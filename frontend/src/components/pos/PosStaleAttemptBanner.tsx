'use client';

import { useTranslations } from 'use-intl';
import type { StalePostpaidAttemptInfo } from '@/hooks/usePosOrderSubmission';

interface PosStaleAttemptBannerProps {
  attempt: StalePostpaidAttemptInfo;
  busy: boolean;
  onRecover: () => void;
  onDismiss: () => void;
}

/** A stale postpaid attempt, surfaced on mount instead of silently forgotten:
 * a sale whose response was lost and whose cart is no longer in front of the
 * cashier. Recovering replays it under its original idempotency key; hiding
 * it is session-only while the outcome is unknown. */
export default function PosStaleAttemptBanner({
  attempt,
  busy,
  onRecover,
  onDismiss,
}: PosStaleAttemptBannerProps) {
  const t = useTranslations('pos');
  return (
    <div
      role="alert"
      className="mx-4 mt-4 flex flex-wrap items-center gap-3 rounded-2xl border border-amber-200 bg-amber-100 px-4 py-3 text-sm dark:border-amber-800/40 dark:bg-amber-950/40"
    >
      <div className="min-w-0 flex-1">
        <p className="font-bold text-amber-800 dark:text-amber-300">{t('staleAttemptTitle')}</p>
        <p className="text-amber-800/80 dark:text-amber-300/80">
          {attempt.orderNumber
            ? t('staleAttemptPlaced', { number: attempt.orderNumber })
            : attempt.itemCount !== null
              ? t('staleAttemptBody', { count: attempt.itemCount })
              : t('staleAttemptBodyUnknown')}
        </p>
      </div>
      <div className="ms-auto flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onRecover}
          className="h-10 rounded-lg border border-brand bg-brand px-3.5 text-sm font-bold text-white hover:opacity-90 disabled:opacity-50"
        >
          {t('staleAttemptRecover')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onDismiss}
          className="h-10 rounded-lg border border-border bg-card px-3.5 text-sm font-bold text-foreground hover:bg-accent disabled:opacity-50"
        >
          {t('staleAttemptDismiss')}
        </button>
      </div>
    </div>
  );
}
