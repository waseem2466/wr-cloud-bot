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

// ─── Smart Keyword Matching (instant, free, contextual) ─────────────────────

function getKeywordReply(text) {
    const t = String(text || '').toLowerCase().trim();

    // Greetings
    if (/\b(hi|hello|hey|good morning|good afternoon|good evening|morning|evening|afternoon)\b/.test(t) ||
        /\b(assalamu|alaikum|salam|vanakkam|ayubowan|namaste|hallo|hai)\b/.test(t) ||
        /^(hi|hey|hello|helo|hii|hiiii|heyy)[\s!?.]*$/.test(t)) {
        return `👋 Hello! Welcome to *${shop.shopName}*! 😊\n\nHow can I help you today?\n• Type *"Show [category]"* to browse items (e.g. *Show Mobile*)\n• Type *"popular"* to see best sellers\n• Or ask any questions about our products!`;
    }

    // Opening hours
    if (/\b(hour|time|open|close|timing|working|when|what time)\b/.test(t)) {
        return `🕐 *Our Opening Hours:*\n${shop.openingHours}\n\nWe are open Monday to Saturday. Visit us or order right here on WhatsApp!`;
    }

    // Location / directions
    if (/\b(location|address|where|direction|map|find you|how to get|which road|near)\b/.test(t)) {
        return `📍 *Our Shop Address:*\n${shop.address}\n\nNear Kandy Road, Mullipothana. Call us at ${shop.phoneNumbers[0]} if you need directions!`;
    }

    // Contact info
    if (/\b(contact|phone|number|call|reach|mobile)\b/.test(t)) {
        return `📞 *Contact Us:*\nPhone: ${shop.phoneNumbers.join(' | ')}\nEmail: ${shop.email}\nAddress: ${shop.address}`;
    }

    // Bank details / payment
    if (/\b(bank|account|pay|payment|transfer|deposit|boc)\b/.test(t)) {
        return `🏦 *Bank Transfer Details:*\nBank: ${shop.bankDetails.bank}\nAccount: *${shop.bankDetails.account}*\nAccount Name: *${shop.bankDetails.name}*\n\nPlease send a screenshot of the payment slip here once transferred! ✅`;
    }

    // Delivery / shipping
    if (/\b(deliver|shipping|ship|courier|post|send|dispatch)\b/.test(t)) {
        return `🚚 *Island-wide Delivery Available!*\nWe deliver across Sri Lanka via registered courier. Payment is required via bank transfer before dispatch. Reply with your location and items needed!`;
    }

    // WhatsApp Group
    if (/\b(group|link|join|community|follow|updates|channel)\b/.test(t)) {
        return `🌟 Join our official WhatsApp group for daily product updates and special offers!\n\nClick here: ${shop.whatsappGroupLink || shop.whatsappCommunityLink}`;
    }

    // Thank you
    if (/\b(thank|thanks|thank you|thx|appreciate|shukriya|நன்றி|ස්තූතියි)\b/.test(t)) {
        return `You're very welcome! 😊 Always happy to assist. Let us know if you need anything else!`;
    }

    return null;
}

// ─── Zhipu AI Provider (glm-4-flash — High Reliability) ────────────────────

