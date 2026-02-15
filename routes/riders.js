// purple-premium-bread-api/routes/riders.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const authenticate = require('../middleware/authenticate');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const path = require('path');

const IMGBB_API_KEY = '77c9bd669b4a5491c1ec247d8d79e866';

// Configure multer for memory storage
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Helper function to upload image to ImgBB
const uploadImageToImgBB = async (imageBuffer) => {
    try {
        const formData = new FormData();
        formData.append('image', imageBuffer.toString('base64'));
        
        const response = await axios.post(
            `https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`,
            formData,
            {
                headers: {
                    ...formData.getHeaders()
                }
            }
        );
        
        if (response.data.success) {
            return response.data.data.url;
        } else {
            throw new Error('Failed to upload image to ImgBB');
        }
    } catch (error) {
        console.error('Image upload error:', error);
        throw error;
    }
};

// GET /api/riders - Fetch riders with filters and pagination
router.get('/', authenticate, async (req, res) => {
    const userRole = req.user.role?.toUpperCase();
    
    // Check permissions
    if (!['ADMIN', 'MANAGER', 'ACCOUNTANT', 'SALES'].includes(userRole)) {
        return res.status(403).json({ error: 'Unauthorized to view riders' });
    }
    
    const {
        searchTerm,
        status,
        minCredit,
        maxCredit,
        minBalance,
        maxBalance,
        sortBy = 'fullname',
        sortOrder = 'asc',
        dateFrom,
        dateTo,
        hasOutstanding,
        page = 1,
        limit = 10,
        export: exportData
    } = req.query;
    
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    try {
        // Build the base query
        let query = `
            SELECT 
                r.*,
                c.id as customer_id,
                c.fullname as customer_name,
                c.credit_limit as customer_credit_limit,
                c.balance as customer_balance,
                c.is_rider,
                c.custom_price_multiplier,
                c.product_prices
            FROM riders r
            LEFT JOIN customers c ON r.customer_id = c.id
            WHERE 1=1
        `;
        
        const params = [];
        let paramIndex = 1;
        
        // Apply filters
        if (searchTerm) {
            query += ` AND (
                r.fullname ILIKE $${paramIndex} OR 
                r.phone_number ILIKE $${paramIndex} OR 
                r.email ILIKE $${paramIndex} OR
                r.guarantor1_name ILIKE $${paramIndex} OR
                r.guarantor2_name ILIKE $${paramIndex}
            )`;
            params.push(`%${searchTerm}%`);
            paramIndex++;
        }
        
        if (status === 'active') {
            query += ` AND r.is_active = true`;
        } else if (status === 'inactive') {
            query += ` AND r.is_active = false`;
        }
        
        if (minCredit) {
            query += ` AND r.credit_limit >= $${paramIndex}`;
            params.push(parseFloat(minCredit));
            paramIndex++;
        }
        
        if (maxCredit) {
            query += ` AND r.credit_limit <= $${paramIndex}`;
            params.push(parseFloat(maxCredit));
            paramIndex++;
        }
        
        if (minBalance) {
            query += ` AND r.current_balance >= $${paramIndex}`;
            params.push(parseFloat(minBalance));
            paramIndex++;
        }
        
        if (maxBalance) {
            query += ` AND r.current_balance <= $${paramIndex}`;
            params.push(parseFloat(maxBalance));
            paramIndex++;
        }
        
        if (dateFrom) {
            query += ` AND r.created_at >= $${paramIndex}`;
            params.push(dateFrom);
            paramIndex++;
        }
        
        if (dateTo) {
            query += ` AND r.created_at <= $${paramIndex}::date + interval '1 day'`;
            params.push(dateTo);
            paramIndex++;
        }
        
        if (hasOutstanding === 'yes') {
            query += ` AND r.current_balance > 0`;
        } else if (hasOutstanding === 'no') {
            query += ` AND r.current_balance = 0`;
        }
        
        // Get total count for pagination
        const countQuery = `SELECT COUNT(*) FROM (${query}) as count`;
        const countResult = await db.query(countQuery, params);
        const total = parseInt(countResult.rows[0].count);
        
        // Add sorting and pagination
        const validSortFields = ['fullname', 'credit_limit', 'current_balance', 'created_at'];
        const sortField = validSortFields.includes(sortBy) ? sortBy : 'fullname';
        const order = sortOrder.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
        
        query += ` ORDER BY r.${sortField} ${order}`;
        
        // If not exporting, add pagination
        if (exportData !== 'true') {
            query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
            params.push(parseInt(limit), offset);
        }
        
        const result = await db.query(query, params);
        
        // Get statistics
        const statsQuery = `
            SELECT 
                COUNT(*) as total_riders,
                COUNT(CASE WHEN is_active THEN 1 END) as active_riders,
                COALESCE(SUM(credit_limit), 0) as total_credit_limit,
                COALESCE(SUM(current_balance), 0) as total_outstanding,
                COALESCE(AVG(credit_limit), 0) as avg_credit_limit
            FROM riders
            WHERE 1=1
        `;
        const statsResult = await db.query(statsQuery);
        
        res.status(200).json({
            riders: result.rows,
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(total / parseInt(limit)),
            stats: statsResult.rows[0]
        });
        
    } catch (error) {
        console.error('Error fetching riders:', error);
        res.status(500).json({ error: 'Failed to fetch riders', details: error.message });
    }
});

