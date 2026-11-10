From: assistant
To: ted
Kind: status
Thread: 20261110-050
Subject: Printing finalization Phase C started — docs + matrix + closure recommendation (base 3a5230f)

Printing finalization Phase C has started, per Ted's decision
20261110-060 (thread 20261110-050), which opens Phase C after Phase B
completed (B1–B4 landed; B4 accepted by decision 20261110-059, thread
20261110-058 closed; Windows installer run 42852333841 dispatched by
Ted after B4).

Base head: 3a5230f0d8fda27c70ae1a637f319123246ed48c (upstream main, B4 landed + follow-up 54 + decisions 059/060)
Branch: assistant/printing-finalization-c

Phase C scope (docs + matrix only — decision 060):

- PF-06/07/08 — correct the stale matrix rows C07, C08, F08, F09, F10,
  F11 plus C06, F06, P07 in the live matrix
  `docs/production-readiness/RESTAURANT_TEST_MATRIX.md` and any canonical
  docs passage repeating the stale claim, each verified against current
  code/tests on main at this base with file:line evidence.
- The two Phase A corrections from decision 051: (a) §3.1 branded
  profile names — `xprinter-xp-v320m-v330m` (XP-V320M/V330M) and
  `epson-tm-series` (TM Series); (b) §7 E04 registry counts — taken
  current at Phase C landing time.
- PF-05 (crash-window KOT duplicates) — recorded as accepted residual
  risk in the docs, no code change.
- Closure recommendation — one written verdict recommending whether the
  printing system is SOFTWARE-CLOSED, with the evidence (PF-01–PF-04
  fixed + verified, PF-05 residual, PF-06/07/08 corrected here) and the
  honest remaining limits (physical-printer verification on the owner's
  machine still outstanding). Flint RECOMMENDS; Ted decides — no
  self-declaration of SOFTWARE-CLOSED.

Rules for this phase: one PR, docs only — no production, test, or golden
files. The Phase A report file
`docs/production-readiness/PRINTING_FINALIZATION_AUDIT.md` is FROZEN and
is not amended. If a correction needs a code change, stop and ask
in-thread. Heartbeat at least every 30 minutes while in progress;
blocked over 30 minutes or the same step failing twice gets a blocked
note in agent-comms/open/. After the PR opens, Phase C STOPS and waits
for Ted's decision. No installer for Phase C.
