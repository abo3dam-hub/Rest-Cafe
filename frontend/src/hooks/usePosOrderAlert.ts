'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import {
  useNewOrderAlert,
  type AlertableOrder,
  type UseNewOrderAlertResult,
} from '@/hooks/useNewOrderAlert';

export interface UsePosOrderAlertResult {
  orderAlert: UseNewOrderAlertResult;
  showPrimeBanner: boolean;
  handlePrimeBanner: () => void;
}

/** POS new-order alert polling and prime banner, moved from the POS page without behavior change. */
export function usePosOrderAlert(): UsePosOrderAlertResult {
  const [alertOrders, setAlertOrders] = useState<AlertableOrder[]>([]);
  // New-order sound for the cashier: the POS has no live orders socket, so
  // it polls the same kitchen feed the KDS REST fallback uses.
  const orderAlert = useNewOrderAlert(alertOrders, { surface: 'pos' });
  useEffect(() => {
    if (!orderAlert.enabled) return;
    let cancelled = false;
    const fetchOrders = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const { data } = await api.get('/kitchen/orders?status=pending,preparing,ready,served');
        if (!cancelled) setAlertOrders((data.orders as AlertableOrder[]) || []);
      } catch {}
    };
    fetchOrders();
    const id = setInterval(fetchOrders, 20000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [orderAlert.enabled]);

  const [primeBannerDismissed, setPrimeBannerDismissed] = useState<boolean>(() =>
    typeof window === 'undefined'
      ? true
      : window.localStorage.getItem('flocafe:order-alert:prime-banner-dismissed') === '1',
  );
  const showPrimeBanner = orderAlert.enabled && !orderAlert.primed && !primeBannerDismissed;
  const handlePrimeBanner = () => {
    orderAlert.primeAudio();
    try {
      window.localStorage.setItem('flocafe:order-alert:prime-banner-dismissed', '1');
    } catch {}
    setPrimeBannerDismissed(true);
  };

  return { orderAlert, showPrimeBanner, handlePrimeBanner };
}
