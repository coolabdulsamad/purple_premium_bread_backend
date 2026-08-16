// routes/telegram.js — Telegram bot integration (replaces WhatsApp).
//
// Staff use the whole system from Telegram, step by step:
//   - Webhook (POST incoming updates) — open; Telegram posts to it directly
//   - Identity linking via a 6-digit one-time code generated in the app
//     (Team Chat page → "Telegram"), stored in telegram_sessions
//   - Permission-aware menus: every menu/flow checks role_permissions
//     through checkPermission(), honouring the admin Permissions page
//
// CONFIGURATION (Settings page app_settings keys or env):
//   telegram.enabled    'true' / 'false'   (TELEGRAM_ENABLED)
//   telegram.bot_token  Bot API token      (TELEGRAM_BOT_TOKEN)
// If no bot token is configured the webhook still answers 200 but sends nothing.
const express = require('express');
const router = express.Router();
const axios = require('axios');
const db = require('../db/db');
const authenticate = require('../middleware/authenticate');
const { checkPermission } = require('../middleware/permissionGuard');
const { recordMoneyTransaction } = require('../utils/money');

const CODE_TTL_MINUTES = 10;

const money = (n) => 'NGN ' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (v) => {
    const n = parseFloat(String(v || '').replace(/[₦,\s]/g, ''));
    return isNaN(n) ? null : n;
};
// Escape dynamic values so Telegram Markdown never breaks
const esc = (s) => String(s ?? '').replace(/([_*\[\]`])/g, '\\$1');

// Photos sent with the current message (receipt uploads), keyed by chat id
const pendingPhotos = new Map();
function takePhoto(chatId) {
    const k = String(chatId);
    const p = pendingPhotos.get(k);
    pendingPhotos.delete(k);
    return p || null;
}
// Shared prompt for the optional receipt/reference step
const RECEIPT_PROMPT = `Optional: send a *photo of the receipt*, type a *reference number*, or *-* to skip.\n\n0. Cancel`;
// Reads a receipt step answer: returns { url, reference } (either may be null)
function readReceiptAnswer(chatId, text) {
    const ph = takePhoto(chatId);
    if (ph && ph.url) {
        return { url: ph.url, reference: ph.caption ? ph.caption.slice(0, 200) : null };
    }
    if (text === '-' || text === '' || text === '[photo]') return { url: null, reference: null };
    return { url: null, reference: text.slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Config: Settings page (app_settings) first, environment variables as fallback
// ---------------------------------------------------------------------------
let cfgCache = { loadedAt: 0, cfg: null };
async function getTelegramConfig() {
    if (cfgCache.cfg && Date.now() - cfgCache.loadedAt < 30 * 1000) return cfgCache.cfg;
    const cfg = {
        enabled: null,
        bot_token: process.env.TELEGRAM_BOT_TOKEN || ''
    };
    try {
        const r = await db.query(
            `SELECT setting_key, setting_value FROM app_settings
             WHERE setting_key IN ('telegram.enabled','telegram.bot_token')`
        );
        const read = (row) => String(row.setting_value ?? '').replace(/^"|"$/g, '').trim();
        for (const row of r.rows) {
            const v = read(row);
            if (row.setting_key === 'telegram.enabled') cfg.enabled = (v === 'true' || v === '1');
            if (row.setting_key === 'telegram.bot_token' && v) cfg.bot_token = v;
        }
    } catch (e) { /* app_settings missing → env only */ }
    if (cfg.enabled === null) cfg.enabled = !!cfg.bot_token;
    cfg.configured = !!cfg.bot_token;
    cfgCache = { loadedAt: Date.now(), cfg };
    return cfg;
}

// ---------------------------------------------------------------------------
// Sending (Bot API). Long texts are split into <=3800-char messages.
// ---------------------------------------------------------------------------
async function sendTelegramText(chatId, text) {
    const cfg = await getTelegramConfig();
    if (!cfg.enabled || !cfg.configured) {
        console.warn('Telegram not configured/enabled — message not sent to', chatId);
        return false;
    }
    const chunks = [];
    let rest = String(text);
    while (rest.length > 3800) {
        let cut = rest.lastIndexOf('\n', 3800);
        if (cut < 500) cut = 3800;
        chunks.push(rest.slice(0, cut));
        rest = rest.slice(cut).replace(/^\n+/, '');
    }
    chunks.push(rest);
    for (const chunk of chunks) {
        try {
            await axios.post(
                `https://api.telegram.org/bot${cfg.bot_token}/sendMessage`,
                { chat_id: chatId, text: chunk, parse_mode: 'Markdown', disable_web_page_preview: true },
                { timeout: 15000 }
            );
        } catch (e) {
            console.error('Telegram send failed:', e.response?.data ? JSON.stringify(e.response.data) : e.message);
            // Retry once without Markdown in case a dynamic value broke parsing
            try {
                await axios.post(
                    `https://api.telegram.org/bot${cfg.bot_token}/sendMessage`,
                    { chat_id: chatId, text: chunk.replace(/[*_`\[]/g, ''), disable_web_page_preview: true },
                    { timeout: 15000 }
                );
            } catch (e2) {
                console.error('Telegram plain-text retry failed:', e2.message);
                return false;
            }
        }
    }
    return true;
}

// ---------------------------------------------------------------------------
// Sessions (telegram_sessions table)
// state: { flow, step, options:[{key,label}], data:{...} }
// ---------------------------------------------------------------------------
async function getSession(chatId) {
    const key = String(chatId);
    let r = await db.query('SELECT * FROM telegram_sessions WHERE chat_id = $1', [key]);
    if (r.rows.length) return r.rows[0];
    r = await db.query(
        `INSERT INTO telegram_sessions (chat_id, is_authenticated, session_state, last_active_at)
         VALUES ($1, false, '{}', NOW()) RETURNING *`, [key]);
    return r.rows[0];
}

async function saveState(id, state) {
    await db.query(
        'UPDATE telegram_sessions SET session_state = $1, last_active_at = NOW() WHERE id = $2',
        [JSON.stringify(state || {}), id]
    );
}

async function getUser(userId) {
    const r = await db.query('SELECT id, fullname, role FROM users WHERE id = $1', [userId]);
    return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Shared query snippets
// ---------------------------------------------------------------------------
const PERIODS = {
    today: `DATE(%COL%) = CURRENT_DATE`,
    week: `%COL% >= DATE_TRUNC('week', CURRENT_DATE)`,
    month: `%COL% >= DATE_TRUNC('month', CURRENT_DATE)`
};
const periodWhere = (col, p) => PERIODS[p].replace(/%COL%/g, col);

async function salesSummary(period) {
    const r = await db.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(total_amount),0) AS total, COALESCE(SUM(balance_due),0) AS credit
         FROM sales_transactions WHERE ${periodWhere('sale_date', period)}`
    );
    return r.rows[0];
}
async function paymentsSummary(period) {
    const r = await db.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM payments WHERE ${periodWhere('payment_date', period)}`
    );
    return r.rows[0];
}
async function expensesSummary(period) {
    const r = await db.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS total FROM operating_expenses WHERE ${periodWhere('expense_date', period)}`
    );
    return r.rows[0];
}
const PERIOD_LABEL = { today: 'Today', week: 'This week', month: 'This month' };

// ---------------------------------------------------------------------------
// Webhook — incoming updates. Answer 200 immediately, process async.
// ---------------------------------------------------------------------------
router.post('/webhook', (req, res) => {
    res.sendStatus(200);
    (async () => {
        const msg = req.body?.message;
        if (!msg || !msg.chat || msg.chat.id === undefined) return;
        const chatId = String(msg.chat.id);
        // Photo message (receipt upload) — resolve it to a downloadable URL
        if (msg.photo && msg.photo.length) {
            const caption = (msg.caption || '').trim();
            const cfg = await getTelegramConfig();
            let photoUrl = null;
            if (cfg.configured) {
                try {
                    const best = msg.photo[msg.photo.length - 1];
                    const f = await axios.get(`https://api.telegram.org/bot${cfg.bot_token}/getFile`,
                        { params: { file_id: best.file_id }, timeout: 15000 });
                    const fp = f.data && f.data.result && f.data.result.file_path;
                    if (fp) photoUrl = `https://api.telegram.org/file/bot${cfg.bot_token}/${fp}`;
                } catch (e) {
                    console.error('Telegram getFile failed:', e.message);
                }
            }
            pendingPhotos.set(chatId, { url: photoUrl, caption });
            await handleIncoming(chatId, caption || '[photo]');
            return;
        }
        if (!msg.text) {
            await sendTelegramText(chatId, 'Sorry, I only understand text messages and receipt photos for now. Send *hi* to see the menu.');
            return;
        }
        const text = msg.text.trim();
        if (!text) return;
        await handleIncoming(chatId, text);
    })().catch(e => console.error('Telegram webhook processing error:', e.message));
});

// ---------------------------------------------------------------------------
// Incoming message router
// ---------------------------------------------------------------------------
async function handleIncoming(chatId, text) {
    const session = await getSession(chatId);

    // ---- Not linked yet: expect a 6-digit login code from the app ----
    if (!session.is_authenticated || !session.user_id) {
        if (/^\d{6}$/.test(text)) {
            const ok = await redeemLoginCode(chatId, text);
            if (!ok) {
                await sendTelegramText(chatId, 'That code is invalid or has expired. Open the app → Team Chat → Telegram button to generate a fresh code.');
            }
        } else {
            await sendTelegramText(chatId,
                `Welcome to *Purple Premium Bread* Telegram service.\n\n` +
                `This Telegram account is not linked to a staff account yet.\n\n` +
                `To link it:\n1. Log in to the app\n2. Go to *Team Chat* → tap the *Telegram* button\n3. Tap *Generate code*\n4. Send the 6-digit code here within ${CODE_TTL_MINUTES} minutes`);
        }
        return;
    }

    const user = await getUser(session.user_id);
    if (!user) {
        await db.query('DELETE FROM telegram_sessions WHERE id = $1', [session.id]);
        await sendTelegramText(chatId, 'Your staff account no longer exists, so this Telegram account has been unlinked.');
        return;
    }

    const lower = text.toLowerCase();
    if (lower === 'logout' || lower === 'unlink') {
        await db.query('DELETE FROM telegram_sessions WHERE id = $1', [session.id]);
        await sendTelegramText(chatId, 'Done — this Telegram account has been unlinked from your account. Send a new login code anytime to link again.');
        return;
    }

    const state = session.session_state || {};

    // "0" / "menu" / "hi" / "/start" → main menu
    if (text === '0' || lower === 'menu' || lower === 'hi' || lower === 'hello' || lower === 'start' || lower === '/start') {
        const options = await buildMenu(user.role);
        await saveState(session.id, { flow: 'menu', options });
        await sendTelegramText(chatId, menuText(user, options));
        return;
    }

    // Dispatch into the active flow
    try {
        await dispatchFlow(chatId, user, session, state, text);
    } catch (e) {
        console.error('Telegram flow error:', e);
        await saveState(session.id, {});
        await sendTelegramText(chatId, 'Sorry, something went wrong while handling that. Send *0* to go back to the menu.');
    }
}

// Link a Telegram account to a user account via the one-time code
async function redeemLoginCode(chatId, code) {
    const r = await db.query(
        `SELECT * FROM telegram_sessions
         WHERE login_code = $1 AND login_code_expires_at > NOW()`, [code]
    );
    if (!r.rows.length) return false;
    const codeRow = r.rows[0];
    const userId = codeRow.user_id;
    if (!userId) return false;

    const user = await getUser(userId);
    if (!user) return false;

    const chatRow = await db.query('SELECT * FROM telegram_sessions WHERE chat_id = $1', [chatId]);

    if (codeRow.chat_id === chatId) {
        await db.query(
            `UPDATE telegram_sessions SET is_authenticated = true, login_code = NULL,
             login_code_expires_at = NULL, session_state = '{}', last_active_at = NOW() WHERE id = $1`, [codeRow.id]);
    } else {
        if (chatRow.rows.length) {
            await db.query('DELETE FROM telegram_sessions WHERE id = $1', [codeRow.id]);
            await db.query(
                `UPDATE telegram_sessions SET user_id = $1, is_authenticated = true, login_code = NULL,
                 login_code_expires_at = NULL, session_state = '{}', last_active_at = NOW() WHERE id = $2`,
                [userId, chatRow.rows[0].id]);
        } else {
            await db.query(
                `UPDATE telegram_sessions SET chat_id = $1, is_authenticated = true, login_code = NULL,
                 login_code_expires_at = NULL, session_state = '{}', last_active_at = NOW() WHERE id = $2`,
                [chatId, codeRow.id]);
        }
    }

    const options = await buildMenu(user.role);
    const session = await getSession(chatId);
    await saveState(session.id, { flow: 'menu', options });
    await sendTelegramText(chatId, `Linked successfully!\n\n` + menuText(user, options));
    return true;
}

// ---------------------------------------------------------------------------
// Menu system — mirrors the app sidebar, filtered by role permissions.
// Top level = sidebar groups; each group opens a numbered sub-menu.
// ---------------------------------------------------------------------------
const MENU_GROUPS = [
    { key: 'dashboard', label: '📊 Dashboard summary', perm: 'dashboard.view' },
    {
        key: 'sub_sales', label: '🛒 Sales', items: [
            { key: 'new_sale', label: 'New sale (record a sale)', perm: 'sales.create' },
            { key: 'sales_summary', label: 'Sales summary (today / week / month)', perm: 'sales.view' },
            { key: 'sales_history', label: 'Sales history — all sales (More pages)', perm: 'sales.view' },
            { key: 'sale_find', label: 'Find a sale by number', perm: 'sales.view' },
            { key: 'returns', label: 'Sales returns (More pages)', perm: 'returns.view' },
            { key: 'exchanges', label: 'Exchanges (More pages)', perm: 'exchanges.view' },
        ]
    },
    {
        key: 'sub_production', label: '🍞 Production & Products', items: [
            { key: 'new_production', label: 'Log production (new batch)', perm: 'production.create' },
            { key: 'production', label: 'Production summary (today / week / month)', perm: 'production.view' },
            { key: 'production_log', label: 'Production history (More pages)', perm: 'production.view' },
            { key: 'products', label: 'Products & prices', perm: 'products.view' },
            { key: 'stock', label: 'Product stock levels (More pages)', perm: 'inventory.view' },
            { key: 'recipes', label: 'Recipes (ingredients per product)', perm: 'recipes.view' },
        ]
    },
    {
        key: 'sub_inventory', label: '📦 Raw Materials & Inventory', items: [
            { key: 'restock', label: 'Restock a raw material', perm: 'raw_materials.create' },
            { key: 'new_waste', label: 'Record waste / damaged stock', perm: 'inventory.create' },
            { key: 'raw_materials', label: 'Raw materials stock (More pages)', perm: 'raw_materials.view' },
            { key: 'materials_low', label: 'Low-stock materials', perm: 'raw_materials.view' },
            { key: 'waste', label: 'Waste stock (More pages)', perm: 'inventory.view' },
            { key: 'branches', label: 'Branches', perm: 'branches.view' },
        ]
    },
    {
        key: 'sub_finance', label: '💰 Finance & Money', items: [
            { key: 'money', label: 'Money accounts & recent movements', perm: 'money.view' },
            { key: 'wallets', label: 'Advance wallets (More pages)', perm: 'wallets.view' },
            { key: 'payment', label: 'Record a payment', perm: 'payments.create' },
            { key: 'pay_salary', label: 'Pay a salary', perm: 'salaries.create' },
            { key: 'expenses', label: 'Expenses (view + record)', perm: 'expenses.view' },
            { key: 'salaries', label: 'Salary payments (More pages)', perm: 'salaries.view' },
            { key: 'loans', label: 'Staff loans outstanding', perm: 'salaries.view' },
            { key: 'reports', label: 'Reports (sales vs expenses)', perm: 'reports.view' },
        ]
    },
    {
        key: 'sub_people', label: '👥 People', items: [
            { key: 'add_customer', label: 'Add a new customer', perm: 'customers.create' },
            { key: 'customers', label: 'Customers & debts', perm: 'customers.view' },
            { key: 'riders', label: 'Riders & balances (More pages)', perm: 'riders.view' },
            { key: 'staff', label: 'Staff list (More pages)', perm: 'staff.view' },
        ]
    },
    {
        key: 'sub_alerts', label: '🔔 Alerts & Approvals', items: [
            { key: 'alerts', label: 'Inventory alerts (More pages)', perm: 'inventory.view' },
            { key: 'approvals', label: 'Pending approvals', perm: 'approvals.view' },
        ]
    },
    { key: 'chat', label: '💬 Team Chat inbox', perm: 'chat.view' },
    { key: 'ai', label: '🤖 Ask the assistant', perm: 'ai_assistant.view' },
];

// Build the top-level menu: keep a group only if the role can use ≥1 item in it
async function buildMenu(role) {
    const out = [];
    for (const g of MENU_GROUPS) {
        if (g.items) {
            const items = [];
            for (const it of g.items) {
                if (await checkPermission(role, it.perm)) items.push(it);
            }
            if (items.length) out.push({ key: g.key, label: g.label, items });
        } else if (await checkPermission(role, g.perm)) {
            out.push({ key: g.key, label: g.label });
        }
    }
    return out;
}

function menuText(user, options) {
    let t = `*Purple Premium Bread* — Telegram\nHello ${esc(user.fullname)} (${esc(user.role)}). What would you like to do?\n`;
    options.forEach((o, i) => { t += `\n${i + 1}. ${o.label}`; });
    t += `\n\nReply with a number. Send *0* anytime to return to this menu, or *logout* to unlink this account.`;
    return t;
}

function subMenuText(title, items) {
    let t = `*${title}*\n`;
    items.forEach((o, i) => { t += `\n${i + 1}. ${o.label}`; });
    t += `\n\n0. Back to menu`;
    return t;
}

// ---------------------------------------------------------------------------
// Paged lists — every long list shows PAGE_SIZE rows and offers:
//   8. ◀ Previous page      9. More ▶      0. Back
// state: { flow:'page', kind, page, extra? }
// ---------------------------------------------------------------------------
const PAGE_SIZE = 10;

async function pageFlow(chatId, user, session, state, text) {
    let page = state.page || 0;
    if (text === '9') page += 1;
    else if (text === '8') page = Math.max(0, page - 1);
    else return sendTelegramText(chatId, 'Reply *9* for more, *8* for previous page, or *0* for the menu.');
    await renderPage(chatId, session, state.kind, page, state.extra || {});
}

async function startPage(chatId, session, kind, extra = {}) {
    await renderPage(chatId, session, kind, 0, extra);
}

async function renderPage(chatId, session, kind, page, extra) {
    const offset = page * PAGE_SIZE;
    const L = PAGE_SIZE + 1; // fetch one extra row to know if "More" exists
    let t = '', hasMore = false;
    const fmtDate = (d) => d ? new Date(d).toLocaleDateString('en-NG') : '';

    if (kind === 'sales_history') {
        const r = await db.query(
            `SELECT st.id, st.total_amount, st.status, st.sale_date,
                    COALESCE(c.fullname, r2.fullname, 'Walk-in') AS party
             FROM sales_transactions st
             LEFT JOIN customers c ON st.customer_id = c.id
             LEFT JOIN riders r2 ON st.rider_id = r2.id
             ORDER BY st.id DESC LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Sales history* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            t += `\n#${x.id} — ${esc(x.party)} — ${money(x.total_amount)} (${esc(x.status || 'n/a')}) ${fmtDate(x.sale_date)}`;
        });
        if (!r.rows.length) t += '\nNo sales on this page.';
    }
    else if (kind === 'returns') {
        const r = await db.query(
            `SELECT sr.id, sr.sale_id, sr.total_amount, sr.refund_method, sr.return_date,
                    COALESCE(c.fullname, r2.fullname, 'Walk-in') AS party
             FROM sales_returns sr
             LEFT JOIN customers c ON sr.customer_id = c.id
             LEFT JOIN riders r2 ON sr.rider_id = r2.id
             ORDER BY sr.id DESC LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Sales returns* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            t += `\n#${x.id} — sale #${x.sale_id} — ${esc(x.party)} — ${money(x.total_amount)} (${esc(x.refund_method || 'n/a')}) ${fmtDate(x.return_date)}`;
        });
        if (!r.rows.length) t += '\nNo returns recorded.';
    }
    else if (kind === 'exchanges') {
        const r = await db.query(
            `SELECT er.id, er.original_sale_id, er.status, er.reason, er.created_at,
                    c.fullname AS customer
             FROM exchange_requests er
             LEFT JOIN customers c ON er.customer_id = c.id
             ORDER BY er.id DESC LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Exchanges* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            t += `\n#${x.id} — sale #${x.original_sale_id} — ${esc(x.customer || 'n/a')} — ${esc(x.status || 'n/a')} ${fmtDate(x.created_at)}`;
        });
        if (!r.rows.length) t += '\nNo exchange requests.';
    }
    else if (kind === 'production_log') {
        const r = await db.query(
            `SELECT pl.id, pl.quantity_produced, pl.waste_quantity, pl.production_date, pl.shift,
                    p.name AS product
             FROM production_logs pl
             LEFT JOIN products p ON pl.product_id = p.id
             ORDER BY pl.id DESC LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Production history* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            t += `\n${esc(x.product || 'Product')} — ${x.quantity_produced} produced${x.waste_quantity ? `, ${x.waste_quantity} waste` : ''} (${esc(x.shift || 'n/a')}) ${fmtDate(x.production_date)}`;
        });
        if (!r.rows.length) t += '\nNo production logged yet.';
    }
    else if (kind === 'stock') {
        const r = await db.query(
            `SELECT p.name, i.quantity, p.min_stock_level
             FROM inventory i JOIN products p ON p.id = i.product_id
             ORDER BY p.name LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Product stock levels* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            const low = Number(x.quantity) <= Number(x.min_stock_level || 0) ? ' ⚠️ LOW' : '';
            t += `\n${esc(x.name)} — ${x.quantity} in stock${low}`;
        });
        if (!r.rows.length) t += '\nNo stock records yet.';
    }
    else if (kind === 'raw_materials') {
        const r = await db.query(
            `SELECT name, unit, current_stock, min_stock_level
             FROM raw_materials ORDER BY name LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Raw materials* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            const low = Number(x.current_stock) <= Number(x.min_stock_level || 0) ? ' ⚠️ LOW' : '';
            t += `\n${esc(x.name)} — ${Number(x.current_stock)} ${esc(x.unit || '')}${low}`;
        });
        if (!r.rows.length) t += '\nNo raw materials recorded.';
    }
    else if (kind === 'waste') {
        const r = await db.query(
            `SELECT w.quantity, w.reason, w.date_recorded, p.name AS product
             FROM waste_stock w LEFT JOIN products p ON w.product_id = p.id
             ORDER BY w.id DESC LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Waste stock* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            t += `\n${esc(x.product || 'Product')} — ${x.quantity} (${esc(x.reason || 'n/a')}) ${fmtDate(x.date_recorded)}`;
        });
        if (!r.rows.length) t += '\nNo waste recorded.';
    }
    else if (kind === 'wallets') {
        const r = await db.query(
            `SELECT fullname, advance_balance, 'Customer' AS kind FROM customers WHERE COALESCE(advance_balance,0) > 0
             UNION ALL
             SELECT fullname, advance_balance, 'Rider' FROM riders WHERE COALESCE(advance_balance,0) > 0
             ORDER BY advance_balance DESC LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Advance wallets* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            t += `\n${esc(x.fullname)} (${x.kind}) — ${money(x.advance_balance)}`;
        });
        if (!r.rows.length) t += '\nNo wallet balances right now.';
    }
    else if (kind === 'salaries') {
        const r = await db.query(
            `SELECT sp.id, sp.salary_period, sp.net_amount, sp.status, sp.payment_date,
                    COALESCE(sm.fullname, u.fullname, 'Staff') AS name
             FROM salary_payments sp
             LEFT JOIN staff_members sm ON sp.staff_member_id = sm.id
             LEFT JOIN users u ON sp.user_id = u.id
             ORDER BY sp.id DESC LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Salary payments* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            t += `\n${esc(x.name)} — ${money(x.net_amount)} (${esc(x.status || 'n/a')}) period ${fmtDate(x.salary_period)}`;
        });
        if (!r.rows.length) t += '\nNo salary payments recorded.';
    }
    else if (kind === 'riders') {
        const r = await db.query(
            `SELECT fullname, phone_number, current_balance
             FROM riders ORDER BY current_balance DESC LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Riders* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            t += `\n${esc(x.fullname)} — holding ${money(x.current_balance)}${x.phone_number ? ' — ' + esc(x.phone_number) : ''}`;
        });
        if (!r.rows.length) t += '\nNo riders found.';
    }
    else if (kind === 'staff') {
        const r = await db.query(
            `SELECT fullname, position, department, is_active
             FROM staff_members ORDER BY fullname LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Staff* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            t += `\n${esc(x.fullname)} — ${esc(x.position || 'n/a')}${x.department ? ' (' + esc(x.department) + ')' : ''}${x.is_active === false ? ' [inactive]' : ''}`;
        });
        if (!r.rows.length) t += '\nNo staff records.';
    }
    else if (kind === 'alerts') {
        const r = await db.query(
            `SELECT alert_type, entity_name, message, status, created_at
             FROM inventory_alerts ORDER BY id DESC LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Inventory alerts* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            t += `\n[${esc(x.status || 'n/a')}] ${esc(x.entity_name || '')}: ${esc((x.message || '').slice(0, 90))} ${fmtDate(x.created_at)}`;
        });
        if (!r.rows.length) t += '\nNo alerts. 🎉';
    }
    else if (kind === 'debtors') {
        const r = await db.query(
            `SELECT fullname, balance FROM customers WHERE balance > 0
             ORDER BY balance DESC LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Customer debts* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach((x, i) => {
            t += `\n${offset + i + 1}. ${esc(x.fullname)} — ${money(x.balance)}`;
        });
        if (!r.rows.length) t += page === 0 ? '\nNo customer owes anything right now. 🎉' : '\nNo more debtors.';
    }
    else if (kind === 'money_tx') {
        const r = await db.query(
            `SELECT direction, amount, category, description, transaction_date
             FROM money_transactions ORDER BY id DESC LIMIT $1 OFFSET $2`, [L, offset]);
        hasMore = r.rows.length > PAGE_SIZE;
        t = `*Money movements* — page ${page + 1}\n`;
        r.rows.slice(0, PAGE_SIZE).forEach(x => {
            const sign = x.direction === 'IN' ? '➕' : '➖';
            t += `\n${sign} ${money(x.amount)} — ${esc(x.category || 'n/a')} — ${esc((x.description || '').slice(0, 60))} ${fmtDate(x.transaction_date)}`;
        });
        if (!r.rows.length) t += '\nNo money movements recorded.';
    }
    else {
        await saveState(session.id, {});
        return sendTelegramText(chatId, 'Unknown list. Send *0* for the menu.');
    }

    t += `\n`;
    if (page > 0) t += `\n8. ◀ Previous page`;
    if (hasMore) t += `\n9. More ▶`;
    t += `\n0. Back to menu`;
    await saveState(session.id, { flow: 'page', kind, page, extra });
    await sendTelegramText(chatId, t);
}

