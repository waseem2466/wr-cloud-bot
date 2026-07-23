/**
 * Cart Manager — WR POS WhatsApp Bot
 * In-memory per-chat cart with 30-min auto-expiry.
 */

const carts = new Map(); // chatJid → { items: [...], updatedAt: Date }
const CART_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getCart(chatJid) {
    cleanExpired();
    if (!carts.has(chatJid)) {
        carts.set(chatJid, { items: [], updatedAt: new Date() });
    }
    return carts.get(chatJid);
}

function addToCart(chatJid, product, quantity = 1) {
    const cart = getCart(chatJid);
    const existing = cart.items.find(i => i.name.toLowerCase() === product.name.toLowerCase());
    if (existing) {
        existing.quantity += quantity;
    } else {
        cart.items.push({
            name: product.name,
            price: product.price,
            quantity,
            stock: product.stock || 0,
            category: product.category || ''
        });
    }
    cart.updatedAt = new Date();
    return cart;
}

function removeFromCart(chatJid, productName) {
    const cart = getCart(chatJid);
    const idx = cart.items.findIndex(i => i.name.toLowerCase().includes(productName.toLowerCase()));
    if (idx === -1) return { removed: false };
    const removed = cart.items.splice(idx, 1)[0];
    cart.updatedAt = new Date();
    return { removed: true, item: removed };
}

function updateQuantity(chatJid, productName, quantity) {
    const cart = getCart(chatJid);
    const item = cart.items.find(i => i.name.toLowerCase().includes(productName.toLowerCase()));
    if (!item) return { updated: false };
    if (quantity <= 0) {
        return removeFromCart(chatJid, productName);
    }
    item.quantity = quantity;
    cart.updatedAt = new Date();
    return { updated: true, item };
}

function clearCart(chatJid) {
    carts.delete(chatJid);
}

function getCartTotal(chatJid) {
    const cart = getCart(chatJid);
    return cart.items.reduce((sum, i) => sum + (i.price * i.quantity), 0);
}

function getCartSummary(chatJid) {
    const cart = getCart(chatJid);
    if (cart.items.length === 0) return null;

    const lines = cart.items.map((i, idx) =>
        `${idx + 1}. ${i.name} x ${i.quantity} = Rs. ${(i.price * i.quantity).toLocaleString()}`
    );
    const total = getCartTotal(chatJid);

    return {
        text: lines.join('\n'),
        total,
        itemCount: cart.items.length,
        items: [...cart.items]
    };
}

function cleanExpired() {
    const now = Date.now();
    for (const [jid, cart] of carts) {
        if (now - cart.updatedAt.getTime() > CART_TTL_MS) {
            carts.delete(jid);
        }
    }
}

// Clean every 5 minutes
setInterval(cleanExpired, 5 * 60 * 1000);

module.exports = {
    addToCart,
    removeFromCart,
    updateQuantity,
    getCart,
    clearCart,
    getCartTotal,
    getCartSummary
};
