import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  clearStaleRenderCachesOnVersionChange,
  STALE_RENDER_CACHE_DIRS,
  type CacheFsOps,
} from '../main/startup-cache';

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected)
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
}

function makeSilentLogger() {
  return { debug: () => {}, warn: () => {} };
}

function withTempUserData(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-startup-cache-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── Fresh profile: no marker, no pre-existing cache — nothing to clear, marker gets written ──
withTempUserData((dir) => {
  clearStaleRenderCachesOnVersionChange(dir, '43.4.0', makeSilentLogger());
  assertEqual(
    fs.readFileSync(path.join(dir, '.electron-version'), 'utf8'),
    '43.4.0',
    'version marker written on fresh profile',
  );
});

// ── Existing profile from before this check existed: no marker, but stale cache present.
//    This is the case the fix targets — it must be cleared on this first launch, not skipped. ──
withTempUserData((dir) => {
  for (const name of STALE_RENDER_CACHE_DIRS) {
    const cacheDir = path.join(dir, name);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'sentinel'), 'x');
  }

  clearStaleRenderCachesOnVersionChange(dir, '43.4.0', makeSilentLogger());

  for (const name of STALE_RENDER_CACHE_DIRS) {
    assertEqual(
      fs.existsSync(path.join(dir, name)),
      false,
      `${name} must be cleared on the first launch of an unmarked pre-existing profile`,
    );
  }
  assertEqual(
    fs.readFileSync(path.join(dir, '.electron-version'), 'utf8'),
    '43.4.0',
    'version marker written after clearing an unmarked profile',
  );
});

// ── Same version on next launch: cache must be left alone ──
withTempUserData((dir) => {
  fs.writeFileSync(path.join(dir, '.electron-version'), '43.4.0');
  const cacheDir = path.join(dir, 'Code Cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, 'sentinel'), 'x');

  clearStaleRenderCachesOnVersionChange(dir, '43.4.0', makeSilentLogger());

  assertEqual(
    fs.existsSync(path.join(cacheDir, 'sentinel')),
    true,
    'unchanged version must not clear cache',
  );
});

// ── Version changed since last launch: all known stale cache dirs must be wiped ──
withTempUserData((dir) => {
  fs.writeFileSync(path.join(dir, '.electron-version'), '31.7.7');
  for (const name of STALE_RENDER_CACHE_DIRS) {
    const cacheDir = path.join(dir, name);
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'sentinel'), 'x');
  }
  // A directory that isn't a known stale-cache dir must survive untouched.
  fs.mkdirSync(path.join(dir, 'Local Storage'), { recursive: true });

  clearStaleRenderCachesOnVersionChange(dir, '43.4.0', makeSilentLogger());

  for (const name of STALE_RENDER_CACHE_DIRS) {
    assertEqual(
      fs.existsSync(path.join(dir, name)),
      false,
      `${name} must be cleared after a version change`,
    );
  }
  assertEqual(
    fs.existsSync(path.join(dir, 'Local Storage')),
    true,
    'unrelated userData dirs must survive',
  );
  assertEqual(
    fs.readFileSync(path.join(dir, '.electron-version'), 'utf8'),
    '43.4.0',
    'version marker updated after clearing',
  );
});

// ── A missing cache dir must not throw ──
withTempUserData((dir) => {
  fs.writeFileSync(path.join(dir, '.electron-version'), '31.7.7');
  clearStaleRenderCachesOnVersionChange(dir, '43.4.0', makeSilentLogger());
  assertEqual(
    fs.readFileSync(path.join(dir, '.electron-version'), 'utf8'),
    '43.4.0',
    'version marker updated even with no cache dirs present',
  );
});

// ── A locked cache dir is warned about once, but the marker still advances ──
// Chromium can hold its GPU cache folders locked for the app's whole run
// (follow-up 46, Ali's 2026-11-08 main.log: EPERM on every launch). Retrying
// the same locked folder on every launch only spams the log, so the marker
// advances and the next launch for this Electron version leaves it alone.
withTempUserData((dir) => {
  fs.writeFileSync(path.join(dir, '.electron-version'), '31.7.7');
  fs.mkdirSync(path.join(dir, 'GPUCache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'GPUCache', 'sentinel'), 'x');

  const warnings: unknown[][] = [];
  const capturingLogger = {
    debug: () => {},
    warn: (...args: unknown[]) => warnings.push(args),
  };
  const realFs: CacheFsOps = fs;
  const flakyFsOps: CacheFsOps = {
    ...realFs,
    rmSync: (target: fs.PathLike, options?: fs.RmOptions) => {
      if (path.basename(String(target)) === 'GPUCache') {
        throw new Error('EPERM: operation not permitted');
      }
      return realFs.rmSync(target, options);
    },
  };

  clearStaleRenderCachesOnVersionChange(dir, '43.4.0', capturingLogger, flakyFsOps);

  assertEqual(warnings.length, 1, 'a locked cache dir still surfaces exactly one warning');
  assertEqual(
    fs.readFileSync(path.join(dir, '.electron-version'), 'utf8'),
    '43.4.0',
    'marker advances even when a cache dir is locked',
  );

  // Next launch for the same version must not retry the cleanup at all.
  clearStaleRenderCachesOnVersionChange(dir, '43.4.0', capturingLogger);
  assertEqual(
    fs.existsSync(path.join(dir, 'GPUCache', 'sentinel')),
    true,
    'same-version launch leaves the cache untouched instead of retrying',
  );
  assertEqual(warnings.length, 1, 'no repeated warning on the same-version launch');
});

console.log('Startup render-cache tests passed');
