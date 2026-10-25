import * as fs from 'node:fs';
import * as path from 'node:path';

let cached: string | null | undefined;

/**
 * Bundled brand logo (Al Malaki) as a data URL, used wherever a logo is
 * displayed or printed while the owner has not uploaded a custom store
 * logo in Settings. The owner-uploaded logo (receipt_logo setting) always
 * wins; this is only the out-of-box identity.
 */
export function getDefaultBrandLogoDataUrl(): string {
  if (cached !== undefined) return cached ?? '';
  const candidates = [
    path.join(__dirname, '../../assets/brand-logo-dataurl.txt'),
    path.join(process.resourcesPath ?? '', 'assets/brand-logo-dataurl.txt'),
  ];
  for (const candidate of candidates) {
    try {
      const value = fs.readFileSync(candidate, 'utf8').trim();
      if (value.startsWith('data:image/')) {
        cached = value;
        return value;
      }
    } catch {
      // try the next candidate
    }
  }
  cached = null;
  return '';
}

/** The effective receipt/brand logo: the owner's upload, else the bundled brand. */
export function resolveBrandLogo(receiptLogo: string | undefined | null): string {
  return receiptLogo && receiptLogo.trim() ? receiptLogo : getDefaultBrandLogoDataUrl();
}
