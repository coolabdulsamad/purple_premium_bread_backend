// routes/operatingExpenses.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// GET /api/operating-expenses - Get all operating expenses with filters
router.get('/', async (req, res) => {
    try {
        const {
            startDate,
            endDate,
            category,
            expenseType,
            paymentMethod,
            viewType = 'all', // 'daily', 'weekly', 'monthly', 'custom', 'all'
            page = 1,
            limit = 50
        } = req.query;

        let query = `
            SELECT 
                oe.*,
                u.fullname as recorded_by_name,
                u.username as recorded_by_username
            FROM operating_expenses oe
            LEFT JOIN users u ON oe.recorded_by = u.id
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 1;

        // Date filtering based on view type
        if (viewType !== 'all') {
            let dateCondition = '';
            const now = new Date();
            
            switch (viewType) {
                case 'today':
                    dateCondition = `DATE(oe.expense_date) = CURRENT_DATE`;
                    break;
                case 'weekly':
                    dateCondition = `oe.expense_date >= DATE_TRUNC('week', CURRENT_DATE) AND oe.expense_date < DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '1 week'`;
                    break;
                case 'monthly':
                    dateCondition = `oe.expense_date >= DATE_TRUNC('month', CURRENT_DATE) AND oe.expense_date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'`;
                    break;
                case 'custom':
                    if (startDate && endDate) {
                        dateCondition = `oe.expense_date >= $${paramCount} AND oe.expense_date <= $${paramCount + 1}`;
                        params.push(startDate, endDate);
                        paramCount += 2;
                    }
                    break;
            }
            
            if (dateCondition) {
                query += ` AND ${dateCondition}`;
            }
        }

        // Additional filters
        if (category) {
            query += ` AND oe.category = $${paramCount}`;
            params.push(category);
            paramCount++;
        }

        if (expenseType) {
            query += ` AND oe.expense_type ILIKE $${paramCount}`;
            params.push(`%${expenseType}%`);
            paramCount++;
        }

        if (paymentMethod) {
            query += ` AND oe.payment_method = $${paramCount}`;
            params.push(paymentMethod);
            paramCount++;
        }

        // Get total count for pagination
        const countQuery = `SELECT COUNT(*) FROM (${query}) as count_query`;
        const countResult = await db.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].count);

        // Add ordering and pagination
        query += ` ORDER BY oe.expense_date DESC, oe.created_at DESC`;
        
        const offset = (page - 1) * limit;
        query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        params.push(parseInt(limit), offset);

        const result = await db.query(query, params);

        // Get summary statistics
        const summaryQuery = `
            SELECT 
                COUNT(*) as total_expenses,
                SUM(amount) as total_amount,
                AVG(amount) as average_amount,
                MIN(amount) as min_amount,
                MAX(amount) as max_amount
            FROM operating_expenses oe
            WHERE 1=1
            ${category ? ` AND oe.category = '${category}'` : ''}
            ${expenseType ? ` AND oe.expense_type ILIKE '%${expenseType}%'` : ''}
        `;

        const summaryResult = await db.query(summaryQuery);

        res.status(200).json({
            expenses: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                totalCount,
                totalPages: Math.ceil(totalCount / limit)
            },
            summary: summaryResult.rows[0]
        });

    } catch (error) {
        console.error('Error fetching operating expenses:', error);
        res.status(500).json({ error: 'Failed to fetch operating expenses.', details: error.message });
    }
});

