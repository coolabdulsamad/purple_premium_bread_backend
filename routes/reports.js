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

// In your reports.js file, update the profit-loss endpoint:

// Enhanced Profit & Loss Summary Report with Tax Calculation and Advantage Amounts
router.get('/profit-loss', async (req, res) => {
    const { startDate, endDate, branchId } = req.query;

    try {
        // Total Revenue from Sales - Updated to include advantage amounts
        let revenueQuery = `
            SELECT 
                COALESCE(SUM(total_amount), 0) AS total_revenue,
                COALESCE(SUM(total_cogs), 0) AS total_cogs,
                COALESCE(SUM(total_profit), 0) AS total_profit,
                COALESCE(SUM(CASE WHEN is_advantage_sale = true THEN advantage_total ELSE 0 END), 0) AS total_advantage_amount,
                COALESCE(SUM(CASE WHEN is_advantage_sale = true THEN total_amount ELSE 0 END), 0) AS total_advantage_sales,
                COALESCE(SUM(CASE WHEN is_advantage_sale = false OR is_advantage_sale IS NULL THEN total_amount ELSE 0 END), 0) AS total_regular_sales
            FROM sales_transactions
            WHERE status != 'Cancelled'
        `;
        let revenueParams = [];
        let paramIndex = 1;

        ({ query: revenueQuery, params: revenueParams, paramIndex } =
            applyDateFilters(revenueQuery, revenueParams, paramIndex, startDate, endDate, 'sale_date'));

        if (branchId) {
            revenueQuery += ` AND branch_id = $${paramIndex++}`;
            revenueParams.push(parseInt(branchId));
        }

        const salesResult = await db.query(revenueQuery, revenueParams);
        const {
            total_revenue,
            total_cogs,
            total_profit,
            total_advantage_amount,
            total_advantage_sales,
            total_regular_sales
        } = salesResult.rows[0];

        // Total Operating Expenses
        let expensesQuery = `
            SELECT COALESCE(SUM(amount), 0) AS total_operating_expenses
            FROM operating_expenses
            WHERE status = 'active'
        `;
        let expensesParams = [];
        paramIndex = 1;

        ({ query: expensesQuery, params: expensesParams, paramIndex } =
            applyDateFilters(expensesQuery, expensesParams, paramIndex, startDate, endDate, 'expense_date'));

        const expensesResult = await db.query(expensesQuery, expensesParams);
        const totalOperatingExpenses = parseFloat(expensesResult.rows[0].total_operating_expenses);

        // Total Salaries
        let salariesQuery = `
            SELECT COALESCE(SUM(net_amount), 0) AS total_salaries
            FROM salary_payments
            WHERE status = 'paid'
        `;
        let salariesParams = [];
        paramIndex = 1;

        ({ query: salariesQuery, params: salariesParams, paramIndex } =
            applyDateFilters(salariesQuery, salariesParams, paramIndex, startDate, endDate, 'payment_date'));

        const salariesResult = await db.query(salariesQuery, salariesParams);
        const totalSalaries = parseFloat(salariesResult.rows[0].total_salaries);

        // Calculate taxable income and tax
        const grossProfit = parseFloat(total_revenue) - parseFloat(total_cogs);
        const totalExpenses = totalOperatingExpenses + totalSalaries;
        const taxableIncome = Math.max(0, grossProfit - totalExpenses); // Ensure taxable income is not negative
        const taxRate = 0.30; // 30% tax rate
        const taxAmount = taxableIncome * taxRate;

        // Calculate net profit after tax
        const netProfitBeforeTax = grossProfit - totalExpenses;
        const netProfit = netProfitBeforeTax - taxAmount;

        res.status(200).json({
            reportTitle: 'Profit & Loss Summary',
            filtersUsed: { startDate, endDate, branchId },
            reportData: {
                totalRevenue: parseFloat(total_revenue),
                totalRegularSales: parseFloat(total_regular_sales),
                totalAdvantageSales: parseFloat(total_advantage_sales),
                totalAdvantageAmount: parseFloat(total_advantage_amount),
                totalCostOfGoodsSold: parseFloat(total_cogs),
                grossProfit: grossProfit,
                totalOperatingExpenses: totalOperatingExpenses,
                totalSalaries: totalSalaries,
                totalExpenses: totalExpenses,
                taxableIncome: taxableIncome,
                taxRate: taxRate * 100, // Convert to percentage for display
                taxAmount: taxAmount,
                netProfitBeforeTax: netProfitBeforeTax,
                netProfit: netProfit
            }
        });

    } catch (error) {
        console.error('Error generating Profit & Loss report:', error);
        res.status(500).json({ error: 'Failed to generate Profit & Loss report.', details: error.message });
    }
});

