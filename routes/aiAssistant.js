// routes/aiAssistant.js — AI business assistant (online AI + offline self-answer engine).
//
//   GET  /api/ai/status  → online/offline availability
//   POST /api/ai/chat    { message, mode: 'online' | 'offline' }
//
// ONLINE mode: sends the question plus a READ-ONLY data snapshot from the
// database to an OpenAI-compatible chat API. Configuration comes from env
// (AI_API_KEY / AI_API_BASE / AI_MODEL) or, once the Settings page saves them,
// from the app_settings table (keys: ai.api_key / ai.api_base / ai.model).
//
// OFFLINE mode: a built-in intent engine answers directly from the database —
// no external API needed. If online mode is requested but unavailable or the
// API call fails, the assistant automatically falls back to this engine.
//
// SAFETY: every query in this file is a SELECT. This route never writes data.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db/db');
const { ensureWalletSchema, ensureReturnsSchema } = require('../utils/schemaGuards');

function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    next();
}
router.use(requireAuth);

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
const N = (v) => Number(v || 0);
const money = (v) => `₦${N(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (v) => N(v).toLocaleString('en-NG');
const pct = (v) => `${N(v).toFixed(1)}%`;

function mdTable(headers, rows) {
    if (!rows || rows.length === 0) return '';
    const head = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => '---').join(' | ')} |`;
    const body = rows.map(r => `| ${r.join(' | ')} |`).join('\n');
    return `${head}\n${sep}\n${body}`;
}

