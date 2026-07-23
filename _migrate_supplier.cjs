const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech')
        ? { rejectUnauthorized: false } : false
});

(async () => {
    console.log('=== MIGRATION: Supplier & StockReceive ===\n');

    // 1. Supplier table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS "Supplier" (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            phone TEXT NOT NULL,
            alt_phone TEXT DEFAULT '',
            company TEXT DEFAULT '',
            address TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )
    `);
    console.log('✅ Supplier table created');

    // 2. StockReceive table (purchase orders / stock received)
    await pool.query(`
        CREATE TABLE IF NOT EXISTS "StockReceive" (
            id TEXT PRIMARY KEY,
            ref_number TEXT NOT NULL,
            supplier_id TEXT REFERENCES "Supplier"(id),
            supplier_name TEXT DEFAULT '',
            supplier_phone TEXT DEFAULT '',
            items JSONB DEFAULT '[]',
            total_amount NUMERIC DEFAULT 0,
            paid_amount NUMERIC DEFAULT 0,
            payment_method TEXT DEFAULT 'CASH',
            status TEXT DEFAULT 'RECEIVED',
            notes TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT NOW(),
            updated_at TIMESTAMP DEFAULT NOW()
        )
    `);
    console.log('✅ StockReceive table created');

    // Verify
    const tables = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('Supplier', 'StockReceive')"
    );
    console.log('\nVerified tables:', tables.rows.map(x => x.table_name).join(', '));

    await pool.end();
    console.log('\n=== DONE ===');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
