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
// Main menu — filtered by the user's role permissions (admin Permissions page)
// ---------------------------------------------------------------------------
const MENU_ITEMS = [
    { key: 'dashboard', label: 'Dashboard summary', perm: 'dashboard.view' },
    { key: 'sales', label: 'Sales', perm: 'sales.view' },
    { key: 'customers', label: 'Customers & debts', perm: 'customers.view' },
    { key: 'products', label: 'Products & prices', perm: 'products.view' },
    { key: 'payment', label: 'Record a payment', perm: 'payments.create' },
    { key: 'expenses', label: 'Expenses', perm: 'expenses.view' },
    { key: 'riders', label: 'Riders', perm: 'riders.view' },
    { key: 'reports', label: 'Reports (sales vs expenses)', perm: 'reports.view' },
    { key: 'chat', label: 'Team Chat inbox', perm: 'chat.view' },
    { key: 'ai', label: 'Ask the assistant', perm: 'ai_assistant.view' },
];

async function buildMenu(role) {
    const options = [];
    for (const item of MENU_ITEMS) {
        if (await checkPermission(role, item.perm)) options.push(item);
    }
    return options;
}

function menuText(user, options) {
    let t = `*Purple Premium Bread* — Telegram\nHello ${esc(user.fullname)} (${esc(user.role)}). What would you like to do?\n`;
    options.forEach((o, i) => { t += `\n${i + 1}. ${o.label}`; });
    t += `\n\nReply with a number. Send *0* anytime to return to this menu, or *logout* to unlink this account.`;
    return t;
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
        if (!msg.text) {
            await sendTelegramText(chatId, 'Sorry, I only understand text messages for now. Send *hi* to see the menu.');
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
        await startFlow(chatId, user, session, choice.key);
        return;
    }

    switch (flow) {
        case 'sales': return salesFlow(chatId, user, session, state, text);
        case 'customers': return customersFlow(chatId, user, session, state, text);
        case 'products': return productsFlow(chatId, user, session, state, text);
        case 'payment': return paymentFlow(chatId, user, session, state, text);
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
        case 'sales': {
            await saveState(session.id, { flow: 'sales', step: 'menu' });
            return sendTelegramText(chatId,
                `*Sales*\n1. Today\n2. This week\n3. This month\n4. Find a sale by number\n\n0. Back to menu`);
        }
        case 'customers': {
            await saveState(session.id, { flow: 'customers', step: 'menu' });
            return sendTelegramText(chatId,
                `*Customers & debts*\n1. Top debtors\n2. Search a customer\n3. Customer count\n\n0. Back to menu`);
        }
        case 'products': {
            await saveState(session.id, { flow: 'products', step: 'search' });
            return sendTelegramText(chatId,
                `*Products*\nType part of a product name to see its price and category.\n\n0. Back to menu`);
        }
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
        case 'riders': {
            const r = await db.query(
                `SELECT fullname, phone_number, current_balance FROM riders ORDER BY current_balance DESC LIMIT 15`);
            let t = `*Riders*\n`;
            if (!r.rows.length) t += 'No riders found.';
            r.rows.forEach((x, i) => {
                t += `\n${i + 1}. ${esc(x.fullname)} — balance ${money(x.current_balance)}`;
            });
            t += `\n\n0. Back to menu`;
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, t);
        }
        case 'reports': {
            await saveState(session.id, { flow: 'reports', step: 'menu' });
            return sendTelegramText(chatId,
                `*Reports*\n1. Today\n2. This week\n3. This month\n\n0. Back to menu`);
        }
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
        if (text === '4') {
            await saveState(session.id, { flow: 'sales', step: 'find' });
            return sendTelegramText(chatId, 'Type the sale number (e.g. 125):\n\n0. Back to menu');
        }
        const period = { '1': 'today', '2': 'week', '3': 'month' }[text];
        if (!period) return sendTelegramText(chatId, 'Reply 1, 2, 3 or 4 — or 0 for the menu.');
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
        t += `\n\n0. Back to menu`;
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
        let t = `*Sale #${s.id}*\n${esc(s.party)}\nDate: ${new Date(s.sale_date).toLocaleDateString('en-NG')}`;
        t += `\nTotal: ${money(s.total_amount)}\nPaid: ${money(s.amount_paid)}\nBalance: ${money(s.balance_due)}`;
        t += `\nMethod: ${esc(s.payment_method || 'n/a')} — Status: ${esc(s.status || 'n/a')}`;
        t += `\n\n0. Back to menu`;
        await saveState(session.id, { flow: 'menu-done' });
        return sendTelegramText(chatId, t);
    }
}

async function customersFlow(chatId, user, session, state, text) {
    if (state.step === 'menu') {
        if (text === '1') {
            const r = await db.query(
                `SELECT fullname, balance FROM customers WHERE balance > 0 ORDER BY balance DESC LIMIT 10`);
            let t = `*Top debtors*\n`;
            if (!r.rows.length) t += 'No customer owes anything right now. 🎉';
            r.rows.forEach((c, i) => { t += `\n${i + 1}. ${esc(c.fullname)} — ${money(c.balance)}`; });
            t += `\n\n0. Back to menu`;
            await saveState(session.id, { flow: 'menu-done' });
            return sendTelegramText(chatId, t);
        }
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
        await saveState(session.id, { flow: 'payment', step: 'confirm', data });
        return sendTelegramText(chatId,
            `*Confirm payment*\nFrom: ${esc(data.owner.fullname)} (${data.isRider ? 'Rider' : 'Customer'})\nAmount: ${money(data.amount)}\nMethod: ${data.method}\nRecorded by: ${esc(user.fullname)}\n\nIt will clear their oldest unpaid sales first. Any extra goes to their advance wallet.\n\n1. Confirm\n2. Cancel`);
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
                `INSERT INTO payments (transaction_id, customer_id, rider_id, amount, payment_date, payment_method, is_rider_payment)
                 VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, $6) RETURNING id`,
                [sale.id, isRider ? null : ownerId, isRider ? ownerId : null, pay, method, isRider]
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
        await saveState(session.id, { flow: 'expenses', step: 'confirm', data });
        return sendTelegramText(chatId,
            `*Confirm expense*\nCategory: ${data.category}\nType: ${data.expenseType}\nAmount: ${money(data.amount)}\nDescription: ${esc(data.description || '—')}\nRecorded by: ${esc(user.fullname)}\n\n1. Confirm\n2. Cancel`);
    }

    if (state.step === 'confirm') {
        if (text !== '1') {
            await saveState(session.id, {});
            return sendTelegramText(chatId, 'Expense cancelled. Send *0* for the menu.');
        }
        try {
            const r = await db.query(
                `INSERT INTO operating_expenses (expense_date, expense_type, description, amount, category, payment_method, recorded_by, is_recurring)
                 VALUES (CURRENT_DATE, $1, $2, $3, $4, 'Cash', $5, false) RETURNING id`,
                [data.expenseType, data.description, data.amount, data.category, user.id]);
            await recordMoneyTransaction({
                direction: 'OUT', amount: data.amount, category: 'expense',
                reference_type: 'expense', reference_id: r.rows[0].id,
                description: `Expense — ${data.expenseType} (via Telegram)`,
                payment_method: 'Cash', transaction_date: null, recorded_by: user.id
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
