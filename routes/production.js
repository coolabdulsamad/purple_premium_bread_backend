// // purple-premium-bread-api/routes/production.js

// const express = require('express');
// const router = express.Router();
// const db = require('../db/db');

// // Helper function to generate batch number
// const generateBatchNumber = (date, shift) => {
//     const d = new Date(date);
//     const year = d.getFullYear();
//     const month = String(d.getMonth() + 1).padStart(2, '0');
//     const day = String(d.getDate()).padStart(2, '0');
//     const shiftCode = shift.charAt(0).toUpperCase(); // M, A, N
//     return `Br/${year}${month}${day}--${shiftCode}`;
// };

// // POST /api/production/log - Log daily production & update inventory
// router.post('/log', async (req, res) => {
//     const { productionData, shift, loggedByUserId } = req.body;
//     const client = await db.pool.connect();

//     // Generate a single batch number for this entire submission
//     const currentProductionDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
//     const batchNumber = generateBatchNumber(currentProductionDate, shift);

//     try {
//         await client.query('BEGIN'); // Start transaction

//         const promises = productionData.map(async (item) => {
//             const quantityProduced = item.quantityProduced || 0;
//             const wasteQuantity = item.wasteQuantity || 0;
//             const totalProducedForInventory = quantityProduced - wasteQuantity;

//             // Only log and update inventory if there's actual production or waste
//             if (quantityProduced > 0 || wasteQuantity > 0) {
//                 // Log production including the new batch_number
//                 const logQuery = `
//                     INSERT INTO production_logs (product_id, quantity_produced, waste_quantity, shift, logged_by_user_id, batch_number)
//                     VALUES ($1, $2, $3, $4, $5, $6);
//                 `;
//                 await client.query(logQuery, [item.productId, quantityProduced, wasteQuantity, shift, loggedByUserId, batchNumber]);

//                 // Update inventory if totalProducedForInventory is positive
//                 if (totalProducedForInventory > 0) {
//                     const inventoryUpdateQuery = `
//                         INSERT INTO inventory (product_id, quantity)
//                         VALUES ($1, $2)
//                         ON CONFLICT (product_id) DO UPDATE
//                         SET quantity = inventory.quantity + EXCLUDED.quantity, last_updated = NOW();
//                     `;
//                     await client.query(inventoryUpdateQuery, [item.productId, totalProducedForInventory]);
//                 }
//             }
//         });

//         await Promise.all(promises);
//         await client.query('COMMIT'); // Commit transaction
//         res.status(201).json({ message: 'Production successfully logged and inventory updated.', batchNumber: batchNumber });
//     } catch (error) {
//         await client.query('ROLLBACK'); // Rollback transaction on error
//         console.error('Error logging production or updating inventory:', error);
//         res.status(500).json({ error: 'Failed to log production.', details: error.message });
//     } finally {
//         client.release(); // Release client back to the pool
//     }
// });


// // GET /api/production/history - Get all production logs with filters, including product units, image, category, and batch number
// router.get('/history', async (req, res) => {
//     const { startDate, endDate, productId, userId, shift, batchNumber } = req.query;
//     let query = `
//         SELECT
//             pl.id,
//             pl.production_date,
//             pl.shift,
//             pl.batch_number,
//             pl.quantity_produced,
//             pl.waste_quantity,
//             p.name AS product_name,
//             p.image_url,
//             p.category,
//             p.units,
//             u.fullname AS logged_by
//         FROM production_logs pl
//         JOIN products p ON p.id = pl.product_id
//         JOIN users u ON u.id = pl.logged_by_user_id
//         WHERE 1=1
//     `;
//     const params = [];
//     let paramIndex = 1;