// ---------------------------------------------------------------------------
// Flow dispatcher
// ---------------------------------------------------------------------------
async function dispatchFlow(chatId, user, session, state, text) {
    const flow = state.flow || 'menu';

    if (flow === 'menu') {
        const idx = parseInt(text, 10);
        const options = state.options || [];
        if (isNaN(idx) || idx < 1 || idx > options.length) {
            await sendTelegramText(chatId, 'Please reply with one of the menu numbers, or *0* to see the menu again.');
            return;
        }
        const choice = options[idx - 1];
        if (choice.items) {
            // Open the sub-menu
            await saveState(session.id, { flow: 'sub', group: choice.label, options: choice.items });
            await sendTelegramText(chatId, subMenuText(choice.label.replace(/^[^\s]+\s/, ''), choice.items));
            return;
        }
        await startFlow(chatId, user, session, choice.key);
        return;
    }

    if (flow === 'sub') {
        const idx = parseInt(text, 10);
        const options = state.options || [];
        if (isNaN(idx) || idx < 1 || idx > options.length) {
            await sendTelegramText(chatId, `Reply 1-${options.length}, or *0* for the main menu.`);
            return;
        }
        await startFlow(chatId, user, session, options[idx - 1].key);
        return;
    }

    switch (flow) {
        case 'page': return pageFlow(chatId, user, session, state, text);
        case 'money_menu': {
            if (text === '1') return startPage(chatId, session, 'money_tx');
            return sendTelegramText(chatId, 'Reply 1 for recent money movements, or 0 for the menu.');
        }
        case 'sales': return salesFlow(chatId, user, session, state, text);
        case 'production': return productionFlow(chatId, user, session, state, text);
        case 'products': return productsFlow(chatId, user, session, state, text);
        case 'customers': return customersFlow(chatId, user, session, state, text);
        case 'payment': return paymentFlow(chatId, user, session, state, text);
        case 'newsale': return newSaleFlow(chatId, user, session, state, text);
        case 'newprod': return newProductionFlow(chatId, user, session, state, text);
        case 'wasteadd': return wasteAddFlow(chatId, user, session, state, text);
        case 'restock': return restockFlow(chatId, user, session, state, text);
        case 'addcust': return addCustomerFlow(chatId, user, session, state, text);
        case 'salarypay': return salaryPayFlow(chatId, user, session, state, text);
        case 'expenses': return expensesFlow(chatId, user, session, state, text);
        case 'reports': return reportsFlow(chatId, user, session, state, text);
        case 'ai': return aiFlow(chatId, user, session, state, text);
        default: {
            const options = await buildMenu(user.role);
            await saveState(session.id, { flow: 'menu', options });
            await sendTelegramText(chatId, menuText(user, options));
        }
    }
}

