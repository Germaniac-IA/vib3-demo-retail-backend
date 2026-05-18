// Módulo AFIP/ARCA — Factura Electrónica
const afipService = require('./afipService');

const IVA_MAP = {
  'responsable inscripto': 1,
  'responsable no inscripto': 2,
  'exento': 3,
  'consumidor final': 4,
  'monotributo': 5,
  'sujeto exento': 6,
};

function condicionIvaToAfipId(condicion) {
  if (!condicion) return null;
  const key = condicion.toLowerCase().trim();
  return IVA_MAP[key] || null;
}

// Auto-detectar tipo de factura según AFIP
function detectarTipoFactura(emisorCond, clienteCond) {
  const e = (emisorCond || '').toLowerCase().trim();
  const c = (clienteCond || '').toLowerCase().trim();
  if (e.includes('monotributo')) return 11; // Factura C
  if (e.includes('responsable inscripto')) {
    if (c.includes('responsable inscripto')) return 1; // Factura A
    return 6; // Factura B
  }
  if (e.includes('exento')) return null; // No puede emitir
  return 6; // Default Factura B
}

const CREDIT_NOTE_TYPES = { 1: 3, 6: 8, 11: 13 }; // Factura A/B/C -> NC A/B/C
const INVOICE_TYPES_BY_CREDIT_NOTE = { 3: 1, 8: 6, 13: 11 };

function creditNoteTypeFor(invoiceType) {
  return CREDIT_NOTE_TYPES[Number(invoiceType)] || null;
}

const CONSUMIDOR_FINAL_DOC_THRESHOLD = 10000000; // ARCA: identificación obligatoria CF >= $10.000.000

function isConsumidorFinal(cond) {
  const c = (cond || '').toLowerCase().trim();
  return !c || c.includes('consumidor final') || c === 'cf';
}

function normalizeDocForAfip({ invoiceType, contactCuit, contactCondicionIva, total }) {
  const cleanDoc = String(contactCuit || '').replace(/[^0-9]/g, '');
  const isCF = isConsumidorFinal(contactCondicionIva);

  // Consumidor final bajo umbral: no requiere identificación.
  if (isCF && Number(total || 0) < CONSUMIDOR_FINAL_DOC_THRESHOLD) {
    return { doc_tipo: 99, doc_nro: 0, required: false, reason: 'Consumidor final bajo umbral ARCA' };
  }

  // Consumidor final sobre umbral: requiere CUIT/CUIL/CDI/DNI/pasaporte.
  if (isCF && !cleanDoc) {
    return { error: 'Consumidor final >= $10.000.000 requiere CUIT/CUIL/CDI/DNI/documento.' };
  }

  // No consumidor final: necesitamos CUIT/CUIL para facturar correctamente.
  if (!isCF && !cleanDoc) {
    return { error: 'El destinatario fiscal requiere CUIT/CUIL cargado.' };
  }

  const docTipo = cleanDoc.length === 11 ? 80 : 96; // 80 CUIT/CUIL, 96 DNI
  return { doc_tipo: docTipo, doc_nro: cleanDoc, required: true, reason: 'Documento informado' };
}

async function buildIvaArray(orderId, pool, clientId, fallbackNeto, fallbackIva, fallbackPct) {
  if (!orderId) {
    const pct = parseFloat(fallbackPct || 21);
    return pct > 0 ? [{ Id: 5, BaseImp: fallbackNeto, Importe: fallbackIva }] : [];
  }
  const itemsQ = await pool.query(`
    SELECT oi.subtotal, p.alicuota, fd.alicuota_default
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    CROSS JOIN fiscal_data fd ON fd.client_id = oi.client_id AND fd.deleted_at IS NULL
    WHERE oi.order_id = $1
  `, [orderId]);
  const ivaMap = {};
  for (const item of itemsQ.rows) {
    const pct = item.alicuota ? parseFloat(item.alicuota) : (parseFloat(item.alicuota_default) || 21);
    const base = parseFloat(item.subtotal) || 0;
    if (pct > 0) {
      const imp = Math.round((base * pct / 100) * 100) / 100;
      if (!ivaMap[pct]) ivaMap[pct] = { base: 0, iva: 0 };
      ivaMap[pct].base += base;
      ivaMap[pct].iva += imp;
    }
  }
  const pctToId = { "0": 3, "2.5": 9, "5": 8, "10.5": 4, "21": 5, "27": 6 };
  return Object.entries(ivaMap).map(([pct, v]) => ({
    Id: pctToId[pct] || 5,
    BaseImp: Math.round(v.base * 100) / 100,
    Importe: Math.round(v.iva * 100) / 100,
  }));
}


function normalizeIvaArrayForCreditNote(inv, fallbackIvaArray = []) {
  const payload = typeof inv.arca_request_payload === 'string'
    ? (() => { try { return JSON.parse(inv.arca_request_payload); } catch { return null; } })()
    : inv.arca_request_payload;
  const source = Array.isArray(payload?.iva) && payload.iva.length ? payload.iva : fallbackIvaArray;
  return (source || []).map(i => ({
    Id: Number(i.Id),
    BaseImp: Math.abs(Math.round(Number(i.BaseImp || 0) * 100) / 100),
    Importe: Math.abs(Math.round(Number(i.Importe || 0) * 100) / 100),
  })).filter(i => i.Id && i.BaseImp >= 0 && i.Importe >= 0);
}

