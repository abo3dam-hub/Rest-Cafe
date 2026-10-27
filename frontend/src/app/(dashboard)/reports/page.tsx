'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Download, FileSpreadsheet, Printer } from 'lucide-react';
import api from '@/lib/api';
import { downloadBlob } from '@/lib/download';
import { getCurrencyMinorUnitFactor } from '@/lib/countries';
import { useAuthStore } from '@/store/auth';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { Button } from '@/components/ui/button';
import { Ltr } from '@/components/layout/Ltr';

// Reports section (W4). Every figure comes from the ledger-backed report
// endpoints — nothing is computed in the browser beyond display sums that the
// endpoints themselves define. Exports read the same datasets server-side.

type TabKey = 'daily' | 'sales' | 'cash' | 'profitability';
type Preset = 'day' | 'month' | 'year' | 'custom';

interface PaymentMethodRow {
  method: string;
  count: number;
  total: number;
}

interface FinancialSummary {
  grossCollected: number;
  refunded: number;
  netCollected: number;
  billCount: number;
  refundCount: number;
  averageOrderValue: number;
  paymentMethods: PaymentMethodRow[];
}

interface DaySummary {
  orders: { count: number; total: number };
  ordersByStatus: { status: string; count: number }[];
}

interface SalesBreakdown {
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

interface DishProfitabilityRow {
  product_id: string;
  name: string;
  quantity: number;
  revenue: number;
  ingredient_cost: number;
  cost_coverage_pct: number;
  margin: number;
  margin_pct: number;
  class: string;
}

interface DishProfitability {
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

interface CashSummary {
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

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function rangeForPreset(preset: Preset, custom: { from: string; to: string }): { from: string; to: string } {
  const now = new Date();
  if (preset === 'day') {
    const today = isoDate(now);
    return { from: today, to: today };
  }
  if (preset === 'month') {
    return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: isoDate(now) };
  }
  if (preset === 'year') {
    return { from: isoDate(new Date(now.getFullYear(), 0, 1)), to: isoDate(now) };
  }
  return custom;
}

export default function ReportsPage() {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  const { currentTenant } = useAuthStore();
  const fmt = useFormatCurrency();

  const [tab, setTab] = useState<TabKey>('daily');
  const [preset, setPreset] = useState<Preset>('day');
  const [custom, setCustom] = useState(() => {
    const today = isoDate(new Date());
    return { from: today, to: today };
  });
  const range = useMemo(() => rangeForPreset(preset, custom), [preset, custom]);

  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [financial, setFinancial] = useState<FinancialSummary | null>(null);
  const [daySummary, setDaySummary] = useState<DaySummary | null>(null);
  const [expectedCash, setExpectedCash] = useState<number | null>(null);
  const [expensesTotal, setExpensesTotal] = useState<number | null>(null);
  const [dailyBreakdown, setDailyBreakdown] = useState<SalesBreakdown | null>(null);
  const [sales, setSales] = useState<SalesBreakdown | null>(null);
  const [cash, setCash] = useState<CashSummary | null>(null);
  const [profitability, setProfitability] = useState<DishProfitability | null>(null);

  const minorFactor = getCurrencyMinorUnitFactor(currentTenant?.currency || '');

  const loadDaily = useCallback(async () => {
    const date = range.from;
    setLoading(true);
    try {
      const [finRes, sumRes, xRes, expRes, brkRes] = await Promise.all([
        api.get('/reports/financial-summary', { params: { start_date: date, end_date: date } }),
        api.get('/reports/summary', { params: { date } }),
        api.get('/reports/x-report', { params: { date } }),
        api.get('/expenses/summary', { params: { from: date, to: date } }),
        api.get('/reports/sales/breakdown', { params: { start_date: date, end_date: date } }),
      ]);
      setFinancial(finRes.data.financialSummary ?? null);
      setDaySummary(sumRes.data.summary ?? null);
      const x = xRes.data.xReport;
      setExpectedCash(
        x ? (Number(x.expectedCashCents || 0) + Number(x.openingFloatCents || 0)) / minorFactor : null,
      );
      const totals = (expRes.data?.totals ?? []) as {
        currency_code: string;
        incurred_minor: number;
      }[];
      const own = totals.find((row) => row.currency_code === currentTenant?.currency) ?? totals[0];
      setExpensesTotal(own ? Number(own.incurred_minor || 0) / minorFactor : 0);
      setDailyBreakdown(brkRes.data.salesBreakdown ?? null);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [range.from, minorFactor, currentTenant?.currency, t]);

  const loadSales = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/reports/sales/breakdown', {
        params: { start_date: range.from, end_date: range.to },
      });
      setSales(data.salesBreakdown ?? null);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, t]);

