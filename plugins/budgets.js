// Plugin: Presupuestos (Budgets)
const PDFDocument = require('pdfkit');
const { renderHtmlToPdf, buildBudgetItems } = require('../html2pdf');

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

  // Design config routes must be registered before /api/budgets/:id
  app.get('/api/budgets/design', authenticate, async (req, res) => {
    try {
      const { rows } = await pool.query('SELECT * FROM budget_designs WHERE client_id = $1', [req.user.client_id]);
      res.json(rows[0] || {});
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/budgets/design', authenticate, async (req, res) => {
    try {
      const { template_html, logo_url, primary_color, footer_text, show_prices } = req.body;
      const { rows } = await pool.query(
        "INSERT INTO budget_designs (client_id, template_html, logo_url, primary_color, footer_text, show_prices) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (client_id) DO UPDATE SET template_html = EXCLUDED.template_html, logo_url = EXCLUDED.logo_url, primary_color = EXCLUDED.primary_color, footer_text = EXCLUDED.footer_text, show_prices = EXCLUDED.show_prices, updated_at = NOW() RETURNING *",
        [req.user.client_id, template_html || '', logo_url || '', primary_color || '#6c63ff', footer_text || '', show_prices !== false]
      );
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
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
      if (client_id) { params.push(client_id); where += " AND b.contact_id = $" + params.length; }
      if (q) { params.push('%' + q + '%'); where += " AND (b.number ILIKE $" + params.length + " OR c.name ILIKE $" + params.length + ")"; }

      const countRow = await pool.query("SELECT COUNT(*) as total FROM budgets b LEFT JOIN contacts c ON b.contact_id = c.id " + where, params);

      params.push(limit, offset);
      const { rows } = await pool.query(
        "SELECT b.*, c.name as client_name FROM budgets b LEFT JOIN contacts c ON b.contact_id = c.id " + where + " ORDER BY b.created_at DESC LIMIT $" + (params.length - 1) + " OFFSET $" + params.length,
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
      const { client_id: contact_id, items = [], notes, valid_until, discount = 0 } = req.body;

      if (!contact_id) return res.status(400).json({ error: 'contact_id requerido' });
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
        "INSERT INTO budgets (client_id, contact_id, number, subtotal, discount, total, notes, valid_until, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendiente') RETURNING *",
        [clientId, contact_id, number, subtotal, Number(discount), total, notes || '', valid_until || null]
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
        "SELECT b.*, c.name as client_name, c.phone as client_phone, c.email as client_email, c.address as client_address FROM budgets b LEFT JOIN contacts c ON b.contact_id = c.id WHERE b.id = $1",
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
        "INSERT INTO orders (client_id, contact_id, order_number, subtotal, total, notes, order_status_id, payment_status_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8 ) RETURNING id",
        [clientId, budget.contact_id, orderNumber, Number(budget.subtotal || 0), Number(budget.total || 0), budget.notes || '', statusRows[0] && statusRows[0].id || 1, payRows[0] && payRows[0].id || 1]
      );
      const orderId = orderRows[0].id;

      for (const item of budgetItems) {
        await client.query(
          "INSERT INTO order_items (order_id, product_id, service_id, product_name, quantity, unit_price, subtotal) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [orderId, item.product_id || null, item.service_id || null, item.description || "", Number(item.quantity) || 1, Number(item.unit_price) || 0, Number(item.subtotal) || 0]
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
        "SELECT b.*, c.name as client_name, c.phone as client_phone, c.email as client_email, c.address as client_address FROM budgets b LEFT JOIN contacts c ON b.contact_id = c.id WHERE b.id = $1 AND b.client_id = $2",
        [req.params.id, req.user.client_id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Presupuesto no encontrado' });
      const budget = rows[0];

      const { rows: items } = await pool.query(
        "SELECT bi.*, p.name as product_name, s.name as service_name FROM budget_items bi LEFT JOIN products p ON bi.product_id = p.id LEFT JOIN services s ON bi.service_id = s.id WHERE bi.budget_id = $1 ORDER BY bi.id",
        [req.params.id]
      );

      const { rows: designRows } = await pool.query('SELECT * FROM budget_designs WHERE client_id = $1', [req.user.client_id]);
      const design = designRows[0] || {};
      const { rows: clientRows } = await pool.query('SELECT name, logo_url, address, phone, whatsapp, email, city, web_url FROM clients WHERE id = $1', [req.user.client_id]);
      const business = clientRows[0] || { name: 'VIB3 Retail' };

      const color = /^#[0-9a-fA-F]{6}$/.test(design.primary_color || '') ? design.primary_color : '#6c63ff';
      const showPrices = design.show_prices !== false;
      const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const date = (v) => v ? new Date(v).toLocaleDateString('es-AR') : '—';
      const safe = (v) => (v === null || v === undefined || v === '') ? '—' : String(v);

      // ── Try HTML template (puppeteer) first ──
      if (design.template_html && design.template_html.trim()) {
        try {
          const itemsHtml = buildBudgetItems(items || [], money, showPrices);
          const notaHtml = budget.notes ? '<div class="notes"><strong>Notas:</strong><br>' + String(budget.notes) + '</div>' : '';
          const vars = {
            COLOR: color,
            LOGO: '',
            NUMERO: safe(budget.number),
            CONTACT: safe(budget.client_name),
            FECHA: date(budget.created_at),
            VENCE: budget.valid_until ? date(budget.valid_until) : 'Sin vencimiento',
            ESTADO: String(budget.status || 'pendiente').toUpperCase(),
            ITEMS: itemsHtml,
            SUBTOTAL: money(budget.subtotal),
            DESCUENTO: money(budget.discount || 0),
            TOTAL: money(budget.total),
            NOTAS: notaHtml,
            FOOTER: safe(design.footer_text || 'Presupuesto sujeto a disponibilidad y confirmación.'),
          };
          const pdf = await renderHtmlToPdf(design.template_html, vars);
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', 'attachment; filename="Presupuesto-' + budget.number + '.pdf"');
          res.setHeader('Content-Length', pdf.length);
          return res.send(pdf);
        } catch (e) {
          console.error('HTML template PDF failed, falling back to PDFKit:', e.message);
        }
      }

      const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => {
        const pdf = Buffer.concat(chunks);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename="Presupuesto-' + budget.number + '.pdf"');
        res.setHeader('Content-Length', pdf.length);
        res.send(pdf);
      });

      const pageWidth = doc.page.width;
      const left = doc.page.margins.left;
      const right = pageWidth - doc.page.margins.right;
      const contentWidth = right - left;

      // Header
      doc.rect(0, 0, pageWidth, 95).fill(color);
      doc.fillColor('#ffffff').fontSize(23).font('Helvetica-Bold').text('PRESUPUESTO', left, 28, { width: contentWidth / 2 });
      doc.fontSize(12).font('Helvetica').text(budget.number, left, 58);
      doc.fontSize(18).font('Helvetica-Bold').text(safe(business.name), left + contentWidth / 2, 28, { width: contentWidth / 2, align: 'right' });
      doc.fontSize(9).font('Helvetica').text([business.address, business.phone || business.whatsapp, business.email, business.web_url].filter(Boolean).join(' · '), left + contentWidth / 2, 53, { width: contentWidth / 2, align: 'right' });

      // Meta boxes
      let y = 120;
      const boxW = (contentWidth - 16) / 2;
      doc.fillColor('#111827').fontSize(11).font('Helvetica-Bold').text('Datos del cliente', left, y);
      doc.fontSize(11).text('Datos del presupuesto', left + boxW + 16, y);
      y += 18;
      doc.roundedRect(left, y, boxW, 92, 8).fillAndStroke('#f8fafc', '#e5e7eb');
      doc.roundedRect(left + boxW + 16, y, boxW, 92, 8).fillAndStroke('#f8fafc', '#e5e7eb');
      doc.fillColor('#374151').fontSize(10).font('Helvetica');
      doc.text('Cliente: ' + safe(budget.client_name), left + 12, y + 13, { width: boxW - 24 });
      doc.text('Teléfono: ' + safe(budget.client_phone), left + 12, y + 31, { width: boxW - 24 });
      doc.text('Email: ' + safe(budget.client_email), left + 12, y + 49, { width: boxW - 24 });
      doc.text('Dirección: ' + safe(budget.client_address), left + 12, y + 67, { width: boxW - 24 });
      doc.text('Número: ' + budget.number, left + boxW + 28, y + 13, { width: boxW - 24 });
      doc.text('Fecha: ' + date(budget.created_at), left + boxW + 28, y + 31, { width: boxW - 24 });
      doc.text('Estado: ' + String(budget.status || 'pendiente').toUpperCase(), left + boxW + 28, y + 49, { width: boxW - 24 });
      doc.text('Validez: ' + (budget.valid_until ? date(budget.valid_until) : 'Sin vencimiento'), left + boxW + 28, y + 67, { width: boxW - 24 });

      // Items table
      y += 120;
      const cols = showPrices
        ? { desc: left, qty: left + 295, unit: left + 365, sub: left + 455 }
        : { desc: left, qty: left + 420 };
      const rowH = 28;
      doc.roundedRect(left, y, contentWidth, rowH, 6).fill(color);
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
      doc.text('Descripción', cols.desc + 10, y + 9, { width: showPrices ? 270 : 390 });
      doc.text('Cant.', cols.qty, y + 9, { width: 55, align: 'right' });
      if (showPrices) {
        doc.text('P. Unit.', cols.unit, y + 9, { width: 70, align: 'right' });
        doc.text('Subtotal', cols.sub, y + 9, { width: 65, align: 'right' });
      }
      y += rowH;

      doc.font('Helvetica').fontSize(9);
      items.forEach((item, idx) => {
        if (y > 720) {
          doc.addPage();
          y = 50;
        }
        const bg = idx % 2 === 0 ? '#ffffff' : '#f9fafb';
        doc.rect(left, y, contentWidth, rowH).fill(bg).stroke('#eef2f7');
        const name = item.product_name || item.service_name || item.description || 'Item';
        doc.fillColor('#111827').text(name, cols.desc + 10, y + 9, { width: showPrices ? 270 : 390, ellipsis: true });
        doc.fillColor('#374151').text(Number(item.quantity || 0).toLocaleString('es-AR'), cols.qty, y + 9, { width: 55, align: 'right' });
        if (showPrices) {
          doc.text(money(item.unit_price), cols.unit, y + 9, { width: 70, align: 'right' });
          doc.font('Helvetica-Bold').text(money(item.subtotal), cols.sub, y + 9, { width: 65, align: 'right' }).font('Helvetica');
        }
        y += rowH;
      });

      // Totals
      y += 18;
      if (y > 690) { doc.addPage(); y = 60; }
      const totalsX = right - 210;
      doc.fillColor('#111827').fontSize(10).font('Helvetica');
      if (showPrices) {
        doc.text('Subtotal', totalsX, y, { width: 95 });
        doc.text(money(budget.subtotal), totalsX + 95, y, { width: 115, align: 'right' });
        y += 20;
        doc.text('Descuento', totalsX, y, { width: 95 });
        doc.text('-' + money(budget.discount), totalsX + 95, y, { width: 115, align: 'right' });
        y += 24;
        doc.moveTo(totalsX, y - 8).lineTo(right, y - 8).stroke('#e5e7eb');
        doc.fillColor(color).fontSize(15).font('Helvetica-Bold').text('TOTAL', totalsX, y, { width: 95 });
        doc.text(money(budget.total), totalsX + 95, y, { width: 115, align: 'right' });
        y += 32;
      }

      if (budget.notes) {
        doc.fillColor('#111827').fontSize(10).font('Helvetica-Bold').text('Notas', left, y);
        y += 14;
        doc.fillColor('#374151').font('Helvetica').fontSize(9).text(String(budget.notes), left, y, { width: contentWidth });
        y += 32;
      }

      // Validity/footer
      const footerY = Math.max(y + 20, 760);
      doc.moveTo(left, footerY).lineTo(right, footerY).stroke('#e5e7eb');
      doc.fillColor('#6b7280').fontSize(9).font('Helvetica')
        .text('Validez del presupuesto: ' + (budget.valid_until ? date(budget.valid_until) : 'sin vencimiento especificado'), left, footerY + 12, { width: contentWidth / 2 });
      doc.text(design.footer_text || 'Presupuesto sujeto a disponibilidad y confirmación.', left + contentWidth / 2, footerY + 12, { width: contentWidth / 2, align: 'right' });

      doc.end();
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
