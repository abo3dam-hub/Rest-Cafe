'use client';

import { useAuthStore } from '@/store/auth';
import { useBrand } from '@/lib/brand';

/**
 * The restaurant's brand logo, shown wherever the brand appears (login,
 * sidebar, setup, customer surfaces). Uses the owner-uploaded store logo
 * from Settings when present; otherwise the bundled brand identity.
 */
export function BrandLogo({ className, size = 96 }: { className?: string; size?: number }) {
  const brand = useBrand();
  const tenantLogo = useAuthStore((s) => s.currentTenant?.brand_logo);
  const src =
    (brand?.logo && brand.logo.trim()) || (tenantLogo && tenantLogo.trim()) || '/brand-default.jpg';
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      className={className ?? 'mx-auto object-contain'}
      style={{ maxWidth: size, maxHeight: size }}
    />
  );
}
