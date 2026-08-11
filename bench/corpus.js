// ============================================
// bench/corpus.js - the fixed benchmark corpus
// ============================================
//
// WHY THIS EXISTS. Performance numbers taken against an ad-hoc document are not
// comparable with performance numbers taken against a different ad-hoc
// document, and the difference is easily large enough to invert a conclusion.
// Two failures during the render-pipeline work motivated this file:
//
//   1. A generator wrote a table's header row and its |---| delimiter row as
//      two entries joined by a blank line. Markdown renders that as two
//      paragraphs, so the "table-heavy" document contained NO TABLES AT ALL -
//      23.5 DOM nodes per KB instead of ~140. A whole profiling run was
//      invalid, and the only hint was applyTableBreakout reporting 0 ms.
//   2. The same DOM-removal defect measured 23.7s on a dense document and
//      571ms on plain paragraphs - a 40x spread for one bug, purely from
//      document shape.
//
// So the corpus is fixed, deterministic and hash-pinned. Two rules follow:
//
//   * EVERY MULTI-LINE CONSTRUCT IS ONE ARRAY ENTRY. Entries are joined with a
//     blank line, so splitting a table or a fenced block across two entries
//     silently degrades it into prose. This is failure (1) above.
//   * NOTHING NON-DETERMINISTIC. No Math.random, no Date, no environment. The
//     same call must produce byte-identical output on every machine and every
//     run, or a measurement taken today cannot be compared with one taken in a
//     month. bench/manifest.json pins the SHA-256 to enforce exactly that.
//
// The corpus is a SET of single-construct profiles rather than one blended
// document, and that is load-bearing rather than tidiness. Isolating constructs
// is what showed that marked v9's block lexer is quadratic in tables, lists and
// headings but linear in prose and code. A single blended document averages
// that signal away into "rendering is slow" and hides which construct - and
// which library - is responsible.
"use strict";

// A 32-bit linear congruential generator (Numerical Recipes constants). The
// content needs to VARY - a document of identical blocks would let the block
// hasher and the LCS diff find matches a real document would not, and would
// measure the wrong thing - but it must vary reproducibly.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const WORDS = [
  "render", "document", "pipeline", "viewer", "markdown", "layout", "buffer",
  "handler", "session", "measure", "linear", "threshold", "content", "column",
  "anchor", "fragment", "sanitise", "observer", "container", "identifier",
  "boundary", "immutable", "sequence", "annotate", "resolve", "descriptor",
  "traversal", "allocation", "predicate", "invariant", "heuristic", "checkpoint",
];

function words(rand, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)]);
  return out.join(" ");
}

function sentence(rand, i) {
  const s = words(rand, 8 + Math.floor(rand() * 10));
  return s.charAt(0).toUpperCase() + s.slice(1) + " " + i + ".";
}

