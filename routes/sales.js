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

// POST /api/sales/process - Process a sale (UPDATED with Customer Balance Update)
// router.post('/process', async (req, res) => {
//     const {
//         cart, subtotal, tax, total, discountAmount,
//         cashierId, paymentMethod, customerId, note,
//         paymentReference, paymentImageUrl, status,
//         amountPaid, balanceDue, dueDate,
//         freeStock, // The free stock object from the frontend
//         // NEW: Advantage sale fields
//         isAdvantageSale, advantageTotal, baseSubtotal
//     } = req.body;

//     console.log('Advantage Sale Data Received:', {
//         isAdvantageSale,
//         advantageTotal,
//         baseSubtotal,
//         cartItems: cart.map(item => ({
//             id: item.id,
//             price: item.price,
//             advantageAmount: item.advantageAmount,
//             finalPrice: item.finalPrice
//         }))
//     });

//     const client = await db.pool.connect();
//     try {
//         await client.query('BEGIN');

//         // --- STEP 1: Determine Stock Source ---
//         let stockTable = 'inventory';
//         let stockCheckQuery = 'SELECT quantity FROM inventory WHERE product_id = $1 FOR UPDATE';
//         let stockUpdateQuery = `
//             UPDATE inventory 
//             SET quantity = quantity - $1, last_updated = NOW() 
//             WHERE product_id = $2 
//             RETURNING *;
//         `;

//         const userResult = await client.query(`
//             SELECT role, load_from_demo_stock 
//             FROM users 
//             WHERE id = $1
//         `, [cashierId]);

//         const user = userResult.rows[0];

//         if (user && user.role === 'sales' && user.load_from_demo_stock) {
//             stockTable = 'sales_user_stock';

//             // ✅ FIXED: Directly lock sales_user_stock (no LEFT JOIN)
//             stockCheckQuery = `
//                 SELECT quantity 
//                 FROM sales_user_stock 
//                 WHERE product_id = $1 AND user_id = $2 
//                 FOR UPDATE;
//             `;

//             stockUpdateQuery = `
//                 UPDATE sales_user_stock 
//                 SET quantity = quantity - $1, last_updated = NOW() 
//                 WHERE product_id = $2 AND user_id = $3
//                 RETURNING *;
//             `;
//         }

//         // --- STEP 2: Aggregate All Products (Sold + Free) and Pre-check Stock ---
//         const productsToUpdate = {};
//         let totalCogs = 0;

//         // Add sold items
//         for (const item of cart) {
//             const productId = item.id;
//             const quantity = item.quantity;
//             productsToUpdate[productId] = (productsToUpdate[productId] || 0) + quantity;

//             // Calculate COGS for sold items
//             const cogsPerUnit = await calculateProductCogs(productId, client);
//             totalCogs += cogsPerUnit * quantity;
//         }

//         const totalProfit = total - totalCogs;

//         // Add free items (if applicable)
//         if (freeStock && freeStock.quantities) {
//             for (const [productIdStr, freeQty] of Object.entries(freeStock.quantities)) {
//                 const productId = parseInt(productIdStr);
//                 if (freeQty > 0) {
//                     productsToUpdate[productId] = (productsToUpdate[productId] || 0) + freeQty;
//                 }
//             }
//         }

//         // --- STEP 3: Final Stock Check (Locking Safely) ---
//         for (const [productId, quantityToDeduct] of Object.entries(productsToUpdate)) {
//             let checkParams = [productId];
//             if (stockTable === 'sales_user_stock') {
//                 checkParams.push(cashierId);
//             }

//             const checkResult = await client.query(stockCheckQuery, checkParams);
//             const availableStock = checkResult.rows[0]?.quantity || 0;

//             if (quantityToDeduct > availableStock) {
//                 const product = await client.query('SELECT name FROM products WHERE id = $1', [productId]);
//                 const productName = product.rows[0]?.name || `Product ID ${productId}`;
//                 throw new Error(
//                     `Insufficient stock for ${productName} in ${stockTable}. Needed: ${quantityToDeduct}, Available: ${availableStock}`
//                 );
//             }
//         }

// // --- STEP 4: UPDATE CUSTOMER BALANCE IF CREDIT SALE ---
// if (customerId && paymentMethod === 'Credit' && balanceDue > 0) {
//   console.log(`Updating customer ${customerId} balance by ${balanceDue} (remaining amount)`);

