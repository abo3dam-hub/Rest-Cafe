'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'use-intl';
import { Ltr } from '@/components/layout/Ltr';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import type { UsePosTableWorkspaceResult } from '@/hooks/usePosTableWorkspace';
import type { Order, Table } from '@/lib/types';

interface PosWorkspaceBannerProps {
  wsTable: Table;
  wsOrder: Order | null;
  wsParams: UsePosTableWorkspaceResult['wsParams'];
  wsBillBusy: boolean;
  canTakePayments: boolean;
  onRequestBill: () => Promise<void>;
  onCheckout: () => void;
}

/** Table-workspace banner, moved from the POS page without behavior change. */
export default function PosWorkspaceBanner({
  wsTable,
  wsOrder,
  wsParams,
  wsBillBusy,
  canTakePayments,
  onRequestBill,
  onCheckout,
}: PosWorkspaceBannerProps) {
  const router = useRouter();
  const tTables = useTranslations('tables');
  const tCommon = useTranslations('common');
  const currencyFmt = useFormatCurrency();
  return (
    <div className="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3">
      <span className="text-lg font-extrabold text-foreground">{wsTable.name}</span>
      {wsOrder && (
        <span className="text-sm text-muted-foreground">
          <Ltr>#{wsOrder.order_number}</Ltr> · {tTables('openedFirstOrder')}{' '}
          <Ltr>
            {new Date(wsOrder.created_at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Ltr>{' '}
          · <span className="font-bold text-foreground">{currencyFmt(wsOrder.total ?? 0)}</span>
        </span>
      )}
      <div className="ms-auto flex flex-wrap gap-2">
        {wsOrder && (
          <button
            type="button"
            onClick={() =>
              router.push(
                `/tables?hall=${encodeURIComponent(wsParams.hall)}&mergeFrom=${wsOrder.id}`,
              )
            }
            className="h-10 rounded-lg border border-border bg-card px-3.5 text-sm font-bold text-foreground hover:bg-accent"
          >
            {tTables('mergeWith')}
          </button>
        )}
        {wsOrder && wsTable.status !== 'bill_requested' && (
          <button
            type="button"
            onClick={onRequestBill}
            disabled={wsBillBusy}
            className="h-10 rounded-lg border border-amber-600 bg-amber-50 px-3.5 text-sm font-bold text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:bg-amber-950/40 dark:text-amber-300"
          >
            {tTables('requestBill')}
          </button>
        )}
        {wsOrder && canTakePayments && (
          <button
            type="button"
            onClick={onCheckout}
            className="h-10 rounded-lg bg-neutral-900 px-3.5 text-sm font-bold text-white hover:bg-neutral-700 dark:bg-white dark:text-neutral-900"
          >
            {tCommon('total')} · {currencyFmt(wsOrder.total ?? 0)}
          </button>
        )}
      </div>
    </div>
  );
}
