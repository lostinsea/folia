# Folia render benchmark - recorded baseline

This file is the reference result for the fixed corpus in `bench/`. It exists
so that a performance claim can be checked rather than remembered: the numbers
below were produced by `npm run bench` against the exact corpus pinned in
`bench/manifest.json`, whose SHA-256 hashes `npm run test:corpus` verifies on
every test run. A future run that disagrees with this table is comparing the
same six documents at the same three sizes, not a fresh set of samples.

## How to compare against it

    npm run bench

**The milliseconds are only comparable within one machine fingerprint.** The
fingerprint block is printed with every run precisely so this is checkable
instead of assumed - a different CPU, a different Electron or a different
viewport makes the absolute figures meaningless. What survives a change of
machine is the **ratio** column: each size doubles, so a linear pass reports
~2.0 and a quadratic one ~4.0. That column is how the two O(n^2) passes in this
pipeline were found, and it is why three sizes are measured rather than one.

**Read the spread before trusting a ratio.** A ratio is a quotient of two cells,
and it is no more trustworthy than the run-to-run variation of those cells. The
harness now **enforces** this rather than leaving it to the reader: a cell whose
spread exceeds **both 15% and 50 ms** is marked with a `?` and the whole run
exits non-zero, so a contaminated run cannot quietly be recorded as a result.
That guard was added after a run on a busy machine reported tables@1MB at 40%
while the same cell re-measured in isolation came back at 1.3% - two runs that
were indistinguishable in the output and only one of which meant anything.

Both halves of the test are load-bearing, and both were measured rather than
chosen. Relative alone rejects prose@512KB, whose 20% is 33 ms of ordinary
scheduler jitter on a 163 ms cell; a live run with the floor removed produced
25% on a 21 ms spread. Absolute alone rejects four cells of a perfectly clean
run - tables@512 (58 ms), tables@1024 (115 ms), code@1024 (110 ms) and
lists@1024 (56 ms) - because a few percent of a 2.9 s cell is tens of
milliseconds. The contaminated run, by contrast, showed 1268 ms and 793 ms. The
clean and contaminated populations do not overlap on either axis, so any cut
inside those gaps is equivalent.

## How much difference is a difference

Measured, not estimated: three clean full runs on the same machine, minutes
apart, with nothing changed between them.

* **Absolute milliseconds drift by up to 11.6% between clean runs.** The worst
  cells were headings@512 (576-643 ms), code@512 (1287-1418) and code@1024
  (2636-2889); the best were prose@256 (82-85) and tables@1024 (2861-2987).
  So a single cell moving 10% against this table is **not** a finding. Ambient
  machine state moves it that much on its own.
* **The doubling ratios are far steadier**, which is the whole reason the table
  reports them: 0.5% drift on tables@512 and code@1024, 1.4% on dense, 2.6% on
  tables@1024. The noisiest ratios - headings@512 at 7.9%, prose@512 at 5.8% -
  are all on the small, fast cells, where a few milliseconds of jitter is a
  large fraction of the quotient.

The practical reading: **treat the ratio column as the result and the
milliseconds as context.** A ratio that moves from ~2.0 to ~4.0 is a quadratic
regression and is unmissable at this noise level. A 10% change in absolute ms is
inside the noise of the machine, and a 10% change that appears in *every* cell
at once is almost certainly ambient rather than a code change.

Note that this cross-run drift is larger than the within-run spread the harness
rejects on (15%/50 ms). That is not a contradiction: the spread guard asks
whether the repetitions of ONE cell agreed well enough for its median to mean
anything, which is a different and stricter question than whether two runs taken
half an hour apart agree.

## What this baseline deliberately does NOT measure

This is a **steady-state** benchmark. Each cell renders from an empty viewer,
after an explicit garbage collection and after two discarded warm-up renders at
the largest size in the run. That is what makes the numbers reproducible, and it
is also a stated limit on what they mean:

* The **first** large file opened in a fresh process is genuinely slower than
  this table says, because it pays for JIT and for V8 growing its heap toward
  the working set. Measured before the warm-up was made representative,
  ``marked.parse`` on tables@1MB cost 2443ms and then 3780ms on the first two
  repetitions against a steady-state 210ms.