//   const updateCustomerBalanceQuery = `
//     UPDATE customers 
//     SET balance = balance + $1, updated_at = NOW() 
//     WHERE id = $2
//     RETURNING *;
//   `;

//   const customerUpdateResult = await client.query(updateCustomerBalanceQuery, [balanceDue, customerId]);

//   if (customerUpdateResult.rowCount === 0) {
//     throw new Error('Customer not found when updating balance');
//   }

//   console.log('Customer balance updated successfully:', customerUpdateResult.rows[0]);
// } else if (customerId && paymentMethod === 'Credit' && balanceDue === 0) {
//   console.log(`Credit sale with full payment - no balance to update for customer ${customerId}`);
// }

//         // --- STEP 5: Record the Sale ---
//         const saleInsertQuery = `
//             INSERT INTO sales_transactions (
//                 subtotal, tax_amount, total_amount, discount_amount, cashier_id, 
//                 payment_method, customer_id, note, payment_reference, 
//                 payment_image_url, status, amount_paid, balance_due, due_date, 
//                 total_cogs, total_profit, stock_source, stock_source_user_id,
//                 is_advantage_sale, advantage_total, base_subtotal
//             )
//             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 
//                     $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) 
//             RETURNING id;
//         `;

//         // Determine stock source
//         let stockSource = 'main_inventory';
//         let stockSourceUserId = null;

//         if (user && user.role === 'sales' && user.load_from_demo_stock) {
//             stockSource = 'user_stock';
//             stockSourceUserId = cashierId;
//         }

//         const saleResult = await client.query(saleInsertQuery, [
//             subtotal, tax, total, discountAmount, cashierId,
//             paymentMethod, customerId, note, paymentReference,
//             paymentImageUrl, status, amountPaid, balanceDue, dueDate,
//             totalCogs, totalProfit, stockSource, stockSourceUserId,
//             // NEW: Advantage sale parameters
//             isAdvantageSale || false,
//             advantageTotal || 0,
//             baseSubtotal || subtotal
//         ]);
//         const saleId = saleResult.rows[0].id;

//         // --- STEP 6: Record Sale Items ---
//         const itemsInsertQuery = `
//             INSERT INTO sales_items (
//                 sale_id, product_id, quantity, price_at_sale, discount_applied,
//                 advantage_amount, final_price
//             )
//             VALUES ($1, $2, $3, $4, $5, $6, $7);
//         `;

//         // Get discount percentage
//         let discountPercent = 0;
//         if (discountAmount && subtotal > 0) {
//             discountPercent = (discountAmount / subtotal) * 100;
//         }

//         for (const item of cart) {
//             // Extract advantage amount and final price from item data
//             const advantageAmount = item.advantageAmount || 0;
//             const finalPrice = item.finalPrice || item.price;
//             const basePrice = item.price; // Original price

//             await client.query(itemsInsertQuery, [
//                 saleId,
//                 item.id,
//                 item.quantity,
//                 basePrice, // Original base price
//                 discountPercent.toFixed(2),
//                 advantageAmount, // Extra amount added for advantage sale
//                 finalPrice // Final price charged (base price + advantage amount)
//             ]);
//         }

//         // --- STEP 7: Deduct Stock ---
//         for (const [productId, quantityToDeduct] of Object.entries(productsToUpdate)) {
//             let updateParams = [quantityToDeduct, productId];
//             if (stockTable === 'sales_user_stock') {
//                 updateParams.push(cashierId);
//             }

//             const updateResult = await client.query(stockUpdateQuery, updateParams);

//             if (updateResult.rowCount === 0 && stockTable === 'sales_user_stock') {
//                 const insertQuery = `
//                     INSERT INTO sales_user_stock (user_id, product_id, quantity)
//                     VALUES ($1, $2, -($3))
//                     ON CONFLICT (user_id, product_id) DO UPDATE
//                     SET quantity = sales_user_stock.quantity - EXCLUDED.quantity
//                     RETURNING *;
//                 `;
//                 await client.query(insertQuery, [cashierId, productId, quantityToDeduct]);
//             }
//         }

//         // --- STEP 8: Log Free Stock ---
//         if (freeStock && freeStock.quantities) {
//             const { quantities, reason } = freeStock;
//             const logQuery = `
//                 INSERT INTO free_stock_log (sale_id, product_id, quantity, reason, recorded_by)
//                 VALUES ($1, $2, $3, $4, $5);
//             `;

