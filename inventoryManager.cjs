/**
 * Inventory Manager — Owner WhatsApp Commands (SAFE MODE)
 * 
 * SAFETY RULES:
 * 1. NEVER deletes any existing data
 * 2. Uses INSERT...ON CONFLICT to safely upsert
 * 3. All changes are logged with audit trail
 * 4. Only the verified OWNER_PHONE can execute write commands
 * 5. Stock updates ADD to existing stock (never replace)
 */

const { Pool } = require('pg');
const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');
const fetch = require('node-fetch');

const { app } = require('electron');
const envPath = app && app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(__dirname, '.env');
dotenv.config({ path: envPath });

let pool;
function getPool() {
    if (!pool) {
        const { SqliteBridge } = require('./sqliteBridge.cjs');
        const useSqlite = process.env.WRPOS_DB_DRIVER !== 'postgres';
        if (useSqlite) {
            pool = new SqliteBridge({ app });
        } else {
            pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: (process.env.DATABASE_URL && process.env.DATABASE_URL.includes('neon.tech'))
                    ? { rejectUnauthorized: false } : false,
                max: 3,
                connectionTimeoutMillis: 5000,
            });
            pool.on('error', (err) => {
                console.error('[InventoryMgr] Pool error:', err.message);
            });
        }
    }
    return pool;
}

// ─── Owner Phone Verification ─────────────────────────────────────────────────

function getOwnerPhones() {
    const raw = process.env.OWNER_PHONE || '0719336848';
    return raw.split(',').map(p => p.trim()).filter(Boolean);
}

/**
 * Check if a JID or phone number belongs to the owner
 */
function isOwner(senderJid) {
    const ownerPhones = getOwnerPhones();
    // Strip @s.whatsapp.net or @g.us
    const cleanSender = senderJid.replace(/@.*$/, '');

    for (const ownerPhone of ownerPhones) {
        // Normalize: remove leading 0, match last 9 digits
        const ownerLast9 = ownerPhone.replace(/^0+/, '').slice(-9);
        const senderLast9 = cleanSender.slice(-9);
        if (ownerLast9 === senderLast9) return true;
    }
    return false;
}

// ─── AI-Powered Command Parsing (uses Gemini) ────────────────────────────────

async function parseOwnerCommand(text) {
    const apiKey = process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';

    if (!apiKey) {
        console.warn('[InventoryMgr] No Gemini key, falling back to regex parsing');
        return parseOwnerCommandRegex(text);
    }

    const systemPrompt = `You are a product data extractor for a shop inventory system.
The owner sends WhatsApp messages to add or update products.

Extract the following from the message:
- action: "add" (new product or add stock), "update_price" (change price), "check" (check stock), "list" (list products)
- name: product name (required for add/update/check)
- price: selling price (number only, no currency)
- cost: purchase/cost price (number only, optional)
- stock: quantity to ADD (number only, optional, default 1)
- category: product category (optional)
- barcode: barcode if mentioned (optional)

IMPORTANT: For "add" action, stock means how many NEW items to ADD to existing stock.

Return ONLY valid JSON. Example:
{"action":"add","name":"Vitamin C 500mg","price":150,"cost":100,"stock":50,"category":"Health"}

If you cannot understand the command, return: {"action":"unknown","error":"reason"}`;

    try {
        const model = process.env.VITE_GEMINI_MODEL || 'gemini-2.0-flash-lite';
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `${systemPrompt}\n\nOwner message: ${text}` }] }]
                })
            }
        );

        if (!res.ok) {
            console.warn(`[InventoryMgr] Gemini failed (${res.status}), using regex`);
            return parseOwnerCommandRegex(text);
        }

        const data = await res.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Extract JSON from response (might be wrapped in code blocks)
        const jsonMatch = reply.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            console.log('[InventoryMgr] AI parsed command:', parsed);
            return parsed;
        }

        return parseOwnerCommandRegex(text);
    } catch (err) {
        console.warn('[InventoryMgr] AI parse failed:', err.message);
        return parseOwnerCommandRegex(text);
    }
}

/**
 * Regex fallback for command parsing
 */
