// routes/salaries.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// GET /api/salaries/staff - Get all staff with salary information
router.get('/staff', async (req, res) => {
    try {
        const { 
            role, 
            search, 
            salaryType, 
            minSalary, 
            maxSalary,
            isActive = 'true'
        } = req.query;

        let query = `
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
            WHERE u.is_active = $1
        `;
        
        const params = [isActive === 'true'];
        let paramCount = 2;

        // Add filters
        if (role) {
            query += ` AND u.role = $${paramCount}`;
            params.push(role);
            paramCount++;
        }

        if (search) {
            query += ` AND (u.fullname ILIKE $${paramCount} OR u.email ILIKE $${paramCount} OR u.username ILIKE $${paramCount})`;
            params.push(`%${search}%`);
            paramCount++;
        }

        if (salaryType) {
            query += ` AND ss.salary_type = $${paramCount}`;
            params.push(salaryType);
            paramCount++;
        }

        if (minSalary) {
            query += ` AND COALESCE(ss.net_salary, 0) >= $${paramCount}`;
            params.push(parseFloat(minSalary));
            paramCount++;
        }

        if (maxSalary) {
            query += ` AND COALESCE(ss.net_salary, 0) <= $${paramCount}`;
            params.push(parseFloat(maxSalary));
            paramCount++;
        }

        query += ` ORDER BY u.role, u.fullname`;

        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching staff salaries:', error);
        res.status(500).json({ error: 'Failed to fetch staff salaries.', details: error.message });
    }
});

