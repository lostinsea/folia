// bench/run.js - timing runner over the fixed corpus
//
// NOT part of `npm test`, deliberately. Every suite in this project uses
// STRUCTURAL oracles precisely because timing assertions are flaky and, worse,
// do not say what broke. This runner reports; it never asserts. `npm run
// test:corpus` (bench/verify.js) is the part that belongs in the gate.
//
// WHAT TO READ IN THE OUTPUT. The absolute milliseconds are machine-specific
// and are only comparable against another run ON THE SAME MACHINE - which is
// what the fingerprint block exists to make checkable rather than assumed. The
// figure that travels between machines is the RATIO column: each size doubles,
// so a linear pass reports ~2.0 and a quadratic one ~4.0. That column is how
// the two O(n^2) passes in this pipeline were identified, and it is the reason
// three sizes are measured rather than one.
//
// The corpus hash is verified BEFORE anything is timed. Measuring a corpus that
// has silently drifted is worse than not measuring at all: it still prints a
// plausible number, and the number is not comparable with anything.
"use strict";

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  PROFILES,
  generate,
  sha256,
  REFERENCE_SIZES,
  BENCH_DEFAULT_SIZES,
  DIGEST_SIZES,
} = require("./corpus");

// A HEAP FULL OF THE PREVIOUS DOCUMENT'S GARBAGE IS INHERITED STATE. Measured
// on tables@1MB with every phase instrumented: marked.parse took 181ms on one
// repetition and 1932ms on another, from a BYTE-IDENTICAL input string, while
// every other phase stayed flat - a 10x swing that was the whole of the 170%
// spread. Tearing down a 73,667-node document leaves that much garbage behind,
// and the next allocation-heavy parse pays to collect it.
//
// The reset already exists to start every measurement from a known state and
// runs outside the timed region; collecting that garbage is the completion of
// that reset, not a trick to flatter the numbers. This switch is what makes
// window.gc() available to do it, and the ready check below FAILS LOUD if it
// did not take effect - a silently absent gc would restore the 10x swing while
// the runner went on printing plausible medians.
app.commandLine.appendSwitch("js-flags", "--expose-gc");

require("../main.js");

// THE REPORT IS INVALIDATED BEFORE ANYTHING ELSE RUNS, INCLUDING ARGUMENT
// VALIDATION. Those checks exit(2) on a typo, and while they were ordered after
// this block a mistyped --sizes or --reps left the PREVIOUS run's STATUS: OK
// sitting on disk - the same stale-report hole in a milder disguise, and one
// this file made WORSE by adding two more early exits to fix a different bug.
// A file describing a run that did not happen is the thing being prevented, so
// it is invalidated first and validated second.
const lines = [];
function say(s) {
  lines.push(s);
  console.log(s);
}

const RESULTS_PATH = path.join(__dirname, "..", "bench-results.txt");

// ONE RUN AT A TIME, BECAUSE THE REPORT IS A SINGLE SHARED FILE.
//
// Two concurrent `npm run bench` invocations both write bench-results.txt, and
// the loser's INCOMPLETE marker lands on top of the winner's finished table -
// or worse, the winner's STATUS: OK lands while the loser is still measuring,
// so the file reads as a completed run describing numbers that are still
// moving. Neither process would notice, and the file is the artifact this whole
// suite exists to produce. Concurrency also invalidates the numbers themselves:
// two Electron instances competing for CPU is exactly the noise the ratios are
// meant to see through.
//
// The lock is taken BEFORE the invalidating write below, because the point is
// to leave a run already in progress entirely alone - including its report.
//
// A STALE LOCK IS EXPECTED HERE, NOT EXCEPTIONAL. This project's operating
// procedure is to force-kill leftover Electron processes between runs, so a
// lock file whose owner no longer exists is the normal aftermath of a killed
// run, and refusing on it would mean hand-deleting a file after every
// interruption. So the holder's pid is recorded and checked: a live holder is
// refused, a dead one is taken over and said so.
const LOCK_PATH = RESULTS_PATH + ".lock";
// DEFINED BEFORE THE LOCK BLOCK BECAUSE THE LOCK BLOCK NEEDS IT. Its ordinary
// call site is still further down, after the exit wrapper is installed - only
// the definition moved. See the long comment there for why the report is
// overwritten at all.
function invalidateReport() {
  try {
    fs.writeFileSync(
      RESULTS_PATH,
      "STATUS: INCOMPLETE (the run did not reach the end; this file is not a result)\n",
    );
  } catch (err) {
    console.error(
      `bench: cannot write ${RESULTS_PATH} (${(err && err.code) || err}).\n` +
        "bench: REFUSING TO RUN - the file still on disk is a PREVIOUS run's report and\n" +
        "bench: nothing would mark it stale. Close whatever holds it open and retry.",
    );
    process.exit(2);
  }
}
// REFUSING BECAUSE THE LOCK PATH IS BROKEN AND REFUSING BECAUSE SOMEBODY ELSE
// IS RUNNING ARE NOT THE SAME REFUSAL, and the difference is entirely about who
// owns bench-results.txt.
//
// A live holder owns it: they are mid-run and will write their own report, so
// touching it would corrupt a run that is doing nothing wrong. That refusal
// must leave the file completely alone.
//
// An unusable lock path - a directory at bench-results.txt.lock, a permissions
// failure, an unlink that cannot succeed - means NOBODY holds the lock, because
// nobody could have taken it. The file on disk is therefore some PREVIOUS run's
// report, and exiting without saying so leaves a `STATUS: OK` that reads
// exactly like a fresh pass. That is the same stale-artifact disease as the
// screenshot harness leaving the last run's PNG in place, and it was reproduced
// here rather than assumed: with the lock path a directory the run exited 2 and
// bench-results.txt still said STATUS: OK.
function refuseBrokenLock(reason) {
  console.error(
    `bench: ${reason}\n` +
      `bench: REFUSING TO RUN. The lock path ${LOCK_PATH} is unusable, so no run holds it -\n` +
      `bench: ${RESULTS_PATH} is a PREVIOUS run's report and is being marked stale now.`,
  );
  invalidateReport();
  process.exit(2);
}
// A live holder whose lock is older than this is treated as stale anyway.
// THIS IS A BOUND, NOT A PROOF, and it is written down as one: a pid can be
// reused by an entirely unrelated process, and there is no portable way to ask
// whether pid N is really the benchmark that wrote this file. Without a ceiling
// that misidentification refuses every future run until someone deletes the
// file by hand. The value is ~13x the slowest full bench observed (9 minutes),
// so it cannot plausibly steal a real run.
const LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
function pidAlive(pid) {
  try {
    // Signal 0 performs the permission and existence check without delivering
    // anything. EPERM means the pid exists but belongs to someone else, which
    // for this purpose is still "alive".
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === "EPERM";
  }
}
// THE RAW UNLINK AND "RELEASE THE LOCK I HOLD" ARE DELIBERATELY TWO FUNCTIONS.
// The stale-takeover path below removes SOMEBODY ELSE's file before we own
// anything, so routing it through the latched release would mark our own lock
// as already released and then skip the unlink that actually matters - we would
// leak the very lock we just took. Splitting them makes that impossible rather
// than merely unlikely.
// RETURNS WHETHER THE PATH IS CLEAR, because the takeover path needs to know.
// A failed unlink used to warn and let the loop go round again, which produced
// the same EEXIST, another takeover announcement and another failed unlink -
// three identical warnings for one unusable path, and then a refusal naming
// EEXIST, which is the one thing that was NOT the problem.
function unlinkLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
    return true;
  } catch (err) {
    if (!err || err.code === "ENOENT") return true;
    console.error(`bench: could not remove ${LOCK_PATH} (${err.code}); remove it by hand.`);
    return false;
  }
}
// MUST STAY SYNCHRONOUS AND MUST NOT THROW OUTWARD. It runs from inside the
// process.exit wrapper below and from signal handlers, where there is no later
// turn of the event loop to finish anything asynchronous and nothing to catch
// an exception. Making it async, or letting an error escape, turns the wrapper
// into either a no-op or an unhandled throw on the way out.
//
// IDEMPOTENT because it is reached from several paths at once: bail() and
// finish() call it explicitly, the exit wrapper calls it, and a signal handler
// that then exits calls it a third time.
let lockHeld = false;
function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  unlinkLock();
}
for (let attempt = 0; ; attempt++) {
  try {
    fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, started: Date.now() }), {
      flag: "wx",
    });
    lockHeld = true;
    break;
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      refuseBrokenLock(`cannot create ${LOCK_PATH} (${(err && err.code) || err}).`);
    }
    if (attempt >= 2) {
      refuseBrokenLock(
        `${LOCK_PATH} still exists after ${attempt + 1} attempts to clear a stale lock.`,
      );
    }
    let holder = 0;
    let started = 0;
    try {
      const text = String(fs.readFileSync(LOCK_PATH, "utf8")).trim();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        parsed = null;
      }
      // JSON.parse SUCCEEDS on a bare pid - "999999" is valid JSON for the
      // NUMBER 999999 - so testing only for a thrown error is not enough. That
      // was measured, not predicted: a legacy lock reported its holder as
      // "unknown" and was taken over, which for a LIVE holder is precisely the
      // concurrent run this lock exists to refuse. The shape of the parse
      // result is what decides, not whether it threw.
      if (parsed && typeof parsed === "object") {
        holder = Number(parsed.pid) || 0;
        started = Number(parsed.started) || 0;
      } else {
        // A lock written by an older build of this file held the bare pid and
        // no timestamp, so it can only ever be judged by liveness.
        holder = Number(text) || 0;
      }
    } catch (readErr) {
      // The holder released it between our open and our read. Retry.
      if (readErr && readErr.code === "ENOENT") continue;
      // ANY OTHER READ FAILURE MEANS WE CANNOT SEE WHO HOLDS IT, and "I could
      // not read it" is not evidence that it is stale. Announcing a takeover
      // here - which is what this used to do, twice, for a directory - claims
      // in as many words that the holder is no longer running, on the strength
      // of no information at all.
      refuseBrokenLock(`cannot read ${LOCK_PATH} (${(readErr && readErr.code) || readErr}).`);
    }
    const ageMs = started ? Date.now() - started : 0;
    if (holder && holder !== process.pid && pidAlive(holder) && ageMs <= LOCK_MAX_AGE_MS) {
      // DELIBERATELY NOT invalidateReport(): the live holder owns that file.
      console.error(
        `bench: another benchmark run (pid ${holder}) is in progress. REFUSING TO RUN -\n` +
          "bench: two runs share bench-results.txt and would overwrite each other's report,\n" +
          "bench: and competing for CPU would invalidate both sets of numbers.",
      );
      process.exit(2);
    }
    console.error(
      `bench: taking over a stale lock left by pid ${holder || "unknown"}` +
        (started && ageMs > LOCK_MAX_AGE_MS
          ? `, whose pid is live but whose lock is ${Math.round(ageMs / 60000)} minutes old.`
          : ", which is no longer running."),
    );
    if (!unlinkLock()) {
      refuseBrokenLock(`the stale lock at ${LOCK_PATH} could not be removed.`);
    }
  }
}
// THE LOCK MUST BE RELEASED ON EVERY EXIT PATH, AND `process.on("exit")` DOES
// NOT DO THAT HERE. Measured with a throwaway Electron app rather than assumed:
// Electron REPLACES process.exit with its own non-native function
// (`process.exit.toString()` contains no [native code]) and that replacement
// emits neither 'exit' nor 'beforeExit'. A `process.on("exit", releaseLock)`
// line therefore reads as a safety net while protecting nothing - the worst
// kind of guard, and the reason this was caught: a run refused on a typo left
// its own lock behind, so the NEXT run announced a stale takeover.
//
// Releasing at each call site instead would be the disease this file has
// already been bitten by twice - the ordering bug above exists precisely
// because two early exits were added without noticing what they bypassed, and
// arg validation alone has six of them. Wrapping the exit closes the class, so
// an early return added later cannot reintroduce it.
const realProcessExit = process.exit.bind(process);
process.exit = (code) => {
  releaseLock();
  return realProcessExit(code);
};

