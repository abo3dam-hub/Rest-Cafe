import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Menu,
  Tray,
  nativeImage,
  shell,
  powerMonitor,
  nativeTheme,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

import { Bonjour } from 'bonjour-service';
import {
  getDatabase,
  initDatabase,
  closeDatabase,
  waitForDatabaseRequests,
  beginDatabaseShutdown,
} from './db';
import { computeTaxPackUpdates, fetchRemoteTaxPackCatalog } from './tax-packs/catalog';
import { startServer, stopServer, getLocalIP, isServerRunning, getServerPort } from './server';
import { operationDiagnostics } from './services/operation-diagnostics';
import { isOfflineMode } from './services/offline-mode';
import { localBackup } from './services/local-backup';
import { startKdsServer, stopKdsServer, getKdsPort, isKdsServerRunning } from './kds-server';
import { startServerApp, stopServerApp, getServerAppPort, isServerAppRunning } from './server-app';
import { initPrinter } from './printers/thermal';
import { destroySharedRasterRenderer } from './printers/raster-renderer';
import { isTrustedMainWindowSender, registerIpcHandlers } from './ipc';
import log from 'electron-log/main';
import { isAllowedLocalWindowUrl, isSafeExternalUrl } from './security/url-allowlist';
import { clearStaleRenderCachesOnVersionChange } from './startup-cache';
import {
  createLocalWindowOpenHandler,
  createMainWindow,
  createMainWindowWillNavigateHandler,
  resolveTitleBarMode,
  type TitleBarMode,
} from './window-options';
import {
  applyTitleBarOverlayTheme,
  resolveTitleBarOverlayColors,
  resolveInitialIsDark,
  resolveThemeMode,
  type ThemeMode,
} from './title-bar-theme';
import {
  beginRendererDocument,
  getRendererDocumentNonce,
  getRendererReadinessEpoch,
  initWindowReadiness,
  isRendererReadinessFailSafeShown,
  isFullDocumentMainFrameNavigation,
  isWindowRendererReady,
} from './window-readiness';
import { setupWindowLoadRetry } from './window-load-retry';
import { createFailedWindowRecovery, shouldQuitOnAllWindowsClosed } from './window-recovery';
import { registerUsbDevicePermissions } from './usb-device-permissions';
import { probeBackendHealth } from './backend-health';
import {
  createRelaunchAttemptGuard,
  createRelaunchGate,
  decideRuntimeActivationAction,
  hasRelaunchAttemptFlag,
  isRuntimeHealthy,
  type RuntimeState,
} from './runtime-recovery';
import {
  createShutdownCoordinator,
  createShutdownEntrypoints,
  SHUTDOWN_TIMEOUT_MS,
  waitForHttpShutdownWork,
  type ShutdownEntrypointApp,
  type ShutdownEntrypointProcess,
} from './shutdown';

// Disable GPU sandbox on Windows to avoid DLL crash fallback
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'debug';
// electron-log's default rotation (~1MB, one archived copy) already bounds disk usage.
const logPath = log.transports.file.getFile().path.replace(/[^\/\\]+$/, '');
console.log('[Log] Log files location:', logPath);

let startupFailure = false;

// Beta channel opt-in stored in SQLite settings; defaults to stable on error.

