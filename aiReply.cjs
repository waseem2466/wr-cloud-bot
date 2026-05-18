/**
 * AI Reply Engine — WR Smile & Supplies WhatsApp Bot
 * Priority: 1) Shop keyword match (instant, free)
 *           2) Google Gemini (primary AI)
 *           3) Ollama Cloud (fallback)
 */
require('dotenv').config(); // Load .env keys (works both standalone and in Electron)
const shop = require('./shopData.cjs');
const fetch = require('node-fetch');
const brain = require('./knowledgeBrain.cjs');

// ─── Keyword Matching (free, instant) ────────────────────────────────────────

function getKeywordReply(text) {
    const t = text.toLowerCase();

    // Sinhala greeting
    if (/\b(ආයුබෝවන්|හලෝ|අයි)\b/.test(t))
        return `ආයුබෝවන්! 😊 WR smile and supplies වෙත සාදරයෙන් පිළිගනිමු. අපි ඔබට උදව් කරන්නේ කෙසේද?`;
    // Tamil greeting
    if (/\b(வணக்கம்|ஹலோ)\b/.test(t))
        return `வணக்கம்! 😊 WR smile and supplies க்கு வரவேற்கிறோம். நாங்கள் உங்களுக்கு எவ்வாறு உதவ முடியும்?`;

    if (/\b(hi|hello|hey|assalamu|alaikum|salam|good morning|good afternoon|good evening)\b/.test(t))
        return shop.greetings[Math.floor(Math.random() * shop.greetings.length)];

    if (/\b(offer|discount|sale|promo|deal|cheap|special)\b/.test(t))
        return shop.replies.offers;

    if (/\b(product|item|sell|available|what do you|stock|carry|have)\b/.test(t))
        return shop.replies.products;

    if (/\b(hour|time|open|close|timing|working|when)\b/.test(t))
        return shop.replies.hours;

    if (/\b(location|address|where|direction|map|find you|how to get)\b/.test(t))
        return shop.replies.location;

    if (/\b(contact|phone|number|call|reach|whatsapp)\b/.test(t))
        return shop.replies.contact;
    if (/\b(group|link|join|community|follow|updates)\b/.test(t))
        return `🌟 Join our official WhatsApp group for daily product updates and special offers! \n\nClick here to join: ${shop.whatsappGroupLink}`;

    if (/\b(thank|thanks|thank you|thx|appreciate)\b/.test(t))
        return shop.replies.thanks;

    if (/\b(bye|goodbye|see you|later|take care|ciao)\b/.test(t))
        return shop.replies.goodbye;

    return null;
}

// ─── Gemini Provider ──────────────────────────────────────────────────────────

async function callGemini(text, systemPrompt) {
    const apiKey = (typeof process !== 'undefined' &&
        (process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY)) || '';
    if (!apiKey) throw new Error('No Gemini API key');

    // Try flash-lite first (higher free-tier rate limits), fall back to flash
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

        // If rate-limited, try next model
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

// ─── Local Ollama Provider ───────────────────────────────────────────────────

async function callLocalOllama(text, systemPrompt) {
    const baseUrl = (typeof process !== 'undefined' && (process.env.OLLAMA_BASE_URL || process.env.VITE_OLLAMA_BASE_URL)) || 'http://127.0.0.1:11434';
    const model = (typeof process !== 'undefined' && (process.env.LOCAL_OLLAMA_MODEL || process.env.VITE_LOCAL_OLLAMA_MODEL)) || 'qwen2.5:3b';

    console.log(`[AI] Calling Local Ollama (${model}) at ${baseUrl}...`);
    try {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model,
                prompt: `${systemPrompt}\n\nCustomer says: ${text}`,
                stream: false,
                options: {
                    num_ctx: Number(process.env.LOCAL_OLLAMA_NUM_CTX || 1024),
                    num_predict: Number(process.env.LOCAL_OLLAMA_NUM_PREDICT || 80)
                }
            })
        });

        if (!res.ok) throw new Error(`Local Ollama failed with status ${res.status}`);
        const data = await res.json();
        const reply = data.response;
        if (!reply) throw new Error('No response from Local Ollama');
        return reply;
    } catch (err) {
        throw new Error(`Local Ollama connection failed: ${err.message}`);
    }
}

// ─── Groq Provider (free, fast, open-source models) ──────────────────────────

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
            max_tokens: 200
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

// ─── OpenRouter Provider (free, 28+ models, no credit card) ────────────────────

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
            max_tokens: 200
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

// ─── Ollama Cloud Provider ────────────────────────────────────────────────────

async function callOllamaCloud(text, systemPrompt) {
    const apiKey = (typeof process !== 'undefined' && process.env.VITE_OLLAMA_CLOUD_API_KEY) || '';
    const model = (typeof process !== 'undefined' && process.env.VITE_OLLAMA_CLOUD_MODEL) || 'gpt-oss:120b-cloud';
    if (!apiKey) throw new Error('No Ollama Cloud API key');

    console.log(`[AI] Calling Ollama Cloud (${model})...`);
    const res = await fetch('https://ollama.com/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
            model,
            messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
            stream: false
        })
    });
    if (!res.ok) throw new Error(`Ollama Cloud failed with status ${res.status}`);
    const data = await res.json();
    const reply = data.message?.content;
    if (!reply) throw new Error('No response from Ollama Cloud');
    return reply;
}

