# Planned Work

The open work register for Folia. This file is the **durable** copy: the working
tracker lives in an agent session database that does not survive the session, so
anything only recorded there is lost the moment the session ends. If a **tracked
item** is not written down here, assume it does not exist.

That qualifier is deliberate. This register covers the *tracker's* open items. A
small amount of open work is recorded only in the audit documents and has never
been given a tracker ID — see *Open work tracked elsewhere* at the end. Those are
not omissions to be silently absorbed; they are listed so the boundary of this
file is visible.

It is deliberately a *register*, not a dump of the tracker. Each entry states
what the work is, why it is open, what proves it done, and what it waits on.

> **Discoverability — resolved 2026-09-02.** Two entry points now lead here, so a
> session that has lost its tracker can still find this file by following the
> repository's own documented starting points:
>
> - **`.github/copilot-instructions.md`** lists `docs/PLANNED-WORK.md` first among
>   the load-bearing documents and carries the rule *"Read `docs/PLANNED-WORK.md`
>   before selecting or starting any work"*, together with the single-writer and
>   update-at-every-transition protocol, and a summary of the mandatory
>   model-role assignment recorded below.
> - **`README.md`**'s *Planned next* now links here as the authoritative live
>   roadmap instead of restating a subset of it. It deliberately does not repeat
>   the inventory — a second copy would be stale within a wave.
>
> Keep both pointers alive. If this file is ever renamed or moved, those two
> references are what must be updated in the same commit; leaving them dangling
> reproduces, one level up, exactly the loss this register exists to prevent.

**Scope.** Everything below is work that has not landed on `main`. Finished work
is documented where it belongs — `docs/SECURITY-AUDIT.md`, `docs/PERF-AUDIT.md`,
`bench/BASELINE.md`, `docs/CUSTOMIZATIONS.md` — and only a short recent-history
section is kept here so the register has a visible edge.

## Update protocol

Read this before editing the file; the value of the register is entirely in it
being current and stable.

1. **Update this file whenever an item starts, finishes, or splits.** Not at the
   end of a wave, not "when things settle" — at the transition. An item that
   changed state in the tracker but not here has already begun rotting.
2. **IDs are stable and are never reused.** `w2-sec08` means the same thing
   forever. If an item is dropped, mark it `DROPPED` with a one-line reason
   rather than deleting the row; a silently vanished ID is indistinguishable
   from a forgotten one.
3. **Splitting keeps the parent.** When an item is broken into subtasks, the
   parent ID stays and gains a nested list. New subtask IDs are namespaced under
   the parent in prose (`w2-f22` → `design-review`, `main-protocol`, …) so the
   totals stay honest — see *Counting* below.
4. **One item, one place.** An item lives in exactly one group. If it plausibly
   belongs to two, pick the one that owns its completion criteria and
   cross-reference from the other.
5. **Evidence, not assertion.** Any number in this file must cite where it was
   measured. This repository's standing rule is *measure; do not reason from the
   code* (`.github/copilot-instructions.md`), and it applies to the tracker too.
   If there is no measurement, say so explicitly rather than estimating.
6. **Completed items move to "Completed recently"** with their commit SHA, and
   are pruned from there once the detail has landed in a permanent document.
7. **Scope decisions are recorded, not just applied.** When the maintainer
   narrows, defers or splits an item, add a dated row to *Maintainer decisions on
   record* and state what the decision costs as well as what it saves. A scope
   change with no recorded reasoning gets re-litigated by the next reader.

## Status legend

| Status | Meaning |
|---|---|
| **ACTIVE** | Being implemented right now. **At most one ACTIVE item per delivery stream** (see *Parallel delivery without reducing quality*); the number of ACTIVE items equals the number of live streams. Today that is one. |
| **PENDING** | Accepted, specified well enough to start, not started. |
| **DEFERRED** | Accepted and specified, but deliberately scheduled *after* the current milestone by a recorded maintainer decision. Always PENDING as well, and always says which decision deferred it. Not the same as BLOCKED: nothing technical prevents it. |
| **BLOCKED** | Cannot start until a named dependency lands. The dependency is always named. |
| **GATE** | Cannot proceed without a decision from the maintainer. See *Decision gates*. |
| **DONE** | Landed on `main` with its tests and, where applicable, its revert proof. |
| **DROPPED** | Deliberately abandoned. Kept as a row with the reason. |

An item may be both PENDING and GATE: the work is understood, but the shape of
it is a decision that has not been made.

## Counting

The register holds **24 work items**: 1 active parent and 23 not-started — of
which 19 are PENDING (one of those additionally marked DEFERRED by a recorded
maintainer decision) and 4 are BLOCKED on a named dependency. The active count
tracks the number of live delivery streams; it is one today because only Stream A
is editing source. `w2-f22` is
additionally broken into **6 subtasks**, which are *steps within* that item and
not separate work.

A naive row count of the underlying tracker therefore reports **30 open rows**
(1 parent + 6 subtasks + 23 not-started). Both numbers are correct; they answer
different questions. Quote "24 items" for scope and "30 rows" only when
reconciling against the tracker.

## Current active milestone

**Wave 2 — close the remaining audit findings, then release once.**

The standing disposition is to *work the full register and release once*, rather
than shipping each fix as it lands. `w2-release` is the milestone's exit and is
blocked on the five open `w2-*` items **and on `fullrun`, `shots` and
`final-cleanup`** — eight blockers in total, listed under *Dependencies and
order*. `w2-f03` and `w2-kbscroll` are `w2-*` items that are deliberately **not**
release blockers — do not infer the dependency from the ID prefix.

Active right now: **`w2-f22`**.

---

## A. Active

### `w2-f22` — protect unsaved tabs during shutdown · ACTIVE

Unsaved tab content must survive — or at least prompt on — every way the app can
go away: the native window close button, `Ctrl+Q`, an ordinary application quit,
and an update installation. Today those paths differ.

This is the fork's own subject matter. The tab model (`src/custom-tabs.js`) is
fork-owned and the reason Folia exists; a shutdown path that discards a dirty tab
is the same class of data loss as the stale-refresh bug the fork was created to
fix.

**Subtasks** (steps within `w2-f22`, not separate items):

| Subtask | What it covers |
|---|---|
| `design-review` | Independent review of the shutdown state machine *before* implementation — the states, the transitions, and which of them can be re-entered — by the three reviewers named in *Model roles and the delivery handoff*. |
| `main-protocol` | The main-process side: intercept close / quit / update-install, ask the renderer for approval, honour the answer. |
| `renderer-protocol` | The renderer side: snapshot the tabs, detect which are dirty, return an approval decision. |
| `tests` | Live Electron shutdown scenarios — every path above, exercised for real, not simulated. |
| `reverts` | Isolated revert proofs in `scripts/prove-table-fixes.js`, one per independently breakable behaviour. |
| `code-review` | Final independent review by GPT-5.6 Sol, GPT-5.6 Terra and GPT-5.6 Luna in three fresh contexts, and the corrections it produces — product fixes to Sol at high reasoning effort, test and automation fixes to Terra. See *Model roles and the delivery handoff*. |

**Completion criteria.** All four shutdown paths prompt (or preserve) for a
dirty tab and do not prompt for a clean one; every fix carries a revert with
`expect` *and* `mustPass` entries; `npm run test:tabs` and the affected suites
pass; `--anchors` resolves clean afterwards; **and the mandatory close-path
performance gate below is closed — that is, a final benchmark run evaluated
against a budget declared in advance, not the initial characterization alone.**

**Criteria status (2026-09-05): all of the above are met.** Suites, revert
proofs, anchors and the performance gate are executed and recorded below. What
remains is the final three-reviewer round over the executed state and the
serialised integration — this item is **not** landed.

**Mandatory close-path measurement — CLOSED (2026-09-05).** This item adds an IPC
round trip on shutdown and a renderer-side scan of every open tab, so it falls
squarely inside the *Performance acceptance gates* below: IPC and DOM traversal
are both named there, and the gate applies whether or not the change looks cheap.
Predicting the cost instead of measuring it is exactly what this repository's
*measure; do not reason from the code* rule forbids.

**The budget was declared before the run that was judged by it: raw p95 <=
16.7 ms**, one frame at 60 Hz, applied to every observation including the
worst-case dirty ones. The permanent record — full method, all three runs, the
durability limitation of the second, and what the gate deliberately does not
measure — is `bench/BASELINE.md`, *The F22 shutdown-approval gate*; the defect
the gate found and the fix it drove are `docs/PERF-AUDIT.md`, PERF-10.

**Three runs, each executed exactly once. None is an average or a best-of.**

| Run | Runtime | Cold worst | Warm worst | Single CRLF | All-dirty LF | All-dirty CRLF | Verdict |
|---|---:|---:|---:|---:|---:|---:|---|
| 1 — pre-optimization | 352112 ms | 2.538 | 0.993 | 1.048 | **22.4936** | **98.1947** | **FAIL** |
| 2 — optimized | 351318 ms | 2.5598 | 1.0094 | 0.4962 | 0.9079 | 1.1272 | pass, 0 failures |
| 3 — attestation | 354850 ms | 2.5902 | 1.0375 | 0.7076 | 1.002 | 1.2792 | pass, 0 failures |

All figures are **raw** p95 in milliseconds, nearest-rank, at 2 MB × 25 tabs for
the dirty rows and worst-of-nine-points for cold and warm. The lifecycle control
reached real application termination on runs 2 and 3.

**Run 1 is a result, not a discarded outlier.** It is the measurement that found
the defect — the close path recomputed every open document's dirtiness, so a
shutdown after editing every tab re-read and re-normalised 50 MB — and it is what
drove the maintained-dirty-state architecture. Recording only the passing runs
would hide the reason the passing runs exist.

**Evidence durability, stated rather than glossed.** Run 2's raw samples were
**not persisted**: the durable-output path did not exist when it was taken, so
its figures are the reported statistics and nothing else — there is no sample
array behind them to re-derive. Run 3 carries the exact raw arrays, each
observation's point and mode, its raw and rounded statistics, the budget and the
per-observation verdict, and the all-dirty filename oracles, in
`f22-final-benchmark-attestation.json` with its console transcript alongside.
**It does not carry** the fixture byte counts and SHA-256 digests, the envelope
token, or the setup and lifecycle validation records: those checks ran and a
failure in any of them fails the run, but they were performed transiently during
`validateResult()` and execution, and only their consequence — **0 failures** —
survives in the file. Re-deriving them means re-running the gate. The artifacts
are **machine-local closure artifacts, not repository files**, and are
deliberately not committed; a later run reproduces the shape via
`F22_RESULT_FILE` (`docs/BUILD.md`).

**Suites, both before and after the revert harness ran:** `test:tabs` **205/205**
plus the isolated portable companion **25/25**; `test:security` **189/189**;
`test:packaging` **265 passed / 0 failed / 1 expected skip**.

**Proofs.** `--expects` audited **545 records across 11 suites** with **3
excused** and **no orphaned regexes**, over **1,697 assertions**. `--anchors`
resolved **545/545 before and after**. Every one of the **58 F22 records
R543–R604** was proven **individually** (R575, R576, R581 and R587 do not exist),
with the tree byte-restored after each. No leftover processes, markers, locks or
temp residue; the diff check came back clean.

**No screenshot evidence is claimed for this item, and none exists.** F22 is
interaction, state-machine and performance work; its visual surface is the
platform's own modal dialog. The *Wave-2 exit criteria*' `shots` requirement is a
separate item covering the theme surfaces.

---

**Historical — the withdrawn first characterization (2026-09-02/03).** Kept
because the reasoning that rejected it is the reason the gate above is
trustworthy, and because the numbers themselves were never in dispute. It is
**superseded** by the three runs above.

**Method.** `bench/bench-f22-shutdown.js`, Electron **43.4.1** / Node
**24.18.1**, **two full runs**. Renderer snapshot + all-tab dirty scan: **n=200**
after **20 warmups**. Clean native-close approval-to-continuation: **n=40**.
Fixture: the repository `README.md`, **25,762 characters per tab**. The modal
count was asserted **zero** on every clean run — the prompt-free path raises no
dialog, which is what makes these numbers the *clean* shutdown cost.

Ranges below span the two runs; where a single figure is given, both runs agreed.

| Measurement | Tabs | p50 (ms) | p95 (ms) |
|---|---|---|---|
| Renderer `snapshotActiveTab` + all-tabs `isDirty` | 1 | 0.3 | 0.4–0.5 |
| Renderer `snapshotActiveTab` + all-tabs `isDirty` | 10 | 0.8–0.9 | 1.1–1.4 |
| Renderer `snapshotActiveTab` + all-tabs `isDirty` | 25 | 1.9–2.0 | 2.2 |
| Clean native-close approval → continuation | 1 | 1.15–1.26 | 1.42–1.61 |
| Clean native-close approval → continuation | 10 | 1.67–1.75 | 1.88–2.87 |
| Clean native-close approval → continuation | 25 | 2.64–2.73 | 2.97–3.09 |
| Bare IPC round trip (reference floor) | — | 0.165–0.177 | 0.21–0.30 |

