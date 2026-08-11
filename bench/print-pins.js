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

function sha(s) {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

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
else {
  console.error("usage: node bench/print-pins.js <digest|blocks>");
  console.error("");
  console.error("  digest  the CORPUS_DIGEST block (axis 9)");
  console.error("  blocks  the BLOCK_IDENTITY block (axis 8)");
  console.error("");
  console.error("Read the failures from `npm run test:corpus` BEFORE pasting either.");
  process.exit(2);
}
