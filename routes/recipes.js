// purple-premium-bread-api/routes/recipes.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// GET /api/recipes - Fetch all recipes, or filter by product_id
router.get('/', async (req, res) => {
    const { productId } = req.query;
    let query = `
        SELECT
            r.product_id,
            p.name AS product_name,
            p.image_url AS product_image_url,
            p.units AS product_units,
            r.raw_material_id,
            rm.name AS raw_material_name,
            rm.unit AS raw_material_unit,
            r.quantity_required,
            rm.restock_price_per_unit AS raw_material_cost_per_unit -- Get the current restock price
        FROM recipes r
        JOIN products p ON r.product_id = p.id
        JOIN raw_materials rm ON r.raw_material_id = rm.id
        WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (productId) {
        query += ` AND r.product_id = $${paramIndex++}`;
        params.push(productId);
    }

    query += ` ORDER BY p.name, rm.name ASC`;

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching recipes:', error);
        res.status(500).json({ error: 'Failed to fetch recipes.', details: error.message });
    }
});

// GET /api/recipes/:productId/:rawMaterialId - Fetch a single recipe item
router.get('/:productId/:rawMaterialId', async (req, res) => {
    const { productId, rawMaterialId } = req.params;
    try {
        const result = await db.query(
            `SELECT
                r.product_id,
                p.name AS product_name,
                p.image_url AS product_image_url,
                p.units AS product_units,
                r.raw_material_id,
                rm.name AS raw_material_name,
                rm.unit AS raw_material_unit,
                r.quantity_required,
                rm.restock_price_per_unit AS raw_material_cost_per_unit
            FROM recipes r
            JOIN products p ON r.product_id = p.id
            JOIN raw_materials rm ON r.raw_material_id = rm.id
            WHERE r.product_id = $1 AND r.raw_material_id = $2`,
            [productId, rawMaterialId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Recipe item not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching recipe item:', error);
        res.status(500).json({ error: 'Failed to fetch recipe item.', details: error.message });
    }
});


// In your POST route - ensure proper precision handling
router.post('/', async (req, res) => {
    const { product_id, raw_material_id, quantity_required } = req.body;
    
    try {
        // Parse and ensure proper precision
        const preciseQuantity = parseFloat(parseFloat(quantity_required).toFixed(6));
        
        const result = await db.query(
            `INSERT INTO recipes (product_id, raw_material_id, quantity_required)
             VALUES ($1, $2, $3)
             RETURNING *`,
            [product_id, raw_material_id, preciseQuantity]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error adding raw material to recipe:', error);
        if (error.code === '23505') {
            return res.status(409).json({ error: 'This raw material is already in the recipe for this product. Please edit instead.' });
        }
        res.status(500).json({ error: 'Failed to add raw material to recipe.', details: error.message });
    }
});

// In your PUT route
router.put('/:productId/:rawMaterialId', async (req, res) => {
    const { productId, rawMaterialId } = req.params;
    const { quantity_required } = req.body;
    
    try {
        // Ensure precision
        const preciseQuantity = parseFloat(parseFloat(quantity_required).toFixed(6));
        
        const result = await db.query(
            `UPDATE recipes
             SET quantity_required = $1
             WHERE product_id = $2 AND raw_material_id = $3
             RETURNING *`,
            [preciseQuantity, productId, rawMaterialId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Recipe item not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating recipe item quantity:', error);
        res.status(500).json({ error: 'Failed to update recipe item quantity.', details: error.message });
    }
});

// DELETE /api/recipes/:productId/:rawMaterialId - Remove a raw material from a product's recipe
router.delete('/:productId/:rawMaterialId', async (req, res) => {
    const { productId, rawMaterialId } = req.params;
    try {
        const result = await db.query(
            `DELETE FROM recipes WHERE product_id = $1 AND raw_material_id = $2`,
            [productId, rawMaterialId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Recipe item not found.' });
        }
        res.status(200).json({ message: 'Raw material removed from recipe successfully.' });
    } catch (error) {
        console.error('Error removing raw material from recipe:', error);
        res.status(500).json({ error: 'Failed to remove raw material from recipe.', details: error.message });
    }
});

module.exports = router;
