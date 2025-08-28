// purple-premium-bread-api/routes/dashboard.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// GET /api/dashboard/kpis - Fetch key performance indicators
router.get('/kpis', async (req, res) => {
    const client = await db.pool.connect();
    try {
        // Total Sales (Revenue)
        const totalSalesResult = await client.query(`
            SELECT COALESCE(SUM(total_amount), 0) AS total_sales
            FROM sales_transactions
            WHERE status != 'Cancelled';
        `);
        const totalSales = parseFloat(totalSalesResult.rows[0].total_sales);
        console.log(`[KPI] Total Sales: ${totalSales}`);


        // Total Profit
        const totalProfitResult = await client.query(`
            SELECT COALESCE(SUM(total_profit), 0) AS total_profit
            FROM sales_transactions
            WHERE status != 'Cancelled';
        `);
        const totalProfit = parseFloat(totalProfitResult.rows[0].total_profit);
        console.log(`[KPI] Total Profit: ${totalProfit}`);


        // Outstanding Credit / Accounts Receivable
        const outstandingCreditResult = await client.query(`
            SELECT COALESCE(SUM(balance_due), 0) AS outstanding_credit
            FROM sales_transactions
            WHERE balance_due > 0;
        `);
        const outstandingCredit = parseFloat(outstandingCreditResult.rows[0].outstanding_credit);
        console.log(`[KPI] Outstanding Credit: ${outstandingCredit}`);


        // Current Day's Net Production Quantity (from production_logs)
        const currentDayProductionResult = await client.query(`
            SELECT
                COALESCE(SUM(quantity_produced), 0) AS produced_today,
                COALESCE(SUM(waste_quantity), 0) AS waste_today
            FROM production_logs
            WHERE production_date = CURRENT_DATE;
        `);
        const producedToday = parseFloat(currentDayProductionResult.rows[0].produced_today);
        const wasteToday = parseFloat(currentDayProductionResult.rows[0].waste_today);
        const netProductionToday = producedToday - wasteToday; // This is the new 'netProduction' KPI
        console.log(`[KPI] Net Production Today: ${netProductionToday}`);


        // Raw Material Current Value (Total Stock Value)
        const rawMaterialValueResult = await client.query(`
            SELECT COALESCE(SUM(current_stock * restock_price_per_unit), 0) AS raw_material_value
            FROM raw_materials;
        `);
        const rawMaterialValue = parseFloat(rawMaterialValueResult.rows[0].raw_material_value);
        console.log(`[KPI] Raw Material Value: ${rawMaterialValue}`);


        // Active Alerts Count
        const activeAlertsResult = await client.query(`
            SELECT COUNT(*) AS active_alerts_count
            FROM inventory_alerts
            WHERE status = 'active';
        `);
        const activeAlertsCount = parseInt(activeAlertsResult.rows[0].active_alerts_count);
        console.log(`[KPI] Active Alerts Count: ${activeAlertsCount}`);

        // Production Waste Rate (using today's figures for relevance if possible, or overall if not enough daily data)
        // For KPI, let's keep it simple with overall production waste rate for consistency across "total" type KPIs
        const overallProductionSummary = await client.query(`
            SELECT COALESCE(SUM(quantity_produced), 0) AS total_produced,
                   COALESCE(SUM(waste_quantity), 0) AS total_waste
            FROM production_logs;
        `);
        const overallProduced = parseFloat(overallProductionSummary.rows[0].total_produced);
        const overallWaste = parseFloat(overallProductionSummary.rows[0].total_waste);
        const productionWasteRate = overallProduced > 0 ? (overallWaste / overallProduced) * 100 : 0;
        console.log(`[KPI] Overall Production Waste Rate: ${productionWasteRate.toFixed(2)}%`);


        // Average Sales Value (Average Order Value)
        const avgSalesValueResult = await client.query(`
            SELECT COALESCE(AVG(total_amount), 0) AS average_sales_value
            FROM sales_transactions
            WHERE status != 'Cancelled';
        `);
        const averageSalesValue = parseFloat(avgSalesValueResult.rows[0].average_sales_value);
        console.log(`[KPI] Average Sales Value: ${averageSalesValue}`);


        // Total Customers
        const customersResult = await client.query(`
            SELECT COUNT(*) AS total_customers
            FROM customers;
        `);
        const totalCustomers = parseInt(customersResult.rows[0].total_customers);
        console.log(`[KPI] Total Customers: ${totalCustomers}`);


        res.status(200).json({
            totalSales,
            totalProfit,
            outstandingCredit,
            netProductionToday, // Now represents today's net production
            rawMaterialValue,
            activeAlertsCount,
            productionWasteRate,
            averageSalesValue,
            totalCustomers,
        });

    } catch (error) {
        console.error('Error fetching KPIs:', error);
        res.status(500).json({ error: 'Failed to fetch KPIs.', details: error.message });
    } finally {
        client.release();
    }
});

