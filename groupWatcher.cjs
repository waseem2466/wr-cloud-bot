/**
 * Group Watcher — Auto-reads WhatsApp Group messages and extracts product data
 * 
 * When someone posts a product photo with price/details in the admin group,
 * the AI reads the image + caption, extracts product info, and saves it
 * to the WR POS inventory database SAFELY.
 * 
 * SAFETY: Only ADDS products or increases stock. Never deletes anything.
 * 
 * ─── WAMessage Technical Reference ───────────────────────────────────────────
 * Messages arrive as proto.IWebMessageInfo which contains:
 * 
 * 1. msg.key:
 *    - remoteJid: The chat ID (user@s.whatsapp.net or group@g.us)
 *    - fromMe: Boolean (true if we sent it)
 *    - id: Unique message ID
 *    - participant: The JID of the actual sender in a group (@g.us)
 * 
 * 2. msg.message:
 *    - conversation: Simple text message
 *    - extendedTextMessage: Text with links, mentions, or replies (metadata)
 *    - imageMessage / videoMessage: Media with captions and download URLs
 * 
 * 3. Handling Media:
 *    - If msg.message.imageMessage.url is missing, use sock.updateMediaMessage(msg)
 *    - Use downloadMediaMessage(msg, 'buffer') to get the raw file
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const dotenv = require('dotenv');

const { app } = require('electron');
const envPath = app && app.isPackaged
    ? path.join(process.resourcesPath, '.env')
    : path.join(__dirname, '.env');
dotenv.config({ path: envPath });

const { safeAddProduct, safeAddGroupProduct } = require('./inventoryManager.cjs');

// ─── Group Configuration ─────────────────────────────────────────────────────

// Groups this bot watches (by name substring, case-insensitive)
const WATCHED_GROUP_NAMES = (process.env.WATCHED_GROUPS || 'smile and supplies').split(',').map(g => g.trim().toLowerCase());

// Track which groups we've seen
const knownGroups = new Map(); // JID -> group name

/**
 * Check if a group JID belongs to a watched group
 */
function isWatchedGroup(groupJid, groupSubject = '') {
    if (!groupJid?.endsWith('@g.us')) return false;

    // Check cached name
    const cachedName = knownGroups.get(groupJid);
    const nameToCheck = (groupSubject || cachedName || '').toLowerCase();

    for (const watchedName of WATCHED_GROUP_NAMES) {
        if (nameToCheck.includes(watchedName)) {
            return true;
        }
    }
    return false;
}

/**
 * Register a group name for future lookups
 */
function registerGroup(groupJid, groupSubject) {
    if (groupJid && groupSubject) {
        knownGroups.set(groupJid, groupSubject);
        console.log(`[GroupWatcher] Registered group: ${groupSubject} (${groupJid})`);
    }
}

// ─── Image Processing ─────────────────────────────────────────────────────────

/**
 * Download image from Baileys message and convert to base64
 */
async function downloadImageFromBaileys(msg, sock) {
    try {
        const { downloadMediaMessage } = require('@whiskeysockets/baileys');

        if (!downloadMediaMessage) {
            console.warn('[GroupWatcher] downloadMediaMessage not found in Baileys');
            return null;
        }

        // 🟢 HANDLE MISSING MEDIA: If the media payload is missing (common in some sync cases),
        // we ask the socket to update/re-fetch the message metadata.
        let messageToDownload = msg;
        const imageMsg = msg.message?.imageMessage;
        if (imageMsg && !imageMsg.url && sock?.updateMediaMessage) {
            console.log('[GroupWatcher] Media URL missing, attempting updateMediaMessage...');
            messageToDownload = await sock.updateMediaMessage(msg);
        }

        const buffer = await downloadMediaMessage(messageToDownload, 'buffer', {});
        if (!buffer || buffer.length === 0) {
            console.warn('[GroupWatcher] Empty image buffer');
            return null;
        }

        const base64 = buffer.toString('base64');
        console.log(`[GroupWatcher] Image downloaded: ${(buffer.length / 1024).toFixed(1)}KB`);
        return base64;
    } catch (err) {
        console.error('[GroupWatcher] Image download error:', err.message);
        return null;
    }
}

/**
 * Use Gemini Vision to extract product details from an image
 */
async function extractProductFromImage(imageBase64, captionText = '') {
    const apiKey = process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
    if (!apiKey) {
        console.warn('[GroupWatcher] No Gemini API key for vision');
        return null;
    }

    const model = process.env.VITE_GEMINI_MODEL || 'gemini-2.0-flash-lite';

    const prompt = `You are reading a product photo posted in a shop's WhatsApp group.

Extract product information from BOTH the image AND the caption text below.

Caption text: "${captionText || 'No caption'}"

Return ONLY valid JSON with these fields. 
BE EXTREMELY CAREFUL WITH PRICES: Look for patterns like "500/=", "100/-", "Rs.50", or just numbers near product names.
Return ONLY valid JSON:
{
  "name": "product name",
  "price": 0,
  "cost": 0,
  "stock": 0,
  "category": "General",
  "description": "short description"
}

Rules:
- "name": The product name visible in the image or caption
- "price": Selling price if visible (number only, no currency symbol)
- "cost": Purchase/wholesale cost if visible (number only)
- "stock": Quantity if mentioned (default 1)
- "category": Best category guess (e.g., "Phone Accessories", "Kitchen", "Cosmetics", "Stationery")
- "description": One-line product description

If you cannot identify a product, return: {"name": null}
Do NOT include markdown code blocks. Return ONLY the JSON object.`;

    try {
        // Use Gemini 2.0 Flash which supports inline images
        const cleanBase64 = imageBase64.replace(/^data:image\/(png|jpeg|webp);base64,/, '');

        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt },
                            {
                                inlineData: {
                                    mimeType: 'image/jpeg',
                                    data: cleanBase64
                                }
                            }
                        ]
                    }]
                })
            }
        );

        if (!res.ok) {
            console.warn(`[GroupWatcher] Gemini Vision failed: ${res.status}`);
            return null;
        }

        const data = await res.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        // Extract JSON
        const jsonMatch = reply.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (!parsed.name) return null;
            console.log('[GroupWatcher] AI extracted product from image:', parsed);
            return parsed;
        }

        return null;
    } catch (err) {
        console.error('[GroupWatcher] Vision extraction error:', err.message);
        return null;
    }
}

