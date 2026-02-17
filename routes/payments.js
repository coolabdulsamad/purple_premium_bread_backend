// purple-premium-bread-api/routes/payments.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { jwtDecode } = require('jwt-decode'); // For getting user ID from token
const authenticate = require('../middleware/authenticate');

// Helper to get user ID from token (if token is sent in headers)
const getUserIdFromToken = (req) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) {
            const decoded = jwtDecode(token);
            return decoded.id;
        }
    } catch (e) {
        console.error("Failed to decode token for payment transaction", e);
    }
    return null;
};

// POST /api/payments - Record a new payment against a sales transaction (especially credit sales)
router.post('/', async (req, res) => {
    const {
        transaction_id,
        customer_id,
        amount,
        payment_method,
        proof, // Payment proof can be a reference number or image URL
        recorded_by_user_id // The user who is recording this payment
    } = req.body;

    // Validate essential fields
    if (!transaction_id || !customer_id || !amount || amount <= 0) {
        return res.status(400).json({ error: 'Missing required payment details: transaction_id, customer_id, and a positive amount are required.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Insert the new payment record
        const paymentInsertQuery = `
            INSERT INTO payments (transaction_id, customer_id, amount, payment_date, payment_method, proof)
            VALUES ($1, $2, $3, NOW(), $4, $5)
            RETURNING *;
        `;
        const paymentResult = await client.query(paymentInsertQuery, [
            transaction_id,
            customer_id,
            amount,
            payment_method || 'Cash', // Default to Cash if not provided
            proof
        ]);
        const newPayment = paymentResult.rows[0];

        // 2. Update the sales_transaction status, amount_paid, and balance_due
        const transactionUpdateQuery = `
            UPDATE sales_transactions
            SET
                amount_paid = amount_paid + $1,
                balance_due = balance_due - $1,
                status = CASE WHEN (balance_due - $1) <= 0 THEN 'Paid' ELSE 'Partially Paid' END,
                updated_at = NOW() -- Assuming an updated_at column on sales_transactions
            WHERE id = $2
            RETURNING amount_paid, balance_due, status;
        `;
        const transactionUpdateResult = await client.query(transactionUpdateQuery, [amount, transaction_id]);

        if (transactionUpdateResult.rows.length === 0) {
            throw new Error('Sales transaction not found or already fully paid.');
        }

        const updatedTransaction = transactionUpdateResult.rows[0];

        // 3. Update the customer's overall balance
        const customerUpdateQuery = `
            UPDATE customers
            SET
                balance = balance - $1,
                updated_at = NOW()
            WHERE id = $2
            RETURNING balance;
        `;
        const customerUpdateResult = await client.query(customerUpdateQuery, [amount, customer_id]);

        if (customerUpdateResult.rows.length === 0) {
            throw new Error('Customer not found.');
        }

        await client.query('COMMIT');
        res.status(201).json({
            message: 'Payment recorded successfully.',
            payment: newPayment,
            updatedTransaction: updatedTransaction,
            updatedCustomerBalance: customerUpdateResult.rows[0].balance
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error recording payment:', error);
        res.status(500).json({ error: 'Failed to record payment.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/payments - Fetch all payments with optional filters
router.get('/', async (req, res) => {
    const { customerId, transactionId, startDate, endDate, paymentMethod } = req.query;
    let query = `
        SELECT
            py.id,
            py.transaction_id,
            py.customer_id,
            c.fullname AS customer_name,
            py.amount,
            py.payment_date,
            py.payment_method,
            py.proof,
            st.total_amount AS sales_total_amount,
            st.balance_due AS sales_balance_before_payment -- This will be the current balance from sales_transactions
        FROM payments py
        JOIN customers c ON py.customer_id = c.id
        JOIN sales_transactions st ON py.transaction_id = st.id
        WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (customerId) {
        query += ` AND py.customer_id = $${paramIndex++}`;
        params.push(customerId);
    }
    if (transactionId) {
        query += ` AND py.transaction_id = $${paramIndex++}`;
        params.push(transactionId);
    }
    if (startDate) {
        query += ` AND py.payment_date >= $${paramIndex++}`;
        params.push(startDate);
    }
    if (endDate) {
        query += ` AND py.payment_date <= $${paramIndex++}`;
        params.push(endDate);
    }
    if (paymentMethod) {
        query += ` AND py.payment_method ILIKE $${paramIndex++}`;
        params.push(`%${paymentMethod}%`);
    }

    query += ` ORDER BY py.payment_date DESC, py.id DESC`;

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching payments:', error);
        res.status(500).json({ error: 'Failed to fetch payments.', details: error.message });
    }
});

// GET /api/payments/customer/:customerId - Fetch all payments for a specific customer
router.get('/customer/:customerId', async (req, res) => {
    const { customerId } = req.params;
    try {
        const result = await db.query(
            `SELECT
                py.id,
                py.transaction_id,
                py.customer_id,
                c.fullname AS customer_name,
                py.amount,
                py.payment_date,
                py.payment_method,
                py.proof,
                st.total_amount AS sales_total_amount,
                st.balance_due AS sales_balance_due_at_payment_time -- This needs care, as balance_due changes.
                                                                    -- For historical view, better to capture transaction's state at time of payment.
                                                                    -- For now, it will show current balance_due of the transaction.
            FROM payments py
            JOIN customers c ON py.customer_id = c.id
            JOIN sales_transactions st ON py.transaction_id = st.id
            WHERE py.customer_id = $1
            ORDER BY py.payment_date DESC, py.id DESC;`,
            [customerId]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching customer payments:', error);
        res.status(500).json({ error: 'Failed to fetch customer payments.', details: error.message });
    }
});

// Add to payments.js backend route file

// GET /api/payments/rider/:riderId - Get payment history for a rider (FIXED)
router.get('/rider/:riderId', authenticate, async (req, res) => {
    const { riderId } = req.params;

    try {
        const query = `
            SELECT 
                p.*,
                st.total_amount as sale_total,
                st.status as sale_status,
                st.balance_due as current_balance_due,
                c.fullname as customer_name,
                r.fullname as rider_name
            FROM payments p
            LEFT JOIN sales_transactions st ON p.transaction_id = st.id
            LEFT JOIN customers c ON p.customer_id = c.id
            LEFT JOIN riders r ON p.rider_id = r.id
            WHERE p.rider_id = $1
            ORDER BY p.payment_date DESC
        `;

        const result = await db.query(query, [riderId]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching rider payments:', error);
        res.status(500).json({ error: 'Failed to fetch payment history', details: error.message });
    }
});

// GET /api/sales/rider/:riderId/outstanding - Get outstanding sales for a rider (FIXED)
router.get('/rider/:riderId/outstanding', authenticate, async (req, res) => {
    const { riderId } = req.params;

    try {
        const query = `
            SELECT 
                id,
                total_amount,
                amount_paid,
                balance_due,
                sale_date,
                due_date,
                status,
                payment_method
            FROM sales_transactions
            WHERE rider_id = $1 AND is_rider_sale = true AND balance_due > 0
            ORDER BY due_date ASC, sale_date ASC
        `;

        const result = await db.query(query, [riderId]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching outstanding rider sales:', error);
        res.status(500).json({ error: 'Failed to fetch outstanding sales', details: error.message });
    }
});

// POST /api/payments/rider - Record a payment for a rider (FIXED to also update customer balance)
router.post('/rider', authenticate, async (req, res) => {
    const {
        transaction_id,
        rider_id,
        amount,
        payment_method,
        proof
    } = req.body;

    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        // First, get the rider's customer_id
        const riderQuery = await client.query(
            `SELECT customer_id, fullname, current_balance 
             FROM riders 
             WHERE id = $1`,
            [rider_id]
        );

        if (riderQuery.rows.length === 0) {
            throw new Error('Rider not found');
        }

        const rider = riderQuery.rows[0];
        const customerId = rider.customer_id;

        if (!customerId) {
            throw new Error('Rider has no associated customer record');
        }

        // Get the transaction details to verify
        const transactionQuery = await client.query(
            `SELECT id, total_amount, amount_paid, balance_due, customer_id 
             FROM sales_transactions 
             WHERE id = $1 AND rider_id = $2`,
            [transaction_id, rider_id]
        );

        if (transactionQuery.rows.length === 0) {
            throw new Error('Transaction not found or does not belong to this rider');
        }

        const transaction = transactionQuery.rows[0];

        // Validate payment amount
        if (amount > transaction.balance_due) {
            throw new Error(`Payment amount (₦${amount}) exceeds balance due (₦${transaction.balance_due})`);
        }

        // Insert payment record with ALL required fields (including customer_id)
        const paymentQuery = `
            INSERT INTO payments (
                transaction_id, 
                customer_id, 
                rider_id, 
                amount, 
                payment_method, 
                proof, 
                payment_date,
                is_rider_payment
            )
            VALUES ($1, $2, $3, $4, $5, $6, NOW(), true)
            RETURNING *
        `;

        const paymentResult = await client.query(paymentQuery, [
            transaction_id,
            customerId,
            rider_id,
            amount,
            payment_method,
            proof || null
        ]);

        // Update the sales transaction
        const updateSaleQuery = `
            UPDATE sales_transactions
            SET amount_paid = amount_paid + $1,
                balance_due = balance_due - $1,
                status = CASE 
                    WHEN balance_due - $1 <= 0 THEN 'Paid'
                    WHEN amount_paid + $1 > 0 THEN 'Partially Paid'
                    ELSE status
                END,
                updated_at = NOW()
            WHERE id = $2
            RETURNING *
        `;

        const saleResult = await client.query(updateSaleQuery, [amount, transaction_id]);

        // Update rider's current balance
        const updateRiderQuery = `
            UPDATE riders
            SET current_balance = current_balance - $1,
                updated_at = NOW()
            WHERE id = $2
            RETURNING current_balance
        `;

        const riderUpdateResult = await client.query(updateRiderQuery, [amount, rider_id]);

        // CRITICAL FIX: Also update the associated customer's balance
        const updateCustomerQuery = `
            UPDATE customers
            SET balance = balance - $1,
                updated_at = NOW()
            WHERE id = $2
            RETURNING balance
        `;

        const customerUpdateResult = await client.query(updateCustomerQuery, [amount, customerId]);

        console.log('Customer balance updated from', 
            parseFloat(customerUpdateResult.rows[0].balance) + parseFloat(amount), 
            'to', customerUpdateResult.rows[0].balance);

        // Insert into rider_payment_history for tracking
        const historyQuery = `
            INSERT INTO rider_payment_history (
                rider_id, 
                payment_id, 
                amount, 
                payment_date, 
                payment_method, 
                notes, 
                recorded_by
            )
            VALUES ($1, $2, $3, NOW(), $4, $5, $6)
        `;

        await client.query(historyQuery, [
            rider_id,
            paymentResult.rows[0].id,
            amount,
            payment_method,
            `Payment for transaction #${transaction_id}`,
            req.user.id
        ]);

        await client.query('COMMIT');

        res.status(201).json({
            message: 'Payment recorded successfully',
            payment: paymentResult.rows[0],
            updated_sale: saleResult.rows[0],
            new_rider_balance: riderUpdateResult.rows[0].current_balance,
            new_customer_balance: customerUpdateResult.rows[0].balance // Include customer balance in response
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error recording rider payment:', error);
        res.status(500).json({ 
            error: 'Failed to record payment', 
            details: error.message 
        });
    } finally {
        client.release();
    }
});

module.exports = router;
