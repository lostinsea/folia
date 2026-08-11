// bench/capture-marked.js - the pre-upgrade record of what marked 9 costs.
//
// WHY THIS EXISTS, AND WHY IT IS RUN BEFORE THE UPGRADE RATHER THAN AFTER.
// The marked 9 -> 18 upgrade replaces the parser every number in
// bench/BASELINE.md was measured through. Afterwards the marked-9 curve is not
// reconstructible: the bundle is replaced, the token stream is restructured
// (marked 18 changes table tokenisation, which is precisely the profile that
// looks superlinear here), and re-vendoring the old bundle to re-measure would
// mean running two parsers against one set of pins - the exact ambiguity
// corpus.js hard-errors on. So this capture is a one-way door. Both reviewers
// converged on taking it, independently, for that reason.
//
// WHAT IT MEASURES THAT `npm run bench` DOES NOT.
//   - FIVE size points (128 KB to 2 MB), not three, so an exponent has enough
//     leverage to be an exponent rather than a single ratio wearing a hat.
//   - The LEXER and the FULL PARSE separately. The observation that started
//     this - `wide` marked.parse scaling at about n^1.41 - says nothing about
//     WHICH half is superlinear. If it is the block lexer, marked 18's
//     tokeniser rewrite is likely to move it; if it is the renderer half, the
//     upgrade probably will not. That prediction is worth having in hand
//     BEFORE the upgrade, because it is what makes the post-upgrade numbers
//     falsifiable rather than merely different.
//   - RAW per-repetition times, not medians. A median is a summary of a
//     distribution nobody kept, and the post-upgrade comparison may want to
//     ask a question of the distribution that this file did not anticipate.
//
// WHY IT DOES NOT RENDER. This process never opens a window: it calls the
// vendored marked bundle directly. The pipeline cost (DOM patching, sanitize,
// table breakout) is already measured by `npm run bench` and is not what the
// upgrade changes. Keeping this to the parser makes five size points affordable
// and removes every source of noise that is not the parser.
//
// THE CORPUS AT THESE SIZES IS NOT IN manifest.json - 128 KB and 2 MB are not
// pinned sizes - so every generated document's sha256 is recorded here instead.
// That is what makes the post-upgrade comparison a comparison: without it, a
// generator change between the two captures would be indistinguishable from a
// parser change, which is the failure the manifest exists to prevent at the
// pinned sizes.
//
// Run:  node bench/capture-marked.js [--runs=3] [--out=bench/marked9-parse.json]
//       (also runs under Electron's own node via ELECTRON_RUN_AS_NODE=1, which
//        is worth doing once: if the two runtimes agree on the exponents, the
//        "is this V8-specific?" question is closed permanently rather than
//        carried as a caveat. process.versions is recorded either way.)

const fs = require("fs");
const path = require("path");
const { generate, lexerCounts, loadMarked, sha256, RENDER_OPTIONS } = require("./corpus");

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}

// SIZES ARE BYTES. `--sizes=512` once silently measured 512-BYTE documents and
// produced a confident, meaningless curve, so the unit is stated here and the
// parser below refuses anything under 1 KB rather than accepting a plausible
// small number.
const SIZES = String(arg("sizes", [131072, 262144, 524288, 1048576, 2097152].join(",")))
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n));

// THE SUBJECTS AND THE CONTROLS ARE BOTH REQUIRED, and which is which is
// declared rather than inferred. `wide` is the profile the superlinearity was
// seen in; `tables` and `headings` were named by the reviewers.
//
// `dense` WAS a control in the first version of this file and MEASUREMENT
// DISQUALIFIED IT - though not for the reason first recorded, which is worth
// keeping because the correction is the point. The first capture put it at
// slope 1.53; that number was itself contaminated by the lex/parse ordering
// defect described at measure(), and once the passes were separated it fell to
// 1.22. So most of `dense`'s apparent superlinearity was garbage collection,
// not parsing. It stays a subject rather than a control anyway, on the
// surviving evidence: its final doubling is still 1.72, i.e. it is not linear
// at 2 MB, and a control that is partly contaminated by the effect under study
// makes the discrimination oracle pass for the wrong reason.
//
// `prose` is the NEGATIVE CONTROL, and is the only profile that earns the name:
// 0.96 overall with every individual doubling between 0.89 and 1.01, all the
// way to 2 MB. Without a control, a slope of 2.0 on `wide` cannot be attributed
// to marked at all - it could be the timer, the generator, the allocator or the
// machine warming up. See the discriminates() oracle.
//
// `headings` is nominally a subject and measures near-linear until 2 MB, which
// is itself the useful observation.
const SUBJECTS = ["wide", "tables", "headings", "dense"];
const CONTROLS = ["prose"];
const PROFILES = String(arg("profiles", [...SUBJECTS, ...CONTROLS].join(",")))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RUNS = Number(arg("runs", 3));
const REPS = Number(arg("reps", 5));
const WARMUPS = Number(arg("warmups", 2));
const OUT = path.resolve(String(arg("out", path.join(__dirname, "marked9-parse.json"))));

