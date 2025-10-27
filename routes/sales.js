const express = require('express');
const router = express.Router();
const db = require('../db/db');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const { jwtDecode } = require('jwt-decode'); // For getting user ID from token if needed for other sales routes

// Configure your ImgBB API Key here
const IMGBB_API_KEY = '77c9bd669b4a5491c1ec247d8d79e866'; // Replace with your actual ImgBB API Key

// Helper to get user ID from token (if token is sent in headers)
const getUserIdFromToken = (req) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) {
            const decoded = jwtDecode(token);
            return decoded.id;
        }
    } catch (e) {
        console.error("Failed to decode token for sales transaction", e);
    }
    return null;
};

// Helper function to calculate COGS for a single product
async function calculateProductCogs(productId, client) {
    const recipeQuery = `
        SELECT r.raw_material_id, r.quantity_required, rm.restock_price_per_unit
        FROM recipes r
        JOIN raw_materials rm ON r.raw_material_id = rm.id
        WHERE r.product_id = $1;
    `;
    const recipeResult = await client.query(recipeQuery, [productId]);
    
    let cogsPerUnit = 0;
    if (recipeResult.rows.length === 0) {
        console.warn(`Product ID ${productId} has no recipe defined. COGS will be 0.`);
    } else {
        cogsPerUnit = recipeResult.rows.reduce((sum, item) => {
            return sum + (parseFloat(item.quantity_required) * parseFloat(item.restock_price_per_unit || 0));
        }, 0);
    }
    return cogsPerUnit;
}


// POST /api/sales/upload-receipt - Endpoint to upload receipt images to ImgBB
router.post('/upload-receipt', async (req, res) => {
    try {
        if (!req.files || !req.files.receiptImage) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }

        const imageData = req.files.receiptImage.data.toString('base64');
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
            res.status(500).json({ error: 'Failed to upload image to ImgBB.', details: imgbbResponse.data.error.message });
        }
    } catch (error) {
        console.error('Image upload error:', error);
        res.status(500).json({ error: 'Failed to upload image.', details: error.message });
    }
});

