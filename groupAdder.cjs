/**
 * Group Inviter — WR POS WhatsApp Bot
 * Extracts all members from source groups, sends fresh invite DMs.
 * Limits: 20 DMs/day with 35-60s delay between sends.
 * Dedup: Permanent via DB "InvitedPhone" table (one person = one invite ever).
 */

const shop = require('./shopData.cjs');
const path = require('path');
const dotenv = require('dotenv');

const envPath = path.join(__dirname, '.env');
dotenv.config({ path: envPath });

const DAILY_LIMIT = parseInt(process.env.GROUP_INVITE_LIMIT || '20');
const SEND_DELAY_MS = 35000;
const GROUP_LINK = shop.whatsappGroupLink;

let sentToday = new Set();
let sendCount = 0;
let lastResetDate = new Date().toDateString();
let isProcessing = false;
let pendingInvites = [];
const invitedPhones = new Set(); // in-memory cache, backed by DB

// ─── DB helpers for permanent dedup ──────────────────────────────────────────

async function loadInvitedPhonesFromDB() {
    try {
        const { getPool } = require('./dbHelper.cjs');
        const pool = getPool();
        const res = await pool.query(`SELECT phone FROM "InvitedPhone"`);
        for (const row of res.rows) {
            invitedPhones.add(row.phone);
        }
        console.log(`[GroupInviter] Loaded ${invitedPhones.size} invited phones from DB`);
    } catch (err) {
        console.error('[GroupInviter] Failed to load invited phones:', err.message);
    }
}

async function saveInvitedPhoneToDB(phone, name, sourceGroup) {
    try {
        const { getPool } = require('./dbHelper.cjs');
        const pool = getPool();
        await pool.query(
            `INSERT INTO "InvitedPhone" (phone, name, source_group, invited_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (phone) DO NOTHING`,
            [phone, name || '', sourceGroup || '']
        );
    } catch (err) {
        console.error('[GroupInviter] Failed to save invited phone:', err.message);
    }
}

// Load on startup
loadInvitedPhonesFromDB();

function resetIfNeeded() {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
        console.log(`[GroupInviter] Daily reset — sent ${sendCount} invites yesterday`);
        sentToday.clear();
        sendCount = 0;
        lastResetDate = today;
    }
}

function buildInviteMessage(name) {
    const communityLink = shop.whatsappCommunityLink || shop.whatsappGroupLink;
    return `🎉 *Welcome to Smile & Supplies!*

Hi ${name}! 👋

We noticed you're part of our local community and wanted to introduce ourselves.

*Who we are:*
📍 Mullipothana 96, Kandy Road, Trincomalee District
🕐 Open 8:00 AM – 8:00 PM (Every day)
📧 smileandsupplies@outlook.com

*What we offer:*
📱 Phone accessories — cases, chargers, earphones, screen guards
🍳 Kitchen accessories — cookware, storage, utensils
🏠 Home essentials — organizers, decor, utilities
👶 Kids' items — toys, school supplies, accessories
📚 Stationery — notebooks, pens, art supplies
💄 Cosmetics — skincare, makeup, personal care
🎁 Gifts & ornaments — birthday, wedding, special occasions
🖨️ Photocopy & printing — documents, banners, cards

*Why join our community?*
✅ Daily deals & flash sales
✅ New product announcements
✅ Exclusive member discounts
✅ Direct ordering via WhatsApp
✅ Island-wide delivery 🚚

*How to order:*
1. Browse our catalog: *"Show [category]"*
2. Add items: *"add 2 [product]"*
3. Checkout: *"checkout"*
4. Bank transfer to BOC 95733864
5. Send deposit slip to confirm
6. We deliver island-wide! 🚚

*Bank Details:*
🏦 BOC (Bank of Ceylon)
Account: 95733864
Name: N K W Khan

📞 Contact: ${shop.phoneNumbers.join(' | ')}

👇 *Tap below to join our WhatsApp Community:*
${communityLink}

See you there! 🛍️`;
}

