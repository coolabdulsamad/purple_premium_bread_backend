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