import * as fs from 'fs';
import * as path from 'path';

// Clears V8 and GPU caches on Electron version changes to prevent stale ABI crashes.
export const STALE_RENDER_CACHE_DIRS = [
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Shader Cache',
];

const VERSION_MARKER_FILENAME = '.electron-version';

// Minimal logger interface matching electron-log usage.
interface Logger {
  debug: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface CacheFsOps {
  readFileSync: typeof fs.readFileSync;
  writeFileSync: typeof fs.writeFileSync;
  rmSync: typeof fs.rmSync;
  mkdirSync: typeof fs.mkdirSync;
}

export function clearStaleRenderCachesOnVersionChange(
  userDataPath: string,
  currentElectronVersion: string,
  logger: Logger = console,
  fsOps: CacheFsOps = fs,
): void {
  const versionFile = path.join(userDataPath, VERSION_MARKER_FILENAME);
  let previousVersion: string | null = null;
  try {
    previousVersion = fsOps.readFileSync(versionFile, 'utf8').toString().trim();
  } catch {
    // Missing marker treated as mismatch to clear caches on first upgrade launch.
  }

  if (previousVersion !== currentElectronVersion) {
    let failedDirs = 0;
    for (const dir of STALE_RENDER_CACHE_DIRS) {
      try {
        fsOps.rmSync(path.join(userDataPath, dir), { recursive: true, force: true });
      } catch (err) {
        failedDirs += 1;
        logger.warn(`[Flo] Failed to clear stale cache dir "${dir}":`, (err as Error).message);
      }
    }

    // Chromium can keep cache folders locked for the whole app run, so advance
    // the marker and do not repeat the same failed cleanup on every launch.
    logger.debug(
      `[Flo] Electron version marker ${previousVersion ?? '(none)'} -> ${currentElectronVersion}; cleared render caches${failedDirs ? ` (${failedDirs} locked dirs skipped)` : ''} to avoid a stale-cache crash loop.`,
    );
  }

  try {
    fsOps.mkdirSync(userDataPath, { recursive: true });
    fsOps.writeFileSync(versionFile, currentElectronVersion, 'utf8');
  } catch (err) {
    logger.warn('[Flo] Failed to write Electron version marker:', (err as Error).message);
  }
}
