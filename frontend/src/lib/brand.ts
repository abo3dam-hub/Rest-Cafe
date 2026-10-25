'use client';

import { useEffect, useState } from 'react';

export interface BrandInfo {
  business_name: string;
  logo: string;
}

let cached: BrandInfo | null = null;
let inflight: Promise<BrandInfo | null> | null = null;

async function fetchBrand(): Promise<BrandInfo | null> {
  if (cached) return cached;
  if (!inflight) {
    inflight = (async () => {
      try {
        const res = await fetch(`${window.location.origin}/api/auth/branding`);
        if (!res.ok) return null;
        const data = (await res.json()) as BrandInfo;
        cached = { business_name: data.business_name || '', logo: data.logo || '' };
        return cached;
      } catch {
        return null;
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

/** Public store identity (name + logo) from the backend; null while loading. */
export function useBrand(): BrandInfo | null {
  const [brand, setBrand] = useState<BrandInfo | null>(cached);
  useEffect(() => {
    let alive = true;
    void fetchBrand().then((b) => {
      if (alive && b) setBrand(b);
    });
    return () => {
      alive = false;
    };
  }, []);
  return brand;
}

/** Drop the cached identity after the owner changes branding in Settings. */
export function invalidateBrandCache(): void {
  cached = null;
}
