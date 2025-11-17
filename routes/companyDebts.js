// routes/companyDebts.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const authenticate = require('../middleware/authenticate');

// GET /api/salaries/company-debts - Get all company debts
router.get('/', async (req, res) => {
    try {
        const query = `
            SELECT 
                cd.*,
                CASE 
                    WHEN cd.staff_type = 'user' THEN u.fullname
                    ELSE sm.fullname
                END as staff_name,
                CASE 
                    WHEN cd.staff_type = 'user' THEN u.role
                    ELSE sm.position
                END as staff_role
            FROM company_debts cd
            LEFT JOIN users u ON cd.staff_type = 'user' AND cd.staff_id = u.id
            LEFT JOIN staff_members sm ON cd.staff_type = 'staff_member' AND cd.staff_id = sm.id
            ORDER BY cd.created_at DESC
        `;
        
        const result = await db.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching company debts:', error);
        res.status(500).json({ error: 'Failed to fetch company debts.', details: error.message });
    }
});

// POST /api/salaries/company-debts - Create new company debt
router.post('/', authenticate, async (req, res) => {
    const { staff_id, staff_type, amount, reason, debt_type, status } = req.body;
    
    try {
        const query = `
            INSERT INTO company_debts 
                (staff_id, staff_type, amount, remaining_amount, reason, debt_type, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING *
        `;
        
        const result = await db.query(query, [
            staff_id, staff_type, parseFloat(amount), parseFloat(amount), 
            reason, debt_type, status
        ]);
        
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating company debt:', error);
        res.status(500).json({ error: 'Failed to create company debt.', details: error.message });
    }
});

// GET /api/salaries/company-debts/history/:staffType/:staffId - Get debt history for staff
router.get('/history/:staffType/:staffId', async (req, res) => {
    const { staffType, staffId } = req.params;
    
    try {
        const query = `
            SELECT dh.*, u.fullname as created_by_name
            FROM debt_history dh
            JOIN company_debts cd ON dh.debt_id = cd.id
            LEFT JOIN users u ON dh.created_by = u.id
            WHERE cd.staff_type = $1 AND cd.staff_id = $2
            ORDER BY dh.created_at DESC
        `;
        
        const result = await db.query(query, [staffType, staffId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching debt history:', error);
        res.status(500).json({ error: 'Failed to fetch debt history.', details: error.message });
    }
});

// POST /api/salaries/company-debts/:id/history - Add debt history entry
router.post('/:id/history', authenticate, async (req, res) => {
    const { id } = req.params;
    const { amount, transaction_type, reason, notes } = req.body;
    const created_by = req.user.id;
    
    try {
        const client = await db.getClient();
        
        try {
            await client.query('BEGIN');
            
            // Insert history
            const historyQuery = `
                INSERT INTO debt_history 
                    (debt_id, amount, transaction_type, reason, notes, created_by)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING *
            `;
            
            await client.query(historyQuery, [id, amount, transaction_type, reason, notes, created_by]);
            
            // Update debt remaining amount based on transaction type
            let updateQuery = '';
            if (transaction_type === 'payment') {
                updateQuery = `
                    UPDATE company_debts 
                    SET remaining_amount = GREATEST(0, remaining_amount - $1),
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $2
                `;
            } else {
                updateQuery = `
                    UPDATE company_debts 
                    SET remaining_amount = remaining_amount + $1,
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = $2
                `;
            }
            
            await client.query(updateQuery, [amount, id]);
            
            await client.query('COMMIT');
            res.status(201).json({ message: 'History added successfully' });
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error adding debt history:', error);
        res.status(500).json({ error: 'Failed to add debt history.', details: error.message });
    }
});

// UPDATE company debt
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const {
        staff_id,
        staff_type,
        amount,
        reason,
        debt_type,
        status
    } = req.body;

    try {
        const query = `
            UPDATE company_debts
            SET staff_id = $1,
                staff_type = $2,
                amount = $3,
                reason = $4,
                debt_type = $5,
                status = $6,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $7
            RETURNING *
        `;

        const values = [
            staff_id,
            staff_type,
            amount,
            reason,
            debt_type,
            status,
            id
        ];

        const result = await db.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Debt record not found" });
        }

        res.status(200).json(result.rows[0]);
        
    } catch (error) {
        console.error("Error updating company debt:", error);
        res.status(500).json({
            error: "Failed to update company debt",
            details: error.message
        });
    }
});


module.exports = router;