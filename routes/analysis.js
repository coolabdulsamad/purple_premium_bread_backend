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
        currentPeriodEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
        previousPeriodStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        previousPeriodEnd = new Date(today.getFullYear(), today.getMonth(), 0);
    } else { // default 'week'
        const dayOfWeek = today.getDay();
        currentPeriodStart = new Date(today);
        currentPeriodStart.setDate(today.getDate() - dayOfWeek);
        currentPeriodEnd = new Date(today);
        currentPeriodEnd.setDate(currentPeriodStart.getDate() + 6);

        previousPeriodStart = new Date(currentPeriodStart);
        previousPeriodStart.setDate(currentPeriodStart.getDate() - 7);
        previousPeriodEnd = new Date(currentPeriodEnd);
        previousPeriodEnd.setDate(currentPeriodEnd.getDate() - 7);
    }

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
        endOfDay.setDate(endOfDay.getDate() + 1);
        query += ` AND ${dateColumn} < $${paramIndex++}`;
        params.push(endOfDay.toISOString());
    }
    return { query, params, paramIndex };
};

// ============================================================================
// EXISTING ANALYSIS ENDPOINTS (UPDATED)
// ============================================================================

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
        const currentPeriodData = await db.query(
            `SELECT
                COALESCE(SUM(total_amount), 0) AS total_sales,
                COALESCE(SUM(total_profit), 0) AS total_profit,
                COALESCE(SUM(total_cogs), 0) AS total_cogs,
                COUNT(*) AS transaction_count
            FROM sales_transactions
            WHERE sale_date >= $1 AND sale_date <= $2 AND status != 'Cancelled' ${branchFilter};`,
            currentQueryParams
        );

        const previousPeriodData = await db.query(
            `SELECT
                COALESCE(SUM(total_amount), 0) AS total_sales,
                COALESCE(SUM(total_profit), 0) AS total_profit,
                COALESCE(SUM(total_cogs), 0) AS total_cogs,
                COUNT(*) AS transaction_count
            FROM sales_transactions
            WHERE sale_date >= $1 AND sale_date <= $2 AND status != 'Cancelled' ${branchFilter};`,
            previousQueryParams
        );

        const currentData = currentPeriodData.rows[0];
        const previousData = previousPeriodData.rows[0];

        const salesChange = previousData.total_sales > 0 ? 
            ((currentData.total_sales - previousData.total_sales) / previousData.total_sales * 100) : 0;
        const profitChange = previousData.total_profit > 0 ? 
            ((currentData.total_profit - previousData.total_profit) / previousData.total_profit * 100) : 0;

        res.status(200).json({
            period: period,
            filtersUsed: { period, branchId },
            currentPeriod: {
                start: currentPeriodStart,
                end: currentPeriodEnd,
                sales: parseFloat(currentData.total_sales),
                profit: parseFloat(currentData.total_profit),
                cogs: parseFloat(currentData.total_cogs),
                transactions: parseInt(currentData.transaction_count),
                avgTransaction: currentData.transaction_count > 0 ? 
                    parseFloat(currentData.total_sales) / parseInt(currentData.transaction_count) : 0
            },
            previousPeriod: {
                start: previousPeriodStart,
                end: previousPeriodEnd,
                sales: parseFloat(previousData.total_sales),
                profit: parseFloat(previousData.total_profit),
                cogs: parseFloat(previousData.total_cogs),
                transactions: parseInt(previousData.transaction_count),
                avgTransaction: previousData.transaction_count > 0 ? 
                    parseFloat(previousData.total_sales) / parseInt(previousData.transaction_count) : 0
            },
            changes: {
                salesChange: salesChange,
                profitChange: profitChange,
                salesDifference: parseFloat(currentData.total_sales) - parseFloat(previousData.total_sales),
                profitDifference: parseFloat(currentData.total_profit) - parseFloat(previousData.total_profit)
            }
        });

    } catch (error) {
        console.error('Error fetching sales comparison data:', error);
        res.status(500).json({ error: 'Failed to fetch sales comparison data.', details: error.message });
    }
});

