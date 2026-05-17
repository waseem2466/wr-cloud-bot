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

            // Wait a moment for creds to save
            await new Promise(r => setTimeout(r, 3000));

            // Verify creds are fully registered
            const credsPath = path.join(AUTH_DIR, 'creds.json');
            if (fs.existsSync(credsPath)) {
                const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
                if (!creds.registered) {
                    console.error('ERROR: Session registered=false. QR scan may be incomplete.');
                    console.error('Please delete auth.bin and baileys_auth_info/, then run again.');
                    process.exit(1);
                }
                console.log(` Registered as: ${creds.me?.name || 'unknown'} (${creds.me?.id || 'unknown'})`);
            }

            console.log('Creating auth.bin from fresh session...');
            const zip = new AdmZip();
            const entries = fs.readdirSync(AUTH_DIR, { withFileTypes: true });
            let fileCount = 0;
            for (const entry of entries) {
                if (entry.isFile()) {
                    const filePath = path.join(AUTH_DIR, entry.name);
                    zip.addLocalFile(filePath, AUTH_DIR);
                    fileCount++;
                }
            }
            zip.writeZip(AUTH_ZIP);

            // Verify ZIP has the correct folder structure
            const verifyZip = new AdmZip(AUTH_ZIP);
            const zipEntries = verifyZip.getEntries();
            const hasPrefix = zipEntries.every(e => e.entryName.startsWith(AUTH_DIR + '/'));
            console.log(` Created ${AUTH_ZIP} with ${fileCount} files`);
            if (!hasPrefix) {
                console.warn('WARNING: ZIP entries missing baileys_auth_info/ prefix — extraction will fail on server!');
            } else {
                console.log(' ZIP structure verified OK (entries have baileys_auth_info/ prefix)');
            }

            console.log('\n Done! Now commit and push to GitHub.');
            console.log(' Run:');
            console.log('   cd C:\\Users\\wasee\\OneDrive\\Desktop\\wr-pos');
            console.log('   git add wr-cloud-bot/auth.bin');
            console.log('   git commit -m "refresh WhatsApp auth session"');
            console.log('   git push');
            console.log('\nThen Koyeb will auto-redeploy from the new commit.');
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
