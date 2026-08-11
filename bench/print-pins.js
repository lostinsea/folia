#!/usr/bin/env node
"use strict";
// Prints the hand-pinned oracle constants that live in verify.js.
//
// THIS SCRIPT PRINTS. IT DOES NOT WRITE, and that is the entire design.
//
// verify.js's pins are deliberately NOT regenerable: write-manifest.js can
// rebuild manifest.json from whatever corpus.js currently says, so the manifest
// alone only ever catches an accident. The hand-pinned axes are what a
// deliberate - or merely unnoticed - corpus change cannot regenerate away.
// Wiring this script into write-manifest.js would hand that property straight
// back and make eight axes decorative.
//
// So why commit it at all? Because until now the pins were produced by throwaway
// helpers that were never committed, which review correctly called out: the
// literals in verify.js could be re-derived by nobody but their author, and a
// future reader facing a legitimate corpus change had no reproducible way to
// re-pin. That is its own kind of unmaintainable.
//
// The workflow this supports is:
//   1. change corpus.js on purpose
//   2. run `npm run test:corpus` and READ THE FAILURES - they name the
//      dimension that moved, which is the step that makes the change deliberate
//   3. satisfy yourself that every named dimension moved for the reason you
//      intended
//   4. run `node bench/print-pins.js <axis>` and paste the block into verify.js
//   5. run `node bench/write-manifest.js`
//
// Step 2 and 3 are not optional decoration. Pasting first turns every oracle in
// this directory into a rubber stamp.
const crypto = require("crypto");
const { PROFILES, REFERENCE_SIZES, DIGEST_SIZES, generate, lexTokens } = require("./corpus");
const { marked } = require("../libs/vendor/marked.min.js");

