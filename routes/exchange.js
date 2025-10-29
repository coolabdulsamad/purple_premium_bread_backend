// purple-premium-bread-api/routes/exchange.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { jwtDecode } = require('jwt-decode'); 
const authenticate = require('../middleware/authenticate'); // Adjust the path as needed

// server.js - Add new routes below existing sales/inventory routes

// ==========================================================
// BREAD EXCHANGE WORKFLOW ROUTES
// ==========================================================

/**
 * Route 1: Sales User submits a new Exchange Request.
 * Status: PENDING
 */
// server.js - FIX for POST /api/exchange/request

router.post('/request', authenticate, async (req, res) => {
    // Assuming req.user contains the logged-in user's ID and role
    // NOTE: If req.user is not available (e.g., middleware issue), this will also cause a 500
    const requested_by_user_id = req.user.id; 
    const { original_sale_id, customer_id, items_requested_jsonb, reason } = req.body;

    if (!customer_id || !items_requested_jsonb) {
        return res.status(400).json({ error: 'Missing required fields: customer_id and items_requested_jsonb.' });
    }

    // ⭐ CRITICAL FIX: Convert JavaScript object to JSON string for the JSONB column
    const items_json_string = JSON.stringify(items_requested_jsonb); 

    try {
        const query = `
            INSERT INTO exchange_requests 
                (original_sale_id, customer_id, requested_by_user_id, items_requested_jsonb, reason, status) 
            VALUES ($1, $2, $3, $4, $5, 'PENDING')
            RETURNING *;
        `;
        // Pass the stringified JSON here ($4)
        const values = [
            original_sale_id || null, 
            customer_id, 
            requested_by_user_id, 
            items_json_string, // <-- USE STRINGIFIED JSON
            reason
        ];
        
        const result = await db.query(query, values);
        
        res.status(201).json({ 
            message: 'Exchange request submitted successfully. Awaiting manager approval.', 
            request: result.rows[0] 
        });

    } catch (error) {
        // IMPORTANT: Log the full error to your backend console to confirm this fix worked
        console.error('Error submitting exchange request (FIX ATTEMPTED):', error); 
        res.status(500).json({ error: 'Failed to submit exchange request.' });
    }
});


/**
 * Route 1: Sales User fetches all approved exchanges awaiting their confirmation (status = 'APPROVED').
 */
router.get('/approved-pending-confirmation', authenticate, async (req, res) => {
    const userId = req.user.id; // User must be authenticated
    try {
        const query = `
            SELECT 
                er.id, er.created_at, er.reason, er.items_requested_jsonb,
                c.fullname AS customer_name,
                u.fullname AS approved_by_user_name,
                er.approval_date
            FROM exchange_requests er
            JOIN customers c ON er.customer_id = c.id
            LEFT JOIN users u ON er.approved_by_user_id = u.id -- Manager Name
            WHERE er.status = 'APPROVED' AND er.requested_by_user_id = $1
            ORDER BY er.approval_date DESC;
        `;
        const result = await db.query(query, [userId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching approved exchange requests:', error);
        res.status(500).json({ error: 'Failed to fetch approved requests.' });
    }
});


/**
 * Route 2: Sales User confirms physical receipt of the approved exchange.
 * Status: APPROVED -> RECORDED (Final state)
 * NOTE: The stock movement was already handled by the manager. This is purely a status update.
 */
router.patch('/confirm/:id', authenticate, async (req, res) => {
    const userId = req.user.id; // User confirming the exchange
    const requestId = req.params.id;

    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Validate request status and user authorization
        const requestQuery = await client.query(
            'SELECT * FROM exchange_requests WHERE id = $1 AND requested_by_user_id = $2 FOR UPDATE',
            [requestId, userId]
        );
        const request = requestQuery.rows[0];

        if (!request) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Exchange request not found or you are not authorized to confirm it.' });
        }
        
        if (request.status !== 'APPROVED') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Cannot confirm exchange. Status is currently: ${request.status}. Only 'APPROVED' requests can be recorded.` });
        }

        // 2. Update the Request status to RECORDED
        const updateRequestQuery = `
            UPDATE exchange_requests 
            SET status = 'RECORDED', 
                updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
            RETURNING *;
        `;
        const updatedRequest = await client.query(updateRequestQuery, [requestId]);

        await client.query('COMMIT');

        res.status(200).json({ 
            message: 'Exchange successfully confirmed and recorded by sales user.', 
            request: updatedRequest.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error during exchange confirmation transaction:', error);
        res.status(500).json({ error: 'Confirmation failed due to a server error.' });
    } finally {
        client.release();
    }
});

module.exports = router;