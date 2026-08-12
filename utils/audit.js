// utils/audit.js — audit logging helper + middleware.
// Records every mutating action (web now, WhatsApp later) into audit_logs.
// NEVER breaks a request: all failures are swallowed after logging to console.
const db = require('../db/db');
const { hasTable } = require('./schemaReady');

const SENSITIVE_KEYS = ['password', 'password_hash', 'token', 'jwt', 'secret', 'api_key', 'apikey', 'authorization'];

function sanitize(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 4) return '[truncated]';
    if (Array.isArray(value)) return value.slice(0, 50).map(v => sanitize(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (SENSITIVE_KEYS.includes(k.toLowerCase())) {
                out[k] = '[redacted]';
            } else if (typeof v === 'string' && v.length > 2000) {
                out[k] = v.slice(0, 2000) + '…[truncated]';
            } else {
                out[k] = sanitize(v, depth + 1);
            }
        }
        return out;
    }
    return value;
}

/**
 * Write one audit row.
 * @param {object} opts
 *  user: req.user (may be null) | {id, username, role}
 *  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | 'APPROVE' | ...
 *  entityType / entityId / description / oldValues / newValues / metadata
 *  channel: 'web' | 'whatsapp' | 'system'
 *  req: optional Express request (for IP)
 */
async function logAudit(opts) {
    try {
        if (!(await hasTable('audit_logs'))) return;
        const {
            user = null, action, entityType = null, entityId = null,
            description = null, oldValues = null, newValues = null,
            metadata = null, channel = 'web', req = null
        } = opts;
        await db.query(
            `INSERT INTO audit_logs
             (user_id, user_name, user_role, channel, action, entity_type, entity_id,
              description, old_values, new_values, metadata, ip_address)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
                user ? user.id : null,
                user ? (user.fullname || user.username || null) : null,
                user ? (user.role || null) : null,
                channel,
                action,
                entityType,
                entityId !== null && entityId !== undefined ? String(entityId) : null,
                description,
                oldValues ? JSON.stringify(sanitize(oldValues)) : null,
                newValues ? JSON.stringify(sanitize(newValues)) : null,
                metadata ? JSON.stringify(sanitize(metadata)) : null,
                req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null) : null
            ]
        );
    } catch (err) {
        console.error('Audit log failed (non-blocking):', err.message);
    }
}

const METHOD_ACTIONS = { POST: 'CREATE', PUT: 'UPDATE', PATCH: 'UPDATE', DELETE: 'DELETE' };

// Middleware: audit every mutating /api call once the response finishes.
// Also captures logins (success + failure) from /api/auth/login.
function auditMiddleware(req, res, next) {
    const method = req.method.toUpperCase();
    const isLogin = req.path === '/auth/login' && method === 'POST';
    const isMutation = !!METHOD_ACTIONS[method];

    if (!isMutation && !isLogin) return next();

    const start = Date.now();
    res.on('finish', () => {
        try {
            const path = req.originalUrl.split('?')[0];
            if (isLogin) {
                const ok = res.statusCode === 200;
                logAudit({
                    user: req.user || null,
                    action: ok ? 'LOGIN' : 'LOGIN_FAILED',
                    entityType: 'auth',
                    description: ok
                        ? `Login successful (${(req.body && req.body.username) || 'unknown'})`
                        : `Login failed (${(req.body && req.body.username) || 'unknown'})`,
                    metadata: { status: res.statusCode },
                    req
                });
                return;
            }
            // Skip noisy internals
            if (path.startsWith('/api/audit-logs')) return;

            const segments = path.replace(/^\/api\//, '').split('/');
            const entityType = segments[0] || 'unknown';
            const entityId = segments[1] && /^\d+$/.test(segments[1]) ? segments[1] : null;
            logAudit({
                user: req.user || null,
                action: METHOD_ACTIONS[method],
                entityType,
                entityId,
                description: `${method} ${path} → ${res.statusCode}`,
                newValues: method !== 'DELETE' ? req.body : null,
                metadata: { status: res.statusCode, duration_ms: Date.now() - start },
                req
            });
        } catch (_) { /* never block */ }
    });
    next();
}

module.exports = { logAudit, auditMiddleware, sanitize };
