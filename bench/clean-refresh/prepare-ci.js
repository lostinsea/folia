"use strict";

const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const protocol = require("./protocol");

const TOOLING = Object.freeze([
  "run.js", "protocol.js", "worker.js", "execute-phase.ps1", "invoke-phase.ps1",
  "prepare-ci.js", "verify-phase.js", "method.md",
]);
const SOURCE_FILES = [
  "src/main.js", "src/custom-tabs.js", "test/test-tab-refresh.js",
  "scripts/prove-table-fixes.js",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function prepare(workspace, outputRoot, run) {
  assert(path.isAbsolute(workspace) && path.isAbsolute(outputRoot), "absolute staging paths required");
  assert(!fs.existsSync(outputRoot), "refusing reused hosted output");
  const candidateRevision = execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], {
    encoding: "utf8", timeout: 30000,
  }).trim();
  assert.match(candidateRevision, /^[a-f0-9]{40}$/);
  fs.mkdirSync(outputRoot);
  for (const name of TOOLING) {
    fs.copyFileSync(path.join(__dirname, name), path.join(outputRoot, name),
      fs.constants.COPYFILE_EXCL);
  }
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "folia-sec08-ci-fixtures-"));
  const owner = `${randomUUID()}\n`;
  fs.writeFileSync(path.join(storageRoot, "owner.txt"), owner, { flag: "wx" });
  const storage = fs.statSync(storageRoot);
  const declaration = {
    schema: "sec08-prospective-calibration-freeze-v1",
    candidateRoot: workspace,
    candidateRevision,
    ci: run,
    policy: protocol.POLICY,
    schedules: { aa: protocol.schedule("aa"), ab: protocol.schedule("ab") },
    storage: {
      policy: "fresh-os-temp-per-worker-v1", root: storageRoot,
      dev: storage.dev, ino: storage.ino, owner,
    },
    candidateSourceHashes: Object.fromEntries(SOURCE_FILES.map((name) =>
      [name, hash(fs.readFileSync(path.join(workspace, name)))])),
    tooling: TOOLING.map((name) => {
      const bytes = fs.readFileSync(path.join(outputRoot, name));
      return { name, bytes: bytes.length, sha256: hash(bytes) };
    }),
  };
  assert.equal(declaration.tooling.find((pin) => pin.name === "worker.js").sha256,
    "315c486b82422dad0908a204ca00c9326537084dd1b0f3cb56422ab77d760b07",
    "the selected worker bytes changed");
  fs.writeFileSync(path.join(outputRoot, "predeclared.json"),
    `${JSON.stringify(declaration, null, 2)}\n`, { flag: "wx" });
  return declaration;
}

if (require.main === module) {
  assert.equal(process.platform, "win32", "this fixed worker requires Windows");
  assert.equal(process.env.GITHUB_ACTIONS, "true", "hosted execution must run in Actions");
  assert.equal(process.env.GITHUB_RUN_ATTEMPT, "1", "this unit does not authorize workflow reruns");
  assert.match(process.env.GITHUB_RUN_ID || "", /^[0-9]+$/);
  const outputRoot = path.join(process.env.RUNNER_TEMP, "folia-sec08-ci-results");
  const declaration = prepare(process.env.GITHUB_WORKSPACE, outputRoot, {
    runId: process.env.GITHUB_RUN_ID, attempt: 1, runner: "windows-latest",
    job: process.env.GITHUB_JOB,
  });
  assert.equal(declaration.candidateRevision, process.env.GITHUB_SHA, "checkout is not the dispatched revision");
  console.log(JSON.stringify({ outputRoot, candidateRevision: declaration.candidateRevision,
    storageRoot: declaration.storage.root, phaseBudgetMs: protocol.POLICY.phaseDeadlineMs }));
}

module.exports = { TOOLING, SOURCE_FILES, prepare, hash };
