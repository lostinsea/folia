// Regression harness for in-document search (PERF-02 and its correctness risk).
// Run with: npm run test:search
//
// PERF-AUDIT.md measured highlightSearchTerm() at 316ms on a 2MB / 2001-heading
// document, paid on every keystroke, because it walks the entire rendered tree
// and replaces text nodes with fragments. The fix is a 150ms debounce plus two
// algorithmic repairs (normalize() once per parent instead of once per match,
// and O(1) instead of O(matches) current-match tracking).
//
// A debounce is a correctness hazard, not just a speed knob: if the user types
// and immediately presses Enter, or hits the next/prev buttons, or closes the
// panel, a naive implementation navigates the PREVIOUS term's matches or
// repopulates highlights into a closed panel. Most of the assertions below are
// about that, not about speed. The speed assertion is deliberately expressed as
// "one pass per burst", which is deterministic, rather than a millisecond
// threshold, which would be flaky on shared CI hardware.

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { inspectVisual, captureScreenshot } = require("./test-visual-utils");

require("./main.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-search-"));
const file = path.join(dir, "searchable.md");
const js = JSON.stringify(file);

// Large enough that a per-keystroke full walk is measurably worse than one
// pass, and with a term ("needle") that appears many times across many parents
// so the normalize()-per-parent and current-match assertions have something to
// bite on. "haystack" appears exactly once, for the unique-match cases.
function buildDoc() {
  const parts = ["# Searchable\n"];
  for (let i = 0; i < 300; i++) {
    parts.push(`## Section ${i}\n`);
    parts.push(`This paragraph mentions needle and needle again in one node.\n`);
    parts.push(`Another paragraph with a single needle here.\n`);
  }
  parts.push("\nThe unique word haystack appears exactly once.\n");
  return parts.join("\n");
}
const DOC = buildDoc();

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? "" : String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

function writeReport(summary) {
  const lines = results.map(
    (r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  -> " + r.detail}`,
  );
  lines.push(summary);
  try {
    fs.writeFileSync(path.join(__dirname, "test-search-results.txt"), lines.join("\n") + "\n");
  } catch (e) {
    console.log("could not write test-search-results.txt: " + e.message);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(exec, label, expression, timeoutMs = 30000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await exec(expression);
    if (last) return last;
    await sleep(100);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${label} (last value: ${JSON.stringify(last)})`,
  );
}

// Type into the search box the way a user does: one input event per character,
// with no delay between them, so the debounce window covers the whole burst.
// Using dispatchEvent rather than calling the handler keeps the test honest
// about the wiring - if the listener were removed, this would stop working.
function typeScript(term) {
  return `
    (() => {
      const input = document.getElementById('searchInput');
      input.value = '';
      const chars = ${JSON.stringify(term)}.split('');
      for (let i = 0; i < chars.length; i++) {
        input.value += chars[i];
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return input.value;
    })()
  `;
}

function keyScript(key, shift) {
  return `
    (() => {
      const input = document.getElementById('searchInput');
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)},
        shiftKey: ${shift ? "true" : "false"},
        bubbles: true,
        cancelable: true,
      }));
      return true;
    })()
  `;
}

const COUNTS = `
  (() => ({
    highlights: document.querySelectorAll('#viewer .search-highlight').length,
    current: document.querySelectorAll('#viewer .search-highlight.current').length,
    counter: (document.getElementById('searchCounter') || {}).textContent || '',
    passes: window.__searchProbe ? window.__searchProbe.passes : -1,
    // Only terms long enough to actually walk the document. The first
    // character of any burst is a 1-char term, which takes the immediate
    // "clear highlights" path by design - that is cheap and must not be
    // delayed, so counting it as a debounce failure would be wrong.
    walkingPasses: window.__searchProbe
      ? window.__searchProbe.terms.filter(t => t && t.length >= 2).length
      : -1,
  }))()