// NEW: Advantage Sales Analysis Report
router.get('/advantage-sales-analysis', async (req, res) => {
    const { startDate, endDate, branchId, productId, staffId } = req.query;

    try {
        let query = `
            SELECT
                st.id AS sale_id,
                st.sale_date,
                COALESCE(c.fullname, 'Walk-in Customer') AS customer_name,
                u.fullname AS cashier_name,
                b.name AS branch_name,
                st.payment_method,
                st.status,
                st.is_advantage_sale,
                st.advantage_total,
                st.base_subtotal,
                st.subtotal,
                st.total_amount,
                st.total_cogs,
                st.total_profit,
                st.note,
                st.payment_reference,
                -- Calculate advantage profit (additional profit from advantage sales)
                CASE 
                    WHEN st.is_advantage_sale = true THEN st.total_profit - (st.total_amount - st.advantage_total - st.total_cogs)
                    ELSE 0 
                END AS advantage_profit
            FROM sales_transactions st
            LEFT JOIN customers c ON st.customer_id = c.id
            LEFT JOIN users u ON st.cashier_id = u.id
            LEFT JOIN branches b ON st.branch_id = b.id
            WHERE st.status != 'Cancelled'
            AND st.is_advantage_sale = true
        `;
        let params = [];
        let paramIndex = 1;

        ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

        if (branchId) {
            query += ` AND st.branch_id = $${paramIndex++}`;
            params.push(parseInt(branchId));
        }
        if (productId) {
            // Join with sales_items to filter by product
            query = `
                SELECT DISTINCT
                    st.id AS sale_id,
                    st.sale_date,
                    COALESCE(c.fullname, 'Walk-in Customer') AS customer_name,
                    u.fullname AS cashier_name,
                    b.name AS branch_name,
                    st.payment_method,
                    st.status,
                    st.is_advantage_sale,
                    st.advantage_total,
                    st.base_subtotal,
                    st.subtotal,
                    st.total_amount,
                    st.total_cogs,
                    st.total_profit,
                    st.note,
                    st.payment_reference,
                    CASE 
                        WHEN st.is_advantage_sale = true THEN st.total_profit - (st.total_amount - st.advantage_total - st.total_cogs)
                        ELSE 0 
                    END AS advantage_profit
                FROM sales_transactions st
                LEFT JOIN customers c ON st.customer_id = c.id
                LEFT JOIN users u ON st.cashier_id = u.id
                LEFT JOIN branches b ON st.branch_id = b.id
                JOIN sales_items si ON st.id = si.sale_id
                WHERE st.status != 'Cancelled'
                AND st.is_advantage_sale = true
                AND si.product_id = $${paramIndex++}
            `;
            params.push(parseInt(productId));

            // Re-apply date filters
            ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));
        }
        if (staffId) {
            query += ` AND st.cashier_id = $${paramIndex++}`;
            params.push(parseInt(staffId));
        }

        query += ` ORDER BY st.sale_date DESC;`;

        const result = await db.query(query, params);

        // Calculate summary statistics
        const summary = {
            totalAdvantageSales: result.rows.length,
            totalAdvantageAmount: result.rows.reduce((sum, row) => sum + parseFloat(row.advantage_total || 0), 0),
            totalSalesAmount: result.rows.reduce((sum, row) => sum + parseFloat(row.total_amount || 0), 0),
            totalAdvantageProfit: result.rows.reduce((sum, row) => sum + parseFloat(row.advantage_profit || 0), 0),
            averageAdvantagePerSale: result.rows.length > 0 ?
                result.rows.reduce((sum, row) => sum + parseFloat(row.advantage_total || 0), 0) / result.rows.length : 0
        };

        res.status(200).json({
            reportTitle: 'Advantage Sales Analysis Report',
            filtersUsed: { startDate, endDate, branchId, productId, staffId },
            summary: summary,
            reportData: result.rows
        });

    } catch (error) {
        console.error('Error generating advantage sales analysis report:', error);
        res.status(500).json({ error: 'Failed to generate advantage sales analysis report.', details: error.message });
    }
});

