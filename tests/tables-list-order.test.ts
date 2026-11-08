/**
 * Integration Test: Tables list-view shared ordering (follow-up 45)
 *
 * Owner decision (2026-11-08): the tables LIST view can be rearranged by
 * drag-and-drop, and the order is SHARED by every user (stored on the
 * table rows, migration v126), not a per-device preference.
 *
 * A) Default list order is the legacy number order (list_order NULL)
 * B) PATCH /tables/list-order persists the arranged order; GET returns it
 * C) Invalid payloads are rejected (empty, duplicates, unknown ids)
 * D) The endpoint requires an authenticated tables.manage user
 *
 * Usage: node tests/run-electron-node-test.cjs tests/tables-list-order.test.ts
 */

// ── Electron Mock ────────────────────────────────────────────────────────────
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-tables-list-order-'));
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
  console.log('Integration Test: Tables List Order');
  console.log('='.repeat(50));

  const db = initTestDb();
  const { authHeader } = seedOwnerUser(db);
  const app = createApp({ '/api/tables': tableRoutes });
  const { baseUrl, server } = await startServer(app);

  const list = (headers?: unknown) =>
    api(baseUrl, '/api/tables', { method: 'GET', headers: headers ?? authHeader });
  const reorder = (body: unknown, headers?: unknown) =>
    api(baseUrl, '/api/tables/list-order', {
      method: 'PATCH',
      headers: headers ?? authHeader,
      body: JSON.stringify(body),
    });

  try {
    const created = await api(baseUrl, '/api/tables/bulk', {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify({ from: 1, to: 5, capacity: 4 }),
    });
    assertEqualOrThrow(created.status, 201, 'setup: five tables created');
    const byNumber = new Map<string, string>(
      created.data.tables.map((t: any) => [t.number, t.id]),
    );

    // ── A) Default order ───────────────────────────────────────────────────
    const before = await list();
    assertEqualOrThrow(
      JSON.stringify(before.data.tables.map((t: any) => t.number)),
      JSON.stringify(['1', '2', '3', '4', '5']),
      'A: default order is the number order',
    );
    assertOrThrow(
      before.data.tables.every((t: any) => t.list_order === null),
      'A: list_order starts NULL',
    );

    // ── B) Persist an arranged order ───────────────────────────────────────
    const arranged = ['3', '1', '2', '5', '4'].map((n) => byNumber.get(n));
    const saved = await reorder({ order: arranged });
    assertEqualOrThrow(saved.status, 200, 'B: reorder accepted');
    assertEqualOrThrow(saved.data.count, 5, 'B: all five rows updated');
    const after = await list();
    assertEqualOrThrow(
      JSON.stringify(after.data.tables.map((t: any) => t.number)),
      JSON.stringify(['3', '1', '2', '5', '4']),
      'B: GET returns the arranged order (shared, from the database)',
    );
    assertEqualOrThrow(
      JSON.stringify(after.data.tables.map((t: any) => t.list_order)),
      JSON.stringify([0, 1, 2, 3, 4]),
      'B: list_order stores the index per table',
    );

    // A newly created table (no stored order) sorts after the arranged ones.
    const extra = await api(baseUrl, '/api/tables/bulk', {
      method: 'POST',
      headers: authHeader,
      body: JSON.stringify({ from: 6, to: 6, capacity: 4 }),
    });
    assertEqualOrThrow(extra.status, 201, 'B: sixth table created');
    const withExtra = await list();
    assertEqualOrThrow(
      withExtra.data.tables.map((t: any) => t.number).join(','),
      '3,1,2,5,4,6',
      'B: unarranged tables keep number order after the arranged ones',
    );

    // ── C) Invalid payloads ────────────────────────────────────────────────
    const empty = await reorder({ order: [] });
    assertEqualOrThrow(empty.status, 400, 'C: empty order rejected');
    const dup = await reorder({ order: [arranged[0], arranged[0]] });
    assertEqualOrThrow(dup.status, 400, 'C: duplicate ids rejected');
    const unknown = await reorder({ order: ['tbl-doesnotexist'] });
    assertEqualOrThrow(unknown.status, 404, 'C: unknown id rejected');
    const afterInvalid = await list();
    assertEqualOrThrow(
      afterInvalid.data.tables.map((t: any) => t.number).join(','),
      '3,1,2,5,4,6',
      'C: rejected payloads leave the stored order untouched',
    );

    // ── D) Auth gate ───────────────────────────────────────────────────────
    const anon = await reorder({ order: arranged }, {});
    assertOrThrow(
      anon.status === 401 || anon.status === 403,
      `D: unauthenticated reorder refused (got ${anon.status})`,
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