  const loadCash = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/reports/cash-summary', {
        params: { start_date: range.from, end_date: range.to },
      });
      setCash(data.cashSummary ?? null);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, t]);

  const loadProfitability = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/reports/dish-profitability', {
        params: { start_date: range.from, end_date: range.to },
      });
      setProfitability(data.dishProfitability ?? null);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to, t]);

  useEffect(() => {
    // oxlint-disable-next-line react-hooks/set-state-in-effect
    if (tab === 'daily') void loadDaily();
    else if (tab === 'sales') void loadSales();
    else if (tab === 'profitability') void loadProfitability();
    else void loadCash();
  }, [tab, loadDaily, loadSales, loadCash, loadProfitability]);

  const download = async (url: string, params: Record<string, string>, filename: string) => {
    const res = await api.get(url, { params, responseType: 'blob' });
    downloadBlob(res.data as Blob, filename);
  };

  const handleExport = async (format: 'xlsx' | 'csv') => {
    if (exporting) return;
    setExporting(true);
    try {
      if (tab === 'daily') {
        // The existing daily-sales export is single-date; it uses the
        // range's first day (the Daily tab's own date).
        if (format === 'xlsx') {
          await download(
            '/reports/daily-sales/export',
            { date: range.from, format },
            `daily-sales-${range.from}.xlsx`,
          );
        } else {
          for (const part of ['summary', 'items', 'payments'] as const) {
            await download(
              '/reports/daily-sales/export',
              { date: range.from, format, part },
              `daily-sales-${range.from}-${part}.csv`,
            );
          }
        }
      } else if (tab === 'sales') {
        await download(
          '/reports/sales/export',
          { start_date: range.from, end_date: range.to, format },
          `sales-report-${range.from}-to-${range.to}.${format}`,
        );
      } else if (tab === 'profitability') {
        await download(
          '/reports/dish-profitability/export',
          { start_date: range.from, end_date: range.to, format },
          `dish-profitability-${range.from}-to-${range.to}.${format}`,
        );
      } else {
        await download(
          '/reports/cash/export',
          { start_date: range.from, end_date: range.to, format },
          `cash-report-${range.from}-to-${range.to}.${format}`,
        );
      }
    } catch {
      toast.error(tCommon('downloadFailed'));
    } finally {
      setExporting(false);
    }
  };

  const methodLabel = (method: string) =>
    method === 'cash' ? t('methodCash') : method === 'card' ? t('methodCard') : method;
  const typeLabel = (type: string) =>
    type === 'dine_in'
      ? t('typeDineIn')
      : type === 'takeaway'
        ? t('typeTakeaway')
        : type === 'delivery'
          ? t('typeDelivery')
          : type;
  const statusCount = (status: string) =>
    daySummary?.ordersByStatus.find((row) => row.status === status)?.count ?? 0;
  const dishClassLabel = (cls: string) =>
    cls === 'star'
      ? t('classStar')
      : cls === 'puzzle'
        ? t('classPuzzle')
        : cls === 'plowhorse'
          ? t('classPlowhorse')
          : cls === 'dog'
            ? t('classDog')
            : cls;
  const dishClassChipClass = (cls: string) =>
    cls === 'star'
      ? 'bg-amber-100 text-amber-800 border-amber-200'
      : cls === 'puzzle'
        ? 'bg-violet-100 text-violet-800 border-violet-200'
        : cls === 'plowhorse'
          ? 'bg-sky-100 text-sky-800 border-sky-200'
          : 'bg-red-100 text-red-800 border-red-200';
  const fmtPct = (value: number) => `${Number(value ?? 0).toFixed(1)}%`;

  const metricCards: { label: string; value: string }[] =
    tab === 'daily' && financial
      ? [
          { label: t('collected'), value: fmt(financial.grossCollected) },
          { label: t('refunds'), value: fmt(financial.refunded) },
          { label: t('net'), value: fmt(financial.netCollected) },
          { label: t('discounts'), value: fmt(dailyBreakdown?.totals.discounts ?? 0) },
          { label: t('taxCollected'), value: fmt(dailyBreakdown?.totals.taxCollected ?? 0) },
          { label: t('serviceCharges'), value: fmt(dailyBreakdown?.totals.serviceCharges ?? 0) },
          { label: t('expensesTotal'), value: expensesTotal == null ? '—' : fmt(expensesTotal) },
          { label: t('expectedCash'), value: expectedCash == null ? '—' : fmt(expectedCash) },
          { label: t('completedOrders'), value: String(statusCount('completed')) },
          { label: t('cancelledOrders'), value: String(statusCount('cancelled')) },
          { label: t('averageTicket'), value: fmt(financial.averageOrderValue) },
          { label: t('billCount'), value: String(financial.billCount) },
        ]
      : tab === 'sales' && sales
        ? [
            { label: t('ordersCount'), value: String(sales.totals.ordersCount) },
            { label: t('ordersTotal'), value: fmt(sales.totals.ordersTotal) },
            { label: t('collected'), value: fmt(sales.totals.collected) },
            { label: t('taxCollected'), value: fmt(sales.totals.taxCollected) },
            { label: t('discounts'), value: fmt(sales.totals.discounts) },
            { label: t('serviceCharges'), value: fmt(sales.totals.serviceCharges) },
          ]
        : tab === 'profitability' && profitability
          ? [
              { label: t('revenue'), value: fmt(profitability.totals.revenue) },
              { label: t('ingredientCost'), value: fmt(profitability.totals.ingredient_cost) },
              { label: t('margin'), value: fmt(profitability.totals.margin) },
              { label: t('marginPct'), value: fmtPct(profitability.totals.margin_pct) },
              { label: t('costCoverage'), value: fmtPct(profitability.totals.cost_coverage_pct) },
            ]
          : [];

  return (
    <div className="mx-auto w-full max-w-6xl p-4 md:p-6">
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .reports-print-area, .reports-print-area * { visibility: visible; }
          .reports-print-area {
            display: block !important;
            position: absolute;
            inset: 0;
            padding: 24px;
            background: #fff;
            color: #000;
          }
        }
      `}</style>

      <div className="print:hidden">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('subtitle')}</p>

        {/* Filters */}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {(['day', 'month', 'year', 'custom'] as Preset[]).map((p) => (
            <Button
              key={p}
              size="sm"
              variant={preset === p ? 'default' : 'outline'}
              onClick={() => setPreset(p)}
            >
              {t(p === 'day' ? 'presetToday' : p === 'month' ? 'presetMonth' : p === 'year' ? 'presetYear' : 'presetCustom')}
            </Button>
          ))}
          {preset === 'custom' && (
            <span className="flex items-center gap-2">
              <label className="text-sm text-muted-foreground">{t('from')}</label>
              <input
                type="date"
                value={custom.from}
                onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
              />
              <label className="text-sm text-muted-foreground">{t('to')}</label>
              <input
                type="date"
                value={custom.to}
                onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                className="rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            </span>
          )}
          <span className="ms-auto flex items-center gap-2">
            <Button size="sm" variant="outline" disabled={exporting} onClick={() => void handleExport('xlsx')}>
              <FileSpreadsheet className="me-1 size-4" /> {t('exportExcel')}
            </Button>
            <Button size="sm" variant="outline" disabled={exporting} onClick={() => void handleExport('csv')}>
              <Download className="me-1 size-4" /> {t('exportCsv')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.print()}>
              <Printer className="me-1 size-4" /> {t('exportPdf')}
            </Button>
          </span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {t('periodLabel')}: <Ltr>{range.from} — {range.to}</Ltr>
        </p>

        {/* Tabs */}
        <div className="mt-4 flex gap-2 border-b">
          {(['daily', 'sales', 'cash', 'profitability'] as TabKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-3 py-2 text-sm font-medium ${
                tab === key
                  ? 'border-b-2 border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(
                key === 'daily'
                  ? 'tabDaily'
                  : key === 'sales'
                    ? 'tabSales'
                    : key === 'cash'
                      ? 'tabCash'
                      : 'tabProfitability',
              )}
            </button>
          ))}
        </div>

        {loading && <p className="py-10 text-center text-sm text-muted-foreground">{tCommon('loading')}</p>}

        {!loading && tab !== 'cash' && metricCards.length > 0 && (
          <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
            {metricCards.map((card) => (
              <div key={card.label} className="rounded-xl border bg-card p-4">
                <p className="text-xs text-muted-foreground">{card.label}</p>
                <p className="mt-1 text-lg font-semibold">{card.value}</p>
              </div>
            ))}
          </div>
        )}

        {!loading && tab === 'daily' && financial && (
          <Section title={t('paymentsByMethod')}>
            <SimpleTable
              head={[t('method'), t('count'), t('total')]}
              rows={financial.paymentMethods.map((row) => [
                methodLabel(row.method),
                String(row.count),
                fmt(row.total),
              ])}
              empty={t('noData')}
            />
          </Section>
        )}

        {!loading && tab === 'sales' && sales && (
          <>
            <Section title={t('byProduct')}>
              <SimpleTable
                head={[t('product'), t('quantity'), t('total')]}
                rows={sales.byProduct.map((row) => [row.product_name, String(row.quantity), fmt(row.total)])}
                empty={t('noData')}
              />
            </Section>
            <Section title={t('byCategory')}>
              <SimpleTable
                head={[t('category'), t('quantity'), t('total')]}
                rows={sales.byCategory.map((row) => [row.category_name || '—', String(row.quantity), fmt(row.total)])}
                empty={t('noData')}
              />
            </Section>
            <Section title={t('byOrderType')}>
              <SimpleTable
                head={[t('orderType'), t('count'), t('total')]}
                rows={sales.byOrderType.map((row) => [typeLabel(row.type), String(row.count), fmt(row.total)])}
                empty={t('noData')}
              />
            </Section>
            <Section title={t('byHour')}>
              <SimpleTable
                head={[t('hour'), t('count'), t('total')]}
                rows={sales.byHour.map((row) => [`${String(row.hour).padStart(2, '0')}:00`, String(row.count), fmt(row.total)])}
                empty={t('noData')}
              />
            </Section>
          </>
        )}

        {!loading && tab === 'profitability' && profitability && (
          <Section title={t('tabProfitability')}>
            {profitability.rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">{t('noData')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-start font-medium">{t('dish')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('quantity')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('revenue')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('ingredientCost')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('margin')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('marginPct')}</th>
                    <th className="px-3 py-2 text-start font-medium">{t('dishClass')}</th>
                  </tr>
                </thead>
                <tbody>
                  {profitability.rows.map((row) => (
                    <tr key={row.product_id} className="border-b last:border-0">
                      <td className="px-3 py-2 font-medium">{row.name}</td>
                      <td className="px-3 py-2">{row.quantity}</td>
                      <td className="px-3 py-2">{fmt(row.revenue)}</td>
                      <td className="px-3 py-2">
                        {fmt(row.ingredient_cost)}
                        <span className="block text-xs text-muted-foreground">
                          {t('costCoverage')}: <Ltr>{fmtPct(row.cost_coverage_pct)}</Ltr>
                        </span>
                      </td>
                      <td className="px-3 py-2">{fmt(row.margin)}</td>
                      <td className="px-3 py-2">
                        <Ltr>{fmtPct(row.margin_pct)}</Ltr>
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-semibold ${dishClassChipClass(row.class)}`}
                        >
                          {dishClassLabel(row.class)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t bg-muted/50 font-semibold">
                    <td className="px-3 py-2">{t('total')}</td>
                    <td className="px-3 py-2">{profitability.totals.quantity}</td>
                    <td className="px-3 py-2">{fmt(profitability.totals.revenue)}</td>
                    <td className="px-3 py-2">{fmt(profitability.totals.ingredient_cost)}</td>
                    <td className="px-3 py-2">{fmt(profitability.totals.margin)}</td>
                    <td className="px-3 py-2">
                      <Ltr>{fmtPct(profitability.totals.margin_pct)}</Ltr>
                    </td>
                    <td className="px-3 py-2" />
                  </tr>
                </tfoot>
              </table>
            )}
          </Section>
        )}

        {!loading && tab === 'cash' && cash && (
          <>
            <Section title={t('sessions')}>
              <SimpleTable
                head={[t('openedBy'), t('openedAt'), t('closedAt'), t('status'), t('openingFloat'), t('expectedCash'), t('countedCash'), t('variance')]}
                rows={cash.sessions.map((s) => [
                  s.opened_by_name,
                  s.opened_at,
                  s.closed_at ?? '—',
                  s.status === 'open' ? t('statusOpen') : t('statusClosed'),
                  fmt(s.opening_float),
                  s.expected_cash == null ? '—' : fmt(s.expected_cash),
                  s.counted_cash == null ? '—' : fmt(s.counted_cash),
                  s.variance == null ? '—' : fmt(s.variance),
                ])}
                empty={t('noData')}
              />
            </Section>
            <Section title={t('closures')}>
              <SimpleTable
                head={[t('businessDate'), t('zNumber'), t('openingFloat'), t('expectedCash'), t('countedCash'), t('variance'), t('net'), t('billCount')]}
                rows={cash.closures.map((c) => [
                  c.business_date,
                  c.z_number == null ? '—' : `Z${c.z_number}`,
                  fmt(c.opening_float),
                  fmt(c.expected_cash),
                  fmt(c.counted_cash),
                  fmt(c.variance),
                  fmt(c.net_collected),
                  String(c.bill_count),
                ])}
                empty={t('noData')}
              />
            </Section>
          </>
        )}
      </div>

      {/* Print-only rendering of the active tab (PDF via the print dialog) */}
      <div className="reports-print-area hidden" aria-hidden="true">
        <h1 style={{ fontSize: 20, fontWeight: 700 }}>{t('title')}</h1>
        <p>
          {t(
            tab === 'daily'
              ? 'tabDaily'
              : tab === 'sales'
                ? 'tabSales'
                : tab === 'cash'
                  ? 'tabCash'
                  : 'tabProfitability',
          )}{' '}
          — {t('periodLabel')}: {range.from} — {range.to}
        </p>
        {metricCards.map((card) => (
          <p key={card.label}>
            {card.label}: <strong>{card.value}</strong>
          </p>
        ))}
        {tab === 'sales' && sales && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('product')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('quantity')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('total')}</th>
              </tr>
            </thead>
            <tbody>
              {sales.byProduct.map((row) => (
                <tr key={row.product_id}>
                  <td>{row.product_name}</td>
                  <td>{row.quantity}</td>
                  <td>{fmt(row.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'profitability' && profitability && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('dish')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('quantity')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('revenue')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('ingredientCost')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('margin')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('marginPct')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('dishClass')}</th>
              </tr>
            </thead>
            <tbody>
              {profitability.rows.map((row) => (
                <tr key={row.product_id}>
                  <td>{row.name}</td>
                  <td>{row.quantity}</td>
                  <td>{fmt(row.revenue)}</td>
                  <td>{fmt(row.ingredient_cost)}</td>
                  <td>{fmt(row.margin)}</td>
                  <td>{fmtPct(row.margin_pct)}</td>
                  <td>{dishClassLabel(row.class)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === 'cash' && cash && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('businessDate')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('expectedCash')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('countedCash')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('variance')}</th>
                <th style={{ textAlign: 'start', borderBottom: '1px solid #000' }}>{t('net')}</th>
              </tr>
            </thead>
            <tbody>
              {cash.closures.map((c) => (
                <tr key={c.id}>
                  <td>{c.business_date}</td>
                  <td>{fmt(c.expected_cash)}</td>
                  <td>{fmt(c.counted_cash)}</td>
                  <td>{fmt(c.variance)}</td>
                  <td>{fmt(c.net_collected)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-base font-semibold">{title}</h2>
      <div className="overflow-x-auto rounded-xl border">{children}</div>
    </section>
  );
}

function SimpleTable({ head, rows, empty }: { head: string[]; rows: string[][]; empty: string }) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>;
  }
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b bg-muted/50">
          {head.map((h) => (
            <th key={h} className="px-3 py-2 text-start font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b last:border-0">
            {row.map((cell, j) => (
              <td key={j} className="px-3 py-2">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
