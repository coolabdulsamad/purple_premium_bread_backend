// middleware/permissionGuard.js — central permission enforcement.
//
// Maps API paths to permission keys (feature.action from the permissions
// catalog) and checks the caller's role against role_permissions.
//
// SAFETY RULES:
//  - No token / no req.user      → allow (route-level auth handles it as before)
//  - Migration not applied yet   → allow (fail-open, system keeps working)
//  - No rule for the path        → allow
//  - admin role                  → always allowed
//
const db = require('../db/db');
const { hasTable } = require('../utils/schemaReady');

// Order matters — first match wins.
const PERMISSION_RULES = [
    // Special cases that must stay open for every authenticated user
    { pattern: /^\/users\/me(\/|$)/, allow: true },
    { pattern: /^\/auth(\/|$)/, allow: true },
    { pattern: /^\/company(\/|$)/, methods: ['GET'], allow: true },
    { pattern: /^\/company(\/|$)/, feature: 'settings' },

    // Feature mappings
    { pattern: /^\/sales(\/|$)/, feature: 'sales' },
    { pattern: /^\/exchange(\/|$)/, feature: 'exchanges' },
    { pattern: /^\/manager\/exchange\/approve(\/|$)/, permission: 'exchanges.approve' },
    { pattern: /^\/manager(\/|$)/, feature: 'approvals' },
    { pattern: /^\/products(\/|$)/, feature: 'products' },
    { pattern: /^\/categories(\/|$)/, feature: 'categories' },
    { pattern: /^\/inventory(\/|$)/, feature: 'inventory' },
    { pattern: /^\/production(\/|$)/, feature: 'production' },
    { pattern: /^\/raw-materials(\/|$)/, feature: 'raw_materials' },
    { pattern: /^\/material-transactions(\/|$)/, feature: 'raw_materials' },
    { pattern: /^\/recipes(\/|$)/, feature: 'recipes' },
    { pattern: /^\/customers(\/|$)/, feature: 'customers' },
    { pattern: /^\/riders(\/|$)/, feature: 'riders' },
    { pattern: /^\/payments(\/|$)/, feature: 'payments' },
    { pattern: /^\/salaries\/company-debts(\/|$)/, feature: 'debts' },
    { pattern: /^\/salaries(\/|$)/, feature: 'salaries' },
    { pattern: /^\/staffs(\/|$)/, feature: 'staff' },
    { pattern: /^\/staff(\/|$)/, feature: 'staff' },
    { pattern: /^\/operating-expenses(\/|$)/, feature: 'expenses' },
    { pattern: /^\/reports(\/|$)/, feature: 'reports' },
    { pattern: /^\/analysis(\/|$)/, feature: 'analysis' },
    { pattern: /^\/users(\/|$)/, feature: 'users' },
    { pattern: /^\/branches(\/|$)/, feature: 'branches' },
    { pattern: /^\/services(\/|$)/, feature: 'services' },
    { pattern: /^\/drivers(\/|$)/, feature: 'branches' },
    { pattern: /^\/approvals(\/|$)/, feature: 'approvals' },
    { pattern: /^\/permissions(\/|$)/, feature: 'settings' },
    { pattern: /^\/settings(\/|$)/, feature: 'settings' },
    { pattern: /^\/audit-logs(\/|$)/, feature: 'audit_logs' },
    { pattern: /^\/money(\/|$)/, feature: 'money' },
    { pattern: /^\/wallets(\/|$)/, feature: 'wallets' },
    { pattern: /^\/returns(\/|$)/, feature: 'returns' },
    { pattern: /^\/chat(\/|$)/, feature: 'chat' },
    { pattern: /^\/ai(\/|$)/, feature: 'ai_assistant' },
    { pattern: /^\/dashboard(\/|$)/, feature: 'dashboard' },
    { pattern: /^\/alerts(\/|$)/, feature: 'inventory' },
    { pattern: /^\/waste-stock(\/|$)/, feature: 'inventory' },
    { pattern: /^\/stock-issue-log(\/|$)/, feature: 'inventory' },
];

const METHOD_ACTIONS = { GET: 'view', POST: 'create', PUT: 'edit', PATCH: 'edit', DELETE: 'delete' };

// role -> Set(permission_key with is_allowed=true), cached 60s
let permCache = { loadedAt: 0, map: new Map() };
const CACHE_TTL_MS = 60 * 1000;

async function loadPermissions() {
    if (Date.now() - permCache.loadedAt < CACHE_TTL_MS) return permCache.map;
    const result = await db.query('SELECT role, permission_key, is_allowed FROM role_permissions');
    const map = new Map();
    for (const row of result.rows) {
        if (!map.has(row.role)) map.set(row.role, new Map());
        map.get(row.role).set(row.permission_key, row.is_allowed);
    }
    permCache = { loadedAt: Date.now(), map };
    return map;
}

function invalidatePermissionCache() {
    permCache.loadedAt = 0;
}

/**
 * Direct permission check usable anywhere (routes, WhatsApp flows, etc.)
 */
async function checkPermission(role, permissionKey) {
    if (!role) return true;               // unauthenticated → existing behavior decides
    if (role === 'admin') return true;    // admin always allowed
    if (!(await hasTable('role_permissions'))) return true;
    const map = await loadPermissions();
    const rolePerms = map.get(role);
    if (!rolePerms) return true;          // role not configured → allow (legacy behavior)
    if (!rolePerms.has(permissionKey)) return true; // key not granted explicitly → allow (legacy)
    return rolePerms.get(permissionKey) === true;
}

function permissionGuard(req, res, next) {
    (async () => {
        if (!req.user || !req.user.role) return next(); // no token → unchanged behavior
        if (req.user.role === 'admin') return next();

        const path = req.path; // mounted at /api, so path excludes /api
        const rule = PERMISSION_RULES.find(r =>
            r.pattern.test(path) && (!r.methods || r.methods.includes(req.method))
        );
        if (!rule || rule.allow) return next();

        const permissionKey = rule.permission || `${rule.feature}.${METHOD_ACTIONS[req.method] || 'view'}`;
        const allowed = await checkPermission(req.user.role, permissionKey);
        if (!allowed) {
            return res.status(403).json({
                error: 'You do not have permission to perform this action.',
                required_permission: permissionKey
            });
        }
        next();
    })().catch(err => {
        console.error('Permission guard error (allowing request):', err.message);
        next(); // fail-open: never break the business on a guard error
    });
}

module.exports = { permissionGuard, checkPermission, invalidatePermissionCache, PERMISSION_RULES };