* Opening a **second** large file back-to-back is also genuinely slower, because
  the previous document's garbage is collected inside the next parse rather than
  before it. Measured: the same ``marked.parse`` swinging between 181ms and
  1932ms on a byte-identical input.

Both effects are real costs a user can experience, and both are excluded here on
purpose: mixing them into the baseline is what produced a 170% run-to-run spread
and made the size-doubling ratios - the entire point of the table - unreadable.
If chained-open or cold-start cost is what needs measuring, that is a separate
mode, not a different reading of this one.

## Why the harness looks the way it does

Four separate harness defects were found and fixed before this table was
trustworthy, each one producing plausible numbers while measuring the wrong
thing:

1. **Inherited DOM.** Without a reset, each profile's smallest document was
   billed the teardown of the previous profile's 1 MB document. Worse, it also
   changed which code path ran: `detectRenderMode()` only returns `full`
   when the previous content is empty, so almost every cell was measuring the
   incremental light-format path rather than the open-a-file path.
2. **The promise is not the finish line.** `renderMarkdown()` resolves before
   syntax highlighting, which `renderer.js` defers behind
   `requestIdleCallback(..., { timeout: 1000 })`. Measured: code@256KB
   resolved with 4,866 nodes and had 65,691 a hundred milliseconds later. Both
   `render` and `settle` are therefore reported.
3. **A quiet window shorter than the deferral deadline lies.** An 80 ms window
   declared dense@1MB settled at 38,740 nodes against a real ~57,000. The
   window is now 1500 ms, derived from the product's own 1000 ms guarantee.
4. **Inherited HEAP.** With everything above fixed, tables@1MB still swung 170%.
   Instrumenting every phase showed `marked.parse` alone moving between 181 ms
   and 1932 ms on a byte-identical input string while every other phase stayed
   flat - the previous document's garbage being collected inside the next
   parse, plus V8 growing its heap towards the working set. The reset now
   collects explicitly (outside the timed region) and the warm-up runs twice at
   the largest size being measured. Spread fell from 170% to 2%.
5. **A wrap that silently does nothing reads exactly like a phase that costs
   nothing.** `parseEmojis` sat in the instrumentation list reporting no phase
   at all, because `renderer.js` imports it with a destructured `require()` -
   a module binding, not a `window` property, so it was never wrappable and the
   wrap had been a no-op from the day it was written. The wrapper now records
   every name it could not wrap and aborts. Replacing it with
   `highlightNewElements` immediately showed why the axis matters: Prism is
   **1160 ms of the code profile's 2156 ms of deferred work at 1 MB**, i.e. the
   single largest phase in the whole corpus, and it had been invisible.
6. **"Wrapped" is a weaker claim than "called".** The abort in (5) only proves a
   name resolved to a function. A later refactor could move the real work into a
   private helper and leave the old global alive but unused - the wrap installs,
   the abort passes, and the phase reports a flat 0 ms, which is the same silent
   zero arrived at from the other direction. Every wrapped phase must therefore
   also be *observed firing* during the warm-up, which renders `dense` precisely
   because it is the only profile containing every construct. Proven by wrapping
   `window.scrollBy`, a real function the render path never calls: it passes the
   resolve-time abort and is caught by the fired check.

## What stops the corpus from silently becoming something else

`bench/manifest.json` pins bytes, SHA-256, block counts and token counts - but a
manifest can be regenerated, so on its own it only detects an *accidental*
change. `npm run test:corpus` therefore also asserts six axes that are
hard-coded in `bench/verify.js` and cannot be regenerated:

1. **SHAPE** - the exact set of top-level token types and their exact
   proportions. The tolerance is `1e-9`, i.e. float noise only, because
   `generate()` tests the byte target only *between whole builder iterations*:
   every profile's token total is an exact multiple of its per-iteration mix
   (dense emits exactly 7 tokens per iteration at any size, headings 2), so the
   shares are exact rationals rather than approximations. Measured exact to six
   decimal places at both reference sizes. A loose tolerance here is room for a
   builder change to move a profile's composition without failing anything.
2. **INTERNALS** - that constructs are not degenerate (tables really have 4
   header cells and 5 rows, lists 2 items, code 2 lines).
