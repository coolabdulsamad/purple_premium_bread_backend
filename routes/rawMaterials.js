// purple-premium-bread-api/routes/rawMaterials.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// GET /api/raw-materials - Fetch all raw materials with optional filters
router.get('/', async (req, res) => {
    const { searchTerm, unit, minStock, maxStock } = req.query;
    let query = `
        SELECT 
            id, name, unit, current_stock, min_stock_level, supplier_info, 
            last_restock_date, restock_price_per_unit, created_at, updated_at
        FROM raw_materials
        WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (searchTerm) {
        query += ` AND (name ILIKE $${paramIndex} OR supplier_info ILIKE $${paramIndex})`;
        params.push(`%${searchTerm}%`);
        paramIndex++;
    }
    if (unit) {
        query += ` AND unit ILIKE $${paramIndex}`;
        params.push(`%${unit}%`);
        paramIndex++;
    }
    if (minStock) {
        query += ` AND current_stock >= $${paramIndex}`;
        params.push(parseFloat(minStock));
        paramIndex++;
    }
    if (maxStock) {
        query += ` AND current_stock <= $${paramIndex}`;
        params.push(parseFloat(maxStock));
        paramIndex++;
    }

    query += ` ORDER BY name ASC`;

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching raw materials:', error);
        res.status(500).json({ error: 'Failed to fetch raw materials.', details: error.message });
    }
});

// GET /api/raw-materials/:id - Fetch a single raw material by ID
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query(
            `SELECT 
                id, name, unit, current_stock, min_stock_level, supplier_info, 
                last_restock_date, restock_price_per_unit, created_at, updated_at
             FROM raw_materials WHERE id = $1`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Raw material not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching raw material:', error);
        res.status(500).json({ error: 'Failed to fetch raw material.', details: error.message });
    }
});

// POST /api/raw-materials - Create a new raw material
router.post('/', async (req, res) => {
    const { name, unit, current_stock, min_stock_level, supplier_info, restock_price_per_unit } = req.body;
    try {
        const result = await db.query(
            `INSERT INTO raw_materials (name, unit, current_stock, min_stock_level, supplier_info, restock_price_per_unit)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, name, unit, current_stock, min_stock_level, supplier_info, restock_price_per_unit, created_at`,
            [name, unit, current_stock || 0, min_stock_level || 0, supplier_info, restock_price_per_unit || 0]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating raw material:', error);
        if (error.code === '23505') { // Unique violation
            return res.status(409).json({ error: 'Raw material with this name already exists.' });
        }
        res.status(500).json({ error: 'Failed to create raw material.', details: error.message });
    }
});

// PUT /api/raw-materials/:id - Update an existing raw material
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, unit, current_stock, min_stock_level, supplier_info, last_restock_date, restock_price_per_unit } = req.body;
    try {
        const result = await db.query(
            `UPDATE raw_materials
             SET name = $1, unit = $2, current_stock = $3, min_stock_level = $4,
                 supplier_info = $5, last_restock_date = $6, restock_price_per_unit = $7, updated_at = NOW()
             WHERE id = $8
             RETURNING id, name, unit, current_stock, min_stock_level, supplier_info, last_restock_date, restock_price_per_unit, updated_at`,
            [name, unit, current_stock, min_stock_level, supplier_info, last_restock_date, restock_price_per_unit, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Raw material not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating raw material:', error);
        if (error.code === '23505') { // Unique violation
            return res.status(409).json({ error: 'Raw material with this name already exists.' });
        }
        res.status(500).json({ error: 'Failed to update raw material.', details: error.message });
    }
});

// DELETE /api/raw-materials/:id - Delete a raw material
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        // First, check if the raw material is used in any recipes
        const recipeCheck = await db.query('SELECT COUNT(*) FROM recipes WHERE raw_material_id = $1', [id]);
        if (parseInt(recipeCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete raw material. It is used in one or more recipes.' });
        }

        // Then check if it's referenced in material_transactions
        const transactionCheck = await db.query('SELECT COUNT(*) FROM material_transactions WHERE raw_material_id = $1', [id]);
        if (parseInt(transactionCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete raw material. It has associated material transactions.' });
        }

        const result = await db.query('DELETE FROM raw_materials WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Raw material not found.' });
        }
        res.status(200).json({ message: 'Raw material deleted successfully.' });
    } catch (error) {
        console.error('Error deleting raw material:', error);
        res.status(500).json({ error: 'Failed to delete raw material.', details: error.message });
    }
});

module.exports = router;
