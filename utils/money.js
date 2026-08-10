// utils/money.js — shared money-management helpers.
//
// Every cash/bank movement in the business flows through recordMoneyTransaction,
// which inserts a money_transactions row AND updates the account balance atomically.
// FAIL-OPEN: if the money tables don't exist yet (migration not applied), these
// helpers no-op and return null/false so business operations are never blocked.
const db = require('../db/db');
const { hasTable } = require('./schemaReady');

async function moneyReady() {
    return (await hasTable('money_accounts')) && (await hasTable('money_transactions'));
}

// 'Cash' → first active CASH account; anything else → first active BANK account.
async function getDefaultAccountId(paymentMethod) {
    const type = (paymentMethod || '').toLowerCase() === 'cash' ? 'CASH' : 'BANK';
    let result = await db.query(
        'SELECT id FROM money_accounts WHERE account_type = $1 AND is_active = true ORDER BY id LIMIT 1',
        [type]
    );
    if (result.rows.length === 0) {
        result = await db.query(
            'SELECT id FROM money_accounts WHERE is_active = true ORDER BY id LIMIT 1'
        );
    }
    return result.rows[0] ? result.rows[0].id : null;
}

// opts: { client?, account_id?, direction: 'IN'|'OUT', amount, category,
//         reference_type?, reference_id?, transfer_pair_id?, description?,
//         payment_method?, transaction_date?, recorded_by?, approval_request_id? }
async function recordMoneyTransaction(opts = {}) {
    try {
        if (!(await moneyReady())) return null;
        const amount = parseFloat(opts.amount);
        const accountId = opts.account_id || (await getDefaultAccountId(opts.payment_method));
        if (!accountId || !['IN', 'OUT'].includes(opts.direction) || !Number.isFinite(amount)) return null;

        const ownClient = !opts.client;
        const client = opts.client || (await db.pool.connect());
        try {
            if (ownClient) await client.query('BEGIN');
            const ins = await client.query(
                `INSERT INTO money_transactions
                 (account_id, direction, amount, category, reference_type, reference_id,
                  transfer_pair_id, description, payment_method, transaction_date,
                  recorded_by, approval_request_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10, CURRENT_TIMESTAMP),$11,$12)
                 RETURNING *`,
                [
                    accountId, opts.direction, amount, opts.category || 'other',
                    opts.reference_type || null, opts.reference_id || null,
                    opts.transfer_pair_id || null, opts.description || null,
                    opts.payment_method || null, opts.transaction_date || null,
                    opts.recorded_by || null, opts.approval_request_id || null
                ]
            );
            await client.query(
                `UPDATE money_accounts
                 SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [opts.direction === 'IN' ? amount : -amount, accountId]
            );
            if (ownClient) await client.query('COMMIT');
            return ins.rows[0];
        } catch (err) {
            if (ownClient) await client.query('ROLLBACK').catch(() => {});
            console.error('recordMoneyTransaction failed:', err.message);
            return null;
        } finally {
            if (ownClient) client.release();
        }
    } catch (err) {
        console.error('recordMoneyTransaction error:', err.message);
        return null;
    }
}

// Reverse + delete all money transactions recorded for a business document
// (used when that document is edited/deleted, e.g. an expense).
async function removeMoneyTransactionsByReference(referenceType, referenceId) {
    try {
        if (!(await moneyReady())) return false;
        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const txns = await client.query(
                'SELECT * FROM money_transactions WHERE reference_type = $1 AND reference_id = $2',
                [referenceType, referenceId]
            );
            for (const t of txns.rows) {
                await client.query(
                    `UPDATE money_accounts
                     SET current_balance = current_balance + $1, updated_at = CURRENT_TIMESTAMP
                     WHERE id = $2`,
                    [t.direction === 'IN' ? -parseFloat(t.amount) : parseFloat(t.amount), t.account_id]
                );
            }
            await client.query(
                'DELETE FROM money_transactions WHERE reference_type = $1 AND reference_id = $2',
                [referenceType, referenceId]
            );
            await client.query('COMMIT');
            return true;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('removeMoneyTransactionsByReference failed:', err.message);
            return false;
        } finally {
            client.release();
        }
    } catch (err) {
        console.error('removeMoneyTransactionsByReference error:', err.message);
        return false;
    }
}

module.exports = {
    recordMoneyTransaction,
    removeMoneyTransactionsByReference,
    getDefaultAccountId,
    moneyReady
};