//     if (startDate) {
//         query += ` AND pl.production_date >= $${paramIndex++}`;
//         params.push(startDate);
//     }
//     if (endDate) {
//         query += ` AND pl.production_date <= $${paramIndex++}`;
//         params.push(endDate);
//     }
//     if (productId) {
//         query += ` AND pl.product_id = $${paramIndex++}`;
//         params.push(productId);
//     }
//     if (userId) {
//         query += ` AND pl.logged_by_user_id = $${paramIndex++}`;
//         params.push(userId);
//     }
//     if (shift) {
//         query += ` AND pl.shift ILIKE $${paramIndex++}`;
//         params.push(`%${shift}%`);
//     }
//     if (batchNumber) {
//         query += ` AND pl.batch_number = $${paramIndex++}`;
//         params.push(batchNumber);
//     }

//     query += ` ORDER BY pl.production_date DESC, pl.created_at DESC`;

//     try {
//         const result = await db.query(query, params);
//         res.status(200).json(result.rows);
//     } catch (error) {
//         console.error('Error fetching production history:', error);
//         res.status(500).json({ error: 'Failed to fetch production history.', details: error.message });
//     }
// });

// // GET /api/production/batches - Get all distinct batch numbers for filtering
// router.get('/batches', async (req, res) => {
//     try {
//         const result = await db.query(`
//             SELECT DISTINCT batch_number
//             FROM production_logs
//             WHERE batch_number IS NOT NULL
//             ORDER BY batch_number DESC;
//         `);
//         res.status(200).json(result.rows.map(row => row.batch_number));
//     } catch (error) {
//         console.error('Error fetching distinct batch numbers:', error);
//         res.status(500).json({ error: 'Failed to fetch batch numbers.', details: error.message });
//     }
// });


// // GET /api/production/logs - Get recent production logs with details (used by ProductionAnalytics probably)
// router.get('/logs', async (req, res) => {
//     try {
//         const result = await db.query(`
//             SELECT
//                 pl.id,
//                 p.name AS product_name,
//                 p.units,
//                 pl.quantity_produced,
//                 pl.waste_quantity,
//                 pl.production_date,
//                 pl.shift,
//                 u.fullname AS logged_by
//             FROM production_logs pl
//             JOIN products p ON p.id = pl.product_id
//             JOIN users u ON u.id = pl.logged_by_user_id
//             ORDER BY pl.production_date DESC
//             LIMIT 50
//         `);
//         res.status(200).json(result.rows);
//     } catch (error) {
//         console.error('Error fetching recent production logs:', error);
//         res.status(500).json({ error: 'Failed to fetch recent production logs.', details: error.message });
//     }
// });

// // GET /api/production/analytics - Get aggregated data for charts with filters
// router.get('/analytics', async (req, res) => {
//     const client = await db.pool.connect();
//     try {
//         const { startDate, endDate, productId, category, shift, userId, batchNumber } = req.query;

//         let baseQuery = `
//             FROM production_logs pl
//             JOIN products p ON p.id = pl.product_id
//             JOIN users u ON u.id = pl.logged_by_user_id
//             WHERE 1=1
//         `;
//         const params = [];
//         let paramIndex = 1;

//         // Apply filters to the base query
//         if (startDate) {
//             baseQuery += ` AND pl.production_date >= $${paramIndex++}`;
//             params.push(startDate);
//         }
//         if (endDate) {
//             baseQuery += ` AND pl.production_date <= $${paramIndex++}`;
//             params.push(endDate);
//         }
//         if (productId) {
//             baseQuery += ` AND pl.product_id = $${paramIndex++}`;
//             params.push(productId);
//         }
//         if (category) {
//             baseQuery += ` AND p.category ILIKE $${paramIndex++}`;
//             params.push(`%${category}%`);
//         }
//         if (shift) {
//             baseQuery += ` AND pl.shift = $${paramIndex++}`;
//             params.push(shift);
//         }
//         if (userId) {
//             baseQuery += ` AND pl.logged_by_user_id = $${paramIndex++}`;
//             params.push(userId);
//         }
//         if (batchNumber) {
//             baseQuery += ` AND pl.batch_number = $${paramIndex++}`;
//             params.push(batchNumber);
//         }

