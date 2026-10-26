/**
 * End-to-end Test: Rest&Cafe Syria-Default Flow
 *
 * Walks the first-run path the product actually ships: the setup wizard
 * collects NO country (Rest&Cafe has no country profiles), so onboarding →
 * regional defaults → Arabic demo seed → settings round-trip → customer
 * creation → translation parity must all land on the product's defaults.
 *
 * Verifies that:
 *  - Setup with the real wizard payload (currency/timezone/language only)
 *    persists SYP / SP / Asia/Damascus / Latin digits / Arabic
 *  - settings.country stays empty — there is no country profile to store
 *  - The demo seed is the Arabic one (categories, products, staff, customers)
 *    and the Argentina hamburger menu is NOT seeded
 *  - Settings save/load round-trips the regional defaults unchanged
 *  - The tax engine applies no automatic country tax: without a manually
 *    configured tax category an item is tax-free (tax is Off/Manual only)
 *  - A Syrian customer can be created in international format (+963)
 *  - i18n ar and en catalogues have identical key sets and every t()
 *    reference in the frontend resolves in both
 *  - A country sent in the setup payload is ignored (fresh-DB isolation)
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/e2e-syria-default-flow.test.ts
 */

// ── Electron Mock (must be before any app imports) ───────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
let testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-e2e-sy-'));
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments);
};

const {
  initTestDb, createApp, startServer,
  seedOwnerUser, api, assert, assertEqual,
  getResults, closeDatabase,
} = require('./helpers/test-setup');

const { authRoutes } = require('../main/routes/auth');
const { settingsRoutes } = require('../main/routes/settings');
const { customerRoutes } = require('../main/routes/customers');
const { collectCalledKeys } = require('./helpers/i18n-scanner');

