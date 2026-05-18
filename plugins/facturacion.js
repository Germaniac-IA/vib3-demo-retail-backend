const PDFDocument = require('pdfkit');
const { renderHtmlToPdf, buildInvoiceItems } = require('../html2pdf');

module.exports = function(app, pool, authenticate) {

  // ─── HELPERS ──────────────────────────────────────────────────

  const INVOICE_TYPE_LABELS = {
    1: 'Factura A', 2: 'Nota de Débito A', 3: 'Nota de Crédito A',
    6: 'Factura B', 7: 'Nota de Débito B', 8: 'Nota de Crédito B',
    11: 'Factura C', 12: 'Nota de Débito C', 13: 'Nota de Crédito C',
    51: 'Factura M', 81: 'Factura de Crédito Electrónica MiPyMEs',
  };

  const money = (n) => '$' + Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const date = (v) => v ? new Date(v).toLocaleDateString('es-AR') : '—';
  const safe = (v) => (v === null || v === undefined || v === '') ? '—' : String(v);

  // ─── LIST INVOICES ────────────────────────────────────────────

  app.get('/api/afip/invoices', authenticate, async (req, res) => {
    try {
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
      const offset = (page - 1) * limit;
      const search = req.query.search || '';

      let where = 'WHERE ai.client_id = $1';
      const params = [req.user.client_id];

      if (search) {
        params.push(`%${search}%`);
        where += ` AND (ai.client_name ILIKE $${params.length} OR CAST(ai.invoice_number AS TEXT) ILIKE $${params.length} OR ai.cae ILIKE $${params.length})`;
      }

      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM afip_invoices ai ${where}`, params
      );
      const total = parseInt(countResult.rows[0].total);

      const { rows } = await pool.query(
        `SELECT ai.*, o.order_number, o.total AS order_total
         FROM afip_invoices ai
         LEFT JOIN orders o ON o.id = ai.order_id
         ${where}
         ORDER BY ai.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      );

      res.json({ invoices: rows, total, page, limit });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── GET INVOICE BY ORDER ─────────────────────────────────────

  app.get('/api/afip/invoices/by-order/:orderId', authenticate, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ai.*, o.order_number FROM afip_invoices ai
         LEFT JOIN orders o ON o.id = ai.order_id
         WHERE ai.order_id = $1 AND ai.client_id = $2
         ORDER BY ai.created_at DESC LIMIT 1`,
        [req.params.orderId, req.user.client_id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Sin factura' });
      res.json(rows[0]);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── PDF INVOICE ──────────────────────────────────────────────

  app.get('/api/afip/invoices/:id/pdf', authenticate, async (req, res) => {
    try {
      // ── Load invoice + order + client data ──
      const { rows: invRows } = await pool.query(
        `SELECT ai.*, o.order_number, o.created_at AS order_date
         FROM afip_invoices ai
         LEFT JOIN orders o ON o.id = ai.order_id
         WHERE ai.id = $1 AND ai.client_id = $2`,
        [req.params.id, req.user.client_id]
      );
      if (!invRows[0]) return res.status(404).json({ error: 'Factura no encontrada' });
      const inv = invRows[0];

      const { rows: items } = await pool.query(
        `SELECT oi.product_name, oi.quantity, oi.unit_price, oi.subtotal
         FROM order_items oi WHERE oi.order_id = $1 AND oi.deleted_at IS NULL
         ORDER BY oi.id`,
        [inv.order_id]
      );

      const { rows: fdr } = await pool.query(
        'SELECT *, invoice_primary_color, invoice_footer_text, invoice_show_logo, invoice_show_prices FROM fiscal_data WHERE client_id = $1 LIMIT 1',
        [req.user.client_id]
      );
      const fiscal = fdr[0] || {};
      const invColor = fiscal.invoice_primary_color || '#1a1a2e';
      const invFooter = fiscal.invoice_footer_text || '';
      const invShowLogo = fiscal.invoice_show_logo === true;
      const invShowPrices = fiscal.invoice_show_prices !== false;

      const { rows: clr } = await pool.query(
        'SELECT name, logo_url, address, phone, whatsapp, email, city, web_url FROM clients WHERE id = $1',
        [req.user.client_id]
      );
      const business = clr[0] || {};

      const { rows: ctr } = inv.order_id ? await pool.query(
        `SELECT c.name, c.cuit, c.condicion_iva, c.address, c.phone, c.email
         FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
         WHERE o.id = $1`, [inv.order_id]
      ) : [];
      const client = ctr && ctr[0] ? ctr[0] : {
        name: inv.client_name || 'Consumidor Final',
        cuit: inv.client_doc_nro || '—',
        condicion_iva: 'Consumidor Final',
        address: null,
        phone: null,
        email: null,
      };

      // ── Try HTML template (puppeteer) first ──
      if (fiscal.invoice_template_html && fiscal.invoice_template_html.trim()) {
        try {
          const typeLabel = INVOICE_TYPE_LABELS[inv.invoice_type] || 'Comprobante';
          const typeShort = typeLabel.replace('Factura ', '').replace('Nota de Débito ', 'ND ').replace('Nota de Crédito ', 'NC ');
          const fullNumber = typeShort + ' ' + String(inv.punto_venta).padStart(4, '0') + '-' + String(inv.invoice_number).padStart(8, '0');
          const itemsHtml = buildInvoiceItems(items || [], money);
          const vars = {
            COLOR: invColor,
            LOGO: '',
            TIPO: typeShort,
            NUMERO_COMPLETO: fullNumber,
            FECHA: date(inv.created_at),
            CLIENTE: safe(client.name),
            CLIENTE_CUIT: safe(client.cuit),
            CLIENTE_IVA: safe(client.condicion_iva),
            EMISOR: safe(fiscal.razon_social || business.name),
            CUIT_EMISOR: safe(fiscal.cuit),
            ITEMS: itemsHtml,
            NETO: money(inv.neto),
            IVA: money(inv.iva),
            TOTAL: money(inv.total),
            CAE: safe(inv.cae).padStart(14, ' ').replace(/(.{4})/g, '$1 '),
            CAE_VTO: inv.cae_vencimiento ? date(inv.cae_vencimiento) : '—',
            FOOTER: invFooter || safe(fiscal.razon_social || business.name) + ' · CUIT: ' + safe(fiscal.cuit),
          };
          const pdf = await renderHtmlToPdf(fiscal.invoice_template_html, vars);
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', 'attachment; filename="' + typeLabel + '-' + String(inv.punto_venta).padStart(4, '0') + '-' + String(inv.invoice_number).padStart(8, '0') + '.pdf"');
          res.setHeader('Content-Length', pdf.length);
          return res.send(pdf);
        } catch (e) {
          console.error('HTML template PDF failed, falling back to PDFKit:', e.message);
        }
      }

      // ── Build PDF (PDFKit fallback) ──
      const doc = new PDFDocument({ size: 'A4', margin: 42, bufferPages: true });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => {
        const pdf = Buffer.concat(chunks);
        const typeLabel = INVOICE_TYPE_LABELS[inv.invoice_type] || 'Comprobante';
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${typeLabel}-${String(inv.punto_venta).padStart(4, '0')}-${String(inv.invoice_number).padStart(8, '0')}.pdf"`);
        res.setHeader('Content-Length', pdf.length);
        res.send(pdf);
      });

      const pw = doc.page.width;
      const lm = doc.page.margins.left;
      const rm = pw - doc.page.margins.right;
      const cw = rm - lm;

      // ══════════════════════════════════════════════════
      //  HEADER — Company info + Invoice type
      // ══════════════════════════════════════════════════
      doc.rect(0, 0, pw, 110).fill(invColor);
      doc.fillColor('#ffffff').fontSize(26).font('Helvetica-Bold')
        .text(safe(fiscal.razon_social || business.name), lm, 22, { width: cw * 0.65 });
      doc.fontSize(10).font('Helvetica')
        .text(`CUIT: ${safe(fiscal.cuit)}`, lm, 56);
      if (fiscal.condicion_iva) {
        doc.text(`Condición IVA: ${safe(fiscal.condicion_iva)}`, lm, 72);
      }
      const addrLine = [business.address, business.city].filter(Boolean).join(', ');
      if (addrLine) doc.text(`Domicilio: ${addrLine}`, lm, 88);

      // Invoice type & number — right side
      const typeLabel = INVOICE_TYPE_LABELS[inv.invoice_type] || 'Comprobante';
      const typeShort = typeLabel.replace('Factura ', '').replace('Nota de Débito ', 'ND ').replace('Nota de Crédito ', 'NC ');
      const fullNumber = `${typeShort} ${String(inv.punto_venta).padStart(4, '0')}-${String(inv.invoice_number).padStart(8, '0')}`;
      doc.fontSize(16).font('Helvetica-Bold').text(fullNumber, rm, 24, { width: cw * 0.33, align: 'right' });
      doc.fontSize(9).font('Helvetica').text(`Fecha: ${date(inv.created_at)}`, rm, 48, { width: cw * 0.33, align: 'right' });
      doc.fontSize(9).font('Helvetica').text(`Fecha: ${date(inv.created_at)}`, rm, 72, { width: cw * 0.33, align: 'right' });

      // ══════════════════════════════════════════════════
      //  CLIENT INFO
      // ══════════════════════════════════════════════════
      let y = 132;
      doc.fillColor('#111827').fontSize(11).font('Helvetica-Bold').text('DATOS DEL CLIENTE', lm, y);
      y += 18;
      doc.roundedRect(lm, y, cw, 82, 6).fillAndStroke('#f8fafc', '#d1d5db');
      doc.fillColor('#374151').fontSize(10).font('Helvetica');
      const colW = cw / 2 - 18;
      doc.text(`Cliente: ${safe(client.name)}`, lm + 12, y + 12, { width: colW });
      doc.text(`CUIT/CUIL: ${safe(client.cuit)}`, lm + 12, y + 30, { width: colW });
      doc.text(`Condición IVA: ${safe(client.condicion_iva)}`, lm + 12, y + 48, { width: colW });
      if (client.address) doc.text(`Dirección: ${safe(client.address)}`, lm + 12, y + 66, { width: colW });
      doc.text(`Comprobante: ${fullNumber}`, lm + colW + 24, y + 12, { width: colW });
      doc.text(`CAE: ${safe(inv.cae)}`, lm + colW + 24, y + 30, { width: colW });
      doc.text(`Vto. CAE: ${inv.cae_vencimiento ? date(inv.cae_vencimiento) : '—'}`, lm + colW + 24, y + 48, { width: colW });
      doc.text(`Estado: ${safe(inv.fiscal_status).toUpperCase()}`, lm + colW + 24, y + 66, { width: colW });
      doc.fillColor('#2563eb').fontSize(11).font('Helvetica-Bold');
      doc.text(`CAE N°: ${safe(inv.cae)}`, lm + 12, y + 66, { width: colW });

      // ══════════════════════════════════════════════════
      //  ITEMS TABLE
      // ══════════════════════════════════════════════════
      y += 106;
      const th = 26;
      const colDesc = lm;
      const colQty = lm + 280;
      const colUnit = lm + 340;
      const colSub = lm + 435;
      const acc6 = cw - 435;

      doc.roundedRect(lm, y, cw, th, 6).fill(invColor);
      doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
      doc.text('DESCRIPCIÓN', colDesc + 10, y + 8, { width: 260 });
      doc.text('CANT.', colQty, y + 8, { width: 50, align: 'right' });
      doc.text('P. UNIT.', colUnit, y + 8, { width: 85, align: 'right' });
      doc.text('SUBTOTAL', colSub, y + 8, { width: acc6, align: 'right' });
      y += th;

      doc.font('Helvetica').fontSize(9);
      items.forEach((item, idx) => {
        if (y > 700) { doc.addPage(); y = 50; }
        const bg = idx % 2 === 0 ? '#ffffff' : '#f9fafb';
        doc.rect(lm, y, cw, 26).fill(bg).stroke('#e5e7eb');
        doc.fillColor('#111827').text(item.product_name || 'Item', colDesc + 10, y + 8, { width: 260, ellipsis: true });
        doc.fillColor('#374151').text(String(Number(item.quantity || 0).toLocaleString('es-AR')), colQty, y + 8, { width: 50, align: 'right' });
        doc.text(money(item.unit_price), colUnit, y + 8, { width: 85, align: 'right' });
        doc.font('Helvetica-Bold').text(money(item.subtotal), colSub, y + 8, { width: acc6, align: 'right' }).font('Helvetica');
        y += 26;
      });

      // ══════════════════════════════════════════════════
      //  TOTALS
      // ══════════════════════════════════════════════════
      y += 16;
      if (y > 690) { doc.addPage(); y = 60; }
      const totX = rm - 210;
      doc.fillColor('#111827').fontSize(10).font('Helvetica');
      doc.text('Neto Gravado', totX, y, { width: 95 });
      doc.text(money(inv.neto), totX + 95, y, { width: 115, align: 'right' });
      y += 20;
      doc.text('IVA', totX, y, { width: 95 });
      doc.text(money(inv.iva), totX + 95, y, { width: 115, align: 'right' });
      y += 22;
      doc.moveTo(totX, y - 6).lineTo(rm, y - 6).stroke('#d1d5db');
      doc.fillColor(invColor).fontSize(16).font('Helvetica-Bold').text('TOTAL', totX, y, { width: 95 });
      doc.text(money(inv.total), totX + 95, y, { width: 115, align: 'right' });

      // ══════════════════════════════════════════════════
      //  CAE & QR / Bar-CODE area
      // ══════════════════════════════════════════════════
      y += 40;
      if (y > 700) { doc.addPage(); y = 60; }
      doc.roundedRect(lm, y, cw, 70, 8).fillAndStroke('#f0f5ff', '#bfdbfe');
      doc.fillColor('#1e40af').fontSize(12).font('Helvetica-Bold');

      // CAE in large text
      const caeText = inv.cae ? inv.cae.padStart(14, ' ').replace(/(.{4})/g, '$1 ') : '—';
      doc.text(`C.A.E. N°: ${caeText}`, lm + 16, y + 12, { width: cw - 32 });
      doc.fontSize(10).font('Helvetica');
      doc.fillColor('#374151');
      doc.text(`Fecha de Vencimiento: ${inv.cae_vencimiento ? date(inv.cae_vencimiento) : '—'}`, lm + 16, y + 34);
      doc.text(`Comprobante: ${fullNumber}`, lm + 16, y + 50);

      // ══════════════════════════════════════════════════
      //  FOOTER
      // ══════════════════════════════════════════════════
      y += 90;
      const footerY = Math.max(y + 10, 770);
      doc.moveTo(lm, footerY).lineTo(rm, footerY).stroke('#d1d5db');
      doc.fillColor('#6b7280').fontSize(8).font('Helvetica');
      const footerLeft = invFooter || `${safe(fiscal.razon_social || business.name)} · CUIT: ${safe(fiscal.cuit)} · ${safe(fiscal.condicion_iva || '')}`;
      const footerRight = 'Original · Documento Fiscal válido';
      doc.text(footerLeft, lm, footerY + 10, { width: cw * 0.6 });
      doc.text(footerRight, lm + cw * 0.6, footerY + 10, { width: cw * 0.4, align: 'right' });

      if (inv.fiscal_status === 'anulado') {
        doc.fillColor('#dc2626').fontSize(18).font('Helvetica-Bold');
        const anuladoText = 'DOCUMENTO ANULADO';
        const atw = doc.widthOfString(anuladoText);
        doc.rotate(-30);
        doc.text(anuladoText, 120, 400, { width: 500, align: 'center' });
        doc.rotate(30);
      }

      doc.end();
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── INVOICE DESIGN CONFIG ─────────────────────────────────────

  app.get('/api/afip/design', authenticate, async (req, res) => {
    try {
      const { rows } = await pool.query(
        'SELECT client_id, invoice_primary_color, invoice_footer_text, invoice_show_logo, invoice_show_prices, invoice_template_html FROM fiscal_data WHERE client_id = $1 LIMIT 1',
        [req.user.client_id]
      );
      if (!rows[0]) return res.json({
        invoice_primary_color: '#1a1a2e', invoice_footer_text: '', invoice_show_logo: false, invoice_show_prices: true, invoice_template_html: ''
      });
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/afip/design', authenticate, async (req, res) => {
    try {
      const { invoice_primary_color, invoice_footer_text, invoice_show_logo, invoice_show_prices, invoice_template_html } = req.body;
      const { rows } = await pool.query(
        `UPDATE fiscal_data SET 
          invoice_primary_color = COALESCE($1, invoice_primary_color),
          invoice_footer_text = COALESCE($2, invoice_footer_text),
          invoice_show_logo = COALESCE($3, invoice_show_logo),
          invoice_show_prices = COALESCE($4, invoice_show_prices),
          invoice_template_html = COALESCE($5, invoice_template_html),
          updated_at = NOW()
         WHERE client_id = $6 RETURNING *`,
        [invoice_primary_color, invoice_footer_text, invoice_show_logo, invoice_show_prices, invoice_template_html, req.user.client_id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Config fiscal no encontrada' });
      res.json(rows[0]);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

};
