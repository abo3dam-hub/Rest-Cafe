'use client';

import { useEffect, useState } from 'react';
import api from '@/lib/api';
import {
  DEFAULT_SPECIAL_CARDS_CONFIG,
  parseSpecialCardsConfig,
  type SpecialCardsConfig,
} from '@/lib/special-cards';
import { useAuthStore } from '@/store/auth';

/** Reads the tenant-wide special-card arrangement for POS surfaces. */
export function useSpecialCardsPreference() {
  const tenantId = useAuthStore((s) => s.currentTenant?.id);
  const [config, setConfig] = useState<SpecialCardsConfig>(DEFAULT_SPECIAL_CARDS_CONFIG);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/settings/special-cards')
      .then(({ data }) => {
        if (!cancelled) setConfig(parseSpecialCardsConfig(data ?? {}));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  return config;
}
