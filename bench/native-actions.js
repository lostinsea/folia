"use strict";

const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { monitorEventLoopDelay } = require("perf_hooks");

const jobArgument = process.argv.find(argument => argument.startsWith("--action-job="));
if (!jobArgument) throw new Error("Native actions require --action-job=<absolute JSON path>");
const job = JSON.parse(fs.readFileSync(jobArgument.slice("--action-job=".length), "utf8"));
if (!path.isAbsolute(job.appRoot) || !path.isAbsolute(job.profile) ||
    !path.isAbsolute(job.output) || !Array.isArray(job.files) ||
    job.files.length < 2 || !Number.isInteger(job.reps) || job.reps < 3 ||
    job.files.some(file => !path.isAbsolute(file)) ||
    typeof job.sourceRevision !== "string" || !job.sourceRevision ||
    !/^[a-f0-9]{64}$/i.test(job.expectedMainSha256)) {
  throw new Error("Invalid native action job");
}
const mainSha256 = crypto.createHash("sha256")
  .update(fs.readFileSync(path.join(job.appRoot, "src", "main.js"))).digest("hex");
if (mainSha256 !== job.expectedMainSha256.toLowerCase()) {
  throw new Error("Native action app Main source differs from the frozen job");
}
if (job.correctedSaveComparison &&
    (!Number.isInteger(job.correctedSaveComparison.pair) ||
     job.correctedSaveComparison.pair < 1 || job.correctedSaveComparison.pair > 21 ||
     !["settled", "immediate"].includes(job.correctedSaveComparison.firstMode))) {
  throw new Error("Invalid corrected Save comparison order");
}
const sourceHashes = Object.fromEntries(
  fs.readdirSync(path.join(job.appRoot, "src")).filter(file => /\.(js|css|html)$/.test(file))
    .sort().map(file => [file, crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(job.appRoot, "src", file))).digest("hex")]),
);
if (!job.expectedSourceHashes ||
    Object.keys(job.expectedSourceHashes).length !== Object.keys(sourceHashes).length ||
    Object.entries(sourceHashes).some(([file, hash]) => job.expectedSourceHashes[file] !== hash)) {
  throw new Error("Native action source set differs from the frozen job");
}
if (fs.existsSync(job.output)) throw new Error("Native action output already exists");
fs.writeFileSync(job.output, JSON.stringify({ status: "incomplete" }) + "\n");
const inputRoot = path.join(path.dirname(job.output), "native-action-inputs");
fs.mkdirSync(inputRoot, { recursive: false });
const captureRoot = path.join(path.dirname(job.output), "captures");
fs.mkdirSync(captureRoot, { recursive: false });
fs.mkdirSync(job.profile, { recursive: false });
app.setPath("userData", job.profile);
if (path.resolve(app.getPath("userData")) !== path.resolve(job.profile)) {
  throw new Error("Native action profile was not selected");
}

const fixtureInputs = job.files.map((source, index) => {
  const file = path.join(inputRoot, "input-" + index + ".md");
  fs.copyFileSync(source, file, fs.constants.COPYFILE_EXCL);
  const content = fs.readFileSync(file, "utf8");
  const heading = /^# ([^\r\n]+)/m.exec(content)?.[1];
  if (!heading) throw new Error("Native action fixture needs a distinct H1");
  return { file, source, content, heading,
    sha256: crypto.createHash("sha256").update(content).digest("hex") };
});
if (new Set(fixtureInputs.map(input => input.heading)).size !== fixtureInputs.length) {
  throw new Error("Native action fixtures need distinct headings");
}

