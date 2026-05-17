-- Schema módulo AFIP / ARCA — append-only + trazabilidad + NC

ALTER TABLE fiscal_data ADD COLUMN IF NOT EXISTS certificate_pem TEXT;
ALTER TABLE fiscal_data ADD COLUMN IF NOT EXISTS private_key_pem TEXT;
ALTER TABLE fiscal_data ADD COLUMN IF NOT EXISTS production BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE fiscal_data ADD COLUMN IF NOT EXISTS punto_venta INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fiscal_data ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();

CREATE TABLE IF NOT EXISTS afip_invoices (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
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
  created_at TIMESTAMP DEFAULT NOW(),
  voucher_kind VARCHAR(20) NOT NULL DEFAULT 'invoice',
  related_invoice_id INTEGER REFERENCES afip_invoices(id),
  source VARCHAR(20) NOT NULL DEFAULT 'single',
  emission_batch_id UUID,
  arca_request_payload JSONB,
  arca_response_payload JSONB,
  authorized_at TIMESTAMP,
  created_by_user_id INTEGER REFERENCES users(id),
  fiscal_status VARCHAR(30) NOT NULL DEFAULT 'vigente'
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_afip_invoice_number
  ON afip_invoices(client_id, invoice_type, punto_venta, invoice_number);
CREATE INDEX IF NOT EXISTS idx_afip_invoices_client
  ON afip_invoices(client_id, invoice_type, invoice_number);
CREATE INDEX IF NOT EXISTS idx_afip_invoices_related
  ON afip_invoices(related_invoice_id);
CREATE INDEX IF NOT EXISTS idx_afip_invoices_batch
  ON afip_invoices(emission_batch_id);

CREATE TABLE IF NOT EXISTS afip_emission_events (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  invoice_id INTEGER REFERENCES afip_invoices(id),
  order_id INTEGER REFERENCES orders(id),
  emission_batch_id UUID,
  event_type VARCHAR(50) NOT NULL,
  event_status VARCHAR(30) NOT NULL DEFAULT 'info',
  message TEXT,
  request_payload JSONB,
  response_payload JSONB,
  error_payload JSONB,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_afip_events_client_created
  ON afip_emission_events(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_afip_events_invoice
  ON afip_emission_events(invoice_id);
CREATE INDEX IF NOT EXISTS idx_afip_events_batch
  ON afip_emission_events(emission_batch_id);

CREATE OR REPLACE FUNCTION prevent_afip_invoice_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'afip_invoices is append-only: DELETE forbidden';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'afip_invoices is append-only: UPDATE forbidden; use credit notes/events';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prevent_afip_invoice_update ON afip_invoices;
CREATE TRIGGER trg_prevent_afip_invoice_update
BEFORE UPDATE ON afip_invoices
FOR EACH ROW EXECUTE FUNCTION prevent_afip_invoice_mutation();

DROP TRIGGER IF EXISTS trg_prevent_afip_invoice_delete ON afip_invoices;
CREATE TRIGGER trg_prevent_afip_invoice_delete
BEFORE DELETE ON afip_invoices
FOR EACH ROW EXECUTE FUNCTION prevent_afip_invoice_mutation();
