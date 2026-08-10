// routes/approvals.js — Approval queue API
//
// Approvers (per workflow_settings.approver_roles, plus admin) review staged
// actions here. Approving EXECUTES the staged request against the real tables;
// rejecting discards it. Requesters can cancel their own pending requests.
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { logAudit } = require('../utils/audit');
const { executeApproval } = require('../utils/workflow');

function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    next();
}
router.use(requireAuth);

// Which request types may this user approve?
async function approvableFeatures(role) {
    if (role === 'admin') return null; // null = all
    const result = await db.query('SELECT feature, approver_roles FROM workflow_settings');
    return result.rows
        .filter(r => Array.isArray(r.approver_roles) && r.approver_roles.includes(role))
        .map(r => r.feature);
}

function scopeClause(features, paramIndex) {
    if (features === null) return { clause: '', params: [] }; // admin: no scope
    if (features.length === 0) return { clause: ' AND 1=0', params: [] }; // can approve nothing
    const placeholders = features.map((_, i) => `$${paramIndex + i}`).join(',');
    return { clause: ` AND ar.request_type IN (${placeholders})`, params: features };
}

// GET /api/approvals - pending queue (scoped to what this user may approve)
router.get('/', async (req, res) => {
    try {
        const features = await approvableFeatures(req.user.role);
        const { clause, params } = scopeClause(features, 1);
        const result = await db.query(
            `SELECT ar.id, ar.request_type, ar.title, ar.amount, ar.status,
                    ar.created_at, ar.requested_by,
                    u.fullname AS requested_by_name, u.role AS requested_by_role,
                    ws.display_name AS feature_name
             FROM approval_requests ar
             LEFT JOIN users u ON ar.requested_by = u.id
             LEFT JOIN workflow_settings ws ON ws.feature = ar.request_type
             WHERE ar.status = 'PENDING' ${clause}
             ORDER BY ar.created_at ASC`,
            params
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching approvals:', error);
        res.status(500).json({ error: 'Failed to fetch approvals.', details: error.message });
    }
});

// GET /api/approvals/history - reviewed / cancelled requests
router.get('/history', async (req, res) => {
    try {
        const features = await approvableFeatures(req.user.role);
        const { clause, params } = scopeClause(features, 1);
        const result = await db.query(
            `SELECT ar.id, ar.request_type, ar.title, ar.amount, ar.status, ar.created_at,
                    ar.reviewed_at, ar.executed_at, ar.review_note, ar.execution_result,
                    u.fullname AS requested_by_name, rv.fullname AS reviewed_by_name,
                    ws.display_name AS feature_name
             FROM approval_requests ar
             LEFT JOIN users u ON ar.requested_by = u.id
             LEFT JOIN users rv ON ar.reviewed_by = rv.id
             LEFT JOIN workflow_settings ws ON ws.feature = ar.request_type
             WHERE ar.status != 'PENDING' ${clause}
             ORDER BY ar.reviewed_at DESC NULLS LAST
             LIMIT 200`,
            params
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching approval history:', error);
        res.status(500).json({ error: 'Failed to fetch approval history.', details: error.message });
    }
});

// GET /api/approvals/pending-count - badge count for the sidebar
router.get('/pending-count', async (req, res) => {
    try {
        const features = await approvableFeatures(req.user.role);
        const { clause, params } = scopeClause(features, 1);
        const result = await db.query(
            `SELECT COUNT(*) AS count FROM approval_requests ar WHERE ar.status = 'PENDING' ${clause}`,
            params
        );
        res.status(200).json({ count: parseInt(result.rows[0].count) });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch count.', details: error.message });
    }
});

// GET /api/approvals/:id - full details including staged payload
router.get('/:id', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT ar.*, u.fullname AS requested_by_name, u.role AS requested_by_role,
                    rv.fullname AS reviewed_by_name, ws.display_name AS feature_name
             FROM approval_requests ar
             LEFT JOIN users u ON ar.requested_by = u.id
             LEFT JOIN users rv ON ar.reviewed_by = rv.id
             LEFT JOIN workflow_settings ws ON ws.feature = ar.request_type
             WHERE ar.id = $1`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Approval request not found.' });

        const approval = result.rows[0];
        const features = await approvableFeatures(req.user.role);
        const isRequester = approval.requested_by === req.user.id;
        if (features !== null && !features.includes(approval.request_type) && !isRequester) {
            return res.status(403).json({ error: 'You are not an approver for this type of request.' });
        }
        res.status(200).json(approval);
    } catch (error) {
        console.error('Error fetching approval:', error);
        res.status(500).json({ error: 'Failed to fetch approval.', details: error.message });
    }
});

// POST /api/approvals/:id/approve - approve AND execute the staged action
router.post('/:id/approve', async (req, res) => {
    const { note } = req.body || {};
    try {
        const found = await db.query('SELECT * FROM approval_requests WHERE id = $1', [req.params.id]);
        if (found.rows.length === 0) return res.status(404).json({ error: 'Approval request not found.' });
        const approval = found.rows[0];

        if (approval.status !== 'PENDING') {
            return res.status(409).json({ error: `This request is already ${approval.status}.` });
        }

        const features = await approvableFeatures(req.user.role);
        if (features !== null && !features.includes(approval.request_type)) {
            return res.status(403).json({ error: 'You are not an approver for this type of request.' });
        }
        if (approval.requested_by === req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'You cannot approve your own request.' });
        }

        // Mark approved first (unlocks the internal bypass)
        await db.query(
            `UPDATE approval_requests
             SET status = 'APPROVED', reviewed_by = $1, review_note = $2,
                 reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [req.user.id, note || null, approval.id]
        );

        // Execute the staged action
        let execution = null;
        let executionError = null;
        try {
            execution = await executeApproval({ ...approval, payload: approval.payload });
        } catch (err) {
            executionError = err.message;
        }

        await logAudit({
            user: req.user, action: 'APPROVE', entityType: approval.request_type, entityId: approval.id,
            description: `Approved: ${approval.title}${executionError ? ` (execution failed: ${executionError})` : ''}`,
            newValues: { note, execution, executionError }, req
        });

        if (executionError) {
            return res.status(502).json({
                error: `Approved, but execution failed: ${executionError}`,
                approval_id: approval.id
            });
        }

        res.status(200).json({ message: 'Approved and executed successfully.', approval_id: approval.id, result: execution });
    } catch (error) {
        console.error('Error approving request:', error);
        res.status(500).json({ error: 'Failed to approve request.', details: error.message });
    }
});

