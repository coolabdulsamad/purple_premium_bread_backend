// purple-premium-bread-api/routes/staff.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { jwtDecode } = require('jwt-decode');

// Helper to get user ID from token
const getUserIdFromToken = (req) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) {
            const decoded = jwtDecode(token);
            return decoded.id;
        }
    } catch (e) {
        console.error("Failed to decode token for staff operations", e);
    }
    return null;
};

// POST /api/staff/duties - Create a new staff duty assignment
router.post('/duties', async (req, res) => {
    const { user_id, duty_date, shift_name, duty_description } = req.body;
    const assigned_by_user_id = getUserIdFromToken(req);

    if (!assigned_by_user_id) {
        return res.status(401).json({ error: 'Unauthorized: User not identified to assign duties.' });
    }
    if (!user_id || !duty_date || !shift_name) {
        return res.status(400).json({ error: 'Missing required fields: user_id, duty_date, shift_name.' });
    }

    try {
        const result = await db.query(
            `INSERT INTO staff_duties (user_id, duty_date, shift_name, duty_description, assigned_by_user_id)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *;`,
            [user_id, duty_date, shift_name, duty_description, assigned_by_user_id]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating staff duty:', error);
        if (error.code === '23505') { // Unique violation for (user_id, duty_date, shift_name)
            return res.status(409).json({ error: `User ID ${user_id} already has a duty assigned for ${new Date(duty_date).toLocaleDateString()} during the ${shift_name} shift.` });
        }
        res.status(500).json({ error: 'Failed to create staff duty.', details: error.message });
    }
});

// GET /api/staff/duties - Fetch all staff duty assignments with filters
router.get('/duties', async (req, res) => {
    const { userId, startDate, endDate, shiftName } = req.query;
    let query = `
        SELECT
            sd.id,
            sd.user_id,
            u.fullname AS user_fullname,
            u.role AS user_role,
            sd.duty_date,
            sd.shift_name,
            sd.duty_description,
            sd.created_at,
            assigner.fullname AS assigned_by_fullname
        FROM staff_duties sd
        JOIN users u ON sd.user_id = u.id
        LEFT JOIN users assigner ON sd.assigned_by_user_id = assigner.id
        WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (userId) {
        query += ` AND sd.user_id = $${paramIndex++}`;
        params.push(userId);
    }
    if (startDate) {
        query += ` AND sd.duty_date >= $${paramIndex++}`;
        params.push(startDate);
    }
    if (endDate) {
        query += ` AND sd.duty_date <= $${paramIndex++}`;
        params.push(endDate);
    }
    if (shiftName) {
        query += ` AND sd.shift_name ILIKE $${paramIndex++}`;
        params.push(`%${shiftName}%`);
    }

    query += ` ORDER BY sd.duty_date DESC, sd.shift_name ASC`;

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching staff duties:', error);
        res.status(500).json({ error: 'Failed to fetch staff duties.', details: error.message });
    }
});

// PUT /api/staff/duties/:id - Update a staff duty assignment
router.put('/duties/:id', async (req, res) => {
    const { id } = req.params;
    const { user_id, duty_date, shift_name, duty_description } = req.body; // user_id and duty_date for unique constraint check
    const assigned_by_user_id = getUserIdFromToken(req); // For auditing

    if (!assigned_by_user_id) {
        return res.status(401).json({ error: 'Unauthorized: User not identified to update duties.' });
    }
    if (!user_id || !duty_date || !shift_name) {
        return res.status(400).json({ error: 'Missing required fields: user_id, duty_date, shift_name.' });
    }

    try {
        const result = await db.query(
            `UPDATE staff_duties
             SET user_id = $1, duty_date = $2, shift_name = $3, duty_description = $4, created_at = NOW() -- using created_at for update time for simplicity, could be updated_at
             WHERE id = $5
             RETURNING *;`,
            [user_id, duty_date, shift_name, duty_description, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Staff duty assignment not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating staff duty:', error);
        if (error.code === '23505') { // Unique violation for (user_id, duty_date, shift_name)
            return res.status(409).json({ error: `User ID ${user_id} already has a duty assigned for ${new Date(duty_date).toLocaleDateString()} during the ${shift_name} shift.` });
        }
        res.status(500).json({ error: 'Failed to update staff duty.', details: error.message });
    }
});

// DELETE /api/staff/duties/:id - Delete a staff duty assignment
router.delete('/duties/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query(
            `DELETE FROM staff_duties WHERE id = $1;`,
            [id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Staff duty assignment not found.' });
        }
        res.status(200).json({ message: 'Staff duty assignment deleted successfully.' });
    } catch (error) {
        console.error('Error deleting staff duty:', error);
        res.status(500).json({ error: 'Failed to delete staff duty.', details: error.message });
    }
});

module.exports = router;
