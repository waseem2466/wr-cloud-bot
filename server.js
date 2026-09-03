const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const dotenv = require('dotenv');
const http = require('http');
const path = require('path');

dotenv.config();

const AUTH_DIR = process.env.AUTH_DIR || path.join(process.cwd(), 'baileys_auth_info');
const AUTH_ZIP = process.env.AUTH_ZIP || path.join(process.cwd(), 'auth.bin');
const DEFAULT_AUTH_FOLDER = 'baileys_auth_info';
const SEND_API_SECRET = process.env.SEND_API_SECRET || '';
let activeSock = null;
let latestQR = null;  // Store latest QR for web display
let skipAuthRestore = false;  // Set true after /reset-auth to prevent re-extracting expired auth

function restoreAuthFromZip() {
    if (skipAuthRestore) { console.log('[Auth] Skipping zip restore (auth was reset)'); return; }
    if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) return;
    if (!fs.existsSync(AUTH_ZIP)) return;

    console.log(` Extracting ${AUTH_ZIP} to restore WhatsApp session...`);
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(AUTH_ZIP);
    const authParent = path.dirname(AUTH_DIR);
    const authBase = path.basename(AUTH_DIR);
    fs.mkdirSync(authParent, { recursive: true });

    zip.extractAllTo(authParent, true);

    const extractedDefaultDir = path.join(authParent, DEFAULT_AUTH_FOLDER);
    if (authBase !== DEFAULT_AUTH_FOLDER && fs.existsSync(extractedDefaultDir) && !fs.existsSync(AUTH_DIR)) {
        fs.renameSync(extractedDefaultDir, AUTH_DIR);
    }

    console.log(` Auth session restored at ${AUTH_DIR}!`);
}

// ═══════════ WhatsApp Session Persistence (survives Koyeb restarts) ═══════════
let lastCredsSave = 0;
const CREDS_SAVE_INTERVAL = 30000; // Debounce: max once per 30s

async function saveCredsToDB(credsJson) {
    try {
        const { getPool } = require('./dbHelper.cjs');
        const pool = getPool();
        await pool.query(
            `INSERT INTO "WhatsAppSession" (id, creds_json, updated_at)
             VALUES ('active_session', $1, NOW())
             ON CONFLICT (id) DO UPDATE SET creds_json = $1, updated_at = NOW()`,
            [JSON.stringify(credsJson)]
        );
        console.log('[Auth] WhatsApp session saved to Neon DB');
    } catch (e) {
        console.error('[Auth] Failed to save session to DB:', e.message);
    }
}

async function restoreCredsFromDB() {
    try {
        const { getPool } = require('./dbHelper.cjs');
        const pool = getPool();
        const res = await pool.query(
            `SELECT creds_json FROM "WhatsAppSession" WHERE id = 'active_session'`
        );
        if (res.rows.length > 0 && res.rows[0].creds_json) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
            fs.writeFileSync(
                path.join(AUTH_DIR, 'creds.json'),
                JSON.stringify(res.rows[0].creds_json, null, 2)
            );
            console.log('[Auth] WhatsApp session restored from Neon DB!');
            return true;
        }
    } catch (e) {
        console.error('[Auth] Failed to restore session from DB:', e.message);
    }
    return false;
}

function hasUsableMessageContent(msg) {
    return !!(
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.audioMessage ||
        msg.message?.documentMessage ||
        msg.message?.stickerMessage ||
        msg.message?.videoMessage ||
        msg.message?.orderMessage ||          // WhatsApp Catalog order
        msg.message?.productMessage ||        // Product shared from catalog
        msg.message?.interactiveResponseMessage || // Button/list reply
        msg.message?.listResponseMessage ||   // List selection reply
        msg.message?.buttonsResponseMessage   // Button reply
    );
}

async function transcribeAudio(buffer) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;

    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', buffer, 'audio.ogg');
    form.append('model', 'whisper-large-v3');
    form.append('language', 'en');

    try {
        const fetch = require('node-fetch');
        const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, ...form.getHeaders() },
            body: form
        });
        const data = await res.json();
        return data.text || null;
    } catch { return null; }
}

function sendWithTimeout(sock, jid, content, timeoutMs = 20000) {
    return Promise.race([
        sock.sendMessage(jid, content),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timed Out')), timeoutMs))
    ]);
}

const { handleOwnerCommand, isOwner } = require('./inventoryManager.cjs');
const { handleGroupMessage, isWatchedGroup, registerGroup } = require('./groupWatcher.cjs');
const { aiReply } = require('./aiReply.cjs');
const { detectIntent } = require('./intent.cjs');
const { handlePriceQuery, handleAvailabilityQuery, getProductDetails } = require('./productPriceHandler.cjs');
const { searchInventory, getCustomerBalance, getProductsByCategory, getAllCategories, getCustomerByPhone, createWhatsAppOrder, getProductByName, getOrdersByPhone, getOverdueCustomers, getPopularProducts, getNewArrivals, addSupplier, getSupplierByPhone, getAllSuppliers, createStockReceive, getStockReceiveBySupplier } = require('./dbHelper.cjs');
const cartManager = require('./cartManager.cjs');
const wrPosApi = require('./wrPosApi.cjs');
const groupAdder = require('./groupAdder.cjs');

// Auto-migrate Supplier & StockReceive tables on startup
async function migrateSupplierTables() {
    try {
        const { getPool } = require('./dbHelper.cjs');
        const pool = getPool();
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
        // InvitedPhone table — permanent dedup for group invites (one person = one invite ever)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "InvitedPhone" (
                phone TEXT PRIMARY KEY,
                name TEXT DEFAULT '',
                source_group TEXT DEFAULT '',
                invited_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('[DB] Supplier, StockReceive & InvitedPhone tables ready');

        // WhatsAppSession — persist WhatsApp auth across container restarts
        await pool.query(`
            CREATE TABLE IF NOT EXISTS "WhatsAppSession" (
                id TEXT PRIMARY KEY DEFAULT 'active_session',
                creds_json JSONB NOT NULL,
                updated_at TIMESTAMP DEFAULT NOW()
            )
        `);
        console.log('[DB] WhatsAppSession table ready');
    } catch (e) {
        console.error('[DB] Migration error:', e.message);
    }
}
migrateSupplierTables();

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1024 * 1024) {
                reject(new Error('Request body too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            } catch {
                reject(new Error('Invalid JSON body'));
            }
        });
        req.on('error', reject);
    });
}

