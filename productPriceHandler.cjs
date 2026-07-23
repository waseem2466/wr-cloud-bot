const { searchInventory } = require('./dbHelper.cjs');

async function getProductDetails(query) {
    if (!query || query.length < 2) return null;
    try {
        const products = await searchInventory(query);
        if (products.length === 0) return { found: false };
        if (products.length === 1) {
            const p = products[0];
            return {
                found: true, single: true, product: p,
                formatted: `*${p.name}*\nPrice: Rs. ${p.price}\nStock: ${p.stock}\nCategory: ${p.category}`
            };
        }
        return {
            found: true, multiple: true, products: products.slice(0, 3),
            formatted: products.slice(0, 3).map((p, i) =>
                `${i + 1}. *${p.name}* - Rs. ${p.price} (Stock: ${p.stock})`
            ).join('\n')
        };
    } catch (err) {
        return { found: false };
    }
}

function extractSearchTerms(text) {
    const stopWords = new Set(['i','a','an','the','is','it','am','to','for','of','in','on','at','by','with','and','or','but','not','do','does','did','have','has','had','can','will','want','need','buy','get','some','please','me','my','you','your','how','much','what','which','where','who','are','this','that','there','here','all','any','each','every','just','now','also','very','too','price','rate','cost','stock','available','hello','hi','hey','thanks','thank','bye']);
    return text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length >= 3 && !stopWords.has(w));
}

async function smartProductSearch(text) {
    const patterns = [
        /(?:price|cost|rate).*?(?:of|for|on)?\s+(.+?)(?:\?|$)/i,
        /how much.*?(?:for|is)?\s+(.+?)(?:\?|$)/i,
        /(?:do you have|is there|got|stock|available|sell|carry)\s+(.+?)(?:\?|$)/i,
        /(.+?)\s+(?:price|cost|rate|in stock|available)(?:\?|$)/i,
        /(?:need|want|buy|looking for|after)\s+(?:\d+\s+)?(.+?)(?:\?|$)/i,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1] && match[1].trim().length >= 2) {
            const result = await getProductDetails(match[1].trim());
            if (result?.found) return result;
        }
    }
    const terms = extractSearchTerms(text);
    for (const term of terms) {
        const result = await getProductDetails(term);
        if (result?.found) return result;
    }
    return null;
}

async function handlePriceQuery(text) {
    const result = await smartProductSearch(text);
    if (result?.found) {
        return { handled: true, reply: result.formatted, product: result.product };
    }
    return { handled: false };
}

async function handleAvailabilityQuery(text) {
    const result = await smartProductSearch(text);
    if (result?.found) {
        return { handled: true, reply: result.formatted, product: result.product };
    }
    return { handled: false };
}

module.exports = { getProductDetails, handlePriceQuery, handleAvailabilityQuery };