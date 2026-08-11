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
const { PROFILES, generate, sha256, REFERENCE_SIZES } = require("./corpus");

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
function releaseLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
  } catch (err) {
    if (err && err.code !== "ENOENT") {
      console.error(`bench: could not remove ${LOCK_PATH} (${err.code}); remove it by hand.`);
    }
  }
}
for (let attempt = 0; ; attempt++) {
  try {
    fs.writeFileSync(LOCK_PATH, String(process.pid), { flag: "wx" });
    break;
  } catch (err) {
    if (!err || err.code !== "EEXIST" || attempt >= 2) {
      console.error(
        `bench: cannot take ${LOCK_PATH} (${(err && err.code) || err}). REFUSING TO RUN.`,
      );
      process.exit(2);
    }
    let holder = 0;
    try {
      holder = Number(String(fs.readFileSync(LOCK_PATH, "utf8")).trim()) || 0;
    } catch (readErr) {
      // The holder released it between our open and our read. Retry.
      if (readErr && readErr.code === "ENOENT") continue;
      holder = 0;
    }
    if (holder && holder !== process.pid && pidAlive(holder)) {
      console.error(
        `bench: another benchmark run (pid ${holder}) is in progress. REFUSING TO RUN -\n` +
          "bench: two runs share bench-results.txt and would overwrite each other's report,\n" +
          "bench: and competing for CPU would invalidate both sets of numbers.",
      );
      process.exit(2);
    }
    console.error(
      `bench: taking over a stale lock left by pid ${holder || "unknown"}, which is no longer running.`,
    );
    releaseLock();
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

function finish(code) {
  // A MACHINE-READABLE VERDICT ON THE FIRST LINE. The REJECTED banner is prose
  // at the bottom of a 50-line report, so anything that reads the file rather
  // than the exit code - a later comparison script, a human skimming for the
  // table - cannot tell a rejected run from a good one. It can now.
  const status = code === 0 ? "STATUS: OK" : `STATUS: FAILED (exit ${code})`;
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
const sizeArg = String(arg("sizes", "262144,524288,1048576"));
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
  say(`  when       ${new Date().toISOString()}`);
  say("");

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
  const SETTLE_CAP_MS = 30000;

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
        const QUIET_MS = 1500;
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
        }
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
    for (let i = 0; i < 2; i++) {
      where = `warm-up ${i + 1}/2 at ${Math.round(warmSize / 1024)}KB`;
      await reset();
      await measureOnce(JSON.stringify(generate("dense", warmSize)));
    }
  } catch (e) {
    say(`ABORT: warm-up render failed: ${String((e && e.message) || e)}`);
    clearTimeout(watchdog);
    return finish(1);
  }

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
        kb: Buffer.byteLength(text, "utf8") / 1024,
        total: rep.renderMs,
        settle: rep.settleMs,
        spread: Math.max(...settles) - Math.min(...settles),
        capped: samples.some((s) => s.capped),
        // If the repetitions did not agree on how big the finished document
        // was, they were not all measuring the same document, and the timing is
        // not comparable with anything. Reported rather than silently averaged.
        nodesAgree: Math.max(...nodeCounts) - Math.min(...nodeCounts) <= Math.max(...nodeCounts) * 0.02,
        phases: rep.phases,
        nodes: rep.nodes,
        tokens: rep.tokens,
        blocks: rep.blocks,
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
  finish(0);
});
