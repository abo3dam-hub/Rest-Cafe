/**
 * Delivery 4 (assignment 037): port bumps are recorded and surfaced (F-006).
 *
 * Pins the bump wiring end to end:
 * - with no contention, every service reports its default port, un-bumped
 * - when a bind fails with EACCES, the service moves one port up AND the
 *   bump is recorded (service, requested port, actual port, reason)
 * - `buildServerPortsStatus()` — the shape `/api/server-ports` and the
 *   app's persistent notice read — reflects the live ports and the bump
 * - the pairing-info routes carry the same live port fields
 *
 * Run: npm run test:server-ports
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-server-ports-'));

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

const {
  assertOrThrow,
  assertEqualOrThrow,
  assertGreaterThanOrThrow,
  getResults,
} = require('./helpers/test-setup');

async function run(): Promise<void> {
  const { startServer, stopServer, getServerPort } = await import('../main/server');
  const { startKdsServer, stopKdsServer, getKdsPort } = await import('../main/kds-server');
  const { startServerApp, stopServerApp, getServerAppPort } = await import('../main/server-app');
  const { initDatabase, closeDatabase } = await import('../main/db');
  const { buildServerPortsStatus } = await import('../main/routes/server-ports');
  const { getPortBumps, getLatestPortBump } = await import('../main/server-state');

  // Fail the first listen() of each server instance once with EACCES, so
  // every service bumps exactly one port. (The shared collision suite
  // fails only the first listen overall; here each service must move.)
  const originalListen = http.Server.prototype.listen;
  const failedServers = new WeakSet<object>();
  function simulateEaccesOncePerServer(): () => void {
    http.Server.prototype.listen = function (this: http.Server, ...args: any[]) {
      if (!failedServers.has(this)) {
        failedServers.add(this);
        process.nextTick(() => {
          const err: NodeJS.ErrnoException = new Error('listen EACCES: permission denied 0.0.0.0');
          err.code = 'EACCES';
          err.syscall = 'listen';
          this.emit('error', err);
        });
        return this;
      }
      return (originalListen as any).apply(this, args);
    };
    return () => {
      http.Server.prototype.listen = originalListen;
    };
  }

  try {
    initDatabase();

    // 1. No contention yet: every service sits on its default port.
    const baseline = buildServerPortsStatus();
    assertEqualOrThrow(baseline.api.port, 3001, 'API starts on its default port');
    assertEqualOrThrow(baseline.kds.port, 3002, 'KDS starts on its default port');
    assertEqualOrThrow(baseline.server_app.port, 3003, 'Server App starts on its default port');
    assertOrThrow(!baseline.api.port_bumped, 'API is un-bumped before any contention');
    assertOrThrow(!baseline.kds.port_bumped, 'KDS is un-bumped before any contention');
    assertOrThrow(
      !baseline.server_app.port_bumped,
      'Server App is un-bumped before any contention',
    );
    assertEqualOrThrow(getPortBumps().length, 0, 'no bump is recorded before any contention');

    // 2. Every service loses its first bind and must move — and record it.
    const restoreListen = simulateEaccesOncePerServer();
    try {
      await startServer();
      await startKdsServer();
      await startServerApp();
    } finally {
      restoreListen();
    }

    const status = buildServerPortsStatus();
    for (const [key, service, requested] of [
      ['api', 'api', 3001],
      ['kds', 'kds', 3002],
      ['server_app', 'server-app', 3003],
    ] as const) {
      const entry = status[key];
      assertOrThrow(entry.port_bumped, `${service} reports bumped after losing its bind`);
      assertGreaterThanOrThrow(
        entry.port,
        requested,
        `${service} moved above its requested port ${requested}`,
      );
      assertEqualOrThrow(
        entry.requested_port,
        requested,
        `${service} still reports the port it first tried`,
      );
      const bump = getLatestPortBump(service);
      assertOrThrow(bump !== null, `${service} recorded its bump`);
      assertEqualOrThrow(
        bump!.requestedPort,
        requested,
        `${service} bump records the requested port`,
      );
      assertEqualOrThrow(
        bump!.actualPort,
        entry.port,
        `${service} bump records the port it actually bound`,
      );
      assertEqualOrThrow(bump!.reason, 'EACCES', `${service} bump records the bind failure`);
    }
    assertEqualOrThrow(getPortBumps().length, 3, 'one bump recorded per service');

    // 3. The live getters agree with the status shape the UI reads.
    assertEqualOrThrow(getServerPort(), status.api.port, 'API getter matches the status port');
    assertEqualOrThrow(getKdsPort(), status.kds.port, 'KDS getter matches the status port');
    assertEqualOrThrow(
      getServerAppPort(),
      status.server_app.port,
      'Server App getter matches the status port',
    );

    const results = getResults();
    console.log(`\nserver-ports: ${results.passed} passed, ${results.failed} failed`);
    if (results.failed > 0) process.exit(1);
  } finally {
    try {
      await stopServerApp();
    } catch {
      // Best effort; the process exits either way.
    }
    try {
      await stopKdsServer();
    } catch {
      // See above.
    }
    try {
      await stopServer();
    } catch {
      // See above.
    }
    try {
      closeDatabase();
    } catch {
      // See above.
    }
    http.Server.prototype.listen = originalListen;
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  http.Server.prototype.listen = originalListen;
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
