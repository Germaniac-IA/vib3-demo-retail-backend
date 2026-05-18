const puppeteer = require('puppeteer');

let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}

/**
 * Render an HTML template to PDF buffer.
 * Variables to replace in template (without {{ }}):
 *   - For invoices: TIPO, NUMERO_COMPLETO, FECHA, CLIENTE, CLIENTE_CUIT, CLIENTE_IVA,
 *                   EMISOR, CUIT_EMISOR, ITEMS, NETO, IVA, TOTAL, CAE, CAE_VTO, FOOTER, COLOR, LOGO
 *   - For budgets: NUMERO, CONTACT, FECHA, VENCE, ESTADO, ITEMS, SUBTOTAL,
 *                   DESCUENTO, TOTAL, NOTAS, FOOTER, COLOR, LOGO
 *
 * @param {string} templateHtml - HTML template with {{VARIABLE}} placeholders
 * @param {object} vars - key-value pairs for replacement
 * @param {object} options - { format: 'A4', landscape: false }
 * @returns {Buffer} PDF buffer
 */
async function renderHtmlToPdf(templateHtml, vars = {}, options = {}) {
  let html = templateHtml;
  for (const [key, value] of Object.entries(vars)) {
    const re = new RegExp('\\{\\{' + key + '\\}\\}', 'g');
    html = html.replace(re, String(value ?? ''));
  }

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
    const pdf = await page.pdf({
      format: options.format || 'A4',
      landscape: options.landscape || false,
      margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
      printBackground: true,
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}

/**
 * Build the HTML items table rows for invoices.
 */
function buildInvoiceItems(items, moneyFn, showPrices = true) {
  if (!items || items.length === 0) return '<tr><td colspan="4" style="text-align:center;padding:20px;color:#999">Sin ítems</td></tr>';
  return items.map((item, idx) => {
    const name = item.product_name || item.description || 'Item';
    const qty = Number(item.quantity || 0).toLocaleString('es-AR');
    const unit = moneyFn(item.unit_price);
    const sub = moneyFn(item.subtotal || Number(item.quantity) * Number(item.unit_price));
    if (!showPrices) {
      return `<tr class="item-${idx % 2}"><td colspan="4">${name} x${qty}</td></tr>`;
    }
    return `<tr class="item-${idx % 2}"><td>${name}</td><td class="r">${qty}</td><td class="r">${unit}</td><td class="r">${sub}</td></tr>`;
  }).join('\n');
}

/**
 * Build the HTML items table rows for budgets.
 */
function buildBudgetItems(items, moneyFn, showPrices = true) {
  if (!items || items.length === 0) return '<tr><td colspan="4" style="text-align:center;padding:20px;color:#999">Sin ítems</td></tr>';
  return items.map((item, idx) => {
    const name = item.product_name || item.service_name || item.description || 'Item';
    const qty = Number(item.quantity || 0).toLocaleString('es-AR');
    const unit = moneyFn(item.unit_price);
    const sub = moneyFn(item.subtotal || Number(item.quantity) * Number(item.unit_price));
    if (!showPrices) {
      return `<tr class="item-${idx % 2}"><td colspan="4">${name} x${qty}</td></tr>`;
    }
    return `<tr class="item-${idx % 2}"><td>${name}</td><td class="r">${qty}</td><td class="r">${unit}</td><td class="r">${sub}</td></tr>`;
  }).join('\n');
}

async function close() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

process.on('exit', () => { if (browser) browser.close().catch(() => {}); });

module.exports = { renderHtmlToPdf, buildInvoiceItems, buildBudgetItems, close };
