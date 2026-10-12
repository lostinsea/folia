"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const protocol = require("./protocol");
const { hash, TOOLING, SOURCE_FILES } = require("./prepare-ci");

function verifyPhase(root, mode) {
  assert(["aa", "ab"].includes(mode), "invalid phase");
  const declarationBytes = fs.readFileSync(path.join(root, "predeclared.json"));
  const declaration = JSON.parse(declarationBytes);
  assert.equal(declaration.schema, "sec08-prospective-calibration-freeze-v1");
  assert.deepEqual(declaration.tooling.map((pin) => pin.name).sort(), [...TOOLING].sort(),
    "phase tooling inventory changed");
  assert.deepEqual(Object.keys(declaration.candidateSourceHashes).sort(), [...SOURCE_FILES].sort(),
    "phase source inventory changed");
  assert.deepEqual(declaration.policy, protocol.POLICY, "phase policy changed");
  assert.deepEqual(declaration.schedules, { aa: protocol.schedule("aa"), ab: protocol.schedule("ab") },
    "phase schedules changed");
  for (const pin of declaration.tooling) {
    const bytes = fs.readFileSync(path.join(root, pin.name));
    assert.equal(bytes.length, pin.bytes, "phase tooling size changed");
    assert.equal(hash(bytes), pin.sha256, "phase tooling changed");
  }
  for (const [name, expected] of Object.entries(declaration.candidateSourceHashes)) {
    assert.equal(hash(fs.readFileSync(path.join(declaration.candidateRoot, name))), expected,
      "candidate source changed");
  }
  const resultPath = path.join(root, `${mode}-01`,
    mode === "aa" ? "aa-calibration-results.json" : "results.json");
  const bytes = fs.readFileSync(resultPath);
  const result = JSON.parse(bytes);
  const executionBytes = fs.readFileSync(path.join(root, `${mode}-execution.json`));
  const execution = JSON.parse(executionBytes);
  const caller = JSON.parse(fs.readFileSync(path.join(root, `${mode}-caller.json`)));
  assert.equal(caller.mode, mode);
  assert.equal(caller.phaseWrapperExitCode, 0, "phase wrapper failed");
  assert.equal(caller.phaseWithinBudget, true, "caller exceeded budget");
  assert.equal(caller.executionSha256, hash(executionBytes), "caller acknowledgment does not match");
  assert.equal(execution.nativeRunnerExitCode, 0, "native runner failed");
  assert.equal(execution.captureSucceeded, true, "capture failed");
  assert.equal(execution.phaseWithinBudget, true, "wrapper exceeded budget");
  assert.equal(execution.resultReadbackError, null);
  assert.deepEqual(execution.captureErrors, []);
  assert.equal(execution.mode, mode);
  assert.equal(execution.commonLockPresentAfterReturn, false, "cleanup did not complete");
  assert.equal(execution.resultSha256, hash(bytes), "native outcome does not match result");
  assert.equal(fs.existsSync(path.join(os.tmpdir(), "folia-machine-exclusive.lock")), false,
    "common lock remains");
  assert.equal(result.complete, true, "phase incomplete: no acceptance");
  assert.equal(result.decision.mode, mode);
  assert.equal(result.decision.qualified, true, "phase did not globally qualify");
  assert.equal(result.predeclaredSha256, hash(declarationBytes), "phase declaration changed");
  assert.deepEqual(result.hashes.frozenBeforeAndAfter, declaration.candidateSourceHashes,
    "phase source boundary changed");
  const pairs = protocol.schedule(mode).flatMap((pair) => pair.order.map(() => pair));
  assert.equal(result.launches.length, pairs.length, "raw inventory incomplete");
  assert.equal(result.workers.length, pairs.length, "compact inventory incomplete");
  for (let i = 0; i < pairs.length; i++) {
    const pin = result.launches[i];
    const raw = fs.readFileSync(pin.rawPath);
    assert.equal(raw.length, pin.bytes, "raw record size changed");
    assert.equal(hash(raw), pin.sha256, "raw worker record changed");
    assert.deepEqual(protocol.compactWorker(JSON.parse(raw), pairs[i], mode), result.workers[i],
      "raw/compact worker mismatch");
  }
  assert.deepEqual(protocol.analyze(result.workers, mode), result.decision,
    "phase decision does not recompute");
  return { resultPath, sha256: hash(bytes), execution, caller, hashes: result.hashes,
    runtime: { electron: result.workers[0].electron, chrome: result.workers[0].chrome } };
}

if (require.main === module) {
  const verified = verifyPhase(__dirname, process.argv[2]);
  console.log(JSON.stringify({ phase: process.argv[2], qualified: true,
    resultPath: verified.resultPath, resultSha256: verified.sha256 }));
}

module.exports = { verifyPhase };
