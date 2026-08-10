// routes/operatingExpenses.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const authenticate = require('../middleware/authenticate'); // Import your auth middleware

// Apply authentication to all routes
router.use(authenticate);

// Predefined expense categories & types (used for dropdown option selection in the UI)
const EXPENSE_CATEGORIES = {
    'Production': ['Raw Material Purchase', 'Packaging Materials', 'Equipment Repair', 'Equipment Purchase', 'Gas/Fuel', 'Water', 'Other Production'],
    'Operations': ['Rent', 'Electricity', 'Transport/Delivery', 'Vehicle Maintenance', 'Communication', 'Cleaning Supplies', 'Other Operations'],
    'Staff': ['Staff Welfare', 'Staff Training', 'Medical', 'Uniforms', 'Other Staff'],
    'Administrative': ['Office Supplies', 'Licenses & Permits', 'Bank Charges', 'Legal & Professional', 'Insurance', 'Other Administrative'],
    'Marketing': ['Advertising', 'Promotions', 'Branding', 'Other Marketing'],
    'Miscellaneous': ['Donations', 'Fines & Penalties', 'Other']
};

// Helper: build shared parameterized WHERE conditions for list + summary
function buildExpenseConditions(query, params, startIndex) {
    const {
        startDate, endDate, category, expenseType, paymentMethod, viewType = 'monthly'
    } = query;

    let where = '';
    let paramCount = startIndex;

    // Date filtering based on view type (defaults to the current month)
    if (viewType && viewType !== 'all') {
        let dateCondition = '';
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
            case 'yearly':
                dateCondition = `oe.expense_date >= DATE_TRUNC('year', CURRENT_DATE) AND oe.expense_date < DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'`;
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
            where += ` AND ${dateCondition}`;
        }
    }

    // Additional filters — ALL parameterized (previously category/expenseType were
    // string-interpolated into the summary query = SQL injection vulnerability)
    if (category) {
        where += ` AND oe.category = $${paramCount}`;
        params.push(category);
        paramCount++;
    }
    if (expenseType) {
        where += ` AND oe.expense_type ILIKE $${paramCount}`;
        params.push(`%${expenseType}%`);
        paramCount++;
    }
    if (paymentMethod) {
        where += ` AND oe.payment_method = $${paramCount}`;
        params.push(paymentMethod);
        paramCount++;
    }

    return { where, paramCount };
}

// GET /api/operating-expenses - Get operating expenses with filters (defaults to current month)
router.get('/', async (req, res) => {
    try {
        const { page = 1, limit = 50 } = req.query;

        const params = [];
        const { where, paramCount } = buildExpenseConditions(req.query, params, 1);

        let query = `
            SELECT 
                oe.*,
                u.fullname as recorded_by_name,
                u.username as recorded_by_username
            FROM operating_expenses oe
            LEFT JOIN users u ON oe.recorded_by = u.id
            WHERE 1=1 ${where}
        `;

        // Get total count for pagination
        const countQuery = `SELECT COUNT(*) FROM operating_expenses oe WHERE 1=1 ${where}`;
        const countResult = await db.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].count);

        // Summary statistics — uses the SAME parameterized conditions (SQL-injection safe)
        const summaryQuery = `
            SELECT 
                COUNT(*) as total_expenses,
                COALESCE(SUM(amount), 0) as total_amount,
                COALESCE(AVG(amount), 0) as average_amount,
                COALESCE(MIN(amount), 0) as min_amount,
                COALESCE(MAX(amount), 0) as max_amount
            FROM operating_expenses oe
            WHERE 1=1 ${where}
        `;
        const summaryResult = await db.query(summaryQuery, params);

        // Category breakdown for the same filtered set (drives KPI cards/charts)
        const breakdownQuery = `
            SELECT category, expense_type, COUNT(*) as count, SUM(amount) as total
            FROM operating_expenses oe
            WHERE 1=1 ${where}
            GROUP BY category, expense_type
            ORDER BY total DESC
        `;
        const breakdownResult = await db.query(breakdownQuery, params);

        // Add ordering and pagination
        query += ` ORDER BY oe.expense_date DESC, oe.created_at DESC`;
        const offset = (page - 1) * limit;
        query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        const listParams = [...params, parseInt(limit), offset];

        const result = await db.query(query, listParams);

        res.status(200).json({
            expenses: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                totalCount,
                totalPages: Math.ceil(totalCount / limit)
            },
            summary: summaryResult.rows[0],
            breakdown: breakdownResult.rows
        });

    } catch (error) {
        console.error('Error fetching operating expenses:', error);
        res.status(500).json({ error: 'Failed to fetch operating expenses.', details: error.message });
    }
});

