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
  let client;
  try {
    const { product_id, quantity, reason, notes } = req.body;
    
    // Validate input
    if (!product_id || !quantity || quantity <= 0) {
      return res.status(400).json({ error: 'Product ID and valid quantity are required' });
    }

    // Get a client from the pool for transaction
    client = await db.connect();
    
    // Start transaction
    await client.query('BEGIN');

    // First, check if we have a valid user to record this waste
    let recorded_by = req.user?.id;
    if (!recorded_by) {
      // Try to get the first active user from the database
      const userResult = await client.query(`
        SELECT id FROM users WHERE is_active = true LIMIT 1
      `);
      
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'No active users found to record this waste entry' });
      }
      
      recorded_by = userResult.rows[0].id;
    }

    console.log('Creating waste record:', { product_id, quantity, reason, notes, recorded_by });

    // Check current inventory stock
    const inventoryResult = await client.query(`
      SELECT quantity FROM inventory WHERE product_id = $1
    `, [product_id]);
    
    if (inventoryResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Product not found in inventory' });
    }
    
    const currentStock = inventoryResult.rows[0].quantity;
    
    if (currentStock < quantity) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: `Insufficient stock. Only ${currentStock} units available.` 
      });
    }

    // Insert waste stock record
    const wasteResult = await client.query(`
      INSERT INTO waste_stock (product_id, quantity, reason, notes, recorded_by)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [product_id, quantity, reason, notes, recorded_by]);

    // Update inventory (reduce stock)
    await client.query(`
      UPDATE inventory 
      SET quantity = quantity - $1
      WHERE product_id = $2
    `, [quantity, product_id]);

    await client.query('COMMIT');
    
    console.log('Waste record created successfully:', wasteResult.rows[0]);
    res.status(201).json(wasteResult.rows[0]);
  } catch (err) {
    console.error('Error creating waste stock record:', err);
    
    if (client) {
      await client.query('ROLLBACK');
    }
    
    res.status(500).json({ 
      error: 'Failed to create waste stock record',
      details: err.message 
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// PUT update waste stock entry
router.put('/:id', async (req, res) => {
  let client;
  try {
    const { id } = req.params;
    const { product_id, quantity, reason, notes } = req.body;

    console.log('Updating waste record:', { id, product_id, quantity, reason, notes });

    // Validate input
    if (!product_id || !quantity || quantity <= 0) {
      return res.status(400).json({ error: 'Product ID and valid quantity are required' });
    }

    // Get the original record
    client = await db.connect();
    await client.query('BEGIN');

    // Get user ID for recording
    let recorded_by = req.user?.id;
    if (!recorded_by) {
      const userResult = await client.query(`
        SELECT id FROM users WHERE is_active = true LIMIT 1
      `);
      
      if (userResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'No active users found to record this update' });
      }
      
      recorded_by = userResult.rows[0].id;
    }

    const originalRecordResult = await client.query(`
      SELECT * FROM waste_stock WHERE id = $1
    `, [id]);

    if (originalRecordResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Waste stock record not found' });
    }

    const originalRecord = originalRecordResult.rows[0];
    const quantityDifference = quantity - originalRecord.quantity;

    // Check current inventory stock if we're increasing the waste quantity
    if (quantityDifference > 0) {
      const inventoryResult = await client.query(`
        SELECT quantity FROM inventory WHERE product_id = $1
      `, [product_id]);

      if (inventoryResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Product not found in inventory' });
      }

      const currentStock = inventoryResult.rows[0].quantity;

      if (currentStock < quantityDifference) {
        await client.query('ROLLBACK');
        return res.status(400).json({ 
          error: `Insufficient stock. Only ${currentStock} units available to add to waste.` 
        });
      }
    }

    // Update waste stock record
    const wasteResult = await client.query(`
      UPDATE waste_stock 
      SET quantity = $1, reason = $2, notes = $3, recorded_by = $4, date_recorded = CURRENT_TIMESTAMP
      WHERE id = $5
      RETURNING *
    `, [quantity, reason, notes, recorded_by, id]);

    // Update inventory (adjust stock based on quantity difference)
    await client.query(`
      UPDATE inventory 
      SET quantity = quantity - $1
      WHERE product_id = $2
    `, [quantityDifference, product_id]);

    await client.query('COMMIT');

    console.log('Waste record updated successfully:', wasteResult.rows[0]);
    res.json(wasteResult.rows[0]);
  } catch (err) {
    console.error('Error updating waste stock record:', err);
    
    if (client) {
      await client.query('ROLLBACK');
    }
    
    res.status(500).json({ 
      error: 'Failed to update waste stock record',
      details: err.message 
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// DELETE waste stock entry
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
    
    res.status(500).json({ 
      error: 'Failed to delete waste stock record',
      details: err.message 
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;