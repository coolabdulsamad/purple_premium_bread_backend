// routes/permissions.js — Permissions & workflow configuration API (admin only)
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { logAudit } = require('../utils/audit');
const { invalidatePermissionCache } = require('../middleware/permissionGuard');
const { invalidateWorkflowCache } = require('../utils/workflow');

const KNOWN_ROLES = ['admin', 'manager', 'sales', 'baker', 'accountant'];

// Inline admin guard (this router manages the permission system itself)
function adminOnly(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only administrators can manage permissions.' });
    next();
}

router.use(adminOnly);

// GET /api/permissions/roles - list of roles
router.get('/roles', (req, res) => {
    res.status(200).json(KNOWN_ROLES);
});

// GET /api/permissions/catalog - full catalog grouped by feature, with grants per role
router.get('/catalog', async (req, res) => {
    try {
        const [perms, grants] = await Promise.all([
            db.query('SELECT * FROM permissions ORDER BY feature, action'),
            db.query('SELECT role, permission_key, is_allowed FROM role_permissions')
        ]);

        const grantMap = {}; // permission_key -> { role: is_allowed }
        for (const g of grants.rows) {
            if (!grantMap[g.permission_key]) grantMap[g.permission_key] = {};
            grantMap[g.permission_key][g.role] = g.is_allowed;
        }

        const features = {};
        for (const p of perms.rows) {
            if (!features[p.feature]) features[p.feature] = [];
            features[p.feature].push({
                permission_key: p.permission_key,
                action: p.action,
                description: p.description,
                grants: grantMap[p.permission_key] || {}
            });
        }

        res.status(200).json({ roles: KNOWN_ROLES, features });
    } catch (error) {
        console.error('Error fetching permission catalog:', error);
        res.status(500).json({ error: 'Failed to fetch permission catalog.', details: error.message });
    }
});

// PUT /api/permissions/role/:role - bulk update grants for a role
// body: { grants: [{ permission_key, is_allowed }] }
router.put('/role/:role', async (req, res) => {
    const { role } = req.params;
    const { grants } = req.body;

    if (!KNOWN_ROLES.includes(role)) {
        return res.status(400).json({ error: `Unknown role '${role}'.` });
    }
    if (!Array.isArray(grants)) {
        return res.status(400).json({ error: 'grants must be an array of { permission_key, is_allowed }.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');
        for (const g of grants) {
            await client.query(
                `INSERT INTO role_permissions (role, permission_key, is_allowed, updated_by, updated_at)
                 VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
                 ON CONFLICT (role, permission_key)
                 DO UPDATE SET is_allowed = EXCLUDED.is_allowed,
                               updated_by = EXCLUDED.updated_by,
                               updated_at = CURRENT_TIMESTAMP`,
                [role, g.permission_key, !!g.is_allowed, req.user.id]
            );
        }
        await client.query('COMMIT');
        invalidatePermissionCache();

        await logAudit({
            user: req.user, action: 'UPDATE', entityType: 'role_permissions', entityId: role,
            description: `Updated ${grants.length} permission(s) for role '${role}'`,
            newValues: { role, grants }, req
        });

        res.status(200).json({ message: `Permissions updated for role '${role}'.`, updated: grants.length });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating role permissions:', error);
        res.status(500).json({ error: 'Failed to update permissions.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/permissions/workflow - all workflow settings
router.get('/workflow', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT w.*, u.fullname AS updated_by_name
            FROM workflow_settings w
            LEFT JOIN users u ON w.updated_by = u.id
            ORDER BY w.feature
        `);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching workflow settings:', error);
        res.status(500).json({ error: 'Failed to fetch workflow settings.', details: error.message });
    }
});

// PUT /api/permissions/workflow/:feature - update a workflow setting
// body: { requires_approval, approval_threshold, approver_roles, is_enabled }
router.put('/workflow/:feature', async (req, res) => {
    const { feature } = req.params;
    const { requires_approval, approval_threshold, approver_roles, is_enabled } = req.body;

    try {
        const existing = await db.query('SELECT * FROM workflow_settings WHERE feature = $1', [feature]);
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: `Unknown workflow feature '${feature}'.` });
        }

        const result = await db.query(
            `UPDATE workflow_settings
             SET requires_approval = COALESCE($1, requires_approval),
                 approval_threshold = COALESCE($2, approval_threshold),
                 approver_roles = COALESCE($3, approver_roles),
                 is_enabled = COALESCE($4, is_enabled),
                 updated_by = $5,
                 updated_at = CURRENT_TIMESTAMP
             WHERE feature = $6
             RETURNING *`,
            [
                typeof requires_approval === 'boolean' ? requires_approval : null,
                approval_threshold !== undefined ? parseFloat(approval_threshold) : null,
                Array.isArray(approver_roles) ? JSON.stringify(approver_roles) : null,
                typeof is_enabled === 'boolean' ? is_enabled : null,
                req.user.id,
                feature
            ]
        );
        invalidateWorkflowCache();

        await logAudit({
            user: req.user, action: 'UPDATE', entityType: 'workflow_settings', entityId: feature,
            description: `Updated workflow '${feature}'`,
            oldValues: existing.rows[0], newValues: result.rows[0], req
        });

        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating workflow setting:', error);
        res.status(500).json({ error: 'Failed to update workflow setting.', details: error.message });
    }
});

module.exports = router;