Worst single sample observed across both runs: **3.78 ms**, at 25 tabs.

**On the absence of a "before" number.** There is no pre-F22 baseline for the
approval path, because that path did not exist — the protocol is what this item
introduces. The figures above are therefore not a delta against a measured prior
state; they are the cost of the new path as measured. That is a real limitation
of this evidence, not a technicality: with no before-number there is nothing to
regress against, which is precisely why the gate has to be closed against a
budget instead. The bare IPC row is included as the floor the protocol cannot go
below, so the protocol's own share is visible. **This limitation still stands**;
it is why the closed gate above is judged against a predeclared budget rather
than against a delta.

**Why that was characterization and not a passed gate — and how each defect was
closed.** Three defects, none of them in the numbers themselves:

1. **One fixture.** Every figure in the historical table uses the repository
   `README.md` at 25,762 characters per tab. The *Performance acceptance gates*
   call for representative content sizes, and this is a single point.
   **Closed:** the gate now runs 50 KB / 500 KB / 2 MB across 1 / 10 / 25 tabs,
   plus all-dirty worst cases at 2 MB × 25 tabs in both LF and CRLF.
2. **No before-path and no prior figure** to compare against, as set out above.
   **Not closed, and it cannot be** — the path did not previously exist. This is
   why a predeclared budget carries the verdict.
3. **No budget was declared before the measurement was taken.** Reading a
   threshold off an observed result and then declaring the result acceptable is
   post-hoc acceptance, which the gate policy exists to prevent. The earlier
   framing of these numbers as a pass did exactly that and is withdrawn.
   **Closed:** 16.7 ms was fixed before the judged runs, and run 1 failing
   against it is the evidence that the budget was real rather than decorative.

**What closing the gate required — all met.**

- **An objective UX budget recorded before the next run** — met: raw p95 <=
  16.7 ms, one frame at 60 Hz, declared ahead of the runs it judged.
- **A fixture matrix beyond the single README** — met: **50 KB / 500 KB / 2 MB**
  across **1 / 10 / 25 tabs**, plus the all-dirty LF and CRLF worst cases.
- **The final run after the review gate's product fixes are in the working tree**
  — met: runs 2 and 3 were taken after those fixes.
- **The budget is not chosen in this document** — respected: it was proposed and
  accepted before the runs, and appears here only as a record of what was
  applied.

**Do not overgeneralise this result.** The gate covers **up to 25 tabs** and
documents **up to 2 MB** each. Nothing here measures 100 tabs, or documents
larger than the matrix. The all-dirty observations are the worst case *within*
those bounds, not beyond them. Any change that raises either bound re-opens this
measurement.

**Status.** The implementation, the executed suites, the proven reverts and the
closed performance gate all exist in the **uncommitted working tree**; they have
**not landed on `main`**, and nothing here is merged. `w2-f22` remains
**ACTIVE**. What is complete: implementation, tests, revert records, the
execution gates (suites, anchors, `--expects`, individual proofs) and the
performance gate. What remains: the final three-reviewer round over the executed
state, and serialised integration. The permanent record required before landing
is now written — `bench/BASELINE.md` (method and runs) and `docs/PERF-AUDIT.md`
(PERF-10, the defect and the fix) — so an uncommitted bench file is no longer the
only place the evidence lives.

**Review round — corrections applied, nothing re-run (2026-09-04).** A sealed
three-reviewer round returned ten findings against the working tree. All ten
were validated against the current source and fixed; one carried a mistaken
mechanism, corrected below, and two implementation decisions taken while fixing
them are recorded in *Maintainer decisions on record*. The corrections, all
uncommitted:

- **Product** (`src/main.js`, `src/custom-tabs.js`) — the portable updater now
  confirms **twice against the live document**: once at the child's `spawn`
  event, before the release gate is written, so a decline still stops an
  installer that has not started; and again at the **acknowledgement**, before
  the quit, because everything between those two points — spawning, polling,
  `start`, the write-back — is time in which the reader can type. Both are
  silent on a clean document. It quits only on an acknowledgement written by
  the batch *after* it has started the installer, carrying a per-hand-off
  secret, with a fail-closed timeout. Every failure and cancel path now removes
  the private temp directory. The shutdown state machine gained an `onDeclined`
  channel so an asynchronous hand-off is told when its intent will never run.
  The renderer's shutdown snapshot now compares the live document against the
  **cached** copy rather than the on-disk one — undoing a view-mode edit used to
  leave the abandoned text in the tab — and its replay cache is bounded to the
  one answer that can still be replayed.
- **Benchmark** (`bench/`) — budgets are compared against **raw** p95 samples,
  with rounding confined to presentation; the worker parent settles exactly once
  on error/close/timeout, so a failed spawn can no longer crash it and leak the
  exclusive lock; and two **worst-case all-dirty observations** (2MB × 25 tabs,
  LF and CRLF) were added, gated against the same budget, each proved
  non-vacuous by an exact filename oracle.
- **Verification** — `.github/workflows/ci.yml` gained a second, read-only job
  running `prove-table-fixes.js --expects`, the audit that catches a renamed
  assertion; `test/test-packaging.js` asserts both audits run and that no
  workflow runs the tree-rewriting mode. Thirteen revert records were added
  (R590–R602), six repaired against moved anchors, and **R560 was replaced** —
  its previous mutation was behaviourally inert and could not fail anything.

**A second review round found seven more defects, all fixed here.** Two
independent read-only reviews (Claude Opus 5 and GPT-5.6 Luna) were run over the
corrections above before they were reported. Both found real defects, and one of
them was introduced by this round:

- **HIGH, introduced by the snapshot fix** — five test fixtures assigned
  `tab.content` on the ACTIVE tab and only then called `switchToTab`, leaving
  `window.originalMarkdown` holding the pristine text. The corrected fold does
  exactly what it should with that and folds the edit away, so four existing
  assertions would have measured a clean tab they believed was dirty. The
  fixtures now move the live copy first; the product change is unchanged.
- **HIGH** — an acknowledged portable hand-off quit on consent that could by
  then describe a different document. It now re-asks when a question is already
  open or the document session has changed.
- **MEDIUM** — a hand-off that timed out *after* its gate was open cleared the
  retry latch, so a second Install press could launch a second installer over
  the first. Only a pre-release cancel or the batch's own failure report — both
  of which prove nothing started — clear it now.
- **MEDIUM** — `attachShutdownGuards()` and the `__shutdown.reset()` seam
  dropped pending and queued intents without declining them, stranding a parked
  hand-off.
- **MEDIUM** — the benchmark's `listener` control sent no renderer generation,
  so every one of its 40 samples timed the handler's stale-request early return
  rather than the scan. It now passes the generation and refuses to report
  unless all 50 calls were answered.
- **MEDIUM** — the benchmark's exclusive lock survived a Ctrl+C or an uncaught
  exception, making the gate unrunnable until the file was found by hand.
- **LOW** — a duplicate-replay assertion could no longer distinguish a cache hit
  from a recompute; the portable `error` handler lacked the terminal-state guard
  every other path has.

Two of Luna's findings were **rejected**, with reasons recorded in *Maintainer
decisions on record*: the ack token being readable by another same-user process,
and `%`-expansion in batch-interpolated paths.

**A third round found one more, and it is the sharpest of them (2026-09-04).**
Luna, reviewing the post-fix snapshot, blocked on the acknowledgement boundary:
it quit outright whenever the document *generation* was unchanged and no other
question was open. That test cannot see the case it most needs to. An edit typed
after the gate opened and before the acknowledgement came back involves no
navigation and raises no question, so the generation is unchanged and the edit
was discarded by a quit that believed it had consent — the same defect `w2-f22`
exists to remove, moved one boundary later. The acknowledgement now always takes
a fresh renderer approval, silent on a clean document, with a **quit-only**
continuation: it never re-enters the installer path, never re-releases the gate,
and a decline leaves the app running, unauthorized and still latched, because an
installer that is already running must not be joined by a second one. Covered by
two new assertions (decline and approve) and by the rewritten **R601**.

**Round 4 — Terra's final execution FAILED, and the correction is architectural
(2026-09-05).** `npm run test:tabs` returned 200/204 (portable companion 25/25),
revert record **R567** returned WRONG-GUARD, and the benchmark failed honestly:
all-dirty 25 × 2MB raw **p95 22.49 ms (LF)** and **98.19 ms (CRLF)** against the
16.7 ms budget. Cold max 2.538 ms, warm max 0.993 ms, single-dirty CRLF
1.048 ms. Three root causes, none of them in the numbers:

1. **The fold could not tell which side moved.** Comparing the live document
   against the *cached* copy fixed the resurrection defect but broke its mirror
   image: a value written straight into `tab.content` — a reload takeover, a
   completed background save, a test seam — is *newer* than the live copy, and
   the fold reverted it, after which the tab read clean and was clobbered by the
   next disk refresh. Both situations present the identical state, so no pair of
   values can separate them. The tab now records the live document its fold last
   observed and adopts only when that witness has moved. All three failing
   product assertions are this one defect.
2. **The measurement window did not contain the work.** The `sameDocument`
   assertions wrapped their scan counters around the *shutdown handler*, but the
   comparison had already been made — and memoised — by the snapshot inside
   `switchToTab`, so they counted zero whatever `sameDocument` did. That is why
   "finds a one-character edit" failed, and why **R567** could delete the
   CR-free fast path without breaking the assertion that names it. The counters
   now wrap the **assignment**, which is where the comparison happens.
3. **Dirtiness was recomputed on the close path.** The memo was keyed on the
   *values*, so its own validity check was itself a full document comparison —
   25 × 2MB of scanning and, for CRLF, of re-normalisation, on every shutdown.
   The answer belongs to the edit, not to the close: `content` and
   `originalContent` are now accessors that settle dirtiness once, at the moment
   the text changes, and shutdown reads one boolean per tab plus at most one
   active-tab reconciliation. Accessors deliberately, not a convention — this
   file, `renderer.js`, the suites and the benchmark all assign those properties
   directly, so a rule that had to be called by hand would be one refactor from
   a stale flag, and a stale flag here reads as "nothing unsaved".
   `setCleanDocument()` states the clean case atomically instead of comparing
   twice on the way to an answer that is already known. **The budget, the
   fixtures, the tab counts, the CRLF observation and the exact filename oracle
   are unchanged; nothing was trimmed, filtered, or moved out of the timed
   window.**

**Durable evidence — Terra could not save the raw samples.** The run deleted its
working directory and printed only rounded figures. Every run now prints one
greppable `F22-RESULT-JSON` line carrying the **raw** p95 of every observation,
and `F22_RESULT_FILE` writes the full record — every raw sample, both
statistics, the budget verdict and the oracle — atomically to a caller-chosen
path, before the lock is released, so a Ctrl+C still leaves its numbers behind.
Nothing is written by default and no artefact lands in the repository. Both
halves are asserted by `test:packaging`.

**One finding's stated mechanism was wrong; its conclusion was not.** The
benchmark finding attributed the free dirty scan to the cold/warm *fixtures*
being reference-identical. They are separate files, read separately. What
actually makes the scan free is `createTab()` storing **one string reference in
both `content` and `originalContent`** (`src/custom-tabs.js`), so `sameDocument`
returns on its identity check before reading a byte. The observation stands and
the worst-case observations were added; the reason recorded here is the measured
one.

**These corrections have not been executed.** No suite, benchmark, revert
harness or build was run in the session that made them; static syntax and anchor
checks only. Treat every claim above as *written*, not *verified*, until Terra
re-runs the affected suites, `--anchors`, `--expects` and `npm run bench:f22`.

**Two consequences that need a decision when it is re-run.**

1. The all-dirty observations apply the **clean-path** budget to a path that
   ends in a modal dialog. They may well exceed it; that is a real number to
   act on, not a defect in the harness, but whether a dirty close is bound by a
   frame budget at all is the maintainer's call and is still open.
2. `--expects` has never run in CI. Its first run audits all 500-odd records,
   not just this item's, so it may surface pre-existing orphaned regexes
   elsewhere in the register.

**Trap to respect.** A modal dialog raised in the **main** process cannot be
dismissed by any test — the process that would run the rescue is the process
that is blocked (`.github/copilot-instructions.md`, "Traps in this repository").
Any approval prompt this item introduces must be designed around that, or the
suites hang instead of failing.

