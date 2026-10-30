/** Z-report document: build the ESC/POS bytes for a day-close Z-report and dispatch it. */

import { getDatabase, parseDbTimestamp } from '../db';
import {
  formatBusinessDate,
  getCurrencyFractionDigits,
  getCurrencySymbol,
  resolveRegionalSnapshot,
} from '../countries';
import { printLabel } from '../print/print-labels.generated';
import type { PrintConceptId } from '../../shared/print/concepts';
import { printViaNetwork, printViaUSB } from './print-transport';
import {
  appendCashDrawerPulse,
  buildEscPos,
  formatCurrency,
  normalizePrintLanguage,
  normalizeThermalText,
  pushCenteredWrapped,
  resolveCurrencyPrefix,
  rightAlign,
  wrapText,
  type PrintWarning,
} from './formatting-helpers';
import {
  bilingualLabelLines,
  buildZReportDocument,
  containsRtlScript,
  layoutStyledUnit,
  selectBilingualFit,
  thermalDisplayWidth,
  type SemanticLabel,
  type ThermalLayoutContext,
  type ZReportDocument,
  type ZReportPrintData,
} from '../../shared/print';
import type { ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import {
  columnsForPaperWidth,
  getPrinterConfig,
  hasFinancialPrintWarning,
  makeFinancialPrintRefusalMessage,
  resolvePrinterContext,
  type DispatchResult,
} from './thermal';

/**
 * Build the ESC/POS bytes for a Z-report (cierre de caja) from a stored
 * `cash_closures` row. Day-close, no bill — sections in spec print order:
 * header → Z number + business date + period → opening float → cash
 * movements → sales by payment method → refunds → tax breakdown → staff
 * sales → expected / counted / variance (variance emphasized) → operator +
 * signature → footer.
 * The byte builder never touches the drawer pulse; that is appended by
 * `printZReport` (the route layer) so the byte form is reusable for the
 * WebUSB `bytes: number[]` branch where the renderer dispatches.
 */
export function buildZReportBody(
  z: any,
  language?: string,
  printer?: { columns?: number; capabilities?: ThermalPrinterCapabilities },
  warnings?: PrintWarning[],
): Buffer {
  const cols = printer?.columns || columnsForPaperWidth('80mm') || 48;
  const lang = normalizePrintLanguage(language ?? z?.__language);
  const additionalLanguage = z?.__additionalLanguage
    ? normalizePrintLanguage(z.__additionalLanguage)
    : undefined;
  const settingsRows = getDatabase().prepare('SELECT key, value FROM settings').all() as {
    key: string;
    value: string;
  }[];
  const settings: Record<string, string> = Object.fromEntries(
    settingsRows.map((r) => [r.key, r.value]),
  );
  // Single resolution for currency/locale/timezone — resolves the stored
  // timezone through the country profile when missing or invalid, instead of
  // leaving it undefined (which would use the server's own host timezone,
  // not the tenant's, for the printed period timestamps).
  const snapshot = resolveRegionalSnapshot(settings);
  const currency = snapshot.currency;
  const fractionDigits = getCurrencyFractionDigits(currency);
  const factor = 10 ** fractionDigits;
  const locale = snapshot.locale;
  const tz = snapshot.timezone;
  const prefix = resolveCurrencyPrefix(
    snapshot.currencySymbol || getCurrencySymbol(currency, locale),
    false,
  );
  const trimDecimals = false;
  const centsToAmount = (cents: number): number => (Number(cents) || 0) / factor;
  const formatAmount = (cents: number): string =>
    formatCurrency(centsToAmount(cents), prefix, locale, trimDecimals, fractionDigits);
  const localTime = (iso: string): string => {
    try {
      const d = parseDbTimestamp(iso);
      if (isNaN(d.getTime())) return iso;
      return `${formatBusinessDate(d, tz)} ${d.toLocaleTimeString('en-US-u-nu-latn', { timeZone: tz })}`;
    } catch {
      return iso;
    }
  };
  const languages =
    additionalLanguage && additionalLanguage !== lang
      ? ([lang, additionalLanguage] as const)
      : ([lang] as const);
  const documentData: ZReportPrintData = {
    zNumber: z?.z_number ?? 0,
    businessDate: String(z?.business_date || ''),
    periodStart: localTime(z?.period_start),
    periodEnd: localTime(z?.period_end),
    openingFloatCents: Number(z?.opening_float_cents) || 0,
    payInCents: Number(z?.pay_in_cents) || 0,
    payOutCents: Number(z?.pay_out_cents) || 0,
    safeDropCents: Number(z?.safe_drop_cents) || 0,
    paymentMethods: (Array.isArray(z?.payment_methods) ? z.payment_methods : []).map(
      (row: any) => ({
        method: String(row?.method || ''),
        count: Number(row?.count) || 0,
        totalCents: Number(row?.total_cents ?? row?.total) || 0,
      }),
    ),
    refundCount: Number(z?.refund_count) || 0,
    refundedCents: Number(z?.refunded_cents) || 0,
    taxComponents: (Array.isArray(z?.tax_components) ? z.tax_components : []).map((row: any) => ({
      title: String(row?.title || row?.label || ''),
      amount: Number(row?.amount) || 0,
    })),
    staffSales: (Array.isArray(z?.staff_sales) ? z.staff_sales : []).map((row: any) => ({
      name: String(row?.name || row?.user_id || ''),
      orderCount: Number(row?.orderCount ?? row?.orders) || 0,
      revenueCents: Number(row?.revenue_cents ?? row?.revenue) || 0,
    })),
    expectedCashCents: Number(z?.expected_cash_cents) || 0,
    countedCashCents: Number(z?.counted_cash_cents) || 0,
    varianceCents: Number(z?.variance_cents) || 0,
    closedByName: String(z?.closed_by_name || z?.closed_by || ''),
    businessName: String(settings.business_name || ''),
    businessAddress: String(settings.business_address || ''),
    taxRegistrationNumber: String(settings.tax_registration_number || ''),
    isReprint: !!z?.__isReprint,
  };
  const zDocument = buildZReportDocument(documentData, {
    languages,
    baseDirection: containsRtlScript(printLabel(lang, 'print.zReport.title')) ? 'rtl' : 'ltr',
    resolveLabel: (conceptId, languageCode) =>
      printLabel(languageCode, conceptId as PrintConceptId),
  });
  const zContext = zLayoutContext(cols, zDocument, printer?.capabilities);
  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);
  const sections: string[] = [];
  sections.push('{INIT}');
  if (zDocument.header.businessName)
    pushCenteredWrapped(
      sections,
      zDocument.header.businessName.text,
      cols,
      lang,
      printer?.capabilities,
    );
  if (zDocument.header.businessAddress)
    pushCenteredWrapped(
      sections,
      zDocument.header.businessAddress.text,
      cols,
      lang,
      printer?.capabilities,
    );
  if (zDocument.header.taxRegistrationNumber)
    pushCenteredWrapped(
      sections,
      zDocument.header.taxRegistrationNumber.text,
      cols,
      lang,
      printer?.capabilities,
    );
  sections.push('');

  const titleLabel: SemanticLabel = {
    primary: `${zDocument.header.title.primary} #${zDocument.header.zNumber.text}${zDocument.header.reprintMarker ? ` (${zDocument.header.reprintMarker.primary})` : ''}`,
    ...(zDocument.header.title.secondary
      ? {
          secondary: `${zDocument.header.title.secondary} #${zDocument.header.zNumber.text}${zDocument.header.reprintMarker?.secondary ? ` (${zDocument.header.reprintMarker.secondary})` : ''}`,
        }
      : {}),
  };
  for (const line of layoutStyledUnit({ label: titleLabel, field: 'Z report title' }, zContext)
    .lines) {
    sections.push(
      '{CENTER}{BOLD}' + normalizeThermalText(line, printer?.capabilities) + '{/BOLD}{/CENTER}',
    );
  }
  sections.push('');

  sections.push(bar);
  for (const row of zDocument.period)
    pushZReportLabelValue(sections, row.label, row.value.text, zContext);
  sections.push(bar);
  sections.push('');

  pushZReportHeading(sections, zDocument.openingFloat.label, zContext, true);
  sections.push('{FINANCIAL}' + rightAlign(formatAmount(zDocument.openingFloat.cents), cols));
  sections.push('');

  pushZReportSectionHeading(sections, zDocument.cashMovements.heading, zContext);
  pushZReportLabelValue(
    sections,
    zDocument.cashMovements.payIn.label,
    formatAmount(zDocument.cashMovements.payIn.cents),
    zContext,
  );
  pushZReportLabelValue(
    sections,
    zDocument.cashMovements.payOut.label,
    formatAmount(zDocument.cashMovements.payOut.cents),
    zContext,
  );
  pushZReportLabelValue(
    sections,
    zDocument.cashMovements.safeDrop.label,
    formatAmount(zDocument.cashMovements.safeDrop.cents),
    zContext,
  );
  sections.push('');

  pushZReportSectionHeading(sections, zDocument.payments.heading, zContext);
  if (zDocument.payments.rows.length === 0)
    pushZReportEmpty(sections, zDocument.payments.none, zContext);
  for (const row of zDocument.payments.rows) {
    pushZReportRow(
      sections,
      {
        primary: `${row.label.primary} ${row.countLabel.primary.replace('{count}', String(row.count))}`,
        ...(row.label.secondary && row.countLabel.secondary
          ? {
              secondary: `${row.label.secondary} ${row.countLabel.secondary.replace('{count}', String(row.count))}`,
            }
          : {}),
      },
      formatAmount(row.totalCents),
      zContext,
    );
  }
  sections.push('');

  pushZReportSectionHeading(sections, zDocument.refunds.heading, zContext);
  pushZReportLabelValue(
    sections,
    zDocument.refunds.countLabel,
    String(zDocument.refunds.count),
    zContext,
  );
  pushZReportLabelValue(
    sections,
    zDocument.refunds.totalLabel,
    formatAmount(zDocument.refunds.totalCents),
    zContext,
    true,
  );
  sections.push('');

  pushZReportSectionHeading(sections, zDocument.tax.heading, zContext);
  if (zDocument.tax.rows.length === 0) pushZReportEmpty(sections, zDocument.tax.none, zContext);
  for (const row of zDocument.tax.rows)
    pushZReportRow(
      sections,
      row.label,
      formatCurrency(row.amount, prefix, locale, trimDecimals, fractionDigits),
      zContext,
    );
  sections.push('');

  pushZReportSectionHeading(sections, zDocument.staff.heading, zContext);
  if (zDocument.staff.rows.length === 0) pushZReportEmpty(sections, zDocument.staff.none, zContext);
  for (const row of zDocument.staff.rows) {
    pushZReportRow(
      sections,
      {
        primary: `${row.label.primary} ${row.countLabel.primary.replace('{count}', String(row.count))}`,
        ...(row.label.secondary && row.countLabel.secondary
          ? {
              secondary: `${row.label.secondary} ${row.countLabel.secondary.replace('{count}', String(row.count))}`,
            }
          : {}),
      },
      formatAmount(row.totalCents),
      zContext,
    );
  }
  sections.push('');

  sections.push(bar);
  pushZReportHeading(sections, zDocument.cash.expected.label, zContext, true);
  sections.push('{FINANCIAL}' + rightAlign(formatAmount(zDocument.cash.expected.cents), cols));
  pushZReportHeading(sections, zDocument.cash.counted.label, zContext, true);
  sections.push('{FINANCIAL}' + rightAlign(formatAmount(zDocument.cash.counted.cents), cols));
  sections.push(bar);
  const varianceLabel: SemanticLabel = {
    primary: `${zDocument.cash.variance.label.primary}  ${formatAmount(zDocument.cash.variance.cents)}`,
    ...(zDocument.cash.variance.label.secondary
      ? {
          secondary: `${zDocument.cash.variance.label.secondary}  ${formatAmount(zDocument.cash.variance.cents)}`,
        }
      : {}),
  };
  for (const line of zLaidOutLabel(varianceLabel, zContext)) {
    sections.push(
      '{CENTER}{FINANCIAL}{BOLD}' +
        normalizeThermalText(line, printer?.capabilities) +
        '{/BOLD}{/CENTER}',
    );
  }
  sections.push(dash);
  sections.push('');

  if (zDocument.operator.name)
    pushZReportTextValue(
      sections,
      zDocument.operator.label,
      zDocument.operator.name.text,
      zContext,
    );
  const signatureLines = zLaidOutLabel(zDocument.operator.signatureLabel, zContext);
  const inlineSignature =
    signatureLines.length === 1
      ? normalizeThermalText(signatureLines[0], printer?.capabilities)
      : null;
  const remainingSigCols =
    inlineSignature === null ? 0 : cols - thermalDisplayWidth(inlineSignature) - 1;
  if (inlineSignature !== null && remainingSigCols >= 8) {
    sections.push(inlineSignature + ' ' + '_'.repeat(remainingSigCols));
  } else {
    for (const line of signatureLines)
      sections.push(normalizeThermalText(line, printer?.capabilities));
    sections.push('_'.repeat(cols));
  }
  sections.push('');

  for (const line of bilingualLabelLines(
    zDocument.footer,
    selectBilingualFit(zDocument.footer, cols),
  )) {
    sections.push('{CENTER}' + normalizeThermalText(line, printer?.capabilities) + '{/CENTER}');
  }
  sections.push(
    '{CENTER}Z#' +
      zDocument.header.zNumber.text +
      ' - ' +
      normalizeThermalText(documentData.businessDate, printer?.capabilities) +
      '{/CENTER}',
  );
  sections.push('{CUT}');

  return buildEscPos(
    sections,
    false,
    { cutMode: 'full', language: lang, columns: cols, capabilities: printer?.capabilities },
    warnings,
  );
}

