/**
 * Local operation diagnostics.
 *
 * Records operation failures and diagnostic events into local SQLite tables
 * (local_diagnostics and diagnostics_hourly_aggregates) for the owner's
 * diagnostics screen. Nothing in this module leaves the device: there is no
 * delivery, no outbox flush, and no remote endpoint.
 */
import * as crypto from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { app } from 'electron';
import log from 'electron-log';
import { getDatabase, now, isDiagnosticsConsentEnabled, withDatabaseRequest } from '../db';
import {
  classClauseSummary,
  deriveDiagnosticSignature,
  errorClassOf,
} from '../lib/diagnostic-signature';
import { serializeOperationFailure } from '../lib/operation-failure';

export type DiagnosticEventInput = {
  event_id: string;
  event_code: string;
  severity: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  correlation_id?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
};

/** A locally captured failure, as the diagnostics screen and the copy-for-support bundle see it. */
export type LocalDiagnostic = {
  id: number;
  event_code: string;
  severity: string;
  error_class: string;
  signature: string;
  summary: string;
  metadata?: Record<string, unknown>;
  occurred_at: string;
  created_at: string;
};

/** Allowlist of event codes; built from this list, never filtered from a wider set afterwards. */
const DIAGNOSTIC_EVENT_CODES = [
  'order.place.failed',
  'order.place.rejected',
  'order.place.unreachable',
  'order.place.storage_unavailable',
  'order.create.failed',
  'payment.batch.failed',
  'server.internal_error',
  'print.receipt.failed',
  'print.kot.failed',
] as const;

type DiagnosticEventCode = (typeof DIAGNOSTIC_EVENT_CODES)[number];

export const ALLOWED_DIAGNOSTIC_EVENT_CODES = new Set<DiagnosticEventCode>([
  ...DIAGNOSTIC_EVENT_CODES,
]);

/** Upper bound on both the local failure log and the undelivered outbox. Oldest rows are evicted first. */
export const DIAGNOSTIC_LOG_MAX_ROWS = 200;

const ALLOWED_DIAGNOSTIC_SEVERITIES = new Set<DiagnosticEventInput['severity']>([
  'debug',
  'info',
  'warn',
  'error',
  'critical',
]);
const ALLOWED_ORDER_PLACE_STAGES = new Set(['order_place']);
const ALLOWED_ORDER_CREATE_STAGES = new Set(['inventory_validation', 'order_insert']);
const ALLOWED_PAYMENT_STAGES = new Set(['payment_batch']);
const ALLOWED_DIAGNOSTIC_METHODS = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'HEAD',
]);
const ALLOWED_PRINT_CONNECTION_TYPES = new Set(['network', 'usb', 'webusb', 'unknown']);
const ALLOWED_PRINT_KINDS = new Set(['receipt', 'kot']);
const ALLOWED_PRINT_FAILURE_CLASSES = new Set([
  'not_configured',
  'offline',
  'needs_attention',
  'queue_unavailable',
  'spooler_error',
  'driver_error',
  'permission_denied',
  'timeout',
  'write_error',
  'unsupported',
  'unknown',
]);
const ALLOWED_PRINT_PLATFORMS = new Set([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'linux',
  'openbsd',
  'win32',
]);
const DIAGNOSTIC_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function isAllowedDiagnosticEventCode(value: unknown): value is DiagnosticEventCode {
  return (
    typeof value === 'string' && ALLOWED_DIAGNOSTIC_EVENT_CODES.has(value as DiagnosticEventCode)
  );
}

function pickInteger(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
): void {
  if (
    typeof source[key] === 'number' &&
    Number.isSafeInteger(source[key]) &&
    source[key] >= min &&
    source[key] <= max
  )
    target[key] = source[key];
}

function pickEnum(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  allowed: Set<string>,
): void {
  if (typeof source[key] === 'string' && allowed.has(source[key])) target[key] = source[key];
}

function pickString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  maxLength: number,
): void {
  if (typeof source[key] === 'string' && source[key].length > 0)
    target[key] = source[key].slice(0, maxLength);
}

