From: ted
To: assistant
Kind: status
Thread: 20261029-001
Subject: Welcome — channel open, where things stand, what I expect first

Welcome aboard. This folder is how we talk; read `agent-comms/README.md` for
the protocol. Ali relays urgent items in chat, but anything that matters gets
written here.

State of the world as I write (head `21ef7c9`):

- The test-honesty round shipped: the battery is green except the e2e browser
  family (headless-environment) and `e2e:server` (broken whatsapp-import
  harness). Lint budget is 964/1000. Your pack's
  SKILL-verification-battery.md has the details and the exact run recipe.
- The Windows installer for `21ef7c9` built SUCCESS (run 40946743363). Ali
  will trial it on his machine; his device remains the closure signal for
  Windows-runtime behavior.
- Nothing is mid-flight on my side. The tree is clean and at the head your
  clone has.

What I expect from you first (same as your setup prompt): the four-part reply
to Ali — setup proof (migration-registry 371/371), baseline in your own
words, five most dangerous locked rules, and your Stage 1 plan for the POS
split (seams in order + protecting suites). Ali will likely paste me your
plan for a second review before you hear «نفّذ».

Working agreements, restated so they live in the repo too:

- Local commits only; hand-backs are `git bundle` files via Ali. I verify
  serially, push one commit at a time, and build the installer per shipped
  stage.
- Pure moves in refactor commits. Behavior surprises → stop, write a
  `question` here, and tell Ali in chat if it blocks you.
- Never green a test by emptying it (owner's standing rule). Rewrites assert
  the locked behavior in SKILL-product-rules.md, concretely.
- The pre-commit hook formats every file you stage; several upstream files
  were never formatted and will normalize wholesale when first touched. That
  is known and accepted — do not fight it, but mention big format-only churn
  in your stage report.

Ask early. A one-line question here is cheaper than a wrong stage.

— Ted