// Best-effort startup check for tax pack plugin updates.
async function checkTaxPackUpdatesOnStartup(): Promise<void> {
  if (isOfflineMode()) return;
  try {
    const remote = await fetchRemoteTaxPackCatalog();
    const installedRows = getDatabase()
      .prepare(`
      SELECT pack.id AS pack_id, pack.country, pack.publisher, version.version
      FROM country_packs AS pack
      JOIN country_pack_versions AS version ON version.id = pack.active_version_id
      WHERE pack.status = 'active'
    `)
      .all() as Array<{ pack_id: string; country: string; publisher: string; version: string }>;
    const updates = computeTaxPackUpdates(
      installedRows.map((row) => ({
        packId: row.pack_id,
        country: row.country,
        publisher: row.publisher,
        version: row.version,
      })),
      remote.catalog,
    );
    if (updates.length > 0) {
      const summary = updates
        .map((update) => `${update.packId} ${update.currentVersion} -> ${update.latestVersion}`)
        .join(', ');
      console.log(`[Tax Packs] ${updates.length} plugin update(s) available: ${summary}`);
    } else {
      console.log('[Tax Packs] Plugin update check: all installed tax packs are up to date');
    }
  } catch (error) {
    console.warn(
      '[Tax Packs] Startup plugin update check skipped (offline or catalog unavailable):',
      error,
    );
  }
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
// Track USB device permissions registration so listeners are not duplicated across windows.
let usbDevicePermissionsRegistered = false;

// Title-bar capability reported to the renderer via get-status; updated each
// time the main window is created.
let resolvedTitleBarMode: TitleBarMode = 'native-overlay';
// Injected as a getter into ipc.ts — it cannot import ./index (load-time cycle).
let currentEffectiveIsDark = false;
let bonjour: InstanceType<typeof Bonjour> | null = null;
let isQuitting = false;
let runtimeState: RuntimeState = 'starting';
let initializationPromise: Promise<void> | null = null;
let activationPending = false;
let runtimeRelaunchRequested = false;
// Last did-fail-load detail captured for diagnostic dialog; cleared on successful load.
let lastWindowLoadFailure: {
  errorCode: number;
  errorDescription: string;
  validatedURL?: string;
} | null = null;
// Self-healing GPU fallback: relaunch with --disable-gpu after repeated crashes.
let shouldDisableGpuOnRelaunch = false;
let consecutiveRendererCrashes = 0;
const GPU_FALLBACK_CRASH_THRESHOLD = 2;
// Reset crash counters only after a window stays up for this duration.
const RENDERER_STABILITY_RESET_MS = 30_000;
let rendererStabilityResetTimer: NodeJS.Timeout | null = null;
function clearRendererStabilityResetTimer(): void {
  if (rendererStabilityResetTimer) {
    clearTimeout(rendererStabilityResetTimer);
    rendererStabilityResetTimer = null;
  }
}

function showMainWindow(expectedWindow?: BrowserWindow): boolean {
  if (isQuitting || isShutdownRequested()) return false;
  if (expectedWindow && mainWindow !== expectedWindow) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (!isRuntimeHealthy(runtimeState, getRuntimeServices(), isShutdownRequested())) {
    void handleMainWindowActivation();
    return false;
  }
  if (isFailedWindowDocument(mainWindow)) {
    recoverFailedWindow(mainWindow);
    return false;
  }
  if (!isWindowRendererReady() && !isRendererReadinessFailSafeShown()) return false;
  // Native E2E drives the real app without popping a window on the developer's
  // desktop; the renderer keeps running unthrottled (see createWindow).
  if (process.env.FLO_E2E_HIDDEN_WINDOW === '1') return true;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.focus();
  return true;
}

function getRuntimeServices() {
  return {
    main: isServerRunning(),
    kds: isKdsServerRunning(),
    serverApp: isServerAppRunning(),
  };
}

function isFailedWindowDocument(window: BrowserWindow): boolean {
  try {
    return window.webContents.getURL().startsWith('chrome-error://');
  } catch {
    return true;
  }
}

const failedWindowRecovery = createFailedWindowRecovery({
  getMainWindow: () => mainWindow,
  isAborted: () => isQuitting || isShutdownRequested() || runtimeState === 'stopping',
  isRuntimeHealthy: () =>
    isRuntimeHealthy(runtimeState, getRuntimeServices(), isShutdownRequested()),
  requestRelaunch: (reason) => requestRuntimeRelaunchOnce(reason),
  createWindow,
  logError: (message, error) => log.error(message, error),
});

function recoverFailedWindow(failedWindow: BrowserWindow): void {
  failedWindowRecovery.recover(failedWindow);
}

// Flag passed in argv to prevent infinite relaunch loops across process restarts.
const RUNTIME_RELAUNCH_ATTEMPT_FLAG = '--flo-runtime-relaunch-attempt';

function hasAlreadyAttemptedRuntimeRelaunch(): boolean {
  return hasRelaunchAttemptFlag(process.argv, RUNTIME_RELAUNCH_ATTEMPT_FLAG);
}

// Gates repeat relaunches across process restarts until runtime recovers.
const relaunchAttemptGuard = createRelaunchAttemptGuard(hasAlreadyAttemptedRuntimeRelaunch());

function performAppRelaunch(): void {
  // Preserve --disable-gpu flag on relaunch if GPU fallback was triggered.
  const wantsGpuDisabled = shouldDisableGpuOnRelaunch || app.commandLine.hasSwitch('disable-gpu');
  if (process.defaultApp || !app.isPackaged) {
    const relaunchArgs = process.argv.slice(1).map((arg) => (arg === '.' ? process.cwd() : arg));
    // Retain sandbox and display flags required under Playwright/CI.
    if (app.commandLine.hasSwitch('no-sandbox') && !relaunchArgs.includes('--no-sandbox')) {
      relaunchArgs.push('--no-sandbox');
    }
    if (wantsGpuDisabled && !relaunchArgs.includes('--disable-gpu')) {
      relaunchArgs.push('--disable-gpu');
    }
    if (
      app.commandLine.hasSwitch('disable-dev-shm-usage') &&
      !relaunchArgs.includes('--disable-dev-shm-usage')
    ) {
      relaunchArgs.push('--disable-dev-shm-usage');
    }
    if (!relaunchArgs.includes(RUNTIME_RELAUNCH_ATTEMPT_FLAG))
      relaunchArgs.push(RUNTIME_RELAUNCH_ATTEMPT_FLAG);
    app.relaunch({ execPath: process.execPath, args: relaunchArgs });
  } else {
    const relaunchArgs = process.argv.slice(1);
    if (wantsGpuDisabled && !relaunchArgs.includes('--disable-gpu')) {
      relaunchArgs.push('--disable-gpu');
    }
    if (!relaunchArgs.includes(RUNTIME_RELAUNCH_ATTEMPT_FLAG))
      relaunchArgs.push(RUNTIME_RELAUNCH_ATTEMPT_FLAG);
    app.relaunch({ args: relaunchArgs });
  }
}

// Dialog shown when runtime repeatedly fails after a restart.
async function showRuntimeStuckDialog(reason: string): Promise<void> {
  const services = getRuntimeServices();
  const detailLines = [
    `Reason: ${reason}`,
    `Server: ${services.main ? 'running' : 'stopped'} | KDS: ${services.kds ? 'running' : 'stopped'} | Server App: ${services.serverApp ? 'running' : 'stopped'}`,
  ];
  if (lastWindowLoadFailure) {
    detailLines.push(
      `Load error: ${lastWindowLoadFailure.errorDescription} (${lastWindowLoadFailure.errorCode})`,
      `URL: ${lastWindowLoadFailure.validatedURL ?? `http://localhost:${getServerPort()}`}`,
    );
  }
  detailLines.push(`Platform: ${process.platform} | Rest&Cafe: ${app.getVersion()}`);

  const { response } = await dialog.showMessageBox({
    type: 'error',
    title: 'Rest&Cafe needs to restart',
    message:
      'Rest&Cafe could not recover automatically. This usually means another program ' +
      '(antivirus, firewall, or a leftover Rest&Cafe process) is blocking its local server.\n\n' +
      'Please quit and reopen the app. If this keeps happening, sending a diagnostic ' +
      'report helps us fix it — it contains no order, customer, or business data.',
    detail: detailLines.join('\n'),
    buttons: ['Send Diagnostic Report', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (response !== 0) return;

  operationDiagnostics.captureOperationFailure({
    capture_point: 'fc.electron.runtime.relaunch_exhausted',
    outcome: 'unknown',
  });

  await dialog.showMessageBox({
    type: 'info',
    title: 'Rest&Cafe',
    message:
      'Diagnostic captured. If sharing is enabled and this device is online, it will be sent automatically.',
    buttons: ['Quit'],
  });
}

function requestRuntimeRelaunch(reason: string): void {
  runtimeState = 'stopping';
  isQuitting = true;
  runtimeRelaunchRequested = true;
  log.error(`[Lifecycle] Runtime recovery relaunch requested: ${reason}`);
  if (process.env.FLO_E2E_PID_FILE) console.log('[Native E2E] runtime relaunch requested');

  const alreadyAttempted = relaunchAttemptGuard.hasExhaustedAttempt();

  const finishRelaunch = (): void => {
    if (alreadyAttempted) {
      log.error(
        `[Lifecycle] Runtime already relaunched once and failed again (${reason}); not relaunching again.`,
      );
      void showRuntimeStuckDialog(reason)
        .catch((error) => log.error('[Lifecycle] Runtime-stuck dialog failed:', error))
        .finally(() => {
          try {
            app.exit(0);
          } catch (error) {
            log.error('[Lifecycle] Exit after runtime-stuck dialog failed:', error);
            app.exit(1);
          }
        });
      return;
    }
    try {
      log.info('[Lifecycle] Runtime cleanup finished; relaunching Flo');
      performAppRelaunch();
      app.exit(0);
    } catch (error) {
      log.error('[Lifecycle] Runtime relaunch failed after cleanup:', error);
      app.exit(1);
    }
  };

  void runCleanup().then(finishRelaunch, (error) => {
    log.error('[Lifecycle] Runtime recovery cleanup failed; proceeding anyway:', error);
    finishRelaunch();
  });
}

const requestRuntimeRelaunchOnce = createRelaunchGate(requestRuntimeRelaunch);

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;

let gotSingleInstanceLock = false;

// Single-instance lock: prevent duplicate app instances.
if (process.env.FLO_E2E_USER_DATA_DIR) {
  // Use isolated profile directory in E2E tests.
  app.setPath('userData', path.resolve(process.env.FLO_E2E_USER_DATA_DIR));
} else if (process.platform === 'linux') {
  // Set explicit paths on Linux to avoid temporary mount directories.
  app.name = 'rest-cafe-desktop';
  app.setPath('userData', path.join(os.homedir(), '.config', 'rest-cafe'));
} else if (app.isPackaged) {
  // Rest&Cafe: pin the data directory under our own fixed name, so a future
  // rebrand or productName change can never move a restaurant's database.
  app.setPath('userData', path.join(app.getPath('appData'), 'RestCafe'));
}

gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.log('[Lock] Another instance is already running. Quitting.');
  app.quit();
  process.exit(0);
}

if (gotSingleInstanceLock) {
  // Focus the existing window if a second launch is attempted.
  app.on('second-instance', () => {
    void handleMainWindowActivation();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.focus();
      if (process.platform === 'linux') {
        mainWindow.setAlwaysOnTop(true);
        mainWindow.setAlwaysOnTop(false);
        app.focus();
      }
    }
  });
}

function createWindow(): void {
  if (isQuitting || isShutdownRequested()) return;
  if (!isRuntimeHealthy(runtimeState, getRuntimeServices(), isShutdownRequested())) {
    log.error('[Lifecycle] Refusing to create a POS window without a healthy runtime');
    requestRuntimeRelaunchOnce('create-window-without-healthy-runtime');
    return;
  }

  // Clear stale GPU/code caches when Electron version upgrades.
  clearStaleRenderCachesOnVersionChange(app.getPath('userData'), process.versions.electron, log);

  // Initialize readiness fail-safe and start document epoch.
  initWindowReadiness(() => {
    showMainWindow();
  });
  beginRendererDocument();

  // Resolve whether native title bar overlay is supported or if fallback is required.
  resolvedTitleBarMode = resolveTitleBarMode({
    platform: process.platform,
    electronVersion: process.versions.electron,
    overlayApiPresent: typeof BrowserWindow.prototype?.setTitleBarOverlay === 'function',
  });
  // Direct read: createWindow() runs before IPC handlers exist; re-read on
  // crash-recovery re-entry. Absent/invalid rows resolve to 'system'.
  let themeMode: ThemeMode = 'system';
  try {
    const row = getDatabase()
      .prepare("SELECT value FROM settings WHERE key = 'theme_mode'")
      .get() as { value?: string } | undefined;
    themeMode = resolveThemeMode(row?.value);
  } catch {
    // No DB yet (first boot edge) → 'system'.
  }
  const initialIsDark = resolveInitialIsDark(themeMode, nativeTheme.shouldUseDarkColors);
  currentEffectiveIsDark = initialIsDark;
  const createdWindow = createMainWindow(
    BrowserWindow,
    path.join(__dirname, 'preload.js'),
    process.platform,
    initialIsDark,
    resolvedTitleBarMode,
    // Hidden windows are throttled by Chromium; the native E2E harness still
    // needs live timers and WebSocket traffic from a window it never shows.
    process.env.FLO_E2E_HIDDEN_WINDOW === '1'
      ? { webPreferences: { backgroundThrottling: false } }
      : undefined,
  );
  mainWindow = createdWindow;

  mainWindow.once('ready-to-show', () => {
    // The native E2E harness drives the app through Playwright from a window it
    // never shows, so it must not spawn DevTools on the developer's desktop.
    if (isDev && process.env.FLO_E2E_HIDDEN_WINDOW !== '1') {
      mainWindow?.webContents.openDevTools();
    }
  });

  // Track full navigations to begin new readiness epochs.
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isSameDocument, isMainFrame) => {
    if (isFullDocumentMainFrameNavigation({ isSameDocument, isMainFrame })) {
      beginRendererDocument();
    }
  });

  // Always load from the embedded Express server (serves static Next.js export).
  // This avoids file:// protocol issues and keeps dev/prod behaviour identical.
  mainWindow.loadURL(`http://localhost:${getServerPort()}`);

  const mainWindowWillNavigateHandler = createMainWindowWillNavigateHandler(
    isAllowedLocalWindowUrl,
    getServerPort,
    getLocalIP,
    isSafeExternalUrl,
    (url) => shell.openExternal(url),
    (msg, ...args) => console.warn(msg, ...args),
  );
  mainWindow.webContents.on('will-navigate', mainWindowWillNavigateHandler);

  // Allow target="_blank" links to open new windows for local URLs (e.g. the KDS page)
  // and blank popup windows (e.g. browser print popups). External URLs are sent to the system browser.
  const localWindowOpenHandler = createLocalWindowOpenHandler(
    isAllowedLocalWindowUrl,
    getServerPort,
    getLocalIP,
  );
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    const localWindowResponse = localWindowOpenHandler({ url });
    if (localWindowResponse) return localWindowResponse;

    if (isSafeExternalUrl(url)) {
      shell
        .openExternal(url)
        .catch((err) => console.warn('[Flo] Failed to open external URL:', err?.message || err));
    } else {
      console.warn('[Flo] Blocked unsafe external URL scheme:', url);
    }
    return { action: 'deny' };
  });

  // Intercept all renderer downloads and show a save dialog instead of
  // auto-saving to Downloads — required for MAS sandbox compliance.
  mainWindow.webContents.session.on('will-download', (_event, item) => {
    item.setSaveDialogOptions({
      defaultPath: path.join(app.getPath('documents'), item.getFilename()),
    });
  });

  // Register WebUSB permissions for direct thermal printer connection.
  if (!usbDevicePermissionsRegistered) {
    registerUsbDevicePermissions(
      mainWindow.webContents.session,
      `http://localhost:${getServerPort()}`,
    );
    usbDevicePermissionsRegistered = true;
  }

  const sendWindowState = () => {
    if (!createdWindow || createdWindow.isDestroyed()) return;
    try {
      createdWindow.webContents.send('window-state-changed', {
        isMaximized: createdWindow.isMaximized(),
        isFullScreen: createdWindow.isFullScreen(),
      });
    } catch {
      // Ignored if webContents destroyed
    }
  };

  createdWindow.on('maximize', sendWindowState);
  createdWindow.on('unmaximize', sendWindowState);
  createdWindow.on('enter-full-screen', sendWindowState);
  createdWindow.on('leave-full-screen', sendWindowState);

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    if (mainWindow === createdWindow) mainWindow = null;
  });

  mainWindow.webContents.once('did-finish-load', () => {
    failedWindowRecovery.markLoadSucceeded();
    lastWindowLoadFailure = null;
    clearRendererStabilityResetTimer();
    rendererStabilityResetTimer = setTimeout(() => {
      rendererStabilityResetTimer = null;
      consecutiveRendererCrashes = 0;
    }, RENDERER_STABILITY_RESET_MS);
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    log.error('[Window] Renderer process gone:', details.reason);
    console.error('[Window] Renderer process gone:', details.reason);

    if (details.reason !== 'clean-exit') {
      // Crash invalidated stability; cancel reset timer.
      clearRendererStabilityResetTimer();
      if (!isQuitting && !isShutdownRequested()) {
        consecutiveRendererCrashes++;
        operationDiagnostics.captureOperationFailure({
          capture_point: 'fc.electron.renderer.process_gone',
          outcome: 'unknown',
        });
      }
      if (consecutiveRendererCrashes >= GPU_FALLBACK_CRASH_THRESHOLD) {
        shouldDisableGpuOnRelaunch = true;
        log.error(
          '[Window] Repeated renderer crashes — requesting relaunch with hardware acceleration disabled.',
        );
        requestRuntimeRelaunchOnce('renderer-repeated-crash-gpu-fallback');
      }
    }

    if (details.reason !== 'clean-exit' && mainWindow === createdWindow) {
      dialog
        .showMessageBox({
          type: 'error',
          title: 'App Crashed',
          message: 'The app crashed and will restart.',
          detail: `Reason: ${details.reason}`,
          buttons: ['OK'],
        })
        .then(() => {
          if (mainWindow !== createdWindow) return;
          failedWindowRecovery.suppressAllClosedQuit(() => {
            createdWindow.destroy();
            if (mainWindow === createdWindow) mainWindow = null;
            void handleMainWindowActivation();
          });
        })
        .catch((error) => {
          log.error('[Window] Renderer crash recovery failed:', error);
          if (!isQuitting && !isShutdownRequested()) {
            requestRuntimeRelaunchOnce('renderer-crash-recovery-failed');
          }
        });
    }
  });

  setupWindowLoadRetry(createdWindow, () => `http://localhost:${getServerPort()}`, {
    log,
    onRetryExhausted: ({ errorCode, errorDescription, validatedURL, retries }) => {
      log.error(
        '[Window] Load retry exhaustion:',
        errorCode,
        errorDescription,
        validatedURL,
        `retries=${retries}`,
      );
      lastWindowLoadFailure = { errorCode, errorDescription, validatedURL };
      recoverFailedWindow(createdWindow);
    },
  });

  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[Window] Window became unresponsive');
  });

  mainWindow.webContents.on('responsive', () => {
    console.log('[Window] Window became responsive again');
  });
}