let currentSample = null;
let pickerPaths = null;
let window = null;
let viewport = null;
const samples = [];
const errors = [];
const layoutReceipts = [];
let historicalLayoutWrites = null;
let failureWitness = null;
let firstFailure = null;
let errorSentinelObserved = false;
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();
function bodyCodeUnits(data) {
  return ["content", "savedContent"].reduce((total, field) =>
    total + (typeof data?.[field] === "string" ? data[field].length : 0), 0);
}
function assertSavedContent(actual, expected) {
  if (actual !== expected) throw new Error("Native Save did not preserve the complete editor text");
}
function failCurrentSample(error) {
  if (!currentSample || samples.includes(currentSample)) return;
  currentSample.status = "failed";
  currentSample.error = String(error.stack || error);
  currentSample.elapsedMs = performance.now() - currentSample.commandStartedAt;
  delete currentSample.resolveSaveAck;
  delete currentSample.saveRequestedAt;
  samples.push(currentSample);
}
app.on("web-contents-created", (_event, contents) => {
  contents.on("console-message", details => {
    if (details?.level === "error" || details?.level === 3 ||
        /^\s*Uncaught\b/.test(details?.message || "")) errors.push(details.message);
  });
  const send = contents.send;
  contents.send = function (channel, data, ...rest) {
    const sample = currentSample;
    if (!sample || !window || contents.id !== window.webContents.id) {
      return send.call(this, channel, data, ...rest);
    }
    sample.outboundIpc[channel] = (sample.outboundIpc[channel] || 0) + 1;
    sample.eventContentCodeUnits += bodyCodeUnits(data);
    if (channel === "file-reload-result" && sample.reloadRequest &&
        data?.path === sample.file && data.success === true &&
        data.reloadRequest?.sequence === sample.reloadRequest.reloadRequestSequence &&
        data.reloadRequest?.session === sample.reloadRequest.reloadRequestSession) {
      sample.reloadReplyMatched = true;
    }
    const started = performance.now();
    const result = send.call(this, channel, data, ...rest);
    sample.sendDispatchMs += performance.now() - started;
    return result;
  };
});
const originals = { on: ipcMain.on, handle: ipcMain.handle };
function count(channel, data) {
  if (!currentSample) return;
  currentSample.ipc[channel] = (currentSample.ipc[channel] || 0) + 1;
  currentSample.requestContentCodeUnits += bodyCodeUnits(data);
  if (channel === "reload-file" && data?.filePath === currentSample.file) {
    currentSample.reloadRequest = data;
  }
  if (channel === "save-markdown-file" && data?.filePath === currentSample.file) {
    currentSample.saveRequest = { requestId: data.requestId, session: data.saveRequestSession };
    currentSample.saveRequestedAt = performance.now();
    currentSample.saveIngressCommandRelativeMs = performance.now() - currentSample.commandStartedAt;
  }
}
ipcMain.on = function (channel, listener) {
  return originals.on.call(this, channel, function (event, data, ...rest) {
    count(channel, data);
    return listener.call(this, event, data, ...rest);
  });
};
ipcMain.handle = function (channel, listener) {
  return originals.handle.call(this, channel, async function (event, data, ...rest) {
    count(channel, data);
    const sample = currentSample;
    const result = await listener.call(this, event, data, ...rest);
    if (job.correctedSaveComparison && channel.includes("layout")) {
      layoutReceipts.push({ channel, completedAt: performance.now(), result });
    }
    if (sample) sample.replyContentCodeUnits += bodyCodeUnits(result);
    if (sample?.kind === "save" && channel === "save-markdown-result-ack" &&
        data?.requestId === sample.saveRequest?.requestId &&
        data?.saveRequestSession === sample.saveRequest?.session) {
      sample.saveAckAccepted = result === true;
      sample.saveRequestToAckMs = performance.now() - sample.saveRequestedAt;
      sample.saveAckCommandRelativeMs = performance.now() - sample.commandStartedAt;
      sample.resolveSaveAck(result);
    }
    return result;
  });
};
dialog.showOpenDialog = async () => {
  if (!pickerPaths) throw new Error("Unexpected native file picker");
  const filePaths = pickerPaths;
  pickerPaths = null;
  return { canceled: false, filePaths };
};
dialog.showMessageBoxSync = () => {
  throw new Error("Unexpected synchronous modal in native actions");
};
dialog.showMessageBox = async () => {
  throw new Error("Unexpected modal in native actions");
};
const mainEntryStartedAt = performance.now();
require(path.join(job.appRoot, "src", "main.js"));
const deadline = setTimeout(() => finish(new Error("Native action job timed out")), 240000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate, timeoutMs = 5000) {
  const until = performance.now() + timeoutMs;
  while (performance.now() < until) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}
const exec = (fn, argument) => window.webContents.executeJavaScript(
  `(${fn.toString()})(${JSON.stringify(argument)})`,
);

async function visibleActionWindow() {
  const startedAt = performance.now();
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  let timer;
  try {
    await Promise.race([
      (async () => {
        while (performance.now() - startedAt < 5000) {
          if (await exec(() => document.visibilityState === "visible")) {
            return;
          }
          await sleep(20);
        }
        throw new Error("Normal visible-window precondition did not settle");
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          "Normal visible-window precondition did not settle")), 5000);
      }),
    ]);
    return { elapsedMs: performance.now() - startedAt, visible: window.isVisible(),
      minimized: window.isMinimized(), focused: window.isFocused() };
  } finally { clearTimeout(timer); }
}

