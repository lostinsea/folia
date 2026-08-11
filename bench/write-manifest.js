// bench/write-manifest.js - regenerate bench/manifest.json
//
// Run this ONLY when the corpus is deliberately changed, and understand what it
// means: every performance number recorded against the previous manifest
// becomes incomparable at that moment. That is the whole point of the hash -
// it makes a silent corpus change impossible, so the choice to void the history
// has to be made on purpose.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { PROFILES, generate, lexerCounts, sha256, REFERENCE_SIZES } = require("./corpus");

const manifest = { profiles: {} };
for (const profile of PROFILES) {
  manifest.profiles[profile] = {};
  for (const size of REFERENCE_SIZES) {
    const text = generate(profile, size);
    manifest.profiles[profile][String(size)] = {
      bytes: Buffer.byteLength(text, "utf8"),
      blocks: text.split("\n\n").length,
      sha256: sha256(text),
      tokens: lexerCounts(text),
    };
  }
}
const out = path.join(__dirname, "manifest.json");
const serialised = JSON.stringify(manifest, null, 2) + "\n";
// A FAILED REGENERATION MUST NOT COST THE PREVIOUS MANIFEST. verify.js reads
// manifest.json from its fixed path, so a candidate has to actually be in place
// to be checked - which means the old one is overwritten before it is known to
// be good. Keep the previous bytes in memory and put them back on any failure
// below, so a rejected regeneration leaves the corpus pins exactly as they
// were. Without this, the one artifact that makes every recorded timing
// comparable is destroyed by the very check meant to protect it.
// CAPTURING `previous` IS ITSELF A FAILURE PATH, and it is the FIRST thing to
// touch the file. Measured: with manifest.json locked, this read throws EBUSY
// before any guard below it can run, and the script dies on a raw stack trace.
//
// AND THE OBVIOUS FIX IS A DATA-LOSS BUG. Catching the error and leaving
// `previous = null` would tell abort() there was no previous manifest, and its
// no-previous branch DELETES the candidate - so a transient read failure would
// end with the real, approved manifest unlinked. "Cannot read it" and "it does
// not exist" are different facts and must not collapse into one null.
//
// So an unreadable-but-present manifest is a hard stop: without its bytes there
// is nothing to restore, and this script must not begin an operation it cannot
// roll back.
let previous = null;
if (fs.existsSync(out)) {
  try {
    previous = fs.readFileSync(out, "utf8");
  } catch (err) {
    console.error(
      `could not read the existing ${out} (${(err && err.code) || err}).\n` +
        "REFUSING TO REGENERATE - without its current bytes a rejected regeneration\n" +
        "could not be rolled back, and the pinned corpus would be lost.",
    );
    process.exit(1);
  }
}
function abort(message) {
  if (previous !== null) {
    // The restore can fail for exactly the same reasons the write did (that is
    // now one of its callers), and an exception thrown out of the recovery path
    // would replace a clear diagnosis with a stack trace about the recovery.
    try {
      fs.writeFileSync(out, previous);
      console.error("\nthe previous manifest.json has been restored; nothing was changed.");
    } catch (err) {
      console.error(
        `\nCOULD NOT RESTORE ${out} (${(err && err.code) || err}). ` +
          "The file on disk is NOT a manifest anyone approved - restore it from git before running the benchmark.",
      );
    }
  } else {
    // FIRST-EVER GENERATION HAS NOTHING TO RESTORE, AND LEAVING THE REJECTED
    // CANDIDATE BEHIND IS WORSE THAN LEAVING NOTHING. A manifest on disk is
    // taken by verify.js and run.js as the pinned corpus; one that has just
    // been rejected would be silently adopted by the next run. Remove it, so
    // the failure state is "no manifest" rather than "a manifest nobody
    // approved".
    try {
      fs.unlinkSync(out);
      console.error("\nthe rejected manifest.json has been removed; there was no previous one.");
    } catch {}
  }
  console.error(message);
  process.exit(1);
}
// THE WRITE ITSELF IS A FAILURE PATH, and it is the one abort() cannot reach
// from below. If it throws - locked file, read-only, disk full - the exception
// propagates unhandled, `previous` is never put back, and the process dies with
// whatever partial bytes the failed open/truncate left behind. Holding the
// previous manifest in memory only helps if every path that can lose it routes
// through abort(), so this one does too.
try {
  fs.writeFileSync(out, serialised);
} catch (err) {
  abort(`could not write ${out}: ${(err && err.code) || err}`);
}

// A WRITER THAT REPORTS ITS OWN IN-MEMORY OBJECT HAS VERIFIED NOTHING.
// Everything above this line describes what was INTENDED to be written; the
// only thing verify.js and run.js ever read is the file. Read it back and
// compare, so a truncated, partially-flushed or lossily-serialised manifest
// fails here rather than surfacing later as an unexplained hash mismatch in a
// benchmark run.
const readBack = fs.readFileSync(out, "utf8");
if (readBack !== serialised) {
  abort(
    `ABORT: manifest.json on disk does not match what was written ` +
      `(wrote ${serialised.length} bytes, read back ${readBack.length}).`,
  );
}
let parsed;
try {
  parsed = JSON.parse(readBack);
} catch (err) {
  abort(`ABORT: manifest.json is not valid JSON after writing: ${err.message}`);
}
if (JSON.stringify(parsed) !== JSON.stringify(manifest)) {
  abort("ABORT: manifest.json did not survive a JSON round trip unchanged.");
}
console.log(`wrote ${out}`);
for (const p of PROFILES) {
  const r = manifest.profiles[p][String(REFERENCE_SIZES[1])];
  console.log(`  ${p.padEnd(9)} ${String(r.bytes).padStart(8)} bytes  ${JSON.stringify(r.tokens)}`);
}

// THE MANIFEST IS REGENERABLE; THE ORACLES AROUND IT ARE NOT. verify.js pins
// four axes by hand (SHAPE, INTERNALS, ELEMENTS, TEXTURE) precisely because a
// regenerated manifest agrees with whatever the corpus now happens to be. So
// running the writer must not be a way to make a corpus change pass unnoticed:
// hand the new file straight to its consumer and fail loud if it is rejected.
// A failure here is not necessarily a bug - a DELIBERATE corpus change is meant
// to fail, and the correct response is to re-derive the pins BY MEASUREMENT and
// say so in BASELINE.md, never to widen a tolerance until the failure stops.
console.log("\nverifying the new manifest against the hand-pinned oracles...");
const res = spawnSync(process.execPath, [path.join(__dirname, "verify.js")], {
  stdio: ["ignore", "pipe", "pipe"],
  encoding: "utf8",
});
if (res.error) {
  abort(`ABORT: could not run verify.js: ${res.error.message}`);
}
if (res.status !== 0) {
  const failures = res.stdout
    .split(/\r?\n/)
    .filter((l) => /^\s*FAIL/.test(l))
    .join("\n");
  console.error(failures || res.stdout);
  console.error(res.stderr || "");
  abort(
    `\nABORT: the regenerated manifest does not satisfy verify.js (exit ${res.status}).\n` +
      `If the corpus change was deliberate, re-derive the failing pins in\n` +
      `bench/verify.js by MEASURING the new corpus, and record the change in\n` +
      `bench/BASELINE.md - every timing recorded against the old corpus becomes\n` +
      `incomparable the moment you regenerate. Then run this again. Do NOT widen\n` +
      `a tolerance to silence this.\n` +
      `(The pins in verify.js are derived from corpus.js directly, so they can be\n` +
      `re-measured without the new manifest being in place.)`,
  );
}
console.log(res.stdout.trim().split(/\r?\n/).pop());
