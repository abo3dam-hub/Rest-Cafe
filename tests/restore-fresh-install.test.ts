/**
 * Restore onto a fresh install / replacement host (assignment 037, Delivery 6: F-022).
 *
 * The runbook case: a store's host dies, a fresh install is put on a
 * replacement machine, and the latest backup is restored. The backup's
 * owner account and data must survive the security-state merge — on a
 * fresh install there is no live security state to protect, so the merge
 * must not disable every restored user (which would lock the operator
 * out: login fails on an inactive owner, and first-run setup refuses
 * because a user row already exists).
 *
 * The old rule still applies when the live database HAS users: accounts
 * that exist only in the backup stay disabled after the restore.
 *
 * Run: npm run test:restore-fresh-install
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Database = require('better-sqlite3');

// Mock electron before importing any app modules
const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-restore-fresh-install-'));
const mockApp = { isPackaged: true, getPath: (_name: string) => testDir, getVersion: () => 'test' };
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') return { app: mockApp };
  return originalLoad.apply(this, arguments as any);
};

const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');
const {
  initDatabase,
  getDatabase,
  getDbPath,
  getCurrentSchemaVersion,
  closeDatabase,
  createBackup,
  restoreBackup,
} = require('../main/db');

function seedSourceStore(): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO users (id, name, email, password, pin_hash, role, is_active, created_at, updated_at)
     VALUES ('fresh-owner', 'Fresh Owner', 'owner@fresh.local', 'owner-hash', 'owner-pin-hash', 'owner', 1, datetime('now'), datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('fresh-chef', 'Fresh Chef', 'chef@fresh.local', 'chef-hash', 'chef', 1, datetime('now'), datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO kitchen_stations (id, name, category_ids, is_active, created_at, updated_at)
     VALUES ('fresh-station', 'Fresh Station', '[]', 1, datetime('now'), datetime('now'))`,
  ).run();
  db.prepare(
    `INSERT INTO station_users (user_id, station_id, created_at)
     VALUES ('fresh-chef', 'fresh-station', datetime('now'))`,
  ).run();
  db.prepare('INSERT INTO categories (id, name) VALUES (?, ?)').run(
    'fresh-category',
    'Fresh Category',
  );
  db.prepare('INSERT INTO products (id, category_id, name, price) VALUES (?, ?, ?, ?)').run(
    'fresh-product',
    'fresh-category',
    'Fresh Product',
    12.5,
  );
  db.prepare(
    `INSERT INTO orders (order_number, type, status, subtotal, total, created_at, updated_at)
     VALUES (?, 'takeaway', 'pending', ?, ?, datetime('now'), datetime('now'))`,
  ).run('FRESH-001', 12.5, 12.5);
  const order = db.prepare('SELECT id FROM orders WHERE order_number = ?').get('FRESH-001') as {
    id: number;
  };
  db.prepare(
    `INSERT INTO order_items
       (order_id, product_id, product_name, unit_price, quantity, subtotal, total, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, 'pending', datetime('now'), datetime('now'))`,
  ).run(order.id, 'fresh-product', 'Fresh Product', 12.5, 12.5, 12.5);
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('business_name', 'Fresh Store', datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run();
}

function userRow(id: string) {
  return getDatabase().prepare('SELECT * FROM users WHERE id = ?').get(id) as
    | { is_active: number; password: string; pin_hash: string | null; email: string }
    | undefined;
}

/** Wipe the live database and its first-start marker, as a fresh install has. */
function wipeLiveDatabase(): void {
  closeDatabase();
  const dbPath = getDbPath();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(`${dbPath}${suffix}`);
    } catch {}
  }
  try {
    fs.unlinkSync(path.join(testDir, '.flo-db-initialized'));
  } catch {}
}

