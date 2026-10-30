import Database from 'better-sqlite3';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { resolveContainedPath } from '../lib/path-containment';
import { resolveRegionalSnapshot } from '../countries';
import {
  bumpSettingsRevision,
  clearGoogleDriveRestoreBinding,
  closeDatabase,
  createMaintenanceAbortError,
  executeSequenceRepair,
  getCurrentSchemaVersion,
  getDatabase,
  getDbPath,
  getRawDatabase,
  initDatabase,
  isHealthyDatabaseFile,
  now,
  parseDbTimestamp,
  rebuildSearchIndex,
  throwIfDatabaseMaintenanceAborted,
  withDatabaseMaintenanceLock,
} from '../db';

export function getBackupDir(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'backups');
}

type ReplacementJournal = {
  phase: 'prepared' | 'committed';
  recoveryPath: string;
  dbPath: string;
  baselineForeignKeyViolations?: string[];
  driveInvalidationRequired?: boolean;
};

export type DatabaseReplacementJournalHandle = {
  phase: 'prepared' | 'committed';
  journalPath: string;
  recoveryPath: string;
  dbPath: string;
};

export function syncFile(filePath: string): void {
  // Use writable handle for portable fsync across Windows and POSIX.
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeReplacementJournal(journalPath: string, journal: ReplacementJournal): void {
  const tempPath = `${journalPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(journal), { encoding: 'utf8', mode: 0o600 });
  syncFile(tempPath);
  fs.renameSync(tempPath, journalPath);
  if (!syncDirectory(path.dirname(journalPath)) && process.platform !== 'win32') {
    throw new Error('Could not durably record database replacement journal');
  }
}

function isLiveDatabaseTarget(candidatePath: string, dbPath: string): boolean {
  const normalize = (value: string) =>
    process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value;
  if (normalize(path.resolve(candidatePath)) === normalize(path.resolve(dbPath))) return true;
  try {
    const candidateStat = fs.statSync(candidatePath);
    const dbStat = fs.statSync(dbPath);
    if (candidateStat.dev === dbStat.dev && candidateStat.ino === dbStat.ino) return true;
  } catch {}
  try {
    const candidateReal = path.join(
      fs.realpathSync(path.dirname(candidatePath)),
      path.basename(candidatePath),
    );
    return normalize(candidateReal) === normalize(fs.realpathSync(dbPath));
  } catch {
    return false;
  }
}

export function pathEntryExists(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

export function syncDirectory(directoryPath: string): boolean {
  try {
    const fd = fs.openSync(directoryPath, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
    return false;
  }
}

function removeReplacementArtifactsDurably(journalPath: string, recoveryPath: string): void {
  const directoryPath = path.dirname(journalPath);
  const artifactPaths = [
    journalPath,
    `${journalPath}.tmp`,
    recoveryPath,
    `${recoveryPath}-wal`,
    `${recoveryPath}-shm`,
  ];
  const cleanupId = crypto.randomBytes(8).toString('hex');
  const backups: { originalPath: string; backupPath: string }[] = [];
  let restorationFailed = false;
  try {
    for (const originalPath of artifactPaths) {
      if (!pathEntryExists(originalPath)) continue;
      const backupPath = `${originalPath}.cleanup-${cleanupId}`;
      fs.copyFileSync(originalPath, backupPath);
      syncFile(backupPath);
      backups.push({ originalPath, backupPath });
    }
    if (!syncDirectory(directoryPath) && process.platform !== 'win32')
      throw new Error('Could not durably prepare database replacement cleanup');
    for (const filePath of [recoveryPath, `${recoveryPath}-wal`, `${recoveryPath}-shm`]) {
      if (pathEntryExists(filePath)) fs.unlinkSync(filePath);
    }
    if (!syncDirectory(directoryPath) && process.platform !== 'win32')
      throw new Error('Could not durably remove database replacement artifacts');
    for (const filePath of [`${journalPath}.tmp`, journalPath]) {
      if (pathEntryExists(filePath)) fs.unlinkSync(filePath);
    }
    if (!syncDirectory(directoryPath) && process.platform !== 'win32')
      throw new Error('Could not durably remove database replacement journal');
    for (const { backupPath } of backups) {
      if (pathEntryExists(backupPath)) fs.unlinkSync(backupPath);
    }
    if (!syncDirectory(directoryPath) && process.platform !== 'win32')
      throw new Error('Could not durably remove database replacement cleanup copies');
  } catch (error) {
    for (const { originalPath, backupPath } of backups) {
      try {
        if (!pathEntryExists(originalPath) && pathEntryExists(backupPath)) {
          fs.copyFileSync(backupPath, originalPath);
          syncFile(originalPath);
        }
      } catch {
        restorationFailed = true;
      }
    }
    if (!syncDirectory(directoryPath)) restorationFailed = true;
    if (!restorationFailed) {
      for (const { backupPath } of backups) {
        try {
          if (pathEntryExists(backupPath)) fs.unlinkSync(backupPath);
        } catch {
          restorationFailed = true;
        }
      }
      if (!syncDirectory(directoryPath)) restorationFailed = true;
    }
    if (restorationFailed) {
      throw new Error(
        `Database replacement cleanup failed and recovery evidence was retained: ${error instanceof Error ? error.message : 'unknown error'}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function restoreReplacementCleanupEvidence(backupDir: string, dbPath: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(backupDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const groups = new Map<string, Map<string, string>>();
  for (const name of names) {
    const markerIndex = name.lastIndexOf('.cleanup-');
    if (markerIndex < 0) continue;
    const originalName = name.slice(0, markerIndex);
    const cleanupId = name.slice(markerIndex + '.cleanup-'.length);
    if (!/^[a-f0-9]{16}$/.test(cleanupId)) continue;
    if (
      !/^(?:flo-restore|flo-reset)-recovery-.+\.(?:json|json\.tmp|db(?:-(?:wal|shm))?)$/.test(
        originalName,
      )
    )
      continue;
    const canonicalName = originalName.endsWith('.json.tmp')
      ? originalName.slice(0, -'.tmp'.length)
      : originalName;
    const canonicalBase = canonicalName.replace(/(?:\.json|\.db(?:-(?:wal|shm))?)$/, '');
    const groupKey = `${canonicalBase}:${cleanupId}`;
    const group = groups.get(groupKey) || new Map<string, string>();
    group.set(canonicalName, name);
    groups.set(groupKey, group);
  }
  for (const [groupKey, group] of groups) {
    const separator = groupKey.lastIndexOf(':');
    const canonicalBase = groupKey.slice(0, separator);
    const journalName = `${canonicalBase}.json`;
    const recoveryName = `${canonicalBase}.db`;
    const journalPath = path.join(backupDir, journalName);
    const recoveryPath = path.join(backupDir, recoveryName);
    const journalEvidence = group.get(journalName) || group.get(`${journalName}.tmp`);
    const recoveryEvidence = group.get(recoveryName);
    if (!journalEvidence || !recoveryEvidence) {
      if (pathEntryExists(journalPath) || pathEntryExists(recoveryPath))
        throw new Error(`Incomplete database replacement cleanup evidence: ${canonicalBase}`);
      for (const evidenceName of new Set(group.values())) {
        const evidencePath = path.join(backupDir, evidenceName);
        if (pathEntryExists(evidencePath)) fs.unlinkSync(evidencePath);
      }
      if (!syncDirectory(backupDir) && process.platform !== 'win32')
        throw new Error(
          'Could not durably remove incomplete database replacement cleanup evidence',
        );
      continue;
    }
    for (const [canonicalPath, evidenceName] of [
      [journalPath, journalEvidence],
      [recoveryPath, recoveryEvidence],
    ] as const) {
      if (pathEntryExists(canonicalPath)) continue;
      const evidencePath = path.join(backupDir, evidenceName);
      const evidenceStat = fs.lstatSync(evidencePath);
      if (evidenceStat.isSymbolicLink() || !evidenceStat.isFile())
        throw new Error(`Invalid database replacement cleanup evidence: ${evidenceName}`);
      if (canonicalPath === journalPath) {
        const journal = JSON.parse(
          fs.readFileSync(evidencePath, 'utf8'),
        ) as Partial<ReplacementJournal>;
        if (journal.dbPath !== dbPath || journal.recoveryPath !== recoveryPath)
          throw new Error(`Invalid database replacement cleanup journal: ${evidenceName}`);
      }
      fs.copyFileSync(evidencePath, canonicalPath);
      syncFile(canonicalPath);
    }
    for (const evidenceName of new Set(group.values())) {
      const evidencePath = path.join(backupDir, evidenceName);
      if (pathEntryExists(evidencePath)) fs.unlinkSync(evidencePath);
    }
    if (!syncDirectory(backupDir) && process.platform !== 'win32')
      throw new Error('Could not durably restore database replacement cleanup evidence');
  }
}

function replacementJournalPath(kind: 'restore' | 'reset'): string {
  const recoveryPath = path.join(
    getBackupDir(),
    `flo-${kind}-recovery-${crypto.randomBytes(8).toString('hex')}.db`,
  );
  return recoveryPath.replace(/\.db$/, '.json');
}

function readReplacementJournal(journalPath: string): ReplacementJournal | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as Partial<ReplacementJournal>;
    if (
      (parsed.phase !== 'prepared' && parsed.phase !== 'committed') ||
      typeof parsed.recoveryPath !== 'string' ||
      typeof parsed.dbPath !== 'string' ||
      !path.isAbsolute(parsed.recoveryPath) ||
      !path.isAbsolute(parsed.dbPath) ||
      parsed.driveInvalidationRequired !== true ||
      parsed.dbPath !== getDbPath() ||
      path.dirname(parsed.recoveryPath) !== path.resolve(getBackupDir()) ||
      `${path.basename(journalPath, '.json')}.db` !== path.basename(parsed.recoveryPath)
    )
      return null;
    return parsed as ReplacementJournal;
  } catch {
    return null;
  }
}

export function getDatabaseReplacementJournal(): DatabaseReplacementJournalHandle | null {
  restoreReplacementCleanupEvidence(getBackupDir(), getDbPath());
  let journals: string[];
  try {
    journals = fs
      .readdirSync(getBackupDir())
      .filter((name) => /^(?:flo-restore|flo-reset)-recovery-.+\.json$/.test(name))
      .map((name) => path.join(getBackupDir(), name))
      .sort((a, b) => fs.lstatSync(b).mtimeMs - fs.lstatSync(a).mtimeMs);
  } catch {
    return null;
  }
  const journalPath = journals[0];
  if (!journalPath) return null;
  const journal = readReplacementJournal(journalPath);
  if (!journal) return null;
  return {
    phase: journal.phase,
    journalPath,
    recoveryPath: journal.recoveryPath,
    dbPath: journal.dbPath,
  };
}

export function beginDatabaseReplacementJournal(
  recoverySourcePath: string,
  kind: 'restore' | 'reset',
): DatabaseReplacementJournalHandle {
  const dbPath = getDbPath();
  const journalPath = replacementJournalPath(kind);
  const recoveryPath = journalPath.replace(/\.json$/, '.db');
  try {
    fs.copyFileSync(recoverySourcePath, recoveryPath);
    syncFile(recoveryPath);
    writeReplacementJournal(journalPath, {
      phase: 'prepared',
      recoveryPath,
      dbPath,
      driveInvalidationRequired: true,
    });
    return { phase: 'prepared', journalPath, recoveryPath, dbPath };
  } catch (error) {
    removeReplacementArtifactsDurably(journalPath, recoveryPath);
    throw error;
  }
}

export function commitDatabaseReplacementJournal(handle: DatabaseReplacementJournalHandle): void {
  getDatabase().pragma('wal_checkpoint(TRUNCATE)');
  syncFile(handle.dbPath);
  if (!syncDirectory(path.dirname(handle.dbPath)) && process.platform !== 'win32') {
    throw new Error('Could not durably commit database replacement');
  }
  try {
    writeReplacementJournal(handle.journalPath, {
      phase: 'committed',
      recoveryPath: handle.recoveryPath,
      dbPath: handle.dbPath,
      driveInvalidationRequired: true,
    });
  } catch (error) {
    if (readReplacementJournal(handle.journalPath)?.phase === 'committed')
      handle.phase = 'committed';
    throw error;
  }
  handle.phase = 'committed';
}

export function abortDatabaseReplacementJournal(handle: DatabaseReplacementJournalHandle): void {
  const journal = readReplacementJournal(handle.journalPath);
  if (!journal || journal.phase === 'committed') return;
  removeReplacementArtifactsDurably(handle.journalPath, handle.recoveryPath);
}

export function finalizeDatabaseReplacementJournal(handle: DatabaseReplacementJournalHandle): void {
  const journal = readReplacementJournal(handle.journalPath);
  if (journal?.phase !== 'committed') throw new Error('Database replacement is not committed');
  removeReplacementArtifactsDurably(handle.journalPath, handle.recoveryPath);
}

export function recoverDatabaseReplacementJournal(handle: DatabaseReplacementJournalHandle): void {
  const journal = readReplacementJournal(handle.journalPath);
  if (journal?.phase === 'committed') return;
  if (
    !journal ||
    journal.recoveryPath !== handle.recoveryPath ||
    journal.dbPath !== handle.dbPath
  ) {
    throw new Error('Database replacement journal could not be validated');
  }
  try {
    const recoveryStat = fs.lstatSync(handle.recoveryPath);
    if (
      recoveryStat.isSymbolicLink() ||
      !recoveryStat.isFile() ||
      pathEntryExists(`${handle.recoveryPath}-wal`) ||
      pathEntryExists(`${handle.recoveryPath}-shm`) ||
      !isHealthyDatabaseFile(handle.recoveryPath, undefined, false)
    ) {
      throw new Error('Database replacement recovery snapshot could not be validated');
    }
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error('Database replacement recovery snapshot could not be validated', {
          cause: error,
        });
  }
  closeDatabase();
  const failures = removeDatabaseFiles(handle.dbPath);
  if (failures.length > 0)
    throw new Error(`Could not clear failed database replacement: ${failures.join(', ')}`);
  fs.copyFileSync(handle.recoveryPath, handle.dbPath);
  syncFile(handle.dbPath);
  if (!syncDirectory(path.dirname(handle.dbPath)) && process.platform !== 'win32') {
    throw new Error('Could not durably recover failed database replacement');
  }
  initDatabase(false, true);
  removeReplacementArtifactsDurably(handle.journalPath, handle.recoveryPath);
}

export const MAX_RETAINED_RESTORE_SAFETY_COPIES = 3;

const MANAGED_BACKUP_PREFIXES = ['rest-cafe-backup-', 'flo-backup-'] as const;

/** Managed backup names carry either prefix; flo-backup-* is the legacy spelling. */
export function hasManagedBackupPrefix(fileName: string): boolean {
  return MANAGED_BACKUP_PREFIXES.some((prefix) => fileName.startsWith(prefix));
}

/** True for the retained copies a successful restore leaves behind as an undo. */
export function isRestoreSafetyCopyName(fileName: string): boolean {
  return (
    hasManagedBackupPrefix(fileName) &&
    fileName.includes('-pre-restore-') &&
    fileName.endsWith('.db')
  );
}

/**
 * A successful restore replaces the live database, so the pre-restore snapshot is
 * the only copy of what it replaced. It is copied into the managed backup naming
 * scheme rather than deleted, which makes it appear in listBackups() and makes it
 * restorable through the same preset-path route as any other managed backup.
 * Retention is bounded so a long-lived install cannot accumulate copies forever.
 *
 * The snapshot is copied rather than renamed so the replacement journal keeps
 * pointing at a real file: a crash between the committed journal and cleanup must
 * still be able to roll the live database back from it.
 */
export function retainRestoreSafetyCopy(
  recoveryPath: string,
  schemaVersion: number,
): string | null {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const retainedPath = path.join(
    getBackupDir(),
    `rest-cafe-backup-${timestamp}-pre-restore-v${schemaVersion}.db`,
  );
  try {
    if (!pathEntryExists(recoveryPath)) return null;
    // The replacement journal snapshots the live file with a raw copy, so the
    // snapshot carries no _flo_meta stamp and every restore route would refuse
    // it. Stamp it before copying, so a failure here leaves the recovery copy
    // exactly where the journal expects it and changes nothing.
    const snapshotDb = new Database(recoveryPath);
    try {
      snapshotDb.pragma('journal_mode = DELETE');
      snapshotDb.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
      snapshotDb
        .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
        .run('schema_version', String(schemaVersion));
      snapshotDb
        .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
        .run('backup_created_at', new Date().toISOString());
      snapshotDb
        .prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)')
        .run('app_version', app.getVersion());
    } finally {
      snapshotDb.close();
    }
    syncFile(recoveryPath);
    fs.copyFileSync(recoveryPath, retainedPath);
    syncFile(retainedPath);
    syncDirectory(getBackupDir());
  } catch (error) {
    // Retention is a safety net, never a reason to fail a committed restore.
    console.warn('[DB] Could not retain the pre-restore safety copy:', error);
    return null;
  }
  try {
    const existing = fs
      .readdirSync(getBackupDir())
      .filter(isRestoreSafetyCopyName)
      .map((name) => ({ name, mtimeMs: fs.lstatSync(path.join(getBackupDir(), name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of existing.slice(MAX_RETAINED_RESTORE_SAFETY_COPIES)) {
      fs.unlinkSync(path.join(getBackupDir(), stale.name));
    }
    syncDirectory(getBackupDir());
  } catch (error) {
    console.warn('[DB] Could not apply pre-restore safety copy retention:', error);
  }
  return retainedPath;
}

function removeOlderReplacementJournals(
  journals: string[],
  dbPath: string,
  backupDir: string,
): void {
  const backupRoot = path.resolve(backupDir);
  for (const journalPath of journals) {
    try {
      const journalStat = fs.lstatSync(journalPath);
      if (journalStat.isSymbolicLink() || !journalStat.isFile())
        throw new Error('journal is not a regular file');
      const journal = JSON.parse(
        fs.readFileSync(journalPath, 'utf8'),
      ) as Partial<ReplacementJournal>;
      if (
        (journal.phase !== 'prepared' && journal.phase !== 'committed') ||
        typeof journal.recoveryPath !== 'string' ||
        journal.dbPath !== dbPath ||
        path.dirname(journal.recoveryPath) !== backupRoot ||
        `${path.basename(journalPath, '.json')}.db` !== path.basename(journal.recoveryPath)
      ) {
        throw new Error('invalid stale replacement journal');
      }
      removeReplacementArtifactsDurably(journalPath, journal.recoveryPath);
    } catch {
      // Remove invalid stale journal and its snapshot without blocking startup.
      const fallbackRecovery = path.join(backupRoot, `${path.basename(journalPath, '.json')}.db`);
      removeReplacementArtifactsDurably(journalPath, fallbackRecovery);
      console.warn(`[DB] Removed stale invalid replacement journal: ${journalPath}`);
    }
  }
}

export function recoverInterruptedDatabaseReplacement(dbPath: string, backupDir: string): void {
  restoreReplacementCleanupEvidence(backupDir, dbPath);
  let journals: string[] = [];
  try {
    journals = fs
      .readdirSync(backupDir)
      .filter((name) => /^(?:flo-restore|flo-reset)-recovery-.+\.json$/.test(name))
      .map((name) => path.join(backupDir, name))
      .sort((a, b) => fs.lstatSync(b).mtimeMs - fs.lstatSync(a).mtimeMs);
  } catch (error) {
    throw new Error(
      `Could not inspect database replacement journals: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
  for (const journalPath of journals) {
    const fallbackRecovery = path.join(
      path.resolve(backupDir),
      `${path.basename(journalPath, '.json')}.db`,
    );
    let journalStat: fs.Stats;
    try {
      journalStat = fs.lstatSync(journalPath);
    } catch {
      removeReplacementArtifactsDurably(journalPath, fallbackRecovery);
      continue;
    }
    if (journalStat.isSymbolicLink() || !journalStat.isFile()) {
      removeReplacementArtifactsDurably(journalPath, fallbackRecovery);
      continue;
    }
    let journal: ReplacementJournal;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(journalPath, 'utf8'),
      ) as Partial<ReplacementJournal>;
      if (
        (parsed.phase !== 'prepared' && parsed.phase !== 'committed') ||
        typeof parsed.recoveryPath !== 'string' ||
        typeof parsed.dbPath !== 'string' ||
        !path.isAbsolute(parsed.recoveryPath) ||
        !path.isAbsolute(parsed.dbPath) ||
        (parsed.baselineForeignKeyViolations !== undefined &&
          (!Array.isArray(parsed.baselineForeignKeyViolations) ||
            parsed.baselineForeignKeyViolations.some((key) => typeof key !== 'string')))
      ) {
        throw new Error('invalid phase or paths');
      }
      journal = parsed as ReplacementJournal;
    } catch (error) {
      throw new Error(
        `Interrupted database replacement journal is invalid: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    const recoveryPath = journal.recoveryPath;
    const backupRoot = path.resolve(backupDir);
    const recoveryRoot = path.dirname(recoveryPath);
    const journalBase = path.basename(journalPath, '.json');
    const recoveryNameValid = `${journalBase}.db` === path.basename(recoveryPath);
    if (journal.dbPath !== dbPath || recoveryRoot !== backupRoot || !recoveryNameValid) {
      throw new Error('Interrupted database replacement recovery snapshot could not be validated');
    }
    // Preserve baseline FK violations for compatibility with older journals.
    const allowedForeignKeyViolations =
      journal.baselineForeignKeyViolations === undefined
        ? null
        : new Set(journal.baselineForeignKeyViolations);
    // Snapshots copy live database without metadata table.
    const requireMetadata = false;
    // Finalize committed replacement if database file is healthy.
    if (
      journal.phase === 'committed' &&
      isHealthyDatabaseFile(dbPath, allowedForeignKeyViolations, requireMetadata)
    ) {
      if (journal.driveInvalidationRequired !== false) {
        if (journal.driveInvalidationRequired !== true) {
          writeReplacementJournal(journalPath, {
            ...journal,
            driveInvalidationRequired: true,
          });
        }
        removeOlderReplacementJournals(journals.slice(1), dbPath, backupDir);
        console.warn(
          `[DB] Preserved committed replacement journal for Drive invalidation: ${journalPath}`,
        );
        return;
      }
      removeReplacementArtifactsDurably(journalPath, recoveryPath);
      removeOlderReplacementJournals(journals.slice(1), dbPath, backupDir);
      console.warn(`[DB] Finalized committed database replacement journal: ${journalPath}`);
      return;
    }
    let recoveryStat: fs.Stats;
    try {
      recoveryStat = fs.lstatSync(recoveryPath);
    } catch {
      throw new Error('Interrupted database replacement snapshot is missing');
    }
    const recoverySidecars =
      pathEntryExists(`${recoveryPath}-wal`) || pathEntryExists(`${recoveryPath}-shm`);
    if (
      recoveryStat.isSymbolicLink() ||
      !recoveryStat.isFile() ||
      recoverySidecars ||
      !isHealthyDatabaseFile(recoveryPath, allowedForeignKeyViolations, requireMetadata)
    ) {
      throw new Error('Interrupted database replacement recovery snapshot could not be validated');
    }
    const failures = removeDatabaseFiles(dbPath);
    if (failures.length > 0)
      throw new Error(`Could not clear interrupted database replacement: ${failures.join(', ')}`);
    fs.copyFileSync(recoveryPath, dbPath);
    syncFile(dbPath);
    if (!syncDirectory(path.dirname(dbPath)) && process.platform !== 'win32') {
      throw new Error('Could not durably install recovered database');
    }
    removeReplacementArtifactsDurably(journalPath, recoveryPath);
    removeOlderReplacementJournals(journals.slice(1), dbPath, backupDir);
    console.warn(`[DB] Recovered database from interrupted replacement snapshot: ${recoveryPath}`);
    return;
  }
}

type BackupOptions = { stagingDirectory?: string };

export async function createBackupUnlocked(
  targetPath?: string,
  signal?: AbortSignal,
  options?: BackupOptions,
): Promise<{ path: string; schemaVersion: number }> {
  // Internal callers must already hold withDatabaseMaintenanceLock().
  if (signal?.aborted) throw createMaintenanceAbortError();
  console.log('[DB] createBackup: Starting...');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uniqueSuffix = crypto.randomBytes(4).toString('hex');
  const backupDir = getBackupDir();
  const stagingDir = options?.stagingDirectory ? path.resolve(options.stagingDirectory) : backupDir;
  const tempPath = path.join(stagingDir, `rest-cafe-backup-${timestamp}-${uniqueSuffix}.db`);
  const finalPath = targetPath ? path.resolve(targetPath) : tempPath;
  const stagedTargetPath =
    finalPath !== tempPath
      ? path.join(path.dirname(finalPath), `.${path.basename(finalPath)}.tmp-${uniqueSuffix}`)
      : null;
  let completed = false;

  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  if (stagingDir !== backupDir && !fs.existsSync(stagingDir))
    fs.mkdirSync(stagingDir, { recursive: true });

  const liveDatabasePath = getDbPath();
  if (
    [liveDatabasePath, `${liveDatabasePath}-wal`, `${liveDatabasePath}-shm`].some((livePath) =>
      isLiveDatabaseTarget(finalPath, livePath),
    )
  ) {
    throw new Error('Backup target cannot be the live database or its SQLite sidecars');
  }
  if (stagedTargetPath && fs.existsSync(finalPath) && fs.lstatSync(finalPath).isSymbolicLink()) {
    throw new Error('Backup target cannot be a symbolic link');
  }

  try {
    console.log('[DB] createBackup: Backing up to temp:', tempPath);
    if (signal?.aborted) throw createMaintenanceAbortError();
    await getRawDatabase().backup(tempPath, {
      progress: () => {
        if (signal?.aborted) throw createMaintenanceAbortError();
        return 100;
      },
    });
    if (signal?.aborted) throw createMaintenanceAbortError();

    let currentVersion = 0;
    let backupDb: Database.Database | undefined;
    try {
      backupDb = new Database(tempPath);
      // Switch to DELETE journal mode: checkpoints WAL and removes
      // .db-wal/.db-shm so the final file is self-contained.
      backupDb.pragma('journal_mode = DELETE');
      backupDb.exec(`
        CREATE TABLE IF NOT EXISTS _flo_meta (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);

      if (signal?.aborted) throw createMaintenanceAbortError();
      currentVersion = getCurrentSchemaVersion();
      backupDb
        .prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('schema_version', String(currentVersion));
      backupDb
        .prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('backup_created_at', new Date().toISOString());
      backupDb
        .prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('app_version', app.getVersion());
    } finally {
      backupDb?.close();
    }

    if (stagedTargetPath) {
      fs.copyFileSync(tempPath, stagedTargetPath);
      syncFile(stagedTargetPath);
      if (!syncDirectory(path.dirname(stagedTargetPath)) && process.platform !== 'win32') {
        throw new Error('Could not durably stage backup target');
      }
      try {
        fs.renameSync(stagedTargetPath, finalPath);
      } catch (error) {
        if (process.platform !== 'win32' || !fs.existsSync(finalPath)) throw error;
        fs.unlinkSync(finalPath);
        fs.renameSync(stagedTargetPath, finalPath);
      }
      syncDirectory(path.dirname(finalPath));
      // On Windows, ignore EBUSY/EPERM if temp file is briefly locked after close.
      try {
        fs.unlinkSync(tempPath);
      } catch (unlinkErr: any) {
        if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(unlinkErr?.code)) {
          throw unlinkErr;
        }
        console.warn(
          '[DB] Could not remove temp backup file (Windows file lock); will be cleaned up on exit:',
          unlinkErr.message,
        );
      }
    }
    for (const sidecar of [`${finalPath}-wal`, `${finalPath}-shm`]) {
      try {
        if (pathEntryExists(sidecar)) fs.unlinkSync(sidecar);
      } catch {}
    }
    syncFile(finalPath);
    if (!syncDirectory(path.dirname(finalPath)) && process.platform !== 'win32') {
      throw new Error('Could not durably persist backup file');
    }
    if (finalPath !== tempPath) {
      console.log(`[DB] Backup saved to: ${finalPath} (schema v${currentVersion})`);
    } else {
      console.log(`[DB] Backup created: ${finalPath} (schema v${currentVersion})`);
    }

    completed = true;
    return { path: finalPath, schemaVersion: currentVersion };
  } finally {
    if (!completed) {
      for (const filePath of [
        tempPath,
        stagedTargetPath,
        `${tempPath}-wal`,
        `${tempPath}-shm`,
      ].filter((value): value is string => Boolean(value))) {
        try {
          if (pathEntryExists(filePath)) fs.unlinkSync(filePath);
        } catch {}
      }
    }
  }
}

export function createBackup(
  targetPath?: string,
  signal?: AbortSignal,
  options?: BackupOptions,
): Promise<{ path: string; schemaVersion: number }> {
  return withDatabaseMaintenanceLock(
    (maintenanceSignal) => createBackupUnlocked(targetPath, maintenanceSignal, options),
    signal,
  );
}

function removeDatabaseFiles(dbPath: string): string[] {
  const failures: string[] = [];
  for (const filePath of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (pathEntryExists(filePath)) fs.unlinkSync(filePath);
    } catch (error: any) {
      console.warn(`[DB] Could not remove ${filePath}:`, error);
      failures.push(filePath);
    }
  }
  return failures;
}

type ResetAfterInit = (freshDb: Database.Database) => void;

/** Resets database under an existing maintenance lock; recovers its safety backup if reset fails. */
async function resetDatabaseWithBackupUnlocked(
  maintenanceSignal: AbortSignal,
  afterInit?: ResetAfterInit,
): Promise<{ backupPath: string; committed?: boolean; cleanupPending?: boolean }> {
  const { path: backupPath } = await createBackupUnlocked(undefined, maintenanceSignal);
  throwIfDatabaseMaintenanceAborted(maintenanceSignal);
  const dbPath = getDbPath();
  const currentDb = getDatabase();
  const baselineForeignKeyViolations = getForeignKeyViolationKeys(currentDb);
  const localBackupEnabled = (
    currentDb.prepare("SELECT value FROM settings WHERE key = 'local_backup_enabled'").get() as
      | { value?: string }
      | undefined
  )?.value;
  const recoveryPath = path.join(
    getBackupDir(),
    `flo-reset-recovery-${crypto.randomBytes(8).toString('hex')}.db`,
  );
  const journalPath = recoveryPath.replace(/\.db$/, '.json');
  let recoveryCompleted = false;
  let replacementStarted = false;
  let replacementCommitted = false;

  try {
    fs.copyFileSync(backupPath, recoveryPath);
    syncFile(recoveryPath);
    writeReplacementJournal(journalPath, {
      phase: 'prepared',
      recoveryPath,
      dbPath,
      baselineForeignKeyViolations: [...baselineForeignKeyViolations],
      driveInvalidationRequired: true,
    });
    throwIfDatabaseMaintenanceAborted(maintenanceSignal);
    replacementStarted = true;
    closeDatabase();
    await new Promise<void>((resolve) => setImmediate(resolve));
    throwIfDatabaseMaintenanceAborted(maintenanceSignal);
    const failures = removeDatabaseFiles(dbPath);
    if (failures.length > 0) {
      throw new Error(`Could not remove database files: ${failures.join(', ')}`);
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    throwIfDatabaseMaintenanceAborted(maintenanceSignal);
    initDatabase(false, true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    throwIfDatabaseMaintenanceAborted(maintenanceSignal);
    const freshDb = getDatabase();
    if (localBackupEnabled !== undefined) {
      freshDb
        .prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('local_backup_enabled', localBackupEnabled, now());
      bumpSettingsRevision();
    }
    afterInit?.(freshDb);
    throwIfDatabaseMaintenanceAborted(maintenanceSignal);
    (getRawDatabase() ?? getDatabase()).pragma('wal_checkpoint(TRUNCATE)');
    syncFile(dbPath);
    if (!syncDirectory(path.dirname(dbPath)) && process.platform !== 'win32') {
      throw new Error('Could not durably commit reset database');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    throwIfDatabaseMaintenanceAborted(maintenanceSignal);
    writeReplacementJournal(journalPath, {
      phase: 'committed',
      recoveryPath,
      dbPath,
      baselineForeignKeyViolations: [...baselineForeignKeyViolations],
      driveInvalidationRequired: true,
    });
    replacementCommitted = true;
    return { backupPath, committed: true, cleanupPending: false };
  } catch (error: any) {
    const committedJournal = readReplacementJournal(journalPath)?.phase === 'committed';
    if (replacementCommitted || committedJournal) {
      console.error('[DB] Reset committed; cleanup remains pending:', error);
      return { backupPath, committed: true, cleanupPending: true };
    }
    // Reopen the pre-wipe snapshot so a partial filesystem failure cannot
    // leave the process serving an empty or closed database.
    if (!replacementStarted) {
      removeReplacementArtifactsDurably(journalPath, recoveryPath);
      throw error;
    }
    try {
      closeDatabase();
      removeDatabaseFiles(dbPath);
      fs.copyFileSync(backupPath, dbPath);
      syncFile(dbPath);
      if (!syncDirectory(path.dirname(dbPath)) && process.platform !== 'win32') {
        throw new Error('Could not durably recover reset database');
      }
      initDatabase(false, true);
      recoveryCompleted = true;
    } catch (recoveryError: any) {
      throw new Error(
        `Database reset failed: ${error?.message || 'unknown error'}; ` +
          `database recovery also failed: ${recoveryError?.message || 'unknown error'}`,
      );
    }
    throw error;
  } finally {
    if (recoveryCompleted) removeReplacementArtifactsDurably(journalPath, recoveryPath);
  }
}

/** Resets database while holding maintenance lock; recovers safety backup if reset fails. */
export async function resetDatabaseWithBackup(
  signal?: AbortSignal,
): Promise<{ backupPath: string; committed?: boolean; cleanupPending?: boolean }> {
  return withDatabaseMaintenanceLock(
    (maintenanceSignal) => resetDatabaseWithBackupUnlocked(maintenanceSignal),
    signal,
  );
}

type CurrencyResetMenuSnapshot = {
  categories: Record<string, unknown>[];
  products: Record<string, unknown>[];
  productVariants: Record<string, unknown>[];
  addonGroups: Record<string, unknown>[];
  addons: Record<string, unknown>[];
  addonGroupProducts: Record<string, unknown>[];
  categoryAddonGroups: Record<string, unknown>[];
};

export interface CurrencyResetImpact {
  currentCurrency: string;
  invoices: number;
  orders: number;
  refunds: number;
  customers: number;
  products: number;
  addons: number;
}

function countTableRows(dbInstance: Database.Database, table: string): number {
  return (dbInstance.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number })
    .count;
}

export function getCurrencyResetImpact(
  dbInstance: Database.Database = getDatabase(),
): CurrencyResetImpact {
  const currentCurrency =
    (
      dbInstance.prepare("SELECT value FROM settings WHERE key = 'currency'").get() as
        | { value?: string }
        | undefined
    )?.value || '';
  return {
    currentCurrency,
    invoices: countTableRows(dbInstance, 'bills'),
    orders: countTableRows(dbInstance, 'orders'),
    refunds: countTableRows(dbInstance, 'refunds'),
    customers: countTableRows(dbInstance, 'customers'),
    products: countTableRows(dbInstance, 'products'),
    addons: countTableRows(dbInstance, 'addons'),
  };
}

function captureCurrencyResetMenu(dbInstance: Database.Database): CurrencyResetMenuSnapshot {
  const rows = (table: string) =>
    dbInstance.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  return {
    categories: rows('categories'),
    products: rows('products'),
    productVariants: rows('product_variants'),
    addonGroups: rows('addon_groups'),
    addons: rows('addons'),
    addonGroupProducts: rows('addon_group_product'),
    categoryAddonGroups: rows('category_addon_groups'),
  };
}

function insertSnapshotRows(
  dbInstance: Database.Database,
  table: string,
  rows: Record<string, unknown>[],
): void {
  if (rows.length === 0) return;
  const targetColumns = new Set(
    (dbInstance.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  const columns = Object.keys(rows[0]).filter((column) => targetColumns.has(column));
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
  const insert = dbInstance.prepare(sql);
  for (const row of rows) insert.run(...columns.map((column) => row[column]));
}

function restoreCurrencyResetMenu(
  dbInstance: Database.Database,
  snapshot: CurrencyResetMenuSnapshot,
): void {
  const categoryIds = new Set(snapshot.categories.map((category) => category.id));
  const productIds = new Set(snapshot.products.map((product) => product.id));
  const addonGroupIds = new Set(snapshot.addonGroups.map((group) => group.id));
  const inventoryLinks = snapshot.products.map((product) => ({
    id: product.id,
    inventoryProductId: product.inventory_product_id,
  }));
  const products = snapshot.products.map((product) => ({
    ...product,
    category_id: categoryIds.has(product.category_id) ? product.category_id : null,
    price: 0,
    cost: 0,
    stock_quantity: 0,
    tax_type: 'none',
    tax_rate: 0,
    tax_category_id: null,
    tax_behavior: 'country_default',
    cb_percent: 0,
    inventory_product_id: null,
  }));
  const addons = snapshot.addons
    .filter((addon) => addonGroupIds.has(addon.addon_group_id))
    .map((addon) => ({
      ...addon,
      price: 0,
      tax_category_id: null,
      tax_behavior: 'country_default',
      inherit_parent_tax_category: 1,
      // Add-on stock is reset for the same reason variant stock is: the reset
      // starts an empty ledger, so any restored stock would have no movement
      // history behind it and would fail the ledger pre-check on every later
      // restore.
      stock_quantity: 0,
    }));
  const addonGroupProducts = snapshot.addonGroupProducts.filter(
    (link) => productIds.has(link.product_id) && addonGroupIds.has(link.addon_group_id),
  );
  const categoryAddonGroups = snapshot.categoryAddonGroups.filter(
    (link) => categoryIds.has(link.category_id) && addonGroupIds.has(link.addon_group_id),
  );
  // Variants are reset exactly like their product: prices are zeroed because
  // they are denominated in the old currency, and stock is zeroed because the
  // reset starts an empty ledger, so any restored stock would have no movement
  // history behind it and would fail the ledger pre-check on every later
  // restore. A recipe link whose base product did not survive is dropped so the
  // restored row stays referentially valid.
  const productVariants = snapshot.productVariants
    .filter((variant) => productIds.has(variant.product_id))
    .map((variant) => ({
      ...variant,
      price: 0,
      online_price: null,
      cost_price: null,
      stock_quantity: 0,
      inventory_product_id: productIds.has(variant.inventory_product_id)
        ? variant.inventory_product_id
        : null,
    }));

  insertSnapshotRows(dbInstance, 'categories', snapshot.categories);
  insertSnapshotRows(dbInstance, 'addon_groups', snapshot.addonGroups);
  insertSnapshotRows(dbInstance, 'products', products);
  const restoreInventoryLink = dbInstance.prepare(
    'UPDATE products SET inventory_product_id = ? WHERE id = ?',
  );
  for (const link of inventoryLinks) {
    if (link.inventoryProductId && productIds.has(link.inventoryProductId)) {
      restoreInventoryLink.run(link.inventoryProductId, link.id);
    }
  }
  insertSnapshotRows(dbInstance, 'addons', addons);
  insertSnapshotRows(dbInstance, 'product_variants', productVariants);
  insertSnapshotRows(dbInstance, 'addon_group_product', addonGroupProducts);
  insertSnapshotRows(dbInstance, 'category_addon_groups', categoryAddonGroups);
}

export async function resetDatabaseForCurrencyChange(
  targetCurrency: string,
  expectedCurrentCurrency: string,
  signal?: AbortSignal,
): Promise<{ backupPath: string; committed?: boolean; cleanupPending?: boolean }> {
  return withDatabaseMaintenanceLock(async (maintenanceSignal) => {
    const currentDb = getDatabase();
    const PRESERVED_SETTINGS = ['country', 'currency', 'timezone', 'local_backup_enabled'] as const;
    const settingsRows = currentDb
      .prepare(
        `SELECT key, value FROM settings WHERE key IN (${PRESERVED_SETTINGS.map(() => '?').join(', ')})`,
      )
      .all(...PRESERVED_SETTINGS) as { key: string; value: string }[];
    const settings = Object.fromEntries(settingsRows.map((row) => [row.key, row.value]));
    if (settings.currency !== expectedCurrentCurrency || settings.currency === targetCurrency) {
      throw Object.assign(new Error('Active currency changed'), { code: 'ERR_CURRENCY_CHANGED' });
    }
    const snapshot = captureCurrencyResetMenu(currentDb);
    const regional = resolveRegionalSnapshot({
      country: settings.country,
      currency: targetCurrency,
      timezone: settings.timezone,
    });

    return resetDatabaseWithBackupUnlocked(maintenanceSignal, (freshDb) => {
      freshDb.transaction(() => {
        freshDb.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
        restoreCurrencyResetMenu(freshDb, snapshot);
        const writeSetting = freshDb.prepare(
          'INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)',
        );
        writeSetting.run('country', regional.country, now());
        writeSetting.run('currency', regional.currency, now());
        writeSetting.run('currency_symbol', regional.currencySymbol, now());
        writeSetting.run('timezone', regional.timezone, now());
        if (settings.local_backup_enabled !== undefined) {
          writeSetting.run('local_backup_enabled', settings.local_backup_enabled, now());
        }
        freshDb.prepare('INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)').run(
          'currency_reset_pending',
          JSON.stringify({
            country: regional.country,
            currency: regional.currency,
            timezone: regional.timezone,
          }),
        );
      })();
    });
  }, signal);
}

/** Reads the canonical schema_version stamp createBackup() writes into _flo_meta. */
function parseCanonicalSchemaVersion(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function readBackupSchemaVersion(fullPath: string): number | null {
  let backupDb: Database.Database | undefined;
  try {
    backupDb = new Database(fullPath, { readonly: true, fileMustExist: true });
    const row = backupDb
      .prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;
    return row ? parseCanonicalSchemaVersion(row.value) : null;
  } catch {
    return null;
  } finally {
    backupDb?.close();
  }
}

export type BackupMetadata = {
  schemaVersion: number | null;
  appVersion: string | null;
  backupCreatedAt: string | null;
};

/** Reads the canonical metadata stamp without changing local backup behavior. */
export function getBackupMetadata(backupPath: string): BackupMetadata {
  let backupDb: Database.Database | undefined;
  try {
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    const rows = backupDb
      .prepare(
        `SELECT key, value FROM _flo_meta WHERE key IN ('schema_version', 'app_version', 'backup_created_at')`,
      )
      .all() as { key: string; value: string }[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const schemaValue = values.get('schema_version');
    const schemaVersion =
      schemaValue && /^(?:0|[1-9]\d*)$/.test(schemaValue) ? Number(schemaValue) : null;
    return {
      schemaVersion:
        schemaVersion !== null && Number.isSafeInteger(schemaVersion) ? schemaVersion : null,
      appVersion: values.get('app_version') || null,
      backupCreatedAt: values.get('backup_created_at') || null,
    };
  } catch {
    return { schemaVersion: null, appVersion: null, backupCreatedAt: null };
  } finally {
    backupDb?.close();
  }
}

export interface BackupInfo {
  fileName: string;
  path: string;
  sizeBytes: number;
  createdAt: string;
  kind: 'manual' | 'auto';
  schemaVersion: number | null;
}

export interface BackupPaginationOptions {
  limit?: number;
  cursor?: string;
}

export interface BackupPageResult {
  backups: BackupInfo[];
  nextCursor: string | null;
  hasMore: boolean;
}

function createInvalidBackupPaginationError(message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = 'ERR_INVALID_BACKUP_PAGINATION';
  return error;
}

export function encodeBackupCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), 'utf8').toString('base64url');
}

export function decodeBackupCursor(rawCursor: string): { createdAt: string; id: string } {
  if (typeof rawCursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(rawCursor)) {
    throw createInvalidBackupPaginationError('Invalid backup cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8'));
  } catch {
    throw createInvalidBackupPaginationError('Invalid backup cursor');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw createInvalidBackupPaginationError('Invalid backup cursor');
  }
  const { createdAt, id } = parsed as { createdAt?: unknown; id?: unknown };
  if (
    typeof createdAt !== 'string' ||
    createdAt.length === 0 ||
    Number.isNaN(Date.parse(createdAt)) ||
    typeof id !== 'string' ||
    id.length === 0
  ) {
    throw createInvalidBackupPaginationError('Invalid backup cursor');
  }
  return { createdAt, id };
}

export function parseBackupPaginationQuery(
  rawLimit: unknown,
  rawCursor: unknown,
): BackupPaginationOptions {
  const options: BackupPaginationOptions = {};
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
      throw createInvalidBackupPaginationError('Invalid backup pagination limit');
    }
    const limit = Number.parseInt(rawLimit, 10);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw createInvalidBackupPaginationError('Invalid backup pagination limit');
    }
    options.limit = limit;
  }
  if (rawCursor !== undefined) {
    if (typeof rawCursor !== 'string' || rawCursor.length === 0) {
      throw createInvalidBackupPaginationError('Invalid backup cursor');
    }
    decodeBackupCursor(rawCursor);
    options.cursor = rawCursor;
  }
  return options;
}

/** Lists auto and manual backups in the managed backups directory, newest first. */
export function listBackupsPage(options: BackupPaginationOptions = {}): BackupPageResult {
  if (
    options.limit !== undefined &&
    (typeof options.limit !== 'number' ||
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 100)
  ) {
    throw createInvalidBackupPaginationError('Invalid backup pagination limit');
  }
  const cursor = options.cursor !== undefined ? decodeBackupCursor(options.cursor) : null;
  const backupDir = getBackupDir();
  if (!fs.existsSync(backupDir)) {
    return { backups: [], nextCursor: null, hasMore: false };
  }

  let candidates = fs
    .readdirSync(backupDir)
    .filter((fileName) => hasManagedBackupPrefix(fileName) && fileName.endsWith('.db'))
    .map((fileName) => ({ fileName, fullPath: resolveContainedPath(backupDir, fileName) }))
    .filter((entry): entry is { fileName: string; fullPath: string } => {
      if (!entry.fullPath) return false;
      try {
        return fs.lstatSync(entry.fullPath).isFile();
      } catch {
        return false;
      }
    })
    .map(({ fileName, fullPath }) => {
      const stat = fs.statSync(fullPath);
      return {
        fileName,
        fullPath,
        sizeBytes: stat.size,
        createdAt: stat.mtime.toISOString(),
        kind: (fileName.includes('-pre-v') || isRestoreSafetyCopyName(fileName)
          ? 'auto'
          : 'manual') as 'manual' | 'auto',
      };
    })
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.fileName === b.fileName ? 0 : a.fileName < b.fileName ? 1 : -1;
    });

  if (cursor) {
    candidates = candidates.filter(
      (entry) =>
        entry.createdAt < cursor.createdAt ||
        (entry.createdAt === cursor.createdAt && entry.fileName < cursor.id),
    );
  }

  const limit = options.limit;
  const sliced = limit !== undefined ? candidates.slice(0, limit + 1) : candidates;
  const hasMore = limit !== undefined && sliced.length > limit;
  const pageEntries = limit !== undefined ? sliced.slice(0, limit) : sliced;
  const backups = pageEntries.map((entry) => ({
    fileName: entry.fileName,
    path: entry.fullPath,
    sizeBytes: entry.sizeBytes,
    createdAt: entry.createdAt,
    kind: entry.kind,
    schemaVersion: readBackupSchemaVersion(entry.fullPath),
  }));
  const last = backups[backups.length - 1];
  const nextCursor = hasMore && last ? encodeBackupCursor(last.createdAt, last.fileName) : null;
  return { backups, nextCursor, hasMore };
}

export function listBackups(): BackupInfo[];
export function listBackups(options: BackupPaginationOptions): BackupPageResult;
export function listBackups(options?: BackupPaginationOptions): BackupInfo[] | BackupPageResult {
  if (options === undefined) {
    return listBackupsPage().backups;
  }
  return listBackupsPage(options);
}

/** Deletes a backup from the managed backups directory after validating filename format. */
export function deleteBackup(fileName: string): void {
  const invalidName = () => {
    const error = new Error('Invalid backup file name') as Error & { code: string };
    error.code = 'ERR_INVALID_BACKUP_NAME';
    return error;
  };
  if (!/^(?:flo-backup|rest-cafe-backup)-[\w.-]+\.db$/.test(fileName)) {
    throw invalidName();
  }
  const backupDir = getBackupDir();
  const fullPath = resolveContainedPath(backupDir, fileName);
  if (!fullPath || path.dirname(fullPath) !== path.resolve(backupDir)) {
    throw invalidName();
  }
  if (!fs.existsSync(fullPath)) {
    const error = new Error('Backup not found') as Error & { code: string };
    error.code = 'ERR_BACKUP_NOT_FOUND';
    throw error;
  }
  fs.unlinkSync(fullPath);
}

/** Returns true if candidate path points to a valid file inside the managed backups directory. */
export function isManagedBackupFile(candidatePath: string): boolean {
  if (typeof candidatePath !== 'string' || !candidatePath) return false;
  let resolved: string;
  let backupDir: string;
  try {
    resolved = fs.realpathSync(candidatePath);
    backupDir = fs.realpathSync(getBackupDir());
  } catch {
    return false;
  }
  if (!resolved.startsWith(backupDir + path.sep)) return false;
  const fileName = path.basename(resolved);
  if (!hasManagedBackupPrefix(fileName) || !fileName.endsWith('.db')) return false;
  try {
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function getSchemaDefinitions(dbInstance: Database.Database): Map<string, string> {
  const rows = dbInstance
    .prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
      AND name <> '_flo_meta'
  `)
    .all() as { type: string; name: string; sql: string | null }[];
  return new Map(
    rows.map((row) => [`${row.type}:${row.name}`, (row.sql || '').replace(/\s+/g, ' ').trim()]),
  );
}

export function getColumns(dbInstance: Database.Database, tableName: string): string[] {
  try {
    const columns = dbInstance.prepare(`PRAGMA table_info(${tableName})`).all() as {
      name: string;
    }[];
    return columns.map((col) => col.name);
  } catch {
    return [];
  }
}

export function getTables(dbInstance: Database.Database): string[] {
  try {
    const tables = dbInstance
      .prepare(`
      SELECT name FROM sqlite_master WHERE type='table'
      AND (sql NOT LIKE 'CREATE VIRTUAL TABLE%' OR sql IS NULL)
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '%_fts_%'
      AND name NOT LIKE '%_fts'
      AND name <> '_flo_meta'
    `)
      .all() as { name: string }[];
    return tables.map((t) => t.name);
  } catch {
    return [];
  }
}

export function validateInventoryLedgerRows(
  productRows: readonly Record<string, unknown>[],
  movementRows: readonly Record<string, unknown>[],
  variantRows: readonly Record<string, unknown>[] = [],
  addonRows: readonly Record<string, unknown>[] = [],
): string | null {
  type Chain = {
    id: number | null;
    index: number;
    movementType: string;
    quantityDelta: number;
    stockAfter: number;
  };
  // A variant owns its own stock pool but shares the product id, and an add-on
  // pool has no product at all, so a chain is keyed by product AND variant AND
  // add-on. Exactly one pool id is set per movement, which keeps an add-on chain
  // from ever being compared against a product or variant snapshot row.
  const chainKey = (productId: string, variantId: string | null, addonId: string | null) =>
    `${productId}|${variantId ?? ''}|${addonId ?? ''}`;
  const movementsByChain = new Map<string, Chain[]>();

  for (const [index, row] of movementRows.entries()) {
    const productId = row?.product_id == null ? '' : String(row.product_id);
    const variantId = row?.variant_id == null ? null : String(row.variant_id);
    const addonId = row?.addon_id == null ? null : String(row.addon_id);
    const movementType = String(row?.movement_type ?? '');
    const quantityDelta = Number(row?.quantity_delta);
    const stockAfter = Number(row?.stock_after);
    const namesOnePool = productId ? !addonId : Boolean(addonId);
    if (
      !namesOnePool ||
      !Number.isFinite(quantityDelta) ||
      quantityDelta === 0 ||
      !Number.isFinite(stockAfter) ||
      stockAfter < 0
    ) {
      return 'Inventory movement history contains an invalid stock state';
    }
    if (movementType === 'sale' && quantityDelta >= 0) {
      return 'Sale movements must reduce product stock';
    }
    const rawId = Number(row?.id);
    const id = Number.isFinite(rawId) ? rawId : null;
    const key = chainKey(productId, variantId, addonId);
    const movements = movementsByChain.get(key) ?? [];
    movements.push({ id, index, movementType, quantityDelta, stockAfter });
    movementsByChain.set(key, movements);
  }

  const allHavePositiveIntegerIds =
    movementRows.length > 0 &&
    movementRows.every((row) => {
      const rawId = Number(row?.id);
      return Number.isInteger(rawId) && rawId > 0;
    });

  const latestMovementByChain = new Map<string, Chain>();
  for (const [key, movements] of movementsByChain) {
    // Order by durable append sequence when all movements carry positive integer IDs, otherwise preserve input order.
    movements.sort((left, right) =>
      allHavePositiveIntegerIds && left.id !== null && right.id !== null && left.id !== right.id
        ? left.id - right.id
        : left.index - right.index,
    );
    const firstMovement = movements[0];
    const firstTolerance =
      Number.EPSILON *
      Math.max(1, Math.abs(firstMovement.quantityDelta), Math.abs(firstMovement.stockAfter)) *
      10;
    if (Math.abs(firstMovement.quantityDelta - firstMovement.stockAfter) > firstTolerance) {
      return 'Inventory movement history is missing an opening balance';
    }
    for (let index = 1; index < movements.length; index += 1) {
      const previous = movements[index - 1];
      const current = movements[index];
      const expectedStockAfter = previous.stockAfter + current.quantityDelta;
      const tolerance =
        Number.EPSILON *
        Math.max(1, Math.abs(expectedStockAfter), Math.abs(current.stockAfter)) *
        10;
      if (Math.abs(expectedStockAfter - current.stockAfter) > tolerance) {
        return 'Inventory movement history contains a broken stock chain';
      }
    }
    const latestMovement = movements[movements.length - 1];
    latestMovementByChain.set(key, latestMovement);
  }

  const matchesLatestMovement = (
    label: 'Product' | 'Variant' | 'Add-on',
    productId: string,
    variantId: string | null,
    addonId: string | null,
    stockQuantity: number,
  ): string | null => {
    const latestMovement = latestMovementByChain.get(chainKey(productId, variantId, addonId));
    if (!latestMovement) {
      return stockQuantity === 0
        ? null
        : `${label} stock has no matching inventory movement history`;
    }
    const tolerance =
      Number.EPSILON *
      Math.max(1, Math.abs(latestMovement.stockAfter), Math.abs(stockQuantity)) *
      10;
    return Math.abs(latestMovement.stockAfter - stockQuantity) <= tolerance
      ? null
      : `${label} stock does not match the latest inventory movement`;
  };

  for (const row of productRows) {
    const productId = row?.id == null ? '' : String(row.id);
    if (
      !row ||
      typeof row !== 'object' ||
      !productId ||
      !Object.prototype.hasOwnProperty.call(row, 'stock_quantity')
    ) {
      return 'Product stock quantity is missing from the inventory snapshot';
    }
    const stockQuantity = row.stock_quantity == null ? 0 : Number(row.stock_quantity);
    if (!Number.isFinite(stockQuantity) || stockQuantity < 0) {
      return 'Product stock quantity is invalid in the inventory snapshot';
    }
    const mismatch = matchesLatestMovement('Product', productId, null, null, stockQuantity);
    if (mismatch) return mismatch;
  }

  for (const row of variantRows) {
    const productId = row?.product_id == null ? '' : String(row.product_id);
    const variantId = row?.id == null ? '' : String(row.id);
    if (
      !row ||
      typeof row !== 'object' ||
      !productId ||
      !variantId ||
      !Object.prototype.hasOwnProperty.call(row, 'stock_quantity')
    ) {
      return 'Variant stock quantity is missing from the inventory snapshot';
    }
    const stockQuantity = row.stock_quantity == null ? 0 : Number(row.stock_quantity);
    if (!Number.isFinite(stockQuantity) || stockQuantity < 0) {
      return 'Variant stock quantity is invalid in the inventory snapshot';
    }
    const mismatch = matchesLatestMovement('Variant', productId, variantId, null, stockQuantity);
    if (mismatch) return mismatch;
  }

  for (const row of addonRows) {
    const addonId = row?.id == null ? '' : String(row.id);
    if (
      !row ||
      typeof row !== 'object' ||
      !addonId ||
      !Object.prototype.hasOwnProperty.call(row, 'stock_quantity')
    ) {
      return 'Add-on stock quantity is missing from the inventory snapshot';
    }
    const stockQuantity = row.stock_quantity == null ? 0 : Number(row.stock_quantity);
    if (!Number.isFinite(stockQuantity) || stockQuantity < 0) {
      return 'Add-on stock quantity is invalid in the inventory snapshot';
    }
    const mismatch = matchesLatestMovement('Add-on', '', null, addonId, stockQuantity);
    if (mismatch) return mismatch;
  }

  return null;
}

export function validateInventoryLedgerDatabase(dbInstance: Database.Database): string | null {
  const tables = new Set(getTables(dbInstance));
  if (!tables.has('products')) return null;
  if (!getColumns(dbInstance, 'products').includes('stock_quantity')) {
    return 'Backup products table is missing stock_quantity';
  }

  const products = dbInstance.prepare('SELECT id, stock_quantity FROM products').all() as Record<
    string,
    unknown
  >[];
  const variants =
    tables.has('product_variants') &&
    getColumns(dbInstance, 'product_variants').includes('stock_quantity')
      ? (dbInstance
          .prepare('SELECT id, product_id, stock_quantity FROM product_variants')
          .all() as Record<string, unknown>[])
      : [];
  const addons =
    tables.has('addons') && getColumns(dbInstance, 'addons').includes('stock_quantity')
      ? (dbInstance.prepare('SELECT id, stock_quantity FROM addons').all() as Record<
          string,
          unknown
        >[])
      : [];
  if (!tables.has('inventory_movements')) {
    if (variants.some((variant) => Number(variant.stock_quantity ?? 0) !== 0)) {
      return 'Backup is missing inventory movement history for variant stock';
    }
    if (addons.some((addon) => Number(addon.stock_quantity ?? 0) !== 0)) {
      return 'Backup is missing inventory movement history for add-on stock';
    }
    return products.some((product) => Number(product.stock_quantity ?? 0) !== 0)
      ? 'Backup is missing inventory movement history for product stock'
      : null;
  }

  const movements = getInventoryMovementRows(dbInstance);
  return validateInventoryLedgerRows(products, movements, variants, addons);
}

export function getInventoryMovementRows(dbInstance: Database.Database): Record<string, unknown>[] {
  const columns = new Set(getColumns(dbInstance, 'inventory_movements'));
  const selectableColumns = [
    'id',
    'product_id',
    'variant_id',
    'addon_id',
    'quantity_delta',
    'movement_type',
    'reference_type',
    'reference_id',
    'reason',
    'actor_user_id',
    'stock_after',
    'created_at',
    'imported_by_user_id',
    'import_batch_id',
    'source_actor_user_id',
    'source_reference_type',
    'source_reference_id',
    'source_reason',
    'source_created_at',
  ].filter((column) => columns.has(column));
  if (selectableColumns.length === 0) return [];
  const orderBy = columns.has('id') ? ' ORDER BY id ASC' : '';
  return dbInstance
    .prepare(`SELECT ${selectableColumns.join(', ')} FROM inventory_movements${orderBy}`)
    .all() as Record<string, unknown>[];
}

function inventoryMovementHistoryKey(row: Record<string, unknown>): string {
  const nullableString = (value: unknown): string | null => (value == null ? null : String(value));
  const numericValue = (value: unknown): number | string | null => {
    if (value == null) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : String(value);
  };
  return JSON.stringify([
    numericValue(row.id),
    nullableString(row.product_id),
    nullableString(row.variant_id),
    nullableString(row.addon_id),
    numericValue(row.quantity_delta),
    nullableString(row.movement_type),
    nullableString(row.reference_type),
    nullableString(row.reference_id),
    nullableString(row.reason),
    nullableString(row.actor_user_id),
    nullableString(row.imported_by_user_id),
    nullableString(row.import_batch_id),
    numericValue(row.stock_after),
    nullableString(row.created_at),
    nullableString(row.source_actor_user_id ?? row.actor_user_id),
    nullableString(row.source_reference_type ?? row.reference_type),
    nullableString(row.source_reference_id ?? row.reference_id),
    nullableString(row.source_reason ?? row.reason),
    nullableString(row.source_created_at ?? row.created_at),
  ]);
}

export function validateInventoryLedgerReplacement(
  currentProductRows: readonly Record<string, unknown>[],
  currentMovementRows: readonly Record<string, unknown>[],
  replacementProductRows: readonly Record<string, unknown>[],
  replacementMovementRows: readonly Record<string, unknown>[],
): string | null {
  const replacementByProduct = new Map<string, Record<string, unknown>>();
  for (const row of replacementProductRows) {
    const productId = row?.id == null ? '' : String(row.id);
    if (productId) replacementByProduct.set(productId, row);
  }
  const replacementMovementProductIds = new Set(
    replacementMovementRows
      .map((row) => (row?.product_id == null ? '' : String(row.product_id)))
      .filter(Boolean),
  );
  const replacementHistoryCounts = new Map<string, number>();
  for (const row of replacementMovementRows) {
    const key = inventoryMovementHistoryKey(row);
    replacementHistoryCounts.set(key, (replacementHistoryCounts.get(key) ?? 0) + 1);
  }
  for (const row of currentMovementRows) {
    const key = inventoryMovementHistoryKey(row);
    const count = replacementHistoryCounts.get(key) ?? 0;
    if (count === 0) return 'Inventory movement history cannot be erased by a replacement';
    replacementHistoryCounts.set(key, count - 1);
  }

  for (const row of currentProductRows) {
    const productId = row?.id == null ? '' : String(row.id);
    const replacement = replacementByProduct.get(productId);
    if (!productId || !replacement) continue;

    const currentStock = Number(row?.stock_quantity ?? 0);
    const replacementStock = Number(replacement.stock_quantity ?? 0);
    if (!Number.isFinite(currentStock) || !Number.isFinite(replacementStock)) continue;
    const tolerance =
      Number.EPSILON * Math.max(1, Math.abs(currentStock), Math.abs(replacementStock)) * 10;
    if (
      Math.abs(currentStock - replacementStock) > tolerance &&
      !replacementMovementProductIds.has(productId)
    ) {
      return 'Product stock replacement is missing matching inventory movement history';
    }
  }

  return null;
}

export interface RestoreResult {
  success: boolean;
  mode: 'direct' | 'data_only' | 'full';
  backupSchemaVersion: number;
  currentSchemaVersion: number;
  tablesRestored: number;
  committed?: boolean;
  cleanupPending?: boolean;
  ambiguous?: boolean;
  error?: string;
}

function validateDirectBackup(
  backupPath: string,
  currentDb: Database.Database,
  currentVersion: number,
  baselineForeignKeyViolations: Set<string> = new Set(),
): string | null {
  let backupDb: Database.Database | undefined;
  try {
    const sourceStat = fs.lstatSync(backupPath);
    if (sourceStat.isSymbolicLink() || !sourceStat.isFile())
      return 'Direct restore source must be a regular file';
    if (pathEntryExists(`${backupPath}-wal`) || pathEntryExists(`${backupPath}-shm`))
      return 'Direct restore source must not have SQLite sidecars';
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    const metaRow = backupDb
      .prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`)
      .get() as { value: string } | undefined;
    const metadataVersion = metaRow ? (parseCanonicalSchemaVersion(metaRow.value) ?? 0) : 0;
    const pragmaVersion = Number(backupDb.pragma('user_version', { simple: true }));
    if (metadataVersion !== currentVersion || pragmaVersion !== currentVersion) {
      return `Direct restore requires matching metadata/header schema v${currentVersion}`;
    }

    const integrity = backupDb.prepare('PRAGMA integrity_check').all() as {
      integrity_check: string;
    }[];
    if (integrity.some((row) => row.integrity_check !== 'ok')) {
      return `Backup integrity check failed: ${integrity.map((row) => row.integrity_check).join('; ')}`;
    }
    const backupForeignKeyViolations = getForeignKeyViolationKeys(backupDb);
    const newForeignKeyViolations = [...backupForeignKeyViolations].filter(
      (key) => !baselineForeignKeyViolations.has(key),
    );
    if (newForeignKeyViolations.length > 0) {
      return `Backup contains ${newForeignKeyViolations.length} new foreign-key violation(s)`;
    }

    const currentTables = getTables(currentDb);
    const backupTables = new Set(getTables(backupDb));
    const missingTables = currentTables.filter((tableName) => !backupTables.has(tableName));
    if (missingTables.length > 0) {
      return `Backup is missing required table(s): ${missingTables.join(', ')}`;
    }

    for (const tableName of currentTables) {
      const backupColumns = new Set(getColumns(backupDb, tableName));
      const missingColumns = getColumns(currentDb, tableName).filter(
        (column) => !backupColumns.has(column),
      );
      if (missingColumns.length > 0) {
        return `Backup table ${tableName} is missing required column(s): ${missingColumns.join(', ')}`;
      }
    }

    const inventoryValidationError = validateInventoryLedgerDatabase(backupDb);
    if (inventoryValidationError) return inventoryValidationError;

    const inventoryReplacementError = validateInventoryLedgerReplacement(
      currentDb.prepare('SELECT id, stock_quantity FROM products').all() as Record<
        string,
        unknown
      >[],
      getInventoryMovementRows(currentDb),
      backupDb.prepare('SELECT id, stock_quantity FROM products').all() as Record<
        string,
        unknown
      >[],
      getInventoryMovementRows(backupDb),
    );
    if (inventoryReplacementError) return inventoryReplacementError;

    const currentSchema = getSchemaDefinitions(currentDb);
    const backupSchema = getSchemaDefinitions(backupDb);
    for (const [key, definition] of currentSchema) {
      if (backupSchema.get(key) !== definition) {
        return `Backup schema object ${key} is missing or differs from the current definition`;
      }
    }
    for (const key of backupSchema.keys()) {
      if (!currentSchema.has(key)) {
        return `Backup contains unapproved schema object ${key}`;
      }
    }
    return null;
  } catch (error: any) {
    return `Backup validation failed: ${error?.message || 'unknown error'}`;
  } finally {
    backupDb?.close();
  }
}

type RevocationRow = { token_hash: string; expires_at: number; revoked_at: string };
export type UserStationSecurityState = {
  user_id: string;
  station_id: string;
  is_active: number;
  category_ids: string | null;
};
export type KitchenStationSecurityState = {
  id: string;
  is_active: number;
  category_ids: string | null;
};

export function captureKitchenStationSecurityState(
  dbInstance: Database.Database,
): KitchenStationSecurityState[] {
  try {
    return dbInstance
      .prepare('SELECT id, is_active, category_ids FROM kitchen_stations')
      .all() as KitchenStationSecurityState[];
  } catch {
    return [];
  }
}

export type KdsEnabledSettingState = { present: boolean; value: string | null };
export type RestoreProtectedSettingState = { key: string; present: boolean; value: string | null };
export type RestoreOutboxState = {
  cloud: Record<string, unknown>[];
  support: Record<string, unknown>[];
  diagnostics: Record<string, unknown>[];
  diagnosticsAggregates?: Record<string, unknown>[];
  diagnosticsGaps?: Record<string, unknown>[];
  /** Device-local failure log; present on restores that predate it. */
  local?: Record<string, unknown>[];
};
const RESTORE_PROTECTED_SETTING_KEYS = [
  'jwt_secret',
  'email',
  'cloud_api_key',
  'cloud_device_secret',
  'cloud_pos_hash',
  'offline_mode',
  'local_backup_enabled',
  'telemetry_enabled',
  'product_analytics_level',
  'diagnostics_consent',
  'diagnostics_transmission_enabled',
  'diagnostics_settings_explicit',
  'diagnostics_consent_sync_pending',
  'diagnostics_consent_change_id',
  'diagnostics_consent_revision',
  'diagnostics_consent_remote_initialized',
  'mobile_pairing_code',
  'mobile_pairing_code_expires_at',
];

export function captureRestoreProtectedSettings(
  dbInstance: Database.Database,
): RestoreProtectedSettingState[] {
  const fixedRows = dbInstance
    .prepare(
      `SELECT key, value FROM settings WHERE key IN (${RESTORE_PROTECTED_SETTING_KEYS.map(() => '?').join(',')})`,
    )
    .all(...RESTORE_PROTECTED_SETTING_KEYS) as { key: string; value: string | null }[];
  const cloudRows = dbInstance
    .prepare("SELECT key, value FROM settings WHERE key LIKE 'cloud_%'")
    .all() as { key: string; value: string | null }[];
  const byKey = new Map([...fixedRows, ...cloudRows].map((row) => [row.key, row.value]));
  const keys = [
    ...new Set([...RESTORE_PROTECTED_SETTING_KEYS, ...cloudRows.map((row) => row.key)]),
  ];
  const deviceSecret = byKey.get('cloud_device_secret');
  return keys.map((key) => ({
    key,
    // Exclude short-lived credentials and standalone position hashes from restore.
    present:
      !key.startsWith('mobile_pairing_code') &&
      !(key === 'cloud_pos_hash' && !deviceSecret) &&
      byKey.has(key),
    value: byKey.get(key) ?? null,
  }));
}

export function mergeRestoreProtectedSettings(
  dbInstance: Database.Database,
  states: RestoreProtectedSettingState[],
): void {
  const upsert = dbInstance.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  // Clear cloud settings first; cloud identity is installation-local.
  dbInstance.prepare("DELETE FROM settings WHERE key LIKE 'cloud_%'").run();
  for (const state of states) {
    if (state.present) upsert.run(state.key, state.value, now());
    else if (!state.key.startsWith('cloud_'))
      dbInstance.prepare('DELETE FROM settings WHERE key = ?').run(state.key);
  }
  try {
    const activeOwners = dbInstance
      .prepare(
        "SELECT lower(trim(email)) AS email FROM users WHERE role = 'owner' AND is_active = 1 AND email IS NOT NULL AND trim(email) != '' ORDER BY created_at ASC, id ASC",
      )
      .all() as { email: string }[];
    if (activeOwners.length > 0) {
      const currentEmail = String(
        (
          dbInstance.prepare("SELECT value FROM settings WHERE key = 'email'").get() as
            | { value: string | null }
            | undefined
        )?.value || '',
      )
        .trim()
        .toLowerCase();
      if (!activeOwners.some((row) => row.email === currentEmail)) {
        upsert.run('email', activeOwners[0].email, now());
      }
    }
  } catch {
    // Skip owner email resync if users table is unavailable in a partial fixture.
  }
  bumpSettingsRevision();
}

export function captureRestoreOutboxState(dbInstance: Database.Database): RestoreOutboxState {
  const pending = (table: string) =>
    dbInstance
      .prepare(`SELECT * FROM ${table} WHERE status IN ('pending', 'failed', 'sending')`)
      .all() as Record<string, unknown>[];
  // A SQLite backup copies the whole file, so local_diagnostics travels with it.
  // Those rows describe the till that produced them, so the receiving device
  // keeps its own and drops the incoming one.
  const local = dbInstance
    .prepare('SELECT * FROM local_diagnostics ORDER BY id ASC')
    .all() as Record<string, unknown>[];
  const diagnosticsAggregates = dbInstance
    .prepare('SELECT * FROM diagnostics_hourly_aggregates ORDER BY window_start, aggregate_key')
    .all() as Record<string, unknown>[];
  const diagnosticsGaps = dbInstance
    .prepare('SELECT * FROM diagnostics_delivery_gaps ORDER BY reason_code')
    .all() as Record<string, unknown>[];
  return {
    cloud: pending('cloud_sync_outbox'),
    support: pending('support_ticket_outbox'),
    diagnostics: pending('store_diagnostics_outbox'),
    diagnosticsAggregates,
    diagnosticsGaps,
    local,
  };
}

export function mergeRestoreOutboxState(
  dbInstance: Database.Database,
  state: RestoreOutboxState,
): void {
  dbInstance.exec(
    'DELETE FROM cloud_sync_outbox; DELETE FROM support_ticket_outbox; DELETE FROM store_diagnostics_outbox; DELETE FROM local_diagnostics; DELETE FROM diagnostics_hourly_aggregates; DELETE FROM diagnostics_delivery_gaps',
  );
  const cloud = dbInstance.prepare(`INSERT OR REPLACE INTO cloud_sync_outbox
    (id, event_type, entity_type, entity_id, payload, status, attempt_count, next_attempt_at, last_error, delivered_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of state.cloud)
    cloud.run(
      row.id,
      row.event_type,
      row.entity_type,
      row.entity_id,
      row.payload,
      row.status === 'sending' ? 'failed' : row.status,
      row.attempt_count || 0,
      row.next_attempt_at || now(),
      row.last_error || null,
      row.delivered_at || null,
      row.created_at || now(),
      row.updated_at || now(),
    );
  const support = dbInstance.prepare(`INSERT OR REPLACE INTO support_ticket_outbox
    (client_ticket_id, payload, status, support_code, attempt_count, next_attempt_at, last_error, created_at, updated_at, delivered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of state.support)
    support.run(
      row.client_ticket_id,
      row.payload,
      row.status === 'sending' ? 'failed' : row.status,
      row.support_code || null,
      row.attempt_count || 0,
      row.next_attempt_at || now(),
      row.last_error || null,
      row.created_at || now(),
      row.updated_at || now(),
      row.delivered_at || null,
    );
  const diagnostics = dbInstance.prepare(`INSERT OR REPLACE INTO store_diagnostics_outbox
    (event_id, payload, status, attempt_count, next_attempt_at, last_error, created_at, updated_at, delivered_at, transport, permanent_failure)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of state.diagnostics)
    diagnostics.run(
      row.event_id,
      row.payload,
      row.status === 'sending' ? 'failed' : row.status,
      row.attempt_count || 0,
      row.next_attempt_at || now(),
      row.last_error || null,
      row.created_at || now(),
      row.updated_at || now(),
      row.delivered_at || null,
      row.transport || 'signed',
      row.permanent_failure ? 1 : 0,
    );
  const aggregate = dbInstance.prepare(`INSERT INTO diagnostics_hourly_aggregates
    (aggregate_key, capture_point, reason_code, classification, operation, stage, outcome, window_start,
     count, first_occurred_at, last_occurred_at, app_version, app_build, platform, examples_json, facts_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of state.diagnosticsAggregates || [])
    aggregate.run(
      row.aggregate_key,
      row.capture_point,
      row.reason_code,
      row.classification,
      row.operation,
      row.stage,
      row.outcome,
      row.window_start,
      row.count,
      row.first_occurred_at,
      row.last_occurred_at,
      row.app_version,
      row.app_build,
      row.platform,
      row.examples_json || '[]',
      row.facts_json || '{}',
      row.updated_at || now(),
    );
  const gap = dbInstance.prepare(
    `INSERT INTO diagnostics_delivery_gaps (reason_code, count, first_occurred_at, last_occurred_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const row of state.diagnosticsGaps || [])
    gap.run(
      row.reason_code,
      row.count,
      row.first_occurred_at || now(),
      row.last_occurred_at || now(),
      row.updated_at || now(),
    );
  const local = dbInstance.prepare(`INSERT INTO local_diagnostics
    (event_code, severity, error_class, signature, summary, metadata_json, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of state.local || [])
    local.run(
      row.event_code,
      row.severity,
      row.error_class,
      row.signature,
      row.summary,
      row.metadata_json || null,
      row.occurred_at,
      row.created_at,
    );
  // Re-cap in case this device was already at the limit before the restore.
  dbInstance
    .prepare(
      'DELETE FROM local_diagnostics WHERE id NOT IN (SELECT id FROM local_diagnostics ORDER BY id DESC LIMIT ?)',
    )
    .run(200);
}

export function captureKdsEnabledSetting(dbInstance: Database.Database): KdsEnabledSettingState {
  const row = dbInstance.prepare('SELECT value FROM settings WHERE key = ?').get('kds_enabled') as
    | { value: string | null }
    | undefined;
  // A missing setting has always meant enabled; preserve that effective
  // security posture instead of letting an older backup disable KDS.
  return { present: true, value: row?.value ?? 'true' };
}

export function mergeKdsEnabledSetting(
  dbInstance: Database.Database,
  state: KdsEnabledSettingState,
): void {
  if (!state.present) return;
  dbInstance
    .prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES ('kds_enabled', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)
    .run(state.value, now());
}

export function captureUserStationSecurityState(
  dbInstance: Database.Database,
): UserStationSecurityState[] {
  try {
    return dbInstance
      .prepare(`
      SELECT su.user_id, su.station_id, ks.is_active, ks.category_ids
      FROM station_users su
      JOIN kitchen_stations ks ON ks.id = su.station_id
    `)
      .all() as UserStationSecurityState[];
  } catch {
    return [];
  }
}

export function mergeUserStationSecurityState(
  dbInstance: Database.Database,
  rows: UserStationSecurityState[],
  userIds: string[],
  preservedStations: KitchenStationSecurityState[] = [],
): void {
  const preservedIds = new Set(userIds);
  const currentStation = dbInstance.prepare('SELECT 1 FROM kitchen_stations WHERE id = ?');
  const missingStations = preservedStations
    .filter((station) => !currentStation.get(station.id))
    .map((station) => station.id);
  if (missingStations.length > 0) {
    throw new Error(
      `Restore cannot preserve current kitchen station(s): ${missingStations.join(', ')}`,
    );
  }
  const restoreStationSecurity = dbInstance.prepare(
    'UPDATE kitchen_stations SET is_active = ?, category_ids = ?, updated_at = ? WHERE id = ?',
  );
  for (const station of preservedStations) {
    restoreStationSecurity.run(station.is_active, station.category_ids, now(), station.id);
  }
  const stationState = dbInstance.prepare(
    'SELECT is_active, category_ids FROM kitchen_stations WHERE id = ?',
  );
  const invalidStations = rows
    .filter((row) => preservedIds.has(row.user_id))
    .filter((row) => {
      const restored = stationState.get(row.station_id) as
        | { is_active: number; category_ids: string | null }
        | undefined;
      return (
        !restored ||
        restored.is_active !== row.is_active ||
        restored.category_ids !== row.category_ids
      );
    })
    .map((row) => `${row.user_id}:${row.station_id}`);
  if (invalidStations.length > 0) {
    throw new Error(
      `Restore cannot preserve current station security state(s): ${invalidStations.join(', ')}`,
    );
  }

  const currentUsers = dbInstance.prepare('SELECT id FROM users').all() as { id: string }[];
  for (const user of currentUsers) {
    dbInstance.prepare('DELETE FROM station_users WHERE user_id = ?').run(user.id);
  }
  const insert = dbInstance.prepare(
    'INSERT INTO station_users (user_id, station_id, created_at) VALUES (?, ?, ?)',
  );
  for (const row of rows) {
    if (preservedIds.has(row.user_id)) insert.run(row.user_id, row.station_id, now());
  }
}

export type UserSecurityState = {
  id: string;
  name: string;
  email: string | null;
  password: string;
  pin: string | null;
  pin_hash: string | null;
  role: string;
  category_ids: string | null;
  is_active: number;
  tokens_valid_after: string | null;
  station_assignments_configured: number;
};

export function getUserKdsStationIds(
  dbInstance: Database.Database,
  userId: string,
): string[] | null {
  try {
    return (
      dbInstance
        .prepare(`
      SELECT su.station_id
      FROM station_users su
      JOIN kitchen_stations ks ON ks.id = su.station_id
      WHERE su.user_id = ? AND ks.is_active = 1
    `)
        .all(userId) as { station_id: string }[]
    ).map((row) => String(row.station_id));
  } catch {
    return null;
  }
}

export function getKdsStationCategoryIds(
  dbInstance: Database.Database,
  stationIds: string[],
): string[] | null {
  if (stationIds.length === 0) return [];
  try {
    const placeholders = stationIds.map(() => '?').join(',');
    const rows = dbInstance
      .prepare(
        `SELECT category_ids FROM kitchen_stations WHERE is_active = 1 AND id IN (${placeholders})`,
      )
      .all(...stationIds) as { category_ids: string | null }[];
    const categories = new Set<string>();
    for (const row of rows) {
      if (!row.category_ids) continue;
      try {
        const parsed = JSON.parse(row.category_ids);
        if (Array.isArray(parsed))
          for (const categoryId of parsed)
            if (categoryId != null) categories.add(String(categoryId));
      } catch {}
    }
    return [...categories];
  } catch {
    return null;
  }
}

export type KdsStationRoutingScope = {
  tablelessCategoryIds: string[];
  categoryIdsByStation: Record<string, string[] | null>;
  hasUnrestrictedStation: boolean;
};

export function getKdsStationRoutingScope(
  dbInstance: Database.Database,
  stationIds: string[],
  userCategoryIds: string[],
): KdsStationRoutingScope | null {
  if (stationIds.length === 0)
    return { tablelessCategoryIds: [], categoryIdsByStation: {}, hasUnrestrictedStation: false };
  try {
    const placeholders = stationIds.map(() => '?').join(',');
    const rows = dbInstance
      .prepare(`
      SELECT id, category_ids FROM kitchen_stations
      WHERE is_active = 1 AND id IN (${placeholders})
    `)
      .all(...stationIds) as { id: string; category_ids: string | null }[];
    const byStation: Record<string, string[] | null> = {};
    const tableless = new Set<string>();
    let hasUnrestrictedStation = false;
    for (const stationId of stationIds) {
      const row = rows.find((candidate) => String(candidate.id) === String(stationId));
      let stationCategories: string[] = [];
      if (row?.category_ids) {
        try {
          const parsed = JSON.parse(row.category_ids);
          if (!Array.isArray(parsed)) return null;
          stationCategories = parsed.filter((id) => id != null).map(String);
        } catch {
          return null;
        }
      }
      const allowed =
        stationCategories.length > 0
          ? stationCategories.filter(
              (id) => userCategoryIds.length === 0 || userCategoryIds.includes(id),
            )
          : userCategoryIds.length > 0
            ? [...userCategoryIds]
            : null;
      byStation[String(stationId)] = allowed;
      if (allowed === null) hasUnrestrictedStation = true;
      if (allowed !== null) allowed.forEach((id) => tableless.add(id));
    }
    return {
      tablelessCategoryIds: [...tableless],
      categoryIdsByStation: byStation,
      hasUnrestrictedStation,
    };
  } catch {
    return null;
  }
}

export function getKdsStationRoutingCategoryIds(
  dbInstance: Database.Database,
  stationIds: string[],
  userCategoryIds: string[],
): string[] | null {
  return (
    getKdsStationRoutingScope(dbInstance, stationIds, userCategoryIds)?.tablelessCategoryIds ?? null
  );
}

export function isKdsStationItemAllowed(
  stationIds: string[],
  stationCategoryIds: string[],
  orderStationId: string | null | undefined,
  itemCategoryId: string | null | undefined,
  orderStationCategoryIds?: string[] | null,
  hasUnrestrictedStation = false,
): boolean {
  if (stationIds.length === 0) return true;
  if (orderStationId) {
    if (!stationIds.includes(String(orderStationId))) return false;
    if (orderStationCategoryIds === undefined) return true;
    if (orderStationCategoryIds === null) return true;
    return !!itemCategoryId && orderStationCategoryIds.includes(String(itemCategoryId));
  }
  return (
    hasUnrestrictedStation ||
    (!!itemCategoryId && stationCategoryIds.includes(String(itemCategoryId)))
  );
}

export function hasUserKdsStationAssignments(
  dbInstance: Database.Database,
  userId: string,
): boolean | null {
  try {
    const row = dbInstance
      .prepare(`
      SELECT station_assignments_configured,
             EXISTS (SELECT 1 FROM station_users WHERE user_id = ?) AS assigned
      FROM users WHERE id = ?
    `)
      .get(userId, userId) as
      | { station_assignments_configured: number; assigned: number }
      | undefined;
    if (!row) return null;
    return row.station_assignments_configured === 1 || row.assigned === 1;
  } catch {
    return null;
  }
}

export function captureUserSecurityState(dbInstance: Database.Database): UserSecurityState[] {
  try {
    return dbInstance
      .prepare(
        'SELECT id, name, email, password, pin, pin_hash, role, category_ids, is_active, tokens_valid_after, station_assignments_configured FROM users',
      )
      .all() as UserSecurityState[];
  } catch {
    return [];
  }
}

export function mergeUserSecurityState(
  dbInstance: Database.Database,
  rows: UserSecurityState[],
): void {
  for (const row of rows) {
    const restored = dbInstance
      .prepare(
        'SELECT id, is_active, tokens_valid_after, station_assignments_configured FROM users WHERE id = ?',
      )
      .get(row.id) as UserSecurityState | undefined;
    if (!restored) continue;
    const currentEpoch = row.tokens_valid_after;
    const restoredEpoch = restored.tokens_valid_after;
    const currentParsedTime = currentEpoch ? parseDbTimestamp(currentEpoch).getTime() : Number.NaN;
    const restoredParsedTime = restoredEpoch
      ? parseDbTimestamp(restoredEpoch).getTime()
      : Number.NaN;
    const currentTime = Number.isFinite(currentParsedTime)
      ? currentParsedTime
      : Number.NEGATIVE_INFINITY;
    const restoredTime = Number.isFinite(restoredParsedTime)
      ? restoredParsedTime
      : Number.NEGATIVE_INFINITY;
    const tokensValidAfter = currentTime >= restoredTime ? currentEpoch : restoredEpoch;
    dbInstance
      .prepare(`
      UPDATE users
      SET name = ?, email = ?, password = ?, pin = ?, pin_hash = ?, role = ?, category_ids = ?,
          is_active = ?, tokens_valid_after = ?, station_assignments_configured = ?
      WHERE id = ?
    `)
      .run(
        row.name,
        row.email,
        row.password,
        row.pin,
        row.pin_hash,
        row.role,
        row.category_ids,
        row.is_active,
        tokensValidAfter,
        row.station_assignments_configured || 0,
        row.id,
      );
  }

  // Accounts introduced only by an older snapshot must not become a new
  // login path without an explicit owner reactivation.
  const preservedIds = new Set(rows.map((row) => row.id));
  const restoredUsers = dbInstance.prepare('SELECT id FROM users').all() as { id: string }[];
  const restoredIds = new Set(restoredUsers.map((user) => user.id));
  const disableRestoredOnly = dbInstance.prepare(
    'UPDATE users SET is_active = 0, tokens_valid_after = ? WHERE id = ?',
  );
  for (const user of restoredUsers) {
    if (!preservedIds.has(user.id)) disableRestoredOnly.run(now(), user.id);
  }

  const insertPreservedUser = dbInstance.prepare(`
    INSERT INTO users (id, name, email, password, pin, pin_hash, role, category_ids, is_active, tokens_valid_after, station_assignments_configured, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    if (restoredIds.has(row.id)) continue;
    const emailConflict = row.email
      ? (dbInstance.prepare('SELECT id FROM users WHERE email = ?').get(row.email) as
          | { id: string }
          | undefined)
      : undefined;
    if (emailConflict)
      dbInstance.prepare('UPDATE users SET email = NULL WHERE id = ?').run(emailConflict.id);
    insertPreservedUser.run(
      row.id,
      row.name,
      row.email,
      row.password,
      row.pin,
      row.pin_hash,
      row.role,
      row.category_ids,
      row.is_active,
      row.tokens_valid_after,
      row.station_assignments_configured || 0,
      now(),
      now(),
    );
  }
}

function readRevocations(dbInstance: Database.Database): RevocationRow[] {
  try {
    return dbInstance
      .prepare('SELECT token_hash, expires_at, revoked_at FROM revoked_tokens')
      .all() as RevocationRow[];
  } catch {
    return [];
  }
}

function mergeRevocations(dbInstance: Database.Database, rows: RevocationRow[]): void {
  if (rows.length === 0) return;
  const merge = dbInstance.prepare(`
    INSERT INTO revoked_tokens (token_hash, expires_at, revoked_at)
    VALUES (?, ?, ?)
    ON CONFLICT(token_hash) DO UPDATE SET
      expires_at = MAX(revoked_tokens.expires_at, excluded.expires_at),
      revoked_at = MIN(revoked_tokens.revoked_at, excluded.revoked_at)
  `);
  for (const row of rows) merge.run(row.token_hash, row.expires_at, row.revoked_at);
}

export function restoreBackup(
  backupPath: string,
  forceDirect: boolean = false,
  signal?: AbortSignal,
): RestoreResult {
  throwIfDatabaseMaintenanceAborted(signal);
  console.log('[DB] restoreBackup: Starting restore from:', backupPath);
  let stagedSource: { snapshotPath: string; cleanup: () => void } | undefined;
  try {
    stagedSource = materializeRestoreSource(backupPath, getDbPath());
    backupPath = stagedSource.snapshotPath;
  } catch (error: any) {
    const currentVersion = getCurrentSchemaVersion();
    return {
      success: false,
      mode: forceDirect ? 'direct' : 'data_only',
      backupSchemaVersion: 0,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: error?.message || 'Invalid restore source',
    };
  }

  try {
    let metadataVersion = 0;
    let metadataStampPresent = false;
    let pragmaVersion = 0;
    let backupDb: Database.Database | undefined;
    let unreadableSource = false;
    try {
      backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
      const metaRow = backupDb
        .prepare(`SELECT value FROM _flo_meta WHERE key = 'schema_version'`)
        .get() as { value: string } | undefined;
      metadataStampPresent = Boolean(metaRow);
      metadataVersion = metaRow ? (parseCanonicalSchemaVersion(metaRow.value) ?? 0) : 0;
      pragmaVersion = Number(backupDb.pragma('user_version', { simple: true }));
    } catch {
      // A file that is not a readable SQLite database (truncated, corrupt, or
      // simply not a database at all) must be refused, never applied.
      unreadableSource = true;
    } finally {
      backupDb?.close();
    }

    if (unreadableSource) {
      return {
        success: false,
        mode: forceDirect ? 'direct' : 'data_only',
        backupSchemaVersion: 0,
        currentSchemaVersion: getCurrentSchemaVersion(),
        tablesRestored: 0,
        error: 'Restore source is not a readable Flo database file',
      };
    }

    // Determine schema version from metadata stamp or SQLite user_version pragma.
    const backupSchemaVersion =
      Number.isFinite(metadataVersion) && metadataVersion > 0 ? metadataVersion : pragmaVersion;
    const currentDb = getDatabase();
    const currentVersion = getCurrentSchemaVersion();
    // Preserve revocations from live database so restored older snapshot cannot unrevoke tokens.
    const preservedRevocations = readRevocations(currentDb);
    const preservedUserSecurity = captureUserSecurityState(currentDb);
    const preservedUserStations = captureUserStationSecurityState(currentDb);
    const preservedStationSecurity = captureKitchenStationSecurityState(currentDb);
    const preservedKdsEnabled = captureKdsEnabledSetting(currentDb);
    const preservedProtectedSettings = captureRestoreProtectedSettings(currentDb);
    const preservedOutboxes = captureRestoreOutboxState(currentDb);

    console.log(
      `[DB] Backup schema version: ${backupSchemaVersion}, SQLite: ${pragmaVersion}, Current: ${currentVersion}`,
    );

    if (metadataStampPresent && (metadataVersion <= 0 || metadataVersion !== pragmaVersion)) {
      return {
        success: false,
        mode: forceDirect ? 'direct' : 'data_only',
        backupSchemaVersion,
        currentSchemaVersion: currentVersion,
        tablesRestored: 0,
        error: 'Backup schema metadata does not match the SQLite header',
      };
    }

    if (forceDirect && pragmaVersion > currentVersion) {
      return {
        success: false,
        mode: 'direct',
        backupSchemaVersion,
        currentSchemaVersion: currentVersion,
        tablesRestored: 0,
        error: `Direct restore rejected: backup schema v${pragmaVersion} is newer than supported schema v${currentVersion}`,
      };
    }

    if (forceDirect || backupSchemaVersion === currentVersion) {
      throwIfDatabaseMaintenanceAborted(signal);
      const baselineForeignKeyViolations = getForeignKeyViolationKeys(currentDb);
      const validationError = validateDirectBackup(
        backupPath,
        currentDb,
        currentVersion,
        baselineForeignKeyViolations,
      );
      if (validationError) {
        return {
          success: false,
          mode: 'direct',
          backupSchemaVersion,
          currentSchemaVersion: currentVersion,
          tablesRestored: 0,
          error: validationError,
        };
      }

      console.log('[DB] restoreBackup: Direct restore (same schema version)');
      const dbPath = getDbPath();
      let recoveryPath = '';
      let journalPath = '';

      let recoveryCopyReady = false;
      let recoveryCompleted = false;
      try {
        // Checkpoint the live WAL before making a synchronous recovery copy.
        currentDb.pragma('wal_checkpoint(TRUNCATE)');
        const replacementJournal = beginDatabaseReplacementJournal(dbPath, 'restore');
        recoveryPath = replacementJournal.recoveryPath;
        journalPath = replacementJournal.journalPath;
        recoveryCopyReady = true;
        writeReplacementJournal(journalPath, {
          phase: 'prepared',
          recoveryPath,
          dbPath,
          baselineForeignKeyViolations: [...baselineForeignKeyViolations],
          driveInvalidationRequired: true,
        });
        throwIfDatabaseMaintenanceAborted(signal);
        closeDatabase();
        throwIfDatabaseMaintenanceAborted(signal);
        const removeFailures = removeDatabaseFiles(dbPath);
        if (removeFailures.length > 0) {
          throw new Error(`Could not remove database files: ${removeFailures.join(', ')}`);
        }
        throwIfDatabaseMaintenanceAborted(signal);
        fs.copyFileSync(backupPath, dbPath);
        initDatabase(false, true);

        const freshDb = getDatabase();
        mergeUserSecurityState(freshDb, preservedUserSecurity);
        mergeUserStationSecurityState(
          freshDb,
          preservedUserStations,
          preservedUserSecurity.map((row) => row.id),
          preservedStationSecurity,
        );
        mergeKdsEnabledSetting(freshDb, preservedKdsEnabled);
        mergeRestoreProtectedSettings(freshDb, preservedProtectedSettings);
        freshDb.prepare('DELETE FROM kds_pairing_tokens').run();
        freshDb.prepare('DELETE FROM customer_display_tokens').run();
        mergeRestoreOutboxState(freshDb, preservedOutboxes);
        mergeRevocations(freshDb, preservedRevocations);
        executeSequenceRepair(freshDb);
        freshDb
          .prepare(`
            INSERT INTO settings (key, value, updated_at) VALUES ('sequence_repair_completed_at', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          `)
          .run(now(), now());
        freshDb
          .prepare(`
            INSERT INTO settings (key, value, updated_at) VALUES ('sequence_repair_pending', '0', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          `)
          .run(now());
        const integrity = freshDb.prepare('PRAGMA integrity_check').all() as {
          integrity_check: string;
        }[];
        const newForeignKeyViolations = [...getForeignKeyViolationKeys(freshDb)].filter(
          (key) => !baselineForeignKeyViolations.has(key),
        );
        if (
          integrity.some((row) => row.integrity_check !== 'ok') ||
          newForeignKeyViolations.length > 0
        ) {
          throw new Error('Restored database failed integrity validation');
        }
        throwIfDatabaseMaintenanceAborted(signal);
        freshDb.pragma('wal_checkpoint(TRUNCATE)');
        syncFile(dbPath);
        if (!syncDirectory(path.dirname(dbPath)) && process.platform !== 'win32') {
          throw new Error('Could not durably commit restored database');
        }
        throwIfDatabaseMaintenanceAborted(signal);
        clearGoogleDriveRestoreBinding(freshDb);
        writeReplacementJournal(journalPath, {
          phase: 'committed',
          recoveryPath,
          dbPath,
          baselineForeignKeyViolations: [...baselineForeignKeyViolations],
          driveInvalidationRequired: true,
        });
        // The replacement is durable; keep the snapshot of what it replaced so a
        // customer who restores the wrong file can undo it.
        retainRestoreSafetyCopy(recoveryPath, currentVersion);
        return {
          success: true,
          mode: 'direct',
          backupSchemaVersion,
          currentSchemaVersion: currentVersion,
          tablesRestored: getTables(freshDb).length,
          committed: true,
          cleanupPending: false,
        };
      } catch (error: any) {
        const committedJournal = readReplacementJournal(journalPath);
        if (committedJournal?.phase === 'committed') {
          // The replacement is authoritative once the committed journal is durable.
          // Do not roll it back after a post-commit error; Drive invalidation and
          // artifact cleanup must finish from the durable boundary.
          return {
            success: true,
            mode: 'direct',
            backupSchemaVersion,
            currentSchemaVersion: currentVersion,
            tablesRestored: getTables(getDatabase()).length,
            committed: true,
            cleanupPending: true,
          };
        }
        // A corrupt/incompatible same-version file must not strand the live
        // database. Restore the checkpointed safety copy before rethrowing.
        if (!recoveryCopyReady) throw error;
        try {
          closeDatabase();
          const recoveryRemoveFailures = removeDatabaseFiles(dbPath);
          if (recoveryRemoveFailures.length > 0) {
            throw new Error(
              `Could not remove database files during recovery: ${recoveryRemoveFailures.join(', ')}`,
            );
          }
          fs.copyFileSync(recoveryPath, dbPath);
          syncFile(dbPath);
          if (!syncDirectory(path.dirname(dbPath)) && process.platform !== 'win32') {
            throw new Error('Could not durably recover direct-restore database');
          }
          initDatabase(false, true);
          recoveryCompleted = true;
        } catch (recoveryError: any) {
          throw new Error(
            `Direct restore failed: ${error?.message || 'unknown error'}; ` +
              `live database recovery failed: ${recoveryError?.message || 'unknown error'}`,
            { cause: recoveryError },
          );
        }
        throw error;
      } finally {
        if (recoveryCompleted) {
          removeReplacementArtifactsDurably(journalPath, recoveryPath);
        } else if (
          recoveryCopyReady &&
          isHealthyDatabaseFile(dbPath, baselineForeignKeyViolations, false) &&
          isHealthyDatabaseFile(recoveryPath, baselineForeignKeyViolations, false)
        ) {
          // A committed journal is finalized here; an uncommitted journal is
          // intentionally retained if recovery itself failed.
          try {
            const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as ReplacementJournal;
            if (journal.phase === 'committed' && journal.driveInvalidationRequired !== true)
              removeReplacementArtifactsDurably(journalPath, recoveryPath);
          } catch {}
        }
      }
    }

    console.log('[DB] restoreBackup: Data-only restore (schema version mismatch)');
    return dataOnlyRestore(
      backupPath,
      backupSchemaVersion,
      currentVersion,
      preservedRevocations,
      preservedUserSecurity,
      preservedUserStations,
      preservedStationSecurity,
      preservedKdsEnabled,
      preservedProtectedSettings,
      preservedOutboxes,
      signal,
    );
  } finally {
    stagedSource?.cleanup();
  }
}

/** Return stable keys for existing FK violations so legacy dirty data can be preserved without accepting new damage. */
export function getForeignKeyViolationKeys(dbInstance: Database.Database): Set<string> {
  const rows = dbInstance.prepare('PRAGMA foreign_key_check').all() as {
    table: string;
    rowid: number | string | null;
    parent: string;
    fkid: number;
  }[];
  const keys = new Set<string>();
  for (const row of rows) {
    let identity: unknown = row.rowid;
    try {
      const tableInfo = dbInstance
        .prepare(`PRAGMA table_info("${row.table.replace(/"/g, '""')}")`)
        .all() as { name: string; pk: number }[];
      const primaryKeys = tableInfo.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
      const columns = primaryKeys.map((column) => `"${column.name.replace(/"/g, '""')}"`);
      const foreignKey = (
        dbInstance.prepare(`PRAGMA foreign_key_list("${row.table.replace(/"/g, '""')}")`).all() as {
          id: number;
          from: string;
        }[]
      )
        .filter((entry) => entry.id === row.fkid)
        .map((entry) => entry.from);
      const selectedColumns = [
        ...new Set([...columns, ...foreignKey.map((column) => `"${column.replace(/"/g, '""')}"`)]),
      ];
      if (selectedColumns.length > 0 && row.rowid != null) {
        const values = dbInstance
          .prepare(
            `SELECT ${selectedColumns.join(', ')} FROM "${row.table.replace(/"/g, '""')}" WHERE rowid = ?`,
          )
          .get(row.rowid) as Record<string, unknown> | undefined;
        if (values)
          identity = {
            primary: primaryKeys.map((column) => values[column.name]),
            foreign: foreignKey.map((column) => values[column]),
          };
      }
    } catch {}
    keys.add(JSON.stringify([row.table, identity, row.parent, row.fkid]));
  }
  return keys;
}

/** Return true only if the string is a safe SQL identifier (letters, digits, underscore). */
export function isSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function materializeRestoreSource(
  sourcePath: string,
  livePath: string,
): { snapshotPath: string; cleanup: () => void } {
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile())
    throw new Error('Restore source must be a regular file');
  if (pathEntryExists(`${sourcePath}-wal`) || pathEntryExists(`${sourcePath}-shm`))
    throw new Error('Restore source must not have SQLite sidecars');
  if (
    [livePath, `${livePath}-wal`, `${livePath}-shm`].some((liveTarget) =>
      isLiveDatabaseTarget(sourcePath, liveTarget),
    )
  ) {
    throw new Error('Restore source cannot be the live database or its SQLite sidecars');
  }
  const sourceFd = fs.openSync(
    sourcePath,
    fs.constants.O_RDONLY | ((fs.constants as any).O_NOFOLLOW || 0),
  );
  let snapshotDir: string | null = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned || !snapshotDir) return;
    cleaned = true;
    try {
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    } catch {}
  };
  try {
    const openedStat = fs.fstatSync(sourceFd);
    if (
      openedStat.dev !== sourceStat.dev ||
      openedStat.ino !== sourceStat.ino ||
      openedStat.size !== sourceStat.size
    ) {
      throw new Error('Restore source changed while it was being opened');
    }
    const liveStat = fs.lstatSync(livePath);
    if (openedStat.dev === liveStat.dev && openedStat.ino === liveStat.ino)
      throw new Error('Restore source cannot be the live database');
    const sourceBytes = fs.readFileSync(sourceFd);
    const finalStat = fs.fstatSync(sourceFd);
    if (
      finalStat.dev !== openedStat.dev ||
      finalStat.ino !== openedStat.ino ||
      finalStat.size !== openedStat.size ||
      finalStat.mtimeMs !== openedStat.mtimeMs
    ) {
      throw new Error('Restore source changed while it was being read');
    }
    if (pathEntryExists(`${sourcePath}-wal`) || pathEntryExists(`${sourcePath}-shm`)) {
      throw new Error('Restore source acquired SQLite sidecars while it was being read');
    }
    snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-restore-source-'));
    const snapshotPath = path.join(snapshotDir, 'source.db');
    fs.writeFileSync(snapshotPath, sourceBytes, { flag: 'wx', mode: 0o600 });
    return { snapshotPath, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    try {
      fs.closeSync(sourceFd);
    } catch (closeError) {
      cleanup();
      throw closeError;
    }
  }
}

function dataOnlyRestore(
  backupPath: string,
  backupVersion: number,
  currentVersion: number,
  preservedRevocations: RevocationRow[] = [],
  preservedUserSecurity: UserSecurityState[] = [],
  preservedUserStations: UserStationSecurityState[] = [],
  preservedStationSecurity: KitchenStationSecurityState[] = [],
  preservedKdsEnabled: KdsEnabledSettingState = { present: false, value: null },
  preservedProtectedSettings: RestoreProtectedSettingState[] = [],
  preservedOutboxes: RestoreOutboxState = { cloud: [], support: [], diagnostics: [] },
  signal?: AbortSignal,
): RestoreResult {
  throwIfDatabaseMaintenanceAborted(signal);
  const livePath = getDbPath();
  if (
    [livePath, `${livePath}-wal`, `${livePath}-shm`].some((liveTarget) =>
      isLiveDatabaseTarget(backupPath, liveTarget),
    )
  ) {
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: 'Data-only restore source cannot be the live database or its SQLite sidecars',
    };
  }
  let backupDb: Database.Database | undefined;
  let backupTables: string[] = [];
  let backupProductRows: Record<string, unknown>[] = [];
  let backupMovementRows: Record<string, unknown>[] = [];
  const backupColumns = new Map<string, string[]>();
  try {
    backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    backupTables = getTables(backupDb);
    for (const tableName of backupTables) {
      if (isSafeIdentifier(tableName))
        backupColumns.set(tableName, getColumns(backupDb, tableName));
    }
    const inventoryValidationError = validateInventoryLedgerDatabase(backupDb);
    if (inventoryValidationError) {
      return {
        success: false,
        mode: 'data_only',
        backupSchemaVersion: backupVersion,
        currentSchemaVersion: currentVersion,
        tablesRestored: 0,
        error: inventoryValidationError,
      };
    }
    if (backupTables.includes('products')) {
      backupProductRows = backupDb
        .prepare('SELECT id, stock_quantity FROM products')
        .all() as Record<string, unknown>[];
    }
    if (backupTables.includes('inventory_movements')) {
      backupMovementRows = getInventoryMovementRows(backupDb);
    }
  } finally {
    backupDb?.close();
  }

  const currentDb = getDatabase();
  if (backupTables.includes('inventory_movements') && !backupTables.includes('products')) {
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: 'Data-only restore source cannot contain inventory movement history without products',
    };
  }
  if (backupTables.includes('products')) {
    const inventoryReplacementError = validateInventoryLedgerReplacement(
      currentDb.prepare('SELECT id, stock_quantity FROM products').all() as Record<
        string,
        unknown
      >[],
      backupTables.includes('inventory_movements') ? getInventoryMovementRows(currentDb) : [],
      backupProductRows,
      backupMovementRows,
    );
    if (inventoryReplacementError) {
      return {
        success: false,
        mode: 'data_only',
        backupSchemaVersion: backupVersion,
        currentSchemaVersion: currentVersion,
        tablesRestored: 0,
        error: inventoryReplacementError,
      };
    }
  }
  const baselineForeignKeyViolations = getForeignKeyViolationKeys(currentDb);
  const currentTables = getTables(currentDb);
  const commonTables = backupTables.filter((tableName) => currentTables.includes(tableName));
  const previousForeignKeys = Number(currentDb.pragma('foreign_keys', { simple: true })) === 1;
  let attached = false;
  let inTransaction = false;
  let tablesRestored = 0;
  let replacementJournal: DatabaseReplacementJournalHandle | null = null;
  let replacementCommitted = false;
  let replacementRecoveryFailed = false;

  // Existing failed versions of this function could strand this alias on the
  // long-lived connection. Remove it before attempting a fresh restore.
  try {
    const attachedDatabases = currentDb.prepare('PRAGMA database_list').all() as { name: string }[];
    if (attachedDatabases.some((entry) => entry.name === '_restore_src')) {
      currentDb.exec('DETACH DATABASE _restore_src');
    }
  } catch (error: any) {
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: `Could not clear a previous restore attachment: ${error?.message || 'unknown error'}`,
    };
  }

  try {
    currentDb.pragma('wal_checkpoint(TRUNCATE)');
    syncFile(livePath);
    replacementJournal = beginDatabaseReplacementJournal(livePath, 'restore');
  } catch (error: any) {
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: error?.message || 'Could not prepare restore recovery journal',
    };
  }

  try {
    throwIfDatabaseMaintenanceAborted(signal);
    // Disable FK checks before BEGIN so deleting parent rows does not cascade to child tables.
    currentDb.pragma('foreign_keys = OFF');
    const safeBackupPath = backupPath.replace(/'/g, "''");
    currentDb.exec(`ATTACH DATABASE '${safeBackupPath}' AS _restore_src`);
    attached = true;
    throwIfDatabaseMaintenanceAborted(signal);
    currentDb.exec('BEGIN IMMEDIATE');
    inTransaction = true;

    for (const tableName of commonTables) {
      throwIfDatabaseMaintenanceAborted(signal);
      if (!isSafeIdentifier(tableName)) {
        console.warn(`[DB] dataOnlyRestore: skipping unsafe table: ${JSON.stringify(tableName)}`);
        continue;
      }

      const currentColumns = getColumns(currentDb, tableName);
      const commonColumns = (backupColumns.get(tableName) || [])
        .filter((column) => currentColumns.includes(column))
        .filter((column) => {
          if (isSafeIdentifier(column)) return true;
          console.warn(
            `[DB] dataOnlyRestore: skipping unsafe column: ${JSON.stringify(column)} in ${tableName}`,
          );
          return false;
        });

      if (commonColumns.length === 0) continue;

      const columnList = commonColumns.join(', ');
      currentDb.exec(`DELETE FROM ${tableName}`);
      currentDb.exec(
        `INSERT INTO ${tableName} (${columnList}) SELECT ${columnList} FROM _restore_src.${tableName}`,
      );

      tablesRestored++;
      console.log(`[DB] Restored ${tableName}: ${commonColumns.length} columns`);
    }

    mergeUserSecurityState(currentDb, preservedUserSecurity);
    mergeUserStationSecurityState(
      currentDb,
      preservedUserStations,
      preservedUserSecurity.map((row) => row.id),
      preservedStationSecurity,
    );
    mergeKdsEnabledSetting(currentDb, preservedKdsEnabled);
    mergeRestoreProtectedSettings(currentDb, preservedProtectedSettings);
    clearGoogleDriveRestoreBinding(currentDb);
    currentDb.prepare('DELETE FROM kds_pairing_tokens').run();
    currentDb.prepare('DELETE FROM customer_display_tokens').run();
    mergeRestoreOutboxState(currentDb, preservedOutboxes);
    mergeRevocations(currentDb, preservedRevocations);
    executeSequenceRepair(currentDb);
    currentDb
      .prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('sequence_repair_completed_at', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(now(), now());
    currentDb
      .prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('sequence_repair_pending', '0', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(now());
    rebuildSearchIndex(currentDb);
    const inventoryValidationError = validateInventoryLedgerDatabase(currentDb);
    if (inventoryValidationError) {
      throw new Error(`Restore would violate the inventory ledger: ${inventoryValidationError}`);
    }
    const newForeignKeyViolations = [...getForeignKeyViolationKeys(currentDb)].filter(
      (key) => !baselineForeignKeyViolations.has(key),
    );
    if (newForeignKeyViolations.length > 0) {
      throw new Error(
        `Restore would introduce ${newForeignKeyViolations.length} new foreign-key violation(s)`,
      );
    }

    // Commit write transaction before detaching database.
    throwIfDatabaseMaintenanceAborted(signal);
    currentDb.exec('COMMIT');
    inTransaction = false;
    if (!replacementJournal) throw new Error('Restore recovery journal is unavailable');
    try {
      commitDatabaseReplacementJournal(replacementJournal);
    } catch (journalError) {
      try {
        recoverDatabaseReplacementJournal(replacementJournal);
      } catch (recoveryError: any) {
        replacementRecoveryFailed = true;
        throw new Error(
          `Restore journal commit failed: ${journalError instanceof Error ? journalError.message : 'unknown error'}; ` +
            `database recovery also failed: ${recoveryError?.message || 'unknown error'}`,
          { cause: recoveryError },
        );
      }
      throw journalError;
    }
    replacementCommitted = true;
    retainRestoreSafetyCopy(replacementJournal.recoveryPath, currentVersion);
    try {
      currentDb.exec('DETACH DATABASE _restore_src');
      attached = false;
    } catch (detachError: any) {
      // Reopen connection if detach fails to clean up attachments.
      try {
        closeDatabase();
        initDatabase(false, true);
        attached = false;
      } catch (recoveryError: any) {
        throw new Error(
          `Restore committed but source cleanup failed: ${detachError?.message || 'unknown error'}; ` +
            `database reopen also failed: ${recoveryError?.message || 'unknown error'}`,
        );
      }
    }

    return {
      success: true,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored,
      committed: true,
      cleanupPending: false,
    };
  } catch (error: any) {
    let cleanupFailure: unknown = null;
    if (inTransaction) {
      try {
        currentDb.exec('ROLLBACK');
      } catch (rollbackError) {
        cleanupFailure = rollbackError;
      }
      inTransaction = false;
    }
    if (attached) {
      try {
        currentDb.exec('DETACH DATABASE _restore_src');
        attached = false;
      } catch (detachError) {
        cleanupFailure = cleanupFailure || detachError;
      }
    }
    if (cleanupFailure) {
      try {
        closeDatabase();
        initDatabase(false, true);
        attached = false;
      } catch (recoveryError: any) {
        error = new Error(
          `${error?.message || 'Restore failed'}; cleanup failed: ${cleanupFailure instanceof Error ? cleanupFailure.message : 'unknown error'}; ` +
            `database reopen failed: ${recoveryError?.message || 'unknown error'}`,
        );
      }
    }
    const committedJournal =
      replacementJournal &&
      readReplacementJournal(replacementJournal.journalPath)?.phase === 'committed';
    if (replacementCommitted || committedJournal) {
      console.error('[DB] Data-only restore committed; cleanup remains pending:', error);
      return {
        success: true,
        mode: 'data_only',
        backupSchemaVersion: backupVersion,
        currentSchemaVersion: currentVersion,
        tablesRestored,
        committed: true,
        cleanupPending: true,
      };
    }
    if (!cleanupFailure && replacementJournal && !replacementRecoveryFailed) {
      try {
        abortDatabaseReplacementJournal(replacementJournal);
      } catch {}
    }
    throwIfDatabaseMaintenanceAborted(signal);
    console.error('[DB] dataOnlyRestore failed:', error);
    return {
      success: false,
      mode: 'data_only',
      backupSchemaVersion: backupVersion,
      currentSchemaVersion: currentVersion,
      tablesRestored: 0,
      error: error?.message || 'Restore failed',
    };
  } finally {
    if (attached) {
      try {
        currentDb.exec('DETACH DATABASE _restore_src');
      } catch {}
    }
    try {
      getDatabase().pragma(`foreign_keys = ${previousForeignKeys ? 'ON' : 'OFF'}`);
    } catch {}
  }
}