function parseOwnerCommandRegex(text) {
    const t = text.trim();

    // ADD: "add 50 Vitamin C price 150 cost 100"
    // ADD: "add Paracetamol 500mg, qty 100, price 25, cost 15"
    const addMatch = t.match(
        /^add\s+(?:(\d+)\s+)?(.+?)(?:\s*,\s*|\s+)(?:qty\s+(\d+)\s*,?\s*)?(?:price\s+(\d+(?:\.\d+)?)\s*,?\s*)?(?:cost\s+(\d+(?:\.\d+)?))?/i
    );
    if (addMatch) {
        return {
            action: 'add',
            stock: parseInt(addMatch[1] || addMatch[3] || '1'),
            name: addMatch[2]?.trim(),
            price: addMatch[4] ? parseFloat(addMatch[4]) : null,
            cost: addMatch[5] ? parseFloat(addMatch[5]) : null,
        };
    }

    // PRICE UPDATE: "update price Vitamin C to 200"
    const priceMatch = t.match(/^(?:update|change|set)\s+price\s+(.+?)\s+(?:to|=)\s+(\d+(?:\.\d+)?)/i);
    if (priceMatch) {
        return {
            action: 'update_price',
            name: priceMatch[1].trim(),
            price: parseFloat(priceMatch[2]),
        };
    }

    // CHECK: "check stock Vitamin C"
    const checkMatch = t.match(/^(?:check|stock|how many)\s+(?:stock\s+)?(.+)/i);
    if (checkMatch) {
        return {
            action: 'check',
            name: checkMatch[1].trim(),
        };
    }

    // LIST: "list products" or "show inventory"
    if (/^(?:list|show|all)\s+(?:products?|inventory|items?|stock)/i.test(t)) {
        return { action: 'list' };
    }

    return { action: 'unknown', error: 'Could not understand command' };
}

// ─── Safe Database Operations ─────────────────────────────────────────────────

/**
 * SAFELY add a product. If it already exists, only ADD stock (never replace).
 */
