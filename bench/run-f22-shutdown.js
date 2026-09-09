// Parent for the F22 process-isolated acceptance gate.
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const WORKER = path.join(__dirname, "bench-f22-shutdown.js");
const ELECTRON = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
const PROTOCOL_VERSION = 1;
const BUDGET_MS = 16.7;
const SIZES = [50 * 1024, 500 * 1024, 2 * 1024 * 1024];
const TABS = [1, 10, 25];
const COLD_SAMPLES = 20;
const WARMUPS = 10;
const WARM_SAMPLES = 40;
const CRLF_SAMPLES = 20;
// The all-dirty worst case pays a full comparison of every open document on
// every sample, so it is deliberately the smallest sample count this project
// will accept rather than the largest it could afford: bench/run.js refuses
// --reps=2 on the grounds that a median needs at least three, and twenty keeps
// a p95 meaningful (the 19th value) while keeping 25 x 2 MB x 20 within the
// runtime a machine-exclusive gate can reasonably occupy.
const DIRTY_SAMPLES = 20;
// Per mode, because they are not the same workload. The all-dirty modes read
// and rebuild 50 MB of document text per sample; the CRLF one additionally
// normalises both sides of every comparison, which is the most expensive path
// in the product and the slowest thing measured here.
const WORKER_TIMEOUTS_MS = {
  default: 60000,
  warm: 120000,
  "dirty-lf": 180000,
  "dirty-crlf": 300000,
  // The active-editor observations pay the same per-sample rebuild plus a real
  // 2 MB textarea assignment and reconciliation.
  "edit-lf": 180000,
  "edit-crlf": 300000,
};
// One table rather than a chain of ternaries, so adding an observation cannot
// silently inherit another mode's expected sample count.
const EXPECTED_SAMPLES = {
  cold: 1,
  anti: 1,
  lifecycle: 1,
  listener: WARM_SAMPLES,
  warm: WARM_SAMPLES,
  crlf: CRLF_SAMPLES,
  "dirty-lf": DIRTY_SAMPLES,
  "dirty-crlf": DIRTY_SAMPLES,
  "edit-lf": DIRTY_SAMPLES,
  "edit-crlf": DIRTY_SAMPLES,
};
// The observations whose answer must name every open document, in tab order.
const ORACLE_MODES = new Set(["dirty-lf", "dirty-crlf", "edit-lf", "edit-crlf"]);
const DIAGNOSTIC = process.argv.includes("--diagnostic");
const token = crypto.randomBytes(16).toString("hex");
const runRoot = path.join(__dirname, `.f22-process-run-${token}`);
const lockPath = path.join(__dirname, ".f22-process.lock");
const failures = [];

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function stable(value) {
  return JSON.stringify(value);
}

function digest(value) {
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}

function fail(message) {
  failures.push(message);
  console.error(`FAIL  ${message}`);
}

function stats(values) {
  if (!values.length) return { n: 0, min: null, p50: null, p95: null, max: null };
  const sorted = values.slice().sort((a, b) => a - b);
  const at = (q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
  // RAW SAMPLES, NEVER ROUNDED. Every budget comparison below reads these
  // fields, and this function used to round them to three decimals before
  // returning: a p95 of 16.7004 ms became 16.7, which is not greater than a
  // 16.7 ms budget, so the gate passed on a sample that exceeded it. Rounding
  // is presentation, and presentation is reported() below.
  return {
    n: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1),
  };
}

// The printed form. Separate from stats() on purpose: a reader wants three
// decimals, a gate wants the number that was actually measured, and the moment
// those are the same object the gate starts reading the reader's copy.
function reported(measured) {
  const round = (value) => (value === null ? null : +value.toFixed(3));
  return {
    n: measured.n,
    min: round(measured.min),
    p50: round(measured.p50),
    p95: round(measured.p95),
    max: round(measured.max),
  };
}

// One place that decides pass/fail, so a new observation cannot quietly ship
// with the comparison spelled differently. Reads the raw p95; prints both.
function enforceBudget(label, measured) {
  if (measured.p95 === null || measured.p95 <= BUDGET_MS) return;
  fail(
    `${label} p95=${measured.p95}ms (reported ${reported(measured).p95}ms) exceeds ${BUDGET_MS}ms`,
  );
}

// EVERY OBSERVATION IS RECORDED, NOT JUST PRINTED. The run directory holding
// the workers' result files is deleted on the way out - it has to be, it is
// keyed to a token and nothing else would ever clean it up - and the console
// carried only three-decimal figures. So a run that produced a real, reportable
// number left nothing behind that could be filed as evidence, and the numbers
// this project records have to be reproducible from something other than a
// scrollback buffer. Each observation keeps its RAW samples here.
const observations = [];

