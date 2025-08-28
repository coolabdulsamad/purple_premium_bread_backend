// purple-premium-bread-api/routes/reports.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');

// Helper function to apply date filters and return the WHERE clause part and new parameters
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

// Profit & Loss Summary Report
router.get('/profit-loss', async (req, res) => {
    const { startDate, endDate, branchId } = req.query;

    let totalRevenueQuery = `
        SELECT COALESCE(SUM(total_amount), 0) AS total_revenue,
               COALESCE(SUM(total_cogs), 0) AS total_cogs,
               COALESCE(SUM(total_profit), 0) AS total_profit
        FROM sales_transactions
        WHERE status != 'Cancelled'
    `;
    let totalRevenueParams = [];
    let paramIndex = 1;

    ({ query: totalRevenueQuery, params: totalRevenueParams, paramIndex } =
        applyDateFilters(totalRevenueQuery, totalRevenueParams, paramIndex, startDate, endDate, 'sale_date'));

    if (branchId) {
        totalRevenueQuery += ` AND branch_id = $${paramIndex++}`;
        totalRevenueParams.push(parseInt(branchId));
    }

    try {
        const salesResult = await db.query(totalRevenueQuery, totalRevenueParams);
        const { total_revenue, total_cogs, total_profit } = salesResult.rows[0];

        // For simplicity, we'll assume "operating expenses" are hardcoded or fetched from another source
        const totalOperatingExpenses = 0; // Placeholder

        const grossProfit = parseFloat(total_revenue) - parseFloat(total_cogs);
        const netProfit = grossProfit - totalOperatingExpenses;

        res.status(200).json({
            reportTitle: 'Profit & Loss Summary',
            filtersUsed: { startDate, endDate, branchId },
            reportData: {
                totalRevenue: parseFloat(total_revenue),
                totalCostOfGoodsSold: parseFloat(total_cogs),
                grossProfit: grossProfit,
                totalOperatingExpenses: totalOperatingExpenses,
                netProfit: netProfit
            }
        });

    } catch (error) {
        console.error('Error generating Profit & Loss report:', error);
        res.status(500).json({ error: 'Failed to generate Profit & Loss report.', details: error.message });
    }
});

