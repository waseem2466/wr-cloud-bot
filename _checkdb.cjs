const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech')
        ? { rejectUnauthorized: false } : false
});

(async () => {
    console.log('=== DATABASE CHECK ===\n');

    const tables = await pool.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    console.log('Tables:', tables.rows.map(x => x.table_name).join(', '));

    console.log('\n--- Product Table ---');
    const cnt = await pool.query('SELECT COUNT(*) as cnt FROM "Product"');
    console.log('Total products:', cnt.rows[0].cnt);

    const sample = await pool.query('SELECT name, price, stock, category FROM "Product" LIMIT 5');
    console.log('Sample:', JSON.stringify(sample.rows, null, 2));

    const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'Product' ORDER BY ordinal_position");
    console.log('Product columns:', cols.rows.map(r => r.column_name).join(', '));

    console.log('\n--- Customer Table ---');
    const custCnt = await pool.query('SELECT COUNT(*) as cnt FROM "Customer"');
    console.log('Total customers:', custCnt.rows[0].cnt);

    console.log('\n--- Bill Table ---');
    const billCnt = await pool.query('SELECT COUNT(*) as cnt FROM "Bill"');
    console.log('Total bills:', billCnt.rows[0].cnt);

    console.log('\n--- GroupProduct Table ---');
    try {
        const gpCnt = await pool.query('SELECT COUNT(*) as cnt FROM "GroupProduct"');
        console.log('Total group products:', gpCnt.rows[0].cnt);
    } catch (e) {
        console.log('GroupProduct table missing or empty');
    }

    console.log('\n--- Knowledge Table ---');
    try {
        const kCnt = await pool.query('SELECT COUNT(*) as cnt FROM "Knowledge"');
        console.log('Total knowledge entries:', kCnt.rows[0].cnt);
    } catch (e) {
        console.log('Knowledge table missing');
    }

    await pool.end();
    console.log('\n=== DONE ===');
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