function record(point, mode, measured, samples, extra = {}) {
  observations.push({
    point,
    mode,
    n: measured.n,
    raw: { min: measured.min, p50: measured.p50, p95: measured.p95, max: measured.max },
    reported: reported(measured),
    budgetMs: BUDGET_MS,
    withinBudget: measured.p95 === null ? null : measured.p95 <= BUDGET_MS,
    samples: samples.slice(),
    ...extra,
  });
}

function realisticContent(size) {
  const paragraph = (
    "This representative markdown paragraph contains ordinary prose, punctuation, " +
    "links [example](https://example.test), and a small table-like sequence | one | two | three |. " +
    "It is intentionally long enough that headings occur at realistic document density rather than " +
    "at every short line. "
  ).repeat(6) + "\n\n";
  const chunks = [];
  let bytes = 0;
  for (let i = 1; bytes < size; i += 1) {
    const chunk = `# Shutdown benchmark section ${i}\n\n${paragraph}`;
    const remaining = size - bytes;
    const part = Buffer.byteLength(chunk) <= remaining ? chunk : chunk.slice(0, remaining);
    chunks.push(part);
    bytes += Buffer.byteLength(part);
  }
  const content = chunks.join("");
  if (Buffer.byteLength(content) !== size) {
    throw new Error(`fixture construction requested=${size} actual=${Buffer.byteLength(content)}`);
  }
  return content;
}

function writeFixtures() {
  const root = path.join(runRoot, "fixtures");
  fs.mkdirSync(root, { recursive: true });
  const fixtures = { primary: new Map(), crlf: new Map() };
  const activeSizes = DIAGNOSTIC ? [SIZES[0]] : SIZES;
  const activeTabs = DIAGNOSTIC ? [TABS[0]] : TABS;
  for (const size of activeSizes) {
    const text = realisticContent(size);
    const files = [];
    const crlfFiles = [];
    for (let index = 0; index < Math.max(...activeTabs); index += 1) {
      const file = path.join(root, `realistic-${size}-${index}.md`);
      fs.writeFileSync(file, text, "utf8");
      const bytes = fs.statSync(file).size;
      if (bytes !== size) throw new Error(`primary fixture ${file} bytes=${bytes} expected=${size}`);
      files.push({
        file,
        requestedBytes: size,
        bytes,
        digest: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      });
      const crlf = path.join(root, `crlf-${size}-${index}.md`);
      fs.writeFileSync(crlf, text.replace(/\n/g, "\r\n"), "utf8");
      const crlfBytes = fs.statSync(crlf).size;
      // CRLF carries one extra byte per newline. The logical document target
      // stays size; the exact on-disk framing overhead is recorded and proved.
      if (crlfBytes <= size) throw new Error(`CRLF fixture ${crlf} lost framing overhead`);
      crlfFiles.push({
        file: crlf,
        requestedBytes: size,
        bytes: crlfBytes,
        digest: crypto.createHash("sha256").update(fs.readFileSync(crlf)).digest("hex"),
      });
    }
    fixtures.primary.set(size, files);
    fixtures.crlf.set(size, crlfFiles);
  }
  return fixtures;
}

function createJob(mode, point, size, tabCount, ordinal, fixtures, fixtureKind = "primary") {
  const id = `${mode}-${size}-${tabCount}-${ordinal}`;
  const profile = path.join(runRoot, "profiles", id);
  const resultFile = path.join(runRoot, "results", `${id}.json`);
  fs.mkdirSync(profile, { recursive: true });
  if (fs.readdirSync(profile).length !== 0) throw new Error(`non-empty profile ${profile}`);
  const envelope = {
    protocolVersion: PROTOCOL_VERSION,
    token,
    id,
    mode,
    point,
    size,
    tabCount,
    // Carried explicitly rather than derived from the mode. The worker's
    // fixture check has to know whether these bytes are supposed to be the
    // exact requested size (LF) or that size plus one byte per newline (CRLF),
    // and inferring that from the mode name is how a new CRLF observation
    // silently gets checked against the wrong invariant.
    fixtureKind,
    files: fixtures[fixtureKind].get(size).slice(0, tabCount).map((fixture) => fixture.file),
    fixtureBytes: fixtures[fixtureKind].get(size).slice(0, tabCount).map((fixture) => fixture.bytes),
    fixtureDigests: fixtures[fixtureKind].get(size).slice(0, tabCount).map((fixture) => fixture.digest),
    fixtureRequestedBytes: size,
    profile,
    resultFile,
  };
  envelope.digest = digest(envelope);
  const jobFile = path.join(runRoot, "jobs", `${id}.json`);
  fs.writeFileSync(`${jobFile}.tmp`, stable(envelope), "utf8");
  fs.renameSync(`${jobFile}.tmp`, jobFile);
  return { ...envelope, jobFile };
}

