/**
 * Local classification of how this instance was launched and installed.
 * Purely descriptive: the values are written into local records (for
 * example cloud-registration payloads built at runtime) and are never
 * transmitted by this module itself.
 */

import type { app } from 'electron';

/** `packaged` for a real merchant install, `dev` for `npm run dev` and non-Electron hosts. */
export type RunMode = 'packaged' | 'dev';

/** Where the running binary came from. Rest&Cafe ships for Windows only. */
export type InstallSource = 'github' | 'ms_store' | 'dev';

/**
 * Resolves Electron's `app` without assuming an Electron runtime. This module
 * is imported by unit tests and scripts where `electron` resolves to a path
 * string or is missing entirely, so an unguarded `app.isPackaged` would
 * throw. Any failure degrades to a dev-mode report instead of breaking the
 * import.
 */
function electronApp(): typeof app | undefined {
  try {
    const electronModule = require('electron') as { app?: typeof app } | undefined;
    return electronModule?.app;
  } catch {
    return undefined;
  }
}

function isPackagedRun(): boolean {
  return electronApp()?.isPackaged === true;
}

export function getRunMode(): RunMode {
  return isPackagedRun() ? 'packaged' : 'dev';
}

/** Classifies the distribution channel the running binary was installed from. */
export function getInstallSource(): InstallSource {
  if (!isPackagedRun()) return 'dev';
  if (process.windowsStore) return 'ms_store';
  return 'github';
}