async function handleMainWindowActivation(): Promise<void> {
  const services = getRuntimeServices();
  const hasWindow = Boolean(mainWindow && !mainWindow.isDestroyed());
  const action = decideRuntimeActivationAction({
    state: runtimeState,
    hasWindow,
    services,
    shutdownRequested: isQuitting || isShutdownRequested(),
  });
  log.info(
    `[Lifecycle] Activation action=${action} state=${runtimeState}` +
      ` services=${services.main ? 'main' : 'no-main'},${services.kds ? 'kds' : 'no-kds'},${services.serverApp ? 'server-app' : 'no-server-app'}`,
  );

  if (action === 'show') {
    // Confirm backend HTTP listeners are actively responding before showing window.
    const reallyHealthy = await probeBackendHealth({
      server: getServerPort(),
      kds: getKdsPort(),
      serverApp: getServerAppPort(),
    });
    // Ignore probe results if shutdown or update was initiated while probing.
    if (isQuitting || isShutdownRequested()) return;
    if (!reallyHealthy) {
      requestRuntimeRelaunchOnce('activation-health-probe-failed');
      return;
    }
    showMainWindow();
    return;
  }
  if (action === 'create') {
    createWindow();
    return;
  }
  if (action === 'wait') {
    if (!initializationPromise) {
      activationPending = true;
      return;
    }
    void initializationPromise.then(
      () => {
        void handleMainWindowActivation();
      },
      (error) => {
        log.error('[Lifecycle] Startup failed while activation was waiting:', error);
        requestRuntimeRelaunchOnce('activation-startup-failed');
      },
    );
    return;
  }
  if (action === 'ignore') return;

  requestRuntimeRelaunchOnce(`activation-runtime-unavailable-${runtimeState}`);
}

