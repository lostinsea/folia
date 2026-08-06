// End-to-end regression harness for the tab overlay (custom-tabs.js).
// Run with: npm run test:tabs
//
// Boots the real main.js so every real IPC handler exists, then drives the
// renderer through the multi-tab refresh scenarios via executeJavaScript.
// Uses only the Electron already required to run the app - no test framework.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  inspectVisual,
  captureScreenshot,
  startErrorSentinel,
  proveSentinelAlive,
} = require("./test-visual-utils");

require("./main.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-e2e-"));
const fileA = path.join(dir, "alpha.md");
const fileB = path.join(dir, "beta.md");
const fileM = path.join(dir, "diagram.mmd");
const jsA = JSON.stringify(fileA);
const jsB = JSON.stringify(fileB);
const jsM = JSON.stringify(fileM);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll a page-side condition rather than guessing with a fixed sleep, so the
// fast path stays fast and a slow machine does not produce a false failure.
async function waitForCondition(exec, expression, timeoutMs = 8000) {
  const started = Date.now();
  let last = false;
  while (Date.now() - started < timeoutMs) {
    last = await exec(expression);
    if (last) return true;
    await sleep(100);
  }
  return last === true;
}

// mtime has 1ms resolution but writes can land inside the same tick; bump the
// mtime explicitly so the change is unambiguously detectable.
function write(file, content) {
  fs.writeFileSync(file, content, "utf8");
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(file, future, future);
}

