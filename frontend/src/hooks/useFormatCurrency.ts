import { useAuthStore } from '@/store/auth';
import { formatCurrencyForTenant } from '@/lib/countries';

export function useFormatCurrency() {
  const tenant = useAuthStore((s) => s.currentTenant);
  const country = tenant?.country || '';
  const currency = tenant?.currency ?? '';
  const prefs = {
    currencyDisplay: tenant?.currency_display,
    digits: tenant?.number_digits,
    currencySymbol: tenant?.currency_symbol,
    currencyPosition: tenant?.currency_position,
  };
  return (n: number) => formatCurrencyForTenant(n, country, currency, prefs);
}