// Update the detailed sales report to include advantage amounts
router.get('/detailed-sales', async (req, res) => {
    const { startDate, endDate, paymentMethod, customerId, status, minTotal, maxTotal, staffId, branchId, transactionType } = req.query;

    let query = `
        SELECT
            st.id AS sale_id,
            st.sale_date,
            st.is_rider_sale,
            COALESCE(c.fullname, 'Walk-in Customer') AS customer_name,
            u.fullname AS cashier_name,
            b.name AS branch_name,
            st.payment_method,
            st.status,
            st.transaction_type,
            st.subtotal,
            st.discount_amount,
            st.tax_amount,
            st.total_amount,
            st.total_cogs,
            st.total_profit,
            st.stock_source,
            st.receipt_reference,
            st.payment_image_url,
            st.note,
            st.amount_paid,
            st.balance_due,
            st.due_date,
            -- NEW: Advantage sale fields
            st.is_advantage_sale,
            st.advantage_total,
            st.base_subtotal,
            r.fullname AS rider_name,
            r.phone_number AS rider_phone,
            r.current_balance AS rider_balance,
            -- Calculate additional metrics
            CASE 
                WHEN st.is_advantage_sale = true THEN st.total_profit - (st.total_amount - st.advantage_total - st.total_cogs)
                ELSE 0 
            END AS advantage_profit,
            CASE 
                WHEN st.is_advantage_sale = true THEN st.total_amount - st.advantage_total
                ELSE st.total_amount
            END AS base_sales_amount
        FROM sales_transactions st
        LEFT JOIN customers c ON st.customer_id = c.id
        LEFT JOIN users u ON st.cashier_id = u.id
        LEFT JOIN branches b ON st.branch_id = b.id
        LEFT JOIN riders r ON st.rider_id = r.id
        WHERE st.status != 'Cancelled'
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    // ... existing filter logic remains the same ...

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

// Enhanced Detailed Sales Report with Discounts and Free Stock
// router.get('/detailed-sales', async (req, res) => {
//     const { startDate, endDate, paymentMethod, customerId, status, minTotal, maxTotal, staffId, branchId, transactionType } = req.query;

//     let query = `
//         SELECT
//             st.id AS sale_id,
//             st.sale_date,
//             COALESCE(c.fullname, 'Walk-in Customer') AS customer_name,
//             u.fullname AS cashier_name,
//             b.name AS branch_name,
//             st.payment_method,
//             st.status,
//             st.transaction_type,
//             st.subtotal,
//             st.discount_amount,
//             st.tax_amount,
//             st.total_amount,
//             st.total_cogs,
//             st.total_profit,
//             st.stock_source,
//             st.receipt_reference,
//             st.note,
//             st.amount_paid,
//             st.balance_due,
//             st.due_date
//         FROM sales_transactions st
//         LEFT JOIN customers c ON st.customer_id = c.id
//         LEFT JOIN users u ON st.cashier_id = u.id
//         LEFT JOIN branches b ON st.branch_id = b.id
//         WHERE st.status != 'Cancelled'
//     `;
//     let params = [];
//     let paramIndex = 1;

//     ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

//     if (paymentMethod) {
//         query += ` AND st.payment_method ILIKE $${paramIndex++}`;
//         params.push(`%${paymentMethod}%`);
//     }
//     if (customerId) {
//         query += ` AND st.customer_id = $${paramIndex++}`;
//         params.push(parseInt(customerId));
//     }
//     if (status) {
//         query += ` AND st.status ILIKE $${paramIndex++}`;
//         params.push(`%${status}%`);
//     }
//     if (minTotal) {
//         query += ` AND st.total_amount >= $${paramIndex++}`;
//         params.push(parseFloat(minTotal));
//     }
//     if (maxTotal) {
//         query += ` AND st.total_amount <= $${paramIndex++}`;
//         params.push(parseFloat(maxTotal));
//     }
//     if (staffId) {
//         query += ` AND st.cashier_id = $${paramIndex++}`;
//         params.push(parseInt(staffId));
//     }
//     if (branchId) {
//         query += ` AND st.branch_id = $${paramIndex++}`;
//         params.push(parseInt(branchId));
//     }
//     if (transactionType) {
//         query += ` AND st.transaction_type ILIKE $${paramIndex++}`;
//         params.push(`%${transactionType}%`);
//     }

//     query += ` ORDER BY st.sale_date DESC;`;

//     try {
//         const result = await db.query(query, params);
//         res.status(200).json({
//             reportTitle: 'Detailed Sales Report',
//             filtersUsed: { startDate, endDate, paymentMethod, customerId, status, minTotal, maxTotal, staffId, branchId, transactionType },
//             reportData: result.rows
//         });
//     } catch (error) {
//         console.error('Error generating detailed sales report:', error);
//         res.status(500).json({ error: 'Failed to generate detailed sales report.', details: error.message });
//     }
// });

// Free Stock Report
router.get('/free-stock', async (req, res) => {
    const { startDate, endDate, productId, branchId } = req.query;

    let query = `
        SELECT
            fsl.id,
            fsl.recorded_at,
            fsl.sale_id,
            p.name AS product_name,
            fsl.quantity,
            fsl.reason,
            u.fullname AS recorded_by_name
            -- Remove branch_name since users table doesn't have branch_id
        FROM free_stock_log fsl
        JOIN products p ON fsl.product_id = p.id
        LEFT JOIN users u ON fsl.recorded_by = u.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'fsl.recorded_at'));

    if (productId) {
        query += ` AND fsl.product_id = $${paramIndex++}`;
        params.push(parseInt(productId));
    }
    // Remove branch filtering since users table doesn't have branch_id
    // if (branchId) {
    //     query += ` AND u.branch_id = $${paramIndex++}`;
    //     params.push(parseInt(branchId));
    // }

    query += ` ORDER BY fsl.recorded_at DESC;`;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            reportTitle: 'Free Stock Report',
            filtersUsed: { startDate, endDate, productId, branchId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating free stock report:', error);
        res.status(500).json({ error: 'Failed to generate free stock report.', details: error.message });
    }
});

// Discount Analysis Report
router.get('/discount-analysis', async (req, res) => {
    const { startDate, endDate, productId, branchId, staffId } = req.query;

    let query = `
        SELECT
            si.id AS sale_item_id,
            st.id AS sale_id,
            st.sale_date,
            COALESCE(c.fullname, 'Walk-in Customer') AS customer_name,
            p.name AS product_name,
            si.quantity,
            -- CORRECT CALCULATIONS:
            si.price_at_sale AS original_price,
            (si.price_at_sale * (si.discount_applied/100)) AS discount_amount,
            si.discount_applied AS discount_percentage,
            (si.price_at_sale - (si.price_at_sale * (si.discount_applied/100))) AS final_price,
            u.fullname AS cashier_name,
            b.name AS branch_name
        FROM sales_items si
        JOIN sales_transactions st ON si.sale_id = st.id
        JOIN products p ON si.product_id = p.id
        LEFT JOIN customers c ON st.customer_id = c.id
        LEFT JOIN users u ON st.cashier_id = u.id
        LEFT JOIN branches b ON st.branch_id = b.id
        WHERE st.status != 'Cancelled' AND si.discount_applied > 0
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (productId) {
        query += ` AND si.product_id = $${paramIndex++}`;
        params.push(parseInt(productId));
    }
    if (branchId) {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }
    if (staffId) {
        query += ` AND st.cashier_id = $${paramIndex++}`;
        params.push(parseInt(staffId));
    }

    query += ` ORDER BY st.sale_date DESC;`;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            reportTitle: 'Discount Analysis Report',
            filtersUsed: { startDate, endDate, productId, branchId, staffId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating discount analysis report:', error);
        res.status(500).json({ error: 'Failed to generate discount analysis report.', details: error.message });
    }
});

// Enhanced Exchange Requests Report with Product Names
router.get('/exchange-requests', async (req, res) => {
    const { startDate, endDate, customerId, status } = req.query;

    let query = `
        SELECT
            er.id,
            er.created_at,
            c.fullname AS customer_name,
            er.original_sale_id,
            er.items_requested_jsonb,
            er.reason,
            er.status,
            requester.fullname AS requested_by_name,
            approver.fullname AS approved_by_name,
            er.approval_date
        FROM exchange_requests er
        JOIN customers c ON er.customer_id = c.id
        LEFT JOIN users requester ON er.requested_by_user_id = requester.id
        LEFT JOIN users approver ON er.approved_by_user_id = approver.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'er.created_at'));

    if (customerId) {
        query += ` AND er.customer_id = $${paramIndex++}`;
        params.push(parseInt(customerId));
    }
    if (status) {
        query += ` AND er.status = $${paramIndex++}`;
        params.push(status);
    }

    query += ` ORDER BY er.created_at DESC;`;

    try {
        const result = await db.query(query, params);

        // Get all product IDs from the exchange requests to fetch product names
        const productIds = new Set();

        result.rows.forEach(row => {
            if (row.items_requested_jsonb && Array.isArray(row.items_requested_jsonb)) {
                row.items_requested_jsonb.forEach(item => {
                    if (item.product_id) {
                        productIds.add(item.product_id);
                    }
                });
            } else if (typeof row.items_requested_jsonb === 'string') {
                try {
                    const parsedItems = JSON.parse(row.items_requested_jsonb);
                    if (Array.isArray(parsedItems)) {
                        parsedItems.forEach(item => {
                            if (item.product_id) {
                                productIds.add(item.product_id);
                            }
                        });
                    }
                } catch (e) {
                    console.error('Error parsing JSON:', e);
                }
            }
        });

        // Fetch product names for all product IDs
        let productsMap = new Map();
        if (productIds.size > 0) {
            const productIdsArray = Array.from(productIds);
            const placeholders = productIdsArray.map((_, index) => `$${index + 1}`).join(',');

            const productsQuery = `
                SELECT id, name 
                FROM products 
                WHERE id IN (${placeholders})
            `;

            const productsResult = await db.query(productsQuery, productIdsArray);
            productsResult.rows.forEach(product => {
                productsMap.set(product.id, product.name);
            });
        }

        // Process the items_requested_jsonb to include product names
        const processedData = result.rows.map(row => {
            let itemsDisplay = 'N/A';
            let itemsWithNames = [];

            if (row.items_requested_jsonb && Array.isArray(row.items_requested_jsonb)) {
                itemsWithNames = row.items_requested_jsonb.map(item => {
                    const productName = productsMap.get(item.product_id) || `Product ID: ${item.product_id}`;
                    return {
                        ...item,
                        product_name: productName
                    };
                });

                itemsDisplay = itemsWithNames.map(item =>
                    `${item.product_name} (Qty: ${item.quantity || 0})`
                ).join(', ');

            } else if (typeof row.items_requested_jsonb === 'string') {
                try {
                    const parsedItems = JSON.parse(row.items_requested_jsonb);
                    if (Array.isArray(parsedItems)) {
                        itemsWithNames = parsedItems.map(item => {
                            const productName = productsMap.get(item.product_id) || `Product ID: ${item.product_id}`;
                            return {
                                ...item,
                                product_name: productName
                            };
                        });

                        itemsDisplay = itemsWithNames.map(item =>
                            `${item.product_name} (Qty: ${item.quantity || 0})`
                        ).join(', ');
                    }
                } catch (e) {
                    itemsDisplay = 'Invalid JSON format';
                }
            }

            return {
                ...row,
                items_display: itemsDisplay,
                items_with_names: itemsWithNames // Include detailed items with names for frontend
            };
        });

        res.status(200).json({
            reportTitle: 'Bread Exchange Report',
            filtersUsed: { startDate, endDate, customerId, status },
            reportData: processedData
        });
    } catch (error) {
        console.error('Error generating exchange requests report:', error);
        res.status(500).json({ error: 'Failed to generate exchange requests report.', details: error.message });
    }
});

// Operating Expenses Report
router.get('/operating-expenses', async (req, res) => {
    const { startDate, endDate, expenseType, expenseCategory, branchId } = req.query;

    let query = `
        SELECT
            oe.id,
            oe.expense_date,
            oe.expense_type,
            oe.category,
            oe.description,
            oe.amount,
            oe.payment_method,
            oe.reference_number,
            u.fullname AS recorded_by_name,
            oe.status
        FROM operating_expenses oe
        LEFT JOIN users u ON oe.recorded_by = u.id
        WHERE oe.status = 'active'
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'oe.expense_date'));

    if (expenseType) {
        query += ` AND oe.expense_type ILIKE $${paramIndex++}`;
        params.push(`%${expenseType}%`);
    }
    if (expenseCategory) {
        query += ` AND oe.category ILIKE $${paramIndex++}`;
        params.push(`%${expenseCategory}%`);
    }
    if (branchId) {
        query += ` AND u.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }

    query += ` ORDER BY oe.expense_date DESC;`;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            reportTitle: 'Operating Expenses Report',
            filtersUsed: { startDate, endDate, expenseType, expenseCategory, branchId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating operating expenses report:', error);
        res.status(500).json({ error: 'Failed to generate operating expenses report.', details: error.message });
    }
});

// Salary & Payroll Report
router.get('/salary-payroll', async (req, res) => {
    const { startDate, endDate, staffId, salaryStatus } = req.query;

    let query = `
        SELECT
            sp.id,
            u.fullname AS staff_name,
            sp.salary_period,
            sp.payment_date,
            sp.base_salary,
            sp.allowances,
            sp.deductions,
            sp.tax_amount,
            sp.pension_amount,
            sp.net_amount,
            sp.payment_method,
            sp.payment_reference,
            sp.status,
            payer.fullname AS paid_by_name,
            sp.notes
        FROM salary_payments sp
        JOIN users u ON sp.user_id = u.id
        LEFT JOIN users payer ON sp.paid_by = payer.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'sp.payment_date'));

    if (staffId) {
        query += ` AND sp.user_id = $${paramIndex++}`;
        params.push(parseInt(staffId));
    }
    if (salaryStatus) {
        query += ` AND sp.status = $${paramIndex++}`;
        params.push(salaryStatus);
    }

    query += ` ORDER BY sp.payment_date DESC;`;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            reportTitle: 'Salary & Payroll Report',
            filtersUsed: { startDate, endDate, staffId, salaryStatus },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating salary payroll report:', error);
        res.status(500).json({ error: 'Failed to generate salary payroll report.', details: error.message });
    }
});

