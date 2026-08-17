// utils/workflow.js — approval workflow engine.
//
// workflowGate middleware intercepts configured mutating endpoints:
//   • If the feature's workflow setting has requires_approval = false → request passes through.
//   • If approval is required but the CREATOR's role is itself an approver for that
//     feature (admins approve everything) → AUTO-APPROVED: the request executes
//     immediately and an audit entry is written. Nothing is staged.
//   • Otherwise the request is STAGED into approval_requests and the client receives
//     HTTP 202 { pending_approval: true }. Nothing is written to the business tables
//     until an approver approves it from the Approvals page.
//   • On approval, executeApproval() replays the staged request internally with a
//     short-lived token for the original user plus an x-approval-id bypass header.
//
// Staged payloads carry a `display` object (fields / items / total) alongside the
// replay `body`. `display` is enrichment only — names, phones, line values — and is
// NEVER replayed; executeApproval replays `payload.body` verbatim.
//
// Fail-open design: if workflow tables don't exist yet, every request passes through,
// and enrichment lookups never throw (failures fall back to id-based labels).
const jwt = require('jsonwebtoken');
const db = require('../db/db');
const config = require('../config');
const { hasTable } = require('./schemaReady');
const { logAudit } = require('./audit');

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------
const n = v => {
    const num = parseFloat(v);
    return Number.isFinite(num) ? num : null;
};

const fmtMoney = v => {
    const num = n(v);
    return num === null ? '—' : `₦${num.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
};

const itemsTotal = body => {
    if (!body) return null;
    if (n(body.total_amount) !== null) return n(body.total_amount);
    if (n(body.total) !== null) return n(body.total);
    const items = body.items || body.cart;
    if (Array.isArray(items) && items.length) {
        const sum = items.reduce((s, i) => {
            const price = n(i.price) ?? n(i.unit_price) ?? n(i.price_at_sale) ?? n(i.final_price) ?? n(i.finalPrice) ?? 0;
            const qty = n(i.quantity) ?? 0;
            return s + price * qty;
        }, 0);
        return sum > 0 ? sum : null;
    }
    return null;
};

// ----------------------------------------------------------------------------
// Enrichment lookups — best-effort, NEVER throw. On any failure the gate must
// still work, so every query is wrapped and falls back to id-based labels.
// ----------------------------------------------------------------------------
async function safeQuery(text, params) {
    try { return await db.query(text, params); } catch (_) { return { rows: [] }; }
}
const row1 = r => (r && r.rows && r.rows[0]) || null;

// ids -> Map(id -> {id, name, price})
async function productMap(ids) {
    const uniq = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
    if (!uniq.length) return new Map();
    const r = await safeQuery('SELECT id, name, price FROM products WHERE id = ANY($1)', [uniq]);
    return new Map(r.rows.map(p => [p.id, p]));
}

async function userInfo(id) {
    if (!id) return null;
    return row1(await safeQuery('SELECT id, fullname, username, role FROM users WHERE id = $1', [id]));
}

// table is 'riders' or 'customers' (internal constant only — never user input)
async function ownerDetails(table, id) {
    if (!id) return null;
    const o = row1(await safeQuery(`SELECT * FROM ${table} WHERE id = $1`, [id]));
    if (!o) return null;
    return {
        id: o.id,
        name: o.fullname || o.name || `#${id}`,
        phone: o.phone_number || o.phone || null,
        balance: n(o.current_balance ?? o.balance),
        advance_balance: n(o.advance_balance)
    };
}

