// purple-premium-bread-api/routes/analysis.js - UPDATED VERSION
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// Helper function to get dates for comparison
const getComparisonDates = (period) => {
    const today = new Date();
    let currentPeriodStart, currentPeriodEnd, previousPeriodStart, previousPeriodEnd;

    if (period === 'month') {
        currentPeriodStart = new Date(today.getFullYear(), today.getMonth(), 1);
        currentPeriodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0); // Last day of current month
        previousPeriodStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        previousPeriodEnd = new Date(today.getFullYear(), today.getMonth(), 0); // Last day of previous month
    } else { // default 'week'
        const dayOfWeek = today.getDay(); // Sunday - 0, Monday - 1, etc.
        currentPeriodStart = new Date(today);
        currentPeriodStart.setDate(today.getDate() - dayOfWeek); // Start of current week (Sunday)
        currentPeriodEnd = new Date(today);
        currentPeriodEnd.setDate(currentPeriodStart.getDate() + 6); // End of current week (Saturday)

        previousPeriodStart = new Date(currentPeriodStart);
        previousPeriodStart.setDate(currentPeriodStart.getDate() - 7); // Start of previous week
        previousPeriodEnd = new Date(currentPeriodEnd);
        previousPeriodEnd.setDate(currentPeriodEnd.getDate() - 7); // End of previous week
    }

    // Adjust to ISO string format without time for SQL date comparison
    return {
        currentPeriodStart: currentPeriodStart.toISOString().split('T')[0],
        currentPeriodEnd: currentPeriodEnd.toISOString().split('T')[0],
        previousPeriodStart: previousPeriodStart.toISOString().split('T')[0],
        previousPeriodEnd: previousPeriodEnd.toISOString().split('T')[0],
    };
};

// Helper function to apply date filters
const applyDateFilters = (baseQuery, baseParams, initialParamIndex, startDate, endDate, dateColumn = 'created_at') => {
    let query = baseQuery;
    let params = [...baseParams];
    let paramIndex = initialParamIndex;

    if (startDate) {
        query += ` AND ${dateColumn} >= $${paramIndex++}`;
        params.push(startDate);
    }
    if (endDate) {
        const endOfDay = new Date(endDate);
        endOfDay.setDate(endOfDay.getDate() + 1); // Increment day to cover full end date
        query += ` AND ${dateColumn} < $${paramIndex++}`;
        params.push(endOfDay.toISOString());
    }
    return { query, params, paramIndex };
};

// Helper function to apply limit
const applyLimit = (query, params, paramIndex, limit = 10) => {
    if (limit && limit > 0) {
        query += ` LIMIT $${paramIndex++}`;
        params.push(parseInt(limit));
    }
    return { query, params, paramIndex };
};

// GET /api/analysis/sales-comparison - Compare sales/profit for current vs previous period
router.get('/sales-comparison', async (req, res) => {
    const { period = 'month', branchId } = req.query;
    const { currentPeriodStart, currentPeriodEnd, previousPeriodStart, previousPeriodEnd } = getComparisonDates(period);

    let currentQueryParams = [currentPeriodStart, currentPeriodEnd];
    let previousQueryParams = [previousPeriodStart, previousPeriodEnd];
    let branchFilter = '';
    let paramIndex = 3;

    if (branchId) {
        branchFilter = ` AND branch_id = $${paramIndex++}`;
        currentQueryParams.push(parseInt(branchId));
        previousQueryParams.push(parseInt(branchId));
    }

    try {
        // Updated queries to calculate profit correctly as (sales - COGS)
        const currentPeriodData = await db.query(
            `SELECT
                COALESCE(SUM(total_amount), 0) AS total_sales,
                COALESCE(SUM(total_cogs), 0) AS total_cogs,
                COALESCE(SUM(total_amount - total_cogs), 0) AS total_profit
            FROM sales_transactions
            WHERE sale_date >= $1 AND sale_date <= $2 AND status != 'Cancelled' ${branchFilter};`,
            currentQueryParams
        );

        const previousPeriodData = await db.query(
            `SELECT
                COALESCE(SUM(total_amount), 0) AS total_sales,
                COALESCE(SUM(total_cogs), 0) AS total_cogs,
                COALESCE(SUM(total_amount - total_cogs), 0) AS total_profit
            FROM sales_transactions
            WHERE sale_date >= $1 AND sale_date <= $2 AND status != 'Cancelled' ${branchFilter};`,
            previousQueryParams
        );

        const currentSales = parseFloat(currentPeriodData.rows[0].total_sales);
        const currentProfit = parseFloat(currentPeriodData.rows[0].total_profit);
        const previousSales = parseFloat(previousPeriodData.rows[0].total_sales);
        const previousProfit = parseFloat(previousPeriodData.rows[0].total_profit);

        console.log('Sales Comparison - Corrected Profit:', {
            currentPeriod: { sales: currentSales, profit: currentProfit },
            previousPeriod: { sales: previousSales, profit: previousProfit },
            profitCalculation: 'Using (Sales - COGS) instead of stored profit field'
        });

        res.status(200).json({
            period: period,
            filtersUsed: { period, branchId },
            currentPeriod: {
                start: currentPeriodStart,
                end: currentPeriodEnd,
                sales: currentSales,
                profit: currentProfit,
            },
            previousPeriod: {
                start: previousPeriodStart,
                end: previousPeriodEnd,
                sales: previousSales,
                profit: previousProfit,
            },
            dataNote: 'Profit calculated as (Sales - COGS) to correct database inconsistency'
        });

    } catch (error) {
        console.error('Error fetching sales comparison data:', error);
        res.status(500).json({ error: 'Failed to fetch sales comparison data.', details: error.message });
    }
});