function coldJobs(fixtures) {
  const points = [];
  const sizes = DIAGNOSTIC ? [SIZES[0]] : SIZES;
  const tabs = DIAGNOSTIC ? [TABS[0]] : TABS;
  for (const size of sizes) for (const tabCount of tabs) points.push({ size, tabCount });
  const jobs = [];
  // Fixed round-robin rotation: every round visits every point once, and the
  // starting point rotates. Results never influence the schedule.
  for (let round = 0; round < COLD_SAMPLES; round += 1) {
    for (let offset = 0; offset < points.length; offset += 1) {
      const point = points[(round + offset) % points.length];
      jobs.push(
        createJob(
          "cold",
          `primary/${point.size}B/${point.tabCount}tabs`,
          point.size,
          point.tabCount,
          round,
          fixtures,
        ),
      );
    }
  }
  return jobs;
}

function runWorker(job) {
  return new Promise((resolve) => {
    const child = spawn(ELECTRON, [WORKER, "--f22-worker", job.jobFile], {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, F22_PROCESS_WORKER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    // NO WORKER MAY OUTLIVE THE EXCLUSIVITY THIS RUN HOLDS. The lock says "one
    // benchmark on this machine"; a worker still running when the lock is
    // removed makes that false, and the next run measures a machine that is
    // busy with the last one. Registered before anything can go wrong, cleared
    // only when the process tree has actually closed.
    //
    // The value is a promise that settles on that CLOSE. Cleanup awaits these
    // rather than polling for an exit code: 'exit' says the main process ended,
    // 'close' says its stdio - and therefore its descendants holding it - are
    // gone, and only the second of those is the claim the lock makes.
    let markClosed;
    const closed = new Promise((resolve) => {
      markClosed = resolve;
    });
    liveWorkers.set(child, closed);
    let output = "";
    let settled = false;
    let timer = null;
    const workerErrors = [];
    let firstWorkerError = null;
    let terminatingForWorkerError = false;
    // Recorded the instant the budget is blown, not when the settlement is
    // built. A worker that closes DURING its own termination settles through
    // the 'close' handler, and without this flag that race would erase the
    // fact that it overran - so the matrix would keep scheduling on a machine
    // whose last job had to be killed.
    let budgetExceeded = false;

    const clearTimers = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    // EXACTLY ONE SETTLEMENT, FROM WHICHEVER EVENT ARRIVES FIRST. 'error' and
    // 'close' can both fire for one failed spawn, in either order, and a worker
    // that ignores its kill would otherwise leave this promise pending forever
    // - which in this parent means main()'s finally never runs, and the
    // exclusive benchmark lock plus the whole run directory are left behind for
    // the next run to trip over.
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimers();
      // `timedOut` last: it is a fact about the run, not a field a settlement
      // may overwrite.
      resolve({ output, pid: child.pid, ...result, timedOut: budgetExceeded });
    };

    const resultWithWorkerErrors = (result) => ({
      ...result,
      ...(firstWorkerError ? { firstWorkerError } : {}),
      ...(workerErrors.length ? { workerErrors: workerErrors.slice() } : {}),
    });

    // A stream error is not merely lost diagnostic text. It proves that the
    // parent's observation channel broke while the child may still be alive,
    // so letting the scheduler start another worker would violate the lock's
    // exclusivity claim just as surely as a timeout would.
    const failClosedWorkerError = (source, error) => {
      if (settled) return;
      if (!firstWorkerError) firstWorkerError = error;
      const detail = `${source} error: ${error && error.stack ? error.stack : error}`;
      workerErrors.push(detail);
      output += `\n${detail}\n`;
      if (terminatingForWorkerError) return;
      terminatingForWorkerError = true;

      // An error before spawn created a process has no tree to wait for. Every
      // other error is fail-closed: terminate it and do not settle this job
      // until close proves its streams and descendants are gone.
      if (child.pid === undefined) {
        liveWorkers.delete(child);
        markClosed();
        settle(
          resultWithWorkerErrors({
            code: null,
            signal: null,
            spawnError: String(error && error.message ? error.message : error),
            closureProven: true,
          }),
        );
        return;
      }
      terminateWorker(child).then((closureProven) => {
        settle(
          resultWithWorkerErrors({
            code: child.exitCode,
            signal: child.signalCode,
            closureProven,
          }),
        );
      });
    };

    child.stdout.on("data", (data) => { output += data; });
    child.stderr.on("data", (data) => { output += data; });
    // The first error decides the failure and starts the termination ladder.
    // Once consumed, however, a one-shot listener would leave a later EventEmitter
    // error uncaught. Install a durable sink before processing the first error;
    // later errors cannot replace the first-error object or settle the job again.
    const observeWorkerErrors = (emitter, source) => {
      emitter.once("error", (error) => {
        emitter.on("error", (laterError) => failClosedWorkerError(source, laterError));
        failClosedWorkerError(source, error);
      });
    };
    observeWorkerErrors(child.stdout, "stdout");
    observeWorkerErrors(child.stderr, "stderr");
    // AN UNHANDLED 'error' IS A CRASH, NOT A FAILED WORKER. Node reports an
    // asynchronous spawn failure - a missing electron.exe, a denied exec - as
    // an 'error' event, and an EventEmitter with no listener for it THROWS.
    // That exception escapes this promise, becomes an uncaught exception in the
    // parent, and terminates the process without unwinding main()'s cleanup.
    // Recorded as a normal non-zero settlement instead: validateResult() then
    // reports a worker that exited badly and published no result, and the run
    // fails through the ordinary path with its lock and directory cleaned up.
    observeWorkerErrors(child, "child process");
    // Only a CLOSE proves the process tree is gone. 'exit' fires when the main
    // process ends but its stdio may still be held by descendants, and this
    // parent's whole claim is that nothing of the last job is still running.
    child.on("close", (code, signal) => {
      liveWorkers.delete(child);
      markClosed();
      settle(resultWithWorkerErrors({ code, signal, closureProven: true }));
    });
    timer = setTimeout(() => {
      // A TIMED-OUT JOB ENDS THE MATRIX, IT DOES NOT YIELD A SAMPLE. Whatever
      // this worker is doing, it is still doing it - and every job after it
      // would have been measured on a machine running two Electron trees at
      // once. That is not a slow number, it is a wrong one, and it would be
      // reported as a gate result. So this terminates THIS child, waits for its
      // actual close, and reports whether that could be proven; the caller
      // stops scheduling either way.
      output += "\nworker exceeded its budget; terminating\n";
      budgetExceeded = true;
      terminateWorker(child).then((closureProven) => {
        settle(resultWithWorkerErrors({
          code: child.exitCode,
          signal: child.signalCode,
          closureProven,
        }));
      });
    }, WORKER_TIMEOUTS_MS[job.mode] || WORKER_TIMEOUTS_MS.default);
  });
}

// Every worker this run started that has not been observed CLOSING, mapped to
// the promise that settles when it does. See runWorker() and
// terminateLiveWorkers().
const liveWorkers = new Map();

// ONE TERMINATION PER CHILD, HOWEVER MANY CALLERS ASK FOR IT. The timeout path
// and the end-of-run sweep can both want the same worker gone, and two
// escalation ladders racing on one process produce two verdicts about whether
// it closed. The first caller owns the ladder; the second awaits its answer.
const terminations = new Map();

// Ask, then insist, then say honestly whether it worked. `kill()` on a child
// that has already exited is a no-op, so the escalation is safe to repeat.
//
// @returns {Promise<boolean>} true only when this child's 'close' was observed.
function terminateWorker(child) {
  const existing = terminations.get(child);
  if (existing) return existing;
  const closed = liveWorkers.get(child);
  if (!closed) return Promise.resolve(true); // already observed closing
  const attempt = (async () => {
    try {
      child.kill();
    } catch (error) {
      fail(`worker ${child.pid} could not be terminated: ${error.message}`);
    }
    if (await waitBounded(closed, TERMINATION_GRACE_MS)) return true;
    try {
      // On Windows SIGKILL maps to TerminateProcess, which the polite signal
      // above does not guarantee.
      child.kill("SIGKILL");
    } catch (error) {
      fail(`worker ${child.pid} could not be force-terminated: ${error.message}`);
    }
    return waitBounded(closed, TERMINATION_KILL_MS);
  })();
  terminations.set(child, attempt);
  return attempt;
}

// A bounded wait that never blocks the loop. The timer is cleared on the fast
// path so a settled wait cannot keep the process alive by itself.
function waitBounded(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve(false);
    }, ms);
    promise.then(() => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

const TERMINATION_GRACE_MS = 5000;
const TERMINATION_KILL_MS = 5000;

// NOTHING MAY BE LAUNCHED AFTER A JOB WENT WRONG IN A WAY THAT CAN CONTAMINATE
// THE NEXT ONE. A worker that had to be killed, or that could not be proven
// closed, may still be on the machine; every measurement taken afterwards would
// be taken on a machine running two Electron trees, and reported as a gate
// result. Set once, never cleared: the matrix is over.
let matrixAborted = null;

class MatrixAborted extends Error {}

// THE ONLY WAY A JOB IS LAUNCHED. The gate is on the way IN, so a worker that
// aborted the matrix stops the next spawn rather than merely failing its own
// row - and the check is here rather than in each of the six loops so a new
// loop cannot forget it.
async function runJob(job) {
  if (matrixAborted) {
    throw new MatrixAborted(`no job may start after: ${matrixAborted}`);
  }
  const child = await runWorker(job);
  if (child.timedOut || child.closureProven === false || child.workerErrors?.length) {
    matrixAborted =
      `${job.id} ` +
      (child.timedOut
        ? "exceeded its budget"
        : child.closureProven === false
          ? "could not be closed"
          : "lost its child-process observation channel") +
      (child.closureProven === false ? " and never closed" : "");
    fail(
      `${matrixAborted}; the remaining jobs were not run, because a worker that ` +
        `may still be on the machine makes every later measurement a measurement ` +
        `of a busy machine`,
    );
  }
  return child;
}

// THE LOCK IS NOT RELEASED OVER A RUNNING WORKER. Called on every exit path
// before cleanup: the ordinary end of main(), a Ctrl+C, an uncaught exception.
// Anything still alive is asked to stop, then made to stop, and each stage
// AWAITS the actual 'close' rather than sampling an exit code - a main process
// that has exited while a renderer still holds its stdio is exactly the state
// this must not accept as gone.
//
// This used to spin the event loop with a blocking shared-buffer wait so it
// could be called synchronously from a signal handler. That was wrong twice
// over: it blocks the very loop the 'close' events have to arrive on, so the
// wait could not observe the thing it was waiting for, and it froze the parent
// for its whole duration. The callers await instead, and the signal handlers
// below no longer exit until they have.
//
// @returns {Promise<boolean>} true only when EVERY worker has been observed
//   closing. False means exclusivity cannot be given back.
async function terminateLiveWorkers() {
  if (!liveWorkers.size) return true;
  // Delegated per child rather than run as a second, competing ladder: the
  // timeout path may already own one for a worker in this set, and two
  // escalations racing on one process produce two answers about whether it
  // closed. terminateWorker() is idempotent and returns the FIRST caller's.
  const outcomes = await Promise.all(
    [...liveWorkers.keys()].map((child) => terminateWorker(child)),
  );
  if (outcomes.every(Boolean) && !liveWorkers.size) return true;
  const survivors = [...liveWorkers.keys()].map((child) => child.pid);
  fail(
    `${survivors.length} benchmark worker(s) never closed (pids ${survivors.join(", ")}); ` +
      `exclusivity was not held for the whole run`,
  );
  return false;
}

function validateResult(job, child) {
  if (child.code !== 0 || child.signal) {
    fail(
      `${job.id} worker exit code=${child.code} signal=${child.signal}` +
        (child.spawnError ? ` spawnError=${child.spawnError}` : "") +
        (child.workerErrors?.length ? ` workerErrors=${child.workerErrors.join(" | ")}` : "") +
        (child.timedOut ? " (exceeded its budget and was terminated)" : "") +
        (child.closureProven === false ? " (never closed)" : ""),
    );
  }
  if (!fs.existsSync(job.resultFile)) {
    fail(`${job.id} did not publish a result`);
    return null;
  }
  let result;
  try {
    result = JSON.parse(fs.readFileSync(job.resultFile, "utf8"));
  } catch (error) {
    fail(`${job.id} result was not valid JSON: ${error.message}`);
    return null;
  }
  for (const key of ["protocolVersion", "token", "id", "mode", "point", "digest"]) {
    if (result[key] !== job[key]) fail(`${job.id} result ${key} mismatch`);
  }
  if (result.pid !== child.pid) fail(`${job.id} result PID mismatch`);
  if (result.status !== "ok" || !Array.isArray(result.failures) || result.failures.length) {
    fail(`${job.id} worker reported ${stable(result.failures)}`);
  }
  const expected = EXPECTED_SAMPLES[job.mode];
  if (!Number.isInteger(expected)) {
    fail(`${job.id} mode ${job.mode} declares no expected sample count`);
    return null;
  }
  const samples = result.diagnostics && result.diagnostics.samples;
  if (!Array.isArray(samples) || samples.length !== expected) {
    fail(`${job.id} sample count expected=${expected} actual=${samples && samples.length}`);
  } else if (!samples.every((sample) => finite(sample.elapsedMs))) {
    fail(`${job.id} has a non-finite sample`);
  }
  if (
    result.diagnostics?.lifecycle?.some((entry) => entry.kind === "unresponsive") ||
    !result.diagnostics?.setup ||
    !finite(result.diagnostics.setup.barePingMs)
  ) {
    fail(`${job.id} setup or lifecycle health failed`);
  }
  const returnedFixtures = result.diagnostics?.fixtures;
  if (
    !Array.isArray(returnedFixtures) ||
    returnedFixtures.length !== job.files.length ||
    returnedFixtures.some(
      (fixture, index) =>
        fixture.bytes !== job.fixtureBytes[index] ||
        fixture.digest !== job.fixtureDigests[index],
    )
  ) {
    fail(`${job.id} fixture digest/byte mapping mismatch`);
  }
  return result;
}

async function main() {
  const began = Date.now();
  try {
    fs.writeFileSync(lockPath, `${token}\n`, { flag: "wx" });
    locked = true;
    fs.mkdirSync(path.join(runRoot, "jobs"), { recursive: true });
    fs.mkdirSync(path.join(runRoot, "profiles"), { recursive: true });
    fs.mkdirSync(path.join(runRoot, "results"), { recursive: true });
    const fixtures = writeFixtures();
    const cold = coldJobs(fixtures);
    const values = new Map();
    for (const job of cold) {
      const result = validateResult(job, await runJob(job));
      if (!result) continue;
      const point = job.point;
      if (!values.has(point)) values.set(point, []);
      for (const sample of result.diagnostics.samples) values.get(point).push(sample.elapsedMs);
    }
    for (const [point, samples] of values) {
      const measured = stats(samples);
      console.log(`${point} cold ${stable(reported(measured))}`);
      record(point, "cold", measured, samples);
      if (measured.n !== COLD_SAMPLES) fail(`${point} cold incomplete`);
      enforceBudget(`${point} cold`, measured);
    }
    if (!DIAGNOSTIC) {
      const warmJobs = [];
      for (const size of SIZES) for (const tabCount of TABS) {
        warmJobs.push(
          createJob(
            "warm",
            `primary/${size}B/${tabCount}tabs`,
            size,
            tabCount,
            0,
            fixtures,
          ),
        );
      }
      for (const job of warmJobs) {
        const result = validateResult(job, await runJob(job));
        const samples = result?.diagnostics?.samples || [];
        const elapsed = samples.map((sample) => sample.elapsedMs);
        const measured = stats(elapsed);
        console.log(`${job.point} warm ${stable(reported(measured))}`);
        record(job.point, "warm", measured, elapsed);
        if (measured.n !== WARM_SAMPLES) fail(`${job.point} warm incomplete`);
        enforceBudget(`${job.point} warm`, measured);
      }
      const controls = [];
      for (const size of SIZES) for (const tabCount of TABS) {
        const point = `primary/${size}B/${tabCount}tabs`;
        controls.push(createJob("listener", point, size, tabCount, 0, fixtures));
        controls.push(createJob("anti", point, size, tabCount, 0, fixtures));
      }
      controls.push(
        createJob(
          "crlf",
          "product-reachable-crlf-dirty/2MB/25tabs",
          SIZES.at(-1),
          TABS.at(-1),
          0,
          fixtures,
          "crlf",
        ),
      );
      // THE WORST CASE, NOT THE COMMON ONE. Everything above measures a scan
      // that costs almost nothing: createTab() stores one string as both
      // `content` and `originalContent`, so `sameDocument` returns on its
      // identity check without reading a byte, and the CRLF control dirties a
      // single tab out of twenty-five. Neither answers "what does a close cost
      // when every open document has been edited?" - which is the shape the
      // reader actually notices, and the only one where the O(tabs) scan and
      // the newline normalisation are both fully paid. Both line-ending forms
      // are measured because they take different paths through sameDocument:
      // LF stops at two indexOf scans and a comparison, CRLF allocates a
      // normalised copy of both sides.
      controls.push(
        createJob(
          "dirty-lf",
          "worst-case-all-dirty-lf/2MB/25tabs",
          SIZES.at(-1),
          TABS.at(-1),
          0,
          fixtures,
        ),
      );
      controls.push(
        createJob(
          "dirty-crlf",
          "worst-case-all-dirty-crlf/2MB/25tabs",
          SIZES.at(-1),
          TABS.at(-1),
          0,
          fixtures,
          "crlf",
        ),
      );
      // THE ACTIVE DOCUMENT, EDITED WHERE AN EDIT REALLY LIVES. Everything
      // above puts the active tab's text in through `tab.content`, which is the
      // background-tab path; it never reaches snapshotActiveTab()'s
      // reconciliation of the EDITOR against the cache, which is the branch a
      // reader closing a window they were typing in actually takes. These two
      // enter real edit mode and put the edit in the textarea, keeping the
      // other 24 tabs late-edited and the exact filename oracle intact.
      controls.push(
        createJob(
          "edit-lf",
          "worst-case-active-editor-lf/2MB/25tabs",
          SIZES.at(-1),
          TABS.at(-1),
          0,
          fixtures,
        ),
      );
      controls.push(
        createJob(
          "edit-crlf",
          "worst-case-active-editor-crlf/2MB/25tabs",
          SIZES.at(-1),
          TABS.at(-1),
          0,
          fixtures,
          "crlf",
        ),
      );
      controls.push(
        createJob(
          "lifecycle",
          "lifecycle-clean-native-close/50KB/1tab",
          SIZES[0],
          TABS[0],
          0,
          fixtures,
        ),
      );
      for (const job of controls) {
        const result = validateResult(job, await runJob(job));
        const elapsed = (result?.diagnostics?.samples || []).map((sample) => sample.elapsedMs);
        const measured = stats(elapsed);
        console.log(`${job.point} ${job.mode} ${stable(reported(measured))}`);
        record(job.point, job.mode, measured, elapsed, {
          dirtyOracle: result?.diagnostics?.dirtyOracle || null,
          listenerControl: result?.diagnostics?.listenerControl || null,
          // Proof that the active-editor observations really were taken in edit
          // mode, persisted with the numbers rather than only asserted here.
          editSetup: result?.diagnostics?.editSetup || null,
        });
        if (
          job.mode === "lifecycle" &&
          !result?.diagnostics?.lifecycleControl?.willQuit
        ) {
          fail(`${job.point} did not reach real app termination`);
        }
        if (job.mode === "crlf") enforceBudget(`${job.point} CRLF`, measured);
        if (ORACLE_MODES.has(job.mode)) {
          // An edit-mode observation that silently fell back to view mode would
          // measure the wrong branch and still look perfect. The worker records
          // what it actually entered; the parent refuses the number without it.
          if (job.mode === "edit-lf" || job.mode === "edit-crlf") {
            const setup = result?.diagnostics?.editSetup;
            if (
              !setup ||
              setup.inEditMode !== true ||
              setup.splitView !== true ||
              // DISCLOSED, NOT ASSUMED. The editor's box is taken out of layout
              // for the observation - two million characters of text costs
              // Chromium seconds to lay out and the renderer cannot answer a
              // liveness ping while it does. Nothing in the shutdown scan reads
              // layout, so the measured path is unchanged; what must not happen
              // is this being true silently.
              setup.editorRendered !== false ||
              !(setup.editorLength >= job.size / 2)
            ) {
              fail(
                `${job.point} did not enter real edit mode: ${stable(setup || null)}`,
              );
            }
            // AND THE RECONCILIATION ITSELF IS WITNESSED. The editor holds a
            // buffer ending in a character no sample writes to the cache, so a
            // cache that ends in it was adopted from the editor - which is the
            // only proof that snapshotActiveTab() took the edit-mode branch
            // rather than the view-mode one on every single sample.
            const reconciled = result?.diagnostics?.editReconciled;
            if (
              !reconciled ||
              reconciled.samples !== EXPECTED_SAMPLES[job.mode] ||
              !(reconciled.length >= job.size / 2)
            ) {
              fail(
                `${job.point} did not reconcile the editor on every sample: ` +
                  `${stable(reconciled || null)} (expected ${EXPECTED_SAMPLES[job.mode]})`,
              );
            }
          }
          // The oracle is the answer itself, not the clock. A run that timed a
          // scan which found nothing would report a fast worst case and be
          // entirely wrong about it, so every sample has to have named EVERY
          // open document - by exact filename, in tab order - before its
          // number is allowed to count for anything.
          const oracle = result?.diagnostics?.dirtyOracle;
          const expectedNames = job.files.map((file) => path.basename(file));
          if (
            !oracle ||
            oracle.samples !== EXPECTED_SAMPLES[job.mode] ||
            !Array.isArray(oracle.dirtyFiles) ||
            stable(oracle.dirtyFiles) !== stable(expectedNames)
          ) {
            fail(
              `${job.point} all-dirty oracle mismatch expected=${stable(expectedNames)} actual=${stable(oracle && oracle.dirtyFiles)} samples=${oracle && oracle.samples}`,
            );
          }
          enforceBudget(`${job.point} ${job.mode}`, measured);
        }
      }
    }
    console.log(`F22 process gate runtimeMs=${Date.now() - began}`);
  } catch (error) {
    // An abort is not an exception to be reported twice: runJob() already
    // recorded exactly which job ended the matrix and why. Reporting it again
    // as a parent exception would put a stack trace over the one line that
    // says what actually happened.
    if (error instanceof MatrixAborted) {
      console.log(`F22 process gate ABORTED after ${Date.now() - began}ms`);
    } else {
      fail(`parent exception: ${error.stack || error}`);
    }
  } finally {
    await releaseRunResources();
  }
  process.exitCode = failures.length ? 1 : 0;
}

// ONE PLACE TO GIVE THE MACHINE BACK, CALLABLE MORE THAN ONCE. The exclusive
// lock is the whole point of this file: while it exists no other run may start,
// and a run that dies without removing it makes the gate unrunnable until
// somebody finds the file by hand. `main()`'s own `finally` covers the ordinary
// exits, but not a Ctrl+C, an uncaught exception thrown outside the awaited
// chain, or an unhandled rejection - and those are the ways an interactive
// benchmark actually gets stopped. `locked` guards the unlink, so a run that
// never took the lock can never remove another run's.
let locked = false;
// The single in-flight release. Cleanup is asynchronous now - it awaits real
// process closure - so "already released" is not a boolean any more: a second
// caller has to be able to WAIT for the first one rather than assume it is
// finished and exit out from under it.
let releasePromise = null;

// The evidence outlives the run directory. Printed unconditionally as one
// machine-readable line, so a result can be recovered from a transcript, and
// written to a file when F22_RESULT_FILE names one - atomically, because a
// half-written record read as a result is worse than no record.
//
// Nothing is written by default and nothing is written inside the repository:
// the path is the caller's, so a gate run never leaves an artefact behind for
// somebody to commit by accident.
function publishResults() {
  const payload = {
    protocolVersion: PROTOCOL_VERSION,
    budgetMs: BUDGET_MS,
    diagnostic: DIAGNOSTIC,
    failures: failures.slice(),
    observations,
  };
  const target = process.env.F22_RESULT_FILE;
  if (!target) return true;

  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), "utf8");
    fs.renameSync(temporary, target);
    console.log(`F22 results written to ${target}`);
    return true;
  } catch (error) {
    // A missing requested artifact is a failed publication. The caller keeps
    // both run resources quarantined, so the evidence remains available.
    fail(`result file could not be written: ${error.message}`);
    try {
      fs.rmSync(temporary, { force: true });
    } catch (cleanupError) {
      // The publication failure above is already authoritative.
    }
    return false;
  }
}

