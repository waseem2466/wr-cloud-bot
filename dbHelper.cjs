const { Pool } = require('pg');
const path = require('path');
const dotenv = require('dotenv');

const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

let pool;

function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech')
                ? { rejectUnauthorized: false } : false,
            max: 5,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });
        pool.on('error', (err) => {
            console.error('[DB Helper] Pool error:', err.message);
        });
    }
    return pool;
}

async function searchInventory(query) {
    if (!query || query.length < 2) return [];
    const p = getPool();
    try {
        const res = await p.query(
            `SELECT name, price, stock, category, 'inventory' as source
             FROM "Product"
             WHERE name ILIKE $1 OR sku ILIKE $1
             UNION ALL
             SELECT name, price, stock, category, 'group' as source
             FROM "GroupProduct"
             WHERE name ILIKE $1
             LIMIT 5`,
            [`%${query}%`]
        );
        return res.rows.map(row => ({
            name: row.name,
            price: row.price,
            stock: row.stock,
            category: row.category || 'General',
            source: row.source
        }));
    } catch (err) {
        console.error('[DB Helper] Search error:', err.message);
        return [];
    }
}

async function getCustomerBalance(phone) {
    if (!phone) return null;
    const p = getPool();
    try {
        const cleanPhone = phone.replace(/[^0-9]/g, '').slice(-10);
        const res = await p.query(
            `SELECT name, phone, total_loan, total_paid, balance
             FROM "Customer" WHERE phone LIKE $1 LIMIT 1`,
            [`%${cleanPhone}%`]
        );
        if (res.rows.length === 0) return null;
        const c = res.rows[0];
        return {
            name: c.name,
            phone: c.phone,
            totalBalance: c.total_loan,
            paidAmount: c.total_paid,
            outstandingBalance: c.balance
        };
    } catch (err) {
        console.error('[DB Helper] Customer lookup error:', err.message);
        return null;
    }
}

async function getProductsByCategory(category) {
    if (!category || category.length < 2) return [];
    const p = getPool();
    try {
        const res = await p.query(
            `SELECT name, price, stock, category, description FROM "Product"
             WHERE category ILIKE $1 ORDER BY name LIMIT 10`,
            [`%${category}%`]
        );
        return res.rows;
    } catch (err) {
        console.error('[DB] Category search error:', err.message);
        return [];
    }
}

async function getAllCategories() {
    const p = getPool();
    try {
        const res = await p.query(
            `SELECT DISTINCT category FROM "Product" WHERE category IS NOT NULL ORDER BY category`
        );
        return res.rows.map(r => r.category);
    } catch (err) {
        console.error('[DB] Categories error:', err.message);
        return [];
    }
}

async function getCustomerByPhone(phone) {
    if (!phone) return null;
    const p = getPool();
    try {
        const cleanPhone = phone.replace(/[^0-9]/g, '').slice(-10);
        const res = await p.query(
            `SELECT id, name, phone, total_loan, total_paid, balance
             FROM "Customer" WHERE phone LIKE $1 LIMIT 1`,
            [`%${cleanPhone}%`]
        );
        if (res.rows.length === 0) return null;
        const c = res.rows[0];
        return {
            id: c.id,
            name: c.name,
            phone: c.phone,
            totalBalance: c.total_loan,
            paidAmount: c.total_paid,
            outstandingBalance: c.balance
        };
    } catch (err) {
        console.error('[DB] Customer lookup error:', err.message);
        return [];
    }
}

async function createOrder(customerName, customerPhone, items, paymentType = 'LOAN') {
    const p = getPool();
    const id = `ord_wa_${Date.now()}`;
    const invoiceNumber = `WA${Date.now().toString(36).toUpperCase()}`;
    const subtotal = items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    try {
        await p.query(
            `INSERT INTO "Bill" (id, invoice_number, date, customer_name, customer_id, items, subtotal, total, payment_type, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [id, invoiceNumber, new Date().toISOString(), customerName, '', JSON.stringify(items),
             subtotal, subtotal, paymentType, new Date().toISOString(), new Date().toISOString()]
        );
        for (const item of items) {
            await p.query(
                `UPDATE "Product" SET stock = GREATEST(0, stock - $1), updated_at = $2 WHERE name ILIKE $3`,
                [item.quantity, new Date().toISOString(), item.name]
            );
        }
        return { success: true, invoiceNumber, total: subtotal, id };
    } catch (err) {
        console.error('[DB] Order creation error:', err.message);
        return { success: false, error: err.message };
    }
}

async function getOrdersByPhone(phone) {
    if (!phone) return [];
    const p = getPool();
    try {
        const cleanPhone = phone.replace(/[^0-9]/g, '').slice(-10);
        const res = await p.query(
            `SELECT id, invoice_number, date, total, payment_type, created_at
             FROM "Bill" WHERE customer_id IN (SELECT id FROM "Customer" WHERE phone LIKE $1)
             ORDER BY date DESC LIMIT 5`,
            [`%${cleanPhone}%`]
        );
        return res.rows.map(r => ({ ...r, invoiceNumber: r.invoice_number }));
    } catch {
        try {
            const res = await p.query(
                `SELECT id, invoice_number, date, total, payment_type, created_at
                 FROM "Bill" WHERE customer_name IS NOT NULL ORDER BY date DESC LIMIT 5`
            );
            return res.rows.map(r => ({ ...r, invoiceNumber: r.invoice_number }));
        } catch { return []; }
    }
}

async function getOverdueCustomers(daysOverdue = 7) {
    const p = getPool();
    try {
        const res = await p.query(
            `SELECT id, name, phone, balance, total_loan, total_paid
             FROM "Customer"
             WHERE balance > 0
             ORDER BY balance DESC LIMIT 10`
        );
        return res.rows.map(c => ({
            id: c.id,
            name: c.name,
            phone: c.phone,
            outstandingBalance: c.balance,
            totalBalance: c.total_loan,
            paidAmount: c.total_paid
        }));
    } catch (err) {
        console.error('[DB] Overdue query error:', err.message);
        return [];
    }
}

module.exports = { searchInventory, getCustomerBalance, getProductsByCategory, getAllCategories, getCustomerByPhone, createOrder, getOrdersByPhone, getOverdueCustomers };