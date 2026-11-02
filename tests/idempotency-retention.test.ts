/**
 * Idempotency retention (assignment 037, Delivery 6: F-033).
 *
 * Keyed order/payment/refund records accumulate one row per key forever;
 * a startup job prunes records older than the retention window (90 days).
 * Replay inside the window is untouched: the exact SELECTs the payment,
 * order, and refund handlers run must still find the stored response.
 *
 * Run: npm run test:idempotency-retention
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Mock electron before importing any app modules
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-idempotency-retention-'));
const mockApp = { isPackaged: true, getPath: (_name: string) => testDir, getVersion: () => 'test' };
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');
const {
  initDatabase,
  getDatabase,
  closeDatabase,
  now,
  pruneIdempotencyRecords,
  IDEMPOTENCY_RETENTION_DAYS,
} = require('../main/db');

/** A `now()`-format timestamp N days in the past. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\..*$/, '');
}

async function main() {
  console.log('Testing idempotency retention (F-033)...');
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
    throw error;
  }

  assertEqualOrThrow(IDEMPOTENCY_RETENTION_DAYS, 90, 'F-033: the retention window is 90 days');

  const db = getDatabase();
  const userId = 'retention-user';
  const billId = 'retention-bill';

  // ── Seed each table with a recent row, a just-inside-window row, and two expired rows ──
  const seedPayment = db.prepare(`
    INSERT INTO payment_idempotency (user_id, idempotency_key, bill_id, request_hash, response_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const seedOrder = db.prepare(`
    INSERT INTO order_idempotency (user_id, idempotency_key, request_hash, response_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const seedRefund = db.prepare(`
    INSERT INTO refund_idempotency (user_id, idempotency_key, bill_id, request_hash, response_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const paymentResponse = JSON.stringify({ ok: true, bill_id: billId, total: 12500 });
  const orderResponse = JSON.stringify({ ok: true, order_id: 7 });
  const refundResponse = JSON.stringify({ ok: true, refund_id: 3 });
  seedPayment.run(userId, 'pay-recent', billId, 'hash-pay-recent', paymentResponse, now());
  seedPayment.run(userId, 'pay-89d', billId, 'hash-pay-89d', paymentResponse, daysAgo(89));
  seedPayment.run(userId, 'pay-91d', billId, 'hash-pay-91d', paymentResponse, daysAgo(91));
  seedPayment.run(userId, 'pay-400d', billId, 'hash-pay-400d', paymentResponse, daysAgo(400));
  seedOrder.run(userId, 'ord-recent', 'hash-ord-recent', orderResponse, now());
  seedOrder.run(userId, 'ord-89d', 'hash-ord-89d', orderResponse, daysAgo(89));
  seedOrder.run(userId, 'ord-91d', 'hash-ord-91d', orderResponse, daysAgo(91));
  seedOrder.run(userId, 'ord-400d', 'hash-ord-400d', orderResponse, daysAgo(400));
  seedRefund.run(userId, 'ref-recent', billId, 'hash-ref-recent', refundResponse, now());
  seedRefund.run(userId, 'ref-89d', billId, 'hash-ref-89d', refundResponse, daysAgo(89));
  seedRefund.run(userId, 'ref-91d', billId, 'hash-ref-91d', refundResponse, daysAgo(91));
  seedRefund.run(userId, 'ref-400d', billId, 'hash-ref-400d', refundResponse, daysAgo(400));

  // ── Half 1: expired records are pruned, in-window records survive ──
  const pruned = pruneIdempotencyRecords(db);
  assertEqualOrThrow(pruned.payment, 2, 'F-033: two expired payment records are pruned');
  assertEqualOrThrow(pruned.order, 2, 'F-033: two expired order records are pruned');
  assertEqualOrThrow(pruned.refund, 2, 'F-033: two expired refund records are pruned');
  const remaining = (table: string) =>
    (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  assertEqualOrThrow(remaining('payment_idempotency'), 2, 'F-033: two payment records remain');
  assertEqualOrThrow(remaining('order_idempotency'), 2, 'F-033: two order records remain');
  assertEqualOrThrow(remaining('refund_idempotency'), 2, 'F-033: two refund records remain');

  // A second prune with nothing expired is a no-op.
  const prunedAgain = pruneIdempotencyRecords(db);
  assertEqualOrThrow(prunedAgain.payment, 0, 'F-033: a repeat prune deletes nothing (payment)');
  assertEqualOrThrow(prunedAgain.order, 0, 'F-033: a repeat prune deletes nothing (order)');
  assertEqualOrThrow(prunedAgain.refund, 0, 'F-033: a repeat prune deletes nothing (refund)');

  // ── Half 2: replay inside the window still finds the stored response ──
  // These are the exact SELECTs the three handlers run (bills.ts, orders.ts,
  // refunds.ts); a row the prune kept must still answer a replay lookup.
  const payPrior = db
    .prepare(
      `
      SELECT bill_id, request_hash, response_json
      FROM payment_idempotency
      WHERE (user_id = ? OR user_id = 'legacy') AND idempotency_key = ?
      ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END
      LIMIT 1
    `,
    )
    .get(userId, 'pay-recent', userId) as
    | { bill_id: string; request_hash: string; response_json: string }
    | undefined;
  assertOrThrow(!!payPrior, 'F-033: a recent payment key still replays');
  assertEqualOrThrow(
    payPrior.request_hash,
    'hash-pay-recent',
    'F-033: replay keeps the request hash',
  );
  assertEqualOrThrow(
    payPrior.response_json,
    paymentResponse,
    'F-033: replay keeps the stored response',
  );
  const ordPrior = db
    .prepare(
      `
    SELECT request_hash, response_json
    FROM order_idempotency
    WHERE (user_id = ? OR user_id = 'legacy') AND idempotency_key = ?
    ORDER BY CASE WHEN user_id = ? THEN 0 ELSE 1 END
    LIMIT 1
  `,
    )
    .get(userId, 'ord-89d', userId) as { request_hash: string; response_json: string } | undefined;
  assertOrThrow(!!ordPrior, 'F-033: an 89-day-old order key still replays');
  assertEqualOrThrow(
    ordPrior.response_json,
    orderResponse,
    'F-033: order replay keeps the stored response',
  );
  const refPrior = db
    .prepare(
      `
        SELECT bill_id, request_hash, response_json
        FROM refund_idempotency
        WHERE user_id = ? AND idempotency_key = ?
      `,
    )
    .get(userId, 'ref-recent') as
    | { bill_id: string; request_hash: string; response_json: string }
    | undefined;
  assertOrThrow(!!refPrior, 'F-033: a recent refund key still replays');
  assertEqualOrThrow(
    refPrior.response_json,
    refundResponse,
    'F-033: refund replay keeps the stored response',
  );

  // A pruned key no longer replays: a repeat with that key is a new request,
  // which is the intended consequence of expiry (keys are reusable after it).
  const payExpired = db
    .prepare('SELECT 1 AS found FROM payment_idempotency WHERE idempotency_key = ?')
    .get('pay-91d') as { found: number } | undefined;
  assertEqualOrThrow(payExpired, undefined, 'F-033: a pruned payment key no longer replays');

  // ── A shorter window prunes more: the cutoff honours its argument ──
  // (the 89-day-old row is older than 30 days too, so it goes with the 31-day-old one)
  seedPayment.run(userId, 'pay-31d', billId, 'hash-pay-31d', paymentResponse, daysAgo(31));
  const pruned30 = pruneIdempotencyRecords(db, 30);
  assertEqualOrThrow(
    pruned30.payment,
    2,
    'F-033: a 30-day window prunes the 31- and 89-day-old rows',
  );
  assertEqualOrThrow(
    remaining('payment_idempotency'),
    1,
    'F-033: only the recent payment row survives the 30-day prune',
  );

  closeDatabase();
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  const results = getResults();
  console.log(`\nResults: ${results.passed}/${results.total} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main().catch((err) => {
  try {
    closeDatabase();
  } catch {}
  Module._load = originalLoad;
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch {}
  console.error(err);
  process.exit(1);
});