function emitResultSummary() {
  const target = process.env.F22_RESULT_FILE;
  const summary = observations.map((entry) => ({
    point: entry.point,
    mode: entry.mode,
    n: entry.n,
    rawP95: entry.raw.p95,
    reportedP95: entry.reported.p95,
    withinBudget: entry.withinBudget,
  }));
  console.log(
    `F22-RESULT-JSON ${stable({
      budgetMs: BUDGET_MS,
      failures: failures.length,
      failureDetail: failures.slice(),
      resultFile: target || null,
      summary,
    })}`,
  );
}
function releaseRunResources() {
  if (!releasePromise) releasePromise = performRelease();
  return releasePromise;
}

async function performRelease() {
  // A released lock asserts that no worker, result publication, or cleanup
  // failure can contaminate the next benchmark. Preserve both resources when
  // that assertion cannot be proven.
  const closureProven = await terminateLiveWorkers();
  if (!closureProven) {
    fail(
      `run resources quarantined: lock ${lockPath} and run directory ${runRoot} were ` +
        `retained because a worker of this run could not be proven closed`,
    );
    publishResults();
    emitResultSummary();
    if (!process.exitCode) process.exitCode = 1;
    return;
  }

  // Publish before deleting the evidence. If publication fails, the complete
  // run tree and exclusive lock remain for diagnosis and block another worker.
  const publicationProven = publishResults();
  if (!publicationProven) {
    fail(
      `run resources quarantined: lock ${lockPath} and run directory ${runRoot} were ` +
        `retained because required result publication failed`,
    );
    emitResultSummary();
    if (!process.exitCode) process.exitCode = 1;
    return;
  }

  let cleanupProven = false;
  try {
    fs.rmSync(runRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    cleanupProven = !fs.existsSync(runRoot);
    if (!cleanupProven) fail(`run cleanup failed: ${runRoot} still exists after rmSync`);
  } catch (error) {
    fail(`run cleanup failed: ${error.message}`);
  }
  if (!cleanupProven) {
    fail(
      `run resources quarantined: lock ${lockPath} and run directory ${runRoot} were ` +
        `retained because required cleanup failed`,
    );
    emitResultSummary();
    if (!process.exitCode) process.exitCode = 1;
    return;
  }

  // This is deliberately last: every required status above is proven before
  // allowing a later invocation to acquire the machine-exclusive lock.
  if (locked) {
    try {
      fs.unlinkSync(lockPath);
    } catch (error) {
      fail(`lock cleanup failed: ${error.message}`);
    }
  }
  emitResultSummary();
  if (failures.length && !process.exitCode) process.exitCode = 1;
}
// EVERY EXIT PATH WAITS FOR CLEANUP TO SETTLE. These used to call
// process.exit() on the line after releaseRunResources(), which was only ever
// correct while cleanup was synchronous; now that closure is genuinely awaited,
// exiting immediately would abandon the workers this run started - the exact
// condition the lock exists to prevent - and lose the verdict as well. Bounded
// by construction: every wait inside the release has a deadline.
function installShutdownHandlers() {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(signal, () => {
        fail(`interrupted by ${signal}`);
        // Re-raise rather than exiting quietly: the caller asked for termination
        // and its shell should see a signal exit, not a tidy zero.
        releaseRunResources().then(
          () => process.exit(130),
          () => process.exit(130),
        );
      });
    } catch (error) {
      // SIGBREAK exists only on Windows, and this gate is Windows-only; a
      // platform that does not know a name simply gets one fewer safety net.
    }
  }
  process.on("uncaughtException", (error) => {
    fail(`uncaught parent exception: ${error && error.stack ? error.stack : error}`);
    releaseRunResources().then(
      () => process.exit(1),
      () => process.exit(1),
    );
  });
  process.on("unhandledRejection", (reason) => {
    fail(`unhandled parent rejection: ${reason && reason.stack ? reason.stack : reason}`);
    releaseRunResources().then(
      () => process.exit(1),
      () => process.exit(1),
    );
  });
}

if (require.main === module) {
  installShutdownHandlers();
  main();
}

// Exposed only for the packaging suite's deterministic lifecycle probes. The
// benchmark entry point remains the guarded call above; requiring this file
// must not start a real Electron matrix merely to prove error handling.
module.exports = {
  runWorker,
  runJob,
  liveWorkers,
};
