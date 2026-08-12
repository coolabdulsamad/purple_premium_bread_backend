/**
 * routes/returns.js
 *
 * Phase 5: Sales returns.
 *  - Return any quantity (up to the not-yet-returned quantity) from any sale.
 *  - Restocks inventory (or the originating sales-user stock) automatically.
 *  - Settles the refunded value, in priority order:
 *      1. Reduces the sale's outstanding credit balance (customer or rider).
 *      2. Any remainder goes to the chosen refund_method:
 *         'advance' -> advance wallet credit, 'cash'/'bank' -> money paid out.
 *  - Full history with per-sale returnable quantities.
 *
 * All endpoints degrade to a clear 503 until migration 003 is applied.
 */

const express = require('express');
const router = express.Router();
const { jwtDecode } = require('jwt-decode');
const db = require('../db/db');
const { recordMoneyTransaction } = require('../utils/money');
const { ensureReturnsSchema, ensureWalletSchema } = require('../utils/schemaGuards');

const getUserIdFromToken = (req) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (token) return jwtDecode(token).id || null;
    } catch (e) {
        console.error('Returns: failed to decode token', e.message);
    }
    return null;
};

const round2 = (n) => Math.round((parseFloat(n) || 0) * 100) / 100;

/**
 * GET /api/returns/sale/:saleId
 * Sale summary + every sold product with its remaining returnable quantity,
 * plus the return history for that sale. Used by the Returns page form.
 */
router.get('/sale/:saleId', async (req, res) => {
    if (!(await ensureReturnsSchema())) {
        return res.status(503).json({ error: 'Returns feature unavailable: migration 003 has not been applied yet.' });
    }
    const { saleId } = req.params;
    try {
        const saleResult = await db.query(
            `SELECT st.id, st.total_amount, st.amount_paid, st.balance_due, st.status,
                    st.payment_method, st.sale_date, st.created_at, st.is_rider_sale,
                    st.customer_id, st.rider_id,
                    c.fullname AS customer_name, r.fullname AS rider_name
             FROM sales_transactions st
             LEFT JOIN customers c ON st.customer_id = c.id
             LEFT JOIN riders r ON st.rider_id = r.id
             WHERE st.id = $1`,
            [saleId]
        );
        if (saleResult.rows.length === 0) {
            return res.status(404).json({ error: 'Sale not found.' });
        }

        const itemsResult = await db.query(
            `SELECT si.product_id,
                    p.name AS product_name,
                    p.units,
                    SUM(si.quantity) AS sold_quantity,
                    COALESCE(MAX(si.final_price), MAX(si.price_at_sale), 0) AS unit_price,
                    COALESCE((
                        SELECT SUM(sri.quantity)
                        FROM sales_return_items sri
                        JOIN sales_returns sr ON sri.return_id = sr.id
                        WHERE sr.sale_id = $1 AND sri.product_id = si.product_id
                    ), 0) AS returned_quantity
             FROM sales_items si
             JOIN products p ON si.product_id = p.id
             WHERE si.sale_id = $1
             GROUP BY si.product_id, p.name, p.units
             ORDER BY p.name`,
            [saleId]
        );

        const items = itemsResult.rows.map((row) => ({
            product_id: row.product_id,
            product_name: row.product_name,
            units: row.units,
            sold_quantity: parseFloat(row.sold_quantity),
            returned_quantity: parseFloat(row.returned_quantity),
            returnable_quantity: round2(parseFloat(row.sold_quantity) - parseFloat(row.returned_quantity)),
            unit_price: parseFloat(row.unit_price)
        }));

        const returnsResult = await db.query(
            `SELECT sr.*, u.fullname AS processed_by_name,
                    COALESCE((
                        SELECT json_agg(json_build_object(
                            'product_id', sri.product_id,
                            'product_name', p.name,
                            'quantity', sri.quantity,
                            'unit_price', sri.unit_price,
                            'amount', sri.amount,
                            'restocked', sri.restocked
                        ))
                        FROM sales_return_items sri
                        LEFT JOIN products p ON sri.product_id = p.id
                        WHERE sri.return_id = sr.id
                    ), '[]'::json) AS items
             FROM sales_returns sr
             LEFT JOIN users u ON sr.processed_by = u.id
             WHERE sr.sale_id = $1
             ORDER BY sr.return_date DESC`,
            [saleId]
        );

        res.status(200).json({
            sale: saleResult.rows[0],
            items,
            returns: returnsResult.rows
        });
    } catch (error) {
        console.error('Error fetching returnable items for sale:', error);
        res.status(500).json({ error: 'Failed to fetch returnable items.', details: error.message });
    }
});