// GET /api/analysis/profit-margin-trend - Gross Profit Margin over time
router.get('/profit-margin-trend', async (req, res) => {
    const { period = 'month', limit = 12, branchId, startDate, endDate } = req.query;
    let groupBy;
    let orderBy;

    if (period === 'month') {
        groupBy = `TO_CHAR(sale_date, 'YYYY-MM')`;
        orderBy = `TO_CHAR(sale_date, 'YYYY-MM')`;
    } else { // default 'day'
        groupBy = `DATE(sale_date)`;
        orderBy = `DATE(sale_date)`;
    }

    // Updated to calculate profit correctly as (sales - COGS)
    let query = `
        SELECT
            ${groupBy} AS period_label,
            COALESCE(SUM(total_amount), 0) AS total_revenue,
            COALESCE(SUM(total_cogs), 0) AS total_cogs,
            COALESCE(SUM(total_amount - total_cogs), 0) AS total_profit,
            CASE
                WHEN COALESCE(SUM(total_amount), 0) > 0 THEN
                    (COALESCE(SUM(total_amount - total_cogs), 0) / COALESCE(SUM(total_amount), 0)) * 100
                ELSE 0
            END AS gross_profit_margin
        FROM sales_transactions
        WHERE status != 'Cancelled'
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'sale_date'));

    if (branchId) {
        query += ` AND branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY period_label
        ORDER BY period_label DESC
        LIMIT $${paramIndex++};
    `;
    params.push(parseInt(limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { period, limit, branchId, startDate, endDate },
            reportData: result.rows.reverse(),
            dataNote: 'Profit and margin calculated using (Sales - COGS)'
        });
    } catch (error) {
        console.error('Error fetching profit margin trend:', error);
        res.status(500).json({ error: 'Failed to fetch profit margin trend.', details: error.message });
    }
});

// GET /api/analysis/inventory-turnover - Calculate inventory turnover rate
router.get('/inventory-turnover', async (req, res) => {
    const { productId, startDate, endDate, branchId } = req.query;

    let dateFilter = '';
    let dateParams = [];
    let dateParamIndex = 1;

    ({ query: dateFilter, params: dateParams, paramIndex: dateParamIndex } = applyDateFilters(
        '', dateParams, dateParamIndex, startDate, endDate, 'st.sale_date'
    ));

    try {
        let totalCogsQuery = `
            SELECT COALESCE(SUM(total_cogs), 0) AS cogs_total
            FROM sales_transactions st
            WHERE st.status != 'Cancelled' ${dateFilter}
        `;
        let totalCogsParams = [...dateParams];
        let cogsParamIndex = dateParamIndex;

        if (productId) {
            totalCogsQuery = `
                SELECT COALESCE(SUM(si.quantity * si.cost_at_sale), 0) AS cogs_total
                FROM sales_items si
                JOIN sales_transactions st ON si.sale_id = st.id
                WHERE st.status != 'Cancelled' AND si.product_id = $${cogsParamIndex++} ${dateFilter}
            `;
            totalCogsParams.push(parseInt(productId));
        }
        if (branchId) {
            totalCogsQuery += ` AND st.branch_id = $${cogsParamIndex++}`;
            totalCogsParams.push(parseInt(branchId));
        }
        
        const cogsResult = await db.query(totalCogsQuery, totalCogsParams);
        const cogs = parseFloat(cogsResult.rows[0].cogs_total);

        // Current Inventory Value
        let currentInventoryQuery = `
            SELECT COALESCE(SUM(i.quantity * p.price), 0) AS current_inventory_value
            FROM inventory i
            JOIN products p ON i.product_id = p.id
        `;
        let currentInvParams = [];
        let currentInvParamIndex = 1;

        if (productId) {
            currentInventoryQuery += ` WHERE i.product_id = $${currentInvParamIndex++}`;
            currentInvParams.push(parseInt(productId));
        }

        const currentInventoryResult = await db.query(currentInventoryQuery, currentInvParams);
        const currentInventoryValue = parseFloat(currentInventoryResult.rows[0].current_inventory_value);

        let turnoverRate = 0;
        if (cogs > 0 && currentInventoryValue > 0) {
            turnoverRate = cogs / currentInventoryValue;
        }

        res.status(200).json({
            filtersUsed: { productId, startDate, endDate, branchId },
            reportData: {
                productId: productId || 'All Products',
                cogs: cogs,
                averageInventoryValue: currentInventoryValue,
                inventoryTurnoverRate: turnoverRate,
                turnover_ratio: turnoverRate,
                days_in_inventory: currentInventoryValue > 0 ? (365 / turnoverRate) : 0,
                cost_of_goods_sold: cogs,
                average_inventory: currentInventoryValue,
                explanation: "Inventory turnover rate (COGS / Average Inventory Value). Note: Average inventory is approximated using current stock value for simplicity."
            }
        });

    } catch (error) {
        console.error('Error fetching inventory turnover data:', error);
        res.status(500).json({ error: 'Failed to fetch inventory turnover data.', details: error.message });
    }
});

// GET /api/analysis/sales-trend-by-category-product
router.get('/sales-trend-by-category-product', async (req, res) => {
    const { startDate, endDate, category, productId, period = 'month', branchId, limit = 50 } = req.query;
    let groupBy;
    let orderBy;

    if (period === 'month') {
        groupBy = `TO_CHAR(st.sale_date, 'YYYY-MM')`;
        orderBy = `TO_CHAR(st.sale_date, 'YYYY-MM')`;
    } else {
        groupBy = `DATE(st.sale_date)`;
        orderBy = `DATE(st.sale_date)`;
    }

    let query = `
        SELECT
            ${groupBy} AS period_label,
            COALESCE(SUM(si.quantity * si.price_at_sale), 0) AS total_sales_amount
        FROM sales_items si
        JOIN sales_transactions st ON si.sale_id = st.id
        JOIN products p ON si.product_id = p.id
        WHERE st.status != 'Cancelled'
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (category) {
        query += ` AND p.category ILIKE $${paramIndex++}`;
        params.push(`%${category}%`);
    }
    if (productId) {
        query += ` AND p.id = $${paramIndex++}`;
        params.push(parseInt(productId));
    }
    if (branchId) {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY period_label
        ORDER BY period_label ASC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, category, productId, period, branchId, limit },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching sales trend by category/product:', error);
        res.status(500).json({ error: 'Failed to fetch sales trend by category/product.', details: error.message });
    }
});