// Each builder appends one iteration's worth of blocks. Every entry pushed is a
// COMPLETE construct - see the rule at the top of this file.
const BUILDERS = {
  // Realistic documentation prose. The linear baseline every other profile is
  // compared against.
  prose(rand, i, out) {
    out.push([sentence(rand, i), sentence(rand, i), sentence(rand, i)].join(" "));
  },

  // Heading-dominated. Quadratic in marked v9's block lexer.
  headings(rand, i, out) {
    out.push("#".repeat(1 + (i % 5)) + " " + words(rand, 4) + " " + i);
    out.push(sentence(rand, i));
  },

  // GFM tables - the construct this application exists to display well, and the
  // one that drives applyTableBreakout.
  tables(rand, i, out) {
    const rows = ["| Flag | Environment | Description | Default |", "|---|---|---|---|"];
    for (let r = 0; r < 5; r++) {
      rows.push(
        "| opt-" + i + "-" + r + " | ENV_" + i + "_" + r + " | " + words(rand, 6) +
          " | value-" + r + " |",
      );
    }
    out.push(rows.join("\n"));
  },

  // Nested bullet and ordered lists. Quadratic in marked v9's block lexer.
  lists(rand, i, out) {
    out.push(
      [
        "- " + words(rand, 5) + " " + i,
        "  - " + words(rand, 5),
        "  - " + words(rand, 5),
        "- " + words(rand, 5),
        "1. " + words(rand, 4),
        "2. " + words(rand, 4),
      ].join("\n"),
    );
  },

  // Fenced code. Linear in marked, and the input to Prism highlighting.
  code(rand, i, out) {
    out.push(
      ["```js", "const value" + i + " = compute(" + i + ", '" + words(rand, 3) + "');",
        "if (value" + i + ") { emit(value" + i + "); }", "```"].join("\n"),
    );
  },

  // Everything at once, in roughly the proportions a real technical document
  // tends to have. This is the dense end of the range and the profile most
  // likely to expose a quadratic anywhere in the pipeline; `bench/run.js`
  // reports its measured nodes-per-KB rather than asserting a figure here.
  dense(rand, i, out) {
    BUILDERS.headings(rand, i, out);
    BUILDERS.prose(rand, i, out);
    BUILDERS.lists(rand, i, out);
    BUILDERS.tables(rand, i, out);
    BUILDERS.code(rand, i, out);
  },

  // A support-matrix table too wide for the 900px reading column: the ONLY
  // profile that reaches applyTableBreakout's widening path.
  //
  // WHY THIS PROFILE EXISTS AT ALL. `tables` above was believed to exercise
  // applyTableBreakout - it is the most expensive phase in that profile - but
  // the class census showed `table-breakout` appearing in NO cell of the
  // corpus. Every table `tables` generates measures 860px against an 860px
  // reading column, so the pass measured its containers, decided nothing
  // needed widening and returned. Gutting the function entirely moved no node
  // count, no block count, no token count and no class in the histogram, while
  // render dropped 566ms to 486ms. No oracle over rendered OUTPUT can cover a
  // pass that produces no output, so the gap was in the corpus, not in any
  // oracle.
  //
  // WHY IT IS A NEW PROFILE RATHER THAN A WIDER TABLE IN `tables`. Two reasons,
  // both structural. The INTERNALS axis in verify.js requires min === max over
  // every table token in a profile, so mixing a 4-column and a 10-column table
  // into one profile would force that axis to be weakened to a range - and the
  // axis exists to catch exactly the "a table collapsed to one column"
  // degeneracy a range would admit. And keeping `tables` untouched preserves
  // the narrow, fits-the-column path as its own measured baseline: closing this
  // hole by widening the existing tables would have opened the symmetric one.
  //
  // WHY TEN COLUMNS OF TWELVE CHARACTERS, MEASURED RATHER THAN CHOSEN. The
  // breakout trigger is `wanted > given`, where `given` is the reading column
  // (measured 860px, not the 900px the stylesheet names - padding) and `wanted`
  // is the table's preferred width. `wanted` is a property of the CONTENT: the
  // same table measured 974px at a 1988px, a 1588px and a 1268px viewport.
  // What IS viewport-dependent is `wrap-anyway`, which fires when
  // `wanted > available` - so a table sized to trigger breakout only just
  // would produce a class histogram that changed with the window, and the
  // census is pinned exactly. Measured across those three viewports:
  //
  //     8 columns   wanted 860   no breakout at all
  //    10 columns   wanted 974   breakout, wrap-anyway false at all three
  //    16 columns   wanted 1598  wrap-anyway false at 1988, TRUE at 1588
  //    24 columns   wanted 2430  wrap-anyway true at all three
  //
  // Ten is the shape with the widest margin on both sides at once: 114px clear
  // of the trigger, and 246px clear of the wrap-anyway boundary at the
  // narrowest viewport tested. `run.js` additionally refuses to run below a
  // documented viewport floor, because that margin is what makes the pin
  // meaningful.
  //
  // WHY THE CELLS ARE FIXED-WIDTH. Column width here IS the trigger, so it
  // must not drift with the document. `i` grows into the thousands, and an
  // unpadded index would make later tables wider than earlier ones - the
  // widening decision would then depend on document SIZE, which is the one
  // variable every ratio in this benchmark is trying to hold still. Padding to
  // six digits keeps every cell exactly 12 characters up to 999,999
  // iterations, against ~1,700 at the largest benchmarked size.
  wide(rand, i, out) {
    const idx = String(i).padStart(6, "0");
    const rows = [
      "| " + WIDE_HEADERS.join(" | ") + " |",
      "|" + "---|".repeat(WIDE_HEADERS.length),
    ];
    for (let r = 0; r < 5; r++) {
      rows.push("| " + WIDE_TAGS.map((tag) => tag + "-" + idx + "-" + r).join(" | ") + " |");
    }
    out.push(rows.join("\n"));
  },
};

