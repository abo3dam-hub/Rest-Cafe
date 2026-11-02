'use client';

import { useEffect, useRef } from 'react';

import api from '@/lib/api';
import type { Bill, Order } from '@/lib/types';
import {
  duePendingPrintJobs,
  markPendingPrintJobFailed,
  removePendingPrintJob,
  type PendingPrintJob,
} from '@/lib/printer/print-queue';
import { useAuthStore } from '@/store/auth';
import { usePosSettingsStore } from '@/store/pos-settings';
import { usePrinterStore } from './usePrinter';

/** How often the POS retries due pending-print jobs while it is open. */
export const PRINT_QUEUE_DRAIN_INTERVAL_MS = 60_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Print failed';
}

function isNotFoundError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return status === 404;
}

/**
 * Retries failed KOT and receipt prints from the frontend queue while the
 * POS is open (F-009). Runs on mount and every minute; a job is only
 * attempted when its backoff has elapsed, and only one pass runs at a
 * time. A fetch that fails (still offline) leaves the job untouched for
 * the next pass; a print that fails burns one attempt with backoff; a
 * job whose order or bill is gone (404) is dropped. When KOT printing
 * is disabled the queued KOT jobs wait instead of burning attempts.
 */
export function usePrintQueueDrain(): void {
  const drainInFlightRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const drainOnce = async () => {
      if (drainInFlightRef.current || cancelled || document.hidden) return;
      drainInFlightRef.current = true;
      try {
        const jobs = duePendingPrintJobs();
        for (const job of jobs) {
          if (cancelled) return;
          await drainJob(job);
        }
      } finally {
        drainInFlightRef.current = false;
      }
    };

    const drainJob = async (job: PendingPrintJob) => {
      try {
        if (job.kind === 'kot') {
          if (!usePosSettingsStore.getState().kotPrintingEnabled) return;
          const { data } = await api.get(`/orders/${job.orderId}`);
          const order = (data?.order ?? data) as Order | undefined;
          if (!order || typeof order !== 'object' || !('id' in order)) {
            removePendingPrintJob(job.id);
            return;
          }
          const items = job.itemIds
            ? (order.items ?? []).filter((item) => job.itemIds?.includes(Number(item.id)))
            : undefined;
          await usePrinterStore.getState().printKot(items ? { ...order, items } : order);
        } else {
          const tenant = useAuthStore.getState().currentTenant;
          if (!tenant) return;
          const { data } = await api.get(`/bills/${job.billId}`);
          const bill = data?.bill as Bill | undefined;
          if (!bill) {
            removePendingPrintJob(job.id);
            return;
          }
          await usePrinterStore.getState().printBill(
            bill,
            {
              business_name: tenant.business_name,
              currency: tenant.currency ?? '',
              country: tenant.country ?? '',
              timezone: tenant.timezone ?? 'UTC',
              currency_display: tenant.currency_display,
              number_digits: tenant.number_digits,
              calendar: tenant.calendar,
            },
            { isReprint: job.isReprint ?? false },
          );
        }
        removePendingPrintJob(job.id);
      } catch (error) {
        // A 404 means the order or bill is gone for good; drop the job.
        if (isNotFoundError(error)) {
          removePendingPrintJob(job.id);
          return;
        }
        // A transport failure (no HTTP answer at all) means the attempt
        // never reached the server; leave the job for the next pass
        // without burning an attempt. Any answered failure — a print the
        // server refused, or a fetch it errored on — counts as an attempt.
        const status = (error as { response?: { status?: number } } | null)?.response?.status;
        if (status === undefined) return;
        markPendingPrintJobFailed(job.id, errorMessage(error));
      }
    };

    void drainOnce();
    const timer = setInterval(() => void drainOnce(), PRINT_QUEUE_DRAIN_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
}