// GET /api/operating-expenses/summary - Get expense summary by period
router.get('/summary', async (req, res) => {
    try {
        const { period = 'monthly', year = new Date().getFullYear() } = req.query;

        let groupByClause = '';
        let dateFormat = '';

        switch (period) {
            case 'daily':
                groupByClause = `DATE(expense_date)`;
                dateFormat = 'YYYY-MM-DD';
                break;
            case 'weekly':
                groupByClause = `DATE_TRUNC('week', expense_date)`;
                dateFormat = 'YYYY-"W"WW';
                break;
            case 'monthly':
                groupByClause = `DATE_TRUNC('month', expense_date)`;
                dateFormat = 'YYYY-MM';
                break;
            case 'yearly':
                groupByClause = `DATE_TRUNC('year', expense_date)`;
                dateFormat = 'YYYY';
                break;
        }

        const query = `
            SELECT 
                ${groupByClause} as period,
                TO_CHAR(${groupByClause}, '${dateFormat}') as period_label,
                COUNT(*) as expense_count,
                SUM(amount) as total_amount,
                category,
                expense_type
            FROM operating_expenses
            WHERE EXTRACT(YEAR FROM expense_date) = $1
            GROUP BY ${groupByClause}, category, expense_type
            ORDER BY period DESC, total_amount DESC
        `;

        const result = await db.query(query, [year]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching expense summary:', error);
        res.status(500).json({ error: 'Failed to fetch expense summary.', details: error.message });
    }
});

// GET /api/operating-expenses/categories - Get distinct expense categories
router.get('/categories', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT DISTINCT category, COUNT(*) as expense_count
            FROM operating_expenses 
            GROUP BY category 
            ORDER BY expense_count DESC
        `);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching expense categories:', error);
        res.status(500).json({ error: 'Failed to fetch expense categories.', details: error.message });
    }
});

// GET /api/operating-expenses/:id - Get a single expense by ID
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query(`
            SELECT 
                oe.*,
                u.fullname as recorded_by_name,
                u.username as recorded_by_username
            FROM operating_expenses oe
            LEFT JOIN users u ON oe.recorded_by = u.id
            WHERE oe.id = $1
        `, [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Expense not found.' });
        }

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching expense:', error);
        res.status(500).json({ error: 'Failed to fetch expense.', details: error.message });
    }
});

// POST /api/operating-expenses - Create a new expense
router.post('/', async (req, res) => {
    const {
        expense_date,
        expense_type,
        description,
        amount,
        category,
        payment_method,
        reference_number,
        recorded_by,
        is_recurring,
        recurrence_pattern
    } = req.body;

    try {
        const result = await db.query(`
            INSERT INTO operating_expenses (
                expense_date, expense_type, description, amount, category,
                payment_method, reference_number, recorded_by, is_recurring, recurrence_pattern
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *
        `, [
            expense_date || new Date(),
            expense_type,
            description,
            amount,
            category,
            payment_method || 'Cash',
            reference_number,
            recorded_by,
            is_recurring || false,
            recurrence_pattern
        ]);

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating expense:', error);
        res.status(500).json({ error: 'Failed to create expense.', details: error.message });
    }
});

// PUT /api/operating-expenses/:id - Update an expense
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const {
        expense_date,
        expense_type,
        description,
        amount,
        category,
        payment_method,
        reference_number,
        is_recurring,
        recurrence_pattern
    } = req.body;

    try {
        const result = await db.query(`
            UPDATE operating_expenses 
            SET expense_date = $1, expense_type = $2, description = $3, amount = $4,
                category = $5, payment_method = $6, reference_number = $7,
                is_recurring = $8, recurrence_pattern = $9, updated_at = CURRENT_TIMESTAMP
            WHERE id = $10
            RETURNING *
        `, [
            expense_date,
            expense_type,
            description,
            amount,
            category,
            payment_method,
            reference_number,
            is_recurring,
            recurrence_pattern,
            id
        ]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Expense not found.' });
        }

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating expense:', error);
        res.status(500).json({ error: 'Failed to update expense.', details: error.message });
    }
});

// DELETE /api/operating-expenses/:id - Delete an expense
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('DELETE FROM operating_expenses WHERE id = $1 RETURNING *', [id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Expense not found.' });
        }

        res.status(200).json({ message: 'Expense deleted successfully.', deletedExpense: result.rows[0] });
    } catch (error) {
        console.error('Error deleting expense:', error);
        res.status(500).json({ error: 'Failed to delete expense.', details: error.message });
    }
});

module.exports = router;