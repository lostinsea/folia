// F22 process-isolated Electron worker.  It is driven only by
// bench/run-f22-shutdown.js; the parent owns fixture/profile/result cleanup.
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WORKER_VERSION = 1;
const args = process.argv.slice(2);
const marker = args.indexOf("--f22-worker");
const jobPath = marker >= 0 ? args[marker + 1] : null;

if (!jobPath) {
  console.error("F22 worker must be run by node bench/run-f22-shutdown.js");
  process.exit(2);
}

let job;
try {
  job = JSON.parse(fs.readFileSync(jobPath, "utf8"));
} catch (error) {
  console.error(`F22 worker could not read job: ${error.message}`);
  process.exit(2);
}

if (
  job.protocolVersion !== WORKER_VERSION ||
  !job.token ||
  !job.profile ||
  !job.resultFile ||
  !job.digest ||
  (job.fixtureKind !== "primary" && job.fixtureKind !== "crlf")
) {
  console.error("F22 worker received an invalid job envelope");
  process.exit(2);
}

// This must happen before main.js creates its window. The parent created and
// checked this unique empty profile while holding the benchmark lock.
fs.mkdirSync(job.profile, { recursive: true });
app.setPath("userData", job.profile);
if (path.resolve(app.getPath("userData")) !== path.resolve(job.profile)) {
  console.error("F22 worker could not select its unique userData profile");
  process.exit(2);
}

const { __shutdown } = require("../src/main.js");
const failures = [];
const lifecycle = [];
let phase = "startup";
let lifecycleExitResult = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(reason, detail) {
  failures.push(detail ? `${reason}: ${detail}` : reason);
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function verifyFixtures() {
  if (
    !Array.isArray(job.files) ||
    !Array.isArray(job.fixtureBytes) ||
    !Array.isArray(job.fixtureDigests) ||
    job.files.length !== job.tabCount ||
    job.fixtureBytes.length !== job.files.length ||
    job.fixtureDigests.length !== job.files.length
  ) {
    throw new Error("fixture manifest is incomplete");
  }
  const fixtures = job.files.map((file, index) => {
    const bytes = fs.statSync(file).size;
    const fileDigest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (bytes !== job.fixtureBytes[index] || fileDigest !== job.fixtureDigests[index]) {
      throw new Error(`fixture mismatch ${path.basename(file)}`);
    }
    if (job.fixtureKind !== "crlf" && bytes !== job.fixtureRequestedBytes) {
      throw new Error(`fixture target mismatch ${path.basename(file)} bytes=${bytes}`);
    }
    if (job.fixtureKind === "crlf" && bytes <= job.fixtureRequestedBytes) {
      throw new Error(`CRLF framing mismatch ${path.basename(file)} bytes=${bytes}`);
    }
    return { file: path.basename(file), bytes, digest: fileDigest };
  });
  return fixtures;
}

function replaceMethod(target, name, impl) {
  const own = Object.getOwnPropertyDescriptor(target, name);
  Object.defineProperty(target, name, {
    value: impl,
    writable: true,
    configurable: true,
    enumerable: own ? own.enumerable : false,
  });
  return () => {
    if (own) Object.defineProperty(target, name, own);
    else delete target[name];
  };
}

async function waitUntil(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await sleep(10);
  }
  return false;
}

async function quiesce(exec) {
  return exec(`
    (async () => {
      for (let frame = 0; frame < 3; frame += 1) {
        await new Promise(requestAnimationFrame);
      }
      const loading = document.getElementById("loadingScreen");
      return !loading || !loading.classList.contains("active");
    })()
  `);
}

async function installPing(exec) {
  await exec(`
    (() => {
      const ipc = require("electron").ipcRenderer;
      ipc.removeAllListeners("f22-process-ping");
      ipc.on("f22-process-ping", (event, id) => ipc.send("f22-process-pong", id));
    })()
  `);
}

async function barePing(win, exec) {
  await installPing(exec);
  return new Promise((resolve) => {
    const id = `${job.id}:${Date.now()}`;
    const started = process.hrtime.bigint();
    const timer = setTimeout(() => {
      ipcMain.removeListener("f22-process-pong", onPong);
      resolve(null);
    }, 2000);
    const onPong = (event, value) => {
      if (value !== id) return;
      clearTimeout(timer);
      ipcMain.removeListener("f22-process-pong", onPong);
      resolve(Number(process.hrtime.bigint() - started) / 1e6);
    };
    ipcMain.on("f22-process-pong", onPong);
    win.webContents.send("f22-process-ping", id);
  });
}