/**
 * POST /api/returns
 * Body: {
 *   sale_id, items: [{ product_id, quantity, restock? }],
 *   refund_method: 'credit_balance' | 'advance' | 'cash' | 'bank',
 *   reason?, return_date?
 * }
 */
router.post('/', async (req, res) => {
    if (!(await ensureReturnsSchema())) {
        return res.status(503).json({ error: 'Returns feature unavailable: migration 003 has not been applied yet.' });
    }

    const { sale_id, items, refund_method = 'advance', reason, return_date } = req.body;
    const processedBy = getUserIdFromToken(req);

    if (!sale_id || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'sale_id and a non-empty items array are required.' });
    }
    if (!['credit_balance', 'advance', 'cash', 'bank'].includes(refund_method)) {
        return res.status(400).json({ error: 'refund_method must be one of: credit_balance, advance, cash, bank.' });
    }
    for (const item of items) {
        if (!item.product_id || !(parseFloat(item.quantity) > 0)) {
            return res.status(400).json({ error: 'Each item needs a product_id and a quantity greater than zero.' });
        }
    }

    const walletReady = await ensureWalletSchema();
    if (refund_method === 'advance' && !walletReady) {
        return res.status(503).json({ error: 'Advance-wallet refunds need migration 002. Choose cash or bank, or apply the migration.' });
    }

    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        // --- Lock and load the sale ---
        const saleResult = await client.query(
            `SELECT id, customer_id, rider_id, is_rider_sale, balance_due, amount_paid,
                    status, stock_source, stock_source_user_id
             FROM sales_transactions WHERE id = $1 FOR UPDATE`,
            [sale_id]
        );
        if (saleResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Sale not found.' });
        }
        const sale = saleResult.rows[0];

        // --- Validate quantities against sold-minus-already-returned ---
        const lineItems = [];
        let totalAmount = 0;
        for (const item of items) {
            const soldResult = await client.query(
                `SELECT SUM(si.quantity) AS sold_quantity,
                        COALESCE(MAX(si.final_price), MAX(si.price_at_sale), 0) AS unit_price
                 FROM sales_items si
                 WHERE si.sale_id = $1 AND si.product_id = $2
                 GROUP BY si.product_id`,
                [sale_id, item.product_id]
            );
            if (soldResult.rows.length === 0 || !soldResult.rows[0].sold_quantity) {
                throw new Error(`Product ${item.product_id} was not part of sale #${sale_id}.`);
            }
            const returnedResult = await client.query(
                `SELECT COALESCE(SUM(sri.quantity), 0) AS returned_quantity
                 FROM sales_return_items sri
                 JOIN sales_returns sr ON sri.return_id = sr.id
                 WHERE sr.sale_id = $1 AND sri.product_id = $2`,
                [sale_id, item.product_id]
            );
            const sold = parseFloat(soldResult.rows[0].sold_quantity);
            const returned = parseFloat(returnedResult.rows[0].returned_quantity);
            const returnable = round2(sold - returned);
            const qty = round2(item.quantity);
            if (qty > returnable) {
                const nameResult = await client.query('SELECT name FROM products WHERE id = $1', [item.product_id]);
                const name = nameResult.rows[0]?.name || `Product ${item.product_id}`;
                throw new Error(`Cannot return ${qty} of ${name}: only ${returnable} returnable (${sold} sold, ${returned} already returned).`);
            }
            const unitPrice = parseFloat(soldResult.rows[0].unit_price);
            const amount = round2(qty * unitPrice);
            totalAmount = round2(totalAmount + amount);
            lineItems.push({
                product_id: item.product_id,
                quantity: qty,
                unit_price: unitPrice,
                amount,
                restock: item.restock !== false
            });
        }

        // --- Insert the return header ---
        const returnResult = await client.query(
            `INSERT INTO sales_returns (sale_id, customer_id, rider_id, return_date, total_amount,
                                        refund_method, reason, processed_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING *`,
            [
                sale_id,
                sale.customer_id || null,
                sale.rider_id || null,
                return_date || new Date(),
                totalAmount,
                refund_method,
                reason || null,
                processedBy
            ]
        );
        const returnRow = returnResult.rows[0];

        // --- Insert items + restock ---
        for (const line of lineItems) {
            await client.query(
                `INSERT INTO sales_return_items (return_id, product_id, quantity, unit_price, amount, restocked)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [returnRow.id, line.product_id, line.quantity, line.unit_price, line.amount, line.restock]
            );

            if (line.restock) {
                if (sale.stock_source === 'user_stock' && sale.stock_source_user_id) {
                    // Return stock to the sales user's own stock (upsert)
                    await client.query(
                        `INSERT INTO sales_user_stock (user_id, product_id, quantity, last_updated)
                         VALUES ($1, $2, $3, NOW())
                         ON CONFLICT (user_id, product_id)
                         DO UPDATE SET quantity = sales_user_stock.quantity + EXCLUDED.quantity,
                                       last_updated = NOW()`,
                        [sale.stock_source_user_id, line.product_id, line.quantity]
                    );
                } else {
                    await client.query(
                        `UPDATE inventory SET quantity = quantity + $1, last_updated = NOW()
                         WHERE product_id = $2`,
                        [line.quantity, line.product_id]
                    );
                }
            }
        }

        // --- Settle the value: outstanding credit first, remainder per refund_method ---
        let remaining = totalAmount;
        let creditApplied = 0;
        let walletCredited = 0;
        let cashRefunded = 0;

        const balanceDue = round2(sale.balance_due);
        if (balanceDue > 0) {
            creditApplied = Math.min(remaining, balanceDue);
            const newBalanceDue = round2(balanceDue - creditApplied);
            const amountPaid = round2(sale.amount_paid);
            const newStatus = newBalanceDue <= 0 ? 'Paid' : (amountPaid > 0 ? 'Partially Paid' : sale.status);

            await client.query(
                `UPDATE sales_transactions
                 SET balance_due = $1, status = $2
                 WHERE id = $3`,
                [newBalanceDue, newStatus, sale_id]
            );

            if (sale.is_rider_sale && sale.rider_id) {
                await client.query(
                    `UPDATE riders SET current_balance = GREATEST(0, current_balance - $1), updated_at = NOW()
                     WHERE id = $2`,
                    [creditApplied, sale.rider_id]
                );
            } else if (sale.customer_id) {
                await client.query(
                    `UPDATE customers SET balance = GREATEST(0, balance - $1), updated_at = NOW()
                     WHERE id = $2`,
                    [creditApplied, sale.customer_id]
                );
            }
            remaining = round2(remaining - creditApplied);
        }

        if (remaining > 0) {
            const ownerType = sale.is_rider_sale && sale.rider_id ? 'RIDER' : 'CUSTOMER';
            const ownerId = sale.is_rider_sale && sale.rider_id ? sale.rider_id : sale.customer_id;

            if (refund_method === 'cash' || refund_method === 'bank') {
                await recordMoneyTransaction({
                    client,
                    direction: 'OUT',
                    amount: remaining,
                    category: 'refund',
                    reference_type: 'sales_return',
                    reference_id: returnRow.id,
                    description: `Sales return refund for sale #${sale_id} (${refund_method})`,
                    payment_method: refund_method === 'cash' ? 'cash' : 'bank',
                    transaction_date: returnRow.return_date,
                    recorded_by: processedBy
                });
                cashRefunded = remaining;
            } else {
                // 'advance' or 'credit_balance' overflow -> advance wallet
                if (!walletReady) {
                    throw new Error('Advance wallet is unavailable (migration 002 not applied); choose cash or bank refund.');
                }
                if (!ownerId) {
                    throw new Error('Walk-in sale with no customer/rider: wallet refund is impossible. Choose cash or bank refund.');
                }
                const ownerTable = ownerType === 'RIDER' ? 'riders' : 'customers';
                const updateResult = await client.query(
                    `UPDATE ${ownerTable} SET advance_balance = COALESCE(advance_balance, 0) + $1
                     WHERE id = $2 RETURNING advance_balance`,
                    [remaining, ownerId]
                );
                if (updateResult.rowCount === 0) {
                    throw new Error(`${ownerType === 'RIDER' ? 'Rider' : 'Customer'} not found for wallet credit.`);
                }
                await client.query(
                    `INSERT INTO wallet_transactions
                        (owner_type, owner_id, transaction_type, amount, balance_after, reference_type, reference_id, notes, created_by)
                     VALUES ($1, $2, 'RETURN_CREDIT', $3, $4, 'sales_return', $5, $6, $7)`,
                    [
                        ownerType, ownerId, remaining,
                        updateResult.rows[0].advance_balance,
                        returnRow.id,
                        `Return credit for sale #${sale_id}`,
                        processedBy
                    ]
                );
                walletCredited = remaining;
            }
        }

        // --- Persist the settlement breakdown on the return row ---
        const finalized = await client.query(
            `UPDATE sales_returns
             SET credit_applied = $1, wallet_credited = $2, cash_refunded = $3
             WHERE id = $4 RETURNING *`,
            [creditApplied, walletCredited, cashRefunded, returnRow.id]
        );

        await client.query('COMMIT');
        res.status(201).json({
            message: 'Return processed successfully.',
            return: finalized.rows[0],
            items: lineItems,
            settlement: {
                total_amount: totalAmount,
                credit_applied: creditApplied,
                wallet_credited: walletCredited,
                cash_refunded: cashRefunded
            }
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Return processing error:', error.message);
        res.status(400).json({ error: error.message || 'Failed to process return.' });
    } finally {
        client.release();
    }
});