async function main() {
  let server;
  let baseUrl;
  let db;
  try {
    db = initTestDb();
    const app = createApp({
      '/api/auth': authRoutes,
      '/api/settings': settingsRoutes,
      '/api/customers': customerRoutes,
    });
    const started = await startServer(app);
    server = started.server;
    baseUrl = started.baseUrl;

    await runSyriaOnboarding(baseUrl, db);
    await runSyriaSettings(baseUrl, db);
    await runSyriaTaxAndCustomers(baseUrl, db);
    await runSyriaTranslations();
  } finally {
    if (server) server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // Fresh DB: a foreign country in the payload must not create a profile.
  await runCountryIgnoredInIsolation();

  const { passed, failed, total } = getResults();
  console.log('\n' + '='.repeat(60));
  console.log(`${passed}/${total} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

async function runCountryIgnoredInIsolation() {
  console.log('\n5. Isolation: a country in the setup payload is ignored');
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-e2e-sy-iso-'));
  const db = initTestDb();
  const app = createApp({ '/api/auth': authRoutes });
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await api(baseUrl + '/api', '/auth/setup/initialize', {
      method: 'POST',
      body: {
        name: 'Owner',
        email: 'iso-owner@test.local',
        password: 'Test1234',
        business_type: 'restaurant',
        business_name: 'Isolation Shop',
        setup_profile: 'demo',
        service_model: 'finedine',
        country: 'MA',
        language: 'ar',
        terms_accepted: true,
        owner_approval_pin: '5678',
        owner_approval_pin_confirmation: '5678',
      },
    });
    assertEqual(res.status, 200, 'setup/initialize returns 200 when a country is sent');
    assertEqual(res.data.tenant.country, '', 'tenant.country stays empty — no profile is created');
    assertEqual(res.data.tenant.currency, 'SYP', 'currency falls back to the SYP default');
    assertEqual(res.data.tenant.timezone, 'Asia/Damascus', 'timezone falls back to Asia/Damascus');
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'country'").get();
    assertEqual(stored.value, '', 'settings.country stays empty');
    const customers = db.prepare('SELECT COUNT(*) AS c FROM customers').get();
    assertEqual(customers.c, 3, 'demo seed still runs with the regional default');
  } finally {
    server.close();
    closeDatabase();
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

async function runSyriaOnboarding(baseUrl, db) {
  console.log('\n1. Onboarding with the shipped wizard payload (no country)');
  const res = await api(baseUrl + '/api', '/auth/setup/initialize', {
    method: 'POST',
    body: {
      name: 'علي المالك',
      email: 'sy-owner@test.local',
      password: 'Test1234',
      business_type: 'restaurant',
      business_name: 'Damascus Eats',
      setup_profile: 'demo',
      service_model: 'finedine',
      currency: 'SYP',
      timezone: 'Asia/Damascus',
      language: 'ar',
      terms_accepted: true,
      owner_approval_pin: '5678',
      owner_approval_pin_confirmation: '5678',
    },
  });

  assertEqual(res.status, 200, 'setup/initialize returns 200');
  const tenant = res.data.tenant;
  assertEqual(tenant.country, '', 'tenant.country is empty (no country profiles)');
  assertEqual(tenant.currency, 'SYP', 'tenant.currency = SYP');
  assertEqual(tenant.currency_symbol, 'SP', 'tenant.currency_symbol = SP');
  assertEqual(tenant.timezone, 'Asia/Damascus', 'tenant.timezone = Asia/Damascus');
  assertEqual(tenant.language, 'ar', 'tenant.language = ar');
  assertEqual(tenant.number_digits, 'latin', 'tenant.number_digits = latin');
  assertEqual(tenant.currency_fraction_digits, 0, 'amounts are whole (0 fraction digits)');

  const curSymbol = db.prepare("SELECT value FROM settings WHERE key = 'currency_symbol'").get();
  assertEqual(curSymbol.value, 'SP', 'DB currency_symbol = SP for SYP');
  const storedCountry = db.prepare("SELECT value FROM settings WHERE key = 'country'").get();
  assertEqual(storedCountry.value, '', 'DB settings.country stays empty');

  const arabicDish = db.prepare("SELECT name FROM products WHERE id = 'prod-demo-butter-chicken'").get();
  assertEqual(arabicDish.name, 'دجاج بالزبدة', 'demo menu is seeded in Arabic');
  const burger = db.prepare("SELECT id FROM products WHERE id = 'prod-demo-hamburguesa-clasica'").get();
  assert(!burger, 'Argentina demo menu is NOT seeded');

  const firstCustomer = db.prepare("SELECT name FROM customers WHERE id = 'cust-demo-1'").get();
  assertEqual(firstCustomer.name, 'علي حسن', 'demo customers are the Arabic sample set');
  const customerCount = db.prepare('SELECT COUNT(*) AS c FROM customers').get();
  assertEqual(customerCount.c, 3, 'demo seed creates 3 customers');

  const staffName = db.prepare("SELECT name FROM users WHERE id = 'user-demo-manager'").get();
  assertEqual(staffName.name, 'مدير تجريبي', 'demo staff localized to ar');

  const category = db.prepare("SELECT name FROM categories WHERE id = 'cat-demo-main'").get();
  assertEqual(category.name, 'الأطباق الرئيسية', 'demo category localized to ar');

  const tables = db.prepare('SELECT COUNT(*) AS c FROM tables').get();
  assertEqual(tables.c, 4, 'FineDine demo seeds 4 tables');
}

async function runSyriaSettings(baseUrl, db) {
  console.log('\n2. Settings save/load round-trip preserves the regional defaults');
  const { authHeader } = seedOwnerUser(db);

  const getRes = await api(baseUrl + '/api', '/settings/business', { headers: authHeader });
  assertEqual(getRes.status, 200, 'GET /settings/business returns 200');
  assertEqual(getRes.data.country, '', 'GET returns country = (empty)');
  assertEqual(getRes.data.currency, 'SYP', 'GET returns currency = SYP');
  assertEqual(getRes.data.currency_symbol, 'SP', 'GET returns currency_symbol = SP');
  assertEqual(getRes.data.timezone, 'Asia/Damascus', 'GET returns timezone = Asia/Damascus');

  const putRes = await api(baseUrl + '/api', '/settings/business', {
    method: 'PUT',
    headers: authHeader,
    body: {
      business_name: 'Damascus Eats E2E',
      country: '',
      timezone: 'Asia/Damascus',
      currency: 'SYP',
    },
  });
  assertEqual(putRes.status, 200, 'PUT /settings/business returns 200');
  assertEqual(putRes.data.currency, 'SYP', 'PUT preserves currency = SYP');

  const verify = await api(baseUrl + '/api', '/settings/business', { headers: authHeader });
  assertEqual(verify.data.business_name, 'Damascus Eats E2E', 'business_name persisted');
  assertEqual(verify.data.timezone, 'Asia/Damascus', 'timezone persisted');
}

async function runSyriaTaxAndCustomers(baseUrl, db) {
  console.log('\n3. Manual-tax posture and Syrian customer creation');
  const { authHeader } = seedOwnerUser(db);

  const storedCountry = db.prepare("SELECT value FROM settings WHERE key = 'country'").get();
  assertEqual(storedCountry.value, '', 'settings.country is empty after first-run setup');

  // No country fiscal plug-in exists in this product: an item without a
  // manually configured tax category is tax-free even with taxes enabled.
  const { calculateItemTax } = require('../main/services/tax');
  for (const country of ['', 'SY']) {
    const result = calculateItemTax(
      { country, business_type: 'restaurant', state_code: '', taxes_enabled: true },
      { tax_type: 'inclusive', tax_rate: 10 },
      100,
      null,
    );
    assertEqual(result.tax_amount, 0, `uncategorized item is tax-free (country='${country}')`);
    assertEqual(result.tax_breakdown.length, 0, `no automatic tax breakdown (country='${country}')`);
  }

  const cRes = await api(baseUrl + '/api', '/customers', {
    method: 'POST',
    headers: authHeader,
    body: { name: 'زبون سوري', phone: '+963991234567', country_code: '+963' },
  });
  assertEqual(cRes.status, 201, 'customer created with a +963 number');
  assertEqual(cRes.data.customer.country_code, '+963', 'new customer has +963 stored');
  assertEqual(cRes.data.customer.phone, '+963991234567', 'phone stored in E.164 form');
}

async function runSyriaTranslations() {
  console.log('\n4. i18n ar/en catalogues match and every t() reference resolves');
  const i18nDir = path.join(__dirname, '../frontend/src/lib/i18n/messages');
  const arSrc = fs.readFileSync(path.join(i18nDir, 'ar.json'), 'utf8');
  const enSrc = fs.readFileSync(path.join(i18nDir, 'en.json'), 'utf8');

  const arKeys = extractJsonKeys(arSrc);
  const enKeys = extractJsonKeys(enSrc);
  assert(arKeys.size > 0 && enKeys.size > 0, 'i18n defines both ar and en blocks');
  if (arKeys.size === 0 || enKeys.size === 0) return;

  assertEqual(arKeys.size, enKeys.size, `ar and en have the same number of keys (ar=${arKeys.size}, en=${enKeys.size})`);
  const missingInAr = [...enKeys].filter((k) => !arKeys.has(k));
  const missingInEn = [...arKeys].filter((k) => !enKeys.has(k));
  assertEqual(missingInAr.length, 0, `ar is missing keys: ${missingInAr.join(', ') || 'none'}`);
  assertEqual(missingInEn.length, 0, `en is missing keys: ${missingInEn.join(', ') || 'none'}`);

  assert(arSrc.includes('الإعدادات'), 'ar catalogue carries the Arabic UI strings');

  // Walk the entire frontend src tree and assert every `t('key')` reference
  // resolves in both shipped catalogues (ar + en are the selectable pair).
  const referenced = collectCalledKeys(path.join(__dirname, '../frontend/src'));
  console.log(`    found ${referenced.size} unique t() keys referenced in frontend`);
  assert(referenced.size >= 20, `at least 20 translation keys should be wired in (found ${referenced.size})`);
  const unknownAr = [...referenced].filter((k) => !arKeys.has(k));
  assertEqual(unknownAr.length, 0, `t() calls reference keys missing in ar: ${unknownAr.join(', ') || 'none'}`);
  const unknownEn = [...referenced].filter((k) => !enKeys.has(k));
  assertEqual(unknownEn.length, 0, `t() calls reference keys missing in en: ${unknownEn.join(', ') || 'none'}`);
}

function extractJsonKeys(jsonSrc) {
  const keys = new Set();
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      const full = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, full);
      else keys.add(full);
    }
  };
  walk(JSON.parse(jsonSrc), '');
  return keys;
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
