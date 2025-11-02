// purple-premium-bread-api/routes/analysis.js
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

// GET /api/analysis/sales-comparison - Compare sales/profit for current vs previous period
router.get('/sales-comparison', async (req, res) => {
    const { period = 'month', branchId } = req.query; // Added branchId filter
    const { currentPeriodStart, currentPeriodEnd, previousPeriodStart, previousPeriodEnd } = getComparisonDates(period);

    let currentQueryParams = [currentPeriodStart, currentPeriodEnd];
    let previousQueryParams = [previousPeriodStart, previousPeriodEnd];
    let branchFilter = '';
    let paramIndex = 3; // Start from 3 because $1 and $2 are already used for dates

    if (branchId) {
        branchFilter = ` AND branch_id = $${paramIndex++}`;
        currentQueryParams.push(parseInt(branchId));
        previousQueryParams.push(parseInt(branchId));
    }

    try {
        const currentPeriodData = await db.query(
            `SELECT
                COALESCE(SUM(total_amount), 0) AS total_sales,
                COALESCE(SUM(total_profit), 0) AS total_profit
            FROM sales_transactions
            WHERE sale_date >= $1 AND sale_date <= $2 AND status != 'Cancelled' ${branchFilter};`,
            currentQueryParams
        );

        const previousPeriodData = await db.query(
            `SELECT
                COALESCE(SUM(total_amount), 0) AS total_sales,
                COALESCE(SUM(total_profit), 0) AS total_profit
            FROM sales_transactions
            WHERE sale_date >= $1 AND sale_date <= $2 AND status != 'Cancelled' ${branchFilter};`,
            previousQueryParams
        );

        res.status(200).json({
            period: period,
            filtersUsed: { period, branchId },
            currentPeriod: {
                start: currentPeriodStart,
                end: currentPeriodEnd,
                sales: parseFloat(currentPeriodData.rows[0].total_sales),
                profit: parseFloat(currentPeriodData.rows[0].total_profit),
            },
            previousPeriod: {
                start: previousPeriodStart,
                end: previousPeriodEnd,
                sales: parseFloat(previousPeriodData.rows[0].total_sales),
                profit: parseFloat(previousPeriodData.rows[0].total_profit),
            }
        });

    } catch (error) {
        console.error('Error fetching sales comparison data:', error);
        res.status(500).json({ error: 'Failed to fetch sales comparison data.', details: error.message });
    }
});

// GET /api/analysis/profit-margin-trend - Gross Profit Margin over time
router.get('/profit-margin-trend', async (req, res) => {
    const { period = 'month', limit = 12, branchId } = req.query; // Added branchId filter
    let groupBy;
    let orderBy;

    if (period === 'month') {
        groupBy = `TO_CHAR(sale_date, 'YYYY-MM')`;
        orderBy = `TO_CHAR(sale_date, 'YYYY-MM')`;
    } else { // default 'day'
        groupBy = `DATE(sale_date)`;
        orderBy = `DATE(sale_date)`;
    }

    let query = `
        SELECT
            ${groupBy} AS period_label,
            COALESCE(SUM(total_amount), 0) AS total_revenue,
            COALESCE(SUM(total_cogs), 0) AS total_cogs,
            CASE
                WHEN COALESCE(SUM(total_amount), 0) > 0 THEN
                    (COALESCE(SUM(total_amount), 0) - COALESCE(SUM(total_cogs), 0)) / COALESCE(SUM(total_amount), 0) * 100
                ELSE 0
            END AS gross_profit_margin
        FROM sales_transactions
        WHERE status != 'Cancelled'
    `;
    let params = [parseInt(limit)]; // Ensure limit is an integer
    let paramIndex = 2; // For limit, which is $1 in the query

    if (branchId) { // Apply branch filter
        query += ` AND branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY period_label
        ORDER BY period_label DESC
        LIMIT $1;
    `;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { period, limit, branchId },
            reportData: result.rows.reverse()
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

    // Apply date filters if provided
    ({ query: dateFilter, params: dateParams, paramIndex: dateParamIndex } = applyDateFilters(
        '', dateParams, dateParamIndex, startDate, endDate, 'st.sale_date' // Use sale_date for COGS calculation
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
            // Apply branch filter to sales transactions
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
        // NOTE: The 'inventory' table does not have a branch_id.
        // If inventory needs to be branch-specific, the schema would need 'inventory.branch_id'.
        // For now, assuming inventory is tracked centrally or this report reflects global inventory.

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
                averageInventoryValue: currentInventoryValue, // Using current as proxy for average
                inventoryTurnoverRate: turnoverRate,
                explanation: "Inventory turnover rate (COGS / Average Inventory Value). Note: Average inventory is approximated using current stock value for simplicity."
            }
        });

    } catch (error) {
        console.error('Error fetching inventory turnover data:', error);
        res.status(500).json({ error: 'Failed to fetch inventory turnover data.', details: error.message });
    }
});

