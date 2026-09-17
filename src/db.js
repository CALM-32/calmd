// db.js — طبقة قاعدة البيانات (SQLite مدمجة في Node.js — لا حاجة لتثبيت أي حزمة خارجية)
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'data.sqlite');
const isFirstRun = !fs.existsSync(DB_PATH);

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------------------------------------------------------------------------
// المخطط (Schema) — مطابق لخطة الـ Backend المتفق عليها
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  internal_name TEXT NOT NULL,
  flag TEXT NOT NULL,
  phone TEXT,
  commission_percent REAL NOT NULL DEFAULT 40,
  is_on_leave INTEGER NOT NULL DEFAULT 0,
  rating_avg REAL NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  base_lat REAL,
  base_lng REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staff_schedule (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  day_of_week INTEGER NOT NULL,      -- 0=الأحد ... 6=السبت
  start_minutes INTEGER NOT NULL,    -- دقائق منذ منتصف الليل
  end_minutes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff_leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price REAL NOT NULL,
  duration_minutes INTEGER NOT NULL,
  prep_minutes INTEGER NOT NULL DEFAULT 10,
  buffer_minutes INTEGER NOT NULL DEFAULT 3,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  staff_id INTEGER REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'pending_payment',
  -- pending_payment / confirmed / staff_onway / arrived / prep / in_service /
  -- between_services / wrapup / completed / cancelled / expired / no_show
  scheduled_start TEXT NOT NULL,      -- ISO datetime لبداية أول خدمة (ما يراه العميل)
  internal_start TEXT NOT NULL,       -- بداية الوقت التشغيلي الداخلي (يشمل التجهيز)
  internal_end TEXT NOT NULL,         -- نهاية الوقت التشغيلي الداخلي (يشمل كل البدل الضائع)
  customer_visible_end TEXT NOT NULL, -- نهاية آخر خدمة كما يراها العميل
  address_text TEXT,
  location_lat REAL,
  location_lng REAL,
  total_price REAL NOT NULL,
  campaign_id INTEGER REFERENCES marketing_campaigns(id),
  hold_expires_at TEXT,
  current_service_index INTEGER NOT NULL DEFAULT 0,
  arrived_at TEXT,
  cancelled_by TEXT,             -- 'customer' أو 'admin'
  cancellation_fee REAL,
  refund_amount REAL,
  cancelled_at TEXT,
  rescheduled_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS booking_services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  sequence_order INTEGER NOT NULL,
  started_at TEXT,
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  amount REAL NOT NULL,
  gateway TEXT NOT NULL DEFAULT 'moyasar',
  gateway_ref TEXT,
  status TEXT NOT NULL DEFAULT 'initiated', -- initiated / paid / failed
  paid_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  stars INTEGER NOT NULL,
  cleanliness_stars INTEGER,
  punctuality_stars INTEGER,
  comment TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS commissions_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  amount REAL NOT NULL,
  percent_applied REAL NOT NULL,
  paid_out INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  expense_date TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  campaign_name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES marketing_campaigns(id),
  visited_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  audience TEXT NOT NULL,   -- admin / staff / customer
  booking_id INTEGER,
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_type TEXT NOT NULL,
  actor_id INTEGER,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS inventory_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'قطعة',
  low_stock_threshold REAL NOT NULL DEFAULT 5,
  notes TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`);

// ---------------------------------------------------------------------------
// بيانات أولية (Seed) — فقط عند أول تشغيل
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ترقية آمنة لقواعد بيانات موجودة مسبقًا (أُنشئت قبل إضافة أعمدة الإلغاء/التعديل)
// ---------------------------------------------------------------------------
const existingColumns = db.prepare(`PRAGMA table_info(bookings)`).all().map((c) => c.name);
const migrations = [
  ['cancelled_by', `ALTER TABLE bookings ADD COLUMN cancelled_by TEXT`],
  ['cancellation_fee', `ALTER TABLE bookings ADD COLUMN cancellation_fee REAL`],
  ['refund_amount', `ALTER TABLE bookings ADD COLUMN refund_amount REAL`],
  ['cancelled_at', `ALTER TABLE bookings ADD COLUMN cancelled_at TEXT`],
  ['rescheduled_count', `ALTER TABLE bookings ADD COLUMN rescheduled_count INTEGER NOT NULL DEFAULT 0`],
];
for (const [col, sql] of migrations) {
  if (!existingColumns.includes(col)) db.exec(sql);
}
const hasWhatsappSetting = db.prepare(`SELECT 1 FROM settings WHERE key='support_whatsapp'`).get();
if (!hasWhatsappSetting) {
  db.prepare(`INSERT INTO settings (key, value) VALUES ('support_whatsapp', ?)`).run('966500000000');
}

if (isFirstRun) {
  const insertService = db.prepare(
    `INSERT INTO services (name, price, duration_minutes, prep_minutes, buffer_minutes) VALUES (?,?,?,?,?)`
  );
  insertService.run('مساج', 200, 45, 10, 3);
  insertService.run('حمام مغربي', 180, 40, 10, 3);
  insertService.run('بديكير', 120, 30, 8, 3);
  insertService.run('منيكير', 100, 25, 8, 3);

  const insertStaff = db.prepare(
    `INSERT INTO staff (internal_name, flag, phone, commission_percent, base_lat, base_lng) VALUES (?,?,?,?,?,?)`
  );
  const ph = insertStaff.run('الموظفة الفلبينية', '🇵🇭', '+9665xxxxxxx1', 40, 24.7136, 46.6753);
  const th = insertStaff.run('الموظفة التايلندية', '🇹🇭', '+9665xxxxxxx2', 40, 24.7743, 46.7386);

  const insertSchedule = db.prepare(
    `INSERT INTO staff_schedule (staff_id, day_of_week, start_minutes, end_minutes) VALUES (?,?,?,?)`
  );
  // كل الموظفات يعملن السبت-الخميس 10:00 - 22:00 (مثال افتراضي، قابل للتعديل من لوحة الإدارة لاحقًا)
  for (const staffRow of [ph, th]) {
    for (const dow of [0, 1, 2, 3, 4, 6]) { // بدون الجمعة كمثال
      insertSchedule.run(staffRow.lastInsertRowid, dow, 10 * 60, 22 * 60);
    }
  }

  const insertCampaign = db.prepare(
    `INSERT INTO marketing_campaigns (source, campaign_name, slug) VALUES (?,?,?)`
  );
  insertCampaign.run('tiktok', 'إعلان_الإطلاق', 'tiktok-launch');
  insertCampaign.run('snapchat', 'قصة_تعريفية', 'snap-story1');

  const insertInventory = db.prepare(
    `INSERT INTO inventory_items (name, quantity, unit, low_stock_threshold) VALUES (?,?,?,?)`
  );
  insertInventory.run('زيت مساج', 12, 'زجاجة', 4);
  insertInventory.run('طين الحمام المغربي', 8, 'كيس', 3);
  insertInventory.run('طلاء أظافر (مجموعة ألوان)', 20, 'قطعة', 6);
  insertInventory.run('مناشف يمكن التخلص منها', 150, 'قطعة', 30);

  console.log('✓ تم إنشاء قاعدة البيانات وتعبئتها ببيانات أولية:', DB_PATH);
}

module.exports = db;
