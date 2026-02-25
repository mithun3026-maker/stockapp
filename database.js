const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'stock.db'));
db.pragma('journal_mode = WAL');

// ==================== CREATE TABLES ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT UNIQUE NOT NULL,
    store_name TEXT NOT NULL,
    manager_name TEXT,
    manager_email TEXT,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id TEXT UNIQUE NOT NULL,
    product_name TEXT NOT NULL,
    category TEXT,
    unit TEXT DEFAULT 'Pcs',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS stock_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start_date TEXT NOT NULL,
    store_id TEXT NOT NULL,
    store_name TEXT,
    product_id TEXT NOT NULL,
    product_name TEXT,
    opening_stock REAL DEFAULT 0,
    received REAL DEFAULT 0,
    sold REAL DEFAULT 0,
    closing_calculated REAL DEFAULT 0,
    physical_count REAL DEFAULT 0,
    variance REAL DEFAULT 0,
    submitted_by TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(week_start_date, store_id, product_id)
  );

  CREATE TABLE IF NOT EXISTS submission_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    week_start_date TEXT NOT NULL,
    store_id TEXT NOT NULL,
    submitted_by TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    item_count INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_sub_week ON stock_submissions(week_start_date);
  CREATE INDEX IF NOT EXISTS idx_sub_store ON stock_submissions(store_id);
  CREATE INDEX IF NOT EXISTS idx_sub_week_store ON stock_submissions(week_start_date, store_id);
