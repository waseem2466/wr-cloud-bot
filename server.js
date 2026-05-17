const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const dotenv = require('dotenv');
const http = require('http');

dotenv.config();

const { handleOwnerCommand, isOwner } = require('./inventoryManager.cjs');
const { handleGroupMessage, isWatchedGroup, registerGroup } = require('./groupWatcher.cjs');
const { aiReply } = require('./aiReply.cjs');
const { detectIntent } = require('./intent.cjs');
const { handlePriceQuery, handleAvailabilityQuery, getProductDetails } = require('./productPriceHandler.cjs');
const { searchInventory, getCustomerBalance, getProductsByCategory, getAllCategories, getCustomerByPhone, createOrder, getOrdersByPhone, getOverdueCustomers } = require('./dbHelper.cjs');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WR POS Cloud Bot is running!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(` Cloud Health Server running on port ${PORT}`);
});

const STOP_WORDS = new Set(['i','a','an','the','is','it','am','to','for','of','in','on','at','by','with','and','or','but','not','do','does','did','have','has','had','can','will','want','need','buy','get','some','please','me','my','you','your','how','much','what','which','where','who','are','this','that','there','here','all','any','each','every','just','now','also','very','too','was','were','been','being','would','could','should','may','might','shall','got','know','like','say','tell','ask','help','check','see','look','give','take','use','make','come','going','out','up','down','off','over','about','than','then','then','price','rate','cost','stock','available','hello','hi','hey','thanks','thank','bye']);

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
                if (!results.has(p.name)) results.set(p.name, p);
            }
        }
        if (results.size === 0) return '';
        return [...results.values()].slice(0, 5)
            .map(p => `- ${p.name}: Rs. ${p.price} (Stock: ${p.stock})`)
            .join('\n');
    } catch { return ''; }
}

function extractPhoneFromJid(jid) {
    if (!jid) return null;
    return jid.replace(/@.*$/, '').replace(/[^0-9]/g, '');
}

const REMINDER_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours

async function startPaymentReminders(sock) {
    console.log('[Reminder] Payment reminder scheduler started (every 12h)');
    const run = async () => {
        try {
            const overdue = await getOverdueCustomers();
            for (const c of overdue) {
                const phone = c.phone?.replace(/[^0-9]/g, '');
                if (!phone) continue;
                const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
                const msg = `🔔 *Payment Reminder*\n\nHi ${c.name}, you have an outstanding balance of *Rs. ${c.outstandingBalance}*.\nPaid: Rs. ${c.paidAmount} of Rs. ${c.totalBalance}\n\nPlease settle soon. Bank transfer or in-store. 🏦`;
                try {
                    await sock.sendMessage(jid, { text: msg });
                    console.log(`[Reminder] Sent to ${c.name} (${phone})`);
                    await new Promise(r => setTimeout(r, 2000));
                } catch (e) {
                    console.error(`[Reminder] Failed for ${phone}:`, e.message);
                }
            }
        } catch (e) {
            console.error('[Reminder] Error:', e.message);
        }
    };
    await run();
    setInterval(run, REMINDER_INTERVAL);
}

async function connectToWhatsApp() {
    console.log('Starting WR POS Cloud WhatsApp Bot...');

    if (!fs.existsSync('baileys_auth_info') && fs.existsSync('auth.bin')) {
        console.log(' Extracting auth.bin to restore WhatsApp session...');
        const AdmZip = require('adm-zip');
        const zip = new AdmZip('auth.bin');
        zip.extractAllTo('.', true);
        console.log(' Auth session restored!');
    }

    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    let { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version, auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('\n=========================================');
            console.log(' SCAN THIS QR CODE WITH WHATSAPP ');
            console.log('=========================================\n');
        }
        if (connection === 'close') {
            console.error('Disconnect Reason:', lastDisconnect?.error);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isConflict = statusCode === 440;
            const isUnauthorized = statusCode === 401;
            const shouldReconnect = !isConflict && !isUnauthorized && statusCode !== DisconnectReason.loggedOut;
            if (isConflict) console.error('[WhatsApp] Connection conflict.');
            if (isUnauthorized) console.error('[WhatsApp] Unauthorized (401).');
            if (shouldReconnect) setTimeout(connectToWhatsApp, 3000);
        } else if (connection === 'open') {
            console.log(' Connected to WhatsApp successfully!');
            startPaymentReminders(sock);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || '';
            if (!text) continue;

            const isGroup = msg.key.remoteJid?.endsWith('@g.us');
            const senderJid = isGroup ? (msg.key.participant || msg.key.remoteJid) : msg.key.remoteJid;
            const replyTo = msg.key.remoteJid;

            if (senderJid === 'status@broadcast' || replyTo === 'status@broadcast') continue;

            console.log(`[Message] from ${senderJid}: "${text}"`);

            // ============ GROUP ============
            if (isGroup) {
                if (isWatchedGroup(msg.key.remoteJid, msg.pushName)) {
                    const isGroupSenderAdmin = isOwner(senderJid) || ['0779336848', '0750204698'].some(n => senderJid?.includes(n));
                    if (isGroupSenderAdmin) {
                        await handleGroupMessage(msg, sock, true);
                        console.log(`[Group] Admin product saved to main inventory from: ${senderJid}`);
                    }
                }
                continue;
            }

            // ============ DM ============

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

            // 1. Browse category — "show kitchen items", "list cosmetics"
            if (intent === 'BROWSE_CATEGORY') {
                const cats = await getAllCategories();
                const categoryMatch = text.match(/(?:show|list|browse|display|items? in|what)\s+(.+?)(?:\?|$)/i);
                const searchCat = categoryMatch ? categoryMatch[1].trim() : '';
                if (searchCat && searchCat.length > 1) {
                    const products = await getProductsByCategory(searchCat);
                    if (products.length > 0) {
                        const reply = `*${searchCat.toUpperCase()}*\n\n` + products.map((p, i) =>
                            `${i + 1}. ${p.name} — Rs. ${p.price} (Stock: ${p.stock})`
                        ).join('\n');
                        await sock.sendMessage(replyTo, { text: reply });
                        continue;
                    }
                }
                const catList = cats.join(', ');
                await sock.sendMessage(replyTo, { text: `📂 *Categories:*\n${catList}\n\nSend *"Show [category]"* to browse.` });
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

            // 5. Loan / balance query
            let financialContext = '';
            if (intent === 'LOAN_INQUIRY' || intent === 'BALANCE_CHECK') {
                if (customer) {
                    financialContext = `Customer: ${customer.name}\nTotal: Rs. ${customer.totalBalance}\nPaid: Rs. ${customer.paidAmount}\nOutstanding: Rs. ${customer.outstandingBalance}`;
                } else if (phone) {
                    const balance = await getCustomerBalance(phone);
                    if (balance) {
                        financialContext = `Customer: ${balance.name}\nTotal: Rs. ${balance.totalBalance}\nPaid: Rs. ${balance.paidAmount}\nOutstanding: Rs. ${balance.outstandingBalance}`;
                    }
                }
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