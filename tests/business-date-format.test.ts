/**
 * Business-date format + language-offering regression tests.
 *
 * Business dates render as DD/MM/YYYY with Latin digits and the Gregorian
 * calendar in both UI languages (Arabic and English), whatever the tenant
 * locale preferences say. The shared helpers in `main/countries.ts` are the
 * single implementation behind the UI hook and every printer path, so the
 * expectations are pinned here against known instants and timezones.
 *
 * The language half pins the Rest&Cafe offering: Arabic and English are the
 * only user-selectable languages, every catalogue stays registered (print
 * labels and saved preferences keep working), and Arabic is the registered
 * first-run default direction anchor (RTL).
 */
import assert from 'node:assert/strict';

import { formatBusinessDate, formatBusinessDateTime } from '../main/countries';
import { LANGUAGES } from '../frontend/src/lib/i18n/languages';

function assertEqualOrThrow<T>(actual: T, expected: T, label: string): void {
  assert.equal(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertMatchOrThrow(value: string, pattern: RegExp, label: string): void {
  assert.match(value, pattern, `${label}: ${JSON.stringify(value)} does not match ${pattern}`);
}

function run(): void {
  // The task's canonical example, in the tenant timezone.
  assertEqualOrThrow(
    formatBusinessDate(new Date('2026-10-25T12:00:00Z'), 'Asia/Damascus'),
    '25/10/2026',
    'Damascus business date',
  );
  // Zero-padded day and month.
  assertEqualOrThrow(
    formatBusinessDate(new Date('2026-01-05T12:00:00Z'), 'UTC'),
    '05/01/2026',
    'zero-padded date',
  );
  // Timezone conversion still applies: the same instant is the next day in
  // Damascus (UTC+3) and the same day in New York (UTC-4).
  const lateUtc = new Date('2026-10-25T23:30:00Z');
  assertEqualOrThrow(formatBusinessDate(lateUtc, 'Asia/Damascus'), '26/10/2026', 'Damascus rollover');
  assertEqualOrThrow(formatBusinessDate(lateUtc, 'America/New_York'), '25/10/2026', 'New York same day');
  // Latin digits only, Gregorian year — never Arabic-Indic digits or a
  // Hijri year (25 Oct 2026 falls in 1448 AH).
  const rendered = formatBusinessDate(new Date('2026-10-25T12:00:00Z'), 'Asia/Damascus');
  assertMatchOrThrow(rendered, /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/, 'Latin DD/MM/YYYY shape');
  // Leap day survives intact.
  assertEqualOrThrow(
    formatBusinessDate(new Date('2024-02-29T12:00:00Z'), 'UTC'),
    '29/02/2024',
    'leap day',
  );
  // Date-time variant: 24-hour Latin time appended.
  assertEqualOrThrow(
    formatBusinessDateTime(new Date('2026-10-25T13:05:00Z'), 'Asia/Damascus'),
    '25/10/2026 16:05',
    'Damascus business date-time',
  );
  assertMatchOrThrow(
    formatBusinessDateTime(new Date('2026-10-25T13:05:00Z'), 'UTC'),
    /^25\/10\/2026 [0-9]{2}:[0-9]{2}$/,
    'date-time shape',
  );

  // Language offering: exactly Arabic and English are selectable; every
  // other catalogue remains registered with its loader intact.
  const selectable = Object.entries(LANGUAGES)
    .filter(([, config]) => config.selectable)
    .map(([key]) => key)
    .sort();
  assert.deepEqual(selectable, ['ar', 'en'], `selectable languages: ${selectable.join(', ')}`);
  assertEqualOrThrow(LANGUAGES.ar.direction, 'rtl', 'Arabic direction');
  assertEqualOrThrow(LANGUAGES.en.direction, 'ltr', 'English direction');
  for (const [key, config] of Object.entries(LANGUAGES)) {
    assert.equal(typeof config.load, 'function', `${key} catalogue loader missing`);
    assert.ok(config.locale.length > 0, `${key} locale missing`);
  }

  console.log('  ✓ business dates render DD/MM/YYYY with Latin digits in ar/en contexts');
  console.log('  ✓ only Arabic and English are user-selectable; all catalogues stay registered');
}

try {
  run();
  console.log('\n✅ Business-date format checks passed.');
} catch (err) {
  console.error(err);
  process.exit(1);
}