// POST /api/sales/process - Process a sale (UPDATED & FIXED FOR FOR UPDATE ERROR)
router.post('/process', async (req, res) => {
    const { 
        cart, subtotal, tax, total, discountAmount, 
        cashierId, paymentMethod, customerId, note, 
        paymentReference, paymentImageUrl, status, 
        amountPaid, balanceDue, dueDate,
        freeStock // NEW: The free stock object from the frontend
    } = req.body;

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // --- STEP 1: Determine Stock Source ---
        let stockTable = 'inventory';
        let stockCheckQuery = 'SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE';
        let stockUpdateQuery = `
            UPDATE inventory 
            SET quantity = quantity - $1, last_updated = NOW() 
            WHERE product_id = $2 
            RETURNING *;
        `;

        const userResult = await client.query(`
            SELECT role, load_from_demo_stock 
            FROM users 
            WHERE id = $1
        `, [cashierId]);

        const user = userResult.rows[0];

        if (user && user.role === 'sales' && user.load_from_demo_stock) {
            stockTable = 'sales_user_stock';

            // ✅ FIXED: Directly lock sales_user_stock (no LEFT JOIN)
            stockCheckQuery = `
                SELECT quantity 
                FROM sales_user_stock 
                WHERE product_id = $1 AND user_id = $2 
                FOR UPDATE;
            `;

            stockUpdateQuery = `
                UPDATE sales_user_stock 
                SET quantity = quantity - $1, last_updated = NOW() 
                WHERE product_id = $2 AND user_id = $3
                RETURNING *;
            `;
        }

        // --- STEP 2: Aggregate All Products (Sold + Free) and Pre-check Stock ---
        const productsToUpdate = {}; // { productId: totalQuantityToDeduct (sold + free) }
        let totalCogs = 0;

        // Add sold items
        for (const item of cart) {
            const productId = item.id;
            const quantity = item.quantity;
            productsToUpdate[productId] = (productsToUpdate[productId] || 0) + quantity;

            // Calculate COGS for sold items
            const cogsPerUnit = await calculateProductCogs(productId, client);
            totalCogs += cogsPerUnit * quantity;
        }

        // Add free items (if applicable)
        if (freeStock && freeStock.quantities) {
            for (const [productIdStr, freeQty] of Object.entries(freeStock.quantities)) {
                const productId = parseInt(productIdStr);
                if (freeQty > 0) {
                    productsToUpdate[productId] = (productsToUpdate[productId] || 0) + freeQty;
                }
            }
        }

        // --- STEP 3: Final Stock Check (Locking Safely) ---
        for (const [productId, quantityToDeduct] of Object.entries(productsToUpdate)) {
            let checkParams = [productId];
            if (stockTable === 'sales_user_stock') {
                checkParams.push(cashierId);
            }

            const checkResult = await client.query(stockCheckQuery, checkParams);
            const availableStock = checkResult.rows[0]?.quantity || 0;

            if (quantityToDeduct > availableStock) {
                // Fetch product name for better error message
                const product = await client.query('SELECT name FROM products WHERE id = $1', [productId]);
                const productName = product.rows[0]?.name || `Product ID ${productId}`;

                throw new Error(
                    `Insufficient stock for ${productName} in ${stockTable}. Needed: ${quantityToDeduct}, Available: ${availableStock}`
                );
            }
        }

        // --- STEP 4: Record the Sale ---
        const saleInsertQuery = `
            INSERT INTO sales_transactions (
                subtotal, tax_amount, total_amount, discount_amount, cashier_id, 
                payment_method, customer_id, note, payment_reference, 
                payment_image_url, status, amount_paid, balance_due, due_date, 
                total_cogs
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 
                    $11, $12, $13, $14, $15)
            RETURNING id;
        `;

        const saleResult = await client.query(saleInsertQuery, [
            subtotal, tax, total, discountAmount, cashierId, 
            paymentMethod, customerId, note, paymentReference, 
            paymentImageUrl, status, amountPaid, balanceDue, dueDate,
            totalCogs
        ]);
        const saleId = saleResult.rows[0].id;

        // --- STEP 5: Record Sale Items ---
        const itemsInsertQuery = `
            INSERT INTO sales_items (sale_id, product_id, quantity, price_at_sale, discount_applied)
            VALUES ($1, $2, $3, $4, $5);
        `;
// Get discount percentage from the frontend payload if available
let discountPercent = 0;
if (discountAmount && subtotal > 0) {
    discountPercent = (discountAmount / subtotal) * 100;
}

for (const item of cart) {
    await client.query(itemsInsertQuery, [
        saleId,
        item.id,
        item.quantity,
        item.price,
        discountPercent.toFixed(2) // Save as e.g., 10.00 (%)
    ]);
}


// --- STEP 5: Deduct Stock (Sold + FREE) ---
for (const [productId, quantityToDeduct] of Object.entries(productsToUpdate)) {
    let updateParams = [quantityToDeduct, productId];
    if (stockTable === 'sales_user_stock') {
        updateParams.push(cashierId);
    }

    const updateResult = await client.query(stockUpdateQuery, updateParams);

    if (updateResult.rowCount === 0 && stockTable === 'sales_user_stock') {
        // Attempt to create a missing record (fallback safeguard)
        const insertQuery = `
            INSERT INTO sales_user_stock (user_id, product_id, quantity)
            VALUES ($1, $2, -($3))
            ON CONFLICT (user_id, product_id) DO UPDATE
            SET quantity = sales_user_stock.quantity - EXCLUDED.quantity
            RETURNING *;
        `;
        await client.query(insertQuery, [cashierId, productId, quantityToDeduct]);
    }
}

// --- STEP 6: Log Free Stock + Confirm Deduction ---
if (freeStock && freeStock.quantities) {
    const { quantities, reason } = freeStock;
    const logQuery = `
        INSERT INTO free_stock_log (sale_id, product_id, quantity, reason, recorded_by)
        VALUES ($1, $2, $3, $4, $5);
    `;

    for (const [productIdStr, quantity] of Object.entries(quantities)) {
        const productId = parseInt(productIdStr);
        if (quantity > 0) {
            // Log it
            await client.query(logQuery, [saleId, productId, quantity, reason, cashierId]);

            // Also reduce free items explicitly from main inventory if sales_user_stock was used
            if (stockTable !== 'sales_user_stock') {
                await client.query(
                    `UPDATE inventory
                     SET quantity = quantity - $1, last_updated = NOW()
                     WHERE product_id = $2;`,
                    [quantity, productId]
                );
            }
        }
    }
}


        await client.query('COMMIT');
        res.status(201).json({ message: 'Sale processed successfully', saleId });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Sale Processing Error:', error.message);
        res.status(500).json({ error: 'Failed to process sale.', details: error.message });
    } finally {
        client.release();
    }
});


