/** Raster documents: PrintDocument → raster lines / WebUSB payloads. */

import { parseBillTemplateSelection } from '../services/print-templates';
import {
  renderBillDocumentToClassicLines,
  renderClassicReceiptViaDocument,
} from './document-classic';
import {
  renderBillDocumentToCompactLines,
  renderCompactReceiptViaDocument,
} from './document-compact';
import { renderKotDocumentToLines } from './document-kot';
import { buildEscPos, normalizePrintLanguage, type PrintWarning } from './formatting-helpers';
import { capabilitiesForPrinter, resolvePrinterProfile, type PrinterCutMode } from './profiles';
import { rasterCapabilityEnabled, type RasterSemanticLineGroup } from '../../shared/print/raster';
import type { PrintDocument } from '../../shared/print/document';
import {
  isThermalTextRepresentable,
  type ThermalPrinterCapabilities,
} from '../../shared/print/thermal-capabilities';
import {
  hasFinancialPrintWarning,
  makeFinancialPrintRefusalMessage,
  normalizeReceiptTemplate,
  resolvePrinterContext,
  type prepareReceipt,
} from './thermal';

type RasterDocumentLines = {
  lines: string[];
  warnings: PrintWarning[];
  rasterGroups?: readonly RasterSemanticLineGroup[];
};
type RasterBusinessInput = Record<string, unknown> | null | undefined;

export function receiptDocumentLines(
  order: unknown,
  bill: unknown,
  business: RasterBusinessInput,
  template: string,
  columns: number,
  useUnicode: boolean,
  isReprint: boolean,
  arabicShaping: boolean,
  language: string,
  additionalLanguage: string | undefined,
  cutMode: PrinterCutMode,
  capabilities: ThermalPrinterCapabilities,
): RasterDocumentLines | null {
  // See formatReceipt's identical placeholder below for why country + currency are both required.
  const biz = business || {
    name: 'Store',
    address: '',
    phone: '',
    taxRegistrationNumber: '',
    country: 'US',
    currency: 'USD',
  };
  const rasterBiz = { ...biz };
  const selection = parseBillTemplateSelection(template);
  if (selection?.source === 'pack' || selection?.source === 'merchant') return null;
  const normalizedTemplate = normalizeReceiptTemplate(
    selection?.source === 'core' ? selection.id : template,
  );
  const result =
    normalizedTemplate === 'compact'
      ? renderCompactReceiptViaDocument(order, bill, rasterBiz, {
          columns,
          language,
          ...(additionalLanguage !== undefined ? { additionalLanguage } : {}),
          isReprint,
          useUnicode,
          arabicShaping,
          cutMode,
          capabilities,
          preserveCurrencySymbol: true,
          maskCustomerPhone: false,
        })
      : renderClassicReceiptViaDocument(order, bill, rasterBiz, {
          columns,
          language,
          ...(additionalLanguage !== undefined ? { additionalLanguage } : {}),
          isReprint,
          useUnicode,
          arabicShaping,
          cutMode,
          capabilities,
          preserveCurrencySymbol: true,
          maskCustomerPhone: false,
        });
  return result;
}