// SIGNALS BYPASS THE WRAPPER ENTIRELY - AND ON WINDOWS THIS HANDLER IS PROVEN
// NOT TO FIRE. Read that before trusting it.
//
// Ctrl-C is how an interrupted bench actually ends, far more often than a clean
// early return, and it terminates the process without any of the code above
// running. The round-6 review proposed this handler as the fix. It is only half
// a fix, and the half that is missing was MEASURED with a control rather than
// assumed - the same method that caught process.on("exit") being inert here:
//
//   a throwaway probe registering exactly these four handlers, launched twice,
//   sent the same real CTRL_C_EVENT via GenerateConsoleCtrlEvent:
//     plain node.exe   sigintListeners=1  ->  HANDLER RAN: SIGINT
//     electron.exe     sigintListeners=1  ->  handler never ran, process died
//
// So Electron's own console-control handling terminates the main process before
// the Node layer is given the event. Confirmed end to end against this file: a
// real Ctrl-C to a live `npm run bench` killed it with the lock still on disk.
//
// THE HANDLER IS KEPT ANYWAY, and deliberately so: on POSIX hosts the signal is
// real and this releases correctly, and bench/ is a developer tool that is not
// Windows-only. What is NOT kept is the impression that it closes the gap. On
// this platform THE STALE-LOCK TAKEOVER ABOVE IS THE LOAD-BEARING MECHANISM for
// an interrupted run, which is why it is written to expect a stale lock as the
// normal case rather than an exceptional one.
//
// The handler re-raises rather than swallowing: exiting 130 here would report a
// clean-ish shutdown for what was really an interrupt, and anything wrapping
// this run (npm, a shell loop) needs the true disposition.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try {
    process.on(sig, () => {
      releaseLock();
      process.removeAllListeners(sig);
      try {
        process.kill(process.pid, sig);
      } catch (err) {
        realProcessExit(130);
      }
    });
  } catch (err) {
    // SIGHUP/SIGBREAK are not available on every platform; the ones that are
    // still get their handler.
  }
}

// INVALIDATE THE PREVIOUS REPORT BEFORE MEASURING ANYTHING.
//
// finish() writes bench-results.txt, so any crash BEFORE finish() leaves the
// PREVIOUS run's file untouched - reading `STATUS: OK`, with a full table of
// plausible numbers and a fingerprint. This is not hypothetical: a TDZ
// ReferenceError in the fingerprint block (introduced by adding one line to it)
// left an 84-minute-old report on disk saying the run had succeeded, and
// because the rejection was unhandled the process HUNG rather than exiting, so
// there was not even a non-zero exit code to contradict it.
//
// That is the same disease as the screenshot harness leaving the previous run's
// PNG in place when a capture failed: a stale artifact is indistinguishable
// from a fresh one, and it is a confident wrong answer in the exact place this
// project trusts most. So the file is overwritten with an explicit
// INCOMPLETE status first. A crashed run now leaves evidence that it crashed.

// CLOSES. Measured, not reasoned: with bench-results.txt held open by another
// process (FileShare.None), writeFileSync throws EBUSY, the process dies, and
// the previous run's `STATUS: OK` survives untouched. A read-only file or a
// concurrent `npm run bench` does the same. So the one write whose whole job is
// to stop a stale report being believed was, unguarded, the likeliest way to
// leave one. Exit loudly instead, and say that the file on disk is now unsafe
// to read - because it is, and nothing else will say so.
invalidateReport();

// Writing the terminal status is best-effort by necessity: the run is already
// over and the process is on its way out, so there is nothing left to fall back
// on. But a swallowed error here means the file still says INCOMPLETE while the
// console says FAILED, and the two disagree for a reason nobody can see. Say so.
function writeStatus(text) {
  try {
    fs.writeFileSync(RESULTS_PATH, text);
    return true;
  } catch (err) {
    console.error(
      `bench: could not update ${RESULTS_PATH} (${(err && err.code) || err}); ` +
        "the file on disk does NOT describe this run.",
    );
    return false;
  }
}

// An unhandled rejection inside app.whenReady().then(...) does not stop
// Electron - it just leaves the app idling forever with no report and no exit
// code. Fail loud and fast instead, keeping the INCOMPLETE marker above.
//
// uncaughtException IS HANDLED TOO, AND THE ASYMMETRY WAS A REAL HOLE. A
// synchronous throw inside a timer callback - the settle watchdog is exactly
// that shape - is not a rejection, so it missed this handler entirely.
// Measured: an Electron main process that throws inside setTimeout does not
// exit at all. Twelve seconds later the process was still alive with three
// Electron processes running - the same hang as the unhandled rejection, not
// the clean non-zero exit that would at least contradict a stale report.
function bail(kind, err) {
  console.error(`bench: ${kind}:`, (err && err.stack) || err);
  writeStatus(`STATUS: FAILED (${kind})\n${(err && err.stack) || err}\n`);
  // Explicitly, not only via the process 'exit' handler: app.exit() terminates
  // through Electron's own path and is not guaranteed to run Node's exit
  // handlers, and a lock left behind by a crashed run makes the NEXT run print
  // a stale-takeover warning it should not have to.
  releaseLock();
  app.exit(1);
}
process.on("unhandledRejection", (err) => bail("unhandled rejection", err));
process.on("uncaughtException", (err) => bail("uncaught exception", err));

// Appended to the STATUS line so a caveat about the run travels WITH the
// artifact rather than only on stderr. Declared here, above finish(), because
// the pin objects in this project have already caused one TDZ crash by being
// referenced before their module-scope declaration ran.
let statusSuffix = "";

function finish(code) {
  // A MACHINE-READABLE VERDICT ON THE FIRST LINE. The REJECTED banner is prose
  // at the bottom of a 50-line report, so anything that reads the file rather
  // than the exit code - a later comparison script, a human skimming for the
  // table - cannot tell a rejected run from a good one. It can now.
  const status = code === 0 ? `STATUS: OK${statusSuffix}` : `STATUS: FAILED (exit ${code})`;
  const text = [status, ...lines].join("\n") + "\n";
  // Electron drops buffered stdout on app.exit() when redirected, so the file
  // is the authoritative record - the same reason test-startup-perf.js writes
  // one. `bench-*.txt` is already gitignored as scratch benchmark output.
  //
  // A FAILED WRITE HERE MUST NOT BE REPORTED AS SUCCESS. Going through
  // writeStatus keeps this off the uncaughtException path (which would re-enter
  // finish's caller) and downgrades the exit code, so a run whose report never
  // reached disk cannot exit 0 with the previous run's file still in place.
  const wrote = writeStatus(text);
  releaseLock();
  app.exit(wrote ? code : 3);
}

// --- arguments -------------------------------------------------------------
// bench/run.js [--profiles=dense,tables] [--sizes=262144,524288,1048576]
const argv = process.argv.slice(2);
function arg(name, fallback) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
}
const profiles = String(arg("profiles", PROFILES.join(","))).split(",").filter(Boolean);

// A NUMERIC ARG OF ZERO IS A VALUE, NOT AN ABSENCE. `parseFloat(x) || fallback`
// silently discards 0, which was not theoretical: --spread-floor-ms=0 was
// accepted, reported nothing unusual, and left the floor at 50, so the override
// looked applied and was not.
//
// AND parseFloat STOPS AT THE FIRST NON-NUMERIC CHARACTER, so it accepted
// --spread-limit=0.15oops as 0.15 and --spread-floor-ms=1e2junk as 100 - a
// typo silently applying a threshold nobody typed, in the one place whose whole
// job is to record the standard a result was judged by. Number() validates the
// WHOLE string; the empty-string guard is needed because Number("") is 0.
//
// THIS IS DEFINED BEFORE THE ARGUMENTS THAT USE IT because fixing only the
// thresholds left the identical bug in both neighbours, and a reviewer found
// them there. Measured: `Math.max(1, parseInt("0", 10) || 3)` returns 3, so
// --reps=0 was silently a 3-rep run; --reps=abc and --reps=0.15oops likewise
// returned 3 while reporting nothing. Fixing a member of a bug class and
// leaving the class open is how all three of them survived this long.
const num = (name, fallback, { integer = false } = {}) => {
  const raw = arg(name, null);
  if (raw === null) return fallback;
  const parsed = String(raw).trim() === "" ? NaN : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed))) {
    console.error(
      `bench: --${name}=${raw} is not a non-negative ${integer ? "integer" : "number"}`,
    );
    process.exit(2);
  }
  return parsed;
};

// EVERY ENTRY MUST PARSE, not merely one of them. `[1024, "abc", 2048]` used to
// drop the typo and carry on, so a mistyped size produced a SUBSET benchmark
// that the fingerprint block then recorded as an ordinary run. The
// everything-dropped case was already caught below; the partial case is the one
// that lies, because it still produces a plausible table.
const sizeArg = String(arg("sizes", BENCH_DEFAULT_SIZES.join(",")));
const sizes = sizeArg
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s !== "")
  .map((s) => {
    const n = Number(s);
    if (!Number.isInteger(n) || n <= 0) {
      console.error(`bench: --sizes entry ${JSON.stringify(s)} is not a positive integer`);
      process.exit(2);
    }
    return n;
  });