// GET /api/riders/:id - Get single rider details
router.get('/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    
    try {
        const query = `
            SELECT 
                r.*,
                c.id as customer_id,
                c.fullname as customer_name,
                c.credit_limit as customer_credit_limit,
                c.balance as customer_balance,
                c.is_rider,
                c.custom_price_multiplier,
                c.product_prices,
                (
                    SELECT json_agg(
                        json_build_object(
                            'sale_id', st.id,
                            'sale_date', st.sale_date,
                            'total_amount', st.total_amount,
                            'status', st.status,
                            'balance_due', st.balance_due
                        ) ORDER BY st.sale_date DESC
                    )
                    FROM sales_transactions st
                    WHERE st.rider_id = r.id
                    LIMIT 10
                ) as recent_sales,
                (
                    SELECT json_agg(
                        json_build_object(
                            'payment_id', p.id,
                            'payment_date', p.payment_date,
                            'amount', p.amount,
                            'payment_method', p.payment_method
                        ) ORDER BY p.payment_date DESC
                    )
                    FROM payments p
                    WHERE p.rider_id = r.id
                    LIMIT 10
                ) as recent_payments
            FROM riders r
            LEFT JOIN customers c ON r.customer_id = c.id
            WHERE r.id = $1
        `;
        
        const result = await db.query(query, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Rider not found' });
        }
        
        res.status(200).json(result.rows[0]);
        
    } catch (error) {
        console.error('Error fetching rider:', error);
        res.status(500).json({ error: 'Failed to fetch rider', details: error.message });
    }
});