// GET /api/analysis/top-customers-by-sales - UPDATED with profit calculation
router.get('/top-customers-by-sales', async (req, res) => {
    const { startDate, endDate, limit = 10, branchId } = req.query;
    let query = `
        SELECT
            c.id AS customer_id,
            c.fullname AS customer_name,
            COALESCE(SUM(st.total_amount), 0) AS total_sales_amount,
            COALESCE(SUM(st.total_amount - st.total_cogs), 0) AS total_profit,
            COUNT(st.id) AS total_transactions,
            CASE 
                WHEN COUNT(st.id) > 0 THEN COALESCE(AVG(st.total_amount), 0)
                ELSE 0 
            END AS avg_transaction_amount
        FROM customers c
        JOIN sales_transactions st ON c.id = st.customer_id
        WHERE st.status != 'Cancelled'
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (branchId) {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY c.id, c.fullname
        ORDER BY total_sales_amount DESC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, limit, branchId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching top customers by sales:', error);
        res.status(500).json({ error: 'Failed to fetch top customers by sales.', details: error.message });
    }
});

// GET /api/analysis/production-waste-over-time
router.get('/production-waste-over-time', async (req, res) => {
    const { startDate, endDate, period = 'month', branchId, limit = 50 } = req.query;
    let groupBy;
    let orderBy;

    if (period === 'month') {
        groupBy = `TO_CHAR(pl.production_date, 'YYYY-MM')`;
        orderBy = `TO_CHAR(pl.production_date, 'YYYY-MM')`;
    } else {
        groupBy = `DATE(pl.production_date)`;
        orderBy = `DATE(pl.production_date)`;
    }

    let query = `
        SELECT
            ${groupBy} AS period_label,
            COALESCE(SUM(pl.quantity_produced), 0) AS total_produced,
            COALESCE(SUM(pl.waste_quantity), 0) AS total_waste,
            CASE
                WHEN COALESCE(SUM(pl.quantity_produced), 0) > 0 THEN
                    COALESCE(SUM(pl.waste_quantity), 0) / COALESCE(SUM(pl.quantity_produced), 0) * 100
                ELSE 0
            END AS waste_percentage
        FROM production_logs pl
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'pl.production_date'));

    query += `
        GROUP BY period_label
        ORDER BY period_label ASC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, period, branchId, limit },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching production waste over time:', error);
        res.status(500).json({ error: 'Failed to fetch production waste over time.', details: error.message });
    }
});

// GET /api/analysis/raw-material-stock-value-trend
router.get('/raw-material-stock-value-trend', async (req, res) => {
    const { startDate, endDate, rawMaterialId, period = 'month', branchId, limit = 50 } = req.query;

    let groupBy;

    if (period === 'month') {
        groupBy = `TO_CHAR(dmv.date_key, 'YYYY-MM')`;
    } else {
        groupBy = `DATE(dmv.date_key)`;
    }

    let query = `
        WITH DailyMaterialValue AS (
            SELECT
                DATE(mt.transaction_date) AS date_key,
                mt.raw_material_id,
                rm.name AS raw_material_name,
                rm.unit AS raw_material_unit,
                mt.quantity_change,
                rm.restock_price_per_unit AS unit_price,
                mt.quantity_change * rm.restock_price_per_unit AS value_change
            FROM material_transactions mt
            JOIN raw_materials rm ON mt.raw_material_id = rm.id
            WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'mt.transaction_date'));

    if (rawMaterialId) {
        query += ` AND mt.raw_material_id = $${paramIndex++}`;
        params.push(parseInt(rawMaterialId));
    }
    
    query += `
        ),
        AggregatedValue AS (
            SELECT
                ${groupBy} AS period_label,
                SUM(dmv.value_change) AS period_stock_value_change
            FROM DailyMaterialValue dmv
            WHERE 1=1
    `;
    query += `
            GROUP BY period_label
        )
        SELECT
            period_label,
            period_stock_value_change,
            SUM(period_stock_value_change) OVER (ORDER BY period_label ASC) AS cumulative_stock_value
        FROM AggregatedValue
        ORDER BY period_label ASC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, rawMaterialId, period, branchId, limit },
            reportData: result.rows.map(row => ({
                period_label: row.period_label,
                stock_value_change: parseFloat(row.period_stock_value_change),
                cumulative_stock_value: parseFloat(row.cumulative_stock_value)
            }))
        });
    } catch (error) {
        console.error('Error fetching raw material stock value trend:', error);
        res.status(500).json({ error: 'Failed to fetch raw material stock value trend.', details: error.message });
    }
});

// GET /api/analysis/customer-lifetime-value - Include ALL customers - UPDATED with complete data
router.get('/customer-lifetime-value', async (req, res) => {
    const { startDate, endDate, customerId, limit = 10, branchId } = req.query;

    let query = `
        SELECT
            c.id AS customer_id,
            c.fullname AS customer_name,
            COALESCE(SUM(CASE WHEN st.status != 'Cancelled' THEN st.total_amount ELSE 0 END), 0) AS total_revenue_generated,
            COALESCE(SUM(CASE WHEN st.status != 'Cancelled' THEN st.total_amount - st.total_cogs ELSE 0 END), 0) AS total_profit_generated,
            COUNT(CASE WHEN st.status != 'Cancelled' THEN st.id END) AS total_transactions,
            CASE 
                WHEN MIN(st.sale_date) IS NOT NULL THEN MIN(st.sale_date)
                ELSE c.created_at
            END AS first_transaction_date,
            CASE 
                WHEN COUNT(st.id) > 0 THEN COALESCE(AVG(st.total_amount), 0)
                ELSE 0 
            END AS avg_transaction_value
        FROM customers c
        LEFT JOIN sales_transactions st ON c.id = st.customer_id
        WHERE (c.is_active IS NULL OR c.is_active = true)
    `;
    let params = [];
    let paramIndex = 1;

    // Apply date filters to transactions
    if (startDate) {
        query += ` AND (st.sale_date IS NULL OR st.sale_date >= $${paramIndex++})`;
        params.push(startDate);
    }
    if (endDate) {
        const endOfDay = new Date(endDate);
        endOfDay.setDate(endOfDay.getDate() + 1);
        query += ` AND (st.sale_date IS NULL OR st.sale_date < $${paramIndex++})`;
        params.push(endOfDay.toISOString());
    }

    if (customerId) {
        query += ` AND c.id = $${paramIndex++}`;
        params.push(parseInt(customerId));
    }

    query += `
        GROUP BY c.id, c.fullname, c.created_at
        ORDER BY total_profit_generated DESC, c.created_at DESC
    `;

    // Apply limit
    if (limit && limit > 0) {
        query += ` LIMIT $${paramIndex++}`;
        params.push(parseInt(limit));
    }

    try {
        const result = await db.query(query, params);
        
        console.log('CLTV Data (All Customers):', {
            total_customers: result.rows.length,
            customer_names: result.rows.map(r => r.customer_name),
            customers_with_transactions: result.rows.filter(r => r.total_transactions > 0).length,
            customers_without_transactions: result.rows.filter(r => r.total_transactions === 0).length
        });

        const cltvData = result.rows.map(row => {
            const totalProfitGenerated = parseFloat(row.total_profit_generated);
            const totalRevenue = parseFloat(row.total_revenue_generated);
            const totalTransactions = parseInt(row.total_transactions);
            const avgTransactionValue = parseFloat(row.avg_transaction_value);

            return {
                customer_id: row.customer_id,
                customer_name: row.customer_name,
                total_revenue: totalRevenue,
                total_profit: totalProfitGenerated,
                total_transactions: totalTransactions,
                avg_transaction_value: avgTransactionValue,
                first_transaction_date: row.first_transaction_date,
                has_transactions: totalTransactions > 0
            };
        });

        res.status(200).json({
            filtersUsed: { startDate, endDate, customerId, limit, branchId },
            reportData: cltvData,
            data_note: 'Includes all customers, even those with 0 transactions'
        });

    } catch (error) {
        console.error('Error fetching customer lifetime value:', error);
        res.status(500).json({ error: 'Failed to fetch customer lifetime value.', details: error.message });
    }
});

// GET /api/analysis/free-items - Analyze free items given - UPDATED with complete data
router.get('/free-items', async (req, res) => {
    const { startDate, endDate, productId, branchId, limit = 10 } = req.query;
    
    let query = `
        SELECT 
            p.name AS product_name,
            SUM(fsl.quantity) AS total_quantity,
            fsl.reason,
            TO_CHAR(fsl.recorded_at, 'YYYY-MM') AS period_label,
            u.fullname AS recorded_by_name,
            (SUM(fsl.quantity) * p.price) AS total_free_value,
            CASE 
                WHEN (SELECT COALESCE(SUM(si.quantity), 1) FROM sales_items si 
                      JOIN sales_transactions st ON si.sale_id = st.id 
                      WHERE st.status != 'Cancelled' AND si.product_id = p.id) > 0 THEN
                    (SUM(fsl.quantity) / (SELECT COALESCE(SUM(si.quantity), 1) FROM sales_items si 
                                         JOIN sales_transactions st ON si.sale_id = st.id 
                                         WHERE st.status != 'Cancelled' AND si.product_id = p.id)) * 100
                ELSE 0
            END AS free_percentage
        FROM free_stock_log fsl
        JOIN products p ON fsl.product_id = p.id
        JOIN sales_transactions st ON fsl.sale_id = st.id
        JOIN users u ON fsl.recorded_by = u.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'fsl.recorded_at'));

    if (productId) {
        query += ` AND fsl.product_id = $${paramIndex++}`;
        params.push(parseInt(productId));
    }
    if (branchId) {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY p.name, fsl.reason, TO_CHAR(fsl.recorded_at, 'YYYY-MM'), u.fullname, p.price
        ORDER BY total_quantity DESC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, productId, branchId, limit },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching free items analysis:', error);
        res.status(500).json({ error: 'Failed to fetch free items analysis.', details: error.message });
    }
});

