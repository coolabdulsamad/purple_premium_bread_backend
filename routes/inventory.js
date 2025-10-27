// purple-premium-bread-api/routes/inventory.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// GET /api/inventory - Fetch current inventory levels
router.get('/', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                i.product_id,
                p.name AS product_name,
                i.quantity
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            ORDER BY p.name ASC
        `);
        res.status(200).json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch inventory.', details: error.message });
    }
});

// POST /api/inventory/update - Manually adjust inventory (e.g., for spoilage)
router.post('/update', async (req, res) => {
    const { productId, adjustmentQuantity } = req.body;
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        const updateQuery = `
            UPDATE inventory
            SET quantity = quantity + $1
            WHERE product_id = $2
            RETURNING *;
        `;
        const result = await client.query(updateQuery, [adjustmentQuantity, productId]);
        if (result.rowCount === 0) {
            throw new Error('Product not found in inventory.');
        }
        await client.query('COMMIT');
        res.status(200).json({ message: 'Inventory updated successfully.', inventory: result.rows[0] });
    } catch (error) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: 'Failed to update inventory.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/inventory/detailed - Fetch inventory with full product details
router.get('/detailed', async (req, res) => {
    try {
        const query = `
            SELECT 
                i.product_id, 
                i.quantity, 
                i.last_updated, 
                p.name AS product_name, 
                p.category AS product_category, 
                p.price,
                p.description,
                p.image_url
            FROM 
                inventory i
            JOIN 
                products p ON i.product_id = p.id
            ORDER BY 
                p.name ASC;
        `;
        const { rows } = await db.pool.query(query);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching detailed inventory:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// NEW: POST /api/inventory/manage-user-stock - Issue or return stock from a sales user
router.post('/manage-user-stock', async (req, res) => {
    const { adminId, userId, type, products } = req.body; // type: 'issue' or 'return'
    
    // ✅ FIX 1: Convert type to uppercase for the ENUM
    const issueType = type.toUpperCase(); // Becomes 'ISSUE' or 'RETURN'

    if (!['ISSUE', 'RETURN'].includes(issueType)) { // Check against uppercase value
        return res.status(400).json({ error: 'Invalid operation type.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        for (const productIdStr in products) {
            const productId = parseInt(productIdStr);
            const quantity = parseInt(products[productIdStr]);
            if (quantity <= 0) continue;

            // ... (Sections 1 and 2 are correct and remain unchanged) ...
            const invAdjustment = issueType === 'ISSUE' ? -quantity : quantity;
            await client.query(
                `UPDATE inventory SET quantity = quantity + $1, last_updated = NOW() WHERE product_id = $2`,
                [invAdjustment, productId]
            );

            const userStockAdjustment = issueType === 'ISSUE' ? quantity : -quantity;
            await client.query(
                `INSERT INTO sales_user_stock (user_id, product_id, quantity, last_updated)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (user_id, product_id) 
                 DO UPDATE SET quantity = sales_user_stock.quantity + $3, last_updated = NOW()`,
                [userId, productId, userStockAdjustment]
            );
            
            // 3. Log the Transaction - FIX APPLIED
            const isIssue = issueType === 'ISSUE';

            await client.query(
                `INSERT INTO stock_issue_log (
                    product_id, 
                    issue_type,
                    from_user_id, 
                    to_user_id, 
                    quantity_changed, 
                    recorded_by
                )
                 VALUES ($1, $2, $3, $4, $5, $6)`, 
                [
                    productId, 
                    issueType, // ✅ FIX 2: Use the UPPERCASE value
                    isIssue ? adminId : userId, 
                    isIssue ? userId : adminId, 
                    quantity, 
                    adminId 
                ]
            );
        }

        await client.query('COMMIT');
        res.status(200).json({ message: `Stock ${type} successful.` });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error managing user stock (${type}):`, error.message);
        res.status(500).json({ error: `Failed to ${type} stock.`, details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/inventory - Original simple endpoint (can be kept or removed)
// router.get('/', async (req, res) => {
//     try {
//         const query = 'SELECT product_id, quantity FROM inventory';
//         const { rows } = await db.pool.query(query);
//         res.json(rows);
//     } catch (err) {
//         console.error('Error fetching simple inventory:', err);
//         res.status(500).json({ error: 'Internal Server Error' });
//     }
// });

module.exports = router;