// POST /api/riders - Create new rider (with better error handling)
router.post('/', authenticate, upload.fields([
    { name: 'profile_image', maxCount: 1 },
    { name: 'id_image', maxCount: 1 },
    { name: 'guarantor1_id_image', maxCount: 1 },
    { name: 'guarantor2_id_image', maxCount: 1 }
]), async (req, res) => {
    const client = await db.pool.connect();
    
    try {
        console.log('=== Starting rider creation ===');
        console.log('Request body:', req.body);
        console.log('Files received:', req.files ? Object.keys(req.files) : 'No files');
        
        await client.query('BEGIN');
        
        const {
            fullname, phone_number, email, address, date_of_birth,
            id_type, id_number,
            guarantor1_name, guarantor1_phone, guarantor1_address, guarantor1_relationship,
            guarantor1_id_type, guarantor1_id_number,
            guarantor2_name, guarantor2_phone, guarantor2_address, guarantor2_relationship,
            guarantor2_id_type, guarantor2_id_number,
            credit_limit, payment_terms, default_payment_method, notes,
            product_prices
        } = req.body;
        
        // Validate required fields
        if (!fullname || !phone_number) {
            console.log('Validation failed: missing required fields');
            return res.status(400).json({ error: 'Full name and phone number are required' });
        }
        
        console.log('Checking for existing rider with phone:', phone_number);
        
        // Check if phone number already exists
        const existingRider = await client.query(
            'SELECT id FROM riders WHERE phone_number = $1',
            [phone_number]
        );
        
        if (existingRider.rows.length > 0) {
            console.log('Rider with this phone already exists');
            return res.status(409).json({ error: 'Rider with this phone number already exists' });
        }
        
        // Upload images if provided
        let profileImageUrl = null;
        let idImageUrl = null;
        let guarantor1IdImageUrl = null;
        let guarantor2IdImageUrl = null;
        
        if (req.files && req.files.profile_image) {
            console.log('Uploading profile image...');
            profileImageUrl = await uploadImageToImgBB(req.files.profile_image[0].buffer);
            console.log('Profile image uploaded:', profileImageUrl);
        }
        
        if (req.files && req.files.id_image) {
            console.log('Uploading ID image...');
            idImageUrl = await uploadImageToImgBB(req.files.id_image[0].buffer);
            console.log('ID image uploaded:', idImageUrl);
        }
        
        if (req.files && req.files.guarantor1_id_image) {
            console.log('Uploading guarantor 1 ID image...');
            guarantor1IdImageUrl = await uploadImageToImgBB(req.files.guarantor1_id_image[0].buffer);
            console.log('Guarantor 1 ID image uploaded:', guarantor1IdImageUrl);
        }
        
        if (req.files && req.files.guarantor2_id_image) {
            console.log('Uploading guarantor 2 ID image...');
            guarantor2IdImageUrl = await uploadImageToImgBB(req.files.guarantor2_id_image[0].buffer);
            console.log('Guarantor 2 ID image uploaded:', guarantor2IdImageUrl);
        }
        
        // Parse product_prices if it's a string
        let parsedProductPrices = {};
        if (product_prices) {
            try {
                parsedProductPrices = typeof product_prices === 'string' 
                    ? JSON.parse(product_prices) 
                    : product_prices;
                console.log('Parsed product prices:', parsedProductPrices);
            } catch (e) {
                console.error('Error parsing product_prices:', e);
                parsedProductPrices = {};
            }
        }
        
        // First, check if customers table exists
        const checkCustomersTable = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'customers'
            );
        `);
        
        console.log('Customers table exists:', checkCustomersTable.rows[0].exists);
        
        if (!checkCustomersTable.rows[0].exists) {
            throw new Error('Customers table does not exist. Please run database migrations first.');
        }
        
        // Create customer record first
        console.log('Creating customer record...');
        const customerQuery = `
            INSERT INTO customers (
                fullname, phone, email, address, 
                credit_limit, balance, is_rider, 
                custom_price_multiplier, product_prices,
                created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
            RETURNING id
        `;
        
        const customerValues = [
            fullname,
            phone_number,
            email || null,
            address || null,
            credit_limit ? parseFloat(credit_limit) : 0,
            0, // initial balance
            true, // is_rider
            1.0, // default multiplier
            JSON.stringify(parsedProductPrices)
        ];
        
        console.log('Customer query values:', customerValues);
        
        const customerResult = await client.query(customerQuery, customerValues);
        const customerId = customerResult.rows[0].id;
        console.log('Customer created with ID:', customerId);
        
        // Check if riders table exists
        const checkRidersTable = await client.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'riders'
            );
        `);
        
        console.log('Riders table exists:', checkRidersTable.rows[0].exists);
        
        if (!checkRidersTable.rows[0].exists) {
            throw new Error('Riders table does not exist. Please run database migrations first.');
        }
        
        // Create rider record
        console.log('Creating rider record...');
        const riderQuery = `
            INSERT INTO riders (
                customer_id, fullname, phone_number, email, address, date_of_birth,
                id_type, id_number, id_image_url, profile_image_url,
                guarantor1_name, guarantor1_phone, guarantor1_address, guarantor1_relationship,
                guarantor1_id_type, guarantor1_id_number, guarantor1_id_image_url,
                guarantor2_name, guarantor2_phone, guarantor2_address, guarantor2_relationship,
                guarantor2_id_type, guarantor2_id_number, guarantor2_id_image_url,
                credit_limit, current_balance, payment_terms, default_payment_method, notes,
                rider_product_prices, is_active, created_by, created_at, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
                    $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31,
                    $32, $33, NOW(), NOW())
            RETURNING id
        `;
        
        const riderValues = [
            customerId, 
            fullname, 
            phone_number, 
            email || null, 
            address || null, 
            date_of_birth || null,
            id_type || null, 
            id_number || null, 
            idImageUrl, 
            profileImageUrl,
            guarantor1_name || null, 
            guarantor1_phone || null, 
            guarantor1_address || null, 
            guarantor1_relationship || null,
            guarantor1_id_type || null, 
            guarantor1_id_number || null, 
            guarantor1IdImageUrl,
            guarantor2_name || null, 
            guarantor2_phone || null, 
            guarantor2_address || null, 
            guarantor2_relationship || null,
            guarantor2_id_type || null, 
            guarantor2_id_number || null, 
            guarantor2IdImageUrl,
            credit_limit ? parseFloat(credit_limit) : 0, 
            0, 
            payment_terms || 'weekly', 
            default_payment_method || 'Cash', 
            notes || null,
            JSON.stringify(parsedProductPrices),
            true,
            req.user.id
        ];
        
        console.log('Rider query values length:', riderValues.length);
        console.log('First few rider values:', riderValues.slice(0, 5));
        
        const riderResult = await client.query(riderQuery, riderValues);
        const riderId = riderResult.rows[0].id;
        console.log('Rider created with ID:', riderId);
        
        await client.query('COMMIT');
        console.log('Transaction committed successfully');
        
        res.status(201).json({
            message: 'Rider created successfully',
            riderId: riderId,
            customerId: customerId
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('=== ERROR CREATING RIDER ===');
        console.error('Error name:', error.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        console.error('Error detail:', error.detail);
        console.error('Error code:', error.code);
        console.error('Error position:', error.position);
        
        // Send detailed error in development, generic in production
        const isDev = process.env.NODE_ENV === 'development';
        res.status(500).json({ 
            error: 'Failed to create rider', 
            details: isDev ? error.message : 'Internal server error',
            code: error.code || 'UNKNOWN'
        });
    } finally {
        client.release();
        console.log('=== Rider creation process completed ===');
    }
});

// PUT /api/riders/:id - Update rider
router.put('/:id', authenticate, upload.fields([
    { name: 'profile_image', maxCount: 1 },
    { name: 'id_image', maxCount: 1 },
    { name: 'guarantor1_id_image', maxCount: 1 },
    { name: 'guarantor2_id_image', maxCount: 1 }
]), async (req, res) => {
    const { id } = req.params;
    const client = await db.pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const {
            fullname, phone_number, email, address, date_of_birth,
            id_type, id_number,
            guarantor1_name, guarantor1_phone, guarantor1_address, guarantor1_relationship,
            guarantor1_id_type, guarantor1_id_number,
            guarantor2_name, guarantor2_phone, guarantor2_address, guarantor2_relationship,
            guarantor2_id_type, guarantor2_id_number,
            credit_limit, payment_terms, default_payment_method, notes,
            product_prices, is_active
        } = req.body;
        
        // Get current rider info to get customer_id
        const currentRider = await client.query(
            'SELECT customer_id FROM riders WHERE id = $1',
            [id]
        );
        
        if (currentRider.rows.length === 0) {
            return res.status(404).json({ error: 'Rider not found' });
        }
        
        const customerId = currentRider.rows[0].customer_id;
        
        // Upload new images if provided
        let profileImageUrl = null;
        let idImageUrl = null;
        let guarantor1IdImageUrl = null;
        let guarantor2IdImageUrl = null;
        
        if (req.files.profile_image) {
            profileImageUrl = await uploadImageToImgBB(req.files.profile_image[0].buffer);
        }
        
        if (req.files.id_image) {
            idImageUrl = await uploadImageToImgBB(req.files.id_image[0].buffer);
        }
        
        if (req.files.guarantor1_id_image) {
            guarantor1IdImageUrl = await uploadImageToImgBB(req.files.guarantor1_id_image[0].buffer);
        }
        
        if (req.files.guarantor2_id_image) {
            guarantor2IdImageUrl = await uploadImageToImgBB(req.files.guarantor2_id_image[0].buffer);
        }
        
        // Parse product_prices
        let parsedProductPrices = {};
        if (product_prices) {
            parsedProductPrices = typeof product_prices === 'string' 
                ? JSON.parse(product_prices) 
                : product_prices;
        }
        
        // Update customer record
        const customerUpdateQuery = `
            UPDATE customers
            SET fullname = COALESCE($1, fullname),
                phone = COALESCE($2, phone),
                email = COALESCE($3, email),
                address = COALESCE($4, address),
                credit_limit = COALESCE($5, credit_limit),
                product_prices = COALESCE($6, product_prices::jsonb),
                updated_at = NOW()
            WHERE id = $7
        `;
        
        await client.query(customerUpdateQuery, [
            fullname || null,
            phone_number || null,
            email || null,
            address || null,
            credit_limit || null,
            JSON.stringify(parsedProductPrices),
            customerId
        ]);
        
        // Build rider update query dynamically
        const riderUpdateFields = [];
        const riderUpdateValues = [];
        let valueIndex = 1;
        
        const updateFields = {
            fullname, phone_number, email, address, date_of_birth,
            id_type, id_number,
            guarantor1_name, guarantor1_phone, guarantor1_address, guarantor1_relationship,
            guarantor1_id_type, guarantor1_id_number,
            guarantor2_name, guarantor2_phone, guarantor2_address, guarantor2_relationship,
            guarantor2_id_type, guarantor2_id_number,
            credit_limit, payment_terms, default_payment_method, notes,
            rider_product_prices: parsedProductPrices,
            is_active,
            updated_by: req.user.id,
            updated_at: 'NOW()'
        };
        
        // Add image URLs if new images were uploaded
        if (profileImageUrl) updateFields.profile_image_url = profileImageUrl;
        if (idImageUrl) updateFields.id_image_url = idImageUrl;
        if (guarantor1IdImageUrl) updateFields.guarantor1_id_image_url = guarantor1IdImageUrl;
        if (guarantor2IdImageUrl) updateFields.guarantor2_id_image_url = guarantor2IdImageUrl;
        
        Object.entries(updateFields).forEach(([key, value]) => {
            if (value !== null && value !== undefined) {
                if (key === 'updated_at') {
                    riderUpdateFields.push(`${key} = NOW()`);
                } else if (key === 'rider_product_prices') {
                    riderUpdateFields.push(`${key} = $${valueIndex}::jsonb`);
                    riderUpdateValues.push(JSON.stringify(value));
                    valueIndex++;
                } else {
                    riderUpdateFields.push(`${key} = $${valueIndex}`);
                    riderUpdateValues.push(value);
                    valueIndex++;
                }
            }
        });
        
        if (riderUpdateFields.length > 0) {
            const riderUpdateQuery = `
                UPDATE riders
                SET ${riderUpdateFields.join(', ')}
                WHERE id = $${valueIndex}
            `;
            riderUpdateValues.push(id);
            
            await client.query(riderUpdateQuery, riderUpdateValues);
        }
        
        await client.query('COMMIT');
        
        res.status(200).json({ message: 'Rider updated successfully' });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating rider:', error);
        res.status(500).json({ error: 'Failed to update rider', details: error.message });
    } finally {
        client.release();
    }
});

// PATCH /api/riders/:id/toggle-status - Toggle rider active status
router.patch('/:id/toggle-status', authenticate, async (req, res) => {
    const { id } = req.params;
    const { is_active } = req.body;
    
    const client = await db.pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const riderResult = await client.query(
            'SELECT customer_id FROM riders WHERE id = $1',
            [id]
        );
        
        if (riderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Rider not found' });
        }
        
        const customerId = riderResult.rows[0].customer_id;
        
        // Update rider status
        await client.query(
            'UPDATE riders SET is_active = $1, updated_at = NOW() WHERE id = $2',
            [is_active, id]
        );
        
        // Update customer's is_rider status (if deactivating, we might want to keep the flag)
        if (!is_active) {
            // Optionally keep is_rider true but mark as inactive
            await client.query(
                'UPDATE customers SET updated_at = NOW() WHERE id = $1',
                [customerId]
            );
        }
        
        await client.query('COMMIT');
        
        res.status(200).json({ 
            message: `Rider ${is_active ? 'activated' : 'deactivated'} successfully` 
        });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error toggling rider status:', error);
        res.status(500).json({ error: 'Failed to update rider status', details: error.message });
    } finally {
        client.release();
    }
});