3. **ELEMENTS** - the rendered element mix per top-level token. The benchmark
   times DOM work, and the token stream does not describe the DOM.
4. **TEXTURE** - words and characters per block, and the rule that the corpus
   carries no inline markup at all (every `<code>` element must come from a
   fenced block).
5. **ATTRIBUTES** - the rendered attribute mix per top-level token. Four
   profiles emit no attributes at all; `code` and `dense` emit only
   `class="language-js"`.
6. **TEXT SHAPE** - what the text inside those extents is actually *made of*:
   an exhaustive character-class histogram per token (letters, digits, spaces
   and newlines grouped; every other character pinned individually), and the
   run-length distribution (the mean of each block's longest unbroken non-space
   run, plus the longest in the document). Pinned per reference size, because
   digit counts genuinely move with document length - the generator writes the
   iteration index into the text, so prose carries 7.27 digits per block at
   64 KB and 10.89 at 1 MB.

**Axes 3, 5 and 6 are exhaustive, and that is the design.** All three count what the
render actually emits and treat *anything not explicitly pinned* as a failure,
rather than tallying a whitelist. The whitelist version was broken by both
reviewers independently, the same way: an element absent from the list is never
counted, so it can be asserted neither present nor absent. Adding a construct to
the corpus is now a deliberate act that has to be recorded.

Two omissions of my own were found the moment each axis was made exhaustive:
`thead`/`tbody` were unpinned, and then `<code>` inside `<pre>` was never
counted at all - the code profile's most characteristic element.

Each axis exists because a reviewer broke the previous set. All of the following
mutations regenerate the manifest cleanly and were caught only by the axis
named:

| mutation | caught by |
|---|---|
| one prose paragraph appended after every table (shares become exactly 0.500) | SHAPE |
| tables collapsed to a single row | INTERNALS |
| the ordered-list half of the lists builder removed | INTERNALS + TEXTURE |
| prose paragraphs filled with inline code, emphasis and links | TEXTURE |
| prose paragraphs collapsed to one word | TEXTURE |
| table cell text shortened without changing its word count | TEXTURE (chars) |
| a hard line break added to every prose paragraph (`<br>`) | ELEMENTS (exhaustive) |
| the code fence language changed from `js` to `py` | ATTRIBUTES |
| three table-cell words fused into one and a fourth split to compensate | TEXT SHAPE (runs) |
| the code fence's string literal rewritten as a template literal | TEXT SHAPE (histogram) |

The cell-shortening one is why texture is pinned in characters as well as words:
shortening `value-3` to `v` leaves the word count identical and passed a
words-only version of the axis at full marks.

