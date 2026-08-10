// utils/workflow.js — approval workflow engine.
//
// workflowGate middleware intercepts configured mutating endpoints:
//   • If the feature's workflow setting has requires_approval = false → request passes through.
//   • If approval is required → the request is STAGED into approval_requests and the
//     client receives HTTP 202 { pending_approval: true }. Nothing is written to the
//     business tables until an approver approves it from the Approvals page.
//   • On approval, executeApproval() replays the staged request internally with a
//     short-lived token for the original user plus an x-approval-id bypass header.
//
// Fail-open design: if workflow tables don't exist yet, every request passes through.
const jwt = require('jsonwebtoken');
const db = require('../db/db');
const config = require('../config');
const { hasTable } = require('./schemaReady');
const { logAudit } = require('./audit');

// ----------------------------------------------------------------------------
// Workflow route map. amount extractors are best-effort (used for thresholds).
// ----------------------------------------------------------------------------
const n = v => {
    const num = parseFloat(v);
    return Number.isFinite(num) ? num : null;
};

const itemsTotal = body => {
    if (!body) return null;
    if (n(body.total_amount) !== null) return n(body.total_amount);
    if (n(body.total) !== null) return n(body.total);
    const items = body.items || body.cart;
    if (Array.isArray(items) && items.length) {
        const sum = items.reduce((s, i) => {
            const price = n(i.price) ?? n(i.unit_price) ?? n(i.price_at_sale) ?? n(i.final_price) ?? 0;
            const qty = n(i.quantity) ?? 0;
            return s + price * qty;
        }, 0);
        return sum > 0 ? sum : null;
    }
    return null;
};

const WORKFLOW_ROUTES = [
    {
        method: 'POST', pattern: /^\/sales\/process\/?$/, feature: 'sales',
        amount: req => itemsTotal(req.body),
        title: req => `New sale${req.body?.items ? ` (${req.body.items.length} item${req.body.items.length > 1 ? 's' : ''})` : ''}`
    },
    {
        method: 'POST', pattern: /^\/sales\/b2b\/?$/, feature: 'sales',
        amount: req => itemsTotal(req.body),
        title: () => 'Branch (B2B) transfer sale'
    },
    {
        method: 'POST', pattern: /^\/production\/log\/?$/, feature: 'production_log',
        amount: () => null,
        title: req => `Production log — product #${req.body?.product_id || '?'} × ${req.body?.quantity_produced || '?'}`
    },
    {
        method: 'POST', pattern: /^\/material-transactions(\/|$)/, feature: 'raw_material_restock',
        amount: req => n(req.body?.total_cost) ?? ((n(req.body?.quantity) ?? 0) * (n(req.body?.unit_cost) ?? 0) || null),
        title: req => `Raw material restock — material #${req.body?.raw_material_id || '?'}`
    },
    {
        method: 'POST', pattern: /^\/inventory\/manage-user-stock\/?$/, feature: 'stock_issue',
        amount: () => null,
        title: req => `Stock ${req.body?.action || 'issue/return'} — product #${req.body?.product_id || '?'} × ${req.body?.quantity || '?'}`
    },
    {
        method: 'POST', pattern: /^\/payments(\/|$)/, feature: 'payment',
        amount: req => n(req.body?.amount),
        title: req => `Payment received — ₦${(n(req.body?.amount) ?? 0).toLocaleString()}`
    },
    {
        method: 'POST', pattern: /^\/operating-expenses\/?$/, feature: 'expense',
        amount: req => n(req.body?.amount),
        title: req => `Expense — ${req.body?.expense_type || 'expense'} (₦${(n(req.body?.amount) ?? 0).toLocaleString()})`
    },
    {
        method: 'POST', pattern: /^\/salaries\/(pay|payments)(\/|$)/, feature: 'salary_payment',
        amount: req => n(req.body?.net_amount) ?? n(req.body?.amount),
        title: req => `Salary payment — staff #${req.body?.staff_id || req.body?.user_id || '?'}`
    },
    {
        method: 'POST', pattern: /^\/salaries\/.*loan/, feature: 'staff_loan',
        amount: req => n(req.body?.amount),
        title: req => `Staff loan — ₦${(n(req.body?.amount) ?? 0).toLocaleString()}`
    },
    {
        method: 'POST', pattern: /^\/returns\/?$/, feature: 'return',
        amount: req => n(req.body?.total_amount),
        title: req => `Sales return — sale #${req.body?.sale_id || '?'}`
    },
    {
        method: 'POST', pattern: /^\/wallets\/deposit\/?$/, feature: 'wallet_deposit',
        amount: req => n(req.body?.amount),
        title: req => `Advance deposit — ₦${(n(req.body?.amount) ?? 0).toLocaleString()}`
    },
    {
        method: 'POST', pattern: /^\/wallets\/refund\/?$/, feature: 'wallet_refund',
        amount: req => n(req.body?.amount),
        title: req => `Wallet refund — ₦${(n(req.body?.amount) ?? 0).toLocaleString()}`
    },
    {
        method: 'POST', pattern: /^\/money\/transactions\/?$/, feature: 'money_transaction',
        amount: req => n(req.body?.amount),
        title: req => `Money ${req.body?.direction === 'OUT' ? 'out' : 'in'} — ₦${(n(req.body?.amount) ?? 0).toLocaleString()}`
    },
];

