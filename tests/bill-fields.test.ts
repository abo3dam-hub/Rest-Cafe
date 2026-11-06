/**
 * Stage B-S2 (owner decisions 2026-11-06): bill content fields.
 * - Licence + classification are independent text settings with their own
 *   show toggles; the tax id stays its own field (now shown by default).
 * - Waiter / cashier / guest count / open-close times ride the receipt
 *   business object with independent toggles (waiter on; cashier, guests,
 *   times off by default). A field with no recorded value carries nothing.
 * - Customer name/phone are hidden on the DINE-IN bill by default.
 * - Closing stamp: bill_requested_at is the printed close time; adding an
 *   item after the request (or un-requesting) clears it for a re-stamp.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/bill-fields.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-bill-fields-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
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
  seedTable,
  seedCustomer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');

function setSettingRaw(db: any, key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now());
}

async function run() {
  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedCategory(db, 'cat-bf', 'مشروبات');
  seedProduct(db, 'prod-bf', 'cat-bf', 'قهوة عربية', 1000);
  seedTable(db, 'tbl-bf', 8);
  seedCustomer(db, 'cust-bf', 'زبون تجريبي', '0999000111');
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('u-waiter', 'سامر', 'waiter@test.local', 'x', 'server', 1, now(), now());
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('u-cashier', 'أحمد خليل', 'cashier@test.local', 'x', 'cashier', 1, now(), now());

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);
  const { buildReceiptBusiness } = require('../main/services/print-queue');

  try {
    console.log('\n1. Licence + classification save and read back with toggle defaults');
    const put = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { business_licence: '12345', business_classification: 'نجمتان' },
    });
    assertEqualOrThrow(put.status, 200, 'PUT /business with licence/classification → 200');
    assertEqualOrThrow(put.data.business_licence, '12345', 'licence round-trips');
    assertEqualOrThrow(put.data.business_classification, 'نجمتان', 'classification round-trips');
    assertEqualOrThrow(put.data.bill_show_licence, true, 'licence shown by default');
    assertEqualOrThrow(put.data.bill_show_classification, true, 'classification shown by default');
    assertEqualOrThrow(put.data.bill_show_tax_id, true, 'tax id shown by default (flipped)');
    assertEqualOrThrow(put.data.bill_show_waiter, true, 'waiter shown by default');
    assertEqualOrThrow(put.data.bill_show_cashier, false, 'cashier hidden by default');
    assertEqualOrThrow(put.data.bill_show_guest_count, false, 'guest count hidden by default');
    assertEqualOrThrow(put.data.bill_show_open_close_times, false, 'open/close times hidden by default');

    const putToggles = await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { bill_show_guest_count: true, bill_show_licence: false },
    });
    assertEqualOrThrow(putToggles.data.bill_show_guest_count, true, 'guest-count toggle persists');
    assertEqualOrThrow(putToggles.data.bill_show_licence, false, 'licence toggle persists');
    await api(baseUrl, '/api/settings/business', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { bill_show_licence: true, bill_show_guest_count: false },
    });

    console.log('\n2. Dine-in order, bill request stamp, bill');
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        type: 'dine_in',
        table_id: 'tbl-bf',
        guest_count: 4,
        items: [{ product_id: 'prod-bf', quantity: 2 }],
      },
    });
    assertEqualOrThrow(created.status, 201, 'dine-in order created');
    const orderId = created.data.order.id;
    db.prepare('UPDATE orders SET user_id = ? WHERE id = ?').run('u-waiter', orderId);
    assertEqualOrThrow(
      db.prepare('SELECT guest_count FROM orders WHERE id = ?').get(orderId).guest_count,
      4,
      'guest count recorded on the order',
    );

    const reqBill = await api(baseUrl, `/api/orders/${orderId}/request-bill`, {
      method: 'POST',
      headers: owner.authHeader,
      body: {},
    });
    assertEqualOrThrow(reqBill.status, 200, 'request-bill → 200');
    const stamped = db
      .prepare('SELECT bill_requested_at FROM orders WHERE id = ?')
      .get(orderId).bill_requested_at;
    assertOrThrow(!!stamped, 'bill_requested_at stamped at bill request');
    assertEqualOrThrow(
      db.prepare('SELECT status FROM tables WHERE id = ?').get('tbl-bf').status,
      'bill_requested',
      'table moved to bill_requested',
    );

    const billRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: owner.authHeader,
      body: { order_id: orderId },
    });
    assertEqualOrThrow(billRes.status, 201, 'bill generated');
    const billId = billRes.data.bill.id;
    db.prepare('UPDATE bills SET customer_id = ? WHERE id = ?').run('cust-bf', billId);
    db.prepare(
      `INSERT INTO payment_idempotency (idempotency_key, bill_id, user_id, request_hash, response_json, created_at)
       VALUES ('bf-key-1', ?, 'u-cashier', 'h', '{}', ?)`,
    ).run(String(billId), now());

    console.log('\n3. Receipt business object: values + default toggles');
    const billRow = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
    const orderRow = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    const biz = buildReceiptBusiness(db, billRow, orderRow);
    assertEqualOrThrow(biz.licence, '12345', 'business carries the licence value');
    assertEqualOrThrow(biz.show_licence, true, 'business show_licence default true');
    assertEqualOrThrow(biz.classification, 'نجمتان', 'business carries the classification value');
    assertEqualOrThrow(biz.show_classification, true, 'business show_classification default true');
    assertEqualOrThrow(biz.show_tax_id, true, 'business show_tax_id default true');
    assertEqualOrThrow(biz.waiter_name, 'سامر', 'waiter name resolves from the order owner');
    assertEqualOrThrow(biz.show_waiter, true, 'business show_waiter default true');
    assertEqualOrThrow(biz.cashier_name, 'أحمد خليل', 'cashier resolves from the payment record');
    assertEqualOrThrow(biz.show_cashier, false, 'business show_cashier default false');
    assertEqualOrThrow(biz.guest_count, 4, 'business carries the guest count');
    assertEqualOrThrow(biz.show_guest_count, false, 'business show_guest_count default false');
    assertEqualOrThrow(biz.opened_at, orderRow.created_at, 'opened_at = order creation time');
    assertEqualOrThrow(biz.closed_at, stamped, 'closed_at = the bill-request stamp');
    assertEqualOrThrow(biz.show_open_close_times, false, 'business show_open_close_times default false');
    assertEqualOrThrow(
      biz.show_customer_name,
      false,
      'customer name hidden on the dine-in bill by default',
    );

    console.log('\n4. Toggle flips reach the business object');
    setSettingRaw(db, 'bill_show_cashier', 'true');
    setSettingRaw(db, 'bill_show_licence', 'false');
    const biz2 = buildReceiptBusiness(db, billRow, orderRow);
    assertEqualOrThrow(biz2.show_cashier, true, 'cashier toggle on → shown');
    assertEqualOrThrow(biz2.show_licence, false, 'licence toggle off → hidden');
    setSettingRaw(db, 'bill_show_cashier', 'false');
    setSettingRaw(db, 'bill_show_licence', 'true');

    console.log('\n5. Cashier falls back to the bill-request actor');
    db.prepare('DELETE FROM payment_idempotency WHERE bill_id = ?').run(String(billId));
    db.prepare(
      `INSERT INTO order_audit_log (order_id, actor_user_id, action, created_at)
       VALUES (?, 'u-cashier', 'bill_requested', ?)`,
    ).run(orderId, now());
    const biz3 = buildReceiptBusiness(db, billRow, orderRow);
    assertEqualOrThrow(biz3.cashier_name, 'أحمد خليل', 'cashier falls back to bill-request actor');

    console.log('\n6. Takeaway bill keeps the customer name by default');
    const takeaway = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-bf', quantity: 1 }] },
    });
    assertEqualOrThrow(takeaway.status, 201, 'takeaway order created');
    const tBillRes = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: owner.authHeader,
      body: { order_id: takeaway.data.order.id },
    });
    assertEqualOrThrow(tBillRes.status, 201, 'takeaway bill generated');
    const tBillId = tBillRes.data.bill.id;
    db.prepare('UPDATE bills SET customer_id = ? WHERE id = ?').run('cust-bf', tBillId);
    const tBiz = buildReceiptBusiness(
      db,
      db.prepare('SELECT * FROM bills WHERE id = ?').get(tBillId),
      db.prepare('SELECT * FROM orders WHERE id = ?').get(takeaway.data.order.id),
    );
    assertEqualOrThrow(tBiz.show_customer_name, true, 'customer name shown on takeaway by default');
    assertEqualOrThrow(tBiz.customer_name, 'زبون تجريبي', 'customer name value present');

    console.log('\n7. Safeguard 1: adding an item clears the closing stamp');
    const addItem = await api(baseUrl, `/api/orders/${orderId}/items`, {
      method: 'POST',
      headers: owner.authHeader,
      body: { items: [{ product_id: 'prod-bf', quantity: 1 }] },
    });
    assertEqualOrThrow(addItem.status, 200, 'item added after bill request');
    assertEqualOrThrow(
      db.prepare('SELECT bill_requested_at FROM orders WHERE id = ?').get(orderId)
        .bill_requested_at,
      null,
      'closing stamp cleared when an item is added after the request',
    );
    assertEqualOrThrow(
      db.prepare('SELECT status FROM tables WHERE id = ?').get('tbl-bf').status,
      'occupied',
      'table returns to occupied after the stamp clears',
    );

    console.log('\n8. Re-request re-stamps; un-request clears again');
    await api(baseUrl, `/api/orders/${orderId}/request-bill`, {
      method: 'POST',
      headers: owner.authHeader,
      body: {},
    });
    assertOrThrow(
      !!db.prepare('SELECT bill_requested_at FROM orders WHERE id = ?').get(orderId)
        .bill_requested_at,
      'closing stamp re-stamped at the next bill request',
    );
    const unreq = await api(baseUrl, `/api/orders/${orderId}/unrequest-bill`, {
      method: 'POST',
      headers: owner.authHeader,
      body: {},
    });
    assertEqualOrThrow(unreq.status, 200, 'unrequest-bill → 200');
    assertEqualOrThrow(
      db.prepare('SELECT bill_requested_at FROM orders WHERE id = ?').get(orderId)
        .bill_requested_at,
      null,
      'un-requesting the bill clears the closing stamp',
    );
    assertEqualOrThrow(
      db.prepare('SELECT status FROM tables WHERE id = ?').get('tbl-bf').status,
      'occupied',
      'table returns to occupied after un-request',
    );
  } finally {
    server.close();
    closeDatabase();
  }
  return getResults();
}

if (require.main === module) {
  run()
    .then((r) => {
      console.log(`\nBill fields: ${r.passed} passed, ${r.failed} failed`);
      process.exit(r.failed > 0 ? 1 : 0);
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

module.exports = { run };