async function extractAndInvite(sock, sourceGroupJid, sourceGroupName) {
    console.log(`[GroupInviter] Extracting members from "${sourceGroupName}"...`);

    let members = [];
    try {
        const metaData = await sock.groupMetadata(sourceGroupJid);
        members = metaData.participants || [];
        console.log(`[GroupInviter] Found ${members.length} members in "${sourceGroupName}"`);
    } catch (e) {
        console.error(`[GroupInviter] Failed to get group metadata: ${e.message}`);
        return { success: false, error: e.message };
    }

    // Filter out: bot itself, owners, already invited
    const ownerNumbers = ['0719336848', '0779336848', '0750204698'];
    const eligible = members.filter(m => {
        const phone = m.id.replace(/@.*$/, '').replace(/[^0-9]/g, '');
        if (!phone || phone.length < 8) return false;
        if (ownerNumbers.some(o => phone.includes(o))) return false;
        if (invitedPhones.has(phone)) return false;
        if (sentToday.has(phone)) return false;
        return true;
    });

    console.log(`[GroupInviter] ${eligible.length} eligible members to invite`);

    // Queue all eligible members
    for (const member of eligible) {
        const phone = member.id.replace(/@.*$/, '').replace(/[^0-9]/g, '');
        pendingInvites.push({
            jid: member.id,
            phone,
            name: phone, // Will use phone as name since we don't have pushName
            sourceGroup: sourceGroupName
        });
    }

    if (!isProcessing) processQueue(sock);

    return { success: true, totalMembers: members.length, eligible: eligible.length, queued: pendingInvites.length };
}

async function queueInvite(sock, senderJid, pushName) {
    resetIfNeeded();

    const phone = senderJid.replace(/@.*$/, '').replace(/[^0-9]/g, '');
    if (!phone || phone.length < 8) return { success: false, reason: 'invalid_phone' };
    if (invitedPhones.has(phone)) return { success: false, reason: 'already_invited' };
    if (sentToday.has(phone)) return { success: false, reason: 'already_invited_today' };
    if (sendCount >= DAILY_LIMIT) return { success: false, reason: 'daily_limit_reached', remaining: getRemaining() };

    pendingInvites.push({ jid: senderJid, phone, name: pushName || phone, sourceGroup: 'message' });
    console.log(`[GroupInviter] Queued ${pushName || phone} (${pendingInvites.length} pending, ${sendCount}/${DAILY_LIMIT} used today)`);

    if (!isProcessing) processQueue(sock);

    return { success: true, queued: true, position: pendingInvites.length, remaining: getRemaining() };
}

async function processQueue(sock) {
    if (isProcessing || pendingInvites.length === 0) return;
    isProcessing = true;

    while (pendingInvites.length > 0 && sendCount < DAILY_LIMIT) {
        const invite = pendingInvites.shift();
        resetIfNeeded();
        if (sendCount >= DAILY_LIMIT) {
            console.log(`[GroupInviter] Daily limit reached (${DAILY_LIMIT}). ${pendingInvites.length} remaining for tomorrow.`);
            break;
        }

        const msg = buildInviteMessage(invite.name);

        try {
            console.log(`[GroupInviter] Sending invite to ${invite.name} (${invite.phone}) from "${invite.sourceGroup}"...`);
            await sock.sendMessage(invite.jid, { text: msg });
            sentToday.add(invite.phone);
            invitedPhones.add(invite.phone);
            sendCount++;
            // Save to DB for permanent dedup (survives bot restart)
            await saveInvitedPhoneToDB(invite.phone, invite.name, invite.sourceGroup);
            console.log(`[GroupInviter] ✅ Sent to ${invite.name} (${sendCount}/${DAILY_LIMIT} today)`);
        } catch (e) {
            console.error(`[GroupInviter] ❌ Failed to send to ${invite.name}: ${e.message}`);
            if (e.message?.includes('not found') || e.message?.includes('blocked')) {
                console.log(`[GroupInviter] ${invite.name} may have blocked the bot. Skipping.`);
            }
        }

        if (pendingInvites.length > 0) {
            const delay = SEND_DELAY_MS + Math.random() * 25000;
            console.log(`[GroupInviter] Waiting ${(delay / 1000).toFixed(0)}s before next DM (${pendingInvites.length} remaining)...`);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    isProcessing = false;
    console.log(`[GroupInviter] Queue complete. Sent ${sendCount}/${DAILY_LIMIT} today.`);
}

function getStats() {
    resetIfNeeded();
    return {
        sentToday: sendCount,
        dailyLimit: DAILY_LIMIT,
        remaining: getRemaining(),
        pending: pendingInvites.length,
        isProcessing,
        totalInvited: invitedPhones.size
    };
}

setInterval(resetIfNeeded, 60 * 60 * 1000);

module.exports = { extractAndInvite, queueInvite, getStats, canSend, getRemaining };

function canSend() {
    resetIfNeeded();
    return sendCount < DAILY_LIMIT;
}

function getRemaining() {
    resetIfNeeded();
    return Math.max(0, DAILY_LIMIT - sendCount);
}
