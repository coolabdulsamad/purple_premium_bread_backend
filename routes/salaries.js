// routes/salaries.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const authenticate = require('../middleware/authenticate');
const { recordMoneyTransaction } = require('../utils/money');

// ---------------------------------------------------------------------------
// Schema guards (migration 002 adds the loan repayment schedule, the
// loan_repayments ledger and the salary credit-sales deduction column; every
// route falls back to legacy behavior until the migration is applied)
// ---------------------------------------------------------------------------
let loanScheduleReady = null;
async function ensureLoanSchedule() {
    if (loanScheduleReady !== null) return loanScheduleReady;
    try {
        const r = await db.query(`
            SELECT
              (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_name = 'staff_loans'
                   AND column_name IN ('repayment_months','monthly_deduction','remaining_balance','status','due_date','start_date')) AS cols,
              (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'loan_repayments') AS ledger,
              (SELECT COUNT(*) FROM information_schema.columns
                 WHERE table_name = 'salary_payments' AND column_name = 'credit_sales_deduction') AS csd
        `);
        const row = r.rows[0];
        loanScheduleReady = Number(row.cols) >= 6 && Number(row.ledger) > 0 && Number(row.csd) > 0;
    } catch (e) {
        loanScheduleReady = false;
    }
    return loanScheduleReady;
}

let creditLinkReady = null;
async function ensureCreditLink() {
    if (creditLinkReady !== null) return creditLinkReady;
    try {
        const r = await db.query(`
            SELECT COUNT(*) AS c FROM information_schema.columns
            WHERE table_name = 'customers' AND column_name IN ('user_id','staff_member_id')
        `);
        creditLinkReady = Number(r.rows[0].c) >= 2;
    } catch (e) {
        creditLinkReady = false;
    }
    return creditLinkReady;
}

// Find the customer record linked to a user / staff member; auto-provision one
// (staff are customers too - they can buy bread on credit) when none exists.
async function getOrCreateStaffCustomer(client, staffID, isStaffMember) {
    const linkCol = isStaffMember ? 'staff_member_id' : 'user_id';
    const found = await client.query(
        `SELECT id FROM customers WHERE ${linkCol} = $1 ORDER BY id LIMIT 1 FOR UPDATE`,
        [staffID]
    );
    if (found.rows.length > 0) return found.rows[0].id;

    const src = isStaffMember
        ? await client.query('SELECT fullname, phone_number, email FROM staff_members WHERE id = $1', [staffID])
        : await client.query('SELECT fullname, phone_number, email FROM users WHERE id = $1', [staffID]);
    if (src.rows.length === 0) return null;

    const p = src.rows[0];
    const ins = await client.query(
        `INSERT INTO customers (fullname, phone, email, balance, advance_balance, credit_limit, is_active, is_rider, ${linkCol})
         VALUES ($1, $2, $3, 0, 0, 0, true, false, $4)
         RETURNING id`,
        [p.fullname || `Staff #${staffID}`, p.phone_number || null, p.email || null, staffID]
    );
    return ins.rows[0].id;
}

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

        const scheduleReady = await ensureLoanSchedule();
        const outstandingLoanSubquery = scheduleReady
            ? `(SELECT COALESCE(SUM(COALESCE(sl.remaining_balance, sl.amount)), 0) FROM staff_loans sl WHERE sl.user_id = u.id AND sl.is_paid = FALSE) as outstanding_loan_amount`
            : `(SELECT COALESCE(SUM(sl.amount), 0) FROM staff_loans sl WHERE sl.user_id = u.id AND sl.is_paid = FALSE) as outstanding_loan_amount`;

        let query = `
            SELECT
                u.id, u.username, u.fullname, u.email, u.phone_number, u.role, u.is_active,
                COALESCE(ss.base_salary, 0) as base_salary,
                COALESCE(ss.allowances, 0) as allowances,
                COALESCE(ss.deductions, 0) as deductions,
                COALESCE(ss.net_salary, 0) as net_salary,
                ss.salary_type,
                ss.bank_name,
                ss.bank_account_name,
                ss.account_number,
                ss.tax_rate,
                ss.pension_rate,
                ss.is_active as salary_active,
                (SELECT COUNT(*) FROM salary_payments sp WHERE sp.user_id = u.id AND sp.status = 'paid') as total_payments,
                (SELECT MAX(payment_date) FROM salary_payments sp WHERE sp.user_id = u.id AND sp.status = 'paid') as last_payment_date,
                ${outstandingLoanSubquery}
            FROM users u
            LEFT JOIN staff_salaries ss ON u.id = ss.user_id
            WHERE u.is_active = $1
        `;

        const params = [isActive === 'true'];
        let paramCount = 2;

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
                COALESCE(sm.fullname, u.fullname) as staff_name,
                COALESCE(sm.position, u.role) as staff_role,
                COALESCE(u.email, sm.email) as staff_email,
                paid_by_user.fullname as paid_by_name
            FROM salary_payments sp
            LEFT JOIN staff_members sm ON sp.staff_member_id = sm.id
            LEFT JOIN users u ON sp.user_id = u.id
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

        if (staffRole) {
            query += ` AND u.role = $${paramCount}`;
            params.push(staffRole);
            paramCount++;
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

        if (search) {
            query += ` AND (
                u.fullname ILIKE $${paramCount} OR
                sm.fullname ILIKE $${paramCount} OR
                u.email ILIKE $${paramCount} OR
                sp.payment_reference ILIKE $${paramCount} OR
                sp.notes ILIKE $${paramCount}
            )`;
            params.push(`%${search}%`);
            paramCount++;
        }

        const countQuery = `SELECT COUNT(*) FROM (${query}) as count_query`;
        const countResult = await db.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].count);

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

