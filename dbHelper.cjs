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
            `SELECT name, price, stock, category, 'inventory' as source, '' as image_url
             FROM "Product"
             WHERE name ILIKE $1 OR sku ILIKE $1
             UNION ALL
             SELECT name, price, stock, category, 'group' as source, '' as image_url
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
            source: row.source,
            imageUrl: row.image_url || ''
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

async function getProductsByCategory(category, page = 1, limit = 10) {
    if (!category || category.length < 2) return { products: [], total: 0, page: 1, totalPages: 0 };
    const p = getPool();
    try {
        const offset = (page - 1) * limit;
        const countRes = await p.query(
            `SELECT COUNT(*) as cnt FROM "Product" WHERE category ILIKE $1`,
            [`%${category}%`]
        );
        const total = parseInt(countRes.rows[0]?.cnt || 0);
        const totalPages = Math.ceil(total / limit);
        const res = await p.query(
            `SELECT name, price, stock, category, description, COALESCE(image_url, '') as image_url
             FROM "Product" WHERE category ILIKE $1 ORDER BY name LIMIT $2 OFFSET $3`,
            [`%${category}%`, limit, offset]
        );
        return { products: res.rows, total, page, totalPages };
    } catch (err) {
        console.error('[DB] Category search error:', err.message);
        return { products: [], total: 0, page: 1, totalPages: 0 };
    }
}

async function getPopularProducts(limit = 10) {
    const p = getPool();
    try {
        const res = await p.query(
            `SELECT name, price, stock, category, COALESCE(image_url, '') as image_url
             FROM "Product" WHERE stock > 0
             ORDER BY stock DESC, name ASC LIMIT $1`,
            [limit]
        );
        return res.rows;
    } catch (err) {
        console.error('[DB] Popular products error:', err.message);
        return [];
    }
}

async function getNewArrivals(limit = 10) {
    const p = getPool();
    try {
        const res = await p.query(
            `SELECT name, price, stock, category, COALESCE(image_url, '') as image_url
             FROM "Product" WHERE created_at IS NOT NULL
             ORDER BY created_at DESC LIMIT $1`,
            [limit]
        );
        return res.rows;
    } catch (err) {
        console.error('[DB] New arrivals error:', err.message);
        return [];
    }
}

async function getProductsByIds(ids) {
    if (!ids || ids.length === 0) return [];
    const p = getPool();
    try {
        const res = await p.query(
            `SELECT name, price, stock, category, COALESCE(image_url, '') as image_url
             FROM "Product" WHERE id = ANY($1)`,
            [ids]
        );
        return res.rows;
    } catch (err) {
        console.error('[DB] Products by IDs error:', err.message);
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

async function getProductByName(name) {
    if (!name) return null;
    const p = getPool();
    try {
        const res = await p.query(
            `SELECT name, price, stock, category, COALESCE(image_url, '') as image_url
             FROM "Product" WHERE name ILIKE $1 LIMIT 1`,
            [`%${name}%`]
        );
        return res.rows[0] || null;
    } catch (err) {
        console.error('[DB] Product lookup error:', err.message);
        return null;
    }
}

async function createWhatsAppOrder(customerName, customerPhone, items, paymentType = 'CASH') {
    const p = getPool();
    const id = `ord_wa_${Date.now()}`;
    const invoiceNumber = `WA${Date.now().toString(36).toUpperCase()}`;
    const subtotal = items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    const customerId = customerPhone ? customerPhone.replace(/[^0-9]/g, '').slice(-10) : '';
    try {
        // Find or create customer
        let customerRow = null;
        if (customerId) {
            const existing = await p.query(`SELECT id FROM "Customer" WHERE phone LIKE $1 LIMIT 1`, [`%${customerId}%`]);
            if (existing.rows.length > 0) {
                customerRow = existing.rows[0].id;
            }
        }
        if (!customerRow && customerPhone) {
            const newCustId = `cust_${Date.now()}`;
            await p.query(
                `INSERT INTO "Customer" (id, name, phone, total_loan, total_paid, balance, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
                [newCustId, customerName || 'Customer', customerPhone, subtotal, 0, subtotal]
            );
            customerRow = newCustId;
        }
        // Create bill
        await p.query(
            `INSERT INTO "Bill" (id, invoice_number, date, customer_name, customer_id, items, subtotal, total, cash_received, payment_type, created_at, updated_at)
             VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
            [id, invoiceNumber, customerName || 'Customer', customerRow || '', JSON.stringify(items),
             subtotal, subtotal, 0, paymentType]
        );
        // Deduct stock
        for (const item of items) {
            await p.query(
                `UPDATE "Product" SET stock = GREATEST(0, stock - $1), updated_at = NOW() WHERE name ILIKE $2`,
                [item.quantity, item.name]
            );
        }
        return { success: true, invoiceNumber, total: subtotal, id, customerId: customerRow };
    } catch (err) {
        console.error('[DB] WhatsApp order error:', err.message);
        return { success: false, error: err.message };
    }
}

// ═══════════ SUPPLIER MANAGEMENT ═══════════

async function addSupplier(name, phone, altPhone = '', company = '', address = '', notes = '') {
    const p = getPool();
    const id = `sup_${Date.now()}`;
    try {
        await p.query(
            `INSERT INTO "Supplier" (id, name, phone, alt_phone, company, address, notes, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
            [id, name, phone, altPhone, company, address, notes]
        );
        return { success: true, id, name, phone };
    } catch (err) {
        console.error('[DB] Add supplier error:', err.message);
        return { success: false, error: err.message };
    }
}