// A SIZE NOBODY VERIFIED IS A NUMBER NOBODY SHOULD QUOTE. The default sizes
// are all covered by the corpus digest oracle, but --sizes accepts anything,
// and a custom size renders a corpus whose text no oracle has ever checked. It
// is still allowed - exploring a new size is a legitimate thing to want - but
// the run says so, because the whole point of the corpus is that a number in
// this table is attached to a known document.
// A WARNING ON STDERR IS NOT A PROPERTY OF THE ARTIFACT. A reviewer's point,
// and it is correct: the authoritative record is bench-results.txt, and a run
// with an unverified size still wrote `STATUS: OK` at the top of it with
// nothing in the file to say the corpus underneath it was unpinned. stderr is
// gone the moment the terminal scrolls; the file is what gets quoted, compared
// and pasted into BASELINE.md. So the marker goes in the status line itself,
// where anything reading the file - or skimming it - meets it first.
const unverifiedSizes = sizes.filter((s) => !DIGEST_SIZES.includes(s));
if (unverifiedSizes.length) {
  statusSuffix = ` (UNVERIFIED SIZES: ${unverifiedSizes.join(", ")} - corpus not pinned by any oracle)`;
  console.error(
    `bench: ${unverifiedSizes.join(", ")} is outside the verified set ` +
      `(${DIGEST_SIZES.join(", ")}). The corpus at those sizes is NOT pinned by\n` +
      "bench: any oracle, so treat the rows as exploratory and do not record them as a baseline.",
  );
}
// THE FINISHED DOCUMENT, PINNED BY HAND, per (profile, size) the benchmark
// reports. See the census check at the bottom of this file for why this exists
// and what it caught. Every number here was MEASURED by a run that refused the
// unpinned cell and printed a paste-ready block - never predicted, and never
// derived from anything the application could also change.
const RENDER_CENSUS = {
  prose: {
    262144: { blocks: 753, nodes: 753, tokens: 0 },
    524288: { blocks: 1507, nodes: 1507, tokens: 0 },
    1048576: { blocks: 2994, nodes: 2994, tokens: 0 },
  },
  headings: {
    262144: { blocks: 646, nodes: 4845, tokens: 0 },
    524288: { blocks: 1290, nodes: 9663, tokens: 0 },
    1048576: { blocks: 2572, nodes: 19278, tokens: 0 },
  },
  tables: {
    262144: { blocks: 505, nodes: 18685, tokens: 0 },
    524288: { blocks: 1006, nodes: 37222, tokens: 0 },
    1048576: { blocks: 1991, nodes: 73667, tokens: 0 },
  },
  lists: {
    262144: { blocks: 1932, nodes: 8694, tokens: 0 },
    524288: { blocks: 3858, nodes: 17361, tokens: 0 },
    1048576: { blocks: 7710, nodes: 34695, tokens: 0 },
  },
  code: {
    262144: { blocks: 2433, nodes: 65691, tokens: 43794 },
    524288: { blocks: 4823, nodes: 130221, tokens: 86814 },
    1048576: { blocks: 9604, nodes: 259308, tokens: 172872 },
  },
  dense: {
    262144: { blocks: 76, nodes: 14399, tokens: 3366 },
    524288: { blocks: 150, nodes: 28721, tokens: 6714 },
    1048576: { blocks: 298, nodes: 57365, tokens: 13410 },
  },
  wide: {
    262144: { blocks: 293, nodes: 21389, tokens: 0 },
    524288: { blocks: 585, nodes: 42705, tokens: 0 },
    1048576: { blocks: 1169, nodes: 85337, tokens: 0 },
  },
};

// THE CLASSES ON THE FINISHED DOCUMENT, pinned exactly, per (profile, size).
//
// WHY A SEPARATE CENSUS. RENDER_CENSUS counts nodes, blocks and tokens - so it
// is blind to any pass that changes no counts. Both reviewers reached that
// independently, and the class attribute is the unit those passes work in:
// markShortColumns() adds `nowrap-col`, applyTableBreakout() adds
// `table-breakout`, Prism labels every span with its token TYPE.
//
// WHY NOT A HASH OF innerHTML. It would move on every unrelated markup change
// and force a re-pin constantly, and when it fired it would say only
// "different" rather than naming what moved. Measured, the class vocabulary on
// this corpus is a closed set of at most 17 names per cell - small enough to
// pin by hand and to read in a diff.
//
// PINNED EXACTLY, WITH NO TOLERANCE, and that is measured rather than hoped:
// across every repetition of every cell the histogram was byte-identical
// (3 reps x 6 profiles, 6 distinct signatures, one per profile). Class counts
// are a property of the document, not of the machine, so unlike a timing they
// have no jitter to absorb. That makes this the strictest oracle in the file.
//
// WHAT IT CLOSES, MEASURED. Prism running in a real browser window was
// previously pinned only by axis 7, which runs prism-bundle.js inside a Node
// `vm` - a re-implementation of the endpoint, not the endpoint. The token
// SUBTYPE counts here (keyword, function, string, number, operator,
// punctuation) are what the shipped renderer actually produced, so a browser
// Prism that silently started classifying differently now fails by name even
// though the total `.token` count is unchanged.
//
// WHAT IT DOES NOT CLOSE, ALSO MEASURED, AND THE MORE IMPORTANT HALF.
// applyTableBreakout() was short-circuited outright and this census did NOT
// move - in any of the six profiles. The reason is not a weakness in the
// oracle: `table-breakout` appears in no cell because every table in the
// corpus FITS the reading column, so the pass never reaches its apply branch.
// The benchmark's single most expensive pass is therefore being timed
// executing only its no-op path (tables@256KB: render 566 -> 486ms, settle
// 782 -> 529ms, breakout phase 372 -> 0ms, with node counts and this histogram
// both perfectly unchanged). No oracle over the rendered output can cover a
// pass that produces no output. The fix is a corpus that contains a table too
// wide for the reading column - see BASELINE.md, where it is scheduled to ride
// with the marked 9 -> 18 upgrade, because both re-pin every cell and doing
// them separately would reset the comparison baseline twice.
const CLASS_CENSUS = {
  prose: {
    262144: {},
    524288: {},
    1048576: {},
  },
  headings: {
    262144: { "collapsible-section": 1615 },
    524288: { "collapsible-section": 3221 },
    1048576: { "collapsible-section": 6426 },
  },
  tables: {
    262144: { "nowrap-col": 9090, "table-container": 505, "table-maximize-btn": 505 },
    524288: { "nowrap-col": 18108, "table-container": 1006, "table-maximize-btn": 1006 },
    1048576: { "nowrap-col": 35838, "table-container": 1991, "table-maximize-btn": 1991 },
  },
  lists: {
    262144: {},
    524288: {},
    1048576: {},
  },
  code: {
    262144: { "check-icon": 2433, "code-block-container": 2433, "code-copy-btn": 2433, "copy-icon": 2433, "function": 4866, "keyword": 4866, "language-js": 4866, "number": 2433, "operator": 2433, "prism-highlighted": 2433, "punctuation": 26763, "string": 2433, "token": 43794 },
    524288: { "check-icon": 4823, "code-block-container": 4823, "code-copy-btn": 4823, "copy-icon": 4823, "function": 9646, "keyword": 9646, "language-js": 9646, "number": 4823, "operator": 4823, "prism-highlighted": 4823, "punctuation": 53053, "string": 4823, "token": 86814 },
    1048576: { "check-icon": 9604, "code-block-container": 9604, "code-copy-btn": 9604, "copy-icon": 9604, "function": 19208, "keyword": 19208, "language-js": 19208, "number": 9604, "operator": 9604, "prism-highlighted": 9604, "punctuation": 105644, "string": 9604, "token": 172872 },
  },
  dense: {
    262144: { "check-icon": 187, "code-block-container": 187, "code-copy-btn": 187, "collapsible-section": 187, "copy-icon": 187, "function": 374, "keyword": 374, "language-js": 374, "nowrap-col": 3366, "number": 187, "operator": 187, "prism-highlighted": 187, "punctuation": 2057, "string": 187, "table-container": 187, "table-maximize-btn": 187, "token": 3366 },
    524288: { "check-icon": 373, "code-block-container": 373, "code-copy-btn": 373, "collapsible-section": 373, "copy-icon": 373, "function": 746, "keyword": 746, "language-js": 746, "nowrap-col": 6714, "number": 373, "operator": 373, "prism-highlighted": 373, "punctuation": 4103, "string": 373, "table-container": 373, "table-maximize-btn": 373, "token": 6714 },
    1048576: { "check-icon": 745, "code-block-container": 745, "code-copy-btn": 745, "collapsible-section": 745, "copy-icon": 745, "function": 1490, "keyword": 1490, "language-js": 1490, "nowrap-col": 13410, "number": 745, "operator": 745, "prism-highlighted": 745, "punctuation": 8195, "string": 745, "table-container": 745, "table-maximize-btn": 745, "token": 13410 },
  },
  // THE ONLY PROFILE WHOSE CENSUS NAMES `table-breakout`, and the reason it
  // exists. Every table here is wider than the 900px reading column, so the
  // widening pass runs on all 293/585/1169 of them; in `tables` and `dense` the
  // tables fit and the pass is silently a no-op, which is how a benchmark spent
  // 79% of its time in a function no oracle could see the effect of. Note the
  // ABSENCE of `wrap-anyway` is pinned just as hard as the presence of
  // `table-breakout` - that class means the window was too narrow, which is a
  // fact about the screen, and the viewport-floor invariant in the regime block
  // is what makes its absence a property of the corpus instead.
  wide: {
    262144: { "compact-table": 293, "nowrap-col": 17580, "table-breakout": 293, "table-container": 293, "table-maximize-btn": 293 },
    524288: { "compact-table": 585, "nowrap-col": 35100, "table-breakout": 585, "table-container": 585, "table-maximize-btn": 585 },
    1048576: { "compact-table": 1169, "nowrap-col": 70140, "table-breakout": 1169, "table-container": 1169, "table-maximize-btn": 1169 },
  },
};

// WHEN TWO DOCUMENTS STOP BEING THE SAME DOCUMENT - one threshold, two uses.
// It gates `nodesAgree` (do the repetitions of a cell agree with each other?)
// and the census check (does the cell agree with its hand-pinned expectation?).
// Those are the same question asked of different pairs, so they must not be
// able to drift apart: a project rule earned the hard way here is that a magic
// number duplicated is a magic number that will eventually disagree with
// itself. 2% is well above the observed repetition jitter and far below any
// real regression - the Prism-skip breaker that motivated the census moved the
// node count by 67%.
const sameDocumentTolerance = 0.02;