function zLayoutContext(
  columns: number,
  document: ZReportDocument,
  capabilities?: ThermalPrinterCapabilities,
): ThermalLayoutContext {
  return {
    logicalColumns: columns,
    direction: document.direction.base,
    languages: document.languages,
    capabilities,
  };
}

function zLaidOutLabel(label: SemanticLabel, context: ThermalLayoutContext): string[] {
  return [...layoutStyledUnit({ label, field: 'Z report label' }, context).lines];
}

function pushZReportHeading(
  lines: string[],
  label: SemanticLabel,
  context: ThermalLayoutContext,
  financial = false,
): void {
  const layout = layoutStyledUnit({ label, field: 'Z report section' }, context);
  for (const line of layout.lines)
    lines.push(
      (financial ? '{FINANCIAL}' : '') +
        '{BOLD}' +
        normalizeThermalText(line, context.capabilities) +
        '{/BOLD}',
    );
}

function pushZReportSectionHeading(
  lines: string[],
  label: SemanticLabel,
  context: ThermalLayoutContext,
): void {
  pushZReportHeading(lines, label, context);
}

function pushZReportEmpty(
  lines: string[],
  label: SemanticLabel,
  context: ThermalLayoutContext,
): void {
  const indentedContext = { ...context, logicalColumns: Math.max(1, context.logicalColumns - 2) };
  for (const line of zLaidOutLabel(label, indentedContext)) {
    lines.push('  ' + normalizeThermalText(line, context.capabilities));
  }
}

