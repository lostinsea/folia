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
change. `npm run test:corpus` therefore also asserts nine axes that are
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
7. **SYNTAX HIGHLIGHTING** - what Prism does with the fenced code blocks:
   an exhaustive tally of highlighted span types per top-level token, plus the
   fenced-block count and a requirement that every block found was actually
   highlighted. Measured against the same `libs/prismjs/prism-bundle.js` the
   application loads, run in this file's own VM. Profiles with no code are
   pinned as having none, so a profile that starts emitting code fails.
8. **BLOCK IDENTITY** - the blocks themselves, by sha256, for nine sampled
   top-level tokens per cell, plus the token count. Not a statistic: an
   exemplar. See "Aggregates discard information" below for why this exists
   alongside seven statistical axes rather than instead of them.
9. **CORPUS DIGEST** - sha256 of the entire generated text, hand-pinned, at
   **every size the benchmark reports**, not just the two reference sizes.
   Neither an aggregate nor a sample, so it has no complement to hide in.
   See "A projection always has a complement" below.

**Across all nine, every pin object must cover every profile the corpus
defines**, and the registry of pin objects is checked against `verify.js`'s own
source so a tenth axis cannot go unregistered. Without that, a new profile is
not *failed* by an axis - it is never visited by one. See "A third complement"
below.

