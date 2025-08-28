// purple-premium-bread-api/routes/alerts.js
const express = require('express');
const router = express.Router();
const db = require('../db/db');
const { jwtDecode } = require('jwt-decode');

// Helper to get user ID from token (still useful for manual resolution)
const getUserIdFromToken = (req) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) {
            const decoded = jwtDecode(token);
            return decoded.id;
        }
    } catch (e) {
        console.error("Failed to decode token for alert operations", e);
    }
    return null;
};

/**
 * Core function to check conditions, generate new alerts, and resolve old ones.
 * This function will be called by a scheduler (e.g., setInterval in server.js or a cron job).
 */
async function checkAndGenerateAlerts() {
    console.log(`[ALERT CHECK] Running automated alert check at ${new Date().toISOString()}`);
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // --- 1. Check for Low Raw Material Stock ---
        console.log('[ALERT CHECK] Checking for low raw material stock...');
        const lowMaterialQuery = `
            SELECT id, name, current_stock, min_stock_level, unit
            FROM raw_materials
            WHERE current_stock <= min_stock_level AND min_stock_level > 0;
        `;
        const lowMaterials = (await client.query(lowMaterialQuery)).rows;
        console.log(`[ALERT CHECK] Found ${lowMaterials.length} raw materials below min stock.`);

        // Active low material alerts
        const activeLowMaterialAlerts = (await client.query(
            `SELECT id, entity_id FROM inventory_alerts WHERE alert_type = 'low_stock_material' AND status = 'active'`
        )).rows.map(alert => alert.entity_id);
        console.log(`[ALERT CHECK] Currently ${activeLowMaterialAlerts.length} active low material alerts.`);

        for (const material of lowMaterials) {
            if (!activeLowMaterialAlerts.includes(material.id)) {
                const message = `Low Stock: Raw material "${material.name}" (${material.current_stock} ${material.unit}) is at or below its minimum stock level (${material.min_stock_level} ${material.unit}).`;
                await client.query(
                    `INSERT INTO inventory_alerts (alert_type, entity_id, entity_name, message, status)
                     VALUES ($1, $2, $3, $4, $5);`,
                    ['low_stock_material', material.id, material.name, message, 'active']
                );
                console.log(`[ALERT CHECK] NEW ALERT: Low stock for raw material "${material.name}".`);
            }
        }
        // Resolve low material alerts whose conditions are no longer met
        const materialsCurrentlyOK = (await client.query(
            `SELECT id FROM raw_materials WHERE current_stock > min_stock_level OR min_stock_level = 0`
        )).rows.map(m => m.id);

        const materialAlertsToResolve = activeLowMaterialAlerts.filter(entityId =>
            materialsCurrentlyOK.includes(entityId)
        );
        if (materialAlertsToResolve.length > 0) {
            await client.query(
                `UPDATE inventory_alerts SET status = 'resolved', resolved_at = NOW()
                 WHERE entity_id = ANY($1::int[]) AND alert_type = 'low_stock_material' AND status = 'active';`,
                [materialAlertsToResolve]
            );
            console.log(`[ALERT CHECK] RESOLVED ${materialAlertsToResolve.length} low raw material stock alerts.`);
        }


        // --- 2. Check for Overdue Customer Payments ---
        console.log('[ALERT CHECK] Checking for overdue customer payments...');
        const overdueCustomerQuery = `
            SELECT id, fullname, balance, due_date
            FROM customers
            WHERE balance > 0 AND due_date < NOW()::date;
        `;
        const overdueCustomers = (await client.query(overdueCustomerQuery)).rows;
        console.log(`[ALERT CHECK] Found ${overdueCustomers.length} overdue customer payments.`);

        // Active overdue payment alerts
        const activeOverdueCustomerAlerts = (await client.query(
            `SELECT id, entity_id FROM inventory_alerts WHERE alert_type = 'overdue_customer_payment' AND status = 'active'`
        )).rows.map(alert => alert.entity_id);
        console.log(`[ALERT CHECK] Currently ${activeOverdueCustomerAlerts.length} active overdue payment alerts.`);

        for (const customer of overdueCustomers) {
            if (!activeOverdueCustomerAlerts.includes(customer.id)) {
                const message = `Overdue Payment: Customer "${customer.fullname}" has an outstanding balance of ₦${parseFloat(customer.balance).toFixed(2)}, due since ${new Date(customer.due_date).toLocaleDateString()}.`;
                await client.query(
                    `INSERT INTO inventory_alerts (alert_type, entity_id, entity_name, message, status)
                     VALUES ($1, $2, $3, $4, $5);`,
                    ['overdue_customer_payment', customer.id, customer.fullname, message, 'active']
                );
                console.log(`[ALERT CHECK] NEW ALERT: Overdue payment for customer "${customer.fullname}".`);
            }
        }
        // Resolve overdue payment alerts whose conditions are no longer met
        const customersCurrentlyOK = (await client.query(
            `SELECT id FROM customers WHERE balance <= 0 OR due_date >= NOW()::date`
        )).rows.map(c => c.id);

        const customerAlertsToResolve = activeOverdueCustomerAlerts.filter(entityId =>
            customersCurrentlyOK.includes(entityId)
        );
        if (customerAlertsToResolve.length > 0) {
            await client.query(
                `UPDATE inventory_alerts SET status = 'resolved', resolved_at = NOW()
                 WHERE entity_id = ANY($1::int[]) AND alert_type = 'overdue_customer_payment' AND status = 'active';`,
                [customerAlertsToResolve]
            );
            console.log(`[ALERT CHECK] RESOLVED ${customerAlertsToResolve.length} overdue customer payment alerts.`);
        }


        // --- 3. Check for Low Finished Product Stock ---
        console.log('[ALERT CHECK] Checking for low finished product stock...');
        const lowProductQuery = `
            SELECT p.id, p.name, i.quantity as current_stock, p.min_stock_level, p.units->0->>'display' as unit_display
            FROM products p
            JOIN inventory i ON p.id = i.product_id
            WHERE i.quantity <= p.min_stock_level AND p.min_stock_level > 0;
        `;
        const lowProducts = (await client.query(lowProductQuery)).rows;
        console.log(`[ALERT CHECK] Found ${lowProducts.length} products below min stock.`);

        // Active low product alerts
        const activeLowProductAlerts = (await client.query(
            `SELECT id, entity_id FROM inventory_alerts WHERE alert_type = 'low_stock_product' AND status = 'active'`
        )).rows.map(alert => alert.entity_id);
        console.log(`[ALERT CHECK] Currently ${activeLowProductAlerts.length} active low product alerts.`);


        for (const product of lowProducts) {
            if (!activeLowProductAlerts.includes(product.id)) {
                const message = `Low Stock: Finished product "${product.name}" (${product.current_stock} ${product.unit_display || 'units'}) is at or below its minimum stock level (${product.min_stock_level} ${product.unit_display || 'units'}).`;
                await client.query(
                    `INSERT INTO inventory_alerts (alert_type, entity_id, entity_name, message, status)
                     VALUES ($1, $2, $3, $4, $5);`,
                    ['low_stock_product', product.id, product.name, message, 'active']
                );
                console.log(`[ALERT CHECK] NEW ALERT: Low stock for product "${product.name}".`);
            }
        }
        // Resolve low product alerts whose conditions are no longer met
        const productsCurrentlyOK = (await client.query(
            `SELECT p.id FROM products p JOIN inventory i ON p.id = i.product_id WHERE i.quantity > p.min_stock_level OR p.min_stock_level = 0`
        )).rows.map(p => p.id);

        const productAlertsToResolve = activeLowProductAlerts.filter(entityId =>
            productsCurrentlyOK.includes(entityId)
        );
        if (productAlertsToResolve.length > 0) {
            await client.query(
                `UPDATE inventory_alerts SET status = 'resolved', resolved_at = NOW()
                 WHERE entity_id = ANY($1::int[]) AND alert_type = 'low_stock_product' AND status = 'active';`,
                [productAlertsToResolve]
            );
            console.log(`[ALERT CHECK] RESOLVED ${productAlertsToResolve.length} low product stock alerts.`);
        }


        await client.query('COMMIT');
        console.log('[ALERT CHECK] Automated alert check completed successfully.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[ALERT CHECK ERROR] Error during automated alert check:', error);
    } finally {
        client.release();
    }
}