//         // 1. Total Production by Date
//         const totalProductionByDateQuery = `
//             SELECT production_date, SUM(quantity_produced) as total_produced, SUM(waste_quantity) as total_waste
//             ${baseQuery}
//             GROUP BY production_date
//             ORDER BY production_date ASC;
//         `;
//         const totalProductionByDate = (await client.query(totalProductionByDateQuery, params)).rows;

//         // 2. Product Mix (Total Produced by Product)
//         const productMixQuery = `
//             SELECT p.name as product_name, SUM(pl.quantity_produced) as total_produced
//             ${baseQuery}
//             GROUP BY p.name
//             ORDER BY total_produced DESC;
//         `;
//         const productMix = (await client.query(productMixQuery, params)).rows;

//         // 3. Waste by Product
//         const wasteByProductQuery = `
//             SELECT p.name as product_name, SUM(pl.waste_quantity) as total_waste
//             ${baseQuery}
//             GROUP BY p.name
//             HAVING SUM(pl.waste_quantity) > 0
//             ORDER BY total_waste DESC;
//         `;
//         const wasteByProduct = (await client.query(wasteByProductQuery, params)).rows;

//         // 4. Production by Shift (Daily Averages/Totals)
//         const productionByShiftQuery = `
//             SELECT pl.shift, SUM(pl.quantity_produced) as total_produced, COUNT(DISTINCT production_date) as num_days
//             ${baseQuery}
//             GROUP BY pl.shift
//             ORDER BY pl.shift;
//         `;
//         const productionByShift = (await client.query(productionByShiftQuery, params)).rows;

//         // 5. Production by Baker
//         const productionByBakerQuery = `
//             SELECT u.fullname as baker_name, SUM(pl.quantity_produced) as total_produced, SUM(pl.waste_quantity) as total_waste
//             ${baseQuery}
//             GROUP BY u.fullname
//             ORDER BY total_produced DESC;
//         `;
//         const productionByBaker = (await client.query(productionByBakerQuery, params)).rows;

//         // 6. Overall Production & Waste Summary
//         const overallSummaryQuery = `
//             SELECT SUM(quantity_produced) as grand_total_produced, SUM(waste_quantity) as grand_total_waste
//             ${baseQuery};
//         `;
//         const overallSummary = (await client.query(overallSummaryQuery, params)).rows[0];

//         res.status(200).json({
//             totalProductionByDate,
//             productMix,
//             wasteByProduct,
//             productionByShift,
//             productionByBaker,
//             overallSummary,
//         });
//     } catch (error) {
//         console.error('Error fetching analytics data:', error);
//         res.status(500).json({ error: 'Failed to fetch analytics data.', details: error.message });
//     } finally {
//         client.release();
//     }
// });


// module.exports = router;


// purple-premium-bread-api/routes/production.js

const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { jwtDecode } = require('jwt-decode');

// Helper function to generate batch number
const generateBatchNumber = (date, shift) => {
    const d = new Date(date);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const shiftCode = shift.charAt(0).toUpperCase(); // M, A, N
    return `Br/${year}${month}${day}--${shiftCode}`;
};

// Helper to get user ID from token (if token is sent in headers)
const getUserIdFromToken = (req) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) {
            const decoded = jwtDecode(token);
            return decoded.id;
        }
    } catch (e) {
        console.error("Failed to decode token for production log", e);
    }
    return null;
};


