import Database from 'better-sqlite3';
import type { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';
import * as fs from 'fs';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { SHUTDOWN_TIMEOUT_MS } from '../shutdown';
import {
  businessDateForInstant,
  dayBoundsInTimezone,
  utcDayBounds,
} from '../../shared/business-date';
import { getCurrencyFractionDigits, resolveRegionalSnapshot } from '../countries';
import { getBackupDir, isSafeIdentifier, recoverInterruptedDatabaseReplacement } from './backup';
import {
  bumpSettingsRevision,
  getSettingValue,
  registerSettingsRevisionTriggers,
  upsertSetting,
} from './settings';
import { runMigrations } from './migrations';

let db: Database.Database;
let dbHealthError: string | null = null;

// Internal accessor for the split db/* modules: returns the live instance
// without the getDatabase() shutdown/initialized guards, matching direct `db` use.
export function getRawDatabase(): Database.Database {
  return db;
}

// Database backup, restore, and wipe operations must not overlap. The lock is
// a FIFO promise chain so a rejected operation cannot strand later work.
let databaseMaintenanceTail: Promise<void> = Promise.resolve();
let databaseMaintenanceActive = false;
let databaseMaintenancePending = 0;
let activeDatabaseRequests = 0;
let databaseShutdownRequested = false;
const databaseShutdownController = new AbortController();
let maintenanceRequestWaiters: (() => void)[] = [];
let maintenanceDrainWaiters: (() => void)[] = [];
let databaseIdleWaiters: (() => void)[] = [];
const databaseMaintenanceStartListeners = new Set<() => void>();
const databaseMaintenanceEndListeners = new Set<() => void>();

function releaseMaintenanceDrainWaiters(): void {
  if (activeDatabaseRequests !== 0) return;
  const waiters = maintenanceDrainWaiters;
  maintenanceDrainWaiters = [];
  waiters.forEach((resolve) => resolve());
}

function releaseMaintenanceRequestWaiters(): void {
  if (activeDatabaseRequests !== 0 || databaseMaintenanceActive || databaseMaintenancePending !== 0)
    return;
  const waiters = maintenanceRequestWaiters;
  maintenanceRequestWaiters = [];
  waiters.forEach((resolve) => resolve());
}

function releaseDatabaseIdleWaiters(): void {
  if (activeDatabaseRequests !== 0 || databaseMaintenanceActive || databaseMaintenancePending !== 0)
    return;
  const waiters = databaseIdleWaiters;
  databaseIdleWaiters = [];
  waiters.forEach((resolve) => resolve());
}

export function createMaintenanceAbortError(): Error & { code: string } {
  const error = new Error('Database maintenance cancelled during shutdown') as Error & {
    code: string;
  };
  error.code = 'ERR_SHUTDOWN_ABORTED';
  return error;
}

export function throwIfDatabaseMaintenanceAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw createMaintenanceAbortError();
}

function createDatabaseShutdownError(): Error & { code: string } {
  const error = new Error('Database access is closed during shutdown') as Error & { code: string };
  error.code = 'ERR_SHUTDOWN_ABORTED';
  return error;
}

function createDatabaseShutdownTimeoutError(): Error & { code: string } {
  const error = new Error(`Database shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`) as Error & {
    code: string;
  };
  error.code = 'ERR_SHUTDOWN_TIMEOUT';
  return error;
}

// Refuse to silently open a blank database when an initialized database file goes missing.
function createDatabaseMissingError(dbPath: string): Error & { code: string } {
  const error = new Error(
    `Database file is missing at ${dbPath}, but this install was previously initialized. ` +
      'Refusing to start with a new, empty database to avoid silently losing existing data. ' +
      'Restore from a backup (Settings → Backup & Restore, or the backups folder) and restart Rest&Cafe.',
  ) as Error & { code: string };
  error.code = 'ERR_DATABASE_MISSING';
  return error;
}

// Maintenance operations bound wait times when draining active database requests.
export const MAINTENANCE_DRAIN_TIMEOUT_MS = SHUTDOWN_TIMEOUT_MS;

function createMaintenanceDrainTimeoutError(timeoutMs: number): Error & { code: string } {
  const error = new Error(
    `Database maintenance timed out after ${timeoutMs}ms waiting for active requests to drain`,
  ) as Error & { code: string };
  error.code = 'ERR_MAINTENANCE_DRAIN_TIMEOUT';
  return error;
}

export function beginDatabaseShutdown(): void {
  databaseShutdownRequested = true;
  databaseShutdownController.abort();
}

function getMaintenanceSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, databaseShutdownController.signal])
    : databaseShutdownController.signal;
}

function waitForActiveDatabaseRequests(signal: AbortSignal, timeoutMs?: number): Promise<void> {
  if (activeDatabaseRequests === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
      if (timeout !== undefined) clearTimeout(timeout);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      const index = maintenanceDrainWaiters.indexOf(finish);
      if (index >= 0) maintenanceDrainWaiters.splice(index, 1);
      cleanup();
      reject(createMaintenanceAbortError());
    };
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = maintenanceDrainWaiters.indexOf(finish);
        if (index >= 0) maintenanceDrainWaiters.splice(index, 1);
        cleanup();
        reject(createMaintenanceDrainTimeoutError(timeoutMs));
      }, timeoutMs);
    }
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    maintenanceDrainWaiters.push(finish);
  });
}

export function withDatabaseRequest<T>(
  operation: () => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (databaseShutdownRequested || signal?.aborted)
    return Promise.reject(createDatabaseShutdownError());
  const run = (): Promise<T> => {
    // Reserve the request synchronously. A maintenance lock scheduled in the
    // same turn must observe this request before it starts replacing the DB.
    activeDatabaseRequests += 1;
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        activeDatabaseRequests = Math.max(0, activeDatabaseRequests - 1);
        releaseMaintenanceDrainWaiters();
        releaseMaintenanceRequestWaiters();
        releaseDatabaseIdleWaiters();
      });
  };
  if (!databaseMaintenanceActive) return run();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let waiter!: () => void;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      const index = maintenanceRequestWaiters.indexOf(waiter);
      if (index >= 0) maintenanceRequestWaiters.splice(index, 1);
      signal?.removeEventListener('abort', onAbort);
      reject(createMaintenanceAbortError());
    };
    waiter = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (databaseShutdownRequested) {
        reject(createDatabaseShutdownError());
        return;
      }
      run().then(resolve, reject);
    };
    maintenanceRequestWaiters.push(waiter);
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function registerDatabaseMaintenanceStartListener(listener: () => void): () => void {
  databaseMaintenanceStartListeners.add(listener);
  return () => databaseMaintenanceStartListeners.delete(listener);
}

