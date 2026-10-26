/**
 * Integration Test: Cashier Table Workspace — backend (bill request + merge)
 *
 * Owner design (2026-10-26):
 *  A) POST /orders/:id/request-bill stamps orders.bill_requested_at (first
 *     stamp wins) and flips the table to 'bill_requested'; unrequest-bill
 *     returns the table to 'occupied' without erasing the stamp. Migration
 *     v118 provides the column.
 *  B) Request-bill rejects closed orders and non-dine-in orders.
 *  C) POST /orders/:id/merge moves live items into the target order with
 *     totals recomputed by the same path add-items uses; terminal items stay
 *     behind; kitchen item states are untouched; the source closes as
 *     cancelled with a merge reason, its table is freed, its unprinted
 *     unpaid bill is removed, the target's unpaid bill is re-synced, and
 *     both orders gain audit entries.
 *  D) Merge guards: same order, inactive order, recorded payment on either
 *     bill, printed source bill, order-level discount, split checks.
 *  E) tables PATCH status accepts 'bill_requested'.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/cashier-workspace-backend.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cashier-workspace-'));
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
  seedTable,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');

const { orderRoutes } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { tableRoutes } = require('../main/routes/tables');

async function main() {
  console.log('Integration Test: Cashier Workspace Backend');
  console.log('='.repeat(50));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const H = owner.authHeader;
  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/tables': tableRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  seedCategory(db, 'cat-1', 'Mains');
  seedProduct(db, 'prod-1', 'cat-1', 'Shawarma', 10000);
  seedProduct(db, 'prod-2', 'cat-1', 'Fattoush', 25000);
  for (const [id, num] of [
    ['tbl-a', 5],
    ['tbl-b', 6],
    ['tbl-c', 7],
    ['tbl-d', 8],
    ['tbl-e', 9],
    ['tbl-f', 10],
    ['tbl-g', 11],
  ] as const) {
    seedTable(db, id, num);
  }

  const createDineIn = async (tableId: string, items: any[]) => {
    const res = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: H,
      body: { type: 'dine_in', table_id: tableId, items },
    });
    assertEqualOrThrow(res.status, 201, `dine-in order created for ${tableId}`);
    return res.data.order;
  };
  const tableStatus = (id: string) =>
    (db.prepare('SELECT status FROM tables WHERE id = ?').get(id) as any).status;
  const orderRow = (id: number) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;

  try {
    // ── A) Bill request lifecycle ─────────────────────────────────────────
    console.log('\n─── A) Bill request lifecycle ───');
    const cols = db.prepare('PRAGMA table_info(orders)').all().map((c: any) => c.name);
    assertOrThrow(cols.includes('bill_requested_at'), 'A: migration v118 added bill_requested_at');

    const aOrder = await createDineIn('tbl-a', [{ product_id: 'prod-1', quantity: 2 }]);
    assertEqualOrThrow(tableStatus('tbl-a'), 'occupied', 'A: order creation occupies the table');
    const rb = await api(baseUrl, `/api/orders/${aOrder.id}/request-bill`, {
      method: 'POST',
      headers: H,
      body: {},
    });
    assertEqualOrThrow(rb.status, 200, 'A: request-bill returns 200');
    const firstStamp = orderRow(aOrder.id).bill_requested_at;
    assertOrThrow(!!firstStamp, 'A: bill_requested_at is stamped');
    assertEqualOrThrow(tableStatus('tbl-a'), 'bill_requested', 'A: table flips to bill_requested');

    const rb2 = await api(baseUrl, `/api/orders/${aOrder.id}/request-bill`, {
      method: 'POST',
      headers: H,
      body: {},
    });
    assertEqualOrThrow(rb2.status, 200, 'A: second request-bill still 200');
    assertEqualOrThrow(
      orderRow(aOrder.id).bill_requested_at,
      firstStamp,
      'A: first stamp wins on re-request',
    );

    const un = await api(baseUrl, `/api/orders/${aOrder.id}/unrequest-bill`, {
      method: 'POST',
      headers: H,
      body: {},
    });
    assertEqualOrThrow(un.status, 200, 'A: unrequest-bill returns 200');
    assertEqualOrThrow(tableStatus('tbl-a'), 'occupied', 'A: table returns to occupied');
    assertEqualOrThrow(
      orderRow(aOrder.id).bill_requested_at,
      firstStamp,
      'A: stamp is kept as history after unrequest',
    );

    // ── B) Bill request rejections ────────────────────────────────────────
    console.log('\n─── B) Bill request rejections ───');
    const takeaway = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: H,
      body: { type: 'takeaway', items: [{ product_id: 'prod-1', quantity: 1 }] },
    });
    assertEqualOrThrow(takeaway.status, 201, 'B: takeaway order created');
    const rbTake = await api(baseUrl, `/api/orders/${takeaway.data.order.id}/request-bill`, {
      method: 'POST',
      headers: H,
      body: {},
    });
    assertEqualOrThrow(rbTake.status, 400, 'B: takeaway order cannot request a bill');

    const cOrder = await createDineIn('tbl-c', [{ product_id: 'prod-1', quantity: 1 }]);
    const cancel = await api(baseUrl, `/api/orders/${cOrder.id}/status`, {
      method: 'PATCH',
      headers: H,
      body: { status: 'cancelled', cancellation_reason: 'customer left' },
    });
    assertEqualOrThrow(cancel.status, 200, 'B: order cancelled');
    const rbClosed = await api(baseUrl, `/api/orders/${cOrder.id}/request-bill`, {
      method: 'POST',
      headers: H,
      body: {},
    });
    assertEqualOrThrow(rbClosed.status, 400, 'B: closed order cannot request a bill');

    // ── C) Merge happy path ───────────────────────────────────────────────
    console.log('\n─── C) Merge happy path ───');
    const src = await createDineIn('tbl-a', [
      { product_id: 'prod-1', quantity: 2 },
      { product_id: 'prod-2', quantity: 1 },
    ]);
    // Cancel the second line through the real path so source totals settle.
    const srcItems = db
      .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
      .all(src.id) as any[];
    const cancelItem = await api(
      baseUrl,
      `/api/orders/${src.id}/items/${srcItems[1].id}/cancel`,
      { method: 'PATCH', headers: H, body: {} },
    );
    assertEqualOrThrow(cancelItem.status, 200, 'C: source line cancelled');
    assertEqualOrThrow(orderRow(src.id).total, 20000, 'C: source total after cancel is 20000');
    // A live line is mid-preparation in the kitchen — merge must not touch it.
    db.prepare("UPDATE order_items SET status = 'preparing' WHERE id = ?").run(srcItems[0].id);

    const tgt = await createDineIn('tbl-b', [{ product_id: 'prod-2', quantity: 2 }]);
    assertEqualOrThrow(orderRow(tgt.id).total, 50000, 'C: target total before merge is 50000');
    // Target already has an (unpaid, unprinted) bill — it must be re-synced.
    const genB = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: H,
      body: { order_id: tgt.id },
    });
    assertOrThrow([200, 201].includes(genB.status), 'C: target bill generated');
    const tgtBillId = genB.data.bill.id;

    const merge = await api(baseUrl, `/api/orders/${src.id}/merge`, {
      method: 'POST',
      headers: H,
      body: { target_order_id: tgt.id },
    });
    assertEqualOrThrow(merge.status, 200, 'C: merge returns 200');
    assertEqualOrThrow(merge.data.moved_item_ids.length, 1, 'C: exactly the live line moved');
    const mergedTarget = orderRow(tgt.id);
    assertEqualOrThrow(mergedTarget.total, 70000, 'C: target total is the sum (70000)');
    const tgtItems = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(tgt.id);
    assertEqualOrThrow(tgtItems.length, 2, 'C: target holds its line plus the moved line');
    const movedRow = db.prepare('SELECT * FROM order_items WHERE id = ?').get(srcItems[0].id) as any;
    assertEqualOrThrow(movedRow.order_id, tgt.id, 'C: moved line now belongs to target');
    assertEqualOrThrow(movedRow.status, 'preparing', 'C: kitchen state of moved line untouched');
    const leftBehind = db.prepare('SELECT * FROM order_items WHERE id = ?').get(srcItems[1].id) as any;
    assertEqualOrThrow(leftBehind.order_id, src.id, 'C: cancelled line stays with the source');
    const mergedSource = orderRow(src.id);
    assertEqualOrThrow(mergedSource.status, 'cancelled', 'C: source closes as cancelled');
    assertOrThrow(
      String(mergedSource.cancellation_reason || '').includes('دمج'),
      'C: source carries the merge reason',
    );
    assertEqualOrThrow(mergedSource.total, 0, 'C: source total zeroed');
    assertEqualOrThrow(tableStatus('tbl-a'), 'available', 'C: source table freed');
    const syncedBill = db.prepare('SELECT * FROM bills WHERE id = ?').get(tgtBillId) as any;
    assertEqualOrThrow(syncedBill.total, 70000, 'C: target bill re-synced to 70000');
    const srcAudit = db
      .prepare("SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'order_merged'")
      .get(src.id);
    const tgtAudit = db
      .prepare("SELECT * FROM order_audit_log WHERE order_id = ? AND action = 'items_merged_in'")
      .get(tgt.id);
    assertOrThrow(!!srcAudit && !!tgtAudit, 'C: audit entries written on both orders');

    // ── D) Merge guards ───────────────────────────────────────────────────
    console.log('\n─── D) Merge guards ───');
    const dSrc = await createDineIn('tbl-d', [{ product_id: 'prod-1', quantity: 1 }]);
    const same = await api(baseUrl, `/api/orders/${dSrc.id}/merge`, {
      method: 'POST',
      headers: H,
      body: { target_order_id: dSrc.id },
    });
    assertEqualOrThrow(same.status, 400, 'D: merging into itself is rejected');
    assertEqualOrThrow(same.data.code, 'merge_same_order', 'D: same-order code returned');

    const intoClosed = await api(baseUrl, `/api/orders/${dSrc.id}/merge`, {
      method: 'POST',
      headers: H,
      body: { target_order_id: cOrder.id },
    });
    assertEqualOrThrow(intoClosed.status, 409, 'D: merging into a closed order is rejected');
    assertEqualOrThrow(intoClosed.data.code, 'merge_order_not_active', 'D: not-active code returned');

    // Recorded payment on the source bill blocks the merge.
    const genD = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: H,
      body: { order_id: dSrc.id },
    });
    assertOrThrow([200, 201].includes(genD.status), 'D: source bill generated');
    db.prepare('UPDATE bills SET paid_amount = 5000 WHERE id = ?').run(genD.data.bill.id);
    const paidMerge = await api(baseUrl, `/api/orders/${dSrc.id}/merge`, {
      method: 'POST',
      headers: H,
      body: { target_order_id: tgt.id },
    });
    assertEqualOrThrow(paidMerge.status, 409, 'D: paid bill blocks merge');
    assertEqualOrThrow(paidMerge.data.code, 'merge_bill_paid', 'D: bill-paid code returned');
    db.prepare('UPDATE bills SET paid_amount = 0 WHERE id = ?').run(genD.data.bill.id);

    // A printed bill on the SOURCE blocks (paper document must not orphan).
    const eSrc = await createDineIn('tbl-e', [{ product_id: 'prod-1', quantity: 1 }]);
    const genE = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: H,
      body: { order_id: eSrc.id },
    });
    assertOrThrow([200, 201].includes(genE.status), 'D: printed-source bill generated');
    db.prepare('UPDATE bills SET printed_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      genE.data.bill.id,
    );
    const printedMerge = await api(baseUrl, `/api/orders/${eSrc.id}/merge`, {
      method: 'POST',
      headers: H,
      body: { target_order_id: tgt.id },
    });
    assertEqualOrThrow(printedMerge.status, 409, 'D: printed source bill blocks merge');
    assertEqualOrThrow(
      printedMerge.data.code,
      'merge_source_bill_printed',
      'D: printed-source code returned',
    );

    // Unprinted + unpaid source bill: merge proceeds and the bill is removed.
    const fSrc = await createDineIn('tbl-f', [{ product_id: 'prod-1', quantity: 1 }]);
    const genF = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: H,
      body: { order_id: fSrc.id },
    });
    assertOrThrow([200, 201].includes(genF.status), 'D: removable source bill generated');
    const fMerge = await api(baseUrl, `/api/orders/${fSrc.id}/merge`, {
      method: 'POST',
      headers: H,
      body: { target_order_id: tgt.id },
    });
    assertEqualOrThrow(fMerge.status, 200, 'D: merge with unprinted source bill succeeds');
    const fBills = db.prepare('SELECT * FROM bills WHERE order_id = ?').all(fSrc.id);
    assertEqualOrThrow(fBills.length, 0, 'D: source unprinted bill removed after merge');
    assertEqualOrThrow(orderRow(tgt.id).total, 80000, 'D: target total grows to 80000');

    // ── E) Table status accepts bill_requested ────────────────────────────
    console.log('\n─── E) Table status vocabulary ───');
    const patch = await api(baseUrl, '/api/tables/tbl-g/status', {
      method: 'PATCH',
      headers: H,
      body: { status: 'bill_requested' },
    });
    assertEqualOrThrow(patch.status, 200, 'E: PATCH status accepts bill_requested');

    console.log('\nAll cashier workspace backend assertions passed.');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
