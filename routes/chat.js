// routes/chat.js — Internal staff chat (Feature #7: direct + group conversations,
// with references to business records: products, sales, payments, customers, riders).
//
// Tables (created by db/migrations/001_system_upgrades_foundation.sql):
//   chat_conversations (id, type 'direct'|'group', name, created_by, created_at, updated_at)
//   chat_participants  (id, conversation_id, user_id, last_read_at, joined_at)
//   chat_messages      (id, conversation_id, sender_id, message_text,
//                       reference_type, reference_id, reference_snapshot JSONB,
//                       is_deleted, created_at)
//
// reference_snapshot stores a display copy { type, id, title, subtitle, path }
// at send time, so a reference still renders even if the record is later edited.

const express = require('express');
const router = express.Router();
const db = require('../db/db');

function requireAuth(req, res, next) {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    next();
}
router.use(requireAuth);

const N = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const money = (v) => '₦' + N(v).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ---------------------------------------------------------------------------
// Reference resolution: validate + build display snapshot for each ref type
// ---------------------------------------------------------------------------
const REFERENCE_TYPES = {
    product: {
        path: '/products',
        async fetch(id) {
            const r = await db.query('SELECT id, name, price, category FROM products WHERE id = $1', [id]);
            if (!r.rows.length) return null;
            const p = r.rows[0];
            return { title: p.name, subtitle: `${p.category || 'Product'} · ${money(p.price)}` };
        },
        async search(q) {
            const r = await db.query(
                'SELECT id, name, price, category FROM products WHERE name ILIKE $1 ORDER BY name LIMIT 10',
                [`%${q}%`]
            );
            return r.rows.map(p => ({ id: p.id, title: p.name, subtitle: `${p.category || 'Product'} · ${money(p.price)}` }));
        }
    },
    sale: {
        path: '/sales-history',
        async fetch(id) {
            const r = await db.query(
                `SELECT st.id, st.total_amount, st.sale_date, st.payment_method, st.status,
                        COALESCE(c.fullname, r2.fullname, b.name, 'Walk-in Customer') AS party
                 FROM sales_transactions st
                 LEFT JOIN customers c ON st.customer_id = c.id
                 LEFT JOIN riders r2 ON st.rider_id = r2.id
                 LEFT JOIN branches b ON st.branch_id = b.id
                 WHERE st.id = $1`, [id]);
            if (!r.rows.length) return null;
            const s = r.rows[0];
            return { title: `Sale #${s.id}`, subtitle: `${s.party} · ${money(s.total_amount)} · ${s.status || ''}`.trim() };
        },
        async search(q) {
            const r = await db.query(
                `SELECT st.id, st.total_amount, st.status,
                        COALESCE(c.fullname, r2.fullname, b.name, 'Walk-in Customer') AS party
                 FROM sales_transactions st
                 LEFT JOIN customers c ON st.customer_id = c.id
                 LEFT JOIN riders r2 ON st.rider_id = r2.id
                 LEFT JOIN branches b ON st.branch_id = b.id
                 WHERE (CAST(st.id AS TEXT) ILIKE $1 OR c.fullname ILIKE $1 OR r2.fullname ILIKE $1)
                 ORDER BY st.id DESC LIMIT 10`, [`%${q}%`]);
            return r.rows.map(s => ({ id: s.id, title: `Sale #${s.id}`, subtitle: `${s.party} · ${money(s.total_amount)} · ${s.status || ''}`.trim() }));
        }
    },
    payment: {
        path: '/payments',
        async fetch(id) {
            const r = await db.query(
                `SELECT p.id, p.amount, p.payment_method, p.payment_date,
                        COALESCE(c.fullname, r2.fullname, 'N/A') AS payer
                 FROM payments p
                 LEFT JOIN customers c ON p.customer_id = c.id
                 LEFT JOIN riders r2 ON p.rider_id = r2.id
                 WHERE p.id = $1`, [id]);
            if (!r.rows.length) return null;
            const p = r.rows[0];
            return { title: `Payment #${p.id}`, subtitle: `${p.payer} · ${money(p.amount)} · ${p.payment_method || ''}`.trim() };
        },
        async search(q) {
            const r = await db.query(
                `SELECT p.id, p.amount, p.payment_method,
                        COALESCE(c.fullname, r2.fullname, 'N/A') AS payer
                 FROM payments p
                 LEFT JOIN customers c ON p.customer_id = c.id
                 LEFT JOIN riders r2 ON p.rider_id = r2.id
                 WHERE (CAST(p.id AS TEXT) ILIKE $1 OR c.fullname ILIKE $1 OR r2.fullname ILIKE $1)
                 ORDER BY p.id DESC LIMIT 10`, [`%${q}%`]);
            return r.rows.map(p => ({ id: p.id, title: `Payment #${p.id}`, subtitle: `${p.payer} · ${money(p.amount)} · ${p.payment_method || ''}`.trim() }));
        }
    },
    customer: {
        path: '/customers',
        async fetch(id) {
            const r = await db.query('SELECT id, fullname, phone, balance FROM customers WHERE id = $1', [id]);
            if (!r.rows.length) return null;
            const c = r.rows[0];
            return { title: c.fullname, subtitle: `Customer${c.phone ? ' · ' + c.phone : ''} · Balance ${money(c.balance)}` };
        },
        async search(q) {
            const r = await db.query(
                'SELECT id, fullname, phone, balance FROM customers WHERE fullname ILIKE $1 ORDER BY fullname LIMIT 10',
                [`%${q}%`]
            );
            return r.rows.map(c => ({ id: c.id, title: c.fullname, subtitle: `Customer${c.phone ? ' · ' + c.phone : ''} · Balance ${money(c.balance)}` }));
        }
    },
    rider: {
        path: '/riders',
        async fetch(id) {
            const r = await db.query('SELECT id, fullname, phone_number, current_balance FROM riders WHERE id = $1', [id]);
            if (!r.rows.length) return null;
            const x = r.rows[0];
            return { title: x.fullname, subtitle: `Rider${x.phone_number ? ' · ' + x.phone_number : ''} · Balance ${money(x.current_balance)}` };
        },
        async search(q) {
            const r = await db.query(
                'SELECT id, fullname, phone_number, current_balance FROM riders WHERE fullname ILIKE $1 ORDER BY fullname LIMIT 10',
                [`%${q}%`]
            );
            return r.rows.map(x => ({ id: x.id, title: x.fullname, subtitle: `Rider${x.phone_number ? ' · ' + x.phone_number : ''} · Balance ${money(x.current_balance)}` }));
        }
    }
};