// GET /api/salaries/payments - Get all salary payments with comprehensive filters
router.get('/payments', async (req, res) => {
    try {
        const {
            userId,
            staffRole,
            startDate,
            endDate,
            status,
            paymentMethod,
            minAmount,
            maxAmount,
            period, // 'today', 'week', 'month', 'year', 'custom'
            search,
            page = 1,
            limit = 50
        } = req.query;

        let query = `
            SELECT 
                sp.*,
                u.fullname as staff_name,
                u.role as staff_role,
                u.email as staff_email,
                paid_by_user.fullname as paid_by_name
            FROM salary_payments sp
            JOIN users u ON sp.user_id = u.id
            LEFT JOIN users paid_by_user ON sp.paid_by = paid_by_user.id
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 1;

        // User and Role filters
        if (userId) {
            query += ` AND sp.user_id = $${paramCount}`;
            params.push(userId);
            paramCount++;
        }

        if (staffRole) {
            query += ` AND u.role = $${paramCount}`;
            params.push(staffRole);
            paramCount++;
        }

        // Date filters with period support
        if (period) {
            let dateCondition = '';
            
            switch (period) {
                case 'today':
                    dateCondition = `DATE(sp.payment_date) = CURRENT_DATE`;
                    break;
                case 'week':
                    dateCondition = `sp.payment_date >= DATE_TRUNC('week', CURRENT_DATE) AND sp.payment_date < DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '1 week'`;
                    break;
                case 'month':
                    dateCondition = `sp.payment_date >= DATE_TRUNC('month', CURRENT_DATE) AND sp.payment_date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'`;
                    break;
                case 'last_month':
                    dateCondition = `sp.payment_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') AND sp.payment_date < DATE_TRUNC('month', CURRENT_DATE)`;
                    break;
                case 'year':
                    dateCondition = `sp.payment_date >= DATE_TRUNC('year', CURRENT_DATE) AND sp.payment_date < DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'`;
                    break;
            }
            
            if (dateCondition) {
                query += ` AND ${dateCondition}`;
            }
        } else {
            // Custom date range
            if (startDate) {
                query += ` AND sp.payment_date >= $${paramCount}`;
                params.push(startDate);
                paramCount++;
            }

            if (endDate) {
                // Add one day to include the end date fully
                const endDateObj = new Date(endDate);
                endDateObj.setDate(endDateObj.getDate() + 1);
                query += ` AND sp.payment_date < $${paramCount}`;
                params.push(endDateObj.toISOString().split('T')[0]);
                paramCount++;
            }
        }

        // Status and method filters
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

        // Amount filters
        if (minAmount) {
            query += ` AND sp.net_amount >= $${paramCount}`;
            params.push(parseFloat(minAmount));
            paramCount++;
        }

        if (maxAmount) {
            query += ` AND sp.net_amount <= $${paramCount}`;
            params.push(parseFloat(maxAmount));
            paramCount++;
        }

        // Search filter
        if (search) {
            query += ` AND (
                u.fullname ILIKE $${paramCount} OR 
                u.email ILIKE $${paramCount} OR 
                sp.payment_reference ILIKE $${paramCount} OR
                sp.notes ILIKE $${paramCount}
            )`;
            params.push(`%${search}%`);
            paramCount++;
        }

        // Get total count for pagination
        const countQuery = `SELECT COUNT(*) FROM (${query}) as count_query`;
        const countResult = await db.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].count);

        // Add ordering and pagination
        query += ` ORDER BY sp.payment_date DESC, sp.created_at DESC`;
        
        const offset = (page - 1) * limit;
        query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        params.push(parseInt(limit), offset);

        const result = await db.query(query, params);

        // Get summary statistics with same filters
        let summaryQuery = `
            SELECT 
                COUNT(*) as total_payments,
                COALESCE(SUM(net_amount), 0) as total_paid,
                COALESCE(AVG(net_amount), 0) as average_payment,
                MIN(payment_date) as first_payment,
                MAX(payment_date) as last_payment,
                COUNT(DISTINCT user_id) as unique_staff
            FROM salary_payments sp
            JOIN users u ON sp.user_id = u.id
            WHERE 1=1
        `;
        const summaryParams = [];
        let summaryParamCount = 1;

        // Apply the same filters to summary
        if (userId) {
            summaryQuery += ` AND sp.user_id = $${summaryParamCount}`;
            summaryParams.push(userId);
            summaryParamCount++;
        }

        if (staffRole) {
            summaryQuery += ` AND u.role = $${summaryParamCount}`;
            summaryParams.push(staffRole);
            summaryParamCount++;
        }

        if (status) {
            summaryQuery += ` AND sp.status = $${summaryParamCount}`;
            summaryParams.push(status);
            summaryParamCount++;
        }

        if (paymentMethod) {
            summaryQuery += ` AND sp.payment_method = $${summaryParamCount}`;
            summaryParams.push(paymentMethod);
            summaryParamCount++;
        }

        if (period) {
            let dateCondition = '';
            
            switch (period) {
                case 'today':
                    dateCondition = `DATE(sp.payment_date) = CURRENT_DATE`;
                    break;
                case 'week':
                    dateCondition = `sp.payment_date >= DATE_TRUNC('week', CURRENT_DATE) AND sp.payment_date < DATE_TRUNC('week', CURRENT_DATE) + INTERVAL '1 week'`;
                    break;
                case 'month':
                    dateCondition = `sp.payment_date >= DATE_TRUNC('month', CURRENT_DATE) AND sp.payment_date < DATE_TRUNC('month', CURRENT_DATE) + INTERVAL '1 month'`;
                    break;
                case 'last_month':
                    dateCondition = `sp.payment_date >= DATE_TRUNC('month', CURRENT_DATE - INTERVAL '1 month') AND sp.payment_date < DATE_TRUNC('month', CURRENT_DATE)`;
                    break;
                case 'year':
                    dateCondition = `sp.payment_date >= DATE_TRUNC('year', CURRENT_DATE) AND sp.payment_date < DATE_TRUNC('year', CURRENT_DATE) + INTERVAL '1 year'`;
                    break;
            }
            
            if (dateCondition) {
                summaryQuery += ` AND ${dateCondition}`;
            }
        } else {
            if (startDate) {
                summaryQuery += ` AND sp.payment_date >= $${summaryParamCount}`;
                summaryParams.push(startDate);
                summaryParamCount++;
            }

            if (endDate) {
                const endDateObj = new Date(endDate);
                endDateObj.setDate(endDateObj.getDate() + 1);
                summaryQuery += ` AND sp.payment_date < $${summaryParamCount}`;
                summaryParams.push(endDateObj.toISOString().split('T')[0]);
                summaryParamCount++;
            }
        }

        if (minAmount) {
            summaryQuery += ` AND sp.net_amount >= $${summaryParamCount}`;
            summaryParams.push(parseFloat(minAmount));
            summaryParamCount++;
        }

        if (maxAmount) {
            summaryQuery += ` AND sp.net_amount <= $${summaryParamCount}`;
            summaryParams.push(parseFloat(maxAmount));
            summaryParamCount++;
        }

        const summaryResult = await db.query(summaryQuery, summaryParams);

        res.status(200).json({
            payments: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                totalCount,
                totalPages: Math.ceil(totalCount / limit)
            },
            summary: summaryResult.rows[0] || {}
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
                paid_by_user.fullname as paid_by_name,
                paid_by_user.email as paid_by_email
            FROM salary_payments sp
            JOIN users u ON sp.user_id = u.id
            LEFT JOIN users paid_by_user ON sp.paid_by = paid_by_user.id
            WHERE sp.id = $1
        `;

        const componentsQuery = `
            SELECT * FROM salary_components 
            WHERE salary_payment_id = $1 
            ORDER BY 
                CASE 
                    WHEN component_type = 'allowance' THEN 1
                    WHEN component_type = 'bonus' THEN 2
                    WHEN component_type = 'deduction' THEN 3
                    WHEN component_type = 'tax' THEN 4
                    ELSE 5
                END,
                amount DESC
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
        // Validate user exists
        const userCheck = await db.query('SELECT id FROM users WHERE id = $1', [id]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found.' });
        }

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
            id, 
            parseFloat(base_salary), 
            parseFloat(allowances || 0), 
            parseFloat(deductions || 0), 
            netSalary,
            salary_type, 
            bank_name, 
            account_number, 
            parseFloat(tax_rate || 0), 
            parseFloat(pension_rate || 0)
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

        // 1. Validate user exists (Return 404)
        const userCheck = await client.query('SELECT id FROM users WHERE id = $1', [user_id]);
        if (userCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Validation Error', details: 'Invalid staff member ID' });
        }

        // 2. Validate paid_by user exists (Return 404)
        if (paid_by) {
            const paidByCheck = await client.query('SELECT id FROM users WHERE id = $1', [paid_by]);
            if (paidByCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Validation Error', details: 'Invalid user ID for paid_by field' });
            }
        }

        // Calculate net amount
        const netAmount = parseFloat(base_salary) + parseFloat(allowances) - parseFloat(deductions) - parseFloat(tax_amount) - parseFloat(pension_amount);

        // 3. Check for duplicate payment for same period (Return 409)
        const duplicateCheck = await client.query(
            'SELECT id FROM salary_payments WHERE user_id = $1 AND salary_period = $2',
            [user_id, salary_period]
        );

        if (duplicateCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({ 
                error: 'Duplicate Payment', 
                details: 'Salary payment for this period already exists for this staff member.' 
            });
        }

        // Insert salary payment
        const paymentQuery = `
            INSERT INTO salary_payments (
                user_id, salary_period, payment_date, base_salary, allowances,
                deductions, tax_amount, pension_amount, net_amount,
                payment_method, payment_reference, paid_by, notes, status
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'paid')
            RETURNING *
        `;

        const paymentResult = await client.query(paymentQuery, [
            user_id, 
            salary_period, 
            payment_date, 
            parseFloat(base_salary), 
            parseFloat(allowances),
            parseFloat(deductions), 
            parseFloat(tax_amount), 
            parseFloat(pension_amount), 
            netAmount,
            payment_method, 
            payment_reference, 
            paid_by, 
            notes
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
                    parseFloat(component.amount),
                    component.description
                ]);
            }
        }

        await client.query('COMMIT');
        res.status(201).json(paymentResult.rows[0]);

    } catch (error) {
        // This catch block is now reserved for unexpected server/database errors (500)
        await client.query('ROLLBACK');
        console.error('Error processing salary payment:', error);
        
        // Final fallback to 500 for unhandled exceptions
        res.status(500).json({ error: 'Failed to process salary payment.', details: error.message });
        
    } finally {
        client.release();
    }
});

