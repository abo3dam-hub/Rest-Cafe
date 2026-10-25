import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Import kill-ports functions
const { isFloProcess, FLO_PATTERNS } = require('../kill-ports.js');
const YAML = require('js-yaml') as { load: (text: string) => unknown };

const rootDir = path.resolve(__dirname, '..');
const resetScript = path.join(rootDir, 'scripts/dev/nuclear-reset.sh');
const i18nAddScript = path.join(rootDir, 'scripts/i18n-add.cjs');
const buildFrontendScript = path.join(rootDir, 'scripts/build-frontend.cjs');

function mkdirp(target: string) {
  fs.mkdirSync(target, { recursive: true });
}

function runReset(platform: string, env: NodeJS.ProcessEnv) {
  return spawnSync('bash', [resetScript, '--electron-cache-only'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FORCE: '',
      CI: '',
      FLO_RESET_PLATFORM: platform,
      ...env,
    },
  });
}

function runTest() {
  console.log('Testing i18n:add scaffolding validation...');
  const existingLanguage = spawnSync(process.execPath, [i18nAddScript, 'en'], {
    encoding: 'utf8',
    cwd: rootDir,
  });
  assert.strictEqual(
    existingLanguage.status,
    1,
    'i18n:add must refuse to overwrite an existing language file',
  );
  assert.match(
    existingLanguage.stderr,
    /Refusing to overwrite existing messages file/,
    'i18n:add must explain why an existing language file was not overwritten',
  );

  const regionalLanguage = spawnSync(process.execPath, [i18nAddScript, 'zh-tw'], {
    encoding: 'utf8',
    cwd: rootDir,
  });
  assert.strictEqual(
    regionalLanguage.status,
    1,
    'i18n:add must accept a regional key before refusing an existing file',
  );
  assert.doesNotMatch(
    regionalLanguage.stderr,
    /Invalid language code/,
    'i18n:add must accept a canonical lowercase regional key',
  );

  const invalidLanguage = spawnSync(process.execPath, [i18nAddScript, 'EN'], {
    encoding: 'utf8',
    cwd: rootDir,
  });
  assert.strictEqual(
    invalidLanguage.status,
    1,
    'i18n:add must reject non-canonical language codes',
  );
  assert.match(invalidLanguage.stderr, /Invalid language code/);

  const extensionLanguage = spawnSync(process.execPath, [i18nAddScript, 'en-u-nu-latn'], {
    encoding: 'utf8',
    cwd: rootDir,
  });
  assert.strictEqual(
    extensionLanguage.status,
    1,
    'i18n:add must reject Unicode-extension locale keys',
  );
  assert.match(extensionLanguage.stderr, /Invalid language code/);
  console.log('✓ i18n:add validation, regional keys, and no-overwrite guard verified');

  console.log('Testing build:frontend dependency validation...');
  const buildFixture = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-build-frontend-test-'));
  try {
    const fixtureFrontend = path.join(buildFixture, 'frontend');
    const fixtureScripts = path.join(buildFixture, 'scripts');
    const mockBin = path.join(buildFixture, 'bin');
    const fixtureBuildScript = path.join(fixtureScripts, 'build-frontend.cjs');
    const mockNpmScript = path.join(mockBin, 'mock-npm.cjs');
    const mockNpmPath = path.join(mockBin, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    const npmLog = path.join(buildFixture, 'npm.log');
    const lockfilePath = path.join(fixtureFrontend, 'package-lock.json');

    fs.mkdirSync(fixtureFrontend, { recursive: true });
    fs.mkdirSync(fixtureScripts, { recursive: true });
    fs.mkdirSync(mockBin, { recursive: true });
    fs.copyFileSync(buildFrontendScript, fixtureBuildScript);

    const lockfile = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'frontend', version: '0.1.0' },
        'node_modules/example': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/example/-/example-1.0.0.tgz',
          integrity: 'sha512-example',
        },
      },
    };
    fs.writeFileSync(lockfilePath, JSON.stringify(lockfile));

    const mockNpmSource = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FLO_TEST_NPM_LOG, args.join(' ') + '\\n');