// GET /api/sales - Get all sales transactions with filters
router.get('/', async (req, res) => {
    try {
        const { search, startDate, endDate, transactionType, paymentMethod, status, customerId } = req.query; // Added customerId filter
        let query = `
            SELECT
                st.*,
                c.fullname AS customer_name,
                u_cashier.fullname AS cashier_name, -- Join users table for cashier name
                b.name AS branch_name
            FROM sales_transactions st
            LEFT JOIN customers c ON st.customer_id = c.id
            LEFT JOIN users u_cashier ON st.cashier_id = u_cashier.id -- Corrected join for cashiers
            LEFT JOIN branches b ON st.branch_id = b.id
            WHERE 1 = 1
        `;
        const params = [];
        let paramCount = 1;

        if (search) {
            query += ` AND (c.fullname ILIKE $${paramCount} OR u_cashier.fullname ILIKE $${paramCount} OR st.note ILIKE $${paramCount} OR b.name ILIKE $${paramCount})`;
            params.push(`%${search}%`);
            paramCount++;
        }
        if (startDate) {
            query += ` AND st.created_at >= $${paramCount}`;
            params.push(startDate);
            paramCount++;
        }
        if (endDate) {
            const endOfDay = new Date(endDate);
            endOfDay.setDate(endOfDay.getDate() + 1);
            query += ` AND st.created_at < $${paramCount}`;
            params.push(endOfDay.toISOString());
            paramCount++;
        }
        if (transactionType) {
            query += ` AND st.transaction_type = $${paramCount}`;
            params.push(transactionType);
            paramCount++;
        }
        if (paymentMethod) {
            query += ` AND st.payment_method = $${paramCount}`;
            params.push(paymentMethod);
            paramCount++;
        }
        if (status) {
            query += ` AND st.status = $${paramCount}`;
            params.push(status);
            paramCount++;
        }
        if (customerId) { // New filter for customer
            query += ` AND st.customer_id = $${paramCount}`;
            params.push(customerId);
            paramCount++;
        }

        query += ` ORDER BY st.created_at DESC;`;

        const result = await db.pool.query(query, params);
        // Customer name logic if transaction_type affects which name to display
        const salesWithNames = result.rows.map(sale => ({
            ...sale,
            customer_name: sale.transaction_type === 'B2B' ? sale.branch_name : (sale.customer_name || 'Walk-in Customer') // Adjust as per your B2B model if it has customer_id vs branch_id
        }));
        res.status(200).json(salesWithNames);
    } catch (error) {
        console.error('Error fetching sales:', error);
        res.status(500).json({ error: 'Failed to fetch sales.', details: error.message });
    }
});

// GET /api/sales/customer/:customerId/outstanding - Fetch outstanding credit sales for a customer
// This endpoint was provided in the previous step, included here for completeness
router.get('/customer/:customerId/outstanding', async (req, res) => {
    const { customerId } = req.params;
    try {
        const result = await db.query(
            `SELECT
                id,
                total_amount,
                amount_paid,
                balance_due,
                sale_date,
                due_date,
                status
            FROM sales_transactions
            WHERE customer_id = $1 AND balance_due > 0
            ORDER BY sale_date ASC;`,
            [customerId]
        );
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching outstanding sales for customer:', error);
        res.status(500).json({ error: 'Failed to fetch outstanding sales.', details: error.message });
    }
});


