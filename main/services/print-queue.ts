/**
 * Durable pending-print queue (F-009).
 *
 * A failed KOT or receipt print is recorded in `print_jobs` instead of
 * depending on a human noticing a toast, and a background worker retries
 * it with backoff until it succeeds or the attempt cap is reached.
 *
 * Printing stays post-commit and non-fatal to the sale: the queue only
 * ever re-runs a print that was already requested, and a retry re-reads
 * the order from the database, so it respects the F-004 printed marker —
 * items printed by an earlier attempt are never sent twice. A job that
 * finds nothing left to print completes as a no-op.
 *
 * Two executors share this table's contract: the backend worker below
 * (backend-attached printers) and the POS frontend queue (WebUSB, in
 * `frontend/src/lib/printer/print-queue.ts`), which retries through the
 * same print functions. Either side completing a job makes the other
 * side's retry a no-op via the marker.
 */
import { getDatabase, now, withTxn } from '../db';
import { printReceiptDetailed, type PrintResult } from '../printers/thermal';
import { markBillPrintedOnDispatch } from './receipt';
import { dispatchKotForOrder } from './kot-print';
import type { PrintWarning } from '../../shared/print/warnings';
import { getOrderWithItems } from '../routes/bills';
import { resolveBrandLogo } from '../branding';
import { getCountryByCode, getCurrencySymbol, resolveTenantCurrency } from '../countries';
import {
  BILL_LANGUAGE_POLICY_KEY,
  parseStoredLanguagePolicy,
} from '../lib/print-language-settings';
import {
  resolveReceiptLanguages,
  shouldShowCustomerNumber,
  type ReceiptLanguagePolicy,
} from '../../shared/print';

export type PrintJobKind = 'kot' | 'receipt';
export type PrintJobStatus = 'pending' | 'processing' | 'done' | 'failed';

/** Payload stored with a job; the worker re-reads the order, so the payload only scopes it. */
export interface PrintJobPayload {
  /** KOT: only these item ids are candidates (absent = all unprinted pending items). */
  itemIds?: number[];
  /** KOT: print for one station only. */
  stationName?: string;
  /** Receipt: this was a reprint. */
  isReprint?: boolean;
  useUnicode?: boolean;
  arabicShaping?: boolean;
}

export interface PrintJob {
  id: number;
  kind: PrintJobKind;
  order_id: number;
  bill_id: number | null;
  payload: PrintJobPayload;
  status: PrintJobStatus;
  attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueuePrintJobInput {
  kind: PrintJobKind;
  orderId: number;
  billId?: number;
  payload?: PrintJobPayload;
}

/** A job stops being retried after this many failed attempts; the row stays as the record. */
export const PRINT_JOB_MAX_ATTEMPTS = 10;

/** Backoff between attempts: 30s, 2m, 5m, 10m, then 15m. */
export function printJobRetryDelayMs(attempts: number): number {
  const delays = [30_000, 120_000, 300_000, 600_000, 900_000];
  return delays[Math.min(Math.max(attempts - 1, 0), delays.length - 1)];
}

/** SQLite CURRENT_TIMESTAMP format (`YYYY-MM-DD HH:MM:SS`, UTC), matching `now()`. */
export function toDbTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').replace(/\..*$/, '');
}