// DELETE /api/riders/:id - Delete rider
router.delete('/:id', authenticate, async (req, res) => {
    const { id } = req.params;
    const userRole = req.user.role?.toUpperCase();
    
    if (userRole !== 'ADMIN') {
        return res.status(403).json({ error: 'Only administrators can delete riders' });
    }
    
    const client = await db.pool.connect();
    
    try {
        await client.query('BEGIN');
        
        const riderResult = await client.query(
            'SELECT customer_id FROM riders WHERE id = $1',
            [id]
        );
        
        if (riderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Rider not found' });
        }
        
        const customerId = riderResult.rows[0].customer_id;
        
        // Check if rider has any sales or payments
        const salesCheck = await client.query(
            'SELECT id FROM sales_transactions WHERE rider_id = $1 LIMIT 1',
            [id]
        );
        
        const paymentsCheck = await client.query(
            'SELECT id FROM payments WHERE rider_id = $1 LIMIT 1',
            [id]
        );
        
        if (salesCheck.rows.length > 0 || paymentsCheck.rows.length > 0) {
            // Soft delete - just deactivate
            await client.query(
                'UPDATE riders SET is_active = false, updated_at = NOW() WHERE id = $1',
                [id]
            );
            await client.query(
                'UPDATE customers SET updated_at = NOW() WHERE id = $1',
                [customerId]
            );
            
            await client.query('COMMIT');
            
            return res.status(200).json({ 
                message: 'Rider has associated transactions. Deactivated instead of deleted.' 
            });
        }
        
        // Hard delete if no transactions
        await client.query('DELETE FROM riders WHERE id = $1', [id]);
        
        // Optionally delete or update customer
        await client.query(
            'UPDATE customers SET is_rider = false, updated_at = NOW() WHERE id = $1',
            [customerId]
        );
        
        await client.query('COMMIT');
        
        res.status(200).json({ message: 'Rider deleted successfully' });
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting rider:', error);
        res.status(500).json({ error: 'Failed to delete rider', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/riders/export - Export riders to CSV
router.get('/export', authenticate, async (req, res) => {
    try {
        const {
            searchTerm,
            status,
            minCredit,
            maxCredit,
            minBalance,
            maxBalance,
            dateFrom,
            dateTo,
            hasOutstanding
        } = req.query;
        
        let query = `
            SELECT 
                r.fullname,
                r.phone_number,
                r.email,
                r.address,
                r.date_of_birth,
                r.credit_limit,
                r.current_balance,
                r.payment_terms,
                r.default_payment_method,
                r.is_active,
                r.created_at,
                r.guarantor1_name,
                r.guarantor1_phone,
                r.guarantor2_name,
                r.guarantor2_phone,
                c.id as customer_id
            FROM riders r
            LEFT JOIN customers c ON r.customer_id = c.id
            WHERE 1=1
        `;
        
        const params = [];
        let paramIndex = 1;
        
        // Apply same filters as the GET endpoint
        if (searchTerm) {
            query += ` AND (
                r.fullname ILIKE $${paramIndex} OR 
                r.phone_number ILIKE $${paramIndex} OR 
                r.email ILIKE $${paramIndex}
            )`;
            params.push(`%${searchTerm}%`);
            paramIndex++;
        }
        
        if (status === 'active') {
            query += ` AND r.is_active = true`;
        } else if (status === 'inactive') {
            query += ` AND r.is_active = false`;
        }
        
        if (minCredit) {
            query += ` AND r.credit_limit >= $${paramIndex}`;
            params.push(parseFloat(minCredit));
            paramIndex++;
        }
        
        if (maxCredit) {
            query += ` AND r.credit_limit <= $${paramIndex}`;
            params.push(parseFloat(maxCredit));
            paramIndex++;
        }
        
        if (minBalance) {
            query += ` AND r.current_balance >= $${paramIndex}`;
            params.push(parseFloat(minBalance));
            paramIndex++;
        }
        
        if (maxBalance) {
            query += ` AND r.current_balance <= $${paramIndex}`;
            params.push(parseFloat(maxBalance));
            paramIndex++;
        }
        
        if (dateFrom) {
            query += ` AND r.created_at >= $${paramIndex}`;
            params.push(dateFrom);
            paramIndex++;
        }
        
        if (dateTo) {
            query += ` AND r.created_at <= $${paramIndex}::date + interval '1 day'`;
            params.push(dateTo);
            paramIndex++;
        }
        
        if (hasOutstanding === 'yes') {
            query += ` AND r.current_balance > 0`;
        } else if (hasOutstanding === 'no') {
            query += ` AND r.current_balance = 0`;
        }
        
        query += ` ORDER BY r.fullname ASC`;
        
        const result = await db.query(query, params);
        
        res.status(200).json(result.rows);
        
    } catch (error) {
        console.error('Error exporting riders:', error);
        res.status(500).json({ error: 'Failed to export riders', details: error.message });
    }
});

module.exports = router;