// GET /api/analysis/discounts - Analyze discount patterns
router.get('/discounts', async (req, res) => {
    const { startDate, endDate, branchId, limit = 50 } = req.query;
    
    let query = `
        SELECT 
            TO_CHAR(st.sale_date, 'YYYY-MM') AS period_label,
            SUM(st.discount_amount) AS total_discount,
            COUNT(st.id) AS total_transactions,
            AVG(st.discount_amount) AS avg_discount_per_transaction,
            (SUM(st.discount_amount) / NULLIF(SUM(st.total_amount), 0)) * 100 AS discount_percentage_of_sales
        FROM sales_transactions st
        WHERE st.status != 'Cancelled' AND st.discount_amount > 0
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (branchId) {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY TO_CHAR(st.sale_date, 'YYYY-MM')
        ORDER BY period_label ASC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, branchId, limit },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching discount analysis:', error);
        res.status(500).json({ error: 'Failed to fetch discount analysis.', details: error.message });
    }
});

// GET /api/analysis/exchanges - Analyze bread exchanges - UPDATED with complete data
router.get('/exchanges', async (req, res) => {
    const { startDate, endDate, status, branchId, limit = 10 } = req.query;
    
    let query = `
        SELECT 
            er.status,
            COUNT(er.id) AS total_exchanges,
            TO_CHAR(er.created_at, 'YYYY-MM') AS period_label,
            c.fullname AS customer_name,
            u.fullname AS requested_by,
            p.name AS product_name,
            (er.items_requested_jsonb->0->>'quantity')::integer AS exchange_quantity,
            ((er.items_requested_jsonb->0->>'quantity')::integer * p.price) AS exchange_value,
            er.reason AS exchange_reason
        FROM exchange_requests er
        JOIN customers c ON er.customer_id = c.id
        JOIN users u ON er.requested_by_user_id = u.id
        JOIN sales_transactions st ON er.original_sale_id = st.id
        JOIN products p ON (er.items_requested_jsonb->0->>'productId')::integer = p.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'er.created_at'));

    if (status) {
        query += ` AND er.status = $${paramIndex++}`;
        params.push(status);
    }
    if (branchId) {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY er.status, TO_CHAR(er.created_at, 'YYYY-MM'), c.fullname, u.fullname, 
                 p.name, er.items_requested_jsonb, er.reason
        ORDER BY period_label DESC, total_exchanges DESC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, status, branchId, limit },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching exchange analysis:', error);
        res.status(500).json({ error: 'Failed to fetch exchange analysis.', details: error.message });
    }
});