---

## B. Security and wave-2 hardening

### `w2-sec08` — context-isolated renderer · PENDING

Turn off `nodeIntegration` in the main window, turn on `contextIsolation`, and
put a minimal validated `contextBridge` preload in front of it. The four popup
windows are already done; the main window is the deliberate, documented
remainder (`docs/SECURITY-AUDIT.md`, SEC-08).

This is the largest single item in the register and it is not a flag flip. The
audit records the measured size of it: **40** distinct IPC channels to re-expose,
**70** `ipcRenderer` call sites, **18** synchronous `fs`/`path`/`os` calls that
become asynchronous IPC round-trips, and **6** renderer-only CommonJS modules
with no loader once `require` disappears (`docs/SECURITY-AUDIT.md`, the SEC-08
inventory table).

> **The audit's inventory is a snapshot and has already drifted.** It records
> `renderer.js` at **8,631** lines; at `db7b960` the file is **9,319**. Re-take
> the counts against the tree before planning the work — do not budget from the
> table above.

**Order of work is fixed by the audit** (each step independently shippable):
rebuild the harnesses' renderer access on a test-only preload → give the 6 local
modules a dual-mode loader → move the 18 `fs`/`path`/`os` sites to IPC one at a
time → replace the 70 `ipcRenderer` sites with a validating bridge → only then
flip the flags, and `sandbox: true` last.

**Path validation lands *inside* this item, not after it.** Several handlers
accept renderer-supplied paths with no validation — `save-markdown-file` writes
any path, `reload-file` reads any path, `start-file-watching` and
`set-active-file` watch any path, `open-folder-in-explorer` calls
`shell.showItemInFolder` on any path. Today that is not an escalation, because
the renderer already has unrestricted `fs`. The audit is explicit that it *"does
become a real path-traversal/arbitrary-write vulnerability class the moment
SEC-08 is fixed — so path validation must be added **as part of** that refactor,
not after it"* (`docs/SECURITY-AUDIT.md`). Deferring it to `w2-f03` would open
the class it is supposed to close.

**Completion criteria.** Main window runs `nodeIntegration: false`,
`contextIsolation: true`; every channel crossing the bridge validates its
arguments, **and every renderer-supplied path is validated**; all impacted
cross-suites pass on the reworked harness and the full 13-suite `npm test` runs
at the next declared milestone boundary; the full benchmark set in *Performance
acceptance gates* is recorded; SEC-08's section in the audit is rewritten from
*deferred* to *fixed*.

### `w2-f03` — validate sender and frame on every IPC handler · BLOCKED on `w2-sec08`

Every `ipcMain` handler should verify which `webContents` and which frame sent
the message rather than trusting any sender. The audit enumerated the full
surface and found no privilege escalation beyond what the renderer already holds;
that last clause is precisely why this is sequenced *after* SEC-08. While the
renderer is Node-privileged, sender validation defends against a frame, not
against an attacker who already has the renderer.

> **Count the handlers freshly; do not quote a number from anywhere.** The
> audit's heading says "all 31 handlers reviewed" while the enumeration on the
> same line lists **29** line numbers, and a direct count of `ipcMain.*`
> registrations in `src/main.js` at `db7b960` agrees with neither. The surface
> is "every `ipcMain` registration", and the first task of this item is to
> establish that set and reconcile the audit.

**Scope boundary.** *Sender and frame* validation belongs here. *Path*
validation belongs to `w2-sec08` — see the note there.

**Completion criteria.** Every handler validates sender and frame; a probe
proves an unexpected sender is rejected; reverts pin it; the audit's handler
count is corrected to the measured one.

### `w2-privacy` — turn the packaged diagnostic log off by default · PENDING · wave-2 release blocker