async function run(win) {
  const exec = (code) => win.webContents.executeJavaScript(code, true);
  const sentinel = startErrorSentinel(win, { label: "tabs" });

  write(fileA, "# Alpha\n\nALPHA_V1\n");
  write(fileB, "# Beta\n\nBETA_V1\n");

  await exec(`
    localStorage.clear();
    window.CustomTabs.getTabs().forEach(t => { t.hasUnsavedChanges = false; });
    window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
    null;
  `);

  const ids = await exec(`
    (() => {
      const a = window.CustomTabs.createTab(${jsA}, window.fs.readFileSync(${jsA}, 'utf8'));
      const b = window.CustomTabs.createTab(${jsB}, window.fs.readFileSync(${jsB}, 'utf8'));
      return { a: a.id, b: b.id };
    })()
  `);
  await sleep(500);

  const viewerText = () =>
    exec(`document.getElementById('viewer').textContent`);

  // ---- Scenario 1: the reported bug -------------------------------------
  // Both files change on disk. Refresh B, then refresh A, then switch back to
  // B. Before the fix, B reverted to BETA_V1.
  write(fileA, "# Alpha\n\nALPHA_V2\n");
  write(fileB, "# Beta\n\nBETA_V2\n");

  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(400);
  await exec(`window.ipcRenderer.send('reload-file', { filePath: ${jsB} }); null;`);
  await sleep(900);
  check(
    "refresh shows new content for B",
    (await viewerText()).includes("BETA_V2"),
    await viewerText(),
  );

  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(400);
  await exec(`window.ipcRenderer.send('reload-file', { filePath: ${jsA} }); null;`);
  await sleep(900);
  check(
    "refresh shows new content for A",
    (await viewerText()).includes("ALPHA_V2"),
    await viewerText(),
  );

  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  const backToB = await viewerText();
  check(
    "REGRESSION: B does not revert after refreshing A",
    backToB.includes("BETA_V2") && !backToB.includes("BETA_V1"),
    backToB,
  );

  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(700);
  const backToA = await viewerText();
  check(
    "REGRESSION: A stays refreshed after switching away and back",
    backToA.includes("ALPHA_V2") && !backToA.includes("ALPHA_V1"),
    backToA,
  );

  // ---- Scenario 2: auto-reload a background tab on switch ---------------
  write(fileB, "# Beta\n\nBETA_V3\n");
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  check(
    "switching to a tab auto-reloads changed file from disk",
    (await viewerText()).includes("BETA_V3"),
    await viewerText(),
  );

  // ---- Scenario 3: unsaved edits are never clobbered --------------------
  await exec(`
    (() => {
      const tabs = window.CustomTabs.getTabs();
      const b = tabs.find(t => t.id === ${ids.b});
      b.content = '# Beta\\n\\nUNSAVED_EDIT\\n';
      b.hasUnsavedChanges = true;
      return true;
    })()
  `);
  write(fileB, "# Beta\n\nBETA_V4\n");
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(400);
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  const afterUnsaved = await viewerText();
  check(
    "unsaved edits survive an on-disk change",
    afterUnsaved.includes("UNSAVED_EDIT") && !afterUnsaved.includes("BETA_V4"),
    afterUnsaved,
  );

  // ---- Scenario 3b: the edit base tracks what is on screen ---------------
  // renderer.js applies view-mode edits (notes, tables, checkboxes) as string
  // splices against originalMarkdown. If a switch seeds it with the on-disk
  // copy while rendering the unsaved copy, the next splice builds on the wrong
  // base and silently drops the earlier unsaved edit.
  const editBaseDirty = await exec("window.originalMarkdown");
  check(
    "edit base matches the rendered (unsaved) content on a dirty tab",
    editBaseDirty.includes("UNSAVED_EDIT") && !editBaseDirty.includes("BETA_V4"),
    editBaseDirty,
  );

  // A second view-mode edit must build on the first, not replace it.
  await exec(`
    (() => {
      window.originalMarkdown = window.originalMarkdown + '\\nSECOND_EDIT\\n';
      const tabs = window.CustomTabs.getTabs();
      const b = tabs.find(t => t.id === ${ids.b});
      b.content = window.originalMarkdown;
      return true;
    })()
  `);
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(400);
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  const editBaseAfter = await exec("window.originalMarkdown");
  check(
    "sequential view-mode edits both survive a tab round-trip",
    editBaseAfter.includes("UNSAVED_EDIT") &&
      editBaseAfter.includes("SECOND_EDIT"),
    editBaseAfter,
  );

  // ---- Scenario 4: scroll position is remembered across a refresh -------
  const longDoc = (marker) =>
    ["# Top", "", "x".repeat(50), ""]
      .concat(
        Array.from({ length: 40 }, (_, i) =>
          [`## Section ${i}`, "", `${marker} body ${i}`, "", "filler ".repeat(60), ""].join("\n"),
        ),
      )
      .join("\n");

  write(fileA, longDoc("V1"));
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(800);

  const scroller = `(document.querySelector('.content-wrapper').classList.contains('split-view') ? document.getElementById('viewer') : document.querySelector('.content-wrapper'))`;
  // An oracle must not reuse the formula it is judging. The implementation's
  // own offsetWithin() was, until this round, a raw
  // `rect.top - rect.top + scrollTop`, and so was this test - which is why the
  // suite could not see that the two terms are in different coordinate spaces
  // once #viewer carries a `zoom` (scrollTop is in the scroller's pre-zoom
  // pixels, rects are in viewport pixels). Derived independently here, from the
  // scroller's own border-box-to-padding-box ratio, so it agrees with the
  // implementation only if both are right.
  const offsetIn = (s, el) => `
    (() => {
      const s = ${s}, el = ${el};
      const cs = getComputedStyle(s);
      const borders = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      const local = s.clientHeight + borders;
      const scale = local ? s.getBoundingClientRect().height / local : 1;
      return (el.getBoundingClientRect().top - s.getBoundingClientRect().top) / (scale || 1) + s.scrollTop;
    })()
  `;
  const SECTION_25 = `Array.from(document.querySelectorAll('#viewer h2')).find(el => el.textContent.trim() === 'Section 25')`;
  await exec(`
    (() => {
      const s = ${scroller};
      s.scrollTop = ${offsetIn(scroller, SECTION_25)};
      return s.scrollTop;
    })()
  `);
  await sleep(200);
  const before = await exec(`${scroller}.scrollTop`);

  // Rewrite with extra content ABOVE the anchor: a raw pixel offset would now
  // point at the wrong place, a heading anchor should not.
  write(fileA, longDoc("V1").replace("# Top", "# Top\n\n" + "extra line\n\n".repeat(30)));
  await exec(`window.ipcRenderer.send('reload-file', { filePath: ${jsA} }); null;`);
  await sleep(1800);

  const after = await exec(`${scroller}.scrollTop`);
  const anchorTop = await exec(offsetIn(scroller, SECTION_25));
  check(
    "refresh keeps the reader at the same heading",
    Math.abs(after - anchorTop) < 40 && after > 0,
    `before=${before} after=${after} anchorTop=${anchorTop}`,
  );
  check(
    "refresh did not merely keep the raw pixel offset",
    Math.abs(after - before) > 40,
    `before=${before} after=${after}`,
  );
  // Deliberately NOT repeated at a second zoom level here. This scenario runs in
  // normal view, where the scroller is .content-wrapper - OUTSIDE the zoom
  // renderer.js applies to #viewer - so the scale is 1 at every zoom and a
  // zoomed pass would assert nothing new. The non-vacuous case is split view,
  // where the scroller IS the zoomed element; that is scenario 5c2z below, and
  // it exercises this same captureAnchor/resolveAnchorTop pair because refresh
  // and tab-switch share them.

  // ---- Scenario 5: the "File Updated" prompt ----------------------------
  // Actively-viewed tab: we deliberately do NOT auto-reload (that would yank
  // the document out from under the reader), so the actionable prompt must
  // still appear, and acting on it must not resurrect the revert bug.
  const promptShown = () =>
    exec(
      `!!document.getElementById('fileUpdateToast') && document.getElementById('fileUpdateToast').classList.contains('show')`,
    );

  write(fileA, "# Alpha\n\nALPHA_V9\n");
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(900);
  await exec(`window.dismissFileUpdateNotification(); null;`);

  // Change the file the user is currently looking at.
  write(fileA, "# Alpha\n\nALPHA_V10\n");
  await sleep(2200);
  check(
    "actively-viewed tab still gets the actionable update prompt",
    await promptShown(),
    "toast not shown",
  );

  // Acting on the prompt must load the new content...
  await exec(`document.getElementById('reloadFileBtn').click(); null;`);
  await sleep(1200);
  check(
    "prompt Reload loads the new content",
    (await viewerText()).includes("ALPHA_V10"),
    await viewerText(),
  );
  check(
    "prompt is dismissed after acting on it",
    (await promptShown()) === false,
    "toast still shown",
  );

  // ...and must survive a tab round-trip (the original bug).
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(400);
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(700);
  check(
    "REGRESSION: prompt-triggered reload does not revert on tab switch",
    (await viewerText()).includes("ALPHA_V10"),
    await viewerText(),
  );

  // A prompt raised for the visible tab is stale once we move away: the
  // background tab is reloaded silently instead, so the ask-to-reload toast
  // must be taken down rather than left pointing at another document.
  write(fileA, "# Alpha\n\nALPHA_V11\n");
  await sleep(2200);
  check(
    "prompt appears again for the visible tab",
    await promptShown(),
    "toast not shown",
  );
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  check(
    "switching tabs dismisses the stale update prompt",
    (await promptShown()) === false,
    "toast still shown after switch",
  );

  // Coming back auto-reloads silently: fresh content, no actionable prompt.
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(900);
  const afterAuto = await viewerText();
  check(
    "auto-reload on switch picks up the change without prompting",
    afterAuto.includes("ALPHA_V11") && (await promptShown()) === false,
    afterAuto,
  );

  // The prompt's Reload button must not silently discard unsaved edits the
  // way upstream's inline onclick="reloadCurrentFile()" does.
  check(
    "prompt Reload button is rebound to the guarded handler",
    (await exec(
      `document.getElementById('reloadFileBtn').onclick && document.getElementById('reloadFileBtn').onclick.name`,
    )) === "reloadFromUpdatePrompt",
    await exec(
      `String(document.getElementById('reloadFileBtn').onclick && document.getElementById('reloadFileBtn').onclick.name)`,
    ),
  );

  // Same for Dismiss. Its inline onclick was removed for SEC-09 (no inline
  // handlers under the new CSP) and rebound in custom-tabs.js, which made this
  // a silently-untested path: a click that no longer reaches
  // dismissFileUpdateNotification() leaves the toast on screen until the
  // 10-second auto-hide, and nothing else in the suite would notice. Driven
  // through a real click on the real element, not by calling the function.
  const dismissState = await exec(`
    (() => {
      const btn = document.getElementById('dismissFileUpdateBtn');
      const toast = document.getElementById('fileUpdateToast');
      if (!btn || !toast) return { missing: true, btn: !!btn, toast: !!toast };
      toast.classList.add('show');
      window.__dismissProbe = 0;
      const orig = window.dismissFileUpdateNotification;
      window.dismissFileUpdateNotification = function () {
        window.__dismissProbe += 1;
        return orig.apply(this, arguments);
      };
      try {
        btn.click();
      } finally {
        window.dismissFileUpdateNotification = orig;
      }
      return {
        bound: typeof btn.onclick === 'function',
        calls: window.__dismissProbe,
        visible: toast.classList.contains('show'),
      };
    })()
  `);
  check(
    "prompt Dismiss button is bound and really dismisses the toast",
    dismissState.bound === true &&
      dismissState.calls === 1 &&
      dismissState.visible === false,
    JSON.stringify(dismissState),
  );


  write(fileA, "# Alpha\n\nALPHA_V12\n");
  await sleep(2200);
  const promptBeforeDecline = await promptShown();

  await exec(`
    (() => {
      const tabs = window.CustomTabs.getTabs();
      const a = tabs.find(t => t.id === ${ids.a});
      a.content = '# Alpha\\n\\nDIRTY_EDIT\\n';
      a.hasUnsavedChanges = true;
      window.originalMarkdown = a.content;
      window.__confirmCalls = 0;
      window.__realConfirm = window.confirm;
      window.confirm = () => { window.__confirmCalls++; return false; };
      return true;
    })()
  `);
  await exec(`document.getElementById('reloadFileBtn').click(); null;`);
  await sleep(900);
  check(
    "declining the Reload confirmation keeps unsaved edits",
    (await exec(`window.__confirmCalls`)) === 1 &&
      (await exec(`window.originalMarkdown`)).includes("DIRTY_EDIT"),
    `confirmCalls=${await exec(`window.__confirmCalls`)}`,
  );
  // Backing out of the confirmation is not the same as pressing Dismiss: the
  // file is still stale, so the only route back to it must remain on screen.
  check(
    "declining the Reload confirmation leaves the prompt up",
    promptBeforeDecline === true && (await promptShown()) === true,
    `before=${promptBeforeDecline} after=${await promptShown()}`,
  );

  await exec(`window.confirm = () => { window.__confirmCalls++; return true; }; null;`);
  await exec(`document.getElementById('reloadFileBtn').click(); null;`);
  await sleep(1200);
  const afterAccept = await viewerText();
  await exec(`window.confirm = window.__realConfirm; null;`);
  check(
    "accepting the Reload confirmation loads from disk",
    afterAccept.includes("ALPHA_V12"),
    afterAccept,
  );

  // ---- Scenario 5b: prompt bookkeeping is reset, not just hidden ---------
  // renderer.js guards showFileUpdateNotification() with a module-level
  // `fileUpdateNotificationShown` flag. If dismissing only hid the DOM without
  // resetting that flag, the NEXT file change would be silently swallowed for
  // up to 10s. This asserts the real resetter is reachable and is actually
  // being used.
  check(
    "renderer's dismissFileUpdateNotification is reachable as a global",
    (await exec(`typeof window.dismissFileUpdateNotification`)) === "function",
    await exec(`typeof window.dismissFileUpdateNotification`),
  );

  // B is still dirty from scenario 3; a dirty tab is never watched or
  // prompted, so clean it before using it as the prompt target.
  await exec(`
    (() => {
      const b = window.CustomTabs.getTabs().find(t => t.id === ${ids.b});
      b.content = b.originalContent;
      b.hasUnsavedChanges = false;
      return true;
    })()
  `);

  await exec(`window.dismissFileUpdateNotification(); null;`);
  write(fileA, "# Alpha\n\nALPHA_V14\n");
  await sleep(2200);
  const promptedForA = await promptShown();

  // Switch away well inside renderer's 10s auto-dismiss window, so the flag is
  // only cleared if our dismiss path actually resets it.
  await exec(`window.CustomTabs.switchToTab(${ids.b}); null;`);
  await sleep(700);
  write(fileB, "# Beta\n\nBETA_V14\n");
  await sleep(2400);
  check(
    "a dismissed prompt does not suppress the next tab's prompt",
    promptedForA === true && (await promptShown()) === true,
    `promptedForA=${promptedForA} promptedForB=${await promptShown()}`,
  );

  // ---- Scenario 5c: a slow reload render must not outlive its context -----
  // renderMarkdown() is async (diagrams can take seconds), so the user can act
  // before a reload settles. The completion must not clear the unsaved flag or
  // restore scroll for a document it no longer owns.
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(900);
  await exec(`window.dismissFileUpdateNotification(); null;`);

  // (i) Edited while the reload render was in flight.
  await exec(`
    (() => {
      window.ipcRenderer.emit('file-reload-result', {}, {
        success: true,
        path: ${jsA},
        content: '# Alpha\\n\\nRELOADED_BODY\\n',
      });
      // Simulate a view-mode edit landing during the async render.
      window.originalMarkdown = '# Alpha\\n\\nTYPED_DURING_RELOAD\\n';
      return true;
    })()
  `);
  await sleep(1600);
  const afterRace = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      return { content: a.content, dirty: a.hasUnsavedChanges };
    })()
  `);
  check(
    "edits made during a reload render are not silently marked saved",
    afterRace.content.includes("TYPED_DURING_RELOAD") && afterRace.dirty === true,
    JSON.stringify(afterRace),
  );

  // (ii) Switched tabs while the reload render was in flight.
  await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      a.content = a.originalContent;
      a.hasUnsavedChanges = false;
      window.originalMarkdown = a.originalContent;

      const b = window.CustomTabs.getTabs().find(t => t.id === ${ids.b});
      b.content = '# Beta\\n\\nB_UNSAVED\\n';
      b.hasUnsavedChanges = true;

      window.__unsavedCalls = [];
      const real = window.setUnsavedState;
      window.setUnsavedState = (v) => { window.__unsavedCalls.push(!!v); return real(v); };

      window.ipcRenderer.emit('file-reload-result', {}, {
        success: true,
        path: ${jsA},
        content: '# Alpha\\n\\nRELOAD_RACE\\n',
      });
      window.CustomTabs.switchToTab(${ids.b});
      return true;
    })()
  `);
  await sleep(1600);
  const afterSuperseded = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      const b = window.CustomTabs.getTabs().find(t => t.id === ${ids.b});
      return {
        unsavedCalls: window.__unsavedCalls,
        aContent: a.content,
        bContent: b.content,
        bDirty: b.hasUnsavedChanges,
      };
    })()
  `);
  check(
    "a superseded reload does not clear the newly active tab's unsaved state",
    afterSuperseded.bDirty === true &&
      afterSuperseded.bContent.includes("B_UNSAVED") &&
      !(
        afterSuperseded.unsavedCalls.length &&
        afterSuperseded.unsavedCalls[afterSuperseded.unsavedCalls.length - 1] ===
          false
      ),
    JSON.stringify(afterSuperseded),
  );
  // Without the generation/tab guard the completion falls into the
  // "edited during reload" branch and writes the NEW tab's live text into the
  // OLD tab's cache - silent cross-tab content corruption.
  check(
    "a superseded reload does not write the new tab's text into the old tab",
    !afterSuperseded.aContent.includes("B_UNSAVED"),
    JSON.stringify({ aContent: afterSuperseded.aContent }),
  );

  // ---- Scenario 5e: CRLF files are not falsely reported as edited --------
  // A <textarea> normalises CRLF to LF on assignment, so renderer's
  // `markdownEditor.value = data.content` silently rewrites the line endings.
  // Comparing the live editor text against the raw `data.content` would then
  // report every Windows-line-ending file as edited on every reload, with no
  // user input at all - permanently dirtying the tab (which also pauses its
  // file watcher) and converting the file to LF on the next save.
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(700);
  await exec(`window.dismissFileUpdateNotification(); null;`);
  const crlfContent = "# Alpha\r\n\r\nCRLF_BODY\r\n";
  const afterCrlf = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      a.content = a.originalContent;
      a.hasUnsavedChanges = false;
      window.originalMarkdown = a.content;

      // Force the edit-mode branch of renderer's reload handler.
      window.isEditMode = true;
      if (!window.markdownEditor) {
        window.markdownEditor = document.getElementById('markdownEditor');
      }
      window.ipcRenderer.emit('file-reload-result', {}, {
        success: true,
        path: ${jsA},
        content: ${JSON.stringify(crlfContent)},
      });
      return true;
    })()
  `);
  await sleep(1600);
  const crlfState = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      window.isEditMode = false;
      return {
        dirty: a.hasUnsavedChanges,
        synced: a.content === a.originalContent,
        hasCr: a.content.indexOf('\\r') !== -1,
      };
    })()
  `);
  check(
    "a CRLF file is not falsely marked edited by its own reload",
    crlfState.dirty !== true && crlfState.synced === true,
    JSON.stringify(crlfState),
  );

  // Same class, different path: switchToTab writes tab.content into the
  // textarea (normalising CRLF->LF) and snapshotActiveTab reads it back out.
  // Switching or closing while in edit mode, with zero edits, must not mark
  // the tab dirty - and must not rewrite the cached document to LF, or the
  // next save silently converts the user's file.
  const crlfSnapshot = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      a.content = ${JSON.stringify(crlfContent)};
      a.originalContent = ${JSON.stringify(crlfContent)};
      a.hasUnsavedChanges = false;
      window.originalMarkdown = a.content;
      window.isEditMode = true;
      if (!window.markdownEditor) {
        window.markdownEditor = document.getElementById('markdownEditor');
      }
      window.markdownEditor.value = a.content;

      window.CustomTabs.switchToTab(${ids.b});
      const after = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      window.isEditMode = false;
      return {
        dirty: after.hasUnsavedChanges,
        keptCrlf: after.content.indexOf('\\r\\n') !== -1,
      };
    })()
  `);
  check(
    "leaving edit mode on a CRLF file does not dirty it or strip its endings",
    crlfSnapshot.dirty !== true && crlfSnapshot.keptCrlf === true,
    JSON.stringify(crlfSnapshot),
  );
  await sleep(800);
  await exec(`
    (() => {
      window.CustomTabs.getTabs().forEach(t => {
        t.content = t.originalContent;
        t.hasUnsavedChanges = false;
      });
      window.CustomTabs.switchToTab(${ids.a});
      window.dismissFileUpdateNotification();
      return true;
    })()
  `);
  await sleep(800);

  // ---- Scenario 5c2: reading position survives a tab switch in REAL split
  // view. Every other edit-mode scenario here only flips `window.isEditMode`,
  // which never applies the `split-view` class and so never exercises the CSS
  // that decides which element actually scrolls. That gap hid a real defect:
  // when #viewer stopped being a scroller, getScroller() still returned it, so
  // save and restore both operated on a node whose scrollTop is permanently 0
  // and the position was silently lost on every switch while editing.
  // Write to disk first, then reload: setting tab.content alone would leave the
  // cached document disagreeing with the file and trip the file-updated prompt,
  // whose native dialog blocks executeJavaScript forever.
  write(fileA, longDoc("SPLIT"));
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(500);
  await exec(`window.ipcRenderer.send('reload-file', { filePath: ${jsA} }); null;`);
  await sleep(1500);
  await exec(`window.dismissFileUpdateNotification && window.dismissFileUpdateNotification(); null;`);
  await sleep(300);

  const splitScroll = await exec(`
    (async () => {
      await new Promise(r => setTimeout(r, 200));
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 600));
      const wrapper = document.querySelector('.content-wrapper');
      const inSplit = wrapper.classList.contains('split-view');
      const s = window.CustomTabs.__getScroller
        ? window.CustomTabs.__getScroller()
        : document.getElementById('viewer');
      // Prove the chosen element is the one that genuinely scrolls, rather
      // than asserting against whatever the implementation happens to pick.
      const oy = getComputedStyle(s).overflowY;
      const canScroll = s.scrollHeight > s.clientHeight + 1;
      s.scrollTop = 400;
      await new Promise(r => setTimeout(r, 100));
      const parked = s.scrollTop;

      window.CustomTabs.switchToTab(${ids.b});
      await new Promise(r => setTimeout(r, 700));
      window.CustomTabs.switchToTab(${ids.a});
      await new Promise(r => setTimeout(r, 900));

      const s2 = window.CustomTabs.__getScroller
        ? window.CustomTabs.__getScroller()
        : document.getElementById('viewer');
      const restored = s2.scrollTop;
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 500));
      return {
        inSplit,
        scrollerId: s.id || s.className,
        overflowY: oy,
        canScroll,
        parked,
        restored,
      };
    })()
  `);
  check(
    "the split-view scroll test really entered split view on a scrollable pane",
    splitScroll.inSplit === true &&
      /^(auto|scroll)$/.test(splitScroll.overflowY) &&
      splitScroll.canScroll === true &&
      splitScroll.parked > 100,
    JSON.stringify(splitScroll),
  );
  check(
    "reading position survives a tab switch in split view",
    Math.abs(splitScroll.restored - splitScroll.parked) < 80,
    JSON.stringify(splitScroll),
  );
  await sleep(400);

  // ---- Scenario 5c2z: reading position survives a tab switch in split view
  // WHILE ZOOMED. 5c2 above proves the right ELEMENT is used; it cannot see a
  // coordinate-space error, because at 100% zoom the scroller's own pixels and
  // viewport pixels are the same thing. offsetWithin() converts a viewport-pixel
  // rect delta into the scroller's space, and in split view the scroller is
  // #viewer, which is the element renderer.js puts `zoom` on. Without the
  // conversion the remembered delta is scaled by the zoom factor and the reader
  // is dropped somewhere else entirely on every tab switch.
  const zoomScroll = await exec(`
    (async () => {
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 600));
      zoomLevel = 200;
      updateZoom();
      await new Promise(r => setTimeout(r, 400));
      const s = window.CustomTabs.__getScroller();
      // Guard: this only measures anything if the scroller really is the
      // zoomed element. If a future change moves the scroller back outside the
      // zoom, the conversion becomes a no-op and this scenario is vacuous.
      const zoomed = parseFloat(getComputedStyle(s).zoom) || 1;
      s.scrollTop = 400;
      await new Promise(r => setTimeout(r, 150));
      const parked = s.scrollTop;

      window.CustomTabs.switchToTab(${ids.b});
      await new Promise(r => setTimeout(r, 700));
      window.CustomTabs.switchToTab(${ids.a});
      await new Promise(r => setTimeout(r, 900));

      const restored = window.CustomTabs.__getScroller().scrollTop;
      zoomLevel = 100;
      updateZoom();
      await new Promise(r => setTimeout(r, 300));
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 500));
      return { zoomed, scrollerId: s.id || s.className, parked, restored };
    })()
  `);
  check(
    "the zoomed split-view scroll test really ran on the zoomed scroller",
    zoomScroll.zoomed === 2 && zoomScroll.parked > 100,
    JSON.stringify(zoomScroll),
  );
  check(
    "reading position survives a tab switch in split view while zoomed",
    Math.abs(zoomScroll.restored - zoomScroll.parked) < 80,
    JSON.stringify(zoomScroll),
  );
  await sleep(400);

  // ---- Scenario 5c3: undo keeps the reading position in REAL split view.
  // historyUndo/historyRedo save and restore contentWrapper.scrollTop
  // unconditionally, in BOTH the edit-mode and view-mode branches, and in
  // split view .content-wrapper is `overflow: hidden` so its scrollTop is
  // permanently 0. A reviewer predicted from that reading that the preview
  // would snap to the top on every undo while editing. It does not: the
  // measured result is parked=900, restored=900 on a document that genuinely
  // shrank by 60 paragraphs ABOVE the reading position. The position survives
  // because `undoRedoRendering` suppresses the only scrollTop reset in the
  // render path and patchViewerDOM keeps the surrounding nodes, so nothing
  // moves it in the first place. The contentWrapper save/restore is therefore
  // dead code in split view rather than a defect - and this scenario exists so
  // that if anyone ever removes the undoRedoRendering guard, the symptom the
  // reviewer described shows up as a failure instead of a bug report.
  const undoScroll = await exec(`
    (async () => {
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 700));
      const inSplit = document
        .querySelector('.content-wrapper')
        .classList.contains('split-view');
      // The rendered document must actually CHANGE across the undo, or the
      // scenario proves nothing: assigning markdownEditor.value does not
      // render, so pushing a state and undoing it would re-render the very
      // same document and the scroll offset would trivially survive.
      // So: render the LONG version, park the reader deep inside it, then undo
      // back to the short one. That removes content above the reading position
      // and is the case most likely to move the scroll offset.
      const shortDoc = markdownEditor.value;
      const longDoc = 'inserted paragraph.\\n\\n'.repeat(60) + shortDoc;
      historyPush(shortDoc);
      markdownEditor.value = longDoc;
      await renderMarkdown(longDoc);
      await new Promise(r => setTimeout(r, 400));

      const s = getViewerScroller();
      const canScroll = s.scrollHeight > s.clientHeight + 1;
      s.scrollTop = 900;
      await new Promise(r => setTimeout(r, 120));
      const parked = s.scrollTop;

      historyUndo();
      await new Promise(r => setTimeout(r, 1400));

      const restored = getViewerScroller().scrollTop;
      document.getElementById('toggleEdit').click();
      await new Promise(r => setTimeout(r, 500));
      return {
        inSplit,
        canScroll,
        parked,
        restored,
        scroller: s.id || s.className,
      };
    })()
  `);
  check(
    "the undo scroll test really entered split view on a scrollable pane",
    undoScroll.inSplit === true &&
      undoScroll.canScroll === true &&
      undoScroll.parked > 100,
    JSON.stringify(undoScroll),
  );
  check(
    "undo keeps the reading position in split view",
    Math.abs(undoScroll.restored - undoScroll.parked) < 80,
    JSON.stringify(undoScroll),
  );
  await sleep(400);

  write(fileM, "graph TD;\n  A-->B;\n");
  const mermaidTab = await exec(`
    (() => {
      const t = window.CustomTabs.createTab(${jsM}, '\\u0060\\u0060\\u0060mermaid\\ngraph TD;\\n  A-->B;\\n\\u0060\\u0060\\u0060');
      return t.id;
    })()
  `);
  await sleep(400);
  write(fileM, "graph TD;\n  A-->C;\n");
  await exec(`window.CustomTabs.switchToTab(${mermaidTab}); null;`);
  await sleep(1200);
  const afterMermaid = await exec(`
    (() => {
      const t = window.CustomTabs.getTabs().find(t => t.id === ${mermaidTab});
      return {
        content: t.content,
        dirty: t.hasUnsavedChanges,
        synced: t.content === t.originalContent,
      };
    })()
  `);
  check(
    "a refreshed .mmd tab keeps its mermaid fence and stays clean",
    afterMermaid.content.includes("```mermaid") &&
      afterMermaid.content.includes("A-->C") &&
      afterMermaid.dirty !== true &&
      afterMermaid.synced === true,
    JSON.stringify(afterMermaid),
  );
  await exec(`
    (() => {
      const t = window.CustomTabs.getTabs().find(t => t.id === ${mermaidTab});
      t.content = t.originalContent;
      t.hasUnsavedChanges = false;
      window.originalMarkdown = t.content;
      window.CustomTabs.closeTab(${mermaidTab});
      return true;
    })()
  `);
  await sleep(400);

  // ---- Scenario 6: closing tabs leaves no stale watcher / cache ---------
  await exec(`window.CustomTabs.switchToTab(${ids.a}); null;`);
  await sleep(500);

  // A save result that lands after its tab was closed must not be applied to
  // whichever tab happens to be active now.
  const beforeStray = await exec(`
    (() => {
      const a = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      a.content = '# Alpha\\n\\nSTRAY_GUARD\\n';
      a.hasUnsavedChanges = true;
      window.originalMarkdown = a.content;
      window.ipcRenderer.emit('save-markdown-result', {}, {
        success: true,
        path: ${JSON.stringify(path.join(dir, "gone.md"))},
      });
      const after = window.CustomTabs.getTabs().find(t => t.id === ${ids.a});
      return { content: after.content, dirty: after.hasUnsavedChanges };
    })()
  `);
  check(
    "save result for a closed tab does not clobber the active tab",
    beforeStray.content.includes("STRAY_GUARD") && beforeStray.dirty === true,
    JSON.stringify(beforeStray),
  );

  // Visual smoke: the assertions above all read state the code believes it has
  // rendered. None of them would notice the tab bar being covered by an
  // overlay, collapsed to zero height, or pushed off screen - which is exactly
  // how a tab bug looks to a user. Assert the pixels-level facts directly.
  // See test-visual-utils.js for why this is a DOM probe and not a pixel diff.
  // inspectVisual installs the probe itself, so no separate injection here.
  const tabsVisual = await inspectVisual(win, ".tab", {
    minWidth: 20,
    minHeight: 10,
  });
  check(
    "every open tab is rendered, on screen, unoccluded and unclipped",
    tabsVisual.count >= 1 && tabsVisual.soundCount === tabsVisual.count,
    JSON.stringify({ count: tabsVisual.count, unsound: tabsVisual.unsound }),
  );

  const viewerVisual = await inspectVisual(win, "#viewer", {
    minWidth: 200,
    minHeight: 100,
  });
  check(
    "the document viewer is rendered, on screen and unoccluded",
    viewerVisual.count === 1 && viewerVisual.soundCount === 1,
    JSON.stringify(viewerVisual.unsound),
  );

  // ---- Scenario 6b: a superseded render must not strand the overlay ------
  // renderMarkdownFull() opens with showLoadingScreen() and hides it at the
  // very end. It also bails out mid-way if a newer render has started, and that
  // bail-out used to `return` without hiding - so the full-screen,
  // click-blocking overlay stayed up forever.
  //
  // This is not a hypothetical: it fired on the ordinary startup path. Restoring
  // a tab began a full render, a second render superseded it, and the winner
  // took the light-format path which neither shows nor hides the overlay. The
  // app booted to a permanent "Loading..." screen with the document invisible
  // behind it - which is precisely what the visual probe above reported before
  // the fix, naming loadingScreen as the occluder.
  //
  // Supersession is forced directly rather than hoped for: two renders are
  // started in the same turn, so the first is guaranteed to be stale by the
  // time it reaches the bail-out.
  //
  // The winner MUST be a light-format render. Two overlapping 'full' renders
  // would not reproduce the bug - the winner would hide the overlay itself and
  // the loser's missing hide would be invisible. Only the full-superseded-by-
  // light ordering leaves nobody responsible for hiding it, which is exactly
  // the ordering the startup path produces.
  //
  // That ordering is only real if renderMarkdown actually takes the light path.
  // It falls back to a FULL render when _lastRenderedContent is null (see
  // renderer.js renderMarkdown), and two full renders would silently restore the
  // vacuous version of this test - it would pass with the fix reverted. Assert
  // the precondition locally rather than trusting scenario ordering.
  const lightPathAvailable = await exec(`_lastRenderedContent !== null`);
  check(
    "the light-format path is reachable, so this scenario is not vacuous",
    lightPathAvailable === true,
    "_lastRenderedContent is null; renderMarkdown would fall back to a full render",
  );
  await exec(`
    (() => {
      renderMarkdown('# Superseded render\\n\\nfirst', 'full');
      renderMarkdown('# Winning render\\n\\nsecond', 'light-format');
      return true;
    })()
  `);
  const overlayState = await waitForCondition(
    exec,
    `(() => {
       const el = document.getElementById('loadingScreen');
       return el && !el.classList.contains('active');
     })()`,
    8000,
  );
  check(
    "a superseded render does not leave the loading overlay up",
    overlayState === true,
    JSON.stringify(
      await exec(
        `({ active: document.getElementById('loadingScreen').classList.contains('active'),
            viewer: document.getElementById('viewer').textContent.slice(0, 40) })`,
      ),
    ),
  );

  // And the overlay must not be covering anything even when it is inactive.
  const overlayVisual = await inspectVisual(win, "#viewer", {
    minWidth: 200,
    minHeight: 100,
  });
  check(
    "the viewer is still unoccluded after overlapping renders",
    overlayVisual.count === 1 && overlayVisual.soundCount === 1,
    JSON.stringify(overlayVisual.unsound),
  );

  // ---- Scenario 6c: the overlay is owned, not shared ---------------------
  // Hiding on the way out of a superseded render is only half correct. If the
  // render that superseded it is ALSO a full render, it is still working, and a
  // loser that hides unconditionally would uncover a half-built document - the
  // overlay would drop on the FIRST completion instead of the last.
  //
  // Ownership makes both directions right, so assert both here: the loser must
  // stay quiet while a newer full render owns the overlay, and the overlay must
  // still come down once that winner finishes.
  const ownership = await exec(`
    (() => {
      const el = document.getElementById('loadingScreen');
      renderMarkdown('# Loser\\n\\n' + 'aaa '.repeat(200), 'full');
      renderMarkdown('# Winner\\n\\n' + 'bbb '.repeat(400), 'full');
      return { shownAtStart: el.classList.contains('active') };
    })()
  `);
  check(
    "two overlapping full renders raise the overlay",
    ownership.shownAtStart === true,
    JSON.stringify(ownership),
  );

  // The loser reaches its bail-out well before the winner finishes, but sampling
  // "mid-flight" by wall clock would be a flaky race. Assert the invariant that
  // actually protects the winner instead: a stale generation must not be able to
  // take the overlay down. This is deterministic and fails loudly if the
  // ownership check is removed or weakened.
  const staleCannotHide = await exec(`
    (() => {
      const el = document.getElementById('loadingScreen');
      const before = el.classList.contains('active');
      hideLoadingScreenFor(-1);      // a generation that never owned it
      const afterStale = el.classList.contains('active');
      hideLoadingScreenFor(0);       // the "nobody owns it" sentinel
      const afterSentinel = el.classList.contains('active');
      return { before, afterStale, afterSentinel };
    })()
  `);
  check(
    "a superseded render cannot take the overlay away from the current one",
    staleCannotHide.before === true &&
      staleCannotHide.afterStale === true &&
      staleCannotHide.afterSentinel === true,
    JSON.stringify(staleCannotHide),
  );

  const settled = await waitForCondition(
    exec,
    `(() => {
       const el = document.getElementById('loadingScreen');
       return el && !el.classList.contains('active');
     })()`,
    8000,
  );
  check(
    "the winning full render still clears the overlay when it finishes",
    settled === true,
    JSON.stringify(staleCannotHide),
  );
  check(
    "the winner ends up owning the rendered document",
    (await exec(`document.getElementById('viewer').textContent.includes('Winner')`)) === true,
    await exec(`document.getElementById('viewer').textContent.slice(0, 30)`),
  );

  // ---- Scenario 6d: the idle callback must carry a deadline --------------
  // The winning render hides the overlay from inside a requestIdleCallback. A
  // bare requestIdleCallback has NO deadline - the browser may defer it
  // indefinitely on a page that never goes idle, which would strand the overlay
  // for the winner in the same way the missing hide stranded it for the loser.
  // The {timeout} option is what bounds that, so assert it is actually passed.
  // The deadline itself is enforced by the browser, not by this code, so the
  // passing of the option IS the contract worth checking here.
  await exec(`
    (() => {
      const real = window.requestIdleCallback;
      window.__idleSeen = [];
      window.requestIdleCallback = function (cb, opts) {
        window.__idleSeen.push(opts || null);
        return real.call(window, cb, opts);
      };
      window.__restoreIdle = () => { window.requestIdleCallback = real; };
      renderMarkdown('# Idle deadline\\n\\nbody text', 'full');
      return true;
    })()
  `);
  await waitForCondition(
    exec,
    `(() => {
       const el = document.getElementById('loadingScreen');
       return el && !el.classList.contains('active');
     })()`,
    8000,
  );
  const idleSeen = await exec(`window.__idleSeen`);
  await exec(`(window.__restoreIdle(), true)`);
  check(
    "the render's idle callback is given a timeout so the overlay cannot be stranded",
    Array.isArray(idleSeen) &&
      idleSeen.length > 0 &&
      idleSeen.every((o) => o && typeof o.timeout === "number" && o.timeout > 0),
    JSON.stringify(idleSeen),
  );

  // Closing every tab must disarm the watcher, so an external change cannot
  // raise a "reload?" prompt over the welcome screen. Clear the dirty state
  // left by earlier scenarios first - closeTab() on a dirty tab raises a
  // native confirm() that would block the run indefinitely.
  await exec(`
    (() => {
      window.CustomTabs.getTabs().forEach(t => {
        t.content = t.originalContent;
        t.hasUnsavedChanges = false;
      });
      // closeTab() re-derives dirtiness from originalMarkdown, so it has to
      // agree with the active tab or the teardown raises a native confirm()
      // and blocks the run.
      const active = window.CustomTabs.getActiveTab && window.CustomTabs.getActiveTab();
      window.originalMarkdown = active ? active.originalContent : '';
      window.CustomTabs.getTabs().slice().forEach(t => window.CustomTabs.closeTab(t.id));
      window.dismissFileUpdateNotification();
      return window.CustomTabs.getTabs().length;
    })()
  `);
  await sleep(400);
  // Write to the file the watcher was last armed on (the last tab closed),
  // otherwise no change event fires at all and the check proves nothing.
  write(fileB, "# Beta\n\nBETA_V13\n");
  await sleep(2200);
  check(
    "closing the last tab leaves no watcher raising prompts",
    (await promptShown()) === false,
    "toast shown with no tabs open",
  );

  // ---- Scenario 6: saving in view mode writes the persisted document -----
  // A CONTRACT test, not a user journey, and the distinction is deliberate.
  //
  // In view mode the textarea is not the source of truth: `originalMarkdown`
  // is what file-opened, file-reload-result and switchToTab write, and those
  // paths touch the textarea only when isEditMode is true. historyUndo /
  // historyRedo likewise update only `originalMarkdown` when isEditMode is
  // false (renderer.js:961, :988). So in view mode the textarea can hold a
  // previous tab's content, a previous file's content, or an undone edit.
  //
  // No shipping UI on this branch reaches saveMarkdownFile() in view mode -
  // Ctrl+S is gated on isEditMode and the save button is in the edit-mode-only
  // header - so this scenario calls it directly and asserts the contract. That
  // is worth pinning because upstream's ef81474 adds a view-mode save trigger,
  // and because the wrong behaviour here is silent data loss rather than a
  // visible error. The undo route is used to create the divergence because it
  // is the cheapest one that uses only the app's own functions.
  //
  // Driven through historyPush / historyUndo / saveMarkdownFile, and checked
  // against the bytes on disk and the in-memory document - never against the
  // implementation's own choice of store.
  // The preceding scenario deliberately closes every tab, so a tab has to be
  // reopened here - otherwise saveMarkdownFile() takes its no-file-open branch
  // and raises a blocking alert instead of saving.
  const tabC = await exec(`
    (() => {
      const t = window.CustomTabs.createTab(${jsA}, window.fs.readFileSync(${jsA}, 'utf8'));
      window.CustomTabs.switchToTab(t.id);
      return t.id;
    })()
  `);
  await sleep(600);
  const undoSave = await exec(`
    (async () => {
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 300));
      // Make the undo stack local to this scenario. Without it the assertions
      // below depend on whatever every preceding scenario left on the stack,
      // which is a global invariant masquerading as a local one.
      historyClear();
      window.originalMarkdown = '# Alpha\\n\\nV_ONSCREEN\\n';
      markdownEditor.value = window.originalMarkdown;
      historyPush(window.originalMarkdown);
      // A view-mode edit: both stores move together, as the edit paths do.
      window.originalMarkdown = '# Alpha\\n\\nV_EDITED\\n';
      markdownEditor.value = window.originalMarkdown;
      // Ctrl+Z in view mode moves originalMarkdown back and leaves the
      // textarea holding V_EDITED. This is the app's own code, not the test's.
      historyUndo();
      await new Promise(r => setTimeout(r, 600));
      return JSON.stringify({
        editMode: isEditMode,
        hasPath: !!currentFilePath,
        onScreen: window.originalMarkdown.includes('V_ONSCREEN'),
        editorStale: markdownEditor.value.includes('V_EDITED'),
      });
    })()
  `);
  const undoState = JSON.parse(undoSave);
  // Vacuity guard: if the two stores had not actually diverged, saving either
  // one would write the same bytes and the assertion below could not fail.
  // hasPath is part of the guard because saveMarkdownFile() silently does
  // nothing useful without a current file.
  check(
    "a view-mode undo really does leave the editor holding different content",
    undoState.editMode === false &&
      undoState.hasPath === true &&
      undoState.onScreen === true &&
      undoState.editorStale === true,
    undoSave,
  );

  await exec(`saveMarkdownFile(); null;`);
  await sleep(900);
  const onDisk = fs.readFileSync(fileA, "utf8");
  check(
    "saving in view mode writes the content on screen, not a stale editor buffer",
    onDisk.includes("V_ONSCREEN") && !onDisk.includes("V_EDITED"),
    onDisk,
  );
  // The second half of the same defect: the save-result handler used to copy
  // the stale editor value back over originalMarkdown, so the undo was lost
  // in memory as well and came back on the next render.
  const afterSave = await exec(`window.originalMarkdown`);
  check(
    "a successful view-mode save does not overwrite the in-memory document",
    afterSave.includes("V_ONSCREEN") && !afterSave.includes("V_EDITED"),
    afterSave,
  );

  // ---- Scenario 7: exiting edit mode discards, and warns that it will ----
  // Measured bug, three clicks, silent: type in edit mode, click Exit, accept
  // the confirm, and the app left the editor buffer holding the typing, the
  // dirty flag true, the preview showing the typed text, and `originalMarkdown`
  // still on the last saved content. Re-entering edit mode then reset the
  // textarea from `originalMarkdown` and cleared the dirty flag, so the typing
  // was destroyed, the app reported "clean", and the preview went on showing
  // text no store held.
  //
  // The user's decision: discard, because there is no way to save from view
  // mode, and say so in the warning. So the discard must actually happen and
  // must be complete - including the undo entries the session pushed, or Ctrl+Z
  // hands the discarded text straight back with no dirty indicator.
  //
  // Deliberately checked here: the rollback is SURGICAL. An undo point made
  // before the edit session must survive it.
  const discardOut = await exec(`
    (async () => {
      const seen = [];
      const realConfirm = window.confirm;
      window.confirm = (msg) => { seen.push(String(msg)); return true; };
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 600));
      historyClear();
      historyPush('# Alpha\\n\\nS7_OLD_UNDO_POINT\\n');
      window.originalMarkdown = '# Alpha\\n\\nS7_SAVED\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Alpha\\n\\nS7_EARLY\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1400));
      markdownEditor.value = '# Alpha\\n\\nS7_TYPED\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 3600));
      // Use undo and redo INSIDE the session before discarding. Both move
      // entries between the stacks without going through historyPush, so a
      // rollback that counts pushes drifts here and eats the pre-session entry.
      // Without these three calls the buggy and the correct implementation
      // agree, and the assertion below passes for the wrong reason.
      historyUndo();
      await new Promise(r => setTimeout(r, 400));
      historyUndo();
      await new Promise(r => setTimeout(r, 400));
      historyRedo();
      await new Promise(r => setTimeout(r, 600));
      const before = {
        editMode: isEditMode,
        dirty: hasUnsavedChanges,
        viewerShowsTyped: viewer.textContent.includes('S7_TYPED'),
        undoDepth: undoHistory.length,
      };
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 1800));
      const after = {
        editMode: isEditMode,
        dirty: hasUnsavedChanges,
        textareaMatchesStore: markdownEditor.value === window.originalMarkdown,
        storeIsSaved: window.originalMarkdown.includes('S7_SAVED'),
        viewerShowsTyped: viewer.textContent.includes('S7_TYPED'),
        viewerShowsSaved: viewer.textContent.includes('S7_SAVED'),
      };
      historyUndo();
      await new Promise(r => setTimeout(r, 1000));
      const undone = {
        resurrected: window.originalMarkdown.includes('S7_TYPED') ||
          window.originalMarkdown.includes('S7_EARLY'),
        olderPointReached: window.originalMarkdown.includes('S7_OLD_UNDO_POINT'),
      };
      window.confirm = realConfirm;
      return JSON.stringify({ warned: seen, before: before, after: after, undone: undone });
    })()
  `);
  const discard = JSON.parse(discardOut);
  // Vacuity guard: an edit-mode session that never diverged would make every
  // assertion below true for free.
  check(
    "the edit-mode session really did diverge from the saved content",
    discard.before.editMode === true &&
      discard.before.dirty === true &&
      discard.before.viewerShowsTyped === true &&
      discard.before.undoDepth > 1,
    discardOut,
  );
  check(
    "the exit warning states that the changes will be discarded",
    discard.warned.length === 1 && /discard/i.test(discard.warned[0]),
    JSON.stringify(discard.warned),
  );
  check(
    "exiting edit mode discards the unsaved edit from every store",
    discard.after.editMode === false &&
      discard.after.dirty === false &&
      discard.after.textareaMatchesStore === true &&
      discard.after.storeIsSaved === true,
    discardOut,
  );
  check(
    "the preview is repainted from the saved content, not left showing the discard",
    discard.after.viewerShowsSaved === true && discard.after.viewerShowsTyped === false,
    discardOut,
  );
  check(
    "undo cannot resurrect discarded content, and older undo points survive",
    discard.undone.resurrected === false && discard.undone.olderPointReached === true,
    JSON.stringify(discard.undone),
  );
  const shotDiscard = await captureScreenshot(win, "tabs-exit-edit-discard");
  if (shotDiscard) console.log("discard screenshot: " + shotDiscard);

  // ---- Scenario 8: the discard survives a tab round trip ----------------
  // Both reviewers found this independently, from opposite directions.
  // switchToTab seeds `window.originalMarkdown` from `tab.content`, and
  // snapshotActiveTab folds the dirty textarea INTO `tab.content` while edit
  // mode is on. So editing tab A, visiting tab B and coming back leaves the
  // session's own unsaved text sitting in `originalMarkdown` - which means a
  // discard that restores "from originalMarkdown" restores the very edit it
  // was asked to throw away, and then marks it clean.
  //
  // The fix is to restore from a baseline captured when the session began, and
  // to re-capture that baseline whenever the active document changes while edit
  // mode stays on, so the discard can never write another tab's text here.
  //
  // The final round trip is the part that matters most: the tab record keeps
  // its own copy, so a discard that fixes only the renderer's globals still
  // lets the next tab switch replay the discarded text.
  const s8 = await exec(`
    (async () => {
      const seen = [];
      const realConfirm = window.confirm;
      window.confirm = (m) => { seen.push(String(m)); return true; };
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 600));
      const findOrMake = (p) => {
        const found = window.CustomTabs.getTabs().find(t => t.filePath === p);
        return found || window.CustomTabs.createTab(p, window.fs.readFileSync(p, 'utf8'));
      };
      const tA = findOrMake(${jsA});
      const tB = findOrMake(${jsB});
      window.CustomTabs.switchToTab(tA.id);
      await new Promise(r => setTimeout(r, 800));
      // Make tab A GENUINELY clean: content === originalContent. Otherwise
      // snapshotActiveTab's view-mode branch (which only folds originalMarkdown
      // back into tab.content when the two DIFFER) papers over the replay hole
      // and this scenario stops testing it.
      window.CustomTabs.updateTabContent(window.originalMarkdown, false);
      await new Promise(r => setTimeout(r, 300));
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Alpha\\n\\nS8_TYPED\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1200));
      window.CustomTabs.switchToTab(tB.id);
      await new Promise(r => setTimeout(r, 900));
      window.CustomTabs.switchToTab(tA.id);
      await new Promise(r => setTimeout(r, 900));
      const contaminated = {
        editMode: isEditMode,
        storeHasTyped: window.originalMarkdown.includes('S8_TYPED'),
      };
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 2000));
      const after = {
        editMode: isEditMode,
        storeHasTyped: window.originalMarkdown.includes('S8_TYPED'),
        viewerHasTyped: viewer.textContent.includes('S8_TYPED'),
      };
      window.CustomTabs.switchToTab(tB.id);
      await new Promise(r => setTimeout(r, 900));
      window.CustomTabs.switchToTab(tA.id);
      await new Promise(r => setTimeout(r, 1000));
      const replay = {
        storeHasTyped: window.originalMarkdown.includes('S8_TYPED'),
        viewerHasTyped: viewer.textContent.includes('S8_TYPED'),
      };
      window.confirm = realConfirm;
      return JSON.stringify({ warned: seen.length, contaminated: contaminated, after: after, replay: replay });
    })()
  `);
  const tabDiscard = JSON.parse(s8);
  // Vacuity guard, and it is the whole point of this scenario: if the tab round
  // trip did NOT push the session's text into the document store, every
  // assertion below would pass without exercising the bug at all.
  check(
    "a tab round trip in edit mode really does put the session's text into the document store",
    tabDiscard.contaminated.editMode === true &&
      tabDiscard.contaminated.storeHasTyped === true &&
      tabDiscard.warned === 1,
    s8,
  );
  check(
    "discarding after a tab round trip does not restore the discarded text",
    tabDiscard.after.editMode === false &&
      tabDiscard.after.storeHasTyped === false &&
      tabDiscard.after.viewerHasTyped === false,
    s8,
  );
  check(
    "a later tab switch cannot replay the discarded text from the tab record",
    tabDiscard.replay.storeHasTyped === false && tabDiscard.replay.viewerHasTyped === false,
    s8,
  );

  // ---- Scenario 8b: discarding on a tab the session did not start on -----
  // The case that makes the switchToTab hook load-bearing. The session begins
  // on tab A, so only A has a baseline; if the user then types on tab B and
  // discards there, a lookup for B finds nothing and the discard silently
  // degrades into "keep the text, mark it clean" - the original bug, on the
  // other tab. The hook gives B a baseline of its own on arrival.
  const s8b = await exec(`
    (async () => {
      const realConfirm = window.confirm;
      window.confirm = () => true;
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 600));
      const tabsNow = window.CustomTabs.getTabs();
      const tA = tabsNow.find(t => t.filePath === ${jsA});
      const tB = tabsNow.find(t => t.filePath === ${jsB});
      window.CustomTabs.switchToTab(tA.id);
      await new Promise(r => setTimeout(r, 800));
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Alpha\\n\\nS8B_ON_A\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1200));
      window.CustomTabs.switchToTab(tB.id);
      await new Promise(r => setTimeout(r, 900));
      const bBefore = window.originalMarkdown;
      markdownEditor.value = '# Beta\\n\\nS8B_ON_B\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1200));
      const diverged = {
        editMode: isEditMode,
        dirty: hasUnsavedChanges,
        viewerHasB: viewer.textContent.includes('S8B_ON_B'),
      };
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 2000));
      // Capture BEFORE the undo below. Building this object inside the return
      // statement would evaluate it after historyUndo() had already moved the
      // document, which reads as a discard failure that never happened.
      const after = {
        editMode: isEditMode,
        storeHasB: window.originalMarkdown.includes('S8B_ON_B'),
        viewerHasB: viewer.textContent.includes('S8B_ON_B'),
        restoredToArrival: window.originalMarkdown === bBefore,
        dirty: hasUnsavedChanges,
        arrival: bBefore.slice(0, 80),
        final: window.originalMarkdown.slice(0, 80),
      };
      // The hook's real payload on this tab: without a baseline of its own the
      // discard cannot roll the history back, so one Ctrl+Z hands the
      // discarded text straight back - the R89 defect, on the other tab.
      historyUndo();
      await new Promise(r => setTimeout(r, 1000));
      const undoAfter = {
        resurrectedB: window.originalMarkdown.includes('S8B_ON_B'),
        viewerHasB: viewer.textContent.includes('S8B_ON_B'),
      };
      window.confirm = realConfirm;
      return JSON.stringify({ diverged: diverged, undoAfter: undoAfter, after: after });
    })()
  `);
  const otherTab = JSON.parse(s8b);
  check(
    "the edit really diverged on the second tab, so the discard there can fail",
    otherTab.diverged.editMode === true &&
      otherTab.diverged.dirty === true &&
      otherTab.diverged.viewerHasB === true,
    s8b,
  );
  check(
    "discarding on a tab the session did not start on restores that tab's own content",
    otherTab.after.editMode === false &&
      otherTab.after.storeHasB === false &&
      otherTab.after.viewerHasB === false &&
      otherTab.after.restoredToArrival === true,
    s8b,
  );
  check(
    "undo cannot resurrect content discarded on a tab the session did not start on",
    otherTab.undoAfter.resurrectedB === false && otherTab.undoAfter.viewerHasB === false,
    JSON.stringify(otherTab.undoAfter),
  );
  // The baseline records the dirty flag as well as the document. It is captured
  // on arrival, and used to be captured BEFORE switchToTab moved the flag to
  // the arriving tab's value - so it baked in the previous tab's dirty state
  // and a discard here left an "unsaved" indicator on a document with nothing
  // unsaved in it. Tab B arrives clean, so the flag must be clean afterwards.
  check(
    "discarding on a clean tab does not inherit the previous tab's unsaved state",
    otherTab.after.dirty === false,
    s8b,
  );

  // ---- Scenario 9: Save clicked, then Exit before the write comes back ----
  // Raised by GPT-5.4 while reviewing the discard. Clicking Save dispatches an
  // async IPC write and clears nothing; `hasUnsavedChanges` stays true until
  // `save-markdown-result` arrives. So an Exit in that window used to (a) warn
  // that changes would be DISCARDED when the user had just asked to save them,
  // and (b) actually discard them in the renderer while the main process wrote
  // them to disk - leaving the file and the app holding different documents,
  // with no indicator that anything had happened.
  //
  // The race is made deterministic rather than hoped for: Save and Exit are
  // issued in one synchronous task, and an IPC reply cannot be delivered before
  // that task yields.
  const raceOut = await exec(`
    (async () => {
      const seen = [];
      const realConfirm = window.confirm;
      window.confirm = (msg) => { seen.push(String(msg)); return true; };
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      window.originalMarkdown = '# Beta\\n\\nS9_SAVED\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Beta\\n\\nS9_TYPED\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1600));
      const before = { editMode: isEditMode, dirty: hasUnsavedChanges };
      // One synchronous task: the save reply cannot land between these two.
      saveButton.click();
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 2500));
      const after = {
        editMode: isEditMode,
        dirty: hasUnsavedChanges,
        storeHasTyped: window.originalMarkdown.includes('S9_TYPED'),
        viewerHasTyped: viewer.textContent.includes('S9_TYPED'),
      };
      // The user's ORIGINAL complaint, in a new disguise: a save that leaves
      // the tab record on the pre-save document means the next tab switch
      // repaints the file as it was before the save, from memory.
      const tabs = window.CustomTabs.getTabs();
      const other = tabs.find(t => t.filePath !== window.currentFilePath);
      let replay = null;
      if (other) {
        const mine = window.CustomTabs.getActiveTab().id;
        window.CustomTabs.switchToTab(other.id);
        await new Promise(r => setTimeout(r, 900));
        window.CustomTabs.switchToTab(mine);
        await new Promise(r => setTimeout(r, 1000));
        replay = {
          storeHasTyped: window.originalMarkdown.includes('S9_TYPED'),
          viewerHasTyped: viewer.textContent.includes('S9_TYPED'),
        };
      }
      window.confirm = realConfirm;
      return JSON.stringify({
        warned: seen,
        before: before,
        path: window.currentFilePath,
        after: after,
        replay: replay,
      });
    })()
  `);
  const race = JSON.parse(raceOut);
  const diskAfterRace = fs.readFileSync(race.path, "utf8");
  check(
    "the save-then-exit race really was set up: dirty edit-mode content and a real write",
    race.before.editMode === true &&
      race.before.dirty === true &&
      diskAfterRace.includes("S9_TYPED"),
    raceOut + " disk=" + JSON.stringify(diskAfterRace.slice(0, 60)),
  );
  check(
    "exiting during a save does not warn that the changes will be discarded",
    race.warned.length === 0,
    JSON.stringify(race.warned),
  );
  check(
    "the document the app shows after a save-then-exit is the document on disk",
    race.after.storeHasTyped === true &&
      race.after.viewerHasTyped === true &&
      race.after.dirty === false,
    raceOut + " disk=" + JSON.stringify(diskAfterRace.slice(0, 60)),
  );
  const shotRace = await captureScreenshot(win, "tabs-save-then-exit");
  if (shotRace) console.log("save-race screenshot: " + shotRace);
  check(
    "a saved document survives a tab round trip instead of reverting to the pre-save text",
    race.replay !== null &&
      race.replay.storeHasTyped === true &&
      race.replay.viewerHasTyped === true,
    raceOut,
  );

  // ---- Scenario 9b: typing while the write is in flight ------------------
  // The save wrote the bytes it was handed, not the bytes that are in the
  // textarea by the time the reply lands. Re-reading the textarea there marks
  // the document saved when it is not: `originalMarkdown` starts describing a
  // file that was never written, the dirty indicator goes out, and the next
  // exit discards the difference without warning. The disk is the oracle here.
  const duringOut = await exec(`
    (async () => {
      const realConfirm = window.confirm;
      window.confirm = () => true;
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      window.originalMarkdown = '# Beta\\n\\nS9B_BASE\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Beta\\n\\nS9B_SENT\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1400));
      // One synchronous task again: the keystroke lands after the write was
      // dispatched and before its reply can possibly arrive.
      saveButton.click();
      markdownEditor.value = '# Beta\\n\\nS9B_AFTER\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 2500));
      const out = {
        editMode: isEditMode,
        storeIsSent: window.originalMarkdown.includes('S9B_SENT'),
        storeIsAfter: window.originalMarkdown.includes('S9B_AFTER'),
        dirty: hasUnsavedChanges,
        textarea: markdownEditor.value.includes('S9B_AFTER'),
        path: window.currentFilePath,
      };
      window.confirm = realConfirm;
      return JSON.stringify(out);
    })()
  `);
  const during = JSON.parse(duringOut);
  const diskDuring = fs.readFileSync(during.path, "utf8");
  check(
    "the type-during-save race really was set up: the write and the buffer diverged",
    during.editMode === true &&
      during.textarea === true &&
      diskDuring.includes("S9B_SENT") &&
      !diskDuring.includes("S9B_AFTER"),
    duringOut + " disk=" + JSON.stringify(diskDuring.slice(0, 60)),
  );
  check(
    "after a save the document store holds the bytes that were written, not later keystrokes",
    during.storeIsSent === true && during.storeIsAfter === false,
    duringOut + " disk=" + JSON.stringify(diskDuring.slice(0, 60)),
  );
  check(
    "keystrokes made during a save are still reported as unsaved",
    during.dirty === true,
    duringOut,
  );

  // ---- Scenario 9c: the save reply lands while another tab is active -----
  // Both reviewers found this independently. custom-tabs.js takes over the
  // save-markdown-result channel and used to swallow replies whose path was
  // not the active document. A save on tab A followed by a switch to tab B
  // therefore never reached the renderer: the promise the exit path parks on
  // was stranded, `originalMarkdown` for A never adopted the write, and coming
  // back to A and clicking Exit sat on a 5s timeout and then offered to
  // DISCARD a save that had already succeeded.
  const bgOut = await exec(`
    (async () => {
      const seen = [];
      const realConfirm = window.confirm;
      window.confirm = (msg) => { seen.push(String(msg)); return true; };
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      // The preceding scenario deliberately leaves a dirty edit session open,
      // so the cleanup click above raises its own discard confirm. Only the
      // prompts this scenario provokes are being measured.
      seen.length = 0;
      const tabs = window.CustomTabs.getTabs();
      const mine = window.CustomTabs.getActiveTab();
      const other = tabs.find(t => t.filePath !== mine.filePath);
      window.originalMarkdown = '# Beta\\n\\nS9C_BASE\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      window.CustomTabs.updateTabContent(window.originalMarkdown, false);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Beta\\n\\nS9C_TYPED\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1600));
      // One synchronous task: the reply cannot arrive before we have left.
      saveButton.click();
      window.CustomTabs.switchToTab(other.id);
      await new Promise(r => setTimeout(r, 2500));
      // The reply for the background document landed while THIS one was on
      // screen. It must not have been applied to it.
      const otherStore = {
        clean: !window.originalMarkdown.includes('S9C_TYPED'),
        viewerClean: !viewer.textContent.includes('S9C_TYPED'),
      };
      window.CustomTabs.switchToTab(mine.id);
      await new Promise(r => setTimeout(r, 1200));
      const beforeExit = {
        dirty: hasUnsavedChanges,
        tabDirty: window.CustomTabs.getActiveTab().hasUnsavedChanges,
        activePath: window.currentFilePath,
        tabContentHasTyped: window.CustomTabs.getActiveTab().content.includes('S9C_TYPED'),
        tabOriginalHasTyped: String(window.CustomTabs.getActiveTab().originalContent).includes('S9C_TYPED'),
      };
      const t0 = Date.now();
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 2200));
      const elapsed = Date.now() - t0;
      window.confirm = realConfirm;
      return JSON.stringify({
        warned: seen,
        elapsed: elapsed,
        path: mine.filePath,
        beforeExit: beforeExit,
        otherStore: otherStore,
        editMode: isEditMode,
        storeHasTyped: window.originalMarkdown.includes('S9C_TYPED'),
        viewerHasTyped: viewer.textContent.includes('S9C_TYPED'),
      });
    })()
  `);
  const bg = JSON.parse(bgOut);
  const diskBg = fs.readFileSync(bg.path, "utf8");
  check(
    "the background-save case really was set up: the write reached disk from a tab left in the background",
    diskBg.includes("S9C_TYPED"),
    bgOut + " disk=" + JSON.stringify(diskBg.slice(0, 60)),
  );
  check(
    "a save whose reply arrived on another tab is not offered for discard on return",
    bg.warned.length === 0 && bg.editMode === false,
    bgOut,
  );
  check(
    "returning to a tab saved in the background shows the saved document, not the pre-save text",
    bg.storeHasTyped === true && bg.viewerHasTyped === true,
    bgOut + " disk=" + JSON.stringify(diskBg.slice(0, 60)),
  );
  check(
    "a save that completes for a background document is not applied to the document on screen",
    bg.otherStore.clean === true && bg.otherStore.viewerClean === true,
    bgOut,
  );
  check(
    "exiting after a completed background save does not stall on the in-flight timeout",
    bg.elapsed < 4500,
    JSON.stringify({ elapsed: bg.elapsed }),
  );

  // ---- Scenario 9d: two writes in flight at once -------------------------
  // A single pending slot cross-wires them: the first reply adopts the SECOND
  // request's bytes, so the store claims a document that is not yet on disk.
  // Ctrl+S twice, or Save then Ctrl+S, reaches this with no exotic timing.
  const twoOut = await exec(`
    (async () => {
      const realConfirm = window.confirm;
      window.confirm = () => true;
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      window.originalMarkdown = '# Beta\\n\\nS9D_BASE\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      markdownEditor.value = '# Beta\\n\\nS9D_FIRST\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1400));
      // Both writes dispatched in one synchronous task, so both are in flight
      // before either reply can be delivered.
      saveButton.click();
      markdownEditor.value = '# Beta\\n\\nS9D_SECOND\\n';
      saveButton.click();
      await new Promise(r => setTimeout(r, 2800));
      const out = {
        editMode: isEditMode,
        storeIsSecond: window.originalMarkdown.includes('S9D_SECOND'),
        storeIsFirst: window.originalMarkdown.includes('S9D_FIRST'),
        dirty: hasUnsavedChanges,
        path: window.currentFilePath,
      };
      window.confirm = realConfirm;
      return JSON.stringify(out);
    })()
  `);
  const two = JSON.parse(twoOut);
  const diskTwo = fs.readFileSync(two.path, "utf8");
  check(
    "the two-writes-in-flight case really was set up: the last write won on disk",
    two.editMode === true && diskTwo.includes("S9D_SECOND"),
    twoOut + " disk=" + JSON.stringify(diskTwo.slice(0, 60)),
  );
  check(
    "with two writes in flight the document store ends on the bytes that are actually on disk",
    two.storeIsSecond === true && two.storeIsFirst === false && two.dirty === false,
    twoOut + " disk=" + JSON.stringify(diskTwo.slice(0, 60)),
  );

  // ---- Scenario 9e: a reload underneath an open edit session -------------
  // Both reviewers found this too. The baseline is captured on edit-mode entry;
  // a reload replaces the document without moving it, so a later discard
  // restores the PRE-reload text and silently undoes the reload as well - the
  // user's own original complaint (a refresh reverting a file) reappearing
  // through the discard path.
  const reloadOut = await exec(`
    (async () => {
      const realConfirm = window.confirm;
      window.confirm = () => true;
      if (isEditMode) toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      window.originalMarkdown = '# Beta\\n\\nS9E_STALE\\n';
      markdownEditor.value = window.originalMarkdown;
      await renderMarkdown(window.originalMarkdown);
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 800));
      // The file on disk still holds whatever the previous scenario wrote, so
      // reloading brings in content the session never saw.
      reloadCurrentFile();
      await new Promise(r => setTimeout(r, 2000));
      const reloaded = markdownEditor.value;
      markdownEditor.value = reloaded + '\\nS9E_TYPED\\n';
      markdownEditor.dispatchEvent(new Event('input'));
      await new Promise(r => setTimeout(r, 1600));
      toggleEditBtn.click();
      await new Promise(r => setTimeout(r, 2000));
      window.confirm = realConfirm;
      return JSON.stringify({
        reloadedWasDifferent: !reloaded.includes('S9E_STALE'),
        reloaded: reloaded.slice(0, 60),
        editMode: isEditMode,
        restoredToReloaded: window.originalMarkdown === reloaded,
        wentBackToStale: window.originalMarkdown.includes('S9E_STALE'),
        keptTyping: window.originalMarkdown.includes('S9E_TYPED'),
        final: window.originalMarkdown.slice(0, 60),
      });
    })()
  `);
  const reload = JSON.parse(reloadOut);
  check(
    "the reload case really was set up: the reload brought in content the session had not seen",
    reload.reloadedWasDifferent === true,
    reloadOut,
  );
  check(
    "discarding after a reload restores the reloaded document, not the pre-reload text",
    reload.editMode === false &&
      reload.restoredToReloaded === true &&
      reload.wentBackToStale === false &&
      reload.keptTyping === false,
    reloadOut,
  );

  const errors = await exec(`window.__e2eErrors || []`);
  check("no uncaught renderer errors", errors.length === 0, JSON.stringify(errors));

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
  // A native modal (confirm/alert) blocks executeJavaScript forever, which
  // turns a bug into a hung run with no output. Fail loudly instead.
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

  await sleep(2500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.log("FAIL  no BrowserWindow was created");
    app.exit(1);
    return;
  }

  await win.webContents.executeJavaScript(`
    window.__e2eErrors = [];
    window.addEventListener('error', e => window.__e2eErrors.push(String(e.message)));
    window.addEventListener('unhandledrejection', e => window.__e2eErrors.push(String(e.reason)));
    null;
  `);

  try {
    await run(win);
  } catch (error) {
    console.log("FAIL  harness threw:", error && error.stack ? error.stack : error);
    results.push({ name: "harness", ok: false });
  }

  const failed = results.filter((r) => !r.ok).length;
  clearTimeout(watchdog);
  // Screenshot as a debugging artifact, never a baseline - see
  // test-visual-utils.js. Captured on failure so the failing screen can be
  // inspected without re-running the suite by hand.
  if (failed > 0) {
    const shot = await captureScreenshot(win, "tab-refresh-FAILED");
    if (shot) console.log("failure screenshot: " + shot);
  }
  console.log(`\n=== ${results.length - failed}/${results.length} passed ===`);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  app.exit(failed === 0 ? 0 : 1);
});
