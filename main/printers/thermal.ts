import { getDatabase, getSettingValue } from '../db';
import {
  PrinterCutMode,
  resolvePrinterProfile,
  SupportedPrinterProfile,
  dotsForPaperWidth,
  capabilitiesForPrinter,
} from './profiles';
import {
  formatBusinessDateTime,
  getCountryByCode,
  getCurrencySymbol,
  resolveRegionalSnapshot,
  resolveTenantCurrency,
  type CurrencyDisplay,
  type DigitMode,
} from '../countries';
import { correlationId, type FloErrorCode } from '../errors';
import { operationDiagnostics } from '../services/operation-diagnostics';
import { printLabel } from '../print/print-labels.generated';
import type { PrintConceptId } from '../../shared/print/concepts';
import { renderKotDocumentToLines, renderKotViaDocument } from './document-kot';
import {
  renderDeliverySlipViaDocument,
  type DeliverySlipItemRow,
  type DeliverySlipOrderRow,
} from './document-delivery-slip';
import { renderMenuViaDocument, type MenuDocument } from './document-menu';
export { escPosToText } from './escpos-preview';
export { describeWindowsPrintProcessFailure, getPrinterStatus } from './windows-print';
import {
  NETWORK_PRINT_CHUNK_DELAY_MS,
  NETWORK_PRINT_CHUNK_SIZE,
  printViaCups,
  printViaLocalIpp,
  printViaNetwork,
  printViaUSB,
} from './print-transport';
export { NETWORK_PRINT_CHUNK_DELAY_MS, NETWORK_PRINT_CHUNK_SIZE, printViaNetwork, printViaUSB };
export { detectConnectedPrinters, windowsPowerShellCommandArgs } from './printer-detection';
export type { PrinterColumnWidth, PrinterInfo } from './printer-detection';
export { buildZReportBody, printZReport } from './document-z-report';
import { rasterizeDocumentLines, rasterizeReceiptIfEnabled } from './raster-documents';
export {
  rasterizeKotDocumentForWebUsb,
  rasterizePrintDocumentForWebUsb,
  receiptDocumentLines,
} from './raster-documents';
import { formatReceipt } from './receipt-entry';
export {
  formatReceipt,
  formatClassicReceipt,
  formatCompactReceipt,
  normalizeReceiptTemplate,
  resolvePaymentMethodLabel,
  formatTableLabel,
} from './receipt-entry';
import type { DeliverySlipAddressSource } from '../../shared/print';
import type { ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import {
  buildRasterDiagnosticBands,
  encodeRasterFeedAndCut,
  encodeRasterUnits,
  rasterCapabilityEnabled,
} from '../../shared/print/raster';
import { columnsForPaperWidth as columnsForConfiguredPaperWidth } from '../../shared/print/width';
import {
  type PrintWarning,
  type RasterLineUnit,
  itemNameWidth,
  itemAmountWidth,
  itemRows,
  addonRows,
  financialRows,
  formatCurrency,
  rightAlign,
  truncate,
  truncateShapedLine,
  normalizePrintLanguage,
  wrapText,
  pushWrapped,
  pushCenteredWrapped,
  appendPoweredByFooter,
  normalizeThermalText,
  resolveCurrencyPrefix,
  appendCashDrawerPulse,
  buildEscPos,
} from './formatting-helpers';

export {
  type PrintWarning,
  type RasterLineUnit,
  itemNameWidth,
  itemAmountWidth,
  itemRows,
  addonRows,
  financialRows,
  formatCurrency,
  rightAlign,
  truncate,
  truncateShapedLine,
  normalizePrintLanguage,
  wrapText,
  pushWrapped,
  pushCenteredWrapped,
  appendPoweredByFooter,
  normalizeThermalText,
  resolveCurrencyPrefix,
  appendCashDrawerPulse,
  buildEscPos,
};

export function hasFinancialPrintWarning(warnings: readonly PrintWarning[]): boolean {
  return warnings.some((warning) => warning.kind === 'financial');
}

export function makeFinancialPrintRefusalMessage(warnings: readonly PrintWarning[]): string {
  const row = warnings.find((warning) => warning.kind === 'financial');
  return `Receipt not printed: a financial row contains unsupported printer text${row?.text ? `: ${row.text}` : '.'} Use a supported printer profile or system/browser printing.`;
}

export type PrintResult = {
  ok: boolean;
  code?: FloErrorCode;
  correlationId: string;
  stage: 'prepare' | 'dispatch';
  detail?: string;
  failureClass?: PrintFailureClass;
  platformErrorCode?: number;
  jobId?: number;
  driverName?: string;
  printerStatus?: number;
  warnings?: PrintWarning[];
};

/** Low-level dispatch result — carries the actual OS/driver reason, not just ok/fail. */
export type DispatchResult = {
  ok: boolean;
  detail?: string;
  failureClass?: PrintFailureClass;
  platformErrorCode?: number;
  jobId?: number;
  driverName?: string;
  printerStatus?: number;
  warnings?: PrintWarning[];
};

export type PrintFailureClass =
  | 'not_configured'
  | 'offline'
  | 'needs_attention'
  | 'queue_unavailable'
  | 'spooler_error'
  | 'driver_error'
  | 'permission_denied'
  | 'timeout'
  | 'write_error'
  | 'unsupported'
  | 'unknown';

const XML_ENTITIES: Record<string, string> = {
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&amp;': '&',
};

/** Strips PowerShell CLIXML serialization envelopes and extracts clean error text. */
export function sanitizePowerShellStderr(stderr?: string): string {
  if (!stderr) return '';
  const raw = String(stderr).trim();
  if (!raw.includes('#< CLIXML') && !raw.includes('<Objs')) {
    return raw;
  }

  const errorMatches: string[] = [];
  const regex = /<S S="Error">(.*?)<\/S>/gs;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(raw)) !== null) {
    const text = match[1]
      .replace(/_x000D__x000A_/g, '\n')
      .replace(/_x([0-9a-fA-F]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/&(?:lt|gt|quot|apos|amp);/g, (entity) => XML_ENTITIES[entity] ?? entity)
      .trim();
    if (text && !text.startsWith('At line:') && !text.startsWith('+ ')) {
      errorMatches.push(text);
    }
  }

  if (errorMatches.length > 0) {
    return errorMatches.join('\n').trim();
  }

  // No structured error-stream content — e.g. only progress-record CLIXML
  // (<Obj S="progress">...), as emitted by module auto-loading during
  // `Add-Type`. Strip every CLIXML envelope wherever it appears in the
  // buffer, not just a leading header, and keep the surrounding plain text.
  return raw
    .replace(/#<\s*CLIXML[\r\n]*/gi, '')
    .replace(/<Objs[^>]*>.*?<\/Objs>/gs, '')
    .replace(/_x000D__x000A_/g, '\n')
    .replace(/_x([0-9a-fA-F]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .trim();
}

// A network printer that refuses the socket is as gone as an unplugged one; the
// errnos are matched lowercased because `value` is.
const NETWORK_UNREACHABLE_RE = /\bconnect (?:econnrefused|ehostunreach|enetunreach)\b/;

/** Stable, privacy-safe classification for fleet telemetry. */
export function classifyPrintFailure(detail?: string): PrintFailureClass {
  const value = sanitizePowerShellStderr(detail).toLowerCase();
  if (!value) return 'unknown';
  if (value.includes('no printer configured') || value.includes('no windows printer configured'))
    return 'not_configured';
  // The queue the till was told to use is gone: `lp` cannot even name it. Anchored
  // on `lp:` so a Node filesystem ENOENT is not blamed on the printer.
  if (
    value.includes('lp: no such file or directory') ||
    value.includes('printer or class does not exist') ||
    value.includes('no default destination')
  )
    return 'not_configured';
  if (
    value.includes('offline') ||
    value.includes('use printer offline') ||
    value.includes('disconnected') ||
    value.includes('printer is not available') ||
    NETWORK_UNREACHABLE_RE.test(value)
  )
    return 'offline';
  // The printer is present but needs a person: paper, cover, or a vendor error flag.
  if (
    value.includes('out of paper') ||
    value.includes('paper jam') ||
    value.includes('cover is open') ||
    value.includes('needs attention') ||
    value.includes('reported an error')
  )
    return 'needs_attention';
  if (
    value.includes('not accepting') ||
    value.includes('queue is disabled') ||
    value.includes('disabled since') ||
    (value.includes('queue') && value.includes('unavailable')) ||
    value.includes('cannot open printer')
  )
    return 'queue_unavailable';
  if (
    value.includes('spool') ||
    value.includes('startdocprinter') ||
    value.includes('startpageprinter')
  )
    return 'spooler_error';
  if (value.includes('driver') || value.includes('no driver')) return 'driver_error';
  if (value.includes('access denied') || value.includes('permission')) return 'permission_denied';
  if (value.includes('timed out') || value.includes('timeout')) return 'timeout';
  if (value.includes('writeprinter') || (value.includes('accepted') && value.includes('of')))
    return 'write_error';
  if (value.includes('not supported') || value.includes('unsupported')) return 'unsupported';
  return 'unknown';
}

export function extractPlatformErrorCode(detail?: string): number | undefined {
  const match = String(detail || '').match(/\b(?:win32 error|error)\s+(\d+)\b/i);
  if (!match) return undefined;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : undefined;
}

export const isMasBuild =
  process.env.MAS_BUILD === '1' || (process as NodeJS.Process & { mas?: boolean }).mas === true;

export async function initPrinter(): Promise<void> {
  try {
    const db = getDatabase();
    const printer = db.prepare('SELECT * FROM printers WHERE is_default = 1').get() as any;
    if (printer) {
      console.log(`[Printer] Default printer: ${printer.name} (${printer.connection_type})`);
    } else {
      console.log('[Printer] No default printer configured');
    }
  } catch {
    console.log('[Printer] Printer initialization skipped (database not ready)');
  }
}

export async function printReceipt(
  order: any,
  bill: any,
  business?: any,
  template: string = 'classic',
  useUnicode: boolean = false,
  isReprint: boolean = false,
  signal?: AbortSignal,
  arabicShapingOverride?: boolean,
  language?: string,
  additionalLanguage?: string,
): Promise<DispatchResult> {
  try {
    if (signal?.aborted) return { ok: false, detail: 'Print cancelled during shutdown' };
    console.log(
      '[Printer] printReceipt called, template:',
      template,
      'useUnicode:',
      useUnicode,
      'isReprint:',
      isReprint,
    );
    const printer = getPrinterConfig();
    if (!printer) {
      console.log('[Printer] No printer configured');
      return { ok: false, detail: 'No printer configured' };
    }
    const prepared = prepareReceipt(
      order,
      bill,
      business,
      template,
      useUnicode,
      isReprint,
      arabicShapingOverride,
      language,
      additionalLanguage,
    );
    const { data, warnings, columns } = await rasterizeReceiptIfEnabled(
      prepared,
      order,
      bill,
      business,
      template,
      useUnicode,
      isReprint,
      arabicShapingOverride,
      language,
      additionalLanguage,
    );
    if (hasFinancialPrintWarning(warnings)) {
      return {
        ok: false,
        detail: makeFinancialPrintRefusalMessage(warnings),
        failureClass: 'unsupported',
        warnings,
      };
    }
    const pulseSetting = getSettingValue('cash_drawer_pulse_enabled');
    const shouldPulse =
      pulseSetting === null
        ? printer.cash_drawer_pulse_enabled === 1
        : pulseSetting === 'true' && shouldPulseForPayment(bill);
    const receiptData = shouldPulse ? appendCashDrawerPulse(data) : data;
    console.log(
      '[Printer] Using printer:',
      printer.name,
      printer.connection_type,
      'columns:',
      columns,
    );
    console.log('[Printer] Receipt data length:', receiptData.length, 'bytes');
    console.log(
      '[Printer] First 100 bytes:',
      Array.from(receiptData.slice(0, 100))
        .map((b) => b.toString(16))
        .join(' '),
    );

    const dispatch = await dispatchPrint(printer, receiptData, signal);
    return warnings.length > 0 ? { ...dispatch, warnings } : dispatch;
  } catch (error: any) {
    console.error('[Printer] Print error:', error);
    return { ok: false, detail: error?.message };
  }
}

/** Determine whether paid bill contains a payment method configured to open cash drawer. */
function shouldPulseForPayment(bill: any): boolean {
  const configured = getSettingValue('cash_drawer_pulse_methods');
  let methods: string[] = ['cash', 'card'];
  try {
    const parsed = configured ? JSON.parse(configured) : methods;
    if (Array.isArray(parsed)) {
      const valid = parsed.filter((value): value is string => typeof value === 'string');
      // Non-empty array without valid strings restores defaults; empty array stays empty.
      methods = parsed.length > 0 && valid.length === 0 ? ['cash', 'card'] : valid;
    }
  } catch {
    /* Keep the safe cash/card defaults. */
  }
  if (!bill?.payment_details) return false;
  try {
    const payments =
      typeof bill.payment_details === 'string'
        ? JSON.parse(bill.payment_details)
        : bill.payment_details;
    if (!Array.isArray(payments)) return false;
    const db = getDatabase();
    return payments.some((payment: any) => {
      if (!payment || Number(payment.amount || 0) <= 0) return false;
      let method = String(payment.method || '').toLowerCase();
      if (method === 'custom' && Number.isSafeInteger(Number(payment.payment_method_id))) {
        const row = db
          .prepare('SELECT name FROM payment_methods WHERE id = ?')
          .get(Number(payment.payment_method_id)) as { name?: string } | undefined;
        method = String(row?.name || method).toLowerCase();
      }
      return methods.some((selected) => selected.toLowerCase() === method);
    });
  } catch {
    return false;
  }
}

export async function printKOT(
  order: any,
  items: any[],
  stationName: string,
  useUnicode: boolean = false,
  targetPrinter?: any,
  signal?: AbortSignal,
  arabicShapingOverride?: boolean,
  language?: string,
): Promise<DispatchResult> {
  try {
    if (signal?.aborted) return { ok: false, detail: 'Print cancelled during shutdown' };
    console.log(
      '[Printer] printKOT called, items count:',
      items?.length || 0,
      'useUnicode:',
      useUnicode,
      'station:',
      stationName,
    );
    const printer = targetPrinter || getPrinterConfig();
    if (!printer) {
      console.log('[Printer] No printer configured');
      return { ok: false, detail: 'No printer configured' };
    }
    console.log('[Printer] Using printer:', printer.name, printer.connection_type);

    const {
      profile,
      columns: cols,
      capabilities,
    } = resolvePrinterContext(printer, arabicShapingOverride);
    const db = getDatabase();
    const biz = db.prepare('SELECT * FROM settings LIMIT 1').get() as any;
    const locale = biz?.country ? (getCountryByCode(biz.country)?.locale ?? 'en-US') : 'en-US';
    // Resolves through the country profile when the stored timezone is
    // missing or invalid, matching resolveRegionalSnapshot's own contract.
    // Throws RegionalNotConfiguredError (naming country, the actual missing
    // field) only when the country itself is unresolvable.
    const timezone = resolveRegionalSnapshot({
      country: getSettingValue('country') ?? undefined,
      currency: getSettingValue('currency') ?? undefined,
      timezone: getSettingValue('timezone') ?? undefined,
    }).timezone;
    const tzOptions = { timeZone: timezone };

    const warnings: PrintWarning[] = [];
    const nativeCapabilities = nativeFallbackCapabilities(capabilities);
    let data: Buffer;
    if (rasterCapabilityEnabled(capabilities)) {
      const documentResult = renderKotViaDocument(order, items, stationName, {
        columns: cols,
        language: normalizePrintLanguage(language ?? biz?.language),
        locale,
        timezone,
        useUnicode,
        arabicShaping: capabilities.shaping.arabic,
        cutMode: profile.cutMode,
        capabilities,
      });
      const nativeResult = renderKotViaDocument(order, items, stationName, {
        columns: cols,
        language: normalizePrintLanguage(language ?? biz?.language),
        locale,
        timezone,
        useUnicode,
        arabicShaping: nativeCapabilities.shaping.arabic,
        cutMode: profile.cutMode,
        capabilities: nativeCapabilities,
      });
      const rasterized = await rasterizeDocumentLines(
        documentResult.lines,
        documentResult.warnings,
        {
          useUnicode,
          cutMode: profile.cutMode,
          arabicShaping: capabilities.shaping.arabic,
          columns: cols,
          language: normalizePrintLanguage(language ?? biz?.language),
          capabilities,
          requestPrefix: 'kot',
        },
        documentResult.rasterGroups,
      );
      data =
        rasterized.rasterSelected && !rasterized.rasterFailed ? rasterized.data : nativeResult.data;
      if (rasterized.rasterFailed) warnings.push(...nativeResult.warnings);
      warnings.push(...rasterized.warnings);
    } else {
      data = formatKOT(
        order,
        items,
        stationName,
        cols,
        useUnicode,
        profile.cutMode,
        locale,
        tzOptions,
        warnings,
        capabilities.shaping.arabic,
        normalizePrintLanguage(language ?? biz?.language),
        capabilities,
      );
    }
    if (hasFinancialPrintWarning(warnings)) {
      return {
        ok: false,
        detail: makeFinancialPrintRefusalMessage(warnings),
        failureClass: 'unsupported',
        warnings,
      };
    }
    console.log('[Printer] KOT data length:', data.length, 'bytes');
    const dispatch = await dispatchPrint(printer, data, signal);
    return warnings.length > 0 ? { ...dispatch, warnings } : dispatch;
  } catch (error: any) {
    console.error('[Printer] KOT print error:', error);
    return { ok: false, detail: error?.message };
  }
}

/** Dispatch a rendered delivery slip to the resolved printer. */
export async function printDeliverySlip(
  order: DeliverySlipOrderRow,
  items: readonly DeliverySlipItemRow[],
  contact: {
    name?: string;
    phone?: string;
    address?: string;
    addressSource?: DeliverySlipAddressSource | null;
  },
  useUnicode: boolean = false,
  targetPrinter?: {
    readonly id?: unknown;
    readonly name?: unknown;
    readonly connection_type?: string;
    readonly paper_width?: string;
    readonly profile_id?: string;
  },
  signal?: AbortSignal,
  arabicShapingOverride?: boolean,
  language?: string,
  showCustomerPhone?: boolean,
): Promise<DispatchResult> {
  try {
    if (signal?.aborted) return { ok: false, detail: 'Print cancelled during shutdown' };
    const printer = targetPrinter || getPrinterConfig();
    if (!printer) {
      return { ok: false, detail: 'No printer configured' };
    }

    const {
      profile,
      columns: cols,
      capabilities,
    } = resolvePrinterContext(printer, arabicShapingOverride);
    getDatabase();
    // Key/value table: a `SELECT * LIMIT 1` row has no `country` property, so
    // reading it that way silently pins the slip date to en-US.
    const countryCode = getSettingValue('country') ?? '';
    const storeLanguage = getSettingValue('language') ?? undefined;
    const locale = countryCode ? (getCountryByCode(countryCode)?.locale ?? 'en-US') : 'en-US';
    const timezone = resolveRegionalSnapshot({
      country: getSettingValue('country') ?? undefined,
      currency: getSettingValue('currency') ?? undefined,
      timezone: getSettingValue('timezone') ?? undefined,
    }).timezone;
    const currency = resolveTenantCurrency(getSettingValue('currency') ?? '', countryCode);
    const currencyLocale = getCountryByCode(countryCode)?.locale ?? locale;
    const currencyDisplayValue = getSettingValue('currency_display');
    const currencyDisplay = ['rial', 'toman', 'toman_short'].includes(currencyDisplayValue ?? '')
      ? (currencyDisplayValue as CurrencyDisplay)
      : undefined;
    // Rest&Cafe renders Latin digits product-wide.
    const digits: DigitMode = 'latin';
    const currencySymbol =
      getSettingValue('currency_symbol') || getCurrencySymbol(currency, currencyLocale);

    const warnings: PrintWarning[] = [];
    const nativeCapabilities = nativeFallbackCapabilities(capabilities);
    const renderWith = (caps: ThermalPrinterCapabilities) =>
      renderDeliverySlipViaDocument(order, items, contact, {
        columns: cols,
        language: normalizePrintLanguage(language ?? storeLanguage),
        locale,
        currency,
        currencySymbol,
        currencyDisplay,
        digits,
        timezone,
        useUnicode,
        arabicShaping: caps.shaping.arabic,
        cutMode: profile.cutMode,
        capabilities: caps,
        showCustomerPhone: showCustomerPhone ?? true,
      });

    let data: Buffer;
    if (rasterCapabilityEnabled(capabilities)) {
      const documentResult = renderWith(capabilities);
      const nativeResult = renderWith(nativeCapabilities);
      const rasterized = await rasterizeDocumentLines(
        documentResult.lines,
        documentResult.warnings,
        {
          useUnicode,
          cutMode: profile.cutMode,
          arabicShaping: capabilities.shaping.arabic,
          columns: cols,
          language: normalizePrintLanguage(language ?? storeLanguage),
          capabilities,
          requestPrefix: 'delivery-slip',
        },
        documentResult.rasterGroups,
      );
      if (rasterized.rasterSelected && !rasterized.rasterFailed) {
        data = rasterized.data;
        warnings.push(...rasterized.warnings);
      } else {
        // The native bytes are going to the printer, so its warnings are the
        // ones staff must see, or an unrepresentable address reports success.
        data = nativeResult.data;
        warnings.push(...nativeResult.warnings, ...rasterized.warnings);
      }
    } else {
      const nativeResult = renderWith(capabilities);
      data = nativeResult.data;
      warnings.push(...nativeResult.warnings);
    }

    if (hasFinancialPrintWarning(warnings)) {
      return {
        ok: false,
        detail: makeFinancialPrintRefusalMessage(warnings),
        failureClass: 'unsupported',
        warnings,
      };
    }
    const dispatch = await dispatchPrint(printer, data, signal);
    return warnings.length > 0 ? { ...dispatch, warnings } : dispatch;
  } catch (error: unknown) {
    console.error('[Printer] Delivery slip print error:', error);
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function printDeliverySlipDetailed(
  ...args: Parameters<typeof printDeliverySlip>
): Promise<PrintResult> {
  const id = correlationId();
  try {
    const dispatch = await printDeliverySlip(...args);
    const result: PrintResult = dispatch.ok
      ? { ok: true, correlationId: id, stage: 'dispatch', warnings: dispatch.warnings }
      : {
          ok: false,
          code: 'print.delivery_slip.failed',
          correlationId: id,
          stage: 'dispatch',
          detail: dispatch.detail,
          failureClass: dispatch.failureClass || classifyPrintFailure(dispatch.detail),
          platformErrorCode:
            dispatch.platformErrorCode || extractPlatformErrorCode(dispatch.detail),
          jobId: dispatch.jobId,
          driverName: dispatch.driverName,
          printerStatus: dispatch.printerStatus,
          warnings: dispatch.warnings,
        };
    if (!result.ok) reportPrintFailure('delivery_slip', result);
    return result;
  } catch (error) {
    const detail = (error as Error).message;
    const result: PrintResult = {
      ok: false,
      code: 'print.delivery_slip.failed',
      correlationId: id,
      stage: 'dispatch',
      detail,
      failureClass: classifyPrintFailure(detail),
      platformErrorCode: extractPlatformErrorCode(detail),
    };
    reportPrintFailure('delivery_slip', result);
    return result;
  }
}

/**
 * Report print failure via telemetry tiers (best-effort, non-blocking).
 */
function reportPrintFailure(kind: 'receipt' | 'kot' | 'delivery_slip', result: PrintResult): void {
  let connectionType = 'unknown';
  try {
    const configured = getPrinterConfig()?.connection_type;
    if (configured === 'network' || configured === 'usb' || configured === 'webusb')
      connectionType = configured;
  } catch {
    /* best-effort only */
  }

  const failureClass = result.failureClass || classifyPrintFailure(result.detail);
  const pointStage = failureClass === 'timeout' ? 'timeout' : 'queue';
  operationDiagnostics.captureOperationFailure({
    capture_point: `fc.backend.printer.${kind}.${pointStage}`,
    outcome: result.stage === 'prepare' ? 'not_applied' : 'unknown',
    correlation_id: result.correlationId,
    facts: { connection_type: connectionType, failure_class: failureClass, kind },
  });
}

/** Typed adapters used by API callers while legacy boolean callers migrate. */
export async function printReceiptDetailed(
  ...args: Parameters<typeof printReceipt>
): Promise<PrintResult> {
  const id = correlationId();
  try {
    const dispatch = await printReceipt(...args);
    const stage =
      !dispatch.ok && hasFinancialPrintWarning(dispatch.warnings || []) ? 'prepare' : 'dispatch';
    const result: PrintResult = dispatch.ok
      ? { ok: true, correlationId: id, stage: 'dispatch', warnings: dispatch.warnings }
      : {
          ok: false,
          code: 'print.receipt.failed',
          correlationId: id,
          stage,
          detail: dispatch.detail,
          failureClass: dispatch.failureClass || classifyPrintFailure(dispatch.detail),
          platformErrorCode:
            dispatch.platformErrorCode || extractPlatformErrorCode(dispatch.detail),
          jobId: dispatch.jobId,
          driverName: dispatch.driverName,
          printerStatus: dispatch.printerStatus,
          warnings: dispatch.warnings,
        };
    if (!result.ok) reportPrintFailure('receipt', result);
    return result;
  } catch (error) {
    const detail = (error as Error).message;
    const result: PrintResult = {
      ok: false,
      code: 'print.receipt.failed',
      correlationId: id,
      stage: 'dispatch',
      detail,
      failureClass: classifyPrintFailure(detail),
      platformErrorCode: extractPlatformErrorCode(detail),
    };
    reportPrintFailure('receipt', result);
    return result;
  }
}

export async function printKOTDetailed(...args: Parameters<typeof printKOT>): Promise<PrintResult> {
  const id = correlationId();
  try {
    const dispatch = await printKOT(...args);
    const result: PrintResult = dispatch.ok
      ? { ok: true, correlationId: id, stage: 'dispatch', warnings: dispatch.warnings }
      : {
          ok: false,
          code: 'print.kot.failed',
          correlationId: id,
          stage: 'dispatch',
          detail: dispatch.detail,
          failureClass: dispatch.failureClass || classifyPrintFailure(dispatch.detail),
          platformErrorCode:
            dispatch.platformErrorCode || extractPlatformErrorCode(dispatch.detail),
          jobId: dispatch.jobId,
          driverName: dispatch.driverName,
          printerStatus: dispatch.printerStatus,
          warnings: dispatch.warnings,
        };
    if (!result.ok) reportPrintFailure('kot', result);
    return result;
  } catch (error) {
    const detail = (error as Error).message;
    const result: PrintResult = {
      ok: false,
      code: 'print.kot.failed',
      correlationId: id,
      stage: 'dispatch',
      detail,
      failureClass: classifyPrintFailure(detail),
      platformErrorCode: extractPlatformErrorCode(detail),
    };
    reportPrintFailure('kot', result);
    return result;
  }
}

function getColumnsForPrinter(printer: any, profile: SupportedPrinterProfile): number {
  const paperWidth = printer.paper_width || profile.defaultPaperWidth || '80mm';
  const explicitColumns = columnsForPaperWidth(paperWidth);
  if (explicitColumns) return explicitColumns;
  return profile.fontAColumns || 48;
}

function nativeFallbackCapabilities(
  capabilities: ThermalPrinterCapabilities,
): ThermalPrinterCapabilities {
  return capabilities.raster.enabled
    ? { ...capabilities, raster: { ...capabilities.raster, enabled: false } }
    : capabilities;
}

export function columnsForPaperWidth(paperWidth: string): number | null {
  return columnsForConfiguredPaperWidth(paperWidth);
}

export { dotsForPaperWidth, capabilitiesForPrinter };

export interface PrinterContext {
  profile: SupportedPrinterProfile;
  columns: number;
  capabilities: ThermalPrinterCapabilities;
}

/** Resolves profile, column count, and capabilities aligned with printer paper_width. */
export function resolvePrinterContext(
  printer: any,
  arabicShapingOverride?: boolean,
): PrinterContext {
  const profile = resolvePrinterProfile(printer);
  const columns = getColumnsForPrinter(printer, profile);
  const capabilities = capabilitiesForPrinter(
    profile,
    printer?.paper_width || profile.defaultPaperWidth,
    arabicShapingOverride,
  );
  return { profile, columns, capabilities };
}

async function dispatchPrint(
  printer: any,
  data: Buffer,
  signal?: AbortSignal,
): Promise<DispatchResult> {
  switch (printer.connection_type) {
    case 'network':
      return await printViaNetwork(printer.ip_address, printer.port || 9100, data, signal);
    case 'usb':
      if (isMasBuild) {
        if (process.platform === 'darwin') {
          return await printViaLocalIpp(data, printer.name, signal);
        }
        const detail =
          'USB printers are not supported in the App Store build. Use a network printer.';
        console.log(`[Printer] ${detail}`);
        return { ok: false, detail };
      }
      return await printViaUSB(data, printer.name, signal);
    case 'webusb':
      console.log('[Printer] WebUSB printer — not supported in Electron');
      return {
        ok: false,
        detail: 'WebUSB printers are handled in the browser, not by the desktop app',
      };
    default:
      console.log(`[Printer] Unsupported connection type: ${printer.connection_type}`);
      return { ok: false, detail: `Unsupported connection type: ${printer.connection_type}` };
  }
}

export function getPrinterConfig(): any {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM printers
     WHERE connection_type != 'webusb'
     ORDER BY is_default DESC, name
     LIMIT 1`,
    )
    .get();
}

export async function printMenuDocument(
  document: MenuDocument,
  signal?: AbortSignal,
  targetPrinter?: unknown,
  language = 'en',
): Promise<DispatchResult & { bytes?: Buffer; connection_type?: string }> {
  try {
    if (signal?.aborted) return { ok: false, detail: 'Print cancelled during shutdown' };
    const printer = targetPrinter || getPrinterConfig();
    if (!printer) return { ok: false, detail: 'No printer configured' };

    const { profile, columns, capabilities } = resolvePrinterContext(printer);
    let rendered = renderMenuViaDocument(document, {
      columns,
      language,
      arabicShaping: capabilities.shaping.arabic,
      cutMode: profile.cutMode,
      capabilities,
    });
    if (rasterCapabilityEnabled(capabilities)) {
      const rasterized = await rasterizeDocumentLines(rendered.lines, rendered.warnings, {
        useUnicode: false,
        cutMode: profile.cutMode,
        arabicShaping: capabilities.shaping.arabic,
        columns,
        language,
        capabilities,
        requestPrefix: 'menu',
      });
      if (rasterized.rasterFailed) {
        return { ok: false, detail: 'Menu raster rendering failed', warnings: rasterized.warnings };
      }
      rendered = { ...rendered, data: rasterized.data, warnings: rasterized.warnings };
    }
    if (rendered.warnings.length > 0) {
      return {
        ok: false,
        detail: 'Menu text is not supported by the selected printer',
        warnings: rendered.warnings,
      };
    }

    if (printer.connection_type === 'webusb') {
      return {
        ok: true,
        bytes: rendered.data,
        connection_type: 'webusb',
        ...(rendered.warnings.length > 0 ? { warnings: rendered.warnings } : {}),
      };
    }

    const result = await dispatchPrint(printer, rendered.data, signal);
    return {
      ...result,
      bytes: rendered.data,
      connection_type: printer.connection_type,
      ...(rendered.warnings.length > 0 ? { warnings: rendered.warnings } : {}),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error('[Printer] Menu print failed:', detail);
    return { ok: false, detail };
  }
}

export function prepareReceipt(
  order: any,
  bill: any,
  business?: any,
  template: string = 'classic',
  useUnicode: boolean = false,
  isReprint: boolean = false,
  arabicShapingOverride?: boolean,
  language?: string,
  additionalLanguage?: string,
): {
  printer: any;
  data: Buffer;
  warnings: PrintWarning[];
  columns: number;
} {
  let printer = getPrinterConfig();
  if (!printer) {
    printer = {
      id: 0,
      name: 'Default 80mm Preview',
      paper_width: '80mm',
    };
  }

  const { profile, columns, capabilities } = resolvePrinterContext(printer, arabicShapingOverride);
  const warnings: PrintWarning[] = [];
  const nativeCapabilities = nativeFallbackCapabilities(capabilities);
  const data = formatReceipt(
    order,
    bill,
    business,
    template,
    columns,
    useUnicode,
    isReprint,
    profile.cutMode,
    warnings,
    nativeCapabilities.shaping.arabic,
    language,
    additionalLanguage,
    nativeCapabilities,
  );
  return { printer, data, warnings, columns };
}

/** Kitchen order ticket: builds KotDocument and renders via document-kot pipeline. */
export function formatKOT(
  order: any,
  items: any[],
  stationName: string,
  cols: number = 48,
  useUnicode: boolean = false,
  cutMode: PrinterCutMode = 'full',
  locale: string = 'en-US',
  tzOptions?: any,
  warnings?: PrintWarning[],
  arabicShaping: boolean = false,
  language?: string,
  capabilities?: ThermalPrinterCapabilities,
): Buffer {
  const lang = normalizePrintLanguage(language);
  const result = renderKotViaDocument(order, items, stationName, {
    columns: cols,
    language: lang,
    ...(locale ? { locale } : {}),
    ...(tzOptions?.timeZone ? { timezone: String(tzOptions.timeZone) } : {}),
    useUnicode,
    arabicShaping,
    cutMode,
    capabilities,
  });
  if (warnings && result.warnings.length > 0) warnings.push(...result.warnings);
  return result.data;
}

export function buildTestPage(
  paperWidth: string = '80mm',
  cutMode: PrinterCutMode = 'full',
  language?: string,
  timezone?: string,
  capabilities?: ThermalPrinterCapabilities,
): Buffer {
  const width = columnsForPaperWidth(paperWidth) || 48;
  const lang = normalizePrintLanguage(language);
  const label = (concept: PrintConceptId): string =>
    normalizeThermalText(printLabel(lang, concept));
  const bar = '='.repeat(width);
  const ruler = Array.from({ length: width }, (_, i) => String((i + 1) % 10)).join('');
  const edgeProbe = 'X'.repeat(width);
  const lines = [
    '{INIT}',
    '{CENTER}{BOLD}' + label('print.test.title') + '{/BOLD}{/CENTER}',
    '',
    bar,
    '{CENTER}' + label('print.test.networkUsb') + '{/CENTER}',
    bar,
    '',
    `${label('print.test.columns')}: ${width}`,
    ...wrapText(label('print.test.wrapHint'), width),
    ruler,
    edgeProbe,
    bar,
    `${label('print.time')}: ${formatBusinessDateTime(new Date(), timezone ?? undefined)}`,
    '',
    bar,
    '{CENTER}' + label('print.test.success') + '{/CENTER}',
    bar,
    '{CUT}',
  ];
  if (!capabilities || !rasterCapabilityEnabled(capabilities))
    return buildEscPos(lines, false, { cutMode, language: lang, columns: width });
  // Explicit shaping capability prevents raster profile passing unshaped Arabic to text.
  const textData = buildEscPos(lines.slice(0, -1), false, {
    cutMode,
    language: lang,
    capabilities,
    arabicShaping: capabilities.shaping.arabic,
    columns: width,
  });
  const rasterData = encodeRasterUnits(
    [
      {
        unitId: 'diagnostic-test-page',
        financial: false,
        complete: true,
        bands: buildRasterDiagnosticBands(
          capabilities.raster.widthDots,
          capabilities.raster.maxBandHeight,
        ),
      },
    ],
    capabilities,
  );
  return Buffer.concat([
    textData,
    Buffer.from(rasterData),
    Buffer.from(encodeRasterFeedAndCut(cutMode)),
  ]);
}