export function registerDatabaseMaintenanceEndListener(listener: () => void): () => void {
  databaseMaintenanceEndListeners.add(listener);
  return () => databaseMaintenanceEndListeners.delete(listener);
}

export function isDatabaseMaintenanceActive(): boolean {
  return databaseMaintenanceActive;
}

const DATABASE_MAINTENANCE_ROUTES = new Set([
  'POST /api/db/import',
  'POST /api/db/backup',
  'POST /api/db/restore',
  'GET /api/db/download',
  'POST /api/db-tools/initialize',
  'POST /api/db-tools/currency-reset',
]);

function isDatabaseMaintenanceRoute(req: Request): boolean {
  // Lowercased for the same reason as requireAuth: the mount is case-insensitive,
  // so an exact-match lookup on the raw spelling misses case variants.
  // Trailing slash is normalized to match Express route handling.
  const rawPath = ((req.baseUrl || '') + (req.path || '')).toLowerCase();
  const fullPath =
    rawPath.length > 1 && rawPath.endsWith('/') ? rawPath.replace(/\/+$/, '') : rawPath;
  const method = String(req.method || '').toUpperCase();
  return DATABASE_MAINTENANCE_ROUTES.has(`${method} ${fullPath}`);
}

export interface DatabaseAdmissionReservation {
  retain(): boolean;
  release(): void;
  isReleased(): boolean;
}

class DatabaseAdmissionReservationImpl implements DatabaseAdmissionReservation {
  private refCount = 1;
  private released = false;

  retain(): boolean {
    if (this.released) return false;
    this.refCount += 1;
    return true;
  }

  isReleased(): boolean {
    return this.released;
  }

  release(): void {
    if (this.released) return;
    this.refCount -= 1;
    if (this.refCount <= 0) {
      this.released = true;
      activeDatabaseRequests = Math.max(0, activeDatabaseRequests - 1);
      releaseMaintenanceDrainWaiters();
      releaseMaintenanceRequestWaiters();
      releaseDatabaseIdleWaiters();
    }
  }
}

function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.startsWith('::ffff:') ? ip.substring(7) : ip;
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.');
}

const MAINTENANCE_HANDOFF_TTL_MS = 15_000;

interface MaintenanceHandoffEntry {
  reservation: DatabaseAdmissionReservation;
  expiresAt: number;
}

const activeMaintenanceHandoffs = new Map<string, MaintenanceHandoffEntry>();

function sweepExpiredMaintenanceHandoffs(): void {
  const now = Date.now();
  for (const [token, entry] of activeMaintenanceHandoffs.entries()) {
    if (entry.expiresAt <= now) {
      activeMaintenanceHandoffs.delete(token);
      entry.reservation.release();
    }
  }
}

export function createDatabaseMaintenanceHandoff(
  reservation: DatabaseAdmissionReservation,
): string | null {
  if (reservation.isReleased()) return null;
  if (!reservation.retain()) return null;
  sweepExpiredMaintenanceHandoffs();
  const token = crypto.randomUUID();
  activeMaintenanceHandoffs.set(token, {
    reservation,
    expiresAt: Date.now() + MAINTENANCE_HANDOFF_TTL_MS,
  });
  return token;
}

export function consumeDatabaseMaintenanceHandoff(
  token: string,
): DatabaseAdmissionReservation | null {
  const entry = activeMaintenanceHandoffs.get(token);
  if (!entry) return null;
  activeMaintenanceHandoffs.delete(token);
  if (Date.now() > entry.expiresAt || entry.reservation.isReleased()) {
    entry.reservation.release();
    return null;
  }
  return entry.reservation;
}

export function revokeDatabaseMaintenanceHandoff(token: string): void {
  const entry = activeMaintenanceHandoffs.get(token);
  if (entry) {
    activeMaintenanceHandoffs.delete(token);
    entry.reservation.release();
  }
}

export function getActiveDatabaseRequestsCount(): number {
  return activeDatabaseRequests;
}

export function databaseMaintenanceMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const fullPath = ((req.baseUrl || '') + req.path).toLowerCase();
  if (!fullPath.startsWith('/api')) {
    next();
    return;
  }

  if (databaseShutdownRequested) {
    res.status(503).json({ error: 'Database is shutting down' });
    return;
  }

  // Trusted internal loopback handoff from Server App (:3003) to Main API (:3001)
  const rawHandoffHeader = req.headers?.['x-flo-maintenance-handoff'];
  let handoffReservation: DatabaseAdmissionReservation | null = null;
  if (typeof rawHandoffHeader === 'string' && isLoopbackAddress(req.socket?.remoteAddress)) {
    handoffReservation = consumeDatabaseMaintenanceHandoff(rawHandoffHeader);
  }

  // Reject requests while maintenance is active unless already admitted via trusted handoff.
  if (!handoffReservation && databaseMaintenanceActive) {
    res.status(503).json({ error: 'Database maintenance in progress' });
    return;
  }

  // Maintenance route handlers acquire the FIFO lock themselves; exclude from active count.
  if (isDatabaseMaintenanceRoute(req)) {
    if (handoffReservation) {
      handoffReservation.release();
    }
    next();
    return;
  }

  let reservation: DatabaseAdmissionReservation;
  if (handoffReservation) {
    // Ticket hold transferred to this inner request — no extra retain or activeDatabaseRequests increment needed.
    reservation = handoffReservation;
  } else {
    activeDatabaseRequests += 1;
    reservation = new DatabaseAdmissionReservationImpl();
  }

  (req as any).databaseAdmissionReservation = reservation;

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    reservation.release();
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