async function getSupplierByPhone(phone) {
    if (!phone) return null;
    const p = getPool();
    try {
        const cleanPhone = phone.replace(/[^0-9]/g, '').slice(-10);
        const res = await p.query(
            `SELECT * FROM "Supplier" WHERE phone LIKE $1 OR alt_phone LIKE $1 LIMIT 1`,
            [`%${cleanPhone}%`]
        );
        return res.rows[0] || null;
    } catch (err) {
        console.error('[DB] Supplier lookup error:', err.message);
        return null;
    }
}

async function getAllSuppliers() {
    const p = getPool();
    try {
        const res = await p.query(`SELECT * FROM "Supplier" ORDER BY name`);
        return res.rows;
    } catch (err) {
        console.error('[DB] List suppliers error:', err.message);
        return [];
    }
}

async function createStockReceive(supplierName, supplierPhone, items, totalAmount, paidAmount, paymentMethod = 'CASH', notes = '') {
    const p = getPool();
    const id = `sr_${Date.now()}`;
    const refNumber = `SR${Date.now().toString(36).toUpperCase()}`;
    try {
        // Find or create supplier
        let supplierId = null;
        if (supplierPhone) {
            const existing = await p.query(`SELECT id FROM "Supplier" WHERE phone LIKE $1 LIMIT 1`, [`%${supplierPhone.replace(/[^0-9]/g, '').slice(-10)}%`]);
            if (existing.rows.length > 0) supplierId = existing.rows[0].id;
        }
        if (!supplierId && supplierName) {
            const newSup = await addSupplier(supplierName, supplierPhone || '', '', '', '', '');
            if (newSup.success) supplierId = newSup.id;
        }

        await p.query(
            `INSERT INTO "StockReceive" (id, ref_number, supplier_id, supplier_name, supplier_phone, items, total_amount, paid_amount, payment_method, status, notes, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'RECEIVED', $10, NOW(), NOW())`,
            [id, refNumber, supplierId || '', supplierName, supplierPhone, JSON.stringify(items), totalAmount, paidAmount, paymentMethod, notes]
        );

        // Update stock for each item
        for (const item of items) {
            await p.query(
                `UPDATE "Product" SET stock = stock + $1, updated_at = NOW() WHERE name ILIKE $2`,
                [item.quantity, item.name]
            );
        }

        return { success: true, id, refNumber, totalAmount, paidAmount, supplierName, supplierPhone };
    } catch (err) {
        console.error('[DB] Stock receive error:', err.message);
        return { success: false, error: err.message };
    }
}

async function getStockReceiveBySupplier(phone) {
    if (!phone) return [];
    const p = getPool();
    try {
        const cleanPhone = phone.replace(/[^0-9]/g, '').slice(-10);
        const res = await p.query(
            `SELECT * FROM "StockReceive" WHERE supplier_phone LIKE $1 ORDER BY created_at DESC LIMIT 5`,
            [`%${cleanPhone}%`]
        );
        return res.rows;
    } catch (err) {
        console.error('[DB] Stock receive lookup error:', err.message);
        return [];
    }
}

module.exports = { getPool, searchInventory, getCustomerBalance, getProductsByCategory, getAllCategories, getCustomerByPhone, createOrder, createWhatsAppOrder, getProductByName, getOrdersByPhone, getOverdueCustomers, getPopularProducts, getNewArrivals, getProductsByIds, addSupplier, getSupplierByPhone, getAllSuppliers, createStockReceive, getStockReceiveBySupplier };
