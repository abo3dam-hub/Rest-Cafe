/**
 * KDS reconnect catch-up chime (assignment 037, Delivery 3: F-029).
 *
 * Pins the contracts behind the persisted seen-order set:
 * - The seen set round-trips through storage per surface (kds and pos
 *   keys are separate), and a damaged stored value reads as "never
 *   persisted", so a brand-new board seeds silently instead of chiming
 *   for every order on it.
 * - The catch-up diff: a snapshot after a remount reports exactly the
 *   orders that arrived during the outage as fresh, and prunes ids that
 *   left the board from the stored set.
 * - The stored set is capped at 500 ids.
 *
 * The hook itself (useNewOrderAlert) is exercised through these same
 * helpers and constants; the hook wiring is covered by lint, tsc and
 * build:frontend.
 *
 * Run: npm run test:kds-reconnect-chime
 */

const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');
const {
  SEEN_ORDER_IDS_CAP,
  diffNewOrders,
  loadSeenOrderIds,
  saveSeenOrderIds,
  seenOrderIdsStorageKey,
} = require('../frontend/src/lib/order-alert');

class MemoryStorage {
  values = new Map<string, string>();

  getItem(key: string) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function main(): void {
  // ── Storage keys are scoped per surface ──
  {
    assertEqualOrThrow(
      seenOrderIdsStorageKey('kds'),
      'flocafe:order-alert:kds:seen-ids',
      'F-029: the KDS seen set has its own key',
    );
    assertEqualOrThrow(
      seenOrderIdsStorageKey('pos'),
      'flocafe:order-alert:pos:seen-ids',
      'F-029: the POS seen set has its own key',
    );
    assertOrThrow(
      seenOrderIdsStorageKey('kds') !== seenOrderIdsStorageKey('pos'),
      'F-029: the two surfaces never share a seen set',
    );
  }

  // ── Round-trip: save then load returns the same ids ──
  {
    const storage = new MemoryStorage();
    assertEqualOrThrow(
      loadSeenOrderIds('kds', storage),
      null,
      'F-029: nothing persisted reads as null (brand-new board seeds silently)',
    );
    saveSeenOrderIds('kds', new Set([1, 2, 3]), storage);
    const loaded = loadSeenOrderIds('kds', storage);
    assertOrThrow(!!loaded, 'F-029: a saved seen set loads back');
    assertEqualOrThrow(loaded!.size, 3, 'F-029: the loaded set has three ids');
    assertOrThrow(loaded!.has(2), 'F-029: the loaded set keeps id 2');
    // The other surface is untouched by the KDS save.
    assertEqualOrThrow(
      loadSeenOrderIds('pos', storage),
      null,
      'F-029: saving the KDS set does not seed the POS set',
    );
  }

  // ── Damaged storage reads as never-persisted ──
  {
    const storage = new MemoryStorage();
    storage.setItem(seenOrderIdsStorageKey('kds'), 'not-json{');
    assertEqualOrThrow(
      loadSeenOrderIds('kds', storage),
      null,
      'F-029: damaged JSON reads as null, so the board seeds silently',
    );
    storage.setItem(seenOrderIdsStorageKey('kds'), JSON.stringify({ not: 'an array' }));
    assertEqualOrThrow(
      loadSeenOrderIds('kds', storage),
      null,
      'F-029: a non-array value reads as null',
    );
    storage.setItem(seenOrderIdsStorageKey('kds'), JSON.stringify(['a', null, 7, 1.5]));
    const loaded = loadSeenOrderIds('kds', storage);
    assertOrThrow(!!loaded, 'F-029: mixed values still load the valid ids');
    assertEqualOrThrow(loaded!.size, 1, 'F-029: only the integer id survives sanitizing');
    assertOrThrow(loaded!.has(7), 'F-029: the surviving id is 7');
  }

  // ── Catch-up diff: outage orders are fresh, departed orders are pruned ──
  {
    const seen = new Set([1, 2]);
    const snapshot = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const { fresh, nextSeen } = diffNewOrders(snapshot, seen);
    assertEqualOrThrow(
      JSON.stringify(fresh.map((order) => order.id)),
      JSON.stringify([3, 4]),
      'F-029: exactly the outage orders are fresh',
    );
    assertEqualOrThrow(nextSeen.size, 4, 'F-029: the next set holds the whole snapshot');
    // Orders 1 and 3 left the board; only the live ones stay seen.
    const later = diffNewOrders([{ id: 2 }, { id: 4 }], nextSeen);
    assertEqualOrThrow(
      later.fresh.length,
      0,
      'F-029: a reconnect snapshot with no new orders is silent',
    );
    assertEqualOrThrow(
      later.nextSeen.size,
      2,
      'F-029: departed orders are pruned from the seen set',
    );
    assertOrThrow(
      later.nextSeen.has(2) && later.nextSeen.has(4),
      'F-029: the pruned set keeps live ids',
    );
  }

  // ── One catch-up signal per reconnect, not per historical order ──
  {
    // The hook raises one alert per snapshot batch (count = fresh.length);
    // the diff itself must therefore return the outage orders as one
    // batch, in snapshot order, with the latest last.
    const { fresh } = diffNewOrders(
      [{ id: 1 }, { id: 2 }, { id: 5 }, { id: 6 }, { id: 7 }],
      new Set([1, 2]),
    );
    assertEqualOrThrow(fresh.length, 3, 'F-029: three outage orders form one batch');
    assertEqualOrThrow(fresh[fresh.length - 1].id, 7, 'F-029: the latest outage order is last');
  }

  // ── Cap: a long-lived board never grows the stored array without bound ──
  {
    assertEqualOrThrow(SEEN_ORDER_IDS_CAP, 500, 'F-029: the seen set caps at 500 ids');
    const storage = new MemoryStorage();
    saveSeenOrderIds(
      'kds',
      Array.from({ length: 600 }, (_, i) => i + 1),
      storage,
    );
    const loaded = loadSeenOrderIds('kds', storage);
    assertOrThrow(!!loaded, 'F-029: a capped set still loads');
    assertEqualOrThrow(loaded!.size, 500, 'F-029: the loaded set is capped at 500');
    assertOrThrow(loaded!.has(600), 'F-029: the cap keeps the most recent ids');
    assertOrThrow(!loaded!.has(100), 'F-029: the cap drops the oldest ids');
  }

  const results = getResults();
  console.log(`\nResults: ${results.passed}/${results.total} passed, ${results.failed} failed`);
  if (results.failed > 0) process.exit(1);
}

main();