function sendJson(res, status, payload) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
    // API routes (/api/*)
    if (req.url.startsWith('/api/')) {
        try {
            const handled = await wrPosApi.handleRequest(req, res);
            if (handled) return;
        } catch (e) {
            console.error('[API] Error:', e.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
            return;
        }
    }

    // /ping — lightweight keep-alive for cron-job.org (prevents Koyeb sleep)
    if (req.url === '/ping') {
        return sendJson(res, 200, {
            pong: true,
            whatsapp: activeSock ? 'connected' : 'disconnected',
            uptime: Math.floor(process.uptime()) + 's'
        });
    }

    // /health — detailed health check endpoint
    if (req.url === '/health') {
        const uptimeSec = Math.floor(process.uptime());
        const hours = Math.floor(uptimeSec / 3600);
        const mins = Math.floor((uptimeSec % 3600) / 60);
        return sendJson(res, activeSock ? 200 : 503, {
            status: activeSock ? 'healthy' : 'degraded',
            whatsapp: activeSock ? 'connected' : 'disconnected',
            qrAvailable: !!latestQR,
            uptime: `${hours}h ${mins}m`,
            uptimeSeconds: uptimeSec,
            lastPing: new Date().toISOString(),
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB'
        });
    }

    // /status — debug endpoint
    if (req.url === '/status') {
        return sendJson(res, 200, {
            bot: 'WR POS Cloud Bot',
            whatsapp: activeSock ? 'connected' : 'disconnected',
            qrAvailable: !!latestQR,
            uptime: Math.floor(process.uptime()) + 's',
            time: new Date().toISOString()
        });
    }

    // /qr — scan QR directly from browser if auth fails
    if (req.url === '/qr') {
        if (activeSock) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2 style="color:green">✅ WhatsApp Already Connected!</h2><p>The bot is online and responding.</p></body></html>');
        }
        if (!latestQR) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2>⏳ Generating QR...</h2><p>Refresh in 10 seconds.</p><script>setTimeout(()=>location.reload(),10000)</script></body></html>');
        }
        // Generate QR as data URL using qrcode
        try {
            const QRCode = require('qrcode');
            const qrDataUrl = await QRCode.toDataURL(latestQR, { width: 350, margin: 2 });
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end(`<html><head><title>WR POS Bot QR</title></head><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0f0f1a;color:white">
<h2 style="color:#25D366">📱 Scan to Activate WhatsApp Bot</h2>
<p style="color:#aaa">WhatsApp → ⋮ → Linked Devices → Link a Device</p>
<img src="${qrDataUrl}" style="border-radius:16px;padding:12px;background:white;width:300px" />
<p style="color:#888;font-size:12px">QR refreshes every 60s. If expired, reload this page.</p>
<script>setTimeout(()=>location.reload(),60000)</script>
</body></html>`);
        } catch(e) {
            return sendJson(res, 500, { error: 'QR generation failed: ' + e.message });
        }
    }

    // /reset-auth — clear old auth and force fresh QR
    if (req.url === '/reset-auth') {
        try {
            console.log('[Auth] Resetting auth session for fresh QR...');
            activeSock = null;
            latestQR = null;
            skipAuthRestore = true;  // Prevent restoreAuthFromZip from re-extracting expired auth
            // Delete auth folder contents
            if (fs.existsSync(AUTH_DIR)) {
                const files = fs.readdirSync(AUTH_DIR);
                for (const f of files) {
                    try { fs.unlinkSync(path.join(AUTH_DIR, f)); } catch(e) {}
                }
                console.log(`[Auth] Cleared ${files.length} auth files from ${AUTH_DIR}`);
            }
            // Restart connection to generate fresh QR
            setTimeout(connectToWhatsApp, 1000);
            res.writeHead(200, { 'Content-Type': 'text/html' });
            return res.end('<html><body style="font-family:sans-serif;text-align:center;padding:40px"><h2 style="color:orange">🔄 Auth Reset!</h2><p>Generating fresh QR code...</p><p><a href="/qr">Go to QR page</a> (wait 10 seconds)</p><script>setTimeout(()=>location.href="/qr",10000)</script></body></html>');
        } catch(e) {
            return sendJson(res, 500, { error: 'Reset failed: ' + e.message });
        }
    }

    // /send endpoint for WhatsApp relay
    if (req.method === 'POST' && req.url === '/send') {
        try {
            if (!SEND_API_SECRET) return sendJson(res, 503, { success: false, error: 'SEND_API_SECRET is not configured' });
            const auth = req.headers.authorization || '';
            if (auth !== `Bearer ${SEND_API_SECRET}`) return sendJson(res, 401, { success: false, error: 'Unauthorized' });
            if (!activeSock) return sendJson(res, 503, { success: false, error: 'WhatsApp is not connected yet' });

            const payload = await readJsonBody(req);
            const to = String(payload.to || '').replace(/[^0-9]/g, '');
            const message = String(payload.message || '');
            if (!to || !message) return sendJson(res, 400, { success: false, error: 'to and message are required' });

            const jid = `${to}@s.whatsapp.net`;
            const content = payload.documentUrl
                ? {
                    document: { url: payload.documentUrl },
                    mimetype: 'application/pdf',
                    fileName: payload.documentName || 'invoice.pdf',
                    caption: message
                }
                : { text: message };
            const result = await sendWithTimeout(activeSock, jid, content);
            return sendJson(res, 200, { success: true, id: result?.key?.id || null });
        } catch (error) {
            console.error('[Send API] Error:', error.message);
            return sendJson(res, 500, { success: false, error: error.message });
        }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WR POS Cloud Bot is running!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(` Cloud Health Server running on port ${PORT}`);
});

// ═══════════ Self-Ping Keep-Alive (prevents Koyeb free tier sleep) ═══════════
const SELF_PING_INTERVAL = 4 * 60 * 1000; // Every 4 minutes
let selfPingCount = 0;

function startSelfPing() {
    setInterval(async () => {
        selfPingCount++;
        try {
            // Internal self-ping via HTTP to keep the process alive
            const pingUrl = `http://localhost:${PORT}/ping`;
            const resp = await new Promise((resolve, reject) => {
                const req = http.get(pingUrl, (res) => {
                    let data = '';
                    res.on('data', (chunk) => data += chunk);
                    res.on('end', () => resolve({ status: res.statusCode, data }));
                });
                req.on('error', reject);
                req.setTimeout(10000, () => { req.destroy(); reject(new Error('Self-ping timeout')); });
            });
            if (selfPingCount % 15 === 0) { // Log every ~1 hour (15 × 4min = 60min)
                console.log(`[KeepAlive] Self-ping #${selfPingCount} OK — WhatsApp: ${activeSock ? 'connected' : 'disconnected'}, uptime: ${Math.floor(process.uptime())}s`);
            }
        } catch (e) {
            console.error(`[KeepAlive] Self-ping #${selfPingCount} failed:`, e.message);
        }
    }, SELF_PING_INTERVAL);
    console.log(`[KeepAlive] Self-ping started — every ${SELF_PING_INTERVAL / 1000}s to prevent container sleep`);
}

// Start self-ping after a short delay to ensure server is ready
setTimeout(startSelfPing, 5000);

const STOP_WORDS = new Set(['i','a','an','the','is','it','am','to','for','of','in','on','at','by','with','and','or','but','not','do','does','did','have','has','had','can','will','want','need','buy','get','some','please','me','my','you','your','how','much','what','which','where','who','are','this','that','there','here','all','any','each','every','just','now','also','very','too','was','were','been','being','would','could','should','may','might','shall','got','know','like','say','tell','ask','help','check','see','look','give','take','use','make','come','going','out','up','down','off','over','about','than','then','then','price','rate','cost','stock','available','hello','hi','hey','thanks','thank','bye']);

// Per-chat pagination state: chatJid → { category, page, totalPages, products }
const catalogState = new Map();
const CATALOG_PAGE_SIZE = 10;

function extractKeywords(text) {
    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
    return [...new Set(words)];
}

async function buildInventoryContext(text) {
    try {
        const keywords = extractKeywords(text);
        if (keywords.length === 0) return '';
        const results = new Map();
        for (const word of keywords.slice(0, 5)) {
            const products = await searchInventory(word);
            for (const p of products) {
                let target = results.get(p.name);
                if (!target || p.stock > target.stock) results.set(p.name, p);
            }
        }
        if (results.size === 0) return '';
        const wantsExactQty = /\b(how many|count|pieces|pcs|quantity|qty|units|bulk)\b/i.test(text);
        return [...results.values()].slice(0, 5)
            .map(p => `- ${p.name}: Rs. ${p.price} (${p.stock > 0 ? (wantsExactQty ? `${p.stock} in stock` : 'In Stock') : 'Out of Stock'}) [${p.category || 'general'}]`)
            .join('\n');
    } catch { return ''; }
}

async function buildFinancialContext(customer, phone) {
    try {
        let c = customer;
        let balance = null;
        if (!c && phone) balance = await getCustomerBalance(phone);
        const name = c?.name || balance?.name;
        if (!name) return '';
        const total = c ? c.totalBalance : balance.totalBalance;
        const paid = c ? c.paidAmount : balance.paidAmount;
        const outstanding = c ? c.outstandingBalance : balance.outstandingBalance;
        // Pull recent invoice history to impress the customer with real POS data
        let recentOrders = '';
        try {
            const p = require('./dbHelper.cjs').getPool ? require('./dbHelper.cjs').getPool() : null;
            if (p) {
                const res = await p.query(
                    `SELECT b.total, b.created_at FROM "Bill" b JOIN "Customer" cu ON b.customer_id = cu.id WHERE cu.phone = $1 ORDER BY b.created_at DESC LIMIT 3`,
                    [String(phone).replace(/[^0-9]/g, '')]
                );
                if (res.rows.length) {
                    recentOrders = 'Recent invoices:\n' + res.rows.map(r =>
                        `  - Rs. ${r.total} on ${new Date(r.created_at).toLocaleDateString('en-LK')}`
                    ).join('\n');
                }
            }
        } catch {}
        return `Customer: ${name}\nTotal credit: Rs. ${total}\nAlready paid: Rs. ${paid}\nOutstanding balance: Rs. ${outstanding}\n${recentOrders}`;
    } catch { return ''; }
}