function parsePrintJob(row: {
  id: number;
  kind: string;
  order_id: number;
  bill_id: number | null;
  payload: string;
  status: string;
  attempts: number;
  next_retry_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}): PrintJob {
  let payload: PrintJobPayload = {};
  try {
    const parsed: unknown = JSON.parse(row.payload || '{}');
    if (parsed && typeof parsed === 'object') payload = parsed as PrintJobPayload;
  } catch {
    payload = {};
  }
  return {
    id: row.id,
    kind: row.kind as PrintJobKind,
    order_id: row.order_id,
    bill_id: row.bill_id,
    payload,
    status: row.status as PrintJobStatus,
    attempts: row.attempts,
    next_retry_at: row.next_retry_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Records a failed print for automatic retry. An identical job that is
 * already pending or processing is not duplicated: the first attempt's
 * retry covers it, and the F-004 marker makes a double execution a no-op.
 */
export function enqueuePrintJob(
  db: ReturnType<typeof getDatabase>,
  input: EnqueuePrintJobInput,
): { id: number; created: boolean } {
  const payloadJson = JSON.stringify(input.payload ?? {});
  const existing = db
    .prepare(
      `SELECT id FROM print_jobs
       WHERE kind = ? AND order_id = ? AND COALESCE(bill_id, -1) = ? AND payload = ?
         AND status IN ('pending', 'processing')
       ORDER BY id LIMIT 1`,
    )
    .get(input.kind, input.orderId, input.billId ?? -1, payloadJson) as { id: number } | undefined;
  if (existing) return { id: existing.id, created: false };
  const firstRetryAt = toDbTimestamp(new Date(Date.now() + printJobRetryDelayMs(1)));
  const result = db
    .prepare(
      `INSERT INTO print_jobs (kind, order_id, bill_id, payload, status, next_retry_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    )
    .run(input.kind, input.orderId, input.billId ?? null, payloadJson, firstRetryAt);
  return { id: Number(result.lastInsertRowid), created: true };
}

/**
 * Claims due jobs for one worker pass, marking them `processing` inside a
 * transaction so two workers (or a worker and a test) never execute the
 * same job twice.
 */
export function claimDuePrintJobs(
  db: ReturnType<typeof getDatabase>,
  limit = 10,
  nowStamp: string = now(),
): PrintJob[] {
  return withTxn(() => {
    const rows = db
      .prepare(
        `SELECT * FROM print_jobs
         WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY created_at ASC, id ASC LIMIT ?`,
      )
      .all(nowStamp, limit) as Parameters<typeof parsePrintJob>[0][];
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => '?').join(',');
    db.prepare(
      `UPDATE print_jobs SET status = 'processing', updated_at = ? WHERE id IN (${placeholders})`,
    ).run(nowStamp, ...rows.map((row) => row.id));
    return rows.map(parsePrintJob);
  });
}

export function completePrintJob(
  db: ReturnType<typeof getDatabase>,
  id: number,
  nowStamp: string = now(),
): void {
  db.prepare(`UPDATE print_jobs SET status = 'done', updated_at = ? WHERE id = ?`).run(
    nowStamp,
    id,
  );
}

/**
 * Records a failed attempt. The job goes back to `pending` with its next
 * retry time pushed out by the backoff, until the attempt cap is reached,
 * after which it stays `failed` as the record (the operator's manual
 * reprint still works; the marker keeps it from duplicating).
 */
export function failPrintJob(
  db: ReturnType<typeof getDatabase>,
  id: number,
  error: string,
  nowStamp: string = now(),
): void {
  const row = db.prepare('SELECT attempts FROM print_jobs WHERE id = ?').get(id) as
    | { attempts: number }
    | undefined;
  if (!row) return;
  const attempts = row.attempts + 1;
  if (attempts >= PRINT_JOB_MAX_ATTEMPTS) {
    db.prepare(
      `UPDATE print_jobs SET status = 'failed', attempts = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
    ).run(attempts, error, nowStamp, id);
    return;
  }
  const nextRetryAt = toDbTimestamp(new Date(Date.now() + printJobRetryDelayMs(attempts)));
  db.prepare(
    `UPDATE print_jobs SET status = 'pending', attempts = ?, last_error = ?,
       next_retry_at = ?, updated_at = ? WHERE id = ?`,
  ).run(attempts, error, nextRetryAt, nowStamp, id);
}

/** Tenant-configured language for print labels, defaulting to 'ar'. */
function tenantLanguageValue(db: ReturnType<typeof getDatabase>): string {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'language'").get() as
      | { value?: string }
      | undefined;
    return row?.value || 'ar';
  } catch {
    return 'ar';
  }
}

function tenantSettingValue(db: ReturnType<typeof getDatabase>, key: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    return row?.value;
  } catch {
    return undefined;
  }
}

/** Resolves primary and optional secondary receipt languages from tenant policy. */
export function resolveReceiptLanguagesForTenant(db: ReturnType<typeof getDatabase>): {
  primary: string;
  additional?: string;
} {
  const policy = parseStoredLanguagePolicy(
    BILL_LANGUAGE_POLICY_KEY,
    tenantSettingValue(db, BILL_LANGUAGE_POLICY_KEY),
  ) as ReceiptLanguagePolicy;
  const languages = resolveReceiptLanguages(policy, tenantLanguageValue(db));
  return languages.length > 1
    ? { primary: languages[0], additional: languages[1] }
    : { primary: languages[0] };
}

export interface ReceiptBusinessRow {
  id: number;
  customer_id?: unknown;
  [key: string]: unknown;
}

export interface ReceiptOrderRow {
  id: number;
  type?: unknown;
  [key: string]: unknown;
}

