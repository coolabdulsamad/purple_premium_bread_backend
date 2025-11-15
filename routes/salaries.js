// routes/salaries.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const authenticate = require('../middleware/authenticate');

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
                ss.bank_account_name,  /* <--- ADD THIS LINE */
                ss.account_number,
                ss.tax_rate,
                ss.pension_rate,
                ss.is_active as salary_active,
                (SELECT COUNT(*) FROM salary_payments sp WHERE sp.user_id = u.id AND sp.status = 'paid') as total_payments,
                (SELECT MAX(payment_date) FROM salary_payments sp WHERE sp.user_id = u.id AND sp.status = 'paid') as last_payment_date,
                (SELECT COALESCE(SUM(sl.amount), 0) FROM staff_loans sl WHERE sl.user_id = u.id AND sl.is_paid = FALSE) as outstanding_loan_amount
            FROM users u
            LEFT JOIN staff_salaries ss ON u.id = ss.user_id
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
            period,
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
            if (startDate) {
                query += ` AND sp.payment_date >= $${paramCount}`;
                params.push(startDate);
                paramCount++;
            }

            if (endDate) {
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

        res.status(200).json({
            payments: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                totalCount,
                totalPages: Math.ceil(totalCount / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching salary payments:', error);
        res.status(500).json({ error: 'Failed to fetch salary payments.', details: error.message });
    }
});

// GET /api/salaries/payments/:id - Get single payment details
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

        const paymentResult = await db.query(paymentQuery, [id]);

        if (paymentResult.rows.length === 0) {
            return res.status(404).json({ error: 'Salary payment not found.' });
        }

        res.status(200).json(paymentResult.rows[0]);
    } catch (error) {
        console.error('Error fetching payment details:', error);
        res.status(500).json({ error: 'Failed to fetch payment details.', details: error.message });
    }
});

// POST /api/salaries/staff/:id/salary - Update staff salary structure
// router.post('/staff/:id/salary', async (req, res) => {
//     const { id } = req.params;
//     const {
//         base_salary,
//         allowances,
//         deductions,
//         salary_type,
//         bank_name,
//         account_number,
//         tax_rate,
//         pension_rate
//     } = req.body;

//     try {
//         // Validate user exists
//         const userCheck = await db.query('SELECT id FROM users WHERE id = $1', [id]);
//         if (userCheck.rows.length === 0) {
//             return res.status(404).json({ error: 'Staff member not found.' });
//         }

//         // Calculate net salary
//         const netSalary = parseFloat(base_salary) + parseFloat(allowances || 0) - parseFloat(deductions || 0);

//         const query = `
//             INSERT INTO staff_salaries (
//                 user_id, base_salary, allowances, deductions, net_salary,
//                 salary_type, bank_name, account_number, tax_rate, pension_rate
//             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
//             ON CONFLICT (user_id) 
//             DO UPDATE SET
//                 base_salary = EXCLUDED.base_salary,
//                 allowances = EXCLUDED.allowances,
//                 deductions = EXCLUDED.deductions,
//                 net_salary = EXCLUDED.net_salary,
//                 salary_type = EXCLUDED.salary_type,
//                 bank_name = EXCLUDED.bank_name,
//                 account_number = EXCLUDED.account_number,
//                 tax_rate = EXCLUDED.tax_rate,
//                 pension_rate = EXCLUDED.pension_rate,
//                 updated_at = CURRENT_TIMESTAMP
//             RETURNING *
//         `;

//         const result = await db.query(query, [
//             id,
//             parseFloat(base_salary),
//             parseFloat(allowances || 0),
//             parseFloat(deductions || 0),
//             netSalary,
//             salary_type,
//             bank_name,
//             account_number,
//             parseFloat(tax_rate || 0),
//             parseFloat(pension_rate || 0)
//         ]);

//         res.status(200).json(result.rows[0]);
//     } catch (error) {
//         console.error('Error updating staff salary:', error);
//         res.status(500).json({ error: 'Failed to update staff salary.', details: error.message });
//     }
// });