module.exports = function (app, pool, authenticate) {


  async function getAfipConfig({ clientId, orderId = null, afipPosId = null } = {}) {
    let posId = afipPosId ? Number(afipPosId) : null;
    if (!posId && orderId) {
      const r = await pool.query(`
        SELECT sc.afip_pos_id
        FROM orders o
        LEFT JOIN sale_channels sc ON sc.id = o.sale_channel_id
        WHERE o.id = $1 AND o.client_id = $2
      `, [orderId, clientId]);
      posId = r.rows[0]?.afip_pos_id || null;
    }
    let pos;
    if (posId) {
      const r = await pool.query('SELECT * FROM afip_points_of_sale WHERE id = $1 AND client_id = $2 AND deleted_at IS NULL AND is_active = true', [posId, clientId]);
      pos = r.rows[0];
    }
    if (!pos) {
      const r = await pool.query('SELECT * FROM afip_points_of_sale WHERE client_id = $1 AND deleted_at IS NULL AND is_active = true ORDER BY is_default DESC, id LIMIT 1', [clientId]);
      pos = r.rows[0];
    }
    const fiscal = await afipService.getFiscalConfig(pool, clientId);
    if (!fiscal || !pos || !pos.certificate_pem || !pos.private_key_pem) return null;
    return { ...fiscal, certificate_pem: pos.certificate_pem, private_key_pem: pos.private_key_pem, production: pos.production, punto_venta: pos.punto_venta, afip_pos_id: pos.id, afip_pos_name: pos.name };
  }

  function formatAfipDate(d) {
    return d.toISOString().slice(0, 10).replace(/-/g, '');
  }

  function parseAfipDate(str) {
    if (!str) return null;
    const s = String(str).replace(/[^0-9]/g, '');
    if (s.length !== 8) return null;
    return new Date(`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}T00:00:00`);
  }

  async function resolveInvoiceDate({ requestedFecha, clientId, puntoVenta }) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const min = new Date(today); min.setDate(min.getDate() - 5);
    const requested = requestedFecha ? parseAfipDate(requestedFecha) : today;
    if (!requested || Number.isNaN(requested.getTime())) {
      const err = new Error('Fecha de facturación inválida'); err.statusCode = 400; throw err;
    }
    if (requested > today) {
      const err = new Error('La fecha de facturación no puede ser futura'); err.statusCode = 400; throw err;
    }
    if (requested < min) {
      const err = new Error('La fecha de facturación no puede tener más de 5 días de antigüedad'); err.statusCode = 400; throw err;
    }
    const last = await pool.query(`
      SELECT MAX(arca_request_payload->>'fecha') AS last_fecha
      FROM afip_invoices
      WHERE client_id = $1 AND punto_venta = $2 AND result = 'A' AND arca_request_payload ? 'fecha'
    `, [clientId, puntoVenta]);
    const lastDate = parseAfipDate(last.rows[0]?.last_fecha);
    if (lastDate && requested < lastDate) {
      const err = new Error(`La fecha no puede ser anterior a la última factura emitida de este punto de venta (${formatAfipDate(lastDate)})`);
      err.statusCode = 400; throw err;
    }
    return formatAfipDate(requested);
  }

  async function logAfipEvent({ req, invoiceId = null, orderId = null, batchId = null, eventType, status = 'info', message = null, requestPayload = null, responsePayload = null, errorPayload = null }) {
    try {
      await pool.query(`
        INSERT INTO afip_emission_events
          (client_id, invoice_id, order_id, emission_batch_id, event_type, event_status, message,
           request_payload, response_payload, error_payload, created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [
        req.user.client_id, invoiceId, orderId, batchId, eventType, status, message,
        requestPayload ? JSON.stringify(requestPayload) : null,
        responsePayload ? JSON.stringify(responsePayload) : null,
        errorPayload ? JSON.stringify(errorPayload) : null,
        req.user.id || null,
      ]);
    } catch (e) {
      console.warn('[afip] No se pudo registrar evento:', e.message);
    }
  }

  // ─── Config AFIP desde fiscal_data ────────────────────────

  app.post('/api/afip/config', authenticate, async (req, res) => {
    try {
      const { cuit, razon_social, condicion_iva, certificate_pem, private_key_pem, production, punto_venta } = req.body;

      const result = await pool.query(`
        INSERT INTO fiscal_data
          (client_id, cuit, razon_social, condicion_iva, certificate_pem, private_key_pem, production, punto_venta)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (client_id) DO UPDATE SET
          cuit = COALESCE(NULLIF(EXCLUDED.cuit, ''), fiscal_data.cuit),
          razon_social = COALESCE(NULLIF(EXCLUDED.razon_social, ''), fiscal_data.razon_social),
          condicion_iva = COALESCE(NULLIF(EXCLUDED.condicion_iva, ''), fiscal_data.condicion_iva),
          certificate_pem = COALESCE(NULLIF(EXCLUDED.certificate_pem, ''), fiscal_data.certificate_pem),
          private_key_pem = COALESCE(NULLIF(EXCLUDED.private_key_pem, ''), fiscal_data.private_key_pem),
          production = COALESCE(NULLIF(EXCLUDED.production::text, '')::boolean, fiscal_data.production),
          punto_venta = COALESCE(NULLIF(EXCLUDED.punto_venta, 1), fiscal_data.punto_venta)
      `, [
        req.user.client_id, cuit || '', razon_social || '', condicion_iva || '',
        certificate_pem || '', private_key_pem || '',
        production || false, punto_venta || 1
      ]);

      res.json({ success: true, message: 'Configuración guardada' });
    } catch (err) {
      console.error('[afip] Error guardando config:', err.message);
      res.status(500).json({ error: 'Error guardando configuración AFIP' });
    }
  });

  app.get('/api/afip/config', authenticate, async (req, res) => {
    try {
      const fiscal = await afipService.getFiscalConfig(pool, req.user.client_id);
      if (!fiscal) {
        return res.status(404).json({ error: 'AFIP no configurado' });
      }
      res.json({
        cuit: fiscal.cuit,
        razon_social: fiscal.razon_social,
        condicion_iva: fiscal.condicion_iva,
        situacion_iibb: fiscal.situacion_iibb,
        numero_iibb: fiscal.numero_iibb,
        production: fiscal.production,
        punto_venta: fiscal.punto_venta,
        has_afip_certs: !!((fiscal.certificate_pem && fiscal.private_key_pem) || (await pool.query('SELECT 1 FROM afip_points_of_sale WHERE client_id = $1 AND deleted_at IS NULL AND is_active = true AND certificate_pem IS NOT NULL AND private_key_pem IS NOT NULL LIMIT 1', [req.user.client_id])).rowCount),
        configured: true,
      });
    } catch (err) {
      res.status(500).json({ error: 'Error leyendo configuración' });
    }
  });


  app.get('/api/afip/points-config', authenticate, async (req, res) => {
    try {
      const r = await pool.query(`SELECT id, punto_venta, name, production, is_default, is_active, certificate_pem IS NOT NULL AND private_key_pem IS NOT NULL as has_certs FROM afip_points_of_sale WHERE client_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, punto_venta`, [req.user.client_id]);
      res.json(r.rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.post('/api/afip/points-config', authenticate, async (req, res) => {
    try {
      const { punto_venta, name, certificate_pem, private_key_pem, production, is_default, is_active } = req.body;
      if (!punto_venta) return res.status(400).json({ error: 'Punto de venta requerido' });
      const result = await pool.query(`
        INSERT INTO afip_points_of_sale (client_id, punto_venta, name, certificate_pem, private_key_pem, production, is_default, is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (client_id, punto_venta, production) DO UPDATE SET
          name = EXCLUDED.name,
          certificate_pem = COALESCE(NULLIF(EXCLUDED.certificate_pem, ''), afip_points_of_sale.certificate_pem),
          private_key_pem = COALESCE(NULLIF(EXCLUDED.private_key_pem, ''), afip_points_of_sale.private_key_pem),
          is_default = EXCLUDED.is_default,
          is_active = EXCLUDED.is_active,
          deleted_at = NULL,
          updated_at = NOW()
        RETURNING *
      `, [req.user.client_id, Number(punto_venta), name || `PV ${punto_venta}`, certificate_pem || '', private_key_pem || '', production === true, is_default === true, is_active !== false]);
      if (result.rows[0].is_default) await pool.query('UPDATE afip_points_of_sale SET is_default = false WHERE client_id = $1 AND id <> $2', [req.user.client_id, result.rows[0].id]);
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.put('/api/afip/points-config/:id', authenticate, async (req, res) => {
    try {
      const { punto_venta, name, certificate_pem, private_key_pem, production, is_default, is_active } = req.body;
      const result = await pool.query(`
        UPDATE afip_points_of_sale SET
          punto_venta = COALESCE($1, punto_venta),
          name = COALESCE($2, name),
          certificate_pem = COALESCE(NULLIF($3, ''), certificate_pem),
          private_key_pem = COALESCE(NULLIF($4, ''), private_key_pem),
          production = COALESCE($5, production),
          is_default = COALESCE($6, is_default),
          is_active = COALESCE($7, is_active),
          updated_at = NOW()
        WHERE id = $8 AND client_id = $9 AND deleted_at IS NULL RETURNING *
      `, [punto_venta ? Number(punto_venta) : null, name || null, certificate_pem || '', private_key_pem || '', production, is_default, is_active, req.params.id, req.user.client_id]);
      if (!result.rows[0]) return res.status(404).json({ error: 'Punto de venta no encontrado' });
      if (result.rows[0].is_default) await pool.query('UPDATE afip_points_of_sale SET is_default = false WHERE client_id = $1 AND id <> $2', [req.user.client_id, result.rows[0].id]);
      res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  app.delete('/api/afip/points-config/:id', authenticate, async (req, res) => {
    try {
      await pool.query('UPDATE afip_points_of_sale SET deleted_at = NOW(), is_active = false WHERE id = $1 AND client_id = $2', [req.params.id, req.user.client_id]);
      await pool.query('UPDATE sale_channels SET afip_pos_id = NULL WHERE afip_pos_id = $1 AND client_id = $2', [req.params.id, req.user.client_id]);
      res.json({ message: 'Eliminado' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  async function requireAfip(req, res, next) {
    const config = await getAfipConfig({ clientId: req.user.client_id, orderId: req.body?.order_id || null, afipPosId: req.body?.afip_pos_id || req.query?.afip_pos_id || null });
    if (!config) {
      return res.status(400).json({
        error: 'AFIP no configurado. Cargá al menos un punto de venta con certificado y clave ARCA.',
      });
    }
    req.afipConfig = config;
    next();
  }

  // ─── Búsqueda de NVs para facturar ────────────────────────

  app.get('/api/afip/orders', authenticate, async (req, res) => {
    try {
      const search = req.query.search || '';
      const from = req.query.from || '';
      const to = req.query.to || '';
      const channelId = req.query.channel_id || '';
      const paymentMethodId = req.query.payment_method_id || '';
      const limit = Math.min(parseInt(req.query.limit) || 50, 100);
      const offset = parseInt(req.query.offset) || 0;

      const params = [req.user.client_id];
      const conds = ["o.client_id = $1", "o.order_type = 'NV'", "o.deleted_at IS NULL"];
      let idx = 2;

      if (search) {
        params.push(`%${search}%`);
        conds.push(`(c.name ILIKE $${idx} OR o.order_number ILIKE $${idx}
          OR oi.product_name ILIKE $${idx} OR c.cuit ILIKE $${idx})`);
        idx++;
      }
      if (from) { params.push(from); conds.push(`o.created_at >= $${idx}`); idx++; }
      if (to) { params.push(to + ' 23:59:59'); conds.push(`o.created_at <= $${idx}`); idx++; }
      if (channelId) { params.push(Number(channelId)); conds.push(`o.sale_channel_id = $${idx}`); idx++; }

      // Filtro por método de pago: si es "op" busca en order_payments, si es "main" busca en orders.payment_method_id
      if (paymentMethodId) {
        const pmId = Number(paymentMethodId);
        params.push(pmId);
        conds.push(`(o.payment_method_id = $${idx} OR EXISTS (
          SELECT 1 FROM order_payments op2 WHERE op2.order_id = o.id
          AND op2.payment_method_id = $${idx} AND op2.deleted_at IS NULL
        ))`);
        idx++;
      }

      const where = conds.join(' AND ');

      const countResult = await pool.query(`
        SELECT COUNT(DISTINCT o.id) FROM orders o
        LEFT JOIN contacts c ON c.id = o.contact_id
        LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
        WHERE ${where}
      `, params);

      const orders = await pool.query(`
        SELECT DISTINCT ON (o.id)
          o.id, o.order_number, o.subtotal, o.delivery_fee, o.total, o.created_at,
          c.id as contact_id, c.name as contact_name, c.cuit as contact_cuit, c.condicion_iva as contact_condicion_iva,
          sc.name as sale_channel_name,
          (SELECT jsonb_agg(jsonb_build_object(
            'product_name', oi2.product_name,
            'quantity', oi2.quantity,
            'unit_price', oi2.unit_price,
            'subtotal', oi2.subtotal
          )) FROM order_items oi2 WHERE oi2.order_id = o.id AND oi2.deleted_at IS NULL) as items,
          (SELECT ai2.cae FROM afip_invoices ai2 WHERE ai2.order_id = o.id LIMIT 1) as factura_cae,
          (SELECT ai2.result FROM afip_invoices ai2 WHERE ai2.order_id = o.id LIMIT 1) as factura_resultado,
          (SELECT ai2.id FROM afip_invoices ai2 WHERE ai2.order_id = o.id LIMIT 1) as factura_id
        FROM orders o
        LEFT JOIN contacts c ON c.id = o.contact_id
        LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.deleted_at IS NULL
        LEFT JOIN sale_channels sc ON sc.id = o.sale_channel_id
        WHERE ${where}
        ORDER BY o.id DESC
        LIMIT $${idx} OFFSET $${idx + 1}
      `, [...params, limit, offset]);

      res.json({
        orders: orders.rows,
        total: parseInt(countResult.rows[0].count),
        limit,
        offset,
      });
    } catch (err) {
      console.error('[afip] Error buscando NVs:', err.message);
      res.status(500).json({ error: 'Error buscando NVs' });
    }
  });

  // ─── Info para facturar una NV específica ──────────────────

  app.get('/api/afip/orders/:id', authenticate, async (req, res) => {
    try {
      const order = await pool.query(`
        SELECT o.*, c.name as contact_name, c.cuit as contact_cuit,
          c.condicion_iva as contact_condicion_iva
        FROM orders o
        LEFT JOIN contacts c ON c.id = o.contact_id
        WHERE o.id = $1 AND o.client_id = $2
      `, [req.params.id, req.user.client_id]);

      if (order.rows.length === 0) {
        return res.status(404).json({ error: 'NV no encontrada' });
      }

      const items = await pool.query(`
        SELECT product_name, quantity, unit_price, subtotal
        FROM order_items WHERE order_id = $1 AND deleted_at IS NULL
      `, [req.params.id]);

      // Detectar tipo de factura
      const fiscal = await afipService.getFiscalConfig(pool, req.user.client_id);
      const invoiceType = fiscal && order.rows[0].contact_condicion_iva
        ? detectarTipoFactura(fiscal.condicion_iva, order.rows[0].contact_condicion_iva)
        : 6;

      res.json({
        order: order.rows[0],
        items: items.rows,
        invoice_type_auto: invoiceType,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── Operaciones AFIP ─────────────────────────────────────

  app.get('/api/afip/status', authenticate, requireAfip, async (req, res) => {
    try {
      const status = await afipService.testConnection(req.afipConfig);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/afip/puntos-venta', authenticate, requireAfip, async (req, res) => {
    try {
      const puntos = await afipService.getSalesPoints(req.afipConfig);
      res.json({ puntos_venta: puntos });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/afip/tipos-comprobante', authenticate, requireAfip, async (req, res) => {
    try {
      const tipos = await afipService.getVoucherTypes(req.afipConfig);
      res.json({ tipos_comprobante: tipos });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/afip/ultimo-comprobante', authenticate, requireAfip, async (req, res) => {
    try {
      const ptoVta = parseInt(req.query.ptoVta) || req.afipConfig.punto_venta;
      const tipo = parseInt(req.query.tipo) || 6;
      const ultimo = await afipService.getLastVoucher(req.afipConfig, ptoVta, tipo);
      res.json({ punto_venta: ptoVta, tipo, ultimo: ultimo || 0 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/afip/facturar', authenticate, requireAfip, async (req, res) => {
    try {
      const { order_id, invoice_type, doc_tipo, doc_nro, client_name, neto, iva_pct, tributos, total, fecha } = req.body;

      let invType = invoice_type;
      let docTipo = doc_tipo;
      let docNro = doc_nro;
      let clientName = client_name;
      let buyerCondicionIva = '';
      let buyerOriginalDoc = '';
      let impNeto = parseFloat(neto || 0);
      let impIva = 0;
      let impTotal = parseFloat(total || 0);

      // Si viene order_id, tomar datos de la NV
      if (order_id) {
        const existingInvoice = await pool.query(
          "SELECT id, cae, invoice_type, invoice_number FROM afip_invoices WHERE order_id = $1 AND client_id = $2 AND result = 'A' LIMIT 1",
          [order_id, req.user.client_id]
        );
        if (existingInvoice.rows.length > 0) {
          return res.status(409).json({
            error: 'La NV ya tiene factura emitida',
            invoice: existingInvoice.rows[0]
          });
        }

        const orderQ = await pool.query(`
          SELECT o.*, c.name as cname, c.cuit as ccuit, c.condicion_iva as ccondiva
          FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
          WHERE o.id = $1 AND o.client_id = $2
        `, [order_id, req.user.client_id]);

        if (orderQ.rows.length === 0) {
          return res.status(404).json({ error: 'NV no encontrada' });
        }

        const ord = orderQ.rows[0];
        clientName = clientName || ord.cname || '';
        buyerCondicionIva = ord.ccondiva || '';
        buyerOriginalDoc = ord.ccuit || '';
        impNeto = impNeto || parseFloat(ord.subtotal) || 0;
        impTotal = impTotal || parseFloat(ord.total) || 0;

        // Auto-detectar tipo de factura si no se especificó
        if (!invType) {
          const fiscal = await afipService.getFiscalConfig(pool, req.user.client_id);
          invType = detectarTipoFactura(fiscal.condicion_iva, ord.ccondiva) || 6;
        }
      }

      if (!invType || impNeto <= 0) {
        return res.status(400).json({ error: 'Faltan datos: invoice_type, neto' });
      }

      let ivaArray = [];
      if (order_id) {
        ivaArray = await buildIvaArray(order_id, pool, req.user.client_id, impNeto, 0, iva_pct || 21);
        impIva = ivaArray.reduce((sum, item) => sum + Number(item.Importe || 0), 0);
      } else {
        const ivaPct = parseFloat(iva_pct || 21);
        impIva = ivaPct > 0 ? Math.round((impNeto * ivaPct / 100) * 100) / 100 : 0;
        ivaArray = ivaPct > 0 ? [{ Id: 5, BaseImp: impNeto, Importe: impIva }] : [];
      }
      impIva = Math.round(impIva * 100) / 100;
      impTotal = Math.round((impNeto + impIva) * 100) / 100;

      if (!docTipo && !docNro) {
        const doc = normalizeDocForAfip({
          invoiceType: invType,
          contactCuit: buyerOriginalDoc,
          contactCondicionIva: buyerCondicionIva,
          total: impTotal,
        });
        if (doc.error) return res.status(400).json({ error: doc.error });
        docTipo = doc.doc_tipo;
        docNro = doc.doc_nro;
      }

      const today = new Date();
      const ptoVta = req.afipConfig.punto_venta;
      const invoiceDate = await resolveInvoiceDate({ requestedFecha: fecha, clientId: req.user.client_id, puntoVenta: ptoVta });

      let ultimo;
      try { ultimo = await afipService.getLastVoucher(req.afipConfig, ptoVta, invType); }
      catch (e) { ultimo = 0; }
      const nuevoNumero = (ultimo || 0) + 1;

      const voucherData = {
        punto_venta: ptoVta, invoice_type: invType, concepto: 1,
        doc_tipo: docTipo || 99, doc_nro: docNro || 0,
        numero_desde: nuevoNumero, numero_hasta: nuevoNumero,
        fecha: invoiceDate,
        imp_neto: impNeto, imp_iva: impIva, imp_total: impTotal,
        imp_trib: parseFloat(tributos || 0), iva: ivaArray,
      };

      const result = await afipService.createVoucher(req.afipConfig, voucherData);

      const fecaeResponse =
        result?.FeDetResp?.FECAEDetResponse?.[0] ||
        result?.FECAEDetResponse?.[0] || {};

      const insertResult = await pool.query(`
        INSERT INTO afip_invoices
          (client_id, invoice_type, invoice_number, punto_venta, cae, cae_vencimiento,
           result, obs, neto, iva, total, order_id, client_doc_type, client_doc_nro, client_name,
           raw_response, voucher_kind, source, arca_request_payload, arca_response_payload, authorized_at, created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'invoice','single',$17,$18,$19,$20)
        RETURNING id
      `, [
        req.user.client_id, invType, nuevoNumero, ptoVta,
        fecaeResponse.CAE || null,
        fecaeResponse.CAEFchVto ? fecaeResponse.CAEFchVto.toString() : null,
        fecaeResponse.Resultado || 'R',
        fecaeResponse.Observaciones ? JSON.stringify(fecaeResponse.Observaciones) : null,
        impNeto, impIva, impTotal, order_id || null,
        docTipo || null, docNro || null, clientName || null,
        JSON.stringify(result),
        JSON.stringify(voucherData),
        JSON.stringify(result),
        fecaeResponse.Resultado === 'A' ? new Date() : null,
        req.user.id || null,
      ]);

      await logAfipEvent({
        req,
        invoiceId: insertResult.rows[0].id,
        orderId: order_id || null,
        eventType: fecaeResponse.Resultado === 'A' ? 'invoice_authorized' : 'invoice_rejected',
        status: fecaeResponse.Resultado === 'A' ? 'success' : 'error',
        message: fecaeResponse.Resultado === 'A' ? 'Factura autorizada por ARCA' : 'Factura rechazada por ARCA',
        requestPayload: voucherData,
        responsePayload: result,
      });

      res.json({
        success: fecaeResponse.Resultado === 'A',
        cae: fecaeResponse.CAE,
        cae_vencimiento: fecaeResponse.CAEFchVto,
        resultado: fecaeResponse.Resultado,
        numero: nuevoNumero,
        punto_venta: ptoVta,
        tipo: invType,
        observaciones: fecaeResponse.Observaciones || null,
        raw: result,
      });

    } catch (err) {
      console.error('[afip] Error facturando:', err.message);
      res.status(500).json({ error: 'Error al facturar: ' + err.message });
    }
  });

  app.get('/api/afip/comprobante', authenticate, requireAfip, async (req, res) => {
    try {
      const tipo = parseInt(req.query.tipo);
      const numero = parseInt(req.query.numero);
      const ptoVta = parseInt(req.query.ptoVta) || req.afipConfig.punto_venta;
      if (!tipo || !numero) return res.status(400).json({ error: 'Faltan parámetros: tipo, numero' });
      const result = await afipService.consultVoucher(req.afipConfig, { punto_venta: ptoVta, invoice_type: tipo, numero });
      res.json({ success: true, comprobante: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // ─── Nota de Crédito: anulación total de factura ───────────

  app.post('/api/afip/notas-credito', authenticate, requireAfip, async (req, res) => {
    try {
      const invoiceId = req.body.invoice_id;
      const motivo = req.body.motivo || 'Anulación de comprobante';
      if (!invoiceId) return res.status(400).json({ error: 'Debe enviar invoice_id' });

      const invQ = await pool.query(`
        SELECT ai.*
        FROM afip_invoices ai
        WHERE ai.id = $1 AND ai.client_id = $2 AND ai.voucher_kind = 'invoice' AND ai.result = 'A'
      `, [invoiceId, req.user.client_id]);

      if (invQ.rows.length === 0) {
        return res.status(404).json({ error: 'Factura autorizada no encontrada' });
      }
      const inv = invQ.rows[0];

      const existingNc = await pool.query(`
        SELECT id, cae FROM afip_invoices
        WHERE related_invoice_id = $1 AND voucher_kind = 'credit_note' AND result = 'A'
        LIMIT 1
      `, [invoiceId]);
      if (existingNc.rows.length > 0) {
        return res.status(409).json({ error: 'La factura ya tiene una Nota de Crédito autorizada', credit_note_id: existingNc.rows[0].id, cae: existingNc.rows[0].cae });
      }

      const ncType = creditNoteTypeFor(inv.invoice_type);
      if (!ncType) return res.status(400).json({ error: `No hay tipo de NC configurado para comprobante ${inv.invoice_type}` });

      const ptoVta = req.afipConfig.punto_venta || inv.punto_venta;
      let ultimo;
      try { ultimo = await afipService.getLastVoucher(req.afipConfig, ptoVta, ncType); }
      catch (e) { ultimo = 0; }
      const nuevoNumero = (ultimo || 0) + 1;
      const today = new Date();
      const invoiceDate = await resolveInvoiceDate({ requestedFecha: req.body.fecha, clientId: req.user.client_id, puntoVenta: ptoVta });

      const impNeto = Math.abs(parseFloat(inv.neto || 0));
      const impIva = Math.abs(parseFloat(inv.iva || 0));
      const impTotal = Math.abs(parseFloat(inv.total || 0));
      const fallbackIvaArray = inv.order_id ? await buildIvaArray(inv.order_id, pool, req.user.client_id, impNeto, impIva, 21) : [];
      const ivaArray = normalizeIvaArrayForCreditNote(inv, fallbackIvaArray);

      const voucherData = {
        punto_venta: ptoVta,
        invoice_type: ncType,
        concepto: 1,
        doc_tipo: inv.client_doc_type || 99,
        doc_nro: inv.client_doc_nro || 0,
        numero_desde: nuevoNumero,
        numero_hasta: nuevoNumero,
        fecha: invoiceDate,
        imp_neto: impNeto,
        imp_iva: impIva,
        imp_total: impTotal,
        imp_trib: 0,
        iva: ivaArray,
        cbtes_asoc: [{
          Tipo: inv.invoice_type,
          PtoVta: inv.punto_venta,
          Nro: inv.invoice_number,
        }],
      };

      await logAfipEvent({ req, invoiceId, orderId: inv.order_id, eventType: 'credit_note_started', status: 'info', message: motivo, requestPayload: voucherData });

      const result = await afipService.createVoucher(req.afipConfig, voucherData);
      const fecaeResponse = result?.FeDetResp?.FECAEDetResponse?.[0] || result?.FECAEDetResponse?.[0] || {};

      const insertResult = await pool.query(`
        INSERT INTO afip_invoices
          (client_id, invoice_type, invoice_number, punto_venta, cae, cae_vencimiento,
           result, obs, neto, iva, total, order_id, client_doc_type, client_doc_nro, client_name,
           raw_response, voucher_kind, related_invoice_id, source, arca_request_payload, arca_response_payload, authorized_at, created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'credit_note',$17,'credit_note',$18,$19,$20,$21)
        RETURNING id
      `, [
        req.user.client_id, ncType, nuevoNumero, ptoVta,
        fecaeResponse.CAE || null,
        fecaeResponse.CAEFchVto ? fecaeResponse.CAEFchVto.toString() : null,
        fecaeResponse.Resultado || 'R',
        fecaeResponse.Observaciones ? JSON.stringify(fecaeResponse.Observaciones) : motivo,
        -impNeto, -impIva, -impTotal, inv.order_id || null,
        inv.client_doc_type || null, inv.client_doc_nro || null, inv.client_name || null,
        JSON.stringify(result),
        invoiceId,
        JSON.stringify(voucherData),
        JSON.stringify(result),
        fecaeResponse.Resultado === 'A' ? new Date() : null,
        req.user.id || null,
      ]);

      await logAfipEvent({
        req,
        invoiceId: insertResult.rows[0].id,
        orderId: inv.order_id || null,
        eventType: fecaeResponse.Resultado === 'A' ? 'credit_note_authorized' : 'credit_note_rejected',
        status: fecaeResponse.Resultado === 'A' ? 'success' : 'error',
        message: motivo,
        requestPayload: voucherData,
        responsePayload: result,
      });

      res.json({
        success: fecaeResponse.Resultado === 'A',
        credit_note_id: insertResult.rows[0].id,
        related_invoice_id: invoiceId,
        cae: fecaeResponse.CAE,
        cae_vencimiento: fecaeResponse.CAEFchVto,
        resultado: fecaeResponse.Resultado,
        numero: nuevoNumero,
        punto_venta: ptoVta,
        tipo: ncType,
        observaciones: fecaeResponse.Observaciones || null,
        raw: result,
      });
    } catch (err) {
      console.error('[afip] Error emitiendo NC:', err.message);
      res.status(500).json({ error: 'Error emitiendo Nota de Crédito: ' + err.message });
    }
  });

  app.get('/api/afip/facturas', authenticate, async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit) || 20, 100);
      const offset = parseInt(req.query.offset) || 0;
      const tipo = req.query.tipo ? parseInt(req.query.tipo) : null;
      const desde = req.query.desde || '';
      const hasta = req.query.hasta || '';

      const params = [req.user.client_id];
      const conds = ['ai.client_id = $1'];
      let idx = 2;

      if (tipo) { params.push(tipo); conds.push(`ai.invoice_type = $${idx}`); idx++; }
      if (desde) { params.push(desde); conds.push(`ai.created_at >= $${idx}`); idx++; }
      if (hasta) { params.push(hasta + ' 23:59:59'); conds.push(`ai.created_at <= $${idx}`); idx++; }

      const where = conds.join(' AND ');

      const countResult = await pool.query(`SELECT COUNT(*) FROM afip_invoices ai WHERE ${where}`, params);
      const result = await pool.query(`
        SELECT ai.*, o.order_number,
          (SELECT nc.id FROM afip_invoices nc WHERE nc.related_invoice_id = ai.id AND nc.voucher_kind = 'credit_note' AND nc.result = 'A' ORDER BY nc.id DESC LIMIT 1) as nc_id,
          (SELECT nc.cae FROM afip_invoices nc WHERE nc.related_invoice_id = ai.id AND nc.voucher_kind = 'credit_note' AND nc.result = 'A' ORDER BY nc.id DESC LIMIT 1) as nc_cae
        FROM afip_invoices ai
        LEFT JOIN orders o ON o.id = ai.order_id
        WHERE ${where}
        ORDER BY ai.id DESC LIMIT $${idx} OFFSET $${idx + 1}
      `, [...params, limit, offset]);

      // Totales por tipo de IVA para libro IVA
      const libroIva = await pool.query(`
        SELECT invoice_type, COUNT(*) as cantidad, SUM(neto) as total_neto, SUM(iva) as total_iva, SUM(total) as total_facturado
        FROM afip_invoices WHERE ${where.replace(/ai\./g, '')}
        GROUP BY invoice_type ORDER BY invoice_type
      `, params);

      res.json({
        facturas: result.rows,
        total: parseInt(countResult.rows[0].count),
        libro_iva: libroIva.rows,
        limit, offset,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/afip/libro-iva', authenticate, async (req, res) => {
    try {
      const anio = parseInt(req.query.anio) || new Date().getFullYear();
      const mes = parseInt(req.query.mes) || (new Date().getMonth() + 1);

      const result = await pool.query(`
        SELECT
          ai.invoice_type,
          ai.invoice_number,
          ai.punto_venta,
          ai.cae,
          ai.cae_vencimiento,
          ai.result,
          ai.neto,
          ai.iva,
          ai.total,
          ai.client_name,
          ai.client_doc_nro,
          ai.client_doc_type,
          ai.created_at,
          o.order_number
        FROM afip_invoices ai
        LEFT JOIN orders o ON o.id = ai.order_id
        WHERE ai.client_id = $1
          AND EXTRACT(YEAR FROM ai.created_at) = $2
          AND EXTRACT(MONTH FROM ai.created_at) = $3
          AND ai.result = 'A'
        ORDER BY ai.created_at ASC
      `, [req.user.client_id, anio, mes]);

      const resumen = await pool.query(`
        SELECT
          invoice_type,
          COUNT(*) as cantidad,
          SUM(neto) as total_neto,
          SUM(iva) as total_iva,
          SUM(total) as total_facturado
        FROM afip_invoices
        WHERE client_id = $1
          AND EXTRACT(YEAR FROM created_at) = $2
          AND EXTRACT(MONTH FROM created_at) = $3
          AND result = 'A'
        GROUP BY invoice_type
      `, [req.user.client_id, anio, mes]);

      res.json({
        periodo: `${anio}-${String(mes).padStart(2, '0')}`,
        comprobantes: result.rows,
        resumen: resumen.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });


  // ─── Facturación por lote de NVs ───────────────────────────

  app.post('/api/afip/facturar-lote', authenticate, requireAfip, async (req, res) => {
    const orderIds = Array.isArray(req.body.order_ids) ? req.body.order_ids : [];

    if (!orderIds.length) {
      return res.status(400).json({ error: 'Debe enviar order_ids: []' });
    }

    const batchId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : require('crypto').randomUUID();
    const emitidas = [];
    const fallidas = [];
    const omitidas = [];

    await logAfipEvent({ req, batchId, eventType: 'batch_started', status: 'info', message: `Inicio lote de ${orderIds.length} NVs`, requestPayload: { order_ids: orderIds } });

    for (const orderId of orderIds) {
      try {
        // Evitar duplicar facturas
        const existing = await pool.query(
          'SELECT id, cae FROM afip_invoices WHERE order_id = $1 AND client_id = $2 LIMIT 1',
          [orderId, req.user.client_id]
        );
        if (existing.rows.length > 0) {
          omitidas.push({ order_id: orderId, reason: 'NV ya facturada', cae: existing.rows[0].cae });
          continue;
        }

        const orderQ = await pool.query(`
          SELECT o.*, c.name as cname, c.cuit as ccuit, c.condicion_iva as ccondiva
          FROM orders o
          LEFT JOIN contacts c ON c.id = o.contact_id
          WHERE o.id = $1 AND o.client_id = $2 AND o.order_type = 'NV' AND o.deleted_at IS NULL
        `, [orderId, req.user.client_id]);

        if (orderQ.rows.length === 0) {
          omitidas.push({ order_id: orderId, reason: 'NV no encontrada' });
          continue;
        }

        const ord = orderQ.rows[0];
        const impNeto = parseFloat(ord.subtotal || 0) || parseFloat(ord.total || 0);
        const ivaArray = await buildIvaArray(orderId, pool, req.user.client_id, impNeto, 0, 21);
        const impIva = Math.round(ivaArray.reduce((sum, item) => sum + Number(item.Importe || 0), 0) * 100) / 100;
        const impTotal = Math.round((impNeto + impIva) * 100) / 100;

        if (!impTotal || impTotal <= 0) {
          omitidas.push({ order_id: orderId, order_number: ord.order_number, reason: 'Total inválido o cero' });
          continue;
        }

        const invType = detectarTipoFactura(req.afipConfig.condicion_iva, ord.ccondiva) || 6;
        const doc = normalizeDocForAfip({
          invoiceType: invType,
          contactCuit: ord.ccuit,
          contactCondicionIva: ord.ccondiva,
          total: impTotal,
        });

        if (doc.error) {
          omitidas.push({ order_id: orderId, order_number: ord.order_number, reason: doc.error });
          continue;
        }

        const today = new Date();
        const ptoVta = req.afipConfig.punto_venta;
        const invoiceDate = await resolveInvoiceDate({ requestedFecha: req.body.fecha, clientId: req.user.client_id, puntoVenta: ptoVta });

        let ultimo;
        try { ultimo = await afipService.getLastVoucher(req.afipConfig, ptoVta, invType); }
        catch (e) { ultimo = 0; }
        const nuevoNumero = (ultimo || 0) + 1;

        const voucherData = {
          punto_venta: ptoVta,
          invoice_type: invType,
          concepto: 1,
          doc_tipo: doc.doc_tipo,
          doc_nro: doc.doc_nro,
          numero_desde: nuevoNumero,
          numero_hasta: nuevoNumero,
          fecha: invoiceDate,
          imp_neto: impNeto,
          imp_iva: impIva,
          imp_total: impTotal,
          imp_trib: 0,
          iva: ivaArray,
        };

        const result = await afipService.createVoucher(req.afipConfig, voucherData);
        const fecaeResponse =
          result?.FeDetResp?.FECAEDetResponse?.[0] ||
          result?.FECAEDetResponse?.[0] || {};

        const insertResult = await pool.query(`
          INSERT INTO afip_invoices
            (client_id, invoice_type, invoice_number, punto_venta, cae, cae_vencimiento,
             result, obs, neto, iva, total, order_id, client_doc_type, client_doc_nro, client_name,
             raw_response, voucher_kind, source, emission_batch_id, arca_request_payload, arca_response_payload, authorized_at, created_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'invoice','batch',$17,$18,$19,$20,$21)
          RETURNING id
        `, [
          req.user.client_id, invType, nuevoNumero, ptoVta,
          fecaeResponse.CAE || null,
          fecaeResponse.CAEFchVto ? fecaeResponse.CAEFchVto.toString() : null,
          fecaeResponse.Resultado || 'R',
          fecaeResponse.Observaciones ? JSON.stringify(fecaeResponse.Observaciones) : null,
          impNeto, impIva, impTotal, orderId,
          doc.doc_tipo || null, doc.doc_nro || null, ord.cname || null,
          JSON.stringify(result),
          batchId,
          JSON.stringify(voucherData),
          JSON.stringify(result),
          fecaeResponse.Resultado === 'A' ? new Date() : null,
          req.user.id || null,
        ]);

        await logAfipEvent({
          req,
          invoiceId: insertResult.rows[0].id,
          orderId,
          batchId,
          eventType: fecaeResponse.Resultado === 'A' ? 'batch_invoice_authorized' : 'batch_invoice_rejected',
          status: fecaeResponse.Resultado === 'A' ? 'success' : 'error',
          message: fecaeResponse.Resultado === 'A' ? 'Factura de lote autorizada por ARCA' : 'Factura de lote rechazada por ARCA',
          requestPayload: voucherData,
          responsePayload: result,
        });

        if (fecaeResponse.Resultado === 'A') {
          emitidas.push({
            order_id: orderId,
            order_number: ord.order_number,
            tipo: invType,
            numero: nuevoNumero,
            punto_venta: ptoVta,
            cae: fecaeResponse.CAE,
            cae_vencimiento: fecaeResponse.CAEFchVto,
            total: impTotal,
            doc_mode: doc.reason,
          });
        } else {
          fallidas.push({
            order_id: orderId,
            order_number: ord.order_number,
            tipo: invType,
            numero: nuevoNumero,
            resultado: fecaeResponse.Resultado || 'R',
            observaciones: fecaeResponse.Observaciones || result,
          });
        }
      } catch (err) {
        fallidas.push({ order_id: orderId, error: err.message });
      }
    }

    await logAfipEvent({ req, batchId, eventType: 'batch_finished', status: fallidas.length ? 'warning' : 'success', message: `Lote finalizado: ${emitidas.length} emitidas, ${omitidas.length} omitidas, ${fallidas.length} fallidas`, responsePayload: { emitidas, omitidas, fallidas } });

    res.json({
      success: fallidas.length === 0,
      requested: orderIds.length,
      emission_batch_id: batchId,
      emitidas,
      fallidas,
      omitidas,
    });
  });

  console.log('✅ Módulo AFIP cargado — rutas /api/afip/*');
};
