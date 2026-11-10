From: assistant
To: ted
Kind: status
Thread: 20261110-050
Subject: Printing finalization Phase A started — audit and evidence only (baseline b05322e)

Printing finalization Phase A has started, per Ted's assignment prompt pasted
by Ali in chat on 2026-11-10 (thread 20261110-050).

Base head: b05322e7a2f2ab3aa4b8d67147b1beb12fd323c6 (upstream main, follow-up 49)
Branch: assistant/printing-finalization-a

Phase A scope (audit and evidence ONLY — no production code changes, no test
changes, no golden-file regeneration):

- Run the section 2 test list at the baseline commit (29 printing suites plus
  lint, build, build:frontend, docs:check) on a clean tree; record exact
  command, exit code, and pass/fail counts for each. test:raster runs an
  Electron renderer test; if the environment cannot run Electron it is
  reported NOT RUN with the exact error, never as passed.
- Audit the verified raster inconsistency: shared/print/thermal-capabilities.ts
  (GENERIC_THERMAL_CAPABILITIES raster disabled) vs
  main/printers/profiles.ts (both generic profiles enable raster 576/384 dots,
  modes mixed + whole-receipt) vs docs/architecture/printing.md (documents all
  four profiles as raster-enabled). Determine what actually happens today when
  a generic-profile printer receives a mixed or whole-receipt raster job
  (especially Arabic rows), whether any path blocks or degrades safely, and
  the conservative resolution options — with evidence for each. Do NOT fix it
  in Phase A. Branded profiles (Xprinter, Epson TM) are treated separately.
- Verify the already-landed print queue / retry / duplicate-prevention
  behaviour from the current code and tests (main/services/print-queue.ts,
  tests/kot-print-queue.test.ts, thread 037 deliveries 3 and 5), including
  whether any manual-reprint path can still duplicate a KOT outside the
  queue; report the stale matrix rows (C07, C08, F08, F09, F10, F11) in
  docs/production-readiness/RESTAURANT_TEST_MATRIX.md.
- Audit the remaining section 1 areas: thermal printer capabilities and
  profiles, ESC/POS 58mm/80mm Raster, Arabic rendering/shaping/RTL,
  receipt/KOT formatting (long text, modifiers, add-ons, notes), USB / TCP
  9100 / IPP / Windows paths, queue reliability, financial-document integrity
  (nothing silently omitted; a failed print never recorded as successful),
  Windows printing errors and recovery.
- Classify every audited item PASS / CONDITIONAL / UNVERIFIED per the
  hardware limitation (no physical printer available to anyone; Arabic output
  on real generic hardware, real Raster compatibility, paper cutting, cash
  drawer pulse, USB device behaviour, and real-LAN network printer behaviour
  stay UNVERIFIED unless evidence says otherwise).

Report file (agreed here, per the assignment): the Phase A deliverable is ONE
new file, docs/production-readiness/PRINTING_FINALIZATION_AUDIT.md. The
hand-back PR will contain only that report plus this start-announcement file
(standing announce rule); the file to land is the report.

After the PR opens, Phase A STOPS and waits: Phase B starts only when a
decision file from Ted appears in agent-comms/open/ (or Ali says so directly
in chat) naming the approved fix list. Heartbeat status commits at least every
30 minutes while the phase is in progress; a step blocked over 30 minutes or
failing twice gets a blocked note in agent-comms/open/ instead of silent
retries. No installer is built for this phase.
