/**
 * Unit tests for the database-open retry helper (follow-up 46).
 *
 * Ali's 2026-11-08 main.log: after a GPU-process crash the app relaunched
 * itself and died in initDatabase with a transient SQLite "disk I/O error"
 * while the previous process was still releasing the database file. Only
 * that class of short-lived handover fault may be retried — real corruption
 * or a bad path must still fail fast.
 *
 * Run: npm run test:db-open-retry
 */

import * as assert from 'node:assert/strict';

import { isTransientDatabaseOpenError, openDatabaseWithRetry } from '../main/db-open-retry';

async function run(): Promise<void> {
  // ── Classification ────────────────────────────────────────────────────────
  assert.equal(
    isTransientDatabaseOpenError(new Error('disk I/O error')),
    true,
    'disk I/O error message is transient',
  );
  assert.equal(
    isTransientDatabaseOpenError(new Error('database is locked')),
    true,
    'database-is-locked message is transient',
  );
  assert.equal(
    isTransientDatabaseOpenError(Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })),
    true,
    'SQLITE_BUSY code is transient',
  );
  assert.equal(
    isTransientDatabaseOpenError(Object.assign(new Error('io'), { code: 'SQLITE_IOERR' })),
    true,
    'SQLITE_IOERR code is transient',
  );
  assert.equal(
    isTransientDatabaseOpenError(new Error('database disk image is malformed')),
    false,
    'corruption is not transient',
  );
  assert.equal(
    isTransientDatabaseOpenError(new Error('no such table: orders')),
    false,
    'schema errors are not transient',
  );

  const noSleep = async () => {};

  // ── Immediate success ─────────────────────────────────────────────────────
  let opens = 0;
  const firstAttempt = await openDatabaseWithRetry(
    () => {
      opens += 1;
    },
    { sleep: noSleep },
  );
  assert.equal(firstAttempt, 1, 'clean open returns attempt 1');
  assert.equal(opens, 1, 'clean open runs exactly once');

  // ── Transient failures then success ───────────────────────────────────────
  opens = 0;
  let resets = 0;
  const delays: number[] = [];
  const thirdAttempt = await openDatabaseWithRetry(
    () => {
      opens += 1;
      if (opens < 3) throw new Error('disk I/O error');
    },
    {
      sleep: async (ms) => {
        delays.push(ms);
      },
      reset: () => {
        resets += 1;
      },
      delaysMs: [10, 20, 30],
    },
  );
  assert.equal(thirdAttempt, 3, 'two transient failures then success returns attempt 3');
  assert.equal(resets, 2, 'reset runs between attempts only');
  assert.deepEqual(delays, [10, 20], 'configured delays are used in order');

  // ── Non-transient errors fail fast ────────────────────────────────────────
  opens = 0;
  await assert.rejects(
    openDatabaseWithRetry(
      () => {
        opens += 1;
        throw new Error('database disk image is malformed');
      },
      { sleep: noSleep },
    ),
    /malformed/,
    'non-transient errors are rethrown',
  );
  assert.equal(opens, 1, 'non-transient errors are never retried');

  // ── Transient errors exhaust the attempts ─────────────────────────────────
  opens = 0;
  await assert.rejects(
    openDatabaseWithRetry(
      () => {
        opens += 1;
        throw new Error('database is locked');
      },
      { sleep: noSleep, maxAttempts: 3, delaysMs: [1, 1] },
    ),
    /database is locked/,
    'the final transient error is rethrown after max attempts',
  );
  assert.equal(opens, 3, 'transient errors stop at max attempts');

  // ── A throwing reset must not mask the original error ─────────────────────
  opens = 0;
  const recovered = await openDatabaseWithRetry(
    () => {
      opens += 1;
      if (opens === 1) throw new Error('disk I/O error');
    },
    {
      sleep: noSleep,
      reset: () => {
        throw new Error('reset exploded');
      },
    },
  );
  assert.equal(recovered, 2, 'a throwing reset is suppressed and the retry proceeds');

  console.log('Database open retry tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
