From: ted
To: assistant
Kind: decision
Thread: 20261030-018
Subject: Current assignment — Stage 3: printing area (classify, oracle-gated formatAmount, slim thermal.ts) (live queue item)

TED GATE UPDATE 2026-10-30 — DELIVERY 3 COMPLETE, DELIVERY 4 NEXT
(read first; the assignment text below stays operative except where
this update overrides the order):
- Delivery 3 ACCEPTED and landed (PR #15, pure moves only).
  thermal.ts 3,586 -> 2,092 lines: seam 4 printer-detection.ts,
  seam 5 document-z-report.ts, seam 6 raster-documents.ts,
  thermal.ts keeps re-exports. Gatekeeper battery 30/30 effective
  (raster plain = declared env skip, green under xvfb); oracle
  12/12 byte-identical, registry 371/371, no new red. Decision
  file 20261030-025. Delivery 3 is COMPLETE. The disclosed
  thermal.ts <-> new-module import cycles are accepted ONLY as
  call-time use; a load-time use in a later seam stops that seam
  and is reported.
- QUEUE ORDER FROM HERE: NEXT = Delivery 4 (branch
  assistant/stage3-delivery4-thermal-slim-3; approved seams 7-8:
  document-plugin-receipt, receipt-entry; one commit per seam,
  pure moves only). THEN Stage 3 completes. No owner wait at any
  gate.

TED GATE UPDATE 2026-10-30 — DELIVERY 2 COMPLETE, DELIVERY 3 NEXT
(read first; the assignment text below stays operative except where
this update overrides the order):
- Delivery 2 ACCEPTED and landed (PR #14, pure moves only).
  thermal.ts 4,227 -> 3,586 lines: seam 1 escpos-preview.ts,
  seam 2 windows-print.ts, seam 3 print-transport.ts, thermal.ts
  keeps re-exports. Gatekeeper battery 30/30 effective (raster
  plain = declared env skip, green under xvfb); oracle 12/12
  byte-identical, registry 371/371, no new red. Decision file
  20261030-024. Delivery 2 is COMPLETE. The disclosed
  thermal.ts <-> windows-print.ts import cycle is accepted
  ONLY as call-time use; a load-time use in a later seam stops
  that seam and is reported.
- QUEUE ORDER FROM HERE: NEXT = Delivery 3 (branch
  assistant/stage3-delivery3-thermal-slim-2; approved seams 4-6:
  printer-detection, document-z-report, raster-documents; one
  commit per seam, pure moves only). THEN Delivery 4 = seams
  7-8. No owner wait at any gate.

TED GATE UPDATE 2026-10-30 — DELIVERY 1 COMPLETE, DELIVERY 2 NEXT
(read first; the assignment text below stays operative except where
this update overrides the order):
- Delivery 1 Part B ACCEPTED and landed (PR #13, comms-only, zero
  production files, no golden regenerated). Verdict: ZERO of the
  five formatAmount variants unify safely — V2 vs V3 proven
  different on the default SYP path, V4's trimDecimals branch
  load-bearing, V1 moves with seam 5, V5 already a pure delegate.
  Gatekeeper spot-check on clean main matched exactly: oracle
  12/12, bills-print-api 34/34, migration registry 371/371.
  Decision file 20261030-023. Delivery 1 is COMPLETE.
- The V3 quirk flag (tax bill digits from the display prefix) is
  NOTED, not decided, not fixed here; it blocks nothing.
- QUEUE ORDER FROM HERE: NEXT = Delivery 2 (branch
  assistant/stage3-delivery2-thermal-slim-1; approved seams 1-3:
  escpos-preview, windows-print, print-transport; one commit per
  seam, pure moves only). THEN Delivery 3 = seams 4-6, Delivery 4 =
  seams 7-8. No owner wait at any gate.

TED GATE UPDATE 2026-10-30 — MENU-PRINTING REPAIR LANDED, PART B NEXT
(read first; the assignment text below stays operative except where
this update overrides the order):
- Repair LANDED (PR #12): test:menu-printing is 10/10 again; oracle
  12/12 byte-identical, bills-print-api 34/34, migration registry
  371/371, lint 0 errors, backend build green. Thread 20261030-020
  closed with decision file 20261030-022. The stop rule is lifted.
- QUEUE ORDER FROM HERE: NEXT = Delivery 1 Part B (branch
  assistant/stage3-delivery1-partb-formatamount; oracle-gated
  formatAmount unification, Part B rules below unchanged). THEN
  Delivery 2 = seams 1-3, Delivery 3 = seams 4-6, Delivery 4 =
  seams 7-8. No owner wait at any gate.

TED GATE UPDATE 2026-10-30 — PART A LANDED, QUEUE REFRESHED (read first;
the assignment text below stays operative except where this update
overrides the order):
- Delivery 1 Part A ACCEPTED and landed (PR #11; upstream head
  c132e40). Baseline recorded: Stage 3 battery 28/30 on clean main
  542ec99 — raster is a declared environment skip off-Windows;
  test:menu-printing is a real 9/10 red (stubbing break at
  tests/menu-printing.test.ts:458, caused by the Stage 2 barrel's
  getter-only re-export) and is an OPEN REPAIR ITEM, not a baseline.
- Seam approval (decision file 20261030-019, same thread): all eight
  proposed seams APPROVED in order (1 escpos-preview, 2 windows-print,
  3 print-transport, 4 printer-detection, 5 document-z-report,
  6 raster-documents, 7 document-plugin-receipt, 8 receipt-entry),
  pure-move rules only; any seam that cannot move purely is excluded
  and reported, never improvised.
- QUEUE ORDER FROM HERE: NEXT = menu-printing repair PR (branch
  assistant/stage3-repair-menu-printing-stub; test-only edit of
  tests/menu-printing.test.ts; ZERO production files; same 10 tests,
  same assertions; barrel unchanged; landing needs 10/10 plus oracle,
  bills-print-api and migration-registry green). THEN Part B (branch
  assistant/stage3-delivery1-partb-formatamount). THEN Delivery 2 =
  seams 1-3, Delivery 3 = seams 4-6, Delivery 4 = seams 7-8 (owner
  decision 2026-10-30, decision file 20261030-021: THREE seams per
  delivery, superseding the two-seam bundling). No owner wait at
  any gate; no Part B or seam move is authored before the repair lands.
  Gatekeeping note: if one seam in a delivery fails verification,
  Ted bisects by commit, lands the verified seams in order, and
  returns only the faulty seam — the one-commit-per-seam rule is
  what makes this possible and is mandatory.

OWNER PRE-AUTHORIZATION (recorded by Ted): on 2026-10-30 ~05:39
Damascus, Ali said, verbatim in substance: "when Stage 3's turn
comes, execute — do not wait for my approval; I want confirmation
that nothing stops on the grounds of needing my approval." This
assignment is therefore UNLOCKED from the moment Stage 2 completes
(Stage 2 completion = thread 20261030-014 closed on upstream main).
Do NOT wait for any further go-ahead — not from Ali, not from Ted
beyond the gatekeeping landings themselves. Under the standing
owner grant (closed/20261030-006), Ted's decisions in this thread
are the operative approvals for everything inside this assignment's
scope. The only things that still stop work are this assignment's
own stop conditions (unexplained reds, oracle byte diffs, behavior
changes) — those are safety stops, not approval waits, and they are
reported, never silently pushed through.

Stage 1 (POS split) and Stage 2 (db.ts facade) are complete when
this unlocks. Read SKILL-printing-guardrails.md and
SKILL-refactor-protocol.md again before starting — printing is the
highest-risk area in this codebase: output is bytes on paper, the
receipt-column oracle is the contract, and physical-printer
verification on the owner's machine remains outstanding for every
printing stage (say so in every report; never claim it).

Goal: leave the printing area understood, pinned, and structurally
slim WITHOUT changing a single printed byte. thermal.ts is 4,227
lines; main/printers/ already has a document-* family (classic,
compact, kot, menu, delivery-slip, merchant) plus
formatting-helpers.ts, profiles.ts, raster-*.ts, ipp-client.ts.
shared/print/ and frontend/src/lib/printer/ are in classification
scope; restructuring scope is main/printers/ (thermal.ts) unless
Ted's seam approval below says otherwise.

Deliveries in order (owner bundling rule, updated 2026-10-30:
Delivery 2+ bundles THREE seams per delivery, one commit per seam;
the final delivery takes the remainder):

DELIVERY 1 — branch assistant/stage3-delivery1-classify-format
  Part A — CLASSIFY, do not restructure. Zero production-code
    changes. Deliverable is the status report on this thread with:
    (1) the Stage 3 battery (below) baseline table run on clean
    upstream main (post-Stage-2 head), every suite green / red /
    declared-skip with its reason — anything red that is not the
    documented environment family (e2e browser, e2e:server) is a
    stop-and-report before any move;
    (2) a section map of thermal.ts: each coherent section with
    line ranges, its exports, and its callers;
    (3) the five formatAmount variants inventoried: location,
    exact semantics (fraction-digit source, cents conversion,
    Toman/special cases), and callers — evidence, not impressions;
    (4) an ordered Stage C seam proposal: for each seam — source
    section, target module under main/printers/ (extend the
    document-* pattern or a named sibling module), estimated
    lines, why it is cohesive, and which suites protect it.
  Part B — formatAmount, variant by variant, under the oracle.
    A variant may be unified ONLY where its semantics are proven
    identical to the target implementation AND the
    receipt-column oracle stays byte-identical AND the printing
    battery shows no new red vs the Part A baseline. Each unified
    variant is its own commit. A variant that genuinely differs
    STAYS as-is, documented with the evidence — that is a
    successful outcome for that variant, not a failure (the
    earlier Graphify round stopped a forced unification for
    exactly this reason; do not force it). Regenerating any
    golden is FORBIDDEN in this stage. If zero variants unify
    safely, Part B is the evidence report alone and is complete.
  Ted's gate on Delivery 1: on landing, Ted reviews the seam
  proposal and issues the Stage C approval decision in this
  thread (pure-move seams only) and refreshes this assignment
  with the approved list — Delivery 2 unlocks in the same
  landing series. No owner wait at this gate.

DELIVERY 2 — branch assistant/stage3-delivery2-thermal-slim-1
  (starts only after Delivery 1 lands and the seam approval is on
  main) Approved seams 1, 2 and 3: extract each into its target
  module under main/printers/; thermal.ts keeps re-exports /
  composition so existing call sites do not change. One commit
  per seam; every commit compiles and passes on its own.

DELIVERY 3 — branch assistant/stage3-delivery3-thermal-slim-2
  Approved seams 4, 5 and 6, same rules.

DELIVERY 4 — branch assistant/stage3-delivery4-thermal-slim-3
  Approved seams 7 and 8 (the remainder), same rules. If seams
  remain after Delivery 4, Ted refreshes this assignment for
  further three-seam deliveries until the list is exhausted.

Stage 3 is complete when: the approved seam list is exhausted,
thermal.ts is reduced to the core ESC/POS builder + orchestration
(or the remainder is documented as cohesive core in the final
report), the battery is green with the oracle byte-identical at
every step, and Ted has built the Windows installer and closed
this thread with the completion report.

Announce every delivery start: the FIRST action on a delivery is
to push its branch carrying one status message in open/ on this
thread (From: assistant, Kind: status) naming the delivery, its
base head, and the planned files. Then work the delivery on that
branch; the hand-back is one PR per delivery.

Stage 3 battery (baseline in Part A; re-run before every
hand-back; Ted re-runs it at landing):
npm run lint, npm run test:lint-engine, npm run i18n:check,
npm run build, npm run build:frontend,
npm run test:receipt-column-oracle, npm run test:bills-print-api,
npm run test:printer, npm run test:printing-settings,
npm run test:printer-api, npm run test:print-menu-printer-selection,
npm run test:printer-ipc, npm run test:receipt-printing,
npm run test:receipt-settings-hydration, npm run test:print-parity,
npm run test:merchant-print-templates, npm run test:print-document,
npm run test:print-kernel, npm run test:thermal-capabilities,
npm run test:raster, npm run test:receipt-column-width,
npm run test:printer-width-refresh, npm run test:printer-migrations,
npm run test:issue-printing-and-kds-resilience,
npm run test:issue-266-currency-symbol-print,
npm run test:menu-printing, npm run test:print-labels,
npm run test:migration-registry, npm run test:backup,
npm run test:e2e-syria-default.
Required at landing: no NEW red vs the Part A baseline, oracle
byte-identical, bills-print-api green, migration registry exactly
371/371. Declared environment skips (raster off-Windows) must be
reported as skips, never as coverage.

Hard rules, every delivery:
- Pure moves only in refactor commits. No logic edits, no renamed
  exports, no signature changes, no call-site changes outside
  main/printers/ + thermal.ts's own re-exports (a seam that seems
  to need one is a stop-and-report, not an improvisation).
- The Arabic shaping fail-closed gate is designed behavior: never
  weaken it to make a preview or a suite pass. In tests, declare
  arabicShaping: true or seed a printer.
- Stored currency symbol wins on printed bills; dates on receipts
  are numeric DD/MM/YYYY in every language.
- Test additions allowed only as a separate first commit of a
  delivery, only as new files, only if they also pass on the
  unmoved code.
- OUT of this stage's scope (report-only; the owner decides
  later): the no-printer Arabic preview polish (making the
  synthetic fallback profile Arabic-capable), any golden
  regeneration, any behavior change anywhere, restructuring
  frontend/src/lib/printer/ or shared/print/ beyond what an
  approved seam strictly requires.

Stop conditions, every delivery: first unexplained red, any
receipt-oracle byte diff, any migration-registry count other
than 371/371, any need for a product decision (wording, defaults,
visibility, money) — stop and report in a comms PR instead of
pushing through. Ted answers from recorded decisions where they
exist; genuinely new product decisions are the only thing that
waits for the owner, and nothing in this assignment's scope
should need one.

If this file ever seems missing while Stage 3 deliveries remain
unlanded, say so in a comms PR — the queue is Ted's to keep filled.