const problems = [];
if (SIZES.length < 4) problems.push(`need at least 4 size points for an exponent, got ${SIZES.length}`);
if (SIZES.some((s) => s < 1024)) problems.push("--sizes is in BYTES; a value under 1 KB is a unit mistake");
if (!SIZES.every((s, i) => i === 0 || s === SIZES[i - 1] * 2)) {
  problems.push("sizes must be successive DOUBLINGS, or log2(t2/t1) is not an exponent");
}
if (RUNS < 3) problems.push(`need at least 3 runs for a variance envelope, got ${RUNS}`);
if (REPS < 3) problems.push(`a median needs at least 3 samples, got ${REPS}`);
if (WARMUPS < 1) problems.push("at least one warm-up is needed; the first parse pays JIT and allocation costs");
if (problems.length) {
  for (const p of problems) console.error(`ABORT: ${p}`);
  process.exit(2);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Least-squares slope of log(time) against log(size). With equally spaced
// log-x points this is the exponent: 1.0 linear, 2.0 quadratic. Reported
// alongside the per-doubling log2 ratios rather than instead of them, because
// a single fitted number hides a curve that changes regime partway up - and a
// regime change is exactly what a quadratic term overtaking a linear one looks
// like.
function logLogSlope(sizes, times) {
  const xs = sizes.map((s) => Math.log(s));
  const ys = times.map((t) => Math.log(t));
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return num / den;
}

function hrms(fn) {
  const t0 = process.hrtime.bigint();
  const out = fn();
  const t1 = process.hrtime.bigint();
  // Returned so the optimiser cannot delete the call it is timing. Measured,
  // not assumed: without a use of the result V8 is free to elide work whose
  // output is unreachable, and a benchmark that times nothing reports a
  // beautifully linear zero.
  return { ms: Number(t1 - t0) / 1e6, keep: out };
}

const { marked, file: markedFile } = loadMarked();

console.log("marked pre-upgrade parse capture");
console.log(`  bundle     ${markedFile}`);
console.log(`  runtime    node ${process.versions.node}  v8 ${process.versions.v8}` +
  (process.versions.electron ? `  electron ${process.versions.electron}` : ""));
console.log(`  options    ${JSON.stringify(RENDER_OPTIONS)}`);
console.log(`  sizes      ${SIZES.map((s) => `${Math.round(s / 1024)}KB`).join(" ")}`);
console.log(`  profiles   ${PROFILES.join(", ")}`);
console.log(`  regime     ${RUNS} runs x ${REPS} reps, ${WARMUPS} warm-up(s) discarded`);
console.log(`  gc         ${typeof global.gc === "function" ? "available" : "NOT available (run with --expose-gc)"}`);
console.log("");

// Generated ONCE and reused across every run and repetition. Regenerating per
// repetition would fold the generator's own cost - which is not linear in the
// same way - into the parser's curve.
const corpora = new Map();
for (const profile of PROFILES) {
  for (const size of SIZES) {
    const text = generate(profile, size);
    corpora.set(`${profile}|${size}`, {
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      sha256: sha256(text),
      tokens: lexerCounts(text),
    });
  }
}

// LEX AND PARSE ARE MEASURED IN SEPARATE PASSES, EACH WITH ITS OWN WARM-UP,
// AND THAT IS NOT TIDINESS - THE FIRST VERSION OF THIS FILE PRODUCED AN
// IMPOSSIBLE NUMBER.
//
// It timed lex and then parse inside one repetition, always in that order.
// `wide`@1024KB came back at lex 944ms against parse 613ms, consistently
// across all three runs. `marked.parse` LEXES AND THEN RENDERS, so parse
// cannot be cheaper than lex; the ordering was measuring something other than
// the parser. Lexing a 1 MB wide document builds an enormous token tree, five
// repetitions build and discard five of them, and the resulting major GCs land
// inside whichever timed region is running - systematically the first one.
//
// So: all lex repetitions, then all parse repetitions, each preceded by its own
// warm-up, with an explicit collection between repetitions OUTSIDE the timed
// region. What is measured is then the parser's own cost rather than the
// parser plus whatever the previous measurement left on the heap.
function measure(text, fn) {
  for (let i = 0; i < WARMUPS; i++) fn(text);
  const ms = [];
  let keep = null;
  for (let i = 0; i < REPS; i++) {
    if (typeof global.gc === "function") global.gc();
    const t = hrms(() => fn(text));
    ms.push(t.ms);
    keep = t.keep;
  }
  return { ms, keep };
}

const samples = [];
for (let run = 1; run <= RUNS; run++) {
  for (const profile of PROFILES) {
    for (const size of SIZES) {
      const doc = corpora.get(`${profile}|${size}`);
      const l = measure(doc.text, (t) => marked.lexer(t));
      const p = measure(doc.text, (t) => marked.parse(t, RENDER_OPTIONS));
      samples.push({
        run,
        profile,
        size,
        lex: l.ms,
        parse: p.ms,
        htmlBytes: typeof p.keep === "string" ? p.keep.length : 0,
      });
      console.log(
        `run ${run}  ${profile.padEnd(9)}${String(Math.round(size / 1024)).padStart(5)}KB  ` +
          `lex ${median(l.ms).toFixed(1).padStart(8)}ms  parse ${median(p.ms).toFixed(1).padStart(8)}ms`,
      );
    }
  }
}
console.log("");

// --- aggregation ------------------------------------------------------------
// The per-cell figure is the median across every repetition of every run, so
// the variance envelope below is computed against the same quantity the
// exponents are.
const cell = (profile, size, which) => {
  const all = [];
  for (const s of samples) {
    if (s.profile === profile && s.size === size) all.push(...s[which]);
  }
  return all;
};

const report = { profiles: {} };
for (const profile of PROFILES) {
  const entry = { sizes: {}, lex: {}, parse: {} };
  for (const size of SIZES) {
    const doc = corpora.get(`${profile}|${size}`);
    entry.sizes[size] = {
      bytes: doc.bytes,
      sha256: doc.sha256,
      tokens: doc.tokens,
      lexMedianMs: median(cell(profile, size, "lex")),
      parseMedianMs: median(cell(profile, size, "parse")),
      // The spread across runs, as a fraction of the median. This is the only
      // thing that says whether a difference between two exponents is worth
      // reading, and it is per-cell because the small sizes are noisier.
      runMedians: {
        lex: samples.filter((s) => s.profile === profile && s.size === size).map((s) => median(s.lex)),
        parse: samples.filter((s) => s.profile === profile && s.size === size).map((s) => median(s.parse)),
      },
    };
  }
  for (const which of ["lex", "parse"]) {
    const key = which === "lex" ? "lexMedianMs" : "parseMedianMs";
    const times = SIZES.map((s) => entry.sizes[s][key]);
    entry[which] = {
      medianMs: times,
      // log2 of each doubling's ratio: 1.0 linear, 2.0 quadratic.
      doublingExponents: times.slice(1).map((t, i) => Math.log2(t / times[i])),
      doublingRatios: times.slice(1).map((t, i) => t / times[i]),
      slope: logLogSlope(SIZES, times),
    };
  }
  report.profiles[profile] = entry;
}

// --- the estimator must DISCRIMINATE, and that is checked without a constant -
// A capture whose exponent estimator cannot tell linear markdown from the
// profile under suspicion is worthless, and it is worthless in the most
// dangerous way: it produces a number that looks like an answer. This is the
// same shape as the two-stage census check - a relational claim, so there is no
// threshold to re-derive on a different machine or a different parser.
//
// Deliberately NOT "wide's slope must exceed 1.2": that is a constant fitted to
// today's measurement, and the whole point of this file is to be re-run against
// a parser whose behaviour is unknown.
const refusals = [];
const slopeOf = (p, which) => report.profiles[p] && report.profiles[p][which].slope;
const presentControls = CONTROLS.filter((p) => PROFILES.includes(p));
const presentSubjects = SUBJECTS.filter((p) => PROFILES.includes(p));
if (presentControls.length && presentSubjects.length) {
  const worstControl = Math.max(...presentControls.map((p) => slopeOf(p, "parse")));
  const bestSubject = Math.max(...presentSubjects.map((p) => slopeOf(p, "parse")));
  if (!(bestSubject > worstControl)) {
    refusals.push(
      `the estimator does not discriminate: the steepest subject (${bestSubject.toFixed(3)}) is not ` +
        `above the steepest control (${worstControl.toFixed(3)}), so a superlinear reading cannot be ` +
        "attributed to the parser rather than to the harness",
    );
  }
}
// A slope materially below 1 means time is NOT growing with document size,
// which no correct parser does - it means the work was optimised away, the
// document did not actually grow, or the clock is wrong. Absolute, but it is a
// statement about arithmetic rather than about performance, so it does not
// drift with the product.
for (const p of PROFILES) {
  for (const which of ["lex", "parse"]) {
    const s = slopeOf(p, which);
    if (!(s > 0.8)) {
      refusals.push(
        `${p} ${which} scaled at ${s.toFixed(3)} - below 1 means the measured work did not grow ` +
          "with the document, so this capture is not measuring parsing",
      );
    }
  }
}

// PARSE INCLUDES LEX, SO PARSE CANNOT BE CHEAPER THAN LEX. This is not a
// performance expectation, it is arithmetic about what the two calls do:
// `marked.parse` runs the lexer and then walks the tokens it produced. A cell
// where lex exceeds parse is therefore a measurement defect, and it is the
// exact defect the first version of this file shipped - `wide`@1024KB read
// lex 944.7ms against parse 613.0ms because both were timed in one repetition,
// always in the same order, with the heap left where the previous measurement
// put it. It reproduced in all three runs, so noise thresholds would not have
// caught it; only the impossibility does.
//
// 10% of slack, because the two calls are not identical work: parse builds a
// string, and lex retains a token tree the collector then has to deal with.
// The defect being guarded against was 54%, so the slack is not load-bearing.
for (const p of PROFILES) {
  const e = report.profiles[p];
  for (let i = 0; i < SIZES.length; i++) {
    const lexMs = e.lex.medianMs[i];
    const parseMs = e.parse.medianMs[i];
    if (lexMs > parseMs * 1.1) {
      refusals.push(
        `${p}@${Math.round(SIZES[i] / 1024)}KB measured lex at ${lexMs.toFixed(1)}ms but parse at ` +
          `${parseMs.toFixed(1)}ms - parse lexes and then renders, so this is not a timing of the ` +
          "parser but of something the previous measurement left behind",
      );
    }
  }
}

const width = Math.max(...PROFILES.map((p) => p.length));
console.log(`${"profile".padEnd(width)}  which  ${SIZES.map((s) => `${Math.round(s / 1024)}KB`.padStart(9)).join("")}   slope  per-doubling`);
for (const p of PROFILES) {
  for (const which of ["lex", "parse"]) {
    const e = report.profiles[p][which];
    console.log(
      `${p.padEnd(width)}  ${which.padEnd(5)}  ` +
        e.medianMs.map((t) => t.toFixed(1).padStart(9)).join("") +
        `   ${e.slope.toFixed(3)}  ` +
        e.doublingExponents.map((x) => x.toFixed(2)).join(" "),
    );
  }
}
console.log("");
console.log("slope and per-doubling figures are exponents: 1.0 linear, 2.0 quadratic.");
console.log(`controls: ${presentControls.join(", ") || "(none)"}   subjects: ${presentSubjects.join(", ") || "(none)"}`);

const out = {
  what: "marked parse/lex cost before the marked 9 -> 18 upgrade",
  capturedAt: new Date().toISOString(),
  bundle: markedFile,
  renderOptions: RENDER_OPTIONS,
  runtime: {
    node: process.versions.node,
    v8: process.versions.v8,
    electron: process.versions.electron || null,
    platform: `${process.platform} ${process.arch}`,
    gc: typeof global.gc === "function",
  },
  regime: { runs: RUNS, reps: REPS, warmups: WARMUPS, sizes: SIZES },
  subjects: SUBJECTS,
  controls: CONTROLS,
  report,
  // RAW, every repetition of every run. The summary above is one set of
  // questions; this is what lets a later reader ask a different one.
  samples,
  refusals,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2).replace(/\n/g, "\r\n") + "\r\n");
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);

if (refusals.length) {
  console.log("");
  for (const r of refusals) console.error(`REJECTED: ${r}`);
  console.error("");
  console.error("  The file was still written, because a refused capture is evidence about the");
  console.error("  harness and deleting it would lose that. It must NOT be committed as the");
  console.error("  pre-upgrade record.");
  process.exit(3);
}