// POST /api/production/log - Log daily production & update inventory (finished goods & raw materials)
router.post('/log', async (req, res) => {
    const { productionData, shift } = req.body; // loggedByUserId is now derived from token
    const recorded_by_user_id = getUserIdFromToken(req);

    if (!recorded_by_user_id) {
        return res.status(401).json({ error: 'Unauthorized: User not identified for logging production.' });
    }

    const client = await db.pool.connect();

    // Generate a single batch number for this entire submission
    const currentProductionDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const batchNumber = generateBatchNumber(currentProductionDate, shift);

    try {
        await client.query('BEGIN'); // Start transaction

        const logAndDeductPromises = productionData.map(async (item) => {
            const quantityProduced = item.quantityProduced || 0;
            const wasteQuantity = item.wasteQuantity || 0;
            const netProduced = quantityProduced - wasteQuantity; // Net items actually added to stock

            // Only process if there's actual production or waste logged for the finished product
            if (quantityProduced > 0 || wasteQuantity > 0) {

                // --- IMPORTANT: Recipe existence check BEFORE logging ---
                const recipeCheckQuery = `
                    SELECT COUNT(*)
                    FROM recipes
                    WHERE product_id = $1;
                `;
                const recipeCheckResult = await client.query(recipeCheckQuery, [item.productId]);
                if (parseInt(recipeCheckResult.rows[0].count) === 0) {
                    // Fetch product name for better error message
                    const productNameResult = await client.query('SELECT name FROM products WHERE id = $1', [item.productId]);
                    const productName = productNameResult.rows.length > 0 ? productNameResult.rows[0].name : `ID ${item.productId}`;
                    throw new Error(`Product "${productName}" has no recipe defined. Cannot log production without a recipe.`);
                }
                // --- END Recipe existence check ---


                // 1. Log the finished product production (including waste)
                const logQuery = `
                    INSERT INTO production_logs (product_id, quantity_produced, waste_quantity, shift, logged_by_user_id, batch_number)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id; -- Return the log ID to link material transactions
                `;
                const logResult = await client.query(logQuery, [item.productId, quantityProduced, wasteQuantity, shift, recorded_by_user_id, batchNumber]);
                const productionLogId = logResult.rows[0].id;

                // 2. Update finished product inventory (only for net produced items)
                if (netProduced > 0) {
                    const inventoryUpdateQuery = `
                        INSERT INTO inventory (product_id, quantity)
                        VALUES ($1, $2)
                        ON CONFLICT (product_id) DO UPDATE
                        SET quantity = inventory.quantity + EXCLUDED.quantity, last_updated = NOW();
                    `;
                    await client.query(inventoryUpdateQuery, [item.productId, netProduced]);
                }

                // 3. Deduct raw materials based on recipe for NET PRODUCED items
                if (netProduced > 0) {
                    // Fetch the recipe for the current product
                    const recipeQuery = `
                        SELECT r.raw_material_id, r.quantity_required, rm.name as raw_material_name, rm.unit as raw_material_unit, rm.restock_price_per_unit
                        FROM recipes r
                        JOIN raw_materials rm ON r.raw_material_id = rm.id
                        WHERE r.product_id = $1;
                    `;
                    const recipeResult = await client.query(recipeQuery, [item.productId]);
                    const productRecipe = recipeResult.rows;

                    // This check is now redundant because of the initial recipeCheckQuery
                    // But good for defensive programming if logic paths change.
                    if (productRecipe.length === 0) {
                         // This case should ideally not be reached due to the initial check.
                         console.warn(`[Defensive Check] Product ID ${item.productId} still has no recipe defined despite initial check. No raw materials deducted.`);
                    } else {
                        for (const recipeItem of productRecipe) {
                            const totalMaterialUsed = recipeItem.quantity_required * netProduced;

                            // Record raw material usage in material_transactions
                            const materialTransactionQuery = `
                                INSERT INTO material_transactions (raw_material_id, transaction_type, quantity_change, unit_cost, recorded_by_user_id, notes, transaction_date, production_log_id)
                                VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7);
                            `;
                            await client.query(materialTransactionQuery, [
                                recipeItem.raw_material_id,
                                'production_use',
                                -totalMaterialUsed, // Negative value for deduction
                                parseFloat(recipeItem.restock_price_per_unit || 0), // Use current restock price as unit_cost for deduction
                                recorded_by_user_id,
                                `Used for batch ${batchNumber} of ${quantityProduced} units of product ID ${item.productId}.`,
                                productionLogId // Link to the specific production log
                            ]);

                            // Deduct from raw_materials.current_stock
                            const deductRawMaterialQuery = `
                                UPDATE raw_materials
                                SET current_stock = current_stock - $1, updated_at = NOW()
                                WHERE id = $2;
                            `;
                            await client.query(deductRawMaterialQuery, [totalMaterialUsed, recipeItem.raw_material_id]);
                        }
                    }
                }
            }
        });

        await Promise.all(logAndDeductPromises);
        await client.query('COMMIT'); // Commit transaction
        res.status(201).json({ message: 'Production successfully logged, inventory and raw materials updated.', batchNumber: batchNumber });
    } catch (error) {
        await client.query('ROLLBACK'); // Rollback transaction on error
        console.error('Error logging production, updating inventory, or deducting raw materials:', error);
        // Specifically catch the error thrown for missing recipe
        if (error.message.includes('has no recipe defined')) {
            return res.status(400).json({ error: error.message, details: "Please define a recipe for this product in the Recipe Management section." });
        }
        res.status(500).json({ error: 'Failed to log production and update inventory/raw materials.', details: error.message });
    } finally {
        client.release(); // Release client back to the pool
    }
});


