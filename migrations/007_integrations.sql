-- Migration 2026-05-06: Módulo de integraciones (Mercado Pago)
CREATE TABLE IF NOT EXISTS integrations (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  provider VARCHAR(50) NOT NULL, -- 'mercadopago', etc.
  config JSONB NOT NULL DEFAULT '{}', -- {access_token, user_id, webhook_secret, ...}
  enabled BOOLEAN NOT NULL DEFAULT false,
  last_sync TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP,
  UNIQUE(client_id, provider)
);

CREATE TABLE IF NOT EXISTS integration_transactions (
  id SERIAL PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  provider VARCHAR(50) NOT NULL,
  order_id INTEGER REFERENCES orders(id),
  mp_preference_id VARCHAR(100),
  mp_payment_id BIGINT,
  mp_merchant_order_id BIGINT,
  status VARCHAR(50) NOT NULL DEFAULT 'pending', -- pending, approved, rejected, refunded, cancelled
  status_detail VARCHAR(100),
  amount NUMERIC(12,2),
  currency VARCHAR(3) DEFAULT 'ARS',
  external_reference VARCHAR(255),
  init_point TEXT,
  payer_email VARCHAR(255),
  payment_method VARCHAR(50),
  payment_type VARCHAR(50),
  raw_response JSONB,
  notification_log JSONB,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  deleted_at TIMESTAMP
);

CREATE INDEX idx_integrations_client_provider ON integrations(client_id, provider);
CREATE INDEX idx_integration_transactions_client ON integration_transactions(client_id);
CREATE INDEX idx_integration_transactions_order ON integration_transactions(order_id);
CREATE INDEX idx_integration_transactions_mp_ref ON integration_transactions(mp_preference_id);
