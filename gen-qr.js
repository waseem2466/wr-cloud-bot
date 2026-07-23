/**
 * gen-qr.js — Generates WhatsApp QR as PNG.
 * NOTE: For QR-based auth, creds.registered is always false — that's normal.
 * We just need connection=open + creds.me.id to confirm a valid session.
 */
const { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { execSync } = require('child_process');

const AUTH_DIR = path.join(process.cwd(), 'baileys_auth_info');
const AUTH_ZIP = path.join(process.cwd(), 'auth.bin');
const QR_IMAGE = path.join(process.cwd(), 'qr.png');

let attempt = 0;
let done = false;

async function saveQRImage(qrData) {
    try {
        const QRCode = require('qrcode');
        await QRCode.toFile(QR_IMAGE, qrData, { width: 512, margin: 2 });
        console.log(`✅ QR image saved → ${QR_IMAGE}`);
        try { execSync(`start "" "${QR_IMAGE}"`); } catch(e) {}
    } catch(e) {
        const qrcode = require('qrcode-terminal');
        qrcode.generate(qrData, { small: true });
    }
}

async function packageAndExit(name, id) {
    if (done) return;
    done = true;

    // Wait 5s for creds to fully flush to disk
    console.log('⏳ Waiting 5s for creds to save to disk...');
    await new Promise(r => setTimeout(r, 5000));

    console.log('\n📦 Packaging auth.bin...');
    const zip = new AdmZip();
    let fileCount = 0;
    for (const entry of fs.readdirSync(AUTH_DIR, { withFileTypes: true })) {
        if (entry.isFile()) {
            zip.addLocalFile(path.join(AUTH_DIR, entry.name), 'baileys_auth_info');
            fileCount++;
        }
    }
    zip.writeZip(AUTH_ZIP);

    // Verify
    const verify = new AdmZip(AUTH_ZIP);
    const credsEntry = verify.getEntry('baileys_auth_info/creds.json');
    const creds = credsEntry ? JSON.parse(credsEntry.getData().toString('utf8')) : null;
    console.log(`✅ auth.bin (${fileCount} files) — account: ${creds?.me?.name || name}, id: ${creds?.me?.id || id}`);

    if (fs.existsSync(QR_IMAGE)) fs.unlinkSync(QR_IMAGE);

    console.log('\n' + '='.repeat(52));
    console.log('  🚀 SUCCESS! Push to GitHub:');
    console.log('='.repeat(52));
    console.log('  git add wr-cloud-bot/auth.bin');
    console.log('  git commit -m "refresh WhatsApp auth"');
    console.log('  git push');
    console.log('='.repeat(52) + '\n');
    process.exit(0);
}

async function connect() {
    attempt++;
    console.log(`\n🔄 Connecting... (attempt ${attempt})`);

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 120000,
        defaultQueryTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('\n' + '='.repeat(52));
            console.log('  📱 SCAN QR WITH WHATSAPP NOW');
            console.log('  WhatsApp > ⋮ > Linked Devices > Link a Device');
            console.log('='.repeat(52));
            await saveQRImage(qr);
            console.log('  ⏳ Scan the qr.png file that just opened...\n');
        }

        if (connection === 'open') {
            const name = sock.user?.name || 'unknown';
            const id = sock.user?.id || 'unknown';
            console.log(`\n🎉 Connected! Account: ${name} (${id})`);
            await packageAndExit(name, id);
        }

        if (connection === 'close' && !done) {
            const code = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = code === DisconnectReason.loggedOut || code === 401;
            if (isLoggedOut) {
                console.log('❌ Logged out — cleaning session...');
                if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            } else {
                console.log(`⚠️  Disconnected (code: ${code}). Reconnecting in 3s...`);
            }
            setTimeout(() => connect(), 3000);
        }
    });
}

async function main() {
    console.log('🧹 Cleaning old session...');
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    if (fs.existsSync(AUTH_ZIP)) fs.unlinkSync(AUTH_ZIP);
    if (fs.existsSync(QR_IMAGE)) fs.unlinkSync(QR_IMAGE);
    await connect();
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
