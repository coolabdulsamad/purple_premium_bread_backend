// routes/wasteStock.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// GET all waste stock entries
router.get('/', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT ws.*, p.name as product_name, p.price, u.fullname as recorded_by_name
      FROM waste_stock ws
      JOIN products p ON ws.product_id = p.id
      LEFT JOIN users u ON ws.recorded_by = u.id
      ORDER BY ws.date_recorded DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching waste stock:', err);
    res.status(500).json({ error: 'Failed to fetch waste stock records' });
  }
});

// GET waste stock entry by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`
      SELECT ws.*, p.name as product_name, p.price, u.fullname as recorded_by_name
      FROM waste_stock ws
      JOIN products p ON ws.product_id = p.id
      LEFT JOIN users u ON ws.recorded_by = u.id
      WHERE ws.id = $1
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Waste stock record not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching waste stock:', err);
    res.status(500).json({ error: 'Failed to fetch waste stock record' });
  }
});

// POST new waste stock entry
router.post('/', async (req, res) => {
  try {
    const { product_id, quantity, reason, notes } = req.body;
    const recorded_by = req.user?.id; // Assuming you have user authentication
    
    // Validate input
    if (!product_id || !quantity || quantity <= 0) {
      return res.status(400).json({ error: 'Product ID and valid quantity are required' });
    }
    
    // Start transaction
    await db.query('BEGIN');
    
    // Insert waste stock record
    const wasteResult = await db.query(`
      INSERT INTO waste_stock (product_id, quantity, reason, notes, recorded_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [product_id, quantity, reason, notes, recorded_by]);
    
    // Update inventory (reduce stock)
    await db.query(`
      UPDATE inventory 
      SET quantity = quantity - $1
      WHERE product_id = $2
    `, [quantity, product_id]);
    
    await db.query('COMMIT');
    
    res.status(201).json(wasteResult.rows[0]);
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Error creating waste stock record:', err);
    res.status(500).json({ error: 'Failed to create waste stock record' });
  }
});

// DELETE waste stock entry
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await db.query(`
      DELETE FROM waste_stock 
      WHERE id = $1 
      RETURNING *
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Waste stock record not found' });
    }
    
    res.json({ message: 'Waste stock record deleted successfully' });
  } catch (err) {
    console.error('Error deleting waste stock record:', err);
    res.status(500).json({ error: 'Failed to delete waste stock record' });
  }
});

module.exports = router;