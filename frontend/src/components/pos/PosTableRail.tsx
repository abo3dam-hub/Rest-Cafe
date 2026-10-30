'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'use-intl';
import type { UsePosTableWorkspaceResult } from '@/hooks/usePosTableWorkspace';
import type { Table } from '@/lib/types';

interface PosTableRailProps {
  tables: Table[];
  wsParams: UsePosTableWorkspaceResult['wsParams'];
  onSelectTable: (table: Table) => void;
}

/** Table rail beside the product grid, moved from the POS page without behavior change. */
export default function PosTableRail({ tables, wsParams, onSelectTable }: PosTableRailProps) {
  const router = useRouter();
  const tTables = useTranslations('tables');
  return (
    <div className="hidden md:flex md:w-[148px] md:shrink-0 flex-col gap-2 rounded-2xl bg-neutral-800 p-2.5">
      <button
        type="button"
        onClick={() => router.push(`/tables?hall=${encodeURIComponent(wsParams.hall)}`)}
        className="flex h-[52px] items-center justify-center rounded-xl bg-amber-500 text-[15px] font-extrabold text-neutral-900 hover:bg-amber-400"
      >
        {tTables('backToTables')}
      </button>
      <p className="text-center text-[11px] font-medium text-neutral-400">
        {wsParams.hall || tTables('title')}
      </p>
      <div className="grid grid-cols-2 gap-1.5 overflow-y-auto">
        {(tables.filter((tb) => (tb.floor || '') === wsParams.hall).length > 0
          ? tables.filter((tb) => (tb.floor || '') === wsParams.hall)
          : tables
        ).map((tb) => {
          const st = tb.status === 'cleaning' ? 'available' : tb.status;
          const selected = String(tb.id) === wsParams.table;
          return (
            <button
              key={tb.id}
              type="button"
              onClick={() => onSelectTable(tb)}
              className={`flex h-11 items-center justify-center rounded-lg border-2 text-[13px] font-extrabold ${
                st === 'occupied'
                  ? 'border-blue-500 bg-blue-950 text-blue-200'
                  : st === 'bill_requested'
                    ? 'border-orange-500 bg-orange-950 text-orange-200'
                    : st === 'reserved'
                      ? 'border-violet-500 bg-violet-950 text-violet-200'
                      : 'border-transparent bg-neutral-700 text-neutral-300'
              } ${selected ? 'outline outline-2 outline-amber-400' : ''}`}
            >
              {tb.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}