// POST /api/approvals/:id/reject - reject the staged action (nothing is executed)
router.post('/:id/reject', async (req, res) => {
    const { note } = req.body || {};
    try {
        const found = await db.query('SELECT * FROM approval_requests WHERE id = $1', [req.params.id]);
        if (found.rows.length === 0) return res.status(404).json({ error: 'Approval request not found.' });
        const approval = found.rows[0];

        if (approval.status !== 'PENDING') {
            return res.status(409).json({ error: `This request is already ${approval.status}.` });
        }

        const features = await approvableFeatures(req.user.role);
        if (features !== null && !features.includes(approval.request_type)) {
            return res.status(403).json({ error: 'You are not an approver for this type of request.' });
        }

        await db.query(
            `UPDATE approval_requests
             SET status = 'REJECTED', reviewed_by = $1, review_note = $2,
                 reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $3`,
            [req.user.id, note || null, approval.id]
        );

        await logAudit({
            user: req.user, action: 'REJECT', entityType: approval.request_type, entityId: approval.id,
            description: `Rejected: ${approval.title}`, newValues: { note }, req
        });

        res.status(200).json({ message: 'Request rejected.', approval_id: approval.id });
    } catch (error) {
        console.error('Error rejecting request:', error);
        res.status(500).json({ error: 'Failed to reject request.', details: error.message });
    }
});

// POST /api/approvals/:id/cancel - requester cancels their own pending request
router.post('/:id/cancel', async (req, res) => {
    try {
        const found = await db.query('SELECT * FROM approval_requests WHERE id = $1', [req.params.id]);
        if (found.rows.length === 0) return res.status(404).json({ error: 'Approval request not found.' });
        const approval = found.rows[0];

        if (approval.requested_by !== req.user.id && req.user.role !== 'admin') {
            return res.status(403).json({ error: 'Only the requester can cancel this request.' });
        }
        if (approval.status !== 'PENDING') {
            return res.status(409).json({ error: `This request is already ${approval.status}.` });
        }

        await db.query(
            `UPDATE approval_requests SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [approval.id]
        );

        await logAudit({
            user: req.user, action: 'CANCEL', entityType: approval.request_type, entityId: approval.id,
            description: `Cancelled: ${approval.title}`, req
        });

        res.status(200).json({ message: 'Request cancelled.', approval_id: approval.id });
    } catch (error) {
        console.error('Error cancelling request:', error);
        res.status(500).json({ error: 'Failed to cancel request.', details: error.message });
    }
});

module.exports = router;
