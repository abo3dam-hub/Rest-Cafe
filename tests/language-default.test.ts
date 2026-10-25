/**
 * Language-default regression tests.
 *
 * Pins the first-run language contract:
 *  - a fresh installation (nothing persisted) starts in Arabic;
 *  - an existing saved language preference always wins, including a
 *    preference for a language that is no longer user-selectable;
 *  - a corrupt or unknown saved value falls back to Arabic, never throws;
 *  - the settings store's own initial language is Arabic, so the shell
 *    renders Arabic before any tenant sync.
 *
 * The selectable-language set itself is pinned in
 * business-date-format.test.ts.
 */
import * as path from 'node:path';

const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

// In-memory localStorage, installed before any frontend module loads so
// the zustand persist layer and the initial-language resolver both see
// the same (initially empty) storage a fresh install would have.
const storageBacking = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => (storageBacking.has(key) ? storageBacking.get(key)! : null),
  setItem: (key: string, value: string) => void storageBacking.set(key, String(value)),
  removeItem: (key: string) => void storageBacking.delete(key),
  clear: () => storageBacking.clear(),
};
(globalThis as any).window = globalThis;
(globalThis as any).localStorage = localStorageStub;

// Resolve the frontend's `@/` and `@countries` aliases the way the app
// bundler does (same approach as receipt-settings-hydration.test.ts).
const Module = require('module');
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request: string, parent: any, isMain: boolean, options?: any) {
  let resolvedRequest = request;
  if (request === '@countries') {
    resolvedRequest = path.resolve(__dirname, '../main/countries.ts');
  } else if (request.startsWith('@/')) {
    resolvedRequest = path.resolve(__dirname, '../frontend/src', request.slice(2));
  } else if (request.startsWith('@print/')) {
    resolvedRequest = path.resolve(__dirname, '../shared/print', request.slice('@print/'.length));
  } else if (request.startsWith('@shared/')) {
    resolvedRequest = path.resolve(__dirname, '../shared', request.slice('@shared/'.length));
  }
  return originalResolveFilename.call(this, resolvedRequest, parent, isMain, options);
};

let provider: any;
let posSettings: any;
try {
  provider = require('../frontend/src/components/providers/I18nProvider');
  posSettings = require('../frontend/src/store/pos-settings');
} finally {
  Module._resolveFilename = originalResolveFilename;
}

const { resolveInitialLanguage } = provider;
const { usePosSettingsStore } = posSettings;

function savedLanguagePayload(language: unknown): string {
  return JSON.stringify({ state: { language }, version: 0 });
}

function run(): void {
  assertOrThrow(typeof resolveInitialLanguage === 'function', 'resolveInitialLanguage is exported');

  // Fresh install: nothing persisted -> Arabic.
  storageBacking.clear();
  assertEqualOrThrow(resolveInitialLanguage(), 'ar', 'fresh install starts in Arabic');

  // The store itself also boots in Arabic before any sync.
  assertEqualOrThrow(
    usePosSettingsStore.getState().language,
    'ar',
    'settings store initial language is Arabic',
  );

  // A saved preference always wins.
  storageBacking.set('pos-settings', savedLanguagePayload('en'));
  assertEqualOrThrow(resolveInitialLanguage(), 'en', 'saved English preference is preserved');

  storageBacking.set('pos-settings', savedLanguagePayload('ar'));
  assertEqualOrThrow(resolveInitialLanguage(), 'ar', 'saved Arabic preference is preserved');

  // Even a preference for a language that is no longer selectable is
  // honoured — upgrading users are never silently switched.
  storageBacking.set('pos-settings', savedLanguagePayload('fa'));
  assertEqualOrThrow(
    resolveInitialLanguage(),
    'fa',
    'saved non-selectable preference is still preserved',
  );

  // Unknown or corrupt saved values fall back to Arabic.
  storageBacking.set('pos-settings', savedLanguagePayload('xx'));
  assertEqualOrThrow(resolveInitialLanguage(), 'ar', 'unknown saved language falls back to Arabic');

  storageBacking.set('pos-settings', '{not json');
  assertEqualOrThrow(resolveInitialLanguage(), 'ar', 'corrupt saved payload falls back to Arabic');

  storageBacking.clear();
  console.log('language-default: all checks passed');
}

run();
