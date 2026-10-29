'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useCartStore } from '@/store/cart';
import { usePrinterStore } from '@/hooks/usePrinter';
import { showPrintWarningsToast } from '@/lib/printer/warnings-toast';
import type { Bill, Order, Table } from '@/lib/types';

export interface UsePosTableWorkspaceOptions {
  tables: Table[];
  refreshTables: () => Promise<void>;
  handleAddItemsToOrder: (table: Table, order: Order) => void;
}

export interface UsePosTableWorkspaceResult {
  wsParams: { table: string; hall: string; order: string };
  wsTable: Table | null;
  wsOrder: Order | null;
  wsBillBusy: boolean;
  handleWsRequestBill: () => Promise<void>;
  goWsTable: (tb: Table) => void;
}

/** POS table workspace binding, moved from the POS page without behavior change. */
export function usePosTableWorkspace({
  tables,
  refreshTables,
  handleAddItemsToOrder,
}: UsePosTableWorkspaceOptions): UsePosTableWorkspaceResult {
  const router = useRouter();
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const tTables = useTranslations('tables');
  const { currentTenant } = useAuthStore();
  const cart = useCartStore();
  const { printBill } = usePrinterStore();

  // Cashier table workspace: POS opened from the table map carries the
  // table (and its active order) in the query string.
  const [wsParams, setWsParams] = useState(() => {
    if (typeof window === 'undefined') return { table: '', hall: '', order: '' };
    const q = new URLSearchParams(window.location.search);
    return {
      table: q.get('table') || '',
      hall: q.get('hall') || '',
      order: q.get('order') || '',
    };
  });
  // The one-shot capture above can run before the router has applied the
  // workspace URL (prerender/hydration in the static export); if it came up
  // empty, re-read the query once the real URL is visible so the workspace
  // binding is never silently lost.
  useEffect(() => {
    if (wsParams.table || typeof window === 'undefined') return;
    const q = new URLSearchParams(window.location.search);
    const table = q.get('table') || '';
    if (table) {
      setWsParams({ table, hall: q.get('hall') || '', order: q.get('order') || '' });
    }
  }, [wsParams.table]);
  const [wsTable, setWsTable] = useState<Table | null>(null);
  const [wsOrder, setWsOrder] = useState<Order | null>(null);
  const [wsBillBusy, setWsBillBusy] = useState(false);
  const wsInitRef = useRef(false);

  // Workspace entry: bind the cart to the table from the map, and when the
  // table already has an active order, switch the cart into append mode on
  // that order through the same path the table checkout modal uses.
  useEffect(() => {
    if (wsInitRef.current || !wsParams.table || tables.length === 0) return;
    const table = tables.find((tb) => String(tb.id) === wsParams.table);
    if (!table) {
      // The linked table no longer exists: say so and return to the map
      // instead of stranding the user in an unbound POS.
      wsInitRef.current = true;
      toast.error(t('noTablesFound'));
      router.replace(
        wsParams.hall ? `/tables?hall=${encodeURIComponent(wsParams.hall)}` : '/tables',
      );
      return;
    }
    wsInitRef.current = true;
    setWsTable(table);
    cart.setOrderType('dine_in');
    cart.setTableId(table.id);
    if (wsParams.order) {
      void (async () => {
        try {
          const { data } = await api.get(`/orders/${wsParams.order}`);
          const order = data.order as Order;
          setWsOrder(order);
          handleAddItemsToOrder(table, order);
        } catch {
          toast.error(t('loadOrderFailed'));
        }
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables, wsParams]);

  const handleWsRequestBill = async () => {
    if (!wsOrder || !wsTable || wsBillBusy) return;
    setWsBillBusy(true);
    try {
      const { data } = await api.post('/bills/generate', { order_id: wsOrder.id });
      const bill = data.bill as Bill;
      const isReprint = Boolean(bill.printed_at);
      const warnings = await printBill(
        bill,
        {
          business_name: currentTenant?.business_name || tCommon('businessNameFallback'),
          currency: currentTenant?.currency || '',
          country: currentTenant?.country || '',
          timezone: currentTenant?.timezone || 'UTC',
          currency_display: currentTenant?.currency_display,
          number_digits: currentTenant?.number_digits,
          calendar: currentTenant?.calendar,
        },
        { isReprint },
      );
      showPrintWarningsToast(warnings);
      try {
        await api.post(`/bills/${bill.id}/print`, {
          print_type: isReprint ? 'reprint' : 'receipt',
        });
      } catch {
        /* best-effort history tracking */
      }
      await api.post(`/orders/${wsOrder.id}/request-bill`, {});
      toast.success(tTables('statusBillRequested'));
      setWsTable((cur) => (cur ? { ...cur, status: 'bill_requested' } : cur));
      await refreshTables();
    } catch {
      toast.error(t('printingFailed'));
    } finally {
      setWsBillBusy(false);
    }
  };

  const goWsTable = (tb: Table) => {
    const active = tb.current_order || tb.activeOrder || null;
    cart.clearCart();
    const url = `/pos?table=${encodeURIComponent(String(tb.id))}&hall=${encodeURIComponent(tb.floor || '')}${
      active ? `&order=${active.id}` : ''
    }`;
    window.location.assign(url);
  };

  return { wsParams, wsTable, wsOrder, wsBillBusy, handleWsRequestBill, goWsTable };
}