async function ready() {
  for (let attempt = 0; attempt < 600; attempt++) {
    window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
    if (window && !window.webContents.isLoadingMainFrame() &&
        await exec(() => document.readyState === "complete" &&
        typeof window.CustomTabs?.getTabs === "function" &&
        typeof window.completeFileOpen === "function" &&
        !document.getElementById("loadingScreen").classList.contains("active"))) {
      if (job.correctedSaveComparison) await visibleActionWindow();
      await exec(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return;
    }
    await sleep(20);
  }
  throw new Error("Production app never became ready");
}

async function measure(kind, input, action, saveMode = null) {
  const sample = { kind, file: input.file, ipc: {},
    outboundIpc: {}, requestContentCodeUnits: 0, replyContentCodeUnits: 0,
    eventContentCodeUnits: 0, sendDispatchMs: 0, saveMode };
  currentSample = sample;
  let commandStartedAt = performance.now();
  sample.commandStartedAt = commandStartedAt;
  let ackTimer;
  let saveAck;
  try {
    if (job.correctedSaveComparison) sample.visibilitySetup = await visibleActionWindow();
    commandStartedAt = performance.now();
    sample.commandStartedAt = commandStartedAt;
    eventLoopDelay.reset();
    saveAck = kind === "save" ? new Promise((resolve, reject) => {
      sample.resolveSaveAck = resolve;
      ackTimer = setTimeout(() => reject(new Error("Main Save acknowledgement did not settle")), 30000);
    }) : null;
    // The acknowledgement may time out while the renderer witness is pending.
    if (saveAck) saveAck.catch(() => {});
    const result = await exec(async ({ kind, file, heading, action, batchFiles, expectedLength, saveMode }) => {
      const tabs = window.CustomTabs;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native action did not settle: " + kind)), 30000);
      });
      const startedAt = performance.now();
      const original = window.completeFileOpen;
      const longTasks = [];
      const observer = new PerformanceObserver(list =>
        longTasks.push(...list.getEntries().map(entry => entry.duration)));
      observer.observe({ type: "longtask" });
      let restore = () => {};
      const settled = new Promise((resolve, reject) => {
        if (action === "reload") {
          const message = document.getElementById("notificationMessage");
          const witness = new MutationObserver(() => {
            if (message.textContent === window.i18n("notif.fileReloaded")) {
              if (document.querySelector("#viewer h1")?.textContent !== heading ||
                  window.originalMarkdown.length !== expectedLength ||
                  tabs.getTabs().find(tab => tab.id === tabs.getActiveTabId())?.filePath !== file) {
                reject(new Error("Reload notification did not reach expected painted bytes"));
              } else resolve(performance.now() - startedAt);
            }
          });
          witness.observe(message, { childList: true, characterData: true, subtree: true });
          restore = () => witness.disconnect();
          document.getElementById("refreshBtn").click();
          return;
        }
        if (kind === "save") {
          if (saveMode === "immediate") window.__nativeSaveWitness.input();
          if (saveMode) {
            const state = window.__nativeSaveWitness.state;
            state.saveClickedAt = performance.now();
            state.previewBeforeSave = state.previewPromiseAt !== null;
            state.historyBeforeSave = state.historyAt !== null;
            if ((saveMode === "immediate" && (state.previewBeforeSave || state.historyBeforeSave)) ||
                (saveMode === "settled" && (!state.previewBeforeSave || !state.historyBeforeSave))) {
              reject(new Error("Corrected Save mode did not reach its declared input boundary"));
              return;
            }
          }
          document.getElementById("saveButton").click();
          if (!window.hasPendingSaveFor(file)) {
            reject(new Error("Save never became pending"));
            return;
          }
          const poll = () => {
            if (!window.hasPendingSaveFor(file)) {
              const tab = tabs.getTabs().find(candidate => candidate.id === tabs.getActiveTabId());
              if (!tab || tab.filePath !== file || tab.hasUnsavedChanges ||
                  window.hasUnsavedWorkForReload()) reject(new Error("Save settled dirty"));
              else {
                if (saveMode) window.__nativeSaveWitness.state.storeSettledAt = performance.now();
                resolve(performance.now() - startedAt);
              }
            } else requestAnimationFrame(poll);
          };
          requestAnimationFrame(poll);
          return;
        }
        const wrapper = function (context, ...args) {
          const accepted = original.call(this, context, ...args);
          if (context?.path === file && accepted === true) {
            if (document.querySelector("#viewer h1")?.textContent !== heading ||
                tabs.getTabs().find(tab => tab.id === tabs.getActiveTabId())?.filePath !== file) {
              reject(new Error("Settlement did not reach the expected visible document"));
            } else resolve(performance.now() - startedAt);
          }
          return accepted;
        };
        window.completeFileOpen = wrapper;
        restore = () => {
          if (window.completeFileOpen !== wrapper) throw new Error("Completion witness replaced");
          window.completeFileOpen = original;
        };
        if (action === "open") document.getElementById("openFile").click();
        else {
          const tab = tabs.getTabs().find(candidate => candidate.filePath === file);
          const element = tab && document.querySelector('[data-tab-id="' + tab.id + '"]');
          if (!element) throw new Error("Tab click target missing");
          element.click();
        }
      });
      try {
        const settlementMs = await Promise.race([settled, timeout]);
        if (batchFiles) {
          await Promise.race([new Promise(resolve => {
            const poll = () => {
              const open = tabs.getTabs();
              if (batchFiles.every(filePath => open.some(tab => tab.filePath === filePath))) resolve();
              else requestAnimationFrame(poll);
            };
            poll();
          }), timeout]);
        }
        await Promise.race([new Promise(resolve => {
          const poll = () => {
            if (!document.getElementById("loadingScreen").classList.contains("active")) resolve();
            else requestAnimationFrame(poll);
          };
          poll();
        }), timeout]);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        longTasks.push(...observer.takeRecords().map(entry => entry.duration));
        return { settlementMs, rendererUsableMs: performance.now() - startedAt, longTasks,
          longTaskWindow: "renderer action through renderer readiness; Main ACK tail separate" };
      } finally {
        observer.disconnect();
        clearTimeout(timer);
        restore();
      }
    }, { kind, file: input.file, heading: input.heading, action, expectedLength: input.content.length,
      batchFiles: kind === "multi-open" ? fixtureInputs.map(input => input.file) : null, saveMode });
    Object.assign(sample, result);
    if (action === "reload" && sample.reloadReplyMatched !== true) {
      throw new Error("Painted reload had no matching successful native request/reply");
    }
    if (kind === "save") {
      if (await saveAck !== true) throw new Error("Main refused the measured Save acknowledgement");
      await exec(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    sample.usableMs = performance.now() - commandStartedAt;
    sample.mainEventLoopDelayMs = { max: eventLoopDelay.max / 1e6,
      p95: eventLoopDelay.percentile(95) / 1e6 };
    delete sample.resolveSaveAck;
    delete sample.saveRequestedAt;
    delete sample.reloadRequest;
    samples.push(sample);
    return sample;
  } catch (error) {
    failCurrentSample(error);
    throw error;
  } finally {
    clearTimeout(ackTimer);
    currentSample = null;
  }
}

async function saveSetup(kind, input, fn, argument) {
  const sample = { kind, file: input.file, commandStartedAt: performance.now(),
    ipc: {}, outboundIpc: {}, requestContentCodeUnits: 0, replyContentCodeUnits: 0,
    eventContentCodeUnits: 0, sendDispatchMs: 0 };
  currentSample = sample;
  eventLoopDelay.reset();
  let timer;
  try {
    sample.visibilitySetup = await visibleActionWindow();
    Object.assign(sample, await Promise.race([
      exec(fn, argument),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(
          "Native Save setup did not settle: " + kind)), 30000);
      }),
    ]));
    sample.usableMs = performance.now() - sample.commandStartedAt;
    sample.mainEventLoopDelayMs = { max: eventLoopDelay.max / 1e6,
      p95: eventLoopDelay.percentile(95) / 1e6 };
    samples.push(sample);
    return sample;
  } catch (error) {
    failCurrentSample(error);
    throw error;
  } finally { clearTimeout(timer); currentSample = null; }
}

