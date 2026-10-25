import { useCallback } from 'react';
import { useAuthStore } from '@/store/auth';
import { useLocale } from 'use-intl';
import { formatBusinessDate, formatDateForTenant } from '@/lib/countries';
import { parseDbTimestamp } from '@/lib/utils';

// String timestamps arrive in DB UTC format (YYYY-MM-DD HH:MM:SS);
// use parseDbTimestamp to avoid machine-local interpretation.
function toDate(date: string | Date | number): Date {
  return typeof date === 'string' ? parseDbTimestamp(date) : new Date(date);
}

const TIME_OPTION_KEYS = ['hour', 'minute', 'second', 'hour12', 'hourCycle'] as const;

export function useFormatDate() {
  const currentTenant = useAuthStore((s) => s.currentTenant);
  const locale = useLocale();

  const country = currentTenant?.country || '';
  const timeZone = currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const format = useCallback((
    date: string | Date | number | null | undefined,
    options: Intl.DateTimeFormatOptions = {},
  ): string => {
    if (!date) return '';
    const d = toDate(date);
    if (isNaN(d.getTime())) return String(date);
    return formatDateForTenant(d, country, timeZone, {
      calendar: currentTenant?.calendar,
      digits: currentTenant?.number_digits,
    }, options, locale);
  }, [country, timeZone, currentTenant?.calendar, currentTenant?.number_digits, locale]);

  // Business dates render as DD/MM/YYYY with Latin digits in every UI
  // language; only the time part keeps locale formatting.
  const formatDate = useCallback((date?: string | Date | number | null): string => {
    if (!date) return '';
    const d = toDate(date);
    if (isNaN(d.getTime())) return String(date);
    return formatBusinessDate(d, timeZone);
  }, [timeZone]);

  const formatTime = useCallback((date?: string | Date | number | null, options?: Intl.DateTimeFormatOptions) =>
    format(date, { hour: '2-digit', minute: '2-digit', ...options }),
  [format]);

  const formatDateTime = useCallback((date?: string | Date | number | null, options?: Intl.DateTimeFormatOptions): string => {
    if (!date) return '';
    const d = toDate(date);
    if (isNaN(d.getTime())) return String(date);
    const timeOptions: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
    for (const key of TIME_OPTION_KEYS) {
      if (options?.[key] !== undefined) Object.assign(timeOptions, { [key]: options[key] });
    }
    return `${formatBusinessDate(d, timeZone)} ${format(d, timeOptions)}`;
  }, [format, timeZone]);

  return { formatDate, formatTime, formatDateTime };
}
