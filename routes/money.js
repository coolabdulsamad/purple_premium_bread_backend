// routes/money.js — Money management: cash in/out, bank in/out, transfers, summary.
// Balances live on money_accounts.current_balance and are maintained by utils/money.js.
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { recordMoneyTransaction } = require('../utils/money');

const MONEY_CATEGORIES = {
    IN: [
        { key: 'sale_payment', label: 'Sale Payment' },
        { key: 'customer_deposit', label: 'Customer Advance Deposit' },
        { key: 'rider_deposit', label: 'Rider Advance Deposit' },
        { key: 'debt_payment', label: 'Debt Repayment' },
        { key: 'capital_injection', label: 'Capital Injection' },
        { key: 'transfer', label: 'Transfer In' },
        { key: 'refund_received', label: 'Refund Received' },
        { key: 'opening_balance', label: 'Opening Balance' },
        { key: 'adjustment', label: 'Adjustment' },
        { key: 'other_income', label: 'Other Income' }
    ],
    OUT: [
        { key: 'expense', label: 'Operating Expense' },
        { key: 'raw_material_purchase', label: 'Raw Material Purchase' },
        { key: 'salary_payment', label: 'Salary Payment' },
        { key: 'loan_disbursement', label: 'Staff Loan Disbursement' },
        { key: 'refund', label: 'Refund Paid' },
        { key: 'transfer', label: 'Transfer Out' },
        { key: 'withdrawal', label: 'Owner Withdrawal' },
        { key: 'adjustment', label: 'Adjustment' },
        { key: 'other_expense', label: 'Other Expense' }
    ]
};

function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    next();
}
router.use(requireAuth);

// GET /api/money/categories - category options for forms/filters
router.get('/categories', (req, res) => {
    res.status(200).json(MONEY_CATEGORIES);
});

// GET /api/money/accounts - all accounts with balances
router.get('/accounts', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT ma.*, u.fullname AS created_by_name,
                   COALESCE(m.period_in, 0) AS period_in,
                   COALESCE(m.period_out, 0) AS period_out
            FROM money_accounts ma
            LEFT JOIN users u ON ma.created_by = u.id
            LEFT JOIN LATERAL (
                SELECT SUM(CASE WHEN direction = 'IN' THEN amount ELSE 0 END) AS period_in,
                       SUM(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END) AS period_out
                FROM money_transactions
                WHERE account_id = ma.id
                  AND transaction_date >= DATE_TRUNC('month', CURRENT_DATE)
            ) m ON true
            ORDER BY ma.account_type, ma.name
        `);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching money accounts:', error);
        res.status(500).json({ error: 'Failed to fetch accounts.', details: error.message });
    }
});

// POST /api/money/accounts - create an account (opening balance recorded as a transaction)
router.post('/accounts', async (req, res) => {
    const { name, account_type, bank_name, account_number, opening_balance } = req.body;
    if (!name || !account_type || !['CASH', 'BANK'].includes(account_type)) {
        return res.status(400).json({ error: 'name and account_type (CASH or BANK) are required.' });
    }
    try {
        const result = await db.query(
            `INSERT INTO money_accounts (name, account_type, bank_name, account_number, created_by)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [name, account_type, bank_name || null, account_number || null, req.user.id]
        );
        const account = result.rows[0];

        const opening = parseFloat(opening_balance);
        if (Number.isFinite(opening) && opening > 0) {
            await recordMoneyTransaction({
                account_id: account.id,
                direction: 'IN',
                amount: opening,
                category: 'opening_balance',
                description: `Opening balance for ${name}`,
                recorded_by: req.user.id
            });
            const refreshed = await db.query('SELECT * FROM money_accounts WHERE id = $1', [account.id]);
            return res.status(201).json(refreshed.rows[0]);
        }

        res.status(201).json(account);
    } catch (error) {
        console.error('Error creating money account:', error);
        res.status(500).json({ error: 'Failed to create account.', details: error.message });
    }
});

