/**
 * Interface Links settings tab (Ali, 2026-11-06): one aggregated payload for
 * every device-facing interface.
 *
 * Pins the aggregation contract of `buildInterfaceLinks()` — the shape
 * `/api/interface-links` and the settings tab read:
 * - four interfaces in a fixed order, each URL built from the live port its
 *   server bound (defaults here: 3001/3002/3003, un-bumped)
 * - enabled interfaces carry a QR data URL; a disabled interface reports
 *   `enabled: false` and NO QR, so the tab never presents a dead link
 * - self-ordering reports flags only (it has one signed link per table)
 *
 * Run: npm run test:interface-links
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-interface-links-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');

async function run(): Promise<void> {
  const { initDatabase, closeDatabase, upsertSettings } = await import('../main/db');
  const { buildInterfaceLinks } = await import('../main/routes/interface-links');

  try {
    initDatabase();

    // 1. Fresh database: every interface enabled on its default port.
    const baseline = await buildInterfaceLinks();
    assertOrThrow(
      typeof baseline.ip === 'string' && baseline.ip.length > 0,
      'payload carries the LAN ip',
    );
    assertEqualOrThrow(baseline.interfaces.length, 4, 'exactly four interfaces are reported');
    assert.deepEqual(
      baseline.interfaces.map((entry) => entry.id),
      ['main', 'kitchen', 'waiter', 'customer_display'],
      'interfaces come in the fixed display order',
    );

    const byId = new Map(baseline.interfaces.map((entry) => [entry.id, entry]));
    const expectedPorts = { main: 3001, kitchen: 3002, waiter: 3003, customer_display: 3001 };
    for (const [id, port] of Object.entries(expectedPorts)) {
      const link = byId.get(id as keyof typeof expectedPorts);
      assertOrThrow(link, `interface ${id} is present`);
      assertEqualOrThrow(link!.port, port, `${id} reports its live port`);
      assertEqualOrThrow(link!.requested_port, port, `${id} reports its requested port`);
      assertOrThrow(!link!.port_bumped, `${id} is un-bumped without contention`);
      assertOrThrow(link!.enabled, `${id} is enabled by default`);
      assertOrThrow(
        link!.url === `http://${baseline.ip}:${port}/` ||
          (id === 'customer_display' &&
            link!.url === `http://${baseline.ip}:${port}/customer-display/`),
        `${id} url is built from the live ip and port`,
      );
      assertOrThrow(
        typeof link!.qr_data_url === 'string' &&
          link!.qr_data_url.startsWith('data:image/png'),
        `${id} carries a QR data URL while enabled`,
      );
    }

    // Self-ordering is opt-in and carries flags only, never a URL.
    assertOrThrow(!baseline.self_order.enabled, 'self-ordering is disabled by default');
    assertOrThrow(
      baseline.self_order.server_app_enabled,
      'server app is enabled by default in the self-order flags',
    );

    // 2. Disabling the kitchen removes its QR but keeps the row honest.
    upsertSettings({ kds_enabled: 'false' });
    const kdsOff = await buildInterfaceLinks();
    const kitchen = kdsOff.interfaces.find((entry) => entry.id === 'kitchen');
    assertOrThrow(kitchen && !kitchen.enabled, 'kitchen reports disabled after kds_enabled=false');
    assertEqualOrThrow(kitchen!.qr_data_url, null, 'a disabled interface carries no QR');
    const mainStill = kdsOff.interfaces.find((entry) => entry.id === 'main');
    assertOrThrow(
      mainStill && mainStill.enabled && mainStill.qr_data_url,
      'other interfaces are unaffected by the kitchen switch',
    );

    // 3. Disabling the Server App disables the waiter row and the
    // self-order prerequisite flag together.
    upsertSettings({ server_app_enabled: 'false' });
    const appOff = await buildInterfaceLinks();
    const waiter = appOff.interfaces.find((entry) => entry.id === 'waiter');
    assertOrThrow(waiter && !waiter.enabled, 'waiter reports disabled after server_app_enabled=false');
    assertEqualOrThrow(waiter!.qr_data_url, null, 'the disabled waiter carries no QR');
    assertOrThrow(
      !appOff.self_order.server_app_enabled,
      'self-order flags follow the server app switch',
    );
  } finally {
    try {
      closeDatabase();
    } catch {
      // Best effort; the process exits either way.
    }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  const results = getResults();
  if (results.failed > 0) {
    console.error(`interface-links: ${results.failed} assertion(s) failed`);
    process.exit(1);
  }
  console.log(`interface-links: all ${results.passed} assertions passed`);
}

run().catch((error) => {
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
