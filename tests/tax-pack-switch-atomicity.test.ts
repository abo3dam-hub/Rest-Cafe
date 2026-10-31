/**
 * Tax pack switch atomicity — assignment 033, finding F-R3-1.
 *
 * With a manual pack active, activating the Syria consumption profile used
 * to return 200 while leaving checkout broken: the products were remapped
 * onto the Syria category (establishment-services) the resolved manual
 * pack does not define, so every subsequent order failed 400 with
 * "unknown tax category". The switch must now be atomic: a profile
 * activation over a different active pack is rejected (409,
 * active_pack_conflict) before anything mutates, and the owner switches
 * in two steps — deactivate the active pack first, then activate the
 * replacement. Re-activating the Syria profile while a Syria pack is
 * already active (classification change, or the other Syria profile —
 * both share one category vocabulary) keeps working as before.
 *
 * Production shape: country '' (no country profiles), currency SYP.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/tax-pack-switch-atomicity.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tax-pack-switch-'));
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

function getSetting(db: any, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

async function main() {
  console.log('Tax Pack Switch Atomicity Tests');
  console.log('='.repeat(56));

  const db = initTestDb();
  // Production shape: no country profile, Syrian pound.
  setSetting(db, 'country', '');
  setSetting(db, 'currency', 'SYP');
  setSetting(db, 'business_type', 'restaurant');

  const owner = seedOwnerUser(db);
  seedCategory(db, 'atom-menu', 'Atomicity Menu');
  seedProduct(db, 'atom-p1', 'atom-menu', 'Shawarma', 10000, { tax_category_id: null });

  const app = createApp({});
  registerRoutes(app);
  const { baseUrl, server } = await startServer(app);

  async function checkout() {
    const res = await api(baseUrl, '/api/orders', {
      method: 'POST',
      headers: owner.authHeader,
      body: { type: 'takeaway', items: [{ product_id: 'atom-p1', quantity: 1 }] },
    });
    assertEqualOrThrow(res.status, 201, 'checkout order is created');
    return res.data.order;
  }

  async function activePackIds(): Promise<string[]> {
    const res = await api(baseUrl, '/api/tax-packs', { headers: owner.authHeader });
    assertEqualOrThrow(res.status, 200, 'packs list reads');
    return ((res.data.packs as any[]) || [])
      .filter((pack) => pack.active_for_store)
      .map((pack) => pack.id);
  }

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

  function taxSettingsSnapshot() {
    return JSON.stringify({
      taxes_enabled: getSetting(db, 'taxes_enabled'),
      tax_profile: getSetting(db, 'tax_profile'),
      syria_tax_classification: getSetting(db, 'syria_tax_classification'),
      syria_tax_rate: getSetting(db, 'syria_tax_rate'),
    });
  }

  function productCategoryId() {
    const row = db.prepare('SELECT tax_category_id FROM products WHERE id = ?').get('atom-p1') as {
      tax_category_id: string | null;
    };
    return row.tax_category_id;
  }

  function latestVersionId(packId: string): string {
    const row = db
      .prepare(
        'SELECT id FROM country_pack_versions WHERE pack_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(packId) as { id: string } | undefined;
    assertOrThrow(!!row, `${packId} has a stored version`);
    return row!.id;
  }

  try {
    console.log('\n1. Manual pack active: 10% applies at checkout');
    const save = await saveManual('Manual', '10');
    assertEqualOrThrow(save.status, 200, 'manual config saved');
    assertEqualOrThrow(save.data.pack_id, 'manual-sy', 'manual pack stored under the home key');
    assertEqualOrThrow(
      JSON.stringify(await activePackIds()),
      JSON.stringify(['manual-sy']),
      'only the manual pack is active',
    );
    const manualOrder = await checkout();
    assertEqualOrThrow(manualOrder.subtotal, 10000, 'manual subtotal is 10,000');
    assertEqualOrThrow(manualOrder.tax_amount, 1000, 'manual 10% tax is applied');
    assertEqualOrThrow(manualOrder.total, 11000, 'manual total includes the tax');

    console.log('\n2. (a) Syria profile over the active manual pack is rejected, nothing moves');
    const settingsBefore = taxSettingsSnapshot();
    const categoryBefore = productCategoryId();
    const rejected = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'rated_4_5' },
    });
    assertEqualOrThrow(rejected.status, 409, 'profile activation over a manual pack is rejected');
    assertEqualOrThrow(
      rejected.data?.code,
      'active_pack_conflict',
      'the rejection carries the stable error code',
    );
    assertEqualOrThrow(
      rejected.data?.active_pack_id,
      'manual-sy',
      'the rejection names the active manual pack',
    );
    assertOrThrow(
      String(rejected.data?.error || '').includes('manual-sy'),
      'the rejection message names the active pack',
    );
    assertEqualOrThrow(
      taxSettingsSnapshot(),
      settingsBefore,
      'tax settings are byte-for-byte untouched by the rejection',
    );
    assertEqualOrThrow(
      productCategoryId(),
      categoryBefore,
      'products are not remapped by the rejection',
    );
    assertEqualOrThrow(
      JSON.stringify(await activePackIds()),
      JSON.stringify(['manual-sy']),
      'only the manual pack stays active after the rejection',
    );
    const afterRejection = await checkout();
    assertEqualOrThrow(
      afterRejection.tax_amount,
      1000,
      'checkout after the rejection still uses the manual 10%',
    );
    assertEqualOrThrow(
      afterRejection.total,
      11000,
      'checkout total after the rejection is the manual total',
    );

    console.log('\n3. (b) Two-step switch: deactivate the manual pack, then activate the profile');
    const unknown = await api(baseUrl, '/api/tax-packs/no-such-pack/deactivate', {
      method: 'POST',
      headers: owner.authHeader,
      body: {},
    });
    assertEqualOrThrow(unknown.status, 404, 'deactivating an unknown pack is a 404');
    const deactivated = await api(baseUrl, '/api/tax-packs/manual-sy/deactivate', {
      method: 'POST',
      headers: owner.authHeader,
      body: {},
    });
    assertEqualOrThrow(deactivated.status, 200, 'manual pack deactivates');
    assertEqualOrThrow(deactivated.data?.changed, true, 'deactivation reports a change');
    assertEqualOrThrow(deactivated.data?.pack_id, 'manual-sy', 'deactivation names the pack');
    assertEqualOrThrow(
      JSON.stringify(await activePackIds()),
      JSON.stringify([]),
      'no pack is active after the deactivation',
    );
    const repeat = await api(baseUrl, '/api/tax-packs/manual-sy/deactivate', {
      method: 'POST',
      headers: owner.authHeader,
      body: {},
    });
    assertEqualOrThrow(repeat.status, 200, 'repeating the deactivation still succeeds');
    assertEqualOrThrow(repeat.data?.changed, false, 'the repeat is an idempotent no-op');
    const activated = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'rated_4_5' },
    });
    assertEqualOrThrow(activated.status, 200, 'profile activates once the manual pack is gone');
    assertEqualOrThrow(activated.data?.pack_id, 'syria-consumption', 'consumption pack installed');
    assertEqualOrThrow(activated.data?.rate, 10, 'rated_4_5 maps to the legal 10% default');
    assertEqualOrThrow(
      JSON.stringify(await activePackIds()),
      JSON.stringify(['syria-consumption']),
      'only the Syria pack is active after the switch',
    );
    assertEqualOrThrow(
      productCategoryId(),
      'establishment-services',
      'products remap to the Syria category on the real switch',
    );
    const feeOrder = await checkout();
    assertEqualOrThrow(feeOrder.tax_amount, 1000, 'consumption fee is 10% of the bill');
    assertEqualOrThrow(feeOrder.total, 11000, 'fee is added on top of the bill');
    const feeBreakdown = (
      typeof feeOrder.tax_breakdown === 'string'
        ? JSON.parse(feeOrder.tax_breakdown || '[]')
        : feeOrder.tax_breakdown || []
    ) as any[];
    assertEqualOrThrow(
      feeBreakdown.some((line) => line.title === 'رسم الإنفاق الاستهلاكي' && line.rate === 10),
      true,
      'breakdown carries the consumption fee line at 10%',
    );

    console.log('\n4. (c) Classification change on the already-active Syria pack still works');
    const reclassified = await api(baseUrl, '/api/tax-packs/syria-profile', {
      method: 'POST',
      headers: owner.authHeader,
      body: { profile: 'consumption', classification: 'rated_2_3' },
    });
    assertEqualOrThrow(reclassified.status, 200, 'reclassification succeeds');
    assertEqualOrThrow(reclassified.data?.rate, 5, 'rated_2_3 maps to 5%');
    const reclassifiedOrder = await checkout();
    assertEqualOrThrow(reclassifiedOrder.tax_amount, 500, 'fee follows the new 5% rate');
    assertEqualOrThrow(reclassifiedOrder.total, 10500, 'total follows the reclassification');

    console.log('\n5. (d) Sibling path: activating a version of another pack is rejected too');
    const manualVersionId = latestVersionId('manual-sy');
    const versionSwitch = await api(
      baseUrl,
      `/api/tax-packs/manual-sy/versions/${manualVersionId}/activate`,
      { method: 'POST', headers: owner.authHeader, body: {} },
    );
    assertEqualOrThrow(
      versionSwitch.status,
      409,
      'version activation over a different active pack is rejected',
    );
    assertEqualOrThrow(
      versionSwitch.data?.code,
      'active_pack_conflict',
      'the version rejection carries the stable error code',
    );
    assertEqualOrThrow(
      versionSwitch.data?.active_pack_id,
      'syria-consumption',
      'the version rejection names the active Syria pack',
    );
    const afterVersionRejection = await checkout();
    assertEqualOrThrow(
      afterVersionRejection.tax_amount,
      500,
      'checkout after the version rejection still uses the Syria 5%',
    );

    console.log('\n6. (d) Sibling path: manual-config over the Syria pack applies completely');
    const resaved = await saveManual('Manual', '5');
    assertEqualOrThrow(resaved.status, 200, 'manual config re-saved over the Syria pack');
    assertEqualOrThrow(
      JSON.stringify(await activePackIds()),
      JSON.stringify(['manual-sy']),
      'only the manual pack is active after the re-save (no stale Syria flag)',
    );
    const manualAgain = await checkout();
    assertEqualOrThrow(manualAgain.tax_amount, 500, 'manual 5% applies at checkout');
    assertEqualOrThrow(manualAgain.total, 10500, 'total follows the re-saved manual rate');

    console.log('\n7. (d) Sibling path: rollback of another pack is rejected, own-pack works');
    const foreignRollback = await api(baseUrl, '/api/tax-packs/syria-consumption/rollback', {
      method: 'POST',
      headers: owner.authHeader,
      body: {},
    });
    assertEqualOrThrow(
      foreignRollback.status,
      409,
      'rolling back a pack that is not the active one is rejected',
    );
    assertEqualOrThrow(
      foreignRollback.data?.code,
      'active_pack_conflict',
      'the rollback rejection carries the stable error code',
    );
    const ownRollback = await api(baseUrl, '/api/tax-packs/manual-sy/rollback', {
      method: 'POST',
      headers: owner.authHeader,
      body: {},
    });
    assertEqualOrThrow(ownRollback.status, 200, 'rolling back the active pack works');
    assertEqualOrThrow(
      JSON.stringify(await activePackIds()),
      JSON.stringify(['manual-sy']),
      'the manual pack stays active after its own rollback',
    );
    const rolledBack = await checkout();
    assertEqualOrThrow(
      rolledBack.tax_amount,
      1000,
      'rollback returns the manual pack to its 10% version',
    );
    assertEqualOrThrow(rolledBack.total, 11000, 'total follows the rolled-back rate');
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
  console.log(`\nTax pack switch atomicity: ${results.passed} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error('Tax pack switch atomicity test crashed:', error);
  process.exit(1);
});