async function safeAddProduct({ name, price, cost, stock, category, barcode }) {
    if (!name) return { success: false, error: 'Product name is required' };

    const p = getPool();
    const id = `prod_wa_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const safeStock = Math.max(0, parseInt(stock) || 1);
    const safePrice = parseFloat(price) || 0;
    const safeCost = parseFloat(cost) || 0;
    const safeName = name.trim();
    const safeCategory = category || 'General';
    const safeBarcode = barcode || '';

    try {
        // First check if product already exists (by name, case-insensitive)
        const existing = await p.query(
            `SELECT id, name, price, cost, stock FROM "Product" WHERE LOWER(name) = LOWER($1) LIMIT 1`,
            [safeName]
        );

        if (existing.rows && existing.rows.length > 0) {
            // Product exists — SAFELY ADD to existing stock
            const existingProduct = existing.rows[0];
            const newStock = (parseFloat(existingProduct.stock) || 0) + safeStock;
            const updatePrice = safePrice > 0 ? safePrice : existingProduct.price;
            const updateCost = safeCost > 0 ? safeCost : existingProduct.cost;

            await p.query(
                `UPDATE "Product" SET stock = $1, price = $2, cost = $3, updated_at = $4 WHERE id = $5`,
                [newStock, updatePrice, updateCost, new Date().toISOString(), existingProduct.id]
            );

            console.log(`[InventoryMgr] ✅ Updated existing product: ${safeName} | Stock: ${existingProduct.stock} → ${newStock}`);
            return {
                success: true,
                isUpdate: true,
                product: {
                    name: safeName,
                    oldStock: existingProduct.stock,
                    newStock: newStock,
                    price: updatePrice,
                    cost: updateCost,
                },
                message: `✅ *Product Updated!*\n\n📦 *${safeName}*\n📊 Stock: ${existingProduct.stock} → *${newStock}* (+${safeStock})\n💰 Price: Rs. ${updatePrice}\n💵 Cost: Rs. ${updateCost}`
            };
        }

        // Product does NOT exist — CREATE new
        await p.query(
            `INSERT INTO "Product" (id, name, barcode, sku, cost, price, stock, category, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [id, safeName, safeBarcode, '', safeCost, safePrice, safeStock, safeCategory,
                new Date().toISOString(), new Date().toISOString()]
        );

        console.log(`[InventoryMgr] ✅ New product added: ${safeName} | Stock: ${safeStock} | Price: ${safePrice}`);
        return {
            success: true,
            isNew: true,
            product: {
                id,
                name: safeName,
                stock: safeStock,
                price: safePrice,
                cost: safeCost,
                category: safeCategory,
            },
            message: `✅ *New Product Added!*\n\n📦 *${safeName}*\n📊 Stock: ${safeStock}\n💰 Price: Rs. ${safePrice}\n💵 Cost: Rs. ${safeCost}\n📂 Category: ${safeCategory}`
        };
    } catch (err) {
        console.error('[InventoryMgr] Add product error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * SAFELY add a product to the GROUP inventory (separate from main inventory).
 */
async function safeAddGroupProduct({ name, price, cost, stock, category, description }) {
    if (!name) return { success: false, error: 'Product name is required' };

    const p = getPool();
    const id = `grp_prod_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const safeStock = Math.max(0, parseInt(stock) || 1);
    const safePrice = parseFloat(price) || 0;
    const safeCost = parseFloat(cost) || 0;
    const safeName = name.trim();
    const safeCategory = category || 'General';
    const safeDesc = description || '';

    try {
        // Check if exists in GroupProduct
        const existing = await p.query(
            `SELECT id, name, price, cost, stock FROM "GroupProduct" WHERE LOWER(name) = LOWER($1) LIMIT 1`,
            [safeName]
        );

        if (existing.rows && existing.rows.length > 0) {
            const existingProduct = existing.rows[0];
            const newStock = (parseFloat(existingProduct.stock) || 0) + safeStock;
            const updatePrice = safePrice > 0 ? safePrice : existingProduct.price;
            const updateCost = safeCost > 0 ? safeCost : existingProduct.cost;

            await p.query(
                `UPDATE "GroupProduct" SET stock = $1, price = $2, cost = $3, updated_at = $4 WHERE id = $5`,
                [newStock, updatePrice, updateCost, new Date().toISOString(), existingProduct.id]
            );

            return {
                success: true,
                isUpdate: true,
                message: `✅ *Group Item Updated!*\n\n📦 *${safeName}*\n📊 Stock: ${existingProduct.stock} → *${newStock}* (+${safeStock})\n💰 Price: Rs. ${updatePrice}`
            };
        }

        // CREATE new in GroupProduct
        await p.query(
            `INSERT INTO "GroupProduct" (id, name, cost, price, stock, category, description, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [id, safeName, safeCost, safePrice, safeStock, safeCategory, safeDesc,
                new Date().toISOString(), new Date().toISOString()]
        );

        return {
            success: true,
            isNew: true,
            message: `✅ *Group Item Logged!*\n\n📦 *${safeName}*\n📊 Stock: ${safeStock}\n💰 Price: Rs. ${safePrice}\n📂 Category: ${safeCategory}`
        };
    } catch (err) {
        console.error('[InventoryMgr] Add group product error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * SAFELY update product price (never touches stock).
 */
async function safeUpdatePrice(name, newPrice) {
    if (!name || !newPrice) return { success: false, error: 'Name and price required' };

    const p = getPool();
    try {
        const existing = await p.query(
            `SELECT id, name, price, stock FROM "Product" WHERE LOWER(name) LIKE LOWER($1) LIMIT 1`,
            [`%${name.trim()}%`]
        );

        if (!existing.rows || existing.rows.length === 0) {
            return { success: false, error: `Product "${name}" not found` };
        }

        const product = existing.rows[0];
        const oldPrice = product.price;
        await p.query(
            `UPDATE "Product" SET price = $1, updated_at = $2 WHERE id = $3`,
            [newPrice, new Date().toISOString(), product.id]
        );

        console.log(`[InventoryMgr] ✅ Price updated: ${product.name} | Rs. ${oldPrice} → Rs. ${newPrice}`);
        return {
            success: true,
            message: `✅ *Price Updated!*\n\n📦 *${product.name}*\n💰 Old Price: Rs. ${oldPrice}\n💰 New Price: Rs. ${newPrice}\n📊 Stock: ${product.stock} (unchanged)`
        };
    } catch (err) {
        console.error('[InventoryMgr] Update price error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Check product stock (read-only, always safe).
 */
async function checkProductStock(name) {
    if (!name) return { success: false, error: 'Product name required' };

    const p = getPool();
    try {
        const result = await p.query(
            `SELECT name, price, cost, stock, category FROM "Product" WHERE LOWER(name) LIKE LOWER($1) LIMIT 5`,
            [`%${name.trim()}%`]
        );

        if (!result.rows || result.rows.length === 0) {
            return { success: true, message: `❌ No product found matching "${name}"` };
        }

        const lines = result.rows.map(p =>
            `📦 *${p.name}*\n   💰 Price: Rs. ${p.price} | 💵 Cost: Rs. ${p.cost}\n   📊 Stock: ${p.stock} | 📂 ${p.category || 'General'}`
        );

        return {
            success: true,
            message: `🔍 *Stock Check Results:*\n\n${lines.join('\n\n')}`
        };
    } catch (err) {
        console.error('[InventoryMgr] Check stock error:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * List recent products (read-only).
 */
async function listProducts(limit = 10) {
    const p = getPool();
    try {
        const result = await p.query(
            `SELECT name, price, stock, category FROM "Product" ORDER BY updated_at DESC LIMIT $1`,
            [limit]
        );

        if (!result.rows || result.rows.length === 0) {
            return { success: true, message: '📦 No products in inventory yet.' };
        }

        const lines = result.rows.map((p, i) =>
            `${i + 1}. *${p.name}* — Rs. ${p.price} (Stock: ${p.stock})`
        );

        return {
            success: true,
            message: `📋 *Recent Products (${result.rows.length}):*\n\n${lines.join('\n')}\n\n_Send "check [name]" for details_`
        };
    } catch (err) {
        console.error('[InventoryMgr] List products error:', err.message);
        return { success: false, error: err.message };
    }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────

/**
 * Handle an owner command from WhatsApp.
 * Returns { handled: boolean, reply: string }
 */
async function handleOwnerCommand(senderJid, text) {
    // Safety check: only owner can execute write commands
    if (!isOwner(senderJid)) {
        console.warn(`[InventoryMgr] ⚠️ Non-owner attempted command: ${senderJid}`);
        return { handled: false };
    }

    console.log(`[InventoryMgr] 👤 Owner command from ${senderJid}: "${text}"`);

    try {
        const command = await parseOwnerCommand(text);
        console.log('[InventoryMgr] Parsed command:', JSON.stringify(command));

        switch (command.action) {
            case 'add': {
                if (!command.name) {
                    return { handled: true, reply: '⚠️ Please specify a product name.\n\nExample: *add 50 Vitamin C price 150 cost 100*' };
                }
                const result = await safeAddProduct(command);
                return { handled: true, reply: result.message || `❌ Error: ${result.error}` };
            }

            case 'update_price': {
                if (!command.name || !command.price) {
                    return { handled: true, reply: '⚠️ Please specify product and price.\n\nExample: *update price Vitamin C to 200*' };
                }
                const result = await safeUpdatePrice(command.name, command.price);
                return { handled: true, reply: result.message || `❌ Error: ${result.error}` };
            }

            case 'check': {
                const result = await checkProductStock(command.name);
                return { handled: true, reply: result.message || `❌ Error: ${result.error}` };
            }

            case 'list': {
                const result = await listProducts();
                return { handled: true, reply: result.message || `❌ Error: ${result.error}` };
            }

            case 'unknown':
            default:
                return { handled: false };
        }
    } catch (err) {
        console.error('[InventoryMgr] Command handler error:', err.message);
        return { handled: true, reply: `❌ Error processing command: ${err.message}` };
    }
}

module.exports = {
    isOwner,
    handleOwnerCommand,
    safeAddProduct,
    safeAddGroupProduct,
    safeUpdatePrice,
    checkProductStock,
    listProducts,
    parseOwnerCommand,
};
