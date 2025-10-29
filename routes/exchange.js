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
            VALUES ($1, $2, $3, $4, $5, 'PENDING')
            RETURNING *;
        `;
        // Pass the stringified JSON here ($4)
        const values = [
            original_sale_id || null, 
            customer_id, 
            requested_by_user_id, 
            items_json_string, 
            reason
        ];
        
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


/**
 * Route 2: Manager approves an exchange request.
 * Status: PENDING -> APPROVED
 */
router.post('/approve/:requestId', authenticate, async (req, res) => {
    // Role check: Only 'admin' or 'manager' can approve
    if (!['admin', 'manager'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden. Only managers or admins can approve exchange requests.' });
    }

    const approved_by_user_id = req.user.id;
    const requestId = req.params.requestId;

    try {
        const query = `
            UPDATE exchange_requests 
            SET status = 'APPROVED', 
                approved_by_user_id = $1, 
                approval_date = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND status = 'PENDING'
            RETURNING *;
        `;
        const result = await db.query(query, [approved_by_user_id, requestId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Exchange request not found or is not currently PENDING.' });
        }
        
        res.status(200).json({ 
            message: 'Exchange request approved successfully. Sales user can now confirm it.', 
            request: result.rows[0] 
        });

    } catch (error) {
        console.error('Error approving exchange request:', error); 
        res.status(500).json({ error: 'Failed to approve exchange request.' });
    }
});

router.patch('/approve/:requestId', authenticate, async (req, res) => {
    // Role check: Only 'admin' or 'manager' can approve
    if (!['admin', 'manager'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden. Only managers or admins can approve exchange requests.' });
    }

    const approved_by_user_id = req.user.id;
    const requestId = req.params.requestId;

    try {
        const query = `
            UPDATE exchange_requests 
            SET status = 'APPROVED', 
                approved_by_user_id = $1, 
                approval_date = CURRENT_TIMESTAMP,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 AND status = 'PENDING'
            RETURNING *;
        `;
        const result = await db.query(query, [approved_by_user_id, requestId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Exchange request not found or is not currently PENDING.' });
        }
        
        res.status(200).json({ 
            message: 'Exchange request approved successfully. Sales user can now confirm it.', 
            request: result.rows[0] 
        });

    } catch (error) {
        console.error('Error approving exchange request:', error); 
        res.status(500).json({ error: 'Failed to approve exchange request.' });
    }
});

/**
 * Route 3: Sales User confirms the exchange (after Manager Approval).
 * Status: APPROVED -> RECORDED. DEDUCTS STOCK.
 * * IMPLEMENTS THE NEW DEDUCTION LOGIC: User Stock Log (if configured) OR Normal Stock (Inventory).
 */
router.post('/confirm/:requestId', authenticate, async (req, res) => {
    // Only the user who requested the exchange should confirm it
    const userId = req.user.id; 
    const requestId = req.params.requestId;
    const client = await db.getClient(); // Use a client for transaction management

    try {
        await client.query('BEGIN');

        // 1. Fetch Request, get user's stock deduction setting, and Lock it
        // Ensure only the original requester can confirm an approved request
        const requestQuery = await client.query(
            `SELECT 
                er.items_requested_jsonb, 
                er.status, 
                er.requested_by_user_id,
                u.load_from_demo_stock -- Get the flag that determines stock source
             FROM exchange_requests er
             JOIN users u ON er.requested_by_user_id = u.id
             WHERE er.id = $1 AND er.requested_by_user_id = $2 FOR UPDATE`,
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

        const itemsToIssue = request.items_requested_jsonb;
        // load_from_demo_stock in the users table determines if stock is deducted from the user's dedicated stock
        const loadFromUserStock = request.load_from_demo_stock; 

        // 2. DEDUCT STOCK based on the requested logic
        for (const item of itemsToIssue) {
            const productId = item.product_id;
            const quantity = item.quantity;

            if (loadFromUserStock) {
                // LOGIC: Deduct from user stock log (`sales_user_stock`)
                
                // A. Check current user stock (and lock row)
                const userStockCheck = await client.query(
                    `SELECT quantity FROM sales_user_stock WHERE user_id = $1 AND product_id = $2 FOR UPDATE`,
                    [userId, productId]
                );
                const currentQuantity = userStockCheck.rows[0]?.quantity || 0;

                if (currentQuantity < quantity) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ 
                        error: `Insufficient stock for product ID ${productId}. User stock is ${currentQuantity}, but ${quantity} is required. Please ask your manager to issue more stock or uncheck the 'load from personal stock' setting.` 
                    });
                }
                
                // B. Deduct from sales_user_stock
                await client.query(
                    `UPDATE sales_user_stock
                     SET quantity = quantity - $1, last_updated = CURRENT_TIMESTAMP
                     WHERE user_id = $2 AND product_id = $3`,
                    [quantity, userId, productId]
                );
                
                // C. Log the stock issue from the user's stock
                await client.query(
                    `INSERT INTO stock_issue_log (issue_type, from_user_id, to_user_id, product_id, quantity_changed, note, recorded_by)
                     VALUES ('ISSUE', $1, NULL, $2, $3, $4, $5)`,
                    [userId, productId, quantity, `Exchange request ${requestId} confirmed. Item issued from user stock.`, userId]
                );

            } else {
                // LOGIC: Deduct from normal stock (`inventory`)
                
                // A. Check current inventory stock (and lock row)
                const inventoryCheck = await client.query(
                    `SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE`,
                    [productId]
                );
                const currentQuantity = inventoryCheck.rows[0]?.quantity || 0;
                
                if (currentQuantity < quantity) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ 
                        error: `Insufficient stock for product ID ${productId}. Main inventory stock is ${currentQuantity}, but ${quantity} is required.` 
                    });
                }

                // B. Deduct from inventory
                await client.query(
                    `UPDATE inventory
                     SET quantity = quantity - $1, last_updated = CURRENT_TIMESTAMP
                     WHERE product_id = $2`,
                    [quantity, productId]
                );
                
                // C. Log the stock issue from main inventory
                await client.query(
                    `INSERT INTO stock_issue_log (issue_type, from_user_id, to_user_id, product_id, quantity_changed, note, recorded_by)
                     VALUES ('ISSUE', NULL, NULL, $1, $2, $3, $4)`,
                    [productId, quantity, `Exchange request ${requestId} confirmed. Item issued from main inventory.`, userId]
                );
            }
            
            // NOTE: A full exchange would also need logic to INCREASE stock (return) of the old item.
            // This code only covers the DEDUCTION (ISSUE) of the new item requested in the exchange.
        }


        // 3. Update the Request status to RECORDED
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
            message: 'Exchange successfully confirmed and recorded by sales user. Stock deducted.', 
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

router.patch('/confirm/:requestId', authenticate, async (req, res) => {
    // Only the user who requested the exchange should confirm it
    const userId = req.user.id; 
    const requestId = req.params.requestId;
    const client = await db.getClient(); // Use a client for transaction management

    try {
        await client.query('BEGIN');

        // 1. Fetch Request, get user's stock deduction setting, and Lock it
        // Ensure only the original requester can confirm an approved request
        const requestQuery = await client.query(
            `SELECT 
                er.items_requested_jsonb, 
                er.status, 
                er.requested_by_user_id,
                u.load_from_demo_stock -- Get the flag that determines stock source
             FROM exchange_requests er
             JOIN users u ON er.requested_by_user_id = u.id
             WHERE er.id = $1 AND er.requested_by_user_id = $2 FOR UPDATE`,
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

        const itemsToIssue = request.items_requested_jsonb;
        // load_from_demo_stock in the users table determines if stock is deducted from the user's dedicated stock
        const loadFromUserStock = request.load_from_demo_stock; 

        // 2. DEDUCT STOCK based on the requested logic
        for (const item of itemsToIssue) {
            const productId = item.product_id;
            const quantity = item.quantity;

            if (loadFromUserStock) {
                // LOGIC: Deduct from user stock log (`sales_user_stock`)
                
                // A. Check current user stock (and lock row)
                const userStockCheck = await client.query(
                    `SELECT quantity FROM sales_user_stock WHERE user_id = $1 AND product_id = $2 FOR UPDATE`,
                    [userId, productId]
                );
                const currentQuantity = userStockCheck.rows[0]?.quantity || 0;

                if (currentQuantity < quantity) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ 
                        error: `Insufficient stock for product ID ${productId}. User stock is ${currentQuantity}, but ${quantity} is required. Please ask your manager to issue more stock or uncheck the 'load from personal stock' setting.` 
                    });
                }
                
                // B. Deduct from sales_user_stock
                await client.query(
                    `UPDATE sales_user_stock
                     SET quantity = quantity - $1, last_updated = CURRENT_TIMESTAMP
                     WHERE user_id = $2 AND product_id = $3`,
                    [quantity, userId, productId]
                );
                
                // C. Log the stock issue from the user's stock
                await client.query(
                    `INSERT INTO stock_issue_log (issue_type, from_user_id, to_user_id, product_id, quantity_changed, note, recorded_by)
                     VALUES ('ISSUE', $1, NULL, $2, $3, $4, $5)`,
                    [userId, productId, quantity, `Exchange request ${requestId} confirmed. Item issued from user stock.`, userId]
                );

            } else {
                // LOGIC: Deduct from normal stock (`inventory`)
                
                // A. Check current inventory stock (and lock row)
                const inventoryCheck = await client.query(
                    `SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE`,
                    [productId]
                );
                const currentQuantity = inventoryCheck.rows[0]?.quantity || 0;
                
                if (currentQuantity < quantity) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ 
                        error: `Insufficient stock for product ID ${productId}. Main inventory stock is ${currentQuantity}, but ${quantity} is required.` 
                    });
                }

                // B. Deduct from inventory
                await client.query(
                    `UPDATE inventory
                     SET quantity = quantity - $1, last_updated = CURRENT_TIMESTAMP
                     WHERE product_id = $2`,
                    [quantity, productId]
                );
                
                // C. Log the stock issue from main inventory
                await client.query(
                    `INSERT INTO stock_issue_log (issue_type, from_user_id, to_user_id, product_id, quantity_changed, note, recorded_by)
                     VALUES ('ISSUE', NULL, NULL, $1, $2, $3, $4)`,
                    [productId, quantity, `Exchange request ${requestId} confirmed. Item issued from main inventory.`, userId]
                );
            }
            
            // NOTE: A full exchange would also need logic to INCREASE stock (return) of the old item.
            // This code only covers the DEDUCTION (ISSUE) of the new item requested in the exchange.
        }


        // 3. Update the Request status to RECORDED
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
            message: 'Exchange successfully confirmed and recorded by sales user. Stock deducted.', 
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

/**
 * Route 4: Sales User fetches all approved exchanges awaiting their confirmation (status = 'APPROVED').
 */
router.get('/approved-pending-confirmation', authenticate, async (req, res) => {
    const userId = req.user.id; // User must be authenticated
    try {
        const query = `
            SELECT er.id, er.created_at, er.reason, er.items_requested_jsonb, c.fullname AS customer_name, u.fullname AS approved_by_user_name, er.approval_date 
            FROM exchange_requests er 
            JOIN customers c ON er.customer_id = c.id 
            LEFT JOIN users u ON er.approved_by_user_id = u.id -- Manager Name
            WHERE er.status = 'APPROVED' AND er.requested_by_user_id = $1 
            ORDER BY er.approval_date DESC;
        `;
        const result = await db.query(query, [userId]);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching approved requests for confirmation:', error);
        res.status(500).json({ error: 'Failed to fetch requests.' });
    }
});


/**
 * Route 5: Manager/Admin fetches all PENDING exchange requests.
 */
router.get('/pending', authenticate, async (req, res) => {
    if (!['admin', 'manager'].includes(req.user.role)) {
        return res.status(403).json({ error: 'Forbidden. Only managers or admins can view pending exchange requests.' });
    }

    try {
        const query = `
            SELECT er.id, er.created_at, er.reason, er.items_requested_jsonb, c.fullname AS customer_name, u.fullname AS requested_by_user_name, er.original_sale_id
            FROM exchange_requests er
            JOIN customers c ON er.customer_id = c.id
            LEFT JOIN users u ON er.requested_by_user_id = u.id -- Requester Name
            WHERE er.status = 'PENDING'
            ORDER BY er.created_at ASC;
        `;
        const result = await db.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching pending exchange requests:', error);
        res.status(500).json({ error: 'Failed to fetch pending requests.' });
    }
});

// Add other routes as needed (e.g., /recorded)

module.exports = router;