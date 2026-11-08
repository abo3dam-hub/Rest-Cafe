/**
 * Integration Test: Catalog arrangement + special cards (follow-up 46)
 *
 * Owner decisions (2026-11-08):
 *  - Categories and products can be drag-reordered; the saved order is one
 *    shared order (sort_order), honoured by every surface.
 *  - Two manual special cards («الأكثر طلباً» + an offers card with an
 *    editable title) hold products the manager assigns by hand — no
 *    automatic suggestions and no special pricing: an offer is an ordinary
 *    product the manager creates, hides, or deletes.
 *
 * A) Migration v127 adds the special-card flags to products
 * B) Product list exposes the flags; PATCH toggles each independently
 * C) Special-card settings round-trip (defaults, save, validation)
 * D) Product/category list-order permutes existing sort_order values
 * E) Tables payload carries the per-table kitchen summary (quantity sums)
 *
 * Usage: node tests/run-electron-node-test.cjs tests/catalog-arrangement.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-catalog-arrangement-'));
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
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');

const { registerRoutes } = require('../main/routes/index');

async function main() {
  console.log('Integration Test: Catalog Arrangement + Special Cards');
  console.log('='.repeat(56));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-a', 'Category A');
  seedCategory(db, 'cat-b', 'Category B');
  seedCategory(db, 'cat-c', 'Category C');
  db.prepare("UPDATE categories SET sort_order = 10 WHERE id = 'cat-a'").run();
  db.prepare("UPDATE categories SET sort_order = 20 WHERE id = 'cat-b'").run();
  db.prepare("UPDATE categories SET sort_order = 30 WHERE id = 'cat-c'").run();
  seedProduct(db, 'prod-a', 'cat-a', 'Product A', 1000);
  seedProduct(db, 'prod-b', 'cat-a', 'Product B', 2000);
  seedProduct(db, 'prod-c', 'cat-b', 'Product C', 3000);
  db.prepare("UPDATE products SET sort_order = 5 WHERE id = 'prod-a'").run();
  db.prepare("UPDATE products SET sort_order = 15 WHERE id = 'prod-b'").run();
  db.prepare("UPDATE products SET sort_order = 25 WHERE id = 'prod-c'").run();
  seedTable(db, 'tbl-1', 1);

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  const get = (urlPath: string) => api(baseUrl, urlPath, { method: 'GET', headers: authHeader });
  const send = (method: string, urlPath: string, body: unknown) =>
    api(baseUrl, urlPath, { method, headers: authHeader, body });

  try {
    // ── A) Migration v127 columns ──────────────────────────────────────────
    const columns = db
      .prepare('PRAGMA table_info(products)')
      .all()
      .map((row: any) => row.name);
    assertOrThrow(columns.includes('in_top_card'), 'A: products.in_top_card exists');
    assertOrThrow(columns.includes('in_offers_card'), 'A: products.in_offers_card exists');

    // ── B) Special-card assignment ─────────────────────────────────────────
    const initial = await get('/api/products');
    assertEqualOrThrow(initial.status, 200, 'B: product list loads');
    const initialA = initial.data.products.find((p: any) => p.id === 'prod-a');
    assertEqualOrThrow(initialA.in_top_card, false, 'B: top flag starts false');
    assertEqualOrThrow(initialA.in_offers_card, false, 'B: offers flag starts false');

    const joined = await send('PATCH', '/api/products/prod-a/special-cards', {
      in_top_card: true,
    });
    assertEqualOrThrow(joined.status, 200, 'B: joining the top card accepted');
    assertEqualOrThrow(joined.data.product.in_top_card, true, 'B: top flag set');
    assertEqualOrThrow(
      joined.data.product.in_offers_card,
      false,
      'B: offers flag untouched by a top-only update',
    );
    const joinedOffers = await send('PATCH', '/api/products/prod-a/special-cards', {
      in_offers_card: true,
    });
    assertEqualOrThrow(joinedOffers.data.product.in_top_card, true, 'B: top flag kept');
    assertEqualOrThrow(joinedOffers.data.product.in_offers_card, true, 'B: offers flag set');
    const left = await send('PATCH', '/api/products/prod-a/special-cards', {
      in_top_card: false,
    });
    assertEqualOrThrow(left.data.product.in_top_card, false, 'B: leaving the top card works');
    assertEqualOrThrow(left.data.product.in_offers_card, true, 'B: offers membership kept');

    const emptyPatch = await send('PATCH', '/api/products/prod-a/special-cards', {});
    assertEqualOrThrow(emptyPatch.status, 400, 'B: empty assignment rejected');
    const wrongType = await send('PATCH', '/api/products/prod-a/special-cards', {
      in_top_card: 'yes',
    });
    assertEqualOrThrow(wrongType.status, 400, 'B: non-boolean assignment rejected');
    const missing = await send('PATCH', '/api/products/prod-nope/special-cards', {
      in_top_card: true,
    });
    assertEqualOrThrow(missing.status, 404, 'B: unknown product rejected with 404');

    // ── C) Special-card settings ───────────────────────────────────────────
    const defaults = await get('/api/settings/special-cards');
    assertEqualOrThrow(defaults.status, 200, 'C: settings load');
    assertEqualOrThrow(defaults.data.offers_title, '', 'C: offers title defaults empty');
    assertEqualOrThrow(defaults.data.top_position, 0, 'C: top position defaults to 0');
    assertEqualOrThrow(defaults.data.offers_position, 1, 'C: offers position defaults to 1');

    const saved = await send('PUT', '/api/settings/special-cards', {
      offers_title: 'عروض الخميس',
      top_position: 2,
      offers_position: 0,
    });
    assertEqualOrThrow(saved.status, 200, 'C: settings save accepted');
    assertEqualOrThrow(saved.data.offers_title, 'عروض الخميس', 'C: title saved');
    assertEqualOrThrow(saved.data.top_position, 2, 'C: top position saved');
    assertEqualOrThrow(saved.data.offers_position, 0, 'C: offers position saved');
    const reloaded = await get('/api/settings/special-cards');
    assertEqualOrThrow(reloaded.data.offers_title, 'عروض الخميس', 'C: title persists');

    const badPosition = await send('PUT', '/api/settings/special-cards', {
      top_position: -1,
    });
    assertEqualOrThrow(badPosition.status, 400, 'C: negative position rejected');
    const fractional = await send('PUT', '/api/settings/special-cards', {
      offers_position: 1.5,
    });
    assertEqualOrThrow(fractional.status, 400, 'C: fractional position rejected');
    const badTitle = await send('PUT', '/api/settings/special-cards', { offers_title: 5 });
    assertEqualOrThrow(badTitle.status, 400, 'C: non-string title rejected');

    // ── D) List ordering permutes existing sort values ─────────────────────
    const productOrder = await send('PATCH', '/api/products/list-order', {
      ids: ['prod-c', 'prod-a'],
    });
    assertEqualOrThrow(productOrder.status, 200, 'D: product reorder accepted');
    assertEqualOrThrow(productOrder.data.updated, 2, 'D: two products updated');
    const productSort = (id: string) =>
      db.prepare('SELECT sort_order FROM products WHERE id = ?').get(id).sort_order;
    assertEqualOrThrow(productSort('prod-c'), 5, 'D: prod-c takes the first existing value');
    assertEqualOrThrow(productSort('prod-b'), 15, 'D: unlisted product keeps its value');
    assertEqualOrThrow(productSort('prod-a'), 25, 'D: prod-a takes the last existing value');
    const orderedProducts = await get('/api/products');
    const relative = orderedProducts.data.products
      .map((p: any) => p.id)
      .filter((id: string) => ['prod-a', 'prod-b', 'prod-c'].includes(id));
    assertEqualOrThrow(
      JSON.stringify(relative),
      JSON.stringify(['prod-c', 'prod-b', 'prod-a']),
      'D: product list follows the arranged order',
    );
    const dupProducts = await send('PATCH', '/api/products/list-order', {
      ids: ['prod-a', 'prod-a'],
    });
    assertEqualOrThrow(dupProducts.status, 400, 'D: duplicate product ids rejected');
    const missingProduct = await send('PATCH', '/api/products/list-order', {
      ids: ['prod-a', 'prod-nope'],
    });
    assertEqualOrThrow(missingProduct.status, 404, 'D: unknown product id rejected');
    assertEqualOrThrow(productSort('prod-a'), 25, 'D: rejected reorder changes nothing');

    const categoryOrder = await send('PATCH', '/api/categories/list-order', {
      ids: ['cat-c', 'cat-a'],
    });
    assertEqualOrThrow(categoryOrder.status, 200, 'D: category reorder accepted');
    const categorySort = (id: string) =>
      db.prepare('SELECT sort_order FROM categories WHERE id = ?').get(id).sort_order;
    assertEqualOrThrow(categorySort('cat-c'), 10, 'D: cat-c takes the first existing value');
    assertEqualOrThrow(categorySort('cat-b'), 20, 'D: unlisted category keeps its value');
    assertEqualOrThrow(categorySort('cat-a'), 30, 'D: cat-a takes the last existing value');
    const orderedCategories = await get('/api/categories');
    const relativeCategories = orderedCategories.data.categories
      .map((c: any) => c.id)
      .filter((id: string) => ['cat-a', 'cat-b', 'cat-c'].includes(id));
    assertEqualOrThrow(
      JSON.stringify(relativeCategories),
      JSON.stringify(['cat-c', 'cat-b', 'cat-a']),
      'D: category list follows the arranged order',
    );

    // ── E) Kitchen summary on the tables payload ───────────────────────────
    const orderRes = await send('POST', '/api/orders', {
      type: 'dine_in',
      table_id: 'tbl-1',
      items: [
        { product_id: 'prod-a', quantity: 2 },
        { product_id: 'prod-b', quantity: 3 },
        { product_id: 'prod-c', quantity: 4 },
      ],
    });
    assertEqualOrThrow(orderRes.status, 201, 'E: dine-in order created');
    const orderId = orderRes.data.order.id;
    const itemIdFor = (productId: string) =>
      db
        .prepare('SELECT id FROM order_items WHERE order_id = ? AND product_id = ?')
        .get(orderId, productId).id;
    db.prepare('UPDATE order_items SET status = ? WHERE id = ?').run(
      'preparing',
      itemIdFor('prod-a'),
    );
    db.prepare('UPDATE order_items SET status = ? WHERE id = ?').run('ready', itemIdFor('prod-b'));
    db.prepare('UPDATE order_items SET status = ? WHERE id = ?').run('served', itemIdFor('prod-c'));

    const tables = await get('/api/tables');
    const table = tables.data.tables.find((t: any) => t.id === 'tbl-1');
    const activeOrder = table?.current_order ?? table?.activeOrder;
    assertOrThrow(table && activeOrder, 'E: table carries its active order');
    const summary = activeOrder.kitchen_summary;
    assertOrThrow(summary, 'E: kitchen summary present');
    assertEqualOrThrow(summary.pending, 0, 'E: pending sums quantities');
    assertEqualOrThrow(summary.preparing, 2, 'E: preparing sums quantities, not rows');
    assertEqualOrThrow(summary.ready, 3, 'E: ready sums quantities, not rows');
    assertEqualOrThrow(summary.served, 4, 'E: served sums quantities, not rows');
  } finally {
    server.close();
    closeDatabase();
  }

  const results = getResults();
  console.log(`\nResults: ${results.passed}/${results.total} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
