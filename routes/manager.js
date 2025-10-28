// purple-premium-bread-api/routes/manager-exchange.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { jwtDecode } = require('jwt-decode'); 
const authenticate = require('../middleware/authenticate'); // ✅ import your middleware

// ---

/**
 * Route 2: Manager/Admin approves an Exchange Request.
 * Status: APPROVED -> RECORDED (if stock movement is successful)
 * NOTE: This is a critical route that handles inventory and finance updates.
 */
router.patch('/exchange/approve/:id', authenticate, async (req, res) => {
    // Assuming req.user contains the manager's ID and role check
    const approved_by_user_id = req.user.id;
    const requestId = req.params.id;
    const managerRole = req.user.role; // e.g., 'ADMIN', 'MANAGER'

    // 1. Authorization check
    if (managerRole !== 'ADMIN' && managerRole !== 'MANAGER') {
        return res.status(403).json({ error: 'Unauthorized. Only Managers or Admins can approve requests.' });
    }

    // Use a transaction for atomic updates to prevent data inconsistencies
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        // A. Retrieve and lock the request
        const requestQuery = await client.query('SELECT * FROM exchange_requests WHERE id = $1 FOR UPDATE', [requestId]);
        const request = requestQuery.rows[0];

        if (!request || request.status !== 'PENDING') {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Exchange request not found or already processed.' });
        }

        const itemsToReturn = request.items_requested_jsonb;
        const salesUserId = request.requested_by_user_id;

        // B. Process stock movement (return bread to the Sales User's stock)
        for (const item of itemsToReturn) {
            const { product_id, quantity } = item;
            
            // i. Update sales_user_stock (increase stock)
            const updateStockQuery = `
                INSERT INTO sales_user_stock (user_id, product_id, quantity) 
                VALUES ($1, $2, $3)
                ON CONFLICT (user_id, product_id) 
                DO UPDATE SET quantity = sales_user_stock.quantity + $3, last_updated = CURRENT_TIMESTAMP;
            `;
            await client.query(updateStockQuery, [salesUserId, product_id, quantity]);
            
            // ii. Log the stock movement (ISSUE_TYPE: RETURN)
            const logStockQuery = `
                INSERT INTO stock_issue_log 
                    (issue_type, to_user_id, product_id, quantity_changed, note, recorded_by)
                VALUES ('RETURN', $1, $2, $3, $4, $5);
            `;
            const logNote = `Customer exchange approved. Returned to stock by Manager approval for Request ID ${requestId}.`;
            await client.query(logStockQuery, [salesUserId, product_id, quantity, logNote, approved_by_user_id]);
        }

        // C. Update the Request status
        const updateRequestQuery = `
            UPDATE exchange_requests 
            SET status = 'APPROVED', 
                approved_by_user_id = $1, 
                approval_date = CURRENT_TIMESTAMP 
            WHERE id = $2
            RETURNING *;
        `;
        const updatedRequest = await client.query(updateRequestQuery, [approved_by_user_id, requestId]);

        await client.query('COMMIT');

        res.status(200).json({ 
            message: 'Exchange request successfully approved and inventory updated.', 
            request: updatedRequest.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error during exchange approval transaction:', error);
        res.status(500).json({ error: 'Approval failed due to a server error.' });
    } finally {
        client.release();
    }
});

// ---

/**
 * Route 3 (Optional but necessary): Get all pending requests for the manager dashboard
 */
router.get('/exchange/pending', authenticate, async (req, res) => {

    const managerRole = req.user.role?.toUpperCase(); // normalize to uppercase
    if (managerRole !== 'ADMIN' && managerRole !== 'MANAGER') {
        return res.status(403).json({ error: 'Unauthorized.' });
    }

    try {
        const query = `
            SELECT 
                er.id, er.created_at, er.reason, er.items_requested_jsonb,
                c.fullname AS customer_name,
                u.fullname AS requested_by_user_name
            FROM exchange_requests er
            JOIN customers c ON er.customer_id = c.id
            JOIN users u ON er.requested_by_user_id = u.id
            WHERE er.status = 'PENDING'
            ORDER BY er.created_at DESC;
        `;
        const result = await db.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching pending exchange requests:', error);
        res.status(500).json({ error: 'Failed to fetch pending requests.' });
    }
});

module.exports = router;