// Each (profile, size) is measured this many times and the MEDIAN is reported.
// One sample is not a measurement here: the first run of this benchmark showed
// prose at 103ms for 256KB and 66ms for 512KB - twice the data in two thirds of
// the time - purely from noise and warm-up, which would read as a superlinear
// speedup to anyone taking the table at face value.
//
// Rejected rather than clamped: --reps=0 is a request this harness cannot
// honour, and silently substituting 3 is what the old code did.
const reps = num("reps", 3, { integer: true });
if (reps < 1) {
  console.error("bench: --reps must be at least 1");
  process.exit(2);
}

// THE SPREAD REJECTION THRESHOLDS, overridable BECAUSE they are calibrated to
// one machine. See the spreadLimit comment below for how the numbers were
// derived. The override exists so that someone on a slower or noisier machine
// has an honest option other than editing the guard out - and the effective
// values are printed in the fingerprint block, so any recorded result carries
// the thresholds it was judged by.
//
// DELIBERATELY NOT self-calibrating from the harness's own warm-up, which was
// the reviewing suggestion. Deriving the limit from the machine's observed
// noise widens the guard exactly when the machine is busy, so the one run that
// most needs rejecting is the one that raises its own bar until it passes. A
// guard whose threshold moves with the thing it is guarding against is not a
// guard.
const spreadLimit = num("spread-limit", 0.15);
const spreadFloorMs = num("spread-floor-ms", 50);

// A BENCHMARK THAT MEASURES NOTHING MUST NOT EXIT 0. `--sizes=abc` parses to an
// empty array, which makes Math.max(...sizes) return -Infinity, degenerates the
// warm-up, produces no rows at all and still reports success - a run that looks
// like it passed and contains no data. The same goes for a mistyped profile
// name, which was previously only "skipped".
if (!sizes.length) {
  console.error("bench: --sizes parsed to nothing. Pass byte counts, e.g. --sizes=262144,1048576");
  process.exit(2);
}
const unknownProfiles = profiles.filter((p) => !PROFILES.includes(p));
if (!profiles.length || unknownProfiles.length) {
  console.error(
    `bench: unknown profile(s) ${unknownProfiles.join(", ") || "(none given)"}. ` +
      `Known profiles: ${PROFILES.join(", ")}`,
  );
  process.exit(2);
}


// --- corpus integrity gate -------------------------------------------------
function verifyCorpus() {
  // THE BENCH AND THE CORPUS CHECKS MUST AGREE ON WHAT "marked" IS. corpus.js
  // hard-errors when libs/vendor holds more than one marked bundle, because
  // every token pin is a statement about one parser. That protected `npm run
  // test:corpus` but not this runner, which renders through whatever
  // index.html loads by hard-coded name: with two bundles present, verify.js
  // would refuse to run while `npm run bench` quietly measured the other one,
  // and the manifest would be describing a parser the benchmark was not using.
  // This matters imminently - the marked 9 -> 18 upgrade re-vendors this very
  // directory.
  const vendorDir = path.join(__dirname, "..", "libs", "vendor");
  const bundles = (fs.existsSync(vendorDir) ? fs.readdirSync(vendorDir) : [])
    .filter((f) => /^marked.*\.js$/.test(f))
    .sort();
  if (bundles.length !== 1) {
    return `libs/vendor holds ${bundles.length} marked bundles (${bundles.join(", ") || "none"}) - the benchmark and the corpus pins must be describing the same parser`;
  }

  const manifestPath = path.join(__dirname, "manifest.json");
  if (!fs.existsSync(manifestPath)) return "bench/manifest.json is missing";
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const profile of PROFILES) {
    for (const size of REFERENCE_SIZES) {
      const pinned = manifest.profiles[profile] && manifest.profiles[profile][String(size)];
      if (!pinned) return `manifest has no entry for ${profile}@${size}`;
      if (sha256(generate(profile, size)) !== pinned.sha256) {
        return `${profile}@${size} does not match the pinned sha256 - the corpus has drifted, so nothing measured here is comparable with any earlier run`;
      }
    }
  }
  return null;
}

