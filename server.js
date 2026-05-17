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
const { searchInventory, getCustomerBalance } = require('./dbHelper.cjs');

const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WR POS Cloud Bot is running!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(` Cloud Health Server running on port ${PORT}`);
});

async function buildInventoryContext(text) {
    try {
        const intent = detectIntent(text);
        let query = text.replace(/(?:price|cost|rate|how much|do you have|stock|available|have you got|is there)\s*/gi, '').trim();
        if (query.length < 2) return '';
        const products = await searchInventory(query);
        if (!products || products.length === 0) return '';
        return products.map(p => `- ${p.name}: Rs. ${p.price} (Stock: ${p.stock})`).join('\n');
    } catch { return ''; }
}

function extractPhoneFromJid(jid) {
    if (!jid) return null;
    return jid.replace(/@.*$/, '').replace(/[^0-9]/g, '');
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
                    await handleGroupMessage(msg, sock);
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

            // Skip auto-reply to admins
            const adminNumbers = ['0779336848', '0719336848', '0750204698'];
            const isFromAdmin = adminNumbers.some(num => senderJid && senderJid.includes(num));
            if (isFromAdmin) continue;

            // ============ SMART REPLY ENGINE ============
            const intent = detectIntent(text);

            // 1. Price query — live DB lookup, instant reply
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

            // 2. Loan / balance query — live DB lookup
            let financialContext = '';
            if (intent === 'LOAN_INQUIRY' || intent === 'BALANCE_CHECK') {
                const phone = extractPhoneFromJid(senderJid);
                if (phone) {
                    const balance = await getCustomerBalance(phone);
                    if (balance) {
                        financialContext = `Customer: ${balance.name}\nTotal: Rs. ${balance.totalBalance}\nPaid: Rs. ${balance.paidAmount}\nOutstanding: Rs. ${balance.outstandingBalance}`;
                    }
                }
            }

            // 3. Build live inventory context from the message
            let inventoryContext = '';
            if (!financialContext) {
                inventoryContext = await buildInventoryContext(text);
            }

            // 4. AI reply with live context — Gemini first (skip local-ollama in cloud)
            let aiResponse = null;
            try {
                aiResponse = await aiReply(text, 'auto', inventoryContext, financialContext);
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