function pushZReportLabelValue(
  lines: string[],
  label: SemanticLabel,
  value: string,
  context: ThermalLayoutContext,
  financial = false,
): void {
  const columns = context.logicalColumns;
  const normalizedValue = normalizeThermalText(value, context.capabilities);
  const labelLines = zLaidOutLabel(label, context);
  if (
    labelLines.length === 1 &&
    thermalDisplayWidth(labelLines[0]) + 1 + thermalDisplayWidth(normalizedValue) <= columns
  ) {
    lines.push(
      (financial ? '{FINANCIAL}' : '') +
        normalizeThermalText(labelLines[0], context.capabilities) +
        rightAlign(normalizedValue, columns - thermalDisplayWidth(labelLines[0])),
    );
    return;
  }
  for (const line of labelLines)
    lines.push((financial ? '{FINANCIAL}' : '') + normalizeThermalText(line, context.capabilities));
  for (const line of wrapText(normalizedValue, columns))
    lines.push((financial ? '{FINANCIAL}' : '') + rightAlign(line, columns));
}

function pushZReportTextValue(
  lines: string[],
  label: SemanticLabel,
  value: string,
  context: ThermalLayoutContext,
): void {
  const labelWithValue: SemanticLabel = {
    primary: `${label.primary} ${value}`,
    ...(label.secondary ? { secondary: `${label.secondary} ${value}` } : {}),
  };
  for (const line of zLaidOutLabel(labelWithValue, context)) {
    lines.push(normalizeThermalText(line, context.capabilities));
  }
}

