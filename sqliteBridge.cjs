const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS "AppUser" (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT, role TEXT, banned INTEGER DEFAULT 0, banReason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "Settings" (id TEXT PRIMARY KEY, business_name TEXT, contact_phone TEXT, address TEXT, logo_url TEXT, currency TEXT, receipt_note TEXT, return_days_limit INTEGER, return_conditions TEXT);
CREATE TABLE IF NOT EXISTS "Supplier" (id TEXT PRIMARY KEY, name TEXT, phone TEXT, hotline TEXT, worker_mobile TEXT, contact_person TEXT, category TEXT, email TEXT, address TEXT, bank_name TEXT, account_number TEXT, branch TEXT);
CREATE TABLE IF NOT EXISTS "Product" (id TEXT PRIMARY KEY, name TEXT, barcode TEXT, sku TEXT, cost REAL DEFAULT 0, price REAL DEFAULT 0, stock REAL DEFAULT 0, category TEXT, transport_cost REAL DEFAULT 0, margin_type TEXT, margin_value REAL DEFAULT 0, warranty_years INTEGER DEFAULT 0, warranty_unit TEXT, warranty_cost REAL DEFAULT 0, warranty_price REAL DEFAULT 0, has_warranty INTEGER DEFAULT 0, description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "Customer" (id TEXT PRIMARY KEY, name TEXT, phone TEXT UNIQUE, nic TEXT, address TEXT, total_loan REAL DEFAULT 0, total_paid REAL DEFAULT 0, balance REAL DEFAULT 0, language TEXT DEFAULT 'en', tags TEXT DEFAULT '[]', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "Bill" (id TEXT PRIMARY KEY, invoice_number TEXT UNIQUE, date TEXT, customer_id TEXT, customer_name TEXT, subtotal REAL DEFAULT 0, total_cost REAL DEFAULT 0, total_profit REAL DEFAULT 0, discount REAL DEFAULT 0, total REAL DEFAULT 0, cash_received REAL DEFAULT 0, change_returned REAL DEFAULT 0, payment_type TEXT, due_date TEXT, archived INTEGER DEFAULT 0, summary_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "BillItem" (id TEXT PRIMARY KEY, bill_id TEXT, product_id TEXT, name TEXT, sku TEXT, quantity REAL DEFAULT 0, cost REAL DEFAULT 0, price REAL DEFAULT 0, profit REAL DEFAULT 0, warranty INTEGER DEFAULT 0, warranty_years INTEGER DEFAULT 0, warranty_unit TEXT, warranty_price REAL DEFAULT 0, warranty_cost REAL DEFAULT 0, discount_type TEXT, discount_value REAL DEFAULT 0, returned_quantity REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS "ReturnRecord" (id TEXT PRIMARY KEY, bill_id TEXT, product_id TEXT, product_name TEXT, quantity REAL DEFAULT 0, refund_value REAL DEFAULT 0, refund_cost REAL DEFAULT 0, refund_profit REAL DEFAULT 0, payment_type TEXT, customer_id TEXT, customer_name TEXT, date TEXT, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "Expense" (id TEXT PRIMARY KEY, category TEXT, amount REAL DEFAULT 0, date TEXT, note TEXT, archived INTEGER DEFAULT 0, summary_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "MonthlySummary" (id TEXT PRIMARY KEY, month INTEGER, year INTEGER, total_sales REAL DEFAULT 0, total_profit REAL DEFAULT 0, total_expenses REAL DEFAULT 0, net_profit REAL DEFAULT 0, date_closed TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "PurchaseOrder" (id TEXT PRIMARY KEY, supplier_id TEXT, supplier_name TEXT, date TEXT, items TEXT, total_cost REAL DEFAULT 0, paid_amount REAL DEFAULT 0, discount_amount REAL DEFAULT 0, payment_method TEXT, status TEXT, transport_cost REAL DEFAULT 0, transport_paid_external INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "Payment" (id TEXT PRIMARY KEY, customer_id TEXT, amount REAL DEFAULT 0, date TEXT, note TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "SupplierPayment" (id TEXT PRIMARY KEY, supplier_id TEXT, purchase_order_id TEXT, amount REAL DEFAULT 0, date TEXT, note TEXT, payment_method TEXT, cheque_number TEXT, cheque_date TEXT, cheque_status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "ProductRequest" (id TEXT PRIMARY KEY, item_name TEXT, quantity REAL DEFAULT 1, customer_id TEXT, customer_name TEXT, customer_phone TEXT, note TEXT, status TEXT DEFAULT 'OPEN', ordered_purchase_order_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "WhatsAppMessage" (id TEXT PRIMARY KEY, from_number TEXT, to_number TEXT, text TEXT, type TEXT, method TEXT, timestamp TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS "GroupProduct" (id TEXT PRIMARY KEY, name TEXT, cost REAL DEFAULT 0, price REAL DEFAULT 0, stock REAL DEFAULT 0, category TEXT, description TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
`;

const OPTIONAL_COLUMNS = {
  Customer: [
    ['language', "TEXT DEFAULT 'en'"],
    ['tags', "TEXT DEFAULT '[]'"]
  ],
  Bill: [
    ['due_date', 'TEXT']
  ],
  ReturnRecord: [
    ['product_name', 'TEXT'],
    ['customer_name', 'TEXT']
  ],
  PurchaseOrder: [
    ['updated_at', 'TEXT DEFAULT CURRENT_TIMESTAMP']
  ]
};

function splitSqlStatements(sql) {
  return String(sql)
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);
}

function normalizeValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value) || (value && typeof value === 'object')) return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value ?? null;
}

function normalizeRows(rows) {
  return rows.map((row) => {
    const normalized = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === 'count' || key.endsWith('_count')) {
        normalized[key] = Number(value);
      } else {
        normalized[key] = value;
      }
    }
    return normalized;
  });
}

function translateSql(sql, params = []) {
  const translatedParams = [];
  let text = String(sql);

  text = text.replace(/(\S+)\s*=\s*ANY\(\$(\d+)::text\[\]\)/gi, (_match, column, index) => {
    const values = params[Number(index) - 1] || [];
    if (!Array.isArray(values) || values.length === 0) return '1 = 0';
    translatedParams.push(...values.map(normalizeValue));
    return `${column} IN (${values.map(() => '?').join(', ')})`;
  });

  text = text
    .replace(/DEFAULT\s+NOW\(\)/gi, 'DEFAULT CURRENT_TIMESTAMP')
    .replace(/NOW\(\)::date::text/gi, "date('now')")
    .replace(/NOW\(\)/gi, "datetime('now')")
    .replace(/\$(\d+)::timestamp/gi, (_match, index) => {
      translatedParams.push(normalizeValue(params[Number(index) - 1]));
      return '?';
    })
    .replace(/\$(\d+)::text\[\]/gi, (_match, index) => {
      translatedParams.push(normalizeValue(params[Number(index) - 1]));
      return '?';
    })
    .replace(/\bTIMESTAMP WITH TIME ZONE\b/gi, 'TEXT')
    .replace(/\bTIMESTAMP\b/gi, 'TEXT')
    .replace(/\bJSONB\b/gi, 'TEXT')
    .replace(/\bBOOLEAN\b/gi, 'INTEGER')
    .replace(/\bNUMERIC\b/gi, 'REAL')
    .replace(/\bILIKE\b/gi, 'LIKE')
    .replace(/\bTRUE\b/g, '1')
    .replace(/\bFALSE\b/g, '0');

  text = text.replace(/\$(\d+)/g, (_match, index) => {
    translatedParams.push(normalizeValue(params[Number(index) - 1]));
    return '?';
  });

  return { text, params: translatedParams };
}

class SqliteBridge {
  constructor({ app }) {
    this.app = app;
    this.db = null;
    this.SQL = null;
    this.dbPath = path.join(app.getPath('userData'), 'data', 'wr-pos.sqlite');
    this.ready = this.init();
  }

  async init() {
    const dataDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    this.SQL = await initSqlJs({
      locateFile: (file) => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file)
    });

    if (fs.existsSync(this.dbPath)) {
      this.db = new this.SQL.Database(fs.readFileSync(this.dbPath));
    } else {
      this.db = new this.SQL.Database();
    }

    this.db.run('PRAGMA foreign_keys = ON');
    this.db.run(SQLITE_SCHEMA);
    this.ensureOptionalColumns();
    this.save();
  }

  ensureOptionalColumns() {
    for (const [table, columns] of Object.entries(OPTIONAL_COLUMNS)) {
      const existing = new Set();
      const info = this.db.exec(`PRAGMA table_info("${table}")`);
      if (info[0]) {
        const nameIndex = info[0].columns.indexOf('name');
        for (const row of info[0].values) existing.add(row[nameIndex]);
      }

      for (const [name, definition] of columns) {
        if (!existing.has(name)) {
          this.db.run(`ALTER TABLE "${table}" ADD COLUMN ${name} ${definition}`);
        }
      }
    }
  }

  save() {
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  async query(sql, params = []) {
    await this.ready;

    const statements = splitSqlStatements(sql);
    let rows = [];
    let rowCount = 0;
    let changed = false;

    for (const statement of statements) {
      const { text, params: statementParams } = translateSql(statement, params);
      const upper = text.trim().toUpperCase();

      if (upper === 'BEGIN') {
        continue;
      }
      if (upper === 'COMMIT') {
        this.save();
        continue;
      }
      if (upper === 'ROLLBACK') {
        continue;
      }

      const stmt = this.db.prepare(text);
      try {
        if (statementParams.length) stmt.bind(statementParams);

        const statementRows = [];
        while (stmt.step()) {
          statementRows.push(stmt.getAsObject());
        }

        const modified = this.db.getRowsModified();
        rowCount = statementRows.length || modified || rowCount;
        rows = statementRows.length ? statementRows : rows;
        changed = changed || modified > 0 || /^(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE)\b/i.test(upper);
      } finally {
        stmt.free();
      }
    }

    if (changed) this.save();
    return { rows: normalizeRows(rows), rowCount };
  }

  connect() {
    return {
      query: (text, params) => this.query(text, params),
      release: async () => undefined
    };
  }

  async end() {
    await this.ready;
    this.save();
    this.db.close();
  }
}

module.exports = { SqliteBridge };
