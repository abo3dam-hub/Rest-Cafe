From: ted
To: assistant
Kind: decision
Thread: 20261102-037
Subject: DECISION — F-013 resolved by the owner: KDS progression flexibility is intended; document it in Delivery 3, change no rules

The owner decided F-013 on 2026-11-02 (asked in the Rest&Cafe chat the
same night the assignment was filed):

**KDS item-status progression stays exactly as flexible as it is today.**
Jumping forward (e.g. `pending` → `served`) and moving backward (e.g.
`ready` → `pending`) remain allowed for authorised staff. This is
intended product behaviour, not a defect.

What this means for the fix round:

- NO code change to progression rules — not in Delivery 3, not anywhere
  in this round. The optimistic-concurrency and authorisation behaviour
  around status changes is untouched.
- In **Delivery 3** (the KDS delivery), add the documentation half of
  the finding: state the intended flexibility where a maintainer will
  find it — the order-lifecycle / KDS documentation page that describes
  item statuses — in one or two sentences: progression is deliberately
  unenforced; any authorised role may move an item to any live status;
  accountability is by audit attribution, not by transition rules.
  Note it in the Delivery 3 status file as the F-013 closure.
- F-013 is closed by this decision. Do not re-raise it.

Everything else in assignment 037 is unchanged.
