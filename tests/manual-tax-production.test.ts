/**
 * Regression tests: a manual tax configuration must reach checkout under
 * production-shape settings (country '' — Rest&Cafe has no country
 * profiles — and SYP).
 *
 * Before the fix, the manual pack was stored under the home-market key
 * 'SY' while order-time pack resolution with a stored country of '' only
 * matched '*' packs, so the bundled generic pack shadowed it: an order
 * then either failed with "resolved unknown tax category" (any category
 * whose slug is not a generic one) or silently carried no tax.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/manual-tax-production.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-manual-tax-production-'));
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
  assertEqualOrThrow,
  getResults,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');

function setSetting(db: any, key: string, value: string) {
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
  ).run(key, value, now());
}

async function main() {
  console.log('Manual Tax — Production Shape Regression Tests');
  console.log('='.repeat(56));

  const db = initTestDb();
  setSetting(db, 'country', '');
  setSetting(db, 'currency', 'SYP');
  setSetting(db, 'business_type', 'restaurant');

  const owner = seedOwnerUser(db);
  seedCategory(db, 'prod-menu', 'Production Menu');
  seedProduct(db, 'prod-p1', 'prod-menu', 'Item', 10000, { tax_category_id: null });

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  async function saveManual(label: string, rate: string) {
    return api(baseUrl, '/api/tax-packs/manual-config', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        inclusive: false,
        categories: [
          {
            tempId: 'only',
            label,
            components: [{ label: `${label} Tax`, type: 'percent', value: rate }],
          },
        ],
        defaultProductCategoryTempId: 'only',
        packagingCategoryTempId: 'only',
        deliveryCategoryTempId: 'only',
        serviceChargeCategoryTempId: 'only',
      },
    });
  }

  async function orderTotal() {
    const res = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'prod-p1', quantity: 1 }] },
    });
    assertEqualOrThrow(res.status, 201, 'order is created (checkout is not blocked)');
    return res.data.order;
  }

  try {
    console.log('\n1. Manual config with a non-generic category name reaches checkout');
    const save = await saveManual('Special', '10');
    assertEqualOrThrow(save.status, 200, 'manual config saved');
    assertEqualOrThrow(save.data.pack_id, 'manual-sy', 'manual pack stored under the home key');

    const packsRes = await api(baseUrl, '/api/tax-packs', { headers: owner.authHeader });
    const activeForStore = (packsRes.data.packs as any[]).find((pack) => pack.active_for_store);
    assertEqualOrThrow(
      activeForStore?.id,
      'manual-sy',
      'packs list reports the manual pack as active for the store',
    );

    const order = await orderTotal();
    assertEqualOrThrow(order.subtotal, 10000, 'subtotal is 10,000');
    assertEqualOrThrow(order.tax_amount, 1000, 'manual 10% tax is applied at checkout');
    assertEqualOrThrow(order.total, 11000, 'total includes the manual tax');
    const breakdown = (typeof order.tax_breakdown === 'string'
      ? JSON.parse(order.tax_breakdown || '[]')
      : order.tax_breakdown || []) as any[];
    assertEqualOrThrow(
      breakdown.some((line) => line.title === 'Special Tax' && line.rate === 10),
      true,
      'breakdown carries the manual component line',
    );

    console.log('\n2. Re-saving with a generic-named category also applies (no silent zero)');
    const resave = await saveManual('Standard', '5');
    assertEqualOrThrow(resave.status, 200, 'manual config re-saved');
    const order2 = await orderTotal();
    assertEqualOrThrow(order2.tax_amount, 500, 're-saved 5% rate applies at checkout');
    assertEqualOrThrow(order2.total, 10500, 'total follows the re-saved rate');
  } finally {
    server.close();
    closeDatabase();
  }

  const results = getResults();
  console.log(`\nManual tax production: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Manual tax production test crashed:', error);
  process.exit(1);
});