// Ten columns. The headers are all shorter than the 12-character cells below
// them, so the CELLS decide every column's width and the measured 974px is a
// property of the generated data rather than of these labels.
const WIDE_HEADERS = [
  "Platform",
  "Runtime",
  "Arch",
  "Toolchain",
  "Package",
  "Signing",
  "Tests",
  "Lint",
  "Docs",
  "Publish",
];
// Three characters each and all distinct, so no two columns carry identical
// text - a table of ten identical columns would be exactly the degeneracy the
// INTERNALS axis exists to refuse.
const WIDE_TAGS = ["plt", "run", "arc", "tch", "pkg", "sgn", "tst", "lnt", "doc", "pub"];

const PROFILES = Object.keys(BUILDERS);

// Seeds are per profile and fixed, so `dense` and `prose` do not accidentally
// share a word stream, and so adding a profile cannot change an existing one.
const SEEDS = {
  prose: 0x5eed0001,
  headings: 0x5eed0002,
  tables: 0x5eed0003,
  lists: 0x5eed0004,
  code: 0x5eed0005,
  dense: 0x5eed0006,
  wide: 0x5eed0007,
};

// Generates at least `targetBytes` of markdown for `profile`. Growth is in
// whole iterations, so the result overshoots slightly and is byte-exact for a
// given (profile, targetBytes) pair - which is what the manifest hash pins.
//
// THE WHOLE-ITERATION PROPERTY IS LOAD-BEARING, not incidental. The byte target
// is tested only at the top of the loop and every builder emits its complete
// set of constructs before the test is reached, so a document can never end
// half way through an iteration. That is what makes the token-type proportions
// in verify.js EXACT rationals rather than approximations - dense is 1/7
// heading, 2/7 paragraph, 2/7 list, 1/7 table, 1/7 code at 64KB and at 1MB
// alike - and it is why those pins can be asserted to a tight tolerance.
// Changing this loop to stop mid-iteration (say, to reduce the overshoot) would
// make the proportions drift with size and quietly weaken every share
// assertion, so it must not be done without re-deriving them.
function generate(profile, targetBytes) {
  const build = BUILDERS[profile];
  if (!build) throw new Error(`unknown profile: ${profile} (have ${PROFILES.join(", ")})`);
  const rand = lcg(SEEDS[profile]);
  const out = [];
  let len = 0;
  let i = 0;
  while (len < targetBytes) {
    const before = out.length;
    build(rand, i, out);
    // +2 for the blank line each entry is joined with.
    for (let k = before; k < out.length; k++) len += out[k].length + 2;
    i++;
  }
  return out.join("\n\n");
}

// Resolves the ONE vendored marked bundle and returns it. Loaded from
// libs/vendor rather than from node_modules so the corpus is described by the
// very parser the application ships. The bundle is UMD: under require() it
// populates module.exports rather than a global.
//
// SORTED, AND AMBIGUITY IS A HARD ERROR. `readdirSync` order is not guaranteed
// across platforms or filesystems, so picking "the first file matching
// /^marked/" would silently choose a different parser on a different machine
// the moment a second one existed - and every token pin in the manifest is a
// statement about a specific parser. Two candidates means the corpus is not
// described by one thing and the answer is to say so, not to pick.
let markedCache = null;
function loadMarked() {
  if (markedCache) return markedCache;
  const path = require("path");
  const fs = require("fs");
  const dir = path.join(__dirname, "..", "libs", "vendor");
  const found = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((f) => /^marked.*\.js$/.test(f))
    .sort();
  if (found.length === 0) {
    throw new Error(
      "libs/vendor/marked*.js is missing - run `npm run vendor`. Not skipped " +
        "deliberately: a corpus check that silently stops checking is worse than none.",
    );
  }
  if (found.length > 1) {
    throw new Error(
      `libs/vendor holds ${found.length} marked bundles (${found.join(", ")}). The corpus ` +
        "manifest pins token counts produced by ONE parser, so which one is used cannot be " +
        "left to directory order.",
    );
  }
  const mod = require(path.join(dir, found[0]));
  const marked =
    (mod && (mod.marked || (typeof mod.lexer === "function" ? mod : null))) || global.marked;
  if (!marked || typeof marked.lexer !== "function" || typeof marked.parse !== "function") {
    throw new Error("could not reach marked.lexer/marked.parse in the vendored bundle");
  }
  markedCache = { marked, file: found[0] };
  return markedCache;
}

