/**
 * AI Reply Engine — WR Smile & Supplies WhatsApp Bot
 * Priority: 1) Smart keyword match (instant, free, contextual)
 *           2) Google Gemini (primary AI)
 *           3) Groq (fallback)
 *           4) OpenRouter (fallback)
 */
require('dotenv').config();
const shop = require('./shopData.cjs');
const fetch = require('node-fetch');
const brain = require('./knowledgeBrain.cjs');

// ─── Smart Keyword Matching (free, instant, contextual) ─────────────────────

function getKeywordReply(text) {
    const t = text.toLowerCase().trim();

    // ═══ GREETINGS (multiple languages) ═══
    if (/\b(ආයුබෝවන්|හලෝ|අයි)\b/.test(t))
        return `ආයුබෝවන්! 😊 Smile & Supplies වෙත සාදරයෙන් පිළිගනිමු. අපි ඔබට උදව් කරන්නේ කෙසේද?\n\n📱 Kitchen | 🏠 Home | 👶 Kids | 📚 Stationery | 💄 Cosmetics\n\n*"Show [category]"* යවන්න බලන්න.`;
    if (/\b(வணக்கம்|ஹலோ)\b/.test(t))
        return `வணக்கம்! 😊 Smile & Supplies க்கு வரவேற்கிறோம். நாங்கள் உங்களுக்கு எவ்வாறு உதவ முடியும்?\n\n📱 Kitchen | 🏠 Home | 👶 Kids | 📚 Stationery | 💄 Cosmetics\n\n*"Show [category]"* என்று அனுப்பவும்.`;

    if (/\b(hi|hello|hey|assalamu|alaikum|salam|good morning|good afternoon|good evening|gd morning|gm|ga|ge)\b/.test(t)) {
        const hour = new Date().getHours();
        let timeGreeting = '';
        if (hour < 12) timeGreeting = 'Good morning! ☀️';
        else if (hour < 17) timeGreeting = 'Good afternoon! 🌤️';
        else timeGreeting = 'Good evening! 🌙';
        return `${timeGreeting} Welcome to *Smile & Supplies*! 🛍️\n\nHow can I help you today?\n\n• Browse products: *"Show [category]"*\n• Check prices: Ask about any product\n• Join group: *"join group"*\n• Contact us: 0719336848`;
    }

    // ═══ PRODUCT BROWSING ═══
    if (/\b(product|item|sell|available|what do you|stock|carry|have|catalog|browse|shop)\b/.test(t)) {
        return `🛍️ *Smile & Supplies* — Your one-stop shop!\n\n📱 *Phone Accessories* — cases, chargers, earphones\n🍳 *Kitchen* — cookware, storage, utensils\n🏠 *Home Essentials* — organizers, decor\n👶 *Kids' Items* — toys, school supplies\n📚 *Stationery* — notebooks, pens, art\n💄 *Cosmetics* — skincare, makeup\n🎁 *Gifts* — birthday, wedding, special\n🖨️ *Printing* — documents, banners\n\n👉 Send *"Show [category]"* to browse!\nExample: *"Show Kitchen"* or *"Show Cosmetics"*`;
    }

    // ═══ SPECIFIC CATEGORY BROWSING ═══
    if (/\b(kitchen|cookware|utensil|pot|pan|knife)\b/.test(t))
        return `🍳 *Kitchen Accessories*\n\nBrowse all kitchen items:\n*"Show Kitchen"*\n\nWe have cookware, storage containers, utensils, and more!`;
    if (/\b(phone|charger|case|earphone|headphone|screen guard|cable|accessories)\b/.test(t))
        return `📱 *Phone Accessories*\n\nBrowse all phone items:\n*"Show Phone Accessories"*\n\nCases, chargers, earphones, screen guards & more!`;
    if (/\b(cosmetic|skincare|makeup|beauty|cream|lotion|soap)\b/.test(t))
        return `💄 *Cosmetics*\n\nBrowse all cosmetics:\n*"Show Cosmetics"*\n\nSkincare, makeup, personal care products!`;
    if (/\b(stationery|notebook|pen|pencil|paper|art|draw)\b/.test(t))
        return `📚 *Stationery*\n\nBrowse all stationery:\n*"Show Stationery"*\n\nNotebooks, pens, art supplies, and more!`;
    if (/\b(kid|child|toy|baby|school)\b/.test(t))
        return `👶 *Kids' Items*\n\nBrowse all kids' products:\n*"Show Kids"*\n\nToys, school supplies, accessories!`;
    if (/\b(gift|present|ornament|birthday|wedding|celebration)\b/.test(t))
        return `🎁 *Gifts & Ornaments*\n\nBrowse all gifts:\n*"Show Gifts"*\n\nBirthday, wedding, special occasion gifts!`;
    if (/\b(home|essential|organizer|decor|utility)\b/.test(t))
        return `🏠 *Home Essentials*\n\nBrowse all home items:\n*"Show Home Essentials"*\n\nOrganizers, decor, utilities!`;

    // ═══ PRICE INQUIRIES ═══
    if (/\b(price|rate|cost|how much|quote|fee|expensive|cheap|affordable)\b/.test(t)) {
        // Check if they mentioned a specific product
        const productMatch = t.match(/\b(price|rate|cost|how much)\s+(?:of|for|is)?\s*(.+?)(?:\?|$)/i);
        if (productMatch) {
            return `💰 To check the price of *"${productMatch[2].trim()}"*, send:\n*"Show [category]"* or ask me directly!\n\nExample: *"Show Kitchen"* to see kitchen products with prices.`;
        }
        return `💰 *Price Information*\n\nTo check prices:\n• Send *"Show [category]"* to see all products with prices\n• Ask about a specific product\n\nExample: *"Show Cosmetics"* or *"What's the price of rice cooker?"*`;
    }

    // ═══ ORDER HELP ═══
    if (/\b(order|buy|purchase|want to|need|get|cart|checkout|place order)\b/.test(t)) {
        if (/\b(how|help|guide|step|process|way)\b/.test(t) || t.length < 15) {
            return `🛒 *How to Order — It's Easy!*\n\n1️⃣ *Browse:* Send *"Show [category]"*\n2️⃣ *Add:* Send *"add 2 [product name]"*\n3️⃣ *Cart:* Send *"show cart"* to review\n4️⃣ *Checkout:* Send *"checkout"* to place order\n5️⃣ *Pay:* Bank transfer to BOC 95733864\n6️⃣ *Confirm:* Send deposit slip\n\nNeed help? Just ask! 😊`;
        }
    }

    // ═══ CART COMMANDS ═══
    if (/\b(cart|basket|bag|add|remove|checkout)\b/.test(t) && /\b(show|view|open|my|what|check|clear|empty)\b/.test(t))
        return null; // Let intent.cjs handle specific cart commands

    // ═══ PAYMENT / BANK ═══
    if (/\b(bank|payment|pay|transfer|deposit|boc|account|money|cash)\b/.test(t)) {
        return `🏦 *Payment Details:*\n\n*Bank:* BOC (Bank of Ceylon)\n*Account:* 95733864\n*Name:* N K W Khan\n\n✅ *How to pay:*\n1. Transfer the amount\n2. Take a screenshot of the deposit slip\n3. Send it to us on WhatsApp\n4. We'll confirm your order!\n\n⚠️ *No Cash on Delivery* — Bank transfer only for deliveries.`;
    }

    // ═══ DELIVERY ═══
    if (/\b(deliver|shipping|courier|post|send|ship|island|nationwide)\b/.test(t)) {
        return shop.smartReplies.delivery;
    }

    // ═══ LOCATION / ADDRESS ═══
    if (/\b(location|address|where|direction|map|find you|how to get|locate)\b/.test(t)) {
        return `📍 *Find Us:*\n\n*Smile & Supplies*\nMullipothana 96, Kandy Road\nTrincomalee District\n\n📞 0719336848 | 0779336848\n📧 smileandsupplies@outlook.com\n\n🕐 Open: 8:00 AM – 8:00 PM (Every day)`;
    }

    // ═══ CONTACT ═══
    if (/\b(contact|phone|number|call|reach|whatsapp|talk|speak)\b/.test(t)) {
        return `📞 *Contact Us:*\n\n📱 *Phone:* 0719336848 | 0779336848\n📧 *Email:* smileandsupplies@outlook.com\n📍 *Address:* Mullipothana 96, Kandy Road, Trincomalee\n\n🕐 Open: 8:00 AM – 8:00 PM (Every day)`;
    }

    // ═══ HOURS ═══
    if (/\b(hour|time|open|close|timing|working|when|schedule)\b/.test(t)) {
        return `🕐 *Opening Hours:*\n\n*8:00 AM – 8:00 PM*\n*Every day* (including weekends!)\n\n📍 Mullipothana 96, Kandy Road, Trincomalee\n📞 0719336848 | 0779336848`;
    }

    // ═══ GROUP / COMMUNITY ═══
    if (/\b(group|link|join|community|follow|updates|whatsapp group)\b/.test(t)) {
        return `🌟 *Join our WhatsApp Community!*\n\nGet daily product updates, flash sales, and exclusive offers!\n\n👇 *Tap below to join:*\n${shop.whatsappCommunityLink}\n\nSee you there! 🛍️`;
    }

    // ═══ OFFERS / DISCOUNTS ═══
    if (/\b(offer|discount|sale|promo|deal|cheap|special|coupon|code)\b/.test(t)) {
        return `🎉 *Special Offers!*\n\nWe have amazing deals running!\n\n👉 Browse our products for the latest prices:\n*"Show [category]"*\n\n📞 Call 0719336848 for exclusive deals!\n🌟 Join our group for flash sales:\n${shop.whatsappCommunityLink}`;
    }

    // ═══ RETURN / POLICY ═══
    if (/\b(return|refund|exchange|policy|warranty|guarantee|complaint)\b/.test(t)) {
        return `📋 *Our Policy:*\n\n✅ *Returns:* Multi-item returns accepted within 3 days\n🧾 *Receipt:* Please keep your receipt\n⚠️ *COD:* Not available — bank transfer only\n\n📞 For issues, call 0719336848`;
    }

    // ═══ THANKS ═══
    if (/\b(thank|thanks|thank you|thx|appreciate|nice|great|awesome|perfect|good|excellent)\b/.test(t)) {
        return `You're welcome! 🙏 We're always happy to help.\n\nVisit *Smile & Supplies* anytime!\n🛍️ Browse: *"Show [category]"*\n📞 Call: 0719336848`;
    }

    // ═══ GOODBYE ═══
    if (/\b(bye|goodbye|see you|later|take care|ciao|good night|gn)\b/.test(t)) {
        const hour = new Date().getHours();
        const farewell = hour < 17 ? 'Have a great day!' : 'Good night! 🌙';
        return `Thank you for contacting *Smile & Supplies*! 🌟\n\n${farewell}\n\n🛍️ Remember to browse our catalog:\n*"Show [category]"*\n📞 Call us: 0719336848`;
    }

    // ═══ COMPLAINT / PROBLEM ═══
    if (/\b(problem|issue|complaint|bad|worst|angry|unhappy|disappointed|broken|defect)\b/.test(t)) {
        return `😔 We're sorry to hear that. Your satisfaction is our priority!\n\n📞 Please call us directly:\n• 0719336848\n• 0779336848\n\nWe'll resolve this immediately. You can also visit us at Mullipothana 96, Kandy Road.`;
    }

    // ═══ QUALITY ═══
    if (/\b(quality|genuine|original|fake|real|branded|brand)\b/.test(t)) {
        return `✅ *Quality Guaranteed!*\n\nWe only sell genuine, high-quality products.\n\n📱 Phone accessories — Original & branded\n💄 Cosmetics — Trusted brands only\n🏠 Home essentials — Durable & reliable\n\nShop with confidence at *Smile & Supplies*!`;
    }

    // ═══ RECOMMEND / SUGGEST ═══
    if (/\b(recommend|suggest|best|top|popular|what should|which one|which is better)\b/.test(t)) {
        return `🌟 *Our Top Categories:*\n\n📱 *Phone Accessories* — Best-selling cases & chargers\n🍳 *Kitchen* — Popular cookware & utensils\n💄 *Cosmetics* — Trending skincare products\n\n👉 Send *"Show [category]"* to browse!\nOr tell me what you're looking for!`;
    }

    // ═══ BULK / WHOLESALE ═══
    if (/\b(bulk|wholesale|quantity|large order|many|10|20|50|100)\b/.test(t)) {
        return `📦 *Bulk Orders Welcome!*\n\nWe offer competitive prices for bulk purchases.\n\n📞 Contact us for bulk pricing:\n• 0719336848\n• 0779336848\n\nOr visit us at Mullipothana 96, Kandy Road.`;
    }

    // ═══ STOCK CHECK ═══
    if (/\b(do you have|is.*available|in stock|out of stock|stock available|any stock)\b/.test(t)) {
        const productMatch = t.match(/(?:do you have|is|check|any)\s+(.+?)(?:\s+available|\s+in stock|\?|$)/i);
        if (productMatch) {
            return `📦 To check if *"${productMatch[1].trim()}"* is in stock, send:\n*"Show [category]"*\n\nExample: *"Show Kitchen"* to see kitchen items with stock levels!`;
        }
        return `📦 *Check Stock*\n\nSend *"Show [category]"* to see products with stock levels.\n\nExample: *"Show Cosmetics"*`;
    }

    // ═══ SUPPLIER INQUIRY ═══
    if (/\b(supplier|vendor|provider|distributor|wholesale|source|where.*get|where.*buy)\b/.test(t)) {
        return `🏪 We work with trusted suppliers to bring you the best products!\n\nFor supplier inquiries, contact our owner:\n📞 0719336848\n\n🛒 Browse our products:\n*"Show [category]"*`;
    }

    // ═══ COMPETITOR / ALTERNATIVE ═══
    if (/\b(other shop|another shop|competitor|alternative|else|different shop)\b/.test(t)) {
        return `🛍️ *Why choose Smile & Supplies?*\n\n✅ Quality products at affordable prices\n✅ Wide range — 8+ categories\n✅ Island-wide delivery\n✅ WhatsApp ordering — easy & fast\n✅ Daily deals in our group\n\n👉 Join us: *"join group"*`;
    }

    return null; // No keyword match — let AI handle it
}