// GET /api/salaries/summary - Get salary summary by period
router.get('/summary', async (req, res) => {
    try {
        const { period = 'monthly', year = new Date().getFullYear() } = req.query;

        let groupByClause = '';
        let dateFormat = '';

        switch (period) {
            case 'daily':
                groupByClause = `DATE(payment_date)`;
                dateFormat = 'YYYY-MM-DD';
                break;
            case 'weekly':
                groupByClause = `DATE_TRUNC('week', payment_date)`;
                dateFormat = 'YYYY-"W"WW';
                break;
            case 'monthly':
                groupByClause = `DATE_TRUNC('month', payment_date)`;
                dateFormat = 'YYYY-MM';
                break;
            case 'yearly':
                groupByClause = `DATE_TRUNC('year', payment_date)`;
                dateFormat = 'YYYY';
                break;
            default:
                return res.status(400).json({ error: 'Invalid period parameter' });
        }

        const query = `
            SELECT 
                ${groupByClause} as period,
                TO_CHAR(${groupByClause}, '${dateFormat}') as period_label,
                COUNT(*) as payment_count,
                COALESCE(SUM(net_amount), 0) as total_paid,
                COALESCE(AVG(net_amount), 0) as average_salary,
                COUNT(DISTINCT user_id) as staff_count
            FROM salary_payments
            WHERE status = 'paid' AND EXTRACT(YEAR FROM payment_date) = $1
            GROUP BY ${groupByClause}
            ORDER BY period DESC
        `;

        const result = await db.query(query, [year]);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching salary summary:', error);
        res.status(500).json({ error: 'Failed to fetch salary summary.', details: error.message });
    }
});

