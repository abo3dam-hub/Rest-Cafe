/**
 * Integration Test: Phase 3 backend features
 *
 * A) Migrations v121/v122 are the registry tail and add their columns:
 *    products.is_sold_out / sold_out_at / is_pinned, tables.reservation_at.
 * B) Sold-out is a floor action: a pos.use-only user (server role) may set
 *    and clear it; a kitchen-only user (chef role) may not. Pinning needs
 *    catalog management. sold_out_at stamps on set and clears on unset.
 * C) Bulk prices validate everything before writing: one missing id or a
 *    bad price rejects the whole batch with nothing changed.
 * D) reservation_at round-trips through the tables API (status PATCH sets
 *    it with the reservation, the full PUT updates and clears it).
 * E) Dish profitability: revenue/cost/margin/class per dish match an
 *    independent SQL oracle over the same window; the CSV export carries
 *    the seeded dish.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/phase3-features.test.ts
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-phase3-features-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const {
  initTestDb,
  createApp,
  startServer,
  seedOwnerUser,
  seedCategory,
  seedProduct,
  seedCustomer,
  seedTable,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');

const { productRoutes } = require('../main/routes/products');
const { tableRoutes } = require('../main/routes/tables');
const { reportRoutes } = require('../main/routes/reports');
const { getJWTSecret } = require('../main/routes/auth');
const { MIGRATIONS, now } = require('../main/db');

function seedRoleUser(db: any, id: string, role: string) {
  const passwordHash = bcrypt.hashSync('testpass123', 10);
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, `Test ${role}`, `${id}@test.local`, passwordHash, role, 1, now(), now());
  const token = jwt.sign({ userId: id, email: `${id}@test.local`, role }, getJWTSecret(), {
    expiresIn: '1h',
  });
  return { userId: id, authHeader: { Authorization: `Bearer ${token}` } };
}

function assertCloseOrThrow(actual: number, expected: number, label: string) {
  assertOrThrow(
    Math.abs(Number(actual) - expected) < 0.01,
    `${label} — expected ~${expected}, got ${actual}`,
  );
}

function dbNow(): string {
  return new Date().toISOString().replace('T', ' ').replace(/\..*$/, '');
}

async function main() {
  console.log('Integration Test: Phase 3 Features');
  console.log('='.repeat(50));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  const H = owner.authHeader;
  const serverUser = seedRoleUser(db, 'server-test-001', 'server');
  const chefUser = seedRoleUser(db, 'chef-test-001', 'chef');
  const app = createApp({
    '/api/products': productRoutes,
    '/api/tables': tableRoutes,
    '/api/reports': reportRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  seedCategory(db, 'cat-1', 'Mains');
  seedProduct(db, 'prod-1', 'cat-1', 'Shawarma', 10000);
  seedProduct(db, 'prod-2', 'cat-1', 'Coffee', 25000);
  seedTable(db, 'tbl-a', 5);
  seedCustomer(db, 'cust-1', 'Ahmad', '+963900000000');

  const productRow = (id: string) =>
    db.prepare('SELECT * FROM products WHERE id = ?').get(id) as any;

  try {
    // ── A) Migration registry tail + columns ──────────────────────────────
    console.log('\n─── A) Migrations v121/v122 ───');
    const tail = MIGRATIONS[MIGRATIONS.length - 1];
    assertEqualOrThrow(tail.version, 122, 'A: registry tail is migration v122');
    assertEqualOrThrow(tail.name, 'add_table_reservation_at', 'A: v122 name registered');
    const v121 = MIGRATIONS.find((m: any) => m.version === 121);
    assertOrThrow(!!v121, 'A: migration v121 exists');
    assertEqualOrThrow(v121.name, 'add_product_sold_out_and_pinned', 'A: v121 name registered');
    const productCols = (db.prepare('PRAGMA table_info(products)').all() as any[]).map(
      (c) => c.name,
    );
    assertOrThrow(productCols.includes('is_sold_out'), 'A: products.is_sold_out exists');
    assertOrThrow(productCols.includes('sold_out_at'), 'A: products.sold_out_at exists');
    assertOrThrow(productCols.includes('is_pinned'), 'A: products.is_pinned exists');
    const tableCols = (db.prepare('PRAGMA table_info(tables)').all() as any[]).map((c) => c.name);
    assertOrThrow(tableCols.includes('reservation_at'), 'A: tables.reservation_at exists');

    // ── B) Sold-out + pin permissions ─────────────────────────────────────
    console.log('\n─── B) Sold-out and pin ───');
    let res = await api(baseUrl, '/api/products/prod-1/sold-out', {
      method: 'PATCH',
      headers: serverUser.authHeader,
      body: { sold_out: true },
    });
    assertEqualOrThrow(res.status, 200, 'B: pos.use-only user may mark sold out');
    assertEqualOrThrow(res.data.product.is_sold_out, true, 'B: response flags sold out');
    assertOrThrow(
      typeof res.data.product.sold_out_at === 'string' && res.data.product.sold_out_at.length > 0,
      'B: sold_out_at is stamped',
    );
    assertEqualOrThrow(productRow('prod-1').is_sold_out, 1, 'B: sold-out persisted');

    res = await api(baseUrl, '/api/products/prod-1/sold-out', {
      method: 'PATCH',
      headers: chefUser.authHeader,
      body: { sold_out: false },
    });
    assertEqualOrThrow(res.status, 403, 'B: kitchen-only user may not touch sold-out');
    assertEqualOrThrow(productRow('prod-1').is_sold_out, 1, 'B: sold-out unchanged after 403');

    res = await api(baseUrl, '/api/products/prod-1/pin', {
      method: 'PATCH',
      headers: serverUser.authHeader,
      body: { pinned: true },
    });
    assertEqualOrThrow(res.status, 403, 'B: pinning requires catalog management');
    res = await api(baseUrl, '/api/products/prod-1/pin', {
      method: 'PATCH',
      headers: H,
      body: { pinned: true },
    });
    assertEqualOrThrow(res.status, 200, 'B: owner may pin');
    assertEqualOrThrow(res.data.product.is_pinned, true, 'B: response flags pinned');
    assertEqualOrThrow(productRow('prod-1').is_pinned, 1, 'B: pin persisted');

    res = await api(baseUrl, '/api/products/prod-1/sold-out', {
      method: 'PATCH',
      headers: serverUser.authHeader,
      body: { sold_out: false },
    });
    assertEqualOrThrow(res.status, 200, 'B: pos.use-only user may clear sold out');
    assertEqualOrThrow(res.data.product.sold_out_at, null, 'B: sold_out_at cleared');
    assertEqualOrThrow(productRow('prod-1').sold_out_at, null, 'B: cleared stamp persisted');

    res = await api(baseUrl, '/api/products/prod-1/sold-out', {
      method: 'PATCH',
      headers: H,
      body: { sold_out: 'yes' },
    });
    assertEqualOrThrow(res.status, 400, 'B: non-boolean sold_out rejected');

    const list = await api(baseUrl, '/api/products', { headers: H });
    const listed = (list.data.products as any[]).find((p) => p.id === 'prod-1');
    assertOrThrow(!!listed, 'B: product appears in list');
    assertEqualOrThrow(listed.is_pinned, true, 'B: list carries is_pinned');
    assertEqualOrThrow(listed.is_sold_out, false, 'B: list carries is_sold_out');

    // ── C) Bulk prices: happy path + atomic rollback ──────────────────────
    console.log('\n─── C) Bulk prices ───');
    res = await api(baseUrl, '/api/products/bulk-prices', {
      method: 'POST',
      headers: H,
      body: {
        items: [
          { id: 'prod-1', price: 12000 },
          { id: 'prod-2', price: 26000 },
        ],
      },
    });
    assertEqualOrThrow(res.status, 200, 'C: bulk-prices accepted');
    assertEqualOrThrow(res.data.updated, 2, 'C: two products updated');
    assertEqualOrThrow(productRow('prod-1').price, 12000, 'C: prod-1 price stored as given');
    assertEqualOrThrow(productRow('prod-2').price, 26000, 'C: prod-2 price stored as given');

    res = await api(baseUrl, '/api/products/bulk-prices', {
      method: 'POST',
      headers: H,
      body: {
        items: [
          { id: 'prod-1', price: 999 },
          { id: 'prod-missing', price: 1000 },
        ],
      },
    });
    assertEqualOrThrow(res.status, 400, 'C: batch with a missing id is rejected');
    assertEqualOrThrow(
      productRow('prod-1').price,
      12000,
      'C: rollback — the valid entry in the bad batch did not change',
    );

    res = await api(baseUrl, '/api/products/bulk-prices', {
      method: 'POST',
      headers: H,
      body: { items: [{ id: 'prod-1', price: -5 }] },
    });
    assertEqualOrThrow(res.status, 400, 'C: negative price rejected');
    assertEqualOrThrow(productRow('prod-1').price, 12000, 'C: price still unchanged');

    res = await api(baseUrl, '/api/products/bulk-prices', {
      method: 'POST',
      headers: serverUser.authHeader,
      body: { items: [{ id: 'prod-1', price: 1 }] },
    });
    assertEqualOrThrow(res.status, 403, 'C: bulk prices require catalog management');

    // ── D) Reservation time roundtrip ─────────────────────────────────────
    console.log('\n─── D) Table reservation_at ───');
    const reservationAt = '2026-10-27T19:30:00.000Z';
    res = await api(baseUrl, '/api/tables/tbl-a/status', {
      method: 'PATCH',
      headers: H,
      body: {
        status: 'reserved',
        reservation_customer_id: 'cust-1',
        reservation_at: reservationAt,
      },
    });
    assertEqualOrThrow(res.status, 200, 'D: reserve with time accepted');
    assertEqualOrThrow(res.data.table.reservation_at, reservationAt, 'D: response carries the time');
    assertEqualOrThrow(
      res.data.table.reservation_customer_name,
      'Ahmad',
      'D: reservation customer still resolved',
    );

    const tablesList = await api(baseUrl, '/api/tables', { headers: H });
    const listedTable = (tablesList.data.tables as any[]).find((t) => t.id === 'tbl-a');
    assertOrThrow(!!listedTable, 'D: table appears in list');
    assertEqualOrThrow(listedTable.reservation_at, reservationAt, 'D: list carries the time');

    const movedAt = '2026-10-27T20:15:00.000Z';
    res = await api(baseUrl, '/api/tables/tbl-a', {
      method: 'PUT',
      headers: H,
      body: { reservation_at: movedAt },
    });
    assertEqualOrThrow(res.status, 200, 'D: full update accepts reservation_at');
    assertEqualOrThrow(res.data.table.reservation_at, movedAt, 'D: updated time returned');
    assertEqualOrThrow(
      (db.prepare('SELECT reservation_at FROM tables WHERE id = ?').get('tbl-a') as any)
        .reservation_at,
      movedAt,
      'D: updated time persisted',
    );

    res = await api(baseUrl, '/api/tables/tbl-a', {
      method: 'PUT',
      headers: H,
      body: { reservation_at: null },
    });
    assertEqualOrThrow(res.status, 200, 'D: clearing reservation_at accepted');
    assertEqualOrThrow(res.data.table.reservation_at, null, 'D: cleared time returned as null');

    res = await api(baseUrl, '/api/tables/tbl-a', {
      method: 'PUT',
      headers: H,
      body: { reservation_at: 'not-a-date' },
    });
    assertEqualOrThrow(res.status, 400, 'D: invalid reservation time rejected');

    // ── E) Dish profitability vs SQL oracle ───────────────────────────────
    console.log('\n─── E) Dish profitability ───');
    const ts = dbNow();
    const orderMain = db
      .prepare(
        `INSERT INTO orders (order_number, type, status, subtotal, total, completed_at, created_at, updated_at)
         VALUES ('ORD-P3-MAIN', 'dine_in', 'completed', 115000, 115000, ?, ?, ?) RETURNING id`,
      )
      .get(ts, ts, ts) as { id: number };
    const insertItem = db.prepare(
      `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, ingredient_cost, ingredient_cost_known, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertItem.run(orderMain.id, 'prod-1', 'Shawarma', 10000, 4, 40000, 40000, 'served', 10000, 1, ts, ts);
    insertItem.run(orderMain.id, 'prod-2', 'Coffee', 25000, 1, 25000, 25000, 'served', 20000, 1, ts, ts);
    // Same dish, cost unknown at sale time: counts toward quantity/revenue,
    // not toward cost — coverage drops to half for this dish.
    insertItem.run(orderMain.id, 'prod-2', 'Coffee', 25000, 1, 25000, 25000, 'served', null, 0, ts, ts);
    // A voided line must not count anywhere.
    insertItem.run(orderMain.id, 'prod-1', 'Shawarma', 10000, 10, 100000, 100000, 'voided', 5000, 1, ts, ts);
    const orderCancelled = db
      .prepare(
        `INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
         VALUES ('ORD-P3-CXL', 'dine_in', 'cancelled', 70000, 70000, ?, ?) RETURNING id`,
      )
      .get(ts, ts) as { id: number };
    insertItem.run(orderCancelled.id, 'prod-1', 'Shawarma', 10000, 7, 70000, 70000, 'served', 7000, 1, ts, ts);

    const tz = 'Asia/Kolkata';
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    const oracle = db
      .prepare(
        `SELECT oi.product_id AS pid,
                COALESCE(SUM(oi.quantity), 0) AS qty,
                COALESCE(SUM(oi.subtotal), 0) AS rev,
                COALESCE(SUM(CASE WHEN oi.ingredient_cost_known = 1 THEN COALESCE(oi.ingredient_cost, 0) ELSE 0 END), 0) AS cost,
                COALESCE(SUM(CASE WHEN oi.ingredient_cost_known = 1 THEN oi.quantity ELSE 0 END), 0) AS known_qty
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.status != 'cancelled'
           AND COALESCE(oi.status, 'active') NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded')
         GROUP BY oi.product_id`,
      )
      .all() as any[];
    const oracleById = new Map(oracle.map((r) => [r.pid, r]));
    assertEqualOrThrow(oracleById.get('prod-1')?.qty, 4, 'E: oracle prod-1 quantity excludes voided + cancelled');
    assertEqualOrThrow(oracleById.get('prod-2')?.rev, 50000, 'E: oracle prod-2 revenue');

    res = await api(
      baseUrl,
      `/api/reports/dish-profitability?start_date=${today}&end_date=${today}`,
      { headers: H },
    );
    assertEqualOrThrow(res.status, 200, 'E: dish-profitability returns 200');
    const dish = res.data.dishProfitability;
    assertEqualOrThrow(dish.rows.length, 2, 'E: two dishes reported');
    const dishById = new Map((dish.rows as any[]).map((r) => [r.product_id, r]));
    for (const [pid, o] of oracleById) {
      const row = dishById.get(pid);
      assertOrThrow(!!row, `E: row present for ${pid}`);
      assertCloseOrThrow(row.quantity, Number(o.qty), `E: ${pid} quantity == oracle`);
      assertCloseOrThrow(row.revenue, Number(o.rev), `E: ${pid} revenue == oracle`);
      assertCloseOrThrow(row.ingredient_cost, Number(o.cost), `E: ${pid} cost == oracle`);
      assertCloseOrThrow(
        row.cost_coverage_pct,
        (Number(o.known_qty) / Number(o.qty)) * 100,
        `E: ${pid} coverage == oracle`,
      );
      assertCloseOrThrow(row.margin, Number(o.rev) - Number(o.cost), `E: ${pid} margin == oracle`);
    }
    const shawarma = dishById.get('prod-1');
    assertCloseOrThrow(shawarma.margin_pct, 75, 'E: shawarma margin_pct is 75');
    assertEqualOrThrow(shawarma.class, 'star', 'E: high qty + high margin classifies as star');
    const coffee = dishById.get('prod-2');
    assertCloseOrThrow(coffee.cost_coverage_pct, 50, 'E: coffee coverage is 50 (one unknown line)');
    assertEqualOrThrow(coffee.class, 'dog', 'E: low qty + low margin classifies as dog');
    assertCloseOrThrow(dish.totals.revenue, 90000, 'E: totals revenue');
    assertCloseOrThrow(dish.totals.margin, 60000, 'E: totals margin');

    const csvRes = await (globalThis as any).fetch(
      `${baseUrl}/api/reports/dish-profitability/export?start_date=${today}&end_date=${today}&format=csv`,
      { headers: H },
    );
    assertEqualOrThrow(csvRes.status, 200, 'E: CSV export returns 200');
    const csvText = await csvRes.text();
    assertOrThrow(csvText.includes('Shawarma'), 'E: CSV export contains the seeded dish name');
    assertOrThrow(csvText.includes('star'), 'E: CSV export contains the dish class');

    console.log('\nAll phase 3 feature assertions passed.');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
