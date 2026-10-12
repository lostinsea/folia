"use strict";

const { createHash } = require("crypto");
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const protocol = require("./protocol");
const { TOOLING } = require("./prepare-ci");
const { verifyPhase } = require("./verify-phase");

const ROOT = __dirname;
const MODE = process.argv[2];
const OUTPUT_NAME = process.argv[3];
if (process.argv.length !== 4 || !["ab", "aa"].includes(MODE) ||
    OUTPUT_NAME !== (MODE === "aa" ? protocol.POLICY.aaOutput : protocol.POLICY.abOutput)) {
  throw new Error("usage: node run.js aa aa-01 OR node run.js ab ab-01; one attempt per frozen phase");
}
const AA_CALIBRATION = MODE === "aa";
const OUTPUT_ROOT = path.join(ROOT, OUTPUT_NAME);
const BASELINE_REVISION = "790c1bc9267f4b794700a8eede506bb48e8be189";
const APP_ROOT = path.join(OUTPUT_ROOT, "app");
const LOG_ROOT = path.join(OUTPUT_ROOT, "logs");
const RECORD_ROOT = path.join(OUTPUT_ROOT, "records");
const LOCK_PATH = path.join(os.tmpdir(), "folia-machine-exclusive.lock");
const RESULT_PATH = path.join(
  OUTPUT_ROOT,
  AA_CALIBRATION ? "aa-calibration-results.json" : "results.json",
);
const PARTIAL_PATH = path.join(OUTPUT_ROOT, "partial-results.json");
const CHILD_TIMEOUT_MS = 240000;
const phaseStartedAt = performance.now();
const FREEZE_PATH = path.join(ROOT, "predeclared.json");
const predeclaredBytes = fs.readFileSync(FREEZE_PATH);
const predeclaredSha256 = sha256(predeclaredBytes);
const predeclared = JSON.parse(predeclaredBytes.toString("utf8"));
const CANDIDATE_ROOT = predeclared.candidateRoot;
const STORAGE_ROOT = predeclared.storage.root;
const FIXTURE_ROOT = path.join(STORAGE_ROOT, MODE, "fixtures");
const PROFILE_ROOT = path.join(STORAGE_ROOT, MODE, "profiles");
const REPETITIONS = 21;
const RUN_REPETITIONS = REPETITIONS;
const SOURCE_FILES = ["src/main.js", "src/custom-tabs.js"];
const FROZEN_HASHES = Object.fromEntries([
  "src/main.js", "src/custom-tabs.js", "test/test-tab-refresh.js",
  "scripts/prove-table-fixes.js",
].map((relative) => [relative, sha256(fs.readFileSync(path.join(CANDIDATE_ROOT, relative)))]));
const FROZEN_TOOLING = TOOLING;
let partialEvidence = null;
let cleanupDeadline = null;
let cleanupFailure = null;
const STATIC_DIRECTORIES = ["libs", "fonts", "assets"];
const SIZES = [
  { name: "50k", bytes: 50 * 1024 },
  { name: "500k", bytes: 500 * 1024 },
  { name: "2m", bytes: 2 * 1024 * 1024 },
];
const TAB_COUNTS = [1, 10, 25];