// Detailed Sales Report
router.get('/detailed-sales', async (req, res) => {
    const { startDate, endDate, paymentMethod, customerId, status, minTotal, maxTotal, staffId, branchId, transactionType } = req.query;

    let query = `
        SELECT
            st.id AS sale_id,
            st.sale_date,
            COALESCE(c.fullname, 'Walk-in Customer') AS customer_name,
            u.fullname AS cashier_name,
            b.name AS branch_name,
            st.payment_method,
            st.status,
            st.transaction_type,
            st.total_amount,
            st.total_cogs,
            st.total_profit,
            st.note
        FROM sales_transactions st
        LEFT JOIN customers c ON st.customer_id = c.id
        LEFT JOIN users u ON st.cashier_id = u.id
        LEFT JOIN branches b ON st.branch_id = b.id
        WHERE st.status != 'Cancelled'
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (paymentMethod) {
        query += ` AND st.payment_method ILIKE $${paramIndex++}`;
        params.push(`%${paymentMethod}%`);
    }
    if (customerId) {
        query += ` AND st.customer_id = $${paramIndex++}`;
        params.push(parseInt(customerId));
    }
    if (status) {
        query += ` AND st.status ILIKE $${paramIndex++}`;
        params.push(`%${status}%`);
    }
    if (minTotal) {
        query += ` AND st.total_amount >= $${paramIndex++}`;
        params.push(parseFloat(minTotal));
    }
    if (maxTotal) {
        query += ` AND st.total_amount <= $${paramIndex++}`;
        params.push(parseFloat(maxTotal));
    }
    if (staffId) {
        query += ` AND st.cashier_id = $${paramIndex++}`;
        params.push(parseInt(staffId));
    }
    if (branchId) {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }
    if (transactionType) {
        query += ` AND st.transaction_type ILIKE $${paramIndex++}`;
        params.push(`%${transactionType}%`);
    }

    query += ` ORDER BY st.sale_date DESC;`;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            reportTitle: 'Detailed Sales Report',
            filtersUsed: { startDate, endDate, paymentMethod, customerId, status, minTotal, maxTotal, staffId, branchId, transactionType },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating detailed sales report:', error);
        res.status(500).json({ error: 'Failed to generate detailed sales report.', details: error.message });
    }
});

// Product Profitability Report
router.get('/product-profitability', async (req, res) => {
    const { startDate, endDate, productId, category, branchId } = req.query;

    let query = `
        SELECT
            p.id AS product_id,
            p.name AS product_name,
            p.category,
            p.image_url,
            COALESCE(SUM(si.quantity), 0) AS total_quantity_sold,
            COALESCE(SUM(si.quantity * si.price_at_sale), 0) AS total_sales_amount,
            COALESCE(SUM(si.quantity * si.cost_at_sale), 0) AS total_product_cogs,
            COALESCE(SUM(si.quantity * si.price_at_sale) - SUM(si.quantity * si.cost_at_sale), 0) AS product_gross_profit
        FROM sales_items si
        JOIN products p ON si.product_id = p.id
        JOIN sales_transactions st ON si.sale_id = st.id
        WHERE st.status != 'Cancelled'
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (productId) {
        query += ` AND p.id = $${paramIndex++}`;
        params.push(parseInt(productId));
    }
    if (category) {
        query += ` AND p.category ILIKE $${paramIndex++}`;
        params.push(`%${category}%`);
    }
    if (branchId) {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY p.id, p.name, p.category, p.image_url
        ORDER BY product_gross_profit DESC;
    `;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            reportTitle: 'Product Profitability Report',
            filtersUsed: { startDate, endDate, productId, category, branchId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating product profitability report:', error);
        res.status(500).json({ error: 'Failed to generate product profitability report.', details: error.message });
    }
});

// Inventory Movement Report (Finished Products)
router.get('/inventory-movement', async (req, res) => {
    const { startDate, endDate, productId, inventoryTransactionType } = req.query;

    let allQueryParts = [];
    let allParams = [];
    let currentParamIndex = 1;

    // --- Production (INFLUX) ---
    let productionBaseQuery = `
        SELECT
            'PROD-' || pl.id AS transaction_id,
            pl.production_date AS transaction_date,
            p.name AS product_name,
            (p.units->>0) AS product_unit,
            pl.quantity_produced AS quantity_change,
            'production' AS transaction_type,
            'Production batch ' || COALESCE(pl.batch_number, '') AS reason,
            u.fullname AS recorded_by_staff,
            NULL AS branch_name -- Cannot determine branch from users table without branch_id
        FROM production_logs pl
        JOIN products p ON pl.product_id = p.id
        LEFT JOIN users u ON pl.logged_by_user_id = u.id
        WHERE pl.quantity_produced > 0
    `;
    let productionFilterParams = [];
    let productionFilterQuery = productionBaseQuery;

    ({ query: productionFilterQuery, params: productionFilterParams, paramIndex: currentParamIndex } =
        applyDateFilters(productionFilterQuery, productionFilterParams, currentParamIndex, startDate, endDate, 'pl.production_date'));
    
    if (productId) {
        productionFilterQuery += ` AND pl.product_id = $${currentParamIndex++}`;
        productionFilterParams.push(parseInt(productId));
    }

    if (!inventoryTransactionType || inventoryTransactionType === 'production') {
        allQueryParts.push(productionFilterQuery);
        allParams = allParams.concat(productionFilterParams);
    }
    
    // --- Sales (OUTFLUX - quantity decreases) ---
    let salesBaseQuery = `
        SELECT
            'SALE-' || si.id AS transaction_id,
            st.sale_date AS transaction_date,
            p.name AS product_name,
            (p.units->>0) AS product_unit,
            -si.quantity AS quantity_change, -- Negative for sales (outflux)
            'sale' AS transaction_type,
            'Sold in transaction ' || st.id AS reason,
            u.fullname AS recorded_by_staff,
            b.name AS branch_name
        FROM sales_items si
        JOIN sales_transactions st ON si.sale_id = st.id
        JOIN products p ON si.product_id = p.id
        LEFT JOIN users u ON st.cashier_id = u.id
        LEFT JOIN branches b ON st.branch_id = b.id
        WHERE st.status != 'Cancelled'
    `;
    let salesFilterParams = [];
    let salesFilterQuery = salesBaseQuery;

    ({ query: salesFilterQuery, params: salesFilterParams, paramIndex: currentParamIndex } =
        applyDateFilters(salesFilterQuery, salesFilterParams, currentParamIndex, startDate, endDate, 'st.sale_date'));

    if (productId) {
        salesFilterQuery += ` AND si.product_id = $${currentParamIndex++}`;
        salesFilterParams.push(parseInt(productId));
    }

    if (!inventoryTransactionType || inventoryTransactionType === 'sale') {
        allQueryParts.push(salesFilterQuery);
        allParams = allParams.concat(salesFilterParams);
    }
    
    let finalQuery = '';
    if (allQueryParts.length > 0) {
        finalQuery = allQueryParts.join(' UNION ALL ');
        finalQuery += ` ORDER BY transaction_date DESC;`;
    } else {
        res.status(200).json({
            reportTitle: 'Inventory Movement Report',
            filtersUsed: { startDate, endDate, productId, inventoryTransactionType },
            reportData: []
        });
        return;
    }

    try {
        const result = await db.query(finalQuery, allParams); // Use allParams for the combined query
        res.status(200).json({
            reportTitle: 'Inventory Movement Report',
            filtersUsed: { startDate, endDate, productId, inventoryTransactionType },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating inventory movement report:', error);
        res.status(500).json({ error: 'Failed to generate inventory movement report.', details: error.message });
    }
});

// Raw Material Consumption Report - SCHEMA CORRECTION: "notes" column & Removed User Branch Link
router.get('/raw-material-consumption', async (req, res) => {
    const { startDate, endDate, rawMaterialId, rawMaterialTransactionType, branchId } = req.query;

    let query = `
        SELECT
            rmt.id AS transaction_id,
            rmt.transaction_date,
            rm.name AS raw_material_name,
            rm.unit AS raw_material_unit,
            rmt.quantity_change,
            rmt.transaction_type,
            rmt.notes AS reason, -- Corrected from 'reason' to 'notes'
            u.fullname AS recorded_by_staff,
            NULL AS branch_name -- Cannot determine branch from users table without branch_id
        FROM material_transactions rmt
        JOIN raw_materials rm ON rmt.raw_material_id = rm.id
        LEFT JOIN users u ON rmt.recorded_by_user_id = u.id
        WHERE rmt.transaction_type IN ('production_use', 'waste', 'adjustment', 'restock')
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'rmt.transaction_date'));

    if (rawMaterialId) {
        query += ` AND rmt.raw_material_id = $${paramIndex++}`;
        params.push(parseInt(rawMaterialId));
    }
    if (rawMaterialTransactionType) {
        query += ` AND rmt.transaction_type ILIKE $${paramIndex++}`;
        params.push(`%${rawMaterialTransactionType}%`);
    }
    // Removed branchId filter because users table doesn't have branch_id

    query += ` ORDER BY rmt.transaction_date DESC;`;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            reportTitle: 'Raw Material Consumption Report',
            filtersUsed: { startDate, endDate, rawMaterialId, rawMaterialTransactionType, branchId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating raw material consumption report:', error);
        res.status(500).json({ error: 'Failed to generate raw material consumption report.', details: error.message });
    }
});