// GET /api/salaries/payments/:id - Get single salary payment details
router.get('/payments/:id', async (req, res) => {
    const paymentId = req.params.id;

    if (isNaN(parseInt(paymentId))) {
        return res.status(400).json({ error: 'Invalid payment ID.' });
    }

    try {
        const query = `
            SELECT
                sp.*,
                COALESCE(sm.fullname, u.fullname) as staff_name,
                COALESCE(sm.position, u.role) as staff_role,
                COALESCE(u.email, sm.email) as staff_email,
                paid_by_user.fullname as paid_by_name
            FROM salary_payments sp
            LEFT JOIN staff_members sm ON sp.staff_member_id = sm.id
            LEFT JOIN users u ON sp.user_id = u.id
            LEFT JOIN users paid_by_user ON sp.paid_by = paid_by_user.id
            WHERE sp.id = $1
        `;

        const result = await db.query(query, [paymentId]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Salary payment not found.' });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error('Error fetching salary payment details:', error);
        res.status(500).json({ error: 'Failed to fetch salary payment details.', details: error.message });
    }
});

// POST /api/salaries/payments - Record a salary payment
// Enhancements (all backward compatible):
//  - loan_deduction without explicit loan_ids auto-allocates across the staff member's
//    unpaid loans (oldest first), decrementing remaining_balance per loan and completing
//    loans when fully repaid (after migration 002; legacy behavior before it).
//  - credit_sales_deduction allocates oldest-first against the staff member's unpaid credit
//    sales (via their linked customer record) and records real payment rows.
//  - The net cash paid out is mirrored into Money Management.
router.post('/payments', authenticate, async (req, res) => {
    const paid_by = parseInt(req.user.id);
    if (!paid_by || isNaN(paid_by)) {
        return res.status(403).json({ error: 'Unauthorized', details: 'Authenticated user ID is missing or invalid.' });
    }

    const {
        user_id,
        staff_type,
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
        loan_ids,
        credit_sales_deduction,
        sale_ids
    } = req.body;

    if (!user_id || !payment_date || !base_salary || !net_amount) {
        return res.status(400).json({ error: 'Missing required fields for payment.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const scheduleReady = await ensureLoanSchedule();
        const linkReady = await ensureCreditLink();

        const staffID = parseInt(user_id);
        let payment_user_id = null;
        let payment_staff_member_id = null;

        const isStaffMember = staff_type && String(staff_type).toLowerCase() === 'staff_member';
        if (isStaffMember) {
            payment_staff_member_id = staffID;
        } else {
            payment_user_id = staffID;
        }

        const gross_amount = parseFloat(base_salary || 0) + parseFloat(allowances || 0);
        const loanDeduction = Math.max(0, parseFloat(loan_deduction) || 0);
        const creditSalesDeduction = Math.max(0, parseFloat(credit_sales_deduction) || 0);

        // 1. Insert the salary payment record
        let paymentQuery, paymentParams;
        if (scheduleReady) {
            paymentQuery = `
                INSERT INTO salary_payments
                    (user_id, staff_member_id, salary_period, payment_date, base_salary, allowances,
                     deductions, tax_amount, pension_amount, net_amount, gross_amount,
                     payment_method, payment_reference, notes, paid_by, status, created_at,
                     loan_deduction, credit_sales_deduction)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'paid', CURRENT_TIMESTAMP, $16, $17)
                RETURNING id
            `;
            paymentParams = [
                payment_user_id, payment_staff_member_id,
                salary_period || payment_date, payment_date,
                parseFloat(base_salary || 0), parseFloat(allowances || 0),
                parseFloat(deductions || 0), parseFloat(tax_amount || 0),
                parseFloat(pension_amount || 0), parseFloat(net_amount), gross_amount,
                payment_method, payment_reference, notes, paid_by,
                loanDeduction, creditSalesDeduction
            ];
        } else {
            paymentQuery = `
                INSERT INTO salary_payments
                    (user_id, staff_member_id, salary_period, payment_date, base_salary, allowances,
                     deductions, tax_amount, pension_amount, net_amount, gross_amount,
                     payment_method, payment_reference, notes, paid_by, status, created_at, loan_deduction)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'paid', CURRENT_TIMESTAMP, $16)
                RETURNING id
            `;
            paymentParams = [
                payment_user_id, payment_staff_member_id,
                salary_period || payment_date, payment_date,
                parseFloat(base_salary || 0), parseFloat(allowances || 0),
                parseFloat(deductions || 0), parseFloat(tax_amount || 0),
                parseFloat(pension_amount || 0), parseFloat(net_amount), gross_amount,
                payment_method, payment_reference, notes, paid_by,
                loanDeduction
            ];
        }

        const paymentResult = await client.query(paymentQuery, paymentParams);
        const newPaymentId = paymentResult.rows[0].id;

        // 2. Process the loan deduction
        if (loanDeduction > 0) {
            let loanIdList = Array.isArray(loan_ids) ? loan_ids.map(Number).filter((n) => !isNaN(n)) : [];

            if (loanIdList.length === 0) {
                const idCol = payment_user_id ? 'user_id' : 'staff_member_id';
                const idVal = payment_user_id || payment_staff_member_id;
                const autoLoans = await client.query(
                    `SELECT id FROM staff_loans WHERE ${idCol} = $1 AND is_paid = FALSE ORDER BY loan_date ASC, id ASC`,
                    [idVal]
                );
                loanIdList = autoLoans.rows.map((r) => r.id);
            }

            if (scheduleReady) {
                // Sequential allocation: oldest loans first, partial deductions supported
                let remainingDeduction = loanDeduction;
                for (const loanId of loanIdList) {
                    if (remainingDeduction <= 0) break;

                    const loanRes = await client.query(
                        'SELECT id, amount, remaining_balance FROM staff_loans WHERE id = $1 AND is_paid = FALSE FOR UPDATE',
                        [loanId]
                    );
                    if (loanRes.rows.length === 0) continue;

                    const loan = loanRes.rows[0];
                    const outstandingBefore = parseFloat(loan.remaining_balance != null ? loan.remaining_balance : loan.amount);
                    const payAmt = Math.min(remainingDeduction, outstandingBefore);
                    if (payAmt <= 0) continue;

                    const newRemaining = outstandingBefore - payAmt;
                    const completed = newRemaining <= 0;
                    await client.query(
                        `UPDATE staff_loans
                         SET remaining_balance = $1,
                             is_paid = $2,
                             status = $3,
                             deducted_on_payment_id = $4,
                             completed_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE completed_at END,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $5`,
                        [newRemaining, completed, completed ? 'completed' : 'active', newPaymentId, loanId]
                    );

                    await client.query(
                        'INSERT INTO loan_repayments (loan_id, amount, payment_date, salary_payment_id, notes) VALUES ($1, $2, $3, $4, $5)',
                        [loanId, payAmt, payment_date, newPaymentId, 'Deduction from salary payment']
                    );

                    remainingDeduction -= payAmt;
                }
            } else if (loanIdList.length > 0) {
                // Legacy behavior: mark the selected loans fully paid
                const idCondition = payment_user_id ? 'user_id = $3' : 'staff_member_id = $3';
                const idValue = payment_user_id || payment_staff_member_id;
                await client.query(
                    `UPDATE staff_loans
                     SET is_paid = TRUE, deducted_on_payment_id = $1, updated_at = CURRENT_TIMESTAMP
                     WHERE id = ANY($2) AND ${idCondition} AND is_paid = FALSE`,
                    [newPaymentId, loanIdList, idValue]
                );
            }
        }

        // 3. Staff credit-sales deduction -> allocate oldest-first across unpaid credit sales
        let creditAllocated = 0;
        const creditAllocations = [];
        if (creditSalesDeduction > 0 && linkReady) {
            const linkCol = isStaffMember ? 'staff_member_id' : 'user_id';
            const custRes = await client.query(
                `SELECT id FROM customers WHERE ${linkCol} = $1 ORDER BY id LIMIT 1 FOR UPDATE`,
                [staffID]
            );

            if (custRes.rows.length > 0) {
                const staffCustomerId = custRes.rows[0].id;
                const saleIdList = Array.isArray(sale_ids) ? sale_ids.map(Number).filter((n) => !isNaN(n) && n > 0) : [];
                const unpaidSales = saleIdList.length > 0
                    ? await client.query(
                        `SELECT id, balance_due FROM sales_transactions
                         WHERE customer_id = $1 AND balance_due > 0 AND id = ANY($2)
                         ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC FOR UPDATE`,
                        [staffCustomerId, saleIdList]
                    )
                    : await client.query(
                        `SELECT id, balance_due FROM sales_transactions
                         WHERE customer_id = $1 AND balance_due > 0
                         ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC FOR UPDATE`,
                        [staffCustomerId]
                    );

                let remainingCredit = creditSalesDeduction;
                for (const sale of unpaidSales.rows) {
                    if (remainingCredit <= 0) break;
                    const pay = Math.min(remainingCredit, parseFloat(sale.balance_due));
                    if (pay <= 0) continue;

                    const pmt = await client.query(
                        `INSERT INTO payments (transaction_id, customer_id, amount, payment_date, payment_method, is_rider_payment)
                         VALUES ($1, $2, $3, $4, 'Salary Deduction', FALSE)
                         RETURNING id`,
                        [sale.id, staffCustomerId, pay, payment_date]
                    );

                    await client.query(
                        `UPDATE sales_transactions
                         SET amount_paid = amount_paid + $1,
                             balance_due = balance_due - $1,
                             status = CASE WHEN balance_due - $1 <= 0 THEN 'Paid' ELSE 'Partially Paid' END,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $2`,
                        [pay, sale.id]
                    );

                    creditAllocations.push({ sale_id: sale.id, payment_id: pmt.rows[0].id, allocated: pay });
                    remainingCredit -= pay;
                }

                creditAllocated = Math.round((creditSalesDeduction - remainingCredit) * 100) / 100;

                if (creditAllocated > 0) {
                    await client.query(
                        'UPDATE customers SET balance = GREATEST(balance - $1, 0) WHERE id = $2',
                        [creditAllocated, staffCustomerId]
                    );
                }
            }

            if (isStaffMember) {
                await client.query(
                    'UPDATE staff_members SET current_balance = GREATEST(current_balance - $1, 0) WHERE id = $2',
                    [creditAllocated > 0 ? creditAllocated : creditSalesDeduction, staffID]
                );
            }
        }

        await client.query('COMMIT');

        // 4. Mirror the net cash paid out into Money Management (fail-open)
        await recordMoneyTransaction({
            direction: 'OUT',
            amount: parseFloat(net_amount),
            category: 'salary_payment',
            payment_method: payment_method || 'bank_transfer',
            reference_type: 'salary_payment',
            reference_id: newPaymentId,
            description: `Salary payment${salary_period ? ` (${salary_period})` : ''} — net paid out`,
            transaction_date: payment_date,
            recorded_by: paid_by,
            approval_id: req.approvalBypassId || null
        });

        // 5. Return the complete payment record (original response shape + allocation info)
        const completeResult = await db.query(
            `SELECT sp.*, u.fullname as staff_name, u.role as staff_role
             FROM salary_payments sp
             LEFT JOIN users u ON u.id = COALESCE(sp.user_id, sp.staff_member_id)
             WHERE sp.id = $1`,
            [newPaymentId]
        );

        res.status(201).json({
            ...completeResult.rows[0],
            credit_allocated: creditAllocated,
            credit_allocations: creditAllocations
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error processing salary payment:', error);
        res.status(500).json({ error: 'Failed to process salary payment.', details: error.message });
    } finally {
        client.release();
    }
});

// POST /api/salaries/loans - Record a new staff loan/advance (with optional repayment schedule)
router.post('/loans', authenticate, async (req, res) => {
    const {
        user_id: borrower_id,
        staff_type,
        loan_date,
        amount,
        reason,
        repayment_months,
        start_date,
        due_date,
        payment_method = 'Cash'
    } = req.body;

    if (!borrower_id || !loan_date || !amount) {
        return res.status(400).json({ error: 'Missing required fields: user_id (borrower_id), loan_date, and amount.' });
    }

    if (parseFloat(amount) <= 0) {
        return res.status(400).json({ error: 'Loan amount must be greater than zero.' });
    }

    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        let user_id_value = null;
        let staff_member_id_value = null;

        if (staff_type === 'staff_member') {
            const staffCheckResult = await client.query(
                'SELECT id FROM staff_members WHERE id = $1 AND is_active = true',
                [borrower_id]
            );
            if (staffCheckResult.rows.length > 0) {
                staff_member_id_value = borrower_id;
            } else {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    error: 'Staff member not found.',
                    details: `ID ${borrower_id} not found in staff_members table.`
                });
            }
        } else if (staff_type === 'user') {
            const userCheckResult = await client.query(
                'SELECT id FROM users WHERE id = $1 AND is_active = true',
                [borrower_id]
            );
            if (userCheckResult.rows.length > 0) {
                user_id_value = borrower_id;
            } else {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    error: 'User not found.',
                    details: `ID ${borrower_id} not found in users table.`
                });
            }
        } else {
            const staffCheckResult = await client.query(
                'SELECT id FROM staff_members WHERE id = $1 AND is_active = true',
                [borrower_id]
            );
            if (staffCheckResult.rows.length > 0) {
                staff_member_id_value = borrower_id;
            } else {
                const userCheckResult = await client.query(
                    'SELECT id FROM users WHERE id = $1 AND is_active = true',
                    [borrower_id]
                );
                if (userCheckResult.rows.length > 0) {
                    user_id_value = borrower_id;
                } else {
                    await client.query('ROLLBACK');
                    return res.status(404).json({
                        error: 'Staff member not found.',
                        details: `ID ${borrower_id} not found in users or staff_members table.`
                    });
                }
            }
        }

        const loanAmount = parseFloat(amount);
        const months = parseInt(repayment_months);
        const scheduleReady = await ensureLoanSchedule();

        let result;
        if (scheduleReady) {
            const monthly = months > 0 ? Math.round((loanAmount / months) * 100) / 100 : loanAmount;
            result = await client.query(
                `INSERT INTO staff_loans
                    (user_id, staff_member_id, loan_date, amount, reason, created_at,
                     repayment_months, monthly_deduction, remaining_balance, start_date, due_date, status)
                 VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, $6, $7, $8, $9, $10, 'active')
                 RETURNING *`,
                [
                    user_id_value,
                    staff_member_id_value,
                    loan_date,
                    loanAmount,
                    reason,
                    months > 0 ? months : null,
                    monthly,
                    loanAmount,
                    start_date || loan_date,
                    due_date || null
                ]
            );
        } else {
            result = await client.query(
                `INSERT INTO staff_loans
                    (user_id, staff_member_id, loan_date, amount, reason, created_at)
                 VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)
                 RETURNING *`,
                [user_id_value, staff_member_id_value, loan_date, loanAmount, reason]
            );
        }

        await client.query('COMMIT');

        // Mirror the cash handed out into Money Management (fail-open)
        await recordMoneyTransaction({
            direction: 'OUT',
            amount: loanAmount,
            category: 'loan_disbursement',
            payment_method,
            reference_type: 'staff_loan',
            reference_id: result.rows[0].id,
            description: `Staff loan disbursed${months > 0 ? ` — repayable over ${months} month(s)` : ''}`,
            transaction_date: loan_date,
            recorded_by: req.user ? req.user.id : null,
            approval_id: req.approvalBypassId || null
        });

        // Return the loan record with staff information
        const loanWithStaff = await db.query(
            `SELECT
                sl.*,
                COALESCE(u.fullname, sm.fullname) as borrower_name,
                COALESCE(u.role, sm.position) as borrower_role,
                COALESCE(u.email, sm.email) as borrower_email,
                CASE
                    WHEN sl.user_id IS NOT NULL THEN 'user'
                    WHEN sl.staff_member_id IS NOT NULL THEN 'staff_member'
                    ELSE 'unknown'
                END as staff_type
             FROM staff_loans sl
             LEFT JOIN users u ON sl.user_id = u.id
             LEFT JOIN staff_members sm ON sl.staff_member_id = sm.id
             WHERE sl.id = $1`,
            [result.rows[0].id]
        );

        res.status(201).json(loanWithStaff.rows[0]);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error recording staff loan:', error);
        res.status(500).json({
            error: 'Failed to record staff loan.',
            details: error.message
        });
    } finally {
        client.release();
    }
});

