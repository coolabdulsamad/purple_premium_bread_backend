// purple-premium-bread-api/routes/manager-exchange.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { jwtDecode } = require('jwt-decode');
const authenticate = require('../middleware/authenticate');

// ---

/**
 * Route 2: Manager/Admin approves an Exchange Request.
 * Status: PENDING -> APPROVED
 * ACTION: ONLY updates the status and approval metadata. NO STOCK MOVEMENT OCCURS HERE.
 */
router.patch('/exchange/approve/:id', authenticate, async (req, res) => {
    // Assuming req.user contains the manager's ID and role check
    const approved_by_user_id = req.user.id;
    const requestId = req.params.id;
    const managerRole = req.user.role?.toUpperCase(); 


    // 1. Authorization check
    if (managerRole !== 'ADMIN' && managerRole !== 'MANAGER') {
        return res.status(403).json({ error: 'Unauthorized. Only Managers or Admins can approve requests.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // A. Retrieve and lock the request, and check its status
        const requestQuery = await client.query('SELECT * FROM exchange_requests WHERE id = $1 FOR UPDATE', [requestId]);
        const requestData = requestQuery.rows[0];

        if (!requestData) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Exchange request not found.' });
        }

        if (requestData.status !== 'PENDING') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Request status is '${requestData.status}'. Only PENDING requests can be approved.` });
        }

        // ⭐ CRITICAL FIX: Removed the stock update loop (B) entirely. 
        // Stock is now only deducted during the user's final 'confirm' stage.
        
        // C. Update the exchange request status to APPROVED
        const updateStatusQuery = `
            UPDATE exchange_requests 
            SET status = 'APPROVED', approved_by_user_id = $2, approval_date = CURRENT_TIMESTAMP 
            WHERE id = $1
        `;
        await client.query(updateStatusQuery, [requestId, approved_by_user_id]);
        
        // D. Commit the transaction
        await client.query('COMMIT');
        // Updated message to reflect the change in logic.
        res.status(200).json({ message: 'Exchange successfully approved. Awaiting sales user confirmation for final stock deduction.', requestId: requestId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error during exchange approval transaction:', error);
        res.status(500).json({ error: 'Approval failed due to a server error.', details: error.message });
    } finally {
        client.release();
    }
});

// --- (Route 3 remains the same) ---

/**
 * Route 3: Get all pending requests for the manager dashboard
 */
router.get('/exchange/pending', authenticate, async (req, res) => {

    const managerRole = req.user.role?.toUpperCase(); 
    if (managerRole !== 'ADMIN' && managerRole !== 'MANAGER') {
        return res.status(403).json({ error: 'Unauthorized.' });
    }

    try {
        const query = `
            SELECT 
                er.id, er.created_at, er.reason, er.items_requested_jsonb,
                c.fullname AS customer_name,
                u.fullname AS requested_by_user_name,
                u.load_from_demo_stock
            FROM exchange_requests er
            JOIN customers c ON er.customer_id = c.id
            JOIN users u ON er.requested_by_user_id = u.id
            WHERE er.status = 'PENDING'
            ORDER BY er.created_at DESC;
        `;
        const result = await db.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching pending exchange requests for manager:', error);
        res.status(500).json({ error: 'Failed to fetch pending requests.', details: error.message });
    }
});

module.exports = router;