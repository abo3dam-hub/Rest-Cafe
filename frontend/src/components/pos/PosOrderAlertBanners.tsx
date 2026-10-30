'use client';

import { Bell } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { NewOrderAlert } from '@/hooks/useNewOrderAlert';

interface PosOrderAlertBannersProps {
  showPrimeBanner: boolean;
  onPrimeBanner: () => void;
  alert: NewOrderAlert | null;
  onDismissAlert: () => void;
}

/** Order-alert sound banners, moved from the POS page without behavior change. */
export default function PosOrderAlertBanners({
  showPrimeBanner,
  onPrimeBanner,
  alert,
  onDismissAlert,
}: PosOrderAlertBannersProps) {
  const tKds = useTranslations('kds');
  return (
    <>
      {showPrimeBanner && (
        <button
          type="button"
          onClick={onPrimeBanner}
          className="fixed bottom-5 inset-x-0 mx-auto w-fit z-40 flex items-center gap-2 rounded-full bg-amber-100 dark:bg-amber-950/80 border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 px-4 py-2 text-sm font-medium shadow-lg"
        >
          <Bell size={16} />
          {tKds('enableSoundBanner')}
        </button>
      )}
      {alert && (
        <div role="status" className="fixed top-4 inset-x-0 mx-auto w-fit z-50">
          <button
            type="button"
            onClick={onDismissAlert}
            className="flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white shadow-lg"
          >
            <Bell size={16} />
            {alert.latestTableLabel
              ? tKds('newOrderAlertTable', { table: alert.latestTableLabel })
              : tKds('newOrderAlert', { count: alert.count })}
          </button>
        </div>
      )}
    </>
  );
}