// PUT /api/salaries/loans/:loanId - Update a loan, including its repayment schedule
router.put('/loans/:loanId', authenticate, async (req, res) => {
    const { loanId } = req.params;
    const { amount, loan_date, reason, is_paid, repayment_months, start_date, due_date } = req.body;

    try {
        const current = await db.query('SELECT * FROM staff_loans WHERE id = $1', [loanId]);
        if (current.rows.length === 0) {
            return res.status(404).json({ error: 'Loan not found.' });
        }
        const loan = current.rows[0];
        const scheduleReady = await ensureLoanSchedule();

        if (scheduleReady) {
            const newAmount = amount !== undefined ? parseFloat(amount) : parseFloat(loan.amount);
            const months = repayment_months !== undefined
                ? parseInt(repayment_months)
                : (loan.repayment_months ? parseInt(loan.repayment_months) : null);
            const remaining = loan.remaining_balance != null ? parseFloat(loan.remaining_balance) : newAmount;
            // Recompute the installment from what is left to repay
            const monthly = months > 0 ? Math.round((remaining / months) * 100) / 100 : remaining;
            const paid = is_paid !== undefined ? !!is_paid : loan.is_paid;

            const result = await db.query(
                `UPDATE staff_loans
                 SET amount = $1, loan_date = $2, reason = $3, is_paid = $4,
                     repayment_months = $5, monthly_deduction = $6, start_date = $7, due_date = $8,
                     status = CASE WHEN $4 THEN 'completed' ELSE 'active' END,
                     completed_at = CASE WHEN $4 THEN COALESCE(completed_at, CURRENT_TIMESTAMP) ELSE NULL END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $9
                 RETURNING *`,
                [
                    newAmount,
                    loan_date || loan.loan_date,
                    reason !== undefined ? reason : loan.reason,
                    paid,
                    months > 0 ? months : null,
                    monthly,
                    start_date || loan.start_date || loan.loan_date,
                    due_date !== undefined ? due_date : loan.due_date,
                    loanId
                ]
            );
            return res.json(result.rows[0]);
        }

        const result = await db.query(
            `UPDATE staff_loans
             SET amount = $1, loan_date = $2, reason = $3, is_paid = $4, updated_at = CURRENT_TIMESTAMP
             WHERE id = $5
             RETURNING *`,
            [
                amount !== undefined ? parseFloat(amount) : loan.amount,
                loan_date || loan.loan_date,
                reason !== undefined ? reason : loan.reason,
                is_paid !== undefined ? !!is_paid : loan.is_paid,
                loanId
            ]
        );
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error updating loan:', error);
        res.status(500).json({ error: 'Failed to update loan.', details: error.message });
    }
});