function extractPhoneFromJid(jid) {
    if (!jid) return null;
    return jid.replace(/@.*$/, '').replace(/[^0-9]/g, '');
}

const REMINDER_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours
const knownContacts = new Set();

async function startPaymentReminders(sock) {
    if (global._paymentRemindersStarted) return;
    global._paymentRemindersStarted = true;
    console.log('[Reminder] Payment reminder scheduler started (every 12h)');
    const run = async () => {
        try {
            const overdue = await getOverdueCustomers();
            for (const c of overdue) {
                const phone = c.phone?.replace(/[^0-9]/g, '');
                if (!phone) continue;
                const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
                if (!knownContacts.has(jid)) {
                    continue;
                }
                const msg = `🔔 *Payment Reminder*\n\nHi ${c.name}, you have an outstanding balance of *Rs. ${c.outstandingBalance}*.\nPaid: Rs. ${c.paidAmount} of Rs. ${c.totalBalance}\n\nPlease settle soon. Bank transfer or in-store. 🏦`;
                try {
                    await sendWithTimeout(sock, jid, { text: msg });
                    console.log(`[Reminder] Sent to ${c.name} (${phone})`);
                    await new Promise(r => setTimeout(r, 2000));
                } catch (e) {
                    console.error(`[Reminder] Failed for ${phone}: ${e.message}`);
                }
            }
        } catch (e) {
            console.error('[Reminder] Error:', e.message);
        }
    };
    setInterval(run, REMINDER_INTERVAL);
}

// ═══════════ ONCE-A-DAY STOCK & BUSINESS DIGEST (Strictly 1x per day at 8:00 PM) ═══════════
let lastDigestDate = '';

async function sendDailyDigest(sock, force = false) {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });
    if (!force && lastDigestDate === todayStr) {
        console.log(`[Digest] Already sent today's digest (${todayStr}). Skipping.`);
        return;
    }

    try {
        const p = require('./dbHelper.cjs').getPool ? require('./dbHelper.cjs').getPool() : null;
        if (!p) { console.log('[Digest] DB Pool not ready'); return; }

        const LOW_STOCK_THRESHOLD = parseInt(process.env.LOW_STOCK_THRESHOLD || '5');
        const twentyFourH = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

        const [bills, newCustomers, lowStockRes, topProductsRes, totalProductsRes] = await Promise.all([
            p.query(`SELECT COUNT(*) as cnt, COALESCE(SUM(total), 0) as rev FROM "Bill" WHERE created_at >= $1`, [twentyFourH]),
            p.query(`SELECT COUNT(*) as cnt FROM "Customer" WHERE created_at >= $1`, [twentyFourH]),
            p.query(`SELECT name, stock, price, category FROM "Product" WHERE stock <= $1 ORDER BY stock ASC LIMIT 10`, [LOW_STOCK_THRESHOLD]),
            p.query(`SELECT name, stock, price FROM "Product" ORDER BY stock DESC LIMIT 5`),
            p.query(`SELECT COUNT(*) as total_items, COALESCE(SUM(stock), 0) as total_units FROM "Product"`)
        ]);

        const orderCount = bills.rows[0]?.cnt || '0';
        const revenue = Number(bills.rows[0]?.rev || 0);
        const newCust = newCustomers.rows[0]?.cnt || '0';
        const lowStockItems = lowStockRes.rows || [];
        const totalItems = totalProductsRes.rows[0]?.total_items || '0';
        const totalUnits = totalProductsRes.rows[0]?.total_units || '0';
        const now = new Date().toLocaleString('en-LK', { timeZone: 'Asia/Colombo' });

        let lowStockSection = '✅ *Stock Health:* All items healthy';
        if (lowStockItems.length > 0) {
            lowStockSection = `⚠️ *Low Stock Items (≤${LOW_STOCK_THRESHOLD} units):*\n` +
                lowStockItems.map((r, i) => `  ${i + 1}. ${r.name} — *${r.stock} left* (Rs. ${r.price})`).join('\n');
        }

        const digest = `📊 *DAILY INVENTORY & BUSINESS DIGEST*\n━━━━━━━━━━━━━━━━━━━━━━━━━━\n📅 ${now}\n\n🧾 *Orders Today:* ${orderCount}\n💰 *Revenue:* Rs. ${revenue.toLocaleString()}\n👥 *New Customers:* ${newCust}\n📦 *Catalog:* ${totalItems} SKUs (${totalUnits} total units)\n\n${lowStockSection}\n\n🤖 *WR POS Bot:* Active & Online`;

        const ownerJids = ['94719336848@s.whatsapp.net', '94779336848@s.whatsapp.net'];
        for (const oj of ownerJids) {
            try { await sendWithTimeout(sock, oj, { text: digest }); } catch (e) {}
        }
        lastDigestDate = todayStr;
        console.log(`[Digest] Sent once-daily summary for ${todayStr}`);
    } catch (e) {
        console.error('[Digest] Error generating daily digest:', e.message);
    }
}

async function startOnceDailyDigest(sock) {
    if (global._dailyDigestSchedulerStarted) return;
    global._dailyDigestSchedulerStarted = true;

    console.log('[Digest] Once-daily digest scheduler started (Daily at 8:00 PM SL time)');

    function scheduleNextRun() {
        const now = new Date();
        const slDateStr = now.toLocaleDateString('en-US', { timeZone: 'Asia/Colombo' });
        const target = new Date(slDateStr);
        target.setHours(20, 0, 0, 0); // 8:00 PM

        let delay = target.getTime() - now.getTime();
        if (delay <= 0) {
            target.setDate(target.getDate() + 1);
            delay = target.getTime() - now.getTime();
        }

        setTimeout(async () => {
            if (activeSock) await sendDailyDigest(activeSock);
            scheduleNextRun();
        }, delay);
    }

    scheduleNextRun();
}

async function startAutoBackup(sock) {
    if (global._autoBackupSchedulerStarted) return;
    global._autoBackupSchedulerStarted = true;

    console.log('[Backup] Auto-backup scheduler started (daily at 3 AM SL time)');
    const TABLES = ['Product', 'Customer', 'Bill', 'BillItem', 'GroupProduct'];
    const run = async () => {
        try {
            const p = require('./dbHelper.cjs').getPool ? require('./dbHelper.cjs').getPool() : null;
            if (!p) { console.log('[Backup] Pool not ready'); return; }
            const backup = {};
            let totalRows = 0;
            for (const table of TABLES) {
                const res = await p.query(`SELECT COUNT(*) as cnt FROM "${table}"`);
                const cnt = parseInt(res.rows[0]?.cnt || 0);
                backup[table] = cnt;
                totalRows += cnt;
            }
            const ownerJids = ['94719336848@s.whatsapp.net', '94779336848@s.whatsapp.net'];
            const msg = `💾 *Daily Backup Complete*\n\n📦 ${TABLES.map(t => `${t}: ${backup[t]}`).join('\n')}\n\n📊 Total rows: ${totalRows}\n✅ Database is healthy.`;
            for (const oj of ownerJids) {
                try { await sendWithTimeout(sock, oj, { text: msg }); } catch(e) {}
            }
            console.log(`[Backup] Sent backup summary (${totalRows} total rows)`);
        } catch (e) {
            console.error('[Backup] Error:', e.message);
        }
    };
    const now = new Date();
    const next3AM = new Date(now);
    next3AM.setDate(now.getDate() + 1);
    next3AM.setHours(3, 0, 0, 0);
    setTimeout(() => { run(); setInterval(run, 24 * 60 * 60 * 1000); }, next3AM - now);
}