`);

// ==================== DATE HELPERS ====================
function getWeekStart(date) {
  const d = date ? new Date(date) : new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}

function getPreviousWeekStart(date) {
  const d = date ? new Date(date) : new Date();
  const day = d.getDay();
  d.setDate(d.getDate() - day - 7);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().split('T')[0];
}

function getAvailableWeeks() {
  const stmt = db.prepare(`
    SELECT DISTINCT week_start_date 
    FROM stock_submissions 
    ORDER BY week_start_date DESC 
    LIMIT 52
  `);
  return stmt.all().map(r => r.week_start_date);
}

// ==================== PREPARED STATEMENTS ====================
const storeOps = {
  getAll: db.prepare('SELECT * FROM stores WHERE is_active=1 ORDER BY store_name'),
  getById: db.prepare('SELECT * FROM stores WHERE store_id=?'),
  insert: db.prepare(`INSERT OR REPLACE INTO stores (store_id,store_name,manager_name,manager_email)
                       VALUES (@store_id,@store_name,@manager_name,@manager_email)`),
  update: db.prepare(`UPDATE stores SET store_name=@store_name, manager_name=@manager_name,
                       manager_email=@manager_email WHERE store_id=@store_id`),
  deactivate: db.prepare('UPDATE stores SET is_active=0 WHERE store_id=?')
};

const productOps = {
  getAll: db.prepare('SELECT * FROM products WHERE is_active=1 ORDER BY category, product_name'),
  getById: db.prepare('SELECT * FROM products WHERE product_id=?'),
  insert: db.prepare(`INSERT OR REPLACE INTO products (product_id,product_name,category,unit)
                       VALUES (@product_id,@product_name,@category,@unit)`),
  deactivate: db.prepare('UPDATE products SET is_active=0 WHERE product_id=?')
};

const submissionOps = {
  getByWeek: db.prepare('SELECT * FROM stock_submissions WHERE week_start_date=? ORDER BY store_name,product_name'),
  getByWeekStore: db.prepare('SELECT * FROM stock_submissions WHERE week_start_date=? AND store_id=? ORDER BY product_name'),
  getSubmittedStores: db.prepare(`
    SELECT DISTINCT store_id, store_name, submitted_by, MAX(submitted_at) as submitted_at
    FROM stock_submissions WHERE week_start_date=? GROUP BY store_id
  `),
  getLastWeekClosing: db.prepare(`
    SELECT product_id, physical_count, closing_calculated
    FROM stock_submissions WHERE week_start_date=? AND store_id=?
  `),
  upsert: db.prepare(`
    INSERT INTO stock_submissions
      (week_start_date,store_id,store_name,product_id,product_name,
       opening_stock,received,sold,closing_calculated,physical_count,variance,submitted_by)
    VALUES
      (@week_start_date,@store_id,@store_name,@product_id,@product_name,
       @opening_stock,@received,@sold,@closing_calculated,@physical_count,@variance,@submitted_by)
    ON CONFLICT(week_start_date,store_id,product_id) DO UPDATE SET
      opening_stock=@opening_stock, received=@received, sold=@sold,
      closing_calculated=@closing_calculated, physical_count=@physical_count,
      variance=@variance, submitted_by=@submitted_by, submitted_at=CURRENT_TIMESTAMP
  `),
  logSubmission: db.prepare('INSERT INTO submission_log (week_start_date,store_id,submitted_by,item_count) VALUES (?,?,?,?)')
};

// ==================== BULK SUBMIT (TRANSACTION) ====================
const bulkSubmit = db.transaction((items, weekStart, storeId, storeName, submittedBy) => {
  let count = 0;
  for (const item of items) {
    const opening = parseFloat(item.opening_stock) || 0;
    const received = parseFloat(item.received) || 0;
    const sold = parseFloat(item.sold) || 0;
    const physical = parseFloat(item.physical_count) || 0;
    const closingCalc = opening + received - sold;
    const variance = physical - closingCalc;

    submissionOps.upsert.run({
      week_start_date: weekStart,
      store_id: storeId,
      store_name: storeName,
      product_id: item.product_id,
      product_name: item.product_name,
      opening_stock: opening,
      received: received,
      sold: sold,
      closing_calculated: closingCalc,
      physical_count: physical,
      variance: variance,
      submitted_by: submittedBy
    });
    count++;
  }
  submissionOps.logSubmission.run(weekStart, storeId, submittedBy, count);
  return count;
});

// ==================== SUBMISSION STATUS ====================
function getSubmissionStatus(weekStart) {
  const week = weekStart || getWeekStart();
  const allStores = storeOps.getAll.all();
  const submitted = submissionOps.getSubmittedStores.all(week);
  const submittedMap = {};

  for (const s of submitted) {
    submittedMap[s.store_id] = { submitted_by: s.submitted_by, submitted_at: s.submitted_at };
  }

  return allStores.map(store => ({
    store_id: store.store_id,
    store_name: store.store_name,
    manager_name: store.manager_name,
    manager_email: store.manager_email,
    submitted: !!submittedMap[store.store_id],
    submitted_by: submittedMap[store.store_id]?.submitted_by || null,
    submitted_at: submittedMap[store.store_id]?.submitted_at || null
  }));
}

// ==================== PILFERAGE REPORT ====================
function getPilferageReport(weekStart) {
  const currentWeek = weekStart || getWeekStart();
  const cwDate = new Date(currentWeek + 'T00:00:00');
  const pwDate = new Date(cwDate);
  pwDate.setDate(pwDate.getDate() - 7);
  const previousWeek = pwDate.toISOString().split('T')[0];

  const currentData = submissionOps.getByWeek.all(currentWeek);
  const prevData = submissionOps.getByWeek.all(previousWeek);

  const prevLookup = {};
  for (const row of prevData) {
    prevLookup[`${row.store_id}|${row.product_id}`] = row;
  }

  const report = currentData.map(curr => {
    const key = `${curr.store_id}|${curr.product_id}`;
    const prev = prevLookup[key] || null;
    const variancePct = curr.closing_calculated !== 0
      ? ((curr.variance / curr.closing_calculated) * 100).toFixed(2)
      : '0.00';

    let flag = 'OK';
    if (curr.variance < 0) flag = 'LOSS';
    else if (curr.variance > 0) flag = 'EXCESS';

    return {
      store_id: curr.store_id,
      store_name: curr.store_name,
      product_id: curr.product_id,
      product_name: curr.product_name,
      opening: curr.opening_stock,
      received: curr.received,
      sold: curr.sold,
      expected_closing: curr.closing_calculated,
      physical_count: curr.physical_count,
      variance: curr.variance,
      variance_pct: variancePct,
      last_week_physical: prev ? prev.physical_count : null,
      week_over_week: prev ? (curr.physical_count - prev.physical_count) : null,
      flag: flag
    };
  });

  report.sort((a, b) => a.variance - b.variance);

  const lossItems = report.filter(r => r.flag === 'LOSS');
  const excessItems = report.filter(r => r.flag === 'EXCESS');

  return {
    week_start: currentWeek,
    prev_week: previousWeek,
    data: report,
    summary: {
      total_items: report.length,
      loss_items: lossItems.length,
      excess_items: excessItems.length,
      ok_items: report.filter(r => r.flag === 'OK').length,
      total_loss_qty: lossItems.reduce((sum, r) => sum + Math.abs(r.variance), 0),
      total_excess_qty: excessItems.reduce((sum, r) => sum + r.variance, 0)
    }
  };
}

// ==================== SEED SAMPLE DATA ====================
function seedSampleData() {
  const count = storeOps.getAll.all().length;
  if (count > 0) return;

  console.log('🌱 Seeding sample data...');

  const seedAll = db.transaction(() => {
    const stores = [
      { store_id:'S001', store_name:'Downtown Store',   manager_name:'John Smith',    manager_email:'' },
      { store_id:'S002', store_name:'Mall Outlet',      manager_name:'Sarah Johnson', manager_email:'' },
      { store_id:'S003', store_name:'Airport Kiosk',    manager_name:'Mike Brown',    manager_email:'' },
      { store_id:'S004', store_name:'Highway Store',    manager_name:'Emily Davis',   manager_email:'' },
      { store_id:'S005', store_name:'Central Market',   manager_name:'David Wilson',  manager_email:'' },
      { store_id:'S006', store_name:'Suburb Branch',    manager_name:'Lisa Anderson', manager_email:'' },
      { store_id:'S007', store_name:'Beach Store',      manager_name:'Tom Garcia',    manager_email:'' },
      { store_id:'S008', store_name:'University Shop',  manager_name:'Anna Martinez', manager_email:'' }
    ];

    const products = [
      { product_id:'P001', product_name:'Rice 5kg Bag',      category:'Grocery',    unit:'Bags' },
      { product_id:'P002', product_name:'Cooking Oil 1L',    category:'Grocery',    unit:'Bottles' },
      { product_id:'P003', product_name:'Sugar 1kg',         category:'Grocery',    unit:'Packs' },
      { product_id:'P004', product_name:'Milk 500ml',        category:'Dairy',      unit:'Packets' },
      { product_id:'P005', product_name:'Bread Loaf',        category:'Bakery',     unit:'Pcs' },
      { product_id:'P006', product_name:'Eggs (Dozen)',      category:'Dairy',      unit:'Dozens' },
      { product_id:'P007', product_name:'Detergent 500g',    category:'Household',  unit:'Packs' },
      { product_id:'P008', product_name:'Soap Bar',          category:'Household',  unit:'Pcs' },
      { product_id:'P009', product_name:'Bottled Water 1L',  category:'Beverages',  unit:'Bottles' },
      { product_id:'P010', product_name:'Instant Noodles',   category:'Grocery',    unit:'Packs' }
    ];

    stores.forEach(s => storeOps.insert.run(s));
    products.forEach(p => productOps.insert.run(p));
  });

  seedAll();
  console.log('✅ 8 stores + 10 products seeded!');
}

module.exports = {
  db, storeOps, productOps, submissionOps, bulkSubmit,
  getWeekStart, getPreviousWeekStart, getAvailableWeeks,
  getPilferageReport, getSubmissionStatus, seedSampleData
};