export async function rasterizeDocumentLines(
  lines: string[],
  sourceWarnings: readonly PrintWarning[],
  options: {
    useUnicode: boolean;
    cutMode: PrinterCutMode;
    arabicShaping: boolean;
    columns: number;
    language: string;
    capabilities: ThermalPrinterCapabilities;
    requestPrefix: string;
  },
  rasterGroups?: readonly RasterSemanticLineGroup[],
): Promise<{
  data: Buffer;
  warnings: PrintWarning[];
  rasterSelected: boolean;
  rasterFailed: boolean;
}> {
  const financialRasterContent = (rasterGroups ?? []).some((group) => {
    const sourceLines =
      group.sourceLines ?? lines.slice(group.lineIndex, group.lineIndex + group.lineCount);
    return sourceLines.some((line, index) => {
      const financial = group.financialSourceLines?.[index] ?? group.financial === true;
      return (
        financial && line.length > 0 && !isThermalTextRepresentable(line, options.capabilities)
      );
    });
  });
  let selectedFinancial = financialRasterContent;
  const failureResult = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const financial = selectedFinancial;
    const warnings = sourceWarnings.filter(
      (warning) => warning.kind !== 'line' && warning.kind !== 'financial',
    );
    warnings.push({
      field: financial ? 'financial row' : 'raster renderer',
      text: '',
      message: `Raster rendering failed: ${message}`,
      kind: financial ? 'financial' : 'line',
    });
    return { data: Buffer.alloc(0), warnings, rasterSelected: false, rasterFailed: true };
  };
  let renderer: Pick<import('./raster-renderer').ChromiumRasterRenderer, 'render'> | undefined;
  let result = failureResult(new Error('Raster renderer was not initialized'));
  try {
    const { getSharedRasterRenderer, renderUnsupportedRasterLines } =
      await import('./raster-renderer');
    renderer = getSharedRasterRenderer();
    const raster = await renderUnsupportedRasterLines(
      renderer,
      lines,
      options.capabilities,
      options.requestPrefix,
      rasterGroups,
    );
    selectedFinancial =
      raster.units.some((unit) => unit.unit.financial) ||
      raster.failures.some((failure) => failure.financial);
    const warnings = sourceWarnings.filter(
      (warning) => warning.kind !== 'line' && warning.kind !== 'financial',
    );
    const data = buildEscPos(
      lines,
      options.useUnicode,
      {
        cutMode: options.cutMode,
        arabicShaping: options.arabicShaping,
        columns: options.columns,
        language: options.language,
        capabilities: options.capabilities,
        rasterUnits: raster.units,
        rasterFailures: raster.failures,
      },
      warnings,
    );
    for (const failure of raster.failures) {
      warnings.push({
        field: failure.financial ? 'financial row' : 'receipt line',
        text: failure.text,
        message: `Raster rendering failed (${failure.code}): ${failure.detail}`,
        kind: failure.financial ? 'financial' : 'line',
      });
    }
    result = {
      data,
      warnings,
      rasterSelected: raster.units.length > 0,
      rasterFailed:
        raster.failures.length > 0 ||
        warnings.some((warning) => warning.kind === 'line' || warning.kind === 'financial'),
    };
  } catch (error) {
    result = failureResult(error);
  }
  return result;
}

export async function rasterizePrintDocumentForWebUsb(
  document: PrintDocument,
  template: 'classic' | 'compact',
  profileId: string,
  options: {
    columns: number;
    language: string;
    locale: string;
    currency: string;
    currencySymbol: string;
    trimDecimals: boolean;
    useUnicode: boolean;
    arabicShaping: boolean;
    timezone?: string;
  },
): Promise<
  | {
      ok: true;
      data: Buffer;
      warnings: PrintWarning[];
      rasterSelected: boolean;
      rasterFailed: boolean;
    }
  | { ok: false; error: string }
> {
  const profile = resolvePrinterProfile({ profile_id: profileId });
  const capabilities = capabilitiesForPrinter(
    profile,
    `cols-${options.columns}`,
    options.arabicShaping,
  );
  if (!rasterCapabilityEnabled(capabilities, 'mixed'))
    return { ok: false, error: 'Raster output is not enabled for this printer profile' };
  const rasterGroups: RasterSemanticLineGroup[] = [];
  const lines =
    template === 'compact'
      ? renderBillDocumentToCompactLines(document, {
          ...options,
          preserveCurrencySymbol: true,
          cutMode: profile.cutMode,
          capabilities,
          maskCustomerPhone: false,
          rasterGroups,
        })
      : renderBillDocumentToClassicLines(document, {
          ...options,
          preserveCurrencySymbol: true,
          cutMode: profile.cutMode,
          capabilities,
          maskCustomerPhone: false,
          rasterGroups,
        });
  const result = await rasterizeDocumentLines(
    lines,
    [],
    {
      ...options,
      cutMode: profile.cutMode,
      capabilities,
      requestPrefix: 'webusb-receipt',
    },
    rasterGroups,
  );
  if (hasFinancialPrintWarning(result.warnings)) {
    return { ok: false, error: makeFinancialPrintRefusalMessage(result.warnings) };
  }
  return {
    ok: true,
    data: result.data,
    warnings: result.warnings,
    rasterSelected: result.rasterSelected,
    rasterFailed: result.rasterFailed,
  };
}

