# Copilot instructions for Folia

Read this before changing anything. It is not style guidance; it is the set of
rules that were learned the expensive way in this repository, and most of them
exist because something passed a test suite while being broken.

## What this repository is

Folia is a **hard fork** of an Electron markdown viewer:

```
yumedzi/markdown-viewer  ->  OmniCoreST/omnicore-markdown-viewer  ->  lostinsea/folia
        (grandparent)                    (parent, `upstream`)          (this repo, `origin`)
```

Diverged at `854bdec` (2026-02-23, upstream v2.0.7). It is a fork, not a branch
of upstream: the fork's `version` is independent, upstream commits are picked
deliberately rather than merged wholesale, and the product has been renamed to
**Folia**. `main` is the only branch that matters.

The fork exists because of one bug — refreshing one tab silently reverted the
*other* tabs to stale content — and most of what is here now came out of chasing
it properly rather than patching it.

**Never point `build.publish` at a parent repository.** Their releases would
silently replace a Folia install. `test-packaging.js` asserts this.

## Layout

Everything runs from the repository root; there is no build step for the app
itself (Electron loads the sources directly).

| Path | What it is |
|---|---|
| `main.js` | Main process: windows, menus, IPC, file dialogs, file watching |
| `renderer.js` | The renderer: markdown -> DOM, tables, notes, search, export. The largest file here |
| `custom-tabs.js` | **Fork-owned.** The tab model: per-tab content cache, lazy render, refresh, scroll/anchor restore |
| `file-helpers.js` | Shared by **both** processes. BOM/mermaid normalisation, and the render-cost estimator |
| `index.html`, `styles.css`, `custom-styles.css` | UI shell and styling |
| `popup-preload.js` | Preload for pop-out windows; the security boundary for them |
| `libs/vendor/`, `libs/prismjs/`, `libs/tabulator/` | Vendored third-party code. **Folia makes no network requests to render a document** |
| `scripts/vendor-libs.js` | Copies vendored libs out of `node_modules` (runs on `postinstall`) |
| `scripts/prove-table-fixes.js` | The revert harness. See below — this is the most important file in the repo |
| `scripts/generate-notices.js` | Regenerates `THIRD-PARTY-NOTICES.md` (licence compliance is enforced by tests) |
| `bench/` | The benchmark corpus, its generator, and `verify.js` — the corpus's own oracle |
| `test-*.js` | The suites. Most are Electron programs, not node programs |
| `.github/workflows/release.yml` | Build + publish for Windows/Linux/macOS |

Docs that are load-bearing, not decoration: `CUSTOMIZATIONS.md` (what the fork
changed and why, so an upstream merge does not silently undo it), `BUILD.md`
(build, signing, release procedure), `SECURITY-AUDIT.md`, `PERF-AUDIT.md`,
`bench/BASELINE.md` (every measurement, with the method used to get it).

## Commands

```bash
npm start                 # run the app
npm test                  # everything. ~9 minutes. 12 suites, ~1290 assertions
npm run test:tabs         # the fork's core loop - run this for any tab/refresh change
npm run test:packaging    # node, not electron. Fast. Identity, licences, asar contents
npm run test:corpus       # node --check on bench sources, then bench/verify.js (~1s, 315 checks)
npm run bench             # electron bench.js. ~8 min. --profiles= --sizes= --reps=
node scripts/prove-table-fixes.js R229 R234   # prove specific fixes are load-bearing
npm run build-all         # electron-builder, Windows portable + NSIS
```

`PACKAGING_STRICT=1 npm run test:packaging` turns a skipped asar oracle into a
failure. Without it, a run that never built anything reports "0 failed" having
verified nothing about the artefact.

## How work is done here

**Measure; do not reason from the code.** Every performance claim, every
threshold, every "this is the slow part" in this repository came from a
measurement, and several of them contradicted the obvious reading of the code.
Two examples worth internalising: the size guard was going to trigger on file
size until measurement showed bytes are a **12.9x-wrong** proxy for render cost;
and `lines` alone — the obvious replacement — scored **26.9x**, worse than the
thing it was replacing.

