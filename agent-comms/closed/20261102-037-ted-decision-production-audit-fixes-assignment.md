From: ted
To: assistant
Kind: decision
Thread: 20261102-037
Subject: ASSIGNMENT — Fix round for the production-readiness audit findings (six deliveries, owner-approved scope)

# Authorization and source

Owner Ali approved this fix round on 2026-11-02: fix everything from the
production-readiness audit (thread 035, reports now on upstream `main` at
`docs/production-readiness/`) that can be fixed and tested in code NOW —
nothing that depends on a Windows trial or a real printer. Under the
standing owner grant (thread 20261030-006) this decision carries his
word; it still needs his one-line confirmation in your own chat before
you start, as usual.

Baseline at assignment time: upstream `main` head `01deb0b`. Finding IDs
below are the audit's (F-001…F-033); the audit report on main is the
operative description of each defect — read the relevant section before
touching an area.

# Scope OUT — do not touch these

Owner-excluded on 2026-11-02, explicitly:

- **F-007** (off-host backup) — excluded by the owner. Do not build one.
- **F-032** (password minimum length) — excluded. Do not change the
  password policy.
- **F-023** (firewall/LAN documentation) — excluded.
- **F-024** (unsigned installer) — excluded (a purchase decision, not
  code).

Deferred by nature, not by exclusion:

- **F-002** (no real-LAN/device measurement) — needs real tablets on a
  real network; stays for the owner's device phase. Do not fabricate a
  substitute measurement.

Pending an owner decision — do NOT implement yet:

- **F-013** (KDS status progression unenforced) — the owner is being
  asked today whether progression becomes strict. His answer will land
  in this thread as a decision file. Until it does, no delivery may
  change KDS progression rules (Delivery 3 touches the KDS area; work
  around this point).

# Locked behaviours — must NOT change in this round

These are recorded owner decisions, verified again in the audit:

- Item refund includes its consumption-fee share (`main/services/refund.ts`
  behaviour stays).
- Cancelling an order with collected amounts stays allowed with manager
  PIN; its partially-paid bill stays live.
- A no-amount duplicate payment on a discount-mixed settled bill returns
  200; a duplicate on a money-paid bill returns 400.
- The two reservation contrast lines on the tables page (~2.8:1) stay.
- UI languages ar/en only; currencies SYP/USD only in pickers; the
  single-Windows-host, local-only architecture stands.
- Printed bytes: the receipt-column oracle stays byte-identical
  everywhere EXCEPT the single intended 80 mm unification in Delivery 5,
  which is called out there. No other golden regeneration, ever.

# Deliveries — one PR each, in this order

Base each delivery branch on the current upstream `main` at its start
(the previous delivery will have landed). One continuous session per
delivery, from start to its PR — the 10-minute queue check is for
discovering assignments and decisions only, never a working cadence.
Each PR: the fix commits, new/updated suites (throwing asserts, wired
into `package.json`), and one status file in this thread reporting what
was done per finding, exact commands and results, and anything not done
with the reason. Never merge; Ted verifies and lands.

## Delivery 1 — Restore the safety net (branch `assistant/auditfix-d1-test-infra`)

- **F-001**: repair `tests/e2e-server.cjs` (the deleted WhatsApp module
  require) so the Playwright harness starts; run the browser and
  electron tiers and record actual results. Fix test-side rot (stale
  selectors, harness assumptions) where the failure is clearly in the
  test. Where a failure is APPLICATION behaviour, do not fix the app in
  this delivery and do not hide the spec: inventory it in your status
  report with evidence, for a separate owner decision.
- **F-020**: the default browser run must no longer exclude
  `FINDING:`-tagged tests (run them, or move them to a named tier that
  CI runs — silently excluding them is the defect).
- **F-019**: exit code 77 in `scripts/run-test.cjs` must fail loudly
  unless the suite is a declared environment skip on a maintained list.
- **F-008 (test side only)**: make `test:cash-closures` section 15 pass
  by fixing the harness mock so the Z-print path is intercepted like the
  other print paths. Do NOT change production printing code for this;
  whether Z-print works on a real printer stays a device-phase item.
