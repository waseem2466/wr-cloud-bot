
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

// Dummy HTTP server to satisfy Cloud Providers (Railway/Koyeb/Heroku) health checks
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('WR POS Cloud Bot is running!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`☁️ Cloud Health Server running on port ${PORT}`);
});

async function connectToWhatsApp() {
    console.log('Starting WR POS Cloud WhatsApp Bot...');
    
    // Auto-extract auth.bin if baileys_auth_info doesn't exist
    if (!fs.existsSync('baileys_auth_info') && fs.existsSync('auth.bin')) {
        console.log('📦 Extracting auth.bin to restore WhatsApp session...');
        const AdmZip = require('adm-zip');
        const zip = new AdmZip('auth.bin');
        zip.extractAllTo('.', true);
        console.log('✅ Auth session restored!');
    }

    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    let { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
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
            console.log('📲 SCAN THIS QR CODE WITH WHATSAPP 📲');
            console.log('=========================================\n');
        }
        if (connection === 'close') {
            console.error('Disconnect Reason:', lastDisconnect?.error);
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isConflict = statusCode === 440;
            const shouldReconnect = !isConflict && statusCode !== DisconnectReason.loggedOut;
            if (isConflict) {
                console.error('[WhatsApp] Connection conflict detected. Another session is active for this phone number.');
                console.error('[WhatsApp] Stop reconnecting until the other session is removed or the session file is refreshed.');
            }
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000); // Wait 3 seconds to prevent rapid crash loops
            }
        } else if (connection === 'open') {
            console.log('✅ Connected to WhatsApp successfully!');
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

            // 1. Handle Owner Commands
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

            // 2. Ignore Admins
            const adminNumbers = ['0779336848', '0719336848', '0750204698'];
            const isFromAdmin = adminNumbers.some(num => senderJid && senderJid.includes(num));
            if (isFromAdmin) continue;

            // 3. Handle Group Watcher (auto-logging items)
            if (isGroup && isWatchedGroup(msg.key.remoteJid, msg.pushName)) {
                const groupResult = await handleGroupMessage(msg, sock);
                if (groupResult.handled && groupResult.reply) {
                    await sock.sendMessage(replyTo, { text: groupResult.reply });
                    continue;
                }
            }

            // 4. Handle Customer AI Auto-Reply
            const intent = detectIntent(text);
            let aiResponse = null;
            try {
                aiResponse = await aiReply(text, 'auto');
            } catch (err) {
                console.error('[AI] Reply generation failed:', err.message);
            }
            if (aiResponse) {
                console.log(`[AI] Sending reply to ${replyTo}: "${aiResponse}"`);
                await sock.sendMessage(replyTo, { text: aiResponse });
            } else {
                console.warn('[AI] No reply generated for message:', text);
            }
        }
    });
}

connectToWhatsApp();
