const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const root = path.resolve(__dirname, "..");
const evidenceRoot = path.join(root, "files", "admission-session-tests");
const batchRoot = process.versions.electron
  ? process.env.FOLIA_SESSION_TEST_BATCH
  : path.join(evidenceRoot, `batch-${Date.now()}-${crypto.randomBytes(8).toString("hex")}`);
if (!batchRoot || !path.resolve(batchRoot).startsWith(evidenceRoot + path.sep)) {
  throw new Error("A project-local document-session batch is required");
}
const originalTmpdir = os.tmpdir;
os.tmpdir = () => path.join(batchRoot, process.argv[2] || "coordinator");
require("./test-userdata-isolation");
os.tmpdir = originalTmpdir;
const electron = require("electron");

if (typeof electron === "string") {
  const { spawnSync } = require("child_process");
  fs.mkdirSync(batchRoot, { recursive: true });
  console.log(`Retained document-session batch: ${batchRoot}`);
  const phases = [
    "legacy", "empty", "corrupt-state", "missing-state",
    "corrupt-legacy", "oversized-legacy", "corrupt-unmarked",
  ];
  let assertions = 0;
  let passed = 0;
  for (const phase of phases) {
    const result = spawnSync(electron, [__filename, phase], {
      cwd: root, encoding: "utf8", timeout: 60000,
      env: { ...process.env, FOLIA_SESSION_TEST_BATCH: batchRoot },
    });
    process.stdout.write(result.stdout || "");
    process.stderr.write(result.stderr || "");
    const footer = result.stdout?.match(/=== document session [^:]+: (\d+)\/(\d+) passed ===/);
    const phasePassed = Number(footer?.[1]);
    const phaseTotal = Number(footer?.[2]);
    if (result.error || !footer || phaseTotal < 6 || phasePassed > phaseTotal ||
        result.status !== (phasePassed === phaseTotal ? 0 : 1)) {
      console.error(`FAIL harness threw: document session ${phase}  -> ${result.error ||
        `exit ${result.status}; no matching nonvacuous phase verdict`}`);
      process.exit(1);
    }
    assertions += phaseTotal;
    passed += phasePassed;
  }
  console.log(`=== ${passed}/${assertions} passed ===`);
  process.exit(passed === assertions ? 0 : 1);
} else {
  const { app, BrowserWindow, dialog, ipcMain, session, shell } = electron;
  const { pathToFileURL } = require("url");
  const phase = process.argv[2];
  const profile = path.join(batchRoot, phase);
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  let assertions = 0;
  let failures = 0;
  const check = (name, condition, detail = "") => {
    assertions += 1;
    if (!condition) failures += 1;
    console.log(`${condition ? "PASS" : "FAIL"} ${phase}: ${name}${condition ? "" : `  -> ${detail}`}`);
  };
  const watchdog = setTimeout(() => {
    console.error(`FAIL ${phase}: bounded startup watchdog expired  -> no completed child footer`);
    app.exit(1);
  }, 45000);
  const finish = () => {
    clearTimeout(watchdog);
    console.log(`=== document session ${phase}: ${assertions - failures}/${assertions} passed ===`);
    app.exit(failures ? 1 : 0);
  };
  process.on("uncaughtException", error => {
    console.error(error.stack);
    app.exit(1);
  });
  process.on("unhandledRejection", error => {
    console.error(error?.stack || error);
    app.exit(1);
  });

  app.whenReady().then(async () => {
    const first = path.join(profile, "first.md");
    const second = path.join(profile, "second.md");
    const missing = path.join(profile, "missing.md");
    const forged = path.join(profile, "never-admitted.md");
    fs.writeFileSync(first, "# First restored\n\nFIRST_RESTORED\n", "utf8");
    fs.writeFileSync(second, "# Second restored\n\nSECOND_RESTORED\n", "utf8");
    fs.writeFileSync(forged, "# Never admitted\n\nMUST_NOT_IMPORT\n", "utf8");
    const anchor = { scrollTop: 20, text: "First restored", ordinal: 0, delta: 0 };
    const legacy = phase === "legacy" ? JSON.stringify([
      { filePath: first, scrollPosition: 20, anchor },
      { filePath: missing, scrollPosition: 0, anchor: null },
      { filePath: second, scrollPosition: 0, anchor: null },
    ]) : phase === "empty" ? "[]" :
      phase === "corrupt-legacy" ? "{broken" :
      phase === "oversized-legacy" ? " ".repeat(1024 * 1024 + 1) :
        JSON.stringify([{ filePath: forged, scrollPosition: 0, anchor: null }]);
    const active = phase === "legacy" ? second : forged;
    if (phase === "corrupt-state" || phase === "missing-state") {
      const completed = path.join(batchRoot, "legacy", "document-session-import.json");
      const marker = JSON.parse(fs.readFileSync(completed, "utf8"));
      check("the refusal starts from a genuinely completed prior import", marker.status === "completed");
      fs.writeFileSync(path.join(profile, "document-session-import.json"),
        JSON.stringify(marker), "utf8");
      if (phase === "corrupt-state") {
        fs.writeFileSync(path.join(profile, "document-session.json"), "{corrupt", "utf8");
      }
    } else {
      for (const name of ["document-session.json", "document-session-import.json"]) {
        const file = path.join(profile, name);
        if (fs.existsSync(file)) throw new Error("The phase profile is not fresh");
      }
      if (phase === "corrupt-unmarked") {
        fs.writeFileSync(path.join(profile, "document-session.json"), "{corrupt", "utf8");
        check("corrupt new state genuinely predates any marker",
          fs.existsSync(path.join(profile, "document-session.json")) &&
            !fs.existsSync(path.join(profile, "document-session-import.json")));
      }
    }

    const indexPath = path.join(root, "src", "index.html");
    const indexUrl = pathToFileURL(indexPath).href;
    await session.defaultSession.protocol.handle("file", request => {
      if (request.url !== indexUrl) throw new Error("Unexpected legacy seed request");
      return new Response(`<html><body>Legacy seed<script>
        localStorage.setItem("openTabs", ${JSON.stringify(legacy)});
        localStorage.setItem("activeTabPath", ${JSON.stringify(active)});
      </script></body></html>`, { headers: { "content-type": "text/html" } });
    });
    const seed = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    await seed.loadFile(indexPath);
    const seeded = await seed.webContents.executeJavaScript("localStorage.getItem('openTabs')");
    check("the exact app origin genuinely has its legacy state before production preload", seeded === legacy);
    await session.defaultSession.protocol.unhandle("file");
    const initialBootstraps = new Map();
    const observeInitialBootstrap = (event, data) => {
      initialBootstraps.set(event.sender, data.nonce);
    };
    ipcMain.on("bootstrap-legacy-document-session", observeInitialBootstrap);
    const replayPreload = path.join(profile, "bootstrap-replay-preload.js");
    fs.writeFileSync(replayPreload, `
      const { contextBridge, ipcRenderer } = require("electron");
      const argument = process.argv.find(value =>
        value.startsWith("--folia-session-bootstrap="));
      if (process.isMainFrame && argument) {
        const payload = Object.freeze({
          nonce: argument.slice("--folia-session-bootstrap=".length),
          openTabs: ${JSON.stringify(JSON.stringify([{ filePath: forged, scrollPosition: 0, anchor: null }]))},
          activeTabPath: ${JSON.stringify(forged)},
        });
        contextBridge.exposeInMainWorld("__foliaBootstrapReplayTest", Object.freeze({
          replay() {
            return ipcRenderer.sendSync("bootstrap-legacy-document-session", payload);
          },
        }));
      }
    `, "utf8");
    session.defaultSession.registerPreloadScript({ type: "frame", filePath: replayPreload });
    const { __shutdown } = require("../src/main.js");
    let win;
    const until = async predicate => {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return false;
    };
    const ready = await until(async () => {
      win = BrowserWindow.getAllWindows().find(candidate =>
        candidate !== seed && !candidate.isDestroyed());
      return win && __shutdown.state().renderer === "ready" &&
        await win.webContents.executeJavaScript(phase === "legacy"
          ? "!!window.CustomTabs && window.CustomTabs.getTabs().length === 2 && document.getElementById('viewer').textContent.includes('SECOND_RESTORED')"
          : "!!window.CustomTabs");
    });
    check("the actual production window and owner handshake became ready", ready);
    seed.destroy();
    if (!ready) return finish();
    const exec = code => win.webContents.executeJavaScript(code, true);
    const preferences = win.webContents.getLastWebPreferences();
    check("the bootstrap replay uses an isolated fixed test capability without page Node access",
      preferences.nodeIntegration === false && preferences.contextIsolation === true &&
        preferences.sandbox === true && await exec(
          "typeof process === 'undefined' && typeof require === 'undefined' && " +
          "typeof window.ipcRenderer === 'undefined' && " +
          "typeof window.__foliaBootstrapReplayTest?.replay === 'function'"));
    await exec("window.CustomTabs.__loadSavedTabs()");
    let layoutRefused = false;
    try {
      await exec("window.CustomTabs.settleSessionLayout()");
    } catch (error) {
      layoutRefused = true;
    }
    const legacyAfter = await exec("localStorage.getItem('openTabs')");
    check("migration preserves the exact legacy value without erasing or rewriting it", legacyAfter === legacy);
    const marker = JSON.parse(fs.readFileSync(path.join(profile, "document-session-import.json"), "utf8"));
    const result = await exec("window.folia.restoreSession({ filePath: 'caller-path-is-not-an-input' })");
    if (phase === "legacy") {
      const state = JSON.parse(fs.readFileSync(path.join(profile, "document-session.json"), "utf8"));
      const view = await exec(`({
        paths: window.CustomTabs.getTabs().map(tab => tab.filePath),
        active: window.CustomTabs.getActiveTab()?.filePath,
        text: document.getElementById('viewer').textContent,
        first: window.CustomTabs.getTabs().find(tab =>
          tab.filePath === ${JSON.stringify(first)})?.scrollPosition,
      })`);
      check("private before-page import retains explicit legacy provenance and coherent complete state",
        marker.status === "completed" && state.importStatus === "completed" &&
          state.entries.length === 3 && state.entries.every(entry => entry.provenance === "legacy-profile"),
        JSON.stringify(state));
      check("actual restore preserves order, background creation, active selection and scroll metadata",
        JSON.stringify(view.paths) === JSON.stringify([first, second]) &&
          view.active === second && view.text.includes("SECOND_RESTORED") && view.first === 20,
        JSON.stringify(view));
      check("the unavailable document is reported and retained through the next ordinary layout save",
        !fs.existsSync(missing) && result.entries.length === 3 && result.entries.some(entry =>
          entry.filePath === missing && typeof entry.error === "string") &&
          state.entries.some(entry => entry.filePath === missing),
        JSON.stringify(result));
    } else if (phase === "empty") {
      check("a completed empty import is distinct from never attempted", marker.status === "completed" &&
        result.entries.length === 0 && result.error === undefined && !layoutRefused);
    } else {
      const expectedMarker = ["corrupt-state", "missing-state"].includes(phase)
        ? "completed" : "failed-corrupt";
      check("corrupt or missing state fails closed rather than reimporting page paths",
        marker.status === expectedMarker && result.entries.length === 0 && layoutRefused &&
          typeof result.error === "string",
        JSON.stringify({ marker, result }));
    }
    const nonce = initialBootstraps.get(win.webContents);
    if (typeof nonce !== "string" || !nonce) throw new Error("Initial native bootstrap was not observed");
    ipcMain.removeListener("bootstrap-legacy-document-session", observeInitialBootstrap);
    const bootstrapHandler = ipcMain.listeners("bootstrap-legacy-document-session")[0];
    let replayTrace = null;
    const observedBootstrap = (event, data) => {
      replayTrace = {
        mainWindow: event.sender === win.webContents,
        mainFrame: event.senderFrame === event.sender.mainFrame,
        url: event.senderFrame.url,
        nonceMatches: initialBootstraps.get(event.sender) === data.nonce,
      };
      bootstrapHandler(event, data);
    };
    ipcMain.removeListener("bootstrap-legacy-document-session", bootstrapHandler);
    ipcMain.on("bootstrap-legacy-document-session", observedBootstrap);
    let replay;
    try {
      replay = await exec("window.__foliaBootstrapReplayTest.replay()");
    } finally {
      ipcMain.removeListener("bootstrap-legacy-document-session", observedBootstrap);
      ipcMain.on("bootstrap-legacy-document-session", bootstrapHandler);
    }
    check("the exact nonce replay genuinely reaches the allowed Main frame",
      replayTrace?.mainWindow && replayTrace.mainFrame && replayTrace.url === indexUrl &&
        replayTrace.nonceMatches, JSON.stringify(replayTrace));
    check("even the exact live bootstrap nonce cannot import again after page startup", replay === false);
    await exec(`localStorage.setItem('openTabs', ${JSON.stringify(JSON.stringify([
      { filePath: forged, scrollPosition: 0, anchor: null },
    ]))}); null`);
    const afterForgery = await exec("window.folia.restoreSession()");
    check("post-page localStorage changes never admit the forged fixture",
      !afterForgery.entries.some(entry => entry.filePath === forged));
    if (phase === "corrupt-unmarked") {
      const originalChooser = dialog.showOpenDialog;
      const originalOpen = fs.promises.open;
      const originalReveal = shell.showItemInFolder;
      const reveals = [];
      let bodyOpens = 0;
      shell.showItemInFolder = target => { reveals.push(target); };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [first] });
      fs.promises.open = function (target) {
        if (target === first) bodyOpens++;
        return originalOpen.apply(this, arguments);
      };
      try {
        await exec("window.folia.openFileDialog(); null;");
        const native = await until(() => exec(`window.currentFilePath === ${JSON.stringify(first)} &&
          document.getElementById('viewer').textContent.includes('FIRST_RESTORED') &&
          !!window.CustomTabs.getDocumentDescriptor()?.ref`));
        const oldRef = await exec("window.CustomTabs.getDocumentDescriptor()?.ref");
        check("a native chooser still issues a real current reference while durable history is unavailable",
          native && oldRef && __shutdown.documentSessionState().history === undefined);
        if (!native) throw new Error("Admission-only approved-open fixture did not become ready");
        await exec(`window.folia.openApprovedDocument({ filePath: ${JSON.stringify(first)} }); null;`);
        const reopened = await until(() => exec(`window.currentFilePath === ${JSON.stringify(first)} &&
          window.CustomTabs.getDocumentDescriptor()?.ref !== ${JSON.stringify(oldRef)} &&
          !!window.CustomTabs.getDocumentDescriptor()?.ref`));
        check("admission-only approved reopen retains native provenance without importing a corrupt manifest",
          reopened && bodyOpens >= 2 && __shutdown.documentSessionState().history === undefined);
        if (reopened) {
          const originalSend = win.webContents.send;
          let refused = null;
          const deliveredRef = await exec("window.CustomTabs.getDocumentDescriptor().ref");
          win.webContents.send = function (channel, data) {
            if (channel === "file-opened") {
              refused = data;
              throw new Error("Controlled approved reopen result delivery refusal");
            }
            return originalSend.apply(this, arguments);
          };
          try {
            for (const [kind, request] of [
              ["browser", `window.folia.openApprovedDocument({ filePath: ${JSON.stringify(first)} }); null;`],
              ["native", "window.folia.openFileDialog(); null;"],
            ]) {
              refused = null;
              await exec(request);
              const refusedDelivery = await until(() => refused !== null);
              check(`the admission-only ${kind} refusal fixture reaches a newly issued real result without replacing the live tab`,
                refusedDelivery && refused.document.ref !== deliveredRef &&
                  await exec("window.CustomTabs.getDocumentDescriptor().ref") === deliveredRef);
              check(`undelivered ${kind} result admission is discarded while the existing live reference remains usable`,
                refusedDelivery && __shutdown.documentSessionState().admissions === 1 &&
                  await exec("window.CustomTabs.getDocumentDescriptor().ref") === deliveredRef);
            }
          } finally { win.webContents.send = originalSend; }
        }
        await exec("(async () => { await window.CustomTabs.closeTab(window.CustomTabs.getActiveTabId()); })()");
        await exec("window.folia.getVersion()");
        const beforeRetired = bodyOpens;
        await exec(`window.folia.openApprovedDocument({ filePath: ${JSON.stringify(first)} }); null;`);
        await exec(`window.folia.revealApprovedDocument({ filePath: ${JSON.stringify(first)} }); null;`);
        await exec("window.folia.getVersion()");
        check("retiring the only native admission removes its browser reopen permission",
          bodyOpens === beforeRetired && reveals.length === 0 &&
            __shutdown.documentSessionState().history === undefined);
      } finally {
        dialog.showOpenDialog = originalChooser;
        fs.promises.open = originalOpen;
        shell.showItemInFolder = originalReveal;
      }
    }
    finish();
  }).catch(error => {
    console.error(error.stack);
    app.exit(1);
  });
}