async function callZhipu(text, systemPrompt) {
    const apiKey = (typeof process !== 'undefined' && (process.env.ZHIPU_API_KEY || process.env.VITE_ZHIPU_AI_API_KEY)) || '';
    if (!apiKey) throw new Error('No Zhipu API key');

    const model = process.env.ZHIPU_MODEL || 'glm-4-flash';
    console.log(`[AI] Calling Zhipu AI (${model})...`);

    const res = await fetch('https://open.bigmodel.cn/api/paas/v4/chat/completions', {
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
            max_tokens: 300
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Zhipu failed (${res.status}): ${errText}`);
    }
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content;
    if (!reply) throw new Error('No response from Zhipu');
    return reply;
}

// ─── Groq Provider (free, fast) ──────────────────────────────────────────────

async function callGroq(text, systemPrompt) {
    const apiKey = (typeof process !== 'undefined' && (process.env.GROQ_API_KEY || process.env.VITE_GROQ_API_KEY)) || '';
    if (!apiKey) throw new Error('No Groq API key');

    const modelsToTry = [
        'openai/gpt-oss-120b',
        'openai/gpt-oss-20b',
        'groq/compound-mini',
        process.env.GROQ_MODEL
    ].filter(Boolean);

    for (const model of [...new Set(modelsToTry)]) {
        try {
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
                    max_tokens: 300
                })
            });

            if (!res.ok) {
                const errText = await res.text();
                console.warn(`[AI] Groq ${model} failed (${res.status}): ${errText}`);
                continue;
            }
            const data = await res.json();
            let reply = data.choices?.[0]?.message?.content;
            if (reply) {
                reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                if (reply) return reply;
            }
        } catch (e) {
            console.warn(`[AI] Groq error on ${model}:`, e.message);
        }
    }
    throw new Error('All Groq models failed');
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

YOU ARE THE WHATSAPP BRAIN OF THE WR POS SYSTEM:
- The shop runs on the WR POS desktop app (billing, customers, suppliers, expenses, warranties, marketing).
- You can see LIVE data: exact product prices & stock, customer account balances, and recent invoices.
- When LIVE INVENTORY DATA or CUSTOMER FINANCIAL STATUS is provided below, ALWAYS use those exact numbers. NEVER guess or say "check with us" when real data is present.
- If a customer asks about their account/loan/balance, give a warm, clear summary of what they owe and how to pay.
- Be a smart salesperson: if a product is low in stock, mention it and suggest acting fast.

IMPORTANT RULES:
1. ALWAYS be warm, polite, and enthusiastic
2. Reply in the SAME LANGUAGE the customer uses (Sinhala, Tamil, or English)
3. Keep replies under 4 sentences unless more detail is needed
4. ALWAYS include relevant commands (like "Show [category]") when discussing products
5. Use emojis to make replies engaging
6. If needed, guide them to "Show [category]" — but if LIVE inventory shows the item, give the exact price
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
- Price questions → Give exact price if LIVE inventory available, else guide to "Show [category]"
- Stock questions → Give exact stock if LIVE inventory available, else guide to "Show [category]"
- "Balance / my loan / what I owe" → Give their exact outstanding balance, paid, and total from CUSTOMER FINANCIAL STATUS
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

    // Step 2: Provider chain (Groq primary -> Zhipu AI -> OpenRouter)
    const allProviders = ['groq', 'zhipu', 'openrouter'];
    let chain = mode === 'auto' ? ['groq', 'zhipu', 'openrouter'] : [mode, ...allProviders.filter(p => p !== mode)];

    console.log(`[AI] Provider chain: ${chain.join(' -> ')}`);

    // Step 3: Try each provider
    for (const provider of chain) {
        try {
            if (provider === 'groq') {
                const res = await callGroq(text, currentSystemPrompt);
                if (res && res.trim()) {
                    console.log(`[AI] Groq success.`);
                    return res;
                }
            }
            if (provider === 'zhipu') {
                const res = await callZhipu(text, currentSystemPrompt);
                if (res && res.trim()) {
                    console.log(`[AI] Zhipu success.`);
                    return res;
                }
            }
            if (provider === 'openrouter') {
                const res = await callOpenRouter(text, currentSystemPrompt);
                if (res && res.trim()) {
                    console.log(`[AI] OpenRouter success.`);
                    return res;
                }
            }
        } catch (err) {
            console.warn(`[AI] ${provider} failed: ${err.message}`);
        }
    }

    // Step 4: Intelligent offline fallback if all cloud APIs temporarily fail
    const fallback = getKeywordReply(text);
    if (fallback) {
        console.log('[AI] Emergency fallback reply served.');
        return fallback;
    }

    return `👋 Hello from *${shop.shopName}*!\n\nHow can I help you today?\n• Send *"Show [category]"* (e.g. *Show Mobile*) to browse products\n• Call us directly at ${shop.phoneNumbers[0]}\n• Visit us at ${shop.address} 📍`;
}

module.exports = { aiReply, getKeywordReply };
