# Network surface

Rest&Cafe is local-only. This page is the inventory of what may talk to the network, what was
removed, and what still exists for local use. The principle is
[0001: offline-first core](../decisions/0001-offline-first-core.md), taken to its conclusion:
core operation never depends on a network, and the default build contacts no vendor server.

## Local network (LAN) serving

The desktop app serves the browser POS, the Kitchen Display (`:3002`), and the Server App
(`:3003`, waiter handhelds and the customer self-order page) on the local network. This is
inbound LAN traffic between the restaurant's own devices; nothing leaves the premises.

## Offline mode

The owner can switch the one optional outbound connection off with the `offline_mode` setting
(`PUT /api/settings/offline-mode`, permission `offline-mode.manage`, Settings → Privacy). It is
off by default and is restore-protected across database restore and import. While it is on,
Google Drive backups do not run and Drive operations fail with the `offline` error code.

## Google Drive backup

Backs up the local database to a folder in the merchant's own Google Drive, and restores from it.

**Enabled by** an OAuth flow the merchant completes. The redirect is served from an ephemeral
loopback listener bound to `127.0.0.1` on a kernel-assigned port, and the authorization request uses
PKCE with `code_challenge_method: 'S256'`.

**Scope rule.** `DRIVE_FILE_SCOPE` is `https://www.googleapis.com/auth/drive.file`, requesting access
only to files the app creates, alongside `openid` and `email` for identity. The scope must not be
widened: `drive.file` is what keeps a compromised token from being able to enumerate the merchant's
whole Drive. Authorization URLs are additionally checked by `isSafeGoogleAuthorizationUrl()` before
the browser is opened.

**Credential storage.** Tokens are encrypted with Electron's `safeStorage` before being written, and
decrypted on read. Backup directories, including the staging area, are created with mode `0o700`.

**Warning gate.** Before a backup runs, the merchant must acknowledge a warning, recorded under the
`google_drive_warning_acknowledged` setting. A backup attempt without that acknowledgement fails
with `warning_acknowledgement_required`.

**Revoke on disconnect.** Disconnecting revokes the grant at Google rather than only deleting the
local token.

**Offline behaviour.** Every operation fails with a `driveError` code rather than hanging. The last
error code is persisted so the settings screen can explain the failure after a restart.

## Removed in this fork

- **FloAdmin cloud sync** — never started (`cloudSync.start()` is not called) and the vendor
  endpoints are emptied in code, so there is nowhere to sync to. The module's local diagnostics
  recorders (for example print-failure capture into local tables) still run; only transmission
  is gone.
- **Anonymous telemetry** — removed end to end: the service, its startup path, and its
  settings surface are deleted, and no anonymous id is created for a new install.
- **WhatsApp receipt delivery** — removed end to end: service, routes, IPC, and UI. The dormant
  database tables remain only so migrations stay valid.
- **Automatic updates** — removed end to end: the updater library, its IPC channels, and its
  settings UI are deleted. New builds are produced from this repository (GitHub Actions,
  manual trigger) and installed by hand.
- **Country tax-pack downloads** — the remote catalog is gone; taxes are manual configuration
  only (see [product invariants](../reference/product-invariants.md)).
- **PostHog product analytics** — removed end to end: the main-process service, the renderer
  bootstrap and client library, and the product-analytics settings surface are deleted.
- **Support tickets / RevFlo pairing** — outbound support plumbing from the upstream product
  is not part of this fork's network surface.

## Verification

```sh
npm run test:url-allowlist   # the build's outbound URL allowlist is empty
npm run test:offline-mode
```
