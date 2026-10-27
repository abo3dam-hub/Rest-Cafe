/**
 * Regression coverage for two field reports from a Syria-configured install
 * (settings.country = '', generic local tax pack, business type restaurant):
 *
 * 1. Saving a product that carries a tax_category_id failed with
 *    "No configured tax categories are available for country  and business
 *    type restaurant" — the generic pack configures no tax rules, so the
 *    membership check could never pass and it blocked unrelated edits such
 *    as entering a cost. The validators now skip membership checks when the
 *    active pack configures no categories, and stay strict when it does.
 *
 * 2. The products CSV import failed every row whose category did not already
 *    exist ("import categories first"), so the app's own menu template —
 *    items together with their category names — could not be imported in
 *    one pass. The products import now creates missing categories on the
 *    spot (the addons import already created missing groups the same way)
 *    and reports them as categories_created.
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-product-tax-csv-'));

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
  api,
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const { productRoutes } = require('../main/routes/products');
const { addonGroupRoutes } = require('../main/routes/addon-groups');
const { menuCsvRoutes } = require('../main/routes/menu-csv');
const { getActiveCountryPack, hasConfiguredTaxCategories } = require('../main/services/tax');

function setSetting(db: any, key: string, value: string) {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

function setAliSettings(db: any) {
  setSetting(db, 'country', '');
  setSetting(db, 'currency', 'SYP');
  setSetting(db, 'currency_symbol', 'SP');
  setSetting(db, 'timezone', 'Asia/Damascus');
  setSetting(db, 'business_type', 'restaurant');
  setSetting(db, 'taxes_enabled', 'false');
}

const PRODUCT_HEADER =
  'id,sku,name,category,price,description,cost,tax_category,tax_behavior,cashback_percent,tags,is_active,flo_csv_encoding';

async function main() {
  console.log('Integration Test: product tax-category validation + menu CSV categories');
  console.log('='.repeat(72));

  const db = initTestDb();
  setAliSettings(db);
  const { authHeader } = seedOwnerUser(db);

  const app = createApp({
    '/api/products': productRoutes,
    '/api/addon-groups': addonGroupRoutes,
    '/api/menu-csv': menuCsvRoutes,
  });
  const { baseUrl, server } = await startServer(app);

  try {
    console.log('\n─── Tax category: unconfigured generic pack (shipped Syria config) ───');
    assertEqualOrThrow(
      hasConfiguredTaxCategories(getActiveCountryPack(''), 'restaurant'),
      false,
      'generic pack configures no tax categories for restaurant (precondition)',
    );

    const created = await api(baseUrl, '/api/products', {
      method: 'POST',
      body: { name: 'Cost With Category', price: 20000, cost_price: 12000, tax_category_id: 'standard' },
      headers: authHeader,
    });
    assertEqualOrThrow(created.status, 201, 'create with cost + tax_category_id succeeds');
    assertEqualOrThrow(created.data.product.cost, 12000, 'cost is stored on create');
    assertEqualOrThrow(
      created.data.product.tax_category_id,
      'standard',
      'tax_category_id is stored verbatim',
    );

    db.prepare(
      `INSERT INTO products (id, name, price, cost, tax_category_id, tax_behavior, is_active, created_at, updated_at)
       VALUES ('prod-stored-tax', 'Stored Tax Product', 20000, 0, 'standard', 'country_default', 1, datetime('now'), datetime('now'))`,
    ).run();
    const edited = await api(baseUrl, '/api/products/prod-stored-tax', {
      method: 'PUT',
      body: {
        name: 'Stored Tax Product',
        price: 20000,
        cost_price: 9000,
        tax_category_id: 'standard',
        tax_behavior: 'country_default',
      },
      headers: authHeader,
    });
    assertEqualOrThrow(edited.status, 200, 'edit of a product with a stored category succeeds');
    assertEqualOrThrow(edited.data.product.cost, 9000, 'cost edit is applied');
    assertEqualOrThrow(
      edited.data.product.tax_category_id,
      'standard',
      'stored category survives the edit',
    );

    const badType = await api(baseUrl, '/api/products', {
      method: 'POST',
      body: { name: 'Bad Category Type', price: 1000, tax_category_id: 123 },
      headers: authHeader,
    });
    assertEqualOrThrow(badType.status, 400, 'non-string tax_category_id is still rejected');
    assertIncludesOrThrow(
      String(badType.data.error),
      'tax_category_id must be a string or null',
      'non-string tax_category_id keeps its specific error',
    );

    const group = await api(baseUrl, '/api/addon-groups', {
      method: 'POST',
      body: {
        name: 'Extras',
        addons: [{ name: 'Extra cheese', price: 3000, tax_category_id: 'standard' }],
      },
      headers: authHeader,
    });
    assertOrThrow(
      group.status === 201 || group.status === 200,
      `addon group carrying a tax_category_id saves (got ${group.status}: ${JSON.stringify(group.data)})`,
    );

    console.log('\n─── Tax category: configured pack stays strict ───');
    // The fork bundles only the generic pack, so install a synthetic pack
    // with a real restaurant rule straight into the pack tables — the same
    // rows the signed-pack install flow writes.
    const configuredPack = {
      id: 'test-configured-pack',
      publisher: 'test',
      country: 'XX',
      jurisdiction: 'XX',
      categories: [{ id: 'std', label: 'Standard', ruleIds: ['r1'] }],
      rules: [{ id: 'r1', conditions: { businessTypes: ['restaurant'] } }],
      defaultCategories: { product: 'std' },
      unclassifiedCategoryId: 'std',
    };
    db.prepare(
      `INSERT INTO country_packs (id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at)
       VALUES ('test-configured-pack', 'test', 'XX', 'XX', 'test-configured-pack-v1', 'active', datetime('now'), datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO country_pack_versions (id, pack_id, version, schema_version, manifest_json, pack_json, digest, signature, effective_from, effective_to, min_flo_version, published_at, status, created_at)
       VALUES ('test-configured-pack-v1', 'test-configured-pack', '1.0.0', 1, '{}', ?, 'test', NULL, '2026-01-01', NULL, '1.0.0', '2026-01-01', 'active', datetime('now'))`,
    ).run(JSON.stringify(configuredPack));
    setSetting(db, 'country', 'XX');
    assertEqualOrThrow(
      hasConfiguredTaxCategories(getActiveCountryPack('XX'), 'restaurant'),
      true,
      'synthetic pack configures tax categories for restaurant (precondition)',
    );
    const bogus = await api(baseUrl, '/api/products', {
      method: 'POST',
      body: { name: 'Bogus Category', price: 1000, tax_category_id: 'bogus-xyz' },
      headers: authHeader,
    });
    assertEqualOrThrow(bogus.status, 400, 'unknown category is rejected under a configured pack');
    assertIncludesOrThrow(
      String(bogus.data.error),
      'Unknown tax_category_id "bogus-xyz" for country XX',
      'unknown category keeps its specific error under a configured pack',
    );
    const validConfigured = await api(baseUrl, '/api/products', {
      method: 'POST',
      body: { name: 'Valid Configured Category', price: 1000, tax_category_id: 'std' },
      headers: authHeader,
    });
    assertEqualOrThrow(validConfigured.status, 201, 'a category from the configured pack is accepted');
    setAliSettings(db);

    console.log('\n─── Menu CSV: missing categories are created, not fatal ───');
    const aliShaped = [
      PRODUCT_HEADER,
      ',,Item One,Hot Drinks,20000,,,,,,,yes,',
      ',,Item Two,Hot Drinks,25000,,,,,,,yes,',
      ',,Item One,Hot Drinks,20000,,,,,,,yes,',
      ',,Main One,Main Dishes,40000,,,,,,,yes,',
    ].join('\r\n');
    const imported = await api(baseUrl, '/api/menu-csv/import/products', {
      method: 'POST',
      body: { csv: aliShaped },
      headers: authHeader,
    });
    assertEqualOrThrow(imported.status, 200, 'products import responds 200');
    assertEqualOrThrow(imported.data.failed, 0, 'no row fails for a missing category');
    assertEqualOrThrow(imported.data.categories_created, 2, 'both missing categories are created');
    assertEqualOrThrow(imported.data.created, 3, 'distinct products are created');
    assertEqualOrThrow(imported.data.skipped, 1, 'exact duplicate row is skipped, not failed');
    const hotDrinks = db
      .prepare('SELECT COUNT(*) AS n FROM categories WHERE name = ? AND deleted_at IS NULL')
      .get('Hot Drinks') as any;
    assertEqualOrThrow(hotDrinks.n, 1, 'auto-created category exists exactly once');

    const reimported = await api(baseUrl, '/api/menu-csv/import/products', {
      method: 'POST',
      body: { csv: aliShaped },
      headers: authHeader,
    });
    assertEqualOrThrow(reimported.data.categories_created, 0, 're-import creates no categories');
    assertEqualOrThrow(reimported.data.created, 0, 're-import creates no products');
    assertEqualOrThrow(reimported.data.skipped, 4, 're-import skips every row as a duplicate');

    console.log('\n─── Menu CSV: corrected UTF-8 Arabic file imports cleanly ───');
    const arabicCsv = [
      PRODUCT_HEADER,
      ',,قهوة عربية,مشروبات ساخنة,20000,,12000,,,,,yes,',
      ',,منسف,وجبات رئيسية,40000,,25000,,,,,yes,',
    ].join('\r\n');
    const arabic = await api(baseUrl, '/api/menu-csv/import/products', {
      method: 'POST',
      body: { csv: arabicCsv },
      headers: authHeader,
    });
    assertEqualOrThrow(arabic.data.failed, 0, 'Arabic rows do not fail');
    assertEqualOrThrow(arabic.data.created, 2, 'Arabic products are created');
    assertEqualOrThrow(arabic.data.categories_created, 2, 'Arabic categories are created');
    const coffee = db.prepare('SELECT cost FROM products WHERE name = ?').get('قهوة عربية') as any;
    assertEqualOrThrow(coffee.cost, 12000, 'Arabic product keeps its imported cost');

    console.log('\n─── Menu CSV: a bad row still fails per-row without killing the file ───');
    const mixedCsv = [
      PRODUCT_HEADER,
      ',,Good Row,Hot Drinks,10000,,,,,,,yes,',
      ',,Bad Row,Hot Drinks,not-a-price,,,,,,,yes,',
    ].join('\n');
    const mixed = await api(baseUrl, '/api/menu-csv/import/products', {
      method: 'POST',
      body: { csv: mixedCsv },
      headers: authHeader,
    });
    assertEqualOrThrow(mixed.data.created, 1, 'good row in a mixed file is created');
    assertEqualOrThrow(mixed.data.failed, 1, 'bad row in a mixed file fails');
    assertIncludesOrThrow(
      String((mixed.data.errors || [])[0]),
      'Row 3 (Bad Row)',
      'bad row error names its row',
    );

    console.log('\n─── Menu CSV: the actual field file (destroyed names) ───');
    const aliFile = path.join(
      process.env.HOME || '',
      'workspace/user/files/products-template_1_nt2e.csv',
    );
    if (fs.existsSync(aliFile)) {
      const aliCsv = fs.readFileSync(aliFile, 'utf8');
      const result = await api(baseUrl, '/api/menu-csv/import/products', {
        method: 'POST',
        body: { csv: aliCsv },
        headers: authHeader,
      });
      assertEqualOrThrow(result.status, 200, 'field file import responds 200');
      assertEqualOrThrow(result.data.failed, 0, 'field file has no failed rows');
      assertEqualOrThrow(
        result.data.created + result.data.skipped,
        110,
        'field file rows are all created or duplicate-skipped',
      );
      assertEqualOrThrow(
        result.data.categories_created,
        8,
        'field file categories are created on the spot',
      );
    } else {
      console.log('  (field file not present; skipped)');
    }

    console.log('\nAll product tax-category + menu CSV assertions passed.');
  } finally {
    server.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('TEST CRASHED:', err);
  process.exit(1);
});
