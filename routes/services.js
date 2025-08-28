const express = require('express');
const router = express.Router();
const db = require('../db/db');

// router.get('/services', async (req, res) => {
//     try {
//         const result = await db.pool.query('SELECT * FROM services WHERE is_active = true');
//         res.status(200).json(result.rows);
//     } catch (error) {
//         console.error('Error fetching services:', error);
//         res.status(500).json({ error: 'Failed to fetch services.', details: error.message });
//     }
// });

router.get('/', async (req, res) => {
    try {
        const result = await db.pool.query('SELECT * FROM services WHERE is_active = true');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching services:', error);
        res.status(500).json({ error: 'Failed to fetch services.', details: error.message });
    }
});

module.exports = router;