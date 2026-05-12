-- ========================================
-- Migration 010: Services + Order Types
-- ========================================

-- Create services table (replaces plans as catalog, plans become config layer for recurring)
CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  price DECIMAL(12,2) NOT NULL DEFAULT 0,
  is_recurring BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

CREATE INDEX idx_services_client ON services(client_id) WHERE deleted_at IS NULL;

-- Migrate existing plans to services
INSERT INTO services (id, client_id, name, description, price, is_recurring, is_active, sort_order, created_at, updated_at, deleted_at)
SELECT id, client_id, name, description, amount, true, is_active, sort_order, created_at, updated_at, deleted_at
FROM plans WHERE deleted_at IS NULL;

-- Reset sequence
SELECT setval('services_id_seq', COALESCE((SELECT MAX(id) FROM services), 1));

-- Plans table: add service_id FK, keep as config layer for recurring services
ALTER TABLE plans ADD COLUMN IF NOT EXISTS service_id INTEGER REFERENCES services(id) ON DELETE SET NULL;
UPDATE plans SET service_id = id WHERE deleted_at IS NULL;

-- Add order_type to orders (NV = Nota de Venta, OT = Orden de Trabajo)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_type VARCHAR(3) NOT NULL DEFAULT 'NV';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_id INTEGER REFERENCES services(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(client_id, order_type) WHERE deleted_at IS NULL;

-- Add billing config columns to subscriptions
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_day INTEGER DEFAULT 1;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_charge BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS generate_invoice BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS payment_method_id INTEGER;

-- Add billing options to plans (what's available for this recurring service)
ALTER TABLE plans ADD COLUMN IF NOT EXISTS allowed_payment_methods TEXT DEFAULT '[]';
ALTER TABLE plans ADD COLUMN IF NOT EXISTS allows_invoice BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE plans ADD COLUMN IF NOT EXISTS requires_billing_day BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN orders.order_type IS 'NV = Nota de Venta (productos), OT = Orden de Trabajo (servicios)';