async function main() {
  console.log('Testing restore onto a fresh install (F-022)...');
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

  seedSourceStore();
  const currentVersion = getCurrentSchemaVersion();
  const { path: backupPath } = await createBackup();
  const backupCopy = path.join(testDir, 'fresh-install-backup.db');
  fs.copyFileSync(backupPath, backupCopy);

  // ── Simulate the replacement host: a fresh install with no users yet ──
  wipeLiveDatabase();
  initDatabase();
  assertEqualOrThrow(
    (getDatabase().prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number }).count,
    0,
    'F-022: the fresh install has no users before the restore',
  );

  const restored = restoreBackup(backupCopy, true);
  assertEqualOrThrow(restored.success, true, 'F-022: the fresh-install restore succeeds');
  assertEqualOrThrow(
    getCurrentSchemaVersion(),
    currentVersion,
    'F-022: the schema version is unchanged by the restore',
  );

  // ── The backup's owner account survives the merge, usable ──
  const owner = userRow('fresh-owner');
  assertOrThrow(!!owner, 'F-022: the backup owner account exists after the restore');
  assertEqualOrThrow(owner.is_active, 1, 'F-022: the backup owner stays active on a fresh install');
  assertEqualOrThrow(owner.password, 'owner-hash', 'F-022: the owner password hash survives');
  assertEqualOrThrow(owner.pin_hash, 'owner-pin-hash', 'F-022: the owner PIN hash survives');
  assertEqualOrThrow(owner.email, 'owner@fresh.local', 'F-022: the owner email survives');

  // ── The other staff account and its station assignment survive too ──
  const chef = userRow('fresh-chef');
  assertOrThrow(!!chef, 'F-022: the backup chef account exists after the restore');
  assertEqualOrThrow(chef.is_active, 1, 'F-022: the backup chef stays active on a fresh install');
  assertEqualOrThrow(chef.password, 'chef-hash', 'F-022: the chef password hash survives');
  const assignment = getDatabase()
    .prepare('SELECT station_id FROM station_users WHERE user_id = ?')
    .get('fresh-chef') as { station_id: string } | undefined;
  assertOrThrow(!!assignment, 'F-022: the chef station assignment survives the restore');
  assertEqualOrThrow(
    assignment.station_id,
    'fresh-station',
    'F-022: the chef keeps the backup station',
  );

  // ── The backup's data survives ──
  assertEqualOrThrow(
    (
      getDatabase().prepare('SELECT name FROM products WHERE id = ?').get('fresh-product') as {
        name: string;
      }
    ).name,
    'Fresh Product',
    'F-022: the backup product survives',
  );
  assertEqualOrThrow(
    (
      getDatabase()
        .prepare('SELECT status FROM orders WHERE order_number = ?')
        .get('FRESH-001') as {
        status: string;
      }
    ).status,
    'pending',
    'F-022: the backup order survives',
  );
  assertEqualOrThrow(
    (
      getDatabase().prepare('SELECT value FROM settings WHERE key = ?').get('business_name') as {
        value: string;
      }
    ).value,
    'Fresh Store',
    'F-022: the backup business name survives',
  );

  // ── Boundary: once the live database HAS users, the old rule still applies ──
  // A user that exists only in the backup must stay disabled after a restore
  // onto a live store (it must not become a new login path on its own).
  const backupOnlyCopy = path.join(testDir, 'backup-only-user.db');
  fs.copyFileSync(backupCopy, backupOnlyCopy);
  const backupDb = new Database(backupOnlyCopy);
  backupDb.pragma('foreign_keys = OFF');
  backupDb
    .prepare(
      `INSERT INTO users (id, name, email, password, role, is_active, created_at, updated_at)
       VALUES ('backup-only-chef', 'Backup Only Chef', 'backup-only-chef@fresh.local', 'test-hash', 'chef', 1, datetime('now'), datetime('now'))`,
    )
    .run();
  backupDb.close();
  const secondRestore = restoreBackup(backupOnlyCopy, true);
  assertEqualOrThrow(secondRestore.success, true, 'F-022: the second restore succeeds');
  const backupOnly = userRow('backup-only-chef');
  assertOrThrow(!!backupOnly, 'F-022: the backup-only user is present after the restore');
  assertEqualOrThrow(
    backupOnly.is_active,
    0,
    'F-022: a backup-only user stays disabled when the live store already has users',
  );
  const ownerAfterSecond = userRow('fresh-owner');
  assertEqualOrThrow(
    ownerAfterSecond?.is_active,
    1,
    'F-022: the live owner stays active through the second restore',
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
