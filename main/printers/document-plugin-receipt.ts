/** Plugin receipt: merchant-installed bill templates rendered to ESC/POS lines. */

import { parseDbTimestamp } from '../db';
import {
  formatBusinessDate,
  getCountryByCode,
  getCurrencyFractionDigits,
  getCurrencySymbol,
  resolveTenantCurrency,
} from '../countries';
import { resolveTaxComponents } from '../services/tax-components';
import type { loadInstalledPrintTemplate } from '../services/print-templates';
import {
  declaredTemplateChargeRows,
  fitTemplateLabel,
  resolveTemplateLabel,
  sanitizeTemplateLabelText,
  type TemplateChargeRowId,
} from '../print/template-labels';
import { isExcludedFromBillReceipt } from '../../shared/order-item-status';
import { receiptChargeLines } from '../../shared/charges';
import { optionalPaymentAmount, projectCashTender } from '../../shared/print';
import { printLabel } from '../print/print-labels.generated';
import type { ThermalPrinterCapabilities } from '../../shared/print/thermal-capabilities';
import type { PrinterCutMode } from './profiles';
import {
  appendPoweredByFooter,
  buildEscPos,
  financialRows,
  formatCurrency,
  normalizeThermalText,
  parseAddons,
  pushCenteredWrapped,
  pushWrapped,
  resolveCurrencyPrefix,
  truncate,
  truncateShapedLine,
  type PrintWarning,
} from './formatting-helpers';
import {
  formatClassicReceipt,
  formatTableLabel,
  pluginDetailLines,
  pluginItemHeader,
  pluginItemRows,
  pluginSummaryRow,
  resolvePaymentMethodLabel,
} from './receipt-entry';

export function renderPluginReceipt(
  template: ReturnType<typeof loadInstalledPrintTemplate>,
  order: any,
  bill: any,
  biz: any,
  cols: number,
  useUnicode: boolean,
  isReprint: boolean,
  cutMode: PrinterCutMode,
  warnings?: PrintWarning[],
  arabicShaping: boolean = false,
  lang: string = 'en',
  capabilities?: ThermalPrinterCapabilities,
): Buffer {
  if (!template)
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
      undefined,
      capabilities,
    );
  const renderer = parseJson(template.renderer_json, {}) as { id?: string; version?: number };
  const payload = parseJson(template.template_payload_json, {}) as any;
  if (
    renderer.id !== 'flocafe-thermal-receipt-template' ||
    renderer.version !== 1 ||
    payload.format !== 'escpos-line-template-v1'
  ) {
    throw new Error(`Unsupported receipt plugin renderer for template ${template.template_id}`);
  }
  const profile = selectTemplateWidthProfile(payload, cols, warnings);
  return renderEscposLineTemplateV1(
    payload,
    profile,
    order,
    bill,
    biz,
    useUnicode,
    isReprint,
    cutMode,
    warnings,
    arabicShaping,
    lang,
    capabilities,
  );
}

function parseJson(raw: string, fallback: unknown): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function selectTemplateWidthProfile(
  payload: any,
  printerColumns: number,
  warnings?: PrintWarning[],
): { columns: number; layout: any } {
  const profiles = collectTemplateWidthProfiles(payload);
  const exact = profiles.find((profile) => profile.columns === printerColumns);
  if (exact) return exact;
  const smaller = profiles
    .filter((profile) => profile.columns < printerColumns)
    .sort((a, b) => b.columns - a.columns)[0];
  if (smaller) return smaller;

  warnings?.push({
    field: 'bill_template_width',
    text: String(printerColumns),
    message: `Template has no ${printerColumns}-column profile; rendered with the printer width instead of squeezing a wider profile.`,
  });
  return { columns: printerColumns, layout: {} };
}

function collectTemplateWidthProfiles(payload: any): Array<{ columns: number; layout: any }> {
  if (!Array.isArray(payload?.widthProfiles)) return [];
  return payload.widthProfiles
    .map((profile: any) => ({
      columns: Number(profile?.columns),
      layout: profile?.layout && typeof profile.layout === 'object' ? profile.layout : {},
    }))
    .filter(
      (profile: { columns: number }) =>
        Number.isInteger(profile.columns) && profile.columns >= 32 && profile.columns <= 48,
    )
    .sort((a: { columns: number }, b: { columns: number }) => a.columns - b.columns);
}

/** Template charge-row ids are camelCase; the engine breakdown stores snake_case ids. */
const TEMPLATE_ROW_TO_CHARGE_ID: Partial<Record<TemplateChargeRowId, string>> = {
  serviceCharge: 'service_charge',
  packagingCharge: 'packaging_charge',
};

