#!/usr/bin/env node
'use strict';

// Runs a test command. Exit code 77 is the GNU "skip" code: a suite that
// cannot even load better-sqlite3 under shell Node (the native module is
// built for Electron's ABI) exits 77 instead of failing. That skip is
// honoured ONLY for suites on the DECLARED_ENVIRONMENT_SKIPS list below;
// any other suite exiting 77 fails loudly, so a real failure can never
// hide behind the skip code.
// Usage: node scripts/run-test.cjs npm run test:integration-happy

const { spawnSync } = require('node:child_process');

// Suites allowed to exit 77, and why. Each entry is a script whose command
// runs a test file with the better-sqlite3 ABI guard (process.exit(77)
// when initDatabase() throws an ABI mismatch), or a composite that chains
// one. Add a suite here only when its 77 comes from that guard; anything
// else exiting 77 is a failure. Keep this list in sync with the guard
// sites: grep -rln "process.exit(77)" tests/*.test.ts
const DECLARED_ENVIRONMENT_SKIPS = {
  // Runs order-item-addons / addon-price-integrity (ABI guard).
  'test:order-item-addons': 'better-sqlite3 ABI guard',
  'test:bill-print-warnings': 'better-sqlite3 ABI guard',
  'test:bill-printed-at': 'better-sqlite3 ABI guard',
  'test:bills-print-api': 'better-sqlite3 ABI guard',
  'test:cancel-override': 'better-sqlite3 ABI guard',
  'test:cash-closures': 'better-sqlite3 ABI guard',
  'test:cash-sessions': 'better-sqlite3 ABI guard',
  'test:customer-display-settings-route': 'better-sqlite3 ABI guard',
  'test:database-tools-api': 'better-sqlite3 ABI guard',
  'test:discount-system': 'better-sqlite3 ABI guard',
  // Runs first-run-setup (ABI guard).
  'test:first-run': 'better-sqlite3 ABI guard',
  'test:idempotency-retention': 'better-sqlite3 ABI guard',
  'test:integration-discount-settings': 'better-sqlite3 ABI guard',
  'test:issue-127-password-recovery': 'better-sqlite3 ABI guard',
  'test:kitchen-addons': 'better-sqlite3 ABI guard',
  'test:kot-print-queue': 'better-sqlite3 ABI guard',
  'test:merchant-print-templates': 'better-sqlite3 ABI guard',
  'test:merchant-template-transfer': 'better-sqlite3 ABI guard',
  'test:migration-v56-v57': 'better-sqlite3 ABI guard',
  'test:orders-layout-settings': 'better-sqlite3 ABI guard',
  'test:pos-sort-settings': 'better-sqlite3 ABI guard',
  // Composite: chains test:printer-api (ABI guard).
  'test:printer': 'chains test:printer-api (better-sqlite3 ABI guard)',
  'test:printer-api': 'better-sqlite3 ABI guard',
  'test:receipt-printing': 'better-sqlite3 ABI guard',
  'test:reports-daily-stats-table-turn': 'better-sqlite3 ABI guard',
  'test:reports-insights': 'better-sqlite3 ABI guard',
  'test:restore-fresh-install': 'better-sqlite3 ABI guard',
  'test:schema-health': 'better-sqlite3 ABI guard',
  'test:theme-mode-settings': 'better-sqlite3 ABI guard',
  'test:upgrade-path': 'better-sqlite3 ABI guard',
  // Alias of test:upgrade-path; behaves identically.
  'test:upgrade-regression': 'alias of test:upgrade-path (better-sqlite3 ABI guard)',
};

// The suite this wrapper is running, taken from the `npm run <name>` it
// was given. Null when the command is not an `npm run` invocation, in
// which case no skip can be declared for it.
function suiteNameFromArgs(args) {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === 'npm' && args[i + 1] === 'run' && /^test:[\w:-]+$/.test(args[i + 2] || '')) {
      return args[i + 2];
    }
  }
  return null;
}

// The exit code the wrapper must produce for a finished command.
// Pure (no I/O) so the rule is unit-testable: tests/run-test-wrapper.test.ts
function resolveExitCode(status, suiteName) {
  if (status === 77) {
    if (suiteName && DECLARED_ENVIRONMENT_SKIPS[suiteName]) return 0;
    return 1;
  }
  return status ?? 1;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    console.error('Usage: node scripts/run-test.cjs <test command> [args...]');
    process.exit(2);
  }

  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  const suiteName = suiteNameFromArgs([command, ...args]);
  if (result.status === 77) {
    if (suiteName && DECLARED_ENVIRONMENT_SKIPS[suiteName]) {
      console.log(
        `  ⏭ Skipped (${suiteName}): ${DECLARED_ENVIRONMENT_SKIPS[suiteName]} (exit 77, declared environment skip)`,
      );
      process.exit(0);
    }
    console.error(
      `  ✖ FAIL: ${suiteName || [command, ...args].join(' ')} exited 77, which is not a declared environment skip. ` +
        `Exit 77 is honoured only for suites on the DECLARED_ENVIRONMENT_SKIPS list in scripts/run-test.cjs.`,
    );
    process.exit(1);
  }
  process.exit(resolveExitCode(result.status, suiteName));
}

if (require.main === module) main();

module.exports = { DECLARED_ENVIRONMENT_SKIPS, suiteNameFromArgs, resolveExitCode };
