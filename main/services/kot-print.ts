/**
 * Kitchen ticket (KOT) dispatch shared by the print-kot API route and the
 * pending-print queue worker, so a ticket is rendered, routed, and marked
 * exactly once no matter which path sends it.
 *
 * F-004: every item carries a `kot_printed_at` marker. A dispatch only sends
 * items that are still pending AND unprinted, and marks each station group
 * the moment its dispatch reports success. A retry or manual reprint
 * therefore sends only items not yet printed; the append path's new-id
 * filter stays as the frontend's first line of defence.
 */
import { getDatabase, now, attachEffectiveAddons, parseItemJson } from '../db';
import { printKOTDetailed, type PrintResult } from '../printers/thermal';
import { isKotItemPending, resolveKotLanguage, type KotLanguagePolicy } from '../../shared/print';
import { KOT_LANGUAGE_POLICY_KEY, parseStoredLanguagePolicy } from '../lib/print-language-settings';
import type { PrintWarning } from '../printers/formatting-helpers';

// Hydrates order items with add-ons from normalized order_item_addons.
export function getEffectiveOrderItems(db: any, orderId: string): any[] {
  return attachEffectiveAddons(
    db,
    (db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId) as any[]).map(
      parseItemJson,
    ),
  );
}

// Routes items to kitchen stations by category, falling back to default kitchen.
export function routeItemsToStations(
  db: any,
  orderItems: any[],
): { stationName: string; printer: any; items: any[] }[] {
  const rawStations = db
    .prepare(
      `SELECT * FROM kitchen_stations WHERE is_active = 1 AND printer_id IS NOT NULL AND category_ids IS NOT NULL AND category_ids != ''`,
    )
    .all() as any[];

  const stations = rawStations
    .map((s) => {
      let categoryIds: string[] = [];
      try {
        categoryIds = JSON.parse(s.category_ids) || [];
      } catch {
        categoryIds = [];
      }
      const printer = db
        .prepare(
          `SELECT * FROM printers
         WHERE id = ? AND connection_type != 'webusb'`,
        )
        .get(s.printer_id);
      return { ...s, categoryIds, printer };
    })
    .filter((s) => s.categoryIds.length > 0 && s.printer);

  if (stations.length === 0) {
    return [{ stationName: 'Kitchen', printer: null, items: orderItems }];
  }

  const groups = new Map<string, { stationName: string; printer: any; items: any[] }>();
  const unrouted: any[] = [];

  for (const item of orderItems) {
    const product: any = item.product_id
      ? db.prepare('SELECT category_id FROM products WHERE id = ?').get(item.product_id)
      : null;
    const categoryId = product?.category_id;
    const matched = categoryId
      ? stations.find((s) => s.categoryIds.includes(categoryId))
      : undefined;
    if (matched) {
      if (!groups.has(matched.id)) {
        groups.set(matched.id, { stationName: matched.name, printer: matched.printer, items: [] });
      }
      groups.get(matched.id)!.items.push(item);
    } else {
      unrouted.push(item);
    }
  }

  const result = Array.from(groups.values());
  if (unrouted.length > 0) {
    result.push({ stationName: 'Kitchen', printer: null, items: unrouted });
  }
  return result;
}

/** Resolves kitchen ticket label language from tenant policy. */
export function resolveKotTicketLanguage(db: ReturnType<typeof getDatabase>): string {
  let stored: string | undefined;
  try {
    const row = db
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(KOT_LANGUAGE_POLICY_KEY) as { value?: string } | undefined;
    stored = row?.value;
  } catch {
    stored = undefined;
  }
  const policy = parseStoredLanguagePolicy(KOT_LANGUAGE_POLICY_KEY, stored) as KotLanguagePolicy;
  let language = 'ar';
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'language'").get() as
      | { value?: string }
      | undefined;
    language = row?.value || 'ar';
  } catch {
    language = 'ar';
  }
  return resolveKotLanguage(policy, language);
}

/** One order_items row as the KOT path reads it. */
export interface KotItemRow {
  id: number;
  status?: unknown;
  kot_printed_at?: string | null;
  product_id?: unknown;
  [key: string]: unknown;
}

/** One orders row as the KOT path reads it. */
export interface KotOrderRow {
  id: number;
  table_id?: unknown;
  customer_id?: unknown;
  table?: { name: string };
  customer?: { name: string };
  [key: string]: unknown;
}

/** Items of an order that a KOT dispatch may still send: pending and never printed. */
export function getUnprintedKotItems(
  db: ReturnType<typeof getDatabase>,
  orderId: number,
  itemIds?: number[],
): KotItemRow[] {
  const rows = getEffectiveOrderItems(db, String(orderId)) as KotItemRow[];
  const wanted = itemIds ? new Set(itemIds.map((id) => Number(id))) : null;
  return rows.filter(
    (item) =>
      isKotItemPending(item?.status) &&
      !item?.kot_printed_at &&
      (!wanted || wanted.has(Number(item?.id))),
  );
}

