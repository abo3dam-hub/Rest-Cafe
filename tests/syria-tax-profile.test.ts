/**
 * Integration tests for the Syria tax profiles endpoint
 * (POST /api/tax-packs/syria-profile).
 *
 * The consumption-spending fee (رسم الإنفاق الاستهلاكي, Decree 11/2015 as
 * amended by Law 15/2024) is a single levy on the whole bill: the owner
 * answers one classification question and every line — including products
 * with no stored tax category, e.g. CSV-imported ones — is charged at that
 * rate, printed as its own breakdown line. The announced 2027 sales tax
 * is a second selectable profile at 5%. Settings mirror production:
 * country '' (no country profiles), currency SYP.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/syria-tax-profile.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-syria-tax-profile-'));
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
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
  ).run(key, value, now());
}

function getSetting(db: any, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

async function main() {
  console.log('Syria Tax Profile Integration Tests');
  console.log('='.repeat(56));

  const db = initTestDb();
  // Production shape: no country profile, Syrian pound.
  setSetting(db, 'country', '');
  setSetting(db, 'currency', 'SYP');
  setSetting(db, 'business_type', 'restaurant');

  const owner = seedOwnerUser(db);
  const manager = seedManagerUser(db);
  seedCategory(db, 'syria-menu', 'Syria Menu');
  seedProduct(db, 'syria-p1', 'syria-menu', 'Shawarma', 10000, { tax_category_id: null });
  seedProduct(db, 'syria-p2', 'syria-menu', 'Falafel', 5000, { tax_category_id: null });

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  async function createOrder(items: Array<{ product_id: string; quantity: number }>) {
    return api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'takeaway', items },
    });
  }

  try {
    console.log('\n1. Baseline: taxes off — an order carries no tax');
    const baseline = await createOrder([{ product_id: 'syria-p1', quantity: 1 }]);
    assertEqualOrThrow(baseline.status, 201, 'baseline order created');
    assertEqualOrThrow(baseline.data.order.tax_amount, 0, 'baseline tax is zero');
    assertEqualOrThrow(baseline.data.order.total, 10000, 'baseline total is the subtotal');

    console.log('\n2. Permission gate and input validation');
    const forbidden = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: manager.authHeader,
      body: { profile: 'consumption', classification: 'rated_2_3' },
    });
    assertEqualOrThrow(forbidden.status, 403, 'manager without tax-packs.manage is rejected');
    const badSalesRate = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'sales', rate: 150 },
    });
    assertEqualOrThrow(badSalesRate.status, 400, 'sales profile still validates the rate');
    const badClass = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'seven_stars' },
    });
    assertEqualOrThrow(badClass.status, 400, 'unknown classification is rejected');
    const badRate = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'rated_2_3', rate: 150 },
    });
    assertEqualOrThrow(badRate.status, 400, 'rate above 100 is rejected');

    console.log('\n3. Owner activates the consumption fee — classified 2–3 stars (5%)');
    const activate = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'rated_2_3' },
    });
    assertEqualOrThrow(activate.status, 200, 'activation succeeds');
    assertEqualOrThrow(activate.data.pack_id, 'syria-consumption', 'consumption pack installed');
    assertEqualOrThrow(activate.data.rate, 5, 'legal default rate for 2–3 stars is 5%');
    assertEqualOrThrow(getSetting(db, 'taxes_enabled'), 'true', 'taxes are enabled');
    assertEqualOrThrow(getSetting(db, 'tax_profile'), 'syria_consumption', 'profile recorded');
    assertEqualOrThrow(getSetting(db, 'syria_tax_classification'), 'rated_2_3', 'class recorded');
    assertEqualOrThrow(getSetting(db, 'syria_tax_rate'), '5', 'rate recorded');

    const packsRes = await api(baseUrl, '/api/tax-packs', { headers: owner.authHeader });
    const activePack = (packsRes.data.packs as any[]).find((pack) => pack.active_for_store);
    assertEqualOrThrow(activePack?.id, 'syria-consumption', 'syria pack is the active pack');

    console.log('\n4. Existing products join the single category; charge overrides exist');
    for (const productId of ['syria-p1', 'syria-p2']) {
      const row = db
        .prepare('SELECT tax_category_id FROM products WHERE id = ?')
        .get(productId) as { tax_category_id: string };
      assertEqualOrThrow(
        row.tax_category_id,
        'establishment-services',
        `${productId} remapped to the establishment category`,
      );
    }
    const chargeOverrides = db
      .prepare(
        `SELECT COUNT(*) AS c FROM tax_overrides
         WHERE pack_version_id = ? AND entity_id IS NULL AND field_name = 'tax_category_id'`,
      )
      .get(activate.data.version_id) as { c: number };
    assertEqualOrThrow(chargeOverrides.c, 3, 'packaging/delivery/service overrides are set');

    console.log('\n5. Whole-bill fee, including a product created after activation');
    seedProduct(db, 'syria-p3', 'syria-menu', 'Tea', 2000, { tax_category_id: null });
    const order = await createOrder([
      { product_id: 'syria-p1', quantity: 1 },
      { product_id: 'syria-p2', quantity: 1 },
      { product_id: 'syria-p3', quantity: 1 },
    ]);
    assertEqualOrThrow(order.status, 201, 'order created under the fee');
    assertEqualOrThrow(order.data.order.subtotal, 17000, 'subtotal is 17,000');
    assertEqualOrThrow(order.data.order.tax_amount, 850, 'fee is 5% of the whole bill (850)');
    assertEqualOrThrow(order.data.order.total, 17850, 'fee is added on top of the bill');
    const rawBreakdown = order.data.order.tax_breakdown;
    const breakdown = (typeof rawBreakdown === 'string'
      ? JSON.parse(rawBreakdown || '[]')
      : rawBreakdown || []) as any[];
    const feeLines = breakdown.filter((line) => line.title === 'رسم الإنفاق الاستهلاكي');
    assertEqualOrThrow(feeLines.length, 1, 'one aggregated fee line on the breakdown');
    assertEqualOrThrow(feeLines[0].rate, 5, 'fee line carries the 5% rate');
    assertEqualOrThrow(feeLines[0].amount, 850, 'fee line amount matches the order tax');

    console.log('\n6. The generated bill carries the same fee');
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: owner.authHeader,
      body: { order_id: order.data.order.id },
    });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    assertEqualOrThrow(bill.data.bill.tax_amount, 850, 'bill tax equals the fee');
    assertEqualOrThrow(bill.data.bill.total, 17850, 'bill total includes the fee');

    console.log('\n7. A discount scales the fee to the discounted bill');
    const discounted = await api(baseUrl, `/api/orders/${order.data.order.id}/discount`, {
      method: 'PATCH',
      headers: owner.authHeader,
      body: { discount_type: 'percentage', discount_value: 10 },
    });
    assertEqualOrThrow(discounted.status, 200, 'discount applied');
    assertEqualOrThrow(
      discounted.data.order.tax_amount,
      765,
      'fee follows the discounted bill (5% of 15,300)',
    );

    console.log('\n8. Reclassification: popular/unrated is exempt (0%)');
    const exempt = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'unrated' },
    });
    assertEqualOrThrow(exempt.status, 200, 'reclassification succeeds');
    assertEqualOrThrow(exempt.data.rate, 0, 'unrated rate is zero');
    const exemptOrder = await createOrder([{ product_id: 'syria-p1', quantity: 1 }]);
    assertEqualOrThrow(exemptOrder.data.order.tax_amount, 0, 'no fee for an unrated establishment');
    assertEqualOrThrow(exemptOrder.data.order.total, 10000, 'total is unchanged when exempt');

    console.log('\n9. Editable rate: owner overrides the legal default');
    const custom = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'rated_2_3', rate: 7 },
    });
    assertEqualOrThrow(custom.status, 200, 'rate override accepted');
    const customOrder = await createOrder([
      { product_id: 'syria-p1', quantity: 1 },
      { product_id: 'syria-p2', quantity: 1 },
    ]);
    assertEqualOrThrow(customOrder.data.order.tax_amount, 1050, 'fee uses the edited 7% rate');
    assertEqualOrThrow(getSetting(db, 'syria_tax_rate'), '7', 'edited rate recorded');

    console.log('\n10. Sales tax is a selectable profile at its announced 5%');
    const sales = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'sales' },
    });
    assertEqualOrThrow(sales.status, 200, 'owner can select the sales tax profile');
    assertEqualOrThrow(sales.data.pack_id, 'syria-sales', 'sales pack installed');
    assertEqualOrThrow(sales.data.rate, 5, 'announced default rate is 5%');
    assertEqualOrThrow(getSetting(db, 'tax_profile'), 'syria_sales', 'sales profile recorded');
    const salesOrder = await createOrder([
      { product_id: 'syria-p1', quantity: 1 },
      { product_id: 'syria-p2', quantity: 1 },
    ]);
    assertEqualOrThrow(salesOrder.data.order.tax_amount, 750, 'sales tax is 5% of the whole bill');
    const salesBreakdown = (typeof salesOrder.data.order.tax_breakdown === 'string'
      ? JSON.parse(salesOrder.data.order.tax_breakdown || '[]')
      : salesOrder.data.order.tax_breakdown || []) as any[];
    assertEqualOrThrow(
      salesBreakdown.some((line) => line.title === 'ضريبة المبيعات' && line.rate === 5),
      true,
      'breakdown carries the sales tax line',
    );

    console.log('\n11. Turning taxes off is a safe off-ramp');
    const off = await api(baseUrl, '/api/settings/taxes_enabled', {
      method: 'PUT',
      headers: owner.authHeader,
      body: { value: 'false' },
    });
    assertEqualOrThrow(off.status, 200, 'taxes turned off');
    const offOrder = await createOrder([{ product_id: 'syria-p1', quantity: 1 }]);
    assertEqualOrThrow(offOrder.data.order.tax_amount, 0, 'no fee while taxes are off');
    assertOrThrow(offOrder.status === 201, 'orders still work with taxes off');
  } finally {
    server.close();
    closeDatabase();
  }

  const results = getResults();
  console.log(`\nSyria tax profile: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Syria tax profile test crashed:', error);
  process.exit(1);
});
