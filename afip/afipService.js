// afipService.js — Wrapper AFIP/ARCA con caching de TA por cliente
const Afip = require('@afipsdk/afip.js');

const afipCache = {};

function getAfipInstance(config) {
  const suffix = config.production ? 'prod' : 'homologation';
  const key = String(config.cuit) + '_' + suffix + '_' + String(config.punto_venta || 'default') + '_' + String((config.certificate_pem || '').length);
  if (!afipCache[key]) {
    afipCache[key] = new Afip({
      CUIT: Number(config.cuit),
      cert: config.certificate_pem,
      key: config.private_key_pem,
      production: config.production || false,
    });
  }
  return afipCache[key];
}

async function getFiscalConfig(pool, clientId) {
  const result = await pool.query(
    'SELECT * FROM fiscal_data WHERE client_id = $1 LIMIT 1',
    [clientId]
  );
  return result.rows[0] || null;
}

async function hasAfipConfig(pool, clientId) {
  const result = await pool.query(
    'SELECT 1 FROM fiscal_data WHERE client_id = $1 AND certificate_pem IS NOT NULL AND private_key_pem IS NOT NULL LIMIT 1',
    [clientId]
  );
  return result.rowCount > 0;
}

async function testConnection(config) {
  try {
    const afip = getAfipInstance(config);
    const info = await afip.ElectronicBilling.getServerStatus();
    return { success: true, serverStatus: info };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

async function getSalesPoints(config) {
  const afip = getAfipInstance(config);
  return await afip.ElectronicBilling.getSalesPoints();
}

async function getVoucherTypes(config) {
  const afip = getAfipInstance(config);
  return await afip.ElectronicBilling.getVoucherTypes();
}

async function getLastVoucher(config, salesPoint, type) {
  const afip = getAfipInstance(config);
  return await afip.ElectronicBilling.getLastVoucher({
    salesPoint,
    type,
  });
}

async function createVoucher(config, data) {
  const afip = getAfipInstance(config);
  const voucherData = {
    CantReg: 1,
    PtoVta: data.punto_venta || 1,
    CbteTipo: data.invoice_type,
    Concepto: data.concepto || 1,
    DocTipo: data.doc_tipo || 80,
    DocNro: Number(data.doc_nro) || 0,
    CbteDesde: data.numero_desde,
    CbteHasta: data.numero_hasta,
    CbteFch: data.fecha,
    ImpTotal: Math.round(data.imp_total * 100) / 100,
    ImpTotConc: 0,
    ImpNeto: Math.round(data.imp_neto * 100) / 100,
    ImpOpEx: 0,
    ImpIVA: Math.round(data.imp_iva * 100) / 100,
    ImpTrib: Math.round(data.imp_trib * 100) / 100 || 0,
    MonId: 'PES',
    MonCotiz: 1,
    Iva: data.iva || [],
    Tributos: data.tributos || [],
  };

  if (data.cbtes_asoc && data.cbtes_asoc.length) {
    voucherData.CbtesAsoc = data.cbtes_asoc;
  }

  return await afip.ElectronicBilling.createVoucher(voucherData);
}

async function consultVoucher(config, data) {
  const afip = getAfipInstance(config);
  return await afip.ElectronicBilling.getVoucherInfo({
    salesPoint: data.punto_venta,
    type: data.invoice_type,
    number: data.numero,
  });
}

module.exports = {
  getFiscalConfig,
  hasAfipConfig,
  testConnection,
  getSalesPoints,
  getVoucherTypes,
  getLastVoucher,
  createVoucher,
  consultVoucher,
};