/**
 * Use Gemini to extract product details from text-only messages
 */
async function extractProductFromText(text) {
    if (!text || text.length < 5) return null;

    // Quick check: does this text look like it contains product info?
    const hasProductIndicators = /\b(price|rs\.?|lkr|cost|\d+[-\/]=?|rupee|stock|qty|quantity|each|per|box|pack|pcs|pieces|available|wholesale|retail|val|=)\b/i.test(text)
        || /\d+\s*[xX×]\s*\d+/.test(text) // dimensions or quantities
        || /\d+\s*[-\/]\s*\d+/.test(text); // price ranges

    if (!hasProductIndicators) return null;

    const apiKey = process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '';
    if (!apiKey) return null;

    const model = process.env.VITE_GEMINI_MODEL || 'gemini-2.0-flash-lite';

    const prompt = `You are reading a WhatsApp group message from a shop supplier or owner.

Extract product information from this message:
"${text}"

Return ONLY valid JSON with these fields:
{
  "name": "product name",
  "price": 0,
  "cost": 0,
  "stock": 0,
  "category": "General",
  "description": "short description"
}

Rules:
- Only extract if this is clearly about a product with price/quantity info
- "price": selling price (number only)
- "cost": wholesale/cost price if mentioned (number only)
- "stock": quantity mentioned (default 1)
- If this is NOT a product message (just chatting), return: {"name": null}
- Do NOT include markdown. Return ONLY JSON.`;

    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            }
        );

        if (!res.ok) return null;

        const data = await res.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

        const jsonMatch = reply.match(/\{[\s\S]*?\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            if (!parsed.name) return null;
            console.log('[GroupWatcher] AI extracted product from text:', parsed);
            return parsed;
        }

        return null;
    } catch (err) {
        console.error('[GroupWatcher] Text extraction error:', err.message);
        return null;
    }
}

// ─── Main Group Message Handler ───────────────────────────────────────────────

/**
 * Process a message from a watched WhatsApp group.
 * Extracts product data from images/text and auto-saves to inventory.
 * 
 * @param {object} msg - Baileys message object
 * @param {object} sock - Baileys socket (for downloading media)
 * @returns {{ handled: boolean, reply?: string, product?: object }}
 */
async function handleGroupMessage(msg, sock) {
    try {
        const hasImage = !!msg?.message?.imageMessage;
        const caption = msg?.message?.imageMessage?.caption || '';
        const textBody = msg?.message?.conversation
            || msg?.message?.extendedTextMessage?.text
            || '';
        const messageText = caption || textBody;

        let productData = null;

        // Priority 1: Image with AI vision
        if (hasImage && sock) {
            console.log('[GroupWatcher] Processing image message...');
            const imageBase64 = await downloadImageFromBaileys(msg, sock);
            if (imageBase64) {
                productData = await extractProductFromImage(imageBase64, caption);
            }
        }

        // Priority 2: Text-only product info (if no image or image extraction failed)
        if (!productData && messageText) {
            productData = await extractProductFromText(messageText);
        }

        // No product found
        if (!productData || !productData.name) {
            return { handled: false };
        }

        // SAFELY add to GROUP inventory (not main inventory)
        console.log(`[GroupWatcher] 📦 Logging group item: ${productData.name}`);
        const result = await safeAddGroupProduct({
            name: productData.name,
            price: productData.price || 0,
            cost: productData.cost || 0,
            stock: productData.stock || 1,
            category: productData.category || 'General',
            description: productData.description || '',
        });

        if (result.success) {
            const statusEmoji = result.isUpdate ? '🔄' : '📝';
            const reply = `${statusEmoji} *Group Item Logged!*\n\n${result.message}\n_(This item is not in main inventory)_`;
            console.log(`[GroupWatcher] ✅ Group product logged: ${productData.name}`);
            return { handled: true, reply, product: productData };
        } else {
            console.error(`[GroupWatcher] ❌ Failed to save: ${result.error}`);
            return { handled: false, error: result.error };
        }
    } catch (err) {
        console.error('[GroupWatcher] Handler error:', err.message);
        return { handled: false, error: err.message };
    }
}

module.exports = {
    isWatchedGroup,
    registerGroup,
    handleGroupMessage,
    extractProductFromImage,
    extractProductFromText,
    knownGroups,
    WATCHED_GROUP_NAMES,
};
