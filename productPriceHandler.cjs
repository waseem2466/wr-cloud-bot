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

async function handlePriceQuery(text) {
    const patterns = [
        /(?:price|cost|rate).*?(?:of|for|on)?\s+(.+?)(?:\?|$)/i,
        /how much.*?(?:for|is)?\s+(.+?)(?:\?|$)/i,
        /(?:do you sell|have you got)\s+(.+?)(?:\?|$)/i,
    ];
    let productName = null;
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) { productName = match[1].trim(); break; }
    }
    if (!productName || productName.length < 2) return { handled: false };
    const result = await getProductDetails(productName);
    return { handled: !!result?.found, reply: result?.formatted, product: result?.product };
}

async function handleAvailabilityQuery(text) {
    const patterns = [
        /(?:do you have|is there|got|stock|available)\s+(.+?)(?:\?|$)/i,
        /(.+?)\s+(?:in stock|available)(?:\?|$)/i
    ];
    let productName = null;
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (match && match[1]) { productName = match[1].trim(); break; }
    }
    if (!productName || productName.length < 2) return { handled: false };
    const result = await getProductDetails(productName);
    return { handled: !!result?.found, reply: result?.formatted, product: result?.product };
}

module.exports = { getProductDetails, handlePriceQuery, handleAvailabilityQuery };