// Returns marked's TOP-LEVEL block tokens, `space` filtered out. Shared by
// lexerCounts() and by the structural checks in verify.js, which need the
// tokens themselves rather than a histogram of their types.
function lexTokens(text) {
  return loadMarked()
    .marked.lexer(text)
    .filter((token) => token.type !== "space");
}

// Renders through the SAME resolved bundle that lexTokens() uses. verify.js
// needs this because the benchmark times DOM work, and the block-token stream
// does not describe the DOM: a paragraph of plain words and a paragraph full of
// inline code, links and emphasis are one `paragraph` token each and a wildly
// different amount of rendering. Sharing loadMarked() is what stops the lexed
// pins and the rendered pins from ever being statements about two parsers.
// RENDER THE WAY THE APP RENDERS. renderer.js calls marked.setOptions with a
// four-option block; marked applies PER-CALL options INSTEAD OF the globals,
// and this module deliberately never calls setOptions (it must not mutate a
// parser other code shares), so every option the app sets has to be repeated
// here or the corpus is parsed with library defaults.
//
// `breaks: true` is the fork decision from item 6c (hard-wrapped agent-written
// documents keep their line structure), pinned by R85; marked's default is
// false. `mangle: false` is the one that actually differed from the default.
//
// MEASURED, not assumed: rendering all six profiles with the full set is
// byte-identical to rendering them with `breaks` alone, and so is an
// autolink/email probe, so mangle and headerIds are inert in this vendored
// marked 9 build. That makes this a no-op TODAY - the manifest does not move -
// and it is pinned anyway because "inert today" is exactly the state `breaks`
// was in before a builder change would have activated it. verify.js asserts
// this set against renderer.js's own block, so the two cannot silently drift.
const RENDER_OPTIONS = { breaks: true, gfm: true, headerIds: true, mangle: false };
function renderHtml(text) {
  return loadMarked().marked.parse(text, RENDER_OPTIONS);
}

// Counts marked's TOP-LEVEL block tokens by type. This is the check that would
// have caught failure (1): a corpus whose tables had silently become paragraphs
// reports table:0 and paragraph:N, in a form a human reads at a glance.
function lexerCounts(text) {
  const counts = {};
  for (const token of lexTokens(text)) {
    counts[token.type] = (counts[token.type] || 0) + 1;
  }
  return counts;
}

function sha256(text) {
  return require("crypto").createHash("sha256").update(text, "utf8").digest("hex");
}

// The reference sizes the manifest pins. Small enough to verify in
// milliseconds, large enough that a generator change cannot miss both.
const REFERENCE_SIZES = [64 * 1024, 1024 * 1024];

// THE SIZES `npm run bench` ACTUALLY MEASURES. This used to be a string
// literal in run.js's argument defaults, and the two lists silently disagreed:
// the benchmark reported 256 KB, 512 KB and 1 MB while the oracles verified
// 64 KB and 1 MB, leaving TWO OF THE THREE REPORTED SIZES UNVERIFIED.
//
// That was not theoretical. A mutation guarded on `targetBytes === 262144 ||
// targetBytes === 524288` - replacing every table description with fifty
// identical characters, which is about as violent as a corpus change gets -
// passed all eight axes at 193/193 AND regenerated the manifest cleanly. Two
// thirds of every row in BASELINE.md would have been describing a different
// corpus with nothing to say so.
//
// So the list lives HERE, is consumed by run.js as its default, and verify.js
// asserts that it pins a digest for every entry. Neither file can now move
// without the other noticing.
const BENCH_DEFAULT_SIZES = [256 * 1024, 512 * 1024, 1024 * 1024];

// Every size any oracle must cover: the two reference sizes the statistical
// axes are pinned at, plus every size the benchmark actually reports.
const DIGEST_SIZES = Array.from(new Set([...REFERENCE_SIZES, ...BENCH_DEFAULT_SIZES])).sort(
  (a, b) => a - b,
);

module.exports = {
  PROFILES,
  RENDER_OPTIONS,
  generate,
  lexerCounts,
  lexTokens,
  renderHtml,
  sha256,
  REFERENCE_SIZES,
  BENCH_DEFAULT_SIZES,
  DIGEST_SIZES,
};