// Sales Performance by Staff/Branch Report
router.get('/sales-performance-by-staff-branch', async (req, res) => {
    const { startDate, endDate, staffId, branchId, groupBy = 'staff' } = req.query;

    let selectClause;
    let groupByClause;

    if (groupBy === 'branch') {
        selectClause = `b.id AS group_id, b.name AS group_name`;
        groupByClause = `b.id, b.name`;
    } else { // Default to staff
        selectClause = `u.id AS group_id, u.fullname AS group_name`;
        groupByClause = `u.id, u.fullname`;
    }

    let query = `
        SELECT
            ${selectClause},
            COALESCE(SUM(st.total_amount), 0) AS total_sales_amount,
            COALESCE(SUM(st.total_profit), 0) AS total_profit,
            COUNT(st.id) AS total_transactions
        FROM sales_transactions st
        LEFT JOIN users u ON st.cashier_id = u.id
        LEFT JOIN branches b ON st.branch_id = b.id
        WHERE st.status != 'Cancelled'
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (staffId && groupBy === 'staff') {
        query += ` AND u.id = $${paramIndex++}`;
        params.push(parseInt(staffId));
    }
    if (branchId && groupBy === 'branch') {
        query += ` AND b.id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    } else if (branchId && groupBy === 'staff') { // Filter staff performance by branch
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }


    query += `
        GROUP BY ${groupByClause}
        ORDER BY total_sales_amount DESC;
    `;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            reportTitle: `Sales Performance by ${groupBy === 'branch' ? 'Branch' : 'Staff'}`,
            filtersUsed: { startDate, endDate, staffId, branchId, groupBy },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating sales performance report:', error);
        res.status(500).json({ error: 'Failed to generate sales performance report.', details: error.message });
    }
});


module.exports = router;