// POST /api/salaries/loans/:loanId/repay - Record a manual (cash) loan repayment
router.post('/loans/:loanId/repay', authenticate, async (req, res) => {
    const { loanId } = req.params;
    const { amount, payment_date, notes, payment_method = 'Cash' } = req.body;

    const payAmount = parseFloat(amount);
    if (isNaN(payAmount) || payAmount <= 0) {
        return res.status(400).json({ error: 'A positive repayment amount is required.' });
    }

    const scheduleReady = await ensureLoanSchedule();
    if (!scheduleReady) {
        return res.status(503).json({ error: 'Loan repayment tracking requires migration 002 to be applied.' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const loanRes = await client.query(
            'SELECT id, amount, remaining_balance, is_paid FROM staff_loans WHERE id = $1 FOR UPDATE',
            [loanId]
        );
        if (loanRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Loan not found.' });
        }

        const loan = loanRes.rows[0];
        const outstanding = parseFloat(loan.remaining_balance != null ? loan.remaining_balance : loan.amount);
        const applied = Math.min(payAmount, outstanding);
        const newRemaining = Math.max(0, outstanding - applied);
        const completed = newRemaining <= 0;

        const repayment = await client.query(
            'INSERT INTO loan_repayments (loan_id, amount, payment_date, notes) VALUES ($1, $2, $3, $4) RETURNING *',
            [loanId, applied, payment_date || new Date().toISOString().split('T')[0], notes || null]
        );

        await client.query(
            `UPDATE staff_loans
             SET remaining_balance = $1,
                 is_paid = $2,
                 status = $3,
                 completed_at = CASE WHEN $2 THEN CURRENT_TIMESTAMP ELSE completed_at END,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $4`,
            [newRemaining, completed, completed ? 'completed' : 'active', loanId]
        );

        await client.query('COMMIT');

        // A manual repayment is cash coming back in
        await recordMoneyTransaction({
            direction: 'IN',
            amount: applied,
            category: 'debt_payment',
            payment_method,
            reference_type: 'loan_repayment',
            reference_id: repayment.rows[0].id,
            description: `Manual repayment on staff loan #${loanId}`,
            transaction_date: payment_date || null,
            recorded_by: req.user ? req.user.id : null,
            approval_id: req.approvalBypassId || null
        });

        res.status(201).json({
            message: completed ? 'Repayment recorded — loan fully repaid.' : 'Repayment recorded.',
            repayment: repayment.rows[0],
            remaining_balance: newRemaining,
            is_paid: completed
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error recording loan repayment:', error);
        res.status(500).json({ error: 'Failed to record loan repayment.', details: error.message });
    } finally {
        client.release();
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
                CASE
                    WHEN sl.user_id IS NOT NULL THEN u.fullname
                    WHEN sl.staff_member_id IS NOT NULL THEN sm.fullname
                    ELSE 'Unknown Staff'
                END as borrower_name,
                CASE
                    WHEN sl.user_id IS NOT NULL THEN u.role
                    WHEN sl.staff_member_id IS NOT NULL THEN sm.position
                    ELSE 'Unknown Role'
                END as borrower_role,
                CASE
                    WHEN sl.user_id IS NOT NULL THEN u.email
                    WHEN sl.staff_member_id IS NOT NULL THEN sm.email
                    ELSE NULL
                END as borrower_email,
                CASE
                    WHEN sl.user_id IS NOT NULL THEN 'user'
                    WHEN sl.staff_member_id IS NOT NULL THEN 'staff_member'
                    ELSE 'unknown'
                END as staff_type,
                sp.payment_date as deducted_date
            FROM staff_loans sl
            LEFT JOIN users u ON sl.user_id = u.id
            LEFT JOIN staff_members sm ON sl.staff_member_id = sm.id
            LEFT JOIN salary_payments sp ON sl.deducted_on_payment_id = sp.id
            WHERE 1=1
        `;

        const params = [];
        let paramCount = 1;

        if (userId) {
            query += ` AND (sl.user_id = $${paramCount} OR sl.staff_member_id = $${paramCount})`;
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

        const countQuery = `SELECT COUNT(*) FROM (${query}) as count_query`;
        const countResult = await db.query(countQuery, params);
        const totalCount = parseInt(countResult.rows[0].count);

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

// GET /api/salaries/loans/details/:userId - Outstanding loans for deduction (repayment-schedule aware)
router.get('/loans/details/:userId', authenticate, async (req, res) => {
    const { userId } = req.params;
    try {
        const scheduleReady = await ensureLoanSchedule();
        const query = scheduleReady
            ? `
                SELECT
                    sl.id,
                    sl.amount,
                    COALESCE(sl.remaining_balance, sl.amount) AS outstanding,
                    sl.repayment_months,
                    COALESCE(sl.monthly_deduction, COALESCE(sl.remaining_balance, sl.amount)) AS monthly_deduction,
                    sl.start_date,
                    sl.loan_date,
                    sl.reason,
                    CASE
                        WHEN sl.user_id IS NOT NULL THEN 'user'
                        WHEN sl.staff_member_id IS NOT NULL THEN 'staff_member'
                        ELSE 'unknown'
                    END as staff_type
                FROM staff_loans sl
                WHERE (sl.user_id = $1 OR sl.staff_member_id = $1)
                  AND sl.is_paid = FALSE
                ORDER BY sl.loan_date ASC
            `
            : `
                SELECT
                    sl.id,
                    sl.amount,
                    sl.amount AS outstanding,
                    sl.loan_date,
                    sl.reason,
                    CASE
                        WHEN sl.user_id IS NOT NULL THEN 'user'
                        WHEN sl.staff_member_id IS NOT NULL THEN 'staff_member'
                        ELSE 'unknown'
                    END as staff_type
                FROM staff_loans sl
                WHERE (sl.user_id = $1 OR sl.staff_member_id = $1)
                  AND sl.is_paid = FALSE
                ORDER BY sl.loan_date ASC
            `;
        const result = await db.query(query, [userId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching outstanding loan details:', error);
        res.status(500).json({ error: 'Failed to fetch outstanding loan details.', details: error.message });
    }
});

// GET /api/salaries/loans/outstanding/:userId - Total outstanding loan for a staff member
router.get('/loans/outstanding/:userId', authenticate, async (req, res) => {
    const { userId } = req.params;
    try {
        const scheduleReady = await ensureLoanSchedule();
        const sumExpr = scheduleReady ? 'COALESCE(sl.remaining_balance, sl.amount)' : 'sl.amount';
        const result = await db.query(
            `SELECT COALESCE(SUM(${sumExpr}), 0) AS outstanding_loan_amount
             FROM staff_loans sl
             WHERE (sl.user_id = $1 OR sl.staff_member_id = $1)
               AND sl.is_paid = FALSE`,
            [userId]
        );
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching outstanding loan:', error);
        res.status(500).json({ error: 'Failed to fetch outstanding loan.', details: error.message });
    }
});

// GET /api/salaries/preview-deductions?user_id=&staff_type=
// Suggested loan installment (from repayment schedules) + outstanding staff credit-sales debt.
// The salary payment form uses this to prefill loan_deduction and credit_sales_deduction.
router.get('/preview-deductions', authenticate, async (req, res) => {
    const staffID = parseInt(req.query.user_id);
    const isStaffMember = String(req.query.staff_type || '').toLowerCase() === 'staff_member';

    if (!staffID || isNaN(staffID)) {
        return res.status(400).json({ error: 'user_id is required.' });
    }

    try {
        const scheduleReady = await ensureLoanSchedule();
        const linkReady = await ensureCreditLink();
        const col = isStaffMember ? 'staff_member_id' : 'user_id';

        const loansQuery = scheduleReady
            ? `SELECT id, amount,
                      COALESCE(remaining_balance, amount) AS outstanding,
                      repayment_months,
                      COALESCE(monthly_deduction, COALESCE(remaining_balance, amount)) AS monthly_deduction,
                      start_date, loan_date, due_date, reason
               FROM staff_loans
               WHERE ${col} = $1 AND is_paid = FALSE
               ORDER BY loan_date ASC, id ASC`
            : `SELECT id, amount, amount AS outstanding, NULL AS repayment_months,
                      amount AS monthly_deduction, NULL AS start_date, loan_date, NULL AS due_date, reason
               FROM staff_loans
               WHERE ${col} = $1 AND is_paid = FALSE
               ORDER BY loan_date ASC, id ASC`;

        const loans = await db.query(loansQuery, [staffID]);
        const suggestedLoan = loans.rows.reduce(
            (sum, l) => sum + Math.min(parseFloat(l.monthly_deduction), parseFloat(l.outstanding)), 0
        );

        let creditOutstanding = 0;
        let customerId = null;
        if (linkReady) {
            const custRes = await db.query(
                `SELECT id FROM customers WHERE ${col} = $1 ORDER BY id LIMIT 1`,
                [staffID]
            );
            if (custRes.rows.length > 0) {
                customerId = custRes.rows[0].id;
                const cr = await db.query(
                    'SELECT COALESCE(SUM(balance_due), 0) AS total FROM sales_transactions WHERE customer_id = $1 AND balance_due > 0',
                    [customerId]
                );
                creditOutstanding = parseFloat(cr.rows[0].total);
            }
        }

        res.status(200).json({
            loans: loans.rows,
            suggested_loan_deduction: Math.round(suggestedLoan * 100) / 100,
            credit_outstanding: Math.round(creditOutstanding * 100) / 100,
            customer_id: customerId
        });
    } catch (error) {
        console.error('Error previewing deductions:', error);
        res.status(500).json({ error: 'Failed to preview deductions.', details: error.message });
    }
});

// GET /api/salaries/credit-sales?user_id=&staff_type=
// Lists the staff member's unpaid credit sales (bread they bought as a customer)
// so the salary form can let the admin select which sales to deduct from salary.
// Auto-provisions a linked customer record for the staff member if none exists.
router.get('/credit-sales', authenticate, async (req, res) => {
    const staffID = parseInt(req.query.user_id);
    const isStaffMember = String(req.query.staff_type || '').toLowerCase() === 'staff_member';

    if (!staffID || isNaN(staffID)) {
        return res.status(400).json({ error: 'user_id is required.' });
    }

    try {
        const linkReady = await ensureCreditLink();
        if (!linkReady) {
            return res.status(200).json({ customer_id: null, credit_sales: [], total_outstanding: 0, link_ready: false });
        }

        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            const customerId = await getOrCreateStaffCustomer(client, staffID, isStaffMember);
            await client.query('COMMIT');

            if (!customerId) {
                return res.status(404).json({ error: 'Staff member not found.' });
            }

            const sales = await db.query(
                `SELECT id, sale_date, due_date, total_amount, amount_paid, balance_due, status, payment_method
                 FROM sales_transactions
                 WHERE customer_id = $1 AND balance_due > 0
                 ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC`,
                [customerId]
            );
            const total = sales.rows.reduce((sum, r) => sum + parseFloat(r.balance_due), 0);

            res.status(200).json({
                customer_id: customerId,
                credit_sales: sales.rows,
                total_outstanding: Math.round(total * 100) / 100,
                link_ready: true
            });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error fetching staff credit sales:', error);
        res.status(500).json({ error: 'Failed to fetch staff credit sales.', details: error.message });
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

        const scheduleReady = await ensureLoanSchedule();
        const userLoanSum = scheduleReady
            ? `(SELECT COALESCE(SUM(COALESCE(sl.remaining_balance, sl.amount)), 0) FROM staff_loans sl WHERE sl.user_id = u.id AND sl.is_paid = FALSE)`
            : `(SELECT COALESCE(SUM(sl.amount), 0) FROM staff_loans sl WHERE sl.user_id = u.id AND sl.is_paid = FALSE)`;
        const staffLoanSum = scheduleReady
            ? `(SELECT COALESCE(SUM(COALESCE(sl.remaining_balance, sl.amount)), 0) FROM staff_loans sl WHERE sl.staff_member_id = sm.id AND sl.is_paid = FALSE)`
            : `(SELECT COALESCE(SUM(sl.amount), 0) FROM staff_loans sl WHERE sl.staff_member_id = sm.id AND sl.is_paid = FALSE)`;

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
                ss.bank_account_name,
                ss.account_number,
                ss.tax_rate,
                ss.pension_rate,
                ss.is_active as salary_active,
                (SELECT COUNT(*) FROM salary_payments sp WHERE sp.user_id = u.id AND sp.status = 'paid') as total_payments,
                (SELECT MAX(payment_date) FROM salary_payments sp WHERE sp.user_id = u.id AND sp.status = 'paid') as last_payment_date,
                ${userLoanSum} as outstanding_loan_amount
            FROM users u
            LEFT JOIN staff_salaries ss ON u.id = ss.user_id
            WHERE u.is_active = $1
        `;

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
                ss.bank_account_name,
                ss.account_number,
                ss.tax_rate,
                ss.pension_rate,
                ss.is_active as salary_active,
                (SELECT COUNT(*) FROM salary_payments sp WHERE sp.staff_member_id = sm.id AND sp.status = 'paid') as total_payments,
                (SELECT MAX(payment_date) FROM salary_payments sp WHERE sp.staff_member_id = sm.id AND sp.status = 'paid') as last_payment_date,
                ${staffLoanSum} as outstanding_loan_amount
            FROM staff_members sm
            LEFT JOIN staff_salaries ss ON sm.id = ss.staff_member_id
            WHERE sm.is_active = $1
        `;

        const userParams = [isActive === 'true'];
        const staffParams = [isActive === 'true'];
        let userParamCount = 2;
        let staffParamCount = 2;

        const addFilters = (query, params, paramCount, forStaffType) => {
            if (role && forStaffType !== 'staff_member') {
                query += ` AND u.role = $${paramCount}`;
                params.push(role);
                paramCount++;
            } else if (role && forStaffType === 'staff_member') {
                query += ` AND sm.position = $${paramCount}`;
                params.push(role);
                paramCount++;
            }

            if (search && forStaffType !== 'staff_member') {
                query += ` AND (u.fullname ILIKE $${paramCount} OR u.email ILIKE $${paramCount} OR u.username ILIKE $${paramCount})`;
                params.push(`%${search}%`);
                paramCount++;
            } else if (search && forStaffType === 'staff_member') {
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

        let usersResult = addFilters(usersQuery, userParams, userParamCount, 'user');
        let staffResult = addFilters(staffMembersQuery, staffParams, staffParamCount, 'staff_member');

        usersQuery = usersResult.query + ` ORDER BY u.fullname`;
        staffMembersQuery = staffResult.query + ` ORDER BY sm.fullname`;

        const [usersData, staffMembersData] = await Promise.all([
            db.query(usersQuery, usersResult.params),
            db.query(staffMembersQuery, staffResult.params)
        ]);

        let allStaff = [
            ...usersData.rows,
            ...staffMembersData.rows
        ];

        if (staffType) {
            allStaff = allStaff.filter(staff => staff.staff_type === staffType);
        }

        res.status(200).json(allStaff);
    } catch (error) {
        console.error('Error fetching all staff salaries:', error);
        res.status(500).json({ error: 'Failed to fetch staff salaries.', details: error.message });
    }
});

// POST /api/salaries/staff/:type/:id/salary - Upsert a salary structure for a user or staff member
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
    pension_rate,
  } = req.body;

  try {
    const staffId = parseInt(id);

    let idColumn;
    let user_id_value = null;
    let staff_member_id_value = null;

    const staffType = String(type).toLowerCase();

    if (staffType === 'user') {
      idColumn = 'user_id';
      user_id_value = staffId;
    } else if (staffType === 'staff_member') {
      idColumn = 'staff_member_id';
      staff_member_id_value = staffId;
    } else {
      return res.status(400).json({ error: 'Invalid staff type provided in the URL path.' });
    }

    const netSalary =
      parseFloat(base_salary || 0) +
      parseFloat(allowances || 0) -
      parseFloat(deductions || 0);

    const query = `
      INSERT INTO staff_salaries (
        user_id, staff_member_id, base_salary, allowances, deductions,
        net_salary, salary_type, bank_name, bank_account_name,
        account_number, tax_rate, pension_rate, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
      ON CONFLICT (${idColumn})
      DO UPDATE SET
        base_salary = EXCLUDED.base_salary,
        allowances = EXCLUDED.allowances,
        deductions = EXCLUDED.deductions,
        net_salary = EXCLUDED.net_salary,
        salary_type = EXCLUDED.salary_type,
        bank_name = EXCLUDED.bank_name,
        bank_account_name = EXCLUDED.bank_account_name,
        account_number = EXCLUDED.account_number,
        tax_rate = EXCLUDED.tax_rate,
        pension_rate = EXCLUDED.pension_rate,
        updated_at = CURRENT_TIMESTAMP
      RETURNING *;
    `;

    const params = [
      user_id_value,
      staff_member_id_value,
      parseFloat(base_salary || 0),
      parseFloat(allowances || 0),
      parseFloat(deductions || 0),
      netSalary,
      salary_type,
      bank_name,
      bank_account_name,
      account_number,
      parseFloat(tax_rate || 0),
      parseFloat(pension_rate || 0)
    ];

    const result = await db.query(query, params);
    return res.status(200).json(result.rows[0]);

  } catch (err) {
    console.error('Salary upsert error:', err);
    return res.status(500).json({ error: 'Failed to save salary', details: err.message });
  }
});

module.exports = router;
