import Database from 'better-sqlite3';
import { normalizeBusinessDayStartTime } from '../../shared/business-date';
import { getRawDatabase, now, type getDatabase } from '../db';

export function bumpSettingsRevision(): void {
  settingsRevision += 1;
}

// Read-through cache keyed to settingsRevision: every settings write bumps
// the revision, so a stale entry can never outlive the write that changed it.
// The database instance is part of the key so reopened/swapped databases
// never inherit values from a previous one.
let settingValueCacheDb: Database.Database | null = null;
let settingValueCacheRevision = -1;
const settingValueCache = new Map<string, string | null>();

export function getSettingValue(key: string): string | null {
  if (settingValueCacheDb !== getRawDatabase() || settingValueCacheRevision !== settingsRevision) {
    settingValueCache.clear();
    settingValueCacheDb = getRawDatabase();
    settingValueCacheRevision = settingsRevision;
  }
  if (settingValueCache.has(key)) return settingValueCache.get(key) ?? null;
  const row = getRawDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  const value = row?.value ?? null;
  settingValueCache.set(key, value);
  return value;
}

/** Resolves the tenant's configured business day start time, holding it to the
 *  `00:00`-`11:59` contract the settings endpoint enforces. */
export function tenantBusinessDayStartTime(customDb?: ReturnType<typeof getDatabase>): string {
  const raw = customDb
    ? (
        customDb
          .prepare("SELECT value FROM settings WHERE key = 'business_day_start_time'")
          .get() as { value?: unknown } | undefined
      )?.value
    : getSettingValue('business_day_start_time');
  return normalizeBusinessDayStartTime(typeof raw === 'string' ? raw : null);
}

let settingsRevision = 0;

export function getSettingsRevision(): number {
  return settingsRevision;
}

export function upsertSettings(entries: Record<string, string | undefined | null>): void {
  const stmt = getRawDatabase().prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  for (const [key, val] of Object.entries(entries)) {
    if (val !== undefined) stmt.run(key, val ?? '', now());
  }
  settingsRevision += 1;
}

export const GOOGLE_DRIVE_PRIVATE_SETTING_KEYS = [
  'google_drive_account_subject',
  'google_drive_account_email',
  'google_drive_destination_folder_id',
  'google_drive_destination_folder_name',
  'google_drive_folder_id',
  'google_drive_owned_destinations',
  'google_drive_last_backup_at',
  'google_drive_last_backup_status',
  'google_drive_last_automatic_backup_at',
  'google_drive_last_attempt_at',
  'google_drive_last_success_at',
  'google_drive_last_success_kind',
  'google_drive_next_retry_at',
  'google_drive_retention_status',
  'google_drive_retention_retry_count',
  'google_drive_last_error_code',
  'google_drive_pending_upload',
  'google_drive_job',
  'google_drive_revoke_status',
  'google_drive_revoke_cleanup_pending',
];

export function clearGoogleDriveRestoreBinding(
  dbInstance: Database.Database = getRawDatabase(),
): void {
  const placeholders = GOOGLE_DRIVE_PRIVATE_SETTING_KEYS.map(() => '?').join(', ');
  dbInstance
    .prepare(`DELETE FROM settings WHERE key IN (${placeholders})`)
    .run(...GOOGLE_DRIVE_PRIVATE_SETTING_KEYS);
  settingsRevision += 1;
}

export function upsertSetting(key: string, value: string): void {
  getRawDatabase()
    .prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `)
    .run(key, value, now());
  settingsRevision += 1;
}

export function insertSettingIfMissing(key: string, value: string): void {
  getRawDatabase()
    .prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, now());
  settingsRevision += 1;
}

export function registerSettingsRevisionTriggers(
  dbInstance: Database.Database = getRawDatabase(),
): void {
  try {
    dbInstance.function('flo_bump_settings_revision', () => {
      settingsRevision += 1;
      return 0;
    });
  } catch {
    // Function already registered or connection closed
  }
  const existingTables = new Set(
    (
      dbInstance
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('settings', 'users')",
        )
        .all() as { name: string }[]
    ).map((r) => r.name),
  );
  if (existingTables.has('settings')) {
    dbInstance.exec(`
      CREATE TEMP TRIGGER IF NOT EXISTS trg_settings_revision_ai AFTER INSERT ON main.settings BEGIN
        SELECT flo_bump_settings_revision();
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS trg_settings_revision_au AFTER UPDATE ON main.settings BEGIN
        SELECT flo_bump_settings_revision();
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS trg_settings_revision_ad AFTER DELETE ON main.settings BEGIN
        SELECT flo_bump_settings_revision();
      END;
    `);
  }
  if (existingTables.has('users')) {
    dbInstance.exec(`
      CREATE TEMP TRIGGER IF NOT EXISTS trg_users_revision_ai AFTER INSERT ON main.users BEGIN
        SELECT flo_bump_settings_revision();
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS trg_users_revision_au AFTER UPDATE ON main.users BEGIN
        SELECT flo_bump_settings_revision();
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS trg_users_revision_ad AFTER DELETE ON main.users BEGIN
        SELECT flo_bump_settings_revision();
      END;
    `);
  }
}

/** Anonymous telemetry toggle; enabled by default, reconfigurable in Settings > Privacy. */
export function isTelemetryEnabled(): boolean {
  return getSettingValue('telemetry_enabled') === 'true';
}

/** Tier 2 diagnostics consent toggle; separate from anonymous telemetry. */
export function isDiagnosticsConsentEnabled(): boolean {
  return getSettingValue('diagnostics_consent') !== 'false';
}

/** Automatic transmission is separate from capture and is disabled by either diagnostics consent gate. */
export function isDiagnosticsTransmissionEnabled(): boolean {
  return (
    isDiagnosticsConsentEnabled() && getSettingValue('diagnostics_transmission_enabled') === 'true'
  );
}

/** Kitchen Display System on/off switch. Defaults to enabled. */
export function isKdsEnabled(): boolean {
  return getSettingValue('kds_enabled') !== 'false';
}

/** Server App tableside ordering switch; defaults to enabled. */
export function isServerAppEnabled(): boolean {
  return getSettingValue('server_app_enabled') !== 'false';
}

/** KOT ticket printing on/off switch (gates automatic and manual prints). Defaults to enabled. */
export function isKotPrintingEnabled(): boolean {
  return getSettingValue('kot_printing_enabled') !== 'false';
}

/** Whether the tableside "server" role may print bills/order-slips. Defaults to disabled. */
export function isServerBillPrintingEnabled(): boolean {
  return getSettingValue('server_app_bill_printing_enabled') === 'true';
}

export function upsertTelemetryLastPing(): void {
  upsertSetting('telemetry_last_ping_at', now());
}