/** Ids of the items a KOT dispatch may still send for an order. */
export function getUnprintedKotItemIds(
  db: ReturnType<typeof getDatabase>,
  orderId: number,
  itemIds?: number[],
): number[] {
  return getUnprintedKotItems(db, orderId, itemIds).map((item) => Number(item?.id));
}

/**
 * Records a successful KOT dispatch for the given items of an order.
 * Only rows still unmarked are stamped, so the first print time stands and
 * a concurrent dispatch cannot overwrite it. Returns how many rows changed.
 */
export function markKotItemsPrinted(
  db: ReturnType<typeof getDatabase>,
  orderId: number,
  itemIds: number[],
): number {
  const ids = [...new Set(itemIds.map((id) => Number(id)).filter(Number.isSafeInteger))];
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const result = db
    .prepare(
      `UPDATE order_items SET kot_printed_at = ?
       WHERE order_id = ? AND kot_printed_at IS NULL AND id IN (${placeholders})`,
    )
    .run(now(), orderId, ...ids);
  return result.changes as number;
}

export interface KotDispatchOptions {
  orderId: number;
  /** When given, only these item ids are candidates (an empty list prints nothing). */
  itemIds?: number[];
  stationName?: string;
  useUnicode?: boolean;
  arabicShaping?: boolean;
  signal?: AbortSignal;
}

export interface KotDispatchResult {
  ok: boolean;
  printedItemIds: number[];
  failedItemIds: number[];
  candidateItemIds: number[];
  nothingToPrint: boolean;
  warnings: PrintWarning[];
  /** First failed group dispatch, when any group failed. */
  failure?: PrintResult | null;
}

/**
 * Sends one kitchen ticket per station for the order's still-unprinted
 * pending items, marking each station group printed only after its own
 * dispatch reports success. A group that fails leaves its items unmarked,
 * so a retry sends exactly those items again.
 */
export async function dispatchKotForOrder(
  db: ReturnType<typeof getDatabase>,
  opts: KotDispatchOptions,
): Promise<KotDispatchResult> {
  const empty: KotDispatchResult = {
    ok: false,
    printedItemIds: [],
    failedItemIds: [],
    candidateItemIds: [],
    nothingToPrint: false,
    warnings: [],
    failure: null,
  };
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(opts.orderId) as
    | KotOrderRow
    | undefined;
  if (!order) {
    return { ...empty, failure: { ok: false, detail: 'Order not found' } as PrintResult };
  }

  // Fetch table/customer info so backend KOT metadata matches the browser
  // and WebUSB paths.
  if (order.table_id) {
    const table = db.prepare('SELECT * FROM tables WHERE id = ?').get(order.table_id) as
      | { number: string }
      | undefined;
    if (table) {
      order.table = { name: table.number };
    }
  }
  if (order.customer_id) {
    const customer = db
      .prepare('SELECT name FROM customers WHERE id = ?')
      .get(order.customer_id) as { name: string } | null;
    if (customer) order.customer = { name: customer.name };
  }

  const candidates = getUnprintedKotItems(db, opts.orderId, opts.itemIds);
  const candidateItemIds = candidates.map((item) => Number(item?.id));
  if (candidates.length === 0) {
    return {
      ok: true,
      printedItemIds: [],
      failedItemIds: [],
      candidateItemIds,
      nothingToPrint: true,
      warnings: [],
      failure: null,
    };
  }

  const kotLanguage = resolveKotTicketLanguage(db);
  const useUnicode = opts.useUnicode ?? false;
  const printedItemIds: number[] = [];
  const failedItemIds: number[] = [];
  const warnings: PrintWarning[] = [];
  let failure: PrintResult | null = null;

  const dispatchGroup = async (
    items: KotItemRow[],
    stationName: string,
    printer: unknown,
  ): Promise<void> => {
    const result = await printKOTDetailed(
      order,
      items,
      stationName,
      useUnicode,
      printer || undefined,
      opts.signal,
      opts.arabicShaping,
      kotLanguage,
    );
    warnings.push(...(result.warnings || []));
    const groupIds = items.map((item) => Number(item?.id));
    if (result.ok) {
      markKotItemsPrinted(db, opts.orderId, groupIds);
      printedItemIds.push(...groupIds);
    } else {
      failedItemIds.push(...groupIds);
      if (!failure) failure = result;
    }
  };

  if (opts.stationName) {
    await dispatchGroup(candidates, opts.stationName || 'Kitchen', undefined);
  } else {
    const groups = routeItemsToStations(db, candidates).filter((g) => g.items.length > 0);
    for (const group of groups) {
      await dispatchGroup(group.items, group.stationName, group.printer || undefined);
    }
  }

  return {
    ok: failedItemIds.length === 0,
    printedItemIds,
    failedItemIds,
    candidateItemIds,
    nothingToPrint: false,
    warnings,
    failure,
  };
}