export async function rasterizeKotDocumentForWebUsb(
  document: import('../../shared/print/document').KotDocument,
  profileId: string,
  options: {
    columns: number;
    language: string;
    locale: string;
    timezone?: string;
    useUnicode: boolean;
    arabicShaping: boolean;
  },
): Promise<
  | {
      ok: true;
      data: Buffer;
      warnings: PrintWarning[];
      rasterSelected: boolean;
      rasterFailed: boolean;
    }
  | { ok: false; error: string }
> {
  const profile = resolvePrinterProfile({ profile_id: profileId });
  const capabilities = capabilitiesForPrinter(
    profile,
    `cols-${options.columns}`,
    options.arabicShaping,
  );
  if (!rasterCapabilityEnabled(capabilities, 'mixed'))
    return { ok: false, error: 'Raster output is not enabled for this printer profile' };
  const rasterGroups: RasterSemanticLineGroup[] = [];
  const lines = renderKotDocumentToLines(document, {
    ...options,
    cutMode: profile.cutMode,
    capabilities,
    rasterGroups,
  });
  const result = await rasterizeDocumentLines(
    lines,
    [],
    {
      ...options,
      cutMode: profile.cutMode,
      capabilities,
      requestPrefix: 'webusb-kot',
    },
    rasterGroups,
  );
  if (hasFinancialPrintWarning(result.warnings)) {
    return { ok: false, error: makeFinancialPrintRefusalMessage(result.warnings) };
  }
  return {
    ok: true,
    data: result.data,
    warnings: result.warnings,
    rasterSelected: result.rasterSelected,
    rasterFailed: result.rasterFailed,
  };
}

export async function rasterizeReceiptIfEnabled(
  prepared: ReturnType<typeof prepareReceipt>,
  order: unknown,
  bill: unknown,
  business: RasterBusinessInput,
  template: string,
  useUnicode: boolean,
  isReprint: boolean,
  arabicShapingOverride: boolean | undefined,
  language: string | undefined,
  additionalLanguage: string | undefined,
): Promise<ReturnType<typeof prepareReceipt>> {
  const { profile, capabilities } = resolvePrinterContext(prepared.printer, arabicShapingOverride);
  if (!rasterCapabilityEnabled(capabilities)) return prepared;
  const document = receiptDocumentLines(
    order,
    bill,
    business,
    template,
    prepared.columns,
    useUnicode,
    isReprint,
    capabilities.shaping.arabic,
    normalizePrintLanguage(language),
    additionalLanguage === undefined ? undefined : normalizePrintLanguage(additionalLanguage),
    profile.cutMode,
    capabilities,
  );
  if (!document) return prepared;
  const result = await rasterizeDocumentLines(
    document.lines,
    document.warnings,
    {
      useUnicode,
      cutMode: profile.cutMode,
      arabicShaping: capabilities.shaping.arabic,
      columns: prepared.columns,
      language: normalizePrintLanguage(language),
      capabilities,
      requestPrefix: 'receipt',
    },
    document.rasterGroups,
  );
  if (result.rasterFailed) {
    return { ...prepared, warnings: [...prepared.warnings, ...result.warnings] };
  }
  return result.rasterSelected
    ? { ...prepared, data: result.data, warnings: result.warnings }
    : prepared;
}
