/**
 * Bill print warnings (assignment 037, Delivery 5: F-017).
 *
 * A non-financial line the printer cannot represent must not vanish with
 * only a toast: merchant templates rasterize through the classic pipeline,
 * and where a line truly cannot print the warning is recorded with the
 * bill (POST /bills/:id/print stores it; GET /bills/:id/print-history
 * returns it). Pack templates have no document lines or financial-line
 * groups, so they stay raster-off and rely on the record alone.
 *
 * Run: npm run test:bill-print-warnings
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Mock electron before importing any app modules
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-bill-print-warnings-'));
const mockApp = { isPackaged: true, getPath: (_name: string) => testDir, getVersion: () => 'test' };
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-key-for-tests-only';

const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { receiptDocumentLines } = require('../main/printers/raster-documents');
const { getOrderWithItems } = require('../main/routes/bills');
const {
  createMerchantPrintTemplate,
  activateMerchantPrintTemplate,
} = require('../main/services/merchant-print-templates');
const { serializeBillTemplateSelection } = require('../main/services/print-templates');
const { LATIN_THERMAL_CAPABILITIES } = require('../shared/print/thermal-capabilities');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const { getJWTSecret } = require('../main/routes/auth');
const { billRoutes } = require('../main/routes/bills');

try {
  initDatabase();
} catch (error: any) {
  if (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  ) {
    console.log('  ⚠ Skipping: better-sqlite3 ABI mismatch (run via Electron)');
    process.exit(77);
  }
  console.error('Failed to initialize database:', error.message);
  process.exit(1);
}

const db = getDatabase();
db.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('country', 'IN')");
db.exec(
  "INSERT OR IGNORE INTO users (id, name, password, role) VALUES ('user-1', 'Test User', 'hash', 'cashier')",
);

const stamp = now();
const orderId = Number(
  db
    .prepare(
      `INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
       VALUES ('ORD-BPW-1', 'dine_in', 100, 0, 100, 'pending', ?, ?)`,
    )
    .run(stamp, stamp).lastInsertRowid,
);
const itemId = Number(
  db
    .prepare(
      `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
       VALUES (?, 'prod-arabic', 'قهوة عربية', 100, 1, 100, 100, 'pending', ?, ?)`,
    )
    .run(orderId, stamp, stamp).lastInsertRowid,
);
const billId = Number(
  db
    .prepare(
      `INSERT INTO bills (bill_number, order_id, subtotal, total, payment_status, created_at, updated_at)
       VALUES ('B-BPW-1', ?, 100, 100, 'unpaid', ?, ?)`,
    )
    .run(orderId, stamp, stamp).lastInsertRowid,
);
db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (?, ?, 1)').run(
  billId,
  itemId,
);

// ── Express app for supertest (same shape as tests/bills-print-api.test.ts) ──
const app = express();
app.use(express.json());
app.use((req: any, res: any, next: any) => {
  if (!req.path.startsWith('/api')) {
    next();
    return;
  }
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    req.user = jwt.verify(authHeader.split(' ')[1], getJWTSecret());
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});
app.use('/api/bills', billRoutes);
const token = jwt.sign(
  { userId: 'user-1', email: 'test@flo.local', role: 'cashier' },
  getJWTSecret(),
  { expiresIn: '1h' },
);
const authHeader = `Bearer ${token}`;

const warningCount = () =>
  Number(
    (
      db.prepare('SELECT COUNT(*) AS n FROM bill_print_warnings WHERE bill_id = ?').get(billId) as {
        n: number;
      }
    ).n,
  );

async function main(): Promise<void> {
  // ── Migration v124: the warnings table exists on a fresh DB ──
  {
    const table = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'bill_print_warnings'`,
      )
      .get() as { name: string } | undefined;
    assertOrThrow(!!table, 'v124: bill_print_warnings table exists');
    const index = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_bill_print_warnings_bill'`,
      )
      .get() as { name: string } | undefined;
    assertOrThrow(!!index, 'v124: idx_bill_print_warnings_bill index exists');
  }

  // ── Warnings travel with the confirmation and come back in history ──
  const warnings = [
    {
      field: 'items',
      text: 'قهوة عربية',
      message: 'Line not representable on this printer',
      kind: 'line',
    },
  ];
  const confirm = await request(app)
    .post(`/api/bills/${billId}/print`)
    .set('Authorization', authHeader)
    .send({ print_type: 'receipt', warnings });
  assertEqualOrThrow(confirm.status, 200, 'F-017: confirming a print with warnings succeeds');
  assertEqualOrThrow(warningCount(), 1, 'F-017: the warning is recorded with the bill');
  const stored = db
    .prepare('SELECT * FROM bill_print_warnings WHERE bill_id = ?')
    .get(billId) as any;
  assertEqualOrThrow(
    stored.text,
    'قهوة عربية',
    'F-017: the recorded warning keeps the dropped line',
  );
  assertEqualOrThrow(stored.source, 'frontend', 'F-017: the recorded warning names its source');
  assertOrThrow(
    stored.print_log_id === Number(confirm.body.printLogId),
    'F-017: the warning is linked to the print log row',
  );
  const bill = db.prepare('SELECT printed_at FROM bills WHERE id = ?').get(billId) as any;
  assertOrThrow(!!bill.printed_at, 'F-017: the confirmation still sets printed_at');

  const history = await request(app)
    .get(`/api/bills/${billId}/print-history`)
    .set('Authorization', authHeader);
  assertEqualOrThrow(history.status, 200, 'F-017: print history loads');
  assertEqualOrThrow(
    history.body.prints[0]?.warnings?.length,
    1,
    'F-017: print history carries the recorded warning on its print row',
  );
  assertEqualOrThrow(
    history.body.prints[0]?.warnings?.[0]?.text,
    'قهوة عربية',
    'F-017: the history warning keeps the dropped line',
  );

  // A confirmation with no warnings records none.
  const clean = await request(app)
    .post(`/api/bills/${billId}/print`)
    .set('Authorization', authHeader)
    .send({ print_type: 'reprint' });
  assertEqualOrThrow(clean.status, 200, 'F-017: confirming a print without warnings succeeds');
  assertEqualOrThrow(warningCount(), 1, 'F-017: a clean confirmation adds no warning row');

  // ── Merchant templates produce a raster document; pack templates do not ──
  const golden = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, 'fixtures/merchant-templates/golden-receipt-v1.json'),
      'utf8',
    ),
  );
  const template = createMerchantPrintTemplate({ name: 'F-017 test', payload: golden }, null);
  activateMerchantPrintTemplate(template.id, null);
  const order = getOrderWithItems(db, orderId, billId);
  const billRow = db.prepare('SELECT * FROM bills WHERE id = ?').get(billId);
  const business = {
    name: 'Store',
    address: '',
    phone: '',
    taxRegistrationNumber: '',
    country: 'SY',
    currency: 'SYP',
  };
  const rasterCaps = {
    ...LATIN_THERMAL_CAPABILITIES,
    raster: { enabled: true, widthDots: 576, maxBandHeight: 255, modes: ['mixed'] },
  };
  const merchantDocument = receiptDocumentLines(
    order,
    billRow,
    business,
    serializeBillTemplateSelection({ source: 'merchant', id: template.id }),
    48,
    false,
    false,
    false,
    'en',
    undefined,
    'full',
    rasterCaps,
  );
  assertOrThrow(!!merchantDocument, 'F-017: a merchant template returns a raster document');
  assertOrThrow(
    merchantDocument.lines.join(' ').includes('قهوة عربية'),
    'F-017: the merchant document keeps the full Arabic product name',
  );
  assertOrThrow(
    (merchantDocument.rasterGroups?.length ?? 0) > 0,
    'F-017: the merchant document carries financial-line groups, so fail-closed still holds',
  );

  const packDocument = receiptDocumentLines(
    order,
    billRow,
    business,
    serializeBillTemplateSelection({ source: 'pack', id: 'in-pack-receipt' }),
    48,
    false,
    false,
    false,
    'en',
    undefined,
    'full',
    rasterCaps,
  );
  assertEqualOrThrow(
    packDocument,
    null,
    'F-017: a pack template still returns no raster document (no lines, no groups)',
  );

  closeDatabase();
  const results = getResults();
  console.log(`\nResults: ${results.passed}/${results.total} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
