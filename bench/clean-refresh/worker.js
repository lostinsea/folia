"use strict";

const { app, BrowserWindow, dialog, ipcMain, contentTracing } = require("electron");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const args = new Map(process.argv.slice(2).filter((arg) => arg.startsWith("--")).map((arg) => {
  const index = arg.indexOf("=");
  return [arg.slice(2, index), arg.slice(index + 1)];
}));
const appRoot = args.get("app-root");
const userData = args.get("user-data");
const variant = args.get("variant");
const sourceVariant = args.get("source-variant");
const fixturePath = args.get("fixture");
const snapshotReadMode = args.get("snapshot-read-mode");
const tracePath = args.get("trace");
let traceStarted = false;
const CHANNEL = "read-owned-tab-disk-snapshot";
const ADOPTION_CHANNEL = "prepare-document-disk-adoption";
const PAUSE_WITNESS_CHANNEL = "sec08-clean-refresh-pause-witness";
const REPETITIONS = Number(args.get("repetitions"));
const TIMEOUT_MS = 230000;
const workerStartedAt = performance.now();
let emitted = false;
let mainWindow = null;
let snapshotHandlerRegistered = false;
let adoptionHandlerRegistered = false;
let snapshotInvokes = 0;
let adoptionInvokes = 0;
let snapshotExtraPathStats = 0;
let ownedSnapshotDepth = 0;
let adoptionDepth = 0;
let snapshotStatTrace = null;
let expectedFixturePaths = null;
let measurementActive = false;
let setupActive = false;
let largeDialogCalls = 0;
let measuring = false;
let watcherCloseCount = 0;
let watcherStartCount = 0;
const liveFixtureWatchers = new Map();
const pauseRequests = [];
const diagnosticRecords = [];
const snapshotDiagnostics = [];
const unattributedFsCalls = [];
const retainedSamples = { changed: [], unchanged: [] };
let currentDiagnostic = null;
let initialFixtureVersions = null;
const mainCounts = {
  callback: { readFile: 0, stat: 0 },
  promises: { open: 0, readFile: 0, stat: 0 },
  handle: { readFile: 0, stat: 0 },
};
const adoptionCounts = {
  callback: { readFile: 0, stat: 0 },
  promises: { open: 0, readFile: 0, stat: 0 },
  handle: { readFile: 0, stat: 0 },
};
const mainTotalCounts = {
  callback: { readFile: 0, stat: 0 },
  promises: { open: 0, readFile: 0, stat: 0 },
  handle: { readFile: 0, stat: 0 },
  sync: { readFile: 0, stat: 0, lstat: 0, exists: 0, realpath: 0 },
};
const setupTotalCounts = JSON.parse(JSON.stringify(mainTotalCounts));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function encodeDiagnostic(value, depth = 0) {
  if (value === undefined) return { unavailable: "undefined" };
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { nonfiniteNumber: String(value) };
  }
  if (typeof value === "bigint") return { bigint: String(value) };
  if (typeof value === "function") return { unavailable: "function" };
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return { unavailable: "depth-limit" };
  if (Array.isArray(value)) return value.map((item) => encodeDiagnostic(item, depth + 1));
  const result = {};
  for (const key of Object.keys(value).slice(0, 40)) {
    if (/content|markdown|html/i.test(key)) {
      result[key] = { type: typeof value[key], length: typeof value[key] === "string" ? value[key].length : null };
    } else {
      result[key] = encodeDiagnostic(value[key], depth + 1);
    }
  }
  return result;
}

function versionDiagnostic(stats) {
  return encodeDiagnostic({
    dev: stats && stats.dev, ino: stats && stats.ino, size: stats && stats.size,
    mtimeMs: stats && stats.mtimeMs, ctimeMs: stats && stats.ctimeMs,
  });
}

async function emit(payload, exitCode) {
  if (emitted) return;
  emitted = true;
  clearTimeout(timeout);
  if (exitCode === 0 && performance.now() - workerStartedAt >= TIMEOUT_MS) {
    payload = { ...payload, ok: false, reason: "worker completed after elapsed deadline" };
    exitCode = 1;
  }
  if (traceStarted) {
    try {
      await contentTracing.stopRecording(tracePath);
    } catch (error) {
      payload = { ...payload, ok: false, traceError: String(error.stack || error) };
      exitCode = 1;
    }
  }
  console.log(`SEC08_CLEAN_REFRESH_RESULT ${JSON.stringify({
    ...payload, instrumented: true, operatorAdjudicationRequired: true,
    originalWorkerSha256: "DBA58019532AFE22F62EE255E7D2622A0998BA5AC73479456B1AC242E007A146",
    initialFixtureVersions, diagnosticRecords, snapshotDiagnostics, retainedSamples,
    authoritativeMainOwner: { unavailable: "not exposed by the already-computed handler result" },
  })}`);
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
    app.exit(exitCode);
  }, 0);
}

function fail(reason, detail) {
  const failureWitness = {
    main: countSnapshot(),
    setupMain: JSON.parse(JSON.stringify(setupTotalCounts)),
    scopes: { measurementActive, setupActive, ownedSnapshotDepth, adoptionDepth },
    snapshotEnd: snapshotDiagnostics.length,
    liveFixtureWatchers: Array.from(liveFixtureWatchers.values()),
    watcherCounts: { starts: watcherStartCount, closes: watcherCloseCount },
    pauseRequests: pauseRequests.slice(),
    unattributedFsCalls: unattributedFsCalls.slice(),
    renderer: currentDiagnostic && currentDiagnostic.rendererCounts ||
      { unavailable: "no renderer counter snapshot available at synchronous failure emission" },
  };
  if (currentDiagnostic) {
    currentDiagnostic.status = "failed-instrumented-leg";
    currentDiagnostic.error = String(detail && (detail.stack || detail) || reason);
    currentDiagnostic.failureWitness = failureWitness;
  }
  emit({
    ok: false, variant, sourceVariant, snapshotReadMode, reason, failureWitness,
    detail: detail ? String(detail.stack || detail) : "",
  }, 1);
}

function normalize(filePath) {
  return path.resolve(filePath).toLowerCase();
}

function recordUnattributedFsCall(group, operation, argument) {
  if (!measurementActive && !setupActive) return;
  unattributedFsCalls.push({
    scope: setupActive ? "setup" : "measured", group, operation,
    argumentType: typeof argument,
    descriptor: typeof argument === "number" ? encodeDiagnostic(argument) : null,
  });
}

function completeLogicalSnapshotTrace(trace) {
  assert(expectedFixturePaths && expectedFixturePaths.has(normalize(trace.filePath)),
    "logical snapshot did not name a fixture path");
  assert(trace.pathStats.length === 1 || trace.pathStats.length === 2,
    `logical snapshot had unexpected path-stat trace: ${JSON.stringify(trace.pathStats)}`);
  assert(trace.pathStats[0] === trace.filePath,
    `logical snapshot did not stat data.filePath first: ${JSON.stringify(trace.pathStats)}`);
  assert(expectedFixturePaths.has(normalize(trace.pathStats[0])),
    "logical snapshot first stat was not a fixture path");
  if (trace.pathStats.length === 2) {
    assert(trace.pathStats[1] !== trace.filePath,
      "logical snapshot statted a distinct read target with an identical spelling");
    assert(expectedFixturePaths.has(normalize(trace.pathStats[1])),
      "logical snapshot read target was not the fixture path");
  }
  return trace.pathStats.length - 1;
}

function fixtureBytes(bytes, heading) {
  const prefix = `# ${heading}\n\n`;
  assert(Buffer.byteLength(prefix) <= bytes, "fixture heading exceeds selected size");
  return Buffer.concat([Buffer.from(prefix, "utf8"), Buffer.alloc(bytes - Buffer.byteLength(prefix), 0x78)]);
}