async function armSaveWitness({ file, baselineDigest, expectedDigest, append }) {
  const tabs = window.CustomTabs;
  const editor = document.getElementById("markdownEditor");
  const tab = tabs.getActiveTab();
  const marker = append.trim();
  if (!tab || tab.filePath !== file || tab.hasUnsavedChanges ||
      window.hasPendingSaveFor(file) || isEditMode ||
      document.getElementById("viewer").textContent.includes(marker)) {
    throw new Error("Corrected Save did not start from a clean native document");
  }
  const layoutStartedAt = performance.now();
  if (typeof tabs.settleSessionLayout === "function") await tabs.settleSessionLayout();
  const priorLayout = { kind: typeof tabs.settleSessionLayout === "function"
    ? "native durable layout tail" : "historical synchronous localStorage; no async tail API",
    elapsedMs: performance.now() - layoutStartedAt };
  document.getElementById("toggleEdit").click();
  if (!isEditMode || editor.offsetHeight <= 0 || window.hasUnsavedWorkForReload()) {
    throw new Error("Corrected Save editor baseline is not clean and visible");
  }
  const baseline = editor.value;
  const expected = baseline + append;
  const digest = async text => Array.from(new Uint8Array(await window.crypto.subtle.digest(
    "SHA-256", new window.TextEncoder().encode(text))),
  byte => byte.toString(16).padStart(2, "0")).join("");
  const cryptoStartedAt = performance.now();
  if (await digest(baseline) !== baselineDigest || await digest(expected) !== expectedDigest) {
    throw new Error("Explicit browser crypto did not verify the exact baseline/draft bytes");
  }
  if (historySnapshot().undo.at(-1) === expected) throw new Error("Draft history witness is already true");
  const originalRender = window.renderMarkdown;
  const originalHistory = window.historyPush;
  const longTasks = [];
  const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries()
    .map(entry => ({ startTime: entry.startTime, duration: entry.duration }))));
  observer.observe({ type: "longtask" });
  const state = { inputAt: null, previewStartedAt: null, previewPromiseAt: null,
    historyAt: null, visibleAt: null, storeSettledAt: null, error: null };
  const render = function (content, ...args) {
    const observed = state.inputAt !== null && content === expected && state.previewStartedAt === null;
    if (observed) state.previewStartedAt = performance.now();
    const result = originalRender.call(this, content, ...args);
    if (observed) {
      state.generation = renderGeneration;
      Promise.resolve(result).then(() => { state.previewPromiseAt = performance.now(); },
        error => { state.error = String(error.stack || error); });
    }
    return result;
  };
  const history = function (content, ...args) {
    const result = originalHistory.call(this, content, ...args);
    if (state.inputAt !== null && content === expected) {
      const snapshot = historySnapshot();
      if (snapshot.undo.at(-1) !== expected || snapshot.redo.length) {
        throw new Error("Natural history callback did not retain the exact draft");
      }
      state.historyAt = performance.now();
    }
    return result;
  };
  window.renderMarkdown = render;
  window.historyPush = history;
  window.__nativeSaveWitness = {
    state,
    input() {
      if (state.inputAt !== null || editor.value !== baseline ||
          document.getElementById("viewer").textContent.includes(marker)) {
        throw new Error("Corrected Save input was reused or its preview was already present");
      }
      observer.takeRecords();
      state.inputAt = performance.now();
      editor.value = expected;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      state.inputDispatchReturnedAt = performance.now();
      if (!hasUnsavedChanges || editor.value !== expected) throw new Error("Normal input did not dirty the exact draft");
      this.draftSettled().catch(error => { state.error = String(error.stack || error); });
    },
    async draftSettled() {
      if (state.draftPromise) return state.draftPromise;
      state.draftPromise = this.observeDraft();
      return state.draftPromise;
    },
    async observeDraft() {
      const until = performance.now() + 30000;
      const valid = () => state.previewPromiseAt !== null && state.historyAt !== null &&
        state.generation === renderGeneration && editor.value === expected &&
        historySnapshot().undo.at(-1) === expected &&
        document.getElementById("viewer").textContent.includes(marker) &&
        !document.getElementById("loadingScreen").classList.contains("active");
      let timer;
      try {
        await Promise.race([
          (async () => {
            while (performance.now() < until) {
              if (state.error) throw new Error(state.error);
              if (valid()) {
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                if (valid()) { state.visibleAt = performance.now(); return; }
              }
              await new Promise(resolve => requestAnimationFrame(resolve));
            }
            throw new Error("Natural exact-draft preview/history did not complete");
          })(),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(
              "Natural exact-draft preview/history did not complete")), 30000);
          }),
        ]);
      } finally { clearTimeout(timer); }
    },
    async tail() {
      await this.draftSettled();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!document.getElementById("viewer").textContent.includes(marker) ||
          document.getElementById("loadingScreen").classList.contains("active")) {
        throw new Error("Post-Save view did not retain the completed draft");
      }
      const postSaveViewAt = performance.now();
      const current = tabs.getActiveTab();
      if (current.id !== tab.id || current.filePath !== file ||
          current.hasUnsavedChanges || current.originalContent !== expected ||
          current.content !== expected || originalMarkdown !== expected ||
          window.hasPendingSaveFor(file)) throw new Error("Save store/native owner did not settle exact bytes");
      const layoutAt = performance.now();
      if (typeof tabs.settleSessionLayout === "function") await tabs.settleSessionLayout();
      longTasks.push(...observer.takeRecords().map(entry => ({
        startTime: entry.startTime, duration: entry.duration })));
      return { inputToSaveClickMs: state.saveClickedAt - state.inputAt,
        previewBeforeSave: state.previewBeforeSave, historyBeforeSave: state.historyBeforeSave,
        inputToStoreMs: state.storeSettledAt - state.inputAt,
        inputToNaturalDraftMs: state.visibleAt - state.inputAt,
        inputToPostSaveViewMs: postSaveViewAt - state.inputAt,
        inputToLayoutTailMs: performance.now() - state.inputAt,
        postSaveLayoutMs: performance.now() - layoutAt,
        priorLayoutKind: priorLayout.kind, naturalPreviewStartedMs: state.previewStartedAt - state.inputAt,
        naturalPreviewPromiseMs: state.previewPromiseAt - state.inputAt,
        naturalHistoryMs: state.historyAt - state.inputAt,
        longTasks: longTasks.filter(entry => entry.startTime >= state.inputAt),
        ownerId: current.id, ownerPath: current.filePath,
        identity: typeof tabs.getActiveDocumentIdentity === "function"
          ? tabs.getActiveDocumentIdentity(file, window.getReloadRequestSession()) : null };
    },
    restore() {
      observer.disconnect();
      if (window.renderMarkdown !== render || window.historyPush !== history) {
        throw new Error("Natural draft witness was replaced");
      }
      window.renderMarkdown = originalRender;
      window.historyPush = originalHistory;
      delete window.__nativeSaveWitness;
    },
  };
  return { priorLayout, cryptoApi: "window.crypto.subtle.digest/SHA-256/window.TextEncoder",
    cryptoMs: performance.now() - cryptoStartedAt, baselineDigest, expectedDigest,
    baselineLength: baseline.length, expectedLength: expected.length,
    markerAbsent: true, nativeOwnerId: tab.id, nativeOwnerPath: tab.filePath,
    historicalLayoutWritesBeforeInput: window.__nativeLayoutWrites.length,
    identity: typeof tabs.getActiveDocumentIdentity === "function"
      ? tabs.getActiveDocumentIdentity(file, window.getReloadRequestSession()) : null };
}