function renderEscposLineTemplateV1(
  payload: any,
  profile: { columns: number; layout: any },
  order: any,
  bill: any,
  biz: any,
  useUnicode: boolean,
  isReprint: boolean,
  cutMode: PrinterCutMode,
  warnings?: PrintWarning[],
  arabicShaping: boolean = false,
  lang: string = 'en',
  capabilities?: ThermalPrinterCapabilities,
): Buffer {
  const lines: string[] = [];
  const financialLineRanges: Array<{ lineIndex: number; lineCount: number }> = [];
  const pushFinancialLines = (financialLines: string[]): void => {
    if (financialLines.length === 0) return;
    financialLineRanges.push({ lineIndex: lines.length, lineCount: financialLines.length });
    lines.push(...financialLines);
  };
  const cols = profile.columns;
  const layout = profile.layout || {};
  const date = parseDbTimestamp(order.created_at);
  const bar = '='.repeat(cols);
  const dash = '-'.repeat(cols);
  const currency = resolveTenantCurrency(biz.currency, biz.country);
  const fractionDigits = getCurrencyFractionDigits(currency);
  const trimDecimals = biz.trim_decimals === true;
  const locale = getCountryByCode(biz.country)?.locale ?? 'en-US';
  // Rest&Cafe: the owner's stored currency unit (biz.currency_symbol, e.g.
  // SP) wins over the CLDR symbol on printed bills.
  const prefix = resolveCurrencyPrefix(
    biz.currency_symbol || getCurrencySymbol(currency, locale) || currency,
    useUnicode,
    capabilities,
    false,
    currency,
  );
  const normalize = (text: string): string => normalizeThermalText(text, capabilities);
  const configuredTaxLabel = normalize(
    sanitizeTemplateLabelText(
      String(
        payload?.fields?.taxRegistrationNumberLabel ||
          getCountryByCode(biz.country)?.taxIdLabel ||
          'Tax ID',
      ),
    ),
  );
  const taxComponents = resolveTaxComponents({ ...bill, items: order.items });
  const hasTax =
    Number(bill.tax_amount) !== 0 || taxComponents.some((component) => component.amount !== 0);
  // Sanitize pack strings against reserved tokens and clamp to selected width profile.
  const title = hasTax
    ? fitTemplateLabel(normalize(String(payload?.header?.taxTitleWhenTaxPresent || '')), cols) ||
      fitTemplateLabel(normalize(resolveTemplateLabel(payload?.labels, 'taxInvoice', lang)), cols)
    : fitTemplateLabel(normalize(String(payload?.header?.titleWhenTaxAbsent || '')), cols) ||
      fitTemplateLabel(normalize(resolveTemplateLabel(payload?.labels, 'invoice', lang)), cols);
  const tzOptions = biz.timezone ? { timeZone: biz.timezone } : undefined;

  lines.push('{INIT}');
  if (isReprint)
    lines.push(
      '{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}** ' +
        normalize(printLabel(lang, 'receipt.reprint')) +
        ' **{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}',
    );
  if (biz.show_name !== false && biz.name) {
    const name =
      payload?.header?.businessNameTransform === 'uppercase'
        ? String(biz.name).toUpperCase()
        : String(biz.name);
    lines.push(
      '{STORE_NAME}{CENTER}{BOLD}' +
        truncateShapedLine(name, cols, arabicShaping, lang, capabilities) +
        '{/BOLD}{/CENTER}',
    );
  }
  lines.push(bar);
  lines.push(`{CENTER}${title}{/CENTER}`);
  lines.push(bar);
  lines.push(
    normalize(printLabel(lang, 'print.invoiceNumber')) +
      ' ' +
      (bill.bill_number || order.order_number),
  );
  lines.push(
    normalize(printLabel(lang, 'receipt.date')) +
      ': ' +
      formatBusinessDate(date, tzOptions?.timeZone),
  );
  lines.push(
    normalize(printLabel(lang, 'print.time')) +
      ': ' +
      date.toLocaleTimeString(locale + '-u-nu-latn', tzOptions),
  );
  if (biz.show_table_number !== false && order.table?.name)
    lines.push(
      truncateShapedLine(
        formatTableLabel(order.table.name, lang),
        cols,
        arabicShaping,
        lang,
        capabilities,
      ),
    );
  // The heading marks these as the customer's details, so a receipt that also
  // prints the store address cannot read as carrying a second business address.
  const deliveryAddress = String(order?.delivery_address ?? '').trim();
  if (deliveryAddress.length > 0) lines.push(normalize(printLabel(lang, 'print.customerDetails')));
  if (biz.show_customer_name !== false && biz.customer_name)
    lines.push(
      truncateShapedLine(
        printLabel(lang, 'pos.customer') + ': ' + biz.customer_name,
        cols,
        arabicShaping,
        lang,
        capabilities,
      ),
    );
  if (biz.show_customer_phone !== false && biz.customer_phone)
    lines.push(normalize(printLabel(lang, 'print.numberShort')) + ': ' + biz.customer_phone);
  if (deliveryAddress.length > 0) {
    // Wrapped, not truncated, so the courier reads the whole address.
    pushWrapped(
      lines,
      normalize(printLabel(lang, 'print.deliverySlip.address')) + ': ' + deliveryAddress,
      cols,
      lang,
      capabilities,
    );
  }
  lines.push(dash);
  lines.push(pluginItemHeader(layout, cols, lang, capabilities));
  lines.push(dash);

  if (order.items) {
    for (const item of order.items) {
      if (isExcludedFromBillReceipt(item.status)) continue;
      pushFinancialLines(
        pluginItemRows(
          item,
          layout,
          cols,
          prefix,
          locale,
          trimDecimals,
          fractionDigits,
          lang,
          capabilities,
        ),
      );
      if (pluginDetailLines(layout).includes('addons')) {
        for (const addon of parseAddons(item.addons)) {
          const addonLines: string[] = [];
          pushWrapped(
            addonLines,
            '  + ' +
              addon.name +
              (addon.price
                ? ' ' + formatCurrency(addon.price, prefix, locale, trimDecimals, fractionDigits)
                : ''),
            cols,
            lang,
            capabilities,
          );
          if (addon.price) pushFinancialLines(addonLines);
          else lines.push(...addonLines);
        }
      }
      if (pluginDetailLines(layout).includes('specialInstructions') && item.special_instructions) {
        pushWrapped(
          lines,
          '  ' + normalize(printLabel(lang, 'print.note')) + ': ' + item.special_instructions,
          cols,
          lang,
          capabilities,
        );
      }
    }
  }

  lines.push(dash);
  // Row labels share line with right-aligned amount; clamped with 12-column reserve.
  const rowLabelWidth = Math.max(8, cols - 12);
  if (payload?.totals?.showSubtotal !== false) {
    const label = fitTemplateLabel(
      normalize(resolveTemplateLabel(payload?.labels, 'subtotal', lang)),
      rowLabelWidth,
    );
    pushFinancialLines(
      financialRows(
        label,
        formatCurrency(bill.subtotal, prefix, locale, trimDecimals, fractionDigits),
        cols,
        lang,
        capabilities,
      ),
    );
  }
  if (Number(bill.discount_amount) > 0 && payload?.totals?.showDiscount !== false) {
    const label = fitTemplateLabel(
      normalize(resolveTemplateLabel(payload?.labels, 'discount', lang)),
      rowLabelWidth,
    );
    pushFinancialLines(
      financialRows(
        label,
        '-' + formatCurrency(bill.discount_amount, prefix, locale, trimDecimals, fractionDigits),
        cols,
        lang,
        capabilities,
      ),
    );
  }
  if (biz.show_tax_breakdown !== false && taxComponents.length > 0) {
    for (const tax of taxComponents) {
      if (tax.amount === 0) continue;
      const rawLabel = tax.rate === null ? tax.title : `${tax.title} @${tax.rate}%`;
      pushFinancialLines([
        pluginSummaryRow(
          rawLabel,
          formatCurrency(tax.amount, prefix, locale, trimDecimals, fractionDigits),
          layout,
          cols,
          lang,
          capabilities,
        ),
      ]);
    }
  } else if (Number(bill.tax_amount) !== 0) {
    const label = fitTemplateLabel(
      normalize(resolveTemplateLabel(payload?.labels, 'tax', lang)),
      rowLabelWidth,
    );
    pushFinancialLines(
      financialRows(
        label,
        formatCurrency(bill.tax_amount, prefix, locale, trimDecimals, fractionDigits),
        cols,
        lang,
        capabilities,
      ),
    );
  }
  // chargeRows capability declaration preserves stable country/legal row order.
  // When the bill carries an engine breakdown it is the itemised source of truth,
  // so the standard rows it already covers are not repeated below.
  const itemisedCharges = receiptChargeLines(bill.charges_breakdown);
  const itemisedIds = new Set(itemisedCharges.map((charge) => charge.id));
  const chargeAmounts: Record<TemplateChargeRowId, number> = {
    serviceCharge: Number(bill.service_charge) || 0,
    deliveryCharge: Number(bill.delivery_charge) || 0,
    packagingCharge: Number(bill.packaging_charge) || 0,
  };
  for (const row of declaredTemplateChargeRows(payload?.totals?.chargeRows)) {
    const amount = chargeAmounts[row];
    if (amount === 0) continue;
    const chargeId = TEMPLATE_ROW_TO_CHARGE_ID[row] ?? row;
    if (itemisedIds.has(chargeId)) continue;
    const label = fitTemplateLabel(
      normalize(resolveTemplateLabel(payload?.labels, row, lang)),
      rowLabelWidth,
    );
    pushFinancialLines(
      financialRows(
        label,
        formatCurrency(amount, prefix, locale, trimDecimals, fractionDigits),
        cols,
        lang,
        capabilities,
      ),
    );
  }
  // Merchant-named surcharges have no catalog label; the configured name is the
  // label, so only the amount needs formatting.
  for (const charge of itemisedCharges) {
    pushFinancialLines(
      financialRows(
        charge.name,
        formatCurrency(charge.amount, prefix, locale, trimDecimals, fractionDigits),
        cols,
        lang,
        capabilities,
      ),
    );
  }
  lines.push(bar);
  // Label precedence: template literal wins, then labels map, then localized catalog.
  const totalLabel =
    fitTemplateLabel(normalize(String(payload?.totals?.grandTotalLabel || '')), rowLabelWidth) ||
    fitTemplateLabel(
      normalize(resolveTemplateLabel(payload?.labels, 'total', lang)),
      rowLabelWidth,
    );
  pushFinancialLines(
    financialRows(
      totalLabel,
      formatCurrency(bill.total, prefix, locale, trimDecimals, fractionDigits),
      cols,
      lang,
      capabilities,
    ).map((line) => `{BOLD}${line}{/BOLD}`),
  );

  if (bill.payment_details) {
    lines.push(dash);
    try {
      const payments =
        typeof bill.payment_details === 'string'
          ? JSON.parse(bill.payment_details)
          : bill.payment_details;
      if (payments && Array.isArray(payments)) {
        for (const payment of payments) {
          if (payment && payment.method) {
            const amount = Number(payment.amount) || 0;
            const methodLabel = truncate(
              resolvePaymentMethodLabel(String(payment.method), lang),
              cols - 12,
              lang,
              capabilities,
            );
            pushFinancialLines(
              financialRows(
                methodLabel,
                formatCurrency(amount, prefix, locale, trimDecimals, fractionDigits),
                cols,
                lang,
                capabilities,
              ),
            );
            const tender = projectCashTender({
              method: String(payment.method),
              amount,
              tendered: optionalPaymentAmount(payment.tendered_amount),
              change: optionalPaymentAmount(payment.change_amount),
            });
            if (tender) {
              const tenderedLabel = truncate(
                printLabel(lang, 'receipt.cashReceived'),
                cols - 12,
                lang,
                capabilities,
              );
              pushFinancialLines(
                financialRows(
                  tenderedLabel,
                  formatCurrency(tender.tendered, prefix, locale, trimDecimals, fractionDigits),
                  cols,
                  lang,
                  capabilities,
                ),
              );
              if (tender.change > 0) {
                const changeLabel = truncate(
                  printLabel(lang, 'pos.changeReturned'),
                  cols - 12,
                  lang,
                  capabilities,
                );
                pushFinancialLines(
                  financialRows(
                    changeLabel,
                    formatCurrency(tender.change, prefix, locale, trimDecimals, fractionDigits),
                    cols,
                    lang,
                    capabilities,
                  ),
                );
              }
            }
          }
        }
      }
    } catch (err: any) {
      console.warn('[Printer] Failed to parse payment details JSON:', err.message);
    }
  }

  lines.push(bar);
  if (biz.show_address !== false && biz.address)
    pushWrapped(
      lines,
      normalize(printLabel(lang, 'print.address')) + ': ' + biz.address,
      cols,
      lang,
      capabilities,
    );
  if (biz.show_phone !== false && biz.phone)
    pushWrapped(
      lines,
      normalize(printLabel(lang, 'print.phoneLong')) + ': ' + biz.phone,
      cols,
      lang,
      capabilities,
    );
  const showTaxRegistration =
    payload?.totals?.showTaxRegistrationNumber === 'when_tax_present_or_enabled'
      ? hasTax || biz.show_tax_id === true
      : biz.show_tax_id === true;
  if (showTaxRegistration && biz.taxRegistrationNumber)
    pushWrapped(
      lines,
      configuredTaxLabel + ': ' + biz.taxRegistrationNumber,
      cols,
      lang,
      capabilities,
    );
  if (payload?.footer?.useConfiguredFooterNote !== false && biz.footer_note)
    pushCenteredWrapped(lines, biz.footer_note, cols, lang, capabilities);
  else
    lines.push(
      '{CENTER}' +
        (fitTemplateLabel(normalize(String(payload?.footer?.defaultMessage || '')), cols) ||
          fitTemplateLabel(
            normalize(resolveTemplateLabel(payload?.labels, 'footerThanks', lang)),
            cols,
          )) +
        '{/CENTER}',
    );
  if (payload?.footer?.includePoweredByFloPOS !== false) appendPoweredByFooter(lines, cols);
  lines.push('{CUT}');

  return buildEscPos(
    lines,
    useUnicode,
    { cutMode, arabicShaping, columns: cols, language: lang, capabilities, financialLineRanges },
    warnings,
  );
}