async function setUpTabs(exec, files) {
  return exec(`
    (() => {
      const paths = ${JSON.stringify(files)};
      const actualRender = window.renderMarkdown;
      let suppressedRenders = 0;
      window.renderMarkdown = () => {
        suppressedRenders += 1;
        return Promise.resolve();
      };
      try {
        localStorage.clear();
        window.isEditMode = false;
        window.originalMarkdown = "";
        const first = window.CustomTabs.createTab(
          paths[0],
          window.fs.readFileSync(paths[0], "utf8"),
          { activate: false },
        );
        for (let index = 1; index < paths.length; index += 1) {
          window.CustomTabs.createTab(
            paths[index],
            window.fs.readFileSync(paths[index], "utf8"),
            { activate: false },
          );
        }
        window.CustomTabs.switchToTab(first.id, { silent: true });
        window.originalMarkdown = first.originalContent;
        const tabs = window.CustomTabs.getTabs();
        return {
          tabs: tabs.length,
          activeMatches: window.CustomTabs.getActiveTab().id === first.id,
          originalsMatch: tabs.every(tab => tab.content === tab.originalContent),
          snapshotMatches: window.originalMarkdown === first.originalContent,
          suppressedRenders,
          headings: (first.content.match(/^#{1,6}\\s/gm) || []).length,
        };
      } finally {
        window.renderMarkdown = actualRender;
      }
    })()
  `);
}

function timingDiagnosis(record) {
  if (!record) return "missing-record";
  if (record.fallbackAt !== null) {
    return record.rendererLateResponseAt !== null
      ? `fallback-${record.fallbackCause}-late-response`
      : `fallback-${record.fallbackCause}-no-response`;
  }
  return record.rendererResponseAt === null ? "no-renderer-response" : "clean-response";
}

