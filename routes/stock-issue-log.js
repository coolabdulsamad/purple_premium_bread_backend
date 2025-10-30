// purple-premium-bread-api/routes/stock-issue-log.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const authenticate = require('../middleware/authenticate');

/**
 * GET /api/stock-issue-log/history - Fetches and filters the stock_issue_log records.
 * Authorized Roles: ADMIN, MANAGER
 */
router.get('/history', authenticate, async (req, res) => {
    const userRole = req.user.role?.toUpperCase();

    if (userRole !== 'ADMIN' && userRole !== 'MANAGER') {
        return res.status(403).json({ error: 'Unauthorized. Only Managers or Admins can view stock issue history.' });
    }

    // Extract query parameters for filtering and searching
    const { 
        issue_type, 
        userId, 
        productId, 
        startDate, 
        endDate, 
        searchTerm 
    } = req.query;

    let query = `
        SELECT 
            sil.id,
            sil.quantity_changed AS quantity, -- ⭐ CRITICAL FIX: Use the correct column name and alias it to 'quantity'
            sil.issue_type,
            sil.created_at,
            p.name AS product_name,
            -- Join on users for human-readable names
            u_from.fullname AS from_user_name,
            u_to.fullname AS to_user_name,
            u_recorded.fullname AS recorded_by_name
        FROM 
            stock_issue_log sil
        JOIN 
            products p ON sil.product_id = p.id
        LEFT JOIN 
            users u_from ON sil.from_user_id = u_from.id
        LEFT JOIN 
            users u_to ON sil.to_user_id = u_to.id
        JOIN 
            users u_recorded ON sil.recorded_by = u_recorded.id
        WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    // --- Dynamic Filtering ---

    // 1. Filter by issue_type
    if (issue_type) {
        // Issue types are defined by the enum, use IN for multiple selected types
        const types = Array.isArray(issue_type) ? issue_type : [issue_type];
        query += ` AND sil.issue_type IN (${types.map(() => '$' + paramIndex++).join(', ')})`;
        params.push(...types);
    }

    // 2. Filter by user (checks both from_user and to_user)
    if (userId) {
        query += ` AND (sil.from_user_id = $${paramIndex} OR sil.to_user_id = $${paramIndex})`;
        params.push(userId);
        paramIndex++;
    }

    // 3. Filter by product
    if (productId) {
        query += ` AND sil.product_id = $${paramIndex++}`;
        params.push(productId);
    }

    // 4. Filter by date range (uses created_at for the log timestamp)
    if (startDate) {
        query += ` AND sil.created_at >= $${paramIndex++}`;
        params.push(startDate); // Assumes startDate is in a format PostgreSQL can read
    }
    if (endDate) {
        // Add one day to endDate to include records from that entire day
        query += ` AND sil.created_at < ($${paramIndex++}::date + '1 day'::interval)`;
        params.push(endDate);
    }

    // 5. Search term (searches product name, or user names)
    if (searchTerm) {
        const term = `%${searchTerm.toLowerCase()}%`;
        query += ` AND (
            LOWER(p.name) LIKE $${paramIndex} OR 
            LOWER(u_from.fullname) LIKE $${paramIndex} OR 
            LOWER(u_to.fullname) LIKE $${paramIndex}
        )`;
        params.push(term);
        paramIndex++;
    }

    // --- Finalize Query ---
    query += ` ORDER BY sil.created_at DESC`;

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching stock issue log:', error);
        res.status(500).json({ error: 'Failed to fetch stock issue history.', details: error.message });
    }
});

module.exports = router;