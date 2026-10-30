import Database from 'better-sqlite3';
import * as path from 'path';
import { app } from 'electron';
import * as fs from 'fs';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { BUNDLED_COUNTRY_PACKS, bundledPackVersionId } from '../tax-packs/bundled';
import { serializeMerchantTemplatePayload, validateMerchantTemplateText } from '../../shared/print';
import { ROLE_KEYS } from '../../shared/role-permissions';
import {
  getBackupDir,
  getColumns,
  getForeignKeyViolationKeys,
  getTables,
  pathEntryExists,
  syncDirectory,
  syncFile,
} from './backup';
import { insertSettingIfMissing, upsertSetting } from './settings';
import {
  getCurrentSchemaVersion,
  getDbPath,
  getRawDatabase,
  insertOrderItemAddons,
  now,
  registerOrderSearchFunctions,
  setRawDatabase,
} from './core';

const USER_ROLE_SQL_CHECK = `CHECK (role IN (${ROLE_KEYS.map((role) => `'${role}'`).join(', ')}))`;

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

interface SchemaRecoveryReference {
  identity: string;
  tableColumns: Map<string, string[]>;
  definitions: Map<string, string>;
}

const cachedSchemaRecoveryReferences = new Map<number, SchemaRecoveryReference>();
let buildingIdealSchema = false;

let recoverySchemaBuildCount = 0;

export function getRecoverySchemaBuildCount(): number {
  return recoverySchemaBuildCount;
}

export function clearRecoverySchemaReference(): void {
  cachedSchemaRecoveryReferences.clear();
}

function getMigrationRegistryIdentity(targetVersion?: number): string {
  const supportedVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version || 0;
  const version = targetVersion !== undefined ? targetVersion : supportedVersion;
  const last = MIGRATIONS[MIGRATIONS.length - 1];
  return `${version}:${MIGRATIONS.length}:${last?.version ?? 0}:${last?.name ?? ''}`;
}

function getRecoverySchemaReference(targetVersion?: number): SchemaRecoveryReference {
  const supportedVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version || 0;
  const version = targetVersion !== undefined ? targetVersion : supportedVersion;
  const currentIdentity = getMigrationRegistryIdentity(version);
  const cached = cachedSchemaRecoveryReferences.get(version);
  if (cached && cached.identity === currentIdentity) {
    return cached;
  }
  recoverySchemaBuildCount += 1;
  const idealDb = buildIdealSchemaDb(version);
  try {
    const ref: SchemaRecoveryReference = {
      identity: currentIdentity,
      tableColumns: new Map(getTables(idealDb).map((table) => [table, getColumns(idealDb, table)])),
      definitions: normalizedSchemaDefinitions(idealDb),
    };
    cachedSchemaRecoveryReferences.set(version, ref);
    return ref;
  } finally {
    idealDb.close();
  }
}

function normalizedSchemaDefinitions(dbInstance: Database.Database): Map<string, string> {
  const definitions = dbInstance
    .prepare(`
    SELECT type, name, tbl_name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name <> '_flo_meta'
  `)
    .all() as { type: string; name: string; tbl_name: string; sql: string }[];
  return new Map(
    definitions.map((row) => [
      `${row.type}:${row.name}`,
      row.sql.replace(/\s+/g, ' ').trim().toLowerCase(),
    ]),
  );
}

