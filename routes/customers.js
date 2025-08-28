const express = require('express');
const router = express.Router();
const db = require('../db/db');

// GET /api/customers - Fetch all customers
router.get('/', async (req, res) => {
    try {
        const result = await db.pool.query('SELECT * FROM customers ORDER BY fullname ASC');
        res.status(200).json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch customers.', details: error.message });
    }
});

// GET /api/customers/:id - Fetch a single customer by ID ⬅️ Added this route
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.pool.query('SELECT * FROM customers WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Customer not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching customer:', error);
        res.status(500).json({ error: 'Failed to fetch customer.', details: error.message });
    }
});

// POST /api/customers - Create a new customer
router.post('/', async (req, res) => {
    const { fullname, email, phone, gender, address, credit_limit, due_date, is_active } = req.body;
    try {
        const result = await db.pool.query(
            'INSERT INTO customers (fullname, email, phone, gender, address, credit_limit, due_date, is_active) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [fullname, email, phone, gender, address, credit_limit || 0, due_date, is_active ?? true]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to create customer.', details: error.message });
    }
});

// PUT /api/customers/:id - Update an existing customer
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { fullname, email, phone, gender, address, credit_limit, due_date, is_active } = req.body;
    try {
        const result = await db.pool.query(
            'UPDATE customers SET fullname = $1, email = $2, phone = $3, gender = $4, address = $5, credit_limit = $6, due_date = $7, is_active = $8, updated_at = NOW() WHERE id = $9 RETURNING *',
            [fullname, email, phone, gender, address, credit_limit, due_date, is_active, id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Customer not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating customer:', error);
        res.status(500).json({ error: 'Failed to update customer.', details: error.message });
    }
});


// DELETE /api/customers/:id - Delete a customer
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.pool.query('DELETE FROM customers WHERE id = $1 RETURNING *', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Customer not found.' });
        }
        res.status(200).json({ message: 'Customer deleted successfully.' });
    } catch (error) {
        console.error('Error deleting customer:', error);
        res.status(500).json({ error: 'Failed to delete customer.', details: error.message });
    }
});

// POST /api/customers/:id/pay - Record a payment against a customer's balance
router.post('/:id/pay', async (req, res) => {
    const { id } = req.params;
    const { amount } = req.body;

    if (!amount || amount <= 0) {
        return res.status(400).json({ error: 'Invalid payment amount.' });
    }

    try {
        const result = await db.pool.query(
            'UPDATE customers SET balance = GREATEST(0, balance - $1) WHERE id = $2 RETURNING *',
            [amount, id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Customer not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error recording payment:', error);
        res.status(500).json({ error: 'Failed to record payment.', details: error.message });
    }
});

module.exports = router;