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

    // Popular / best sellers — "popular", "best sellers", "top products", "trending"
    if (/\b(popular|best.?seller|top.?product|trending|most.?sold|hot.?item|recommend)\b/i.test(t))
        return 'POPULAR';

    // New arrivals — "new arrivals", "new products", "latest", "just arrived", "new in"
    if (/\b(new.?arrivals?|new.?products?|latest|just.?arrived|new.?in|recently.?added)\b/i.test(t))
        return 'NEW_ARRIVALS';

    // Pagination — "next", "more", "show more", "page 2", "previous", "back"
    if (/\b(next|more|show.?more|page\s*\d+|further|continue)\b/i.test(t))
        return 'NEXT_PAGE';
    if (/\b(previous|prev|back|go.?back|page.?up)\b/i.test(t))
        return 'PREV_PAGE';

    // ─── CART INTENTS (must come before ORDER) ────────────────────────────
    // Checkout — "checkout", "place order", "confirm order", "pay now"
    if (/\b(checkout|check.?out|place.*order|confirm.*order|pay.*now|done.*shopping|finish.*buying)\b/.test(t))
        return 'CHECKOUT';

    // View cart — "show cart", "my cart", "what's in my cart", "cart"
    if (/\b(show\s*cart|my\s*cart|what.?s?\s+in\s+my\s+cart|view\s*cart|open\s*cart|cart|basket|bag)\b/.test(t))
        return 'VIEW_CART';

    // Clear cart — "clear cart", "empty cart", "remove all"
    if (/\b(clear\s*cart|empty\s*cart|remove\s*all|reset\s*cart|start\s*over)\b/.test(t))
        return 'CLEAR_CART';

    // Remove from cart — "remove rice", "remove rice from cart"
    if (/\b(remove|delete|drop)\s+(?:from\s+cart\s+)?(.+)/.test(t))
        return 'REMOVE_FROM_CART';

    // Add to cart — "add 2 rice", "add rice to cart", "buy 3 paint"
    if (/\b(?:add|buy|get|want|need)\s+\d*\s*\w+/.test(t) && /\b(cart|basket|bag|to\s+cart)\b/.test(t))
        return 'ADD_TO_CART';
    if (/\b(?:add|buy)\s+\d+\s+\w+/.test(t))
        return 'ADD_TO_CART';

    // Place order (direct) — "I need 2 cement", "order 5 paint"
    if (/\b(?:need|want|order)\s+\d+/.test(t) || /\b(?:need|want|order)\s+.*?\s+\d+/.test(t))
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

    // Order tracking — "where is my order", "order status", "track"
    if (/\b(where.*order|order.*status|track.*order|delivery|shipping|my.*order)\b/.test(t))
        return 'ORDER_TRACKING';

    // Payment reminder inquiry — "when to pay", "due date", "reminder"
    if (/\b(due|overdue|remind|reminder|when.*pay|pay.*date|due.*date|late)\b/.test(t))
        return 'PAYMENT_DUE';

    // Multi-language Sinhala/Tamil keywords
    // Sinhala: greetings, prices, products
    if (/\b(ආයුබෝවන්|හලෝ|මොකක්ද|කීයද|ගන්න|ඕන|තියෙනවා|ප්‍රයිස්)\b/.test(t))
        return 'GENERAL';
    // Tamil: greetings, prices, products
    if (/\b(வணக்கம்|எவ்வளவு|விலை|வேணும்|இருக்கா|கிடைக்கும்|பொருள்)\b/.test(t))
        return 'GENERAL';

    // Supplier inquiries — "who is your supplier", "where do you get products", "do you have suppliers"
    if (/\b(supplier|vendor|provider|distributor|wholesale|source|where.*get|where.*buy|where.*stock|who.*supply)\b/.test(t))
        return 'SUPPLIER_INQUIRY';

    // Stock availability — "do you have rice", "is rice available", "check stock"
    if (/\b(do you have|is.*available|check stock|in stock|out of stock|have.*in stock)\b/.test(t))
        return 'STOCK_CHECK';

    // Join group — "add me to group", "join group", "group link"
    if (/\b(add\s+me\s+to\s+group|join\s+(?:the\s+)?group|group\s+link|want\s+to\s+join|enter\s+group)\b/.test(t))
        return 'JOIN_GROUP';

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
