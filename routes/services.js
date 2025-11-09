const express = require('express');
const router = express.Router();
const db = require('../db/db');
const authenticate = require('../middleware/authenticate'); // Use your existing authenticate


// const express = require('express');
// const router = express.Router();
// const db = require('../db/db');

// router.get('/services', async (req, res) => {
    //     try {
        //         const result = await db.pool.query('SELECT * FROM services WHERE is_active = true');
        //         res.status(200).json(result.rows);
//     } catch (error) {
//         console.error('Error fetching services:', error);
//         res.status(500).json({ error: 'Failed to fetch services.', details: error.message });
//     }
// });

router.get('/', async (req, res) => {
    try {
        const result = await db.pool.query('SELECT * FROM services WHERE is_active = true');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching services:', error);
        res.status(500).json({ error: 'Failed to fetch services.', details: error.message });
    }
});

// Get all services
router.get('/', authenticate, async (req, res) => {
  try {
    const { status } = req.query;
    let query = 'SELECT * FROM services';
    const params = [];

    if (status) {
      query += ' WHERE is_active = $1';
      params.push(status === 'active');
    }

    query += ' ORDER BY created_at DESC';

    const result = await db.query(query, params);
    res.json({
      success: true,
      data: result.rows
    });
  } catch (error) {
    console.error('Error fetching services:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching services'
    });
  }
});

// Get service by ID
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query('SELECT * FROM services WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    res.json({
      success: true,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching service:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching service'
    });
  }
});

// Create new service
router.post('/', authenticate, async (req, res) => {
  try {
    const { name, rate, is_active = true } = req.body;

    // Validate required fields
    if (!name || !rate) {
      return res.status(400).json({
        success: false,
        message: 'Name and rate are required'
      });
    }

    // Check if service name already exists
    const existingService = await db.query(
      'SELECT id FROM services WHERE name = $1',
      [name]
    );

    if (existingService.rows.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Service name already exists'
      });
    }

    const result = await db.query(
      `INSERT INTO services (name, rate, is_active) 
       VALUES ($1, $2, $3) 
       RETURNING *`,
      [name, parseFloat(rate), is_active]
    );

    res.status(201).json({
      success: true,
      message: 'Service created successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error creating service:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating service'
    });
  }
});

// Update service
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, rate, is_active } = req.body;

    // Check if service exists
    const existingService = await db.query(
      'SELECT id FROM services WHERE id = $1',
      [id]
    );

    if (existingService.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    // Check if name already exists (excluding current service)
    if (name) {
      const duplicateService = await db.query(
        'SELECT id FROM services WHERE name = $1 AND id != $2',
        [name, id]
      );

      if (duplicateService.rows.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Service name already exists'
        });
      }
    }

    const result = await db.query(
      `UPDATE services 
       SET name = COALESCE($1, name), 
           rate = COALESCE($2, rate), 
           is_active = COALESCE($3, is_active),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $4 
       RETURNING *`,
      [name, rate ? parseFloat(rate) : null, is_active, id]
    );

    res.json({
      success: true,
      message: 'Service updated successfully',
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating service:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating service'
    });
  }
});

// Toggle service status
router.patch('/:id/toggle-status', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      `UPDATE services 
       SET is_active = NOT is_active,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 
       RETURNING *`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    const newStatus = result.rows[0].is_active ? 'activated' : 'deactivated';
    
    res.json({
      success: true,
      message: `Service ${newStatus} successfully`,
      data: result.rows[0]
    });
  } catch (error) {
    console.error('Error toggling service status:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating service status'
    });
  }
});

// Delete service
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      'DELETE FROM services WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Service not found'
      });
    }

    res.json({
      success: true,
      message: 'Service deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting service:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting service'
    });
  }
});

module.exports = router;