// GET /api/analysis/stock-allocation - Analyze stock allocation to sales users - UPDATED with complete data
router.get('/stock-allocation', async (req, res) => {
    const { userId, productId, branchId, limit = 10 } = req.query;
    
    let query = `
        SELECT 
            u.fullname AS user_name,
            u.role,
            p.name AS product_name,
            sus.quantity AS allocated_quantity,
            sus.last_updated AS allocation_date,
            b.name AS branch_name,
            (sus.quantity * p.price) AS stock_value,
            CASE 
                WHEN sus.quantity > 0 THEN 'Active'
                ELSE 'Inactive'
            END AS status
        FROM sales_user_stock sus
        JOIN users u ON sus.user_id = u.id
        JOIN products p ON sus.product_id = p.id
        LEFT JOIN branches b ON u.id = b.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    if (userId) {
        query += ` AND sus.user_id = $${paramIndex++}`;
        params.push(parseInt(userId));
    }
    if (productId) {
        query += ` AND sus.product_id = $${paramIndex++}`;
        params.push(parseInt(productId));
    }
    if (branchId) {
        query += ` AND b.id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += ` ORDER BY stock_value DESC, u.fullname ASC`;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { userId, productId, branchId, limit },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching stock allocation analysis:', error);
        res.status(500).json({ error: 'Failed to fetch stock allocation analysis.', details: error.message });
    }
});

