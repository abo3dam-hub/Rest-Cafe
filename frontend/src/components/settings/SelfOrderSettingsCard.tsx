'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { ExternalLink, QrCode, RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import { Toggle } from '@/components/settings/Toggle';

interface SelfOrderTableEntry {
  id: string;
  number: string;
  url: string;
  qr_data_url: string | null;
}

interface SelfOrderAdminState {
  enabled: boolean;
  server_app_enabled: boolean;
  tables: SelfOrderTableEntry[];
}

export default function SelfOrderSettingsCard() {
  const t = useTranslations('selfOrder');
  const [state, setState] = useState<SelfOrderAdminState | null>(null);
  const [saving, setSaving] = useState(false);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/self-order-admin')
      .then((res) => {
        if (!cancelled) setState(res.data);
      })
      .catch(() => {
        if (!cancelled) toast.error(t('loadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function saveEnabled(enabled: boolean) {
    setSaving(true);
    try {
      await api.put('/self-order-admin', { enabled });
      setState((current) => (current ? { ...current, enabled } : current));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function regenerate(table: SelfOrderTableEntry) {
    setRegeneratingId(table.id);
    try {
      const res = await api.post(`/self-order-admin/tables/${table.id}/regenerate`);
      setState((current) =>
        current
          ? {
              ...current,
              tables: current.tables.map((entry) => (entry.id === table.id ? res.data : entry)),
            }
          : current,
      );
      toast.success(t('regeneratedToast'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setRegeneratingId(null);
    }
  }

  return (
    <div className="bg-card rounded-xl border border-border p-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0">
          <p className="font-medium text-foreground flex items-center gap-2">
            <QrCode className="w-5 h-5" />
            {t('settingsTitle')}
          </p>
          <p className="text-sm text-muted-foreground">{t('settingsHint')}</p>
        </div>
        <Toggle
          value={state?.enabled ?? false}
          label={t('settingsTitle')}
          disabled={!state || saving}
          onChange={(v) => {
            if (!saving) void saveEnabled(v);
          }}
        />
      </div>

      {state && !state.server_app_enabled && (
        <p className="mt-3 text-sm text-muted-foreground italic">{t('needsServerApp')}</p>
      )}

      {state?.enabled && (
        <div className="mt-5">
          <p className="mb-3 text-sm font-medium text-foreground">{t('tablesTitle')}</p>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {state.tables.map((table) => (
              <div
                key={table.id}
                className="flex flex-col items-center gap-2 rounded-xl border border-border p-3 text-center"
              >
                <p className="text-sm font-semibold text-foreground">#{table.number}</p>
                {table.qr_data_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={table.qr_data_url} alt="" className="h-28 w-28" />
                ) : null}
                <p className="w-full break-all text-[11px] text-muted-foreground">{table.url}</p>
                <div className="flex gap-2">
                  <a
                    href={table.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t('openPage')}
                  </a>
                  <button
                    onClick={() => void regenerate(table)}
                    disabled={regeneratingId === table.id}
                    className="inline-flex items-center gap-1 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-foreground disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {t('regenerate')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
