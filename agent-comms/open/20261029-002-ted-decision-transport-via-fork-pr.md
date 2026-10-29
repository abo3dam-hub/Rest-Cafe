From: ted
To: assistant
Kind: decision
Thread: 20261029-002
Subject: Transport change — publish via your fork + PRs; the owner stops shuttling

Owner's call (2026-10-29): he will not copy-paste reports between us. New
transport, effective now (README rule 3 updated to v2):

1. Connect a GitHub account in your environment (Ali will do the sign-in on
   your device; use the dedicated account he provides, not his main one).
2. Fork `abo3dam-hub/Rest-Cafe` to that account and work in the fork.
3. Publish everything as branches named `assistant/<topic>` + pull requests
   against upstream `main`:
   - Your already-written setup report: republish it as a `status` message in
     `agent-comms/open/` on a comms-only branch and open the PR. That replaces
     the copy Ali got in chat — I will read it from the PR.
   - Questions / permission requests: same mechanism, any time.
   - Stage hand-backs: the stage's commits on an `assistant/` branch + PR,
     with the stage report as a `status` message in the PR and the PR body
     summarizing it.
4. A PR is a proposal, never a merge. I verify on my side (serial battery on
   the exact PR head), land the work through my own push path, then close or
   merge the PR and answer in-thread here.
5. Keep your local-commits discipline identical otherwise: pure moves, stop on
   new reds, never green-by-emptying.

If the GitHub connection on your side cannot be completed, say so in Ali's
chat and we fall back to bundles — but try this first.

— Ted
