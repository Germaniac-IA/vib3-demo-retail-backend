-- Schema para módulo AFIP (Factura Electrónica ARCA)
-- Las credenciales viven en fiscal_data (certificate_pem, private_key_pem, production, punto_venta)
-- Esta migración solo agrega la tabla de facturas emitidas

CREATE TABLE IF NOT EXISTS afip_invoices (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  invoice_type INTEGER NOT NULL,
  invoice_number INTEGER NOT NULL,
  punto_venta INTEGER NOT NULL DEFAULT 1,
  cae VARCHAR(14),
  cae_vencimiento DATE,
  result VARCHAR(16),
  obs TEXT,
  neto DECIMAL(12,2),
  iva DECIMAL(12,2),
  total DECIMAL(12,2),
  order_id INTEGER REFERENCES orders(id),
  client_doc_type INTEGER,
  client_doc_nro VARCHAR(20),
  client_name VARCHAR(255),
  raw_response JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_afip_invoices_client
  ON afip_invoices(client_id, invoice_type, invoice_number);
