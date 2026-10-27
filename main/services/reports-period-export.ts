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
  /**
   * Per-business-day ledger collections. Payments never require an open
   * cash session in this product, so a store that never opens shifts (and
   * never runs a day close) still has real collections to show: these rows
   * are computed straight from bills/refunds, bucketed by the business
   * date of each bill's paid_at — the same attribution financial-summary
   * uses. `expected_cash` is the sales-only drawer expectation (cash lines
   * minus cash refunds); drawer movements and opening float live on
   * sessions/closures, matching the X-report convention of reporting the
   * float separately.
   */
  days: {
    business_date: string;
    bill_count: number;
    gross_collected: number;
    refunded: number;
    net_collected: number;
    cash_collected: number;
    expected_cash: number;
  }[];
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
  opts: {
    startDate: string;
    endDate: string;
    windowStart: string;
    windowEnd: string;
    timeZone: string;
    startTime: string;
    minorFactor: number;
  },
): CashSummaryDataset {
  const { windowStart, windowEnd, minorFactor } = opts;

  // Per-day ledger collections (see the dataset doc): bucket paid bills by
  // the business date of paid_at in JS — SQLite has no IANA timezone support.
  const paidBills = db
    .prepare(
      `SELECT paid_amount, paid_at, payment_details FROM bills
       WHERE paid_at >= ? AND paid_at < ?`,
    )
    .all(windowStart, windowEnd) as any[];
  const refundRows = db
    .prepare(
      `SELECT r.amount_cents, r.method, b.paid_at
       FROM refunds r JOIN bills b ON b.id = r.bill_id
       WHERE b.paid_at >= ? AND b.paid_at < ?`,
    )
    .all(windowStart, windowEnd) as any[];

  type DayBucket = {
    bill_count: number;
    gross: number;
    refunded: number;
    cash: number;
    cashRefunded: number;
  };
  const dayBuckets = new Map<string, DayBucket>();
  const bucketFor = (paidAt: string): DayBucket | null => {
    const instant = parseDbTimestamp(paidAt);
    if (isNaN(instant.getTime())) return null;
    const date = localDateInTimezone(instant, opts.timeZone, opts.startTime);
    if (date < opts.startDate || date > opts.endDate) return null;
    let bucket = dayBuckets.get(date);
    if (!bucket) {
      bucket = { bill_count: 0, gross: 0, refunded: 0, cash: 0, cashRefunded: 0 };
      dayBuckets.set(date, bucket);
    }
    return bucket;
  };
  for (const bill of paidBills) {
    const bucket = bucketFor(String(bill.paid_at));
    if (!bucket) continue;
    bucket.bill_count += 1;
    bucket.gross += Number(bill.paid_amount || 0);
    let lines: any[] = [];
    try {
      const parsed = JSON.parse(bill.payment_details || '[]');
      lines = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      lines = [];
    }
    for (const line of lines) {
      if (line && line.method === 'cash') bucket.cash += Number(line.amount || 0);
    }
  }
  for (const refund of refundRows) {
    const bucket = bucketFor(String(refund.paid_at));
    if (!bucket) continue;
    const amount = Number(refund.amount_cents || 0) / minorFactor;
    bucket.refunded += amount;
    if (refund.method === 'cash') bucket.cashRefunded += amount;
  }
  const days = [...dayBuckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([business_date, b]) => ({
      business_date,
      bill_count: b.bill_count,
      gross_collected: b.gross,
      refunded: b.refunded,
      net_collected: b.gross - b.refunded,
      cash_collected: b.cash,
      expected_cash: b.cash - b.cashRefunded,
    }));

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
    days,
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

export type DishClass = 'star' | 'puzzle' | 'plowhorse' | 'dog';

export interface DishProfitabilityRow {
  product_id: string;
  name: string;
  quantity: number;
  revenue: number;
  ingredient_cost: number;
  cost_coverage_pct: number;
  margin: number;
  margin_pct: number;
  class: DishClass;
}

export interface DishProfitabilityDataset {
  startDate: string;
  endDate: string;
  rows: DishProfitabilityRow[];
  totals: {
    quantity: number;
    revenue: number;
    ingredient_cost: number;
    cost_coverage_pct: number;
    margin: number;
    margin_pct: number;
  };
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const pctOf = (part: number, whole: number): number => (whole > 0 ? (part / whole) * 100 : 0);

// Revenue is the stored line total (oi.subtotal); ingredient cost is the
// line-total snapshot stored on the item, counted only where it was known
// at sale time (ingredient_cost_known = 1). Margin therefore compares full
// revenue against the known-cost portion, and cost_coverage_pct says how
// much of the sold quantity that cost actually covers.
export function buildDishProfitability(
  db: Db,
  opts: { startDate: string; endDate: string; windowStart: string; windowEnd: string },
): DishProfitabilityDataset {
  const { windowStart, windowEnd } = opts;

  const rawRows = db
    .prepare(
      `SELECT oi.product_id, oi.product_name,
              COALESCE(SUM(oi.quantity), 0) AS quantity,
              COALESCE(SUM(oi.subtotal), 0) AS revenue,
              COALESCE(SUM(CASE WHEN oi.ingredient_cost_known = 1
                            THEN COALESCE(oi.ingredient_cost, 0) ELSE 0 END), 0) AS ingredient_cost,
              COALESCE(SUM(CASE WHEN oi.ingredient_cost_known = 1
                            THEN oi.quantity ELSE 0 END), 0) AS known_quantity
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.created_at >= ? AND o.created_at < ? AND o.status != 'cancelled' AND ${ITEM_ACTIVE}
       GROUP BY oi.product_id, oi.product_name
       ORDER BY revenue DESC`,
    )
    .all(windowStart, windowEnd) as any[];

  const rows: DishProfitabilityRow[] = rawRows
    .map((r) => {
      const quantity = Number(r.quantity || 0);
      const revenue = Number(r.revenue || 0);
      const ingredientCost = Number(r.ingredient_cost || 0);
      const margin = revenue - ingredientCost;
      return {
        product_id: String(r.product_id),
        name: String(r.product_name),
        quantity,
        revenue,
        ingredient_cost: ingredientCost,
        cost_coverage_pct: pctOf(Number(r.known_quantity || 0), quantity),
        margin,
        margin_pct: pctOf(margin, revenue),
        class: 'dog' as DishClass,
      };
    })
    .filter((r) => r.quantity > 0);

  const quantityMedian = medianOf(rows.map((r) => r.quantity));
  const marginMedian = medianOf(rows.map((r) => r.margin_pct));
  for (const row of rows) {
    const highPopularity = row.quantity >= quantityMedian;
    const highMargin = row.margin_pct >= marginMedian;
    row.class = highPopularity
      ? highMargin
        ? 'star'
        : 'plowhorse'
      : highMargin
        ? 'puzzle'
        : 'dog';
  }

  const totalQuantity = rows.reduce((sum, r) => sum + r.quantity, 0);
  const totalRevenue = rows.reduce((sum, r) => sum + r.revenue, 0);
  const totalCost = rows.reduce((sum, r) => sum + r.ingredient_cost, 0);
  const totalKnownQuantity = rawRows.reduce(
    (sum, r) => sum + (Number(r.quantity || 0) > 0 ? Number(r.known_quantity || 0) : 0),
    0,
  );
  const totalMargin = totalRevenue - totalCost;

  return {
    startDate: opts.startDate,
    endDate: opts.endDate,
    rows,
    totals: {
      quantity: totalQuantity,
      revenue: totalRevenue,
      ingredient_cost: totalCost,
      cost_coverage_pct: pctOf(totalKnownQuantity, totalQuantity),
      margin: totalMargin,
      margin_pct: pctOf(totalMargin, totalRevenue),
    },
  };
}

export function serializeDishProfitabilityCsv(dataset: DishProfitabilityDataset): string {
  const lines: string[] = [];
  lines.push(
    toCsvRow([
      'product_id',
      'name',
      'quantity',
      'revenue',
      'ingredient_cost',
      'cost_coverage_pct',
      'margin',
      'margin_pct',
      'class',
    ]),
  );
  for (const r of dataset.rows) {
    lines.push(
      toCsvRow([
        r.product_id,
        r.name,
        r.quantity,
        r.revenue,
        r.ingredient_cost,
        r.cost_coverage_pct,
        r.margin,
        r.margin_pct,
        r.class,
      ]),
    );
  }
  const t = dataset.totals;
  lines.push(
    toCsvRow(['total', '', t.quantity, t.revenue, t.ingredient_cost, t.cost_coverage_pct, t.margin, t.margin_pct, '']),
  );
  return lines.join('\n') + '\n';
}

export async function serializeDishProfitabilityXlsx(
  dataset: DishProfitabilityDataset,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('DishProfitability');
  sheet.columns = [
    { header: 'product_id', key: 'product_id', width: 16 },
    { header: 'name', key: 'name', width: 32 },
    { header: 'quantity', key: 'quantity', width: 12 },
    { header: 'revenue', key: 'revenue', width: 16 },
    { header: 'ingredient_cost', key: 'ingredient_cost', width: 16 },
    { header: 'cost_coverage_pct', key: 'cost_coverage_pct', width: 16 },
    { header: 'margin', key: 'margin', width: 16 },
    { header: 'margin_pct', key: 'margin_pct', width: 12 },
    { header: 'class', key: 'class', width: 12 },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const r of dataset.rows) sheet.addRow(r);
  const t = dataset.totals;
  sheet.addRow({
    product_id: 'total',
    name: '',
    quantity: t.quantity,
    revenue: t.revenue,
    ingredient_cost: t.ingredient_cost,
    cost_coverage_pct: t.cost_coverage_pct,
    margin: t.margin,
    margin_pct: t.margin_pct,
    class: '',
  });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function serializeCashSummaryCsv(dataset: CashSummaryDataset): string {
  const lines: string[] = [];
  lines.push(
    toCsvRow(['section', 'id_or_date', 'opened_by', 'opened_at', 'status_or_scope', 'opening_float', 'expected_cash', 'counted_cash', 'variance', 'net_collected']),
  );
  for (const d of dataset.days) {
    lines.push(
      toCsvRow(['day', d.business_date, '', '', 'ledger', '', d.expected_cash, '', '', d.net_collected]),
    );
  }
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
  const days = workbook.addWorksheet('Days');
  days.columns = [
    { header: 'business_date', key: 'business_date', width: 16 },
    { header: 'bill_count', key: 'bill_count', width: 12 },
    { header: 'gross_collected', key: 'gross_collected', width: 16 },
    { header: 'refunded', key: 'refunded', width: 14 },
    { header: 'net_collected', key: 'net_collected', width: 16 },
    { header: 'cash_collected', key: 'cash_collected', width: 16 },
    { header: 'expected_cash', key: 'expected_cash', width: 16 },
  ];
  days.getRow(1).font = { bold: true };
  for (const d of dataset.days) days.addRow(d);

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
