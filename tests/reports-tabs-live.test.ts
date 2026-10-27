/**
 * Integration Test: Reports Tabs — live paid-order regression
 *
 * Reproduces the field report "Daily all zero / Sales partial / Cash empty"
 * against a REAL order → bill → cash-payment flow (no hand-seeded bills)
 * under the production Syrian configuration (country '', SYP, SP,
 * Asia/Damascus), then pins the fixed behavior:
 *  A) The daily endpoints the Reports page calls return the paid order's
 *     numbers for the tenant business day (== independent SQL oracle).
 *  B) /reports/cash-summary with NO cash session ever opened still shows
 *     the day's ledger collections in `days` (sessions/closures stay empty
 *     by design — payments never require a session).
 *  C) After a session is opened and closed, it still lists as before.
 *  D) A manager (reports.view, no reports.financial.view) gets 403 on
 *     financial-summary while the other daily sources stay readable — the
 *     split the Reports page now tolerates per-source.
 *  E) A wrong business date reads zeros (the day-basis sensitivity behind
 *     the original report; the page now anchors presets on the shared
 *     business-date rule instead of the device clock).
 *
 * Usage: node tests/run-electron-node-test.cjs tests/reports-tabs-live.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reports-tabs-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedManagerUser,
  seedCategory,
  seedProduct,
  seedTable,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { reportRoutes } = require('../main/routes/reports');
const { expenseRoutes } = require('../main/routes/expenses');
const { cashSessionRoutes } = require('../main/routes/cash-sessions');
const {
  dayBoundsInTimezone,
  localDateInTimezone,
  tenantBusinessDayStartTime,
} = require('../main/db');

async function main() {
  console.log('Integration Test: Reports Tabs Live Regression');
  console.log('='.repeat(50));

  const db = initTestDb();
  // Production Syrian configuration (overrides the harness IN/INR/Kolkata).
  const setSetting = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  );
  setSetting.run('country', '');
  setSetting.run('currency', 'SYP');
  setSetting.run('currency_symbol', 'SP');
  setSetting.run('timezone', 'Asia/Damascus');

  const owner = seedOwnerUser(db);
  const H = owner.authHeader;
  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/reports': reportRoutes,
    '/api/expenses': expenseRoutes,
    '/api/cash-sessions': cashSessionRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  seedCategory(db, 'cat-1', 'Mains');
  seedProduct(db, 'prod-1', 'cat-1', 'Shawarma', 10000);
  seedTable(db, 'tbl-1', 5);

  // ── Real flow: dine-in order → bill → full cash payment (no session) ────
  const order = await api(baseUrl, '/api/orders', {
    method: 'POST',
    headers: H,
    body: { type: 'dine_in', table_id: 'tbl-1', items: [{ product_id: 'prod-1', quantity: 2 }] },
  });
  assertEqualOrThrow(order.status, 201, 'dine-in order created');
  const bill = await api(baseUrl, '/api/bills/generate', {
    method: 'POST',
    headers: H,
    body: { order_id: order.data.order.id },
  });
  assertEqualOrThrow(bill.status, 201, 'bill generated');
  const payment = await api(baseUrl, `/api/bills/${bill.data.bill.id}/payments`, {
    method: 'POST',
    headers: { ...H, 'Idempotency-Key': 'tabs-live-key-1' },
    body: { payments: [{ method: 'cash', amount: bill.data.bill.total }] },
  });
  assertEqualOrThrow(payment.status, 200, 'cash payment accepted');
  assertEqualOrThrow(payment.data.bill.payment_status, 'paid', 'bill is paid');

  const tz = 'Asia/Damascus';
  const today = localDateInTimezone(new Date(), tz, tenantBusinessDayStartTime(db));
  const [winStart, winEnd] = dayBoundsInTimezone(today, tz, tenantBusinessDayStartTime(db));

  // ── A) daily endpoints == SQL oracle ─────────────────────────────────────
  const ordersSql = db
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS s FROM orders
       WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'`,
    )
    .get(winStart, winEnd) as { s: number };
  assertEqualOrThrow(ordersSql.s, 20000, 'oracle: orders sum is 20000');

  const fin = await api(
    baseUrl,
    `/api/reports/financial-summary?start_date=${today}&end_date=${today}`,
    { headers: H },
  );
  assertEqualOrThrow(fin.status, 200, 'financial-summary returns 200 for owner');
  assertEqualOrThrow(fin.data.financialSummary.grossCollected, 20000, 'daily collected == 20000');
  assertEqualOrThrow(fin.data.financialSummary.netCollected, 20000, 'daily net == 20000');
  assertEqualOrThrow(fin.data.financialSummary.billCount, 1, 'daily billCount == 1');
  assertEqualOrThrow(
    fin.data.financialSummary.paymentMethods.find((r: any) => r.method === 'cash')?.total,
    20000,
    'daily paymentMethods cash == 20000',
  );

  const sum = await api(baseUrl, `/api/reports/summary?date=${today}`, { headers: H });
  assertEqualOrThrow(sum.status, 200, 'summary returns 200');
  assertEqualOrThrow(sum.data.summary.orders.count, 1, 'summary orders count == 1');
  assertEqualOrThrow(sum.data.summary.orders.total, 20000, 'summary orders total == 20000');
  assertEqualOrThrow(
    sum.data.summary.ordersByStatus.find((r: any) => r.status === 'completed')?.count,
    1,
    'summary completed count == 1',
  );

  const x = await api(baseUrl, `/api/reports/x-report?date=${today}`, { headers: H });
  assertEqualOrThrow(x.status, 200, 'x-report returns 200');
  assertEqualOrThrow(
    Number(x.data.xReport.expectedCashCents || 0) + Number(x.data.xReport.openingFloatCents || 0),
    20000,
    'x-report expected cash (incl. float) == 20000',
  );

  const brk = await api(
    baseUrl,
    `/api/reports/sales/breakdown?start_date=${today}&end_date=${today}`,
    { headers: H },
  );
  assertEqualOrThrow(brk.status, 200, 'breakdown returns 200');
  assertEqualOrThrow(brk.data.salesBreakdown.totals.ordersTotal, 20000, 'sales ordersTotal == 20000');
  assertEqualOrThrow(brk.data.salesBreakdown.totals.collected, 20000, 'sales collected == 20000');
  console.log('  ✓ A: daily + sales endpoints reconcile with the SQL oracle');

  // ── B) cash-summary without any session: days carry the collections ──────
  const cash = await api(
    baseUrl,
    `/api/reports/cash-summary?start_date=${today}&end_date=${today}`,
    { headers: H },
  );
  assertEqualOrThrow(cash.status, 200, 'cash-summary returns 200');
  assertEqualOrThrow(cash.data.cashSummary.sessions.length, 0, 'no sessions exist (by design)');
  assertEqualOrThrow(cash.data.cashSummary.closures.length, 0, 'no closures exist (by design)');
  assertEqualOrThrow(cash.data.cashSummary.days.length, 1, 'cash days has the paid day');
  const day = cash.data.cashSummary.days[0];
  assertEqualOrThrow(day.business_date, today, 'cash day is the business today');
  assertEqualOrThrow(day.bill_count, 1, 'cash day bill_count == 1');
  assertEqualOrThrow(day.gross_collected, 20000, 'cash day gross == 20000');
  assertEqualOrThrow(day.net_collected, 20000, 'cash day net == 20000');
  assertEqualOrThrow(day.cash_collected, 20000, 'cash day cash == 20000');
  assertEqualOrThrow(day.expected_cash, 20000, 'cash day expected == 20000');

  const cashCsv = await (globalThis as any).fetch(
    `${baseUrl}/api/reports/cash/export?start_date=${today}&end_date=${today}&format=csv`,
    { headers: H },
  );
  assertEqualOrThrow(cashCsv.status, 200, 'cash export csv returns 200');
  const cashCsvText = await cashCsv.text();
  assertOrThrow(cashCsvText.includes(`day,${today}`), 'cash export CSV carries the ledger day row');
  console.log('  ✓ B: cash-summary days show collections with zero sessions/closures');

  // ── C) session lifecycle still lists alongside days ──────────────────────
  const opened = await api(baseUrl, '/api/cash-sessions/open', {
    method: 'POST',
    headers: H,
    body: { opening_float_cents: 5000 },
  });
  assertEqualOrThrow(opened.status, 200, 'cash session opens');
  const sessionId = opened.data.session?.id ?? opened.data.id;
  assertOrThrow(Number.isInteger(sessionId), 'open returns a session id');
  const closed = await api(baseUrl, `/api/cash-sessions/${sessionId}/close`, {
    method: 'POST',
    headers: H,
    body: { counted_cash_cents: 25000 },
  });
  assertEqualOrThrow(closed.status, 200, 'cash session closes');
  const cash2 = await api(
    baseUrl,
    `/api/reports/cash-summary?start_date=${today}&end_date=${today}`,
    { headers: H },
  );
  assertEqualOrThrow(cash2.data.cashSummary.sessions.length, 1, 'closed session is listed');
  assertEqualOrThrow(cash2.data.cashSummary.sessions[0].status, 'closed', 'session shows closed');
  assertEqualOrThrow(cash2.data.cashSummary.days.length, 1, 'ledger day still listed');
  console.log('  ✓ C: session rows keep working next to the ledger days');

  // ── D) manager: financial 403, other daily sources fine ──────────────────
  const manager = seedManagerUser(db);
  const finMgr = await api(
    baseUrl,
    `/api/reports/financial-summary?start_date=${today}&end_date=${today}`,
    { headers: manager.authHeader },
  );
  assertEqualOrThrow(finMgr.status, 403, 'manager lacks reports.financial.view (403 by design)');
  const sumMgr = await api(baseUrl, `/api/reports/summary?date=${today}`, {
    headers: manager.authHeader,
  });
  assertEqualOrThrow(sumMgr.status, 200, 'manager summary returns 200');
  assertEqualOrThrow(sumMgr.data.summary.orders.count, 1, 'manager sees the order in summary');
  const brkMgr = await api(
    baseUrl,
    `/api/reports/sales/breakdown?start_date=${today}&end_date=${today}`,
    { headers: manager.authHeader },
  );
  assertEqualOrThrow(brkMgr.status, 200, 'manager breakdown returns 200');
  console.log('  ✓ D: permission split documented (financial is owner-only)');

  // ── E) wrong business date reads zeros ───────────────────────────────────
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowStr = tomorrow.toISOString().slice(0, 10);
  const finWrong = await api(
    baseUrl,
    `/api/reports/financial-summary?start_date=${tomorrowStr}&end_date=${tomorrowStr}`,
    { headers: H },
  );
  assertEqualOrThrow(finWrong.status, 200, 'wrong-date financial-summary returns 200');
  assertEqualOrThrow(
    finWrong.data.financialSummary.grossCollected,
    0,
    'wrong business date collects 0 (day-basis sensitivity)',
  );
  console.log('  ✓ E: day basis is exact — a different date is a different (empty) day');

  server.close();
  closeDatabase();
  console.log('\nAll reports tabs live regression tests passed.');
}

main().catch((error) => {
  console.error('Reports tabs live regression test failed:', error);
  process.exit(1);
});
