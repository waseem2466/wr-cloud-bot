
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const { handleOwnerCommand, isOwner } = require('./inventoryManager.cjs');
const { handleGroupMessage, isWatchedGroup, registerGroup } = require('./groupWatcher.cjs');
const { aiReply } = require('./aiReply.cjs');
const { detectIntent } = require('./intent.cjs');

async function connectToWhatsApp() {
    console.log('Starting WR POS Cloud WhatsApp Bot...');
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ['WR POS Cloud', 'Chrome', '1.0.0'],
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
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed. Reconnecting:', shouldReconnect);
            if (shouldReconnect) connectToWhatsApp();
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
            const aiResponse = await aiReply(text, senderJid, intent);
            if (aiResponse) {
                await sock.sendMessage(replyTo, { text: aiResponse });
            }
        }
    });
}

connectToWhatsApp();