// Waste Stock Report
router.get('/waste-stock', async (req, res) => {
    const { startDate, endDate, productId, wasteReason } = req.query;

    let query = `
        SELECT
            ws.id,
            ws.date_recorded,
            p.name AS product_name,
            ws.quantity,
            ws.reason,
            ws.notes,
            u.fullname AS recorded_by_name
        FROM waste_stock ws
        JOIN products p ON ws.product_id = p.id
        LEFT JOIN users u ON ws.recorded_by = u.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'ws.date_recorded'));

    if (productId) {
        query += ` AND ws.product_id = $${paramIndex++}`;
        params.push(parseInt(productId));
    }
    if (wasteReason) {
        query += ` AND ws.reason ILIKE $${paramIndex++}`;
        params.push(`%${wasteReason}%`);
    }

    query += ` ORDER BY ws.date_recorded DESC;`;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            reportTitle: 'Waste Stock Report',
            filtersUsed: { startDate, endDate, productId, wasteReason },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating waste stock report:', error);
        res.status(500).json({ error: 'Failed to generate waste stock report.', details: error.message });
    }
});

// Stock Issue/Transfer Report
router.get('/stock-issue-transfer', async (req, res) => {
    const { startDate, endDate, productId, issueType } = req.query;

    let query = `
        SELECT
            sil.id,
            sil.created_at,
            sil.issue_type,
            from_user.fullname AS from_user_name,
            to_user.fullname AS to_user_name,
            p.name AS product_name,
            sil.quantity_changed,
            sil.note,
            recorder.fullname AS recorded_by_name
        FROM stock_issue_log sil
        JOIN products p ON sil.product_id = p.id
        LEFT JOIN users from_user ON sil.from_user_id = from_user.id
        LEFT JOIN users to_user ON sil.to_user_id = to_user.id
        LEFT JOIN users recorder ON sil.recorded_by = recorder.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'sil.created_at'));

    if (productId) {
        query += ` AND sil.product_id = $${paramIndex++}`;
        params.push(parseInt(productId));
    }
    if (issueType) {
        query += ` AND sil.issue_type = $${paramIndex++}`;
        params.push(issueType);
    }

    query += ` ORDER BY sil.created_at DESC;`;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            reportTitle: 'Stock Issue/Transfer Report',
            filtersUsed: { startDate, endDate, productId, issueType },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating stock issue/transfer report:', error);
        res.status(500).json({ error: 'Failed to generate stock issue/transfer report.', details: error.message });
    }
});

