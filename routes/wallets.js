/**
 * routes/wallets.js
 *
 * Phase 5: Advance deposit wallets for customers and riders.
 *  - POST /deposit  : money paid in advance (recorded in money_transactions as IN)
 *  - POST /refund   : money paid back out of the wallet (any payment method)
 *  - POST /use      : spend wallet balance on a specific sale, or auto-clear
 *                     the owner's oldest outstanding credit sales first
 *  - GET  /balance  : current advance balance + owner info
 *  - GET  /history  : full wallet_transactions ledger
 *
 * Wallet spending never touches money_transactions (the cash was already
 * counted at deposit time); deposits and refunds do.
 * All endpoints return a clear 503 until migration 002 is applied.
 */

const express = require('express');
const router = express.Router();
const { jwtDecode } = require('jwt-decode');
const db = require('../db/db');
const { recordMoneyTransaction } = require('../utils/money');
const { ensureWalletSchema } = require('../utils/schemaGuards');

const getUserIdFromToken = (req) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) return jwtDecode(token).id || null;
    } catch (e) {
        console.error('Wallets: failed to decode token', e.message);
    }
    return null;
};

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

const OWNER = {
    CUSTOMER: { table: 'customers', nameColumn: 'fullname', depositCategory: 'customer_deposit', label: 'Customer' },
    RIDER: { table: 'riders', nameColumn: 'fullname', depositCategory: 'rider_deposit', label: 'Rider' }
};

const normalizeOwnerType = (value) => {
    const v = String(value || '').trim().toUpperCase();
    return OWNER[v] ? v : null;
};

const requireWallet = async (res) => {
    if (!(await ensureWalletSchema())) {
        res.status(503).json({ error: 'Advance wallets unavailable: migration 002 has not been applied yet.' });
        return false;
    }
    return true;
};

const validateOwnerBody = (req, res) => {
    const ownerType = normalizeOwnerType(req.body.owner_type);
    const ownerId = parseInt(req.body.owner_id, 10);
    const amount = round2(req.body.amount);
    if (!ownerType) {
        res.status(400).json({ error: 'owner_type must be CUSTOMER or RIDER.' });
        return null;
    }
    if (!ownerId || ownerId <= 0) {
        res.status(400).json({ error: 'A valid owner_id is required.' });
        return null;
    }
    if (!(amount > 0)) {
        res.status(400).json({ error: 'amount must be greater than zero.' });
        return null;
    }
    return { ownerType, ownerId, amount };
};

/**
 * GET /api/wallets/balance?owner_type=CUSTOMER|RIDER&owner_id=123
 */
router.get('/balance', async (req, res) => {
    if (!(await requireWallet(res))) return;
    const ownerType = normalizeOwnerType(req.query.owner_type);
    const ownerId = parseInt(req.query.owner_id, 10);
    if (!ownerType || !ownerId) {
        return res.status(400).json({ error: 'owner_type (CUSTOMER|RIDER) and owner_id are required.' });
    }
    const meta = OWNER[ownerType];
    try {
        const result = await db.query(
            `SELECT id, ${meta.nameColumn} AS owner_name, COALESCE(advance_balance, 0) AS advance_balance
             FROM ${meta.table} WHERE id = $1`,
            [ownerId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: `${meta.label} not found.` });
        }
        res.status(200).json({
            owner_type: ownerType,
            owner_id: ownerId,
            owner_name: result.rows[0].owner_name,
            advance_balance: parseFloat(result.rows[0].advance_balance)
        });
    } catch (error) {
        console.error('Error fetching wallet balance:', error);
        res.status(500).json({ error: 'Failed to fetch wallet balance.', details: error.message });
    }
});

/**
 * GET /api/wallets/history?owner_type=CUSTOMER|RIDER&owner_id=123&limit=100&offset=0
 */
