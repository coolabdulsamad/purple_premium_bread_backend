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
    const { adminId, userId, type, products } = req.body; // type: 'issue' or 'return', products: {productId: quantity, ...}

    if (!['issue', 'return'].includes(type)) {
        return res.status(400).json({ error: 'Invalid operation type.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        for (const productIdStr in products) {
            const productId = parseInt(productIdStr);
            const quantity = parseInt(products[productIdStr]);
            if (quantity <= 0) continue;

            // 1. Update Main Inventory
            const invAdjustment = type === 'issue' ? -quantity : quantity;
            await client.query(
                `UPDATE inventory SET quantity = quantity + $1, last_updated = NOW() WHERE product_id = $2`,
                [invAdjustment, productId]
            );

            // 2. Update Sales User Stock (Insert or Update)
            const userStockAdjustment = type === 'issue' ? quantity : -quantity;
            await client.query(
                `INSERT INTO sales_user_stock (user_id, product_id, quantity, last_updated)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (user_id, product_id) 
                 DO UPDATE SET quantity = sales_user_stock.quantity + $3, last_updated = NOW()`,
                [userId, productId, userStockAdjustment]
            );
            
            // 3. Log the Transaction (Optional but highly recommended for audit)
// In purple-premium-bread-api/routes/inventory.js, inside POST /api/inventory/manage-user-stock

// 3. Log the Transaction (Optional but highly recommended for audit)
// Fix the column names in the INSERT query to match the corrected schema
await client.query(
    `INSERT INTO stock_issue_log (
        product_id, 
        issue_type,
        from_user_id, 
        to_user_id, 
        quantity_changed, 
        recorded_by
    )
     VALUES ($1, $2, $3, $4, $5, $6)`, // Updated number of parameters
    [
        productId, 
        type, // This is the issue_type_enum value (e.g., 'ISSUE', 'RETURN')
        (type === 'ISSUE' ? adminId : userId), // Example: If ISSUING, from admin to user.
        (type === 'ISSUE' ? userId : adminId), // Example: If RETURNING, from user to admin.
        quantity, 
        adminId // The manager/admin who recorded the action
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