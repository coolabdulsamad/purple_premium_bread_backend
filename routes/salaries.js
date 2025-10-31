// routes/salaries.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// GET /api/salaries/staff - Get all staff with salary information
router.get('/staff', async (req, res) => {
    try {
        const query = `
            SELECT 
                u.id, u.username, u.fullname, u.email, u.phone_number, u.role, u.is_active,
                COALESCE(ss.base_salary, 0) as base_salary,
                COALESCE(ss.allowances, 0) as allowances,
                COALESCE(ss.deductions, 0) as deductions,
                COALESCE(ss.net_salary, 0) as net_salary,
                ss.salary_type,
                ss.bank_name,
                ss.account_number,
                ss.tax_rate,
                ss.pension_rate,
                ss.is_active as salary_active,
                (SELECT COUNT(*) FROM salary_payments sp WHERE sp.user_id = u.id AND sp.status = 'paid') as total_payments,
                (SELECT MAX(payment_date) FROM salary_payments sp WHERE sp.user_id = u.id AND sp.status = 'paid') as last_payment_date
            FROM users u
            LEFT JOIN staff_salaries ss ON u.id = ss.user_id AND ss.is_active = true
            WHERE u.is_active = true
            ORDER BY u.role, u.fullname
        `;

        const result = await db.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching staff salaries:', error);
        res.status(500).json({ error: 'Failed to fetch staff salaries.', details: error.message });
    }
});

// GET /api/salaries/payments - Get all salary payments with filters
router.get('/payments', async (req, res) => {
    try {
        const {
            userId,
            startDate,
            endDate,
            status,
            paymentMethod,
            page = 1,
            limit = 50
        } = req.query;

        let query = `
            SELECT 
                sp.*,
                u.fullname as staff_name,
                u.role as staff_role,
                paid_by_user.fullname as paid_by_name
            FROM salary_payments sp
            JOIN users u ON sp.user_id = u.id
            LEFT JOIN users paid_by_user ON sp.paid_by = paid_by_user.id
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 1;

        if (userId) {
            query += ` AND sp.user_id = $${paramCount}`;
            params.push(userId);
            paramCount++;
        }

        if (startDate) {
            query += ` AND sp.payment_date >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
        }

        if (endDate) {
            query += ` AND sp.payment_date <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
        }

        if (status) {
            query += ` AND sp.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }

        if (paymentMethod) {
            query += ` AND sp.payment_method = $${paramCount}`;
            params.push(paymentMethod);
            paramCount++;
        }

        // Get total count
        const countQuery = `SELECT COUNT(*) FROM (${query}) as count_query`;
        const countResult = await db.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].count);

        // Add ordering and pagination
        query += ` ORDER BY sp.payment_date DESC, sp.created_at DESC`;
        
        const offset = (page - 1) * limit;
        query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        params.push(parseInt(limit), offset);

        const result = await db.query(query, params);

        // Get summary statistics
        const summaryQuery = `
            SELECT 
                COUNT(*) as total_payments,
                SUM(net_amount) as total_paid,
                AVG(net_amount) as average_payment,
                MIN(payment_date) as first_payment,
                MAX(payment_date) as last_payment
            FROM salary_payments
            WHERE 1=1
            ${userId ? ` AND user_id = ${userId}` : ''}
            ${status ? ` AND status = '${status}'` : ''}
        `;

        const summaryResult = await db.query(summaryQuery);

        res.status(200).json({
            payments: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                totalCount,
                totalPages: Math.ceil(totalCount / limit)
            },
            summary: summaryResult.rows[0]
        });

    } catch (error) {
        console.error('Error fetching salary payments:', error);
        res.status(500).json({ error: 'Failed to fetch salary payments.', details: error.message });
    }
});

