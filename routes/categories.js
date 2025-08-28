// routes/products.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const axios = require('axios');
const fileUpload = require('express-fileupload');

router.use(fileUpload());

const IMGBB_API_KEY = '77c9bd669b4a5491c1ec247d8d79e866'; // Your ImgBB API Key

router.get('/', async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM categories ORDER BY name ASC');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ error: 'Failed to fetch categories.', details: error.message });
    }
});

router.post('/', async (req, res) => {
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

router.put('/:id', async (req, res) => {
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

router.delete('/:id', async (req, res) => {
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

// --- Category Routes (Moved to the top) ---

// GET /api/products/categories - Get all categories
// router.get('/', async (req, res) => {
//     try {
//         const result = await db.query('SELECT * FROM categories ORDER BY name ASC');
//         res.status(200).json(result.rows);
//     } catch (error) {
//         console.error('Error fetching categories:', error);
//         res.status(500).json({ error: 'Failed to fetch categories.', details: error.message });
//     }
// });

// // POST /api/products/categories - Create a new category
// router.post('/', async (req, res) => {
//     const { name, description } = req.body;
//     try {
//         const result = await db.query(
//             `INSERT INTO categories (name, description) VALUES ($1, $2) RETURNING *`,
//             [name, description]
//         );
//         res.status(201).json(result.rows[0]);
//     } catch (error) {
//         console.error('Error creating category:', error);
//         if (error.code === '23505') {
//             return res.status(409).json({ error: 'Category with this name already exists.' });
//         }
//         res.status(500).json({ error: 'Failed to create category.', details: error.message });
//     }
// });

// // PUT /api/products/categories/:id - Update a category by ID
// router.put('/:id', async (req, res) => {
//     const { id } = req.params;
//     const { name, description } = req.body;
//     try {
//         const result = await db.query(
//             `UPDATE categories SET name = $1, description = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
//             [name, description, id]
//         );
//         if (result.rows.length === 0) {
//             return res.status(404).json({ message: 'Category not found.' });
//         }
//         res.status(200).json(result.rows[0]);
//     } catch (error) {
//         console.error('Error updating category:', error);
//         if (error.code === '23505') {
//             return res.status(409).json({ error: 'Category with this name already exists.' });
//         }
//         res.status(500).json({ error: 'Failed to update category.', details: error.message });
//     }
// });

// // DELETE /api/products/categories/:id - Delete a category by ID
// router.delete('/:id', async (req, res) => {
//     const { id } = req.params;
//     try {
//         const productCountResult = await db.query('SELECT COUNT(*) FROM products WHERE category = (SELECT name FROM categories WHERE id = $1)', [id]);
//         if (parseInt(productCountResult.rows[0].count) > 0) {
//             return res.status(400).json({ error: 'Cannot delete category. Products are linked to it. Please reassign products first.' });
//         }
//         const result = await db.query('DELETE FROM categories WHERE id = $1', [id]);
//         if (result.rowCount === 0) {
//             return res.status(404).json({ message: 'Category not found.' });
//         }
//         res.status(200).json({ message: 'Category deleted successfully.' });
//     } catch (error) {
//         console.error('Error deleting category:', error);
//         res.status(500).json({ error: 'Failed to delete category.', details: error.message });
//     }
// });

// --- Product Routes (Rest of the original routes) ---

// GET /api/products - Get all products with their inventory stock
// router.get('/', async (req, res) => {
//     try {
//         const result = await db.query(`
//             SELECT p.*, COALESCE(i.quantity, 0) AS stock_level
//             FROM products p
//             LEFT JOIN inventory i ON p.id = i.product_id
//             ORDER BY p.name ASC
//         `);
//         res.status(200).json(result.rows);
//     } catch (error) {
//         console.error('Error fetching products with stock:', error);
//         res.status(500).json({ error: 'Failed to fetch products.', details: error.message });
//     }
// });

// GET /api/products/:id - Get a single product by ID with inventory stock
// router.get('/:id', async (req, res) => {
//     const { id } = req.params;
//     try {
//         const result = await db.query(`
//             SELECT p.*, COALESCE(i.quantity, 0) AS stock_level
//             FROM products p
//             LEFT JOIN inventory i ON p.id = i.product_id
//             WHERE p.id = $1
//         `, [id]);
//         if (result.rows.length === 0) {
//             return res.status(404).json({ message: 'Product not found.' });
//         }
//         res.status(200).json(result.rows[0]);
//     } catch (error) {
//         console.error('Error fetching single product:', error);
//         res.status(500).json({ error: 'Failed to fetch product.', details: error.message });
//     }
// });

// POST /api/products - Create a new product
// router.post('/', async (req, res) => {
//     const { name, description, price, category, image_url, is_active } = req.body;
//     try {
//         const result = await db.query(
//             `INSERT INTO products (name, description, price, category, image_url, is_active)
//              VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
//             [name, description, price, category, image_url, is_active]
//         );
//         res.status(201).json(result.rows[0]);
//     } catch (error) {
//         console.error('Error creating product:', error);
//         res.status(500).json({ error: 'Failed to create product.', details: error.message });
//     }
// });

// PUT /api/products/:id - Update a product by ID
// router.put('/:id', async (req, res) => {
//     const { id } = req.params;
//     const { name, description, price, category, image_url, is_active } = req.body;
//     try {
//         const result = await db.query(
//             `UPDATE products SET name = $1, description = $2, price = $3, category = $4,
//              image_url = $5, is_active = $6, updated_at = NOW() WHERE id = $7 RETURNING *`,
//             [name, description, price, category, image_url, is_active, id]
//         );
//         if (result.rows.length === 0) {
//             return res.status(404).json({ message: 'Product not found.' });
//         }
//         res.status(200).json(result.rows[0]);
//     } catch (error) {
//         console.error('Error updating product:', error);
//         res.status(500).json({ error: 'Failed to update product.', details: error.message });
//     }
// });

// DELETE /api/products/:id - Delete a product by ID
// router.delete('/:id', async (req, res) => {
//     const { id } = req.params;
//     try {
//         const result = await db.query('DELETE FROM products WHERE id = $1', [id]);
//         if (result.rowCount === 0) {
//             return res.status(404).json({ message: 'Product not found.' });
//         }
//         res.status(200).json({ message: 'Product deleted successfully.' });
//     } catch (error) {
//         console.error('Error deleting product:', error);
//         res.status(500).json({ error: 'Failed to delete product.', details: error.message });
//     }
// });

module.exports = router;