function countMainFs(fixturePaths) {
  const expected = new Set(fixturePaths.map(normalize));
  expectedFixturePaths = expected;
  const originalCallbackReadFile = fs.readFile.bind(fs);
  const originalReadFile = fs.promises.readFile.bind(fs.promises);
  const originalStat = fs.stat.bind(fs);
  const originalPromiseStat = fs.promises.stat.bind(fs.promises);
  const originalOpen = fs.promises.open.bind(fs.promises);
  const originalReadFileSync = fs.readFileSync.bind(fs);
  const originalStatSync = fs.statSync.bind(fs);
  const originalLstatSync = fs.lstatSync.bind(fs);
  const originalExistsSync = fs.existsSync.bind(fs);
  const originalRealpathSync = fs.realpathSync.bind(fs);
  const originalRealpathNative = fs.realpathSync.native.bind(fs.realpathSync);
  const handlerCounts = (filePath) => {
    if (typeof filePath !== "string") return null;
    if (!expected.has(normalize(filePath))) return null;
    if (ownedSnapshotDepth > 0 && adoptionDepth > 0) {
      throw new Error("fixture I/O overlapped snapshot and adoption handlers");
    }
    if (ownedSnapshotDepth > 0) return mainCounts;
    if (adoptionDepth > 0) return adoptionCounts;
    return null;
  };
  const countTotal = (group, operation, filePath) => {
    assert(!(measurementActive && setupActive), "setup and measured I/O scopes overlapped");
    if (!measurementActive && !setupActive) return;
    if (typeof filePath !== "string") {
      recordUnattributedFsCall(group, operation, filePath);
      return;
    }
    if (expected.has(normalize(filePath))) {
      if (setupActive) setupTotalCounts[group][operation] += 1;
      else if (measurementActive) mainTotalCounts[group][operation] += 1;
    }
  };
  const count = (group, operation, filePath) => {
    countTotal(group, operation, filePath);
    const counts = handlerCounts(filePath);
    if (counts) counts[group][operation] += 1;
  };
  fs.readFile = (filePath, ...rest) => {
    count("callback", "readFile", filePath);
    return originalCallbackReadFile(filePath, ...rest);
  };
  fs.promises.readFile = async (filePath, ...rest) => {
    count("promises", "readFile", filePath);
    return originalReadFile(filePath, ...rest);
  };
  fs.stat = (filePath, ...rest) => {
    count("callback", "stat", filePath);
    return originalStat(filePath, ...rest);
  };
  fs.promises.stat = async (filePath, ...rest) => {
    if (ownedSnapshotDepth > 0 && snapshotStatTrace) {
      snapshotStatTrace.pathStats.push(filePath);
    }
    count("promises", "stat", filePath);
    return originalPromiseStat(filePath, ...rest);
  };
  fs.promises.open = async (filePath, ...rest) => {
    const counts = handlerCounts(filePath);
    countTotal("promises", "open", filePath);
    if (counts) counts.promises.open += 1;
    const handle = await originalOpen(filePath, ...rest);
    if (typeof filePath !== "string" || !expected.has(normalize(filePath))) return handle;
    const originalHandleReadFile = handle.readFile.bind(handle);
    const originalHandleStat = handle.stat.bind(handle);
    handle.readFile = async (...handleArgs) => {
      countTotal("handle", "readFile", filePath);
      if (counts) counts.handle.readFile += 1;
      return originalHandleReadFile(...handleArgs);
    };
    handle.stat = async (...handleArgs) => {
      countTotal("handle", "stat", filePath);
      if (counts) counts.handle.stat += 1;
      return originalHandleStat(...handleArgs);
    };
    return handle;
  };
  fs.readFileSync = (filePath, ...rest) => {
    countTotal("sync", "readFile", filePath);
    return originalReadFileSync(filePath, ...rest);
  };
  fs.statSync = (filePath, ...rest) => {
    countTotal("sync", "stat", filePath);
    return originalStatSync(filePath, ...rest);
  };
  fs.lstatSync = (filePath, ...rest) => {
    countTotal("sync", "lstat", filePath);
    return originalLstatSync(filePath, ...rest);
  };
  fs.existsSync = (filePath) => {
    countTotal("sync", "exists", filePath);
    return originalExistsSync(filePath);
  };
  const realpathSync = (filePath, ...rest) => {
    countTotal("sync", "realpath", filePath);
    return originalRealpathSync(filePath, ...rest);
  };
  realpathSync.native = (filePath, ...rest) => {
    countTotal("sync", "realpath", filePath);
    return originalRealpathNative(filePath, ...rest);
  };
  fs.realpathSync = realpathSync;
}

function rendererSetupScript(fixturePaths) {
  return `(() => {
    const expected = new Set(${JSON.stringify(fixturePaths.map(normalize))});
    const normal = (value) => String(value).replace(/\\//g, "\\\\").toLowerCase();
    if (!window.fs || typeof window.fs.readFileSync !== "function" || typeof window.fs.statSync !== "function") {
      throw new Error("renderer filesystem bridge is unavailable");
    }
    const originalRead = window.fs.readFileSync.bind(window.fs);
    const originalStat = window.fs.statSync.bind(window.fs);
    const counts = { readFileSync: 0, statSync: 0 };
    const encode = ${encodeDiagnostic.toString()};
    const unattributedFsCalls = [];
    let unattributedStart = 0;
    const recordUnattributed = (operation, argument) => {
      unattributedFsCalls.push({
        operation, argumentType: typeof argument,
        descriptor: typeof argument === "number" ? encode(argument) : null,
      });
    };
    const completions = [];
    let completionSequence = 0;
    let recordedCompletionCount = 0;
    let leg = null;
    let firstStat = null;
    let beforeLeg = null;
    let lastMeasuredTarget = null;
    const tabState = (filePath) => {
      const tabs = window.CustomTabs && window.CustomTabs.getTabs();
      const tab = tabs && tabs.find((entry) => entry.filePath === filePath);
      if (!tab) return { unavailable: "target tab not present" };
      return {
        fields: encode(tab),
        diskVersion: encode(tab.diskVersion),
        modifiedTime: encode(tab.modifiedTime),
        owner: { rendererState: encode(tab.owner), authoritativeMainOwner: { unavailable: "not exposed" } },
      };
    };
    const state = (filePath) => ({
      target: tabState(filePath),
      activeTitle: document.querySelector(".tab.active") && document.querySelector(".tab.active").title,
      completionSequence,
    });
    const completionOriginal = window.completeFileOpen;
    window.completeFileOpen = function(context, ...args) {
      const record = {
        sequence: ++completionSequence,
        leg: encode(leg),
        path: encode(context && context.path),
        context: encode(context),
        before: context && typeof context.path === "string" ? state(context.path) : { unavailable: "no context path" },
        trackedTargetBefore: lastMeasuredTarget ? state(lastMeasuredTarget) : { unavailable: "no prior measured target" },
      };
      completions.push(record);
      try {
        const accepted = completionOriginal.call(this, context, ...args);
        record.accepted = accepted === true;
        record.returnValue = encode(accepted);
        record.after = context && typeof context.path === "string" ? state(context.path) : { unavailable: "no context path" };
        record.trackedTargetAfter = lastMeasuredTarget ? state(lastMeasuredTarget) : { unavailable: "no prior measured target" };
        return accepted;
      } catch (error) {
        record.error = String(error.stack || error);
        record.after = context && typeof context.path === "string" ? state(context.path) : { unavailable: "no context path" };
        record.trackedTargetAfter = lastMeasuredTarget ? state(lastMeasuredTarget) : { unavailable: "no prior measured target" };
        throw error;
      }
    };
    window.fs.readFileSync = (...args) => {
      if (typeof args[0] !== "string") recordUnattributed("readFileSync", args[0]);
      else if (expected.has(normal(args[0]))) counts.readFileSync += 1;
      return originalRead(...args);
    };
    window.fs.statSync = (...args) => {
      if (typeof args[0] !== "string") recordUnattributed("statSync", args[0]);
      else if (expected.has(normal(args[0]))) counts.statSync += 1;
      const cachedBeforeStat = typeof args[0] === "string" && leg &&
        firstStat === null && normal(args[0]) === normal(leg.filePath)
        ? tabState(leg.filePath) : null;
      const result = originalStat(...args);
      if (cachedBeforeStat) {
        firstStat = {
          path: String(args[0]),
          cachedBeforeStat,
          disk: encode({
            dev: result.dev, ino: result.ino, size: result.size,
            mtimeMs: result.mtimeMs, ctimeMs: result.ctimeMs,
          }),
        };
      }
      return result;
    };
    window.__sec08CleanRefreshProbe = {
      counts,
      peekState(filePath) { return state(filePath); },
      controlState(filePath) {
        const matching = completions.filter((entry) => entry.path === filePath);
        const latest = matching.length ? matching[matching.length - 1] : null;
        return {
          activeTitle: document.querySelector(".tab.active") && document.querySelector(".tab.active").title,
          completionSequence,
          latest: latest && { sequence: latest.sequence, accepted: latest.accepted },
          counts: { ...counts },
          unattributedFsCallCount: unattributedFsCalls.length,
        };
      },
      reset() { counts.readFileSync = 0; counts.statSync = 0; },
      snapshot() { return { ...counts }; },
      attributionSnapshot() { return unattributedFsCalls.slice(); },
      armDiagnostic(context) {
        leg = context;
        unattributedStart = unattributedFsCalls.length;
        lastMeasuredTarget = context.filePath;
        firstStat = null;
        beforeLeg = state(context.filePath);
      },
      diagnosticSnapshot() {
        return {
          leg: encode(leg), beforeLeg, firstStat, after: leg ? state(leg.filePath) : null,
          completionRange: { start: recordedCompletionCount, end: completions.length },
          completions: completions.slice(recordedCompletionCount),
          unattributedFsCalls: unattributedFsCalls.slice(unattributedStart),
        };
      },
      finishDiagnostic() {
        const result = this.diagnosticSnapshot();
        recordedCompletionCount = completions.length;
        leg = null;
        return result;
      },
    };
    return { completeFileOpen: typeof window.completeFileOpen, hasCustomTabs: typeof window.CustomTabs };
  })()`;
}

