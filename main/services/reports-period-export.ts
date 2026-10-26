import ExcelJS from 'exceljs';
import { toCsvRow } from '../lib/csv';
import { localDateInTimezone, parseDbTimestamp } from '../db';

/**
 * Period report datasets + serializers for the Reports section (W4).
 *
 * Ledger-only rule (Phase 1 definitions): every figure here is computed from
 * bills / orders / order_items / cash_sessions / cash_closures — the same rows
 * the JSON breakdown endpoints return, so screen, API and export cannot drift.
 * Money is recognized at payment time (bills.paid_at) for collected totals;
 * product/category/hour breakdowns follow order creation time, mirroring the
 * existing GET /reports/sales + /reports/topProducts conventions.
 */

type Db = ReturnType<typeof import('../db').getDatabase>;

export interface SalesBreakdownDataset {
  startDate: string;
  endDate: string;
  totals: {
    ordersCount: number;
    ordersTotal: number;
    collected: number;
    taxCollected: number;
    discounts: number;
    serviceCharges: number;
  };
  byProduct: { product_id: string; product_name: string; quantity: number; total: number }[];
  byCategory: { category_name: string; quantity: number; total: number }[];
  byOrderType: { type: string; count: number; total: number }[];
  byHour: { hour: number; count: number; total: number }[];
}

export interface CashSummaryDataset {
  startDate: string;
  endDate: string;
  sessions: {
    id: number;
    opened_by_name: string;
    opened_at: string;
    closed_at: string | null;
    status: string;
    opening_float: number;
    expected_cash: number | null;
    counted_cash: number | null;
    variance: number | null;
  }[];
  closures: {
    id: number;
    z_number: number | null;
    business_date: string;
    scope: string;
    opening_float: number;
    expected_cash: number;
    counted_cash: number;
    variance: number;
    gross_collected: number;
    refunded: number;
    net_collected: number;
    bill_count: number;
    created_at: string;
  }[];
}

const ITEM_ACTIVE = "COALESCE(oi.status, 'active') NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded')";

export function buildSalesBreakdown(
  db: Db,
  opts: { startDate: string; endDate: string; windowStart: string; windowEnd: string; timeZone: string; startTime: string; minorFactor: number },
): SalesBreakdownDataset {
  const { windowStart, windowEnd } = opts;

  const totalsRow = db
    .prepare(
      `SELECT COUNT(*) AS orders_count, COALESCE(SUM(total), 0) AS orders_total,
              COALESCE(SUM(tax_amount), 0) AS tax_collected,
              COALESCE(SUM(discount_amount), 0) AS discounts,
              COALESCE(SUM(service_charge), 0) AS service_charges
       FROM orders
       WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'`,
    )
    .get(windowStart, windowEnd) as any;

  const collectedRow = db
    .prepare(
      `SELECT COALESCE(SUM(b.paid_amount), 0) AS collected
       FROM bills b JOIN orders o ON o.id = b.order_id
       WHERE b.paid_at >= ? AND b.paid_at < ? AND o.status != 'cancelled'`,
    )
    .get(windowStart, windowEnd) as any;

  const byProduct = db
    .prepare(
      `SELECT oi.product_id, oi.product_name,
              COALESCE(SUM(oi.quantity), 0) AS quantity,
              COALESCE(SUM(oi.subtotal), 0) AS total
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelled' AND ${ITEM_ACTIVE}
       GROUP BY oi.product_id, oi.product_name
       ORDER BY total DESC`,
    )
    .all(windowStart, windowEnd) as any[];

  const byCategory = db
    .prepare(
      `SELECT COALESCE(c.name, '') AS category_name,
              COALESCE(SUM(oi.quantity), 0) AS quantity,
              COALESCE(SUM(oi.subtotal), 0) AS total
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
       LEFT JOIN categories c ON c.id = p.category_id
       WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelled' AND ${ITEM_ACTIVE}
       GROUP BY category_name
       ORDER BY total DESC`,
    )
    .all(windowStart, windowEnd) as any[];

  const byOrderType = db
    .prepare(
      `SELECT type, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
       FROM orders
       WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'
       GROUP BY type ORDER BY total DESC`,
    )
    .all(windowStart, windowEnd) as any[];

  // Hour buckets in tenant-local time (SQLite has no IANA tz support) — same
  // approach as reports.ts bucketByLocalHourAndWeekday.
  const orderRows = db
    .prepare(
      `SELECT created_at, total FROM orders
       WHERE created_at >= ? AND created_at < ? AND status != 'cancelled'`,
    )
    .all(windowStart, windowEnd) as { created_at: string; total: number }[];
  const hourFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: opts.timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
  });
  const byHourMap = new Map<number, { count: number; total: number }>();
  for (const row of orderRows) {
    const d = parseDbTimestamp(row.created_at);
    if (isNaN(d.getTime())) continue;
    // Business-day shifted hour: bucket by the local clock of the business
    // date the order belongs to (startTime only shifts the date, hours stay
    // wall-clock — matches the insights bucketing idiom).
    void localDateInTimezone(d, opts.timeZone, opts.startTime);
    const hour = parseInt(hourFmt.format(d), 10);
    if (hour < 0 || hour > 23) continue;
    const bucket = byHourMap.get(hour) || { count: 0, total: 0 };
    bucket.count += 1;
    bucket.total += Number(row.total || 0);
    byHourMap.set(hour, bucket);
  }
  const byHour = [...byHourMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, v]) => ({ hour, count: v.count, total: v.total }));

  return {
    startDate: opts.startDate,
    endDate: opts.endDate,
    totals: {
      ordersCount: Number(totalsRow.orders_count || 0),
      ordersTotal: Number(totalsRow.orders_total || 0),
      collected: Number(collectedRow.collected || 0),
      taxCollected: Number(totalsRow.tax_collected || 0),
      discounts: Number(totalsRow.discounts || 0),
      serviceCharges: Number(totalsRow.service_charges || 0),
    },
    byProduct: byProduct.map((r) => ({
      product_id: String(r.product_id),
      product_name: String(r.product_name),
      quantity: Number(r.quantity || 0),
      total: Number(r.total || 0),
    })),
    byCategory: byCategory.map((r) => ({
      category_name: String(r.category_name || ''),
      quantity: Number(r.quantity || 0),
      total: Number(r.total || 0),
    })),
    byOrderType: byOrderType.map((r) => ({
      type: String(r.type),
      count: Number(r.count || 0),
      total: Number(r.total || 0),
    })),
    byHour,
  };
}

