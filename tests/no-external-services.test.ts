/**
 * Regression guard for the local-only cleanup.
 *
 * The removed external integrations (FloAdmin cloud sync, Google Drive,
 * PostHog analytics, anonymous telemetry, and the electron auto-updater)
 * must not come back as dependencies, imports, source modules, endpoints,
 * or startup calls. This is a static source audit: it proves the removed
 * code is absent, which together with the offline-mode suite (runtime
 * behavior of the remaining surface) is the offline evidence base. It is
 * not, by itself, a runtime network capture.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const { assertOrThrow, getResults } = require('./helpers/test-setup');

const ROOT = path.join(__dirname, '..');

const PROHIBITED_DEPENDENCIES = [
  'posthog-node',
  'posthog-js',
  '@googleapis/drive',
  'electron-updater',
  'builder-util-runtime',
];

const REMOVED_MODULES = [
  'main/services/cloud-sync.ts',
  'main/services/google-drive.ts',
  'main/services/telemetry.ts',
  'main/services/posthog.ts',
  'main/services/posthog-config.ts',
  'main/services/posthog-identity.ts',
  'main/update-channel.ts',
  'main/update-state.ts',
  'main/updater-shutdown.ts',
  'main/update-ipc.ts',
  'frontend/src/lib/posthog-client.ts',
  'frontend/src/components/analytics/PostHogBootstrap.tsx',
  'frontend/src/hooks/useUpdateStatus.ts',
];

const PROHIBITED_SPECIFIERS = [
  'posthog-node',
  'posthog-js',
  '@googleapis/drive',
  'electron-updater',
  'builder-util-runtime',
  'services/cloud-sync',
  'services/google-drive',
  'services/telemetry',
  'services/posthog',
  '/update-channel',
  '/update-state',
  '/updater-shutdown',
  '/update-ipc',
];

const PROHIBITED_MAIN_TOKENS = [
  'flopos.com',
  'i.posthog.com',
  'googleapis.com',
  'startPostHog',
  'cloudSync.',
  'googleDrive.',
  'telemetry.start',
  'autoUpdater',
  'ensureCloudIdentity',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function main() {
  console.log('No-external-services regression checks');
  console.log('='.repeat(60));

  // 1. Dependencies stay removed in both packages.
  for (const rel of ['package.json', 'frontend/package.json']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    for (const dep of PROHIBITED_DEPENDENCIES) {
      assertOrThrow(!(dep in allDeps), `${rel} does not depend on ${dep}`);
    }
  }

  // 2. Removed modules stay deleted.
  for (const rel of REMOVED_MODULES) {
    assertOrThrow(!fs.existsSync(path.join(ROOT, rel)), `${rel} stays removed`);
  }

  // 3. No source file imports a prohibited module, in main, shared, or the
  // frontend (locale message catalogs excluded — they hold display strings).
  const sourceRoots = ['main', 'shared', 'frontend/src'];
  const offenders: string[] = [];
  for (const root of sourceRoots) {
    for (const file of walk(path.join(ROOT, root))) {
      if (file.includes(`${path.sep}i18n${path.sep}messages${path.sep}`)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const specifier of PROHIBITED_SPECIFIERS) {
        if (
          text.includes(`'${specifier}'`) ||
          text.includes(`"${specifier}"`) ||
          text.includes(`/${specifier}'`) ||
          text.includes(`/${specifier}"`) ||
          (text.includes(specifier) && specifier.startsWith('services/'))
        ) {
          offenders.push(`${path.relative(ROOT, file)} -> ${specifier}`);
        }
      }
    }
  }
  assertOrThrow(
    offenders.length === 0,
    `no prohibited imports remain${offenders.length ? `: ${offenders.join('; ')}` : ''}`,
  );

  // 4. The main process carries no vendor endpoints or startup calls.
  const mainOffenders: string[] = [];
  for (const file of walk(path.join(ROOT, 'main'))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const token of PROHIBITED_MAIN_TOKENS) {
      if (text.includes(token)) mainOffenders.push(`${path.relative(ROOT, file)} -> ${token}`);
    }
  }
  assertOrThrow(
    mainOffenders.length === 0,
    `main process is free of vendor endpoints and startup calls${
      mainOffenders.length ? `: ${mainOffenders.join('; ')}` : ''
    }`,
  );

  // 5. Packaging stays Windows-only: no mac/linux builder targets or
  // platform build/release scripts.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const build = pkg.build || {};
  assertOrThrow(
    !('mac' in build) && !('linux' in build),
    'builder config has no mac/linux targets',
  );
  assertOrThrow('win' in build, 'builder config keeps the Windows target');
  for (const scriptName of [
    'build:mac',
    'build:mas',
    'build:linux',
    'release:mac',
    'release:linux',
  ]) {
    assertOrThrow(!(scriptName in (pkg.scripts || {})), `script ${scriptName} stays removed`);
  }
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/build-windows.yml'), 'utf8');
  assertOrThrow(
    workflow.includes('windows-latest') &&
      !workflow.includes('--mac') &&
      !workflow.includes('--linux'),
    'the release workflow builds the Windows installer only',
  );

  const results = getResults();
  console.log(`\n${results.passed}/${results.total} passed`);
  process.exit(results.failed > 0 ? 1 : 0);
}

main();
