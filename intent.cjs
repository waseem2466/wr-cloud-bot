/**
 * Intent Detection — WR Smile & Supplies WhatsApp Bot
 * Detects the customer's intent from their message text.
 */
function detectIntent(text) {
    const t = text.toLowerCase();

    // OWNER INVENTORY COMMANDS - Highest Priority
    if (/^add\s+/i.test(t.trim()))
        return 'OWNER_ADD_PRODUCT';
    if (/^(?:update|change|set)\s+price\s+/i.test(t.trim()))
        return 'OWNER_UPDATE_PRICE';
    if (/^(?:check|stock|how many)\s+/i.test(t.trim()))
        return 'OWNER_CHECK_STOCK';
    if (/^(?:list|show|all)\s+(?:products?|inventory|items?|stock)/i.test(t.trim()))
        return 'OWNER_LIST_PRODUCTS';

    // LOANS & OPENCLAW - High Priority
    if (/\b(loan|openclaw|open.?claw|advance|borrow|credit|loan amount|how much|can i get|openclaw amount)\b/.test(t))
        return 'LOAN_INQUIRY';

    // LOAN STATUS / BALANCE CHECK
    if (/\b(balance|owe|owed|due|payment|what.?owe|how much.?(owe|pay)|dues|pending payment)\b/.test(t))
        return 'BALANCE_CHECK';

    // Invoice / bill request
    if (/\b(invoice|bill|receipt|payment)\b/.test(t))
        return 'INVOICE';

    // Price / rate enquiry
    if (/\b(price|rate|cost|how much|quote|fee)\b/.test(t))
        return 'PRICE';

    // Product / item availability
    if (/\b(product|item|sell|available|stock|carry|have|do you|got)\b/.test(t))
        return 'PRODUCTS';

    // Browse category — "show kitchen items", "what phones", "list cosmetics"
    if (/\b(show|list|browse|display|catalog|what.*(?:have|sell)|categories?|items? in)\b/i.test(t))
        return 'BROWSE_CATEGORY';

    // Place order — "I need 2 cement", "order 5 paint", "want 3 rice"
    if (/\b(?:need|want|order|buy|get)\s+\d+/.test(t) || /\b(?:need|want|order|buy|get)\s+.*?\s+\d+/.test(t))
        return 'ORDER';

    // Opening hours
    if (/\b(hour|time|open|close|timing|working|when)\b/.test(t))
        return 'HOURS';

    // Location / address
    if (/\b(location|address|where|direction|map|find you)\b/.test(t))
        return 'LOCATION';

    // Contact / phone number
    if (/\b(contact|phone|number|call|reach)\b/.test(t))
        return 'CONTACT';

    // Offers / discounts
    if (/\b(offer|discount|sale|promo|deal|special)\b/.test(t))
        return 'OFFERS';

    // Phone number confirmation (digits only or confirmation phrases)
    if (/^\d{9,}$/.test(t.replace(/\D/g, '')) || /\b(yes|correct|that|confirm|right)\b/.test(t))
        return 'PHONE_CONFIRMATION';

    // Greetings
    if (/\b(hi|hello|hey|assalamu|alaikum|salam|good morning|good afternoon|good evening)\b/.test(t))
        return 'GREETING';

    // Thanks
    if (/\b(thank|thanks|thank you|thx|appreciate)\b/.test(t))
        return 'THANKS';

    // Goodbye
    if (/\b(bye|goodbye|see you|later|take care)\b/.test(t))
        return 'GOODBYE';

    return 'GENERAL';
}

module.exports = { detectIntent };
