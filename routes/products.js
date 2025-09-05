// routes/products.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const axios = require('axios');
// const fileUpload = require('express-fileupload');

// router.use(fileUpload());

const IMGBB_API_KEY = '77c9bd669b4a5491c1ec247d8d79e866';

// --- CATEGORY ROUTES (MUST BE BEFORE PRODUCT ID ROUTES) ---

// GET /api/products/categories - Get all categories with optional search filter
router.get('/categories', async (req, res) => {
    try {
        const { searchTerm } = req.query;
        let query = 'SELECT * FROM categories WHERE 1=1';
        const params = [];
        let paramCount = 1;

        if (searchTerm) {
            query += ` AND (name ILIKE $${paramCount} OR description ILIKE $${paramCount})`;
            params.push(`%${searchTerm}%`);
            paramCount++;
        }
        query += ' ORDER BY name ASC';

        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ error: 'Failed to fetch categories.', details: error.message });
    }
});

// POST /api/products/categories - Create a new category
router.post('/categories', async (req, res) => {
    const { name, description } = req.body;
    try {
        const result = await db.query(
            `INSERT INTO categories (name, description) VALUES ($1, $2) RETURNING *`,
            [name, description]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating category:', error);
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Category with this name already exists.' });
        }
        res.status(500).json({ error: 'Failed to create category.', details: error.message });
    }
});

// PUT /api/products/categories/:id - Update a category by ID
router.put('/categories/:id', async (req, res) => {
    const { id } = req.params;
    const { name, description } = req.body;
    try {
        const result = await db.query(
            `UPDATE categories SET name = $1, description = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
            [name, description, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Category not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating category:', error);
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Category with this name already exists.' });
        }
        res.status(500).json({ error: 'Failed to update category.', details: error.message });
    }
});

// DELETE /api/products/categories/:id - Delete a category by ID
router.delete('/categories/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const productCountResult = await db.query('SELECT COUNT(*) FROM products WHERE category = (SELECT name FROM categories WHERE id = $1)', [id]);
        if (parseInt(productCountResult.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete category. Products are linked to it. Please reassign products first.' });
        }
        const result = await db.query('DELETE FROM categories WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Category not found.' });
        }
        res.status(200).json({ message: 'Category deleted successfully.' });
    } catch (error) {
        console.error('Error deleting category:', error);
        res.status(500).json({ error: 'Failed to delete category.', details: error.message });
    }
});

// --- PRODUCT IMAGE UPLOAD ROUTE ---
router.post('/upload-image', async (req, res) => {
    try {
        if (!req.files || !req.files.productImage) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }

        const imageData = req.files.productImage.data.toString('base64');
        const imgbbResponse = await axios.post(
            `https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`,
            `image=${encodeURIComponent(imageData)}`,
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        if (imgbbResponse.data.success) {
            res.status(200).json({ url: imgbbResponse.data.data.url });
        } else {
            console.error('ImgBB error response:', imgbbResponse.data);
            res.status(500).json({ error: 'Failed to upload image to ImgBB.', details: imgbbResponse.data.error.message });
        }
    } catch (error) {
        console.error('Image upload error:', error);
        res.status(500).json({ error: 'Failed to upload image.', details: error.message });
    }
});


// --- GENERAL PRODUCT ROUTES ---

// GET /api/products - Get all products with filters and their inventory stock
router.get('/', async (req, res) => {
    try {
        const {
            name,
            category,
            minPrice,
            maxPrice,
            minStock,
            maxStock,
            isActive,
            productId
        } = req.query;

        let query = `
            SELECT p.*, COALESCE(i.quantity, 0) AS stock_level
            FROM products p
            LEFT JOIN inventory i ON p.id = i.product_id
            WHERE 1=1
        `;
        const params = [];
        let paramCount = 1;

        if (productId) {
            query += ` AND p.id = $${paramCount}`;
            params.push(productId);
            paramCount++;
        }
        if (name) {
            query += ` AND p.name ILIKE $${paramCount}`;
            params.push(`%${name}%`);
            paramCount++;
        }
        if (category) {
            query += ` AND p.category ILIKE $${paramCount}`;
            params.push(`%${category}%`);
            paramCount++;
        }
        if (minPrice) {
            query += ` AND p.price >= $${paramCount}`;
            params.push(parseFloat(minPrice));
            paramCount++;
        }
        if (maxPrice) {
            query += ` AND p.price <= $${paramCount}`;
            params.push(parseFloat(maxPrice));
            paramCount++;
        }
        if (minStock) {
            query += ` AND COALESCE(i.quantity, 0) >= $${paramCount}`;
            params.push(parseInt(minStock));
            paramCount++;
        }
        if (maxStock) {
            query += ` AND COALESCE(i.quantity, 0) <= $${paramCount}`;
            params.push(parseInt(maxStock));
            paramCount++;
        }
        if (isActive !== undefined) {
            query += ` AND p.is_active = $${paramCount}`;
            params.push(isActive === 'true');
            paramCount++;
        }

        query += ` ORDER BY p.name ASC`;

        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching products with stock and filters:', error);
        res.status(500).json({ error: 'Failed to fetch products.', details: error.message });
    }
});

// GET /api/products/:id - Get a single product by ID with inventory stock
router.get('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query(`
            SELECT p.*, COALESCE(i.quantity, 0) AS stock_level
            FROM products p
            LEFT JOIN inventory i ON p.id = i.product_id
            WHERE p.id = $1
        `, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Product not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching single product:', error);
        res.status(500).json({ error: 'Failed to fetch product.', details: error.message });
    }
});

// POST /api/products - Create a new product
router.post('/', async (req, res) => {
    const { name, description, price, min_stock_level, category, image_url, is_active, units } = req.body;
    try {
        // Explicitly stringify the units array for JSONB column
        const unitsJson = JSON.stringify(units);

        const result = await db.query(
            `INSERT INTO products (name, description, price, min_stock_level, category, image_url, is_active, units)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) RETURNING *`,
            [name, description, price, min_stock_level, category, image_url, is_active, unitsJson]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating product:', error);
        res.status(500).json({ error: 'Failed to create product.', details: error.message });
    }
});

// PUT (update) a product by ID
router.put('/:id', async (req, res) => {
    const { id } = req.params;
    const { name, description, price, min_stock_level, category, image_url, is_active, units } = req.body;
    try {
        // Explicitly stringify the units array for JSONB column
        const unitsJson = JSON.stringify(units);

        const result = await db.query(
            `UPDATE products SET 
                name = $1, 
                description = $2, 
                price = $3, 
                min_stock_level = $4,
                category = $5,
                image_url = $6, 
                is_active = $7, 
                units = $8::jsonb,  
                updated_at = NOW() 
             WHERE id = $9 RETURNING *`,
            [name, description, price, min_stock_level, category, image_url, is_active, unitsJson, id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Product not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error updating product:', error);
        res.status(500).json({ error: 'Failed to update product.', details: error.message });
    }
});

// DELETE a product by ID
router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db.query('DELETE FROM products WHERE id = $1', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Product not found.' });
        }
        res.status(200).json({ message: 'Product deleted successfully.' });
    } catch (error) {
        console.error('Error deleting product:', error);
        res.status(500).json({ error: 'Failed to delete product.', details: error.message });
    }
});

module.exports = router;