// PUT /api/money/accounts/:id - edit details / activate / deactivate (balance untouched)
router.put('/accounts/:id', async (req, res) => {
    const { name, bank_name, account_number, is_active } = req.body;
    try {
        const result = await db.query(
            `UPDATE money_accounts
             SET name = COALESCE($1, name),
                 bank_name = COALESCE($2, bank_name),
                 account_number = COALESCE($3, account_number),
                 is_active = COALESCE($4, is_active),
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $5
             RETURNING *`,
            [name || null, bank_name, account_number,
             typeof is_active === 'boolean' ? is_active : null, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Account not found.' });
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating money account:', error);
        res.status(500).json({ error: 'Failed to update account.', details: error.message });
    }
});

// GET /api/money/transactions - filtered, paginated ledger
router.get('/transactions', async (req, res) => {
    try {
        const {
            account_id, direction, category, startDate, endDate, search,
            page = 1, limit = 50
        } = req.query;

        const params = [];
        let where = ' WHERE 1=1';
        let i = 1;
        if (account_id) { where += ` AND mt.account_id = $${i++}`; params.push(account_id); }
        if (direction) { where += ` AND mt.direction = $${i++}`; params.push(direction); }
        if (category) { where += ` AND mt.category = $${i++}`; params.push(category); }
        if (startDate) { where += ` AND mt.transaction_date >= $${i++}`; params.push(startDate); }
        if (endDate) { where += ` AND mt.transaction_date < ($${i++})::date + INTERVAL '1 day'`; params.push(endDate); }
        if (search) { where += ` AND (mt.description ILIKE $${i} OR mt.payment_method ILIKE $${i})`; params.push(`%${search}%`); i++; }

        const countResult = await db.query(
            `SELECT COUNT(*) FROM money_transactions mt${where}`, params
        );
        const totalCount = parseInt(countResult.rows[0].count);

        const totalsResult = await db.query(
            `SELECT COALESCE(SUM(CASE WHEN mt.direction = 'IN' THEN mt.amount ELSE 0 END), 0) AS total_in,
                    COALESCE(SUM(CASE WHEN mt.direction = 'OUT' THEN mt.amount ELSE 0 END), 0) AS total_out
             FROM money_transactions mt${where}`,
            params
        );

        const offset = (page - 1) * limit;
        const result = await db.query(
            `SELECT mt.*, ma.name AS account_name, ma.account_type,
                    u.fullname AS recorded_by_name
             FROM money_transactions mt
             JOIN money_accounts ma ON mt.account_id = ma.id
             LEFT JOIN users u ON mt.recorded_by = u.id
             ${where}
             ORDER BY mt.transaction_date DESC, mt.id DESC
             LIMIT $${i} OFFSET $${i + 1}`,
            [...params, parseInt(limit), offset]
        );

        res.status(200).json({
            transactions: result.rows,
            totals: totalsResult.rows[0],
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                totalCount,
                totalPages: Math.ceil(totalCount / limit)
            }
        });
    } catch (error) {
        console.error('Error fetching money transactions:', error);
        res.status(500).json({ error: 'Failed to fetch transactions.', details: error.message });
    }
});

// POST /api/money/transactions - manual cash/bank in or out
router.post('/transactions', async (req, res) => {
    const {
        account_id, direction, amount, category,
        description, payment_method, transaction_date
    } = req.body;

    const amt = parseFloat(amount);
    if (!account_id || !['IN', 'OUT'].includes(direction) || !Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: 'account_id, direction (IN/OUT) and a positive amount are required.' });
    }
    const validKeys = (MONEY_CATEGORIES[direction] || []).map(c => c.key);
    if (!category || !validKeys.includes(category)) {
        return res.status(400).json({ error: `category must be one of: ${validKeys.join(', ')}` });
    }

    try {
        const account = await db.query(
            'SELECT id FROM money_accounts WHERE id = $1 AND is_active = true', [account_id]
        );
        if (account.rows.length === 0) {
            return res.status(404).json({ error: 'Account not found or inactive.' });
        }

        const txn = await recordMoneyTransaction({
            account_id,
            direction,
            amount: amt,
            category,
            description: description || null,
            payment_method: payment_method || null,
            transaction_date: transaction_date || null,
            recorded_by: req.user.id,
            approval_request_id: req.approvalBypassId || null
        });
        if (!txn) throw new Error('Failed to record the transaction.');

        res.status(201).json(txn);
    } catch (error) {
        console.error('Error creating money transaction:', error);
        res.status(500).json({ error: 'Failed to record transaction.', details: error.message });
    }
});

