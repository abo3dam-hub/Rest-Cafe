'use client';

import { useEffect, useState } from 'react';

/** POS connectivity from real signals: the browser online/offline events plus
 * the shared API client's outcome events — a transport failure marks the POS
 * offline, and any confirmed response marks it back online. */
export function usePosConnectivity(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  );
  useEffect(() => {
    const markOnline = () => setOnline(true);
    const markOffline = () => setOnline(false);
    window.addEventListener('online', markOnline);
    window.addEventListener('offline', markOffline);
    window.addEventListener('flo:api-online', markOnline);
    window.addEventListener('flo:api-offline', markOffline);
    return () => {
      window.removeEventListener('online', markOnline);
      window.removeEventListener('offline', markOffline);
      window.removeEventListener('flo:api-online', markOnline);
      window.removeEventListener('flo:api-offline', markOffline);
    };
  }, []);
  return online;
}