async function startFlow(chatId, user, session, key) {
    switch (key) {
        case 'dashboard': return dashboardFlow(chatId, user, session);

        // ---- Sales ----
        case 'new_sale': {
            await saveState(session.id, { flow: 'newsale', step: 'party', data: { items: [] } });
            return sendTelegramText(chatId,
                `*New sale*\nWho is buying?\n1. Walk-in customer\n2. Registered customer\n3. Rider sale\n\n0. Cancel`);
        }
        case 'sales_summary': {
            await saveState(session.id, { flow: 'sales', step: 'menu' });
            return sendTelegramText(chatId,
                `*Sales summary*\n1. Today\n2. This week\n3. This month\n\n0. Back to menu`);
        }
        case 'sales_history': return startPage(chatId, session, 'sales_history');
        case 'sale_find': {
            await saveState(session.id, { flow: 'sales', step: 'find' });
            return sendTelegramText(chatId, 'Type the sale number (e.g. 125):\n\n0. Back to menu');
        }
        case 'returns': return startPage(chatId, session, 'returns');
        case 'exchanges': return startPage(chatId, session, 'exchanges');

        // ---- Production & products ----
        case 'new_production': {
            await saveState(session.id, { flow: 'newprod', step: 'product_search', data: { batches: [] } });
            return sendTelegramText(chatId,
                `*Log production*\nType part of the product name that was produced:\n\n0. Cancel`);
        }
        case 'production': {
            await saveState(session.id, { flow: 'production', step: 'menu' });
            return sendTelegramText(chatId,
                `*Production summary*\n1. Today\n2. This week\n3. This month\n\n0. Back to menu`);
        }
        case 'production_log': return startPage(chatId, session, 'production_log');
        case 'products': {
            await saveState(session.id, { flow: 'products', step: 'menu' });
            return sendTelegramText(chatId,
                `*Products & prices*\n1. Search a product\n2. All products (prices)\n3. Low-stock products\n\n0. Back to menu`);
        }
        case 'stock': return startPage(chatId, session, 'stock');
        case 'recipes': {
            const r = await db.query(
                `SELECT p.name AS product, rm.name AS material, rm.unit, r.quantity_required
                 FROM recipes r
                 LEFT JOIN products p ON p.id = r.product_id
                 LEFT JOIN raw_materials rm ON rm.id = r.raw_material_id
                 ORDER BY p.name, rm.name LIMIT 60`);
            let t = `*Recipes*\n`;
            if (!r.rows.length) t += 'No recipes defined yet.';
            let cur = null;
            for (const x of r.rows) {
                if (x.product !== cur) { cur = x.product; t += `\n*${esc(cur || 'Product')}*:`; }
                t += `\n  - ${esc(x.material || '?')} ${Number(x.quantity_required)} ${esc(x.unit || '')}`;
            }
            t += `\n\n0. Back to menu`;
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, t);
        }

        // ---- Raw materials & inventory ----
        case 'restock': {
            await saveState(session.id, { flow: 'restock', step: 'mat_search', data: {} });
            return sendTelegramText(chatId,
                `*Restock a raw material*\nType part of the material name:\n\n0. Cancel`);
        }
        case 'new_waste': {
            await saveState(session.id, { flow: 'wasteadd', step: 'product_search', data: {} });
            return sendTelegramText(chatId,
                `*Record waste / damaged stock*\nType part of the product name:\n\n0. Cancel`);
        }
        case 'raw_materials': return startPage(chatId, session, 'raw_materials');
        case 'materials_low': {
            const r = await db.query(
                `SELECT name, unit, current_stock, min_stock_level FROM raw_materials
                 WHERE COALESCE(current_stock,0) <= COALESCE(min_stock_level,0)
                 ORDER BY current_stock ASC LIMIT 25`);
            let t = `*Low-stock raw materials*\n`;
            if (!r.rows.length) t += 'Nothing is below its minimum level. 🎉';
            r.rows.forEach(x => { t += `\n⚠️ ${esc(x.name)} — ${Number(x.current_stock)} ${esc(x.unit || '')} (min ${Number(x.min_stock_level)})`; });
            t += `\n\n0. Back to menu`;
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, t);
        }
        case 'waste': return startPage(chatId, session, 'waste');
        case 'branches': {
            const r = await db.query(`SELECT name, contact_person, phone, address FROM branches ORDER BY name LIMIT 25`);
            let t = `*Branches*\n`;
            if (!r.rows.length) t += 'No branches recorded.';
            r.rows.forEach(x => {
                t += `\n*${esc(x.name)}*${x.contact_person ? ' — ' + esc(x.contact_person) : ''}${x.phone ? ' (' + esc(x.phone) + ')' : ''}`;
            });
            t += `\n\n0. Back to menu`;
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, t);
        }

        // ---- Finance ----
        case 'money': {
            const acc = await db.query(
                `SELECT name, account_type, current_balance FROM money_accounts WHERE is_active = true ORDER BY name LIMIT 20`);
            let t = `*Money accounts*\n`;
            if (!acc.rows.length) t += 'No money accounts set up yet.';
            let total = 0;
            acc.rows.forEach(x => {
                total += Number(x.current_balance || 0);
                t += `\n${esc(x.name)} (${esc(x.account_type || 'n/a')}) — ${money(x.current_balance)}`;
            });
            if (acc.rows.length) t += `\n\nTotal across accounts: ${money(total)}`;
            t += `\n\n1. See recent money movements\n\n0. Back to menu`;
            await saveState(session.id, { flow: 'money_menu' });
            return sendTelegramText(chatId, t);
        }
        case 'wallets': return startPage(chatId, session, 'wallets');
        case 'payment': {
            await saveState(session.id, { flow: 'payment', step: 'party', data: {} });
            return sendTelegramText(chatId,
                `*Record a payment*\nWho is paying?\n1. Customer (debt settlement, oldest sales first)\n2. Rider (remittance)\n\n0. Cancel`);
        }
        case 'expenses': {
            const canCreate = await checkPermission(user.role, 'expenses.create');
            await saveState(session.id, { flow: 'expenses', step: 'menu', data: { canCreate } });
            let t = `*Expenses*\n1. Today\n2. This week\n3. This month`;
            if (canCreate) t += `\n4. Record a new expense`;
            t += `\n\n0. Back to menu`;
            return sendTelegramText(chatId, t);
        }
        case 'pay_salary': {
            const rows = await salaryStaffList('');
            if (!rows.length) {
                await saveState(session.id, { flow: 'menu-done' });
                return sendTelegramText(chatId, 'No staff have a salary set up yet — set salaries in the app first (Salary Management).\n\n0. Back to menu');
            }
            await saveState(session.id, { flow: 'salarypay', step: 'staff', data: { matches: rows } });
            let t = '*Pay a salary*\nPick the staff member (number), or type a name to search:\n';
            rows.forEach((m, i) => { t += `\n${i + 1}. ${esc(m.name)} (${esc(m.sub)}) — net ${money(parseFloat(m.base) + parseFloat(m.allowances) - parseFloat(m.deductions))}`; });
            t += `\n\n0. Cancel`;
            return sendTelegramText(chatId, t);
        }
        case 'salaries': return startPage(chatId, session, 'salaries');
        case 'loans': {
            const r = await db.query(
                `SELECT COALESCE(sm.fullname, u.fullname, 'Staff') AS name,
                        l.amount, COALESCE(l.remaining_balance, l.amount) AS remaining,
                        l.monthly_deduction, l.status, l.is_paid
                 FROM staff_loans l
                 LEFT JOIN staff_members sm ON l.staff_member_id = sm.id
                 LEFT JOIN users u ON l.user_id = u.id
                 WHERE l.is_paid = false OR COALESCE(l.remaining_balance, 1) > 0
                 ORDER BY remaining DESC LIMIT 25`);
            let t = `*Staff loans outstanding*\n`;
            if (!r.rows.length) t += 'No outstanding loans. 🎉';
            let total = 0;
            r.rows.forEach(x => {
                total += Number(x.remaining || 0);
                t += `\n${esc(x.name)} — owes ${money(x.remaining)} of ${money(x.amount)}${x.monthly_deduction ? ` (${money(x.monthly_deduction)}/month)` : ''}`;
            });
            if (r.rows.length) t += `\n\nTotal outstanding: ${money(total)}`;
            t += `\n\n0. Back to menu`;
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, t);
        }
        case 'reports': {
            await saveState(session.id, { flow: 'reports', step: 'menu' });
            return sendTelegramText(chatId,
                `*Reports*\n1. Today\n2. This week\n3. This month\n\n0. Back to menu`);
        }

        // ---- People ----
        case 'add_customer': {
            await saveState(session.id, { flow: 'addcust', step: 'name', data: {} });
            return sendTelegramText(chatId,
                `*Add a new customer*\nType the customer full name:\n\n0. Cancel`);
        }
        case 'customers': {
            await saveState(session.id, { flow: 'customers', step: 'menu' });
            return sendTelegramText(chatId,
                `*Customers & debts*\n1. Customer debts (all pages)\n2. Search a customer\n3. Customer count\n\n0. Back to menu`);
        }
        case 'riders': return startPage(chatId, session, 'riders');
        case 'staff': return startPage(chatId, session, 'staff');

        // ---- Alerts & approvals ----
        case 'alerts': return startPage(chatId, session, 'alerts');
        case 'approvals': {
            const r = await db.query(
                `SELECT a.id, a.request_type, a.title, a.amount, a.created_at, u.fullname AS requester
                 FROM approval_requests a LEFT JOIN users u ON a.requested_by = u.id
                 WHERE LOWER(a.status) = 'pending'
                 ORDER BY a.id DESC LIMIT 20`);
            let t = `*Pending approvals*\n`;
            if (!r.rows.length) t += 'Nothing is waiting for approval. 🎉';
            r.rows.forEach(x => {
                t += `\n#${x.id} — ${esc(x.title || x.request_type)}${x.amount ? ' — ' + money(x.amount) : ''} (by ${esc(x.requester || 'n/a')})`;
            });
            t += `\n\nApproving / rejecting is done in the app → Approvals.\n\n0. Back to menu`;
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, t);
        }

        // ---- Communication ----
        case 'chat': return chatInboxFlow(chatId, user, session);
        case 'ai': {
            await saveState(session.id, { flow: 'ai' });
            return sendTelegramText(chatId,
                `*Assistant*\nAsk me quick questions like:\n- "sales today"\n- "expenses this month"\n- "who owes us?"\n- "payments this week"\n\nFor deeper analysis, use the AI Assistant page in the app.\n\n0. Back to menu`);
        }
        default: {
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Unknown option. Send *0* for the menu.');
        }
    }
}

// ---------------------------------------------------------------------------
// Read-only flows
// ---------------------------------------------------------------------------
async function dashboardFlow(chatId, user, session) {
    const [s, p, e] = await Promise.all([salesSummary('today'), paymentsSummary('today'), expensesSummary('today')]);
    const debt = await db.query(
        `SELECT COUNT(*) AS n, COALESCE(SUM(balance),0) AS total FROM customers WHERE balance > 0`);
    const riderDebt = await db.query(
        `SELECT COALESCE(SUM(current_balance),0) AS total FROM riders WHERE current_balance > 0`);
    const net = parseFloat(p.total) - parseFloat(e.total);

    let t = `*Dashboard — Today*\n`;
    t += `\nSales: ${money(s.total)} (${s.n} sale${Number(s.n) === 1 ? '' : 's'})`;
    t += `\nPayments received: ${money(p.total)} (${p.n})`;
    t += `\nExpenses: ${money(e.total)} (${e.n})`;
    t += `\nCash in minus expenses: ${money(net)}`;
    t += `\n\nCustomers owing: ${debt.rows[0].n} (${money(debt.rows[0].total)})`;
    t += `\nRiders holding: ${money(riderDebt.rows[0].total)}`;
    t += `\n\n0. Back to menu`;
    await saveState(session.id, { flow: 'menu-done' });
    await sendTelegramText(chatId, t);
}

async function salesFlow(chatId, user, session, state, text) {
    if (state.step === 'menu') {
        const period = { '1': 'today', '2': 'week', '3': 'month' }[text];
        if (!period) return sendTelegramText(chatId, 'Reply 1, 2 or 3 — or 0 for the menu.');
        const s = await salesSummary(period);
        const rows = await db.query(
            `SELECT st.id, st.total_amount, st.status, COALESCE(c.fullname, r2.fullname, 'Walk-in') AS party
             FROM sales_transactions st
             LEFT JOIN customers c ON st.customer_id = c.id
             LEFT JOIN riders r2 ON st.rider_id = r2.id
             WHERE ${periodWhere('st.sale_date', period)}
             ORDER BY st.id DESC LIMIT 10`);
        let t = `*Sales — ${PERIOD_LABEL[period]}*\nTotal: ${money(s.total)} across ${s.n} sale(s)`;
        t += `\nUnpaid balance on them: ${money(s.credit)}\n`;
        rows.rows.forEach(r => { t += `\n#${r.id} — ${esc(r.party)} — ${money(r.total_amount)} (${esc(r.status || 'n/a')})`; });
        t += `\n\nFor the full list use Sales → Sales history.\n\n0. Back to menu`;
        await saveState(session.id, { flow: 'menu-done' });
        return sendTelegramText(chatId, t);
    }
    if (state.step === 'find') {
        const id = parseInt(text, 10);
        if (isNaN(id)) return sendTelegramText(chatId, 'Please type a valid sale number, or 0 for the menu.');
        const r = await db.query(
            `SELECT st.id, st.total_amount, st.amount_paid, st.balance_due, st.status, st.payment_method,
                    st.sale_date, COALESCE(c.fullname, r2.fullname, 'Walk-in') AS party
             FROM sales_transactions st
             LEFT JOIN customers c ON st.customer_id = c.id
             LEFT JOIN riders r2 ON st.rider_id = r2.id
             WHERE st.id = $1`, [id]);
        if (!r.rows.length) {
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, `No sale found with number ${id}.\n\n0. Back to menu`);
        }
        const s = r.rows[0];
        const items = await db.query(
            `SELECT si.quantity, si.price_at_sale, p.name FROM sales_items si
             LEFT JOIN products p ON si.product_id = p.id WHERE si.sale_id = $1`, [id]);
        let t = `*Sale #${s.id}*\n${esc(s.party)}\nDate: ${new Date(s.sale_date).toLocaleDateString('en-NG')}`;
        if (items.rows.length) {
            t += `\nItems:`;
            items.rows.forEach(x => { t += `\n  - ${esc(x.name || 'Product')} x${x.quantity} @ ${money(x.price_at_sale)}`; });
        }
        t += `\nTotal: ${money(s.total_amount)}\nPaid: ${money(s.amount_paid)}\nBalance: ${money(s.balance_due)}`;
        t += `\nMethod: ${esc(s.payment_method || 'n/a')} — Status: ${esc(s.status || 'n/a')}`;
        t += `\n\n0. Back to menu`;
        await saveState(session.id, { flow: 'menu-done' });
        return sendTelegramText(chatId, t);
    }
}

async function productionFlow(chatId, user, session, state, text) {
    const period = { '1': 'today', '2': 'week', '3': 'month' }[text];
    if (!period) return sendTelegramText(chatId, 'Reply 1, 2 or 3 — or 0 for the menu.');
    const sum = await db.query(
        `SELECT COALESCE(SUM(quantity_produced),0) AS produced, COALESCE(SUM(waste_quantity),0) AS waste, COUNT(*) AS batches
         FROM production_logs WHERE ${periodWhere('production_date', period)}`);
    const top = await db.query(
        `SELECT p.name, SUM(pl.quantity_produced) AS qty
         FROM production_logs pl LEFT JOIN products p ON pl.product_id = p.id
         WHERE ${periodWhere('pl.production_date', period)}
         GROUP BY p.name ORDER BY qty DESC LIMIT 10`);
    const s = sum.rows[0];
    let t = `*Production — ${PERIOD_LABEL[period]}*\n`;
    t += `Produced: ${s.produced} units across ${s.batches} batch(es)`;
    t += `\nWaste: ${s.waste} units\n`;
    top.rows.forEach(x => { t += `\n- ${esc(x.name || 'Product')}: ${x.qty}`; });
    t += `\n\nFor the full log use Production → Production history.\n\n0. Back to menu`;
    await saveState(session.id, { flow: 'menu-done' });
    await sendTelegramText(chatId, t);
}