// GET /api/salaries/payments/:id - Get single payment details with components
router.get('/payments/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const paymentQuery = `
            SELECT 
                sp.*,
                u.fullname as staff_name,
                u.role as staff_role,
                u.email as staff_email,
                u.phone_number as staff_phone,
                paid_by_user.fullname as paid_by_name
            FROM salary_payments sp
            JOIN users u ON sp.user_id = u.id
            LEFT JOIN users paid_by_user ON sp.paid_by = paid_by_user.id
            WHERE sp.id = $1
        `;

        const componentsQuery = `
            SELECT * FROM salary_components 
            WHERE salary_payment_id = $1 
            ORDER BY component_type, amount DESC
        `;

        const [paymentResult, componentsResult] = await Promise.all([
            db.query(paymentQuery, [id]),
            db.query(componentsQuery, [id])
        ]);

        if (paymentResult.rows.length === 0) {
            return res.status(404).json({ error: 'Salary payment not found.' });
        }

        const paymentDetails = {
            ...paymentResult.rows[0],
            components: componentsResult.rows
        };

        res.status(200).json(paymentDetails);
    } catch (error) {
        console.error('Error fetching payment details:', error);
        res.status(500).json({ error: 'Failed to fetch payment details.', details: error.message });
    }
});

// POST /api/salaries/staff/:id/salary - Update staff salary structure
router.post('/staff/:id/salary', async (req, res) => {
    const { id } = req.params;
    const {
        base_salary,
        allowances,
        deductions,
        salary_type,
        bank_name,
        account_number,
        tax_rate,
        pension_rate
    } = req.body;

    try {
        // Calculate net salary
        const netSalary = parseFloat(base_salary) + parseFloat(allowances || 0) - parseFloat(deductions || 0);

        const query = `
            INSERT INTO staff_salaries (
                user_id, base_salary, allowances, deductions, net_salary,
                salary_type, bank_name, account_number, tax_rate, pension_rate
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (user_id) 
            DO UPDATE SET
                base_salary = EXCLUDED.base_salary,
                allowances = EXCLUDED.allowances,
                deductions = EXCLUDED.deductions,
                net_salary = EXCLUDED.net_salary,
                salary_type = EXCLUDED.salary_type,
                bank_name = EXCLUDED.bank_name,
                account_number = EXCLUDED.account_number,
                tax_rate = EXCLUDED.tax_rate,
                pension_rate = EXCLUDED.pension_rate,
                updated_at = CURRENT_TIMESTAMP
            RETURNING *
        `;

        const result = await db.query(query, [
            id, base_salary, allowances, deductions, netSalary,
            salary_type, bank_name, account_number, tax_rate, pension_rate
        ]);

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating staff salary:', error);
        res.status(500).json({ error: 'Failed to update staff salary.', details: error.message });
    }
});

// POST /api/salaries/payments - Process salary payment
router.post('/payments', async (req, res) => {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        const {
            user_id,
            salary_period,
            payment_date,
            base_salary,
            allowances = 0,
            deductions = 0,
            tax_amount = 0,
            pension_amount = 0,
            payment_method,
            payment_reference,
            paid_by,
            notes,
            components = []
        } = req.body;

        // Calculate net amount
        const netAmount = parseFloat(base_salary) + parseFloat(allowances) - parseFloat(deductions) - parseFloat(tax_amount) - parseFloat(pension_amount);

        // Insert salary payment
        const paymentQuery = `
            INSERT INTO salary_payments (
                user_id, salary_period, payment_date, base_salary, allowances,
                deductions, tax_amount, pension_amount, net_amount,
                payment_method, payment_reference, paid_by, notes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING *
        `;

        const paymentResult = await client.query(paymentQuery, [
            user_id, salary_period, payment_date, base_salary, allowances,
            deductions, tax_amount, pension_amount, netAmount,
            payment_method, payment_reference, paid_by, notes
        ]);

        const paymentId = paymentResult.rows[0].id;

        // Insert salary components if provided
        if (components.length > 0) {
            const componentsQuery = `
                INSERT INTO salary_components (salary_payment_id, component_type, component_name, amount, description)
                VALUES ($1, $2, $3, $4, $5)
            `;

            for (const component of components) {
                await client.query(componentsQuery, [
                    paymentId,
                    component.component_type,
                    component.component_name,
                    component.amount,
                    component.description
                ]);
            }
        }

        await client.query('COMMIT');
        res.status(201).json(paymentResult.rows[0]);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error processing salary payment:', error);
        res.status(500).json({ error: 'Failed to process salary payment.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/salaries/summary - Get salary summary by period
router.get('/summary', async (req, res) => {
    try {
        const { period = 'monthly', year = new Date().getFullYear() } = req.query;

        const query = `
            SELECT 
                DATE_TRUNC($1, payment_date) as period,
                COUNT(*) as payment_count,
                SUM(net_amount) as total_paid,
                AVG(net_amount) as average_salary,
                COUNT(DISTINCT user_id) as staff_count
            FROM salary_payments
            WHERE status = 'paid' AND EXTRACT(YEAR FROM payment_date) = $2
            GROUP BY DATE_TRUNC($1, payment_date)
            ORDER BY period DESC
        `;

        const result = await db.query(query, [period, year]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching salary summary:', error);
        res.status(500).json({ error: 'Failed to fetch salary summary.', details: error.message });
    }
});

// PUT /api/salaries/payments/:id/status - Update payment status
router.put('/payments/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;

    try {
        const query = `
            UPDATE salary_payments 
            SET status = $1, notes = COALESCE($2, notes), updated_at = CURRENT_TIMESTAMP
            WHERE id = $3
            RETURNING *
        `;

        const result = await db.query(query, [status, notes, id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Salary payment not found.' });
        }

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating payment status:', error);
        res.status(500).json({ error: 'Failed to update payment status.', details: error.message });
    }
});

module.exports = router;