if (args[0] === 'ls') {
  process.exitCode = Number(process.env.FLO_TEST_NPM_LS_STATUS || 0);
} else if (args[0] === 'ci') {
  const lockfile = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
  const packages = { ...lockfile.packages };
  delete packages[''];
  fs.rmSync('node_modules', { recursive: true, force: true });
  fs.mkdirSync('node_modules', { recursive: true });
  fs.writeFileSync(path.join('node_modules', '.package-lock.json'), JSON.stringify({ lockfileVersion: lockfile.lockfileVersion, packages }));
} else if (args[0] !== 'run' || args[1] !== 'build') {
  process.exitCode = 9;
}
`;

    fs.writeFileSync(mockNpmScript, mockNpmSource);
    if (process.platform === 'win32') {
      fs.writeFileSync(mockNpmPath, `@echo off\r\n"${process.execPath}" "${mockNpmScript}" %*\r\n`);
    } else {
      fs.writeFileSync(mockNpmPath, `#!/usr/bin/env node\n${mockNpmSource}`, { mode: 0o755 });
    }

    const buildEnv = {
      ...process.env,
      PATH: `${mockBin}${path.delimiter}${process.env.PATH || ''}`,
      FLO_TEST_NPM_LOG: npmLog,
      FLO_TEST_NPM_LS_STATUS: '0',
    };
    const runFrontendBuild = (env: NodeJS.ProcessEnv = buildEnv) =>
      spawnSync(process.execPath, [fixtureBuildScript], {
        encoding: 'utf8',
        cwd: buildFixture,
        env,
      });
    const npmCalls = () => fs.readFileSync(npmLog, 'utf8').trim().split(/\r?\n/);

    const firstBuild = runFrontendBuild();
    assert.strictEqual(
      firstBuild.status,
      0,
      `Expected missing dependencies to install: ${firstBuild.stderr}`,
    );
    assert.deepStrictEqual(
      npmCalls(),
      ['ci', 'run build'],
      'Missing dependencies must be installed before building',
    );

    const currentBuild = runFrontendBuild();
    assert.strictEqual(
      currentBuild.status,
      0,
      `Expected current dependencies to build: ${currentBuild.stderr}`,
    );
    assert.deepStrictEqual(
      npmCalls().slice(2),
      ['ls --all --json', 'run build'],
      'A complete installation matching the lockfile must skip npm ci',
    );

    lockfile.packages['node_modules/example'].version = '1.0.1';
    fs.writeFileSync(lockfilePath, JSON.stringify(lockfile));
    const staleBuild = runFrontendBuild();
    assert.strictEqual(
      staleBuild.status,
      0,
      `Expected stale dependencies to reinstall: ${staleBuild.stderr}`,
    );
    assert.deepStrictEqual(
      npmCalls().slice(-2),
      ['ci', 'run build'],
      'A lockfile change must trigger npm ci',
    );

    const incompleteBuild = runFrontendBuild({ ...buildEnv, FLO_TEST_NPM_LS_STATUS: '1' });
    assert.strictEqual(
      incompleteBuild.status,
      0,
      `Expected incomplete dependencies to reinstall: ${incompleteBuild.stderr}`,
    );
    assert.deepStrictEqual(npmCalls().slice(-3), ['ls --all --json', 'ci', 'run build']);
  } finally {
    fs.rmSync(buildFixture, { recursive: true, force: true });
  }
  console.log('✓ build:frontend lockfile drift and incomplete installation checks verified');

  console.log('Testing kill-ports.js process identity matching...');

  // Positive cases (should match as Flo processes)
  const positiveCases = [
    'node /Users/dev/FloCafe/dist/index.js',
    'node /Users/dev/FloCafe/dist/main/index.js',
    'node C:\\FloCafe\\dist\\main\\index.js',
    '/Applications/Flo Cafe.app/Contents/MacOS/Flo Cafe',
    '/usr/bin/flocafe --no-sandbox',
    'electron . --appName=flo-desktop',
    'node /path/to/FloCafe/dev-server.js',
    'node /path/to/FloCafe/dist/index.js',
    'com.flo.desktop.helper',
    'flo-pos-service',
  ];

  for (const cmd of positiveCases) {
    assert.strictEqual(isFloProcess(cmd), true, `Expected "${cmd}" to match Flo process patterns`);
  }

  // Negative cases (should NOT match as Flo processes)
  const negativeCases = [
    'node /Users/dev/other-project/index.js',
    'node /Users/other-project/dist/index.js',
    'node /Users/other-project/dev-server.js',
    'node /home/user/app/dev-server.js',
    'node /Users/dev/FloCafe/other-server.js',
    'node /Users/dev/FloCafe-tools/dev-server.js',
    'python3 -m http.server 3000',
    'nginx: master process',
    'postgres -D /data',
    'redis-server *:6379',
  ];

  for (const cmd of negativeCases) {
    assert.strictEqual(
      isFloProcess(cmd),
      false,
      `Expected "${cmd}" to NOT match Flo process patterns`,
    );
  }

  console.log('✓ kill-ports.js pattern matching verified');

  console.log('Testing scripts/dev/nuclear-reset.sh confirmation guard...');

  // Running the reset script in non-interactive mode without -y should fail.
  const nonInteractiveResult = spawnSync('bash', [resetScript], {
    encoding: 'utf8',
    env: { ...process.env, FORCE: '', CI: '' },
  });

  assert.strictEqual(
    nonInteractiveResult.status,
    1,
    'Expected non-interactive reset without -y flag to fail with exit code 1',
  );
  assert.match(
    nonInteractiveResult.stdout + nonInteractiveResult.stderr,
    /Non-interactive shell detected/i,
    'Expected output to warn about non-interactive shell',
  );

  console.log('✓ development reset non-interactive confirmation guard verified');

  console.log('Testing nuclear-reset.sh Electron cache paths...');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-reset-cache-test-'));
  try {
    const darwinHome = path.join(tmpDir, 'darwin-home');
    const darwinPaths = [
      path.join(darwinHome, 'Library/Application Support/flo-desktop/Cache'),
      path.join(darwinHome, 'Library/Application Support/flo-desktop/Code Cache'),
      path.join(darwinHome, 'Library/Caches/flo-desktop'),
    ];
    darwinPaths.forEach(mkdirp);
    const darwinResult = runReset('Darwin', { HOME: darwinHome });
    assert.strictEqual(
      darwinResult.status,
      0,
      `Expected Darwin cache cleanup to pass: ${darwinResult.stderr}`,
    );
    darwinPaths.forEach((cachePath) => {
      assert.strictEqual(
        fs.existsSync(cachePath),
        false,
        `Expected Darwin cache path to be removed: ${cachePath}`,
      );
    });
    assert.match(
      darwinResult.stdout,
      /Cleared: Electron app cache/,
      'Expected Darwin app cache removal message',
    );
    assert.match(
      darwinResult.stdout,
      /Cleared: Electron code cache/,
      'Expected Darwin code cache removal message',
    );
    assert.match(
      darwinResult.stdout,
      /Cleared: Electron system cache/,
      'Expected Darwin system cache removal message',
    );

    const linuxHome = path.join(tmpDir, 'linux-home');
    const linuxConfigHome = path.join(tmpDir, 'linux-config');
    const linuxCacheHome = path.join(tmpDir, 'linux-cache');
    const linuxPaths = [
      path.join(linuxConfigHome, 'flo-desktop/Cache'),
      path.join(linuxConfigHome, 'flo-desktop/Code Cache'),
      path.join(linuxCacheHome, 'flo-desktop'),
    ];
    linuxPaths.forEach(mkdirp);
    const linuxResult = runReset('Linux', {
      HOME: linuxHome,
      XDG_CONFIG_HOME: linuxConfigHome,
      XDG_CACHE_HOME: linuxCacheHome,
    });
    assert.strictEqual(
      linuxResult.status,
      0,
      `Expected Linux cache cleanup to pass: ${linuxResult.stderr}`,
    );
    linuxPaths.forEach((cachePath) => {
      assert.strictEqual(
        fs.existsSync(cachePath),
        false,
        `Expected Linux cache path to be removed: ${cachePath}`,
      );
    });

    const windowsAppData = path.join(tmpDir, 'windows-appdata');
    const windowsLocalAppData = path.join(tmpDir, 'windows-localappdata');
    const windowsPaths = [
      path.join(windowsAppData, 'flo-desktop/Cache'),
      path.join(windowsAppData, 'flo-desktop/Code Cache'),
      path.join(windowsLocalAppData, 'flo-desktop'),
    ];
    windowsPaths.forEach(mkdirp);
    const windowsResult = runReset('Windows_NT', {
      APPDATA: windowsAppData,
      LOCALAPPDATA: windowsLocalAppData,
    });
    assert.strictEqual(
      windowsResult.status,
      0,
      `Expected Windows cache cleanup to pass: ${windowsResult.stderr}`,
    );
    windowsPaths.forEach((cachePath) => {
      assert.strictEqual(
        fs.existsSync(cachePath),
        false,
        `Expected Windows cache path to be removed: ${cachePath}`,
      );
    });

    const missingWindowsResult = runReset('Windows_NT', {
      APPDATA: '',
      LOCALAPPDATA: '',
    });
    assert.strictEqual(
      missingWindowsResult.status,
      0,
      'Expected missing Windows cache roots to be reported without failing',
    );
    assert.match(
      missingWindowsResult.stdout,
      /Skipped: Electron app\/code cache unavailable \(APPDATA is not set\)/,
      'Expected missing APPDATA diagnostic',
    );
    assert.match(
      missingWindowsResult.stdout,
      /Skipped: Electron system cache unavailable \(LOCALAPPDATA is not set\)/,
      'Expected missing LOCALAPPDATA diagnostic',
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log('✓ nuclear reset Electron cache paths verified');

  console.log(
    'Testing scripts/ci/run-test-shard.cjs parameter validation and sharding behavior...',
  );

  const shardScript = path.join(rootDir, 'scripts/ci/run-test-shard.cjs');

  // Parameter validation checks
  const invalidCases = [
    {
      env: { SHARD_TOTAL: '0', SHARD_INDEX: '0' },
      expectedErr: /Invalid SHARD_TOTAL=0: expected an integer >= 1/,
    },
    {
      env: { SHARD_TOTAL: '-2', SHARD_INDEX: '0' },
      expectedErr: /Invalid SHARD_TOTAL=-2: expected an integer >= 1/,
    },
    {
      env: { SHARD_TOTAL: 'abc', SHARD_INDEX: '0' },
      expectedErr: /Invalid SHARD_TOTAL=abc: expected an integer >= 1/,
    },
    {
      env: { SHARD_TOTAL: '2.5', SHARD_INDEX: '0' },
      expectedErr: /Invalid SHARD_TOTAL=2.5: expected an integer >= 1/,
    },
    {
      env: { SHARD_TOTAL: '2', SHARD_INDEX: '-1' },
      expectedErr: /Invalid SHARD_INDEX=-1: expected an integer >= 0/,
    },
    {
      env: { SHARD_TOTAL: '2', SHARD_INDEX: '2' },
      expectedErr: /Invalid SHARD_INDEX=2: must be < SHARD_TOTAL=2/,
    },
    {
      env: { SHARD_TOTAL: '2', SHARD_INDEX: '5' },
      expectedErr: /Invalid SHARD_INDEX=5: must be < SHARD_TOTAL=2/,
    },
  ];

  for (const tc of invalidCases) {
    const res = spawnSync('node', [shardScript], {
      encoding: 'utf8',
      cwd: rootDir,
      env: { ...process.env, ...tc.env },
    });
    assert.strictEqual(res.status, 2, `Expected exit status 2 for env ${JSON.stringify(tc.env)}`);
    assert.match(res.stderr, tc.expectedErr, `Expected stderr to match ${tc.expectedErr}`);
  }

  console.log('✓ run-test-shard.cjs parameter validation verified');

  // Execution and partition behavior using temporary fixture
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-shard-test-'));
  try {
    fs.mkdirSync(path.join(fixtureDir, 'scripts/ci'), { recursive: true });
    fs.mkdirSync(path.join(fixtureDir, 'tests'), { recursive: true });

    // Copy run-test-shard.cjs
    fs.copyFileSync(shardScript, path.join(fixtureDir, 'scripts/ci/run-test-shard.cjs'));

    // Create mock scripts/run-test.cjs
    const runTestWrapper = `const suite = process.argv[4];
console.log('RUNNING_MOCK_SUITE:' + suite);
process.exit(suite === 'test:failing-suite' ? 1 : 0);
`;
    fs.writeFileSync(path.join(fixtureDir, 'scripts/run-test.cjs'), runTestWrapper);

    // Create fixture package.json
    const fixturePkg = {
      name: 'fixture-app',
      scripts: {
        'test:suite-1': 'node -e ""',
        'test:suite-2': 'node -e ""',
        'test:suite-3': 'node -e ""',
        'test:suite-4': 'node -e ""',
        'test:suite-5': 'node -e ""',
        'test:failing-suite': 'node -e ""',
        test: 'node scripts/run-test.cjs npm run test:suite-1 && node scripts/run-test.cjs npm run test:suite-2 && node scripts/run-test.cjs npm run test:suite-3 && node scripts/run-test.cjs npm run test:suite-4 && node scripts/run-test.cjs npm run test:suite-5',
        'test-with-fail':
          'node scripts/run-test.cjs npm run test:suite-1 && node scripts/run-test.cjs npm run test:failing-suite && node scripts/run-test.cjs npm run test:suite-3',
      },
    };
    fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify(fixturePkg, null, 2));

    // Test Shard 0 execution (suites 1, 3, 5)
    const shard0 = spawnSync('node', ['scripts/ci/run-test-shard.cjs'], {
      encoding: 'utf8',
      cwd: fixtureDir,
      env: { ...process.env, SHARD_TOTAL: '2', SHARD_INDEX: '0' },
    });
    assert.strictEqual(shard0.status, 0, `Expected shard 0 to pass: ${shard0.stderr}`);
    assert.match(shard0.stdout, /RUNNING_MOCK_SUITE:test:suite-1/);
    assert.match(shard0.stdout, /RUNNING_MOCK_SUITE:test:suite-3/);
    assert.match(shard0.stdout, /RUNNING_MOCK_SUITE:test:suite-5/);
    assert.doesNotMatch(shard0.stdout, /RUNNING_MOCK_SUITE:test:suite-2/);
    assert.doesNotMatch(shard0.stdout, /RUNNING_MOCK_SUITE:test:suite-4/);

    // Test Shard 1 execution (suites 2, 4)
    const shard1 = spawnSync('node', ['scripts/ci/run-test-shard.cjs'], {
      encoding: 'utf8',
      cwd: fixtureDir,
      env: { ...process.env, SHARD_TOTAL: '2', SHARD_INDEX: '1' },
    });
    assert.strictEqual(shard1.status, 0, `Expected shard 1 to pass: ${shard1.stderr}`);
    assert.match(shard1.stdout, /RUNNING_MOCK_SUITE:test:suite-2/);
    assert.match(shard1.stdout, /RUNNING_MOCK_SUITE:test:suite-4/);
    assert.doesNotMatch(shard1.stdout, /RUNNING_MOCK_SUITE:test:suite-1/);
    assert.doesNotMatch(shard1.stdout, /RUNNING_MOCK_SUITE:test:suite-3/);
    assert.doesNotMatch(shard1.stdout, /RUNNING_MOCK_SUITE:test:suite-5/);

    // Test Fail-fast on failing suite
    fixturePkg.scripts.test = fixturePkg.scripts['test-with-fail'];
    fs.writeFileSync(path.join(fixtureDir, 'package.json'), JSON.stringify(fixturePkg, null, 2));

    const failingShard = spawnSync('node', ['scripts/ci/run-test-shard.cjs'], {
      encoding: 'utf8',
      cwd: fixtureDir,
      env: { ...process.env, SHARD_TOTAL: '2', SHARD_INDEX: '1' }, // failing-suite is at index 1
    });
    assert.strictEqual(failingShard.status, 1, 'Expected failing suite to exit with code 1');
    assert.match(failingShard.stdout, /RUNNING_MOCK_SUITE:test:failing-suite/);
    assert.match(failingShard.stderr, /\[shard 1\] FAILED: test:failing-suite/);
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }

  console.log('✓ run-test-shard.cjs round-robin execution and fail-fast verified');

  // Real package.json test suite partition & coverage invariance
  const realPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const testScript = realPkg.scripts?.test;
  assert.ok(
    typeof testScript === 'string' && testScript.length > 0,
    'package.json must define a "test" script',
  );

  const pretestScript = realPkg.scripts?.pretest;
  const releaseRegressionScript = realPkg.scripts?.['test:release-regressions'];
  assert.ok(
    typeof pretestScript === 'string' && pretestScript.includes('npm run test:release-regressions'),
    'npm pretest must run the release regression aggregate before the canonical suite',
  );
  assert.ok(
    typeof releaseRegressionScript === 'string' && releaseRegressionScript.length > 0,
    'package.json must define the release regression aggregate',
  );
  for (const requiredSuite of [
    'test:browser-receipts',
    'test:decoupled-ui-locale',
    'test:i18n-audit-remediations',
    'test:i18n-ssr-timezone',
    'test:issue-241-localized-errors',
    'test:payment-modal-currency-adapter',
    'test:printer-fallback-and-popup-verification',
  ]) {
    assert.ok(
      releaseRegressionScript.includes(`npm run ${requiredSuite}`),
      `release regression aggregate must include ${requiredSuite}`,
    );
  }

  const suitePattern = /(?:bash\s+tests\/run-test\.sh\s+)?npm\s+run\s+(test:[\w-]+)/g;
  const allSuites: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = suitePattern.exec(testScript)) !== null) {
    if (!allSuites.includes(match[1])) allSuites.push(match[1]);
  }

  assert.ok(
    allSuites.length >= 90,
    `Expected at least 90 test suites in "test" script, got ${allSuites.length}`,
  );

  for (const suiteName of allSuites) {
    assert.ok(
      suiteName in realPkg.scripts,
      `Suite "${suiteName}" extracted from "test" script must exist in package.json scripts`,
    );
  }

  const shardSuites = [0, 1, 2, 3].map((s) => allSuites.filter((_, i) => i % 4 === s));
  for (let s = 0; s < 4; s++) {
    const expected = Math.floor(allSuites.length / 4) + (s < allSuites.length % 4 ? 1 : 0);
    assert.strictEqual(
      shardSuites[s].length,
      expected,
      `Shard ${s} must have exactly ${expected} suites`,
    );
  }

  // Ensure 0 overlap and 100% union coverage
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) {
      const intersection = shardSuites[a].filter((s) => shardSuites[b].includes(s));
      assert.strictEqual(
        intersection.length,
        0,
        `Shards ${a} and ${b} must not share any duplicate suites`,
      );
    }
  }

  const reconstructed = [];
  for (let i = 0; i < allSuites.length; i++) {
    reconstructed.push(shardSuites[i % 4][Math.floor(i / 4)]);
  }
  assert.deepStrictEqual(
    reconstructed,
    allSuites,
    'Round-robin shards must reconstruct the exact original suite list in order',
  );

  console.log(
    `✓ package.json test suite sharding coverage invariance (${allSuites.length} suites across 4 shards) verified`,
  );

  // CI Workflow schema — the fork's lean CI (upstream's sharded release
  // matrix and store pipelines were removed with the manual distribution
  // model; what remains must keep validating the local-only contract).
  const ciWorkflow = fs.readFileSync(path.join(rootDir, '.github/workflows/ci.yml'), 'utf8');
  const ciConfig = YAML.load(ciWorkflow) as any;

  const validateJob = ciConfig?.jobs?.validate;
  assert.ok(validateJob, 'ci.yml must define the "validate" job');
  assert.strictEqual(validateJob['runs-on'], 'ubuntu-24.04');
  const validateRuns = (validateJob.steps as any[])
    .map((step) => (typeof step.run === 'string' ? step.run : ''))
    .join('\n');
  for (const required of [
    'npm run lint',
    'npm run build',
    'npm run build:frontend',
    'npm run test:url-allowlist',
    'npm run test:offline-mode',
    'npm run test:first-run',
    'npm run test:tax-pack-catalog',
    'npm run test:electron-api-contract',
    'npm run test:print-parity',
    'npm run test:script-coverage',
  ]) {
    assert.ok(validateRuns.includes(required), `ci validate job must run: ${required}`);
  }

  // The Windows installer pipeline is manual-trigger only.
  const winWorkflow = fs.readFileSync(
    path.join(rootDir, '.github/workflows/build-windows.yml'),
    'utf8',
  );
  const winConfig = YAML.load(winWorkflow) as any;
  const winTriggers = winConfig?.on ?? (winConfig as any)?.[true];
  assert.ok(winTriggers?.workflow_dispatch !== undefined, 'build-windows.yml is manual only');
  const installerJob = winConfig?.jobs?.['build-windows'];
  assert.ok(installerJob, 'build-windows.yml must define the build-installer job');
  assert.strictEqual(installerJob['runs-on'], 'windows-latest');

  console.log('✓ Fork CI (lean validate job + manual Windows installer) verified');

  console.log('All dev tooling script tests passed cleanly!');
}

runTest();
