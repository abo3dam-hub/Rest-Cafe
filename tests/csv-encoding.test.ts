/**
 * CSV/XLSX text-encoding regression tests (Arabic in Excel exports).
 *
 * Root cause pinned here: the export serializers always produced correct
 * UTF-8, but the downloaded .csv files carried no byte-order mark, and
 * Microsoft Excel on Windows decodes downloaded CSVs with the system ANSI
 * code page unless the file starts with the UTF-8 BOM — Arabic names came
 * back as mojibake. The fix prefixes every user-data CSV download with
 * the BOM (reports + menu exports) and makes the menu importer strip a
 * leading BOM so an exported file can be re-imported unchanged.
 *
 * Verified at the file/data level: BOM bytes, exact Arabic strings in CSV
 * text, an export→import round trip, and XLSX cell values read back with
 * ExcelJS (the XLSX path was never corrupt — it stores UTF-8 natively).
 * Excel GUI verification is not performed in this environment.
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-csv-encoding-'));

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
  api,
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
  closeDatabase,
} = require('./helpers/test-setup');
const { menuCsvRoutes } = require('../main/routes/menu-csv');
const { withUtf8Bom, UTF8_BOM } = require('../main/lib/csv');
const {
  serializeDailySalesExportCsv,
  serializeDailySalesExportXlsx,
} = require('../main/services/daily-sales-export-files');
const ExcelJS = require('exceljs');

const ARABIC_NAME = 'قهوة عربية';
const MIXED_NAME = 'شاي أخضر Green Tea';
const ARABIC_CATEGORY = 'مشروبات';

function serializerLevelChecks(): Promise<void> {
  return (async () => {
    // The BOM helper is a pure prefix and never doubles up.
    assertEqualOrThrow(withUtf8Bom('a,b'), `${UTF8_BOM}a,b`, 'withUtf8Bom prefixes the BOM');
    assertEqualOrThrow(withUtf8Bom(`${UTF8_BOM}a,b`), `${UTF8_BOM}a,b`, 'withUtf8Bom is idempotent');
    const bomBytes = Buffer.from(withUtf8Bom('x'), 'utf8');
    assertEqualOrThrow(
      [bomBytes[0], bomBytes[1], bomBytes[2]].join(','),
      '239,187,191',
      'BOM serializes to EF BB BF',
    );

    const dataset = {
      summary: {
        business_date: '2026-10-25',
        timezone: 'Asia/Damascus',
        business_day_start: '00:00',
        currency: 'SYP',
        order_count: 2,
        paid_bill_count: 2,
        gross_collected: 350,
        refunds_issued: 0,
        net_collected: 350,
        tax_total: 0,
        discount_total: 0,
        service_charge_total: 0,
        packaging_charge_total: 0,
        delivery_charge_total: 0,
        known_cost_net_item_sales: 350,
        ingredient_cost_total: null,
        gross_profit_total: null,
        gross_margin_percent: null,
        cost_coverage_status: 'unknown',
        payment_methods: [{ method: 'cash', total: 350 }],
      },
      items: [
        {
          product_id: 'p1',
          product_name: ARABIC_NAME,
          product_sku: null,
          quantity: 2,
          gross_item_sales: 300,
          item_discounts: 0,
          net_item_sales: 300,
          tax_amount: 0,
          ingredient_cost: null,
          profit: null,
          margin_percent: null,
          cost_status: 'unknown',
        },
        {
          product_id: 'p2',
          product_name: MIXED_NAME,
          product_sku: 'TEA-1',
          quantity: 1,
          gross_item_sales: 50,
          item_discounts: 0,
          net_item_sales: 50,
          tax_amount: 0,
          ingredient_cost: null,
          profit: null,
          margin_percent: null,
          cost_status: 'unknown',
        },
      ],
      payments: [
        {
          bill_number: 'B-1',
          order_number: 'ORD-1',
          payment_time: '2026-10-25 12:30:00',
          method: 'cash',
          amount: 350,
          transaction_id: '',
        },
      ],
    };

    // CSV: Arabic (pure and mixed) survives byte-for-byte, numbers and the
    // business date stay intact.
    const itemsCsv = serializeDailySalesExportCsv(dataset, 'items');
    assertIncludesOrThrow(itemsCsv, ARABIC_NAME, 'items CSV keeps pure Arabic product name');
    assertIncludesOrThrow(itemsCsv, MIXED_NAME, 'items CSV keeps mixed Arabic/Latin name');
    assertIncludesOrThrow(itemsCsv, 'p1', 'items CSV keeps product id');
    const summaryCsv = serializeDailySalesExportCsv(dataset, 'summary');
    assertIncludesOrThrow(summaryCsv, 'business_date,2026-10-25', 'summary CSV keeps the date');
    assertIncludesOrThrow(summaryCsv, 'net_collected,350', 'summary CSV keeps numeric totals');

    // XLSX: read back with ExcelJS — cell values equal the source strings.
    const buffer = await serializeDailySalesExportXlsx(dataset as any, { fractionDigits: 0 });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const items = workbook.getWorksheet('Items');
    assertOrThrow(!!items, 'XLSX has an Items sheet');
    assertEqualOrThrow(items.getRow(2).getCell(2).value, ARABIC_NAME, 'XLSX cell keeps Arabic name');
    assertEqualOrThrow(items.getRow(3).getCell(2).value, MIXED_NAME, 'XLSX cell keeps mixed name');
    assertEqualOrThrow(items.getRow(2).getCell(4).value, 2, 'XLSX quantity stays numeric');
    console.log('   ✓ serializers preserve Arabic, mixed text, numbers and dates (CSV + XLSX)');
  })();
}

async function menuRoundTripChecks(): Promise<void> {
  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  seedCategory(db, 'cat-encoding', ARABIC_CATEGORY);

  const app = createApp({ '/api/menu/csv': menuCsvRoutes });
  const { baseUrl, server } = await startServer(app);
  try {
    const header =
      'id,sku,name,category,price,description,cost,tax_category,tax_behavior,cashback_percent,tags,is_active';
    const row = (name: string, price: number) =>
      ['', '', name, ARABIC_CATEGORY, price, '', '', '', '', '', '', 'yes'].join(',');
    const imported = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: { csv: [header, row(ARABIC_NAME, 150), row(MIXED_NAME, 50)].join('\n') },
      headers: authHeader,
    });
    assertEqualOrThrow(imported.status, 200, 'Arabic product import succeeds');
    assertEqualOrThrow(imported.data.created, 2, 'both Arabic products are created');

    const exportRes = await fetch(`${baseUrl}/api/menu/csv/export/products`, {
      headers: authHeader,
    });
    assertEqualOrThrow(exportRes.status, 200, 'products export returns 200');
    const raw = Buffer.from(await exportRes.arrayBuffer());
    assertEqualOrThrow(
      [raw[0], raw[1], raw[2]].join(','),
      '239,187,191',
      'exported file starts with the UTF-8 BOM bytes EF BB BF',
    );
    const exportedText = raw.toString('utf8');
    assertIncludesOrThrow(exportedText, ARABIC_NAME, 'export keeps the Arabic product name');
    assertIncludesOrThrow(exportedText, MIXED_NAME, 'export keeps the mixed product name');
    console.log('   ✓ menu CSV export carries the BOM and exact Arabic names');

    // The exported file (BOM and all) must import back cleanly: the parser
    // strips the BOM instead of welding it onto the first header cell.
    const reimported = await api(baseUrl, '/api/menu/csv/import/products', {
      method: 'POST',
      body: { csv: exportedText },
      headers: authHeader,
    });
    assertEqualOrThrow(reimported.status, 200, 'exported file re-imports without error');
    assertEqualOrThrow(reimported.data.failed, 0, 're-import has no failed rows');
    console.log('   ✓ exported CSV re-imports cleanly (BOM stripped by the parser)');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function main() {
  console.log('🧪 CSV/XLSX encoding tests (Arabic exports)');
  await serializerLevelChecks();
  await menuRoundTripChecks();
  closeDatabase();
  console.log('\n✅ CSV/XLSX encoding tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
