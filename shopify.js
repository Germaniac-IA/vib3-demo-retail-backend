// Módulo Shopify - Integración con flujo OAuth + solo lectura
const crypto = require('crypto');

module.exports = function (app, pool, authenticate) {

  // GET /api/integrations/shopify/auth - iniciar OAuth para instalar la app en la tienda
  // Query params: ?shop=baver-oficial.myshopify.com&client_id=1
  app.get('/integrations/shopify/auth', async (req, res) => {
    try {
      const shop = req.query.shop;
      const clientId = parseInt(req.query.client_id) || 1;
      if (!shop) return res.status(400).send('Falta parametro shop');

      // Obtener api_key + secret de la integracion configurada
      const r = await pool.query(
        'SELECT config FROM integrations WHERE client_id=$1 AND provider=$2 AND deleted_at IS NULL',
        [clientId, 'shopify']
      );

      let apiKey, secretKey;
      if (r.rows.length > 0 && r.rows[0].config) {
        const cfg = typeof r.rows[0].config === 'string' ? JSON.parse(r.rows[0].config) : r.rows[0].config;
        apiKey = cfg.access_token || cfg.api_key;
        secretKey = cfg.api_secret || cfg.access_token + '_secret';
      }

      if (!apiKey) {
        return res.status(400).send('API Key no configurado. Guarda el Access Token en Integraciones.');
      }
      // Si no hay secret key separado, usar el mismo api_key como secret (compatible con apps internas)
      if (!secretKey || secretKey.endsWith('_secret')) {
        secretKey = apiKey;
      }

      // Generar state (nonce) y guardarlo en sesion
      const state = crypto.randomBytes(16).toString('hex');

      const redirectUri = 'http://149.50.148.131/api/integrations/shopify/callback';
      const scopes = 'read_products,read_orders,read_customers,read_inventory,read_all_orders';
      const authUrl = 'https://' + shop + '/admin/oauth/authorize' +
        '?client_id=' + apiKey +
        '&scope=' + encodeURIComponent(scopes) +
        '&redirect_uri=' + encodeURIComponent(redirectUri) +
        '&state=' + state;

      // Guardar state temporal para verificacion
      const stateKey = 'shopify_oauth_' + shop;
      global[stateKey] = { state, clientId, shop };

      res.redirect(authUrl);
    } catch (e) {
      res.status(500).send('Error al iniciar OAuth: ' + e.message);
    }
  });

  // GET /api/integrations/shopify/callback - OAuth callback
  app.get('/integrations/shopify/callback', async (req, res) => {
    try {
      const { shop, code, state, hmac } = req.query;
      if (!shop || !code || !state) return res.status(400).send('Parametros faltantes');

      // Verificar state
      const stateKey = 'shopify_oauth_' + shop;
      const saved = global[stateKey];
      if (!saved || saved.state !== state) return res.status(403).send('State invalido');
      delete global[stateKey];

      const clientId = saved.clientId;

      // Obtener api_key + secret
      const r = await pool.query(
        'SELECT config FROM integrations WHERE client_id=$1 AND provider=$2 AND deleted_at IS NULL',
        [clientId, 'shopify']
      );
      if (r.rows.length === 0) return res.status(400).send('Integracion no encontrada');

      const callbackCfg = typeof r.rows[0].config === 'string' ? JSON.parse(r.rows[0].config) : r.rows[0].config;
      const apiKey = callbackCfg.access_token || callbackCfg.api_key;
      const secretKey = callbackCfg.api_secret || apiKey;

      // HMAC verification
      if (hmac) {
        const sortedParams = Object.keys(req.query)
          .filter(k => k !== 'hmac' && k !== 'signature')
          .sort()
          .map(k => k + '=' + req.query[k])
          .join('&');
        const calculatedHmac = crypto.createHmac('sha256', secretKey).update(sortedParams).digest('hex');
        if (calculatedHmac !== hmac) return res.status(403).send('HMAC invalido');
      }

      // Intercambiar code por access token
      const tokenResp = await fetch('https://' + shop + '/admin/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: apiKey,
          client_secret: secretKey,
          code: code
        })
      });

      if (!tokenResp.ok) return res.status(500).send('Error obteniendo token de Shopify');

      const tokenData = await tokenResp.json();
      const accessToken = tokenData.access_token;

      if (!accessToken) return res.status(500).send('No se recibio access_token');

      // Guardar en integraciones
      const newConfig = { ...cfg, access_token: accessToken, shop_url: shop, last_auth: new Date().toISOString() };
      await pool.query(
        `INSERT INTO integrations (client_id, provider, config, enabled) 
         VALUES ($1, $2, $3, true)
         ON CONFLICT (client_id, provider) 
         DO UPDATE SET config = $3, enabled = true, deleted_at = NULL, updated_at = NOW()`,
        [clientId, 'shopify', JSON.stringify(newConfig)]
      );

      // Redirigir al dashboard con exito
      res.send(`
        <html><body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#0f0f1e;color:#e2e8f0">
        <div style="text-align:center">
          <h1>✅ Shopify conectado correctamente</h1>
          <p>Ya podes cerrar esta ventana y volver al dashboard.</p>
          <p><a href="/integraciones" style="color:#6c63ff">Volver a Integraciones</a></p>
        </div>
        </body></html>
      `);
    } catch (e) {
      res.status(500).send('Error en callback OAuth: ' + e.message);
    }
  });

  // GET /api/integrations/shopify/status - estado de la integración
  app.get('/integrations/shopify/status', authenticate, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, provider, enabled, config, last_sync, 
          (SELECT COUNT(*) FROM products WHERE client_id=$1 AND external_id IS NOT NULL) as products_synced,
          (SELECT COUNT(*) FROM orders WHERE client_id=$1 AND external_id IS NOT NULL) as orders_synced
         FROM integrations WHERE client_id=$1 AND provider='shopify' AND deleted_at IS NULL`,
        [req.user.client_id]
      );
      if (r.rows.length === 0) return res.json({ connected: false });
      const integ = r.rows[0];
      const cfg = typeof integ.config === 'string' ? JSON.parse(integ.config) : integ.config;
      res.json({
        connected: integ.enabled && !!cfg.access_token,
        shop_url: cfg.shop_url || '',
        last_sync: integ.last_sync,
        products_synced: parseInt(integ.products_synced) || 0,
        orders_synced: parseInt(integ.orders_synced) || 0
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/integrations/shopify/sync - sincronizar
  app.post('/integrations/shopify/sync', authenticate, async (req, res) => {
    try {
      const r = await pool.query(
        'SELECT config FROM integrations WHERE client_id=$1 AND provider=$2 AND enabled=true AND deleted_at IS NULL',
        [req.user.client_id, 'shopify']
      );
      if (r.rows.length === 0) return res.status(400).json({ error: 'Shopify no configurado o desactivado' });
      
      const cfg = typeof r.rows[0].config === 'string' ? JSON.parse(r.rows[0].config) : r.rows[0].config;
      const shop = cfg.shop_url;
      const token = cfg.access_token;
      const clientId = req.user.client_id;

      if (!shop || !token) return res.status(400).json({ error: 'Configuracion incompleta' });

      const api = 'https://' + shop + '/admin/api/2024-01';
      const headers = { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' };
      const results = { products: 0, orders: 0, customers: 0, errors: [] };

      // PRODUCTOS
      try {
        let url = api + '/products.json?limit=250&status=active';
        while (url) {
          const resp = await fetch(url, { headers });
          if (!resp.ok) { results.errors.push('Products API: ' + resp.status); break; }
          const data = await resp.json();
          for (const sp of data.products) {
            const existing = await pool.query('SELECT id FROM products WHERE client_id=$1 AND external_id=$2', [clientId, String(sp.id)]);
            const pd = {
              name: sp.title,
              description: sp.body_html ? sp.body_html.replace(/<[^>]*>/g, '').substring(0, 1000) : '',
              price: parseFloat(sp.variants?.[0]?.price) || 0,
              stock_quantity: sp.variants?.reduce((a, v) => a + (parseInt(v.inventory_quantity) || 0), 0) || 0,
              sku: sp.variants?.[0]?.sku || '',
              is_active: sp.status === 'active',
              image_url: sp.image?.src || null,
              external_id: String(sp.id)
            };
            if (existing.rows.length > 0) {
              await pool.query('UPDATE products SET name=$1, description=$2, price=$3, stock_quantity=$4, sku=$5, is_active=$6, image_url=$7, updated_at=NOW() WHERE id=$8',
                [pd.name, pd.description, pd.price, pd.stock_quantity, pd.sku, pd.is_active, pd.image_url, existing.rows[0].id]);
            } else {
              await pool.query('INSERT INTO products (client_id, name, description, price, stock_quantity, sku, is_active, image_url, external_id, requires_stock, unit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,\'Unidad\')',
                [clientId, pd.name, pd.description, pd.price, pd.stock_quantity, pd.sku, pd.is_active, pd.image_url, pd.external_id]);
            }
            results.products++;
          }
          url = null;
          const lh = resp.headers.get('link');
          if (lh) { const m = lh.match(/<([^>]+)>\s*;\s*rel="next"/); if (m) url = m[1]; }
        }
      } catch (e) { results.errors.push('Products: ' + e.message); }

      // CLIENTES
      try {
        let url = api + '/customers.json?limit=250';
        while (url) {
          const resp = await fetch(url, { headers });
          if (!resp.ok) { results.errors.push('Customers API: ' + resp.status); break; }
          const data = await resp.json();
          for (const sc of data.customers) {
            const existing = await pool.query('SELECT id FROM contacts WHERE client_id=$1 AND external_id=$2', [clientId, String(sc.id)]);
            const addr = sc.default_address || {};
            const cd = { name: sc.first_name + ' ' + sc.last_name, email: sc.email || '', phone: sc.phone || addr.phone || '', address: [addr.address1, addr.address2].filter(Boolean).join(', '), location: addr.city || '', external_id: String(sc.id) };
            if (existing.rows.length > 0) {
              await pool.query('UPDATE contacts SET name=$1,email=$2,phone=$3,address=$4,location=$5,updated_at=NOW() WHERE id=$6',
                [cd.name, cd.email, cd.phone, cd.address, cd.location, existing.rows[0].id]);
            } else {
              await pool.query('INSERT INTO contacts (client_id,name,email,phone,address,location,external_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                [clientId, cd.name, cd.email, cd.phone, cd.address, cd.location, cd.external_id]);
            }
            results.customers++;
          }
          url = null;
          const lh = resp.headers.get('link');
          if (lh) { const m = lh.match(/<([^>]+)>\s*;\s*rel="next"/); if (m) url = m[1]; }
        }
      } catch (e) { results.errors.push('Customers: ' + e.message); }

      // ORDENES
      try {
        let url = api + '/orders.json?limit=250&status=any';
        while (url) {
          const resp = await fetch(url, { headers });
          if (!resp.ok) { results.errors.push('Orders API: ' + resp.status); break; }
          const data = await resp.json();
          for (const so of data.orders) {
            let contactId = null;
            if (so.customer) {
              const c = await pool.query('SELECT id FROM contacts WHERE client_id=$1 AND external_id=$2', [clientId, String(so.customer.id)]);
              if (c.rows.length > 0) contactId = c.rows[0].id;
            }
            const existing = await pool.query('SELECT id FROM orders WHERE client_id=$1 AND external_id=$2', [clientId, String(so.id)]);
            const od = { contact_id: contactId, order_number: so.name || String(so.order_number), subtotal: parseFloat(so.subtotal_price) || 0, delivery_fee: parseFloat(so.total_shipping_price_set?.shop_money?.amount) || 0, total: parseFloat(so.total_price) || 0, notes: so.note || null, external_id: String(so.id) };
            if (existing.rows.length > 0) {
              await pool.query('UPDATE orders SET contact_id=$1,order_number=$2,subtotal=$3,delivery_fee=$4,total=$5,notes=$6,updated_at=NOW() WHERE id=$7',
                [od.contact_id, od.order_number, od.subtotal, od.delivery_fee, od.total, od.notes, existing.rows[0].id]);
            } else {
              const ins = await pool.query('INSERT INTO orders (client_id,contact_id,order_number,subtotal,delivery_fee,total,notes,external_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
                [clientId, od.contact_id, od.order_number, od.subtotal, od.delivery_fee, od.total, od.notes, od.external_id]);
              if (so.line_items) {
                for (const li of so.line_items) {
                  let productId = null;
                  if (li.product_id) {
                    const p = await pool.query('SELECT id FROM products WHERE client_id=$1 AND external_id=$2', [clientId, String(li.product_id)]);
                    if (p.rows.length > 0) productId = p.rows[0].id;
                  }
                  await pool.query('INSERT INTO order_items (order_id,product_id,quantity,unit_price,description) VALUES ($1,$2,$3,$4,$5,$6)',
                    [ins.rows[0].id, productId, li.quantity || 1, parseFloat(li.price) || 0, li.title || '']);
                }
              }
            }
            results.orders++;
          }
          url = null;
          const lh = resp.headers.get('link');
          if (lh) { const m = lh.match(/<([^>]+)>\s*;\s*rel="next"/); if (m) url = m[1]; }
        }
      } catch (e) { results.errors.push('Orders: ' + e.message); }

      await pool.query('UPDATE integrations SET last_sync=NOW() WHERE client_id=$1 AND provider=$2', [clientId, 'shopify']);

      res.json({ success: true, message: 'Sincronizados ' + results.products + ' productos, ' + results.customers + ' clientes, ' + results.orders + ' ordenes', details: results });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  console.log('Modulo Shopify cargado');
};