// POST /api/sales/b2b - Record a bulk "sales out" to another branch
router.post('/b2b', async (req, res) => {
    const { items, cashierId, note, branchId, driverId, driverName, driverPhoneNumber } = req.body;
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        let finalDriverId = driverId;
        // If driverId is null, it means a new driver is being added
        if (!finalDriverId) {
            const findDriverQuery = 'SELECT id FROM drivers WHERE phone_number = $1';
            const driverResult = await client.query(findDriverQuery, [driverPhoneNumber]);

            if (driverResult.rows.length > 0) {
                finalDriverId = driverResult.rows[0].id;
            } else {
                const createDriverQuery = 'INSERT INTO drivers (name, phone_number) VALUES ($1, $2) RETURNING id';
                const newDriverResult = await client.query(createDriverQuery, [driverName, driverPhoneNumber]);
                finalDriverId = newDriverResult.rows[0].id;
            }
        }

        let totalAmount = 0;
        let transactionTotalCogs = 0;

        // Calculate total amount and COGS for B2B items
        const processedB2BItems = [];
        for (const item of items) {
             // Check stock (similar to retail sale)
            const stockCheckQuery = 'SELECT quantity FROM inventory WHERE product_id = $1';
            const stockCheckResult = await client.query(stockCheckQuery, [item.id]);
            if (stockCheckResult.rows.length === 0 || stockCheckResult.rows[0].quantity < item.quantity) {
                throw new Error(`Insufficient stock for product: ${item.name}. Available: ${stockCheckResult.rows.length > 0 ? stockCheckResult.rows[0].quantity : 0}, Requested: ${item.quantity}.`);
            }

            const cogsPerUnit = await calculateProductCogs(item.id, client); // Calculate COGS
            processedB2BItems.push({ ...item, cogs_per_unit: cogsPerUnit });
            totalAmount += (item.price * item.quantity);
            transactionTotalCogs += cogsPerUnit * item.quantity;
        }

        const subtotal = totalAmount;
        const tax = 0; // Assuming B2B sales might not have direct tax or are handled differently

        const transactionTotalProfit = totalAmount - transactionTotalCogs;


        const saleQuery = `
            INSERT INTO sales_transactions (
                subtotal, tax_amount, total_amount, cashier_id, payment_method,
                payment_proof, customer_id, note, transaction_type, branch_id, driver_id,
                total_cogs, total_profit, status, amount_paid, balance_due
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING id;
        `;
        const saleResult = await client.query(saleQuery, [
            subtotal,
            tax,
            totalAmount,
            cashierId,
            'Internal Transfer', // payment_method
            null,                // payment_proof
            null,                // customer_id (B2B)
            note || `Bulk sale to branch ${branchId}`,
            'B2B',               // transaction_type
            branchId,
            finalDriverId,
            transactionTotalCogs,
            transactionTotalProfit,
            'Paid',              // status
            totalAmount,         // amount_paid
            0                    // balance_due
        ]);
        const salesId = saleResult.rows[0].id;

        const itemPromises = processedB2BItems.map(async item => {
            const itemQuery = `
                INSERT INTO sales_items (sale_id, product_id, quantity, price_at_sale, cost_at_sale)
                VALUES ($1, $2, $3, $4, $5);
            `;
            await client.query(itemQuery, [salesId, item.id, item.quantity, item.price, item.cogs_per_unit]);

            // Update inventory
            const inventoryUpdateQuery = `
                UPDATE inventory
                SET quantity = quantity - $1, last_updated = NOW()
                WHERE product_id = $2;
            `;
            await client.query(inventoryUpdateQuery, [item.quantity, item.id]);
        });

        await Promise.all(itemPromises);
        await client.query('COMMIT');
        res.status(201).json({ message: 'Bulk sale recorded successfully.', salesId: salesId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error recording bulk sale:', error);
        res.status(500).json({ error: 'Failed to record bulk sale.', details: error.message });
    } finally {
        client.release();
    }
});


// GET /api/sales/details/:id - Get a single sale's details
router.get('/details/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const saleQuery = `
            SELECT
                st.*,
                c.fullname AS customer_name,
                u_cashier.fullname AS cashier_name, -- Corrected join for cashiers
                b.name AS branch_name,
                d.name AS driver_name,
                d.phone_number AS driver_phone_number
            FROM sales_transactions st
            LEFT JOIN customers c ON st.customer_id = c.id
            LEFT JOIN branches b ON st.branch_id = b.id
            LEFT JOIN drivers d ON st.driver_id = d.id
            LEFT JOIN users u_cashier ON st.cashier_id = u_cashier.id -- Corrected join for cashiers
            WHERE st.id = $1;
        `;
        const itemsQuery = `
            SELECT si.*, p.name AS product_name, p.image_url, p.category, p.units
            FROM sales_items si
            JOIN products p ON si.product_id = p.id
            WHERE si.sale_id = $1;
        `;

        const saleResult = await db.pool.query(saleQuery, [id]);
        const itemsResult = await db.pool.query(itemsQuery, [id]);

        if (saleResult.rowCount === 0) {
            return res.status(404).json({ error: 'Sale not found.' });
        }

        const saleDetails = {
            ...saleResult.rows[0],
            items: itemsResult.rows,
        };

        res.status(200).json(saleDetails);
    } catch (error) {
        console.error('Error fetching sale details:', error);
        res.status(500).json({ error: 'Failed to fetch sale details.', details: error.message });
    }
});

// GET /api/sales/company - Get company details
router.get('/company', async (req, res) => {
    try {
        const result = await db.pool.query('SELECT * FROM company_details LIMIT 1');
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Company details not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching company details:', error);
        res.status(500).json({ error: 'Failed to fetch company details.', details: error.message });
    }
});

module.exports = router;
