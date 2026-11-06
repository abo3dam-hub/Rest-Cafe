'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import {
  Check,
  ChefHat,
  Copy,
  ExternalLink,
  Monitor,
  MonitorSmartphone,
  QrCode,
  RefreshCw,
  Smartphone,
} from 'lucide-react';
import api from '@/lib/api';

interface InterfaceLink {
  id: 'main' | 'kitchen' | 'waiter' | 'customer_display';
  url: string;
  qr_data_url: string | null;
  port: number;
  requested_port: number;
  port_bumped: boolean;
  enabled: boolean;
}

interface InterfaceLinksState {
  ip: string;
  interfaces: InterfaceLink[];
  self_order: {
    enabled: boolean;
    server_app_enabled: boolean;
  };
}

const INTERFACE_ORDER: InterfaceLink['id'][] = ['main', 'kitchen', 'waiter', 'customer_display'];

const INTERFACE_ICONS: Record<InterfaceLink['id'], typeof Monitor> = {
  main: Monitor,
  kitchen: ChefHat,
  waiter: Smartphone,
  customer_display: MonitorSmartphone,
};

export default function InterfaceLinksTab({
  onNavigate,
}: {
  onNavigate?: (tab: string) => void;
}) {
  const t = useTranslations('settings');
  const [state, setState] = useState<InterfaceLinksState | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get('/interface-links')
      .then((res) => {
        setState(res.data);
      })
      .catch(() => {
        toast.error(t('interfaceLinksLoadFailed'));
      })
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/interface-links')
      .then((res) => {
        if (!cancelled) setState(res.data);
      })
      .catch(() => {
        if (!cancelled) toast.error(t('interfaceLinksLoadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function copyLink(id: string, url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(id);
      toast.success(t('interfaceCopied'));
      window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 2000);
    } catch {
      toast.error(t('interfaceCopyFailed'));
    }
  }

  const byId = new Map((state?.interfaces ?? []).map((entry) => [entry.id, entry]));

  const interfaceText: Record<InterfaceLink['id'], { title: string; hint: string }> = {
    main: { title: t('interface_main_title'), hint: t('interface_main_hint') },
    kitchen: { title: t('interface_kitchen_title'), hint: t('interface_kitchen_hint') },
    waiter: { title: t('interface_waiter_title'), hint: t('interface_waiter_hint') },
    customer_display: {
      title: t('interface_customer_display_title'),
      hint: t('interface_customer_display_hint'),
    },
  };

  return (
    <div className="space-y-6">
      <div className="bg-card rounded-xl border border-border p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-semibold text-foreground">{t('tabInterfaceLinks')}</h2>
            <p className="text-sm text-muted-foreground mt-1">{t('interfaceLinksIntro')}</p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {t('interfaceRefresh')}
          </button>
        </div>

        {loading && !state && (
          <p className="mt-5 text-sm text-muted-foreground">{t('interfaceLoading')}</p>
        )}
        {!loading && !state && (
          <button
            onClick={load}
            className="mt-5 px-4 py-2 text-sm bg-brand text-white rounded-lg hover:opacity-90 font-medium"
          >
            {t('interfaceRetry')}
          </button>
        )}

        {state && (
          <div className="mt-5 space-y-4">
            {INTERFACE_ORDER.map((id) => {
              const link = byId.get(id);
              if (!link) return null;
              const Icon = INTERFACE_ICONS[id];
              return (
                <div key={id} className="rounded-xl border border-border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="font-medium text-foreground flex items-center gap-2">
                      <Icon className="w-5 h-5" />
                      {interfaceText[id].title}
                    </p>
                    <span
                      className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        link.enabled
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {link.enabled ? t('interfaceStatusEnabled') : t('interfaceStatusDisabled')}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{interfaceText[id].hint}</p>

                  {link.enabled ? (
                    <>
                      <div className="mt-3 flex flex-wrap items-center gap-3">
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          dir="ltr"
                          className="font-mono text-sm text-brand break-all hover:underline"
                        >
                          {link.url}
                        </a>
                        <button
                          onClick={() => void copyLink(id, link.url)}
                          className="inline-flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground"
                        >
                          {copiedId === id ? (
                            <Check className="h-3.5 w-3.5" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                          {t('interfaceCopyLink')}
                        </button>
                        <a
                          href={link.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          {t('interfaceOpenLink')}
                        </a>
                      </div>
                      {link.qr_data_url && (
                        <div className="mt-3">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={link.qr_data_url} alt="" className="h-28 w-28" />
                        </div>
                      )}
                      {link.port_bumped && (
                        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">
                          {t('interfacePortBumped', {
                            port: link.port,
                            requested: link.requested_port,
                          })}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      <p className="text-sm text-muted-foreground italic">
                        {id === 'kitchen'
                          ? t('interfaceEnableKitchen')
                          : t('interfaceEnableWaiter')}
                      </p>
                      {onNavigate && (
                        <button
                          onClick={() => onNavigate(id === 'kitchen' ? 'kds' : 'server-app')}
                          className="inline-flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground"
                        >
                          {t('interfaceGoToSettings')}
                        </button>
                      )}
                    </div>
                  )}

                  {id === 'customer_display' && (
                    <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border pt-3">
                      <p className="text-sm text-muted-foreground italic">
                        {t('interfaceDisplayPairing')}
                      </p>
                      {onNavigate && (
                        <button
                          onClick={() => onNavigate('customer-display')}
                          className="inline-flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground"
                        >
                          {t('interfaceGoToSettings')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {/* Self-ordering has one signed link per table, so it is managed
                from the tableside-ordering tab instead of a single URL here. */}
            <div className="rounded-xl border border-border p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="font-medium text-foreground flex items-center gap-2">
                  <QrCode className="w-5 h-5" />
                  {t('interface_self_order_title')}
                </p>
                <span
                  className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    state.self_order.enabled
                      ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
                      : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {state.self_order.enabled
                    ? t('interfaceStatusEnabled')
                    : t('interfaceStatusDisabled')}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('interface_self_order_hint')}
              </p>
              <div className="mt-3">
                {onNavigate && (
                  <button
                    onClick={() => onNavigate('server-app')}
                    className="inline-flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground"
                  >
                    {t('interfaceManageSelfOrder')}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <p className="text-sm text-muted-foreground">{t('interfaceIpNote')}</p>
    </div>
  );
}
