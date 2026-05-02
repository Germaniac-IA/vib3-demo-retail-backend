ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS cash_user_id integer REFERENCES users(id) ON DELETE SET NULL;

UPDATE agents a
SET cash_user_id = u.id
FROM users u
WHERE a.cash_user_id IS NULL
  AND a.client_id = u.client_id
  AND u.deleted_at IS NULL
  AND lower(u.username) = 'admin';
