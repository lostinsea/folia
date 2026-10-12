"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const protocol = require("./protocol");
const { prepare, hash } = require("./prepare-ci");
const { verifyPhase } = require("./verify-phase");

// Every timing, runtime and native-outcome field below is synthetic DATA.
// These controls test admission logic, not app behavior or native capture.
function fixture(t) {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "folia-sec08-ci-data-"));
  t.after(() => fs.rmSync(ownedRoot, { recursive: true, force: true }));
  const root = path.join(ownedRoot, "results");
  const declaration = prepare(path.resolve(__dirname, "..", ".."), root, { runId: "DATA" });
  t.after(() => fs.rmSync(declaration.storage.root, { recursive: true, force: true }));
  const phaseRoot = path.join(root, "aa-01");
  fs.mkdirSync(phaseRoot);
  const launches = [];
  const workers = [];
  for (const pair of protocol.schedule("aa")) {
    for (const variant of pair.order) {
      const payload = {
        ok: true, variant, sourceVariant: "baseline", snapshotReadMode: "renderer-baseline",
        electron: "DATA-runtime", chrome: "DATA-runtime", samples: {}, diagnosticRecords: [],
      };
      for (const operation of ["changed", "unchanged"]) {
        payload.samples[operation] = [];
        for (let i = 0; i < 21; i++) {
          payload.samples[operation].push({
            repetition: i + 1, tabIndex: i % pair.tabCount + 1, elapsedMs: 10,
            headingVisible: true, activeTitle: "DATA-owned-fixture", expectedHeading: "DATA heading",
            witness: { completionCalls: [{ accepted: true }] },
          });
          payload.diagnosticRecords.push({
            operation, repetition: i + 1, status: "exact-witness-complete-instrumented",
            timed: { elapsedMs: 10 }, filePath: "DATA-owned-fixture", heading: "DATA heading",
            setup: {
              outsideHeadingTimer: true, directFixtureWrites: operation === "changed" ? 1 : 0,
              timestampSetters: 0,
              control: { completion: { accepted: true }, resumed: ["DATA"], paused: [] },
            },
            assertedWitness: { DATA: true }, expectedWitness: { DATA: true },
            assertedAdoption: { DATA: true }, expectedAdoption: { DATA: true },
          });
        }
      }
      const launch = { label: `DATA-${launches.length}`, variant, fixture: pair.cell,
        exitCode: 0, signal: null, pid: -1, elapsedMs: 1, payload };
      const rawPath = path.join(phaseRoot, `${launch.label}.json`);
      fs.writeFileSync(rawPath, JSON.stringify(launch));
      const bytes = fs.readFileSync(rawPath);
      launches.push({ rawPath, bytes: bytes.length, sha256: hash(bytes) });
      workers.push(protocol.compactWorker(launch, pair, "aa"));
    }
  }
  const result = {
    complete: true, decision: protocol.analyze(workers, "aa"), launches, workers,
    predeclaredSha256: hash(fs.readFileSync(path.join(root, "predeclared.json"))),
    hashes: { frozenBeforeAndAfter: declaration.candidateSourceHashes },
  };
  const execution = {
    mode: "aa", nativeRunnerExitCode: 0, captureSucceeded: true, phaseWithinBudget: true,
    resultReadbackError: null, captureErrors: [], commonLockPresentAfterReturn: false,
  };
  const caller = { mode: "aa", phaseWrapperExitCode: 0, phaseWithinBudget: true };
  function persist() {
    const resultPath = path.join(phaseRoot, "aa-calibration-results.json");
    fs.writeFileSync(resultPath, JSON.stringify(result));
    execution.resultSha256 = hash(fs.readFileSync(resultPath));
    const executionPath = path.join(root, "aa-execution.json");
    fs.writeFileSync(executionPath, JSON.stringify(execution));
    caller.executionSha256 = hash(fs.readFileSync(executionPath));
    fs.writeFileSync(path.join(root, "aa-caller.json"), JSON.stringify(caller));
  }
  persist();
  return { root, declaration, result, execution, caller, persist };
}

test("DATA: complete matched AA records pass raw/compact/global admission", (t) => {
  const f = fixture(t);
  assert.equal(verifyPhase(f.root, "aa").runtime.electron, "DATA-runtime");
});

for (const [name, change, expected] of [
  ["native nonzero despite result presence", (f) => { f.execution.nativeRunnerExitCode = 7; }, /native runner failed/],
  ["wrapper nonzero", (f) => { f.caller.phaseWrapperExitCode = 1; }, /phase wrapper failed/],
  ["late caller", (f) => { f.caller.phaseWithinBudget = false; }, /caller exceeded budget/],
  ["failed capture", (f) => { f.execution.captureSucceeded = false; }, /capture failed/],
  ["incomplete AA", (f) => { f.result.complete = false; }, /phase incomplete/],
  ["unqualified AA", (f) => { f.result.decision.qualified = false; }, /did not globally qualify/],
  ["raw/compact mismatch", (f) => { f.result.workers[0].elapsedMs = 999; }, /raw\/compact worker mismatch/],
]) {
  test(`DATA: rejects ${name}`, (t) => {
    const f = fixture(t);
    change(f);
    f.persist();
    assert.throws(() => verifyPhase(f.root, "aa"), expected);
  });
}

test("DATA: rejects a raw record altered after the native receipt", (t) => {
  const f = fixture(t);
  fs.appendFileSync(f.result.launches[0].rawPath, "\n");
  assert.throws(() => verifyPhase(f.root, "aa"), /raw record size changed/);
});

test("DATA: rejects a missing caller rather than reconstructing success", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.root, "aa-caller.json"));
  assert.throws(() => verifyPhase(f.root, "aa"), /ENOENT/);
});

test("DATA: declaration rejects reuse and inventory changes", (t) => {
  const f = fixture(t);
  assert.throws(() => prepare(path.resolve(__dirname, "..", ".."), f.root, { runId: "DATA" }),
    /refusing reused hosted output/);
  f.declaration.tooling.pop();
  fs.writeFileSync(path.join(f.root, "predeclared.json"), JSON.stringify(f.declaration));
  assert.throws(() => verifyPhase(f.root, "aa"), /phase tooling inventory changed/);
});
