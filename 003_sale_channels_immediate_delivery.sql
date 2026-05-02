ALTER TABLE sale_channels
  ADD COLUMN IF NOT EXISTS immediate_delivery boolean NOT NULL DEFAULT false;

UPDATE sale_channels
SET immediate_delivery = true
WHERE deleted_at IS NULL
  AND lower(name) IN ('mostrador', 'local');