// ----------------------------------------------------------------------------
// Workflow route map. Each route resolves { title, amount, display } where
// `display` = { fields: [{label, value}], items?: [row objects], total?: {label, value} }
// rendered by the Approvals page. Amount is best-effort (used for thresholds).
// ----------------------------------------------------------------------------
const WORKFLOW_ROUTES = [
    {
        method: 'POST', pattern: /^\/sales\/process\/?$/, feature: 'sales',
        details: async req => {
            const body = req.body || {};
            const cart = Array.isArray(body.cart) ? body.cart : (Array.isArray(body.items) ? body.items : []);
            const pmap = await productMap(cart.map(i => i.id ?? i.product_id));
            const items = cart.map(i => {
                const pid = Number(i.id ?? i.product_id);
                const qty = n(i.quantity) ?? 0;
                const price = n(i.finalPrice ?? i.price) ?? 0;
                return {
                    Product: pmap.get(pid)?.name || i.name || `Product #${pid || '?'}`,
                    Quantity: qty,
                    'Unit price': fmtMoney(price),
                    Total: fmtMoney(price * qty)
                };
            });
            const customer = body.customerId ? await ownerDetails('customers', body.customerId) : null;
            const rider = body.riderId ? await ownerDetails('riders', body.riderId) : null;
            const owner = rider || customer;
            const total = itemsTotal(body);
            const who = rider ? `Rider ${rider.name}` : (customer ? customer.name : 'Walk-in customer');
            return {
                title: `Sale — ${who} · ${fmtMoney(total)}`,
                amount: total,
                display: {
                    fields: [
                        { label: rider ? 'Rider' : 'Customer', value: owner?.name || 'Walk-in customer' },
                        ...(owner?.phone ? [{ label: 'Phone', value: owner.phone }] : []),
                        { label: 'Payment method', value: body.paymentMethod || '—' },
                        { label: 'Total', value: fmtMoney(total) },
                        { label: 'Amount paid', value: fmtMoney(body.amountPaid ?? total) },
                        { label: 'Balance due', value: fmtMoney(body.balanceDue ?? 0) },
                        ...(body.note ? [{ label: 'Note', value: String(body.note) }] : [])
                    ],
                    items,
                    total: { label: 'Sale total', value: fmtMoney(total) }
                }
            };
        }
    },
    {
        method: 'POST', pattern: /^\/sales\/b2b\/?$/, feature: 'sales',
        details: async req => {
            const body = req.body || {};
            const arr = Array.isArray(body.items) ? body.items : [];
            const pmap = await productMap(arr.map(i => i.id ?? i.product_id));
            const items = arr.map(i => {
                const pid = Number(i.id ?? i.product_id);
                const qty = n(i.quantity) ?? 0;
                const price = n(i.price) ?? 0;
                return { Product: pmap.get(pid)?.name || `Product #${pid || '?'}`, Quantity: qty, 'Unit price': fmtMoney(price), Total: fmtMoney(price * qty) };
            });
            const total = itemsTotal(body);
            const branch = body.branchId ? row1(await safeQuery('SELECT name FROM branches WHERE id = $1', [body.branchId])) : null;
            return {
                title: `Branch (B2B) transfer — ${branch?.name || (body.branchId ? `branch #${body.branchId}` : 'branch')} · ${fmtMoney(total)}`,
                amount: total,
                display: {
                    fields: [
                        { label: 'Branch', value: branch?.name || (body.branchId ? `branch #${body.branchId}` : '—') },
                        { label: 'Driver', value: body.driverName || '—' },
                        { label: 'Driver phone', value: body.driverPhoneNumber || '—' },
                        ...(body.note ? [{ label: 'Note', value: String(body.note) }] : [])
                    ],
                    items,
                    total: { label: 'Transfer value', value: fmtMoney(total) }
                }
            };
        }
    },
    {
        method: 'POST', pattern: /^\/production\/log\/?$/, feature: 'production_log',
        details: async req => {
            const body = req.body || {};
            const shift = body.shift || null;
            const arr = Array.isArray(body.productionData) ? body.productionData
                : (body.product_id ? [{ productId: body.product_id, quantityProduced: body.quantity_produced, wasteQuantity: body.waste_quantity }] : []);
            const pmap = await productMap(arr.map(i => i.productId ?? i.product_id));
            let totalValue = 0, anyPrice = false, totalQty = 0, totalWaste = 0;
            const items = arr.map(i => {
                const pid = Number(i.productId ?? i.product_id);
                const qty = n(i.quantityProduced ?? i.quantity_produced) ?? 0;
                const waste = n(i.wasteQuantity ?? i.waste_quantity) ?? 0;
                const p = pmap.get(pid);
                const price = n(p?.price);
                const value = price !== null ? price * qty : null;
                if (value !== null) { totalValue += value; anyPrice = true; }
                totalQty += qty; totalWaste += waste;
                return {
                    Product: p?.name || `Product #${pid || '?'}`,
                    'Qty produced': qty,
                    Waste: waste,
                    'Unit price': price !== null ? fmtMoney(price) : '—',
                    'Line value': value !== null ? fmtMoney(value) : '—'
                };
            });
            const names = items.map(it => `${it.Product} ×${it['Qty produced']}`);
            const titleCore = names.length
                ? names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3} more` : '')
                : 'no items';
            return {
                title: `Production log — ${titleCore}${shift ? ` (${shift})` : ''}`,
                amount: anyPrice ? totalValue : null,
                display: {
                    fields: [
                        { label: 'Shift', value: shift || '—' },
                        { label: 'Products logged', value: String(items.length) },
                        { label: 'Total produced', value: String(totalQty) },
                        { label: 'Total waste', value: String(totalWaste) }
                    ],
                    items,
                    total: anyPrice ? { label: 'Estimated production value', value: fmtMoney(totalValue) } : null
                }
            };
        }
    },
    {
        method: 'POST', pattern: /^\/material-transactions(\/|$)/, feature: 'raw_material_restock',
        details: async req => {
            const body = req.body || {};
            const mid = body.raw_material_id;
            const mat = mid ? row1(await safeQuery('SELECT id, name, unit FROM raw_materials WHERE id = $1', [mid])) : null;
            const qty = n(body.quantity_added ?? body.quantity);
            const unitCost = n(body.unit_cost);
            const total = n(body.total_cost) ?? (qty !== null && unitCost !== null ? qty * unitCost : null);
            return {
                title: `Raw material restock — ${mat?.name || `material #${mid || '?'}`} × ${qty ?? '?'}${mat?.unit ? ` ${mat.unit}` : ''}`,
                amount: total,
                display: {
                    fields: [
                        { label: 'Material', value: mat?.name || `#${mid || '?'}` },
                        { label: 'Quantity added', value: `${qty ?? '—'}${mat?.unit ? ` ${mat.unit}` : ''}` },
                        { label: 'Unit cost', value: fmtMoney(unitCost) },
                        { label: 'Total cost', value: fmtMoney(total) },
                        ...(body.notes ? [{ label: 'Notes', value: String(body.notes) }] : [])
                    ]
                }
            };
        }
    },
    {
        method: 'POST', pattern: /^\/inventory\/manage-user-stock\/?$/, feature: 'stock_issue',
        details: async req => {
            const body = req.body || {};
            const type = String(body.type || body.action || 'ISSUE').toUpperCase();
            const entries = body.products && typeof body.products === 'object' && !Array.isArray(body.products)
                ? Object.entries(body.products).map(([pid, qty]) => ({ productId: Number(pid), quantity: n(qty) ?? 0 }))
                : (Array.isArray(body.products) ? body.products
                    : (body.product_id ? [{ productId: body.product_id, quantity: body.quantity }] : []));
            const pmap = await productMap(entries.map(e => e.productId ?? e.product_id));
            const user = await userInfo(body.userId ?? body.user_id);
            const admin = await userInfo(body.adminId ?? body.admin_id);
            let totalValue = 0, anyPrice = false;
            const items = entries.filter(e => (e.quantity ?? 0) > 0).map(e => {
                const pid = Number(e.productId ?? e.product_id);
                const qty = n(e.quantity) ?? 0;
                const p = pmap.get(pid);
                const price = n(p?.price);
                if (price !== null) { totalValue += price * qty; anyPrice = true; }
                return { Product: p?.name || `Product #${pid || '?'}`, Quantity: qty, Value: price !== null ? fmtMoney(price * qty) : '—' };
            });
            return {
                title: `Stock ${type.toLowerCase()} — ${user?.fullname || `user #${body.userId ?? body.user_id ?? '?'}`} · ${items.length} product${items.length === 1 ? '' : 's'}`,
                amount: anyPrice ? totalValue : null,
                display: {
                    fields: [
                        { label: 'Operation', value: type === 'ISSUE' ? 'Issue stock to staff' : 'Return stock from staff' },
                        { label: 'Staff', value: user?.fullname || '—' },
                        ...(admin ? [{ label: 'Recorded by (admin)', value: admin.fullname }] : [])
                    ],
                    items,
                    total: anyPrice ? { label: 'Stock value', value: fmtMoney(totalValue) } : null
                }
            };
        }
    },
    {
        method: 'POST', pattern: /^\/payments(\/|$)/, feature: 'payment',
        details: async req => {
            const body = req.body || {};
            const rider = body.rider_id ? await ownerDetails('riders', body.rider_id) : null;
            const customer = !rider && body.customer_id ? await ownerDetails('customers', body.customer_id) : null;
            const owner = rider || customer;
            const amount = n(body.amount);
            return {
                title: `Payment received — ${owner ? owner.name : 'unknown payer'} · ${fmtMoney(amount)}`,
                amount,
                display: {
                    fields: [
                        { label: 'Payer type', value: rider ? 'Rider' : (customer ? 'Customer' : '—') },
                        { label: rider ? 'Rider' : 'Customer', value: owner?.name || '—' },
                        ...(owner?.phone ? [{ label: 'Phone', value: owner.phone }] : []),
                        ...(owner && owner.balance !== null ? [{ label: rider ? 'Outstanding balance' : 'Balance', value: fmtMoney(owner.balance) }] : []),
                        { label: 'Amount', value: fmtMoney(amount) },
                        { label: 'Method', value: body.payment_method || '—' },
                        ...(body.payment_date ? [{ label: 'Payment date', value: String(body.payment_date) }] : []),
                        ...(body.proof ? [{ label: 'Proof / reference', value: String(body.proof) }] : []),
                        ...(body.notes ? [{ label: 'Notes', value: String(body.notes) }] : []),
                        ...(body.transaction_id ? [{ label: 'Transaction', value: `#${body.transaction_id}` }] : [])
                    ]
                }
            };
        }
    },
    {
        method: 'POST', pattern: /^\/operating-expenses\/?$/, feature: 'expense',
        details: async req => {
            const body = req.body || {};
            const amount = n(body.amount);
            return {
                title: `Expense — ${body.expense_type || 'expense'} (${fmtMoney(amount)})`,
                amount,
                display: {
                    fields: [
                        { label: 'Expense type', value: body.expense_type || '—' },
                        { label: 'Category', value: body.category || '—' },
                        { label: 'Amount', value: fmtMoney(amount) },
                        { label: 'Payment method', value: body.payment_method || '—' },
                        ...(body.reference_number ? [{ label: 'Reference', value: String(body.reference_number) }] : []),
                        ...(body.description ? [{ label: 'Description', value: String(body.description) }] : []),
                        ...(body.expense_date ? [{ label: 'Date', value: String(body.expense_date) }] : [])
                    ]
                }
            };
        }
    },
    {
        method: 'POST', pattern: /^\/salaries\/(pay|payments)(\/|$)/, feature: 'salary_payment',
        details: async req => {
            const body = req.body || {};
            const staff = await userInfo(body.user_id ?? body.staff_id);
            const net = n(body.net_amount) ?? n(body.amount);
            return {
                title: `Salary payment — ${staff?.fullname || `staff #${body.user_id ?? body.staff_id ?? '?'}`} · ${fmtMoney(net)}`,
                amount: net,
                display: {
                    fields: [
                        { label: 'Staff', value: staff?.fullname || '—' },
                        ...(staff?.role ? [{ label: 'Role', value: staff.role }] : []),
                        { label: 'Base salary', value: fmtMoney(body.base_salary) },
                        ...(n(body.loan_deduction) ? [{ label: 'Loan deduction', value: fmtMoney(body.loan_deduction) }] : []),
                        ...(n(body.credit_sales_deduction) ? [{ label: 'Credit sales deduction', value: fmtMoney(body.credit_sales_deduction) }] : []),
                        { label: 'Net paid', value: fmtMoney(net) },
                        { label: 'Method', value: body.payment_method || '—' },
                        ...(body.payment_reference ? [{ label: 'Reference', value: String(body.payment_reference) }] : []),
                        ...(body.payment_date ? [{ label: 'Payment date', value: String(body.payment_date) }] : []),
                        ...(body.notes ? [{ label: 'Notes', value: String(body.notes) }] : [])
                    ]
                }
            };
        }
    },
    {
        method: 'POST', pattern: /^\/salaries\/.*loan/, feature: 'staff_loan',
        details: async req => {
            const body = req.body || {};
            const staff = await userInfo(body.user_id ?? body.staff_id);
            const amount = n(body.amount);
            return {
                title: `Staff loan — ${staff?.fullname || `staff #${body.user_id ?? body.staff_id ?? '?'}`} · ${fmtMoney(amount)}`,
                amount,
                display: {
                    fields: [
                        { label: 'Staff', value: staff?.fullname || '—' },
                        { label: 'Amount', value: fmtMoney(amount) },
                        ...(body.reason ? [{ label: 'Reason', value: String(body.reason) }] : []),
                        ...(body.repayment_months ? [{ label: 'Repayment months', value: String(body.repayment_months) }] : []),
                        ...(body.start_date ? [{ label: 'Start date', value: String(body.start_date) }] : []),
                        ...(body.due_date ? [{ label: 'Due date', value: String(body.due_date) }] : []),
                        { label: 'Method', value: body.payment_method || '—' }
                    ]
                }
            };
        }
    },
    {
        method: 'POST', pattern: /^\/returns\/?$/, feature: 'return',
        details: async req => {
            const body = req.body || {};
            const sale = body.sale_id ? row1(await safeQuery('SELECT * FROM sales WHERE id = $1', [body.sale_id])) : null;
            const customer = sale?.customer_id ? await ownerDetails('customers', sale.customer_id) : null;
            const rider = !customer && sale?.rider_id ? await ownerDetails('riders', sale.rider_id) : null;
            const who = customer || rider;
            const arr = Array.isArray(body.items) ? body.items : [];
            const pmap = await productMap(arr.map(i => i.product_id ?? i.productId));
            const items = arr.map(i => {
                const pid = Number(i.product_id ?? i.productId);
                return { Product: pmap.get(pid)?.name || `Product #${pid || '?'}`, Quantity: n(i.quantity) ?? 0, Restocked: i.restock ? 'Yes' : 'No' };
            });
            const saleTotal = n(sale?.total_amount ?? sale?.total);
            return {
                title: `Sales return — sale #${body.sale_id || '?'}${who ? ` (${who.name})` : ''}`,
                amount: n(body.total_amount),
                display: {
                    fields: [
                        { label: 'Sale', value: `#${body.sale_id || '—'}` },
                        ...(who ? [{ label: customer ? 'Customer' : 'Rider', value: who.name }] : []),
                        ...(who?.phone ? [{ label: 'Phone', value: who.phone }] : []),
                        ...(saleTotal !== null ? [{ label: 'Sale total', value: fmtMoney(saleTotal) }] : []),
                        { label: 'Refund method', value: body.refund_method || '—' },
                        ...(body.reason ? [{ label: 'Reason', value: String(body.reason) }] : []),
                        ...(body.return_date ? [{ label: 'Return date', value: String(body.return_date) }] : [])
                    ],
                    items
                }
            };
        }
    },
    {
        method: 'POST', pattern: /^\/wallets\/deposit\/?$/, feature: 'wallet_deposit',
        details: async req => walletDetails(req, 'Advance deposit')
    },
    {
        method: 'POST', pattern: /^\/wallets\/refund\/?$/, feature: 'wallet_refund',
        details: async req => walletDetails(req, 'Wallet refund')
    },
    {
        method: 'POST', pattern: /^\/money\/transactions\/?$/, feature: 'money_transaction',
        details: async req => {
            const body = req.body || {};
            const account = body.account_id ? row1(await safeQuery('SELECT name, account_type, bank_name FROM money_accounts WHERE id = $1', [body.account_id])) : null;
            const amount = n(body.amount);
            const dir = body.direction === 'OUT' ? 'out' : 'in';
            return {
                title: `Money ${dir} — ${account?.name || `account #${body.account_id || '?'}`} · ${fmtMoney(amount)}`,
                amount,
                display: {
                    fields: [
                        { label: 'Account', value: account ? `${account.name}${account.bank_name ? ` (${account.bank_name})` : ''}` : `#${body.account_id || '?'}` },
                        { label: 'Direction', value: body.direction || '—' },
                        { label: 'Category', value: body.category || '—' },
                        { label: 'Amount', value: fmtMoney(amount) },
                        ...(body.description ? [{ label: 'Description', value: String(body.description) }] : []),
                        { label: 'Method', value: body.payment_method || '—' },
                        ...(body.transaction_date ? [{ label: 'Date', value: String(body.transaction_date) }] : [])
                    ]
                }
            };
        }
    },
];