/** Projects diagnostic metadata to the small set of event-specific non-PII fields. */
function sanitizeDiagnosticMetadata(
  eventCode: DiagnosticEventCode,
  metadata: unknown,
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const source = metadata as Record<string, unknown>;
  const target: Record<string, unknown> = {};

  if (eventCode.startsWith('order.place.')) {
    pickEnum(source, target, 'stage', ALLOWED_ORDER_PLACE_STAGES);
    pickInteger(source, target, 'status', 100, 599);
  } else if (eventCode === 'order.create.failed') {
    pickEnum(source, target, 'stage', ALLOWED_ORDER_CREATE_STAGES);
    pickInteger(source, target, 'status', 100, 599);
    pickInteger(source, target, 'item_count', 0, 10_000);
  } else if (eventCode === 'payment.batch.failed') {
    pickEnum(source, target, 'stage', ALLOWED_PAYMENT_STAGES);
    pickInteger(source, target, 'status', 100, 599);
  } else if (eventCode === 'server.internal_error') {
    pickString(source, target, 'route', 200);
    pickEnum(source, target, 'method', ALLOWED_DIAGNOSTIC_METHODS);
    pickInteger(source, target, 'status', 500, 599);
  } else {
    pickEnum(source, target, 'connection_type', ALLOWED_PRINT_CONNECTION_TYPES);
    pickEnum(source, target, 'kind', ALLOWED_PRINT_KINDS);
    pickEnum(source, target, 'failure_class', ALLOWED_PRINT_FAILURE_CLASSES);
    pickEnum(source, target, 'os_platform', ALLOWED_PRINT_PLATFORMS);
    pickInteger(source, target, 'platform_error_code', -1_000_000, 1_000_000);
    pickInteger(source, target, 'job_id', 1, Number.MAX_SAFE_INTEGER);
    pickInteger(source, target, 'printer_status', 0, Number.MAX_SAFE_INTEGER);
  }
  return Object.keys(target).length > 0 ? target : undefined;
}

const PRINT_FAILURE_REASON: Record<string, string> = {
  not_configured: 'No printer is configured',
  offline: 'The printer was offline or disconnected',
  needs_attention: 'The printer needs attention - check its paper, cover and consumables',
  queue_unavailable: 'The print queue was not accepting jobs',
  spooler_error: 'The print spooler rejected the job',
  driver_error: 'The printer driver failed',
  permission_denied: 'Access to the printer was denied',
  timeout: 'The printer did not respond in time',
  write_error: 'The printer failed while writing the job',
  unsupported: 'This print is not supported on the current setup',
};

/**
 * The line an operator reads when the template has nothing real in it, rebuilt
 * from the projected metadata. A class with no reason falls back to the clause.
 */
