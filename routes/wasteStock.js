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
    console.error('Error fetching waste stock by ID:', err);
    res.status(500).json({ error: 'Failed to fetch waste stock record' });
  }
});

// POST new waste stock entry
router.post('/', async (req, res) => {
  try {
    let { product_id, quantity, reason, notes } = req.body;

    const parsedProductId = parseInt(product_id, 10);
    const parsedQuantity = parseInt(quantity, 10);

    if (isNaN(parsedProductId) || isNaN(parsedQuantity) || parsedQuantity <= 0) {
      return res.status(400).json({ error: 'Invalid product ID or quantity' });
    }

    await db.query('BEGIN');

    // get recorded_by user (fallback if no req.user)
    let recorded_by = req.user?.id;
    if (!recorded_by) {
      const userRes = await db.query(`SELECT id FROM users WHERE is_active = true LIMIT 1`);
      if (userRes.rows.length === 0) {
        await db.query('ROLLBACK');
        return res.status(400).json({ error: 'No active user available to record waste' });
      }
      recorded_by = userRes.rows[0].id;
    }

    // check inventory
    const invRes = await db.query(`SELECT quantity FROM inventory WHERE product_id = $1`, [parsedProductId]);
    if (invRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Product not found in inventory' });
    }
    if (invRes.rows[0].quantity < parsedQuantity) {
      await db.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient stock for this waste quantity' });
    }

    // insert waste record
    const insertRes = await db.query(`
      INSERT INTO waste_stock (product_id, quantity, reason, notes, recorded_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [parsedProductId, parsedQuantity, reason, notes, recorded_by]);

    // update inventory
    await db.query(`
      UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2
    `, [parsedQuantity, parsedProductId]);

    await db.query('COMMIT');
    res.status(201).json(insertRes.rows[0]);
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Error creating waste stock record:', err);
    res.status(500).json({ error: 'Failed to create waste stock record', details: err.message });
  }
});

// PUT update waste stock entry
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let { product_id, quantity, reason, notes } = req.body;

    const parsedProductId = parseInt(product_id, 10);
    const parsedQuantity = parseInt(quantity, 10);

    if (isNaN(parsedProductId) || isNaN(parsedQuantity) || parsedQuantity <= 0) {
      return res.status(400).json({ error: 'Invalid product ID or quantity' });
    }

    await db.query('BEGIN');

    const originalRes = await db.query(`SELECT * FROM waste_stock WHERE id = $1`, [id]);
    if (originalRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Waste stock record not found' });
    }

    const original = originalRes.rows[0];
    const diff = parsedQuantity - original.quantity;

    // check stock if waste increased
    if (diff > 0) {
      const invRes = await db.query(`SELECT quantity FROM inventory WHERE product_id = $1`, [parsedProductId]);
      if (invRes.rows.length === 0 || invRes.rows[0].quantity < diff) {
        await db.query('ROLLBACK');
        return res.status(400).json({ error: 'Insufficient stock to increase waste quantity' });
      }
    }

    // recorded_by
    let recorded_by = req.user?.id;
    if (!recorded_by) {
      const userRes = await db.query(`SELECT id FROM users WHERE is_active = true LIMIT 1`);
      recorded_by = userRes.rows[0]?.id || null;
    }

    const updateRes = await db.query(`
      UPDATE waste_stock 
      SET product_id = $1, quantity = $2, reason = $3, notes = $4, recorded_by = $5, date_recorded = CURRENT_TIMESTAMP
      WHERE id = $6 RETURNING *
    `, [parsedProductId, parsedQuantity, reason, notes, recorded_by, id]);

    // adjust inventory
    await db.query(`
      UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2
    `, [diff, parsedProductId]);

    await db.query('COMMIT');
    res.json(updateRes.rows[0]);
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Error updating waste stock record:', err);
    res.status(500).json({ error: 'Failed to update waste stock record', details: err.message });
  }
});

// DELETE waste stock entry
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.query('BEGIN');

    const wasteRes = await db.query(`SELECT * FROM waste_stock WHERE id = $1`, [id]);
    if (wasteRes.rows.length === 0) {
      await db.query('ROLLBACK');
      return res.status(404).json({ error: 'Waste stock record not found' });
    }

    const waste = wasteRes.rows[0];

    // restore inventory
    await db.query(`
      UPDATE inventory SET quantity = quantity + $1 WHERE product_id = $2
    `, [waste.quantity, waste.product_id]);

    await db.query(`DELETE FROM waste_stock WHERE id = $1`, [id]);

    await db.query('COMMIT');
    res.json({ message: 'Waste stock record deleted successfully' });
  } catch (err) {
    await db.query('ROLLBACK');
    console.error('Error deleting waste stock record:', err);
    res.status(500).json({ error: 'Failed to delete waste stock record', details: err.message });
  }
});

module.exports = router;
