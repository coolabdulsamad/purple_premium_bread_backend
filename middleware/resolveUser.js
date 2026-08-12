// middleware/resolveUser.js — non-blocking auth resolver.
// If an Authorization Bearer token is present and valid, attaches req.user.
// If absent/invalid, the request continues WITHOUT req.user — existing
// route-level auth behavior is completely unchanged.
const jwt = require('jsonwebtoken');
const config = require('../config');

module.exports = function resolveUser(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (authHeader) {
        const token = authHeader.split(' ')[1];
        if (token) {
            try {
                req.user = jwt.verify(token, config.JWT_SECRET);
            } catch (_) {
                // invalid token — leave req.user unset; route-level auth will handle it
            }
        }
    }
    next();
};