/** Builds the receipt `business` block from current settings, as the print-bill route does. */
export function buildReceiptBusiness(
  db: ReturnType<typeof getDatabase>,
  bill: ReceiptBusinessRow,
  order: ReceiptOrderRow,
): Record<string, unknown> {
  const settingsRows = db.prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const settings: Record<string, string> = Object.fromEntries(
    settingsRows.map((r) => [r.key, r.value]),
  );

  // Customer + loyalty context, only relevant when the bill is tied to a customer
  let customer: { name?: string; phone?: string; country_code?: string } | null = null;
  let pointsEarned = 0;
  let pointsRedeemed = 0;
  let pointsBalance: number | null = null;
  if (bill.customer_id) {
    customer = db
      .prepare('SELECT name, phone, country_code FROM customers WHERE id = ?')
      .get(bill.customer_id) as { name?: string; phone?: string; country_code?: string } | null;

    const earned = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE bill_id = ? AND type = 'credit'`,
      )
      .get(bill.id) as { total: number };
    pointsEarned = earned.total;

    const redeemed = db
      .prepare(
        `SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE bill_id = ? AND type = 'debit'`,
      )
      .get(bill.id) as { total: number };
    pointsRedeemed = redeemed.total;

    if (['true', '1'].includes(settings.loyalty_enabled || '')) {
      const credits = db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE customer_id = ? AND type = 'credit'`,
        )
        .get(bill.customer_id) as { total: number };
      const debits = db
        .prepare(
          `SELECT COALESCE(SUM(amount), 0) as total FROM loyalty_ledger WHERE customer_id = ? AND type = 'debit'`,
        )
        .get(bill.customer_id) as { total: number };
      pointsBalance = Math.max(0, credits.total - debits.total);
    }
  }

  const country = settings.country || '';
  const currency = resolveTenantCurrency(settings.currency, country);
  return {
    name: settings.business_name || '',
    address: settings.business_address || '',
    phone: settings.business_phone || '',
    taxRegistrationNumber: settings.tax_registration_number || '',
    currency,
    // Rest&Cafe: the currency unit is the owner's own setting (e.g. SP);
    // CLDR is only the fallback when no unit is stored.
    currency_symbol:
      settings.currency_symbol ||
      getCurrencySymbol(currency, getCountryByCode(country)?.locale) ||
      currency,
    country,
    instagram_handle: settings.instagram_handle || '',
    customer_name: customer?.name || '',
    customer_phone: customer?.phone
      ? customer.country_code && !customer.phone.startsWith(customer.country_code)
        ? `${customer.country_code} ${customer.phone}`
        : customer.phone
      : '',
    // One shared rule, so the receipt and the slip cannot disagree.
    show_customer_phone: shouldShowCustomerNumber({
      showOnReceipts: settings.bill_show_customer_phone !== 'false',
      alwaysForDeliveryOrders: settings.bill_delivery_show_customer_phone_always !== 'false',
      orderType: String(order?.type ?? ''),
    }),
    points_earned: pointsEarned,
    points_redeemed: pointsRedeemed,
    points_balance: pointsBalance,
    trim_decimals: settings.printer_trim_decimals === 'true',
    timezone: settings.timezone || '',
    show_name: settings.bill_show_name !== 'false',
    show_address: settings.bill_show_address !== 'false',
    show_phone: settings.bill_show_phone !== 'false',
    show_tax_id: settings.bill_show_tax_id === 'true',
    show_tax_breakdown: settings.bill_show_tax_breakdown !== 'false',
    show_customer_name: settings.bill_show_customer_name !== 'false',
    show_table_number: settings.bill_show_table_number !== 'false',
    show_logo: settings.bill_show_logo === 'true',
    receipt_logo: resolveBrandLogo(settings.receipt_logo),
    receipt_logo_raster: settings.receipt_logo_raster || '',
    footer_note: settings.bill_footer_message || '',
  };
}

export interface BillPrintDispatchOptions {
  bill: ReceiptBusinessRow;
  order: ReceiptOrderRow;
  isReprint?: boolean;
  useUnicode?: boolean;
  arabicShaping?: boolean;
  signal?: AbortSignal;
}

/**
 * Dispatches one receipt exactly as the print-bill route does, from the
 * bill and order rows the caller loaded. Does not touch `bills.printed_at`
 * itself: the caller records it only after this dispatch succeeds (F-026).
 */
export async function dispatchBillPrint(
  db: ReturnType<typeof getDatabase>,
  opts: BillPrintDispatchOptions,
): Promise<PrintResult> {
  const business = buildReceiptBusiness(db, opts.bill, opts.order);
  const languages = resolveReceiptLanguagesForTenant(db);
  const template = tenantSettingValue(db, 'bill_template') || 'classic';
  return printReceiptDetailed(
    opts.order,
    opts.bill,
    business,
    template,
    opts.useUnicode ?? false,
    opts.isReprint ?? false,
    opts.signal,
    opts.arabicShaping,
    languages.primary,
    languages.additional,
  );
}