async function customersFlow(chatId, user, session, state, text) {
    if (state.step === 'menu') {
        if (text === '1') return startPage(chatId, session, 'debtors');
        if (text === '2') {
            await saveState(session.id, { flow: 'customers', step: 'search' });
            return sendTelegramText(chatId, 'Type part of the customer name:\n\n0. Back to menu');
        }
        if (text === '3') {
            const r = await db.query('SELECT COUNT(*) AS n FROM customers');
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, `*Customers:* ${r.rows[0].n} registered.\n\n0. Back to menu`);
        }
        return sendTelegramText(chatId, 'Reply 1, 2 or 3 — or 0 for the menu.');
    }
    if (state.step === 'search') {
        const r = await db.query(
            `SELECT id, fullname, phone, balance FROM customers WHERE fullname ILIKE $1 ORDER BY fullname LIMIT 5`,
            [`%${text}%`]);
        if (!r.rows.length) {
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, `No customer matching "${esc(text)}".\n\n0. Back to menu`);
        }
        let t = '';
        for (const c of r.rows) {
            const out = await db.query(
                `SELECT COUNT(*) AS n, COALESCE(SUM(balance_due),0) AS due FROM sales_transactions
                 WHERE customer_id = $1 AND balance_due > 0`, [c.id]);
            t += `\n*${esc(c.fullname)}*${c.phone ? ' (' + esc(c.phone) + ')' : ''}\nDebt balance: ${money(c.balance)} across ${out.rows[0].n} unpaid sale(s) (${money(out.rows[0].due)})\n`;
        }
        t += `\n0. Back to menu`;
        await saveState(session.id, { flow: 'menu-done' });
        return sendTelegramText(chatId, t.trim());
    }
}

async function productsFlow(chatId, user, session, state, text) {
    if (state.step === 'menu') {
        if (text === '1') {
            await saveState(session.id, { flow: 'products', step: 'search' });
            return sendTelegramText(chatId, 'Type part of a product name:\n\n0. Back to menu');
        }
        if (text === '2') {
            const r = await db.query(`SELECT name, price, category FROM products ORDER BY name LIMIT 40`);
            let t = `*Products & prices*\n`;
            if (!r.rows.length) t += 'No products yet.';
            r.rows.forEach(p => { t += `\n- ${esc(p.name)} — ${money(p.price)}${p.category ? ' (' + esc(p.category) + ')' : ''}`; });
            t += `\n\n0. Back to menu`;
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, t);
        }
        if (text === '3') {
            const r = await db.query(
                `SELECT p.name, i.quantity, p.min_stock_level
                 FROM inventory i JOIN products p ON p.id = i.product_id
                 WHERE COALESCE(i.quantity,0) <= COALESCE(p.min_stock_level,0)
                 ORDER BY i.quantity ASC LIMIT 25`);
            let t = `*Low-stock products*\n`;
            if (!r.rows.length) t += 'No product is below its minimum level. 🎉';
            r.rows.forEach(x => { t += `\n⚠️ ${esc(x.name)} — ${x.quantity} left (min ${Number(x.min_stock_level)})`; });
            t += `\n\n0. Back to menu`;
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, t);
        }
        return sendTelegramText(chatId, 'Reply 1, 2 or 3 — or 0 for the menu.');
    }
    if (state.step === 'search') {
        const r = await db.query(
            `SELECT name, price, category FROM products WHERE name ILIKE $1 ORDER BY name LIMIT 10`,
            [`%${text}%`]);
        let t;
        if (!r.rows.length) {
            t = `No product matching "${esc(text)}".`;
        } else {
            t = `*Products matching "${esc(text)}"*\n`;
            r.rows.forEach(p => { t += `\n- ${esc(p.name)} — ${money(p.price)}${p.category ? ' (' + esc(p.category) + ')' : ''}`; });
        }
        t += `\n\nType another name to search again, or 0 for the menu.`;
        await saveState(session.id, { flow: 'products', step: 'search' });
        await sendTelegramText(chatId, t);
    }
}
async function chatInboxFlow(chatId, user, session) {
    const unread = await db.query(
        `SELECT COUNT(*) AS n FROM chat_messages m
         JOIN chat_participants p ON p.conversation_id = m.conversation_id
         WHERE p.user_id = $1 AND m.sender_id <> $1 AND m.is_deleted = false
           AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)`, [user.id]);
    const latest = await db.query(
        `SELECT m.message_text, m.created_at, u.fullname AS sender,
                COALESCE(cv.name, du.fullname, 'Chat') AS convo
         FROM chat_messages m
         JOIN chat_participants p ON p.conversation_id = m.conversation_id AND p.user_id = $1
         JOIN chat_conversations cv ON cv.id = m.conversation_id
         LEFT JOIN users u ON u.id = m.sender_id
         LEFT JOIN chat_participants dp ON dp.conversation_id = cv.id AND dp.user_id <> $1 AND cv.type = 'direct'
         LEFT JOIN users du ON du.id = dp.user_id
         WHERE m.is_deleted = false
         ORDER BY m.id DESC LIMIT 5`, [user.id]);
    let t = `*Team Chat inbox*\nUnread messages: ${unread.rows[0].n}\n`;
    if (latest.rows.length) {
        t += `\nLatest:\n`;
        for (const m of latest.rows.reverse()) {
            const body = (m.message_text || '[record reference]').slice(0, 80);
            t += `\n[${esc(String(m.convo || 'Chat').slice(0, 30))}] ${esc(m.sender)}: ${esc(body)}`;
        }
    }
    t += `\n\nOpen the app → Team Chat to reply.\n\n0. Back to menu`;
    await saveState(session.id, { flow: 'menu-done' });
    await sendTelegramText(chatId, t);
}
async function aiFlow(chatId, user, session, state, text) {
    const q = text.toLowerCase();
    let answer = null;
    if (/\b(sale|sales|sold|revenue)\b/.test(q)) {
        const period = q.includes('week') ? 'week' : q.includes('month') ? 'month' : 'today';
        const s = await salesSummary(period);
        answer = `Sales ${PERIOD_LABEL[period].toLowerCase()}: ${money(s.total)} across ${s.n} sale(s). Open credit on them: ${money(s.credit)}.`;
    } else if (/\b(expense|expenses|spending|spent)\b/.test(q)) {
        const period = q.includes('today') ? 'today' : q.includes('week') ? 'week' : 'month';
        const e = await expensesSummary(period);
        answer = `Expenses ${PERIOD_LABEL[period].toLowerCase()}: ${money(e.total)} across ${e.n} record(s).`;
    } else if (/\b(owe|owes|owing|debt|debtor|credit)\b/.test(q)) {
        const d = await db.query(`SELECT COUNT(*) AS n, COALESCE(SUM(balance),0) AS total FROM customers WHERE balance > 0`);
        const top = await db.query(`SELECT fullname, balance FROM customers WHERE balance > 0 ORDER BY balance DESC LIMIT 5`);
        answer = `${d.rows[0].n} customer(s) owe a total of ${money(d.rows[0].total)}.`;
        if (top.rows.length) {
            answer += ' Top: ' + top.rows.map(x => `${esc(x.fullname)} ${money(x.balance)}`).join(', ') + '.';
        }
    } else if (/\b(payment|payments|collected|collection)\b/.test(q)) {
        const period = q.includes('today') ? 'today' : q.includes('month') ? 'month' : 'week';
        const p = await paymentsSummary(period);
        answer = `Payments collected ${PERIOD_LABEL[period].toLowerCase()}: ${money(p.total)} across ${p.n} payment(s).`;
    } else if (/\b(price|product|bread)\b/.test(q)) {
        const r = await db.query(`SELECT name, price FROM products ORDER BY name LIMIT 10`);
        answer = 'Products: ' + r.rows.map(x => `${esc(x.name)} ${money(x.price)}`).join(', ') + (r.rows.length === 10 ? '…' : '.');
    }
    if (!answer) {
        answer = `I can answer quick stats about *sales*, *expenses*, *debts* and *payments*. For deeper questions, use the AI Assistant page in the app.`;
    }
    await sendTelegramText(chatId, answer + `\n\nAsk another, or 0 for the menu.`);
}
// ---------------------------------------------------------------------------
// Payment flow — same oldest-first allocation logic as the app
// ---------------------------------------------------------------------------
const PAYMENT_METHODS = ['Cash', 'Bank Transfer', 'POS'];

async function paymentFlow(chatId, user, session, state, text) {
    const data = state.data || {};

    if (state.step === 'party') {
        if (text !== '1' && text !== '2') return sendTelegramText(chatId, 'Reply 1 for Customer or 2 for Rider — or 0 to cancel.');
        data.isRider = text === '2';
        await saveState(session.id, { flow: 'payment', step: 'search', data });
        return sendTelegramText(chatId, `Type part of the ${data.isRider ? 'rider' : 'customer'} name:\n\n0. Cancel`);
    }

    if (state.step === 'search') {
        const r = data.isRider
            ? await db.query(`SELECT id, fullname, current_balance AS bal FROM riders WHERE fullname ILIKE $1 ORDER BY fullname LIMIT 8`, [`%${text}%`])
            : await db.query(`SELECT id, fullname, balance AS bal FROM customers WHERE fullname ILIKE $1 ORDER BY fullname LIMIT 8`, [`%${text}%`]);
        if (!r.rows.length) return sendTelegramText(chatId, `No match for "${esc(text)}". Type another name, or 0 to cancel.`);
        data.matches = r.rows;
        await saveState(session.id, { flow: 'payment', step: 'pick', data });
        let t = 'Pick one:\n';
        r.rows.forEach((m, i) => { t += `\n${i + 1}. ${esc(m.fullname)} — owes ${money(m.bal)}`; });
        t += `\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'pick') {
        const idx = parseInt(text, 10);
        if (isNaN(idx) || idx < 1 || idx > (data.matches || []).length) {
            return sendTelegramText(chatId, `Reply with a number 1-${(data.matches || []).length}, or 0 to cancel.`);
        }
        data.owner = data.matches[idx - 1];
        delete data.matches;
        await saveState(session.id, { flow: 'payment', step: 'amount', data });
        return sendTelegramText(chatId,
            `*${esc(data.owner.fullname)}* currently owes ${money(data.owner.bal)}.\nHow much are they paying? (numbers only, e.g. 5000)\n\n0. Cancel`);
    }

    if (state.step === 'amount') {
        const amount = num(text);
        if (!amount || amount <= 0) return sendTelegramText(chatId, 'Please type a valid amount (e.g. 5000), or 0 to cancel.');
        data.amount = amount;
        await saveState(session.id, { flow: 'payment', step: 'method', data });
        let t = `Amount: ${money(amount)}\nPayment method?\n`;
        PAYMENT_METHODS.forEach((m, i) => { t += `\n${i + 1}. ${m}`; });
        t += `\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'method') {
        const idx = parseInt(text, 10);
        if (isNaN(idx) || idx < 1 || idx > PAYMENT_METHODS.length) {
            return sendTelegramText(chatId, `Reply 1-${PAYMENT_METHODS.length}, or 0 to cancel.`);
        }
        data.method = PAYMENT_METHODS[idx - 1];
        await saveState(session.id, { flow: 'payment', step: 'receipt', data });
        return sendTelegramText(chatId, `Method: ${data.method}\n` + RECEIPT_PROMPT);
    }

    if (state.step === 'receipt') {
        const r = readReceiptAnswer(chatId, text);
        data.receiptUrl = r.url;
        data.reference = r.reference;
        await saveState(session.id, { flow: 'payment', step: 'confirm', data });
        return sendTelegramText(chatId,
            `*Confirm payment*\nFrom: ${esc(data.owner.fullname)} (${data.isRider ? 'Rider' : 'Customer'})\nAmount: ${money(data.amount)}\nMethod: ${data.method}${data.reference ? `\nReference: ${esc(data.reference)}` : ''}${data.receiptUrl ? '\nReceipt photo: attached ✅' : ''}\nRecorded by: ${esc(user.fullname)}\n\nIt will clear their oldest unpaid sales first. Any extra goes to their advance wallet.\n\n1. Confirm\n2. Cancel`);
    }

    if (state.step === 'confirm') {
        if (text !== '1') {
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Payment cancelled. Send *0* for the menu.');
        }
        const result = await allocatePayment(data, user.id);
        await saveState(session.id, {});
        return sendTelegramText(chatId, result + `\n\n0. Back to menu`);
    }
}

