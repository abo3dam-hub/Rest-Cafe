/**
 * End-to-end Test: Restaurant Day Cycle (يوم مطعم كامل)
 *
 * Drives the real API through one full restaurant day, twice, on fresh
 * databases created through the real setup wizard with production shape
 * (no country, SYP / SP / Asia/Damascus / Arabic) — never the test-suite
 * regional defaults:
 *
 *   Round A — plain shop, tax off:
 *     waiter opens a table order (multi-item) → the order is visible on the
 *     POS list, the kitchen board and the KDS feed, and the table shows the
 *     running total → kitchen walks the kanban (pending → preparing →
 *     ready) → quantity edit on a started line → void of a started item
 *     (manager PIN) → a sold-out probe order → a second course on the same
 *     table → all items served → bill requested, generated, printed →
 *     cash payment → table freed → reports reconcile to hand-computed
 *     numbers.
 *
 *   Round B — Syria consumption fee 5% + 10% discount + split payment:
 *     same skeleton; every money figure (fee on the discounted base,
 *     split cash/card, tax components, cash summary) is reconciled against
 *     numbers computed by hand in this file before any response is read.
 *
 * The expected numbers below are the contract. Any mismatch is a finding,
 * not something to tune away.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/restaurant-day-cycle.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-day-cycle-'));
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const {
  initTestDb, startServer,
  api, assert, assertEqual,
  getResults, closeDatabase, now,
  seedCategory, seedProduct,
} = require('./helpers/test-setup');

const { getJWTSecret } = require('../main/routes/auth');
const { registerRoutes } = require('../main/routes/index');

// ── App factory: production route composition (registerRoutes) behind the
// same JWT gate the test harness uses.
function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'test-secret-' + Date.now();
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api')) return next();
    if (req.path === '/api/health') return next();
    if (req.path.startsWith('/api/auth') && !req.path.includes('/api/auth/me')) return next();
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    try {
      req.user = jwt.verify(authHeader.split(' ')[1], getJWTSecret());
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  });
  registerRoutes(app);
  return app;
}

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

function seedStaffUser(db, id, name, email, role, pin) {
  const passwordHash = bcrypt.hashSync('testpass123', 10);
  const pinHash = pin ? bcrypt.hashSync(pin, 10) : null;
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(id, name, email, passwordHash, role, pinHash, now(), now());
  const token = jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' });
  return { id, token, authHeader: auth(token) };
}

// ── Shop bootstrap through the real wizard, then the production-shape gate.
const OWNER_PIN = '5678';
async function setupShop(baseUrl, db, businessName) {
  const res = await api(baseUrl + '/api', '/auth/setup/initialize', {
    method: 'POST',
    body: {
      name: 'علي المالك',
      email: 'day-owner@test.local',
      password: 'Test1234',
      business_type: 'restaurant',
      business_name: businessName,
      setup_profile: 'demo',
      service_model: 'finedine',
      currency: 'SYP',
      timezone: 'Asia/Damascus',
      language: 'ar',
      terms_accepted: true,
      owner_approval_pin: OWNER_PIN,
      owner_approval_pin_confirmation: OWNER_PIN,
    },
  });
  assertEqual(res.status, 200, 'setup/initialize returns 200');
  if (res.status !== 200) throw new Error('setup failed: ' + JSON.stringify(res.data));
  const ownerToken = res.data.access_token;
  assert(!!ownerToken, 'setup returns an owner access_token');

  // The gate this whole exercise exists for: the shop must look like a real
  // Syrian shop, not like the test-suite defaults (IN / INR).
  const get = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value;
  assertEqual(get('country'), '', "production shape: settings.country is ''");
  assertEqual(get('currency'), 'SYP', 'production shape: currency = SYP');
  assertEqual(get('currency_symbol'), 'SP', 'production shape: currency_symbol = SP');
  assertEqual(get('timezone'), 'Asia/Damascus', 'production shape: timezone = Asia/Damascus');
  return { ownerToken, ownerAuth: auth(ownerToken) };
}

const MENU = [
  ['p-shawarma', 'cat-mains', 'شاورما دجاج', 25000],
  ['p-fattoush', 'cat-mains', 'فتوش', 12000],
  ['p-cola', 'cat-drinks', 'كولا', 5000],
  ['p-tea', 'cat-drinks', 'شاي', 3000],
  ['p-kunafa', 'cat-mains', 'كنافة', 15000],
  ['p-mansaf', 'cat-mains', 'منسف', 40000],
];
function seedMenu(db) {
  seedCategory(db, 'cat-mains', 'الأطباق الرئيسية');
  seedCategory(db, 'cat-drinks', 'مشروبات');
  for (const [id, cat, name, price] of MENU) seedProduct(db, id, cat, name, price);
}

function findItem(order, productId, status) {
  return (order.items || []).find(
    (i) => i.product_id === productId && (!status || i.status === status),
  );
}
function activeQty(order, productId) {
  return (order.items || [])
    .filter((i) => i.product_id === productId && !['cancelled', 'voided', 'void_adjustment', 'refunded'].includes(i.status))
    .reduce((s, i) => s + Number(i.quantity), 0);
}
function normalizeBreakdown(x) {
  if (!x) return [];
  return typeof x === 'string' ? JSON.parse(x || '[]') : x;
}
function damascusToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus' }).format(new Date());
}

async function main() {
  await runRoundA();
  await runRoundB();
  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(60));
  console.log(`RESTAURANT DAY CYCLE: ${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

// ── Round A: plain shop, tax off ────────────────────────────────────────────
async function runRoundA() {
  console.log('\n########## ROUND A — plain shop, tax off ##########');
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-day-a-'));
  const db = initTestDb();
  const app = buildApp();
  const { server, baseUrl } = await startServer(app);
  const A = baseUrl + '/api';
  try {
    const { ownerToken, ownerAuth } = await setupShop(baseUrl, db, 'مطعم اليوم أ');
    const waiter = seedStaffUser(db, 'waiter-day-a', 'نادل اليوم', 'waiter-a@test.local', 'server', null);
    const chef = seedStaffUser(db, 'chef-day-a', 'شيف اليوم', 'chef-a@test.local', 'chef', null);
    seedMenu(db);

    // Mark the mansaf sold out through the real endpoint (owner).
    const soRes = await api(A, '/products/p-mansaf/sold-out', {
      method: 'PATCH', headers: ownerAuth, body: { sold_out: true },
    });
    assertEqual(soRes.status, 200, 'A0: mansaf marked sold out');

    // 1) Waiter opens the table order.
    const create = await api(A, '/orders', {
      method: 'POST', headers: waiter.authHeader,
      body: {
        type: 'dine_in', table_id: 'tbl-demo-1', guest_count: 3,
        items: [
          { product_id: 'p-shawarma', quantity: 2 },
          { product_id: 'p-fattoush', quantity: 1 },
          { product_id: 'p-cola', quantity: 2 },
        ],
      },
    });
    assertEqual(create.status, 201, 'A1: waiter creates the dine-in order (201)');
    if (create.status !== 201) throw new Error('A1 failed: ' + JSON.stringify(create.data));
    let order = create.data.order;
    const oid = order.id;
    assertEqual(order.subtotal, 72000, 'A1: subtotal = 72,000');
    assertEqual(order.tax_amount, 0, 'A1: tax = 0 (tax off)');
    assertEqual(order.total, 72000, 'A1: total = 72,000');
    assertEqual(order.status, 'pending', 'A1: order starts pending');
    assert((order.items || []).every((i) => i.status === 'pending'), 'A1: all items start pending');

    // 2) The order reaches every interface.
    const posList = await api(A, '/orders', { headers: waiter.authHeader });
    const posOrders = posList.data.orders || posList.data.data || [];
    assert(posOrders.some((o) => o.id === oid), 'A2: order visible on the POS list');
    const kitchen = await api(A, '/kitchen/orders', { headers: ownerAuth });
    const kOrder = (kitchen.data.orders || []).find((o) => o.id === oid);
    assert(!!kOrder, 'A2: order visible on the kitchen board');
    assertEqual((kOrder?.items || []).length, 3, 'A2: kitchen board shows 3 items');
    const kds = await api(A, '/kds/orders', { headers: chef.authHeader });
    const kdsOrder = (kds.data.orders || []).find((o) => o.id === oid);
    assert(!!kdsOrder, 'A2: order visible on the KDS feed (chef view)');
    assert((kdsOrder?.items || []).some((i) => i.product_name === 'شاورما دجاج' && Number(i.quantity) === 2),
      'A2: KDS feed carries the shawarma line (name + qty, prices stripped for chef)');
    const tables = await api(A, '/tables', { headers: waiter.authHeader });
    const t1 = (tables.data.tables || []).find((t) => t.id === 'tbl-demo-1');
    assertEqual(t1?.status, 'occupied', 'A2: table 1 is occupied');
    assertEqual(t1?.activeOrder?.total, 72000, 'A2: table shows running total 72,000');

    // 3) Kitchen walks the kanban.
    const moveItem = async (itemId, status) => api(A, `/kds/items/${itemId}/status`, {
      method: 'PATCH', headers: chef.authHeader, body: { status },
    });
    for (const it of order.items) {
      const r = await moveItem(it.id, 'preparing');
      assertEqual(r.status, 200, `A3: item ${it.product_name} → preparing`);
    }
    const shawarma = findItem(order, 'p-shawarma');
    assertEqual((await moveItem(shawarma.id, 'ready')).status, 200, 'A3: shawarma → ready');
    let cur = (await api(A, `/orders/${oid}`, { headers: ownerAuth })).data.order;
    assertEqual(cur.status, 'preparing', 'A3: order rollup = preparing');

    // 4) Quantity edit on a started line (owner-only): cola 2 → 3.
    const cola = findItem(cur, 'p-cola', 'preparing');
    const edit = await api(A, `/orders/${oid}/items/${cola.id}/edit`, {
      method: 'PATCH',
      headers: { ...ownerAuth, 'Idempotency-Key': 'day-a-edit-cola-1' },
      body: { quantity: 3, expected_edit_version: cola.edit_version ?? 0 },
    });
    assertEqual(edit.status, 200, 'A4: cola quantity edit accepted');
    if (edit.status === 200) {
      cur = edit.data.order;
      assertEqual(activeQty(cur, 'p-cola'), 3, 'A4: active cola quantity is now 3 (2 started + 1 new pending line)');
      assertEqual(cur.total, 77000, 'A4: total = 77,000 after the edit');
    }

    // 5) Void the started fattoush (waiter + manager PIN = owner approval PIN).
    const fattoush = findItem(cur, 'p-fattoush', 'preparing');
    const voidRes = await api(A, `/orders/${oid}/items/${fattoush.id}/cancel`, {
      method: 'PATCH', headers: waiter.authHeader,
      body: { reason: 'الزبون غيّر رأيه', override_pin: OWNER_PIN },
    });
    assertEqual(voidRes.status, 200, 'A5: void of the preparing fattoush accepted with manager PIN');
    if (voidRes.status === 200) {
      cur = voidRes.data.order;
      assertEqual(findItem(cur, 'p-fattoush')?.status, 'voided', 'A5: fattoush line is voided');
      const adj = (cur.items || []).find((i) => i.status === 'void_adjustment');
      assert(!!adj && Number(adj.total) === -12000, 'A5: a −12,000 void-adjustment line balances the bill');
      assertEqual(cur.total, 65000, 'A5: total = 65,000 after the void');
      const kAfter = await api(A, '/kitchen/orders', { headers: ownerAuth });
      const kOrderAfter = (kAfter.data.orders || []).find((o) => o.id === oid);
      assert(!(kOrderAfter?.items || []).some((i) => i.status === 'void_adjustment'),
        'A5: the void-adjustment line never reaches the kitchen board');
    }

    // 6) Sold-out probe: the backend itself refuses a sold-out product —
    //    on creation and on add-items alike (fixed after the day-cycle
    //    finding; previously the POS screen was the only enforcement).
    const probe = await api(A, '/orders', {
      method: 'POST', headers: waiter.authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'p-mansaf', quantity: 1 }] },
    });
    console.log(`    [probe] sold-out mansaf order attempt → HTTP ${probe.status}`);
    assertEqual(probe.status, 400,
      'A6: the backend refuses an order for a sold-out product');
    assert(String(probe.data?.error || '').includes('sold out'),
      'A6: the refusal names the sold-out cause');
    const probeAdd = await api(A, `/orders/${oid}/items`, {
      method: 'POST', headers: waiter.authHeader,
      body: { items: [{ product_id: 'p-mansaf', quantity: 1 }] },
    });
    assertEqual(probeAdd.status, 400,
      'A6: adding a sold-out item to the open table order is also refused');
    cur = (await api(A, `/orders/${oid}`, { headers: waiter.authHeader })).data.order;
    assertEqual(cur.total, 65000, 'A6: the refused add left the order total at 65,000');

    // 7) Second course on the same table.
    const add = await api(A, `/orders/${oid}/items`, {
      method: 'POST', headers: waiter.authHeader,
      body: { items: [{ product_id: 'p-kunafa', quantity: 1 }, { product_id: 'p-tea', quantity: 1 }] },
    });
    assertEqual(add.status, 200, 'A7: second course added to the same table order');
    if (add.status === 200) {
      cur = add.data.order;
      assertEqual(cur.total, 83000, 'A7: table total = 83,000 after the second course');
    }
    const tables2 = await api(A, '/tables', { headers: waiter.authHeader });
    assertEqual((tables2.data.tables || []).find((t) => t.id === 'tbl-demo-1')?.activeOrder?.total, 83000,
      'A7: table view shows 83,000');

    // 8) Kitchen completes everything still active.
    cur = (await api(A, `/orders/${oid}`, { headers: ownerAuth })).data.order;
    for (const it of cur.items) {
      if (['pending', 'preparing', 'ready'].includes(it.status)) {
        assertEqual((await moveItem(it.id, 'served')).status, 200, `A8: ${it.product_name} → served`);
      }
    }
    cur = (await api(A, `/orders/${oid}`, { headers: ownerAuth })).data.order;
    assertEqual(cur.status, 'served', 'A8: order rollup = served once every item is served');

    // 9) Bill: request → generate → print.
    const reqBill = await api(A, `/orders/${oid}/request-bill`, { method: 'POST', headers: ownerAuth, body: {} });
    assertEqual(reqBill.status, 200, 'A9: bill requested');
    const tables3 = await api(A, '/tables', { headers: waiter.authHeader });
    assertEqual((tables3.data.tables || []).find((t) => t.id === 'tbl-demo-1')?.status, 'bill_requested',
      'A9: table flips to bill_requested');
    const gen = await api(A, '/bills/generate', { method: 'POST', headers: ownerAuth, body: { order_id: oid } });
    assert([200, 201].includes(gen.status), 'A9: bill generated');
    if (![200, 201].includes(gen.status)) throw new Error('A9 generate failed: ' + JSON.stringify(gen.data));
    const bill = gen.data.bill;
    assertEqual(bill.total, 83000, 'A9: bill total = 83,000');
    assertEqual(bill.tax_amount, 0, 'A9: bill tax = 0');
    assertEqual(normalizeBreakdown(bill.tax_breakdown).length, 0, 'A9: bill has no tax lines');
    const print = await api(A, `/bills/${bill.id}/print`, {
      method: 'POST', headers: ownerAuth, body: { print_type: 'receipt' },
    });
    assertEqual(print.status, 200, 'A9: bill print recorded (200, no printer configured)');
    const history = await api(A, `/bills/${bill.id}/print-history`, { headers: ownerAuth });
    assert((history.data.prints || []).length >= 1, 'A9: print history has the print event');
    const preview = await api(A, '/printers/print-bill', {
      method: 'POST', headers: ownerAuth, body: { billId: bill.id, preview: true },
    });
    console.log(`    [print] preview → HTTP ${preview.status}, text length: ${(preview.data?.text || '').length}, warnings: ${JSON.stringify(preview.data?.warnings || [])}`);
    assertEqual(preview.status, 200, 'A9: device-path preview responds 200');
    assert((preview.data?.text || '').length > 0,
      'A9: no-printer Arabic preview renders text (paperless preview defaults shaping on)');
    assert((preview.data?.text || '').includes('83,000'),
      'A9: preview text carries the 83,000 total');
    assert(/[؀-ۿﭐ-﷿ﹰ-﻿]/.test(preview.data?.text || ''),
      'A9: preview text contains Arabic script');

    // 10) Cash payment settles everything.
    const pay = await api(A, `/bills/${bill.id}/payment`, {
      method: 'POST', headers: ownerAuth, body: { method: 'cash' },
    });
    assertEqual(pay.status, 200, 'A10: cash payment accepted');
    assertEqual(pay.data.bill?.payment_status, 'paid', 'A10: bill is paid');
    assertEqual(Number(pay.data.bill?.paid_amount), 83000, 'A10: paid amount = 83,000');
    cur = (await api(A, `/orders/${oid}`, { headers: ownerAuth })).data.order;
    assertEqual(cur.status, 'completed', 'A10: order completes on full payment');
    const tables4 = await api(A, '/tables', { headers: waiter.authHeader });
    const t1After = (tables4.data.tables || []).find((t) => t.id === 'tbl-demo-1');
    assertEqual(t1After?.status, 'available', 'A10: table returns to available');
    assert(!t1After?.activeOrder, 'A10: table has no active order');

    // 11) Reports reconcile to the hand-computed day.
    const date = damascusToday();
    const summary = await api(A, `/reports/summary?date=${date}`, { headers: ownerAuth });
    const s = summary.data.summary || {};
    assertEqual(s.orders?.count, 1, 'A11: summary counts exactly 1 non-cancelled order');
    assertEqual(s.orders?.total, 83000, 'A11: summary orders total = 83,000');
    assertEqual(s.bills?.collected, 83000, 'A11: summary collected = 83,000');
    const cashRow = (s.paymentMethods || []).find((p) => p.method === 'cash');
    assertEqual(cashRow?.total, 83000, 'A11: summary payment methods: cash = 83,000');
    assertEqual((s.ordersByStatus || []).find((r) => r.status === 'cancelled')?.count ?? 0, 0,
      'A11: the refused sold-out probe never became an order (no cancelled row, no sale)');
    const daily = await api(A, '/reports/daily-stats', { headers: ownerAuth });
    assertEqual(daily.data.sales, 83000, 'A11: daily-stats sales = 83,000');
    const taxComp = await api(A, '/reports/tax-components', { headers: ownerAuth });
    assertEqual(taxComp.data.taxComponents?.taxAmount, 0, 'A11: tax components total = 0');
    const x = await api(A, `/reports/x-report?date=${date}`, { headers: ownerAuth });
    assertEqual(x.data.xReport?.netCollected, 83000, 'A11: X report net collected = 83,000');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

// ── Round B: consumption fee 5% + 10% discount + split payment ─────────────
async function runRoundB() {
  console.log('\n########## ROUND B — consumption fee 5% + discount + split payment ##########');
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-day-b-'));
  const db = initTestDb();
  const app = buildApp();
  const { server, baseUrl } = await startServer(app);
  const A = baseUrl + '/api';
  try {
    const { ownerAuth } = await setupShop(baseUrl, db, 'مطعم اليوم ب');
    const waiter = seedStaffUser(db, 'waiter-day-b', 'نادل اليوم', 'waiter-b@test.local', 'server', null);
    const chef = seedStaffUser(db, 'chef-day-b', 'شيف اليوم', 'chef-b@test.local', 'chef', null);
    seedMenu(db);

    // Activate the Syria consumption profile through the real endpoint.
    const act = await api(A, '/tax-packs/syria-profile', {
      method: 'POST', headers: ownerAuth,
      body: { profile: 'consumption', classification: 'rated_2_3' },
    });
    assertEqual(act.status, 200, 'B0: Syria consumption profile activates (owner)');
    assertEqual(act.data?.rate, 5, 'B0: rated_2_3 maps to the legal 5% default');
    const get = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value;
    assertEqual(get('tax_profile'), 'syria_consumption', 'B0: marker tax_profile = syria_consumption');
    assertEqual(get('taxes_enabled'), 'true', 'B0: taxes_enabled flips on');

    // 1) The order — fee applies to the whole bill from the first line.
    const create = await api(A, '/orders', {
      method: 'POST', headers: waiter.authHeader,
      body: {
        type: 'dine_in', table_id: 'tbl-demo-1', guest_count: 2,
        items: [
          { product_id: 'p-shawarma', quantity: 1 },
          { product_id: 'p-kunafa', quantity: 2 },
          { product_id: 'p-cola', quantity: 1 },
        ],
      },
    });
    assertEqual(create.status, 201, 'B1: order created');
    if (create.status !== 201) throw new Error('B1 failed: ' + JSON.stringify(create.data));
    let order = create.data.order;
    const oid = order.id;
    assertEqual(order.subtotal, 60000, 'B1: subtotal = 60,000');
    assertEqual(order.tax_amount, 3000, 'B1: fee = 5% × 60,000 = 3,000');
    assertEqual(order.total, 63000, 'B1: total = 63,000');
    const bd = normalizeBreakdown(order.tax_breakdown);
    assertEqual(bd.length, 1, 'B1: exactly one tax line');
    assertEqual(bd[0]?.title, 'رسم الإنفاق الاستهلاكي', 'B1: the tax line is the consumption fee');
    assertEqual(bd[0]?.amount, 3000, 'B1: fee line amount = 3,000');

    // 2) Kitchen serves everything.
    for (const it of order.items) {
      const r = await api(A, `/kds/items/${it.id}/status`, {
        method: 'PATCH', headers: chef.authHeader, body: { status: 'served' },
      });
      assertEqual(r.status, 200, `B2: ${it.product_name} → served`);
    }

    // 3) A 10% order discount — the fee must shrink proportionally.
    const disc = await api(A, `/orders/${oid}/discount`, {
      method: 'PATCH', headers: ownerAuth,
      body: { discount_type: 'percentage', discount_value: 10, discount_reason: 'زبون دائم' },
    });
    assertEqual(disc.status, 200, 'B3: 10% discount applied');
    if (disc.status === 200) {
      order = disc.data.order;
      assertEqual(order.discount_amount, 6000, 'B3: discount = 6,000');
      assertEqual(order.tax_amount, 2700, 'B3: fee rescales to 5% × 54,000 = 2,700');
      assertEqual(order.total, 56700, 'B3: total = 54,000 + 2,700 = 56,700');
    }

    // 4) Bill + print.
    const gen = await api(A, '/bills/generate', { method: 'POST', headers: ownerAuth, body: { order_id: oid } });
    assert([200, 201].includes(gen.status), 'B4: bill generated');
    if (![200, 201].includes(gen.status)) throw new Error('B4 generate failed: ' + JSON.stringify(gen.data));
    const bill = gen.data.bill;
    assertEqual(bill.total, 56700, 'B4: bill total = 56,700');
    const bbd = normalizeBreakdown(bill.tax_breakdown);
    assertEqual(bbd.length, 1, 'B4: bill carries exactly one tax line');
    assertEqual(bbd[0]?.title, 'رسم الإنفاق الاستهلاكي', 'B4: bill tax line is the consumption fee');
    assertEqual(bbd[0]?.amount, 2700, 'B4: bill fee line = 2,700');
    const print = await api(A, `/bills/${bill.id}/print`, {
      method: 'POST', headers: ownerAuth, body: { print_type: 'receipt' },
    });
    assertEqual(print.status, 200, 'B4: bill print recorded');

    // 5) Split payment: 30,000 cash + 26,700 card.
    const pay = await api(A, `/bills/${bill.id}/payments`, {
      method: 'POST', headers: ownerAuth,
      body: { payments: [{ method: 'cash', amount: 30000 }, { method: 'card', amount: 26700 }] },
    });
    assertEqual(pay.status, 200, 'B5: split payment accepted');
    assertEqual(pay.data.bill?.payment_status, 'paid', 'B5: bill is paid');
    assertEqual(Number(pay.data.bill?.paid_amount), 56700, 'B5: paid amount = 56,700');
    const done = (await api(A, `/orders/${oid}`, { headers: ownerAuth })).data.order;
    assertEqual(done.status, 'completed', 'B5: order completes on full payment');
    const tables = await api(A, '/tables', { headers: waiter.authHeader });
    assertEqual((tables.data.tables || []).find((t) => t.id === 'tbl-demo-1')?.status, 'available',
      'B5: table returns to available');

    // 6) Reports reconcile: fee, cash/card split, net.
    const date = damascusToday();
    const summary = await api(A, `/reports/summary?date=${date}`, { headers: ownerAuth });
    const s = summary.data.summary || {};
    assertEqual(s.bills?.collected, 56700, 'B6: summary collected = 56,700');
    assertEqual((s.paymentMethods || []).find((p) => p.method === 'cash')?.total, 30000,
      'B6: summary payment methods: cash = 30,000');
    assertEqual((s.paymentMethods || []).find((p) => p.method === 'card')?.total, 26700,
      'B6: summary payment methods: card = 26,700');
    const taxComp = await api(A, '/reports/tax-components', { headers: ownerAuth });
    assertEqual(taxComp.data.taxComponents?.taxAmount, 2700, 'B6: tax components total = 2,700');
    const fee = (taxComp.data.taxComponents?.components || []).find((c) => c.title === 'رسم الإنفاق الاستهلاكي');
    assertEqual(fee?.amount, 2700, 'B6: fee component = 2,700 at 5%');
    const cashSummary = await api(A, '/reports/cash-summary', { headers: ownerAuth });
    const day = (cashSummary.data.cashSummary?.days || [])[0];
    assertEqual(day?.cash_collected, 30000, 'B6: cash summary — cash collected = 30,000');
    assertEqual(day?.net_collected, 56700, 'B6: cash summary — net collected = 56,700');
    const x = await api(A, `/reports/x-report?date=${date}`, { headers: ownerAuth });
    assertEqual(x.data.xReport?.netCollected, 56700, 'B6: X report net collected = 56,700');
    assertEqual((x.data.xReport?.taxComponents || []).find((c) => c.title === 'رسم الإنفاق الاستهلاكي')?.amount, 2700,
      'B6: X report carries the fee component = 2,700');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
