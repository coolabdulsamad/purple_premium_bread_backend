// purple-premium-bread-api/routes/branches.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// POST /api/branches - Register a new branch
router.post('/', async (req, res) => {
    const { name, contact_person, phone, address } = req.body;
    try {
        const result = await db.pool.query(
            'INSERT INTO branches (name, contact_person, phone, address) VALUES ($1, $2, $3, $4) RETURNING *',
            [name, contact_person, phone, address]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error registering branch:', error);
        res.status(500).json({ error: 'Failed to register branch.', details: error.message });
    }
});

// GET /api/branches - Get all branches
router.get('/', async (req, res) => {
    try {
        const result = await db.pool.query('SELECT * FROM branches ORDER BY created_at DESC');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching branches:', error);
        res.status(500).json({ error: 'Failed to fetch branches.', details: error.message });
    }
});

module.exports = router;