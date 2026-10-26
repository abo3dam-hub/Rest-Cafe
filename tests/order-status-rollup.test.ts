/**
 * Integration Test: Order status rollup + split-checks default (v119)
 *
 * A) orders.status follows kitchen progress: the item-status endpoints
 *    (PATCH /api/order-items/:id/status here; the KDS route calls the same
 *    helper) write only order_items.status, and
 *    main/services/order-status-rollup.ts derives the order status from its
 *    live items — pending → preparing → ready → served — advancing only.
 * B) A completed order is final: kitchen writes after full payment never
 *    roll its status back (whether the endpoint rejects the now-terminal
 *    item or accepts it, the rollup guard holds).
 * C) Split checks are default-on: a fresh database seeds
 *    split_checks_enabled='true', the settings fallback agrees, and
 *    migration v119 flips a stored 'false' to 'true' idempotently.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-status-rollup.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-status-rollup-'));
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
const { orderItemRoutes } = require('../main/routes/order-items');
const { billRoutes } = require('../main/routes/bills');
const { settingsRoutes } = require('../main/routes/settings');
const { MIGRATIONS } = require('../main/db');

async function main() {
  console.log('Integration Test: Order Status Rollup + Split Default');
  console.log('='.repeat(50));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const H = owner.authHeader;
  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/order-items': orderItemRoutes,
    '/api/bills': billRoutes,
    '/api/settings': settingsRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  seedCategory(db, 'cat-1', 'Mains');
  seedProduct(db, 'prod-1', 'cat-1', 'Shawarma', 10000);
  seedProduct(db, 'prod-2', 'cat-1', 'Fattoush', 25000);
  seedTable(db, 'tbl-a', 5);

  const orderRow = (id: number) => db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as any;
  const setItemStatus = async (itemId: number, status: string) =>
    api(baseUrl, `/api/order-items/${itemId}/status`, {
      method: 'PATCH',
      headers: H,
      body: { status },
    });

  try {
    // ── A) Derivation ladder ──────────────────────────────────────────────
    console.log('\n─── A) Order status derives from item progress ───');
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: H,
      body: {
        type: 'dine_in',
        table_id: 'tbl-a',
        items: [
          { product_id: 'prod-1', quantity: 1 },
          { product_id: 'prod-2', quantity: 1 },
        ],
      },
    });
    assertEqualOrThrow(created.status, 201, 'A: dine-in order created');
    const order = created.data.order;
    const items = db
      .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
      .all(order.id) as any[];
    assertEqualOrThrow(items.length, 2, 'A: order holds two items');
    const [item1, item2] = items;
    assertEqualOrThrow(orderRow(order.id).status, 'pending', 'A: order starts pending');

    let res = await setItemStatus(item1.id, 'preparing');
    assertEqualOrThrow(res.status, 200, 'A: item1 → preparing accepted');
    assertEqualOrThrow(orderRow(order.id).status, 'preparing', 'A: order follows to preparing');

    res = await setItemStatus(item1.id, 'ready');
    assertEqualOrThrow(res.status, 200, 'A: item1 → ready accepted');
    assertEqualOrThrow(
      orderRow(order.id).status,
      'preparing',
      'A: one ready + one pending keeps order at preparing',
    );

    res = await setItemStatus(item2.id, 'preparing');
    assertEqualOrThrow(res.status, 200, 'A: item2 → preparing accepted');
    assertEqualOrThrow(orderRow(order.id).status, 'preparing', 'A: order stays preparing');

    res = await setItemStatus(item2.id, 'ready');
    assertEqualOrThrow(res.status, 200, 'A: item2 → ready accepted');
    assertEqualOrThrow(orderRow(order.id).status, 'ready', 'A: all ready lifts order to ready');

    res = await setItemStatus(item1.id, 'served');
    assertEqualOrThrow(res.status, 200, 'A: item1 → served accepted');
    assertEqualOrThrow(
      orderRow(order.id).status,
      'ready',
      'A: one served + one ready keeps order at ready',
    );

    res = await setItemStatus(item2.id, 'served');
    assertEqualOrThrow(res.status, 200, 'A: item2 → served accepted');
    assertEqualOrThrow(orderRow(order.id).status, 'served', 'A: all served lifts order to served');

    // The item endpoint permits moving an item backwards; the order must not follow.
    res = await setItemStatus(item1.id, 'preparing');
    assertEqualOrThrow(res.status, 200, 'A: item1 moved back to preparing at item level');
    assertEqualOrThrow(
      orderRow(order.id).status,
      'served',
      'A: order status never moves backwards',
    );
    res = await setItemStatus(item1.id, 'served');
    assertEqualOrThrow(res.status, 200, 'A: item1 restored to served');

    // ── B) Completed orders are final ─────────────────────────────────────
    console.log('\n─── B) Completed order guard ───');
    const gen = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: H,
      body: { order_id: order.id },
    });
    assertOrThrow([200, 201].includes(gen.status), 'B: bill generated');
    const pay = await api(baseUrl, `/api/bills/${gen.data.bill.id}/payment`, {
      method: 'POST',
      headers: H,
      body: { method: 'cash', amount: 35000 },
    });
    assertEqualOrThrow(pay.status, 200, 'B: full payment accepted');
    assertEqualOrThrow(orderRow(order.id).status, 'completed', 'B: payment completes the order');

    // Settlement may have marked the items terminal (endpoint then rejects
    // the write) or left them served (write succeeds) — either way the
    // completed order must not move.
    await setItemStatus(item1.id, 'preparing');
    assertEqualOrThrow(
      orderRow(order.id).status,
      'completed',
      'B: completed order is never rolled back by kitchen writes',
    );

    // ── C) Split checks default-on + migration v119 ───────────────────────
    console.log('\n─── C) Split checks default (seed, fallback, v119) ───');
    const tail = MIGRATIONS[MIGRATIONS.length - 1];
    assertEqualOrThrow(tail.version, 120, 'C: registry tail is migration v120');
    assertEqualOrThrow(tail.name, 'customers_country_code_default_syria', 'C: v120 name registered');
    const v119 = MIGRATIONS.find((m: any) => m.version === 119);
    assertOrThrow(!!v119, 'C: migration v119 exists');

    const settingRow = () =>
      (
        db.prepare("SELECT value FROM settings WHERE key = 'split_checks_enabled'").get() as any
      )?.value;
    assertEqualOrThrow(settingRow(), 'true', 'C: fresh database seeds split checks enabled');

    const read = await api(baseUrl, '/api/settings/split_checks_enabled', { headers: H });
    assertEqualOrThrow(read.status, 200, 'C: settings read returns 200');
    assertEqualOrThrow(read.data.setting.value, 'true', 'C: settings API reports enabled');

    db.prepare("UPDATE settings SET value = 'false' WHERE key = 'split_checks_enabled'").run();
    assertEqualOrThrow(settingRow(), 'false', 'C: stored value forced back to false');
    v119.up();
    assertEqualOrThrow(settingRow(), 'true', 'C: v119 flips stored false to true');
    v119.up();
    assertEqualOrThrow(settingRow(), 'true', 'C: v119 is idempotent on re-run');

    db.prepare("DELETE FROM settings WHERE key = 'split_checks_enabled'").run();
    const fallback = await api(baseUrl, '/api/settings/split_checks_enabled', { headers: H });
    assertEqualOrThrow(fallback.status, 200, 'C: missing setting still reads');
    assertEqualOrThrow(
      fallback.data.setting.value,
      'true',
      'C: fallback default keeps split checks enabled',
    );

    console.log('\nAll order-status rollup assertions passed.');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
