-- Plugin Fabricación
-- Tabla para registrar movimientos de fabricación (insumos → productos)

CREATE TABLE IF NOT EXISTS manufacturing_movements (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  notes TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_manufacturing_movements_client ON manufacturing_movements(client_id);
CREATE INDEX IF NOT EXISTS idx_manufacturing_movements_product ON manufacturing_movements(product_id);
