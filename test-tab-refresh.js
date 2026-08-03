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

// mtime has 1ms resolution but writes can land inside the same tick; bump the
// mtime explicitly so the change is unambiguously detectable.
function write(file, content) {
  fs.writeFileSync(file, content, "utf8");
  const future = new Date(Date.now() + 2000);
  fs.utimesSync(file, future, future);
}

async function run(win) {
  const exec = (code) => win.webContents.executeJavaScript(code, true);

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
  await exec(`
    (() => {
      const h = Array.from(document.querySelectorAll('#viewer h2'))
        .find(el => el.textContent.trim() === 'Section 25');
      const s = ${scroller};
      s.scrollTop = h.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop;
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
  const anchorTop = await exec(`
    (() => {
      const h = Array.from(document.querySelectorAll('#viewer h2'))
        .find(el => el.textContent.trim() === 'Section 25');
      const s = ${scroller};
      return h.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop;
    })()
  `);
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

  // Realistic sequence: the prompt is raised while the tab is clean, the user
  // then starts a view-mode edit, and only afterwards clicks Reload.
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

  // ---- Scenario 5d: non-markdown file types survive a disk re-read -------
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

  const errors = await exec(`window.__e2eErrors || []`);
  check("no uncaught renderer errors", errors.length === 0, JSON.stringify(errors));
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