// GET /api/operating-expenses/options - Predefined categories & types + existing ones (for dropdowns)
router.get('/options', async (req, res) => {
    try {
        // Merge predefined options with any types already used in the database
        const existing = await db.query(`
            SELECT DISTINCT category, expense_type FROM operating_expenses ORDER BY category, expense_type
        `);
        const merged = JSON.parse(JSON.stringify(EXPENSE_CATEGORIES));
        for (const row of existing.rows) {
            if (!row.category || !row.expense_type) continue;
            if (!merged[row.category]) merged[row.category] = [];
            if (!merged[row.category].includes(row.expense_type)) merged[row.category].push(row.expense_type);
        }
        res.status(200).json(merged);
    } catch (error) {
        console.error('Error fetching expense options:', error);
        res.status(500).json({ error: 'Failed to fetch expense options.', details: error.message });
    }
});

// GET /api/operating-expenses/summary - Get expense summary by period
router.get('/summary', async (req, res) => {
    try {
        const { period = 'monthly', year = new Date().getFullYear() } = req.query;

        let groupByClause;
        let dateFormat;

        switch (period) {
            case 'daily':
                groupByClause = `DATE(expense_date)`;
                dateFormat = 'YYYY-MM-DD';
                break;
            case 'weekly':
                groupByClause = `DATE_TRUNC('week', expense_date)`;
                dateFormat = 'YYYY-"W"WW';
                break;
            case 'yearly':
                groupByClause = `DATE_TRUNC('year', expense_date)`;
                dateFormat = 'YYYY';
                break;
            case 'monthly':
            default:
                groupByClause = `DATE_TRUNC('month', expense_date)`;
                dateFormat = 'YYYY-MM';
                break;
        }

        const query = `
            SELECT 
                ${groupByClause} as period,
                TO_CHAR(${groupByClause}, $2) as period_label,
                COUNT(*) as expense_count,
                SUM(amount) as total_amount,
                category,
                expense_type
            FROM operating_expenses
            WHERE EXTRACT(YEAR FROM expense_date) = $1
            GROUP BY ${groupByClause}, category, expense_type
            ORDER BY period DESC, total_amount DESC
        `;

        const result = await db.query(query, [year, dateFormat]);
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
        is_recurring,
        recurrence_pattern
    } = req.body;

    try {
        // Validate required fields
        if (!expense_type || !amount || !category) {
            return res.status(400).json({ 
                error: 'Missing required fields: expense_type, amount, and category are required.' 
            });
        }

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
            parseFloat(amount),
            category,
            payment_method || 'Cash',
            reference_number,
            req.user.id, // Use the authenticated user's ID
            is_recurring || false,
            recurrence_pattern
        ]);

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating expense:', error);
        res.status(500).json({ 
            error: 'Failed to create expense.', 
            details: error.message 
        });
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
        // First, check if the expense exists
        const existingExpense = await db.query(
            'SELECT * FROM operating_expenses WHERE id = $1',
            [id]
        );

        if (existingExpense.rows.length === 0) {
            return res.status(404).json({ error: 'Expense not found.' });
        }

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
