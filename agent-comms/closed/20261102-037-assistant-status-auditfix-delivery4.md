From: assistant
To: ted
Kind: status
Thread: 20261102-037
Subject: Audit-fix Delivery 4 done — operable host (F-005, F-006, F-030, R-01, R-02)

Delivery 4 of assignment 037 is done, per decision 041.

Base head: b5b3b873308d771748062a5c8dd86964f3d0c308 (upstream main, Delivery 3 landed)
Branch: assistant/auditfix-d4-host

## What was done, per finding

### F-005 — Autostart on Windows
- New `main/services/autostart.ts`: `isAutostartEnabled()` (ships on — an
  absent setting means enabled) and `applyAutostartSetting()`, which calls
  `app.setLoginItemSettings({ openAtLogin, path: process.execPath })` on
  Windows only and is a safe no-op everywhere else. It never throws: a
  missing or failing login-item API is reported as not applied.
- Applied at startup in `main/index.ts:1163`, right after `initDatabase()`
  (settings are readable from there), and immediately on save in
  `main/routes/settings.ts:1496-1497`: the route passes the freshly saved
  value, so turning the toggle off is respected in the same run instead of
  waiting on the settings cache or a restart.
- `autostart_enabled` is a validated boolean wildcard key
  (`main/routes/settings.ts:1408`, allow-listed with the other booleans).
- Owner-visible toggle in Settings → Store tab, next to the store settings
  (`frontend/src/app/(dashboard)/settings/page.tsx:1443,2522,3012`):
  a card with the shared `Toggle`, saved immediately, gated on
  `settings.manage`. Strings in `ar.json` + `en.json` only
  (`autostartEnabled`, `autostartHint`, `autostartOn`, `autostartOff`).
- Caveat, as the assignment requires saying: actual login behaviour is
  verified on the owner's Windows machine later. This delivery pins the
  registration call (suite below); no Windows host was available here.

### F-006 — A port bump is surfaced to the operator
- Each server records its bump where it already retries the next port:
  `main/server.ts:413` (API), `main/kds-server.ts:892` (KDS),
  `main/server-app.ts:729` (Server App). Records live in
  `main/server-state.ts:37,57,62` (`recordPortBump`, `getPortBumps`,
  `getLatestPortBump`) — service, requested port, actual port, reason,
  timestamp, in memory for the run.
- New `GET /api/server-ports` (`main/routes/server-ports.ts`, registered in
  `main/routes/index.ts`): per service `{ requested_port, port,
  port_bumped, last_bump }`, via the exported pure `buildServerPortsStatus()`.
- Persistent notice in the app, not console only: `GlobalNotifications`
  (`frontend/src/components/layout/GlobalNotifications.tsx`) polls
  `/api/server-ports` every 30 s and shows a non-dismissible amber banner
  ("Server port moved: …") with a link to Settings while any service is
  bumped. Because that component is hidden on the POS/KDS pages, the same
  state also shows as a compact "Port moved" chip in the `StatusBar`
  (`frontend/src/components/layout/StatusBar.tsx`), which is visible on
  every page including the POS.
- Live ports where the operator pairs devices: the three pairing-info
  routes now return `port`, `requested_port`, `port_bumped`
  (`main/routes/pos-info.ts`, `kds-info.ts`, `server-app-info.ts`), and
  each pairing card in Settings renders them via `PairingPortNotice`
  (`frontend/src/app/(dashboard)/settings/page.tsx:220,3250,3787,4036` —
  POS, KDS, Server App): always the live port, plus an amber
  "Port moved from X to Y" line when it moved.
- Bump behaviour itself is unchanged: same 10-attempt retry, same logging.

### F-030 — Tablets fall back to re-discovery
- New `frontend/src/lib/host-rediscovery.ts`: `buildRediscoveryCandidates`
  (flo.local on the same port first, then cached pairing hosts),
  `probeHostOrigin` (any HTTP answer — even a 503 — proves the host is
  there), `attemptHostRediscovery` (first reachable candidate wins),
  `attemptHostRediscoveryOnce` (single-flight, at most 3 redirects per
  session so a genuinely down host cannot ping-pong the browser).
- Wired into the shared API client (`frontend/src/lib/api.ts:158`): when a
  request fails with no response at all, re-discovery runs before the
  failure is declared; on success the tablet navigates to the found host
  on the same page. Loopback origins never rediscover (the server is down,
  not moved). Pairing itself is unchanged.
- Candidates are cached from the pairing-info fetches
  (`frontend/src/app/(dashboard)/settings/page.tsx:879,909,936` and
  `frontend/src/components/settings/CustomerDisplayCard.tsx`), so a tablet
  that was once paired can try those hosts again.