/**
 * GET /api/returns
 * Full return history. Filters: sale_id, customer_id, rider_id, startDate, endDate.
 */
router.get('/', async (req, res) => {
    if (!(await ensureReturnsSchema())) {
        return res.status(503).json({ error: 'Returns feature unavailable: migration 003 has not been applied yet.' });
    }
    const { sale_id, customer_id, rider_id, startDate, endDate } = req.query;
    try {
        let query = `
            SELECT sr.*, u.fullname AS processed_by_name,
                   c.fullname AS customer_name, r.fullname AS rider_name,
                   COALESCE((
                       SELECT json_agg(json_build_object(
                           'product_id', sri.product_id,
                           'product_name', p.name,
                           'quantity', sri.quantity,
                           'unit_price', sri.unit_price,
                           'amount', sri.amount,
                           'restocked', sri.restocked
                       ) ORDER BY sri.id)
                       FROM sales_return_items sri
                       LEFT JOIN products p ON sri.product_id = p.id
                       WHERE sri.return_id = sr.id
                   ), '[]'::json) AS items
            FROM sales_returns sr
            LEFT JOIN users u ON sr.processed_by = u.id
            LEFT JOIN customers c ON sr.customer_id = c.id
            LEFT JOIN riders r ON sr.rider_id = r.id
            WHERE 1 = 1
        `;
        const params = [];
        let i = 1;
        if (sale_id) { query += ` AND sr.sale_id = $${i++}`; params.push(sale_id); }
        if (customer_id) { query += ` AND sr.customer_id = $${i++}`; params.push(customer_id); }
        if (rider_id) { query += ` AND sr.rider_id = $${i++}`; params.push(rider_id); }
        if (startDate) { query += ` AND sr.return_date >= $${i++}`; params.push(startDate); }
        if (endDate) {
            const end = new Date(endDate);
            end.setDate(end.getDate() + 1);
            query += ` AND sr.return_date < $${i++}`;
            params.push(end.toISOString());
        }
        query += ' ORDER BY sr.return_date DESC';

        const result = await db.query(query, params);
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('Error fetching returns:', error);
        res.status(500).json({ error: 'Failed to fetch returns.', details: error.message });
    }
});