// routes/salaries.js - FIXED PAYMENT ROUTE
router.post('/payments', authenticate, async (req, res) => {
    const paid_by = parseInt(req.user.id);
    if (!paid_by || isNaN(paid_by)) {
        return res.status(403).json({ error: 'Unauthorized', details: 'Authenticated user ID is missing or invalid.' });
    }

    const {
        user_id,
        salary_period,
        payment_date,
        base_salary,
        allowances,
        deductions,
        tax_amount,
        pension_amount,
        net_amount,
        payment_method,
        payment_reference,
        notes,
        loan_deduction,
        loan_ids
    } = req.body;

    console.log('Payment data received:', {
        user_id, salary_period, payment_date, base_salary, allowances,
        deductions, tax_amount, pension_amount, net_amount, loan_deduction
    });

    if (!user_id || !payment_date || !base_salary || !net_amount) {
        return res.status(400).json({ error: 'Missing required fields for payment.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Calculate gross amount from base_salary + allowances
        const gross_amount = parseFloat(base_salary || 0) + parseFloat(allowances || 0);

        // Calculate total deductions (including tax, pension, other deductions, and loans)
        const total_deductions = parseFloat(deductions || 0) +
            parseFloat(tax_amount || 0) +
            parseFloat(pension_amount || 0) +
            parseFloat(loan_deduction || 0);

        console.log('Calculated values:', { gross_amount, total_deductions });

        // Insert the Salary Payment with all fields
        const paymentQuery = `
            INSERT INTO salary_payments 
                (user_id, salary_period, payment_date, base_salary, allowances, 
                 deductions, tax_amount, pension_amount, net_amount, gross_amount,
                 payment_method, payment_reference, notes, paid_by, status, created_at, loan_deduction)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'paid', CURRENT_TIMESTAMP, $15)
            RETURNING id
        `;

        const paymentResult = await client.query(paymentQuery, [
            user_id,
            salary_period || payment_date,
            payment_date,
            parseFloat(base_salary || 0),
            parseFloat(allowances || 0),
            parseFloat(deductions || 0), // This is "other deductions"
            parseFloat(tax_amount || 0),
            parseFloat(pension_amount || 0),
            parseFloat(net_amount),
            gross_amount, // Calculated gross amount
            payment_method,
            payment_reference,
            notes,
            paid_by,
            parseFloat(loan_deduction || 0)
        ]);

        const newPaymentId = paymentResult.rows[0].id;

        // Update loan status if loans were deducted
        if (loan_ids && loan_ids.length > 0 && parseFloat(loan_deduction || 0) > 0) {
            const loanUpdateQuery = `
                UPDATE staff_loans
                SET is_paid = TRUE, deducted_on_payment_id = $1, updated_at = CURRENT_TIMESTAMP
                WHERE id = ANY($2) AND user_id = $3 AND is_paid = FALSE
            `;
            await client.query(loanUpdateQuery, [newPaymentId, loan_ids, user_id]);
        }

        await client.query('COMMIT');

        // Return the complete payment record
        const completePaymentQuery = `
            SELECT sp.*, u.fullname as staff_name, u.role as staff_role
            FROM salary_payments sp
            JOIN users u ON sp.user_id = u.id
            WHERE sp.id = $1
        `;
        const completeResult = await client.query(completePaymentQuery, [newPaymentId]);

        res.status(201).json(completeResult.rows[0]);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error processing salary payment:', error);
        res.status(500).json({ error: 'Failed to process salary payment.', details: error.message });
    } finally {
        client.release();
    }
});

// POST /api/salaries/loans - Record a new staff loan/advance
router.post('/loans', authenticate, async (req, res) => {
    const { user_id, loan_date, amount, reason } = req.body;

    if (!user_id || !loan_date || !amount) {
        return res.status(400).json({ error: 'Missing required fields: user_id, loan_date, and amount.' });
    }

    if (parseFloat(amount) <= 0) {
        return res.status(400).json({ error: 'Loan amount must be greater than zero.' });
    }

    try {
        const query = `
            INSERT INTO staff_loans 
                (user_id, loan_date, amount, reason, created_at)
            VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
            RETURNING *
        `;
        const result = await db.query(query, [user_id, loan_date, parseFloat(amount), reason]);
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error recording staff loan:', error);
        res.status(500).json({ error: 'Failed to record staff loan.', details: error.message });
    }
});

// GET /api/salaries/loans - Get all loans with filters
router.get('/loans', async (req, res) => {
    try {
        const {
            userId,
            status,
            startDate,
            endDate,
            page = 1,
            limit = 50
        } = req.query;

        let query = `
            SELECT 
                sl.*,
                u.fullname as staff_name,
                u.role as staff_role,
                u.email as staff_email,
                sp.payment_date as deducted_date
            FROM staff_loans sl
            JOIN users u ON sl.user_id = u.id
            LEFT JOIN salary_payments sp ON sl.deducted_on_payment_id = sp.id
            WHERE 1=1
        `;

        const params = [];
        let paramCount = 1;

        if (userId) {
            query += ` AND sl.user_id = $${paramCount}`;
            params.push(userId);
            paramCount++;
        }

        if (status === 'paid') {
            query += ` AND sl.is_paid = true`;
        } else if (status === 'unpaid') {
            query += ` AND sl.is_paid = false`;
        }

        if (startDate) {
            query += ` AND sl.loan_date >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
        }

        if (endDate) {
            query += ` AND sl.loan_date <= $${paramCount}`;
            params.push(endDate);
            paramCount++;
        }

        // Get total count
        const countQuery = `SELECT COUNT(*) FROM (${query}) as count_query`;
        const countResult = await db.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].count);

        // Add ordering and pagination
        query += ` ORDER BY sl.loan_date DESC, sl.created_at DESC`;

        const offset = (page - 1) * limit;
        query += ` LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
        params.push(parseInt(limit), offset);

        const result = await db.query(query, params);

        res.status(200).json({
            loans: result.rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                totalCount,
                totalPages: Math.ceil(totalCount / limit)
            }
        });

    } catch (error) {
        console.error('Error fetching loans:', error);
        res.status(500).json({ error: 'Failed to fetch loans.', details: error.message });
    }
});

// GET /api/salaries/loans/details/:userId - Get details of all outstanding loans for deduction
router.get('/loans/details/:userId', authenticate, async (req, res) => {
    const { userId } = req.params;
    try {
        const query = `
            SELECT id, amount, loan_date, reason
            FROM staff_loans
            WHERE user_id = $1 AND is_paid = FALSE
            ORDER BY loan_date ASC
        `;
        const result = await db.query(query, [userId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching outstanding loan details:', error);
        res.status(500).json({ error: 'Failed to fetch outstanding loan details.', details: error.message });
    }
});

// GET /api/salaries/loans/outstanding/:userId - Get total outstanding loan for a staff member
router.get('/loans/outstanding/:userId', authenticate, async (req, res) => {
    const { userId } = req.params;
    try {
        const query = `
            SELECT COALESCE(SUM(amount), 0) AS outstanding_loan_amount
            FROM staff_loans
            WHERE user_id = $1 AND is_paid = FALSE
        `;
        const result = await db.query(query, [userId]);
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching outstanding loan:', error);
        res.status(500).json({ error: 'Failed to fetch outstanding loan.', details: error.message });
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

// Add these routes to your existing salaries.js file

// GET /api/salaries/all-staff - Get all staff with salary information (both users and staff_members)
router.get('/all-staff', async (req, res) => {
    try {
        const {
            role,
            search,
            salaryType,
            minSalary,
            maxSalary,
            isActive = 'true',
            staffType
        } = req.query;

        // Query for users
        let usersQuery = `
            SELECT 
                u.id, u.username, u.fullname, u.email, u.phone_number, u.role, u.is_active,
                'user' as staff_type,
                COALESCE(ss.base_salary, 0) as base_salary,
                COALESCE(ss.allowances, 0) as allowances,
                COALESCE(ss.deductions, 0) as deductions,
                COALESCE(ss.net_salary, 0) as net_salary,
                ss.salary_type,
                ss.bank_name,
                ss.bank_account_name, -- Add this
                ss.account_number,
                ss.tax_rate,
                ss.pension_rate,
                ss.is_active as salary_active,
                (SELECT COUNT(*) FROM salary_payments sp WHERE sp.user_id = u.id AND sp.status = 'paid') as total_payments,
                (SELECT MAX(payment_date) FROM salary_payments sp WHERE sp.user_id = u.id AND sp.status = 'paid') as last_payment_date,
                (SELECT COALESCE(SUM(sl.amount), 0) FROM staff_loans sl WHERE sl.user_id = u.id AND sl.is_paid = FALSE) as outstanding_loan_amount
            FROM users u
            LEFT JOIN staff_salaries ss ON u.id = ss.user_id
            WHERE u.is_active = $1
        `;

        // Query for staff members
        let staffMembersQuery = `
            SELECT 
                sm.id, '' as username, sm.fullname, sm.email, sm.phone_number, 
                COALESCE(sm.position, 'staff') as role, sm.is_active,
                'staff_member' as staff_type,
                COALESCE(ss.base_salary, 0) as base_salary,
                COALESCE(ss.allowances, 0) as allowances,
                COALESCE(ss.deductions, 0) as deductions,
                COALESCE(ss.net_salary, 0) as net_salary,
                ss.salary_type,
                ss.bank_name,
                ss.bank_account_name, -- Add this
                ss.account_number,
                ss.tax_rate,
                ss.pension_rate,
                ss.is_active as salary_active,
                (SELECT COUNT(*) FROM salary_payments sp WHERE sp.staff_member_id = sm.id AND sp.status = 'paid') as total_payments,
                (SELECT MAX(payment_date) FROM salary_payments sp WHERE sp.staff_member_id = sm.id AND sp.status = 'paid') as last_payment_date,
                (SELECT COALESCE(SUM(sl.amount), 0) FROM staff_loans sl WHERE sl.staff_member_id = sm.id AND sl.is_paid = FALSE) as outstanding_loan_amount
            FROM staff_members sm
            LEFT JOIN staff_salaries ss ON sm.id = ss.staff_member_id
            WHERE sm.is_active = $1
        `;

        const userParams = [isActive === 'true'];
        const staffParams = [isActive === 'true'];
        let userParamCount = 2;
        let staffParamCount = 2;

        // Add filters to both queries
        const addFilters = (query, params, paramCount, staffType) => {
            if (role && staffType !== 'staff_member') {
                query += ` AND u.role = $${paramCount}`;
                params.push(role);
                paramCount++;
            } else if (role && staffType === 'staff_member') {
                query += ` AND sm.position = $${paramCount}`;
                params.push(role);
                paramCount++;
            }

            if (search && staffType !== 'staff_member') {
                query += ` AND (u.fullname ILIKE $${paramCount} OR u.email ILIKE $${paramCount} OR u.username ILIKE $${paramCount})`;
                params.push(`%${search}%`);
                paramCount++;
            } else if (search && staffType === 'staff_member') {
                query += ` AND (sm.fullname ILIKE $${paramCount} OR sm.email ILIKE $${paramCount})`;
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

            return { query, params, paramCount };
        };

        // Apply filters to both queries
        let usersResult = addFilters(usersQuery, userParams, userParamCount, 'user');
        let staffResult = addFilters(staffMembersQuery, staffParams, staffParamCount, 'staff_member');

        usersQuery = usersResult.query + ` ORDER BY u.fullname`;
        staffMembersQuery = staffResult.query + ` ORDER BY sm.fullname`;

        // Execute queries
        const [usersData, staffMembersData] = await Promise.all([
            db.query(usersQuery, usersResult.params),
            db.query(staffMembersQuery, staffResult.params)
        ]);

        // Combine results
        let allStaff = [
            ...usersData.rows,
            ...staffMembersData.rows
        ];

        // Filter by staff type if specified
        if (staffType) {
            allStaff = allStaff.filter(staff => staff.staff_type === staffType);
        }

        res.status(200).json(allStaff);
    } catch (error) {
        console.error('Error fetching all staff salaries:', error);
        res.status(500).json({ error: 'Failed to fetch staff salaries.', details: error.message });
    }
});

// POST /api/salaries/staff/:type/:id/salary - FIXED VERSION
router.post('/staff/:type/:id/salary', async (req, res) => {
    const { type, id } = req.params;
    const {
        base_salary,
        allowances,
        deductions,
        salary_type,
        bank_name,
        bank_account_name,
        account_number,
        tax_rate,
        pension_rate
    } = req.body;

    console.log('Salary update request:', { type, id, formData: req.body });

    try {
        const staffId = parseInt(id);
        
        // Simple validation
        if (type !== 'user' && type !== 'staff_member') {
            return res.status(400).json({ error: 'Invalid staff type' });
        }

        if (isNaN(staffId)) {
            return res.status(400).json({ error: 'Invalid staff ID' });
        }

        // Check if staff exists
        const staffCheck = type === 'user' 
            ? await db.query('SELECT id, fullname FROM users WHERE id = $1', [staffId])
            : await db.query('SELECT id, fullname FROM staff_members WHERE id = $1', [staffId]);
            
        if (staffCheck.rows.length === 0) {
            return res.status(404).json({ error: 'Staff not found' });
        }

        console.log('Staff found:', staffCheck.rows[0]);

        // Calculate values
        const netSalary = (parseFloat(base_salary) || 0) + 
                         (parseFloat(allowances) || 0) - 
                         (parseFloat(deductions) || 0);

        // Prepare values array
        const values = [
            parseFloat(base_salary) || 0,
            parseFloat(allowances) || 0,
            parseFloat(deductions) || 0,
            netSalary,
            salary_type || 'monthly',
            bank_name || '',
            bank_account_name || '',
            account_number || '',
            parseFloat(tax_rate) || 0,
            parseFloat(pension_rate) || 0
        ];

        // Build the query based on staff type
        let updateQuery, insertQuery;

        if (type === 'user') {
            updateQuery = `
                UPDATE staff_salaries 
                SET base_salary = $1, allowances = $2, deductions = $3, net_salary = $4,
                    salary_type = $5, bank_name = $6, bank_account_name = $7, account_number = $8,
                    tax_rate = $9, pension_rate = $10, updated_at = CURRENT_TIMESTAMP
                WHERE user_id = $11
                RETURNING *
            `;
            insertQuery = `
                INSERT INTO staff_salaries (
                    user_id, base_salary, allowances, deductions, net_salary,
                    salary_type, bank_name, bank_account_name, account_number, tax_rate, pension_rate
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING *
            `;
        } else {
            updateQuery = `
                UPDATE staff_salaries 
                SET base_salary = $1, allowances = $2, deductions = $3, net_salary = $4,
                    salary_type = $5, bank_name = $6, bank_account_name = $7, account_number = $8,
                    tax_rate = $9, pension_rate = $10, updated_at = CURRENT_TIMESTAMP
                WHERE staff_member_id = $11
                RETURNING *
            `;
            insertQuery = `
                INSERT INTO staff_salaries (
                    staff_member_id, base_salary, allowances, deductions, net_salary,
                    salary_type, bank_name, bank_account_name, account_number, tax_rate, pension_rate
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                RETURNING *
            `;
        }

        // Try to update first
        const updateValues = [...values, staffId];
        console.log('Update query:', updateQuery);
        console.log('Update values:', updateValues);

        const updateResult = await db.query(updateQuery, updateValues);

        if (updateResult.rows.length > 0) {
            // Update successful
            console.log('Salary updated successfully:', updateResult.rows[0]);
            res.status(200).json(updateResult.rows[0]);
        } else {
            // No existing record, insert new one
            const insertValues = [staffId, ...values];
            console.log('Insert query:', insertQuery);
            console.log('Insert values:', insertValues);
            
            const insertResult = await db.query(insertQuery, insertValues);
            
            console.log('Salary inserted successfully:', insertResult.rows[0]);
            res.status(200).json(insertResult.rows[0]);
        }

    } catch (error) {
        console.error('Salary update error:', error);
        res.status(500).json({ 
            error: 'Failed to update salary',
            details: error.message,
            hint: 'Check that all required fields are provided and values are valid numbers.'
        });
    }
});

// routes/salaries.js

// PUT /api/salaries/staff/:staffType/:staffId/salary - Update or Insert salary structure
// router.put('/staff/:staffType/:staffId/salary', authenticate.verifyToken, authenticate.checkRole(['admin', 'manager', 'accountant']), async (req, res) => {
//     const { staffId } = req.params;
    
//     // Safely extract and default text fields to '' to prevent errors if they are missing/undefined in req.body
//     const {
//         base_salary, 
//         allowances, 
//         deductions, 
//         salary_type = 'monthly', // Default to 'monthly' if missing
//         bank_name = '', 
//         bank_account_name = '', // Crucially, ensure this defaults to ''
//         account_number = '', 
//         tax_rate, 
//         pension_rate
//     } = req.body;

//     if (!base_salary || !staffId) {
//         return res.status(400).json({ error: 'Base salary and staff ID are required.' });
//     }

//     try {
//         // Parse all numeric fields to prevent database conversion errors
//         const parsedBaseSalary = parseFloat(base_salary) || 0;
//         const parsedAllowances = parseFloat(allowances) || 0;
//         const parsedDeductions = parseFloat(deductions) || 0;
//         const parsedTaxRate = parseFloat(tax_rate) || 0;
//         const parsedPensionRate = parseFloat(pension_rate) || 0;

//         // Calculate net salary
//         const net_salary = parsedBaseSalary + parsedAllowances - parsedDeductions;

//         // The values array (10 elements: $1 to $10 in UPDATE, $2 to $11 in INSERT)
//         const values = [
//             parsedBaseSalary,
//             parsedAllowances,
//             parsedDeductions,
//             salary_type,
//             bank_name,
//             bank_account_name, 
//             account_number,
//             parsedTaxRate,
//             parsedPensionRate,
//             net_salary
//         ];

//         // SQL Queries (ensuring parameter counts are correct)
//         let updateQuery = `
//             UPDATE staff_salaries
//             SET
//                 base_salary = $1, allowances = $2, deductions = $3, salary_type = $4,
//                 bank_name = $5, bank_account_name = $6, account_number = $7,
//                 tax_rate = $8, pension_rate = $9, net_salary = $10,
//                 updated_at = CURRENT_TIMESTAMP
//             WHERE user_id = $11
//             RETURNING *
//         `;

//         let insertQuery = `
//             INSERT INTO staff_salaries (
//                 user_id, base_salary, allowances, deductions, salary_type, bank_name,
//                 bank_account_name, account_number, tax_rate, pension_rate, net_salary
//             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
//             RETURNING *
//         `;

//         // Try to update first
//         // updateValues = [value1, ..., value10, staffId] (11 params)
//         const updateValues = [...values, staffId]; 
//         const updateResult = await db.query(updateQuery, updateValues);

//         if (updateResult.rows.length > 0) {
//             // Update successful
//             res.status(200).json(updateResult.rows[0]);
//         } else {
//             // No existing record, insert new one
//             // insertValues = [staffId, value1, ..., value10] (11 params)
//             const insertValues = [staffId, ...values]; 
//             const insertResult = await db.query(insertQuery, insertValues);

//             res.status(200).json(insertResult.rows[0]);
//         }

//     } catch (error) {
//         console.error('Salary update error:', error);
//         // Return a detailed error message if possible (helpful for debugging)
//         res.status(500).json({ 
//             error: 'Failed to update salary',
//             details: error.message
//         });
//     }
// });

module.exports = router;