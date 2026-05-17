const { makeWASocket, useMultiFileAuthState, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const AUTH_DIR = 'baileys_auth_info';
const AUTH_ZIP = 'auth.bin';

async function refreshAuth() {
    // Remove old auth state so we start fresh
    if (fs.existsSync(AUTH_DIR)) {
        console.log('Removing old auth state...');
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    if (fs.existsSync(AUTH_ZIP)) {
        console.log('Removing old auth.bin...');
        fs.unlinkSync(AUTH_ZIP);
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: Browsers.ubuntu('Chrome'),
        syncFullHistory: false,
        markOnlineOnConnect: true
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrcode.generate(qr, { small: true });
            console.log('\n=========================================');
            console.log(' SCAN THE QR ABOVE WITH WHATSAPP');
            console.log(' Menu > Linked Devices > Link a Device');
            console.log('=========================================\n');
        }
        if (connection === 'open') {
            console.log(' Connected to WhatsApp successfully!');

            // Wait a moment for creds to save, then zip
            await new Promise(r => setTimeout(r, 2000));

            console.log('Creating auth.bin from fresh session...');
            const zip = new AdmZip();
            const files = fs.readdirSync(AUTH_DIR);
            for (const file of files) {
                const filePath = path.join(AUTH_DIR, file);
                const stat = fs.statSync(filePath);
                if (stat.isFile()) {
                    zip.addLocalFile(filePath);
                }
            }
            zip.writeZip(AUTH_ZIP);
            console.log(` Created ${AUTH_ZIP} with ${files.length} files`);
            console.log('\n Done! Now commit and push to GitHub.');
            console.log(' Run:');
            console.log('   git add wr-cloud-bot/auth.bin');
            console.log('   git commit -m "refresh WhatsApp auth session"');
            console.log('   git push');
            console.log('\nThen redeploy on Koyeb.');
            process.exit(0);
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) {
                console.log('Session invalid. A new QR will appear above.');
            } else {
                console.log('Connection closed. Retrying in 3s...');
                setTimeout(() => process.exit(1), 3000);
            }
        }
    });
}

refreshAuth().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
