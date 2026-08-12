// config/index.js — Centralized configuration for Purple Premium Bread backend
// All secrets should be set via environment variables in production (Render dashboard).
require('dotenv').config();

module.exports = {
    // JWT secret — MUST be identical for signing (login) and verifying (middleware).
    // Previously the fallbacks differed ('supersecretkey' vs 'your_jwt_secret'),
    // which broke every token whenever JWT_SECRET was missing from the environment.
    JWT_SECRET: process.env.JWT_SECRET || 'purple_premium_bread_dev_secret_change_me',

    // ImgBB image hosting key. Set IMGBB_API_KEY in the environment.
    // TODO: rotate this key on ImgBB — it was previously committed to the repo.
    IMGBB_API_KEY: process.env.IMGBB_API_KEY || '77c9bd669b4a5491c1ec247d8d79e866',

    // Corporate tax rate used by the Profit & Loss report (previously hardcoded 30%).
    TAX_RATE: parseFloat(process.env.TAX_RATE || '0.30'),

    PORT: process.env.PORT || 5000,
};