export function withDatabaseMaintenanceLock<T>(
  operation: (signal: AbortSignal) => T | Promise<T>,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  if (databaseShutdownRequested) return Promise.reject(createMaintenanceAbortError());
  const maintenanceSignal = getMaintenanceSignal(signal);
  const previous = databaseMaintenanceTail;
  databaseMaintenancePending += 1;
  let started = false;
  let release!: () => void;
  databaseMaintenanceTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous
    .then(async () => {
      if (maintenanceSignal.aborted || databaseShutdownRequested)
        throw createMaintenanceAbortError();
      started = true;
      databaseMaintenanceActive = true;
      for (const listener of databaseMaintenanceStartListeners) {
        try {
          listener();
        } catch (error) {
          console.error('[DB] Maintenance listener failed:', error);
        }
      }
      try {
        // Drain requests in flight before maintenance started.
        if (activeDatabaseRequests > 0) {
          await waitForActiveDatabaseRequests(
            maintenanceSignal,
            timeoutMs ?? MAINTENANCE_DRAIN_TIMEOUT_MS,
          );
        }
        if (maintenanceSignal.aborted || databaseShutdownRequested)
          throw createMaintenanceAbortError();
        return await operation(maintenanceSignal);
      } finally {
        databaseMaintenanceActive = false;
        for (const listener of databaseMaintenanceEndListeners) {
          try {
            listener();
          } catch (error) {
            console.error('[DB] Maintenance end listener failed:', error);
          }
        }
        releaseMaintenanceRequestWaiters();
        releaseDatabaseIdleWaiters();
      }
    })
    .finally(() => {
      databaseMaintenancePending = Math.max(0, databaseMaintenancePending - 1);
      release();
      releaseMaintenanceRequestWaiters();
      releaseDatabaseIdleWaiters();
    });
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (started || settled) return;
      settled = true;
      maintenanceSignal.removeEventListener('abort', onAbort);
      reject(createMaintenanceAbortError());
    };
    if (maintenanceSignal.aborted) onAbort();
    else maintenanceSignal.addEventListener('abort', onAbort, { once: true });
    queued.then(
      (value) => {
        if (settled) return;
        settled = true;
        maintenanceSignal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        maintenanceSignal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

// Internal db-swap seam for buildIdealSchemaDb (main/db/migrations.ts): swaps
// the live instance and returns the previous one, preserving the exact
// swap/restore semantics (try/finally) of the original direct assignment.
// Not re-exported from main/db.ts.
export function setRawDatabase(next: Database.Database): Database.Database {
  const previous = db;
  db = next;
  return previous;
}

export function getDbHealth(): { ok: boolean; error?: string } {
  if (!db) return { ok: false, error: 'Database not initialized' };
  if (dbHealthError) return { ok: false, error: dbHealthError };
  return { ok: true };
}

export function getDbPath(): string {
  // Native Playwright owns this path for its disposable local Electron run.
  // It is intentionally opt-in and has no effect on normal desktop installs.
  if (process.env.FLO_E2E_DB_PATH) return path.resolve(process.env.FLO_E2E_DB_PATH);
  // One level deeper than main/db.ts: resolve one extra level per layout.
  const projectRoot =
    path.basename(path.dirname(path.dirname(__dirname))) === 'dist'
      ? path.resolve(__dirname, '../../..')
      : path.resolve(__dirname, '../..');
  const userDataPath = app.isPackaged ? app.getPath('userData') : projectRoot;
  return path.join(userDataPath, 'flo.db');
}

// Marker written on first startup to distinguish empty fresh install from missing db file.
function getDbInitializedMarkerPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, '.flo-db-initialized');
}

export function registerOrderSearchFunctions(dbInstance: Database.Database): void {
  try {
    dbInstance.function('orders_search_contains', (value: string | null, query: string) =>
      typeof value === 'string' && value.toLowerCase().includes(query.toLowerCase()) ? 1 : 0,
    );
    dbInstance.function('orders_search_digits_contains', (value: string | null, digits: string) =>
      typeof value === 'string' && value.replace(/\D/g, '').includes(digits) ? 1 : 0,
    );
  } catch {
    // Function already registered or connection closed
  }
}

export function initDatabase(
  recoverInterruptedReplacement = true,
  allowDuringShutdown = false,
): void {
  if (databaseShutdownRequested && !allowDuringShutdown) throw createDatabaseShutdownError();
  const dbPath = getDbPath();
  const backupDir = getBackupDir();

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  if (recoverInterruptedReplacement) recoverInterruptedDatabaseReplacement(dbPath, backupDir);

  // Startup guard: prevent silent recreation of missing database if previously initialized.
  const isProductionStartup =
    recoverInterruptedReplacement && app.isPackaged && !process.env.FLO_E2E_DB_PATH;
  if (
    isProductionStartup &&
    !fs.existsSync(dbPath) &&
    fs.existsSync(getDbInitializedMarkerPath())
  ) {
    throw createDatabaseMissingError(dbPath);
  }

  console.log(`[DB] Opening database at: ${dbPath}`);
  dbHealthError = null;
  db = new Database(dbPath);
  bumpSettingsRevision();
  registerOrderSearchFunctions(db);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = OFF'); // Off during migrations

  runMigrations();

  db.pragma('foreign_keys = ON');
  registerSettingsRevisionTriggers(db);

  runStartupIntegrityCheck();
  repairSequences();
  autoRepairPaymentDetails();
  autoRepairDefaultPrinter();

  if (app.isPackaged && !process.env.FLO_E2E_DB_PATH) {
    const markerPath = getDbInitializedMarkerPath();
    try {
      fs.writeFileSync(markerPath, now());
    } catch {
      // Retry writing marker once on transient filesystem errors.
      try {
        fs.writeFileSync(markerPath, now());
      } catch (retryErr) {
        console.error('[DB] Failed to write init marker after retry:', retryErr);
        log.error(
          '[DB] Failed to write .flo-db-initialized marker after retry — the #278 ' +
            'missing-database guard will not protect this install until a future boot succeeds:',
          retryErr,
        );
      }
    }
  }
}