**Hold data back.** Fitting the size-guard signal on the first three corpus
profiles scored 1.3x; the same formula scored 3.6x on the four profiles it had
not seen. The honest number is the held-out one. Never tune a constant on the
same data used to report its quality.

**Two independent reviewers, 2-3 rounds.** Non-trivial changes get reviewed by
two different models independently; agreements and disagreements are both
surfaced. Stop when a round produces no new blocking findings — do not loop
indefinitely. The convergence is worth it: on the `marked 18` upgrade both
reviewers independently found the same defect, and one proposed a fix that was
strictly better than the other's by exactly one case (`Infinity`).

**Fix the class, not the instance.** When something breaks, ask what else has
the same shape. A stale `hasOwnProperty` check that accepted garbage was fixed
by `Number.isFinite`, and the mutation suite went from 1 case to 7.

**Comment the why, never the what.** Every non-obvious decision in this codebase
has its reasoning at the call site, including deliberate omissions. If you
decide *not* to do something, write down why where the next person will look.

## Test discipline — the part that matters

The rule this repository is built on: **a test that cannot fail is worse than no
test**, because it also stops anyone from looking. Assume any new green result
is vacuous until proven otherwise.

### 1. Every fix gets a revert

`scripts/prove-table-fixes.js` currently holds **184 reverts (R49-R235)** across
all 10 suites. Each one undoes a real fix in the source, runs the suite that is
supposed to notice, and requires:

- `expect` — the assertions that **must fail** when the fix is undone. If the
  suite stays green, the test is decorative and the fix is unprotected.
- `mustPass` — assertions that **must keep passing**, so a revert that fails
  everything (a syntax error, a crashed app) cannot be mistaken for a real
  detection. There are 102 of these.

A fix without a revert is not finished. If you cannot write a revert that turns
the suite red, you have not tested the fix — you have tested that the app still
starts.

### 2. Every scenario proves its own setup

Before asserting the interesting thing, assert that the situation you are
testing actually exists. The suites are full of these and they read like:

- *"the document really overflows at 100%, so the scroll assertion can fail"*
- *"the injected failure really did reach the console, so the mute is not hiding a silent no-op"*
- *"the guard sample really is scored as expensive and the control is not"*

Without them, "no error was recorded" and "the watcher stopped working" are the
same result.

### 3. Error sentinels must be proven alive

Suites watch for console errors and error DOM. `proveSentinelAlive()` deliberately
provokes both channels and checks they were seen. A silent sentinel and a clean
run are indistinguishable otherwise.

### 4. Oracles reject their own bad inputs

The benchmark refuses `--reps=2` ("a median needs at least 3 samples") and
rejects sizes outside its verified set rather than reporting an unpinned number.
Prefer a harness that refuses to produce a result over one that produces a bad
one.

### 5. Negative cases must be exact

When proving sensitivity, check *which* assertions failed, not how many. A
mutation that fails five legs when it should fail one is telling you the probe
is coupled to something else.

### 6. Verify by viewing, not by capturing

Screenshots are verification only if someone looks at them. Capturing a PNG and
declaring success is another vacuous green. The same applies to launching the
packaged app: look at what it drew.

## Traps in this repository

These have each cost real time. They are not hypothetical.

**Backticks inside `bench/run.js`'s `exec()` template literal.** The shim region
(~1077-1160) is source code embedded in a template literal. A backtick there —
*including in a `//` comment* — ends the literal.
- An **unbalanced** backtick gives a `SyntaxError` (caught by `node --check`,
  which is why `test:corpus` runs it first).
- A **balanced pair** closes and reopens the literal, **passes `node --check`**,
  and detonates at runtime as `TypeError: 0 is not a function`. Only the
  character ban in AXIS 10 catches this.
- AXIS 10 alone is blind to both: it extracts the region and runs it standalone,
  where a backtick in a comment is inert. It once reported **295/295 against a
  `run.js` that could not start.**

