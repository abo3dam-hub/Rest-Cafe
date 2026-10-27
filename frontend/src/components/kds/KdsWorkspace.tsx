'use client';

import { useState } from 'react';
import { Bell } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { KdsHeader } from '@/components/kds/KdsHeader';
import { KdsKanbanBoard } from '@/components/kds/KdsKanbanBoard';
import { KdsTabsView } from '@/components/kds/KdsTabsView';
import { useKdsView } from '@/hooks/useKdsView';
import { useNewOrderAlert } from '@/hooks/useNewOrderAlert';
import type { UseKdsConnectionResult } from '@/hooks/useKdsConnection';

const PRIME_BANNER_DISMISSED_KEY = 'flocafe:order-alert:prime-banner-dismissed';

function readBannerDismissed(): boolean {
  try {
    return window.localStorage.getItem(PRIME_BANNER_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function KdsWorkspace({ conn, serverDefault }: { conn: UseKdsConnectionResult; serverDefault: 'tabs' | 'kanban' | null }) {
  const { viewMode, setViewMode } = useKdsView(serverDefault);
  const t = useTranslations('kds');
  const orderAlert = useNewOrderAlert(conn.orders, { surface: 'kds' });
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : readBannerDismissed(),
  );

  const showPrimeBanner = orderAlert.enabled && !orderAlert.primed && !bannerDismissed;
  const handlePrimeBanner = () => {
    orderAlert.primeAudio();
    try {
      window.localStorage.setItem(PRIME_BANNER_DISMISSED_KEY, '1');
    } catch {}
    setBannerDismissed(true);
  };

  const alert = orderAlert.alert;

  return (
    <div data-testid="kds-workspace" className="h-full flex flex-col">
      <KdsHeader
        userName={conn.user!.name}
        userRole={conn.user!.role}
        connected={conn.connected}
        connectionMode={conn.connectionMode}
        viewMode={viewMode}
        onChangeView={setViewMode}
        onLogout={conn.handleLogout}
        soundEnabled={orderAlert.enabled}
        onToggleSound={() => orderAlert.setEnabled(!orderAlert.enabled)}
        onTestSound={orderAlert.testChime}
      />
      {showPrimeBanner && (
        <button
          type="button"
          onClick={handlePrimeBanner}
          className="shrink-0 mb-3 flex items-center justify-center gap-2 rounded-lg bg-amber-100 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-800 text-amber-900 dark:text-amber-200 px-3 py-2 text-sm font-medium"
        >
          <Bell size={16} />
          {t('enableSoundBanner')}
        </button>
      )}
      {alert && (
        <button
          type="button"
          onClick={orderAlert.dismissAlert}
          className="fixed top-4 inset-x-0 mx-auto w-fit z-50 flex items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-white shadow-lg"
          role="status"
        >
          <Bell size={16} />
          {alert.latestTableLabel
            ? t('newOrderAlertTable', { table: alert.latestTableLabel })
            : t('newOrderAlert', { count: alert.count })}
        </button>
      )}
      <div className="flex-1 min-h-0 flex flex-col">
        {viewMode === 'kanban' ? (
          <KdsKanbanBoard orders={conn.orders} updating={conn.updating} updateItemStatus={conn.updateItemStatus} />
        ) : (
          <KdsTabsView
            orders={conn.orders}
            updating={conn.updating}
            updateItemStatus={conn.updateItemStatus}
          />
        )}
      </div>
      {conn.ConfirmDialog}
    </div>
  );
}