function pushZReportRow(
  lines: string[],
  label: SemanticLabel,
  value: string,
  context: ThermalLayoutContext,
): void {
  const prefix = '  ';
  const columns = context.logicalColumns;
  const normalizedValue = normalizeThermalText(value, context.capabilities);
  const labelContext = { ...context, logicalColumns: Math.max(1, columns - prefix.length) };
  const labelLines = zLaidOutLabel(label, labelContext);
  if (
    labelLines.length === 1 &&
    prefix.length + thermalDisplayWidth(labelLines[0]) + 1 + thermalDisplayWidth(normalizedValue) <=
      columns
  ) {
    lines.push(
      '{FINANCIAL}' +
        prefix +
        labelLines[0] +
        rightAlign(normalizedValue, columns - prefix.length - thermalDisplayWidth(labelLines[0])),
    );
    return;
  }
  for (const line of labelLines)
    lines.push('{FINANCIAL}' + prefix + normalizeThermalText(line, context.capabilities));
  for (const line of wrapText(normalizedValue, columns))
    lines.push('{FINANCIAL}' + rightAlign(line, columns));
}

/**
 * Dispatch the Z report to the configured printer. The pulse is forced on Z
 * print (bypassing bill-bound `shouldPulseForPayment` and the
 * `cash_drawer_pulse_methods` filter): the Z is the document the merchant
 * prints while counting the drawer.
 */