// NEW ANALYTICS: GET /api/analysis/sales-trend-by-category-product
router.get('/sales-trend-by-category-product', async (req, res) => {
    const { startDate, endDate, category, productId, period = 'month', branchId } = req.query;
    let groupBy;
    let orderBy;

    if (period === 'month') {
        groupBy = `TO_CHAR(st.sale_date, 'YYYY-MM')`;
        orderBy = `TO_CHAR(st.sale_date, 'YYYY-MM')`;
    } else { // default 'day'
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
        ORDER BY period_label ASC;
    `;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, category, productId, period, branchId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching sales trend by category/product:', error);
        res.status(500).json({ error: 'Failed to fetch sales trend by category/product.', details: error.message });
    }
});

// NEW ANALYTICS: GET /api/analysis/top-customers-by-sales
router.get('/top-customers-by-sales', async (req, res) => {
    const { startDate, endDate, limit = 10, branchId } = req.query;
    let query = `
        SELECT
            c.id AS customer_id,
            c.fullname AS customer_name,
            COALESCE(SUM(st.total_amount), 0) AS total_sales_amount,
            COUNT(st.id) AS total_transactions
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
        LIMIT $${paramIndex++};
    `;
    params.push(parseInt(limit));

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

// NEW ANALYTICS: GET /api/analysis/production-waste-over-time - Removed User Branch Link
router.get('/production-waste-over-time', async (req, res) => {
    const { startDate, endDate, period = 'month', branchId } = req.query;
    let groupBy;
    let orderBy;

    if (period === 'month') {
        groupBy = `TO_CHAR(pl.production_date, 'YYYY-MM')`;
        orderBy = `TO_CHAR(pl.production_date, 'YYYY-MM')`;
    } else { // default 'day'
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

    // Removed branchId filter because users table doesn't have branch_id

    query += `
        GROUP BY period_label
        ORDER BY period_label ASC;
    `;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, period, branchId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching production waste over time:', error);
        res.status(500).json({ error: 'Failed to fetch production waste over time.', details: error.message });
    }
});

// NEW ANALYTICS: GET /api/analysis/raw-material-stock-value-trend - FIXED COLUMN REFERENCE & Removed User Branch Link
router.get('/raw-material-stock-value-trend', async (req, res) => {
    const { startDate, endDate, rawMaterialId, period = 'month', branchId } = req.query;

    let groupBy;

    if (period === 'month') {
        groupBy = `TO_CHAR(dmv.date_key, 'YYYY-MM')`;
    } else { // default 'day'
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
    // Removed branchId filter because users table doesn't have branch_id
    query += `
            GROUP BY period_label
        )
        SELECT
            period_label,
            period_stock_value_change,
            SUM(period_stock_value_change) OVER (ORDER BY period_label ASC) AS cumulative_stock_value
        FROM AggregatedValue
        ORDER BY period_label ASC;
    `;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            filtersUsed: { startDate, endDate, rawMaterialId, period, branchId },
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

// NEW ANALYTICS: GET /api/analysis/customer-lifetime-value
router.get('/customer-lifetime-value', async (req, res) => {
    const { startDate, endDate, customerId, limit = 10, branchId } = req.query;

    let query = `
        SELECT
            c.id AS customer_id,
            c.fullname AS customer_name,
            COALESCE(SUM(st.total_profit), 0) AS total_profit_generated,
            COUNT(st.id) AS total_transactions,
            EXTRACT(EPOCH FROM (MAX(st.sale_date) - MIN(st.sale_date))) / (3600 * 24 * 30.5) AS customer_lifespan_months,
            COALESCE(SUM(st.total_amount), 0) AS total_revenue_generated
        FROM customers c
        JOIN sales_transactions st ON c.id = st.customer_id
        WHERE st.status != 'Cancelled'
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (customerId) {
        query += ` AND c.id = $${paramIndex++}`;
        params.push(parseInt(customerId));
    }
    if (branchId) {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += `
        GROUP BY c.id, c.fullname
        HAVING COUNT(st.id) > 0 -- Only include customers with sales
        ORDER BY total_profit_generated DESC
        LIMIT $${paramIndex++};
    `;
    params.push(parseInt(limit));

    try {
        const result = await db.query(query, params);
        
        const cltvData = result.rows.map(row => {
            const totalProfitGenerated = parseFloat(row.total_profit_generated);
            const totalTransactions = parseInt(row.total_transactions);
            const customerLifespanMonths = parseFloat(row.customer_lifespan_months);

            const avgProfitPerTransaction = totalTransactions > 0 ? totalProfitGenerated / totalTransactions : 0;
            const avgTransactionsPerMonth = customerLifespanMonths > 0 ? totalTransactions / customerLifespanMonths : 0;
            
            const estimatedFutureLifespanMonths = 24;
            const approximatedCLTV = avgProfitPerTransaction * avgTransactionsPerMonth * estimatedFutureLifespanMonths;

            return {
                customer_id: row.customer_id,
                customer_name: row.customer_name,
                total_profit_generated: totalProfitGenerated,
                total_transactions: totalTransactions,
                customer_lifespan_months: customerLifespanMonths.toFixed(1),
                approximated_cltv: Math.max(0, approximatedCLTV),
                total_revenue_generated: parseFloat(row.total_revenue_generated)
            };
        });

        res.status(200).json({
            filtersUsed: { startDate, endDate, customerId, limit, branchId },
            reportData: cltvData
        });

    } catch (error) {
        console.error('Error fetching customer lifetime value:', error);
        res.status(500).json({ error: 'Failed to fetch customer lifetime value.', details: error.message });
    }
});

// ============================================================================
// NEW COMPREHENSIVE ANALYSIS ENDPOINTS
// ============================================================================

// GET /api/analysis/free-stock - Free stock distribution analysis
router.get('/free-stock', async (req, res) => {
    const { startDate, endDate, productId, branchId } = req.query;
    
    try {
        let query = `
            SELECT 
                p.id as product_id,
                p.name as product_name,
                SUM(fsl.quantity) as total_quantity,
                COUNT(fsl.id) as total_occurrences,
                (
                    SELECT reason 
                    FROM free_stock_log 
                    WHERE product_id = p.id 
                    GROUP BY reason 
                    ORDER BY COUNT(*) DESC 
                    LIMIT 1
                ) as most_common_reason
            FROM free_stock_log fsl
            JOIN products p ON fsl.product_id = p.id
            WHERE 1=1
        `;
        let params = [];
        let paramIndex = 1;

        // Apply date filters
        if (startDate) {
            query += ` AND fsl.recorded_at >= $${paramIndex++}`;
            params.push(startDate);
        }
        if (endDate) {
            const endOfDay = new Date(endDate);
            endOfDay.setDate(endOfDay.getDate() + 1);
            query += ` AND fsl.recorded_at < $${paramIndex++}`;
            params.push(endOfDay.toISOString());
        }
        if (productId) {
            query += ` AND fsl.product_id = $${paramIndex++}`;
            params.push(parseInt(productId));
        }

        query += ` GROUP BY p.id, p.name ORDER BY total_quantity DESC`;

        const result = await db.query(query, params);
        
        res.status(200).json({
            filtersUsed: { startDate, endDate, productId, branchId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching free stock analysis:', error);
        res.status(500).json({ error: 'Failed to fetch free stock analysis.', details: error.message });
    }
});

// GET /api/analysis/exchange-requests - Exchange requests analysis
router.get('/exchange-requests', async (req, res) => {
    const { startDate, endDate, status, branchId } = req.query;
    
    try {
        let query = `
            SELECT 
                er.*,
                c.fullname as customer_name,
                u.fullname as requested_by_name,
                jsonb_array_length(er.items_requested_jsonb) as items_count,
                EXTRACT(DAYS FROM (COALESCE(er.approval_date, CURRENT_TIMESTAMP) - er.created_at)) as resolution_days
            FROM exchange_requests er
            JOIN customers c ON er.customer_id = c.id
            JOIN users u ON er.requested_by_user_id = u.id
            WHERE 1=1
        `;
        let params = [];
        let paramIndex = 1;

        if (startDate) {
            query += ` AND er.created_at >= $${paramIndex++}`;
            params.push(startDate);
        }
        if (endDate) {
            const endOfDay = new Date(endDate);
            endOfDay.setDate(endOfDay.getDate() + 1);
            query += ` AND er.created_at < $${paramIndex++}`;
            params.push(endOfDay.toISOString());
        }
        if (status) {
            query += ` AND er.status = $${paramIndex++}`;
            params.push(status);
        }

        query += ` ORDER BY er.created_at DESC`;

        const result = await db.query(query, params);
        
        res.status(200).json({
            filtersUsed: { startDate, endDate, status, branchId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching exchange requests analysis:', error);
        res.status(500).json({ error: 'Failed to fetch exchange requests analysis.', details: error.message });
    }
});

// GET /api/analysis/discounts - Discount analysis
router.get('/discounts', async (req, res) => {
    const { startDate, endDate, productId, branchId, period = 'month' } = req.query;
    
    try {
        let groupBy, dateFormat;
        if (period === 'day') {
            groupBy = `DATE(st.sale_date)`;
            dateFormat = `TO_CHAR(st.sale_date, 'YYYY-MM-DD')`;
        } else if (period === 'week') {
            groupBy = `DATE_TRUNC('week', st.sale_date)`;
            dateFormat = `TO_CHAR(DATE_TRUNC('week', st.sale_date), 'YYYY-MM-DD')`;
        } else {
            groupBy = `DATE_TRUNC('month', st.sale_date)`;
            dateFormat = `TO_CHAR(DATE_TRUNC('month', st.sale_date), 'YYYY-MM')`;
        }

        let query = `
            SELECT 
                ${dateFormat} as period_label,
                SUM(st.discount_amount) as total_discount_amount,
                COUNT(st.id) as transaction_count,
                AVG(st.discount_amount) as average_discount
            FROM sales_transactions st
            WHERE st.status != 'Cancelled' AND st.discount_amount > 0
        `;
        let params = [];
        let paramIndex = 1;

        if (startDate) {
            query += ` AND st.sale_date >= $${paramIndex++}`;
            params.push(startDate);
        }
        if (endDate) {
            const endOfDay = new Date(endDate);
            endOfDay.setDate(endOfDay.getDate() + 1);
            query += ` AND st.sale_date < $${paramIndex++}`;
            params.push(endOfDay.toISOString());
        }
        if (branchId) {
            query += ` AND st.branch_id = $${paramIndex++}`;
            params.push(parseInt(branchId));
        }

        query += ` GROUP BY ${groupBy} ORDER BY period_label ASC`;

        const result = await db.query(query, params);
        
        res.status(200).json({
            filtersUsed: { startDate, endDate, productId, branchId, period },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching discount analysis:', error);
        res.status(500).json({ error: 'Failed to fetch discount analysis.', details: error.message });
    }
});

// GET /api/analysis/operating-expenses - Operating expenses analysis
router.get('/operating-expenses', async (req, res) => {
    const { startDate, endDate, category, expenseType, period = 'month' } = req.query;
    
    try {
        let query = `
            SELECT 
                category,
                expense_type,
                SUM(amount) as total_amount,
                COUNT(*) as transaction_count,
                AVG(amount) as average_amount,
                (SUM(amount) / 
                    GREATEST(
                        EXTRACT(EPOCH FROM (MAX(expense_date) - MIN(expense_date))) / 2592000,
                        1
                    )
                ) as average_monthly
            FROM operating_expenses
            WHERE status = 'active'
        `;
        let params = [];
        let paramIndex = 1;

        if (startDate) {
            query += ` AND expense_date >= $${paramIndex++}`;
            params.push(startDate);
        }
        if (endDate) {
            query += ` AND expense_date <= $${paramIndex++}`;
            params.push(endDate);
        }
        if (category) {
            query += ` AND category = $${paramIndex++}`;
            params.push(category);
        }
        if (expenseType) {
            query += ` AND expense_type = $${paramIndex++}`;
            params.push(expenseType);
        }

        query += ` GROUP BY category, expense_type ORDER BY total_amount DESC`;

        const result = await db.query(query, params);
        
        res.status(200).json({
            filtersUsed: { startDate, endDate, category, expenseType, period },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching operating expenses analysis:', error);
        res.status(500).json({ error: 'Failed to fetch operating expenses analysis.', details: error.message });
    }
});

// GET /api/analysis/salaries - Salary analysis
router.get('/salaries', async (req, res) => {
    const { startDate, endDate, userId, status, period = 'month' } = req.query;
    
    try {
        let query = `
            SELECT 
                sp.*,
                u.fullname as staff_name,
                u.role as staff_role,
                COALESCE(sc_allow.allowances, 0) as allowances,
                COALESCE(sc_ded.deductions, 0) as deductions
            FROM salary_payments sp
            JOIN users u ON sp.user_id = u.id
            LEFT JOIN (
                SELECT salary_payment_id, SUM(amount) as allowances
                FROM salary_components 
                WHERE component_type = 'allowance'
                GROUP BY salary_payment_id
            ) sc_allow ON sp.id = sc_allow.salary_payment_id
            LEFT JOIN (
                SELECT salary_payment_id, SUM(amount) as deductions
                FROM salary_components 
                WHERE component_type = 'deduction'
                GROUP BY salary_payment_id
            ) sc_ded ON sp.id = sc_ded.salary_payment_id
            WHERE 1=1
        `;
        let params = [];
        let paramIndex = 1;

        if (startDate) {
            query += ` AND sp.payment_date >= $${paramIndex++}`;
            params.push(startDate);
        }
        if (endDate) {
            query += ` AND sp.payment_date <= $${paramIndex++}`;
            params.push(endDate);
        }
        if (userId) {
            query += ` AND sp.user_id = $${paramIndex++}`;
            params.push(parseInt(userId));
        }
        if (status) {
            query += ` AND sp.status = $${paramIndex++}`;
            params.push(status);
        }

        query += ` ORDER BY sp.payment_date DESC`;

        const result = await db.query(query, params);
        
        res.status(200).json({
            filtersUsed: { startDate, endDate, userId, status, period },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching salary analysis:', error);
        res.status(500).json({ error: 'Failed to fetch salary analysis.', details: error.message });
    }
});

// GET /api/analysis/stock-issues - Stock issue analysis
router.get('/stock-issues', async (req, res) => {
    const { startDate, endDate, issueType, productId, branchId, period = 'month' } = req.query;
    
    try {
        let query = `
            SELECT 
                sil.issue_type,
                SUM(sil.quantity_changed) as total_quantity,
                COUNT(sil.id) as transaction_count,
                (
                    SELECT p.name 
                    FROM stock_issue_log sil2 
                    JOIN products p ON sil2.product_id = p.id 
                    WHERE sil2.issue_type = sil.issue_type 
                    GROUP BY p.name 
                    ORDER BY SUM(sil2.quantity_changed) DESC 
                    LIMIT 1
                ) as most_affected_product
            FROM stock_issue_log sil
            JOIN products p ON sil.product_id = p.id
            WHERE 1=1
        `;
        let params = [];
        let paramIndex = 1;

        if (startDate) {
            query += ` AND sil.created_at >= $${paramIndex++}`;
            params.push(startDate);
        }
        if (endDate) {
            const endOfDay = new Date(endDate);
            endOfDay.setDate(endOfDay.getDate() + 1);
            query += ` AND sil.created_at < $${paramIndex++}`;
            params.push(endOfDay.toISOString());
        }
        if (issueType) {
            query += ` AND sil.issue_type = $${paramIndex++}`;
            params.push(issueType);
        }
        if (productId) {
            query += ` AND sil.product_id = $${paramIndex++}`;
            params.push(parseInt(productId));
        }

        query += ` GROUP BY sil.issue_type ORDER BY total_quantity DESC`;

        const result = await db.query(query, params);
        
        res.status(200).json({
            filtersUsed: { startDate, endDate, issueType, productId, branchId, period },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching stock issue analysis:', error);
        res.status(500).json({ error: 'Failed to fetch stock issue analysis.', details: error.message });
    }
});

// GET /api/analysis/waste-stock - Waste stock analysis
router.get('/waste-stock', async (req, res) => {
    const { startDate, endDate, productId, reason, branchId, period = 'month' } = req.query;
    
    try {
        let query = `
            SELECT 
                ws.product_id,
                p.name as product_name,
                SUM(ws.quantity) as total_quantity,
                (
                    SELECT reason 
                    FROM waste_stock 
                    WHERE product_id = ws.product_id 
                    GROUP BY reason 
                    ORDER BY SUM(quantity) DESC 
                    LIMIT 1
                ) as primary_reason,
                COUNT(ws.id) as occurrence_count,
                SUM(ws.quantity * p.price) as cost_impact
            FROM waste_stock ws
            JOIN products p ON ws.product_id = p.id
            WHERE 1=1
        `;
        let params = [];
        let paramIndex = 1;

        if (startDate) {
            query += ` AND ws.date_recorded >= $${paramIndex++}`;
            params.push(startDate);
        }
        if (endDate) {
            const endOfDay = new Date(endDate);
            endOfDay.setDate(endOfDay.getDate() + 1);
            query += ` AND ws.date_recorded < $${paramIndex++}`;
            params.push(endOfDay.toISOString());
        }
        if (productId) {
            query += ` AND ws.product_id = $${paramIndex++}`;
            params.push(parseInt(productId));
        }
        if (reason) {
            query += ` AND ws.reason = $${paramIndex++}`;
            params.push(reason);
        }

        query += ` GROUP BY ws.product_id, p.name ORDER BY total_quantity DESC`;

        const result = await db.query(query, params);
        
        res.status(200).json({
            filtersUsed: { startDate, endDate, productId, reason, branchId, period },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching waste stock analysis:', error);
        res.status(500).json({ error: 'Failed to fetch waste stock analysis.', details: error.message });
    }
});

// GET /api/analysis/sales-performance-by-branch - New comprehensive branch performance
router.get('/sales-performance-by-branch', async (req, res) => {
    const { startDate, endDate, period = 'month' } = req.query;
    
    try {
        let groupBy, dateFormat;
        if (period === 'day') {
            groupBy = `DATE(st.sale_date), b.id`;
            dateFormat = `TO_CHAR(st.sale_date, 'YYYY-MM-DD')`;
        } else if (period === 'week') {
            groupBy = `DATE_TRUNC('week', st.sale_date), b.id`;
            dateFormat = `TO_CHAR(DATE_TRUNC('week', st.sale_date), 'YYYY-MM-DD')`;
        } else {
            groupBy = `DATE_TRUNC('month', st.sale_date), b.id`;
            dateFormat = `TO_CHAR(DATE_TRUNC('month', st.sale_date), 'YYYY-MM')`;
        }

        let query = `
            SELECT 
                b.id as branch_id,
                b.name as branch_name,
                ${dateFormat} as period_label,
                COUNT(st.id) as total_transactions,
                SUM(st.total_amount) as total_sales,
                SUM(st.total_profit) as total_profit,
                AVG(st.total_amount) as average_transaction_value,
                COUNT(DISTINCT st.customer_id) as unique_customers
            FROM sales_transactions st
            JOIN branches b ON st.branch_id = b.id
            WHERE st.status != 'Cancelled'
        `;
        let params = [];
        let paramIndex = 1;

        if (startDate) {
            query += ` AND st.sale_date >= $${paramIndex++}`;
            params.push(startDate);
        }
        if (endDate) {
            const endOfDay = new Date(endDate);
            endOfDay.setDate(endOfDay.getDate() + 1);
            query += ` AND st.sale_date < $${paramIndex++}`;
            params.push(endOfDay.toISOString());
        }

        query += ` GROUP BY ${groupBy}, b.name ORDER BY period_label DESC, total_sales DESC`;

        const result = await db.query(query, params);
        
        res.status(200).json({
            filtersUsed: { startDate, endDate, period },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching sales performance by branch:', error);
        res.status(500).json({ error: 'Failed to fetch sales performance by branch.', details: error.message });
    }
});

// GET /api/analysis/product-performance - Comprehensive product performance
router.get('/product-performance', async (req, res) => {
    const { startDate, endDate, category, branchId } = req.query;
    
    try {
        let query = `
            SELECT 
                p.id as product_id,
                p.name as product_name,
                p.category as product_category,
                p.price as current_price,
                COALESCE(SUM(si.quantity), 0) as total_quantity_sold,
                COALESCE(SUM(si.quantity * si.price_at_sale), 0) as total_revenue,
                COALESCE(SUM(si.quantity * si.cost_at_sale), 0) as total_cogs,
                COALESCE(SUM(si.quantity * si.price_at_sale - si.quantity * si.cost_at_sale), 0) as total_profit,
                CASE 
                    WHEN COALESCE(SUM(si.quantity * si.price_at_sale), 0) > 0 THEN
                        (COALESCE(SUM(si.quantity * si.price_at_sale - si.quantity * si.cost_at_sale), 0) / COALESCE(SUM(si.quantity * si.price_at_sale), 0)) * 100
                    ELSE 0
                END as profit_margin_percent,
                COUNT(DISTINCT st.id) as transaction_count,
                AVG(si.quantity) as avg_quantity_per_transaction
            FROM products p
            LEFT JOIN sales_items si ON p.id = si.product_id
            LEFT JOIN sales_transactions st ON si.sale_id = st.id AND st.status != 'Cancelled'
            WHERE 1=1
        `;
        let params = [];
        let paramIndex = 1;

        if (startDate) {
            query += ` AND st.sale_date >= $${paramIndex++}`;
            params.push(startDate);
        }
        if (endDate) {
            const endOfDay = new Date(endDate);
            endOfDay.setDate(endOfDay.getDate() + 1);
            query += ` AND st.sale_date < $${paramIndex++}`;
            params.push(endOfDay.toISOString());
        }
        if (category) {
            query += ` AND p.category ILIKE $${paramIndex++}`;
            params.push(`%${category}%`);
        }
        if (branchId) {
            query += ` AND st.branch_id = $${paramIndex++}`;
            params.push(parseInt(branchId));
        }

        query += ` GROUP BY p.id, p.name, p.category, p.price 
                  ORDER BY total_revenue DESC`;

        const result = await db.query(query, params);
        
        res.status(200).json({
            filtersUsed: { startDate, endDate, category, branchId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error fetching product performance analysis:', error);
        res.status(500).json({ error: 'Failed to fetch product performance analysis.', details: error.message });
    }
});

module.exports = router;