// Sleep/wake recovery: nudge window dimensions on resume to force GPU compositor repaint.
function registerPowerMonitorRecovery(): void {
  powerMonitor.on('resume', () => {
    console.log('[Window] System resumed from sleep, forcing repaint');
    // Allow display pipeline to wake before nudging.
    setTimeout(() => {
      if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return;
      const [width, height] = mainWindow.getSize();
      mainWindow.setSize(width + 1, height);
      mainWindow.setSize(width, height);
    }, 1000);
  });
}

// Track child process crashes and trigger GPU fallback relaunch on GPU crash.
function registerChildProcessCrashTelemetry(): void {
  app.on('child-process-gone', (_event, details) => {
    const systemErrorCode =
      'systemErrorCode' in details
        ? (details as { systemErrorCode?: number }).systemErrorCode
        : undefined;
    log.error(
      '[Process] Child process gone:',
      details.type,
      details.reason,
      details.exitCode,
      systemErrorCode !== undefined ? `systemErrorCode=${systemErrorCode}` : '',
    );
    console.error(
      '[Process] Child process gone:',
      details.type,
      details.reason,
      details.exitCode,
      systemErrorCode !== undefined ? `systemErrorCode=${systemErrorCode}` : '',
    );
    // Ignore normal shutdown/clean-exit signals.
    const isGpuFailure =
      details.type === 'GPU' &&
      details.reason !== 'clean-exit' &&
      !isQuitting &&
      !isShutdownRequested();
    if (isGpuFailure) {
      // Cancel the stability reset timer after a GPU crash.
      clearRendererStabilityResetTimer();
    }
    if (details.reason !== 'clean-exit' && !isQuitting && !isShutdownRequested()) {
      operationDiagnostics.captureOperationFailure({
        capture_point: 'fc.electron.child.process_gone',
        outcome: 'unknown',
      });
    }
    if (isGpuFailure) {
      // Hardware acceleration fallback after GPU process crash.
      shouldDisableGpuOnRelaunch = true;
      log.error(
        '[Process] GPU process crashed — requesting relaunch with hardware acceleration disabled.',
      );
      requestRuntimeRelaunchOnce('gpu-process-crashed');
    }
  });
}

