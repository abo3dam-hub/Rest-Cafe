/**
 * Regression tests: sold-out is enforced by the backend, and the no-printer
 * Arabic bill preview renders instead of returning an empty buffer.
 *
 * Before the fix, sold-out was enforced only by the POS screen: the orders
 * API accepted a sold-out product (HTTP 201, the item reached the kitchen),
 * and customer self-order sanitizing ignored the flag too. The preview half
 * covers the no-printer bill preview: the synthetic "Default 80mm Preview"
 * profile declares no Arabic shaping, so the fail-closed gate dropped every
 * Arabic line of an Arabic-first receipt and the preview came back empty.
 * The preview endpoint now defaults shaping on only when no printer is
 * configured (the preview is paperless); prepareReceipt's gate is untouched.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/sold-out-backend.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-sold-out-backend-'));
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
  seedCategory,
  seedProduct,
  api,
  assert,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');
const { sanitizeSelfOrderItems } = require('../main/services/self-order');

function setSetting(db: any, key: string, value: string) {
  db.prepare(
    'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
  ).run(key, value, now());
}

const ARABIC_RE = /[\u0600-\u06FF\uFB50-\uFDFF\uFE70-\uFEFF]/;

async function main() {
  console.log('Sold-Out Backend Enforcement + Arabic Preview Tests');
  console.log('='.repeat(56));

  const db = initTestDb();
  setSetting(db, 'country', '');
  setSetting(db, 'currency', 'SYP');
  setSetting(db, 'currency_symbol', 'SP');
  setSetting(db, 'business_type', 'restaurant');
  setSetting(db, 'language', 'ar');
  setSetting(db, 'business_name', 'مطعم الاختبار');

  const owner = seedOwnerUser(db);
  seedCategory(db, 'menu', 'Menu');
  seedProduct(db, 'p-avail', 'menu', 'Shawarma', 25000);
  seedProduct(db, 'p-gone', 'menu', 'Mansaf', 40000);
  seedProduct(db, 'p-edit', 'menu', 'Kebab', 10000);
  seedProduct(db, 'p-arabic', 'menu', 'شاورما دجاج', 25000);

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  const orderCount = () =>
    Number((db.prepare('SELECT COUNT(*) AS c FROM orders').get() as any).c);
  const setSoldOut = async (id: string, soldOut: boolean) =>
    api(baseUrl, `/api/products/${id}/sold-out`, {
      method: 'PATCH',
      headers: owner.authHeader,
      body: { sold_out: soldOut },
    });
  const createOrder = async (items: any[]) =>
    api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'takeaway', items },
    });

  try {
    console.log('\n1. Creating an order for a sold-out product is refused');
    const mark = await setSoldOut('p-gone', true);
    assertEqualOrThrow(mark.status, 200, 'mansaf marked sold out');

    const before = orderCount();
    const single = await createOrder([{ product_id: 'p-gone', quantity: 1 }]);
    assertEqualOrThrow(single.status, 400, 'sold-out order is refused with 400');
    assertOrThrow(
      String(single.data?.error || '').includes('sold out'),
      'refusal names the sold-out cause',
    );
    assertEqualOrThrow(orderCount(), before, 'no order was persisted for the refused sale');

    const mixed = await createOrder([
      { product_id: 'p-avail', quantity: 1 },
      { product_id: 'p-gone', quantity: 1 },
    ]);
    assertEqualOrThrow(mixed.status, 400, 'a mixed cart containing a sold-out item is refused');
    assertEqualOrThrow(orderCount(), before, 'the mixed refusal rolls the whole order back');

    console.log('\n2. Adding a sold-out item to an open order is refused');
    const open = await createOrder([{ product_id: 'p-avail', quantity: 1 }]);
    assertEqualOrThrow(open.status, 201, 'available order is created');
    const openOrder = open.data.order;
    const addGone = await api(baseUrl, `/api/orders/${openOrder.id}/items`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { items: [{ product_id: 'p-gone', quantity: 1 }] },
    });
    assertEqualOrThrow(addGone.status, 400, 'add-items refuses the sold-out product');
    const afterAdd = await api(baseUrl, `/api/orders/${openOrder.id}`, {
      headers: owner.authHeader,
    });
    assertEqualOrThrow(
      Number(afterAdd.data.order.total),
      25000,
      'the refused add-items left the order total unchanged',
    );

    console.log('\n3. Quantity edits: increases are sales, reductions are not');
    const editOrderRes = await createOrder([{ product_id: 'p-edit', quantity: 2 }]);
    assertEqualOrThrow(editOrderRes.status, 201, 'edit-target order is created');
    const editOrder = editOrderRes.data.order;
    const editItem = editOrder.items[0];
    await setSoldOut('p-edit', true);

    const fetched = await api(baseUrl, `/api/orders/${editOrder.id}`, {
      headers: owner.authHeader,
    });
    const fetchedItem = (fetched.data.order.items || []).find(
      (i: any) => String(i.id) === String(editItem.id),
    );
    const editVersion = Number(fetchedItem?.edit_version ?? 0);
    let keySeq = 0;
    const edit = (quantity: number, version: number) =>
      api(baseUrl, `/api/orders/${editOrder.id}/items/${editItem.id}/edit`, {
        method: 'PATCH',
        headers: { ...owner.authHeader, 'Idempotency-Key': `sold-out-edit-${++keySeq}` },
        body: { quantity, expected_edit_version: version },
      });

    const increase = await edit(3, editVersion);
    assertEqualOrThrow(
      increase.status,
      400,
      'increasing the quantity of a now-sold-out product is refused',
    );

    const reduction = await edit(1, editVersion);
    assertEqualOrThrow(
      reduction.status,
      200,
      'reducing the quantity of an already-sold line still works after sell-out',
    );
    const afterEdit = await api(baseUrl, `/api/orders/${editOrder.id}`, {
      headers: owner.authHeader,
    });
    assertEqualOrThrow(
      Number(afterEdit.data.order.total),
      10000,
      'the reduction repriced the order to one unit',
    );

    console.log('\n4. Customer self-order sanitizing refuses sold-out items');
    const sanitizedGone = sanitizeSelfOrderItems(db, [{ product_id: 'p-gone', quantity: 1 }]);
    assertOrThrow(
      'error' in sanitizedGone,
      'self-order cart with a sold-out product is rejected at sanitize time',
    );
    const sanitizedOk = sanitizeSelfOrderItems(db, [{ product_id: 'p-avail', quantity: 1 }]);
    assertOrThrow(
      'items' in sanitizedOk && sanitizedOk.items.length === 1,
      'self-order cart with an available product still passes',
    );

    console.log('\n5. Restoring a sold-out product makes it sellable again');
    const restore = await setSoldOut('p-gone', false);
    assertEqualOrThrow(restore.status, 200, 'mansaf restored');
    const again = await createOrder([{ product_id: 'p-gone', quantity: 1 }]);
    assertEqualOrThrow(again.status, 201, 'restored product can be ordered again');

    console.log('\n6. Arabic bill preview with NO printer configured renders');
    const printerCount = Number(
      (db.prepare('SELECT COUNT(*) AS c FROM printers').get() as any).c,
    );
    assertEqualOrThrow(printerCount, 0, 'this section runs with no printer configured');
    const arOrder = await createOrder([{ product_id: 'p-arabic', quantity: 2 }]);
    assertEqualOrThrow(arOrder.status, 201, 'Arabic order is created');
    const gen = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: owner.authHeader,
      body: { order_id: arOrder.data.order.id },
    });
    assertOrThrow([200, 201].includes(gen.status), 'bill generated for the Arabic order');
    const bill = gen.data.bill;

    const preview = await api(baseUrl, '/api/printers/print-bill', {
      method: 'POST',
      headers: owner.authHeader,
      body: { billId: bill.id, preview: true },
    });
    assertEqualOrThrow(preview.status, 200, 'preview responds 200');
    const text = String(preview.data?.text || '');
    assertOrThrow(text.length > 0, 'preview text is not empty');
    assertOrThrow(ARABIC_RE.test(text), 'preview text contains Arabic script');
    assertOrThrow(text.includes('50,000'), 'preview text carries the 50,000 total');

    const explicitOff = await api(baseUrl, '/api/printers/print-bill', {
      method: 'POST',
      headers: owner.authHeader,
      body: { billId: bill.id, preview: true, arabicShaping: false },
    });
    assertEqualOrThrow(
      String(explicitOff.data?.text || '').length,
      0,
      'an explicit arabicShaping:false choice is still respected (gate unchanged)',
    );

    console.log('\n7. A configured non-shaping printer keeps the fail-closed gate');
    db.prepare(
      `INSERT INTO printers (id, name, connection_type, is_default, paper_width, created_at, updated_at)
       VALUES (?, ?, ?, 1, '80mm', ?, ?)`,
    ).run(9901, 'Generic ESC/POS 80mm', 'network', now(), now());
    const gated = await api(baseUrl, '/api/printers/print-bill', {
      method: 'POST',
      headers: owner.authHeader,
      body: { billId: bill.id, preview: true },
    });
    assertEqualOrThrow(gated.status, 200, 'preview with a real printer responds 200');
    assertEqualOrThrow(
      String(gated.data?.text || '').length,
      0,
      'Arabic financial lines are still refused for a real printer without shaping',
    );
  } finally {
    server.close();
    closeDatabase();
  }

  const results = getResults();
  console.log(`\nSold-out backend: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Sold-out backend test crashed:', error);
  process.exit(1);
});