// ═══════════ PRODUCT IMAGE UPLOAD (via WhatsApp) ═══════════
async function handleProductImageUpload(sock, senderJid, msg) {
    try {
        const imageMsg = msg.message?.imageMessage;
        if (!imageMsg) return false;
        const caption = imageMsg.caption || '';
        // Format: "image [product name]" or just "image" with reply to product message
        const match = caption.match(/^image\s+(.+)/i);
        if (!match && !caption.toLowerCase().startsWith('image')) return false;
        const productName = match ? match[1].trim() : '';
        if (!productName) return false;
        // Download image
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
        let messageToDownload = msg;
        if (!imageMsg.url && sock?.updateMediaMessage) {
            messageToDownload = await sock.updateMediaMessage(msg);
        }
        const buffer = await downloadMediaMessage(messageToDownload, 'buffer', {});
        if (!buffer || buffer.length === 0) return false;
        // Upload to catbox.moe (free image hosting)
        const FormData = require('form-data');
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', buffer, { filename: 'product.jpg', contentType: 'image/jpeg' });
        const uploadRes = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form });
        const imageUrl = await uploadRes.text();
        if (!imageUrl || !imageUrl.startsWith('http')) return false;
        // Update product in DB
        const p = require('./dbHelper.cjs').getPool();
        await p.query(`UPDATE "Product" SET image_url = $1, updated_at = NOW() WHERE name ILIKE $2`, [imageUrl, `%${productName}%`]);
        await sendWithTimeout(sock, senderJid, { text: `✅ *Image uploaded!*\n\nProduct: ${productName}\nImage: ${imageUrl}` });
        console.log(`[Image] Uploaded image for "${productName}"`);
        return true;
    } catch (e) {
        console.error('[Image] Upload error:', e.message);
        return false;
    }
}