export function isHealthyDatabaseFile(
  filePath: string,
  allowedForeignKeyViolations: Set<string> | null | undefined = undefined,
  requireMetadata = true,
): boolean {
  try {
    const candidate = new Database(filePath, { readonly: true, fileMustExist: true });
    const integrity =
      (candidate.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
        .integrity_check === 'ok';
    const foreignKeyViolations = getForeignKeyViolationKeys(candidate);
    const foreignKeysClean =
      allowedForeignKeyViolations === null ||
      (allowedForeignKeyViolations
        ? [...foreignKeyViolations].every((key) => allowedForeignKeyViolations.has(key))
        : foreignKeyViolations.size === 0);
    const schemaVersion = Number(candidate.pragma('user_version', { simple: true }));
    let metadata: { value: string } | undefined;
    try {
      metadata = candidate
        .prepare("SELECT value FROM _flo_meta WHERE key = 'schema_version'")
        .get() as { value: string } | undefined;
    } catch {}

    const supportedVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version || 0;
    if (schemaVersion < 1 || schemaVersion > supportedVersion) {
      candidate.close();
      return false;
    }

    const tables = new Set(getTables(candidate));
    const schemaRef = getRecoverySchemaReference(schemaVersion);
    const expectedSchema = schemaRef.tableColumns;
    const columnsValid = [...expectedSchema.entries()].every(([table, columns]) => {
      const available = new Set(getColumns(candidate, table));
      return columns.every((column) => available.has(column));
    });
    const actualDefinitions = normalizedSchemaDefinitions(candidate);
    const definitionsValid =
      schemaRef.definitions.size === actualDefinitions.size &&
      [...schemaRef.definitions].every(([key, sql]) => actualDefinitions.get(key) === sql);
    candidate.close();
    return (
      integrity &&
      foreignKeysClean &&
      schemaVersion > 0 &&
      schemaVersion <= supportedVersion &&
      (!requireMetadata || metadata?.value === String(schemaVersion)) &&
      tables.size === expectedSchema.size &&
      [...expectedSchema.keys()].every((table) => tables.has(table)) &&
      columnsValid &&
      definitionsValid
    );
  } catch {
    return false;
  }
}

/** Builds in-memory database using migration pipeline as ideal schema reference. */
export function buildIdealSchemaDb(targetVersion?: number): Database.Database {
  const idealDb = new Database(':memory:');
  registerOrderSearchFunctions(idealDb);
  idealDb.pragma('foreign_keys = OFF'); // Off during migrations
  const previousDb = setRawDatabase(idealDb);
  try {
    buildingIdealSchema = true;
    runMigrations(targetVersion);
  } finally {
    buildingIdealSchema = false;
    setRawDatabase(previousDb);
  }
  idealDb.pragma('foreign_keys = ON');
  return idealDb;
}

// ─── Migration registry ───────────────────────────────────────────────────────
// Entries run once in order within a transaction. Append new entries; do not edit existing entries.

export const MIGRATIONS: { version: number; name: string; up: () => void }[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: () => {
      createSchema();
      seedInstallDefaults();
    },
  },
  {
    version: 2,
    name: 'hash_plaintext_pins',
    up: () => {
      // Migrate from plaintext PINs to hashed PINs.
      const userColumns = getColumns(getRawDatabase(), 'users');
      if (!userColumns.includes('pin_hash')) {
        getRawDatabase().exec(`ALTER TABLE users ADD COLUMN pin_hash TEXT`);
      }

      if (!userColumns.includes('pin')) return;

      const usersWithPin = getRawDatabase()
        .prepare('SELECT id, pin FROM users WHERE pin IS NOT NULL')
        .all() as {
        id: string;
        pin: string;
      }[];
      for (const user of usersWithPin) {
        const pin = String(user.pin || '');
        if (!pin) continue;
        // Already a bcrypt hash?
        if (pin.startsWith('$2')) continue;
        getRawDatabase()
          .prepare('UPDATE users SET pin_hash = ?, pin = NULL WHERE id = ?')
          .run(bcrypt.hashSync(pin, 10), user.id);
      }
    },
  },
  {
    version: 3,
    name: 'cloud_identity_and_outbox',
    up: () => {
      createCloudSyncSchema();
      seedOfflineModeDefault();
    },
  },
  {
    version: 4,
    name: 'add_notes_limits_settings',
    up: () => {
      insertSettingIfMissing('max_order_notes_length', '200');
      insertSettingIfMissing('max_item_notes_length', '100');
    },
  },
  {
    version: 5,
    name: 'add_print_logs_table',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS print_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bill_id INTEGER NOT NULL,
          user_id TEXT NOT NULL,
          printed_at TEXT DEFAULT CURRENT_TIMESTAMP,
          print_type TEXT DEFAULT 'receipt',
          FOREIGN KEY (bill_id) REFERENCES bills(id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        )
      `);
    },
  },
  {
    version: 6,
    name: 'add_loyalty_settings',
    up: () => {
      insertSettingIfMissing('loyalty_enabled', 'true');
      insertSettingIfMissing('loyalty_points_per_currency', '1');
      insertSettingIfMissing('loyalty_redemption_rate', '100');
      insertSettingIfMissing('loyalty_max_balance_enabled', '0');
      insertSettingIfMissing('loyalty_max_balance_points', '10000');
      insertSettingIfMissing('loyalty_expiry_enabled', '0');
      insertSettingIfMissing('loyalty_expiry_months', '6');
      insertSettingIfMissing('loyalty_min_redemption', '100');
      insertSettingIfMissing('loyalty_max_redemption_percentage', '50');
    },
  },
  {
    version: 7,
    name: 'add_discount_settings',
    up: () => {
      insertSettingIfMissing('discount_mode', 'percentage');
      insertSettingIfMissing('discount_requires_approval', '0');
      insertSettingIfMissing('discount_max_percentage', '25');
      insertSettingIfMissing('discount_max_amount', '0');
    },
  },
  {
    version: 8,
    name: 'add_loyalty_index',
    up: () => {
      getRawDatabase().exec(
        'CREATE INDEX IF NOT EXISTS idx_loyalty_customer ON loyalty_ledger(customer_id, type)',
      );
    },
  },
  {
    version: 9,
    name: 'add_sequences_table',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS sequences (
          name TEXT PRIMARY KEY,
          date TEXT NOT NULL,
          current_value INTEGER NOT NULL DEFAULT 0
        )
      `);
    },
  },
  {
    version: 10,
    name: 'fix_sequences_composite_key',
    up: () => {
      // Recreate sequences table with (name, date) composite primary key.
      getRawDatabase().exec(`DROP TABLE IF EXISTS sequences`);
      getRawDatabase().exec(`
        CREATE TABLE sequences (
          name TEXT NOT NULL,
          date TEXT NOT NULL,
          current_value INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (name, date)
        )
      `);
      getRawDatabase()
        .prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES ('sequence_repair_pending', '1', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
        .run(now());
    },
  },
  {
    version: 11,
    name: 'first_run_setup_uses_welcome_form',
    up: () => {
      // Intentionally no-op. Fresh installs must remain uninitialized so the
      // local welcome form can create the first owner account.
    },
  },
  {
    version: 12,
    name: 'fix_table_integer_ids',
    up: () => {
      // Convert legacy integer table IDs to strings.
      getRawDatabase().exec(`UPDATE tables SET id = 'tbl-' || id WHERE typeof(id) = 'integer'`);
    },
  },
  {
    version: 13,
    name: 'fix_null_table_ids',
    up: () => {
      // Generate string IDs using rowid for existing tables with NULL ids.
      getRawDatabase().exec(`UPDATE tables SET id = 'tbl-' || rowid WHERE id IS NULL`);

      // Catch any integer ids that slipped through v12.
      getRawDatabase().exec(`UPDATE tables SET id = 'tbl-' || id WHERE typeof(id) = 'integer'`);
    },
  },
  {
    version: 14,
    name: 'simplify_loyalty_settings',
    up: () => {
      // Keep only loyalty_enabled and remove unused tuning settings.
      getRawDatabase().exec(`
        DELETE FROM settings WHERE key IN (
          'loyalty_points_per_currency',
          'loyalty_redemption_rate',
          'loyalty_max_balance_enabled',
          'loyalty_max_balance_points',
          'loyalty_expiry_enabled',
          'loyalty_expiry_months',
          'loyalty_min_redemption',
          'loyalty_max_redemption_percentage',
          'loyalty_expiry_days'
        )
      `);
      const customerCols = getRawDatabase().prepare(`PRAGMA table_info(customers)`).all() as {
        name: string;
      }[];
      if (customerCols.some((c) => c.name === 'loyalty_points')) {
        getRawDatabase().exec(`ALTER TABLE customers DROP COLUMN loyalty_points`);
      }
    },
  },
  {
    version: 15,
    name: 'add_instagram_handle_setting',
    up: () => {
      insertSettingIfMissing('instagram_handle', '');
    },
  },
  {
    version: 16,
    name: 'add_terms_accepted_at_to_users',
    up: () => {
      const userColumns = getColumns(getRawDatabase(), 'users');
      if (!userColumns.includes('terms_accepted_at')) {
        getRawDatabase().exec(`ALTER TABLE users ADD COLUMN terms_accepted_at TEXT`);
      }
    },
  },
  {
    version: 17,
    name: 'add_held_orders_table',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS held_orders (
          id TEXT PRIMARY KEY,
          table_id TEXT NOT NULL,
          items TEXT NOT NULL,
          customer_id TEXT,
          guest_count INTEGER DEFAULT 1,
          order_notes TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    },
  },
  {
    version: 18,
    name: 'fix_null_category_ids',
    up: () => {
      // Backfill missing category IDs using rowid.
      getRawDatabase().exec(`UPDATE categories SET id = 'cat-' || rowid WHERE id IS NULL`);
    },
  },
  {
    version: 19,
    name: 'backfill_product_cb_percent_and_tags',
    up: () => {
      // Ensure cb_percent and tags columns exist on pre-v8 installs.
      const productColumns = getColumns(getRawDatabase(), 'products');
      if (!productColumns.includes('cb_percent')) {
        getRawDatabase().exec(`ALTER TABLE products ADD COLUMN cb_percent REAL DEFAULT 0`);
      }
      if (!productColumns.includes('tags')) {
        getRawDatabase().exec(`ALTER TABLE products ADD COLUMN tags TEXT`);
      }
    },
  },
  {
    version: 20,
    name: 'add_tables_is_active',
    up: () => {
      // Add is_active column to support deactivating tables without deleting history.
      const tableColumns = getColumns(getRawDatabase(), 'tables');
      if (!tableColumns.includes('is_active')) {
        getRawDatabase().exec(`ALTER TABLE tables ADD COLUMN is_active INTEGER DEFAULT 1`);
      }
    },
  },
  {
    version: 21,
    name: 'clear_legacy_loyalty_expiry',
    up: () => {
      // Align legacy loyalty ledger rows with non-expiry policy.
      getRawDatabase().exec(
        `UPDATE loyalty_ledger SET expires_at = NULL WHERE expires_at IS NOT NULL`,
      );
    },
  },
  {
    version: 22,
    name: 'add_customers_phone_digits',
    up: () => {
      if (!getColumns(getRawDatabase(), 'customers').includes('phone_digits')) {
        getRawDatabase().exec(`
          ALTER TABLE customers ADD COLUMN phone_digits TEXT
            GENERATED ALWAYS AS (
              CASE WHEN phone IS NULL THEN NULL
                   ELSE REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(phone, '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')
              END
            ) VIRTUAL
        `);
      }
    },
  },
  {
    version: 23,
    name: 'normalize_customer_phones',
    up: () => {
      // Ensure country_code column exists before running normalization.
      if (!getColumns(getRawDatabase(), 'customers').includes('country_code')) {
        getRawDatabase().exec(`ALTER TABLE customers ADD COLUMN country_code TEXT DEFAULT '+91'`);
      }

      const tenantCountryRow = getRawDatabase()
        .prepare("SELECT value FROM settings WHERE key = 'country'")
        .get() as any;
      // Deliberate exception to "no India default" (docs/reference/product-invariants.md):
      // this is a one-time best-effort cleanup of pre-existing customer phone
      // records on an upgrading install, most of which predate multi-country
      // support and were Indian. Not a live store's regional identity.
      const tenantCountry = tenantCountryRow?.value || 'IN';

      const { parsePhoneE164 } = require('../lib/phone');

      const customers = getRawDatabase()
        .prepare(
          "SELECT id, phone, country_code FROM customers WHERE phone IS NOT NULL AND phone != ''",
        )
        .all() as any[];

      let normalized = 0,
        unparseable = 0;

      for (const c of customers) {
        const parsed = parsePhoneE164(c.phone, tenantCountry);
        if (parsed) {
          getRawDatabase()
            .prepare('UPDATE customers SET phone = ?, country_code = ? WHERE id = ?')
            .run(parsed.e164, parsed.countryCode, c.id);
          normalized++;
        } else {
          console.log(`[MIGRATION v23] unparseable: ${c.id} ${c.phone}`);
          unparseable++;
        }
      }
      console.log(`[MIGRATION v23] normalized: ${normalized}, unparseable: ${unparseable}`);

      const dupes = getRawDatabase()
        .prepare(`
        SELECT phone_digits, GROUP_CONCAT(id) as ids, COUNT(*) as cnt
        FROM customers
        WHERE phone_digits IS NOT NULL AND phone_digits != ''
        GROUP BY phone_digits
        HAVING cnt > 1
      `)
        .all() as any[];

      let merged = 0;

      for (const group of dupes) {
        const ids = group.ids.split(',').sort();
        const allRows = getRawDatabase()
          .prepare(
            `SELECT * FROM customers WHERE id IN (${ids.map(() => '?').join(',')})
           ORDER BY created_at ASC, id ASC`,
          )
          .all(...ids) as any[];

        const winner = allRows[0];
        const losers = allRows.slice(1);

        const coalesceFields = ['email', 'address', 'notes', 'country_code'];
        for (const loser of losers) {
          for (const field of coalesceFields) {
            if (!winner[field] && loser[field]) {
              winner[field] = loser[field];
            }
          }
        }

        getRawDatabase()
          .prepare(`
          UPDATE customers SET email = ?, address = ?, notes = ?, country_code = ?, updated_at = ?
          WHERE id = ?
        `)
          .run(winner.email, winner.address, winner.notes, winner.country_code, now(), winner.id);

        const fkTables = ['orders', 'bills', 'held_orders', 'loyalty_ledger'];
        for (const table of fkTables) {
          getRawDatabase()
            .prepare(
              `UPDATE ${table} SET customer_id = ? WHERE customer_id IN (${losers.map(() => '?').join(',')})`,
            )
            .run(winner.id, ...losers.map((l: any) => l.id));
        }

        const loserIds = losers.map((l: any) => l.id);
        getRawDatabase()
          .prepare(`DELETE FROM customers WHERE id IN (${loserIds.map(() => '?').join(',')})`)
          .run(...loserIds);

        console.log(
          `[MIGRATION v23] merged ${loserIds.join(',')} → ${winner.id} (phone: ${winner.phone})`,
        );
        merged += losers.length;
      }
      console.log(`[MIGRATION v23] merged ${merged} duplicate customer(s)`);

      getRawDatabase().exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_phone_digits_unique
        ON customers(phone_digits)
        WHERE phone_digits IS NOT NULL AND phone_digits != ''
      `);

      const total = getRawDatabase().prepare('SELECT COUNT(*) as cnt FROM customers').get() as {
        cnt: number;
      };
      const nonE164 = getRawDatabase()
        .prepare(
          "SELECT COUNT(*) as cnt FROM customers WHERE phone IS NOT NULL AND phone != '' AND phone NOT LIKE '+%'",
        )
        .get() as { cnt: number };
      console.log(
        `[MIGRATION v23] verification: ${total.cnt} customers, ${nonE164.cnt} still non-E.164`,
      );
      if (nonE164.cnt > 0) {
        console.warn(
          `[MIGRATION v23] WARNING: ${nonE164.cnt} customers have unparseable phones (preserved as raw)`,
        );
      }
    },
  },
  {
    version: 24,
    name: 'normalize_customer_phones_retry',
    up: () => {
      const tenantCountryRow = getRawDatabase()
        .prepare("SELECT value FROM settings WHERE key = 'country'")
        .get() as any;
      // Same deliberate exception as migration v23 above — historical
      // customer-data cleanup, not a live store's regional identity.
      const tenantCountry = tenantCountryRow?.value || 'IN';

      const { parsePhoneE164 } = require('../lib/phone');

      const customers = getRawDatabase()
        .prepare(
          "SELECT id, phone, country_code FROM customers WHERE phone IS NOT NULL AND phone != ''",
        )
        .all() as any[];

      let normalized = 0,
        unparseable = 0;

      for (const c of customers) {
        const parsed = parsePhoneE164(c.phone, tenantCountry);
        if (parsed && parsed.e164 !== c.phone) {
          getRawDatabase()
            .prepare('UPDATE customers SET phone = ?, country_code = ? WHERE id = ?')
            .run(parsed.e164, parsed.countryCode, c.id);
          normalized++;
        } else if (!parsed) {
          unparseable++;
        }
      }
      console.log(`[MIGRATION v24] normalized: ${normalized}, unparseable: ${unparseable}`);
    },
  },
  {
    version: 25,
    name: 'add_order_item_addons_table',
    up: () => {
      // Add a normalized table for selected order item add-ons and backfill existing rows.
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS order_item_addons (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_item_id INTEGER NOT NULL,
          addon_id TEXT,
          addon_name TEXT NOT NULL,
          price NUMERIC NOT NULL DEFAULT 0,
          quantity INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE CASCADE,
          FOREIGN KEY (addon_id) REFERENCES addons(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_order_item_addons_order_item_id ON order_item_addons(order_item_id);
        CREATE INDEX IF NOT EXISTS idx_order_item_addons_addon_id ON order_item_addons(addon_id);
      `);

      const rows = getRawDatabase()
        .prepare(
          `SELECT id, addons, created_at FROM order_items WHERE addons IS NOT NULL AND addons != '' AND addons != 'null'`,
        )
        .all() as { id: number; addons: string; created_at: string }[];

      let backfilled = 0,
        skipped = 0;
      for (const row of rows) {
        let parsed: any;
        try {
          parsed = JSON.parse(row.addons);
        } catch {
          skipped++;
          continue;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        insertOrderItemAddons(getRawDatabase(), row.id, parsed, row.created_at || now());
        backfilled++;
      }
      console.log(
        `[MIGRATION v25] backfilled addons for ${backfilled} order items (${skipped} unparseable, skipped)`,
      );
    },
  },
  {
    version: 26,
    name: 'add_kds_default_view',
    up: () => {
      getRawDatabase()
        .prepare(
          `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('kds_default_view', 'tabs', ?)`,
        )
        .run(now());
    },
  },
  {
    version: 27,
    name: 'add_station_printer_link_and_user_stations',
    up: () => {
      // Link kitchen stations to printer rows and assign staff logins to stations.
      const stationColumns = getColumns(getRawDatabase(), 'kitchen_stations');
      if (!stationColumns.includes('printer_id')) {
        getRawDatabase().exec(
          `ALTER TABLE kitchen_stations ADD COLUMN printer_id TEXT REFERENCES printers(id) ON DELETE SET NULL`,
        );
      }
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS station_users (
          user_id TEXT NOT NULL,
          station_id TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, station_id),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (station_id) REFERENCES kitchen_stations(id) ON DELETE CASCADE
        );
      `);
    },
  },
  {
    version: 28,
    name: 'seed_telemetry_settings',
    up: () => {
      // Seed default telemetry settings as disabled for pre-telemetry installs.
      const t = now();
      getRawDatabase()
        .prepare(
          `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('anonymous_data_consent', 'false', ?)`,
        )
        .run(t);
      getRawDatabase()
        .prepare(
          `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_enabled', 'false', ?)`,
        )
        .run(t);
      getRawDatabase()
        .prepare(
          `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_scope', 'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics', ?)`,
        )
        .run(t);
    },
  },
  {
    version: 29,
    name: 'whatsapp_messaging',
    up: () => {
      createWhatsAppSchema();
      seedWhatsAppDefaults();
    },
  },
  {
    version: 30,
    name: 'drop_order_items_addons_json_column',
    up: () => {
      // Backfill any remaining addons into order_item_addons and drop the legacy JSON column.
      const columns = getColumns(getRawDatabase(), 'order_items');
      if (!columns.includes('addons')) return; // already dropped (idempotent re-run)

      const rows = getRawDatabase()
        .prepare(`
        SELECT id, addons, created_at FROM order_items
        WHERE addons IS NOT NULL AND addons != '' AND addons != 'null'
          AND NOT EXISTS (SELECT 1 FROM order_item_addons WHERE order_item_id = order_items.id)
      `)
        .all() as { id: number; addons: string; created_at: string }[];

      let backfilled = 0;
      const unrecoverable: number[] = [];
      for (const row of rows) {
        let parsed: any;
        try {
          parsed = JSON.parse(row.addons);
        } catch {
          unrecoverable.push(row.id);
          continue;
        }
        if (!Array.isArray(parsed) || parsed.length === 0) continue;
        insertOrderItemAddons(getRawDatabase(), row.id, parsed, row.created_at || now());
        backfilled++;
      }
      console.log(
        `[MIGRATION v30] backfilled ${backfilled} order_item(s) still missing a normalized addons snapshot`,
      );

      if (unrecoverable.length > 0) {
        console.warn(
          `[MIGRATION v30] ${unrecoverable.length} order_item row(s) have unparseable legacy addons JSON (ids: ${unrecoverable.join(', ')}) and could not be migrated. Leaving the addons column in place so this data isn't lost — please review these rows manually.`,
        );
        return;
      }

      const remaining = (
        getRawDatabase()
          .prepare(`
        SELECT COUNT(*) as count FROM order_items
        WHERE addons IS NOT NULL AND addons != '' AND addons != 'null'
          AND NOT EXISTS (SELECT 1 FROM order_item_addons WHERE order_item_id = order_items.id)
      `)
          .get() as { count: number }
      ).count;

      if (remaining > 0) {
        console.warn(
          `[MIGRATION v30] ${remaining} order_item row(s) still lack a normalized addons snapshot after backfill — skipping the column drop this run.`,
        );
        return;
      }

      getRawDatabase().exec('ALTER TABLE order_items DROP COLUMN addons');
      console.log(
        '[MIGRATION v30] Dropped order_items.addons — order_item_addons is now the only place selected addons live.',
      );
    },
  },
  {
    version: 31,
    name: 'add_customers_tag_counts_column',
    up: () => {
      // Ensure customers.tag_counts exists on legacy installs.
      if (!getColumns(getRawDatabase(), 'customers').includes('tag_counts')) {
        getRawDatabase().exec(`ALTER TABLE customers ADD COLUMN tag_counts TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 32,
    name: 'add_kds_and_kot_printing_toggles',
    up: () => {
      // Add independent on/off settings for KDS and KOT printing (defaulting to true).
      insertSettingIfMissing('kds_enabled', 'true');
      insertSettingIfMissing('kot_printing_enabled', 'true');
    },
  },
  {
    version: 33,
    name: 'add_addon_groups_allow_multiple_quantities',
    up: () => {
      if (!getColumns(getRawDatabase(), 'addon_groups').includes('allow_multiple_quantities')) {
        getRawDatabase().exec(
          `ALTER TABLE addon_groups ADD COLUMN allow_multiple_quantities INTEGER DEFAULT 0`,
        );
      }
    },
  },
  {
    version: 34,
    name: 'add_order_items_voided_at',
    up: () => {
      // Timestamp anchor for showing voided kitchen items struck-through before removal.
      if (!getColumns(getRawDatabase(), 'order_items').includes('voided_at')) {
        getRawDatabase().exec(`ALTER TABLE order_items ADD COLUMN voided_at TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 35,
    name: 'add_tax_pack_configuration_tables',
    up: () => {
      createTaxPackSchema();
    },
  },
  {
    version: 36,
    name: 'add_product_and_addon_tax_categories',
    up: () => {
      const productColumns = getColumns(getRawDatabase(), 'products');
      if (!productColumns.includes('tax_category_id')) {
        getRawDatabase().exec(`ALTER TABLE products ADD COLUMN tax_category_id TEXT DEFAULT NULL`);
      }
      if (!productColumns.includes('tax_behavior')) {
        getRawDatabase().exec(
          `ALTER TABLE products ADD COLUMN tax_behavior TEXT DEFAULT 'country_default'`,
        );
      }

      const addonColumns = getColumns(getRawDatabase(), 'addons');
      if (!addonColumns.includes('tax_category_id')) {
        getRawDatabase().exec(`ALTER TABLE addons ADD COLUMN tax_category_id TEXT DEFAULT NULL`);
      }
      if (!addonColumns.includes('tax_behavior')) {
        getRawDatabase().exec(
          `ALTER TABLE addons ADD COLUMN tax_behavior TEXT DEFAULT 'country_default'`,
        );
      }
      if (!addonColumns.includes('inherit_parent_tax_category')) {
        getRawDatabase().exec(
          `ALTER TABLE addons ADD COLUMN inherit_parent_tax_category INTEGER DEFAULT 1`,
        );
      }
    },
  },
  {
    version: 37,
    name: 'add_transaction_tax_snapshots_and_charge_categories',
    up: () => {
      const orderColumns = getColumns(getRawDatabase(), 'orders');
      if (!orderColumns.includes('tax_snapshot')) {
        getRawDatabase().exec(`ALTER TABLE orders ADD COLUMN tax_snapshot TEXT DEFAULT NULL`);
      }
      if (!orderColumns.includes('packaging_tax_category_id')) {
        getRawDatabase().exec(
          `ALTER TABLE orders ADD COLUMN packaging_tax_category_id TEXT DEFAULT NULL`,
        );
      }
      if (!orderColumns.includes('delivery_tax_category_id')) {
        getRawDatabase().exec(
          `ALTER TABLE orders ADD COLUMN delivery_tax_category_id TEXT DEFAULT NULL`,
        );
      }
      if (!orderColumns.includes('service_charge_tax_category_id')) {
        getRawDatabase().exec(
          `ALTER TABLE orders ADD COLUMN service_charge_tax_category_id TEXT DEFAULT NULL`,
        );
      }

      if (!getColumns(getRawDatabase(), 'order_items').includes('tax_snapshot')) {
        getRawDatabase().exec(`ALTER TABLE order_items ADD COLUMN tax_snapshot TEXT DEFAULT NULL`);
      }
      if (!getColumns(getRawDatabase(), 'bills').includes('tax_snapshot')) {
        getRawDatabase().exec(`ALTER TABLE bills ADD COLUMN tax_snapshot TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 38,
    name: 'register_bundled_tax_pack_versions',
    up: () => {
      createTaxPackSchema();
      const insertPack = getRawDatabase().prepare(`
        INSERT INTO country_packs (
          id, publisher, country, jurisdiction, active_version_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          publisher = excluded.publisher,
          country = excluded.country,
          jurisdiction = excluded.jurisdiction,
          active_version_id = COALESCE(country_packs.active_version_id, excluded.active_version_id),
          updated_at = excluded.updated_at
      `);
      const insertVersion = getRawDatabase().prepare(`
        INSERT OR IGNORE INTO country_pack_versions (
          id, pack_id, version, schema_version, manifest_json, pack_json, digest, signature,
          effective_from, effective_to, min_flo_version, published_at, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 'active', ?)
      `);
      const insertCategory = getRawDatabase().prepare(`
        INSERT OR IGNORE INTO tax_categories (
          id, pack_version_id, category_id, label, default_behavior, definition_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const insertRule = getRawDatabase().prepare(`
        INSERT OR IGNORE INTO tax_rules (
          id, pack_version_id, rule_id, label, calculation_type, rate, amount,
          applies_per, base_rule_ids, definition_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const pack of BUNDLED_COUNTRY_PACKS) {
        const versionId = bundledPackVersionId(pack);
        const packJson = JSON.stringify(pack);
        const installedAt = now();
        const alreadyInstalled = getRawDatabase()
          .prepare('SELECT 1 FROM country_pack_versions WHERE id = ?')
          .get(versionId);

        insertPack.run(
          pack.id,
          pack.publisher,
          pack.country,
          pack.jurisdiction,
          versionId,
          installedAt,
          installedAt,
        );
        insertVersion.run(
          versionId,
          pack.id,
          pack.version,
          pack.schemaVersion,
          JSON.stringify({
            id: pack.id,
            publisher: pack.publisher,
            country: pack.country,
            jurisdiction: pack.jurisdiction,
            version: pack.version,
            publishedAt: pack.publishedAt,
          }),
          packJson,
          sha256Hex(packJson),
          pack.effectiveFrom,
          pack.effectiveTo || null,
          pack.minFloVersion,
          pack.publishedAt,
          installedAt,
        );

        for (const category of pack.categories) {
          insertCategory.run(
            `${versionId}:category:${category.id}`,
            versionId,
            category.id,
            category.label,
            category.defaultBehavior || null,
            JSON.stringify(category),
            installedAt,
          );
        }
        for (const rule of pack.rules) {
          insertRule.run(
            `${versionId}:rule:${rule.id}`,
            versionId,
            rule.id,
            rule.label,
            rule.type,
            rule.rate || null,
            rule.amount || null,
            rule.appliesPer || null,
            JSON.stringify(rule.baseRuleIds || []),
            JSON.stringify(rule),
            installedAt,
          );
        }

        if (!alreadyInstalled) {
          getRawDatabase()
            .prepare(`
            INSERT INTO tax_config_audit (
              action, pack_id, pack_version_id, details_json, created_at
            ) VALUES ('install_bundled_pack', ?, ?, ?, ?)
          `)
            .run(
              pack.id,
              versionId,
              JSON.stringify({ source: 'application_bundle', version: pack.version }),
              installedAt,
            );
        }
      }
    },
  },
  {
    version: 39,
    name: 'add_users_tokens_valid_after',
    up: () => {
      // Invalidate outstanding JWT sessions when user credentials change.
      if (!getColumns(getRawDatabase(), 'users').includes('tokens_valid_after')) {
        getRawDatabase().exec(`ALTER TABLE users ADD COLUMN tokens_valid_after TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 40,
    name: 'v2_cloud_defaults_and_tax_toggle',
    up: () => {
      // Seed-written timestamps use SQLite's format without T. An ISO
      // timestamp means the merchant explicitly changed the setting.
      getRawDatabase()
        .prepare(`
        UPDATE settings
           SET value = '1', updated_at = ?
         WHERE key = 'cloud_sync_enabled'
           AND value = '0'
           AND updated_at NOT LIKE '%T%'
      `)
        .run(now());
      getRawDatabase().prepare(`DELETE FROM settings WHERE key = 'cloud_pending_store_id'`).run();
      insertSettingIfMissing('taxes_enabled', 'false');
    },
  },
  {
    version: 41,
    name: 'support_ticket_outbox',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS support_ticket_outbox (
          client_ticket_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
          support_code TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_support_ticket_outbox_retry
          ON support_ticket_outbox(status, next_attempt_at, created_at);
      `);
    },
  },
  {
    version: 42,
    name: 'add_global_cashback_percent',
    up: () => {
      insertSettingIfMissing('global_cashback_percent', '0');
      // Existing product cb_percent values are preserved; null inherits global rate.
    },
  },
  {
    version: 43,
    name: 'telemetry_default_on_for_new_installs',
    up: () => {
      // Seed default telemetry settings as enabled for newly installed systems.
      const t = now();
      getRawDatabase()
        .prepare(
          `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_enabled', 'false', ?)`,
        )
        .run(t);
      getRawDatabase()
        .prepare(
          `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('anonymous_data_consent', 'true', ?)`,
        )
        .run(t);
      getRawDatabase()
        .prepare(
          `INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('telemetry_scope', 'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics', ?)`,
        )
        .run(t);
    },
  },
  {
    version: 44,
    name: 'store_diagnostics_outbox',
    up: () => {
      // Seed diagnostics consent setting.
      insertSettingIfMissing('diagnostics_consent', 'false');
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS store_diagnostics_outbox (
          event_id TEXT PRIMARY KEY,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          delivered_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_store_diagnostics_outbox_retry
          ON store_diagnostics_outbox(status, next_attempt_at, created_at);
      `);
    },
  },
  {
    // Performance indexes for large order volumes and timestamp normalization (ISO to SQLite format).
    version: 45,
    name: 'add_performance_indexes_and_normalize_timestamps',
    up: () => {
      getRawDatabase().exec(`
        CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
        CREATE INDEX IF NOT EXISTS idx_orders_table_id ON orders(table_id);
        CREATE INDEX IF NOT EXISTS idx_orders_type ON orders(type);
        CREATE INDEX IF NOT EXISTS idx_bills_created_at ON bills(created_at);
        CREATE INDEX IF NOT EXISTS idx_bills_paid_status_paid_at ON bills(payment_status, paid_at);
        CREATE INDEX IF NOT EXISTS idx_bills_customer_id ON bills(customer_id);
        CREATE INDEX IF NOT EXISTS idx_print_logs_bill_id ON print_logs(bill_id);
        CREATE INDEX IF NOT EXISTS idx_ledger_bill_id_type ON loyalty_ledger(bill_id, type);
        CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
        CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at);
        -- Index on paid_at to support range and null queries in payment breakdowns.
        CREATE INDEX IF NOT EXISTS idx_bills_paid_at ON bills(paid_at);
      `);
      const normalize: [string, string][] = [
        ['orders', 'created_at'],
        ['orders', 'updated_at'],
        ['orders', 'cooking_started_at'],
        ['orders', 'ready_at'],
        ['orders', 'served_at'],
        ['orders', 'completed_at'],
        ['orders', 'cancelled_at'],
        ['order_items', 'created_at'],
        ['order_items', 'updated_at'],
        ['order_items', 'voided_at'],
        ['bills', 'created_at'],
        ['bills', 'updated_at'],
        ['bills', 'paid_at'],
        ['bills', 'printed_at'],
        ['customers', 'created_at'],
        ['customers', 'updated_at'],
        ['users', 'created_at'],
        ['users', 'updated_at'],
        ['users', 'terms_accepted_at'],
        ['users', 'tokens_valid_after'],
        ['loyalty_ledger', 'created_at'],
        ['loyalty_ledger', 'updated_at'],
        ['loyalty_ledger', 'expires_at'],
        ['products', 'created_at'],
        ['products', 'updated_at'],
        ['addons', 'created_at'],
        ['addons', 'updated_at'],
        ['addon_groups', 'created_at'],
        ['addon_groups', 'updated_at'],
        ['tables', 'created_at'],
        ['tables', 'updated_at'],
        ['settings', 'updated_at'],
        ['print_logs', 'printed_at'],
        ['order_item_addons', 'created_at'],
        ['whatsapp_messages', 'queued_at'],
        ['whatsapp_messages', 'seen_at'],
        ['whatsapp_messages', 'typing_at'],
        ['whatsapp_messages', 'sent_at'],
        ['whatsapp_messages', 'delivered_at'],
        ['whatsapp_messages', 'read_at'],
        ['whatsapp_messages', 'failed_at'],
        ['whatsapp_blocklist', 'blocked_at'],
        ['held_orders', 'created_at'],
        ['held_orders', 'updated_at'],
        ['kds_pairing_tokens', 'expires_at'],
        ['kds_pairing_tokens', 'created_at'],
        // Outbox tables: normalize timestamp formats for retry ordering.
        ['cloud_sync_outbox', 'created_at'],
        ['cloud_sync_outbox', 'updated_at'],
        ['cloud_sync_outbox', 'next_attempt_at'],
        ['support_ticket_outbox', 'created_at'],
        ['support_ticket_outbox', 'updated_at'],
        ['support_ticket_outbox', 'next_attempt_at'],
        ['support_ticket_outbox', 'delivered_at'],
      ];
      for (const [table, column] of normalize) {
        if (!getColumns(getRawDatabase(), table).includes(column)) continue;
        // Strip ISO T delimiter to match standard SQLite timestamps.
        getRawDatabase()
          .prepare(
            `UPDATE ${table} SET ${column} = substr(REPLACE(${column}, 'T', ' '), 1, 19) WHERE ${column} LIKE '%T%'`,
          )
          .run();
      }
    },
  },
  {
    version: 46,
    name: 'normalize_cloud_enabled_flags_to_01',
    up: () => {
      // Normalize boolean string settings to '0' and '1' for cloud sync flags.
      const flags = [
        'cloud_sync_enabled',
        'cloud_orders_enabled',
        'cloud_reports_enabled',
        'cloud_command_polling_enabled',
      ];
      const toOne = getRawDatabase().prepare(
        `UPDATE settings SET value = '1' WHERE key = ? AND value = 'true'`,
      );
      const toZero = getRawDatabase().prepare(
        `UPDATE settings SET value = '0' WHERE key = ? AND value = 'false'`,
      );
      for (const key of flags) {
        toOne.run(key);
        toZero.run(key);
      }
    },
  },
  {
    version: 47,
    name: 'store_diagnostics_enabled_by_default',
    up: () => {
      // Preserve existing false setting; default missing rows to true.
      insertSettingIfMissing('diagnostics_consent', 'false');
    },
  },
  {
    version: 48,
    name: 'deactivate_reusable_demo_credentials',
    up: () => {
      // Deactivate bundled demo accounts if passwords were never changed.
      const changedAt = now();
      const demoUsers = getRawDatabase()
        .prepare(
          `SELECT id, password FROM users WHERE id IN ('user-demo-manager', 'user-demo-cashier', 'user-demo-chef')`,
        )
        .all() as { id: string; password: string }[];
      const deactivate = getRawDatabase().prepare(
        'UPDATE users SET is_active = 0, tokens_valid_after = ?, updated_at = ? WHERE id = ?',
      );
      for (const user of demoUsers) {
        try {
          if (bcrypt.compareSync('demo12345', user.password))
            deactivate.run(changedAt, changedAt, user.id);
        } catch {
          // Skip corrupt hashes without failing migration.
          console.warn(`[DB] Could not inspect demo credential for ${user.id}`);
        }
      }
    },
  },
  {
    version: 49,
    name: 'add_payment_idempotency_records',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS payment_idempotency (
          idempotency_key TEXT PRIMARY KEY,
          bill_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_payment_idempotency_bill ON payment_idempotency(bill_id);
        CREATE TABLE IF NOT EXISTS payment_transaction_refs (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (method, transaction_id)
        );
        CREATE INDEX IF NOT EXISTS idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
        CREATE TABLE IF NOT EXISTS payment_transaction_ref_conflicts (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          detected_at TEXT NOT NULL
        );
      `);
      const rows = getRawDatabase()
        .prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL')
        .all() as { id: string; payment_details: string }[];
      const insert = getRawDatabase().prepare(
        'INSERT OR IGNORE INTO payment_transaction_refs (method, transaction_id, bill_id, created_at) VALUES (?, ?, ?, ?)',
      );
      const conflictInsert = getRawDatabase().prepare(
        'INSERT INTO payment_transaction_ref_conflicts (method, transaction_id, bill_id, created_at, detected_at) VALUES (?, ?, ?, ?, ?)',
      );
      const seenRefs = new Map<string, { billId: string; createdAt: string }>();
      const detectedAt = now();
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payment_details);
          const payments = Array.isArray(parsed) ? parsed : [parsed];
          for (const payment of payments) {
            if (
              payment &&
              typeof payment.method === 'string' &&
              typeof payment.transaction_id === 'string' &&
              payment.transaction_id.trim() !== ''
            ) {
              const createdAt = payment.timestamp || detectedAt;
              const key = `${payment.method}\u0000${payment.transaction_id}`;
              const previous = seenRefs.get(key);
              if (previous && previous.billId !== row.id)
                conflictInsert.run(
                  payment.method,
                  payment.transaction_id,
                  row.id,
                  previous.createdAt,
                  detectedAt,
                );
              else seenRefs.set(key, { billId: row.id, createdAt });
              insert.run(payment.method, payment.transaction_id, row.id, createdAt);
            }
          }
        } catch {
          // Invalid legacy payment JSON is handled at settlement time; it must
          // not prevent idempotency tables from being created.
        }
      }
    },
  },
  {
    version: 50,
    name: 'add_order_idempotency_records',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS order_idempotency (
          idempotency_key TEXT PRIMARY KEY,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 51,
    name: 'enforce_global_payment_transaction_refs',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS payment_transaction_ref_conflicts (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          detected_at TEXT NOT NULL
        );
      `);
      const duplicateRows = getRawDatabase()
        .prepare(`
        SELECT method, transaction_id, bill_id, created_at
        FROM payment_transaction_refs
        WHERE transaction_id IN (
          SELECT transaction_id FROM payment_transaction_refs
          GROUP BY transaction_id HAVING COUNT(*) > 1
        )
      `)
        .all() as { method: string; transaction_id: string; bill_id: string; created_at: string }[];
      const recordConflict = getRawDatabase().prepare(`
        INSERT INTO payment_transaction_ref_conflicts (method, transaction_id, bill_id, created_at, detected_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const detectedAt = now();
      for (const row of duplicateRows)
        recordConflict.run(row.method, row.transaction_id, row.bill_id, row.created_at, detectedAt);
      getRawDatabase().exec(`
        CREATE TABLE payment_transaction_refs_global (
          transaction_id TEXT PRIMARY KEY,
          method TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      getRawDatabase().exec(`
        INSERT OR IGNORE INTO payment_transaction_refs_global (transaction_id, method, bill_id, created_at)
        SELECT transaction_id, method, bill_id, created_at
        FROM payment_transaction_refs
        ORDER BY created_at, bill_id;
        DROP TABLE payment_transaction_refs;
        ALTER TABLE payment_transaction_refs_global RENAME TO payment_transaction_refs;
        CREATE INDEX idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
      `);
    },
  },
  {
    version: 52,
    name: 'restore_method_scoped_transaction_refs',
    up: () => {
      // Rebuild method-scoped references and record duplicate conflicts.
      const recordConflict = getRawDatabase().prepare(`
        INSERT INTO payment_transaction_ref_conflicts (method, transaction_id, bill_id, created_at, detected_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const detectedAt = now();
      getRawDatabase().exec(`
        CREATE TABLE payment_transaction_refs_method (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (method, transaction_id)
        );
      `);
      const insertRef = getRawDatabase().prepare(`
        INSERT OR IGNORE INTO payment_transaction_refs_method
          (method, transaction_id, bill_id, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const findRef = getRawDatabase().prepare(
        'SELECT bill_id, created_at FROM payment_transaction_refs_method WHERE method = ? AND transaction_id = ?',
      );
      const addRef = (method: string, transactionId: string, billId: string, createdAt: string) => {
        const existing = findRef.get(method, transactionId) as
          | { bill_id: string; created_at: string }
          | undefined;
        if (existing && String(existing.bill_id) !== String(billId)) {
          recordConflict.run(method, transactionId, billId, createdAt, detectedAt);
          return;
        }
        insertRef.run(method, transactionId, billId, createdAt);
      };
      const existingRefs = getRawDatabase()
        .prepare('SELECT method, transaction_id, bill_id, created_at FROM payment_transaction_refs')
        .all() as { method: string; transaction_id: string; bill_id: string; created_at: string }[];
      for (const ref of existingRefs)
        addRef(ref.method, ref.transaction_id, ref.bill_id, ref.created_at);
      const rows = getRawDatabase()
        .prepare(
          'SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL ORDER BY id',
        )
        .all() as { id: string; payment_details: string }[];
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payment_details);
          const payments = Array.isArray(parsed) ? parsed : [parsed];
          for (const payment of payments) {
            if (
              !payment ||
              typeof payment.method !== 'string' ||
              typeof payment.transaction_id !== 'string' ||
              payment.transaction_id.trim() === ''
            )
              continue;
            addRef(
              payment.method,
              payment.transaction_id,
              String(row.id),
              payment.timestamp || detectedAt,
            );
          }
        } catch {
          // Invalid legacy JSON remains recoverable by the settlement path.
        }
      }
      getRawDatabase().exec(`
        DROP TABLE payment_transaction_refs;
        ALTER TABLE payment_transaction_refs_method RENAME TO payment_transaction_refs;
        CREATE INDEX idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
      `);
    },
  },
  {
    version: 53,
    name: 'scope_idempotency_records_to_user',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE payment_idempotency_scoped (
          user_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, idempotency_key)
        );
        CREATE TABLE order_idempotency_scoped (
          user_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, idempotency_key)
        );
      `);
      const paymentRows = getRawDatabase()
        .prepare(`
        SELECT p.idempotency_key, p.bill_id, p.request_hash, p.response_json, p.created_at,
               'legacy' AS user_id
        FROM payment_idempotency p
      `)
        .all() as {
        idempotency_key: string;
        bill_id: string;
        request_hash: string;
        response_json: string;
        created_at: string;
        user_id: string;
      }[];
      const insertPayment = getRawDatabase().prepare(`
        INSERT INTO payment_idempotency_scoped
          (user_id, idempotency_key, bill_id, request_hash, response_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const row of paymentRows)
        insertPayment.run(
          row.user_id || 'legacy',
          row.idempotency_key,
          row.bill_id,
          row.request_hash,
          row.response_json,
          row.created_at,
        );

      const orderRows = getRawDatabase()
        .prepare(
          'SELECT idempotency_key, request_hash, response_json, created_at FROM order_idempotency',
        )
        .all() as {
        idempotency_key: string;
        request_hash: string;
        response_json: string;
        created_at: string;
      }[];
      const insertOrder = getRawDatabase().prepare(`
        INSERT INTO order_idempotency_scoped
          (user_id, idempotency_key, request_hash, response_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of orderRows) {
        let userId = 'legacy';
        try {
          const response = JSON.parse(row.response_json);
          if (response?.order?.user_id != null) userId = String(response.order.user_id);
        } catch {
          // Keep the compatibility owner for malformed historical responses.
        }
        insertOrder.run(
          userId,
          row.idempotency_key,
          row.request_hash,
          row.response_json,
          row.created_at,
        );
      }
      getRawDatabase().exec(`
        DROP TABLE payment_idempotency;
        ALTER TABLE payment_idempotency_scoped RENAME TO payment_idempotency;
        CREATE INDEX idx_payment_idempotency_bill ON payment_idempotency(bill_id);
        DROP TABLE order_idempotency;
        ALTER TABLE order_idempotency_scoped RENAME TO order_idempotency;
      `);
    },
  },
  {
    version: 54,
    name: 'repair_retry_ownership_and_payment_reference_history',
    up: () => {
      // Backfill user ownership on legacy payment idempotency rows.
      const paymentRows = getRawDatabase()
        .prepare(`
        SELECT p.idempotency_key,
               CAST(o.user_id AS TEXT) AS user_id
        FROM payment_idempotency p
        JOIN bills b ON b.id = p.bill_id
        JOIN orders o ON o.id = b.order_id
        WHERE p.user_id = 'legacy' AND o.user_id IS NOT NULL
      `)
        .all() as { idempotency_key: string; user_id: string }[];
      const updatePayment = getRawDatabase().prepare(`
        UPDATE payment_idempotency SET user_id = ?
        WHERE user_id = 'legacy' AND idempotency_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM payment_idempotency existing
            WHERE existing.idempotency_key = payment_idempotency.idempotency_key
              AND existing.user_id != 'legacy'
          )
      `);
      for (const row of paymentRows) updatePayment.run(row.user_id, row.idempotency_key);

      const orderRows = getRawDatabase()
        .prepare(`
        SELECT idempotency_key, response_json
        FROM order_idempotency
        WHERE user_id = 'legacy'
      `)
        .all() as { idempotency_key: string; response_json: string }[];
      const updateOrder = getRawDatabase().prepare(`
        UPDATE order_idempotency SET user_id = ?
        WHERE user_id = 'legacy' AND idempotency_key = ?
          AND NOT EXISTS (
            SELECT 1 FROM order_idempotency existing
            WHERE existing.idempotency_key = order_idempotency.idempotency_key
              AND existing.user_id != 'legacy'
          )
      `);
      for (const row of orderRows) {
        try {
          const response = JSON.parse(row.response_json);
          if (response?.order?.user_id != null)
            updateOrder.run(String(response.order.user_id), row.idempotency_key);
        } catch {
          // Leave malformed historical responses under the compatibility owner.
        }
      }

      // Reconstruct method-scoped references from all bill records.
      const existingRefs = getRawDatabase()
        .prepare('SELECT method, transaction_id, bill_id, created_at FROM payment_transaction_refs')
        .all() as { method: string; transaction_id: string; bill_id: string; created_at: string }[];
      const rows = getRawDatabase()
        .prepare(
          'SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL ORDER BY id',
        )
        .all() as { id: string; payment_details: string }[];
      getRawDatabase().exec(`
        CREATE TABLE payment_transaction_refs_repaired (
          method TEXT NOT NULL,
          transaction_id TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (method, transaction_id)
        );
      `);
      const insertRef = getRawDatabase().prepare(`
        INSERT OR IGNORE INTO payment_transaction_refs_repaired
          (method, transaction_id, bill_id, created_at)
        VALUES (?, ?, ?, ?)
      `);
      const findRef = getRawDatabase().prepare(
        'SELECT bill_id FROM payment_transaction_refs_repaired WHERE method = ? AND transaction_id = ?',
      );
      const recordConflict = getRawDatabase().prepare(`
        INSERT INTO payment_transaction_ref_conflicts
          (method, transaction_id, bill_id, created_at, detected_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      const detectedAt = now();
      const addRef = (method: string, transactionId: string, billId: string, createdAt: string) => {
        const existing = findRef.get(method, transactionId) as { bill_id: string } | undefined;
        if (existing && String(existing.bill_id) !== String(billId)) {
          recordConflict.run(method, transactionId, billId, createdAt, detectedAt);
          return;
        }
        insertRef.run(method, transactionId, billId, createdAt);
      };
      for (const ref of existingRefs)
        addRef(ref.method, ref.transaction_id, ref.bill_id, ref.created_at);
      for (const row of rows) {
        try {
          const parsed = JSON.parse(row.payment_details);
          const payments = Array.isArray(parsed) ? parsed : [parsed];
          for (const payment of payments) {
            if (
              !payment ||
              typeof payment.method !== 'string' ||
              typeof payment.transaction_id !== 'string' ||
              payment.transaction_id.trim() === ''
            )
              continue;
            addRef(
              payment.method,
              payment.transaction_id,
              String(row.id),
              payment.timestamp || detectedAt,
            );
          }
        } catch {
          // Invalid legacy JSON remains recoverable by the settlement path.
        }
      }
      getRawDatabase().exec(`
        DROP TABLE payment_transaction_refs;
        ALTER TABLE payment_transaction_refs_repaired RENAME TO payment_transaction_refs;
        CREATE INDEX idx_payment_transaction_refs_bill ON payment_transaction_refs(bill_id);
      `);
    },
  },
  {
    version: 55,
    name: 'durable_token_revocations',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS revoked_tokens (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          revoked_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at
          ON revoked_tokens(expires_at);
      `);
    },
  },
  {
    version: 56,
    name: 'persist_station_assignment_scope',
    up: () => {
      if (!getColumns(getRawDatabase(), 'users').includes('station_assignments_configured')) {
        getRawDatabase().exec(
          `ALTER TABLE users ADD COLUMN station_assignments_configured INTEGER NOT NULL DEFAULT 0`,
        );
      }
      getRawDatabase().exec(
        `UPDATE users SET station_assignments_configured = 1 WHERE EXISTS (SELECT 1 FROM station_users WHERE station_users.user_id = users.id)`,
      );
    },
  },
  {
    version: 57,
    name: 'rename_gstin_to_generic_tax_registration_number',
    up: () => {
      // Copy tax identification number settings forward to generic keys.
      const copyIfPresent = (oldKey: string, newKey: string) => {
        const existing = getRawDatabase()
          .prepare('SELECT value FROM settings WHERE key = ?')
          .get(oldKey) as { value: string } | undefined;
        if (existing) {
          getRawDatabase()
            .prepare(
              'INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)',
            )
            .run(newKey, existing.value);
        }
      };
      copyIfPresent('gstin', 'tax_registration_number');
      copyIfPresent('bill_show_gstn', 'bill_show_tax_id');
    },
  },
  {
    version: 58,
    name: 'configurable_manual_payment_methods',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS payment_methods (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_payment_methods_active_sort ON payment_methods(is_active, sort_order, id);
        CREATE TABLE IF NOT EXISTS payment_method_merges (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          source_name TEXT NOT NULL,
          target_name TEXT NOT NULL,
          affected_payments INTEGER NOT NULL DEFAULT 0,
          merged_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Preserve UPI payment method for upgrading stores that have used it previously.
      const legacyUpi = getRawDatabase()
        .prepare(`
        SELECT 1 FROM bills b, json_each(CASE
          WHEN json_valid(b.payment_details) AND json_type(b.payment_details) = 'array' THEN b.payment_details
          WHEN json_valid(b.payment_details) THEN json_array(b.payment_details)
          ELSE '[]' END) je
        WHERE lower(json_extract(je.value, '$.method')) = 'upi' LIMIT 1
      `)
        .get();
      if (legacyUpi) {
        getRawDatabase()
          .prepare(
            `INSERT OR IGNORE INTO payment_methods (name, is_active, sort_order, created_at, updated_at) VALUES ('UPI', 1, 10, ?, ?)`,
          )
          .run(now(), now());
        const upiId = Number(
          (
            getRawDatabase()
              .prepare(`SELECT id FROM payment_methods WHERE name = 'UPI' COLLATE NOCASE`)
              .get() as { id: number }
          ).id,
        );
        const rows = getRawDatabase()
          .prepare('SELECT id, payment_details FROM bills WHERE payment_details IS NOT NULL')
          .all() as any[];
        const update = getRawDatabase().prepare(
          'UPDATE bills SET payment_details = ? WHERE id = ?',
        );
        for (const row of rows) {
          let parsed: any;
          try {
            parsed = JSON.parse(row.payment_details);
          } catch {
            continue;
          }
          const lines = Array.isArray(parsed) ? parsed : [parsed];
          let changed = false;
          for (const line of lines) {
            if (line && String(line.method || '').toLowerCase() === 'upi') {
              line.method = 'UPI';
              line.payment_method_id = upiId;
              changed = true;
            }
          }
          if (changed) update.run(JSON.stringify(Array.isArray(parsed) ? lines : lines[0]), row.id);
        }
      }
    },
  },
  {
    version: 59,
    name: 'split_checks_by_item_quantity',
    up: () => {
      if (!getColumns(getRawDatabase(), 'bills').includes('split_group_id'))
        getRawDatabase().exec('ALTER TABLE bills ADD COLUMN split_group_id TEXT');
      if (!getColumns(getRawDatabase(), 'bills').includes('split_label'))
        getRawDatabase().exec('ALTER TABLE bills ADD COLUMN split_label TEXT');
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS bill_items (
          bill_id INTEGER NOT NULL,
          order_item_id INTEGER NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          PRIMARY KEY (bill_id, order_item_id),
          FOREIGN KEY (bill_id) REFERENCES bills(id) ON DELETE CASCADE,
          FOREIGN KEY (order_item_id) REFERENCES order_items(id)
        );
        CREATE INDEX IF NOT EXISTS idx_bill_items_order_item ON bill_items(order_item_id);
        CREATE INDEX IF NOT EXISTS idx_bills_split_group ON bills(split_group_id);
      `);
    },
  },
  {
    version: 60,
    name: 'seed_split_checks_disabled_setting',
    up: () => {
      // Seed the split-checks setting for upgrading stores; v119 later made
      // the feature default-on, so the seed now inserts the current default.
      getRawDatabase()
        .prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('split_checks_enabled', 'true', ?)
      `)
        .run(now());
    },
  },
  {
    version: 61,
    name: 'seed_server_app_enabled_setting',
    up: () => {
      // Seed server app enabled setting for upgraded stores.
      getRawDatabase()
        .prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('server_app_enabled', 'true', ?)
      `)
        .run(now());
    },
  },
  {
    version: 62,
    name: 'normalize_cloud_last_error',
    up: () => {
      // Sanitize legacy cloud error text to prevent credential leaks.
      getRawDatabase()
        .prepare(`
        UPDATE settings
        SET value = 'Cloud service request failed', updated_at = ?
        WHERE key = 'cloud_last_error' AND value <> ''
      `)
        .run(now());
    },
  },
  {
    version: 63,
    name: 'seed_printer_trim_decimals_setting',
    up: () => {
      // Seed default printer decimal trimming setting as disabled.
      getRawDatabase()
        .prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES ('printer_trim_decimals', 'false', ?)
      `)
        .run(now());
    },
  },
  {
    version: 64,
    name: 'drop_unused_printer_usb_device_path',
    up: () => {
      if (getColumns(getRawDatabase(), 'printers').includes('usb_device_path')) {
        getRawDatabase().exec('ALTER TABLE printers DROP COLUMN usb_device_path');
      }
    },
  },
  {
    version: 65,
    name: 'seed_bill_content_visibility_settings',
    up: () => {
      const insert = getRawDatabase().prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
      `);
      const defaults = [
        ['bill_show_name', 'true'],
        ['bill_show_address', 'true'],
        ['bill_show_phone', 'true'],
        ['bill_show_tax_id', 'false'],
        ['bill_show_tax_breakdown', 'true'],
        ['bill_show_customer_name', 'true'],
        ['bill_show_customer_phone', 'true'],
        ['bill_show_table_number', 'true'],
      ];
      for (const [key, value] of defaults) insert.run(key, value, now());
    },
  },
  {
    version: 66,
    name: 'seed_bill_template_settings',
    up: () => {
      const insert = getRawDatabase().prepare(`
        INSERT OR IGNORE INTO settings (key, value, updated_at)
        VALUES (?, ?, ?)
      `);
      insert.run('bill_template', 'classic', now());
      insert.run('bill_footer_message', '', now());
    },
  },
  {
    version: 67,
    name: 'persist_order_item_inventory_deductions',
    up: () => {
      if (!getColumns(getRawDatabase(), 'order_items').includes('inventory_deducted_quantity')) {
        getRawDatabase().exec(
          `ALTER TABLE order_items ADD COLUMN inventory_deducted_quantity REAL NOT NULL DEFAULT 0`,
        );
      }
      getRawDatabase()
        .prepare(`
        UPDATE order_items
        SET inventory_deducted_quantity = quantity
        WHERE inventory_deducted_quantity = 0
          AND EXISTS (
            SELECT 1 FROM products
            WHERE products.id = order_items.product_id AND products.track_inventory = 1
          )
      `)
        .run();
    },
  },
  {
    version: 68,
    name: 'add_invoice_numbering_settings',
    up: () => {
      insertSettingIfMissing('invoice_number_prefix', 'INV');
      insertSettingIfMissing('invoice_number_include_period', 'true');
      insertSettingIfMissing('invoice_number_reset_period', 'daily');
      insertSettingIfMissing('invoice_financial_year_start_month', '4');
      insertSettingIfMissing('invoice_financial_year_start_day', '1');
    },
  },
  {
    version: 69,
    name: 'installed_plugin_print_templates',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS installed_print_templates (
          template_id TEXT PRIMARY KEY,
          pack_id TEXT NOT NULL,
          pack_version_id TEXT NOT NULL,
          country TEXT NOT NULL,
          jurisdiction TEXT NOT NULL,
          display_name TEXT NOT NULL,
          paper_widths_json TEXT NOT NULL,
          renderer_json TEXT NOT NULL,
          template_payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'installed',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_installed_print_templates_pack_version
          ON installed_print_templates(pack_version_id);
      `);
    },
  },
  {
    version: 70,
    name: 'rename_waiter_role_to_server',
    up: () => {
      getRawDatabase().exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE users_role_server_migration (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT UNIQUE,
          password TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'cashier'
            ${USER_ROLE_SQL_CHECK},
          pin TEXT,
          pin_hash TEXT,
          category_ids TEXT,
          is_active INTEGER DEFAULT 1,
          terms_accepted_at TEXT,
          tokens_valid_after TEXT DEFAULT NULL,
          station_assignments_configured INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO users_role_server_migration (
          id, name, email, password, role, pin, pin_hash, category_ids, is_active,
          terms_accepted_at, tokens_valid_after, station_assignments_configured,
          created_at, updated_at
        )
        SELECT
          id, name, email, password,
          CASE WHEN role = 'waiter' THEN 'server' ELSE role END,
          pin, pin_hash, category_ids, is_active,
          terms_accepted_at, tokens_valid_after, station_assignments_configured,
          created_at, updated_at
        FROM users;
        DROP TABLE users;
        ALTER TABLE users_role_server_migration RENAME TO users;
        PRAGMA foreign_keys = ON;
      `);
    },
  },
  {
    version: 71,
    name: 'repair_durable_token_revocations',
    up: () => {
      // Re-create revoked_tokens table idempotently to fix version collision from v55.
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS revoked_tokens (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          revoked_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires_at
          ON revoked_tokens(expires_at);
      `);
    },
  },
  {
    version: 72,
    name: 'merchant_print_templates',
    up: () => {
      // Add tenant-owned editable receipt templates table.
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS merchant_print_templates (
          id TEXT PRIMARY KEY,
          business_id TEXT NOT NULL DEFAULT 'local',
          name TEXT NOT NULL,
          origin TEXT NOT NULL DEFAULT 'created' CHECK (origin IN ('created', 'imported', 'cloned')),
          derived_from TEXT,
          document_type TEXT NOT NULL DEFAULT 'receipt' CHECK (document_type IN ('receipt')),
          schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
          previous_payload_json TEXT,
          checksum TEXT NOT NULL DEFAULT '',
          created_by TEXT,
          updated_by TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_merchant_print_templates_business_status
          ON merchant_print_templates(business_id, status);
      `);

      // Migrate bill_template string setting to structured JSON identity format.
      const current = getRawDatabase()
        .prepare("SELECT value FROM settings WHERE key = 'bill_template'")
        .get() as { value: string } | undefined;
      const rawValue = typeof current?.value === 'string' ? current.value.trim() : '';
      if (rawValue.length > 0 && !(rawValue.startsWith('{') && rawValue.endsWith('}'))) {
        let upgraded: string | null = null;
        if (['classic', 'compact'].includes(rawValue.toLowerCase())) {
          upgraded = JSON.stringify({ source: 'core', id: rawValue.toLowerCase() });
        } else if (
          getRawDatabase()
            .prepare('SELECT 1 FROM installed_print_templates WHERE template_id = ?')
            .get(rawValue)
        ) {
          upgraded = JSON.stringify({ source: 'pack', id: rawValue });
        }
        if (upgraded) {
          getRawDatabase()
            .prepare(`
            INSERT INTO settings (key, value, updated_at) VALUES ('bill_template', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
          `)
            .run(upgraded, now());
        }
      }
    },
  },
  {
    version: 73,
    name: 'normalize_merchant_template_payloads',
    up: () => {
      // Normalize merchant template payloads to canonical serialization and update checksums.
      const rows = getRawDatabase()
        .prepare(`
        SELECT id, payload_json, previous_payload_json, checksum
        FROM merchant_print_templates
      `)
        .all() as {
        id: string;
        payload_json: string;
        previous_payload_json: string | null;
        checksum: string;
      }[];
      let normalized = 0;
      for (const row of rows) {
        if (
          crypto.createHash('sha256').update(row.payload_json, 'utf8').digest('hex') !==
          row.checksum
        )
          continue;
        const validation = validateMerchantTemplateText(row.payload_json);
        if (!validation.ok) continue;
        const payloadJson = serializeMerchantTemplatePayload(validation.payload);
        let previousPayloadJson = row.previous_payload_json;
        if (previousPayloadJson !== null) {
          const previousValidation = validateMerchantTemplateText(previousPayloadJson);
          if (previousValidation.ok) {
            previousPayloadJson = serializeMerchantTemplatePayload(previousValidation.payload);
          }
        }
        if (payloadJson === row.payload_json && previousPayloadJson === row.previous_payload_json)
          continue;
        getRawDatabase()
          .prepare(`
          UPDATE merchant_print_templates
          SET payload_json = ?, previous_payload_json = ?, checksum = ?
          WHERE id = ?
        `)
          .run(
            payloadJson,
            previousPayloadJson,
            crypto.createHash('sha256').update(payloadJson, 'utf8').digest('hex'),
            row.id,
          );
        normalized++;
      }
      console.log(
        `[MIGRATION v73] normalized ${normalized} merchant template payload(s); ${rows.length - normalized} already canonical or left untouched`,
      );
    },
  },
  {
    version: 74,
    name: 'add_country_packs_disclaimer_ack',
    up: () => {
      // Support community tax pack disclaimer acknowledgement columns.
      const columns = getColumns(getRawDatabase(), 'country_packs');
      if (!columns.includes('disclaimer_acknowledged_at')) {
        getRawDatabase().exec(
          `ALTER TABLE country_packs ADD COLUMN disclaimer_acknowledged_at TEXT`,
        );
      }
      if (!columns.includes('disclaimer_acknowledged_by')) {
        getRawDatabase().exec(
          `ALTER TABLE country_packs ADD COLUMN disclaimer_acknowledged_by TEXT`,
        );
      }
    },
  },
  {
    version: 75,
    name: 'add_printer_cash_drawer_pulse',
    up: () => {
      if (!getColumns(getRawDatabase(), 'printers').includes('cash_drawer_pulse_enabled')) {
        getRawDatabase().exec(
          `ALTER TABLE printers ADD COLUMN cash_drawer_pulse_enabled INTEGER NOT NULL DEFAULT 0`,
        );
      }
    },
  },
  {
    version: 76,
    name: 'add_refunds_and_refund_idempotency',
    up: () => {
      // Add refunds and refund_idempotency tables.
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS refunds (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bill_id INTEGER NOT NULL REFERENCES bills(id),
          order_item_id INTEGER REFERENCES order_items(id),
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
          method TEXT NOT NULL,
          reason TEXT,
          shift_id TEXT,
          approved_by TEXT NOT NULL REFERENCES users(id),
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_refunds_bill ON refunds(bill_id);
        CREATE INDEX IF NOT EXISTS idx_refunds_order_item ON refunds(order_item_id);

        -- Final user-scoped refund idempotency table.
        CREATE TABLE IF NOT EXISTS refund_idempotency (
          user_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          bill_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (user_id, idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_refund_idempotency_bill ON refund_idempotency(bill_id);
      `);
    },
  },
  {
    version: 77,
    name: 'add_weighted_product_metadata',
    up: () => {
      const columns = getRawDatabase().prepare(`PRAGMA table_info(products)`).all() as Array<{
        name: string;
      }>;
      const hasColumn = (name: string) => columns.some((column) => column.name === name);
      if (!hasColumn('sale_unit')) {
        getRawDatabase().exec(
          `ALTER TABLE products ADD COLUMN sale_unit TEXT NOT NULL DEFAULT 'each' CHECK (sale_unit IN ('each', 'kg', 'g', 'lb'))`,
        );
      }
      if (!hasColumn('allow_fractional_quantity')) {
        getRawDatabase().exec(
          `ALTER TABLE products ADD COLUMN allow_fractional_quantity INTEGER NOT NULL DEFAULT 0`,
        );
      }
      if (!hasColumn('weight_precision')) {
        getRawDatabase().exec(
          `ALTER TABLE products ADD COLUMN weight_precision INTEGER NOT NULL DEFAULT 3 CHECK (weight_precision BETWEEN 0 AND 4)`,
        );
      }
    },
  },
  {
    version: 78,
    name: 'add_online_order_reference',
    up: () => {
      // Add online aggregator platform and external order ID columns.
      const orderColumns = getColumns(getRawDatabase(), 'orders');
      if (!orderColumns.includes('online_platform')) {
        getRawDatabase().exec(`ALTER TABLE orders ADD COLUMN online_platform TEXT DEFAULT NULL`);
      }
      if (!orderColumns.includes('external_order_id')) {
        getRawDatabase().exec(`ALTER TABLE orders ADD COLUMN external_order_id TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 79,
    name: 'add_service_charge_amounts',
    up: () => {
      const orderColumns = getColumns(getRawDatabase(), 'orders');
      if (!orderColumns.includes('service_charge')) {
        getRawDatabase().exec(`ALTER TABLE orders ADD COLUMN service_charge REAL DEFAULT 0`);
      }
      const billColumns = getColumns(getRawDatabase(), 'bills');
      if (!billColumns.includes('service_charge')) {
        getRawDatabase().exec(`ALTER TABLE bills ADD COLUMN service_charge REAL DEFAULT 0`);
      }
    },
  },
  {
    version: 80,
    name: 'migrate_cash_drawer_pulse_to_global_setting',
    up: () => {
      // Migrate per-printer cash drawer pulse flag to global setting.
      const columns = getColumns(getRawDatabase(), 'printers');
      if (!columns.includes('cash_drawer_pulse_enabled')) return;
      // Mirror default receipt printer selection when migrating setting.
      const receiptPrinter = getRawDatabase()
        .prepare(`
        SELECT cash_drawer_pulse_enabled FROM printers
        WHERE connection_type != 'webusb'
        ORDER BY is_default DESC, name
        LIMIT 1
      `)
        .get() as { cash_drawer_pulse_enabled?: number } | undefined;
      if (receiptPrinter?.cash_drawer_pulse_enabled === 1) {
        getRawDatabase()
          .prepare(`
          INSERT OR IGNORE INTO settings (key, value, updated_at)
          VALUES ('cash_drawer_pulse_enabled', 'true', ?)
        `)
          .run(now());
      }
    },
  },
  {
    version: 81,
    name: 'add_cash_closures',
    up: () => {
      // Cierre de caja (day close, #649). All money columns are INTEGER
      // minor units to match the codebase convention (`refunds.amount_cents`);
      // display conversion happens at the API boundary.
      //
      // Extension door: the day-close invariant ("one close per
      // business_date") lives in the partial index below, not on the
      // column, so future `scope='session'` rows for the same date do not
      // collide. The `period_start/period_end` window also serves a future
      // sessions feature without schema change.
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS cash_closures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL DEFAULT 'day' CHECK (scope IN ('day', 'session')),
          business_date TEXT NOT NULL CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          opening_float_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),
          expected_cash_cents INTEGER NOT NULL,
          counted_cash_cents INTEGER NOT NULL CHECK (counted_cash_cents >= 0),
          variance_cents INTEGER NOT NULL,
          gross_collected_cents INTEGER NOT NULL,
          refunded_cents INTEGER NOT NULL,
          net_collected_cents INTEGER NOT NULL,
          bill_count INTEGER NOT NULL,
          refund_count INTEGER NOT NULL,
          payment_methods_json TEXT NOT NULL DEFAULT '[]',
          staff_sales_json TEXT NOT NULL DEFAULT '[]',
          tax_components_json TEXT NOT NULL DEFAULT '[]',
          z_number INTEGER UNIQUE NOT NULL,
          closed_by TEXT NOT NULL REFERENCES users(id),
          notes TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS cash_closures_one_day
          ON cash_closures(business_date) WHERE scope = 'day';
      `);
    },
  },
  {
    version: 82,
    name: 'add_order_audit_log',
    up: () => {
      // Append-only actor log for order/item mutations (docs/reference/product-invariants.md).
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS order_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id INTEGER NOT NULL REFERENCES orders(id),
          order_item_id INTEGER REFERENCES order_items(id),
          actor_user_id TEXT NOT NULL REFERENCES users(id),
          action TEXT NOT NULL,
          details_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_order_audit_log_order ON order_audit_log(order_id);
        CREATE INDEX IF NOT EXISTS idx_order_audit_log_actor ON order_audit_log(actor_user_id);
      `);
    },
  },
  {
    version: 83,
    name: 'add_server_app_bill_printing_toggle',
    up: () => {
      // Owner opt-in for tableside servers to print bills; defaults off (print-bill stays payment-adjacent).
      insertSettingIfMissing('server_app_bill_printing_enabled', 'false');
    },
  },
  {
    version: 84,
    name: 'add_cash_drawer_movements',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS cash_drawer_movements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          business_date TEXT NOT NULL CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          movement_type TEXT NOT NULL CHECK (movement_type IN ('opening_float', 'pay_in', 'pay_out', 'safe_drop')),
          amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
          reason TEXT,
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          voided_at TEXT,
          voided_by TEXT REFERENCES users(id),
          void_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cash_drawer_movements_date
          ON cash_drawer_movements(business_date, created_at);
        CREATE UNIQUE INDEX IF NOT EXISTS cash_drawer_one_opening_float
          ON cash_drawer_movements(business_date)
          WHERE movement_type = 'opening_float' AND voided_at IS NULL;
      `);
      const columns = new Set(
        (
          getRawDatabase().prepare(`PRAGMA table_info(cash_closures)`).all() as { name: string }[]
        ).map((column) => column.name),
      );
      const addColumn = (name: string, definition: string) => {
        if (!columns.has(name)) {
          getRawDatabase().exec(`ALTER TABLE cash_closures ADD COLUMN ${definition}`);
          columns.add(name);
        }
      };
      addColumn('pay_in_cents', 'pay_in_cents INTEGER NOT NULL DEFAULT 0');
      addColumn('pay_out_cents', 'pay_out_cents INTEGER NOT NULL DEFAULT 0');
      addColumn('safe_drop_cents', 'safe_drop_cents INTEGER NOT NULL DEFAULT 0');
      addColumn('cash_movements_json', "cash_movements_json TEXT NOT NULL DEFAULT '[]'");
    },
  },
  {
    version: 85,
    name: 'add_inventory_movements',
    up: () => {
      const negativeStockedProduct = getRawDatabase()
        .prepare(`
        SELECT id, stock_quantity
        FROM products
        WHERE stock_quantity < 0
        ORDER BY id
        LIMIT 1
      `)
        .get() as { id: string; stock_quantity: number } | undefined;
      if (negativeStockedProduct) {
        throw new Error(
          `Cannot migrate inventory movements while product ${negativeStockedProduct.id} has negative stock_quantity (${negativeStockedProduct.stock_quantity}). Correct the stock quantity and retry the migration.`,
        );
      }

      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS inventory_movements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id TEXT NOT NULL REFERENCES products(id),
          quantity_delta REAL NOT NULL CHECK (quantity_delta <> 0),
          movement_type TEXT NOT NULL CHECK (movement_type IN ('sale', 'cancel_restore', 'adjustment')),
          reference_type TEXT,
          reference_id TEXT,
          reason TEXT,
          actor_user_id TEXT NOT NULL REFERENCES users(id),
          stock_after REAL NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_created
          ON inventory_movements(product_id, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference
          ON inventory_movements(reference_type, reference_id);
        CREATE INDEX IF NOT EXISTS idx_inventory_movements_created
          ON inventory_movements(created_at, id);
      `);

      const stockedProducts = getRawDatabase()
        .prepare(`
        SELECT id, stock_quantity
        FROM products
        WHERE COALESCE(stock_quantity, 0) <> 0
        ORDER BY id
      `)
        .all() as { id: string; stock_quantity: number }[];
      if (stockedProducts.length === 0) return;

      const actor = getRawDatabase()
        .prepare(`
        SELECT id
        FROM users
        ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END, created_at, id
        LIMIT 1
      `)
        .get() as { id: string } | undefined;
      if (!actor)
        throw new Error('Cannot backfill inventory movements without an existing staff actor');

      const createdAt = now();
      const insertOpeningMovement = getRawDatabase().prepare(`
        INSERT INTO inventory_movements (
          product_id, quantity_delta, movement_type, reference_type, reference_id,
          reason, actor_user_id, stock_after, created_at
        ) VALUES (?, ?, 'adjustment', 'opening_balance', ?, ?, ?, ?, ?)
      `);
      for (const product of stockedProducts) {
        insertOpeningMovement.run(
          product.id,
          product.stock_quantity,
          product.id,
          'Opening balance migrated to inventory ledger',
          actor.id,
          product.stock_quantity,
          createdAt,
        );
      }
    },
  },
  {
    version: 86,
    name: 'add_inventory_import_provenance',
    up: () => {
      const columns = new Set(
        (
          getRawDatabase().prepare('PRAGMA table_info(inventory_movements)').all() as {
            name: string;
          }[]
        ).map((column) => column.name),
      );
      const addColumn = (name: string, definition: string) => {
        if (!columns.has(name)) {
          getRawDatabase().exec(`ALTER TABLE inventory_movements ADD COLUMN ${definition}`);
          columns.add(name);
        }
      };
      addColumn('imported_by_user_id', 'imported_by_user_id TEXT REFERENCES users(id)');
      addColumn('import_batch_id', 'import_batch_id TEXT');
      addColumn('source_actor_user_id', 'source_actor_user_id TEXT');
      addColumn('source_reference_type', 'source_reference_type TEXT');
      addColumn('source_reference_id', 'source_reference_id TEXT');
      addColumn('source_reason', 'source_reason TEXT');
      addColumn('source_created_at', 'source_created_at TEXT');
    },
  },
  {
    version: 87,
    name: 'add_volume_units_and_inventory_links',
    up: () => {
      const productColumns = getColumns(getRawDatabase(), 'products');
      const needsRebuild =
        !productColumns.includes('inventory_product_id') ||
        !productColumns.includes('inventory_deduction_quantity');
      const saleUnitSql = getRawDatabase()
        .prepare(`
        SELECT sql FROM sqlite_master
        WHERE type = 'table' AND name = 'products'
      `)
        .get() as { sql: string } | undefined;
      const needsWideSaleUnit = !!saleUnitSql && !/sale_unit[^)]*'ml'/.test(saleUnitSql.sql);

      if (needsRebuild || needsWideSaleUnit) {
        // SQLite cannot ALTER a column CHECK constraint; rebuild products with
        // volume units and the 1-to-1 inventory-link columns in one pass.
        const productIndexes = (
          getRawDatabase()
            .prepare(`
          SELECT name, sql FROM sqlite_master
          WHERE type = 'index' AND tbl_name = 'products' AND sql IS NOT NULL
        `)
            .all() as { name: string; sql: string }[]
        ).filter((index) => index.name.startsWith('idx_products_'));
        getRawDatabase().exec(`
          PRAGMA foreign_keys = OFF;
          CREATE TABLE products_volume_migration (
            id TEXT PRIMARY KEY,
            category_id TEXT,
            name TEXT NOT NULL,
            description TEXT,
            price REAL NOT NULL DEFAULT 0,
            cost REAL DEFAULT 0,
            sku TEXT,
            barcode TEXT,
            sale_unit TEXT NOT NULL DEFAULT 'each' CHECK (sale_unit IN ('each', 'kg', 'g', 'lb', 'ml', 'cl', 'l', 'fl oz', 'oz')),
            allow_fractional_quantity INTEGER NOT NULL DEFAULT 0,
            weight_precision INTEGER NOT NULL DEFAULT 3 CHECK (weight_precision BETWEEN 0 AND 4),
            image_url TEXT,
            is_active INTEGER DEFAULT 1,
            sort_order INTEGER DEFAULT 0,
            track_inventory INTEGER DEFAULT 0,
            stock_quantity REAL DEFAULT 0,
            low_stock_threshold REAL DEFAULT 5,
            tax_type TEXT DEFAULT 'none',
            tax_rate REAL DEFAULT 0,
            tax_category_id TEXT DEFAULT NULL,
            tax_behavior TEXT DEFAULT 'country_default',
            cb_percent REAL DEFAULT 0,
            tags TEXT,
            inventory_product_id TEXT DEFAULT NULL REFERENCES products(id),
            inventory_deduction_quantity REAL DEFAULT 1,
            deleted_at TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (category_id) REFERENCES categories(id)
          );
          INSERT INTO products_volume_migration (
            id, category_id, name, description, price, cost, sku, barcode,
            sale_unit, allow_fractional_quantity, weight_precision, image_url,
            is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold,
            tax_type, tax_rate, tax_category_id, tax_behavior, cb_percent, tags,
            inventory_product_id, inventory_deduction_quantity, deleted_at, created_at, updated_at
          )
          SELECT
            id, category_id, name, description, price, cost, sku, barcode,
            sale_unit, allow_fractional_quantity, weight_precision, image_url,
            is_active, sort_order, track_inventory, stock_quantity, low_stock_threshold,
            tax_type, tax_rate, tax_category_id, tax_behavior, cb_percent, tags,
            ${productColumns.includes('inventory_product_id') ? 'inventory_product_id' : 'NULL'},
            ${productColumns.includes('inventory_deduction_quantity') ? 'inventory_deduction_quantity' : '1'},
            deleted_at, created_at, updated_at
          FROM products;
          DROP TABLE products;
          ALTER TABLE products_volume_migration RENAME TO products;
          PRAGMA foreign_keys = ON;
        `);
        for (const index of productIndexes) {
          getRawDatabase().exec(index.sql);
        }
      }

      if (!getColumns(getRawDatabase(), 'order_items').includes('inventory_product_id')) {
        getRawDatabase().exec(
          `ALTER TABLE order_items ADD COLUMN inventory_product_id TEXT DEFAULT NULL`,
        );
      }
    },
  },
  {
    version: 88,
    name: 'add_supplies_and_recipes',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS supplies (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_unit TEXT NOT NULL CHECK (base_unit IN ('each', 'g', 'kg', 'ml', 'l')),
          stock_quantity REAL NOT NULL DEFAULT 0,
          low_stock_threshold REAL,
          is_active INTEGER NOT NULL DEFAULT 1,
          deleted_at TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_supplies_name ON supplies(name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_supplies_deleted ON supplies(deleted_at);

        CREATE TABLE IF NOT EXISTS supply_movements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          supply_id TEXT NOT NULL REFERENCES supplies(id),
          quantity_delta REAL NOT NULL,
          movement_type TEXT NOT NULL CHECK (movement_type IN ('receive', 'count', 'adjustment', 'waste', 'recipe_depletion', 'recipe_restore')),
          unit TEXT NOT NULL CHECK (unit IN ('each', 'g', 'kg', 'ml', 'l')),
          stock_after REAL NOT NULL,
          reason TEXT,
          actor_user_id TEXT NOT NULL REFERENCES users(id),
          reference_type TEXT,
          reference_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_supply_movements_supply_created
          ON supply_movements(supply_id, created_at, id);
        CREATE INDEX IF NOT EXISTS idx_supply_movements_reference
          ON supply_movements(reference_type, reference_id);
        CREATE INDEX IF NOT EXISTS idx_supply_movements_created
          ON supply_movements(created_at, id);

        CREATE TABLE IF NOT EXISTS recipes (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL REFERENCES products(id),
          yield_quantity REAL NOT NULL DEFAULT 1 CHECK (yield_quantity > 0),
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_recipes_product
          ON recipes(product_id);

        CREATE TABLE IF NOT EXISTS recipe_items (
          id TEXT PRIMARY KEY,
          recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
          supply_id TEXT NOT NULL REFERENCES supplies(id),
          quantity REAL NOT NULL CHECK (quantity > 0),
          unit TEXT NOT NULL CHECK (unit IN ('each', 'g', 'kg', 'ml', 'l')),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_recipe_items_recipe ON recipe_items(recipe_id);
      `);
    },
  },
  {
    version: 89,
    name: 'add_order_item_recipe_snapshot',
    up: () => {
      if (!getColumns(getRawDatabase(), 'order_items').includes('recipe_snapshot')) {
        getRawDatabase().exec(
          `ALTER TABLE order_items ADD COLUMN recipe_snapshot TEXT DEFAULT NULL`,
        );
      }
    },
  },
  {
    version: 90,
    name: 'add_cash_sessions',
    up: () => {
      // Shift lifecycle, open state (#279, approach A). Close rows stay
      // final in `cash_closures` (scope='session'); an open session has no
      // count and no Z number yet, so it lives here until close writes the
      // closure row and points back via `closure_id`.
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS cash_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          opened_by TEXT NOT NULL REFERENCES users(id),
          opened_by_name TEXT NOT NULL DEFAULT '',
          opened_at TEXT NOT NULL,
          opening_float_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
          closed_at TEXT,
          closed_by TEXT REFERENCES users(id),
          closure_id INTEGER REFERENCES cash_closures(id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open
          ON cash_sessions(status) WHERE status = 'open';
      `);
      // Seeded here (not only in seedInstallDefaults) so pre-v90 upgrades
      // get the rows too — same pattern as v83's opt-in toggle.
      insertSettingIfMissing('require_open_shift', 'false');
      insertSettingIfMissing('stale_session_days', '7');
    },
  },
  {
    version: 91,
    name: 'add_cash_session_ownership',
    up: () => {
      if (!getColumns(getRawDatabase(), 'cash_drawer_movements').includes('cash_session_id')) {
        getRawDatabase().exec(
          `ALTER TABLE cash_drawer_movements ADD COLUMN cash_session_id INTEGER`,
        );
      }
      if (!getColumns(getRawDatabase(), 'refunds').includes('cash_session_id')) {
        getRawDatabase().exec(`ALTER TABLE refunds ADD COLUMN cash_session_id INTEGER`);
      }
      getRawDatabase().exec(
        `CREATE INDEX IF NOT EXISTS idx_cash_drawer_movements_session ON cash_drawer_movements(cash_session_id)`,
      );
      getRawDatabase().exec(
        `CREATE INDEX IF NOT EXISTS idx_refunds_session ON refunds(cash_session_id)`,
      );
    },
  },
  {
    version: 92,
    name: 'add_table_reservation_customer',
    up: () => {
      if (!getColumns(getRawDatabase(), 'tables').includes('reservation_customer_id')) {
        getRawDatabase().exec(
          'ALTER TABLE tables ADD COLUMN reservation_customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL',
        );
      }
      getRawDatabase().exec(`
        CREATE TRIGGER IF NOT EXISTS clear_table_reservation_customer_on_status_change
        AFTER UPDATE OF status ON tables
        WHEN NEW.status != 'reserved' AND NEW.reservation_customer_id IS NOT NULL
        BEGIN
          UPDATE tables SET reservation_customer_id = NULL WHERE id = NEW.id;
        END;
      `);
    },
  },
  {
    version: 93,
    name: 'add_configurable_permissions',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS role_permission_overrides (
          role TEXT NOT NULL ${USER_ROLE_SQL_CHECK},
          permission_id TEXT NOT NULL,
          effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
          updated_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (role, permission_id)
        );
        CREATE INDEX IF NOT EXISTS idx_role_permission_overrides_role
          ON role_permission_overrides(role);

        CREATE TABLE IF NOT EXISTS user_permission_overrides (
          user_id TEXT NOT NULL REFERENCES users(id),
          permission_id TEXT NOT NULL,
          effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
          updated_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (user_id, permission_id)
        );
        CREATE INDEX IF NOT EXISTS idx_user_permission_overrides_user
          ON user_permission_overrides(user_id);

        CREATE TABLE IF NOT EXISTS authorization_audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id TEXT NOT NULL,
          actor_user_id TEXT NOT NULL REFERENCES users(id),
          target_type TEXT NOT NULL CHECK (target_type IN ('role', 'user')),
          target_id TEXT NOT NULL,
          permission_id TEXT NOT NULL,
          previous_effect TEXT CHECK (previous_effect IS NULL OR previous_effect IN ('allow', 'deny')),
          next_effect TEXT CHECK (next_effect IS NULL OR next_effect IN ('allow', 'deny')),
          details_json TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_authorization_audit_created
          ON authorization_audit_log(created_at, id);
        CREATE INDEX IF NOT EXISTS idx_authorization_audit_target
          ON authorization_audit_log(target_type, target_id, id);
      `);
    },
  },
  {
    version: 94,
    name: 'add_order_delivery_address',
    up: () => {
      // A fresh install gets this column from the CREATE TABLE, so the ALTER is
      // guarded the way the online_platform migration guards its own columns.
      const orderColumns = getColumns(getRawDatabase(), 'orders');
      if (!orderColumns.includes('delivery_address')) {
        getRawDatabase().exec(`ALTER TABLE orders ADD COLUMN delivery_address TEXT DEFAULT NULL`);
      }
      // On by default: delivery documents show the number unless the merchant
      // turns it off. See docs/reference/product-invariants.md.
      getRawDatabase()
        .prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)')
        .run('bill_delivery_show_customer_phone_always', 'true', now());
    },
  },
  {
    version: 95,
    name: 'add_local_diagnostics_log',
    up: () => {
      // Local, operator-readable failure log. Nothing here is transmitted; the
      // diagnostics screen reads it and the copy-for-support bundle quotes it.
      insertSettingIfMissing('diagnostics_transmission_enabled', 'false');
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS local_diagnostics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_code TEXT NOT NULL,
          severity TEXT NOT NULL,
          error_class TEXT NOT NULL,
          signature TEXT NOT NULL,
          summary TEXT NOT NULL,
          metadata_json TEXT,
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_local_diagnostics_created
          ON local_diagnostics(created_at, id);
      `);
    },
  },
  {
    version: 96,
    name: 'add_whatsapp_z_report_kind',
    up: () => {
      getRawDatabase().exec(`
        ALTER TABLE whatsapp_messages RENAME TO whatsapp_messages_v95;
        CREATE TABLE whatsapp_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          bill_id INTEGER REFERENCES bills(id),
          customer_id TEXT REFERENCES customers(id),
          phone_e164 TEXT NOT NULL,
          direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
          kind TEXT NOT NULL DEFAULT 'manual_reply'
            CHECK (kind IN ('bill_receipt','manual_reply','auto_followup','z_report')),
          status TEXT NOT NULL DEFAULT 'queued'
            CHECK (status IN ('queued','seen','typing','sent','delivered','read','failed')),
          body TEXT NOT NULL,
          external_message_id TEXT,
          error TEXT,
          queued_at TEXT DEFAULT CURRENT_TIMESTAMP,
          seen_at TEXT,
          typing_at TEXT,
          sent_at TEXT,
          delivered_at TEXT,
          read_at TEXT,
          failed_at TEXT,
          created_by_user_id TEXT
        );
        INSERT INTO whatsapp_messages (
          id, bill_id, customer_id, phone_e164, direction, kind, status, body,
          external_message_id, error, queued_at, seen_at, typing_at, sent_at,
          delivered_at, read_at, failed_at, created_by_user_id
        )
        SELECT
          id, bill_id, customer_id, phone_e164, direction, kind, status, body,
          external_message_id, error, queued_at, seen_at, typing_at, sent_at,
          delivered_at, read_at, failed_at, created_by_user_id
        FROM whatsapp_messages_v95;
        DROP TABLE whatsapp_messages_v95;
        CREATE INDEX idx_whatsapp_messages_phone
          ON whatsapp_messages(phone_e164, queued_at DESC);
        CREATE INDEX idx_whatsapp_messages_status
          ON whatsapp_messages(status, queued_at DESC);
        CREATE INDEX idx_whatsapp_messages_bill
          ON whatsapp_messages(bill_id);
        CREATE INDEX idx_whatsapp_messages_inbound_unread
          ON whatsapp_messages(direction, status, queued_at DESC)
          WHERE direction = 'inbound' AND status NOT IN ('read','failed');
      `);
    },
  },
  {
    version: 97,
    name: 'add_kitchen_delivery_settlement_setting',
    up: () => {
      insertSettingIfMissing('require_kitchen_delivered_before_settlement', 'false');
    },
  },
  {
    version: 98,
    name: 'add_category_addon_groups',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS category_addon_groups (
          category_id TEXT NOT NULL,
          addon_group_id TEXT NOT NULL,
          PRIMARY KEY (category_id, addon_group_id),
          FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
          FOREIGN KEY (addon_group_id) REFERENCES addon_groups(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_category_addon_groups_category ON category_addon_groups(category_id);
        CREATE INDEX IF NOT EXISTS idx_category_addon_groups_group ON category_addon_groups(addon_group_id);
      `);
    },
  },
  {
    version: 99,
    name: 'add_charges_breakdown_and_custom_charges_setting',
    up: () => {
      // Additive only: existing orders/bills keep a NULL charges_breakdown and
      // fall back to the dedicated service_charge/packaging_charge columns.
      const orderColumns = getColumns(getRawDatabase(), 'orders');
      if (!orderColumns.includes('charges_breakdown')) {
        getRawDatabase().exec(`ALTER TABLE orders ADD COLUMN charges_breakdown TEXT`);
      }
      const billColumns = getColumns(getRawDatabase(), 'bills');
      if (!billColumns.includes('charges_breakdown')) {
        getRawDatabase().exec(`ALTER TABLE bills ADD COLUMN charges_breakdown TEXT`);
      }
      insertSettingIfMissing('custom_charges', '[]');
    },
  },
  {
    version: 100,
    name: 'add_product_variants_table',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS product_variants (
          id TEXT PRIMARY KEY,
          product_id TEXT NOT NULL,
          name TEXT NOT NULL,
          sku TEXT,
          barcode TEXT,
          price REAL NOT NULL,
          online_price REAL DEFAULT NULL,
          cost_price REAL DEFAULT NULL,
          track_inventory INTEGER DEFAULT 0,
          stock_quantity REAL DEFAULT 0,
          low_stock_threshold REAL DEFAULT NULL,
          inventory_product_id TEXT DEFAULT NULL REFERENCES products(id),
          inventory_deduction_quantity REAL DEFAULT 1,
          is_active INTEGER DEFAULT 1,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);
        CREATE INDEX IF NOT EXISTS idx_product_variants_barcode ON product_variants(barcode);
      `);

      if (!getColumns(getRawDatabase(), 'order_items').includes('variant_id')) {
        getRawDatabase().exec(`ALTER TABLE order_items ADD COLUMN variant_id TEXT DEFAULT NULL`);
      }
      if (!getColumns(getRawDatabase(), 'products').includes('dietary_tags')) {
        getRawDatabase().exec(`ALTER TABLE products ADD COLUMN dietary_tags TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 101,
    name: 'add_variant_id_to_inventory_movements',
    up: () => {
      if (!getColumns(getRawDatabase(), 'inventory_movements').includes('variant_id')) {
        getRawDatabase().exec(
          `ALTER TABLE inventory_movements ADD COLUMN variant_id TEXT DEFAULT NULL`,
        );
      }
    },
  },
  {
    version: 102,
    name: 'add_inventory_variant_id_to_order_items',
    up: () => {
      if (!getColumns(getRawDatabase(), 'order_items').includes('inventory_variant_id')) {
        getRawDatabase().exec(
          `ALTER TABLE order_items ADD COLUMN inventory_variant_id TEXT DEFAULT NULL`,
        );
      }
    },
  },
  {
    version: 103,
    name: 'add_order_delivery_collection_details',
    up: () => {
      // Additive only: NULL reads as an unknown expected method and no note,
      // which is exactly what every existing delivery order recorded.
      const orderColumns = getColumns(getRawDatabase(), 'orders');
      if (!orderColumns.includes('expected_payment_method')) {
        getRawDatabase().exec(
          `ALTER TABLE orders ADD COLUMN expected_payment_method TEXT DEFAULT NULL`,
        );
      }
      if (!orderColumns.includes('delivery_note')) {
        getRawDatabase().exec(`ALTER TABLE orders ADD COLUMN delivery_note TEXT DEFAULT NULL`);
      }
    },
  },
  {
    version: 104,
    name: 'add_addon_inventory',
    up: () => {
      // Additive only, like every catalog column so far: existing add-ons keep
      // an untracked, zero-stock pool until a merchant switches tracking on.
      const addonColumns = getColumns(getRawDatabase(), 'addons');
      const addAddonColumn = (name: string, definition: string) => {
        if (addonColumns.includes(name)) return;
        getRawDatabase().exec(`ALTER TABLE addons ADD COLUMN ${definition}`);
        addonColumns.push(name);
      };
      addAddonColumn('track_inventory', 'track_inventory INTEGER DEFAULT 0');
      addAddonColumn('stock_quantity', 'stock_quantity REAL DEFAULT 0');
      addAddonColumn('low_stock_threshold', 'low_stock_threshold REAL DEFAULT 0');

      if (
        !getColumns(getRawDatabase(), 'order_item_addons').includes('inventory_deducted_quantity')
      ) {
        getRawDatabase().exec(
          `ALTER TABLE order_item_addons ADD COLUMN inventory_deducted_quantity REAL NOT NULL DEFAULT 0`,
        );
      }
      if (!getColumns(getRawDatabase(), 'inventory_movements').includes('addon_id')) {
        getRawDatabase().exec(
          `ALTER TABLE inventory_movements ADD COLUMN addon_id TEXT DEFAULT NULL`,
        );
      }

      // An add-on pool has no owning product, so the ledger can no longer
      // require product_id. Rebuild once: SQLite cannot relax a NOT NULL
      // constraint in place. Every existing row is copied column by column, so
      // a column this migration does not know about fails the copy loudly
      // instead of being dropped.
      const productIdColumn = (
        getRawDatabase().prepare('PRAGMA table_info(inventory_movements)').all() as {
          name: string;
          notnull: number;
        }[]
      ).find((column) => column.name === 'product_id');
      if (productIdColumn?.notnull === 1) {
        getRawDatabase().exec(`
          ALTER TABLE inventory_movements RENAME TO inventory_movements_v103;
          CREATE TABLE inventory_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id TEXT DEFAULT NULL REFERENCES products(id),
            quantity_delta REAL NOT NULL CHECK (quantity_delta <> 0),
            movement_type TEXT NOT NULL CHECK (movement_type IN ('sale', 'cancel_restore', 'adjustment')),
            reference_type TEXT,
            reference_id TEXT,
            reason TEXT,
            actor_user_id TEXT NOT NULL REFERENCES users(id),
            stock_after REAL NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            imported_by_user_id TEXT REFERENCES users(id),
            import_batch_id TEXT,
            source_actor_user_id TEXT,
            source_reference_type TEXT,
            source_reference_id TEXT,
            source_reason TEXT,
            source_created_at TEXT,
            variant_id TEXT DEFAULT NULL,
            addon_id TEXT DEFAULT NULL
          );
          INSERT INTO inventory_movements (
            id, product_id, quantity_delta, movement_type, reference_type, reference_id,
            reason, actor_user_id, stock_after, created_at,
            imported_by_user_id, import_batch_id,
            source_actor_user_id, source_reference_type, source_reference_id,
            source_reason, source_created_at, variant_id, addon_id
          )
          SELECT
            id, product_id, quantity_delta, movement_type, reference_type, reference_id,
            reason, actor_user_id, stock_after, created_at,
            imported_by_user_id, import_batch_id,
            source_actor_user_id, source_reference_type, source_reference_id,
            source_reason, source_created_at, variant_id, addon_id
          FROM inventory_movements_v103;
          DROP TABLE inventory_movements_v103;
          CREATE INDEX IF NOT EXISTS idx_inventory_movements_product_created
            ON inventory_movements(product_id, created_at, id);
          CREATE INDEX IF NOT EXISTS idx_inventory_movements_reference
            ON inventory_movements(reference_type, reference_id);
          CREATE INDEX IF NOT EXISTS idx_inventory_movements_created
            ON inventory_movements(created_at, id);
        `);
      }
    },
  },
  {
    version: 105,
    name: 'add_held_order_charge_selections',
    up: () => {
      // Additive only: a cart held before these columns existed carries no
      // charge decisions, and an empty selection list says exactly that.
      const heldOrderColumns = getColumns(getRawDatabase(), 'held_orders');
      const addHeldOrderColumn = (name: string, definition: string) => {
        if (heldOrderColumns.includes(name)) return;
        getRawDatabase().exec(`ALTER TABLE held_orders ADD COLUMN ${definition}`);
        heldOrderColumns.push(name);
      };
      addHeldOrderColumn('waived_charge_ids', `waived_charge_ids TEXT NOT NULL DEFAULT '[]'`);
      addHeldOrderColumn('opted_in_charge_ids', `opted_in_charge_ids TEXT NOT NULL DEFAULT '[]'`);
    },
  },
  {
    version: 106,
    name: 'add_order_expected_payment_method_id',
    up: () => {
      // A historical identity marker, deliberately not a foreign key: deleting
      // or renaming the configured method must never rewrite what an order
      // said it expected. Rows that predate the column stay NULL - an old
      // `expected_payment_method` string was never an identity and must not be
      // guessed into one.
      if (!getColumns(getRawDatabase(), 'orders').includes('expected_payment_method_id')) {
        getRawDatabase().exec(
          'ALTER TABLE orders ADD COLUMN expected_payment_method_id INTEGER DEFAULT NULL',
        );
      }
    },
  },
  {
    version: 107,
    name: 'add_variant_recipe_multiplier',
    up: () => {
      // Additive only: every existing variant consumes exactly one base recipe
      // portion, which is what it did before the column existed. The multiplier
      // scales ingredient depletion; it is not the linked-product stock factor.
      if (!getColumns(getRawDatabase(), 'product_variants').includes('recipe_multiplier')) {
        getRawDatabase().exec(
          'ALTER TABLE product_variants ADD COLUMN recipe_multiplier REAL NOT NULL DEFAULT 1 CHECK (recipe_multiplier > 0)',
        );
      }
    },
  },
  {
    version: 108,
    name: 'add_expense_records',
    up: () => {
      // Additive only: expense categories, immutable expenses, their
      // payment/reversal ledger, and the idempotency receipts that make the
      // expense mutations replayable. No existing table is touched.
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS expense_categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_by TEXT NOT NULL REFERENCES users(id),
          updated_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_categories_name_key
          ON expense_categories(name_key);

        CREATE TABLE IF NOT EXISTS expenses (
          id TEXT PRIMARY KEY,
          category_id TEXT NOT NULL REFERENCES expense_categories(id),
          category_name TEXT NOT NULL,
          description TEXT NOT NULL,
          payee TEXT,
          notes TEXT,
          amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
          currency_code TEXT NOT NULL CHECK (length(currency_code) = 3),
          incurred_on TEXT NOT NULL CHECK (incurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          replaces_expense_id TEXT REFERENCES expenses(id),
          voided_at TEXT,
          voided_by TEXT REFERENCES users(id),
          void_reason TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_replaces_unique
          ON expenses(replaces_expense_id) WHERE replaces_expense_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_expenses_incurred ON expenses(incurred_on, id);
        CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id, incurred_on, id);

        CREATE TABLE IF NOT EXISTS expense_payments (
          id TEXT PRIMARY KEY,
          expense_id TEXT NOT NULL REFERENCES expenses(id),
          amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
          method TEXT NOT NULL CHECK (method IN ('cash', 'card', 'bank_transfer', 'other')),
          business_date TEXT NOT NULL CHECK (business_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          reversal_of TEXT REFERENCES expense_payments(id),
          reason TEXT,
          cash_movement_id INTEGER REFERENCES cash_drawer_movements(id),
          created_by TEXT NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL,
          CHECK ((reversal_of IS NULL AND reason IS NULL) OR (reversal_of IS NOT NULL AND reason IS NOT NULL))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_payments_reversal_unique
          ON expense_payments(reversal_of) WHERE reversal_of IS NOT NULL;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_payments_cash_movement
          ON expense_payments(cash_movement_id) WHERE cash_movement_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_expense_payments_expense
          ON expense_payments(expense_id, created_at, id);

        CREATE TABLE IF NOT EXISTS expense_mutations (
          actor_user_id TEXT NOT NULL REFERENCES users(id),
          idempotency_key TEXT NOT NULL,
          operation TEXT NOT NULL,
          resource_id TEXT NOT NULL,
          request_hash TEXT NOT NULL,
          response_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (actor_user_id, idempotency_key)
        );
      `);
    },
  },
  {
    version: 109,
    name: 'add_expense_payment_reference',
    up: () => {
      // Optional operator reference on a recorded expense payment (slip,
      // transfer, or receipt number). Nullable and additive, so existing
      // payment rows stay valid unchanged.
      if (!getColumns(getRawDatabase(), 'expense_payments').includes('reference')) {
        getRawDatabase().exec('ALTER TABLE expense_payments ADD COLUMN reference TEXT');
      }
    },
  },
  {
    version: 110,
    name: 'enable_safe_diagnostics_transmission_once',
    up: () => {
      const getSetting = (key: string) =>
        (
          getRawDatabase().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
            | { value: string }
            | undefined
        )?.value;
      const consent = getSetting('diagnostics_consent');
      const explicit = getSetting('diagnostics_settings_explicit') === 'true';
      const transmission = getSetting('diagnostics_transmission_enabled');
      const hasExistingUsers =
        (getRawDatabase().prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n > 0;
      insertSettingIfMissing('diagnostics_settings_explicit', 'false');
      insertSettingIfMissing('diagnostics_consent_sync_pending', 'false');
      if (consent === 'false') {
        upsertSetting('diagnostics_settings_explicit', 'true');
        upsertSetting('diagnostics_consent_sync_pending', 'true');
      } else if (explicit && transmission === 'false') {
        upsertSetting('diagnostics_consent_sync_pending', 'true');
      } else if (!explicit && hasExistingUsers) {
        // Legacy false had no reliable provenance; enable once for existing
        // installs unless the merchant had explicitly refused diagnostics consent.
        // Fresh installs stay opted out until the operator chooses.
        upsertSetting('diagnostics_transmission_enabled', 'true');
      }
      if (
        getSetting('diagnostics_consent_sync_pending') === 'true' &&
        !getSetting('diagnostics_consent_change_id')
      ) {
        upsertSetting('diagnostics_consent_change_id', crypto.randomUUID());
      }
    },
  },
  {
    version: 111,
    name: 'add_hourly_diagnostics_aggregates_and_delivery_gaps',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS diagnostics_hourly_aggregates (
          aggregate_key TEXT PRIMARY KEY,
          capture_point TEXT NOT NULL,
          reason_code TEXT NOT NULL,
          classification TEXT NOT NULL CHECK (classification IN ('expected_rejection', 'unexpected_failure')),
          operation TEXT NOT NULL,
          stage TEXT NOT NULL,
          outcome TEXT NOT NULL CHECK (outcome IN ('not_applied', 'applied', 'partial', 'unknown', 'not_applicable')),
          window_start TEXT NOT NULL,
          count INTEGER NOT NULL CHECK (count > 0),
          first_occurred_at TEXT NOT NULL,
          last_occurred_at TEXT NOT NULL,
          app_version TEXT NOT NULL,
          app_build TEXT NOT NULL,
          platform TEXT NOT NULL CHECK (platform IN ('win32', 'darwin', 'linux', 'unknown')),
          examples_json TEXT NOT NULL DEFAULT '[]',
          facts_json TEXT NOT NULL DEFAULT '{}',
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_diagnostics_hourly_window
          ON diagnostics_hourly_aggregates(window_start, updated_at);
        CREATE TABLE IF NOT EXISTS diagnostics_delivery_gaps (
          reason_code TEXT PRIMARY KEY CHECK (reason_code IN ('queue_eviction', 'permanent_rejection', 'invalid_ack', 'report_id_mismatch', 'local_retention')),
          count INTEGER NOT NULL CHECK (count >= 0),
          first_occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 112,
    name: 'pin_diagnostics_transport_and_permanent_rejections',
    up: () => {
      const columns = getColumns(getRawDatabase(), 'store_diagnostics_outbox');
      if (!columns.includes('transport')) {
        getRawDatabase().exec(
          "ALTER TABLE store_diagnostics_outbox ADD COLUMN transport TEXT NOT NULL DEFAULT 'signed'",
        );
      }
      if (!columns.includes('permanent_failure')) {
        getRawDatabase().exec(
          'ALTER TABLE store_diagnostics_outbox ADD COLUMN permanent_failure INTEGER NOT NULL DEFAULT 0 CHECK (permanent_failure IN (0, 1))',
        );
      }
    },
  },
  {
    version: 113,
    name: 'customer_display_tokens',
    up: () => {
      getRawDatabase().exec(`
        CREATE TABLE IF NOT EXISTS customer_display_tokens (
          id TEXT PRIMARY KEY,
          token_hash TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL,
          created_by TEXT,
          created_at TEXT NOT NULL,
          last_seen_at TEXT,
          revoked_at TEXT
        );
      `);
    },
  },
  {
    version: 114,
    name: 'add_order_audit_log_item_index',
    up: () => {
      getRawDatabase().exec(`
        CREATE INDEX IF NOT EXISTS idx_order_audit_log_item ON order_audit_log(order_item_id);
      `);
    },
  },
  {
    version: 115,
    name: 'add_order_and_customer_search_fts',
    up: () => {
      getRawDatabase().exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS orders_search_fts USING fts5(
          order_number,
          content='orders',
          content_rowid='id',
          tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS trg_orders_search_ai AFTER INSERT ON orders BEGIN
          INSERT INTO orders_search_fts(rowid, order_number) VALUES (new.id, new.order_number);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_orders_search_ad AFTER DELETE ON orders BEGIN
          INSERT INTO orders_search_fts(orders_search_fts, rowid, order_number) VALUES('delete', old.id, old.order_number);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_orders_search_au AFTER UPDATE OF order_number ON orders BEGIN
          INSERT INTO orders_search_fts(orders_search_fts, rowid, order_number) VALUES('delete', old.id, old.order_number);
          INSERT INTO orders_search_fts(rowid, order_number) VALUES (new.id, new.order_number);
        END;

        CREATE VIRTUAL TABLE IF NOT EXISTS customers_search_fts USING fts5(
          name,
          phone,
          phone_digits,
          content='customers',
          content_rowid='rowid',
          tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS trg_customers_search_ai AFTER INSERT ON customers BEGIN
          INSERT INTO customers_search_fts(rowid, name, phone, phone_digits) VALUES (new.rowid, new.name, new.phone, new.phone_digits);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_customers_search_ad AFTER DELETE ON customers BEGIN
          INSERT INTO customers_search_fts(customers_search_fts, rowid, name, phone, phone_digits) VALUES('delete', old.rowid, old.name, old.phone, old.phone_digits);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_customers_search_au AFTER UPDATE OF name, phone, phone_digits ON customers BEGIN
          INSERT INTO customers_search_fts(customers_search_fts, rowid, name, phone, phone_digits) VALUES('delete', old.rowid, old.name, old.phone, old.phone_digits);
          INSERT INTO customers_search_fts(rowid, name, phone, phone_digits) VALUES (new.rowid, new.name, new.phone, new.phone_digits);
        END;

        INSERT INTO orders_search_fts(rowid, order_number)
        SELECT id, order_number FROM orders;

        INSERT INTO customers_search_fts(rowid, name, phone, phone_digits)
        SELECT rowid, name, phone, phone_digits FROM customers;
      `);
    },
  },
  {
    version: 116,
    name: 'add_order_item_price_override',
    up: () => {
      const columns = getColumns(getRawDatabase(), 'order_items');
      const add = (name: string, definition: string) => {
        if (!columns.includes(name))
          getRawDatabase().exec(`ALTER TABLE order_items ADD COLUMN ${name} ${definition}`);
      };
      add('price_overridden', 'INTEGER NOT NULL DEFAULT 0');
      add('original_unit_price', 'REAL');
      add('price_override_reason', 'TEXT');
      add('price_overridden_by', 'TEXT');
      add('price_overridden_at', 'TEXT');
      getRawDatabase().exec(`
        CREATE INDEX IF NOT EXISTS idx_order_items_price_overridden
          ON order_items(price_overridden_at) WHERE price_overridden = 1;
      `);
    },
  },
  {
    version: 117,
    name: 'add_ingredient_cost_tracking',
    up: () => {
      const supplyColumns = getColumns(getRawDatabase(), 'supplies');
      if (!supplyColumns.includes('unit_cost')) {
        getRawDatabase().exec('ALTER TABLE supplies ADD COLUMN unit_cost REAL DEFAULT NULL');
      }

      const movementColumns = getColumns(getRawDatabase(), 'supply_movements');
      const addMovementCol = (name: string, definition: string) => {
        if (!movementColumns.includes(name)) {
          getRawDatabase().exec(`ALTER TABLE supply_movements ADD COLUMN ${name} ${definition}`);
        }
      };
      addMovementCol('unit_cost', 'REAL DEFAULT NULL');
      addMovementCol('total_cost', 'REAL DEFAULT NULL');
      addMovementCol('unit_cost_after', 'REAL DEFAULT NULL');

      const orderItemColumns = getColumns(getRawDatabase(), 'order_items');
      const addOrderItemCol = (name: string, definition: string) => {
        if (!orderItemColumns.includes(name)) {
          getRawDatabase().exec(`ALTER TABLE order_items ADD COLUMN ${name} ${definition}`);
        }
      };
      addOrderItemCol('ingredient_cost', 'REAL DEFAULT NULL');
      addOrderItemCol('ingredient_cost_known', 'INTEGER NOT NULL DEFAULT 0');
    },
  },
  {
    // Cashier table-map workspace (owner design, 2026-10-26): the moment a
    // dine-in order's bill was first requested for the table. The table's
    // visible state lives in tables.status ('bill_requested'); this stamp is
    // the order's permanent record of when that first request happened.
    version: 118,
    name: 'add_order_bill_requested_at',
    up: () => {
      const orderColumns = getColumns(getRawDatabase(), 'orders');
      if (!orderColumns.includes('bill_requested_at')) {
        getRawDatabase().exec('ALTER TABLE orders ADD COLUMN bill_requested_at TEXT DEFAULT NULL');
      }
    },
  },
  {
    // Split-by-item payment is a core cashier flow, not an opt-in: stores
    // that never touched the setting still carry the old 'false' seed (v60),
    // so flip it on. The guard keeps the UPDATE idempotent on re-runs.
    version: 119,
    name: 'enable_split_checks_default',
    up: () => {
      getRawDatabase()
        .prepare(`
        UPDATE settings
        SET value = 'true', updated_at = ?
        WHERE key = 'split_checks_enabled' AND value = 'false'
      `)
        .run(now());
    },
  },
  {
    // Installs upgraded from the pre-Syria schema carry customers.country_code
    // with DEFAULT '+91' (the old add-column migration); fresh installs use
    // '+963'. SQLite cannot alter a column default, so rebuild customers with
    // only that literal swapped, preserving rows, indexes, and FTS triggers.
    version: 120,
    name: 'customers_country_code_default_syria',
    up: () => {
      const tableSql = getRawDatabase()
        .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customers'`)
        .get() as { sql: string } | undefined;
      if (!tableSql?.sql || !tableSql.sql.includes("country_code TEXT DEFAULT '+91'")) {
        return;
      }
      const dependents = getRawDatabase()
        .prepare(
          `SELECT type, sql FROM sqlite_master
           WHERE tbl_name = 'customers' AND sql IS NOT NULL AND type IN ('index', 'trigger')`,
        )
        .all() as { type: string; sql: string }[];
      const columns = getColumns(getRawDatabase(), 'customers');
      const columnList = columns.join(', ');
      const rebuiltSql = tableSql.sql
        .replace('CREATE TABLE IF NOT EXISTS customers', 'CREATE TABLE customers_v120')
        .replace('CREATE TABLE customers', 'CREATE TABLE customers_v120')
        .replace("country_code TEXT DEFAULT '+91'", "country_code TEXT DEFAULT '+963'");
      getRawDatabase().exec('PRAGMA foreign_keys = OFF');
      try {
        getRawDatabase().exec(rebuiltSql);
        getRawDatabase().exec(
          `INSERT INTO customers_v120 (rowid, ${columnList}) SELECT rowid, ${columnList} FROM customers`,
        );
        getRawDatabase().exec('DROP TABLE customers');
        getRawDatabase().exec('ALTER TABLE customers_v120 RENAME TO customers');
        for (const dependent of dependents) {
          getRawDatabase().exec(dependent.sql);
        }
      } finally {
        getRawDatabase().exec('PRAGMA foreign_keys = ON');
      }
      const ftsExists = getRawDatabase()
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'customers_search_fts'`,
        )
        .get();
      if (ftsExists) {
        getRawDatabase().exec(
          "INSERT INTO customers_search_fts(customers_search_fts) VALUES('rebuild')",
        );
      }
    },
  },
  {
    // Cashier-facing product flags: sold out for the day (with the moment it
    // was marked) and pinned ahead of category peers on the POS grid.
    version: 121,
    name: 'add_product_sold_out_and_pinned',
    up: () => {
      const productColumns = getColumns(getRawDatabase(), 'products');
      if (!productColumns.includes('is_sold_out')) {
        getRawDatabase().exec(
          'ALTER TABLE products ADD COLUMN is_sold_out INTEGER NOT NULL DEFAULT 0',
        );
      }
      if (!productColumns.includes('sold_out_at')) {
        getRawDatabase().exec('ALTER TABLE products ADD COLUMN sold_out_at TEXT DEFAULT NULL');
      }
      if (!productColumns.includes('is_pinned')) {
        getRawDatabase().exec(
          'ALTER TABLE products ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0',
        );
      }
    },
  },
  {
    // When a reserved table's party is expected; the reservation customer
    // link already exists, this is its time half.
    version: 122,
    name: 'add_table_reservation_at',
    up: () => {
      const tableColumns = getColumns(getRawDatabase(), 'tables');
      if (!tableColumns.includes('reservation_at')) {
        getRawDatabase().exec('ALTER TABLE tables ADD COLUMN reservation_at TEXT DEFAULT NULL');
      }
    },
  },
];

function syncBackupBeforeMigration(fromVersion: number, toVersion: number): void {
  if (buildingIdealSchema) return;
  let targetPath = '';
  let completed = false;
  try {
    const dbPath = getDbPath();
    const backupDir = getBackupDir();
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    targetPath = path.join(
      backupDir,
      `rest-cafe-backup-${timestamp}-pre-v${fromVersion}-to-v${toVersion}.db`,
    );

    if (fs.existsSync(dbPath)) {
      getRawDatabase().pragma('wal_checkpoint(TRUNCATE)');
      fs.copyFileSync(dbPath, targetPath);
    } else {
      // A brand-new install has no source file yet; keep the backup contract
      // by creating an empty SQLite file with migration metadata below.
      fs.writeFileSync(targetPath, '');
    }

    let backupDb: Database.Database | undefined;
    try {
      backupDb = new Database(targetPath);
      backupDb.pragma('journal_mode = DELETE');
      backupDb.exec(`
        CREATE TABLE IF NOT EXISTS _flo_meta (
          key TEXT PRIMARY KEY,
          value TEXT
        )
      `);
      // Record schema version on snapshot so it correctly reflects pre-migration state.
      backupDb.pragma(`user_version = ${fromVersion}`);
      backupDb
        .prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('schema_version', String(fromVersion));
      backupDb
        .prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('backup_created_at', new Date().toISOString());
      backupDb
        .prepare(`INSERT OR REPLACE INTO _flo_meta (key, value) VALUES (?, ?)`)
        .run('app_version', app.getVersion());
    } finally {
      backupDb?.close();
    }
    syncFile(targetPath);
    if (!syncDirectory(path.dirname(targetPath)) && process.platform !== 'win32') {
      throw new Error('Could not durably persist pre-migration backup');
    }

    completed = true;
    console.log(
      `[DB] Auto-backup before migrating v${fromVersion} → v${toVersion} created at ${targetPath}`,
    );
  } catch (err: any) {
    console.error(`[DB] Auto-backup before migration failed:`, err.message);
    throw new Error(
      `Pre-migration backup failed; refusing to migrate the database: ${err.message}`,
    );
  } finally {
    if (!completed && targetPath) {
      for (const filePath of [targetPath, `${targetPath}-wal`, `${targetPath}-shm`]) {
        try {
          if (pathEntryExists(filePath)) fs.unlinkSync(filePath);
        } catch {}
      }
    }
  }
}

export class SchemaVersionMismatchError extends Error {
  constructor(
    public readonly dbVersion: number,
    public readonly appVersion: number,
  ) {
    super(
      `Database schema (v${dbVersion}) is newer than this app version supports (v${appVersion}). ` +
        `This usually means another device or a previous update already upgraded this database. ` +
        `Please update Rest&Cafe to the latest version before continuing.`,
    );
    this.name = 'SchemaVersionMismatchError';
  }
}

export function runMigrations(targetVersion?: number): void {
  const current = getCurrentSchemaVersion();
  const maxSupported = MIGRATIONS.length > 0 ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;
  const target = targetVersion !== undefined ? targetVersion : maxSupported;
  const verboseMigrationLogs = process.env.FLOCAFE_TEST_VERBOSE === '1';

  if (current > target) {
    // Fail startup if database schema version is newer than supported by this build.
    throw new SchemaVersionMismatchError(current, target);
  }

  if (current === target) {
    if (!buildingIdealSchema) console.log(`[DB] Schema up to date (v${current})`);
    return;
  }

  if (!buildingIdealSchema) console.log(`[DB] Schema: v${current} → v${target}`);

  // Create automatic pre-migration backup before running pending batch.
  if (!buildingIdealSchema) {
    console.log(`[DB] Triggering auto-backup before migrating v${current} → v${target}...`);
    syncBackupBeforeMigration(current, target);
  }

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    if (migration.version > target) break;

    if (verboseMigrationLogs && !buildingIdealSchema) {
      console.log(`[DB] Applying migration v${migration.version}: ${migration.name}`);
    }
    getRawDatabase().transaction(() => {
      migration.up();
      getRawDatabase().pragma(`user_version = ${migration.version}`);
    })();
    if (verboseMigrationLogs && !buildingIdealSchema) {
      console.log(`[DB] Migration v${migration.version} complete`);
    }
  }
}

// Initial schema definition for brand-new installs (migration v1).
function createSchema(): void {
  getRawDatabase().exec(`
    -- ── Master data tables ──────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      image_url TEXT,
      sort_order INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      parent_id TEXT,
      slug TEXT,
      color TEXT,
      icon TEXT,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      category_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      price REAL NOT NULL DEFAULT 0,
      cost REAL DEFAULT 0,
      sku TEXT,
      barcode TEXT,
      sale_unit TEXT NOT NULL DEFAULT 'each' CHECK (sale_unit IN ('each', 'kg', 'g', 'lb', 'ml', 'cl', 'l', 'fl oz', 'oz')),
      allow_fractional_quantity INTEGER NOT NULL DEFAULT 0,
      weight_precision INTEGER NOT NULL DEFAULT 3 CHECK (weight_precision BETWEEN 0 AND 4),
      image_url TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      track_inventory INTEGER DEFAULT 0,
      stock_quantity REAL DEFAULT 0,
      low_stock_threshold REAL DEFAULT 5,
      tax_type TEXT DEFAULT 'none',
      tax_rate REAL DEFAULT 0,
      tax_category_id TEXT DEFAULT NULL,
      tax_behavior TEXT DEFAULT 'country_default',
      -- Defaults to 0 so fresh and upgraded installs have identical schema.
      cb_percent REAL DEFAULT 0,
      tags TEXT,
      inventory_product_id TEXT DEFAULT NULL REFERENCES products(id),
      inventory_deduction_quantity REAL DEFAULT 1,
      deleted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id)
    );

    CREATE TABLE IF NOT EXISTS addon_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      is_required INTEGER DEFAULT 0,
      min_selection INTEGER DEFAULT 0,
      max_selection INTEGER DEFAULT 1,
      allow_multiple_quantities INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS addons (
      id TEXT PRIMARY KEY,
      addon_group_id TEXT NOT NULL,
      name TEXT NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      tax_category_id TEXT DEFAULT NULL,
      tax_behavior TEXT DEFAULT 'country_default',
      inherit_parent_tax_category INTEGER DEFAULT 1,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (addon_group_id) REFERENCES addon_groups(id)
    );

    CREATE TABLE IF NOT EXISTS addon_group_product (
      product_id TEXT NOT NULL,
      addon_group_id TEXT NOT NULL,
      PRIMARY KEY (product_id, addon_group_id)
    );

    CREATE TABLE IF NOT EXISTS category_addon_groups (
      category_id TEXT NOT NULL,
      addon_group_id TEXT NOT NULL,
      PRIMARY KEY (category_id, addon_group_id),
      FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE,
      FOREIGN KEY (addon_group_id) REFERENCES addon_groups(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_category_addon_groups_category ON category_addon_groups(category_id);
    CREATE INDEX IF NOT EXISTS idx_category_addon_groups_group ON category_addon_groups(addon_group_id);

    CREATE TABLE IF NOT EXISTS kitchen_stations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category_ids TEXT,
      printer_id TEXT,
      printer_ip TEXT,
      printer_port INTEGER DEFAULT 9100,
      printer_name TEXT,
      is_active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS station_users (
      user_id TEXT NOT NULL,
      station_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, station_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (station_id) REFERENCES kitchen_stations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tables (
      id TEXT PRIMARY KEY,
      number TEXT NOT NULL UNIQUE,
      capacity INTEGER DEFAULT 4,
      status TEXT DEFAULT 'available',
      floor TEXT,
      section TEXT,
      position_x REAL,
      position_y REAL,
      kitchen_station_id TEXT,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      reservation_customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      country_code TEXT DEFAULT '+963',
      address TEXT,
      notes TEXT,
      tag_counts TEXT DEFAULT NULL,
      is_active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Users (authentication + roles) ──────────────────────────────────
    -- Roles: ${ROLE_KEYS.join(', ')}
    -- KDS is operated by the chef role.

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier'
        ${USER_ROLE_SQL_CHECK},
      pin TEXT,
      pin_hash TEXT,
      category_ids TEXT,
      is_active INTEGER DEFAULT 1,
      terms_accepted_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Transactional tables ─────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_number TEXT UNIQUE NOT NULL,
      table_id TEXT,
      customer_id TEXT,
      user_id TEXT,
      type TEXT DEFAULT 'takeaway',
      delivery_address TEXT DEFAULT NULL,
      expected_payment_method TEXT DEFAULT NULL,
      delivery_note TEXT DEFAULT NULL,
      guest_count INTEGER,
      special_instructions TEXT,
      packaging_charge REAL DEFAULT 0,
      delivery_charge REAL DEFAULT 0,
      service_charge REAL DEFAULT 0,
      charges_breakdown TEXT,
      status TEXT DEFAULT 'pending',
      subtotal REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      tax_breakdown TEXT,
      tax_snapshot TEXT DEFAULT NULL,
      packaging_tax_category_id TEXT DEFAULT NULL,
      delivery_tax_category_id TEXT DEFAULT NULL,
      service_charge_tax_category_id TEXT DEFAULT NULL,
      discount_amount REAL DEFAULT 0,
      discount_type TEXT,
      discount_value REAL,
      discount_reason TEXT,
      round_off REAL DEFAULT 0,
      total REAL DEFAULT 0,
      cooking_started_at TEXT,
      ready_at TEXT,
      served_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      cancellation_reason TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id TEXT NOT NULL,
      product_name TEXT NOT NULL,
      product_sku TEXT,
      unit_price REAL NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      inventory_deducted_quantity REAL NOT NULL DEFAULT 0,
      inventory_product_id TEXT DEFAULT NULL,
      subtotal REAL NOT NULL,
      tax_amount REAL DEFAULT 0,
      tax_breakdown TEXT,
      tax_snapshot TEXT DEFAULT NULL,
      tax_type TEXT,
      discount_amount REAL DEFAULT 0,
      total REAL NOT NULL,
      variant_selection TEXT,
      modifier_selection TEXT,
      addons TEXT,
      special_instructions TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_number TEXT UNIQUE NOT NULL,
      order_id INTEGER NOT NULL,
      customer_id TEXT,
      subtotal REAL DEFAULT 0,
      tax_amount REAL DEFAULT 0,
      tax_breakdown TEXT,
      tax_snapshot TEXT DEFAULT NULL,
      discount_amount REAL DEFAULT 0,
      discount_type TEXT,
      discount_value REAL,
      discount_reason TEXT,
      delivery_charge REAL DEFAULT 0,
      packaging_charge REAL DEFAULT 0,
      service_charge REAL DEFAULT 0,
      charges_breakdown TEXT,
      round_off REAL DEFAULT 0,
      total REAL DEFAULT 0,
      paid_amount REAL DEFAULT 0,
      balance REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'unpaid',
      payment_details TEXT,
      paid_at TEXT,
      printed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (order_id) REFERENCES orders(id)
    );

    CREATE TABLE IF NOT EXISTS loyalty_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id TEXT NOT NULL,
      bill_id INTEGER,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      description TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Config tables ────────────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS kds_pairing_tokens (
      id TEXT PRIMARY KEY,
      token TEXT UNIQUE NOT NULL,
      station_id TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS printers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      connection_type TEXT NOT NULL CHECK (connection_type IN ('network', 'usb', 'webusb')),
      ip_address TEXT,
      port INTEGER DEFAULT 9100,
      is_default INTEGER DEFAULT 0,
      cash_drawer_pulse_enabled INTEGER NOT NULL DEFAULT 0,
      paper_width TEXT DEFAULT '80mm',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS country_packs (
      id TEXT PRIMARY KEY,
      publisher TEXT NOT NULL,
      country TEXT NOT NULL,
      jurisdiction TEXT NOT NULL,
      active_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'installed',
      disclaimer_acknowledged_at TEXT,
      disclaimer_acknowledged_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS country_pack_versions (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      version TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      pack_json TEXT NOT NULL,
      digest TEXT,
      signature TEXT,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      min_flo_version TEXT NOT NULL,
      published_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'staged',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_id, version)
    );

    CREATE TABLE IF NOT EXISTS tax_categories (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      label TEXT NOT NULL,
      default_behavior TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS tax_rules (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      label TEXT NOT NULL,
      calculation_type TEXT NOT NULL,
      rate TEXT,
      amount TEXT,
      applies_per TEXT,
      base_rule_ids TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, rule_id)
    );

    CREATE TABLE IF NOT EXISTS tax_overrides (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      field_name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_by_user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS installed_print_templates (
      template_id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      pack_version_id TEXT NOT NULL,
      country TEXT NOT NULL,
      jurisdiction TEXT NOT NULL,
      display_name TEXT NOT NULL,
      paper_widths_json TEXT NOT NULL,
      renderer_json TEXT NOT NULL,
      template_payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'installed',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tax_config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      pack_id TEXT,
      pack_version_id TEXT,
      override_id TEXT,
      actor_user_id TEXT,
      details_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    -- ── Indexes ──────────────────────────────────────────────────────────

    CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_products_active   ON products(is_active);
    CREATE INDEX IF NOT EXISTS idx_orders_status     ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created    ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_orders_user       ON orders(user_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_bills_order       ON bills(order_id);
    CREATE INDEX IF NOT EXISTS idx_country_pack_versions_pack ON country_pack_versions(pack_id);
    CREATE INDEX IF NOT EXISTS idx_tax_categories_pack_version ON tax_categories(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_rules_pack_version ON tax_rules(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_overrides_pack_version ON tax_overrides(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_installed_print_templates_pack_version ON installed_print_templates(pack_version_id);
  `);
}

function createTaxPackSchema(): void {
  getRawDatabase().exec(`
    CREATE TABLE IF NOT EXISTS country_packs (
      id TEXT PRIMARY KEY,
      publisher TEXT NOT NULL,
      country TEXT NOT NULL,
      jurisdiction TEXT NOT NULL,
      active_version_id TEXT,
      status TEXT NOT NULL DEFAULT 'installed',
      disclaimer_acknowledged_at TEXT,
      disclaimer_acknowledged_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS country_pack_versions (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      version TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      manifest_json TEXT NOT NULL,
      pack_json TEXT NOT NULL,
      digest TEXT,
      signature TEXT,
      effective_from TEXT NOT NULL,
      effective_to TEXT,
      min_flo_version TEXT NOT NULL,
      published_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'staged',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_id, version)
    );

    CREATE TABLE IF NOT EXISTS tax_categories (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      category_id TEXT NOT NULL,
      label TEXT NOT NULL,
      default_behavior TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, category_id)
    );

    CREATE TABLE IF NOT EXISTS tax_rules (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      label TEXT NOT NULL,
      calculation_type TEXT NOT NULL,
      rate TEXT,
      amount TEXT,
      applies_per TEXT,
      base_rule_ids TEXT,
      definition_json TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(pack_version_id, rule_id)
    );

    CREATE TABLE IF NOT EXISTS tax_overrides (
      id TEXT PRIMARY KEY,
      pack_version_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      field_name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_by_user_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS installed_print_templates (
      template_id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL,
      pack_version_id TEXT NOT NULL,
      country TEXT NOT NULL,
      jurisdiction TEXT NOT NULL,
      display_name TEXT NOT NULL,
      paper_widths_json TEXT NOT NULL,
      renderer_json TEXT NOT NULL,
      template_payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'installed',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tax_config_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      pack_id TEXT,
      pack_version_id TEXT,
      override_id TEXT,
      actor_user_id TEXT,
      details_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_country_pack_versions_pack ON country_pack_versions(pack_id);
    CREATE INDEX IF NOT EXISTS idx_tax_categories_pack_version ON tax_categories(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_rules_pack_version ON tax_rules(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_tax_overrides_pack_version ON tax_overrides(pack_version_id);
    CREATE INDEX IF NOT EXISTS idx_installed_print_templates_pack_version ON installed_print_templates(pack_version_id);
  `);
}

function createCloudSyncSchema(): void {
  getRawDatabase().exec(`
    CREATE TABLE IF NOT EXISTS cloud_sync_outbox (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT,
      entity_id TEXT,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      delivered_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cloud_sync_outbox_status
      ON cloud_sync_outbox(status, next_attempt_at, created_at);
    CREATE INDEX IF NOT EXISTS idx_cloud_sync_outbox_entity
      ON cloud_sync_outbox(entity_type, entity_id);
  `);
}

function createWhatsAppSchema(): void {
  getRawDatabase().exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER REFERENCES bills(id),
      customer_id TEXT REFERENCES customers(id),
      phone_e164 TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
      kind TEXT NOT NULL DEFAULT 'manual_reply'
        CHECK (kind IN ('bill_receipt','manual_reply','auto_followup','z_report')),
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','seen','typing','sent','delivered','read','failed')),
      body TEXT NOT NULL,
      external_message_id TEXT,
      error TEXT,
      queued_at TEXT DEFAULT CURRENT_TIMESTAMP,
      seen_at TEXT,
      typing_at TEXT,
      sent_at TEXT,
      delivered_at TEXT,
      read_at TEXT,
      failed_at TEXT,
      created_by_user_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone
      ON whatsapp_messages(phone_e164, queued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_status
      ON whatsapp_messages(status, queued_at DESC);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_bill
      ON whatsapp_messages(bill_id);
    CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_inbound_unread
      ON whatsapp_messages(direction, status, queued_at DESC)
      WHERE direction = 'inbound' AND status NOT IN ('read','failed');

    CREATE TABLE IF NOT EXISTS whatsapp_blocklist (
      phone_e164 TEXT PRIMARY KEY,
      reason TEXT,
      blocked_at TEXT DEFAULT CURRENT_TIMESTAMP,
      blocked_by_user_id TEXT
    );
  `);
}

function seedOfflineModeDefault(): void {
  // Rest&Cafe is local-only: offline mode defaults on for new installs.
  insertSettingIfMissing('offline_mode', 'true');
}

function seedWhatsAppDefaults(): void {
  insertSettingIfMissing('whatsapp_enabled', 'false');
  insertSettingIfMissing('whatsapp_activated_by_user_id', '');
  insertSettingIfMissing('whatsapp_activated_at', '');
  insertSettingIfMissing('whatsapp_disclosure_version_acknowledged', '');
  insertSettingIfMissing('whatsapp_connected_phone', '');
  insertSettingIfMissing('whatsapp_disclosure_version', '1');
  // Group chat filtering is enabled by default to prevent sending receipts to groups.
  insertSettingIfMissing('whatsapp_filter_groups', 'true');
  insertSettingIfMissing('receipt_logo', '');
  insertSettingIfMissing('receipt_logo_raster', '');
  insertSettingIfMissing('bill_show_logo', 'true');
}

function seedInstallDefaults(): void {
  const insert = (key: string, value: string) =>
    getRawDatabase()
      .prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
      .run(key, value);

  insert('business_name', 'Al Malaki Pizza & Café');
  insert('business_type', 'restaurant');
  // country/currency/currency_symbol/timezone are deliberately not seeded here:
  // they come only from the signup wizard (docs/reference/product-invariants.md,
  // "Regional settings come from signup, never from a fallback"). Until setup
  // completes, resolveRegionalSnapshot() throws RegionalNotConfiguredError
  // rather than a caller substituting a default country.
  insert('business_day_start_time', '00:00');
  // Shift enforcement ships default-off (#279, approach A): sales work with
  // no open session unless the owner opts in. Stale auto-close threshold in days.
  insert('require_open_shift', 'false');
  insert('stale_session_days', '7');
  insert('address', '');
  insert('phone', '');
  insert('email', '');
  insert('business_address', '');
  insert('business_phone', '');
  insert('instagram_handle', '');
  insert('receipt_logo', '');
  insert('receipt_logo_raster', '');
  insert('tax_registered', 'false');
  insert('tax_registration_number', '');
  insert('state_code', '');
  insert('tax_scheme', 'regular');
  insert('taxes_enabled', 'false');
  insert('billing_type', 'postpaid');
  insert('tables_required', 'true');
  insert('service_model', 'finedine');
  insert('setup_profile', '');
  // Unified charges & fees engine: JSON array of ChargeDefinition objects.
  // Validated only by the dedicated /settings/charges endpoints.
  insert('custom_charges', '[]');
  insert('anonymous_data_consent', 'false');
  insert('telemetry_enabled', 'false');
  insert(
    'telemetry_scope',
    'usage_stats,country,app_version,platform,session_duration,feature_usage,error_diagnostics',
  );
  insert('diagnostics_consent', 'false');
  insert('kds_enabled', 'true');
  insert('require_kitchen_delivered_before_settlement', 'false');
  insert('server_app_enabled', 'true');
  insert('kot_printing_enabled', 'true');
  insert('server_app_bill_printing_enabled', 'false');
  insert('printer_trim_decimals', 'false');
  insert('bill_template', 'classic');
  insert('bill_footer_message', '');
  insert('bill_show_logo', 'true');
  insert('bill_show_name', 'true');
  insert('bill_show_address', 'true');
  insert('bill_show_phone', 'true');
  insert('bill_show_tax_id', 'false');
  insert('bill_show_tax_breakdown', 'true');
  insert('bill_show_customer_name', 'true');
  insert('bill_show_customer_phone', 'true');
  insert('bill_delivery_show_customer_phone_always', 'true');
  insert('bill_show_table_number', 'true');
  insert('order_number_prefix', 'ORD');
  insert('order_number_include_date', 'true');
  insert('order_number_reset_daily', 'true');
  insert('invoice_number_prefix', 'INV');
  insert('invoice_number_include_period', 'true');
  insert('invoice_number_reset_period', 'daily');
  insert('invoice_financial_year_start_month', '4');
  insert('invoice_financial_year_start_day', '1');

  seedOfflineModeDefault();

  console.log('[DB] Install defaults loaded; first-run setup pending');
}
