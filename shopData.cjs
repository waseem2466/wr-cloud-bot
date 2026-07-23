// shopData.js — WR Smile & Supplies business information
// Used by aiReply.js for keyword-based instant replies
module.exports = {
    shopName: "Smile & Supplies",
    tagline: "Explore, shop, and enjoy quality products at affordable prices.",
    address: "Mullipothana 96, Kandy Road, Trincomalee District",
    phoneNumbers: ["0719336848", "0779336848"],
    email: "smileandsupplies@outlook.com",
    products: [
        "📱 Phone accessories — cases, chargers, earphones, screen guards",
        "🍳 Kitchen accessories — cookware, storage, utensils",
        "🏠 Home essentials — organizers, decor, utilities",
        "👶 Kids' items — toys, school supplies, accessories",
        "📚 Stationery — notebooks, pens, art supplies",
        "💄 Cosmetics — skincare, makeup, personal care",
        "🎁 Gifts & ornaments — birthday, wedding, special occasions",
        "🖨️ Photocopy & printing — documents, banners, cards"
    ],
    productCategories: ["Phone Accessories", "Kitchen", "Home Essentials", "Kids", "Stationery", "Cosmetics", "Gifts", "Printing"],
    openingHours: "8:00 AM – 8:00 PM (Every day)",
    bankDetails: {
        bank: "BOC (Bank of Ceylon)",
        account: "95733864",
        name: "N K W Khan"
    },
    greetings: [
        "Assalamu Alaikum! 🌟 Welcome to Smile & Supplies. How can we help you today?",
        "Hello! 😊 Welcome to Smile & Supplies. We're happy to assist you!",
        "Hey there! 👋 Welcome to Smile & Supplies. What are you looking for today?",
        "Hi! 🛍️ Welcome to Smile & Supplies. Browse our products or ask me anything!"
    ],
    replies: {
        offers: "🎉 We have amazing discounts this week! Visit us at Mullipothana 96, Kandy Road or call 0719336848 for details.",
        products: `🛍️ *Smile & Supplies* — We offer:\n• 📱 Phone accessories\n• 🍳 Kitchen accessories\n• 🏠 Home essentials\n• 👶 Kids' items\n• 📚 Stationery\n• 💄 Cosmetics\n• 🎁 Gifts & ornaments\n• 🖨️ Photocopy & printing\n\nSend *"Show [category]"* to browse our catalog!`,
        hours: "🕐 Our shop is open *8:00 AM – 8:00 PM every day*. We look forward to seeing you!",
        location: "📍 Find us at *Mullipothana 96, Kandy Road, Trincomalee District*.\n📞 Call: 0719336848 | 0779336848\n📧 Email: smileandsupplies@outlook.com",
        contact: "📞 Contact us:\n• 0719336848\n• 0779336848\n📧 smileandsupplies@outlook.com\n📍 Mullipothana 96, Kandy Road, Trincomalee",
        thanks: "You're welcome! 🙏 We're always happy to help. Visit Smile & Supplies anytime!",
        goodbye: "Thank you for contacting Smile & Supplies! 🌟 Have a wonderful day. Come visit us soon! 🛍️",
        policy: "⚠️ *Return Policy*: Multi-item returns are accepted within 3 days of purchase. Please keep your receipt! 🧾",
        delivery: "🚚 We offer island-wide delivery! Payment via bank transfer (BOC: 95733864). Send your deposit slip to confirm your order.",
        community: "🌟 Join our WhatsApp Community for daily product updates and special offers!\n\n👇 Tap below to join:\nhttps://chat.whatsapp.com/G2sFie5DaUHL4XyY2oGEbP"
    },
    whatsappGroupLink: "https://chat.whatsapp.com/G2sFie5DaUHL4XyY2oGEbP",
    whatsappCommunityLink: "https://chat.whatsapp.com/G2sFie5DaUHL4XyY2oGEbP",
    faqs: [
        { q: "Do you offer delivery?", a: "Yes! We offer island-wide delivery via courier. Payment via bank transfer (BOC: 95733864). Send your deposit slip to confirm." },
        { q: "Do you have Cash on Delivery (COD)?", a: "No, we do not offer Cash on Delivery. Payment must be made via Bank Transfer before shipping." },
        { q: "What payment methods do you accept?", a: "We accept Cash (in-store) and Bank Transfer for deliveries.\n\n🏦 BOC (Bank of Ceylon)\nAccount: 95733864\nName: N K W Khan\n\nPlease send your deposit slip to our WhatsApp." },
        { q: "Where is the shop located?", a: "We are located at Mullipothana 96, Kandy Road, Trincomalee District." },
        { q: "How can I join your group?", a: "Join our WhatsApp Community for daily updates!\n👇\nhttps://chat.whatsapp.com/G2sFie5DaUHL4XyY2oGEbP" },
        { q: "What products do you sell?", a: "We sell Phone accessories, Kitchen items, Home essentials, Kids' items, Stationery, Cosmetics, Gifts, and Printing services. Send 'Show [category]' to browse!" },
        { q: "What are your opening hours?", a: "We're open 8:00 AM – 8:00 PM every day including weekends!" },
        { q: "Can I order via WhatsApp?", a: "Yes! Browse our products, add items to cart, and checkout directly via WhatsApp. It's easy!" }
    ],
    smartReplies: {
        // Price inquiry patterns
        priceInquiry: "💰 To check prices, send *\"Show [category]\"* (e.g., Show Kitchen) or ask me about a specific product!",
        stockInquiry: "📦 To check stock, ask me about a specific product or send *\"Show [category]\"* to browse available items.",
        orderHelp: "🛒 To order:\n1. Browse: *\"Show [category]\"*\n2. Add: *\"add 2 [product]\"*\n3. Cart: *\"show cart\"*\n4. Checkout: *\"checkout\"*\n\nIt's that easy!",
        joinGroup: "🌟 Join our WhatsApp Community for daily deals!\n👇\nhttps://chat.whatsapp.com/G2sFie5DaUHL4XyY2oGEbP",
        paymentInfo: "🏦 *Payment Details:*\n\nBank: BOC (Bank of Ceylon)\nAccount: 95733864\nName: N K W Khan\n\nSend deposit slip to confirm your order!"
    }
};