// GET /api/dashboard/sales-over-time - Sales data aggregated by day or month
router.get('/sales-over-time', async (req, res) => {
    const { period = 'day', limit = 30 } = req.query; // 'day' or 'month', default 30 days
    let groupBy;
    let orderBy;

    if (period === 'month') {
        groupBy = `TO_CHAR(sale_date, 'YYYY-MM')`;
        orderBy = `TO_CHAR(sale_date, 'YYYY-MM')`;
    } else { // default 'day'
        groupBy = `DATE(sale_date)`;
        orderBy = `DATE(sale_date)`;
    }

    try {
        const query = `
            SELECT
                ${groupBy} AS period,
                COALESCE(SUM(total_amount), 0) AS total_sales,
                COALESCE(SUM(total_profit), 0) AS total_profit
            FROM sales_transactions
            WHERE status != 'Cancelled'
            GROUP BY period
            ORDER BY period DESC
            LIMIT $1;
        `;
        const result = await db.query(query, [limit]);
        res.status(200).json(result.rows.reverse()); // Reverse to show oldest first
    } catch (error) {
        console.error('Error fetching sales over time:', error);
        res.status(500).json({ error: 'Failed to fetch sales over time.', details: error.message });
    }
});

// GET /api/dashboard/top-selling-products - Top products by sales amount or quantity
router.get('/top-selling-products', async (req, res) => {
    const { orderBy = 'amount', limit = 5 } = req.query; // 'amount' or 'quantity'

    let orderClause = 'SUM(si.quantity * si.price_at_sale)';
    if (orderBy === 'quantity') {
        orderClause = 'SUM(si.quantity)';
    }

    try {
        const query = `
            SELECT
                p.name AS product_name,
                p.image_url,
                p.units->0->>'display' AS unit_display, -- Get first unit display name
                SUM(si.quantity) AS total_quantity_sold,
                SUM(si.quantity * si.price_at_sale) AS total_sales_amount
            FROM sales_items si
            JOIN products p ON si.product_id = p.id
            GROUP BY p.name, p.image_url, p.units
            ORDER BY ${orderClause} DESC
            LIMIT $1;
        `;
        const result = await db.query(query, [limit]);
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
            WHERE COALESCE(i.quantity, 0) <= p.min_stock_level AND p.min_stock_level > 0 -- Only show products at or below min stock
            ORDER BY p.name ASC;
        `;
        const result = await db.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching product stock levels:', error);
        res.status(500).json({ error: 'Failed to fetch product stock levels.', details: error.message });
    }
});

// GET /api/dashboard/sales-by-payment-method
router.get('/sales-by-payment-method', async (req, res) => {
    try {
        const query = `
            SELECT
                payment_method,
                COALESCE(SUM(total_amount), 0) AS total_sales_amount
            FROM sales_transactions
            WHERE status != 'Cancelled'
            GROUP BY payment_method
            ORDER BY total_sales_amount DESC;
        `;
        const result = await db.query(query);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching sales by payment method:', error);
        res.status(500).json({ error: 'Failed to fetch sales by payment method.', details: error.message });
    }
});

// GET /api/dashboard/raw-material-usage-trend
router.get('/raw-material-usage-trend', async (req, res) => {
    const { period = 'month', limit = 6 } = req.query; // 'day' or 'month'
    let groupBy;
    let orderBy;

    if (period === 'month') {
        groupBy = `TO_CHAR(transaction_date, 'YYYY-MM')`;
        orderBy = `TO_CHAR(transaction_date, 'YYYY-MM')`;
    } else { // default 'day'
        groupBy = `DATE(transaction_date)`;
        orderBy = `DATE(transaction_date)`;
    }

    try {
        const query = `
            SELECT
                ${groupBy} AS period,
                COALESCE(SUM(quantity_change), 0) AS net_material_change,
                COALESCE(SUM(CASE WHEN quantity_change < 0 THEN -quantity_change ELSE 0 END), 0) AS total_material_used,
                COALESCE(SUM(CASE WHEN quantity_change > 0 THEN quantity_change ELSE 0 END), 0) AS total_material_added
            FROM material_transactions
            GROUP BY period
            ORDER BY period DESC
            LIMIT $1;
        `;
        const result = await db.query(query, [limit]);
        res.status(200).json(result.rows.reverse());
    } catch (error) {
        console.error('Error fetching raw material usage trend:', error);
        res.status(500).json({ error: 'Failed to fetch raw material usage trend.', details: error.message });
    }
});

// GET /api/dashboard/customers-by-gender
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

// NEW ENDPOINT: GET /api/dashboard/production-over-time - Daily production and waste trend
router.get('/production-over-time', async (req, res) => {
    const { limit = 30 } = req.query; // Default to last 30 days
    try {
        const query = `
            SELECT
                production_date,
                COALESCE(SUM(quantity_produced), 0) AS total_produced,
                COALESCE(SUM(waste_quantity), 0) AS total_waste,
                COALESCE(SUM(quantity_produced - waste_quantity), 0) AS net_production
            FROM production_logs
            GROUP BY production_date
            ORDER BY production_date DESC
            LIMIT $1;
        `;
        const result = await db.query(query, [limit]);
        res.status(200).json(result.rows.reverse()); // Reverse to show oldest first
    } catch (error) {
        console.error('Error fetching production over time:', error);
        res.status(500).json({ error: 'Failed to fetch production over time.', details: error.message });
    }
});


module.exports = router;
