// // purple-premium-bread-api/routes/branches.js
// const express = require('express');
// const router = express.Router();
// const db = require('../db/db');

// // POST /api/branches - Register a new branch
// router.post('/', async (req, res) => {
//     const { name, contact_person, phone, address } = req.body;
//     try {
//         const result = await db.pool.query(
//             'INSERT INTO branches (name, contact_person, phone, address) VALUES ($1, $2, $3, $4) RETURNING *',
//             [name, contact_person, phone, address]
//         );
//         res.status(201).json(result.rows[0]);
//     } catch (error) {
//         console.error('Error registering branch:', error);
//         res.status(500).json({ error: 'Failed to register branch.', details: error.message });
//     }
// });

// // GET /api/branches - Get all branches
// router.get('/', async (req, res) => {
//     try {
//         const result = await db.pool.query('SELECT * FROM branches ORDER BY created_at DESC');
//         res.status(200).json(result.rows);
//     } catch (error) {
//         console.error('Error fetching branches:', error);
//         res.status(500).json({ error: 'Failed to fetch branches.', details: error.message });
//     }
// });

// module.exports = router;



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

// GET /api/branches/:id - Get a single branch by ID
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.pool.query('SELECT * FROM branches WHERE id = $1', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Branch not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching branch:', error);
        res.status(500).json({ error: 'Failed to fetch branch.', details: error.message });
    }
});

// PUT /api/branches/:id - Update a branch
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, contact_person, phone, address } = req.body;
    
    try {
        const result = await db.pool.query(
            'UPDATE branches SET name = $1, contact_person = $2, phone = $3, address = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING *',
            [name, contact_person, phone, address, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Branch not found.' });
        }
        
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating branch:', error);
        res.status(500).json({ error: 'Failed to update branch.', details: error.message });
    }
});

// DELETE /api/branches/:id - Delete a branch
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    
    try {
        const result = await db.pool.query('DELETE FROM branches WHERE id = $1 RETURNING *', [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Branch not found.' });
        }
        
        res.status(200).json({ message: 'Branch deleted successfully.', deletedBranch: result.rows[0] });
    } catch (error) {
        console.error('Error deleting branch:', error);
        res.status(500).json({ error: 'Failed to delete branch.', details: error.message });
    }
});

module.exports = router;