/** Locally-cached RevFlo pairing code (plaintext) — FloAdmin only ever returns it once. */

/** Random UUID, generated once and persisted — never derived from store/device identity. */

/** Atomic multi-statement mutation. Use for anything touching >1 row or >1 table. */
export function withTxn<T>(fn: () => T): T {
  return db.transaction(fn)();
}

/** Safely append an object to a JSON-array column. Creates the array if missing/invalid. */
export function appendJsonArray(
  table: string,
  idColumn: string,
  idValue: any,
  column: string,
  value: any,
): void {
  // Validate identifiers to prevent SQL injection
  if (!isSafeIdentifier(table) || !isSafeIdentifier(idColumn) || !isSafeIdentifier(column)) {
    throw new Error(`Invalid identifier: table=${table}, idColumn=${idColumn}, column=${column}`);
  }
  const row = db
    .prepare(`SELECT ${column} AS v FROM ${table} WHERE ${idColumn} = ?`)
    .get(idValue) as any;
  let arr: any[] = [];
  if (row && row.v) {
    try {
      const parsed = JSON.parse(row.v);
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      arr = [];
    }
  }
  arr.push(value);
  db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${idColumn} = ?`).run(
    JSON.stringify(arr),
    idValue,
  );
}

/** Runs on every startup. Logs loud warnings but never throws — DB stays available even if dirty. */
function runStartupIntegrityCheck(): void {
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    const bad = integrity.filter((r) => r.integrity_check !== 'ok');
    if (bad.length > 0) {
      const msg = bad.map((r) => r.integrity_check).join('; ');
      console.error('[DB] ⚠ integrity_check reported issues:', msg);
      dbHealthError = `Database integrity error: ${msg}`;
    } else {
      console.log('[DB] integrity_check: ok');
    }

    const fkViolations = db.prepare('PRAGMA foreign_key_check').all() as any[];
    if (fkViolations.length > 0) {
      console.error(
        `[DB] ⚠ ${fkViolations.length} foreign-key violation(s):`,
        fkViolations.slice(0, 5),
      );
    } else {
      console.log('[DB] foreign_key_check: clean');
    }
  } catch (err: any) {
    console.error('[DB] Startup integrity check failed:', err.message);
  }
}

/**
 * Execute sequence repair queries directly inside SQLite.
 *
 * Coverage boundary: Reconstructs sequence counters for canonical daily order format
 * (`ORD-YYYYMMDD-NNNN`) and canonical daily bill format (`INV-YYYYMMDD-NNNN`).
 * Customized prefixes (e.g. `FAC-`, `BILL-`) or non-daily reset periods (`monthly`,
 * `financial_year`, `no_reset`) are not reconstructed from table scans; their counters
 * are managed dynamically in the sequences table.
 */
export function executeSequenceRepair(targetDb: Database.Database): {
  orderChanges: number;
  billChanges: number;
} {
  const orderInfo = targetDb
    .prepare(`
      INSERT INTO sequences (name, date, current_value)
      SELECT
        'orders' AS name,
        substr(order_number, 5, 8) AS date,
        MAX(CAST(substr(order_number, 14) AS INTEGER)) AS current_value
      FROM orders
      WHERE order_number GLOB 'ORD-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9]*'
        AND substr(order_number, 14) NOT GLOB '*[^0-9]*'
      GROUP BY substr(order_number, 5, 8)
      HAVING current_value > 0
      ON CONFLICT(name, date) DO UPDATE SET
        current_value = MAX(sequences.current_value, excluded.current_value)
    `)
    .run();

  const billInfo = targetDb
    .prepare(`
      INSERT INTO sequences (name, date, current_value)
      SELECT
        'bills' AS name,
        substr(bill_number, 5, 8) AS date,
        MAX(CAST(substr(bill_number, 14) AS INTEGER)) AS current_value
      FROM bills
      WHERE bill_number GLOB 'INV-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9]*'
        AND substr(bill_number, 14) NOT GLOB '*[^0-9]*'
      GROUP BY substr(bill_number, 5, 8)
      HAVING current_value > 0
      ON CONFLICT(name, date) DO UPDATE SET
        current_value = MAX(sequences.current_value, excluded.current_value)
    `)
    .run();

  return {
    orderChanges: orderInfo.changes,
    billChanges: billInfo.changes,
  };
}

/**
 * Re-seeds sequences table from existing orders and bills to fix unique constraint collisions.
 *
 * Uses SQL-level aggregation to eliminate JavaScript array materialization of historical IDs.
 * Ordinary boots verify sequence health and skip the full scan unless flagged as pending.
 */
export function repairSequences(force: boolean = false): {
  repaired: boolean;
  orderSequencesUpdated: number;
  billSequencesUpdated: number;
} {
  try {
    const isPending = getSettingValue('sequence_repair_pending') === '1';
    const isCompleted = Boolean(getSettingValue('sequence_repair_completed_at'));

    if (!force && !isPending && isCompleted) {
      // Check safety fallback: if sequences exist, or if there are no historical orders/bills,
      // skip scanning historical tables on ordinary boots.
      const hasSequences = Boolean(db.prepare('SELECT 1 FROM sequences LIMIT 1').get());
      if (hasSequences) {
        return { repaired: false, orderSequencesUpdated: 0, billSequencesUpdated: 0 };
      }
      const hasOrders = Boolean(db.prepare('SELECT 1 FROM orders LIMIT 1').get());
      const hasBills = Boolean(db.prepare('SELECT 1 FROM bills LIMIT 1').get());
      if (!hasOrders && !hasBills) {
        return { repaired: false, orderSequencesUpdated: 0, billSequencesUpdated: 0 };
      }
    }

    return withTxn(() => {
      const { orderChanges, billChanges } = executeSequenceRepair(db);

      upsertSetting('sequence_repair_completed_at', now());
      upsertSetting('sequence_repair_pending', '0');

      return {
        repaired: true,
        orderSequencesUpdated: orderChanges,
        billSequencesUpdated: billChanges,
      };
    });
  } catch (err) {
    console.error('[DB] repairSequences failed:', err);
    return { repaired: false, orderSequencesUpdated: 0, billSequencesUpdated: 0 };
  }
}

/** Idempotent auto-repair for the pre-fix payment_details corruption: `{A},{A}` → `[A]`.
 *  Only runs when rows are detected as malformed AND the deduped sum matches `paid_amount`. */
function autoRepairPaymentDetails(): void {
  try {
    const rows = db
      .prepare(
        `SELECT id, payment_details, paid_amount FROM bills WHERE payment_details IS NOT NULL AND payment_details != ''`,
      )
      .all() as any[];
    const toFix: { id: number; value: string }[] = [];

    for (const row of rows) {
      try {
        JSON.parse(row.payment_details);
        continue;
      } catch {}

      const wrapped = '[' + String(row.payment_details).replace(/\}\s*,\s*\{/g, '},{') + ']';
      let parsed: any[];
      try {
        parsed = JSON.parse(wrapped);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;

      const deduped: any[] = [];
      for (const p of parsed) {
        const prev = deduped[deduped.length - 1];
        if (
          prev &&
          prev.method === p.method &&
          prev.amount === p.amount &&
          prev.timestamp === p.timestamp
        )
          continue;
        deduped.push(p);
      }

      const dedupedSum = deduped.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const rawSum = parsed.reduce((s, p) => s + (Number(p.amount) || 0), 0);
      const chosen =
        Math.abs(dedupedSum - row.paid_amount) <= 0.02
          ? deduped
          : Math.abs(rawSum - row.paid_amount) <= 0.02
            ? parsed
            : null;
      if (!chosen) continue;

      toFix.push({ id: row.id, value: JSON.stringify(chosen) });
    }

    if (toFix.length === 0) return;

    const stmt = db.prepare(
      `UPDATE bills SET payment_details = ?, updated_at = datetime('now') WHERE id = ?`,
    );
    const tx = db.transaction((rows: { id: number; value: string }[]) => {
      for (const r of rows) stmt.run(r.value, r.id);
    });
    tx(toFix);
    console.log(`[DB] auto-repaired payment_details on ${toFix.length} bill(s)`);
  } catch (err: any) {
    console.error('[DB] autoRepairPaymentDetails failed:', err.message);
  }
}

/** Keep printer selection deterministic if an older install ended up with multiple defaults. */
function autoRepairDefaultPrinter(): void {
  try {
    const defaults = db
      .prepare(`
      SELECT id FROM printers
      WHERE is_default = 1
      ORDER BY CASE WHEN id = 'printer-1' AND name = 'Thermal Printer' THEN 1 ELSE 0 END ASC,
               COALESCE(updated_at, created_at, '') DESC,
               COALESCE(created_at, '') DESC,
               name COLLATE NOCASE ASC,
               id ASC
    `)
      .all() as { id: string }[];

    if (defaults.length <= 1) return;

    const keepId = defaults[0].id;
    db.prepare(`
      UPDATE printers
      SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END,
          updated_at = CASE WHEN id = ? THEN updated_at ELSE ? END
      WHERE is_default = 1
    `).run(keepId, keepId, now());

    console.log(`[DB] auto-repaired default printers; kept ${keepId}`);
  } catch (err: any) {
    console.error('[DB] autoRepairDefaultPrinter failed:', err.message);
  }
}

export function getDatabase(): Database.Database {
  if (databaseShutdownRequested) throw createDatabaseShutdownError();
  if (!db) throw new Error('Database not initialized');
  return db;
}

export function waitForDatabaseRequests(timeoutMs?: number): Promise<void> {
  if (
    activeDatabaseRequests === 0 &&
    !databaseMaintenanceActive &&
    databaseMaintenancePending === 0
  )
    return Promise.resolve();
  const drain = new Promise<void>((resolve) => databaseIdleWaiters.push(resolve));
  const effectiveTimeoutMs =
    timeoutMs ?? (databaseShutdownRequested ? SHUTDOWN_TIMEOUT_MS : undefined);
  if (effectiveTimeoutMs === undefined) return drain;
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(createDatabaseShutdownTimeoutError()),
      effectiveTimeoutMs,
    );
    drain.then(
      () => {
        clearTimeout(timeout);
        resolve();
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null as unknown as Database.Database;
    bumpSettingsRevision();
    console.log('[DB] Database closed');
  }
}

export function getSchemaVersionFromBackup(backupPath: string): number | null {
  let backupDb: Database.Database | undefined;
  try {
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    const metaRow = backupDb
      .prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;
    if (!metaRow) return null;
    const version = Number.parseInt(metaRow.value, 10);
    return Number.isFinite(version) && version >= 0 ? version : null;
  } catch {
    return null;
  } finally {
    backupDb?.close();
  }
}

export function getCurrentSchemaVersion(): number {
  return (db ?? getDatabase()).pragma('user_version', { simple: true }) as number;
}

export function rebuildSearchIndex(targetDb?: Database.Database): void {
  const target = targetDb || db;
  if (!target) return;
  try {
    const hasOrdersFts = target
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'orders_search_fts'")
      .get();
    if (hasOrdersFts) {
      target.exec("INSERT INTO orders_search_fts(orders_search_fts) VALUES('rebuild')");
    }
    const hasCustomersFts = target
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'customers_search_fts'")
      .get();
    if (hasCustomersFts) {
      target.exec("INSERT INTO customers_search_fts(customers_search_fts) VALUES('rebuild')");
    }
  } catch (err) {
    console.warn('[DB] rebuildSearchIndex error:', err);
  }
}

const SHORT_ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function generateShortId(table: string, length = 6): string {
  for (let attempt = 0; attempt < 20; attempt++) {
    let id = '';
    for (let i = 0; i < length; i++)
      id += SHORT_ID_CHARS[Math.floor(Math.random() * SHORT_ID_CHARS.length)];
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).get(id)) return id;
  }
  throw new Error(`generateShortId: could not find unique id for ${table} after 20 attempts`);
}

/**
 * Per-install lifetime Z counter used by the day-close (cierre de caja)
 * snapshot. Uses a single, non-date-bucketed `sequences` row with
 * `name='z_report', date='ALL'` so the counter stays outside the daily
 * sequences used by orders/bills and preserves conventional single-store
 * Z numbering.
 */
export function nextZNumber(): number {
  return getNextSequence('z_report', 'ALL');
}

/** Atomically get the next sequence value for a given name and date. */
function getNextSequence(name: string, date: string): number {
  return db.transaction(() => {
    // Try to update existing row
    const updated = db
      .prepare(`
      UPDATE sequences SET current_value = current_value + 1
      WHERE name = ? AND date = ?
    `)
      .run(name, date);

    if (updated.changes === 0) {
      // Row doesn't exist for today, insert it
      try {
        db.prepare(`
          INSERT INTO sequences (name, date, current_value) VALUES (?, ?, 1)
        `).run(name, date);
        return 1;
      } catch (insertError) {
        // Retry update if concurrent insert won race; preserve insert error if stuck.
        const retry = db
          .prepare(`
          UPDATE sequences SET current_value = current_value + 1
          WHERE name = ? AND date = ?
        `)
          .run(name, date);
        if (retry.changes === 0) {
          throw new Error(`Failed to generate sequence for ${name}`, { cause: insertError });
        }
      }
    }

    const row = db
      .prepare('SELECT current_value FROM sequences WHERE name = ? AND date = ?')
      .get(name, date) as any;
    return row?.current_value ?? 0;
  })();
}

/** YYYYMMDD for "now" in the given IANA timezone (falls back to UTC if the zone is invalid). */
export function dateStampInTimezone(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}${get('month')}${get('day')}`;
  } catch {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
}