const ACTIVE_SCHEDULE = protocol.schedule(MODE);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyFreeze() {
  assert(sha256(fs.readFileSync(FREEZE_PATH)) === predeclaredSha256,
    "predeclared manifest changed after startup");
  assert(predeclared.schema === "sec08-prospective-calibration-freeze-v1", "invalid freeze schema");
  assert(gitBuffer(["rev-parse", "HEAD"]).toString("utf8").trim() === predeclared.candidateRevision,
    "candidate checkout revision changed");
  assert(equal(predeclared.policy, protocol.POLICY), "predeclared policy differs from current policy");
  assert(equal(predeclared.schedules, { aa: protocol.schedule("aa"), ab: protocol.schedule("ab") }),
    "predeclared schedules differ or are incomplete");
  assert(Array.isArray(predeclared.tooling) &&
    equal(predeclared.tooling.map((pin) => pin.name).sort(), [...FROZEN_TOOLING].sort()),
    "frozen tooling inventory must be exact, nonempty and duplicate-free");
  assert(predeclared.candidateSourceHashes && equal(Object.keys(predeclared.candidateSourceHashes).sort(),
    Object.keys(FROZEN_HASHES).sort()), "frozen candidate source inventory must be exact");
  for (const pin of predeclared.tooling) {
    assert(equal(Object.keys(pin).sort(), ["bytes", "name", "sha256"]) &&
      Number.isSafeInteger(pin.bytes) && pin.bytes > 0 && /^[a-f0-9]{64}$/.test(pin.sha256),
      `invalid tooling pin: ${pin.name}`);
    const bytes = fs.readFileSync(path.join(ROOT, pin.name));
    assert(bytes.length === pin.bytes && sha256(bytes) === pin.sha256, `frozen tooling changed: ${pin.name}`);
  }
  for (const [relative, expected] of Object.entries(predeclared.candidateSourceHashes)) {
    assert(/^[a-f0-9]{64}$/.test(expected), `invalid source hash: ${relative}`);
    assert(sha256(fs.readFileSync(path.join(CANDIDATE_ROOT, relative))) === expected,
      `predeclared source changed: ${relative}`);
  }
}

function assertWithinPhase() {
  assert(performance.now() - phaseStartedAt < protocol.POLICY.phaseDeadlineMs, "fixed phase deadline exceeded");
}

function nativeTimeout(maximumMs) {
  assertWithinPhase();
  return Math.max(1, Math.floor(Math.min(maximumMs,
    protocol.POLICY.phaseDeadlineMs - (performance.now() - phaseStartedAt))));
}

function verifyPriorAA() {
  return verifyPhase(ROOT, "aa");
}

function baselineTransformation(baselineHashes, workerHash) {
  const recipe = {
    baselineRevision: BASELINE_REVISION,
    baselineSourceHashes: baselineHashes,
    sharedInstrumentedWorkerSha256: workerHash,
    transformation: "Unmodified baseline source bytes plus the same observer worker used by candidate; no baseline product rewrite.",
  };
  return { recipe, sha256: sha256(Buffer.from(JSON.stringify(recipe), "utf8")) };
}

function checkpointPartial(launch, error = null) {
  if (!partialEvidence) return;
  if (launch) {
    const rawPath = path.join(RECORD_ROOT, `${launch.label}.json`);
    writeJson(rawPath, launch);
    const bytes = fs.readFileSync(rawPath);
    partialEvidence.launches.push({
      label: launch.label, variant: launch.variant, fixture: launch.fixture,
      exitCode: launch.exitCode, signal: launch.signal, pid: launch.pid,
      elapsedMs: launch.elapsedMs,
      rawPath, bytes: bytes.length, sha256: sha256(bytes),
    });
  }
  partialEvidence.completedLaunches = partialEvidence.launches.length;
  partialEvidence.checkpointAt = new Date().toISOString();
  if (error) {
    partialEvidence.status = "stopped-at-first-error-not-acceptance";
    partialEvidence.error = String(error.stack || error);
  }
  writeJson(PARTIAL_PATH, partialEvidence);
}

function writeJson(target, value) {
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, target);
}

function gitBuffer(args) {
  return execFileSync("git", ["-C", CANDIDATE_ROOT, ...args], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    timeout: nativeTimeout(30000),
  });
}