// GET /api/production/history - Get all production logs with filters, including product units, image, category, and batch number
router.get('/history', async (req, res) => {
    const { startDate, endDate, productId, userId, shift, batchNumber } = req.query;
    let query = `
        SELECT
            pl.id,
            pl.production_date,
            pl.shift,
            pl.batch_number,
            pl.quantity_produced,
            pl.waste_quantity,
            p.name AS product_name,
            p.image_url,
            p.category,
            p.units,
            u.fullname AS logged_by
        FROM production_logs pl
        JOIN products p ON p.id = pl.product_id
        JOIN users u ON u.id = pl.logged_by_user_id
        WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (startDate) {
        query += ` AND pl.production_date >= $${paramIndex++}`;
        params.push(startDate);
    }
    if (endDate) {
        query += ` AND pl.production_date <= $${paramIndex++}`;
        params.push(endDate);
    }
    if (productId) {
        query += ` AND pl.product_id = $${paramIndex++}`;
        params.push(productId);
    }
    if (userId) {
        query += ` AND pl.logged_by_user_id = $${paramIndex++}`;
        params.push(userId);
    }
    if (shift) {
        query += ` AND pl.shift ILIKE $${paramIndex++}`;
        params.push(`%${shift}%`);
    }
    if (batchNumber) {
        query += ` AND pl.batch_number = $${paramIndex++}`;
        params.push(batchNumber);
    }

    query += ` ORDER BY pl.production_date DESC, pl.created_at DESC`;

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching production history:', error);
        res.status(500).json({ error: 'Failed to fetch production history.', details: error.message });
    }
});

// GET /api/production/batches - Get all distinct batch numbers for filtering
router.get('/batches', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT DISTINCT batch_number
            FROM production_logs
            WHERE batch_number IS NOT NULL
            ORDER BY batch_number DESC;
        `);
        res.status(200).json(result.rows.map(row => row.batch_number));
    } catch (error) {
        console.error('Error fetching distinct batch numbers:', error);
        res.status(500).json({ error: 'Failed to fetch batch numbers.', details: error.message });
    }
});


// GET /api/production/logs - Get recent production logs with details (used by ProductionAnalytics probably)
router.get('/logs', async (req, res) => {
    try {
        const result = await db.query(`
            SELECT
                pl.id,
                p.name AS product_name,
                p.units,
                pl.quantity_produced,
                pl.waste_quantity,
                pl.production_date,
                pl.shift,
                u.fullname AS logged_by
            FROM production_logs pl
            JOIN products p ON p.id = pl.product_id
            JOIN users u ON u.id = pl.logged_by_user_id
            ORDER BY pl.production_date DESC
            LIMIT 50
        `);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching recent production logs:', error);
        res.status(500).json({ error: 'Failed to fetch recent production logs.', details: error.message });
    }
});