function createTray(): void {
  if (process.platform === 'linux') {
    // Linux tray: provides persistent icon to restore or quit the app.
    const linuxIconPath = isDev
      ? path.join(__dirname, '../../assets/icon-512.png')
      : path.join(process.resourcesPath, 'assets/icon-512.png');

    try {
      const linuxIcon = nativeImage.createFromPath(linuxIconPath);
      tray = new Tray(linuxIcon.resize({ width: 22, height: 22 }));

      const linuxMenu = Menu.buildFromTemplate([
        {
          label: 'Show',
          click: () => {
            if (mainWindow) {
              if (showMainWindow()) mainWindow.focus();
            }
          },
        },
        { type: 'separator' },
        {
          label: 'Quit',
          click: () => {
            isQuitting = true;
            // On Debian/AppIndicator, quitting while the context menu is open
            // can cause a deadlock. Defer the teardown so the menu can close.
            setTimeout(() => {
              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.destroy();
              }
              // Explicitly destroy tray to release the AppIndicator lock
              if (tray) {
                tray.destroy();
                tray = null;
              }
              // Defer quit so context menu can close and drain resources cleanly.
              app.quit();
            }, 100);
          },
        },
      ]);

      tray.setToolTip('Rest&Cafe');
      tray.setContextMenu(linuxMenu);
      // Single-click also shows the window on Linux (no double-click standard).
      tray.on('click', () => {
        if (mainWindow) {
          if (showMainWindow()) mainWindow.focus();
        }
      });

      console.log('[Tray] Linux tray created');
    } catch {
      console.log('[Tray] Linux icon not found, skipping tray');
    }
    return;
  }

  // ── macOS / Windows tray ─────────────────────────────────────────────────
  const iconPath = isDev
    ? path.join(__dirname, '../../assets/icon.png')
    : path.join(process.resourcesPath, 'assets/icon.png');

  try {
    const icon = nativeImage.createFromPath(iconPath);
    tray = new Tray(icon.resize({ width: 16, height: 16 }));

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Rest&Cafe',
        click: () => {
          showMainWindow();
        },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ]);

    tray.setToolTip('Rest&Cafe');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => {
      showMainWindow();
    });
  } catch {
    console.log('[Tray] Icon not found, skipping tray');
  }
}