function setupTabsScript(manifest) {
  return `(() => (async () => {
    const viewer = document.getElementById("viewer");
    const timeout = (label) => new Promise((_, rejectTimeout) =>
      setTimeout(() => rejectTimeout(new Error(label)), 30000));
    const waitForHeading = (heading) => Promise.race([
      new Promise((resolveHeading, rejectHeading) => {
        const startedAt = performance.now();
        const check = () => {
          if (performance.now() - startedAt >= 30000) {
            return rejectHeading(new Error("initial heading exceeded elapsed deadline: " + heading));
          }
          if (viewer && viewer.innerText.includes(heading)) return resolveHeading();
          setTimeout(check, 20);
        };
        check();
      }), timeout("initial heading was not rendered: " + heading),
    ]);
    if (!window.CustomTabs ||
        typeof window.CustomTabs.createTab !== "function" ||
        typeof window.CustomTabs.switchToTab !== "function" ||
        typeof window.CustomTabs.getTabs !== "function" ||
        typeof window.completeFileOpen !== "function") {
      throw new Error("tab setup ownership API is unavailable");
    }
    const createBackgroundTab = (filePath) => {
      const content = window.fs.readFileSync(filePath, "utf8");
      const tab = window.CustomTabs.createTab(filePath, content, {
        activate: false,
        confirmed: true,
      });
      if (!tab || tab.filePath !== filePath || !window.CustomTabs.getTabs().includes(tab)) {
        throw new Error("background tab was not created: " + filePath);
      }
      return tab;
    };
    const created = ${JSON.stringify(manifest.tabs)}.map((tab) => createBackgroundTab(tab.filePath));
    const controlTab = createBackgroundTab(${JSON.stringify(manifest.controlPath)});
    if (created.length !== ${manifest.measuredTabCount} ||
        new Set([...created, controlTab].map((tab) => tab.id)).size !== created.length + 1) {
      throw new Error("background tab identities are not distinct");
    }
    const setupOriginalCompletion = window.completeFileOpen;
    const setupCompletions = [];
    const setupCompletionWrapper = function(context, ...args) {
      const accepted = setupOriginalCompletion.call(this, context, ...args);
      if (context && context.path === ${JSON.stringify(manifest.controlPath)}) {
        setupCompletions.push({ accepted: accepted === true });
      }
      return accepted;
    };
    window.completeFileOpen = setupCompletionWrapper;
    try {
      await Promise.resolve(window.CustomTabs.switchToTab(controlTab.id));
      await waitForHeading(${JSON.stringify(`SEC08 control ${manifest.size}-${manifest.measuredTabCount}`)});
      await Promise.race([
        new Promise((resolveCompletion) => {
          const poll = () => {
            if (setupCompletions.length > 0) return resolveCompletion();
            setTimeout(poll, 20);
          };
          poll();
        }),
        timeout("control switch did not reach completeFileOpen"),
      ]);
      if (setupCompletions.length !== 1 || setupCompletions[0].accepted !== true) {
        throw new Error("control switch completion was not accepted");
      }
    } finally {
      if (window.completeFileOpen !== setupCompletionWrapper) {
        throw new Error("setup completion wrapper was replaced before restoration");
      }
      window.completeFileOpen = setupOriginalCompletion;
    }
    const control = Array.from(document.querySelectorAll(".tab")).find((tab) => tab.title === ${JSON.stringify(manifest.controlPath)});
    if (!control || !control.classList.contains("active")) throw new Error("control tab is not active after completeFileOpen setup");
    if (!window.ipcRenderer || typeof window.ipcRenderer.send !== "function") {
      throw new Error("renderer IPC bridge is unavailable for watcher pause");
    }
    const pageSession = window.getReloadRequestSession();
    const identity = window.CustomTabs.getActiveDocumentIdentity(${JSON.stringify(manifest.controlPath)}, pageSession);
    const selectionGeneration = window.getActiveFileSelectionGeneration();
    const owner = identity && { ...identity, selectionGeneration };
    if (!owner || owner.pageSession !== pageSession ||
        !Number.isSafeInteger(owner.rendererGeneration) || owner.rendererGeneration <= 0 ||
        !Number.isSafeInteger(owner.selectionGeneration) || owner.selectionGeneration <= 0) {
      throw new Error("control tab has no authenticated watcher owner");
    }
    const beforePause = await window.ipcRenderer.invoke(${JSON.stringify(PAUSE_WITNESS_CHANNEL)});
    window.ipcRenderer.send("pause-file-watching", {
      filePath: ${JSON.stringify(manifest.controlPath)},
      pageSession,
      rendererGeneration: owner.rendererGeneration,
      owner,
    });
    const observed = await window.ipcRenderer.invoke(${JSON.stringify(PAUSE_WITNESS_CHANNEL)});
    if (
      !beforePause ||
      !observed ||
      !Array.isArray(observed.requests) ||
      observed.requests.length !== beforePause.requests.length + 1 ||
      observed.watcherCloseCount <= beforePause.watcherCloseCount
    ) {
      throw new Error("main did not accept and apply the watcher pause envelope");
    }
    const pause = observed.requests[observed.requests.length - 1];
    if (
      pause.filePath !== ${JSON.stringify(manifest.controlPath)} ||
      pause.pageSession !== pageSession ||
      pause.rendererGeneration !== owner.rendererGeneration ||
      !pause.owner ||
      pause.owner.tabId !== owner.tabId ||
      pause.owner.documentGeneration !== owner.documentGeneration ||
      pause.owner.selectionGeneration !== owner.selectionGeneration
    ) throw new Error("main received a different watcher pause envelope");
    return { tabNodes: document.querySelectorAll(".tab").length, controlActive: true, pauseWitness: true };
  })())()`;
}

