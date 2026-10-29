'use client';

import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { isPrintCancelledOnTenantChangeError, usePrinterStore } from '@/hooks/usePrinter';
import { showPrintWarningsToast } from '@/lib/printer/warnings-toast';
import { formatKotErrorToast, formatReceiptErrorToast } from '@/lib/printer/warnings';
import type { Bill, Order } from '@/lib/types';
import type { SupportOperationFailure } from '@/lib/pos/order-attempts';

export interface PosPrintingFailureEntry {
  code: string;
  title: string;
  message: string;
  nextStep: string;
  detail: string;
  status: number | null;
  operation: string;
  stage: string;
  outcome: string;
  classification?: string;
  reasonCode?: string | null;
  correlationId?: string | null;
  operationFailure?: SupportOperationFailure;
}

export interface UsePosPrintingOptions {
  reportOrderFailure: (entry: PosPrintingFailureEntry) => void;
}

/** POS printing helpers, moved from the POS page without behavior change. */
export function usePosPrinting({ reportOrderFailure }: UsePosPrintingOptions) {
  const t = useTranslations('pos');
  const { currentTenant } = useAuthStore();
  const { kotPrintingEnabled, autoPrintKot, autoPrintBill } = usePosSettingsStore();
  const { printBill, printKot } = usePrinterStore();

  const printKotIfEnabled = async (order: Order) => {
    // Master kot_printing_enabled check gates both manual and automatic prints.
    if (!kotPrintingEnabled) return;
    if (!autoPrintKot) return;

    try {
      const printWarnings = await printKot(order, order.items ? { items: order.items } : undefined);
      showPrintWarningsToast(printWarnings);
    } catch (err) {
      console.error('[POS] KOT print failed:', err);
      const code = 'printer.queue_failed';
      reportOrderFailure({
        code,
        title: t('printingFailed'),
        message: t('saleCompletePrintFailed'),
        nextStep: t('saleCompleteReprintNextStep'),
        detail: 'Kitchen ticket printing failed after the order was created',
        status: null,
        operation: 'printer.print',
        stage: 'printing',
        outcome: 'unknown',
        reasonCode: code,
      });
      toast.error(formatKotErrorToast(t('kotPrintFailed'), t('saleCompletePrintFailed')));
    }
  };

  const fetchLatestBill = async (billId: number): Promise<Bill> => {
    const { data } = await api.get(`/bills/${billId}`);
    return data.bill as Bill;
  };

  const printBillForTenant = async (bill: Bill, force = false, reservedWindow?: Window | null) => {
    if (
      !currentTenant ||
      useAuthStore.getState().currentTenant?.id !== currentTenant.id ||
      (!force && !autoPrintBill)
    ) {
      if (reservedWindow && !reservedWindow.closed) reservedWindow.close();
      return;
    }

    try {
      const printWarnings = await printBill(bill, currentTenant, undefined, reservedWindow);
      showPrintWarningsToast(printWarnings);
    } catch (err) {
      if (isPrintCancelledOnTenantChangeError(err)) return;
      // Non-fatal: print failure should not block the checkout flow.
      const code = 'print.receipt.failed';
      console.error('[POS] Receipt print failed:', err);
      reportOrderFailure({
        code,
        title: t('printingFailed'),
        message: t('saleCompletePrintFailed'),
        nextStep: t('saleCompleteReprintNextStep'),
        detail: 'Receipt printing failed after payment was completed',
        status: null,
        operation: 'printer.print',
        stage: 'printing',
        outcome: 'unknown',
        reasonCode: code,
      });
      toast.error(formatReceiptErrorToast(t('receiptPrintFailed'), t('saleCompletePrintFailed')));
    }
  };

  return { printKotIfEnabled, fetchLatestBill, printBillForTenant };
}