async function run() {
  const startedAt = process.hrtime.bigint();
  let win;
  let exec;
  let closes = 0;
  let modals = 0;
  let lastCloseAt = 0n;
  let lastModalAt = 0n;
  const cleanup = [];
  const diagnostics = {
    startupMs: null,
    setup: null,
    lifecycle,
    samples: [],
  };

  try {
    await app.whenReady();
    win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error("main.js did not create its document window");
    win.show();
    win.focus();
    if (typeof win.webContents.setBackgroundThrottling === "function") {
      win.webContents.setBackgroundThrottling(false);
      diagnostics.backgroundThrottlingDisabled = true;
    } else {
      diagnostics.backgroundThrottlingDisabled = false;
    }
    exec = (code) => win.webContents.executeJavaScript(code, true);
    const ready = await waitUntil(() => __shutdown.state().renderer === "ready", 30000);
    if (!ready) throw new Error(`renderer was not ready: ${JSON.stringify(__shutdown.state())}`);
    diagnostics.startupMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

    const recordLifecycle = (kind) => {
      lifecycle.push({
        kind,
        phase,
        atMs: Number(process.hrtime.bigint()) / 1e6,
        isLoading: win.webContents.isLoading(),
        state: __shutdown.state(),
        timing: __shutdown.timing.state(),
      });
    };
    win.on("unresponsive", () => recordLifecycle("unresponsive"));
    win.on("responsive", () => recordLifecycle("responsive"));

    cleanup.push(
      replaceMethod(dialog, "showMessageBox", async () => {
        modals += 1;
        lastModalAt = process.hrtime.bigint();
        return { response: 1 };
      }),
      replaceMethod(dialog, "showMessageBoxSync", () => {
        modals += 1;
        return 1;
      }),
    );
    if (job.mode !== "lifecycle") {
      cleanup.push(
        replaceMethod(win, "close", () => {
          closes += 1;
          lastCloseAt = process.hrtime.bigint();
        }),
      );
    }

    diagnostics.fixtures = verifyFixtures();
    phase = "setup";
    const fixture = await setUpTabs(exec, job.files);
    diagnostics.setup = fixture;
    if (
      fixture.tabs !== job.tabCount ||
      !fixture.activeMatches ||
      !fixture.originalsMatch ||
      !fixture.snapshotMatches ||
      fixture.suppressedRenders !== 1
    ) {
      throw new Error(`fixture invariant failed: ${JSON.stringify(fixture)}`);
    }
    phase = "barrier";
    if (!(await quiesce(exec))) throw new Error("renderer did not quiesce");
    const setupPingMs = await barePing(win, exec);
    diagnostics.setup.barePingMs = setupPingMs;
    if (!finite(setupPingMs)) throw new Error("setup bare IPC ping timed out");
    if (lifecycle.some((entry) => entry.kind === "unresponsive")) {
      throw new Error(`setup health failed: ${JSON.stringify(lifecycle)}`);
    }

    __shutdown.timing.enable();
    if (job.mode === "lifecycle") {
      const observed = {
        nativeClose: false,
        windowDestroyed: false,
        windowAllClosed: false,
        beforeQuit: false,
        willQuit: false,
      };
      win.once("close", () => { observed.nativeClose = true; });
      win.once("closed", () => { observed.windowDestroyed = true; });
      app.prependOnceListener("window-all-closed", () => {
        observed.windowAllClosed = true;
      });
      app.once("before-quit", () => { observed.beforeQuit = true; });
      app.once("will-quit", () => {
        observed.willQuit = true;
        lifecycleExitResult = {
          status:
            observed.nativeClose &&
            observed.windowDestroyed &&
            observed.windowAllClosed &&
            observed.beforeQuit
              ? "ok"
              : "failed",
          diagnostics: {
            ...diagnostics,
            lifecycleControl: observed,
            samples: [{ index: 0, elapsedMs: 0 }],
          },
        };
      });
      phase = "sample";
      win.close();
      return;
    }
    const closeClean = async (sampleIndex, warmup) => {
      phase = warmup ? "warmup" : "sample";
      __shutdown.reset();
      closes = 0;
      const modalBefore = modals;
      const lifecycleBefore = lifecycle.length;
      const beforeId = __shutdown.state().lastRequestId;
      const event = { prevented: false, preventDefault() { this.prevented = true; } };
      const started = process.hrtime.bigint();
      win.emit("close", event);
      const continued = await waitUntil(() => closes === 1, 2000);
      const state = __shutdown.state();
      const request = __shutdown.timing.state().requests.at(-1);
      const sample = {
        index: sampleIndex,
        warmup,
        elapsedMs: continued ? Number(lastCloseAt - started) / 1e6 : null,
        modalDelta: modals - modalBefore,
        prevented: event.prevented,
        state,
        request,
        timingDiagnosis: timingDiagnosis(request),
        lifecycle: lifecycle.slice(lifecycleBefore),
      };
      if (
        !continued ||
        !event.prevented ||
        sample.modalDelta !== 0 ||
        state.lastRequestId !== beforeId + 1 ||
        state.settleWhy !== "clean" ||
        !request ||
        request.rendererDispatchedAt === null ||
        request.rendererResponseAt === null ||
        request.settledAt === null ||
        request.continuationInvokedAt === null ||
        request.fallbackAt !== null ||
        request.rendererLateResponseAt !== null ||
        sample.lifecycle.some((entry) => entry.kind === "unresponsive")
      ) {
        throw new Error(`shutdown protocol failed: ${JSON.stringify(sample)}`);
      }
      return sample;
    };

    if (job.mode === "cold") {
      diagnostics.samples.push(await closeClean(0, false));
    } else if (job.mode === "warm") {
      for (let index = 0; index < 10; index += 1) await closeClean(index, true);
      phase = "barrier";
      if (!(await quiesce(exec))) throw new Error("warm renderer did not quiesce");
      const warmPingMs = await barePing(win, exec);
      if (!finite(warmPingMs)) throw new Error("warm bare IPC ping timed out");
      diagnostics.warmPingMs = warmPingMs;
      for (let index = 0; index < 40; index += 1) {
        diagnostics.samples.push(await closeClean(index, false));
      }
    } else if (job.mode === "listener") {
      phase = "control";
      // THE GENERATION IS LOAD-BEARING, NOT DECORATION. Without it the
      // renderer's handler rejects the request as stale on its FIRST guard -
      // `Number.isSafeInteger(undefined)` is false - and returns before
      // snapshotActiveTab() and before the all-tab scan. Every "sample" then
      // times a console.log, and the control reports that the handler costs
      // nothing and does not scale with document size: a confident wrong
      // answer, and one nothing else here could catch, because the listener
      // mode has no oracle of its own. Hence the reply counter below.
      const listenerGeneration = await exec(
        `window.ipcRenderer.invoke("quit-approval-generation")`,
      );
      const control = await exec(`
        (() => {
          const ipc = require("electron").ipcRenderer;
          const handler = ipc.listeners("quit-approval-request")[0];
          if (!handler) return null;
          const send = ipc.send;
          let answers = 0;
          let lastDirty = null;
          ipc.send = function (channel, value) {
            if (channel === "quit-approval-response") {
              answers += 1;
              lastDirty = value && value.dirtyFiles;
              return;
            }
            return send.apply(this, arguments);
          };
          try {
            let id = 900000000000;
            for (let index = 0; index < 10; index += 1) {
              handler({}, { id: id++, reason: "window-close", gen: ${listenerGeneration} });
            }
            const samples = [];
            for (let index = 0; index < 40; index += 1) {
              const started = performance.now();
              handler({}, { id: id++, reason: "window-close", gen: ${listenerGeneration} });
              samples.push(performance.now() - started);
            }
            return { samples, answers, lastDirty };
          } finally {
            ipc.send = send;
          }
        })()
      `);
      const samples = control && control.samples;
      if (!Array.isArray(samples) || !samples.every((value) => Number.isFinite(value))) {
        throw new Error("listener control did not return finite samples");
      }
      // Every one of the 50 calls must have produced an answer. A rejected
      // request produces none, which is exactly the vacuity above.
      if (control.answers !== 50 || !Array.isArray(control.lastDirty)) {
        throw new Error(
          `listener control answered ${control.answers}/50 calls, lastDirty=${JSON.stringify(control.lastDirty)}`,
        );
      }
      diagnostics.listenerControl = {
        answers: control.answers,
        dirtyFiles: control.lastDirty.length,
      };
      diagnostics.samples = samples.map((elapsedMs, index) => ({ index, elapsedMs }));
    } else if (job.mode === "anti") {
      phase = "control";
      const generation = await exec(
        `window.ipcRenderer.invoke("quit-approval-generation")`,
      );
      const proof = await exec(`
        (() => {
          const ipc = require("electron").ipcRenderer;
          const handler = ipc.listeners("quit-approval-request")[0];
          if (!handler) return null;
          const send = ipc.send;
          let reply = null;
          ipc.send = function (channel, value) {
            if (channel === "quit-approval-response") { reply = value; return; }
            return send.apply(this, arguments);
          };
          try {
            const tab = window.CustomTabs.getTabs().at(-1);
            const filename = tab.filename;
            tab.content = tab.originalContent.slice(0, -1) + "X";
            // A view-mode edit lives in window.originalMarkdown, and the
            // shutdown snapshot folds that back over the ACTIVE tab before the
            // scan. Writing tab.content alone is a state the product cannot
            // reach for the active document, and at one tab the tab below IS
            // the active one - so the snapshot would restore the pristine text
            // and this control would prove the opposite of what it claims.
            window.originalMarkdown = window.CustomTabs.getActiveTab().content;
            handler({}, { id: 950000000000, reason: "window-close", gen: ${generation} });
            tab.content = tab.originalContent;
            tab.hasUnsavedChanges = false;
            window.originalMarkdown =
              window.CustomTabs.getActiveTab().originalContent;
            return { filename, dirtyFiles: reply && reply.dirtyFiles };
          } finally {
            ipc.send = send;
          }
        })()
      `);
      if (
        !proof ||
        !Array.isArray(proof.dirtyFiles) ||
        proof.dirtyFiles.length !== 1 ||
        proof.dirtyFiles[0] !== proof.filename
      ) {
        throw new Error(`anti-vacuity failed: ${JSON.stringify(proof)}`);
      }
      diagnostics.antiVacuity = proof;
      diagnostics.samples.push({ index: 0, elapsedMs: 0 });
    } else if (job.mode === "crlf") {
      for (let index = 0; index < 20; index += 1) {
        await exec(`
          (() => {
            const tab = window.CustomTabs.getTabs().at(-1);
            tab.content = tab.originalContent.slice(0, -1) + "X";
            tab.hasUnsavedChanges = false;
            // Keeps the active document's live copy in step with its cache, so
            // the shutdown snapshot folds nothing back over it. A no-op at 25
            // tabs, where the dirtied tab is a background one, and the reason
            // this stays correct if that ever changes.
            window.originalMarkdown = window.CustomTabs.getActiveTab().content;
          })()
        `);
        phase = "sample";
        __shutdown.reset();
        const modalBefore = modals;
        const event = { prevented: false, preventDefault() { this.prevented = true; } };
        const started = process.hrtime.bigint();
        win.emit("close", event);
        const asked = await waitUntil(() => modals === modalBefore + 1, 2000);
        const request = __shutdown.timing.state().requests.at(-1);
        if (
          !asked ||
          !event.prevented ||
          !request ||
          request.rendererResponseAt === null ||
          request.fallbackAt !== null
        ) {
          throw new Error(`CRLF dirty close failed: ${JSON.stringify({ event, request, lifecycle })}`);
        }
        diagnostics.samples.push({
          index,
          elapsedMs: Number(lastModalAt - started) / 1e6,
          request,
        });
        await exec(`
          (() => {
            const tab = window.CustomTabs.getTabs().at(-1);
            tab.content = tab.originalContent;
            tab.hasUnsavedChanges = false;
            window.originalMarkdown =
              window.CustomTabs.getActiveTab().originalContent;
          })()
        `);
      }
    } else if (
      job.mode === "dirty-lf" ||
      job.mode === "dirty-crlf" ||
      job.mode === "edit-lf" ||
      job.mode === "edit-crlf"
    ) {
      // THE ACTIVE DOCUMENT'S REAL RECONCILIATION PATH. The dirty-* modes put
      // every tab's text in through `tab.content`, which is the background-tab
      // path - correct for the 24 tabs nobody is looking at, but it never
      // reaches the branch of snapshotActiveTab() that matters most: the one
      // that reconciles the EDITOR against the cache. The edit-* modes enter
      // real edit mode (the same `.content-wrapper.split-view` class
      // renderer.js toggles, which is what inEditMode() reads) and put the
      // active tab's edit into the textarea, so the close pays the genuine
      // textarea-vs-cache comparison on a 2 MB document. The other 24 tabs are
      // still late-edited in the background, and the filename oracle still
      // demands all 25.
      const editMode = job.mode === "edit-lf" || job.mode === "edit-crlf";
      // THE TERMINAL CHARACTER THE EDITOR HOLDS, and it is deliberately not in
      // EDIT_ALPHABET below. The editor buffer is written ONCE (see the setup
      // block); every sample then rewrites the CACHE to a different terminal
      // character, so the fold always finds the live copy and the cache
      // disagreeing and always performs a real 2 MB reconciliation. If the two
      // could ever coincide, that sample would measure a no-op.
      const EDITOR_TERMINAL = "~";
      if (editMode) {
        // MODE IS CONFIGURED BEFORE THE GIANT BUFFER EXISTS ANYWHERE NEAR THE
        // EDITOR, and configuring it renders nothing: `.content-wrapper
        // .split-view` is the class renderer.js toggles and the class
        // inEditMode() reads, and adding it does not re-run the preview.
        //
        // THE EDITOR'S BOX IS THEN TAKEN OUT OF LAYOUT for the duration. This
        // is the one accommodation this observation makes, and it is disclosed
        // rather than implied: laying out two million characters of text costs
        // Chromium SECONDS, the renderer cannot answer a liveness ping while it
        // does so, and the run's own health check - correctly - fails on that.
        // Measured: two `unresponsive` lifecycle events per worker, about five
        // seconds apart, on a sample loop whose measured work was six
        // milliseconds. Nothing in the shutdown scan reads layout: it reads
        // `editor.value` and compares strings, and that path is untouched by
        // whether the box is painted. `editorRendered` records the choice so
        // the parent can assert it rather than inherit an assumption.
        const entered = await exec(`
          (() => {
            const wrapper = document.querySelector(".content-wrapper");
            if (!wrapper || !window.markdownEditor) return null;
            wrapper.classList.add("split-view");
            window.__f22EditorDisplay = window.markdownEditor.style.display;
            window.markdownEditor.style.display = "none";
            return {
              splitView: wrapper.classList.contains("split-view"),
              inEditMode: window.CustomTabs.__inEditMode(),
              editorRendered: window.markdownEditor.offsetParent !== null,
              editorLength: window.markdownEditor.value.length,
            };
          })()
        `);
        if (
          !entered ||
          entered.inEditMode !== true ||
          entered.splitView !== true ||
          entered.editorRendered !== false
        ) {
          throw new Error(`edit-mode setup failed: ${JSON.stringify(entered)}`);
        }
        // THE 2 MB BUFFER GOES IN ONCE, HERE, IN SETUP - not on every sample.
        // Re-assigning it per sample was the other half of the hang, and it was
        // never necessary: what the timed window has to pay is the READ and the
        // COMPARISON of two 2 MB documents, and those happen whether or not the
        // buffer was rewritten first.
        const loaded = await exec(`
          (() => {
            const active = window.CustomTabs.getActiveTab();
            const edited =
              active.originalContent.slice(0, -1) + ${JSON.stringify(EDITOR_TERMINAL)};
            window.markdownEditor.value = edited;
            // Flattened here, outside the timed window, for the same reason the
            // background tabs are: a cons or sliced string would otherwise pay
            // a 2 MB flatten inside sameDocument that a real edited document,
            // held flat by the editor, never pays.
            window.markdownEditor.value.indexOf("\\u0000");
            return {
              editorLength: window.markdownEditor.value.length,
              endsWithTerminal: window.markdownEditor.value.endsWith(
                ${JSON.stringify(EDITOR_TERMINAL)},
              ),
            };
          })()
        `);
        if (!loaded || loaded.endsWithTerminal !== true || loaded.editorLength < 1000) {
          throw new Error(`edit-mode buffer setup failed: ${JSON.stringify(loaded)}`);
        }
        entered.editorLength = loaded.editorLength;
        // AND THEN WAIT FOR THE RENDERER TO GO QUIET. Two animation frames plus
        // a round trip: the frames prove a render cycle completed, the round
        // trip proves the main thread is answering again. Everything above is
        // setup, and the health check below must see a settled renderer before
        // the first sample rather than a busy one.
        await exec(`
          new Promise((resolve) => {
            requestAnimationFrame(() =>
              requestAnimationFrame(() => setTimeout(() => resolve(true), 0)),
            );
          })
        `);
        await exec(`window.CustomTabs.getTabs().length`);
        diagnostics.editSetup = entered;
      }
      // WORST CASE: EVERY OPEN DOCUMENT EDITED, EVERY SAMPLE, AT EQUAL LENGTH.
      // Three separate fast paths have to be defeated for this to measure what
      // it claims to, and each of them was measured rather than assumed:
      //
      //  - THE MEMO. isDirty() caches on the exact (content, originalContent)
      //    pair, compared by VALUE. Re-assigning the same text is therefore a
      //    HIT, not a miss, however many new string objects it builds - so the
      //    edited VALUE has to differ from the previous sample's. It cycles
      //    through EDIT_ALPHABET below.
      //  - LENGTH. `a === b` on strings of different lengths returns without
      //    reading a byte, and so does the memo's own comparison. An edit that
      //    lengthens the document therefore measures nothing but the two
      //    indexOf scans. Replacing the final character keeps the lengths
      //    equal, so every comparison in the chain runs to completion.
      //  - LAZY STRINGS. `slice()` yields a sliced string and `+ "A"` a cons
      //    string, both unflattened; the first read inside sameDocument would
      //    otherwise pay a 2 MB flatten that a real edited document - held flat
      //    by the editor - never pays. `indexOf` on an absent character forces
      //    the flatten, and it happens in setup, outside the timed window.
      const EDIT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      // Record the real answer as it goes past, rather than replaying the
      // handler with a synthetic id afterwards: a synthetic id has to be larger
      // than every real one, and the renderer's stale-request watermark would
      // then refuse the NEXT sample's genuine close. This passes every message
      // through untouched.
      await exec(`
        (() => {
          const ipc = require("electron").ipcRenderer;
          window.__f22Answers = [];
          window.__f22RealSend = ipc.send;
          ipc.send = function (channel, value) {
            if (channel === "quit-approval-response") {
              window.__f22Answers.push(value && value.dirtyFiles);
            }
            return window.__f22RealSend.apply(this, arguments);
          };
          return true;
        })()
      `);
      const oracle = { samples: 0, dirtyFiles: null };
      const editReconciled = { samples: 0, length: 0 };
      try {
        for (let index = 0; index < 20; index += 1) {
          const editChar = EDIT_ALPHABET[index % EDIT_ALPHABET.length];
          const dirtied = await exec(`
            (() => {
              const tabs = window.CustomTabs.getTabs();
              for (const tab of tabs) {
                tab.content = tab.originalContent.slice(0, -1) + ${JSON.stringify(editChar)};
                tab.hasUnsavedChanges = false;
                tab.content.indexOf("\\u0000");
              }
              const active = window.CustomTabs.getActiveTab();
              if (${editMode ? "true" : "false"}) {
                // THE EDITOR IS NOT TOUCHED HERE. Its 2 MB buffer was written
                // once in setup and ends in a character no sample ever writes,
                // so the cache assignment above has just made the live copy and
                // the cache disagree - which is exactly the state
                // snapshotActiveTab() has to reconcile, and it will read and
                // compare both documents in full to do it. Rewriting the
                // textarea per sample bought nothing and cost a multi-second
                // relayout that the run's own liveness check failed on.
                window.markdownEditor.value.indexOf("\\u0000");
              } else {
                // The ACTIVE tab's edit has to exist where a view-mode edit
                // really lives, or the shutdown snapshot folds the pristine
                // text back over it and reports that one document clean -
                // which would silently make this a 24-of-25 measurement.
                window.originalMarkdown = active.content;
              }
              return tabs.every(tab => tab.content.length === tab.originalContent.length)
                ? tabs.length
                : -1;
            })()
          `);
          if (dirtied !== job.tabCount) {
            throw new Error(`all-dirty setup dirtied ${dirtied} of ${job.tabCount}`);
          }
          phase = "sample";
          __shutdown.reset();
          const modalBefore = modals;
          const answersBefore = await exec(`window.__f22Answers.length`);
          const event = { prevented: false, preventDefault() { this.prevented = true; } };
          const started = process.hrtime.bigint();
          win.emit("close", event);
          const asked = await waitUntil(() => modals === modalBefore + 1, 20000);
          const request = __shutdown.timing.state().requests.at(-1);
          if (
            !asked ||
            !event.prevented ||
            !request ||
            request.rendererResponseAt === null ||
            request.fallbackAt !== null
          ) {
            throw new Error(
              `all-dirty close failed: ${JSON.stringify({ mode: job.mode, event, request, lifecycle })}`,
            );
          }
          diagnostics.samples.push({
            index,
            elapsedMs: Number(lastModalAt - started) / 1e6,
            request,
          });
          // THE ANSWER IS THE ORACLE. A close that raised the modal proves a
          // dialog appeared, not that anything was scanned - so the exact list
          // the renderer sent is read back and compared, by the parent, against
          // the exact fixture filenames. Every sample must produce the same
          // list; a run whose answer drifted measured two workloads and can
          // average neither.
          const answerCount = await exec(`window.__f22Answers.length`);
          if (answerCount !== answersBefore + 1) {
            throw new Error(
              `all-dirty sample ${index} produced ${answerCount} answers, expected ${answersBefore + 1}`,
            );
          }
          const answered = await exec(
            `window.__f22Answers[window.__f22Answers.length - 1]`,
          );
          if (!Array.isArray(answered) || answered.length !== job.tabCount) {
            throw new Error(
              `all-dirty oracle returned ${JSON.stringify(answered)} for ${job.tabCount} tabs`,
            );
          }
          if (oracle.dirtyFiles === null) {
            oracle.dirtyFiles = answered;
          } else if (JSON.stringify(oracle.dirtyFiles) !== JSON.stringify(answered)) {
            throw new Error(
              `all-dirty oracle drifted: ${JSON.stringify(oracle.dirtyFiles)} then ${JSON.stringify(answered)}`,
            );
          }
          oracle.samples += 1;
          if (editMode) {
            // THE RECONCILIATION IS WITNESSED, NOT ASSUMED. The editor holds a
            // buffer ending in a character no sample ever writes to the cache,
            // so a cache that now ends in it can only have been adopted from
            // the editor - which is proof that snapshotActiveTab() really took
            // the edit-mode branch and really read the 2 MB textarea. Without
            // this the observation could measure a view-mode fold and report an
            // edit-mode number.
            const reconciled = await exec(`
              (() => {
                const active = window.CustomTabs.getActiveTab();
                return {
                  adopted: active.content.endsWith(${JSON.stringify(EDITOR_TERMINAL)}),
                  length: active.content.length,
                };
              })()
            `);
            if (!reconciled || reconciled.adopted !== true) {
              throw new Error(
                `edit-mode sample ${index} did not reconcile the editor into the cache: ` +
                  JSON.stringify(reconciled),
              );
            }
            editReconciled.samples += 1;
            editReconciled.length = reconciled.length;
          }
          await exec(`
            (() => {
              for (const tab of window.CustomTabs.getTabs()) {
                tab.content = tab.originalContent;
                tab.hasUnsavedChanges = false;
              }
              const active = window.CustomTabs.getActiveTab();
              window.originalMarkdown = active.originalContent;
              // THE EDITOR IS LEFT ALONE IN EDIT MODE. Its buffer is written
              // once, in setup; rewriting 2 MB into a textarea here would put
              // the multi-second relayout back into the loop, which is the
              // defect this whole arrangement exists to remove.
              if (window.markdownEditor && ${editMode ? "false" : "true"}) {
                window.markdownEditor.value = active.originalContent;
              }
              return true;
            })()
          `);
        }
      } finally {
        await exec(`
          (() => {
            const ipc = require("electron").ipcRenderer;
            if (window.__f22RealSend) ipc.send = window.__f22RealSend;
            delete window.__f22RealSend;
            delete window.__f22Answers;
            // Leave the window exactly as it was found: an edit-mode class that
            // outlived its observation would silently change what every later
            // job in this process measures, and an editor left out of layout
            // would hide a real render cost from whatever ran next.
            const wrapper = document.querySelector(".content-wrapper");
            if (wrapper) wrapper.classList.remove("split-view");
            if (window.markdownEditor && typeof window.__f22EditorDisplay === "string") {
              window.markdownEditor.value = "";
              window.markdownEditor.style.display = window.__f22EditorDisplay;
            }
            delete window.__f22EditorDisplay;
            return true;
          })()
        `);
      }
      diagnostics.dirtyOracle = oracle;
      if (editMode) diagnostics.editReconciled = editReconciled;
    } else {
      throw new Error(`unsupported primary mode ${job.mode}`);
    }

    phase = "complete";
    if (lifecycle.some((entry) => entry.kind === "unresponsive")) {
      throw new Error(`unresponsive lifecycle event: ${JSON.stringify(lifecycle)}`);
    }
    writeResult("ok", diagnostics);
  } catch (error) {
    fail("worker exception", error.stack || String(error));
    writeResult("failed", diagnostics);
  } finally {
    __shutdown.timing.disable();
    while (cleanup.length) cleanup.pop()();
  }
}

