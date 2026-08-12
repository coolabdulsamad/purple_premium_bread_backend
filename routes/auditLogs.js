// routes/auditLogs.js — read-only access to the audit trail (audit_logs table).
//
// GET /api/audit-logs       → paginated, filterable list
// GET /api/audit-logs/:id   → one entry with full detail (click-to-view)
//
// Access is governed by the global permission guard (/audit-logs → audit_logs.*)
// plus the seeded role permissions (admin: all, manager: view).
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const authenticate = require('../middleware/authenticate');

router.use(authenticate);

// GET /api/audit-logs — filters: user, action, entity_type, channel, startDate, endDate, search, page, limit
router.get('/', async (req, res) => {
    const {
        user, action, entity_type, channel, startDate, endDate, search,
        page = 1, limit = 30
    } = req.query;

    const where = [];
    const params = [];
    let i = 1;

    if (user) { where.push(`user_name ILIKE $${i++}`); params.push(`%${user}%`); }
    if (action) { where.push(`action = $${i++}`); params.push(action); }
    if (entity_type) { where.push(`entity_type = $${i++}`); params.push(entity_type); }
    if (channel) { where.push(`channel = $${i++}`); params.push(channel); }
    if (startDate) { where.push(`created_at >= $${i++}`); params.push(startDate); }
    if (endDate) { where.push(`created_at < ($${i++})::date + INTERVAL '1 day'`); params.push(endDate); }
    if (search) { where.push(`description ILIKE $${i++}`); params.push(`%${search}%`); }

    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

    try {
        const countRes = await db.query(`SELECT COUNT(*) AS n FROM audit_logs${whereSql}`, params);
        const total = parseInt(countRes.rows[0].n, 10);

        const offset = (parseInt(page, 10) - 1) * parseInt(limit, 10);
        const listParams = [...params, parseInt(limit, 10), offset];
        const rows = await db.query(
            `SELECT id, user_id, user_name, user_role, channel, action, entity_type, entity_id,
                    description, ip_address, created_at
             FROM audit_logs${whereSql}
             ORDER BY id DESC
             LIMIT $${i++} OFFSET $${i}`,
            listParams
        );

        res.json({
            logs: rows.rows,
            pagination: {
                page: parseInt(page, 10),
                limit: parseInt(limit, 10),
                total,
                totalPages: Math.max(1, Math.ceil(total / parseInt(limit, 10)))
            }
        });
    } catch (e) {
        console.error('Audit logs list error:', e);
        res.status(500).json({ error: 'Failed to load audit logs.' });
    }
});

// GET /api/audit-logs/filters — distinct values for the filter dropdowns
router.get('/filters', async (req, res) => {
    try {
        const [actions, entities, channels] = await Promise.all([
            db.query('SELECT DISTINCT action FROM audit_logs ORDER BY action'),
            db.query('SELECT DISTINCT entity_type FROM audit_logs WHERE entity_type IS NOT NULL ORDER BY entity_type'),
            db.query('SELECT DISTINCT channel FROM audit_logs WHERE channel IS NOT NULL ORDER BY channel')
        ]);
        res.json({
            actions: actions.rows.map(r => r.action),
            entity_types: entities.rows.map(r => r.entity_type),
            channels: channels.rows.map(r => r.channel)
        });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load audit filters.' });
    }
});

// GET /api/audit-logs/:id — full detail incl. old/new values
router.get('/:id', async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) {
        return res.status(400).json({ error: 'Invalid audit log id.' });
    }
    try {
        const r = await db.query('SELECT * FROM audit_logs WHERE id = $1', [req.params.id]);
        if (!r.rows.length) return res.status(404).json({ error: 'Audit log entry not found.' });
        res.json(r.rows[0]);
    } catch (e) {
        res.status(500).json({ error: 'Failed to load audit log entry.' });
    }
});

module.exports = router;