type InvoiceResetPeriod = 'never' | 'daily' | 'monthly' | 'financial_year';

function datePartsInTimezone(timezone: string): { year: number; month: number; day: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const year = get('year');
    const month = get('month');
    const day = get('day');
    if (Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)) {
      return { year, month, day };
    }
  } catch {}

  const [year, month, day] = new Date().toISOString().slice(0, 10).split('-').map(Number);
  return { year, month, day };
}

function clampFinancialYearStart(
  monthValue: string | null | undefined,
  dayValue: string | null | undefined,
) {
  const month = Number.parseInt(monthValue || '4', 10);
  const day = Number.parseInt(dayValue || '1', 10);
  return {
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : 4,
    day: Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1,
  };
}

function financialYearSegment(timezone: string, startMonth: number, startDay: number): string {
  const current = datePartsInTimezone(timezone);
  const startsThisYear =
    current.month > startMonth || (current.month === startMonth && current.day >= startDay);
  const startYear = startsThisYear ? current.year : current.year - 1;
  return `FY${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function invoicePeriodSegment(
  period: InvoiceResetPeriod,
  timezone: string,
  startMonth: number,
  startDay: number,
): string {
  const date = dateStampInTimezone(timezone);
  if (period === 'monthly') return date.slice(0, 6);
  if (period === 'financial_year') return financialYearSegment(timezone, startMonth, startDay);
  return date;
}

// Strip non-alphanumeric characters to prevent collision with hyphen separators.
function sanitizedNumberPrefix(value: string | null | undefined, fallback: string): string {
  return (value ?? fallback).replace(/[^A-Za-z0-9]/g, '');
}

// Order/bill numbering buckets and displayed date/period segments on a
// tenant-local day. A missing timezone must not silently fall through to the
// date helpers' own UTC fallback — at a local day/month/year boundary that
// produces the wrong period segment and sequence bucket for the identifier.
// Resolves through the country profile when the stored timezone is missing
// or invalid, matching resolveRegionalSnapshot's own contract — only throws
// RegionalNotConfiguredError when the country itself is unresolvable.
function requireTenantTimezone(): string {
  return resolveRegionalSnapshot({
    country: getSettingValue('country') ?? undefined,
    currency: getSettingValue('currency') ?? undefined,
    timezone: getSettingValue('timezone') ?? undefined,
  }).timezone;
}

export function generateOrderNumber(): string {
  const prefix = sanitizedNumberPrefix(getSettingValue('order_number_prefix'), 'ORD');
  const includeDate = getSettingValue('order_number_include_date') !== 'false';
  const resetDaily = getSettingValue('order_number_reset_daily') !== 'false';
  const timezone = requireTenantTimezone();

  // Per-day bucket when reset daily, otherwise a single bucket.
  const bucket = resetDaily ? dateStampInTimezone(timezone) : 'ALL';
  const next = getNextSequence('orders', bucket);

  const dateSegment = includeDate ? dateStampInTimezone(timezone) : '';
  return [prefix, dateSegment, String(next).padStart(4, '0')].filter(Boolean).join('-');
}

export function generateBillNumber(): string {
  const prefix = sanitizedNumberPrefix(getSettingValue('invoice_number_prefix'), 'INV');
  const includePeriod = getSettingValue('invoice_number_include_period') !== 'false';
  const configuredPeriod = getSettingValue('invoice_number_reset_period') || 'daily';
  const resetPeriod: InvoiceResetPeriod = ['never', 'daily', 'monthly', 'financial_year'].includes(
    configuredPeriod,
  )
    ? (configuredPeriod as InvoiceResetPeriod)
    : 'daily';
  const timezone = requireTenantTimezone();
  const fyStart = clampFinancialYearStart(
    getSettingValue('invoice_financial_year_start_month'),
    getSettingValue('invoice_financial_year_start_day'),
  );
  const periodSegment = invoicePeriodSegment(
    resetPeriod === 'never' ? 'daily' : resetPeriod,
    timezone,
    fyStart.month,
    fyStart.day,
  );
  const bucket = resetPeriod === 'never' ? 'ALL' : periodSegment;
  const next = getNextSequence('bills', bucket);
  return [prefix, includePeriod ? periodSegment : '', String(next).padStart(4, '0')]
    .filter(Boolean)
    .join('-');
}

export function now(): string {
  // Returns SQLite CURRENT_TIMESTAMP format (`YYYY-MM-DD HH:MM:SS`, UTC).
  return new Date().toISOString().replace('T', ' ').replace(/\..*$/, '');
}

/** Records who performed an order/item mutation (docs/reference/product-invariants.md). */
export function recordOrderAudit(
  db: ReturnType<typeof getDatabase>,
  params: {
    orderId: number | string;
    orderItemId?: number | string | null;
    actorUserId: string;
    action: string;
    details?: Record<string, unknown>;
  },
): void {
  db.prepare(`
    INSERT INTO order_audit_log (order_id, order_item_id, actor_user_id, action, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.orderId,
    params.orderItemId ?? null,
    params.actorUserId,
    params.action,
    params.details ? JSON.stringify(params.details) : null,
    now(),
  );
}

