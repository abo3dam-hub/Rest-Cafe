/**
 * End-to-end Test: Restaurant Full House (مطعم ممتلئ — ٤٠ طاولة)
 *
 * The big sibling of tests/restaurant-day-cycle.test.ts. Fills a restaurant
 * to 40 tables at once on a fresh database created through the real setup
 * wizard with production shape (country '', SYP / SP / Asia/Damascus /
 * Arabic / finedine — never the test-harness regional defaults), runs every
 * realistic rush scenario against the real API, and proves, against numbers
 * computed BEFORE any response is read, that every bill is exact, every
 * report equals an independent SQL ledger AND the hand-computed expectations
 * (three-way reconciliation), and nothing is lost, duplicated, or stuck when
 * many things happen at nearly the same time.
 *
 *   Round 1 — full house, plain shop (tax off).
 *   Round 2 — full house again, money round (fresh DB): Syria consumption
 *     fee 10% (rated_4_5) + discounts + split payments + refunds.
 *   Round 3 — small combined-tax probe (fresh DB, 4 tables): manual sales
 *     tax 5% AND consumption fee 10% together, as two components of one
 *     manual pack. (Two separate tax packs cannot stack: only one pack is
 *     active per country, and activating the Syria profile while a manual
 *     pack is active is rejected with 409 before anything mutates — see the
 *     stacking probe at the end of Round 3 and finding F-R3-1, fixed by
 *     assignment 033.)
 *
 * Money rule (absolute, from the day-cycle file): the expected numbers below
 * are the contract. A mismatch is a FINDING — recorded exactly (scenario,
 * table/order, expected vs actual) and the run continues wherever it is
 * safe — never a reason to tune an expectation to match actual output.
 * Findings are collected in `findings` and fail the suite at the end, so a
 * regression cannot hide behind a green run that stopped early.
 *
 * Menu prices are whole SYP chosen so every total is hand-computable:
 * shawarma 25,000 / fattoush 15,000 / kunafa 40,000 / mansaf 60,000 /
 * cola 10,000 / tea 10,000.
 *
 * Pinned grand totals (hand-computed from the scenario table in this file;
 * the in-code ledger must agree with them before either is compared to the
 * system, so a script bug cannot masquerade as a system bug):
 *
 *   Round 1: gross collected 2,928,000; discounts 27,000; fee 0;
 *     cash 2,708,000; card 220,000; orders created 52 (46 dine-in +
 *     3 takeaway + 3 delivery); completed 43; cancelled 9 (8 normal +
 *     1 merged); units SH 42 / FA 15 / CO 51 / KU 20 / TE 13 / MA 4;
 *     cash close: opening 100,000 + cash 2,708,000 - refunds 0 -
 *     expense 25,000 = counted 2,783,000, variance 0.
 *   Round 2: gross collected (before refunds) 3,220,800; discounts 27,000;
 *     fee 292,800; cash 2,978,800; card 242,000; refunds 158,500
 *     (partial item 10,000 + full bill 148,500, both cash);
 *     net collected 3,062,300; cash net 2,820,300; card 242,000;
 *     same order counts as Round 1; units as Round 1 except TE 12
 *     (the refunded tea line is excluded); cash close:
 *     100,000 + 2,978,800 - 158,500 - 25,000 = 2,895,300, variance 0.
 *   Round 3: gross 235,750; discounts 5,000; tax 30,750 (sales 5%:
 *     10,250 + fee 10%: 20,500); cash 178,250; card 57,500;
 *     orders created 4, completed 4, cancelled 0;
 *     units SH 4 / KU 1 / CO 1 / MA 1.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/restaurant-full-house.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
let testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-full-house-'));
Module._load = function (request, parent, isMain) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const {
  initTestDb,
  startServer,
  api: apiRaw,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
  seedCategory,
  seedProduct,
  seedCustomer,
} = require('./helpers/test-setup');

// Same shape as the shared api() helper, but a non-JSON response (e.g. a
// plain-text 429) throws an error naming the URL, status and body instead
// of a bare SyntaxError.
async function api(baseUrl, urlPath, options = {}) {
  const fetchOptions = {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  };
  if (options.method) fetchOptions.method = options.method;
  if (options.body !== undefined) {
    fetchOptions.body =
      typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  const response = await globalThis.fetch(baseUrl + urlPath, fetchOptions);
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON ${response.status} from ${urlPath}: ${text.slice(0, 200)}`);
  }
  return { status: response.status, data };
}
void apiRaw;

const { getJWTSecret } = require('../main/routes/auth');
const { registerRoutes } = require('../main/routes/index');

// ── App factory: production route composition (registerRoutes) behind the
// same JWT gate the test harness uses (day-cycle pattern).
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
      email: 'fh-owner@test.local',
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
  assertEqualOrThrow(res.status, 200, 'setup/initialize returns 200');
  if (res.status !== 200) throw new Error('setup failed: ' + JSON.stringify(res.data));
  const ownerToken = res.data.access_token;
  assertOrThrow(!!ownerToken, 'setup returns an owner access_token');

  const get = (k) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) || {}).value;
  assertEqualOrThrow(get('country'), '', "production shape: settings.country is ''");
  assertEqualOrThrow(get('currency'), 'SYP', 'production shape: currency = SYP');
  assertEqualOrThrow(get('currency_symbol'), 'SP', 'production shape: currency_symbol = SP');
  assertEqualOrThrow(
    get('timezone'),
    'Asia/Damascus',
    'production shape: timezone = Asia/Damascus',
  );
  return { ownerToken, ownerAuth: auth(ownerToken) };
}

const MENU = [
  ['p-shawarma', 'cat-mains', 'شاورما دجاج', 25000],
  ['p-fattoush', 'cat-mains', 'فتوش', 15000],
  ['p-kunafa', 'cat-mains', 'كنافة', 40000],
  ['p-mansaf', 'cat-mains', 'منسف', 60000],
  ['p-cola', 'cat-drinks', 'كولا', 10000],
  ['p-tea', 'cat-drinks', 'شاي', 10000],
];
const PRICE = Object.fromEntries(MENU.map(([id, , , price]) => [id, price]));
const PNAME = Object.fromEntries(MENU.map(([id, , name]) => [id, name]));
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
function normalizeBreakdown(x) {
  if (!x) return [];
  return typeof x === 'string' ? JSON.parse(x || '[]') : x;
}
function damascusToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus' }).format(new Date());
}
async function getFreeTcpPort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));
  return port;
}
// Raw fetch (for the Server App and for export downloads, which are not JSON).
async function fetchRaw(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    method: options.method || 'GET',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* keep raw text */
  }
  return { status: res.status, data, text, contentType: res.headers.get('content-type') || '' };
}

// ── Pinned grand totals (hand-computed; see the header comment) ─────────────
const EXPECTED_R1 = {
  grossCollected: 2928000,
  discounts: 27000,
  fee: 0,
  refunds: 0,
  netCollected: 2928000,
  cash: 2708000,
  card: 220000,
  ordersCreated: 52,
  ordersCompleted: 43,
  ordersCancelled: 9,
  ordersCancelledNormal: 8,
  ordersMerged: 1,
  byType: { dine_in: 46, takeaway: 3, delivery: 3 },
  selfOrder: 1,
  units: {
    'p-shawarma': 42,
    'p-fattoush': 15,
    'p-cola': 51,
    'p-kunafa': 20,
    'p-tea': 13,
    'p-mansaf': 4,
  },
  billsCount: 44,
  billsTotal: 2928000,
  openingFloat: 100000,
  expense: 25000,
  cashRefunds: 0,
  countedCash: 2783000,
};
const EXPECTED_R2 = {
  grossCollected: 3220800,
  discounts: 27000,
  fee: 292800,
  refunds: 159500,
  netCollected: 3061300,
  cash: 2978800,
  card: 242000,
  cashNet: 2819300,
  ordersCreated: 52,
  ordersCompleted: 43,
  ordersCancelled: 9,
  ordersCancelledNormal: 8,
  ordersMerged: 1,
  byType: { dine_in: 46, takeaway: 3, delivery: 3 },
  selfOrder: 1,
  units: {
    'p-shawarma': 42,
    'p-fattoush': 15,
    'p-cola': 51,
    'p-kunafa': 20,
    'p-tea': 12,
    'p-mansaf': 4,
  },
  billsCount: 44,
  billsTotal: 3220800,
  openingFloat: 100000,
  expense: 25000,
  cashRefunds: 159500,
  countedCash: 2894300,
};
const EXPECTED_R3 = {
  grossCollected: 235750,
  discounts: 5000,
  tax: 30750,
  salesTax: 10250,
  fee: 20500,
  refunds: 0,
  netCollected: 235750,
  cash: 178250,
  card: 57500,
  ordersCreated: 4,
  ordersCompleted: 4,
  ordersCancelled: 0,
  units: { 'p-shawarma': 4, 'p-kunafa': 1, 'p-cola': 1, 'p-mansaf': 1 },
};

// ── Findings: a money/integrity mismatch is recorded exactly and the run
// continues wherever it is safe. The suite fails at the end if any finding
// was recorded, so a regression cannot hide behind an early exit.
const findings = [];
const timings = [];
function recordFinding(scenario, label, expected, actual, context) {
  const f = { scenario, label, expected, actual, context: context || '' };
  findings.push(f);
  console.log(
    `    [FINDING] ${scenario} — ${label}: expected ${expected}, actual ${actual}${f.context ? ` (${f.context})` : ''}`,
  );
}
function expectMoney(scenario, label, expected, actual, context) {
  if (Number(expected) === Number(actual)) return true;
  recordFinding(scenario, label, expected, actual, context);
  return false;
}
function expectEqual(scenario, label, expected, actual, context) {
  if (expected === actual) return true;
  recordFinding(scenario, label, expected, actual, context);
  return false;
}
// ops = how many API calls the burst fans out. The sanity bound is
// max(10, ops) x the median single op: a burst must beat running its calls
// one after another (fully serial), with a 10x floor for tiny bursts.
function timeOp(label, fn, ops = 1) {
  const t0 = Date.now();
  return Promise.resolve()
    .then(fn)
    .then((r) => {
      const ms = Date.now() - t0;
      timings.push({ label, ms, ops });
      return r;
    });
}
function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ── The expected ledger: built from the scenario as it runs. Every order's
// lines, discounts, fees, payments, and refunds are tracked here; the
// finale compares this ledger against the pinned constants above FIRST, so
// a script bug cannot masquerade as a system bug.
class Ledger {
  constructor(feePct) {
    this.feePct = feePct;
    this.orders = new Map(); // orderId -> entry
    this.refunds = []; // {label, amount, method}
    this.expense = 0;
    this.openingFloat = 0;
  }
  addOrder(orderId, label, tableNo, type, items, selfOrder = false) {
    this.orders.set(orderId, {
      orderId,
      label,
      tableNo,
      type,
      selfOrder,
      items: items.map(([productId, qty]) => ({ productId, qty, status: 'active' })),
      discountPct: 0,
      status: 'pending',
      payments: [],
      billId: null,
      cancelledReason: null,
      merged: false,
    });
    return this.orders.get(orderId);
  }
  entry(orderId) {
    return this.orders.get(orderId);
  }
  orderMoney(e) {
    // Refunded items stay in the money totals: a refund never changes the
    // order or bill total, it only records a separate refund row. Units
    // exclude refunded items (topProducts does the same).
    const sub = e.items
      .filter((i) => i.status === 'active' || i.status === 'refunded')
      .reduce((s, i) => s + PRICE[i.productId] * i.qty, 0);
    const disc = Math.round((sub * e.discountPct) / 100);
    const base = sub - disc;
    const fee = Math.round((base * this.feePct) / 100);
    return { sub, disc, base, fee, total: base + fee };
  }
  setItemQty(orderId, productId, qty) {
    const e = this.entry(orderId);
    const it = e.items.find((i) => i.productId === productId && i.status === 'active');
    assertOrThrow(!!it, `ledger: active ${productId} line on ${e.label}`);
    it.qty = qty;
  }
  addItems(orderId, items) {
    const e = this.entry(orderId);
    for (const [productId, qty] of items) {
      const it = e.items.find((i) => i.productId === productId && i.status === 'active');
      if (it) it.qty += qty;
      else e.items.push({ productId, qty, status: 'active' });
    }
  }
  voidItem(orderId, productId) {
    const e = this.entry(orderId);
    const it = e.items.find((i) => i.productId === productId && i.status === 'active');
    assertOrThrow(!!it, `ledger: active ${productId} line to void on ${e.label}`);
    it.status = 'voided';
  }
  cancelItem(orderId, productId) {
    const e = this.entry(orderId);
    const it = e.items.find((i) => i.productId === productId && i.status === 'active');
    assertOrThrow(!!it, `ledger: active ${productId} line to cancel on ${e.label}`);
    it.status = 'cancelled';
  }
  refundItem(orderId, productId) {
    const e = this.entry(orderId);
    const it = e.items.find((i) => i.productId === productId && i.status === 'active');
    assertOrThrow(!!it, `ledger: active ${productId} line to refund on ${e.label}`);
    it.status = 'refunded';
  }
  cancelOrder(orderId, reason, merged = false) {
    const e = this.entry(orderId);
    e.status = 'cancelled';
    e.cancelledReason = reason;
    e.merged = merged;
  }
  completeOrder(orderId) {
    this.entry(orderId).status = 'completed';
  }
  pay(orderId, method, amount) {
    this.entry(orderId).payments.push({ method, amount });
  }
  aggregates() {
    let gross = 0,
      disc = 0,
      fee = 0,
      cash = 0,
      card = 0;
    const units = {};
    let created = 0,
      completed = 0,
      cancelled = 0,
      cancelledNormal = 0,
      merged = 0;
    const byType = { dine_in: 0, takeaway: 0, delivery: 0 };
    let selfOrder = 0;
    for (const e of this.orders.values()) {
      created++;
      byType[e.type] = (byType[e.type] || 0) + 1;
      if (e.selfOrder) selfOrder++;
      if (e.status === 'completed') {
        completed++;
        const m = this.orderMoney(e);
        gross += m.total;
        disc += m.disc;
        fee += m.fee;
        for (const p of e.payments) {
          if (p.method === 'cash') cash += p.amount;
          else if (p.method === 'card') card += p.amount;
        }
        for (const i of e.items.filter((x) => x.status === 'active')) {
          units[i.productId] = (units[i.productId] || 0) + i.qty;
        }
      } else if (e.status === 'cancelled') {
        cancelled++;
        if (e.merged) merged++;
        else cancelledNormal++;
      }
    }
    const refundTotal = this.refunds.reduce((s, r) => s + r.amount, 0);
    const cashRefunds = this.refunds
      .filter((r) => r.method === 'cash')
      .reduce((s, r) => s + r.amount, 0);
    return {
      gross,
      disc,
      fee,
      cash,
      card,
      units,
      created,
      completed,
      cancelled,
      cancelledNormal,
      merged,
      byType,
      selfOrder,
      refundTotal,
      cashRefunds,
      net: gross - refundTotal,
      countedCash: this.openingFloat + cash - cashRefunds - this.expense,
    };
  }
}