export interface PrintJobDispatchers {
  dispatchKot?: typeof dispatchKotForOrder;
  dispatchBill?: typeof dispatchBillPrint;
}

/** Executes one claimed job against the current database state. */
export async function executePrintJob(
  db: ReturnType<typeof getDatabase>,
  job: PrintJob,
  dispatchers: PrintJobDispatchers = {},
): Promise<{ ok: boolean; detail?: string; warnings?: PrintWarning[] }> {
  if (job.kind === 'kot') {
    const dispatchKot = dispatchers.dispatchKot ?? dispatchKotForOrder;
    const result = await dispatchKot(db, {
      orderId: job.order_id,
      ...(job.payload.itemIds ? { itemIds: job.payload.itemIds } : {}),
      ...(job.payload.stationName ? { stationName: job.payload.stationName } : {}),
      ...(job.payload.useUnicode !== undefined ? { useUnicode: job.payload.useUnicode } : {}),
      ...(job.payload.arabicShaping !== undefined
        ? { arabicShaping: job.payload.arabicShaping }
        : {}),
    });
    if (result.ok) return { ok: true };
    return { ok: false, detail: result.failure?.detail || 'KOT print failed' };
  }

  if (!job.bill_id) return { ok: false, detail: 'Receipt job has no bill' };
  const bill = db.prepare('SELECT * FROM bills WHERE id = ?').get(job.bill_id) as
    | (ReceiptBusinessRow & { order_id: number })
    | undefined;
  if (!bill) return { ok: false, detail: 'Bill not found' };
  const order = getOrderWithItems(db, Number(bill.order_id), Number(bill.id));
  if (!order) return { ok: false, detail: 'Order not found' };
  const dispatchBill = dispatchers.dispatchBill ?? dispatchBillPrint;
  const result = await dispatchBill(db, {
    bill,
    order,
    ...(job.payload.isReprint !== undefined ? { isReprint: job.payload.isReprint } : {}),
    ...(job.payload.useUnicode !== undefined ? { useUnicode: job.payload.useUnicode } : {}),
    ...(job.payload.arabicShaping !== undefined
      ? { arabicShaping: job.payload.arabicShaping }
      : {}),
  });
  if (result.ok) return { ok: true, warnings: result.warnings };
  return { ok: false, detail: result.detail || 'Receipt print failed' };
}

/** Claims due jobs and executes them, completing or failing each one. */
export async function processDuePrintJobs(
  dispatchers: PrintJobDispatchers = {},
): Promise<{ processed: number; succeeded: number; failed: number }> {
  const db = getDatabase();
  const jobs = claimDuePrintJobs(db);
  let succeeded = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const result = await executePrintJob(db, job, dispatchers);
      if (result.ok) {
        completePrintJob(db, job.id);
        // The bytes moved: only now does the bill count as printed (F-026),
        // with any warnings the dispatch produced recorded with it (F-017).
        if (job.kind === 'receipt' && job.bill_id) {
          markBillPrintedOnDispatch(db, job.bill_id, result.warnings);
        }
        succeeded += 1;
      } else {
        failPrintJob(db, job.id, result.detail || 'Print failed');
        failed += 1;
      }
    } catch (error: unknown) {
      failPrintJob(db, job.id, error instanceof Error ? error.message : 'Print failed');
      failed += 1;
    }
  }
  return { processed: jobs.length, succeeded, failed };
}

const PRINT_QUEUE_INTERVAL_MS = 30_000;
const PRINT_QUEUE_STARTUP_DELAY_MS = 10_000;

/**
 * Background worker: retries due pending-print jobs every 30 seconds
 * (plus one pass shortly after startup, so a job queued before a restart
 * does not wait for the first tick). Single-flight; never throws out of
 * the timer; never keeps the process alive on its own.
 */
class PrintQueueService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private stopping = false;

  start(): void {
    this.stopping = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.runIfDue(), PRINT_QUEUE_INTERVAL_MS);
    this.timer.unref?.();
    this.startupTimer = setTimeout(() => void this.runIfDue(), PRINT_QUEUE_STARTUP_DELAY_MS);
    this.startupTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = null;
    this.startupTimer = null;
    await this.running?.catch(() => {});
  }

  runIfDue(): Promise<void> {
    if (this.running || this.stopping) return this.running ?? Promise.resolve();
    this.running = processDuePrintJobs()
      .then(() => undefined)
      .catch((error) => console.warn('[PrintQueue] Retry pass skipped:', error))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }
}

export const printQueue = new PrintQueueService();
