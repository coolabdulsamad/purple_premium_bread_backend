// purple-premium-bread-api/routes/materialTransactions.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { jwtDecode } = require('jwt-decode'); // Assuming jwt-decode is available in frontend, can be used for backend too if token sent

// Helper to get user ID from token (if token is sent in headers)
const getUserIdFromToken = (req) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) {
            const decoded = jwtDecode(token);
            return decoded.id;
        }
    } catch (e) {
        console.error("Failed to decode token for material transactions", e);
    }
    return null;
};

// POST /api/material-transactions/restock - Record a raw material restock
router.post('/restock', async (req, res) => {
    const { raw_material_id, quantity_added, unit_cost, notes } = req.body;
    const recorded_by_user_id = getUserIdFromToken(req); // Get user ID from token

    if (!recorded_by_user_id) {
        return res.status(401).json({ error: 'Unauthorized: User not identified.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // 1. Record the material transaction
        const transactionQuery = `
            INSERT INTO material_transactions (raw_material_id, transaction_type, quantity_change, unit_cost, recorded_by_user_id, notes, transaction_date)
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            RETURNING *;
        `;
        const transactionResult = await client.query(transactionQuery, [
            raw_material_id,
            'restock',
            quantity_added,
            unit_cost,
            recorded_by_user_id,
            notes
        ]);

        // 2. Update the raw_materials current_stock and last_restock_date
        const updateRawMaterialQuery = `
            UPDATE raw_materials
            SET
                current_stock = current_stock + $1,
                last_restock_date = CURRENT_DATE,
                restock_price_per_unit = $2, -- Update the default restock price in raw_materials
                updated_at = NOW()
            WHERE id = $3
            RETURNING *;
        `;
        const updatedRawMaterialResult = await client.query(updateRawMaterialQuery, [
            quantity_added,
            unit_cost, // The new price per unit for future COGS calculations (can be refined to moving average later)
            raw_material_id
        ]);

        if (updatedRawMaterialResult.rows.length === 0) {
            throw new Error('Raw material not found during stock update.');
        }

        await client.query('COMMIT');
        res.status(201).json({
            message: 'Raw material restocked and transaction logged successfully.',
            transaction: transactionResult.rows[0],
            rawMaterial: updatedRawMaterialResult.rows[0]
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error recording restock transaction:', error);
        res.status(500).json({ error: 'Failed to record restock.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/material-transactions - Fetch all material transactions with filters
router.get('/', async (req, res) => {
    const { rawMaterialId, transactionType, startDate, endDate, recordedByUserId } = req.query;
    let query = `
        SELECT
            mt.id,
            mt.transaction_type,
            mt.quantity_change,
            mt.unit_cost,
            mt.transaction_date,
            mt.notes,
            rm.name AS raw_material_name,
            rm.unit AS raw_material_unit,
            u.fullname AS recorded_by_user_name
        FROM material_transactions mt
        JOIN raw_materials rm ON mt.raw_material_id = rm.id
        LEFT JOIN users u ON mt.recorded_by_user_id = u.id
        WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (rawMaterialId) {
        query += ` AND mt.raw_material_id = $${paramIndex++}`;
        params.push(rawMaterialId);
    }
    if (transactionType) {
        query += ` AND mt.transaction_type ILIKE $${paramIndex++}`;
        params.push(`%${transactionType}%`);
    }
    if (startDate) {
        query += ` AND mt.transaction_date >= $${paramIndex++}`;
        params.push(startDate);
    }
    if (endDate) {
        query += ` AND mt.transaction_date <= $${paramIndex++}`;
        params.push(endDate);
    }
    if (recordedByUserId) {
        query += ` AND mt.recorded_by_user_id = $${paramIndex++}`;
        params.push(recordedByUserId);
    }

    query += ` ORDER BY mt.transaction_date DESC, mt.id DESC`;

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching material transactions:', error);
        res.status(500).json({ error: 'Failed to fetch material transactions.', details: error.message });
    }
});

module.exports = router;