function startMdns(): void {
  try {
    bonjour = new Bonjour();
    bonjour.publish({
      name: 'Rest&Cafe',
      type: 'http',
      port: getServerPort(),
      host: 'flo', // resolves as flo.local on the LAN
      txt: {
        version: app.getVersion(),
        kds: `/kds`,
        kds_port: String(getKdsPort()),
        server_app: '/server-standalone',
        server_app_port: String(getServerAppPort()),
      },
    });
    const ip = getLocalIP();
    console.log(
      `[mDNS] Advertising flo.local:${getServerPort()}  (IP fallback: http://${ip}:${getServerPort()})`,
    );
    console.log(
      `[mDNS] KDS available at http://flo.local:${getKdsPort()}  (IP fallback: http://${ip}:${getKdsPort()})`,
    );
    console.log(
      `[mDNS] Server App available at http://flo.local:${getServerAppPort()}  (IP fallback: http://${ip}:${getServerAppPort()})`,
    );
  } catch (err) {
    console.warn('[mDNS] Could not start Bonjour:', err);
  }
}

function stopMdns(): Promise<void> {
  // Capture the instance before clearing the global reference. Bonjour invokes
  // this callback later, after unpublishAll has finished.
  const instance = bonjour;
  bonjour = null;
  if (!instance) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`Bonjour shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms`));
    }, SHUTDOWN_TIMEOUT_MS);

    const finish = (unpublishError?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        instance.destroy();
      } catch (destroyError) {
        if (unpublishError) {
          reject(new AggregateError([unpublishError, destroyError], 'Bonjour shutdown failed'));
        } else {
          reject(destroyError);
        }
        return;
      }
      if (unpublishError) reject(unpublishError);
      else resolve();
    };

    try {
      instance.unpublishAll(() => finish());
    } catch (error) {
      finish(error);
    }
  });
}

function createMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.getName(),
            submenu: [
              { label: `About ${app.getName()}`, click: () => showAbout() },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              {
                label: 'Quit',
                accelerator: 'Cmd+Q',
                click: () => {
                  isQuitting = true;
                  app.quit();
                },
              },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Order',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('new-order'),
        },
        {
          label: 'Quick Search',
          accelerator: 'CmdOrCtrl+K',
          click: () => mainWindow?.webContents.send('quick-search'),
        },
        { type: 'separator' },
        { label: 'Backup Database', click: () => mainWindow?.webContents.send('backup-database') },
        {
          label: 'Restore Backup',
          click: () => mainWindow?.webContents.send('menu-restore-from-file'),
        },
        { type: 'separator' },
        {
          label: 'Database Health Check',
          click: () => mainWindow?.webContents.send('menu-db-health-check'),
        },
        {
          label: 'Initialize Database',
          click: () => mainWindow?.webContents.send('menu-db-initialize'),
        },
        { label: 'Master PIN…', click: () => mainWindow?.webContents.send('menu-master-pin') },
        { type: 'separator' },
        {
          label: 'Exit',
          accelerator: process.platform === 'darwin' ? undefined : 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'POS',
          accelerator: 'CmdOrCtrl+1',
          click: () => mainWindow?.webContents.send('go-pos'),
        },
        {
          label: 'Dashboard',
          accelerator: 'CmdOrCtrl+2',
          click: () => mainWindow?.webContents.send('go-dashboard'),
        },
        {
          label: 'Orders',
          accelerator: 'CmdOrCtrl+3',
          click: () => mainWindow?.webContents.send('go-orders'),
        },
        {
          label: 'Kitchen Display',
          accelerator: 'CmdOrCtrl+4',
          click: () => mainWindow?.webContents.send('go-kds'),
        },
        {
          label: 'Tables',
          accelerator: 'CmdOrCtrl+5',
          click: () => mainWindow?.webContents.send('go-tables'),
        },
        {
          label: 'Catalog',
          accelerator: 'CmdOrCtrl+6',
          click: () => mainWindow?.webContents.send('go-products'),
        },
        {
          label: 'Inventory',
          accelerator: 'CmdOrCtrl+7',
          click: () => mainWindow?.webContents.send('go-inventory'),
        },
        {
          label: 'Customers',
          accelerator: 'CmdOrCtrl+8',
          click: () => mainWindow?.webContents.send('go-customers'),
        },
        {
          label: 'Staff',
          accelerator: 'CmdOrCtrl+9',
          click: () => mainWindow?.webContents.send('go-staff'),
        },
      ],
    },
    {
      label: 'Orders',
      submenu: [
        {
          label: 'View All Orders',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('view-orders'),
        },
      ],
    },
    {
      label: 'Reports',
      submenu: [
        { label: 'Daily Summary', click: () => mainWindow?.webContents.send('report-daily') },
        { label: 'Sales Report', click: () => mainWindow?.webContents.send('report-sales') },
        { label: 'X Report', click: () => mainWindow?.webContents.send('report-x') },
        { label: 'Z Report', click: () => mainWindow?.webContents.send('report-z') },
      ],
    },
    {
      label: 'Settings',
      submenu: [
        {
          label: 'Business Settings',
          click: () => mainWindow?.webContents.send('settings-business'),
        },
        { label: 'Tax Settings', click: () => mainWindow?.webContents.send('settings-tax') },
        { label: 'Printer Setup', click: () => mainWindow?.webContents.send('settings-printer') },
        {
          label: 'Kitchen Stations',
          click: () => mainWindow?.webContents.send('settings-kitchen'),
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        {
          label: 'Rest&Cafe',
          click: () => {
            if (showMainWindow()) mainWindow?.focus();
          },
        },
        { type: 'separator' },
        { role: 'minimize' },
        ...(process.platform === 'darwin'
          ? [{ role: 'zoom' as const }, { type: 'separator' as const }, { role: 'front' as const }]
          : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        ...(process.platform !== 'darwin'
          ? [{ label: 'About Rest&Cafe', click: () => showAbout() }]
          : []),
        {
          label: 'Open Logs Folder',
          click: () => shell.showItemInFolder(log.transports.file.getFile().path),
        },
      ],
    },
  ];

  if (isDev) {
    template.push({
      label: 'Developer',
      submenu: [
        {
          label: 'Toggle DevTools',
          accelerator: 'F12',
          click: () => mainWindow?.webContents.toggleDevTools(),
        },
        {
          label: 'Reload',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow?.webContents.reload(),
        },
      ],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

function showAbout(): void {
  const ip = getLocalIP();
  const kdsPort = getKdsPort();
  const serverAppPort = getServerAppPort();
  dialog.showMessageBox({
    type: 'info',
    title: 'About Rest&Cafe',
    message: 'Rest&Cafe',
    detail: [
      `Version: ${app.getVersion()}`,
      `Electron: ${process.versions.electron}`,
      `Node: ${process.versions.node}`,
      '',
      'Powerd and developed by Ali.J.',
      'ali-coding.pages.dev.',
      '',
      `POS URL: http://local:${getServerPort()}`,
      `KDS URL: http://local:${kdsPort}`,
      `Server App URL: http://local:${serverAppPort}`,
      '',
      `KDS IP fallback: http://${ip}:${kdsPort}`,
      `Server App IP fallback: http://${ip}:${serverAppPort}`,
    ].join('\n'),
  });
}

async function initialize(): Promise<void> {
  runtimeState = 'starting';
  log.info('[Lifecycle] Runtime is starting');
  try {
    if (isShutdownRequested()) return;
    console.log('[Flo] Initializing...');

    console.log('[Flo] Initializing database...');
    initDatabase();
    if (isShutdownRequested()) return;

    console.log('[Flo] Starting local server...');
    await startServer();
    if (isShutdownRequested()) return;

    // Rest&Cafe: no cloud sync, telemetry, or analytics services exist in
    // this build. Local recorders (e.g. print-failure diagnostics) keep
    // working. Manual updates only.
    localBackup.start();

    console.log('[Flo] Starting KDS server on port 3002...');
    await startKdsServer();
    if (isShutdownRequested()) return;

    console.log('[Flo] Starting Server App on port 3003...');
    await startServerApp();
    if (isShutdownRequested()) return;

    // Native E2E owns an offline fixture; optional LAN discovery must not
    // contend with a developer session or keep the test process alive.
    if (process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK !== '1') {
      console.log('[Flo] Starting mDNS advertisement...');
      startMdns();
    }

    console.log('[Flo] Initializing printer...');
    await initPrinter();
    if (isShutdownRequested()) return;

    console.log('[Flo] Registering IPC handlers...');
    registerIpcHandlers(
      shutdownSignal,
      () => mainWindow,
      showMainWindow,
      () => currentEffectiveIsDark,
    );

    // Main-window status and theme IPC. Software updates are manual (the
    // owner installs new builds by hand), so no update channels exist.
    ipcMain.handle('get-status', (event) => {
      if (!isTrustedMainWindowSender(event, () => mainWindow, getServerPort())) {
        return { error: 'Unauthorized sender' };
      }
      const mem = process.memoryUsage();
      return {
        server: isServerRunning() ? 'running' : 'stopped',
        kdsServer: isKdsServerRunning() ? 'running' : 'stopped',
        serverApp: isServerAppRunning() ? 'running' : 'stopped',
        memory: {
          heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
          heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
          rss: Math.round(mem.rss / 1024 / 1024),
        },
        uptime: process.uptime(),
        port: getServerPort(),
        titleBarMode: resolvedTitleBarMode,
        titleBarEpoch: getRendererReadinessEpoch(),
        titleBarDocumentNonce: getRendererDocumentNonce() ?? undefined,
        effectiveTheme: currentEffectiveIsDark ? 'dark' : 'light',
      };
    });

    ipcMain.handle('set-theme-effective', (event, isDark: unknown) => {
      if (!isTrustedMainWindowSender(event, () => mainWindow, getServerPort())) {
        return { success: false, error: 'Unauthorized sender' };
      }
      if (typeof isDark !== 'boolean') {
        return { success: false, error: 'isDark must be boolean' };
      }
      currentEffectiveIsDark = isDark;
      if (mainWindow && !mainWindow.isDestroyed()) {
        applyTitleBarOverlayTheme(mainWindow, isDark, process.platform);
        mainWindow.setBackgroundColor(resolveTitleBarOverlayColors(isDark).color);
      }
      return { success: true };
    });

    runtimeState = 'ready';
    relaunchAttemptGuard.markRuntimeRecovered();
    log.info('[Lifecycle] Runtime is ready');
    console.log('[Flo] Creating window...');
    createWindow();
    registerPowerMonitorRecovery();
    registerChildProcessCrashTelemetry();
    createTray();
    createMenu();
    if (process.env.FLO_E2E_SKIP_OPTIONAL_NETWORK !== '1') {
      setTimeout(() => {
        void checkTaxPackUpdatesOnStartup();
      }, 5000);
    }

    console.log('[Flo] Ready!');
  } catch (error) {
    runtimeState = 'failed';
    log.error('[Lifecycle] Runtime initialization failed:', error);
    console.error('[Flo] Initialization error:', error);
    const errorDetails = error as { code?: unknown; name?: unknown } | null;
    const expectedShutdownCancellation =
      errorDetails?.code === 'ERR_SHUTDOWN_ABORTED' ||
      errorDetails?.code === 'ABORT_ERR' ||
      errorDetails?.name === 'AbortError';
    if (!expectedShutdownCancellation) startupFailure = true;
    if (isShutdownRequested()) {
      try {
        await runCleanup();
      } catch (cleanupError) {
        console.error('[Flo] Cleanup after interrupted initialization failed:', cleanupError);
      }
      return;
    }
    dialog.showErrorBox('Initialization Error', `Failed to start Rest&Cafe: ${error}`);

    // Capture only a safe classification; exception text can contain business data.
    try {
      operationDiagnostics.captureOperationFailure({
        capture_point: 'fc.electron.startup.failure',
        outcome: 'not_applied',
      });
    } catch (diagnosticError) {
      console.error('[Flo] Failed to capture startup failure:', diagnosticError);
    }

    isQuitting = true;
    try {
      await runCleanup();
    } catch (cleanupError) {
      console.error('[Flo] Cleanup after initialization failure failed:', cleanupError);
    }
    // Cleanup has settled (or reported its bounded failure) before exiting.
    app.exit(1);
  } finally {
    if (isShutdownRequested() && runtimeState === 'starting') runtimeState = 'stopping';
  }
}

app.whenReady().then(() => {
  initializationPromise = initialize();
  void initializationPromise.then(
    () => {
      if (!activationPending) return;
      activationPending = false;
      void handleMainWindowActivation();
    },
    (error) => {
      if (!activationPending) return;
      activationPending = false;
      log.error('[Lifecycle] Startup failed while activation was pending:', error);
      if (!isQuitting && !isShutdownRequested())
        requestRuntimeRelaunchOnce('activation-startup-failed');
    },
  );
});

app.on('window-all-closed', () => {
  if (shouldQuitOnAllWindowsClosed(process.platform, failedWindowRecovery.isReplacingWindow())) {
    app.quit();
  }
});

app.on('activate', () => {
  void handleMainWindowActivation();
});

if (process.env.NODE_ENV === 'test' && process.env.FLO_E2E_PID_FILE) {
  try {
    fs.writeFileSync(process.env.FLO_E2E_PID_FILE, String(process.pid));
  } catch (error) {
    log.error('[Native E2E] Could not write Electron PID:', error);
  }
}

// --- Cleanup function (idempotent — safe to call from every entrypoint) ---
const cleanupCoordinator = createShutdownCoordinator(
  () => [
    {
      name: 'tray',
      run: () => {
        const currentTray = tray;
        tray = null;
        if (currentTray) currentTray.destroy();
      },
    },
    { name: 'raster surface', run: () => destroySharedRasterRenderer() },
    // Drain Server App before shutting down main API.
    { name: 'Server App', run: () => stopServerApp(), blocksDatabase: true },
    { name: 'Main server', run: () => stopServer(), blocksDatabase: true },
    { name: 'KDS server', run: () => stopKdsServer(), blocksDatabase: true },
    {
      name: 'operation diagnostics',
      run: () => operationDiagnostics.shutdown(),
      blocksDatabase: true,
    },
    { name: 'local backup', run: () => localBackup.stop(), blocksDatabase: true },
    { name: 'Bonjour', run: () => stopMdns() },
    { name: 'HTTP handler cleanup', run: () => waitForHttpShutdownWork(), blocksDatabase: true },
    { name: 'database admission', run: () => beginDatabaseShutdown(), blocksDatabase: true },
    { name: 'database requests', run: () => waitForDatabaseRequests(), blocksDatabase: true },
    // Close database after all in-flight handlers have finished.
    { name: 'database', run: () => closeDatabase(), databaseClose: true },
  ],
  {
    onFatalTimeout: () => {
      if (!runtimeRelaunchRequested) {
        app.exit(1);
      }
    },
  },
);

const { runCleanup, isShutdownRequested, shutdownSignal } = createShutdownEntrypoints({
  app: app as unknown as ShutdownEntrypointApp,
  process: process as unknown as ShutdownEntrypointProcess,
  cleanup: async () => {
    log.info('[Lifecycle] Cleanup started');
    console.log('[Flo] Running cleanup...');
    try {
      await cleanupCoordinator();
      log.info('[Lifecycle] Cleanup completed');
      console.log('[Flo] Goodbye!');
    } catch (error) {
      log.error('[Lifecycle] Cleanup failed:', error);
      console.error('[Flo] Cleanup failed:', error);
      throw error;
    }
  },
  setQuitting: () => {
    isQuitting = true;
    runtimeState = 'stopping';
  },
  destroyWindow: () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
  },
  reportFailure: (context, error) => {
    console.error(`[Flo] Cleanup failed before ${context}:`, error);
  },
  getSignalExitCode: () => (startupFailure ? 1 : 0),
  getQuitExitCode: () => (startupFailure ? 1 : 0),
});

process.on('uncaughtException', (error) => {
  log.error('[Flo] Uncaught exception:', error);
  console.error('[Flo] Uncaught exception:', error);
  if (!isQuitting && !isShutdownRequested()) {
    operationDiagnostics.captureOperationFailure({
      capture_point: 'fc.electron.main.uncaught',
      outcome: 'unknown',
    });
  }
});

process.on('unhandledRejection', (reason) => {
  log.error('[Flo] Unhandled rejection:', reason);
  console.error('[Flo] Unhandled rejection:', reason);
  if (!isQuitting && !isShutdownRequested()) {
    operationDiagnostics.captureOperationFailure({
      capture_point: 'fc.electron.main.unhandled_rejection',
      outcome: 'unknown',
    });
  }
});
