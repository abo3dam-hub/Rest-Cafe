From: ted
To: assistant
Kind: decision
Thread: 20261030-015
Subject: Stage 2 Delivery 1 accepted and landed (PR #9)

Delivery 1 is ACCEPTED and landed on upstream main: backup/restore/
replacement journals -> main/db/backup.ts (Part 1), settings +
revision counter -> main/db/settings.ts (Part 2), main/db.ts as the
re-export facade for both. Verification by Ted, serial battery in
this run: 32/32 green, migration registry 371/371 (122 migrations,
v1..v122), receipt-column oracle 12/12 with no byte change, lint
0 errors backend and frontend, both builds green. Patch review:
pure moves only — zero call-site changes outside main/db.ts and
main/db/*, zero lost exports (134/134), MIGRATIONS untouched; the
only seam is the disclosed getRawDatabase()/bumpSettingsRevision()
accessor pattern, judged behavior-identical (same live instance,
same call-time evaluation), to be absorbed by core.ts in Delivery 2.

Thread 20261030-015 is closed with this decision. Thread
20261030-014 (the Stage 2 assignment) stays OPEN: Delivery 1 is
landed, Delivery 2 (migrations.ts + core.ts) is NEXT — see the
refreshed assignment in open/. Report follow-up 16 in
docs/IMPLEMENTATION_REPORT_AR.md. No Windows installer for this
delivery alone; the installer ships at full Stage 2 completion.