// GET /api/analysis/salaries - Analyze salary and wages - UPDATED with complete data
router.get('/salaries', async (req, res) => {
    const { startDate, endDate, userId, branchId, limit = 10 } = req.query;
    
    let query = `
        SELECT 
            u.fullname AS staff_name,
            u.role,
            sp.base_salary AS basic_salary,
            sp.allowances,
            sp.deductions,
            sp.net_amount AS net_salary,
            TO_CHAR(sp.salary_period, 'YYYY-MM') AS pay_period,
            sp.payment_method,
            sp.status
        FROM salary_payments sp
        JOIN users u ON sp.user_id = u.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'sp.salary_period'));

    if (userId) {
        query += ` AND sp.user_id = $${paramIndex++}`;
        params.push(parseInt(userId));
    }

    query += ` ORDER BY sp.salary_period DESC, sp.net_amount DESC`;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, userId, branchId, limit },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching salary analysis:', error);
        res.status(500).json({ error: 'Failed to fetch salary analysis.', details: error.message });
    }
});

// GET /api/analysis/operating-expenses - Analyze operating expenses
router.get('/operating-expenses', async (req, res) => {
    const { startDate, endDate, category, branchId, limit = 10 } = req.query;
    
    let query = `
        SELECT 
            oe.category,
            SUM(oe.amount) AS total_amount,
            TO_CHAR(oe.expense_date, 'YYYY-MM') AS period_label,
            COUNT(oe.id) AS total_expenses,
            (SUM(oe.amount) / NULLIF((SELECT COALESCE(SUM(amount), 1) FROM operating_expenses WHERE 1=1), 0)) * 100 AS percentage
        FROM operating_expenses oe
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'oe.expense_date'));

    if (category) {
        query += ` AND oe.category = $${paramIndex++}`;
        params.push(category);
    }
    if (branchId) {
        query += ` AND oe.recorded_by IN (SELECT id FROM users WHERE branch_id = $${paramIndex++})`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY oe.category, TO_CHAR(oe.expense_date, 'YYYY-MM')
        ORDER BY total_amount DESC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, category, branchId, limit },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching operating expenses analysis:', error);
        res.status(500).json({ error: 'Failed to fetch operating expenses analysis.', details: error.message });
    }
});

// GET /api/analysis/staff-performance - Analyze staff performance with CORRECT profit calculation
router.get('/staff-performance', async (req, res) => {
    const { startDate, endDate, role, limit = 10 } = req.query;
    
    let query = `
        SELECT 
            u.id AS user_id,
            u.fullname AS staff_name,
            u.role,
            COUNT(st.id) AS total_transactions,
            COALESCE(SUM(st.total_amount), 0) AS total_sales,
            COALESCE(SUM(st.total_cogs), 0) AS total_cogs,
            -- Calculate profit correctly as (sales - COGS)
            COALESCE(SUM(st.total_amount - st.total_cogs), 0) AS total_profit,
            COALESCE(SUM(st.total_profit), 0) AS stored_profit_incorrect,
            AVG(st.total_amount) AS avg_transaction_value,
            COALESCE(SUM(st.discount_amount), 0) AS total_discounts_given,
            TO_CHAR(MIN(st.sale_date), 'YYYY-MM') AS period_label
        FROM users u
        LEFT JOIN sales_transactions st ON u.id = st.cashier_id AND st.status != 'Cancelled'
        WHERE u.role IN ('sales', 'cashier', 'manager')
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (role) {
        query += ` AND u.role = $${paramIndex++}`;
        params.push(role);
    }

    query += `
        GROUP BY u.id, u.fullname, u.role
        ORDER BY total_sales DESC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        
        // Log profit correction for debugging
        result.rows.forEach(staff => {
            if (parseFloat(staff.total_profit) !== parseFloat(staff.stored_profit_incorrect)) {
                console.log('Staff Profit Correction:', {
                    staff: staff.staff_name,
                    correct_profit: staff.total_profit,
                    incorrect_stored_profit: staff.stored_profit_incorrect,
                    discrepancy: staff.total_profit - staff.stored_profit_incorrect
                });
            }
        });

        const performanceData = result.rows.map(staff => ({
            staff_name: staff.staff_name,
            role: staff.role,
            total_transactions: parseInt(staff.total_transactions),
            total_sales: parseFloat(staff.total_sales),
            total_profit: parseFloat(staff.total_profit), // Using CORRECT profit
            total_cogs: parseFloat(staff.total_cogs),
            avg_transaction_value: parseFloat(staff.avg_transaction_value),
            total_discounts_given: parseFloat(staff.total_discounts_given),
            period_label: staff.period_label,
            profit_margin_percentage: staff.total_sales > 0 ? (staff.total_profit / staff.total_sales * 100) : 0
        }));

        res.status(200).json({
            filtersUsed: { startDate, endDate, role, limit },
            reportData: performanceData,
            data_note: 'Profit calculated as (Sales - COGS) to correct database inconsistency'
        });
    } catch (error) {
        console.error('Error fetching staff performance analysis:', error);
        res.status(500).json({ error: 'Failed to fetch staff performance analysis.', details: error.message });
    }
});

