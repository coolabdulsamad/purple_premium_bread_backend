/**
 * utils/schemaGuards.js
 *
 * Cached, fail-closed-for-feature schema capability checks.
 * Each guard verifies (via information_schema) that the optional migration
 * backing a feature has been applied, so the API degrades gracefully — the
 * rest of the system keeps working before migrations run, and the new
 * endpoints return a clear 503 instead of a SQL error.
 *
 * Results are cached for the process lifetime; call resetSchemaGuardCache()
 * in tests or after running migrations inside a long-lived process.
 */

const db = require('../db/db');

const cache = new Map();

async function check(key, sql) {
    if (cache.has(key)) return cache.get(key);
    let ok = false;
    try {
        const result = await db.query(sql);
        ok = result.rows.length > 0 && Object.values(result.rows[0]).every(Boolean);
    } catch (err) {
        console.error(`Schema guard "${key}" check failed:`, err.message);
        ok = false;
    }
    cache.set(key, ok);
    return ok;
}

function resetSchemaGuardCache() {
    cache.clear();
}

/** customers.advance_balance + riders.advance_balance + wallet_transactions (migration 002) */
function ensureWalletSchema() {
    return check('wallet', `
        SELECT
            EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'advance_balance')
            AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'riders' AND column_name = 'advance_balance')
            AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'wallet_transactions')
        AS ready;
    `);
}

/** sales_returns + sales_return_items (migration 003) */
function ensureReturnsSchema() {
    return check('returns', `
        SELECT
            EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sales_returns')
            AND EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sales_return_items')
        AS ready;
    `);
}

/** sale_payment_splits (migration 003) */
function ensureSplitsSchema() {
    return check('splits', `
        SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sale_payment_splits') AS ready;
    `);
}

module.exports = {
    ensureWalletSchema,
    ensureReturnsSchema,
    ensureSplitsSchema,
    resetSchemaGuardCache
};
