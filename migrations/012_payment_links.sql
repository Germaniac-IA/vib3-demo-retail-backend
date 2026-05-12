-- Migration 2026-05-11: payment methods that generate online payment links
ALTER TABLE payment_methods
  ADD COLUMN IF NOT EXISTS generates_payment_link BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS integration_provider VARCHAR(50),
  ADD COLUMN IF NOT EXISTS integration_label VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_methods_one_link_provider
  ON payment_methods (client_id, integration_provider)
  WHERE generates_payment_link = true AND deleted_at IS NULL AND integration_provider IS NOT NULL;

ALTER TABLE integration_transactions
  ADD COLUMN IF NOT EXISTS financial_account_id INTEGER REFERENCES payment_methods(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reason VARCHAR(50),
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS cash_movement_id INTEGER REFERENCES cash_movements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS client_advance_id INTEGER REFERENCES client_advances(id) ON DELETE SET NULL;
