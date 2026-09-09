// ============================================
// test-packaging.js - do the files the app loads at runtime actually ship?
// ============================================
//
// package.json's `build.files` is an explicit allowlist, so anything added to
// the app that is loaded by path - a preload script, a vendored library, a font
// - is silently absent from packaged builds unless it is also added here. The
// failure is invisible in development, where everything is read straight from
// the working tree, and only shows up as a broken feature in a shipped build.
//
// This walks the real runtime references (preload paths in main.js, <script>
// and <link> in index.html, @font-face URLs in styles.css) and asserts each is
// matched by the allowlist.
//
// Run: node test-packaging.js

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { EventEmitter } = require("events");
const { stripJsComments } = require("./test-source-utils.js");

// The repository root, which is this suite's subject - it reads package.json,
// build.files, the shipped sources and the docs. It is one level up now that
// the suites live in test/, and every path here goes through ROOT rather than
// __dirname so that stays true in one place.
const ROOT = path.join(__dirname, "..");
// The application's own source. `libs/` (vendored third party), `fonts/` (a
// gitignored BUILD OUTPUT of scripts/vendor-libs.js) and `assets/` (tracked
// image and font sources) are deliberately SIBLINGS of it rather than children:
// vendored code carries its own LICENSE and .gitattributes pins, and build
// output does not belong inside a source tree. The cost of that decision is
// that references crossing out of src/ are relative (`../libs/...`), which is
// why the discovery below resolves each reference against the directory of the
// file it was found in rather than against ROOT.
const SRC = path.join(ROOT, "src");
let pass = 0;
let fail = 0;
const skipped = [];

// A conditional block that quietly does nothing leaves no trace in the output
// and simply lowers the assertion count, which is indistinguishable from an
// assertion never having existed. Measured: touching package-lock.json after a
// build silently removed the two asar oracles below and the suite still
// reported "0 failed". Skips are therefore announced and counted.
//
// Announcing is enough for a developer reading the output, but not for CI,
// where nobody reads it. PACKAGING_STRICT=1 turns any skip into a failure, so
// a release job can require that the oracles actually RAN rather than merely
// that nothing failed.
function skip(name, reason) {
  skipped.push(name);
  console.log(`  SKIP  ${name}${reason ? " - " + reason : ""}`);
}

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    // THE SEPARATOR IS `  -> `, MATCHING EVERY OTHER SUITE, AND THAT IS
    // LOAD-BEARING RATHER THAN COSMETIC. The revert harness anchors `expect`
    // and `mustPass` to the assertion NAME, which it recovers by splitting a
    // FAIL line on "  ->". This suite used to separate its evidence with " - ",
    // so the name it recovered still carried the evidence - and a revert's
    // regex could be satisfied by a selector, a filename or a colour the suite
    // happened to print about a DIFFERENT assertion. That is exactly the hole
    // assertionNameOf() was introduced to close, left open in the two suites
    // that formatted their own output differently.
    console.log(`  FAIL  ${name}${detail ? "  -> " + detail : ""}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// The component names in a notices document, one place rather than three.
// The trailing token is stripped only when it is VERSION-SHAPED. A blanket
// `/ [^ ]+$/` looks equivalent on today's data but is not: "### Fira Code"
// carries no version, so it was being truncated to "Fira" - which is why the
// vendored-file allowlist below used to have to name the half-word "Fira" to
// match. Any future version-less entry ("Noto Sans", "Source Sans") would have
// hit the same trap, and the failure mode is a MISSING licence notice going
// unnoticed, which is the one outcome this file exists to prevent.
function documentedNames(notices) {
  return new Set(
    (notices.match(/^### .+$/gm) || []).map((h) =>
      h.replace(/^### /, "").replace(/ \d[^ ]*$/, ""),
    ),
  );
}

// electron-builder uses glob semantics; only the small subset this manifest
// actually uses needs to be understood here.
function patternToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` crosses directory separators; `**/` may also match zero segments
        // so that "libs/**/*" matches "libs/x.js" as well as "libs/a/x.js".
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$", "i");
}

function isPackaged(files, rel) {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  let included = false;
  for (const entry of files) {
    const negated = entry.startsWith("!");
    const re = patternToRegExp(negated ? entry.slice(1) : entry);
    if (re.test(norm)) included = !negated;
  }
  return included;
}