// POST /api/money/transfer - move money between accounts (two linked legs, atomic)
router.post('/transfer', async (req, res) => {
    const { from_account_id, to_account_id, amount, description, transaction_date } = req.body;
    const amt = parseFloat(amount);

    if (!from_account_id || !to_account_id || from_account_id === to_account_id) {
        return res.status(400).json({ error: 'Two different accounts are required.' });
    }
    if (!Number.isFinite(amt) || amt <= 0) {
        return res.status(400).json({ error: 'A positive amount is required.' });
    }

    const client = await db.pool.connect();
    try {
        const accounts = await db.query(
            'SELECT id, name FROM money_accounts WHERE id = ANY($1) AND is_active = true',
            [[from_account_id, to_account_id]]
        );
        if (accounts.rows.length !== 2) {
            return res.status(404).json({ error: 'One or both accounts not found or inactive.' });
        }
        const fromName = accounts.rows.find(a => a.id === parseInt(from_account_id))?.name;
        const toName = accounts.rows.find(a => a.id === parseInt(to_account_id))?.name;

        await client.query('BEGIN');
        const outLeg = await recordMoneyTransaction({
            client,
            account_id: from_account_id,
            direction: 'OUT',
            amount: amt,
            category: 'transfer',
            description: description || `Transfer to ${toName}`,
            transaction_date: transaction_date || null,
            recorded_by: req.user.id,
            approval_request_id: req.approvalBypassId || null
        });
        if (!outLeg) throw new Error('Failed to record the outgoing leg.');

        const inLeg = await recordMoneyTransaction({
            client,
            account_id: to_account_id,
            direction: 'IN',
            amount: amt,
            category: 'transfer',
            transfer_pair_id: outLeg.id,
            description: description || `Transfer from ${fromName}`,
            transaction_date: transaction_date || null,
            recorded_by: req.user.id,
            approval_request_id: req.approvalBypassId || null
        });
        if (!inLeg) throw new Error('Failed to record the incoming leg.');

        await client.query('UPDATE money_transactions SET transfer_pair_id = $1 WHERE id = $2', [inLeg.id, outLeg.id]);
        await client.query('COMMIT');

        res.status(201).json({ out: outLeg, in: inLeg });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('Error transferring money:', error);
        res.status(500).json({ error: 'Failed to transfer.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/money/summary - dashboard numbers for a period (default: this month)
router.get('/summary', async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const params = [];
        let dateWhere = `mt.transaction_date >= DATE_TRUNC('month', CURRENT_DATE)`;
        if (startDate && endDate) {
            dateWhere = `mt.transaction_date >= $1 AND mt.transaction_date < ($2)::date + INTERVAL '1 day'`;
            params.push(startDate, endDate);
        }

        const [totals, byCategory, byAccount, daily] = await Promise.all([
            db.query(
                `SELECT COALESCE(SUM(CASE WHEN mt.direction = 'IN' THEN mt.amount ELSE 0 END), 0) AS total_in,
                        COALESCE(SUM(CASE WHEN mt.direction = 'OUT' THEN mt.amount ELSE 0 END), 0) AS total_out,
                        COUNT(*) AS transaction_count
                 FROM money_transactions mt WHERE ${dateWhere}`,
                params
            ),
            db.query(
                `SELECT mt.direction, mt.category,
                        COUNT(*) AS count, SUM(mt.amount) AS total
                 FROM money_transactions mt WHERE ${dateWhere}
                 GROUP BY mt.direction, mt.category
                 ORDER BY total DESC`,
                params
            ),
            db.query(
                `SELECT ma.id, ma.name, ma.account_type, ma.current_balance,
                        COALESCE(SUM(CASE WHEN mt.direction = 'IN' THEN mt.amount ELSE 0 END), 0) AS period_in,
                        COALESCE(SUM(CASE WHEN mt.direction = 'OUT' THEN mt.amount ELSE 0 END), 0) AS period_out
                 FROM money_accounts ma
                 LEFT JOIN money_transactions mt ON mt.account_id = ma.id AND ${dateWhere}
                 WHERE ma.is_active = true
                 GROUP BY ma.id
                 ORDER BY ma.account_type, ma.name`,
                params
            ),
            db.query(
                `SELECT DATE(mt.transaction_date) AS day,
                        COALESCE(SUM(CASE WHEN mt.direction = 'IN' THEN mt.amount ELSE 0 END), 0) AS total_in,
                        COALESCE(SUM(CASE WHEN mt.direction = 'OUT' THEN mt.amount ELSE 0 END), 0) AS total_out
                 FROM money_transactions mt WHERE ${dateWhere}
                 GROUP BY DATE(mt.transaction_date)
                 ORDER BY day`,
                params
            )
        ]);

        const t = totals.rows[0];
        res.status(200).json({
            total_in: t.total_in,
            total_out: t.total_out,
            net: parseFloat(t.total_in) - parseFloat(t.total_out),
            transaction_count: parseInt(t.transaction_count),
            by_category: byCategory.rows,
            accounts: byAccount.rows,
            daily: daily.rows
        });
    } catch (error) {
        console.error('Error fetching money summary:', error);
        res.status(500).json({ error: 'Failed to fetch summary.', details: error.message });
    }
});

module.exports = router;