async function connectToWhatsApp() {
    console.log('Starting WR POS Cloud WhatsApp Bot...');
    console.log(`[WhatsApp] Auth directory: ${AUTH_DIR}`);

    // Priority 1: DB persistence (survives Koyeb restarts)
    if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
        console.log('[Auth] No local creds.json — trying Neon DB restore...');
        await restoreCredsFromDB();
    }

    // Priority 2: Fallback to auth.bin zip
    restoreAuthFromZip();

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    // Debounced cred save — local file + Neon DB
    sock.ev.on('creds.update', async (creds) => {
        saveCreds();
        const now = Date.now();
        if (now - lastCredsSave > CREDS_SAVE_INTERVAL) {
            lastCredsSave = now;
            try {
                const credsPath = path.join(AUTH_DIR, 'creds.json');
                if (fs.existsSync(credsPath)) {
                    const credsJson = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
                    await saveCredsToDB(credsJson);
                }
            } catch (e) {
                console.error('[Auth] Debounced DB save error:', e.message);
            }
        }
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            latestQR = qr;  // Store for /qr web endpoint
            console.log('\n=========================================');
            console.log(' QR READY — visit /qr to scan from browser ');
            console.log('=========================================\n');
        }
        if (connection === 'close') {
            console.error('Disconnect Reason:', lastDisconnect?.error);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isConflict = statusCode === 440;
            const isUnauthorized = statusCode === 401;
            const shouldReconnect = !isUnauthorized && statusCode !== DisconnectReason.loggedOut;
            if (isConflict) console.warn('[WhatsApp] Conflict — another device connected, retrying in 10s...');
            if (isUnauthorized) {
                console.error('[WhatsApp] Unauthorized (401) — clearing old auth for fresh QR...');
                skipAuthRestore = true;  // Don't restore from auth.bin again
                // Clear stale session from DB too
                try {
                    const { getPool } = require('./dbHelper.cjs');
                    await getPool().query(`DELETE FROM "WhatsAppSession" WHERE id = 'active_session'`);
                    console.log('[Auth] Cleared session from Neon DB');
                } catch(e) {}
                try {
                    if (fs.existsSync(AUTH_DIR)) {
                        const files = fs.readdirSync(AUTH_DIR);
                        for (const f of files) {
                            try { fs.unlinkSync(path.join(AUTH_DIR, f)); } catch(e) {}
                        }
                        console.log(`[Auth] Cleared ${files.length} auth files for fresh start`);
                    }
                } catch(e) { console.error('[Auth] Clear failed:', e.message); }
                // Reconnect after a short delay to generate fresh QR
                setTimeout(connectToWhatsApp, 5000);
            } else if (shouldReconnect) {
                setTimeout(connectToWhatsApp, isConflict ? 10000 : 3000);
            }
        } else if (connection === 'open') {
            console.log(' Connected to WhatsApp successfully!');
            activeSock = sock;
            latestQR = null;  // Clear QR since we're connected
            startPaymentReminders(sock);
            startAutoBackup(sock);
            startOnceDailyDigest(sock);

            // ═══════════ WhatsApp Connection Watchdog ═══════════
            // Check every 5 min if WA socket is still alive, auto-reconnect if zombie
            if (!global._waWatchdogRunning) {
                global._waWatchdogRunning = true;
                setInterval(() => {
                    try {
                        if (activeSock && activeSock.ws) {
                            const wsState = activeSock.ws.readyState;
                            // WebSocket states: 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
                            if (wsState !== 1) {
                                console.error(`[Watchdog] WhatsApp WebSocket is dead (state=${wsState}), reconnecting...`);
                                activeSock = null;
                                setTimeout(connectToWhatsApp, 3000);
                            }
                        } else if (!activeSock) {
                            console.warn('[Watchdog] No active WhatsApp socket, attempting reconnect...');
                            setTimeout(connectToWhatsApp, 3000);
                        }
                    } catch (e) {
                        console.error('[Watchdog] Check error:', e.message);
                    }
                }, 5 * 60 * 1000); // Every 5 minutes
                console.log('[Watchdog] WhatsApp connection watchdog started');
            }
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;
            if (!msg.message || !hasUsableMessageContent(msg)) {
                console.warn(`[WhatsApp] Ignoring empty/undecrypted message from ${msg.key.remoteJid || 'unknown'}. If this repeats, refresh the linked-device auth session.`);
                continue;
            }

            let text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';

            const isGroup = msg.key.remoteJid?.endsWith('@g.us');
            const senderJid = isGroup ? (msg.key.participant || msg.key.remoteJid) : msg.key.remoteJid;
            const replyTo = msg.key.remoteJid;

            if (!senderJid || senderJid === 'status@broadcast' || replyTo === 'status@broadcast') continue;
            const orderMsg = msg.message?.orderMessage;
            if (orderMsg && !isGroup) {
                knownContacts.add(senderJid);
                try {
                    const products = orderMsg.products || [];
                    const token = orderMsg.token || '';
                    const currency = orderMsg.currency || 'LKR';
                    let orderTotal = 0;
                    let orderLines = products.map(p => {
                        const price = (p.retailerProductId || '') ? `Rs. ${(p.price / 1000).toFixed(2)}` : 'N/A';
                        const lineTotal = p.price ? (p.price / 1000) * p.quantity : 0;
                        orderTotal += lineTotal;
                        return `• ${p.name} × ${p.quantity} — ${price}`;
                    }).join('\n');

                    // Try to save as an order in the DB
                    const customerPhone = extractPhoneFromJid(senderJid);
                    const customer = await getCustomerByPhone(customerPhone).catch(() => null);
                    const customerName = customer?.name || `Customer (${customerPhone})`;

                    const confirmMsg = `🛒 *New Catalog Order Received!*\n\n` +
                        `👤 From: ${customerName}\n` +
                        `📦 Items:\n${orderLines}\n\n` +
                        `💰 Est. Total: Rs. ${orderTotal.toFixed(2)}\n\n` +
                        `✅ Thank you! We'll confirm your order shortly.\n` +
                        `📞 Questions? Call us anytime.`;

                    await sendWithTimeout(sock, replyTo, { text: confirmMsg }, { quoted: msg });

                    // Notify owner
                    const ownerJid = '94719336848@s.whatsapp.net';
                    const ownerAlert = `🛍️ *CATALOG ORDER*\n\n👤 ${customerName} (${customerPhone})\n\n${orderLines}\n\n💰 Total: Rs. ${orderTotal.toFixed(2)}`;
                    await sendWithTimeout(sock, ownerJid, { text: ownerAlert }).catch(() => {});

                    console.log(`[Catalog] Order from ${customerPhone}: ${products.length} items, Rs. ${orderTotal.toFixed(2)}`);
                } catch(e) {
                    console.error('[Catalog] Order error:', e.message);
                    await sendWithTimeout(sock, replyTo, { text: '✅ Order received! We will contact you soon.' }, { quoted: msg });
                }
                continue;
            }

            // ── WhatsApp Product SHARE handler ──────────────────────────────
            const productMsg = msg.message?.productMessage;
            if (productMsg && !isGroup) {
                knownContacts.add(senderJid);
                const product = productMsg.product;
                const pName = product?.title || product?.name || 'this product';
                const pPrice = product?.priceAmount1000 ? `Rs. ${(product.priceAmount1000 / 1000).toFixed(2)}` : '';
                const reply = `🏷️ *${pName}*${pPrice ? `\n💰 Price: ${pPrice}` : ''}\n\nInterested? Reply *yes* to order or ask us anything!`;
                await sendWithTimeout(sock, replyTo, { text: reply }, { quoted: msg });
                console.log(`[Catalog] Product share: ${pName}`);
                continue;
            }

            // ── Button / List REPLY handler ──────────────────────────────────
            const listReply = msg.message?.listResponseMessage;
            const btnReply = msg.message?.buttonsResponseMessage;
            const interactiveReply = msg.message?.interactiveResponseMessage;
            if (listReply || btnReply || interactiveReply) {
                const selectedTitle = listReply?.title || btnReply?.selectedDisplayText || interactiveReply?.nativeFlowResponseMessage?.paramsJson || '';
                if (selectedTitle) text = selectedTitle;
            }
            // ─────────────────────────────────────────────────────────────────

            if (!text) {
                if (msg.message?.audioMessage && !isGroup) {
                    knownContacts.add(senderJid);
                    try {
                        const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                        const buffer = await downloadMediaMessage(msg, 'buffer', {});
                        const transcript = await transcribeAudio(buffer);
                        if (transcript) {
                            console.log(`[Voice] Transcribed: "${transcript}" from ${senderJid}`);
                            // Fall through to normal processing with transcribed text
                            text = transcript;
                        } else {
                            await sock.sendMessage(replyTo, { text: `🎤 I couldn't understand that. Please type or send a photo.` }, { quoted: msg });
                            continue;
                        }
                    } catch(e) { 
                        await sock.sendMessage(replyTo, { text: `🎤 Voice processing failed. Please type your message.` }, { quoted: msg });
                        continue; 
                    }
                } else if (msg.message?.documentMessage && !isGroup) {
                    knownContacts.add(senderJid);
                    if (isOwner(senderJid)) {
                        try {
                            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
                            const buffer = await downloadMediaMessage(msg, 'buffer', {});
                            const fileName = msg.message.documentMessage.fileName;
                            const content = buffer.toString('utf-8');
                            const { saveToDb } = require('./knowledgeBrain.cjs');
                            const result = await saveToDb(fileName, content, 'Uploaded');
                            await sock.sendMessage(replyTo, { text: result.success ? `🧠 *Knowledge Saved!* I learned from "${fileName}".` : `⚠️ Failed: ${result.error}` });
                        } catch(e) { await sock.sendMessage(replyTo, { text: `⚠️ Could not read document.` }); }
                    }
                    continue;
                } else if (msg.message?.stickerMessage || msg.message?.videoMessage) {
                    continue;
                }
            }

            console.log(`[Message] from ${senderJid}: "${text}"`);

            // ============ GROUP ============
            if (isGroup) {
                const groupJid = msg.key.remoteJid;
                const groupName = msg.pushName || '';

                // Target group = "smile and supplies" (where admins post product updates)
                const targetGroup = (process.env.TARGET_GROUP || 'smile and supplies').toLowerCase();
                const isTargetGroup = groupName.toLowerCase().includes(targetGroup);

                // Source groups = "cargills food city kanthale 1" etc. (for member extraction only)
                const sourceGroups = (process.env.WATCHED_GROUPS || '').split(',').map(g => g.trim().toLowerCase());
                const isSourceGroup = sourceGroups.some(sg => groupName.toLowerCase().includes(sg)) && !groupName.toLowerCase().includes('smile');

                if (isTargetGroup) {
                    // TARGET GROUP: Only admins can post product updates
                    const isGroupSenderAdmin = isOwner(senderJid) || ['0779336848', '0750204698', '0750204698'].some(n => senderJid?.includes(n));
                    if (isGroupSenderAdmin) {
                        await handleGroupMessage(msg, sock, true);
                        console.log(`[Group] Admin product saved to main inventory from: ${senderJid}`);
                    } else {
                        console.log(`[Group] Non-admin message in target group ignored: ${senderJid}`);
                    }
                } else if (isSourceGroup) {
                    // SOURCE GROUP: Only queue invites, NO product extraction
                    if (!isOwner(senderJid)) {
                        const result = await groupAdder.queueInvite(sock, senderJid, msg.pushName);
                        if (result.success) {
                            console.log(`[GroupInviter] Queued ${msg.pushName || senderJid} from "${groupName}"`);
                        } else {
                            console.log(`[GroupInviter] Skipped ${senderJid}: ${result.reason}`);
                        }
                    }
                } else {
                    // OTHER GROUPS: Ignore completely (no extraction, no invites)
                    console.log(`[Group] Ignored message from unknown group: ${groupName}`);
                }
                continue;
            }

            // ============ DM ============
            knownContacts.add(senderJid);

            // Handle image uploads for product images (owner only)
            if (isOwner(senderJid) && msg.message?.imageMessage) {
                const imageHandled = await handleProductImageUpload(sock, senderJid, msg);
                if (imageHandled) continue;
            }

            // Owner commands
            if (isOwner(senderJid)) {
                const intent = detectIntent(text);
                if (intent.startsWith('OWNER_')) {
                    const result = await handleOwnerCommand(senderJid, text);
                    if (result.handled && result.reply) {
                        await sock.sendMessage(replyTo, { text: result.reply }, { quoted: msg });
                        continue;
                    }
                }

                // Owner: extract members from source groups
                if (/\b(extract|invite|bulk invite|add all|get members)\b/i.test(text)) {
                    const sourceGroups = (process.env.WATCHED_GROUPS || '').split(',').map(g => g.trim().toLowerCase());
                    let totalQueued = 0;
                    for (const [jid, name] of knownGroups) {
                        const isSource = sourceGroups.some(sg => name.toLowerCase().includes(sg)) && !name.toLowerCase().includes('smile');
                        if (isSource) {
                            const result = await groupAdder.extractAndInvite(sock, jid, name);
                            if (result.success) {
                                totalQueued += result.eligible;
                                await sock.sendMessage(replyTo, { text: `📋 *${name}*\nMembers: ${result.totalMembers}\nEligible: ${result.eligible}\nQueued for invite: ${result.queued}` });
                            }
                        }
                    }
                    if (totalQueued > 0) {
                        const stats = groupAdder.getStats();
                        await sock.sendMessage(replyTo, { text: `✅ *Invite queue ready!*\n\nTotal queued: ${totalQueued}\nDaily limit: ${stats.dailyLimit}\nWill take ~${Math.ceil(totalQueued * 0.75)} minutes\n\nBot will send DMs automatically with 35-60s delays.` });
                    } else {
                        await sock.sendMessage(replyTo, { text: `No source groups found. Check WATCHED_GROUPS env var.` });
                    }
                    continue;
                }

                // Owner: check invite stats
                if (/\b(invite stats|invite status|how many invites)\b/i.test(text)) {
                    const stats = groupAdder.getStats();
                    await sock.sendMessage(replyTo, { text: `📊 *Invite Stats*\n\nSent today: ${stats.sentToday}/${stats.dailyLimit}\nRemaining: ${stats.remaining}\nPending queue: ${stats.pending}\nProcessing: ${stats.isProcessing ? 'Yes' : 'No'}\nTotal invited (all-time): ${stats.totalInvited}` });
                    continue;
                }

                // Owner: add supplier — "add supplier ABC Traders 0771234567 Cargills"
                if (/\b(add supplier|add vendor|new supplier|new vendor)\b/i.test(text)) {
                    const match = text.match(/(?:add supplier|add vendor|new supplier|new vendor)\s+(.+)/i);
                    if (match) {
                        const parts = match[1].trim().split(/\s+/);
                        const name = parts[0] || '';
                        const phone = parts[1] || '';
                        const company = parts.slice(2).join(' ') || '';
                        if (name && phone) {
                            const result = await addSupplier(name, phone, '', company);
                            if (result.success) {
                                await sock.sendMessage(replyTo, { text: `✅ *Supplier Added!*\n\nName: ${result.name}\nPhone: ${result.phone}\nID: ${result.id}` });
                            } else {
                                await sock.sendMessage(replyTo, { text: `❌ Error: ${result.error}` });
                            }
                        } else {
                            await sock.sendMessage(replyTo, { text: `Usage: *add supplier [name] [phone] [company]*\nExample: add supplier ABC Traders 0771234567 Cargills` });
                        }
                    } else {
                        await sock.sendMessage(replyTo, { text: `Usage: *add supplier [name] [phone] [company]*` });
                    }
                    continue;
                }

                // Owner: list suppliers
                if (/\b(list suppliers|all suppliers|show suppliers|suppliers list)\b/i.test(text)) {
                    const suppliers = await getAllSuppliers();
                    if (suppliers.length > 0) {
                        const reply = '📋 *Suppliers*\n\n' + suppliers.map((s, i) =>
                            `${i + 1}. ${s.name} — ${s.phone}${s.company ? ' (' + s.company + ')' : ''}`
                        ).join('\n');
                        await sock.sendMessage(replyTo, { text: reply });
                    } else {
                        await sock.sendMessage(replyTo, { text: 'No suppliers yet. Add one with: *add supplier [name] [phone]*' });
                    }
                    continue;
                }

                // Owner: get supplier — "get supplier ABC" or "supplier 0771234567"
                if (/\b(get supplier|supplier info|show supplier|who is supplier)\b/i.test(text)) {
                    const match = text.match(/(?:get supplier|supplier info|show supplier|who is supplier)\s+(.+)/i);
                    if (match) {
                        const query = match[1].trim();
                        const supplier = await getSupplierByPhone(query);
                        if (supplier) {
                            const stockHistory = await getStockReceiveBySupplier(supplier.phone);
                            let reply = `👤 *Supplier Details*\n\nName: ${supplier.name}\nPhone: ${supplier.phone}\nAlt Phone: ${supplier.alt_phone || 'N/A'}\nCompany: ${supplier.company || 'N/A'}\nAddress: ${supplier.address || 'N/A'}\nNotes: ${supplier.notes || 'N/A'}`;
                            if (stockHistory.length > 0) {
                                reply += '\n\n📦 *Recent Stock Received:*\n' + stockHistory.map((s, i) =>
                                    `${i + 1}. #${s.ref_number} — Rs. ${s.total_amount.toLocaleString()} (Paid: Rs. ${s.paid_amount.toLocaleString()}) — ${new Date(s.created_at).toLocaleDateString()}`
                                ).join('\n');
                            }
                            await sock.sendMessage(replyTo, { text: reply });
                        } else {
                            await sock.sendMessage(replyTo, { text: `Supplier not found for "${query}". Use *list suppliers* to see all.` });
                        }
                    } else {
                        await sock.sendMessage(replyTo, { text: `Usage: *get supplier [name or phone]*` });
                    }
                    continue;
                }

                // Owner: stock receive — "stock receive [supplier] [phone] [item1 qty price, item2 qty price] [total paid]"
                if (/\b(stock receive|received stock|receive stock|new stock|stock in)\b/i.test(text)) {
                    const match = text.match(/(?:stock receive|received stock|receive stock|new stock|stock in)\s+(.+)/i);
                    if (match) {
                        const parts = match[1].trim();
                        // Format: "supplier phone item1 qty price, item2 qty price total paid"
                        const phoneMatch = parts.match(/^(\S+)\s+(\d+)\s+/);
                        if (phoneMatch) {
                            const supplierName = phoneMatch[1];
                            const supplierPhone = phoneMatch[2];
                            const rest = parts.slice(phoneMatch[0].length);
                            // Parse items: "rice 10 250, oil 5 500 total 3500 paid 3500"
                            const itemMatches = rest.match(/(\w+)\s+(\d+)\s+(\d+)/g) || [];
                            const totalMatch = rest.match(/total\s+(\d+)/i);
                            const paidMatch = rest.match(/paid\s+(\d+)/i);
                            const items = itemMatches.map(m => {
                                const [, name, qty, price] = m.match(/(\w+)\s+(\d+)\s+(\d+)/);
                                return { name, quantity: parseInt(qty), price: parseInt(price) };
                            });
                            const totalAmount = totalMatch ? parseInt(totalMatch[1]) : items.reduce((s, i) => s + (i.quantity * i.price), 0);
                            const paidAmount = paidMatch ? parseInt(paidMatch[1]) : totalAmount;

                            if (items.length > 0) {
                                const result = await createStockReceive(supplierName, supplierPhone, items, totalAmount, paidAmount);
                                if (result.success) {
                                    // Send receipt to supplier
                                    const itemLines = items.map(i => `• ${i.name} x ${i.quantity} @ Rs. ${i.price} = Rs. ${(i.quantity * i.price).toLocaleString()}`).join('\n');
                                    const receipt = `📦 *STOCK RECEIVED*\n\nRef: #${result.refNumber}\nSupplier: ${supplierName}\nPhone: ${supplierPhone}\n\n${itemLines}\n\n💰 *Total: Rs. ${totalAmount.toLocaleString()}*\n✅ *Paid: Rs. ${paidAmount.toLocaleString()}*\n\nThank you for your business!`;
                                    // Send to supplier
                                    try { await sock.sendMessage(`${supplierPhone}@s.whatsapp.net`, { text: receipt }); } catch(e) {}
                                    // Notify owners
                                    const ownerPhones = ['94719336848', '94779336848'];
                                    for (const op of ownerPhones) {
                                        try { await sock.sendMessage(`${op}@s.whatsapp.net`, { text: `📦 *Stock Received!*\n\nRef: #${result.refNumber}\nSupplier: ${supplierName}\n${itemLines}\n\nTotal: Rs. ${totalAmount.toLocaleString()}\nPaid: Rs. ${paidAmount.toLocaleString()}` }); } catch(e) {}
                                    }
                                    await sock.sendMessage(replyTo, { text: `✅ *Stock Received!*\n\nRef: #${result.refNumber}\nSupplier: ${supplierName}\n\n${itemLines}\n\n💰 Total: Rs. ${totalAmount.toLocaleString()}\n✅ Paid: Rs. ${paidAmount.toLocaleString()}\n\nReceipt sent to supplier + owners notified.` });
                                } else {
                                    await sock.sendMessage(replyTo, { text: `❌ Error: ${result.error}` });
                                }
                            } else {
                                await sock.sendMessage(replyTo, { text: `Usage: *stock receive [supplier] [phone] [item qty price, item qty price] [total paid]*\nExample: stock receive ABC 0771234567 rice 10 250, oil 5 500 total 3500 paid 3500` });
                            }
                        } else {
                            await sock.sendMessage(replyTo, { text: `Usage: *stock receive [supplier] [phone] [item qty price]*\nExample: stock receive ABC 0771234567 rice 10 250, oil 5 500 total 3500 paid 3500` });
                        }
                    } else {
                        await sock.sendMessage(replyTo, { text: `Usage: *stock receive [supplier] [phone] [item qty price]*` });
                    }
                    continue;
                }
            }

            // Skip auto-reply to other admins (owner already handled above, so not skipped)
            const adminNumbers = ['0779336848', '0750204698'];
            const isFromAdmin = adminNumbers.some(num => senderJid && senderJid.includes(num));
            if (isFromAdmin) continue;

            // ============ SMART REPLY ENGINE ============
            const intent = detectIntent(text);
            let customerName = '';

            // 0. Auto-ID: look up customer by phone number
            const phone = extractPhoneFromJid(senderJid);
            const customer = phone ? await getCustomerByPhone(phone) : null;
            if (customer) customerName = customer.name;

            // ═══════════ CART & CHECKOUT ═══════════
            // 0a. View cart
            if (intent === 'VIEW_CART') {
                const summary = cartManager.getCartSummary(senderJid);
                if (summary) {
                    await sock.sendMessage(replyTo, { text: `🛒 *Your Cart*\n\n${summary.text}\n\n💰 *Total: Rs. ${summary.total.toLocaleString()}*\n\nReply *"checkout"* to place order or *"clear cart"* to start over.` });
                } else {
                    await sock.sendMessage(replyTo, { text: `🛒 Your cart is empty.\n\nSend *"add [qty] [product]"* to add items.` });
                }
                continue;
            }

            // 0b. Clear cart
            if (intent === 'CLEAR_CART') {
                cartManager.clearCart(senderJid);
                await sock.sendMessage(replyTo, { text: `🗑️ Cart cleared. Ready to shop!` });
                continue;
            }

            // 0c. Remove from cart
            if (intent === 'REMOVE_FROM_CART') {
                const removeMatch = text.match(/(?:remove|delete|drop)\s+(?:from\s+cart\s+)?(.+)/i);
                const itemName = removeMatch ? removeMatch[1].trim().replace(/\s+from\s+cart$/i, '') : '';
                if (itemName) {
                    const result = cartManager.removeFromCart(senderJid, itemName);
                    if (result.removed) {
                        const summary = cartManager.getCartSummary(senderJid);
                        const totalLine = summary ? `\n\n💰 Total: Rs. ${summary.total.toLocaleString()}` : '';
                        await sock.sendMessage(replyTo, { text: `❌ Removed *${result.item.name}* from cart.${totalLine}` });
                    } else {
                        await sock.sendMessage(replyTo, { text: `❓ "${itemName}" not found in your cart.` });
                    }
                } else {
                    await sock.sendMessage(replyTo, { text: `Usage: *remove [product name]*` });
                }
                continue;
            }

            // 0d. Add to cart
            if (intent === 'ADD_TO_CART') {
                const addMatch = text.match(/(?:add|buy|get|want|need)\s+(\d+)?\s*(.+?)(?:\s+to\s+cart)?$/i);
                const qty = addMatch && addMatch[1] ? parseInt(addMatch[1]) : 1;
                const itemName = addMatch ? addMatch[2].trim().replace(/\s+to\s+cart$/i, '') : '';
                if (itemName && itemName.length > 1) {
                    const products = await searchInventory(itemName);
                    if (products.length > 0) {
                        const product = products[0];
                        if (product.stock < qty) {
                            await sock.sendMessage(replyTo, { text: `⚠️ Only *${product.stock}* in stock for *${product.name}*.` });
                        } else {
                            cartManager.addToCart(senderJid, product, qty);
                            const summary = cartManager.getCartSummary(senderJid);
                            await sock.sendMessage(replyTo, { text: `✅ Added *${qty}x ${product.name}* to cart.\n\n🛒 *Cart (${summary.itemCount} items)*\n${summary.text}\n\n💰 Total: Rs. ${summary.total.toLocaleString()}\n\nReply *"add more"* or *"checkout"* to place order.` });
                        }
                    } else {
                        await sock.sendMessage(replyTo, { text: `❓ "${itemName}" not found. Send *"products"* to browse.` });
                    }
                } else {
                    await sock.sendMessage(replyTo, { text: `Usage: *add [qty] [product name]*\nExample: add 2 rice` });
                }
                continue;
            }

            // 0e. Checkout
            if (intent === 'CHECKOUT') {
                const summary = cartManager.getCartSummary(senderJid);
                if (!summary || summary.items.length === 0) {
                    await sock.sendMessage(replyTo, { text: `🛒 Your cart is empty. Add items first!` });
                    continue;
                }
                const custName = customerName || 'Customer';
                const result = await createWhatsAppOrder(custName, phone || '', summary.items, 'CASH');
                if (result.success) {
                    cartManager.clearCart(senderJid);
                    const itemLines = summary.items.map(i => `• ${i.name} x ${i.quantity} = Rs. ${(i.price * i.quantity).toLocaleString()}`).join('\n');
                    await sock.sendMessage(replyTo, { text: `✅ *Order Placed!*\n\nInvoice: #${result.invoiceNumber}\n\n${itemLines}\n\n💰 *Total: Rs. ${summary.total.toLocaleString()}*\n\n📞 Call 0719336848 for delivery. Cash deposit only.` });
                    // Notify owners
                    const ownerPhones = ['94719336848', '94779336848'];
                    for (const op of ownerPhones) {
                        const ownerMsg = `📦 *New WhatsApp Order!*\n\nFrom: ${custName}\nPhone: ${phone}\nInvoice: #${result.invoiceNumber}\n\n${itemLines}\n\n*Total: Rs. ${summary.total.toLocaleString()}*`;
                        try { await sock.sendMessage(`${op}@s.whatsapp.net`, { text: ownerMsg }); } catch(e) {}
                    }
                } else {
                    await sock.sendMessage(replyTo, { text: `❌ Order failed: ${result.error}\nPlease call 0719336848.` });
                }
                continue;
            }
            // ═══════════ END CART ═══════════

            // 1. Browse category — "show kitchen items", "list cosmetics"
            if (intent === 'BROWSE_CATEGORY') {
                const cats = await getAllCategories();
                const categoryMatch = text.match(/(?:show|list|browse|display|items? in|what)\s+(.+?)(?:\?|$)/i);
                const searchCat = categoryMatch ? categoryMatch[1].trim() : '';
                if (searchCat && searchCat.length > 1) {
                    const result = await getProductsByCategory(searchCat, 1, CATALOG_PAGE_SIZE);
                    const products = result.products;
                    if (products.length > 0) {
                        catalogState.set(senderJid, { category: searchCat, page: 1, totalPages: result.totalPages, total: result.total });
                        const reply = `*${searchCat.toUpperCase()}* (Page 1/${result.totalPages || 1} — ${result.total} items)\n\n` +
                            products.map((p, i) => `${i + 1}. ${p.name} — Rs. ${p.price.toLocaleString()} (Stock: ${p.stock})`).join('\n') +
                            (result.totalPages > 1 ? '\n\nReply *"more"* for next page or *"back"* for previous.' : '') +
                            '\n\n_Add to cart: "add 2 [product name]"_';
                        const firstWithImage = products.find(p => p.image_url && p.image_url.startsWith('http'));
                        if (firstWithImage) {
                            await sock.sendMessage(replyTo, { image: { url: firstWithImage.image_url }, caption: reply });
                        } else {
                            await sock.sendMessage(replyTo, { text: reply });
                        }
                        continue;
                    }
                }
                const catList = cats.join(', ');
                await sock.sendMessage(replyTo, { text: `📂 *Categories:*\n${catList}\n\nSend *"Show [category]"* to browse.\nSend *"popular"* for best sellers.\nSend *"new arrivals"* for latest products.` });
                continue;
            }

            // 1b. Popular / best sellers
            if (intent === 'POPULAR') {
                const products = await getPopularProducts(10);
                if (products.length > 0) {
                    const reply = `🔥 *POPULAR PRODUCTS*\n\n` +
                        products.map((p, i) => `${i + 1}. ${p.name} — Rs. ${p.price.toLocaleString()} (Stock: ${p.stock})`).join('\n') +
                        '\n\n_Add to cart: "add [qty] [product name]"_';
                    const firstWithImage = products.find(p => p.image_url && p.image_url.startsWith('http'));
                    if (firstWithImage) {
                        await sock.sendMessage(replyTo, { image: { url: firstWithImage.image_url }, caption: reply });
                    } else {
                        await sock.sendMessage(replyTo, { text: reply });
                    }
                } else {
                    await sock.sendMessage(replyTo, { text: `No products found. Send *"products"* to browse catalog.` });
                }
                continue;
            }

            // 1c. New arrivals
            if (intent === 'NEW_ARRIVALS') {
                const products = await getNewArrivals(10);
                if (products.length > 0) {
                    const reply = `🆕 *NEW ARRIVALS*\n\n` +
                        products.map((p, i) => `${i + 1}. ${p.name} — Rs. ${p.price.toLocaleString()} (Stock: ${p.stock})`).join('\n') +
                        '\n\n_Add to cart: "add [qty] [product name]"_';
                    const firstWithImage = products.find(p => p.image_url && p.image_url.startsWith('http'));
                    if (firstWithImage) {
                        await sock.sendMessage(replyTo, { image: { url: firstWithImage.image_url }, caption: reply });
                    } else {
                        await sock.sendMessage(replyTo, { text: reply });
                    }
                } else {
                    await sock.sendMessage(replyTo, { text: `No new arrivals yet. Send *"products"* to browse catalog.` });
                }
                continue;
            }

            // 1d. Pagination — next / previous
            if (intent === 'NEXT_PAGE' || intent === 'PREV_PAGE') {
                const state = catalogState.get(senderJid);
                if (!state) {
                    await sock.sendMessage(replyTo, { text: `Send *"Show [category]"* first to start browsing.` });
                    continue;
                }
                let newPage = intent === 'NEXT_PAGE' ? state.page + 1 : state.page - 1;
                if (newPage < 1) newPage = 1;
                if (newPage > state.totalPages) newPage = state.totalPages;
                const result = await getProductsByCategory(state.category, newPage, CATALOG_PAGE_SIZE);
                const products = result.products;
                if (products.length > 0) {
                    state.page = newPage;
                    catalogState.set(senderJid, state);
                    const reply = `*${state.category.toUpperCase()}* (Page ${newPage}/${result.totalPages} — ${result.total} items)\n\n` +
                        products.map((p, i) => `${(newPage - 1) * CATALOG_PAGE_SIZE + i + 1}. ${p.name} — Rs. ${p.price.toLocaleString()} (Stock: ${p.stock})`).join('\n') +
                        '\n\nReply *"more"* for next page or *"back"* for previous.' +
                        '\n\n_Add to cart: "add [qty] [product name]"_';
                    const firstWithImage = products.find(p => p.image_url && p.image_url.startsWith('http'));
                    if (firstWithImage) {
                        await sock.sendMessage(replyTo, { image: { url: firstWithImage.image_url }, caption: reply });
                    } else {
                        await sock.sendMessage(replyTo, { text: reply });
                    }
                } else {
                    await sock.sendMessage(replyTo, { text: `No more products in *${state.category}*. Send *"Show [category]"* to restart.` });
                    catalogState.delete(senderJid);
                }
                continue;
            }

            // 2. Place order — "I need 2 cement and 5 paint"
            if (intent === 'ORDER') {
                const orderMatch = text.match(/(\d+)\s+(.+?)(?:\s+and\s+|,|\s*$)/gi);
                if (orderMatch) {
                    const items = [];
                    for (const m of orderMatch) {
                        const parts = m.match(/(\d+)\s+(.+?)(?:\s+and\s+|,|\s*$)/i);
                        if (parts) {
                            const qty = parseInt(parts[1]);
                            const name = parts[2].trim();
                            const product = await searchInventory(name);
                            if (product.length > 0) {
                                items.push({ name: product[0].name, quantity: qty, price: product[0].price });
                            }
                        }
                    }
                    if (items.length > 0) {
                        const result = await createOrder(customerName || phone || 'Customer', phone || '', items);
                        if (result.success) {
                            const summary = items.map(i => `• ${i.name} x ${i.quantity} = Rs. ${i.price * i.quantity}`).join('\n');
                            await sock.sendMessage(replyTo, { text: `✅ *Order Placed!*\nInvoice: #${result.invoiceNumber}\n\n${summary}\n\nTotal: Rs. ${result.total}\n\nReply "OK" to confirm or call us.` });
                            const ownerPhones = ['94719336848', '94779336848'];
                            for (const op of ownerPhones) {
                                const ownerJid = `${op}@s.whatsapp.net`;
                                const ownerMsg = `📦 *New WhatsApp Order!*\n\nFrom: ${customerName || phone}\nPhone: ${phone}\nInvoice: #${result.invoiceNumber}\n\n${summary}\n\n*Total: Rs. ${result.total}*`;
                                try { await sock.sendMessage(ownerJid, { text: ownerMsg }); } catch(e) {}
                            }
                            continue;
                        }
                    }
                }
            }

            // 3. Price / product query — live DB lookup
            if (intent === 'PRICE' || intent === 'PRODUCTS') {
                const priceResult = await handlePriceQuery(text);
                if (priceResult.handled && priceResult.reply) {
                    await sock.sendMessage(replyTo, { text: priceResult.reply });
                    continue;
                }
                const availResult = await handleAvailabilityQuery(text);
                if (availResult.handled && availResult.reply) {
                    await sock.sendMessage(replyTo, { text: availResult.reply });
                    continue;
                }
            }

            // 4a. Order tracking — "where is my order"
            if (intent === 'ORDER_TRACKING' && phone) {
                const orders = await getOrdersByPhone(phone);
                if (orders.length > 0) {
                    const reply = '*Your Recent Orders*\n\n' + orders.map((o, i) =>
                        `${i + 1}. #${o.invoiceNumber} — Rs. ${o.total} (${new Date(o.date).toLocaleDateString()})`
                    ).join('\n') + '\n\n_Call us for detailed tracking._';
                    await sock.sendMessage(replyTo, { text: reply });
                    continue;
                }
                await sock.sendMessage(replyTo, { text: 'No orders found for your number. Call 0719336848 for help.' });
                continue;
            }

            // 4b. Payment due inquiry
            if (intent === 'PAYMENT_DUE' && customer) {
                const due = customer.outstandingBalance;
                if (due > 0) {
                    await sock.sendMessage(replyTo, { text: `📋 *Payment Reminder*\n\n${customer.name}, your outstanding balance is *Rs. ${due}*.\nPaid: Rs. ${customer.paidAmount} of Rs. ${customer.totalBalance}\n\nPlease settle at your earliest. Cash deposit only. 🏦` });
                } else {
                    await sock.sendMessage(replyTo, { text: `✅ ${customer.name}, you have no outstanding balance. All paid up!` });
                }
                continue;
            }

            // ═══════════ JOIN GROUP ═══════════
            if (intent === 'JOIN_GROUP') {
                const groupLink = require('./shopData.cjs').whatsappGroupLink;
                const WATCHED_GROUPS = (process.env.WATCHED_GROUPS || 'smile and supplies').split(',').map(g => g.trim().toLowerCase());
                let groupJid = null;
                // Find the Smile & Supplies group JID
                for (const [jid, name] of knownGroups) {
                    if (name.toLowerCase().includes('smile') && name.toLowerCase().includes('supplies')) {
                        groupJid = jid;
                        break;
                    }
                }
                let added = false;
                if (groupJid) {
                    try {
                        await sock.groupParticipantsUpdate(groupJid, [senderJid], 'add');
                        added = true;
                        console.log(`[Group] Auto-added ${senderJid} to Smile & Supplies`);
                    } catch (e) {
                        console.log(`[Group] Auto-add failed for ${senderJid}: ${e.message}`);
                    }
                }
                if (added) {
                    await sock.sendMessage(replyTo, { text: `✅ You've been added to *Smile & Supplies* group!\n\nCheck your WhatsApp groups.` });
                } else {
                    await sock.sendMessage(replyTo, { text: `👥 *Join Our Group*\n\nTap the link to join *Smile & Supplies*:\n${groupLink}\n\nOr ask the admin to add you manually.` });
                }
                continue;
            }
            // ═══════════ END JOIN GROUP ═══════════
            // 4b. Live customer financial status (with recent POS invoices)
            let financialContext = '';
            if (intent === 'LOAN_INQUIRY' || intent === 'BALANCE_CHECK') {
                financialContext = await buildFinancialContext(customer, phone);
            }

            // 5. Build live inventory context
            let inventoryContext = '';
            if (!financialContext) {
                inventoryContext = await buildInventoryContext(text);
            }

            // 6. Personalized greeting for known customers
            const personalizedGreeting = customerName ? `(Customer: ${customerName}) ` : '';

            // 7. AI reply with live context
            let aiResponse = null;
            try {
                const aiText = personalizedGreeting + text;
                aiResponse = await aiReply(aiText, 'auto', inventoryContext, financialContext);
            } catch (err) {
                console.error('[AI] Reply failed:', err.message);
            }

            if (aiResponse) {
                await sock.sendMessage(replyTo, { text: aiResponse });
            } else {
                await sock.sendMessage(replyTo, { text: `Sorry, I'm having trouble. Please call us at ${require('./shopData.cjs').phoneNumbers[0]}.` });
            }
        }
    });
}

connectToWhatsApp();
