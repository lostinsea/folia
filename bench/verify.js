// bench/verify.js - the corpus is what the manifest says it is
//
// Plain node, no Electron, deterministic and fast, so it belongs in `npm test`
// even though the TIMING runner (bench/run.js) deliberately does not: a timing
// assertion is how this project's suites would become flaky, and it would not
// say what broke.
//
// What this defends is narrow and worth stating: a benchmark corpus that drifts
// silently makes every recorded number a lie, and the drift is invisible
// because the benchmark still runs and still prints a plausible figure. So
// three independent things are checked, and each catches a different accident:
//
//   1. SHA-256 - any change to the generator at all, however small.
//   2. Token counts - the corpus is still made of the CONSTRUCTS it is named
//      for. This is the check that catches the real recorded failure: a table
//      split across two array entries degrades into paragraphs, which changes
//      the hash too, but only the token count says WHAT went wrong.
//   3. Determinism - generate() called twice in one process agrees. Catches an
//      accidental Math.random/Date dependency, which the hash alone would only
//      catch on the run that happened to differ.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const {
  PROFILES,
  RENDER_OPTIONS,
  generate,
  lexerCounts,
  lexTokens,
  renderHtml,
  REFERENCE_SIZES,
  BENCH_DEFAULT_SIZES,
  DIGEST_SIZES,
} = require("./corpus");

// AN ORACLE MAY NOT SHARE CODE WITH ITS SUBJECT.
//
// This used to import `sha256` from corpus.js - the very module every axis here
// exists to police - and a reviewer broke it by MEASUREMENT: he applied the
// round-7 column-swap mutation to the generator AND taught corpus.js's own
// `sha256()` to canonicalise the swapped rows back before hashing. Every digest
// cell still matched, so the axis advertised as "the one with no complement"
// had the largest complement of all - the entire hash function.
//
// It is the same fallacy this project has already been bitten by once, when a
// test judged a formula with a copy of that formula (test-tab-refresh.js
// Scenario 4). A hash computed by the subject is the subject's own opinion of
// itself.
//
// So the digest is computed HERE, from node's crypto, and corpus.js's helper is
// deliberately not imported. It is byte-identical today - plain sha256 over
// utf8, so no pin needed re-deriving - and that is exactly the point: the pins
// do not move, but they can no longer be moved BY the thing they describe.
function digest(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

// COUNT EVERY ELEMENT THE RENDER EMITS, NEVER A WHITELIST OF THEM.
//
// This was a whitelist (ELEMENT_NAMES) and BOTH independent reviewers broke it
// the same way: an element absent from the list is never counted, so it can be
// asserted neither present nor absent. Adding a hard line break to every prose
// paragraph put ~6000 extra <br> nodes into the 1MB document - real work for
// DOMPurify and for patchViewerDOM, the two passes this harness times most
// closely - and every one of the 126 assertions still passed with the manifest
// regenerated. Extending the list to cover <br> would have closed that one
// breaker and left the class open.
//
// So the mix is derived from the HTML itself and anything not explicitly
// pinned below is a FAILURE. Adding a construct to the corpus is then a
// deliberate act that must be recorded in ELEMENTS, rather than something that
// slips in unmeasured. Applying this immediately caught a second omission of my
// own that the whitelist had been hiding: <code> inside <pre> was never counted
// at all, so the code profile's most characteristic element was unpinned.
function countElements(html) {
  const tally = {};
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)(?=[\s>/])/g;
  let m;
  while ((m = re.exec(html))) tally[m[1]] = (tally[m[1]] || 0) + 1;
  return tally;
}

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : `  ${detail}`}`);
  }
}

const manifestPath = path.join(__dirname, "manifest.json");
if (!fs.existsSync(manifestPath)) {
  console.error("bench/manifest.json is missing - run `node bench/write-manifest.js`");
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

console.log("bench corpus verification");

// A manifest that has drifted out of step with the profile list would otherwise
// let a whole profile go unverified while every remaining assertion passes.
check(
  "the manifest describes exactly the profiles the corpus defines",
  JSON.stringify(Object.keys(manifest.profiles).sort()) === JSON.stringify([...PROFILES].sort()),
  `manifest=${Object.keys(manifest.profiles).sort()} corpus=${[...PROFILES].sort()}`,
);

// Vacuity floor. Without it, an empty manifest passes everything below by
// iterating over nothing - the "a conditional block that quietly does nothing
// is indistinguishable from an assertion that never existed" failure.
//
// It asserts on the MANIFEST, not merely on the corpus constants. An earlier
// version checked `PROFILES.length >= 6 && REFERENCE_SIZES.length >= 2`, which
// are compile-time constants of corpus.js: a manifest file containing
// `{"profiles":{}}` satisfied it completely, and the loop below then iterated
// over nothing while this "floor" reported that all was well.
{
  const cells = Object.values(manifest.profiles || {}).reduce(
    (n, entry) => n + REFERENCE_SIZES.filter((s) => entry && entry[String(s)]).length,
    0,
  );
  check(
    "the manifest really describes every profile at every reference size",
    PROFILES.length >= 6 &&
      REFERENCE_SIZES.length >= 2 &&
      cells === PROFILES.length * REFERENCE_SIZES.length,
    `${cells} pinned cells for ${PROFILES.length} profiles x ${REFERENCE_SIZES.length} sizes`,
  );
}

for (const profile of PROFILES) {
  const entry = manifest.profiles[profile];
  if (!entry) continue;
  for (const size of REFERENCE_SIZES) {
    const expected = entry[String(size)];
    const label = `${profile}@${Math.round(size / 1024)}KB`;
    if (!expected) {
      check(`${label} is described by the manifest`, false, "no entry");
      continue;
    }
    const text = generate(profile, size);

    check(
      `${label} reproduces the pinned bytes`,
      Buffer.byteLength(text, "utf8") === expected.bytes,
      `got ${Buffer.byteLength(text, "utf8")}, pinned ${expected.bytes}`,
    );
    check(
      `${label} reproduces the pinned sha256`,
      digest(text) === expected.sha256,
      `got ${digest(text).slice(0, 16)}, pinned ${expected.sha256.slice(0, 16)}`,
    );
    check(
      `${label} is byte-identical when generated twice`,
      generate(profile, size) === text,
      "generator is not deterministic",
    );

    const tokens = lexerCounts(text);
    check(
      `${label} still parses into the pinned block tokens`,
      JSON.stringify(tokens) === JSON.stringify(expected.tokens),
      `got ${JSON.stringify(tokens)}, pinned ${JSON.stringify(expected.tokens)}`,
    );
    // `blocks` was written into the manifest and never read, which made it
    // decorative data masquerading as a pin. It is a genuinely independent
    // axis from the token counts: marked merges and skips blocks, so a change
    // that leaves the token histogram intact while altering how the text is
    // divided moves this and nothing else.
    check(
      `${label} reproduces the pinned block count`,
      text.split("\n\n").length === expected.blocks,
      `got ${text.split("\n\n").length}, pinned ${expected.blocks}`,
    );
  }
}

// ---------------------------------------------------------------------------
// THE NON-REGENERABLE SHAPE SIGNATURE
// ---------------------------------------------------------------------------
// Everything above compares the corpus against the manifest, and the manifest
// is regenerated from whatever the generator currently emits. So a corpus
// broken at the same moment `write-manifest.js` is run would pin its own defect
// and compare equal forever. The checks below are HARD-CODED here and cannot be
// re-pinned by any script; they are what stands between that scenario and a
// silently meaningless benchmark.
//
// THE THRESHOLD IS EXACT, NOT LOOSE, AND THAT WAS MEASURED. An earlier version
// asserted only that the named construct held >= 40% of the tokens. Appending
// one prose paragraph after every table in the `tables` profile - so that the
// profile is half prose and no longer measures what its name claims - produces
// `{table:128, paragraph:128}`, a share of exactly 0.500, and sailed through.
// The real shares are not approximate: every profile emits a fixed repeating
// unit, so each share is an exact rational that is IDENTICAL at 64KB and at
// 1MB (measured). Pinning the exact share and the exact token-type SET rejects
// that mutation on both counts - the share moves 1.000 -> 0.500 and an
// unexpected `paragraph` type appears.
const SHAPE = {
  prose: { paragraph: 1 },
  headings: { heading: 1 / 2, paragraph: 1 / 2 },
  tables: { table: 1 },
  lists: { list: 1 },
  code: { code: 1 },
  // dense emits 1 heading + 2 paragraphs + 2 lists + 1 table + 1 code per
  // iteration, so the sevenths below are the builder's design intent stated as
  // an assertion rather than a comment.
  dense: {
    heading: 1 / 7,
    paragraph: 2 / 7,
    list: 2 / 7,
    table: 1 / 7,
    code: 1 / 7,
  },
  wide: { table: 1 },
};
// TOLERANCE IS ESSENTIALLY ZERO, AND THAT IS THE POINT. generate() only tests
// the byte target between whole builder iterations (see the comment on
// generate() in corpus.js), and each iteration emits a fixed construct mix, so
// the token total is always an exact multiple of that mix - dense emits 7
// tokens per iteration at every size, headings 2. The shares are therefore
// exact rationals, not approximations, and MEASURED exact to six decimal places
// at both reference sizes. The previous 0.02 admitted 2% of drift the generator
// structurally cannot produce, which is 2% of room for a builder change to move
// a profile's composition without failing anything. The residual allowance is
// float representation error only.
const SHARE_TOLERANCE = 1e-9;
for (const [profile, shape] of Object.entries(SHAPE)) {
  for (const size of REFERENCE_SIZES) {
    const label = `${profile}@${Math.round(size / 1024)}KB`;
    const tokens = lexerCounts(generate(profile, size));
    const total = Object.values(tokens).reduce((a, b) => a + b, 0);
    // The token-type SET is checked as well as the proportions. A share test
    // alone cannot see a construct that was ADDED in small quantities, and
    // "the corpus grew a type nobody asked for" is exactly how a profile stops
    // measuring the thing it is named after.
    const got = Object.keys(tokens).sort().join(",");
    const want = Object.keys(shape).sort().join(",");
    check(
      `${label} is made of exactly the constructs its profile names`,
      got === want,
      `got [${got}], expected [${want}]`,
    );
    const off = Object.entries(shape)
      .map(([type, share]) => [type, (tokens[type] || 0) / total - share])
      .filter(([, d]) => Math.abs(d) > SHARE_TOLERANCE);
    check(
      `${label} holds the exact construct proportions`,
      total > 0 && off.length === 0,
      off.length
        ? off.map(([t, d]) => `${t} off by ${d.toFixed(3)}`).join(", ")
        : `total=${total} ${JSON.stringify(tokens)}`,
    );
  }
}

// A SECOND, INDEPENDENT AXIS: THE CONSTRUCTS MUST NOT BE DEGENERATE.
// Token counts and proportions are both blind to a table that has collapsed to
// one column and one row, or a fenced block containing a single line. The
// corpus would still be "made of tables" and would still hash consistently
// while measuring almost nothing - and the whole reason this corpus isolates
// constructs is that construct COST is what the ratios are reading.
// Every figure below was measured on the current corpus and is exact
// (min === max across every token at both reference sizes).
//
// A PROFILE WITH NO SUCH CONSTRUCTS IS PINNED AS `{}`, NOT OMITTED, and the
// empty pin is an assertion rather than a shrug. `prose` and `headings` were
// simply absent from this object until the profile-coverage check below was
// written, and absent is indistinguishable from forgotten - the same "an item
// not on the list is never counted" defect that made axes 3, 5, 6 and 7
// exhaustive. Writing `prose: {}` says "this profile has no tables, lists or
// fenced blocks", and the loop now CHECKS that claim, so the empty pin cannot
// be a vacuous pass either.
const INTERNALS = {
  prose: {},
  headings: {},
  tables: { headerCells: 4, rows: 5 },
  lists: { items: 2 },
  code: { lines: 2 },
  dense: { headerCells: 4, rows: 5, items: 2, lines: 2 },
  // Ten header cells is the whole reason this profile exists: it is what takes
  // the table past the reading column and into applyTableBreakout's widening
  // path. A change that narrowed it back to `tables`' four would silently
  // return the benchmark to timing only the no-op path.
  wide: { headerCells: 10, rows: 5 },
};
for (const [profile, want] of Object.entries(INTERNALS)) {
  const toks = lexTokens(generate(profile, REFERENCE_SIZES[0]));
  const problems = [];
  const sweep = (type, name, read) => {
    if (want[name] === undefined) return;
    const seen = toks.filter((t) => t.type === type).map(read);
    if (!seen.length) problems.push(`no ${type} tokens at all`);
    else if (Math.min(...seen) !== want[name] || Math.max(...seen) !== want[name]) {
      problems.push(`${name} ${Math.min(...seen)}..${Math.max(...seen)}, expected ${want[name]}`);
    }
  };
  sweep("table", "headerCells", (t) => (t.header || []).length);
  sweep("table", "rows", (t) => (t.rows || []).length);
  sweep("list", "items", (t) => (t.items || []).length);
  sweep("code", "lines", (t) => String(t.text || "").split("\n").length);
  // THE UNPINNED CONSTRUCTS ARE A CLAIM TOO. Saying nothing about tables in the
  // prose profile is only safe if prose really has none; if it ever grew one,
  // this axis would be silent about the construct it exists to police. So every
  // construct WITHOUT a pin must be absent, which turns each omission into a
  // positive statement instead of a gap.
  for (const [type, names] of [
    ["table", ["headerCells", "rows"]],
    ["list", ["items"]],
    ["code", ["lines"]],
  ]) {
    if (names.some((n) => want[n] !== undefined)) continue;
    const n = toks.filter((t) => t.type === type).length;
    if (n) problems.push(`${n} ${type} tokens, but none are pinned, so none are being checked`);
  }
  check(
    `the ${profile} profile's constructs are not degenerate`,
    problems.length === 0,
    problems.join("; "),
  );
}

