/** Receipt entry: formatReceipt dispatch plus the classic/compact renderers and plugin column helpers. */

import {
  loadInstalledPrintTemplate,
  parseBillTemplateSelection,
} from '../services/print-templates';
import { renderMerchantReceiptViaDocument } from './document-merchant';
import { renderPluginReceipt } from './document-plugin-receipt';
import { renderClassicReceiptViaDocument } from './document-classic';
import { renderCompactReceiptViaDocument } from './document-compact';
import { printLabel } from '../print/print-labels.generated';
import type { PrintConceptId } from '../../shared/print/concepts';
import {
  displayCellWidth,
  padToDisplayCells,
  truncateToDisplayCells,
} from '../../shared/print/width';
import type { ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import type { PrinterCutMode } from './profiles';
import {
  formatCurrency,
  itemNameWidth,
  normalizePrintLanguage,
  normalizeThermalText,
  rightAlign,
  truncate,
  wrapText,
  type PrintWarning,
} from './formatting-helpers';

export function formatReceipt(
  order: any,
  bill: any,
  business?: any,
  template?: string,
  cols: number = 48,
  useUnicode: boolean = false,
  isReprint: boolean = false,
  cutMode: PrinterCutMode = 'full',
  warnings?: PrintWarning[],
  arabicShaping: boolean = false,
  language?: string,
  additionalLanguage?: string,
  capabilities?: ThermalPrinterCapabilities,
): Buffer {
  console.log('[Printer] formatReceipt - template:', template);
  console.log('[Printer] formatReceipt - order:', order?.order_number, 'bill:', bill?.bill_number);
  console.log('[Printer] formatReceipt - items count:', order?.items?.length || 0, 'cols:', cols);

  const lang = normalizePrintLanguage(language);
  // No business info supplied at all (e.g. a synthetic preview) — a neutral
  // explicit country + currency, never a default country or INR
  // (docs/reference/product-invariants.md). resolveTenantCurrency validates the
  // country before it ever looks at currency, so both must be present.
  const biz = business || {
    name: 'Store',
    address: '',
    phone: '',
    taxRegistrationNumber: '',
    country: 'US',
    currency: 'USD',
  };
  // Merchant templates resolve through document pipeline; pack templates use compliance renderer.
  const selection = parseBillTemplateSelection(template);
  const templateCapabilities =
    selection?.source === 'pack' || selection?.source === 'merchant'
      ? capabilities && { ...capabilities, raster: { ...capabilities.raster, enabled: false } }
      : capabilities;
  if (selection?.source === 'pack') {
    return renderPluginReceipt(
      loadInstalledPrintTemplate(selection.id),
      order,
      bill,
      biz,
      cols,
      useUnicode,
      isReprint,
      cutMode,
      warnings,
      arabicShaping,
      lang,
      templateCapabilities,
    );
  }
  if (selection?.source === 'merchant') {
    const result = renderMerchantReceiptViaDocument(order, bill, biz, selection.id, {
      columns: cols,
      language: lang,
      ...(additionalLanguage !== undefined
        ? { additionalLanguage: normalizePrintLanguage(additionalLanguage) }
        : {}),
      isReprint,
      useUnicode,
      arabicShaping,
      cutMode,
      capabilities: templateCapabilities,
    });
    if (warnings && result.warnings.length > 0) warnings.push(...result.warnings);
    return result.data;
  }
  const tpl = normalizeReceiptTemplate(selection?.source === 'core' ? selection.id : template);

  try {
    switch (tpl) {
      case 'classic':
        return formatClassicReceipt(
          order,
          bill,
          biz,
          cols,
          useUnicode,
          isReprint,
          cutMode,
          warnings,
          arabicShaping,
          lang,
          additionalLanguage,
          capabilities,
        );
      default:
        return formatCompactReceipt(
          order,
          bill,
          biz,
          cols,
          useUnicode,
          isReprint,
          cutMode,
          warnings,
          arabicShaping,
          lang,
          additionalLanguage,
          capabilities,
        );
    }
  } catch (err) {
    console.error('[Printer] formatReceipt error:', err);
    throw err;
  }
}

export function normalizeReceiptTemplate(template?: string): 'classic' | 'compact' {
  const normalized = String(template || 'classic')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (normalized.includes('compact') || normalized.includes('minimal')) return 'compact';
  return 'classic';
}

/** Compact thermal receipt: builds PrintDocument and renders via document-compact pipeline. */
export function formatCompactReceipt(
  order: any,
  bill: any,
  biz: any,
  cols: number = 48,
  useUnicode: boolean = false,
  isReprint: boolean = false,
  cutMode: PrinterCutMode = 'full',
  warnings?: PrintWarning[],
  arabicShaping: boolean = false,
  lang: string = 'en',
  additionalLanguage?: string,
  capabilities?: ThermalPrinterCapabilities,
): Buffer {
  const result = renderCompactReceiptViaDocument(order, bill, biz, {
    columns: cols,
    language: lang,
    ...(additionalLanguage !== undefined ? { additionalLanguage } : {}),
    isReprint,
    useUnicode,
    arabicShaping,
    cutMode,
    capabilities,
  });
  if (warnings && result.warnings.length > 0) warnings.push(...result.warnings);
  return result.data;
}

/** Classic thermal receipt: builds PrintDocument and renders via document-classic pipeline. */
export function formatClassicReceipt(
  order: any,
  bill: any,
  biz: any,
  cols: number = 48,
  useUnicode: boolean = false,
  isReprint: boolean = false,
  cutMode: PrinterCutMode = 'full',
  warnings?: PrintWarning[],
  arabicShaping: boolean = false,
  lang: string = 'en',
  additionalLanguage?: string,
  capabilities?: ThermalPrinterCapabilities,
): Buffer {
  const result = renderClassicReceiptViaDocument(order, bill, biz, {
    columns: cols,
    language: lang,
    ...(additionalLanguage !== undefined ? { additionalLanguage } : {}),
    isReprint,
    useUnicode,
    arabicShaping,
    cutMode,
    capabilities,
  });
  if (warnings && result.warnings.length > 0) warnings.push(...result.warnings);
  return result.data;
}

type PluginColumnAlign = 'left' | 'right' | 'center';
type PluginLineColumn = {
  key?: string;
  label?: string;
  width?: number;
  align?: PluginColumnAlign;
  wrap?: boolean;
  maxLines?: number;
  ellipsis?: boolean;
};

function pluginLineItemColumns(
  layout: any,
  cols: number,
  lang: string = 'en',
  capabilities?: ThermalPrinterCapabilities,
): PluginLineColumn[] {
  const configured = layout?.lineItems?.columns;
  if (Array.isArray(configured) && configured.length > 0) {
    const columns = configured
      .map((column: any) => ({
        key: typeof column?.key === 'string' ? column.key : undefined,
        label:
          typeof column?.label === 'string'
            ? normalizeThermalText(column.label, capabilities)
            : undefined,
        width: Number(column?.width),
        align: column?.align === 'right' || column?.align === 'center' ? column.align : 'left',
        wrap: column?.wrap === true,
        maxLines:
          Number.isInteger(column?.maxLines) && column.maxLines > 0 ? column.maxLines : undefined,
        ellipsis: column?.ellipsis !== false,
      }))
      .filter(
        (column: PluginLineColumn) =>
          column.key && Number.isInteger(column.width) && Number(column.width) > 0,
      );
    if (columns.length > 0) return columns;
  }
  return [
    {
      key: 'item',
      label: normalizeThermalText(printLabel(lang, 'receipt.item'), capabilities),
      width: itemNameWidth(cols, 10),
      align: 'left',
      wrap: true,
      maxLines: 2,
      ellipsis: true,
    },
    {
      key: 'quantity',
      label: normalizeThermalText(printLabel(lang, 'receipt.qty'), capabilities),
      width: 4,
      align: 'left',
    },
    {
      key: 'amount',
      label: normalizeThermalText(printLabel(lang, 'receipt.amount'), capabilities),
      width: 10,
      align: 'right',
    },
  ];
}

function pluginLineGap(layout: any): number {
  const gap = Number(layout?.lineItems?.gap);
  return Number.isInteger(gap) && gap >= 0 && gap <= 4 ? gap : 0;
}

export function pluginDetailLines(layout: any): string[] {
  const detailLines = layout?.lineItems?.detailLines;
  if (!Array.isArray(detailLines)) return ['addons', 'specialInstructions'];
  return detailLines.filter((line: unknown) => typeof line === 'string');
}

export function pluginItemHeader(
  layout: any,
  cols: number,
  lang: string = 'en',
  capabilities?: ThermalPrinterCapabilities,
): string {
  return composePluginColumns(
    pluginLineItemColumns(layout, cols, lang, capabilities).map((column) => ({
      ...column,
      value: column.label || column.key || '',
    })),
    pluginLineGap(layout),
    cols,
  );
}

export function pluginItemRows(
  item: any,
  layout: any,
  cols: number,
  prefix: string,
  locale: string,
  trimDecimals: boolean,
  fractionDigits: number,
  lang: string = 'en',
  capabilities?: ThermalPrinterCapabilities,
): string[] {
  const columns = pluginLineItemColumns(layout, cols, lang, capabilities);
  const gap = pluginLineGap(layout);
  const values = columns.map((column) => ({
    ...column,
    value: normalizeThermalText(
      pluginItemColumnValue(column.key || '', item, prefix, locale, trimDecimals, fractionDigits),
      capabilities,
    ),
  }));
  const wrappedValues = values.map((column) => {
    if (!column.wrap)
      return [truncateCell(column.value, Number(column.width), column.ellipsis !== false)];
    const maxLines = column.maxLines || 2;
    const wrapped = wrapText(column.value, Number(column.width));
    const limited = wrapped.slice(0, maxLines);
    if (wrapped.length > maxLines && limited.length > 0 && column.ellipsis !== false) {
      limited[limited.length - 1] = truncateCell(
        limited[limited.length - 1],
        Number(column.width),
        true,
      );
    }
    return limited.length > 0 ? limited : [''];
  });
  const lineCount = Math.max(1, ...wrappedValues.map((value) => value.length));
  const rows: string[] = [];
  for (let index = 0; index < lineCount; index++) {
    rows.push(
      composePluginColumns(
        values.map((column, columnIndex) => ({
          ...column,
          value: wrappedValues[columnIndex][index] || '',
        })),
        gap,
        cols,
      ),
    );
  }
  return rows;
}

function pluginItemColumnValue(
  key: string,
  item: any,
  prefix: string,
  locale: string,
  trimDecimals: boolean,
  fractionDigits: number,
): string {
  switch (key) {
    case 'item':
      return String(item.product_name || '');
    case 'quantity':
      return String(item.quantity ?? '');
    case 'rate': {
      const quantity = Number(item.quantity) || 0;
      const rate = Number(
        item.unit_price ?? item.price ?? (quantity ? Number(item.total) / quantity : 0),
      );
      return formatCurrency(rate, prefix, locale, trimDecimals, fractionDigits);
    }
    case 'taxRate':
      return pluginItemTaxRate(item);
    case 'amount':
      return formatCurrency(item.total, prefix, locale, trimDecimals, fractionDigits);
    default:
      return '';
  }
}

function pluginItemTaxRate(item: any): string {
  const rates = new Set<string>();
  const breakdown = Array.isArray(item.tax_breakdown) ? item.tax_breakdown : [];
  for (const component of breakdown) {
    if (component?.rate !== null && component?.rate !== undefined)
      rates.add(String(component.rate));
  }
  return [...rates].join('+');
}

export function pluginSummaryRow(
  label: string,
  amount: string,
  layout: any,
  cols: number,
  lang: string = 'en',
  capabilities?: ThermalPrinterCapabilities,
): string {
  const normalizedLabel = normalizeThermalText(label, capabilities);
  const labelWidth = Number(layout?.taxSummary?.labelWidth);
  const amountWidth = Number(layout?.taxSummary?.amountWidth);
  if (
    Number.isInteger(labelWidth) &&
    Number.isInteger(amountWidth) &&
    labelWidth > 0 &&
    amountWidth > 0
  ) {
    return composePluginColumns(
      [
        { value: normalizedLabel, width: labelWidth, align: 'left', ellipsis: true },
        { value: amount, width: amountWidth, align: 'right', ellipsis: true },
      ],
      Math.max(0, cols - labelWidth - amountWidth),
      cols,
    );
  }
  const safeLabel = truncate(normalizedLabel, cols - 12, lang, capabilities);
  return safeLabel + rightAlign(amount, cols - displayCellWidth(safeLabel));
}

function composePluginColumns(
  columns: Array<PluginLineColumn & { value: string }>,
  gap: number,
  cols: number,
): string {
  const separator = ' '.repeat(gap);
  const line = columns
    .map((column) =>
      alignCell(
        truncateCell(column.value, Number(column.width), column.ellipsis !== false),
        Number(column.width),
        column.align || 'left',
      ),
    )
    .join(separator);
  return padToDisplayCells(truncateCell(line, cols, false), cols);
}

function alignCell(value: string, width: number, align: PluginColumnAlign): string {
  return padToDisplayCells(truncateCell(value, width, true), width, align);
}

function truncateCell(text: string, length: number, ellipsis: boolean): string {
  const value = String(text || '');
  if (length <= 0) return '';
  if (displayCellWidth(value) <= length) return value;
  if (!ellipsis || length <= 2) return truncateToDisplayCells(value, length);
  return truncateToDisplayCells(value, length - 2) + '..';
}

const PAYMENT_METHOD_CONCEPTS: Record<string, PrintConceptId> = {
  cash: 'pos.methodCash',
  card: 'pos.methodCard',
  wallet: 'pos.methodWallet',
};

/** Ported from web-print.ts (#440): known methods localize; unknown keep the capitalize fallback. */
export function resolvePaymentMethodLabel(method: string, lang: string): string {
  const concept = PAYMENT_METHOD_CONCEPTS[String(method || '').toLowerCase()];
  if (concept) return printLabel(lang, concept);
  return capitalize(String(method || ''));
}

/** pos.tableLabel carries an ICU {name} placeholder; backend rendering swaps it inline. */
export function formatTableLabel(tableName: string, lang: string): string {
  return printLabel(lang, 'pos.tableLabel').replace('{name}', tableName);
}

function capitalize(text: string): string {
  return text.length > 0 ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