async function isParticipant(convId, userId) {
    const r = await db.query(
        'SELECT 1 FROM chat_participants WHERE conversation_id = $1 AND user_id = $2',
        [convId, userId]
    );
    return r.rows.length > 0;
}

async function getConversation(convId) {
    const r = await db.query('SELECT * FROM chat_conversations WHERE id = $1', [convId]);
    return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// GET /api/chat/users — staff directory for starting chats / building groups
// ---------------------------------------------------------------------------
router.get('/users', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT id, fullname, role FROM users WHERE id <> $1 ORDER BY fullname',
            [req.user.id]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Chat users error:', error);
        res.status(500).json({ error: 'Failed to load users.', details: error.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/chat/references/search?type=product&q=... — entity picker data
// ---------------------------------------------------------------------------
router.get('/references/search', async (req, res) => {
    const { type, q } = req.query;
    const handler = REFERENCE_TYPES[type];
    if (!handler) {
        return res.status(400).json({ error: `Unknown reference type '${type}'. Use: ${Object.keys(REFERENCE_TYPES).join(', ')}` });
    }
    try {
        const rows = await handler.search(String(q || '').trim());
        res.status(200).json(rows.map(r => ({ ...r, type, path: handler.path })));
    } catch (error) {
        console.error('Chat reference search error:', error);
        res.status(500).json({ error: 'Failed to search references.', details: error.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/chat/conversations — my conversations, latest first
// ---------------------------------------------------------------------------
router.get('/conversations', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT
                c.id, c.type, c.name, c.created_at, c.updated_at,
                CASE WHEN c.type = 'direct' THEN (
                    SELECT u.fullname FROM chat_participants cp
                    JOIN users u ON u.id = cp.user_id
                    WHERE cp.conversation_id = c.id AND cp.user_id <> $1 LIMIT 1
                ) ELSE c.name END AS display_name,
                (SELECT COUNT(*) FROM chat_participants WHERE conversation_id = c.id) AS member_count,
                (SELECT json_build_object(
                        'text', LEFT(m.message_text, 90),
                        'sender_name', su.fullname,
                        'reference_type', m.reference_type,
                        'created_at', m.created_at)
                 FROM chat_messages m JOIN users su ON su.id = m.sender_id
                 WHERE m.conversation_id = c.id AND m.is_deleted = false
                 ORDER BY m.id DESC LIMIT 1) AS last_message,
                (SELECT COUNT(*) FROM chat_messages m
                 WHERE m.conversation_id = c.id AND m.is_deleted = false AND m.sender_id <> $1
                   AND (p.last_read_at IS NULL OR m.created_at > p.last_read_at)) AS unread_count
             FROM chat_conversations c
             JOIN chat_participants p ON p.conversation_id = c.id AND p.user_id = $1
             ORDER BY c.updated_at DESC`,
            [req.user.id]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Chat conversations error:', error);
        res.status(500).json({ error: 'Failed to load conversations.', details: error.message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/chat/conversations — start a direct chat or create a group
// body: { type: 'direct', user_id } | { type: 'group', name, member_ids: [] }
// ---------------------------------------------------------------------------
router.post('/conversations', async (req, res) => {
    const { type, user_id, name, member_ids } = req.body || {};

    try {
        if (type === 'direct') {
            const otherId = parseInt(user_id, 10);
            if (!otherId || otherId === req.user.id) {
                return res.status(400).json({ error: 'A valid user_id (not yourself) is required for a direct chat.' });
            }
            const other = await db.query('SELECT id, fullname FROM users WHERE id = $1', [otherId]);
            if (!other.rows.length) return res.status(404).json({ error: 'User not found.' });

            // Reuse an existing direct conversation between the two users
            const existing = await db.query(
                `SELECT c.id FROM chat_conversations c
                 WHERE c.type = 'direct'
                   AND EXISTS (SELECT 1 FROM chat_participants WHERE conversation_id = c.id AND user_id = $1)
                   AND EXISTS (SELECT 1 FROM chat_participants WHERE conversation_id = c.id AND user_id = $2)
                 LIMIT 1`,
                [req.user.id, otherId]
            );
            if (existing.rows.length) {
                return res.status(200).json({ id: existing.rows[0].id, type: 'direct', display_name: other.rows[0].fullname, reused: true });
            }

            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');
                const conv = await client.query(
                    `INSERT INTO chat_conversations (type, created_by) VALUES ('direct', $1) RETURNING id`,
                    [req.user.id]
                );
                const convId = conv.rows[0].id;
                await client.query(
                    `INSERT INTO chat_participants (conversation_id, user_id) VALUES ($1, $2), ($1, $3)`,
                    [convId, req.user.id, otherId]
                );
                await client.query('COMMIT');
                return res.status(201).json({ id: convId, type: 'direct', display_name: other.rows[0].fullname });
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        }

        if (type === 'group') {
            const groupName = String(name || '').trim();
            if (!groupName) return res.status(400).json({ error: 'A group name is required.' });
            const memberIds = [...new Set((Array.isArray(member_ids) ? member_ids : [])
                .map(x => parseInt(x, 10))
                .filter(x => Number.isInteger(x) && x > 0 && x !== req.user.id))];
            if (memberIds.length === 0) {
                return res.status(400).json({ error: 'Select at least one other member for the group.' });
            }
            // Validate all members exist
            const valid = await db.query(
                'SELECT id FROM users WHERE id = ANY($1::int[])', [memberIds]
            );
            if (valid.rows.length !== memberIds.length) {
                return res.status(400).json({ error: 'One or more selected members do not exist.' });
            }

            const client = await db.pool.connect();
            try {
                await client.query('BEGIN');
                const conv = await client.query(
                    `INSERT INTO chat_conversations (type, name, created_by) VALUES ('group', $1, $2) RETURNING id`,
                    [groupName, req.user.id]
                );
                const convId = conv.rows[0].id;
                for (const uid of [req.user.id, ...memberIds]) {
                    await client.query(
                        'INSERT INTO chat_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                        [convId, uid]
                    );
                }
                await client.query('COMMIT');
                return res.status(201).json({ id: convId, type: 'group', display_name: groupName });
            } catch (e) {
                await client.query('ROLLBACK');
                throw e;
            } finally {
                client.release();
            }
        }

        return res.status(400).json({ error: "type must be 'direct' or 'group'." });
    } catch (error) {
        console.error('Chat create conversation error:', error);
        res.status(500).json({ error: 'Failed to create conversation.', details: error.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/chat/conversations/:id — details + participants (must be a member)
// ---------------------------------------------------------------------------
router.get('/conversations/:id', async (req, res) => {
    const convId = parseInt(req.params.id, 10);
    try {
        if (!(await isParticipant(convId, req.user.id))) {
            return res.status(403).json({ error: 'You are not a member of this conversation.' });
        }
        const conv = await getConversation(convId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

        const members = await db.query(
            `SELECT u.id, u.fullname, u.role, p.joined_at, p.last_read_at
             FROM chat_participants p JOIN users u ON u.id = p.user_id
             WHERE p.conversation_id = $1 ORDER BY u.fullname`,
            [convId]
        );
        let displayName = conv.name;
        if (conv.type === 'direct') {
            const other = members.rows.find(m => m.id !== req.user.id);
            displayName = other ? other.fullname : conv.name;
        }
        res.status(200).json({ ...conv, display_name: displayName, members: members.rows });
    } catch (error) {
        console.error('Chat conversation details error:', error);
        res.status(500).json({ error: 'Failed to load conversation.', details: error.message });
    }
});

// ---------------------------------------------------------------------------
// GET /api/chat/conversations/:id/messages?before_id=&limit=
// Newest page first (id DESC), reversed to ascending before responding.
// ---------------------------------------------------------------------------
router.get('/conversations/:id/messages', async (req, res) => {
    const convId = parseInt(req.params.id, 10);
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
    const beforeId = parseInt(req.query.before_id, 10) || null;

    try {
        if (!(await isParticipant(convId, req.user.id))) {
            return res.status(403).json({ error: 'You are not a member of this conversation.' });
        }
        const params = [convId, limit];
        let where = 'm.conversation_id = $1 AND m.is_deleted = false';
        if (beforeId) {
            params.push(beforeId);
            where += ` AND m.id < $${params.length}`;
        }
        const result = await db.query(
            `SELECT m.id, m.conversation_id, m.sender_id, m.message_text,
                    m.reference_type, m.reference_id, m.reference_snapshot, m.created_at,
                    u.fullname AS sender_name, u.role AS sender_role
             FROM chat_messages m
             JOIN users u ON u.id = m.sender_id
             WHERE ${where}
             ORDER BY m.id DESC
             LIMIT $2`,
            params
        );
        res.status(200).json(result.rows.reverse());
    } catch (error) {
        console.error('Chat messages error:', error);
        res.status(500).json({ error: 'Failed to load messages.', details: error.message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/chat/conversations/:id/messages — send a message
// body: { message_text?, reference?: { type, id } }
// The reference is validated and snapshotted server-side; the message_text
// serves as the caption shown under the reference card.
// ---------------------------------------------------------------------------
router.post('/conversations/:id/messages', async (req, res) => {
    const convId = parseInt(req.params.id, 10);
    const { message_text, reference } = req.body || {};
    const text = String(message_text || '').trim();

    try {
        if (!(await isParticipant(convId, req.user.id))) {
            return res.status(403).json({ error: 'You are not a member of this conversation.' });
        }

        let refType = null, refId = null, refSnapshot = null;
        if (reference && reference.type && reference.id) {
            const handler = REFERENCE_TYPES[reference.type];
            if (!handler) {
                return res.status(400).json({ error: `Unknown reference type '${reference.type}'.` });
            }
            const snap = await handler.fetch(parseInt(reference.id, 10));
            if (!snap) {
                return res.status(404).json({ error: `${reference.type} #${reference.id} was not found.` });
            }
            refType = reference.type;
            refId = parseInt(reference.id, 10);
            refSnapshot = { type: refType, id: refId, title: snap.title, subtitle: snap.subtitle, path: handler.path };
        }

        if (!text && !refSnapshot) {
            return res.status(400).json({ error: 'A message needs text, a reference, or both.' });
        }

        const client = await db.pool.connect();
        try {
            await client.query('BEGIN');
            const inserted = await client.query(
                `INSERT INTO chat_messages
                    (conversation_id, sender_id, message_text, reference_type, reference_id, reference_snapshot)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, conversation_id, sender_id, message_text, reference_type, reference_id, reference_snapshot, created_at`,
                [convId, req.user.id, text || null, refType, refId, refSnapshot ? JSON.stringify(refSnapshot) : null]
            );
            await client.query(
                'UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
                [convId]
            );
            // Sending implies reading up to now
            await client.query(
                'UPDATE chat_participants SET last_read_at = CURRENT_TIMESTAMP WHERE conversation_id = $1 AND user_id = $2',
                [convId, req.user.id]
            );
            await client.query('COMMIT');

            const row = inserted.rows[0];
            res.status(201).json({ ...row, sender_name: req.user.fullname, sender_role: req.user.role });
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Chat send message error:', error);
        res.status(500).json({ error: 'Failed to send message.', details: error.message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/chat/conversations/:id/read — mark everything read
// ---------------------------------------------------------------------------
router.post('/conversations/:id/read', async (req, res) => {
    const convId = parseInt(req.params.id, 10);
    try {
        if (!(await isParticipant(convId, req.user.id))) {
            return res.status(403).json({ error: 'You are not a member of this conversation.' });
        }
        await db.query(
            'UPDATE chat_participants SET last_read_at = CURRENT_TIMESTAMP WHERE conversation_id = $1 AND user_id = $2',
            [convId, req.user.id]
        );
        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Chat mark read error:', error);
        res.status(500).json({ error: 'Failed to mark as read.', details: error.message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/chat/conversations/:id/members — add members to a group
// body: { member_ids: [] }  (any current participant may add)
// ---------------------------------------------------------------------------
router.post('/conversations/:id/members', async (req, res) => {
    const convId = parseInt(req.params.id, 10);
    const memberIds = [...new Set((Array.isArray(req.body?.member_ids) ? req.body.member_ids : [])
        .map(x => parseInt(x, 10))
        .filter(x => Number.isInteger(x) && x > 0))];

    try {
        if (!(await isParticipant(convId, req.user.id))) {
            return res.status(403).json({ error: 'You are not a member of this conversation.' });
        }
        const conv = await getConversation(convId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
        if (conv.type !== 'group') {
            return res.status(400).json({ error: 'Members can only be added to group conversations.' });
        }
        if (!memberIds.length) {
            return res.status(400).json({ error: 'member_ids must be a non-empty array.' });
        }

        let added = 0;
        for (const uid of memberIds) {
            const r = await db.query(
                'INSERT INTO chat_participants (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
                [convId, uid]
            );
            added += r.rowCount;
        }
        res.status(200).json({ ok: true, added });
    } catch (error) {
        console.error('Chat add members error:', error);
        res.status(500).json({ error: 'Failed to add members.', details: error.message });
    }
});

// ---------------------------------------------------------------------------
// POST /api/chat/conversations/:id/leave — leave a group
// ---------------------------------------------------------------------------
router.post('/conversations/:id/leave', async (req, res) => {
    const convId = parseInt(req.params.id, 10);
    try {
        if (!(await isParticipant(convId, req.user.id))) {
            return res.status(403).json({ error: 'You are not a member of this conversation.' });
        }
        const conv = await getConversation(convId);
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });
        if (conv.type !== 'group') {
            return res.status(400).json({ error: 'You cannot leave a direct conversation.' });
        }
        await db.query(
            'DELETE FROM chat_participants WHERE conversation_id = $1 AND user_id = $2',
            [convId, req.user.id]
        );
        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Chat leave error:', error);
        res.status(500).json({ error: 'Failed to leave conversation.', details: error.message });
    }
});

module.exports = router;