- **F-010**: CI must run the protecting suites: wire the full `npm test`
  chain (or an explicit list covering money, backup, migration, upgrade,
  startup, full-house, day-cycle, and the receipt oracle) into
  `ci.yml`. Create the Playwright CI job the coverage validator cites,
  or remove the citation — and if the browser tiers carry
  application-behaviour failures from F-001, that job lands
  non-gating with the failure inventory attached, and Ted routes the
  failures separately. Never make CI green by removing suites from it.

## Delivery 2 — The POS survives a Wi-Fi drop (branch `assistant/auditfix-d2-hung-sale`)

- **F-003**: add a request timeout to the shared API client
  (`frontend/src/lib/api.ts`), consistent with the ceiling the KDS poll
  already uses, so a half-open connection fails visibly and the existing
  failure/retry UX runs. Mutations and reads both covered; printing
  paths keep their own behaviour.
- **F-011**: persist the POS cart draft (the `pos-settings.ts` persist
  pattern) so a reload, a 401 navigation, or a crash restores the
  in-progress cart. Held orders are server-side and unchanged.
- **F-012**: retry the POS catalog load with backoff (the KDS
  enabled-check pattern) instead of one attempt and an empty grid.
- **F-014**: a persistent offline indicator in the POS (the KDS red-dot
  equivalent) driven by real request outcomes / online-offline events.
- **F-028**: surface stale postpaid attempts the way appends already
  replay on mount: an unrecovered attempt is shown to the cashier, never
  silently forgotten. Duplicate prevention stays exactly as strong.

## Delivery 3 — Kitchen tickets: never lost, never duplicated (branch `assistant/auditfix-d3-kot`)

- **F-004**: record a printed marker per KOT item (or an equivalent
  printed-at watermark) so a retry or manual reprint sends only items
  not yet printed. The append path's new-id filter stays.
- **F-009**: a durable pending-print queue with automatic retry for
  failed KOT and receipt jobs, so a failed print is retried by the
  system instead of depending on a human noticing a toast. Retry must
  respect F-004's marker (no duplicates), and printing stays post-commit
  and non-fatal to the sale.
- **F-029**: on KDS reconnect, orders that arrived during the outage and
  are still live chime once. No chime storms: one catch-up signal per
  reconnect, not per historical order.
- Do NOT touch KDS status-progression rules (F-013 is pending).

## Delivery 4 — Operable host (branch `assistant/auditfix-d4-host`)

- **F-005**: register autostart on Windows via Electron login-item
  settings, with an owner-visible settings toggle (default on; turning
  it off must be respected). Safe no-op off Windows. Actual login
  behaviour is verified on the owner's Windows machine later — say so.
- **F-006**: when a server port bumps, surface it to the operator: a
  persistent notice in the app (not console only), and the live ports
  visible where the operator pairs devices.
- **F-030**: when a tablet's stored host address is unreachable, the
  clients fall back to re-discovery (`flo.local` and the pairing host
  candidates) before declaring failure. Pairing itself is unchanged.
- **R-01** (audit risk, owner-approved to verify-and-fix): if the
  startup integrity check flagged the database, the operator must SEE
  it — a persistent warning surface for owner/manager in the app. The
  boot-with-warning design itself does not change.
- **R-02** (audit risk): attempt a WAL checkpoint on database close so
  an unexpected Windows shutdown leaves the least possible unmerged
  journal; prove it with a suite (forced-termination recovery shape).

## Delivery 5 — Print correctness (branch `assistant/auditfix-d5-print`)

Printing guardrails apply in full (read the printing guardrail notes
before starting). The oracle stays byte-identical for 58 mm and for
every profile except the single intended change below.

- **F-015**: unify 80 mm width across the two render paths on the
  backend profile width (48 columns, Font A), unless your evidence
  shows a transport where that is wrong — then say so and stop that
  item. After the change the oracle must PIN 80 mm agreement between
  the paths (it currently only asserts 58 mm). The frontend 80 mm
  golden may be regenerated for this change only, in its own commit,
  flagged in the status report.
