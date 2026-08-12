-- ============================================================================
-- Purple Premium Bread — System Upgrades Foundation Migration
-- 001_system_upgrades_foundation.sql
--
-- Covers: permissions, role_permissions, workflow settings, approval queue,
-- money management (accounts + transactions), app settings, audit log,
-- sales returns, split payments, advance-deposit wallets, loan terms,
-- internal chat, AI chat history, WhatsApp sessions.
--
-- SAFETY: 100% additive & idempotent (IF NOT EXISTS everywhere).
-- No existing table/column is dropped or altered destructively.
-- All workflow_settings default to requires_approval = FALSE, so current
-- behavior is unchanged until an admin explicitly enables approvals.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 0. Migration tracking
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY,
    filename VARCHAR UNIQUE NOT NULL,
    applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 1. PERMISSIONS & WORKFLOWS (Feature #1)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS permissions (
    id SERIAL PRIMARY KEY,
    permission_key VARCHAR UNIQUE NOT NULL,   -- e.g. 'sales.create'
    feature VARCHAR NOT NULL,                  -- e.g. 'sales'
    action VARCHAR NOT NULL,                   -- view / create / edit / delete / approve
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS role_permissions (
    id SERIAL PRIMARY KEY,
    role VARCHAR NOT NULL,
    permission_key VARCHAR NOT NULL REFERENCES permissions(permission_key) ON DELETE CASCADE,
    is_allowed BOOLEAN DEFAULT true,
    updated_by INTEGER REFERENCES users(id),
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (role, permission_key)
);

CREATE TABLE IF NOT EXISTS workflow_settings (
    id SERIAL PRIMARY KEY,
    feature VARCHAR UNIQUE NOT NULL,           -- sales / production_log / raw_material_restock / ...
    display_name VARCHAR NOT NULL,
    requires_approval BOOLEAN DEFAULT false,   -- DEFAULT FALSE: behavior unchanged until enabled
    approval_threshold NUMERIC DEFAULT 0,      -- amount above which approval is required (0 = always, when requires_approval)
    approver_roles JSONB DEFAULT '["admin","manager"]'::jsonb,
    is_enabled BOOLEAN DEFAULT true,
    description TEXT,
    updated_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Generic approval queue: when a workflow requires approval, the action is
-- staged here and only executed against the real tables after approval.
CREATE TABLE IF NOT EXISTS approval_requests (
    id SERIAL PRIMARY KEY,
    request_type VARCHAR NOT NULL,             -- matches workflow_settings.feature
    title VARCHAR NOT NULL,
    payload JSONB NOT NULL,                    -- the full staged action data
    amount NUMERIC,                            -- for threshold checks & display
    status VARCHAR DEFAULT 'PENDING',          -- PENDING / APPROVED / REJECTED / CANCELLED
    requested_by INTEGER REFERENCES users(id),
    reviewed_by INTEGER REFERENCES users(id),
    review_note TEXT,
    reviewed_at TIMESTAMPTZ,
    executed_at TIMESTAMPTZ,                   -- when the staged action was applied
    execution_result JSONB,                    -- resulting record ids (e.g. sale_id)
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_type ON approval_requests(request_type);

-- ----------------------------------------------------------------------------
-- 2. MONEY MANAGEMENT (Feature #2): cash in/out, bank in/out
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS money_accounts (
    id SERIAL PRIMARY KEY,
    name VARCHAR NOT NULL,
    account_type VARCHAR NOT NULL DEFAULT 'CASH',   -- CASH / BANK
    bank_name VARCHAR,
    account_number VARCHAR,
    current_balance NUMERIC DEFAULT 0,
    is_active BOOLEAN DEFAULT true,
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS money_transactions (
    id SERIAL PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES money_accounts(id),
    direction VARCHAR NOT NULL,                -- IN / OUT
    amount NUMERIC NOT NULL CHECK (amount >= 0),
    category VARCHAR NOT NULL,                 -- sale_payment / customer_deposit / rider_deposit /
                                               -- expense / raw_material_purchase / salary_payment /
                                               -- refund / transfer / loan_disbursement / debt_payment /
                                               -- opening_balance / adjustment / other
    reference_type VARCHAR,                    -- sale / payment / expense / salary_payment / wallet_transaction / ...
    reference_id INTEGER,
    transfer_pair_id INTEGER,                  -- links the two legs of an account transfer
    description TEXT,
    payment_method VARCHAR,
    transaction_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    recorded_by INTEGER REFERENCES users(id),
    approval_request_id INTEGER REFERENCES approval_requests(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_money_txn_account ON money_transactions(account_id);
CREATE INDEX IF NOT EXISTS idx_money_txn_date ON money_transactions(transaction_date);
CREATE INDEX IF NOT EXISTS idx_money_txn_category ON money_transactions(category);

-- ----------------------------------------------------------------------------
-- 3. APP SETTINGS (Feature #9): WhatsApp API keys, AI config, everything
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_settings (
    id SERIAL PRIMARY KEY,
    setting_key VARCHAR UNIQUE NOT NULL,
    setting_value JSONB,
    category VARCHAR DEFAULT 'general',        -- general / whatsapp / ai / workflow / company / notifications
    is_secret BOOLEAN DEFAULT false,           -- secret values masked in API responses
    description TEXT,
    updated_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ----------------------------------------------------------------------------
-- 4. AUDIT LOG (Feature #9): every action, web + WhatsApp
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER,
    user_name VARCHAR,
    user_role VARCHAR,
    channel VARCHAR DEFAULT 'web',             -- web / whatsapp / system
    action VARCHAR NOT NULL,                   -- CREATE / UPDATE / DELETE / LOGIN / APPROVE / REJECT / ...
    entity_type VARCHAR,                       -- sale / product / payment / ...
    entity_id VARCHAR,
    description TEXT,
    old_values JSONB,
    new_values JSONB,
    metadata JSONB,
    ip_address VARCHAR,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id);

-- ----------------------------------------------------------------------------
-- 5. SALES RETURNS (Feature #10)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_returns (
    id SERIAL PRIMARY KEY,
    sale_id INTEGER NOT NULL REFERENCES sales_transactions(id),
    customer_id INTEGER REFERENCES customers(id),
    rider_id INTEGER REFERENCES riders(id),
    return_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    reason TEXT,
    total_amount NUMERIC NOT NULL DEFAULT 0,
    resolution VARCHAR NOT NULL,               -- CREDIT_BALANCE / ADVANCE_BALANCE / REFUND
    status VARCHAR DEFAULT 'COMPLETED',        -- PENDING / COMPLETED / REJECTED
    processed_by INTEGER REFERENCES users(id),
    approval_request_id INTEGER REFERENCES approval_requests(id),
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sales_returns_sale ON sales_returns(sale_id);

CREATE TABLE IF NOT EXISTS sales_return_items (
    id SERIAL PRIMARY KEY,
    return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    price_at_sale NUMERIC NOT NULL,
    cost_at_sale NUMERIC DEFAULT 0,
    amount NUMERIC NOT NULL,
    restocked BOOLEAN DEFAULT true             -- whether qty was added back to inventory
);

-- ----------------------------------------------------------------------------
-- 6. SPLIT / MULTI-METHOD PAYMENTS (Feature #10)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_payment_splits (
    id SERIAL PRIMARY KEY,
    sale_id INTEGER NOT NULL REFERENCES sales_transactions(id) ON DELETE CASCADE,
    payment_method VARCHAR NOT NULL,           -- Cash / Transfer / POS / Wallet / ...
    amount NUMERIC NOT NULL CHECK (amount >= 0),
    reference VARCHAR,
    money_account_id INTEGER REFERENCES money_accounts(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_splits_sale ON sales_payment_splits(sale_id);

-- ----------------------------------------------------------------------------
-- 7. ADVANCE DEPOSITS / WALLETS (Feature #11)
-- ----------------------------------------------------------------------------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS advance_balance NUMERIC DEFAULT 0;
ALTER TABLE riders    ADD COLUMN IF NOT EXISTS advance_balance NUMERIC DEFAULT 0;

CREATE TABLE IF NOT EXISTS wallet_transactions (
    id SERIAL PRIMARY KEY,
    owner_type VARCHAR NOT NULL,               -- customer / rider
    owner_id INTEGER NOT NULL,
    transaction_type VARCHAR NOT NULL,         -- DEPOSIT / REFUND / SALE_PAYMENT / CREDIT_SETTLEMENT / RETURN_CREDIT / ADJUSTMENT
    direction VARCHAR NOT NULL,                -- IN / OUT
    amount NUMERIC NOT NULL CHECK (amount >= 0),
    balance_after NUMERIC NOT NULL,
    reference_type VARCHAR,                    -- sale / payment / sales_return / ...
    reference_id INTEGER,
    payment_method VARCHAR,
    money_account_id INTEGER REFERENCES money_accounts(id),
    notes TEXT,
    recorded_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wallet_owner ON wallet_transactions(owner_type, owner_id);

-- ----------------------------------------------------------------------------
-- 8. STAFF LOAN TERMS (Feature #4): repay over N months
-- ----------------------------------------------------------------------------
ALTER TABLE staff_loans
    ADD COLUMN IF NOT EXISTS repayment_months INTEGER,
    ADD COLUMN IF NOT EXISTS monthly_deduction NUMERIC,
    ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC,
    ADD COLUMN IF NOT EXISTS start_date DATE,
    ADD COLUMN IF NOT EXISTS status VARCHAR DEFAULT 'active';   -- active / completed / cancelled

UPDATE staff_loans SET remaining_balance = amount WHERE remaining_balance IS NULL;
UPDATE staff_loans SET status = CASE WHEN is_paid THEN 'completed' ELSE 'active' END WHERE status IS NULL;

-- ----------------------------------------------------------------------------
-- 9. INTERNAL CHAT (Feature #7): direct + group, entity references
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_conversations (
    id SERIAL PRIMARY KEY,
    type VARCHAR NOT NULL DEFAULT 'direct',    -- direct / group
    name VARCHAR,                              -- group name
    created_by INTEGER REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_participants (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at TIMESTAMPTZ,
    joined_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    message_text TEXT,
    reference_type VARCHAR,                    -- product / sale / payment / customer / rider / expense
    reference_id INTEGER,
    reference_snapshot JSONB,                  -- display copy so refs survive edits/deletes
    is_deleted BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id, created_at);

-- ----------------------------------------------------------------------------
-- 10. AI CHAT HISTORY (Feature #7)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ai_chat_messages (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    role VARCHAR NOT NULL,                     -- user / assistant
    content TEXT NOT NULL,
    mode VARCHAR DEFAULT 'offline',            -- online / offline
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ai_chat_user ON ai_chat_messages(user_id, created_at);

-- ----------------------------------------------------------------------------
-- 11. WHATSAPP SESSIONS (Feature #8)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS whatsapp_sessions (
    id SERIAL PRIMARY KEY,
    phone_number VARCHAR UNIQUE NOT NULL,
    user_id INTEGER REFERENCES users(id),
    is_authenticated BOOLEAN DEFAULT false,
    login_code VARCHAR,                        -- one-time code used to link identity
    login_code_expires_at TIMESTAMPTZ,
    session_state JSONB DEFAULT '{}'::jsonb,   -- current menu / pending step-by-step action
    last_active_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ============================================================================
-- SEED DATA (all idempotent)
-- ============================================================================

-- Permissions catalog: feature × action
INSERT INTO permissions (permission_key, feature, action, description)
SELECT feature || '.' || action, feature, action,
       'Can ' || action || ' in ' || feature
FROM (VALUES
    ('dashboard'), ('sales'), ('exchanges'), ('products'), ('categories'),
    ('inventory'), ('production'), ('raw_materials'), ('recipes'),
    ('customers'), ('riders'), ('payments'), ('credit'), ('wallets'), ('returns'),
    ('salaries'), ('staff'), ('expenses'), ('debts'), ('money'),
    ('reports'), ('analysis'), ('users'), ('branches'), ('services'),
    ('approvals'), ('settings'), ('chat'), ('ai_assistant'), ('audit_logs')
) AS f(feature)
CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('delete'), ('approve')) AS a(action)
ON CONFLICT (permission_key) DO NOTHING;

-- Default role grants matching the system's CURRENT behavior (no behavior change):
-- admin: everything
INSERT INTO role_permissions (role, permission_key, is_allowed)
SELECT 'admin', permission_key, true FROM permissions
ON CONFLICT (role, permission_key) DO NOTHING;

-- manager: everything except destructive user/settings/audit management
INSERT INTO role_permissions (role, permission_key, is_allowed)
SELECT 'manager', permission_key, true FROM permissions
WHERE NOT (feature IN ('users','settings','audit_logs') AND action IN ('delete','edit'))
ON CONFLICT (role, permission_key) DO NOTHING;

-- sales: POS-facing permissions
INSERT INTO role_permissions (role, permission_key, is_allowed)
SELECT 'sales', permission_key, true FROM permissions
WHERE (feature IN ('sales','exchanges','payments','credit','returns','chat','ai_assistant') AND action IN ('view','create'))
   OR (feature IN ('products','customers','riders','inventory','wallets') AND action = 'view')
   OR (feature = 'dashboard' AND action = 'view')
ON CONFLICT (role, permission_key) DO NOTHING;

-- baker: production-facing permissions
INSERT INTO role_permissions (role, permission_key, is_allowed)
SELECT 'baker', permission_key, true FROM permissions
WHERE (feature IN ('production','chat','ai_assistant') AND action IN ('view','create'))
   OR (feature IN ('raw_materials','recipes','products','inventory') AND action = 'view')
   OR (feature = 'dashboard' AND action = 'view')
ON CONFLICT (role, permission_key) DO NOTHING;

-- accountant: finance-facing permissions
INSERT INTO role_permissions (role, permission_key, is_allowed)
SELECT 'accountant', permission_key, true FROM permissions
WHERE (feature IN ('payments','credit','wallets','expenses','debts','salaries','money','reports','analysis','returns','chat','ai_assistant') AND action IN ('view','create','edit'))
   OR (feature IN ('sales','customers','riders','staff') AND action = 'view')
   OR (feature = 'dashboard' AND action = 'view')
ON CONFLICT (role, permission_key) DO NOTHING;

-- Workflow settings: approval DISABLED by default for every feature.
-- Admin enables per-feature approvals from the new Permissions & Workflow page.
INSERT INTO workflow_settings (feature, display_name, requires_approval, approval_threshold, description)
VALUES
    ('sales',                 'Sales Processing',        false, 0, 'New sales transactions'),
    ('production_log',        'Production Logging',      false, 0, 'Recording production batches'),
    ('raw_material_restock',  'Raw Material Restock',    false, 0, 'Restocking raw materials'),
    ('stock_issue',           'Stock Issue / Return',    false, 0, 'Issuing or returning stock to sales users'),
    ('payment',               'Payments',                false, 0, 'Customer & rider payments'),
    ('expense',               'Operating Expenses',      false, 0, 'Recording operating expenses'),
    ('salary_payment',        'Salary Payments',         false, 0, 'Paying staff salaries'),
    ('return',                'Sales Returns',           false, 0, 'Customer / rider product returns'),
    ('wallet_deposit',        'Advance Deposits',        false, 0, 'Customer / rider advance deposits'),
    ('wallet_refund',         'Wallet Refunds',          false, 0, 'Refunding advance balances'),
    ('money_transaction',     'Money Transactions',      false, 0, 'Manual cash/bank in & out'),
    ('staff_loan',            'Staff Loans',             false, 0, 'Granting staff loans')
ON CONFLICT (feature) DO NOTHING;

-- Default money account
INSERT INTO money_accounts (name, account_type, current_balance)
SELECT 'Main Cash', 'CASH', 0
WHERE NOT EXISTS (SELECT 1 FROM money_accounts WHERE account_type = 'CASH');

-- App settings seeds (keys consumed by upcoming features)
INSERT INTO app_settings (setting_key, setting_value, category, is_secret, description)
VALUES
    ('ai.mode',            '"offline"'::jsonb, 'ai', false, 'AI assistant mode: online or offline'),
    ('ai.api_key',         '""'::jsonb,        'ai', true,  'API key for the online AI provider'),
    ('ai.provider',        '"openai"'::jsonb,  'ai', false, 'Online AI provider (openai-compatible)'),
    ('ai.model',           '"gpt-4o-mini"'::jsonb, 'ai', false, 'Model used in online AI mode'),
    ('whatsapp.enabled',   'false'::jsonb,     'whatsapp', false, 'Enable the WhatsApp integration'),
    ('whatsapp.api_token', '""'::jsonb,        'whatsapp', true,  'WhatsApp Cloud API access token'),
    ('whatsapp.phone_number_id', '""'::jsonb,  'whatsapp', false, 'WhatsApp Cloud API phone number ID'),
    ('whatsapp.verify_token', '""'::jsonb,     'whatsapp', true,  'Webhook verify token for WhatsApp'),
    ('company.currency',   '"NGN"'::jsonb,     'general', false, 'Display currency code'),
    ('reports.tax_rate',   '0.30'::jsonb,      'general', false, 'Tax rate used in Profit & Loss report')
ON CONFLICT (setting_key) DO NOTHING;

-- Record this migration
INSERT INTO schema_migrations (filename)
VALUES ('001_system_upgrades_foundation.sql')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
