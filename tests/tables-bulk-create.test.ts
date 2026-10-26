/**
 * Integration Test: Bulk Table Creation
 *
 * Owner-approved shape (2026-10-26): a numeric range with an optional
 * prefix, one shared capacity/hall/section for the batch. Numbers that
 * already exist — active or deactivated — are skipped and reported,
 * never an error, so an owner can extend an existing numbering run.
 *
 * A) POST /tables/bulk creates a full range in one call
 * B) Prefix is applied to every generated name
 * C) Existing numbers (incl. deactivated) are skipped and reported
 * D) Invalid ranges are rejected (from > to, non-positive, > 200)
 * E) Shared fields land on every created table; capacity defaults to 4
 *
 * Usage: node tests/run-electron-node-test.cjs tests/tables-bulk-create.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tables-bulk-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
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
  closeDatabase,
} = require('./helpers/test-setup');

const { tableRoutes } = require('../main/routes/tables');

async function main() {
  console.log('Integration Test: Bulk Table Creation');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const app = createApp({ '/api/tables': tableRoutes });
  const { baseUrl, server } = await startServer(app);

  const bulk = (body: unknown) =>
    api(baseUrl, '/api/tables/bulk', {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify(body),
    });

  try {
    // ── A) Full range in one call ──────────────────────────────────────────
    console.log('\n─── A) Range create ───');
    const a = await bulk({ from: 1, to: 5, capacity: 6, floor: 'الصالة الرئيسية', section: 'نافذة' });
    assertEqualOrThrow(a.status, 201, 'A: bulk create returns 201');
    assertEqualOrThrow(a.data.created_count, 5, 'A: five tables created');
    assertEqualOrThrow(a.data.skipped.length, 0, 'A: nothing skipped');
    const aNames = a.data.tables.map((t: any) => t.number);
    assertOrThrow(
      JSON.stringify(aNames) === JSON.stringify(['1', '2', '3', '4', '5']),
      `A: names are the range (got ${JSON.stringify(aNames)})`,
    );
    assertOrThrow(
      a.data.tables.every((t: any) => /^tbl-[a-f0-9]{8}$/.test(t.id)),
      'A: ids are tbl-{uuid} strings',
    );
    assertOrThrow(
      a.data.tables.every(
        (t: any) => t.capacity === 6 && t.floor === 'الصالة الرئيسية' && t.section === 'نافذة',
      ),
      'A: shared capacity/hall/section applied to all',
    );

    // ── B) Prefix ──────────────────────────────────────────────────────────
    console.log('\n─── B) Prefix ───');
    const b = await bulk({ prefix: 'T', from: 1, to: 3 });
    assertEqualOrThrow(b.status, 201, 'B: prefix create returns 201');
    const bNames = b.data.tables.map((t: any) => t.number);
    assertOrThrow(
      JSON.stringify(bNames) === JSON.stringify(['T1', 'T2', 'T3']),
      `B: prefixed names (got ${JSON.stringify(bNames)})`,
    );
    assertOrThrow(
      b.data.tables.every((t: any) => t.capacity === 4),
      'B: capacity defaults to 4 when omitted',
    );

    // ── C) Skip existing, including deactivated ────────────────────────────
    console.log('\n─── C) Skip duplicates ───');
    const c = await bulk({ from: 4, to: 8 });
    assertEqualOrThrow(c.status, 201, 'C: overlapping range still returns 201');
    assertEqualOrThrow(c.data.created_count, 3, 'C: only the new numbers are created');
    assertOrThrow(
      JSON.stringify(c.data.skipped) === JSON.stringify(['4', '5']),
      `C: existing numbers reported as skipped (got ${JSON.stringify(c.data.skipped)})`,
    );

    const eight = c.data.tables.find((t: any) => t.number === '8');
    const deact = await api(baseUrl, `/api/tables/${eight.id}/deactivate`, {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify({}),
    });
    assertEqualOrThrow(deact.status, 200, 'C: table 8 deactivated');
    const c2 = await bulk({ from: 8, to: 8 });
    assertEqualOrThrow(c2.data.created_count, 0, 'C: deactivated number is not recreated');
    assertOrThrow(
      JSON.stringify(c2.data.skipped) === JSON.stringify(['8']),
      'C: deactivated number reported as skipped',
    );

    // ── D) Validation ──────────────────────────────────────────────────────
    console.log('\n─── D) Validation ───');
    const d1 = await bulk({ from: 10, to: 5 });
    assertEqualOrThrow(d1.status, 400, 'D: from > to rejected');
    assertEqualOrThrow(d1.data.code, 'TABLE_RANGE_INVALID', 'D: range error code');
    const d2 = await bulk({ from: 1, to: 201 });
    assertEqualOrThrow(d2.status, 400, 'D: batch above 200 rejected');
    assertEqualOrThrow(d2.data.code, 'TABLE_RANGE_TOO_LARGE', 'D: too-large error code');
    const d3 = await bulk({ from: 0, to: 3 });
    assertEqualOrThrow(d3.status, 400, 'D: zero start rejected');
    const d4 = await bulk({ from: 20, to: 22, capacity: 0 });
    assertEqualOrThrow(d4.status, 400, 'D: zero capacity rejected');
    const d5 = await bulk({ prefix: 42, from: 20, to: 22 });
    assertEqualOrThrow(d5.status, 400, 'D: non-text prefix rejected');

    // ── E) Final state ─────────────────────────────────────────────────────
    console.log('\n─── E) Final state ───');
    const list = await api(baseUrl, '/api/tables', { headers: authHeader });
    const numbers = list.data.tables.map((t: any) => t.number).sort();
    assertOrThrow(
      JSON.stringify(numbers) ===
        JSON.stringify(['1', '2', '3', '4', '5', '6', '7', '8', 'T1', 'T2', 'T3']),
      `E: table list matches all creations (got ${JSON.stringify(numbers)})`,
    );

    const results = require('./helpers/test-setup').getResults();
    console.log(`\nResults: ${results.passed}/${results.total} passed, ${results.failed} failed`);
    if (results.failed > 0) process.exit(1);
  } finally {
    server.close();
    closeDatabase();
  }
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