router.get('/history', async (req, res) => {
    if (!(await requireWallet(res))) return;
    const ownerType = normalizeOwnerType(req.query.owner_type);
    const ownerId = parseInt(req.query.owner_id, 10);
    if (!ownerType || !ownerId) {
        return res.status(400).json({ error: 'owner_type (CUSTOMER|RIDER) and owner_id are required.' });
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;
    try {
        const result = await db.query(
            `SELECT wt.*, u.fullname AS created_by_name
             FROM wallet_transactions wt
             LEFT JOIN users u ON wt.created_by = u.id
             WHERE wt.owner_type = $1 AND wt.owner_id = $2
             ORDER BY wt.created_at DESC, wt.id DESC
             LIMIT $3 OFFSET $4`,
            [ownerType, ownerId, limit, offset]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching wallet history:', error);
        res.status(500).json({ error: 'Failed to fetch wallet history.', details: error.message });
    }
});

/**
 * POST /api/wallets/deposit
 * Body: { owner_type, owner_id, amount, payment_method: 'cash'|'bank', transaction_date?, notes? }
 */
router.post('/deposit', async (req, res) => {
    if (!(await requireWallet(res))) return;
    const parsed = validateOwnerBody(req, res);
    if (!parsed) return;
    const { ownerType, ownerId, amount } = parsed;
    const { payment_method = 'cash', transaction_date, notes } = req.body;
    const recordedBy = getUserIdFromToken(req);
    const meta = OWNER[ownerType];

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const ownerResult = await client.query(
            `SELECT id, ${meta.nameColumn} AS owner_name, COALESCE(advance_balance, 0) AS advance_balance
             FROM ${meta.table} WHERE id = $1 FOR UPDATE`,
            [ownerId]
        );
        if (ownerResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: `${meta.label} not found.` });
        }

        const updateResult = await client.query(
            `UPDATE ${meta.table} SET advance_balance = COALESCE(advance_balance, 0) + $1
             WHERE id = $2 RETURNING advance_balance`,
            [amount, ownerId]
        );
        const newBalance = parseFloat(updateResult.rows[0].advance_balance);

        const txnResult = await client.query(
            `INSERT INTO wallet_transactions
                (owner_type, owner_id, transaction_type, amount, balance_after, reference_type, notes, created_by)
             VALUES ($1, $2, 'DEPOSIT', $3, $4, 'wallet_deposit', $5, $6)
             RETURNING *`,
            [ownerType, ownerId, amount, newBalance, notes || null, recordedBy]
        );

        await recordMoneyTransaction({
            client,
            direction: 'IN',
            amount,
            category: meta.depositCategory,
            reference_type: 'wallet_transaction',
            reference_id: txnResult.rows[0].id,
            description: `Advance deposit from ${meta.label.toLowerCase()} ${ownerResult.rows[0].owner_name}`,
            payment_method,
            transaction_date: transaction_date || new Date(),
            recorded_by: recordedBy
        });

        await client.query('COMMIT');
        res.status(201).json({
            message: 'Deposit recorded successfully.',
            transaction: txnResult.rows[0],
            advance_balance: newBalance
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Wallet deposit error:', error);
        res.status(500).json({ error: 'Failed to record deposit.', details: error.message });
    } finally {
        client.release();
    }
});

/**
 * POST /api/wallets/refund
 * Body: { owner_type, owner_id, amount, payment_method: 'cash'|'bank', transaction_date?, notes? }
 * Pays money out of the wallet back to the owner.
 */
router.post('/refund', async (req, res) => {
    if (!(await requireWallet(res))) return;
    const parsed = validateOwnerBody(req, res);
    if (!parsed) return;
    const { ownerType, ownerId, amount } = parsed;
    const { payment_method = 'cash', transaction_date, notes } = req.body;
    const recordedBy = getUserIdFromToken(req);
    const meta = OWNER[ownerType];

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const ownerResult = await client.query(
            `SELECT id, ${meta.nameColumn} AS owner_name, COALESCE(advance_balance, 0) AS advance_balance
             FROM ${meta.table} WHERE id = $1 FOR UPDATE`,
            [ownerId]
        );
        if (ownerResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: `${meta.label} not found.` });
        }
        const currentBalance = parseFloat(ownerResult.rows[0].advance_balance);
        if (amount > currentBalance + 0.004) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: `Insufficient wallet balance. Available: ${currentBalance.toFixed(2)}, requested: ${amount.toFixed(2)}.`
            });
        }

        const updateResult = await client.query(
            `UPDATE ${meta.table} SET advance_balance = advance_balance - $1
             WHERE id = $2 RETURNING advance_balance`,
            [amount, ownerId]
        );
        const newBalance = parseFloat(updateResult.rows[0].advance_balance);

        const txnResult = await client.query(
            `INSERT INTO wallet_transactions
                (owner_type, owner_id, transaction_type, amount, balance_after, reference_type, notes, created_by)
             VALUES ($1, $2, 'REFUND', $3, $4, 'wallet_refund', $5, $6)
             RETURNING *`,
            [ownerType, ownerId, amount, newBalance, notes || null, recordedBy]
        );

        await recordMoneyTransaction({
            client,
            direction: 'OUT',
            amount,
            category: 'refund',
            reference_type: 'wallet_transaction',
            reference_id: txnResult.rows[0].id,
            description: `Advance refund to ${meta.label.toLowerCase()} ${ownerResult.rows[0].owner_name}`,
            payment_method,
            transaction_date: transaction_date || new Date(),
            recorded_by: recordedBy
        });

        await client.query('COMMIT');
        res.status(201).json({
            message: 'Refund paid successfully.',
            transaction: txnResult.rows[0],
            advance_balance: newBalance
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Wallet refund error:', error);
        res.status(500).json({ error: 'Failed to pay refund.', details: error.message });
    } finally {
        client.release();
    }
});