// Export the function to be called by server.js
module.exports = { router, checkAndGenerateAlerts };


// GET /api/alerts - Fetch alerts with filters
router.get('/', async (req, res) => {
    const { status, alertType, entityId, searchTerm } = req.query;
    let query = `
        SELECT
            id, alert_type, entity_id, entity_name, message, status, created_at, resolved_at
        FROM inventory_alerts
        WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (status) {
        query += ` AND status = $${paramIndex++}`;
        params.push(status);
    }
    if (alertType) {
        query += ` AND alert_type = $${paramIndex++}`;
        params.push(alertType);
    }
    if (entityId) {
        query += ` AND entity_id = $${paramIndex++}`;
        params.push(entityId);
    }
    if (searchTerm) {
        query += ` AND (message ILIKE $${paramIndex} OR entity_name ILIKE $${paramIndex})`;
        params.push(`%${searchTerm}%`);
        paramIndex++;
    }

    query += ` ORDER BY created_at DESC`;

    try {
        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching alerts:', error);
        res.status(500).json({ error: 'Failed to fetch alerts.', details: error.message });
    }
});

// PUT /api/alerts/:id/resolve - Mark an alert as resolved (manual resolution still possible)
router.put('/:id/resolve', async (req, res) => {
    const { id } = req.params;
    const resolved_by_user_id = getUserIdFromToken(req);

    if (!resolved_by_user_id) {
         console.warn(`Alert ID ${id} resolved without identified user.`);
    }

    try {
        const result = await db.query(
            `UPDATE inventory_alerts
             SET status = 'resolved', resolved_at = NOW()
             WHERE id = $1 AND status = 'active'
             RETURNING *;`,
            [id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Active alert not found or already resolved.' });
        }
        res.status(200).json({ message: 'Alert resolved successfully.', alert: result.rows[0] });
    } catch (error) {
        console.error('Error resolving alert:', error);
        res.status(500).json({ error: 'Failed to resolve alert.', details: error.message });
    }
});