// ─── Gemini Provider ──────────────────────────────────────────────────────────

async function callGemini(text, systemPrompt) {
    const apiKey = (typeof process !== 'undefined' &&
        (process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY)) || '';
    if (!apiKey) throw new Error('No Gemini API key');

    const modelsToTry = [
        process.env.VITE_GEMINI_MODEL || 'gemini-2.0-flash-lite',
        'gemini-2.0-flash-lite',
        'gemini-2.0-flash'
    ];
    const uniqueModels = [...new Set(modelsToTry)];

    for (const model of uniqueModels) {
        console.log(`[AI] Calling Google Gemini (${model})...`);
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: `${systemPrompt}\n\nCustomer says: ${text}` }] }]
                })
            }
        );

        if (res.status === 429) {
            console.warn(`[AI] Gemini ${model} rate-limited (429), trying next model...`);
            continue;
        }

        if (!res.ok) throw new Error(`Gemini failed with status ${res.status}`);
        const data = await res.json();
        const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (reply) return reply;
        throw new Error('No response from Gemini');
    }

    throw new Error('All Gemini models rate-limited (429)');
}

// ─── Groq Provider (free, fast) ──────────────────────────────────────────────

async function callGroq(text, systemPrompt) {
    const apiKey = (typeof process !== 'undefined' && process.env.GROQ_API_KEY) || '';
    if (!apiKey) throw new Error('No Groq API key');

    const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
    console.log(`[AI] Calling Groq (${model})...`);

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            temperature: 0.7,
            max_tokens: 250
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Groq failed (${res.status}): ${errText}`);
    }
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) throw new Error('No response from Groq');
    return reply;
}

// ─── OpenRouter Provider (free, 28+ models) ──────────────────────────────────

async function callOpenRouter(text, systemPrompt) {
    const apiKey = (typeof process !== 'undefined' && process.env.OPENROUTER_API_KEY) || '';
    if (!apiKey) throw new Error('No OpenRouter API key');

    const model = process.env.OPENROUTER_MODEL || 'openrouter/auto';
    console.log(`[AI] Calling OpenRouter (${model})...`);

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'HTTP-Referer': 'https://wr-pos.app',
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: text }
            ],
            temperature: 0.7,
            max_tokens: 250
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenRouter failed (${res.status}): ${errText}`);
    }
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) throw new Error('No response from OpenRouter');
    return reply;
}