**Axes 3, 5, 6 and 7 are exhaustive, and that is the design.** All four count what the
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
| the code fence's keywords uppercased (`const` -> `CONST`, `if` -> `IF`) | HIGHLIGHTING |
| the code fence's keywords replaced by same-length non-keywords (`const` -> `snect`) | HIGHLIGHTING |
| the table's Description and Default payloads exchanged | BLOCK IDENTITY |
| the same exchange, guarded to skip the nine sampled iterations | CORPUS DIGEST |
| every table description replaced by 50 identical chars at 256KB and 512KB only | CORPUS DIGEST |
| a seventh builder added, pinned by nothing | PROFILE COVERAGE |
| a canonicalising `corpus.sha256` paired with a table column swap | CORPUS DIGEST (only once it stopped sharing the subject's hash) |
| an unregistered tenth pin object, and a whitespace reformat that blinds the registry parse | PIN REGISTRY |
| `highlightNewElements()` short-circuited (1.9x "faster", two-thirds of the DOM gone) | RENDER CENSUS (`run.js`, not `verify.js`) |
| `markShortColumns()` short-circuited (no node, block or token count moves) | CLASS CENSUS (RENDER CENSUS silent) |
| a browser-only `Prism.hooks` transform renaming `keyword` -> `builtin` | CLASS CENSUS (`verify.js` passed 232/232 under it) |
| `QUIET_MS` shortened below the product's own idle deadline | REGIME INVARIANTS (before any cell is measured) |
| the shared settle loop settling after a fixed few ticks instead of on the quiet window | SETTLE-LOOP CONTROL |
| `applyTableBreakout()` gutted (372 ms -> 0 ms) | CLASS CENSUS, once the `wide` profile existed - see "The widening pass now has a corpus that exercises it". It was caught by **NOTHING** for the six profiles before it |
| the viewport-floor invariant disabled and the window shrunk to 988px | CLASS CENSUS (`"wrap-anyway": 293` where 0 is pinned) |
| a genuine quadratic injected into `applyTableBreakout` (phase 119 -> 468 ms) | NONLINEAR RATIO, **per phase**; the total settle ratio was 2.68 and passed |
| the deferred highlight pass invoked synchronously instead of on idle | TWO-STAGE CENSUS - every other axis is silent, because the same work still happens |

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

### Aggregates discard information, so an eighth statistic was the wrong answer

Axes 1-7 are all aggregates: proportions, counts, means, histograms, tallies. An
aggregate is a projection, and a projection necessarily throws information away.
Every review round found a mutation living in whatever the current set had
thrown away, and each was closed by adding one more statistic - which merely
moved the surviving dimension somewhere new.

**Round 6 is where that pattern became untenable, because two reviewers found
two DIFFERENT surviving breakers in the same round.** One exchanged the table's
Description and Default payloads. Every character, every word, every run length
and the whole character histogram are preserved, because the same text is still
present - it has only moved column. The corpus passed **180/180**, including the
brand-new highlighting axis, and `write-manifest.js` regenerated it cleanly with
exit 0. Both were reproduced here before being believed.

It matters for exactly the reason the corpus exists: the per-column maxima move
`[7,7,59,7] -> [7,7,7,59]`, which flips which column `markShortColumns()` marks
nowrap for every table in the corpus, changing the layout work the benchmark is
supposed to be holding constant.

So axis 8 pins the blocks themselves rather than another projection of them.
Nine sampled top-level tokens per cell are hashed with sha256. A hash discards
nothing about the block it covers, which closes every mutation that touches a
sampled block - **but a sample is itself a projection, and round 7 broke it with
a mutation guarded on the complement of the sample. See "A projection always has
a complement" below. The claim originally made here, that axis 8 closed the
class, was wrong, and both reviewers said so independently.**

**The seven statistical axes are NOT made redundant and must not be deleted as
though they were.** They are complementary in both directions:

- They cover **every** block weakly, where axis 8 covers nine exactly. A
  mutation confined to unsampled blocks is caught only by them.
- Their failures **name the dimension** that moved ("the keyword token is pinned
  but no longer occurs"), which is what tells whoever re-derives the pins what
  actually changed. A hash mismatch says only "different" - which is why the
  axis-8 failure prints the block text.

**A third breaker, found in the same review, is closed by the same change** and
was verified rather than assumed: fusing three table-cell words into one and
splitting a fourth to compensate preserves the character count *and* the word
count while growing the longest unbroken run 9 -> 22. It is caught twice over,
by axis 6's run lengths and by axis 8.

#### The sample is nine consecutive-plus-two indices, and the reason is aliasing

The first version sampled three blocks - first, middle, last. Against the
column-exchange breaker the `tables` profile failed correctly and **`dense` did
not**, because `dense` cycles seven builders and none of its three sampled
blocks happened to be a table. Measured, not predicted; it is the reason the
sample was widened at all.

The sample is now indices 0-6 (one full cycle, so every builder in every
profile) plus the middle and last block, so a mutation guarded on the iteration
index is not invisible *by accident*. With that, the `dense` legs fail at block 5
- the table in the cycle. **A mutation guarded on the iteration index
deliberately is a different matter, and axis 9 is what answers it.**

**Evenly spread indices would have been worse than the naive three**, which is
why the first seven are consecutive. Nine evenly spread indices over dense's 336
tokens land on 0, 42, 84 ... and 42 is a multiple of 7, so every sample would
have been the same builder: an axis that appears to cover nine blocks while
covering one, aliased against the very cycle it exists to sample. Consecutive
indices cannot alias with any cycle length.

The sampling function in `verify.js` must stay identical to the generator's,
because the pins are positional against it. A divergence would not fail loudly -
it would compare block 3 against block 5's hash and report a mutation that never
happened - so the axis additionally asserts that the number of sampled blocks
still equals the number of pinned hashes.

### A projection always has a complement

Axes 1-7 are aggregates, so they discard whatever the aggregate does not carry.
Axis 8 is a sample, so it discards every block it does not sample. Both are
projections, and **every projection has a complement a mutation can be guarded
on**. Six rounds of review were spent discovering, one at a time, which
complement was currently reachable.

**Round 7 is where that ended, because both reviewers independently produced the
same breaker** - the round-6 column exchange, guarded to fire only on iterations
axis 8 does not sample:

```js
if (i > 6 && i !== 64 && i !== 127 && i !== 995 && i !== 1990) { ...swap... }
```

Reproduced here before being believed: **193/193, and `write-manifest.js`
regenerated the manifest with exit 0**. It moves the per-column maxima on 1984 of
1991 tables, flipping which column `markShortColumns()` marks nowrap across
99.6% of the corpus - the same layout effect axis 8 was added to catch, simply
stepped around it.

**A sampling oracle cannot be repaired by changing the sample.** Both remedies
offered in review were rejected for the same reason:

- A *pseudo-random or seeded* sample is obscurity, not security. The pins are
  literals in `verify.js`, so anyone editing `corpus.js` can read exactly which
  indices are watched.
- Raising the sample from 9 to 32 raises the cost of enumerating the complement.
  It does not remove the complement.

Both are the same treadmill axis 8 was itself created to get off.

So axis 9 neither samples nor aggregates: it pins sha256 of the **entire
generated text**. There is nothing it does not cover, so there is no complement.
Every breaker found in seven rounds fails it, and so will every future one,
because a mutation that does not change the text does not change what is
measured.

**It is not a duplicate of `manifest.json`, although it is literally the same
number, and de-duplicating it would silently delete the whole defence.**
`manifest.json` is *regenerable* - `write-manifest.js` rebuilds it from whatever
`corpus.js` currently says - which is exactly why it only ever catches an
accident. Axis 9's pins are hand-held and regeneration cannot touch them. That
difference is the entire point, and it is why both exist.

**The statistical axes still earn their place.** A digest mismatch says only
"different"; it cannot say *what* moved, and what moved is precisely what tells
whoever is re-pinning whether the change was the one they intended. Axes 1-7
name the dimension, axis 8 prints the block, axis 9 guarantees that *something*
always fires. Detector and diagnosis are different jobs.

#### Two of the three reported sizes were verified by nothing at all

Closing the first complement surfaced a second that nobody had looked for in
seven rounds, including both reviewers. `run.js` measured and reported **256 KB,
512 KB and 1 MB**, while every oracle verified **64 KB and 1 MB**. The two lists
were unrelated - the benchmark's sizes were a string literal in its argument
defaults, `REFERENCE_SIZES` was a separate constant - so nothing noticed they
disagreed.

Measured, not reasoned: a mutation guarded on
`targetBytes === 262144 || targetBytes === 524288`, replacing every table
description with fifty identical characters, **passed all eight axes at 193/193
and regenerated the manifest cleanly**. Two thirds of every row in the table
below would have described a different corpus with nothing to say so.

Axis 9 is cheap - `generate()` and a hash, with no parse and no highlighting -
so it covers all four sizes while the expensive diagnostic axes stay at the two
reference sizes. The benchmark's defaults now live in `corpus.js` as
`BENCH_DEFAULT_SIZES`, `run.js` consumes them, and `verify.js` **asserts that a
digest is pinned for every one of them**, so the two lists cannot drift apart
again. A `--sizes` override outside the verified set is still allowed - exploring
a new size is legitimate - but the run says out loud that those rows are not
pinned by anything and must not be recorded as a baseline.

#### The pins are now reproducible

Until round 7 the hand-pinned literals in `verify.js` were produced by throwaway
helpers that were never committed, so they could be re-derived by nobody but
their author - a fair review finding, and its own kind of unmaintainable.
`bench/print-pins.js` is committed to fix it. **It prints; it does not write**,
and it is deliberately not wired into `write-manifest.js` - doing so would make
the hand-pinned axes regenerable and hand back the exact property they exist to
have. The intended workflow is: change the corpus on purpose, run
`npm run test:corpus` and *read the named failures*, satisfy yourself each
dimension moved for the reason you intended, and only then paste. Pasting first
turns every oracle in this directory into a rubber stamp.

Confirmation that the tool is faithful: run against the unchanged corpus it
reproduces the committed `BLOCK_IDENTITY` block byte-for-byte.

#### A third complement: an entire profile that nothing pinned

All nine pin objects are keyed by profile, and every axis iterates
`Object.entries(PIN)`. A profile absent from a pin object is therefore not
failed - **it is never visited at all**. And `PROFILES` is
`Object.keys(BUILDERS)`, so *adding a builder silently creates a profile*.
Extending the corpus with a new construct is the documented way to use this
directory, which makes this the one hole here most likely to be hit by accident
rather than by an adversary.

Measured: a seventh "ghost" builder was added and nothing else touched. The
manifest tier caught it - and then `write-manifest.js` regenerated the manifest
and the suite passed at **229/229, exit 0**. The assertion count went *up* by
ten, so it read as more verification while the new profile - a whole document
class the benchmark renders, times and prints a row for - was covered by nothing
that could not be regenerated away.

Every pin object is now checked to pin exactly the profiles the corpus defines.
**The registry of pin objects is itself checked against this file's own source**,
because registering by hand would only move the omission up a level: a tenth
axis would go unregistered exactly as the ghost profile went unpinned. Every
`const NAME = {` at column zero is discovered by reading `__filename` and must
appear in the registry. Proven sensitive: an unregistered tenth pin object fails
the check by name.

Writing that check immediately found a real pre-existing gap - `INTERNALS` had
never pinned `prose` or `headings`. That was defensible (neither profile has
tables, lists or fenced blocks) but it was nowhere recorded, and *absent is
indistinguishable from forgotten*. They are now pinned as `{}`, and because an
empty pin would otherwise be a vacuous pass, the axis additionally asserts that
every construct WITHOUT a pin is genuinely absent - turning each omission into a
positive claim.

#### A registry's discovery must itself be proven to discover

The registry check above reads this file's own source with a regular expression.
That is a linter, not a proof, and **both reviewers said so independently**. Worse,
it could go *vacuous*: if the pattern ever stopped matching - a reformat, a
rename, a change to how pin objects are declared - `declared` would be empty,
"nothing is unregistered" would be trivially true, and the check would pass while
checking nothing at all.

A hard-coded floor (`declared.length >= 10`) was rejected: it needs raising by
hand on every new axis, and the hand that forgets to register an axis is the same
hand that forgets to raise the floor. Instead the two sets must be **equal** -
every registered name must also be *discovered*. The registry is then its own
self-calibrating expected-minimum and cannot rot.

Proven sensitive by the exact accident it defends against: inserting one extra
space (`const  SHAPE = {`) - a pure-whitespace reformat with zero semantic
effect - fails exactly one assertion, and it names `SHAPE`.

### An oracle may not share code with its subject

Axis 9 hashes the whole corpus text and compares against a pinned digest. It was
advertised here as *the axis with no complement*, and it had the largest one of
all: **the entire hash function**. `verify.js` imported `sha256` from
`corpus.js` - the very module every axis in this file exists to police.

Measured, not argued. Apply the round-7 column-swap mutation to `BUILDERS.tables`
*and* teach `corpus.sha256()` to canonicalise that swap away, then run the suite:

| axis 9 computes its digest with | failures on the breaker |
|---|---|
| `corpus.sha256` (as shipped through round 7) | **0** |
| `crypto` directly, inside `verify.js` | **8** |

Every one of the eight digest cells still matched, because subject and oracle
agreed on a lie. This project has hit this exact fallacy once before - a test
that judged a formula with a copy of that formula (`test-tab-refresh.js`
Scenario 4) - which is the argument for writing it down rather than fixing it
quietly.

`verify.js` now computes its digest from `crypto` in a local `digest()` and no
longer imports `sha256` at all. **The pins did not move**, which is the proof the
change is purely structural: `corpus.sha256` is plain sha256 over utf8 today, so
the two functions are byte-identical *now* - the defect was never a wrong hash,
it was a shared one.

`write-manifest.js` still uses `corpus.sha256`, and that is now *better* rather
than merely tolerable: the manifest tier compares an independently-computed
digest against the manifest's, so a lying `corpus.sha256` makes regeneration
**fail** instead of pass.

### Nothing pinned what the application actually rendered

Every axis in `verify.js` pins the corpus *text*. `run.js` then feeds that text
to the real render pipeline and times it. Nothing anywhere pinned what the
pipeline **built** - so any change that made the app render *less* would be
reported as a speed-up.

`nodesAgree` cannot cover this. It compares repetitions **to each other**, so it
is structurally blind to any change that is perfectly reproducible - which every
code change is. Nor can the correctness suites: they render their own fixtures
and never open `bench/corpus.js`.

Measured with a plausible-looking "optimisation" - an early return in
`highlightNewElements()`, the shape a well-meaning change would take:

| `code@256KB` | nodes | render |
|---|---|---|
| pinned | 65,691 | 700 ms |
| with Prism skipped | 21,897 | 370 ms |

A **1.9x speed-up** with two-thirds of the DOM missing, printed as a clean row.
`nodesAgree` was TRUE (all repetitions agreed on the wrong number) and
`npm run test:corpus` passed 232/232 (the corpus text was untouched).

`RENDER_CENSUS` in `run.js` now pins `blocks` / `nodes` / `tokens` for every
benchmarked cell. Re-running the same breaker with it in place:

```
REJECTED: code@256KB  rendered 21897 nodes, pinned 65691 (-66.7%)
REJECTED: code@256KB  rendered 0 tokens,    pinned 43794 (-100.0%)
REJECTED: code@512KB  rendered 43407 nodes, pinned 130221 (-66.7%)
...
REJECTED: dense@256KB rendered 11033 nodes, pinned 14399  (-23.4%)
```

Three properties are deliberate:

- **A missing pin is a refusal, not a default.** An unpinned cell exits 4 and
  prints a paste-ready `RENDER_CENSUS` block, so pins are always *measured*
  rather than predicted - and re-pinning is the deliberate act it is meant to be.
- **The key is the REQUESTED size, not the generated byte count.** `generate()`
  only checks its target between whole builder iterations, so it overshoots by a
  profile-dependent amount (`prose@256KB` emits 262,464 bytes). Keying on the
  overshoot would make the census move with any per-iteration size change - a
  fact the manifest already pins - and would stop the keys matching
  `BENCH_DEFAULT_SIZES`, making "is every benchmarked size pinned?"
  unanswerable.
- **One tolerance, one constant.** `sameDocumentTolerance` gates both
  `nodesAgree` and the census: the same question asked of different pairs. An
  earlier version carried a comment claiming "one rule, applied twice" while
  leaving two literal `0.02`s - a magic number duplicated will eventually
  disagree with itself.

**Known limit, recorded rather than implied away.** The census sees changes that
move node, block or token counts. It is blind to class- or attribute-only
changes. That gap is now half-closed by `CLASS_CENSUS` below - and the other
half turned out to be a hole in the *corpus*, not in the oracle.

### A count is not a shape: the class census

`RENDER_CENSUS` counts. A change that renames a class, drops a modifier or stops
applying a decoration moves no count at all, so the strongest oracle in the file
was blind to a whole category of regression.

The fix is `CLASS_CENSUS`: an exact per-class histogram of everything under
`#viewer`, pinned for all 18 cells. Four things about it were **measured before
it was built**, because a histogram is only worth pinning if it is stable and
bounded:

- **The vocabulary is closed.** At most **17 distinct class names** appear in any
  cell. A histogram over an unbounded vocabulary would be a hash by another name.
- **It is byte-identical across every repetition of every cell.** 3 repetitions x
  6 profiles produced exactly **6 distinct signatures**, one per profile. Class
  counts are a property of the *document*, not of the machine, so unlike a timing
  there is no jitter to absorb - which is why this is pinned **exactly, with no
  tolerance**, and is the strictest oracle in the directory.
- **The stability check is its own positive control.** The repetitions are
  required to agree before the pin is consulted. If they ever stop agreeing, the
  oracle says so rather than comparing the first repetition and calling it a day.
- **An empty pin is a positive claim, not a vacuum.** `prose` and `lists` pin
  `{}`. The comparison iterates the **union** of pinned and observed keys, so a
  class appearing where none was pinned fails. Without the union an empty pin
  would be unfalsifiable.

**Proven sensitive twice, by two different classes of breaker.**

1. `markShortColumns()` short-circuited. Exit 4, **exactly two assertions**
   (`nowrap-col` 9090 -> 0 and 3366 -> 0), and `RENDER_CENSUS` stayed silent
   throughout - i.e. the new oracle caught precisely what the old one could not.
2. A **browser-only** `Prism.hooks.add('wrap', ...)` renaming `keyword` ->
   `builtin`. Exit 4, four assertions naming both classes, node and token counts
   unmoved. Under the identical breaker **`node bench/verify.js` passed
   232/232** - because axis 7 runs the Prism bundle in a Node `vm`, so a
   transform installed in the browser is invisible to it. That axis really was
   blind, and the gap is now closed.

### The benchmark was timing its most expensive pass executing only its no-op path

`applyTableBreakout()` was 79% of a 1 MB render before the layout-thrash fix, and
it is still the largest single phase in the table profiles. `table-breakout`
appears in **no cell of the class census**.

Chasing that: `nowrap-col` comes from `markShortColumns()`, not from
`applyTableBreakout()`. Every table the corpus generates fits inside the 900px
reading column, so the pass measures its containers, decides nothing needs
widening, and returns. Gutting the function entirely was measured:

| `tables@256KB` | nodes | class census | render | settle | breakout phase |
|---|---|---|---|---|---|
| intact | 18,685 | identical | 566 ms | 782 ms | 372 ms |
| gutted | 18,685 | identical | 486 ms | 529 ms | **0 ms** |

Every output oracle - nodes, blocks, tokens, class histogram - was silent, while
a third of the render time vanished. **No oracle over rendered output can cover a
pass that produces no output**, so this is not a defect in the census; it is a
hole in the *corpus*.

The fix is a table too wide for the reading column. **It was originally scheduled
to ride with the `marked` 9 -> 18 upgrade and both reviewers, independently,
overruled that.** The scheduling argument was that both changes re-pin every cell
and doing them apart resets the comparison baseline twice. The counter-argument
was decisive: the prose beside the `tables` numbers in this file was *already
false* - it described a widening pass that never ran - and while a baseline is
re-measured routinely, there is no mechanism that re-measures the *interpretation*
printed next to a number. A wrong number gets corrected on the next run; a wrong
sentence does not.

See "The widening pass now has a corpus that exercises it" below for what was
built and what it caught.

### The widening pass now has a corpus that exercises it

A seventh profile, `wide`, whose only content is tables that do not fit the
reading column. `tables` was deliberately left untouched: the narrow,
fits-the-column path is its own baseline, and closing today's hole by converting
that profile would have opened the symmetric one.

**Why a new profile rather than a wider table added to `tables`.** The
`INTERNALS` axis in `verify.js` requires `min === max` over every table token in
a profile - it is what catches "a table collapsed to a single column". Mixing a
4-column and a 10-column table into one profile forces that axis down to a range,
which admits exactly the degeneracy it exists to catch. Keeping them apart also
left all nine existing axes and all 18 existing cells completely unchanged.

**The trigger was measured, not reasoned about.** `applyTableBreakout()` widens
when `wanted > given + 1 && available > given`. A throwaway probe rendered seven
candidate table shapes at three viewports:

| shape | `wanted` | breaks out | `wrap-anyway` @1988 / @1588 / @1268 |
|---|---|---|---|
| 8 cols x 12 chars | 860 | **no** | - |
| **10 cols x 12 chars** | **974** | yes | no / no / no |
| 12 cols x 12 chars | 1182 | yes | no / no / no |
| 16 cols x 12 chars | 1598 | yes | no / **yes** / **yes** |
| 24 cols x 12 chars | 2430 | yes | yes / yes / yes |

Two facts came out of it that reading the code would not have given:

- `given` - the reading column - measures **860px**, not the 900px the
  stylesheet names. The difference is padding.
- `wanted` is **viewport-invariant**: identical at all three window widths for
  every candidate. What *is* viewport-dependent is `wrap-anyway`, which appears
  when `wanted` exceeds the space actually available.

So a table sized to *just* trigger breakout would have produced a class histogram
that changed with the window, and `CLASS_CENSUS` is pinned exactly. Ten columns
clears the trigger by 114px and the wrap-anyway boundary by 246px at the narrowest
viewport tested - a large margin on both sides at once, which is the property that
was being selected for.

**Fixed-width cells are load-bearing, not tidiness.** Column width *is* the
trigger, so it must not drift with document length: the iteration counter reaches
1,169 at 1 MB, and an unpadded index would make later tables wider than earlier
ones, which would make the widening decision depend on document *size*. Padding
to six digits holds every cell at exactly 12 characters. `TEXT_SHAPE` shows it
worked - the character histogram and `maxRun` are identical at 64 KB and 1 MB,
where every other profile's digit counts drift. (`maxRun` is 41 and it is the
separator row, `|` followed by `---|` ten times, not any cell.)

**Measured on the real generated corpus, not on the probe:** 293 of 293 tables
carry `table-breakout` at 256 KB, `wrap-anyway` is absent, and the full class
histogram is byte-identical at 1988px, 1588px and 1268px.

**The viewport is therefore part of the regime now**, and is enforced as such: a
fifth invariant refuses (exit 3, before any cell is measured) below an inner width
of 1280px. Below roughly 1022px the wide tables gain `wrap-anyway`, which is a
fact about the screen rather than about the corpus. Both halves were proven:
requesting a 1000px window exits 3 naming the invariant, and with the invariant
disabled at that same width the class census gains `"wrap-anyway": 293` and is
rejected. `main.js` persists window bounds, so this is a reachable accident, not
a theoretical one.

**What it catches.** Gutting `applyTableBreakout()` - the change that every
oracle was previously silent about - is now refused by name in all three cells:

```
REJECTED: wide@257KB rendered 0 .table-breakout, pinned 293
REJECTED: wide@512KB rendered 0 .table-breakout, pinned 585
REJECTED: wide@1024KB rendered 0 .table-breakout, pinned 1169
```

`verify.js` went 232 -> 267 assertions (nine axes x three new cells, plus manifest
coverage), and `print-pins.js` was extended from 2 axes to 5 so the added pins are
re-derivable. That extension duplicates measurement code that `verify.js` also
has, which is normally forbidden here - it is safe **only** because `print-pins.js`
is not an oracle: it *proposes* numbers and `verify.js` recomputes every one
independently, so a divergence produces a failing assertion rather than a false
pass. It was validated by confirming it reproduces every pre-existing pin exactly.
If `verify.js` ever imports those functions the property is gone and both files
would agree on the same mistake, which is the round-8 defect shape.

### A quadratic can hide inside a linear majority

Every oracle above describes the corpus, the regime or the rendered *output*.
None described the **shape of the timing result itself**, so the two defects
this project was created by - a pass going quadratic, and a deferred pass
quietly becoming synchronous - would both have produced a clean run with
nothing but larger numbers, and larger numbers are what a benchmark is expected
to produce when the machine is busy.

Both reviewers proposed an invariant, both proposals rested on a constant, and
in both cases the constant was the weak part. The interesting part is how each
was replaced.

**(1) The ratio bound, and the measurement that contradicted both framings.**
The table's own legend already states the semantics - *~2.0 is linear, ~4.0 is
quadratic* - so the first refusal threshold was the midpoint of two values the
artifact itself names, not a new magic number. Only the upper bound refuses: a
lower bound was proposed and rejected on the argument that an optimisation
removing fixed per-render overhead legitimately pushes the ratio *down*.

One reviewer objected that a bound which has never fired is a guess. That was
tested rather than argued, by injecting a genuine quadratic into
`applyTableBreakout` scaled by the document's own block count, so doubling the
document quadruples the injected cost:

| | 256 KB | 512 KB | ratio |
|---|---:|---:|---:|
| the `applyTableBreakout` phase | 119 ms | 468 ms | **3.95** |
| total settle | - | - | 2.68 |

**The phase is unambiguously quadratic and the total sailed under a 3.0 bound.**
The rest of the pipeline is linear and dominates at the small end, so it dilutes
the ratio. A total-only bound is far less sensitive than it looks. The bound is
therefore applied **per recorded phase as well as to the total**, which catches
the same injection at 3.95.

The noise floor is the **existing** spread floor rather than a second constant.
A phase costing less than that is one the harness already considers too small to
draw conclusions from, and dividing two such figures gives a ratio dominated by
scheduling jitter - prose spends ~0 ms in breakout, and 0.4/0.1 is not a
quadratic.

#### The legend's premise turned out to be false, and the bound was mis-derived

The 3.0 bound assumed a phase is *either* linear *or* quadratic. Measuring both
populations - which nobody had done, including the two reviewers who argued
about where the bound belonged - showed that premise is wrong.

**Legitimate behaviour, five clean runs of `wide`, per-phase medians:**

| phase | ms at 1024 KB across 5 runs | ratio 512 -> 1024 |
|---|---|---:|
| `applyTableBreakout` | 2234 / 2193 / 2209 / 2251 / 2347 | 2.01 - 2.11 |
| `sanitizeHtml` | 443 / 444 / 446 / 447 / 447 | 1.99 - 2.04 |
| `marked.parse` | 286 / 284 / 287 / 289 / 296 | **2.61 - 2.85** |
| `patchViewerDOM` | 161 / **230** / 163 / 162 / 163 | 1.99 - **2.89** |
| `addTableMaximizeButtons` | 211 / 220 / 211 / 215 / 218 | 1.64 - 2.67 |

Two separate facts fall out, and they have different causes:

- **`marked.parse` is genuinely superlinear** - a stable 2.61-2.85 across five
  runs and across *both* doublings, i.e. roughly **n^1.41**. That is not noise;
  two independent doublings agreeing to within 2% is a property of marked's own
  lexer on wide tables. It is invisible on every other profile.
- **`patchViewerDOM`'s 230 ms is one contaminated run out of five.** Four runs
  agree at 161-163 ms. Its within-run spread was 12.6%, i.e. *under* the spread
  limit, so neither the spread bound nor the per-phase medians could see it -
  both are computed inside a single run.

**And what a real quadratic actually reads as**, re-measured across both
doublings rather than one:

| | 256 KB | 512 KB | 1024 KB | ratios |
|---|---:|---:|---:|---|
| injected quadratic in `applyTableBreakout` | 118 ms | 469 ms | 2779 ms | **3.98**, 5.93 |
| total settle | 140 ms | 406 ms | 1678 ms | 2.89, 4.14 |

This corrected two things previously believed here. First, *"4.0 is an asymptote
a quadratic approaches from below, so a bound at 4.0 could never fire"* is
**wrong**: once the quadratic term overtakes the linear one the ratio overshoots
4.0 (5.93 on the second doubling). Second, the total is not blind to a quadratic
*forever* - it reached 4.14 on the second doubling. The honest claim for the
per-phase check is therefore narrower than first stated: **it catches a
quadratic one doubling earlier**, not uniquely.

So the two populations are:

| | value |
|---|---:|
| highest **legitimate** phase ratio (5 runs x 12 phases) | 2.89 |
| lowest ratio a **genuine quadratic** produced | 3.98 |

3.0 sat **4% above real behaviour** and 25% below the thing it hunts.

#### Two bounds, because one threshold cannot do both jobs

The obvious repair - slide the bound to 3.44, the midpoint of the measured
populations - was proposed to both reviewers and **rejected by both,
independently, from opposite directions**. They agreed on the diagnosis and
disagreed on the cure, which is what made the exchange worth having:

- One argued that 3.44 is *pareto-dominated*: it catches nothing 3.0 does not,
  while waving through a real-but-not-quadratic regression (n^1.6 reads ~3.03),
  and it collapses per-phase structure that a global constant cannot express.
- The other argued the same band from the other end: moving the *sole* bound to
  3.44 deletes the 3.0-3.44 signal entirely, and that band is exactly where a
  superlinear regression smaller than full quadratic first appears.

**The question was a false dichotomy, and both numbers are right for different
jobs.** The harness now carries two:

| bound | value | derivation | effect |
|---|---:|---|---|
| `SUSPICIOUS_RATIO` | 3.0 | midpoint of the table legend's 2.0 / 4.0 | re-measure, then report loudly on a passing run |
| `QUADRATIC_RATIO` | 3.44 | midpoint of the two **measured** populations (2.89, 3.98) | refuse |

Each keeps its own derivation. Neither was chosen to make a specific
observation pass or fail, and `marked.parse` at ~2.72 is now reported every run
with 21% headroom instead of 5% - visible, characterised, and not a per-run
alarm about behaviour that has already been diagnosed.

**A rejected third option is recorded because it is the strongest of the ones
not taken.** One reviewer proposed a per-phase bound of `min(3.0, base * 1.3)`
derived from each phase's own measured baseline, which would catch a
`sanitizeHtml` regression from 2.04 to 2.7 that no global bound can see. It was
not taken for two reasons, one of them measured: `addTableMaximizeButtons`
measures 2.19-2.67 legitimately on one doubling, so a bound at `base * 1.3`
would sit about 12% above a phase whose own measured noise is +/-22% - a false
refusal waiting to happen. And the other reviewer's objection is structural: a
bound derived from the product's current performance drifts *with* the product,
so a gradual regression that lands in the baseline becomes the new normal. It
remains the honest answer if per-phase sensitivity is ever needed.

#### Re-measure once before refusing

Both reviewers chose this independently, over the alternatives (gate the refusal
on the phase's share of settle; require two aggregations to agree), and for the
same reason: **the measured failure mode is a single contaminated run, and every
other proposal only attacks within-run variation.** A second observation is the
only thing independent of it.

On any ratio above `SUSPICIOUS_RATIO` the harness re-measures both cells of the
pair and recomputes. Both the first and second ratios are reported, so a cell
needing a retry on *every* run is visible rather than silently defended - which
is precisely the distinction a widened bound destroys. A re-measurement that is
itself over the spread limit **refuses**: a noisy retry can neither clear a
suspicious ratio nor condemn one.

It earned its place immediately. Proving the path (by lowering both bounds until
real ratios crossed them) caught a live instance of the exact phenomenon it was
built for:

```
re-measured ratios (first observation -> second):
  wide the marked.parse phase    2.71 -> 2.69
  wide the patchViewerDOM phase  2.92 -> 2.50
```

`patchViewerDOM` was observed at 2.92 - near the bound - and came back at 2.50
on re-measurement, unprompted, in a run that was not looking for it.

**The retry, the band report and the contaminated-retry refusal are all dead
code on a passing run**, because the closest real approach is 2.72. A path that
has never executed is not verified, so both were forced and proven: one
scenario landing in the band (exit 0, band reported, first->second printed) and
one crossing the refusal bound (exit 3, with the surviving re-measurement
printed beside the refusal).

**Per-phase ratios use per-phase medians, not the representative sample**, and
that distinction was forced by measurement too. The printed table uses one
coherent sample - the one whose *settle* is the median - so that two figures
printed side by side cannot contradict each other (`settle < render` is
arithmetically possible and physically meaningless). But a phase's value *in
that sample* can sit well off that phase's own median: `addTableMaximizeButtons`
diverges **11.4% and 12.9%** between the two aggregations, moving its ratio from
2.042 to 2.305. The coherence argument that chose the representative sample does
not apply to an invariant, which compares one phase against *itself* at another
size, where robustness is the only property that matters.

**(2) The two-stage invariant, and why neither reviewer's own proposal was
taken.** `renderMarkdown()` resolves on readable content; Prism then runs the
largest single pass in the corpus behind `requestIdleCallback`. `settle` is the
headline number *because* of that gap. A change folding the deferred pass back
into the render would make `settle` and `render` describe the same instant while
every existing oracle stayed silent - the node counts, the classes and the
corpus digest would all be unmoved, because the same work still happened, just
earlier.

Both reviewers proposed `settle > K * render`. Both, independently, withdrew it
in favour of a **resolve-side census**: record node and token counts at the
instant `renderMarkdown()` resolves, and require the settled counts to exceed
them. The subject is not time, it is whether nodes appeared after the render
resolved. No `K`, machine-independent, and it fails by name:

```
REJECTED: code@256KB had 43794 tokens when the render resolved and 43794 once
it settled, so nothing was deferred
```

**The scope comes from the PIN, not from the measurement, and that removes the
need for a vacuity guard.** Selecting "cells that produced tokens" and then
checking those cells makes the selector and the subject the same quantity, so a
run where the tokens vanished entirely would select nothing and pass - the
defect shape this project already hit with a revert-id filter that matched
nothing and printed ALL PROVEN. Selecting instead on `CLASS_CENSUS[...].token >
0` makes the scope a hand-pinned fact about the corpus. A cell that lost its
tokens is then caught by the class census; a cell that kept them but stopped
deferring them is caught here. A narrowed `--profiles` run may legitimately have
no cell in scope, but a *full* run with none is itself refused.

**THE OBVIOUS REVERT FOR (2) IS A WRONG-GUARD, and it is recorded because the
next person will reach for it.** `run.js` parses
`requestIdleCallback(cb, { timeout: 1000 })` out of `renderer.js` to derive
`QUIET_MS`, so any revert editing that call site aborts at the regime parse
before the invariant is ever evaluated - proving nothing while looking like a
proof. The faithful revert perturbs the **call** instead
(`requestIdle(() => {` -> an immediate invocation), leaving the parsed text
untouched: the scheduler is still declared, the callback simply runs
synchronously. Both invariants were shown sensitive that way before either was
trusted.

| mutation | caught by |
|---|---|
| a genuine quadratic injected into `applyTableBreakout` | NONLINEAR RATIO, per phase at 3.98 - the **total** ratio was 2.89 and passed |
| the deferred highlight pass invoked synchronously | TWO-STAGE CENSUS (`43794` tokens at resolve, `43794` at settle) |
| a suspicious ratio confirmed by re-measurement | REFUSAL, with both observations printed |
| a suspicious ratio cleared by re-measurement | `OK_AFTER_RETRY`, run passes and says so |

### The measurement regime was unpinned, so two runs could be incomparable and both say OK

Three dials decide what a settle figure *means* - the quiet window, the settle
cap and the warm-up count - and all three were literals buried in the file. A run
with a shortened quiet window produces smaller settle figures for every cell,
prints `STATUS: OK`, and is not comparable with anything.

Two decisions, both of which the reviewers reached independently:

- **Invariants, not values.** Pinning `reps === 3` would need re-deriving on
  every legitimate re-tune, and a pin that is routinely re-derived stops being
  read. The four assertions state *properties*: `QUIET_MS > idleDeadlineMs`,
  `SETTLE_CAP_MS > QUIET_MS * 2`, `WARMUP_REPS >= 2`, `reps >= 3`. A re-tune
  passes silently; an un-tune fails by name, **before any cell is measured**.
- **The threshold is derived, not compared against a literal.** `QUIET_MS` must
  outlast the product's own deferred work, so the harness *parses*
  `requestIdleCallback(cb, { timeout: N })` out of `renderer.js` rather than
  comparing against `1000`. If the product raises its deadline the harness fails
  and says so. The parse **refuses (exit 3) rather than defaulting** if the regex
  stops matching - a default would silently restore the magic number the parse
  exists to remove.

The effective regime is then *recorded* in the fingerprint block:

```
regime  3 reps, warm-up 2x dense@1024KB, quiet 1500ms (product defers 1000ms),
        cap 30000ms, gc renderer-only, throttling off
```

so two runs with different regimes cannot look comparable merely because both
printed `STATUS: OK`.

Proven sensitive: `QUIET_MS = 900` (below the product's 1000 ms deadline) exits 3
naming the invariant, with no cell measured.

### The settle loop had no positive control - and the first attempt at one re-implemented it

`settle` is the headline number, and nothing checked that the loop producing it
can see late work at all. A loop that gave up early would report smaller settle
figures for every cell and never say so - the defect that once reported
`dense@1MB` at 38,740 nodes against a true ~57,000.

The control schedules a mutation at 400 ms and requires **both** halves:

- the loop **saw** it (settle reaches ~400 ms), and
- the loop was **held open** by it (total elapsed >= 400 + one full quiet window).

The second half is what separates "the observer fired" from "the observer fired
and the loop cared".

**The first version of this control was itself defective, and it is the third
instance of the same disease in this project** - after a test that judged a
formula with a copy of that formula (6a) and an oracle that hashed with its
subject's own hash function (round 8). The control carried **its own copy of the
settle loop**, so it would have proven that *a correct loop* works, not that
`measureOnce`'s loop works. Fixed by hoisting one `SETTLE_LOOP` template string
used by both callers.

Proven sensitive **after** the hoist, which is the only version of the proof that
means anything: making the shared loop settle after 80 ms instead of on the quiet
window makes the control abort with exit 3 (`reported 0ms for a document
deliberately mutated at 400ms`) - and because the loop is now shared, that is
demonstrably the same code every cell's settle figure comes from.

### A warning on stderr is not a property of the artifact

`bench-results.txt` is what gets quoted, pasted and compared weeks later; stderr
is gone the moment the terminal scrolls. A run given `--sizes` values that no
digest pins was warning on stderr while the artifact still said `STATUS: OK`.
The caveat now goes into the `STATUS:` line itself via `statusSuffix`, which is
declared above `finish()` - module-scope pin objects in this directory have
already caused one TDZ crash.

### The corpus must be parsed the way the app parses

`bench/corpus.js` never calls `marked.setOptions` (it must not mutate a parser
other code shares) and marked applies per-call options *instead of* the globals,
so every option `renderer.js` sets has to be repeated in `RENDER_OPTIONS`.
`verify.js` parses `renderer.js`'s own `setOptions` block and asserts the two
sets match exactly, failing loud if the block is missing or holds a value it
cannot parse. Without that, `RENDER_OPTIONS` is a hard-coded copy of another
file's setting: correct the day it is written, silently wrong afterwards.

Measured: the full option set rendered byte-identically to `breaks` alone across
all six profiles and on an autolink/email probe, so `mangle` and `headerIds`
were inert in the marked 9 build. They were pinned anyway on the argument that
"inert today" is exactly the state `breaks` was in before a builder change would
have activated it. The 9 -> 18 upgrade retired that argument rather than
confirming it: both options were removed from marked's *core* in v8/v9, so no
builder change could ever have activated them, and they are now deleted from
`renderer.js` and `RENDER_OPTIONS` alike. The set is `breaks` and `gfm`.

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

The control also pins the *converse*: the two parsers must **agree on legal
input**, not merely disagree on illegal input. The permissive scan originally
used `[^>]*`, which stops at the first `>` even inside a well-formed value, so
`class="a>b"` was truncated to `<span class="a>` and reported as unreadable
while the strict parser and the tally both read it correctly. That is a false
positive rather than a hole - the axis fails loud instead of miscounting - but a
guard that cries wolf on valid documents is one a future reader widens a
tolerance to silence. The scan now skips over quoted regions, and the control
asserts the *value is tallied whole*, not merely that nothing was complained
about.

### Nothing measured Prism, and Prism is the most expensive pass

Six axes described everything about the benchmark except its largest deferred
phase. Every one of them reads marked's output or its input, and marked emits
`<pre><code class="language-js">` with the fence body untouched inside it -
so **no axis ever looked inside a code block**, while Prism highlighting is
1160 ms of the code profile's 2156 ms of post-resolve time at 1 MB.

Found by the round-6 review and MEASURED end to end: uppercasing the two
keywords in `BUILDERS.code` passes **166/166 with a regenerated manifest**.
Every axis is silent for a reason that is individually correct - SHAPE,
INTERNALS, ELEMENTS and ATTRIBUTES all see the wrapper and never its contents;
TEXTURE sees identical word and character counts (`const` and `CONST` are both
five characters); TEXT SHAPE groups A-Z with a-z, so the histogram is identical
to the byte and so are the run lengths.

**The axis tallies by token type rather than counting spans, and that
distinction is the whole point.** Measured in this file's own VM on the bundle
the app loads:

| fence body | spans | keyword spans |
|---|---:|---:|
| `const value0 = …` / `if (…)` | 18 | 2 |
| `CONST value0 = …` / `IF (…)` | 19 | 0 |
| `snect value0 = …` / `fi (…)` | 18 | 0 |

That third row is the one that matters. Replacing the keywords with same-length
non-keywords leaves the **total span count identical at 18** while emptying the
keyword bucket entirely - so a total-span oracle would pass it, and so would the
cheaper remedy of splitting TEXT SHAPE's `alpha` class into upper and lower.
Splitting `alpha` closes the case-swap *instance*; only tallying what Prism
actually emitted closes the *class*. Both breakers were applied for real: each
failed exactly the four HIGHLIGHTING assertions with axes 1-6 silent, and
`write-manifest.js` refused to regenerate in both cases, leaving `manifest.json`
byte-identical.

**A missing grammar is a failure, not a skip** - the same rule as the attribute
parser. If the bundle failed to load, highlighting nothing would leave every
tally empty and read as agreement, so the number of blocks highlighted must
equal the number found, both are pinned, and the load carries a positive control
requiring Prism to report a keyword as a keyword *and* a same-length
non-keyword as not one.

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

**Nor do signal handlers - and this reverses a review recommendation.** Round 6
proposed a `SIGINT` handler to cover Ctrl-C, which the exit wrapper cannot see.
It was implemented and then measured with a control, the same method that caught
`process.on("exit")`: a throwaway probe registering the four handlers was
launched twice and sent the same real `CTRL_C_EVENT`.

```
plain node.exe    sigintListeners=1  ->  HANDLER RAN: SIGINT
electron.exe      sigintListeners=1  ->  handler never ran, process died
```

Electron's own console-control handling terminates the main process before the
Node layer sees the event; confirmed end to end against `run.js`, where a real
Ctrl-C killed a live run with the lock still on disk. The handler is **kept**,
because on POSIX hosts the signal is real and `bench/` is not a Windows-only
tool - but the comment now says exactly what it does not cover, because on this
platform **the stale-lock takeover is the load-bearing mechanism** for an
interrupted run. `child.kill("SIGINT")` cannot be used to test any of this on
Windows: it calls `TerminateProcess` and no signal is ever delivered, so that
route measures nothing.

**Two defects in the lock were found by testing it rather than reading it.**
The first: making `releaseLock()` idempotent with a single `released` flag - the
obvious implementation, and the one suggested in review - would have *leaked the
lock*, because the stale-takeover path calls into the same function to remove
**somebody else's** file before we own anything, latching the flag before our
own release could ever run. Raw unlink and "release the lock I hold" are
therefore two separate functions. The second: the lock now records
`{pid, started}` as JSON, and `JSON.parse` **succeeds on a bare pid** - `"999999"`
is valid JSON for a number - so testing only for a thrown error left the legacy
fallback unreachable and reported the holder as unknown. A legacy lock held by a
*live* process would have been silently stolen, which is exactly the concurrent
run the lock exists to refuse. The parse result's *shape* decides, not whether
it threw.

The timestamp exists because a pid can be reused by an unrelated process and
there is no portable way to ask whether pid N is really this benchmark. A live
holder whose lock is older than two hours - about 13x the slowest observed full
run - is treated as stale anyway. **That is a bound, not a proof**, and it is
written down as one.

**A broken lock path and a busy lock are not the same refusal**, and conflating
them left a stale `STATUS: OK` on disk. Reported in review and reproduced here
before being fixed: with a *directory* at `bench-results.txt.lock`, the run
exited 2 and `bench-results.txt` still read `STATUS: OK` from a previous run -
indistinguishable from a fresh pass. It was also worse than reported. A
directory yields `EEXIST`, not some other error, so the run took the *takeover*
path and twice announced

```
bench: taking over a stale lock left by pid unknown, which is no longer running.
```

which asserts in as many words that the holder is dead, on the strength of a
read that had just failed with `EISDIR`. "I could not read it" is not evidence
that it is stale.

The distinction is entirely about **who owns `bench-results.txt`**:

- A **live holder** owns it. They are mid-run and will write their own report,
  so that refusal must leave the file completely alone.
- An **unusable lock path** - a directory, a permissions failure, an unlink that
  cannot succeed - means *nobody* holds the lock, because nobody could have
  taken it. The file on disk is therefore some previous run's report, and
  exiting quietly leaves a `STATUS: OK` that reads like a fresh pass.

So `refuseBrokenLock()` invalidates and says why; the live-holder branch
deliberately does not, and carries a comment saying so. `unlinkLock()` now
reports success, so a failed unlink refuses instead of looping into two more
identical warnings and a final message naming `EEXIST` - the one thing that was
not the problem. Both directions were then measured: broken path -> `STATUS:
INCOMPLETE`, live holder -> the holder's `STATUS: OK` untouched and its lock
still on disk.

The same review raised early `process.exit(2)` paths in argument validation
bypassing the invalidating write. That had already been closed by moving
argument parsing after it, and was re-measured rather than assumed: `--sizes=abc`
exits 2, leaves `STATUS: INCOMPLETE`, and releases the lock. The suggestion to
write per-run report files instead is not needed for its stated purpose, since
the lock refuses the second run outright.

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

## The `wide` profile's first full run

Run `2026-08-11T09:56:37Z`, same machine and fingerprint, viewport 1988x1070,
`corpus manifest verified (7 profiles)`. `STATUS: OK`; no cell rejected on
spread; the settle-loop control reported a mutation at 400 ms observed at 406 ms
holding the loop open to 1939 ms.

| profile | 256 KB | 512 KB | 1024 KB | ratios |
|---|---|---|---|---|
| prose | 81 | 159 | 295 | 1.96 / 1.85 |
| headings | 289 | 574 | 1132 | 1.98 / 1.97 |
| tables | 758 | 1434 | 2771 | 1.89 / 1.93 |
| lists | 317 | 673 | 1351 | 2.12 / 2.01 |
| code | 633 | 1301 | 2622 | 2.05 / 2.02 |
| dense | 524 | 1068 | 2209 | 2.04 / 2.07 |
| **wide** | **1105** | **2210** | **4347** | **2.00 / 1.97** |

**Node counts are byte-identical to the baseline in all 18 pre-existing cells**
(753/1507/2994, 4845/9663/19278, 18685/37222/73667, 8694/17361/34695,
65691/130221/259308, 14399/28721/57365). Adding a seventh profile did not perturb
the six that were already there - which is the claim that most needed evidence,
since the whole reason for a new profile rather than a wider table in `tables`
was to leave the existing cells alone.

**`wide` is now the most expensive profile in the corpus**, and that is the
finding rather than a complaint: at 1 MB the widening phase is 2254 ms of a
3209 ms render - **70%** - against 1424 ms of 2245 ms (63%) for `tables`, where
the pass runs but decides nothing needs widening. Before this profile existed the
single most expensive function in the pipeline was benchmarked only in the
configuration where it returns early.

The ratios (2.00 / 1.97) say the widening pass is linear in table count, so the
layout-thrash fix holds on the path that actually exercises it. That was
previously an inference from a profile where the pass did no work.

## What marked 9 costs, recorded before it is replaced

Captured by `bench/capture-marked.js` into `bench/marked9-parse.json`, run
`node --expose-gc bench/capture-marked.js`. It exists because the marked 9 -> 18
upgrade replaces the parser every number above was measured through, and
afterwards the marked-9 curve is not reconstructible: the bundle is gone, table
tokenisation is restructured, and re-vendoring the old bundle to re-measure
would mean two parsers against one set of pins - the ambiguity `corpus.js`
hard-errors on.

It measures the lexer and the full parse separately, at five sizes rather than
three, and keeps raw per-repetition times. Separately, because the observation
that started this says nothing about *which half* is superlinear - and that
determines whether marked 18's tokeniser rewrite is likely to help.

Median ms, 3 runs x 5 reps, node 24.18.1 / V8 13.6:

| profile | | 128K | 256K | 512K | 1M | 2M | slope | per-doubling |
|---|---|---:|---:|---:|---:|---:|---:|---|
| wide | lex | 16.0 | 48.9 | 139.2 | 476.9 | **6002** | 2.038 | 1.61 1.51 1.78 **3.65** |
| wide | parse | 19.3 | 53.5 | 150.4 | 515.6 | **6138** | 1.990 | 1.47 1.49 1.78 **3.57** |
| tables | parse | 17.9 | 34.5 | 103.6 | 283.3 | 2658 | 1.746 | 0.94 1.59 1.45 3.23 |
| dense | parse | 14.4 | 27.9 | 52.0 | 145.2 | 437 | 1.223 | 0.95 0.90 1.48 1.59 |
| headings | parse | 7.1 | 13.9 | 26.9 | 56.2 | 151 | 1.083 | 0.96 0.95 1.07 1.43 |
| prose | parse | 4.9 | 9.0 | 18.1 | 35.4 | 69.5 | **0.966** | 0.89 1.01 0.97 0.97 |

**Lexing and parsing degrade together and by the same factor.** `wide` lex
2.038 against parse 1.990 - the renderer half is not where the cost is going
non-linear, the tokeniser is. That is the falsifiable prediction to hold against
marked 18: if its tokeniser rewrite does not move these, the upgrade will not
fix this.

### The first capture produced an impossible number, and only impossibility caught it

It timed lex and then parse inside one repetition, always in that order.
`wide`@1 MB came back at **lex 944.7 ms against parse 613.0 ms** - and
`marked.parse` lexes and *then* renders, so parse cannot be cheaper than lex.
The reading reproduced in all three runs, so no variance or spread check would
have rejected it; only the arithmetic does.

The cause was heap state, not ordering as such: lexing a 1 MB wide document
builds an enormous token tree, five repetitions build and discard five of them,
and the resulting major collections land inside whichever timed region runs
first. The fix is all lex repetitions then all parse repetitions, each with its
own warm-up and an explicit collection *outside* the timed region.
`capture-marked.js` now refuses any capture where a cell reports lex above
parse, so this cannot come back quietly.

It mattered to the conclusions, not just to the tidiness: `dense` measured 1.53
before and **1.22** after, so most of its apparent superlinearity was collection
cost. `dense` had been declared a negative control on the strength of the
contaminated figure. It is now a subject, and `prose` is the only control - it
is the only profile that earns the name, at 0.966 with every individual doubling
between 0.89 and 1.01.

### The blow-up is a sustained change of regime, not a cliff to stay under

The per-doubling figures jump on exactly the last doubling for every structured
profile, which looks like a threshold - and a threshold would mean there is a
safe size just below it. There is not. Measured at eleven intermediate sizes,
cost **per KB**:

| MB | wide ms | ms/KB | prose ms | ms/KB |
|---:|---:|---:|---:|---:|
| 1.00 | 516 | 0.503 | 39 | 0.038 |
| 1.25 | 791 | 0.618 | 56 | 0.043 |
| 1.50 | 1326 | 0.863 | 63 | 0.041 |
| 1.75 | 2998 | 1.673 | 72 | 0.040 |
| 2.00 | 6346 | 3.099 | 88 | 0.043 |
| 2.25 | 11520 | 5.000 | 88 | 0.038 |
| 2.50 | **17415** | **6.803** | 104 | 0.041 |

`prose` is flat to within noise across the whole range - 0.038 to 0.044 ms/KB -
which is what makes the `wide` column attributable to the parser rather than to
the machine, the allocator or the generator. `wide` rises monotonically with no
discontinuity: local exponent about 1.7-2.1 below 1.4 MB, then about 5 from
1.5 MB onward and staying there.

**The consequence for the pending size guard is that document size alone is the
wrong trigger.** At 2.5 MB `prose` parses in 104 ms and `wide` takes 17.4
seconds - a 167x spread at identical byte count. A byte threshold set to protect
against `wide` refuses documents that would have opened instantly; set where
`prose` is comfortable, it does not fire until `wide` has already cost tens of
seconds. Whatever the guard ends up being, it has to see structure, and a pipe
count is O(n) and cheap.

## The marked 9 -> 18 upgrade

Taken on the strength of the capture above. The prediction it was taken to test
was that the cost lived in the TOKENISER - lex and parse degraded together and
by the same factor - so marked 18's tokeniser rewrite should move it. It did.

Both parsers loaded in one process, same machine, same moment, median of
2 runs x 3 reps, gc between reps:

| profile | size | marked 9 | marked 18 | speed-up |
|---|---:|---:|---:|---:|
| wide | 512 KB | 175 ms | 84 ms | 2.1x |
| wide | 1 MB | 547 ms | 158 ms | 3.5x |
| wide | 1.5 MB | 2303 ms | 223 ms | 10.4x |
| wide | 2 MB | 13373 ms | 339 ms | **39.4x** |
| wide | 2.5 MB | 34339 ms | **397 ms** | **86.6x** |
| tables | 2.5 MB | 12861 ms | 356 ms | 36.2x |
| prose | 2.5 MB | 92 ms | 93 ms | 1.0x |

`prose` is unchanged at 1.00x. That is the control working: this is not a
general speed-up, it is specifically the superlinear path being removed. Under
18, `wide` goes 84 -> 397 ms across a 5x size increase, which is linear.

Note that marked 9 measures WORSE here than in the capture (13.4 s against 6.3 s
at 2 MB) purely because this process holds two parsers and two corpora. Its
cliff is sensitive to heap pressure, so its real in-app cost - in a process also
holding tabs, the DOM and Prism - was worse than the capture suggested.

### The upgrade is byte-safe, and that is measured rather than hoped

- All seven corpus profiles render **byte-identical** HTML under 9.1.6 and
  18.0.9, so not one digest, token, render-census or class-census pin moved.
  `verify.js` passes 267/267 unchanged.
- Of 42 hand-written edge cases - tables with escaped pipes and ragged rows,
  the `@@@html` fence, setext headings, task lists, autolinks, reference links,
  nested lists, entities, CRLF - **41 are byte-identical**. The one difference is
  whitespace inside a raw HTML block: `<div>\n\n<p>` became `<div><p>`.
- `npm test`: 12 suites, 0 failures.

### What it did to the end-to-end numbers

`marked.parse` on `wide`, per-phase medians at 256/512/1024 KB: **37 / 71 /
141 ms**, ratios **1.92 and 1.99**. Under marked 9 the same phase was the
harness's worst legitimate offender at 2.61-2.85. Its share of `wide`@1 MB
render fell from roughly 12% to **4.1%**.

The SUSPICIOUS band - ratios above 2.89 that are reported loudly but not
refused - is now **empty**. It never was before; `marked.parse` was a permanent
resident, documented in the report text as expected. That text has been updated,
because a reader told to expect an entry that can no longer appear learns to
ignore the list.

`wide` render at 1 MB went 4347 -> 3397 ms, about 22%, and every profile's
settle ratio stayed linear (1.87-2.06).

**The next target is now unambiguous.** With marked linear, `applyTableBreakout`
is 2595-2686 ms of `wide`@1 MB's 3439 ms render - **76%** - and is the phase
closest to the nonlinear bound on most runs. It is where the remaining
large-document cost is.

### The harness caught the upgrade breaking its own instrumentation

The first full run after re-vendoring refused with `PHASE_NEVER_CALLED:
marked.parse`, and the cause was not in the product at all.

marked 18 is bundled by esbuild, whose export helper defines every export as a
**getter-only, non-configurable** accessor:

```js
for (var k in all) Object.defineProperty(target, k, { get: all[k], enumerable: true })
```

marked 9's exports were plain writable data properties, so the instrumentation's
`window.marked.parse = wrapped` worked. Under 18 that same line is a **silent
no-op** - sloppy-mode assignment to an accessor with no setter throws nothing -
and `Object.defineProperty` raises `Cannot redefine property`. Both measured
directly against the vendored bundle.

So the wrap reported success while the original parse kept being called and the
phase recorded 0 ms, which reads in the table exactly like a phase that costs
nothing. Two changes:

1. The whole `window.marked` namespace is replaced with a shim that forwards
   every key by getter and carries the wrapped `parse`. The global binding is an
   ordinary writable property, so this works where patching the member cannot.
2. **The wrap now asserts its own post-condition.** It previously checked only
   that `marked.parse` was a function *before* assigning, and then trusted the
   assignment. It now re-reads the property afterwards and requires it to be the
   wrapper, so an export shape this code cannot patch is reported at boot as
   `PHASE_NOT_WRAPPED` - naming the real cause - instead of surfacing eleven
   minutes later as a phase that mysteriously never ran.

