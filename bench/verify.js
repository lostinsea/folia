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
const {
  PROFILES,
  RENDER_OPTIONS,
  generate,
  lexerCounts,
  lexTokens,
  renderHtml,
  sha256,
  REFERENCE_SIZES,
} = require("./corpus");

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
      sha256(text) === expected.sha256,
      `got ${sha256(text).slice(0, 16)}, pinned ${expected.sha256.slice(0, 16)}`,
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
const INTERNALS = {
  tables: { headerCells: 4, rows: 5 },
  lists: { items: 2 },
  code: { lines: 2 },
  dense: { headerCells: 4, rows: 5, items: 2, lines: 2 },
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
  const permissiveRe = /<[a-zA-Z][a-zA-Z0-9-]*(?:\s[^>]*)?\/?>/g;
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
// per-call options INSTEAD OF the globals, so the other three were silently
// coming from library defaults - `mangle` genuinely differed (renderer.js sets
// false, the default is true). Measured inert in this marked 9 build, but the
// point of the assertion is that it will not stay inert through the 9 -> 18
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
console.log(`\n=== ${passed}/${passed + failed} passed ===`);
process.exit(failed ? 1 : 0);