// ─── Main aiReply Function ────────────────────────────────────────────────────

const systemPrompt = `You are a BRILLIANT, friendly, and helpful customer service assistant for "${shop.shopName}" — a retail shop in Sri Lanka.

SHOP INFO:
📍 Address: ${shop.address}
📞 Phone: ${shop.phoneNumbers.join(' | ')}
📧 Email: ${shop.email}
🕐 Hours: ${shop.openingHours}

PRODUCT CATEGORIES:
${shop.products.join('\n')}

BANK DETAILS:
🏦 ${shop.bankDetails.bank}
Account: ${shop.bankDetails.account}
Name: ${shop.bankDetails.name}

IMPORTANT RULES:
1. ALWAYS be warm, polite, and enthusiastic
2. Reply in the SAME LANGUAGE the customer uses (Sinhala, Tamil, or English)
3. Keep replies under 4 sentences unless more detail is needed
4. ALWAYS include relevant commands (like "Show [category]") when discussing products
5. Use emojis to make replies engaging
6. If you don't know a specific price, guide them to "Show [category]"
7. NEVER say "I don't know" — always guide them to the right action
8. If they want to order, guide them through: Browse → Add to Cart → Checkout
9. For payment, always include bank details
10. For delivery, mention it's island-wide but payment must be bank transfer first

SHOPPING FLOW:
- Browse: "Show [category]"
- Add to cart: "add [qty] [product]"
- View cart: "show cart"
- Checkout: "checkout"
- Payment: Bank transfer to BOC 95733864

SMART RESPONSES:
- Price questions → Guide to "Show [category]"
- Stock questions → Guide to "Show [category]"
- Order questions → Explain the full flow
- Delivery questions → Mention island-wide + bank transfer
- Join group → Share link: ${shop.whatsappCommunityLink}

BE BRILLIANT: Anticipate what the customer needs. If they ask about one thing, suggest related products. Make shopping easy and fun!`;