The fence-language one is worth keeping because the two reviewers **disagreed
about why it mattered**, which forced a measurement. One held that the bundled
Prism ships no `python` grammar, so highlighting would drop to zero; the other
measured Prism token spans falling from 172,872 to 144,060 on the 1 MB code
corpus. Loading `libs/prismjs/prism-bundle.js` in a VM and listing the real
grammars settled it: the bundle **does** ship `python`, `sh`, `bash`, `java`,
`cpp`, `cs` and `ts` - its own header comments under-list what is in it - so the
second reviewer was right. Prism is the single largest deferred phase in the
corpus (1160 ms of the code profile's 2156 ms at 1 MB), so a ~25% swing in the
tokens it produces is a material change to what is being benchmarked.

### The corpus must be parsed the way the app parses

`bench/corpus.js` never calls `marked.setOptions` (it must not mutate a parser
other code shares) and marked applies per-call options *instead of* the globals,
so every option `renderer.js` sets has to be repeated in `RENDER_OPTIONS`.
`verify.js` parses `renderer.js`'s own `setOptions` block and asserts the two
sets match exactly, failing loud if the block is missing or holds a value it
cannot parse. Without that, `RENDER_OPTIONS` is a hard-coded copy of another
file's setting: correct the day it is written, silently wrong afterwards.

Measured: the full option set renders byte-identically to `breaks` alone across
all six profiles and on an autolink/email probe, so `mangle` and `headerIds` are
inert in this marked 9 build. They are pinned anyway, because "inert today" is
exactly the state `breaks` was in before a builder change would have activated
it - and the 9 -> 18 upgrade is where this will stop being inert.

### Regenerating the manifest is gated

`bench/write-manifest.js` reads the file back after writing it (bytes plus a
JSON round trip) and then runs `verify.js` against the result, refusing to leave
behind a manifest its own consumer rejects. A rejected regeneration restores the
previous manifest - or deletes the candidate if there was no previous one -
because a manifest on disk is taken by the runner as the pinned corpus.

A deliberate corpus change is *meant* to fail this gate. The correct response is
to re-derive the failing pins by measuring the new corpus (the numbers appear in
the failure messages) and record the change here, never to widen a tolerance.
The pins are derived from `corpus.js` directly, so they can be re-measured
without the new manifest being in place.

### Text inside a pinned extent was not itself pinned

Both reviewers broke the five-axis set independently, without coordinating, and
arrived at **the same class through different instances**: axes 1-3 and 5
describe structure and axis 4 describes *how much* text sits in it, but nothing
described what that text is or how it is distributed. That agreement on a class
is the strongest signal this process produces, and it is why axis 6 counts
exhaustively rather than adding two more pins.

The two instances are worth keeping because **neither half of the axis catches
the other's**:

* **Word fusion.** Fuse three table-cell words into one and split a fourth to
  compensate. Character count, word count *and space count* are all preserved
  exactly, so axis 4 is structurally blind to it - measured end to end against
  the real `write-manifest.js`, the regenerated manifest was accepted and
  **141/141 assertions passed**. What moves is the longest unbroken run in the
  cell, 9 -> 22, which is a direct input to `measureTextColumnCap()` and
  `applyTableBreakout()` - between 345 and 1524 ms of the tables profile. The
  mutation quietly re-benchmarks the one pass this application exists to get
  right. Caught by the run-length half; the histogram half does not move at all.
* **Template literal.** Change the code fence's `'...'` to `` `...` ``.
  Identical character count, word count and run lengths, so every other axis
  including the run-length half is blind - but it changes what Prism has to
  tokenise, and Prism is 1160 ms of the code profile's 2156 ms at 1 MB, the
  largest deferred phase in the corpus. Caught by the histogram half alone.

Each was applied to the real corpus and measured. The fusion failed only the
four `wraps where it is pinned to` assertions; the template literal failed only
the four `made of the pinned characters` assertions, one of which fired the
`is pinned but no longer occurs` branch - so both directions of the
exhaustiveness check are demonstrated live rather than argued. In both cases
`write-manifest.js` **refused to regenerate** and left the manifest byte
identical, which is the end-to-end claim: these mutations can no longer be
laundered through a regeneration.

### A narrow parser must refuse, not skip

`countAttributes()` recognises double-quoted attribute values only, which is
what marked emits today. That narrowing is deliberate - the pins are literal
strings containing those quotes, so widening the parser to normalise `class='x'`
into `class="x"` would silently re-interpret pinned values instead of reporting
that the renderer's output moved.

The hazard is that a narrow parser fails *silently*: a tag carrying a
single-quoted or unquoted value does not match at all, so the whole tag drops
out of the tally and its attributes read as absent. A new attribute arriving in
an unreadable quoting style would be invisible - the same whitelist disease
that has already cost this suite `thead`/`tbody`, `<br>`, `<code>` and unpinned
text content. So every tag a permissive scan can see must also have been
consumed by the strict one, and a shortfall is a named failure telling the
reader to re-derive the pins.

That refusal carries a **positive control**, because every assertion in the axis
reads "nothing unreadable was found" as good news - and that is also what a
parser which has stopped looking returns. Two lines assert that a single-quoted
tag *is* reported and a double-quoted one is not.

### One run at a time

Two concurrent `npm run bench` invocations share `bench-results.txt`: the
loser's `INCOMPLETE` marker lands on the winner's finished table, or the
winner's `STATUS: OK` lands while the loser is still measuring, so the file
reads as a completed run describing numbers that are still moving. Concurrency
also invalidates the numbers themselves - two Electron instances competing for
CPU is exactly the noise the ratios exist to see through. A pid-stamped lock is
taken before the invalidating write, so a run already in progress is left
entirely alone, including its report.

A **stale lock is expected, not exceptional**: the operating procedure here is
to force-kill leftover Electron processes between runs, so a lock whose owner no
longer exists is the normal aftermath of an interruption. A live holder is
refused; a dead one is taken over and said so.

**`process.on("exit")` does not work in this process, and the first version of
this lock relied on it.** Measured with a throwaway Electron app rather than
assumed: Electron *replaces* `process.exit` with a non-native function that
emits neither `exit` nor `beforeExit`. The handler read as a safety net and
protected nothing - a run refused on a typo left its own lock behind, so the
next run announced a stale takeover. Releasing at each call site was rejected as
the fix: argument validation alone has six early exits, and adding an early exit
without noticing what it bypassed is precisely the bug the ordering fix above
exists to correct. The exit is wrapped instead, so the class is closed.

### A crashed run must not leave a passing report

`bench-results.txt` is written by `finish()`, so any crash *before* it left the
previous run's file untouched, reading `STATUS: OK` with a full table of
plausible numbers. This is not hypothetical: a TDZ `ReferenceError` introduced
by adding one line to the fingerprint block left an 84-minute-old report on
disk claiming success, and because the rejection was unhandled the process
**hung** rather than exiting, so there was not even a non-zero exit code to
contradict it. The file is now overwritten with `STATUS: INCOMPLETE` before any
measurement, and an unhandled rejection writes `STATUS: FAILED` and exits.
Same disease as the screenshot harness leaving a stale PNG in place: a stale
artifact is indistinguishable from a fresh one.

Three further holes in that guard were found by *attacking it* rather than
reading it, and all three were confirmed by measurement:

* **The invalidating write can itself fail, and then it reopens the hole it
  closes.** With `bench-results.txt` held open by another process
  (`FileShare.None`), `writeFileSync` throws `EBUSY`, the process dies, and the
  previous run's `STATUS: OK` survives untouched. The one write whose entire job
  is to stop a stale report being believed was, unguarded, the likeliest way to
  leave one. It now refuses loudly and says the file on disk is unsafe to read.
* **`uncaughtException` was not handled, only `unhandledRejection`** - and the
  settle watchdog is a `setTimeout`, so a synchronous throw there missed the
  handler entirely. The predicted consequence was a clean non-zero exit; the
  measured one was worse. A throwaway Electron app throwing inside a timer was
  **still alive twelve seconds later with three processes running** - the same
  hang as the unhandled rejection, so not even an exit code would contradict a
  stale report.
* **Every `exit(2)` on a bad argument ran *before* the invalidating write**, so
  a mistyped `--sizes` left the previous run's `STATUS: OK` in place. This file
  had made that worse by adding two more early exits while fixing something
  else. The whole reporting block now sits above argument parsing: invalidate
  first, validate second.

Argument validation was hardened in the same pass, because the same bug class
was sitting in two neighbours of a function already fixed once:
`Math.max(1, parseInt(x, 10) || 3)` silently turned `--reps=0`, `--reps=abc` and
`--reps=0.15oops` into 3, and `--sizes=1024,abc,2048` silently dropped the
middle entry. Both now refuse rather than guess. **Fixing one member and leaving
the class is the recurring disease here** - the same sitting also guarded
`write-manifest.js`'s *write* while leaving its *read* unguarded.

That read is worth recording, because the obvious fix is a data-loss bug.
Catching the read error and leaving `previous = null` tells the rollback there
was no previous manifest, and its no-previous branch **deletes** the candidate -
so a transient read failure would end with the real, approved manifest gone.
"Cannot read it" and "does not exist" are different facts and must not collapse
into one null. It is a hard stop instead: never begin an operation that cannot
be rolled back.


## Baseline
```text
Folia render benchmark

machine fingerprint (numbers are only comparable within one fingerprint)
  cpu        AMD EPYC 7763 64-Core Processor                 x32
  memory     128 GB
  platform   win32 x64 10.0.26200
  electron   43.2.0  chrome 150.0.7871.129  node 24.18.0
  viewport   1990x1071
  marked     loaded, version not exposed
  corpus     manifest verified (6 profiles)
  when       2026-08-10T21:46:30.590Z

median of 3 run(s) per cell, each from an empty viewer
rejecting any cell whose spread exceeds 15% AND 50ms

profile       KB   render   settle  spread  ratio    nodes  nd/KB  breakout/patch ms
--------------------------------------------------------------------------------------------
prose        256       76       85     10%      -      753   2.9   0 / 5
prose        512      136      165      4%   1.94     1507   2.9   0 / 11
prose       1024      261      312      2%   1.89     2994   2.9   0 / 22
headings     256      263      320      3%      -     4845  18.9   0 / 28
headings     512      579      643      4%   2.01     9663  18.9   0 / 52
headings    1024     1111     1231      2%   1.91    19278  18.8   1 / 93
tables       256      589      807      4%      -    18685  72.9   376 / 37
tables       512     1219     1551      1%   1.92    37222  72.7   802 / 82
tables      1024     2426     2987      3%   1.93    73667  71.9   1540 / 157
lists        256      297      338      4%      -     8694  34.0   0 / 17
lists        512      625      713      4%   2.11    17361  33.9   1 / 35
lists       1024     1278     1454      2%   2.04    34695  33.9   1 / 67
code         256      161      701      1%      -    65691 256.5   1 / 20
code         512      306     1418      3%   2.02   130221 254.3   1 / 38
code        1024      639     2889      1%   2.04   259308 253.2   3 / 106
dense        256      370      551      5%      -    14399  56.2   220 / 25
dense        513      727     1131      5%   2.05    28721  56.0   442 / 49
dense       1025     1652     2390      1%   2.11    57365  56.0   1052 / 101

render = time until renderMarkdown() resolves: time to READABLE content.
settle = time until the last DOM mutation: TOTAL work, including the syntax
         highlighting that renderer.js defers behind requestIdleCallback.
         A `!` means the 30s settle cap was hit and the figure is a floor.
ratio  = this size's settle / the previous size's settle, same profile.
         Each size doubles, so ~2.0 is linear and ~4.0 is quadratic. This is
         the figure that survives a change of machine; the ms do not.
spread = (max - min) / median across the repetitions. A ratio is only as
         trustworthy as the spread of the two cells it was computed from.
         A trailing `?` means the spread exceeded 15% AND 50ms and the
         run is REJECTED: those numbers describe the machine, not the code.
nd/KB  = DOM nodes per KB of markdown - the shape factor that made one
         removal defect measure 23.7s on a dense document and 571ms on prose.
         A trailing `~` means the repetitions disagreed on the finished node
         count by more than 2%, i.e. they were not measuring one document and
         the timing beside it should not be trusted.
```

## Repeat run (confirmation, NOT a new baseline)

The baseline above stays the reference. This run is the same tree measured again
after the axis work, and is recorded to show what an unchanged codebase looks
like when it is measured twice - which is the only way to read the drift figures
in "How much difference is a difference" as something other than an assertion.

Run `2026-08-10T23:37:10Z`, same machine and fingerprint, viewport 1988x1070
(the baseline's was 1990x1071 - the window is pinned by the harness, and the 2px
is chrome rounding, not a layout difference).

| profile | 256 KB | 512 KB | 1024 KB | ratios |
|---|---|---|---|---|
| prose | 80 | 161 | 294 | 2.01 / 1.83 |
| headings | 292 | 604 | 1143 | 2.07 / 1.89 |
| tables | 766 | 1448 | 2876 | 1.89 / 1.99 |
| lists | 320 | 664 | 1360 | 2.07 / 2.05 |
| code | 638 | 1292 | 2631 | 2.03 / 2.04 |
| dense | 522 | 1026 | 2181 | 1.97 / 2.12 |

Every cell is 5-9% faster than the baseline and every ratio is in 1.83-2.12. No
cell was rejected on spread. **This is not a speedup.** It is inside the 11.6%
cross-run drift already measured over three clean runs, and the ratios - the
figure that is supposed to survive noise - moved by at most 0.07. Read together
with the baseline it says the corpus and harness changes did not move what is
being measured, which is the claim that actually needed evidence.

Node counts are byte-identical to the baseline in all 18 cells. That is the
strongest single check here: the corpus and the render pipeline both produced
exactly the same document twice, ninety minutes and one axis apart.
