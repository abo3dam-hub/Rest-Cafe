import { useEffect, useState } from 'react';
import { AlertCircle, AlertTriangle, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';

type ServerPortStatus = {
  service: string;
  requested_port: number;
  port: number;
  port_bumped: boolean;
};

export default function GlobalNotifications() {
  const tCustomers = useTranslations('customers');
  const tCommon = useTranslations('common');
  const [invalidPhonesCount, setInvalidPhonesCount] = useState(0);
  // Port-bump notice (F-006) and database-integrity warning (R-01). Both
  // are persistent: they stay until the underlying condition clears, and
  // are never dismissed like a toast.
  const [bumpedPorts, setBumpedPorts] = useState<ServerPortStatus[]>([]);
  const [dbHealthError, setDbHealthError] = useState<string | null>(null);
  const currentTenant = useAuthStore((s) => s.currentTenant);
  const isOwnerOrManager = currentTenant?.role === 'owner' || currentTenant?.role === 'manager';

  useEffect(() => {
    const fetchAlerts = () => {
      api
        .get('/customers/alerts')
        .then((res) => {
          setInvalidPhonesCount(res.data?.invalidPhonesCount || 0);
        })
        .catch((err) => {
          console.warn('[Notifications] Failed to fetch customer alerts:', err?.message);
        });
    };

    fetchAlerts();
    const interval = setInterval(fetchAlerts, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const fetchHostNotices = () => {
      api
        .get('/server-ports')
        .then((res) => {
          const statuses: ServerPortStatus[] = [
            res.data?.api,
            res.data?.kds,
            res.data?.server_app,
          ].filter(Boolean);
          setBumpedPorts(statuses.filter((s) => s.port_bumped));
        })
        .catch(() => {
          // Ports are advisory; a failed read leaves the last known state.
        });
      // /api/health answers 503 when the startup integrity check flagged
      // the database — axios rejects, so read the flag from the error.
      api
        .get('/health')
        .then(() => setDbHealthError(null))
        .catch((err) => {
          const db = err?.response?.data?.db;
          setDbHealthError(typeof db === 'string' && db !== 'ok' ? db : null);
        });
    };

    fetchHostNotices();
    const interval = setInterval(fetchHostNotices, 30000);
    return () => clearInterval(interval);
  }, []);

  const showDbWarning = isOwnerOrManager && dbHealthError !== null;
  const portDetails = bumpedPorts
    .map((s) => `${s.service} ${s.requested_port} → ${s.port}`)
    .join('; ');

  if (invalidPhonesCount === 0 && !showDbWarning && bumpedPorts.length === 0) return null;

  const displayMsg = tCustomers('invalidPhoneCount', { count: invalidPhonesCount });

  return (
    <>
      {showDbWarning && (
        <div className="bg-red-50 border-b border-red-100 px-4 py-2 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <AlertTriangle className="text-red-500 w-5 h-5 shrink-0" />
            <p className="text-sm text-red-800 font-medium">{tCommon('dbIntegrityWarning')}</p>
            <Link
              href="/settings"
              className="text-sm text-red-600 hover:text-red-700 font-bold flex items-center underline underline-offset-2"
            >
              {tCommon('reviewFix')} <ChevronRight className="w-4 h-4 ms-0.5 rtl-flip" />
            </Link>
          </div>
        </div>
      )}
      {bumpedPorts.length > 0 && (
        <div className="bg-amber-50 border-b border-amber-100 px-4 py-2 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <AlertTriangle className="text-amber-500 w-5 h-5 shrink-0" />
            <p className="text-sm text-amber-800 font-medium">
              {tCommon('portBumpNotice', { details: portDetails })}
            </p>
            <Link
              href="/settings"
              className="text-sm text-amber-600 hover:text-amber-700 font-bold flex items-center underline underline-offset-2"
            >
              {tCommon('reviewFix')} <ChevronRight className="w-4 h-4 ms-0.5 rtl-flip" />
            </Link>
          </div>
        </div>
      )}
      {invalidPhonesCount > 0 && (
        <div className="bg-red-50 border-b border-red-100 px-4 py-2 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <AlertCircle className="text-red-500 w-5 h-5 shrink-0" />
            <p className="text-sm text-red-800 font-medium">{displayMsg}</p>
            <Link
              href="/customers?filter=invalid_phones"
              className="text-sm text-red-600 hover:text-red-700 font-bold flex items-center underline underline-offset-2"
            >
              {tCommon('reviewFix')} <ChevronRight className="w-4 h-4 ms-0.5 rtl-flip" />
            </Link>
          </div>
        </div>
      )}
    </>
  );
}
