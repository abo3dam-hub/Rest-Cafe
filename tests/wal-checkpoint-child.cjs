/**
 * Child for tests/wal-checkpoint.test.ts (R-02, forced-termination shape).
 *
 * Opens the database at --db-path, writes one marker row into wal_probe,
 * prints WAL_CHILD_READY, then hangs WITHOUT closing the database until
 * the parent SIGKILLs it. The parent then reopens the file and asserts the
 * row is recovered from the WAL.
 *
 * Spawned with the Electron binary as Node (ELECTRON_RUN_AS_NODE=1), like
 * tests/database-import-shutdown-child.cjs.
 */
const path = require('node:path');
const Module = require('node:module');

const args = process.argv.slice(2);
function argValue(name) {
  const index = args.indexOf(name);
  if (index === -1 || index + 1 >= args.length) {
    throw new Error(`wal-checkpoint-child: missing ${name} <value>`);
  }
  return args[index + 1];
}

const dbPath = argValue('--db-path');
const marker = argValue('--marker');
const testDir = path.dirname(dbPath);
process.env.FLO_E2E_DB_PATH = dbPath;

const originalLoad = Module._load;
const mockApp = {
  isPackaged: true,
  getPath: () => testDir,
  getVersion: () => 'test',
};

Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: mockApp,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value) => Buffer.from(value),
        decryptString: (value) => value.toString(),
      },
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  return originalLoad.apply(this, arguments);
};

require('ts-node').register({
  transpileOnly: true,
  project: path.join(__dirname, 'tsconfig.json'),
});

const dbModule = require('../main/db');

async function run() {
  dbModule.initDatabase();
  const db = dbModule.getDatabase();
  db.exec('CREATE TABLE IF NOT EXISTS wal_probe (key TEXT PRIMARY KEY, value TEXT)');
  db.prepare('INSERT INTO wal_probe (key, value) VALUES (?, ?)').run(marker, 'recovered');
  // The row is committed to the WAL here; the process must NOT close the
  // database before the parent kills it — that is the shape under test.
  console.log('WAL_CHILD_READY');
  await new Promise(() => {});
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
