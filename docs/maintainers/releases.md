# Desktop releases

Rest&Cafe is distributed for **Windows x64 only**. There is no tag-driven
release pipeline and no automatic update feed.

## How a release is produced

1. Maintainer triggers the **Build Windows Installer** GitHub Actions
   workflow manually (`workflow_dispatch`).
2. The workflow builds the frontend and the Electron app, then packages an
   NSIS x64 installer with electron-builder.
3. The installer is uploaded as the `rest-cafe-windows-installer` workflow
   artifact (30-day retention) and distributed to customers manually.

## Signing status

The installer is **unsigned**. Windows SmartScreen will warn on first run
("Windows protected your PC" → More info → Run anyway) until a code-signing
certificate is adopted. Do not describe the installer as signed or trusted.

## Updates

Updates are fully manual: the customer installs a newer installer over the
existing installation. The app contains no auto-updater, no update feed,
and performs no update checks. User data lives in `%APPDATA%/RestCafe`
and is preserved across installer upgrades.
