// Módulo de Integraciones (Mercado Pago y futuros providers)
const { MercadoPagoConfig, Preference } = require('mercadopago');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'vib3ia-secret-key-change-in-production';

module.exports = function(app, pool) {
  const authenticate = (req, res, next) => {
    if (req.user && req.user.is_agent) return next();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No autorizado' });
    }
    const token = auth.slice(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      next();
    } catch {
      res.status(401).json({ error: 'Token invalido' });
    }
  };

  // GET /api/integrations - listar integraciones del cliente
  app.get('/api/integrations', authenticate, (req, res) => {
    pool.query(
      'SELECT id, provider, enabled, config, last_sync, created_at, updated_at FROM integrations WHERE client_id = $1 AND deleted_at IS NULL ORDER BY provider',
      [req.user.client_id],
      (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(result.rows);
      }
    );
  });

  // PUT /api/integrations/:provider - guardar/configurar integracion
  app.put('/api/integrations/:provider', authenticate, (req, res) => {
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

  // DELETE /api/integrations/:provider - desactivar integracion
  app.delete('/api/integrations/:provider', authenticate, (req, res) => {
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

  // GET /api/integrations/mercadopago/check - test de conexion
  app.get('/api/integrations/mercadopago/check', authenticate, async (req, res) => {
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

  // POST /api/integrations/mercadopago/preference - crear link de pago
  app.post('/api/integrations/mercadopago/preference', authenticate, async (req, res) => {
    try {
      const integ = await getIntegration(req.user.client_id, 'mercadopago');
      if (!integ || !integ.enabled) return res.status(400).json({ error: 'Mercado Pago no configurado' });

      const { order_id, title, amount, quantity, description, payer_email } = req.body;
      if (!order_id || !title || !amount) return res.status(400).json({ error: 'order_id, title y amount son requeridos' });

      const client = buildMPClient(integ);
      const preference = new Preference(client);

      const protocol = req.headers['x-forwarded-proto'] || req.protocol;
      const host = req.headers['x-forwarded-host'] || req.get('host');

      const body = {
        items: [{ title, quantity: quantity || 1, unit_price: Number(amount), currency_id: 'ARS', description: description || '' }],
        external_reference: String(order_id),
        back_urls: { success: '', failure: '', pending: '' },
        auto_return: 'approved',
        notification_url: protocol + '://' + host + '/api/integrations/mercadopago/webhook',
        payer: payer_email ? { email: payer_email } : undefined,
      };

      const result = await preference.create({ body });

      await pool.query(
        `INSERT INTO integration_transactions (client_id, provider, order_id, mp_preference_id, status, amount, external_reference, init_point, raw_response)
         VALUES ($1, 'mercadopago', $2, $3, 'pending', $4, $5, $6, $7)`,
        [req.user.client_id, order_id, result.id, amount, String(order_id), result.init_point, JSON.stringify(result)]
      );

      res.json({ preference_id: result.id, init_point: result.init_point, sandbox_init_point: result.sandbox_init_point });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/integrations/mercadopago/webhook - recibe notificaciones de MP
  app.post('/api/integrations/mercadopago/webhook', async (req, res) => {
    try {
      const notification = req.body;
      res.status(200).json({ received: true });
      if (!notification || !notification.type) return;

      if (notification.type === 'payment' && notification.data && notification.data.id) {
        const paymentId = notification.data.id;
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
              await pool.query(
                `UPDATE integration_transactions SET status = $1, status_detail = $2, mp_payment_id = $3,
                  payer_email = $4, payment_method = $5, payment_type = $6,
                  notification_log = COALESCE(notification_log, '[]'::jsonb) || $7::jsonb, updated_at = NOW()
                 WHERE mp_preference_id = $8`,
                [newStatus, payment.status_detail || '', paymentId, payment.payer?.email || '',
                 payment.payment_method?.id || '', payment.payment_method?.type || '',
                 JSON.stringify([notification]), payment.external_reference || paymentId]
              );
              if (newStatus === 'approved') {
                await pool.query(
                  `UPDATE orders SET payment_status_id = 3, updated_at = NOW()
                   WHERE id = $1 AND payment_status_id != 3 AND deleted_at IS NULL`, [orderId]
                );
                const ps = await pool.query(
                  "SELECT id FROM payment_statuses WHERE LOWER(name) LIKE '%pagado%' OR LOWER(name) LIKE '%paid%' LIMIT 1"
                );
                const psid = ps.rows.length ? ps.rows[0].id : 3;
                await pool.query(
                  `INSERT INTO order_payments (order_id, amount, payment_method_id, payment_status_id, notes, created_at)
                   VALUES ($1, $2, (SELECT id FROM payment_methods WHERE LOWER(name) LIKE '%mercadopago%' OR LOWER(name) LIKE '%transferencia%' LIMIT 1), $3, $4, NOW())`,
                  [orderId, payment.transaction_amount || 0, psid, 'Pago automatico MP - ID: ' + paymentId]
                );
              }
              break;
            }
          } catch (e) { console.error('[MP Webhook] Error:', paymentId, e.message); }
        }
      }
    } catch (e) { console.error('[MP Webhook] Error general:', e.message); }
  });

  // GET /api/integrations/mercadopago/transactions
  app.get('/api/integrations/mercadopago/transactions', authenticate, (req, res) => {
    const { order_id, limit, offset } = req.query;
    const lim = parseInt(limit) || 20;
    const off = parseInt(offset) || 0;
    let q = 'SELECT it.*, o.order_number FROM integration_transactions it LEFT JOIN orders o ON o.id = it.order_id WHERE it.client_id = $1 AND it.provider = \'mercadopago\' AND it.deleted_at IS NULL';
    const p = [req.user.client_id];
    if (order_id) { p.push(parseInt(order_id)); q += ' AND it.order_id = $' + p.length; }
    q += ' ORDER BY it.created_at DESC LIMIT $' + (p.length + 1) + ' OFFSET $' + (p.length + 2);
    p.push(lim, off);
    pool.query(q, p, (err, r) => { if (err) return res.status(500).json({ error: err.message }); res.json(r.rows); });
  });

  // Helpers
  function getIntegration(clientId, provider) {
    return new Promise((resolve, reject) => {
      pool.query('SELECT * FROM integrations WHERE client_id = $1 AND provider = $2 AND deleted_at IS NULL',
        [clientId, provider], (err, r) => { if (err) return reject(err); resolve(r.rows[0] || null); });
    });
  }
  function buildMPClient(integ) {
    const cfg = typeof integ.config === 'string' ? JSON.parse(integ.config) : integ.config;
    return new MercadoPagoConfig({ accessToken: cfg.access_token, options: { timeout: 10000 } });
  }
  function mapMPStatus(status) {
    const m = { approved: 'approved', pending: 'pending', in_process: 'pending', in_mediation: 'pending', rejected: 'rejected', cancelled: 'cancelled', refunded: 'refunded', charged_back: 'refunded' };
    return m[status] || 'pending';
  }
};
