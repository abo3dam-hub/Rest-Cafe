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
off by default and is restore-protected across database restore and import.

## Removed in this fork

- **Google Drive backup** — removed end to end: the service, its OAuth flow, its settings
  routes, and its settings UI are deleted. Local backup and restore are unchanged; legacy
  `google_drive_*` credential rows in existing databases are inert and are still scrubbed
  when a database is imported or reset.
- **FloAdmin cloud sync** — removed end to end: the sync service, its registration and
  pairing flows, the cloud account and email-recovery routes, the OrderFlow polling toggle,
  and the RevFlo mobile pairing endpoints are deleted, and no cloud identity is minted for
  new installs. The local diagnostics recorders that used to live inside the sync module
  (operation-failure capture, the diagnostics screen data) moved to a local-only module,
  `main/services/operation-diagnostics.ts`, and still write only to local tables. Existing
  databases keep their cloud settings rows and outbox tables as inert data.
- **Support tickets** — the ticket submission flow queued tickets for delivery to the
  vendor cloud; the routes, the settings/support forms, and the POS "get help" submission
  are removed. The diagnostics screen (local failure log and support bundle) remains.
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