// GET /api/analysis/branch-performance - Compare branch performance with CORRECT profit
router.get('/branch-performance', async (req, res) => {
    const { startDate, endDate, metric = 'sales', limit = 10 } = req.query;
    
    // First, let's get the correct field for performance metric
    let performanceField = '';
    let performanceLabel = '';
    
    switch (metric) {
        case 'sales':
            performanceField = 'COALESCE(SUM(st.total_amount), 0)';
            performanceLabel = 'Total Sales (₦)';
            break;
        case 'profit':
            // Use CORRECT profit calculation
            performanceField = 'COALESCE(SUM(st.total_amount - st.total_cogs), 0)';
            performanceLabel = 'Total Profit (₦)';
            break;
        case 'customers':
            performanceField = 'COUNT(DISTINCT st.customer_id)';
            performanceLabel = 'Unique Customers';
            break;
        case 'transactions':
            performanceField = 'COUNT(st.id)';
            performanceLabel = 'Total Transactions';
            break;
        default:
            performanceField = 'COALESCE(SUM(st.total_amount), 0)';
            performanceLabel = 'Total Sales (₦)';
    }

    let query = `
        SELECT 
            b.id AS branch_id,
            b.name AS branch_name,
            ${performanceField} AS performance_metric,
            -- Always calculate all metrics for comprehensive data
            COUNT(st.id) AS total_transactions,
            COALESCE(SUM(st.total_amount), 0) AS total_sales,
            COALESCE(SUM(st.total_cogs), 0) AS total_cogs,
            -- Calculate profit correctly for ALL branches
            COALESCE(SUM(st.total_amount - st.total_cogs), 0) AS total_profit,
            COALESCE(SUM(st.total_profit), 0) AS stored_profit_incorrect,
            COUNT(DISTINCT st.customer_id) AS unique_customers,
            CASE 
                WHEN COUNT(st.id) > 0 THEN COALESCE(AVG(st.total_amount), 0)
                ELSE 0 
            END AS avg_transaction_value,
            -- Profit margin calculation
            CASE 
                WHEN COALESCE(SUM(st.total_amount), 0) > 0 THEN
                    (COALESCE(SUM(st.total_amount - st.total_cogs), 0) / COALESCE(SUM(st.total_amount), 0)) * 100
                ELSE 0
            END AS profit_margin_percentage
        FROM branches b
        LEFT JOIN sales_transactions st ON b.id = st.branch_id AND st.status != 'Cancelled'
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    query += `
        GROUP BY b.id, b.name
        ORDER BY performance_metric DESC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        
        console.log('Branch Performance - Profit Analysis:', {
            metric: metric,
            branches_analyzed: result.rows.length,
            profit_calculation: 'Using (Sales - COGS) for all profit metrics'
        });

        // Log any profit discrepancies for debugging
        result.rows.forEach(branch => {
            if (parseFloat(branch.total_profit) !== parseFloat(branch.stored_profit_incorrect)) {
                console.log('Branch Profit Correction:', {
                    branch: branch.branch_name,
                    correct_profit: branch.total_profit,
                    incorrect_stored_profit: branch.stored_profit_incorrect,
                    discrepancy: (branch.total_profit - branch.stored_profit_incorrect).toFixed(2)
                });
            }
        });

        const branchData = result.rows.map(branch => ({
            branch_id: branch.branch_id,
            branch_name: branch.branch_name,
            performance_metric: parseFloat(branch.performance_metric),
            performance_label: performanceLabel,
            total_transactions: parseInt(branch.total_transactions),
            total_sales: parseFloat(branch.total_sales),
            total_cogs: parseFloat(branch.total_cogs),
            total_profit: parseFloat(branch.total_profit), // CORRECT profit
            unique_customers: parseInt(branch.unique_customers),
            avg_transaction_value: parseFloat(branch.avg_transaction_value),
            profit_margin_percentage: parseFloat(branch.profit_margin_percentage),
            data_quality: parseFloat(branch.total_profit) !== parseFloat(branch.stored_profit_incorrect) ? 'corrected' : 'consistent'
        }));

        res.status(200).json({
            filtersUsed: { startDate, endDate, metric, limit },
            reportData: branchData,
            data_note: `Profit metrics calculated as (Sales - COGS). Showing ${metric} performance.`
        });
    } catch (error) {
        console.error('Error fetching branch performance analysis:', error);
        res.status(500).json({ error: 'Failed to fetch branch performance analysis.', details: error.message });
    }
});

// GET /api/analysis/stock-issues - Analyze stock issues and transfers - UPDATED with complete data
router.get('/stock-issues', async (req, res) => {
    const { startDate, endDate, issueType, productId, branchId, limit = 10 } = req.query;
    
    let query = `
        SELECT 
            sil.issue_type,
            p.name AS product_name,
            SUM(sil.quantity_changed) AS total_quantity,
            TO_CHAR(sil.created_at, 'YYYY-MM') AS period_label,
            u_from.fullname AS from_user,
            u_to.fullname AS to_user,
            u_recorded.fullname AS recorded_by,
            sil.note,
            b.name AS branch_name,
            (SUM(sil.quantity_changed) * p.price) AS total_value
        FROM stock_issue_log sil
        JOIN products p ON sil.product_id = p.id
        LEFT JOIN users u_from ON sil.from_user_id = u_from.id
        LEFT JOIN users u_to ON sil.to_user_id = u_to.id
        JOIN users u_recorded ON sil.recorded_by = u_recorded.id
        LEFT JOIN branches b ON u_recorded.id = b.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'sil.created_at'));

    if (issueType) {
        query += ` AND sil.issue_type = $${paramIndex++}`;
        params.push(issueType);
    }
    if (productId) {
        query += ` AND sil.product_id = $${paramIndex++}`;
        params.push(parseInt(productId));
    }
    if (branchId) {
        query += ` AND b.id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY sil.issue_type, p.name, TO_CHAR(sil.created_at, 'YYYY-MM'), 
                 u_from.fullname, u_to.fullname, u_recorded.fullname, sil.note, b.name, p.price
        ORDER BY period_label DESC, total_quantity DESC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, issueType, productId, branchId, limit },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching stock issues analysis:', error);
        res.status(500).json({ error: 'Failed to fetch stock issues analysis.', details: error.message });
    }
});