// ─── Main aiReply Function ────────────────────────────────────────────────────

const systemPrompt = `You are a helpful and friendly customer service assistant for "${shop.shopName}" located at ${shop.address}.
We sell: ${shop.products.join(', ')}.
Opening hours: ${shop.openingHours}.
Contact: ${shop.phoneNumbers.join(', ')}.
Reply politely, concisely, and in the same language the customer uses. Keep replies under 3 sentences.`;

/**
 * @param {string} text - customer message
 * @param {'gemini'|'ollama-cloud'|'local-ollama'|'auto'} mode - preferred provider
 * @param {string} inventoryContext - optional live inventory data
 * @param {string} financialContext - optional customer financial data (loan, balance)
 */
async function aiReply(text, mode = 'auto', inventoryContext = '', financialContext = '') {
    console.log(`[AI Engine] Received request. Mode: ${mode}, Text: "${text.substring(0, 50)}..."`);
    // Step 1: Instant keyword match (no API cost)
    const keywordReply = getKeywordReply(text);
    if (keywordReply && !inventoryContext && !financialContext) {
        console.log('[AI] Keyword match — instant reply.');
        return keywordReply;
    }

    const customerNameMatch = text.match(/^\(Customer: (.+?)\) /);
    const knownCustomer = customerNameMatch ? customerNameMatch[1] : '';
    const cleanText = customerNameMatch ? text.replace(customerNameMatch[0], '') : text;

    const customerLine = knownCustomer ? `\nThe customer's name is "${knownCustomer}". Address them by name when replying.` : '';

    const brainContext = brain.getContextString(text);

    const currentSystemPrompt = `You are a helpful and friendly customer service assistant for "${shop.shopName}" located at ${shop.address}.
    
IMPORTANT SHOP FAQs (Prioritize these answers):
${shop.faqs.map(f => `- Q: ${f.q} A: ${f.a}`).join('\n')}

WHATSAPP GROUP MONITORING:
- You monitor admin groups (like "Smile and Supplies") to automatically update your inventory from staff posts.
- If customers ask to join the group, share this link: ${shop.whatsappGroupLink}
- If asked about product categories, direct them: "Send 'Show [category]' to browse our catalog."

${inventoryContext ? `LIVE INVENTORY INFO:\n${inventoryContext}\nCRITICAL: You MUST tell the customer the exact price listed in the data. Never omit the price or say "check with us" if the price is available in the list above.` : ''}
${financialContext ? `CUSTOMER FINANCIAL STATUS:\n${financialContext}\nProvide a warm summary of their loan, paid amount, and current balance.` : (inventoryContext ? '' : `We sell: ${shop.products.join(', ')}.`)}
${brainContext}
Opening hours: ${shop.openingHours}.
Contact: ${shop.phoneNumbers.join(', ')}.
CRITICAL LANGUAGE RULE: Reply in the SAME LANGUAGE the customer wrote in — Sinhala (සිංහල), Tamil (தமிழ்), or English. Detect the language from their message and reply in it. Never mix languages.
Keep replies under 3 sentences. Be warm and polite.${customerLine}`;

    // Replace text with cleaned version (without customer prefix)
    text = cleanText;

    // Step 2: Build provider chain based on preferred mode
    const allProviders = ['gemini', 'groq', 'openrouter', 'ollama-cloud'];
    let chain = [];

    if (mode === 'auto') {
        chain = ['gemini', 'groq', 'openrouter'];
    } else {
        chain = [mode];
        allProviders.forEach(p => {
            if (!chain.includes(p)) chain.push(p);
        });
    }

    console.log(`[AI] No keyword match (or live context needed). Provider chain: ${chain.join(' -> ')}`);

    // Step 3: Try each provider in order
    for (const provider of chain) {
        try {
            if (provider === 'local-ollama') {
                const res = await callLocalOllama(text, currentSystemPrompt);
                console.log(`[AI Engine] Local Ollama success.`);
                return res;
            }
            if (provider === 'gemini') {
                const res = await callGemini(text, currentSystemPrompt);
                console.log(`[AI Engine] Gemini success.`);
                return res;
            }
            if (provider === 'groq') {
                const res = await callGroq(text, currentSystemPrompt);
                console.log(`[AI Engine] Groq success.`);
                return res;
            }
            if (provider === 'openrouter') {
                const res = await callOpenRouter(text, currentSystemPrompt);
                console.log(`[AI Engine] OpenRouter success.`);
                return res;
            }
            if (provider === 'ollama-cloud') {
                const res = await callOllamaCloud(text, currentSystemPrompt);
                console.log(`[AI Engine] Ollama Cloud success.`);
                return res;
            }
        } catch (err) {
            console.warn(`[AI] ${provider} failed: ${err.message}`);
        }
    }

    return `I'm sorry, I'm having trouble responding right now. Please call us at ${shop.phoneNumbers[0]} or visit us at ${shop.address}.`;
}

module.exports = { aiReply, getKeywordReply };

