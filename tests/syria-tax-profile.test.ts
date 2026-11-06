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
 * Owner-confirmed Syrian practice (2026-11-06): the fee is computed on the
 * WHOLE bill with fractions rounded up; the local-administration fee is a
 * percent OF the consumption fee (default 5%, editable), also rounded up;
 * and a discount is deducted only after the fees, with a percentage
 * discount taken from the post-fee total.
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
    const badAdminRate = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'rated_2_3', local_admin_rate: 150 },
    });
    assertEqualOrThrow(badAdminRate.status, 400, 'local admin rate above 100 is rejected');

    console.log('\n3. Owner activates the consumption fee — classified 2–3 stars (5%)');
    const activate = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'rated_2_3' },
    });
    assertEqualOrThrow(activate.status, 200, 'activation succeeds');
    assertEqualOrThrow(activate.data.pack_id, 'syria-consumption', 'consumption pack installed');
    assertEqualOrThrow(activate.data.rate, 5, 'legal default rate for 2–3 stars is 5%');
    assertEqualOrThrow(activate.data.local_admin_rate, 5, 'local admin defaults to 5% of the fee');
    assertEqualOrThrow(getSetting(db, 'syria_local_admin_rate'), '5', 'local admin rate recorded');
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
    assertEqualOrThrow(
      order.data.order.tax_amount,
      893,
      'tax is the fee (850) plus local admin at 5% of the fee, rounded up (43)',
    );
    assertEqualOrThrow(order.data.order.total, 17893, 'fees are added on top of the bill');
    const rawBreakdown = order.data.order.tax_breakdown;
    const breakdown = (typeof rawBreakdown === 'string'
      ? JSON.parse(rawBreakdown || '[]')
      : rawBreakdown || []) as any[];
    const feeLines = breakdown.filter((line) => line.title === 'رسم الإنفاق الاستهلاكي');
    assertEqualOrThrow(feeLines.length, 1, 'one aggregated fee line on the breakdown');
    assertEqualOrThrow(feeLines[0].rate, 5, 'fee line carries the 5% rate');
    assertEqualOrThrow(feeLines[0].amount, 850, 'fee line amount is 5% of the whole bill');
    const adminLines = breakdown.filter((line) => line.title === 'رسم الإدارة المحلية');
    assertEqualOrThrow(adminLines.length, 1, 'one local admin line on the breakdown');
    assertEqualOrThrow(adminLines[0].rate, 5, 'admin line carries the 5% rate');
    assertEqualOrThrow(adminLines[0].amount, 43, 'admin is 5% of the fee, rounded up (42.5 → 43)');

    console.log('\n6. The generated bill carries the same fee');
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      headers: owner.authHeader,
      body: { order_id: order.data.order.id },
    });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    assertEqualOrThrow(bill.data.bill.tax_amount, 893, 'bill tax equals fee + local admin');
    assertEqualOrThrow(bill.data.bill.total, 17893, 'bill total includes both fees');

    console.log('\n7. A discount is deducted after the fees and never shrinks them');
    const discounted = await api(baseUrl, `/api/orders/${order.data.order.id}/discount`, {
      method: 'PATCH',
      headers: owner.authHeader,
      body: { discount_type: 'percentage', discount_value: 10 },
    });
    assertEqualOrThrow(discounted.status, 200, 'discount applied');
    assertEqualOrThrow(
      discounted.data.order.tax_amount,
      893,
      'fees stay on the whole pre-discount bill',
    );
    assertEqualOrThrow(
      discounted.data.order.discount_amount,
      1789,
      'percentage discount is taken from the post-fee total (10% of 17,893)',
    );
    assertEqualOrThrow(
      discounted.data.order.total,
      16104,
      'total is the post-fee total minus the discount',
    );

    console.log('\n8. Whole-bill ceiling across many small lines (approved mockup numbers)');
    seedProduct(db, 'syria-p4', 'syria-menu', 'Coffee', 950, { tax_category_id: null });
    seedProduct(db, 'syria-p5', 'syria-menu', 'Grill', 1200, { tax_category_id: null });
    seedProduct(db, 'syria-p6', 'syria-menu', 'Salad', 250, { tax_category_id: null });
    seedProduct(db, 'syria-p7', 'syria-menu', 'Water', 100, { tax_category_id: null });
    seedProduct(db, 'syria-p8', 'syria-menu', 'Bread', 50, { tax_category_id: null });
    seedProduct(db, 'syria-p9', 'syria-menu', 'Tissues', 25, { tax_category_id: null });
    const manyLines = await createOrder([
      { product_id: 'syria-p4', quantity: 1 },
      { product_id: 'syria-p5', quantity: 1 },
      { product_id: 'syria-p6', quantity: 1 },
      { product_id: 'syria-p7', quantity: 2 },
      { product_id: 'syria-p8', quantity: 1 },
      { product_id: 'syria-p9', quantity: 1 },
    ]);
    assertEqualOrThrow(manyLines.status, 201, 'multi-line order created');
    assertEqualOrThrow(manyLines.data.order.subtotal, 2675, 'subtotal is 2,675');
    const manyBreakdown = (typeof manyLines.data.order.tax_breakdown === 'string'
      ? JSON.parse(manyLines.data.order.tax_breakdown || '[]')
      : manyLines.data.order.tax_breakdown || []) as any[];
    const manyFee = manyBreakdown.find((line) => line.title === 'رسم الإنفاق الاستهلاكي');
    // Per-line rounding would give 135; the levy is on the whole bill:
    // 2,675 × 5% = 133.75, rounded UP to 134.
    assertEqualOrThrow(manyFee?.amount, 134, 'fee is rounded up on the whole bill, not per line');
    const manyAdmin = manyBreakdown.find((line) => line.title === 'رسم الإدارة المحلية');
    assertEqualOrThrow(manyAdmin?.amount, 7, 'admin is 5% of 134, rounded up (6.7 → 7)');
    assertEqualOrThrow(manyLines.data.order.tax_amount, 141, 'tax is fee + admin');
    assertEqualOrThrow(manyLines.data.order.total, 2816, 'total matches the approved mockup');

    console.log('\n9. Percentage discount on the post-fee total (owner example)');
    const exampleOrder = await createOrder([{ product_id: 'syria-p1', quantity: 1 }]);
    assertEqualOrThrow(exampleOrder.data.order.tax_amount, 525, 'fee 500 + admin 25');
    assertEqualOrThrow(exampleOrder.data.order.total, 10525, 'post-fee total is 10,525');
    const exampleDiscount = await api(
      baseUrl,
      `/api/orders/${exampleOrder.data.order.id}/discount`,
      {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { discount_type: 'percentage', discount_value: 10 },
      },
    );
    assertEqualOrThrow(exampleDiscount.status, 200, 'discount applied');
    assertEqualOrThrow(
      exampleDiscount.data.order.discount_amount,
      1053,
      '10% is taken from 10,525, not from 10,000',
    );
    assertEqualOrThrow(exampleDiscount.data.order.tax_amount, 525, 'fees unchanged by discount');
    assertEqualOrThrow(exampleDiscount.data.order.total, 9472, 'total is 10,525 − 1,053');

    console.log('\n10. An amount discount is also deducted after the fees');
    setSetting(db, 'discount_mode', 'both');
    const amountOrder = await createOrder([{ product_id: 'syria-p1', quantity: 1 }]);
    const amountDiscount = await api(
      baseUrl,
      `/api/orders/${amountOrder.data.order.id}/discount`,
      {
        method: 'PATCH',
        headers: owner.authHeader,
        body: { discount_type: 'amount', discount_value: 2000 },
      },
    );
    assertEqualOrThrow(amountDiscount.status, 200, 'amount discount applied');
    assertEqualOrThrow(amountDiscount.data.order.tax_amount, 525, 'fees unchanged');
    assertEqualOrThrow(amountDiscount.data.order.total, 8525, 'total is 10,525 − 2,000');

    console.log('\n11. Reclassification: popular/unrated is exempt (0%)');
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

    console.log('\n12. Editable rate: owner overrides the legal default');
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
    assertEqualOrThrow(
      customOrder.data.order.tax_amount,
      1103,
      'fee uses the edited 7% rate (1,050) plus admin rounded up (52.5 → 53)',
    );
    assertEqualOrThrow(getSetting(db, 'syria_tax_rate'), '7', 'edited rate recorded');

    console.log('\n13. Local admin rate is editable, and 0 turns it off');
    const adminCustom = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'rated_2_3', rate: 7, local_admin_rate: 10 },
    });
    assertEqualOrThrow(adminCustom.status, 200, 'admin rate override accepted');
    assertEqualOrThrow(adminCustom.data.local_admin_rate, 10, 'response carries the admin rate');
    assertEqualOrThrow(getSetting(db, 'syria_local_admin_rate'), '10', 'admin rate recorded');
    const adminOrder = await createOrder([
      { product_id: 'syria-p1', quantity: 1 },
      { product_id: 'syria-p2', quantity: 1 },
    ]);
    assertEqualOrThrow(
      adminOrder.data.order.tax_amount,
      1155,
      'admin at 10% of the 1,050 fee adds 105',
    );
    const adminOff = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'rated_2_3', rate: 7, local_admin_rate: 0 },
    });
    assertEqualOrThrow(adminOff.status, 200, 'admin rate 0 accepted');
    const adminOffOrder = await createOrder([
      { product_id: 'syria-p1', quantity: 1 },
      { product_id: 'syria-p2', quantity: 1 },
    ]);
    assertEqualOrThrow(adminOffOrder.data.order.tax_amount, 1050, 'no admin line at rate 0');
    const adminOffBreakdown = (typeof adminOffOrder.data.order.tax_breakdown === 'string'
      ? JSON.parse(adminOffOrder.data.order.tax_breakdown || '[]')
      : adminOffOrder.data.order.tax_breakdown || []) as any[];
    assertEqualOrThrow(
      adminOffBreakdown.some((line) => line.title === 'رسم الإدارة المحلية'),
      false,
      'breakdown has no admin line at rate 0',
    );
    // Restore the default for the remaining sections.
    await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'rated_2_3', rate: 7, local_admin_rate: 5 },
    });

    console.log('\n14. Sales tax is a selectable profile at its announced 5%');
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

    console.log('\n15. Turning taxes off is a safe off-ramp');
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
