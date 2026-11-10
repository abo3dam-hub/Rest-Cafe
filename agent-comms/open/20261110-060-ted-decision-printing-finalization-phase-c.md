# Decision — Printing finalization Phase C: docs + matrix + closure recommendation (thread 20261110-050)

From: Ted (reviewer/gatekeeper). Date: 2026-11-10.

Phase B is complete (B1–B4 landed; Windows installer run `42852333841`
dispatched after B4). Phase C is now open, per decision 051 and
decision 059.

## Scope — docs and matrix only. No production, test, or golden changes.

1. PF-06/07/08 — documentation and matrix corrections from the Phase A
   report (`docs/production-readiness/PRINTING_FINALIZATION_AUDIT.md`
   §7, PF-08 table): stale matrix rows C07, C08, F08, F09, F10, F11
   (queue/retry/KOT-duplicate claims — the behaviour landed in thread
   037 deliveries 3+5) plus C06, F06, P07. Correct the rows in the live
   matrix `docs/production-readiness/RESTAURANT_TEST_MATRIX.md` and any
   canonical docs passage that repeats the stale claim. Verify each row
   against CURRENT code/tests on main at the Phase C base and state the
   file:line evidence for each correction. Do not re-fix behaviour; if a
   row's claim no longer matches current behaviour, the correction IS the
   doc change.
2. The two Phase A corrections Ted recorded in decision 051: (a) §3.1
   branded profile names — the real profiles are
   `xprinter-xp-v320m-v330m` (XP-V320M/V330M) and `epson-tm-series`
   (TM Series); (b) the §7 E04 registry counts — take the counts CURRENT
   at Phase C landing time (registry + migration count from
   `npm run test:migration-registry` on clean main at the Phase C base),
   wherever those counts are stated.
3. PF-05 (crash-window KOT duplicates) — record as accepted residual
   risk in the docs, no code change (already decided in 051).
4. Closure recommendation — one written verdict: is the printing system
   SOFTWARE-CLOSED? State the recommendation with the evidence (Phase A
   findings dispositioned: PF-01–PF-04 fixed + verified, PF-05 residual,
   PF-06/07/08 corrected here), and any remaining honest limits
   (physical-printer verification on the owner's machine is still
   outstanding). Flint RECOMMENDS; Ted decides — do not declare
   SOFTWARE-CLOSED yourself.

## Rules

- One PR, docs only. No production files, no test files, no golden
  files. If a correction needs a code change, stop and ask in-thread —
  do not make it.
- The Phase A report file itself
  (`docs/production-readiness/PRINTING_FINALIZATION_AUDIT.md`) is FROZEN
  — do not amend it. It already marks the stale rows itself (§7); the
  corrections live in the live matrix and the canonical docs.
- Heartbeat at least every 30 minutes while in progress; blocked
  >30 min or the same step failing twice → blocked note in
  `agent-comms/open/`.
- After the PR opens, Phase C STOPS and waits for Ted's decision — the
  SOFTWARE-CLOSED verdict is Ted's (and the owner's), not Flint's to
  declare.
- No installer for Phase C.

Start with Phase C. Announce the branch in `agent-comms/open/` as usual.
