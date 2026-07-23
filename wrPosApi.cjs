/**
 * WR POS REST API — Cloud Bot
 * Shared API layer for WhatsApp bot + future web frontend.
 * Mount on the existing HTTP server in server.js.
 */

const dbHelper = require('./dbHelper.cjs');
const cartManager = require('./cartManager.cjs');

function jsonReply(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(data));
}

function parseBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', chunk => { body += chunk; if (body.length > 1024 * 1024) { req.destroy(); reject(new Error('Too large')); } });
        req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new Error('Invalid JSON')); } });
        req.on('error', reject);
    });
}

function matchRoute(method, url, pattern, reqMethod) {
    if (reqMethod !== method) return null;
    const patternParts = pattern.split('/');
    const urlParts = url.split('/');
    if (patternParts.length !== urlParts.length) return null;
    const params = {};
    for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
            params[patternParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
        } else if (patternParts[i] !== urlParts[i]) return null;
    }
    return params;
}

async function handleRequest(req, res) {
    const url = req.url.split('?')[0];
    const method = req.method;

    // CORS preflight
    if (method === 'OPTIONS') {
        res.writeHead(200, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        });
        res.end();
        return true;
    }

    let params;

    // ═══════════ PRODUCTS ═══════════

    // GET /api/products?q=rice
    if ((params = matchRoute('GET', url, '/api/products', method))) {
        const query = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
        if (query.length < 2) return jsonReply(res, 200, { products: [] });
        const products = await dbHelper.searchInventory(query);
        return jsonReply(res, 200, { products, count: products.length });
    }

    // GET /api/products/:id
    if ((params = matchRoute('GET', url, '/api/products/:id', method))) {
        const product = await dbHelper.getProductByName(params.id);
        if (!product) return jsonReply(res, 404, { error: 'Product not found' });
        return jsonReply(res, 200, { product });
    }

    // GET /api/categories
    if ((params = matchRoute('GET', url, '/api/categories', method))) {
        const categories = await dbHelper.getAllCategories();
        return jsonReply(res, 200, { categories, count: categories.length });
    }

    // GET /api/categories/:name/products
    if ((params = matchRoute('GET', url, '/api/categories/:name/products', method))) {
        const products = await dbHelper.getProductsByCategory(params.name);
        return jsonReply(res, 200, { products, count: products.length, category: params.name });
    }

    // ═══════════ CART ═══════════

    // GET /api/cart/:sessionId
    if ((params = matchRoute('GET', url, '/api/cart/:sessionId', method))) {
        const summary = cartManager.getCartSummary(params.sessionId);
        if (!summary) return jsonReply(res, 200, { cart: { items: [], total: 0, itemCount: 0 } });
        return jsonReply(res, 200, { cart: summary });
    }

    // POST /api/cart/:sessionId/add  { name, quantity }
    if ((params = matchRoute('POST', url, '/api/cart/:sessionId/add', method))) {
        const body = await parseBody(req);
        const { name, quantity = 1 } = body;
        if (!name) return jsonReply(res, 400, { error: 'Product name required' });
        const products = await dbHelper.searchInventory(name);
        if (products.length === 0) return jsonReply(res, 404, { error: `Product "${name}" not found` });
        const product = products[0];
        if (product.stock < quantity) return jsonReply(res, 400, { error: `Only ${product.stock} in stock`, stock: product.stock });
        cartManager.addToCart(params.sessionId, product, quantity);
        const summary = cartManager.getCartSummary(params.sessionId);
        return jsonReply(res, 200, { success: true, message: `Added ${quantity}x ${product.name}`, cart: summary });
    }

    // POST /api/cart/:sessionId/remove  { name }
    if ((params = matchRoute('POST', url, '/api/cart/:sessionId/remove', method))) {
        const body = await parseBody(req);
        const { name } = body;
        if (!name) return jsonReply(res, 400, { error: 'Product name required' });
        const result = cartManager.removeFromCart(params.sessionId, name);
        if (!result.removed) return jsonReply(res, 404, { error: `"${name}" not in cart` });
        const summary = cartManager.getCartSummary(params.sessionId);
        return jsonReply(res, 200, { success: true, message: `Removed ${result.item.name}`, cart: summary });
    }

    // POST /api/cart/:sessionId/update  { name, quantity }
    if ((params = matchRoute('POST', url, '/api/cart/:sessionId/update', method))) {
        const body = await parseBody(req);
        const { name, quantity } = body;
        if (!name || quantity === undefined) return jsonReply(res, 400, { error: 'Name and quantity required' });
        const result = cartManager.updateQuantity(params.sessionId, name, quantity);
        if (!result.updated) return jsonReply(res, 404, { error: `"${name}" not in cart` });
        const summary = cartManager.getCartSummary(params.sessionId);
        return jsonReply(res, 200, { success: true, cart: summary });
    }

    // DELETE /api/cart/:sessionId
    if ((params = matchRoute('DELETE', url, '/api/cart/:sessionId', method))) {
        cartManager.clearCart(params.sessionId);
        return jsonReply(res, 200, { success: true, message: 'Cart cleared' });
    }

    // ═══════════ CHECKOUT ═══════════

    // POST /api/checkout  { sessionId, customerName, customerPhone, paymentType }
    if ((params = matchRoute('POST', url, '/api/checkout', method))) {
        const body = await parseBody(req);
        const { sessionId, customerName = 'Customer', customerPhone = '', paymentType = 'CASH' } = body;
        if (!sessionId) return jsonReply(res, 400, { error: 'Session ID required' });
        const summary = cartManager.getCartSummary(sessionId);
        if (!summary || summary.items.length === 0) return jsonReply(res, 400, { error: 'Cart is empty' });
        const result = await dbHelper.createWhatsAppOrder(customerName, customerPhone, summary.items, paymentType);
        if (result.success) {
            cartManager.clearCart(sessionId);
            return jsonReply(res, 200, {
                success: true,
                invoiceNumber: result.invoiceNumber,
                total: result.total,
                items: summary.items,
                message: `Order #${result.invoiceNumber} placed successfully`
            });
        }
        return jsonReply(res, 500, { error: result.error });
    }

    // ═══════════ ORDERS ═══════════

    // GET /api/orders/:phone
    if ((params = matchRoute('GET', url, '/api/orders/:phone', method))) {
        const orders = await dbHelper.getOrdersByPhone(params.phone);
        return jsonReply(res, 200, { orders, count: orders.length });
    }

    // ═══════════ CUSTOMER ═══════════

    // GET /api/customer/:phone
    if ((params = matchRoute('GET', url, '/api/customer/:phone', method))) {
        const customer = await dbHelper.getCustomerByPhone(params.phone);
        if (!customer) return jsonReply(res, 404, { error: 'Customer not found' });
        return jsonReply(res, 200, { customer });
    }

    // ═══════════ HEALTH ═══════════

    // GET /api/health
    if ((params = matchRoute('GET', url, '/api/health', method))) {
        try {
            const p = dbHelper.getPool();
            await p.query('SELECT 1');
            return jsonReply(res, 200, { status: 'ok', database: 'connected', timestamp: new Date().toISOString() });
        } catch (e) {
            return jsonReply(res, 500, { status: 'error', database: 'disconnected', error: e.message });
        }
    }

    return false; // Not handled
}

module.exports = { handleRequest };