function describeDiagnosticFailure(
  eventCode: DiagnosticEventCode,
  metadata: Record<string, unknown> | undefined,
  errorClass: string,
): string {
  const failureClass = metadata?.failure_class;
  const reason =
    eventCode.startsWith('print.') && typeof failureClass === 'string'
      ? PRINT_FAILURE_REASON[failureClass]
      : undefined;
  return reason ? `${reason}.` : classClauseSummary(errorClass);
}

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function recordLocalDiagnostic(
  db: BetterSqlite3.Database,
  entry: Omit<LocalDiagnostic, 'id' | 'created_at'>,
  timestamp: string,
): void {
  db.prepare(`
    INSERT INTO local_diagnostics
      (event_code, severity, error_class, signature, summary, metadata_json, occurred_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.event_code,
    entry.severity,
    entry.error_class,
    entry.signature,
    entry.summary,
    entry.metadata ? JSON.stringify(entry.metadata) : null,
    entry.occurred_at,
    timestamp,
  );
  // No delivery state here, so oldest-first is the only sensible eviction.
  const overflow =
    (db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as { count: number })
      .count - DIAGNOSTIC_LOG_MAX_ROWS;
  if (overflow > 0) addDiagnosticsDeliveryGap(db, 'local_retention', overflow);
  evictOldestDiagnostics(db, 'local_diagnostics', DIAGNOSTIC_LOG_MAX_ROWS);
}

// Enforced on write, not on read, so neither log can grow between reads. `rowid`
// is insertion order on both tables; the outbox's `event_id` key is not a rowid alias.
function evictOldestDiagnostics(
  db: BetterSqlite3.Database,
  table: 'local_diagnostics' | 'store_diagnostics_outbox',
  max: number,
): void {
  db.prepare(
    `DELETE FROM ${table} WHERE rowid NOT IN (SELECT rowid FROM ${table} ORDER BY rowid DESC LIMIT ?)`,
  ).run(max);
}

// Evicts resolved rows first, then oldest undelivered rows.
const DIAGNOSTICS_GAP_REASONS = [
  'queue_eviction',
  'permanent_rejection',
  'invalid_ack',
  'report_id_mismatch',
  'local_retention',
] as const;
type DiagnosticsGapReason = (typeof DIAGNOSTICS_GAP_REASONS)[number];

function addDiagnosticsDeliveryGap(
  db: BetterSqlite3.Database,
  reason: DiagnosticsGapReason,
  count: number,
): void {
  if (!Number.isSafeInteger(count) || count <= 0) return;
  const timestamp = diagnosticUtcTimestamp();
  db.prepare(`
    INSERT INTO diagnostics_delivery_gaps (reason_code, count, first_occurred_at, last_occurred_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(reason_code) DO UPDATE SET count = count + excluded.count,
      last_occurred_at = excluded.last_occurred_at, updated_at = excluded.updated_at
  `).run(reason, count, timestamp, timestamp, now());
}

function canonicalDiagnosticFacts(
  facts: Record<string, number | string>,
): Record<string, number | string> {
  return Object.fromEntries(
    Object.entries(facts).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function diagnosticOccurrenceTime(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64) return diagnosticUtcTimestamp();
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp > Date.now() + 86_400_000 ||
    timestamp < Date.now() - 365 * 86_400_000
  ) {
    return diagnosticUtcTimestamp();
  }
  return diagnosticUtcTimestamp(timestamp);
}

function diagnosticUtcTimestamp(timestamp = Date.now()): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function diagnosticWindowStart(occurredAt: string): string {
  const date = new Date(occurredAt);
  date.setUTCMinutes(0, 0, 0);
  return diagnosticUtcTimestamp(date.getTime());
}

function diagnosticBuildIdentity(): string {
  try {
    const value = require('./build-identity').getBuildIdentity() as unknown;
    return typeof value === 'string' && /^[A-Za-z0-9._:+-]{1,64}$/.test(value) ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

function diagnosticAppVersion(): string {
  try {
    const value = app.getVersion();
    return /^[A-Za-z0-9._:+-]{1,64}$/.test(value) ? value : 'unknown';
  } catch {
    return 'unknown';
  }
}

function safeParseMetadata(json: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export class OperationDiagnosticsService {
  private backgroundPromises = new Set<Promise<unknown>>();
  private shutdownController = new AbortController();
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | null = null;

  private async waitForBackgroundWork(): Promise<void> {
    while (this.backgroundPromises.size > 0) {
      await Promise.allSettled([...this.backgroundPromises]);
    }
  }

  private withDatabaseRequest<T>(
    operation: () => T | Promise<T>,
    requestSignal?: AbortSignal,
  ): Promise<T> {
    const signal = requestSignal
      ? AbortSignal.any([this.shutdownController.signal, requestSignal])
      : this.shutdownController.signal;
    return withDatabaseRequest(operation, signal);
  }

  private runBackground<T>(
    operation: Promise<T>,
    label: string,
    onError?: (error: unknown) => void,
  ): void {
    const tracked = operation.catch((error) => {
      if (this.shutdownRequested || (error as { code?: unknown })?.code === 'ERR_SHUTDOWN_ABORTED')
        return;
      try {
        if (onError) {
          onError(error);
        } else {
          log.warn(`[Diagnostics] ${label} failed`, (error as Error).message);
        }
      } catch (callbackError) {
        log.warn(
          `[Diagnostics] ${label} failure handling failed`,
          (callbackError as Error).message,
        );
      }
    });
    this.backgroundPromises.add(tracked);
    void tracked.finally(() => this.backgroundPromises.delete(tracked));
  }

  private markError(message: string) {
    if (this.shutdownRequested) return;
    log.warn('[Diagnostics]', message);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownRequested = true;
    this.shutdownController.abort();
    this.shutdownPromise = this.waitForBackgroundWork().then(() => undefined);
    return this.shutdownPromise;
  }

  reportDiagnostic(input: DiagnosticEventInput, error?: unknown): void {
    if (this.shutdownRequested) return;
    if (!isAllowedDiagnosticEventCode(input.event_code)) return;
    if (!ALLOWED_DIAGNOSTIC_SEVERITIES.has(input.severity)) return;
    if (typeof input.event_id !== 'string' || !DIAGNOSTIC_ID_RE.test(input.event_id)) return;
    const metadata = sanitizeDiagnosticMetadata(input.event_code, input.metadata);
    // A handler that catches a non-Error throw has no `.message`; the thrown value
    // itself is then the only text there is, and a string throw is the message.
    const thrown =
      error === undefined || error === null
        ? input.message
        : typeof error === 'string'
          ? error
          : typeof (error as { message?: unknown }).message === 'string'
            ? (error as { message: string }).message
            : input.message;
    const derived = deriveDiagnosticSignature(
      error ? { errorClass: errorClassOf(error), message: thrown } : { message: thrown },
    );
    const summary = derived.is_informative
      ? derived.summary
      : describeDiagnosticFailure(input.event_code, metadata, derived.error_class);
    const sanitized: DiagnosticEventInput = {
      event_id: input.event_id,
      event_code: input.event_code,
      severity: input.severity,
      message: derived.signature,
      ...(typeof input.correlation_id === 'string' && DIAGNOSTIC_ID_RE.test(input.correlation_id)
        ? { correlation_id: input.correlation_id }
        : {}),
      ...(metadata ? { metadata } : {}),
      occurred_at:
        typeof input.occurred_at === 'string' && input.occurred_at.length <= 64
          ? input.occurred_at
          : new Date().toISOString(),
    };
    this.runBackground(
      this.withDatabaseRequest(() => {
        if (this.shutdownRequested) return;
        const db = getDatabase();
        const timestamp = now();
        recordLocalDiagnostic(
          db,
          {
            event_code: sanitized.event_code,
            severity: sanitized.severity,
            error_class: derived.error_class,
            signature: derived.signature,
            summary,
            metadata,
            occurred_at: sanitized.occurred_at,
          },
          timestamp,
        );
      }),
      'diagnostic enqueue',
      (enqueueError) => this.markError((enqueueError as Error).message),
    );
  }

  captureOperationFailure(input: {
    capture_point: unknown;
    outcome: unknown;
    correlation_id?: unknown;
    facts?: unknown;
    occurred_at?: unknown;
  }): void {
    if (this.shutdownRequested) return;
    const failure = serializeOperationFailure(input);
    if (!failure) return;
    const occurredAt = diagnosticOccurrenceTime(input.occurred_at);
    const windowStart = diagnosticWindowStart(occurredAt);
    const appVersion = diagnosticAppVersion();
    const appBuild = diagnosticBuildIdentity();
    const platform = ['win32', 'darwin', 'linux'].includes(process.platform)
      ? process.platform
      : 'unknown';
    const facts = canonicalDiagnosticFacts(failure.facts);
    const aggregateKey = sha256Hex(
      JSON.stringify([
        failure.operation,
        failure.stage,
        failure.reason_code,
        failure.capture_point,
        failure.outcome,
        windowStart,
        appVersion,
        appBuild,
        platform,
        facts,
      ]),
    );
    const timestamp = now();

    this.runBackground(
      this.withDatabaseRequest(() => {
        if (this.shutdownRequested) return;
        const db = getDatabase();
        const safeMetadata = {
          capture_point: failure.capture_point,
          operation: failure.operation,
          stage: failure.stage,
          reason_code: failure.reason_code,
          classification: failure.classification,
          outcome: failure.outcome,
          ...(failure.correlation_id ? { correlation_id: failure.correlation_id } : {}),
          ...facts,
        };
        const displaySummary = `${failure.operation} failed during ${failure.stage} (${failure.reason_code}).`;
        const transaction = db.transaction(() => {
          recordLocalDiagnostic(
            db,
            {
              event_code: failure.reason_code,
              severity: failure.classification === 'expected_rejection' ? 'warn' : 'error',
              error_class: failure.classification,
              signature: `${failure.operation}:${failure.stage}:${failure.reason_code}`,
              summary: displaySummary,
              metadata: safeMetadata,
              occurred_at: occurredAt,
            },
            timestamp,
          );

          const existing = db
            .prepare('SELECT * FROM diagnostics_hourly_aggregates WHERE aggregate_key = ?')
            .get(aggregateKey) as
            | {
                count: number;
                first_occurred_at: string;
                last_occurred_at: string;
                examples_json: string;
              }
            | undefined;
          if (existing) {
            if (
              !Number.isSafeInteger(existing.count) ||
              existing.count >= Number.MAX_SAFE_INTEGER
            ) {
              addDiagnosticsDeliveryGap(db, 'local_retention', 1);
              return;
            }
            let examples: string[] = [];
            try {
              const parsed = JSON.parse(existing.examples_json);
              if (Array.isArray(parsed))
                examples = parsed
                  .filter(
                    (item) =>
                      typeof item === 'string' &&
                      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                        item,
                      ),
                  )
                  .slice(0, 3);
            } catch {
              /* keep the bounded example list empty */
            }
            if (
              failure.correlation_id &&
              !examples.includes(failure.correlation_id) &&
              examples.length < 3
            )
              examples.push(failure.correlation_id);
            db.prepare(`UPDATE diagnostics_hourly_aggregates
            SET count = count + 1, first_occurred_at = MIN(first_occurred_at, ?),
                last_occurred_at = MAX(last_occurred_at, ?), examples_json = ?, updated_at = ?
            WHERE aggregate_key = ?`).run(
              occurredAt,
              occurredAt,
              JSON.stringify(examples),
              timestamp,
              aggregateKey,
            );
            return;
          }

          const aggregateCount = (
            db.prepare('SELECT COUNT(*) AS count FROM diagnostics_hourly_aggregates').get() as {
              count: number;
            }
          ).count;
          if (aggregateCount >= DIAGNOSTIC_LOG_MAX_ROWS) {
            addDiagnosticsDeliveryGap(db, 'local_retention', 1);
            return;
          }
          db.prepare(`INSERT INTO diagnostics_hourly_aggregates (
          aggregate_key, capture_point, reason_code, classification, operation, stage, outcome,
          window_start, count, first_occurred_at, last_occurred_at, app_version, app_build, platform,
          examples_json, facts_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            aggregateKey,
            failure.capture_point,
            failure.reason_code,
            failure.classification,
            failure.operation,
            failure.stage,
            failure.outcome,
            windowStart,
            occurredAt,
            occurredAt,
            appVersion,
            appBuild,
            platform,
            JSON.stringify(failure.correlation_id ? [failure.correlation_id] : []),
            JSON.stringify(facts),
            timestamp,
          );
        });
        transaction();
      }),
      'diagnostic capture',
      (captureError) => this.markError((captureError as Error).message),
    );
  }

  /** Safe counts for the diagnostics screen; everything is local by construction. */
  listDiagnosticDeliveryHealth(): {
    effective_consent: boolean;
    transmission_enabled: boolean;
    consent_sync_pending: boolean;
    delayed: boolean;
    transport: 'signed' | 'anonymous' | 'local' | 'disabled';
    pending_reports: number;
    pending_occurrences: number;
    pending_aggregates: number;
    pending_aggregate_occurrences: number;
    permanently_rejected_reports: number;
    gaps: Array<{ reason_code: DiagnosticsGapReason; count: number }>;
  } {
    const db = getDatabase();
    const pendingAggregate = db
      .prepare(
        'SELECT COUNT(*) AS count, COALESCE(SUM(count), 0) AS occurrences FROM diagnostics_hourly_aggregates',
      )
      .get() as { count: number; occurrences: number };
    const gaps = db
      .prepare(
        'SELECT reason_code, count FROM diagnostics_delivery_gaps WHERE count > 0 ORDER BY reason_code',
      )
      .all() as Array<{ reason_code: DiagnosticsGapReason; count: number }>;
    const effectiveConsent = isDiagnosticsConsentEnabled();
    return {
      effective_consent: effectiveConsent,
      transmission_enabled: false,
      consent_sync_pending: false,
      delayed: effectiveConsent && (pendingAggregate.count > 0 || gaps.length > 0),
      transport: effectiveConsent ? 'local' : 'disabled',
      pending_reports: 0,
      pending_occurrences: 0,
      pending_aggregates: pendingAggregate.count,
      pending_aggregate_occurrences: pendingAggregate.occurrences,
      permanently_rejected_reports: 0,
      gaps,
    };
  }

  listLocalDiagnostics(limit = 50): LocalDiagnostic[] {
    const db = getDatabase();
    const bounded =
      Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, DIAGNOSTIC_LOG_MAX_ROWS) : 50;
    const rows = db
      .prepare(`
      SELECT id, event_code, severity, error_class, signature, summary, metadata_json, occurred_at, created_at
        FROM local_diagnostics ORDER BY id DESC LIMIT ?
    `)
      .all(bounded) as Array<{
      id: number;
      event_code: string;
      severity: string;
      error_class: string;
      signature: string;
      summary: string;
      metadata_json: string | null;
      occurred_at: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      event_code: row.event_code,
      severity: row.severity,
      error_class: row.error_class,
      signature: row.signature,
      summary: row.summary,
      metadata: row.metadata_json ? safeParseMetadata(row.metadata_json) : undefined,
      occurred_at: row.occurred_at,
      created_at: row.created_at,
    }));
  }

  /** Remove every locally captured failure. Nothing has been transmitted, so nothing is withdrawn. */
  clearLocalDiagnostics(): number {
    const db = getDatabase();
    const removed = db.prepare('SELECT COUNT(*) AS count FROM local_diagnostics').get() as {
      count: number;
    };
    db.prepare('DELETE FROM local_diagnostics').run();
    return removed?.count || 0;
  }
}

export const operationDiagnostics = new OperationDiagnosticsService();
