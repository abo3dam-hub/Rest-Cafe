/**
 * Cancel closes the bill — assignment 033, finding F-R1-1.
 *
 * Cancelling an order after its bill was generated used to leave the bill
 * row behind as a live unpaid bill (payment_status 'unpaid', total intact,
 * retrievable forever). The cancel now closes the order's unpaid,
 * never-paid bills in the same transaction: the row reads 'cancelled'
 * through the existing bill read paths, its total and items stay as the
 * audit trail, and it refuses any further payment. Bills with any payment
 * recorded are out of this fix's reach and keep their existing behaviour
 * (cancelling a partially-paid order with an owner PIN is still allowed
 * today and leaves the bill live — flagged in the status report, not
 * changed here).
 *
 * Production shape: country '' (no country profiles), currency SYP.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/cancel-closes-bill.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-cancel-closes-bill-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => '2.9.5' } };
  }
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
  api,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');

function setSetting(db: any, key: string, value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    value,
    now(),
  );
}

// The seeded manager's approval PIN (seedManagerUser sets '1234'); the
// seeded owner has no PIN, so the manager approves the override cancels.
const APPROVER_PIN = '1234';

async function main() {
  console.log('Cancel Closes Bill Tests');
  console.log('='.repeat(56));

  const db = initTestDb();
  setSetting(db, 'country', '');
  setSetting(db, 'currency', 'SYP');
  setSetting(db, 'business_type', 'restaurant');

  const owner = seedOwnerUser(db);
  seedManagerUser(db);
  seedCategory(db, 'close-menu', 'Close Menu');
  seedProduct(db, 'close-p1', 'close-menu', 'Shawarma', 10000, { tax_category_id: null });

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  async function createOrder() {
    const res = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'close-p1', quantity: 1 }] },
    });
    assertEqualOrThrow(res.status, 201, 'order is created');
    return res.data.order;
  }

  async function generateBill(orderId: number) {
    db.prepare("UPDATE order_items SET status = 'served' WHERE order_id = ?").run(orderId);
    const res = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: owner.authHeader,
      body: { order_id: orderId },
    });
    assertEqualOrThrow(res.status, 201, 'bill is generated');
    return res.data.bill;
  }

  async function cancelOrder(orderId: number, reason: string) {
    const res = await api(baseUrl, `/api/orders/${orderId}/status`, {
      method: 'PATCH',
      headers: owner.authHeader,
      body: { status: 'cancelled', reason, override_pin: APPROVER_PIN },
    });
    assertEqualOrThrow(res.status, 200, 'order cancels with the owner PIN');
    assertEqualOrThrow(res.data.order?.status, 'cancelled', 'order status is cancelled');
  }

  async function readBill(orderId: number) {
    const res = await api(baseUrl, `/api/bills/order/${orderId}`, { headers: owner.authHeader });
    return res;
  }

  try {
    console.log('\n1. Cancel-after-bill closes the unpaid bill in the same transaction');
    const order = await createOrder();
    const bill = await generateBill(order.id);
    assertEqualOrThrow(bill.payment_status, 'unpaid', 'bill starts unpaid');
    assertEqualOrThrow(bill.total, 10000, 'bill total is 10,000');
    await cancelOrder(order.id, 'Guest left');
    const after = await readBill(order.id);
    assertEqualOrThrow(after.status, 200, 'the bill is still retrievable after the cancel');
    assertEqualOrThrow(
      after.data?.bill?.payment_status,
      'cancelled',
      'the bill reads cancelled through the bill read path',
    );
    assertEqualOrThrow(after.data?.bill?.total, 10000, 'the closed bill keeps its total');
    assertEqualOrThrow(after.data?.bill?.paid_amount, 0, 'the closed bill has no payment');
    const billRow = db.prepare('SELECT * FROM bills WHERE id = ?').get(bill.id) as any;
    assertOrThrow(!!billRow, 'the bill row is not deleted (audit trail stays)');
    const itemCount = (
      db.prepare('SELECT COUNT(*) c FROM order_items WHERE order_id = ?').get(order.id) as any
    ).c;
    assertEqualOrThrow(itemCount, 1, 'the closed bill\u2019s order keeps its items');

    console.log('\n2. A cancelled bill refuses payment');
    const refused = await api(baseUrl, `/api/bills/${bill.id}/payment`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { method: 'cash', amount: 10000 },
    });
    assertEqualOrThrow(refused.status, 409, 'paying the cancelled bill is refused');
    assertOrThrow(
      String(refused.data?.error || '')
        .toLowerCase()
        .includes('cancelled'),
      'the refusal names the cancelled bill',
    );
    assertEqualOrThrow(
      refused.data?.display_code,
      'bill_cancelled',
      'the refusal carries the bill_cancelled code',
    );
    const stillClosed = await readBill(order.id);
    assertEqualOrThrow(
      stillClosed.data?.bill?.payment_status,
      'cancelled',
      'the bill stays cancelled after the refused payment',
    );
    assertEqualOrThrow(
      stillClosed.data?.bill?.paid_amount,
      0,
      'no payment lands on the cancelled bill',
    );

    console.log('\n3. A partially-paid bill is out of reach (flagged, unchanged behaviour)');
    const order2 = await createOrder();
    const bill2 = await generateBill(order2.id);
    const partial = await api(baseUrl, `/api/bills/${bill2.id}/payment`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { method: 'cash', amount: 4000 },
    });
    assertEqualOrThrow(partial.status, 200, 'partial payment is accepted');
    assertEqualOrThrow(partial.data?.bill?.payment_status, 'partial', 'the bill is partially paid');
    await cancelOrder(order2.id, 'Guest left after a partial payment');
    const afterPartial = await readBill(order2.id);
    assertEqualOrThrow(
      afterPartial.data?.bill?.payment_status,
      'partial',
      'the partially-paid bill keeps its status (out of this fix\u2019s reach)',
    );
    assertEqualOrThrow(
      afterPartial.data?.bill?.paid_amount,
      4000,
      'the recorded payment is untouched by the cancel',
    );

    console.log('\n4. Cancelling an order with no bill creates no bill rows');
    const order3 = await createOrder();
    await cancelOrder(order3.id, 'Changed mind before billing');
    const noBill = await readBill(order3.id);
    assertEqualOrThrow(noBill.status, 404, 'no bill exists for the never-billed order');
    const billCount = (
      db.prepare('SELECT COUNT(*) c FROM bills WHERE order_id = ?').get(order3.id) as any
    ).c;
    assertEqualOrThrow(billCount, 0, 'the cancel invents no bill row');
  } finally {
    server.close();
    closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  const results = getResults();
  console.log(`\nCancel closes bill: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Cancel closes bill test crashed:', error);
  process.exit(1);
});