/**
 * @param {string} text - customer message
 * @param {'gemini'|'groq'|'openrouter'|'auto'} mode - preferred provider
 * @param {string} inventoryContext - optional live inventory data
 * @param {string} financialContext - optional customer financial data
 */
async function aiReply(text, mode = 'auto', inventoryContext = '', financialContext = '') {
    console.log(`[AI Engine] Mode: ${mode}, Text: "${text.substring(0, 50)}..."`);

    // Step 1: Smart keyword match (instant, free)
    const keywordReply = getKeywordReply(text);
    if (keywordReply && !inventoryContext && !financialContext) {
        console.log('[AI] Smart keyword match — instant reply.');
        return keywordReply;
    }

    // Extract customer name if present
    const customerNameMatch = text.match(/^\(Customer: (.+?)\) /);
    const knownCustomer = customerNameMatch ? customerNameMatch[1] : '';
    const cleanText = customerNameMatch ? text.replace(customerNameMatch[0], '') : text;
    const customerLine = knownCustomer ? `\nThe customer's name is "${knownCustomer}". Address them by name.` : '';

    // Get knowledge brain context
    const brainContext = await brain.getContextString(text);

    const currentSystemPrompt = `${systemPrompt}

${inventoryContext ? `\nLIVE INVENTORY DATA:\n${inventoryContext}\nIMPORTANT: Always tell the customer the EXACT price from this data. Never say "check with us" if price is available.` : ''}
${financialContext ? `\nCUSTOMER FINANCIAL STATUS:\n${financialContext}\nProvide a warm summary of their loan, paid amount, and balance.` : ''}
${brainContext}
${customerLine}

RESPONSE STYLE:
- Be conversational and friendly
- Use bullet points for lists
- Include relevant commands in bold
- End with a helpful next step
- Match the customer's language`;

    text = cleanText;

    // Step 2: Provider chain
    const allProviders = ['gemini', 'groq', 'openrouter'];
    let chain = mode === 'auto' ? ['gemini', 'groq', 'openrouter'] : [mode, ...allProviders.filter(p => p !== mode)];

    console.log(`[AI] Provider chain: ${chain.join(' -> ')}`);

    // Step 3: Try each provider
    for (const provider of chain) {
        try {
            if (provider === 'gemini') {
                const res = await callGemini(text, currentSystemPrompt);
                console.log(`[AI] Gemini success.`);
                return res;
            }
            if (provider === 'groq') {
                const res = await callGroq(text, currentSystemPrompt);
                console.log(`[AI] Groq success.`);
                return res;
            }
            if (provider === 'openrouter') {
                const res = await callOpenRouter(text, currentSystemPrompt);
                console.log(`[AI] OpenRouter success.`);
                return res;
            }
        } catch (err) {
            console.warn(`[AI] ${provider} failed: ${err.message}`);
        }
    }

    return `I'm having trouble responding right now. Please call us at ${shop.phoneNumbers[0]} or visit us at ${shop.address}. 📞\n\nOr try:\n• *"Show [category]"* to browse products\n• *"join group"* for updates`;
}

module.exports = { aiReply, getKeywordReply };
