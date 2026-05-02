CREATE TABLE IF NOT EXISTS expense_categories (
  id serial PRIMARY KEY,
  client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  is_active boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  deleted_at timestamp,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expenses (
  id serial PRIMARY KEY,
  client_id integer NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  expense_number varchar(30) NOT NULL,
  category_id integer REFERENCES expense_categories(id) ON DELETE SET NULL,
  provider_id integer REFERENCES providers(id) ON DELETE SET NULL,
  description text NOT NULL,
  issue_date date DEFAULT CURRENT_DATE,
  due_date date,
  total numeric(12,2) NOT NULL DEFAULT 0,
  payment_status_id integer REFERENCES payment_statuses(id) ON DELETE SET NULL,
  notes text,
  deleted_at timestamp,
  created_at timestamp DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS expenses_client_number_idx ON expenses(client_id, expense_number) WHERE deleted_at IS NULL;

ALTER TABLE cash_movements
  ADD COLUMN IF NOT EXISTS expense_id integer REFERENCES expenses(id) ON DELETE SET NULL;

INSERT INTO expense_categories (client_id, name, sort_order)
SELECT c.id, v.name, v.sort_order
FROM clients c
CROSS JOIN (VALUES
  ('Alquileres', 1),
  ('Servicios', 2),
  ('Sueldos', 3),
  ('Marketing', 4),
  ('Impuestos', 5),
  ('Logística', 6),
  ('Oficina', 7),
  ('Mantenimiento', 8),
  ('Otros', 99)
) AS v(name, sort_order)
WHERE NOT EXISTS (
  SELECT 1 FROM expense_categories ec
  WHERE ec.client_id = c.id AND lower(ec.name) = lower(v.name) AND ec.deleted_at IS NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE ON expense_categories, expenses TO cristal;
GRANT USAGE, SELECT ON SEQUENCE expense_categories_id_seq, expenses_id_seq TO cristal;
