// routes/staff.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const authenticate = require('../middleware/authenticate');

// GET /api/staff - Get all staff (both users and non-users)
router.get('/', async (req, res) => {
    try {
        const { type, search, isActive } = req.query;

        // Get users (system users)
        const usersQuery = `
            SELECT 
                id, username, fullname, email, phone_number, role, 
                is_active, 'user' as staff_type, created_at
            FROM users 
            WHERE 1=1
        `;
        
        // Get staff members (non-users)
        const staffMembersQuery = `
            SELECT 
                id, fullname, phone_number, position as role, 
                is_active, 'staff_member' as staff_type, created_at,
                email, department, gender, date_of_birth, address,
                emergency_contact_name, emergency_contact_phone
            FROM staff_members 
            WHERE 1=1
        `;

        const userParams = [];
        const staffParams = [];
        let userParamCount = 1;
        let staffParamCount = 1;

        // Add filters for users
        if (isActive !== undefined) {
            usersQuery += ` AND is_active = $${userParamCount}`;
            userParams.push(isActive === 'true');
            userParamCount++;
        }

        if (search) {
            usersQuery += ` AND (fullname ILIKE $${userParamCount} OR email ILIKE $${userParamCount} OR username ILIKE $${userParamCount})`;
            userParams.push(`%${search}%`);
            userParamCount++;
        }

        // Add filters for staff members
        if (isActive !== undefined) {
            staffMembersQuery += ` AND is_active = $${staffParamCount}`;
            staffParams.push(isActive === 'true');
            staffParamCount++;
        }

        if (search) {
            staffMembersQuery += ` AND (fullname ILIKE $${staffParamCount} OR email ILIKE $${staffParamCount})`;
            staffParams.push(`%${search}%`);
            staffParamCount++;
        }

        // Execute both queries
        const [usersResult, staffMembersResult] = await Promise.all([
            db.query(usersQuery, userParams),
            db.query(staffMembersQuery, staffParams)
        ]);

        // Combine results
        const allStaff = [
            ...usersResult.rows.map(user => ({ ...user, staff_type: 'user' })),
            ...staffMembersResult.rows.map(staff => ({ ...staff, staff_type: 'staff_member' }))
        ];

        // Filter by type if specified
        const filteredStaff = type ? allStaff.filter(staff => staff.staff_type === type) : allStaff;

        res.status(200).json(filteredStaff);
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.status(500).json({ error: 'Failed to fetch staff.', details: error.message });
    }
});

// POST /api/staff/members - Create new staff member
router.post('/members', authenticate, async (req, res) => {
    const {
        fullname,
        phone_number,
        position,
        department,
        email,
        gender,
        date_of_birth,
        address,
        emergency_contact_name,
        emergency_contact_phone
    } = req.body;

    try {
        const query = `
            INSERT INTO staff_members (
                fullname, phone_number, position, department, email,
                gender, date_of_birth, address, emergency_contact_name,
                emergency_contact_phone, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
            RETURNING *
        `;

        const result = await db.query(query, [
            fullname,
            phone_number,
            position,
            department,
            email,
            gender,
            date_of_birth,
            address,
            emergency_contact_name,
            emergency_contact_phone
        ]);

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating staff member:', error);
        res.status(500).json({ error: 'Failed to create staff member.', details: error.message });
    }
});

// PUT /api/staff/members/:id - Update staff member
router.put('/members/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    const {
        fullname,
        phone_number,
        position,
        department,
        email,
        gender,
        date_of_birth,
        address,
        emergency_contact_name,
        emergency_contact_phone,
        is_active
    } = req.body;

    try {
        const query = `
            UPDATE staff_members 
            SET fullname = $1, phone_number = $2, position = $3, 
                department = $4, email = $5, gender = $6, date_of_birth = $7,
                address = $8, emergency_contact_name = $9, 
                emergency_contact_phone = $10, is_active = $11,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $12
            RETURNING *
        `;

        const result = await db.query(query, [
            fullname,
            phone_number,
            position,
            department,
            email,
            gender,
            date_of_birth,
            address,
            emergency_contact_name,
            emergency_contact_phone,
            is_active,
            id
        ]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found.' });
        }

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating staff member:', error);
        res.status(500).json({ error: 'Failed to update staff member.', details: error.message });
    }
});

module.exports = router;