function clickAndObserveScript(filePath, heading) {
  return `(() => new Promise((resolve, reject) => {
    const targetPath = ${JSON.stringify(filePath)};
    const heading = ${JSON.stringify(heading)};
    const viewer = document.getElementById("viewer");
    const tab = Array.from(document.querySelectorAll(".tab")).find((node) => node.title === targetPath);
    if (!viewer || !tab) return reject(new Error("missing viewer or target tab"));
    if (tab.classList.contains("active")) return reject(new Error("target tab was already active before measured switch"));
    const tabId = tab.dataset.tabId;
    if (!tabId) return reject(new Error("target tab lacks a stable tab ID"));
    const t0 = performance.now();
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("distinct heading did not render: " + heading));
    }, 30000);
    const check = () => {
      const active = document.querySelector(".tab.active");
      if (!active || active.dataset.tabId !== tabId || active.title !== targetPath ||
          !viewer.innerText.includes(heading)) return;
      observer.disconnect();
      clearTimeout(timer);
      const elapsedMs = performance.now() - t0;
      if (elapsedMs >= 30000) {
        return reject(new Error("heading observation exceeded elapsed deadline: " + heading));
      }
      resolve({ elapsedMs, activeTitle: active.title, headingVisible: true });
    };
    const observer = new MutationObserver(check);
    observer.observe(viewer, { childList: true, subtree: true, characterData: true });
    tab.click();
    check();
  }))()`;
}

function countsScript(reset, diagnosticContext = null, includeAttribution = false) {
  return `(() => {
    const probe = window.__sec08CleanRefreshProbe;
    if (!probe) throw new Error("renderer probe is unavailable");
    ${reset ? `probe.reset(); probe.armDiagnostic(${JSON.stringify(diagnosticContext)});` :
      includeAttribution ?
        "return { ...probe.snapshot(), unattributedFsCalls: probe.attributionSnapshot() };" :
        "return probe.snapshot();"}
  })()`;
}

function controlBarrierScript(filePath, minimumSequence) {
  return `(() => (async () => {
    const filePath = ${JSON.stringify(filePath)};
    const minimumSequence = ${JSON.stringify(minimumSequence)};
    const probe = window.__sec08CleanRefreshProbe;
    const deadline = performance.now() + 30000;
    let completion;
    for (;;) {
      if (performance.now() >= deadline) throw new Error("control completion barrier timed out");
      const observed = probe.controlState(filePath);
      if (observed.activeTitle === filePath && observed.latest &&
          observed.latest.sequence >= minimumSequence) {
        if (observed.latest.accepted !== true) throw new Error("control completion was rejected");
        completion = observed.latest;
        break;
      }
      if (performance.now() >= deadline) throw new Error("control completion barrier timed out");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const pageSession = window.getReloadRequestSession();
    const identity = window.CustomTabs.getActiveDocumentIdentity(filePath, pageSession);
    const selectionGeneration = window.getActiveFileSelectionGeneration();
    const owner = identity && { ...identity, selectionGeneration };
    if (!owner || owner.pageSession !== pageSession ||
        !Number.isSafeInteger(owner.rendererGeneration) || owner.rendererGeneration <= 0 ||
        !Number.isSafeInteger(selectionGeneration) || selectionGeneration <= 0) {
      throw new Error("control has no authenticated watcher owner");
    }
    const envelope = { filePath, pageSession, rendererGeneration: owner.rendererGeneration, owner };
    const channel = ${JSON.stringify(PAUSE_WITNESS_CHANNEL)};
    const before = await window.ipcRenderer.invoke(channel);
    window.ipcRenderer.send("resume-file-watching", envelope);
    const resumed = await window.ipcRenderer.invoke(channel);
    if (resumed.liveFixtureWatchers.length !== 1 ||
        resumed.liveFixtureWatchers[0] !== filePath) {
      throw new Error("control watcher was not live before pause");
    }
    window.ipcRenderer.send("pause-file-watching", envelope);
    const paused = await window.ipcRenderer.invoke(channel);
    const received = paused.requests[paused.requests.length - 1];
    if (paused.requests.length !== resumed.requests.length + 1 ||
        paused.watcherCloseCount !== resumed.watcherCloseCount + 1 ||
        paused.liveFixtureWatchers.length !== 0 ||
        !received || received.filePath !== filePath || received.pageSession !== pageSession ||
        received.rendererGeneration !== owner.rendererGeneration ||
        !received.owner || received.owner.tabId !== owner.tabId ||
        received.owner.documentGeneration !== owner.documentGeneration ||
        received.owner.selectionGeneration !== owner.selectionGeneration) {
      throw new Error("control watcher pause effect or owner envelope was not proven");
    }
    return {
      completion, liveBefore: before.liveFixtureWatchers,
      resumed: resumed.liveFixtureWatchers, paused: paused.liveFixtureWatchers,
      watcherStartDelta: paused.watcherStartCount - before.watcherStartCount,
      watcherCloseDelta: paused.watcherCloseCount - before.watcherCloseCount,
      auxiliaryInvokes: 3, resumeSends: 1, pauseSends: 1,
      identityLookupOutsideTimer: true,
    };
  })())()`;
}

function sameFixtureVersion(left, right) {
  const valid = (value) => value && typeof value === "object" &&
    ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => Number.isFinite(value[key]));
  return !!(valid(left) && valid(right) &&
    ["dev", "ino", "size", "mtimeMs"].every((key) => left[key] === right[key]));
}

function assertFixtureSetup(operation, beforeVersion, expectedVersion, disk, cached) {
  assert(sameFixtureVersion(beforeVersion, cached),
    `${operation} fixture setup cached version differs from preceding producer version`);
  assert(sameFixtureVersion(expectedVersion, disk),
    `${operation} fixture setup disk version differs from producer version`);
  if (operation === "changed") {
    assert(expectedVersion.mtimeMs > beforeVersion.mtimeMs,
      "changed fixture setup has no genuine write-generated mtime advance");
  } else {
    assert(operation === "unchanged" && sameFixtureVersion(cached, disk),
      "unchanged fixture setup cached/disk versions differ");
  }
}

function counterDifference(after, before) {
  return Object.fromEntries(Object.keys(after).map((group) => [group,
    Object.fromEntries(Object.keys(after[group]).map((operation) => [operation,
      after[group][operation] - before[group][operation]])),
  ]));
}

function completionScript(action, filePath = null) {
  if (action === "arm") {
    return `(() => {
      if (window.__sec08CleanRefreshCompletion) throw new Error("completion witness was already armed");
      const expectedPath = ${JSON.stringify(filePath)};
      const original = window.completeFileOpen;
      if (typeof original !== "function") throw new Error("completeFileOpen is unavailable");
      const calls = [];
      const wrapper = function(context, ...args) {
        const accepted = original.call(this, context, ...args);
        if (context && context.path === expectedPath) {
          calls.push({
            path: context.path,
            accepted: accepted === true,
            renderer: window.__sec08CleanRefreshProbe.snapshot(),
          });
        }
        return accepted;
      };
      window.__sec08CleanRefreshCompletion = { original, wrapper, calls };
      window.completeFileOpen = wrapper;
    })()`;
  }
  if (action === "snapshot") {
    return `(() => {
      const state = window.__sec08CleanRefreshCompletion;
      if (!state || window.completeFileOpen !== state.wrapper) {
        throw new Error("completion witness was not armed by this sample");
      }
      return state.calls;
    })()`;
  }
  if (action !== "restore") throw new Error("invalid completion witness action");
  return `(() => {
    const state = window.__sec08CleanRefreshCompletion;
    if (!state || window.completeFileOpen !== state.wrapper) {
      throw new Error("completion witness was not armed by this sample");
    }
    window.completeFileOpen = state.original;
    delete window.__sec08CleanRefreshCompletion;
    return {
      calls: state.calls,
      diagnostic: window.__sec08CleanRefreshProbe.finishDiagnostic(),
      rendererCounts: window.__sec08CleanRefreshProbe.snapshot(),
    };
  })()`;
}