export function buildCashSummary(
  db: Db,
  opts: { startDate: string; endDate: string; windowStart: string; windowEnd: string; minorFactor: number },
): CashSummaryDataset {
  const { windowStart, windowEnd, minorFactor } = opts;

  const sessionRows = db
    .prepare(
      `SELECT s.id, s.opened_by_name, s.opened_at, s.closed_at, s.status,
              s.opening_float_cents,
              cl.expected_cash_cents, cl.counted_cash_cents, cl.variance_cents
       FROM cash_sessions s
       LEFT JOIN cash_closures cl ON cl.id = s.closure_id
       WHERE s.opened_at >= ? AND s.opened_at < ?
       ORDER BY s.opened_at DESC`,
    )
    .all(windowStart, windowEnd) as any[];

  const closureRows = db
    .prepare(
      `SELECT * FROM cash_closures
       WHERE business_date >= ? AND business_date <= ?
       ORDER BY business_date DESC, id DESC`,
    )
    .all(opts.startDate, opts.endDate) as any[];

  return {
    startDate: opts.startDate,
    endDate: opts.endDate,
    sessions: sessionRows.map((r) => ({
      id: Number(r.id),
      opened_by_name: String(r.opened_by_name || ''),
      opened_at: String(r.opened_at),
      closed_at: r.closed_at ? String(r.closed_at) : null,
      status: String(r.status),
      opening_float: Number(r.opening_float_cents || 0) / minorFactor,
      expected_cash: r.expected_cash_cents == null ? null : Number(r.expected_cash_cents) / minorFactor,
      counted_cash: r.counted_cash_cents == null ? null : Number(r.counted_cash_cents) / minorFactor,
      variance: r.variance_cents == null ? null : Number(r.variance_cents) / minorFactor,
    })),
    closures: closureRows.map((r) => ({
      id: Number(r.id),
      z_number: r.z_number == null ? null : Number(r.z_number),
      business_date: String(r.business_date),
      scope: String(r.scope),
      opening_float: Number(r.opening_float_cents || 0) / minorFactor,
      expected_cash: Number(r.expected_cash_cents || 0) / minorFactor,
      counted_cash: Number(r.counted_cash_cents || 0) / minorFactor,
      variance: Number(r.variance_cents || 0) / minorFactor,
      gross_collected: Number(r.gross_collected_cents || 0) / minorFactor,
      refunded: Number(r.refunded_cents || 0) / minorFactor,
      net_collected: Number(r.net_collected_cents || 0) / minorFactor,
      bill_count: Number(r.bill_count || 0),
      created_at: String(r.created_at),
    })),
  };
}

// ── Serializers (daily-sales-export-files style: numeric xlsx, plain csv) ──

export function serializeSalesBreakdownCsv(dataset: SalesBreakdownDataset): string {
  const lines: string[] = [];
  lines.push(toCsvRow(['section', 'name', 'quantity_or_count', 'total']));
  const t = dataset.totals;
  lines.push(toCsvRow(['total', 'orders_total', t.ordersCount, t.ordersTotal]));
  lines.push(toCsvRow(['total', 'collected', '', t.collected]));
  lines.push(toCsvRow(['total', 'tax_collected', '', t.taxCollected]));
  lines.push(toCsvRow(['total', 'discounts', '', t.discounts]));
  lines.push(toCsvRow(['total', 'service_charges', '', t.serviceCharges]));
  for (const r of dataset.byProduct) lines.push(toCsvRow(['product', r.product_name, r.quantity, r.total]));
  for (const r of dataset.byCategory) lines.push(toCsvRow(['category', r.category_name, r.quantity, r.total]));
  for (const r of dataset.byOrderType) lines.push(toCsvRow(['order_type', r.type, r.count, r.total]));
  for (const r of dataset.byHour) lines.push(toCsvRow(['hour', String(r.hour), r.count, r.total]));
  return lines.join('\n') + '\n';
}

