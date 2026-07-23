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
    // Return null so Groq AI handles all customer conversations, greetings, and queries naturally
    return null;
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

    // Step 2: Provider chain (Groq primary — fast & free)
    const allProviders = ['groq', 'gemini', 'openrouter'];
    let chain = mode === 'auto' ? ['groq', 'gemini', 'openrouter'] : [mode, ...allProviders.filter(p => p !== mode)];

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
