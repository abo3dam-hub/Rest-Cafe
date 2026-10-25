import { parseDbTimestamp } from '@/lib/utils';
import { formatBusinessDate } from '@/lib/countries';

function withLatn(locale: string): string {
  if (/-u-/i.test(locale)) {
    return /-nu-/i.test(locale) ? locale.replace(/-nu-[^-]*/i, '-nu-latn') : `${locale}-nu-latn`;
  }
  return `${locale}-u-nu-latn`;
}

// Receipt timestamps render as "DD/MM/YYYY HH:MM" with Latin digits in
// every language; only the time keeps the caller's locale flavour. The
// legacy third argument is an Intl options bag — only its timeZone is
// honoured now that the date shape is fixed.
export function formatDate(iso?: string, locale: string = 'en-US', options?: Intl.DateTimeFormatOptions): string {
  if (!iso) return '';
  try {
    const d = parseDbTimestamp(iso);
    if (isNaN(d.getTime())) return iso;
    const timeZone = options?.timeZone;
    const time = new Intl.DateTimeFormat(withLatn(locale), {
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    }).format(d);
    return `${formatBusinessDate(d, timeZone)} ${time}`;
  } catch {
    return iso;
  }
}

export function formatTime(iso?: string, locale: string = 'en-US', options?: Intl.DateTimeFormatOptions): string {
  if (!iso) return '';
  try {
    const d = parseDbTimestamp(iso);
    if (isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      ...options
    }).format(d);
  } catch {
    return iso;
  }
}