/** Parse DB timestamp into Date, ensuring space-delimited timestamps parse as UTC. */
export function parseDbTimestamp(ts: string | null | undefined): Date {
  if (!ts) return new Date(NaN);
  // Space form: append a Z so V8 parses it as UTC instead of machine-local.
  return /^\d{4}-\d{2}-\d{2} /.test(ts) ? new Date(`${ts.replace(' ', 'T')}Z`) : new Date(ts);
}

/** "Today" as a `YYYY-MM-DD` string in UTC for non-tenant uses. */
export function utcTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

// The business-day rule lives in shared/business-date.ts so the renderer cannot
// restate it. These re-exports keep the existing importer surface for one
// release: every remaining import of a business-date symbol from this module is
// visible in review instead of hidden behind a silent copy. Delete them and
// repoint the importers in a follow-on, or the move is cosmetic.
export { dayBoundsInTimezone, utcDayBounds };

/** Deprecated positional alias of `businessDateForInstant`, kept so the existing
 *  `localDateInTimezone(instant, timezone, startTime)` importers keep their exact
 *  signature for one release. A bare rename would have changed the argument order
 *  of a live export without any of those callers changing. */
export function localDateInTimezone(
  instant: Date,
  timezone: string,
  startTime: string = '00:00',
): string {
  return businessDateForInstant({ instant, timezone, startTime });
}