function treeHash(root, excluded = new Set()) {
  const hash = createHash("sha256");
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const fullPath = path.join(directory, entry.name);
      const relative = path.relative(root, fullPath).replace(/\\/g, "/");
      if (excluded.has(relative)) continue;
      if (entry.isDirectory()) {
        hash.update(`D:${relative}\n`);
        visit(fullPath);
      } else if (entry.isFile()) {
        hash.update(`F:${relative}\0`);
        hash.update(fs.readFileSync(fullPath));
      } else {
        throw new Error(`unsupported staging entry ${fullPath}`);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function sourceHashes(root) {
  return Object.fromEntries(SOURCE_FILES.map((relative) => [
    relative, sha256(fs.readFileSync(path.join(root, relative))),
  ]));
}

function detectCandidateSnapshotReadMode(mainSource) {
  const source = mainSource.toString("utf8");
  const handler = 'ipcMain.handle("read-owned-tab-disk-snapshot"';
  assert(source.includes(handler), "candidate lacks main-owned refresh snapshot IPC");
  if (
    /readOwnedTabDiskSnapshot\s*\(\s*owner\s*,\s*data\.filePath\s*,\s*event\s*,\s*data\s*,?\s*\)/.test(source) &&
    /fs\.promises\.open\s*\(\s*filePath\s*,\s*["']r["']\s*\)/.test(source) &&
    /handle\.readFile\s*\(/.test(source) &&
    /handle\.stat\s*\(/.test(source) &&
    /fs\.promises\.stat\s*\(\s*filePath\s*\)/.test(source) &&
    /filePath\s*===\s*owner\.readTarget/.test(source) &&
    /fs\.promises\.stat\s*\(\s*owner\.readTarget\s*\)/.test(source) &&
    /before\.dev\s*!==\s*pathStats\.dev/.test(source) &&
    /before\.dev\s*!==\s*targetStats\.dev/.test(source) &&
    /owner\.readTarget\s*===\s*currentOwner\.readTarget/.test(source)
  ) {
    return "logical-fd-pinned";
  }
  if (source.includes("readMarkdownSnapshot(data.filePath")) return "path-based";
  throw new Error("candidate refresh handler has no recognized stable-read topology");
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function electronProcesses(timeoutMs = 15000) {
  const command =
    "Get-CimInstance Win32_Process -Filter \"Name = 'electron.exe'\" -ErrorAction Stop | " +
    "Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
  const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
    windowsHide: true,
    timeout: nativeTimeout(timeoutMs),
  }).trim();
  if (!text) return [];
  const parsed = JSON.parse(text);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function assertMachineExclusive(phase) {
  const processes = electronProcesses();
  assert(processes.length === 0, `${phase}: competing Electron processes: ${JSON.stringify(processes)}`);
}

async function waitForNoElectron(timeoutMs = 15000) {
  if (cleanupFailure) throw cleanupFailure;
  if (cleanupDeadline === null) cleanupDeadline = performance.now() + timeoutMs;
  try {
    while (performance.now() < cleanupDeadline) {
      const processes = electronProcesses(Math.max(1, cleanupDeadline - performance.now()));
      if (performance.now() >= cleanupDeadline) break;
      if (processes.length === 0) return;
      await new Promise((resolve) => setTimeout(resolve,
        Math.min(200, Math.max(1, cleanupDeadline - performance.now()))));
    }
    throw new Error("bounded Electron cleanup deadline exceeded; ownership remains unsettled");
  } catch (error) {
    cleanupFailure = error;
    throw error;
  }
}

function fixtureBytes(bytes, heading) {
  const prefix = `# ${heading}\n\n`;
  assert(Buffer.byteLength(prefix) <= bytes, "fixture heading exceeds selected size");
  return Buffer.concat([
    Buffer.from(prefix, "utf8"),
    Buffer.alloc(bytes - Buffer.byteLength(prefix), 0x78),
  ]);
}

function makeFixtures() {
  const fixtures = [];
  for (const size of SIZES) {
    for (const tabCount of TAB_COUNTS) {
      const directory = path.join(FIXTURE_ROOT, `${size.name}-${tabCount}`);
      fs.mkdirSync(directory, { recursive: true });
      const tabs = [];
      for (let index = 1; index <= tabCount; index += 1) {
        const heading = `SEC08 refresh ${size.name} tab ${index} initial`;
        const bytes = fixtureBytes(size.bytes, heading);
        const filePath = path.join(directory, `measured-${String(index).padStart(2, "0")}.md`);
        fs.writeFileSync(filePath, bytes);
        tabs.push({ index, filePath, bytes: size.bytes, initialHeading: heading, initialSha256: sha256(bytes) });
      }
      const controlPath = path.join(directory, "control.md");
      const controlHeading = `SEC08 control ${size.name}-${tabCount}`;
      const controlBytes = fixtureBytes(1024, controlHeading);
      fs.writeFileSync(controlPath, controlBytes);
      const manifest = {
        size: size.name, bytes: size.bytes, measuredTabCount: tabCount, controlPath, controlHeading,
        controlSha256: sha256(controlBytes), tabs,
      };
      const manifestPath = path.join(directory, "manifest.json");
      writeJson(manifestPath, manifest);
      fixtures.push({ ...manifest, manifestPath, manifestSha256: sha256(fs.readFileSync(manifestPath)) });
    }
  }
  return fixtures;
}

function fixtureHashes(fixture) {
  return Object.fromEntries([
    ...fixture.tabs.map((tab) => [path.basename(tab.filePath), sha256(fs.readFileSync(tab.filePath))]),
    [path.basename(fixture.controlPath), sha256(fs.readFileSync(fixture.controlPath))],
  ]);
}

function assertPhysicalDirectory(directory) {
  const resolved = path.resolve(directory);
  let current = resolved;
  while (true) {
    const stat = fs.lstatSync(current);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), `storage directory is aliased or invalid: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const physical = fs.realpathSync.native(resolved);
  assert(physical.toLowerCase() === resolved.toLowerCase(), `storage path differs from physical path: ${resolved}`);
  const stat = fs.statSync(resolved);
  return { path: resolved, dev: stat.dev, ino: stat.ino };
}

function verifyStorageRoot() {
  assert(predeclared.storage.policy === "fresh-os-temp-per-worker-v1", "wrong storage policy");
  const physical = assertPhysicalDirectory(STORAGE_ROOT);
  const temporary = assertPhysicalDirectory(os.tmpdir());
  assert(path.dirname(physical.path).toLowerCase() === temporary.path.toLowerCase(),
    "fixture/profile storage is not directly in ordinary OS temp");
  assert(physical.dev === predeclared.storage.dev && physical.ino === predeclared.storage.ino,
    "owned storage root identity changed");
  assert(fs.readFileSync(path.join(STORAGE_ROOT, "owner.txt"), "utf8") === predeclared.storage.owner,
    "storage owner marker changed");
}

function freshWorkerFixture(template, variant, ordinal) {
  const label = `${template.size}-${template.measuredTabCount}-${variant}-${ordinal}`;
  const directory = path.join(FIXTURE_ROOT, "workers", label);
  fs.mkdirSync(directory);
  assertPhysicalDirectory(directory);
  const tabs = template.tabs.map((tab) => {
    const filePath = path.join(directory, path.basename(tab.filePath));
    const bytes = fixtureBytes(tab.bytes, tab.initialHeading);
    assert(sha256(bytes) === tab.initialSha256, "fresh fixture generation differs");
    fs.writeFileSync(filePath, bytes, { flag: "wx" });
    return { ...tab, filePath };
  });
  const controlPath = path.join(directory, "control.md");
  const controlBytes = fixtureBytes(1024, template.controlHeading);
  assert(sha256(controlBytes) === template.controlSha256, "fresh control generation differs");
  fs.writeFileSync(controlPath, controlBytes, { flag: "wx" });
  const manifest = { size: template.size, bytes: template.bytes, measuredTabCount: template.measuredTabCount,
    controlPath, controlHeading: template.controlHeading, controlSha256: template.controlSha256, tabs };
  const manifestPath = path.join(directory, "manifest.json");
  writeJson(manifestPath, manifest);
  return { ...manifest, manifestPath, manifestSha256: sha256(fs.readFileSync(manifestPath)) };
}

function copyBaselineApp() {
  assert(!fs.existsSync(APP_ROOT), `refusing to reuse disposable app ${APP_ROOT}`);
  fs.mkdirSync(APP_ROOT, { recursive: true });
  const archivePath = path.join(ROOT, `baseline-${BASELINE_REVISION}.tar`);
  fs.writeFileSync(archivePath,
    gitBuffer(["archive", "--format=tar", BASELINE_REVISION, "src", "package.json", "package-lock.json"]));
  try {
    execFileSync("tar", ["-xf", archivePath, "-C", APP_ROOT], {
      stdio: "pipe", windowsHide: true, timeout: nativeTimeout(30000),
    });
  } finally {
    if (fs.existsSync(archivePath)) fs.unlinkSync(archivePath);
  }
  for (const directory of STATIC_DIRECTORIES) {
    fs.cpSync(path.join(CANDIDATE_ROOT, directory), path.join(APP_ROOT, directory), {
      recursive: true, dereference: false,
    });
  }
  fs.symlinkSync(path.join(CANDIDATE_ROOT, "node_modules"), path.join(APP_ROOT, "node_modules"), "junction");
  fs.copyFileSync(path.join(ROOT, "worker.js"), path.join(APP_ROOT, "sec08-clean-refresh-worker.js"));
}

function stageVariant(variant, snapshots) {
  for (const relative of SOURCE_FILES) {
    const target = path.join(APP_ROOT, relative);
    fs.writeFileSync(target, snapshots[variant][relative]);
    assert(sha256(fs.readFileSync(target)) === snapshots.hashes[variant][relative],
      `${variant}: staged hash mismatch for ${relative}`);
  }
}

function runChild(variant, sourceVariant, fixture, snapshotReadMode, ordinal) {
  return new Promise((resolve, reject) => {
    assertWithinPhase();
    const label = `${fixture.size}-${fixture.measuredTabCount}-${variant}-${ordinal}`;
    const profile = path.join(PROFILE_ROOT, label);
    const logPath = path.join(LOG_ROOT, `${label}.log`);
    const electron = path.join(APP_ROOT, "node_modules", "electron", "dist", "electron.exe");
    const startedAt = performance.now();
    if (cleanupFailure) throw cleanupFailure;
    cleanupDeadline = null;
    verifyStorageRoot();
    assert(!fs.existsSync(profile), `refusing reused worker profile ${profile}`);
    fs.mkdirSync(profile);
    const storageWitness = {
      fixtureDirectory: assertPhysicalDirectory(path.dirname(fixture.manifestPath)),
      profileDirectory: assertPhysicalDirectory(profile),
    };
    assert(fs.readdirSync(profile).length === 0, "worker profile was not empty before launch");
    assertWithinPhase();
    const child = spawn(electron, [
      path.join(APP_ROOT, "sec08-clean-refresh-worker.js"),
      `--app-root=${APP_ROOT}`,
      `--user-data=${profile}`,
      `--variant=${variant}`,
      `--source-variant=${sourceVariant}`,
      `--fixture=${fixture.manifestPath}`,
      `--snapshot-read-mode=${snapshotReadMode}`,
      `--repetitions=${RUN_REPETITIONS}`,
    ], { cwd: APP_ROOT, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutMs = Math.min(CHILD_TIMEOUT_MS,
      protocol.POLICY.phaseDeadlineMs - (performance.now() - phaseStartedAt));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", async (code, signal) => {
      clearTimeout(timer);
      const elapsedMs = performance.now() - startedAt;
      try {
        await waitForNoElectron();
      } catch (error) {
        fs.writeFileSync(logPath,
          `exitCode=${code} signal=${signal || ""} timedOut=${timedOut}\n\n=== stdout ===\n${stdout}\n=== stderr ===\n${stderr}`,
          "utf8");
        return reject(new Error(`${label}: Electron cleanup failed: ${error.stack || error}; see ${logPath}`));
      }
      fs.writeFileSync(logPath,
        `exitCode=${code} signal=${signal || ""} timedOut=${timedOut}\n\n=== stdout ===\n${stdout}\n=== stderr ===\n${stderr}`,
        "utf8");
      if (timedOut || elapsedMs > CHILD_TIMEOUT_MS ||
          performance.now() - phaseStartedAt >= protocol.POLICY.phaseDeadlineMs) {
        return reject(new Error(`${label} exceeded worker or fixed phase deadline; elapsed=${elapsedMs}`));
      }
      if (code !== 0 || signal !== null) {
        return reject(new Error(`${label}: native worker failure code=${code} signal=${signal}; see ${logPath}`));
      }
      const records = stdout.split(/\r?\n/).filter((line) => line.startsWith("SEC08_CLEAN_REFRESH_RESULT "));
      if (records.length !== 1) return reject(new Error(`${label}: expected one result record, found ${records.length}; see ${logPath}`));
      let payload;
      try {
        payload = JSON.parse(records[0].slice("SEC08_CLEAN_REFRESH_RESULT ".length));
      } catch (error) {
        return reject(new Error(`${label}: invalid result JSON: ${error.message}; see ${logPath}`));
      }
      resolve({
        label, variant, fixture: `${fixture.size}-${fixture.measuredTabCount}`,
        payload, logPath, exitCode: code, signal, pid: child.pid, elapsedMs, storageWitness,
      });
    });
  });
}

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK_PATH), { recursive: true });
  fs.mkdirSync(LOCK_PATH);
  writeJson(path.join(LOCK_PATH, "owner.json"), { pid: process.pid, startedAt: new Date().toISOString() });
}

async function releaseOwnedLock() {
  try {
    await waitForNoElectron();
  } catch (error) {
    console.error(`SEC08_CLEAN_REFRESH_LOCK_RETAINED ${error.stack || error}`);
    throw error;
  }
  if (fs.existsSync(LOCK_PATH)) {
    const owner = JSON.parse(fs.readFileSync(path.join(LOCK_PATH, "owner.json"), "utf8"));
    assert(owner.pid === process.pid, "common lock ownership changed; retaining it");
    fs.unlinkSync(path.join(LOCK_PATH, "owner.json"));
    fs.rmdirSync(LOCK_PATH);
  }
  assertWithinPhase();
}

async function main() {
  verifyFreeze();
  verifyStorageRoot();
  assertWithinPhase();
  const priorAA = AA_CALIBRATION ? null : verifyPriorAA();
  assert(!fs.existsSync(OUTPUT_ROOT), `refusing to reuse probe output root ${OUTPUT_ROOT}`);
  for (const target of [APP_ROOT, FIXTURE_ROOT, PROFILE_ROOT, LOG_ROOT, LOCK_PATH, RESULT_PATH, PARTIAL_PATH]) {
    assert(!fs.existsSync(target), `refusing to reuse probe output ${target}`);
  }
  assertMachineExclusive("before acquiring probe lock");
  acquireLock();
  const snapshots = { A: {}, B: {}, hashes: { A: {}, B: {} } };
  let staticHash;
  let candidateHashes;
  let candidateSnapshotReadMode;
  let workerHash;
  let baselineTransform;
  let phaseFailure = null;
  try {
    assertMachineExclusive("before staging");
    for (const [relative, expected] of Object.entries(FROZEN_HASHES)) {
      assert(sha256(fs.readFileSync(path.join(CANDIDATE_ROOT, relative))) === expected,
        `frozen file changed before run: ${relative}`);
    }
    assert(gitBuffer(["cat-file", "-t", BASELINE_REVISION]).toString("utf8").trim() === "commit",
      `${BASELINE_REVISION} is not a commit`);
    for (const relative of SOURCE_FILES) {
      snapshots.A[relative] = gitBuffer(["show", `${BASELINE_REVISION}:${relative}`]);
      snapshots.hashes.A[relative] = sha256(snapshots.A[relative]);
    }
    assert(!snapshots.A["src/main.js"].includes("read-owned-tab-disk-snapshot"), "baseline unexpectedly contains refresh snapshot IPC");
    assert(snapshots.A["src/custom-tabs.js"].includes("readStableDiskSnapshot"), "baseline lacks renderer snapshot read");
    if (AA_CALIBRATION) {
      for (const relative of SOURCE_FILES) {
        snapshots.B[relative] = Buffer.from(snapshots.A[relative]);
        snapshots.hashes.B[relative] = snapshots.hashes.A[relative];
      }
    } else {
      const sourceDiff = gitBuffer(["diff", "--name-only", BASELINE_REVISION, "--", "src"])
        .toString("utf8").trim().split(/\r?\n/).filter(Boolean).sort();
      assert(equal(sourceDiff, [...SOURCE_FILES].sort()), `candidate source scope is not exactly ${SOURCE_FILES.join(", ")}: ${JSON.stringify(sourceDiff)}`);
      assert(gitBuffer(["diff", "--name-only", BASELINE_REVISION, "--", "package.json", "package-lock.json"])
        .toString("utf8").trim() === "", "package dependencies differ from the baseline");
      for (const relative of SOURCE_FILES) {
        snapshots.B[relative] = fs.readFileSync(path.join(CANDIDATE_ROOT, relative));
        snapshots.hashes.B[relative] = sha256(snapshots.B[relative]);
      }
      candidateSnapshotReadMode = detectCandidateSnapshotReadMode(snapshots.B["src/main.js"]);
      assert(snapshots.B["src/custom-tabs.js"].includes('tabIpc.invoke("read-owned-tab-disk-snapshot"'),
        "candidate lacks refresh snapshot invoke");
      candidateHashes = sourceHashes(CANDIDATE_ROOT);
      assert(equal(candidateHashes, snapshots.hashes.B), "candidate sources changed while snapshotting");
    }

    workerHash = sha256(fs.readFileSync(path.join(ROOT, "worker.js")));
    baselineTransform = baselineTransformation(snapshots.hashes.A, workerHash);
    copyBaselineApp();
    stageVariant(AA_CALIBRATION ? "A" : "B", snapshots);
    staticHash = treeHash(APP_ROOT, new Set([...SOURCE_FILES, "node_modules"]));
    if (priorAA) {
      assert(staticHash === priorAA.hashes.stagedStaticAssets &&
        workerHash === priorAA.hashes.instrumentedWorker &&
        equal(snapshots.hashes.A, priorAA.hashes.baseline), "AB is not comparable to qualifying AA");
    }
    fs.mkdirSync(PROFILE_ROOT, { recursive: true });
    fs.mkdirSync(LOG_ROOT, { recursive: true });
    fs.mkdirSync(RECORD_ROOT, { recursive: true });
    const fixtures = makeFixtures();
    fs.mkdirSync(path.join(FIXTURE_ROOT, "workers"));
    const launches = [];
    partialEvidence = {
      status: "prospective-phase-incomplete-not-acceptance",
      accepted: false, expectedLaunches: protocol.POLICY.workersPerPhase,
      expectedSamples: protocol.POLICY.workersPerPhase * 42,
      completedLaunches: 0,
      baselineRevision: BASELINE_REVISION,
      schedule: ACTIVE_SCHEDULE,
      hashes: { baseline: snapshots.hashes.A, candidate: snapshots.hashes.B,
        frozen: FROZEN_HASHES, instrumentedWorker: workerHash, baselineTransformation: baselineTransform },
      launches: [],
    };
    checkpointPartial(null);
    const finish = (decision, complete) => {
      verifyFreeze();
      assertWithinPhase();
      assert(treeHash(APP_ROOT, new Set([...SOURCE_FILES, "node_modules"])) === staticHash,
        "disposable static assets changed during phase");
      const result = {
        status: decision.status, complete, mode: MODE, completedAt: new Date().toISOString(),
        phaseElapsedMs: performance.now() - phaseStartedAt,
        predeclaredSha256,
        method: { policy: protocol.POLICY, schedule: ACTIVE_SCHEDULE,
          storage: predeclared.storage,
          unchangedWorkerSha256: workerHash, endpoint: "Original t0 before observer setup/tab click until active viewer DOM innerText heading, not overlay removal or compositor paint.",
          ledgerInterval: "Includes post-heading accepted completion and counter quiescence.",
          allObservationsRetained: true, noPopulationP95Certificate: true,
          nativeRunnerOutcomeExternal: true, priorAA },
        host: { platform: process.platform, release: os.release(), cpus: os.cpus().map((cpu) => cpu.model) },
        hashes: { frozenBeforeAndAfter: FROZEN_HASHES, instrumentedWorker: workerHash,
          baseline: snapshots.hashes.A, sourceArms: snapshots.hashes,
          stagedStaticAssets: staticHash, baselineTransformation: baselineTransform },
        launches: partialEvidence.launches, workers: launches, decision,
      };
      assertWithinPhase();
      writeJson(RESULT_PATH, result);
      assertWithinPhase();
      partialEvidence.status = complete ? "fixed-phase-complete" : "stopped-at-first-material-veto";
      partialEvidence.fullResultPath = RESULT_PATH;
      checkpointPartial(null);
      console.log(`SEC08_PROSPECTIVE_RESULT ${JSON.stringify({
        status: result.status, complete, workers: launches.length,
        qualified: decision.qualified, certificateScope: protocol.POLICY.estimand,
        originalTwoMsObjectiveMet: decision.originalTwoMsObjectiveMet,
      })}`);
    };
    for (const pair of ACTIVE_SCHEDULE) {
      const { size: sizeName, tabCount, order } = pair;
      assertWithinPhase();
      const template = fixtures.find((entry) => entry.size === sizeName && entry.measuredTabCount === tabCount);
      assert(template, `missing fixture ${sizeName}-${tabCount}`);
      for (const variant of order) {
        assertMachineExclusive(`before ${sizeName}-${tabCount}-${variant}`);
        const sourceKey = AA_CALIBRATION ? "A" : variant;
        const sourceVariant = sourceKey === "A" ? "baseline" : "candidate";
        const snapshotReadMode = sourceVariant === "baseline"
          ? "renderer-baseline"
          : candidateSnapshotReadMode;
        if (!AA_CALIBRATION) {
          assert(equal(sourceHashes(CANDIDATE_ROOT), candidateHashes), "candidate source bytes changed during probe");
        }
        stageVariant(sourceKey, snapshots);
        assert(equal(sourceHashes(APP_ROOT), snapshots.hashes[sourceKey]), "staged source differs before worker");
        const fixture = freshWorkerFixture(template, variant, launches.length + 1);
        const initialHashes = fixtureHashes(fixture);
        assert(equal(initialHashes, Object.fromEntries([
          ...fixture.tabs.map((tab) => [path.basename(tab.filePath), tab.initialSha256]),
          [path.basename(fixture.controlPath), fixture.controlSha256],
        ])), `${sizeName}-${tabCount}-${variant}: fixture reset hash mismatch`);
        const launch = await runChild(
          variant,
          sourceVariant,
          fixture,
          snapshotReadMode,
          launches.length + 1,
        );
        const retainedLaunch = { ...launch, initialFixtureHashes: initialHashes };
        checkpointPartial(retainedLaunch);
        assert(launch.exitCode === 0 && launch.payload.ok,
          `${launch.label}: worker failed: ${launch.payload.reason || ""}; ${launch.payload.detail || ""}; raw evidence: ${launch.logPath}`);
        assert(
          launch.payload.variant === variant &&
          launch.payload.sourceVariant === sourceVariant &&
          launch.payload.snapshotReadMode === snapshotReadMode,
          `${sizeName}-${tabCount}-${variant}: worker read-topology identity mismatch`,
        );
        assert(equal(fixtureHashes(fixture), launch.payload.fixtureHashes),
          `${sizeName}-${tabCount}-${variant}: fixture hashes changed after worker exit`);
        const compact = protocol.compactWorker(launch, pair, MODE);
        if (priorAA) assert(compact.electron === priorAA.runtime.electron &&
          compact.chrome === priorAA.runtime.chrome, "AB runtime differs from qualifying AA");
        if (launches.length) assert(compact.electron === launches[0].electron &&
          compact.chrome === launches[0].chrome, "runtime changed within phase");
        launches.push(compact);
        assertMachineExclusive(`after ${sizeName}-${tabCount}-${variant}`);
        assertWithinPhase();
      }
      const group = launches.slice(-2);
      const comparison = protocol.comparePair(group.find((l) => l.variant === "A"),
        group.find((l) => l.variant === "B"), MODE);
      const vetoes = Object.entries(comparison.endpoints).filter(([, value]) => value.decisionMarginMs > 0);
      console.log(`SEC08_PROSPECTIVE_PAIR ${JSON.stringify({
        round: pair.round, cell: pair.cell, order, elapsedMs: performance.now() - phaseStartedAt,
        completedWorkers: launches.length, vetoes,
      })}`);
      if (vetoes.length) {
        finish({
          status: `${AA_CALIBRATION ? "AA_NOT_QUALIFIED" : "AB_NOT_CERTIFIED"}_EARLY_OBSERVED_MATERIAL_GUARD_BREACH`,
          mode: MODE, qualified: false, originalTwoMsObjectiveMet: null,
          certificateScope: protocol.POLICY.estimand, completedPair: comparison, vetoes,
          statisticalProofOfRegressionWhenFailed: false, incompleteByPredeclaredIrreversibleVeto: true,
        }, false);
        return;
      }
    }
    finish(protocol.analyze(launches, MODE), true);
  } catch (error) {
    phaseFailure = error;
    throw error;
  } finally {
    try {
      await releaseOwnedLock();
    } catch (error) {
      throw phaseFailure || error;
    }
  }
}

main().catch((error) => {
  checkpointPartial(null, error);
  console.error(`SEC08_CLEAN_REFRESH_FAILED ${error.stack || error}`);
  process.exitCode = 1;
});
