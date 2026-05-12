// Módulo de Integraciones (Mercado Pago y futuros providers)
const { MercadoPagoConfig, Preference } = require('mercadopago');

module.exports = function(app, pool, authenticate) {
  // Verificar que authenticate sea función, si no, usar la interna
  const auth = typeof authenticate === 'function' ? authenticate : (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    pool.query('SELECT * FROM users WHERE token = $1', [token], (err, result) => {
      if (err || !result.rows.length) return res.status(401).json({ error: 'Token inválido' });
      req.user = result.rows[0];
      next();
    });
  };

  // ==========================================
  // INTEGRACIONES CRUD
  // ==========================================

  // GET /api/integrations - listar integraciones del cliente
  app.get('/api/integrations', auth, (req, res) => {
    pool.query(
      'SELECT id, provider, enabled, config, last_sync, created_at, updated_at FROM integrations WHERE client_id = $1 AND deleted_at IS NULL ORDER BY provider',
      [req.user.client_id],
      (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(result.rows);
      }
    );
  });

  // PUT /api/integrations/:provider - guardar/configurar integración
  app.put('/api/integrations/:provider', auth, (req, res) => {
    const { provider } = req.params;
    const { config, enabled } = req.body;
    if (!config) return res.status(400).json({ error: 'config es requerido' });

    pool.query(
      `INSERT INTO integrations (client_id, provider, config, enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (client_id, provider)
       DO UPDATE SET config = $3, enabled = $4, updated_at = NOW()
       RETURNING id, provider, enabled, config, last_sync, created_at, updated_at`,
      [req.user.client_id, provider, JSON.stringify(config), enabled !== false],
      (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(result.rows[0]);
      }
    );
  });

  // DELETE /api/integrations/:provider - desactivar integración
  app.delete('/api/integrations/:provider', auth, (req, res) => {
    const { provider } = req.params;
    pool.query(
      'UPDATE integrations SET enabled = false, deleted_at = NOW() WHERE client_id = $1 AND provider = $2',
      [req.user.client_id, provider],
      (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
      }
    );
  });

  // ==========================================
  // MERCADO PAGO — Endpoints específicos
  // ==========================================

  // GET /api/integrations/mercadopago/check — test de conexión
  app.get('/api/integrations/mercadopago/check', auth, async (req, res) => {
    try {
      const integ = await getIntegration(req.user.client_id, 'mercadopago');
      if (!integ) return res.json({ connected: false, error: 'No configurado' });

      const client = buildMPClient(integ);
      const User = require('mercadopago').User;
      const user = await new User(client).get();
      res.json({ connected: true, user_id: user.id, email: user.email });
    } catch (e) {
      res.json({ connected: false, error: e.message });
    }
  });

  // POST /api/integrations/mercadopago/preference — crear link de pago
  app.post('/api/integrations/mercadopago/preference', auth, async (req, res) => {
    try {
      const integ = await getIntegration(req.user.client_id, 'mercadopago');
      if (!integ || !integ.enabled) return res.status(400).json({ error: 'Mercado Pago no configurado' });

      const { order_id, title, amount, quantity = 1, description, payer_email } = req.body;
      if (!order_id || !title || !amount) return res.status(400).json({ error: 'order_id, title y amount son requeridos' });

      const client = buildMPClient(integ);
      const preference = new Preference(client);

      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');

      const body = {
        items: [{ title, quantity, unit_price: Number(amount), currency_id: 'ARS', description: description || '' }],
        external_reference: String(order_id),
        back_urls: { success: '', failure: '', pending: '' },
        auto_return: 'approved',
        notification_url: protocol + '://' + host + '/api/integrations/mercadopago/webhook',
        payer: payer_email ? { email: payer_email } : undefined,
      };

      const result = await preference.create({ body });

      // Guardar transacción
      await pool.query(
        `INSERT INTO integration_transactions (client_id, provider, order_id, mp_preference_id, status, amount, external_reference, init_point, raw_response)
         VALUES ($1, 'mercadopago', $2, $3, 'pending', $4, $5, $6, $7)`,
        [req.user.client_id, order_id, result.id, amount, String(order_id), result.init_point, JSON.stringify(result)]
      );

      res.json({
        preference_id: result.id,
        init_point: result.init_point,
        sandbox_init_point: result.sandbox_init_point,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/integrations/mercadopago/webhook — recibe notificaciones de MP
  app.post('/api/integrations/mercadopago/webhook', async (req, res) => {
    try {
      const notification = req.body;
      // Responder 200 rápido para que MP no reintente
      res.status(200).json({ received: true });

      if (!notification || !notification.type) return;

      // Solo procesamos payment notifications
      if (notification.type === 'payment' && notification.data?.id) {
        const paymentId = notification.data.id;

        // Buscar integraciones activas
        const integs = await pool.query(
          "SELECT * FROM integrations WHERE provider = 'mercadopago' AND enabled = true AND deleted_at IS NULL"
        );

        for (const integ of integs.rows) {
          try {
            const client = buildMPClient(integ);
            const Payment = require('mercadopago').Payment;
            const payment = await new Payment(client).get({ id: paymentId });

            if (payment && payment.external_reference) {
              const orderId = parseInt(payment.external_reference);
              const newStatus = mapMPStatus(payment.status);

              // Actualizar transacción
              await pool.query(
                `UPDATE integration_transactions SET
                  status = $1, status_detail = $2, mp_payment_id = $3,
                  payer_email = $4, payment_method = $5, payment_type = $6,
                  notification_log = COALESCE(notification_log, '[]'::jsonb) || $7::jsonb,
                  updated_at = NOW()
                 WHERE mp_preference_id = $8`,
                [newStatus, payment.status_detail || '', paymentId,
                 payment.payer?.email || '', payment.payment_method?.id || '', payment.payment_method?.type || '',
                 JSON.stringify([notification]), payment.external_reference || paymentId]
              );

              // Si el pago fue aprobado, actualizar la orden
              if (newStatus === 'approved') {
                await pool.query(
                  `UPDATE orders SET
                    payment_status_id = 3,
                    updated_at = NOW()
                   WHERE id = $1 AND payment_status_id != 3 AND deleted_at IS NULL`,
                  [orderId]
                );

                // Registrar el pago en order_payments
                const payStatus = await pool.query(
                  "SELECT id FROM payment_statuses WHERE LOWER(name) LIKE '%pagado%' OR LOWER(name) LIKE '%paid%' LIMIT 1"
                );
                const paymentStatusId = payStatus.rows.length ? payStatus.rows[0].id : 3;

                await pool.query(
                  `INSERT INTO order_payments (order_id, amount, payment_method_id, payment_status_id, notes, created_at)
                   VALUES ($1, $2, (SELECT id FROM payment_methods WHERE LOWER(name) LIKE '%mercadopago%' OR LOWER(name) LIKE '%transferencia%' LIMIT 1), $3, $4, NOW())`,
                  [orderId, payment.transaction_amount || 0, paymentStatusId,
                   'Pago automático MP - ID: ' + paymentId]
                );
              }

              break;
            }
          } catch (e) {
            console.error('[MP Webhook] Error procesando pago:', paymentId, e.message);
          }
        }
      }
    } catch (e) {
      console.error('[MP Webhook] Error general:', e.message);
    }
  });

  // ==========================================
  // TRANSACCIONES — historial
  // ==========================================

  // GET /api/integrations/mercadopago/transactions
  app.get('/api/integrations/mercadopago/transactions', auth, (req, res) => {
    const { order_id, limit = 20, offset = 0 } = req.query;
    let query = `SELECT it.*, o.order_number FROM integration_transactions it
                  LEFT JOIN orders o ON o.id = it.order_id
                  WHERE it.client_id = $1 AND it.provider = 'mercadopago' AND it.deleted_at IS NULL`;
    const params = [req.user.client_id];

    if (order_id) {
      params.push(order_id);
      query += ' AND it.order_id = $' + params.length;
    }

    query += ' ORDER BY it.created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2);
    params.push(Number(limit), Number(offset));

    pool.query(query, params, (err, result) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(result.rows);
    });
  });

  // ==========================================
  // HELPERS
  // ==========================================

  function getIntegration(clientId, provider) {
    return new Promise((resolve, reject) => {
      pool.query(
        'SELECT * FROM integrations WHERE client_id = $1 AND provider = $2 AND deleted_at IS NULL',
        [clientId, provider],
        (err, result) => {
          if (err) return reject(err);
          resolve(result.rows[0] || null);
        }
      );
    });
  }

  function buildMPClient(integ) {
    const config = typeof integ.config === 'string' ? JSON.parse(integ.config) : integ.config;
    return new MercadoPagoConfig({
      accessToken: config.access_token,
      options: { timeout: 10000 },
    });
  }


  // ── Shopify ────────────────────────────────────────────────
  // Helper: get integration config
  async function getIntegration(clientId, provider) {
    const r = await pool.query('SELECT * FROM integrations WHERE client_id = $1 AND provider = $2 LIMIT 1', [clientId, provider]);
    return r.rows[0] || null;
  }

  // Helper: get Shopify OAuth token from client credentials
  async function getShopifyToken(config) {
    if (!config.client_id || !config.client_secret || !config.shop_url) return null;
    const shopUrl = config.shop_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const tokenRes = await fetch('https://' + shopUrl + '/admin/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: config.client_id,
        client_secret: config.client_secret,
        grant_type: 'client_credentials'
      })
    });
    if (!tokenRes.ok) return null;
    const tokenData = await tokenRes.json();
    return tokenData.access_token || null;
  }

  // GET /api/integrations/shopify/status
  app.get('/api/integrations/shopify/status', auth, async (req, res) => {
    try {
      const integ = await getIntegration(req.user.client_id, 'shopify');
      if (!integ || !integ.config) return res.json({ connected: false });
      const config = typeof integ.config === 'string' ? JSON.parse(integ.config) : integ.config;
      const token = await getShopifyToken(config);
      if (!config.shop_url || !token) return res.json({ connected: false });
      const prod = await pool.query("SELECT COUNT(*) as cnt FROM products WHERE client_id = $1 AND is_imported = true AND deleted_at IS NULL", [req.user.client_id]);
      const ord = await pool.query("SELECT COUNT(*) as cnt FROM orders WHERE client_id = $1 AND source ILIKE '%shopify%' AND deleted_at IS NULL", [req.user.client_id]);
      res.json({ connected: true, products_synced: parseInt(prod.rows[0]?.cnt || 0), orders_synced: parseInt(ord.rows[0]?.cnt || 0), last_sync: integ.last_sync });
    } catch (e) { res.json({ connected: false, error: e.message }); }
  });

  // POST /api/integrations/shopify/sync
  app.post('/api/integrations/shopify/sync', auth, async (req, res) => {
    try {
      const integ = await getIntegration(req.user.client_id, 'shopify');
      if (!integ || !integ.enabled) return res.status(400).json({ error: 'Shopify no configurado' });
      const config = typeof integ.config === 'string' ? JSON.parse(integ.config) : integ.config;
      const token = await getShopifyToken(config);
      if (!config.shop_url || !token) return res.status(400).json({ error: 'Shopify no configurado' });
      const shopUrl = config.shop_url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const apiUrl = 'https://' + shopUrl + '/admin/api/2024-10';
      const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
      const errors = [];
      let created = 0, updated = 0;

      // Sync products — split by color, use talle as attribute
      try {
        const spRes = await fetch(apiUrl + '/products.json?limit=250', { headers });
        if (spRes.ok) {
          const spData = await spRes.json();
          for (const sp of spData.products || []) {
            const parentTitle = sp.title || 'Sin nombre';
            const imageUrl = sp.image?.src || '';
            const bodyHtml = sp.body_html || '';
            const variants = sp.variants || [];
            const options = sp.options || [];

            // Single variant = simple product
            if (variants.length <= 1) {
              const price = parseFloat(variants[0]?.price || 0);
              const stock = parseInt(variants[0]?.inventory_quantity || 0);
              const ex = await pool.query('SELECT id FROM products WHERE client_id = $1 AND sku = $2 AND deleted_at IS NULL', [req.user.client_id, String(sp.id)]);
              if (ex.rows.length > 0) {
                await pool.query('UPDATE products SET name = $1, price = $2, stock_quantity = $3, image_url = COALESCE($4, image_url), description = $5, requires_stock = true, updated_at = NOW() WHERE id = $6', [parentTitle, price, stock, imageUrl, bodyHtml, ex.rows[0].id]);
                updated++;
              } else {
                await pool.query('INSERT INTO products (client_id, sku, name, price, stock_quantity, image_url, description, is_imported, requires_stock) VALUES ($1, $2, $3, $4, $5, $6, $7, true, true)', [req.user.client_id, String(sp.id), parentTitle, price, stock, imageUrl, bodyHtml]);
                created++;
              }
              continue;
            }

            // Multiple options: identify split option vs attribute option (from config)
            const attrOptConfig = (config.attribute_option || 'auto').toLowerCase();
            const sizeNames = ['talle', 'talla', 'size', 'tamanho'];
            let splitIdx = 0, attrIdx = 1;
            if (attrOptConfig === 'none') {
              // Each variant becomes its own product, no attributes
              splitIdx = -1; attrIdx = -1;
            } else if (attrOptConfig === 'color') {
              // Force Color as internal attribute; the other option splits products
              attrIdx = options.findIndex(o => (o.name || '').toLowerCase().includes('color'));
              if (attrIdx < 0) attrIdx = 0;
              splitIdx = options.length >= 2 ? (attrIdx === 0 ? 1 : 0) : -1;
            } else if (attrOptConfig === 'talle') {
              // Force Talle/Talla/Size as internal attribute; the other option splits products
              attrIdx = options.findIndex(o => sizeNames.includes((o.name || '').toLowerCase()));
              if (attrIdx < 0) attrIdx = 0;
              splitIdx = options.length >= 2 ? (attrIdx === 0 ? 1 : 0) : -1;
            } else {
              // auto: detect
              if (options.length >= 2 && sizeNames.includes(options[0].name.toLowerCase())) {
                splitIdx = 1; attrIdx = 0;
              }
            }
            // If there is only one option and it is the chosen attribute (e.g. only Talle),
            // keep one product and put all variants as attributes.
            if (options.length === 1 && attrIdx === 0) {
              splitIdx = -2; // special key: one grouped product, no split suffix
            }

            const attrOptName = options[attrIdx]?.name;

            // Ensure attribute type exists
            let attrTypeId = null;
            if (attrOptName) {
              const at = await pool.query("SELECT id FROM attribute_types WHERE client_id = $1 AND name ILIKE $2 AND is_active = true LIMIT 1", [req.user.client_id, attrOptName]);
              if (at.rows.length > 0) {
                attrTypeId = at.rows[0].id;
              } else {
                const na = await pool.query("INSERT INTO attribute_types (client_id, name) VALUES ($1, $2) RETURNING id", [req.user.client_id, attrOptName]);
                attrTypeId = na.rows[0].id;
              }
            }

            // Group variants by split option
            const groups = {};
            for (const v of variants) {
              const vals = (v.title || '').split(' / ').map(s => s.trim());
              let key;
              if (splitIdx === -2) key = '';
              else if (splitIdx < 0) key = v.title || String(v.id);
              else key = vals[splitIdx] || 'Default';
              if (!groups[key]) groups[key] = [];
              groups[key].push(v);
            }

            // Create one product per group
            for (const [splitVal, gvs] of Object.entries(groups)) {
              const pname = splitVal ? parentTitle + ' - ' + splitVal : parentTitle;
              const sku = splitIdx === -2 ? String(sp.id) : String(sp.id) + '-' + String(gvs[0].id);
              const fp = parseFloat(gvs[0]?.price || 0);
              const fs = gvs.reduce((sum, v) => sum + parseInt(v.inventory_quantity || 0), 0);
              const ex = await pool.query('SELECT id FROM products WHERE client_id = $1 AND sku = $2 AND deleted_at IS NULL', [req.user.client_id, sku]);
              let pid;
              if (ex.rows.length > 0) {
                pid = ex.rows[0].id;
                await pool.query('UPDATE products SET name = $1, price = $2, stock_quantity = $3, image_url = COALESCE($4, image_url), description = $5, requires_stock = true, has_attributes = true, updated_at = NOW() WHERE id = $6', [pname, fp, fs, imageUrl, bodyHtml, pid]);
                updated++;
              } else {
                const np = await pool.query('INSERT INTO products (client_id, sku, name, price, stock_quantity, image_url, description, is_imported, requires_stock, has_attributes) VALUES ($1, $2, $3, $4, $5, $6, $7, true, true, true) RETURNING id', [req.user.client_id, sku, pname, fp, fs, imageUrl, bodyHtml]);
                pid = np.rows[0].id;
                created++;
              }

              // If attrIdx < 0 (none mode), skip attribute creation — create one product per variant
            if (attrIdx < 0) {
              // Create separate product for each variant (already done per split)
              continue;
            }
            // Set attributes (talles)
              if (attrTypeId) {
                await pool.query('DELETE FROM product_attributes WHERE product_id = $1', [pid]);
                for (const v of gvs) {
                  const vals = (v.title || '').split(' / ').map(s => s.trim());
                  const av = vals[attrIdx] || '';
                  if (!av) continue;
                  const vs = parseInt(v.inventory_quantity || 0);
                  const avr = await pool.query("SELECT id FROM attribute_values WHERE attribute_type_id = $1 AND value = $2 LIMIT 1", [attrTypeId, av]);
                  let avid;
                  if (avr.rows.length > 0) {
                    avid = avr.rows[0].id;
                  } else {
                    const na = await pool.query("INSERT INTO attribute_values (attribute_type_id, value) VALUES ($1, $2) RETURNING id", [attrTypeId, av]);
                    avid = na.rows[0].id;
                  }
                  await pool.query('INSERT INTO product_attributes (product_id, attribute_value_id, stock_quantity) VALUES ($1, $2, $3) ON CONFLICT (product_id, attribute_value_id) DO UPDATE SET stock_quantity = $3', [pid, avid, vs]);
                }
              }
            }
          }
        } else { errors.push('Products sync error ' + (await spRes.text())); }
      } catch (e) { errors.push('Products: ' + e.message); }

      // Sync customers
      try {
        const cr = await fetch(apiUrl + '/customers.json?limit=250', { headers });
        if (cr.ok) {
          const cd = await cr.json();
          for (const c of cd.customers || []) {
            const phone = c.phone || c.default_address?.phone || '';
            const email = c.email || '';
            const name = (c.first_name || '') + ' ' + (c.last_name || '');
            const ex = await pool.query('SELECT id FROM contacts WHERE client_id = $1 AND (external_id = $2 OR email = $3) AND deleted_at IS NULL LIMIT 1', [req.user.client_id, String(c.id), email]);
            if (ex.rows.length === 0) {
              await pool.query('INSERT INTO contacts (client_id, name, email, phone, external_id, source) VALUES ($1, $2, $3, $4, $5, $6)', [req.user.client_id, name.trim() || email, email, phone, String(c.id), 'shopify']);
            }
          }
        }
      } catch (e) { errors.push('Customers: ' + e.message); }

      // Sync orders
      try {
        const or = await fetch(apiUrl + '/orders.json?limit=250&status=any', { headers });
        if (or.ok) {
          const od = await or.json();
          for (const o of od.orders || []) {
            const total = parseFloat(o.total_price || 0);
            const contactEmail = o.email || o.contact_email || '';
            let contactId = null;
            const ex = await pool.query('SELECT id FROM orders WHERE client_id = $1 AND external_id = $2 AND deleted_at IS NULL LIMIT 1', [req.user.client_id, String(o.id)]);
            if (ex.rows.length === 0) {
              if (contactEmail) {
                const ct = await pool.query('SELECT id FROM contacts WHERE client_id = $1 AND email = $2 AND deleted_at IS NULL LIMIT 1', [req.user.client_id, contactEmail]);
                if (ct.rows.length > 0) contactId = ct.rows[0].id;
              }
              await pool.query("INSERT INTO orders (client_id, contact_id, total, payment_method, notes, source, status, external_id, created_at) VALUES ($1, $2, $3, $4, $5, 'shopify', 'delivered', $6, $7)", [req.user.client_id, contactId, total, o.gateway || '', 'Order #' + o.order_number + ' from Shopify', String(o.id), o.created_at || new Date()]);
            }
          }
        }
      } catch (e) { errors.push('Orders: ' + e.message); }

      await pool.query("UPDATE integrations SET last_sync = NOW() WHERE client_id = $1 AND provider = 'shopify'", [req.user.client_id]);
      res.json({ success: true, message: 'Sync completado', created, updated, details: { errors } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/integrations/shopify/cleanup
  app.post('/api/integrations/shopify/cleanup', auth, async (req, res) => {
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const pr = await client.query("UPDATE products SET is_active = false, updated_at = NOW() WHERE client_id = $1 AND is_imported = true AND deleted_at IS NULL RETURNING id", [req.user.client_id]);
        const or = await client.query("UPDATE orders SET deleted_at = NOW() WHERE client_id = $1 AND source = 'shopify' AND deleted_at IS NULL RETURNING id", [req.user.client_id]);
        const cr = await client.query("UPDATE contacts SET deleted_at = NOW() WHERE client_id = $1 AND source = 'shopify' AND deleted_at IS NULL RETURNING id", [req.user.client_id]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Datos ocultados', products_affected: parseInt(pr.rowCount || 0), orders_affected: parseInt(or.rowCount || 0), contacts_affected: parseInt(cr.rowCount || 0) });
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/integrations/shopify/restore
  app.post('/api/integrations/shopify/restore', auth, async (req, res) => {
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const pr = await client.query("UPDATE products SET is_active = true, updated_at = NOW() WHERE client_id = $1 AND is_imported = true AND deleted_at IS NULL RETURNING id", [req.user.client_id]);
        const or = await client.query("UPDATE orders SET deleted_at = NULL WHERE client_id = $1 AND source = 'shopify' RETURNING id", [req.user.client_id]);
        const cr = await client.query("UPDATE contacts SET deleted_at = NULL WHERE client_id = $1 AND source = 'shopify' RETURNING id", [req.user.client_id]);
        await client.query('COMMIT');
        res.json({ success: true, message: 'Datos restaurados', products_affected: parseInt(pr.rowCount || 0), orders_affected: parseInt(or.rowCount || 0), contacts_affected: parseInt(cr.rowCount || 0) });
      } catch (e) { await client.query('ROLLBACK'); throw e; }
      finally { client.release(); }
    } catch (e) { res.status(500).json({ error: e.message }); }
  });


  function mapMPStatus(status) {
    const map = {
      approved: 'approved',
      pending: 'pending',
      in_process: 'pending',
      in_mediation: 'pending',
      rejected: 'rejected',
      cancelled: 'cancelled',
      refunded: 'refunded',
      charged_back: 'refunded',
    };
    return map[status] || 'pending';
  }
};
