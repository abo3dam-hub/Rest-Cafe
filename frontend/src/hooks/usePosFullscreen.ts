'use client';

import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';

export interface UsePosFullscreenResult {
  fullscreen: boolean;
  toggleFullscreen: () => Promise<void>;
}

/** POS fullscreen state and toggle, moved from the POS page without behavior change. */
export function usePosFullscreen(): UsePosFullscreenResult {
  const t = useTranslations('pos');
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    if (window.electronAPI?.getWindowState) {
      window.electronAPI
        .getWindowState()
        .then((state) => {
          if (state && typeof state === 'object' && 'isMaximized' in state) {
            setFullscreen(Boolean(state.isMaximized || state.isFullScreen));
          }
        })
        .catch(() => {});

      if (window.electronAPI.onWindowStateChanged) {
        return window.electronAPI.onWindowStateChanged((state) => {
          setFullscreen(Boolean(state?.isMaximized || state?.isFullScreen));
        });
      }
      return;
    }

    const syncFullscreen = () => setFullscreen(document.fullscreenElement != null);
    syncFullscreen();
    document.addEventListener('fullscreenchange', syncFullscreen);
    return () => document.removeEventListener('fullscreenchange', syncFullscreen);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    if (typeof window === 'undefined') return;

    if (window.electronAPI?.windowAction) {
      try {
        await window.electronAPI.windowAction('toggle-maximize');
      } catch {
        toast.error(t('fullscreenUnavailable'));
      }
      return;
    }

    if (typeof document === 'undefined') return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      toast.error(t('fullscreenUnavailable'));
    }
  }, [t]);

  return { fullscreen, toggleFullscreen };
}
