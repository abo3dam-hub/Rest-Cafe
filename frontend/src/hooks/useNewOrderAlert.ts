'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  diffNewOrders,
  getAudioMode,
  isAudioPrimed,
  loadSeenOrderIds,
  playNewOrderChime,
  primeAudio,
  saveSeenOrderIds,
  type OrderAlertSurface,
} from '@/lib/order-alert';

export type { OrderAlertSurface } from '@/lib/order-alert';

/**
 * Watches the live orders feed a surface already receives (the KDS
 * WebSocket/REST stream from useKdsConnection, or the POS equivalent) and
 * raises a sound + visual alert when genuinely new order ids appear.
 *
 * The seen-id set is persisted per surface, so a remount after a
 * disconnect diffs the first snapshot against the pre-outage set: orders
 * that arrived during the outage chime once as catch-up, while orders
 * that were already on the board never chime. A brand-new board (nothing
 * persisted) seeds silently from its first snapshot. Reconnect snapshots
 * re-send the same ids and are equally silent.
 */

export interface AlertableOrder {
  id: number;
  order_number?: string;
  table_id?: string | number | null;
  table?: { name: string } | null;
}

export interface NewOrderAlert {
  count: number;
  latestTableLabel: string | null;
  latestOrderNumber: string | null;
}

export interface UseNewOrderAlertOptions {
  /** Defaults to the localStorage-backed toggle for the surface (default ON). */
  enabled?: boolean;
  surface?: OrderAlertSurface;
}

export interface UseNewOrderAlertResult {
  alert: NewOrderAlert | null;
  dismissAlert: () => void;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  /** True once the browser is actually allowed to play the chime. */
  primed: boolean;
  primeAudio: () => void;
  /** Primes (this call is normally a click) and plays the chime once. */
  testChime: () => void;
  audioMode: ReturnType<typeof getAudioMode>;
}

const ALERT_VISIBLE_MS = 6000;

function enabledStorageKey(surface: OrderAlertSurface): string {
  return `flocafe:order-alert:${surface}:enabled`;
}

function readStoredEnabled(surface: OrderAlertSurface): boolean {
  try {
    return window.localStorage.getItem(enabledStorageKey(surface)) !== '0';
  } catch {
    return true;
  }
}

export function useNewOrderAlert(
  orders: AlertableOrder[],
  options: UseNewOrderAlertOptions = {},
): UseNewOrderAlertResult {
  const surface: OrderAlertSurface = options.surface ?? 'kds';
  const controlledEnabled = options.enabled;
  const [storedEnabled, setStoredEnabled] = useState<boolean>(() =>
    typeof window === 'undefined' ? true : readStoredEnabled(surface),
  );
  const enabled = controlledEnabled ?? storedEnabled;

  const [alert, setAlert] = useState<NewOrderAlert | null>(null);
  const [primed, setPrimed] = useState<boolean>(() => isAudioPrimed());
  const seenIdsRef = useRef<Set<number> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const setEnabled = useCallback(
    (value: boolean) => {
      setStoredEnabled(value);
      try {
        window.localStorage.setItem(enabledStorageKey(surface), value ? '1' : '0');
      } catch {}
    },
    [surface],
  );

  const dismissAlert = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    setAlert(null);
  }, []);

  // Diff each new snapshot against the seen-id set.
  useEffect(() => {
    if (seenIdsRef.current === null) {
      // First snapshot after mount: seed from the persisted set when the
      // surface had one, so orders that arrived during a disconnect chime
      // once as catch-up; a brand-new board (nothing persisted) still
      // seeds silently.
      const persisted = loadSeenOrderIds(surface);
      if (persisted === null) {
        seenIdsRef.current = new Set(orders.map((order) => order.id));
        saveSeenOrderIds(surface, seenIdsRef.current);
        return;
      }
      seenIdsRef.current = persisted;
    }
    const { fresh, nextSeen } = diffNewOrders(orders, seenIdsRef.current);
    seenIdsRef.current = nextSeen;
    saveSeenOrderIds(surface, nextSeen);
    if (fresh.length === 0) return;

    const latest = fresh[fresh.length - 1];
    const latestTableLabel =
      latest.table?.name ??
      (latest.table_id !== null && latest.table_id !== undefined ? String(latest.table_id) : null);
    if (enabled) playNewOrderChime();
    setAlert((prev) => ({
      count: (prev?.count ?? 0) + fresh.length,
      latestTableLabel,
      latestOrderNumber: latest.order_number ?? null,
    }));
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => setAlert(null), ALERT_VISIBLE_MS);
  }, [orders, enabled, surface]);

  useEffect(
    () => () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    },
    [],
  );

  // Keep the primed flag honest: the engine unlocks on the first gesture
  // anywhere, so mirror that here for the banner/toggle UI.
  useEffect(() => {
    if (primed) return;
    const sync = () => {
      if (isAudioPrimed()) setPrimed(true);
    };
    window.addEventListener('pointerdown', sync);
    window.addEventListener('keydown', sync);
    return () => {
      window.removeEventListener('pointerdown', sync);
      window.removeEventListener('keydown', sync);
    };
  }, [primed]);

  const prime = useCallback(() => {
    primeAudio();
    setPrimed(isAudioPrimed());
  }, []);

  const testChime = useCallback(() => {
    primeAudio();
    setPrimed(isAudioPrimed());
    playNewOrderChime();
  }, []);

  return {
    alert,
    dismissAlert,
    enabled,
    setEnabled,
    primed,
    primeAudio: prime,
    testChime,
    audioMode: getAudioMode(),
  };
}