// Same rules as routes/payments.js POST /allocate — kept in one transaction.
async function allocatePayment(data, userId) {
    const isRider = !!data.isRider;
    const ownerId = data.owner.id;
    const payAmount = data.amount;
    const method = data.method || 'Cash';
    const ownerTable = isRider ? 'riders' : 'customers';

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const ownerRes = await client.query(`SELECT id FROM ${ownerTable} WHERE id = $1 FOR UPDATE`, [ownerId]);
        if (!ownerRes.rows.length) {
            await client.query('ROLLBACK');
            return 'That record no longer exists — payment NOT recorded.';
        }

        const salesQuery = isRider
            ? `SELECT id, balance_due, payment_method FROM sales_transactions
               WHERE rider_id = $1 AND is_rider_sale = true AND balance_due > 0
               ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC FOR UPDATE`
            : `SELECT id, balance_due FROM sales_transactions
               WHERE customer_id = $1 AND balance_due > 0
               ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC FOR UPDATE`;
        const sales = await client.query(salesQuery, [ownerId]);

        let remaining = payAmount;
        const allocations = [];
        for (const sale of sales.rows) {
            if (remaining <= 0) break;
            const due = parseFloat(sale.balance_due);
            const pay = Math.min(remaining, due);
            if (pay <= 0) continue;

            await client.query(
                `INSERT INTO payments (transaction_id, customer_id, rider_id, amount, payment_date, payment_method, is_rider_payment, payment_reference, receipt_image_url)
                 VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6, $7, $8) RETURNING id`,
                [sale.id, isRider ? null : ownerId, isRider ? ownerId : null, pay, method, isRider,
                 data.reference || null, data.receiptUrl || null]
            );
            await client.query(
                `UPDATE sales_transactions
                 SET amount_paid = amount_paid + $1, balance_due = balance_due - $1,
                     status = CASE WHEN balance_due - $1 <= 0 THEN 'Paid' ELSE 'Partially Paid' END,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE id = $2`, [pay, sale.id]);
            if (isRider && sale.payment_method === 'Credit') {
                await client.query(
                    `UPDATE customers c SET balance = balance - $1
                     FROM sales_transactions s WHERE s.id = $2 AND c.id = s.customer_id`, [pay, sale.id]);
            }
            allocations.push({ sale_id: sale.id, allocated: pay });
            remaining -= pay;
        }

        const allocatedTotal = Math.round((payAmount - remaining) * 100) / 100;
        if (allocatedTotal > 0) {
            await client.query(
                isRider
                    ? 'UPDATE riders SET current_balance = current_balance - $1 WHERE id = $2'
                    : 'UPDATE customers SET balance = balance - $1 WHERE id = $2',
                [allocatedTotal, ownerId]);
        }

        // Leftover → advance wallet (only if migration 002 columns exist)
        let walletCredit = 0;
        if (remaining > 0.004) {
            const w = await client.query(
                `SELECT COUNT(*) AS n FROM information_schema.columns
                 WHERE table_name = $1 AND column_name = 'advance_balance'`, [ownerTable]);
            if (Number(w.rows[0].n) > 0) {
                walletCredit = Math.round(remaining * 100) / 100;
                await client.query(
                    `UPDATE ${ownerTable} SET advance_balance = COALESCE(advance_balance, 0) + $1 WHERE id = $2`,
                    [walletCredit, ownerId]);
                try {
                    await client.query(
                        `INSERT INTO wallet_transactions (owner_type, owner_id, transaction_type, amount, balance_after, reference_type, notes, created_by)
                         SELECT $1, $2, 'DEPOSIT', $3, advance_balance, 'telegram_payment', 'Overpayment via Telegram credited to advance wallet', $4
                         FROM ${ownerTable} WHERE id = $2`,
                        [isRider ? 'RIDER' : 'CUSTOMER', ownerId, walletCredit, userId]);
                } catch (e) { /* wallet_transactions missing → balance already updated, skip log */ }
            } else {
                await client.query('ROLLBACK');
                return `Payment exceeds the total debt (${money(allocatedTotal)} available) and advance wallets are not set up yet. Payment NOT recorded — try a smaller amount.`;
            }
        }

        await client.query('COMMIT');

        // Money Management mirror (fail-open, same as the app)
        if (allocatedTotal > 0) {
            await recordMoneyTransaction({
                direction: 'IN', amount: allocatedTotal, category: 'debt_payment', payment_method: method,
                reference_type: 'payment_allocation', reference_id: null,
                description: `${isRider ? 'Rider' : 'Customer'} debt settlement via Telegram across ${allocations.length} sale(s)`,
                transaction_date: null, recorded_by: userId
            });
        }
        if (walletCredit > 0) {
            await recordMoneyTransaction({
                direction: 'IN', amount: walletCredit, category: isRider ? 'rider_deposit' : 'customer_deposit',
                payment_method: method, reference_type: 'payment_allocation', reference_id: null,
                description: 'Advance wallet top-up from Telegram overpayment', transaction_date: null, recorded_by: userId
            });
        }

        let t = `Payment of ${money(payAmount)} recorded for ${esc(data.owner.fullname)}.`;
        if (allocations.length) t += `\nCleared ${money(allocatedTotal)} across ${allocations.length} sale(s): ${allocations.map(a => '#' + a.sale_id).join(', ')}.`;
        if (walletCredit > 0) t += `\nExtra ${money(walletCredit)} added to their advance wallet.`;
        if (!allocations.length && !walletCredit) t += ' Nothing was due, so no allocation was needed.';
        return t;
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Telegram payment allocation error:', e);
        return 'Failed to record the payment — nothing was saved. Please try again or use the app.';
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Expenses flow — view summaries + record a new expense step by step
// ---------------------------------------------------------------------------
const EXPENSE_CATEGORIES = {
    'Production': ['Raw Material Purchase', 'Packaging Materials', 'Equipment Repair', 'Equipment Purchase', 'Gas/Fuel', 'Water', 'Other Production'],
    'Operations': ['Rent', 'Electricity', 'Transport/Delivery', 'Vehicle Maintenance', 'Communication', 'Cleaning Supplies', 'Other Operations'],
    'Staff': ['Staff Welfare', 'Staff Training', 'Medical', 'Uniforms', 'Other Staff'],
    'Administrative': ['Office Supplies', 'Licenses & Permits', 'Bank Charges', 'Legal & Professional', 'Insurance', 'Other Administrative'],
    'Marketing': ['Advertising', 'Promotions', 'Branding', 'Other Marketing'],
    'Miscellaneous': ['Donations', 'Fines & Penalties', 'Other']
};

async function expensesFlow(chatId, user, session, state, text) {
    const data = state.data || {};

    if (state.step === 'menu') {
        if (text === '4' && data.canCreate) {
            const cats = Object.keys(EXPENSE_CATEGORIES);
            await saveState(session.id, { flow: 'expenses', step: 'category', data });
            let t = '*Record an expense*\nPick a category:\n';
            cats.forEach((c, i) => { t += `\n${i + 1}. ${c}`; });
            t += `\n\n0. Cancel`;
            return sendTelegramText(chatId, t);
        }
        const period = { '1': 'today', '2': 'week', '3': 'month' }[text];
        if (!period) return sendTelegramText(chatId, `Reply 1, 2, 3${data.canCreate ? ' or 4' : ''} — or 0 for the menu.`);
        const e = await expensesSummary(period);
        const top = await db.query(
            `SELECT expense_type, category, amount FROM operating_expenses
             WHERE ${periodWhere('expense_date', period)} ORDER BY amount DESC LIMIT 5`);
        let t = `*Expenses — ${PERIOD_LABEL[period]}*\nTotal: ${money(e.total)} across ${e.n} record(s)\n`;
        top.rows.forEach(x => { t += `\n- ${esc(x.expense_type)} (${esc(x.category)}) — ${money(x.amount)}`; });
        t += `\n\n0. Back to menu`;
        await saveState(session.id, { flow: 'menu-done' });
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'category') {
        const cats = Object.keys(EXPENSE_CATEGORIES);
        const idx = parseInt(text, 10);
        if (isNaN(idx) || idx < 1 || idx > cats.length) return sendTelegramText(chatId, `Reply 1-${cats.length}, or 0 to cancel.`);
        data.category = cats[idx - 1];
        await saveState(session.id, { flow: 'expenses', step: 'type', data });
        let t = `Category: *${data.category}*\nPick the expense type:\n`;
        EXPENSE_CATEGORIES[data.category].forEach((x, i) => { t += `\n${i + 1}. ${x}`; });
        t += `\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'type') {
        const types = EXPENSE_CATEGORIES[data.category];
        const idx = parseInt(text, 10);
        if (isNaN(idx) || idx < 1 || idx > types.length) return sendTelegramText(chatId, `Reply 1-${types.length}, or 0 to cancel.`);
        data.expenseType = types[idx - 1];
        await saveState(session.id, { flow: 'expenses', step: 'amount', data });
        return sendTelegramText(chatId, `Type: *${data.expenseType}*\nHow much? (numbers only, e.g. 2500)\n\n0. Cancel`);
    }

    if (state.step === 'amount') {
        const amount = num(text);
        if (!amount || amount <= 0) return sendTelegramText(chatId, 'Please type a valid amount (e.g. 2500), or 0 to cancel.');
        data.amount = amount;
        await saveState(session.id, { flow: 'expenses', step: 'description', data });
        return sendTelegramText(chatId, `Amount: ${money(amount)}\nAdd a short description, or send *-* to skip.\n\n0. Cancel`);
    }

    if (state.step === 'description') {
        data.description = text === '-' ? null : text.slice(0, 200);
        await saveState(session.id, { flow: 'expenses', step: 'method', data });
        let t = `Amount: ${money(data.amount)}\nHow was it paid?\n`;
        PAYMENT_METHODS.forEach((m, i) => { t += `\n${i + 1}. ${m}`; });
        t += `\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'method') {
        const idx = parseInt(text, 10);
        if (isNaN(idx) || idx < 1 || idx > PAYMENT_METHODS.length) {
            return sendTelegramText(chatId, `Reply 1-${PAYMENT_METHODS.length}, or 0 to cancel.`);
        }
        data.method = PAYMENT_METHODS[idx - 1];
        await saveState(session.id, { flow: 'expenses', step: 'receipt', data });
        return sendTelegramText(chatId, `Method: ${data.method}\n` + RECEIPT_PROMPT);
    }

    if (state.step === 'receipt') {
        const r = readReceiptAnswer(chatId, text);
        data.receiptUrl = r.url;
        data.reference = r.reference;
        await saveState(session.id, { flow: 'expenses', step: 'confirm', data });
        return sendTelegramText(chatId,
            `*Confirm expense*\nCategory: ${data.category}\nType: ${data.expenseType}\nAmount: ${money(data.amount)}\nMethod: ${data.method}${data.reference ? `\nReference: ${esc(data.reference)}` : ''}${data.receiptUrl ? '\nReceipt photo: attached ✅' : ''}\nDescription: ${esc(data.description || '—')}\nRecorded by: ${esc(user.fullname)}\n\n1. Confirm\n2. Cancel`);
    }

    if (state.step === 'confirm') {
        if (text !== '1') {
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Expense cancelled. Send *0* for the menu.');
        }
        try {
            const r = await db.query(
                `INSERT INTO operating_expenses (expense_date, expense_type, description, amount, category, payment_method, reference_number, receipt_image_url, recorded_by, is_recurring)
                 VALUES (CURRENT_DATE, $1, $2, $3, $4, $5, $6, $7, $8, false) RETURNING id`,
                [data.expenseType, data.description, data.amount, data.category, data.method,
                 data.reference || null, data.receiptUrl || null, user.id]);
            await recordMoneyTransaction({
                direction: 'OUT', amount: data.amount, category: 'expense',
                reference_type: 'expense', reference_id: r.rows[0].id,
                description: `Expense — ${data.expenseType} (via Telegram)`,
                payment_method: data.method, transaction_date: null, recorded_by: user.id
            });
            await saveState(session.id, {});
            return sendTelegramText(chatId, `Expense recorded: ${data.expenseType} — ${money(data.amount)}.\n\n0. Back to menu`);
        } catch (e) {
            console.error('Telegram expense error:', e);
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Failed to save the expense — nothing was recorded. Please use the app.\n\n0. Back to menu');
        }
    }
}
async function reportsFlow(chatId, user, session, state, text) {
    const period = { '1': 'today', '2': 'week', '3': 'month' }[text];
    if (!period) return sendTelegramText(chatId, 'Reply 1, 2 or 3 — or 0 for the menu.');
    const [s, p, e] = await Promise.all([salesSummary(period), paymentsSummary(period), expensesSummary(period)]);
    const net = parseFloat(p.total) - parseFloat(e.total);
    let t = `*Report — ${PERIOD_LABEL[period]}*\n`;
    t += `\nSales made: ${money(s.total)} (${s.n})`;
    t += `\nPayments received: ${money(p.total)} (${p.n})`;
    t += `\nExpenses: ${money(e.total)} (${e.n})`;
    t += `\nNet cash movement: ${money(net)}`;
    t += `\nCredit still open on these sales: ${money(s.credit)}`;
    t += `\n\nFull breakdowns are on the Reports page in the app.\n\n0. Back to menu`;
    await saveState(session.id, { flow: 'menu-done' });
    await sendTelegramText(chatId, t);
}

// ---------------------------------------------------------------------------
// New Sale flow (POS) — mirrors routes/sales.js POST /process
// tax = 0 and discount = 0 (matches every real sale in the system).
// Demo-stock users are redirected to the app (their stock is per-user).
// ---------------------------------------------------------------------------
async function searchProducts(term, limit = 8) {
    const r = await db.query(
        `SELECT p.id, p.name, p.price, COALESCE(i.quantity, 0) AS stock
         FROM products p LEFT JOIN inventory i ON i.product_id = p.id
         WHERE p.is_active = true AND p.name ILIKE $1
         ORDER BY p.name LIMIT $2`, [`%${term}%`, limit]);
    return r.rows;
}

function cartText(data) {
    let t = '';
    let total = 0;
    data.items.forEach((it, i) => {
        total += it.qty * it.price;
        t += `\n${i + 1}. ${esc(it.name)} × ${it.qty} — ${money(it.qty * it.price)}`;
    });
    t += `\nTotal so far: ${money(total)}`;
    return t;
}

function saleItemPrompt(data) {
    return `Type part of a product name to add it${data.items.length ? ', or:' : '.'}\n${data.items.length ? '1. Done — choose payment\n' : ''}\n0. Cancel`;
}

function saleConfirmText(data, user) {
    const total = data.items.reduce((s, it) => s + it.qty * it.price, 0);
    const buyer = data.rider
        ? `Rider ${esc(data.rider.fullname)}${data.customer ? ` for customer ${esc(data.customer.fullname)}` : ''}`
        : (data.customer ? esc(data.customer.fullname) : 'Walk-in customer');
    const paid = data.method === 'Credit' ? (data.paidNow || 0) : total;
    let t = `*Confirm sale*\nBuyer: ${buyer}\n*Items:*` + cartText(data);
    t += `\n\nPayment: ${data.method}`;
    if (data.method === 'Credit') t += `\nPaid now: ${money(paid)}\nBalance owed: ${money(total - paid)} (due tomorrow, settled oldest-first)`;
    if (data.reference) t += `\nReference: ${esc(data.reference)}`;
    if (data.receiptUrl) t += `\nReceipt photo: attached ✅`;
    t += `\nRecorded by: ${esc(user.fullname)}\nStock will be deducted immediately.`;
    t += `\n\n1. Confirm\n2. Cancel`;
    return t;
}

async function newSaleFlow(chatId, user, session, state, text) {
    const data = state.data || {};
    data.items = data.items || [];

    if (state.step === 'party') {
        if (!['1', '2', '3'].includes(text)) return sendTelegramText(chatId, 'Reply 1, 2 or 3 — or 0 to cancel.');
        data.party = text === '1' ? 'walkin' : (text === '2' ? 'customer' : 'rider');
        if (data.party === 'customer') {
            await saveState(session.id, { flow: 'newsale', step: 'cust_search', data });
            return sendTelegramText(chatId, 'Type part of the customer name:\n\n0. Cancel');
        }
        if (data.party === 'rider') {
            await saveState(session.id, { flow: 'newsale', step: 'rider_search', data });
            return sendTelegramText(chatId, 'Type part of the rider name:\n\n0. Cancel');
        }
        await saveState(session.id, { flow: 'newsale', step: 'item_search', data });
        return sendTelegramText(chatId, saleItemPrompt(data));
    }

    if (state.step === 'cust_search' || state.step === 'rider_search') {
        const isRider = state.step === 'rider_search';
        const r = isRider
            ? await db.query(`SELECT id, fullname, current_balance AS bal, credit_limit FROM riders WHERE is_active = true AND fullname ILIKE $1 ORDER BY fullname LIMIT 8`, [`%${text}%`])
            : await db.query(`SELECT id, fullname, balance AS bal, NULL AS credit_limit FROM customers WHERE COALESCE(is_active, true) = true AND fullname ILIKE $1 ORDER BY fullname LIMIT 8`, [`%${text}%`]);
        if (!r.rows.length) return sendTelegramText(chatId, `No match for "${esc(text)}". Type another name, or 0 to cancel.`);
        data.matches = r.rows;
        await saveState(session.id, { flow: 'newsale', step: isRider ? 'rider_pick' : 'cust_pick', data });
        let t = 'Pick one:\n';
        r.rows.forEach((m, i) => {
            t += `\n${i + 1}. ${esc(m.fullname)} — owes ${money(m.bal)}`;
            if (isRider && m.credit_limit) t += ` (limit ${money(m.credit_limit)})`;
        });
        t += `\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'cust_pick' || state.step === 'rider_pick') {
        const idx = parseInt(text, 10);
        if (isNaN(idx) || idx < 1 || idx > (data.matches || []).length) {
            return sendTelegramText(chatId, `Reply with a number 1-${(data.matches || []).length}, or 0 to cancel.`);
        }
        const picked = data.matches[idx - 1];
        delete data.matches;
        if (state.step === 'rider_pick') {
            data.rider = picked;
            await saveState(session.id, { flow: 'newsale', step: 'rider_cust', data });
            return sendTelegramText(chatId,
                `Rider: *${esc(picked.fullname)}*\nIs this load for a specific registered customer?\n1. No — rider sells on the street\n2. Yes — pick the customer\n\n0. Cancel`);
        }
        data.customer = picked;
        await saveState(session.id, { flow: 'newsale', step: 'item_search', data });
        return sendTelegramText(chatId, `Customer: *${esc(picked.fullname)}*\n` + saleItemPrompt(data));
    }

    if (state.step === 'rider_cust') {
        if (text === '1') {
            await saveState(session.id, { flow: 'newsale', step: 'item_search', data });
            return sendTelegramText(chatId, saleItemPrompt(data));
        }
        if (text === '2') {
            await saveState(session.id, { flow: 'newsale', step: 'cust_search', data });
            return sendTelegramText(chatId, 'Type part of the customer name:\n\n0. Cancel');
        }
        return sendTelegramText(chatId, 'Reply 1 or 2 — or 0 to cancel.');
    }

    if (state.step === 'item_search') {
        if (text === '1') {
            if (!data.items.length) return sendTelegramText(chatId, 'Add at least one item first — type a product name to search.\n\n0. Cancel');
            await saveState(session.id, { flow: 'newsale', step: 'pay_method', data });
            let t = `*Sale items:*` + cartText(data);
            t += `\n\nPayment method?\n1. Cash\n2. Bank Transfer\n3. POS\n4. Credit (pay later)\n\n0. Cancel`;
            return sendTelegramText(chatId, t);
        }
        const rows = await searchProducts(text);
        if (!rows.length) return sendTelegramText(chatId, `No product matches "${esc(text)}". Type another name, or 0 to cancel.`);
        data.matches = rows;
        await saveState(session.id, { flow: 'newsale', step: 'item_pick', data });
        let t = 'Pick a product:\n';
        rows.forEach((m, i) => { t += `\n${i + 1}. ${esc(m.name)} — ${money(m.price)} (${Number(m.stock)} in stock)`; });
        t += `\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'item_pick') {
        const idx = parseInt(text, 10);
        if (isNaN(idx) || idx < 1 || idx > (data.matches || []).length) {
            return sendTelegramText(chatId, `Reply with a number 1-${(data.matches || []).length}, or 0 to cancel.`);
        }
        data.current = data.matches[idx - 1];
        delete data.matches;
        await saveState(session.id, { flow: 'newsale', step: 'item_qty', data });
        return sendTelegramText(chatId,
            `*${esc(data.current.name)}* — ${money(data.current.price)} each, ${Number(data.current.stock)} in stock.\nHow many? (whole number)\n\n0. Cancel`);
    }

    if (state.step === 'item_qty') {
        const qty = parseInt(text, 10);
        if (isNaN(qty) || qty <= 0) return sendTelegramText(chatId, 'Please type a whole number (e.g. 10), or 0 to cancel.');
        const already = data.items.filter(it => it.product_id === data.current.id).reduce((s, it) => s + it.qty, 0);
        if (qty + already > Number(data.current.stock)) {
            return sendTelegramText(chatId,
                `Only ${Number(data.current.stock)} of *${esc(data.current.name)}* in stock${already ? ` and you already added ${already}` : ''}. Type a smaller quantity, or 0 to cancel.`);
        }
        const existing = data.items.find(it => it.product_id === data.current.id);
        if (existing) existing.qty += qty;
        else data.items.push({ product_id: data.current.id, name: data.current.name, price: parseFloat(data.current.price), qty });
        delete data.current;
        await saveState(session.id, { flow: 'newsale', step: 'item_search', data });
        return sendTelegramText(chatId, `Added. *Cart:*` + cartText(data) + `\n\n` + saleItemPrompt(data));
    }

    if (state.step === 'pay_method') {
        const method = { '1': 'Cash', '2': 'Bank Transfer', '3': 'POS', '4': 'Credit' }[text];
        if (!method) return sendTelegramText(chatId, 'Reply 1-4, or 0 to cancel.');
        data.method = method;
        if (method === 'Credit') {
            const total = data.items.reduce((s, it) => s + it.qty * it.price, 0);
            await saveState(session.id, { flow: 'newsale', step: 'credit_paid', data });
            return sendTelegramText(chatId,
                `Credit sale — total ${money(total)}.\nHow much is being paid right now? (*-* for nothing now)\n\n0. Cancel`);
        }
        data.paidNow = null;
        await saveState(session.id, { flow: 'newsale', step: 'receipt', data });
        return sendTelegramText(chatId, `Payment: ${data.method}\n` + RECEIPT_PROMPT);
    }

    if (state.step === 'credit_paid') {
        const paid = text === '-' ? 0 : num(text);
        if (paid === null || paid < 0) return sendTelegramText(chatId, 'Please type a valid amount (or *-* for nothing now), or 0 to cancel.');
        const total = data.items.reduce((s, it) => s + it.qty * it.price, 0);
        data.paidNow = Math.min(paid, total);
        await saveState(session.id, { flow: 'newsale', step: 'receipt', data });
        return sendTelegramText(chatId, `Credit — paid now ${money(data.paidNow)}\n` + RECEIPT_PROMPT);
    }

    if (state.step === 'receipt') {
        const r = readReceiptAnswer(chatId, text);
        data.receiptUrl = r.url;
        data.reference = r.reference;
        await saveState(session.id, { flow: 'newsale', step: 'confirm', data });
        return sendTelegramText(chatId, saleConfirmText(data, user));
    }

    if (state.step === 'confirm') {
        if (text !== '1') {
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Sale cancelled. Send *0* for the menu.');
        }
        const result = await processTelegramSale(data, user);
        await saveState(session.id, {});
        return sendTelegramText(chatId, result + `\n\n0. Back to menu`);
    }
}

async function processTelegramSale(data, user) {
    const u = await db.query('SELECT role, load_from_demo_stock FROM users WHERE id = $1', [user.id]);
    if (u.rows.length && u.rows[0].role === 'sales' && u.rows[0].load_from_demo_stock) {
        return 'Your account sells from personal demo stock — please record this sale in the app so it deducts from your own stock. Nothing was saved.';
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Lock and re-check stock for every item (main inventory)
        for (const it of data.items) {
            const s = await client.query('SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE', [it.product_id]);
            const avail = s.rows.length ? Number(s.rows[0].quantity) : 0;
            if (avail < it.qty) {
                await client.query('ROLLBACK');
                return `Not enough stock for ${esc(it.name)} — only ${avail} available right now. Sale NOT recorded.`;
            }
        }

        // COGS from recipes × latest restock prices (same as the app)
        let total = 0, totalCogs = 0;
        for (const it of data.items) {
            total += it.qty * it.price;
            const c = await client.query(
                `SELECT COALESCE(SUM(r.quantity_required * COALESCE(rm.restock_price_per_unit, 0)), 0) AS cogs
                 FROM recipes r JOIN raw_materials rm ON rm.id = r.raw_material_id
                 WHERE r.product_id = $1`, [it.product_id]);
            totalCogs += it.qty * parseFloat(c.rows[0].cogs);
        }
        total = Math.round(total * 100) / 100;
        totalCogs = Math.round(totalCogs * 100) / 100;

        const isCredit = data.method === 'Credit';
        const paid = isCredit ? Math.min(data.paidNow || 0, total) : total;
        const balance = Math.round((total - paid) * 100) / 100;
        const status = balance <= 0 ? 'Paid' : (paid > 0 ? 'Partially Paid' : 'Unpaid');

        // Rider credit-limit check (same as the app)
        if (data.rider && balance > 0) {
            const rr = await client.query('SELECT fullname, current_balance, credit_limit FROM riders WHERE id = $1 FOR UPDATE', [data.rider.id]);
            if (!rr.rows.length) {
                await client.query('ROLLBACK');
                return 'That rider no longer exists. Sale NOT recorded.';
            }
            const newBal = parseFloat(rr.rows[0].current_balance) + balance;
            const limit = parseFloat(rr.rows[0].credit_limit || 0);
            if (limit > 0 && newBal > limit) {
                await client.query('ROLLBACK');
                return `This would push ${esc(rr.rows[0].fullname)} to ${money(newBal)}, over their credit limit of ${money(limit)}. Sale NOT recorded.`;
            }
        }

        const ins = await client.query(
            `INSERT INTO sales_transactions
                (subtotal, tax_amount, total_amount, discount_amount, cashier_id, payment_method,
                 customer_id, note, payment_reference, payment_image_url, status, amount_paid,
                 balance_due, due_date, total_cogs, total_profit, stock_source, stock_source_user_id,
                 is_advantage_sale, advantage_total, base_subtotal, is_rider_sale, rider_id)
             VALUES ($1, 0, $1, 0, $2, $3, $4, 'Recorded via Telegram', $13, $14, $5, $6, $7,
                     $8, $9, $10, 'main_inventory', NULL, false, 0, $1, $11, $12)
             RETURNING id`,
            [total, user.id, data.method,
             data.customer ? data.customer.id : null, status, paid, balance,
             isCredit ? new Date(Date.now() + 86400000) : null,
             totalCogs, Math.round((total - totalCogs) * 100) / 100,
             !!data.rider, data.rider ? data.rider.id : null,
             data.reference || null, data.receiptUrl || null]);
        const saleId = ins.rows[0].id;

        for (const it of data.items) {
            await client.query(
                `INSERT INTO sales_items (sale_id, product_id, quantity, price_at_sale, discount_applied, advantage_amount, final_price)
                 VALUES ($1, $2, $3, $4, 0, 0, $4)`, [saleId, it.product_id, it.qty, it.price]);
            await client.query(
                'UPDATE inventory SET quantity = quantity - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2',
                [it.qty, it.product_id]);
        }

        if (balance > 0) {
            if (data.rider) {
                await client.query('UPDATE riders SET current_balance = current_balance + $1 WHERE id = $2', [balance, data.rider.id]);
            }
            if (data.customer) {
                await client.query('UPDATE customers SET balance = balance + $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [balance, data.customer.id]);
            }
        }

        // Rider remittance at sale time → payments + rider history (same as the app)
        if (data.rider && paid > 0) {
            const p = await client.query(
                `INSERT INTO payments (transaction_id, customer_id, rider_id, amount, payment_date, payment_method, is_rider_payment)
                 VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, true) RETURNING id`,
                [saleId, data.customer ? data.customer.id : null, data.rider.id, paid, data.method]);
            await client.query(
                `INSERT INTO rider_payment_history (rider_id, payment_id, amount, payment_date, payment_method, notes, recorded_by)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4, $5, $6)`,
                [data.rider.id, p.rows[0].id, paid, data.method, `Payment for transaction #${saleId}`, user.id]);
        }

        await client.query('COMMIT');

        // Money Management mirror (fail-open, same as the app)
        if (paid > 0) {
            await recordMoneyTransaction({
                direction: 'IN', amount: paid, category: 'sale_payment', payment_method: data.method,
                reference_type: 'sale', reference_id: saleId,
                description: `Sale #${saleId} via Telegram${data.rider ? ' (rider sale)' : ''}`,
                transaction_date: null, recorded_by: user.id
            });
        }

        let t = `✅ Sale #${saleId} recorded — ${money(total)} (${status}).`;
        if (balance > 0) {
            if (data.rider) t += `\n${money(balance)} added to ${esc(data.rider.fullname)}'s balance.`;
            if (data.customer) t += `\n${money(balance)} added to ${esc(data.customer.fullname)}'s debt.`;
        }
        return t;
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Telegram sale error:', e);
        return 'Failed to record the sale — nothing was saved. Please try again or use the app.';
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Log Production flow — mirrors routes/production.js POST /log
// ---------------------------------------------------------------------------
async function newProductionFlow(chatId, user, session, state, text) {
    const data = state.data || {};
    data.batches = data.batches || [];

    if (state.step === 'product_search') {
        const rows = await db.query(
            `SELECT p.id, p.name, COALESCE(i.quantity, 0) AS stock,
                    (SELECT COUNT(*) FROM recipes r WHERE r.product_id = p.id) AS recipe_lines
             FROM products p LEFT JOIN inventory i ON i.product_id = p.id
             WHERE p.is_active = true AND p.name ILIKE $1
             ORDER BY p.name LIMIT 8`, [`%${text}%`]);
        if (!rows.rows.length) return sendTelegramText(chatId, `No product matches "${esc(text)}". Type another name, or 0 to cancel.`);
        data.matches = rows.rows;
        await saveState(session.id, { flow: 'newprod', step: 'product_pick', data });
        let t = 'Pick a product:\n';
        rows.rows.forEach((m, i) => {
            t += `\n${i + 1}. ${esc(m.name)}${Number(m.recipe_lines) === 0 ? ' ⚠️ no recipe' : ''}`;
        });
        t += `\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'product_pick') {
        const idx = parseInt(text, 10);
        if (isNaN(idx) || idx < 1 || idx > (data.matches || []).length) {
            return sendTelegramText(chatId, `Reply with a number 1-${(data.matches || []).length}, or 0 to cancel.`);
        }
        const picked = data.matches[idx - 1];
        delete data.matches;
        if (Number(picked.recipe_lines) === 0) {
            await saveState(session.id, { flow: 'newprod', step: 'product_search', data: { batches: data.batches } });
            return sendTelegramText(chatId,
                `⚠️ *${esc(picked.name)}* has no recipe, so production can't be logged for it (same rule as the app).\nType another product name, or 0 to cancel.`);
        }
        data.current = picked;
        await saveState(session.id, { flow: 'newprod', step: 'qty', data });
        return sendTelegramText(chatId, `*${esc(picked.name)}*\nHow many were produced? (whole number)\n\n0. Cancel`);
    }

    if (state.step === 'qty') {
        const qty = parseInt(text, 10);
        if (isNaN(qty) || qty <= 0) return sendTelegramText(chatId, 'Please type a whole number (e.g. 50), or 0 to cancel.');
        data.current.qty = qty;
        await saveState(session.id, { flow: 'newprod', step: 'waste', data });
        return sendTelegramText(chatId, `Producing ${qty} × *${esc(data.current.name)}*.\nHow many were wasted / damaged? (1-${qty}, or *-* for none)\n\n0. Cancel`);
    }

    if (state.step === 'waste') {
        const w = text === '-' ? 0 : parseInt(text, 10);
        if (isNaN(w) || w < 0 || w > data.current.qty) {
            return sendTelegramText(chatId, `Please type a number between 1 and ${data.current.qty} (or *-* for no waste), or 0 to cancel.`);
        }
        data.current.waste = w;
        data.batches.push(data.current);
        delete data.current;
        await saveState(session.id, { flow: 'newprod', step: 'more', data });
        let t = '*This production run:*';
        data.batches.forEach((b, i) => { t += `\n${i + 1}. ${esc(b.name)} — ${b.qty} produced, ${b.waste} waste`; });
        t += `\n\n1. Add another product\n2. Done — choose shift\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'more') {
        if (text === '1') {
            await saveState(session.id, { flow: 'newprod', step: 'product_search', data });
            return sendTelegramText(chatId, 'Type part of the next product name:\n\n0. Cancel');
        }
        if (text === '2') {
            await saveState(session.id, { flow: 'newprod', step: 'shift', data });
            return sendTelegramText(chatId, 'Which shift?\n1. Morning\n2. Afternoon\n3. Night\n\n0. Cancel');
        }
        return sendTelegramText(chatId, 'Reply 1 or 2 — or 0 to cancel.');
    }

    if (state.step === 'shift') {
        const shift = { '1': 'Morning', '2': 'Afternoon', '3': 'Night' }[text];
        if (!shift) return sendTelegramText(chatId, 'Reply 1, 2 or 3 — or 0 to cancel.');
        data.shift = shift;

        // Material usage preview (recipes × quantities)
        const usage = {};
        for (const b of data.batches) {
            const r = await db.query(
                `SELECT rm.name, rm.unit, r.quantity_required
                 FROM recipes r JOIN raw_materials rm ON rm.id = r.raw_material_id
                 WHERE r.product_id = $1`, [b.id]);
            for (const x of r.rows) {
                const k = x.name;
                if (!usage[k]) usage[k] = { qty: 0, unit: x.unit };
                usage[k].qty += parseFloat(x.quantity_required) * b.qty;
            }
        }
        const now = new Date();
        const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        let t = `*Confirm production*\nShift: ${shift}\nBatch: Br/${ymd}--${shift.charAt(0)}\n`;
        data.batches.forEach(b => { t += `\n• ${esc(b.name)} — ${b.qty} produced, ${b.waste} waste (${b.qty - b.waste} to stock)`; });
        const names = Object.keys(usage);
        if (names.length) {
            t += `\n\n*Materials to deduct:*`;
            names.forEach(n => { t += `\n- ${esc(n)}: ${Math.round(usage[n].qty * 100) / 100} ${esc(usage[n].unit || '')}`; });
        }
        t += `\nLogged by: ${esc(user.fullname)}\n\n1. Confirm\n2. Cancel`;
        await saveState(session.id, { flow: 'newprod', step: 'confirm', data });
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'confirm') {
        if (text !== '1') {
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Production log cancelled. Send *0* for the menu.');
        }
        const result = await processTelegramProduction(data, user);
        await saveState(session.id, {});
        return sendTelegramText(chatId, result + `\n\n0. Back to menu`);
    }
}

async function processTelegramProduction(data, user) {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');
        const now = new Date();
        const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        const batch = `Br/${ymd}--${data.shift.charAt(0)}`;
        const logged = [];

        for (const b of data.batches) {
            // Recipe is required (same rule as the app)
            const rec = await client.query(
                `SELECT r.raw_material_id, r.quantity_required, rm.restock_price_per_unit, rm.name
                 FROM recipes r JOIN raw_materials rm ON rm.id = r.raw_material_id
                 WHERE r.product_id = $1`, [b.id]);
            if (!rec.rows.length) {
                await client.query('ROLLBACK');
                return `No recipe found for ${esc(b.name)} — production NOT logged.`;
            }

            const ins = await client.query(
                `INSERT INTO production_logs (product_id, quantity_produced, waste_quantity, production_date, shift, logged_by_user_id, batch_number)
                 VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6) RETURNING id`,
                [b.id, b.qty, b.waste, data.shift, user.id, batch]);
            const logId = ins.rows[0].id;

            const net = b.qty - b.waste;
            if (net > 0) {
                const up = await client.query(
                    'UPDATE inventory SET quantity = quantity + $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2',
                    [net, b.id]);
                if (up.rowCount === 0) {
                    await client.query(
                        'INSERT INTO inventory (product_id, quantity, last_updated) VALUES ($1, $2, CURRENT_TIMESTAMP)',
                        [b.id, net]);
                }
            }

            for (const x of rec.rows) {
                const used = parseFloat(x.quantity_required) * b.qty;
                if (used <= 0) continue;
                await client.query(
                    `INSERT INTO material_transactions (raw_material_id, transaction_type, quantity_change, unit_cost, transaction_date, recorded_by_user_id, notes, production_log_id)
                     VALUES ($1, 'production_use', $2, $3, CURRENT_TIMESTAMP, $4, $5, $6)`,
                    [x.raw_material_id, -used, parseFloat(x.restock_price_per_unit || 0), user.id, `Production batch ${batch}`, logId]);
                await client.query(
                    'UPDATE raw_materials SET current_stock = current_stock - $1 WHERE id = $2',
                    [used, x.raw_material_id]);
            }
            logged.push({ name: b.name, qty: b.qty, waste: b.waste });
        }

        await client.query('COMMIT');
        let t = `✅ Production logged — batch ${batch} (${data.shift} shift).`;
        logged.forEach(l => { t += `\n• ${esc(l.name)}: ${l.qty - l.waste} added to stock${l.waste ? ` (${l.waste} waste)` : ''}`; });
        t += `\nRaw materials were deducted per recipe.`;
        return t;
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Telegram production error:', e);
        return 'Failed to log production — nothing was saved. Please try again or use the app.';
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Record Waste flow — mirrors routes/wasteStock.js POST /
// ---------------------------------------------------------------------------
async function wasteAddFlow(chatId, user, session, state, text) {
    const data = state.data || {};

    if (state.step === 'product_search') {
        const rows = await searchProducts(text);
        if (!rows.length) return sendTelegramText(chatId, `No product matches "${esc(text)}". Type another name, or 0 to cancel.`);
        data.matches = rows;
        await saveState(session.id, { flow: 'wasteadd', step: 'product_pick', data });
        let t = 'Pick a product:\n';
        rows.forEach((m, i) => { t += `\n${i + 1}. ${esc(m.name)} — ${Number(m.stock)} in stock`; });
        t += `\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'product_pick') {
        const idx = parseInt(text, 10);
        if (isNaN(idx) || idx < 1 || idx > (data.matches || []).length) {
            return sendTelegramText(chatId, `Reply with a number 1-${(data.matches || []).length}, or 0 to cancel.`);
        }
        data.product = data.matches[idx - 1];
        delete data.matches;
        await saveState(session.id, { flow: 'wasteadd', step: 'qty', data });
        return sendTelegramText(chatId,
            `*${esc(data.product.name)}* — ${Number(data.product.stock)} in stock.\nHow many are wasted / damaged?\n\n0. Cancel`);
    }

    if (state.step === 'qty') {
        const qty = parseInt(text, 10);
        if (isNaN(qty) || qty <= 0) return sendTelegramText(chatId, 'Please type a whole number (e.g. 3), or 0 to cancel.');
        if (qty > Number(data.product.stock)) {
            return sendTelegramText(chatId, `Only ${Number(data.product.stock)} in stock — type a smaller number, or 0 to cancel.`);
        }
        data.qty = qty;
        await saveState(session.id, { flow: 'wasteadd', step: 'reason', data });
        return sendTelegramText(chatId, `Recording ${qty} × *${esc(data.product.name)}* as waste.\nWhy? (e.g. Burnt, Expired, Damaged — or *-* to skip)\n\n0. Cancel`);
    }

    if (state.step === 'reason') {
        data.reason = text === '-' ? 'Waste recorded via Telegram' : text.slice(0, 150);
        await saveState(session.id, { flow: 'wasteadd', step: 'confirm', data });
        return sendTelegramText(chatId,
            `*Confirm waste*\nProduct: ${esc(data.product.name)}\nQuantity: ${data.qty}\nReason: ${esc(data.reason)}\nRecorded by: ${esc(user.fullname)}\n\nStock will be reduced immediately.\n\n1. Confirm\n2. Cancel`);
    }

    if (state.step === 'confirm') {
        if (text !== '1') {
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Waste record cancelled. Send *0* for the menu.');
        }
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            const s = await client.query('SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE', [data.product.id]);
            const avail = s.rows.length ? Number(s.rows[0].quantity) : 0;
            if (avail < data.qty) {
                await client.query('ROLLBACK');
                await saveState(session.id, {});
                return sendTelegramText(chatId, `Stock for ${esc(data.product.name)} changed — only ${avail} available now. Waste NOT recorded.\n\n0. Back to menu`);
            }
            await client.query(
                `INSERT INTO waste_stock (product_id, quantity, reason, date_recorded, recorded_by)
                 VALUES ($1, $2, $3, CURRENT_TIMESTAMP, $4)`,
                [data.product.id, data.qty, data.reason, user.id]);
            await client.query(
                'UPDATE inventory SET quantity = quantity - $1, last_updated = CURRENT_TIMESTAMP WHERE product_id = $2',
                [data.qty, data.product.id]);
            await client.query('COMMIT');
            await saveState(session.id, {});
            return sendTelegramText(chatId,
                `✅ Waste recorded: ${data.qty} × ${esc(data.product.name)}. Stock is now ${avail - data.qty}.\n\n0. Back to menu`);
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Telegram waste error:', e);
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Failed to record waste — nothing was saved. Please try again or use the app.\n\n0. Back to menu');
        } finally {
            client.release();
        }
    }
}

// ---------------------------------------------------------------------------
// Restock Raw Material flow — mirrors routes/materialTransactions.js POST /restock
// ---------------------------------------------------------------------------
async function restockFlow(chatId, user, session, state, text) {
    const data = state.data || {};

    if (state.step === 'mat_search') {
        const r = await db.query(
            `SELECT id, name, unit, current_stock, restock_price_per_unit
             FROM raw_materials WHERE name ILIKE $1 ORDER BY name LIMIT 8`, [`%${text}%`]);
        if (!r.rows.length) return sendTelegramText(chatId, `No material matches "${esc(text)}". Type another name, or 0 to cancel.`);
        data.matches = r.rows;
        await saveState(session.id, { flow: 'restock', step: 'mat_pick', data });
        let t = 'Pick a material:\n';
        r.rows.forEach((m, i) => {
            t += `\n${i + 1}. ${esc(m.name)} — ${Number(m.current_stock)} ${esc(m.unit || '')} in stock (last cost ${money(m.restock_price_per_unit)}/${esc(m.unit || 'unit')})`;
        });
        t += `\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'mat_pick') {
        const idx = parseInt(text, 10);
        if (isNaN(idx) || idx < 1 || idx > (data.matches || []).length) {
            return sendTelegramText(chatId, `Reply with a number 1-${(data.matches || []).length}, or 0 to cancel.`);
        }
        data.material = data.matches[idx - 1];
        delete data.matches;
        await saveState(session.id, { flow: 'restock', step: 'qty', data });
        return sendTelegramText(chatId,
            `*${esc(data.material.name)}* (${esc(data.material.unit || 'units')})\nHow many ${esc(data.material.unit || 'units')} are you adding?\n\n0. Cancel`);
    }

    if (state.step === 'qty') {
        const qty = num(text);
        if (!qty || qty <= 0) return sendTelegramText(chatId, 'Please type a valid quantity (e.g. 25 or 2.5), or 0 to cancel.');
        data.qty = qty;
        await saveState(session.id, { flow: 'restock', step: 'cost', data });
        return sendTelegramText(chatId,
            `Adding ${data.qty} ${esc(data.material.unit || 'units')} of *${esc(data.material.name)}*.\nCost per ${esc(data.material.unit || 'unit')}? (last was ${money(data.material.restock_price_per_unit)} — type *-* to keep it)\n\n0. Cancel`);
    }

    if (state.step === 'cost') {
        let cost;
        if (text === '-') cost = parseFloat(data.material.restock_price_per_unit || 0);
        else cost = num(text);
        if (!cost || cost <= 0) return sendTelegramText(chatId, 'Please type a valid unit cost (e.g. 1500), or 0 to cancel.');
        data.cost = cost;
        await saveState(session.id, { flow: 'restock', step: 'notes', data });
        return sendTelegramText(chatId,
            `Unit cost: ${money(cost)} — total ${money(cost * data.qty)}.\nAdd a note (supplier, etc.) or *-* to skip.\n\n0. Cancel`);
    }

    if (state.step === 'notes') {
        data.notes = text === '-' ? `Restock via Telegram` : text.slice(0, 200);
        await saveState(session.id, { flow: 'restock', step: 'confirm', data });
        return sendTelegramText(chatId,
            `*Confirm restock*\nMaterial: ${esc(data.material.name)}\nQuantity: +${data.qty} ${esc(data.material.unit || 'units')}\nUnit cost: ${money(data.cost)}\nTotal value: ${money(data.cost * data.qty)}\nNote: ${esc(data.notes)}\nRecorded by: ${esc(user.fullname)}\n\nStock and unit cost will update immediately.\n\n1. Confirm\n2. Cancel`);
    }

    if (state.step === 'confirm') {
        if (text !== '1') {
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Restock cancelled. Send *0* for the menu.');
        }
        const client = await db.getClient();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO material_transactions (raw_material_id, transaction_type, quantity_change, unit_cost, transaction_date, recorded_by_user_id, notes)
                 VALUES ($1, 'restock', $2, $3, CURRENT_TIMESTAMP, $4, $5)`,
                [data.material.id, data.qty, data.cost, user.id, data.notes]);
            const up = await client.query(
                `UPDATE raw_materials
                 SET current_stock = current_stock + $1, last_restock_date = CURRENT_DATE, restock_price_per_unit = $2
                 WHERE id = $3 RETURNING current_stock`,
                [data.qty, data.cost, data.material.id]);
            await client.query('COMMIT');
            await saveState(session.id, {});
            return sendTelegramText(chatId,
                `✅ Restocked ${esc(data.material.name)}: +${data.qty} ${esc(data.material.unit || 'units')} at ${money(data.cost)}. New stock: ${Number(up.rows[0].current_stock)}.\n\n0. Back to menu`);
        } catch (e) {
            await client.query('ROLLBACK');
            console.error('Telegram restock error:', e);
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Failed to record the restock — nothing was saved. Please try again or use the app.\n\n0. Back to menu');
        } finally {
            client.release();
        }
    }
}

