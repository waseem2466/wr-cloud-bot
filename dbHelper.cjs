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
            `SELECT name, phone, "totalBalance", "paidAmount", "outstandingBalance"
             FROM "Customer" WHERE phone LIKE $1 LIMIT 1`,
            [`%${cleanPhone}%`]
        );
        if (res.rows.length === 0) return null;
        const c = res.rows[0];
        return {
            name: c.name,
            phone: c.phone,
            totalBalance: c.totalBalance,
            paidAmount: c.paidAmount,
            outstandingBalance: c.outstandingBalance
        };
    } catch (err) {
        console.error('[DB Helper] Customer lookup error:', err.message);
        return null;
    }
}

module.exports = { searchInventory, getCustomerBalance };