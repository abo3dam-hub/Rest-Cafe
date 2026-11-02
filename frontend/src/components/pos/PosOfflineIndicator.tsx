'use client';

import { useTranslations } from 'use-intl';

interface PosOfflineIndicatorProps {
  online: boolean;
  catalogRetrying: boolean;
}

/** Persistent offline indicator for the POS (the KDS red-dot equivalent): a
 * red strip that stays visible while the backend is unreachable, and an amber
 * one while the catalog load is retrying with backoff. Unlike a toast it does
 * not disappear until connectivity returns. */
export default function PosOfflineIndicator({
  online,
  catalogRetrying,
}: PosOfflineIndicatorProps) {
  const t = useTranslations('pos');
  if (online && !catalogRetrying) return null;
  const offline = !online;
  return (
    <div
      role="status"
      className={`mx-4 mt-4 flex flex-wrap items-center gap-2 rounded-2xl border px-4 py-3 text-sm font-bold ${
        offline
          ? 'border-red-200 bg-red-100 text-red-700 dark:border-red-800/40 dark:bg-red-950/40 dark:text-red-300'
          : 'border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/40 dark:text-amber-300'
      }`}
    >
      <span
        aria-hidden
        className={`h-2.5 w-2.5 rounded-full ${offline ? 'bg-red-500' : 'bg-amber-500'}`}
      />
      {offline ? t('offlineIndicator') : t('catalogRetrying')}
    </div>
  );
}
