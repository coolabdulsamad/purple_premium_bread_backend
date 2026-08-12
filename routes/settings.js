// routes/settings.js — System settings (app_settings table from migration 001).
//
// GET  /api/settings         → all settings (admin only; secret values masked)
// PUT  /api/settings/:key    → upsert one setting (admin only, audited)
//
// Values are stored as JSONB strings (matching how aiAssistant.js / whatsapp.js
// read them). Secret rows (is_secret = true) are never returned in full —
// the API only reports whether they are set; submitting an empty value for a
// secret key leaves the stored value untouched.
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const authenticate = require('../middleware/authenticate');
const { logAudit } = require('../utils/audit');

router.use(authenticate);

// Settings management is an admin-only area
router.use((req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only admins can manage system settings.' });
    }
    next();
});

// GET /api/settings — list all settings grouped for the Settings page
router.get('/', async (req, res) => {
    try {
        const r = await db.query(
            `SELECT id, setting_key, setting_value, category, is_secret
             FROM app_settings ORDER BY category NULLS LAST, setting_key`
        );
        const settings = r.rows.map(row => {
            const raw = String(row.setting_value ?? '').replace(/^"|"$/g, '');
            if (row.is_secret) {
                return {
                    setting_key: row.setting_key,
                    category: row.category,
                    is_secret: true,
                    is_set: raw.trim().length > 0,
                    setting_value: '' // never leak secrets to the browser
                };
            }
            return {
                setting_key: row.setting_key,
                category: row.category,
                is_secret: false,
                is_set: raw.trim().length > 0,
                setting_value: raw
            };
        });
        res.json(settings);
    } catch (e) {
        console.error('Settings list error:', e);
        res.status(500).json({ error: 'Failed to load settings.' });
    }
});

// PUT /api/settings/:key — upsert one setting. Body: { value }
router.put('/:key', async (req, res) => {
    const key = req.params.key;
    const value = req.body?.value;

    if (!/^[a-z0-9_.-]+$/i.test(key) || key.length > 80) {
        return res.status(400).json({ error: 'Invalid setting key.' });
    }
    if (value === undefined || value === null) {
        return res.status(400).json({ error: 'Provide a value.' });
    }

    try {
        // Secret keys: empty submission = keep the current stored value
        const existing = await db.query(
            'SELECT is_secret, setting_value FROM app_settings WHERE setting_key = $1', [key]);
        if (existing.rows.length && existing.rows[0].is_secret && String(value).trim() === '') {
            return res.json({ message: 'Secret unchanged.', setting_key: key });
        }

        const jsonVal = JSON.stringify(String(value));
        const looksSecret = /api_key|token|secret/i.test(key);
        await db.query(
            `INSERT INTO app_settings (setting_key, setting_value, category, is_secret)
             VALUES ($1, $2::jsonb, $3, $4)
             ON CONFLICT (setting_key) DO UPDATE SET setting_value = $2::jsonb`,
            [key, jsonVal, key.split('.')[0] || 'general', looksSecret]
        );

        await logAudit({
            user: req.user,
            action: 'UPDATE',
            entityType: 'settings',
            entityId: key,
            description: `Setting "${key}" updated`,
            req
        });

        res.json({ message: 'Setting saved.', setting_key: key });
    } catch (e) {
        console.error('Settings update error:', e);
        res.status(500).json({ error: 'Failed to save setting.' });
    }
});

module.exports = router;
