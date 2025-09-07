const express = require('express');
const router = express.Router();
const db = require('../db/db');

// GET all waste stock entries
router.get('/', async (req, res) => {
  try {
    console.log('Fetching waste records...');
    const result = await db.query(`
      SELECT ws.*, p.name as product_name, p.price, u.fullname as recorded_by_name
      FROM waste_stock ws
      JOIN products p ON ws.product_id = p.id
      LEFT JOIN users u ON ws.recorded_by = u.id
      ORDER BY ws.date_recorded DESC
    `);

    console.log(`Found ${result.rows.length} waste records`);
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
      return res.status(404).json({ error: 'Waste stock entry not found' });
    }
    
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching waste stock entry:', err);
    res.status(500).json({ error: 'Failed to fetch waste stock entry' });
  }
});

// POST a new waste stock entry
router.post('/', async (req, res) => {
  let client;
  try {
    const { product_id, quantity, reason, notes } = req.body;

    // --- Step 1: Add more robust input validation ---
    if (!product_id || !quantity || isNaN(Number(quantity)) || Number(quantity) <= 0) {
      return res.status(400).json({ error: 'Product ID must be a valid integer, and quantity must be a positive number.' });
    }

    // --- Step 2: Ensure product_id is an integer for database query ---
    const parsedProductId = parseInt(product_id);
    const parsedQuantity = parseInt(quantity);

    // Get a client from the pool for a transaction
    client = await db.connect();
    await client.query('BEGIN');

    // First, check if we have a valid user to record this waste
    let recorded_by = req.user?.id;
    if (!recorded_by) {
      const userResult = await client.query(`
        SELECT id FROM users WHERE is_active = true LIMIT 1
      `);
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'No active users found to record this waste entry' });
      }
      recorded_by = userResult.rows[0].id;
    }

    // Check if the product exists in inventory
    const inventoryResult = await client.query(`
      SELECT quantity FROM inventory WHERE product_id = $1
    `, [parsedProductId]);

    if (inventoryResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Product not found in inventory. Please ensure the product exists before creating a waste record.' });
    }

    const currentStock = inventoryResult.rows[0].quantity;
    if (currentStock < parsedQuantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Insufficient stock to create a waste record of this quantity.' });
    }

    console.log('Creating waste record:', { product_id: parsedProductId, quantity: parsedQuantity, reason, notes, recorded_by });

    // --- Step 3: Use the parsed integer values in the query ---
    const insertResult = await client.query(`
      INSERT INTO waste_stock (product_id, quantity, reason, notes, recorded_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `, [parsedProductId, parsedQuantity, reason, notes, recorded_by]);

    const newWasteRecord = insertResult.rows[0];

    // Update inventory
    await client.query(`
      UPDATE inventory
      SET quantity = quantity - $1
      WHERE product_id = $2
    `, [parsedQuantity, parsedProductId]);

    await client.query('COMMIT');

    console.log('Waste record created successfully:', newWasteRecord);
    res.status(201).json(newWasteRecord);

  } catch (err) {
    // --- Step 4: Add specific logging for the server-side error ---
    if (client) {
      await client.query('ROLLBACK');
    }

    // Check if the error is due to a foreign key violation
    if (err.code === '23503') { // PostgreSQL error code for foreign key violation
      console.error('Foreign Key Violation Error:', err.detail);
      return res.status(400).json({ error: 'Failed to create waste record due to a foreign key constraint violation. Please check the provided product ID and recorded_by user ID.' });
    }

    // Catch any other unexpected server errors
    console.error('Error creating waste stock entry:', err);
    res.status(500).json({
      error: 'Failed to create waste stock record.',
      details: err.message
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// DELETE a waste stock entry by ID
router.delete('/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;

    console.log('Deleting waste record:', id);

    // First get the waste record to restore inventory
    client = await db.connect();
    await client.query('BEGIN');

    const wasteResult = await client.query(`
      SELECT * FROM waste_stock WHERE id = $1
    `, [id]);

    if (wasteResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Waste stock record not found' });
    }

    const wasteRecord = wasteResult.rows[0];

    // Restore inventory
    await client.query(`
      UPDATE inventory
      SET quantity = quantity + $1
      WHERE product_id = $2
    `, [wasteRecord.quantity, wasteRecord.product_id]);

    // Delete waste record
    await client.query(`
      DELETE FROM waste_stock
      WHERE id = $1
    `, [id]);

    await client.query('COMMIT');

    console.log('Waste record deleted successfully');
    res.json({ message: 'Waste stock record deleted successfully' });
  } catch (err) {
    console.error('Error deleting waste stock record:', err);

    if (client) {
      await client.query('ROLLBACK');
    }

    res.status(500).json({ error: 'Failed to delete waste stock record' });
  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;