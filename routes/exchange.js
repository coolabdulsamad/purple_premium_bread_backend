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
// server.js - FIX for POST /api/exchange/request

router.post('/request', async (req, res) => {
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