- **F-016**: KOT lines wrap instead of truncating (item names, addons,
  notes), matching the receipt path's behaviour.
- **F-017**: a non-financial line that cannot be represented must not
  vanish with only a toast: rasterize the line where the transport
  allows it; where it truly cannot print, the warning must be recorded
  with the bill (operator-visible after the fact), not only toasted.
- **F-018**: pin the compact 80 mm double-width content to the paper
  width in the oracle (assert it fits), fixing the content if it does
  not.
- **F-026**: `bills.printed_at` is set only on confirmed dispatch, not
  on print request.
- **F-027**: with several WebUSB printers, select deterministically and
  name the selected printer in the UI; never a silent empty selection.

## Delivery 6 — Hardening, hygiene, procedures (branch `assistant/auditfix-d6-hardening`)

- **F-031**: the general API rate limiter must apply on the LAN too —
  replace the blanket private-IP skip with a generous per-IP ceiling
  that stops a retry-loop flood without ever throttling a real
  5-device restaurant. The auth, PIN, and order-write buckets are
  unchanged. Update the suites that assert the old skip.
- **F-033**: idempotency records get a retention cleanup (startup job;
  conservative window — propose 90 days in your status if you choose
  otherwise, with the reasoning). Replay inside the window is
  untouched; prove both halves with a suite.
- **F-025**: restore lint headroom to at most 900 backend warnings
  using ONLY behaviour-preserving cleanups (unused imports/vars and
  their like). If a warning cluster needs a logic change, leave it and
  report it — do not fix it here.
- **F-021**: fix the three documentation drifts the audit named
  (startup-step list, backup file naming, backup folder path, the
  `main/db.ts` description) to match current code.
- **F-022**: write the restore-onto-a-replacement-host runbook
  (maintainers docs + index row), AND prove the fresh-install restore
  path with a suite: restore a backup onto a fresh install and show
  the backup's owner account and data survive the security-state
  merge. If the merge actually drops them, that is a defect — fix the
  merge in this delivery and say so plainly.

# Battery (every delivery)

Standard: `npm run lint`, `npm run test:lint-engine`,
`npm run i18n:check`, `npm run build`, `npm run build:frontend`,
`npm run test:script-coverage`, `npm run docs:check`,
`git diff --check` — plus, per delivery area:

- D1: the e2e tiers themselves, `test:cash-closures` (full),
  script-coverage, and the CI workflow validated by reading the run
  definition (no CI run is available to you; say what you verified).
- D2: order-attempt storage, append/order idempotency suites,
  cashier-workspace, full-house, day-cycle.
- D3: printing family (printer, printer-api, bills-print-api,
  menu-printing, print-kernel, KDS suites incl. kds-integration and
  kds-live-push), full-house, day-cycle, receipt oracle.
- D4: startup family (server-port-collision, issue-278 fail-closed DB,
  smoke), backup, local-backup, migration-registry.
- D5: the full printing battery from the Stage 3 list, receipt oracle
  (byte-identical except the flagged 80 mm change), bills-print-api.
- D6: security, cors, csp-lan, staff-authz, orders-authz, backup,
  local-backup, migration-registry, upgrade-path.

Any NEW red against the audited baseline (the audit's appendix is the
baseline; the one known red entering this round is `test:cash-closures`
section 15, which D1 is expected to turn green) stops that delivery:
report it, do not land around it.

# Hard rules (all deliveries)

- Locked behaviours above are untouchable. Money math, tax behaviour,
  and settlement semantics do not change in this round.
- New user-visible strings go in `ar.json` + `en.json` only.
- New suites use the throwing assert helpers and are wired into
  `package.json` (script-coverage must pass).
- Conventional Commits; one delivery = one PR; never merge; never push
  to upstream.
- Do not edit `docs/production-readiness/*` (the audit record stands);
  the only docs edits are D6's F-021/F-022 items.
- If a finding's fix turns out to need a product decision the audit and
  this assignment do not answer, stop that item, report it in the
  status file, and continue with the rest of the delivery.