- Limitation, stated plainly: re-discovery only runs in a page that is
  already loaded (or served from cache). A tablet whose bookmarked URL
  cannot load any page at all — because the host IP changed and nothing
  is cached — still needs the flo.local address or a re-pair. The
  flo.local candidate is the mitigation for exactly that case.

### R-01 — The operator SEES a flagged database
- The boot-with-warning design is unchanged (`main/db/core.ts`
  `runStartupIntegrityCheck` still never throws; `/api/health` still
  returns 503 with the flag).
- New persistent surface: `GlobalNotifications` polls `/api/health` and,
  when the integrity check flagged the database, shows a non-dismissible
  red banner ("The database integrity check flagged a problem…") with a
  link to Settings — visible to owner/manager roles only
  (`currentTenant.role === 'owner' | 'manager`). Cashiers and waiters do
  not see it; the banner stays until the flag clears (no dismiss button,
  by design — hiding a corrupt-database warning is not an available
  outcome).

### R-02 — WAL checkpoint on database close
- `main/db/core.ts:915`: `closeDatabase()` now attempts
  `PRAGMA wal_checkpoint(TRUNCATE)` before `db.close()`, best effort —
  a checkpoint that cannot run (read-only handle, open transaction)
  is logged and never prevents the close. Every close path benefits,
  including the shutdown coordinator's database step.
- Proved with `tests/wal-checkpoint.test.ts` (forced-termination recovery
  shape, see Battery): clean close leaves the `-wal` file empty/absent
  with the rows intact, and a SIGKILLed child that never closed still
  leaves its committed row recoverable from the WAL on reopen.

### Not done
- F-026 (`bills.printed_at`): NOT touched. Per decision 041 it belongs to
  Delivery 5, not Delivery 4. No print-correctness item was touched.
- No docs edits: the assignment reserves docs changes for Delivery 6
  (F-021/F-022). `docs/production-readiness/*` untouched.

## Battery — 19/19 green, local, serial, `npm run clean` between suites

Logs: `~/workspace/rest-cafe-docs/auditfix-d4-2026-11-02/` (one log per
suite, plus `run-battery.sh`).

Standard (8): `lint`, `test:lint-engine`, `i18n:check`, `build`,
`build:frontend` (proxy on, as required), `test:script-coverage`,
`docs:check`, `git diff --check` — all exit 0.

D4 area (6): `test:server-port-collision`, `test:issue-278-fail-closed-db`,
`test:smoke`, `test:backup`, `test:local-backup`,
`test:migration-registry` (374/374, 123 migrations v1..v123) — all exit 0.

New suites (4), all wired into `package.json` and the `test` chain, and
added to the CI protecting list (D1 precedent):
- `test:host-rediscovery` — 21/21
- `test:autostart` — 23/23
- `test:server-ports` — 32/32
- `test:wal-checkpoint` — 8/8

Extra (1): `test:receipt-column-oracle` — green, no byte change.

## Disclosures
- The intermittent EPERM write fault did NOT return during this delivery.
  Local git writes, fetches, and the full battery all worked.
- Lint: backend 966 warnings / 0 errors — identical to the base
  `b5b3b87` (verified by running backend lint on a clean base worktree),
  so Delivery 4 added zero new backend warnings; budget is 1000.
  Frontend 1 warning / 0 errors — a pre-existing `exhaustive-deps`
  warning in `TaxConfigurationPanel.tsx`, a file this delivery did not
  touch (byte-identical to base).
- The settings route applies autostart with the freshly saved value
  (see F-005): the route-level call is pinned by the autostart service
  suite plus lint/tsc/build, not by a route-level test — standing up
  Express auth for one call was disproportionate. The React wiring for
  the banners, chip, toggle, and re-discovery hook is covered by lint,
  tsc, and `build:frontend`, per the D2 precedent.
- Formatter normalization (disclosure): the repo's pre-commit hook
  reformatted three small files wholesale when they were staged —
  `main/routes/pos-info.ts`, `main/routes/kds-info.ts`, and
  `main/routes/server-app-info.ts` (indentation/line-wrapping only, e.g.
  `router.get('/', …)` split across lines, aligned `=` un-aligned).
  No logic changed in those hunks; the only behavioural changes in the
  three files are the added `port` / `requested_port` / `port_bumped`
  response fields. The battery above ran on the formatted tree.
- Money math, tax, settlement, and refund semantics unchanged. No
  production-readiness docs edited. No installer for this delivery.

## What is next
Delivery 5 — print correctness (F-015, F-016, F-017, F-018, F-026, F-027),
on branch `assistant/auditfix-d5-print` once this delivery lands.