async function main() {
  console.log("\n=== Packaging allowlist ===\n");

  const pkg = JSON.parse(read("package.json"));
  const files = pkg.build && pkg.build.files;
  check(
    "the machine-exclusive F22 benchmark script invokes its process-isolated parent",
    pkg.scripts && pkg.scripts["bench:f22"] === "node bench/run-f22-shutdown.js",
    pkg.scripts && pkg.scripts["bench:f22"],
  );
  check(
    "the ordinary npm test aggregate does not run the machine-exclusive F22 benchmark",
    typeof pkg.scripts?.test === "string" && !pkg.scripts.test.includes("bench:f22"),
    pkg.scripts && pkg.scripts.test,
  );
  const buildDoc = read("docs/BUILD.md");
  check(
    "BUILD documents the separate machine-exclusive F22 benchmark command",
    /npm run bench:f22/.test(buildDoc) &&
      /not[^a-z]+part[^a-z]+of[^a-z]+`npm test`/i.test(buildDoc),
  );
  // A GATE THAT PRINTS ONLY ROUNDED NUMBERS AND THEN DELETES ITS WORKING
  // DIRECTORY LEAVES NOTHING TO FILE. That really happened: a run produced a
  // reportable result and the raw samples were gone by the time anyone went
  // looking, because the transcript carried three-decimal figures and the
  // result files had been swept. Both halves are asserted - the greppable
  // machine-readable line that always appears, and the opt-in file written
  // atomically to a caller-chosen path - because either alone can rot.
  {
    const runnerPath = path.join(ROOT, "bench", "run-f22-shutdown.js");
    const runner = fs.existsSync(runnerPath)
      ? fs.readFileSync(runnerPath, "utf8")
      : "";
    check(
      "the F22 benchmark runner is present for the evidence assertions below",
      runner.length > 0,
      `${runnerPath} is ${runner.length} bytes - zero would make the two checks below vacuous`,
    );
    check(
      "the F22 benchmark always emits a machine-readable summary carrying the raw p95",
      /F22-RESULT-JSON/.test(runner) && /rawP95/.test(runner),
      "bench/run-f22-shutdown.js must print an F22-RESULT-JSON line whose summary " +
        "includes rawP95; a rounded figure is not the number the gate judged",
    );
    check(
      "the F22 benchmark can publish its raw samples durably and atomically",
      /F22_RESULT_FILE/.test(runner) &&
        /\.tmp-/.test(runner) &&
        /renameSync/.test(runner) &&
        /F22_RESULT_FILE/.test(buildDoc),
      "bench/run-f22-shutdown.js must honour F22_RESULT_FILE, write through a " +
        "temporary and rename it into place, and docs/BUILD.md must say so",
    );
    // EXCLUSIVITY IS A CLAIM ABOUT PROCESSES, NOT ABOUT INTENTIONS. The lock
    // says "no other benchmark is running on this machine"; removing it while a
    // worker of this run is still alive makes that false for the NEXT run,
    // which then measures a busy machine and reports the number as a gate
    // result. So closure has to be awaited for real - not sampled from an exit
    // code, and above all not waited for by blocking the very event loop the
    // 'close' events arrive on, which is what Atomics.wait() did here.
    check(
      "the F22 benchmark awaits real worker closure instead of blocking its event loop",
      !/Atomics\.wait/.test(runner) &&
        /liveWorkers\s*=\s*new Map\(/.test(runner) &&
        /markClosed\(\)/.test(runner) &&
        // The wait is on the CHILD'S OWN close promise, and it is bounded at
        // both stages of the escalation - not a poll of an exit code, which
        // says the main process ended while its renderers may still hold the
        // stdio this parent's exclusivity claim is about.
        /await waitBounded\(closed, TERMINATION_GRACE_MS\)/.test(runner) &&
        /return waitBounded\(closed, TERMINATION_KILL_MS\)/.test(runner) &&
        /const outcomes = await Promise\.all\(/.test(runner) &&
        /async function terminateLiveWorkers/.test(runner),
      "bench/run-f22-shutdown.js must track a close promise per worker and await " +
        "it with a bounded wait; Atomics.wait blocks the loop the close arrives on",
    );
    check(
      "the F22 benchmark retains its lock and run directory when a worker cannot be proven closed",
      /const closureProven = await terminateLiveWorkers\(\)/.test(runner) &&
        /if \(!closureProven\)/.test(runner) &&
        /quarantined/.test(runner) &&
        // The quarantine branch returns BEFORE either release, so neither the
        // run directory nor the lock can be removed over a survivor.
        /if \(!closureProven\)[\s\S]*?return;[\s\S]*?rmSync\(runRoot/.test(runner) &&
        /if \(!closureProven\)[\s\S]*?return;[\s\S]*?unlinkSync\(lockPath\)/.test(runner),
      "bench/run-f22-shutdown.js must quarantine the lock and run directory rather " +
        "than advertise exclusivity while a worker of the run is still alive",
    );
    check(
      "the F22 benchmark finishes cleanup before any exit path terminates the parent",
      !/releaseRunResources\(\);\s*\n\s*process\.exit/.test(runner) &&
        /releaseRunResources\(\)\.then\(/.test(runner) &&
        /await releaseRunResources\(\)/.test(runner),
      "signal, uncaught-exception and unhandled-rejection paths must await the " +
        "asynchronous release before process.exit, or they abandon live workers",
    );
    check(
      "the F22 benchmark quarantines lock and run evidence when publication or cleanup fails",
      (() => {
        const publication = runner.indexOf("const publicationProven = publishResults();");
        const publicationFailure = runner.indexOf("retained because required result publication failed");
        const cleanup = runner.indexOf("let cleanupProven = false;");
        const cleanupFailure = runner.indexOf("retained because required cleanup failed");
        const unlock = runner.indexOf("fs.unlinkSync(lockPath)");
        return (
          publication >= 0 &&
          publicationFailure > publication &&
          cleanup > publicationFailure &&
          cleanupFailure > cleanup &&
          unlock > cleanupFailure &&
          /if \(!publicationProven\) \{[\s\S]*?emitResultSummary\(\);[\s\S]*?return;/.test(runner) &&
          /if \(!cleanupProven\) \{[\s\S]*?emitResultSummary\(\);[\s\S]*?return;/.test(runner)
        );
      })(),
      "required result publication and run-directory cleanup must each return through " +
        "quarantine before the exclusive lock can be unlinked",
    );
    const workerPath = path.join(ROOT, "bench", "bench-f22-shutdown.js");
    const worker = fs.existsSync(workerPath)
      ? fs.readFileSync(workerPath, "utf8")
      : "";
    check(
      "the F22 lifecycle worker cannot survive a failed product-path termination",
      worker.length > 0 &&
        /did not terminate through the product path/.test(worker) &&
        // Referenced, not unref'd: an unref'd backstop only fires when
        // something else is already holding the loop open, which is exactly not
        // guaranteed for the case it exists to cover.
        !/watchdog\.unref/.test(worker) &&
        /\}\)\.catch\(\(error\) => \{/.test(worker) &&
        /app\.exit\(process\.exitCode \|\| 1\)/.test(worker),
      "bench/bench-f22-shutdown.js must exit explicitly when the lifecycle quit " +
        "does not complete and when its own teardown throws",
    );
    // A TIMED-OUT WORKER IS NOT A SLOW ROW, IT IS A CONTAMINATED MACHINE. The
    // job that overran is still running somewhere; every measurement taken
    // after it would be taken on a machine with two Electron trees on it, and
    // reported as a gate result. Scheduling has to stop at the timeout, not
    // continue with one bad row recorded.
    check(
      "the F22 benchmark stops scheduling the moment a worker overruns its budget",
      /let matrixAborted = null/.test(runner) &&
        /class MatrixAborted extends Error/.test(runner) &&
        /async function runJob\(job\)/.test(runner) &&
        /if \(matrixAborted\) \{[\s\S]*?throw new MatrixAborted\(/.test(runner) &&
        /child\.timedOut \|\| child\.closureProven === false/.test(runner) &&
        // Every launch goes through the gate: a loop that still called
        // runWorker directly would start the next Electron tree anyway.
        /validateResult\(job, await runJob\(job\)\)/.test(runner) &&
        !/validateResult\(job, await runWorker\(job\)\)/.test(runner),
      "bench/run-f22-shutdown.js must route every job through runJob() and refuse " +
        "to launch another worker once one has timed out or could not be closed",
    );
    check(
      "the F22 benchmark terminates a timed-out worker exactly once and awaits its close",
      /const terminations = new Map\(\)/.test(runner) &&
        /function terminateWorker\(child\)/.test(runner) &&
        /const existing = terminations\.get\(child\);/.test(runner) &&
        /if \(existing\) return existing;/.test(runner) &&
        // The end-of-run sweep delegates rather than running a second ladder.
        /map\(\(child\) => terminateWorker\(child\)\)/.test(runner) &&
        // The overrun is latched at the instant it happens, so a worker that
        // closes during its own termination cannot erase it.
        /budgetExceeded = true;/.test(runner) &&
        /timedOut: budgetExceeded/.test(runner) &&
        // The old behaviour: settle after a fixed grace period whether or not
        // the tree closed, and carry on with the next job.
        !/SIGKILL-TIMEOUT/.test(runner),
      "bench/run-f22-shutdown.js must terminate the exact timed-out child through " +
        "one shared escalation and settle on its observed close",
    );
    // Source checks establish that the fail-closed branches are present, but
    // cannot prove that an EventEmitter error really leaves the run blocked
    // until close. Load an isolated copy with a deterministic child-process
    // double so this exercises the actual error listeners, termination ladder,
    // live-worker registration, and runJob scheduling gate without launching
    // Electron or a benchmark matrix.
    const loadLifecycleProbe = () => {
      const childProcess = require("child_process");
      const realSpawn = childProcess.spawn;
      const runnerModule = require.resolve(runnerPath);
      const cachedRunner = require.cache[runnerModule];
      const children = [];
      childProcess.spawn = () => {
        const child = new EventEmitter();
        child.pid = 4242 + children.length;
        child.exitCode = null;
        child.signalCode = null;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.killCalls = 0;
        child.kill = () => {
          child.killCalls++;
          return true;
        };
        children.push(child);
        return child;
      };
      delete require.cache[runnerModule];
      let runner;
      try {
        runner = require(runnerPath);
      } finally {
        childProcess.spawn = realSpawn;
        if (cachedRunner) require.cache[runnerModule] = cachedRunner;
        else delete require.cache[runnerModule];
      }
      return { runner, children };
    };
    const proveLifecycleErrorFailsClosed = async (source) => {
      const { runner, children } = loadLifecycleProbe();
      const first = runner.runJob({
        id: `controlled-${source}`,
        mode: "controlled",
        jobFile: "controlled-job.json",
      });
      let firstSettled = false;
      first.then(
        () => { firstSettled = true; },
        () => { firstSettled = true; },
      );
      const child = children[0];
      const emitter = source === "child process" ? child : child[source];
      const error = new Error(`controlled ${source} error`);
      error.code = "EIO";
      emitter.emit("error", error);
      let secondErrorCaught = null;
      try {
        emitter.emit("error", new Error(`second controlled ${source} error before close`));
      } catch (caught) {
        secondErrorCaught = caught;
      }
      await new Promise((resolve) => setImmediate(resolve));
      const blockedUntilClose =
        !firstSettled && child.killCalls === 1 && runner.liveWorkers.has(child);
      child.exitCode = 1;
      child.emit("close", 1, null);
      const outcome = await first;
      let lateErrorCaught = null;
      try {
        emitter.emit("error", new Error(`late controlled ${source} error after close`));
      } catch (caught) {
        lateErrorCaught = caught;
      }
      let refused = null;
      try {
        await runner.runJob({
          id: `after-${source}`,
          mode: "controlled",
          jobFile: "controlled-job.json",
        });
      } catch (caught) {
        refused = caught;
      }
      return {
        blockedUntilClose,
        outcome,
        firstError: error,
        secondErrorCaught,
        lateErrorCaught,
        workerClosed: !runner.liveWorkers.has(child),
        refused,
        spawned: children.length,
      };
    };
    for (const source of ["child process", "stdout", "stderr"]) {
      const probe = await proveLifecycleErrorFailsClosed(source);
      check(
        `the F22 benchmark fail-closes a ${source} error until the actual child close`,
        probe.blockedUntilClose &&
          probe.outcome.closureProven === true &&
          probe.outcome.firstWorkerError === probe.firstError &&
          probe.outcome.workerErrors?.[0]?.startsWith(`${source} error:`) &&
          probe.secondErrorCaught === null &&
          probe.lateErrorCaught === null &&
          probe.workerClosed &&
          /no job may start after:/.test(probe.refused?.message || "") &&
          probe.spawned === 1,
        `blockedUntilClose=${probe.blockedUntilClose} closureProven=${probe.outcome.closureProven} ` +
          `firstErrorPreserved=${probe.outcome.firstWorkerError === probe.firstError} ` +
          `workerErrors=${JSON.stringify(probe.outcome.workerErrors)} secondErrorCaught=${probe.secondErrorCaught} ` +
          `lateErrorCaught=${probe.lateErrorCaught} workerClosed=${probe.workerClosed} ` +
          `refused=${probe.refused && probe.refused.message} spawned=${probe.spawned}`,
      );
    }
    check(
      "the F22 error paths publish failure detail and preserve the lock quarantine on unproven closure",
      /workerErrors=\$\{child\.workerErrors\.join/.test(runner) &&
        /child\.timedOut \|\| child\.closureProven === false \|\| child\.workerErrors\?\.length/.test(runner) &&
        /if \(!closureProven\)[\s\S]*?run resources quarantined[\s\S]*?publishResults\(\)[\s\S]*?return;/.test(runner) &&
        /if \(require\.main === module\)/.test(runner),
      "worker and stream errors must be published, abort the matrix, and retain lock/run evidence " +
        "when termination cannot prove closure; lifecycle probes must not launch the real matrix",
    );
    // AN ACTIVE-EDITOR NUMBER HAS TO HAVE COME FROM THE ACTIVE-EDITOR BRANCH.
    // The edit-* observations put a 2 MB buffer in the textarea and let the
    // shutdown fold reconcile it; a fold that quietly took the view-mode path
    // instead produces a plausible number that measures the wrong thing. The
    // buffer ends in a character no sample ever writes to the cache, so a cache
    // that ends in it can only have been adopted from the editor - and the
    // parent requires that witness on EVERY sample.
    check(
      "the F22 benchmark proves its active-editor samples really reconciled the editor",
      /editReconciled/.test(runner) &&
        /reconciled\.samples !== EXPECTED_SAMPLES\[job\.mode\]/.test(runner) &&
        /setup\.editorRendered !== false/.test(runner) &&
        /editReconciled/.test(worker) &&
        /did not reconcile the editor into the cache/.test(worker) &&
        // Written once, in setup - not per sample. Re-assigning two million
        // characters into a laid-out textarea twenty times is what made the
        // renderer miss its liveness pings and fail the run's health check.
        /THE 2 MB BUFFER GOES IN ONCE/.test(worker),
      "bench must witness the editor-to-cache reconciliation on every edit-* sample " +
        "and must not rewrite the 2MB textarea inside the sample loop",
    );
  }
  // THE READ-ONLY AUDIT MUST WORK ON A CLEAN CHECKOUT. A fresh runner has no
  // `dist/app.asar`, so every built-ASAR oracle announces itself SKIPPED. Until
  // this distinction existed, `--expects` read those names as dead regexes and
  // failed - which meant the one audit that costs no mutation could not be run
  // without first producing a release build. A skipped name is live but
  // unobserved, and the audit has to say exactly that: not an orphan, and not a
  // proof either.
  {
    const harness = read("scripts/prove-table-fixes.js");
    check(
      "the revert audit distinguishes a skipped assertion from a dead regex",
      /skippedMatch/.test(harness) &&
        /SKIPPED\s+\$\{label\}|SKIPPED  /.test(harness) &&
        /proves nothing here/.test(harness) &&
        // Still an orphan when it matches nothing at all: the escape hatch is
        // the specific skipped NAME, never "some block skipped in this run".
        /ORPHANED \$\{label\}/.test(harness),
      "scripts/prove-table-fixes.js must report a regex that names a SKIPPED " +
        "assertion separately from one that names nothing, without counting " +
        "either as proven",
    );
    // THE OTHER WAY THAT AUDIT CAN LIE, and the one that actually happened: a
    // suite that crashed part-way prints a TRUNCATED list of assertion names,
    // and every name it never reached then looks like a dead regex. Measured -
    // one harness exception turned a 205-name catalogue into 177 and produced
    // 255 confident, wrong orphan findings. "The suite did not finish" and
    // "this regex is dead" are different results and only one of them is about
    // the records.
    check(
      "the revert cataloguer refuses to convict a regex on a suite that did not finish",
      /function runSuiteChecked/.test(harness) &&
        /SUITE UNUSABLE/.test(harness) &&
        // The health signals themselves: a non-zero exit, and a missing
        // `=== N/M passed ===` footer, which is what a crashed run leaves out.
        /if \(exitCode !== 0\) reasons\.push/.test(harness) &&
        /the run did not finish/.test(harness) &&
        // AND THE GATE IS ACTUALLY APPLIED. A health check that is computed and
        // then ignored is the same as no health check at all. Anchored to a
        // whole source line: this file also CONTAINS the revert record that
        // perturbs that line, and a substring match would happily find the
        // record's own quoted copy of it and report the control present after
        // it had been removed.
        /^ {4}if \(!run\.healthy\) \{\r?$/m.test(harness) &&
        /unusableSuites/.test(harness) &&
        // The records under an unusable suite are counted as unaudited rather
        // than classified, and the exit code is distinct from "found orphans".
        /unaudited \+=/.test(harness) &&
        /process\.exit\(2\)/.test(harness) &&
        // And true orphans are still reported: the escape hatch is the suite's
        // health, never the regex's convenience.
        /ORPHANED \$\{label\}/.test(harness),
      "scripts/prove-table-fixes.js must detect a suite that did not run to " +
        "completion and report its regexes as unaudited rather than as orphans",
    );
  }
  check("package.json declares build.files", Array.isArray(files) && files.length > 0);
  if (!Array.isArray(files)) {
    console.log("\nCannot continue without build.files.\n");
    process.exit(1);
  }

  // Sanity-check the matcher itself, so a broken matcher cannot make the real
  // assertions below pass vacuously.
  check("matcher: exact name matches", isPackaged(["main.js"], "main.js"));
  check("matcher: exact name does not over-match", !isPackaged(["main.js"], "other.js"));
  check("matcher: ** matches nested", isPackaged(["libs/**/*"], "libs/vendor/x.js"));
  check("matcher: ** matches direct child", isPackaged(["libs/**/*"], "libs/x.js"));
  check("matcher: negation excludes", !isPackaged(["a/**/*", "!a/b.js"], "a/b.js"));
  check(
    "matcher: a file that is genuinely absent is reported absent",
    !isPackaged(files, "definitely-not-shipped-xyz.js"),
  );

  const referenced = new Set();
  // A reference is relative to the FILE THAT MAKES IT, not to the repository
  // root. That distinction did not exist while every referring file sat at the
  // root, and it is exactly what the src/ move introduced: `../libs/x.js` in
  // src/index.html and `libs/x.js` in a root-level file name the same file.
  // Resolving here - once - keeps every downstream assertion (exists on disk,
  // is in build.files, the mermaid canary) speaking one vocabulary: paths
  // relative to the repository root, in POSIX form, which is what build.files
  // is written in.
  const addRef = (fromDir, ref) => {
    const abs = path.resolve(fromDir, ref);
    referenced.add(path.relative(ROOT, abs).replace(/\\/g, "/"));
  };

  // 1. Preload scripts referenced from the main process.
  const mainJs = read("src/main.js");
  // MacUpdater has no BaseUpdater-style, attributable synchronous
  // before-quit-for-update/app.quit pair. This platform path cannot be driven
  // live from the Windows/Linux packaging harness, so pin its fail-closed
  // contract structurally without inventing that lifecycle.
  const macExplicitInstallStart = mainJs.indexOf(
    'if (process.platform === "darwin") {',
  );
  const macExplicitInstallEnd = mainJs.indexOf(
    "\n  // BaseUpdater.install()",
    macExplicitInstallStart,
  );
  const macExplicitInstallBlock =
    macExplicitInstallStart >= 0 && macExplicitInstallEnd > macExplicitInstallStart
      ? mainJs.slice(macExplicitInstallStart, macExplicitInstallEnd)
      : "";
  check(
    "macOS explicit update installation fails closed instead of assuming a BaseUpdater quit pair",
    /Explicit update installation is unavailable on macOS/.test(
      macExplicitInstallBlock,
    ) &&
      /status:\s*"error"/.test(macExplicitInstallBlock) &&
      /replayAbsorbedUserShutdownAfterUpdaterCancel\(\s*"unsupported-macos-explicit-install"/.test(
        macExplicitInstallBlock,
      ) &&
      /return false;/.test(macExplicitInstallBlock) &&
      !/watchUpdaterInstallCommit|quitAndInstall/.test(macExplicitInstallBlock),
    "the macOS explicit-install branch must report an error, replay any absorbed user " +
      "intent, return false, and never claim BaseUpdater's paired quit lifecycle",
  );
  const preloadRe = /preload:\s*path\.join\(\s*__dirname\s*,\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let m;
  while ((m = preloadRe.exec(mainJs))) addRef(SRC, m[1]);
  check("found at least one preload reference in main.js", referenced.size > 0);

  // 2. Scripts and stylesheets loaded by the renderer document.
  const indexHtml = read("src/index.html");
  const srcRe = /<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"':]+)["']/gi;
  while ((m = srcRe.exec(indexHtml))) {
    const ref = m[1].replace(/^\.\//, "");
    if (!/^(https?:|data:|#)/i.test(ref)) addRef(SRC, ref);
  }

  // 3. Font files referenced by @font-face, which have no import statement to
  //    give them away and so are especially easy to leave out.
  const css = read("src/styles.css");
  const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  while ((m = urlRe.exec(css))) {
    const ref = m[1].replace(/^\.\//, "");
    if (!/^(https?:|data:)/i.test(ref)) addRef(SRC, ref);
  }

  // 4. Assets loaded lazily at runtime by injecting a <script> or <link>, or by
  //    any other runtime construct. These have no static tag in index.html, so
  //    step 2 cannot see them - which is the same invisibility problem this
  //    whole file exists for, one level deeper. Removing mermaid's eager
  //    <script> tag for PERF-03 silently dropped it from this test's coverage
  //    until this step was added.
  //
  //    The scan is deliberately construct-agnostic: it matches any string
  //    literal that looks like a shipped asset path, so `new Worker(...)`,
  //    `setAttribute('src', ...)`, `import(...)` and `new URL(...)` are all
  //    caught without needing a rule each. An earlier version keyed on
  //    `.src = '...'` specifically, which meant a future asset added through
  //    any other construct would have slipped past in silence.
  //
  //    Over-matching is the safe direction here: a path named in a comment or
  //    an error message only adds an assertion that the file ships, which it
  //    should. Under-matching is the failure that actually costs anything.
  const runtimeSources = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith(".js") && !/^(test-|bench-|probe-)/.test(f));
  const assetLiteralRe =
    /['"`]((?:\.\.\/)?(?:libs|fonts|assets)\/[^'"`$\\\s]+\.(?:js|mjs|css|woff2?|ttf|eot|svg|png|jpg|gif))['"`]/g;
  // A path built by interpolation cannot be resolved statically. Rather than
  // quietly missing it, say so.
  const unresolvableRe = /`(?:\.\.\/)?(?:libs|fonts|assets)\/[^`]*\$\{/g;
  const unresolvable = [];
  for (const file of runtimeSources) {
    const src = read("src/" + file);
    while ((m = assetLiteralRe.exec(src))) addRef(SRC, m[1]);
    if (unresolvableRe.test(src)) unresolvable.push(file);
    unresolvableRe.lastIndex = 0;
  }
  check(
    "no runtime asset path is built by interpolation the scanner cannot resolve",
    unresolvable.length === 0,
    `template-literal asset paths in ${unresolvable.join(", ")} cannot be ` +
      "checked statically; either make the path a literal or extend this step",
  );
  // A canary rather than a count. "at least one dynamic reference exists" was
  // satisfied by mermaid alone, so it stayed green - and stayed reassuring -
  // even if a newly added lazy asset was being missed entirely.
  //
  // It is also the guard on the src/ move: the sweep above reads a DIRECTORY,
  // so pointing it at the wrong one yields an empty file list and a silent
  // pass. Measured by forcing the sweep to return nothing - this canary is one
  // of three assertions that fire.
  check(
    "the known lazily-loaded bundle is discovered by the scanner",
    referenced.has("libs/vendor/mermaid.min.js"),
    "mermaid.min.js is injected at runtime by ensureMermaid() but this scan " +
      "did not find it; if lazy loading was removed, delete this check, but " +
      "if the loader merely changed shape, the scanner is now blind",
  );

  console.log(`\n  ${referenced.size} runtime references discovered\n`);

  for (const ref of [...referenced].sort()) {
    const onDisk = fs.existsSync(path.join(ROOT, ref));
    // A reference that does not exist on disk is a separate (worse) bug, but
    // it is not a packaging bug, so report it distinctly rather than as a
    // missing allowlist entry.
    check(
      `${ref} exists on disk`,
      onDisk,
      onDisk ? "" : "referenced at runtime but not present",
    );
    if (onDisk) {
      check(`${ref} is in build.files`, isPackaged(files, ref));
    }
  }

  // Explicit regression guards for the two files this suite was written for.
  check("popup-preload.js is in build.files", isPackaged(files, "src/popup-preload.js"));
  // fonts/ is a BUILD OUTPUT (gitignored) produced by scripts/vendor-libs.js
  // from the tracked assets/fonts/. Asserting only on fonts/ would therefore
  // keep passing on a machine that has stale build output while the SOURCE has
  // been deleted from the repo - and the first sign of trouble would be a
  // postinstall failure on someone else's clean clone, or nothing at all in an
  // environment that installs with scripts disabled. So assert the source too.
  const fontSrcDir = path.join(ROOT, "assets", "fonts");
  check(
    "assets/fonts is present and populated (tracked source for font vendoring)",
    fs.existsSync(fontSrcDir) &&
      fs.readdirSync(fontSrcDir).some((f) => /\.ttf$/i.test(f)),
    fs.existsSync(fontSrcDir) ? fs.readdirSync(fontSrcDir).join(",") : "absent",
  );
  const fontFiles = fs.existsSync(path.join(ROOT, "fonts"))
    ? fs.readdirSync(path.join(ROOT, "fonts")).filter((f) => /\.ttf$/i.test(f))
    : [];
  check("vendored fonts exist", fontFiles.length > 0);
  for (const f of fontFiles) {
    check(`fonts/${f} is in build.files`, isPackaged(files, "fonts/" + f));
  }

  // ONE parser for the LIBS table in scripts/vendor-libs.js, read here and
  // consumed by three separate oracles below (the unused-devDependency scan,
  // the "every vendored library has a notice" compliance check and the
  // vendored-freshness block). A second copy is exactly how two oracles come
  // to disagree about what the product vendors while both keep passing - the
  // defect class this file has caught four times already. The regex is LAX on
  // purpose: it takes the first string of each entry, so it still finds the
  // package name if the triple's shape ever changes. The freshness block
  // parses the same table STRICTLY and cross-checks the two counts, which is
  // what stops this lax read from silently matching the wrong thing.
  const vendorSrc = read("scripts/vendor-libs.js");
  const libsTable = /const LIBS = \[([\s\S]*?)\];/.exec(vendorSrc);
  const libsNames = libsTable
    ? [...libsTable[1].matchAll(/\[\s*"([^"]+)"/g)].map((m) => m[1])
    : [];

  // Production dependencies and bare requires must be the SAME set, in both
  // directions. This is the general form of the finding that shrank app.asar
  // from 153.6 MB to 23.2 MB: `build.files` ships `node_modules/**/*` and
  // electron-builder prunes only devDependencies, so a package declared in
  // `dependencies` is installed into every user's machine whether any shipped
  // line requires it or not. That sweep was done by hand once; this is the
  // version that keeps being true.
  //
  // The reverse direction matters just as much and fails far more loudly: a
  // bare require with no matching dependency works forever on the developer's
  // machine, where the package is present transitively or left over from an
  // earlier install, and throws on a clean install.
  {
    const shippedJs = fs
      .readdirSync(SRC)
      .filter(
        (f) =>
          f.endsWith(".js") &&
          !/^(test-|bench-|probe-)/.test(f) &&
          isPackaged(files, "src/" + f),
      );
    const builtins = new Set(require("module").builtinModules);
    const required = new Map();
    const bareRe = /\brequire\(\s*["']([^"'.\/][^"']*)["']\s*\)/g;
    for (const f of shippedJs) {
      const src = read("src/" + f);
      let mm;
      while ((mm = bareRe.exec(src))) {
        // Scoped and subpath specifiers resolve to their package root.
        const spec = mm[1];
        const pkgName = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        if (builtins.has(pkgName) || pkgName === "electron" || pkgName.startsWith("node:")) continue;
        if (!required.has(pkgName)) required.set(pkgName, new Set());
        required.get(pkgName).add(f);
      }
    }
    const declared = new Set(Object.keys(pkg.dependencies || {}));

    // Vacuity floor. A regex that silently stops matching - because requires
    // move behind a helper, or the shipped-file filter changes shape - would
    // otherwise satisfy both assertions below by finding nothing at all.
    //
    // Tied to the DECLARED count rather than a constant, because a constant
    // floor sits at whatever today's number is and a dependency removal walks
    // straight under it. Two of anything is not a meaningful floor when the
    // tree declares exactly two production dependencies.
    check(
      "the bare-require scan found something to check",
      required.size >= declared.size && declared.size > 0,
      `${required.size} bare require(s) across ${shippedJs.length} shipped file(s): ` +
        `${[...required.keys()].join(", ")} - fewer than the ${declared.size} declared ` +
        "dependencies, so the scan or the file filter has gone blind",
    );

    const undeclared = [...required.keys()].filter((n) => !declared.has(n));
    check(
      "every bare require in shipped code is a declared production dependency",
      undeclared.length === 0,
      undeclared
        .map((n) => `${n} (required by ${[...required.get(n)].join(", ")})`)
        .join("; ") + " - present on this machine, absent on a clean install",
    );

    const unused = [...declared].filter((n) => !required.has(n));
    check(
      "every production dependency is actually required by shipped code",
      unused.length === 0,
      `${unused.join(", ")} ship into every installer but nothing loads them; ` +
        "they belong in devDependencies, or the require that justified them is gone",
    );
  }

  // The same sweep for devDependencies, which the block above deliberately
  // cannot cover: its subject is `Object.keys(pkg.dependencies)`, so a dead
  // devDependency is invisible to it by construction. That is not
  // hypothetical - `png-to-ico` sat in this manifest long after both .ico
  // files it once produced became TRACKED artifacts, and nothing noticed,
  // because a devDependency is not required by any SHIPPED file BY DEFINITION.
  //
  // A devDependency is justified by any ONE of five sources, each MEASURED
  // against this tree rather than assumed:
  //   (a) the shared LIBS table   - marked, mermaid and dompurify are
  //                                 VENDORED, so nothing ever requires them
  //   (b) a committed libs/<name> - prismjs ships as checked-in source
  //   (c) a require()/import under scripts/ or test/   - ajv, electron
  //   (d) an npm script command   - electron-builder is only ever a CLI
  //   (e) a workflow file         - a CI-only tool has no other trace
  //
  // (e) is not UNIQUELY load-bearing today - electron-builder is also named by
  // an npm script - but a devDependency used only by CI is a real category,
  // and dropping the source would report the next one of those as dead.
  {
    const declaredDev = Object.keys(pkg.devDependencies || {});

    const toolFiles = [];
    const walkTools = (rel) => {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (e.name === "node_modules") continue;
        const child = rel + "/" + e.name;
        if (e.isDirectory()) walkTools(child);
        else if (/\.(js|cjs|mjs)$/.test(e.name)) toolFiles.push(child);
      }
    };
    walkTools("scripts");
    walkTools("test");

    const toolRequired = new Set();
    const specRe =
      /(?:\brequire\(\s*["']([^"'.\/][^"']*)["']\s*\)|\bfrom\s+["']([^"'.\/][^"']*)["'])/g;
    for (const f of toolFiles) {
      const srcText = read(f);
      let mm;
      while ((mm = specRe.exec(srcText))) {
        const spec = mm[1] || mm[2];
        toolRequired.add(
          spec.startsWith("@")
            ? spec.split("/").slice(0, 2).join("/")
            : spec.split("/")[0],
        );
      }
    }

    const libsDirs = fs.existsSync(path.join(ROOT, "libs"))
      ? fs
          .readdirSync(path.join(ROOT, "libs"), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      : [];

    const scriptText = Object.values(pkg.scripts || {}).join("\n");
    const wfDir = path.join(ROOT, ".github", "workflows");
    const workflowText = fs.existsSync(wfDir)
      ? fs
          .readdirSync(wfDir)
          .map((f) => read(".github/workflows/" + f))
          .join("\n")
      : "";

    // Token match, not substring: `electron` must not be evidenced by the
    // string "electron-builder", or removing the last real use of electron
    // would go unnoticed for as long as electron-builder stays declared.
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namedIn = (hay, n) =>
      new RegExp(
        "(^|[^A-Za-z0-9_@/.-])" + escRe(n) + "([^A-Za-z0-9_-]|$)",
      ).test(hay);

    const evidence = new Map();
    const bySource = {
      "LIBS table": [],
      "committed libs/ directory": [],
      "require under scripts/ or test/": [],
      "npm script": [],
      "workflow": [],
    };
    for (const n of declaredDev) {
      const where = [];
      if (libsNames.includes(n)) {
        where.push("LIBS table");
        bySource["LIBS table"].push(n);
      }
      if (libsDirs.includes(n)) {
        where.push("libs/" + n);
        bySource["committed libs/ directory"].push(n);
      }
      if (toolRequired.has(n)) {
        where.push("required by scripts/ or test/");
        bySource["require under scripts/ or test/"].push(n);
      }
      if (namedIn(scriptText, n)) {
        where.push("npm script");
        bySource["npm script"].push(n);
      }
      if (namedIn(workflowText, n)) {
        where.push("workflow");
        bySource["workflow"].push(n);
      }
      evidence.set(n, where);
    }

    // The vacuity floor, and it is a RELATIONSHIP rather than a count: every
    // one of the five sources must justify at least one declared
    // devDependency. A source that has silently stopped matching - a moved
    // directory, a regex that no longer fits the file shape - would otherwise
    // make a live dependency look dead, and the assertion below would fail
    // NAMING THE WRONG THING. Assert the cause beside the consequence.
    const deadSources = Object.entries(bySource)
      .filter(([, v]) => v.length === 0)
      .map(([k]) => k);
    check(
      "every devDependency evidence source is live",
      declaredDev.length > 0 && deadSources.length === 0,
      `${declaredDev.length} devDependenc(ies) declared across ${toolFiles.length} tool file(s); ` +
        `source(s) matching nothing: ${deadSources.join(", ") || "none"} - a source that has ` +
        "stopped matching reports a live dependency as dead",
    );

    const deadDev = declaredDev.filter((n) => evidence.get(n).length === 0);
    check(
      "every devDependency is used by something in this repository",
      deadDev.length === 0,
      `${deadDev.join(", ")} - declared but named by no vendoring table entry, committed libs/ ` +
        "directory, require, npm script or workflow; it is installed on every contributor's " +
        "machine and on every CI run for nothing",
    );
  }

  // TABULATOR IS VENDORED BY HAND, SO NOTHING RESOLVES ITS API FOR US. The
  // table popup builds its options object as a literal inside a template
  // string, and Tabulator silently ignores options it does not recognise
  // (it only logs, via debugInvalidOptions). A major-version bump can
  // therefore retire an option and leave the app passing it forever: that is
  // not hypothetical, `resizableColumns` is a Tabulator 4.x spelling that was
  // still being passed under 6.2.5, recognised by nothing, and no test could
  // see it because no test ever compared the two sides.
  //
  // THE EARLIER VERSION OF THIS BLOCK CARRIED A COMMENT CLAIMING THAT "the only
  // honest question to ask of a minified bundle is whether the option NAME
  // appears at all". THAT WAS FALSE, and measuring it is what replaced this
  // whole block. Tabulator declares its own option surface in the bundle, in
  // two places, and both can be read exactly:
  //
  //   registerTableOption("name") calls .......... 150 names
  //   the core defaults object literal ............ 43 names
  //   union (measured: zero overlap) .............. 193 names
  //   registerColumnOption + column defaults ...... 136 names
  //
  // THE UNION IS MANDATORY, NOT BELT-AND-BRACES, and that is asserted rather
  // than asserted-about: `data`, `columns` and `height` - three of the twelve
  // options this app actually passes - are reachable ONLY through the defaults
  // literal, and `title`/`field` likewise on the column side. Dropping either
  // half makes a genuinely shipped option look unrecognised.
  //
  // What the loose `\bname\b` matcher it replaces really answered: YES for
  // `fitColumns`, `cellClick` and `rowClick` - none of which are recognised
  // constructor options - because those strings occur in the bundle as values,
  // method names and event names. So it could not fail for any plausible
  // retired option whose name survives anywhere in 3 MB of minified code.
  //
  // THE TEMPLATE-LITERAL RULE, which governs both captures below. `new
  // Tabulator(` lives INSIDE the popup HTML template literal in main.js (the
  // popup script is embedded as string content), so stripping comments from
  // the whole file can never reach it - by design, since the stripper treats a
  // backtick as an ordinary quote and does not descend into an interpolation.
  // Slice from the anchor FIRST (which starts in code context), then strip.
  // And because the hardened stripper is NOT length-preserving (a line comment
  // collapses to "\n", a block comment to one space), an index is only ever
  // valid against the exact string it was computed from.
  {
    const mainSrc = read("src/main.js");
    const rendererSrc = read("src/renderer.js");
    const tabBundlePath = path.join(ROOT, "libs", "tabulator", "tabulator.min.js");
    const tabBundle = fs.existsSync(tabBundlePath)
      ? fs.readFileSync(tabBundlePath, "utf8")
      : "";

    // Brace-match forward from an opening bracket, honouring quotes.
    function matchBracket(src, start) {
      const open = src[start];
      const close = { "{": "}", "[": "]", "(": ")" }[open];
      let depth = 0;
      let i = start;
      const n = src.length;
      while (i < n) {
        const c = src[i];
        if (c === '"' || c === "'" || c === "`") {
          const q = c;
          i++;
          while (i < n) {
            if (src[i] === "\\") {
              i += 2;
              continue;
            }
            if (src[i] === q) break;
            i++;
          }
          i++;
          continue;
        }
        if (c === open) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) return i;
        }
        i++;
      }
      return -1;
    }

    // Object keys at depth 0 of an object-literal body. A nested callback's own
    // keys live at depth > 0 and are excluded STRUCTURALLY, so a callback can
    // neither truncate the scan nor pad it.
    function keysAtTopLevel(body) {
      const keys = [];
      let depth = 0;
      let i = 0;
      const n = body.length;
      while (i < n) {
        const c = body[i];
        if (c === '"' || c === "'" || c === "`") {
          const q = c;
          i++;
          while (i < n) {
            if (body[i] === "\\") {
              i += 2;
              continue;
            }
            if (body[i] === q) break;
            i++;
          }
          i++;
          continue;
        }
        if (c === "{" || c === "[" || c === "(") {
          depth++;
          i++;
          continue;
        }
        if (c === "}" || c === "]" || c === ")") {
          depth--;
          i++;
          continue;
        }
        if (depth === 0 && /[A-Za-z_$]/.test(c)) {
          let j = i;
          while (j < n && /[\w$]/.test(body[j])) j++;
          let k = j;
          while (k < n && /\s/.test(body[k])) k++;
          if (body[k] === ":") keys.push(body.slice(i, j));
          i = j;
          continue;
        }
        i++;
      }
      return keys;
    }

    // The 2nd argument of `new Tabulator(...)`, located by brace matching
    // rather than by a non-greedy regex. See the template-literal rule above.
    function captureTabulatorOptions(src) {
      const rawAt = src.indexOf("new Tabulator(");
      if (rawAt === -1) return null;
      const clean = stripJsComments(src.slice(rawAt));
      const at = clean.indexOf("new Tabulator(");
      if (at === -1) return null;
      const lparen = clean.indexOf("(", at);
      const rparen = matchBracket(clean, lparen);
      if (rparen === -1) return null;
      let depth = 0;
      for (let i = lparen; i < rparen; i++) {
        const c = clean[i];
        if (c === "(") depth++;
        else if (c === ")") depth--;
        else if (c === "{" && depth === 1) {
          const end = matchBracket(clean, i);
          if (end === -1 || end > rparen) return null;
          return clean.slice(i + 1, end);
        }
      }
      return null;
    }

    function registered(fn) {
      const set = new Set();
      const re = new RegExp(fn + '\\(\\s*"([A-Za-z_$][\\w$]*)"', "g");
      let m;
      while ((m = re.exec(tabBundle))) set.add(m[1]);
      return set;
    }

    // Walk BACKWARDS from a known member of a defaults literal to its opening
    // brace, then brace-match forward and read the keys.
    function defaultsLiteralAt(anchor) {
      const at = tabBundle.indexOf(anchor);
      if (at === -1) return new Set();
      let depth = 0;
      let open = -1;
      for (let i = at; i >= 0; i--) {
        const c = tabBundle[i];
        if (c === "}") depth++;
        else if (c === "{") {
          if (depth === 0) {
            open = i;
            break;
          }
          depth--;
        }
      }
      if (open === -1) return new Set();
      const end = matchBracket(tabBundle, open);
      if (end === -1) return new Set();
      const body = tabBundle.slice(open + 1, end);
      const set = new Set();
      const re = /(^|[,{])\s*([A-Za-z_$][\w$]*)\s*:/g;
      let m;
      while ((m = re.exec(body))) set.add(m[2]);
      return set;
    }

    const tabReg = registered("registerTableOption");
    const tabDfl = defaultsLiteralAt("debugInvalidOptions");
    const tableSurface = new Set([...tabReg, ...tabDfl]);
    const colReg = registered("registerColumnOption");
    const colDfl = defaultsLiteralAt("title:void 0,field:void 0");
    const colSurface = new Set([...colReg, ...colDfl]);
    const BOGUS = "totallyBogusTabulatorOption";

    check(
      "the Tabulator option surface was extracted from the vendored bundle, not matched loosely",
      tabReg.size > 0 &&
        tabDfl.size > 0 &&
        tableSurface.size === 193 &&
        colSurface.size === 136 &&
        !tableSurface.has(BOGUS) &&
        !tableSurface.has("fitColumns") &&
        !tableSurface.has("cellClick") &&
        !tableSurface.has("rowClick") &&
        tabBundle.includes("rowClick") &&
        !tabReg.has("height") &&
        tableSurface.has("height") &&
        !colReg.has("title") &&
        colSurface.has("title") &&
        colSurface.has("field"),
      `registerTableOption=${tabReg.size} + defaults=${tabDfl.size} -> table surface ` +
        `${tableSurface.size} (measured 193); column surface ${colSurface.size} ` +
        "(measured 136). The union is MANDATORY: `height` (table) and `title` " +
        "(column) are shipped options reachable only through the defaults " +
        "literal. And the surface must still answer NO for names the old loose " +
        "matcher accepted - fitColumns, cellClick, rowClick all occur in the " +
        "bundle but none is a recognised constructor option",
    );

    const tabOpts = keysAtTopLevel(captureTabulatorOptions(mainSrc) || "");

    // THE FLOOR CARRIES ITS OWN NEGATIVE CONTROL. An absence check fails open:
    // if the capture stopped finding the constructor, or the bundle went
    // unread, `tabOpts` would be empty and the assertion below would pass
    // having compared nothing. Worse, a matcher that answered TRUE for
    // everything would also pass.
    check(
      "the Tabulator option scan read both sides and can still answer no",
      tabOpts.length >= 12 &&
        tabBundle.length > 0 &&
        !tableSurface.has(BOGUS),
      `${tabOpts.length} option(s) captured from the constructor (measured 12), ` +
        `${tabBundle.length} byte(s) of bundle read - if either is empty, or an ` +
        "impossible option name resolves, the check below compares nothing",
    );

    const unknownOpts = tabOpts.filter((o) => !tableSurface.has(o));
    check(
      "every Tabulator option the app passes is recognised by the vendored bundle",
      unknownOpts.length === 0,
      `${unknownOpts.join(", ")} - passed to the Tabulator constructor but not a ` +
        "recognised option of the vendored bundle, so it is silently ignored; " +
        "an option retired by an upstream major version looks exactly like this",
    );

    // PLANTED POSITIVE CONTROLS. Neither defect is reachable from the shipped
    // source - main.js has no callback option today and its one block comment
    // is stripped - so a test that waited for the product to exhibit them would
    // be permanently vacuous. The plants are applied to a synthetic COPY, and
    // the assertion additionally requires that they really landed: a plant that
    // silently failed to apply reports a clean capture for the wrong reason.
    const lateCallback = [
      "",
      "          rowClick: function (e, row) {",
      "            requestAnimationFrame(function () {",
      "              row.getElement();",
      "            });",
      "          },",
    ].join("\n");
    const blockComment = [
      "",
      "          /* rejected alternative:",
      "             resizableColumns: true,",
      "             not a recognised option in 6.x */",
    ].join("\n");
    const truncSrc = mainSrc.replace(
      /(\n\s*initialSort\s*:[\s\S]*?\],)/,
      "$1" + lateCallback,
    );
    const phantomSrc = mainSrc.replace(
      /(\n\s*movableColumns\s*:\s*[a-z]+,)/,
      "$1" + blockComment,
    );
    const truncKeys = keysAtTopLevel(captureTabulatorOptions(truncSrc) || "");
    const phantomKeys = keysAtTopLevel(captureTabulatorOptions(phantomSrc) || "");
    const dropped = tabOpts.filter((o) => !truncKeys.includes(o));
    check(
      "the Tabulator option capture is structural: a late callback cannot truncate it and a comment cannot pad it",
      truncSrc !== mainSrc &&
        phantomSrc !== mainSrc &&
        dropped.length === 0 &&
        truncKeys.includes("rowClick") &&
        !phantomKeys.includes("resizableColumns") &&
        !phantomKeys.includes("alternative"),
      `truncation plant: ${truncKeys.length} key(s), dropped [${dropped.join(",")}] ` +
        "(want none - the OLD regex stopped at the callback's own `});` and " +
        "silently lost `height` while reporting the SAME COUNT as a clean tree, " +
        "so a count-based floor could never see it); comment plant: " +
        `${phantomKeys.length} key(s), resizableColumns present=` +
        `${phantomKeys.includes("resizableColumns")} (want false)`,
    );

    // ISSUE 9 - THE COLUMN DEFINITIONS WERE OUTSIDE THE ORACLE'S REACH
    // ENTIRELY. renderer.js builds them for the same popup and they are
    // validated by the same bundle, against a DIFFERENT surface.
    const colAt = rendererSrc.indexOf("columns.push({");
    const colClean =
      colAt === -1 ? "" : stripJsComments(rendererSrc.slice(colAt));
    const colOpen = colClean.indexOf("{");
    const colBodyEnd = colOpen === -1 ? -1 : matchBracket(colClean, colOpen);
    const colKeys =
      colBodyEnd === -1
        ? []
        : keysAtTopLevel(colClean.slice(colOpen + 1, colBodyEnd));
    check(
      "the Tabulator column option scan read both sides and can still answer no",
      colKeys.length >= 4 && colSurface.size > 0 && !colSurface.has(BOGUS),
      `${colKeys.length} column option(s) captured from renderer.js ` +
        `[${colKeys.join(",")}] (measured 4), ${colSurface.size} name(s) of ` +
        "column surface - if either is empty the check below compares nothing",
    );

    const colUnknown = colKeys.filter((k) => !colSurface.has(k));
    check(
      "every Tabulator column option the popup builds is recognised by the vendored bundle",
      colUnknown.length === 0,
      `${colUnknown.join(", ")} - written into a Tabulator column definition in ` +
        "src/renderer.js but not a recognised column option of the vendored " +
        "bundle, so it is silently ignored",
    );
  }

  // Shipping the right file list is useless if electron-builder refuses the
  // configuration outright. The 24 -> 26 upgrade removed `win.sign` (signing
  // moved under `win.signtoolOptions`), which made EVERY packaged build fail
  // at the schema-validation step - invisible to the whole test suite, because
  // tests run from the working tree and never invoke the packager. The release
  // workflow would have been the first thing to find out.
  //
  // electron-builder ships its own JSON schema and validates against it with
  // ajv. We do the same thing here rather than hand-rolling a key walker: a
  // first attempt only compared top-level key names per section, which caught
  // the `win.sign` case but was blind to nested objects (`win.target[].*`,
  // `extraResources[].*`, `directories.*`), to value-type changes
  // (`win.icon` becoming an object), and to any section not in a hard-coded
  // list. Delegating to the real validator covers all of those for free and
  // cannot drift out of step with the sections the config actually uses.
  const schemaPath = path.join(
    ROOT,
    "node_modules",
    "app-builder-lib",
    "scheme.json",
  );
  if (!fs.existsSync(schemaPath)) {
    check("electron-builder schema is available to validate against", false,
      "node_modules/app-builder-lib/scheme.json not found");
  } else {
    let Ajv = null;
    try {
      Ajv = require("ajv");
    } catch {
      /* reported by the assertion below */
    }
    // Without this the whole check would silently vanish, which is exactly the
    // blind spot that let the broken build ship in the first place.
    check("ajv is available to validate the build config", Boolean(Ajv));
    if (Ajv) {
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      let validate = null;
      try {
        validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
      } catch (err) {
        check("electron-builder schema compiles", false, err.message);
      }
      if (validate) {
        const ok = validate(pkg.build);
        const detail = ok
          ? ""
          : validate.errors
              .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
              .slice(0, 6)
              .join(" | ");
        check(
          "package.json build config satisfies the electron-builder schema",
          ok,
          detail,
        );
      }
    }
  }

  // The auto-update feed must never point at the parent project. Publishing is
  // enabled today and targets this fork's own releases (see docs/BUILD.md);
  // pointing it at OmniCoreST would let upstream binaries silently replace a
  // fork build, discarding every fix in this repo. This half is deliberately
  // permissive about *whether* publishing is enabled and strict about *where*
  // it points; the positive half below pins that it stays enabled.
  //
  // The first version of this check only looked at `p.owner`, which review
  // showed was easy to walk around. electron-builder accepts a provider
  // shorthand string ("github"), an object with no owner/repo at all, and a
  // combined `repo: "owner/name"` form; in every one of those cases it falls
  // back to `package.json.repository` to resolve the target. A `generic`
  // provider names the host in `url` instead. `publish` can also be set per
  // platform, not just at the root. All of those are covered below.
  {
    const PARENT = /(^|[/.:@-])omnicorest($|[/.:-])/i;
    const roots = [pkg.build && pkg.build.publish];
    for (const plat of ["win", "mac", "linux"]) {
      if (pkg.build && pkg.build[plat]) roots.push(pkg.build[plat].publish);
    }
    const repoUrl =
      (pkg.repository &&
        (typeof pkg.repository === "string"
          ? pkg.repository
          : pkg.repository.url)) ||
      "";
    const reasons = [];
    for (const root of roots) {
      if (root == null) continue;
      for (const p of [].concat(root)) {
        // Provider shorthand — target is resolved from package.json.repository.
        if (typeof p === "string") {
          if (PARENT.test(repoUrl)) {
            reasons.push(`"${p}" shorthand resolves via repository ${repoUrl}`);
          }
          continue;
        }
        if (!p || typeof p !== "object") continue;
        if (typeof p.owner === "string" && PARENT.test(p.owner)) {
          reasons.push(`owner ${p.owner}`);
          continue;
        }
        if (typeof p.repo === "string" && PARENT.test(p.repo)) {
          reasons.push(`repo ${p.repo}`);
          continue;
        }
        if (typeof p.url === "string" && PARENT.test(p.url)) {
          reasons.push(`url ${p.url}`);
          continue;
        }
        // No explicit target: electron-builder falls back to the repository
        // field, so this is only safe if that field is not the parent.
        if (!p.owner && !p.repo && !p.url && PARENT.test(repoUrl)) {
          reasons.push(
            `provider ${p.provider || "?"} resolves via repository ${repoUrl}`,
          );
        }
      }
    }
    check(
      "update feed does not point at the upstream parent repo",
      reasons.length === 0,
      reasons.length ? `publishes from ${reasons.join("; ")}` : "",
    );

    // Auto-update is now ENABLED, and the negative check above passes just as
    // happily when it is off - `publish: null` points at nobody, including the
    // parent. These assert the positive fact, so silently reverting to null
    // (which is where this started) fails rather than reading as compliant.
    const publishCfg = [].concat(pkg.build && pkg.build.publish ? pkg.build.publish : []);
    const github = publishCfg.filter(
      (p) => p && typeof p === "object" && p.provider === "github",
    );
    check(
      "auto-update publishes to this fork's own GitHub releases",
      github.length === 1 && github[0].owner === "lostinsea" && github[0].repo === "folia",
      `build.publish=${JSON.stringify(pkg.build && pkg.build.publish)} - electron-builder writes no app-update.yml without it, so installed builds can never see a release`,
    );

    // docs/BUILD.md prints the publish block as the configuration IN FORCE, and
    // prose is checked by nothing that runs. It drifted, exactly as you would
    // expect: the documented example still named the pre-rebrand repo
    // "markdown-viewer" long after package.json said "folia", while the
    // paragraph directly beneath it asserted the feed resolves to
    // lostinsea/folia. The document contradicted itself for releases on end and
    // nothing noticed, because the only reader was a human.
    //
    // The block count is asserted rather than assumed: "no example found" would
    // otherwise make this pass by having lost its subject, which is the same
    // fail-open shape this suite exists to refuse.
    {
      const buildDoc = path.join(ROOT, "docs", "BUILD.md");
      if (fs.existsSync(buildDoc)) {
        const doc = fs.readFileSync(buildDoc, "utf8");
        const blocks = [...doc.matchAll(/"publish"\s*:\s*\[([^\]]*)\]/g)].map((m) => m[0]);
        const owner = github.length === 1 ? github[0].owner : null;
        const repo = github.length === 1 ? github[0].repo : null;
        const wrong = blocks.filter(
          (b) => !(b.includes(`"owner": "${owner}"`) && b.includes(`"repo": "${repo}"`)),
        );
        check(
          "docs/BUILD.md documents the publish target package.json actually uses",
          blocks.length > 0 && wrong.length === 0,
          blocks.length === 0
            ? "no publish example found in docs/BUILD.md - the assertion has lost its subject"
            : `documented ${wrong.join(" | ")} but build.publish is owner=${owner} repo=${repo}`,
        );
      }
    }

    // Same disease, same document, a different paragraph. The restrictive-network
    // section spells the Electron download URL out literally, and the version
    // appears inside it twice - once as the release directory and once inside the
    // artifact filename. Those are DERIVED from the pinned Electron version, so an
    // Electron bump makes the documented URL name a release the build never asks
    // for, and a reader following it byte-for-byte gets a mirror layout that does
    // not match what @electron/get actually requests. The publish block above
    // drifted for releases on end for exactly this reason: prose has no reader
    // that runs.
    //
    // The count is asserted rather than assumed, for the same fail-open reason:
    // deleting the URL example would otherwise satisfy "no version is wrong".
    {
      const buildDoc = path.join(ROOT, "docs", "BUILD.md");
      if (fs.existsSync(buildDoc)) {
        const doc = fs.readFileSync(buildDoc, "utf8");
        const start = doc.indexOf("## Building behind a restrictive network");
        const end = start === -1 ? -1 : doc.indexOf("\n## ", start + 4);
        const section = start === -1 ? "" : doc.slice(start, end === -1 ? undefined : end);
        const declared = String(
          (pkg.devDependencies && pkg.devDependencies.electron) ||
            (pkg.dependencies && pkg.dependencies.electron) ||
            "",
        ).replace(/^[\^~>=<\s]+/, "");
        const cited = [...section.matchAll(/\bv(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]);
        const stale = [...new Set(cited.filter((v) => v !== declared))];
        check(
          "docs/BUILD.md's Electron mirror example cites the pinned Electron version",
          start !== -1 && cited.length >= 2 && declared !== "" && stale.length === 0,
          start === -1
            ? "the restrictive-network section is gone - the assertion has lost its subject"
            : cited.length < 2
              ? `only ${cited.length} version citation(s) in that section (expected the release dir and the artifact filename) - the assertion has lost its subject`
              : declared === ""
                ? "package.json declares no electron version to compare against"
                : `documents Electron ${stale.join(", ")} but package.json pins ${declared}`,
        );
      }
    }

    // Every build script must pass --publish never. electron-builder's default
    // is onTagOrDraft: with publish configured, a tag build inside the release
    // matrix would upload on all three legs at once, racing the create-release
    // job that is meant to be the single writer. This was invisible while
    // publish was null, because nothing could upload regardless.
    const buildScripts = Object.entries(pkg.scripts || {}).filter(([k, v]) =>
      /^build/.test(k) && /electron-builder/.test(v),
    );
    const unguarded = buildScripts.filter(([, v]) => !/--publish\s+never/.test(v)).map(([k]) => k);
    check(
      "every electron-builder script disables implicit publishing",
      buildScripts.length >= 4 && unguarded.length === 0,
      `${buildScripts.length} build scripts, ${unguarded.length} without --publish never: ${unguarded.join(", ")}`,
    );

    // Every Electron suite must run against an ISOLATED userData profile.
    //
    // The suites used to share ONE profile between them, and eight of them
    // require ../src/main.js, so main.js's "confirm-large-render" handler was
    // live in all eight and each opened a real window. A restored session
    // holding an expensive document reached dialog.showMessageBoxSync(), which
    // is modal IN THE MAIN PROCESS and so cannot be dismissed by any stub,
    // watchdog or renderer-side patch - the process that would run the rescue
    // is the process that is blocked. test-tab-refresh's own 260KB guard-big.md
    // fixture is persisted by saveTabs() the moment its tab is created, so a
    // killed run planted a landmine that stopped every LATER suite until a
    // human clicked. A/B measured: seeded profile hung with zero assertions,
    // empty profile finished 7/7 in 8s.
    //
    // THE REQUIRE MUST BE AT MODULE SCOPE. app.setPath("userData", ...) is
    // ignored once the app is ready, so an indented require - inside a
    // function, a ready handler or a try block - establishes nothing. That is
    // not hypothetical: test-render-patch.js reached the shared helper only
    // from inside `async function run(win)`, long after the window had loaded.
    // A check that accepted a require anywhere in the file would have passed
    // for that suite while it ran unisolated.
    //
    // This lives in the PACKAGING suite because it is a property of the test
    // estate as a whole - an eleventh suite added later is exactly what a
    // per-suite assertion cannot see.
    //
    // The floor is the MEASURED subject-set size (10), not a round number
    // below it. A floor with slack is satisfied by a sweep that has silently
    // stopped seeing part of its population - the same magic-number defect as
    // a licence guard demanding 200 entries against a real 220. R513 pins it
    // by moving one suite off the `electron` runner, which the old `>= 8`
    // waved through.
    const ISOLATION_AT_MODULE_SCOPE =
      /^(?:const\s+\w+\s*=\s*)?require\(["']\.\/test-userdata-isolation["']\);?\s*$/m;
    const electronSuites = Object.values(pkg.scripts || {})
      .flatMap((v) => [...v.matchAll(/electron\s+(test\/[\w.-]+\.js)/g)].map((m) => m[1]))
      .filter((v, i, a) => a.indexOf(v) === i);
    const unisolated = electronSuites.filter((rel) => {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return true;
      return !ISOLATION_AT_MODULE_SCOPE.test(fs.readFileSync(abs, "utf8"));
    });
    check(
      "every Electron test suite establishes an isolated userData profile",
      electronSuites.length >= 10 && unisolated.length === 0,
      `${electronSuites.length} suites; missing: ${unisolated.join(", ") || "none"}`,
    );

    // Every suite package.json REFERENCES must exist - for BOTH runners.
    //
    // The isolation sweep above derives its subject list from `electron
    // test/...`, so it structurally cannot see a suite run by plain `node`.
    // Two are: test-dev-profile.js and test-packaging.js. That gap is not
    // theoretical - test:migration -> test:profile was renamed with a `git mv`
    // in this repo, and had package.json been left pointing at the old path the
    // ONLY signal would have been a failed chain run, minutes in. A missing
    // file is a silent no-op for the npm script that names it.
    //
    // The node-only count is pinned rather than merely derived. This assertion
    // exists BECAUSE the electron-only pattern was too narrow, so a future edit
    // narrowing it back would shrink the subject set to exactly the population
    // that was already covered - passing while covering nothing new. That is
    // this file's recurring defect class: a subject list narrower than the
    // claim it supports.
    const referencedSuites = [
      ...new Set(
        Object.values(pkg.scripts || {}).flatMap((v) =>
          [...v.matchAll(/(electron|node)\s+(test\/[\w.-]+\.js)/g)].map((m) => m[2]),
        ),
      ),
    ];
    const nodeOnlySuites = referencedSuites.filter((rel) => !electronSuites.includes(rel));
    const missingSuites = referencedSuites.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
    check(
      "every test suite package.json names actually exists on disk",
      referencedSuites.length >= 12 && nodeOnlySuites.length >= 2 && missingSuites.length === 0,
      `${referencedSuites.length} referenced (${nodeOnlySuites.length} node-run); missing: ${missingSuites.join(", ") || "none"}`,
    );


    // that refusal it would silently no-op and every assertion above would keep
    // passing while the suites ran against a shared profile again - an absence
    // assertion failing open, the defect class this project keeps rediscovering.
    // The refusal is an explicit stderr-plus-exit rather than a throw: under
    // Electron a throw during load becomes dialog.showErrorBox, and a modal in
    // the process that is failing is a hang, not a failure. See the module's
    // own header, which records a 42-minute stall on exactly that.
    check(
      "the isolation module refuses to run after the app is ready",
      /app\.isReady\(\)/.test(
        fs.readFileSync(path.join(ROOT, "test", "test-userdata-isolation.js"), "utf8"),
      ),
    );

    // Auto-update exists for the packaged app only if an app-update.yml is
    // packed beside it, and electron-builder writes that file ONLY when an
    // NSIS (or updater-aware appx) target is part of the build - read out of
    // app-builder-lib's own isSuitableWindowsTarget(), not assumed. A
    // portable-only build therefore ships an app that cannot check for
    // updates at all, silently, while main.js still carries a whole portable
    // update-install path (the temp batch script) that can never be reached.
    //
    // `npm run build` is exactly such a build, which is why the artefact-level
    // assertion further down has to state its precondition instead of reading
    // whichever target happened to run last. THIS assertion is the
    // order-independent half: whatever the release workflow runs must include
    // an auto-updatable target.
    const workflowPath = path.join(ROOT, ".github", "workflows", "release.yml");
    if (fs.existsSync(workflowPath)) {
      const wf = fs.readFileSync(workflowPath, "utf8");
      const winScripts = [...wf.matchAll(/run:\s*npm run (build[\w-]*)/g)]
        .map((m) => m[1])
        .filter((s) => /electron-builder --win/.test((pkg.scripts || {})[s] || ""));
      const updatable = winScripts.filter((s) => {
        const cmd = pkg.scripts[s];
        // `--win` with no target list builds the configured win.target set.
        // The negative lookahead matters: without it `--win --publish never`
        // parses "--publish" as a target list (a `-` inside the character
        // class), and a correctly configured build reads as having no nsis
        // target at all.
        const explicit = cmd.match(/--win\s+(?!-)([\w,-]+)/);
        const targets = explicit
          ? explicit[1].split(",")
          : [].concat((pkg.build && pkg.build.win && pkg.build.win.target) || []);
        return targets.some((t) => /^nsis/.test(typeof t === "string" ? t : t.target || ""));
      });
      check(
        "the Windows release build includes an auto-updatable target",
        winScripts.length > 0 && updatable.length === winScripts.length,
        `release.yml runs ${winScripts.join(", ") || "no Windows build"}; ` +
          `${updatable.length} of ${winScripts.length} include an nsis target - ` +
          "without one electron-builder writes no app-update.yml and the " +
          "shipped app can never check for updates",
      );
    }
  }

  // scripts/post-upstream-merge.sh re-pins Electron with `npm pkg set`. If that
  // pin ever drifts below what package.json actually declares, running the
  // script — which the docs tell you to do after every upstream merge —
  // silently DOWNGRADES Electron and reintroduces the advisories the upgrade
  // cleared. Nothing else in the repo ties these two numbers together.
  {
    const scriptPath = path.join(ROOT, "scripts", "post-upstream-merge.sh");
    const declared =
      (pkg.devDependencies && pkg.devDependencies.electron) || "";
    if (!fs.existsSync(scriptPath)) {
      check("post-upstream-merge.sh exists to be checked", false);
    } else {
      const script = fs.readFileSync(scriptPath, "utf8");
      const m = script.match(/npm pkg set devDependencies\.electron="([^"]+)"/);
      check(
        "post-upstream-merge.sh pins an Electron version",
        Boolean(m),
        m ? "" : "no `npm pkg set devDependencies.electron=` line found",
      );
      if (m) {
        check(
          "post-upstream-merge.sh cannot downgrade Electron",
          m[1] === declared,
          m[1] === declared
            ? ""
            : `script pins ${m[1]} but package.json declares ${declared}`,
        );
      }
    }
  }

  // The same script asserts about two dozen OTHER things about this tree, and
  // nothing tied any of them to it. One had rotted into the exact OPPOSITE of
  // the truth: it required an `app-title` element inside a `#logoLink` in
  // index.html, when the header was deliberately redesigned down to the
  // hamburger alone. Two oracles pin that absence - the `.app-title` check
  // further down this file, and test-tab-refresh.js asserting appTitle ===
  // false and logoLink === false in the live DOM. So a maintainer following
  // the script's own printed instruction would have re-added markup and failed
  // the suite on the very next run. Two of this repo's checks disagreed with
  // each other for as long as both existed.
  //
  // Parse the script's expectations and hold them against the tree. The
  // ABSENCE family is the dangerous half and is covered too: a
  // check_html_absent naming something that was never coming back reads as a
  // pass forever, so it is only worth anything while the parse that finds it
  // is known to be finding things at all. Hence the count floors below, which
  // are the MEASURED counts with no slack - a floor with room to spare would
  // let the parse quietly stop seeing checks and still report success.
  {
    const scriptPath = path.join(ROOT, "scripts", "post-upstream-merge.sh");
    const htmlPath = path.join(ROOT, "src", "index.html");
    if (fs.existsSync(scriptPath) && fs.existsSync(htmlPath)) {
      const script = fs.readFileSync(scriptPath, "utf8");
      const html = fs.readFileSync(htmlPath, "utf8");
      const buildFiles = ((pkg.build && pkg.build.files) || []).filter(
        (f) => typeof f === "string",
      );

      const calls = (re) => [...script.matchAll(re)].map((m) => m[1]);
      // The helper DEFINITIONS (`check_line() {`) cannot match these: every
      // pattern requires whitespace then a quote where the definition has `()`.
      const lineChecks = calls(
        /^check_line\s+"\$ROOT\/src\/index\.html"\s+'([^']*)'/gm,
      );
      const scriptTags = calls(/^check_html_script\s+"([^"]+)"/gm);
      const absentTags = calls(/^check_html_absent\s+"([^"]+)"/gm);
      const buildChecks = calls(/^check_build_file\s+"([^"]+)"/gm);

      check(
        "post-upstream-merge.sh checks are still parseable",
        lineChecks.length >= 6 &&
          scriptTags.length >= 4 &&
          absentTags.length >= 1 &&
          buildChecks.length >= 10,
        `parsed ${lineChecks.length} check_line (need 6), ` +
          `${scriptTags.length} check_html_script (need 4), ` +
          `${absentTags.length} check_html_absent (need 1), ` +
          `${buildChecks.length} check_build_file (need 10) - ` +
          "a reformat that breaks this parse would silently disarm every " +
          "assertion below it",
      );

      // grep semantics: the pattern is a BRE, but every one of them is a plain
      // literal today. Accept either reading so a future regex pattern is not
      // reported as a false failure, and so a literal containing `.` is not
      // matched loosely by accident.
      const matches = (hay, pat) => {
        if (hay.includes(pat)) return true;
        try {
          return new RegExp(pat).test(hay);
        } catch {
          return false;
        }
      };

      const missingLine = lineChecks.filter((p) => !matches(html, p));
      check(
        "post-upstream-merge.sh index.html checks all still match",
        missingLine.length === 0,
        missingLine.length === 0
          ? `${lineChecks.length} checked; all present`
          : `${missingLine.length} of ${lineChecks.length} no longer match ` +
            `index.html: ${missingLine.join(", ")} - the script would tell a ` +
            "maintainer to re-add something this repo has removed",
      );

      const missingTag = scriptTags.filter(
        (s) => !html.includes(`src="${s}"`),
      );
      check(
        "post-upstream-merge.sh required script tags are all loaded",
        missingTag.length === 0,
        missingTag.length === 0
          ? `${scriptTags.length} checked; all loaded`
          : `not loaded by index.html: ${missingTag.join(", ")}`,
      );

      const resurrected = absentTags.filter((s) => html.includes(`src="${s}"`));
      check(
        "post-upstream-merge.sh forbidden script tags are still absent",
        resurrected.length === 0,
        resurrected.length === 0
          ? `${absentTags.length} checked; all absent`
          : `back in index.html: ${resurrected.join(", ")}`,
      );

      const missingBuild = buildChecks.filter(
        (f) => !buildFiles.some((b) => b.includes(f)),
      );
      check(
        "post-upstream-merge.sh build.files checks all still match",
        missingBuild.length === 0,
        missingBuild.length === 0
          ? `${buildChecks.length} checked; all declared`
          : `absent from build.files: ${missingBuild.join(", ")}`,
      );
    }
  }

  // F32: for as long as this repository had CI, CI never ran a windowed test.
  // release.yml triggers only on a `v*` tag or a manual dispatch, and its one
  // test step is `npm run test:packaging` - a suite that runs under plain node.
  // The ten suites that drive real BrowserWindows, including every
  // render-security regression test, ran only where someone remembered to run
  // them. ci.yml now runs the whole chain on push and pull request.
  //
  // Asserted as COVERAGE rather than existence: "some workflow mentions
  // electron somewhere" would be satisfied by a single token suite, which is
  // the shape this defect would take if it came back. So resolve what the
  // workflows actually invoke - transitively, because `npm test` is a chain of
  // `npm run` calls - and require the reachable set to be the WHOLE set, with
  // no slack. The two positive controls exist because both halves are counts
  // derived by regex: if either parse silently stopped matching, an empty set
  // would agree with an empty set and this would pass having checked nothing.
  {
    const scripts = pkg.scripts || {};
    const SUITE_RE = /electron\s+(test\/[\w.-]+\.js)/g;

    const declared = new Set();
    for (const body of Object.values(scripts)) {
      for (const m of String(body).matchAll(SUITE_RE)) declared.add(m[1]);
    }

    const reachable = new Set();
    const walk = (name, seen) => {
      if (seen.has(name) || !scripts[name]) return;
      seen.add(name);
      const body = String(scripts[name]);
      for (const m of body.matchAll(SUITE_RE)) reachable.add(m[1]);
      // `npm test`, `npm run test:tabs`, `npm run build-all` all land here.
      for (const m of body.matchAll(/npm\s+(?:run\s+)?([\w:-]+)/g)) {
        walk(m[1], seen);
      }
    };

    // NOTE FOR EDITORS: these locals are deliberately NOT named wfDir/wfFiles.
    // The devDependency-evidence scan earlier in this file already declares a
    // wfDir bound to the same workflows directory, and R488 anchors on that
    // exact line - so a second identical declaration here makes the anchor
    // ambiguous and R488 reports SETUP-FAILED rather than proving anything.
    // For the same reason, do not spell that declaration out verbatim in a
    // comment: the harness matches raw text, so a quoted copy collides too.
    const ciWorkflowDir = path.join(ROOT, ".github", "workflows");
    const ciWorkflowFiles = fs.existsSync(ciWorkflowDir)
      ? fs.readdirSync(ciWorkflowDir).filter((f) => /\.ya?ml$/i.test(f))
      : [];
    let invocations = 0;
    for (const f of ciWorkflowFiles) {
      const text = fs.readFileSync(path.join(ciWorkflowDir, f), "utf8");
      for (const m of text.matchAll(/run:\s*(?:npx\s+)?npm\s+(?:run\s+)?([\w:-]+)/g)) {
        invocations++;
        walk(m[1], new Set());
      }
    }

    check(
      "the workflows invoke npm scripts this assertion can follow",
      ciWorkflowFiles.length > 0 && invocations > 0,
      `${ciWorkflowFiles.length} workflow file(s) [${ciWorkflowFiles.join(", ")}], ` +
        `${invocations} npm invocation(s) parsed - zero of either would make ` +
        "the coverage check below vacuous",
    );
    check(
      "package.json declares Electron suites for CI to run",
      declared.size >= 10,
      `${declared.size} suites matched \`electron test/*.js\` (expected at ` +
        "least the 10 windowed suites)",
    );

    const uncovered = [...declared].filter((s) => !reachable.has(s)).sort();
    check(
      "CI runs every Electron test suite, not just the node-only ones",
      uncovered.length === 0,
      uncovered.length === 0
        ? `${reachable.size} of ${declared.size} Electron suites reachable from the workflows`
        : `${uncovered.length} of ${declared.size} never run in CI: ${uncovered.join(", ")} - ` +
          "these are the suites that drive real windows, so a regression in " +
          "them would reach a release unopposed",
    );
  }

  // The revert harness has TWO read-only audits and one destructive mode, and
  // CI ran only the first audit. `--anchors` proves the text a record perturbs
  // still exists; `--expects` proves the assertion NAMES it pairs with still
  // exist. Only the second can catch a renamed assertion, and an orphaned
  // `mustPass` is unfalsifiable by construction - it can never match, so the
  // COLLATERAL guard can never fire and the record reports PROVEN with its
  // guard gone. Both audits belong in CI; the destructive mode - which rewrites
  // the working tree and is machine-exclusive - must never be run there, and a
  // workflow that started doing so would corrupt whatever else that runner was
  // building. Asserted in both directions for that reason.
  //
  // NOTE FOR EDITORS: these locals are deliberately not named wfDir/wfFiles or
  // ciWorkflowDir/ciWorkflowFiles - two identical declarations in this file
  // make an existing revert record's anchor ambiguous. See R488 above.
  {
    const auditWorkflowDir = path.join(ROOT, ".github", "workflows");
    const auditWorkflowFiles = fs.existsSync(auditWorkflowDir)
      ? fs.readdirSync(auditWorkflowDir).filter((f) => /\.ya?ml$/i.test(f))
      : [];
    const harnessRuns = [];
    for (const f of auditWorkflowFiles) {
      const text = fs.readFileSync(path.join(auditWorkflowDir, f), "utf8");
      for (const m of text.matchAll(
        /run:\s*(?:npx\s+)?node\s+scripts\/prove-table-fixes\.js([^\r\n]*)/g,
      )) {
        harnessRuns.push({ file: f, flags: m[1].trim() });
      }
    }
    // Positive control for both assertions below: they are counts derived by
    // regex, and an empty set agrees with an empty set. If this parse ever
    // stopped matching, "no mutating run" would pass having read nothing.
    check(
      "the workflows invoke the revert harness in a form this assertion can read",
      auditWorkflowFiles.length > 0 && harnessRuns.length > 0,
      `${auditWorkflowFiles.length} workflow file(s), ${harnessRuns.length} ` +
        `prove-table-fixes.js invocation(s) parsed: ` +
        JSON.stringify(harnessRuns),
    );
    check(
      "CI audits every expect/mustPass regex, not just the anchors",
      harnessRuns.some((run) => /(^|\s)--expects(\s|$)/.test(run.flags)) &&
        harnessRuns.some((run) => /(^|\s)--anchors(\s|$)/.test(run.flags)),
      `revert-harness invocations: ${JSON.stringify(harnessRuns)} - both ` +
        "--anchors and --expects are required; anchors alone cannot see a " +
        "renamed assertion, and an orphaned mustPass reports PROVEN forever",
    );
    const mutating = harnessRuns.filter(
      (run) => !/(^|\s)--(anchors|expects)(\s|$)/.test(run.flags),
    );
    check(
      "no workflow runs the revert harness in its tree-rewriting mode",
      mutating.length === 0,
      mutating.length === 0
        ? `${harnessRuns.length} invocation(s), all read-only`
        : `${mutating.length} mutating invocation(s): ${JSON.stringify(mutating)} - ` +
          "the harness rewrites the working tree of the checkout it runs in, so " +
          "everything built afterwards in that job would be built from reverted source",
    );
  }

  // F21: DevTools is a Node REPL while the renderer runs nodeIntegration: true,
  // and main.js bound it to F12 in EVERY build with no gate at all. The
  // accelerator half of that surface is asserted behaviourally by
  // test-render-security.js ("no default application menu survives startup");
  // this is the half no behavioural test can reach, because flipping
  // app.isPackaged to true requires an actual packaged build.
  //
  // Checked as SHAPE, deliberately narrowly: the gate must wrap the call, not
  // merely exist somewhere in the file. An `if (devToolsAllowed())` sitting
  // anywhere would satisfy a looser regex while the toggle stayed
  // unconditional.
  {
    const main = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
    const toggles = (main.match(/toggleDevTools\s*\(/g) || []).length;
    check(
      "main.js has exactly one DevTools toggle to guard",
      toggles === 1,
      `${toggles} toggleDevTools( call sites - the gate below only covers one`,
    );
    check(
      "the DevTools toggle is behind the packaged-build gate",
      /if\s*\(\s*devToolsAllowed\(\)\s*\)\s*\{[^}]*toggleDevTools\s*\(/.test(main),
      "toggleDevTools() is not wrapped in `if (devToolsAllowed())` - a shipped " +
        "build would hand a Node console to anyone at the keyboard",
    );
    // And the gate has to consult something a shipped build actually changes.
    // `function devToolsAllowed() { return true; }` would pass the check above.
    const body = main.match(/function devToolsAllowed\(\)\s*\{([\s\S]*?)\n\}/);
    check(
      "the DevTools gate is defined and reads app.isPackaged",
      Boolean(body) && /app\.isPackaged/.test(body[1]),
      body
        ? `devToolsAllowed() body does not mention app.isPackaged: ${JSON.stringify(body[1].trim().slice(0, 120))}`
        : "no devToolsAllowed() definition found",
    );
    // The per-window control the accelerator measurement pinned. Every window
    // this app opens must drop its menu; main.js's is the one that matters
    // because it is the only window with Node integration.
    check(
      "the main window drops its menu bar, which suppresses the DevTools accelerator",
      /mainWindow\.setMenu\(null\)/.test(main),
      "mainWindow.setMenu(null) is gone - measured to re-enable Ctrl+Shift+I",
    );
  }

  // The README states the Electron version in several places. Nothing tied
  // those numbers to package.json, and they DID rot: the badge and the macOS
  // fix table said 37, the tech-stack list still said 27, and the description
  // of post-upstream-merge.sh claimed it re-pins to ^37 while the script
  // actually pins ^43. A reader following that text would conclude the fork
  // ships a runtime three majors older than it does, with the security
  // advisories that implies.
  //
  // The claim SHAPES are rewritten whenever the README is, and three of the
  // four were invalidated by the Folia rewrite - which the suite reported as
  // four named failures rather than silently checking nothing, because a
  // missing match is a failure here and not a skip. That is the property worth
  // preserving: these must be re-pointed by hand at each rewrite.
  {
    const declared =
      (pkg.devDependencies && pkg.devDependencies.electron) || "";
    const wantMajor = (declared.match(/(\d+)/) || [])[1];
    const readme = read("README.md");
    const claims = [
      ["what-changed summary", /Electron upgraded to (\d+)/],
      ["tech-stack table row", /\|\s*Electron\s*\|\s*(\d+)/],
      ["install-notes prose", /Electron (\d+) downloads its binary lazily/],
    ];
    check(
      "package.json declares an Electron version to check the README against",
      Boolean(wantMajor),
      declared,
    );
    for (const [where, re] of claims) {
      const m = readme.match(re);
      check(
        `README ${where} states the Electron major this fork actually ships`,
        Boolean(m) && m[1] === wantMajor,
        m
          ? `README says ${m[1]}, package.json declares ${declared}`
          : `no match for ${re} - claim removed or reworded, so it is no longer checked`,
      );
    }
  }

  // The README describes a POLICY - editing is edit-mode only, notes are the
  // one exception and save themselves - and a policy described in prose rots
  // the moment the mechanism behind it moves. This is the same defect class as
  // the Electron version claims above, with a worse failure: a reader who is
  // told the document is read-only in view mode, and is wrong, edits a file
  // they believed they were only reading.
  //
  // WHAT THIS PAIR IS, HONESTLY. The behavioural oracle for all three policies
  // already exists and is not here: test-render-patch.js dispatches real
  // contextmenu events in both modes and measures OBSERVED visibility, and
  // drives the real note dialogs with disk bytes as the oracle. This suite is
  // not windowed, so it cannot do that. What it adds is the LINK between the
  // shipped prose and the mechanism named in it - the axis the behavioural
  // suite cannot see, because a test that drives the product is blind to the
  // README drifting away from it.
  //
  // THE MECHANISM HALVES ARE STRUCTURAL, NOT SUBSTRING MATCHES, and that
  // distinction was earned: a reviewer measured the first version and found two
  // of the three could not fail. `/autoSaveViewModeNote\(\)/` matched four
  // lines, of which one was a COMMENT and one the function's own definition, so
  // deleting both call sites - i.e. actually breaking auto-save - left it
  // green. `/function editOnlyAlwaysVisibleItems\(\)/` matched the definition
  // alone, so emptying the returned list left it green. Each mechanism half now
  // parses the function it names and asserts something the disabled version
  // could not satisfy: the gate call must be a live statement inside
  // showContextMenu (not commented out, not a stray reference elsewhere), the
  // gate's item list must actually name the eight controls the README
  // enumerates, and auto-save must have at least two live call sites.
  //
  // A reworded or deleted claim is a FAILURE, not a skip - otherwise rewriting
  // the section silently switches the check off, which is exactly what happened
  // to three of the four Electron claims.
  {
    const readme = read("README.md");
    const rendererSrc = read("src/renderer.js");
    // Brace-matched body extraction. Substring searches over a 9000-line file
    // cannot distinguish a definition from a call from a mention in a comment,
    // which is the whole reason the first version of these oracles was weak.
    const bodyOf = (src, signature) => {
      const start = src.indexOf(signature);
      if (start < 0) return null;
      let i = src.indexOf("{", start);
      if (i < 0) return null;
      let depth = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") {
          depth--;
          if (depth === 0) return src.slice(i + 1, j);
        }
      }
      return null;
    };
    // Lines that are entirely a `//` comment are not mechanism.
    const liveLines = (body) =>
      String(body || "")
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*)/.test(l));

    const gateCallIsLive = (src) => {
      const body = bodyOf(src, "function showContextMenu(");
      return liveLines(body).some((l) => /^\s*applyEditModeMenuGating\(\);\s*$/.test(l));
    };
    // Exactly the controls the README bullet enumerates, so the prose and the
    // list close the loop on each other.
    const GATED_ITEMS = [
      "ctxBold", "ctxItalic", "ctxCode", "ctxList",
      "ctxRemoveFormat", "ctxInsertImage", "ctxInsertMermaid", "ctxInsertTable",
    ];
    const gateOwnsTheItems = (src) => {
      const body = liveLines(bodyOf(src, "function editOnlyAlwaysVisibleItems(")).join("\n");
      return GATED_ITEMS.every((id) => body.includes(id));
    };
    const autoSaveIsWired = (src) => {
      const defStart = src.indexOf("function autoSaveViewModeNote(");
      const calls = liveLines(src).filter(
        (l) => /autoSaveViewModeNote\(\)/.test(l) && !/^\s*function /.test(l),
      );
      return defStart >= 0 && calls.length >= 2;
    };

    const claims = [
      [
        "states that document editing is confined to edit mode",
        /In view mode the document is read-only/,
        "the context menu is gated on edit mode",
        gateCallIsLive,
      ],
      [
        "names the inline formatting commands as edit-mode only",
        /\*\*Edit mode only\*\*[^\n]*inline formatting/,
        "the gate owns those items and restores them in edit mode",
        gateOwnsTheItems,
      ],
      [
        "promises a view-mode note is written to the file immediately",
        /a note made in view mode is written to the file as soon as you confirm it/,
        "the note commit helpers auto-save",
        autoSaveIsWired,
      ],
    ];
    for (const [what, readmeRe, mechanism, mechanismFn] of claims) {
      check(
        `the README ${what}`,
        readmeRe.test(readme),
        `no match for ${readmeRe} - claim removed or reworded, so it is no longer checked`,
      );
      check(
        `...and ${mechanism}, so that claim is still true`,
        mechanismFn(rendererSrc) === true,
        `the mechanism named by this claim is no longer live in renderer.js`,
      );
    }
  }

  // Three README claims about things that live in package.json and index.html
  // rather than in renderer.js, all three of which were WRONG when a reviewer
  // measured them against the build configuration:
  //
  //  - the file-associations sentence promised the installer registers all
  //    seven supported extensions; it registers three;
  //  - the download table listed three artefacts out of five, silently hiding
  //    the Windows portable build and the macOS dmg that release.yml publishes;
  //  - the right-click bullet offered "insert / edit / delete ... images", and
  //    there is no image-edit control anywhere in the app.
  //
  // All three are the same shape: prose describing a MACHINE-READABLE fact that
  // nothing compared it against. So the oracle is the build config itself,
  // never a second copy of the sentence.
  {
    const readme = read("README.md");
    const indexSrc = read("src/index.html");

    const winAssoc = ((pkg.build.win || {}).fileAssociations || []).map((a) => a.ext).sort();
    check(
      "the build declares the file associations the README's claim is checked against",
      winAssoc.length > 0,
      JSON.stringify(winAssoc),
    );
    // The README names them inline, so the comparison is against the sentence a
    // reader actually reads rather than against a list maintained beside it.
    const claimed = (readme.match(/The installer registers Folia as a handler for ([^\n]+?)\n/) || [])[1] || "";
    const claimedExts = [...claimed.matchAll(/`\.([a-z]+)`/g)].map((m) => m[1]).sort();
    check(
      "the README names exactly the extensions the installer actually registers",
      claimedExts.length === winAssoc.length
        && claimedExts.every((e, i) => e === winAssoc[i]),
      JSON.stringify({ readme: claimedExts, build: winAssoc }),
    );

    // THE THEMES BULLET NAMES SIX SCHEMES BY LABEL, and a label is exactly the
    // kind of claim that goes stale silently: adding a seventh scheme, renaming
    // one, or dropping one all leave the sentence reading perfectly while
    // describing a product that no longer exists. This is the same disease the
    // shortcut table had - a reader tests it in seconds and it is wrong.
    // The oracle is the REGISTRY in src/custom-theme.js, never a second copy of
    // the list maintained beside the assertion.
    const themeSrc = read("src/custom-theme.js");
    const schemeLabels = [...themeSrc.matchAll(/\blabel:\s*"([^"]+)",\s*mode:\s*"(?:light|dark)"/g)]
      .map((m) => m[1]);
    check(
      "the theme registry declares the schemes the README's claim is checked against",
      schemeLabels.length >= 6,
      JSON.stringify(schemeLabels),
    );
    const themesBullet = (readme.match(/^- \*\*Themes\*\*[^\n]+$/m) || [])[0] || "";
    const undocumented = schemeLabels.filter(
      (l) => !new RegExp(`\\b${l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(themesBullet),
    );
    check(
      "the README names every colour scheme the theme menu actually offers",
      themesBullet !== "" && undocumented.length === 0,
      themesBullet === ""
        ? "the Themes bullet was reworded or removed, so nothing is being checked"
        : `undocumented: ${JSON.stringify(undocumented)}`,
    );

    // Every artefact the release workflow publishes has to appear in the
    // download table, or a reader concludes their platform is unsupported.
    const targets = []
      .concat((pkg.build.win || {}).target || [])
      .concat((pkg.build.mac || {}).target || [])
      .concat((pkg.build.linux || {}).target || [])
      .map((t) => (typeof t === "string" ? t : t.target));
    const TABLE_EVIDENCE = {
      nsis: /Folia-Setup-X\.X\.X\.exe/,
      portable: /\| Windows \| `Folia X\.X\.X\.exe`/,
      dmg: /Folia-X\.X\.X\.dmg/,
      AppImage: /Folia-X\.X\.X\.AppImage/,
      deb: /folia_X\.X\.X_amd64\.deb/,
    };
    check(
      "every build target is one the download-table check knows how to look for",
      targets.every((t) => TABLE_EVIDENCE[t]),
      JSON.stringify(targets),
    );
    const missingRows = targets.filter((t) => TABLE_EVIDENCE[t] && !TABLE_EVIDENCE[t].test(readme));
    check(
      "the README's download table lists every artefact the release publishes",
      missingRows.length === 0,
      JSON.stringify({ missing: missingRows, targets }),
    );

    // The image half of the right-click bullet. There is an insert control and
    // a delete control and no edit control, so the day someone adds one this
    // fires and the bullet gets updated in the same change - which is the only
    // moment anybody would remember to.
    check(
      "the app still has no image-edit control, as the right-click bullet now says",
      !/ctxEditImage/.test(indexSrc) && /ctxDeleteImage/.test(indexSrc) && /ctxInsertImage/.test(indexSrc),
      "an image control was added or removed without the README bullet moving with it",
    );

    // "The Mermaid and table dialogs are resizable" - named rather than
    // generalised, because the note, find-note and edit-text dialogs are NOT.
    // Asserted as an exact set so widening the CSS without widening the prose
    // fails, and so does the reverse.
    const resizable = [...read("src/styles.css").matchAll(/([^\n{}]+)\{[^}]*resize:\s*both[^}]*\}/g)]
      .map((m) => m[1].trim())
      .sort();
    check(
      "exactly the two dialogs the README names are the resizable ones",
      resizable.length === 2
        && resizable[0] === ".mermaid-template-dialog"
        && resizable[1] === ".table-insert-dialog",
      JSON.stringify(resizable),
    );
    check(
      "the README names those two dialogs rather than claiming all dialogs resize",
      /The Mermaid and table dialogs are resizable/.test(readme),
      "the dialog-resize claim was reworded, so it is no longer checked",
    );
  }

  // ==========================================================================
  // THE SHIPPED VERSION TABLE
  // ==========================================================================
  // README.md ships inside the installer through extraResources and the in-app
  // welcome button opens it, so the `## Technology` table is a statement the
  // PRODUCT makes about which versions of its dependencies the reader is
  // running. Measured before this oracle existed: FIVE of the six versioned
  // rows were stale, three of them by a whole minor. Nothing had ever compared
  // them against anything, so the table was written once and then drifted
  // through every dependency bump - the same disease as the four false
  // keyboard-shortcut rows and the three-of-five download table above.
  //
  // Every row's truth comes from an INDEPENDENT source, never from a second
  // copy of the number maintained beside the assertion:
  //  - npm-sourced components resolve through package-lock.json. The RESOLVED
  //    version is the one that ships; package.json carries CARET RANGES, so
  //    reading it would compare the README against a range rather than against
  //    a version and would go green on a table that names no shipped release.
  //  - Tabulator is HAND-VENDORED. It is absent from package.json entirely, so
  //    it is invisible to `npm audit`, `npm outdated` and Dependabot alike, and
  //    the only statement of its version anywhere in this tree is the banner at
  //    the top of the bundle it ships as.
  //  - Fira Code vendors as five .ttf files that carry no version at all, so a
  //    dash is the honest cell. That is ASSERTED rather than skipped, so the
  //    row cannot quietly acquire an invented number.
  //
  // EXHAUSTIVE BY CONSTRUCTION: a row this block does not recognise FAILS. A
  // seventh component therefore cannot be added to the table and left unchecked
  // by omission, which is the failure mode of any hand-maintained row list.
  {
    // EOL-NORMALISED FOR PARSING ONLY. README.md is CRLF in the working tree
    // (`.gitattributes` normalises it on the way in), so a `"\n## Technology\n"`
    // needle finds nothing and every check below then passes VACUOUSLY on zero
    // rows. Measured: that is exactly what this block's first run did, and the
    // row floor two assertions down is what caught it.
    const readme = read("README.md").replace(/\r\n/g, "\n");

    // A PARSER WITH NO END MARKER REPORTS ON TEXT NOBODY CLAIMED IT WAS
    // READING - recorded when the keyboard-shortcut parser ran on into the
    // provenance table 200 lines later and classified "Electron" as a shortcut.
    // Bounded at the next heading, and the bound is asserted rather than
    // assumed.
    const secAt = readme.indexOf("\n## Technology\n");
    const tail = secAt === -1 ? "" : readme.slice(secAt + 1);
    const endAt = tail.indexOf("\n## ", 1);
    const section = endAt === -1 ? tail : tail.slice(0, endAt);
    check(
      "the README's Technology section was located and bounded at the next heading",
      secAt !== -1 && /^## Technology\n/.test(section) && section.indexOf("\n## ", 1) === -1,
      secAt === -1
        ? "no `## Technology` heading - the section was renamed, so nothing is being checked"
        : `${section.length} chars, ends: ${JSON.stringify(section.slice(-40))}`,
    );

    const rows = [...section.matchAll(/^\| *([^|\n]+?) *\| *([^|\n]+?) *\| *([^|\n]+?) *\|$/gm)]
      .map((m) => ({ component: m[1], version: m[2], role: m[3] }))
      .filter((r) => r.component !== "Component" && !/^-+$/.test(r.component));
    check(
      "the version table really parsed, so the checks below have subjects",
      rows.length >= 7,
      `${rows.length} row(s): ${JSON.stringify(rows.map((r) => r.component))}`,
    );

    const lockPkgs = JSON.parse(read("package-lock.json")).packages || {};
    const lockVersion = (name) => ((lockPkgs["node_modules/" + name] || {}).version || "");

    const tabBanner = ((read("libs/tabulator/tabulator.min.js").slice(0, 400)
      .match(/Tabulator v(\d+\.\d+\.\d+)/) || [])[1] || "");
    check(
      "the vendored Tabulator bundle declares the version its README row is checked against",
      /^\d+\.\d+\.\d+$/.test(tabBanner),
      tabBanner || "no version banner at the head of libs/tabulator/tabulator.min.js",
    );

    const TRUTH = {
      Electron: () => lockVersion("electron"),
      marked: () => lockVersion("marked"),
      Mermaid: () => lockVersion("mermaid"),
      DOMPurify: () => lockVersion("dompurify"),
      PrismJS: () => lockVersion("prismjs"),
      Tabulator: () => tabBanner,
      // Five .ttf files under assets/fonts/, no version anywhere in any of them.
      "Fira Code": () => "-",
    };

    const unclassified = rows.filter((r) => !TRUTH[r.component]);
    check(
      "every row in the shipped version table is one this oracle knows how to verify",
      unclassified.length === 0,
      JSON.stringify(unclassified.map((r) => r.component)),
    );

    // THE CAUSE IS ASSERTED BESIDE THE CONSEQUENCE. A mistyped package name
    // resolves to the empty string, which would fail the comparison below with
    // an evidence line naming the README rather than the lookup that broke.
    const known = rows.filter((r) => TRUTH[r.component]);
    const unresolved = known.filter((r) => TRUTH[r.component]() === "");
    check(
      "every version this oracle checks against was resolved from a real source",
      unresolved.length === 0,
      JSON.stringify(unresolved.map((r) => r.component)),
    );

    const stale = known
      .map((r) => ({ component: r.component, readme: r.version, ships: TRUTH[r.component]() }))
      .filter((r) => r.readme !== r.ships);
    check(
      "every version the shipped README claims is the version that actually ships",
      stale.length === 0,
      JSON.stringify(stale),
    );
  }

  // ==========================================================================
  // PRODUCT IDENTITY
  // ==========================================================================
  // The 1.0 rebrand replaced the upstream vendor's identity with this project's
  // own. These are not cosmetic assertions: `appId` and the app name decide the
  // Windows install target, the single-instance lock and, through Electron's
  // userData path, where the user's recent-file list and tab session live.
  // Silently drifting back to the old identity would strand user data and point
  // installs at the vendor's namespace.
  {
    check(
      "package.json declares a productName, so Electron and the installer agree on the app name",
      pkg.productName === "Folia",
      `productName=${JSON.stringify(pkg.productName)}`,
    );
    check(
      "package name matches the product",
      pkg.name === "folia",
      `name=${JSON.stringify(pkg.name)}`,
    );

    // build.productName, not root productName, is what electron-builder uses
    // to name the executable, the Program Files directory and the Add/Remove
    // Programs entry (it resolves build.productName || productName || name).
    // The two are separate keys, so renaming the root one alone produced a
    // build whose RUNTIME called itself Folia while the INSTALLER still called
    // itself Markdown Viewer. Pinned explicitly rather than left to the
    // vendor-mark sweep below, which only looks for the vendor's name.
    check(
      "build.productName names the installer, so the installed app is not the old name",
      pkg.build && pkg.build.productName === "Folia",
      `build.productName=${JSON.stringify(pkg.build && pkg.build.productName)}`,
    );

    // The name a USER SEES. index.html once carried a full `.app-title` in the
    // header AND an abbreviated `.app-title-short` shown by the compact header
    // below 780px, and the abbreviation still read "MV" - Markdown Viewer.
    // It survived the rename because a two-letter string in markup is not
    // something anyone greps for, which is the argument for deriving the
    // assertion from package.json rather than hard-coding "Folia" again here:
    // a fourth copy checked against a third copy proves only that two files
    // agree.
    //
    // The single-row header redesign DELETED the in-header title outright, so
    // the assertion that the header shows the product name has been retired
    // rather than left to rot against an element that no longer exists. The
    // product name now reaches the user through <title> alone (window frame and
    // taskbar), which is exactly why that assertion is the one that stays - it
    // went from a second line of defence to the only one. The "no abbreviated
    // copy" assertion is kept and WIDENED: with no header title at all, neither
    // spelling may come back.
    {
      const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
      const productName = (pkg.build && pkg.build.productName) || pkg.productName;
      const titleTag = /<title>([^<]*)<\/title>/i.exec(html);
      check(
        "the window title is the product name",
        Boolean(titleTag) && titleTag[1].trim() === productName,
        `<title>=${titleTag && JSON.stringify(titleTag[1])} productName=${productName}`,
      );
      // No second copy of the name, abbreviated or otherwise, to keep in step
      // by hand. Covers the markup and the stylesheet that styled it.
      const customCss = fs.readFileSync(path.join(SRC, "custom-styles.css"), "utf8");
      const baseCss = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
      check(
        "the header carries no abbreviated second copy of the product name",
        !/app-title-short/.test(html) &&
          !/app-title-short/.test(customCss),
        "app-title-short still present",
      );
      check(
        "the single-row header carries no in-header product name at all",
        !/class="app-title"/.test(html) &&
          !/\.app-title\b/.test(customCss) &&
          !/\.app-title\b/.test(baseCss),
        "an .app-title element or rule is back in the header",
      );
    }

    // The vendor's MIT grant covers the code, not their marks. Renaming means
    // the marks are actually gone from what we ship, not merely relabelled.
    const VENDOR = /omnicore/i;

    // README.md is a SHIPPED, USER-FACING surface, not just repository prose:
    // it goes into the installer via extraResources and is what the in-app
    // welcome button opens. It was also the single largest remaining piece of
    // vendor branding - it described the vendor's product, by name, to anyone
    // who opened it - which both independent licence reviews rated blocking,
    // on the grounds that shipping it misrepresents who publishes the app.
    //
    // The vendor's name is still allowed in ONE place, and deliberately so:
    // LICENSE names three copyright holders, and a reader who meets two
    // unfamiliar names there needs the README to say why. So this does not
    // sweep the name out entirely - it pins it to the provenance section,
    // which is the assertion that actually expresses the intent. A vendor
    // mention drifting back into the product description would fail here
    // while the legitimate attribution keeps passing.
    {
      const readmeSrc = read("README.md");
      const productName = (pkg.build && pkg.build.productName) || pkg.productName;
      const readmeLines = readmeSrc.split(/\r?\n/);

      const h1 = readmeLines.find((l) => /^#\s+\S/.test(l));
      check(
        "the README titles itself with the product name, not the vendor's",
        Boolean(h1) && h1.replace(/^#\s+/, "").trim() === productName,
        `README H1=${JSON.stringify(h1)} productName=${productName}`,
      );

      // FOUND BY A PROBE, NOT BY THIS SUITE, which is why it is here now: an
      // edit that inserted two sections above `## Development` consumed that
      // heading and left its body - the install and test commands - hanging
      // under the section before it. All 197 assertions passed. Opening the
      // README in the app and listing the rendered <h2>s is what showed 12
      // headings where there should have been 13.
      //
      // The oracle is the SECTION LIST, not a line count or a total, because
      // those tolerate exactly the substitution that happened here (one
      // heading gained, one lost, structure still "plausible"). Renaming a
      // section is a deliberate act and updating this list with it is correct;
      // silently absorbing one is not. Headings inside fenced code blocks are
      // excluded - `# nvm-windows does not read .nvmrc` in the build snippet
      // is a shell comment, and counting it would make this assertion a
      // description of the file's punctuation rather than of its structure.
      {
        const REQUIRED_SECTIONS = [
          "What Folia is",
          "What changed in Folia",
          "Features",
          "Installation",
          "Controls",
          "Supported files",
          "Mermaid",
          "Technology",
          "Engineering",
          "Where this is going",
          "Development",
          "Contributing",
          "License",
        ];
        let fenced = false;
        const sections = [];
        for (const l of readmeLines) {
          if (/^\s*```/.test(l)) {
            fenced = !fenced;
            continue;
          }
          if (fenced) continue;
          const m = /^##\s+(\S.*?)\s*$/.exec(l);
          if (m) sections.push(m[1]);
        }
        const missing = REQUIRED_SECTIONS.filter((s) => !sections.includes(s));
        check(
          "every section the shipped README promises a reader is still present",
          missing.length === 0,
          `missing: ${missing.join(", ")} | found: ${sections.join(" / ")}`,
        );
        // Without this, deleting the whole list above would leave the check
        // above trivially satisfied.
        check(
          "the README section sweep really parsed a document structure",
          sections.length >= REQUIRED_SECTIONS.length,
          `parsed only ${sections.length} level-2 headings`,
        );
      }

      // Embedded images are REDACTED rather than having their whole line
      // dropped: base64 is drawn from an alphabet that can spell anything, so
      // a blob is not evidence of branding - but dropping the line would also
      // blind these sweeps to anything else sharing it, which is a real hole
      // in a file whose longest lines are images.
      const prose = readmeSrc
        .split(/\r?\n/)
        .map((l, i) => [i + 1, l.replace(/data:image\/[A-Za-z0-9+/=;,.-]+/g, "data:image/<redacted>")]);

      // What extraResources genuinely ships, read from package.json rather than
      // restated here. Both the image and the link assertions below judge
      // against this same list, because both are asking the same question: is
      // this thing still there after installation?
      const extraTargets = ((pkg.build && pkg.build.extraResources) || []).map(
        (e) => (typeof e === "string" ? e : e.to || e.from),
      );

      const provStart = prose.findIndex(([, l]) => /^###\s+Provenance\b/.test(l));
      check(

        "the README has a provenance section, which is where upstream attribution belongs",
        provStart !== -1,
        "no '### Provenance' heading found",
      );
      const provEnd =
        provStart === -1
          ? -1
          : (() => {
              const rest = prose.slice(provStart + 1);
              const nxt = rest.findIndex(([, l]) => /^#{1,3}\s+\S/.test(l));
              return nxt === -1 ? prose.length : provStart + 1 + nxt;
            })();

      const vendorHits = prose
        .map((e, idx) => [idx, e])
        .filter(([, [, l]]) => VENDOR.test(l));
      const strayVendor = vendorHits
        .filter(([idx]) => provStart === -1 || idx < provStart || idx >= provEnd)
        .map(([, [n, l]]) => `${n}: ${l.trim().slice(0, 60)}`);
      check(
        "vendor branding in the README is confined to the provenance section",
        strayVendor.length === 0,
        strayVendor.join(" | "),
      );
      check(
        "the provenance section does credit the upstream authors, so LICENSE's names are explained",
        provStart !== -1 &&
          vendorHits.some(
            ([idx]) => idx >= provStart && idx < provEnd,
          ),
        "provenance section names no upstream vendor",
      );

      // The images used to be `data:` URIs, and the comment here used to
      // explain why: a document rendered by this app had baseURI = the app's
      // own index.html, so a relative <img src> resolved against the asar and
      // never loaded (measured: naturalWidth 0 for markdown image syntax, for
      // './'-prefixed paths and for raw <img src> alike, against 512 for a
      // data: URI).
      //
      // BOTH HALVES OF THAT HAVE SINCE CHANGED, and the fix for one surface was
      // silently breaking the other. `resolveDocumentRelativeImageSrc()`
      // (renderer.js) now resolves a relative src against the directory of the
      // file being viewed, so the app-side reason to embed is gone. Meanwhile
      // GitHub's markdown sanitizer permits only http(s) in an <img src> and
      // strips `data:` outright, so every screenshot in this README rendered as
      // a broken-image icon on the project's own front page - REPORTED BY THE
      // USER, because nothing here could see it.
      //
      // So the rule inverts. It is pinned in both directions on purpose: the
      // no-data: half is what keeps GitHub working, and the ships-beside half
      // is what keeps the installed app working, and each is invisible from the
      // surface the other one serves.
      {
        const imgs = prose
          .flatMap(([n, l]) =>
            [...l.matchAll(/<img\s[^>]*src="([^"]*)"/gi)].map((m) => [n, m[1]]),
          );
        const relImgs = imgs.filter(([, s]) => !/^(https?:|data:)/i.test(s));

        // A vacuity floor, not a specification: without it, a README that had
        // lost its images entirely would satisfy every assertion below.
        check(
          "the README carries images, so the assertions about them have something to judge",
          relImgs.length >= 4,
          `found ${relImgs.length} relative images among ${imgs.length} total`,
        );

        const embedded = imgs
          .filter(([, s]) => /^data:/i.test(s))
          .map(([n]) => `line ${n}`);
        check(
          "no README image is embedded as a data: URI, which GitHub strips",
          embedded.length === 0,
          embedded.join(" | "),
        );

        const missingOnDisk = relImgs
          .filter(([, s]) => !fs.existsSync(path.join(ROOT, s.replace(/[?#].*$/, ""))))
          .map(([n, s]) => `${n}: ${s}`);
        check(
          "every README image exists in the repository, so GitHub can serve it",
          missingOnDisk.length === 0,
          missingOnDisk.join(" | "),
        );

        // The installed README sits in resources/ with only what
        // extraResources put beside it, and the app resolves a relative src
        // against the README's OWN directory - so an image that is not shipped
        // at the same relative path is a broken image in the packaged product
        // while looking perfect on GitHub. Read from extraResources rather than
        // restated, so adding an image outside a shipped directory fails here.
        const unshipped = relImgs
          .filter(([, s]) => {
            const t = s.replace(/[?#].*$/, "");
            return !extraTargets.some((e) => t === e || t.startsWith(e + "/"));
          })
          .map(([n, s]) => `${n}: ${s}`);
        check(
          "every README image also ships beside the installed README, so the app can render it",
          unshipped.length === 0,
          `${unshipped.join(" | ")} - not under extraResources (${extraTargets.join(", ")})`,
        );
      }

      // MEASURED on the real open path, and the reason the shields.io badges
      // were dropped: all three loaded over the network (naturalWidth 210, 78
      // and 90). `img-src` deliberately permits `https:` - docs/SECURITY-AUDIT.md
      // records that as a considered trade, because remote images in markdown
      // are a real feature - so the CSP does not stop them and was never meant
      // to. The problem is not the directive, it is that the app's OWN bundled
      // documentation was exercising it: opening the README sent a request to
      // a third party every time, which is a read receipt issued by a file
      // whose opening paragraph promises the app works entirely offline.
      // Anything genuinely remote in a user's own document is still their
      // business; this pins only what THIS project ships.
      const remote = prose
        .filter(([, l]) =>
          /<img\s[^>]*src="https?:/i.test(l) ||
          /!\[[^\]]*\]\(\s*https?:\/\//i.test(l))
        .map(([n, l]) => `${n}: ${l.trim().slice(0, 70)}`);
      check(
        "the shipped README fetches no images over the network when the app opens it",
        remote.length === 0,
        remote.join(" | "),
      );

      // A relative LINK in the README must point at something that is actually
      // there after installation, and "there" is not the repository. MEASURED:
      // relative links resolve against the DOCUMENT's own directory (unlike
      // images, which resolve against index.html - the app is inconsistent, and
      // that is tracked separately), and in an install the README sits in
      // resources/ with only whatever extraResources put beside it. A probe of
      // the first draft found 7 of its 8 relative targets missing there,
      // including `LICENSE` - which ships only as `LICENSE.txt`.
      //
      // The failure is quiet and it is on a page the app itself offers from the
      // welcome screen, so nothing about running the app would reveal it, and
      // every one of those links works perfectly on GitHub. Repository-only
      // documents are therefore absolute URLs now; this pins the rest to what
      // extraResources genuinely ships, reading that list rather than repeating
      // it, so adding a link to an unshipped doc fails here.
      {
        const extras = extraTargets;
        const linkTargets = [];
        for (const [n, l] of prose) {
          for (const m of l.matchAll(/\]\(([^)\s]+)\)/g)) {
            const t = m[1];
            if (/^(https?:|mailto:|#|data:)/i.test(t)) continue;
            linkTargets.push([n, t.replace(/#.*$/, "")]);
          }
        }
        check(
          "the README does link to local files, so this assertion has something to judge",
          linkTargets.length > 0,
          "no relative links found at all",
        );
        const dangling = linkTargets
          .filter(([, t]) => !extras.includes(t))
          .map(([n, t]) => `${n}: ${t}`);
        check(
          "every relative README link points at a file that ships beside it",
          dangling.length === 0,
          `${dangling.join(", ")} - not in extraResources (${extras.join(", ")})`,
        );
      }
    }

    // The pre-rename generic name is a separate hazard: it carries no vendor
    // mark, so the VENDOR sweep is blind to it, and a field left behind on it
    // silently reintroduces the old identity.
    const STALE_PRODUCT = /markdown[\s-]?viewer/i;
    const identityFields = {
      name: pkg.name,
      productName: pkg.productName,
      "build.productName": pkg.build && pkg.build.productName,
      description: pkg.description,
      homepage: pkg.homepage,
      "author.name": pkg.author && pkg.author.name,
      "build.appId": pkg.build && pkg.build.appId,
      "build.nsis.shortcutName":
        pkg.build && pkg.build.nsis && pkg.build.nsis.shortcutName,
      "build.linux.maintainer":
        pkg.build && pkg.build.linux && pkg.build.linux.maintainer,
      "build.win.artifactName":
        pkg.build && pkg.build.win && pkg.build.win.artifactName,
      "build.nsis.artifactName":
        pkg.build && pkg.build.nsis && pkg.build.nsis.artifactName,
    };
    const branded = Object.entries(identityFields)
      .filter(([, v]) => typeof v === "string" && VENDOR.test(v))
      .map(([k, v]) => `${k}=${v}`);
    check(
      "no vendor branding survives in the shipped package identity",
      branded.length === 0,
      branded.join("; "),
    );

    // Fields exempt from the stale-name sweep:
    //   description   - "markdown viewer" is the product CATEGORY, and saying
    //                   what the app is is the field's entire job. Sweeping it
    //                   would force prose that avoids naming its own category.
    // `homepage` used to be exempt too, because the GitHub repository was
    // still named markdown-viewer and the URL had to keep that slug to point
    // at anything. The repository is now lostinsea/folia, so the exemption is
    // gone and the URL is swept like every other identifier. GitHub keeps the
    // old slug redirecting, which is exactly why this needs an oracle: a stale
    // homepage would go on working indefinitely and nothing would notice.
    // Everything left is used as an IDENTIFIER by Electron, electron-builder
    // or the OS, and none of those may still say the old name.
    const STALE_EXEMPT = new Set(["description"]);
    const stale = Object.entries(identityFields)
      .filter(([k]) => !STALE_EXEMPT.has(k))
      .filter(([, v]) => typeof v === "string" && STALE_PRODUCT.test(v))
      .map(([k, v]) => `${k}=${v}`);
    check(
      "no pre-rename product name survives in the shipped package identity",
      stale.length === 0,
      stale.join("; "),
    );

    check(
      "appId is this project's own reverse-DNS namespace, not the vendor's",
      typeof (pkg.build && pkg.build.appId) === "string" &&
        pkg.build.appId === "io.github.lostinsea.folia",
      `appId=${pkg.build && pkg.build.appId}`,
    );

    // On Windows the taskbar, jump list, pinning and toast notifications all
    // identify the app by its AppUserModelID, NOT by its window title. With no
    // explicit call the runtime falls back to a default id, so a correctly
    // titled window can still group and notify under a different identity -
    // which is exactly the kind of half-finished rename this block exists to
    // catch.
    //
    // Asserted on main.js's source rather than on the running app because the
    // packaging suite is not an Electron harness. Two separate things are
    // pinned: that the call exists at all, and that its argument is DERIVED
    // from build.appId rather than a second copy of the string. A hardcoded
    // literal here would drift the moment appId changed, silently splitting
    // one app into two Windows identities - the failure mode is invisible in
    // the UI, so only a structural assertion catches it.
    const mainSrc = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
    check(
      "main.js sets an explicit AppUserModelId, so Windows groups and notifies as Folia",
      /app\.setAppUserModelId\(/.test(mainSrc),
      "no setAppUserModelId call found in main.js",
    );
    check(
      "the AppUserModelId is read from build.appId rather than duplicated as a literal",
      /appId\s*\}\s*=\s*require\(["']\.{1,2}\/package\.json["']\)\.build/.test(
        mainSrc,
      ) && !/setAppUserModelId\(\s*["']/.test(mainSrc),
      "expected the id to come from package.json build.appId",
    );

    // The dev-profile redirect has to run before ANYTHING reads the profile
    // path, and lateness is not observable at runtime: app.setPath("userData")
    // is silently ignored once the app is ready, so a call that moved down the
    // file keeps returning normally while the redirect quietly stops happening.
    // An absence check fails open, so the ordering is pinned statically here.
    //
    // The two readers below are the ones that resolve at MODULE SCOPE, so
    // they capture whatever the profile path is at the instant main.js is
    // evaluated: WINDOW_STATE_FILE and logFilePath. A behavioural suite
    // structurally cannot cover the positive half - every windowed suite
    // relocates userData first, so the redirect correctly declines there and
    // the ordering never bites. test-startup-perf.js asserts the declining
    // half live; test-dev-profile.js drives the decision itself against a stub.
    const devCall = mainSrc.indexOf("\napplyDevProfile();");
    check(
      "main.js applies the dev-profile redirect at module scope",
      devCall !== -1,
      "no top-level applyDevProfile() call found in main.js",
    );
    for (const [what, needle] of [
      ["WINDOW_STATE_FILE", "const WINDOW_STATE_FILE"],
      ["the debug log path", "logFilePath ="],
    ]) {
      const at = mainSrc.indexOf(needle);
      check(
        `the dev-profile redirect runs before ${what} reads the profile path`,
        devCall !== -1 && at !== -1 && devCall < at,
        `applyDevProfile@${devCall} ${JSON.stringify(needle)}@${at}`,
      );
    }

    // The letterhead PNG was deleted with Corporate Mode. If the allowlist
    // still named it, electron-builder would fail the build on a missing file.
    check(
      "the deleted letterhead asset is not still on the build allowlist",
      !files.some((f) => /letterhead/i.test(String(f))),
      files.filter((f) => /letterhead/i.test(String(f))).join(", "),
    );

    // Installer filenames are what release.js and electron-updater agree on.
    // The old config emitted dot-separated names while release.js hunted for
    // dash-separated ones, so the rename step it ran was permanently dead.
    for (const [where, value] of [
      ["win", pkg.build && pkg.build.win && pkg.build.win.artifactName],
      ["nsis", pkg.build && pkg.build.nsis && pkg.build.nsis.artifactName],
    ]) {
      check(
        `${where} artifactName uses dashes, matching what release.js expects`,
        typeof value === "string" &&
          value.startsWith("Folia-") &&
          !/\s/.test(value),
        `${where} artifactName=${JSON.stringify(value)}`,
      );
    }

    // release.js spells the expected filenames out in its dry-run listing and
    // its release notes. Those must track build config or the notes tell users
    // to download files that were never produced.
    {
      const rel = fs.readFileSync(
        path.join(ROOT, "scripts", "release.js"),
        "utf8",
      );
      check(
        "release.js no longer references the vendor's installer names",
        !VENDOR.test(rel),
        (rel.match(/.*omnicore.*/gi) || []).slice(0, 3).join(" | "),
      );
      check(
        "release.js dropped the dead space-to-dash installer rename",
        !/renameWindowsInstaller/.test(rel),
      );

      // Every `gh release` call is pinned with --repo so it cannot resolve the
      // target from git remotes. This checkout carries three remotes and two
      // of them are other people's repositories, so an unpinned
      // `gh release delete --yes` could destroy releases on the vendor's
      // project. Counted rather than pattern-spotted: a single new unpinned
      // call is exactly the regression worth catching, and it would be
      // invisible to a "does --repo appear anywhere" check.
      {
        // Scoped to real invocations - `exec(`gh release …`)` - not to any
        // occurrence of the words. The first attempt matched free text and
        // flagged a comment and a log message that merely NAME the command,
        // which would have trained the next reader to ignore this assertion.
        const GH_CALL = new RegExp("exec\\(`gh release [^`]*`", "g");
        const ghCalls = rel.match(GH_CALL) || [];
        const unpinned = ghCalls.filter((c) => !/\$\{ghRepo\}|--repo/.test(c));
        check(
          "every gh release call is pinned to an explicit --repo",
          ghCalls.length >= 4 && unpinned.length === 0,
          `calls=${ghCalls.length} unpinned=${JSON.stringify(unpinned)}`,
        );
      }

      // The --repo pin covers `gh`, not `git`. Deleting a REMOTE tag is the
      // one destructive git operation in the script and it targets `origin`,
      // which is not guaranteed to be the repo package.json names - the same
      // hazard, one tool over. Assert the verification exists rather than that
      // the push exists, so restructuring is free but removing the guard is not.
      check(
        "the remote tag delete verifies origin against the package.json repo",
        /remoteSlug\(['"]origin['"]\)/.test(rel) &&
          /git push origin :refs\/tags\//.test(rel) &&
          rel.indexOf("remoteSlug('origin')") < rel.indexOf("git push origin :refs/tags/"),
        "expected remoteSlug('origin') to be checked before the remote tag delete",
      );

      // The release notes and the build config are written in different files
      // and drifted apart: the notes told every user "existing installations
      // will automatically detect this update" while `build.publish` was null,
      // so no feed existed and nobody ever updated. Couple them, in whichever
      // direction the project later chooses.
      const publishEnabled = Boolean(
        pkg.build &&
          pkg.build.publish !== null &&
          pkg.build.publish !== undefined,
      );
      const promisesAutoUpdate =
        /automatically detect this update|will auto-?update/i.test(rel);
      check(
        publishEnabled
          ? "release notes may promise auto-update because publishing is configured"
          : "release notes do not promise auto-update while publishing is disabled",
        publishEnabled || !promisesAutoUpdate,
        `build.publish=${JSON.stringify(pkg.build && pkg.build.publish)}`,
      );

      // Same drift, second symptom: the dry-run listing advertised update
      // manifests that a publish-less build never emits, so a dry run showed
      // artifacts the real run could not produce.
      const dryRunListsManifests = /['"`]latest(-\w+)?\.yml['"`]/.test(rel);
      check(
        publishEnabled
          ? "dry-run artifact list may include update manifests because publishing is configured"
          : "dry-run artifact list does not advertise update manifests that are never built",
        publishEnabled || !dryRunListsManifests,
        dryRunListsManifests
          ? (rel.match(/.*['"`]latest(-\w+)?\.yml['"`].*/g) || [])
              .slice(0, 2)
              .join(" | ")
          : "",
      );

      // Everything above reads release.js as TEXT. The next block runs it.
      //
      // A native-Windows host cannot build Linux artifacts, but the dry-run
      // listing and the published release notes both named an AppImage and a
      // DEB unconditionally - so a Windows release shipped download
      // instructions for two files that were never uploaded. Text assertions
      // cannot see that, because the strings are present in the source either
      // way; only running the code with a known artifact set can.
      //
      // The real source is evaluated (minus its trailing `main()` call), not a
      // copy, so this cannot pass against code that no longer ships.
      {
        const MAIN_CALL = "main().catch(";
        const cut = rel.indexOf(MAIN_CALL);
        check(
          "release.js still ends with the main() entry point the harness slices off",
          cut > 0,
          "expected to find " + JSON.stringify(MAIN_CALL),
        );

        if (cut > 0) {
          const body =
            rel.slice(0, cut).replace(/^#![^\n]*/, "") +
            "\nreturn { willBuildLinux, getArtifacts, createGitHubRelease," +
            " setDryRun: (v) => { dryRun = v; } };\n";
          const api = new Function(
            "require",
            "__dirname",
            "process",
            "console",
            body,
          )(
            require,
            path.join(ROOT, "scripts"),
            process,
            console,
          );
          api.setDryRun(true);

          // logDryRun -> log -> console.log, so the notes come back through
          // stdout. Capture rather than re-derive them.
          const captured = [];
          const realLog = console.log;
          console.log = (...a) => captured.push(a.join(" "));
          let notesFor;
          try {
            notesFor = (files) => {
              captured.length = 0;
              api.createGitHubRelease(
                "9.9.9",
                files.map((f) => path.join(ROOT, "dist", f)),
              );
              return captured.join("\n");
            };

            const winOnly = notesFor([
              "Folia-Setup-9.9.9.exe",
              "Folia-Setup-9.9.9.exe.blockmap",
            ]);
            const allThree = notesFor([
              "Folia-Setup-9.9.9.exe",
              "Folia-9.9.9.AppImage",
              "folia_9.9.9_amd64.deb",
            ]);

            const listedArtifacts = (() => {
              captured.length = 0;
              api.getArtifacts("9.9.9");
              return captured.join("\n");
            })();

            console.log = realLog;

            check(
              "release notes name the Windows installer that was collected",
              /Folia-Setup-9\.9\.9\.exe/.test(winOnly),
            );
            check(
              "release notes do not offer Linux downloads that were not built",
              !/AppImage|\.deb/i.test(winOnly),
              (winOnly.match(/.*(AppImage|\.deb).*/gi) || [])
                .slice(0, 2)
                .join(" | "),
            );
            check(
              "release notes do offer Linux downloads when they were built",
              /Folia-9\.9\.9\.AppImage/.test(allThree) &&
                /folia_9\.9\.9_amd64\.deb/.test(allThree),
            );

            // Independent oracle: decided from the host, not from the
            // implementation's own willBuildLinux(). On this machine the two
            // must agree; asserting only "list matches willBuildLinux()" would
            // pass against a helper that always returned true.
            const hostCanBuildLinux =
              process.platform !== "win32" ||
              fs.existsSync("/proc/version");
            const listsLinux = /AppImage|\.deb/i.test(listedArtifacts);
            check(
              "the dry-run artifact list advertises Linux builds only where they can be produced",
              listsLinux === hostCanBuildLinux,
              `platform=${process.platform} hostCanBuildLinux=${hostCanBuildLinux} listsLinux=${listsLinux}`,
            );
            check(
              "willBuildLinux() agrees with the host it is running on",
              api.willBuildLinux() === hostCanBuildLinux,
            );
          } finally {
            console.log = realLog;
          }

          // The scan half of getArtifacts, driven against a real directory.
          // dist/ is never cleaned, so a previous version's installer sits
          // there matching the same patterns; uploading it attaches a
          // wrong-version binary to the release. DIST_DIR derives from
          // __dirname, so a fake root gives the real function a real directory
          // to walk without touching this checkout's dist/.
          const fakeRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "folia-release-scan-"),
          );
          try {
            fs.mkdirSync(path.join(fakeRoot, "scripts"));
            fs.mkdirSync(path.join(fakeRoot, "dist"));
            fs.writeFileSync(
              path.join(fakeRoot, "package.json"),
              JSON.stringify({ version: "9.9.9" }),
            );
            const dist = path.join(fakeRoot, "dist");
            for (const f of [
              "Folia-Setup-9.9.9.exe",
              "Folia-Setup-9.9.9.exe.blockmap",
              "Folia-Setup-9.9.8.exe",
              "Folia-9.9.8.AppImage",
              "notes.txt",
            ]) {
              fs.writeFileSync(path.join(dist, f), "x");
            }

            const scanApi = new Function(
              "require",
              "__dirname",
              "process",
              "console",
              body,
            )(
              require,
              path.join(fakeRoot, "scripts"),
              process,
              console,
            );

            const quiet = [];
            const realLog2 = console.log;
            console.log = (...a) => quiet.push(a.join(" "));
            let found;
            try {
              found = scanApi
                .getArtifacts("9.9.9")
                .map((p) => path.basename(p));
            } finally {
              console.log = realLog2;
            }

            check(
              "the artifact scan collects this version's files",
              found.includes("Folia-Setup-9.9.9.exe") &&
                found.includes("Folia-Setup-9.9.9.exe.blockmap"),
              JSON.stringify(found),
            );
            check(
              "the artifact scan ignores a previous version left in dist/",
              !found.some((f) => f.includes("9.9.8")),
              JSON.stringify(found),
            );
            check(
              "the stale files really were there, so the filter had something to reject",
              fs.existsSync(path.join(dist, "Folia-9.9.8.AppImage")),
            );
          } finally {
            fs.rmSync(fakeRoot, { recursive: true, force: true });
          }
        }
      }
    }
  }

    // The welcome screen's version badge must come from app.getVersion() at
    // runtime, never from a literal in the markup. The old markup hardcoded
    // "v2.0.0" and was still claiming it after the 1.0 rebrand, because nothing
    // made the two agree.
    {
      const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
      const m = html.match(
        /id="welcomeVersion"[^>]*>([^<]*)</,
      );
      check(
        "the welcome version badge carries no hardcoded version literal",
        Boolean(m) && m[1].trim() === "",
        m ? `badge contains ${JSON.stringify(m[1])}` : "welcomeVersion element not found",
      );
    }

  // ------------------------------------------------------------------
  // Third-party licence compliance.
  //
  // Folia being MIT does not discharge anything here. MIT, ISC, BSD and
  // Apache-2.0 each grant redistribution ON CONDITION that their own copyright
  // notice and licence text are reproduced in the distribution. That obligation
  // belongs to each dependency, and `build.files` ships `node_modules/**/*`, so
  // every one of them is in the installer.
  // ------------------------------------------------------------------
  {
    const NOTICES = "THIRD-PARTY-NOTICES.md";
    const noticesPath = path.join(ROOT, NOTICES);
    check("the third-party notices file exists", fs.existsSync(noticesPath));

    // WHERE THESE FILES ACTUALLY SHIP - measured against a real
    // `electron-builder --win dir` build with probe files planted in each
    // position, not reasoned from the docs:
    //
    //   probe listed BEFORE `!**/*.md`         -> not in asar
    //   probe listed AFTER  `!**/*.md`         -> IN asar   (order IS honoured)
    //   probe in build.files AND extraResources -> NOT in asar, in resources/
    //   probe in build.files only               -> IN asar
    //
    // The third line is the one that matters here: electron-builder removes a
    // file from the asar when it is also an extraResources source, so it is
    // not shipped twice. So listing an extraResources file in `build.files` as
    // well changes nothing - it is dead configuration that reads as
    // load-bearing. An earlier version of this file did exactly that and had a
    // revert entry "proving" it, which could only ever have been vacuous.
    // extraResources is the whole mechanism, so that is what is asserted.
    const extra = (pkg.build && pkg.build.extraResources) || [];
    check(
      "the notices file ships unpacked in resources/, where a reader can find it",
      extra.some((e) => (e && e.from) === NOTICES),
      JSON.stringify(extra),
    );
    check(
      "the notices file is not also listed in build.files (that entry is inert)",
      !files.includes(NOTICES),
      `files: ${JSON.stringify(files.filter((f) => /\.md$|\.txt$/.test(f)))}`,
    );
    // The same trap, for the two files that were in both lists for the same
    // reason. main.js:2639 resolves README from process.resourcesPath when
    // packaged, which is only correct because extraResources is what puts it
    // there.
    for (const f of ["README.md", "LICENSE.txt"]) {
      check(
        `${f} ships via extraResources and is not duplicated into build.files`,
        extra.some((e) => (e && e.from) === f) && !files.includes(f),
        `inExtra=${extra.some((e) => (e && e.from) === f)} inFiles=${files.includes(f)}`,
      );
    }

    // The generator reads the dependency tree that is actually installed, so
    // regenerating in memory and comparing catches the case that matters:
    // a dependency added, removed or upgraded without refreshing the notices.
    if (fs.existsSync(noticesPath)) {
      let regenerated = null;
      let genErr = null;
      let gen = null;
      try {
        gen = require("../scripts/generate-notices");
        regenerated = gen.build();
      } catch (e) {
        genErr = e;
      }
      check("the notices generator runs", regenerated !== null, genErr && genErr.message);
      if (regenerated) {
        const committed = fs.readFileSync(noticesPath, "utf8");
        // The evidence has to survive the case where the two differ WITHOUT
        // differing in length - a version bump like 3.4.12 -> 3.4.14 keeps the
        // byte count identical, so a size-only message reads "committed 196797
        // bytes, regenerated 196797 bytes" and reports a failure whose own
        // detail says nothing is wrong. Same disease as the licence guard's
        // "107 entries, 0 without". Name the first divergence instead.
        let noticesDetail = `committed ${committed.length} bytes, regenerated ${regenerated.length} bytes - run \`npm run notices\``;
        if (committed !== regenerated) {
          let at = 0;
          while (at < committed.length && at < regenerated.length && committed[at] === regenerated[at]) at++;
          const excerpt = (s) => JSON.stringify(s.slice(at, at + 48));
          noticesDetail =
            `first difference at offset ${at} of ${committed.length}/${regenerated.length} bytes: ` +
            `committed ${excerpt(committed)} vs regenerated ${excerpt(regenerated)} - run \`npm run notices\``;
        }
        check("the committed notices file is not stale", committed === regenerated, noticesDetail);

        // This document SHIPS, and its first line tells the reader where
        // Folia's own licence is. It said `LICENSE` - a file that exists in
        // the repository and is deliberately NOT in extraResources, because
        // the shipped copy is `LICENSE.txt` (a bare extensionless file is a
        // "how do you want to open this" dialog on Windows). So the one
        // pointer in the installed notices named the one licence file that
        // does not install beside it.
        //
        // The README's relative links are already pinned to extraResources
        // further up, but that oracle could never have caught this: the
        // pointer is inline CODE, not a markdown link, and it is in the other
        // shipped document. Read the shipping list rather than repeating it,
        // so renaming what ships fails here too.
        const pointer = committed.match(
          /distributed under the MIT licence \(see `([^`]+)`\)/,
        );
        check(
          "the notices file still states where Folia's own licence is",
          Boolean(pointer),
          pointer
            ? ""
            : "no `distributed under the MIT licence (see ...)` sentence found - " +
              "the assertion below judges nothing without it",
        );
        if (pointer) {
          const shipped = extra
            .map((e) => e && (e.to || e.from))
            .filter(Boolean);
          check(
            "the notices file's licence pointer names a file that ships beside it",
            shipped.includes(pointer[1]),
            `points at ${JSON.stringify(pointer[1])}; resources/ receives ` +
              `${JSON.stringify(shipped)} - fix the sentence in ` +
              "scripts/generate-notices.js, then `npm run notices`",
          );
        }

        // A second source describing the same tree. NOTE ON ITS STRENGTH: the
        // generator now reads package-lock.json directly (it used to walk
        // `npm ls`, which reported 259 packages against the lockfile's 219
        // because it includes EXTRANEOUS ones left behind by earlier
        // installs - jsdom among them, which is demonstrably absent from the
        // built asar). That fix made this oracle share a source with the
        // generator, so it no longer checks the SOURCE - it checks the walk,
        // the dedupe and the rendering between that source and the output. The
        // asar oracle below is the one that is genuinely independent.
        const lockPath = path.join(ROOT, "package-lock.json");
        if (fs.existsSync(lockPath)) {
          const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          const prod = new Set();
          for (const [p, meta] of Object.entries(lock.packages || {})) {
            if (!p.startsWith("node_modules/")) continue;
            if (meta.dev || meta.devOptional) continue;
            prod.add(p.slice(p.lastIndexOf("node_modules/") + "node_modules/".length));
          }
          const documented = new Set(
            (committed.match(/^### (.+?)(?: \d[^\s]*)?$/gm) || []).map((h) =>
              h.replace(/^### /, "").replace(/ \d[^\s]*$/, ""),
            ),
          );
          const missing = [...prod].filter((n) => !documented.has(n));
          check(
            "every production dependency in package-lock.json has a notice",
            prod.size > 0 && missing.length === 0,
            `${prod.size} production packages, ${missing.length} undocumented: ${missing.slice(0, 8).join(", ")}`,
          );
        }

        // COMPLIANCE, and the gap that let a 130 MB packaging win silently
        // become a licence breach. Moving marked/mermaid/dompurify/prismjs to
        // devDependencies removed them from the lockfile's non-dev tree, and
        // the generator derived its package set from exactly that - so the
        // notices lost them while their code went on shipping inside
        // libs/vendor/*.js and libs/prismjs/. Nothing failed. The oracle here
        // is deliberately INDEPENDENT of the generator's own VENDORED_ROOTS:
        // it reads the LIBS table out of scripts/vendor-libs.js (the thing
        // that actually performs the vendoring) plus the committed libs/
        // subdirectories, so vendoring a new library without documenting it
        // fails rather than passing by omission.
        const vendoredHere = new Set(libsNames);
        // libs/prismjs and libs/tabulator are COMMITTED rather than produced by
        // vendor-libs.js, so the LIBS table cannot see them. EVERY committed
        // libs/ subdirectory counts: requiring a matching node_modules/<name>
        // (as this first did) quietly excused exactly the case that needs
        // policing most - Tabulator is not an npm dependency at all, so it was
        // covered only by the "committed file is not stale" assertion, which
        // anyone could satisfy by deleting its EXTRA entry and regenerating.
        const libsDir = path.join(ROOT, "libs");
        if (fs.existsSync(libsDir)) {
          for (const e of fs.readdirSync(libsDir, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name === "vendor") continue;
            vendoredHere.add(e.name);
          }
        }
        check(
          "the vendoring oracle found the libraries it is meant to police",
          vendoredHere.size >= 4,
          `found ${vendoredHere.size}: ${[...vendoredHere].join(", ")} - the LIBS table or libs/ layout moved, so this check stopped checking`,
        );        // A cardinality check alone would be satisfied by any four names. These

        // The root set every vendored-library oracle below scopes itself by.
        // It is the UNION of the structurally discovered set and the
        // generator's own list, never the generator's list alone. Both review
        // models independently found the same residual hole: an oracle scoped
        // by gen.VENDORED_ROOTS silently stops looking at a root the moment
        // that list loses it, so a coordinated edit - drop "marked" from
        // VENDORED_ROOTS and move it back to dependencies - would restore the
        // double-shipping this whole item exists to remove while every
        // assertion here stayed green. Unioning makes the scope monotonic:
        // shrinking VENDORED_ROOTS can never shrink what gets checked.
        const vendoredRootNames = new Set([...vendoredHere, ...gen.VENDORED_ROOTS]);
        // A cardinality check alone would be satisfied by any four names. These
        // are the four whose code is known to ship, so name them: drift that
        // swaps one for another has to be noticed rather than counted.
        const missingRoots = ["marked", "mermaid", "dompurify", "prismjs"].filter(
          (n) => !vendoredHere.has(n),
        );
        check(
          "the vendoring oracle is policing the libraries that actually ship",
          missingRoots.length === 0,
          `${missingRoots.join(", ")} not discovered - if a library really was dropped, remove it from libs/ and from the generator too`,
        );
        // Directory names are lower case ("libs/tabulator") while the notice
        // heading is the project's own capitalisation ("Tabulator" plus its
        // version), so the comparison has to be case-insensitive or it reports
        // a false breach for the one library it was just widened to cover.
        const documentedLower = new Set([...documentedNames(regenerated)].map((n) => n.toLowerCase()));
        const undocumentedVendored = [...vendoredHere].filter(
          (n) => !documentedLower.has(n.toLowerCase()),
        );
        check(
          "every library vendored into libs/ has a notice",
          undocumentedVendored.length === 0,
          `${undocumentedVendored.join(", ")} - code ships inside libs/ but is documented nowhere; how it got there (npm devDependency, or committed by hand like Tabulator) does not change the obligation`,
        );

        // THE VENDORED COPY CAN GO STALE WITHOUT ANYTHING FAILING, and it did.
        // A real bump shipped the previous library's bytes: `npm install
        // marked@18.0.10` put 18.0.10 into node_modules, left
        // libs/vendor/marked.min.js on 18.0.9, wrote nothing to VERSIONS.json,
        // and reported success. Every other assertion in this suite stayed
        // green, because they ask whether the vendored files are DOCUMENTED and
        // PACKAGED - never whether they are CURRENT. So package.json, the
        // lockfile and `npm audit` would all have described a version the
        // application does not run, which is the exact decorative-versions
        // failure vendoring was introduced to end.
        //
        // MEASURED, because scripts/vendor-libs.js's own header asserted the
        // opposite ("It runs on postinstall, so the copies cannot drift from
        // package.json"): on npm 11.16.0 a bare `npm install` DOES fire the
        // root postinstall, and `npm install <pkg>@<ver>` DOES NOT. The drift
        // window is therefore exactly the command a dependency bump is made
        // with. The remedy named below is `npm run vendor`.
        //
        // BOTH HALVES ARE NEEDED AND NEITHER IMPLIES THE OTHER. The byte
        // comparison catches the stale copy (the case above). The version
        // comparison catches a copy made by hand without updating
        // VERSIONS.json, and also the case where two releases happen to emit
        // byte-identical output - there the bytes agree while the recorded
        // version is wrong, and only VERSIONS.json can say so.
        const libTriples = [];
        if (libsTable) {
          for (const m of libsTable[1].matchAll(
            /\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g,
          )) {
            libTriples.push({ pkg: m[1], file: m[2], dest: m[3] });
          }
        }
        // Non-vacuity by CROSS-CHECKING TWO PARSERS of the same table rather
        // than by a count with slack in it. The shared lax parser (hoisted to
        // one site near the top of this file) reads only the first string of
        // each entry; this one needs all three. An entry whose shape the strict
        // parser cannot read would otherwise be dropped from the freshness
        // check silently, which is the same disease this block exists to catch,
        // one level up.
        check(
          "the vendored-freshness oracle read every entry in the LIBS table",
          libTriples.length === libsNames.length && libTriples.length >= 3,
          `${libTriples.length} full triple(s) parsed against ${libsNames.length} entr(ies) found, measured 3 - a mismatch means an entry is being skipped rather than checked`,
        );
        let recordedVendorVersions = null;
        try {
          recordedVendorVersions =
            JSON.parse(read("libs/vendor/VERSIONS.json")).versions || null;
        } catch (e) {
          recordedVendorVersions = null;
        }
        check(
          "libs/vendor/VERSIONS.json records what was vendored",
          recordedVendorVersions !== null,
          "missing or unparseable - vendor-libs.js rewrites it on every run, so its absence means the vendoring never completed",
        );
        const staleVendored = [];
        const versionMismatches = [];
        const unvendorable = [];
        for (const t of libTriples) {
          const src = path.join(ROOT, "node_modules", t.pkg, t.file);
          const dst = path.join(ROOT, "libs", "vendor", t.dest);
          const meta = path.join(ROOT, "node_modules", t.pkg, "package.json");
          if (!fs.existsSync(src) || !fs.existsSync(meta)) {
            unvendorable.push(t.pkg);
            continue;
          }
          if (!fs.existsSync(dst) || !fs.readFileSync(src).equals(fs.readFileSync(dst))) {
            staleVendored.push(`libs/vendor/${t.dest} != node_modules/${t.pkg}/${t.file}`);
          }
          const installed = JSON.parse(fs.readFileSync(meta, "utf8")).version;
          const recorded = recordedVendorVersions ? recordedVendorVersions[t.pkg] : undefined;
          if (String(recorded) !== String(installed)) {
            versionMismatches.push(
              `${t.pkg}: VERSIONS.json says ${recorded}, node_modules has ${installed}`,
            );
          }
        }
        if (unvendorable.length > 0) {
          // Naming the packages rather than the count, because a partial
          // node_modules is the one state in which this block genuinely cannot
          // answer - and a silent pass here would restore the hole exactly.
          skip(
            "every vendored library is the byte-for-byte copy of the version installed in node_modules",
            `${unvendorable.join(", ")} not present under node_modules - run \`npm install\` so the shipped copies can be compared against their source`,
          );
          skip(
            "libs/vendor/VERSIONS.json names the versions installed in node_modules",
            `${unvendorable.join(", ")} not present under node_modules`,
          );
        } else {
          check(
            "every vendored library is the byte-for-byte copy of the version installed in node_modules",
            staleVendored.length === 0,
            `${staleVendored.join("; ")} - the shipped library is not the one package.json declares; run \`npm run vendor\` (a bump made with \`npm install <pkg>@<ver>\` does not fire the root postinstall)`,
          );
          check(
            "libs/vendor/VERSIONS.json names the versions installed in node_modules",
            versionMismatches.length === 0,
            `${versionMismatches.join("; ")} - run \`npm run vendor\``,
          );
        }

        // THE ATTRIBUTION THAT USED TO SHIP AS A FILE. Solarized Light and
        // Tomorrow Night were vendored as libs/prismjs/themes/*.css, each
        // carrying its own author header, and this suite asserted those files
        // shipped. Inlining their rules into src/styles.css deleted both files
        // and, with them, both assertions - silently. A name-set diff of this
        // suite across that change shows the two simply gone: nothing failed,
        // because an assertion that stops existing cannot fail. The obligation
        // did not go anywhere, so the guard is restored in the form the code
        // now takes - a comment in a stylesheet, which is precisely the kind of
        // thing a reformat or a minifier drops without anyone noticing.
        //
        // The names are listed rather than scraped. Upstream credits its
        // authors in four different shapes ("originally by", "Ported for
        // PrismJS by", "@author", and a bare github URL), so a scraper needs
        // four patterns and one that quietly matches three of them reports full
        // compliance. Listing moves the risk to STALENESS instead, which the
        // first assertion below removes by checking every listed name against
        // the upstream header it claims to come from.
        const INLINED_THEME_CREDITS = [
          { name: "Ethan Schoonover", upstream: "prism-solarizedlight.css", as: "Ethan Schoonover" },
          { name: "Hector Matos", upstream: "prism-solarizedlight.css", as: "Hector Matos" },
          // Upstream credits Tomorrow Night only through the project URL
          // github.com/chriskempson/tomorrow-theme, so what must appear
          // upstream and what must appear in our own prose are different
          // strings for the same person.
          { name: "Chris Kempson", upstream: "prism-tomorrow.css", as: "chriskempson" },
          { name: "Rose Pritchard", upstream: "prism-tomorrow.css", as: "Rose Pritchard" },
        ];
        check(
          "the inlined-theme attribution oracle has credits to police",
          INLINED_THEME_CREDITS.length >= 4,
          `${INLINED_THEME_CREDITS.length} credits listed - emptying this list would make both assertions below pass over nothing`,
        );
        const prismThemeDir = path.join(ROOT, "node_modules", "prismjs", "themes");
        const creditsWithoutUpstream = INLINED_THEME_CREDITS.filter(
          (c) => !fs.existsSync(path.join(prismThemeDir, c.upstream)),
        );
        if (creditsWithoutUpstream.length > 0) {
          skip(
            "every inlined theme credit is one upstream PrismJS really gives",
            `node_modules/prismjs/themes is missing ${[
              ...new Set(creditsWithoutUpstream.map((c) => c.upstream)),
            ].join(", ")} - run \`npm install\` so the list can be validated against its source`,
          );
        } else {
          const notCreditedUpstream = INLINED_THEME_CREDITS.filter(
            (c) => !fs.readFileSync(path.join(prismThemeDir, c.upstream), "utf8").includes(c.as),
          );
          check(
            "every inlined theme credit is one upstream PrismJS really gives",
            notCreditedUpstream.length === 0,
            `${notCreditedUpstream
              .map((c) => `${c.name} (looked for "${c.as}" in ${c.upstream})`)
              .join(", ")} - the list has gone stale against upstream, so the notice below is crediting from memory`,
          );
        }
        const inlinedThemeStyles = read("src/styles.css");
        const missingThemeCredits = INLINED_THEME_CREDITS.filter(
          (c) => !inlinedThemeStyles.includes(c.name),
        );
        check(
          "the inlined PrismJS colour schemes keep their upstream attribution",
          missingThemeCredits.length === 0,
          `${missingThemeCredits
            .map((c) => c.name)
            .join(", ")} uncredited in src/styles.css - their rules ship inlined there, and deleting the file they came from must not delete the credit`,
        );

        // VERSION-level, and not merely a stricter version of the check above.
        // mermaid bundles marked 16.4.2 while this repository's own root copy
        // is marked 9.1.6. Both ship. If the lockfile walk ever resolved
        // mermaid's dependency to the ROOT entry instead of the nested one -
        // the single most plausible regression in resolveLockKey() - the
        // notices would still contain a heading called "marked", so every
        // name-level assertion here would stay green while the licence for the
        // code actually inside libs/vendor/mermaid.min.js went missing.
        //
        // The expectation is read STRUCTURALLY out of the lockfile rather than
        // from the generator's own closure. That distinction is not academic:
        // this assertion was first written against gen.vendoredPackages() and
        // was CIRCULAR - reverting resolveLockKey() to a root-only lookup moved
        // the expectation and the output together, and the assertion passed
        // while documenting the wrong version. A nested lockfile key IS a
        // private copy belonging to its parent by construction, so no
        // resolution logic is needed to know it must be documented.
        //
        // Assumes vendored roots are unscoped and unaliased: a scoped root
        // (@scope/name) would need `node_modules/@scope/name/node_modules/`,
        // and an `npm:` alias would make the folder name differ from the
        // package name the heading is written from. Neither shape exists here.
        const lockPkgs = JSON.parse(read("package-lock.json")).packages || {};
        const nestedUnderVendored = Object.keys(lockPkgs).filter((k) =>
          [...vendoredRootNames].some((r) => k.includes(`node_modules/${r}/node_modules/`)),
        );
        check(
          "the duplicate-version oracle found the nested copies it exists to police",
          nestedUnderVendored.length > 0,
          "no vendored root has a private nested dependency in the lockfile - this check is no longer checking anything",
        );
        const headings = new Set((regenerated.match(/^### .+$/gm) || []).map((h) => h.slice(4)));
        const missingVersions = nestedUnderVendored
          .map((k) => ({
            name: k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length),
            version: (lockPkgs[k] || {}).version,
          }))
          .filter((p) => p.version && !headings.has(`${p.name} ${p.version}`));
        check(
          "every bundled version is documented, including duplicate versions of the same package",
          missingVersions.length === 0,
          `${missingVersions.length} missing: ${missingVersions
            .slice(0, 8)
            .map((p) => `${p.name}@${p.version}`)
            .join(", ")} - a nested lockfile entry is a private copy bundled into its parent, so the parent's bundle contains THAT version`,
        );

        // THE INDEPENDENT ORACLE: what electron-builder actually put in the
        // asar. Not derived from package.json or package-lock.json at all, so
        // it is the only check here that can catch the generator and its input
        // agreeing with each other and both being wrong about the product.
        // Skipped when there is no build, because requiring one would make the
        // suite depend on a 4-minute step; the checks above still run.
        const asarPath = path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar");
        // Only trusted when the build is NEWER than the lockfile. A stale asar
        // produces a confident FALSE FAILURE - add a dependency without
        // rebuilding and the notices correctly document a package the old asar
        // cannot contain, which this would report as over-inclusion. An oracle
        // that fails for reasons unrelated to the thing it measures gets
        // muted by whoever hits it next, so it is skipped instead.
        const asarFresh =
          fs.existsSync(asarPath) &&
          fs.existsSync(lockPath) &&
          fs.statSync(asarPath).mtimeMs >= fs.statSync(lockPath).mtimeMs;
        if (asarFresh) {
          let shipped = null;
          let shippedFiles = null;
          let asarErr = null;
          try {
            const asar = require("@electron/asar");
            shipped = new Set();
            shippedFiles = new Set();
            for (const f of asar.listPackage(asarPath)) {
              const norm = f.replace(/\\/g, "/");
              shippedFiles.add(norm);
              const m = /^.*\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\/package\.json$/.exec(norm);
              if (m) shipped.add(m[1]);
            }
          } catch (e) {
            asarErr = e;
            shipped = null;
            shippedFiles = null;
          }
          // A build exists and is fresh, so these oracles are OWED. Letting a
          // failure to read it fall through to `if (shipped)` would delete the
          // only assertions that inspect the actual artefact, with neither a
          // FAIL nor a SKIP - the same silent disappearance the skip()
          // mechanism was added to end, just via a different door.
          check(
            "the built app.asar can be inspected",
            shippedFiles !== null && shipped.size > 0,
            asarErr
              ? `@electron/asar threw: ${asarErr.message}`
              : "archive read but no node_modules package.json found in it",
          );
          if (shippedFiles) {
            // build.files states the INTENT to package libs/; this is the FACT
            // that it happened. The distinction stopped being academic when
            // marked/mermaid/dompurify/prismjs moved to devDependencies: from
            // that point libs/ is the ONLY copy of those libraries in the
            // installer, so a globbing change that dropped it would take the
            // renderer's syntax highlighting and every diagram with it, and
            // the two existing "in build.files" assertions would still pass.
            //
            // The PrismJS entry used to name components/prism-core.min.js,
            // which was the wrong file and made this guard decorative for
            // syntax highlighting: src/index.html loads exactly one Prism file,
            // libs/prismjs/prism-bundle.js, and nothing has ever loaded
            // components/. Dropping the bundle really would take highlighting
            // with it and this assertion would have stayed green; dropping
            // components/ took nothing and would have failed it. Measured, not
            // assumed - the components/ tree could not even load, because
            // prism-clike.min.js was never vendored and 8 of its 14 language
            // components require it. It has since been deleted.
            for (const rel of [
              "libs/vendor/marked.min.js",
              "libs/vendor/mermaid.min.js",
              "libs/vendor/purify.min.js",
              "libs/prismjs/prism-bundle.js",
            ]) {
              check(
                `${rel} is really inside the built app.asar`,
                shippedFiles.has("/" + rel),
                "declared in build.files but absent from the archive - this is now the only copy that ships",
              );
            }

            // The COMPLEMENT of the loop above, and the guard that stops the
            // 143.8 KB of redundant PrismJS payload from silently coming back.
            // build.files ships libs/**/*, so anything re-vendored under
            // libs/prismjs/ enters the installer with nothing to review: every
            // assertion above is equally satisfied by a directory that carries
            // 16 dead component files beside the bundle.
            //
            // It fails CLOSED rather than needing a separate positive control -
            // the expectation is a NON-EMPTY set, so a sweep that matched
            // nothing (a path-separator change, a renamed directory) reports a
            // mismatch rather than a clean absence.
            //
            // NOT revert-provable, and that is a structural limit of the
            // harness rather than an omission: a revert is a string edit and
            // this reads a BUILD ARTEFACT the harness cannot regenerate, so no
            // revert can put a file back into the archive. Proven non-vacuous
            // by MEASUREMENT instead: against the build made BEFORE the
            // deletion this same sweep saw 21 entries (components.json,
            // components/ and its 16 .min.js files, prism.js), and after
            // `npm run build` on the deleted tree it sees 2. Same precedent as
            // R457 - record the gap, prove the property the way the artefact
            // allows.
            const prismEntries = [...shippedFiles].filter((p) => p.startsWith("/libs/prismjs/"));
            const prismFiles = prismEntries
              .filter((p) => !prismEntries.some((q) => q.startsWith(p + "/")))
              .sort();
            check(
              "the built app.asar carries exactly one PrismJS file, the bundle the renderer loads",
              prismFiles.length === 1 && prismFiles[0] === "/libs/prismjs/prism-bundle.js",
              `libs/prismjs/ ships ${prismFiles.length} file(s): ${JSON.stringify(prismFiles)}`,
            );
          }

          // app-update.yml is what makes the packaged app able to find an
          // update at all: electron-updater reads it from resourcesPath, and
          // without it every check fails at config load. It is the
          // artefact-level fact behind the config-level assertion earlier -
          // the same intent/fact split as the libs/ bundles above.
          //
          // Its PRECONDITION has to be stated, and getting that wrong is how
          // this assertion first failed: electron-builder writes the file only
          // when an nsis target is in the build (app-builder-lib's
          // isSuitableWindowsTarget), so `npm run build` - portable only -
          // leaves win-unpacked with no feed, and the assertion was really
          // reading whichever target happened to build last. A skip that names
          // the remedy is honest; a failure would be blaming the tree for the
          // command the developer chose.
          const updateYml = path.join(
            ROOT, "dist", "win-unpacked", "resources", "app-update.yml",
          );
          if (!fs.existsSync(updateYml)) {
            skip(
              "packaged update feed config",
              "the last build produced no auto-updatable target, so electron-builder " +
                "wrote no app-update.yml - run `npm run build-all` (what release.yml runs)",
            );
          } else {
            const updateCfg = fs.readFileSync(updateYml, "utf8");
            check(
              "the packaged app carries an update feed config",
              /provider:\s*github/.test(updateCfg) &&
                /owner:\s*lostinsea/.test(updateCfg) &&
                /repo:\s*folia/.test(updateCfg),
              `app-update.yml does not name this fork: ${updateCfg.replace(/\s+/g, " ").trim()}`,
            );
          }
          if (shipped && shipped.size > 0) {
            const vendoredClosure = gen.vendoredPackageNames();
            // Names only. Reading each package.json out of the asar to compare
            // versions would be stronger still, but the failure this guards
            // against - a package shipping with no notice at all - is a name
            // level fact, and the staleness check above pins the versions.
            const documented = documentedNames(regenerated);
            const undocumented = [...shipped].filter((n) => !documented.has(n));
            check(
              "every package inside the built app.asar has a notice",
              undocumented.length === 0,
              `${shipped.size} packages in the asar, ${undocumented.length} undocumented: ${undocumented
                .slice(0, 8)
                .join(", ")}`,
            );
            // The other direction, and the one that caught the original
            // defect: documenting a package that does not ship describes the
            // developer's workstation rather than the product, and two
            // developers would produce different files from the same commit.
            // Tabulator and Fira Code are vendored files rather than packages,
            // so they are legitimately absent from node_modules. ("Fira Code"
            // in full now - it used to be spelled "Fira" here only because the
            // name parser truncated version-less headings.) So is the whole
            // marked/mermaid/dompurify/prismjs closure: that code ships
            // pre-bundled under libs/, which is why it is a devDependency and
            // why it has no directory in the asar. The exemption is taken from
            // the generator rather than hard-coded so the two cannot drift.
            const VENDORED = new Set(["Tabulator", "Fira Code"]);
            for (const n of vendoredClosure) VENDORED.add(n);
            const overIncluded = [...documented].filter(
              (n) => !shipped.has(n) && !VENDORED.has(n),
            );
            check(
              "the notices document nothing that is absent from the built app.asar",
              overIncluded.length === 0,
              `${overIncluded.length} over-included: ${overIncluded.slice(0, 8).join(", ")}`,
            );

            // THE 130 MB GUARD. build.files ships `node_modules/**/*`, so
            // every production dependency lands in the asar whether any
            // shipped file requires it or not. Measured: marked, mermaid,
            // dompurify and prismjs were production dependencies and
            // contributed 130.4 MB to a 153.6 MB asar, while the renderer
            // loaded none of them from node_modules - it loads the vendored
            // bundles under libs/. Nothing failed, because a package that
            // ships and is documented satisfies both oracles above; the cost
            // was invisible to every assertion in this suite.
            //
            // Policed over the whole CLOSURE, not just the four roots. The
            // roots are the obvious regression; the transitives are the likely
            // one - d3, cytoscape, katex and dagre are already inlined into
            // libs/vendor/mermaid.min.js, so a future production dependency
            // that pulls any of them in ships that code TWICE while every
            // other assertion here stays green. Measured against the current
            // build: the closure (105 packages) and the asar's node_modules
            // (94 packages) do not intersect at all, so this is a genuine
            // widening rather than a rule the tree already violates.
            //
            // The structurally discovered roots are unioned in for the same
            // reason as vendoredRootNames above, and the shape of the hole was
            // MEASURED rather than taken on the reviewer's description of it.
            // Both models proposed the same compound regression - drop a root
            // from VENDORED_ROOTS and move it back to dependencies - using
            // `marked` as the example. Building that exact state (asar 24.1 MB,
            // marked back in node_modules) showed the closure-only guard
            // catching it anyway: mermaid depends on marked, so marked stays in
            // the closure even when it is not a root. The reviewers' conclusion
            // was right and their example was wrong.
            //
            // Reachability of each root via the other three, measured:
            //   marked    -> still reachable (via mermaid)
            //   dompurify -> still reachable (via mermaid)
            //   mermaid   -> NOT reachable, closure collapses 105 -> 4
            //   prismjs   -> NOT reachable, closure 105 -> 104
            // So for mermaid and prismjs the closure-only guard is
            // structurally incapable of naming them, for any asar contents.
            // That is what the union fixes. No revert entry pins it, because
            // the two sets are disjoint in the current tree and such an entry
            // would be permanently vacuous - the same reason R110b was deleted
            // rather than kept.
            const vendorDirs = [...new Set([...vendoredClosure, ...vendoredRootNames])].filter(
              (n) => shipped.has(n),
            );
            check(
              "no vendored library is also shipped as a node_modules copy",
              vendorDirs.length === 0,
              `${vendorDirs.join(", ")} ship twice - once under libs/ and again in node_modules; they belong in devDependencies`,
            );
          }
        } else {
          skip(
            "built app.asar oracles",
            fs.existsSync(asarPath)
              ? "dist build is older than package-lock.json - run `npm run build`"
              : "no dist build present - run `npm run build`",
          );
        }

        // Six shipped packages publish no licence file. Their terms live only
        // in a README, and `!**/*.md` strips READMEs out of the packaged app,
        // so before this the text existed NOWHERE in the distribution. An
        // entry that says "ships no licence file" is an admission that the
        // condition attached to the grant was not met, not a notice.
        check(
          "no shipped package is left with a placeholder instead of licence terms",
          !/ships no licence file/.test(regenerated),
          (regenerated.match(/^### .+\n(?:[\s\S]{0,900}?ships no licence file)/gm) || [])
            .map((s) => s.split("\n")[0])
            .slice(0, 8)
            .join(", "),
        );
        // Stronger than "there is a fenced block": a block containing none of
        // the operative phrases is a badge or a pointer, not a grant.
        {
          const entries = regenerated.split(/^### /m).slice(1);
          const toothless = entries.filter((e) => !gen.LICENCE_BODY_RE.test(e));
          // The vacuity guard used to be a hard-coded `entries.length > 200`
          // against a real count of 220. Twenty packages of headroom made it
          // a false failure waiting to happen, and it fired as exactly that:
          // a run with a smaller (deliberately broken) tree reported "107
          // entries, 0 WITHOUT" - a failure whose own diagnostic said nothing
          // was wrong. Tied to the collected component list instead, so it
          // measures a relationship rather than a remembered number.
          const collected = gen.collect().length;
          check(
            "every component entry reproduces operative licence language",
            collected > 0 && entries.length === collected && toothless.length === 0,
            `${collected} components collected, ${entries.length} rendered as entries, ${toothless.length} without operative language: ${toothless
              .map((e) => e.split("\n")[0])
              .slice(0, 8)
              .join(", ")}`,
          );
        }
        // Where canonical text is used it must SAY so. Presenting a
        // reconstructed licence as if it had been copied from the package
        // would be the more damaging error of the two.
        check(
          "canonical licence text is labelled as reconstructed, not passed off as the package's own",
          !/canonical text of that licence/.test(regenerated) ||
            /publishes no licence file and no licence text in its README/.test(regenerated),
          "canonical block present without its provenance note",
        );

        check(
          "the vendored Tabulator is documented despite not being an npm dependency",
          /^### Tabulator \d+\.\d+\.\d+$/m.test(committed),
          "no versioned Tabulator heading",
        );
        check(
          "Fira Code is documented",
          /^### Fira Code/m.test(committed) && committed.includes("OFL-1.1"),
        );
        // A dual licence is an offer, not a description; the notice has to say
        // which limb was taken or downstream cannot tell what terms they got.
        // Checking the ELECTION TEXT alone would be weak, because the licence
        // body reproduced underneath is chosen by a separate code path: for
        // dompurify the Apache `LICENSE` beats the MPL `LICENSE-MPL` on a
        // shortest-filename tiebreak, so the two agreed only by coincidence.
        // These assert the body actually matches the election.
        const elections = [
          { heading: "dompurify", spdx: "(MPL-2.0 OR Apache-2.0)", elected: "Apache-2.0", body: /Apache License/, rejected: /Mozilla Public License/ },
        ];
        // Checked against the REGENERATED text, not the committed copy. A
        // generator regression shows up in what it produces now; the committed
        // file would only catch it one `npm run notices` later, by which point
        // the wrong licence has already shipped. The staleness assertion above
        // ties the two together, so checking the live output is strictly
        // stronger rather than a different subject.
        for (const e of elections) {
          // No `m` flag: with it, the `$` in the lookahead would match the end
          // of the first LINE, truncating every entry to nothing - which made
          // the negative "does not contain the rejected limb" check pass
          // vacuously while the positive ones failed.
          const m = new RegExp(
            `\\n### ${e.heading} [^\\n]*\\n([\\s\\S]*?)(?=\\n### |$)`,
          ).exec(regenerated);
          if (!m) {
            check(`${e.heading} appears in the notices`, false, "no heading found");
            continue;
          }
          const entry = m[1];
          check(
            `${e.heading}'s entry names the licence Folia elects`,
            entry.includes(`elects **${e.elected}**`),
            entry.split("\n").slice(0, 6).join(" | "),
          );
          check(
            `${e.heading}'s reproduced licence text is the one elected, not merely the one that sorted first`,
            e.body.test(entry),
            `entry does not contain ${e.body}`,
          );
          if (e.rejected) {
            check(
              `${e.heading} does not reproduce the rejected limb's text instead`,
              !e.rejected.test(entry),
            );
          }
        }

        // An SPDX `AND` is not an offer to choose from, it is two obligations
        // at once - so the election machinery above is not just inapplicable
        // here, it would be actively wrong. This is driven off the SPDX
        // expression rather than off a list of package names, so a future
        // conjunctive dependency is caught without anyone remembering that
        // conjunctive licences exist as a category.
        const conjunctive = [];
        {
          const re = /\n### ([^\s]+) [^\n]*\n([\s\S]*?)(?=\n### |$)/g;
          let m;
          while ((m = re.exec(regenerated)) !== null) {
            if (/^- Licence: [^\n]*\sAND\s/m.test(m[2])) {
              conjunctive.push({ name: m[1], entry: m[2] });
            }
          }
        }
        // NO REAL CONJUNCTIVE PACKAGE REMAINS. pako - `(MIT AND Zlib)` - was
        // the only one, and it left with html-to-docx's 70-package closure,
        // taking jszip's `(MIT OR GPL-3.0-or-later)` dual election with it.
        // The vacuity guard that asserted pako's presence was removed with it
        // rather than retargeted, because there is nothing to retarget it to.
        //
        // That costs less than it looks. The loop below still runs for any
        // conjunctive package that arrives later, and the machinery itself is
        // covered by the SYNTHETIC sensitivity probe further down - which was
        // written that way on purpose, precisely so this coverage would not
        // depend on a particular package staying in the tree. The election
        // assertions above are still driven by a real package (dompurify).
        for (const c of conjunctive) {
          check(
            `${c.name} does not claim an election it cannot make`,
            !/elects \*\*/.test(c.entry),
          );
          check(
            `${c.name} says plainly that every limb applies`,
            /No election is made or possible/.test(c.entry),
          );
          // The substantive check: not "is there a second block" but "are the
          // second licence's OWN operative clauses present". Zlib's clause 1
          // and clause 3 appear in no other licence family in this tree, so
          // this cannot be satisfied by the MIT text already there.
          check(
            `${c.name} reproduces the operative terms of every limb, not just the first`,
            /origin of this software must not be misrepresented/i.test(c.entry) &&
              /may not be removed or altered/i.test(c.entry),
            c.entry.slice(0, 200),
          );
          check(
            `${c.name} states which part of the package the additional terms cover`,
            /Additional terms for `[^`]+`/.test(c.entry),
          );
        }

        // Sensitivity probe. The guard's whole justification is that a missing
        // limb is INVISIBLE in the output - the entry still names the full
        // expression and still reproduces a real licence - so the guard must be
        // shown to fire rather than assumed to. Driving it with a synthetic
        // component is deliberate: waiting for a real conjunctive package to
        // lose its extra block would make this assertion permanently vacuous.
        // Since pako left the tree, this probe is the ONLY thing covering the
        // conjunctive path, which is exactly the case it was designed for. The
        // name is deliberately not a real package, so nobody greps for it and
        // concludes the dependency is still installed.
        let guardFired = false;
        try {
          gen.assertConjunctiveCovered([
            { name: "synthetic-conjunctive-fixture", version: "0.0.0", spdx: "(MIT AND Zlib)", extraLicences: [] },
          ]);
        } catch (err) {
          guardFired = /Conjunctive/.test(err.message);
        }
        check(
          "the conjunctive-licence guard really rejects an entry that drops a limb",
          guardFired,
        );
        // ...and does not fire on a licence that merely contains the letters
        // AND, which would make it noise that gets disabled.
        let falsePositive = false;
        try {
          gen.assertConjunctiveCovered([
            { name: "standard", version: "1.0.0", spdx: "MIT", extraLicences: [] },
          ]);
        } catch {
          falsePositive = true;
        }
        check("the conjunctive-licence guard does not fire on single licences", !falsePositive);

        // The guard has four clauses and the two probes above reach only the
        // first (`!entry`). The rest are reachable only with a POPULATED table,
        // which the tree cannot supply while CONJUNCTIVE is legitimately empty -
        // so the table itself is the fixture. Restored in `finally`, because a
        // leaked entry would silently weaken every later assertion in this
        // process rather than failing one.
        const probeName = "synthetic-conjunctive-fixture";
        const realEntry = Object.prototype.hasOwnProperty.call(gen.CONJUNCTIVE, probeName)
          ? gen.CONJUNCTIVE[probeName]
          : undefined;
        const throwsWith = (entry, extraLicences, spdx) => {
          gen.CONJUNCTIVE[probeName] = entry;
          try {
            gen.assertConjunctiveCovered([
              { name: probeName, version: "0.0.0", spdx, extraLicences },
            ]);
            return false;
          } catch (err) {
            return /Conjunctive/.test(err.message);
          }
        };
        try {
          const limb = [{ file: "lib/zlib/README", spdx: "Zlib", covers: "lib/zlib/", text: "x" }];
          check(
            "the conjunctive guard fires when a table entry exists but no extra limb was collected",
            throwsWith({ spdx: "(MIT AND Zlib)" }, [], "(MIT AND Zlib)"),
          );
          check(
            "the conjunctive guard fires when the table entry describes a different expression",
            throwsWith({ spdx: "(MIT AND ISC)" }, limb, "(MIT AND Zlib)"),
          );
          // POSITIVE CONTROL, and it is the load-bearing one: without it every
          // assertion above is satisfied by a guard that throws unconditionally,
          // which would fail the build on the first real conjunctive dependency
          // and get deleted as noise - the precise outcome the guard exists to
          // avoid.
          check(
            "the conjunctive guard accepts a fully described conjunctive licence",
            !throwsWith({ spdx: "(MIT AND Zlib)" }, limb, "(MIT AND Zlib)"),
          );
        } finally {
          if (realEntry === undefined) delete gen.CONJUNCTIVE[probeName];
          else gen.CONJUNCTIVE[probeName] = realEntry;
        }

        // RENDER-level sensitivity probe, and it is NOT a stricter version of
        // the guard probe above. The guard only asks whether `extraLicences`
        // was POPULATED; it says nothing about whether the renderer emits it.
        // Those are two different failure modes and the second is the more
        // dangerous one - the guard is satisfied, the generator runs happily,
        // and the notices silently lose a binding limb.
        //
        // Synthetic for the same reason as the guard probe: pako left with
        // html-to-docx's closure and no conjunctive package remains, so a probe
        // driven by the real tree would be permanently vacuous. That is exactly
        // what happened to R141/R142, which named these properties and could
        // not break either of them.
        const conjRendered = gen.render([
          {
            name: "synthetic-conjunctive-fixture",
            version: "0.0.0",
            spdx: "(MIT AND Zlib)",
            licenseText: "MIT BODY, first limb only.",
            extraLicences: [
              {
                file: "lib/zlib/README",
                spdx: "Zlib",
                covers: "lib/zlib/",
                why: "Fixture: the package states that this folder carries the second limb.",
                // Zlib's clause 1 and clause 3, which appear in no other
                // licence family here - so the assertion cannot be satisfied by
                // the MIT text already present in the same entry.
                text:
                  "The origin of this software must not be misrepresented. " +
                  "This notice may not be removed or altered from any source distribution.",
              },
            ],
          },
        ]);
        check(
          "a conjunctive entry reproduces the operative terms of every limb, not just the first",
          /origin of this software must not be misrepresented/i.test(conjRendered) &&
            /may not be removed or altered/i.test(conjRendered),
          conjRendered.slice(0, 200),
        );
        check(
          "a conjunctive entry states which part of the package the extra terms cover",
          /Additional terms for `lib\/zlib\/` \(Zlib\)/.test(conjRendered),
          conjRendered.slice(0, 200),
        );
        check(
          "a conjunctive entry says plainly that no election is made, and claims none",
          /No election is made or possible/.test(conjRendered) &&
            !/elects \*\*/.test(conjRendered),
          conjRendered.slice(0, 200),
        );
        // Sensitivity in the other direction: the probe above would still pass
        // if render() dropped the PRIMARY licence text and emitted only the
        // extra limbs. Named separately so R142 can list it in mustPass, which
        // is what makes that revert say "the extra limbs were lost" rather than
        // "conjunctive rendering broke somehow".
        check(
          "a conjunctive entry still reproduces the primary licence text",
          /MIT BODY, first limb only\./.test(conjRendered),
          conjRendered.slice(0, 200),
        );

        // core.autocrlf=true is set on this repo and LICENSE is already
        // `i/lf w/crlf`. If the notices file were not pinned to LF in
        // .gitattributes, a fresh clone would hold CRLF while the generator
        // keeps emitting LF, and the byte-for-byte staleness check above would
        // fail on a clean checkout with no way to fix it - regenerating writes
        // LF and git converts it straight back.
        check(
          "the committed notices file is LF, as .gitattributes pins it",
          !committed.includes("\r"),
          `${(committed.match(/\r/g) || []).length} CR bytes present`,
        );
        const attrs = fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
        check(
          ".gitattributes pins the generated notices to LF",
          /^THIRD-PARTY-NOTICES\.md\s+text\s+eol=lf\s*$/m.test(attrs),
        );
        // Verbatim third-party licence texts. Their provenance rests on a
        // byte-for-byte match with the upstream artifact (the OFL as SIL
        // publishes it; Tabulator's licence as it comes out of `npm pack`), so
        // an end-of-line rewrite on checkout would break that verification -
        // and for the OFL it would alter the very file clause 2 requires to
        // travel with the font binaries. This is also not hypothetical: git's
        // own core.safecrlf guard REFUSED to stage these files until they were
        // pinned, because the LF -> repo -> CRLF round trip is not reversible.
        for (const f of ["assets/fonts/LICENSE-FiraCode.txt", "libs/tabulator/LICENSE"]) {
          const pinned = new RegExp(
            `^${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+text\\s+eol=lf\\s*$`,
            "m",
          ).test(attrs);
          check(`.gitattributes pins ${f} to LF so it stays byte-faithful`, pinned);
          const p = path.join(ROOT, f);
          check(
            `${f} is stored with LF endings, as pinned`,
            fs.existsSync(p) && !fs.readFileSync(p, "utf8").includes("\r\n"),
          );
        }

        // THE PROVENANCE CLAIM ABOVE USED TO NAME A VERSION, AND IT WENT STALE.
        // The comment beside the Tabulator pin in .gitattributes read "the
        // Tabulator licence comes out of `npm pack tabulator-tables@6.2.5`"
        // while the tree had moved on to 6.5.2. That is not a cosmetic drift in
        // a comment: the two artifacts differ precisely in the copyright notice
        // (6.2.5 reads `Copyright (c) 2015-2024 Oli Folkerd`, 6.5.2 reads
        // `2015-2026`), and under MIT the notice IS the obligation. So the
        // comment was citing, as the source of a verbatim copy, an artifact
        // that does not contain the text that ships.
        //
        // Measured, both tarballs unpacked side by side:
        //   6.2.5  banner `Tabulator v6.2.5 ... 2024`   LICENSE 2015-2024
        //   6.5.2  banner `Tabulator v6.5.2 ... 2026`   LICENSE 2015-2026
        //   vendored LICENSE  ==  6.5.2's, byte for byte; differs from 6.2.5's
        //
        // Two assertions, because the cause and the consequence fail under
        // different accidents. The first forbids a version being written down
        // beside the file at all - the drift cannot recur if there is nothing
        // to drift. The second is the substantive half: the vendored LICENSE
        // and the vendored bundle must still look like two files out of ONE
        // tarball, which is the actual thing the prose claims and the actual
        // accident that produced this defect (bump the bundle, forget to
        // re-copy the licence beside it).
        {
          const staleVersion = attrs.match(/tabulator-tables@\s*([\d.]+)/);
          check(
            ".gitattributes cites the Tabulator licence source without pinning a version to drift from",
            !staleVersion,
            staleVersion
              ? `.gitattributes names tabulator-tables@${staleVersion[1]}; the vendored bundle's own banner is the version record, so nothing should restate it here`
              : "",
          );

          // Independent of the README version oracle above: that one reads the
          // banner for its VERSION, this one reads it for its YEAR, and
          // compares it against a different file entirely.
          const licText = read("libs/tabulator/LICENSE");
          const bannerYear = ((read("libs/tabulator/tabulator.min.js").slice(0, 400)
            .match(/Tabulator v[\d.]+ \(c\) [^\n]*?(\d{4})/) || [])[1] || "");
          const licYear = ((licText.match(/Copyright \(c\) \d{4}-(\d{4})/) || [])[1] || "");
          // Vacuity floor: two empty strings compare equal, so a regex that
          // stopped matching either file would report perfect agreement. Same
          // disease as the `entries.length > 200` licence guard against a real
          // 220 - a comparison nobody has forced to name what it compared.
          check(
            "both halves of the Tabulator provenance pair were really parsed",
            /^\d{4}$/.test(bannerYear) && /^\d{4}$/.test(licYear),
            `banner year ${JSON.stringify(bannerYear)}, LICENSE year ${JSON.stringify(licYear)}`,
          );
          // Upstream stamps the bundle banner from the build and hand-maintains
          // the LICENSE, and the two agreed on both sampled releases two years
          // apart. This is therefore evidence rather than a guarantee: a future
          // bump published in January, before upstream rolls its own copyright
          // year, would fail here with the licence correctly copied. That is
          // the intended behaviour and matches the recorded stance on the other
          // Tabulator surface pins - a bump SHOULD fail loudly and be looked at
          // by a human, rather than pass silently while the shipped notice
          // quietly stops matching the shipped code.
          check(
            "the vendored Tabulator licence and bundle still come from the same upstream tarball",
            bannerYear === licYear,
            `libs/tabulator/tabulator.min.js reports ${bannerYear} but libs/tabulator/LICENSE reports ${licYear}; ` +
              "re-copy LICENSE out of `npm pack tabulator-tables` at the banner's version",
          );
        }

        // The logo SVG is generated, like the notices above, and needs the same
        // pin for the same reason - but it earned its own assertion by failing
        // in a worse way than the others. `git add -A` ABORTED on safecrlf, and
        // the `git commit` that ran next still SUCCEEDED, capturing only the
        // paths that happened to be staged already. The result was a commit
        // that looked ordinary and contained a fraction of the change. Nothing
        // about an aborted add stops the commit after it, so the guard has to
        // live here rather than relying on noticing the abort.
        {
          const pinned = /^assets\/logo\.svg\s+text\s+eol=lf\s*$/m.test(attrs);
          check(".gitattributes pins the generated logo SVG to LF", pinned);
          const p = path.join(ROOT, "assets", "logo.svg");
          check(
            "assets/logo.svg is stored with LF endings, as pinned",
            fs.existsSync(p) && !fs.readFileSync(p, "utf8").includes("\r\n"),
          );
        }

        // A LONE CR - a \r that is not part of a \r\n pair - silently disables
        // git's end-of-line normalisation for the ENTIRE file. git's own
        // text/binary heuristic classifies such a file as `-text`, after which
        // core.autocrlf stops converting it and the working tree's CRLF is
        // committed verbatim. Nothing announces this: `git diff --numstat`
        // still counts it as text, `git status` is silent, and the file reads
        // normally in every editor. The only symptom is an implausibly large
        // diffstat - here, a 285-line change to this very file was committed as
        // 1913 insertions / 1642 deletions because one stray \r had been
        // introduced by an automated edit.
        //
        // The .gitattributes pins above defend six specific generated or
        // verbatim files. They cannot defend the rest of the tree, because the
        // damage does not come from a missing pin - it comes from a byte that
        // should never have been written. So this checks the bytes.
        {
          let tracked = null;
          try {
            tracked = execFileSync("git", ["ls-files", "--eol", "-z"], {
              cwd: ROOT,
              encoding: "utf8",
              maxBuffer: 32 * 1024 * 1024,
            });
          } catch {
            tracked = null;
          }

          if (tracked === null) {
            skip(
              "tracked-source end-of-line hygiene",
              "git is unavailable or this is not a checkout; run inside the repository to enable",
            );
          } else {
            // Extensions whose contents are text by construction. Deliberately
            // an allow-list rather than a deny-list: a new binary format added
            // to the repo must not be able to fail this by accident, whereas a
            // new source extension that goes unchecked is a gap this comment
            // exists to make visible.
            const TEXT_EXT = new Set([
              ".js",
              ".cjs",
              ".mjs",
              ".json",
              ".md",
              ".css",
              ".html",
              ".yml",
              ".yaml",
              ".txt",
              ".svg",
              ".sh",
            ]);

            const rows = tracked.split("\0").filter(Boolean);
            const loneCr = [];
            const notText = [];
            let scanned = 0;

            for (const row of rows) {
              // `i/lf    w/crlf  attr/text=auto  <path>` - the path is
              // separated from the attribute columns by a TAB, and a path may
              // itself contain spaces, so split on the tab and nothing else.
              const tab = row.indexOf("\t");
              if (tab === -1) continue;
              const cols = row.slice(0, tab);
              const rel = row.slice(tab + 1);
              if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;

              const abs = path.join(ROOT, rel);
              if (!fs.existsSync(abs)) continue; // staged deletion mid-run
              scanned += 1;

              // git's own verdict. `-text` means normalisation is OFF for this
              // file, whatever .gitattributes or core.autocrlf say.
              if (/(^|\s)i\/-text(\s|$)/.test(cols)) notText.push(rel);

              const buf = fs.readFileSync(abs, "latin1");
              const hits = buf.match(/\r(?!\n)/g);
              if (hits) loneCr.push(`${rel} (${hits.length})`);
            }

            // Without this the whole block would pass by scanning nothing - the
            // exact shape of vacuous green this suite has been bitten by before.
            check(
              "the end-of-line sweep actually reached the tracked source files",
              scanned >= 30,
              `${scanned} text files scanned`,
            );
            check(
              "no tracked source file contains a lone CR, which would silently disable EOL normalisation",
              loneCr.length === 0,
              loneCr.slice(0, 10).join(", "),
            );
            check(
              "git classifies every tracked source file as text, so autocrlf still applies to it",
              notText.length === 0,
              notText.slice(0, 10).join(", "),
            );
          }
        }
      }
    }

    // Apache-2.0 section 4(d) makes propagating a dependency's NOTICE file a
    // condition of redistribution, and it is a SEPARATE obligation from
    // reproducing the licence text. Nothing in this tree ships one today, so
    // the scan below finds nothing - which is why the collector is proved
    // sensitive first. An assertion that scans for something that does not
    // exist, using a collector that has never been shown to detect anything,
    // is two vacuous checks agreeing with each other.
    {
      const gen = require("../scripts/generate-notices");
      const probe = fs.mkdtempSync(path.join(os.tmpdir(), "folia-notice-"));
      try {
        const withNotice = path.join(probe, "with");
        const withoutNotice = path.join(probe, "without");
        fs.mkdirSync(withNotice);
        fs.mkdirSync(withoutNotice);
        fs.writeFileSync(path.join(withNotice, "NOTICE"), "Example Corp\nDerived from X.\n");
        fs.writeFileSync(path.join(withoutNotice, "LICENSE"), "MIT\n");
        const hit = gen.readNoticeText(withNotice);
        const miss = gen.readNoticeText(withoutNotice);
        check(
          "the NOTICE collector detects a NOTICE file and ignores a licence-only package",
          Boolean(hit) && hit.text.includes("Example Corp") && miss === null,
          `hit=${JSON.stringify(hit)} miss=${JSON.stringify(miss)}`,
        );
      } finally {
        fs.rmSync(probe, { recursive: true, force: true });
      }

      // The README harvester needs the same treatment, and for a sharper
      // reason: its first version returned null for EVERY package, and that
      // presented as "no package happens to state its licence in prose"
      // rather than as a failure. (`\Z` is not a JavaScript escape - it
      // matches a literal "Z" - and the heading-level lookahead was inverted.)
      // A harvester that cannot be shown to harvest is indistinguishable from
      // one that is broken.
      {
        const probe2 = fs.mkdtempSync(path.join(os.tmpdir(), "folia-readme-"));
        try {
          const real = path.join(probe2, "real");
          const label = path.join(probe2, "label");
          const trailing = path.join(probe2, "trailing");
          for (const d of [real, label, trailing]) fs.mkdirSync(d);
          const MIT =
            "Copyright (c) 2013 Example Person &lt;p@example.com&gt;\n\n" +
            "Permission is hereby granted, free of charge, to any person obtaining a copy " +
            "of this software and associated documentation files (the \"Software\"), to deal " +
            "in the Software without restriction, including without limitation the rights " +
            "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell " +
            "copies of the Software, subject to the following conditions:\n\n" +
            "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND.\n";
          fs.writeFileSync(path.join(real, "README.md"), `# thing\n\n## License\n\n${MIT}`);
          // The failure mode that matters most: a heading whose body is just
          // the SPDX id. Reproducing that would satisfy a naive "has a licence
          // section" check while discharging nothing.
          fs.writeFileSync(path.join(label, "README.md"), "# thing\n\n## License\n\nMIT\n");
          fs.writeFileSync(
            path.join(trailing, "README.md"),
            `# thing\n\n## License\n\n${MIT}\n## Contributing\n\nSend patches to nobody.\n`,
          );
          const hit = gen.readLicenseFromReadme(real);
          const miss = gen.readLicenseFromReadme(label);
          const bounded = gen.readLicenseFromReadme(trailing);
          check(
            "the README harvester extracts real licence prose and rejects a bare SPDX label",
            Boolean(hit) && /Permission is hereby granted/.test(hit.text) && miss === null,
            `hit=${hit && hit.text.length} miss=${JSON.stringify(miss)}`,
          );
          check(
            "the README harvester decodes HTML entities in the copyright line",
            Boolean(hit) && hit.text.includes("<p@example.com>") && !hit.text.includes("&lt;"),
            hit && hit.text.split("\n")[0],
          );
          check(
            "the README harvester stops at the next heading of the same level",
            Boolean(bounded) && !/Send patches/.test(bounded.text),
            bounded && bounded.text.slice(-80),
          );
          // spdxFromReadme fires for no package in the tree today (`error`
          // turned out to declare MIT through the legacy `licenses` array in
          // its package.json, which spdxOf already handles). Kept as a guard
          // for the next such package, and proved sensitive so that it is a
          // guard rather than dead code.
          check(
            "the README SPDX declaration reader discriminates",
            gen.spdxFromReadme(label) === null &&
              gen.spdxFromReadme(
                (() => {
                  const d = path.join(probe2, "declared");
                  fs.mkdirSync(d);
                  fs.writeFileSync(path.join(d, "README.md"), "# t\n\n## MIT Licenced\n\nhi\n");
                  return d;
                })(),
              ) === "MIT",
            `label=${gen.spdxFromReadme(label)}`,
          );
        } finally {
          fs.rmSync(probe2, { recursive: true, force: true });
        }
      }

      // Now the real tree, using the same collector that was just shown to work.
      const modules = path.join(ROOT, "node_modules");
      const unpropagated = [];
      if (fs.existsSync(noticesPath) && fs.existsSync(modules)) {
        const committedText = fs.readFileSync(noticesPath, "utf8");
        const stack = [modules];
        while (stack.length) {
          const dir = stack.pop();
          let entries = [];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          if (entries.some((e) => e.isFile() && e.name === "package.json")) {
            const n = gen.readNoticeText(dir);
            if (n && !committedText.includes(n.text.slice(0, 120))) {
              unpropagated.push(path.relative(modules, dir).replace(/\\/g, "/"));
            }
          }
          for (const e of entries) {
            if (e.isDirectory() && (e.name === "node_modules" || !e.name.startsWith("."))) {
              stack.push(path.join(dir, e.name));
            }
          }
        }
      }
      check(
        "no dependency ships a NOTICE file that the notices omit",
        unpropagated.length === 0,
        `unpropagated: ${unpropagated.slice(0, 8).join(", ")}`,
      );
    }

    // OFL-1.1 clause 2 is stricter than the MIT-style notices above: the
    // licence has to travel WITH the font files, not merely be reproduced
    // somewhere in the distribution.
    check(
      "the OFL ships beside the fonts it covers",
      fs.existsSync(path.join(ROOT, "fonts", "LICENSE-FiraCode.txt")) &&
        isPackaged(files, "fonts/LICENSE-FiraCode.txt"),
    );
    check(
      "Tabulator's licence ships beside the code it covers",
      fs.existsSync(path.join(ROOT, "libs", "tabulator", "LICENSE")) &&
        isPackaged(files, "libs/tabulator/LICENSE"),
    );

    // LICENSE and LICENSE.txt both exist because both are load-bearing:
    // GitHub's licence detection and README's link want `LICENSE`, while the
    // NSIS installer agreement page is configured to `LICENSE.txt`. Two files
    // that must agree by discipline alone had already drifted - one said 2025
    // and the other 2026 - so the agreement is asserted rather than assumed.
    const licA = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    const licB = fs.readFileSync(path.join(ROOT, "LICENSE.txt"), "utf8");
    check(
      "LICENSE and LICENSE.txt have not drifted apart",
      licA === licB,
      "the NSIS installer shows LICENSE.txt; GitHub and README show LICENSE",
    );
    // MIT requires the ORIGINAL copyright notice to be retained in derivative
    // works, so the upstream line is not optional and must not be replaced by
    // the fork's own.
    check(
      "LICENSE retains the upstream copyright, as MIT requires of a derivative",
      /Copyright \(c\) [\d-]*2025[\d-]* Omnicore/.test(licA),
      licA.split("\n").slice(0, 5).join(" | "),
    );
    check(
      "LICENSE also asserts the fork's own copyright",
      /Copyright \(c\) .*lostinsea/.test(licA),
      licA.split("\n").slice(0, 5).join(" | "),
    );
    // The intermediate fork's author never added a copyright line for himself,
    // so MIT's retention clause does not strictly compel this one. It is here
    // because his authorship is a FACT about the code this fork ships (43
    // commits in the inherited history, measured with `git shortlog -s`), and
    // copyright vests in an author whether or not he asserts it in a file.
    // Asserted rather than left to discipline: a future rewrite of the header
    // would otherwise drop an attribution that nothing else in the tree records.
    check(
      "LICENSE credits the intermediate fork's author, whose code this fork inherits",
      /Copyright \(c\) .*Moyseyenko/.test(licA),
      licA.split("\n").slice(0, 5).join(" | "),
    );
    check(
      "the NSIS installer agreement points at a licence file that exists",
      Boolean(pkg.build && pkg.build.nsis && pkg.build.nsis.license) &&
        fs.existsSync(path.join(ROOT, pkg.build.nsis.license)),
      pkg.build && pkg.build.nsis && pkg.build.nsis.license,
    );
  }

  // ── Localisation removal ─────────────────────────────────────────────────
  // The Turkish and Ukrainian locales and the language switcher were removed:
  // both arrived from the two upstream forks and neither served this product.
  // These oracles are static because the failure mode is a *leftover*, and a
  // leftover is a source fact. The i18n() seam is deliberately retained, so
  // "no localisation" cannot be asserted by its absence - it has to be
  // asserted against the specific machinery that was taken out.
  {
    const rendererSrc = fs.readFileSync(path.join(SRC, "renderer.js"), "utf8");
    const htmlSrc = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
    // "Shipped" is defined by package.json build.files, not by a hand-kept list
    // here. An earlier version of this block scanned only renderer.js,
    // index.html and custom-*.js while claiming to cover every shipped file -
    // which silently exempted main.js, popup-preload.js and the seven helper
    // modules from the leftover sweep. Deriving the list from the manifest
    // means adding a script to the package automatically puts it in scope.
    const shippedScripts = pkg.build.files.filter(
      (f) => /^[^!*]+\.js$/.test(f) && fs.existsSync(path.join(ROOT, f)),
    );
    const allSrc =
      htmlSrc +
      "\n" +
      shippedScripts
        .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
        .join("\n");

    // Vacuity guard: if the manifest filter matched nothing (or almost
    // nothing) every "is gone" assertion below would pass by scanning air.
    check(
      "the shipped-script list really was resolved from the packaging manifest",
      shippedScripts.length >= 12 &&
        shippedScripts.includes("src/renderer.js") &&
        shippedScripts.includes("src/main.js") &&
        shippedScripts.includes("src/popup-preload.js"),
      `${shippedScripts.length}: ${shippedScripts.join(", ")}`,
    );

    check(
      "the language switcher is gone from every shipped script",
      !/interfaceLang|applyInterfaceLang|langSubmenu|data-lang=/.test(allSrc),
      (allSrc.match(/interfaceLang|applyInterfaceLang|langSubmenu|data-lang=/g) || [])
        .join(", "),
    );

    // The instance-level check lives in test:security (N10). This is the CLASS:
    // no Turkish-SPECIFIC letter survives anywhere in shipped source (see the
    // narrower claim spelled out below - this is not "no Turkish text"). It is
    // the only thing that would catch the NEXT one, and it is exactly what was
    // missing - the
    // string N10 removed evaded the original locale sweep because it was a raw
    // literal spliced into innerHTML rather than an entry in the i18n table.
    //
    // Restricted to the six letters unique to Turkish. c-cedilla, o- and
    // u-umlaut are shared with French, German and Spanish, so including them
    // would make this fire on legitimate content one day.
    //
    // The name is deliberately narrow. This does NOT prove "no Turkish text":
    // Duzenle and Gorunum carry only umlauts, and Kaydet, Kapat, Ekle, Tablo -
    // and the two likeliest menu leftovers, Edit and View - are pure ASCII. It
    // proves no Turkish-SPECIFIC letter survives, which is the low-noise half
    // of the problem and the half that catches prose.
    const TURKISH_CHARS = /[\u011E\u011F\u0130\u0131\u015E\u015F]/;
    check(
      "the Turkish sweep's own character class actually matches Turkish",
      TURKISH_CHARS.test("Geçersiz tablo formatı") &&
        !TURKISH_CHARS.test("Invalid table format"),
      "character class does not discriminate",
    );
    check(
      "no Turkish-specific letter survives in any shipped script",
      !TURKISH_CHARS.test(allSrc),
      (allSrc.match(new RegExp(TURKISH_CHARS.source, "g")) || []).join(", "),
    );

    // N10 built the table dialog's validation error as a node instead of
    // assigning markup. That property is invisible from the DOM - an innerHTML
    // assignment producing the same element is indistinguishable afterwards -
    // so it can only be pinned at the source, here.
    //
    // Scoped to the one function AND the one element on purpose. The dialog's
    // LEGITIMATE renderers (updateTablePreview, and openTableInsertDialog's
    // edit path) assign sanitizeTableHtml() output into the preview through
    // innerHTML, and insertTableFromDialog itself uses innerHTML on a DETACHED
    // div to parse-test the markdown - so neither a file-wide nor a
    // function-wide ban would be true. What must not come back is markup
    // assigned into the LIVE preview from this function.
    //
    // The slice runs to the next COLUMN-0 "}", which is the function's own
    // closing brace - every brace inside the body is indented, so a nested one
    // cannot truncate it. MEASURED rather than assumed: the slice spans
    // renderer.js:9235-9346, 112 lines, 4408 chars, i.e. the whole function.
    // The vacuity guard pins BOTH ends, because "the body was located" and
    // "the body was wholly located" are different claims and only the first is
    // proven by a length floor: TAIL_MARKER sits at 86% of the body, so a
    // future reformat that did introduce a column-0 brace mid-function would
    // shrink the scope loudly instead of silently narrowing what is swept.
    {
      const TAIL_MARKER = "showNotification('Table inserted', 1000)";
      const start = rendererSrc.indexOf("\nfunction insertTableFromDialog() {");
      const body =
        start === -1 ? "" : rendererSrc.slice(start, rendererSrc.indexOf("\n}", start));
      check(
        "the insertTableFromDialog body was located in full, so the check below reads the whole function",
        start !== -1 &&
          body.length > 400 &&
          body.includes("table-insert-error") &&
          body.includes(TAIL_MARKER),
        `start=${start} len=${body.length} tail=${body.includes(TAIL_MARKER)}`,
      );
      check(
        "the table dialog's validation error is built as a node, not assigned as markup",
        !/tableInsertPreviewEl\s*\.\s*innerHTML/.test(body),
        (body.match(/.*tableInsertPreviewEl\s*\.\s*innerHTML.*/g) || []).join(" | "),
      );
    }

    // N12 - the same property for renderMarkdownFull's tail catch. Node-
    // building is unobservable from the DOM (an innerHTML assignment producing
    // the same element is indistinguishable afterwards), so the behavioural
    // assertions in test:security pin what the banner LOOKS like and this pins
    // how it is BUILT. Measured, not reasoned: the payload below was applied to
    // renderer.js by hand and test:security run against it - both N12 DOM
    // assertions still PASSED.
    //
    // SCOPED TO THE CATCH BLOCK, not the function, and that scope was chosen by
    // MEASUREMENT rather than for tidiness. renderMarkdownFull assigns
    // innerHTML three times legitimately - the mermaid SVG cache twice and the
    // maximize button's icon once - so a function-wide ban on innerHTML would
    // simply be false, and a ban narrowed to `viewer.innerHTML` would wave
    // through the realistic accident of building the banner's own subtree from
    // a string. Inside the catch the measured count is ZERO, so the ban there
    // is both total and true.
    //
    // The catch is the last block of the function, so it runs to the function's
    // own COLUMN-0 "}" - every brace inside the body is indented, so a nested
    // one cannot truncate it. Both ends are pinned, because "the block was
    // located" and "the block was wholly located" are different claims and a
    // length floor only proves the first. TAIL_MARKER is deliberately the one
    // statement a banner rewrite would NOT touch, so a future innerHTML version
    // fails the BAN (naming the defect) rather than the vacuity guard (naming
    // the instrument).
    {
      const TAIL_MARKER = "hideLoadingScreenFor(generation);";
      const fnStart = rendererSrc.indexOf("\nasync function renderMarkdownFull(");
      const fnEnd = fnStart === -1 ? -1 : rendererSrc.indexOf("\n}", fnStart);
      const catchStart =
        fnStart === -1 ? -1 : rendererSrc.indexOf("\n  } catch (error) {", fnStart);
      const body =
        catchStart === -1 || catchStart > fnEnd
          ? ""
          : rendererSrc.slice(catchStart, fnEnd);
      check(
        "the renderMarkdownFull catch block was located in full, so the check below reads the whole handler",
        fnStart !== -1 &&
          catchStart !== -1 &&
          catchStart < fnEnd &&
          body.length > 400 &&
          body.includes("Error rendering markdown:") &&
          body.includes(TAIL_MARKER),
        `fn=${fnStart} catch=${catchStart} end=${fnEnd} len=${body.length} tail=${body.includes(TAIL_MARKER)}`,
      );
      check(
        "the markdown render-failure banner is built as nodes, not assigned as markup",
        !/\.\s*innerHTML/.test(body),
        (body.match(/.*\.\s*innerHTML.*/g) || []).join(" | "),
      );
    }

    check(
      "the Ukrainian overlay file is deleted, not merely unregistered",
      !fs.existsSync(path.join(ROOT, "custom-language.js")) &&
        !/custom-language\.js/.test(htmlSrc) &&
        !JSON.stringify(pkg.build.files).includes("custom-language.js"),
      "custom-language.js still present on disk, in index.html, or in build.files",
    );

    check(
      "the emptied Tools menu was removed rather than left as a dead button",
      !/id="toolsBtn"|id="toolsMenu"/.test(htmlSrc) &&
        !/toolsBtn|toolsMenu/.test(rendererSrc),
      "toolsBtn/toolsMenu references survive",
    );

    // The View menu shares the .tools-* CSS class family with the removed
    // Tools menu, and custom-theme.js injects its Theme submenu into it. A
    // deletion that took the classes with it would silently unstyle both, so
    // the survivors are pinned explicitly.
    const cssSrc = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
    check(
      "the shared submenu styling the Theme menu depends on survived the removal",
      // Anchored at line start on purpose: an unanchored /\.tools-submenu\s*\{/
      // is also satisfied by the descendant selector
      // ".tools-menu-item.has-submenu:hover > .tools-submenu {", so deleting
      // the standalone rule that actually positions and hides the panel left
      // the check green. R175 measured that.
      /^\.tools-submenu\s*\{/m.test(cssSrc) &&
        /^\.tools-submenu-item\s*\{/m.test(cssSrc) &&
        /^\.submenu-arrow\s*\{/m.test(cssSrc) &&
        /\.tools-menu-item\.has-submenu:hover\s*>\s*\.tools-submenu\s*\{/.test(
          cssSrc,
        ) &&
        /id="viewMenu"/.test(htmlSrc),
      "custom-theme.js builds .tools-menu-item.has-submenu > .tools-submenu inside #viewMenu",
    );

    // UI_STRINGS is now a flat single-locale table. Parse it and require every
    // key to have a consumer. Without this the table silently accumulates dead
    // entries: 19 were already unreferenced before the locales were removed,
    // and nothing would ever have said so.
    const lines = rendererSrc.split(/\r?\n/);
    const iDecl = lines.indexOf("const UI_STRINGS = {");
    const iEnd = lines.indexOf("};", iDecl);
    const tableBody = lines.slice(iDecl + 1, iEnd).join("\n");
    const uiKeys = [];
    const keyRe = /'((?:[^'\\]|\\.)*)':\s*'/g;
    let km;
    while ((km = keyRe.exec(tableBody))) uiKeys.push(km[1]);

    check(
      "UI_STRINGS is a flat single-locale table",
      iDecl >= 0 && iEnd > iDecl && !/^\s{2}(en|tr|uk):\s*\{/m.test(tableBody),
      `iDecl=${iDecl} iEnd=${iEnd}`,
    );

    // Vacuity guard: a parse that finds nothing would make the sweep below
    // pass by measuring an empty set.
    check(
      "the UI string table really was parsed",
      uiKeys.length >= 100,
      `${uiKeys.length} keys parsed`,
    );

    // Reference syntaxes recognised here: i18n('key'), the data-i18n family,
    // and custom-tabs.js's local t('key', fallback) wrapper. That wrapper is
    // the reason this list is explicit rather than a bare i18n() match - an
    // overlay key reachable ONLY through t() would otherwise be swept up as
    // dead and deleted. Any future indirection must be added here too.
    const orphaned = uiKeys.filter((k) => {
      const q = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return (
        !new RegExp(`i18n\\(\\s*['"\`]${q}['"\`]`).test(allSrc) &&
        !new RegExp(`\\bt\\(\\s*['"\`]${q}['"\`]`).test(allSrc) &&
        !new RegExp(`data-i18n(?:-title|-placeholder)?="${q}"`).test(allSrc)
      );
    });
    check(
      "every UI string has a consumer",
      orphaned.length === 0,
      `${orphaned.length} unreferenced: ${orphaned.join(", ")}`,
    );
  }

  // ── Word export removal ──────────────────────────────────────────────────
  // Export to Word was removed with its html-to-docx dependency. The removal
  // is worth pinning for two reasons that pull in different directions:
  //
  //  - html-to-docx was one of only two production dependencies, and its
  //    closure was 70 packages / 13.00 MB that nothing else in the tree
  //    shared. A re-added `dependencies` entry ships that to every user again
  //    whether or not any code calls it, which is the R159 failure mode.
  //  - The renderer-side rasteriser (mermaidToPngDataUrl) was left with NO
  //    caller once the Word handler went, so it was removed too. Dead code
  //    that is still tested reads as live code to the next maintainer.
  //
  // Static oracles, because a leftover is a source fact.
  {
    const shippedScripts = pkg.build.files.filter(
      (f) => /^[^!*]+\.js$/.test(f) && fs.existsSync(path.join(ROOT, f)),
    );
    const htmlSrc = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
    const allSrc =
      htmlSrc +
      "\n" +
      shippedScripts
        .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
        .join("\n");

    check(
      "html-to-docx is gone from the manifest, the lockfile and node_modules",
      !Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, "html-to-docx") &&
        !Object.prototype.hasOwnProperty.call(
          pkg.devDependencies || {},
          "html-to-docx",
        ) &&
        !fs.existsSync(path.join(ROOT, "node_modules", "html-to-docx")) &&
        !fs
          .readFileSync(path.join(ROOT, "package-lock.json"), "utf8")
          .includes("html-to-docx"),
      "a surviving entry in any of the four reinstalls the whole 70-package closure",
    );

    // Stated as a bound rather than an exact set so that adding a dependency
    // is a deliberate act with a visible cost, not a silent one.
    check(
      "the tree still declares exactly one production dependency",
      Object.keys(pkg.dependencies || {}).length === 1 &&
        Object.prototype.hasOwnProperty.call(
          pkg.dependencies || {},
          "electron-updater",
        ),
      JSON.stringify(Object.keys(pkg.dependencies || {})),
    );

    check(
      "the Word export path is gone from every shipped script",
      !/exportWord|export-word|word-export|HTMLtoDOCX|html-to-docx/.test(allSrc),
      (
        allSrc.match(
          /exportWord|export-word|word-export|HTMLtoDOCX|html-to-docx/g,
        ) || []
      ).join(", "),
    );

    check(
      "the Word menu item was removed rather than left hidden",
      !/id="exportWord"/.test(htmlSrc) && !/\.docx/.test(allSrc),
      "an #exportWord element or a .docx mention survives in the shipped source",
    );

    // The name of the format is not the only way it can come back. The Word
    // MIME types are what a save dialog filter and a Blob type are written
    // with, and neither contains the string "docx" or "word-export", so the
    // sweeps above would both pass while a half-restored export path sat in
    // the tree. Cheap to state, and it costs nothing while the feature is gone.
    check(
      "no Word document MIME type survives in any shipped script",
      !/wordprocessingml|application\/msword/i.test(allSrc),
      (allSrc.match(/wordprocessingml|application\/msword/gi) || []).join(", "),
    );

    // Dead UI strings are already swept generally, a few assertions above
    // ("every UI string has a consumer"), and that sweep is strictly stronger
    // than a Word-specific one: it requires each key to appear in a CALL
    // position rather than merely somewhere in the file. It is what caught the
    // orphaned 'mermaid.error' string this removal left behind, so the six
    // labels the Word menu item owned need no separate assertion here.

    // The rasteriser existed only to embed diagrams into the DOCX. Leaving it
    // behind would keep ~120 lines of renderer parsed on every launch, plus
    // the two test sections that measured it, for a feature that no longer
    // exists. The image-zoom popup does its own rasterising in its own window.
    check(
      "the orphaned export rasteriser was removed with its only caller",
      !/mermaidToPngDataUrl/.test(allSrc),
      "mermaidToPngDataUrl survives with no caller",
    );

    // --- THE VENDORED-INLINING INVARIANT --------------------------------
    // main.js splices two hand-vendored files into the table popup's HTML as
    // element CONTENT: tabulator.min.js inside <script> and tabulator.min.css
    // inside <style>. Those are the only two files inlined that way, so this
    // invariant is deliberately scoped to them rather than stated over libs/.
    //
    // The hazard is the HTML tokenizer, not JavaScript. Inside a <script>, the
    // parser is scanning raw text for the byte sequence "</script" - it does
    // not know or care that the sequence sits inside a JS string literal or a
    // regex. A vendored bundle containing one would terminate the element
    // early, and everything after it would be parsed as MARKUP in a window
    // whose CSP permits inline styles. "<script", "<!--" and "-->" are the
    // same class of hazard via the script-data double-escaped states.
    //
    // A runtime escape was considered and rejected: rewriting "</script" to
    // "<\/script" is safe in a string literal but not inside a regex character
    // class, and the bundle is minified, so a blanket rewrite could silently
    // change its behaviour. These two files are hand-vendored and change only
    // on a deliberate upgrade, so a build-time invariant is the honest control.
    const inlined = [
      ["libs/tabulator/tabulator.min.js", ["</script", "<script", "<!--", "-->"]],
      ["libs/tabulator/tabulator.min.css", ["</style", "<script", "<!--", "-->"]],
    ];
    const inlineHits = [];
    for (const [rel, needles] of inlined) {
      const body = fs.readFileSync(path.join(ROOT, rel), "utf8").toLowerCase();
      for (const n of needles) if (body.includes(n)) inlineHits.push(`${rel}: ${n}`);
    }
    // POSITIVE CONTROL. Every reading above is an ABSENCE, so a typo in a
    // needle, a bad path, or an empty read would report "clean" while
    // measuring nothing. Run the same matcher over a string that is known to
    // contain each needle and require it to find all of them.
    const controlBody = "x</script<script<!-- -->y</style".toLowerCase();
    const controlFound = [
      "</script",
      "<script",
      "<!--",
      "-->",
      "</style",
    ].filter((n) => controlBody.includes(n)).length;
    check(
      "the inlining needle matcher actually matches, so its absences mean something",
      controlFound === 5,
      `matched ${controlFound}/5 needles in the planted control`,
    );
    check(
      "no vendored file inlined into the table popup can terminate its own element",
      inlineHits.length === 0,
      inlineHits.join(", "),
    );
  }

  const strict = process.env.PACKAGING_STRICT === "1";
  if (strict && skipped.length) {
    check(
      "no oracle was skipped (PACKAGING_STRICT=1)",
      false,
      `skipped: ${skipped.join(", ")} - the release must verify the artefact, not merely fail to contradict it`,
    );
  }
  console.log(
    `\n=== ${pass} passed, ${fail} failed${skipped.length ? `, ${skipped.length} SKIPPED: ${skipped.join(", ")}` : ""} ===\n`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`FAIL  packaging suite exception  -> ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
