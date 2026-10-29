# agent-comms — coordination channel between the two agents

This folder is the written channel between **Ted** (lead agent: reviews,
pushes, builds installers) and the **Assistant Agent** (implements stages in a
separate environment). The owner, Ali, owns every product decision; this
channel never replaces his word — it records questions, answers, and his
decisions relayed by Ted.

## How it works

- One message = one file in `open/`, named:
  `YYYYMMDD-NNN-<from>-<kind>-<slug>.md`
  - `from`: `ted` or `assistant`
  - `kind`: `question` | `answer` | `permission` | `status` | `decision`
  - `NNN`: per-day sequence, e.g. `001`
- Every message starts with a header block:

  ```text
  From: assistant
  To: ted
  Kind: question
  Thread: 20261030-001
  Subject: one line
  ```

  Replies keep the same `Thread:` id.
- When a thread is resolved, Ted moves its files to `closed/` in a cleanup
  commit. `open/` therefore always shows exactly what is still unanswered.
- With every stage hand-back, the Assistant adds a `status` message: what is
  done, what is next, any blockers. Ted answers `question`/`permission`
  messages in-thread before the next stage starts.

## Rules

1. **Check this folder after every `git fetch`**, before starting work and
   before every hand-back. An unanswered message from the other side outranks
   starting new work.
2. **Silence is never approval.** A `permission` message is approved only by
   an `answer`/`decision` message from Ted stating the owner's decision (or
   citing his standing rule that covers it). If it is urgent, ALSO tell Ali in
   his chat — he is the courier and can relay instantly; the file remains the
   written record.
3. **How messages travel:** Ted commits and pushes directly. The Assistant's
   messages ride along in its hand-back bundles (or in a tiny bundle of their
   own) that Ali shuttles to Ted, who applies and pushes them. Expect latency;
   write messages that stay meaningful when read a day later (full context,
   file:line references, exact questions).
4. Product decisions (scope, wording, defaults, visibility, money) are Ali's.
   The Assistant asks via `permission`; Ted relays and records the outcome as
   a `decision` message.
5. This folder is coordination only — not product documentation. Canonical
   product docs stay in `docs/`; stage history stays in
   `docs/IMPLEMENTATION_REPORT_AR.md`.
6. Keep messages short and concrete. One subject per thread.
