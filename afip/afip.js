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

module.exports = function (app, pool, authenticate) {

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
        has_afip_certs: !!(fiscal.certificate_pem && fiscal.private_key_pem),
        configured: true,
      });
    } catch (err) {
      res.status(500).json({ error: 'Error leyendo configuración' });
    }
  });

  async function requireAfip(req, res, next) {
    const fiscal = await afipService.getFiscalConfig(pool, req.user.client_id);
    if (!fiscal || !fiscal.certificate_pem || !fiscal.private_key_pem) {
      return res.status(400).json({
        error: 'AFIP no configurado. Complete sus datos fiscales y cargue los certificados ARCA.',
      });
    }
    req.afipConfig = fiscal;
    next();
  }

  // ─── Búsqueda de NVs para facturar ────────────────────────

  app.get('/api/afip/orders', authenticate, async (req, res) => {
    try {
      const search = req.query.search || '';
      const from = req.query.from || '';
      const to = req.query.to || '';
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

      const ivaPct = parseFloat(iva_pct || 21);
      impIva = ivaPct > 0 ? Math.round((impNeto * ivaPct / 100) * 100) / 100 : 0;
      impTotal = impTotal || Math.round((impNeto + impIva) * 100) / 100;

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
      const invoiceDate = fecha || today.toISOString().slice(0, 10).replace(/-/g, '');
      const ptoVta = req.afipConfig.punto_venta;

      let ultimo;
      try { ultimo = await afipService.getLastVoucher(req.afipConfig, ptoVta, invType); }
      catch (e) { ultimo = 0; }
      const nuevoNumero = (ultimo || 0) + 1;

      const ivaArray = ivaPct > 0
        ? [{ Id: 5, BaseImp: impNeto, Importe: impIva }]
        : [];

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

      await pool.query(`
        INSERT INTO afip_invoices
          (client_id, invoice_type, invoice_number, punto_venta, cae, cae_vencimiento,
           result, obs, neto, iva, total, order_id, client_doc_type, client_doc_nro, client_name, raw_response)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      `, [
        req.user.client_id, invType, nuevoNumero, ptoVta,
        fecaeResponse.CAE || null,
        fecaeResponse.CAEFchVto ? fecaeResponse.CAEFchVto.toString() : null,
        fecaeResponse.Resultado || 'R',
        fecaeResponse.Observaciones ? JSON.stringify(fecaeResponse.Observaciones) : null,
        impNeto, impIva, impTotal, order_id || null,
        docTipo || null, docNro || null, clientName || null,
        JSON.stringify(result),
      ]);

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
        SELECT ai.*, o.order_number
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
    const ivaPct = parseFloat(req.body.iva_pct || 21);

    if (!orderIds.length) {
      return res.status(400).json({ error: 'Debe enviar order_ids: []' });
    }

    const emitidas = [];
    const fallidas = [];
    const omitidas = [];

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
        const impIva = ivaPct > 0 ? Math.round((impNeto * ivaPct / 100) * 100) / 100 : 0;
        const impTotal = parseFloat(ord.total || 0) || Math.round((impNeto + impIva) * 100) / 100;

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
        const invoiceDate = today.toISOString().slice(0, 10).replace(/-/g, '');
        const ptoVta = req.afipConfig.punto_venta;

        let ultimo;
        try { ultimo = await afipService.getLastVoucher(req.afipConfig, ptoVta, invType); }
        catch (e) { ultimo = 0; }
        const nuevoNumero = (ultimo || 0) + 1;

        const ivaArray = ivaPct > 0 ? [{ Id: 5, BaseImp: impNeto, Importe: impIva }] : [];
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

        await pool.query(`
          INSERT INTO afip_invoices
            (client_id, invoice_type, invoice_number, punto_venta, cae, cae_vencimiento,
             result, obs, neto, iva, total, order_id, client_doc_type, client_doc_nro, client_name, raw_response)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
        `, [
          req.user.client_id, invType, nuevoNumero, ptoVta,
          fecaeResponse.CAE || null,
          fecaeResponse.CAEFchVto ? fecaeResponse.CAEFchVto.toString() : null,
          fecaeResponse.Resultado || 'R',
          fecaeResponse.Observaciones ? JSON.stringify(fecaeResponse.Observaciones) : null,
          impNeto, impIva, impTotal, orderId,
          doc.doc_tipo || null, doc.doc_nro || null, ord.cname || null,
          JSON.stringify(result),
        ]);

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

    res.json({
      success: fallidas.length === 0,
      requested: orderIds.length,
      emitidas,
      fallidas,
      omitidas,
    });
  });

  console.log('✅ Módulo AFIP cargado — rutas /api/afip/*');
};