// ---------------------------------------------------------------------------
// Add Customer flow
// ---------------------------------------------------------------------------
async function addCustomerFlow(chatId, user, session, state, text) {
    const data = state.data || {};

    if (state.step === 'name') {
        const name = text.trim();
        if (name.length < 2) return sendTelegramText(chatId, 'Please type the customer full name, or 0 to cancel.');
        data.name = name.slice(0, 120);
        await saveState(session.id, { flow: 'addcust', step: 'phone', data });
        return sendTelegramText(chatId, `Name: *${esc(data.name)}*\nPhone number? (or *-* to skip)\n\n0. Cancel`);
    }

    if (state.step === 'phone') {
        data.phone = text === '-' ? null : text.replace(/[^\d+\s]/g, '').slice(0, 30) || null;
        await saveState(session.id, { flow: 'addcust', step: 'confirm', data });
        return sendTelegramText(chatId,
            `*Confirm new customer*\nName: ${esc(data.name)}\nPhone: ${esc(data.phone || '—')}\nStarting balance: ${money(0)}\n\n1. Confirm\n2. Cancel`);
    }

    if (state.step === 'confirm') {
        if (text !== '1') {
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Cancelled. Send *0* for the menu.');
        }
        try {
            const dup = await db.query('SELECT id FROM customers WHERE fullname ILIKE $1 LIMIT 1', [data.name]);
            if (dup.rows.length) {
                await saveState(session.id, {});
                return sendTelegramText(chatId,
                    `A customer named "${esc(data.name)}" already exists (#${dup.rows[0].id}) — not added again. If it's a different person, add a distinguishing detail to the name in the app.\n\n0. Back to menu`);
            }
            const r = await db.query(
                `INSERT INTO customers (fullname, phone, balance, advance_balance, credit_limit, is_active, is_rider)
                 VALUES ($1, $2, 0, 0, 0, true, false) RETURNING id`,
                [data.name, data.phone]);
            await saveState(session.id, {});
            return sendTelegramText(chatId, `✅ Customer *${esc(data.name)}* added (#${r.rows[0].id}).\n\n0. Back to menu`);
        } catch (e) {
            console.error('Telegram add-customer error:', e);
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Failed to add the customer — please try again or use the app.\n\n0. Back to menu');
        }
    }
}

