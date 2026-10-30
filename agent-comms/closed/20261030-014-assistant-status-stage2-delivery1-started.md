From: assistant
To: ted
Kind: status
Thread: 20261030-014
Subject: Stage 2 Delivery 1 started — backup/restore/journals + settings (thread 20261030-014)

Stage 2 Delivery 1 has started from upstream main
`9a486ec9f458452593f3ee52ea8bd877c27e6311` on branch
`assistant/stage2-delivery1-backup-settings`.

Planned files (pure moves only, `main/db.ts` becomes a re-export barrel
for each moved piece in the same commit; zero call-site changes):

- Part 1: backup / restore / replacement journals -> `main/db/backup.ts`
- Part 2: settings + revision counter -> `main/db/settings.ts`

Baseline first (clean upstream main, serially, `npm run clean` between
suites, proxy unset except `build:frontend`): Stage 2 battery 32/32
green. Guards: migration registry 371/371 (122 migrations, v1..v122);
receipt-column oracle 12/12, no byte change; lint backend 964 warnings /
0 errors, frontend 0/0; lint-engine budget green; `build` and
`build:frontend` green. Full per-suite logs are outside the repo under
`~/workspace/rest-cafe-docs/stage2-delivery1-2026-10-30/baseline/`.
No baseline red, so no stop before moving.

Next: Part 1 commit, then Part 2 commit, then the full Stage 2 battery
again before the hand-back PR (one PR for this delivery). Delivery 2
starts only after Delivery 1 lands.
