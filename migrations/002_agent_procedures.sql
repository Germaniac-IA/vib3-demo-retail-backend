-- Migration 002: agent_procedures table
-- Crea la tabla de procedimientos de interacción para agentes

CREATE TABLE IF NOT EXISTS agent_procedures (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  context VARCHAR(50) NOT NULL DEFAULT 'lead_nuevo',
  step_order INTEGER NOT NULL DEFAULT 0,
  step_name VARCHAR(255) NOT NULL DEFAULT '',
  step_prompt TEXT NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_procedures_agent ON agent_procedures(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_procedures_context ON agent_procedures(context);
CREATE INDEX IF NOT EXISTS idx_agent_procedures_active ON agent_procedures(active);
