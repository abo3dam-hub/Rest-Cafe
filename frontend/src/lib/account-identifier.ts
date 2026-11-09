/**
 * Username accounts are stored as `<username>@restcafe.local`; every display
 * surface shows the plain username. Real email addresses pass through.
 */
export function displayAccountIdentifier(stored: string | null | undefined): string {
  const value = stored ?? '';
  const suffix = '@restcafe.local';
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}
