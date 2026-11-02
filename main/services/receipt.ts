/**
 * Print confirmation records (F-017, F-026).
 *
 * `bills.printed_at` means confirmed dispatch, never a print request: it is
 * set only here, by the party that dispatched the bytes — the frontend
 * confirmation endpoint after a successful WebUSB/browser/server print, or
 * the durable print queue after a retry dispatch succeeds. A non-financial
 * line the printer could not represent is recorded with the bill in
 * `bill_print_warnings` (operator-visible after the fact) instead of
 * vanishing with only a toast.
 */

import { getDatabase, withTxn, now } from '../db';
import type { PrintWarning } from '../../shared/print/warnings';

export type PrintType = 'receipt' | 'reprint';

export type PrintWarningSource = 'frontend' | 'server' | 'queue' | 'operator';

export interface StoredPrintWarning {
  id: number;
  bill_id: number;
  print_log_id: number | null;
  field: string;
  text: string;
  message: string;
  kind: string;
  source: string;
  created_at: string;
}

/** Keep only the warning fields the record stores, dropping anything else. */
export function sanitizePrintWarnings(
  warnings: readonly unknown[] | undefined | null,
): Array<{ field: string; text: string; message: string; kind: string }> {
  if (!Array.isArray(warnings)) return [];
  const kinds = new Set(['line', 'financial', 'configuration', 'locale']);
  const cleaned: Array<{ field: string; text: string; message: string; kind: string }> = [];
  for (const warning of warnings.slice(0, 50)) {
    if (!warning || typeof warning !== 'object') continue;
    const record = warning as Partial<PrintWarning> & { kind?: unknown };
    const field = typeof record.field === 'string' ? record.field.slice(0, 200) : '';
    const text = typeof record.text === 'string' ? record.text.slice(0, 500) : '';
    const message = typeof record.message === 'string' ? record.message.slice(0, 1000) : '';
    if (!field && !text && !message) continue;
    cleaned.push({
      field,
      text,
      message,
      kind: typeof record.kind === 'string' && kinds.has(record.kind) ? record.kind : 'line',
    });
  }
  return cleaned;
}

/** Insert sanitized warnings for a bill; no-op when there are none. */
export function recordBillPrintWarnings(
  db: ReturnType<typeof getDatabase>,
  billId: number,
  warnings: readonly unknown[] | undefined | null,
  source: PrintWarningSource,
  printLogId: number | null,
): void {
  for (const warning of sanitizePrintWarnings(warnings)) {
    db.prepare(
      `INSERT INTO bill_print_warnings
         (bill_id, print_log_id, field, text, message, kind, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(billId, printLogId, warning.field, warning.text, warning.message, warning.kind, source);
  }
}

/** Warnings recorded with a bill, oldest first. */
export function getBillPrintWarnings(
  db: ReturnType<typeof getDatabase>,
  billId: number,
): StoredPrintWarning[] {
  return db
    .prepare(`SELECT * FROM bill_print_warnings WHERE bill_id = ? ORDER BY id ASC`)
    .all(billId) as StoredPrintWarning[];
}

/**
 * Record a confirmed print: a print_logs row, the bill's printed_at, and any
 * warnings the dispatch produced. Called only after the bytes were confirmed
 * dispatched — never on a print request.
 */
export function recordPrintConfirmation(
  billId: number,
  userId: string,
  printType: PrintType,
  warnings?: readonly unknown[] | null,
): { success: boolean; printLogId?: number } {
  const db = getDatabase();

  const result = withTxn(() => {
    const bill = db.prepare('SELECT id FROM bills WHERE id = ?').get(billId) as
      | { id: number }
      | undefined;
    if (!bill) {
      throw new Error('Bill not found');
    }

    const insertResult = db
      .prepare(
        'INSERT INTO print_logs (bill_id, user_id, print_type, printed_at) VALUES (?, ?, ?, ?)',
      )
      .run(billId, userId, printType, now());
    const printLogId = insertResult.lastInsertRowid as number;

    db.prepare('UPDATE bills SET printed_at = ?, updated_at = ? WHERE id = ?').run(
      now(),
      now(),
      billId,
    );
    recordBillPrintWarnings(db, billId, warnings, 'frontend', printLogId);

    return insertResult;
  });

  return { success: true, printLogId: result.lastInsertRowid as number };
}

/**
 * Mark a bill printed after a server-side dispatch the queue worker confirmed
 * (F-026): no authenticated user and no print_logs row exist on that path, so
 * only printed_at and the dispatch warnings are recorded.
 */
export function markBillPrintedOnDispatch(
  db: ReturnType<typeof getDatabase>,
  billId: number,
  warnings?: readonly unknown[] | null,
): void {
  withTxn(() => {
    const bill = db.prepare('SELECT id FROM bills WHERE id = ?').get(billId) as
      | { id: number }
      | undefined;
    if (!bill) return;
    db.prepare('UPDATE bills SET printed_at = ?, updated_at = ? WHERE id = ?').run(
      now(),
      now(),
      billId,
    );
    recordBillPrintWarnings(db, billId, warnings, 'queue', null);
  });
}