// ---------------------------------------------------------------------------
// Period parsing — maps words in the question to SAFE, fixed SQL fragments
// (no user text is ever interpolated into SQL)
// ---------------------------------------------------------------------------
function resolvePeriod(text, defaultKey = 'thisMonth') {
    const t = (text || '').toLowerCase();
    let key = null;
    if (/\byesterday\b/.test(t)) key = 'yesterday';
    else if (/\b(today|today's|todays)\b/.test(t)) key = 'today';
    else if (/\bthis\s+week\b/.test(t)) key = 'thisWeek';
    else if (/\blast\s+week\b/.test(t)) key = 'lastWeek';
    else if (/\blast\s+month\b/.test(t)) key = 'lastMonth';
    else if (/\b(this\s+month|monthly|this\s+month's)\b/.test(t)) key = 'thisMonth';
    else if (/\b(this\s+year|yearly|annually|this\s+year's)\b/.test(t)) key = 'thisYear';
    else if (/\b(all\s*time|overall|ever|total)\b/.test(t)) key = 'all';
    if (!key) key = defaultKey;

    const F = {
        today: { label: 'today', frag: c => `DATE(${c}) = CURRENT_DATE` },
        yesterday: { label: 'yesterday', frag: c => `DATE(${c}) = CURRENT_DATE - INTERVAL '1 day'` },
        thisWeek: { label: 'this week', frag: c => `${c} >= DATE_TRUNC('week', CURRENT_DATE)` },
        lastWeek: { label: 'last week', frag: c => `${c} >= DATE_TRUNC('week', CURRENT_DATE) - INTERVAL '1 week' AND ${c} < DATE_TRUNC('week', CURRENT_DATE)` },
        thisMonth: { label: 'this month', frag: c => `${c} >= DATE_TRUNC('month', CURRENT_DATE)` },
        lastMonth: { label: 'last month', frag: c => `${c} >= DATE_TRUNC('month', CURRENT_DATE) - INTERVAL '1 month' AND ${c} < DATE_TRUNC('month', CURRENT_DATE)` },
        thisYear: { label: 'this year', frag: c => `${c} >= DATE_TRUNC('year', CURRENT_DATE)` },
        all: { label: 'all time', frag: () => 'TRUE' },
    };
    return { key, label: F[key].label, frag: F[key].frag };
}

// ---------------------------------------------------------------------------
// Read-only data providers (each fails soft → null, so one bad table can
// never break the whole assistant)
// ---------------------------------------------------------------------------
async function safe(label, fn) {
    try { return await fn(); }
    catch (e) { console.error(`AI assistant: provider "${label}" failed:`, e.message); return null; }
}

async function getSalesSummary(period) {
    const where = `st.status != 'Cancelled' AND ${period.frag('st.sale_date')}`;
    const totals = await db.query(`
        SELECT COUNT(*) AS sales_count,
               COALESCE(SUM(st.total_amount), 0) AS total_sales,
               COALESCE(SUM(st.total_profit), 0) AS total_profit,
               COALESCE(SUM(st.total_cogs), 0) AS total_cogs,
               COALESCE(SUM(st.amount_paid), 0) AS total_collected,
               COALESCE(SUM(st.balance_due), 0) AS total_outstanding
        FROM sales_transactions st WHERE ${where}`);
    const byMethod = await db.query(`
        SELECT st.payment_method, COUNT(*) AS count, COALESCE(SUM(st.total_amount), 0) AS total
        FROM sales_transactions st WHERE ${where}
        GROUP BY st.payment_method ORDER BY total DESC`);
    const topProducts = await db.query(`
        SELECT p.name, SUM(si.quantity) AS qty, COALESCE(SUM(si.quantity * si.price_at_sale), 0) AS amount
        FROM sales_items si
        JOIN sales_transactions st ON si.sale_id = st.id
        JOIN products p ON si.product_id = p.id
        WHERE ${where}
        GROUP BY p.name ORDER BY amount DESC LIMIT 5`);
    return { totals: totals.rows[0], byMethod: byMethod.rows, topProducts: topProducts.rows };
}

async function getCustomers() {
    const count = await db.query('SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE is_active) AS active FROM customers');
    const top = await db.query(`
        SELECT c.fullname, c.phone, c.balance AS credit_balance,
               COUNT(st.id) AS sales_count, COALESCE(SUM(st.total_amount), 0) AS total_spent
        FROM customers c
        LEFT JOIN sales_transactions st ON st.customer_id = c.id AND st.status != 'Cancelled'
        GROUP BY c.id ORDER BY total_spent DESC LIMIT 10`);
    return { count: count.rows[0], top: top.rows };
}

async function getDebtors() {
    const customers = await db.query(`
        SELECT fullname, phone, balance FROM customers
        WHERE balance > 0 ORDER BY balance DESC LIMIT 15`);
    const riders = await db.query(`
        SELECT fullname, phone_number, current_balance FROM riders
        WHERE current_balance > 0 ORDER BY current_balance DESC LIMIT 15`);
    const totals = await db.query(`
        SELECT (SELECT COALESCE(SUM(balance), 0) FROM customers WHERE balance > 0) AS customer_debt,
               (SELECT COALESCE(SUM(current_balance), 0) FROM riders WHERE current_balance > 0) AS rider_debt`);
    return { customers: customers.rows, riders: riders.rows, totals: totals.rows[0] };
}

async function getProductStock() {
    const r = await db.query(`
        SELECT p.name, p.category, p.price, COALESCE(i.quantity, 0) AS stock
        FROM products p LEFT JOIN inventory i ON i.product_id = p.id
        ORDER BY p.name ASC LIMIT 60`);
    return r.rows;
}

async function getRawMaterials() {
    const r = await db.query(`
        SELECT name, unit, current_stock, min_stock_level,
               (current_stock <= min_stock_level) AS is_low
        FROM raw_materials ORDER BY is_low DESC, name ASC LIMIT 60`);
    return r.rows;
}

async function getExpenses(period) {
    const frag = period.frag('expense_date');
    const totals = await db.query(`
        SELECT COUNT(*) AS count, COALESCE(SUM(amount), 0) AS total
        FROM operating_expenses WHERE status = 'active' AND ${frag}`);
    const byType = await db.query(`
        SELECT expense_type, COALESCE(SUM(amount), 0) AS total
        FROM operating_expenses WHERE status = 'active' AND ${frag}
        GROUP BY expense_type ORDER BY total DESC`);
    return { totals: totals.rows[0], byType: byType.rows };
}

async function getPayments(period) {
    const frag = period.frag('p.payment_date');
    const totals = await db.query(`
        SELECT COUNT(*) AS count, COALESCE(SUM(p.amount), 0) AS total
        FROM payments p WHERE ${frag}`);
    const recent = await db.query(`
        SELECT p.amount, p.payment_date, p.payment_method, p.is_rider_payment,
               COALESCE(c.fullname, r.fullname, 'N/A') AS payer
        FROM payments p
        LEFT JOIN customers c ON p.customer_id = c.id
        LEFT JOIN riders r ON p.rider_id = r.id
        WHERE ${frag}
        ORDER BY p.payment_date DESC, p.id DESC LIMIT 12`);
    return { totals: totals.rows[0], recent: recent.rows };
}

async function getMoneySummary() {
    const accounts = await db.query(`
        SELECT name, account_type, bank_name, current_balance
        FROM money_accounts WHERE is_active = true ORDER BY account_type, name`);
    const month = await db.query(`
        SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN amount ELSE 0 END), 0) AS month_in,
               COALESCE(SUM(CASE WHEN direction = 'OUT' THEN amount ELSE 0 END), 0) AS month_out
        FROM money_transactions
        WHERE transaction_date >= DATE_TRUNC('month', CURRENT_DATE)`);
    return { accounts: accounts.rows, month: month.rows[0] };
}

async function getProduction(period) {
    const frag = period.frag('pl.production_date');
    const totals = await db.query(`
        SELECT COUNT(*) AS batches, COALESCE(SUM(pl.quantity_produced), 0) AS produced,
               COALESCE(SUM(pl.waste_quantity), 0) AS wasted
        FROM production_logs pl WHERE ${frag}`);
    const byProduct = await db.query(`
        SELECT p.name, COALESCE(SUM(pl.quantity_produced), 0) AS qty
        FROM production_logs pl JOIN products p ON pl.product_id = p.id
        WHERE ${frag} GROUP BY p.name ORDER BY qty DESC LIMIT 8`);
    return { totals: totals.rows[0], byProduct: byProduct.rows };
}

async function getSalaries(period) {
    const frag = period.frag('payment_date');
    const r = await db.query(`
        SELECT COUNT(*) AS count, COALESCE(SUM(net_amount), 0) AS total
        FROM salary_payments WHERE status = 'paid' AND ${frag}`);
    return r.rows[0];
}

async function getReturns(period) {
    if (!(await ensureReturnsSchema())) return { unavailable: true };
    const frag = period.frag('return_date');
    const r = await db.query(`
        SELECT COUNT(*) AS count, COALESCE(SUM(total_amount), 0) AS total,
               COALESCE(SUM(credit_applied), 0) AS credit_applied,
               COALESCE(SUM(wallet_credited), 0) AS wallet_credited,
               COALESCE(SUM(cash_refunded), 0) AS cash_refunded
        FROM sales_returns WHERE ${frag}`);
    return r.rows[0];
}

async function getWallets() {
    if (!(await ensureWalletSchema())) return { unavailable: true };
    const bal = await db.query(`
        SELECT (SELECT COALESCE(SUM(advance_balance), 0) FROM customers) AS customer_wallets,
               (SELECT COALESCE(SUM(advance_balance), 0) FROM riders) AS rider_wallets`);
    const top = await db.query(`
        SELECT fullname, advance_balance FROM customers WHERE advance_balance > 0
        UNION ALL
        SELECT fullname, advance_balance FROM riders WHERE advance_balance > 0
        ORDER BY advance_balance DESC LIMIT 10`);
    const monthTxns = await db.query(`
        SELECT COUNT(*) AS count FROM wallet_transactions
        WHERE created_at >= DATE_TRUNC('month', CURRENT_DATE)`);
    return { balances: bal.rows[0], top: top.rows, monthCount: monthTxns.rows[0].count };
}

async function getRiders() {
    const r = await db.query(`
        SELECT fullname, phone_number, current_balance, credit_limit
        FROM riders ORDER BY fullname ASC LIMIT 30`);
    return r.rows;
}

async function getStaff() {
    const r = await db.query(`SELECT fullname, role FROM users ORDER BY role, fullname LIMIT 40`);
    return r.rows;
}

// ---------------------------------------------------------------------------
// Offline answer builders (markdown)
// ---------------------------------------------------------------------------
async function answerSales(q) {
    const period = resolvePeriod(q, 'today');
    const d = await safe('sales', () => getSalesSummary(period));
    if (!d) return 'I could not read the sales data right now. Please try again.';
    const t = d.totals;
    let out = `### Sales — ${period.label}\n\n`;
    out += `- **Total sales:** ${money(t.total_sales)} across **${num(t.sales_count)}** transaction(s)\n`;
    out += `- **Amount collected:** ${money(t.total_collected)}\n`;
    out += `- **Outstanding (credit):** ${money(t.total_outstanding)}\n`;
    out += `- **Gross profit:** ${money(t.total_profit)}\n`;
    if (d.byMethod.length) {
        out += `\n**By payment method**\n\n`;
        out += mdTable(['Method', 'Sales', 'Total'], d.byMethod.map(m => [m.payment_method, num(m.count), money(m.total)]));
    }
    if (d.topProducts.length) {
        out += `\n\n**Top products (${period.label})**\n\n`;
        out += mdTable(['Product', 'Qty sold', 'Amount'], d.topProducts.map(p => [p.name, num(p.qty), money(p.amount)]));
    }
    return out;
}

async function answerProfit(q) {
    const period = resolvePeriod(q, 'thisMonth');
    const [sales, expenses, salaries] = await Promise.all([
        safe('sales', () => getSalesSummary(period)),
        safe('expenses', () => getExpenses(period)),
        safe('salaries', () => getSalaries(period)),
    ]);
    if (!sales) return 'I could not read the figures right now. Please try again.';
    const revenue = N(sales.totals.total_sales);
    const cogs = N(sales.totals.total_cogs);
    const gross = revenue - cogs;
    const opex = expenses ? N(expenses.totals.total) : 0;
    const sal = salaries ? N(salaries.total) : 0;
    const net = gross - opex - sal;
    let out = `### Profit summary — ${period.label}\n\n`;
    out += mdTable(['Item', 'Amount'], [
        ['Revenue (sales)', money(revenue)],
        ['Cost of goods sold', `-${money(cogs)}`],
        ['**Gross profit**', `**${money(gross)}**`],
        ['Operating expenses', `-${money(opex)}`],
        ['Salaries paid', `-${money(sal)}`],
        ['**Net profit (before tax)**', `**${money(net)}**`],
    ]);
    out += `\n\nFor the full audited breakdown (including tax), see **Reports → Profit & Loss Summary**.`;
    return out;
}

async function answerCustomers() {
    const d = await safe('customers', getCustomers);
    if (!d) return 'I could not read the customers list right now.';
    let out = `### Customers\n\nYou have **${num(d.count.total)}** customers on record (${num(d.count.active)} active).\n`;
    if (d.top.length) {
        out += `\n**Top customers by total purchases**\n\n`;
        out += mdTable(['Customer', 'Phone', 'Purchases', 'Total spent', 'Credit balance'],
            d.top.map(c => [c.fullname, c.phone || '—', num(c.sales_count), money(c.total_spent), money(c.credit_balance)]));
    }
    return out;
}

async function answerDebtors() {
    const d = await safe('debtors', getDebtors);
    if (!d) return 'I could not read the credit balances right now.';
    const t = d.totals;
    let out = `### Outstanding credit\n\n`;
    out += `- **Customers owe:** ${money(t.customer_debt)}\n- **Riders owe:** ${money(t.rider_debt)}\n- **Total outstanding:** **${money(N(t.customer_debt) + N(t.rider_debt))}**\n`;
    if (d.customers.length) {
        out += `\n**Customers with balances**\n\n`;
        out += mdTable(['Customer', 'Phone', 'Owes'], d.customers.map(c => [c.fullname, c.phone || '—', money(c.balance)]));
    }
    if (d.riders.length) {
        out += `\n\n**Riders with balances**\n\n`;
        out += mdTable(['Rider', 'Phone', 'Owes'], d.riders.map(r => [r.fullname, r.phone_number || '—', money(r.current_balance)]));
    }
    if (!d.customers.length && !d.riders.length) out += `\nGreat news — nobody owes anything right now. 🎉`;
    return out;
}

async function answerStock() {
    const d = await safe('stock', getProductStock);
    if (!d) return 'I could not read the inventory right now.';
    const low = d.filter(p => N(p.stock) <= 5);
    let out = `### Product stock levels\n\n`;
    if (low.length) out += `⚠️ **${low.length} product(s) at 5 units or fewer.**\n\n`;
    out += mdTable(['Product', 'Category', 'Price', 'In stock'],
        d.map(p => [p.name, p.category || '—', money(p.price), num(p.stock)]));
    return out;
}

async function answerRawMaterials() {
    const d = await safe('rawMaterials', getRawMaterials);
    if (!d) return 'I could not read the raw materials right now.';
    const low = d.filter(m => m.is_low);
    let out = `### Raw materials\n\n`;
    if (low.length) out += `⚠️ **Low stock:** ${low.map(m => m.name).join(', ')} — please restock.\n\n`;
    out += mdTable(['Material', 'Stock', 'Unit', 'Min level'],
        d.map(m => [m.name + (m.is_low ? ' ⚠️' : ''), num(m.current_stock), m.unit || '—', num(m.min_stock_level)]));
    return out;
}

async function answerExpenses(q) {
    const period = resolvePeriod(q, 'thisMonth');
    const d = await safe('expenses', () => getExpenses(period));
    if (!d) return 'I could not read the expenses right now.';
    let out = `### Operating expenses — ${period.label}\n\n`;
    out += `**Total:** ${money(d.totals.total)} across **${num(d.totals.count)}** expense record(s).\n`;
    if (d.byType.length) {
        out += `\n**By type**\n\n`;
        out += mdTable(['Type', 'Total'], d.byType.map(e => [e.expense_type, money(e.total)]));
    }
    return out;
}

async function answerPayments(q) {
    const period = resolvePeriod(q, 'today');
    const d = await safe('payments', () => getPayments(period));
    if (!d) return 'I could not read the payments right now.';
    let out = `### Payments received — ${period.label}\n\n`;
    out += `**Total collected:** ${money(d.totals.total)} across **${num(d.totals.count)}** payment(s).\n`;
    if (d.recent.length) {
        out += `\n**Most recent**\n\n`;
        out += mdTable(['Date', 'Payer', 'Method', 'Amount'],
            d.recent.map(p => [new Date(p.payment_date).toLocaleDateString('en-NG'), `${p.payer}${p.is_rider_payment ? ' (Rider)' : ''}`, p.payment_method || '—', money(p.amount)]));
    }
    return out;
}

async function answerMoney() {
    const d = await safe('money', getMoneySummary);
    if (!d) return 'I could not read the money accounts right now.';
    let out = `### Cash & bank balances\n\n`;
    if (d.accounts.length) {
        out += mdTable(['Account', 'Type', 'Balance'],
            d.accounts.map(a => [a.name + (a.bank_name ? ` (${a.bank_name})` : ''), a.account_type, money(a.current_balance)]));
        const total = d.accounts.reduce((s, a) => s + N(a.current_balance), 0);
        out += `\n**Total across accounts:** ${money(total)}\n`;
    } else {
        out += 'No active money accounts found — set them up under **Money**.\n';
    }
    out += `\n**This month:** ${money(d.month.month_in)} in / ${money(d.month.month_out)} out.`;
    return out;
}

async function answerProduction(q) {
    const period = resolvePeriod(q, 'today');
    const d = await safe('production', () => getProduction(period));
    if (!d) return 'I could not read the production logs right now.';
    let out = `### Production — ${period.label}\n\n`;
    out += `- **Batches logged:** ${num(d.totals.batches)}\n- **Units produced:** ${num(d.totals.produced)}\n- **Waste:** ${num(d.totals.wasted)}\n`;
    if (d.byProduct.length) {
        out += `\n**By product**\n\n`;
        out += mdTable(['Product', 'Units produced'], d.byProduct.map(p => [p.name, num(p.qty)]));
    }
    return out;
}

async function answerSalaries(q) {
    const period = resolvePeriod(q, 'thisMonth');
    const d = await safe('salaries', () => getSalaries(period));
    if (!d) return 'I could not read the salary records right now.';
    return `### Salaries — ${period.label}\n\n**${money(d.total)}** paid across **${num(d.count)}** salary payment(s).\n\nFor full payroll detail see **Reports → Salary & Payroll Report**.`;
}

async function answerReturns(q) {
    const period = resolvePeriod(q, 'thisMonth');
    const d = await safe('returns', () => getReturns(period));
    if (!d) return 'I could not read the returns right now.';
    if (d.unavailable) return 'The returns feature is not installed yet (migration 003), so there is nothing to report.';
    let out = `### Sales returns — ${period.label}\n\n`;
    out += `- **Returns processed:** ${num(d.count)}\n- **Total value:** ${money(d.total)}\n`;
    out += `- Applied to credit: ${money(d.credit_applied)} · To wallets: ${money(d.wallet_credited)} · Cash/bank refunded: ${money(d.cash_refunded)}\n`;
    return out;
}

async function answerWallets() {
    const d = await safe('wallets', getWallets);
    if (!d) return 'I could not read the wallets right now.';
    if (d.unavailable) return 'The advance-wallet feature is not installed yet (migration 002), so there is nothing to report.';
    const b = d.balances;
    let out = `### Advance wallet balances\n\n`;
    out += `- **Customers:** ${money(b.customer_wallets)}\n- **Riders:** ${money(b.rider_wallets)}\n- **Total held:** **${money(N(b.customer_wallets) + N(b.rider_wallets))}**\n`;
    out += `\n${num(d.monthCount)} wallet transaction(s) this month.`;
    if (d.top.length) {
        out += `\n\n**Largest wallet balances**\n\n`;
        out += mdTable(['Name', 'Balance'], d.top.map(w => [w.fullname, money(w.advance_balance)]));
    }
    return out;
}

async function answerRiders() {
    const d = await safe('riders', getRiders);
    if (!d) return 'I could not read the riders right now.';
    let out = `### Riders (${d.length})\n\n`;
    out += mdTable(['Rider', 'Phone', 'Owes', 'Credit limit'],
        d.map(r => [r.fullname, r.phone_number || '—', money(r.current_balance), money(r.credit_limit)]));
    return out;
}

async function answerStaff() {
    const d = await safe('staff', getStaff);
    if (!d) return 'I could not read the staff list right now.';
    let out = `### Team members (${d.length})\n\n`;
    out += mdTable(['Name', 'Role'], d.map(u => [u.fullname, u.role]));
    return out;
}

const HELP_TEXT = `### What I can answer

Ask me things like:

- **Sales** — "sales today", "sales this week", "total revenue this month"
- **Profit** — "profit this month", "how much did we make"
- **Customers** — "list customers", "who are our top customers"
- **Credit** — "who owes us", "outstanding balances"
- **Stock** — "product stock levels", "what is in inventory"
- **Raw materials** — "raw material stock", "which materials are low"
- **Expenses** — "expenses this month"
- **Payments** — "payments today", "collections this week"
- **Money** — "cash and bank balances"
- **Production** — "production today", "what did we bake this week"
- **Salaries** — "salaries paid this month"
- **Returns** — "returns this month"
- **Wallets** — "advance wallet balances"
- **People** — "list riders", "list staff"

Tip: add a time word — *today, yesterday, this week, last week, this month, last month, this year, all time*.`;

function offlineIntent(q) {
    const t = (q || '').toLowerCase().trim();
    if (!t) return { name: 'help' };
    if (/^(hi|hello|hey|good\s(morning|afternoon|evening)|yo)\b/.test(t) && t.length < 40) return { name: 'greeting' };
    if (/\b(help|what can you do|how do you work|guide)\b/.test(t)) return { name: 'help' };
    if (/\breturn/.test(t)) return { name: 'returns' };
    if (/\b(wallet|advance|deposit)\b/.test(t)) return { name: 'wallets' };
    if (/\b(profit|p\s*&\s*l|income|earnings|margin)\b/.test(t)) return { name: 'profit' };
    if (/\b(owe|owes|owing|outstanding|debt|debtor|credit balance|unpaid)\b/.test(t)) return { name: 'debtors' };
    if (/\b(raw\s*material|ingredient|flour|sugar|butter)\b/.test(t)) return { name: 'rawMaterials' };
    if (/\b(stock|inventory|products? (level|balance|left|remaining)|how many products)\b/.test(t)) return { name: 'stock' };
    if (/\bexpense|spending|spent on\b/.test(t)) return { name: 'expenses' };
    if (/\b(salar|payroll)\b/.test(t)) return { name: 'salaries' };
    if (/\b(payment|collection|collected|remittance)\b/.test(t)) return { name: 'payments' };
    if (/\b(cash|bank|money|account balance|balances)\b/.test(t)) return { name: 'money' };
    if (/\b(production|bake|baked|baking|batches|produced)\b/.test(t)) return { name: 'production' };
    if (/\brider/.test(t)) return { name: 'riders' };
    if (/\bcustomer/.test(t)) return { name: 'customers' };
    if (/\b(staff|employee|team|users? list|workers)\b/.test(t)) return { name: 'staff' };
    if (/\b(sale|sales|revenue|sold|selling)\b/.test(t)) return { name: 'sales' };
    return { name: 'unknown' };
}

async function answerOffline(question, userName) {
    const intent = offlineIntent(question);
    switch (intent.name) {
        case 'greeting':
            return `Hello${userName ? ` ${userName}` : ''}! 👋 I'm your business assistant. Ask me about **sales, profit, customers, credit, stock, expenses, payments, production, salaries, returns or wallets** — or type **help** to see examples.`;
        case 'help': return HELP_TEXT;
        case 'sales': return answerSales(question);
        case 'profit': return answerProfit(question);
        case 'customers': return answerCustomers();
        case 'debtors': return answerDebtors();
        case 'stock': return answerStock();
        case 'rawMaterials': return answerRawMaterials();
        case 'expenses': return answerExpenses(question);
        case 'payments': return answerPayments(question);
        case 'money': return answerMoney();
        case 'production': return answerProduction(question);
        case 'salaries': return answerSalaries(question);
        case 'returns': return answerReturns(question);
        case 'wallets': return answerWallets();
        case 'riders': return answerRiders();
        case 'staff': return answerStaff();
        default:
            return `I'm not sure how to answer that one yet. Try rephrasing, or type **help** to see the questions I understand.\n\nFor example: *"sales today"*, *"who owes us"*, *"product stock levels"*.`;
    }
}

// ---------------------------------------------------------------------------
// Online AI mode
// ---------------------------------------------------------------------------
async function getAiConfig() {
    const cfg = {
        apiKey: process.env.AI_API_KEY || '',
        apiBase: (process.env.AI_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, ''),
        model: process.env.AI_MODEL || 'gpt-4o-mini',
    };
    if (!cfg.apiKey) {
        // Fall back to keys saved from the Settings page (Phase: settings).
        try {
            const r = await db.query(
                "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('ai.api_key', 'ai.api_base', 'ai.model')"
            );
            for (const row of r.rows) {
                const val = String(row.setting_value ?? '').replace(/^"|"$/g, '').trim();
                if (!val) continue;
                if (row.setting_key === 'ai.api_key') cfg.apiKey = val;
                if (row.setting_key === 'ai.api_base') cfg.apiBase = val.replace(/\/+$/, '');
                if (row.setting_key === 'ai.model') cfg.model = val;
            }
        } catch (_) { /* app_settings table not installed yet — env only */ }
    }
    return cfg;
}

// Compact, read-only snapshot of the business for the AI to reason over.
async function buildDataSnapshot() {
    const today = resolvePeriod('today', 'today');
    const month = resolvePeriod('this month', 'thisMonth');
    const [salesToday, salesMonth, debtors, stock, materials, expenses, money, production, wallets, returns, counts] =
        await Promise.all([
            safe('salesToday', () => getSalesSummary(today)),
            safe('salesMonth', () => getSalesSummary(month)),
            safe('debtors', getDebtors),
            safe('stock', getProductStock),
            safe('materials', getRawMaterials),
            safe('expenses', () => getExpenses(month)),
            safe('money', getMoneySummary),
            safe('production', () => getProduction(month)),
            safe('wallets', getWallets),
            safe('returns', () => getReturns(month)),
            safe('counts', async () => {
                const r = await db.query(`
                    SELECT (SELECT COUNT(*) FROM customers WHERE is_active) AS customers,
                           (SELECT COUNT(*) FROM riders) AS riders,
                           (SELECT COUNT(*) FROM products) AS products,
                           (SELECT COUNT(*) FROM users) AS staff`);
                return r.rows[0];
            }),
        ]);

    return {
        business_date: new Date().toISOString().slice(0, 10),
        record_counts: counts,
        sales_today: salesToday && { ...salesToday.totals, by_method: salesToday.byMethod, top_products: salesToday.topProducts },
        sales_this_month: salesMonth && { ...salesMonth.totals, by_method: salesMonth.byMethod },
        outstanding_credit: debtors && {
            customers_total: debtors.totals.customer_debt,
            riders_total: debtors.totals.rider_debt,
            top_customer_debtors: debtors.customers.slice(0, 10),
            top_rider_debtors: debtors.riders.slice(0, 10),
        },
        product_stock: stock && stock.slice(0, 40),
        low_raw_materials: materials && materials.filter(m => m.is_low),
        expenses_this_month: expenses && { total: expenses.totals.total, by_type: expenses.byType },
        money_accounts: money && money.accounts,
        money_this_month: money && money.month,
        production_this_month: production && { ...production.totals, by_product: production.byProduct },
        advance_wallets: wallets && !wallets.unavailable ? wallets.balances : 'feature not installed',
        returns_this_month: returns && !returns.unavailable ? returns : 'feature not installed',
    };
}

async function answerOnline(question, userName, cfg) {
    const snapshot = await buildDataSnapshot();
    const systemPrompt = [
        `You are "Purple", the AI business assistant for Purple Premium Bread, a bakery in Nigeria (currency: Nigerian Naira ₦).`,
        userName ? `You are chatting with ${userName}.` : '',
        `Answer the user's question using ONLY the JSON data snapshot below — it is live data queried from the company database just now. Never invent figures.`,
        `If the snapshot does not contain what they ask, say so honestly and suggest a related question the data can answer.`,
        `Formatting: one short intro sentence, then clean markdown — pipe tables for lists, bold for key figures.`,
        `Always format money as ₦ with thousand separators and 2 decimals (e.g. ₦1,234,567.89). Keep answers concise and business-like.`,
        ``,
        `DATA SNAPSHOT (JSON):`,
        JSON.stringify(snapshot),
    ].filter(Boolean).join('\n');

    const resp = await axios.post(
        `${cfg.apiBase}/chat/completions`,
        {
            model: cfg.model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: question },
            ],
            temperature: 0.2,
            max_tokens: 900,
        },
        {
            headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
            timeout: 45000,
        }
    );
    const answer = resp.data?.choices?.[0]?.message?.content;
    if (!answer) throw new Error('The AI provider returned an empty answer.');
    return answer;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/ai/status — lets the UI show which modes are available
router.get('/status', async (req, res) => {
    const cfg = await getAiConfig();
    res.status(200).json({
        online: {
            configured: Boolean(cfg.apiKey),
            model: cfg.model,
            provider: 'OpenAI-compatible API',
        },
        offline: { available: true },
    });
});

// POST /api/ai/chat { message, mode }
router.post('/chat', async (req, res) => {
    const { message, mode = 'offline' } = req.body || {};
    if (!message || !String(message).trim()) {
        return res.status(400).json({ error: 'message is required.' });
    }
    const question = String(message).trim().slice(0, 2000);
    const userName = req.user.fullname || req.user.name || '';

    try {
        if (mode === 'online') {
            const cfg = await getAiConfig();
            if (!cfg.apiKey) {
                const answer = await answerOffline(question, userName);
                return res.status(200).json({
                    answer,
                    mode_used: 'offline',
                    fallback: true,
                    notice: 'Online AI is not configured yet (no API key). I answered with the built-in offline engine. Add your API key in Settings or the AI_API_KEY environment variable to enable online mode.',
                });
            }
            try {
                const answer = await answerOnline(question, userName, cfg);
                return res.status(200).json({ answer, mode_used: 'online', model: cfg.model });
            } catch (aiErr) {
                console.error('AI assistant: online call failed, falling back to offline:', aiErr.message);
                const answer = await answerOffline(question, userName);
                return res.status(200).json({
                    answer,
                    mode_used: 'offline',
                    fallback: true,
                    notice: `Online AI request failed (${aiErr.message}). I answered with the built-in offline engine instead.`,
                });
            }
        }

        const answer = await answerOffline(question, userName);
        return res.status(200).json({ answer, mode_used: 'offline' });
    } catch (error) {
        console.error('AI assistant error:', error);
        res.status(500).json({ error: 'The assistant ran into a problem. Please try again.', details: error.message });
    }
});

module.exports = router;
