import * as assert from 'node:assert/strict';

const Module = require('module');
const originalLoad = Module._load;
const calls: { channel: string; args: unknown[] }[] = [];
const syncCalls: { channel: string; args: unknown[] }[] = [];
const eventHandlers = new Map<string, (...args: unknown[]) => void>();
let exposedApi: Record<string, unknown> | undefined;

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      contextBridge: {
        exposeInMainWorld: (name: string, api: Record<string, unknown>) => {
          assert.equal(name, 'electronAPI');
          exposedApi = api;
        },
      },
      ipcRenderer: {
        sendSync: (channel: string, ...args: unknown[]) => {
          syncCalls.push({ channel, args });
          return { success: true };
        },
        invoke: (channel: string, ...args: unknown[]) => {
          calls.push({ channel, args });
          return Promise.resolve();
        },
        on: (channel: string, handler: (...args: unknown[]) => void) => {
          eventHandlers.set(channel, handler);
        },
        removeListener: (channel: string, handler: (...args: unknown[]) => void) => {
          if (eventHandlers.get(channel) === handler) eventHandlers.delete(channel);
        },
      },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

try {
  require('../main/preload');
} finally {
  Module._load = originalLoad;
}

const kotDocument = {
  version: 1,
  direction: { base: 'ltr', document: 'ltr', block: 'ltr', value: 'ltr' },
  languages: ['en'],
  blocks: [
    {
      kind: 'kot-header',
      direction: 'ltr',
      banner: { primary: 'Kitchen Order Ticket' },
      stationLabel: { primary: 'Station' },
      stationName: { text: 'Kitchen', direction: 'ltr' },
      orderNumberLabel: { primary: 'Order' },
      orderNumber: { text: 'K-1', direction: 'ltr' },
      table: null,
      orderType: null,
      customer: null,
      timeLabel: { primary: 'Time' },
      timestamp: { text: '2026-01-01T12:00:00.000Z', direction: 'ltr' },
    },
    { kind: 'kot-items', direction: 'ltr', rows: [] },
  ],
};

async function run(): Promise<void> {
  assert.ok(exposedApi, 'preload exposes electronAPI');
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].channel, 'window-document');
  const documentNonce = syncCalls[0].args[0];
  assert.match(
    String(documentNonce),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.deepEqual(
    Object.keys(exposedApi!).sort(),
    [
      'backupDatabase',
      'dbApplySafeFixes',
      'dbHealthCheck',
      'dbInitialize',
      'getAppInfo',
      'getApplicationMenu',
      'getKdsInfo',
      'getLogTail',
      'getMasterPinStatus',
      'getPrinters',
      'getSettings',
      'getStatus',
      'getWindowState',
      'onMenuAction',
      'onWindowStateChanged',
      'openApplicationMenu',
      'openKdsWindow',
      'pickRestoreFile',
      'platform',
      'reportRendererError',
      'rasterizeKotDocument',
      'rasterizePrintDocument',
      'restoreBackup',
      'saveHtmlAsPdf',
      'setSetting',
      'setThemeEffective',
      'windowAction',
      'windowReady',
    ].sort(),
  );

  // The printer and daily-summary bridges are removed, not merely unwired:
  // both are reachable only through permission-gated HTTP routes now, and an
  // origin-checked IPC channel is the wrong place for either one.
  for (const removed of [
    'savePrinter',
    'getDailySummary',
    'getUpdateStatus',
    'onUpdateStatus',
    'checkForUpdates',
    'downloadUpdate',
    'getBetaChannel',
    'setBetaChannel',
    'getAutoUpdateCheck',
    'setAutoUpdateCheck',
    'restartAndInstall',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(exposedApi, removed),
      false,
      `preload no longer exposes ${removed}`,
    );
  }

  assert.equal(typeof exposedApi!.setThemeEffective, 'function');

  const call = (name: string, ...args: unknown[]) =>
    (exposedApi![name] as (...callArgs: unknown[]) => Promise<unknown>)(...args);
  await call('getSettings');
  await call('setSetting', 'theme_mode', 'dark');
  await call('getKdsInfo');
  await call('openKdsWindow');
  await call('getPrinters');
  await call('rasterizePrintDocument', {
    document: {},
    template: 'classic',
    profileId: 'profile',
    options: {},
  });
  await call('rasterizeKotDocument', { document: kotDocument, profileId: 'profile', options: {} });
  await call('saveHtmlAsPdf', {
    html: '<html></html>',
    defaultFileName: 'menu.pdf',
    pageSize: 'A4',
  });
  await call('windowReady', { epoch: 1 });
  await call('windowAction', 'minimize');
  await call('getWindowState');
  await call('reportRendererError', {
    message: 'boom',
    stack: 'stack',
    digest: 'd1',
    route: '/dashboard',
  });
  await call('getApplicationMenu');
  await call('openApplicationMenu', '0', 12, 0);

  const receivedWindowStates: unknown[] = [];
  const unsubscribeWindowState = (
    exposedApi!['onWindowStateChanged'] as (callback: (state: unknown) => void) => () => void
  )((state) => receivedWindowStates.push(state));
  const windowStatePayload = { isMaximized: true, isFullScreen: false };
  eventHandlers.get('window-state-changed')?.({}, windowStatePayload);
  assert.deepEqual(receivedWindowStates, [windowStatePayload]);
  unsubscribeWindowState();
  assert.equal(eventHandlers.has('window-state-changed'), false);

  assert.deepEqual(calls, [
    { channel: 'get-settings', args: [] },
    { channel: 'set-setting', args: ['theme_mode', 'dark'] },
    { channel: 'get-kds-info', args: [] },
    { channel: 'open-kds-window', args: [] },
    { channel: 'get-printers', args: [] },
    {
      channel: 'rasterize-print-document',
      args: [{ document: {}, template: 'classic', profileId: 'profile', options: {} }],
    },
    {
      channel: 'rasterize-kot-document',
      args: [{ document: kotDocument, profileId: 'profile', options: {} }],
    },
    {
      channel: 'save-html-as-pdf',
      args: [{ html: '<html></html>', defaultFileName: 'menu.pdf', pageSize: 'A4' }],
    },
    { channel: 'window-ready', args: [{ epoch: 1, documentNonce }] },
    { channel: 'window-action', args: ['minimize'] },
    { channel: 'get-window-state', args: [] },
    {
      channel: 'report-renderer-error',
      args: [{ message: 'boom', stack: 'stack', digest: 'd1', route: '/dashboard' }],
    },
    { channel: 'get-application-menu', args: [] },
    { channel: 'open-application-menu', args: ['0', 12, 0] },
  ]);

  for (const removedChannel of [
    'save-printer',
    'get-daily-summary',
    'get-update-status',
    'check-for-updates',
    'download-update',
    'restart-and-install',
  ]) {
    assert.equal(
      calls.some(({ channel }) => channel === removedChannel),
      false,
      `no renderer call reaches the ${removedChannel} channel`,
    );
  }

  console.log('Electron preload methods expose the expected narrow IPC channels.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
