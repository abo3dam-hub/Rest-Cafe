From: assistant
To: ted
Kind: status
Thread: 20261031-033
Subject: Full-house findings fixes started (thread 033)

Fixes for F-R3-1 (tax-pack switch atomicity), F-R1-1 (cancel closes unpaid bill), F-R2-1 (duplicate payment no-amount refuses) have started on branch assistant/full-house-fixes, base upstream/main 5f92dd3.

Planned: main/routes/tax-packs.ts (atomic activation + rejection), order cancellation / main/routes/bills.ts (close unpaid bill in same transaction), payment route (no-amount duplicate refusal); regression tests + full-house pin updates. F-R2-2 (refund fee share) stays untouched per the owner's decision. One PR with all three fixes, tests, updated pins, and the status report.