function overwriteActionFixture(file, content) {
  // Reset an existing fixture without truncate-on-open; that open failed with
  // UNKNOWN after an accepted Save. Retain its inode and surface every failure.
  const bytes = Buffer.from(content, "utf8");
  const sample = { kind: "setup-fixture-write", file, commandStartedAt: performance.now() };
  samples.push(sample);
  try {
    const fd = fs.openSync(file, "r+");
    try {
      const oldSize = fs.fstatSync(fd).size;
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!count) throw new Error("Fixture write made no progress");
        offset += count;
      }
      if (bytes.length < oldSize) fs.ftruncateSync(fd, bytes.length);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    sample.status = "failed";
    sample.error = String(error.stack || error);
    throw error;
  } finally {
    sample.usableMs = performance.now() - sample.commandStartedAt;
  }
}

async function correctedSaveJourney(primary, control) {
  const append = "\nNative action Save settlement.\n";
  for (let repetition = 0; repetition < job.reps; repetition++) {
    const first = repetition % 2
      ? (job.correctedSaveComparison.firstMode === "settled" ? "immediate" : "settled")
      : job.correctedSaveComparison.firstMode;
    for (const mode of [first, first === "settled" ? "immediate" : "settled"]) {
      const startedAt = performance.now();
      await measure("setup-control-tab", control, "tab");
      await measure("setup-primary-tab", primary, "tab");
      const changed = primary.content.replace("# " + primary.heading,
        "# " + primary.heading + " revision " + repetition);
      overwriteActionFixture(primary.file, changed);
      const input = { ...primary, content: changed, heading: primary.heading + " revision " + repetition };
      await measure("reload", input, "reload");
      await measure("unchanged-reload", input, "reload");
      const expected = changed + append;
      const setup = await saveSetup("setup-save-precondition", input, armSaveWitness, {
        file: input.file, baselineDigest: crypto.createHash("sha256").update(changed).digest("hex"),
        expectedDigest: crypto.createHash("sha256").update(expected).digest("hex"), append });
      setup.saveMode = mode;
      if (mode === "settled") {
        await saveSetup("setup-natural-draft", input, async () => {
          const witness = window.__nativeSaveWitness;
          witness.state.setupPhase = "input";
          witness.input();
          await witness.draftSettled();
          witness.state.naturalDraftSettledAt = performance.now();
          witness.state.setupPhase = "layout";
          const layoutAt = performance.now();
          if (typeof window.CustomTabs.settleSessionLayout === "function") {
            await window.CustomTabs.settleSessionLayout();
          }
          witness.state.setupPhase = "final-frames";
          witness.state.finalFramesEnteredAt = performance.now();
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          witness.state.finalFramesCompletedAt = performance.now();
          witness.state.setupPhase = "complete";
          return { exactNaturalDraftBeforeSave: true, settledDraftLayoutBarrierMs: performance.now() - layoutAt };
        });
      }
      const save = await measure("save", input, "save", mode);
      save.repetition = repetition;
      save.order = [first, first === "settled" ? "immediate" : "settled"];
      save.setupThroughUsableMs = performance.now() - startedAt;
      try {
        assertSavedContent(fs.readFileSync(input.file, "utf8"), expected);
        save.exactDiskVerified = true;
        const tail = await saveSetup("save-natural-layout-tail", input,
          async () => window.__nativeSaveWitness.tail());
        tail.saveMode = mode;
        save.naturalTail = tail;
        save.setupThroughTailMs = performance.now() - startedAt;
      } catch (error) {
        save.status = "failed";
        save.error = String(error.stack || error);
        throw error;
      }
      await exec(() => {
        window.__nativeSaveWitness.restore();
        document.getElementById("exitEditBtn").click();
      });
      overwriteActionFixture(primary.file, primary.content);
      await measure("setup-reset-reload", primary, "reload");
    }
  }
}

