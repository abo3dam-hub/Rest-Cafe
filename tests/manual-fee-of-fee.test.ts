/**
 * Integration tests for the manual fee-list kind "percent of another fee"
 * (follow-up 45, owner decision 2026-11-08: the tax screen is one
 * invoice-level fee list; a fee may be a % of the bill, a % of another fee
 * in the list, or a fixed amount).
 *
 * Engine contract: a percent_of_fee component is stored as a percent rule
 * with feeBaseOnly=true and baseRuleIds=[the referenced rule] — its base is
 * the referenced fee's amount ALONE (never the bill plus that fee).
 *
 * Usage: node tests/run-electron-node-test.cjs tests/manual-fee-of-fee.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-manual-fee-of-fee-'));
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
  assertEqual,
  getResults,
  closeDatabase,
} = require('./helpers/test-setup');
const { registerRoutes } = require('../main/routes/index');

async function main() {
  console.log('Manual Fee-of-Fee Tests (follow-up 45)');
  console.log('='.repeat(56));

  const db = initTestDb();
  const owner = seedOwnerUser(db);
  seedCategory(db, 'fee-products', 'Fee Products');
  seedProduct(db, 'fee-product', 'fee-products', 'Fee Product', 10000, {
    tax_type: 'none',
    tax_category_id: null,
  });

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  const saveConfig = (components: Array<Record<string, unknown>>) =>
    api(baseUrl, '/api/tax-packs/manual-config', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        inclusive: false,
        override: true,
        categories: [{ tempId: 'standard', label: 'Standard', components }],
        defaultProductCategoryTempId: 'standard',
        packagingCategoryTempId: 'standard',
        deliveryCategoryTempId: 'standard',
        serviceChargeCategoryTempId: 'standard',
      },
    });

  try {
    console.log('\n1. A percent_of_fee referencing itself or a later fee is rejected');
    const selfRef = await saveConfig([
      { label: 'Fee A', type: 'percent', value: '10' },
      { label: 'Fee B', type: 'percent_of_fee', value: '5', baseIndex: 1 },
    ]);
    assertEqual(selfRef.status, 400, 'self-referencing percent_of_fee is rejected');
    const noBase = await saveConfig([
      { label: 'Fee A', type: 'percent_of_fee', value: '5' },
    ]);
    assertEqual(noBase.status, 400, 'percent_of_fee without an earlier fee is rejected');
    console.log('   ✓ invalid references rejected with 400');

    console.log('\n2. Fee list: 10% of bill + 5% of that fee + fixed 100');
    const saved = await saveConfig([
      { label: 'Fee A', type: 'percent', value: '10' },
      { label: 'Fee B', type: 'percent_of_fee', value: '5', baseIndex: 0 },
      { label: 'Fee C', type: 'fixed', value: '100' },
    ]);
    assertEqual(saved.status, 200, 'fee list with percent_of_fee saves');

    console.log('\n3. Stored rule carries feeBaseOnly + the referenced rule id');
    const ruleRow = (label: string) =>
      db
        .prepare(
          `SELECT rule_id, base_rule_ids, definition_json FROM tax_rules
           WHERE label = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(label) as
        | { rule_id: string; base_rule_ids: string; definition_json: string }
        | undefined;
    const feeBRow = ruleRow('Fee B');
    const feeARow = ruleRow('Fee A');
    assert(feeBRow && feeARow, 'Fee A and Fee B rules exist');
    const feeB = JSON.parse(feeBRow!.definition_json);
    assertEqual(feeB.feeBaseOnly, true, 'Fee B is feeBaseOnly');
    assertEqual(
      JSON.stringify(JSON.parse(feeBRow!.base_rule_ids)),
      JSON.stringify([feeARow!.rule_id]),
      'Fee B references Fee A only',
    );
    console.log('   ✓ rule graph is feeBaseOnly → Fee A');

    console.log('\n4. Order math: fee-of-fee is % of the fee alone, not of bill+fee');
    db.prepare("UPDATE settings SET value = 'true' WHERE key = 'taxes_enabled'").run();
    const orderRes = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: {
        type: 'takeaway',
        items: [{ product_id: 'fee-product', quantity: 1 }],
      },
    });
    if (orderRes.status !== 201) console.log('   order error:', JSON.stringify(orderRes.data));
    assertEqual(orderRes.status, 201, 'order created');
    const order = orderRes.data.order;
    // Fee A = 10% of 10,000 = 1,000. Fee B = 5% of 1,000 = 50 (NOT 5% of
    // 11,000 = 550). Fee C = 100 fixed. Total tax = 1,150.
    assertEqual(order.tax_amount, 1150, 'tax = 1000 + 50 + 100');
    assertEqual(order.total, 11150, 'total = 10,000 + 1,150');
    console.log('   ✓ order tax is 1,150 (fee-of-fee = 50, not 550)');
  } finally {
    server.close();
    closeDatabase();
  }

  console.log('\n' + '='.repeat(56));
  const results = getResults();
  console.log(`${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Test suite crashed:', error);
  process.exit(1);
});
