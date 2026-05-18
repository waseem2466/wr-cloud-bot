const fs = require('fs');
const path = require('path');

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');

// Cache for loaded knowledge
let knowledgeCache = [];
let lastLoadTime = 0;

function loadKnowledge() {
    if (!fs.existsSync(KNOWLEDGE_DIR)) {
        fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
        return [];
    }

    const files = fs.readdirSync(KNOWLEDGE_DIR).filter(f => /\.(md|txt|json)$/i.test(f));
    knowledgeCache = [];
    lastLoadTime = Date.now();

    for (const file of files) {
        try {
            const content = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), 'utf-8');
            knowledgeCache.push({ file, content, lines: content.split('\n').length });
            console.log(`[Brain] Loaded: ${file} (${content.length} chars)`);
        } catch (err) {
            console.error(`[Brain] Failed to load ${file}:`, err.message);
        }
    }
    return knowledgeCache;
}

function searchKnowledge(query, maxResults = 3) {
    if (!query || query.length < 3) return null;
    
    // Reload if files are newer than cache
    if (fs.existsSync(KNOWLEDGE_DIR)) {
        const mtime = Math.max(...fs.readdirSync(KNOWLEDGE_DIR).map(f => {
            try { return fs.statSync(path.join(KNOWLEDGE_DIR, f)).mtimeMs; } catch { return 0; }
        }));
        if (mtime > lastLoadTime) loadKnowledge();
    }

    const q = query.toLowerCase();
    const results = [];

    for (const doc of knowledgeCache) {
        const lines = doc.content.split('\n');
        const relevantLines = [];
        for (const line of lines) {
            if (line.toLowerCase().includes(q) || q.includes(line.toLowerCase().split(':')[0])) {
                relevantLines.push(line.trim());
            }
        }
        if (relevantLines.length > 0) {
            results.push({
                source: doc.file,
                snippets: relevantLines.slice(0, 3), // Top 3 snippets
                relevance: relevantLines.length
            });
        }
    }

    return results.sort((a, b) => b.relevance - a.relevance).slice(0, maxResults);
}

function getContextString(query) {
    const results = searchKnowledge(query);
    if (!results || results.length === 0) return '';

    let context = `## INTERNAL KNOWLEDGE BASE:\n`;
    for (const r of results) {
        context += `\n### From ${r.source}:\n- ${r.snippets.join('\n- ')}\n`;
    }
    return context;
}

// Initial load
loadKnowledge();

module.exports = { searchKnowledge, getContextString, loadKnowledge };
