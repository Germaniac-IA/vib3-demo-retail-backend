-- ========================================
-- Migration 011: Work Orders (Órdenes de Trabajo)
-- ========================================

-- Work orders table
CREATE TABLE IF NOT EXISTS work_orders (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  service_id INTEGER REFERENCES services(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  status VARCHAR(50) NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'en_curso', 'realizada', 'cancelada')),
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  scheduled_date DATE,
  completed_at TIMESTAMP,
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_work_orders_client ON work_orders(client_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_orders_status ON work_orders(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_work_orders_contact ON work_orders(contact_id) WHERE deleted_at IS NULL;

-- Add creates_work_order flag to services
ALTER TABLE services ADD COLUMN IF NOT EXISTS creates_work_order BOOLEAN NOT NULL DEFAULT false;