**CRLF.** The working tree is CRLF. PowerShell here-strings with `Add-Content`
write bare LFs. Audit any file you edit by hand:
`[IO.File]::ReadAllBytes(<abs path>)`, count `10` not preceded by `13`, expect 0.
The exceptions are pinned in `.gitattributes` (`package.json`,
`package-lock.json`, `THIRD-PARTY-NOTICES.md`, `bench/manifest.json`,
`assets/logo.svg`, licence texts, `*.sh`) — those are generated LF-first, and
an aborted `git add` from `core.safecrlf` does **not** abort the `commit` after
it, which once produced a silently partial commit.

**PowerShell eats `$var`, `${`, and `\$`** even inside quotes. This has broken
`node -e` one-liners repeatedly. Write a probe script to a file instead, or use
`String.fromCharCode(96)` / `"$" + "{"` in source.

**`Set-Location` does not move .NET's CWD.** `[IO.File]::*` needs absolute paths.

**`verify.js` output is indented**, so `.StartsWith("FAIL")` needs `.trim()`
first. This produced a false "0 failures" reading once, caught only because the
exit code contradicted it.

**Kill stray Electron processes before every run.** A leftover instance holds
files and produces confusing failures.

**Tests must never open a real browser.** `trapExternalOpens()` exists because a
suite once opened `https://example.invalid/x` in the user's default browser on
every run.

**electron-builder logs `signing with signtool.exe` whether or not a certificate
exists.** The builds are unsigned. Do not read that line as evidence.

**Tag pushes do not trigger the release workflow on this fork.** `git push
origin v1.2.3` succeeds, prints a new-tag line, and starts nothing. Dispatch on
the **tag ref**: `gh workflow run release.yml --ref v1.2.3`. Dispatching on
`main` builds everything and publishes nothing, because `create-release` is
gated on `refs/tags/`.

**Bump `package-lock.json` with `package.json`.** The release workflow runs
`npm ci`, which fails when they disagree.

## Behaviours worth knowing before you change them

**Tabs render lazily.** `createTab()` only stores text; `switchToTab()` pays the
render cost. So guarding the *read* paths saves nothing — the cost lands on the
tab click. `createTab()` also calls `switchToTab()`, so opening a file is itself
a guarded switch.

**`reload-file` is deliberately unguarded** by the size dialog. It re-reads an
already-open document, and the tabbed-refresh loop is the reason this fork
exists; a confirmation there would fire dozens of times a session. The rationale
is at the call site — do not "fix" it.

**Fork-owned files diverge from upstream on purpose.** `custom-tabs.js` and the
tab-aware parts of `renderer.js` are the fork. When merging upstream commits,
check `CUSTOMIZATIONS.md` first; an upstream change that looks like an
improvement can quietly undo a fix here.

## Conventions

- **Commit directly to `main`.** This is a single-maintainer repository; there
  is no PR ceremony, and pushing does not need to be asked for. (Inherited
  `.cursor` / `.claude` rule files said otherwise; they were wrong for this repo
  and have been deleted — this file is the only agent guidance here.)
- **Stage named files, never `git add -A` or `git add .`.** Review `git status`
  and `git diff --stat` first. Two reasons, both learned here: the root
  directory carries untracked scratch output that must not be committed, and a
  bulk add can abort on `core.safecrlf` while the `commit` after it still
  succeeds — producing a commit that looks ordinary and contains a fraction of
  the change.
- **Never generate a review diff while the revert harness is running.** It will
  contain reverted code you did not write, and it reads exactly like a real
  finding.
- **Commit messages state the problem, not the patch.** The subject says what
  was wrong — "an oracle that accepts garbage is only half an oracle" — and the
  body explains how it was found, what was measured, and which revert proves it.
  They are the archaeology of this codebase; write them for the person who has
  to understand this in a year.
- **Never add a lint suppression to make something pass.** Fix the cause.
- **Do not add new tooling** (linters, frameworks, formatters) unless the task
  genuinely requires it.
- Fitted constants (`MS_PER_UNIT`, `FENCED_LINE_DISCOUNT`) are **derived, not
  chosen**. If the renderer's cost profile changes, re-derive them with the
  bench; do not nudge them by taste.
- Keep the app offline. Any new dependency that renders content must be
  vendored into `libs/` and added to the notices.