//             for (const [productIdStr, quantity] of Object.entries(quantities)) {
//                 const productId = parseInt(productIdStr);
//                 if (quantity > 0) {
//                     await client.query(logQuery, [saleId, productId, quantity, reason, cashierId]);

//                     if (stockTable !== 'sales_user_stock') {
//                         await client.query(
//                             `UPDATE inventory
//                              SET quantity = quantity - $1, last_updated = NOW()
//                              WHERE product_id = $2;`,
//                             [quantity, productId]
//                         );
//                     }
//                 }
//             }
//         }

//         await client.query('COMMIT');
//         res.status(201).json({ message: 'Sale processed successfully', saleId });

//     } catch (error) {
//         await client.query('ROLLBACK');
//         console.error('Sale Processing Error:', error.message);
//         res.status(500).json({ error: 'Failed to process sale.', details: error.message });
//     } finally {
//         client.release();
//     }
// });

// POST /api/sales/process - Process a sale (UPDATED with Customer Balance Update and Rider Support)
router.post('/process', async (req, res) => {
    const {
        cart, subtotal, tax, total, discountAmount,
        cashierId, paymentMethod, customerId, note,
        paymentReference, paymentImageUrl, status,
        amountPaid, balanceDue, dueDate,
        freeStock, // The free stock object from the frontend
        // Advantage sale fields
        isAdvantageSale, advantageTotal, baseSubtotal,
        // Rider sale fields - NEW
        isRiderSale, riderId
    } = req.body;

    console.log('Sale Data Received:', {
        isAdvantageSale,
        advantageTotal,
        baseSubtotal,
        isRiderSale,
        riderId,
        cartItems: cart.map(item => ({
            id: item.id,
            price: item.price,
            advantageAmount: item.advantageAmount,
            finalPrice: item.finalPrice
        }))
    });

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
        const productsToUpdate = {};
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

        const totalProfit = total - totalCogs;

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
                const product = await client.query('SELECT name FROM products WHERE id = $1', [productId]);
                const productName = product.rows[0]?.name || `Product ID ${productId}`;
                throw new Error(
                    `Insufficient stock for ${productName} in ${stockTable}. Needed: ${quantityToDeduct}, Available: ${availableStock}`
                );
            }
        }

        // --- STEP 4: UPDATE CUSTOMER BALANCE IF CREDIT SALE ---
        if (customerId && paymentMethod === 'Credit' && balanceDue > 0) {
            console.log(`Updating customer ${customerId} balance by ${balanceDue} (remaining amount)`);

            const updateCustomerBalanceQuery = `
                UPDATE customers 
                SET balance = balance + $1, updated_at = NOW() 
                WHERE id = $2
                RETURNING *;
            `;

            const customerUpdateResult = await client.query(updateCustomerBalanceQuery, [balanceDue, customerId]);

            if (customerUpdateResult.rowCount === 0) {
                throw new Error('Customer not found when updating balance');
            }

            console.log('Customer balance updated successfully:', customerUpdateResult.rows[0]);
        } else if (customerId && paymentMethod === 'Credit' && balanceDue === 0) {
            console.log(`Credit sale with full payment - no balance to update for customer ${customerId}`);
        }

        // --- STEP 5: UPDATE RIDER BALANCE IF RIDER CREDIT SALE ---
        // --- STEP 5: UPDATE RIDER BALANCE IF RIDER CREDIT SALE ---
        if (isRiderSale && riderId && paymentMethod === 'Credit' && balanceDue > 0) {
            console.log(`Updating rider ${riderId} balance by ${balanceDue} (remaining amount)`);

            // First check if rider exists and get current balance
            const riderCheck = await client.query(
                'SELECT current_balance, credit_limit FROM riders WHERE id = $1',
                [riderId]
            );

            if (riderCheck.rows.length === 0) {
                throw new Error('Rider not found');
            }

            const rider = riderCheck.rows[0];
            const newBalance = parseFloat(rider.current_balance) + parseFloat(balanceDue);

            // Check if new balance would exceed credit limit
            if (newBalance > parseFloat(rider.credit_limit)) {
                throw new Error(`This sale would exceed rider's credit limit. Current balance: ₦${rider.current_balance}, Credit limit: ₦${rider.credit_limit}, Additional amount: ₦${balanceDue}`);
            }

            const updateRiderBalanceQuery = `
        UPDATE riders 
        SET current_balance = current_balance + $1, 
            updated_at = NOW() 
        WHERE id = $2
        RETURNING *;
    `;

            const riderUpdateResult = await client.query(updateRiderBalanceQuery, [balanceDue, riderId]);

            if (riderUpdateResult.rowCount === 0) {
                throw new Error('Rider not found when updating balance');
            }

            console.log('Rider balance updated successfully:', riderUpdateResult.rows[0]);

            // REMOVED: The customer balance update section that was here

        } else if (isRiderSale && riderId && paymentMethod === 'Credit' && balanceDue === 0) {
            console.log(`Rider credit sale with full payment - no balance to update for rider ${riderId}`);
        }

        // --- STEP 6: Record the Sale ---
        const saleInsertQuery = `
            INSERT INTO sales_transactions (
                subtotal, tax_amount, total_amount, discount_amount, cashier_id, 
                payment_method, customer_id, note, payment_reference, 
                payment_image_url, status, amount_paid, balance_due, due_date, 
                total_cogs, total_profit, stock_source, stock_source_user_id,
                is_advantage_sale, advantage_total, base_subtotal,
                is_rider_sale, rider_id
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 
                    $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, 
                    $21, $22, $23) 
            RETURNING id;
        `;

        // Determine stock source
        let stockSource = 'main_inventory';
        let stockSourceUserId = null;

        if (user && user.role === 'sales' && user.load_from_demo_stock) {
            stockSource = 'user_stock';
            stockSourceUserId = cashierId;
        }

        const saleResult = await client.query(saleInsertQuery, [
            subtotal, tax, total, discountAmount, cashierId,
            paymentMethod, customerId, note, paymentReference,
            paymentImageUrl, status, amountPaid, balanceDue, dueDate,
            totalCogs, totalProfit, stockSource, stockSourceUserId,
            // Advantage sale parameters
            isAdvantageSale || false,
            advantageTotal || 0,
            baseSubtotal || subtotal,
            // Rider sale parameters
            isRiderSale || false,
            riderId || null
        ]);
        const saleId = saleResult.rows[0].id;

        // --- STEP 7: Record Sale Items ---
        const itemsInsertQuery = `
            INSERT INTO sales_items (
                sale_id, product_id, quantity, price_at_sale, discount_applied,
                advantage_amount, final_price
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7);
        `;

        // Get discount percentage
        let discountPercent = 0;
        if (discountAmount && subtotal > 0) {
            discountPercent = (discountAmount / subtotal) * 100;
        }

        for (const item of cart) {
            // Extract advantage amount and final price from item data
            const advantageAmount = item.advantageAmount || 0;
            const finalPrice = item.finalPrice || item.price;
            const basePrice = item.price; // Original price

            await client.query(itemsInsertQuery, [
                saleId,
                item.id,
                item.quantity,
                basePrice, // Original base price
                discountPercent.toFixed(2),
                advantageAmount, // Extra amount added for advantage sale
                finalPrice // Final price charged (base price + advantage amount)
            ]);
        }

        // --- STEP 8: Deduct Stock ---
        for (const [productId, quantityToDeduct] of Object.entries(productsToUpdate)) {
            let updateParams = [quantityToDeduct, productId];
            if (stockTable === 'sales_user_stock') {
                updateParams.push(cashierId);
            }

            const updateResult = await client.query(stockUpdateQuery, updateParams);

            if (updateResult.rowCount === 0 && stockTable === 'sales_user_stock') {
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

        // --- STEP 9: Log Free Stock ---
        if (freeStock && freeStock.quantities) {
            const { quantities, reason } = freeStock;
            const logQuery = `
                INSERT INTO free_stock_log (sale_id, product_id, quantity, reason, recorded_by)
                VALUES ($1, $2, $3, $4, $5);
            `;

            for (const [productIdStr, quantity] of Object.entries(quantities)) {
                const productId = parseInt(productIdStr);
                if (quantity > 0) {
                    await client.query(logQuery, [saleId, productId, quantity, reason, cashierId]);

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

        // --- STEP 10: If this was a rider sale, log to rider_payment_history if payment was made ---
        if (isRiderSale && riderId && amountPaid > 0) {
            // First, create a payment record
            const paymentQuery = `
        INSERT INTO payments (
            transaction_id, customer_id, amount, payment_date, 
            payment_method, proof, rider_id, is_rider_payment
        )
        VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7)
        RETURNING id;
    `;

            const paymentResult = await client.query(paymentQuery, [
                saleId,
                customerId || null,
                amountPaid,
                paymentMethod,
                paymentImageUrl || null,
                riderId,
                true // is_rider_payment
            ]);

            const paymentId = paymentResult.rows[0].id;

            // Then log to rider_payment_history with the correct payment_id
            const riderPaymentQuery = `
        INSERT INTO rider_payment_history (
            rider_id, payment_id, amount, payment_date, payment_method, notes, recorded_by
        )
        VALUES ($1, $2, $3, NOW(), $4, $5, $6)
    `;

            await client.query(riderPaymentQuery, [
                riderId,
                paymentId, // Use payment_id, not saleId
                amountPaid,
                paymentMethod,
                `Payment from sale #${saleId}`,
                cashierId
            ]);

            console.log(`Rider payment history updated for rider ${riderId} with payment ID ${paymentId}`);
        }

        await client.query('COMMIT');

        res.status(201).json({
            message: 'Sale processed successfully',
            saleId,
            isRiderSale,
            riderId: riderId || null
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Sale Processing Error:', error.message);
        res.status(500).json({ error: 'Failed to process sale.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/sales - Get all sales transactions with enhanced filters
router.get('/', async (req, res) => {
    try {
        const {
            search, startDate, endDate, transactionType, paymentMethod,
            status, customerId, stockSource, hasFreeStock, discountRange,
            saleType, hasReceipt, hasReference, advantageRange,
            isRiderSale, riderId  // Add these new params
        } = req.query;

        let query = `
            SELECT
                st.*,
                c.fullname AS customer_name,
                u_cashier.fullname AS cashier_name,
                b.name AS branch_name,
                r.fullname as rider_name,
                r.current_balance as rider_balance,
                CASE 
                    WHEN EXISTS (SELECT 1 FROM free_stock_log fsl WHERE fsl.sale_id = st.id) THEN true
                    ELSE false
                END as has_free_stock
            FROM sales_transactions st
            LEFT JOIN customers c ON st.customer_id = c.id
            LEFT JOIN users u_cashier ON st.cashier_id = u_cashier.id
            LEFT JOIN branches b ON st.branch_id = b.id
            LEFT JOIN riders r ON st.rider_id = r.id
            WHERE 1 = 1
        `;

        const params = [];
        let paramCount = 1;

        if (search) {
            query += ` AND (c.fullname ILIKE $${paramCount} OR u_cashier.fullname ILIKE $${paramCount} OR st.note ILIKE $${paramCount} OR b.name ILIKE $${paramCount} OR r.fullname ILIKE $${paramCount})`;
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
        if (customerId) {
            query += ` AND st.customer_id = $${paramCount}`;
            params.push(customerId);
            paramCount++;
        }
        if (stockSource) {
            query += ` AND st.stock_source = $${paramCount}`;
            params.push(stockSource);
            paramCount++;
        }
        if (hasFreeStock === 'true') {
            query += ` AND EXISTS (SELECT 1 FROM free_stock_log fsl WHERE fsl.sale_id = st.id)`;
        } else if (hasFreeStock === 'false') {
            query += ` AND NOT EXISTS (SELECT 1 FROM free_stock_log fsl WHERE fsl.sale_id = st.id)`;
        }
        if (discountRange) {
            switch (discountRange) {
                case 'none':
                    query += ` AND st.discount_amount = 0`;
                    break;
                case 'small':
                    query += ` AND st.discount_amount > 0 AND st.discount_amount <= 500`;
                    break;
                case 'medium':
                    query += ` AND st.discount_amount > 500 AND st.discount_amount <= 2000`;
                    break;
                case 'large':
                    query += ` AND st.discount_amount > 2000`;
                    break;
            }
        }

        // New filters
        if (saleType === 'advantage') {
            query += ` AND st.is_advantage_sale = true`;
        } else if (saleType === 'regular') {
            query += ` AND (st.is_advantage_sale = false OR st.is_advantage_sale IS NULL)`;
        }

        if (hasReceipt === 'true') {
            query += ` AND st.payment_image_url IS NOT NULL AND st.payment_image_url != ''`;
        } else if (hasReceipt === 'false') {
            query += ` AND (st.payment_image_url IS NULL OR st.payment_image_url = '')`;
        }

        if (hasReference === 'true') {
            query += ` AND st.payment_reference IS NOT NULL AND st.payment_reference != ''`;
        } else if (hasReference === 'false') {
            query += ` AND (st.payment_reference IS NULL OR st.payment_reference = '')`;
        }

        if (advantageRange) {
            switch (advantageRange) {
                case 'none':
                    query += ` AND (st.is_advantage_sale = false OR st.is_advantage_sale IS NULL OR st.advantage_total = 0 OR st.advantage_total IS NULL)`;
                    break;
                case 'small':
                    query += ` AND st.is_advantage_sale = true AND st.advantage_total > 0 AND st.advantage_total <= 500`;
                    break;
                case 'medium':
                    query += ` AND st.is_advantage_sale = true AND st.advantage_total > 500 AND st.advantage_total <= 2000`;
                    break;
                case 'large':
                    query += ` AND st.is_advantage_sale = true AND st.advantage_total > 2000`;
                    break;
            }
        }

        // Add rider filters
        if (isRiderSale === 'true') {
            query += ` AND st.is_rider_sale = true`;
        } else if (isRiderSale === 'false') {
            query += ` AND (st.is_rider_sale = false OR st.is_rider_sale IS NULL)`;
        }

        if (riderId) {
            query += ` AND st.rider_id = $${paramCount}`;
            params.push(riderId);
            paramCount++;
        }

        query += ` ORDER BY st.created_at DESC`;

        const result = await db.pool.query(query, params);

        // Map the results to ensure consistent naming
        const salesWithNames = result.rows.map(sale => ({
            ...sale,
            customer_name: sale.transaction_type === 'B2B' ? sale.branch_name : (sale.customer_name || 'Walk-in Customer')
        }));

        res.status(200).json(salesWithNames);
    } catch (error) {
        console.error('Error fetching sales:', error);
        res.status(500).json({
            error: 'Failed to fetch sales.',
            details: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
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


// GET /api/sales/details/:id - Get a single sale's details with free stock
router.get('/details/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const saleQuery = `
            SELECT
                st.*,
                c.fullname AS customer_name,
                c.email AS customer_email,
                c.phone AS customer_phone,
                u_cashier.fullname AS cashier_name,
                u_cashier.email AS cashier_email,
                b.name AS branch_name,
                d.name AS driver_name,
                d.phone_number AS driver_phone_number,
                u_stock.fullname as stock_source_user_name,
                u_stock.username as stock_source_username
            FROM sales_transactions st
            LEFT JOIN customers c ON st.customer_id = c.id
            LEFT JOIN branches b ON st.branch_id = b.id
            LEFT JOIN drivers d ON st.driver_id = d.id
            LEFT JOIN users u_cashier ON st.cashier_id = u_cashier.id
            LEFT JOIN users u_stock ON st.stock_source_user_id = u_stock.id
            WHERE st.id = $1;
        `;

        const itemsQuery = `
            SELECT 
                si.*, 
                p.name AS product_name, 
                p.image_url, 
                p.category, 
                p.units,
                p.description as product_description
            FROM sales_items si
            JOIN products p ON si.product_id = p.id
            WHERE si.sale_id = $1
            ORDER BY si.id;
        `;

        const freeStockQuery = `
            SELECT 
                fsl.*, 
                p.name as product_name,
                p.category as product_category,
                u.fullname as recorded_by_name
            FROM free_stock_log fsl
            JOIN products p ON fsl.product_id = p.id
            LEFT JOIN users u ON fsl.recorded_by = u.id
            WHERE fsl.sale_id = $1
            ORDER BY fsl.id;
        `;

        const [saleResult, itemsResult, freeStockResult] = await Promise.all([
            db.pool.query(saleQuery, [id]),
            db.pool.query(itemsQuery, [id]),
            db.pool.query(freeStockQuery, [id])
        ]);

        if (saleResult.rowCount === 0) {
            return res.status(404).json({ error: 'Sale not found.' });
        }

        const saleDetails = {
            ...saleResult.rows[0],
            items: itemsResult.rows,
            free_stock_items: freeStockResult.rows
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
        // Check if the table exists first
        const tableCheck = await db.pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'company_details'
            );
        `);

        if (!tableCheck.rows[0].exists) {
            // Return default company details if table doesn't exist
            return res.status(200).json({
                name: 'Purple Premium Bread & Pastries',
                address: '123 Bakery Lane, Lekki, Lagos',
                phone_number: '+234 801 234 5678',
                email: 'info@purplebread.com'
            });
        }

        const result = await db.pool.query('SELECT * FROM company_details LIMIT 1');
        if (result.rowCount === 0) {
            // Return default company details if no record exists
            return res.status(200).json({
                name: 'Purple Premium Bread & Pastries',
                address: '123 Bakery Lane, Lekki, Lagos',
                phone_number: '+234 801 234 5678',
                email: 'info@purplebread.com'
            });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching company details:', error);
        // Return default company details on error
        res.status(200).json({
            name: 'Purple Premium Bread & Pastries',
            address: '123 Bakery Lane, Lekki, Lagos',
            phone_number: '+234 801 234 5678',
            email: 'info@purplebread.com'
        });
    }
});

// GET /api/sales/rider/:riderId - Get sales for a specific rider
router.get('/rider/:riderId', async (req, res) => {
    const { riderId } = req.params;
    const { search, startDate, endDate, paymentMethod, status } = req.query;

    try {
        let query = `
            SELECT 
                st.*,
                c.fullname AS customer_name,
                u_cashier.fullname AS cashier_name,
                r.fullname as rider_name,
                r.current_balance as rider_balance,
                (
                    SELECT COALESCE(json_agg(
                        json_build_object(
                            'id', si.id,
                            'product_id', si.product_id,
                            'product_name', p.name,
                            'quantity', si.quantity,
                            'price_at_sale', si.price_at_sale,
                            'advantage_amount', si.advantage_amount,
                            'final_price', si.final_price,
                            'discount_applied', si.discount_applied
                        )
                    ), '[]'::json)
                    FROM sales_items si
                    JOIN products p ON si.product_id = p.id
                    WHERE si.sale_id = st.id
                ) as items
            FROM sales_transactions st
            LEFT JOIN customers c ON st.customer_id = c.id
            LEFT JOIN users u_cashier ON st.cashier_id = u_cashier.id
            LEFT JOIN riders r ON st.rider_id = r.id
            WHERE st.rider_id = $1 AND st.is_rider_sale = true
        `;

        const params = [riderId];
        let paramCount = 2;

        if (search) {
            query += ` AND (
                st.note ILIKE $${paramCount} OR 
                EXISTS (SELECT 1 FROM sales_items si JOIN products p ON si.product_id = p.id WHERE si.sale_id = st.id AND p.name ILIKE $${paramCount})
            )`;
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

        query += ` ORDER BY st.created_at DESC`;

        const result = await db.pool.query(query, params);
        res.status(200).json(result.rows);

    } catch (error) {
        console.error('Error fetching rider sales:', error);
        res.status(500).json({ error: 'Failed to fetch rider sales', details: error.message });
    }
});

// GET /api/sales/rider/:riderId/outstanding - Get outstanding balance for rider
// GET /api/sales/rider/:riderId/outstanding - Get outstanding balance for rider
router.get('/rider/:riderId/outstanding', async (req, res) => {
    const { riderId } = req.params;

    try {
        // Get rider current balance
        const riderQuery = `
            SELECT current_balance, credit_limit, fullname 
            FROM riders 
            WHERE id = $1
        `;

        const riderResult = await db.pool.query(riderQuery, [riderId]);

        if (riderResult.rows.length === 0) {
            return res.status(404).json({ error: 'Rider not found' });
        }

        // Get outstanding sales
        const salesQuery = `
            SELECT 
                id,
                total_amount,
                amount_paid,
                balance_due,
                sale_date,
                due_date,
                status,
                payment_method
            FROM sales_transactions
            WHERE rider_id = $1 AND is_rider_sale = true AND balance_due > 0
            ORDER BY due_date ASC
        `;

        const salesResult = await db.pool.query(salesQuery, [riderId]);

        // Return as an array of outstanding sales
        res.status(200).json(salesResult.rows);

    } catch (error) {
        console.error('Error fetching rider outstanding:', error);
        res.status(500).json({ error: 'Failed to fetch rider outstanding', details: error.message });
    }
});


module.exports = router;