export async function serializeSalesBreakdownXlsx(dataset: SalesBreakdownDataset): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet('Summary');
  summary.columns = [
    { header: 'metric', key: 'metric', width: 24 },
    { header: 'value', key: 'value', width: 20 },
  ];
  summary.getRow(1).font = { bold: true };
  const t = dataset.totals;
  summary.addRow({ metric: 'orders_count', value: t.ordersCount });
  summary.addRow({ metric: 'orders_total', value: t.ordersTotal });
  summary.addRow({ metric: 'collected', value: t.collected });
  summary.addRow({ metric: 'tax_collected', value: t.taxCollected });
  summary.addRow({ metric: 'discounts', value: t.discounts });
  summary.addRow({ metric: 'service_charges', value: t.serviceCharges });

  const products = workbook.addWorksheet('Products');
  products.columns = [
    { header: 'product_name', key: 'product_name', width: 32 },
    { header: 'quantity', key: 'quantity', width: 12 },
    { header: 'total', key: 'total', width: 18 },
  ];
  products.getRow(1).font = { bold: true };
  for (const r of dataset.byProduct) products.addRow(r);

  const categories = workbook.addWorksheet('Categories');
  categories.columns = [
    { header: 'category_name', key: 'category_name', width: 32 },
    { header: 'quantity', key: 'quantity', width: 12 },
    { header: 'total', key: 'total', width: 18 },
  ];
  categories.getRow(1).font = { bold: true };
  for (const r of dataset.byCategory) categories.addRow(r);

  const types = workbook.addWorksheet('OrderTypes');
  types.columns = [
    { header: 'type', key: 'type', width: 20 },
    { header: 'count', key: 'count', width: 12 },
    { header: 'total', key: 'total', width: 18 },
  ];
  types.getRow(1).font = { bold: true };
  for (const r of dataset.byOrderType) types.addRow(r);

  const hours = workbook.addWorksheet('Hours');
  hours.columns = [
    { header: 'hour', key: 'hour', width: 10 },
    { header: 'count', key: 'count', width: 12 },
    { header: 'total', key: 'total', width: 18 },
  ];
  hours.getRow(1).font = { bold: true };
  for (const r of dataset.byHour) hours.addRow(r);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function serializeCashSummaryCsv(dataset: CashSummaryDataset): string {
  const lines: string[] = [];
  lines.push(
    toCsvRow(['section', 'id_or_date', 'opened_by', 'opened_at', 'status_or_scope', 'opening_float', 'expected_cash', 'counted_cash', 'variance', 'net_collected']),
  );
  for (const s of dataset.sessions) {
    lines.push(
      toCsvRow(['session', s.id, s.opened_by_name, s.opened_at, s.status, s.opening_float, s.expected_cash ?? '', s.counted_cash ?? '', s.variance ?? '', '']),
    );
  }
  for (const c of dataset.closures) {
    lines.push(
      toCsvRow(['closure', c.business_date, '', c.created_at, c.scope, c.opening_float, c.expected_cash, c.counted_cash, c.variance, c.net_collected]),
    );
  }
  return lines.join('\n') + '\n';
}

export async function serializeCashSummaryXlsx(dataset: CashSummaryDataset): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sessions = workbook.addWorksheet('Sessions');
  sessions.columns = [
    { header: 'id', key: 'id', width: 10 },
    { header: 'opened_by', key: 'opened_by_name', width: 22 },
    { header: 'opened_at', key: 'opened_at', width: 22 },
    { header: 'closed_at', key: 'closed_at', width: 22 },
    { header: 'status', key: 'status', width: 12 },
    { header: 'opening_float', key: 'opening_float', width: 16 },
    { header: 'expected_cash', key: 'expected_cash', width: 16 },
    { header: 'counted_cash', key: 'counted_cash', width: 16 },
    { header: 'variance', key: 'variance', width: 14 },
  ];
  sessions.getRow(1).font = { bold: true };
  for (const s of dataset.sessions) sessions.addRow(s);

  const closures = workbook.addWorksheet('Closures');
  closures.columns = [
    { header: 'business_date', key: 'business_date', width: 16 },
    { header: 'z_number', key: 'z_number', width: 10 },
    { header: 'scope', key: 'scope', width: 12 },
    { header: 'opening_float', key: 'opening_float', width: 16 },
    { header: 'expected_cash', key: 'expected_cash', width: 16 },
    { header: 'counted_cash', key: 'counted_cash', width: 16 },
    { header: 'variance', key: 'variance', width: 14 },
    { header: 'gross_collected', key: 'gross_collected', width: 16 },
    { header: 'refunded', key: 'refunded', width: 14 },
    { header: 'net_collected', key: 'net_collected', width: 16 },
    { header: 'bill_count', key: 'bill_count', width: 12 },
  ];
  closures.getRow(1).font = { bold: true };
  for (const c of dataset.closures) closures.addRow(c);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