/**
 * GET /api/returns/:id - single return with items
 */
router.get('/:id', async (req, res) => {
    if (!(await ensureReturnsSchema())) {
        return res.status(503).json({ error: 'Returns feature unavailable: migration 003 has not been applied yet.' });
    }
    try {
        const result = await db.query(
            `SELECT sr.*, u.fullname AS processed_by_name,
                    c.fullname AS customer_name, r.fullname AS rider_name,
                    COALESCE((
                        SELECT json_agg(json_build_object(
                            'product_id', sri.product_id,
                            'product_name', p.name,
                            'quantity', sri.quantity,
                            'unit_price', sri.unit_price,
                            'amount', sri.amount,
                            'restocked', sri.restocked
                        ) ORDER BY sri.id)
                        FROM sales_return_items sri
                        LEFT JOIN products p ON sri.product_id = p.id
                        WHERE sri.return_id = sr.id
                    ), '[]'::json) AS items
             FROM sales_returns sr
             LEFT JOIN users u ON sr.processed_by = u.id
             LEFT JOIN customers c ON sr.customer_id = c.id
             LEFT JOIN riders r ON sr.rider_id = r.id
             WHERE sr.id = $1`,
            [req.params.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Return not found.' });
        }
        res.status(200).json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching return:', error);
        res.status(500).json({ error: 'Failed to fetch return.', details: error.message });
    }
});

module.exports = router;