// Production Efficiency Report
router.get('/production-efficiency', async (req, res) => {
    const { startDate, endDate, productId } = req.query;

    let query = `
        SELECT
            pl.id,
            pl.production_date,
            p.name AS product_name,
            pl.quantity_produced,
            pl.waste_quantity,
            ROUND((pl.waste_quantity::decimal / NULLIF(pl.quantity_produced + pl.waste_quantity, 0)) * 100, 2) AS waste_percentage,
            ROUND((pl.quantity_produced::decimal / NULLIF(pl.quantity_produced + pl.waste_quantity, 0)) * 100, 2) AS efficiency_percentage,
            pl.batch_number,
            u.fullname AS produced_by_name
        FROM production_logs pl
        JOIN products p ON pl.product_id = p.id
        LEFT JOIN users u ON pl.logged_by_user_id = u.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'pl.production_date'));

    if (productId) {
        query += ` AND pl.product_id = $${paramIndex++}`;
        params.push(parseInt(productId));
    }

    query += ` ORDER BY pl.production_date DESC;`;

    try {
        const result = await db.query(query, params);
        res.status(200).json({
            reportTitle: 'Production Efficiency Report',
            filtersUsed: { startDate, endDate, productId },
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating production efficiency report:', error);
        res.status(500).json({ error: 'Failed to generate production efficiency report.', details: error.message });
    }
});


// Enhanced Product Profitability Report
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
            COALESCE(SUM(si.quantity * si.price_at_sale) - SUM(si.quantity * si.cost_at_sale), 0) AS product_gross_profit,
            CASE 
                WHEN COALESCE(SUM(si.quantity * si.price_at_sale), 0) > 0 
                THEN ROUND(((COALESCE(SUM(si.quantity * si.price_at_sale) - SUM(si.quantity * si.cost_at_sale)) / SUM(si.quantity * si.price_at_sale)) * 100), 2)
                ELSE 0 
            END AS profit_margin_percentage
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

// purple-premium-bread-api/routes/reports.js
// Add these new endpoints to your existing reports.js file

// NEW: Rider Sales Report
router.get('/rider-sales', async (req, res) => {
    const { startDate, endDate, riderId, branchId, paymentMethod, status } = req.query;

    let query = `
        SELECT
            st.id AS sale_id,
            st.sale_date,
            r.fullname AS rider_name,
            r.phone_number AS rider_phone,
            COALESCE(c.fullname, 'Walk-in Customer') AS customer_name,
            u.fullname AS cashier_name,
            b.name AS branch_name,
            st.payment_method,
            st.status,
            st.transaction_type,
            st.subtotal,
            st.discount_amount,
            st.tax_amount,
            st.total_amount,
            st.total_cogs,
            st.total_profit,
            st.is_advantage_sale,
            st.advantage_total,
            st.is_rider_sale,
            st.amount_paid,
            st.balance_due,
            st.due_date,
            st.note
        FROM sales_transactions st
        LEFT JOIN riders r ON st.rider_id = r.id
        LEFT JOIN customers c ON st.customer_id = c.id
        LEFT JOIN users u ON st.cashier_id = u.id
        LEFT JOIN branches b ON st.branch_id = b.id
        WHERE st.is_rider_sale = true
        AND st.status != 'Cancelled'
    `;
    let params = [];
    let paramIndex = 1;

    // Apply date filters
    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'st.sale_date'));

    if (riderId) {
        query += ` AND st.rider_id = $${paramIndex++}`;
        params.push(parseInt(riderId));
    }
    if (branchId) {
        query += ` AND st.branch_id = $${paramIndex++}`;
        params.push(parseInt(branchId));
    }
    if (paymentMethod) {
        query += ` AND st.payment_method ILIKE $${paramIndex++}`;
        params.push(`%${paymentMethod}%`);
    }
    if (status) {
        query += ` AND st.status ILIKE $${paramIndex++}`;
        params.push(`%${status}%`);
    }

    query += ` ORDER BY st.sale_date DESC;`;

    try {
        const result = await db.query(query, params);

        // Calculate summary statistics
        const summary = {
            totalSales: result.rows.reduce((sum, row) => sum + parseFloat(row.total_amount || 0), 0),
            totalProfit: result.rows.reduce((sum, row) => sum + parseFloat(row.total_profit || 0), 0),
            totalTransactions: result.rows.length,
            totalCreditSales: result.rows.filter(row => row.status === 'Unpaid' || row.status === 'Partially Paid').length,
            totalOutstandingBalance: result.rows.reduce((sum, row) => sum + parseFloat(row.balance_due || 0), 0)
        };

        res.status(200).json({
            reportTitle: 'Rider Sales Report',
            filtersUsed: { startDate, endDate, riderId, branchId, paymentMethod, status },
            summary: summary,
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating rider sales report:', error);
        res.status(500).json({ error: 'Failed to generate rider sales report.', details: error.message });
    }
});

// NEW: Rider Performance Report
router.get('/rider-performance', async (req, res) => {
    const { startDate, endDate, limit = 10, sortBy = 'total_sales' } = req.query;

    let query = `
        SELECT
            r.id AS rider_id,
            r.fullname AS rider_name,
            r.phone_number,
            r.credit_limit,
            r.current_balance,
            r.payment_terms,
            COUNT(st.id) AS total_transactions,
            COALESCE(SUM(st.total_amount), 0) AS total_sales,
            COALESCE(SUM(st.total_profit), 0) AS total_profit,
            COALESCE(SUM(st.balance_due), 0) AS outstanding_balance,
            COALESCE(AVG(st.total_amount), 0) AS avg_transaction_value,
            COUNT(DISTINCT st.customer_id) AS unique_customers,
            COALESCE(SUM(CASE WHEN st.status IN ('Unpaid', 'Partially Paid') THEN st.balance_due ELSE 0 END), 0) AS total_collectible,
            MAX(st.sale_date) AS last_sale_date
        FROM riders r
        LEFT JOIN sales_transactions st ON r.id = st.rider_id 
            AND st.is_rider_sale = true 
            AND st.status != 'Cancelled'
    `;
    let params = [];
    let paramIndex = 1;

    // Apply date filters
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

    query += `
        GROUP BY r.id, r.fullname, r.phone_number, r.credit_limit, r.current_balance, r.payment_terms
        ORDER BY ${sortBy === 'total_sales' ? 'total_sales' :
            sortBy === 'outstanding' ? 'outstanding_balance' :
                sortBy === 'transactions' ? 'total_transactions' : 'total_sales'} DESC
    `;

    if (limit && limit > 0) {
        query += ` LIMIT $${paramIndex++}`;
        params.push(parseInt(limit));
    }

    try {
        const result = await db.query(query, params);

        // Calculate overall metrics
        const overall = {
            totalRiders: result.rows.length,
            totalSales: result.rows.reduce((sum, r) => sum + parseFloat(r.total_sales), 0),
            totalOutstanding: result.rows.reduce((sum, r) => sum + parseFloat(r.outstanding_balance), 0),
            avgPerRider: result.rows.length > 0 ?
                result.rows.reduce((sum, r) => sum + parseFloat(r.total_sales), 0) / result.rows.length : 0
        };

        res.status(200).json({
            reportTitle: 'Rider Performance Report',
            filtersUsed: { startDate, endDate, limit, sortBy },
            overall: overall,
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating rider performance report:', error);
        res.status(500).json({ error: 'Failed to generate rider performance report.', details: error.message });
    }
});

// NEW: Rider Payment History
router.get('/rider-payments', async (req, res) => {
    const { startDate, endDate, riderId, paymentMethod } = req.query;

    let query = `
        SELECT
            rph.id AS payment_id,
            r.fullname AS rider_name,
            rph.payment_date,
            rph.amount,
            rph.payment_method,
            rph.notes,
            u.fullname AS recorded_by_name,
            COALESCE(
                (SELECT COUNT(*) FROM sales_transactions st 
                 WHERE st.rider_id = r.id AND st.payment_reference = rph.payment_reference),
                0
            ) AS transactions_covered
        FROM rider_payment_history rph
        JOIN riders r ON rph.rider_id = r.id
        LEFT JOIN users u ON rph.recorded_by = u.id
        WHERE 1=1
    `;
    let params = [];
    let paramIndex = 1;

    ({ query, params, paramIndex } = applyDateFilters(query, params, paramIndex, startDate, endDate, 'rph.payment_date'));

    if (riderId) {
        query += ` AND rph.rider_id = $${paramIndex++}`;
        params.push(parseInt(riderId));
    }
    if (paymentMethod) {
        query += ` AND rph.payment_method ILIKE $${paramIndex++}`;
        params.push(`%${paymentMethod}%`);
    }

    query += ` ORDER BY rph.payment_date DESC;`;

    try {
        const result = await db.query(query, params);

        const summary = {
            totalPayments: result.rows.length,
            totalAmount: result.rows.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0),
            avgPayment: result.rows.length > 0 ?
                result.rows.reduce((sum, p) => sum + parseFloat(p.amount || 0), 0) / result.rows.length : 0
        };

        res.status(200).json({
            reportTitle: 'Rider Payment History',
            filtersUsed: { startDate, endDate, riderId, paymentMethod },
            summary: summary,
            reportData: result.rows
        });
    } catch (error) {
        console.error('Error generating rider payment history:', error);
        res.status(500).json({ error: 'Failed to generate rider payment history.', details: error.message });
    }
});

// UPDATE existing detailed sales report to include rider information
// Find your existing '/detailed-sales' endpoint and update the SELECT clause to include rider fields:

/*
In the detailed-sales endpoint, add these fields to the SELECT clause:
    st.is_rider_sale,
    r.fullname AS rider_name,
    r.phone_number AS rider_phone,
    r.current_balance AS rider_balance,
*/

// Also update the JOIN:
/*
LEFT JOIN riders r ON st.rider_id = r.id
*/


module.exports = router;
