// purple-premium-bread-api/routes/users.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const bcrypt = require('bcryptjs'); // For password hashing

// Example middleware to get user from token (adjust as needed)
const authenticate = require('../middleware/authenticate');

// GET /api/users - Fetch all users with optional filters (role, search term, active)
router.get('/', async (req, res) => {
    const { role, searchTerm, activeOnly } = req.query; // Filters from frontend
    let query = `
        SELECT 
            id, fullname, username, email, phone_number, gender, role, is_active, load_from_demo_stock, created_at, updated_at
        FROM users
        WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    // Filter by role
    if (role) {
        query += ` AND role = $${paramIndex++}`;
        params.push(role);
    }
    // Search by fullname, username, or email (case-insensitive)
    if (searchTerm) {
        query += ` AND (fullname ILIKE $${paramIndex} OR username ILIKE $${paramIndex} OR email ILIKE $${paramIndex})`;
        params.push(`%${searchTerm}%`); // % for partial matching
        paramIndex++;
    }
    // Optionally restrict to active users (used by dropdowns)
    if (activeOnly === 'true') {
        query += ` AND is_active = true`;
    }
    query += ` ORDER BY fullname ASC`; // Order results

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ error: 'Failed to fetch users.', details: error.message });
    }
});

// POST /api/users - Create a new user (for admin to add users)
router.post('/', async (req, res) => {
    const { username, password, role, fullname, email, phone_number, gender } = req.body;
    try {
        // Hash the password before storing
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const result = await db.query(
            `INSERT INTO users (username, password, role, fullname, email, phone_number, gender)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             RETURNING id, fullname, username, email, phone_number, gender, role, created_at`, // Return selected fields
            [username, hashedPassword, role, fullname, email, phone_number, gender]
        );
        res.status(201).json(result.rows[0]); // Return the newly created user (without password)
    } catch (error) {
        console.error('Error creating user:', error);
        if (error.code === '23505') { // PostgreSQL unique violation error code
            return res.status(409).json({ error: 'Username or email already exists.' });
        }
        res.status(500).json({ error: 'Failed to create user.', details: error.message });
    }
});

// PUT /api/users/:id - Update an existing user
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { username, password, role, fullname, email, phone_number, gender, is_active } = req.body;

    let query = `
        UPDATE users
        SET fullname = $1, email = $2, phone_number = $3, gender = $4, role = $5, updated_at = NOW()
    `;
    const params = [fullname, email, phone_number, gender, role];
    let paramIndex = 6; // Start index for dynamic parameters

    // Only update password if a new one is provided
    if (password) {
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        query += `, password = $${paramIndex++}`;
        params.push(hashedPassword);
    }
    // Allow updating username if a new one is provided
    if (username) {
        query += `, username = $${paramIndex++}`;
        params.push(username);
    }
    // Allow toggling active status
    if (typeof is_active === 'boolean') {
        query += `, is_active = $${paramIndex++}`;
        params.push(is_active);
    }

    query += ` WHERE id = $${paramIndex}
               RETURNING id, fullname, username, email, phone_number, gender, role, is_active, updated_at`;
    params.push(id); // The ID for the WHERE clause

    try {
        const result = await db.query(query, params);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.status(200).json(result.rows[0]); // Return the updated user (without password)
    } catch (error) {
        console.error('Error updating user:', error);
        if (error.code === '23505') { // Unique violation for username/email
            return res.status(409).json({ error: 'Username or email already exists.' });
        }
        res.status(500).json({ error: 'Failed to update user.', details: error.message });
    }
});

// DELETE /api/users/:id - Delete a user
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('DELETE FROM users WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.status(200).json({ message: 'User deleted successfully.' });
    } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).json({ error: 'Failed to delete user.', details: error.message });
    }
});

// GET /api/users/me - Get current user info
router.get('/me', authenticate, async (req, res) => {
    try {
        const userId = req.user.id; // req.user set by authenticate middleware
        const result = await db.query(
            `SELECT id, fullname, username, email, phone_number, gender, role, created_at, updated_at
             FROM users WHERE id = $1`, [userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch user.', details: error.message });
    }
});

// GET /api/users/sales-accounts - Fetch all sales users and their allocated stock
router.get('/sales-accounts', async (req, res) => {
    try {
        const query = `
            SELECT 
                u.id, 
                u.fullname, 
                u.username, 
                u.load_from_demo_stock,
                COALESCE(
                    json_agg(json_build_object(
                        'product_id', sus.product_id,
                        'product_name', p.name,
                        'quantity', sus.quantity
                    ) ORDER BY p.name) FILTER (WHERE sus.product_id IS NOT NULL), 
                    '[]'
                ) AS allocated_stock
            FROM 
                users u
            LEFT JOIN 
                sales_user_stock sus ON u.id = sus.user_id
            LEFT JOIN 
                products p ON sus.product_id = p.id
            WHERE u.role = 'sales'
            GROUP BY u.id
            ORDER BY u.fullname ASC;
        `;
        const result = await db.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching sales accounts:', error);
        res.status(500).json({ error: 'Failed to fetch sales accounts.', details: error.message });
    }
});

// PUT /api/users/toggle-demo-stock/:userId - Toggle the load_from_demo_stock flag
router.put('/toggle-demo-stock/:userId', async (req, res) => {
    const { userId } = req.params;
    const { load_from_demo_stock } = req.body; // Expect a boolean: true or false

    try {
        const result = await db.query(
            `UPDATE users SET load_from_demo_stock = $1 WHERE id = $2 RETURNING id, fullname, load_from_demo_stock`,
            [load_from_demo_stock, userId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Sales user not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error toggling demo stock setting:', error);
        res.status(500).json({ error: 'Failed to update setting.', details: error.message });
    }
});

// GET /api/users/for-duties - Get all users AND staff members for duty assignments
router.get('/for-duties', async (req, res) => {
    try {
        // Get system users
        const usersQuery = `SELECT id, fullname, username, email, role FROM users WHERE is_active = true ORDER BY fullname ASC`;
        const usersResult = await db.query(usersQuery);
        
        // Get staff members (non-system users)
        const staffQuery = `SELECT id, fullname, position as role FROM staff_members WHERE is_active = true ORDER BY fullname ASC`;
        const staffResult = await db.query(staffQuery);
        
        // Combine both results
        const combined = [
            ...usersResult.rows.map(user => ({ ...user, type: 'system_user' })),
            ...staffResult.rows.map(staff => ({ ...staff, type: 'staff_member' }))
        ];
        
        res.status(200).json(combined);
    } catch (error) {
        console.error('Error fetching users for duties:', error);
        res.status(500).json({ error: 'Failed to fetch users for duties.', details: error.message });
    }
});

module.exports = router;
