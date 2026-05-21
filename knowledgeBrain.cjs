const fs = require('fs');
const path = require('path');
const dbHelper = require('./dbHelper.cjs');

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');

// Cache for loaded knowledge
let knowledgeCache = [];
let dbCache = [];
let lastLoadTime = 0;

function loadLocalKnowledge() {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
        fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
        return [];
    }

    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => /\.(md|txt|json)$/i.test(f));
    knowledgeCache = [];
    
    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf-8');
            knowledgeCache.push({ file, content, lines: content.split('\n').length });
        } catch (err) {
            console.error(`[Brain] Failed to load ${file}:`, err.message);
        }
    }
    return knowledgeCache;
}

async function loadDbKnowledge() {
    const p = typeof dbHelper.getPool === 'function' ? dbHelper.getPool() : null;
    if (!p) return [];
    try {
        const res = await p.query(`SELECT title, content, category FROM "Knowledge" ORDER BY updated_at DESC`);
        dbCache = res.rows.map(r => ({ source: `DB:${r.title} (${r.category})`, content: r.content }));
        console.log(`[Brain] Loaded ${dbCache.length} records from DB`);
        return dbCache;
    } catch (err) {
        console.error('[Brain] DB load failed:', err.message);
        return [];
    }
}

function loadKnowledge() {
    loadLocalKnowledge();
    loadDbKnowledge();
    lastLoadTime = Date.now();
}

async function searchKnowledge(query, maxResults = 3) {
    if (!query || query.length < 3) return null;
    
    await loadDbKnowledge(); // Always check DB for latest updates
    const q = query.toLowerCase();
    const results = [];

    const allDocs = [
        ...knowledgeCache.map(d => ({ source: d.file, content: d.content })),
        ...dbCache
    ];

    for (const doc of allDocs) {
        const lines = doc.content.split('\n');
        const relevantLines = [];
        for (const line of lines) {
            if (line.toLowerCase().includes(q) || q.includes(line.toLowerCase().split(':')[0])) {
                relevantLines.push(line.trim());
            }
        }
        if (relevantLines.length > 0) {
            results.push({
                source: doc.source,
                snippets: relevantLines.slice(0, 3),
                relevance: relevantLines.length
            });
        }
    }

    return results.sort((a, b) => b.relevance - a.relevance).slice(0, maxResults);
}

async function getContextString(query) {
    const results = await searchKnowledge(query);
    if (!results || results.length === 0) return '';

    let context = `## INTERNAL KNOWLEDGE BASE:\n`;
    for (const r of results) {
        context += `\n### From ${r.source}:\n- ${r.snippets.join('\n- ')}\n`;
    }
    return context;
}

async function saveToDb(title, content, category = 'General') {
    const p = typeof dbHelper.getPool === 'function' ? dbHelper.getPool() : null;
    if (!p) return { success: false, error: 'DB not ready' };
    const id = `know_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    try {
        await p.query(`INSERT INTO "Knowledge" (id, title, content, category, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW(), NOW())`, [id, title, content, category]);
        console.log(`[Brain] Saved new knowledge to DB: ${title}`);
        loadDbKnowledge();
        return { success: true, id };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// Initial load
loadKnowledge();

module.exports = { searchKnowledge, getContextString, saveToDb, loadKnowledge };