/** Verify a user PIN against the stored pin_hash. */
export function verifyPin(
  storedHash: string | null | undefined,
  inputPin: string | number,
): boolean {
  if (!storedHash || !inputPin) return false;
  return bcrypt.compareSync(String(inputPin), storedHash);
}

/** Verify a user PIN against the stored pin_hash asynchronously without blocking the event loop. */
export async function verifyPinAsync(
  storedHash: string | null | undefined,
  inputPin: string | number,
): Promise<boolean> {
  if (!storedHash || !inputPin) return false;
  return bcrypt.compare(String(inputPin), storedHash);
}

// Duration a voided in-progress item remains visible on KDS boards before dropping off.
export const KDS_VOIDED_ITEM_VISIBILITY_MS = 15 * 60 * 1000;

/** Determines whether a voided order item should still appear on KDS surfaces. */
export function isVoidedItemKdsVisible(voidedAt: string | null | undefined): boolean {
  if (!voidedAt) return true;
  return Date.now() - parseDbTimestamp(voidedAt).getTime() < KDS_VOIDED_ITEM_VISIBILITY_MS;
}

/** Remove customer/payment/order-financial fields from category-scoped KDS payloads. */
export function projectKdsOrder(order: any, restricted: boolean): any {
  if (!restricted) return order;
  const allowedFields = [
    'id',
    'order_number',
    'type',
    'guest_count',
    'special_instructions',
    'status',
    'created_at',
    'updated_at',
    'table_name',
    'table_number',
    'floor',
    'section',
  ];
  return Object.fromEntries(
    allowedFields.filter((field) => field in order).map((field) => [field, order[field]]),
  );
}

/** Keep category-scoped KDS lines limited to kitchen-operational fields. */
export function projectKdsItem(item: any, restricted: boolean): any {
  if (!restricted) return item;
  const allowedFields = [
    'id',
    'order_id',
    'product_id',
    'product_name',
    'product_sku',
    'quantity',
    'status',
    'special_instructions',
    'created_at',
    'updated_at',
    'order_number',
    'type',
    'table_name',
    'order_status',
    'order_notes',
    'order_time',
  ];
  const projected = Object.fromEntries(
    allowedFields.filter((field) => field in item).map((field) => [field, item[field]]),
  );
  if (Array.isArray(item.addons)) {
    projected.addons = item.addons.map((addon: any) => {
      const safeAddon: Record<string, any> = {};
      for (const field of ['id', 'name', 'quantity']) {
        if (field in addon) safeAddon[field] = addon[field];
      }
      return safeAddon;
    });
  }
  return projected;
}

/** Avoid exposing printer/network credentials in restricted KDS station metadata. */
export function projectKdsStation(
  station: any,
  restricted: boolean,
  userCategoryIds: string[] = [],
): any {
  if (!restricted) return station;
  const allowedFields = ['id', 'name', 'description', 'category_ids', 'sort_order', 'is_active'];
  const projected = Object.fromEntries(
    allowedFields.filter((field) => field in station).map((field) => [field, station[field]]),
  );
  if (typeof projected.category_ids === 'string' && userCategoryIds.length > 0) {
    try {
      const parsed = JSON.parse(projected.category_ids);
      if (Array.isArray(parsed))
        projected.category_ids = JSON.stringify(
          parsed.filter((id) => userCategoryIds.includes(String(id))),
        );
    } catch {
      projected.category_ids = '[]';
    }
  }
  return projected;
}

