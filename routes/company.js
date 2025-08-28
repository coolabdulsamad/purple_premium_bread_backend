const express = require('express');
const router = express.Router();
const db = require('../db/db');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path')

// GET /api/company - Get company details
router.get('/', async (req, res) => {
    try {
        const result = await db.pool.query('SELECT * FROM company_details LIMIT 1');
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Company details not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching company details:', error);
        res.status(500).json({ error: 'Failed to fetch company details.', details: error.message });
    }
});

module.exports = router;