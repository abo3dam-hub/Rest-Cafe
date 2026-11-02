/** Windows autostart via Electron login-item settings (F-005).
 *
 * The owner toggles it in Settings (store tab); the stored setting ships on
 * (an absent setting means the owner never touched the toggle). The main
 * process applies it at startup and immediately whenever the setting is
 * saved. Safe no-op off Windows, and never throws: a failed registration
 * must not break startup or a settings save. Actual login behaviour is
 * verified on the owner's Windows machine later.
 */
import { app } from 'electron';
import { getSettingValue } from '../db';

export const AUTOSTART_SETTING_KEY = 'autostart_enabled';

/** True unless the owner explicitly turned autostart off. */
export function isAutostartEnabled(): boolean {
  try {
    return getSettingValue(AUTOSTART_SETTING_KEY) !== 'false';
  } catch {
    return true;
  }
}

export interface AutostartApplyResult {
  applied: boolean;
  enabled: boolean;
  platform: string;
}

/**
 * Honour the autostart preference in the OS login items.
 *
 * `enabled` is the value just saved (the settings route passes it so the
 * toggle applies immediately, without waiting on the settings cache); when
 * omitted, the stored setting is read (the startup path). `overrides`
 * exists for suites: the real app object and platform are otherwise read
 * from Electron / process.
 */
export function applyAutostartSetting(
  enabled?: boolean,
  overrides?: {
    platform?: string;
    setLoginItemSettings?: (settings: { openAtLogin: boolean; path?: string }) => void;
  },
): AutostartApplyResult {
  const platform = overrides?.platform ?? process.platform;
  const resolvedEnabled = enabled ?? isAutostartEnabled();
  if (platform !== 'win32') return { applied: false, enabled: resolvedEnabled, platform };
  const setLoginItemSettings =
    overrides?.setLoginItemSettings ?? app.setLoginItemSettings?.bind(app);
  if (typeof setLoginItemSettings !== 'function') {
    return { applied: false, enabled: resolvedEnabled, platform };
  }
  try {
    setLoginItemSettings({ openAtLogin: resolvedEnabled, path: process.execPath });
    return { applied: true, enabled: resolvedEnabled, platform };
  } catch (err) {
    console.warn('[Autostart] Failed to apply login-item setting:', err);
    return { applied: false, enabled: resolvedEnabled, platform };
  }
}