// ── API operation helpers (each asserts its structural contract with a
// throwing assert, and records money expectations in the ledger) ─────────
function tableItems(plan) {
  return plan.map(([p, q]) => ({ product_id: p, quantity: q }));
}

async function createDineInOrder(A, authHeader, ledger, label, tableId, tableNo, items, opts = {}) {
  const res = await api(A, '/orders', {
    method: 'POST',
    headers: authHeader,
    body: {
      type: 'dine_in',
      table_id: tableId,
      guest_count: opts.guests || 2,
      items: tableItems(items),
      ...(opts.extra || {}),
    },
  });
  assertEqualOrThrow(res.status, 201, `${label}: dine-in order created (201)`);
  const order = res.data.order;
  const m = { sub: items.reduce((s, [p, q]) => s + PRICE[p] * q, 0) };
  expectMoney(label, 'order subtotal', m.sub, order.subtotal, 'at creation');
  expectMoney(
    label,
    'order total at creation',
    m.sub + Math.round((m.sub * ledger.feePct) / 100),
    order.total,
    'at creation',
  );
  ledger.addOrder(order.id, label, tableNo, 'dine_in', items, !!opts.selfOrder);
  return order;
}

async function createNoTableOrder(A, authHeader, ledger, label, type, items, idempotencyKey) {
  const headers = { ...authHeader };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await api(A, '/orders', {
    method: 'POST',
    headers,
    body: { type, items: tableItems(items) },
  });
  assertOrThrow(
    [200, 201].includes(res.status),
    `${label}: ${type} order created (201, or 200 on idempotent replay)`,
  );
  const order = res.data.order;
  const sub = items.reduce((s, [p, q]) => s + PRICE[p] * q, 0);
  expectMoney(label, 'order subtotal', sub, order.subtotal, 'at creation');
  ledger.addOrder(order.id, label, null, type, items);
  return { res, order };
}

// The chef drives the KDS transitions; the order itself is read with the
// owner token (the chef role has no orders.read permission).
async function serveItems(A, chefAuth, orderId, targetStatus = 'served', readAuth = null) {
  const ra = readAuth || chefAuth;
  const cur = (await api(A, `/orders/${orderId}`, { headers: ra })).data.order;
  for (const it of cur.items || []) {
    if (['pending', 'preparing', 'ready'].includes(it.status)) {
      const r = await api(A, `/kds/items/${it.id}/status`, {
        method: 'PATCH',
        headers: chefAuth,
        body: { status: targetStatus },
      });
      assertEqualOrThrow(r.status, 200, `serve item ${it.product_name} -> ${targetStatus}`);
    }
  }
  return cur;
}

// One feed read lists every open order and its items; advance each matching
// item once. This keeps order reads far below the orderReadRateLimit
// (120/min on GET /orders*) that caps per-order reads.
async function kdsPass(A, chefAuth, fromStatuses, targetStatus) {
  const feed = (await api(A, '/kds/orders', { headers: chefAuth })).data.orders || [];
  let advanced = 0;
  for (const o of feed) {
    for (const it of o.items || []) {
      if (fromStatuses.includes(it.status)) {
        const r = await api(A, `/kds/items/${it.id}/status`, {
          method: 'PATCH',
          headers: chefAuth,
          body: { status: targetStatus },
        });
        assertEqualOrThrow(r.status, 200, `KDS: ${it.product_name} -> ${targetStatus}`);
        advanced++;
      }
    }
  }
  return advanced;
}

let editKeySeq = 0;
async function editItemQty(A, ownerAuth, ledger, label, orderId, productId, newQty) {
  const cur = (await api(A, `/orders/${orderId}`, { headers: ownerAuth })).data.order;
  const item = findItem(cur, productId);
  assertOrThrow(!!item, `${label}: ${productId} line found for edit`);
  const res = await api(A, `/orders/${orderId}/items/${item.id}/edit`, {
    method: 'PATCH',
    headers: { ...ownerAuth, 'Idempotency-Key': `fh-edit-${label}-${++editKeySeq}` },
    body: { quantity: newQty, expected_edit_version: item.edit_version ?? 0 },
  });
  assertEqualOrThrow(res.status, 200, `${label}: quantity edit accepted`);
  return res.data.order;
}

async function cancelItem(A, waiterAuth, ledger, label, orderId, productId, reason) {
  const cur = (await api(A, `/orders/${orderId}`, { headers: waiterAuth })).data.order;
  const item = findItem(cur, productId);
  assertOrThrow(!!item, `${label}: ${productId} line found for cancel`);
  const res = await api(A, `/orders/${orderId}/items/${item.id}/cancel`, {
    method: 'PATCH',
    headers: waiterAuth,
    body: { reason },
  });
  assertEqualOrThrow(res.status, 200, `${label}: item cancel accepted`);
  ledger.cancelItem(orderId, productId);
  return res.data.order;
}

async function voidItem(A, waiterAuth, ledger, label, orderId, productId, reason) {
  const cur = (await api(A, `/orders/${orderId}`, { headers: waiterAuth })).data.order;
  const item =
    findItem(cur, productId, 'preparing') ||
    findItem(cur, productId, 'ready') ||
    findItem(cur, productId);
  assertOrThrow(!!item, `${label}: ${productId} started line found for void`);
  const res = await api(A, `/orders/${orderId}/items/${item.id}/cancel`, {
    method: 'PATCH',
    headers: waiterAuth,
    body: { reason, override_pin: OWNER_PIN },
  });
  assertEqualOrThrow(res.status, 200, `${label}: void of started item accepted with manager PIN`);
  const after = res.data.order;
  assertEqualOrThrow(findItem(after, productId)?.status, 'voided', `${label}: line is voided`);
  ledger.voidItem(orderId, productId);
  return after;
}

async function addItems(A, waiterAuth, ledger, label, orderId, items) {
  const res = await api(A, `/orders/${orderId}/items`, {
    method: 'POST',
    headers: waiterAuth,
    body: { items: tableItems(items) },
  });
  assertEqualOrThrow(res.status, 200, `${label}: add-items accepted`);
  ledger.addItems(orderId, items);
  const e = ledger.entry(orderId);
  const m = ledger.orderMoney(e);
  expectMoney(label, 'order total after add-items', m.total, res.data.order.total, 'add-items');
  return res.data.order;
}

async function applyDiscount(A, ownerAuth, ledger, label, orderId, pct, reason) {
  const res = await api(A, `/orders/${orderId}/discount`, {
    method: 'PATCH',
    headers: ownerAuth,
    body: { discount_type: 'percentage', discount_value: pct, discount_reason: reason },
  });
  assertEqualOrThrow(res.status, 200, `${label}: ${pct}% discount applied`);
  const e = ledger.entry(orderId);
  e.discountPct = pct;
  const m = ledger.orderMoney(e);
  expectMoney(label, 'discount amount', m.disc, res.data.order.discount_amount, 'discount');
  expectMoney(label, 'total after discount', m.total, res.data.order.total, 'discount');
  return res.data.order;
}

async function generateBill(A, ownerAuth, ledger, label, orderId) {
  const res = await api(A, '/bills/generate', {
    method: 'POST',
    headers: ownerAuth,
    body: { order_id: orderId },
  });
  assertOrThrow([200, 201].includes(res.status), `${label}: bill generated`);
  const bill = res.data.bill;
  const e = ledger.entry(orderId);
  e.billId = bill.id;
  const m = ledger.orderMoney(e);
  expectMoney(label, 'bill total', m.total, bill.total, 'generate');
  expectMoney(label, 'bill fee/tax', m.fee, bill.tax_amount, 'generate');
  return bill;
}

async function printBill(A, ownerAuth, label, billId) {
  const res = await api(A, `/bills/${billId}/print`, {
    method: 'POST',
    headers: ownerAuth,
    body: { print_type: 'receipt' },
  });
  assertEqualOrThrow(res.status, 200, `${label}: bill print recorded`);
  return res.data.bill;
}

async function requestBill(A, ownerAuth, label, orderId) {
  const res = await api(A, `/orders/${orderId}/request-bill`, {
    method: 'POST',
    headers: ownerAuth,
    body: {},
  });
  assertEqualOrThrow(res.status, 200, `${label}: bill requested`);
  return res.data;
}

async function payBill(A, authHeader, ledger, label, billId, orderId, payments) {
  // payments: [{method, amount}] — one line uses the single-payment endpoint
  // (amount omitted pays the remaining balance); several lines use /payments.
  let res;
  if (payments.length === 1 && payments[0].amount === undefined) {
    res = await api(A, `/bills/${billId}/payment`, {
      method: 'POST',
      headers: authHeader,
      body: { method: payments[0].method },
    });
  } else if (payments.length === 1) {
    res = await api(A, `/bills/${billId}/payment`, {
      method: 'POST',
      headers: authHeader,
      body: { method: payments[0].method, amount: payments[0].amount },
    });
  } else {
    res = await api(A, `/bills/${billId}/payments`, {
      method: 'POST',
      headers: authHeader,
      body: { payments },
    });
  }
  assertEqualOrThrow(res.status, 200, `${label}: payment accepted`);
  for (const p of payments) {
    ledger.pay(orderId, p.method, p.amount ?? ledger.orderMoney(ledger.entry(orderId)).total);
  }
  return res.data.bill;
}

async function settleOrder(A, authHeader, ledger, label, orderId, payments) {
  const bill = await generateBill(A, authHeader, ledger, label, orderId);
  const paid = await payBill(A, authHeader, ledger, label, bill.id, orderId, payments);
  assertEqualOrThrow(paid.payment_status, 'paid', `${label}: bill is paid`);
  const e = ledger.entry(orderId);
  expectMoney(label, 'paid amount', ledger.orderMoney(e).total, Number(paid.paid_amount), 'settle');
  ledger.completeOrder(orderId);
  return paid;
}

async function cancelOrder(A, authHeader, ledger, label, orderId, reason, pin = false) {
  const body = { status: 'cancelled', reason };
  if (pin) body.override_pin = OWNER_PIN;
  const res = await api(A, `/orders/${orderId}/status`, {
    method: 'PATCH',
    headers: authHeader,
    body,
  });
  assertEqualOrThrow(res.status, 200, `${label}: order cancelled`);
  assertEqualOrThrow(res.data.order?.status, 'cancelled', `${label}: order status is cancelled`);
  ledger.cancelOrder(orderId, reason, false);
  return res.data.order;
}