`;

async function run(win) {
  const exec = (code) => win.webContents.executeJavaScript(code, true);

  fs.writeFileSync(file, DOC, "utf8");

  await exec(`
    localStorage.clear();
    window.CustomTabs.getTabs().slice().forEach(t => { t.hasUnsavedChanges = false; window.CustomTabs.closeTab(t.id); });
    null;
  `);

  await exec(`
    (() => {
      const t = window.CustomTabs.createTab(${js}, window.fs.readFileSync(${js}, 'utf8'));
      window.CustomTabs.switchToTab(t.id);
      return t.id;
    })()
  `);
  await waitFor(
    exec,
    "the document to render",
    `document.querySelectorAll('#viewer h2').length >= 300`,
  );

  // Open the search panel through the real toggle so the panel state under
  // test is the one the app actually produces.
  await exec(`toggleSearchPanel(), true`);
  await waitFor(
    exec,
    "the search panel to open",
    `document.getElementById('searchPanel').classList.contains('visible')`,
  );

  // Count actual highlight passes. This is the measurement the debounce is for:
  // a millisecond threshold would be flaky, but "one pass per burst" is exact.
  await exec(`
    (() => {
      window.__searchProbe = { passes: 0, terms: [] };
      const original = window.highlightSearchTerm;
      window.__searchProbeRestore = () => { window.highlightSearchTerm = original; };
      window.highlightSearchTerm = function (term) {
        window.__searchProbe.passes++;
        window.__searchProbe.terms.push(term);
        return original(term);
      };
      return typeof original === 'function';
    })()
  `);

  // --- 1. A burst of typing produces exactly one highlight pass ------------
  await exec(typeScript("needle"));
  const during = await exec(COUNTS);
  check(
    "typing does not highlight synchronously on every keystroke",
    during.passes <= 1,
    JSON.stringify(during),
  );

  await waitFor(exec, "the debounced search to run", `window.__searchProbe.passes >= 1`);
  await sleep(300); // let any further (unwanted) passes land before counting
  const after = await exec(COUNTS);
  check(
    "a six-character burst produces a single document-walking pass",
    after.walkingPasses === 1,
    JSON.stringify(after),
  );
  check(
    "the debounced pass highlights every match",
    after.highlights === 900,
    JSON.stringify(after),
  );
  check(
    "exactly one match is marked current",
    after.current === 1,
    JSON.stringify(after),
  );

  // --- 2. Navigation flushes a pending search -----------------------------
  // The dangerous case: type a NEW term and press Enter before the debounce
  // fires. Without a flush this navigates the old term's matches, so the user
  // is silently taken to the wrong place.
  await exec(`window.__searchProbe.passes = 0; window.__searchProbe.terms = []; true`);
  await exec(typeScript("haystack"));
  await exec(keyScript("Enter", false));
  const afterEnter = await exec(COUNTS);
  check(
    "Enter flushes a pending search instead of navigating stale matches",
    afterEnter.highlights === 1 && afterEnter.current === 1,
    JSON.stringify(afterEnter),
  );
  check(
    "the counter reflects the flushed term, not the previous one",
    /\b1\b/.test(afterEnter.counter) && !/900/.test(afterEnter.counter),
    JSON.stringify(afterEnter),
  );

  // The next/prev buttons need the same flush as Enter.
  await exec(typeScript("needle"));
  await exec(`document.getElementById('searchNext').click(), true`);
  const afterNextBtn = await exec(COUNTS);
  check(
    "the next button flushes a pending search",
    afterNextBtn.highlights === 900 && afterNextBtn.current === 1,
    JSON.stringify(afterNextBtn),
  );

  await exec(typeScript("haystack"));
  await exec(`document.getElementById('searchPrev').click(), true`);
  const afterPrevBtn = await exec(COUNTS);
  check(
    "the previous button flushes a pending search",
    afterPrevBtn.highlights === 1,
    JSON.stringify(afterPrevBtn),
  );

  // The two checks above only pass because the buttons are still clickable while
  // a term is pending. Assert that directly so the reason is visible: the first
  // character of a burst is a 1-char term, which clears highlights to zero
  // matches, and a zero-match state used to disable both nav buttons - making
  // their flush-on-click handler unreachable for the whole debounce window.
  const pendingDisabled = await exec(`
    (() => {
      const i = document.getElementById('searchInput');
      i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true }));
      const clearedState = document.getElementById('searchNext').disabled;
      i.value = 'needle'; i.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        clearedState,
        pendingState: document.getElementById('searchNext').disabled,
        prevPendingState: document.getElementById('searchPrev').disabled,
      };
    })()
  `);
  check(
    "nav buttons stay clickable while a debounced search is pending",
    pendingDisabled.clearedState === true &&
      pendingDisabled.pendingState === false &&
      pendingDisabled.prevPendingState === false,
    JSON.stringify(pendingDisabled),
  );
  await waitFor(exec, "the pending term to flush", `document.querySelectorAll('#viewer .search-highlight').length === 900`);

  // --- 3. Moving between matches is O(1), not O(matches) ------------------
  await exec(typeScript("needle"));
  await waitFor(exec, "matches to appear", `document.querySelectorAll('#viewer .search-highlight').length === 900`);

  const navProbe = await exec(`
    (() => {
      const before = [...document.querySelectorAll('#viewer .search-highlight')];
      const firstBefore = before.findIndex(el => el.classList.contains('current'));
      nextMatch();
      const after = [...document.querySelectorAll('#viewer .search-highlight')];
      const firstAfter = after.findIndex(el => el.classList.contains('current'));
      return {
        total: after.length,
        currentCount: after.filter(el => el.classList.contains('current')).length,
        firstBefore,
        firstAfter,
      };
    })()
  `);
  check(
    "next moves the current marker by exactly one match",
    navProbe.firstAfter === navProbe.firstBefore + 1,
    JSON.stringify(navProbe),
  );
  check(
    "only one match is ever marked current after navigating",
    navProbe.currentCount === 1,
    JSON.stringify(navProbe),
  );

  // Wrapping past the end must still leave exactly one current match - the
  // O(1) rewrite tracks the outgoing element by reference, so an off-by-one
  // here would strand a stale .current on the last match.
  const wrapProbe = await exec(`
    (() => {
      currentMatchIndex = searchMatches.length - 1;
      highlightCurrentMatch();
      nextMatch();
      const all = [...document.querySelectorAll('#viewer .search-highlight')];
      return {
        currentCount: all.filter(el => el.classList.contains('current')).length,
        currentIndex: all.findIndex(el => el.classList.contains('current')),
      };
    })()
  `);
  check(
    "wrapping from the last match back to the first leaves one current match",
    wrapProbe.currentCount === 1 && wrapProbe.currentIndex === 0,
    JSON.stringify(wrapProbe),
  );

  const prevWrapProbe = await exec(`
    (() => {
      previousMatch();
      const all = [...document.querySelectorAll('#viewer .search-highlight')];
      return {
        currentCount: all.filter(el => el.classList.contains('current')).length,
        currentIndex: all.findIndex(el => el.classList.contains('current')),
        total: all.length,
      };
    })()
  `);
  check(
    "wrapping backwards from the first match leaves one current match at the end",
    prevWrapProbe.currentCount === 1 &&
      prevWrapProbe.currentIndex === prevWrapProbe.total - 1,
    JSON.stringify(prevWrapProbe),
  );

  // --- 4. Clearing restores the DOM exactly ------------------------------
  // clearSearchHighlights() now normalizes each parent once rather than once
  // per match. Under-normalising would leave the tree split into many adjacent
  // text nodes, so the NEXT search would walk a fragmented tree and, worse,
  // could fail to match a term straddling the split.
  const clearProbe = await exec(`
    (() => {
      const target = document.querySelectorAll('#viewer p')[0];
      const before = target.textContent;
      clearSearchHighlights();
      const nodes = [...target.childNodes];
      return {
        text: target.textContent,
        before,
        childNodes: nodes.length,
        allText: nodes.every(n => n.nodeType === Node.TEXT_NODE),
        highlights: document.querySelectorAll('#viewer .search-highlight').length,
      };
    })()
  `);
  check(
    "clearing removes every highlight",
    clearProbe.highlights === 0,
    JSON.stringify(clearProbe),
  );
  check(
    "clearing collapses a previously highlighted paragraph back to one text node",
    clearProbe.childNodes === 1 && clearProbe.allText === true,
    JSON.stringify(clearProbe),
  );
  check(
    "clearing preserves the paragraph text exactly",
    clearProbe.text === clearProbe.before,
    JSON.stringify(clearProbe),
  );

  // A term that spans what used to be a highlight boundary only matches if the
  // tree was properly re-joined. This is the assertion that would catch a
  // regression to per-match normalize() being dropped entirely.
  await exec(typeScript("needle and needle"));
  await waitFor(
    exec,
    "the straddling term to match",
    `document.querySelectorAll('#viewer .search-highlight').length > 0`,
  );
  const straddle = await exec(COUNTS);
  check(
    "a term spanning a previous highlight boundary still matches after clearing",
    straddle.highlights === 300,
    JSON.stringify(straddle),
  );

  // --- 5. Closing the panel cancels a pending search ----------------------
  // Without cancellation the queued highlight fires after the clear and
  // repopulates highlights into a closed panel with an empty input.
  await exec(typeScript("needle"));
  await exec(`toggleSearchPanel(), true`);
  await sleep(400); // longer than the debounce window
  const afterClose = await exec(COUNTS);
  check(
    "closing the panel cancels a pending search",
    afterClose.highlights === 0,
    JSON.stringify(afterClose),
  );
  check(
    "closing the panel clears the input",
    (await exec(`document.getElementById('searchInput').value`)) === "",
    "input not cleared",
  );

  // --- 6. Short and empty terms clear immediately -------------------------
  // These are cheap, so they must not be delayed behind the debounce - a user
  // deleting their query expects the highlights to go at once.
  await exec(`toggleSearchPanel(), true`);
  await waitFor(exec, "the panel to reopen", `document.getElementById('searchPanel').classList.contains('visible')`);
  await exec(typeScript("needle"));
  await waitFor(exec, "matches to appear", `document.querySelectorAll('#viewer .search-highlight').length === 900`);
  await exec(`
    (() => {
      const input = document.getElementById('searchInput');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  const afterEmpty = await exec(COUNTS);
  check(
    "emptying the input clears highlights synchronously",
    afterEmpty.highlights === 0,
    JSON.stringify(afterEmpty),
  );

  // --- 7. Visual smoke ----------------------------------------------------
  await exec(typeScript("needle"));
  await waitFor(exec, "matches to appear", `document.querySelectorAll('#viewer .search-highlight').length === 900`);
  const panelVisual = await inspectVisual(win, "#searchPanel");
  check(
    "the search panel is actually visible on screen",
    panelVisual.count === 1 && panelVisual.soundCount === 1,
    JSON.stringify(panelVisual.unsound),
  );

  await exec(`window.__searchProbeRestore(), true`);
  await captureScreenshot(win, "search");

  // --- 8. A re-render must not leave the search UI describing the old tree --
  // Every render replaces viewer blocks, which detaches the highlight spans
  // inside them. Before the fix the search state kept pointing at those detached
  // nodes: the counter went on reporting the previous document's matches, the
  // nav buttons stayed enabled, and clicking next advanced the counter while
  // nothing moved on screen. Measured on the real app: 30 matches recorded, 0
  // still attached, on a document that no longer contained the term.
  //
  // This is the app's normal case, not an edge case - files are expected to
  // change underneath the reader.
  await exec(`
    (() => {
      window.__docWith = '# With\\n\\n' + Array.from({length: 12}, () => 'a needle here').join('\\n\\n');
      window.__docWithout = '# Without\\n\\n' + Array.from({length: 12}, () => 'nothing to find').join('\\n\\n');
      return true;
    })()
  `);

  // 8a. Re-render into a document that does NOT contain the term.
  await exec(`renderMarkdown(window.__docWith, 'full')`);
  await sleep(1200);
  await exec(typeScript("needle"));
  await waitFor(exec, "matches in the first document", `searchMatches.length === 12`);
  await exec(`renderMarkdown(window.__docWithout, 'full')`);
  await waitFor(
    exec,
    "the search state to resync and settle after the re-render",
    `searchMatches.length === 0 && pendingSearchTerm === null`,
  );
  const afterSwapAway = await exec(`
    ({ matches: searchMatches.length,
       detached: searchMatches.filter(m => !m.isConnected).length,
       counter: searchCounter.textContent,
       nextDisabled: searchNextBtn.disabled,
       currentEl: currentMatchEl === null })
  `);
  check(
    "a re-render drops search state that points at the old tree",
    afterSwapAway.matches === 0 &&
      afterSwapAway.detached === 0 &&
      afterSwapAway.currentEl === true,
    JSON.stringify(afterSwapAway),
  );
  check(
    "the counter and nav buttons stop advertising matches that no longer exist",
    /\b0\b/.test(afterSwapAway.counter) && afterSwapAway.nextDisabled === true,
    JSON.stringify(afterSwapAway),
  );

  // Clicking next must be inert rather than silently walking dead nodes.
  const afterDeadClick = await exec(`
    (() => {
      document.getElementById('searchNext').click();
      return { counter: searchCounter.textContent,
               visible: document.querySelectorAll('#viewer .search-highlight').length };
    })()
  `);
  check(
    "navigating after a re-render does not walk detached matches",
    /\b0\b/.test(afterDeadClick.counter) && afterDeadClick.visible === 0,
    JSON.stringify(afterDeadClick),
  );

  // 8b. Re-render into a document that DOES contain the term: the highlights
  // must come back, attached to the NEW tree - resyncing must not mean "give up".
  await exec(`renderMarkdown(window.__docWith, 'full')`);
  await waitFor(
    exec,
    "the search to re-apply against the new tree",
    `searchMatches.length === 12`,
  );
  const afterSwapBack = await exec(`
    ({ matches: searchMatches.length,
       live: searchMatches.filter(m => m.isConnected).length,
       inViewer: searchMatches.filter(m => viewer.contains(m)).length,
       counter: searchCounter.textContent })
  `);
  check(
    "the search re-applies against the new tree, with every match attached",
    afterSwapBack.matches === 12 &&
      afterSwapBack.live === 12 &&
      afterSwapBack.inViewer === 12,
    JSON.stringify(afterSwapBack),
  );
}

app.whenReady().then(async () => {
  await sleep(2500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    check("a window was created", false, "no BrowserWindow found");
    writeReport("=== 0/1 passed ===");
    app.exit(1);
    return;
  }

  let fatal = null;
  try {
    await run(win);
  } catch (e) {
    fatal = e;
    check("harness ran to completion", false, e.message);
    try {
      await captureScreenshot(win, "search-FAILED");
    } catch (_) {
      /* screenshot is best-effort */
    }
  }

  const passed = results.filter((r) => r.ok).length;
  const summary = `=== ${passed}/${results.length} passed ===`;
  console.log(summary);
  if (fatal) console.log(fatal.stack);
  writeReport(summary);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) {
    /* temp dir cleanup is best-effort */
  }
  app.exit(passed === results.length ? 0 : 1);
});

setTimeout(() => {
  check("harness completed within 180s", false, "watchdog fired");
  writeReport(`=== ${results.filter((r) => r.ok).length}/${results.length} passed ===`);
  app.exit(1);
}, 180000);
