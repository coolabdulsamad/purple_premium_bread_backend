// purple-premium-bread-api/routes/staff.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { jwtDecode } = require('jwt-decode');
// Helper to convert to Nigeria time
const toNigeriaTime = (dateString) => {
    if (!dateString) return null;
    
    const date = new Date(dateString);
    // Nigeria is GMT+1, so we need to adjust if the time is in UTC
    const nigeriaTime = new Date(date.getTime() + (60 * 60 * 1000));
    return nigeriaTime.toISOString();
};

// Helper to get user ID from token - UPDATED
const getUserIdFromToken = (req) => {
    try {
        const authHeader = req.headers.authorization;
        console.log('Auth header:', authHeader); // Debug log
        
        if (!authHeader) {
            console.log('No authorization header');
            return null;
        }

        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
        
        if (!token) {
            console.log('No token found');
            return null;
        }

        const decoded = jwtDecode(token);
        console.log('Decoded token:', decoded); // Debug log
        
        return decoded.id;
    } catch (e) {
        console.error("Failed to decode token for staff operations:", e);
        return null;
    }
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

// Updated: Staff Members Management with complete details
router.get('/members', async (req, res) => {
    try {
        const { department, isActive } = req.query;
        let query = `
            SELECT 
                id, fullname, phone_number, email, gender, date_of_birth, 
                position, department, address, emergency_contact_name, 
                emergency_contact_phone, is_active, created_at
            FROM staff_members
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (department) {
            query += ` AND department ILIKE $${paramIndex++}`;
            params.push(`%${department}%`);
        }
        if (isActive !== undefined) {
            query += ` AND is_active = $${paramIndex++}`;
            params.push(isActive === 'true');
        }

        query += ` ORDER BY fullname ASC`;

        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching staff members:', error);
        res.status(500).json({ error: 'Failed to fetch staff members.', details: error.message });
    }
});

router.post('/members', async (req, res) => {
    const { 
        fullname, phone_number, email, gender, date_of_birth,
        position, department, address, emergency_contact_name, 
        emergency_contact_phone, is_active 
    } = req.body;
    
    if (!fullname) {
        return res.status(400).json({ error: 'Full name is required.' });
    }

    try {
        const result = await db.query(
            `INSERT INTO staff_members 
                (fullname, phone_number, email, gender, date_of_birth,
                 position, department, address, emergency_contact_name, 
                 emergency_contact_phone, is_active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             RETURNING *`,
            [
                fullname, phone_number, email, gender, date_of_birth,
                position, department, address, emergency_contact_name,
                emergency_contact_phone, is_active !== false
            ]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating staff member:', error);
        res.status(500).json({ error: 'Failed to create staff member.', details: error.message });
    }
});

router.put('/members/:id', async (req, res) => {
    const { id } = req.params;
    const { 
        fullname, phone_number, email, gender, date_of_birth,
        position, department, address, emergency_contact_name, 
        emergency_contact_phone, is_active 
    } = req.body;

    try {
        const result = await db.query(
            `UPDATE staff_members 
             SET 
                fullname = $1, phone_number = $2, email = $3, gender = $4, 
                date_of_birth = $5, position = $6, department = $7, 
                address = $8, emergency_contact_name = $9, 
                emergency_contact_phone = $10, is_active = $11, 
                updated_at = NOW()
             WHERE id = $12
             RETURNING *`,
            [
                fullname, phone_number, email, gender, date_of_birth,
                position, department, address, emergency_contact_name,
                emergency_contact_phone, is_active, id
            ]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Staff member not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating staff member:', error);
        res.status(500).json({ error: 'Failed to update staff member.', details: error.message });
    }
});

// NEW: Staff Attendance Management
router.post('/attendance', async (req, res) => {
    const { user_id, staff_member_id, attendance_date, sign_in_time, sign_out_time, status, notes } = req.body;
    const recorded_by = getUserIdFromToken(req);

    if (!recorded_by) {
        return res.status(401).json({ error: 'Unauthorized: User not identified.' });
    }

    if (!attendance_date) {
        return res.status(400).json({ error: 'Attendance date is required.' });
    }

    // Validate that either user_id or staff_member_id is provided
    if (!user_id && !staff_member_id) {
        return res.status(400).json({ error: 'Either user ID or staff member ID is required.' });
    }

    try {
        // Check if attendance already exists for this person on this date
        const existingQuery = `
            SELECT id FROM staff_attendance 
            WHERE attendance_date = $1 AND (
                (user_id = $2 AND user_id IS NOT NULL) OR 
                (staff_member_id = $3 AND staff_member_id IS NOT NULL)
            )
        `;
        const existingResult = await db.query(existingQuery, [attendance_date, user_id, staff_member_id]);

        if (existingResult.rows.length > 0) {
            return res.status(409).json({ error: 'Attendance already recorded for this staff on this date.' });
        }

        const result = await db.query(
            `INSERT INTO staff_attendance (user_id, staff_member_id, attendance_date, sign_in_time, sign_out_time, status, notes, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [user_id, staff_member_id, attendance_date, sign_in_time, sign_out_time, status, notes, recorded_by]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error recording attendance:', error);
        res.status(500).json({ error: 'Failed to record attendance.', details: error.message });
    }
});

router.put('/attendance/:id/sign-out', async (req, res) => {
    const { id } = req.params;
    const { sign_out_time, notes } = req.body;

    try {
        const result = await db.query(
            `UPDATE staff_attendance 
             SET sign_out_time = $1, notes = COALESCE($2, notes)
             WHERE id = $3
             RETURNING *`,
            [sign_out_time, notes, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Attendance record not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating sign-out time:', error);
        res.status(500).json({ error: 'Failed to update sign-out time.', details: error.message });
    }
});

router.get('/attendance', async (req, res) => {
    const { 
        startDate, 
        endDate, 
        userId, 
        staffMemberId, 
        department, 
        status,
        showPunctual 
    } = req.query;

    let query = `
        SELECT 
            sa.*,
            u.fullname as user_fullname,
            u.role as user_role,
            sm.fullname as staff_member_fullname,
            sm.position as staff_member_position,
            sm.department as staff_member_department,
            recorder.fullname as recorded_by_name
        FROM staff_attendance sa
        LEFT JOIN users u ON sa.user_id = u.id
        LEFT JOIN staff_members sm ON sa.staff_member_id = sm.id
        LEFT JOIN users recorder ON sa.recorded_by = recorder.id
        WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (startDate) {
        query += ` AND sa.attendance_date >= $${paramIndex++}`;
        params.push(startDate);
    }
    if (endDate) {
        query += ` AND sa.attendance_date <= $${paramIndex++}`;
        params.push(endDate);
    }
    if (userId) {
        query += ` AND sa.user_id = $${paramIndex++}`;
        params.push(userId);
    }
    if (staffMemberId) {
        query += ` AND sa.staff_member_id = $${paramIndex++}`;
        params.push(staffMemberId);
    }
    if (department) {
        query += ` AND (u.role = $${paramIndex} OR sm.department = $${paramIndex})`;
        params.push(department);
        paramIndex++;
    }
    if (status) {
        query += ` AND sa.status = $${paramIndex++}`;
        params.push(status);
    }

    query += ` ORDER BY sa.attendance_date DESC, sa.sign_in_time DESC`;

    try {
        const result = await db.query(query, params);
        
        // Filter for punctual staff if requested
        let attendanceData = result.rows;
        if (showPunctual === 'true') {
            attendanceData = attendanceData.filter(record => {
                if (!record.sign_in_time) return false;
                
                const signInTime = new Date(record.sign_in_time);
                const expectedTime = new Date(record.attendance_date);
                expectedTime.setHours(8, 0, 0, 0); // Expected sign-in at 8:00 AM
                
                return signInTime <= expectedTime; // Signed in on or before expected time
            });
        }

        res.status(200).json(attendanceData);
    } catch (error) {
        console.error('Error fetching attendance:', error);
        res.status(500).json({ error: 'Failed to fetch attendance records.', details: error.message });
    }
});

// NEW: Get attendance statistics
router.get('/attendance/stats', async (req, res) => {
    const { startDate, endDate } = req.query;

    try {
        const query = `
            SELECT 
                COALESCE(u.fullname, sm.fullname) as staff_name,
                COUNT(*) as total_days,
                COUNT(CASE WHEN sa.status = 'Present' THEN 1 END) as present_days,
                COUNT(CASE WHEN sa.status = 'Absent' THEN 1 END) as absent_days,
                COUNT(CASE WHEN sa.status = 'Late' THEN 1 END) as late_days,
                AVG(EXTRACT(EPOCH FROM (sa.sign_out_time - sa.sign_in_time))/3600) as avg_hours_worked
            FROM staff_attendance sa
            LEFT JOIN users u ON sa.user_id = u.id
            LEFT JOIN staff_members sm ON sa.staff_member_id = sm.id
            WHERE sa.attendance_date >= $1 AND sa.attendance_date <= $2
            GROUP BY staff_name
            ORDER BY present_days DESC
        `;
        
        const result = await db.query(query, [startDate || '2024-01-01', endDate || '2024-12-31']);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching attendance stats:', error);
        res.status(500).json({ error: 'Failed to fetch attendance statistics.', details: error.message });
    }
});

module.exports = router;