// GET /api/analysis/profit-margin-trend - Gross Profit Margin over time
router.get('/profit-margin-trend', async (req, res) => {
    const { period = 'month', limit = 12, branchId } = req.query;
    let groupBy;
    let orderBy;

    if (period === 'month') {
        groupBy = `TO_CHAR(sale_date, 'YYYY-MM')`;
        orderBy = `TO_CHAR(sale_date, 'YYYY-MM')`;
    } else if (period === 'week') {
        groupBy = `TO_CHAR(DATE_TRUNC('week', sale_date), 'YYYY-MM-DD')`;
        orderBy = `TO_CHAR(DATE_TRUNC('week', sale_date), 'YYYY-MM-DD')`;
    } else { // default 'day'
        groupBy = `DATE(sale_date)`;
        orderBy = `DATE(sale_date)`;
    }

    let query = `
        SELECT
            ${groupBy} AS period_label,
            COALESCE(SUM(total_amount), 0) AS total_revenue,
            COALESCE(SUM(total_cogs), 0) AS total_cogs,
            COALESCE(SUM(total_profit), 0) AS total_profit,
            COUNT(*) AS transaction_count,
            CASE
                WHEN COALESCE(SUM(total_amount), 0) > 0 THEN
                    (COALESCE(SUM(total_amount), 0) - COALESCE(SUM(total_cogs), 0)) / COALESCE(SUM(total_amount), 0) * 100
                ELSE 0
            END AS gross_profit_margin
        FROM sales_transactions
        WHERE status != 'Cancelled'
    `;
    let params = [parseInt(limit)];
    let paramIndex = 2;

    if (branchId) {
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

// ============================================================================
// NEW COMPREHENSIVE ANALYSIS ENDPOINTS
// ============================================================================

// GET /api/analysis/business-overview - Comprehensive business overview
router.get('/business-overview', async (req, res) => {
    const { startDate, endDate, branchId } = req.query;
    
    try {
        // Sales metrics
        let salesQuery = `
            SELECT
                COUNT(*) as total_transactions,
                COALESCE(SUM(total_amount), 0) as total_revenue,
                COALESCE(SUM(total_profit), 0) as total_profit,
                COALESCE(SUM(total_cogs), 0) as total_cogs,
                AVG(total_amount) as avg_transaction_value,
                COUNT(DISTINCT customer_id) as unique_customers
            FROM sales_transactions
            WHERE status != 'Cancelled'
        `;
        let salesParams = [];
        let salesParamIndex = 1;

        ({ query: salesQuery, params: salesParams, paramIndex: salesParamIndex } = applyDateFilters(
            salesQuery, salesParams, salesParamIndex, startDate, endDate, 'sale_date'
        ));

        if (branchId) {
            salesQuery += ` AND branch_id = $${salesParamIndex++}`;
            salesParams.push(parseInt(branchId));
        }

        const salesResult = await db.query(salesQuery, salesParams);
        const salesData = salesResult.rows[0];

        // Inventory metrics
        const inventoryResult = await db.query(`
            SELECT
                COUNT(*) as total_products,
                COALESCE(SUM(i.quantity * p.price), 0) as total_inventory_value,
                COALESCE(SUM(CASE WHEN i.quantity <= p.min_stock_level THEN 1 ELSE 0 END), 0) as low_stock_items
            FROM inventory i
            JOIN products p ON i.product_id = p.id
            WHERE p.is_active = true
        `);

        // Customer metrics
        let customerQuery = `
            SELECT
                COUNT(*) as total_customers,
                COUNT(CASE WHEN balance > 0 THEN 1 END) as customers_with_balance,
                COALESCE(SUM(balance), 0) as total_outstanding_balance
            FROM customers
            WHERE is_active = true
        `;
        const customerResult = await db.query(customerQuery);
        const customerData = customerResult.rows[0];

        // Expense metrics
        let expenseQuery = `
            SELECT
                COALESCE(SUM(amount), 0) as total_expenses,
                COUNT(*) as expense_transactions
            FROM operating_expenses
            WHERE status = 'active'
        `;
        let expenseParams = [];
        let expenseParamIndex = 1;

        ({ query: expenseQuery, params: expenseParams, paramIndex: expenseParamIndex } = applyDateFilters(
            expenseQuery, expenseParams, expenseParamIndex, startDate, endDate, 'expense_date'
        ));

        const expenseResult = await db.query(expenseQuery, expenseParams);
        const expenseData = expenseResult.rows[0];

        // Production metrics
        let productionQuery = `
            SELECT
                COALESCE(SUM(quantity_produced), 0) as total_produced,
                COALESCE(SUM(waste_quantity), 0) as total_waste,
                CASE
                    WHEN COALESCE(SUM(quantity_produced), 0) > 0 THEN
                        COALESCE(SUM(waste_quantity), 0) / COALESCE(SUM(quantity_produced), 0) * 100
                    ELSE 0
                END as waste_percentage
            FROM production_logs
            WHERE 1=1
        `;
        let productionParams = [];
        let productionParamIndex = 1;

        ({ query: productionQuery, params: productionParams, paramIndex: productionParamIndex } = applyDateFilters(
            productionQuery, productionParams, productionParamIndex, startDate, endDate, 'production_date'
        ));

        const productionResult = await db.query(productionQuery, productionParams);
        const productionData = productionResult.rows[0];

        res.status(200).json({
            filtersUsed: { startDate, endDate, branchId },
            overview: {
                sales: {
                    totalRevenue: parseFloat(salesData.total_revenue),
                    totalProfit: parseFloat(salesData.total_profit),
                    totalTransactions: parseInt(salesData.total_transactions),
                    avgTransactionValue: parseFloat(salesData.avg_transaction_value),
                    uniqueCustomers: parseInt(salesData.unique_customers),
                    cogs: parseFloat(salesData.total_cogs)
                },
                inventory: {
                    totalProducts: parseInt(inventoryResult.rows[0].total_products),
                    totalValue: parseFloat(inventoryResult.rows[0].total_inventory_value),
                    lowStockItems: parseInt(inventoryResult.rows[0].low_stock_items)
                },
                customers: {
                    totalCustomers: parseInt(customerData.total_customers),
                    customersWithBalance: parseInt(customerData.customers_with_balance),
                    totalOutstanding: parseFloat(customerData.total_outstanding_balance)
                },
                expenses: {
                    totalExpenses: parseFloat(expenseData.total_expenses),
                    expenseTransactions: parseInt(expenseData.expense_transactions)
                },
                production: {
                    totalProduced: parseInt(productionData.total_produced),
                    totalWaste: parseInt(productionData.total_waste),
                    wastePercentage: parseFloat(productionData.waste_percentage)
                },
                financialHealth: {
                    netProfit: parseFloat(salesData.total_profit) - parseFloat(expenseData.total_expenses),
                    profitMargin: salesData.total_revenue > 0 ? 
                        (parseFloat(salesData.total_profit) / parseFloat(salesData.total_revenue)) * 100 : 0
                }
            }
        });

    } catch (error) {
        console.error('Error fetching business overview:', error);
        res.status(500).json({ error: 'Failed to fetch business overview.', details: error.message });
    }
});

// GET /api/analysis/cash-flow - Cash flow analysis
router.get('/cash-flow', async (req, res) => {
    const { startDate, endDate, period = 'month', branchId } = req.query;
    
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

        // Cash inflows from sales
        let inflowQuery = `
            SELECT
                ${dateFormat} as period_label,
                COALESCE(SUM(total_amount), 0) as cash_inflow,
                COUNT(*) as transaction_count
            FROM sales_transactions st
            WHERE st.status != 'Cancelled'
        `;
        let inflowParams = [];
        let inflowParamIndex = 1;

        ({ query: inflowQuery, params: inflowParams, paramIndex: inflowParamIndex } = applyDateFilters(
            inflowQuery, inflowParams, inflowParamIndex, startDate, endDate, 'st.sale_date'
        ));

        if (branchId) {
            inflowQuery += ` AND st.branch_id = $${inflowParamIndex++}`;
            inflowParams.push(parseInt(branchId));
        }

        inflowQuery += ` GROUP BY ${groupBy} ORDER BY period_label ASC`;

        // Cash outflows from expenses
        let outflowQuery = `
            SELECT
                ${dateFormat} as period_label,
                COALESCE(SUM(amount), 0) as cash_outflow,
                COUNT(*) as expense_count
            FROM operating_expenses oe
            WHERE oe.status = 'active'
        `;
        let outflowParams = [];
        let outflowParamIndex = 1;

        ({ query: outflowQuery, params: outflowParams, paramIndex: outflowParamIndex } = applyDateFilters(
            outflowQuery, outflowParams, outflowParamIndex, startDate, endDate, 'oe.expense_date'
        ));

        outflowQuery += ` GROUP BY ${groupBy} ORDER BY period_label ASC`;

        const [inflowResult, outflowResult] = await Promise.all([
            db.query(inflowQuery, inflowParams),
            db.query(outflowQuery, outflowParams)
        ]);

        // Combine results
        const cashFlowData = [];
        const allPeriods = new Set([
            ...inflowResult.rows.map(r => r.period_label),
            ...outflowResult.rows.map(r => r.period_label)
        ]);

        for (const period of Array.from(allPeriods).sort()) {
            const inflow = inflowResult.rows.find(r => r.period_label === period) || { cash_inflow: 0, transaction_count: 0 };
            const outflow = outflowResult.rows.find(r => r.period_label === period) || { cash_outflow: 0, expense_count: 0 };
            
            const netCashFlow = parseFloat(inflow.cash_inflow) - parseFloat(outflow.cash_outflow);
            
            cashFlowData.push({
                period_label: period,
                cash_inflow: parseFloat(inflow.cash_inflow),
                cash_outflow: parseFloat(outflow.cash_outflow),
                net_cash_flow: netCashFlow,
                transaction_count: parseInt(inflow.transaction_count),
                expense_count: parseInt(outflow.expense_count)
            });
        }

        res.status(200).json({
            filtersUsed: { startDate, endDate, period, branchId },
            reportData: cashFlowData
        });

    } catch (error) {
        console.error('Error fetching cash flow analysis:', error);
        res.status(500).json({ error: 'Failed to fetch cash flow analysis.', details: error.message });
    }
});

// GET /api/analysis/customer-behavior - Customer behavior analysis
router.get('/customer-behavior', async (req, res) => {
    const { startDate, endDate, branchId } = req.query;
    
    try {
        // Customer segmentation by purchase frequency
        const segmentationQuery = `
            SELECT
                CASE
                    WHEN transaction_count >= 10 THEN 'VIP'
                    WHEN transaction_count >= 5 THEN 'Regular'
                    WHEN transaction_count >= 2 THEN 'Occasional'
                    ELSE 'One-time'
                END as segment,
                COUNT(*) as customer_count,
                AVG(total_spent) as avg_spent,
                SUM(total_spent) as segment_revenue
            FROM (
                SELECT
                    c.id,
                    c.fullname,
                    COUNT(st.id) as transaction_count,
                    COALESCE(SUM(st.total_amount), 0) as total_spent
                FROM customers c
                LEFT JOIN sales_transactions st ON c.id = st.customer_id 
                    AND st.status != 'Cancelled'
                    ${startDate ? `AND st.sale_date >= '${startDate}'` : ''}
                    ${endDate ? `AND st.sale_date <= '${endDate}'` : ''}
                    ${branchId ? `AND st.branch_id = ${parseInt(branchId)}` : ''}
                GROUP BY c.id, c.fullname
            ) customer_stats
            GROUP BY segment
            ORDER BY segment_revenue DESC
        `;

        // Repeat customer analysis
        const repeatCustomerQuery = `
            SELECT
                EXTRACT(MONTH FROM sale_date) as month,
                EXTRACT(YEAR FROM sale_date) as year,
                COUNT(DISTINCT customer_id) as unique_customers,
                COUNT(DISTINCT CASE WHEN transaction_count > 1 THEN customer_id END) as repeat_customers,
                CASE 
                    WHEN COUNT(DISTINCT customer_id) > 0 THEN
                        COUNT(DISTINCT CASE WHEN transaction_count > 1 THEN customer_id END) * 100.0 / COUNT(DISTINCT customer_id)
                    ELSE 0
                END as repeat_rate
            FROM (
                SELECT
                    customer_id,
                    DATE_TRUNC('month', sale_date) as sale_date,
                    COUNT(*) OVER (PARTITION BY customer_id, DATE_TRUNC('month', sale_date)) as transaction_count
                FROM sales_transactions
                WHERE status != 'Cancelled' AND customer_id IS NOT NULL
                    ${startDate ? `AND sale_date >= '${startDate}'` : ''}
                    ${endDate ? `AND sale_date <= '${endDate}'` : ''}
                    ${branchId ? `AND branch_id = ${parseInt(branchId)}` : ''}
            ) monthly_transactions
            GROUP BY EXTRACT(YEAR FROM sale_date), EXTRACT(MONTH FROM sale_date)
            ORDER BY year, month
        `;

        const [segmentationResult, repeatResult] = await Promise.all([
            db.query(segmentationQuery),
            db.query(repeatCustomerQuery)
        ]);

        res.status(200).json({
            filtersUsed: { startDate, endDate, branchId },
            segmentation: segmentationResult.rows,
            repeatCustomers: repeatResult.rows
        });

    } catch (error) {
        console.error('Error fetching customer behavior analysis:', error);
        res.status(500).json({ error: 'Failed to fetch customer behavior analysis.', details: error.message });
    }
});

// GET /api/analysis/inventory-health - Inventory health analysis
router.get('/inventory-health', async (req, res) => {
    try {
        // Stock level analysis
        const stockLevelQuery = `
            SELECT
                p.id,
                p.name,
                p.category,
                p.price,
                COALESCE(i.quantity, 0) as current_stock,
                p.min_stock_level,
                CASE 
                    WHEN COALESCE(i.quantity, 0) <= p.min_stock_level THEN 'Low Stock'
                    WHEN COALESCE(i.quantity, 0) <= (p.min_stock_level * 2) THEN 'Medium Stock'
                    ELSE 'Adequate Stock'
                END as stock_status,
                COALESCE(sales_data.total_sold, 0) as total_sold,
                COALESCE(sales_data.days_supply, 0) as days_supply
            FROM products p
            LEFT JOIN inventory i ON p.id = i.product_id
            LEFT JOIN (
                SELECT
                    si.product_id,
                    SUM(si.quantity) as total_sold,
                    CASE 
                        WHEN AVG(si.quantity) > 0 THEN 
                            COALESCE(i.quantity, 0) / (SUM(si.quantity) / 30.0)
                        ELSE 999
                    END as days_supply
                FROM sales_items si
                JOIN sales_transactions st ON si.sale_id = st.id
                LEFT JOIN inventory i ON si.product_id = i.product_id
                WHERE st.sale_date >= CURRENT_DATE - INTERVAL '30 days'
                    AND st.status != 'Cancelled'
                GROUP BY si.product_id, i.quantity
            ) sales_data ON p.id = sales_data.product_id
            WHERE p.is_active = true
            ORDER BY stock_status, days_supply ASC
        `;

        // Inventory valuation by category
        const valuationQuery = `
            SELECT
                p.category,
                COUNT(*) as product_count,
                COALESCE(SUM(i.quantity * p.price), 0) as total_value,
                AVG(i.quantity * p.price) as avg_product_value
            FROM products p
            LEFT JOIN inventory i ON p.id = i.product_id
            WHERE p.is_active = true
            GROUP BY p.category
            ORDER BY total_value DESC
        `;

        const [stockLevelResult, valuationResult] = await Promise.all([
            db.query(stockLevelQuery),
            db.query(valuationQuery)
        ]);

        // Calculate inventory health metrics
        const totalProducts = stockLevelResult.rows.length;
        const lowStockCount = stockLevelResult.rows.filter(p => p.stock_status === 'Low Stock').length;
        const adequateStockCount = stockLevelResult.rows.filter(p => p.stock_status === 'Adequate Stock').length;
        const totalInventoryValue = valuationResult.rows.reduce((sum, cat) => sum + parseFloat(cat.total_value), 0);

        res.status(200).json({
            stockLevels: stockLevelResult.rows,
            categoryValuation: valuationResult.rows,
            healthMetrics: {
                totalProducts,
                lowStockCount,
                adequateStockCount,
                lowStockPercentage: (lowStockCount / totalProducts) * 100,
                totalInventoryValue,
                averageDaysSupply: stockLevelResult.rows.reduce((sum, p) => sum + (p.days_supply || 0), 0) / totalProducts
            }
        });

    } catch (error) {
        console.error('Error fetching inventory health analysis:', error);
        res.status(500).json({ error: 'Failed to fetch inventory health analysis.', details: error.message });
    }
});

// GET /api/analysis/staff-performance - Staff performance analysis
router.get('/staff-performance', async (req, res) => {
    const { startDate, endDate, branchId } = req.query;
    
    try {
        let query = `
            SELECT
                u.id,
                u.fullname,
                u.role,
                COUNT(st.id) as transaction_count,
                COALESCE(SUM(st.total_amount), 0) as total_sales,
                COALESCE(SUM(st.total_profit), 0) as total_profit,
                AVG(st.total_amount) as avg_transaction_value,
                COUNT(DISTINCT st.customer_id) as unique_customers,
                MIN(st.sale_date) as first_sale_date,
                MAX(st.sale_date) as last_sale_date
            FROM users u
            LEFT JOIN sales_transactions st ON u.id = st.cashier_id 
                AND st.status != 'Cancelled'
        `;
        let params = [];
        let paramIndex = 1;

        ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

        if (branchId) {
            query += ` AND st.branch_id = $${paramIndex++}`;
            params.push(parseInt(branchId));
        }

        query += `
            GROUP BY u.id, u.fullname, u.role
            HAVING COUNT(st.id) > 0
            ORDER BY total_sales DESC
        `;

        const result = await db.query(query, params);

        // Calculate performance metrics
        const performanceData = result.rows.map(staff => {
            const daysActive = staff.first_sale_date && staff.last_sale_date ? 
                Math.ceil((new Date(staff.last_sale_date) - new Date(staff.first_sale_date)) / (1000 * 60 * 60 * 24)) + 1 : 0;
            
            const salesPerDay = daysActive > 0 ? parseFloat(staff.total_sales) / daysActive : 0;
            const transactionsPerDay = daysActive > 0 ? parseInt(staff.transaction_count) / daysActive : 0;

            return {
                ...staff,
                days_active: daysActive,
                sales_per_day: salesPerDay,
                transactions_per_day: transactionsPerDay,
                profit_margin: staff.total_sales > 0 ? (parseFloat(staff.total_profit) / parseFloat(staff.total_sales)) * 100 : 0
            };
        });

        res.status(200).json({
            filtersUsed: { startDate, endDate, branchId },
            reportData: performanceData
        });

    } catch (error) {
        console.error('Error fetching staff performance analysis:', error);
        res.status(500).json({ error: 'Failed to fetch staff performance analysis.', details: error.message });
    }
});

// GET /api/analysis/credit-sales - Credit sales and receivables analysis
router.get('/credit-sales', async (req, res) => {
    const { startDate, endDate, branchId } = req.query;
    
    try {
        // Credit sales summary
        let creditQuery = `
            SELECT
                COUNT(*) as total_credit_sales,
                COALESCE(SUM(total_amount), 0) as total_credit_amount,
                COALESCE(SUM(balance_due), 0) as total_outstanding,
                AVG(total_amount) as avg_credit_sale,
                COUNT(CASE WHEN balance_due > 0 THEN 1 END) as active_credit_accounts
            FROM sales_transactions
            WHERE status != 'Cancelled' AND transaction_type = 'Credit'
        `;
        let creditParams = [];
        let creditParamIndex = 1;

        ({ query: creditQuery, params: creditParams, paramIndex: creditParamIndex } = applyDateFilters(
            creditQuery, creditParams, creditParamIndex, startDate, endDate, 'sale_date'
        ));

        if (branchId) {
            creditQuery += ` AND branch_id = $${creditParamIndex++}`;
            creditParams.push(parseInt(branchId));
        }

        // Aging analysis
        const agingQuery = `
            SELECT
                CASE
                    WHEN due_date < CURRENT_DATE THEN 'Overdue'
                    WHEN due_date <= CURRENT_DATE + INTERVAL '7 days' THEN 'Due Soon'
                    WHEN due_date <= CURRENT_DATE + INTERVAL '30 days' THEN 'Due Later'
                    ELSE 'Future'
                END as aging_category,
                COUNT(*) as invoice_count,
                COALESCE(SUM(balance_due), 0) as total_amount
            FROM sales_transactions
            WHERE status != 'Cancelled' 
                AND balance_due > 0
                AND due_date IS NOT NULL
            GROUP BY aging_category
            ORDER BY 
                CASE aging_category
                    WHEN 'Overdue' THEN 1
                    WHEN 'Due Soon' THEN 2
                    WHEN 'Due Later' THEN 3
                    ELSE 4
                END
        `;

        // Top customers with outstanding balances
        const topDebtorsQuery = `
            SELECT
                c.id,
                c.fullname,
                c.phone,
                COUNT(st.id) as credit_transactions,
                COALESCE(SUM(st.balance_due), 0) as total_balance,
                MAX(st.due_date) as latest_due_date
            FROM customers c
            JOIN sales_transactions st ON c.id = st.customer_id
            WHERE st.status != 'Cancelled' 
                AND st.balance_due > 0
            GROUP BY c.id, c.fullname, c.phone
            ORDER BY total_balance DESC
            LIMIT 10
        `;

        const [creditResult, agingResult, debtorsResult] = await Promise.all([
            db.query(creditQuery, creditParams),
            db.query(agingQuery),
            db.query(topDebtorsQuery)
        ]);

        const creditData = creditResult.rows[0];

        res.status(200).json({
            filtersUsed: { startDate, endDate, branchId },
            summary: {
                totalCreditSales: parseInt(creditData.total_credit_sales),
                totalCreditAmount: parseFloat(creditData.total_credit_amount),
                totalOutstanding: parseFloat(creditData.total_outstanding),
                avgCreditSale: parseFloat(creditData.avg_credit_sale),
                activeCreditAccounts: parseInt(creditData.active_credit_accounts),
                collectionRate: creditData.total_credit_amount > 0 ? 
                    ((parseFloat(creditData.total_credit_amount) - parseFloat(creditData.total_outstanding)) / parseFloat(creditData.total_credit_amount)) * 100 : 0
            },
            agingAnalysis: agingResult.rows,
            topDebtors: debtorsResult.rows
        });

    } catch (error) {
        console.error('Error fetching credit sales analysis:', error);
        res.status(500).json({ error: 'Failed to fetch credit sales analysis.', details: error.message });
    }
});

// GET /api/analysis/seasonal-trends - Seasonal and trend analysis
router.get('/seasonal-trends', async (req, res) => {
    const { year = new Date().getFullYear(), branchId } = req.query;
    
    try {
        let query = `
            SELECT
                EXTRACT(MONTH FROM sale_date) as month,
                EXTRACT(YEAR FROM sale_date) as year,
                TO_CHAR(sale_date, 'Month') as month_name,
                COUNT(*) as transaction_count,
                COALESCE(SUM(total_amount), 0) as total_sales,
                COALESCE(SUM(total_profit), 0) as total_profit,
                AVG(total_amount) as avg_transaction_value,
                COUNT(DISTINCT customer_id) as unique_customers
            FROM sales_transactions
            WHERE status != 'Cancelled'
                AND EXTRACT(YEAR FROM sale_date) = $1
        `;
        let params = [parseInt(year)];
        let paramIndex = 2;

        if (branchId) {
            query += ` AND branch_id = $${paramIndex++}`;
            params.push(parseInt(branchId));
        }

        query += `
            GROUP BY EXTRACT(YEAR FROM sale_date), EXTRACT(MONTH FROM sale_date), TO_CHAR(sale_date, 'Month')
            ORDER BY year, month
        `;

        const result = await db.query(query, params);

        // Daily trends (day of week analysis)
        const dailyTrendsQuery = `
            SELECT
                EXTRACT(DOW FROM sale_date) as day_of_week,
                TO_CHAR(sale_date, 'Day') as day_name,
                COUNT(*) as transaction_count,
                COALESCE(SUM(total_amount), 0) as total_sales,
                AVG(total_amount) as avg_transaction_value
            FROM sales_transactions
            WHERE status != 'Cancelled'
                AND EXTRACT(YEAR FROM sale_date) = $1
                ${branchId ? `AND branch_id = $2` : ''}
            GROUP BY EXTRACT(DOW FROM sale_date), TO_CHAR(sale_date, 'Day')
            ORDER BY day_of_week
        `;

        const dailyParams = branchId ? [parseInt(year), parseInt(branchId)] : [parseInt(year)];
        const dailyResult = await db.query(dailyTrendsQuery, dailyParams);

        res.status(200).json({
            filtersUsed: { year, branchId },
            monthlyTrends: result.rows,
            dailyTrends: dailyResult.rows
        });

    } catch (error) {
        console.error('Error fetching seasonal trends:', error);
        res.status(500).json({ error: 'Failed to fetch seasonal trends.', details: error.message });
    }
});

// GET /api/analysis/branch-comparison - Branch performance comparison
router.get('/branch-comparison', async (req, res) => {
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
                COUNT(st.id) as transaction_count,
                COALESCE(SUM(st.total_amount), 0) as total_sales,
                COALESCE(SUM(st.total_profit), 0) as total_profit,
                COALESCE(SUM(st.total_cogs), 0) as total_cogs,
                AVG(st.total_amount) as avg_transaction_value,
                COUNT(DISTINCT st.customer_id) as unique_customers,
                CASE
                    WHEN COALESCE(SUM(st.total_amount), 0) > 0 THEN
                        (COALESCE(SUM(st.total_amount), 0) - COALESCE(SUM(st.total_cogs), 0)) / COALESCE(SUM(st.total_amount), 0) * 100
                    ELSE 0
                END as profit_margin
            FROM branches b
            LEFT JOIN sales_transactions st ON b.id = st.branch_id 
                AND st.status != 'Cancelled'
        `;
        let params = [];
        let paramIndex = 1;

        ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

        query += `
            GROUP BY ${groupBy}, b.name
            ORDER BY period_label DESC, total_sales DESC
        `;

        const result = await db.query(query, params);

        // Calculate branch rankings
        const branchSummary = {};
        result.rows.forEach(row => {
            if (!branchSummary[row.branch_id]) {
                branchSummary[row.branch_id] = {
                    branch_name: row.branch_name,
                    total_sales: 0,
                    total_profit: 0,
                    transaction_count: 0,
                    unique_customers: new Set()
                };
            }
            
            branchSummary[row.branch_id].total_sales += parseFloat(row.total_sales);
            branchSummary[row.branch_id].total_profit += parseFloat(row.total_profit);
            branchSummary[row.branch_id].transaction_count += parseInt(row.transaction_count);
            if (row.unique_customers) {
                branchSummary[row.branch_id].unique_customers.add(row.unique_customers);
            }
        });

        // Convert unique_customers sets to counts
        Object.keys(branchSummary).forEach(branchId => {
            branchSummary[branchId].unique_customers = branchSummary[branchId].unique_customers.size;
            branchSummary[branchId].avg_transaction_value = branchSummary[branchId].transaction_count > 0 ?
                branchSummary[branchId].total_sales / branchSummary[branchId].transaction_count : 0;
            branchSummary[branchId].profit_margin = branchSummary[branchId].total_sales > 0 ?
                (branchSummary[branchId].total_profit / branchSummary[branchId].total_sales) * 100 : 0;
        });

        const branchRankings = Object.values(branchSummary).sort((a, b) => b.total_sales - a.total_sales);

        res.status(200).json({
            filtersUsed: { startDate, endDate, period },
            detailedData: result.rows,
            branchRankings: branchRankings
        });

    } catch (error) {
        console.error('Error fetching branch comparison:', error);
        res.status(500).json({ error: 'Failed to fetch branch comparison.', details: error.message });
    }
});

// GET /api/analysis/operational-efficiency - Operational efficiency metrics
router.get('/operational-efficiency', async (req, res) => {
    const { startDate, endDate, branchId } = req.query;
    
    try {
        // Production efficiency
        let productionEfficiencyQuery = `
            SELECT
                pl.production_date,
                SUM(pl.quantity_produced) as total_produced,
                SUM(pl.waste_quantity) as total_waste,
                CASE
                    WHEN SUM(pl.quantity_produced) > 0 THEN
                        (SUM(pl.quantity_produced) - SUM(pl.waste_quantity)) * 100.0 / SUM(pl.quantity_produced)
                    ELSE 0
                END as efficiency_rate,
                COUNT(*) as production_batches
            FROM production_logs pl
            WHERE 1=1
        `;
        let productionParams = [];
        let productionParamIndex = 1;

        ({ query: productionEfficiencyQuery, params: productionParams, paramIndex: productionParamIndex } = applyDateFilters(
            productionEfficiencyQuery, productionParams, productionParamIndex, startDate, endDate, 'pl.production_date'
        ));

        productionEfficiencyQuery += ` GROUP BY pl.production_date ORDER BY pl.production_date`;

        // Staff productivity
        let staffProductivityQuery = `
            SELECT
                u.id,
                u.fullname,
                u.role,
                COUNT(DISTINCT st.id) as sales_count,
                COALESCE(SUM(st.total_amount), 0) as sales_amount,
                COUNT(DISTINCT pl.id) as production_batches,
                COALESCE(SUM(pl.quantity_produced), 0) as items_produced
            FROM users u
            LEFT JOIN sales_transactions st ON u.id = st.cashier_id 
                AND st.status != 'Cancelled'
            LEFT JOIN production_logs pl ON u.id = pl.logged_by_user_id
            WHERE 1=1
        `;
        let staffParams = [];
        let staffParamIndex = 1;

        ({ query: staffProductivityQuery, params: staffParams, paramIndex: staffParamIndex } = applyDateFilters(
            staffProductivityQuery, staffParams, staffParamIndex, startDate, endDate, 'COALESCE(st.sale_date, pl.production_date)'
        ));

        if (branchId) {
            staffProductivityQuery += ` AND (st.branch_id = $${staffParamIndex} OR st.branch_id IS NULL)`;
            staffParams.push(parseInt(branchId));
            staffParamIndex++;
        }

        staffProductivityQuery += ` GROUP BY u.id, u.fullname, u.role HAVING COUNT(DISTINCT st.id) > 0 OR COUNT(DISTINCT pl.id) > 0`;

        // Resource utilization
        const resourceUtilizationQuery = `
            SELECT
                rm.name as raw_material,
                rm.current_stock,
                rm.min_stock_level,
                COALESCE(SUM(mt.quantity_change), 0) as monthly_usage,
                CASE
                    WHEN rm.current_stock > 0 AND COALESCE(SUM(mt.quantity_change), 0) > 0 THEN
                        rm.current_stock / (COALESCE(SUM(mt.quantity_change), 0) / 30.0)
                    ELSE 999
                END as days_of_supply
            FROM raw_materials rm
            LEFT JOIN material_transactions mt ON rm.id = mt.raw_material_id
                AND mt.transaction_date >= CURRENT_DATE - INTERVAL '30 days'
            GROUP BY rm.id, rm.name, rm.current_stock, rm.min_stock_level
            ORDER BY days_of_supply ASC
        `;

        const [productionResult, staffResult, resourceResult] = await Promise.all([
            db.query(productionEfficiencyQuery, productionParams),
            db.query(staffProductivityQuery, staffParams),
            db.query(resourceUtilizationQuery)
        ]);

        // Calculate overall efficiency metrics
        const totalProduced = productionResult.rows.reduce((sum, row) => sum + parseInt(row.total_produced), 0);
        const totalWaste = productionResult.rows.reduce((sum, row) => sum + parseInt(row.total_waste), 0);
        const overallEfficiency = totalProduced > 0 ? ((totalProduced - totalWaste) / totalProduced) * 100 : 0;

        res.status(200).json({
            filtersUsed: { startDate, endDate, branchId },
            productionEfficiency: productionResult.rows,
            staffProductivity: staffResult.rows,
            resourceUtilization: resourceResult.rows,
            overallMetrics: {
                totalProduced,
                totalWaste,
                overallEfficiency,
                wastePercentage: totalProduced > 0 ? (totalWaste / totalProduced) * 100 : 0,
                averageDailyProduction: productionResult.rows.length > 0 ? totalProduced / productionResult.rows.length : 0
            }
        });

    } catch (error) {
        console.error('Error fetching operational efficiency:', error);
        res.status(500).json({ error: 'Failed to fetch operational efficiency.', details: error.message });
    }
});

module.exports = router;