/**
 * POST /api/wallets/use
 * Spend wallet balance against credit sales.
 * Body: { owner_type, owner_id, amount, sale_id?, notes? }
 *  - With sale_id: pays that specific sale (capped at its balance_due).
 *  - Without sale_id: auto-allocates oldest-first across the owner's unpaid sales.
 * No money movement: the cash entered at deposit time.
 */
router.post('/use', async (req, res) => {
    if (!(await requireWallet(res))) return;
    const parsed = validateOwnerBody(req, res);
    if (!parsed) return;
    const { ownerType, ownerId, amount } = parsed;
    const { sale_id, notes } = req.body;
    const recordedBy = getUserIdFromToken(req);
    const meta = OWNER[ownerType];
    const isRider = ownerType === 'RIDER';

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const ownerResult = await client.query(
            `SELECT id, ${meta.nameColumn} AS owner_name, COALESCE(advance_balance, 0) AS advance_balance
             FROM ${meta.table} WHERE id = $1 FOR UPDATE`,
            [ownerId]
        );
        if (ownerResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: `${meta.label} not found.` });
        }
        const walletBalance = parseFloat(ownerResult.rows[0].advance_balance);
        if (amount > walletBalance + 0.004) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                error: `Insufficient wallet balance. Available: ${walletBalance.toFixed(2)}, requested: ${amount.toFixed(2)}.`
            });
        }

        // Pick target sales
        let salesResult;
        if (sale_id) {
            salesResult = await client.query(
                `SELECT id, total_amount, amount_paid, balance_due, customer_id, rider_id, is_rider_sale
                 FROM sales_transactions
                 WHERE id = $1 AND balance_due > 0
                 FOR UPDATE`,
                [sale_id]
            );
            if (salesResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Sale not found or has no outstanding balance.' });
            }
            const target = salesResult.rows[0];
            const ownsSale = isRider
                ? (target.rider_id === ownerId && target.is_rider_sale)
                : (target.customer_id === ownerId && !target.is_rider_sale);
            if (!ownsSale) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: `Sale #${sale_id} does not belong to this ${meta.label.toLowerCase()}.` });
            }
        } else {
            salesResult = await client.query(
                isRider
                    ? `SELECT id, total_amount, amount_paid, balance_due, customer_id, rider_id, is_rider_sale
                       FROM sales_transactions
                       WHERE rider_id = $1 AND is_rider_sale = true AND balance_due > 0
                       ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC
                       FOR UPDATE`
                    : `SELECT id, total_amount, amount_paid, balance_due, customer_id, rider_id, is_rider_sale
                       FROM sales_transactions
                       WHERE customer_id = $1 AND (is_rider_sale = false OR is_rider_sale IS NULL) AND balance_due > 0
                       ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC
                       FOR UPDATE`,
                [ownerId]
            );
            if (salesResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ error: `No outstanding credit sales found for this ${meta.label.toLowerCase()}.` });
            }
        }

        // Allocate across target sales
        let remaining = amount;
        const allocations = [];
        for (const saleRow of salesResult.rows) {
            if (remaining <= 0.004) break;
            const due = round2(saleRow.balance_due);
            if (due <= 0) continue;
            const applied = round2(Math.min(remaining, due));
            const newPaid = round2(parseFloat(saleRow.amount_paid) + applied);
            const newDue = round2(due - applied);
            const newStatus = newDue <= 0 ? 'Paid' : 'Partially Paid';

            await client.query(
                `UPDATE sales_transactions
                 SET amount_paid = $1, balance_due = $2, status = $3
                 WHERE id = $4`,
                [newPaid, newDue, newStatus, saleRow.id]
            );

            const paymentResult = await client.query(
                `INSERT INTO payments (transaction_id, customer_id, amount, payment_date, payment_method, notes, rider_id, is_rider_payment)
                 VALUES ($1, $2, $3, NOW(), 'Wallet', $4, $5, $6)
                 RETURNING id`,
                [
                    saleRow.id,
                    saleRow.customer_id || null,
                    applied,
                    notes || `Wallet balance applied to sale #${saleRow.id}`,
                    isRider ? ownerId : null,
                    isRider
                ]
            );

            allocations.push({
                sale_id: saleRow.id,
                payment_id: paymentResult.rows[0].id,
                amount: applied,
                new_balance_due: newDue,
                new_status: newStatus
            });
            remaining = round2(remaining - applied);
        }

        const usedAmount = round2(amount - remaining);
        if (usedAmount <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Nothing could be allocated from the wallet.' });
        }

        // Reduce credit balance + wallet balance
        if (isRider) {
            await client.query(
                `UPDATE riders SET current_balance = GREATEST(0, current_balance - $1), updated_at = NOW()
                 WHERE id = $2`,
                [usedAmount, ownerId]
            );
        } else {
            await client.query(
                `UPDATE customers SET balance = GREATEST(0, balance - $1), updated_at = NOW()
                 WHERE id = $2`,
                [usedAmount, ownerId]
            );
        }

        const updateResult = await client.query(
            `UPDATE ${meta.table} SET advance_balance = advance_balance - $1
             WHERE id = $2 RETURNING advance_balance`,
            [usedAmount, ownerId]
        );
        const newBalance = parseFloat(updateResult.rows[0].advance_balance);

        const txnResult = await client.query(
            `INSERT INTO wallet_transactions
                (owner_type, owner_id, transaction_type, amount, balance_after, reference_type, reference_id, notes, created_by)
             VALUES ($1, $2, 'USAGE', $3, $4, 'sale_payment', $5, $6, $7)
             RETURNING *`,
            [
                ownerType, ownerId, usedAmount, newBalance,
                sale_id || null,
                notes || `Wallet used to clear ${allocations.length} credit sale(s)`,
                recordedBy
            ]
        );

        await client.query('COMMIT');
        res.status(201).json({
            message: 'Wallet balance applied successfully.',
            transaction: txnResult.rows[0],
            amount_requested: amount,
            amount_used: usedAmount,
            amount_unallocated: remaining,
            advance_balance: newBalance,
            allocations
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Wallet use error:', error);
        res.status(500).json({ error: 'Failed to apply wallet balance.', details: error.message });
    } finally {
        client.release();
    }
});

module.exports = router;