/** Snapshots an order item's selected addons into the order_item_addons table. */
export function insertOrderItemAddons(
  dbInstance: Database.Database,
  orderItemId: number | bigint,
  addons:
    | {
        id?: string;
        name?: string;
        price?: number;
        quantity?: number;
        inventory_deducted_quantity?: number;
      }[]
    | null
    | undefined,
  createdAt: string,
): void {
  if (!addons || !Array.isArray(addons) || addons.length === 0) return;
  const addonExists = dbInstance.prepare('SELECT 1 FROM addons WHERE id = ?');
  const insertAddon = dbInstance.prepare(`
    INSERT INTO order_item_addons (order_item_id, addon_id, addon_name, price, quantity, inventory_deducted_quantity, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const addon of addons) {
    if (!addon || !addon.name) continue;
    // Fall back to NULL addon_id if missing from catalog to prevent FK failure.
    const linkedAddonId = addon.id && addonExists.get(addon.id) ? addon.id : null;
    const qty = Math.max(1, Math.floor(Number(addon.quantity) || 1));
    // The snapshot of what this line took out of the add-on pool, so a later
    // cancel returns exactly this much instead of whatever the catalog says.
    const deductedQuantity = Math.max(0, Number(addon.inventory_deducted_quantity) || 0);
    insertAddon.run(
      orderItemId,
      linkedAddonId,
      addon.name,
      addon.price || 0,
      qty,
      deductedQuantity,
      createdAt,
    );
  }
}

/** Parse JSON string fields on order_item rows returned from SQLite. */
export function parseItemJson(item: any): any {
  const tryParse = (val: any) => {
    if (typeof val !== 'string') return val;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  };
  return {
    ...item,
    variant_selection: tryParse(item.variant_selection),
    modifier_selection: tryParse(item.modifier_selection),
    tax_breakdown: tryParse(item.tax_breakdown),
    tax_snapshot: tryParse(item.tax_snapshot),
    recipe_snapshot: tryParse(item.recipe_snapshot),
  };
}

/** Resolves selected addons and item audit metadata for a batch of order_items rows. */
export function attachEffectiveAddons<T extends { id: number }>(
  dbInstance: Database.Database,
  items: T[],
): (T & {
  addons: { id: string | null; name: string; price: number; quantity: number }[];
  edit_version: number;
  superseded?: boolean;
})[] {
  if (items.length === 0)
    return items as (T & {
      addons: { id: string | null; name: string; price: number; quantity: number }[];
      edit_version: number;
      superseded?: boolean;
    })[];

  const ids = items.map((item) => item.id);
  const CHUNK_SIZE = 400;

  const byItem = new Map<
    number,
    { id: string | null; name: string; price: number; quantity: number }[]
  >();
  for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = dbInstance
      .prepare(
        `SELECT * FROM order_item_addons WHERE order_item_id IN (${placeholders}) ORDER BY id`,
      )
      .all(...chunk) as {
      order_item_id: number;
      addon_id: string | null;
      addon_name: string;
      price: number;
      quantity: number;
    }[];
    for (const row of rows) {
      const list = byItem.get(row.order_item_id) || [];
      list.push({
        id: row.addon_id,
        name: row.addon_name,
        price: row.price,
        quantity: row.quantity,
      });
      byItem.set(row.order_item_id, list);
    }
  }

  const editVersionByItem = new Map<number, number>();
  const supersededItemIds = new Set<number>();
  try {
    for (let offset = 0; offset < ids.length; offset += CHUNK_SIZE) {
      const chunk = ids.slice(offset, offset + CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(',');
      const auditRows = dbInstance
        .prepare(
          `SELECT id, order_item_id, action, details_json FROM order_audit_log WHERE order_item_id IN (${placeholders}) ORDER BY id`,
        )
        .all(...chunk) as {
        id: number;
        order_item_id: number | string | null;
        action: string;
        details_json: string | null;
      }[];
      for (const audit of auditRows) {
        const itemId = Number(audit.order_item_id);
        if (!Number.isFinite(itemId)) continue;
        const prev = editVersionByItem.get(itemId) ?? 0;
        if (audit.id > prev) editVersionByItem.set(itemId, audit.id);
        if (audit.action === 'item_edited' && audit.details_json) {
          try {
            const details = JSON.parse(audit.details_json) as { superseded?: unknown } | null;
            if (details?.superseded === true) {
              supersededItemIds.add(itemId);
            }
          } catch {
            // Ignore malformed audit details_json.
          }
        }
      }
    }
  } catch {
    // Partial test schemas without order_audit_log default to edit_version 0.
  }

  return items.map((item) => {
    const itemId = Number(item.id);
    const status = (item as { status?: string }).status;
    const isSuperseded =
      supersededItemIds.has(itemId) && (status === 'cancelled' || status === 'voided');
    return {
      ...item,
      addons: byItem.get(item.id) || [],
      edit_version: editVersionByItem.get(itemId) ?? 0,
      ...(isSuperseded ? { superseded: true } : {}),
    };
  });
}

/** Parse JSON text columns on bill/order rows returned from SQLite. */
export function parseRowJson(row: any): any {
  if (!row) return row;
  const tryParse = (val: any) => {
    if (typeof val !== 'string') return val;
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  };

  // tax_breakdown is stored as an array of per-item breakdowns (array of arrays).
  // Aggregate into a flat array of { title, rate, amount } for the frontend.
  let taxBreakdown = tryParse(row.tax_breakdown);
  if (Array.isArray(taxBreakdown) && taxBreakdown.length > 0 && Array.isArray(taxBreakdown[0])) {
    let fractionDigits = 2;
    try {
      fractionDigits = getCurrencyFractionDigits(getSettingValue('currency') || '');
    } catch {}
    const merged: Record<string, { title: string; rate: number; amount: number }> = {};
    for (const itemBreakdown of taxBreakdown) {
      if (!Array.isArray(itemBreakdown)) continue;
      for (const line of itemBreakdown) {
        const key = `${line.title}_${line.rate}`;
        if (!merged[key]) {
          merged[key] = { title: line.title, rate: line.rate, amount: 0 };
        }
        merged[key].amount += line.amount;
      }
    }
    taxBreakdown = Object.values(merged)
      .filter((line) => line.amount !== 0)
      .map((line) => ({
        ...line,
        amount: Number(line.amount.toFixed(fractionDigits)),
      }));
  }

  return {
    ...row,
    tax_breakdown: taxBreakdown,
    tax_snapshot: tryParse(row.tax_snapshot),
    payment_details: tryParse(row.payment_details),
  };
}
