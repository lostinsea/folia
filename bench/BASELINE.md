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
changes - short-circuiting `applyTableBreakout()`, for instance, adds no nodes.
That gap is covered by the revert harness (R53), not by the benchmark.

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