// Shared wallet (deposit / refund) detail builder
async function walletDetails(req, kindLabel) {
    const body = req.body || {};
    const type = String(body.owner_type || '').toUpperCase();
    const table = type === 'RIDER' ? 'riders' : 'customers';
    const owner = body.owner_id ? await ownerDetails(table, body.owner_id) : null;
    const amount = n(body.amount);
    return {
        title: `${kindLabel} — ${owner?.name || `${type || 'wallet'} #${body.owner_id || '?'}`} · ${fmtMoney(amount)}`,
        amount,
        display: {
            fields: [
                { label: 'Wallet owner', value: `${type === 'RIDER' ? 'Rider' : 'Customer'} — ${owner?.name || '—'}` },
                ...(owner?.phone ? [{ label: 'Phone', value: owner.phone }] : []),
                ...(owner && owner.advance_balance !== null ? [{ label: 'Advance balance', value: fmtMoney(owner.advance_balance) }] : []),
                { label: 'Amount', value: fmtMoney(amount) },
                { label: 'Method', value: body.payment_method || '—' },
                ...(body.transaction_date ? [{ label: 'Date', value: String(body.transaction_date) }] : []),
                ...(body.notes ? [{ label: 'Notes', value: String(body.notes) }] : [])
            ]
        }
    };
}

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

        // Resolve enriched title / amount / display (never throws — falls back)
        let details;
        try {
            details = await route.details(req);
        } catch (e) {
            console.error(`Workflow enrichment failed for ${route.feature}:`, e.message);
            details = { title: route.feature, amount: null, display: null };
        }

        const amount = details.amount ?? null;
        const threshold = parseFloat(setting.approval_threshold || 0);
        if (threshold > 0 && (amount === null || amount < threshold)) return next();

        // AUTO-APPROVE: if the creator's own role is an approver for this feature
        // (admins approve everything), execute directly instead of staging.
        const approverRoles = Array.isArray(setting.approver_roles) ? setting.approver_roles : [];
        if (req.user && (req.user.role === 'admin' || approverRoles.includes(req.user.role))) {
            await logAudit({
                user: req.user, action: 'AUTO_APPROVED',
                entityType: route.feature, entityId: null,
                description: `Auto-approved (creator is an approver for this workflow): ${details.title}`,
                newValues: { url: req.originalUrl.split('?')[0], body: req.body }, req
            });
            return next();
        }

        // Stage the request for approval
        const payload = {
            method: req.method,
            url: req.originalUrl.split('?')[0],
            body: req.body,
            display: details.display || null,
            user_id: req.user ? req.user.id : null,
            username: req.user ? req.user.username : null,
            role: req.user ? req.user.role : null
        };
        const insert = await db.query(
            `INSERT INTO approval_requests (request_type, title, payload, amount, requested_by)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [route.feature, details.title, JSON.stringify(payload), amount, req.user ? req.user.id : null]
        );

        await logAudit({
            user: req.user, action: 'SUBMIT_FOR_APPROVAL',
            entityType: route.feature, entityId: insert.rows[0].id,
            description: `Staged for approval: ${details.title}`,
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
