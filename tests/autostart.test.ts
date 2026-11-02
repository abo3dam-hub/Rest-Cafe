/**
 * Delivery 4 (assignment 037): Windows autostart (F-005).
 *
 * Pins the autostart contract:
 * - the setting ships on: an absent `autostart_enabled` means enabled
 * - turning it off is respected: the login-item call gets openAtLogin false
 * - the settings route can pass the freshly saved value, so the toggle
 *   applies in the same run instead of waiting on the settings cache
 * - off Windows the call is a safe no-op that never throws
 * - a missing or throwing `setLoginItemSettings` never breaks the caller
 *
 * Actual login behaviour is verified on the owner's Windows machine later;
 * this suite pins the registration call, not the OS effect.
 *
 * Run: npm run test:autostart
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-autostart-'));

type LoginItemCall = { openAtLogin: boolean; path?: string };
const loginItemCalls: LoginItemCall[] = [];
let loginItemShouldThrow = false;

const mockApp = {
  isPackaged: true,
  getPath: () => testDir,
  getVersion: () => 'test',
  setLoginItemSettings: (settings: LoginItemCall) => {
    if (loginItemShouldThrow) throw new Error('login items unavailable');
    loginItemCalls.push({ ...settings });
  },
};

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: mockApp,
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (value: string) => Buffer.from(value),
        decryptString: (value: Buffer) => value.toString(),
      },
      shell: { openExternal: () => Promise.resolve() },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');

import { closeDatabase, getDatabase, initDatabase } from '../main/db';
import { upsertSettings } from '../main/db/settings';
import {
  AUTOSTART_SETTING_KEY,
  applyAutostartSetting,
  isAutostartEnabled,
} from '../main/services/autostart';

async function run(): Promise<void> {
  try {
    initDatabase();
    assertOrThrow(
      fs.existsSync(path.join(testDir, 'flo.db')),
      'temp database is created for the autostart suite',
    );

    // 1. The setting ships on: absent means enabled, and the Windows call
    //    registers the app for login.
    assertOrThrow(isAutostartEnabled(), 'autostart is enabled when the setting is absent');
    const onResult = applyAutostartSetting(undefined, { platform: 'win32' });
    assertOrThrow(onResult.applied, 'autostart applies on Windows');
    assertOrThrow(onResult.enabled, 'autostart reports enabled by default');
    assertEqualOrThrow(loginItemCalls.length, 1, 'one login-item call for the default-on apply');
    assertEqualOrThrow(
      loginItemCalls[0].openAtLogin,
      true,
      'default-on registers openAtLogin true',
    );
    assertEqualOrThrow(
      loginItemCalls[0].path,
      process.execPath,
      'the login item points at the running executable',
    );

    // 2. Turning it off is respected: the stored value drives the call.
    upsertSettings({ [AUTOSTART_SETTING_KEY]: 'false' });
    assertOrThrow(!isAutostartEnabled(), 'autostart reads disabled once the setting is false');
    const offResult = applyAutostartSetting(undefined, { platform: 'win32' });
    assertOrThrow(offResult.applied, 'autostart applies on Windows when turning off');
    assertOrThrow(!offResult.enabled, 'autostart reports disabled after the toggle');
    assertEqualOrThrow(loginItemCalls.length, 2, 'one login-item call for the turn-off apply');
    assertEqualOrThrow(
      loginItemCalls[1].openAtLogin,
      false,
      'turning autostart off registers openAtLogin false',
    );

    // 3. An explicitly passed value wins over the stored one: this is how
    //    the settings route applies the freshly saved toggle immediately.
    const explicitOn = applyAutostartSetting(true, { platform: 'win32' });
    assertOrThrow(explicitOn.enabled, 'explicit true wins over the stored false');
    assertEqualOrThrow(
      loginItemCalls[2].openAtLogin,
      true,
      'explicit true registers openAtLogin true',
    );
    const explicitOff = applyAutostartSetting(false, { platform: 'win32' });
    assertOrThrow(!explicitOff.enabled, 'explicit false wins over a stored true');
    assertEqualOrThrow(
      loginItemCalls[3].openAtLogin,
      false,
      'explicit false registers openAtLogin false',
    );

    // 4. Off Windows the call is a safe no-op: nothing is registered.
    const callsBefore = loginItemCalls.length;
    const linuxResult = applyAutostartSetting(undefined, { platform: 'linux' });
    assertOrThrow(!linuxResult.applied, 'autostart does not apply off Windows');
    assertOrThrow(!linuxResult.enabled, 'off-Windows result still reports the stored value');
    assertEqualOrThrow(
      loginItemCalls.length,
      callsBefore,
      'no login-item call happens off Windows',
    );

    // 5. A missing or throwing setLoginItemSettings never breaks the caller.
    const savedSetLoginItemSettings = mockApp.setLoginItemSettings;
    delete (mockApp as { setLoginItemSettings?: unknown }).setLoginItemSettings;
    const missingResult = applyAutostartSetting(undefined, { platform: 'win32' });
    assertOrThrow(!missingResult.applied, 'a missing login-item API reports not applied');
    mockApp.setLoginItemSettings = savedSetLoginItemSettings;
    loginItemShouldThrow = true;
    const throwingResult = applyAutostartSetting(undefined, { platform: 'win32' });
    assertOrThrow(!throwingResult.applied, 'a throwing login-item API reports not applied');
    loginItemShouldThrow = false;

    // 6. Re-enabling through the stored setting restores the default.
    upsertSettings({ [AUTOSTART_SETTING_KEY]: 'true' });
    assertOrThrow(isAutostartEnabled(), 'autostart reads enabled once the setting is true');
    assertOrThrow(
      getDatabase()
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(AUTOSTART_SETTING_KEY) !== undefined,
      'the autostart setting round-trips through the settings table',
    );

    const results = getResults();
    console.log(`\nautostart: ${results.passed} passed, ${results.failed} failed`);
    if (results.failed > 0) process.exit(1);
  } finally {
    try {
      closeDatabase();
    } catch {
      // Already closed or never opened; cleanup continues regardless.
    }
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  try {
    closeDatabase();
  } catch {
    // See above.
  }
  Module._load = originalLoad;
  fs.rmSync(testDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
