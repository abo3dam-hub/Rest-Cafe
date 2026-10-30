'use client';

import { X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { Product } from '@/lib/types';

interface PosSoldOutModalProps {
  products: Product[];
  onClose: () => void;
  onToggleSoldOut: (product: Product) => Promise<void>;
  onReactivateAll: () => Promise<void>;
}

/** Sold-out reminder modal, moved from the POS page without behavior change. */
export default function PosSoldOutModal({
  products,
  onClose,
  onToggleSoldOut,
  onReactivateAll,
}: PosSoldOutModalProps) {
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-2xl shadow-xl w-full max-w-md max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="font-bold text-foreground">{t('soldOutReminderTitle')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label={tCommon('close')}
          >
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto p-2">
          {products.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg hover:bg-muted/50"
            >
              <span className="text-sm font-medium text-foreground">{p.name}</span>
              <button
                type="button"
                onClick={() => onToggleSoldOut(p)}
                className="shrink-0 rounded-lg bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/50 px-3 py-1 text-xs font-bold"
              >
                {t('soldOutRestore')}
              </button>
            </div>
          ))}
          {products.length === 0 && (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t('soldOutSaved')}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 p-4 border-t border-border">
          <button
            type="button"
            onClick={onReactivateAll}
            className="flex-1 rounded-lg bg-brand text-white px-4 py-2 text-sm font-bold hover:bg-brand-hover"
          >
            {t('soldOutReactivateAll')}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted"
          >
            {tCommon('close')}
          </button>
        </div>
      </div>
    </div>
  );
}