async function scroll() {
  const sample = { kind: "scroll", ipc: {}, outboundIpc: {},
    requestContentCodeUnits: 0, replyContentCodeUnits: 0, eventContentCodeUnits: 0,
    sendDispatchMs: 0, commandStartedAt: performance.now() };
  currentSample = sample;
  eventLoopDelay.reset();
  try {
    Object.assign(sample, await exec(async () => {
    const scroller = window.getViewerScroller();
    if (!scroller || scroller.scrollHeight <= scroller.clientHeight) {
      throw new Error("Native scroll fixture does not overflow");
    }
    const longTasks = [];
    const observer = new PerformanceObserver(list =>
      longTasks.push(...list.getEntries().map(entry => entry.duration)));
    observer.observe({ type: "longtask" });
    const frames = [];
    let minScrollTop = Infinity, maxScrollTop = 0;
    let previous = performance.now();
    for (let step = 0; step < 120; step++) {
      await new Promise(resolve => requestAnimationFrame(now => {
        frames.push(now - previous);
        previous = now;
        minScrollTop = Math.min(minScrollTop, scroller.scrollTop);
        maxScrollTop = Math.max(maxScrollTop, scroller.scrollTop);
        scroller.scrollTop = (step % 30) * (scroller.scrollHeight - scroller.clientHeight) / 29;
        resolve();
      }));
    }
    longTasks.push(...observer.takeRecords().map(entry => entry.duration));
    observer.disconnect();
    if (maxScrollTop - minScrollTop < 100) throw new Error("Native scroll did not actually move");
    return { frames, longTasks, minScrollTop, maxScrollTop,
      scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
    }));
    sample.usableMs = performance.now() - sample.commandStartedAt;
    sample.mainEventLoopDelayMs = { max: eventLoopDelay.max / 1e6,
      p95: eventLoopDelay.percentile(95) / 1e6 };
    samples.push(sample);
    return sample;
  } catch (error) {
    failCurrentSample(error);
    throw error;
  } finally { currentSample = null; }
}

async function changeMermaidZoom(reset) {
  const sample = { kind: reset ? "mermaid-zoom-reset" : "mermaid-zoom-in",
    ipc: {}, outboundIpc: {}, requestContentCodeUnits: 0, replyContentCodeUnits: 0,
    eventContentCodeUnits: 0, sendDispatchMs: 0 };
  currentSample = sample;
  eventLoopDelay.reset();
  const commandStartedAt = performance.now();
  sample.commandStartedAt = commandStartedAt;
  try {
    Object.assign(sample, await exec(async reset => {
      const before = document.querySelector("#viewer h1").getBoundingClientRect().height;
      const longTasks = [];
      const observer = new PerformanceObserver(list =>
        longTasks.push(...list.getEntries().map(entry => entry.duration)));
      observer.observe({ type: "longtask" });
      try {
        if (reset) document.getElementById("zoomReset").click();
        else {
          if (document.getElementById("zoomReset").textContent !== "100%") throw new Error("Mermaid journey did not start at 100%");
          for (let click = 0; click < 5; click++) document.getElementById("zoomIn").click();
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const after = document.querySelector("#viewer h1").getBoundingClientRect().height;
        const expected = reset ? 1 : 1.5;
        const ratio = after / before;
        if (document.getElementById("zoomReset").textContent !== expected * 100 + "%" ||
            Number(document.getElementById("viewer").style.zoom) !== expected ||
            (reset ? ratio < 0.6 || ratio > 0.75 : ratio < 1.4 || ratio > 1.6)) {
          throw new Error("Mermaid zoom did not change the visible heading scale");
        }
        longTasks.push(...observer.takeRecords().map(entry => entry.duration));
        return { beforeHeight: before, afterHeight: after, longTasks };
      } finally { observer.disconnect(); }
    }, reset));
    sample.usableMs = performance.now() - commandStartedAt;
    sample.mainEventLoopDelayMs = { max: eventLoopDelay.max / 1e6,
      p95: eventLoopDelay.percentile(95) / 1e6 };
    samples.push(sample);
  } catch (error) {
    failCurrentSample(error);
    throw error;
  } finally { currentSample = null; }
}

async function captureMermaid(name) {
  const sample = { kind: "visual-observation", capture: path.join(captureRoot, name + ".png"),
    viewed: false, commandStartedAt: performance.now(), ipc: {}, outboundIpc: {},
    requestContentCodeUnits: 0, replyContentCodeUnits: 0, eventContentCodeUnits: 0,
    sendDispatchMs: 0 };
  currentSample = sample;
  try {
    Object.assign(sample, await exec(() => {
      const diagrams = Array.from(document.querySelectorAll("#viewer .mermaid svg"));
      const labels = diagrams.flatMap(svg => Array.from(svg.querySelectorAll(".nodeLabel"))
        .map(label => label.textContent.replace(/\s+/g, " ").trim()));
      if (diagrams.length !== 1 || !labels.includes("Each query or stage language")) {
        throw new Error("Native Mermaid journey did not paint the expected complete decision label");
      }
      return { diagramCount: diagrams.length, labels,
        zoom: document.getElementById("zoomReset").textContent };
    }));
    fs.writeFileSync(sample.capture, (await window.webContents.capturePage()).toPNG());
    samples.push(sample);
  } catch (error) {
    failCurrentSample(error);
    throw error;
  } finally { currentSample = null; }
}

let finishing = false;
function finish(error = null) {
  if (finishing) return;
  error = firstFailure || error;
  finishing = true;
  clearTimeout(deadline);
  if (error) failCurrentSample(error);
  eventLoopDelay.disable();
  const result = { status: error ? "failed" : "complete",
    appRoot: job.appRoot, profile: job.profile,
    sourceRevision: job.sourceRevision, mainSha256, errorSentinelObserved, inputRoot,
    sourceHashes, fingerprint: { platform: process.platform, arch: process.arch,
      versions: process.versions, cpu: os.cpus()[0]?.model,
      logicalProcessors: os.cpus().length, viewport },
    preferences: window?.webContents.getLastWebPreferences(),
    fixtures: fixtureInputs.map(({ file, source, sha256, heading }) => ({ file, source, sha256, heading })),
    samples, errors, layoutReceipts, historicalLayoutWrites, failureWitness,
    correctedSaveComparison: job.correctedSaveComparison || null,
    error: error ? String(error.stack || error) : null,
    scope: "Real native dialog/open/reload/tab/Save and observed visible endpoints. usableMs is Main automation-command to observed UI readiness including injection/observation; rendererUsableMs separately measures action to UI frames. Save also awaits its matching accepted Main acknowledgement. IPC counts, content/savedContent UTF-16 code units and inclusive native send dispatch time, not exact engine serialization bytes/cost. Startup is Main module entry to usable fresh-profile window; source/dependency/process-launch overhead excluded. Only fresh owned input copies are mutated and retained through actual process death. Setup-reset samples separate. No threshold verdict." };
  fs.writeFileSync(job.output, JSON.stringify(result, null, 2) + "\n");
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  await ready();
  if (job.correctedSaveComparison) {
    await exec(() => {
      const original = Storage.prototype.setItem;
      window.__nativeLayoutWrites = [];
      const wrapper = function (key, value) {
        const result = original.call(this, key, value);
        if (this === localStorage && ["openTabs", "activeTabPath"].includes(key)) {
          window.__nativeLayoutWrites.push({ key, completedAt: performance.now(), codeUnits: String(value).length });
        }
        return result;
      };
      Storage.prototype.setItem = wrapper;
      window.__restoreNativeLayoutWitness = () => {
        if (Storage.prototype.setItem !== wrapper) throw new Error("Historical layout witness replaced");
        Storage.prototype.setItem = original;
        delete window.__restoreNativeLayoutWitness;
      };
    });
  }
  samples.push({ kind: "startup", usableMs: performance.now() - mainEntryStartedAt });
  viewport = await exec(() => ({ width: window.innerWidth, height: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    viewerWidth: document.getElementById("viewer").clientWidth,
    font: getComputedStyle(document.getElementById("viewer")).fontFamily }));
  const sentinel = "NATIVE_ACTION_ERROR_SENTINEL_" + crypto.randomUUID();
  await exec(message => console.error(message), sentinel);
  if (!await waitUntil(() => errors.includes(sentinel))) throw new Error("Console error sentinel was not observed");
  if (errors.filter(error => error === sentinel).length !== 1) throw new Error("Console error sentinel was duplicated");
  errors.splice(errors.indexOf(sentinel), 1);
  errorSentinelObserved = true;
  pickerPaths = [fixtureInputs[0].file];
  await measure("open", fixtureInputs[0], "open");
  pickerPaths = fixtureInputs.map(input => input.file);
  await measure("multi-open", fixtureInputs[0], "open");
  const primary = fixtureInputs[0];
  const control = fixtureInputs[1];
  if (job.correctedSaveComparison) {
    await correctedSaveJourney(primary, control);
    historicalLayoutWrites = await exec(() => {
      window.__restoreNativeLayoutWitness();
      return window.__nativeLayoutWrites;
    });
    if (errors.length) throw new Error("Corrected native Save run recorded renderer errors");
    finish();
    return;
  }
  await measure("setup-control-tab", control, "tab");
  for (let repetition = 0; repetition < job.reps; repetition++) {
    await measure("tab-switch", primary, "tab");
    const changed = primary.content.replace("# " + primary.heading,
      "# " + primary.heading + " revision " + repetition);
    fs.writeFileSync(primary.file, changed);
    await measure("reload", { ...primary, content: changed,
      heading: primary.heading + " revision " + repetition }, "reload");
    await measure("unchanged-reload", { ...primary, content: changed,
      heading: primary.heading + " revision " + repetition }, "reload");
    const expectedSaveText = changed + "\nNative action Save settlement.\n";
    const editorDigest = await exec(async () => {
      document.getElementById("toggleEdit").click();
      const editor = document.getElementById("markdownEditor");
      editor.value += "\nNative action Save settlement.\n";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      const digest = await window.crypto.subtle.digest("SHA-256", new window.TextEncoder().encode(editor.value));
      return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    });
    if (editorDigest !== crypto.createHash("sha256").update(expectedSaveText).digest("hex")) {
      throw new Error("Save setup editor text differs from the expected complete body");
    }
    for (const corrupted of ["Native action Save settlement.", expectedSaveText.replace(primary.heading, "CORRUPTED")]) {
      let refused = false;
      try { assertSavedContent(corrupted, expectedSaveText); }
      catch (error) { refused = error.message === "Native Save did not preserve the complete editor text"; }
      if (!refused) throw new Error("Native Save oracle accepted truncated or altered body");
    }
    const saveSample = await measure("save", primary, "save");
    try { assertSavedContent(fs.readFileSync(primary.file, "utf8"), expectedSaveText); }
    catch (error) {
      saveSample.status = "failed";
      saveSample.error = String(error.stack || error);
      throw error;
    }
    await exec(() => document.getElementById("exitEditBtn").click());
    await scroll();
    fs.writeFileSync(primary.file, primary.content);
    await measure("setup-reset-reload", primary, "reload");
    await measure("tab-switch", control, "tab");
  }
  if (job.mermaidFile) {
    const input = fixtureInputs.find(candidate => candidate.source === job.mermaidFile);
    if (!input) throw new Error("Mermaid fixture is not one of the admitted inputs");
    await measure("mermaid-tab", input, "tab");
    await changeMermaidZoom(false);
    if (typeof job.mermaidContent === "string" && job.mermaidContent !== input.content &&
        job.mermaidContent.includes("```mermaid")) {
      if (!job.mermaidContent.startsWith("# " + input.heading + "\n")) {
        throw new Error("Added Mermaid content must preserve its fixture H1");
      }
      fs.writeFileSync(input.file, job.mermaidContent);
    } else throw new Error("Mermaid journey needs newly added diagram bytes");
    const added = { ...input, content: job.mermaidContent };
    await measure("mermaid-zoom-reload", added, "reload");
    await captureMermaid("added-at-150");
    await measure("mermaid-repeated-zoom-reload", added, "reload");
    await captureMermaid("reloaded-at-150");
    await changeMermaidZoom(true);
    await measure("mermaid-return-100-reload", added, "reload");
    await captureMermaid("returned-to-100");
  }
  if (errors.length) throw new Error("Native action run recorded renderer errors");
  finish();
}).catch(async error => {
  firstFailure = firstFailure || error;
  failureWitness = { unavailable: true, reason: "Failure collection has not returned; original deadline remains active" };
  if (job.correctedSaveComparison && window && !window.isDestroyed()) {
    const unavailable = { unavailable: true, reason: "Renderer did not return retained failure witnesses" };
    const capture = exec(() => ({
      historicalLayoutWrites: window.__nativeLayoutWrites || null,
      documentVisibility: document.visibilityState,
      editMode: isEditMode,
      renderGeneration,
      loading: document.getElementById("loadingScreen").classList.contains("active"),
      draftMarkerVisible: document.getElementById("viewer").textContent.includes("Native action Save settlement."),
      naturalWitness: window.__nativeSaveWitness
        ? Object.fromEntries(Object.entries(window.__nativeSaveWitness.state)
          .filter(([key]) => key !== "draftPromise")) : null,
    }));
    const retained = await Promise.race([capture.then(value => value,
      failure => ({ unavailable: true, reason: String(failure.stack || failure) })),
    sleep(1000).then(() => unavailable)]);
    historicalLayoutWrites = retained.historicalLayoutWrites || null;
    failureWitness = retained;
    const lastSave = samples.findLast(sample => sample.kind === "save");
    if (lastSave?.status === "failed") lastSave.retainedFailureWitness = retained;
  }
  finish(error);
});