function sha(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// EVERY MEASUREMENT BELOW IS DUPLICATED FROM verify.js, AND THE DUPLICATION IS
// SAFE FOR ONE SPECIFIC REASON THAT DOES NOT GENERALISE.
//
// The rule this directory learned in round 8 is that an oracle may not share
// code with its subject. This script is not an oracle - it proposes numbers,
// and verify.js recomputes every one of them independently from the corpus. So
// a divergence between the two implementations cannot produce a false pass: it
// produces a FAILING assertion in verify.js naming the dimension that differs.
// The duplication is checked by the thing it feeds.
//
// What it must NOT become is a source of truth. If verify.js is ever changed to
// import these functions, that property is gone and both files would agree on
// the same mistake - the exact shape of the round-8 defect.
function renderHtml(md) {
  return marked.parse(md, { async: false });
}
function countElements(html) {
  const counts = {};
  for (const m of html.matchAll(/<([a-z][a-z0-9]*)[\s/>]/g)) {
    counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return counts;
}
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
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const round = (x, dp) => Number(x.toFixed(dp));

// MUST MATCH verify.js's sampleIndices EXACTLY. The pins are positional against
// it, so a divergence compares block 3 against block 5's hash and reports a
// mutation that never happened. verify.js additionally asserts that the number
// of blocks it samples equals the number of hashes pinned, which is what makes
// a divergence in the COUNT loud rather than silent.
function sampleIndices(n) {
  const idx = [];
  for (let i = 0; i < 7 && i < n; i++) idx.push(i);
  for (const extra of [Math.floor(n / 2), n - 1]) if (!idx.includes(extra)) idx.push(extra);
  return idx.sort((a, b) => a - b);
}

function printElements() {
  const out = ["const ELEMENTS = {"];
  for (const p of PROFILES) {
    const size = REFERENCE_SIZES[0];
    const tokens = lexTokens(generate(p, size)).length;
    const seen = countElements(renderHtml(generate(p, size)));
    const parts = Object.keys(seen)
      .sort()
      .map((el) => `${el}: ${round(seen[el] / tokens, 6)}`);
    out.push(`  ${p}: { ${parts.join(", ")} },`);
  }
  out.push("};");
  console.log(out.join("\n"));
  console.log("");
  console.log("// NOTE: these are printed as decimals. Where the true value is an exact");
  console.log("// rational (dense is 1/7, 4/7, 20/7 ...) WRITE THE FRACTION, not the decimal -");
  console.log("// the existing entries do, and a fraction states the builder's design intent");
  console.log("// while a decimal states one measurement of it.");
}

function printTexture() {
  const out = ["const TEXTURE = {"];
  for (const p of PROFILES) {
    const at = [];
    let minWords = Infinity;
    let minChars = Infinity;
    for (const size of REFERENCE_SIZES) {
      const raw = lexTokens(generate(p, size)).map((t) => String(t.raw || "").trim());
      const words = raw.map((r) => (r.match(/\S+/g) || []).length);
      const chars = raw.map((r) => r.length);
      minWords = Math.min(minWords, ...words);
      minChars = Math.min(minChars, ...chars);
      at.push(`${size}: { words: ${round(mean(words), 2)}, chars: ${round(mean(chars), 2)} }`);
    }
    out.push(`  ${p}: {`);
    // The floors are the OBSERVED minima, printed here as a starting point.
    // They are meant to be round numbers slightly below the observed value -
    // a floor equal to the measurement is a second copy of it, not a floor.
    out.push(`    minWords: ${minWords}, // observed minimum - round DOWN before pasting`);
    out.push(`    minChars: ${minChars}, // observed minimum - round DOWN before pasting`);
    out.push(`    at: { ${at.join(", ")} },`);
    out.push("  },");
  }
  out.push("};");
  console.log(out.join("\n"));
}

function printTextShape() {
  const out = ["const TEXT_SHAPE = {"];
  for (const p of PROFILES) {
    out.push(`  ${p}: {`);
    for (const size of REFERENCE_SIZES) {
      const toks = lexTokens(generate(p, size));
      const raw = toks.map((t) => String(t.raw || "").trim());
      const n = toks.length;
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
      const chars = Object.keys(tally)
        .sort()
        .map((k) => `${JSON.stringify(k)}: ${round(tally[k] / n, 4)}`);
      out.push(`    ${size}: {`);
      out.push(`      maxRun: ${maxRun},`);
      out.push(`      meanBlockMaxRun: ${round(sumBlockMax / n, 4)},`);
      out.push(`      chars: { ${chars.join(", ")} },`);
      out.push("    },");
    }
    out.push("  },");
  }
  out.push("};");
  console.log(out.join("\n"));
}

function printDigest() {
  const out = ["const CORPUS_DIGEST = {"];
  for (const p of PROFILES) {
    out.push(`  ${p}: {`);
    for (const size of DIGEST_SIZES) {
      out.push(`    ${size}: ${JSON.stringify(sha(generate(p, size)))},`);
    }
    out.push("  },");
  }
  out.push("};");
  console.log(out.join("\n"));
}

function printBlocks() {
  const out = ["const BLOCK_IDENTITY = {"];
  for (const p of PROFILES) {
    out.push(`  ${p}: {`);
    for (const size of REFERENCE_SIZES) {
      const toks = lexTokens(generate(p, size));
      const parts = sampleIndices(toks.length).map((i) =>
        JSON.stringify(sha(String(toks[i].raw || "").trim()).slice(0, 16)),
      );
      out.push(`    ${size}: { tokens: ${toks.length}, blocks: [${parts.join(", ")}] },`);
    }
    out.push("  },");
  }
  out.push("};");
  console.log(out.join("\n"));
}

const which = String(process.argv[2] || "").toLowerCase();
if (which === "digest") printDigest();
else if (which === "blocks") printBlocks();
else if (which === "elements") printElements();
else if (which === "texture") printTexture();
else if (which === "textshape") printTextShape();
else {
  console.error("usage: node bench/print-pins.js <digest|blocks|elements|texture|textshape>");
  console.error("");
  console.error("  elements   the ELEMENTS block (axis 3)");
  console.error("  texture    the TEXTURE block (axis 4)");
  console.error("  textshape  the TEXT_SHAPE block (axis 6)");
  console.error("  blocks     the BLOCK_IDENTITY block (axis 8)");
  console.error("  digest     the CORPUS_DIGEST block (axis 9)");
  console.error("");
  console.error("SHAPE, INTERNALS and ATTRIBUTES are deliberately absent: each is a");
  console.error("statement of a builder's DESIGN INTENT (a profile of tables is 1.0 table,");
  console.error("a table has 10 header cells) and printing them from the corpus would let");
  console.error("a builder change re-derive its own specification. HIGHLIGHT is absent");
  console.error("because it needs the Prism sandbox verify.js builds; read its numbers");
  console.error("from that axis's failure output instead.");
  console.error("");
  console.error("Read the failures from `npm run test:corpus` BEFORE pasting any of them.");
  process.exit(2);
}