// GET /api/salaries/filters/options - Get filter options
router.get('/filters/options', async (req, res) => {
    try {
        const [roles, paymentMethods, statuses, salaryTypes] = await Promise.all([
            db.query('SELECT DISTINCT role FROM users WHERE is_active = true ORDER BY role'),
            db.query('SELECT DISTINCT payment_method FROM salary_payments WHERE payment_method IS NOT NULL ORDER BY payment_method'),
            db.query('SELECT DISTINCT status FROM salary_payments WHERE status IS NOT NULL ORDER BY status'),
            db.query('SELECT DISTINCT salary_type FROM staff_salaries WHERE is_active = true AND salary_type IS NOT NULL ORDER BY salary_type')
        ]);

        res.status(200).json({
            roles: roles.rows.map(r => r.role).filter(r => r),
            paymentMethods: paymentMethods.rows.map(p => p.payment_method).filter(p => p),
            statuses: statuses.rows.map(s => s.status).filter(s => s),
            salaryTypes: salaryTypes.rows.map(st => st.salary_type).filter(st => st)
        });
    } catch (error) {
        console.error('Error fetching filter options:', error);
        res.status(500).json({ error: 'Failed to fetch filter options.', details: error.message });
    }
});

// PUT /api/salaries/payments/:id/status - Update payment status
router.put('/payments/:id/status', async (req, res) => {
    const { id } = req.params;
    const { status, notes } = req.body;

    try {
        // Validate status
        const validStatuses = ['paid', 'pending', 'failed', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ error: 'Invalid status. Must be one of: paid, pending, failed, cancelled' });
        }

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

// DELETE /api/salaries/payments/:id - Delete a salary payment
router.delete('/payments/:id', async (req, res) => {
    const { id } = req.params;
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        // First delete components (due to foreign key constraint)
        await client.query('DELETE FROM salary_components WHERE salary_payment_id = $1', [id]);

        // Then delete the payment
        const result = await client.query('DELETE FROM salary_payments WHERE id = $1 RETURNING *', [id]);

        if (result.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Salary payment not found.' });
        }

        await client.query('COMMIT');
        res.status(200).json({ 
            message: 'Salary payment deleted successfully.', 
            deletedPayment: result.rows[0] 
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting salary payment:', error);
        res.status(500).json({ error: 'Failed to delete salary payment.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/salaries/staff/:id/payments - Get payment history for a specific staff member
router.get('/staff/:id/payments', async (req, res) => {
    const { id } = req.params;
    const { page = 1, limit = 20 } = req.query;

    try {
        // Validate staff exists
        const staffCheck = await db.query('SELECT id, fullname FROM users WHERE id = $1', [id]);
        if (staffCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found.' });
        }

        const query = `
            SELECT 
                sp.*,
                paid_by_user.fullname as paid_by_name
            FROM salary_payments sp
            LEFT JOIN users paid_by_user ON sp.paid_by = paid_by_user.id
            WHERE sp.user_id = $1
            ORDER BY sp.payment_date DESC, sp.created_at DESC
            LIMIT $2 OFFSET $3
        `;

        const countQuery = `SELECT COUNT(*) FROM salary_payments WHERE user_id = $1`;
        
        const [result, countResult] = await Promise.all([
            db.query(query, [id, parseInt(limit), (parseInt(page) - 1) * parseInt(limit)]),
            db.query(countQuery, [id])
        ]);

        const totalCount = parseInt(countResult.rows[0].count);

        res.status(200).json({
            staff: staffCheck.rows[0],
            payments: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                totalCount,
                totalPages: Math.ceil(totalCount / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching staff payment history:', error);
        res.status(500).json({ error: 'Failed to fetch staff payment history.', details: error.message });
    }
});

// GET /api/salaries/dashboard/stats - Get dashboard statistics
router.get('/dashboard/stats', async (req, res) => {
    try {
        const query = `
            SELECT 
                -- Total staff count
                (SELECT COUNT(*) FROM users WHERE is_active = true) as total_staff,
                
                -- Staff with salary structure
                (SELECT COUNT(*) FROM staff_salaries WHERE is_active = true) as staff_with_salary,
                
                -- Total payments this month
                (SELECT COUNT(*) FROM salary_payments 
                 WHERE payment_date >= DATE_TRUNC('month', CURRENT_DATE) 
                 AND status = 'paid') as payments_this_month,
                
                -- Total paid this month
                (SELECT COALESCE(SUM(net_amount), 0) FROM salary_payments 
                 WHERE payment_date >= DATE_TRUNC('month', CURRENT_DATE) 
                 AND status = 'paid') as total_paid_this_month,
                
                -- Average salary
                (SELECT COALESCE(AVG(net_salary), 0) FROM staff_salaries WHERE is_active = true) as average_salary,
                
                -- Pending payments
                (SELECT COUNT(*) FROM salary_payments WHERE status = 'pending') as pending_payments,
                
                -- Total paid all time
                (SELECT COALESCE(SUM(net_amount), 0) FROM salary_payments WHERE status = 'paid') as total_paid_all_time
        `;

        const result = await db.query(query);
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching dashboard stats:', error);
        res.status(500).json({ error: 'Failed to fetch dashboard statistics.', details: error.message });
    }
});

module.exports = router;