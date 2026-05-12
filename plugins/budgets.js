// Plugin: Presupuestos (Budgets)
module.exports = function(app, pool, authenticate) {

  async function getNextBudgetNumber(clientId) {
    const { rows } = await pool.query(
      "SELECT COALESCE(MAX(CAST(SUBSTRING(number FROM 6) AS INTEGER)), 0) + 1 AS next_num FROM budgets WHERE client_id = $1",
      [clientId]
    );
    return 'PRES-' + String(rows[0].next_num || 1).padStart(4, '0');
  }

  async function autoExpireBudgets() {
    await pool.query(
      "UPDATE budgets SET status = 'vencido', updated_at = NOW() WHERE status = 'pendiente' AND valid_until IS NOT NULL AND valid_until < CURRENT_DATE"
    );
  }

  app.get('/api/budgets/auto-expire', async (req, res) => {
    try { await autoExpireBudgets(); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/budgets', authenticate, async (req, res) => {
    try {
      const clientId = req.user.client_id;
      const { status, client_id, q, page = 1 } = req.query;
      const limit = 50;
      const offset = (Number(page) - 1) * limit;

      let where = 'WHERE b.client_id = $1';
      const params = [clientId];

      if (status && status !== 'todos') { params.push(status); where += " AND b.status = $" + params.length; }
      if (client_id) { params.push(client_id); where += " AND b.client_id = $" + params.length; }
      if (q) { params.push('%' + q + '%'); where += " AND (b.number ILIKE $" + params.length + " OR c.name ILIKE $" + params.length + ")"; }

      const countRow = await pool.query("SELECT COUNT(*) as total FROM budgets b LEFT JOIN contacts c ON b.client_id = c.id " + where, params);

      params.push(limit, offset);
      const { rows } = await pool.query(
        "SELECT b.*, c.name as client_name FROM budgets b LEFT JOIN contacts c ON b.client_id = c.id " + where + " ORDER BY b.created_at DESC LIMIT $" + (params.length - 1) + " OFFSET $" + params.length,
        params
      );

      res.json({
        budgets: rows,
        total: parseInt(countRow.rows[0].total),
        page: Number(page),
        pages: Math.ceil(parseInt(countRow.rows[0].total) / limit)
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/budgets', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const clientId = req.user.client_id;
      const { client_id, items = [], notes, valid_until, discount = 0 } = req.body;

      if (!client_id) return res.status(400).json({ error: 'client_id requerido' });
      if (!items.length) return res.status(400).json({ error: 'Se requiere al menos un item' });

      await client.query('BEGIN');

      const number = await getNextBudgetNumber(clientId);

      const resolvedItems = [];
      for (const item of items) {
        let unit_price = Number(item.unit_price || 0);
        if (item.product_id && unit_price === 0) {
          const { rows: prodRows } = await client.query('SELECT price FROM products WHERE id = $1', [item.product_id]);
          if (prodRows[0]) unit_price = Number(prodRows[0].price);
        }
        if (item.service_id && unit_price === 0) {
          const { rows: svcRows } = await client.query('SELECT price FROM services WHERE id = $1', [item.service_id]);
          if (svcRows[0]) unit_price = Number(svcRows[0].price);
        }
        resolvedItems.push({ ...item, unit_price });
      }

      const subtotal = resolvedItems.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0);
      const total = Math.max(0, subtotal - Number(discount));

      const { rows: budgetRows } = await client.query(
        "INSERT INTO budgets (client_id, number, subtotal, discount, total, notes, valid_until, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pendiente') RETURNING *",
        [clientId, number, subtotal, Number(discount), total, notes || '', valid_until || null]
      );
      const budget = budgetRows[0];

      for (const item of resolvedItems) {
        const itemSubtotal = Number(item.quantity) * Number(item.unit_price);
        await client.query(
          "INSERT INTO budget_items (budget_id, product_id, service_id, description, quantity, unit_price, subtotal) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [budget.id, item.product_id || null, item.service_id || null, item.description || '', item.quantity, item.unit_price, itemSubtotal]
        );
      }

      await client.query('COMMIT');
      res.status(201).json(budget);
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  app.get('/api/budgets/:id', authenticate, async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT b.*, c.name as client_name, c.phone as client_phone, c.email as client_email, c.address as client_address FROM budgets b LEFT JOIN contacts c ON b.client_id = c.id WHERE b.id = $1",
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Presupuesto no encontrado' });

      const items = await pool.query(
        "SELECT bi.*, p.name as product_name, s.name as service_name FROM budget_items bi LEFT JOIN products p ON bi.product_id = p.id LEFT JOIN services s ON bi.service_id = s.id WHERE bi.budget_id = $1",
        [req.params.id]
      );

      res.json({ ...rows[0], items: items.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/budgets/:id', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const { items = [], notes, valid_until, discount = 0 } = req.body;

      await client.query('BEGIN');

      const { rows: curr } = await client.query('SELECT status FROM budgets WHERE id = $1', [req.params.id]);
      if (!curr[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No encontrado' }); }
      if (curr[0].status !== 'pendiente') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Solo se pueden editar presupuestos pendientes' }); }

      const resolvedItems = [];
      for (const item of items) {
        let unit_price = Number(item.unit_price || 0);
        if (item.product_id && unit_price === 0) {
          const { rows: prodRows } = await client.query('SELECT price FROM products WHERE id = $1', [item.product_id]);
          if (prodRows[0]) unit_price = Number(prodRows[0].price);
        }
        if (item.service_id && unit_price === 0) {
          const { rows: svcRows } = await client.query('SELECT price FROM services WHERE id = $1', [item.service_id]);
          if (svcRows[0]) unit_price = Number(svcRows[0].price);
        }
        resolvedItems.push({ ...item, unit_price });
      }

      const subtotal = resolvedItems.reduce((s, i) => s + Number(i.quantity) * Number(i.unit_price), 0);
      const total = Math.max(0, subtotal - Number(discount));

      await client.query(
        "UPDATE budgets SET subtotal = $1, discount = $2, total = $3, notes = $4, valid_until = $5, updated_at = NOW() WHERE id = $6",
        [subtotal, Number(discount), total, notes || '', valid_until || null, req.params.id]
      );

      await client.query('DELETE FROM budget_items WHERE budget_id = $1', [req.params.id]);
      for (const item of resolvedItems) {
        const itemSubtotal = Number(item.quantity) * Number(item.unit_price);
        await client.query(
          "INSERT INTO budget_items (budget_id, product_id, service_id, description, quantity, unit_price, subtotal) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [req.params.id, item.product_id || null, item.service_id || null, item.description || '', item.quantity, item.unit_price, itemSubtotal]
        );
      }

      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  app.delete('/api/budgets/:id', authenticate, async (req, res) => {
    try {
      const { rows: curr } = await pool.query('SELECT status FROM budgets WHERE id = $1', [req.params.id]);
      if (!curr[0]) return res.status(404).json({ error: 'No encontrado' });
      if (curr[0].status !== 'pendiente') return res.status(400).json({ error: 'Solo se pueden eliminar presupuestos pendientes' });
      await pool.query('DELETE FROM budgets WHERE id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/budgets/:id/convert', authenticate, async (req, res) => {
    const client = await pool.connect();
    try {
      const clientId = req.user.client_id;

      await client.query('BEGIN');

      const { rows: budgetRows } = await client.query('SELECT * FROM budgets WHERE id = $1', [req.params.id]);
      if (!budgetRows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Presupuesto no encontrado' }); }
      const budget = budgetRows[0];
      if (budget.status === 'convertido') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Este presupuesto ya fue convertido' }); }

      const { rows: budgetItems } = await client.query('SELECT * FROM budget_items WHERE budget_id = $1', [req.params.id]);

      const { rows: seqRows } = await client.query(
        "SELECT COALESCE(MAX(CAST(SUBSTRING(order_number FROM 4) AS INTEGER)), 0) + 1 AS next_num FROM orders WHERE client_id = $1 AND order_number ~ '^NV-[0-9]+$'",
        [clientId]
      );
      const orderNumber = 'NV-' + String(seqRows[0].next_num).padStart(5, '0');

      const { rows: statusRows } = await client.query(
        "SELECT id FROM order_statuses WHERE client_id = $1 AND deleted_at IS NULL ORDER BY sort_order LIMIT 1",
        [clientId]
      );
      const { rows: payRows } = await client.query("SELECT id FROM payment_statuses WHERE name = 'Impago' LIMIT 1");

      const { rows: orderRows } = await client.query(
        "INSERT INTO orders (client_id, contact_id, order_number, subtotal, total, notes, order_status_id, payment_status_id, type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'venta') RETURNING id",
        [clientId, budget.client_id, orderNumber, budget.subtotal, budget.total, budget.notes || '', statusRows[0] && statusRows[0].id || 1, payRows[0] && payRows[0].id || 1]
      );
      const orderId = orderRows[0].id;

      for (const item of budgetItems) {
        await client.query(
          "INSERT INTO order_items (order_id, product_id, service_id, product_name, quantity, unit_price, subtotal) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [orderId, item.product_id, item.service_id, item.description, item.quantity, item.unit_price, item.subtotal]
        );
      }

      await client.query(
        "UPDATE budgets SET status = 'convertido', converted_to_order_id = $1, updated_at = NOW() WHERE id = $2",
        [orderId, req.params.id]
      );

      await client.query('COMMIT');
      res.json({ order_id: orderId, order_number: orderNumber });
    } catch (e) {
      await client.query('ROLLBACK');
      res.status(500).json({ error: e.message });
    } finally {
      client.release();
    }
  });

  app.get('/api/budgets/:id/pdf', authenticate, async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT b.*, c.name as client_name, c.phone as client_phone, c.email as client_email, c.address as client_address FROM budgets b LEFT JOIN contacts c ON b.client_id = c.id WHERE b.id = $1",
        [req.params.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Presupuesto no encontrado' });
      const budget = rows[0];

      const items = await pool.query(
        "SELECT bi.*, p.name as product_name, s.name as service_name FROM budget_items bi LEFT JOIN products p ON bi.product_id = p.id LEFT JOIN services s ON bi.service_id = s.id WHERE bi.budget_id = $1",
        [req.params.id]
      );

      const { rows: designRows } = await pool.query('SELECT * FROM budget_designs WHERE client_id = $1', [budget.client_id]);
      const design = designRows[0] || {};

      const itemsHtml = items.rows.map(item => {
        const name = item.product_name || item.service_name || item.description || '';
        const qty = Number(item.quantity).toFixed(2);
        const price = Number(item.unit_price).toFixed(2);
        const sub = Number(item.subtotal).toFixed(2);
        return '<tr><td style="padding:8px;border-bottom:1px solid #eee">' + name + '</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">' + qty + '</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">$' + price + '</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">$' + sub + '</td></tr>';
      }).join('');

      const color = design.primary_color || '#6c63ff';
      const fecha = new Date(budget.created_at).toLocaleDateString('es-AR');
      const vence = budget.valid_until ? new Date(budget.valid_until).toLocaleDateString('es-AR') : 'Sin vencimiento';
      const contacto = budget.client_name || '';
      const subtotal = Number(budget.subtotal).toFixed(2);
      const descuento = Number(budget.discount).toFixed(2);
      const total = Number(budget.total).toFixed(2);

      const defaultTemplate = '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>body{font-family:Arial,sans-serif;margin:40px;color:#333}.header{text-align:center;margin-bottom:30px;border-bottom:3px solid ' + color + ';padding-bottom:20px}.header h1{color:' + color + ';margin:0 0 5px;font-size:24px}.header h2{margin:0;font-size:16px;font-weight:normal;color:#666}.meta{display:flex;justify-content:space-between;margin:20px 0}.meta-box{background:#f9f9f9;padding:12px 16px;border-radius:8px;border-left:4px solid ' + color + ';flex:1;margin:0 4px}.meta-box p{margin:4px 0;font-size:13px}table{width:100%;border-collapse:collapse;margin:20px 0}th{background:' + color + ';color:#fff;padding:10px 8px;text-align:left;font-size:12px}td{font-size:13px}.totals{margin-top:20px;text-align:right}.totals p{margin:4px 0;font-size:14px}.totals .total{font-size:20px;font-weight:bold;color:' + color + '}.footer{margin-top:40px;text-align:center;font-size:11px;color:#999;border-top:1px solid #eee;padding-top:12px}.notes{background:#fff8e1;padding:10px 14px;border-radius:6px;margin:16px 0;font-size:13px}</style></head><body><div class="header"><h1>PRESUPUESTO</h1><h2>' + budget.number + '</h2></div><div class="meta"><div class="meta-box"><p><strong>Cliente:</strong> ' + contacto + '</p><p><strong>Fecha:</strong> ' + fecha + '</p></div><div class="meta-box"><p><strong>Validez:</strong> ' + vence + '</p><p><strong>Estado:</strong> ' + (budget.status || '').toUpperCase() + '</p></div></div><table><thead><tr><th>Descripcion</th><th style="text-align:right">Cantidad</th><th style="text-align:right">Precio Unit.</th><th style="text-align:right">Subtotal</th></tr></thead><tbody>' + itemsHtml + '</tbody></table><div class="totals"><p>Subtotal: $' + subtotal + '</p><p>Descuento: -$' + descuento + '</p><p class="total">TOTAL: $' + total + '</p></div>' + (budget.notes ? '<div class="notes"><strong>Notas:</strong> ' + budget.notes + '</div>' : '') + '<div class="footer">' + (design.footer_text || '') + '</div></body></html>';

      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', 'inline; filename="Presupuesto-' + budget.number + '.html"');
      res.send(defaultTemplate);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/budgets/design', authenticate, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM budget_designs WHERE client_id = $1', [req.params.clientId]);
      res.json(rows[0] || {});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/budgets/design', authenticate, async (req, res) => {
    try {
      const { template_html, logo_url, primary_color, footer_text, show_prices } = req.body;
      const { rows } = await pool.query(
        "INSERT INTO budget_designs (client_id, template_html, logo_url, primary_color, footer_text, show_prices) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (client_id) DO UPDATE SET template_html = EXCLUDED.template_html, logo_url = EXCLUDED.logo_url, primary_color = EXCLUDED.primary_color, footer_text = EXCLUDED.footer_text, show_prices = EXCLUDED.show_prices, updated_at = NOW() RETURNING *",
        [req.params.clientId, template_html || '', logo_url || '', primary_color || '#6c63ff', footer_text || '', show_prices !== false]
      );
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

};