function writeResult(status, diagnostics) {
  const result = {
    protocolVersion: WORKER_VERSION,
    token: job.token,
    id: job.id,
    mode: job.mode,
    point: job.point,
    digest: job.digest,
    pid: process.pid,
    status,
    failures,
    diagnostics,
  };
  const temporary = `${job.resultFile}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(result), "utf8");
    fs.renameSync(temporary, job.resultFile);
  } catch (error) {
    console.error(`F22 worker could not atomically publish result: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = status === "ok" ? 0 : 1;
}

process.once("exit", () => {
  if (lifecycleExitResult) {
    writeResult(lifecycleExitResult.status, lifecycleExitResult.diagnostics);
  }
});

app.whenReady().then(run).then(() => {
  if (job.mode === "lifecycle") {
    // THE LIFECYCLE WORKER STILL HAS TO DIE. Its whole point is to reach real
    // application termination through the product's own path, so it must not be
    // exited from here - but if that path does not complete, this process would
    // sit on the machine holding the parent's exclusivity open until the
    // parent's timeout killed it. The watchdog is a long backstop, not a
    // schedule: a lifecycle quit that is working finishes in milliseconds, and
    // anything still here after this has already failed.
    //
    // DELIBERATELY REFERENCED. It was unref'd, which makes it a timer that only
    // fires if something else is already keeping the loop alive - precisely not
    // guaranteed for the case it exists to cover. A successful lifecycle quit
    // ends the process through app.quit() long before this, so holding a handle
    // costs a working run nothing.
    setTimeout(() => {
      console.error("F22 lifecycle worker did not terminate through the product path");
      app.exit(process.exitCode || 1);
    }, 30000);
    return;
  }
  setTimeout(() => app.exit(process.exitCode || 0), 20).unref?.();
}).catch((error) => {
  // run() handles its own failures, so reaching here means the failure was in
  // the teardown itself. A worker that neither published nor exited is the one
  // outcome the parent cannot resolve except by timing out and killing it, so
  // this exits explicitly rather than leaving the process on the machine.
  console.error(
    "F22 worker teardown failed:",
    error && error.stack ? error.stack : error,
  );
  app.exit(process.exitCode || 1);
});