function expectedCounts(operation, logicalReadTargetStats) {
  const noSnapshotRead = {
    callback: { readFile: 0, stat: 0 },
    promises: { open: 0, readFile: 0, stat: 0 },
    handle: { readFile: 0, stat: 0 },
  };
  if (operation === "unchanged") {
    return {
      invokes: 0, logicalReadTargetStats: 0,
      mainSnapshot: noSnapshotRead, renderer: { readFileSync: 0, statSync: 1 },
    };
  }
  if (snapshotReadMode === "renderer-baseline") {
    // Frozen 790c1bc changed switch: 1+2+2 refresh/adoption, 1+2 handoff,
    // then 2 post-render and 2 accepted-completion path/version checks.
    return {
      invokes: 0, logicalReadTargetStats: 0,
      mainSnapshot: noSnapshotRead, renderer: { readFileSync: 1, statSync: 12 },
    };
  }
  if (snapshotReadMode === "path-based") {
    // Candidate changed switch: 1+2 detection/adoption, 1+2 handoff,
    // then 2 post-render and 2 accepted-completion path/version checks.
    return {
      invokes: 1, logicalReadTargetStats: 0,
      mainSnapshot: {
        callback: { readFile: 1, stat: 2 },
        promises: { open: 0, readFile: 0, stat: 0 },
        handle: { readFile: 0, stat: 0 },
      },
      renderer: { readFileSync: 0, statSync: 10 },
    };
  }
  const extraPathStat = snapshotReadMode === "logical-fd-pinned"
    ? logicalReadTargetStats
    : 0;
  assert(extraPathStat === 0 || extraPathStat === 1,
    `invalid logical read-target stat count: ${extraPathStat}`);
  // Candidate changed switch: 1+2 detection/adoption, 1+2 handoff,
  // then 2 post-render and 2 accepted-completion path/version checks.
  return {
    invokes: 1, logicalReadTargetStats: extraPathStat,
    mainSnapshot: {
      callback: { readFile: 0, stat: 0 },
      promises: { open: 1, readFile: 0, stat: 1 + extraPathStat },
      handle: { readFile: 1, stat: 2 },
    },
    renderer: { readFileSync: 0, statSync: 10 },
  };
}