> **Folia uploads no logs. There is no telemetry, and this item does not add
> any.** No first-party code sends document content, usage data, or log content
> anywhere. Every rendering library is vendored under `libs/`, so no CDN is
> contacted at runtime (`docs/SECURITY-AUDIT.md`, SEC-10 — *"Runtime libraries
> vendored locally; no CDN load"*).
>
> **Two things do reach the network, and both are stated in `README.md` rather
> than buried:** `electron-updater`'s check against this project's own releases
> feed, gated on `app.isPackaged` and carrying no document content; and **any
> image a document itself points at with an `https:` URL** — the CSP keeps
> `img-src … https:` deliberately so remote images in markdown keep working
> (`docs/SECURITY-AUDIT.md`, SEC-09), and the resulting read-receipt exposure is
> recorded there rather than traded away. That request is the document's doing,
> not Folia's, and it is not a log upload.

What this item actually is: **`src/main.js` opens an append-only write stream to
`<userData>\debug.log` at module load and writes to it unconditionally** —
including in packaged builds, where the console half is suppressed
(`if (!app.isPackaged)`) but the file half is not. The work is therefore **local
data minimisation and disk hygiene**, and nothing to do with remote telemetry.

**What the file actually accumulates, and why it outlives the app** (evidence
gathered during review, all read from the tree):

- **It records filesystem paths and the full command line.** `log("Attempting to
  open file:", filePath)`, `log("Extracted file path:", filePath)`,
  `log("handleFileArgument called with argv:", argv)` and
  `log("Initial process.argv:", process.argv)` are all in `src/main.js`. Document
  paths are frequently sensitive on their own — they carry project names, client
  names and directory structure.
- **It records raw updater error text.** `autoUpdater.on("error", …)` calls
  `log("Auto-updater error (silent):", err.message)` — the message is written
  verbatim, unfiltered.
- **It survives uninstall.** `package.json` sets `nsis.deleteAppDataOnUninstall:
  false`, so removing Folia leaves `<userData>\debug.log` on disk indefinitely.
  That flag is otherwise deliberate — it is what preserves the user's tabs and
  settings across an upgrade — so the fix belongs in the logging, not in the
  uninstall behaviour.

**Realistic severity: Low-to-Medium**, for a single-user desktop install. It is a
*local* privacy and disk-hygiene issue: an unbounded, uninstall-surviving file
containing paths and argv, readable by anything else running as that user. It is
**not** a data-exfiltration issue and must not be written up as one — nothing
uploads it.

#### Release logging policy (the target state for this item)

**Scope narrowed by maintainer decision, 2026-09-02.** Because the diagnostic
file is being turned off by default in packaged builds, the *hardening* of that
file — rotation, size/count retention, sanitising and redaction — no longer has
to ship inside this release-blocking item. It moves to
`diagnostic-log-hardening` below. What remains here is deliberately minimal,
tested, and expected neutral-to-slightly-faster.

This is the policy the item must land, stated so it can be asserted against
rather than re-litigated:

1. **Packaged/release builds create no `debug.log` and write no diagnostic file
   by default.** Not an empty file, not a zero-byte placeholder — no file.
2. **Development builds may log to the console.** That is already the existing
   `!app.isPackaged` behaviour and is not the problem. Console-only stays the
   development default; nothing in this item adds a development file.
3. **Diagnostics are enabled only by an explicit, documented switch.** Name:
   **`FOLIA_DIAGNOSTIC_LOG=1`**. This follows the repository's existing
   environment-variable convention — `FOLIA_DEVTOOLS` and `FOLIA_GOLDEN_COMMIT`
   are the precedents, alongside the unprefixed `PACKAGING_STRICT`. No collision
   exists in the tree today; confirm again at implementation time, and document
   it in `docs/BUILD.md` where the other switches live. With the switch set, the
   diagnostic file may be created — in its current unhardened form, which is the
   accepted tradeoff below.
4. **Disabled must mean the stream is never opened.** The `createWriteStream`
   call currently runs at module load, before anything has decided whether
   logging is wanted. Gate the *creation*, not just the writes — otherwise the
   default install still creates the file, which is exactly what point 1
   forbids.
5. **An existing stale packaged `debug.log` stops being a growing artefact.**
   Users who already ran an affected build have one on disk. On a default
   (opt-out) packaged start, Folia removes it, or at minimum never appends to it
   again. Leaving a file that keeps growing after the fix ships would defeat the
   item.
6. **No upload path is added, and none exists.** This item introduces no network
   call whatsoever.

**Explicitly out of scope here** — all of it owned by `diagnostic-log-hardening`:
rotation, maximum size, retained-file count and retention policy, redaction of
paths and `argv`, and the replacement of raw updater `err.message` with safe
structured fields.

**What deferring actually costs, stated plainly.** Making the file opt-in removes
it from the default install, which is where nearly all of the exposure was: no
file means nothing to accumulate, nothing to survive uninstall, nothing for
another process running as that user to read. That genuinely reduces urgency.
It does **not** make the risk disappear. When a user *does* set
`FOLIA_DIAGNOSTIC_LOG=1`, the file they get is still the unhardened one — it
still records document paths and the full `argv`, it still writes updater
`err.message` verbatim (which can carry response metadata such as a status line,
a URL or header-derived text, depending on what `electron-updater` surfaces), and
it is still unbounded and still survives uninstall via
`nsis.deleteAppDataOnUninstall: false`. This is an **accepted tradeoff**, not a
resolved risk.

**Therefore, until `diagnostic-log-hardening` lands, the documentation must tell
users to enable diagnostics only temporarily** — turn it on to reproduce a
problem, turn it off afterwards, and delete the file. That sentence belongs in
`docs/BUILD.md` alongside the switch, and it is part of this item's completion
criteria.

**Completion criteria.** A packaged default run **creates no new diagnostic
file** and neither opens nor appends to `debug.log` (asserted, not assumed); an
assertion proves the write stream is not opened when logging is disabled; a
*pre-existing* packaged `debug.log` is either removed or provably left untouched
and unappended on a default start — the two permitted outcomes of point 5, and
the only sense in which a file may still be present after a default run;
`FOLIA_DIAGNOSTIC_LOG=1` does create the diagnostic file; no upload path is
added; `docs/BUILD.md` documents the switch **and** the temporary-use guidance
above. Reverts pin each of those independently. Hardening assertions are
explicitly *not* required here — they belong to `diagnostic-log-hardening`.

### `diagnostic-log-hardening` — harden the opt-in diagnostic log · PENDING · DEFERRED

**Not a wave-2 release blocker.** Deferred out of `w2-privacy` by maintainer
decision on **2026-09-02** (see *Maintainer decisions on record*), on the
reasoning that once the file is off by default, hardening it is no longer on the
release path.
It is not BLOCKED — nothing technical prevents it — it is scheduled after the
milestone. It does depend on `w2-privacy` in the practical sense that the opt-in
switch has to exist before there is a gated file to harden.

This item owns everything `w2-privacy` no longer does:

1. **Rotation and bounds.** A maximum file size and a maximum retained file
   count, both fixed constants, oldest rotated out. An opt-in log that grows
   forever is the same defect behind a flag — it is merely no longer a *default*
   defect, which is why it can wait but cannot be dropped.
2. **Retention.** How long rotated files are kept, and what removes them. Both
   halves are in scope: a chosen **retention duration** (a fixed constant, not
   "until the disk fills"), and the **cleanup behaviour** that enforces it —
   what deletes an over-age file, and when it runs.
3. **Sanitising and redaction of what is already logged.** Document paths, the
   extracted file path, `argv` and `process.argv` are all written today
   (`src/main.js`). Decide per call site whether the value is needed at all,
   redacted, or reduced — a basename or a hash rather than a full path.
4. **Safe structured fields for the updater error path.** Replace
   `log("Auto-updater error (silent):", err.message)` with a deliberate,
   enumerated shape: an error class or `code`, an HTTP `status`, and at most the
   *host* — never a full URL with a query string, never headers, never a
   response body, never cookies.
5. **Documentation, tests and reverts for the opt-in path in detail** — what the
   log contains once hardened, what it deliberately omits, and revert records
   pinning each guarantee independently. The temporary-use warning added by
   `w2-privacy` is revisited here and relaxed only if the hardening earns it.

**Completion criteria.** With `FOLIA_DIAGNOSTIC_LOG=1`: the log rotates at a
fixed size, retains a fixed count, and an assertion proves both; **a specific
retention duration is chosen and documented in `docs/BUILD.md` as a named
constant — not left implicit — and age-based cleanup is proven by two
assertions: an over-age rotated file *is* removed, and a within-age file is
*not*** — a cleanup that deletes everything passes a naive retention test while
destroying the diagnostics the flag exists to produce; an assertion proves no raw
updater `err.message` is persisted and that only the enumerated safe fields
appear; an assertion proves path/`argv` redaction; `docs/BUILD.md` documents the
hardened format; **each of those guarantees — size, count, the retention duration
and the age-based removal behaviour included — has its own revert record**,
proven individually rather than as a batch. No change to the packaged default,
which `w2-privacy` already settled.

### `w2-hygiene` — dead code and one file-extension policy · PENDING

Remove handlers and code paths that nothing reaches, and consolidate the
file-extension policy into a single source of truth. Extension handling is
currently a *security* policy (SEC-12 routes local-file links through an
extension check applied to the `realpathSync`-resolved path) as well as a
file-association and open-dialog concern; more than one list of extensions is a
divergence waiting to happen.

**Completion criteria.** One extension policy, referenced everywhere it is
needed; every removal proven unreachable before deletion, not after; suites and
`--anchors` clean.

### `w2-upstream` — classify the 16 outstanding upstream commits · BLOCKED on `upstream-toolbar-overflow`

Folia is a hard fork, not a branch: upstream commits are taken as deliberate
individual cherry-picks, never merged wholesale
(`.github/copilot-instructions.md`, `docs/CUSTOMIZATIONS.md`). Sixteen upstream
commits are outstanding and unclassified — verified at `db7b960` with
`git rev-list --count HEAD..upstream/main`, which is how the number should be
re-checked rather than trusted from this file.

Policy for this item: **bug fixes and security fixes are taken autonomously**
after evaluation. **Feature additions are a decision gate** — the fork's stated
direction is *leaner and faster*, and two upstream features have already been
evaluated and declined on exactly that ground.

It is sequenced after `upstream-toolbar-overflow` because that item is itself an
upstream-derived fix in the same surface; classifying the backlog before it lands
would mean classifying against a moving target.

**Completion criteria.** All 16 commits classified as *taken*, *declined*, or
*escalated to the maintainer*, with the reason recorded per commit; everything
taken carries tests and a revert; `docs/CUSTOMIZATIONS.md` updated for anything
that changes the fork's divergence.

### `w2-kbscroll` — keyboard scrolling of the document · PENDING

Keyboard scrolling in the document pane does not work. This is a plain
correctness bug in the reading experience — for a document viewer, "the arrow
keys and Page Down do nothing" is a first-minute defect.

**Completion criteria.** The standard keys scroll the viewer; the fix does not
re-break the arrow-key file navigation that F23 established (arrow keys must not
be swallowed when there is nowhere to navigate); assertion + revert.

### `w2-release` — ship wave 2 · BLOCKED

The milestone exit: documentation, the complete suite, version bump, tag, and
release. The current version is whatever `package.json` declares — read it there;
it is not restated here, because a version literal in a planning document is the
one number guaranteed to go stale.

**Blocked on:** `w2-f22`, `w2-hygiene`, `w2-privacy`, `w2-sec08`, `w2-upstream`,
and — corrected 2026-09-03 — `fullrun`, `shots`, `final-cleanup`; and on
`w2-ci`, `w2-docs`, `w2-f23`, `w2-f25`, which are **already done**.

**Release traps, both already paid for once** (`.github/copilot-instructions.md`):

- **Tag pushes do not trigger the release workflow on this fork.** `git push
  origin vX.Y.Z` succeeds, prints a new-tag line, and starts nothing. Dispatch on
  the tag ref: `gh workflow run release.yml --ref vX.Y.Z`. Dispatching on `main`
  builds everything and publishes nothing.
- **Bump `package-lock.json` with `package.json`.** The workflow runs `npm ci`,
  which fails when they disagree.

**Completion criteria.** Full `npm test` green from a clean tree; `PACKAGING_STRICT=1
npm run test:packaging` green; docs current; version and lockfile bumped
together; tag dispatched on the tag ref; artifacts verified by looking at the
installed app, not by capturing a screenshot of it.

---

## C. Mermaid

Three items in the same surface. The first two are **correctness** items from the
F43 / N18 work; the third is a **performance** question in the same code. They
are listed separately because they fail differently and can be proven separately.

### `mermaid-cold-cache-source` — reused SVG must not become "source" · PENDING

After a cache eviction, previously rendered SVG markup can be mistaken for the
diagram's Mermaid source. The recent hardening removed fallback source
reconstruction and made these paths fail closed (commit `db7b960`); this item is
the remaining cold-cache case.

**Completion criteria.** With the cache cold, an edit either reaches the true
source or fails closed with a visible reason — never silently edits rendered SVG;
assertions on both the full and light render paths; revert.

### `mermaid-block-identity` — renderer-owned identity for edit/delete · PENDING

Introduce renderer-owned `WeakMap` identities for Mermaid blocks so an edit or a
delete acts on the block the user actually pointed at. Identity currently rests
on positional or markup-derived matching, which is exactly the assumption F43
showed a hostile or merely unlucky document can break.

**Completion criteria.** Edit and delete are proven to act on the intended block
with duplicate and near-duplicate diagrams present in one document; a decoy
cannot capture a real block on either render path; revert.

### `perf-mermaid-sweep` — remove a duplicate DOM traversal · PENDING

There is a redundant second traversal of the Mermaid DOM. **Measure its cost
before removing it** — a traversal that is free is not worth the churn, and this
repository's rule is that the measurement decides.

**Completion criteria.** The measurement is recorded in `docs/PERF-AUDIT.md`
whichever way it goes; if removed, the class census and node counts are unmoved
and the saving is stated as a measured number.

---

## D. Performance and UI correctness

### `table-breakout-perf` — the single largest remaining render cost · PENDING

`applyTableBreakout()` is the dominant phase on wide documents. Measured in
`bench/BASELINE.md`: with `marked` linear, it is **2,595–2,686 ms of the `wide`
profile's 3,439 ms render at 1 MB — about 76%** — and it is the phase sitting
closest to the harness's nonlinear bound on most runs.

Two earlier figures from the same file, neither interchangeable with the `wide`
number above. The gutted-versus-intact experiment was run on the **`tables`**
profile at 256 KB and measured **372 ms → 0 ms** with every output oracle silent
— and that 372 ms is the cost of the pass's **no-op path**, because every table
the corpus generated at the time fitted inside the reading column, so the pass
measured its containers, decided nothing needed widening, and returned. (That
column is **860 px measured**, not the 900 px the stylesheet names; the
difference is padding.) Separately, the pass was **79%** of a 1 MB render before
the layout-thrash fix — `bench/BASELINE.md` does **not** name a profile for that
one, and the `wide` profile did not yet exist when it was taken, so read it as a
table-profile figure and re-derive it rather than quoting it at `wide`.

That last detail is why this item also carries a testing obligation: **no oracle
over rendered output can cover a pass that produces no output.** The corpus now
has a `wide` profile precisely so this pass is exercised; any optimisation must
keep it exercised.

**Completion criteria.** A measured reduction in the breakout phase on the `wide`
profile at 256 KB / 512 KB / 1 MB, reported with the harness's own numbers; the
class census and `.table-breakout` counts unchanged; `bench/BASELINE.md` updated
with the method as well as the result.

### `upstream-toolbar-overflow` — menus must not escape a narrow window · PENDING

Menus extend outside the window at narrow widths. The fix must handle overflow
**without clipping nested flyouts** — the naive `overflow: hidden` fix trades one
visible defect for a worse, less obvious one.

**Completion criteria.** At the narrowest supported window width, no menu escapes
the window and every nested flyout is fully reachable; verified by *looking* at
the screenshots, not by capturing them.

### `perf-node-count` — fewer Prism token spans on very large code blocks · PENDING · GATE

Evaluate reducing the number of DOM nodes Prism emits for very large code
blocks. Prism was deliberately left eager and is not the startup problem — it is
**96 KB** against Mermaid's 3.2 MB, and a fresh bundle load/eval measures
**16.7 ms** (`docs/PERF-AUDIT.md`). The question here is *node count in the
rendered output*, not load cost.

**Gate — the threshold only.** The simplification threshold — the size at which a
code block stops being fully tokenised — is a maintainer decision, because it
trades syntax fidelity for speed on exactly the documents where the user is most
likely to be reading code. **The measurement and the evaluation are autonomous**;
only picking the threshold stops. There is no contradiction with the completion
criterion below: the bench *derives* the candidate value, and the maintainer
accepts the trade or declines it. See *Decision gates*.

**Completion criteria.** The threshold is derived from the bench, not chosen by
taste (the repository's rule for fitted constants); the node-count reduction and
the render-time effect are both measured; the fidelity loss above the threshold
is described in the docs and visible in a screenshot.

### `rv4-nth` — remaining theme/render review findings · PENDING

The unresolved tail of the RV4 theme/render review round. These are individually
small; they are kept as one item because they came from one review and share its
context.

**Completion criteria.** Every finding in the round is closed as fixed, declined
with a reason, or promoted to its own ID here. None left unaddressed.

### `n16-insert-anchor` — insertion position must match the source · PENDING · GATE

Insertions can land at a badly mismatched source/DOM position — the DOM location
the user pointed at and the source offset the text is written to disagree.

**Gate:** scope and design. Mapping DOM position back to source offset can be
done narrowly (fix the specific mismatching call sites) or generally (a real
position map maintained across renders). The general version is a substantially
larger change to the render pipeline. See *Decision gates*.

**Completion criteria.** Whatever scope is chosen, insertion position is asserted
against the *source* for the cases in scope, the out-of-scope cases are written
down, and a revert proves the mapping is load-bearing.

### `n2-user` — Ctrl+wheel zoom anchoring · PENDING · GATE

Decide whether `Ctrl`+wheel zoom should anchor around the **pointer** rather than
the pane centre. This is a preference question, not a defect: pointer-anchored
zoom is the common convention, and centre-anchored zoom is what the existing
zoom work — which deliberately holds the reader's place — currently gives.

**Gate:** the maintainer's call. No implementation until it is made.

---

## E. Delivery and verification

### `sign-provenance` — build provenance and signing · PENDING · partial GATE

Two separable pieces, deliberately split so the free one is not held hostage by
the paid one:

- **Free GitHub artifact attestations — autonomous.** Add build provenance
  attestations to the release workflow. No cost, no external decision; proceed.
- **Paid Azure Artifact Signing — GATE.** Actual code signing costs money and is
  the maintainer's decision. Until it is taken, builds remain unsigned.

**Do not read the build log as evidence here:** electron-builder logs `signing
with signtool.exe` whether or not a certificate exists
(`.github/copilot-instructions.md`). The builds are unsigned.

**Completion criteria.** Attestations are produced by the release workflow and
verifiable against a published artifact; the packaging suite asserts the workflow
still emits them; the signing decision is recorded here either way.

### `readme-story` — rewrite the README around the fork's story · PENDING

Rewrite `README.md` around Folia's divergence from upstream, what was improved,
the measurements behind those claims, and where it is going. **Verify the
README's own claims before publishing them** — stated counts in this repository
have rotted every single time they were hand-maintained, which is why several of
them are now pinned by assertions in `test/test-packaging.js`.

**Two known inconsistencies to resolve while doing it**, both found by review of
this register and neither fixed here:

- `README.md` states in one place that the two network paths are the update check
  and document-authored `https:` images, and in another that *"Folia makes no
  network requests"*. Both cannot be true; the first is the accurate one.
- `docs/SECURITY-AUDIT.md`'s coverage note still says the only outbound activity
  is "the CDN/font loads in `index.html` (SEC-10) and `electron-updater`'s GitHub
  Releases check". That predates the SEC-10 fix — libraries are vendored and no
  CDN is contacted — and it omits SEC-09's deliberate `img-src https:`. The row in
  the same document's summary table (SEC-10 **FIXED**) is the current truth.
*(A third inconsistency — hardcoded harness counts of **458** records and **276**
`mustPass` entries in `.github/copilot-instructions.md`, against **487** and
**303** counted at `HEAD` on 2026-09-02 — was **resolved on 2026-09-03** by
removing the numbers from that file rather than refreshing them. The harness is
extended by almost every item in this register, so any hand-maintained count is
stale again within a wave. Counts are now stated to be dynamic and to be derived
from the harness itself — `--anchors`, `--expects`, or the counting method
already used against the file. Do not reintroduce a prose count anywhere,
including here.)*

**Completion criteria.** Every factual claim traced to a measurement or an
assertion; the two inconsistencies above resolved in their own files; any newly
stated count pinned by the packaging suite so it cannot rot silently; **and the
*Planned next* link to this register survives the rewrite** — it is one of the
two entry points that make this file discoverable (see the note at the top), so
a rewrite that drops it re-opens the gap that was closed on 2026-09-02.

### `fullrun` — the complete revert harness from a clean tree · PENDING · blocks `w2-release`

Run every record in `scripts/prove-table-fixes.js` end to end from a clean tree.
This takes hours, which is why it is a scheduled item rather than a routine step.
It is nonetheless a **release blocker**: the milestone gate requires the complete
harness, and a release that skipped it has not been proven at all.

**Preconditions that make the result meaningful:** a clean working tree, no
Electron process running, and **no review diff generated while it runs** — the
harness mutates repository files, so a diff taken mid-run contains reverted code
and reads exactly like a real finding.

**Completion criteria.** Every record either PROVEN or explained; no
`SETUP-FAILED` (a rotted anchor never reports a pass, but it also never reports
a proof).

### `shots` — regenerate and *look at* every theme screenshot · PENDING · blocks `w2-release`

Regenerate the theme screenshots across all six schemes and inspect them.

**Capturing a PNG is not verification.** The repository rule is explicit:
*verify by viewing, not by capturing*. An unlooked-at screenshot is another
vacuous green.

**This is regenerate-and-view, not capture-only, and it is a release blocker.**
The scope is every visual surface the wave touched — the six theme schemes, and
any other rendered surface a landed item changed. Each regenerated image is
opened and looked at by the reviewer before the item is closed; an image that was
produced but not viewed does not count toward it.

**Completion criteria.** Every scheme and every wave-touched visual surface
regenerated **and visually confirmed by a human or reviewing agent that actually
opened the image**; the golden re-captured only if a deliberate change requires
it.

### `final-cleanup` — clean the tree before release · PENDING · blocks `w2-release`

Remove probe scripts and scratch output, normalise files (CRLF — the working tree
is CRLF and hand-written files are the usual offender), and run the complete
test and revert chain, then push.

**Staging discipline:** stage named files. Never `git add -A` or `git add .` —
the root directory carries untracked scratch output, and a bulk add can abort on
`core.safecrlf` while the `commit` after it still succeeds, producing a commit
that looks ordinary and contains a fraction of the change.

**Completion criteria.** `git status` shows nothing unintended; `--anchors`
resolves; the full chain is green; pushed.

### `user-verify` — verification against the real workflow · BLOCKED on `final-cleanup`

Final verification by the maintainer against the real multi-file Copilot
workflow — the actual use case Folia exists to serve. This is last on purpose:
it is only meaningful against a clean, released-shaped tree.

**Completion criteria.** The maintainer confirms the workflow behaves correctly,
or files what does not.

---

## Dependencies and order

Explicit dependencies:

| Item | Waits on | Why |
|---|---|---|
| `w2-f03` | `w2-sec08` | Sender validation defends a frame, not an attacker who already owns a Node-privileged renderer. Ordering it first would be defence that measures nothing. |
| `w2-upstream` | `upstream-toolbar-overflow` | That fix is in the same upstream-derived surface; classifying the backlog first means classifying against a moving target. |
| `w2-release` | `w2-f22`, `w2-hygiene`, `w2-privacy`, `w2-sec08`, `w2-upstream`, **`fullrun`, `shots`, `final-cleanup`** (+ `w2-ci`, `w2-docs`, `w2-f23`, `w2-f25`, all **done**) | The milestone ships once, not per fix. The last three are verification prerequisites, not courtesies: the milestone gates require the **complete** revert harness, **viewed** screenshots and a clean tree, so a release without them is a release that skipped its own gates. |
| `user-verify` | `final-cleanup` | Verifying a dirty tree verifies nothing that will ship. It runs after `final-cleanup` and may be returned either side of the release cut, as the maintainer's own verification. |
| `diagnostic-log-hardening` | `w2-privacy` (practical, not blocking) | The opt-in switch has to exist before there is a gated file to harden. It is DEFERRED rather than BLOCKED: it is scheduled after wave 2 by the 2026-09-02 decision, not prevented by anything. |

Everything else is independent and may be taken in any order.

**`diagnostic-log-hardening` is deliberately absent from `w2-release`'s row.** It
is **not** a wave-2 release blocker. If that ever changes, it is added to
`w2-release`'s "Waits on" cell above and nowhere else.

**`fullrun`, `shots` and `final-cleanup` are blockers, corrected 2026-09-03.**
They were previously listed here as *strongly recommended, not blocking*, with
the note that releasing without them was "a maintainer call, not a protocol
violation". That was **wrong and is withdrawn**: it contradicted the milestone
gates in *Completion criteria* and *Parallel delivery*, which require the full
13-suite run **and the complete revert harness** at a milestone boundary, and
require visual changes to be verified by screenshots that are actually viewed. A
document cannot mandate a gate in one section and make it optional in another.
**No release may bypass the full suite, the complete revert harness, the tree
cleanup, or the required viewed screenshots.**

**Suggested order**, given the above:

1. **`w2-f22`** — active; finish it.
2. **`w2-sec08`** — the long pole, and an **exclusive** stream: while it holds
   `src/`, no other source work runs (see *Parallel delivery without reducing
   quality*). Only docs-scoped work proceeds alongside it.
3. **`w2-f03`** — immediately after SEC-08, while the bridge is fresh.
4. **`w2-privacy`, `w2-hygiene`, `w2-kbscroll`** — small, independent, no gates.
5. **`upstream-toolbar-overflow` → `w2-upstream`** — in that order.
6. **Mermaid trio** (`mermaid-cold-cache-source`, `mermaid-block-identity`,
   `perf-mermaid-sweep`) — one surface, best done together.
7. **`table-breakout-perf`** — the largest remaining perf win; independent of
   everything above.
8. **Gated items** (`n2-user`, `n16-insert-anchor`, `perf-node-count`,
   Azure signing) — as decisions arrive.
9. **`readme-story`, `sign-provenance` (free half), `rv4-nth`** — any time.
10. **`shots` → `fullrun` → `final-cleanup` → `w2-release` → `user-verify`** —
    the closing sequence. All three of `shots`, `fullrun` and `final-cleanup` are
    **blockers** of `w2-release`; `fullrun` and `final-cleanup` both want a quiet
    tree, and `fullrun` must not overlap any edit in its worktree. `user-verify`
    is the maintainer's own pass and follows `final-cleanup`; it is the one item
    in this sequence that is not a release blocker.
11. **`diagnostic-log-hardening`** — **after** `w2-release`. Deferred out of
    wave 2 on 2026-09-02; it ships in a later stage, not this milestone.

---

## Decision gates

Work that **stops** until the maintainer decides. Everything not listed here
proceeds autonomously.

| Gate | Item | The decision |
|---|---|---|
| Zoom anchoring | `n2-user` | Should `Ctrl`+wheel zoom anchor on the pointer instead of the pane centre? Preference, not defect. |
| Insertion-anchor scope | `n16-insert-anchor` | Narrow fix at the mismatching call sites, or a general source↔DOM position map? The general version is a render-pipeline change. |
| Prism simplification threshold | `perf-node-count` | At what document/block size does Prism stop fully tokenising? Trades syntax fidelity for speed. **Only the threshold is gated** — the measurement and evaluation proceed autonomously. |
| Paid code signing | `sign-provenance` | Purchase Azure Artifact Signing? **Only the paid half is gated** — free GitHub attestations proceed without asking. |
| Upstream feature additions | `w2-upstream` | Any upstream commit classified as a *feature* needs a call, because the fork's direction is deliberately leaner. Bug and security fixes are taken autonomously. |

### Explicitly autonomous

No decision needed; these proceed without asking: `w2-f22` and all six of its
subtasks, `w2-sec08`, `w2-f03`, `w2-privacy`, `w2-hygiene`, `w2-kbscroll`,
`w2-release`, `mermaid-cold-cache-source`, `mermaid-block-identity`,
`perf-mermaid-sweep`, `table-breakout-perf`, `upstream-toolbar-overflow`,
`rv4-nth`, `readme-story`, `fullrun`, `shots`, `final-cleanup`,
`diagnostic-log-hardening` (deferred, but ungated — no decision is outstanding on
it), the free-attestation half of `sign-provenance`, the measurement and
evaluation half of `perf-node-count`, and the *classification* work in
`w2-upstream` (only the feature calls are gated).

The three partially gated items — `sign-provenance`, `perf-node-count`,
`w2-upstream` — are each split above so that the ungated half is never held up
waiting for the gated one.

`user-verify` is not gated — it is maintainer work by definition.

### Maintainer decisions on record

Decisions already taken. Recorded here so a later reader sees the reasoning and
the cost, and so a decision is not silently re-opened by someone who only reads
the item entry.

| Date | Decision | Consequence |
|---|---|---|
| **2026-09-02** | **Make this register discoverable from the repository's documented entry points.** The tracker it mirrors does not survive a session, so a register nothing links to is one lost session away from being invisible. | `.github/copilot-instructions.md` lists `docs/PLANNED-WORK.md` among the load-bearing documents and adds a startup rule: read it before selecting or starting work; treat its IDs, status, dependencies, decision gates, performance gates and parallel-worktree process as authoritative; update it at every status transition and after every merge; only the integration owner writes it. `README.md`'s *Planned next* links here as the live roadmap instead of restating a subset of it. Both pointers are now load-bearing: renaming or moving this file must update them in the same commit, and `readme-story` carries a criterion that the link survives the README rewrite. |
| **2026-09-02** | **`w2-f22`'s close-path measurement is unconditional.** The gate applies to any change touching IPC or DOM traversal, and this item adds a shutdown IPC round trip and an all-tab dirty scan; it is benchmarked, not argued. | A first measurement was taken the same day: `bench/bench-f22-shutdown.js`, Electron 43.4.1 / Node 24.18.1, two runs; worst p95 **3.09 ms** at 25 tabs, once per shutdown. There is no "before" figure because the approval path did not previously exist. **Superseded in part on 2026-09-03:** that run is initial characterization, not a passed gate — one fixture, no before-path, and no budget declared in advance. `w2-f22` is **ACTIVE** and the final gate is pending. |
| **2026-09-02** | **Narrow `w2-privacy` to "off by default", and defer diagnostic-log hardening.** Because the diagnostic file will not be created in packaged/release builds by default, rotation, size/count retention and detailed sanitising need not ship inside the release-blocking item. | `w2-privacy` stays a wave-2 release blocker with minimal, tested scope. Rotation, retention, path/`argv` redaction, safe structured updater-error fields, and the detailed opt-in documentation/tests/reverts move to the new `diagnostic-log-hardening` item, PENDING · DEFERRED and explicitly **not** a wave-2 blocker. **Accepted tradeoff, not an eliminated risk:** a user who sets `FOLIA_DIAGNOSTIC_LOG=1` still gets the unhardened file, which records paths and `argv` and writes updater `err.message` verbatim — and that message can carry response metadata. Documentation must tell users to enable diagnostics only temporarily until hardening lands. |
| **2026-09-02** | **Fix the model for each role, and make code review three independent reviews rather than two.** GPT-5.6 Sol at high reasoning effort implements product change; GPT-5.6 Terra owns tests, benchmark, screenshot and revert-harness automation; GPT-5.6 Sol, GPT-5.6 Terra and GPT-5.6 Luna review independently in fresh contexts; Claude Opus 5 explores and researches, and no longer owns product implementation. | These assignments apply **going forward** and **supersede every earlier *current-process* model assignment in this register** — the `w2-f22` `code-review` and `design-review` subtasks, the per-stream quality loop, the completion criteria and *Process controls* are all restated accordingly. Explicitly historical records of who did what keep their names and are labelled historical rather than rewritten. The full procedure — the deterministic handoff order, how it composes with the isolated-worktree and file-ownership rules, and who owns which evidence — is in *Model roles and the delivery handoff*. **Accepted cost, not an eliminated one:** a third reviewer plus a mandatory re-review after every material correction adds a round to each unit, and because the agent that produced the work cannot review it, each unit now needs more separate fresh contexts than before. **What it buys:** the reviewer that finds a defect is never the agent that wrote it, and a fix is never blessed by the round that demanded it. **No item status changes because of this decision** — nothing here closes or advances an item, and `w2-f22` remains **ACTIVE** with its review still outstanding. |
| **2026-09-03** | **Corrections from the first three-reviewer gate, applied to the process documents.** The gate ran fresh, independent reviews by GPT-5.6 Sol, GPT-5.6 Terra and GPT-5.6 Luna over this register and `.github/copilot-instructions.md`. Five findings were accepted. | **Sol (HIGH):** `fullrun` was declared non-blocking while the milestone gates demanded the complete revert harness — a self-contradiction. `fullrun` is now a `w2-release` prerequisite. **Luna (HIGH), same area, independently:** `shots` and `final-cleanup` conflicted with the milestone and visual-verification rules for the same reason; both are now prerequisites too, and `shots` must be **regenerated and viewed**, not captured. **Luna (HIGH):** `w2-f22` could not be called a performance-gate pass — one fixture, no before-path, no budget declared in advance; downgraded to initial characterization with the final gate pending, and GPT-5.6 Terra owes a predeclared UX budget and a wider fixture matrix before the final run. **Terra (MEDIUM):** the instructions still said *"commit directly to `main`"*, contradicting the isolated-worktree and serialized-integration process; replaced. **Luna (MEDIUM):** the instructions hardcoded harness counts that had already rotted; the numbers were removed rather than refreshed, and counts are now derived from the harness. **Where they differed:** each HIGH came from a different reviewer, and only the `fullrun`/`shots`/`final-cleanup` contradiction was found by two independently — evidence that the three-reviewer gate is doing work a two-reviewer one did not. No reviewer contradicted another; nothing was rejected. **These corrections are documentation only** and have not themselves been through a review round — the follow-up three-reviewer pass has not run. |
| **2026-09-04** | **Two review findings about the portable updater's temp-file surface are rejected as out of scope, not as wrong.** Both are real properties of the design; neither is introduced by this work, and both would need a different mechanism rather than a bigger check. | **Rejected — "the acknowledgement token is readable by another same-user process".** True: it is embedded in `update.bat` inside a `mkdtemp` directory, and `mode: 0o600` does nothing to Windows ACLs, so any process running as the same user can read it and forge an `ack`. The token is what the review round asked for and it does what it can — it makes a *stale* or *blind* marker useless and raises a forgery from "guess the directory name" to "read the directory". It cannot defend against a same-user process, and neither can anything else here: that process can already replace `update.bat` before it runs, replace the downloaded installer, or kill the app. A genuine fix is an OS-protected channel (a named pipe with an ACL, or a helper process), which is a design change, not a hardening tweak. **Residual risk, accepted and recorded:** a same-user local process can make Folia quit without an installer having started. It cannot make it quit with unsaved work, because the commit re-asks whenever the document has moved. **Rejected — "`%` in an interpolated path is expanded by `cmd.exe`".** Also true, also pre-existing: `downloadedUpdatePath` and the batch directory have been interpolated into this script since SEC-20. Nothing in this round widened it, and the `if not exist "<installer>" goto failed` line added here makes the failure mode *observable and fail-closed* where it used to be a silent no-install. A real fix means not building a batch file at all. |
| **2026-09-04** | **Two implementation decisions taken while fixing the `w2-f22` review findings.** No sealed finding was rejected — all ten were valid — but both of these changed something a reader could reasonably expect to have been left alone, so they are recorded rather than absorbed. | **The portable spawn handler no longer cancels merely because another question is open.** The old guard was `if (pendingShutdown \|\| !isSameShutdownDocumentSession(...))`. The commit now raises its own force-fresh approval, and `requestShutdown` already **queues** a force-fresh intent behind an open question and re-raises it on settle — which is what the installed updater's public commit does, and what *"an updater commit arriving behind another question remains a required fresh question"* already asserts. Cancelling would make the portable path the only one that silently drops a stronger intent. The document-session half of the guard is kept, and the acknowledgement boundary re-checks both. **Cost, not an eliminated risk:** a portable child can now sit parked while an unrelated close question is on screen. It is bounded — the queued intent either runs or is declined, and a decline stands the child down through the new `onDeclined` channel. **R560's id is repurposed, not reused.** Its mutation (`return attempt.committed` → `return false`) is provably inert: `attempt.committed` is true only when the commit fired synchronously, and that path has already revoked the authorization and raised a fresh request, so both return values leave identical state. The record keeps its id and its subject — authorization across the installed updater's deferred-commit gap — and gains a mutation that can actually fail, plus a new assertion written for it. Deleting it and allocating a fresh id instead would have left a silent gap where a record used to be. |
| **2026-09-05** | **`w2-f22`'s performance gate is CLOSED, and the 2026-09-02 and 2026-09-03 rows above are superseded on that point only.** Neither is rewritten: their reasoning is why the closed gate can be trusted, and the numbers they recorded were never in dispute. | The 2026-09-02 row recorded a first measurement and the 2026-09-03 row correctly refused to call it a pass — one fixture, no before-path, no budget declared in advance. **Two of those three are now closed** (a 50 KB / 500 KB / 2 MB × 1 / 10 / 25 tab matrix plus all-dirty LF and CRLF worst cases at 2 MB × 25 tabs; a **16.7 ms** raw-p95 budget fixed *before* the runs it judged). **The third cannot be closed and is not claimed to be:** the approval path did not previously exist, so there is no before-number, which is exactly why a predeclared budget carries the verdict. Three runs, each executed exactly once: run 1 **failed honestly** at **22.4936 ms (LF)** and **98.1947 ms (CRLF)** and drove the maintained-dirty-state architecture; runs 2 and 3 passed every observation with 0 failures. **Run 1 is retained as a result, not a discarded outlier** — recording only the passing runs would hide the reason they pass. Full method and runs are in `bench/BASELINE.md`; the defect and fix are `docs/PERF-AUDIT.md` PERF-10. **Run 2's raw samples were not persisted** (the durable-output path did not yet exist); run 3's attestation artifact is machine-local and deliberately uncommitted. **No item status changes because of this decision:** `w2-f22` stays **ACTIVE**, is **not landed and not merged**, and still owes the final three-reviewer round over the executed state and serialised integration. |

---

## Model roles and the delivery handoff

**Maintainer decision, 2026-09-02 — mandatory.** These role assignments apply
**going forward** and supersede every earlier *current-process* model assignment
in this register. Where a passage is explicitly historical — a record of what a
particular round or commit already did — it keeps the names it had and is
labelled historical; it is not a description of how work is delivered now.

### The roles

| Role | Model | What the role owns |
|---|---|---|
| **Product coding and implementation** | **GPT-5.6 Sol** — `gpt-5.6-sol` | Reasoning effort **high**, always. Product source and any behavioural change to shipped code. |
| **Tests and automations** | **GPT-5.6 Terra** — `gpt-5.6-terra` | Test design and implementation, benchmark automation, screenshot-capture automation, revert-harness records in `scripts/prove-table-fixes.js`, and orchestration of the proofs. |
| **Code review** | **GPT-5.6 Sol** — `gpt-5.6-sol`, **GPT-5.6 Terra** — `gpt-5.6-terra`, and **GPT-5.6 Luna** — `gpt-5.6-luna` | Three *independent* reviews, each in a **fresh context**, read-only. Agreements and disagreements are both surfaced. |
| **Exploration and research** | **Claude Opus 5** — `claude-opus-5` | Maps architecture, history and risk, and supplies the evidence a change is planned against. It does **not** own product implementation under this process. |

**Independence is structural, not nominal.** The Sol agent that wrote the code is
**not** the independent Sol reviewer, and the Terra agent that wrote the tests is
**not** the independent Terra reviewer. An agent that has already committed to a
change cannot find its own blind spot — that is the entire reason there are
three. Each review starts from a fresh context and the diff, not from the
conversation that produced them.

**Blocking findings return to the role owner, not to whoever found them.**
Product defects go back to Sol at high reasoning effort; test, benchmark,
screenshot and revert-harness defects go back to Terra. **A product fix that a
Terra test exposed is still Sol's work.** After any material correction the
three-reviewer gate **repeats** — a fix is not blessed by the round that demanded
it. Stop when a round produces no new blocking findings.

### The handoff sequence

Deterministic, and in this order for every behavioural unit:

1. **Opus 5 — exploration.** Architecture, history, risk, and the evidence the
   change will be judged against. Read-only; no product edits.
2. **Sol at high reasoning effort — the product change.** Only the files the
   stream owns.
3. **Terra — tests, automation and evidence.** The targeted suite, the
   revert-harness records, the benchmark and screenshot automation, and the
   recorded results.
4. **Independent review — Sol, Terra and Luna**, three fresh contexts. These may
   run at once, because review is read-only.
5. **Corrections by the role owner** — product to Sol at high reasoning effort,
   tests and automation to Terra.
6. **Repeat step 4** after any material correction, until a round produces no new
   blocking findings.
7. **Serialised integration** — one stream merges at a time, per *Integration is
   serialised*.

**Where an item carries its own pre-implementation design review** — `w2-f22`'s
`design-review` subtask is the only current example — that review sits **between
steps 1 and 2**, runs with the same three independent reviewers, and
**supplements rather than replaces** the review at step 4. Reviewing a state
machine before it is built and reviewing the code that implements it are two
different questions.

### How this composes with the isolated-worktree model

The role split changes **who** performs a step. It relaxes nothing in *Parallel
delivery without reducing quality*.

- **One behavioural unit is edited by exactly one role owner at a time.** Sol and
  Terra never hold the same file concurrently, and never edit the same
  behavioural unit concurrently. If a product fix and its test live in the same
  file, they are sequential steps, not parallel ones.
- **Research and test *design* may run in parallel with an edit** — but only
  while they stay read-only and touch nothing the editing owner holds. Reading
  and designing compose safely; writing does not.
- **Test *automation* must not run a mutation harness while an edit is in flight
  in the worktree that harness will mutate.** `scripts/prove-table-fixes.js`
  rewrites the working tree of the worktree it runs in, so Terra runs it when
  nobody is editing that worktree — never alongside an edit there, and never two
  harnesses at once anywhere on the machine.
- **Screenshots, performance measurement and the full harness remain
  machine-exclusive** across all worktrees, exactly as *Machine-level
  exclusivity* states. Three reviewers do not make a shared machine safe.
- **The per-unit gates stand unchanged**: the targeted suite, individually proven
  revert records, screenshots actually *viewed*, the performance acceptance
  gates, a clean diff, and the milestone-boundary full suite and full revert
  harness.

### Evidence ownership

| Evidence | Owner | What that owner is accountable for |
|---|---|---|
| Commands, results and sample counts | **Terra** | Recording the exact command, the machine and runtime versions, the sample count and the p50/p95 — and building automation that reproduces them. A result nobody else can re-run is not evidence. |
| Product behaviour and performance correctness | **Sol** | That the change does what this register says it does, and that the numbers Terra recorded actually clear the *Performance acceptance gates* rather than merely existing. |
| Non-vacuity of the evidence, and the claims made about it | **The three reviewers** | That each test can fail, that each revert is proven individually with `expect` *and* `mustPass`, that screenshots were viewed rather than captured, and that every claim in the diff and the commit message is supported. Assume a new green result is vacuous until shown otherwise. |
| This register | **The integration owner** | Updating `docs/PLANNED-WORK.md` at **every** transition — role handoff, review round, material correction, status change and merge — under the single-writer protocol in *Process controls*. |

---

## Completion criteria

Per-item criteria are stated with each entry. These apply to **every** item:

1. **A fix without a revert is not finished.** Each fix gets a record in
   `scripts/prove-table-fixes.js` that undoes it, with `expect` (assertions that
   must fail) and `mustPass` (assertions that must keep passing, so a revert that
   fails everything cannot be mistaken for a detection).
2. **Every scenario proves its own setup** before asserting the interesting
   thing, and negative cases are exact — *which* assertions failed, not how many.
3. **`node scripts/prove-table-fixes.js --anchors` after any rename, move or
   reformat.** Anchor rot is the one failure this project cannot detect by
   testing; it reports `SETUP-FAILED` rather than a false pass, but only when it
   is actually run.
4. **Three-reviewer independent review** — GPT-5.6 Sol (`gpt-5.6-sol`), GPT-5.6
   Terra (`gpt-5.6-terra`) and GPT-5.6 Luna (`gpt-5.6-luna`), each in a fresh
   context, agreements and disagreements both surfaced. Two to three rounds is
   the usual shape, not a cap: blocking findings return to the role owner and
   the full round repeats after any material correction. Stop when a round
   produces no new blocking findings. See *Model roles and the delivery
   handoff*.
5. **Measurements are recorded** in `docs/PERF-AUDIT.md` or `bench/BASELINE.md`
   with the method, not just the result — including measurements that came out
   negative.
6. **The relevant audit document is updated**: `docs/SECURITY-AUDIT.md` for any
   SEC finding, `docs/CUSTOMIZATIONS.md` for anything that changes the fork's
   divergence from upstream.
7. **No lint suppressions, no new tooling** to make something pass.
8. **The performance acceptance gates below are met** for any change touching
   startup, rendering, file I/O, tab switching, IPC, or DOM traversal —
   including security changes, which get no exemption.

### Wave-2 exit criteria

`w2-release` requires **all** of the following. None of them is optional, and
none is a maintainer's discretionary call:

1. **Full `npm test` green from a clean tree** — all 13 suites, not a subset.
2. **`PACKAGING_STRICT=1 npm run test:packaging` green.** Without the flag, a run
   that built nothing reports "0 failed" having verified nothing.
3. **`fullrun` complete** — the *complete* revert harness from a clean tree,
   every record PROVEN or explained, no `SETUP-FAILED`.
4. **`shots` complete** — every screenshot for the wave's visual surfaces
   **regenerated and viewed**. Capturing is not verifying.
5. **`final-cleanup` complete** — clean tree, `--anchors` resolving, chain green,
   pushed.

`user-verify` is **not** a release blocker: it is the maintainer's own
verification against the real workflow, runs after `final-cleanup`, and may be
returned either side of the release cut.

**Corrected 2026-09-03.** This section previously listed items 3–5 as *"strongly
recommended, not blocking"* and said releasing without them was "a maintainer
call, not a protocol violation". That contradicted the milestone gates stated
above and in *Parallel delivery*, and is withdrawn.

---

## Performance acceptance gates

**Mandatory for every product and security change in this register.** These sit
alongside the completion criteria above, not instead of them.

### The rule

**No security change is accepted on reasoning alone when it touches startup,
rendering, file I/O, tab switching, IPC, or DOM traversal.** "It is only a
validation check", "it is just a preload", "this cannot be hot" are all
predictions, and this repository's standing rule is *measure; do not reason from
the code* — a rule that exists because measurement has repeatedly contradicted
the obvious reading (bytes were a **12.9×**-wrong proxy for render cost; `lines`,
the obvious replacement, scored **26.9×**, worse than what it replaced). Security
work gets no exemption from that. A change in the six areas above ships with
numbers or it does not ship.

### What every such change must produce

1. **Before and after, on representative fixtures.** Not a synthetic microbench.
   Use the corpus and the audit fixtures that already exist — `plain50k`,
   `plain500k`, `plain2m`, `code10`, `code200`, `mermaid5`, `mermaid20`, and the
   `tables` / `wide` bench profiles — so the numbers are comparable to everything
   already recorded.
2. **Repeated samples, reported honestly.** Where a measurement is noisy or
   user-perceived, report **p50 and p95** (or median-of-N with the spread) rather
   than a single run. The bench already refuses `--reps=2` on the grounds that *a
   median needs at least 3 samples*; hold hand-run measurements to the same
   standard.
3. **A stated regression budget, fixed before the measurement is taken.** Decide
   what counts as acceptable *first*, then measure. Deciding afterwards is how a
   regression becomes "within noise".
4. **The result recorded in the tracker and in the permanent document** —
   `docs/PERF-AUDIT.md` or `bench/BASELINE.md`, with the method, the machine and
   the runtime version, not just the number. **Negative and neutral results are
   recorded too**; "we measured and it did not move" is a finding.
5. **Like-for-like comparison.** Same machine, same Electron version, same
   profile state, no other suite or harness running. A before/after taken across
   two machines or two Electron versions is not a comparison.

### Regressions are blockers

**A measured performance regression blocks the change** unless the maintainer
explicitly accepts it, and the acceptance is recorded here with the number and
the reason. A regression that is noticed and then absorbed silently is the
failure mode this gate exists to prevent.

### SEC-08 (`w2-sec08`) — the explicit benchmark set

SEC-08 is the change most likely to move these numbers, because it converts
**18** synchronous `fs`/`path`/`os` calls into asynchronous IPC round-trips,
several of which sit inside the render pipeline. It does not ship without the
following, measured before and after on the **same machine and the same Electron
version**:

| Measurement | Why it is in the set |
|---|---|
| **Cold startup** and **first paint** | The preload, the bridge and the module loader all execute before anything is drawn. |
| **Open + reload at 50 KB / 500 KB / 2 MB** | The three scales the existing fixtures already cover, so the numbers join the existing series. Reload is included because `reload-file` is the fork's core loop. |
| **Tab switching at 10 and 25 open tabs** | `switchToTab()` is where the render cost actually lands — tabs render lazily, so a guard on the read path saves nothing and a regression here is felt immediately. |
| **Save and open round-trips** | These are exactly the `fs` calls that become async. |
| **IPC latency and bytes per call** | The bridge replaces 70 direct call sites; both the added latency and any serialisation growth need a number. |
| **Renderer long tasks** | The user-visible symptom of a pipeline whose ordering changed. Count and duration. |

The audit already names where a regression would hide: several of the converted
call sites *"sit inside the render pipeline whose ordering invariants are exactly
what PERF-04/05/06 and the mermaid race work were about"*. That is the sentence
this benchmark set exists to answer.

### Style-heavy fixtures: benchmark CSS normalisation

The sanitizer no longer hand-tokenises CSS. It **delegates to Chromium**: a style
attribute is assigned to a detached element's `style.cssText` and read back, and
a `<style>` element's text goes through `new CSSStyleSheet()` + `replaceSync()`
(`docs/SECURITY-AUDIT.md`). That is correct — it is what closed the escaped-`url`
and SVG-`<style>` bypasses — but it is **per-attribute and per-element CSSOM work
on every sanitize**, and its cost has never been measured.

Any change touching the sanitizer, the style allowlist, or the theme system must
therefore be benchmarked on a **style-heavy fixture** — many inline `style`
attributes and multiple `<style>` blocks — which the current corpus does not
contain. Building that fixture is part of the first such change.

### What is already measured, and what is not

Do not let the two be confused. The distinction matters because an existing
number is a baseline to defend, while an absent one is work to do.

| Claim | Status |
|---|---|
| `DOMPurify.sanitize` costs **4.9 ms** on the `mermaid20` fixture (225 KB, 20 diagrams) for a **changed render** after a one-line text edit | **Measured** — `docs/PERF-AUDIT.md`, PERF-04, alongside `renderMarkdownFull()` **93.9 ms**, `marked.parse` **7.8 ms**, `patchViewerDOM` **8.0 ms**, `mermaid.run` **0 calls**. |
| The cost of CSSOM-based CSS normalisation on style-heavy documents | **Not measured.** No style-heavy fixture exists. |
| The cost of an `ipcMain` handler, with or without sender validation | **Partially measured, and now recorded.** `bench/bench-f22-shutdown.js` records a bare IPC round trip at **p50 0.165–0.177 ms / p95 0.21–0.30 ms** (Electron 43.4.1, two runs) — a useful floor, but it is *round-trip* cost on one channel with a trivial payload, not per-handler cost and not the cost of adding sender validation. **Those two remain unmeasured.** What has since been measured and written down is the whole F22 close path, including its IPC round trip, across 50 KB / 500 KB / 2 MB × 1 / 10 / 25 tabs: `bench/BASELINE.md`, *The F22 shutdown-approval gate*, and `docs/PERF-AUDIT.md` PERF-10. |
| The cost of the `debug.log` write stream | **Not measured.** |
| Any steady-state cost of `contextIsolation` on the main window | **Not measured.** The popups run isolated with no recorded consequence, but an absence of a record is not a measurement, and a popup workload would not predict the main window's. |

Quoting the 4.9 ms figure for anything other than that fixture, that render path
and that edit is a misattribution.

## Parallel delivery without reducing quality

Parallelism here is a **file-ownership** problem, not a scheduling problem. The
constraint that decides everything: `scripts/prove-table-fixes.js` **mutates the
working tree of the worktree it runs in**, so any edit made while it runs is
made against reverted source. The repository already records the consequence —
*never generate a review diff while the revert harness is running; it will
contain reverted code you did not write, and it reads exactly like a real
finding.* Two streams sharing one working tree cannot both be trusted.

### Topology

- **One git worktree per independent stream**, each on its own branch.
- **The main worktree is integration-only.** No stream develops in it. It is
  where branches land, one at a time, and where milestone-boundary runs happen.
- **Each worktree is fully isolated at runtime:** its own Electron `userData`
  path, its own dev profile, its own temp directory prefix, and its own ports if
  anything binds one. The repository already treats shared profile state as a
  defect class — it produced a suite that hung with zero assertions until
  `test/test-userdata-isolation.js` made isolation structural, and that was the
  *fourth* instance of suites measuring inherited session state. Sharing a
  profile across worktrees would reintroduce it at a new level.

### The hard rule

> **No two concurrent streams may modify the same product, test, or harness
> file.** Not "coordinate carefully" — not at all. If two candidate streams both
> need `src/renderer.js`, they are not parallel; they are sequential.

Broad-surface work **serialises**: `w2-sec08` and `w2-f03` (they rewrite the
renderer's entire boundary), any renderer architecture change, and `w2-release`.
While one of those holds the renderer, nothing else touches it.

### File-ownership matrix

Ownership is exclusive for the duration of a stream. `scripts/prove-table-fixes.js`
is the contended file in almost every row — every stream adds records to it —
which is why the sequencing below matters more than it first appears.

| Stream | Owns exclusively | Must not touch |
|---|---|---|
| **A — F22 shutdown** | `src/main.js`, `src/custom-tabs.js`, `test/test-tab-refresh.js`, `test/test-render-security.js`, `scripts/prove-table-fixes.js`, `bench/bench-f22-shutdown.js` | `src/renderer.js` beyond what the protocol strictly needs |
| **B — docs / provenance / upstream research** | `README.md`, `.github/workflows/*`, and the narrative documents no other stream is recording into | `src/`, and `test/` except the two pinning assertions named below |
| **C — SEC-08 then F03** | `src/renderer.js`, `src/main.js`, `src/index.html`, a new preload, every Electron suite's renderer access, `scripts/prove-table-fixes.js` | nothing else may run concurrently against `src/` |
| **D — Mermaid** | the Mermaid regions of `src/renderer.js`, `test/test-mermaid-render.js`, `test/test-render-patch.js` | `src/main.js`; cannot overlap C at all |
| **E — UI keyboard / menu** | `src/custom-styles.css`, `src/styles.css`, the menu/keyboard regions of `src/renderer.js` | anything C or D holds |
| **F — Performance** | `bench/*`, the specific pass under optimisation | any file another stream holds |

Note what the matrix makes obvious: **C and D and E all want `src/renderer.js`**.
Only one of them can be live. Be conservative wherever `src/renderer.js`,
`src/main.js` or `scripts/prove-table-fixes.js` overlap — the cost of guessing
wrong is a silently corrupted diff, which is expensive to detect and worse to
review.

**The record documents are append-scoped, not owned.** Every stream writes its
own findings into `docs/SECURITY-AUDIT.md`, `docs/PERF-AUDIT.md`,
`bench/BASELINE.md` and `docs/CUSTOMIZATIONS.md` — completion criteria 5 and 6
and the performance gates require it, and SEC-08 cannot be closed otherwise.
Those four files are therefore excluded from Stream B's exclusivity, and
`bench/BASELINE.md` is excluded from Stream F's: F owns the harness *code* under
`bench/`, not the recorded results. Streams append to disjoint sections and never
rewrite another stream's entry.

**`docs/PLANNED-WORK.md` has exactly one writer** — the integration owner, per
*Process controls*. Streams report status transitions to that owner rather than
editing this file themselves.

### Suggested streams and order, from the current queue

**Now, in parallel:**

- **Stream A — `w2-f22`, the critical shutdown work.** Already active. It owns
  `src/main.js`, `src/custom-tabs.js`, `test/test-tab-refresh.js`,
  `test/test-render-security.js`, `scripts/prove-table-fixes.js` and
  `bench/bench-f22-shutdown.js` today. Finish
  it before anything else claims those files.
- **Stream B — documentation, provenance and upstream research.** Touches no
  product source: `readme-story` and the free-attestation half of
  `sign-provenance`. Its one `test/` exception is `test/test-packaging.js`, and
  only to add the two pinning assertions those items require — the count
  `readme-story` states, and the assertion that the workflow still emits free
  attestations — and only while no other stream holds that file. Every other
  `test/` file is out of bounds. B may also do *preparatory* reading of the 16
  outstanding upstream commits: building the list and its context, not recording
  verdicts. The classification itself is `w2-upstream`, which stays BLOCKED on
  `upstream-toolbar-overflow` precisely so it is not done against a moving
  target; feature additions found during that reading still go through their
  decision gate. Safe to run alongside A because their file sets are disjoint.

**After A lands:**

- **Stream C — `w2-sec08`, then `w2-f03`, as one exclusive broad security
  stream.** These are not parallelisable with each other or with anything else
  that touches `src/`. Path validation lands inside SEC-08; sender/frame
  validation follows in F03. Expect this to be long — it is the five-step
  sequence the audit fixed, and it carries the full benchmark set above.
- **Stream D — Mermaid**, in its own renderer worktree, **only while it does not
  conflict with C**. Serial within the stream:
  `mermaid-cold-cache-source` → `mermaid-block-identity` → `perf-mermaid-sweep`.
  Each depends on the identity model the previous one establishes. If C is live
  in `src/renderer.js`, D waits — do not attempt region-level sharing of that
  file.
- **Stream E — UI keyboard and menu work:** `w2-kbscroll` and
  `upstream-toolbar-overflow`. Mostly CSS and event handling, largely disjoint
  from C's boundary work, but it still touches `src/renderer.js` — so it yields
  to C.
- **Stream F — performance:** `table-breakout-perf` first, as the largest
  measured remaining cost. `perf-node-count`'s **measurement and evaluation are
  autonomous and may start here** — the bench has to derive a candidate
  threshold before the maintainer can decide anything; only *adopting* a
  threshold and acting on it waits on the gate. `n16-insert-anchor` is gated on
  scope and design and does not start until the maintainer decides — starting it
  before that is speculative work that may be discarded.

`w2-hygiene`, `w2-privacy` and `rv4-nth` are small and can be slotted into
whichever stream owns the files they touch, rather than being given streams of
their own. `w2-privacy` in particular is now a narrow `src/main.js` change, so it
belongs to whichever stream holds that file. `w2-release`, `fullrun`, `shots`,
`final-cleanup` and `user-verify` are the closing sequence and run in the
integration worktree with nothing else in flight.
`diagnostic-log-hardening` sits **after** that sequence entirely: it is deferred
out of wave 2, and it takes `src/main.js` when no other stream holds it.

### Quality gates are per stream, not per milestone

Parallelism must not dilute any of this. **Every stream runs the full loop for
every unit of work it takes on:**

1. **Baseline** — measurements and a green targeted suite *before* touching
   anything, so the after-number has something to compare against. This is
   Terra's execution and it runs against unmodified source, alongside Opus 5's
   exploration and Terra's read-only test *design*. No product edit and no new
   test or harness record exists yet at this point.
2. **Scoped implementation by Sol at high reasoning effort** — only the files
   the stream owns.
3. **Targeted suite, written by Terra** — the narrowest suite that covers the
   changed behaviour.
4. **Isolated revert proofs, recorded by Terra** — each fix gets a record with
   `expect` and `mustPass`; each is proven individually, not as a batch.
5. **Independent review in three fresh contexts** — GPT-5.6 Sol, GPT-5.6 Terra
   and GPT-5.6 Luna, none of them the agent that produced the work under review.
6. **Reviewer feedback returned to the role owner** — product to Sol at high
   reasoning effort, tests and automation to Terra — for validation and
   correction, with agreements and disagreements both surfaced. Re-run the three
   reviews after any material correction. Stop when a round produces no new
   blocking findings.
7. **Performance comparison** against the stream's own baseline, per the gates
   above.
8. **Screenshots regenerated and actually viewed** for any visual change.
   Capturing a PNG is not verification.
9. **A clean diff** — reviewed, nothing unrelated, nothing swept in.
10. **One commit**, message stating the problem rather than the patch.

### Integration is serialised

- **One stream merges at a time.** Cherry-pick or merge into the integration
  worktree, never two at once.
- **After each merge, re-run the impacted cross-suites** — not just the stream's
  own targeted suite. A stream that was green in isolation can break a suite it
  never ran.
- **The full 13-suite `npm test` and the complete revert harness run at milestone
  boundaries only.** The full chain is ~11 minutes and the full harness takes
  hours; running them after every merge would stop the pipeline without adding
  information that the impacted cross-suites do not already give.
- **Run `--anchors` after every merge.** It is ~1 second and it is the only thing
  that detects anchor rot, which is the one failure this project cannot detect by
  testing. Merges reformat and move code; that is exactly the damage class.

### Machine-level exclusivity

Worktree isolation is not sufficient for everything. These take an **exclusive
machine lock, across all worktrees**:

- **The revert harness.** It mutates its worktree's files. Never run it
  concurrently with edits *in that worktree*, and never run two harnesses at
  once — they are CPU-saturating and the timings become meaningless.
- **Screenshot and focus-sensitive Electron suites.** They depend on window
  focus and compositor state, which are machine-global. A second Electron window
  appearing mid-capture produces a wrong screenshot, not a failure.
- **Any performance measurement.** A benchmark sharing a machine with a test run
  is not a measurement.

Kill stray Electron processes before every run — a leftover instance holds files
and produces confusing failures.

## Process controls

**Historical incident these controls exist to prevent a repeat of:** a single
opaque agent run once went five hours without a reportable status. The failure
was not the duration; it was that nothing was observable while it happened and
nothing was recoverable when it stopped.

1. **Split work into bounded behavioural units.** A unit is one behaviour that
   can be described, implemented, tested and reverted on its own. `w2-f22`'s six
   subtasks are the model. If a unit cannot be stated in a sentence, it is not
   bounded yet.
2. **Emit a checkpoint after every phase** — design, implementation, test,
   revert, review. Each checkpoint states what was done, what was verified, what
   is uncommitted, and what is next. A phase that produces no checkpoint is
   indistinguishable from a phase that produced nothing.
3. **Stop and report the exact blocker; do not explore open-endedly.** When
   something is genuinely undecidable — a gate, a contradiction in the evidence,
   a missing measurement — report it precisely and stop. Hours of speculative
   exploration are how a run becomes opaque.
4. **One editing owner per unit; every reviewer is read-only.** The role owner
   edits — Sol for product, Terra for tests and automation — and the three
   reviewers only read and report. Two agents editing the same unit produce
   interleaved changes that neither can account for, and that is as true of two
   role owners as it is of two reviewers.
5. **Parallelise research, review and test design early** — those are read-only
   and compose safely, which is why the three independent reviews run at once.
   **Never parallelise editing within a unit**, and never run a mutation harness
   while an edit is in flight in the worktree that harness will mutate.
6. **The integration owner updates this register** after every merge, every role
   handoff, every review round, every material correction and every status
   transition. One writer for this file avoids the merge conflicts that a shared
   tracking document otherwise guarantees — and a tracker that conflicts is a
   tracker people stop updating.

## Expected performance impact of the security work


Stated **only where the repository has evidence.** No estimate appears here that
is not traceable to a measurement or an enumeration already in the tree. These
are *expectations to be tested by the gates above*, not results — none of them
substitutes for a before/after measurement.

| Item | Classification | Evidence |
|---|---|---|
| `w2-sec08` | **Credible, noticeable interaction risk. Requires the full benchmark set above; magnitude unmeasured.** This is the one item here where a user-perceptible regression is genuinely plausible. | `docs/SECURITY-AUDIT.md` (SEC-08 deferred section) enumerates **18** synchronous `fs`/`path`/`os` call sites that become asynchronous IPC round-trips, and states that several *"sit inside the render pipeline whose ordering invariants are exactly what PERF-04/05/06 and the mermaid race work were about. This is where regressions would hide."* |
| `w2-sec08`, steady-state cost of the flags themselves | **Not classified.** | The four popups already run `nodeIntegration: false, contextIsolation: true` behind preloads, and no performance consequence is recorded for them — but an *absence* of a record is not a measurement, and a popup workload would not predict the main window's anyway. No number is offered. |
| `w2-f03` sender/frame checks, and the existing navigation guards | **Expected negligible** — a constant-time comparison on an already-asynchronous message boundary. Still measured, because it is on the IPC path, which the gate names. | No IPC handler timing exists in `docs/PERF-AUDIT.md` or `bench/BASELINE.md`. The expectation is stated as an expectation, not a result. |
| `w2-privacy` logging fix | **Expected neutral to slightly faster** in packaged builds, because the default path stops opening a stream and stops writing to disk. With the scope narrowed on 2026-09-02 this is the whole of the item — no rotation accounting is added here. | `src/main.js` writes to an append-only `debug.log` stream on every `log()` call in packaged builds. No logging measurement exists anywhere in the repository. |
| `diagnostic-log-hardening` | **Expected confined to the opt-in path.** Rotation adds per-write size accounting and periodic rename/truncate; redaction adds per-call string work. Both are unmeasured, and neither runs in a default packaged build, where no file is opened at all. | The default-off behaviour is established by `w2-privacy`; this item only changes what happens once `FOLIA_DIAGNOSTIC_LOG=1` is set. |
| `sign-provenance` (free attestations) | **No runtime cost — CI-only.** Attestations are produced by the release workflow and change nothing the user executes. | The work is confined to `.github/workflows/release.yml`. |
| `w2-f22` | **Close-time only. Measured against a predeclared budget; gate CLOSED.** The work runs on shutdown paths — window close, `Ctrl+Q`, quit, update install — and does not touch the render or open path. It adds a shutdown IPC round trip and an all-tab dirty scan, which the gates name explicitly, so it is benchmarked rather than argued. The gate found a real defect and refused it: the first run reached **22.4936 ms (LF)** and **98.1947 ms (CRLF)** at 25 tabs × 2 MB with every tab edited, against a **16.7 ms** budget fixed beforehand. With the dirty answer maintained at the edit instead of recomputed at the close, the same observations are **1.002 ms** and **1.2792 ms**, and every observation clears the budget across two subsequent runs with 0 failures. | `bench/BASELINE.md`, *The F22 shutdown-approval gate* — method and all three runs; `docs/PERF-AUDIT.md` PERF-10 — the defect and the fix. Matrix 50 KB / 500 KB / 2 MB × 1 / 10 / 25 tabs; bounded to ≤25 tabs and ≤2 MB per tab. The earlier one-fixture characterization (worst p95 3.09 ms, worst sample 3.78 ms) is kept as history in group A and is superseded. |
| CSS normalisation (any sanitizer/theme change) | **Secondary, unmeasured risk.** Per-attribute and per-element CSSOM work on every sanitize; no style-heavy fixture exists to measure it with. | `docs/SECURITY-AUDIT.md` — `style.cssText` round-trip and `new CSSStyleSheet()` + `replaceSync()`. See *Style-heavy fixtures: benchmark CSS normalisation* above. |
| `w2-hygiene` | **Not classified.** | Dead-code removal has no measured effect recorded here. Payload reductions elsewhere in the fork were measured individually; this item has not been. |

The one number this repository *does* have for the security direction is the CSP
work: every directive in the main-window CSP was chosen by a runtime probe that
reported what stopped working (`docs/SECURITY-AUDIT.md`, SEC-09) — a method to
copy for SEC-08, not a performance figure.

---

## Completed recently

Short and pruned deliberately; the permanent record for each of these is in the
audit documents and the commit history.

| Item | Commit | What landed |
|---|---|---|
| F43 follow-up | **`db7b960`** — *Harden Mermaid edit sessions and F43 regression coverage* | Removed fallback source reconstruction; Mermaid edits now **fail closed** on ambiguous or stale state; navigation and placeholder probes made exact and hermetic. Touched `src/renderer.js`, `test/test-mermaid-render.js`, `test/test-render-patch.js`, `test/test-render-security.js`, `scripts/prove-table-fixes.js` (+1,857 / −136). The two open Mermaid **correctness** items in group C (`mermaid-cold-cache-source`, `mermaid-block-identity`) are the remainder of this surface; `perf-mermaid-sweep` is a separate performance question in the same code. |
| F43 / N18 | `1132fc7` | Hardened block-placeholder assembly (per-render nonce tokens, so a decoy placeholder in a code span cannot capture the real diagram) and restored the Mermaid source attribute. |
| `w2-ci`, `w2-docs`, `w2-f23`, `w2-f25` | various, through `a80c813` | The wave-2 checkpoint: security, hygiene, CI and payload work. All four are `w2-release` prerequisites and are **done**. |
| Release 0.4.0 | `eae1429` | The release the register's remaining work builds on top of. Check `package.json` for the version actually on `main`. |

---

## Open work tracked elsewhere

Work that is documented as open in the tree but has **no tracker ID**, and is
therefore not one of the 24 items above. It is listed so the register's boundary
is explicit rather than implicit. Give any of these an ID and promote it to a
group above if it is picked up.

| Work | Where it is recorded | Status there |
|---|---|---|
| The partial-reuse removal path — many removals *with* some reuse — is unmeasured and likely still quadratic; the 5 MB leg remains super-linear, and the render-cost guard covers it rather than a fix. | `docs/PERF-AUDIT.md`, "Still open". It was also the first bullet of `README.md`'s old *Planned next* list, which now links here instead — so this document is the only place it is still visible outside the audit. | Open, unmeasured. |

## Where the permanent detail lives

This register is intentionally thin on background. When an entry above is not
enough:

| Document | What it holds |
|---|---|
| `docs/SECURITY-AUDIT.md` | Every SEC finding, its evidence, its fix, and its deliberate deferrals. |
| `docs/PERF-AUDIT.md` | The PERF findings, the measurement methodology, and the fixtures. |
| `bench/BASELINE.md` | Every benchmark measurement with the method used to get it. |
| `docs/CUSTOMIZATIONS.md` | What the fork changed and why, so an upstream merge cannot silently undo it. |
| `.github/copilot-instructions.md` | How work is done here: the mandatory model-role assignment in summary, test discipline, the traps, the conventions. |
| `docs/BUILD.md`, `docs/RELEASE.md` | Build, signing and release procedure. |
