// purple-premium-bread-api/routes/dashboard.js - UPDATED WITH PROPER FILTERING
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// Helper function to apply date filters
const applyDateFilters = (query, params, paramIndex, startDate, endDate, dateColumn = 'sale_date') => {
    if (startDate) {
        query += ` AND ${dateColumn} >= $${paramIndex++}`;
        params.push(startDate);
    }
    if (endDate) {
        const endOfDay = new Date(endDate);
        endOfDay.setDate(endOfDay.getDate() + 1);
        query += ` AND ${dateColumn} < $${paramIndex++}`;
        params.push(endOfDay.toISOString());
    }
    return { query, params, paramIndex };
};

// GET /api/dashboard/kpis - Fetch key performance indicators WITH FILTERS
router.get('/kpis', async (req, res) => {
    const { startDate, endDate, branchId, category } = req.query;
    const client = await db.pool.connect();
    
    try {
        // Build filter conditions
        let salesFilter = '';
        let customerFilter = '';
        let productionFilter = '';
        const salesParams = [];
        const customerParams = [];
        const productionParams = [];
        let salesParamIndex = 1;
        let customerParamIndex = 1;
        let productionParamIndex = 1;

        // Date filters for sales
        if (startDate) {
            salesFilter += ` AND st.sale_date >= $${salesParamIndex++}`;
            salesParams.push(startDate);
            customerFilter += ` AND c.created_at >= $${customerParamIndex++}`;
            customerParams.push(startDate);
            productionFilter += ` AND pl.production_date >= $${productionParamIndex++}`;
            productionParams.push(startDate);
        }
        if (endDate) {
            const endOfDay = new Date(endDate);
            endOfDay.setDate(endOfDay.getDate() + 1);
            salesFilter += ` AND st.sale_date < $${salesParamIndex++}`;
            salesParams.push(endOfDay.toISOString());
            customerFilter += ` AND c.created_at < $${customerParamIndex++}`;
            customerParams.push(endOfDay.toISOString());
            productionFilter += ` AND pl.production_date < $${productionParamIndex++}`;
            productionParams.push(endOfDay.toISOString());
        }

        // Branch filter
        if (branchId && branchId !== 'all' && branchId !== 'undefined' && branchId !== 'null') {
            salesFilter += ` AND st.branch_id = $${salesParamIndex++}`;
            salesParams.push(parseInt(branchId));
        }

        // Category filter
        if (category && category !== 'all' && category !== 'undefined' && category !== 'null') {
            salesFilter += ` AND EXISTS (
                SELECT 1 FROM sales_items si 
                JOIN products p ON si.product_id = p.id 
                WHERE si.sale_id = st.id AND p.category = $${salesParamIndex++}
            )`;
            salesParams.push(category);
        }

        // 1. Total Sales (Revenue) with filters
        const totalSalesResult = await client.query(`
            SELECT COALESCE(SUM(total_amount), 0) AS total_sales
            FROM sales_transactions st
            WHERE st.status != 'Cancelled'${salesFilter}
        `, salesParams);
        const totalSales = parseFloat(totalSalesResult.rows[0].total_sales);

        // 2. Total Profit with filters (using CORRECT calculation)
        const totalProfitResult = await client.query(`
            SELECT COALESCE(SUM(total_amount - total_cogs), 0) AS total_profit
            FROM sales_transactions st
            WHERE st.status != 'Cancelled'${salesFilter}
        `, salesParams);
        const totalProfit = parseFloat(totalProfitResult.rows[0].total_profit);

        // 3. Outstanding Credit / Accounts Receivable (cumulative - no date filter)
        const outstandingCreditResult = await client.query(`
            SELECT COALESCE(SUM(balance_due), 0) AS outstanding_credit
            FROM sales_transactions
            WHERE balance_due > 0;
        `);
        const outstandingCredit = parseFloat(outstandingCreditResult.rows[0].outstanding_credit);

        // 4. Current Day's Net Production Quantity (always today's data)
        const currentDayProductionResult = await client.query(`
            SELECT
                COALESCE(SUM(quantity_produced), 0) AS produced_today,
                COALESCE(SUM(waste_quantity), 0) AS waste_today
            FROM production_logs
            WHERE production_date = CURRENT_DATE;
        `);
        const producedToday = parseFloat(currentDayProductionResult.rows[0].produced_today);
        const wasteToday = parseFloat(currentDayProductionResult.rows[0].waste_today);
        const netProductionToday = producedToday - wasteToday;

        // 5. Raw Material Current Value (cumulative)
        const rawMaterialValueResult = await client.query(`
            SELECT COALESCE(SUM(current_stock * restock_price_per_unit), 0) AS raw_material_value
            FROM raw_materials;
        `);
        const rawMaterialValue = parseFloat(rawMaterialValueResult.rows[0].raw_material_value);

        // 6. Active Alerts Count (cumulative)
        const activeAlertsResult = await client.query(`
            SELECT COUNT(*) AS active_alerts_count
            FROM inventory_alerts
            WHERE status = 'active';
        `);
        const activeAlertsCount = parseInt(activeAlertsResult.rows[0].active_alerts_count);

        // 7. Production Waste Rate (filtered by date if provided)
        let wasteRateQuery = `
            SELECT 
                COALESCE(SUM(quantity_produced), 0) AS total_produced,
                COALESCE(SUM(waste_quantity), 0) AS total_waste
            FROM production_logs pl
            WHERE 1=1
        `;
        
        if (startDate || endDate) {
            if (startDate) {
                wasteRateQuery += ` AND pl.production_date >= $${productionParamIndex}`;
                productionParams.push(startDate);
                productionParamIndex++;
            }
            if (endDate) {
                const endOfDay = new Date(endDate);
                endOfDay.setDate(endOfDay.getDate() + 1);
                wasteRateQuery += ` AND pl.production_date < $${productionParamIndex}`;
                productionParams.push(endOfDay.toISOString());
                productionParamIndex++;
            }
        }

        const productionSummaryResult = await client.query(wasteRateQuery, productionParams);
        const totalProduced = parseFloat(productionSummaryResult.rows[0].total_produced || 0);
        const totalWaste = parseFloat(productionSummaryResult.rows[0].total_waste || 0);
        const productionWasteRate = totalProduced > 0 ? (totalWaste / totalProduced) * 100 : 0;

        // 8. Average Sales Value (filtered)
        const avgSalesValueResult = await client.query(`
            SELECT COALESCE(AVG(total_amount), 0) AS average_sales_value
            FROM sales_transactions st
            WHERE st.status != 'Cancelled'${salesFilter}
        `, salesParams);
        const averageSalesValue = parseFloat(avgSalesValueResult.rows[0].average_sales_value);

        // 9. New Customers in period (filtered)
        const customersResult = await client.query(`
            SELECT COUNT(*) AS total_customers
            FROM customers c
            WHERE 1=1${customerFilter}
        `, customerParams);
        const totalCustomers = parseInt(customersResult.rows[0].total_customers);

        // 10. Previous period comparison data
        let previousSales = 0;
        let previousProfit = 0;
        
        if (startDate && endDate && salesParams.length > 0) {
            const start = new Date(startDate);
            const end = new Date(endDate);
            const daysDiff = Math.round((end - start) / (1000 * 60 * 60 * 24)) + 1;
            
            const prevStartDate = new Date(start);
            prevStartDate.setDate(prevStartDate.getDate() - daysDiff);
            const prevEndDate = new Date(end);
            prevEndDate.setDate(prevEndDate.getDate() - daysDiff);

            const prevStartStr = prevStartDate.toISOString().split('T')[0];
            const prevEndStr = prevEndDate.toISOString().split('T')[0];

            // Build previous period query
            let prevQuery = `
                SELECT 
                    COALESCE(SUM(total_amount), 0) AS prev_sales,
                    COALESCE(SUM(total_amount - total_cogs), 0) AS prev_profit
                FROM sales_transactions st
                WHERE st.status != 'Cancelled'
                  AND st.sale_date >= $1
                  AND st.sale_date < $2
            `;
            const prevParams = [prevStartStr, prevEndStr];
            let prevParamIndex = 3;

            if (branchId && branchId !== 'all' && branchId !== 'undefined' && branchId !== 'null') {
                prevQuery += ` AND st.branch_id = $${prevParamIndex}`;
                prevParams.push(parseInt(branchId));
                prevParamIndex++;
            }

            if (category && category !== 'all' && category !== 'undefined' && category !== 'null') {
                prevQuery += ` AND EXISTS (
                    SELECT 1 FROM sales_items si 
                    JOIN products p ON si.product_id = p.id 
                    WHERE si.sale_id = st.id AND p.category = $${prevParamIndex}
                )`;
                prevParams.push(category);
                prevParamIndex++;
            }

            const prevResult = await client.query(prevQuery, prevParams);
            previousSales = parseFloat(prevResult.rows[0].prev_sales);
            previousProfit = parseFloat(prevResult.rows[0].prev_profit);
        }

        console.log(`[Filtered KPIs] Period: ${startDate || 'all'} to ${endDate || 'all'}, Total Sales: ${totalSales}, Profit: ${totalProfit}`);

        res.status(200).json({
            totalSales,
            totalProfit,
            outstandingCredit,
            netProductionToday,
            rawMaterialValue,
            activeAlertsCount,
            productionWasteRate,
            averageSalesValue,
            totalCustomers,
            previousSales,
            previousProfit,
            filtersApplied: { startDate, endDate, branchId, category }
        });

    } catch (error) {
        console.error('Error fetching KPIs:', error);
        res.status(500).json({ error: 'Failed to fetch KPIs.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/dashboard/sales-over-time - Sales data aggregated by day or month WITH FILTERS
router.get('/sales-over-time', async (req, res) => {
    const { period = 'day', limit = 30, startDate, endDate, branchId, category } = req.query;
    
    let groupBy;
    if (period === 'month') {
        groupBy = `TO_CHAR(st.sale_date, 'YYYY-MM')`;
    } else {
        groupBy = `DATE(st.sale_date)`;
    }

    let query = `
        SELECT
            ${groupBy} AS period,
            COALESCE(SUM(st.total_amount), 0) AS total_sales,
            COALESCE(SUM(st.total_amount - st.total_cogs), 0) AS total_profit
        FROM sales_transactions st
        WHERE st.status != 'Cancelled'
    `;
    
    const params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (branchId && branchId !== 'all' && branchId !== 'undefined' && branchId !== 'null') {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    if (category && category !== 'all' && category !== 'undefined' && category !== 'null') {
        query += ` AND EXISTS (
            SELECT 1 FROM sales_items si 
            JOIN products p ON si.product_id = p.id 
            WHERE si.sale_id = st.id AND p.category = $${paramIndex++}
        )`;
        params.push(category);
    }

    query += `
        GROUP BY period
        ORDER BY period DESC
        LIMIT $${paramIndex}
    `;
    params.push(parseInt(limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows.reverse());
    } catch (error) {
        console.error('Error fetching sales over time:', error);
        res.status(500).json({ error: 'Failed to fetch sales over time.', details: error.message });
    }
});

// GET /api/dashboard/top-selling-products - Top products by sales amount or quantity WITH FILTERS
router.get('/top-selling-products', async (req, res) => {
    const { orderBy = 'amount', limit = 5, startDate, endDate, branchId, category } = req.query;

    let orderClause = 'SUM(si.quantity * si.price_at_sale)';
    if (orderBy === 'quantity') {
        orderClause = 'SUM(si.quantity)';
    }

    let query = `
        SELECT
            p.id,
            p.name AS product_name,
            p.image_url,
            p.units->0->>'display' AS unit_display,
            SUM(si.quantity) AS total_quantity_sold,
            SUM(si.quantity * si.price_at_sale) AS total_sales_amount
        FROM sales_items si
        JOIN sales_transactions st ON si.sale_id = st.id
        JOIN products p ON si.product_id = p.id
        WHERE st.status != 'Cancelled'
    `;
    
    const params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (branchId && branchId !== 'all' && branchId !== 'undefined' && branchId !== 'null') {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    if (category && category !== 'all' && category !== 'undefined' && category !== 'null') {
        query += ` AND p.category = $${paramIndex++}`;
        params.push(category);
    }

    query += `
        GROUP BY p.id, p.name, p.image_url, p.units
        ORDER BY ${orderClause} DESC
        LIMIT $${paramIndex}
    `;
    params.push(parseInt(limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching top selling products:', error);
        res.status(500).json({ error: 'Failed to fetch top selling products.', details: error.message });
    }
});

// GET /api/dashboard/stock-levels - Overview of current finished product stock levels (for critical low stock)
router.get('/stock-levels', async (req, res) => {
    try {
        const query = `
            SELECT
                p.id,
                p.name AS product_name,
                p.image_url,
                p.min_stock_level,
                p.units->0->>'display' AS unit_display,
                COALESCE(i.quantity, 0) AS current_stock
            FROM products p
            LEFT JOIN inventory i ON p.id = i.product_id
            WHERE COALESCE(i.quantity, 0) <= p.min_stock_level AND p.min_stock_level > 0
            ORDER BY p.name ASC;
        `;
        const result = await db.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching product stock levels:', error);
        res.status(500).json({ error: 'Failed to fetch product stock levels.', details: error.message });
    }
});

// GET /api/dashboard/sales-by-payment-method WITH FILTERS
router.get('/sales-by-payment-method', async (req, res) => {
    const { startDate, endDate, branchId } = req.query;

    let query = `
        SELECT
            payment_method,
            COALESCE(SUM(total_amount), 0) AS total_sales_amount
        FROM sales_transactions st
        WHERE st.status != 'Cancelled'
    `;
    
    const params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (branchId && branchId !== 'all' && branchId !== 'undefined' && branchId !== 'null') {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY payment_method
        ORDER BY total_sales_amount DESC
    `;

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching sales by payment method:', error);
        res.status(500).json({ error: 'Failed to fetch sales by payment method.', details: error.message });
    }
});

// GET /api/dashboard/raw-material-usage-trend WITH FILTERS
router.get('/raw-material-usage-trend', async (req, res) => {
    const { period = 'month', limit = 6, startDate, endDate } = req.query;
    
    let groupBy;
    if (period === 'month') {
        groupBy = `TO_CHAR(transaction_date, 'YYYY-MM')`;
    } else {
        groupBy = `DATE(transaction_date)`;
    }

    let query = `
        SELECT
            ${groupBy} AS period,
            COALESCE(SUM(quantity_change), 0) AS net_material_change,
            COALESCE(SUM(CASE WHEN quantity_change < 0 THEN -quantity_change ELSE 0 END), 0) AS total_material_used,
            COALESCE(SUM(CASE WHEN quantity_change > 0 THEN quantity_change ELSE 0 END), 0) AS total_material_added
        FROM material_transactions
        WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'transaction_date'));

    query += `
        GROUP BY period
        ORDER BY period DESC
        LIMIT $${paramIndex}
    `;
    params.push(parseInt(limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows.reverse());
    } catch (error) {
        console.error('Error fetching raw material usage trend:', error);
        res.status(500).json({ error: 'Failed to fetch raw material usage trend.', details: error.message });
    }
});

// GET /api/dashboard/customers-by-gender (no date filtering - demographic data)
router.get('/customers-by-gender', async (req, res) => {
    try {
        const query = `
            SELECT
                gender,
                COUNT(id) AS customer_count
            FROM customers
            WHERE gender IS NOT NULL AND gender != ''
            GROUP BY gender
            ORDER BY customer_count DESC;
        `;
        const result = await db.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching customers by gender:', error);
        res.status(500).json({ error: 'Failed to fetch customers by gender.', details: error.message });
    }
});

// GET /api/dashboard/production-over-time - Daily production and waste trend WITH FILTERS
router.get('/production-over-time', async (req, res) => {
    const { limit = 30, startDate, endDate } = req.query;
    
    let query = `
        SELECT
            production_date,
            COALESCE(SUM(quantity_produced), 0) AS total_produced,
            COALESCE(SUM(waste_quantity), 0) AS total_waste,
            COALESCE(SUM(quantity_produced - waste_quantity), 0) AS net_production
        FROM production_logs
        WHERE 1=1
    `;
    
    const params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'production_date'));

    query += `
        GROUP BY production_date
        ORDER BY production_date DESC
        LIMIT $${paramIndex}
    `;
    params.push(parseInt(limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows.reverse());
    } catch (error) {
        console.error('Error fetching production over time:', error);
        res.status(500).json({ error: 'Failed to fetch production over time.', details: error.message });
    }
});

module.exports = router;