// GET /api/production/analytics - Get aggregated data for charts with filters
router.get('/analytics', async (req, res) => {
    const client = await db.pool.connect();
    try {
        const { startDate, endDate, productId, category, shift, userId, batchNumber } = req.query;

        let baseQuery = `
            FROM production_logs pl
            JOIN products p ON p.id = pl.product_id
            JOIN users u ON u.id = pl.logged_by_user_id
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        // Apply filters to the base query
        if (startDate) {
            baseQuery += ` AND pl.production_date >= $${paramIndex++}`;
            params.push(startDate);
        }
        if (endDate) {
            baseQuery += ` AND pl.production_date <= $${paramIndex++}`;
            params.push(endDate);
        }
        if (productId) {
            baseQuery += ` AND pl.product_id = $${paramIndex++}`;
            params.push(productId);
        }
        if (category) {
            baseQuery += ` AND p.category ILIKE $${paramIndex++}`;
            params.push(`%${category}%`);
        }
        if (shift) {
            baseQuery += ` AND pl.shift = $${paramIndex++}`;
            params.push(shift);
        }
        if (userId) {
            baseQuery += ` AND pl.logged_by_user_id = $${paramIndex++}`;
            params.push(userId);
        }
        if (batchNumber) {
            baseQuery += ` AND pl.batch_number = $${paramIndex++}`;
            params.push(batchNumber);
        }

        // 1. Total Production by Date
        const totalProductionByDateQuery = `
            SELECT production_date, SUM(quantity_produced) as total_produced, SUM(waste_quantity) as total_waste
            ${baseQuery}
            GROUP BY production_date
            ORDER BY production_date ASC;
        `;
        const totalProductionByDate = (await client.query(totalProductionByDateQuery, params)).rows;

        // 2. Product Mix (Total Produced by Product)
        const productMixQuery = `
            SELECT p.name as product_name, SUM(pl.quantity_produced) as total_produced
            ${baseQuery}
            GROUP BY p.name
            ORDER BY total_produced DESC;
        `;
        const productMix = (await client.query(productMixQuery, params)).rows;

        // 3. Waste by Product
        const wasteByProductQuery = `
            SELECT p.name as product_name, SUM(pl.waste_quantity) as total_waste
            ${baseQuery}
            GROUP BY p.name
            HAVING SUM(pl.waste_quantity) > 0
            ORDER BY total_waste DESC;
        `;
        const wasteByProduct = (await client.query(wasteByProductQuery, params)).rows;

        // 4. Production by Shift (Daily Averages/Totals)
        const productionByShiftQuery = `
            SELECT pl.shift, SUM(pl.quantity_produced) as total_produced, COUNT(DISTINCT production_date) as num_days
            ${baseQuery}
            GROUP BY pl.shift
            ORDER BY pl.shift;
        `;
        const productionByShift = (await client.query(productionByShiftQuery, params)).rows;

        // 5. Production by Baker
        const productionByBakerQuery = `
            SELECT u.fullname as baker_name, SUM(pl.quantity_produced) as total_produced, SUM(pl.waste_quantity) as total_waste
            ${baseQuery}
            GROUP BY u.fullname
            ORDER BY total_produced DESC;
        `;
        const productionByBaker = (await client.query(productionByBakerQuery, params)).rows;

        // 6. Overall Production & Waste Summary
        const overallSummaryQuery = `
            SELECT SUM(quantity_produced) as grand_total_produced, SUM(waste_quantity) as grand_total_waste
            ${baseQuery};
        `;
        const overallSummary = (await client.query(overallSummaryQuery, params)).rows[0];

        res.status(200).json({
            totalProductionByDate,
            productMix,
            wasteByProduct,
            productionByShift,
            productionByBaker,
            overallSummary,
        });
    } catch (error) {
        console.error('Error fetching analytics data:', error);
        res.status(500).json({ error: 'Failed to fetch analytics data.', details: error.message });
    } finally {
        client.release();
    }
});


module.exports = router;
