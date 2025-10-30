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
router.post('/request', authenticate, async (req, res) => {
    // Assuming req.user contains the logged-in user's ID and role
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
            VALUES 
                ($1, $2, $3, $4, $5, 'PENDING')
            RETURNING id;
        `;
        const result = await db.query(query, [original_sale_id, customer_id, requested_by_user_id, items_json_string, reason]);
        res.status(201).json({ message: 'Exchange request submitted successfully.', requestId: result.rows[0].id });
    } catch (error) {
        console.error('Error submitting exchange request:', error);
        res.status(500).json({ error: 'Failed to submit exchange request.', details: error.message });
    }
});

// ---

/**
 * Route 2: Sales User confirms an APPROVED Exchange.
 * Status: APPROVED -> RECORDED
 * NOTE: This is the critical step where new product stock is DEDUCTED.
 * It must check the user's load_from_demo_stock flag.
 */
router.patch('/confirm/:requestId', authenticate, async (req, res) => {
    const requestId = req.params.requestId;
    const currentUserId = req.user.id;
    const currentUserRole = req.user.role?.toUpperCase();

    // Authorization check: Only the requesting user (or Admin/Manager) can confirm.
    // We will enforce the user ID check inside the transaction after fetching the request.

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // A. Fetch the request details and the requesting user's settings
        const requestQuery = await client.query('SELECT er.*, u.load_from_demo_stock, u.fullname FROM exchange_requests er JOIN users u ON er.requested_by_user_id = u.id WHERE er.id = $1 FOR UPDATE', [requestId]);
        
        if (requestQuery.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Exchange request not found.' });
        }
        
        const request = requestQuery.rows[0];
        
        // Authorization Check (secondary/stricter)
        if (request.requested_by_user_id !== currentUserId && currentUserRole !== 'ADMIN' && currentUserRole !== 'MANAGER') {
            await client.query('ROLLBACK');
            return res.status(403).json({ error: 'Unauthorized. You can only confirm your own requests.' });
        }
        
        if (request.status !== 'APPROVED') {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: `Cannot confirm exchange. Current status is '${request.status}'.` });
        }

        const { items_requested_jsonb, requested_by_user_id, load_from_demo_stock, fullname } = request;

        // B. Loop through items and perform stock deduction based on user setting
        for (const item of items_requested_jsonb) {
            const { product_id, quantity } = item;
            
            if (load_from_demo_stock) {
                // 1. DEDUCT FROM SALES_USER_STOCK (Allocated Stock)
                
                // ⭐ CRITICAL 1: Check if the user has enough stock first.
                const stockCheckQuery = `
                    SELECT COALESCE(stock_allocated, 0) AS current_stock 
                    FROM sales_user_stock 
                    WHERE user_id = $1 AND product_id = $2
                `;
                const stockCheckResult = await client.query(stockCheckQuery, [requested_by_user_id, product_id]);
                const currentStock = stockCheckResult.rows.length > 0 ? stockCheckResult.rows[0].current_stock : 0;

                if (currentStock < quantity) {
                    // ⭐ CRITICAL 1: Fail the transaction and rollback if not enough stock.
                    await client.query('ROLLBACK');
                    return res.status(400).json({ 
                        error: `Exchange failed: Sales User ${fullname} (ID: ${requested_by_user_id}) does not have enough allocated stock (${currentStock}) for Product ID ${product_id}.` 
                    });
                }

                // Proceed with deduction from sales_user_stock
                const deductionQuery = `
                    UPDATE sales_user_stock 
                    SET stock_allocated = stock_allocated - $1 
                    WHERE user_id = $2 AND product_id = $3
                    RETURNING stock_allocated;
                `;
                await client.query(deductionQuery, [quantity, requested_by_user_id, product_id]);

                // ⭐ LOGGING REMOVED: Exchange is a replacement, not a standard loggable stock issue.
                
            } else {
                // 2. DEDUCT FROM MAIN INVENTORY (Normal Inventory)
                const deductionQuery = `
                    UPDATE inventory 
                    SET current_stock = current_stock - $1 
                    WHERE product_id = $2
                    RETURNING current_stock;
                `;
                const result = await client.query(deductionQuery, [quantity, product_id]);

                if (result.rowCount === 0) {
                     // Product not found in inventory, which is an error state
                     // NOTE: You might need a check for negative stock depending on your database constraints
                }

                // ⭐ LOGGING REMOVED: Exchange is a replacement, not a standard loggable stock issue.
            }
        }

        // C. Update the exchange request status to RECORDED
        const updateStatusQuery = `
            UPDATE exchange_requests 
            SET status = 'RECORDED', confirmed_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `;
        await client.query(updateStatusQuery, [requestId]);
        
        // D. Commit the transaction
        await client.query('COMMIT');
        res.status(200).json({ message: 'Exchange successfully confirmed and stock deducted.' });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error during exchange confirmation transaction:', error);
        res.status(500).json({ error: 'Confirmation failed due to a server error.', details: error.message });
    } finally {
        client.release();
    }
});


// ---

/**
 * Route 3: Get all APPROVED requests pending confirmation by the sales user.
 */
router.get('/approved-pending-confirmation', authenticate, async (req, res) => {
    // Only sales role needs to see their own approved exchanges
    const requested_by_user_id = req.user.id;
    const userRole = req.user.role?.toUpperCase();

    let query;
    let params = [];

    // Admins/Managers can see all pending-confirmation requests
    if (userRole === 'ADMIN' || userRole === 'MANAGER') {
        query = `
            SELECT 
                er.id, er.created_at, er.reason, er.items_requested_jsonb, er.status,
                c.fullname AS customer_name,
                u.fullname AS requested_by_user_name
            FROM exchange_requests er
            JOIN customers c ON er.customer_id = c.id
            JOIN users u ON er.requested_by_user_id = u.id
            WHERE er.status = 'APPROVED'
            ORDER BY er.created_at DESC;
        `;
    } else if (userRole === 'SALES') {
        // Sales user can only see their own
        query = `
            SELECT 
                er.id, er.created_at, er.reason, er.items_requested_jsonb, er.status,
                c.fullname AS customer_name,
                u.fullname AS requested_by_user_name
            FROM exchange_requests er
            JOIN customers c ON er.customer_id = c.id
            JOIN users u ON er.requested_by_user_id = u.id
            WHERE er.status = 'APPROVED' AND er.requested_by_user_id = $1
            ORDER BY er.created_at DESC;
        `;
        params.push(requested_by_user_id);
    } else {
        return res.status(403).json({ error: 'Unauthorized role to view this queue.' });
    }

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching approved/pending confirmation requests:', error);
        res.status(500).json({ error: 'Failed to fetch requests.', details: error.message });
    }
});

// ---

/**
 * Route 4: Get all PENDING requests. (Primarily for a sales user to track their request)
 */
router.get('/pending', authenticate, async (req, res) => {
    const requested_by_user_id = req.user.id;
    const userRole = req.user.role?.toUpperCase();

    let query;
    let params = [];
    
    // Admins/Managers can see all PENDING requests (They have a separate manager route for their queue, but this covers general views)
    if (userRole === 'ADMIN' || userRole === 'MANAGER') {
        query = `
            SELECT 
                er.id, er.created_at, er.reason, er.items_requested_jsonb, er.status,
                c.fullname AS customer_name,
                u.fullname AS requested_by_user_name
            FROM exchange_requests er
            JOIN customers c ON er.customer_id = c.id
            JOIN users u ON er.requested_by_user_id = u.id
            WHERE er.status = 'PENDING'
            ORDER BY er.created_at DESC;
        `;
    } else if (userRole === 'SALES') {
        // Sales user can only see their own
        query = `
            SELECT 
                er.id, er.created_at, er.reason, er.items_requested_jsonb, er.status,
                c.fullname AS customer_name,
                u.fullname AS requested_by_user_name
            FROM exchange_requests er
            JOIN customers c ON er.customer_id = c.id
            JOIN users u ON er.requested_by_user_id = u.id
            WHERE er.status = 'PENDING' AND er.requested_by_user_id = $1
            ORDER BY er.created_at DESC;
        `;
        params.push(requested_by_user_id);
    } else {
        return res.status(403).json({ error: 'Unauthorized role to view this queue.' });
    }

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching pending exchange requests:', error);
        res.status(500).json({ error: 'Failed to fetch requests.', details: error.message });
    }
});

// ---

/**
 * Route 5: Get Exchange History (Completed/Recorded exchanges)
 */
router.get('/history', authenticate, async (req, res) => {
    const currentUserId = req.user.id;
    const userRole = req.user.role?.toUpperCase();

    let query;
    let params = [];

    // Admins/Managers see all history
    if (userRole === 'ADMIN' || userRole === 'MANAGER') {
        query = `
            SELECT 
                er.id, er.created_at, er.confirmed_at, er.reason, er.items_requested_jsonb, er.status,
                c.fullname AS customer_name,
                u.fullname AS requested_by_user_name,
                ua.fullname AS approved_by_user_name
            FROM exchange_requests er
            JOIN customers c ON er.customer_id = c.id
            JOIN users u ON er.requested_by_user_id = u.id
            LEFT JOIN users ua ON er.approved_by_user_id = ua.id
            WHERE er.status = 'RECORDED'
            ORDER BY er.confirmed_at DESC;
        `;
    } else if (userRole === 'SALES') {
        // Sales user sees only their own history
        query = `
            SELECT 
                er.id, er.created_at, er.confirmed_at, er.reason, er.items_requested_jsonb, er.status,
                c.fullname AS customer_name,
                u.fullname AS requested_by_user_name,
                ua.fullname AS approved_by_user_name
            FROM exchange_requests er
            JOIN customers c ON er.customer_id = c.id
            JOIN users u ON er.requested_by_user_id = u.id
            LEFT JOIN users ua ON er.approved_by_user_id = ua.id
            WHERE er.status = 'RECORDED' AND er.requested_by_user_id = $1
            ORDER BY er.confirmed_at DESC;
        `;
        params.push(currentUserId);
    } else {
        return res.status(403).json({ error: 'Unauthorized role to view history.' });
    }
    
    try {
        const result = await db.query(query, params);
        const requests = result.rows;
        
        // 1. Collect all unique product IDs
        const productIds = new Set();
        requests.forEach(req => {
            if (Array.isArray(req.items_requested_jsonb)) {
                req.items_requested_jsonb.forEach(item => {
                    productIds.add(item.product_id);
                });
            }
        });

        // 2. Fetch product names from the products table
        let productNamesMap = {};
        if (productIds.size > 0) {
            // Fetch names for all unique product IDs in one go
            const productQuery = `
                SELECT id, name FROM products WHERE id = ANY($1::int[])
            `;
            const productResult = await db.query(productQuery, [[...productIds]]);
            
            productResult.rows.forEach(p => {
                productNamesMap[p.id] = p.name;
            });
        }

        // 3. Enrich the requests with product names
        const enrichedRequests = requests.map(req => {
            if (!Array.isArray(req.items_requested_jsonb)) return req;

            const enrichedItems = req.items_requested_jsonb.map(item => ({
                ...item,
                // Add the name using the map, falling back to an error message if not found
                name: productNamesMap[item.product_id] || `Product ID ${item.product_id} Missing`
            }));
            
            return {
                ...req,
                items_requested_jsonb: enrichedItems // Overwrite with enriched array
            };
        });

        res.status(200).json(enrichedRequests);

    } catch (error) {
        console.error('Error fetching exchange history:', error);
        res.status(500).json({ error: 'Failed to fetch exchange history.', details: error.message });
    }
});


// Note: The /approve route is intentionally omitted here to prevent accidental use
// and to centralize the approval logic in manager.js.

module.exports = router;