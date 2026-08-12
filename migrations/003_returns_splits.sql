-- Migration 003: Sales returns, split payments, and sale-level extras
-- Idempotent: safe to run multiple times. Adds ONLY new tables + indexes.
-- Phase 5 feature set:
--   * Returns of any quantity from any sale (with inventory restock + balance/wallet effects)
--   * Split payment methods within a single sale
--   * Advance-wallet usage tracking hooks (wallet_transactions lives in migration 002)

-- ---------------------------------------------------------------------------
-- 1. sale_payment_splits: one row per payment method used inside a single sale
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sale_payment_splits (
    id              SERIAL PRIMARY KEY,
    sale_id         INTEGER NOT NULL REFERENCES sales_transactions(id) ON DELETE CASCADE,
    payment_method  VARCHAR(50) NOT NULL,
    amount          NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sale_payment_splits_sale_id ON sale_payment_splits(sale_id);

-- ---------------------------------------------------------------------------
-- 2. sales_returns: header for each return event
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_returns (
    id              SERIAL PRIMARY KEY,
    sale_id         INTEGER NOT NULL REFERENCES sales_transactions(id) ON DELETE CASCADE,
    customer_id     INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    rider_id        INTEGER REFERENCES riders(id) ON DELETE SET NULL,
    return_date     TIMESTAMP NOT NULL DEFAULT NOW(),
    total_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
    -- How the refunded value was settled:
    --   credit_balance -> reduced the customer's/rider's outstanding credit
    --   advance        -> credited to the advance wallet
    --   cash / bank    -> money paid out (recorded in money_transactions)
    refund_method   VARCHAR(20) NOT NULL DEFAULT 'advance'
        CHECK (refund_method IN ('credit_balance', 'advance', 'cash', 'bank')),
    -- Breakdown of where the value went (all default 0; sums to total_amount)
    credit_applied  NUMERIC(14,2) NOT NULL DEFAULT 0,
    wallet_credited NUMERIC(14,2) NOT NULL DEFAULT 0,
    cash_refunded   NUMERIC(14,2) NOT NULL DEFAULT 0,
    reason          TEXT,
    processed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_returns_sale_id     ON sales_returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_sales_returns_customer_id ON sales_returns(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_returns_rider_id    ON sales_returns(rider_id);
CREATE INDEX IF NOT EXISTS idx_sales_returns_return_date ON sales_returns(return_date);

-- ---------------------------------------------------------------------------
-- 3. sales_return_items: per-product returned quantities
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales_return_items (
    id          SERIAL PRIMARY KEY,
    return_id   INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
    product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
    quantity    NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
    unit_price  NUMERIC(14,2) NOT NULL DEFAULT 0,
    amount      NUMERIC(14,2) NOT NULL DEFAULT 0,
    restocked   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sales_return_items_return_id  ON sales_return_items(return_id);
CREATE INDEX IF NOT EXISTS idx_sales_return_items_product_id ON sales_return_items(product_id);
