// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../db/db');
const config = require('../config');

// Registration route with new fields
router.post('/register', async (req, res) => {
  const { username, password, role, fullname, email, phone_number, gender } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.query(
      `INSERT INTO users (username, password, role, fullname, email, phone_number, gender)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [username, hashedPassword, role, fullname, email, phone_number, gender]
    );
    res.status(201).json({ message: 'User registered successfully!', user: result.rows[0] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login route
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await db.query('SELECT * FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    const validPassword = await bcrypt.compare(password, user.rows[0].password);
    if (!validPassword) {
      return res.status(401).json({ message: 'Invalid username or password' });
    }

    if (user.rows[0].is_active === false) {
      return res.status(403).json({ message: 'This account has been deactivated. Please contact an administrator.' });
    }

    const token = jwt.sign(
      { id: user.rows[0].id, username: user.rows[0].username, role: user.rows[0].role }, // payload
      config.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      message: 'Logged in successfully!',
      token,
      role: user.rows[0].role,
      user: {
        id: user.rows[0].id,
        username: user.rows[0].username,
        full_name: user.rows[0].fullname,
        email: user.rows[0].email,
        phone_number: user.rows[0].phone_number,
        gender: user.rows[0].gender,
        role: user.rows[0].role
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
