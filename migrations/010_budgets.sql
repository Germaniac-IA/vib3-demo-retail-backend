-- Migration 2026-05-12: Budgets module (Presupuestos)

CREATE TABLE IF NOT EXISTS budgets (
  id SERIAL PRIMARY KEY,
  client_id INT REFERENCES clients(id) ON DELETE SET NULL,
  number VARCHAR(20) NOT NULL UNIQUE,
  subtotal DECIMAL(12,2) DEFAULT 0,
  discount DECIMAL(12,2) DEFAULT 0,
  total DECIMAL(12,2) DEFAULT 0,
  notes TEXT,
  status VARCHAR(20) DEFAULT 'pendiente',
  valid_until DATE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  converted_to_order_id INT REFERENCES orders(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS budget_items (
  id SERIAL PRIMARY KEY,
  budget_id INT REFERENCES budgets(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id) ON DELETE SET NULL,
  service_id INT REFERENCES services(id) ON DELETE SET NULL,
  description VARCHAR(255),
  quantity DECIMAL(12,2) DEFAULT 1,
  unit_price DECIMAL(12,2) DEFAULT 0,
  subtotal DECIMAL(12,2) DEFAULT 0
);

CREATE TABLE IF NOT EXISTS budget_designs (
  id SERIAL PRIMARY KEY,
  client_id INT REFERENCES clients(id) ON DELETE CASCADE,
  template_html TEXT NOT NULL DEFAULT '',
  logo_url VARCHAR(500) DEFAULT '',
  primary_color VARCHAR(20) DEFAULT '#6c63ff',
  footer_text TEXT DEFAULT '',
  show_prices BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(client_id)
);

ALTER TABLE budgets ADD COLUMN IF NOT EXISTS contact_id INT REFERENCES contacts(id) ON DELETE SET NULL;