// GET /api/analysis/waste-analysis - Comprehensive waste analysis - UPDATED with complete data
router.get('/waste-analysis', async (req, res) => {
    const { startDate, endDate, productId, branchId, limit = 10 } = req.query;
    
    let query = `
        SELECT 
            p.name AS product_name,
            SUM(ws.quantity) AS total_waste_quantity,
            TO_CHAR(ws.date_recorded, 'YYYY-MM') AS period_label,
            ws.reason AS waste_reason,
            u.fullname AS recorded_by,
            (SUM(ws.quantity) * p.price) AS waste_value
        FROM waste_stock ws
        JOIN products p ON ws.product_id = p.id
        JOIN users u ON ws.recorded_by = u.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'ws.date_recorded'));

    if (productId) {
        query += ` AND ws.product_id = $${paramIndex++}`;
        params.push(parseInt(productId));
    }

    query += `
        GROUP BY p.name, TO_CHAR(ws.date_recorded, 'YYYY-MM'), ws.reason, u.fullname, p.price
        ORDER BY waste_value DESC, total_waste_quantity DESC
    `;

    ({ query, params, paramIndex } = applyLimit(query, params, paramIndex, limit));

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, productId, branchId, limit },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching waste analysis:', error);
        res.status(500).json({ error: 'Failed to fetch waste analysis.', details: error.message });
    }
});

// Add these new endpoints to your existing analysis.js file

// GET /api/analysis/sales-summary - Get total sales, profit, and transactions for period
router.get('/sales-summary', async (req, res) => {
    const { startDate, endDate, branchId } = req.query;
    
    let query = `
        SELECT 
            COALESCE(SUM(total_amount), 0) AS total_sales,
            COALESCE(SUM(total_cogs), 0) AS total_cogs,
            -- ALWAYS calculate profit as (sales - COGS) since stored profit is incorrect
            COALESCE(SUM(total_amount - total_cogs), 0) AS total_profit,
            COUNT(*) AS total_transactions,
            -- Also return the incorrect stored profit for reference
            COALESCE(SUM(total_profit), 0) AS stored_profit_incorrect
        FROM sales_transactions 
        WHERE status != 'Cancelled'
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'sale_date'));

    if (branchId) {
        query += ` AND branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    try {
        const result = await db.query(query, params);
        const data = result.rows[0];
        
        console.log('PROFIT FIX APPLIED - Corrected profit calculation:', {
            total_sales: data.total_sales,
            total_cogs: data.total_cogs,
            correct_profit: data.total_profit,
            incorrect_stored_profit: data.stored_profit_incorrect,
            discrepancy: data.stored_profit_incorrect - data.total_profit
        });

        res.status(200).json({
            filtersUsed: { startDate, endDate, branchId },
            reportData: {
                total_sales: parseFloat(data.total_sales),
                total_profit: parseFloat(data.total_profit), // This is the CORRECT profit
                total_transactions: parseInt(data.total_transactions),
                data_quality_note: 'Profit calculated as (Sales - COGS) to correct database inconsistency'
            }
        });
    } catch (error) {
        console.error('Error fetching sales summary:', error);
        res.status(500).json({ error: 'Failed to fetch sales summary.', details: error.message });
    }
});

// GET /api/analysis/customer-count - Count ALL customers (including those with 0 transactions)
router.get('/customer-count', async (req, res) => {
    const { startDate, endDate, branchId } = req.query;
    
    let query = `
        SELECT 
            COUNT(*) AS total_customers
        FROM customers c
        WHERE c.is_active IS NULL OR c.is_active = true
    `;
    let params = [];
    let paramIndex = 1;

    // If date range is provided, only count customers created in that period
    if (startDate) {
        query += ` AND c.created_at >= $${paramIndex++}`;
        params.push(startDate);
    }
    if (endDate) {
        const endOfDay = new Date(endDate);
        endOfDay.setDate(endOfDay.getDate() + 1);
        query += ` AND c.created_at < $${paramIndex++}`;
        params.push(endOfDay.toISOString());
    }

    try {
        const result = await db.query(query, params);
        console.log('Customer Count (All Customers):', {
            total_customers: result.rows[0].total_customers,
            filters: { startDate, endDate, branchId }
        });
        
        res.status(200).json({
            filtersUsed: { startDate, endDate, branchId },
            reportData: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching customer count:', error);
        res.status(500).json({ error: 'Failed to fetch customer count.', details: error.message });
    }
});

// GET /api/analysis/inventory-value - Get current inventory value
router.get('/inventory-value', async (req, res) => {
    try {
        const query = `
            SELECT 
                COALESCE(SUM(i.quantity * p.price), 0) AS total_value
            FROM inventory i
            JOIN products p ON i.product_id = p.id
        `;
        
        const result = await db.query(query);
        res.status(200).json({
            reportData: result.rows[0]
        });
    } catch (error) {
        console.error('Error fetching inventory value:', error);
        res.status(500).json({ error: 'Failed to fetch inventory value.', details: error.message });
    }
});

module.exports = router;