// ---------------------------------------------------------------------------
// Salary Payment flow — mirrors routes/salaries.js POST /payments
// (tax & pension are 0 for every staff salary in the system, loan deduction
//  auto-allocates oldest-first, credit-sales deduction clears oldest unpaid
//  credit sales via the staff member's linked customer record)
// ---------------------------------------------------------------------------
async function salaryStaffList(term) {
    const like = `%${term || ''}%`;
    const r = await db.query(
        `SELECT * FROM (
            SELECT u.id, 'user' AS stype, u.fullname AS name, u.role AS sub,
                   COALESCE(ss.base_salary, 0) AS base, COALESCE(ss.allowances, 0) AS allowances,
                   COALESCE(ss.deductions, 0) AS deductions
            FROM users u JOIN staff_salaries ss ON ss.user_id = u.id AND ss.is_active = true
            WHERE u.is_active = true AND u.fullname ILIKE $1
            UNION ALL
            SELECT sm.id, 'staff_member' AS stype, sm.fullname AS name, COALESCE(sm.position, 'staff') AS sub,
                   COALESCE(ss.base_salary, 0) AS base, COALESCE(ss.allowances, 0) AS allowances,
                   COALESCE(ss.deductions, 0) AS deductions
            FROM staff_members sm JOIN staff_salaries ss ON ss.staff_member_id = sm.id AND ss.is_active = true
            WHERE sm.is_active = true AND sm.fullname ILIKE $1
        ) x ORDER BY name LIMIT 15`, [like]);
    return r.rows;
}

