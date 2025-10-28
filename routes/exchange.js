// purple-premium-bread-api/routes/exchange.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { jwtDecode } = require('jwt-decode'); 


// server.js - Add new routes below existing sales/inventory routes

// ==========================================================
// BREAD EXCHANGE WORKFLOW ROUTES
// ==========================================================

/**
 * Route 1: Sales User submits a new Exchange Request.
 * Status: PENDING
 */
router.post('/request', async (req, res) => {
    // Assuming req.user contains the logged-in user's ID and role
    const requested_by_user_id = req.user.id; 
    const { original_sale_id, customer_id, items_requested_jsonb, reason } = req.body;

    if (!customer_id || !items_requested_jsonb) {
        return res.status(400).json({ error: 'Missing required fields: customer_id and items_requested_jsonb.' });
    }

    try {
        const query = `
            INSERT INTO exchange_requests 
                (original_sale_id, customer_id, requested_by_user_id, items_requested_jsonb, reason, status) 
            VALUES ($1, $2, $3, $4, $5, 'PENDING')
            RETURNING *;
        `;
        const values = [original_sale_id || null, customer_id, requested_by_user_id, items_requested_jsonb, reason];
        
        const result = await db.query(query, values);
        
        res.status(201).json({ 
            message: 'Exchange request submitted successfully. Awaiting manager approval.', 
            request: result.rows[0] 
        });

    } catch (error) {
        console.error('Error submitting exchange request:', error);
        res.status(500).json({ error: 'Failed to submit exchange request.' });
    }
});

module.exports = router;