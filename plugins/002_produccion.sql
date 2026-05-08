-- Plugin Producción — sub-etapas para órdenes en estado "pedido"
CREATE TABLE IF NOT EXISTS production_stages (
  id SERIAL PRIMARY KEY,
  client_id INT NOT NULL REFERENCES clients(id),
  name VARCHAR(100) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  UNIQUE(client_id, sort_order)
);

CREATE TABLE IF NOT EXISTS production_order_items (
  id SERIAL PRIMARY KEY,
  client_id INT NOT NULL REFERENCES clients(id),
  order_id INT NOT NULL REFERENCES orders(id),
  order_item_id INT NOT NULL REFERENCES order_items(id),
  current_stage_id INT REFERENCES production_stages(id),
  status VARCHAR(20) DEFAULT 'pending',
  assigned_to VARCHAR(100),
  notes TEXT,
  started_at TIMESTAMP,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS production_item_log (
  id SERIAL PRIMARY KEY,
  production_item_id INT NOT NULL REFERENCES production_order_items(id),
  from_stage_id INT REFERENCES production_stages(id),
  to_stage_id INT REFERENCES production_stages(id),
  status VARCHAR(20),
  notes TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

-- Stages default para Baver (client_id=1)
INSERT INTO production_stages (client_id, name, sort_order)
SELECT 1, name, ord FROM (VALUES
  ('Diseño', 1),
  ('Impresión', 2),
  ('Corte', 3),
  ('Confección', 4),
  ('Empaquetado', 5)
) AS s(name, ord)
WHERE NOT EXISTS (SELECT 1 FROM production_stages WHERE client_id=1);

-- Activar plugin en clients
UPDATE clients SET plugins = array_append(COALESCE(plugins, '{}'), 'produccion')
WHERE id = 1 AND NOT (plugins @> ARRAY['produccion']);