function expectedAdoptionCounts(operation) {
  const noAdoptionRead = {
    callback: { readFile: 0, stat: 0 },
    promises: { open: 0, readFile: 0, stat: 0 },
    handle: { readFile: 0, stat: 0 },
  };
  if (operation === "unchanged") {
    return { invokes: 0, mainAdoption: noAdoptionRead };
  }
  // prepare-document-disk-adoption: open, handle stat/read/stat, path stat.
  return {
    invokes: 1,
    mainAdoption: {
      callback: { readFile: 0, stat: 0 },
      promises: { open: 1, readFile: 0, stat: 1 },
      handle: { readFile: 1, stat: 2 },
    },
  };
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function hashFile(filePath) {
  return require("crypto").createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function totalFixtureReads(counts) {
  return counts.callback.readFile +
    counts.promises.readFile +
    counts.handle.readFile +
    counts.sync.readFile;
}

function snapshotFixtureReads(counts) {
  return counts.callback.readFile +
    counts.promises.readFile +
    counts.handle.readFile;
}

function fixtureHashes() {
  return Object.fromEntries([
    ...manifest.tabs.map((tab) => [path.basename(tab.filePath), hashFile(tab.filePath)]),
    [path.basename(manifest.controlPath), hashFile(manifest.controlPath)],
  ]);
}

function countSnapshot() {
  return {
    invokes: snapshotInvokes,
    logicalReadTargetStats: snapshotExtraPathStats,
    adoptionInvokes,
    mainSnapshot: {
      callback: { ...mainCounts.callback },
      promises: { ...mainCounts.promises },
      handle: { ...mainCounts.handle },
    },
    mainAdoption: {
      callback: { ...adoptionCounts.callback },
      promises: { ...adoptionCounts.promises },
      handle: { ...adoptionCounts.handle },
    },
    mainTotal: {
      callback: { ...mainTotalCounts.callback },
      promises: { ...mainTotalCounts.promises },
      handle: { ...mainTotalCounts.handle },
      sync: { ...mainTotalCounts.sync },
    },
  };
}

async function waitForRendererWitnessQuiescence(win) {
  let previous = {
    renderer: await win.webContents.executeJavaScript(countsScript(false), true),
    mainTotal: countSnapshot().mainTotal,
  };
  let quietRounds = 0;
  for (let poll = 0; poll < 40; poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    const current = {
      renderer: await win.webContents.executeJavaScript(countsScript(false), true),
      mainTotal: countSnapshot().mainTotal,
    };
    if (equal(current, previous)) {
      quietRounds += 1;
      if (quietRounds === 3) return previous.renderer;
    } else {
      quietRounds = 0;
      previous = current;
    }
  }
  throw new Error("renderer filesystem witness did not quiesce within one second");
}

async function waitForAcceptedCompletion(win, filePath) {
  for (let poll = 0; poll < 40; poll += 1) {
    const calls = await win.webContents.executeJavaScript(completionScript("snapshot"), true);
    if (calls.length === 1) {
      assert(calls[0].path === filePath,
        `completion witness observed a different path: ${JSON.stringify(calls[0])}`);
      assert(calls[0].accepted === true,
        `completion witness was rejected: ${JSON.stringify(calls[0])}`);
      return calls[0];
    }
    if (calls.length > 1) {
      throw new Error(`completion witness was invoked more than once: ${JSON.stringify(calls)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("accepted completion did not arrive within one second");
}

async function sample(win, operation, filePath, heading, beforeMtimeMs, repetition, beforeVersion) {
  currentDiagnostic = {
    operation, repetition, filePath, heading, beforeMtimeMs,
    phase: "control-transition", status: "in-progress",
    snapshotStart: snapshotDiagnostics.length,
  };
  diagnosticRecords.push(currentDiagnostic);
  assert(beforeVersion && beforeVersion.mtimeMs === beforeMtimeMs,
    "fixture producer version and mtime arguments disagree");
  const controlPath = manifest.controlPath;
  const setupStart = JSON.parse(JSON.stringify(setupTotalCounts));
  currentDiagnostic.setupMainBefore = setupStart;
  const watcherStart = watcherStartCount;
  const watcherClose = watcherCloseCount;
  const unattributedSetupStart = unattributedFsCalls.length;
  let hashBefore;
  let expectedVersion = beforeVersion;
  setupActive = true;
  try {
    const controlBefore = await win.webContents.executeJavaScript(
      `window.__sec08CleanRefreshProbe.controlState(${JSON.stringify(controlPath)})`, true);
    currentDiagnostic.setup = { controlBefore };
    const switched = controlBefore.activeTitle !== controlPath;
    if (switched) {
      await win.webContents.executeJavaScript(
        clickAndObserveScript(controlPath, `SEC08 control ${manifest.size}-${manifest.measuredTabCount}`), true);
    }
    currentDiagnostic.setup.control = await win.webContents.executeJavaScript(
      controlBarrierScript(controlPath, controlBefore.completionSequence + (switched ? 1 : 0)), true);
    await waitForRendererWitnessQuiescence(win);
    currentDiagnostic.phase = "fixture-mutation";
    hashBefore = hashFile(filePath);
    currentDiagnostic.setup.directFixtureWrites = 0;
    currentDiagnostic.setup.timestampSetters = 0;
    if (operation === "changed") {
      const bytes = fixtureBytes(manifest.bytes, heading);
      fs.writeFileSync(filePath, bytes);
      currentDiagnostic.setup.directFixtureWrites = 1;
      expectedVersion = versionDiagnostic(fs.statSync(filePath));
      currentDiagnostic.writeStat = expectedVersion;
      assert(expectedVersion.mtimeMs > beforeMtimeMs, "fixture mtime did not advance from the real write");
      assert(hashFile(filePath) === require("crypto").createHash("sha256").update(bytes).digest("hex"),
        "fixture bytes differ after changed-disk write");
      beforeMtimeMs = expectedVersion.mtimeMs;
    }
    currentDiagnostic.phase = "fixture-version-setup";
    const disk = versionDiagnostic(fs.statSync(filePath));
    const cached = await win.webContents.executeJavaScript(
      `window.__sec08CleanRefreshProbe.peekState(${JSON.stringify(filePath)})`, true);
    currentDiagnostic.setup.versions = { beforeVersion, expectedVersion, disk, cached };
    const rendererAfterSetup = await win.webContents.executeJavaScript(countsScript(false, null, true), true);
    currentDiagnostic.setup.rendererIo = {
      readFileSync: rendererAfterSetup.readFileSync - controlBefore.counts.readFileSync,
      statSync: rendererAfterSetup.statSync - controlBefore.counts.statSync,
    };
    currentDiagnostic.setup.rendererAttribution = {
      start: controlBefore.unattributedFsCallCount,
      records: rendererAfterSetup.unattributedFsCalls,
    };
    assert(Array.isArray(rendererAfterSetup.unattributedFsCalls) &&
      Number.isSafeInteger(controlBefore.unattributedFsCallCount) &&
      controlBefore.unattributedFsCallCount >= 0 &&
      controlBefore.unattributedFsCallCount <= rendererAfterSetup.unattributedFsCalls.length,
      "fixture setup renderer filesystem attribution boundary is unavailable");
    currentDiagnostic.setup.rendererUnattributedFsCalls =
      rendererAfterSetup.unattributedFsCalls.slice(controlBefore.unattributedFsCallCount);
    assert(cached && cached.target && cached.target.fields &&
      cached.target.fields.filePath === filePath && cached.target.fields.hasUnsavedChanges === false,
      "fixture setup target is missing, dirty, or path-mismatched");
    assertFixtureSetup(operation, beforeVersion, expectedVersion, disk, cached.target.diskVersion);
  } finally {
    setupActive = false;
    currentDiagnostic.setup = currentDiagnostic.setup || {};
    currentDiagnostic.setup.mainIo = counterDifference(setupTotalCounts, setupStart);
    currentDiagnostic.setup.watcherStarts = watcherStartCount - watcherStart;
    currentDiagnostic.setup.watcherCloses = watcherCloseCount - watcherClose;
    currentDiagnostic.setup.unattributedFsCalls = unattributedFsCalls.slice(unattributedSetupStart);
    currentDiagnostic.setup.outsideHeadingTimer = true;
  }
  assert(currentDiagnostic.setup.unattributedFsCalls.length === 0,
    "fixture setup filesystem attribution is incomplete for non-string arguments");
  assert(currentDiagnostic.setup.rendererUnattributedFsCalls.length === 0,
    "fixture setup renderer filesystem attribution is incomplete for non-string arguments");
  currentDiagnostic.phase = "measured-leg";
  await win.webContents.executeJavaScript(countsScript(true, {
    operation, repetition, filePath, heading,
  }), true);
  const before = countSnapshot();
  currentDiagnostic.mainBefore = before;
  const unattributedMeasurementStart = unattributedFsCalls.length;
  let timed;
  let renderer;
  let completionArmed = false;
  let completionCalls;
  let acceptedCompletion = null;
  measurementActive = true;
  try {
    await win.webContents.executeJavaScript(completionScript("arm", filePath), true);
    completionArmed = true;
    timed = await win.webContents.executeJavaScript(clickAndObserveScript(filePath, heading), true);
    currentDiagnostic.timed = timed;
    // The heading is the user-visible timer endpoint, but a detached render
    // completion verifies adoption afterward. Changed samples must observe that
    // acceptance before filesystem quiescence can be meaningful.
    if (operation === "changed") {
      acceptedCompletion = await waitForAcceptedCompletion(win, filePath);
    }
    renderer = await waitForRendererWitnessQuiescence(win);
    currentDiagnostic.rendererCounts = renderer;
    const restored = await win.webContents.executeJavaScript(completionScript("restore"), true);
    completionCalls = restored.calls;
    currentDiagnostic.rendererState = restored.diagnostic;
    currentDiagnostic.rendererCounts = restored.rendererCounts;
    currentDiagnostic.completionCalls = restored.calls;
    completionArmed = false;
  } catch (error) {
    currentDiagnostic.error = String(error.stack || error);
    currentDiagnostic.measurementError = currentDiagnostic.error;
    currentDiagnostic.status = "failed-before-ledger";
    throw error;
  } finally {
    try {
      if (completionArmed) {
        const restored = await win.webContents.executeJavaScript(completionScript("restore"), true);
        currentDiagnostic.rendererState = restored.diagnostic;
        currentDiagnostic.rendererCounts = restored.rendererCounts;
        currentDiagnostic.completionCalls = restored.calls;
      }
    } catch (error) {
      currentDiagnostic.completionRestoreError = String(error.stack || error);
      throw error;
    } finally {
      measurementActive = false;
      currentDiagnostic.mainAfter = countSnapshot();
      currentDiagnostic.snapshotEnd = snapshotDiagnostics.length;
      currentDiagnostic.acceptedCompletionVariable = acceptedCompletion;
      currentDiagnostic.unattributedFsCalls = unattributedFsCalls.slice(unattributedMeasurementStart);
    }
  }
  const after = countSnapshot();
  const assertedWitness = {
    invokes: after.invokes - before.invokes,
    logicalReadTargetStats: after.logicalReadTargetStats - before.logicalReadTargetStats,
    mainSnapshot: {
      callback: {
        readFile: after.mainSnapshot.callback.readFile - before.mainSnapshot.callback.readFile,
        stat: after.mainSnapshot.callback.stat - before.mainSnapshot.callback.stat,
      },
      promises: {
        open: after.mainSnapshot.promises.open - before.mainSnapshot.promises.open,
        readFile: after.mainSnapshot.promises.readFile - before.mainSnapshot.promises.readFile,
        stat: after.mainSnapshot.promises.stat - before.mainSnapshot.promises.stat,
      },
      handle: {
        readFile: after.mainSnapshot.handle.readFile - before.mainSnapshot.handle.readFile,
        stat: after.mainSnapshot.handle.stat - before.mainSnapshot.handle.stat,
      },
    },
    renderer,
  };
  currentDiagnostic.assertedWitness = assertedWitness;
  const expected = expectedCounts(operation, assertedWitness.logicalReadTargetStats);
  currentDiagnostic.expectedWitness = expected;
  currentDiagnostic.completionCalls = completionCalls;
  currentDiagnostic.mainAfter = after;
  currentDiagnostic.phase = "filesystem-attribution-validation";
  assert(currentDiagnostic.unattributedFsCalls.length === 0,
    "measured filesystem attribution is incomplete for non-string arguments");
  assert(currentDiagnostic.rendererState &&
    Array.isArray(currentDiagnostic.rendererState.unattributedFsCalls) &&
    currentDiagnostic.rendererState.unattributedFsCalls.length === 0,
    "measured renderer filesystem attribution is incomplete for non-string arguments");
  currentDiagnostic.phase = "first-stat-setup-validation";
  const firstStat = currentDiagnostic.rendererState && currentDiagnostic.rendererState.firstStat;
  assert(firstStat && firstStat.path === filePath, "fixture setup first stat witness is missing");
  assertFixtureSetup(operation, beforeVersion, expectedVersion,
    firstStat.disk, firstStat.cachedBeforeStat.diskVersion);
  currentDiagnostic.phase = "ledger-validation";
  currentDiagnostic.status = "pending-validation";
  assert(equal(assertedWitness, expected),
    `${operation} filesystem/IPC witness differs: ${JSON.stringify({
      assertedWitness, expected, acceptedCompletion,
    })}`);
  const assertedAdoption = {
    invokes: after.adoptionInvokes - before.adoptionInvokes,
    mainAdoption: {
      callback: {
        readFile: after.mainAdoption.callback.readFile - before.mainAdoption.callback.readFile,
        stat: after.mainAdoption.callback.stat - before.mainAdoption.callback.stat,
      },
      promises: {
        open: after.mainAdoption.promises.open - before.mainAdoption.promises.open,
        readFile: after.mainAdoption.promises.readFile - before.mainAdoption.promises.readFile,
        stat: after.mainAdoption.promises.stat - before.mainAdoption.promises.stat,
      },
      handle: {
        readFile: after.mainAdoption.handle.readFile - before.mainAdoption.handle.readFile,
        stat: after.mainAdoption.handle.stat - before.mainAdoption.handle.stat,
      },
    },
  };
  const expectedAdoption = expectedAdoptionCounts(operation);
  currentDiagnostic.assertedAdoption = assertedAdoption;
  currentDiagnostic.expectedAdoption = expectedAdoption;
  assert(equal(assertedAdoption, expectedAdoption),
    `${operation} adoption filesystem/IPC witness differs: ${JSON.stringify({ assertedAdoption, expectedAdoption })}`);
  assert(timed.headingVisible && timed.activeTitle === filePath && Number.isFinite(timed.elapsedMs) && timed.elapsedMs >= 0,
    `${operation} DOM/active-tab witness failed`);
  assert(completionCalls.length === 1 && completionCalls[0].accepted === true,
    `${operation} post-render completeFileOpen acceptance failed: ${JSON.stringify(completionCalls)}`);
  if (operation === "unchanged") assert(hashFile(filePath) === hashBefore, "unchanged switch altered fixture bytes");
  const mainTotal = {
    callback: {
      readFile: after.mainTotal.callback.readFile - before.mainTotal.callback.readFile,
      stat: after.mainTotal.callback.stat - before.mainTotal.callback.stat,
    },
    promises: {
      open: after.mainTotal.promises.open - before.mainTotal.promises.open,
      readFile: after.mainTotal.promises.readFile - before.mainTotal.promises.readFile,
      stat: after.mainTotal.promises.stat - before.mainTotal.promises.stat,
    },
    handle: {
      readFile: after.mainTotal.handle.readFile - before.mainTotal.handle.readFile,
      stat: after.mainTotal.handle.stat - before.mainTotal.handle.stat,
    },
    sync: {
      readFile: after.mainTotal.sync.readFile - before.mainTotal.sync.readFile,
      stat: after.mainTotal.sync.stat - before.mainTotal.sync.stat,
      lstat: after.mainTotal.sync.lstat - before.mainTotal.sync.lstat,
      exists: after.mainTotal.sync.exists - before.mainTotal.sync.exists,
      realpath: after.mainTotal.sync.realpath - before.mainTotal.sync.realpath,
    },
  };
  currentDiagnostic.mainTotal = mainTotal;
  assert(
    totalFixtureReads(mainTotal) ===
      snapshotFixtureReads(assertedWitness.mainSnapshot) +
        snapshotFixtureReads(assertedAdoption.mainAdoption),
    `${operation} observed unexplained main fixture read: ${JSON.stringify({
      mainTotal, mainSnapshot: assertedWitness.mainSnapshot, mainAdoption: assertedAdoption.mainAdoption,
    })}`,
  );
  currentDiagnostic.status = "exact-witness-complete-instrumented";
  currentDiagnostic.phase = "complete";
  console.log(`SEC08_DIAGNOSTIC_LEG ${JSON.stringify(currentDiagnostic)}`);
  return {
    sample: {
      ...timed,
      witness: {
        ...assertedWitness, ...assertedAdoption,
        snapshotInvokes: assertedWitness.invokes,
        adoptionInvokes: assertedAdoption.invokes,
        mainTotal, completionCalls,
      },
      expectedHeading: heading,
    },
    mtimeMs: beforeMtimeMs,
    version: expectedVersion,
  };
}

const timeout = setTimeout(() => fail("timed out waiting for worker completion"), TIMEOUT_MS);
let manifest;

if (
  !appRoot ||
  !userData ||
  !variant ||
  !sourceVariant ||
  !fixturePath ||
  !["A", "B"].includes(variant) ||
  !["baseline", "candidate"].includes(sourceVariant) ||
  !["renderer-baseline", "path-based", "fd-pinned", "logical-fd-pinned"].includes(snapshotReadMode) ||
  (sourceVariant === "baseline" && snapshotReadMode !== "renderer-baseline") ||
  (sourceVariant === "candidate" && snapshotReadMode === "renderer-baseline") ||
  !Number.isSafeInteger(REPETITIONS) ||
  REPETITIONS !== 21
) {
  fail("missing or invalid required arguments");
} else {
  try {
    manifest = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
    assert(["50k", "500k", "2m"].includes(manifest.size) &&
      [1, 10, 25].includes(manifest.measuredTabCount),
    "instrumented full worker received an unsupported cell");
    assert(manifest.tabs.length === manifest.measuredTabCount, "fixture manifest tab count is invalid");
    assert(manifest.tabs.length > 0, "fixture manifest has no measured tabs");
    countMainFs([...manifest.tabs.map((tab) => tab.filePath), manifest.controlPath]);
    const originalWatch = fs.watch.bind(fs);
    fs.watch = (...watchArgs) => {
      const watcher = originalWatch(...watchArgs);
      if (typeof watchArgs[0] !== "string") {
        recordUnattributedFsCall("watch", "watch", watchArgs[0]);
      }
      const fixture = typeof watchArgs[0] === "string" &&
        expectedFixturePaths.has(normalize(watchArgs[0]));
      if (fixture) {
        watcherStartCount += 1;
        liveFixtureWatchers.set(watcher, String(watchArgs[0]));
      }
      const close = watcher.close.bind(watcher);
      watcher.close = (...closeArgs) => {
        const result = close(...closeArgs);
        watcherCloseCount += 1;
        liveFixtureWatchers.delete(watcher);
        return result;
      };
      return watcher;
    };
    const originalOn = ipcMain.on.bind(ipcMain);
    ipcMain.on = (channel, listener) => {
      if (channel !== "pause-file-watching") return originalOn(channel, listener);
      return originalOn(channel, (event, data) => {
        pauseRequests.push({
          filePath: data && data.filePath,
          pageSession: data && data.pageSession,
          rendererGeneration: data && data.rendererGeneration,
          owner: data && data.owner && {
            tabId: data.owner.tabId,
            documentGeneration: data.owner.documentGeneration,
            selectionGeneration: data.owner.selectionGeneration,
          },
        });
        return listener(event, data);
      });
    };
    ipcMain.handle(PAUSE_WITNESS_CHANNEL, () => ({
      requests: pauseRequests,
      watcherCloseCount,
      watcherStartCount,
      liveFixtureWatchers: Array.from(liveFixtureWatchers.values()),
    }));
    const originalHandle = ipcMain.handle.bind(ipcMain);
    ipcMain.handle = (channel, handler) => {
      if (channel !== CHANNEL && channel !== ADOPTION_CHANNEL) {
        return originalHandle(channel, handler);
      }
      const snapshot = channel === CHANNEL;
      if (snapshot) snapshotHandlerRegistered = true;
      else adoptionHandlerRegistered = true;
      return originalHandle(channel, async (...handlerArgs) => {
        if (ownedSnapshotDepth > 0 || adoptionDepth > 0) {
          throw new Error(`fixture I/O handler overlap: ${channel}`);
        }
        let trace = null;
        if (snapshot) {
          snapshotInvokes += 1;
          ownedSnapshotDepth += 1;
          if (snapshotReadMode === "logical-fd-pinned") {
            const data = handlerArgs[1];
            assert(data && typeof data.filePath === "string" && data.filePath.length > 0,
              "logical snapshot handler had no data.filePath");
            trace = { filePath: data.filePath, pathStats: [] };
            snapshotStatTrace = trace;
          }
        } else {
          adoptionInvokes += 1;
          adoptionDepth += 1;
        }
        const snapshotDiagnostic = snapshot ? {
          operation: currentDiagnostic && currentDiagnostic.operation,
          repetition: currentDiagnostic && currentDiagnostic.repetition,
          phase: currentDiagnostic && currentDiagnostic.phase,
          request: encodeDiagnostic(handlerArgs[1]),
          requestOwnerIsAuthoritative: false,
          returned: { unavailable: "handler has not returned" },
          authoritativeMainOwner: { unavailable: "not exposed by handler result" },
        } : null;
        if (snapshotDiagnostic) snapshotDiagnostics.push(snapshotDiagnostic);
        try {
          const result = await handler(...handlerArgs);
          if (snapshotDiagnostic) {
            snapshotDiagnostic.returned = result === null ? null : encodeDiagnostic({
                diskVersion: result && result.diskVersion,
                modifiedTime: result && result.modifiedTime,
              });
          }
          if (trace) snapshotExtraPathStats += completeLogicalSnapshotTrace(trace);
          return result;
        } catch (error) {
          if (snapshotDiagnostic) snapshotDiagnostic.error = String(error.stack || error);
          throw error;
        } finally {
          if (snapshot) {
            snapshotStatTrace = null;
            ownedSnapshotDepth -= 1;
          } else {
            adoptionDepth -= 1;
          }
        }
      });
    };
    const recordDialog = (kind, options) => {
      if (measuring) throw new Error(`${kind} was invoked during a measured refresh`);
      if (options && options.title === "Large document") {
        largeDialogCalls += 1;
        return;
      }
      throw new Error(`unexpected ${kind}: ${options && options.title}`);
    };
    dialog.showMessageBoxSync = (owner, options) => {
      recordDialog("showMessageBoxSync", options || owner);
      return 0;
    };
    dialog.showMessageBox = async (owner, options) => {
      recordDialog("showMessageBox", options || owner);
      return { response: 0, checkboxChecked: false };
    };
    dialog.showErrorBox = (title, content) => {
      recordDialog("showErrorBox", { title, content });
    };
    app.setPath("userData", userData);
    app.on("browser-window-created", (_event, win) => {
      if (mainWindow || emitted) return;
      mainWindow = win;
      win.webContents.on("did-fail-load", (_event, code, description, url) =>
        fail("main window did-fail-load", JSON.stringify({ code, description, url })));
      win.webContents.on("render-process-gone", (_event, details) => fail("renderer process exited", JSON.stringify(details)));
      win.webContents.on("console-message", (details) => {
        if (details && details.level === "error") fail("renderer console error", details.message);
      });
      win.webContents.once("did-finish-load", async () => {
        try {
          if (tracePath) {
            await contentTracing.startRecording({
              included_categories: ["devtools.timeline", "v8", "blink", "toplevel"],
              trace_options: "record-until-full",
            });
            traceStarted = true;
          }
          const expectedUrl = pathToFileURL(path.join(appRoot, "src", "index.html")).href;
          const readiness = await win.webContents.executeJavaScript(`(() => ({
            href: location.href, readyState: document.readyState, hasFs: !!window.fs,
            completeFileOpen: typeof window.completeFileOpen, customTabs: typeof window.CustomTabs
          }))()`, true);
          assert(readiness.href === expectedUrl && readiness.readyState === "complete" && readiness.hasFs &&
            readiness.completeFileOpen === "function" && readiness.customTabs === "object",
          `renderer is not ready: ${JSON.stringify(readiness)}`);
          assert(snapshotHandlerRegistered === (snapshotReadMode !== "renderer-baseline"),
            `wrong ${CHANNEL} registration for ${sourceVariant}/${snapshotReadMode}`);
          assert(adoptionHandlerRegistered,
            `missing ${ADOPTION_CHANNEL} registration`);
          await win.webContents.executeJavaScript(rendererSetupScript([
            ...manifest.tabs.map((tab) => tab.filePath), manifest.controlPath,
          ]), true);
          const setup = await win.webContents.executeJavaScript(setupTabsScript(manifest), true);
          assert(setup.tabNodes === manifest.measuredTabCount + 1 && setup.controlActive && setup.pauseWitness,
            `completeFileOpen setup did not create the expected tabs: ${JSON.stringify(setup)}`);
          const dialogsBeforeSamples = largeDialogCalls;
          const samples = retainedSamples;
          const expectedInitialHashes = Object.fromEntries([
            ...manifest.tabs.map((tab) => [path.basename(tab.filePath), tab.initialSha256]),
            [path.basename(manifest.controlPath), manifest.controlSha256],
          ]);
          assert(equal(fixtureHashes(), expectedInitialHashes), "fixture hashes changed before measured samples");
          initialFixtureVersions = {};
          const lastVersions = new Map(manifest.tabs.map((tab) => {
            const stats = fs.statSync(tab.filePath);
            initialFixtureVersions[tab.filePath] = versionDiagnostic(stats);
            return [tab.filePath, versionDiagnostic(stats)];
          }));
          measuring = true;
          for (let repetition = 1; repetition <= REPETITIONS; repetition += 1) {
            const tab = manifest.tabs[(repetition - 1) % manifest.tabs.length];
            const heading = `SEC08 refresh ${manifest.size} tab ${tab.index} changed ${repetition}`;
            const beforeVersion = lastVersions.get(tab.filePath);
            const changed = await sample(win, "changed", tab.filePath, heading, beforeVersion.mtimeMs, repetition, beforeVersion);
            lastVersions.set(tab.filePath, changed.version);
            samples.changed.push({ repetition, tabIndex: tab.index, ...changed.sample });
            const unchanged = await sample(win, "unchanged", tab.filePath, heading, changed.mtimeMs, repetition, changed.version);
            samples.unchanged.push({ repetition, tabIndex: tab.index, ...unchanged.sample });
          }
          measuring = false;
          assert(largeDialogCalls === dialogsBeforeSamples,
            `a Large document modal was attempted during measured refreshes: ${largeDialogCalls - dialogsBeforeSamples}`);
          assert(hashFile(manifest.controlPath) === manifest.controlSha256, "control fixture bytes changed during samples");
          emit({
            ok: true,             variant, sourceVariant, snapshotReadMode, appRoot, fixturePath, electron: process.versions.electron,
            chrome: process.versions.chrome, snapshotHandlerRegistered, largeDialogCalls,
            readiness, setup, samples, fixtureHashes: fixtureHashes(),
          }, 0);
        } catch (error) {
          fail("worker measurement failed", error);
        }
      });
    });
    require(path.join(appRoot, "src", "main.js"));
  } catch (error) {
    fail("worker startup failed", error);
  }
}