export async function printZReport(
  z: any,
  signal?: AbortSignal,
  targetPrinter?: any,
): Promise<DispatchResult & { bytes?: Buffer; connection_type?: string }> {
  try {
    if (signal?.aborted) return { ok: false, detail: 'Print cancelled during shutdown' };
    // The route resolves the default receipt printer so it can pick the
    // WebUSB branch server-side (`main/routes/printers.ts:329-331`). The
    // helper's own fallback uses getPrinterConfig() (which excludes webusb,
    // so default lookups never see a WebUSB printer).
    const printer = targetPrinter || getPrinterConfig();
    if (!printer) return { ok: false, detail: 'No printer configured' };
    // F3: resolve the printer's profile so `buildZReportBody` can use the
    // right columns and capabilities (58mm/36/42 cols, profile-specific
    // code pages, etc.). Same pattern as `prepareReceipt` (`:1043-1056`).
    const { columns, capabilities } = resolvePrinterContext(printer, false);
    const zWithMarker = { ...z, __isReprint: !!z?.__isReprint };
    // The route carries the resolved Z-report language policy in the snapshot;
    // direct callers retain the English store-language default.
    const warnings: PrintWarning[] = [];
    const baseBody = buildZReportBody(zWithMarker, undefined, { columns, capabilities }, warnings);
    if (hasFinancialPrintWarning(warnings)) {
      return { ok: false, detail: makeFinancialPrintRefusalMessage(warnings), warnings };
    }
    const data = appendCashDrawerPulse(baseBody);
    let result: DispatchResult;
    switch (printer.connection_type) {
      case 'network':
        result = await printViaNetwork(printer.ip_address, printer.port || 9100, data, signal);
        break;
      case 'usb':
        result = await printViaUSB(data, printer.name, signal);
        break;
      case 'webusb':
        // Backend never dispatches WebUSB; return the FULL bytes (including
        // the appended drawer pulse) for the renderer. The route maps this to
        // `bytes: number[]` per the test-page endpoint contract.
        return {
          ok: true,
          bytes: data,
          connection_type: 'webusb',
          ...(warnings.length > 0 ? { warnings } : {}),
        };
      default:
        result = { ok: false, detail: `Unsupported connection type: ${printer.connection_type}` };
    }
    return {
      ...result,
      bytes: data,
      connection_type: printer.connection_type,
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  } catch (error: any) {
    console.error('[Printer] Z-report dispatch failed:', error);
    return { ok: false, detail: error?.message };
  }
}
