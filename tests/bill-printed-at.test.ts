/**
 * bills.printed_at semantics (assignment 037, Delivery 5: F-026).
 *
 * printed_at means confirmed dispatch, never a print request: the durable
 * print queue sets it only after a receipt retry dispatch succeeds (and
 * records the dispatch warnings with the bill), and the operator
 * attestation endpoint requires an explicit { confirmed: true } instead of
 * marking on a bare request. A failed dispatch leaves printed_at unset.
 *
 * Run: npm run test:bill-printed-at
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Mock electron before importing any app modules
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-bill-printed-at-'));
const mockApp = { isPackaged: true, getPath: (_name: string) => testDir, getVersion: () => 'test' };
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-key-for-tests-only';

const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { enqueuePrintJob, processDuePrintJobs } = require('../main/services/print-queue');
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
       VALUES ('ORD-BPA-1', 'dine_in', 100, 0, 100, 'pending', ?, ?)`,
    )
    .run(stamp, stamp).lastInsertRowid,
);
db.prepare(
  `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
   VALUES (?, 'prod-1', 'Espresso', 100, 1, 100, 100, 'pending', ?, ?)`,
).run(orderId, stamp, stamp);

function makeBill(number: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO bills (bill_number, order_id, subtotal, total, payment_status, created_at, updated_at)
         VALUES (?, ?, 100, 100, 'unpaid', ?, ?)`,
      )
      .run(number, orderId, stamp, stamp).lastInsertRowid,
  );
}

function printedAt(billId: number): string | null {
  return (
    (db.prepare('SELECT printed_at FROM bills WHERE id = ?').get(billId) as any)?.printed_at ?? null
  );
}

function jobRow(id: number): any {
  return db.prepare('SELECT * FROM print_jobs WHERE id = ?').get(id);
}

/** Makes a job due right now so the worker will claim it. */
function makeDue(id: number): void {
  db.prepare(`UPDATE print_jobs SET next_retry_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace(/\..*$/, ''),
    id,
  );
}

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

async function main(): Promise<void> {
  // ── Queue: success marks printed_at and records the dispatch warnings ──
  const successBillId = makeBill('B-BPA-OK');
  assertEqualOrThrow(printedAt(successBillId), null, 'F-026: printed_at starts unset');
  const stubWarnings = [
    {
      field: 'items',
      text: 'قهوة عربية',
      message: 'Line not representable on this printer',
      kind: 'line',
    },
  ];
  const stubDispatchBill = async (_db: any, _opts: any) => ({ ok: true, warnings: stubWarnings });
  const { id: okJobId } = enqueuePrintJob(db, {
    kind: 'receipt',
    orderId,
    billId: successBillId,
    payload: { isReprint: false },
  });
  makeDue(okJobId);
  const pass = await processDuePrintJobs({ dispatchBill: stubDispatchBill });
  assertEqualOrThrow(pass.succeeded, 1, 'F-026: the receipt job succeeds with a stub dispatcher');
  assertEqualOrThrow(jobRow(okJobId).status, 'done', 'F-026: the receipt job is done');
  assertOrThrow(
    !!printedAt(successBillId),
    'F-026: printed_at is set after the queue dispatch succeeds',
  );
  const recorded = db
    .prepare('SELECT * FROM bill_print_warnings WHERE bill_id = ?')
    .get(successBillId) as any;
  assertOrThrow(!!recorded, 'F-026: the dispatch warning is recorded with the bill');
  assertEqualOrThrow(recorded.source, 'queue', 'F-026: the queue warning names its source');
  assertEqualOrThrow(recorded.print_log_id, null, 'F-026: the queue record has no print_logs row');
  assertEqualOrThrow(
    Number(
      (
        db.prepare('SELECT COUNT(*) AS n FROM print_logs WHERE bill_id = ?').get(successBillId) as {
          n: number;
        }
      ).n,
    ),
    0,
    'F-026: the queue path writes no print_logs row (no user on that path)',
  );

  // ── Queue: failure leaves printed_at unset ──
  const failBillId = makeBill('B-BPA-FAIL');
  const failingDispatchBill = async (_db: any, _opts: any) => ({ ok: false, detail: 'no paper' });
  const { id: failJobId } = enqueuePrintJob(db, {
    kind: 'receipt',
    orderId,
    billId: failBillId,
    payload: { isReprint: false },
  });
  makeDue(failJobId);
  const failPass = await processDuePrintJobs({ dispatchBill: failingDispatchBill });
  assertEqualOrThrow(failPass.failed, 1, 'F-026: the failing receipt job is counted failed');
  assertEqualOrThrow(
    printedAt(failBillId),
    null,
    'F-026: printed_at stays unset after a failed dispatch',
  );

  // ── markPrinted: a bare request no longer marks ──
  const attestBillId = makeBill('B-BPA-ATTEST');
  const bare = await request(app)
    .post(`/api/bills/${attestBillId}/markPrinted`)
    .set('Authorization', authHeader)
    .send({});
  assertEqualOrThrow(bare.status, 400, 'F-026: markPrinted without confirmed is rejected');
  assertEqualOrThrow(
    printedAt(attestBillId),
    null,
    'F-026: a rejected attestation leaves printed_at unset',
  );

  const attested = await request(app)
    .post(`/api/bills/${attestBillId}/markPrinted`)
    .set('Authorization', authHeader)
    .send({ confirmed: true });
  assertEqualOrThrow(attested.status, 200, 'F-026: markPrinted with confirmed:true succeeds');
  assertOrThrow(!!printedAt(attestBillId), 'F-026: an attested print sets printed_at');

  // ── POST /print still records a confirmed print ──
  const confirmBillId = makeBill('B-BPA-CONFIRM');
  const confirmed = await request(app)
    .post(`/api/bills/${confirmBillId}/print`)
    .set('Authorization', authHeader)
    .send({ print_type: 'receipt' });
  assertEqualOrThrow(confirmed.status, 200, 'F-026: POST /print still succeeds');
  assertOrThrow(!!printedAt(confirmBillId), 'F-026: POST /print sets printed_at');

  closeDatabase();
  const results = getResults();
  console.log(`\nResults: ${results.passed}/${results.total} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
