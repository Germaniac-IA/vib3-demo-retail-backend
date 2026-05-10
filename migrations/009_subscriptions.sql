-- Plans (catalogo de servicios/suscripciones)
CREATE TABLE IF NOT EXISTS plans (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    billing_cycle VARCHAR(50) NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('weekly','biweekly','monthly','quarterly','semiannual','annual')),
    amount NUMERIC(12,2) NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    requires_contract BOOLEAN NOT NULL DEFAULT false,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP
);

-- Subscriptions (suscripciones activas de contactos)
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
    start_date DATE NOT NULL,
    end_date DATE,
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','cancelled','expired')),
    next_billing_date DATE NOT NULL,
    billing_amount NUMERIC(12,2) NOT NULL,
    default_payment_method_id INTEGER REFERENCES payment_methods(id) ON DELETE SET NULL,
    notes TEXT,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP
);

-- Billing cycles (periodos de facturacion devengados)
CREATE TABLE IF NOT EXISTS billing_cycles (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    period_start DATE NOT NULL,
    period_end DATE NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','billed','paid','cancelled','overdue')),
    issued_at TIMESTAMP,
    due_date DATE,
    paid_at TIMESTAMP,
    paid_amount NUMERIC(12,2),
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMP
);

-- Invoice items (items que componen un billing cycle)
CREATE TABLE IF NOT EXISTS invoice_items (
    id SERIAL PRIMARY KEY,
    client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    billing_cycle_id INTEGER NOT NULL REFERENCES billing_cycles(id) ON DELETE CASCADE,
    description VARCHAR(255) NOT NULL,
    amount NUMERIC(12,2) NOT NULL,
    type VARCHAR(50) NOT NULL DEFAULT 'subscription' CHECK (type IN ('subscription','product','service','adjustment','discount')),
    product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
    order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
    quantity NUMERIC(12,2) NOT NULL DEFAULT 1,
    unit_price NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_subscriptions_contact ON subscriptions(contact_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_subscriptions_next_billing ON subscriptions(next_billing_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_billing_cycles_subscription ON billing_cycles(subscription_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_billing_cycles_status ON billing_cycles(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_billing_cycles_due ON billing_cycles(due_date) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_invoice_items_billing ON invoice_items(billing_cycle_id);
