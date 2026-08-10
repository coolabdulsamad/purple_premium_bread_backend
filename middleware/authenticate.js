const jwt = require('jsonwebtoken');
const config = require('../config');

module.exports = function authenticate(req, res, next) {
    const authHeader = req.headers['authorization'];
    if (!authHeader) {
        return res.status(401).json({ error: 'No token provided.' });
    }
    const token = authHeader.split(' ')[1];
    if (!token) {
        return res.status(401).json({ error: 'Malformed token.' });
    }
    try {
        const decoded = jwt.verify(token, config.JWT_SECRET);
        req.user = decoded; // decoded should have user info (e.g., id)
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid token.' });
    }
};
