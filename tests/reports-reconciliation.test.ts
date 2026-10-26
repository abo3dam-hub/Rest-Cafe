/**
 * Integration Test: Reports Section — reconciliation (W4)
 *
 * Seeds orders/bills/items with known amounts on the tenant's business
 * "today" and proves the reports agree with an independent SQL sum over the
 * same ledger rows:
 *  A) GET /reports/sales daily totals == SQL SUM(orders.total) (non-cancelled)
 *     and its by-type rows match the seeded split.
 *  B) GET /reports/sales/breakdown totals == the same orders sum, and its
 *     collected total == SQL SUM(bills.paid_amount) for bills paid in range.
 *  C) GET /reports/sales/export?format=csv returns 200 and contains the
 *     seeded orders total; the xlsx variant returns 200 too.
 *  D) GET /reports/cash/export returns 200 (csv + xlsx) with a seeded
 *     session/closure present, and /reports/cash-summary lists them.
 *  E) GET /reports/daily-stats sales == SQL collected (paid bills minus
 *     refunds) for the business day.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/reports-reconciliation.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reports-recon-'));
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
  seedCategory,
  seedProduct,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');

const { reportRoutes } = require('../main/routes/reports');
const { dayBoundsInTimezone, tenantBusinessDayStartTime } = require('../main/db');

function dbNow(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\..*$/, '');
}

async function main() {
  console.log('Integration Test: Reports Reconciliation');
  console.log('='.repeat(50));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const H = owner.authHeader;
  const app = createApp({ '/api/reports': reportRoutes });
  const { baseUrl, server } = await startServer(app);

  seedCategory(db, 'cat-1', 'Mains');
  seedProduct(db, 'prod-1', 'cat-1', 'Shawarma', 10000);
  seedProduct(db, 'prod-2', 'cat-1', 'Coffee', 10000);

  // Tenant business "today" in the seeded test timezone (Asia/Kolkata).
  const tz = 'Asia/Kolkata';
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [winStart, winEnd] = dayBoundsInTimezone(today, tz, tenantBusinessDayStartTime(db));
  const ts = dbNow();

  // ── Seed: order A (dine_in, completed, fully paid 30000) ────────────────
  const orderA = db
    .prepare(
      `INSERT INTO orders (order_number, type, status, subtotal, total, completed_at, created_at, updated_at)
       VALUES ('ORD-RECON-A', 'dine_in', 'completed', 30000, 30000, ?, ?, ?) RETURNING id`,
    )
    .get(ts, ts, ts) as { id: number };
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
     VALUES (?, 'prod-1', 'Shawarma', 10000, 2, 20000, 20000, 'served', ?, ?)`,
  ).run(orderA.id, ts, ts);
  db.prepare(
    `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
     VALUES (?, 'prod-2', 'Coffee', 10000, 1, 10000, 10000, 'served', ?, ?)`,
  ).run(orderA.id, ts, ts);
  db.prepare(
    `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, payment_details, paid_at, created_at, updated_at)
     VALUES ('BILL-RECON-A', ?, 30000, 30000, 30000, 0, 'paid', ?, ?, ?, ?)`,
  ).run(orderA.id, JSON.stringify([{ method: 'cash', amount: 30000 }]), ts, ts, ts);

  // ── Seed: order B (takeaway, open, unpaid 5000) ──────────────────────────
  const orderB = db
    .prepare(
      `INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
       VALUES ('ORD-RECON-B', 'takeaway', 'pending', 5000, 5000, ?, ?) RETURNING id`,
    )
    .get(ts, ts) as { id: number };
  db.prepare(
    `INSERT INTO bills (bill_number, order_id, subtotal, total, paid_amount, balance, payment_status, created_at, updated_at)
     VALUES ('BILL-RECON-B', ?, 5000, 5000, 0, 5000, 'unpaid', ?, ?)`,
  ).run(orderB.id, ts, ts);

  // ── Independent SQL sums (the reconciliation oracle) ─────────────────────
  const ordersSql = db
    .prepare(
      `SELECT COALESCE(SUM(total), 0) AS s FROM orders
       WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'`,
    )
    .get(winStart, winEnd) as { s: number };
  assertEqualOrThrow(ordersSql.s, 35000, 'oracle: seeded orders sum is 35000');
  const collectedSql = db
    .prepare(
      `SELECT COALESCE(SUM(b.paid_amount), 0) AS s FROM bills b JOIN orders o ON o.id = b.order_id
       WHERE b.paid_at >= ? AND b.paid_at < ? AND o.status != 'cancelled'`,
    )
    .get(winStart, winEnd) as { s: number };
  assertEqualOrThrow(collectedSql.s, 30000, 'oracle: seeded collected sum is 30000');

  // ── A) /reports/sales ────────────────────────────────────────────────────
  const sales = await api(baseUrl, `/api/reports/sales?start_date=${today}&end_date=${today}`, {
    headers: H,
  });
  assertEqualOrThrow(sales.status, 200, 'GET /reports/sales returns 200');
  const dailySum = (sales.data.sales.dailySales as any[]).reduce((acc, r) => acc + r.sales, 0);
  assertEqualOrThrow(dailySum, ordersSql.s, '/sales dailySales sum == independent SQL orders sum');
  const typeRows = sales.data.sales.byOrderType as any[];
  assertEqualOrThrow(
    typeRows.find((r) => r.type === 'dine_in')?.total,
    30000,
    '/sales byOrderType dine_in == 30000',
  );
  assertEqualOrThrow(
    typeRows.find((r) => r.type === 'takeaway')?.total,
    5000,
    '/sales byOrderType takeaway == 5000',
  );
  console.log('  ✓ A: /reports/sales reconciles with the SQL oracle');

  // ── B) /reports/sales/breakdown ──────────────────────────────────────────
  const brk = await api(
    baseUrl,
    `/api/reports/sales/breakdown?start_date=${today}&end_date=${today}`,
    { headers: H },
  );
  assertEqualOrThrow(brk.status, 200, 'GET /reports/sales/breakdown returns 200');
  const bd = brk.data.salesBreakdown;
  assertEqualOrThrow(bd.totals.ordersTotal, ordersSql.s, 'breakdown ordersTotal == SQL orders sum');
  assertEqualOrThrow(bd.totals.collected, collectedSql.s, 'breakdown collected == SQL paid sum');
  const shawarma = (bd.byProduct as any[]).find((r) => r.product_name === 'Shawarma');
  assertOrThrow(!!shawarma, 'breakdown byProduct contains Shawarma');
  assertEqualOrThrow(shawarma.quantity, 2, 'breakdown Shawarma quantity == 2');
  assertEqualOrThrow(shawarma.total, 20000, 'breakdown Shawarma total == 20000');
  assertOrThrow(
    (bd.byHour as any[]).reduce((a, r) => a + r.count, 0) === 2,
    'breakdown byHour counts both seeded orders',
  );
  console.log('  ✓ B: /reports/sales/breakdown reconciles (totals, products, hours)');

  // ── C) /reports/sales/export ─────────────────────────────────────────────
  const csvRes = await (globalThis as any).fetch(
    `${baseUrl}/api/reports/sales/export?start_date=${today}&end_date=${today}&format=csv`,
    { headers: H },
  );
  assertEqualOrThrow(csvRes.status, 200, 'GET /reports/sales/export?format=csv returns 200');
  const csvText = await csvRes.text();
  assertOrThrow(csvText.includes('35000'), 'sales export CSV contains the seeded orders total 35000');
  assertOrThrow(csvText.includes('Shawarma'), 'sales export CSV contains the seeded product');
  const xlsxRes = await (globalThis as any).fetch(
    `${baseUrl}/api/reports/sales/export?start_date=${today}&end_date=${today}&format=xlsx`,
    { headers: H },
  );
  assertEqualOrThrow(xlsxRes.status, 200, 'GET /reports/sales/export?format=xlsx returns 200');
  console.log('  ✓ C: /reports/sales/export serves csv (seeded figures) and xlsx');

  // ── D) cash summary + export ─────────────────────────────────────────────
  const closure = db
    .prepare(
      `INSERT INTO cash_closures (scope, business_date, period_start, period_end,
         opening_float_cents, expected_cash_cents, counted_cash_cents, variance_cents,
         gross_collected_cents, refunded_cents, net_collected_cents, bill_count, refund_count,
         z_number, closed_by, created_at)
       VALUES ('day', ?, ?, ?, 0, 3000000, 3000000, 0, 3000000, 0, 3000000, 1, 0, 9001, ?, ?)
       RETURNING id`,
    )
    .get(today, winStart, winEnd, owner.userId, ts) as { id: number };
  db.prepare(
    `INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status, closed_at, closed_by, closure_id)
     VALUES (?, 'Test Owner', ?, 0, 'closed', ?, ?, ?)`,
  ).run(owner.userId, ts, ts, owner.userId, closure.id);

  const cashSummary = await api(
    baseUrl,
    `/api/reports/cash-summary?start_date=${today}&end_date=${today}`,
    { headers: H },
  );
  assertEqualOrThrow(cashSummary.status, 200, 'GET /reports/cash-summary returns 200');
  assertEqualOrThrow(cashSummary.data.cashSummary.sessions.length, 1, 'cash-summary lists the seeded session');
  assertEqualOrThrow(cashSummary.data.cashSummary.closures.length, 1, 'cash-summary lists the seeded closure');
  assertEqualOrThrow(
    cashSummary.data.cashSummary.closures[0].net_collected,
    30000,
    'cash-summary closure net == 30000 (cents converted by minor factor)',
  );

  const cashCsv = await (globalThis as any).fetch(
    `${baseUrl}/api/reports/cash/export?start_date=${today}&end_date=${today}&format=csv`,
    { headers: H },
  );
  assertEqualOrThrow(cashCsv.status, 200, 'GET /reports/cash/export?format=csv returns 200');
  const cashCsvText = await cashCsv.text();
  assertOrThrow(cashCsvText.includes(today), 'cash export CSV contains the seeded business date');
  const cashXlsx = await (globalThis as any).fetch(
    `${baseUrl}/api/reports/cash/export?start_date=${today}&end_date=${today}&format=xlsx`,
    { headers: H },
  );
  assertEqualOrThrow(cashXlsx.status, 200, 'GET /reports/cash/export?format=xlsx returns 200');
  console.log('  ✓ D: /reports/cash-summary + /reports/cash/export serve the seeded rows');

  // ── E) /reports/daily-stats vs the same oracle ───────────────────────────
  const daily = await api(baseUrl, '/api/reports/daily-stats', { headers: H });
  assertEqualOrThrow(daily.status, 200, 'GET /reports/daily-stats returns 200');
  assertEqualOrThrow(
    daily.data.sales,
    collectedSql.s,
    'daily-stats sales == SQL collected for the business day',
  );
  console.log('  ✓ E: /reports/daily-stats reconciles with the SQL oracle');

  server.close();
  closeDatabase();
  console.log('\nAll reports reconciliation tests passed.');
}

main().catch((error) => {
  console.error('Reports reconciliation test failed:', error);
  process.exit(1);
});