// --- helpers ---------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  // A watchdog that only says "timed out" costs a whole diagnostic cycle: the
  // first stall of this runner produced 900 seconds of silence and a message
  // that named nothing. `where` is updated at every step so the timeout can
  // report the exact cell and phase it died in.
  let where = "startup";
  const watchdog = setTimeout(() => {
    say(`=== timed out after 900s while: ${where} ===`);
    finish(1);
  }, 900000);

  const drift = verifyCorpus();
  if (drift) {
    say(`ABORT: ${drift}`);
    clearTimeout(watchdog);
    return finish(1);
  }

  if (!BrowserWindow.getAllWindows().length) {
    say("ABORT: no window at ready - another instance is probably holding the single-instance lock");
    clearTimeout(watchdog);
    return finish(1);
  }
  const win = BrowserWindow.getAllWindows()[0];
  const exec = (c) => win.webContents.executeJavaScript(c, true);
  if (win.webContents.isLoading()) {
    await new Promise((r) => win.webContents.once("did-finish-load", r));
  }

  // A BENCHMARK MUST NOT DEPEND ON WHICH WINDOW HAS FOCUS. Chromium throttles
  // timers and can stop requestAnimationFrame outright for an occluded or
  // backgrounded window, which both distorts every measurement and - because
  // the settle loops below tick on rAF - can stall them indefinitely. That is
  // not hypothetical: a run of this file hung until its 900s watchdog with no
  // output, purely because the console window had focus. Precedent in this
  // project is the same shape (capturePage returning a stale frame when the
  // window was not foreground), and so is the remedy.
  win.webContents.setBackgroundThrottling(false);
  win.showInactive();
  win.moveTop();

  // Window geometry changes how much work applyTableBreakout does, so a run at
  // an unrecorded size is not comparable with one at another size. Pin it, then
  // RECORD what was actually achieved rather than what was requested - main.js
  // persists bounds on resize, and a request swallowed by a maximized window
  // would otherwise be indistinguishable from a settled one.
  if (win.isMaximized()) win.unmaximize();
  win.setBounds({ x: 40, y: 40, width: 2000, height: 1100 });
  let inner = "";
  for (let i = 0; i < 80; i++) {
    await sleep(50);
    const now = await exec("window.innerWidth + 'x' + window.innerHeight");
    if (now === inner) break;
    inner = now;
  }

  const versions = process.versions;
  // Fail loud and immediately if the window did not actually load the app.
  // main.js resolves index.html against app.getAppPath(), so launching this
  // file directly rather than through the root bench.js entry leaves a blank
  // window in which every renderer symbol is undefined. Without this check the
  // symptom is 900 seconds of watchdog followed by an unhandled rejection that
  // names renderMarkdown rather than the real cause.
  const ready = await exec(
    "typeof renderMarkdown === 'function' && !!document.getElementById('viewer')",
  );
  if (!ready) {
    say("ABORT: the renderer did not load the application.");
    say("  Run `npm run bench` (or `electron bench.js`) from the repo root, not `electron bench/run.js`.");
    clearTimeout(watchdog);
    return finish(1);
  }

  // The gc switch is verified in the RENDERER, which is the process whose heap
  // is being reset - appendSwitch is applied in the main process and its
  // propagation to renderers is a behaviour, not a guarantee. Fail loud: an
  // absent gc restores the measured 10x marked.parse swing and there is no
  // other symptom, so a silently unexposed gc would corrupt every later run
  // while the table went on looking reasonable.
  const gcReady = await exec("typeof window.gc === 'function'");
  if (!gcReady) {
    say("ABORT: window.gc is not exposed in the renderer, so the heap cannot be");
    say("  reset between repetitions. Without it marked.parse alone was measured");
    say("  swinging 181ms to 1932ms on identical input. Check that");
    say("  app.commandLine.appendSwitch('js-flags', '--expose-gc') still reaches");
    say("  the renderer process on this Electron version.");
    clearTimeout(watchdog);
    return finish(1);
  }

  const SETTLE_CAP_MS = 30000;
  // See the viewport invariant below: this is a floor, not the requested size.
  const MIN_VIEWPORT_WIDTH = 1280;
  const innerWidth = Number(String(inner).split("x")[0]) || 0;
  // THE MEASUREMENT REGIME. Every number below changes what a millisecond in
  // BASELINE.md MEANS, without changing a single thing an output oracle can
  // see: the corpus digest still matches, the render and class censuses still
  // match, and the table still prints. Both reviewers named this independently
  // as the dimension nothing covered.
  //
  // PINNED AS INVARIANTS, NOT AS VALUES - that is the whole design. Asserting
  // `reps === 3` would have to be re-derived by hand every time someone
  // legitimately raised it, and a pin that is routinely re-derived stops being
  // read. Each assertion below instead states the PROPERTY the value has to
  // have, so a legitimate re-tune passes silently and an accidental or
  // adversarial un-tune fails by name.
  //
  // The quiet window is the one that matters most and it is DERIVED, not
  // compared against a literal. The product defers highlighting with
  // `requestIdleCallback(cb, { timeout: N })`, so N is the longest the document
  // can be genuinely silent while still not being finished. An earlier version
  // of this harness waited ~80ms and reported dense@1MB at 38,740 nodes where
  // its siblings scaled to ~57,000 - it had measured a half-built document and
  // printed a plausible number for it. Reading the deadline out of renderer.js
  // means that if the product's deadline is ever raised, this fails and says
  // so, instead of silently going back to measuring half a document.
  const WARMUP_REPS = 2;
  const QUIET_MS = 1500;
  const idleDeadlineMs = (() => {
    const src = fs.readFileSync(path.join(__dirname, "..", "renderer.js"), "utf8");
    const m = src.match(/requestIdleCallback\([^)]*\{\s*timeout:\s*(\d+)\s*\}/);
    if (!m) {
      // A REGEX THAT STOPS MATCHING MUST REFUSE, NOT DEFAULT. Falling back to a
      // literal here would silently restore the magic number this exists to
      // remove, and the check would go on passing while checking nothing.
      say("ABORT: could not read the product's requestIdleCallback deadline out of");
      say("  renderer.js, so the settle window cannot be shown to exceed it. If the");
      say("  product no longer defers work that way, this check needs rewriting, not");
      say("  deleting - the settle window has to outlast whatever replaced it.");
      return null;
    }
    return Number(m[1]);
  })();
  if (idleDeadlineMs === null) return finish(3);

  const regimeFailures = [];
  const regimeRequire = (ok, what) => {
    if (!ok) regimeFailures.push(what);
  };
  regimeRequire(
    QUIET_MS > idleDeadlineMs,
    `the settle window (${QUIET_MS}ms) must outlast the product's own deferred-work ` +
      `deadline (${idleDeadlineMs}ms), or a document is called settled while it is still being built`,
  );
  regimeRequire(
    SETTLE_CAP_MS > QUIET_MS * 2,
    `the settle cap (${SETTLE_CAP_MS}ms) must leave room for the quiet window ` +
      `(${QUIET_MS}ms), or every cell is capped before it can ever be observed quiet`,
  );
  regimeRequire(
    WARMUP_REPS >= 2,
    `the warm-up must run at least twice (got ${WARMUP_REPS}): the SECOND repetition ` +
      "was the worst one measured, which is what rules out plain JIT warm-up and " +
      "identified V8 heap growth as the real cost",
  );
  regimeRequire(
    reps >= 3,
    `a median needs at least 3 samples (got ${reps}); one sample reported prose as ` +
      "twice the data in two thirds of the time",
  );
  // THE VIEWPORT IS PART OF THE REGIME NOW, AND ONLY BECAME SO WHEN THE CORPUS
  // GAINED A TABLE THAT BREAKS OUT OF THE READING COLUMN. Before the `wide`
  // profile every pinned class was a property of the document alone, so the
  // window size was worth recording but nothing depended on it. It is not
  // decorative any more: applyTableBreakout adds `wrap-anyway` when a table's
  // preferred width exceeds the space actually AVAILABLE, so on a narrow enough
  // window the class census would gain a class the corpus did not put there and
  // every wide cell would be refused for a reason that is about the screen.
  //
  // The floor is derived from measurement, not chosen. The wide table's
  // preferred width is 974px at a 1988px, a 1588px and a 1268px viewport - it
  // is a property of the content - and `available` is the inner width less
  // roughly 48px of chrome. wrap-anyway therefore appears somewhere below an
  // inner width of ~1022px. 1280 is the smallest widely-used desktop width and
  // leaves ~258px of margin, which is what makes the exact class pin safe to
  // assert rather than merely likely to hold.
  regimeRequire(
    innerWidth >= MIN_VIEWPORT_WIDTH,
    `the window is ${innerWidth}px wide and the class census needs at least ` +
      `${MIN_VIEWPORT_WIDTH}px: below roughly 1022px the wide profile's tables gain a ` +
      "`wrap-anyway` class, which is a fact about this screen rather than about the " +
      "corpus. main.js persists window bounds, so a previous run left at a small size " +
      "can cause this - the request is 2000px wide",
  );

  // The effective regime, recorded in the artifact. Codex's framing, and it is
  // the same argument as the unverified-sizes marker: bench-results.txt is what
  // gets quoted weeks later, and two runs with different regimes must not look
  // comparable just because both say STATUS: OK.
  const REGIME = {
    reps,
    warmup: `${WARMUP_REPS}x dense@${Math.round(Math.max(...sizes) / 1024)}KB`,
    quietMs: QUIET_MS,
    idleDeadlineMs,
    settleCapMs: SETTLE_CAP_MS,
    gc: typeof global.gc === "function" || "renderer-only",
    backgroundThrottling: false,
  };

  say("Folia render benchmark");
  say("");
  say("machine fingerprint (numbers are only comparable within one fingerprint)");
  say(`  cpu        ${(os.cpus()[0] || {}).model || "unknown"} x${os.cpus().length}`);
  say(`  memory     ${Math.round(os.totalmem() / 1024 / 1024 / 1024)} GB`);
  say(`  platform   ${process.platform} ${process.arch} ${os.release()}`);
  say(`  electron   ${versions.electron}  chrome ${versions.chrome}  node ${versions.node}`);
  say(`  viewport   ${inner}`);
  say(`  marked     ${await exec("(window.marked && (window.marked.parse || window.marked.lexer)) ? (window.marked.version || 'loaded, version not exposed') : 'ABSENT'")}`);
  say(`  corpus     manifest verified (${PROFILES.length} profiles)`);
  // The thresholds belong WITH the machine fingerprint, not only in the legend
  // under the table: they are part of the standard the numbers were judged by,
  // and a result relaxed with --spread-limit must not be comparable-looking
  // against one that was not.
  say(`  spread     reject > ${(spreadLimit * 100).toFixed(0)}% AND > ${spreadFloorMs}ms`);
  // THE REGIME BELONGS WITH THE MACHINE, for the same reason the thresholds do.
  // Every dial here changes what a millisecond MEANS while leaving every output
  // oracle satisfied, so two runs with different regimes must not look
  // comparable merely because both printed STATUS: OK.
  say(
    `  regime     ${REGIME.reps} reps, warm-up ${REGIME.warmup}, quiet ${REGIME.quietMs}ms ` +
      `(product defers ${REGIME.idleDeadlineMs}ms), cap ${REGIME.settleCapMs}ms, ` +
      `gc ${REGIME.gc === true ? "exposed" : REGIME.gc}, throttling off`,
  );
  say(`  when       ${new Date().toISOString()}`);
  say("");

  // A REGIME THAT VIOLATES ITS OWN INVARIANTS INVALIDATES EVERY NUMBER BELOW
  // IT, so this refuses rather than warns - and it refuses HERE, before a
  // single cell is measured, because nine minutes of timings produced under a
  // broken regime are nine minutes of numbers nobody may quote.
  if (regimeFailures.length) {
    say("");
    for (const f of regimeFailures) say(`REJECTED: ${f}`);
    say("");
    say("  These are invariants of the measurement, not preferences. Each states a");
    say("  property the dial must have rather than the value it must hold, so a");
    say("  legitimate re-tune passes silently and only an un-tune reaches here.");
    clearTimeout(watchdog);
    return finish(3);
  }

  // The pipeline is timed from INSIDE the renderer. executeJavaScript queues on
  // the renderer's main thread, so timing the round trip from here would fold
  // IPC scheduling into every measurement - and during the quadratic-hunting
  // work the main thread was so wedged that only 2 polls got through a 187s
  // render, which is exactly the regime a benchmark has to survive.
  //
  // renderer.js is a classic <script>, so its top-level declarations are
  // properties of window and reassigning window.X really does change what the
  // internal call sites resolve to. That is what allows the sub-phases to be
  // timed with NO edits to product code - the same technique that attributed
  // 79% of a 1 MB render to applyTableBreakout.
  await exec(`
    window.__bench = { phases: {} };
    window.__benchUnwrappable = [];
    (function () {
      const wrap = (name) => {
        const original = window[name];
        if (typeof original === 'function' && original.__benchWrapped) return;
        // FAIL LOUD RATHER THAN SILENTLY SKIP. A name that is not a window
        // property simply never gets a phase key, and a phase that was never
        // measured is indistinguishable in the output from a phase that cost
        // nothing. That is not hypothetical: 'parseEmojis' sat in this list
        // reporting nothing at all, because renderer.js:13 imports it with a
        // destructured require() from ./emoji-parser - a module binding, not a
        // window property - so the wrap had been a no-op from the day it was
        // written. (No backticks anywhere in this injected script: they end the
        // template literal that carries it, which has cost this project a
        // debugging cycle more than once.)
        if (typeof original !== 'function') {
          window.__benchUnwrappable.push(name);
          return;
        }
        const wrapped = function (...args) {
          const t0 = performance.now();
          try { return original.apply(this, args); }
          finally { window.__bench.phases[name] = (window.__bench.phases[name] || 0) + (performance.now() - t0); }
        };
        wrapped.__benchWrapped = true;
        window[name] = wrapped;
      };
      // Only names that are top-level \`function\` declarations in renderer.js
      // can appear here; anything imported with require() must be measured at
      // its call site instead. highlightNewElements is included because it is
      // the Prism phase, and Prism is what makes the code profile settle at
      // four times its render time - the single largest deferred cost in the
      // pipeline was previously folded into "unaccounted".
      const NAMES = ['patchViewerDOM', 'applyTableBreakout', 'assignHeadingIds', 'makeHeadersCollapsible',
       'sanitizeHtml', 'addTableMaximizeButtons', 'initImageZoom',
       'applyNoteStyles', 'applyRawHtmlDocuments', 'highlightNewElements'];
      // A duplicate in that list is not harmless: the second wrap() call sees
      // __benchWrapped and returns silently, so a typo would remove a phase
      // while looking like it added one.
      if (new Set(NAMES).size !== NAMES.length) {
        window.__benchUnwrappable.push('DUPLICATE NAME IN WRAP LIST');
      }
      NAMES.forEach(wrap);
      window.__benchWrapNames = NAMES.slice();
      // marked.parse is a METHOD, not a top-level declaration, so the wrap
      // helper above cannot reach it - and on a table-heavy document the lexer
      // is exactly the phase most likely to dominate what the named passes
      // leave unaccounted for.
      if (window.marked && typeof window.marked.parse === 'function' && !window.marked.parse.__benchWrapped) {
        const originalParse = window.marked.parse.bind(window.marked);
        const wrappedParse = function (...args) {
          const t0 = performance.now();
          try { return originalParse(...args); }
          finally { window.__bench.phases['marked.parse'] = (window.__bench.phases['marked.parse'] || 0) + (performance.now() - t0); }
        };
        wrappedParse.__benchWrapped = true;
        window.marked.parse = wrappedParse;
      } else if (!window.marked || typeof window.marked.parse !== 'function') {
        window.__benchUnwrappable.push('marked.parse');
      }
      window.__benchWrapNames.push('marked.parse');
    })();
    null
  `);
  const unwrappable = await exec("window.__benchUnwrappable.join(', ')");
  if (unwrappable) {
    say(`ABORT: these phases could not be instrumented: ${unwrappable}`);
    say("  An uninstrumented phase reports nothing, which reads identically to a phase");
    say("  that costs nothing. Either the function was renamed, or it stopped being a");
    say("  top-level declaration in renderer.js and must be measured another way.");
    clearTimeout(watchdog);
    return finish(1);
  }

  // EVERY MEASUREMENT STARTS FROM AN EMPTY VIEWER, and this is not tidiness.
  // The first run of this benchmark billed each profile's smallest document
  // with the cost of tearing down the PREVIOUS profile's 1 MB document, which
  // inflated the first row of every profile and made its ratio meaningless -
  // measuring inherited state, the same defect this project has already fixed
  // three times (window bounds, splitter ratio, a relative <img src>).
  //
  // Empty is also the honest baseline rather than merely a convenient one: it
  // is the state a freshly opened file renders into, and it is the only
  // starting state that is identical for every profile, every size and every
  // repetition. The reset is performed OUTSIDE the timed region.
  // A tick that CANNOT stall. Waiting on requestAnimationFrame alone means the
  // loop's own deadline check never runs when rAF stops, so a throttled window
  // turns a bounded wait into an unbounded one. Racing it against a timer keeps
  // the loop ticking so the deadline can always fire; rAF still wins whenever
  // it is healthy, which is what keeps the settle point frame-accurate.
  const TICK = `() => Promise.race([
    new Promise((r) => requestAnimationFrame(r)),
    new Promise((r) => setTimeout(r, 50)),
  ])`;

  // THE SETTLE LOOP, WRITTEN ONCE. This is the only measurement in the harness
  // that no oracle over the finished document can check: "settle" is a claim
  // about WHEN the document stopped changing, and a finished document looks
  // identical whether the loop watched it properly or gave up early. It is
  // therefore covered by a positive control below - and the control is only
  // worth anything if it exercises THIS loop.
  //
  // An earlier version of that control carried its own copy of these lines. It
  // would have proven that a correct loop works, which is not the question, and
  // it is precisely the fallacy this directory has now hit twice (a test that
  // judged a formula with a copy of that formula; an axis that hashed with its
  // subject's own hash). One source, two callers.
  //
  // Contract for callers: `lastMutationAt`, `seen`, `settled`, `capped` and
  // `t0` must already exist, and QUIET_MS must be in scope.
  const SETTLE_LOOP = `
        const tick = ${TICK};
        let quietSince = performance.now();
        while (!settled) {
          await tick();
          if (lastMutationAt !== seen) {
            seen = lastMutationAt;
            quietSince = performance.now();
          } else if (performance.now() - quietSince >= QUIET_MS) {
            settled = true;
          }
          if (performance.now() - t0 > ${SETTLE_CAP_MS}) { capped = true; break; }
        }`;

  const reset = async () => {
    // The reset is VERIFIED, not assumed, and it WAITS FOR QUIET rather than
    // sleeping a fixed interval. Two distinct hazards make both halves
    // necessary:
    //
    //   * A reset that quietly fails to clear the viewer leaves every later
    //     measurement diffing against an inherited document - the exact defect
    //     this reset exists to remove, reintroduced in a form that still prints
    //     plausible numbers.
    //   * Tearing down a large document schedules deferred work of its own. The
    //     ResizeObserver on .content-wrapper debounces applyTableBreakout by
    //     120ms, so a fixed sleep can hand the NEXT render a pending callback
    //     that fires in the middle of its timed region. That is the most likely
    //     source of the 185% run-to-run spread seen on tables@1MB before this
    //     was added.
    const remaining = await exec(`
      (async () => {
        const viewer = document.getElementById('viewer');
        if (!viewer) return -1;
        let lastMutationAt = performance.now();
        const observer = new MutationObserver(() => { lastMutationAt = performance.now(); });
        observer.observe(viewer, { childList: true, subtree: true, attributes: true, characterData: true });
        await renderMarkdown('');
        const tick = ${TICK};
        const deadline = performance.now() + 6000;
        // 600ms, and it does NOT need to exceed the product's 1000ms
        // requestIdleCallback deadline the way the measurement's QUIET_MS does.
        // The relationship is what makes that safe rather than lucky: every
        // measurement already waits 1500ms of quiet - longer than that deadline
        // - and is followed by a 300ms settle sleep, so any deferred work
        // belonging to the PREVIOUS document has necessarily run before the
        // reset begins. What this window has to cover is only the empty
        // render's own teardown, including the 120ms debounced applyTableBreakout
        // that the ResizeObserver on .content-wrapper schedules.
        while (performance.now() - lastMutationAt < 600 && performance.now() < deadline) {
          await tick();
        }
        observer.disconnect();
        // Collect the previous document before the next one is timed. Awaiting
        // a macrotask after the collection lets any finalisation settle, so the
        // pause lands here rather than inside the measured render.
        if (typeof window.gc === 'function') { window.gc(); await new Promise((r) => setTimeout(r, 50)); window.gc(); }
        return viewer.children.length;
      })()
    `);
    if (remaining !== 0) {
      throw new Error(`reset left ${remaining} block(s) in the viewer`);
    }
  };

  // TWO NUMBERS ARE REPORTED PER CELL, AND THE DIFFERENCE BETWEEN THEM IS THE
  // POINT. `renderMarkdown` resolving does NOT mean the document is finished:
  // syntax highlighting is deliberately deferred behind
  // requestIdleCallback(..., { timeout: 1000 }) at renderer.js:4488 so the text
  // becomes readable before the colours arrive.
  //
  // Measured on the code profile at 256 KB: the promise resolved with 4,866
  // nodes in the viewer, and 100 ms later there were 65,691 - 43,794 Prism
  // token spans. A benchmark that stopped at the promise was therefore blind to
  // the single largest phase of a code-heavy document, and would have reported
  // a 10x highlighting regression as no change at all.
  //
  //   render ms = to the promise resolving - time to readable content.
  //   settle ms = to the last DOM mutation - total work the machine does.
  //
  // Settling is observed with a MutationObserver rather than by polling a node
  // count: a mutation that replaces a node, or edits an attribute or text node,
  // leaves the count identical, so a count-based poll would declare a document
  // settled while it was still changing. The timestamp taken is that of the
  // LAST mutation, not of the frame that noticed the quiet, so the quiet-frame
  // window adds nothing to the reported figure.
  // ONE SOURCE OF TRUTH FOR THE CAP. It was 30000 in the loop while the legend
  // printed "20s", so a capped figure would have been described to the reader
  // as a floor at the wrong number. Both now read this constant.


  // The point past which a cell's repetitions disagree so much that the median
  // describes machine load rather than the code under test.
  //
  // BOTH a relative AND an absolute test, because neither alone discriminates.
  // Relative alone rejects prose@512KB - a 163ms cell whose 20% is 33ms of
  // ordinary scheduler jitter - while the run that genuinely was contaminated
  // showed 1268ms and 793ms on the 1MB cells. Absolute alone rejects four cells
  // of a perfectly clean run: tables@512 (58ms), tables@1024 (115ms),
  // code@1024 (110ms) and lists@1024 (56ms), because a few percent of a 2.9s
  // cell is tens of milliseconds. Both halves were measured independently.
  //
  // Neither number is a preference. Across every clean run measured here the
  // absolute spread of the small cells topped out at 33ms and no cell exceeded
  // 11% relative; the contaminated run produced 40%/1268ms and 23%/793ms. The
  // two populations do not overlap on either axis, so any cut inside those gaps
  // is equivalent. A cell that passes both tests can still be a few percent
  // out - which is fine, because the question a ratio has to answer is 2.0
  // versus 4.0, not 2.0 versus 2.1.
  //
  // TWO KNOWN LIMITS, both stated rather than papered over:
  //   * The gaps above were measured on ONE machine. A slower or more contended
  //     one has a higher noise floor, which is why --spread-limit and
  //     --spread-floor-ms exist and why the effective values are printed with
  //     the results.
  //   * The statistic is max-min, which can only grow as repetitions are added,
  //     so raising --reps well above the default 3 makes the test stricter.
  //     That is the intended direction: the question this guard asks is whether
  //     ANY repetition disagreed, and a run in which one did is one where the
  //     machine was busy at some point - which says nothing good about the
  //     cells measured either side of it.
  const untrustworthy = (r) =>
    r.settle > 0 && r.spread / r.settle > spreadLimit && r.spread > spreadFloorMs;

  const measureOnce = async (payload) =>
    exec(`
      (async () => {
        const md = ${payload};
        const viewer = document.getElementById('viewer');
        window.__bench.phases = {};
        let lastMutationAt = 0;
        const observer = new MutationObserver(() => { lastMutationAt = performance.now(); });
        observer.observe(viewer, { childList: true, subtree: true, attributes: true, characterData: true });
        // DELIBERATELY NOT setting window.originalMarkdown. An earlier version
        // did, with a comment claiming it kept the document store coherent with
        // the viewer. That comment was wrong: renderer.js:1056 declares
        // originalMarkdown with a top-level let, which is a LEXICAL binding, so
        // the 81 references to it in renderer.js never read a window property -
        // and window.originalMarkdown appears nowhere in renderer.js at all.
        // The write therefore only ever created a stray property nothing read,
        // which is worse than doing nothing because the comment beside it told
        // the next reader the store was being kept in step. Removing it was
        // verified to leave every measured figure unchanged.
        const t0 = performance.now();
        await renderMarkdown(md);
        const renderMs = performance.now() - t0;

        let settled = false;
        let capped = false;
        let seen = lastMutationAt;
        // THE QUIET WINDOW IS DERIVED FROM THE PRODUCT, NOT PICKED. Syntax
        // highlighting is scheduled with requestIdleCallback(..., { timeout:
        // 1000 }) at renderer.js:4488, so after the render finishes there can
        // be a full second of genuine silence before the deferred work even
        // begins. An earlier version here waited 5 animation frames (~80ms) and
        // declared the document settled inside that gap: dense@1MB reported
        // 38,740 nodes where its 256KB and 512KB siblings scaled to ~57,000 -
        // it had measured a document that was still being built, and printed a
        // plausible number for it. The window must exceed the deadline the
        // product itself guarantees, so it is tied to that deadline.
        const QUIET_MS = ${QUIET_MS};
        ${SETTLE_LOOP}
        observer.disconnect();

        return {
          renderMs,
          // Falls back to renderMs when nothing mutated at all, so an empty
          // render reports a coherent pair rather than a negative settle time.
          settleMs: lastMutationAt ? lastMutationAt - t0 : renderMs,
          capped,
          phases: window.__bench.phases,
          blocks: viewer.children.length,
          nodes: viewer.querySelectorAll('*').length,
          tokens: viewer.querySelectorAll('.token').length,
          // A COUNT OF NODES CANNOT SEE A CHANGE THAT MOVES NO NODES. Both
          // reviewers reached this independently: short-circuiting a pass that
          // only sets classes - applyTableBreakout(), markShortColumns() - adds
          // and removes nothing, so blocks/nodes/tokens are all unmoved and the
          // row prints clean. The histogram is over class TOKENS rather than
          // over innerHTML because a hash of the markup moves on every
          // unrelated change and would have to be re-pinned constantly, while
          // a class name is exactly the unit those passes operate in.
          classes: (() => {
            const h = Object.create(null);
            viewer.querySelectorAll('[class]').forEach((el) => {
              const raw = el.getAttribute('class');
              if (!raw) return;
              for (const c of raw.split(/\\s+/)) if (c) h[c] = (h[c] || 0) + 1;
            });
            return h;
          })(),
        };
      })()
    `);

  // DISCARDED WARM-UP, AT THE WORKING-SET SIZE. The first render in a process
  // pays for JIT, lazy Prism initialisation and first-touch allocation. It also
  // pays something larger and less obvious: V8 starts with a small heap and
  // GROWS it towards the working set, and growth means repeated major
  // collections and compaction.
  //
  // That was measured, not assumed. With the gc reset in place but a 128 KB
  // warm-up, tables@1MB still reported marked.parse at 2443ms and then 3780ms
  // for its first two repetitions before dropping to 205/210/211/214 - and the
  // SECOND repetition being the worst is what rules out plain JIT warm-up,
  // which can only get better. The warm-up therefore renders at the largest
  // size this run will actually measure, twice, so the heap has already grown
  // to the working set before any figure is recorded.
  //
  // `dense` is the warm-up profile because it is the only one containing every
  // construct - headings, paragraphs, lists, tables and code - so a single
  // warm-up exercises every path the measured profiles will take.
  try {
    const warmSize = Math.max(...sizes);
    for (let i = 0; i < WARMUP_REPS; i++) {
      where = `warm-up ${i + 1}/${WARMUP_REPS} at ${Math.round(warmSize / 1024)}KB`;
      await reset();
      await measureOnce(JSON.stringify(generate("dense", warmSize)));
    }
  } catch (e) {
    say(`ABORT: warm-up render failed: ${String((e && e.message) || e)}`);
    clearTimeout(watchdog);
    return finish(1);
  }

  // THE SETTLE LOOP IS THE ONE MEASUREMENT NOTHING ELSE CAN CHECK. Every other
  // number here is verified by an oracle over the finished document, but
  // "settle" is a claim about WHEN the document stopped changing, and a
  // finished document looks identical whether the loop watched it properly or
  // gave up early. The invariant assertions above prove the quiet window
  // OUTLASTS the product's deferred-work deadline; they cannot prove the
  // observer is wired up, that mutations reach it, or that a late change
  // actually postpones the verdict.
  //
  // So this is a POSITIVE CONTROL, in the same shape this project already uses
  // for the keyboard-shortcut probe: schedule a mutation at a known delay well
  // past what a frame-counting loop would tolerate but well inside QUIET_MS,
  // and require the reported settle time to reach it. A loop that stopped at a
  // few animation frames - the exact defect that once reported dense@1MB at
  // 38,740 nodes against a true ~57,000 - reports a settle far below the delay
  // and fails here by name, BEFORE any cell is measured.
  //
  // Deliberately not a mutation of the real corpus render: this must test the
  // observation machinery, not the product, and a product that legitimately
  // stopped mutating late would otherwise make the control fail.
  const PROBE_DELAY_MS = 400;
  where = "settle-loop positive control";
  const probe = await exec(`
    (async () => {
      const viewer = document.getElementById('viewer');
      viewer.replaceChildren();
      let lastMutationAt = 0;
      const t0 = performance.now();
      const observer = new MutationObserver(() => { lastMutationAt = performance.now(); });
      observer.observe(viewer, { childList: true, subtree: true, attributes: true, characterData: true });
      const p = document.createElement('p');
      p.textContent = 'settle probe';
      viewer.appendChild(p);
      setTimeout(() => { p.textContent = 'settle probe, mutated late'; }, ${PROBE_DELAY_MS});
      const QUIET_MS = ${QUIET_MS};
      let settled = false;
      let capped = false;
      let seen = lastMutationAt;
      ${SETTLE_LOOP}
      observer.disconnect();
      viewer.replaceChildren();
      return {
        settleMs: lastMutationAt ? lastMutationAt - t0 : 0,
        elapsed: performance.now() - t0,
        capped,
      };
    })()
  `);
  // The late mutation must have been SEEN (settle reaches the delay) and must
  // have POSTPONED the verdict (the loop ran at least the delay plus a full
  // quiet window). The second half is what separates "the observer fired" from
  // "the observer fired and the loop cared".
  const controlFailure =
    probe.capped
      ? `the settle loop hit its ${SETTLE_CAP_MS}ms cap on a document containing one paragraph`
      : !(probe.settleMs >= PROBE_DELAY_MS * 0.9)
        ? `the settle loop reported ${probe.settleMs.toFixed(0)}ms for a document deliberately ` +
          `mutated at ${PROBE_DELAY_MS}ms, so it is not observing late work`
        : !(probe.elapsed >= PROBE_DELAY_MS + QUIET_MS * 0.9)
          ? `the settle loop finished after ${probe.elapsed.toFixed(0)}ms, but a mutation at ` +
            `${PROBE_DELAY_MS}ms should have held it open for at least ` +
            `${PROBE_DELAY_MS + QUIET_MS}ms - the mutation was seen but did not postpone the verdict`
          : null;
  if (controlFailure) {
    say(`ABORT: ${controlFailure}.`);
    say("  Every settle figure this run would produce describes a document that may");
    say("  still have been being built. This is the defect that once reported");
    say("  dense@1MB at 38,740 nodes against a true ~57,000.");
    clearTimeout(watchdog);
    return finish(3);
  }
  say(
    `settle-loop control: a mutation at ${PROBE_DELAY_MS}ms was observed at ` +
      `${probe.settleMs.toFixed(0)}ms and held the loop open to ${probe.elapsed.toFixed(0)}ms`,
  );
  say("");

  // WRAPPED IS A WEAKER CLAIM THAN CALLED, so check the stronger one now that a
  // full dense render has actually happened. The abort above only proves the
  // name resolved to a function at wrap time. If a future refactor extracts the
  // real work into a private helper and leaves the old global alive but unused,
  // the wrap still installs, the abort still passes, and the phase reports a
  // flat 0 ms - which reads in the table exactly like a phase that is free.
  // That is the same silent-zero that hid parseEmojis, arrived at by a
  // different route, so it is closed at the other end: every wrapped name must
  // have been observed at least once during the warm-up.
  //
  // The warm-up is the right place to assert it: it renders `dense`, the only
  // profile containing every construct, so every phase has had its opportunity.
  const fired = await exec(
    "JSON.stringify(window.__benchWrapNames.filter(n => !(n in window.__bench.phases)))",
  );
  const silent = JSON.parse(fired || "[]");
  if (silent.length) {
    say(`ABORT: these phases wrapped cleanly but never ran: ${silent.join(", ")}`);
    say("  A phase that is instrumented but never called reports 0ms, which reads in");
    say("  the table exactly like a phase that costs nothing. Either the render path no");
    say("  longer calls it, or the work moved to a helper the wrap cannot see.");
    clearTimeout(watchdog);
    return finish(1);
  }

  const rows = [];
  for (const profile of profiles) {
    if (!PROFILES.includes(profile)) {
      say(`skipping unknown profile: ${profile}`);
      continue;
    }
    for (const size of sizes) {
      const text = generate(profile, size);
      // JSON.stringify rather than a template literal: the corpus contains
      // backticks (fenced code) and ${, either of which would otherwise be
      // interpreted by the injected script rather than measured by it.
      const payload = JSON.stringify(text);
      const samples = [];
      let failed = false;
      for (let r = 0; r < reps; r++) {
        try {
          where = `${profile}@${Math.round(size / 1024)}KB rep ${r + 1}/${reps}: reset`;
          await reset();
          where = `${profile}@${Math.round(size / 1024)}KB rep ${r + 1}/${reps}: render`;
          samples.push(await measureOnce(payload));
        } catch (e) {
          // A render that throws must be reported as a named row rather than
          // taken to the watchdog: an unhandled rejection here reads as "the
          // benchmark hung", which points the next reader at timing rather
          // than at the exception that actually happened.
          say(`ERROR  ${profile}@${Math.round(size / 1024)}KB: ${String((e && e.message) || e)}`);
          failed = true;
          break;
        }
        // Let the renderer settle so a deferred layout from one document is
        // not billed to the next.
        await sleep(300);
      }
      if (failed) continue;
      if (arg("dump", "") === "1") {
        // Raw per-repetition numbers. A spread figure names the size of a
        // disagreement but not its shape: one slow outlier and a bimodal
        // split read identically, and they have different causes.
        for (const s of samples) {
          say(
            `  raw ${profile}@${Math.round(size / 1024)}KB  render=${s.renderMs}  settle=${s.settleMs}` +
              `  nodes=${s.nodes}  ${Object.entries(s.phases || {})
                .map(([k, v]) => `${k}=${v}`)
                .join(" ")}`,
          );
        }
      }
      // ONE REPRESENTATIVE SAMPLE, NOT A COLUMN-WISE MEDIAN. Taking the median
      // of each column independently can pair a render time from one run with
      // a settle time from another, and those two can then disagree with each
      // other - a cell reporting settle < render is arithmetically possible and
      // physically meaningless. Choosing the sample whose settle time is the
      // median keeps every figure in the row describing the same render.
      const ordered = [...samples].sort((a, b) => a.settleMs - b.settleMs);
      const rep = ordered[Math.floor((ordered.length - 1) / 2)];
      const settles = samples.map((s) => s.settleMs);
      const nodeCounts = samples.map((s) => s.nodes);
      rows.push({
        profile,
        // The REQUESTED size, which is the key the census and the corpus digest
        // are both pinned by. Deliberately not the generated byte count:
        // generate() only checks its target between whole builder iterations,
        // so it overshoots by a profile-dependent amount (prose@256KB really
        // emits 262,464 bytes). Keying on the overshoot would make the pin move
        // whenever a builder's per-iteration size changed, which is a fact the
        // manifest already pins, and would stop the keys matching
        // BENCH_DEFAULT_SIZES - so "is every benchmarked size pinned?" would
        // stop being answerable.
        size,
        kb: Buffer.byteLength(text, "utf8") / 1024,
        total: rep.renderMs,
        settle: rep.settleMs,
        spread: Math.max(...settles) - Math.min(...settles),
        capped: samples.some((s) => s.capped),
        // If the repetitions did not agree on how big the finished document
        // was, they were not all measuring the same document, and the timing is
        // not comparable with anything. Reported rather than silently averaged.
        nodesAgree:
          Math.max(...nodeCounts) - Math.min(...nodeCounts) <=
          Math.max(...nodeCounts) * sameDocumentTolerance,
        phases: rep.phases,
        nodes: rep.nodes,
        tokens: rep.tokens,
        blocks: rep.blocks,
        classes: rep.classes,
        allClasses: samples.map((s) => s.classes),
      });
    }
  }

  // --- report --------------------------------------------------------------
  const width = { p: 9, kb: 7, ms: 9, st: 9, sp: 8, r: 7 };
  say(`median of ${reps} run(s) per cell, each from an empty viewer`);
  say(
    `rejecting any cell whose spread exceeds ${(spreadLimit * 100).toFixed(0)}% AND ${spreadFloorMs}ms`,
  );
  say("");
  say(
    "profile".padEnd(width.p) +
      "KB".padStart(width.kb) +
      "render".padStart(width.ms) +
      "settle".padStart(width.st) +
      "spread".padStart(width.sp) +
      "ratio".padStart(width.r) +
      "nodes".padStart(9) +
      "nd/KB".padStart(7) +
      "  breakout/patch ms",
  );
  say("-".repeat(92));
  let prev = null;
  for (const r of rows) {
    const same = prev && prev.profile === r.profile;
    // The ratio is taken on SETTLE, not render: settle is the one that accounts
    // for all the work, so it is the one whose growth curve describes the
    // algorithm rather than describing where a yield point happens to be.
    const ratio = same ? (r.settle / prev.settle).toFixed(2) : "-";
    const breakout = (r.phases.applyTableBreakout || 0).toFixed(0);
    const patch = (r.phases.patchViewerDOM || 0).toFixed(0);
    say(
      r.profile.padEnd(width.p) +
        r.kb.toFixed(0).padStart(width.kb) +
        r.total.toFixed(0).padStart(width.ms) +
        (r.settle.toFixed(0) + (r.capped ? "!" : "")).padStart(width.st) +
        // Spread as a percentage of the median. A ratio close to 2.0 means
        // nothing if the spread is 40% - this column is what says whether the
        // ratio beside it is worth reading at all.
        (r.settle
          ? ((r.spread / r.settle) * 100).toFixed(0) + "%" + (untrustworthy(r) ? "?" : "")
          : "-"
        ).padStart(width.sp) +
        String(ratio).padStart(width.r) +
        String(r.nodes).padStart(9) +
        (r.nodes / r.kb).toFixed(1).padStart(6) +
        (r.nodesAgree ? " " : "~") +
        `  ${breakout} / ${patch}`,
    );
    prev = r;
  }
  say("");
  say("render = time until renderMarkdown() resolves: time to READABLE content.");
  say("settle = time until the last DOM mutation: TOTAL work, including the syntax");
  say("         highlighting that renderer.js defers behind requestIdleCallback.");
  say(`         A \`!\` means the ${SETTLE_CAP_MS / 1000}s settle cap was hit and the figure is a floor.`);
  say("ratio  = this size's settle / the previous size's settle, same profile.");
  say("         Each size doubles, so ~2.0 is linear and ~4.0 is quadratic. This is");
  say("         the figure that survives a change of machine; the ms do not.");
  say("spread = (max - min) / median across the repetitions. A ratio is only as");
  say("         trustworthy as the spread of the two cells it was computed from.");
  say(`         A trailing \`?\` means the spread exceeded ${(spreadLimit * 100).toFixed(0)}% AND ${spreadFloorMs}ms and the`);
  say("         run is REJECTED: those numbers describe the machine, not the code.");
  say("nd/KB  = DOM nodes per KB of markdown - the shape factor that made one");
  say("         removal defect measure 23.7s on a dense document and 571ms on prose.");
  say("         A trailing `~` means the repetitions disagreed on the finished node");
  say("         count by more than 2%, i.e. they were not measuring one document and");
  say("         the timing beside it should not be trusted.");

  clearTimeout(watchdog);

  // FAIL LOUD ON A CONTAMINATED RUN, rather than printing it and letting a
  // human decide whether to believe it. This is not hypothetical: one full run
  // during development reported tables@1MB at 40% and code@1MB at 23% spread
  // while the very same cell, re-measured in isolation minutes later, came back
  // at 1.3%. Nothing in the code had changed - the machine was busy. Those two
  // runs are indistinguishable in the output, so a quiet 40% is an invitation
  // to record background load as a performance result and then chase it. The
  // numbers above are still printed in full; what a nonzero exit denies is
  // treating them as comparable to BASELINE.md.
  const bad = rows.filter(untrustworthy);
  if (bad.length) {
    say("");
    say(`REJECTED: ${bad.length} cell(s) exceeded the ${(spreadLimit * 100).toFixed(0)}% / ${spreadFloorMs}ms spread limit:`);
    for (const r of bad) {
      say(
        `  ${r.profile}@${r.kb.toFixed(0)}KB  spread ${((r.spread / r.settle) * 100).toFixed(0)}% (${r.spread.toFixed(0)}ms)`,
      );
    }
    say("  Re-run on an idle machine. Do NOT compare these figures to bench/BASELINE.md.");
    return finish(3);
  }

  // A FASTER NUMBER FOR A SMALLER DOCUMENT IS NOT A FASTER RENDER.
  //
  // Every oracle in verify.js pins the corpus - the INPUT. Nothing pinned what
  // the application actually built out of it, and the two are not the same
  // claim. MEASURED: `highlightNewElements()` was made to return immediately -
  // the shape of a plausible "optimisation" - and code@256KB went from 65,691
  // nodes / 700ms to 21,897 nodes / 370ms. That is a 1.9x speedup printed as a
  // clean row: two thirds of the DOM was missing, `nodesAgree` was TRUE because
  // all three repetitions agreed on the wrong number, and `npm run test:corpus`
  // passed 232/232 because the corpus text was untouched.
  //
  // `nodesAgree` compares the repetitions to EACH OTHER, so it cannot see a
  // change that is perfectly reproducible - which every code change is. The
  // census below compares them to a hand-pinned expectation instead.
  //
  // WHY THIS IS NOT THE CORRECTNESS SUITE'S JOB: the 12-suite chain renders its
  // own fixtures, never bench/corpus.js. A pipeline change that only shows up
  // on a 256KB machine-generated document is invisible to it. This is the only
  // oracle whose subject is the render the benchmark actually times.
  //
  // THE PIN MOVES ONLY BY HAND, and that is the contract - the same one axis 9
  // has. A legitimate render change (marked 9 -> 18 will be one) MUST re-pin
  // these numbers deliberately, because such a change also means the timings
  // are no longer comparable to the ones in BASELINE.md.
  const censusBad = [];
  const censusUnpinned = [];
  for (const r of rows) {
    const want = (RENDER_CENSUS[r.profile] || {})[r.size];
    // A MISSING PIN IS A REFUSAL, NOT A SKIP - same rule as the corpus digest.
    // A cell nobody pinned is a cell nobody checked, and silently passing it is
    // exactly how two of the three benchmarked sizes ended up verified by
    // nothing at all.
    if (!want) {
      censusUnpinned.push(r);
      continue;
    }
    for (const key of ["blocks", "nodes", "tokens"]) {
      // THE SAME CONSTANT `nodesAgree` USES, not a second one that happens to
      // hold the same value. If two repetitions differing by more than this
      // "were not measuring one document", then a repetition differing from the
      // pin by more than this is likewise not the pinned document.
      const drift = Math.abs(r[key] - want[key]);
      if (drift > Math.max(want[key], r[key]) * sameDocumentTolerance) {
        censusBad.push({ r, key, got: r[key], want: want[key] });
      }
    }
  }
  if (censusUnpinned.length || censusBad.length) {
    say("");
    for (const c of censusBad) {
      say(
        `REJECTED: ${c.r.profile}@${c.r.kb.toFixed(0)}KB rendered ${c.got} ${c.key}, pinned ${c.want}` +
          ` (${(((c.got - c.want) / c.want) * 100).toFixed(1)}%)`,
      );
    }
    for (const c of censusUnpinned) {
      say(`REJECTED: ${c.profile}@${c.kb.toFixed(0)}KB has no pinned census, so nothing checked it`);
    }
    say("");
    say("  The application built a different document out of the same pinned corpus, so");
    say("  these timings are not comparable with bench/BASELINE.md. Either a render change");
    say("  is doing less (or more) work than the baseline, or the change is intended and");
    say("  the census below must be pasted into RENDER_CENSUS in bench/run.js by hand,");
    say("  together with a fresh baseline table - the old timings no longer describe it.");
    say("");
    say("  const RENDER_CENSUS = {");
    for (const p of PROFILES) {
      const cells = rows.filter((r) => r.profile === p);
      if (!cells.length) continue;
      say(`    ${p}: {`);
      for (const r of cells) {
        say(
          `      ${r.size}: { blocks: ${r.blocks}, nodes: ${r.nodes}, tokens: ${r.tokens} },`,
        );
      }
      say("    },");
    }
    say("  };");
    return finish(4);
  }

  // --- class census ---------------------------------------------------------
  // Same refusal contract as RENDER_CENSUS above, with two deliberate
  // differences: the comparison is EXACT (see the CLASS_CENSUS comment - the
  // histogram was measured identical across every repetition, so there is no
  // jitter to absorb and a tolerance would only hide real drift), and the
  // repetitions are additionally required to agree with EACH OTHER. That second
  // check is the positive control for the first: if the reps disagreed, the
  // pin would be describing whichever rep happened to be reported, and an exact
  // pin over a jittery quantity is worse than none.
  const classSig = (h) =>
    Object.keys(h)
      .sort()
      .map((k) => `${k}=${h[k]}`)
      .join(" ");
  const classBad = [];
  const classUnstable = [];
  const classUnpinned = [];
  for (const r of rows) {
    const sigs = new Set(r.allClasses.map(classSig));
    if (sigs.size > 1) classUnstable.push({ r, sigs: [...sigs] });
    const want = (CLASS_CENSUS[r.profile] || {})[r.size];
    if (!want) {
      classUnpinned.push(r);
      continue;
    }
    const got = r.classes;
    // Reported per CLASS rather than as one "signatures differ", because the
    // whole reason this is a histogram and not a hash is that it should name
    // what moved.
    for (const name of new Set([...Object.keys(want), ...Object.keys(got)])) {
      const g = got[name] || 0;
      const w = want[name] || 0;
      if (g !== w) classBad.push({ r, name, got: g, want: w });
    }
  }
  if (classUnstable.length || classBad.length || classUnpinned.length) {
    say("");
    for (const c of classUnstable) {
      say(
        `REJECTED: ${c.r.profile}@${c.r.kb.toFixed(0)}KB repetitions disagreed on their own classes,` +
          ` so no exact pin can describe them (${c.sigs.length} distinct signatures)`,
      );
    }
    for (const c of classBad) {
      say(
        `REJECTED: ${c.r.profile}@${c.r.kb.toFixed(0)}KB rendered ${c.got} .${c.name}, pinned ${c.want}`,
      );
    }
    for (const c of classUnpinned) {
      say(
        `REJECTED: ${c.profile}@${c.kb.toFixed(0)}KB has no pinned class census, so nothing checked it`,
      );
    }
    say("");
    say("  A render pass that changes only classes moves no node, block or token count, so");
    say("  RENDER_CENSUS above cannot see it. If this is intended, paste the block below");
    say("  into CLASS_CENSUS in bench/run.js by hand.");
    say("");
    say("  const CLASS_CENSUS = {");
    for (const p of PROFILES) {
      const cells = rows.filter((r) => r.profile === p);
      if (!cells.length) continue;
      say(`    ${p}: {`);
      for (const r of cells) {
        const body = Object.keys(r.classes)
          .sort()
          .map((k) => `${JSON.stringify(k)}: ${r.classes[k]}`)
          .join(", ");
        say(`      ${r.size}: { ${body} },`);
      }
      say("    },");
    }
    say("  };");
    return finish(4);
  }

  finish(0);
});