// ── Scenario table: base items per table (Round 1 and Round 2 share it) ────
const SH = 'p-shawarma',
  FA = 'p-fattoush',
  KU = 'p-kunafa',
  MA = 'p-mansaf',
  CO = 'p-cola',
  TE = 'p-tea';
const TABLE_PLANS = {
  1: [
    [SH, 2],
    [FA, 1],
    [CO, 2],
  ],
  2: [
    [SH, 2],
    [FA, 1],
    [CO, 2],
  ],
  3: [
    [SH, 2],
    [FA, 1],
    [CO, 2],
  ],
  4: [
    [SH, 2],
    [FA, 1],
    [CO, 2],
  ],
  5: [
    [SH, 2],
    [FA, 1],
    [CO, 2],
  ],
  6: [
    [SH, 2],
    [FA, 1],
    [CO, 2],
  ],
  7: [
    [SH, 2],
    [FA, 1],
    [CO, 2],
  ],
  8: [
    [SH, 2],
    [FA, 1],
    [CO, 2],
  ],
  9: [
    [SH, 1],
    [CO, 1],
  ],
  10: [
    [SH, 1],
    [CO, 1],
  ],
  11: [
    [SH, 2],
    [CO, 1],
  ],
  12: [
    [SH, 1],
    [FA, 1],
    [CO, 1],
  ],
  13: [
    [SH, 1],
    [FA, 1],
    [CO, 1],
  ],
  14: [
    [SH, 1],
    [CO, 1],
  ],
  15: [
    [SH, 1],
    [CO, 1],
  ],
  16: [
    [FA, 2],
    [TE, 1],
  ],
  17: [[KU, 1]],
  18: [[MA, 1]],
  19: [
    [SH, 1],
    [CO, 2],
  ],
  20: [
    [FA, 1],
    [KU, 1],
  ],
  21: [
    [SH, 2],
    [CO, 2],
  ],
  22: [
    [KU, 1],
    [MA, 1],
  ],
  23: [
    [SH, 2],
    [FA, 2],
    [CO, 2],
  ],
  24: [
    [MA, 1],
    [CO, 1],
  ],
  25: [
    [KU, 1],
    [TE, 2],
  ],
  26: [
    [SH, 1],
    [KU, 1],
  ],
  27: [
    [SH, 1],
    [CO, 1],
  ],
  28: [
    [FA, 1],
    [TE, 1],
  ],
  29: [
    [KU, 1],
    [CO, 1],
  ],
  30: [
    [KU, 1],
    [CO, 1],
  ],
  31: [
    [KU, 1],
    [CO, 1],
  ],
  32: [
    [SH, 1],
    [CO, 1],
  ],
  33: [
    [SH, 1],
    [CO, 1],
  ],
  34: [
    [SH, 1],
    [CO, 1],
  ],
  35: [
    [SH, 1],
    [CO, 1],
  ],
  36: [
    [MA, 1],
    [CO, 1],
  ],
  37: [
    [SH, 1],
    [CO, 1],
  ],
  38: [
    [MA, 2],
    [CO, 1],
  ],
  39: [
    [SH, 1],
    [CO, 2],
  ],
  40: [
    [FA, 1],
    [TE, 1],
  ],
};
const SECOND_COURSE = [
  [KU, 1],
  [TE, 1],
]; // T1–T8, added after KDS start
const RESEAT_ITEMS = [
  [SH, 1],
  [CO, 1],
]; // T40 second lifecycle + second seating

