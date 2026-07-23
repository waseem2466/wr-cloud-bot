const AdmZip = require('adm-zip');
const path = require('path');
const os = require('os');

// The desktop app stores its session at: %APPDATA%/wr-pos/auth_info_baileys
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const sourceDir = path.join(appData, 'wr-pos', 'auth_info_baileys');
const destZip = path.join(__dirname, '..', 'wr-cloud-bot', 'auth.bin');

console.log(`Source: ${sourceDir}`);
console.log(`Dest:   ${destZip}`);

const fs = require('fs');
if (!fs.existsSync(sourceDir)) {
    console.error('ERROR: Desktop auth folder not found at:');
    console.error(`  ${sourceDir}`);
    console.error('Make sure you have scanned a QR code in the desktop app first.');
    process.exit(1);
}

const zip = new AdmZip();
zip.addLocalFolder(sourceDir, 'baileys_auth_info');
zip.writeZip(destZip);
console.log('✅ Created auth.bin from desktop WhatsApp session!');
