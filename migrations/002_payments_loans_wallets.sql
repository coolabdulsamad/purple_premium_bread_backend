-- Migration 002: Phase 4 - payments by amount, loan repayment schedules, advance wallets
-- Idempotent: safe to run multiple times. Does NOT modify or delete any existing data.

-- 1. Advance (wallet) balances on customers and riders
ALTER TABLE customers ADD COLUMN IF NOT EXISTS advance_balance NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE riders ADD COLUMN IF NOT EXISTS advance_balance NUMERIC(14,2) NOT NULL DEFAULT 0;

-- 2. Staff loan repayment schedule columns
ALTER TABLE staff_loans ADD COLUMN IF NOT EXISTS due_date DATE;
ALTER TABLE staff_loans ADD COLUMN IF NOT EXISTS repayment_months INTEGER;
ALTER TABLE staff_loans ADD COLUMN IF NOT EXISTS monthly_deduction NUMERIC(14,2);
ALTER TABLE staff_loans ADD COLUMN IF NOT EXISTS remaining_balance NUMERIC(14,2);
ALTER TABLE staff_loans ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE staff_loans ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE staff_loans ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;
ALTER TABLE staff_loans ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP;

-- 3. Backfill existing loans (no data loss: remaining = amount, paid loans marked completed)
UPDATE staff_loans SET remaining_balance = amount WHERE remaining_balance IS NULL;
UPDATE staff_loans SET status = 'completed', completed_at = COALESCE(completed_at, created_at) WHERE is_paid = TRUE AND status <> 'completed';
UPDATE staff_loans SET monthly_deduction = COALESCE(remaining_balance, amount) WHERE monthly_deduction IS NULL AND repayment_months IS NULL;
UPDATE staff_loans SET start_date = loan_date WHERE start_date IS NULL;

-- 4. Salary payments: explicit credit-sales deduction column
ALTER TABLE salary_payments ADD COLUMN IF NOT EXISTS credit_sales_deduction NUMERIC(14,2) NOT NULL DEFAULT 0;

-- 5. Loan repayment ledger (used by salary deductions and manual repayments)
CREATE TABLE IF NOT EXISTS loan_repayments (
    id SERIAL PRIMARY KEY,
    loan_id INTEGER NOT NULL REFERENCES staff_loans(id) ON DELETE CASCADE,
    amount NUMERIC(14,2) NOT NULL,
    payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
    salary_payment_id INTEGER,
    notes TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_loan_repayments_loan ON loan_repayments (loan_id, payment_date DESC);

-- 6. Wallet transaction ledger (customer / rider advance deposits)
CREATE TABLE IF NOT EXISTS wallet_transactions (
    id SERIAL PRIMARY KEY,
    owner_type VARCHAR(20) NOT NULL CHECK (owner_type IN ('CUSTOMER','RIDER')),
    owner_id INTEGER NOT NULL,
    transaction_type VARCHAR(30) NOT NULL,
    amount NUMERIC(14,2) NOT NULL,
    balance_after NUMERIC(14,2) NOT NULL DEFAULT 0,
    reference_type VARCHAR(50),
    reference_id INTEGER,
    notes TEXT,
    created_by INTEGER,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_owner ON wallet_transactions (owner_type, owner_id, created_at DESC);