// ---------------------------------------------------------------------------
// AXIS 3: RENDERED ELEMENT MIX, per top-level token. Also NOT regenerable.
//
// The two axes above describe the token stream. The benchmark does not time the
// token stream - it times DOM construction, sanitising, and the table and
// highlighting passes, all of which are driven by ELEMENTS. Two corpora with an
// identical token stream can render a materially different DOM, so a pin on
// tokens alone is not a pin on the thing being measured.
//
// This closed a real hole. Both round-2 reviewers independently constructed
// corpus mutations that passed every token-based assertion after the manifest
// was regenerated. One dropped the ordered-list half of the lists builder:
// every top-level token is still a `list`, share still 1.000, items still 2 -
// and `ol` per token falls from 0.500 to 0. That is invisible on axes 1 and 2
// and obvious here.
//
// The figures are ratios to the top-level token count rather than absolute
// counts, which is what makes them size-independent: every one below was
// measured identical at 64KB and at 1MB, so they are exact rationals and not
// approximations. tables reads 4 header cells + 5 rows as th=4, tr=6, td=20;
// headings reads its five depths as 0.100 each.
const ELEMENTS = {
  prose: { p: 1 },
  headings: { h1: 0.1, h2: 0.1, h3: 0.1, h4: 0.1, h5: 0.1, p: 0.5 },
  tables: { table: 1, thead: 1, tbody: 1, th: 4, tr: 6, td: 20 },
  lists: { ul: 1, ol: 0.5, li: 3 },
  code: { pre: 1, code: 1 },
  dense: {
    h1: 1 / 35,
    h2: 1 / 35,
    h3: 1 / 35,
    h4: 1 / 35,
    h5: 1 / 35,
    p: 2 / 7,
    ul: 2 / 7,
    ol: 1 / 7,
    li: 6 / 7,
    table: 1 / 7,
    thead: 1 / 7,
    tbody: 1 / 7,
    th: 4 / 7,
    tr: 6 / 7,
    td: 20 / 7,
    pre: 1 / 7,
    code: 1 / 7,
  },
  wide: { table: 1, thead: 1, tbody: 1, th: 10, tr: 6, td: 50 },
};
// 1% of the smallest pinned ratio. Deliberately not a share tolerance: these
// are exact rationals, so anything beyond rounding is a real change.
const ELEMENT_TOLERANCE = 0.005;
for (const [profile, want] of Object.entries(ELEMENTS)) {
  for (const size of REFERENCE_SIZES) {
    const md = generate(profile, size);
    const html = renderHtml(md);
    const tokens = lexTokens(md).length;
    const seenCounts = countElements(html);
    const seen = {};
    for (const el of Object.keys(seenCounts)) seen[el] = seenCounts[el] / tokens;
    const problems = [];
    for (const el of new Set([...Object.keys(want), ...Object.keys(seen)])) {
      const a = seen[el] || 0;
      const b = want[el] || 0;
      if (Math.abs(a - b) > ELEMENT_TOLERANCE) {
        problems.push(
          b === 0
            ? `${el} is not pinned for this profile but renders ${a.toFixed(3)} per token`
            : `${el} ${a.toFixed(3)} per token, expected ${b.toFixed(3)}`,
        );
      }
    }
    check(
      `the ${profile} profile renders the pinned element mix at ${size / 1024}KB`,
      problems.length === 0,
      problems.join("; "),
    );
  }
}