async function runRound(cfg) {
  const { round, feePct, expected, doRefunds } = cfg;
  console.log(`\n########## ${round} — full house, fee ${feePct}% ##########`);
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-full-house-'));
  const db = initTestDb();
  const app = buildApp();
  const { server, baseUrl } = await startServer(app);
  const A = baseUrl + '/api';
  const ledger = new Ledger(feePct);
  let serverAppOn = false;
  try {
    const { ownerAuth } = await setupShop(
      baseUrl,
      db,
      round === 'R1' ? 'مطعم الفول أ' : 'مطعم الفول ب',
    );
    const manager = seedStaffUser(
      db,
      `manager-fh-${round}`,
      'مدير الفول',
      `manager-${round}@test.local`,
      'manager',
      '1234',
    );
    const cashier = seedStaffUser(
      db,
      `cashier-fh-${round}`,
      'أمين الصندوق',
      `cashier-${round}@test.local`,
      'cashier',
      null,
    );
    const waiter1 = seedStaffUser(
      db,
      `waiter1-fh-${round}`,
      'نادل أول',
      `waiter1-${round}@test.local`,
      'server',
      null,
    );
    const waiter2 = seedStaffUser(
      db,
      `waiter2-fh-${round}`,
      'نادل ثان',
      `waiter2-${round}@test.local`,
      'server',
      null,
    );
    const chef = seedStaffUser(
      db,
      `chef-fh-${round}`,
      'شيف الفول',
      `chef-${round}@test.local`,
      'chef',
      null,
    );
    const ownerId = db.prepare("SELECT id FROM users WHERE role = 'owner'").get().id;
    seedMenu(db);
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('split_checks_enabled', 'true', ?)",
    ).run(now());

    // Round 2: Syria consumption fee 10% (rated_4_5) through the same
    // settings path the day-cycle Round B uses.
    if (feePct > 0) {
      const act = await api(A, '/tax-packs/syria-profile', {
        method: 'POST',
        headers: ownerAuth,
        body: { profile: 'consumption', classification: 'rated_4_5' },
      });
      assertEqualOrThrow(act.status, 200, `${round}: Syria consumption profile activates (owner)`);
      assertEqualOrThrow(act.data?.rate, 10, `${round}: rated_4_5 maps to the legal 10% default`);
    }

    // 40 tables through the real bulk endpoint.
    const bulk = await api(A, '/tables/bulk', {
      method: 'POST',
      headers: ownerAuth,
      body: { from: 1, to: 40, capacity: 4 },
    });
    assertEqualOrThrow(bulk.status, 201, `${round}: bulk-create 40 tables`);
    assertEqualOrThrow(bulk.data?.created_count, 40, `${round}: 40 tables created`);
    const tablesRes = await api(A, '/tables', { headers: ownerAuth });
    const tableIdByNumber = {};
    for (const t of tablesRes.data.tables || []) tableIdByNumber[String(t.number)] = t.id;
    for (let n = 1; n <= 40; n++) {
      assertOrThrow(!!tableIdByNumber[String(n)], `${round}: table ${n} resolvable by number`);
    }

    // Cash session open at day start.
    const open = await api(A, '/cash-sessions/open', {
      method: 'POST',
      headers: cashier.authHeader,
      body: { opening_float_cents: 100000 },
    });
    assertEqualOrThrow(open.status, 200, `${round}: cash session opens`);
    const sessionId = open.data?.id;
    assertOrThrow(typeof sessionId === 'number', `${round}: open returns a session id`);
    ledger.openingFloat = 100000;

    // Self-order Server App (T39): point its forward at this test app.
    let selfToken = null;
    let appBaseUrl = null;
    {
      const { setServerPort } = require('../main/server-state');
      const testPort = Number(new URL(baseUrl).port);
      setServerPort(testPort);
      process.env.SERVER_APP_PORT = String(await getFreeTcpPort());
      const { startServerApp, getServerAppPort } = require('../main/server-app');
      const selfOrder = require('../main/services/self-order');
      await startServerApp();
      serverAppOn = true;
      appBaseUrl = `http://127.0.0.1:${getServerAppPort()}`;
      selfOrder.setSelfOrderEnabled(true);
      assertOrThrow(selfOrder.isSelfOrderEnabled(), `${round}: self-ordering enabled`);
      selfToken = selfOrder.getSelfOrderToken(tableIdByNumber['39']);
      assertOrThrow(
        typeof selfToken === 'string' && selfToken.length >= 32,
        `${round}: self-order token issued for T39`,
      );
    }

    // T40 reservation (name/phone/arrival) before the fill.
    seedCustomer(db, `cust-fh-40-${round}`, 'زبون الحجز', '0991112223');
    const arrival = new Date(Date.now() + 3600 * 1000).toISOString();
    const reserve = await api(A, `/tables/${tableIdByNumber['40']}/status`, {
      method: 'PATCH',
      headers: ownerAuth,
      body: {
        status: 'reserved',
        reservation_customer_id: `cust-fh-40-${round}`,
        reservation_at: arrival,
      },
    });
    assertEqualOrThrow(reserve.status, 200, `${round}: T40 reserved`);
    assertEqualOrThrow(reserve.data.table?.status, 'reserved', `${round}: T40 status is reserved`);

    // ── FILL: all 40 tables ──
    const orderByTable = {};
    for (let n = 1; n <= 40; n++) {
      const waiter = n % 2 === 1 ? waiter1 : waiter2;
      const label = `T${n}`;
      if (n === 39) {
        // Self-order path: the guests order through the per-table HMAC token.
        const so = await fetchRaw(`${appBaseUrl}/api/self-order/orders?t=${selfToken}`, {
          method: 'POST',
          headers: { 'Idempotency-Key': `fh-${round}-self-39` },
          body: { items: tableItems(TABLE_PLANS[39]), customer_name: 'ضيوف الطاولة ٣٩' },
        });
        assertEqualOrThrow(so.status, 201, 'T39: self-order creates the order (201)');
        const order = so.data.order;
        assertEqualOrThrow(
          order.table_id,
          tableIdByNumber['39'],
          'T39: self-order lands on the token table',
        );
        assertEqualOrThrow(order.type, 'dine_in', 'T39: self-order type is dine_in');
        assertEqualOrThrow(order.online_platform, 'self_order', 'T39: order is marked self_order');
        ledger.addOrder(order.id, 'T39', 39, 'dine_in', TABLE_PLANS[39], true);
        orderByTable[39] = order.id;
        continue;
      }
      const order = await createDineInOrder(
        A,
        waiter.authHeader,
        ledger,
        label,
        tableIdByNumber[String(n)],
        n,
        TABLE_PLANS[n],
      );
      orderByTable[n] = order.id;
    }
    // T40's order seats the reservation (customer attached, table occupied).
    {
      const t40 = (await api(A, '/tables', { headers: ownerAuth })).data.tables.find(
        (t) => t.id === tableIdByNumber['40'],
      );
      assertEqualOrThrow(t40?.status, 'occupied', `${round}: T40 is occupied after seating`);
      assertEqualOrThrow(
        t40?.reservation_customer_id ?? null,
        null,
        `${round}: seating clears the reservation fields`,
      );
    }

    // ── PEAK SNAPSHOT: 40 occupied, 40 open orders, KDS shows all 40 ──
    const tablesPeak = await api(A, '/tables', { headers: waiter1.authHeader });
    // The demo setup profile also seeds 4 tables numbered T1–T4; the rush
    // tables are the numeric 1–40.
    const peakTables = (tablesPeak.data.tables || []).filter((t) => {
      const n = Number(t.number);
      return Number.isInteger(n) && n >= 1 && n <= 40;
    });
    assertEqualOrThrow(peakTables.length, 40, 'peak: 40 rush tables listed');
    assertOrThrow(
      peakTables.every((t) => t.status === 'occupied'),
      'peak: all 40 tables occupied',
    );
    for (let n = 1; n <= 40; n++) {
      const t = peakTables.find((x) => String(x.number) === String(n));
      const m = ledger.orderMoney(ledger.entry(orderByTable[n]));
      expectMoney(
        `peak-T${n}`,
        'table running total',
        m.total,
        t?.activeOrder?.total,
        'peak snapshot',
      );
    }
    const posList = await api(A, '/orders', { headers: waiter1.authHeader });
    const posOrders = posList.data.orders || posList.data.data || [];
    const openPeak = posOrders.filter((o) =>
      ['pending', 'preparing', 'ready', 'served'].includes(o.status),
    );
    assertEqualOrThrow(openPeak.length, 40, 'peak: 40 open orders on the POS list');
    const kitchen = await api(A, '/kitchen/orders', { headers: ownerAuth });
    assertEqualOrThrow((kitchen.data.orders || []).length, 40, 'peak: kitchen board shows all 40');
    const kds = await api(A, '/kds/orders', { headers: chef.authHeader });
    assertEqualOrThrow((kds.data.orders || []).length, 40, 'peak: KDS feed shows all 40');
    console.log(`    [peak] 40/40 occupied, 40 open orders, KDS + board + tables all agree`);

    // Single-operation timing samples for the simultaneity bound (median).
    await timeOp('single GET /tables', () => api(A, '/tables', { headers: ownerAuth }));
    await timeOp('single GET /orders/:id', () =>
      api(A, `/orders/${orderByTable[1]}`, { headers: ownerAuth }),
    );
    await timeOp('single GET /reports/summary', () =>
      api(A, `/reports/summary?date=${damascusToday()}`, { headers: ownerAuth }),
    );

    // Mid-day expense (recorded while the house is full).
    const catRes = await api(A, '/expenses/categories', {
      method: 'POST',
      headers: { ...ownerAuth, 'Idempotency-Key': `fh-${round}-cat-1` },
      body: { name: 'مشتريات وسط اليوم' },
    });
    assertEqualOrThrow(catRes.status, 201, `${round}: expense category created`);
    const expRes = await api(A, '/expenses', {
      method: 'POST',
      headers: { ...ownerAuth, 'Idempotency-Key': `fh-${round}-exp-1` },
      body: {
        category_id: catRes.data.category.id,
        description: 'مشتريات وسط اليوم',
        amount_minor: 25000,
        incurred_on: damascusToday(),
      },
    });
    assertEqualOrThrow(expRes.status, 201, `${round}: mid-day expense recorded`);
    ledger.expense = 25000;
    // A new expense starts unpaid (paid_minor 0) and takes nothing out of the
    // drawer until it is paid; pay it in cash now so the session close nets it.
    const payRes = await api(A, `/expenses/${expRes.data.expense.id}/payments`, {
      method: 'POST',
      headers: { ...ownerAuth, 'Idempotency-Key': `fh-${round}-exppay-1` },
      body: { method: 'cash', amount_minor: 25000 },
    });
    assertEqualOrThrow(payRes.status, 201, `${round}: mid-day expense paid in cash`);
    assertEqualOrThrow(
      Number(payRes.data.expense?.paid_minor),
      25000,
      `${round}: expense fully paid`,
    );

    // ── No-table orders, interleaved ──
    // Burst 3 — duplicate order submission: TK1 submitted twice in parallel
    // with the same Idempotency-Key; exactly one order exists afterwards.
    const beforeCount = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
    let tk1;
    await timeOp(`${round} burst duplicate-submission`, async () => {
      const [d1, d2] = await Promise.all([
        createNoTableOrder(
          A,
          waiter1.authHeader,
          ledger,
          'TK1',
          'takeaway',
          [
            [SH, 1],
            [CO, 1],
          ],
          `fh-${round}-dup-tk1`,
        ),
        createNoTableOrder(
          A,
          waiter1.authHeader,
          ledger,
          'TK1',
          'takeaway',
          [
            [SH, 1],
            [CO, 1],
          ],
          `fh-${round}-dup-tk1`,
        ),
      ]);
      assertOrThrow(
        [201, 200].includes(d1.res.status) && [201, 200].includes(d2.res.status),
        'TK1: parallel duplicate submission returns 201 + 200',
      );
      assertEqualOrThrow(d1.order.id, d2.order.id, 'TK1: both submissions carry the same order id');
      tk1 = d1.order;
    });
    assertEqualOrThrow(
      db.prepare('SELECT COUNT(*) c FROM orders').get().c - beforeCount,
      1,
      'TK1: exactly one order row after the duplicate submission',
    );
    const tk2 = (
      await createNoTableOrder(A, waiter2.authHeader, ledger, 'TK2', 'takeaway', [[FA, 2]], null)
    ).order;
    const tk3 = (
      await createNoTableOrder(A, waiter1.authHeader, ledger, 'TK3', 'takeaway', [[KU, 1]], null)
    ).order;
    const dv1 = (
      await createNoTableOrder(
        A,
        waiter2.authHeader,
        ledger,
        'DV1',
        'delivery',
        [
          [SH, 1],
          [TE, 1],
        ],
        null,
      )
    ).order;
    const dv2 = (
      await createNoTableOrder(
        A,
        waiter1.authHeader,
        ledger,
        'DV2',
        'delivery',
        [
          [CO, 2],
          [FA, 1],
        ],
        null,
      )
    ).order;
    const dv3 = (
      await createNoTableOrder(
        A,
        waiter2.authHeader,
        ledger,
        'DV3',
        'delivery',
        [
          [KU, 1],
          [CO, 1],
        ],
        null,
      )
    ).order;
    orderByTable.TK1 = tk1.id;
    orderByTable.TK2 = tk2.id;
    orderByTable.TK3 = tk3.id;
    orderByTable.DV1 = dv1.id;
    orderByTable.DV2 = dv2.id;
    orderByTable.DV3 = dv3.id;

    // ── Early cancellations (pending, no PIN needed) ──
    await cancelOrder(A, ownerAuth, ledger, 'T15', orderByTable[15], 'الزبون غادر قبل الطلب');
    await cancelOrder(A, ownerAuth, ledger, 'T16', orderByTable[16], 'إلغاء قبل الدفع');
    await cancelOrder(A, ownerAuth, ledger, 'T19', orderByTable[19], 'الزبون غادر');
    await cancelOrder(A, ownerAuth, ledger, 'T20', orderByTable[20], 'إلغاء قبل الدفع');
    await cancelOrder(A, ownerAuth, ledger, 'T40a', orderByTable[40], 'إلغاء دورة الحجز الأولى');
    await cancelOrder(A, ownerAuth, ledger, 'TK3', orderByTable.TK3, 'إلغاء طلب سفري');
    // T13: cancel one single item before kitchen start.
    await cancelItem(A, ownerAuth, ledger, 'T13', orderByTable[13], FA, 'الزبون غيّر رأيه');

    // ── KDS pass 1: everything to preparing ──
    // Burst 5 — KDS advances the same item twice concurrently (T9's first
    // item, expected_status 'pending'): one 200, one 409; the item ends in
    // exactly one consistent state and the order is unpoisoned.
    const t9order = (await api(A, `/orders/${orderByTable[9]}`, { headers: ownerAuth })).data.order;
    const t9item = t9order.items[0];
    await timeOp(`${round} burst kds-double-advance`, async () => {
      const [k1, k2] = await Promise.all([
        api(A, `/kds/items/${t9item.id}/status`, {
          method: 'PATCH',
          headers: chef.authHeader,
          body: { status: 'preparing', expected_status: 'pending' },
        }),
        api(A, `/kds/items/${t9item.id}/status`, {
          method: 'PATCH',
          headers: chef.authHeader,
          body: { status: 'preparing', expected_status: 'pending' },
        }),
      ]);
      const statuses = [k1.status, k2.status].sort();
      assertEqualOrThrow(
        JSON.stringify(statuses),
        JSON.stringify([200, 409]),
        'T9: concurrent double advance yields one 200 + one 409',
      );
      const loser = k1.status === 409 ? k1 : k2;
      assertOrThrow(
        String(loser.data?.error || '').includes('refresh'),
        'T9: the loser names the refresh conflict',
      );
    });
    const t9after = (await api(A, `/orders/${orderByTable[9]}`, { headers: ownerAuth })).data.order;
    assertEqualOrThrow(
      findItem(t9after, SH)?.status,
      'preparing',
      'T9: item ends preparing, exactly one state',
    );
    assertEqualOrThrow(t9after.status, 'preparing', 'T9: order rollup is preparing, not poisoned');
    const activeOrderIds = () =>
      [...ledger.orders.values()].filter((e) => e.status === 'pending').map((e) => e.orderId);
    const moved1 = await kdsPass(A, chef.authHeader, ['pending'], 'preparing');
    assertOrThrow(moved1 > 0, 'KDS pass 1 moves pending items to preparing');
    {
      const list = (await api(A, '/orders?per_page=100', { headers: ownerAuth })).data.orders || [];
      const open = list.filter((o) =>
        ['pending', 'preparing', 'ready', 'served'].includes(o.status),
      );
      assertEqualOrThrow(
        open.length,
        activeOrderIds().length,
        'KDS pass 1: open order count unchanged',
      );
      assertOrThrow(
        open.every((o) => o.status === 'preparing'),
        'KDS pass 1: every open order rolls up to preparing',
      );
    }

    // ── Mid-KDS edits ──
    await addItems(A, waiter1.authHeader, ledger, 'T9', orderByTable[9], [[FA, 1]]); // add after KDS start
    {
      const after = await editItemQty(A, ownerAuth, ledger, 'T10', orderByTable[10], CO, 2); // started line 1 -> 2
      ledger.setItemQty(orderByTable[10], CO, 2);
      expectMoney(
        'T10',
        'total after started increase',
        ledger.orderMoney(ledger.entry(orderByTable[10])).total,
        after.total,
        'edit',
      );
    }
    {
      const after = await editItemQty(A, ownerAuth, ledger, 'T11', orderByTable[11], SH, 1); // started line 2 -> 1
      ledger.setItemQty(orderByTable[11], SH, 1);
      expectMoney(
        'T11',
        'total after started decrease',
        ledger.orderMoney(ledger.entry(orderByTable[11])).total,
        after.total,
        'edit',
      );
    }
    await voidItem(A, waiter1.authHeader, ledger, 'T12', orderByTable[12], FA, 'الزبون غيّر رأيه');
    // Burst 4 — two waiters add different items to the same table
    // concurrently (T14's second course): both items present afterwards,
    // total = sum of both (no lost update).
    await timeOp(`${round} burst concurrent-add`, async () => {
      const [a1, a2] = await Promise.all([
        api(A, `/orders/${orderByTable[14]}/items`, {
          method: 'POST',
          headers: waiter1.authHeader,
          body: { items: [{ product_id: KU, quantity: 1 }] },
        }),
        api(A, `/orders/${orderByTable[14]}/items`, {
          method: 'POST',
          headers: waiter2.authHeader,
          body: { items: [{ product_id: TE, quantity: 1 }] },
        }),
      ]);
      assertEqualOrThrow(a1.status, 200, 'T14: waiter 1 concurrent add accepted');
      assertEqualOrThrow(a2.status, 200, 'T14: waiter 2 concurrent add accepted');
    });
    ledger.addItems(orderByTable[14], [
      [KU, 1],
      [TE, 1],
    ]);
    {
      const cur14 = (await api(A, `/orders/${orderByTable[14]}`, { headers: ownerAuth })).data
        .order;
      assertOrThrow(!!findItem(cur14, KU), 'T14: concurrent add left the kunafa line');
      assertOrThrow(!!findItem(cur14, TE), 'T14: concurrent add left the tea line');
      expectMoney(
        'T14',
        'total after concurrent adds',
        ledger.orderMoney(ledger.entry(orderByTable[14])).total,
        cur14.total,
        'concurrent add',
      );
    }
    // Second course on the straight road (T1–T8), added after KDS start.
    for (let n = 1; n <= 8; n++) {
      await addItems(
        A,
        n % 2 === 1 ? waiter1.authHeader : waiter2.authHeader,
        ledger,
        `T${n}`,
        orderByTable[n],
        SECOND_COURSE,
      );
    }

    // ── Merge T28 into T27 mid-service ──
    {
      const merge = await api(A, `/orders/${orderByTable[28]}/merge`, {
        method: 'POST',
        headers: ownerAuth,
        body: { target_order_id: orderByTable[27] },
      });
      assertEqualOrThrow(merge.status, 200, 'T27: merge accepted');
      const target = merge.data.target_order;
      const source = merge.data.source_order;
      assertEqualOrThrow(source.status, 'cancelled', 'T27: source order is cancelled by the merge');
      assertOrThrow(
        String(source.cancellation_reason || '').includes('دمج'),
        'T27: source carries the merge reason',
      );
      ledger.addItems(orderByTable[27], TABLE_PLANS[28]);
      ledger.cancelOrder(orderByTable[28], source.cancellation_reason || 'دمج', true);
      expectMoney(
        'T27',
        'merged order total',
        ledger.orderMoney(ledger.entry(orderByTable[27])).total,
        target.total,
        'merge',
      );
      const t28 = (await api(A, '/tables', { headers: ownerAuth })).data.tables.find(
        (t) => t.id === tableIdByNumber['28'],
      );
      assertEqualOrThrow(t28?.status, 'available', 'T27: source table freed by the merge');
    }

    // ── Sold-out in the middle of the rush ──
    {
      const so = await api(A, `/products/${MA}/sold-out`, {
        method: 'PATCH',
        headers: ownerAuth,
        body: { sold_out: true },
      });
      assertEqualOrThrow(so.status, 200, 'T36: mansaf marked sold out');
    }
    // A NEW order containing it is refused (400 product_sold_out, whole cart rolls back).
    const soldOutBefore = db.prepare('SELECT COUNT(*) c FROM orders').get().c;
    const probeOrder = await api(A, '/orders', {
      method: 'POST',
      headers: waiter1.authHeader,
      body: {
        type: 'takeaway',
        items: [
          { product_id: MA, quantity: 1 },
          { product_id: CO, quantity: 1 },
        ],
      },
    });
    assertEqualOrThrow(probeOrder.status, 400, 'T37: new order with a sold-out product is refused');
    assertOrThrow(
      String(probeOrder.data?.error || '').includes('sold out'),
      'T37: the refusal names the sold-out cause',
    );
    assertEqualOrThrow(
      db.prepare('SELECT COUNT(*) c FROM orders').get().c,
      soldOutBefore,
      'T37: the refused cart created no order (whole cart rolls back)',
    );
    // Add-items of it is refused; orders already containing it are unaffected.
    const probeAdd = await api(A, `/orders/${orderByTable[36]}/items`, {
      method: 'POST',
      headers: waiter1.authHeader,
      body: { items: [{ product_id: MA, quantity: 1 }] },
    });
    assertEqualOrThrow(probeAdd.status, 400, 'T36: add-items of the sold-out product is refused');
    const t36cur = (await api(A, `/orders/${orderByTable[36]}`, { headers: ownerAuth })).data.order;
    expectMoney(
      'T36',
      'existing sold-out order unaffected',
      ledger.orderMoney(ledger.entry(orderByTable[36])).total,
      t36cur.total,
      'sold-out',
    );
    // A quantity REDUCTION of an existing line stays allowed (locked exception).
    {
      const after = await editItemQty(A, ownerAuth, ledger, 'T38', orderByTable[38], MA, 1);
      ledger.setItemQty(orderByTable[38], MA, 1);
      expectMoney(
        'T38',
        'total after sold-out reduction',
        ledger.orderMoney(ledger.entry(orderByTable[38])).total,
        after.total,
        'sold-out reduction',
      );
    }

    // ── KDS pass 2: everything still active to served ──
    const moved2 = await kdsPass(A, chef.authHeader, ['pending', 'preparing', 'ready'], 'served');
    assertOrThrow(moved2 > 0, 'KDS pass 2 moves active items to served');
    {
      const list = (await api(A, '/orders?per_page=100', { headers: ownerAuth })).data.orders || [];
      const open = list.filter((o) =>
        ['pending', 'preparing', 'ready', 'served'].includes(o.status),
      );
      assertEqualOrThrow(
        open.length,
        activeOrderIds().length,
        'KDS pass 2: open order count unchanged',
      );
      assertOrThrow(
        open.every((o) => o.status === 'served'),
        'KDS pass 2: every open order rolls up to served',
      );
    }

    // ── T9–T14: the edited/adjusted tables settle in cash ──
    for (const n of [9, 10, 11, 12, 13, 14]) {
      await settleOrder(A, ownerAuth, ledger, `T${n}`, orderByTable[n], [
        { method: 'cash', amount: ledger.orderMoney(ledger.entry(orderByTable[n])).total },
      ]);
    }

    // ── Burst 1: ten tables request their bill and pay in one burst ──
    const burstTables = [1, 2, 3, 4, 5, 6, 7, 8, 29, 30];
    const burstBills = {};
    await timeOp(
      `${round} burst bill-and-pay x10`,
      async () => {
        const results = await Promise.all(
          burstTables.map(async (n) => {
            const oid = orderByTable[n];
            const label = `T${n}`;
            await requestBill(A, ownerAuth, label, oid);
            const bill = await generateBill(A, ownerAuth, ledger, label, oid);
            await printBill(A, ownerAuth, label, bill.id);
            const paid = await payBill(A, ownerAuth, ledger, label, bill.id, oid, [
              { method: 'cash', amount: ledger.orderMoney(ledger.entry(oid)).total },
            ]);
            assertEqualOrThrow(paid.payment_status, 'paid', `${label}: bill is paid in the burst`);
            ledger.completeOrder(oid);
            return [n, bill.id];
          }),
        );
        for (const [n, bid] of results) burstBills[n] = bid;
      },
      40,
    );
    // Burst 2 — duplicate payment attempt on an already-settled bill (T1),
    // same moment, twice, explicit amounts: both rejected, no double revenue.
    await timeOp(`${round} burst duplicate-payment`, async () => {
      const t1 = ledger.entry(orderByTable[1]);
      const amt = ledger.orderMoney(t1).total;
      const [p1, p2] = await Promise.all([
        api(A, `/bills/${burstBills[1]}/payment`, {
          method: 'POST',
          headers: ownerAuth,
          body: { method: 'cash', amount: amt },
        }),
        api(A, `/bills/${burstBills[1]}/payment`, {
          method: 'POST',
          headers: ownerAuth,
          body: { method: 'cash', amount: amt },
        }),
      ]);
      assertEqualOrThrow(p1.status, 400, 'T1: first duplicate payment rejected');
      assertEqualOrThrow(p2.status, 400, 'T1: second duplicate payment rejected');
      assertOrThrow(
        String(p1.data?.error || '').includes('already paid'),
        'T1: rejection names already-paid',
      );
      assertOrThrow(
        String(p2.data?.error || '').includes('already paid'),
        'T1: rejection names already-paid',
      );
    });
    {
      const billRow = db.prepare('SELECT paid_amount FROM bills WHERE id = ?').get(burstBills[1]);
      expectMoney(
        'T1',
        'paid amount counts the duplicate once',
        ledger.orderMoney(ledger.entry(orderByTable[1])).total,
        Number(billRow.paid_amount),
        'duplicate payment',
      );
    }

    // ── Cancellations after bill generation (T17, T18) ──
    for (const n of [17, 18]) {
      const oid = orderByTable[n];
      await generateBill(A, ownerAuth, ledger, `T${n}`, oid);
      await cancelOrder(
        A,
        ownerAuth,
        ledger,
        `T${n}`,
        oid,
        'إلغاء بعد إصدار الفاتورة وقبل الدفع',
        true,
      );
      const t = (await api(A, '/tables', { headers: ownerAuth })).data.tables.find(
        (x) => x.id === tableIdByNumber[String(n)],
      );
      assertEqualOrThrow(t?.status, 'available', `T${n}: table freed after cancel`);
    }

    // ── Discounts and split money (T21–T26) ──
    await applyDiscount(A, ownerAuth, ledger, 'T21', orderByTable[21], 10, 'زبون دائم');
    await settleOrder(A, ownerAuth, ledger, 'T21', orderByTable[21], [
      { method: 'cash', amount: ledger.orderMoney(ledger.entry(orderByTable[21])).total },
    ]);
    await applyDiscount(A, ownerAuth, ledger, 'T22', orderByTable[22], 20, 'عرض خاص');
    await settleOrder(A, ownerAuth, ledger, 'T22', orderByTable[22], [
      { method: 'cash', amount: ledger.orderMoney(ledger.entry(orderByTable[22])).total },
    ]);
    // T23 split-by-item: one guest pays his items and leaves, the rest pay later.
    {
      const oid = orderByTable[23];
      const bill = await generateBill(A, ownerAuth, ledger, 'T23', oid);
      const cur = (await api(A, `/orders/${oid}`, { headers: ownerAuth })).data.order;
      const lineId = (pid) => findItem(cur, pid).id;
      const split = await api(A, `/bills/${bill.id}/split-check`, {
        method: 'POST',
        headers: ownerAuth,
        body: {
          checks: [
            {
              label: 'Guest 1',
              items: [
                { order_item_id: lineId(SH), quantity: 1 },
                { order_item_id: lineId(FA), quantity: 1 },
                { order_item_id: lineId(CO), quantity: 1 },
              ],
            },
            {
              label: 'Guest 2',
              items: [
                { order_item_id: lineId(SH), quantity: 1 },
                { order_item_id: lineId(FA), quantity: 1 },
                { order_item_id: lineId(CO), quantity: 1 },
              ],
            },
          ],
        },
      });
      assertEqualOrThrow(split.status, 201, 'T23: split-check accepted');
      const children = split.data.bills || [];
      assertEqualOrThrow(children.length, 2, 'T23: two child checks');
      const childSum = children.reduce((s, b) => s + Number(b.total || 0), 0);
      expectMoney(
        'T23',
        'children sum == original exactly',
        ledger.orderMoney(ledger.entry(oid)).total,
        childSum,
        'split-check',
      );
      const [childA, childB] = children;
      const paidA = await payBill(A, ownerAuth, ledger, 'T23', childA.id, oid, [
        { method: 'cash', amount: Number(childA.total) },
      ]);
      assertEqualOrThrow(paidA.payment_status, 'paid', 'T23: guest 1 check paid in cash');
      const paidB = await payBill(A, ownerAuth, ledger, 'T23', childB.id, oid, [
        { method: 'card', amount: Number(childB.total) },
      ]);
      assertEqualOrThrow(paidB.payment_status, 'paid', 'T23: guest 2 check paid by card');
      ledger.completeOrder(oid);
    }
    // T24 / T25: split payment cash+card on one bill.
    for (const [n, cashAmt, cardAmt] of [
      [24, 40000, 30000],
      [25, 25000, 35000],
    ]) {
      const oid = orderByTable[n];
      const e = ledger.entry(oid);
      const m = ledger.orderMoney(e);
      const bill = await generateBill(A, ownerAuth, ledger, `T${n}`, oid);
      const fee = m.fee;
      const cashTotal = cashAmt + Math.round((fee * cashAmt) / (m.base || 1));
      const cardTotal = cardAmt + (fee - Math.round((fee * cashAmt) / (m.base || 1)));
      const paid = await payBill(A, ownerAuth, ledger, `T${n}`, bill.id, oid, [
        { method: 'cash', amount: cashTotal },
        { method: 'card', amount: cardTotal },
      ]);
      assertEqualOrThrow(paid.payment_status, 'paid', `T${n}: split payment settles the bill`);
      ledger.completeOrder(oid);
    }
    // T26: partial payment then remainder. The partial keeps the same
    // cash/card split of the fee as the other split payments (proportional
    // to the base share), so the ledger's cash/card totals stay exact.
    {
      const oid = orderByTable[26];
      const e = ledger.entry(oid);
      const m = ledger.orderMoney(e);
      const bill = await generateBill(A, ownerAuth, ledger, 'T26', oid);
      const partialCash = 25000 + Math.round((m.fee * 25000) / (m.base || 1));
      const partial = await payBill(A, ownerAuth, ledger, 'T26', bill.id, oid, [
        { method: 'cash', amount: partialCash },
      ]);
      assertEqualOrThrow(Number(partial.paid_amount), partialCash, 'T26: partial payment recorded');
      assertOrThrow(
        partial.payment_status !== 'paid',
        'T26: bill is not paid after the partial payment',
      );
      const rest = await payBill(A, ownerAuth, ledger, 'T26', bill.id, oid, [
        { method: 'card', amount: m.total - partialCash },
      ]);
      assertEqualOrThrow(rest.payment_status, 'paid', 'T26: remainder settles the bill');
      ledger.completeOrder(oid);
    }

    // ── T27 (merged) + T31 ──
    await settleOrder(A, ownerAuth, ledger, 'T27', orderByTable[27], [
      { method: 'cash', amount: ledger.orderMoney(ledger.entry(orderByTable[27])).total },
    ]);
    await settleOrder(A, ownerAuth, ledger, 'T31', orderByTable[31], [
      { method: 'cash', amount: ledger.orderMoney(ledger.entry(orderByTable[31])).total },
    ]);

    // ── T32–T35: bill, then more food ──
    for (let n = 32; n <= 35; n++) {
      const oid = orderByTable[n];
      await requestBill(A, ownerAuth, `T${n}`, oid);
      const bill = await generateBill(A, ownerAuth, ledger, `T${n}`, oid);
      await printBill(A, ownerAuth, `T${n}`, bill.id);
      await addItems(A, waiter1.authHeader, ledger, `T${n}`, oid, [[KU, 1]]); // dessert after print
      const regen = await generateBill(A, ownerAuth, ledger, `T${n}`, oid);
      assertEqualOrThrow(regen.id, bill.id, `T${n}: re-generate returns the same bill`);
      const paid = await payBill(A, ownerAuth, ledger, `T${n}`, bill.id, oid, [
        { method: 'cash', amount: ledger.orderMoney(ledger.entry(oid)).total },
      ]);
      assertEqualOrThrow(paid.payment_status, 'paid', `T${n}: bill paid after dessert`);
      ledger.completeOrder(oid);
    }

    // ── T36–T38, T39 (cashier), T40 reseat ──
    await settleOrder(A, ownerAuth, ledger, 'T36', orderByTable[36], [
      { method: 'cash', amount: ledger.orderMoney(ledger.entry(orderByTable[36])).total },
    ]);
    await settleOrder(A, ownerAuth, ledger, 'T37', orderByTable[37], [
      { method: 'cash', amount: ledger.orderMoney(ledger.entry(orderByTable[37])).total },
    ]);
    await settleOrder(A, ownerAuth, ledger, 'T38', orderByTable[38], [
      { method: 'cash', amount: ledger.orderMoney(ledger.entry(orderByTable[38])).total },
    ]);
    {
      const oid = orderByTable[39];
      const bill = await generateBill(A, cashier.authHeader, ledger, 'T39', oid);
      const paid = await payBill(A, cashier.authHeader, ledger, 'T39', bill.id, oid, [
        { method: 'cash', amount: ledger.orderMoney(ledger.entry(oid)).total },
      ]);
      assertEqualOrThrow(paid.payment_status, 'paid', 'T39: self-order table pays at the cashier');
      ledger.completeOrder(oid);
    }
    {
      const reseat = await createDineInOrder(
        A,
        waiter1.authHeader,
        ledger,
        'T40b',
        tableIdByNumber['40'],
        40,
        RESEAT_ITEMS,
      );
      await serveItems(A, chef.authHeader, reseat.id, undefined, ownerAuth);
      await settleOrder(A, ownerAuth, ledger, 'T40b', reseat.id, [
        { method: 'cash', amount: ledger.orderMoney(ledger.entry(reseat.id)).total },
      ]);
    }

    // ── No-table orders settle ──
    await settleOrder(A, ownerAuth, ledger, 'TK1', orderByTable.TK1, [
      { method: 'cash', amount: ledger.orderMoney(ledger.entry(orderByTable.TK1)).total },
    ]);
    await settleOrder(A, ownerAuth, ledger, 'TK2', orderByTable.TK2, [
      { method: 'card', amount: ledger.orderMoney(ledger.entry(orderByTable.TK2)).total },
    ]);
    await settleOrder(A, ownerAuth, ledger, 'DV1', orderByTable.DV1, [
      { method: 'cash', amount: ledger.orderMoney(ledger.entry(orderByTable.DV1)).total },
    ]);
    await settleOrder(A, ownerAuth, ledger, 'DV2', orderByTable.DV2, [
      { method: 'card', amount: ledger.orderMoney(ledger.entry(orderByTable.DV2)).total },
    ]);
    await settleOrder(A, ownerAuth, ledger, 'DV3', orderByTable.DV3, [
      { method: 'cash', amount: ledger.orderMoney(ledger.entry(orderByTable.DV3)).total },
    ]);

    // ── Second seating on five freed tables (T1–T5) ──
    for (let n = 1; n <= 5; n++) {
      const label = `SS${n}`;
      if (n === 5) {
        // One held order: cart held mid-rush, then resumed to payment.
        const hold = await api(A, '/held-orders', {
          method: 'POST',
          headers: waiter1.authHeader,
          body: {
            tableId: tableIdByNumber['5'],
            items: [
              {
                id: 'ss5-sh',
                product: { id: SH, name: PNAME[SH], price: PRICE[SH] },
                quantity: 1,
                addons: [],
                special_instructions: '',
              },
              {
                id: 'ss5-co',
                product: { id: CO, name: PNAME[CO], price: PRICE[CO] },
                quantity: 1,
                addons: [],
                special_instructions: '',
              },
            ],
            guestCount: 2,
          },
        });
        assertEqualOrThrow(hold.status, 200, 'SS5: held order created');
        assertOrThrow(hold.data?.success === true, 'SS5: hold returns success');
        const heldId = hold.data.id;
        const heldList = await api(A, '/held-orders', { headers: waiter1.authHeader });
        const snap = (heldList.data.orders || []).find((o) => o.id === heldId);
        assertOrThrow(!!snap, 'SS5: held order listed');
        const resumed = await api(A, '/orders', {
          method: 'POST',
          headers: waiter1.authHeader,
          body: {
            type: 'dine_in',
            table_id: tableIdByNumber['5'],
            guest_count: snap.guestCount || 2,
            items: (snap.items || []).map((it) => ({
              product_id: it.product.id,
              quantity: it.quantity,
            })),
          },
        });
        assertEqualOrThrow(resumed.status, 201, 'SS5: order re-created from the hold');
        ledger.addOrder(resumed.data.order.id, 'SS5', 5, 'dine_in', RESEAT_ITEMS);
        const del = await api(A, `/held-orders/${tableIdByNumber['5']}?heldOrderId=${heldId}`, {
          method: 'DELETE',
          headers: waiter1.authHeader,
        });
        assertEqualOrThrow(del.status, 200, 'SS5: hold consumed');
        const gone =
          (await api(A, '/held-orders', { headers: waiter1.authHeader })).data.orders || [];
        assertOrThrow(!gone.some((o) => o.id === heldId), 'SS5: hold no longer listed');
        orderByTable.SS5 = resumed.data.order.id;
      } else {
        const order = await createDineInOrder(
          A,
          waiter1.authHeader,
          ledger,
          label,
          tableIdByNumber[String(n)],
          n,
          RESEAT_ITEMS,
        );
        orderByTable[`SS${n}`] = order.id;
      }
    }
    for (let n = 1; n <= 5; n++) {
      const oid = orderByTable[`SS${n}`];
      await serveItems(A, chef.authHeader, oid, undefined, ownerAuth);
      await settleOrder(A, ownerAuth, ledger, `SS${n}`, oid, [
        { method: 'cash', amount: ledger.orderMoney(ledger.entry(oid)).total },
      ]);
    }

    // ── Refunds (Round 2 only, after full payment) ──
    if (doRefunds) {
      // Partial refund: one item (T1's tea line, 10,000) in cash.
      const t1order = (await api(A, `/orders/${orderByTable[1]}`, { headers: ownerAuth })).data
        .order;
      const teaLine = findItem(t1order, TE);
      assertOrThrow(!!teaLine, 'R2 refund: T1 tea line found');
      const t1bill = (await api(A, `/bills/order/${orderByTable[1]}`, { headers: ownerAuth })).data
        .bill;
      const pref = await api(A, '/refunds', {
        method: 'POST',
        headers: ownerAuth,
        body: {
          bill_id: t1bill.id,
          order_item_id: teaLine.id,
          method: 'cash',
          reason: 'إرجاع صنف واحد',
          approver_id: ownerId,
          override_pin: OWNER_PIN,
        },
      });
      assertEqualOrThrow(pref.status, 201, 'R2 refund: partial item refund accepted');
      // The item refund defaults to the line total INCLUDING its fee share
      // (tea 10,000 + 1,000 fee = 11,000); the order/bill totals do not move.
      assertEqualOrThrow(
        Number(pref.data.refund?.amount_cents),
        11000,
        'R2 refund: partial amount = the item line total incl. fee 11,000',
      );
      assertEqualOrThrow(
        pref.data.bill?.payment_status,
        'partially_refunded',
        'R2 refund: bill is partially_refunded',
      );
      ledger.refundItem(orderByTable[1], TE);
      ledger.refunds.push({ label: 'T1-tea', amount: 11000, method: 'cash' });
      // Full refund: T2's whole bill (148,500) in cash.
      const t2bill = (await api(A, `/bills/order/${orderByTable[2]}`, { headers: ownerAuth })).data
        .bill;
      const fref = await api(A, '/refunds', {
        method: 'POST',
        headers: ownerAuth,
        body: {
          bill_id: t2bill.id,
          amount: 148500,
          method: 'cash',
          reason: 'إرجاع كامل',
          approver_id: ownerId,
          override_pin: OWNER_PIN,
        },
      });
      assertEqualOrThrow(fref.status, 201, 'R2 refund: full refund accepted');
      assertEqualOrThrow(fref.data.bill?.payment_status, 'refunded', 'R2 refund: bill is refunded');
      ledger.refunds.push({ label: 'T2-full', amount: 148500, method: 'cash' });
    }

    // ── Cash closure: counted = opening + cash in - cash refunds - expense ──
    const agg = ledger.aggregates();
    const close = await api(A, `/cash-sessions/${sessionId}/close`, {
      method: 'POST',
      headers: ownerAuth,
      body: { counted_cash_cents: agg.countedCash, notes: `full-house ${round}` },
    });
    assertEqualOrThrow(close.status, 200, `${round}: cash session closes`);
    expectMoney(
      `${round} close`,
      'expected cash',
      agg.countedCash,
      Number(close.data?.expected_cash_cents),
      'session close',
    );
    expectMoney(
      `${round} close`,
      'variance',
      0,
      Number(close.data?.variance_cents),
      'session close',
    );

    // ── Finale: three-way reconciliation ──
    await finale(A, ownerAuth, db, ledger, expected, round);

    console.log(
      `    [${round}] done: gross ${agg.gross}, net ${agg.net}, findings so far: ${findings.length}`,
    );
  } finally {
    if (serverAppOn) {
      try {
        const { stopServerApp } = require('../main/server-app');
        await stopServerApp();
      } catch {
        /* ignore */
      }
    }
    server.close();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── Finale: three-way reconciliation (Reports API vs independent SQL
// ledger vs hand-computed constants) + integrity sweep + exports ─────────
async function finale(A, ownerAuth, db, ledger, expected, round) {
  const date = damascusToday();
  const agg = ledger.aggregates();
  const isR3 = round === 'R3';
  console.log(`    [finale ${round}] ledger gross ${agg.gross}, net ${agg.net}`);

  // 1) The ledger must agree with the pinned constants BEFORE either is
  // compared to the system.
  assertEqualOrThrow(
    agg.gross,
    expected.grossCollected,
    `${round} finale: ledger gross == pinned constant`,
  );
  assertEqualOrThrow(
    agg.disc,
    expected.discounts,
    `${round} finale: ledger discounts == pinned constant`,
  );
  assertEqualOrThrow(
    agg.fee,
    isR3 ? expected.tax : expected.fee,
    `${round} finale: ledger fee/tax == pinned constant`,
  );
  assertEqualOrThrow(agg.cash, expected.cash, `${round} finale: ledger cash == pinned constant`);
  assertEqualOrThrow(agg.card, expected.card, `${round} finale: ledger card == pinned constant`);
  assertEqualOrThrow(
    agg.net,
    expected.netCollected,
    `${round} finale: ledger net == pinned constant`,
  );
  assertEqualOrThrow(
    agg.created,
    expected.ordersCreated,
    `${round} finale: ledger orders created == pinned constant`,
  );
  assertEqualOrThrow(
    agg.completed,
    expected.ordersCompleted,
    `${round} finale: ledger orders completed == pinned constant`,
  );
  assertEqualOrThrow(
    agg.cancelled,
    expected.ordersCancelled,
    `${round} finale: ledger orders cancelled == pinned constant`,
  );
  assertEqualOrThrow(
    agg.cancelledNormal,
    expected.ordersCancelledNormal ?? expected.ordersCancelled,
    `${round} finale: ledger normal cancellations == pinned constant`,
  );
  assertEqualOrThrow(
    agg.merged,
    expected.ordersMerged ?? 0,
    `${round} finale: ledger merged == pinned constant`,
  );
  if (!isR3) {
    assertEqualOrThrow(
      agg.byType.dine_in,
      expected.byType.dine_in,
      `${round} finale: ledger dine-in count == pinned constant`,
    );
    assertEqualOrThrow(
      agg.byType.takeaway,
      expected.byType.takeaway,
      `${round} finale: ledger takeaway count == pinned constant`,
    );
    assertEqualOrThrow(
      agg.byType.delivery,
      expected.byType.delivery,
      `${round} finale: ledger delivery count == pinned constant`,
    );
    assertEqualOrThrow(
      agg.selfOrder,
      expected.selfOrder,
      `${round} finale: ledger self-order count == pinned constant`,
    );
    assertEqualOrThrow(
      agg.countedCash,
      expected.countedCash,
      `${round} finale: ledger cash close == pinned constant`,
    );
  }
  for (const [pid, qty] of Object.entries(expected.units)) {
    assertEqualOrThrow(
      agg.units[pid] || 0,
      qty,
      `${round} finale: ledger units ${pid} == pinned constant`,
    );
  }

  // 2) Reports API vs the pinned constants.
  const summary =
    (await api(A, `/reports/summary?date=${date}`, { headers: ownerAuth })).data.summary || {};
  expectMoney(
    `${round} summary`,
    'orders count (non-cancelled)',
    expected.ordersCreated - expected.ordersCancelled,
    summary.orders?.count,
    'summary',
  );
  expectMoney(
    `${round} summary`,
    'orders total',
    expected.grossCollected,
    summary.orders?.total,
    'summary',
  );
  expectMoney(
    `${round} summary`,
    'bills collected (net)',
    expected.netCollected,
    summary.bills?.collected,
    'summary',
  );
  expectMoney(
    `${round} summary`,
    'bills total',
    expected.grossCollected,
    summary.bills?.total,
    'summary',
  );
  if (!isR3)
    expectMoney(
      `${round} summary`,
      'bills count',
      expected.billsCount,
      summary.bills?.count,
      'summary',
    );
  const byStatus = Object.fromEntries(
    (summary.ordersByStatus || []).map((r) => [r.status, r.count]),
  );
  expectMoney(
    `${round} summary`,
    'orders by status: completed',
    expected.ordersCompleted,
    byStatus.completed ?? 0,
    'summary',
  );
  expectMoney(
    `${round} summary`,
    'orders by status: cancelled',
    expected.ordersCancelled,
    byStatus.cancelled ?? 0,
    'summary',
  );
  const cashNet = isR3 ? expected.cash : expected.cash - expected.cashRefunds;
  const pm = Object.fromEntries((summary.paymentMethods || []).map((r) => [r.method, r.total]));
  expectMoney(`${round} summary`, 'payment methods: cash (net)', cashNet, pm.cash ?? 0, 'summary');
  expectMoney(`${round} summary`, 'payment methods: card', expected.card, pm.card ?? 0, 'summary');

  const daily = (await api(A, '/reports/daily-stats', { headers: ownerAuth })).data;
  expectMoney(
    `${round} daily-stats`,
    'sales (net)',
    expected.netCollected,
    daily.sales,
    'daily-stats',
  );
  const dpm = Object.fromEntries((daily.paymentMethods || []).map((r) => [r.method, r.total]));
  expectMoney(
    `${round} daily-stats`,
    'payment methods: cash (net)',
    cashNet,
    dpm.cash ?? 0,
    'daily-stats',
  );
  expectMoney(
    `${round} daily-stats`,
    'payment methods: card',
    expected.card,
    dpm.card ?? 0,
    'daily-stats',
  );

  const x =
    (await api(A, `/reports/x-report?date=${date}`, { headers: ownerAuth })).data.xReport || {};
  expectMoney(
    `${round} x-report`,
    'gross collected',
    expected.grossCollected,
    x.grossCollected,
    'x-report',
  );
  expectMoney(`${round} x-report`, 'refunded', expected.refunds, x.refunded, 'x-report');
  expectMoney(
    `${round} x-report`,
    'net collected',
    expected.netCollected,
    x.netCollected,
    'x-report',
  );
  if (!isR3)
    expectMoney(`${round} x-report`, 'bill count', expected.billsCount, x.billCount, 'x-report');
  expectMoney(
    `${round} x-report`,
    'refund count',
    expected.refunds > 0 ? 2 : 0,
    x.refundCount,
    'x-report',
  );
  const xpm = Object.fromEntries((x.paymentMethods || []).map((r) => [r.method, r.total]));
  expectMoney(
    `${round} x-report`,
    'payment methods: cash (net)',
    cashNet,
    xpm.cash ?? 0,
    'x-report',
  );
  expectMoney(
    `${round} x-report`,
    'payment methods: card',
    expected.card,
    xpm.card ?? 0,
    'x-report',
  );

  const cashSummary =
    (
      await api(A, `/reports/cash-summary?start_date=${date}&end_date=${date}`, {
        headers: ownerAuth,
      })
    ).data.cashSummary || {};
  const day = (cashSummary.days || [])[0] || {};
  // cash_collected is gross cash paid (refunds are netted only in net_collected).
  expectMoney(
    `${round} cash-summary`,
    'cash collected (gross)',
    expected.cash,
    day.cash_collected,
    'cash-summary',
  );
  expectMoney(
    `${round} cash-summary`,
    'net collected',
    expected.netCollected,
    day.net_collected,
    'cash-summary',
  );

  const taxComp =
    (await api(A, '/reports/tax-components', { headers: ownerAuth })).data.taxComponents || {};
  expectMoney(
    `${round} tax-components`,
    'tax amount',
    isR3 ? expected.tax : expected.fee,
    taxComp.taxAmount,
    'tax-components',
  );
  if (!isR3 && expected.fee > 0) {
    const feeComp = (taxComp.components || []).find((c) => c.title === 'رسم الإنفاق الاستهلاكي');
    expectMoney(
      `${round} tax-components`,
      'consumption fee component',
      expected.fee,
      feeComp?.amount,
      'tax-components',
    );
  }
  if (isR3) {
    const salesComp = (taxComp.components || []).find((c) => c.title === 'ضريبة المبيعات');
    const feeComp = (taxComp.components || []).find((c) => c.title === 'رسم الإنفاق الاستهلاكي');
    expectMoney(
      `${round} tax-components`,
      'sales tax component',
      expected.salesTax,
      salesComp?.amount,
      'tax-components',
    );
    expectMoney(
      `${round} tax-components`,
      'consumption fee component',
      expected.fee,
      feeComp?.amount,
      'tax-components',
    );
  }

  const top =
    (
      await api(A, `/reports/topProducts?start_date=${date}&end_date=${date}&limit=100`, {
        headers: ownerAuth,
      })
    ).data.topProducts || [];
  for (const [pid, qty] of Object.entries(expected.units)) {
    const row = top.find((r) => r.product_id === pid);
    expectMoney(
      `${round} topProducts`,
      `units ${pid}`,
      qty,
      row?.total_quantity ?? 0,
      'topProducts',
    );
  }

  const breakdown =
    (
      await api(A, `/reports/sales/breakdown?start_date=${date}&end_date=${date}`, {
        headers: ownerAuth,
      })
    ).data.salesBreakdown || {};
  expectMoney(
    `${round} breakdown`,
    'orders count',
    expected.ordersCreated - expected.ordersCancelled,
    breakdown.totals?.ordersCount,
    'sales/breakdown',
  );
  expectMoney(
    `${round} breakdown`,
    'orders total',
    expected.grossCollected,
    breakdown.totals?.ordersTotal,
    'sales/breakdown',
  );
  expectMoney(
    `${round} breakdown`,
    'collected (gross paid)',
    expected.grossCollected,
    breakdown.totals?.collected,
    'sales/breakdown',
  );
  expectMoney(
    `${round} breakdown`,
    'tax collected',
    isR3 ? expected.tax : expected.fee,
    breakdown.totals?.taxCollected,
    'sales/breakdown',
  );
  expectMoney(
    `${round} breakdown`,
    'discounts',
    expected.discounts,
    breakdown.totals?.discounts,
    'sales/breakdown',
  );
  for (const [pid, qty] of Object.entries(expected.units)) {
    const row = (breakdown.byProduct || []).find((r) => r.product_id === pid);
    expectMoney(
      `${round} breakdown`,
      `byProduct units ${pid}`,
      qty,
      row?.quantity ?? 0,
      'sales/breakdown',
    );
    expectMoney(
      `${round} breakdown`,
      `byProduct total ${pid}`,
      qty * PRICE[pid],
      row?.total ?? 0,
      'sales/breakdown',
    );
  }
  if (!isR3) {
    for (const [type, count] of Object.entries({
      dine_in: expected.ordersCompleted - 2 - 3,
      takeaway: 2,
      delivery: 3,
    })) {
      const row = (breakdown.byOrderType || []).find((r) => r.type === type);
      expectMoney(
        `${round} breakdown`,
        `byOrderType count ${type}`,
        count,
        row?.count ?? 0,
        'sales/breakdown',
      );
    }
  }

  // 3) Independent SQL ledger vs the pinned constants.
  const sqlOrders = db
    .prepare(
      `SELECT status, type, COUNT(*) c, COALESCE(SUM(total),0) t FROM orders GROUP BY status, type`,
    )
    .all();
  const sqlCompleted = sqlOrders.filter((r) => r.status === 'completed');
  expectMoney(
    `${round} sql`,
    'orders completed',
    expected.ordersCompleted,
    sqlCompleted.reduce((s, r) => s + r.c, 0),
    'sql orders',
  );
  expectMoney(
    `${round} sql`,
    'orders total (non-cancelled)',
    expected.grossCollected,
    sqlOrders.filter((r) => r.status !== 'cancelled').reduce((s, r) => s + r.t, 0),
    'sql orders',
  );
  expectMoney(
    `${round} sql`,
    'orders cancelled',
    expected.ordersCancelled,
    sqlOrders.filter((r) => r.status === 'cancelled').reduce((s, r) => s + r.c, 0),
    'sql orders',
  );
  const sqlMerged = db
    .prepare(
      `SELECT COUNT(*) c FROM orders WHERE status='cancelled' AND cancellation_reason LIKE 'دمج%'`,
    )
    .get().c;
  expectMoney(
    `${round} sql`,
    'merged orders distinguished',
    expected.ordersMerged ?? 0,
    sqlMerged,
    'sql orders',
  );
  const sqlSelf = db
    .prepare(`SELECT COUNT(*) c FROM orders WHERE online_platform='self_order'`)
    .get().c;
  expectMoney(
    `${round} sql`,
    'self-order count',
    isR3 ? 0 : expected.selfOrder,
    sqlSelf,
    'sql orders',
  );
  const sqlBills = db
    .prepare(`
    SELECT COUNT(*) c, COALESCE(SUM(b.total),0) t, COALESCE(SUM(b.paid_amount),0) p
    FROM bills b JOIN orders o ON o.id = b.order_id WHERE o.status != 'cancelled'`)
    .get();
  if (!isR3)
    expectMoney(`${round} sql`, 'bills count', expected.billsCount, sqlBills.c, 'sql bills');
  expectMoney(`${round} sql`, 'bills total', expected.grossCollected, sqlBills.t, 'sql bills');
  expectMoney(
    `${round} sql`,
    'bills paid (gross)',
    expected.grossCollected,
    sqlBills.p,
    'sql bills',
  );
  const sqlRefunds = db
    .prepare(`SELECT COUNT(*) c, COALESCE(SUM(amount_cents),0) t FROM refunds`)
    .get();
  expectMoney(`${round} sql`, 'refunds total', expected.refunds, sqlRefunds.t, 'sql refunds');
  expectMoney(
    `${round} sql`,
    'refund count',
    expected.refunds > 0 ? 2 : 0,
    sqlRefunds.c,
    'sql refunds',
  );
  // Cash/card from the raw payment_details JSON (independent of reports.ts).
  const billRows = db
    .prepare(
      `SELECT b.payment_details FROM bills b JOIN orders o ON o.id = b.order_id WHERE o.status != 'cancelled'`,
    )
    .all();
  let sqlCash = 0,
    sqlCard = 0;
  for (const row of billRows) {
    let details = [];
    try {
      details = JSON.parse(row.payment_details || '[]');
    } catch {
      details = [];
    }
    if (!Array.isArray(details)) details = [details];
    for (const line of details) {
      if (line.method === 'cash') sqlCash += Number(line.amount || 0);
      else if (line.method === 'card') sqlCard += Number(line.amount || 0);
    }
  }
  expectMoney(`${round} sql`, 'cash paid (gross)', expected.cash, sqlCash, 'sql payment_details');
  expectMoney(`${round} sql`, 'card paid', expected.card, sqlCard, 'sql payment_details');
  const sqlUnits = db
    .prepare(`
    SELECT oi.product_id, COALESCE(SUM(oi.quantity),0) q
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status != 'cancelled'
      AND COALESCE(oi.status, 'active') NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded')
    GROUP BY oi.product_id`)
    .all();
  for (const [pid, qty] of Object.entries(expected.units)) {
    const row = sqlUnits.find((r) => r.product_id === pid);
    expectMoney(`${round} sql`, `units ${pid}`, qty, Number(row?.q ?? 0), 'sql order_items');
  }

  // 4) Database integrity sweep.
  const nonTerminal = db
    .prepare(`SELECT COUNT(*) c FROM orders WHERE status NOT IN ('completed', 'cancelled')`)
    .get().c;
  expectMoney(
    `${round} sweep`,
    'orders in a non-terminal state',
    0,
    nonTerminal,
    'integrity sweep',
  );
  const orphanItems = db
    .prepare(`
    SELECT COUNT(*) c FROM bill_items bi
    LEFT JOIN bills b ON b.id = bi.bill_id LEFT JOIN order_items oi ON oi.id = bi.order_item_id
    WHERE b.id IS NULL OR oi.id IS NULL`)
    .get().c;
  expectMoney(`${round} sweep`, 'orphan bill items', 0, orphanItems, 'integrity sweep');
  const tablesEnd = db.prepare(`SELECT COUNT(*) c FROM tables WHERE status != 'available'`).get().c;
  // Demo-seeded tables T1–T4 are untouched (available); the 40 rush tables must all be available.
  expectMoney(`${round} sweep`, 'tables not available at day end', 0, tablesEnd, 'integrity sweep');
  // Cancel-after-bill closes the order's unpaid, never-paid bill in the
  // same transaction (assignment 033, F-R1-1 fixed): no orphaned live
  // unpaid bill may survive its cancelled order. The closed row itself
  // still exists with payment_status 'cancelled', total intact, paid 0 —
  // the sweep below asserts exactly that shape.
  const orphanBills = db
    .prepare(`
    SELECT COUNT(*) c, COALESCE(SUM(b.paid_amount),0) p FROM bills b
    JOIN orders o ON o.id = b.order_id WHERE o.status = 'cancelled' AND b.payment_status = 'unpaid'`)
    .get();
  expectMoney(
    `${round} sweep`,
    'orphaned unpaid bills of cancelled orders',
    0,
    orphanBills.c,
    'integrity sweep (assignment 033: zero after the Fix 2 closure)',
  );
  expectMoney(`${round} sweep`, 'orphaned bills paid amount', 0, orphanBills.p, 'integrity sweep');
  const closedBills = db
    .prepare(`
    SELECT COUNT(*) c FROM bills b
    JOIN orders o ON o.id = b.order_id WHERE o.status = 'cancelled' AND b.payment_status = 'cancelled'`)
    .get();
  expectMoney(
    `${round} sweep`,
    'cancelled orders whose unpaid bill reads cancelled',
    isR3 ? 0 : 2,
    closedBills.c,
    'integrity sweep (Fix 2: the two cancel-after-bill rows close)',
  );
  // The sold-out product stays sold out at day end (never auto-resets).
  if (!isR3) {
    const probe = await api(A, '/orders', {
      method: 'POST',
      headers: ownerAuth,
      body: { type: 'takeaway', items: [{ product_id: MA, quantity: 1 }] },
    });
    assertEqualOrThrow(
      probe.status,
      400,
      `${round} sweep: sold-out product still refused at day end`,
    );
    assertOrThrow(
      String(probe.data?.error || '').includes('sold out'),
      `${round} sweep: day-end refusal names sold out`,
    );
  }

  // 5) Exports carry the same headline numbers as the API. The daily CSV
  // part=summary is metric,value rows (order_count, gross_collected,
  // net_collected, refunds_issued, tax_total, discount_total, payment_*).
  const csv = await fetchRaw(
    `${A}/reports/daily-sales/export?date=${date}&format=csv&part=summary`,
    { headers: ownerAuth },
  );
  assertEqualOrThrow(csv.status, 200, `${round} export: daily CSV returns 200`);
  const csvText = String(csv.text || '').replace(/"/g, '');
  expectEqual(
    `${round} export`,
    'CSV carries order_count',
    true,
    csvText.includes(`order_count,${expected.ordersCreated - expected.ordersCancelled}`),
    'daily CSV export',
  );
  expectEqual(
    `${round} export`,
    'CSV carries gross_collected',
    true,
    csvText.includes(`gross_collected,${expected.grossCollected}`),
    'daily CSV export',
  );
  expectEqual(
    `${round} export`,
    'CSV carries net_collected',
    true,
    csvText.includes(`net_collected,${expected.netCollected}`),
    'daily CSV export',
  );
  expectEqual(
    `${round} export`,
    'CSV carries refunds_issued',
    true,
    csvText.includes(`refunds_issued,${expected.refunds}`),
    'daily CSV export',
  );
  expectEqual(
    `${round} export`,
    'CSV carries tax_total',
    true,
    csvText.includes(`tax_total,${isR3 ? expected.tax : expected.fee}`),
    'daily CSV export',
  );
  expectEqual(
    `${round} export`,
    'CSV carries discount_total',
    true,
    csvText.includes(`discount_total,${expected.discounts}`),
    'daily CSV export',
  );
  expectEqual(
    `${round} export`,
    'CSV carries payment_cash (net)',
    true,
    csvText.includes(`payment_cash,${isR3 ? expected.cash : expected.cash - expected.cashRefunds}`),
    'daily CSV export',
  );
  expectEqual(
    `${round} export`,
    'CSV carries payment_card',
    true,
    csvText.includes(`payment_card,${expected.card}`),
    'daily CSV export',
  );
  const xlsx = await fetchRaw(`${A}/reports/daily-sales/export?date=${date}&format=xlsx`, {
    headers: ownerAuth,
  });
  assertEqualOrThrow(xlsx.status, 200, `${round} export: daily XLSX returns 200`);
  assertOrThrow(
    String(xlsx.contentType).includes('spreadsheetml'),
    `${round} export: XLSX content type`,
  );
  assertOrThrow((xlsx.text || '').length > 1000, `${round} export: XLSX payload is non-empty`);
  const xcsv = await fetchRaw(`${A}/reports/x-report/export?date=${date}&format=csv`, {
    headers: ownerAuth,
  });
  assertEqualOrThrow(xcsv.status, 200, `${round} export: X-report CSV returns 200`);
  expectEqual(
    `${round} export`,
    'X-report CSV carries net collected',
    true,
    String(xcsv.text || '')
      .replace(/"/g, '')
      .replace(/,/g, '')
      .includes(String(expected.netCollected)),
    'x-report CSV export',
  );
  console.log(`    [finale ${round}] three-way reconciliation + sweep + exports checked`);
}

// ── Round 3: combined-tax probe (fresh DB, 4 tables) ───────────────────────
async function runRound3() {
  console.log('\n########## ROUND 3 — combined tax probe: manual 5% + fee 10% ##########');
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-full-house-'));
  const db = initTestDb();
  const app = buildApp();
  const { server, baseUrl } = await startServer(app);
  const A = baseUrl + '/api';
  const ledger = new Ledger(0); // feePct 0: the manual pack carries both tax lines; the ledger tracks the combined 15% as its fee
  ledger.feePct = 15;
  try {
    const { ownerAuth } = await setupShop(baseUrl, db, 'مطعم الفول ج');
    const waiter = seedStaffUser(
      db,
      'waiter-fh-R3',
      'نادل',
      'waiter-R3@test.local',
      'server',
      null,
    );
    const chef = seedStaffUser(db, 'chef-fh-R3', 'شيف', 'chef-R3@test.local', 'chef', null);
    seedMenu(db);
    const bulk = await api(A, '/tables/bulk', {
      method: 'POST',
      headers: ownerAuth,
      body: { from: 1, to: 4, capacity: 4 },
    });
    assertEqualOrThrow(bulk.status, 201, 'R3: bulk-create 4 tables');
    const tablesRes = await api(A, '/tables', { headers: ownerAuth });
    const tableIdByNumber = {};
    for (const t of tablesRes.data.tables || []) tableIdByNumber[String(t.number)] = t.id;

    // Manual mode, two percent components in one category: sales tax 5% AND
    // consumption fee 10% together. Expected per the charges/tax engine
    // order of operations: discount first, each line on the discounted base.
    const manual = await api(A, '/tax-packs/manual-config', {
      method: 'POST',
      headers: ownerAuth,
      body: {
        inclusive: false,
        categories: [
          {
            tempId: 'only',
            label: 'خدمات المنشأة',
            components: [
              { label: 'ضريبة المبيعات', type: 'percent', value: '5' },
              { label: 'رسم الإنفاق الاستهلاكي', type: 'percent', value: '10' },
            ],
          },
        ],
        defaultProductCategoryTempId: 'only',
        packagingCategoryTempId: 'only',
        deliveryCategoryTempId: 'only',
        serviceChargeCategoryTempId: 'only',
      },
    });
    assertEqualOrThrow(manual.status, 200, 'R3: manual two-component pack saved');
    const packs = await api(A, '/tax-packs', { headers: ownerAuth });
    const active = (packs.data.packs || []).find((p) => p.active_for_store);
    assertEqualOrThrow(active?.id, 'manual-sy', 'R3: manual pack is the active pack');

    const plans = [
      { label: 'R3-T1', n: 1, items: [[SH, 2]], discount: 0, pay: 'cash' },
      {
        label: 'R3-T2',
        n: 2,
        items: [
          [KU, 1],
          [CO, 1],
        ],
        discount: 0,
        pay: 'card',
      },
      { label: 'R3-T3', n: 3, items: [[MA, 1]], discount: 0, pay: 'cash' },
      { label: 'R3-T4', n: 4, items: [[SH, 2]], discount: 10, pay: 'cash' },
    ];
    for (const p of plans) {
      const order = await createDineInOrder(
        A,
        waiter.authHeader,
        ledger,
        p.label,
        tableIdByNumber[String(p.n)],
        p.n,
        p.items,
      );
      await serveItems(A, chef.authHeader, order.id, undefined, ownerAuth);
      if (p.discount > 0)
        await applyDiscount(A, ownerAuth, ledger, p.label, order.id, p.discount, 'probe');
      const bill = await generateBill(A, ownerAuth, ledger, p.label, order.id);
      const bd = normalizeBreakdown(bill.tax_breakdown);
      const sales = bd.find((l) => l.title === 'ضريبة المبيعات');
      const fee = bd.find((l) => l.title === 'رسم الإنفاق الاستهلاكي');
      const m = ledger.orderMoney(ledger.entry(order.id));
      expectMoney(
        p.label,
        'sales tax line (5% of discounted base)',
        Math.round((m.base * 5) / 100),
        sales?.amount,
        'R3 stacking',
      );
      expectMoney(
        p.label,
        'fee line (10% of discounted base)',
        Math.round((m.base * 10) / 100),
        fee?.amount,
        'R3 stacking',
      );
      const paid = await payBill(A, ownerAuth, ledger, p.label, bill.id, order.id, [
        { method: p.pay, amount: m.total },
      ]);
      assertEqualOrThrow(paid.payment_status, 'paid', `${p.label}: bill paid`);
      ledger.completeOrder(order.id);
    }
    await finale(A, ownerAuth, db, ledger, EXPECTED_R3, 'R3');

    // ── Stacking probe (finding F-R3-1, FIXED by assignment 033): two
    // separate tax packs cannot stack. With the manual pack active,
    // activating the Syria consumption profile is REJECTED (409,
    // active_pack_conflict) before anything mutates, and checkout keeps
    // working with the manual pack's numbers. The rejection, the single
    // active pack, and the surviving checkout are all pinned here.
    console.log(
      '    [R3 stacking probe] activating the Syria profile while the manual pack is active…',
    );
    const react = await api(A, '/tax-packs/syria-profile', {
      method: 'POST',
      headers: ownerAuth,
      body: { profile: 'consumption', classification: 'rated_4_5' },
    });
    assertEqualOrThrow(
      react.status,
      409,
      'R3 probe: Syria profile activation over the active manual pack is rejected',
    );
    assertEqualOrThrow(
      react.data?.code,
      'active_pack_conflict',
      'R3 probe: the rejection carries the stable error code',
    );
    assertEqualOrThrow(
      react.data?.active_pack_id,
      'manual-sy',
      'R3 probe: the rejection names the active manual pack',
    );
    const packsAfter = await api(A, '/tax-packs', { headers: ownerAuth });
    const activeAfter = (packsAfter.data.packs || [])
      .filter((p) => p.active_for_store)
      .map((p) => p.id);
    assertEqualOrThrow(
      JSON.stringify(activeAfter),
      JSON.stringify(['manual-sy']),
      'R3 probe: only the manual pack stays active after the rejected switch',
    );
    const stillWorks = await api(A, '/orders', {
      method: 'POST',
      headers: waiter.authHeader,
      body: { type: 'takeaway', items: [{ product_id: SH, quantity: 1 }] },
    });
    assertEqualOrThrow(
      stillWorks.status,
      201,
      'R3 probe: checkout still works after the rejected switch',
    );
    console.log(
      '    [R3 stacking probe] F-R3-1 FIXED: profile switch rejected (409 active_pack_conflict), checkout unbroken with manual numbers',
    );
    console.log('    [R3] done');
  } finally {
    server.close();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  const t0 = Date.now();
  await runRound({ round: 'R1', feePct: 0, expected: EXPECTED_R1, doRefunds: false });
  await runRound({ round: 'R2', feePct: 10, expected: EXPECTED_R2, doRefunds: true });
  await runRound3();
  // Simultaneity timing table: generous sanity bounds only.
  const singles = timings.filter((t) => !t.label.includes('burst')).map((t) => t.ms);
  const med = median(singles);
  console.log('\n' + '='.repeat(60));
  console.log('SIMULTANEITY TIMING TABLE (ms)');
  for (const t of timings.filter((x) => x.label.includes('burst'))) {
    const bound = Math.max(10, t.ops || 1) * med;
    const flag =
      med > 0 && t.ms > bound
        ? `  <-- PATHOLOGICAL (>${Math.max(10, t.ops || 1)}x median single op)`
        : '';
    console.log(`  ${t.label}: ${t.ms}ms (median single op: ${med}ms, bound: ${bound}ms)${flag}`);
    if (flag)
      recordFinding(
        'timing',
        `burst ${t.label} took longer than running its ${t.ops || 1} calls serially`,
        `<= ${bound}ms`,
        `${t.ms}ms`,
        'timing table',
      );
  }
  console.log('='.repeat(60));
  console.log(
    `RESTAURANT FULL HOUSE: findings: ${findings.length}, runtime ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
  if (findings.length > 0) {
    console.log('\nFINDINGS (verbatim):');
    for (const f of findings) {
      console.log(
        `  - [${f.scenario}] ${f.label}: expected ${f.expected}, actual ${f.actual}${f.context ? ` (${f.context})` : ''}`,
      );
    }
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
