// routes/payments.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const authenticate = require('../middleware/authenticate');
const { recordMoneyTransaction } = require('../utils/money');

// ---------------------------------------------------------------------------
// Wallet schema guard (advance_balance columns + wallet_transactions table are
// created by migration 002; features degrade gracefully until it is applied)
// ---------------------------------------------------------------------------
let walletSchemaReady = null;
async function ensureWalletSchema() {
    if (walletSchemaReady !== null) return walletSchemaReady;
    try {
        const r = await db.query(`
            SELECT
              (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'customers' AND column_name = 'advance_balance') AS c_col,
              (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'riders' AND column_name = 'advance_balance') AS r_col,
              (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'wallet_transactions') AS w_tbl
        `);
        const row = r.rows[0];
        walletSchemaReady = Number(row.c_col) > 0 && Number(row.r_col) > 0 && Number(row.w_tbl) > 0;
    } catch (e) {
        walletSchemaReady = false;
    }
    return walletSchemaReady;
}

// POST /api/payments - Record a payment against a specific sale
router.post('/', async (req, res) => {
    const { transaction_id, customer_id, amount, payment_date, payment_method, proof } = req.body;

    if (!transaction_id || !customer_id || !amount) {
        return res.status(400).json({ error: 'Transaction ID, Customer ID, and amount are required.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // 1. Insert the new payment record
        const paymentQuery = `
            INSERT INTO payments (transaction_id, customer_id, amount, payment_date, payment_method, proof)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id;
        `;
        const paymentResult = await client.query(paymentQuery, [transaction_id, customer_id, amount, payment_date, payment_method, proof]);
        const newPaymentId = paymentResult.rows[0].id;

        // 2. Update the corresponding sales_transactions record
        const paymentAmount = parseFloat(amount);
        const updateSaleQuery = `
            UPDATE sales_transactions
            SET
                amount_paid = amount_paid + $1,
                balance_due = balance_due - $1,
                status = CASE
                    WHEN balance_due - $1 <= 0 THEN 'Paid'
                    WHEN amount_paid + $1 > 0 THEN 'Partially Paid'
                    ELSE status
                END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2;
        `;
        await client.query(updateSaleQuery, [paymentAmount, transaction_id]);

        // 3. Update the customer's total credit balance
        const updateCustomerQuery = `
            UPDATE customers
            SET balance = balance - $1
            WHERE id = $2;
        `;
        await client.query(updateCustomerQuery, [paymentAmount, customer_id]);

        await client.query('COMMIT');

        // 4. Mirror into Money Management (fail-open)
        await recordMoneyTransaction({
            direction: 'IN',
            amount: paymentAmount,
            category: 'sale_payment',
            payment_method: payment_method || 'Cash',
            reference_type: 'payment',
            reference_id: newPaymentId,
            description: `Payment received for sale #${transaction_id}`,
            transaction_date: payment_date || null,
            recorded_by: req.user ? req.user.id : null,
            approval_id: req.approvalBypassId || null
        });

        res.status(201).json({ message: 'Payment recorded successfully.', paymentId: newPaymentId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error recording payment:', error);
        res.status(500).json({ error: 'Failed to record payment.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/payments/outstanding?customer_id= | ?rider_id=
// Oldest-first list of unpaid sales for a customer or rider + advance balance.
router.get('/outstanding', async (req, res) => {
    const customerId = parseInt(req.query.customer_id);
    const riderId = parseInt(req.query.rider_id);

    if ((isNaN(customerId) || !customerId) && (isNaN(riderId) || !riderId)) {
        return res.status(400).json({ error: 'Provide customer_id or rider_id.' });
    }

    try {
        const walletReady = await ensureWalletSchema();
        let ownerType, ownerId, salesQuery, ownerQuery;

        if (!isNaN(riderId) && riderId) {
            ownerType = 'RIDER';
            ownerId = riderId;
            salesQuery = `
                SELECT id, sale_date, due_date, total_amount, amount_paid, balance_due, status, payment_method
                FROM sales_transactions
                WHERE rider_id = $1 AND is_rider_sale = true AND balance_due > 0
                ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC
            `;
            ownerQuery = walletReady
                ? 'SELECT id, fullname AS name, current_balance, COALESCE(advance_balance, 0) AS advance_balance FROM riders WHERE id = $1'
                : 'SELECT id, fullname AS name, current_balance, 0 AS advance_balance FROM riders WHERE id = $1';
        } else {
            ownerType = 'CUSTOMER';
            ownerId = customerId;
            salesQuery = `
                SELECT id, sale_date, due_date, total_amount, amount_paid, balance_due, status, payment_method
                FROM sales_transactions
                WHERE customer_id = $1 AND balance_due > 0
                ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC
            `;
            ownerQuery = walletReady
                ? 'SELECT id, fullname AS name, balance AS current_balance, COALESCE(advance_balance, 0) AS advance_balance FROM customers WHERE id = $1'
                : 'SELECT id, fullname AS name, balance AS current_balance, 0 AS advance_balance FROM customers WHERE id = $1';
        }

        const [sales, owner] = await Promise.all([
            db.query(salesQuery, [ownerId]),
            db.query(ownerQuery, [ownerId])
        ]);

        if (owner.rows.length === 0) {
            return res.status(404).json({ error: `${ownerType === 'RIDER' ? 'Rider' : 'Customer'} not found.` });
        }

        const totalOutstanding = sales.rows.reduce((sum, s) => sum + parseFloat(s.balance_due), 0);

        res.status(200).json({
            owner_type: ownerType,
            owner: owner.rows[0],
            outstanding_sales: sales.rows,
            total_outstanding: Math.round(totalOutstanding * 100) / 100
        });
    } catch (error) {
        console.error('Error fetching outstanding sales:', error);
        res.status(500).json({ error: 'Failed to fetch outstanding sales.', details: error.message });
    }
});

// POST /api/payments/allocate - Credit payment by AMOUNT (no sale selection).
// Allocates oldest-first across the customer's / rider's unpaid sales.
// Any leftover after clearing all debt is credited to the advance wallet.
router.post('/allocate', authenticate, async (req, res) => {
    const { customer_id, rider_id, amount, payment_method = 'Cash', payment_date, proof, notes } = req.body;

    const customerId = parseInt(customer_id);
    const riderId = parseInt(rider_id);
    const payAmount = parseFloat(amount);

    if ((isNaN(customerId) || !customerId) && (isNaN(riderId) || !riderId)) {
        return res.status(400).json({ error: 'Provide customer_id or rider_id.' });
    }
    if (isNaN(payAmount) || payAmount <= 0) {
        return res.status(400).json({ error: 'A positive payment amount is required.' });
    }

    const isRider = !isNaN(riderId) && !!riderId;
    const ownerType = isRider ? 'RIDER' : 'CUSTOMER';
    const ownerId = isRider ? riderId : customerId;

    const walletReady = await ensureWalletSchema();

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // 1. Lock the owner record
        const ownerTable = isRider ? 'riders' : 'customers';
        const ownerRes = await client.query(`SELECT id FROM ${ownerTable} WHERE id = $1 FOR UPDATE`, [ownerId]);
        if (ownerRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: `${isRider ? 'Rider' : 'Customer'} not found.` });
        }

        // 2. Fetch unpaid sales oldest-first
        const salesQuery = isRider
            ? `SELECT id, balance_due, payment_method FROM sales_transactions
               WHERE rider_id = $1 AND is_rider_sale = true AND balance_due > 0
               ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC FOR UPDATE`
            : `SELECT id, balance_due FROM sales_transactions
               WHERE customer_id = $1 AND balance_due > 0
               ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC FOR UPDATE`;
        const sales = await client.query(salesQuery, [ownerId]);

        // 3. Allocate the amount across sales, oldest first
        let remaining = payAmount;
        const allocations = [];
        for (const sale of sales.rows) {
            if (remaining <= 0) break;
            const due = parseFloat(sale.balance_due);
            const pay = Math.min(remaining, due);
            if (pay <= 0) continue;

            const pmt = await client.query(
                `INSERT INTO payments (transaction_id, customer_id, rider_id, amount, payment_date, payment_method, proof, is_rider_payment)
                 VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_DATE), $6, $7, $8)
                 RETURNING id`,
                [
                    sale.id,
                    isRider ? null : customerId,
                    isRider ? riderId : null,
                    pay,
                    payment_date || null,
                    payment_method,
                    proof || null,
                    isRider
                ]
            );

            await client.query(
                `UPDATE sales_transactions
                 SET amount_paid = amount_paid + $1,
                     balance_due = balance_due - $1,
                     status = CASE
                         WHEN balance_due - $1 <= 0 THEN 'Paid'
                         ELSE 'Partially Paid'
                     END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`,
                [pay, sale.id]
            );

            // Rider remittance against a credit sale also clears the linked customer's balance
            if (isRider && sale.payment_method === 'Credit') {
                await client.query(
                    `UPDATE customers c SET balance = balance - $1
                     FROM sales_transactions s
                     WHERE s.id = $2 AND c.id = s.customer_id`,
                    [pay, sale.id]
                );
            }

            allocations.push({ sale_id: sale.id, payment_id: pmt.rows[0].id, allocated: pay });
            remaining -= pay;
        }

        const allocatedTotal = Math.round((payAmount - remaining) * 100) / 100;

        // 4. Reduce the owner's debt balance
        if (allocatedTotal > 0) {
            if (isRider) {
                await client.query('UPDATE riders SET current_balance = current_balance - $1 WHERE id = $2', [allocatedTotal, riderId]);
            } else {
                await client.query('UPDATE customers SET balance = balance - $1 WHERE id = $2', [allocatedTotal, customerId]);
            }
        }

        // 5. Leftover -> advance wallet (requires migration 002)
        let walletCredit = 0;
        if (remaining > 0.004) {
            if (!walletReady) {
                await client.query('ROLLBACK');
                return res.status(503).json({
                    error: 'Payment exceeds total outstanding debt and the advance-wallet schema is not installed yet. Apply migration 002, or reduce the amount.',
                    total_outstanding: allocatedTotal
                });
            }
            walletCredit = Math.round(remaining * 100) / 100;
            const balRes = await client.query(
                `UPDATE ${ownerTable} SET advance_balance = COALESCE(advance_balance, 0) + $1 WHERE id = $2 RETURNING advance_balance`,
                [walletCredit, ownerId]
            );
            await client.query(
                `INSERT INTO wallet_transactions (owner_type, owner_id, transaction_type, amount, balance_after, reference_type, reference_id, notes, created_by)
                 VALUES ($1, $2, 'DEPOSIT', $3, $4, 'payment_allocation', $5, $6, $7)`,
                [
                    ownerType,
                    ownerId,
                    walletCredit,
                    balRes.rows[0].advance_balance,
                    allocations.length ? allocations[0].payment_id : null,
                    notes || 'Overpayment from credit settlement credited to advance wallet',
                    req.user.id
                ]
            );
        }

        await client.query('COMMIT');

        // 6. Money Management mirror (fail-open)
        if (allocatedTotal > 0) {
            await recordMoneyTransaction({
                direction: 'IN',
                amount: allocatedTotal,
                category: 'debt_payment',
                payment_method,
                reference_type: 'payment_allocation',
                reference_id: allocations.length ? allocations[0].payment_id : null,
                description: `${isRider ? 'Rider' : 'Customer'} debt settlement auto-allocated across ${allocations.length} sale(s)`,
                transaction_date: payment_date || null,
                recorded_by: req.user.id,
                approval_id: req.approvalBypassId || null
            });
        }
        if (walletCredit > 0) {
            await recordMoneyTransaction({
                direction: 'IN',
                amount: walletCredit,
                category: isRider ? 'rider_deposit' : 'customer_deposit',
                payment_method,
                reference_type: 'payment_allocation',
                reference_id: null,
                description: `Advance wallet top-up from ${isRider ? 'rider' : 'customer'} overpayment`,
                transaction_date: payment_date || null,
                recorded_by: req.user.id,
                approval_id: req.approvalBypassId || null
            });
        }

        res.status(201).json({
            message: walletCredit > 0
                ? `Payment allocated: NGN ${allocatedTotal.toFixed(2)} cleared debt, NGN ${walletCredit.toFixed(2)} credited to advance wallet.`
                : `Payment allocated across ${allocations.length} sale(s), oldest first.`,
            total_amount: payAmount,
            allocated: allocatedTotal,
            wallet_credit: walletCredit,
            allocations
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error allocating payment:', error);
        res.status(500).json({ error: 'Failed to allocate payment.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/payments - Get all payment records
router.get('/', async (req, res) => {
    const { customerId, transactionId, startDate, endDate, paymentMethod } = req.query;

    let query = `
        SELECT
            p.id,
            p.amount,
            p.payment_date,
            p.payment_method,
            p.proof,
            st.id as transaction_id,
            c.fullname as customer_name
        FROM payments p
        JOIN sales_transactions st ON p.transaction_id = st.id
        JOIN customers c ON p.customer_id = c.id
    `;

    const whereClauses = [];
    const queryParams = [];
    let paramIndex = 1;

    if (customerId) {
        whereClauses.push(`p.customer_id = $${paramIndex++}`);
        queryParams.push(customerId);
    }
    if (transactionId) {
        whereClauses.push(`p.transaction_id = $${paramIndex++}`);
        queryParams.push(transactionId);
    }
    if (startDate) {
        whereClauses.push(`p.payment_date >= $${paramIndex++}`);
        queryParams.push(startDate);
    }
    if (endDate) {
        whereClauses.push(`p.payment_date <= $${paramIndex++}`);
        queryParams.push(endDate);
    }
    if (paymentMethod) {
        whereClauses.push(`p.payment_method = $${paramIndex++}`);
        queryParams.push(paymentMethod);
    }

    if (whereClauses.length > 0) {
        query += ' WHERE ' + whereClauses.join(' AND ');
    }

    query += ' ORDER BY p.payment_date DESC, p.id DESC;';

    try {
        const result = await db.query(query, queryParams);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching payments:', error);
        res.status(500).json({ error: 'Failed to fetch payments.' });
    }
});

// GET /api/payments/customer/:customerId
router.get('/customer/:customerId', async (req, res) => {
    const { customerId } = req.params;
    try {
        const query = `
            SELECT
                p.id,
                p.amount,
                p.payment_date,
                p.payment_method,
                p.proof,
                st.id as transaction_id,
                c.fullname as customer_name
            FROM payments p
            JOIN sales_transactions st ON p.transaction_id = st.id
            JOIN customers c ON p.customer_id = c.id
            WHERE p.customer_id = $1
            ORDER BY p.payment_date DESC, p.id DESC;
        `;
        const result = await db.query(query, [customerId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error(`Error fetching payments for customer ${customerId}:`, error);
        res.status(500).json({ error: 'Failed to fetch payments for customer.' });
    }
});

// GET /api/payments/rider/:riderId - Get payment history for a specific rider
router.get('/rider/:riderId', authenticate, async (req, res) => {
    const { riderId } = req.params;
    try {
        const query = `
            SELECT
                p.id,
                p.amount,
                p.payment_date,
                p.payment_method,
                st.id as transaction_id,
                c.fullname as customer_name
            FROM payments p
            JOIN sales_transactions st ON p.transaction_id = st.id
            JOIN customers c ON p.customer_id = c.id
            WHERE p.rider_id = $1
            ORDER BY p.payment_date DESC, p.id DESC;
        `;
        const result = await db.query(query, [riderId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error(`Error fetching payments for rider ${riderId}:`, error);
        res.status(500).json({ error: 'Failed to fetch payments for rider.' });
    }
});

// GET /api/payments/rider/:riderId/outstanding - Get outstanding sales for a rider
router.get('/rider/:riderId/outstanding', async (req, res) => {
    const { riderId } = req.params;
    try {
        const query = `
            SELECT id, due_date, balance_due
            FROM sales_transactions
            WHERE rider_id = $1 AND is_rider_sale = true AND balance_due > 0
            ORDER BY due_date ASC, sale_date ASC;
        `;
        const result = await db.query(query, [riderId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error(`Error fetching outstanding sales for rider ${riderId}:`, error);
        res.status(500).json({ error: 'Failed to fetch outstanding sales for rider.' });
    }
});

// POST /api/payments/rider - Record a rider payment against a specific sale
router.post('/rider', async (req, res) => {
    const { transaction_id, rider_id, amount, payment_date, payment_method } = req.body;

    if (!transaction_id || !rider_id || !amount) {
        return res.status(400).json({ error: 'Transaction ID, Rider ID, and amount are required.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const saleResult = await client.query('SELECT * FROM sales_transactions WHERE id = $1', [transaction_id]);
        if (saleResult.rows.length === 0) {
            throw new Error('Sale transaction not found.');
        }
        const sale = saleResult.rows[0];
        const paymentAmount = parseFloat(amount);

        if (paymentAmount > sale.balance_due) {
            return res.status(400).json({ error: 'Payment amount cannot be greater than the balance due.' });
        }

        const paymentQuery = `
            INSERT INTO payments (transaction_id, rider_id, customer_id, amount, payment_date, payment_method, is_rider_payment)
            VALUES ($1, $2, $3, $4, $5, $6, true)
            RETURNING id;
        `;
        const paymentResult = await client.query(paymentQuery, [transaction_id, rider_id, sale.customer_id, paymentAmount, payment_date, payment_method]);
        const newPaymentId = paymentResult.rows[0].id;

        const newBalanceDue = sale.balance_due - paymentAmount;
        const newStatus = newBalanceDue <= 0 ? 'Paid' : 'Partially Paid';

        const updateSaleQuery = `
            UPDATE sales_transactions
            SET amount_paid = amount_paid + $1, balance_due = $2, status = $3, updated_at = CURRENT_TIMESTAMP
            WHERE id = $4;
        `;
        await client.query(updateSaleQuery, [paymentAmount, newBalanceDue, newStatus, transaction_id]);

        const updateRiderQuery = `
            UPDATE riders
            SET current_balance = current_balance - $1
            WHERE id = $2;
        `;
        await client.query(updateRiderQuery, [paymentAmount, rider_id]);

        if (sale.payment_method === 'Credit') {
            const updateCustomerQuery = `
                UPDATE customers
                SET balance = balance - $1
                WHERE id = $2;
            `;
            await client.query(updateCustomerQuery, [paymentAmount, sale.customer_id]);
        }

        const historyQuery = `
            INSERT INTO rider_payment_history (rider_id, amount, payment_date)
            VALUES ($1, $2, $3);
        `;
        await client.query(historyQuery, [rider_id, paymentAmount, payment_date]);

        await client.query('COMMIT');

        // Money Management mirror (fail-open)
        await recordMoneyTransaction({
            direction: 'IN',
            amount: paymentAmount,
            category: 'sale_payment',
            payment_method: payment_method || 'Cash',
            reference_type: 'rider_payment',
            reference_id: newPaymentId,
            description: `Rider remittance for sale #${transaction_id}`,
            transaction_date: payment_date || null,
            recorded_by: req.user ? req.user.id : null,
            approval_id: req.approvalBypassId || null
        });

        res.status(201).json({ message: 'Rider payment recorded successfully.', paymentId: newPaymentId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error recording rider payment:', error);
        res.status(500).json({ error: 'Failed to record rider payment.', details: error.message });
    } finally {
        client.release();
    }
});

module.exports = router;