// ----------------------------------------------------------------------------
// Settings cache
// ----------------------------------------------------------------------------
let settingsCache = { loadedAt: 0, map: new Map() };
const SETTINGS_TTL_MS = 60 * 1000;

async function getWorkflowSettings() {
    if (Date.now() - settingsCache.loadedAt < SETTINGS_TTL_MS) return settingsCache.map;
    const result = await db.query('SELECT * FROM workflow_settings');
    const map = new Map(result.rows.map(r => [r.feature, r]));
    settingsCache = { loadedAt: Date.now(), map };
    return map;
}

function invalidateWorkflowCache() {
    settingsCache.loadedAt = 0;
}

async function getWorkflowSetting(feature) {
    if (!(await hasTable('workflow_settings'))) return null;
    const map = await getWorkflowSettings();
    return map.get(feature) || null;
}

// ----------------------------------------------------------------------------
// Validate an approval-bypass header. Returns the approval row when valid.
// ----------------------------------------------------------------------------
async function validateBypass(approvalId, feature) {
    if (!approvalId) return null;
    try {
        const result = await db.query(
            `SELECT * FROM approval_requests
             WHERE id = $1 AND request_type = $2 AND status = 'APPROVED' AND executed_at IS NULL`,
            [approvalId, feature]
        );
        return result.rows[0] || null;
    } catch (_) {
        return null;
    }
}

// ----------------------------------------------------------------------------
// The gate middleware
// ----------------------------------------------------------------------------
function workflowGate(req, res, next) {
    (async () => {
        const route = WORKFLOW_ROUTES.find(r => r.method === req.method && r.pattern.test(req.path));
        if (!route) return next();

        if (!(await hasTable('approval_requests'))) return next(); // migration not applied

        // Approval replay bypass — an approved staged request being executed
        const bypass = await validateBypass(req.headers['x-approval-id'], route.feature);
        if (bypass) {
            req.approvalBypassId = bypass.id;
            return next();
        }

        const setting = await getWorkflowSetting(route.feature);
        if (!setting || !setting.is_enabled || !setting.requires_approval) return next();

        const amount = route.amount(req);
        const threshold = parseFloat(setting.approval_threshold || 0);
        if (threshold > 0 && (amount === null || amount < threshold)) return next();

        // Stage the request for approval
        const payload = {
            method: req.method,
            url: req.originalUrl.split('?')[0],
            body: req.body,
            user_id: req.user ? req.user.id : null,
            username: req.user ? req.user.username : null,
            role: req.user ? req.user.role : null
        };
        const title = route.title(req);
        const insert = await db.query(
            `INSERT INTO approval_requests (request_type, title, payload, amount, requested_by)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [route.feature, title, JSON.stringify(payload), amount, req.user ? req.user.id : null]
        );

        await logAudit({
            user: req.user, action: 'SUBMIT_FOR_APPROVAL',
            entityType: route.feature, entityId: insert.rows[0].id,
            description: `Staged for approval: ${title}`,
            newValues: payload, req
        });

        return res.status(202).json({
            pending_approval: true,
            approval_id: insert.rows[0].id,
            message: `This ${setting.display_name || route.feature} requires approval. It has been sent to the approvers and will take effect once approved.`
        });
    })().catch(err => {
        console.error('Workflow gate error (allowing request):', err.message);
        next(); // fail-open
    });
}

// ----------------------------------------------------------------------------
// Execute an approved request by replaying it internally
// ----------------------------------------------------------------------------
async function executeApproval(approval) {
    const payload = typeof approval.payload === 'string' ? JSON.parse(approval.payload) : approval.payload;

    // Load the original user to mint a short-lived internal token
    const userResult = await db.query('SELECT id, username, role FROM users WHERE id = $1', [payload.user_id]);
    if (userResult.rows.length === 0) {
        throw new Error('Original requesting user no longer exists.');
    }
    const u = userResult.rows[0];
    const internalToken = jwt.sign({ id: u.id, username: u.username, role: u.role }, config.JWT_SECRET, { expiresIn: '5m' });

    const port = config.PORT;
    const response = await fetch(`http://127.0.0.1:${port}${payload.url}`, {
        method: payload.method,
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${internalToken}`,
            'x-approval-id': String(approval.id)
        },
        body: JSON.stringify(payload.body || {})
    });

    let body = null;
    try { body = await response.json(); } catch (_) { body = null; }

    if (!response.ok) {
        await db.query(
            `UPDATE approval_requests SET execution_result = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`,
            [JSON.stringify({ ok: false, status: response.status, response: body }), approval.id]
        );
        throw new Error(`Execution failed (HTTP ${response.status}): ${body && body.error ? body.error : 'unknown error'}`);
    }

    await db.query(
        `UPDATE approval_requests
         SET executed_at = CURRENT_TIMESTAMP, execution_result = $1, updated_at = CURRENT_TIMESTAMP
         WHERE id = $2`,
        [JSON.stringify({ ok: true, status: response.status, response: body }), approval.id]
    );

    return body;
}

module.exports = {
    workflowGate,
    executeApproval,
    getWorkflowSetting,
    invalidateWorkflowCache,
    WORKFLOW_ROUTES
};