// ---------------------------------------------------------------------------
// AXIS 5: RENDERED ATTRIBUTES. Also NOT regenerable, and the same shape as the
// element axis: anything not pinned is a failure.
//
// BOTH round-4 reviewers found the same breaker independently, again: swap the
// code fence language from ```js to ```py (or sh, ts, cs - all 2 chars, so the
// texture means do not move) and regenerate the manifest. Every one of the 128
// assertions passed. The element axis could not see it because countElements
// reads the TAG NAME only: <code class="language-js"> and
// <code class="language-py"> are both `code`.
//
// It is material, and it was MEASURED rather than argued - the two reviewers
// actually disagreed about the mechanism, which is what forced the measurement.
// One claimed the bundled Prism ships no python grammar so highlighting would
// drop to zero; the other measured Prism token spans falling from 172,872 to
// 144,060 on the 1MB code corpus. Loading libs/prismjs/prism-bundle.js in a VM
// and listing the real grammars settled it: the bundle DOES ship python, sh,
// bash, java, cpp, cs and ts - the file's own header comments under-list what
// is in it - so the second reviewer was right. Highlighting the same snippet
// gives 15 spans as js against 11 as py. Prism was measured in an earlier round
// at 1160ms of the code profile's 2156ms of deferred work at 1MB, so a ~25%
// swing in the token count it produces is a real change to the largest deferred
// phase in the corpus.
//
// The measured attribute surface is tiny - four profiles emit NO attributes at
// all, and code/dense emit only class="language-js" - so pinning it exhaustively
// costs almost nothing and closes the channel rather than this one breaker.
// It will also fail loud if a future marked emits heading ids or table
// alignment attributes, which both reviewers agreed is correct behaviour that
// should force deliberate re-pinning.
// This recognises DOUBLE-QUOTED attribute values only, which is what marked
// emits today. That is a deliberate narrowing, not an oversight - the pins
// below are literal strings containing those quotes, so widening the parser to
// normalise `class='x'` into `class="x"` would silently re-interpret pinned
// values rather than reporting that the renderer's output shape moved.
//
// The hazard a narrow parser carries is that it fails SILENTLY: a tag carrying
// a single-quoted or unquoted value does not match tagRe at all, so the tag
// drops out of the tally entirely and its attributes read as absent. In the
// pinned direction that surfaces as a shortfall, but a NEW attribute arriving
// in a quoting style this parser cannot read would be invisible - which is the
// whitelist disease that has already cost this suite thead/tbody, <br>, <code>
// and unpinned text content.
//
// So the parser refuses rather than guesses: every tag a permissive scan can
// see must also have been consumed by the strict one, and any shortfall is
// reported as a named failure telling the reader to re-derive the pins.
function countAttributes(html) {
  const tally = {};
  const unreadable = [];
  // THE PERMISSIVE SCAN SKIPS OVER QUOTED REGIONS. A naive `[^>]*` stops at the
  // first `>` even when it is inside a legal attribute value, so `class="a>b"`
  // would be truncated to `<span class="a>` - which the strict parser then
  // rejects, and the two would disagree about a tag that is not malformed at
  // all. That is a false positive rather than a hole (the axis fails loud
  // instead of miscounting), but a guard that cries wolf on legal input is one
  // a future reader widens a tolerance to silence. The strict parser and the
  // tally regex below both already tolerate `>` inside a value, so this is the
  // only place the two could have diverged.
  const permissiveRe = /<[a-zA-Z][a-zA-Z0-9-]*(?:\s+(?:"[^"]*"|'[^']*'|[^>"'])*)?\s*\/?>/g;
  const strictRe = /^<[a-zA-Z][a-zA-Z0-9-]*((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*\/?>$/;
  let seen;
  while ((seen = permissiveRe.exec(html))) {
    if (!strictRe.test(seen[0]) && unreadable.length < 5) unreadable.push(seen[0]);
  }
  const tagRe = /<[a-zA-Z][a-zA-Z0-9-]*((?:\s+[a-zA-Z-]+(?:="[^"]*")?)+)\s*\/?>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const attrRe = /([a-zA-Z-]+)(?:="([^"]*)")?/g;
    let a;
    while ((a = attrRe.exec(m[1]))) {
      const key = a[2] === undefined ? a[1] : `${a[1]}="${a[2]}"`;
      tally[key] = (tally[key] || 0) + 1;
    }
  }
  return { tally, unreadable };
}

const ATTRIBUTES = {
  prose: {},
  headings: {},
  tables: {},
  lists: {},
  code: { 'class="language-js"': 1 },
  dense: { 'class="language-js"': 1 / 7 },
  wide: {},
};
// A POSITIVE CONTROL, so the refusal above cannot quietly stop refusing. Every
// assertion in this axis reads `unreadable` being EMPTY as good news, and an
// empty array is also what a parser that has stopped looking returns. These two
// lines are the difference between "nothing unreadable was found" and "the
// search for unreadable tags works".
{
  const bad = countAttributes(`<span class='x'>y</span>`);
  const good = countAttributes(`<span class="x">y</span>`);
  check(
    "the attribute parser reports a value it cannot read rather than skipping it",
    bad.unreadable.length === 1 && good.unreadable.length === 0,
    `single-quoted ${JSON.stringify(bad.unreadable)}, double-quoted ${JSON.stringify(good.unreadable)}`,
  );

  // THE TWO PARSERS MUST AGREE ON LEGAL INPUT, not merely disagree on illegal
  // input. `>` inside a double-quoted value is valid HTML that the strict
  // parser accepts, so if the permissive scan truncated there the pair would
  // manufacture an "unreadable" tag out of a well-formed one - the guard
  // failing on the very documents it is meant to pass. Asserting the VALUE is
  // tallied whole, not just that nothing was reported, is what makes this a
  // check on the parse rather than on the complaint.
  const angle = countAttributes(`<span class="a>b">y</span>`);
  check(
    "a legal attribute value containing > is read whole by both parsers",
    angle.unreadable.length === 0 && angle.tally['class="a>b"'] === 1,
    `unreadable ${JSON.stringify(angle.unreadable)}, tally ${JSON.stringify(angle.tally)}`,
  );
}

for (const [profile, want] of Object.entries(ATTRIBUTES)) {
  for (const size of REFERENCE_SIZES) {
    const md = generate(profile, size);
    const { tally: counts, unreadable } = countAttributes(renderHtml(md));
    const tokens = lexTokens(md).length;
    const problems = [];
    if (unreadable.length) {
      problems.push(
        `the attribute parser could not read ${unreadable.length}+ tags, e.g. ${unreadable
          .map((t) => JSON.stringify(t))
          .join(", ")} - it recognises double-quoted values only, so the pins below must be re-derived rather than the parser widened in place`,
      );
    }
    for (const key of new Set([...Object.keys(want), ...Object.keys(counts)])) {
      const a = (counts[key] || 0) / tokens;
      const b = want[key] || 0;
      if (Math.abs(a - b) > ELEMENT_TOLERANCE) {
        problems.push(
          b === 0
            ? `${key} is not pinned for this profile but renders ${a.toFixed(3)} per token`
            : `${key} ${a.toFixed(3)} per token, expected ${b.toFixed(3)}`,
        );
      }
    }
    check(
      `the ${profile} profile renders the pinned attributes at ${size / 1024}KB`,
      problems.length === 0,
      problems.join("; "),
    );
  }
}

// THE CORPUS'S RENDER OPTIONS MUST BE THE APP'S, NOT A COPY THAT HAPPENS TO
// AGREE. A hard-coded copy of another file's setting is precisely the
// silent-divergence class this project keeps hitting: the value is correct on
// the day it is written and nothing notices when the other side moves.
//
// This checks the WHOLE option block, not one key. The first version compared
// only `breaks` and a reviewer correctly pointed out that marked applies
// per-call options INSTEAD OF the globals, so the others were silently coming
// from library defaults - `mangle` genuinely differed (renderer.js set false,
// the default is true).
//
// The 9 -> 18 upgrade resolved that: `mangle` and `headerIds` were deleted from
// both sides, because they had been removed from marked's CORE in v8/v9 and so
// could never have become live again. The block is now `breaks` and `gfm`, and
// this assertion is what stops the two copies drifting apart on the next
// upgrade.
//
// FAIL-LOUD ON ANYTHING IT CANNOT PARSE. If the block cannot be found, or holds
// a value that is not a boolean literal, this reports that rather than quietly
// checking a subset - the "a parser with no end marker reports on text nobody
// claimed it was reading" lesson.
{
  const src = fs.readFileSync(path.join(__dirname, "..", "renderer.js"), "utf8");
  const start = src.indexOf("marked.setOptions({");
  const end = start === -1 ? -1 : src.indexOf("});", start);
  check(
    "renderer.js has exactly one parseable marked.setOptions block",
    start !== -1 && end !== -1 && src.indexOf("marked.setOptions({", start + 1) === -1,
    `start=${start} end=${end}`,
  );
  if (start !== -1 && end !== -1) {
    const body = src.slice(start + "marked.setOptions({".length, end);
    const app = {};
    const unparsed = [];
    for (const line of body.split("\n")) {
      const bare = line.replace(/\/\/.*$/, "").trim().replace(/,$/, "");
      if (!bare) continue;
      const m = bare.match(/^([a-zA-Z_$][\w$]*)\s*:\s*(true|false)$/);
      if (m) app[m[1]] = m[2] === "true";
      else unparsed.push(bare);
    }
    check(
      "every option renderer.js passes to marked is a boolean this check understands",
      unparsed.length === 0,
      `could not parse: ${unparsed.join(" | ")}`,
    );
    const keys = [...new Set([...Object.keys(app), ...Object.keys(RENDER_OPTIONS)])].sort();
    const diffs = keys
      .filter((k) => app[k] !== RENDER_OPTIONS[k])
      .map((k) => `${k}: renderer.js=${app[k]}, corpus=${RENDER_OPTIONS[k]}`);
    check(
      "the corpus renders with exactly the marked options the app renders with",
      diffs.length === 0,
      `${diffs.join("; ")}. The rendered-element, attribute and texture pins ` +
        `describe a parse the benchmark does not perform.`,
    );
  }
}

// ---------------------------------------------------------------------------
// AXIS 4: CONTENT EXTENT AND INLINE TEXTURE. Also NOT regenerable.
//
// Axes 1-3 constrain structure; none of them constrains how much text sits
// inside that structure, and the cost of every pass the benchmark times scales
// with it. Both round-2 reviewers broke the earlier version here, from opposite
// directions and with the same root cause - `prose` and `headings` had no
// degeneracy entry at all:
//
//   * collapse every prose paragraph to one word: still {paragraph: 1.000},
//     but 191 paragraphs at 64KB becomes 8331. Measured.
//   * fill every prose paragraph with inline code, emphasis and links: still
//     {paragraph: 1.000}, but inline elements go from 0 to 877 at 64KB, which
//     is a completely different sanitising and DOM workload. Measured.
//
// So: a floor and a mean on both WORDS and CHARACTERS per top-level token, and
// an explicit statement that this corpus carries NO inline markup.
//
// Words and characters are both pinned because neither subsumes the other, and
// that is measured rather than assumed: shortening every table cell from
// "value-3" to "v" leaves the word count of the block exactly unchanged and
// takes ~6% off its characters. That mutation passed the words-only version of
// this axis at 126/126 while changing DOMPurify's per-cell work, the text-node
// sizes applyTableBreakout measures, and - because the corpus generates to a
// byte target - the number of tables in the document.
//
// The means are pinned PER REFERENCE SIZE rather than shared. Generation is
// deterministic, so each size has one exact answer, and smearing them together
// would have forced a tolerance (~2.5%) wide enough to hide the very collapse
// above. The floors are deliberately looser than the measured minima: a minimum
// over a random sample drifts downward as the sample grows (prose's thinnest
// paragraph is 236 characters at 64KB and 221 at 1MB), so a floor pinned tight
// to today's minimum would fail on a larger document for no real reason.
//
// The inline rule is not a tolerance at all but an exact relationship - every
// <code> element in the corpus comes from a fenced block, so their count must
// equal the count of `code` tokens exactly, and strong/em/link/img must not
// appear. That is deliberate: inline constructs are a dimension this corpus
// does not vary, and the moment one appears the profiles no longer isolate what
// they claim to.
const TEXTURE = {
  prose: {
    minWords: 20,
    minChars: 180,
    at: { 65536: { words: 40.11, chars: 341.57 }, 1048576: { words: 40.48, chars: 348.31 } },
  },
  headings: {
    minWords: 5,
    minChars: 28,
    at: { 65536: { words: 9.74, chars: 78.22 }, 1048576: { words: 9.76, chars: 79.59 } },
  },
  tables: {
    minWords: 80,
    minChars: 470,
    at: { 65536: { words: 80, chars: 512.2 }, 1048576: { words: 80, chars: 524.77 } },
  },
  lists: {
    minWords: 10,
    minChars: 58,
    at: { 65536: { words: 17.5, chars: 133.98 }, 1048576: { words: 17.5, chars: 134.52 } },
  },
  code: {
    minWords: 14,
    minChars: 88,
    at: { 65536: { words: 14, chars: 102.83 }, 1048576: { words: 14, chars: 107.18 } },
  },
  dense: {
    minWords: 5,
    minChars: 30,
    at: { 65536: { words: 27.07, chars: 196.55 }, 1048576: { words: 27.03, chars: 199.35 } },
  },
  // Every block in this profile is byte-identical in SHAPE - only the padded
  // index differs - so the means are integers and do not move with size. That
  // is the property the widening trigger depends on: a table whose width drifted
  // with the document would make the breakout decision a function of file size.
  wide: {
    minWords: 120,
    minChars: 880,
    at: { 65536: { words: 127, chars: 895 }, 1048576: { words: 127, chars: 895 } },
  },
};
// 2% against a per-size pin. The pinned value is exactly reproducible, so this
// only has to absorb the generator's own byte-target rounding.
const MEAN_TOLERANCE = 0.02;
for (const [profile, want] of Object.entries(TEXTURE)) {
  for (const size of REFERENCE_SIZES) {
    const md = generate(profile, size);
    const toks = lexTokens(md);
    const raw = toks.map((t) => String(t.raw || "").trim());
    const words = raw.map((r) => (r.match(/\S+/g) || []).length);
    const chars = raw.map((r) => r.length);
    const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const pin = want.at[size];
    const problems = [];
    if (Math.min(...words) < want.minWords) {
      problems.push(`thinnest block has ${Math.min(...words)} words, floor is ${want.minWords}`);
    }
    if (Math.min(...chars) < want.minChars) {
      problems.push(`thinnest block has ${Math.min(...chars)} chars, floor is ${want.minChars}`);
    }
    for (const [name, seen, expected] of [
      ["words", mean(words), pin.words],
      ["chars", mean(chars), pin.chars],
    ]) {
      if (Math.abs(seen - expected) / expected > MEAN_TOLERANCE) {
        problems.push(`mean ${seen.toFixed(2)} ${name} per block, pinned at ${expected}`);
      }
    }
    check(
      `the ${profile} profile's blocks carry their pinned amount of text at ${size / 1024}KB`,
      problems.length === 0,
      problems.join("; "),
    );

    const html = renderHtml(md);
    const codeEls = (html.match(/<code[ >]/g) || []).length;
    const fenced = toks.filter((t) => t.type === "code").length;
    const stray = {};
    for (const el of ["strong", "em", "a", "img"]) {
      const n = (html.match(new RegExp("<" + el + "[ >]", "g")) || []).length;
      if (n) stray[el] = n;
    }
    check(
      `the ${profile} profile carries no inline markup at ${size / 1024}KB`,
      codeEls === fenced && Object.keys(stray).length === 0,
      codeEls !== fenced
        ? `${codeEls} <code> elements against ${fenced} fenced blocks`
        : `inline ${JSON.stringify(stray)}`,
    );
  }
}


// AXIS 6: TEXT SHAPE. Also NOT regenerable.
//
// BOTH round-5 reviewers, independently and without coordinating, broke the
// five-axis set the same way: TEXT CONTENT INSIDE A PINNED EXTENT IS NOT
// PINNED. Axes 1-3 and 5 describe structure, and axis 4 describes how MUCH text
// sits in it - how many words, how many characters - but nothing described what
// those characters ARE or how they are distributed. Two different exploits of
// the same hole:
//
//   * Fuse three table-cell words into one and split another to compensate.
//     MEASURED, end to end, against the real write-manifest.js and verify.js:
//     50 chars and 6 words before and after, so axis 4 cannot see it, and
//     141/141 still passed with the manifest regenerated. The longest unbroken
//     run in the cell went 9 -> 22. That is a direct input to
//     measureTextColumnCap() and applyTableBreakout(), which is 345-1524ms of
//     the tables profile - i.e. the mutation quietly re-benchmarks the one pass
//     this application exists to get right.
//
//   * Rewrite the code-fence body with regex literals and template
//     interpolation, changing what Prism has to tokenise. Prism is 1160ms of
//     the code profile's 2156ms at 1MB, the largest deferred phase in the
//     corpus. (The version as proposed was caught by axis 4 on word count -
//     17 against a pinned 14 - but only because it was not tuned to match; the
//     class is real even though that instance was not.)
//
// So this axis pins the two properties those exploits move and nothing else
// observes:
//
//   1. THE CHARACTER-CLASS HISTOGRAM, per top-level token. Letters, digits,
//      spaces and newlines are grouped; every other character is pinned
//      INDIVIDUALLY, because punctuation is precisely what a syntax
//      highlighter's cost is made of - a regex literal is `/`, `^`, `\`, `+`
//      and `$` appearing where they did not before.
//   2. THE RUN-LENGTH DISTRIBUTION - the mean of each block's longest unbroken
//      non-space run, and the longest in the document. This is the layout
//      dimension: wrap opportunities, min-content width, and what a column cap
//      measured in characters actually has to accommodate. The word-fusion
//      breaker preserves the character histogram EXACTLY (it moves two spaces
//      rather than adding or removing any), so the histogram alone would not
//      have caught it and the runs alone would not have caught the code-fence
//      one. Both halves are load-bearing; neither subsumes the other.
//
// EXHAUSTIVE, like axes 3 and 5, and for the same reason. Every character is
// classified and anything not pinned is a failure that names itself. A
// whitelist here would be the fourth instance of the defect that has already
// cost this suite thead/tbody, <br> and <code>.
//
// PINNED PER REFERENCE SIZE, like axis 4's means. Digit counts genuinely move
// with document length - the generator writes the iteration index into the
// text, so prose carries 7.27 digits per block at 64KB and 10.89 at 1MB - and a
// shared pin would need a 50% tolerance, which is no pin at all.
//
// These literals were GENERATED from the corpus and spliced in, not transcribed.
// There are about 130 of them and a transcription error in one would read as a
// passing assertion about a number nobody chose.
const TEXT_SHAPE = {
  prose: {
    65536: {
      maxRun: 10,
      meanBlockMaxRun: 9.9895,
      chars: { ".": 3, "alpha": 292.1832, "digit": 7.2723, "space": 39.1099 },
    },
    1048576: {
      maxRun: 10,
      meanBlockMaxRun: 9.9916,
      chars: { ".": 3, "alpha": 294.9402, "digit": 10.8878, "space": 39.4813 },
    },
  },
  headings: {
    65536: {
      maxRun: 10,
      meanBlockMaxRun: 9.4597,
      chars: { "#": 1.4976, ".": 0.5, "alpha": 64.7518, "digit": 2.7311, "space": 8.7396 },
    },
    1048576: {
      maxRun: 10,
      meanBlockMaxRun: 9.4926,
      chars: { "#": 1.4998, ".": 0.5, "alpha": 65.0038, "digit": 3.8273, "space": 8.7596 },
    },
  },
  tables: {
    65536: {
      maxRun: 17,
      meanBlockMaxRun: 17,
      chars: { "-": 27, "_": 10, "alpha": 324.7891, "digit": 36.4063, "newline": 6, "space": 73, "|": 35 },
    },
    1048576: {
      maxRun: 17,
      meanBlockMaxRun: 17,
      chars: { "-": 27, "_": 10, "alpha": 324.3435, "digit": 49.4249, "newline": 6, "space": 73, "|": 35 },
    },
  },
  lists: {
    65536: {
      maxRun: 10,
      meanBlockMaxRun: 9.7624,
      chars: { "-": 2, ".": 1, "alpha": 110.2107, "digit": 2.2727, "newline": 2, "space": 16.5 },
    },
    1048576: {
      maxRun: 10,
      meanBlockMaxRun: 9.7712,
      chars: { "-": 2, ".": 1, "alpha": 110.159, "digit": 2.856, "newline": 2, "space": 16.5 },
    },
  },
  code: {
    65536: {
      maxRun: 15,
      meanBlockMaxRun: 14.8243,
      chars: { "'": 2, "(": 3, ")": 3, ",": 1, ";": 2, "=": 1, "`": 6, "alpha": 58.5304, "digit": 11.2971, "newline": 3, "space": 10, "{": 1, "}": 1 },
    },
    1048576: {
      maxRun: 16,
      meanBlockMaxRun: 15.8844,
      chars: { "'": 2, "(": 3, ")": 3, ",": 1, ";": 2, "=": 1, "`": 6, "alpha": 58.6443, "digit": 15.5377, "newline": 3, "space": 10, "{": 1, "}": 1 },
    },
  },
  dense: {
    65536: {
      maxRun: 17,
      meanBlockMaxRun: 11.3333,
      chars: { "#": 0.4196, "'": 0.2857, "(": 0.4286, ")": 0.4286, ",": 0.1429, "-": 4.4286, ".": 0.8571, ";": 0.2857, "=": 0.1429, "_": 1.4286, "`": 0.8571, "alpha": 147.369, "digit": 7.5476, "newline": 1.8571, "space": 24.7887, "{": 0.1429, "|": 5, "}": 0.1429 },
    },
    1048576: {
      maxRun: 17,
      meanBlockMaxRun: 11.4871,
      chars: { "#": 0.4286, "'": 0.2857, "(": 0.4286, ")": 0.4286, ",": 0.1429, "-": 4.4286, ".": 0.8571, ";": 0.2857, "=": 0.1429, "_": 1.4286, "`": 0.8571, "alpha": 147.1651, "digit": 10.5781, "newline": 1.8571, "space": 24.7469, "{": 0.1429, "|": 5, "}": 0.1429 },
    },
  },
  // IDENTICAL AT BOTH SIZES, TO THE CHARACTER, AND THAT IS AN ASSERTION RATHER
  // THAN A COINCIDENCE. Every other profile's digit count drifts with document
  // length because the generator writes an unpadded iteration index into the
  // text - prose carries 7.27 digits per block at 64KB and 10.89 at 1MB. This
  // profile pads that index to six characters precisely so its column widths
  // cannot move with the document, and these two identical rows are what will
  // fail if the padding is ever removed.
  //
  // maxRun is 41, and it is the `|---|---|...` separator row rather than any
  // cell: with ten columns the separator is the longest unbroken run in the
  // block. meanBlockMaxRun equals it exactly because every block has the same
  // shape.
  wide: {
    65536: {
      maxRun: 41,
      meanBlockMaxRun: 41,
      chars: { "-": 130, "alpha": 212, "digit": 350, "newline": 6, "space": 120, "|": 77 },
    },
    1048576: {
      maxRun: 41,
      meanBlockMaxRun: 41,
      chars: { "-": 130, "alpha": 212, "digit": 350, "newline": 6, "space": 120, "|": 77 },
    },
  },
};

// Deterministic generation, so the only error to absorb is the 4-decimal
// rounding of the pins above. Same value as the element axis.
const SHAPE_CHAR_TOLERANCE = 0.005;
function classifyChars(s) {
  const tally = {};
  for (const ch of s) {
    let k;
    if (/[A-Za-z]/.test(ch)) k = "alpha";
    else if (/[0-9]/.test(ch)) k = "digit";
    else if (ch === " ") k = "space";
    else if (ch === "\n") k = "newline";
    else k = ch;
    tally[k] = (tally[k] || 0) + 1;
  }
  return tally;
}
for (const [profile, want] of Object.entries(TEXT_SHAPE)) {
  for (const size of REFERENCE_SIZES) {
    const toks = lexTokens(generate(profile, size));
    const raw = toks.map((t) => String(t.raw || "").trim());
    const n = toks.length;
    const pin = want[size];
    const tally = {};
    let maxRun = 0;
    let sumBlockMax = 0;
    for (const r of raw) {
      const c = classifyChars(r);
      for (const k of Object.keys(c)) tally[k] = (tally[k] || 0) + c[k];
      const runs = (r.match(/\S+/g) || []).map((w) => w.length);
      const blockMax = runs.length ? Math.max(...runs) : 0;
      sumBlockMax += blockMax;
      if (blockMax > maxRun) maxRun = blockMax;
    }

    const problems = [];
    // Every class the corpus emits must be pinned, and every class pinned must
    // still be emitted. A character class that appears from nowhere is exactly
    // how the <br> and <code> omissions hid.
    for (const cls of Object.keys(tally).sort()) {
      const per = tally[cls] / n;
      if (!(cls in pin.chars)) {
        problems.push(`${JSON.stringify(cls)} is not pinned but occurs ${per.toFixed(3)} per token`);
        continue;
      }
      const expected = pin.chars[cls];
      if (Math.abs(per - expected) / Math.max(expected, 1e-9) > SHAPE_CHAR_TOLERANCE) {
        problems.push(`${JSON.stringify(cls)} occurs ${per.toFixed(3)} per token, pinned at ${expected}`);
      }
    }
    for (const cls of Object.keys(pin.chars)) {
      if (!(cls in tally)) problems.push(`${JSON.stringify(cls)} is pinned but no longer occurs`);
    }
    check(
      `the ${profile} profile's text is made of the pinned characters at ${size / 1024}KB`,
      problems.length === 0,
      problems.join("; "),
    );

    // The run lengths are a separate assertion rather than more problems in the
    // one above, so a layout-shaped change and a highlighting-shaped change
    // cannot be confused for each other in the failure output.
    const runProblems = [];
    if (maxRun !== pin.maxRun) {
      runProblems.push(`longest unbroken run is ${maxRun}, pinned at ${pin.maxRun}`);
    }
    const meanBlockMax = sumBlockMax / n;
    if (
      Math.abs(meanBlockMax - pin.meanBlockMaxRun) / pin.meanBlockMaxRun >
      SHAPE_CHAR_TOLERANCE
    ) {
      runProblems.push(
        `mean longest run per block is ${meanBlockMax.toFixed(3)}, pinned at ${pin.meanBlockMaxRun}`,
      );
    }
    check(
      `the ${profile} profile's text wraps where it is pinned to at ${size / 1024}KB`,
      runProblems.length === 0,
      runProblems.join("; "),
    );
  }
}

// AXIS 7: SYNTAX HIGHLIGHTING. Also NOT regenerable.
//
// EVERY AXIS ABOVE MEASURES marked's OUTPUT OR ITS INPUT. NOTHING MEASURES
// PRISM - and Prism is 1160ms of the code profile's 2156ms of post-resolve time
// at 1MB, the single largest deferred phase in the whole corpus. Six axes
// therefore described everything about the benchmark except its most expensive
// pass.
//
// This was found by the round-6 review, and it was MEASURED end to end rather
// than argued: uppercasing the two keywords in BUILDERS.code (`const` -> `CONST`,
// `if` -> `IF`) passes 166/166 WITH A REGENERATED MANIFEST. Every axis is
// silent for a reason that is individually correct - SHAPE, INTERNALS, ELEMENTS
// and ATTRIBUTES all see marked's `<pre><code class="language-js">` wrapper and
// never look inside it; TEXTURE sees identical word and character counts
// (`const`/`CONST` are both 5 characters); axis 6 groups A-Z with a-z, so the
// histogram is identical to the byte and so are the run lengths.
//
// What actually moves is measured here, in this file's own VM, on the same
// bundle the app loads:
//
//     const value0 = ... / if (...)     18 spans   keyword 2
//     CONST value0 = ... / IF (...)     19 spans   keyword 0, constant 2
//     snect value0 = ... / fi (...)     18 spans   keyword 0, function 3
//
// THAT THIRD ROW IS WHY THIS AXIS TALLIES BY TOKEN TYPE RATHER THAN COUNTING
// SPANS. Replacing the keywords with same-length non-keywords leaves the TOTAL
// span count identical at 18 while emptying the keyword bucket entirely - so a
// total-span oracle would pass it, and so would splitting axis 6's `alpha`
// class into upper and lower. Splitting `alpha` closes the case-swap instance;
// only tallying what Prism actually emitted closes the class. That distinction
// is the whole point: this suite has now been broken five times by a whitelist
// that covered the member in front of it and not the class behind it.
//
// EXHAUSTIVE IN BOTH DIRECTIONS, like axes 3, 5 and 6. A token type Prism emits
// that nothing pins is a failure; a pinned type that stops occurring is a
// failure.
//
// A MISSING GRAMMAR IS A FAILURE, NOT A SKIP. This is the countAttributes
// lesson: if the bundle failed to load, or a fence carried a language Prism
// does not know, silently highlighting nothing would leave every tally empty
// and read as a passing assertion about a highlighter that never ran. So the
// number of blocks HIGHLIGHTED must equal the number of fenced blocks FOUND,
// both are pinned, and the load itself carries a positive control below.
//
// The pins are size-independent here, unlike axes 4 and 6, because each code
// block has the same token structure whatever iteration index is written into
// it. They are still pinned PER SIZE rather than once: two identical numbers
// are an assertion that they are identical, and a mutation that made the two
// sizes drift apart would be caught by exactly that.
//
// GENERATED from the corpus and spliced in, not transcribed.
const HIGHLIGHT = {
  prose: {},
  headings: {},
  tables: {},
  lists: {},
  code: {
    65536: { blocks: 626, spans: { function: 2, keyword: 2, number: 1, operator: 1, punctuation: 11, string: 1 } },
    1048576: { blocks: 9604, spans: { function: 2, keyword: 2, number: 1, operator: 1, punctuation: 11, string: 1 } },
  },
  dense: {
    65536: { blocks: 48, spans: { function: 0.2857, keyword: 0.2857, number: 0.1429, operator: 0.1429, punctuation: 1.5714, string: 0.1429 } },
    1048576: { blocks: 745, spans: { function: 0.2857, keyword: 0.2857, number: 0.1429, operator: 0.1429, punctuation: 1.5714, string: 0.1429 } },
  },
  wide: {},
};
const HIGHLIGHT_TOLERANCE = 0.005;

// The bundle is a browser script, so it is given a window that is its own
// global and nothing else. It is deliberately the SAME FILE index.html loads;
// a second copy of Prism would make this axis describe a highlighter the
// application does not run.
const prismSandbox = { console };
prismSandbox.window = prismSandbox;
prismSandbox.self = prismSandbox;
vm.createContext(prismSandbox);
vm.runInContext(
  fs.readFileSync(path.join(__dirname, "..", "libs", "prismjs", "prism-bundle.js"), "utf8"),
  prismSandbox,
);
const Prism = prismSandbox.Prism;

function tallySpans(code, lang, grammar) {
  const html = Prism.highlight(code, grammar, lang);
  const tally = {};
  for (const m of html.match(/<span class="token [^"]*"/g) || []) {
    const type = m.match(/token ([a-z-]+)/)[1];
    tally[type] = (tally[type] || 0) + 1;
  }
  return tally;
}

// POSITIVE CONTROL. "No token types found" is also what a Prism that failed to
// load, or one loaded without its JavaScript grammar, reports - and it reports
// it as silence, which every assertion below would read as agreement. So before
// anything is pinned, the highlighter must be shown to DISCRIMINATE: a keyword
// must be reported as a keyword, and a non-keyword of the same length must not.
const controlOk = (() => {
  if (!Prism || !Prism.languages || !Prism.languages.js) return "the js grammar did not load";
  const kw = tallySpans("const x = 1;", "js", Prism.languages.js);
  const no = tallySpans("snect x = 1;", "js", Prism.languages.js);
  if (kw.keyword !== 1) return `a keyword was reported ${kw.keyword} time(s), expected 1`;
  if (no.keyword) return `a non-keyword was reported as a keyword ${no.keyword} time(s)`;
  return null;
})();
check(
  "the vendored Prism bundle loads and tells a keyword from a non-keyword",
  controlOk === null,
  controlOk || `${Object.keys((Prism && Prism.languages) || {}).length} grammars loaded`,
);

for (const [profile, want] of Object.entries(HIGHLIGHT)) {
  for (const size of REFERENCE_SIZES) {
    const toks = lexTokens(generate(profile, size));
    const n = toks.length;
    const pin = want[size];
    const problems = [];

    const tally = {};
    let blocks = 0;
    let highlighted = 0;
    for (const t of toks) {
      if (t.type !== "code") continue;
      blocks++;
      const lang = String(t.lang || "").trim();
      const grammar = Prism.languages[lang];
      if (!grammar) {
        if (problems.length < 3) problems.push(`no Prism grammar for the language ${JSON.stringify(lang)}`);
        continue;
      }
      highlighted++;
      const c = tallySpans(String(t.text || ""), lang, grammar);
      for (const k of Object.keys(c)) tally[k] = (tally[k] || 0) + c[k];
    }

    // A profile pinned as carrying no code that starts carrying some is the
    // same omission-shaped failure as an unpinned element, so the empty object
    // is an assertion rather than an absence of one.
    if (!pin) {
      check(
        `the ${profile} profile contains no syntax-highlighted code at ${size / 1024}KB`,
        blocks === 0,
        `${blocks} fenced code block(s) appeared in a profile pinned as having none`,
      );
      continue;
    }

    if (blocks !== pin.blocks) problems.push(`${blocks} fenced code blocks, pinned at ${pin.blocks}`);
    if (highlighted !== blocks) problems.push(`${blocks} fenced blocks but only ${highlighted} were highlighted`);

    for (const type of Object.keys(tally).sort()) {
      const per = tally[type] / n;
      if (!(type in pin.spans)) {
        problems.push(`the ${JSON.stringify(type)} token is not pinned but occurs ${per.toFixed(4)} per token`);
        continue;
      }
      const expected = pin.spans[type];
      if (Math.abs(per - expected) / Math.max(expected, 1e-9) > HIGHLIGHT_TOLERANCE) {
        problems.push(`the ${JSON.stringify(type)} token occurs ${per.toFixed(4)} per token, pinned at ${expected}`);
      }
    }
    for (const type of Object.keys(pin.spans)) {
      if (!(type in tally)) problems.push(`the ${JSON.stringify(type)} token is pinned but no longer occurs`);
    }

    check(
      `the ${profile} profile highlights into the pinned token mix at ${size / 1024}KB`,
      problems.length === 0,
      problems.join("; "),
    );
  }
}
// AXIS 8: BLOCK IDENTITY. Also NOT regenerable - and DIFFERENT IN KIND from
// everything above it. Read this before adding a ninth statistic.
//
// Axes 1-7 are all AGGREGATES: proportions, per-token means, histograms,
// tallies. An aggregate necessarily throws information away, and every review
// round so far has found a different thing that was thrown away:
//
//   round 5  text content inside a pinned extent      -> axis 6
//   round 6  character IDENTITY inside a pinned count -> axis 7 (Prism)
//   round 6  the ARRANGEMENT of already-pinned content within a token
//
// That last one was measured end to end by the second reviewer and is the
// reason this axis exists. Swapping the tables builder's Description and
// Default columns - the same characters, the same words, the same run lengths,
// the same histogram, in a different order - passed 180/180 WITH A REGENERATED
// MANIFEST. What it changes is the per-column maximum, [7,7,59,7] -> [7,7,7,59],
// which flips which column markShortColumns() marks nowrap for every table in
// the corpus: a direct change to the layout pass this benchmark exists to
// measure.
//
// A CORRESPONDING EIGHTH STATISTIC WOULD HAVE CLOSED THAT INSTANCE AND INVITED
// A NINTH ROUND. Two independent reviewers found two different surviving
// breakers in the same round; the honest reading is that the supply of
// discarded dimensions is not close to exhausted, and that chasing them one at
// a time is a losing game.
//
// So this axis is not another statistic. It pins THE BLOCKS THEMSELVES, by
// hash, and therefore discards nothing about the blocks it covers. Every
// breaker any reviewer has produced across six rounds - word fusion, template
// literals, keyword case, non-keyword substitution, column reordering - is a
// change to a BUILDER, so it changes every block that builder emits, so it
// changes these hashes.
//
// THE STATISTICAL AXES ARE NOT MADE REDUNDANT BY THIS, and must not be deleted
// as though they were. They are complementary in both directions: they cover
// EVERY block weakly where this covers nine exactly, so a mutation touching
// only unsampled blocks is caught only by them; and their failures NAME THE
// DIMENSION that moved ("the keyword token is pinned but no longer occurs"),
// which is what tells a reader re-deriving the pins what actually changed. A
// hash mismatch alone says only "different", which is why the failure below
// prints the block.
//
// THREE SAMPLES PER CELL WOULD NOT HAVE BEEN ENOUGH, AND THAT WAS MEASURED
// RATHER THAN GUESSED. The first version sampled the first, middle and last
// block. Against the column-reordering breaker the `tables` profile failed
// correctly - but `dense` PASSED, because `dense` cycles seven builders and
// none of its three sampled blocks happened to be the table. The sample now
// covers indices 0-6, which is one full cycle and therefore every builder in
// every profile, plus the middle and last block so that a mutation guarded on
// the iteration index (`if (i > 100)`) still has nowhere to hide.
//
// EVENLY SPREAD SAMPLING WOULD HAVE BEEN WORSE THAN THE NAIVE VERSION, which is
// why the indices are consecutive. Nine evenly spread indices over dense's 336
// tokens land on 0, 42, 84 ... and 42 is a multiple of 7, so every single
// sample would have been the SAME builder - an axis that looks like it covers
// nine blocks while covering one, aliased against the very cycle it is meant to
// sample. Consecutive indices cannot alias with any cycle length.
//
// GENERATED from the corpus and spliced in, not transcribed.
const BLOCK_IDENTITY = {
  prose: {
    65536: { tokens: 191, blocks: ["aaa15cda4acb2ad5", "a8178204ebce6177", "0f9b4ff3cb442a19", "e6ad3a3b0faaf97e", "b24dcfcd5f221a53", "c8bc6dca5bde7e27", "5f03d98b10f1d37a", "4847cf77acc1c8e0", "beaf54b40e3df472"] },
    1048576: { tokens: 2994, blocks: ["aaa15cda4acb2ad5", "a8178204ebce6177", "0f9b4ff3cb442a19", "e6ad3a3b0faaf97e", "b24dcfcd5f221a53", "c8bc6dca5bde7e27", "5f03d98b10f1d37a", "3ff59c0f622d2392", "932d0d9c30faa3fb"] },
  },
  headings: {
    65536: { tokens: 818, blocks: ["229aa4be4eb82fbd", "90873696ee6ec886", "b649b1f9f596a493", "95fbb8c473cfe2fc", "e4a1effec2ba81d0", "4bf55a76cd514182", "e9d7ab31167fbb6c", "774f33f03e44fb70", "9ac16db4f08f7977"] },
    1048576: { tokens: 12852, blocks: ["229aa4be4eb82fbd", "90873696ee6ec886", "b649b1f9f596a493", "95fbb8c473cfe2fc", "e4a1effec2ba81d0", "4bf55a76cd514182", "e9d7ab31167fbb6c", "555521b7e614b43f", "5a7613a16c049e51"] },
  },
  tables: {
    65536: { tokens: 128, blocks: ["977a566e13ea7404", "e5f3604ca19664b3", "61e563a445416668", "d3778c70efe821e9", "e57271b91a35eb77", "c0c2c5f2a40eeb12", "4739b5474cd02379", "5d6cb5ca695a532a", "e69a8de2714807c4"] },
    1048576: { tokens: 1991, blocks: ["977a566e13ea7404", "e5f3604ca19664b3", "61e563a445416668", "d3778c70efe821e9", "e57271b91a35eb77", "c0c2c5f2a40eeb12", "4739b5474cd02379", "11aa31cdaff62cca", "ab09ad5cc18e077f"] },
  },
  lists: {
    65536: { tokens: 484, blocks: ["cd1b8e414d33ba67", "c239197d414559ba", "12cd1312aecff681", "5a0af5fa06939bfc", "89fed31686bf421c", "0b75a66c09b2d327", "42c8a259b66d30ce", "be6cd8cd7e605767", "911d80c9ea31fd99"] },
    1048576: { tokens: 7710, blocks: ["cd1b8e414d33ba67", "c239197d414559ba", "12cd1312aecff681", "5a0af5fa06939bfc", "89fed31686bf421c", "0b75a66c09b2d327", "42c8a259b66d30ce", "5fd241103084ba73", "2b484d404c0b2cf1"] },
  },
  code: {
    65536: { tokens: 626, blocks: ["c43d60d01b0e3929", "3fffd623fe321ba4", "3f6b60a6843d7c7d", "770f839092cb7966", "2603b82468549b2e", "c5e55cce9fa68e9c", "5b030520e6f3d1e6", "c7ff2fcc06b6f363", "0733aae25b7141eb"] },
    1048576: { tokens: 9604, blocks: ["c43d60d01b0e3929", "3fffd623fe321ba4", "3f6b60a6843d7c7d", "770f839092cb7966", "2603b82468549b2e", "c5e55cce9fa68e9c", "5b030520e6f3d1e6", "2f7a4e374502fe5c", "4faa9bd8917b5e50"] },
  },
  dense: {
    65536: { tokens: 336, blocks: ["1ae371b1de01eed7", "83b0b73871953d4b", "59c3f6a6499ec1f7", "75aec77e597bbc71", "44b7f8690eed416f", "738024cc94b52699", "a59d433481d7f9be", "e1d9723bc34187bb", "98daed013586d3aa"] },
    1048576: { tokens: 5215, blocks: ["1ae371b1de01eed7", "83b0b73871953d4b", "59c3f6a6499ec1f7", "75aec77e597bbc71", "44b7f8690eed416f", "738024cc94b52699", "a59d433481d7f9be", "0d809363bb095c17", "e85ce6b1501f28f0"] },
  },
  wide: {
    65536: { tokens: 74, blocks: ["06307e4c058d2b61", "f04bf1d8f10003fc", "b116885b41e02eda", "2d66ba598847d4f7", "1df82ab1927bdee4", "cbbf789e29d55330", "d82b2de6e518b0bf", "49267f4d1f8d525a", "021c03af54202b6f"] },
    1048576: { tokens: 1169, blocks: ["06307e4c058d2b61", "f04bf1d8f10003fc", "b116885b41e02eda", "2d66ba598847d4f7", "1df82ab1927bdee4", "cbbf789e29d55330", "d82b2de6e518b0bf", "e776bf919eda9854", "94500fed5cc00132"] },
  },
};
function blockHash(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
}

// A POSITIVE CONTROL, for the same reason axes 5 and 7 carry one. Every
// assertion below reads "the hashes agree" as good news, and two hashes of the
// same empty string agree too. If the sampling ever silently started reading
// nothing - an empty raw, a token list of length zero - the axis would go on
// passing. So the hash must be shown to DISCRIMINATE, and the sampled blocks
// must be shown to be non-empty below.
check(
  "the block hash tells two different blocks apart",
  blockHash("| a | b |") !== blockHash("| b | a |") && blockHash("x") === blockHash("x"),
  "the sampled-block hash does not distinguish reordered content",
);

// MUST MATCH THE GENERATOR EXACTLY. The pins are an array positional against
// this list, so a divergence here does not fail loudly - it silently compares
// block 3 against block 5's hash and reports a mutation that did not happen.
// The length assertion below is what makes a divergence in the COUNT loud.
function sampleIndices(n) {
  const idx = [];
  for (let i = 0; i < 7 && i < n; i++) idx.push(i);
  for (const extra of [Math.floor(n / 2), n - 1]) if (!idx.includes(extra)) idx.push(extra);
  return idx.sort((a, b) => a - b);
}

for (const [profile, want] of Object.entries(BLOCK_IDENTITY)) {
  for (const size of REFERENCE_SIZES) {
    const toks = lexTokens(generate(profile, size));
    const n = toks.length;
    const pin = want[size];
    const problems = [];

    if (n !== pin.tokens) {
      // Named separately from the hashes because it moves the sample indices,
      // so it would otherwise present as several unrelated blocks all changing.
      problems.push(`${n} top-level tokens, pinned at ${pin.tokens}`);
    }

    const indices = sampleIndices(n);
    if (indices.length !== pin.blocks.length) {
      problems.push(
        `${indices.length} sampled blocks against ${pin.blocks.length} pinned hashes, so the two are no longer aligned`,
      );
    }
    for (let s = 0; s < Math.min(indices.length, pin.blocks.length); s++) {
      const raw = String((toks[indices[s]] || {}).raw || "").trim();
      if (!raw) {
        problems.push(`block ${indices[s]} is empty, so its hash proves nothing`);
        continue;
      }
      const got = blockHash(raw);
      if (got !== pin.blocks[s]) {
        const shown = raw.length > 160 ? `${raw.slice(0, 160)}...` : raw;
        problems.push(
          `block ${indices[s]} hashes ${got}, pinned ${pin.blocks[s]} - it now reads ${JSON.stringify(shown)}`,
        );
      }
    }

    check(
      `the ${profile} profile's sampled blocks are the pinned text at ${size / 1024}KB`,
      problems.length === 0,
      problems.join("; "),
    );
  }
}
// ============================================================================
// AXIS 9: CORPUS DIGEST - the whole text, losslessly, at every size the
// benchmark actually reports.
//
// EVERY AXIS ABOVE IS A PROJECTION, AND EVERY PROJECTION HAS A COMPLEMENT.
// Axes 1-7 are aggregates, so they discard whatever the aggregate does not
// carry. Axis 8 is a sample, so it discards every block it does not sample.
// Round 7 is where that stopped being an abstract worry: BOTH reviewers,
// independently and without coordinating, produced the SAME mutation - the
// round-6 column exchange, guarded to fire only on iterations axis 8 does not
// sample:
//
//   if (i > 6 && i !== 64 && i !== 127 && i !== 995 && i !== 1990) { ...swap... }
//
// Reproduced here before being believed: 193/193, and write-manifest.js
// regenerated the manifest with exit 0. It moves the per-column maxima on 1984
// of 1991 tables, flipping which column markShortColumns() marks nowrap across
// 99.6% of the corpus.
//
// A SAMPLING ORACLE CANNOT BE FIXED BY CHANGING THE SAMPLE. Both remedies
// offered in review were rejected for the same reason. A pseudo-random or
// seeded sample is obscurity, not security: the pins are literals in this file,
// so anyone editing corpus.js can read exactly which indices are watched.
// Raising the sample from 9 to 32 only raises the cost of enumerating the
// complement; it does not remove the complement. Both are the same treadmill
// that axis 8 was itself created to get off.
//
// So this axis does not sample and does not aggregate. It pins sha256 of the
// ENTIRE generated text. There is no complement to hide in, because there is
// nothing it does not cover. Every breaker found in seven rounds of review
// fails it, and so will every future one, because a mutation that does not
// change the text does not change what is measured.
//
// THIS IS NOT A DUPLICATE OF manifest.json, ALTHOUGH IT IS LITERALLY THE SAME
// NUMBER, and de-duplicating it would silently delete the entire defence.
// manifest.json is REGENERABLE - write-manifest.js rebuilds it from whatever
// corpus.js currently says - which is why it only ever catches an accident.
// These pins are hand-held: regenerating the manifest cannot touch them. That
// difference is the whole point, and it is why both exist.
//
// THE STATISTICAL AXES STILL EARN THEIR PLACE, for one reason: a digest
// mismatch says only "different". It cannot say WHAT moved, and "what moved" is
// exactly what tells whoever is re-pinning whether the change was the one they
// intended. Axes 1-7 name the dimension, axis 8 prints the block, axis 9
// guarantees that SOMETHING always fires. Detector and diagnosis are different
// jobs and this file needs both.
//
// PINNED AT EVERY BENCHMARKED SIZE, NOT THE TWO REFERENCE SIZES, because a
// second complement was found while closing the first - and this one nobody had
// looked for. run.js reported 256 KB, 512 KB and 1 MB while every oracle
// verified 64 KB and 1 MB, so two of the three reported sizes were unverified
// by anything at all. Measured: a mutation guarded on
// `targetBytes === 262144 || targetBytes === 524288`, replacing every table
// description with fifty identical characters, passed all eight axes at 193/193
// and regenerated the manifest cleanly. This axis is cheap - generate() and a
// hash, with no parse and no highlighting - so it covers all four sizes, while
// the expensive diagnostic axes stay at the two reference sizes.
//
// GENERATED by `node bench/print-pins.js digest`, which is committed so these
// can be re-derived reproducibly. Read the failures before pasting new ones.
const CORPUS_DIGEST = {
  prose: {
    65536: "bac1fbc5773fa6e43c29bdcafc270e2576f0bce33b430bf2f3cdb7c33ba1b214",
    262144: "974b6c33f666da27fbb932428a2e72e81f2955c9481839e05e482f486d90a176",
    524288: "c0dda63ee596af64fa77373969f0b5e2d0d6db9afb4ef09b27cd9a8ed6a64fe4",
    1048576: "eb719cbc8ef53757d5d6ba2c6fa1562a3f30db93691ca9f2e7fa77089d504203",
  },
  headings: {
    65536: "100aad026ac7c283ed7c6b6d4df92b4dc9cbd8505e06b080d3bdbed17c316b7d",
    262144: "de16b918151998ac1e400b78f5f9e66fe5d3e5871a23cd47cf7ae18211e4bdbc",
    524288: "bfc0d57c9706d6ae5fc2f09b990c5483c28556022424644eb3fd7d0e603da171",
    1048576: "4d26ab3c5af43a393b76241fc9fc2872ea9a40e73d73969d0023ba87d465e915",
  },
  tables: {
    65536: "095ee6ce45d695360252b56b3e8ffe59342e294e361763a169d1fe0eadff34a6",
    262144: "34e7e33d7c9160ee977d57d42abcc5d4f9caed192405f209b2618be80dba0143",
    524288: "c1f181657fdb00358b7927d5d146c2615614c4cc0e276ee655a423cedae44f43",
    1048576: "f989218a6777e2f48c31ba3323940e8b588f08991db0d034cd762625bbade3d4",
  },
  lists: {
    65536: "fdf83f75c5d3896b096761dea8929b7433590c6b6335b7346b4aa263a7771143",
    262144: "f4095686f000af4b296727b3230cbe0f393a96d76f6673c254f949bb81b9fd07",
    524288: "541806b9d06c709f8d5aefac7e50240c35705deda9660669c98fef55d9b1797e",
    1048576: "14e289cc3dbbf495acf141cd00b527fc94553c593ee3288805ef6ec2ef3db29e",
  },
  code: {
    65536: "c6547282166c871dc8406fa6eae9db0be31f438715901943c4d68dfa5c8c89cd",
    262144: "91e9e8994613ca2efc9e35739c5a00b3cd23e0b8e7b038022102f0b9490610ce",
    524288: "da4e2f01e7abf43ae1a295cabfb826df1e2cfbaba39ed0af1dc42a7b7eb995c6",
    1048576: "5eaee1027db8be5b48ad866b2205f347313bbbb820aee4aa0a88ec4dc5c4f542",
  },
  dense: {
    65536: "c4c6dd2b4db99266676056671399f1edaf68e46347eee1b369c031ef9d296ed2",
    262144: "eaca039a1c37cbf0f24fac93c3e109e8f03ab7991224066a2354711d00a1066b",
    524288: "2f690f7e2171979080c9341c378590a45b23b27f619c1df17cb2aac797bbb763",
    1048576: "8e78e73f8bd06e5bb51cbc944778147d8f078cd3b069039a1dc0ea330ec15c48",
  },
  wide: {
    65536: "838adc3b6170788194264cf8c748677f7285f32ee285c9de9104e6bba0a712e4",
    262144: "b3cde4bfb7ce1e20c4d199ed34b14282ae65e33461ec1eafed45a3d62fb9abd3",
    524288: "fd8eb0df770cef111f87b1079170ea4096765a97f70ebc7894012a574a1af578",
    1048576: "bc7360dd943c34f55ecb48ad77d2d17ebd4ecca5336b8653670a9861434365c0",
  },
};

// THE TWO LISTS MUST NOT DRIFT APART AGAIN, and this is what stops them. The
// hole above existed because run.js's default sizes were a string literal in
// its argument parsing and this file's were a separate constant; nothing
// related them, so nothing noticed when they disagreed. Now the benchmark's
// defaults are exported from corpus.js and this asserts that a digest is pinned
// for every one of them. Adding a size to the benchmark without pinning it
// fails here rather than silently producing unverified rows.
{
  const unpinned = BENCH_DEFAULT_SIZES.filter((s) => !DIGEST_SIZES.includes(s));
  check(
    "every size the benchmark reports is covered by a pinned digest",
    unpinned.length === 0,
    `the benchmark measures ${unpinned.join(", ")}, which no oracle verifies`,
  );
}

// A POSITIVE CONTROL, for the same reason axes 5, 7 and 8 carry one. Every
// assertion below reads "the digests agree" as good news, and two digests of
// the same empty string agree too. If generate() ever started returning "" the
// axis would go on passing, so the hash must be shown to discriminate and the
// text must be shown to be non-empty.
check(
  "the corpus digest tells two different documents apart",
  digest("| a | b |") !== digest("| b | a |") && digest("x") === digest("x"),
  "the corpus digest does not distinguish reordered content",
);

for (const [profile, want] of Object.entries(CORPUS_DIGEST)) {
  for (const size of DIGEST_SIZES) {
    const text = generate(profile, size);
    const got = digest(text);
    const pin = want[size];
    // A missing pin is a REFUSAL, not a skip. A silently absent entry is how an
    // oracle ends up asserting nothing about the size that matters most.
    if (!pin) {
      check(
        `the ${profile} corpus is pinned at ${size / 1024}KB`,
        false,
        "no digest is pinned for this size, so nothing about it is being checked",
      );
      continue;
    }
    check(
      `the ${profile} corpus is byte-for-byte the pinned document at ${size / 1024}KB`,
      got === pin && text.length > 0,
      text.length === 0
        ? "generate() returned an empty document"
        : `sha256 ${got}, pinned ${pin} - the corpus text at this size is not the one every ` +
          "number in BASELINE.md was measured against",
    );
  }
}
// ============================================================================
// EVERY AXIS MUST PIN EVERY PROFILE, AND UNTIL NOW NONE OF THEM CHECKED.
//
// All nine pin objects are keyed by profile and every axis iterates
// `Object.entries(PIN)`. A profile that is absent from a pin object is
// therefore not failed - it is never visited at all. And `PROFILES` is
// `Object.keys(BUILDERS)`, so ADDING A BUILDER SILENTLY CREATES A PROFILE.
// Extending the corpus with a new construct is the documented way to use this
// directory, which makes this the one hole here most likely to be hit by
// accident rather than by an adversary.
//
// MEASURED, not reasoned. A seventh "ghost" builder was added and nothing else
// was touched. The manifest tier caught it - and then `write-manifest.js`
// regenerated the manifest and the whole suite passed at 229/229, exit 0. The
// assertion count went UP by ten, so it read as MORE verification while the new
// profile - an entire document class the benchmark renders, times and prints a
// row for - was checked by nothing that could not be regenerated away.
//
// This is the same disease as the two complements above, on a third axis:
// something the benchmark reports that no non-regenerable oracle covers. The
// manifest is not an answer, precisely because it regenerates.
//
// THE REGISTRY IS CHECKED AGAINST THIS FILE'S OWN SOURCE so that a tenth axis
// cannot quietly skip it. Registering by hand would just move the omission one
// level up - the new axis would be unregistered exactly as the ghost profile
// was unpinned. Instead every `const NAME = {` at column zero is discovered by
// reading __filename, and any such declaration missing from the registry is a
// failure. This is the same technique verify.js already uses to read
// renderer.js's setOptions block rather than hard-coding a copy of it.
{
  const PIN_OBJECTS = {
    SHAPE,
    INTERNALS,
    ELEMENTS,
    ATTRIBUTES,
    TEXTURE,
    TEXT_SHAPE,
    HIGHLIGHT,
    BLOCK_IDENTITY,
    CORPUS_DIGEST,
  };
  const source = fs.readFileSync(__filename, "utf8");
  const declared = new Set();
  const declRe = /^const ([A-Z][A-Z0-9_]*) = \{/gm;
  let match;
  while ((match = declRe.exec(source))) declared.add(match[1]);
  // prismSandbox and friends are lower-case by convention, so the pattern is
  // already specific to pin objects; anything new that matches it is one.
  const unregistered = [...declared].filter((name) => !(name in PIN_OBJECTS));
  check(
    "every hand-pinned oracle in this file is registered for the profile-coverage check",
    unregistered.length === 0,
    `${unregistered.join(", ")} is pinned per profile but is not in PIN_OBJECTS, so nobody ` +
      "checks that it covers every profile",
  );

  // THE DISCOVERY MUST BE PROVEN TO DISCOVER. If declRe ever stops matching -
  // an ESM migration putting `export` in front, a wrapper like
  // `Object.freeze({...})`, `let` instead of `const`, a reformat inserting a
  // second space - then `declared` is empty, `unregistered` is empty, and the
  // check above PASSES while checking nothing. That is the exact failure it
  // exists to prevent, one level up.
  //
  // The expected minimum is the registry itself rather than a hard-coded count:
  // a literal floor would need raising by hand on every new axis, and the hand
  // that forgets to register an axis is the same hand that forgets to raise the
  // floor. Requiring both directions makes the two sets equal, so the pattern
  // is re-proven against live declarations on every run.
  const undiscovered = Object.keys(PIN_OBJECTS).filter((name) => !declared.has(name));
  check(
    "the source pattern really finds the pin objects it is meant to police",
    undiscovered.length === 0,
    `${undiscovered.join(", ")} is registered but was not found by the source pattern, so the ` +
      "pattern no longer matches how pin objects are declared and can no longer detect a new one",
  );

  const wantProfiles = [...PROFILES].sort().join(",");
  for (const [name, pin] of Object.entries(PIN_OBJECTS)) {
    const got = Object.keys(pin).sort().join(",");
    const missing = [...PROFILES].filter((p) => !(p in pin));
    const extra = Object.keys(pin).filter((p) => !PROFILES.includes(p));
    check(
      `${name} pins every profile the corpus defines`,
      got === wantProfiles,
      [
        missing.length ? `pins nothing for ${missing.join(", ")}` : "",
        extra.length ? `pins ${extra.join(", ")}, which the corpus no longer defines` : "",
      ]
        .filter(Boolean)
        .join("; ") || `${got} against ${wantProfiles}`,
    );
  }
}
// ---------------------------------------------------------------------------
// AXIS 10: THE BENCHMARK'S OWN INSTRUMENTATION STILL TAKES EFFECT.
//
// This axis exists because of a defect that reached a full run. bench/run.js
// wraps marked.parse so the harness can attribute time to parsing. marked 18 is
// bundled by esbuild, whose export helper defines every export as a GETTER-ONLY,
// NON-CONFIGURABLE accessor, so the old `window.marked.parse = wrapped` became a
// SILENT no-op - sloppy-mode assignment to an accessor without a setter throws
// nothing. The wrap reported success, the original parse kept being called, and
// the phase recorded 0ms, which in the results table is indistinguishable from a
// phase that costs nothing. It surfaced eleven minutes later as PHASE_NEVER_CALLED.
//
// run.js now asserts its own post-condition, but that assertion lives INSIDE the
// eleven-minute artifact it protects. This axis moves the same question into the
// pre-flight, where it costs about a second.
//
// IT TESTS THE SHIPPED SOURCE, NOT A COPY. The block is extracted from run.js
// between two markers and executed here. A hand-maintained duplicate of the shim
// would pass forever while the real one rotted - the exact silent-divergence
// failure the setOptions axis above was written to prevent.
{
  const runSrc = fs.readFileSync(path.join(__dirname, "run.js"), "utf8");
  const B = "BENCH-SHIM-BEGIN";
  const E = "BENCH-SHIM-END";
  const bi = runSrc.indexOf(B);
  const ei = runSrc.indexOf(E);
  check(
    "run.js still carries the extraction markers this axis reads",
    bi !== -1 && ei !== -1 && ei > bi &&
      runSrc.indexOf(B, bi + 1) === -1 && runSrc.indexOf(E, ei + 1) === -1,
    `begin=${bi} end=${ei}. Without exactly one of each, the instrumentation cannot be ` +
      "tested here and would again only be checked by an eleven-minute run.",
  );

  if (bi !== -1 && ei > bi) {
    const shimSrc = runSrc.slice(runSrc.indexOf("\n", bi) + 1, runSrc.lastIndexOf("\n", ei));
    // The extracted text must actually be the wrap. If a future edit moves the
    // markers around something else, this axis would run harmless code and pass.
    check(
      "the extracted block is the marked.parse wrap",
      shimSrc.includes("window.marked = shim") && shimSrc.includes("__benchWrapped"),
      `extracted ${shimSrc.length} chars that do not look like the wrap`,
    );

    const bundlePath = path.join(__dirname, "..", "libs", "vendor", "marked.min.js");
    const haveBundle = fs.existsSync(bundlePath);
    check(
      "the vendored marked bundle is present to test the wrap against",
      haveBundle,
      `${bundlePath} is missing - run 'npm run vendor'. Testing the wrap against a mock ` +
        "would defeat the point: the defect was in the real bundle's export shape.",
    );

    if (haveBundle) {
      const bundle = fs.readFileSync(bundlePath, "utf8");
      const loadMarked = () => {
        const sb = { console };
        sb.globalThis = sb;
        sb.window = sb;
        sb.self = sb;
        vm.createContext(sb);
        vm.runInContext(bundle, sb);
        return sb.marked;
      };

      // Run the extracted wrap against a window holding the real module.
      //
      // performance.now() HERE MUST BE HIGH-RESOLUTION, like the renderer's.
      // A Date.now() stand-in quantises to 1ms, and parsing a short string once
      // marked is warm takes about 50us - so the sandbox would report 0ms for
      // work that really happened and would misrepresent the environment the
      // shim actually runs in. Measured: 452 of 500 healthy runs saw a zero
      // delta under Date.now(), none under hrtime.
      const hrMs = () => Number(process.hrtime.bigint()) / 1e6;
      const runShim = (win) => {
        const ctx = { window: win, performance: { now: hrMs }, console };
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        vm.runInContext(`(function(){\n${shimSrc}\n})()`, ctx);
      };
      const freshWindow = () => ({
        marked: loadMarked(),
        __bench: { phases: {} },
        __benchUnwrappable: [],
        __benchWrapNames: [],
      });

      // 1. THE PREMISE. If marked ever goes back to writable data exports the
      //    shim is no longer necessary, and this says so rather than leaving a
      //    workaround in place forever for a reason nobody can still verify.
      const probe = loadMarked();
      const desc = Object.getOwnPropertyDescriptor(probe, "parse");
      check(
        "marked's exports are still the getter-only accessors the shim exists for",
        typeof desc.get === "function" && desc.configurable === false,
        `parse is now {get:${typeof desc.get}, configurable:${desc.configurable}} - if it is ` +
          "writable again, the namespace-replacement shim can be simplified.",
      );

      // 2. THE WRAP TAKES EFFECT AND ACTUALLY RECORDS TIME. Not "the marker is
      //    present" - the counter must move, which is the failure mode above.
      const w = freshWindow();
      runShim(w);
      check(
        "the wrap reports no instrumentation problems against the real bundle",
        w.__benchUnwrappable.length === 0,
        w.__benchUnwrappable.join(", "),
      );
      check("the wrap registers marked.parse as a measured phase",
        w.__benchWrapNames.includes("marked.parse"), w.__benchWrapNames.join(", "));
      w.__bench.phases = {};
      const html = w.marked.parse("| a | b |\n|---|---|\n| 1 | 2 |");
      check(
        "calling marked.parse through the wrap records time against marked.parse",
        w.__bench.phases["marked.parse"] !== undefined,
        `phases=${JSON.stringify(w.__bench.phases)} - the wrap installed but measures nothing`,
      );
      check("the wrap does not change what marked renders",
        html.includes("<table"), html.slice(0, 80));

      // 3. THE POST-CONDITION MUST NOT DEPEND ON CLOCK RESOLUTION. This is the
      //    regression test for a real flake: when the guard required a POSITIVE
      //    time delta, 452 of 500 healthy runs failed at 1ms resolution, because
      //    parsing a short string once marked is warm takes about 50us. A clock
      //    that never advances is the worst case, and is deterministic where a
      //    stress run is not - so freeze it and require the healthy wrap to pass
      //    anyway. The wrap's claim is that it WRITES the counter; how long the
      //    parse took is not the claim.
      const frozen = freshWindow();
      const fctx = { window: frozen, performance: { now: () => 0 }, console };
      fctx.globalThis = fctx;
      vm.createContext(fctx);
      vm.runInContext(`(function(){\n${shimSrc}\n})()`, fctx);
      check(
        "the wrap's post-condition survives a clock that never advances",
        frozen.__benchUnwrappable.length === 0,
        `${frozen.__benchUnwrappable.join(", ")} - the guard is measuring elapsed time rather ` +
          "than whether the counter was written, so it will fail intermittently on fast machines",
      );

      // 4. EVERY ALIAS OF parse IS WRAPPED. marked exports the same callable
      //    under more than one name (marked.marked === marked.parse), and a
      //    forward-by-name shim leaves the alias as an untimed second door.
      const aliases = Object.getOwnPropertyNames(probe).filter((k) => probe[k] === probe.parse);
      check(
        "the aliases of marked.parse are known to this axis",
        aliases.length >= 1 && aliases.includes("parse"),
        `found ${JSON.stringify(aliases)}`,
      );
      for (const alias of aliases) {
        const wa = freshWindow();
        runShim(wa);
        wa.__bench.phases = {};
        wa.marked[alias]("# x");
        check(
          `calling marked.${alias} is timed, not an untimed second door onto parse`,
          wa.__bench.phases["marked.parse"] !== undefined,
          `marked.${alias} bypassed instrumentation; time spent there would vanish from the report`,
        );
      }

      // 5. THE GUARD IS SENSITIVE. A check that cannot fail is a defect equal to
      //    a product bug, so break the thing it watches and require it to notice.
      //    The mutation removes ONLY the timing side effect and leaves the
      //    __benchWrapped marker, which is precisely what a structural check
      //    cannot see - it is the reason the post-condition calls rather than
      //    inspects.
      const brokenSrc = shimSrc.replace(
        /window\.__bench\.phases\['marked\.parse'\] = \(window\.__bench\.phases\['marked\.parse'\] \|\| 0\) \+ \(performance\.now\(\) - t0\);/,
        "void 0;",
      );
      check(
        "the sensitivity mutation still matches the wrap's timing statement",
        brokenSrc !== shimSrc,
        "could not break the timing side effect, so the check below proves nothing",
      );
      if (brokenSrc !== shimSrc) {
        const wb = freshWindow();
        const ctx = { window: wb, performance: { now: hrMs }, console };
        ctx.globalThis = ctx;
        vm.createContext(ctx);
        vm.runInContext(`(function(){\n${brokenSrc}\n})()`, ctx);
        check(
          "the wrap's post-condition CATCHES a wrap that installs but records nothing",
          wb.__benchUnwrappable.some((p) => String(p).startsWith("marked.parse")),
          `a wrap with its timing removed was accepted (unwrappable=${JSON.stringify(wb.__benchUnwrappable)}). ` +
            "The post-condition is checking the marker rather than the behaviour.",
        );
      }
    }
  }
}

console.log(`\n=== ${passed}/${passed + failed} passed ===`);
process.exit(failed ? 1 : 0);
