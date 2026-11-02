/**
 * KOT printed marker + durable print queue (assignment 037, Delivery 3: F-004, F-009).
 *
 * Pins the contracts behind the marker and the queue:
 * - F-004: migration v123 adds order_items.kot_printed_at; getUnprintedKotItems
 *   returns only pending, still-unmarked items; markKotItemsPrinted stamps
 *   only still-unmarked rows.
 * - F-009: print_jobs is a durable queue — enqueue dedupes identical
 *   pending jobs, claim is transactional (processing), failure backs off
 *   (30s, 2m, 5m, 10m, 15m cap) up to 10 attempts, then the job is failed.
 *   The worker (processDuePrintJobs) executes with injectable dispatchers:
 *   a failing dispatcher leaves the job pending with attempts grown; a
 *   succeeding dispatcher completes it. A receipt job with a missing bill
 *   fails without touching the printer.
 *
 * The frontend queue (localStorage, same backoff) is covered by the same
 * helpers through the pure module functions below.
 *
 * Run: npm run test:kot-print-queue
 */

const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-kot-queue-'));

const mockApp = {
  isPackaged: true,
  getPath: (_name: string) => testDir,
  getVersion: () => 'test',
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');
const {
  getUnprintedKotItems,
  getUnprintedKotItemIds,
  markKotItemsPrinted,
} = require('../main/services/kot-print');
const {
  PRINT_JOB_MAX_ATTEMPTS,
  claimDuePrintJobs,
  completePrintJob,
  enqueuePrintJob,
  failPrintJob,
  printJobRetryDelayMs,
  processDuePrintJobs,
} = require('../main/services/print-queue');
const {
  PENDING_PRINT_JOB_MAX_ATTEMPTS,
  duePendingPrintJobs,
  enqueuePendingPrintJob,
  loadPendingPrintJobs,
  markPendingPrintJobFailed,
  pendingPrintJobRetryDelayMs,
  removePendingPrintJob,
} = require('../frontend/src/lib/printer/print-queue');

function isNativeAbiMismatch(error: any): boolean {
  return (
    error?.code === 'ERR_DLOPEN_FAILED' &&
    String(error?.message || '').includes('NODE_MODULE_VERSION')
  );
}

try {
  initDatabase();
} catch (error: any) {
  if (isNativeAbiMismatch(error)) {
    console.log('  ⚠ Skipping: better-sqlite3 is not built for this shell Node ABI.');
    process.exit(77);
  }
  throw error;
}

const db = getDatabase();
const stamp = now();

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

async function main(): Promise<void> {
  // ── Migration v123: marker column and queue table exist on a fresh DB ──
  {
    const columns = db.prepare('PRAGMA table_info(order_items)').all() as { name: string }[];
    assertOrThrow(
      columns.some((column) => column.name === 'kot_printed_at'),
      'v123: order_items has a kot_printed_at column',
    );
    const table = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'print_jobs'`)
      .get() as { name: string } | undefined;
    assertOrThrow(!!table, 'v123: print_jobs table exists');
    const index = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_print_jobs_due'`,
      )
      .get() as { name: string } | undefined;
    assertOrThrow(!!index, 'v123: idx_print_jobs_due index exists');
  }

  // ── Seed: one order, one pending unmarked item, one pending marked item, one ready item ──
  const orderId = Number(
    db
      .prepare(
        `INSERT INTO orders (order_number, type, subtotal, tax_amount, total, status, created_at, updated_at)
         VALUES ('ORD-KOTQ-1', 'dine_in', 100, 0, 100, 'pending', ?, ?)`,
      )
      .run(stamp, stamp).lastInsertRowid,
  );
  const insertItem = (name: string, status: string, marked: boolean) =>
    Number(
      db
        .prepare(
          `INSERT INTO order_items (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, kot_printed_at, created_at, updated_at)
           VALUES (?, ?, ?, 100, 1, 100, 100, ?, ?, ?, ?)`,
        )
        .run(orderId, `prod-${name}`, name, status, marked ? stamp : null, stamp, stamp)
        .lastInsertRowid,
    );
  const pendingUnmarkedId = insertItem('Pending', 'pending', false);
  const pendingMarkedId = insertItem('Marked', 'pending', true);
  const readyId = insertItem('Ready', 'ready', false);

  // ── F-004: the marker filter ──
  {
    const unprinted = getUnprintedKotItems(db, orderId);
    assertEqualOrThrow(unprinted.length, 1, 'F-004: only the pending unmarked item is unprinted');
    assertEqualOrThrow(
      Number(unprinted[0].id),
      pendingUnmarkedId,
      'F-004: the unprinted item is the pending unmarked one',
    );
    const ids = getUnprintedKotItemIds(db, orderId);
    assertEqualOrThrow(ids.length, 1, 'F-004: unprinted ids has one entry');
    assertEqualOrThrow(ids[0], pendingUnmarkedId, 'F-004: unprinted id matches');
    // Scoping by ids still respects the marker and the status.
    assertEqualOrThrow(
      getUnprintedKotItemIds(db, orderId, [pendingMarkedId, readyId]).length,
      0,
      'F-004: marked and ready items stay excluded even when scoped in',
    );
    assertEqualOrThrow(
      markKotItemsPrinted(db, orderId, [pendingUnmarkedId]),
      1,
      'F-004: marking stamps one still-unmarked row',
    );
    assertEqualOrThrow(
      markKotItemsPrinted(db, orderId, [pendingUnmarkedId]),
      0,
      'F-004: re-marking stamps nothing (idempotent)',
    );
    assertEqualOrThrow(
      getUnprintedKotItems(db, orderId).length,
      0,
      'F-004: nothing is unprinted once every pending item is marked',
    );
    // Unmark for the queue tests below.
    db.prepare('UPDATE order_items SET kot_printed_at = NULL WHERE id = ?').run(pendingUnmarkedId);
  }

  // ── F-009: backoff schedule ──
  {
    assertEqualOrThrow(printJobRetryDelayMs(1), 30_000, 'F-009: first retry is 30 s out');
    assertEqualOrThrow(printJobRetryDelayMs(2), 120_000, 'F-009: second retry is 2 m out');
    assertEqualOrThrow(printJobRetryDelayMs(3), 300_000, 'F-009: third retry is 5 m out');
    assertEqualOrThrow(printJobRetryDelayMs(4), 600_000, 'F-009: fourth retry is 10 m out');
    assertEqualOrThrow(printJobRetryDelayMs(5), 900_000, 'F-009: fifth retry is 15 m out');
    assertEqualOrThrow(printJobRetryDelayMs(10), 900_000, 'F-009: backoff caps at 15 m');
    assertEqualOrThrow(printJobRetryDelayMs(99), 900_000, 'F-009: backoff stays capped');
    assertEqualOrThrow(PRINT_JOB_MAX_ATTEMPTS, 10, 'F-009: backend jobs cap at 10 attempts');
  }

  // ── F-009: enqueue dedupes, claim/complete move the state ──
  let kotJobId: number;
  {
    const first = enqueuePrintJob(db, {
      kind: 'kot',
      orderId,
      payload: { itemIds: [pendingUnmarkedId] },
    });
    assertOrThrow(first.created, 'F-009: first enqueue creates the job');
    kotJobId = first.id;
    const second = enqueuePrintJob(db, {
      kind: 'kot',
      orderId,
      payload: { itemIds: [pendingUnmarkedId] },
    });
    assertOrThrow(!second.created, 'F-009: an identical pending job is not duplicated');
    assertEqualOrThrow(second.id, kotJobId, 'F-009: the duplicate enqueue returns the same job');
    const different = enqueuePrintJob(db, {
      kind: 'kot',
      orderId,
      payload: { itemIds: [pendingUnmarkedId, pendingMarkedId] },
    });
    assertOrThrow(different.created, 'F-009: a different payload is a different job');
    assertOrThrow(different.id !== kotJobId, 'F-009: the different job has its own id');

    // Nothing is due yet: the first retry is 30 s out.
    assertEqualOrThrow(
      claimDuePrintJobs(db).length,
      0,
      'F-009: no job is due before its retry time',
    );
    makeDue(different.id);
    const claimed = claimDuePrintJobs(db);
    assertEqualOrThrow(claimed.length, 1, 'F-009: the due job is claimed once');
    assertEqualOrThrow(claimed[0].id, different.id, 'F-009: the claimed job is the due one');
    assertEqualOrThrow(
      jobRow(different.id).status,
      'processing',
      'F-009: claiming marks processing',
    );
    assertEqualOrThrow(
      claimDuePrintJobs(db).length,
      0,
      'F-009: a claimed job is not claimed twice',
    );
    completePrintJob(db, different.id);
    assertEqualOrThrow(jobRow(different.id).status, 'done', 'F-009: completing marks done');
  }

  // ── F-009: failure backs off, then the job is failed at the cap ──
  {
    // kotJobId is still pending from the dedupe block above; fail it
    // repeatedly, making it due again before each attempt.
    const targetId = kotJobId;
    for (let attempt = 1; attempt <= PRINT_JOB_MAX_ATTEMPTS; attempt++) {
      makeDue(targetId);
      assertEqualOrThrow(
        claimDuePrintJobs(db).filter((job: any) => job.id === targetId).length,
        1,
        `F-009: job is claimable at attempt ${attempt}`,
      );
      failPrintJob(db, targetId, 'printer offline');
      const row = jobRow(targetId);
      assertEqualOrThrow(Number(row.attempts), attempt, `F-009: attempts is ${attempt}`);
      if (attempt < PRINT_JOB_MAX_ATTEMPTS) {
        assertEqualOrThrow(
          row.status,
          'pending',
          'F-009: a failed job stays pending below the cap',
        );
        assertOrThrow(!!row.next_retry_at, 'F-009: a failed job has a next retry time');
        assertEqualOrThrow(row.last_error, 'printer offline', 'F-009: the failure reason is kept');
      } else {
        assertEqualOrThrow(row.status, 'failed', 'F-009: the job is failed at the attempt cap');
      }
    }
  }

  // ── F-009: worker end-to-end with stub dispatchers ──
  {
    const stubCalls: { orderId: number; itemIds?: number[] }[] = [];
    let kotShouldFail = true;
    const stubDispatchKot = async (_db: any, opts: any) => {
      stubCalls.push({ orderId: opts.orderId, itemIds: opts.itemIds });
      if (kotShouldFail) {
        return {
          ok: false,
          printedItemIds: [],
          failedItemIds: opts.itemIds ?? [],
          candidateItemIds: opts.itemIds ?? [],
          nothingToPrint: false,
          warnings: [],
          failure: { detail: 'printer offline' },
        };
      }
      return {
        ok: true,
        printedItemIds: opts.itemIds ?? [],
        failedItemIds: [],
        candidateItemIds: opts.itemIds ?? [],
        nothingToPrint: false,
        warnings: [],
      };
    };
    const { id: workerJobId } = enqueuePrintJob(db, {
      kind: 'kot',
      orderId,
      payload: { itemIds: [pendingUnmarkedId] },
    });
    makeDue(workerJobId);
    const firstPass = await processDuePrintJobs({ dispatchKot: stubDispatchKot });
    assertEqualOrThrow(firstPass.processed, 1, 'F-009: the worker processes the due job');
    assertEqualOrThrow(firstPass.failed, 1, 'F-009: the failing dispatch counts as failed');
    assertEqualOrThrow(firstPass.succeeded, 0, 'F-009: nothing succeeded on the failing pass');
    assertEqualOrThrow(
      jobRow(workerJobId).status,
      'pending',
      'F-009: the job stays pending after a failure',
    );
    assertEqualOrThrow(Number(jobRow(workerJobId).attempts), 1, 'F-009: the attempt is recorded');
    assertEqualOrThrow(stubCalls.length, 1, 'F-009: the stub dispatcher was called once');
    assertEqualOrThrow(stubCalls[0].orderId, orderId, 'F-009: the stub got the job order');
    assertEqualOrThrow(
      JSON.stringify(stubCalls[0].itemIds),
      JSON.stringify([pendingUnmarkedId]),
      'F-009: the stub got the payload item ids',
    );

    kotShouldFail = false;
    makeDue(workerJobId);
    const secondPass = await processDuePrintJobs({ dispatchKot: stubDispatchKot });
    assertEqualOrThrow(
      secondPass.succeeded,
      1,
      'F-009: the retry succeeds once the printer is back',
    );
    assertEqualOrThrow(
      jobRow(workerJobId).status,
      'done',
      'F-009: the job is done after the retry',
    );
  }

  // ── F-009: receipt job with a stub dispatcher; missing bill fails cleanly ──
  {
    const billId = Number(
      db
        .prepare(
          `INSERT INTO bills (bill_number, order_id, subtotal, total, payment_status, created_at, updated_at)
           VALUES ('B-KOTQ-1', ?, 100, 100, 'unpaid', ?, ?)`,
        )
        .run(orderId, stamp, stamp).lastInsertRowid,
    );
    const billCalls: number[] = [];
    const stubDispatchBill = async (_db: any, opts: any) => {
      billCalls.push(Number(opts.bill.id));
      return { ok: true };
    };
    const { id: receiptJobId } = enqueuePrintJob(db, {
      kind: 'receipt',
      orderId,
      billId,
      payload: { isReprint: false },
    });
    makeDue(receiptJobId);
    const pass = await processDuePrintJobs({ dispatchBill: stubDispatchBill });
    assertEqualOrThrow(pass.succeeded, 1, 'F-009: the receipt job succeeds with a stub dispatcher');
    assertEqualOrThrow(jobRow(receiptJobId).status, 'done', 'F-009: the receipt job is done');
    assertEqualOrThrow(billCalls[0], billId, 'F-009: the receipt stub got the bill');

    // A receipt job whose bill is gone fails without calling the dispatcher.
    const { id: orphanJobId } = enqueuePrintJob(db, {
      kind: 'receipt',
      orderId,
      billId: 999_999,
      payload: {},
    });
    makeDue(orphanJobId);
    const orphanPass = await processDuePrintJobs({ dispatchBill: stubDispatchBill });
    assertEqualOrThrow(orphanPass.failed, 1, 'F-009: the orphan receipt job fails');
    assertEqualOrThrow(
      jobRow(orphanJobId).last_error,
      'Bill not found',
      'F-009: the orphan failure names the missing bill',
    );
    assertEqualOrThrow(billCalls.length, 1, 'F-009: the dispatcher was not called for the orphan');
  }

  // ── F-009: frontend queue helpers (same backoff, localStorage-backed) ──
  {
    const storage = (() => {
      const values = new Map<string, string>();
      return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          values.set(key, value);
        },
        removeItem: (key: string) => {
          values.delete(key);
        },
      };
    })();
    assertEqualOrThrow(
      pendingPrintJobRetryDelayMs(1),
      30_000,
      'F-009: frontend first retry is 30 s out',
    );
    assertEqualOrThrow(
      pendingPrintJobRetryDelayMs(99),
      900_000,
      'F-009: frontend backoff caps at 15 m',
    );
    assertEqualOrThrow(PENDING_PRINT_JOB_MAX_ATTEMPTS, 5, 'F-009: frontend jobs cap at 5 attempts');
    const first = enqueuePendingPrintJob(
      { kind: 'kot', orderId, itemIds: [pendingUnmarkedId] },
      1_000_000,
      storage,
    );
    assertOrThrow(first.created, 'F-009: frontend enqueue creates the job');
    const second = enqueuePendingPrintJob(
      { kind: 'kot', orderId, itemIds: [pendingUnmarkedId] },
      1_000_000,
      storage,
    );
    assertOrThrow(!second.created, 'F-009: frontend enqueue dedupes an identical job');
    assertEqualOrThrow(second.job.id, first.job.id, 'F-009: the duplicate returns the same job');
    // Not due until its first retry time (30 s after creation).
    assertEqualOrThrow(
      duePendingPrintJobs(1_000_000 + 29_999, storage).length,
      0,
      'F-009: the frontend job is not due before its retry time',
    );
    assertEqualOrThrow(
      duePendingPrintJobs(1_000_000 + 30_000, storage).length,
      1,
      'F-009: the frontend job is due at its retry time',
    );
    // Four failures keep it pending with growing backoff; the fifth exhausts it.
    for (let attempt = 1; attempt <= PENDING_PRINT_JOB_MAX_ATTEMPTS; attempt++) {
      markPendingPrintJobFailed(first.job.id, 'webusb error', 2_000_000, storage);
      const row = loadPendingPrintJobs(storage).find((job: any) => job.id === first.job.id);
      assertOrThrow(!!row, 'F-009: the frontend job is still stored after a failure');
      assertEqualOrThrow(Number(row!.attempts), attempt, `F-009: frontend attempts is ${attempt}`);
      if (attempt < PENDING_PRINT_JOB_MAX_ATTEMPTS) {
        assertOrThrow(!row!.exhausted, 'F-009: the frontend job is not exhausted below the cap');
      } else {
        assertOrThrow(!!row!.exhausted, 'F-009: the frontend job is exhausted at the cap');
      }
    }
    assertEqualOrThrow(
      duePendingPrintJobs(3_000_000, storage).length,
      0,
      'F-009: an exhausted frontend job is never due again',
    );
    removePendingPrintJob(first.job.id, storage);
    assertEqualOrThrow(
      loadPendingPrintJobs(storage).length,
      0,
      'F-009: removing the frontend job clears it',
    );
  }

  const results = getResults();
  console.log(`\nResults: ${results.passed}/${results.total} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => {
    try {
      closeDatabase();
    } catch {}
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });
