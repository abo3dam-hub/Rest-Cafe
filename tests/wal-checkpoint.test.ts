/**
 * Delivery 4 (assignment 037): WAL checkpoint on database close (R-02).
 *
 * Pins the shutdown durability contract with two shapes:
 * - Clean close: rows written after startup sit in the WAL until the
 *   close; `closeDatabase()` checkpoints it, so afterwards the `-wal`
 *   file is empty or gone and the rows survive a fresh open.
 * - Forced termination: a child that writes a row and is SIGKILLed without
 *   any close still leaves the row recoverable on reopen — the WAL
 *   replay shape an unexpected Windows shutdown depends on.
 *
 * Run: npm run test:wal-checkpoint
 */

import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-wal-checkpoint-'));

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

import { closeDatabase, getDatabase, getDbPath, initDatabase } from '../main/db';

const Database = require('better-sqlite3');

function walSize(dbPath: string): number {
  const walPath = `${dbPath}-wal`;
  return fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
}

function readMarker(dbPath: string, marker: string): string | null {
  const db = new Database(dbPath);
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as {
      integrity_check: string;
    }[];
    assertOrThrow(
      integrity.every((row) => row.integrity_check === 'ok'),
      `integrity_check is ok on reopen (${dbPath})`,
    );
    const row = db.prepare('SELECT value FROM wal_probe WHERE key = ?').get(marker) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

async function waitForReady(
  child: ReturnType<typeof spawn>,
  output: { text: string },
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`wal-checkpoint child timed out: ${output.text}`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      output.text += chunk.toString();
      if (output.text.includes('WAL_CHILD_READY')) {
        clearTimeout(timer);
        child.stdout?.off('data', onData);
        child.stderr?.off('data', onData);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function run(): Promise<void> {
  const killDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-wal-kill-'));
  try {
    // 1. Clean close checkpoints the WAL: rows written after startup are
    //    in the journal until the close, then merged.
    initDatabase();
    const dbPath = getDbPath();
    const db = getDatabase();
    db.exec('CREATE TABLE IF NOT EXISTS wal_probe (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO wal_probe (key, value) VALUES (?, ?)').run(
      'clean-close',
      'checkpointed',
    );
    const walBeforeClose = walSize(dbPath);
    assertGreaterThanOrThrow(
      walBeforeClose,
      0,
      'rows written after startup sit in the WAL before the close',
    );
    closeDatabase();
    assertEqualOrThrow(
      walSize(dbPath),
      0,
      'closeDatabase() checkpoints the WAL away (empty or gone)',
    );
    assertEqualOrThrow(
      readMarker(dbPath, 'clean-close'),
      'checkpointed',
      'the checkpointed row survives a fresh open',
    );

    // 2. Forced termination: the child writes a row, never closes, and is
    //    SIGKILLed. The row must still be recoverable from the WAL.
    const killDbPath = path.join(killDir, 'flo.db');
    const child = spawn(
      process.execPath,
      [
        path.join(__dirname, 'wal-checkpoint-child.cjs'),
        '--db-path',
        killDbPath,
        '--marker',
        'forced-termination',
      ],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const output = { text: '' };
    try {
      await waitForReady(child, output, 60_000);
      child.kill('SIGKILL');
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(
        (resolve) => {
          child.once('exit', (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
        },
      );
      assertEqualOrThrow(signal, 'SIGKILL', 'the child died by the kill, not by exiting');
      assertEqualOrThrow(code, null, 'a SIGKILLed child has no exit code');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    assertEqualOrThrow(
      readMarker(killDbPath, 'forced-termination'),
      'recovered',
      'a row committed before SIGKILL is recovered from the WAL on reopen',
    );

    const results = getResults();
    console.log(`\nwal-checkpoint: ${results.passed} passed, ${results.failed} failed`);
    if (results.failed > 0) process.exit(1);
  } finally {
    try {
      closeDatabase();
    } catch {
      // Already closed or never opened; cleanup continues regardless.
    }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(killDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  try {
    closeDatabase();
  } catch {
    // See above.
  }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
