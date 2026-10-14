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
    if (sample) sample.replyContentCodeUnits += bodyCodeUnits(result);
    if (sample?.kind === "save" && channel === "save-markdown-result-ack" &&
        data?.requestId === sample.saveRequest?.requestId &&
        data?.saveRequestSession === sample.saveRequest?.session) {
      sample.saveAckAccepted = result === true;
      sample.saveRequestToAckMs = performance.now() - sample.saveRequestedAt;
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

async function ready() {
  for (let attempt = 0; attempt < 600; attempt++) {
    window = BrowserWindow.getAllWindows().find(candidate => !candidate.isDestroyed());
    if (window && !window.webContents.isLoadingMainFrame() &&
        await exec(() => document.readyState === "complete" &&
        typeof window.CustomTabs?.getTabs === "function" &&
        typeof window.completeFileOpen === "function" &&
        !document.getElementById("loadingScreen").classList.contains("active"))) {
      await exec(() => new Promise(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))));
      return;
    }
    await sleep(20);
  }
  throw new Error("Production app never became ready");
}

async function measure(kind, input, action) {
  const sample = { kind, file: input.file, ipc: {},
    outboundIpc: {}, requestContentCodeUnits: 0, replyContentCodeUnits: 0,
    eventContentCodeUnits: 0, sendDispatchMs: 0 };
  currentSample = sample;
  const commandStartedAt = performance.now();
  sample.commandStartedAt = commandStartedAt;
  eventLoopDelay.reset();
  let ackTimer;
  const saveAck = kind === "save" ? new Promise((resolve, reject) => {
    sample.resolveSaveAck = resolve;
    ackTimer = setTimeout(() => reject(new Error("Main Save acknowledgement did not settle")), 30000);
  }) : null;
  // The acknowledgement may time out while the renderer witness is pending.
  if (saveAck) saveAck.catch(() => {});
  try {
    const result = await exec(async ({ kind, file, heading, action, batchFiles, expectedLength }) => {
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
              else resolve(performance.now() - startedAt);
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
      batchFiles: kind === "multi-open" ? fixtureInputs.map(input => input.file) : null });
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
    samples, errors, error: error ? String(error.stack || error) : null,
    scope: "Real native dialog/open/reload/tab/Save and observed visible endpoints. usableMs is Main automation-command to observed UI readiness including injection/observation; rendererUsableMs separately measures action to UI frames. Save also awaits its matching accepted Main acknowledgement. IPC counts, content/savedContent UTF-16 code units and inclusive native send dispatch time, not exact engine serialization bytes/cost. Startup is Main module entry to usable fresh-profile window; source/dependency/process-launch overhead excluded. Only fresh owned input copies are mutated and retained through actual process death. Setup-reset samples separate. No threshold verdict." };
  fs.writeFileSync(job.output, JSON.stringify(result, null, 2) + "\n");
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(error ? 1 : 0);
}

app.whenReady().then(async () => {
  await ready();
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
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(editor.value));
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
}).catch(finish);