async function salaryPayFlow(chatId, user, session, state, text) {
    const data = state.data || {};

    if (state.step === 'staff') {
        let rows = data.matches;
        const idx = parseInt(text, 10);
        if (rows && !isNaN(idx) && idx >= 1 && idx <= rows.length) {
            const s = rows[idx - 1];
            data.staff = s;
            delete data.matches;

            // Suggested deductions (loans + credit purchases), same as the app preview
            const col = s.stype === 'staff_member' ? 'staff_member_id' : 'user_id';
            const loans = await db.query(
                `SELECT id, COALESCE(remaining_balance, amount) AS outstanding,
                        COALESCE(monthly_deduction, COALESCE(remaining_balance, amount)) AS monthly
                 FROM staff_loans WHERE ${col} = $1 AND is_paid = FALSE
                 ORDER BY loan_date ASC, id ASC`, [s.id]);
            data.suggestedLoan = Math.round(loans.rows.reduce((sum, l) => sum + Math.min(parseFloat(l.monthly), parseFloat(l.outstanding)), 0) * 100) / 100;
            data.loanCount = loans.rows.length;
            const cust = await db.query(`SELECT id FROM customers WHERE ${col} = $1 ORDER BY id LIMIT 1`, [s.id]);
            data.creditOutstanding = 0;
            if (cust.rows.length) {
                const cr = await db.query(
                    'SELECT COALESCE(SUM(balance_due), 0) AS t FROM sales_transactions WHERE customer_id = $1 AND balance_due > 0',
                    [cust.rows[0].id]);
                data.creditOutstanding = parseFloat(cr.rows[0].t);
            }

            await saveState(session.id, { flow: 'salarypay', step: 'loan_ded', data });
            let t = `*Pay salary — ${esc(s.name)}* (${esc(s.sub)})\nBase: ${money(s.base)}\nAllowances: ${money(s.allowances)}\nOther deductions: ${money(s.deductions)}`;
            t += `\n\nUnpaid loans: ${data.loanCount} — suggested deduction this month: ${money(data.suggestedLoan)}`;
            t += `\n\nLoan deduction amount? (*-* = use suggestion, *none* = no deduction)\n\n0. Cancel`;
            return sendTelegramText(chatId, t);
        }
        // otherwise treat input as a name search
        rows = await salaryStaffList(text.trim());
        if (!rows.length) return sendTelegramText(chatId, `No staff with a salary setup matches "${esc(text)}". Type another name, or 0 to cancel.`);
        data.matches = rows;
        await saveState(session.id, { flow: 'salarypay', step: 'staff', data });
        let t = 'Pick the staff member (number), or type a name to search:\n';
        rows.forEach((m, i) => { t += `\n${i + 1}. ${esc(m.name)} (${esc(m.sub)}) — net ${money(parseFloat(m.base) + parseFloat(m.allowances) - parseFloat(m.deductions))}`; });
        t += `\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'loan_ded') {
        let amt;
        if (text === '-') amt = data.suggestedLoan;
        else if (text.toLowerCase() === 'none') amt = 0;
        else amt = num(text);
        if (amt === null || amt < 0) return sendTelegramText(chatId, 'Please type a valid amount, *-* for the suggestion, *none* for no deduction — or 0 to cancel.');
        data.loanDed = amt;
        await saveState(session.id, { flow: 'salarypay', step: 'credit_ded', data });
        return sendTelegramText(chatId,
            `Loan deduction: ${money(amt)}.\n\n${esc(data.staff.name)} owes ${money(data.creditOutstanding)} for bread bought on credit.\nDeduct from salary? (amount, or *-* for none)\n\n0. Cancel`);
    }

    if (state.step === 'credit_ded') {
        const amt = text === '-' ? 0 : num(text);
        if (amt === null || amt < 0) return sendTelegramText(chatId, 'Please type a valid amount (or *-* for none), or 0 to cancel.');
        if (amt > data.creditOutstanding) return sendTelegramText(chatId, `They only owe ${money(data.creditOutstanding)} — type that or less, or 0 to cancel.`);
        data.creditDed = amt;
        await saveState(session.id, { flow: 'salarypay', step: 'method', data });
        let t = `Credit-sales deduction: ${money(amt)}.\n\nPayment method?\n`;
        PAYMENT_METHODS.forEach((m, i) => { t += `\n${i + 1}. ${m}`; });
        t += `\n\n0. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'method') {
        const idx = parseInt(text, 10);
        if (isNaN(idx) || idx < 1 || idx > PAYMENT_METHODS.length) {
            return sendTelegramText(chatId, `Reply 1-${PAYMENT_METHODS.length}, or 0 to cancel.`);
        }
        data.method = PAYMENT_METHODS[idx - 1];
        await saveState(session.id, { flow: 'salarypay', step: 'receipt', data });
        return sendTelegramText(chatId, `Method: ${esc(data.method)}.\n\n${RECEIPT_PROMPT}`);
    }

    if (state.step === 'receipt') {
        const r = readReceiptAnswer(chatId, text);
        data.receiptUrl = r.url; data.reference = r.reference;
        const s = data.staff;
        const gross = parseFloat(s.base) + parseFloat(s.allowances);
        const net = gross - parseFloat(s.deductions) - data.loanDed - data.creditDed;
        if (net < 0) {
            await saveState(session.id, {});
            return sendTelegramText(chatId,
                `The deductions (${money(parseFloat(s.deductions) + data.loanDed + data.creditDed)}) are more than the gross pay (${money(gross)}) — payment cancelled. Please do this one in the app.\n\n0. Back to menu`);
        }
        data.net = Math.round(net * 100) / 100;
        data.gross = Math.round(gross * 100) / 100;
        await saveState(session.id, { flow: 'salarypay', step: 'confirm', data });
        const now = new Date();
        const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        let t = `*Confirm salary payment*\nStaff: ${esc(s.name)} (${esc(s.sub)})\nPeriod: ${period}\n`;
        t += `\nBase: ${money(s.base)}\nAllowances: ${money(s.allowances)}\nGross: ${money(data.gross)}`;
        t += `\nOther deductions: -${money(s.deductions)}`;
        if (data.loanDed > 0) t += `\nLoan repayment: -${money(data.loanDed)} (oldest loans first)`;
        if (data.creditDed > 0) t += `\nCredit purchases: -${money(data.creditDed)} (oldest sales first)`;
        t += `\n\n*Net to pay: ${money(data.net)}*\nMethod: ${data.method}\nPaid by: ${esc(user.fullname)}`;
        if (data.reference) t += `\nReference: ${esc(data.reference)}`;
        if (data.receiptUrl) t += `\nReceipt photo: attached ✅`;
        t += `\n\n1. Confirm\n2. Cancel`;
        return sendTelegramText(chatId, t);
    }

    if (state.step === 'confirm') {
        if (text !== '1') {
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Salary payment cancelled. Send *0* for the menu.');
        }
        const result = await processTelegramSalary(data, user);
        await saveState(session.id, {});
        return sendTelegramText(chatId, result + `\n\n0. Back to menu`);
    }
}

async function processTelegramSalary(data, user) {
    const s = data.staff;
    const isStaffMember = s.stype === 'staff_member';
    const col = isStaffMember ? 'staff_member_id' : 'user_id';
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        const ins = await client.query(
            `INSERT INTO salary_payments
                (user_id, staff_member_id, salary_period, payment_date, base_salary, allowances,
                 deductions, tax_amount, pension_amount, net_amount, gross_amount,
                 payment_method, payment_reference, notes, paid_by, status, created_at,
                 loan_deduction, credit_sales_deduction)
             VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, 0, 0, $7, $8, $9, $13,
                     'Recorded via Telegram', $10, 'paid', CURRENT_TIMESTAMP, $11, $12)
             RETURNING id`,
            [isStaffMember ? null : s.id, isStaffMember ? s.id : null, period,
             parseFloat(s.base), parseFloat(s.allowances), parseFloat(s.deductions),
             data.net, data.gross, data.method, user.id, data.loanDed, data.creditDed,
             data.reference || null]);
        const paymentId = ins.rows[0].id;

        // Loan allocation, oldest first
        let loanLeft = data.loanDed;
        let loansCleared = 0;
        let loanApplied = 0;
        if (loanLeft > 0) {
            const loans = await client.query(
                `SELECT id, amount, COALESCE(remaining_balance, amount) AS outstanding
                 FROM staff_loans WHERE ${col} = $1 AND is_paid = FALSE
                 ORDER BY loan_date ASC, id ASC FOR UPDATE`, [s.id]);
            for (const l of loans.rows) {
                if (loanLeft <= 0) break;
                const pay = Math.min(loanLeft, parseFloat(l.outstanding));
                if (pay <= 0) continue;
                await client.query(
                    `INSERT INTO loan_repayments (loan_id, amount, payment_date, salary_payment_id, notes)
                     VALUES ($1, $2, CURRENT_DATE, $3, 'Salary deduction via Telegram')`,
                    [l.id, pay, paymentId]);
                await client.query(
                    `UPDATE staff_loans
                     SET remaining_balance = COALESCE(remaining_balance, amount) - $1,
                         is_paid = (COALESCE(remaining_balance, amount) - $1) <= 0,
                         status = CASE WHEN (COALESCE(remaining_balance, amount) - $1) <= 0 THEN 'completed' ELSE 'active' END
                     WHERE id = $2`, [pay, l.id]);
                loansCleared++;
                loanApplied += pay;
                loanLeft -= pay;
            }
        }

        // Credit-sales deduction, oldest unpaid sales first (via linked customer record)
        let creditAllocated = 0;
        if (data.creditDed > 0) {
            const cust = await client.query(`SELECT id FROM customers WHERE ${col} = $1 ORDER BY id LIMIT 1 FOR UPDATE`, [s.id]);
            if (cust.rows.length) {
                const customerId = cust.rows[0].id;
                const sales = await client.query(
                    `SELECT id, balance_due FROM sales_transactions
                     WHERE customer_id = $1 AND balance_due > 0
                     ORDER BY due_date ASC NULLS LAST, sale_date ASC, id ASC FOR UPDATE`, [customerId]);
                let left = data.creditDed;
                for (const sale of sales.rows) {
                    if (left <= 0) break;
                    const pay = Math.min(left, parseFloat(sale.balance_due));
                    if (pay <= 0) continue;
                    await client.query(
                        `INSERT INTO payments (transaction_id, customer_id, rider_id, amount, payment_date, payment_method, is_rider_payment)
                         VALUES ($1, $2, NULL, $3, CURRENT_DATE, 'Salary deduction', false)`,
                        [sale.id, customerId, pay]);
                    await client.query(
                        `UPDATE sales_transactions
                         SET amount_paid = amount_paid + $1, balance_due = balance_due - $1,
                             status = CASE WHEN balance_due - $1 <= 0 THEN 'Paid' ELSE 'Partially Paid' END,
                             updated_at = CURRENT_TIMESTAMP
                         WHERE id = $2`, [pay, sale.id]);
                    creditAllocated += pay;
                    left -= pay;
                }
                if (creditAllocated > 0) {
                    await client.query('UPDATE customers SET balance = balance - $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
                        [creditAllocated, customerId]);
                }
            }
        }

        await client.query('COMMIT');

        // Money Management mirror — the actual cash paid out
        await recordMoneyTransaction({
            direction: 'OUT', amount: data.net, category: 'salary_payment', payment_method: data.method,
            reference_type: 'salary_payment', reference_id: paymentId,
            description: `Salary payment to ${s.name} (${period}) via Telegram`,
            transaction_date: null, recorded_by: user.id
        });

        let t = `✅ Salary paid to ${esc(s.name)} — net ${money(data.net)} (${data.method}).`;
        if (loanApplied > 0) t += `\n${money(loanApplied)} went to ${loansCleared} loan(s).`;
        if (creditAllocated > 0) t += `\n${money(creditAllocated)} cleared their credit purchases.`;
        return t;
    } catch (e) {
        await client.query('ROLLBACK');
        console.error('Telegram salary error:', e);
        return 'Failed to record the salary payment — nothing was saved. Please try again or use the app.';
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// Authenticated app endpoints (the webhook route above stays open)
// ---------------------------------------------------------------------------
router.use(authenticate);

// GET /api/telegram/status — bot configuration + linked state for this user
router.get('/status', async (req, res) => {
    const cfg = await getTelegramConfig();
    res.json({
        configured: cfg.configured,
        enabled: cfg.enabled
    });
});

// POST /api/telegram/setup-webhook — points the bot at this server (admin only)
router.post('/setup-webhook', async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can set up the webhook.' });
    const cfg = await getTelegramConfig();
    if (!cfg.configured) return res.status(400).json({ error: 'Save the bot token in Settings first.' });
    try {
        const host = req.get('host');
        const url = `https://${host}/api/telegram/webhook`;
        const r = await axios.post(`https://api.telegram.org/bot${cfg.bot_token}/setWebhook`, { url }, { timeout: 15000 });
        // Fetch bot identity for confirmation
        let bot = null;
        try {
            const me = await axios.get(`https://api.telegram.org/bot${cfg.bot_token}/getMe`, { timeout: 15000 });
            bot = me.data?.result?.username || null;
        } catch (_) { /* ignore */ }
        res.json({ success: !!r.data?.ok, webhook_url: url, telegram_response: r.data, bot_username: bot });
    } catch (e) {
        res.status(500).json({ error: 'Failed to set webhook.', details: e.response?.data || e.message });
    }
});

// GET /api/telegram/link-status — is the logged-in user's Telegram linked?
router.get('/link-status', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT chat_id, last_active_at FROM telegram_sessions
             WHERE user_id = $1 AND is_authenticated = true AND chat_id NOT LIKE 'pending:%'`,
            [req.user.id]);
        if (!r.rows.length) return res.json({ linked: false });
        res.json({ linked: true, chat_id: r.rows[0].chat_id, last_active_at: r.rows[0].last_active_at });
    } catch (e) {
        res.status(500).json({ error: 'Failed to check Telegram link status.' });
    }
});

// POST /api/telegram/link-code — generate a 6-digit one-time code
router.post('/link-code', async (req, res) => {
    try {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        const expires = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

        const existing = await db.query('SELECT id FROM telegram_sessions WHERE user_id = $1', [req.user.id]);
        if (existing.rows.length) {
            await db.query(
                `UPDATE telegram_sessions SET login_code = $1, login_code_expires_at = $2 WHERE user_id = $3`,
                [code, expires, req.user.id]);
        } else {
            await db.query(
                `INSERT INTO telegram_sessions (chat_id, user_id, is_authenticated, login_code, login_code_expires_at, session_state, last_active_at)
                 VALUES ($1, $2, false, $3, $4, '{}', NOW())
                 ON CONFLICT (chat_id) DO UPDATE SET login_code = $3, login_code_expires_at = $4, user_id = $2`,
                [`pending:${req.user.id}`, req.user.id, code, expires]);
        }
        res.json({ code, expires_at: expires, ttl_minutes: CODE_TTL_MINUTES });
    } catch (e) {
        console.error('Telegram link-code error:', e);
        res.status(500).json({ error: 'Failed to generate a Telegram code.' });
    }
});

// POST /api/telegram/unlink — disconnect the user's Telegram
router.post('/unlink', async (req, res) => {
    try {
        await db.query('DELETE FROM telegram_sessions WHERE user_id = $1', [req.user.id]);
        res.json({ message: 'Telegram unlinked.' });
    } catch (e) {
        res.status(500).json({ error: 'Failed to unlink Telegram.' });
    }
});

module.exports = router;
