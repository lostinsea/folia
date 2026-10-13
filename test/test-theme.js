// Regression harness for the theme system: the two DEFAULT schemes must look
// exactly as Folia looked before the theme system existed.
//
// That is a user requirement, not a nicety - "make sure current themes also
// bundle up as Dark/Light defaults" - so the oracle is a FROZEN BASELINE
// captured from the tree at commit 4bbde83, before any of the refactor landed.
// test/fixtures/theme-golden.json is committed literal data produced by
// scripts/capture-theme-golden.js, by hand, deliberately. It is NEVER
// regenerated from a test run: if it were, changing a colour would rewrite the
// file this suite reads, the assertion could not fail, and the revert proof
// would come back VACUOUS.
//
// It records the FULL VISUAL TUPLE rather than colour alone. That is a measured
// requirement: `entity` is separated from `operator` only by its background and
// cursor, and `namespace` from `tag` only by opacity, so a colour-only baseline
// lets both regress green. It also records the code box (padding, radius,
// tab-size, white-space...) because every one of those used to come from the
// vendored light Solarized stylesheet and DARK MODE DEPENDED ON IT - dropping
// that <link> without porting them would have degraded both themes silently.
//
// THE AMENDMENTS TABLE IS THE OTHER HALF OF THE DESIGN. Three dark-mode cells
// are deliberately NOT reproduced, because the old dark block overrode `color`
// only and the light stylesheet leaked everything else into dark mode. Each is
// listed below with a reason and its new expected value. The golden itself is
// never edited, so it stays a faithful record of what shipped - and a FOURTH
// deviation, which nobody decided on, fails loudly instead of hiding among
// three that were.
// Isolate this suite's userData profile before main.js exists and before the
// app is ready. See test-userdata-isolation.js.
require("./test-userdata-isolation");

const { app, BrowserWindow, ipcMain } = require("electron");
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { stripJsComments } = require("./test-source-utils.js");
const { captureScreenshot } = require("./test-visual-utils.js");

const {
  GOLDEN_PATH,
  TOKEN_PROPS,
  BOX_PROPS,
  SURFACE_SELECTORS,
  waitForWindow,
  captureBothModes,
  applyModeInPage,
  waitFor,
} = require("./theme-census");

const results = [];
let failed = 0;
let finishing = false;

function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failed++;
  results.push(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : "  -> " + detail}`,
  );
}

async function finish() {
  if (finishing) return;
  finishing = true;
  try {
    // Keep owned teardown diagnostics before the terminal transcript, without
    // muting them or racing automatic quit when the last test window disappears.
    const windows = BrowserWindow.getAllWindows();
    const keepalive = new BrowserWindow({
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    await Promise.all(windows.map(win => new Promise(resolve => {
      if (win.webContents.isDestroyed()) return resolve();
      win.webContents.once("destroyed", resolve);
      win.destroy();
    })));
    await new Promise(resolve => setImmediate(resolve));
    if (keepalive.isDestroyed()) throw new Error("Theme teardown keepalive was lost");
    results.push(`=== ${results.length - failed}/${results.length} passed ===`);
    const text = results.join("\n") + "\n";
    fs.writeFileSync(path.join(__dirname, "test-theme-results.txt"), text);
    console.log(text);
    app.exit(failed === 0 ? 0 : 1);
  } catch (error) {
    console.error("FATAL: theme harness teardown failed:", error);
    app.exit(2);
  }
}

/* A HANG DETECTOR, NOT A PERFORMANCE BUDGET - and the difference is what the
   number has to respect. It sat at 180s while the suite ran 43s, which reads
   like ample headroom until a revert deliberately slows the product down:
   R300 stretches a themed transition past the settle budget, and since
   applySettled() then burns its full 60x50ms poll (plus one exec round-trip
   per poll) on every one of ~30 states, the run lands at roughly 183s. The
   watchdog fired FIRST, called finish(), and truncated the run before the
   settle assertion at the end of the suite was ever reported - so R300 came
   back WRONG-GUARD and the settle assertion silently had no proof at all.
   That is the worst failure mode available here: a truncated run still prints
   a count and still looks like a result.
   So the budget must outlast the slowest revert that legitimately depends on
   this suite, not merely the suite at rest. At 43s this leaves ~10x headroom
   for a real hang while keeping R300 provable. */
const watchdog = setTimeout(() => {
  check("harness completed within 420s", false, "watchdog fired");
  finish();
}, 420000);

// ─── THE AMENDMENTS ─────────────────────────────────────────────────────────
// Keyed mode -> token class-set -> property -> { was, now, why }. `was` is
// asserted against the golden too, so an amendment whose premise has changed
// (the old value is no longer what the golden records) fails rather than
// silently excusing whatever is there now.
const TOKEN_AMENDMENTS = {
  dark: {
    "entity.named-entity@": {
      backgroundColor: {
        was: "rgb(238, 232, 213)",
        now: "rgb(58, 58, 58)",
        why: "Solarized base2 cream, a LIGHT swatch painted behind entities on a dark page. It leaked in because the dark block overrode color only.",
      },
    },
    // Three keys, one decision. The census key carries the ancestor token chain,
    // so a namespace inside a tag, inside an attr-name, and bare are separate
    // cells - which is the whole point, since in LIGHT mode those three have
    // three different colours. The opacity amendment applies to all of them.
    "namespace@tag>tag": { opacity: NAMESPACE_OPACITY_AMENDMENT() },
    "namespace@tag>attr-name": { opacity: NAMESPACE_OPACITY_AMENDMENT() },
    "namespace@": { opacity: NAMESPACE_OPACITY_AMENDMENT() },
  },
};

function NAMESPACE_OPACITY_AMENDMENT() {
  return {
    was: "0.7",
    now: "1",
    why: "Solarized dims namespaces to .7 and index.html linked ONLY that light file; the dark block declared no opacity rule at all, so the .7 was never a dark-theme decision. Full opacity is.",
  };
}

// BOX_AMENDMENTS is EMPTY, deliberately, and that is a decision rather than an
// omission. It used to hold one entry: dark `preCode` background
// rgb(45,45,45) -> transparent, on the reasoning that the <code> was repainting
// the identical colour already behind its <pre>. That reasoning is true for a
// HIGHLIGHTED block, where `pre[class*=language-]` carries --code-bg, and FALSE
// for a <pre><code> PrismJS never touches: nothing paints that <pre>, so the
// <code> WAS the dark panel. `--code-pre-code-bg` restores it per mode, which
// makes the highlighted case byte-exact too and leaves nothing to amend.
// DECIDED_AMENDMENTS below is what stops this emptiness from being silent.
const BOX_AMENDMENTS = {};

// ::selection is not on any element, so it is amended as a cascade rule rather
// than a token tuple. The old value was Solarized navy in BOTH modes, which is
// very nearly invisible against the #2d2d2d dark code background.
//
// THE ALPHA WAS BRIEFLY RE-DERIVED AND THEN RESTORED, and the round trip is
// recorded rather than tidied away because it is the most instructive thing
// about this cell. Section 10l composited the tint and measured the worst
// TOKEN at 2.48:1 through it, so the alpha was lowered to 18% to protect those
// tokens. The tokens were the wrong subject: the app-wide ::selection rule
// declares a colour, so selected code is repainted in ONE flat ink and the
// syntax palette underneath is never seen (captured pixels: 1264 distinct
// colours unselected, 128 selected). Legibility is owned by
// --code-selection-fg, the alpha only controls how visible the highlight is,
// and 35% is what makes it visible - measured 1.95:1 against the code
// background at 35% against 1.39:1 at 18%. Both the original fault and the
// round trip are kept here rather than overwritten, because `was` is what
// stops the amendment becoming a licence to differ.
const DARK_CODE_SELECTION = {
  was: "rgb(7, 54, 66)",
  now: "rgba(61, 189, 198, 0.35)",
};

// THE LEDGER, and it exists because every "applied exactly the decided
// amendments" assertion is structurally unfailable for a mode/part with no
// declared amendment: it compares [] against []. That is harmless while the
// tables are believed correct and worthless as a guard - emptying a table, or
// never adding an entry for a whole mode, is invisible.
//
// So the tables are pinned to the DECISION rather than to themselves. These are
// coordinates (mode/key.property), not decisions: the three namespace keys are
// one decision recorded three times, because the census key carries the
// ancestor token chain.
/* THE MEASURED SIZE OF THE DERIVED REQUIRED LIST. Pinned rather than floored -
   see the note printed beside the assertion that consumes it. */
const REQUIRED_COUNTS = { light: 61, dark: 61 };

const DECIDED_AMENDMENTS = [
  "dark/entity.named-entity@.backgroundColor",
  "dark/namespace@.opacity",
  "dark/namespace@tag>attr-name.opacity",
  "dark/namespace@tag>tag.opacity",
  "dark/::selection.background",
];

// THE CHROME LEDGER, and it exists because the register above cannot hold this
// kind of entry at all. DECIDED_AMENDMENTS covers the frozen SYNTAX defaults -
// token tuples, code-box parts and the code ::selection rule - so an appearance
// change to the app's own menu chrome had nowhere to be recorded, and both
// models of the fourth review round independently reported the mode rows as an
// undeclared deviation. They were right on the substance: the Light / Dark /
// Follow Desktop rows predate this feature and this work rebuilt their tick
// gutter underneath them.
//
// `was` IS A MEASUREMENT, NOT A RECOLLECTION. The insets were read off the live
// menu with the old declarations restored (that restoration is revert R364),
// which is what makes the stated reason checkable rather than asserted: the
// hand-tuned `margin-right: 6px` / `20px` pair never aligned the three mode
// rows with EACH OTHER, so the ticked row's label sat 6px left of the other two
// and that jitter travelled down the menu as the reader changed mode.
//
// IT IS KEYED BY TICK STATE, NOT BY MODE, and that correction came out of a
// review round. The reading was originally recorded as
// `{ light: 34, dark: 40, desktop: 40 }`, which reads as a fact about the light
// row - but the 34 belongs to whichever row was TICKED when the capture was
// taken, and light was merely the stored mode at the time. Re-measuring the
// identical defect under a stored mode of dark would legitimately have produced
// `{ light: 40, dark: 34, desktop: 40 }`, so a premise stated that way changes
// with state that has nothing to do with the defect. Keyed by tick state the
// same numbers say what was actually seen, and `inactive` is a pair because two
// rows are unticked at any moment and both were measured at 40.
const CHROME_AMENDMENTS = [
  {
    id: "mode-row tick gutter",
    was: { active: 34, inactive: [40, 40] },
    now: "the same fixed 12px tick box the scheme rows use",
    why: "the old margin pair left the ticked row's label 6px left of the other two",
  },
];

function declaredAmendmentCoords() {
  const out = [];
  for (const [mode, keys] of Object.entries(TOKEN_AMENDMENTS)) {
    for (const [key, props] of Object.entries(keys)) {
      for (const prop of Object.keys(props)) out.push(`${mode}/${key}.${prop}`);
    }
  }
  for (const [mode, parts] of Object.entries(BOX_AMENDMENTS)) {
    for (const [part, props] of Object.entries(parts)) {
      for (const prop of Object.keys(props)) out.push(`${mode}/box:${part}.${prop}`);
    }
  }
  if (DARK_CODE_SELECTION) out.push("dark/::selection.background");
  return out.sort();
}

function amendmentFor(mode, key, prop) {
  const m = TOKEN_AMENDMENTS[mode];
  return m && m[key] && m[key][prop];
}

// The exact tree the baseline was measured from. Pinned by VALUE, not by shape:
// checking only that it is 40 hex characters asks "is this a commit id?" when
// the question is "is this THE commit?". A golden regenerated against the
// changed tree and stamped with any plausible sha would have passed the shape
// check, and every revert R259-R265 would have gone VACUOUS behind it.
const BASELINE_COMMIT = "4bbde83aa92a1c1a360925b183308b477254667b";

// BORDER WIDTH IS THE ONLY DEVICE-PIXEL-SNAPPED QUANTITY IN THE GOLDEN, so it
// is the only one whose CSS-pixel value depends on the DISPLAY the golden was
// captured on rather than on the product. `.markdown-body pre` declares
// `border: 1px` (styles.css); Chromium snaps a used border width to whole
// device pixels, so that one declaration computes to 0.666667px at DPR 1.5 and
// 0.8px at DPR 1.25 - two spellings of the SAME appearance, one device pixel.
// Comparing the CSS strings therefore asserts a fact about the MACHINE. It bit
// for real: the golden was captured on a 150%-scaled display and the four
// `pre`/`preNoLang` assertions began failing the day the display moved to 125%,
// on the unmodified tree, with nothing about the product changed.
//
// The fix needs the golden's capture DPR, which the golden does not record and
// cannot be made to - it is frozen at BASELINE_COMMIT and re-capturing it here
// would simply re-baseline these four numbers onto THIS display and break again
// on the next one. So it is DERIVED, and the derivation is asserted rather than
// asserted-by-comment: every golden border width must be a whole number of
// device pixels at this DPR, and every non-zero one must be exactly ONE (which
// is what `border: 1px` produces at any DPR < 2). That pins the value
// uniquely - 0.666667 x 3 is also a whole number, but it is 2, not 1 - so a
// wrong GOLDEN_DPR fails loudly instead of silently excusing a real regression.
const GOLDEN_DPR = 1.5;
const SNAPPED_BOX_PROPS = [
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
];

// THE SNAPPING LAW, MEASURED rather than assumed (a DPR sweep under
// --force-device-scale-factor on this Electron/Chromium, declared -> used):
//
//   declared |  dpr 1  |  1.25   |   1.5    |   1.75   |    2    |   2.5   |  3
//   ---------+---------+---------+----------+----------+---------+---------+------
//     0.25px | 1px/1dp | 0.8px/1 | 0.667/1  | 0.571/1  | 0.5px/1 | 0.4px/1 | .33/1
//        1px | 1px/1dp | 0.8px/1 | 0.667/1  | 0.571/1  | 1px/2dp | 0.8px/2 | 1px/3
//        2px | 2px/2dp | 1.6px/2 | 2px/3dp  | 1.714/3  | 2px/4dp | 2px/5dp | 2px/6
//
// Two facts fall out of it, and BOTH are asserted below rather than trusted:
//   1. the used width is ALWAYS a whole number of device pixels
//      (used_css x dpr is an integer in every cell above), so rounding to
//      device pixels is LOSSLESS on this quantity, not lossy;
//   2. the count is `max(1, floor(declared x dpr))` - so ONE declaration does
//      NOT keep a constant device-pixel count across displays. `border: 1px`
//      is 1 device px below DPR 2 and 2 device px at DPR 2. Comparing raw
//      device-pixel counts would therefore have re-broken these same four
//      assertions on any 200%-scaled display (a 4K laptop's default), which is
//      simply the first bug wearing the opposite sign.
//
// So the comparison is made on the only quantity that IS display-independent:
// the set of DECLARED widths that could have produced the observation. From a
// used count of n device pixels at some DPR, the declaration lay in
// [n/dpr, (n+1)/dpr) - or in (0, 2/dpr) when n is 1, because the `max(1, ...)`
// floor means any positive declaration below one device pixel is drawn as one.
// Two observations agree iff those bands INTERSECT. That is exactly as
// sensitive as the available information allows: it accepts every declaration
// consistent with both readings and rejects every one that is not, at any DPR.
// NOTE ON THE DIRECTION, because the two laws are easy to conflate and a
// reviewer did: `max(1, floor(declared x dpr))` above is the FORWARD law, from
// an author's declaration to the pixels Chromium paints. deviceWidth() runs the
// INVERSE - its input is a CSSOM computed value, which is already the snapped
// used width - so it must ROUND, not floor. At DPR 1.5 the used value reads
// back as "0.666667px" and 0.666667 x 1.5 = 0.9999995: floor would report 0
// device pixels for a border that is plainly drawn, and declaredBand would then
// return the zero band and call it a mismatch. Rounding is not a loosening
// here; it is the correct inverse of a quantity the engine already quantised.
const deviceWidth = (cssLength, dpr) => Math.round(parseFloat(cssLength) * dpr);
const declaredBand = (cssLength, dpr) => {
  const n = deviceWidth(cssLength, dpr);
  if (n === 0) return [0, 0]; // only a zero declaration paints zero pixels
  return [n === 1 ? 0 : n / dpr, (n + 1) / dpr];
};
// THE LIMIT THIS BUYS, recorded because it is a real loss and not an oversight.
// The n === 1 band is [0, 2/dpr), so below DPR 2 a regression from `border:1px`
// to `border:0.5px` or `0.25px` is INVISIBLE here - all three paint one device
// pixel and no observation can separate them. The old string comparison did
// catch that, but only at exactly the golden's capture DPR and only by
// accident: it equally reported a false failure whenever the display scaling
// changed, which is the defect this replaced. Sub-device-pixel border
// declarations are not something any scheme here uses, so the trade is
// deliberate; a scheme that starts using them needs its own assertion on the
// DECLARED value, which no computed-style reading can supply.
const snappedWidthsAgree = (goldenCss, goldenDpr, liveCss, liveDpr) => {
  const a = declaredBand(goldenCss, goldenDpr);
  const b = declaredBand(liveCss, liveDpr);
  if (a[1] === 0 || b[1] === 0) return a[1] === b[1];
  return a[0] < b[1] - 1e-9 && b[0] < a[1] - 1e-9;
};

// The measured sweep above, kept verbatim so the portability of the comparator
// is proven against REAL Chromium output rather than against a model of it.
const SNAP_SWEEP_DPRS = [1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const SNAP_SWEEP = {
  // `border: 1px` - what `.markdown-body pre` actually declares.
  thin: ["1px", "0.8px", "0.666667px", "0.571429px", "1px", "0.8px", "1px"],
  // `border: 2px` - the regression R424 installs, at the same seven displays.
  thick: ["2px", "1.6px", "2px", "1.71429px", "2px", "2px", "2px"],
};

require("../src/main.js");

async function checkContextMenuViewport(win, exec) {
  const bounds = win.getBounds();
  const size = win.getContentSize();
  const prefix = `theme-context-viewport-${process.pid}-${Date.now()}`;
  const shots = [];
  const savedMenu = await exec(`(() => {
    const menu = document.getElementById("contextMenu");
    return [menu, ...menu.querySelectorAll("*")].map(el => ({
      className: el.getAttribute("class"), style: el.getAttribute("style"),
    }));
  })()`);
  const frames = () => exec(`new Promise(r => requestAnimationFrame(() =>
    requestAnimationFrame(() => r(true))))`);
  const resize = async (width, height) => {
    win.setContentSize(width, height);
    let previous = "";
    let stable = 0;
    let measured;
    await waitFor(async () => {
      await frames();
      measured = await exec(`({ width: innerWidth, height: innerHeight })`);
      const current = JSON.stringify(measured);
      stable = current === previous ? stable + 1 : 0;
      previous = current;
      const native = win.getContentSize();
      return stable > 0 && Math.abs(native[0] - measured.width) <= 1 &&
        Math.abs(native[1] - measured.height) <= 1;
    }, "true", "context-menu resize reaches the renderer", 4000);
    return measured;
  };
  function probe(action, x, y) {
    const menu = document.getElementById("contextMenu");
    const viewer = document.getElementById("viewer");
    const rect = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
        width: r.width, height: r.height };
    };
    if (action === "open") {
      document.body.click();
      viewer.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
      }));
      for (const animation of menu.getAnimations()) animation.finish();
    } else if (action === "scroll") menu.scrollTop = menu.scrollHeight;
    else if (action === "document-scroll") {
      document.dispatchEvent(new Event("scroll"));
    } else if (action === "escape") {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } else if (action === "select") {
      document.getElementById("ctxSelectAll").click();
    }
    const rows = [...menu.querySelectorAll(".context-menu-item")];
    const visible = rows.filter((el) => getComputedStyle(el).display !== "none");
    const r = rect(menu);
    const hit = (el) => {
      const b = rect(el);
      const left = Math.max(b.left, r.left + menu.clientLeft);
      const right = Math.min(b.right, r.left + menu.clientLeft + menu.clientWidth);
      const top = Math.max(b.top, r.top + menu.clientTop);
      const bottom = Math.min(b.bottom, r.top + menu.clientTop + menu.clientHeight);
      if (right - left < 1 || bottom - top < 1 || top < 0 || left < 0 ||
          bottom > innerHeight + 1 || right > innerWidth + 1) return false;
      const target = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return !!target && (target === el || el.contains(target));
    };
    return {
      rect: r, width: innerWidth, height: innerHeight,
      open: menu.classList.contains("visible"),
      scrollTop: menu.scrollTop, scrollHeight: menu.scrollHeight,
      clientHeight: menu.clientHeight, clientWidth: menu.clientWidth,
      scrollWidth: menu.scrollWidth, overflow: getComputedStyle(menu).overflowY,
      inventory: rows.map((el) => [el.id, el.textContent.trim()]),
      visible: visible.map((el) => el.id),
      lastHit: hit(document.getElementById("ctxSelectAll")),
      selected: window.getSelection().toString(),
      viewerText: viewer.innerText,
    };
  }
  const read = (action, x = 0, y = 0) =>
    exec(`(${probe.toString()})(${JSON.stringify(action)}, ${x}, ${y})`);
  const bounded = (state) => state.open && state.rect.width > 0 && state.rect.height > 0 &&
    state.rect.left >= 9 && state.rect.top >= 9 &&
    state.rect.right <= state.width - 9 && state.rect.bottom <= state.height - 9;
  const allReachable = async () => exec(`(async () => {
    const menu = document.getElementById("contextMenu");
    const rows = [...menu.querySelectorAll(".context-menu-item")]
      .filter(el => getComputedStyle(el).display !== "none");
    const misses = [];
    for (const row of rows) {
      row.scrollIntoView({ block: "nearest", inline: "nearest" });
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const b = row.getBoundingClientRect();
      const m = menu.getBoundingClientRect();
      const top = Math.max(b.top, m.top + menu.clientTop);
      const bottom = Math.min(b.bottom, m.top + menu.clientTop + menu.clientHeight);
      const left = Math.max(b.left, m.left + menu.clientLeft);
      const right = Math.min(b.right, m.left + menu.clientLeft + menu.clientWidth);
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      if (!menu.classList.contains("visible") || right <= left || bottom <= top ||
          b.left < m.left + menu.clientLeft - 1 ||
          b.right > m.left + menu.clientLeft + menu.clientWidth + 1 ||
          b.top < m.top + menu.clientTop - 1 ||
          b.bottom > m.top + menu.clientTop + menu.clientHeight + 1 ||
          !hit || !(hit === row || row.contains(hit))) misses.push(row.id);
    }
    return { count: rows.length, misses, scrollTop: menu.scrollTop,
      open: menu.classList.contains("visible") };
  })()`);
  try {
    await resize(1000, 700);
    const ordinary = await read("open", 250, 150);
    check("context-viewport: actual right-click opens the unchanged command set (control)",
      ordinary.open && ordinary.visible.includes("ctxSelectAll") &&
        ordinary.visible.includes("ctxCopy") && ordinary.viewerText.trim().length > 0,
      JSON.stringify(ordinary));
    check("context-viewport: ordinary positioning keeps the requested point without scrolling",
      bounded(ordinary) && ordinary.rect.left === 250 && ordinary.rect.top === 150 &&
        ordinary.scrollHeight <= ordinary.clientHeight + 1, JSON.stringify(ordinary));
    for (const [x, y] of [[999, 699], [0, 0], [-50, -50], [999, 0], [0, 699]]) {
      const edge = await read("open", x, y);
      check(`context-viewport: edge ${x},${y} remains inside the viewport`,
        bounded(edge), JSON.stringify(edge));
    }
    shots.push(await captureScreenshot(win, `${prefix}-wide-edge`));
    const minimum = await resize(1, 340);
    const repeated = await resize(2, 340);
    check("context-viewport: two requests measure the actual OS minimum width (control)",
      minimum.width > 2 && minimum.width === repeated.width, JSON.stringify({ minimum, repeated }));
    const narrow = await read("open", repeated.width - 1, repeated.height - 1);
    shots.push(await captureScreenshot(win, `${prefix}-minimum-top`));
    check("context-viewport: minimum-width menu fits without losing or horizontally clipping commands",
      bounded(narrow) && narrow.scrollWidth <= narrow.clientWidth + 1 &&
        JSON.stringify(narrow.inventory) === JSON.stringify(ordinary.inventory) &&
        JSON.stringify(narrow.visible) === JSON.stringify(ordinary.visible), JSON.stringify(narrow));
    const narrowReach = await allReachable();
    check("context-viewport: every minimum-width command remains hit-testable after scrolling",
      narrowReach.count === ordinary.visible.length && narrowReach.misses.length === 0 &&
        narrowReach.open, JSON.stringify(narrowReach));
    shots.push(await captureScreenshot(win, `${prefix}-minimum-bottom`));
    await resize(1000, 180);
    const short = await read("open", 999, 179);
    check("context-viewport: the short-height setup actually needs vertical scrolling (control)",
      short.scrollHeight > short.height - 20, JSON.stringify(short));
    check("context-viewport: oversized height is a bounded vertical scrollport",
      bounded(short) && short.scrollHeight > short.clientHeight + 1 &&
        /auto|scroll/.test(short.overflow), JSON.stringify(short));
    await read("scroll");
    await frames();
    const scrolled = await read("inspect");
    check("context-viewport: actual menu scrolling keeps the final command hit-testable",
      scrolled.open && scrolled.scrollTop > 0 && scrolled.lastHit, JSON.stringify(scrolled));
    shots.push(await captureScreenshot(win, `${prefix}-short-bottom`));
    const shortReach = await allReachable();
    check("context-viewport: every oversized-height command remains reachable",
      shortReach.count === ordinary.visible.length && shortReach.misses.length === 0 &&
        shortReach.open, JSON.stringify(shortReach));
    await read("open", 999, 179);
    const reopened = await read("inspect");
    check("context-viewport: reopening starts at the first command",
      reopened.open && reopened.scrollTop === 0, JSON.stringify(reopened));
    await read("scroll");
    await frames();
    const beforeSelect = await read("inspect");
    await read("select");
    const selected = await read("inspect");
    check("context-viewport: the final Select All command still executes its real handler",
      beforeSelect.open && beforeSelect.lastHit &&
        selected.selected.replace(/\s+/g, " ").trim() ===
          selected.viewerText.replace(/\s+/g, " ").trim() &&
        selected.selected.trim().length > 0 &&
        !selected.open, JSON.stringify(selected));
    await exec(`window.getSelection().removeAllRanges()`);
    await read("open", 250, 100);
    const dismissed = await read("document-scroll");
    check("context-viewport: outside document scrolling still dismisses the menu (control)",
      !dismissed.open, JSON.stringify(dismissed));
    await read("open", 250, 100);
    const escaped = await read("escape");
    check("context-viewport: Escape still dismisses the menu (control)",
      !escaped.open, JSON.stringify(escaped));
    await exec(`document.getElementById("toggleEdit").click()`);
    await waitFor(exec, `document.querySelector(".content-wrapper").classList.contains("split-view")`,
      "real edit-mode entry enables the larger context menu");
    const editing = await read("open", 999, 179);
    check("context-viewport: the real edit-mode menu exposes additional commands (control)",
      editing.visible.includes("ctxBold") && editing.visible.includes("ctxInsertTable") &&
        editing.visible.length > ordinary.visible.length &&
        JSON.stringify(editing.inventory) === JSON.stringify(ordinary.inventory), JSON.stringify(editing));
    const editReach = await allReachable();
    check("context-viewport: every edit-mode command remains reachable in the short viewport",
      bounded(editing) && editReach.count === editing.visible.length &&
        editReach.misses.length === 0 && editReach.open, JSON.stringify({ editing, editReach }));
    await resize(1, 340);
    const narrowEdit = await read("open", 99, 339);
    const narrowEditReach = await allReachable();
    check("context-viewport: every edit-mode command remains reachable at minimum width",
      bounded(narrowEdit) && narrowEdit.scrollWidth <= narrowEdit.clientWidth + 1 &&
        narrowEditReach.count === editing.visible.length &&
        narrowEditReach.misses.length === 0 && narrowEditReach.open,
      JSON.stringify({ narrowEdit, narrowEditReach }));
    shots.push(await captureScreenshot(win, `${prefix}-minimum-edit-bottom`));
    const ordinaryWidths = [];
    for (const width of [320, 220, 221]) {
      await resize(width, 700);
      const state = await read("open", width - 1, 699);
      const reachable = await allReachable();
      ordinaryWidths.push({ width: state.width, rect: state.rect });
      check(`context-viewport: every edit-mode command fits at requested width ${width}`,
        bounded(state) && state.scrollWidth <= state.clientWidth + 1 &&
          reachable.count === editing.visible.length &&
          reachable.misses.length === 0 && reachable.open,
        JSON.stringify({ state, reachable }));
    }
    shots.push(await captureScreenshot(win, `${prefix}-ordinary-edit-bottom`));
    console.log(`  note: context-menu measured geometry: ${JSON.stringify({
      ordinary: ordinary.rect, minimum, minimumMenu: narrow.rect,
      shortViewport: [short.width, short.height], shortMenu: short.rect,
      shortScroll: [short.scrollHeight, short.clientHeight, scrolled.scrollTop],
      viewCommands: ordinary.visible.length, editCommands: editing.visible.length,
      minimumEditMenu: narrowEdit.rect,
      ordinaryWidths,
    })}`);
  } finally {
    await exec(`(() => {
      document.body.click();
      window.getSelection().removeAllRanges();
      if (document.querySelector(".content-wrapper").classList.contains("split-view")) {
        document.getElementById("toggleEdit").click();
      }
      const menu = document.getElementById("contextMenu");
      const saved = ${JSON.stringify(savedMenu)};
      [menu, ...menu.querySelectorAll("*")].forEach((el, i) => {
        for (const [key, value] of Object.entries(saved[i])) {
          const attr = key === "className" ? "class" : key;
          if (value === null) el.removeAttribute(attr); else el.setAttribute(attr, value);
        }
      });
    })()`);
    win.setBounds(bounds);
    await resize(...size);
  }
  console.log(`  note: context-menu viewport captures awaiting review: ${shots.filter(Boolean).join(", ")}`);
}

app.whenReady().then(async () => {
  try {
    const win = await waitForWindow(BrowserWindow);
    const exec = (js) => win.webContents.executeJavaScript(js);

    await checkContextMenuViewport(win, exec);

    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));

    // ─── 0. The baseline must be the pre-refactor one ───────────────────────
    // A golden generated from the tree it guards is circular, so its
    // independence has to be checkable rather than trusted.
    check(
      "the golden was captured from the pinned baseline commit",
      golden.capturedFromCommit === BASELINE_COMMIT,
      `${golden.capturedFromCommit} (expected ${BASELINE_COMMIT})`,
    );
    // AN INTRINSIC GATE, because the commit stamp is still just a claim made by
    // whoever ran the capture. This one is a property OF THE DATA: before the
    // refactor the code ::selection colour came from the vendored stylesheet and
    // was recorded as a literal `background: rgb(7, 54, 66)`. In the current
    // tree the very same rule serialises as `background: var(--code-selection-bg)`.
    // So a golden whose code ::selection is baked cannot have been produced by
    // the token system - no honest re-capture of the post-refactor tree can
    // forge it.
    const bakedSel = (golden.light.selection || []).filter(
      (r) => /language-/.test(r.selector) && !/var\(/.test(r.css),
    );
    check(
      "the golden predates the token system (its code ::selection is a baked colour, not a var)",
      bakedSel.length > 0,
      JSON.stringify((golden.light.selection || []).map((r) => r.css)),
    );
    check(
      "the golden is non-trivial (>= 40 token keys per mode)",
      Object.keys(golden.light.tokens).length >= 40 &&
        Object.keys(golden.dark.tokens).length >= 40,
      `${Object.keys(golden.light.tokens).length} light / ${Object.keys(golden.dark.tokens).length} dark`,
    );
    // Folded up from what used to be 26 separate "was measured in the golden"
    // checks. Those compared committed data to committed data - they could not
    // respond to any change under src/ - so they inflated the assertion count
    // without measuring the app. One structural gate says the same thing.
    const nullRecords = [];
    for (const mode of ["light", "dark"]) {
      for (const [part, v] of Object.entries(golden[mode].box)) {
        if (!v || typeof v !== "object") nullRecords.push(`${mode}.box.${part}`);
      }
      for (const [sel, v] of Object.entries(golden[mode].surfaces)) {
        if (!v || typeof v !== "object")
          nullRecords.push(`${mode}.surfaces.${sel}`);
      }
    }
    check(
      "every box and surface the golden claims to record is actually recorded",
      nullRecords.length === 0,
      `null (selector matched nothing, asserts nothing): ${nullRecords.join(", ")}`,
    );
    // THE CENSUS'S OWN LISTS, PINNED FROM OUTSIDE THE CENSUS.
    //
    // The shape gate below compares the golden against TOKEN_PROPS / BOX_PROPS /
    // SURFACE_SELECTORS - but those are imported from theme-census.js, WHICH
    // ALSO DRIVES THE CAPTURE. Delete a property there and re-capture and the
    // probe measures less, the golden records less, the gate compares less, and
    // every assertion in this file still passes. Re-capture is not a
    // hypothetical path: this golden has been re-captured five times, and the
    // recipe for doing it is written down.
    //
    // That is this suite's recurring defect for the third time - AN EXPECTATION
    // DRAWN FROM THE THING UNDER TEST IS NOT AN EXPECTATION. (First: the token
    // comparison iterated the golden's own property list. Second: the
    // attribution names existed in two places, so trimming one left all four
    // present and the revert came back vacuous.) The remedy has been the same
    // every time: take the subject list from a source that does not move when
    // the subject moves.
    //
    // So these are a SECOND, INDEPENDENT copy living in the asserting file.
    // Editing theme-census.js alone now fails here; widening or narrowing the
    // census means editing both, and that second edit IS the decision being
    // recorded. Sorted, so a reordering of either list is not a failure.
    const PINNED_TOKEN_PROPS = [
      "backgroundColor",
      "color",
      "cursor",
      "fontStyle",
      "fontWeight",
      "opacity",
    ];
    const PINNED_BOX_PROPS = [
      "backgroundColor",
      "borderBottomColor",
      "borderBottomStyle",
      "borderBottomWidth",
      "borderLeftColor",
      "borderLeftStyle",
      "borderLeftWidth",
      "borderRadius",
      "borderRightColor",
      "borderRightStyle",
      "borderRightWidth",
      "borderTopColor",
      "borderTopStyle",
      "borderTopWidth",
      "boxShadow",
      "color",
      "fontFamily",
      "fontSize",
      "hyphens",
      "lineHeight",
      "margin",
      "overflow",
      "overflowWrap",
      "padding",
      "tabSize",
      "textAlign",
      "textShadow",
      "whiteSpace",
      "wordBreak",
      "wordSpacing",
    ];
    const PINNED_SURFACES = {
      body: ["backgroundColor", "color"],
      "#viewer": ["color"],
      "#viewer h1": ["borderBottomColor", "color"],
      "#viewer h2": ["borderBottomColor", "color"],
      "#viewer p": ["color"],
      "#viewer a": ["color"],
      "#viewer blockquote": ["backgroundColor", "borderLeftColor", "color"],
      "#viewer th": ["backgroundColor", "borderBottomColor", "color"],
      "#viewer td": ["backgroundColor", "color"],
      "#viewer tbody tr:first-child td": ["borderBottomColor"],
    };
    const sortedJSON = (a) => JSON.stringify(a.slice().sort());
    check(
      "the census measures exactly the token properties this suite pins",
      sortedJSON(TOKEN_PROPS) === sortedJSON(PINNED_TOKEN_PROPS),
      `census=${sortedJSON(TOKEN_PROPS)} pinned=${sortedJSON(PINNED_TOKEN_PROPS)} - narrowing the census and re-capturing would shrink coverage with every assertion still green, so the two lists are kept deliberately redundant`,
    );
    check(
      "the census measures exactly the code-box properties this suite pins",
      sortedJSON(BOX_PROPS) === sortedJSON(PINNED_BOX_PROPS),
      `census=${sortedJSON(BOX_PROPS)} pinned=${sortedJSON(PINNED_BOX_PROPS)}`,
    );
    {
      const shape = (o) =>
        JSON.stringify(
          Object.keys(o)
            .sort()
            .map((k) => [k, o[k].slice().sort()]),
        );
      check(
        "the census measures exactly the reading surfaces this suite pins",
        shape(SURFACE_SELECTORS) === shape(PINNED_SURFACES),
        `census=${shape(SURFACE_SELECTORS)} pinned=${shape(PINNED_SURFACES)}`,
      );
    }
    // THE GOLDEN'S SHAPE, not just its size. The token comparison in section 2
    // iterates `Object.entries(want)` - the GOLDEN's own property list - so a
    // record that lost properties compares fewer of them and passes, and a
    // record that lost all of them compares nothing at all. Neither the key
    // count (>= 40) nor section 1's key symmetry can see inside a record.
    // Section 3 already gates the box records this way, and its comment records
    // that the hole "already bit once when BOX_PROPS gained border/box-shadow";
    // tokens, boxes-as-a-set and surfaces never got the same treatment. The
    // expectation is the census's OWN exported constants, so widening the probe
    // without re-capturing fails here rather than silently measuring less.
    const shapeGaps = [];
    for (const mode of ["light", "dark"]) {
      const wantProps = JSON.stringify(TOKEN_PROPS.slice().sort());
      for (const [key, rec] of Object.entries(golden[mode].tokens)) {
        if (JSON.stringify(Object.keys(rec).sort()) !== wantProps) {
          shapeGaps.push(
            `${mode}.tokens[${key}] has ${JSON.stringify(Object.keys(rec).sort())}`,
          );
        }
      }
      for (const [part, rec] of Object.entries(golden[mode].box)) {
        const miss = BOX_PROPS.filter((p) => !rec || !(p in rec));
        if (miss.length) shapeGaps.push(`${mode}.box.${part} lacks ${miss.join(",")}`);
      }
      for (const [sel, props] of Object.entries(SURFACE_SELECTORS)) {
        const rec = golden[mode].surfaces[sel];
        if (!rec) {
          shapeGaps.push(`${mode}.surfaces.${sel} MISSING`);
          continue;
        }
        const miss = props.filter((p) => !(p in rec));
        if (miss.length) shapeGaps.push(`${mode}.surfaces.${sel} lacks ${miss.join(",")}`);
      }
    }
    check(
      "every golden record carries every property the census measures",
      shapeGaps.length === 0,
      `${shapeGaps.slice(0, 8).join(" | ")}${shapeGaps.length > 8 ? ` (+${shapeGaps.length - 8})` : ""} - a record missing a property is compared for the properties it still has and passes for the rest`,
    );

    /* STASH THE WELCOME SCREEN BEFORE ANYTHING RENDERS OVER IT.
       `.welcome` is #viewer's INITIAL content and every render path replaces
       #viewer's children - measured directly: 1 `.welcome` before a render and
       0 after. The census below renders a document, so from that moment on the
       whole --welcome-* surface family is absent from the DOM and any probe
       that walks querySelectorAll('*') is scanning a page that cannot contain
       it. Section 10 re-attaches this markup for its scheme scans. */
    const welcomeStash = await exec(`(() => {
      const w = document.querySelector('#viewer > .welcome');
      if (!w) return 0;
      window.__foliaWelcomeHTML = w.outerHTML;
      return w.querySelectorAll('*').length;
    })()`);
    check(
      "the welcome screen was captured before the first render replaced it",
      welcomeStash > 20,
      `${welcomeStash} nodes captured - section 10 re-attaches this markup to reach the --welcome-* surfaces, which no post-render DOM contains, so a failure here silently empties that coverage`,
    );

    const now = await captureBothModes(win);
    const liveDpr = await exec("devicePixelRatio");

    // ─── 1. The census still measures something ─────────────────────────────
    // A probe that matches nothing compares {} to {} and passes. Coverage is
    // asserted against the golden's own size, a measured relationship, rather
    // than a hand-picked floor that decays into a description of the status quo.
    // SYMMETRIC in both directions: a key that disappears means the fixture
    // stopped exercising a rule, and a key that APPEARS is a context the golden
    // never measured, which would otherwise be accepted silently whatever colour
    // it rendered.
    for (const mode of ["light", "dark"]) {
      const g = Object.keys(golden[mode].tokens);
      const n = Object.keys(now[mode].tokens);
      check(
        `${mode}: every token key in the golden still renders`,
        g.every((k) => n.includes(k)),
        `missing: ${g.filter((k) => !n.includes(k)).join(", ") || "none"}`,
      );
      check(
        `${mode}: no token key appears that the golden never measured`,
        n.every((k) => g.includes(k)),
        `unmeasured: ${n.filter((k) => !g.includes(k)).join(", ") || "none"}`,
      );
    }

    // ─── 2. Token tuples reproduce the golden, amendments aside ─────────────
    // The amendment tables are pinned to the recorded DECISION before they are
    // used as an oracle. Without this, "applied exactly the decided amendments"
    // is satisfied by a table that has been emptied, since it then compares an
    // empty observed list against an empty declared list.
    {
      const declared = declaredAmendmentCoords();
      const decided = DECIDED_AMENDMENTS.slice().sort();
      check(
        "the amendment tables declare exactly the decided deviations",
        JSON.stringify(declared) === JSON.stringify(decided),
        `declared=${JSON.stringify(declared)} decided=${JSON.stringify(decided)}`,
      );
    }
    for (const mode of ["light", "dark"]) {
      const diffs = [];
      const amended = [];
      for (const [key, want] of Object.entries(golden[mode].tokens)) {
        const got = now[mode].tokens[key];
        if (!got) continue; // reported by section 1
        for (const [prop, wantVal] of Object.entries(want)) {
          const gotVal = got[prop];
          if (gotVal === wantVal) continue;
          const am = amendmentFor(mode, key, prop);
          if (am && am.was === wantVal && am.now === gotVal) {
            amended.push(`${key}.${prop}`);
            continue;
          }
          diffs.push(`${key}.${prop}: golden=${wantVal} now=${gotVal}`);
        }
      }
      check(
        `${mode}: token appearance reproduces the golden exactly`,
        diffs.length === 0,
        diffs.slice(0, 12).join(" | ") + (diffs.length > 12 ? ` (+${diffs.length - 12})` : ""),
      );
      const expectedAmendments = Object.entries(TOKEN_AMENDMENTS[mode] || {})
        .flatMap(([k, props]) => Object.keys(props).map((p) => `${k}.${p}`))
        .sort();
      check(
        `${mode}: exactly the decided amendments applied, no more and no fewer`,
        JSON.stringify(amended.sort()) === JSON.stringify(expectedAmendments),
        `applied=${JSON.stringify(amended)} decided=${JSON.stringify(expectedAmendments)}`,
      );
    }

    // ─── 3. The code box survived losing the vendored stylesheet ────────────
    // SYMMETRY GATE FIRST, and it closes a real vacuity hole. The comparison
    // below iterates the GOLDEN's record and skips any part the golden lacks
    // (section 0 gates the records the golden DOES claim). So adding a probe to
    // the census without re-capturing compares nothing and reads as passing -
    // the exact disease this suite exists to prevent, and one that already bit
    // once when BOX_PROPS gained border/box-shadow. Asserted in both directions:
    // a part the golden has but the census dropped is lost coverage.
    for (const mode of ["light", "dark"]) {
      const gp = Object.keys(golden[mode].box).sort();
      const np = Object.keys(now[mode].box).sort();
      check(
        `${mode}: the golden records exactly the code-box parts the census probes`,
        JSON.stringify(gp) === JSON.stringify(np),
        `golden=${JSON.stringify(gp)} census=${JSON.stringify(np)}. Re-capture the golden from ${BASELINE_COMMIT}.`,
      );
    }
    // GOLDEN_DPR IS DERIVED, SO IT IS ASSERTED. See its declaration: the
    // comparison below reads the golden's snapped border widths in device
    // pixels, and a wrong capture DPR would turn a real regression into a
    // silent pass. This is the check that makes the constant a measurement
    // rather than a magic number, and it is falsifiable in both directions -
    // a golden captured at any other DPR fails it, and so does one whose
    // border declaration was ever something other than the thinnest line.
    {
      const bad = [];
      const parts = new Set();
      let seen = 0;
      let nonZero = 0;
      for (const mode of ["light", "dark"]) {
        for (const [part, rec] of Object.entries(golden[mode].box)) {
          for (const p of SNAPPED_BOX_PROPS) {
            if (!(p in rec)) continue;
            seen++;
            parts.add(`${mode}.${part}`);
            const css = parseFloat(rec[p]);
            if (css > 0) nonZero++;
            const dev = css * GOLDEN_DPR;
            const whole = Math.abs(dev - Math.round(dev)) < 1e-3;
            const oneOrNone = Math.round(dev) === 0 || Math.round(dev) === 1;
            if (!whole || !oneOrNone) {
              bad.push(`${mode}.${part}.${p}=${rec[p]} -> ${dev.toFixed(4)}dp`);
            }
          }
        }
      }
      check(
        `the golden's snapped border widths are whole device pixels at the derived capture DPR (${GOLDEN_DPR})`,
        seen === 48 && nonZero === 16 && parts.size === 12 && bad.length === 0,
        `${seen} width(s) over ${parts.size} box part(s), ${nonZero} non-zero ` +
          `(measured: 48 / 12 / 16), ${bad.length} inconsistent: ${bad.slice(0, 6).join(" | ")}`,
      );
    }
    // THE COUNTS ABOVE ARE EXACT, NOT FLOORS, and that is the whole point of
    // this block. `seen >= 48` was the first spelling and BOTH reviewers
    // flagged it independently: a count tolerates precisely the substitution
    // that goes wrong in practice - one box part losing its four border
    // properties while another gains four - and it also said nothing about how
    // many widths are NON-ZERO. Only the 16 non-zero entries pin GOLDEN_DPR at
    // all; the other 32 are "0px", which is a whole number of device pixels at
    // every DPR and would satisfy the derivation vacuously. Measured against
    // the frozen golden: 12 box parts x 4 properties = 48, of which 16 are
    // 0.666667px (pre and preNoLang, both modes) and 32 are 0px.

    // THE COMPARATOR IS PROVEN PORTABLE AT THE UNIT LEVEL, against the real
    // Chromium sweep recorded beside SNAP_SWEEP. This is deliberately NOT a
    // property of the display the harness happens to run on: it asserts that
    // ONE declaration reads as agreeing with itself across all seven displays,
    // and that a DOUBLED declaration is still caught on every one of them.
    // The first half is what stops the DPR >= 2 regression; the second is what
    // stops the fix being bought by making the comparison blind.
    //
    // THE SECOND HALF HOLDS THE GOLDEN AT GOLDEN_DPR AND SWEEPS ONLY THE LIVE
    // SIDE, because that is the real question and the general form is FALSE:
    // measured, a golden captured at DPR 1 observes `border: 1px` as one
    // device pixel, whose declared band is (0, 2px) - wide enough to contain a
    // 2px declaration as seen at DPR 1.25 (1.6px) or 1.75 (1.714px), so those
    // two pairings genuinely cannot be told apart. That is a limit of the
    // information in an unscaled capture, not a defect in the comparator, and
    // it is a second independent reason the capture DPR has to be pinned
    // rather than assumed. The golden is at 1.5, where all seven bite.
    {
      const sameFails = [];
      const missed = [];
      for (let i = 0; i < SNAP_SWEEP_DPRS.length; i++) {
        for (let j = 0; j < SNAP_SWEEP_DPRS.length; j++) {
          const [da, db] = [SNAP_SWEEP_DPRS[i], SNAP_SWEEP_DPRS[j]];
          const [ta, tb] = [SNAP_SWEEP.thin[i], SNAP_SWEEP.thin[j]];
          if (!snappedWidthsAgree(ta, da, tb, db))
            sameFails.push(`1px@${da}=${ta} vs 1px@${db}=${tb}`);
        }
      }
      const gi = SNAP_SWEEP_DPRS.indexOf(GOLDEN_DPR);
      for (let j = 0; j < SNAP_SWEEP_DPRS.length; j++) {
        const db = SNAP_SWEEP_DPRS[j];
        if (snappedWidthsAgree(SNAP_SWEEP.thin[gi], GOLDEN_DPR, SNAP_SWEEP.thick[j], db))
          missed.push(`2px@${db}=${SNAP_SWEEP.thick[j]}`);
      }
      check(
        "the snapped-width comparator reads one declaration as unchanged across every measured display scale",
        sameFails.length === 0 && SNAP_SWEEP_DPRS.length === 7,
        `Chromium ${process.versions.chrome} / Electron ${process.versions.electron}: ` +
          `${sameFails.length}/49 pairing(s) wrongly differ: ${sameFails.slice(0, 4).join(" | ")}`,
      );
      check(
        "the snapped-width comparator still catches a doubled border at every measured display scale",
        missed.length === 0 && gi >= 0,
        `Chromium ${process.versions.chrome} / Electron ${process.versions.electron}: ` +
          `GOLDEN_DPR=${GOLDEN_DPR} at sweep index ${gi}; ${missed.length}/7 doubled reading(s) wrongly agree: ${missed.join(" | ")}`,
      );
    }

    // THE LIVE SIDE OBEYS THE SAME SNAPPING LAW - a positive control, without
    // which the band arithmetic above is a model rather than a measurement.
    // It is also the assertion that answers "is rounding to device pixels too
    // coarse": it is not, because a used border width is ALWAYS a whole number
    // of device pixels, so the rounding is lossless. If a future Chromium ever
    // paints a fractional one, this fails and says so instead of silently
    // rounding the difference away.
    {
      const off = [];
      let checked = 0;
      for (const mode of ["light", "dark"]) {
        for (const [part, rec] of Object.entries(now[mode].box)) {
          if (!rec) continue;
          for (const p of SNAPPED_BOX_PROPS) {
            if (!(p in rec)) continue;
            checked++;
            const dev = parseFloat(rec[p]) * liveDpr;
            if (Math.abs(dev - Math.round(dev)) > 1e-3)
              off.push(`${mode}.${part}.${p}=${rec[p]} -> ${dev.toFixed(4)}dp`);
          }
        }
      }
      check(
        `every live snapped border width is a whole number of device pixels at this display's DPR (${liveDpr})`,
        checked === 48 && off.length === 0,
        `${checked} width(s) checked (measured: 48), ${off.length} fractional: ${off.slice(0, 4).join(" | ")}`,
      );
      console.log(
        `  note: snapped borders - golden ${GOLDEN_DPR}dpr / live ${liveDpr}dpr; ` +
          `48 widths over 12 box parts, 16 non-zero; live sample ` +
          `"${(now.light.box.pre || {}).borderTopWidth}" = ` +
          `${deviceWidth((now.light.box.pre || {}).borderTopWidth || "0px", liveDpr)}dp, ` +
          `golden "${golden.light.box.pre.borderTopWidth}" = ` +
          `${deviceWidth(golden.light.box.pre.borderTopWidth, GOLDEN_DPR)}dp`,
      );
    }

    // THE CONVERSION IS KEYED ON A LIST, SO THE LIST'S COMPLETENESS IS THE
    // REAL ASSERTION (N6). Sections 3 and 4 both compare a snapped width as a
    // band of declared widths - but only for the property NAMES
    // SNAPPED_BOX_PROPS happens to carry. A width recorded under any other
    // name (an outline, a column rule, a heading underline a future scheme
    // wants thicker) would fall straight back to the exact string comparison
    // and start failing on every display whose DPR is not the capture's, which
    // is the entire defect this work exists to remove - and it would do it
    // silently, because nothing else in the suite looks at the shape of the
    // golden's keys.
    //
    // The property NAME is a sound signal here rather than a guess: Chromium
    // snaps a USED border-style length to whole device pixels, and every such
    // property in the CSSOM is spelled `*Width`. `width` itself does not match
    // (capital W), which is deliberate - the box model's own width is not
    // recorded here at all.
    //
    // The count is PINNED, not floored. A floor would tolerate exactly the
    // substitution that matters - one width leaving the census while another
    // arrives - which is the same magic-number disease as the licence guard's
    // `> 200` against a real 220.
    {
      const unhandled = [];
      let widths = 0;
      for (const mode of ["light", "dark"]) {
        for (const [group, recs] of [
          ["box", golden[mode].box],
          ["surfaces", golden[mode].surfaces],
        ]) {
          for (const [key, rec] of Object.entries(recs || {})) {
            if (!rec) continue;
            for (const p of Object.keys(rec)) {
              if (!/Width$/.test(p)) continue;
              widths++;
              if (!SNAPPED_BOX_PROPS.includes(p))
                unhandled.push(`${mode}.${group}.${key}.${p}`);
            }
          }
        }
      }
      check(
        "every device-pixel-snapped length the golden records goes through the declared-width band, not a string comparison",
        widths === 48 && unhandled.length === 0,
        `${widths} *Width propert(ies) recorded across box+surfaces ` +
          `(measured: 48, all in the code box, none in surfaces); ` +
          `${unhandled.length} not in SNAPPED_BOX_PROPS: ${unhandled.slice(0, 6).join(" | ") || "none"}`,
      );
    }
    for (const mode of ["light", "dark"]) {
      for (const part of [
        "pre",
        "preCode",
        "inlineCode",
        "inlineLangCode",
        "preNoLang",
        "preNoLangCode",
      ]) {
        const want = golden[mode].box[part];
        const got = now[mode].box[part];
        if (!want) continue; // reported by section 0
        // Section 0 gates the GOLDEN's records. This gates the LIVE one: if the
        // fixture stopped producing the element, `got` is null and every
        // property lookup below would throw rather than report, turning a real
        // coverage loss into a confusing harness crash.
        if (!got) {
          check(
            `${mode}: the fixture still renders the "${part}" element`,
            false,
            "the census selector matched nothing, so nothing was compared",
          );
          continue;
        }
        const diffs = [];
        const amended = [];
        for (const [p, v] of Object.entries(want)) {
          if (got[p] === v) continue;
          // A snapped width is compared as the band of DECLARED widths that
          // could have produced it (see snappedWidthsAgree), so the two sides
          // may legitimately spell the same declaration differently when the
          // golden was captured on a differently-scaled display - including
          // across the DPR 2 boundary, where the device-pixel COUNT itself
          // changes. Everything else in BOX_PROPS is reported unsnapped by
          // getComputedStyle - padding 13px, margin 6.5px and border-radius
          // 3.9px all survive a DPR change untouched - so only these four need
          // the conversion.
          if (SNAPPED_BOX_PROPS.includes(p)) {
            if (snappedWidthsAgree(v, GOLDEN_DPR, got[p], liveDpr)) continue;
            const wb = declaredBand(v, GOLDEN_DPR);
            const gb = declaredBand(got[p], liveDpr);
            diffs.push(
              `${p}: golden=${v} (${deviceWidth(v, GOLDEN_DPR)}dp @${GOLDEN_DPR}, ` +
                `declared ${wb[0].toFixed(3)}-${wb[1].toFixed(3)}px) now=${got[p]} ` +
                `(${deviceWidth(got[p], liveDpr)}dp @${liveDpr}, ` +
                `declared ${gb[0].toFixed(3)}-${gb[1].toFixed(3)}px)`,
            );
            continue;
          }
          const am =
            BOX_AMENDMENTS[mode] &&
            BOX_AMENDMENTS[mode][part] &&
            BOX_AMENDMENTS[mode][part][p];
          if (am && am.was === v && am.now === got[p]) {
            amended.push(p);
            continue;
          }
          diffs.push(`${p}: golden=${v} now=${got[p]}`);
        }
        check(
          `${mode}: code box "${part}" reproduces the golden exactly`,
          diffs.length === 0,
          diffs.join(" | "),
        );
        const expected = Object.keys(
          (BOX_AMENDMENTS[mode] && BOX_AMENDMENTS[mode][part]) || {},
        ).sort();
        check(
          `${mode}: code box "${part}" applied exactly the decided amendments`,
          JSON.stringify(amended.sort()) === JSON.stringify(expected),
          `applied=${JSON.stringify(amended)} decided=${JSON.stringify(expected)}`,
        );
      }
    }

    // ─── 4. Reading surfaces are untouched ──────────────────────────────────
    // Nothing in this change was supposed to move prose, headings, tables or
    // blockquotes. Asserting it is how "I only touched syntax colours" stops
    // being a claim and becomes a measurement.
    for (const mode of ["light", "dark"]) {
      const diffs = [];
      for (const [sel, want] of Object.entries(golden[mode].surfaces)) {
        if (!want) continue; // reported by section 0
        const got = now[mode].surfaces[sel];
        if (!got) {
          diffs.push(`${sel}: no longer present`);
          continue;
        }
        for (const [p, v] of Object.entries(want)) {
          if (got[p] === v) continue;
          // THE SAME DPR-PORTABLE PATH AS THE CODE BOX ABOVE. Surfaces record
          // only colours today, so this branch is unreachable - but the
          // alternative is that the first scheme to give a heading rule or a
          // blockquote bar its own width reintroduces the display-dependent
          // string comparison here, silently, in the one section nobody would
          // think to look in. Keeping the two loops' comparison identical is
          // what stops that; the completeness assertion in section 3 is what
          // stops a width arriving under a name this list does not carry.
          if (SNAPPED_BOX_PROPS.includes(p)) {
            if (snappedWidthsAgree(v, GOLDEN_DPR, got[p], liveDpr)) continue;
            const wb = declaredBand(v, GOLDEN_DPR);
            const gb = declaredBand(got[p], liveDpr);
            diffs.push(
              `${sel}.${p}: golden=${v} (${deviceWidth(v, GOLDEN_DPR)}dp @${GOLDEN_DPR}, ` +
                `declared ${wb[0].toFixed(3)}-${wb[1].toFixed(3)}px) now=${got[p]} ` +
                `(${deviceWidth(got[p], liveDpr)}dp @${liveDpr}, ` +
                `declared ${gb[0].toFixed(3)}-${gb[1].toFixed(3)}px)`,
            );
            continue;
          }
          // Reached only when got[p] !== v - the equality case continued at the
          // top of the loop - so the condition that used to guard this push was
          // trivially true and has been dropped rather than left as a check
          // that cannot fail.
          diffs.push(`${sel}.${p}: golden=${v} now=${got[p]}`);
        }
      }
      check(
        `${mode}: reading surfaces reproduce the golden exactly`,
        diffs.length === 0,
        diffs.slice(0, 10).join(" | "),
      );
    }

    // ─── 5. Code ::selection ────────────────────────────────────────────────
    // MEASURED END-TO-END, via getComputedStyle(el, '::selection'). An earlier
    // version of this block asserted two proxies instead, and both were
    // satisfiable by the wrong thing:
    //   - "resolves through a variable" tested the joined CSS TEXT of the
    //     matching rules against an unanchored /var\(\s*--code-selection-bg/,
    //     so a typo'd `--code-selection-bgg` matched the prefix and passed;
    //   - "is the amended value" read getComputedStyle(pre).getPropertyValue(
    //     '--code-selection-bg'), i.e. the VARIABLE DECLARATION, which cannot
    //     tell "the rule consumes it" from "the variable exists".
    // So breaking the consuming rule - a typo, or `background` changed to
    // `color` - left the suite green while code selection silently fell back to
    // the app-wide accent. The comment justifying that design claimed
    // getComputedStyle could not see ::selection; measured in Electron 43, it
    // can, and the golden now records it for both modes.
    for (const mode of ["light", "dark"]) {
      const want = golden[mode].selectionComputed;
      const got = now[mode].selectionComputed;
      const diffs = [];
      for (const part of ["pre", "preCode", "body"]) {
        const w =
          mode === "dark" && part !== "body" ? DARK_CODE_SELECTION.now : want[part];
        if (got[part] !== w) diffs.push(`${part}: expected=${w} now=${got[part]}`);
      }
      check(
        `${mode}: ::selection paints what the golden recorded`,
        diffs.length === 0,
        diffs.join(" | "),
      );
      /* THE FOREGROUND, AND ITS ABSENCE WAS THE ONE FINDING BOTH REVIEWERS
         REACHED INDEPENDENTLY. The census recorded backgroundColor alone, so
         the ink half of the frozen defaults' selection was byte-exact only by
         ARGUMENT - the argument being that 4bbde83's app-wide rule declared a
         literal `color: #ffffff` and --on-accent-fg did not yet exist. That
         argument is sound and it is still written down in styles.css, but an
         argument is not a measurement: moving --code-selection-fg to #e8e8e8
         moved no assertion in the suite.
         It is deliberately NOT amended in either default. The F1 fix changed
         WHERE the ink comes from (a named --code-selection-fg instead of the
         app-wide --on-accent-fg) without changing WHAT it is, so both modes
         must still reproduce the golden exactly, and this is the assertion
         that says so. */
      const fgKeys = ["pre", "preCode", "body"].map((p) => p + "Fg");
      const missingFg = fgKeys.filter((k) => !want[k]);
      const fgDiffs = fgKeys.filter((k) => got[k] !== want[k]);
      check(
        `${mode}: ::selection paints the golden's INK, not just its fill`,
        missingFg.length === 0 && fgDiffs.length === 0,
        missingFg.length
          ? `the golden carries no foreground for [${missingFg.join(", ")}] - re-capture it, do not relax this`
          : fgDiffs.map((k) => `${k}: golden=${want[k]} now=${got[k]}`).join(" | "),
      );
      /* THE ARGUMENT ABOVE, TURNED INTO A MEASUREMENT, using data already in
         the golden. The objection a review round raised is exact and it is not
         answered by the check above: the `*Fg` entries were captured AFTER the
         ink moved to --code-selection-fg, so they are a RE-BASELINE and cannot
         by themselves prove the pre-change value. Every other amendment in
         this suite carries a `was` (see DARK_CODE_SELECTION); the ink has
         none, and none can now be captured.

         AN EARLIER REVISION OF THIS COMMENT RESCUED THAT WITH A CLAIM THIS
         CHANGE FALSIFIES. It said `bodyFg` is painted by the app-wide
         ::selection rule "which this change never touched". A later review
         round measured the rule and it is touched:
           4bbde83:  ::selection { background: var(--primary-color); color: #ffffff; }
           now:      ::selection { background: var(--primary-color); color: var(--on-accent-fg); }
         So the equality below can be satisfied by BOTH halves moving together,
         and on its own it no longer states the byte-exactness claim.

         What actually preserves the ink is measured and pinned immediately
         after: --on-accent-fg is #ffffff at :root and is NOT redeclared on
         body.dark-mode, so both frozen defaults resolve the same white the
         baseline baked. Only the four scheme blocks move it. The equality
         below is still worth asserting - it catches a consuming rule that
         stops consuming - but it is the anchor assertion that carries the
         fidelity half. It is asserted on the two FROZEN DEFAULTS only: a
         curated scheme is entitled to a different selection ink for its code,
         and three of the four use one. */
      check(
        `${mode}: the frozen default's code selection ink is still the app-wide selection ink it used to inherit`,
        got.preFg === got.bodyFg && got.preCodeFg === got.bodyFg,
        `app-wide=${got.bodyFg} pre=${got.preFg} preCode=${got.preCodeFg}`,
      );
      /* THE ANCHOR THE EQUALITY LOST. Both halves of the equality above now
         resolve through --on-accent-fg, so the pre-change VALUE has to be
         pinned somewhere, and this is it: the literal the baseline baked into
         the app-wide ::selection rule. It is read from the live cascade rather
         than from the stylesheet text so a scheme block leaking into a frozen
         default would fail it too.

         THE MODE MUST BE APPLIED BEFORE THIS READ, and for a long time it was
         not. Everything else in this loop reads the CAPTURED census, which
         carries its own per-mode snapshot; this is the only LIVE read in the
         section, and captureBothModes() runs light-then-dark and therefore
         leaves the page in DARK. So both iterations measured dark, and the
         `light:` assertion was a duplicate of the `dark:` one - a
         mode-scoped redeclaration in the light `body` block would have gone
         green. R403 is the proof. The state is restored below so the sections
         that follow still start from the mode they have always started from. */
      await exec(applyModeInPage(mode));
      await waitFor(
        exec,
        `document.body.classList.contains('dark-mode') === ${mode === "dark"}`,
        `${mode} mode for the --on-accent-fg read`,
      );
      const onAccent = await exec(
        `getComputedStyle(document.body).getPropertyValue('--on-accent-fg').trim()`,
      );
      check(
        `${mode}: the frozen default still resolves --on-accent-fg to the white the baseline baked`,
        onAccent === "#ffffff",
        `--on-accent-fg=${onAccent} in ${await exec("document.body.classList.contains('dark-mode') ? 'dark' : 'light'")} mode (baseline ::selection baked color: #ffffff)`,
      );
    }
    // Put the page back where captureBothModes() left it. The read above is the
    // only thing in this section that moves the mode, and every later section
    // was written against a dark page.
    await exec(applyModeInPage("dark"));
    await waitFor(
      exec,
      `document.body.classList.contains('dark-mode') === true`,
      "dark mode restored after the --on-accent-fg reads",
    );
    // The dark amendment's premise, asserted against the golden like every
    // other one: the old value must really have been the near-invisible navy.
    check(
      "the dark ::selection amendment still describes the golden",
      golden.dark.selectionComputed.pre === DARK_CODE_SELECTION.was,
      `amendment says was=${DARK_CODE_SELECTION.was}, golden says ${golden.dark.selectionComputed.pre}`,
    );
    // Cheap belt: the rule must still exist and must still route BOTH painted
    // properties through their variables, so a scheme can retint either.
    //
    // TWO THINGS HERE WERE WRONG AND A REVERT (R354) EXPOSED BOTH.
    //  1. It named only --code-selection-bg. The foreground is the half that
    //     was actually broken (see the comment on the rule in styles.css), so
    //     deleting `color: var(--code-selection-fg)` outright left this green.
    //  2. It was a `some()`. The product then shipped a `::-moz-selection`
    //     group beside the standard one, and one rule satisfying the claim let
    //     the other be broken - the recorded disjunction disease, where a claim
    //     whose subject can be supplied by more than one source measures
    //     neither. `every()` is what closes that, and it stays `every()` even
    //     though the moz group has since been deleted, because the collector is
    //     a filter over the live cascade and a future rule joining it must
    //     satisfy the claim too rather than hide behind this one.
    //
    // THE MOZ GROUP IS NOT CHECKED HERE, AND THAT IS A LIMIT OF THE ORACLE
    // RATHER THAN AN OMISSION: Chromium drops an unrecognised pseudo-element's
    // rule at parse time, so such a rule never enters document.styleSheets and
    // no CSSOM-based probe can see it. An assertion written over this list
    // could only ever report it as absent - which it did, failing on a clean
    // tree while a revert that "proved" it looked green. The group was deleted
    // for exactly that reason (styles.css records the measurement).
    const selRules = now.light.selection.filter((r) =>
      /language-/.test(r.selector),
    );
    const missingVars = [];
    for (const v of ["--code-selection-bg", "--code-selection-fg"]) {
      const re = new RegExp(`var\\(\\s*${v}\\s*[,)]`);
      if (!selRules.every((r) => re.test(r.css))) missingVars.push(v);
    }
    check(
      "every code ::selection rule consumes both selection variables",
      selRules.length > 0 && missingVars.length === 0,
      selRules.length === 0
        ? "no code ::selection rule reached the CSSOM at all"
        : `missing=${missingVars.join(",")} css=${selRules
            .map((r) => r.css)
            .join(" ")
            .slice(0, 200)}`,
    );

    // ─── 6. The amendments' premises still hold ─────────────────────────────
    // An amendment excuses a difference. If what it claims to be excusing is no
    // longer what the golden says, the excuse is stale and must not stand.
    for (const [mode, byKey] of Object.entries(TOKEN_AMENDMENTS)) {
      for (const [key, props] of Object.entries(byKey)) {
        for (const [prop, am] of Object.entries(props)) {
          const goldenVal =
            golden[mode].tokens[key] && golden[mode].tokens[key][prop];
          check(
            `amendment ${mode}/${key}.${prop} still describes the golden`,
            goldenVal === am.was,
            `amendment says was=${am.was}, golden says ${goldenVal}`,
          );
        }
      }
    }

    // ─── 7. The vendored theme link is really gone ──────────────────────────
    // The whole point of inlining is that styles.css is the only source. A
    // leftover <link> would load AFTER it and win every specificity tie, so the
    // theme variables would appear to work and then be overruled in light mode.
    const linkCount = await exec(`
      [...document.querySelectorAll('link[rel=stylesheet]')]
        .filter(l => /prism.*themes/i.test(l.getAttribute('href') || '')).length`);
    check(
      "no PrismJS theme stylesheet is linked",
      linkCount === 0,
      `${linkCount} such <link> elements`,
    );

    // ─── 8. The indirection is declared where it actually works ─────────────
    // A custom property containing var() is substituted on the element where it
    // is DECLARED. Declared on :root (that is <html>), a body-level scheme
    // override of a coarse role would never reach the fine variable and every
    // scheme would silently render default syntax colours. Measured in Electron
    // 43; this asserts the arrangement rather than trusting the comment.
    //
    // ALL NINE ROLES, ALL TWENTY-FIVE CELLS, and the breadth is the point. An
    // earlier version overrode two roles and read ONE fine cell (--tok-builtin,
    // chosen because the two modes map it from different roles, so the resolved
    // value names WHICH block answered). That pinned the scope question but
    // covered one ninth of "the surface a new scheme fills in": baking both
    // --tok-comment cells to their resolved literals severs --syn-comment
    // outright - no scheme could ever restyle comments through the coarse role -
    // with zero appearance change and zero assertions firing. Proven by
    // mutation, not supposed.
    //
    // So every role gets its own sentinel and every cell is checked against what
    // its OWN authored declaration implies. A cell reading var(--syn-X) must
    // resolve to X's sentinel; a cell holding a literal must be unmoved. The
    // authored side is read from the CSSOM rather than hard-coded here, so this
    // cannot drift out of step with the stylesheet - what it pins is that the
    // declaration is EFFECTIVE at body scope, while the golden pins that it
    // names the right role.
    //
    // A custom property's value is preserved as the author's literal token
    // stream - it is NOT re-serialised as a colour - so values are compared with
    // whitespace stripped rather than in getComputedStyle's "rgb(1, 2, 3)" form.
    const SYN_ROLES = [
      "comment",
      "punctuation",
      "operator",
      "keyword",
      "string",
      "literal",
      "tag",
      "function",
      "variable",
      // A BACKGROUND swatch rather than a foreground colour, and the reason it
      // is a role at all: see ROLE_FREE_CELLS below. The sentinel machinery
      // does not care - it substitutes an unmistakable literal and asks which
      // cells received it, which works the same for a background.
      "entity-bg",
    ];
    // Distinct, and distinguishable from any real palette value.
    const SENTINEL = {};
    SYN_ROLES.forEach((r, i) => {
      SENTINEL[`--syn-${r}`] = `rgb(${i + 1},0,0)`;
    });
    // PARKED BEFORE THE PROBE RUNS so that the probe's own park/restore is
    // FALSIFIABLE. The probe swaps body's data-theme for its own value and must
    // put back whatever it found; an earlier version deleted it unconditionally.
    // Nothing in the app sets data-theme yet, so that bug was inert - and a fix
    // whose absence changes nothing cannot be proven, it can only be asserted
    // by its author. This sentinel matches no rule (there are no scheme blocks
    // yet), so it cannot disturb a single measurement, but it must survive.
    await exec(`document.body.setAttribute('data-theme', '__parked__')`);
    const scopeProbe = JSON.parse(
      await exec(`(() => {
        const SENT = ${JSON.stringify(SENTINEL)};
        const decls = Object.entries(SENT)
          .map((kv) => kv[0] + ':' + kv[1])
          .join(';');
        const s = document.createElement('style');
        s.textContent = 'body[data-theme="__probe__"]{' + decls + '}';
        document.head.appendChild(s);
        const had = document.body.classList.contains('dark-mode');
        // BOTH pieces of state this probe disturbs must be PARKED, not assumed.
        // An earlier version saved the dark-mode class but removed data-theme
        // unconditionally, which is inert only while nothing sets it. That
        // attribute is exactly what the scheme blocks and the PDF-export
        // park/restore will use, so the moment a scheme is active this probe
        // would strip it and every later section would measure the DEFAULT
        // scheme under a name claiming otherwise - passing, and wrong.
        const hadTheme = document.body.getAttribute('data-theme');
        document.body.setAttribute('data-theme', '__probe__');
        const authoredIn = (selector) => {
          // EVERY --tok-* declaration in the document, with the selector that
          // made it. Deliberately NOT filtered to the block selector up front:
          // the failure this section exists to catch MOVES a declaration to
          // :root, and a probe that only looks at the body-level rule would
          // find the cell simply MISSING rather than wrong - it would drop out
          // of the list and stop being checked at all. That is how the
          // behavioural assertion below went unfalsifiable once, caught by R259
          // coming back WRONG-GUARD. The cell list is therefore
          // scope-independent and the scope is asserted separately.
          const seen = {};
          const at = {};
          const take = (rule, sel) => {
            for (const prop of rule.style) {
              if (prop.indexOf('--tok-') !== 0) continue;
              seen[prop] = rule.style.getPropertyValue(prop).trim();
              at[prop] = sel;
            }
          };
          const inherited = [];
          const matching = [];
          for (const sheet of document.styleSheets) {
            let rules;
            try { rules = sheet.cssRules; } catch (e) { continue; }
            for (const rule of rules || []) {
              if (!rule.style || !rule.selectorText) continue;
              let hits = false;
              try { hits = document.body.matches(rule.selectorText); } catch (e) { hits = false; }
              if (hits) matching.push(rule);
              // :root / html do not match <body>, but they still reach it by
              // inheritance - outbid by any rule that does match.
              else if (/^\s*(:root|html)\s*$/.test(rule.selectorText)) inherited.push(rule);
            }
          }
          inherited.forEach((r) => take(r, r.selectorText));
          matching.forEach((r) => take(r, r.selectorText));
          return { authored: seen, declaredAt: at, block: selector };
        };
        const readAll = (names) => {
          const cs = getComputedStyle(document.body);
          const out = {};
          for (const n of names) out[n] = cs.getPropertyValue(n).replace(/\\s+/g, '');
          return out;
        };
        const shot = (selector, dark) => {
          document.body.classList.toggle('dark-mode', dark);
          const a = authoredIn(selector);
          return {
            authored: a.authored,
            declaredAt: a.declaredAt,
            block: a.block,
            computed: readAll(Object.keys(a.authored)),
          };
        };
        const light = shot('body', false);
        const dark = shot('body.dark-mode', true);
        document.body.classList.toggle('dark-mode', had);
        if (hadTheme === null) document.body.removeAttribute('data-theme');
        else document.body.setAttribute('data-theme', hadTheme);
        s.remove();
        return JSON.stringify({ light, dark });
      })()`),
    );
    {
      const parked = JSON.parse(
        await exec(`(() => {
          const v = document.body.getAttribute('data-theme');
          document.body.removeAttribute('data-theme');
          return JSON.stringify(v);
        })()`),
      );
      check(
        "the scope probe restores the data-theme it found instead of deleting it",
        parked === "__parked__",
        `data-theme came back as ${JSON.stringify(parked)} - the probe parks body's dark-mode class but must park this attribute too; once scheme blocks land, deleting it would silently drop every later section back to the DEFAULT scheme while still reporting the scheme's name`,
      );
    }
    for (const mode of ["light", "dark"]) {
      const { authored, computed, declaredAt, block } = scopeProbe[mode];
      const cells = Object.keys(authored);
      check(
        `${mode}: the probe found every fine cell the stylesheet declares`,
        cells.length === 25,
        `read ${cells.length} --tok-* declarations, expected 25 (see the THEME TOKENS header)`,
      );
      // THE SCOPE ASSERTION, and it is separate from the behavioural one on
      // purpose: this one names the CAUSE ("declared at :root") while the one
      // below reports the CONSEQUENCE (the override does not land). Between
      // them a single misplaced cell fails loudly and legibly instead of
      // quietly dropping out of the checked set.
      const misplaced = cells
        .filter((c) => declaredAt[c] !== block)
        .map((c) => `${c} is declared at "${declaredAt[c]}"`);
      check(
        `${mode}: every fine cell is declared at body scope, not :root`,
        misplaced.length === 0,
        `${misplaced.join(" | ")} - expected "${block}". A var() in a custom property is substituted on the element that DECLARES it, so a scheme override on <body> can never reach a cell declared on <html>.`,
      );
      const wrong = [];
      const rolesSeen = new Set();
      for (const cell of cells) {
        const m = authored[cell].match(/^var\((--syn-[a-z-]+)\)$/);
        let want;
        if (m) {
          rolesSeen.add(m[1]);
          want = (SENTINEL[m[1]] || "").replace(/\s+/g, "");
          if (!want) {
            wrong.push(`${cell}: names unknown role ${m[1]}`);
            continue;
          }
        } else if (authored[cell] === "inherit") {
          // `inherit` on a custom property takes html's value, and html declares
          // none, so it computes to the empty string. The consuming var() then
          // has no substitution and the property falls back to unset, which for
          // an inherited property is inherit - which is the intent. Section 9
          // pins these cells' painted result.
          want = "";
        } else {
          want = authored[cell].replace(/\s+/g, "");
        }
        if (computed[cell] !== want) {
          wrong.push(
            `${cell}: authored "${authored[cell]}" should resolve to "${want}" but read "${computed[cell]}"`,
          );
        }
      }
      check(
        `${mode}: a body-level role override reaches every fine cell it names`,
        wrong.length === 0,
        `${wrong.join(" | ")}. A ":root" declaration yields the ORIGINAL palette value instead of the sentinel.`,
      );
      const missingRoles = SYN_ROLES.map((r) => `--syn-${r}`).filter(
        (r) => !rolesSeen.has(r),
      );
      check(
        `${mode}: every coarse role is still reached by at least one fine cell`,
        missingRoles.length === 0,
        `${missingRoles.join(", ")} is declared but nothing consumes it, so a scheme could never restyle it`,
      );
      // THE OTHER DIRECTION, and it was missing. The assertion above walks
      // roles->cells, so a cell that names NO role is invisible to it: it
      // simply never joins rolesSeen. That is the shape of a real trap for
      // part 2 - a scheme fills every advertised role, and the cells that read
      // from none of them keep the DEFAULT scheme's literal. Entities on
      // Solarized cream is not a hypothetical; it is amendment 1 in the dark
      // block, which exists because precisely that leaked once already.
      //
      // So role-free cells are not banned - some are legitimate - but the set
      // is CLOSED and named. `inherit` records that the source theme wrote no
      // rule, which is a structural fact rather than a colour a scheme could
      // supply; --tok-namespace-opacity is not a palette entry. The two dark
      // literals ARE colours, kept deliberately because mapping them onto an
      // existing role would repaint them and the golden forbids that - so they
      // are listed as cells a scheme author must set by hand.
      //
      // Listed per mode, because the light and dark blocks genuinely differ
      // here: light's --tok-inserted DOES name a role and dark's does not.
      const ROLE_FREE_CELLS = {
        light: [
          "--tok-block-comment",
          "--tok-function-name",
          "--tok-namespace",
          "--tok-namespace-opacity",
          "--tok-operator",
        ],
        dark: [
          "--tok-function-name",
          "--tok-inserted",
          "--tok-namespace-opacity",
        ],
      };
      const roleFree = cells
        .filter((c) => !/^var\(--syn-[a-z-]+\)$/.test(authored[c]))
        .sort();
      check(
        `${mode}: exactly the listed fine cells read from no coarse role`,
        JSON.stringify(roleFree) === JSON.stringify(ROLE_FREE_CELLS[mode]),
        `found=${JSON.stringify(roleFree)} listed=${JSON.stringify(ROLE_FREE_CELLS[mode])} - a cell that names no role keeps this scheme's literal under EVERY future scheme, so adding one is a decision that has to be recorded here`,
      );
    }

    /* THE SUBSTITUTION-SCOPE GUARD, WIDENED PAST --tok-*. The two assertions
       above are the strongest guard in this file, and they were also the
       NARROWEST: their census filters on `prop.indexOf('--tok-') !== 0`, so
       four theme variables whose values contain var() were never scope-checked
       at all - --code-inline-bg, --code-inline-fg, --drop-overlay-fg and
       --welcome-readme-ink-hover. Move any one of them to :root and the
       defaults still look right (nothing overrides them today), a scheme can
       still override the variable DIRECTLY, and every existing assertion stays
       green - while a scheme that overrides only the ROLE it derives from
       silently stops reaching it. --welcome-readme-ink-hover is not a
       hypothetical example: a revert in this suite exists because exactly that
       move repainted the dark welcome screen.

       This one is family-agnostic on purpose. It asks the only question the
       Chromium rule actually cares about - does this declaration contain
       var(), and is it declared somewhere <body> can be reached from - so a
       token family invented next year is covered on the day it is added
       rather than when someone remembers to widen a prefix filter. */
    const varScope = JSON.parse(
      await exec(`(() => {
        const out = { rootish: [], bodyish: 0, total: 0, names: [] };
        /* RECURSES THROUGH CSSGroupingRule, because iterating only top-level
           cssRules made the sweep blind to anything inside @media or
           @supports - a --foo: var(--bar) declared at :root inside an
           @media block would be neither reported NOR counted, so it could
           not even move the pinned total. Both reviewers found this
           independently. There are no such rules today (measured), so this
           does not change the count; it makes the guarantee match the claim.

           SELECTOR LISTS ARE SPLIT for the same reason: the old test asked
           whether the WHOLE selectorText was exactly ":root" or "html", so
           ":root, .foo" - which declares on the document element and on
           nothing <body> can reach - classified as safe. */
        const walk = (rules) => {
          for (const rule of rules || []) {
            if (rule.cssRules) walk(rule.cssRules);
            if (!rule.style || !rule.selectorText) continue;
            const parts = rule.selectorText.split(',').map((s) => s.trim());
            const rootParts = parts.filter((p) => /^(:root|html)(?![\\w-])/.test(p));
            for (const prop of rule.style) {
              if (prop.indexOf('--') !== 0) continue;
              const val = rule.style.getPropertyValue(prop);
              if (!/\\bvar\\(/.test(val)) continue;
              out.total++;
              out.names.push(prop);
              if (rootParts.length)
                out.rootish.push(prop + ' @ ' + rule.selectorText);
              else out.bodyish++;
            }
          }
        };
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
          walk(rules);
        }
        out.names = [...new Set(out.names)].sort();
        return JSON.stringify(out);
      })()`),
    );
    console.log(
      `  note  var()-valued custom properties: ${varScope.total} declaration(s), ${varScope.names.length} distinct, ${varScope.rootish.length} at :root/html`,
    );
    /* Pinned to the measurement, not floored below it. A sweep that silently
       stopped matching would drop the count to 0, and an assertion of ABSENCE
       ("none at :root") passes on an empty set - the fail-open shape this
       suite has been bitten by before. */
    const VAR_SCOPE_COUNT = 59;
    check(
      "every custom property whose value contains var() is declared where <body> can reach it, never on :root",
      varScope.rootish.length === 0 && varScope.total === VAR_SCOPE_COUNT,
      `${varScope.total} var()-valued declaration(s) found (pinned ${VAR_SCOPE_COUNT}), ${varScope.bodyish} at body scope or deeper, ${varScope.rootish.length} at :root/html${
        varScope.rootish.length ? ": " + varScope.rootish.join(" | ") : ""
      } - a var() in a custom property is substituted on the element that DECLARES it, so one declared on <html> can never be re-pointed by a body[data-theme] scheme`,
    );

    // THE COMMENT'S NUMBER, MEASURED. src/styles.css claims in two places that
    // a specific number of the 25 fine cells map from a DIFFERENT coarse role
    // in dark than in light, and that claim is the entire justification for
    // declaring the mapping twice instead of once. It went stale the moment
    // --tok-entity-bg was promoted to a role: both blocks then read
    // var(--syn-entity-bg), the count fell from 16 to 15, and nothing noticed -
    // not this suite, not --anchors, not --expects, none of which can see a
    // stale number in prose. That is the same comment-rot that a revert's
    // rationale hit one round earlier. A number a reader is invited to trust
    // has to be measured or deleted, so this measures it.
    {
      const L = scopeProbe.light.authored;
      const D = scopeProbe.dark.authored;
      const differing = Object.keys(L)
        .filter((c) => L[c] !== D[c])
        .sort();
      check(
        "the per-mode mapping differs in exactly the number of cells the stylesheet claims",
        differing.length === 15,
        `${differing.length} cells differ (${differing.join(", ")}) but src/styles.css says 15, in the THEME TOKENS header and again above the dark mapping. If the mapping really changed, both comments and this number move together.`,
      );
    }

    // ─── 9. Rules no bundled grammar can reach ──────────────────────────────
    // `deleted` and `inserted` are emitted by NO bundled grammar (there is no
    // diff component, and the CSP is script-src 'self', so the bundled
    // autoloader cannot fetch one either). `block-comment` likewise appears in
    // no grammar, and neither does `bold` or `italic`. `function-name` is
    // emitted only by bash, and always with alias:function, so `.token.function`
    // - declared later - always wins on the real element. Measured, not assumed,
    // and re-derived against the file that actually ships: loading
    // libs/prismjs/prism-bundle.js (the ONE Prism file src/index.html loads) and
    // walking every grammar it registers for token names and aliases finds
    // `function-name` in bash alone, and none of the other five anywhere. The
    // walker was positive-controlled on keyword/string/comment/function, since
    // an absence check fails open. An earlier version of this note cited
    // libs/prismjs/components instead - the wrong artifact twice over: nothing
    // ever loaded it, and it could not have loaded (prism-clike.min.js was never
    // vendored, so 8 of its 14 language components could not resolve). It has
    // since been deleted.
    // All six therefore render nowhere in the
    // fixture and the golden CANNOT cover them: their declarations could be
    // changed to anything at all and every assertion above would stay green.
    //
    // They are still shipped rules, so they are measured directly by injecting
    // an element carrying the class into a real highlighted code block and
    // asking what it comes out as. That is an end-to-end check of the rule, not
    // a re-reading of the variable: it fails if the selector is dropped, if the
    // declaration stops consuming the variable, or if the rule is shadowed.
    //
    // Each case names the PROPERTY it is about, because two of these rules are
    // not about colour at all.
    //
    // THE EXPECTED VALUES ARE PINNED TO THE SHIPPED SOURCE, NOT DERIVED FROM THE
    // VARIABLE THE RULE CONSUMES. An earlier version read --tok-deleted and
    // asked whether the element painted that - which proves the rule is WIRED
    // but says nothing about whether it is wired to the RIGHT value, because
    // both sides of the comparison move together when the cell is edited. These
    // cells render nowhere, so the golden cannot supply the value either; it is
    // therefore taken from the two files that WERE the defaults, read out of the
    // pre-refactor tree:
    //
    //   light  git show 4bbde83:libs/prismjs/themes/prism-solarizedlight.css
    //          - the only PrismJS theme index.html ever linked
    //   dark   git show 4bbde83:src/styles.css, the body.dark-mode override
    //          block (prism-tomorrow.css was vendored but NEVER LINKED, so it
    //          was not the dark source despite carrying the same values)
    //
    // INHERIT means that file declares no rule for the class at all, so the
    // element took its enclosing colour. That is UNFALSIFIABLE by painting -
    // "no rule" and "color: inherit" are indistinguishable on the element - so
    // for those cells the DECLARATION is pinned separately below, and the
    // linkage is proven by the other mode, where the value is absolute.
    const REACHLESS = {
      deleted: { prop: "color", from: "--tok-deleted", light: "#268bd2", dark: "#e2777a" },
      inserted: { prop: "color", from: "--tok-inserted", light: "#2aa198", dark: "#8fa876" },
      "function-name": { prop: "color", from: "--tok-function-name", light: "INHERIT", dark: "#6196cc" },
      "block-comment": { prop: "color", from: "--tok-block-comment", light: "INHERIT", dark: "#999" },
      // Emitted by no bundled grammar either: `symbol` appears in the shipped
      // components only INSIDE TypeScript's `builtin` pattern, never as a token
      // name of its own. It was missing from this ledger and from the golden
      // both, which is the gap the closure assertion below now closes.
      symbol: { prop: "color", from: "--tok-constant", light: "#268bd2", dark: "#f8c555" },
      // No variable behind these two - the rule declares a literal - so the
      // literal itself is the ground truth. Deleting the selector or the
      // declaration drops the element back to the inherited value and fails.
      bold: { prop: "fontWeight", light: "bold", dark: "bold" },
      italic: { prop: "fontStyle", light: "italic", dark: "italic" },
    };
    // THE LEDGER IS NOW CLOSED, and until it was, it was a hand-written list
    // with nothing checking it against the CSS. The coverage argument this
    // whole suite rests on is "every styled token class is either measured by
    // the golden or pinned here". Nothing asserted it, so four classes fell
    // through both halves at once: `symbol` (styled, unreachable, unlisted) and
    // `char`/`prolog`/`cdata` (styled, REACHABLE, but absent from the fixture
    // so absent from the golden). Consequence: any of those four could be
    // deleted from its selector list and all assertions stayed green - the
    // exact selector-deletion failure R271/R275/R278 exist to catch.
    //
    // The styled set is read from document.styleSheets rather than by parsing
    // the file, so it is the CSS the app actually parsed, and it descends into
    // grouping rules so a class styled only inside @media still counts.
    const classGaps = JSON.parse(
      await exec(`(() => {
        const styled = new Set();
        const walk = (list) => {
          for (const r of list) {
            if (r.cssRules) walk(r.cssRules);
            if (!r.selectorText) continue;
            const re = /\\.token((?:\\.[a-zA-Z][a-zA-Z0-9-]*)+)/g;
            let m;
            while ((m = re.exec(r.selectorText))) {
              m[1].split('.').filter(Boolean).forEach((c) => styled.add(c));
            }
          }
        };
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch (e) { continue; }
          if (rules) walk(rules);
        }
        return JSON.stringify([...styled].sort());
      })()`),
    );
    const styledClasses = new Set(classGaps);
    const ledgerNotStyled = Object.keys(REACHLESS).filter(
      (c) => !styledClasses.has(c),
    );
    // THE VACUITY GUARD for the closure assertion below, and it is not
    // ceremonial: if the selector scrape broke, `styled` would be empty, the
    // closure would have nothing to complain about and would pass. This fails
    // first and says why.
    check(
      "every class in the unreachable ledger is really styled by the shipped CSS",
      ledgerNotStyled.length === 0 && styledClasses.size > 0,
      `${ledgerNotStyled.join(", ") || "(scrape found no styled token class at all)"} - the ledger pins a value for a class the stylesheet no longer styles, or the selector scrape stopped working`,
    );
    const goldenClasses = new Set();
    for (const key of Object.keys(golden.light.tokens)) {
      for (const part of key.split("@").join(">").split(">")) {
        for (const c of part.split(".")) if (c) goldenClasses.add(c);
      }
    }
    const unmeasured = [...styledClasses].filter(
      (c) => !goldenClasses.has(c) && !(c in REACHLESS),
    );
    check(
      "every styled token class is either measured by the golden or listed as unreachable",
      unmeasured.length === 0,
      `${unmeasured.join(", ")} - styled by src/styles.css, rendered nowhere in the fixture and absent from REACHLESS, so its declaration could be deleted with every assertion staying green. Either add a snippet that emits it and re-capture the golden, or pin it here`,
    );
    for (const mode of ["light", "dark"]) {
      await exec(
        `document.body.classList.toggle('dark-mode', ${mode === "dark"})`,
      );
      const got = JSON.parse(
        await exec(`(() => {
          const CASES = ${JSON.stringify(REACHLESS)};
          const MODE = ${JSON.stringify(mode)};
          const BLOCK = MODE === 'dark' ? 'body.dark-mode' : 'body';
          // The AUTHORED declaration, read from the CSSOM rather than from
          // getComputedStyle. That is not a stylistic preference: a custom
          // property declared "inherit" on <body> takes html's value, and html
          // declares none, so the computed value is the EMPTY STRING - the
          // consuming var() then has no substitution and "color" falls back to
          // unset, which for an inherited property is inherit. The painted
          // result is right; the computed property is simply not where the
          // decision is recorded.
          // WHERE the declaration lives is section 8's business, not this
          // section's - here the question is only what VALUE the shipped
          // default declares. So an inherited :root/html declaration is
          // accepted as a fallback when the body-level block has none; that
          // keeps a misplaced block reported once, by the assertion named for
          // it, instead of also failing here under a misleading name.
          const declaredIn = (prop) => {
            let found = null;
            let fallback = null;
            for (const sheet of document.styleSheets) {
              let rules;
              try { rules = sheet.cssRules; } catch (e) { continue; }
              if (!rules) continue;
              for (const rule of rules) {
                if (!rule.style || !rule.selectorText) continue;
                const v = rule.style.getPropertyValue(prop).trim();
                if (!v) continue;
                if (rule.selectorText === BLOCK) found = v;
                else if (/^\s*(:root|html)\s*$/.test(rule.selectorText)) fallback = v;
              }
            }
            return found !== null ? found : fallback;
          };
          const code = document.querySelector('#viewer pre[class*=language-] code');
          const host = document.createElement('span');
          code.appendChild(host);
          const probe = document.createElement('span');
          host.appendChild(probe);
          // Canonicalises whatever the source held (#rrggbb, a keyword) into the
          // same serialisation getComputedStyle returns, so the comparison is
          // never decided by spelling.
          const canonical = (prop, v) => {
            probe.style[prop] = '';
            probe.style[prop] = v;
            return getComputedStyle(probe)[prop];
          };
          const out = {};
          for (const [cls, spec] of Object.entries(CASES)) {
            const el = document.createElement('span');
            el.className = 'token ' + cls;
            el.textContent = 'x';
            host.appendChild(el);
            const truth = spec[MODE];
            out[cls] = {
              prop: spec.prop,
              truth: truth,
              actual: getComputedStyle(el)[spec.prop],
              expected: truth === 'INHERIT'
                ? getComputedStyle(host)[spec.prop]
                : canonical(spec.prop, truth),
              // Read only for the INHERIT cells, where painting cannot tell a
              // missing rule from an inherited one.
              declared: spec.from ? declaredIn(spec.from) : null,
            };
            el.remove();
          }
          host.remove();
          return JSON.stringify(out);
        })()`),
      );
      // A case that silently disappeared from the payload would otherwise be
      // reported as zero differences, which is the vacuity this section exists
      // to prevent - so the payload is checked for completeness first.
      const missing = Object.keys(REACHLESS).filter((k) => !got[k]);
      check(
        `${mode}: every unreachable-class probe reported a result`,
        missing.length === 0,
        `no result for: ${missing.join(", ")}`,
      );
      const bad = Object.entries(got)
        .filter(([, v]) => v.actual !== v.expected)
        .map(
          ([k, v]) =>
            `${k}.${v.prop}: source=${v.truth} expected=${v.expected} actual=${v.actual}`,
        );
      check(
        `${mode}: rules for token classes no grammar emits paint the shipped default's value`,
        bad.length === 0,
        bad.join(" | "),
      );

      // The value assertion above is structurally blind for a cell whose ground
      // truth is INHERIT: dropping the rule leaves the element inheriting too,
      // so both readings agree. What can still be pinned is that the cell says
      // `inherit` rather than an invented absolute - which is exactly the
      // regression Opus found in the light operator/namespace cells.
      // Two-sided: without this, dark - which has no INHERIT cells - compares an
      // empty list against an empty list and cannot fail, and light would do the
      // same the moment a payload key went missing.
      const inheritCells = Object.entries(got)
        .filter(([, v]) => v.truth === "INHERIT")
        .map(([k]) => k);
      const wantInherit = Object.entries(REACHLESS)
        .filter(([, s]) => s[mode] === "INHERIT")
        .map(([k]) => k);
      check(
        `${mode}: the inherit-cell set is exactly the one the shipped default has`,
        inheritCells.join(",") === wantInherit.join(","),
        `probe reported [${inheritCells.join(", ")}], source says [${wantInherit.join(", ")}]`,
      );
      const wrongDecl = Object.entries(got)
        .filter(([, v]) => v.truth === "INHERIT" && v.declared !== "inherit")
        .map(([k, v]) => `${k}: --tok-* declares "${v.declared}", must be "inherit"`);
      check(
        `${mode}: cells whose default declares no rule are pinned to inherit`,
        wrongDecl.length === 0,
        wrongDecl.join(" | "),
      );
    }

    // ─── SECTION 10: THE SCHEME LAYER ───────────────────────────────────────
    // Sections 1-9 guard FIDELITY: the two default schemes must look exactly as
    // Folia looked before the theme system existed. This section guards the
    // thing built on top - the four additional schemes, the registry that names
    // them and the menu that applies them.
    //
    // IT EXISTS BECAUSE A SCREENSHOT FOUND WHAT EVERY NUMBER MISSED. Abyss
    // shipped visibly half-themed - the Open File button and the active
    // carousel dot stayed default teal on a blue page - while every WCAG ratio
    // in the suite was green. Contrast is a relationship between a foreground
    // and THE BACKGROUND IT WAS MEASURED AGAINST; it cannot notice that the
    // background belongs to a different palette. So a contrast bar alone can
    // never catch a stranded surface, and 10c below is the assertion that can.
    const HELD = "window.__foliaExportThemeHeld";

    /* Properties a scheme is NOT required to override, each with the reason.
       Anything else the mode's base declares as a LITERAL must be overridden,
       and the required list is DERIVED from the base blocks rather than
       restated here - so adding a new chrome variable without adding it to the
       four schemes fails, naming the variable. That is exactly the accident
       that stranded the Open File button. */
    const SCHEME_EXCUSALS = {
      "--toc-width":
        "a layout dimension (300px), not a palette value - the table of contents is the same width in every scheme",
      "--tok-namespace-opacity":
        "a per-MODE legibility dimming (.7 light / 1 dark), inherited from the mode base on purpose: it is a decision about the page's contrast, not about the palette, and every scheme of a mode wants its mode's answer",
    };

    // ── 10a: the registry and the stylesheet must agree, in BOTH directions ──
    // Either half alone permits a dead entry: a registered scheme with no CSS
    // block applies data-theme and paints nothing, and a CSS block no scheme
    // names is unreachable styling nobody can select.
    const reg = JSON.parse(
      await exec(`(() => {
        const cssIds = new Set();
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
          if (!rules) continue;
          for (const rule of rules) {
            if (!rule.selectorText) continue;
            const m = /^body\\[data-theme="([^"]+)"\\]$/.exec(rule.selectorText.trim());
            if (m) cssIds.add(m[1]);
          }
        }
        const S = window.foliaThemes.SCHEMES;
        return JSON.stringify({
          cssIds: [...cssIds],
          nonBase: S.filter((s) => !s.base).map((s) => s.id),
          byMode: { light: S.filter((s) => s.mode === 'light').length,
                    dark: S.filter((s) => s.mode === 'dark').length },
          bases: S.filter((s) => s.base).map((s) => s.mode),
        });
      })()`),
    );
    const missingBlocks = reg.nonBase.filter((id) => !reg.cssIds.includes(id));
    const orphanBlocks = reg.cssIds.filter((id) => !reg.nonBase.includes(id));
    check(
      "every registered non-base scheme has a body[data-theme] block in the stylesheet",
      missingBlocks.length === 0,
      `registered with no CSS: ${missingBlocks.join(", ")}`,
    );
    check(
      "every body[data-theme] block in the stylesheet is a registered scheme",
      orphanBlocks.length === 0,
      `CSS blocks nothing can select: ${orphanBlocks.join(", ")}`,
    );
    // Vacuity floor. Both directions above are satisfied by an EMPTY registry
    // against an EMPTY stylesheet, which is the state this whole section is
    // meant to guard against reaching by accident.
    check(
      "the registry ships schemes in both modes, plus exactly one base per mode",
      reg.nonBase.length >= 4 &&
        reg.byMode.light >= 2 &&
        reg.byMode.dark >= 2 &&
        reg.bases.sort().join(",") === "dark,light",
      `nonBase=${reg.nonBase.length} light=${reg.byMode.light} dark=${reg.byMode.dark} bases=[${reg.bases.join(", ")}]`,
    );

    // ── 10b: completeness - a scheme must not inherit half its palette ───────
    // The base for a LIGHT scheme is :root + body; for a DARK scheme it is
    // :root + body + body.dark-mode, because dark overrides only what differs.
    // A var()-derived cell is exempt BY CONSTRUCTION: it resolves through a
    // coarse --syn-* role the scheme does override, so it retints on its own.
    // Only LITERALS can strand.
    const cover = JSON.parse(
      await exec(`(() => {
        const decl = (selector) => {
          const set = new Map();
          for (const sheet of document.styleSheets) {
            let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
            if (!rules) continue;
            for (const rule of rules) {
              if (!rule.style || rule.selectorText !== selector) continue;
              for (const p of rule.style) {
                if (p.startsWith('--')) set.set(p, rule.style.getPropertyValue(p).trim());
              }
            }
          }
          return set;
        };
        const merge = (...maps) => {
          const m = new Map();
          for (const x of maps) for (const [k, v] of x) m.set(k, v);
          return m;
        };
        const root = decl(':root'), body = decl('body'), dark = decl('body.dark-mode');
        const bases = { light: merge(root, body), dark: merge(root, body, dark) };
        /* REQUIRED, not DECLARED. The completeness check below only ever
           requires the LITERAL-valued subset of the base - a var()-derived cell
           follows its source by construction - so flooring the total would let
           the required list collapse without the floor moving at all: convert
           30 base literals to var() references and 10b silently stops requiring
           30 variables while every assertion stays green. */
        const literalCount = (m) =>
          [...m.entries()].filter(([, v]) => !v.includes('var(')).length;
        const out = {
          baseSize: { light: bases.light.size, dark: bases.dark.size },
          requiredSize: { light: literalCount(bases.light), dark: literalCount(bases.dark) },
          requiredNames: {
            light: [...bases.light.entries()].map(([k, v]) => [k, v]),
            dark: [...bases.dark.entries()].map(([k, v]) => [k, v]),
          },
          schemes: {},
        };
        for (const s of window.foliaThemes.SCHEMES.filter((x) => !x.base)) {
          const own = decl('body[data-theme="' + s.id + '"]');
          const base = bases[s.mode];
          out.schemes[s.id] = {
            mode: s.mode,
            own: own.size,
            literalMissing: [...base.entries()]
              .filter(([k, v]) => !own.has(k) && !v.includes('var('))
              .map(([k]) => k),
          };
        }
        return JSON.stringify(out);
      })()`),
    );
    /* THE FLOOR IS THE MEASUREMENT, not a comfortable number below it. Review
       flagged `>= 50` as carrying the same slack this suite has twice called a
       defect elsewhere (the `>= 30 / >= 200` that was retied to `>= 62 / >= 632`,
       and the `>= 4` against 9 that R340 exposed): eight required variables
       could have been converted to var() without the floor noticing. The note
       below prints what was actually counted so the pinned numbers can be
       re-derived rather than trusted. */
    console.log(
      `  note  base variables light ${cover.baseSize.light} (${cover.requiredSize.light} required) / dark ${cover.baseSize.dark} (${cover.requiredSize.dark} required)`,
    );
    check(
      "the derived required-variable list is the pinned measured size (the completeness check is not vacuous)",
      cover.requiredSize.light === REQUIRED_COUNTS.light &&
        cover.requiredSize.dark === REQUIRED_COUNTS.dark,
      `light base declares ${cover.baseSize.light} variables of which ${cover.requiredSize.light} are literal-valued and therefore REQUIRED of a scheme (pinned ${REQUIRED_COUNTS.light}); dark ${cover.baseSize.dark}/${cover.requiredSize.dark} (pinned ${REQUIRED_COUNTS.dark}) - it is the required count that makes the completeness check non-vacuous, not the declared one`,
    );
    /* THE ONE CONTRACT THE STYLESHEET STATES IN PROSE AND NOTHING CHECKED.
       styles.css says it plainly under the "COLOUR SCHEMES" heading, in the
       paragraph beginning "POSITION IS LOAD-BEARING": `body[data-theme="x"]`
       and `body.dark-mode` are both specificity (0,1,1) and declare on the
       same element, so SOURCE ORDER alone decides which wins. (Cited by
       heading rather than by line, per the convention custom-styles.css
       states: a change that adds rules above it silently invalidates a line
       number, and this citation had already rotted from 473 to 477.) Move the
       scheme blocks above the dark block and abyss and ember silently lose
       every cell the dark default also declares.
       Review found the defect IS caught today - 10c fails, because the dark
       default's accent reappears everywhere - but by an assertion named for
       STRANDED ACCENTS, which is the wrong-name failure mode this project
       rewrote R366's expect to avoid. Worse, the guard is asymmetric: clarity
       and parchment sit under `body` with no dark block to lose to, so a
       light-only reorder changes nothing and is not caught at all. This reads
       the rule indices directly, so it fails for the reason it is named for
       and covers all four schemes equally.

       IT MUST BE THE **LAST** DARK BLOCK, NOT THE FIRST, AND THAT IS A FACT
       ABOUT THIS STYLESHEET RATHER THAN A HYPOTHETICAL. `findIndex` was the
       first form, and styles.css declares TWO top-level `body.dark-mode`
       rules: the chrome variables, and - three hundred lines later - the
       whole Tomorrow Night syntax palette. A scheme block pasted between them
       therefore sits AFTER the first dark block and loses every --syn- and
       --tok- variable it declares, in dark mode only, with nothing failing.
       Taking
       the last index closes that and additionally covers the appended-block
       accident (a second dark block added at the END of the file would beat
       all four schemes). The full index list is printed so a third dark block
       appearing is visible rather than silently absorbed. R394 is the proof;
       under the old form it passes. */
    const order = JSON.parse(
      await exec(`(() => {
        const out = { dark: -1, darkAll: [], schemes: [], sheet: null };
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = [...sheet.cssRules]; } catch (e) { continue; }
          const darkAts = [];
          rules.forEach((r, i) => { if (r.selectorText === 'body.dark-mode') darkAts.push(i); });
          if (!darkAts.length) continue;
          out.sheet = (sheet.href || '').split('/').pop() || '(inline)';
          out.darkAll = darkAts;
          out.dark = darkAts[darkAts.length - 1];
          rules.forEach((r, i) => {
            const m = r.selectorText && /^body\\[data-theme="([a-z-]+)"\\]$/.exec(r.selectorText);
            if (m) out.schemes.push({ id: m[1], at: i });
          });
          break;
        }
        return JSON.stringify(out);
      })()`),
    );
    const misordered = order.schemes.filter((s) => s.at < order.dark).map((s) => s.id);
    check(
      "10b: every scheme block is declared AFTER the dark default, which is the only thing that lets it win",
      order.dark >= 0 && order.schemes.length === 4 && misordered.length === 0,
      `${order.sheet}: body.dark-mode at rule(s) ${order.darkAll.join(",")} (last ${order.dark}); ${order.schemes
        .map((s) => `${s.id}@${s.at}`)
        .join(" ")}${misordered.length ? ` - BEFORE the last dark block: ${misordered.join(", ")}` : ""}`,
    );
    const excusedNames = Object.keys(SCHEME_EXCUSALS);
    const excusalUsed = new Set();
    for (const [id, v] of Object.entries(cover.schemes)) {
      const stranded = v.literalMissing.filter((k) => {
        if (excusedNames.includes(k)) {
          excusalUsed.add(k);
          return false;
        }
        return true;
      });
      check(
        `${id}: overrides every literal its mode's base declares`,
        stranded.length === 0,
        `frozen to the ${v.mode} default palette: ${stranded.join(", ")}`,
      );
    }
    // A stale excusal is a hole nobody can see. If a variable stops being
    // skipped - because it was deleted, or because the schemes started
    // declaring it - the entry must go, or it silently widens the exemption for
    // whatever is added under that name next.
    const staleExcusals = excusedNames.filter((k) => !excusalUsed.has(k));
    check(
      "every scheme excusal is still load-bearing",
      staleExcusals.length === 0,
      `no scheme skips these any more, so the entries must be removed: ${staleExcusals.join(", ")}`,
    );

    // ── 10c: no default-accent literal may survive under a scheme ────────────
    // THE ABYSS FINDING AS A TIER-1 ASSERTION. Walks every element over every
    // colour-valued property looking for a colour from the DEFAULT accent
    // family while a non-base scheme is applied. An element still painting one
    // is a surface the scheme cannot reach.
    const ACCENT_PROBE = `(() => {
      /* SUBSTRING NEEDLES, NOT EXACT KEYS, and the reason is box-shadow: it
         serialises as 'rgba(39, 158, 167, 0.35) 0px 3px 12px', so an exact
         lookup can never match it however many properties are scanned.
         The ALPHA forms are listed separately because every accent glow and
         tint in the base stylesheet uses the accent with an alpha - 18 of
         them - and each was invisible to an opaque-only list.
         The hover family was WRONG here: this list carried 'rgb(42, 143, 150)'
         (#2a8f96), a colour that appears NOWHERE in src (verified by search),
         while the three hover accents the product actually ships - #1f8089,
         #1f8a92 and #4FCDD6 - were absent. A dead needle is not merely
         useless: it reads as coverage. */
      const NEEDLES = [
        ['rgb(39, 158, 167)', '#279EA7 default accent (light)'],
        ['rgba(39, 158, 167', '#279EA7 default accent with alpha (light)'],
        ['rgb(61, 189, 198)', '#3DBDC6 default accent (dark)'],
        ['rgba(61, 189, 198', '#3DBDC6 default accent with alpha (dark)'],
        ['rgb(59, 191, 204)', '#3bbfcc default welcome accent (dark)'],
        ['rgba(59, 191, 204', '#3bbfcc default welcome accent with alpha (dark)'],
        ['rgb(31, 128, 137)', '#1f8089 default accent hover (light)'],
        ['rgb(31, 138, 146)', '#1f8a92 default welcome solid hover (light)'],
        ['rgb(79, 205, 214)', '#4FCDD6 default accent hover (dark)'],
        ['rgb(31, 50, 68)',   '#1F3244 default ink/panel/table header (light)'],
      ];
      const PROPS = ['color','backgroundColor','backgroundImage','borderTopColor','borderRightColor',
                     'borderBottomColor','borderLeftColor','fill','stroke',
                     'outlineColor','textDecorationColor','caretColor','boxShadow'];
      const seen = new Set();
      const hits = [];
      const needleHits = {};
      for (const n of NEEDLES) needleHits[n[0]] = 0;
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const cs = getComputedStyle(el);
        for (const p of PROPS) {
          const val = cs[p];
          if (!val || typeof val !== 'string') continue;
          /* EVERY matching needle is counted, and the count is taken BEFORE
             the per-cell dedup below. The dedup exists to keep the failure
             message readable; letting it also decide needle coverage would
             mean a needle whose only paint happens to share a cell with an
             earlier needle reads as dead. */
          const matched = NEEDLES.filter((n) => val.indexOf(n[0]) !== -1);
          for (const n of matched) needleHits[n[0]]++;
          if (!matched.length) continue;
          const found = matched[0];
          const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
            (el.className && typeof el.className === 'string' && el.className.trim()
              ? '.' + el.className.trim().split(/\\s+/)[0] : '');
          const k = sel + '|' + p;
          if (seen.has(k)) continue;
          seen.add(k);
          hits.push(sel + ' { ' + p + ': ' + val + ' }  <- ' + found[1]);
        }
      }
      return JSON.stringify({ scanned: all.length, hits: hits, needles: needleHits });
    })()`;

    /* Drives the PRODUCT's own entry point rather than a copy of it, so the
       stored-preference bookkeeping, applyTheme(), the #darkModeToggle click
       and markActive() all run.
       THE BASE STATES GO THROUGH setScheme() TOO, and that is the whole point
       of this shape. The earlier version hand-rolled the default branch -
       remove the two scheme keys, call applyScheme(mode), toggle the class -
       which is a REIMPLEMENTATION of the product's base path, not a use of it.
       Every baseline in 10c, 10d and 10f is measured through here, so a defect
       in the real base path (markActive never running, the toggle's mermaid
       side effects never firing, a base id failing to clear data-theme) would
       have been invisible to the entire section while the suite reported the
       defaults intact. The base ids are registry entries like any other. */
    const applyState = (mode, scheme) =>
      exec(`(() => {
        localStorage.setItem('themeMode', ${JSON.stringify(mode)});
        window.foliaThemes.setScheme(${JSON.stringify(scheme || `default-${mode}`)});
        return (document.body.getAttribute('data-theme') || 'none') + '/' +
               (document.body.classList.contains('dark-mode') ? 'dark' : 'light');
      })()`);

    /* A COLOUR READ WHILE A TRANSITION IS RUNNING IS THE PREVIOUS SCHEME'S
       COLOUR, and it reads exactly like a stranded surface.
       custom-styles.css puts `transition: background .2s` on the update and
       file-update buttons, so sampling straight after a scheme change reported
       three buttons still painting the DEFAULT DARK accent while the very same
       elements resolved --primary-color to the new scheme's blue. Only one CSS
       rule matched them and it read var(--primary-color): the computed value
       was mid-flight, not wrong.

       So this waits on the engine's own animation registry rather than
       sleeping a guessed number of milliseconds - the browser knows when a
       transition has finished and nothing else does. Restricted to
       CSSTransition on purpose: a looping CSSAnimation (a spinner) is always
       "running" and would turn every settle into a silent timeout. */
    const settleTransitions = () =>
      exec(`(() => {
        const running = document.getAnimations().filter(
          (a) => typeof CSSTransition !== 'undefined' && a instanceof CSSTransition
        );
        return running.length;
      })()`);
    let settleFailures = [];
    let maxRunning = 0;
    const applySettled = async (mode, scheme, label) => {
      const applied = await applyState(mode, scheme);
      let running = -1;
      for (let i = 0; i < 60; i++) {
        running = await settleTransitions();
        maxRunning = Math.max(maxRunning, running);
        if (running === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (running !== 0) settleFailures.push(`${label}: ${running} still running`);
      return applied;
    };

    const SCHEME_STATES = [
      ["light", "clarity"],
      ["light", "parchment"],
      ["dark", "abyss"],
      ["dark", "ember"],
    ];

    /* 10b, SECOND HALF: a cell must RESOLVE, not merely be DECLARED.
       The completeness check above reads the CSSOM, so it answers "does this
       scheme have a declaration for --header-bg" - and `--header-bg:
       var(--typo)` answers YES. A custom property whose value references a
       variable that does not exist computes to the guaranteed-invalid value
       and reads back as the EMPTY STRING, so every consumer of it falls back
       to its own default or paints nothing, while 10b reports full coverage.
       Nothing else in the suite sees it either: 10c only hunts for the DEFAULT
       accent (an unresolved cell paints neither the default nor the scheme
       colour), and 10d skips fully transparent surfaces.

       AN EMPTY COMPUTED VALUE IS NOT ALWAYS A DEFECT, and the distinction is
       measured rather than excused. Light authors four cells as the CSS-wide
       keyword `inherit` - --tok-block-comment, --tok-operator, --tok-namespace
       and --tok-function-name - because Solarized Light declares no rule for
       any of them and the token really must take its parent's colour. That
       computes to the empty string BY DESIGN, and the consumer's
       `color: var(--tok-operator)` becoming invalid-at-computed-value-time is
       precisely the mechanism that produces the inheritance. Those four are
       covered on the appearance axis by the frozen golden, which recorded the
       real painted colour per context chain (operator@class-name yellow vs
       operator@ base00 - the very difference an invented absolute erased).
       So the classifier is the authored value, not a name list: a CSS-wide
       keyword is intended, anything else computing to empty is a broken
       reference. A name list would rot the moment a cell was retuned; this
       cannot, because it reads what the stylesheet actually says.

       THE AUTHORED VALUE MUST BE READ FROM THE STATE THAT IS APPLIED, and
       R304 is the proof - it came back VACUOUS on its first run because the
       classifier read the BASE declaration. Every one of these four cells is
       `inherit` in the light base, so a scheme overriding one with a broken
       var() was classified "by design" using a declaration the scheme had
       already replaced. The probe therefore resolves the WINNING declaration
       on <body> in the live state (last matching rule in document order - the
       three tiers here are body, body.dark-mode and body[data-theme], which
       ascend in both source order and specificity), falling back to :root for
       cells only declared there. Same disease as the mode-inherited probe in
       part 1: an assertion whose subject can be supplied by more than one
       source reports the disjunction unless it is told which one to ask. */
    const CSS_WIDE = ["inherit", "initial", "unset", "revert", "revert-layer"];
    const RESOLVE_PROBE = (names) => `(() => {
      const wanted = new Set(${JSON.stringify(names)});
      /* Winning authored value per cell, in the state that is applied right
         now - not the base's, which a scheme may have replaced. */
      const bodyWins = new Map(), rootWins = new Map();
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        if (!rules) continue;
        for (const rule of rules) {
          if (!rule.style || !rule.selectorText) continue;
          let onBody = false, onRoot = false;
          try { onBody = document.body.matches(rule.selectorText); } catch (e) {}
          try { onRoot = document.documentElement.matches(rule.selectorText); } catch (e) {}
          if (!onBody && !onRoot) continue;
          for (const p of rule.style) {
            if (!wanted.has(p)) continue;
            (onBody ? bodyWins : rootWins).set(p, rule.style.getPropertyValue(p).trim());
          }
        }
      }
      const cs = getComputedStyle(document.body);
      const empty = [];
      for (const n of wanted) {
        if (cs.getPropertyValue(n).trim() !== '') continue;
        const authored = bodyWins.has(n) ? bodyWins.get(n)
          : rootWins.has(n) ? rootWins.get(n) : '__NO-DECLARATION-FOUND__';
        empty.push([n, authored]);
      }
      return JSON.stringify({ checked: wanted.size, empty: empty });
    })()`;
    for (const [mode, scheme] of [
      ["light", null],
      ["dark", null],
      ...SCHEME_STATES,
    ]) {
      await applySettled(mode, scheme, (scheme || mode + " default") + " (resolution)");
      const names = cover.requiredNames[mode].map(([k]) => k);
      const res = JSON.parse(await exec(RESOLVE_PROBE(names)));
      const broken = res.empty.filter(([, v]) => !CSS_WIDE.includes(v));
      const byDesign = res.empty.filter(([, v]) => CSS_WIDE.includes(v));
      check(
        `${scheme || mode + " default"}: every variable its mode's base declares resolves to a real value (or is a deliberate CSS-wide keyword)`,
        broken.length === 0 && res.checked === cover.baseSize[mode] && res.checked > 50,
        `checked ${res.checked} of ${cover.baseSize[mode]} declared cells; DECLARED BUT UNRESOLVABLE: ${broken.map(([n, v]) => n + " = " + v).join(", ") || "none"}; empty by design (winning declaration is a CSS-wide keyword, appearance covered by the frozen golden): ${byDesign.map(([n]) => n).join(", ") || "none"}`,
      );
    }

    /* RE-ATTACH THE WELCOME SCREEN FOR THE SCHEME SCANS.
       R295 IS THE PROOF THIS IS LOAD-BEARING: pointing clarity's
       --welcome-solid-bg back at the DEFAULT accent - precisely the defect 10c
       exists to catch - left this whole section GREEN, because by this point
       the census render had replaced #viewer's children and every welcome
       surface with them. Five variables that 10b REQUIRES each scheme to
       declare were being scanned in a document that contained no consumer of
       any of them.
       Attached as a direct child of #viewer, un-wrapped, because that is where
       it lives in index.html; no .welcome rule is scoped to a parent, so the
       markup styles identically either way, and appending it unchanged keeps
       what is scanned the PRODUCT's markup under the PRODUCT's rules. */
    const welcomeAttached = await exec(`(() => {
      if (!window.__foliaWelcomeHTML) return 0;
      const viewer = document.getElementById('viewer');
      viewer.insertAdjacentHTML('beforeend', window.__foliaWelcomeHTML);
      const node = viewer.lastElementChild;
      node.setAttribute('data-folia-welcome-probe', '1');
      return node.querySelectorAll('*').length;
    })()`);
    await applySettled("light", null, "light default (welcome re-attach)");
    const welcomeLive = JSON.parse(
      await exec(`(() => {
        const pick = (s, prop) => {
          const el = document.querySelector('[data-folia-welcome-probe] ' + s);
          return el ? getComputedStyle(el).getPropertyValue(prop) : null;
        };
        return JSON.stringify({
          dot: pick('.welcome-dot.active', 'background-color'),
          btn: pick('.welcome-open-btn', 'background-color'),
          readme: pick('.welcome-readme-btn', 'border-top-color'),
        });
      })()`),
    );
    /* TWO variables are probed, not one, and they are deliberately different
       cells: --welcome-solid-bg (the fill the dot and the Open button share)
       and --welcome-accent (the Readme button's border). A guard that reached
       only the first would leave the second free to be stranded while still
       reporting that the welcome surfaces were covered - which is the shape of
       the vacuity R295 exposed, one variable further along.
       The remaining three --welcome-* cells are :hover-only, so no resting
       probe can reach them at all; 10f's declaration-scope and retint
       assertions are what cover that class. */
    check(
      "the welcome surfaces are back in the DOM and really painting the welcome tokens",
      welcomeAttached > 20 &&
        !!welcomeLive.dot &&
        welcomeLive.dot === welcomeLive.btn &&
        /^rgb\(\d/.test(welcomeLive.dot) &&
        /^rgb\(\d/.test(welcomeLive.readme || ""),
      `attached ${welcomeAttached} nodes; .welcome-dot.active=${welcomeLive.dot} .welcome-open-btn=${welcomeLive.btn} (both read var(--welcome-solid-bg)) .welcome-readme-btn border=${welcomeLive.readme} (reads var(--welcome-accent)) - if any disagree, are transparent or are missing then 10c and 10d cover no welcome surface at all`,
    );

    // POSITIVE CONTROL FIRST, and it is not optional. 10c is an assertion of
    // ABSENCE, and an absence check fails OPEN: if the accent literals above
    // ever go stale - the default palette is retuned, or getComputedStyle
    // starts serialising differently - every scheme reports zero survivals and
    // the section passes by matching nothing. The defaults MUST hit them.
    //
    // PER NEEDLE, NOT IN AGGREGATE. `hits.length > 0` is a DISJUNCTION over
    // ten needles: nine could rot and the control would still report coverage
    // off the tenth. Measured, that was not hypothetical - half the list was
    // unreachable at rest, so half of 10c's stated coverage did not exist.
    // A needle that genuinely cannot be reached from a resting document is
    // EXCUSED BY NAME with the reason, and a stale excusal fails, so the map
    // cannot quietly grow into a way of ignoring the control.
    //
    // ALL THREE ENTRIES WERE MEASURED, not assumed: the probe named them and
    // each consumer was then read out of the stylesheet. Every one is a
    // :hover-only or ::selection paint, i.e. exactly the class of surface
    // getComputedStyle over document.querySelectorAll('*') structurally cannot
    // reach - which is why 10f (glow replay) and 10g (hover replay) exist
    // beside this section, and why an excusal here is a division of labour
    // rather than a hole. Their DECLARATION is separately required of every
    // scheme by 10b.
    const NEEDLE_EXCUSALS = {
      "rgba(61, 189, 198":
        "--accent-tint (.nav-btn:hover only) and --code-selection-bg (::selection, a pseudo-element no computed-style sweep can read)",
      "rgba(59, 191, 204":
        "--welcome-accent-tint, consumed only by .welcome-readme-btn:hover",
      "rgb(31, 138, 146)":
        "--welcome-solid-hover, consumed only by .welcome-open-btn:hover",
    };
    const ctlNeedles = {};
    for (const mode of ["light", "dark"]) {
      await applySettled(mode, null, mode + " default (accent control)");
      const ctl = JSON.parse(await exec(ACCENT_PROBE));
      for (const [k, v] of Object.entries(ctl.needles)) ctlNeedles[k] = (ctlNeedles[k] || 0) + v;
      check(
        `${mode} default: the accent literals 10c searches for are really painted (positive control)`,
        ctl.hits.length > 0 && ctl.scanned > 100,
        `scanned ${ctl.scanned} elements and found ${ctl.hits.length} default-accent paints; if this is 0 the literal list is stale and every scheme below passes vacuously`,
      );
    }
    const deadNeedles = Object.entries(ctlNeedles)
      .filter(([k, v]) => v === 0 && !(k in NEEDLE_EXCUSALS))
      .map(([k]) => k);
    check(
      "every accent needle is really painted by a default (per-needle positive control)",
      deadNeedles.length === 0,
      `these needles matched nothing in either default, so any surface stranded on them would go unreported: ${deadNeedles.join(", ")} | full tally ${JSON.stringify(ctlNeedles)}`,
    );
    const staleNeedleExcusals = Object.keys(NEEDLE_EXCUSALS).filter((k) => ctlNeedles[k] > 0);
    check(
      "every accent-needle excusal is still load-bearing",
      staleNeedleExcusals.length === 0,
      `these needles ARE reachable at rest now, so the excusal must be removed or it silently exempts whatever is added under that name next: ${staleNeedleExcusals.join(", ")}`,
    );
    for (const [mode, scheme] of SCHEME_STATES) {
      const applied = await applySettled(mode, scheme, scheme + " (accent)");
      check(
        `${scheme}: applying the scheme really moved the document into it`,
        applied === scheme + "/" + mode,
        `data-theme/mode came back as ${applied}`,
      );
      const surv = JSON.parse(await exec(ACCENT_PROBE));
      check(
        `${scheme}: no element still paints a DEFAULT accent colour`,
        surv.hits.length === 0,
        `${surv.hits.length} stranded surface(s) across ${surv.scanned} elements: ${surv.hits.join(" | ")}`,
      );
    }

    // ── 10d: a scheme may not make contrast worse than the default ───────────
    // Deliberately NOT an absolute WCAG bar. Folia's own defaults carry several
    // sub-4.5 cells (worst: white on the dark accent at 2.26) that cannot be
    // fixed without breaking the byte-exact-default requirement sections 1-9
    // enforce, so an absolute bar could only be met by changing the very thing
    // this suite exists to freeze. The bar that IS meetable, and is the one a
    // scheme author can actually violate, is RELATIVE: introduce no new
    // low-contrast cell, and make no existing one worse.
    const CONTRAST_PROBE = `(() => {
      function parse(c) {
        const m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(c);
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
      }
      function lum(c) {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      }
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const out = [];
      let painting = 0, invisible = 0;
      const seen = new Set();
      for (const el of document.querySelectorAll('*')) {
        /* Measure the element that actually PAINTS text - one with a DIRECT
           non-empty text node - and resolve its background from the nearest
           ancestor-or-self that is opaque. Both halves were arrived at by
           measurement and each fixes a failure of a cruder rule: keying on
           textContent reports containers at 1:1 (a div inherits a colour it
           never paints with), and using the element's OWN background misses
           every button whose label sits in a <span>, which is most of them. A
           semi-transparent background is skipped rather than alpha-blended -
           the blend is real, but the answer is only as good as the guess about
           what is behind it. */
        const paints = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
        if (!paints) continue;
        /* CUMULATIVE OPACITY, AND IT IS NOT OPTIONAL. An element with
           opacity < 1 is composited over its backdrop, so its RENDERED ink is
           o*fg + (1-o)*bg - not cs.color. Measured, the un-composited reading
           over-reports by a wide margin on real cells: .welcome-open-hint
           (opacity .75) reports 5.19 under clarity and RENDERS 3.61.
           o === 0 is a different case entirely and is EXCLUDED rather than
           measured: the element paints nothing at all, so compositing it
           yields fg === bg and a meaningless 1.00 ratio. Measured, 65 of the
           157 cells per state are the welcome slider's inactive slides at
           opacity 0; scoring them would bury every real cell under 65 false
           ones. The count is returned so the exclusion cannot go silent. */
        let o = 1;
        for (let a = el; a; a = a.parentElement) {
          const v = parseFloat(getComputedStyle(a).opacity);
          o *= isNaN(v) ? 1 : v;
        }
        if (o === 0) { invisible++; continue; }
        painting++;
        let bg = null;
        for (let a = el; a; a = a.parentElement) {
          const c = parse(getComputedStyle(a).backgroundColor);
          if (c && c.a >= 0.95) { bg = c; break; }
        }
        const cs = getComputedStyle(el);
        const fg = parse(cs.color);
        if (!bg || !fg) continue;
        /* EVERY cell is emitted, not just the sub-4.5 ones. Filtering here was
           a structural defect: it made the RELATIVE comparisons unfailable
           whenever the absolute bar passed, because both drew their subjects
           from a list that the absolute bar had already emptied. Worse, the
           one case the relative bar was kept for - a cell degrading from 6.0
           to 4.6 - could never enter the list at all. The assertions filter at
           their own site now, and the ratios are carried UNROUNDED so a
           comparison is not decided by two decimal places. */
        const r = ratio(fg, bg);
        const ink = o >= 0.999 ? fg : {
          r: o * fg.r + (1 - o) * bg.r,
          g: o * fg.g + (1 - o) * bg.g,
          b: o * fg.b + (1 - o) * bg.b,
        };
        /* A colour-INDEPENDENT identity, so the same cell is recognisable
           across two states that deliberately paint it differently. Keying on
           the colours would make every scheme row look like a brand-new cell;
           keying on the tag name collapses the dozens of elements that share
           one - which is how the exit button's white-on-red hid inside the
           defaults while surfacing as the schemes' only cell. */
        let path = '', node = el;
        while (node && node.nodeType === 1) {
          const parent = node.parentElement;
          const idx = parent ? [...parent.children].indexOf(node) + 1 : 1;
          path = '>' + node.tagName.toLowerCase() + ':' + idx + path;
          node = parent;
        }
        if (seen.has(path)) continue;
        seen.add(path);
        const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
          (el.className && typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
        out.push({
          path, sel, o: o, r: r, rEff: ratio(ink, bg),
          fg: 'rgb(' + fg.r + ',' + fg.g + ',' + fg.b + ')',
          bg: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')',
        });
      }
      return JSON.stringify({ painting: painting, invisible: invisible, cells: out });
    })()`;

    const contrastBase = {};
    for (const mode of ["light", "dark"]) {
      await applySettled(mode, null, mode + " default (contrast baseline)");
      contrastBase[mode] = JSON.parse(await exec(CONTRAST_PROBE));
    }
    const buckets = (s) => ({
      painting: s.painting,
      invisible: s.invisible,
      dimmed: s.cells.filter((c) => c.o < 0.999).length,
      undimmed: s.cells.filter((c) => c.o >= 0.999).length,
    });
    check(
      "the contrast probe measured a substantial number of text-painting elements",
      contrastBase.light.painting >= 80 && contrastBase.dark.painting >= 80,
      `light ${contrastBase.light.painting}, dark ${contrastBase.dark.painting} - too few and the comparisons below are vacuous`,
    );
    // BOTH buckets must be occupied, because the bars below are SPLIT by this
    // very distinction: an empty dimmed bucket would make the inherited-dimming
    // assertion vacuous, and an empty undimmed bucket would gut the absolute
    // one. Measured today: 81 undimmed and 11 dimmed per state.
    check(
      "the defaults paint text at BOTH full and reduced opacity, so neither contrast bucket is empty",
      ["light", "dark"].every(
        (m) => buckets(contrastBase[m]).dimmed > 0 && buckets(contrastBase[m]).undimmed > 0,
      ),
      `light ${JSON.stringify(buckets(contrastBase.light))}, dark ${JSON.stringify(buckets(contrastBase.dark))}`,
    );
    // The defaults' own sub-AA cells are RECORDED rather than asserted away.
    // They are pre-existing and frozen; what matters is that the list is
    // non-empty, because an empty one would make the relative bars below
    // trivially true for every scheme. Measured: 10 undimmed sub-AA cells in
    // the light default, 4 in the dark - and 0 in all four schemes.
    check(
      "both defaults carry the pre-existing sub-AA cells the relative bars are measured against",
      ["light", "dark"].every(
        (m) => contrastBase[m].cells.filter((c) => c.rEff < 4.5).length > 0,
      ),
      `light ${contrastBase.light.cells.filter((c) => c.rEff < 4.5).length}, dark ${contrastBase.dark.cells.filter((c) => c.rEff < 4.5).length}`,
    );
    const show = (c) => `${c.sel} ${c.fg} on ${c.bg} o=${c.o.toFixed(2)} r=${c.r.toFixed(2)} rendered=${c.rEff.toFixed(2)}`;
    for (const [mode, scheme] of SCHEME_STATES) {
      await applySettled(mode, scheme, scheme + " (contrast)");
      const cur = JSON.parse(await exec(CONTRAST_PROBE));
      const baseByPath = new Map(contrastBase[mode].cells.map((c) => [c.path, c]));

      /* THE SCAN ITSELF IS ASSERTED FIRST, and it is not a threshold - it is
         an EQUALITY. Every assertion below is an assertion of ABSENCE over a
         scanned document, so all of them pass vacuously if the document shrinks
         between the baseline and the scheme state. That is not hypothetical:
         R295 was exactly this defect one state earlier, where the census render
         had removed the whole welcome screen before anything scanned for it.
         The six states are SUPPOSED to render identical DOM - only colours
         change - so equality is both the strongest available guard and the
         true statement. It also protects the path keying the two relative bars
         depend on, which degrades silently to "no shared cells" if the DOM
         shifts. Measured: 157 cells, 81 undimmed / 11 dimmed / 65 invisible,
         identical in all six states. */
      check(
        `${scheme}: scanned the very same document its mode's default baseline did`,
        JSON.stringify(buckets(cur)) === JSON.stringify(buckets(contrastBase[mode])) &&
          cur.cells.every((c) => baseByPath.has(c.path)),
        `scheme ${JSON.stringify(buckets(cur))} vs default ${JSON.stringify(buckets(contrastBase[mode]))}; ${cur.cells.filter((c) => !baseByPath.has(c.path)).length} cell(s) have no counterpart in the baseline`,
      );

      /* ABSOLUTE, over the ink the scheme actually controls at full strength.
         It applies ONLY to the four curated schemes, never to the defaults,
         which carry 10 (light) and 4 (dark) undimmed sub-AA cells the
         byte-exact requirement forbids touching.
         It was NOT assumed to be meetable. Measured, the schemes' only
         remaining undimmed sub-AA cell was the editor Exit button, white on
         the default's #e74c3c at 3.82 - a failure every scheme INHERITED from
         the base rather than chose, which is why the fix was to tokenise
         --danger-bg rather than to write an excusal here. All four now measure
         ZERO. */
      const undimmedFail = cur.cells.filter((c) => c.o >= 0.999 && c.rEff < 4.5);
      check(
        `${scheme}: every element it paints at full opacity meets WCAG AA (4.5:1)`,
        undimmedFail.length === 0,
        undimmedFail.map(show).join(" | "),
      );

      /* THE DIMMED CELLS ARE NOT EXCUSED - they are held to the same bar on
         the half the scheme owns. Base chrome dims secondary hints with
         `opacity` (.5 on .tools-shortcut/.submenu-arrow/.welcome-version, .7 on
         .shortcut, .75 on .welcome-open-hint). That dimming is frozen with the
         defaults, and it pushes those cells below AA no matter what colour sits
         underneath - measured, .tools-shortcut renders at 2.01 in the LIGHT
         DEFAULT. What a scheme does own is the colour pair it dims, so that is
         what is asserted: the choice must clear AA before the inherited
         dimming is applied. All four schemes pass; both DEFAULTS fail it at
         3.21 (.welcome-open-hint), which is exactly why the bar is scoped to
         schemes. */
      const dimmedChoice = cur.cells.filter((c) => c.o < 0.999 && c.r < 4.5);
      check(
        `${scheme}: every dimmed hint's colour choice meets WCAG AA before the inherited dimming`,
        dimmedChoice.length === 0,
        dimmedChoice.map(show).join(" | "),
      );

      /* THE HONEST RENDERED CLAIM. The two bars above are about what the
         scheme CHOSE; this one is about what a reader SEES, and it is the
         assertion that would have caught the defect that motivated all of
         this: .welcome-open-hint reports 5.19 under clarity and renders 3.61,
         so an absolute bar on cs.color alone certified as AA something that is
         not. It cannot demand AA outright - the dimming is frozen - so it
         demands PROVENANCE: anything rendering below AA must be a cell that
         renders below AA in this mode's default too. A scheme cannot introduce
         a sub-AA render, only inherit one. */
      const novelRenderFail = cur.cells.filter(
        (c) => c.rEff < 4.5 && !(baseByPath.get(c.path) && baseByPath.get(c.path).rEff < 4.5),
      );
      check(
        `${scheme}: every element that RENDERS below AA also renders below AA in its mode's default`,
        novelRenderFail.length === 0,
        novelRenderFail
          .map((c) => `${show(c)} (default rendered ${baseByPath.get(c.path) ? baseByPath.get(c.path).rEff.toFixed(2) : "ABSENT"})`)
          .join(" | "),
      );

      /* THE SECOND RELATIVE BAR, AND IT WAS REDUNDANT UNTIL IT WAS MEASURED
         AGAINST THE FIRST. Its previous form fired when a cell that met AA
         under the default fell below it - which is a STRICT SUBSET of the
         provenance bar above (base >= 4.5 and scheme < 4.5 satisfies both), so
         it could never fail alone and two assertions were guarding one
         property. That is worse than one assertion, because the second looks
         like independent coverage.
         What NEITHER of them could see is the cell that starts BELOW the bar.
         Provenance excuses any cell whose default is already sub-AA, and the
         dimmed-choice bar reads the pre-dimming pair, so a scheme could take
         .tools-shortcut from the light default's rendered 2.01 down to 1.2 and
         every assertion in 10d would stay green. The two bars are now DISJOINT
         by construction: provenance owns base >= 4.5, this owns base < 4.5.
         The asymmetry is deliberate and is the whole argument. Above AA a
         scheme may legitimately trade contrast for aesthetics - parchment
         moves a cell from 13.14 to 10.59 and that is a choice, not a defect.
         Below AA there is nothing left to trade. */
      const B_EPS = 0.01;
      const worsened = cur.cells.filter(
        (c) =>
          baseByPath.has(c.path) &&
          baseByPath.get(c.path).rEff < 4.5 &&
          c.rEff < baseByPath.get(c.path).rEff - B_EPS,
      );
      check(
        `${scheme}: no element that was ALREADY below AA in the default is made worse`,
        worsened.length === 0,
        worsened
          .map((c) => `${c.sel} rendered ${baseByPath.get(c.path).rEff.toFixed(2)} -> ${c.rEff.toFixed(2)} (${c.fg} on ${c.bg} o=${c.o.toFixed(2)})`)
          .join(" | "),
      );
    }
    /* The welcome markup deliberately STAYS attached through 10f and 10g.
       Removing it here - which is where it used to happen - silently narrowed
       10g's subject set: .welcome-open-btn:hover and .welcome-readme-btn:hover
       are two of the four hover rules in the whole product that paint an
       accent FILL, and they landed in `unmatched` for no reason other than
       ordering. Same disease as R295, one section further along: an assertion
       that walks the live DOM is only as wide as the DOM the suite has built
       by the time it runs. It is removed after 10g instead. */

    /* ── 10f: the accent GLOWS - the half of the appearance no golden can see ─
       Sections 1-9 sample surfaces in their RESTING state, because that is all
       getComputedStyle can reach. Every rule below paints only on :hover,
       :focus or ::after, so the twelve box-shadows that carry Folia's accent
       halo were invisible to the entire suite - and 10c caught the resulting
       gap only by accident, through the one glow that happens to sit on
       .welcome-open-btn.

       THE FROZEN VALUES BELOW RECORD A MEASUREMENT THAT IS NOT OBVIOUS AND IS
       EASY TO "TIDY" AWAY. Before tokenisation, ELEVEN of the twelve rules
       carried the LIGHT teal literal and had no body.dark-mode counterpart, so
       they painted the light halo in dark mode too. Exactly one -
       .app-update-btn.primary:hover - was overridden. Folding all twelve into
       a single per-mode accent token therefore LOOKS correct and silently
       changes the frozen dark default; --accent-glow-rgb is deliberately
       absent from the dark block for that reason, and R301 is that edit.

       Both halves are asserted separately, because a value that resolves
       correctly can do so from the wrong declaration: the CAUSE (which block
       declares the token) and the CONSEQUENCE (what the rules resolve to in
       each mode) fail under different accidents. */
    const GLOW_FAMILIES = {
      "--accent-glow-rgb": { light: "39, 158, 167", dark: "39, 158, 167" },
      "--accent-mode-glow-rgb": { light: "39, 158, 167", dark: "61, 189, 198" },
      "--danger-glow-rgb": { light: "231, 76, 60", dark: "231, 76, 60" },
    };
    /* THE FROZEN INVENTORY - every glow this app paints, by selector, by the
       property that paints it, and by the alpha it paints at.
       A COUNT IS NOT AN INVENTORY, and that distinction is the whole reason
       this is a table rather than a floor. A floor of 13 is satisfied when a
       hover consumer is deleted and any other tokenised rule is duplicated in
       its place, and a SET of alphas is satisfied when two rules exchange
       theirs - neither of which any other assertion in the suite can see,
       because every one of these states is a :hover, :focus or ::after that
       getComputedStyle cannot reach and no screenshot of a resting page shows.
       The alphas live at the USE SITES on purpose: the token carries an rgb
       triple so that one scheme value serves six halo strengths, which also
       makes an alpha the one part of a glow a scheme author cannot reach. */
    const GLOW_INVENTORY = [
      ["--accent-glow-rgb", "body.drop-active::after", "background", "0.08"],
      ["--accent-glow-rgb", ".btn:hover", "box-shadow", "0.3"],
      ["--accent-glow-rgb", ".editor-save-btn:hover", "box-shadow", "0.3"],
      ["--danger-glow-rgb", ".editor-exit-btn:hover", "box-shadow", "0.3"],
      ["--accent-glow-rgb", ".welcome-open-btn", "box-shadow", "0.35"],
      ["--accent-glow-rgb", ".welcome-open-btn:hover", "box-shadow", "0.45"],
      ["--accent-glow-rgb", ".welcome-open-btn:active", "box-shadow", "0.3"],
      ["--accent-glow-rgb", ".search-input:focus", "box-shadow", "0.2"],
      ["--accent-glow-rgb", ".file-update-btn.reload:hover", "box-shadow", "0.3"],
      ["--accent-mode-glow-rgb", ".app-update-btn.primary:hover", "box-shadow", "0.3"],
      ["--accent-glow-rgb", ".note-dialog-input:focus", "box-shadow", "0.15"],
      ["--accent-glow-rgb", ".note-dialog-textarea:focus", "box-shadow", "0.15"],
      ["--accent-glow-rgb", ".note-dialog-btn.primary:hover", "box-shadow", "0.3"],
    ];

    /* Collected from the LIVE stylesheet rather than listed here: a hard-coded
       selector list silently stops covering a rule that is renamed, and stops
       growing when a thirteenth glow is added.
       SCANNED ACROSS PROPERTIES, and that was not the first version. Filtering
       on box-shadow alone quietly dropped `body.drop-active::after`'s
       `background: rgba(var(--accent-glow-rgb), 0.08)` - the ONE glow consumer
       in the app that is not a shadow; a later review round measured all 13
       consumers and it is still the only one - and the ONLY symptom was a
       missing alpha in the frozen list
       below. The retint and fidelity assertions were happily reporting a clean
       sweep of a subject set one rule short. */
    const GLOW_PROPS = {
      "box-shadow": "box-shadow",
      background: "background-color",
      "background-color": "background-color",
      border: "border-top-color",
      "border-color": "border-top-color",
      color: "color",
      outline: "outline-color",
      "outline-color": "outline-color",
    };
    const glowRules = JSON.parse(
      await exec(`(() => {
        const FAMILIES = ${JSON.stringify(Object.keys(GLOW_FAMILIES))};
        const PROPS = ${JSON.stringify(Object.keys(GLOW_PROPS))};
        const out = [];
        const walk = (rules) => {
          for (const rule of rules) {
            if (rule.style && rule.selectorText) {
              for (const prop of PROPS) {
                const v = rule.style.getPropertyValue(prop);
                if (!v) continue;
                const fam = FAMILIES.filter((f) => v.includes(f));
                if (fam.length === 1) out.push({ sel: rule.selectorText.trim(), prop, family: fam[0], declared: v.trim() });
                else if (fam.length > 1) out.push({ sel: rule.selectorText.trim(), prop, family: 'MIXED:' + fam.join('+'), declared: v.trim() });
              }
            }
            if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
          }
        };
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
          if (rules) walk(rules);
        }
        return JSON.stringify(out);
      })()`),
    );
    /* Set equality in BOTH directions against the frozen inventory. A missing
       tuple is a consumer that stopped being tokenised or was renamed; an
       unexpected one is a glow nobody decided to add. Both need a human, and
       both are silent everywhere else. */
    const glowKey = (family, sel, prop, alpha) => `${sel} {${prop}} ${family} @${alpha}`;
    const liveGlowKeys = glowRules.map((r) => {
      const m = /,\s*([0-9.]+)\s*\)/.exec(r.declared);
      return glowKey(r.family, r.sel, r.prop, m ? String(parseFloat(m[1])) : "NO-ALPHA");
    });
    const frozenGlowKeys = GLOW_INVENTORY.map((row) => glowKey(row[0], row[1], row[2], row[3]));
    const glowMissing = frozenGlowKeys.filter((k) => !liveGlowKeys.includes(k));
    const glowUnexpected = liveGlowKeys.filter((k) => !frozenGlowKeys.includes(k));
    check(
      "the glow rules are exactly the frozen inventory - same selectors, same properties, same alphas",
      glowMissing.length === 0 &&
        glowUnexpected.length === 0 &&
        liveGlowKeys.length === frozenGlowKeys.length &&
        glowRules.every((r) => !r.family.startsWith("MIXED")),
      `missing: [${glowMissing.join(" | ")}] unexpected: [${glowUnexpected.join(" | ")}] (live ${liveGlowKeys.length}, frozen ${frozenGlowKeys.length})`,
    );

    const resolveGlows = async (mode, scheme, label) => {
      await applySettled(mode, scheme, label);
      return JSON.parse(
        await exec(`(() => {
          const RULES = ${JSON.stringify(glowRules)};
          const READ = ${JSON.stringify(GLOW_PROPS)};
          const host = document.createElement('div');
          host.style.position = 'absolute'; host.style.left = '-99999px';
          document.body.appendChild(host);
          const els = RULES.map((r) => {
            const el = document.createElement('div');
            el.style.setProperty(r.prop, r.declared);
            host.appendChild(el);
            return el;
          });
          const out = els.map((el, i) => getComputedStyle(el).getPropertyValue(READ[RULES[i].prop]));
          host.remove();
          return JSON.stringify(out);
        })()`),
      );
    };

    /* An rgb triple is compared, not the whole declaration: the offsets and
       blur radii belong to the rule and are identical by construction, while
       the COLOUR is the only thing the token moves. */
    const tripleOf = (s) => {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s || "");
      return m ? `${m[1]}, ${m[2]}, ${m[3]}` : null;
    };
    const glowByMode = {};
    for (const mode of ["light", "dark"]) {
      const got = await resolveGlows(mode, null, `${mode} default (glow probe)`);
      glowByMode[mode] = got;
      const wrong = glowRules
        .map((r, i) => ({ ...r, got: tripleOf(got[i]) }))
        .filter((r) => r.got !== GLOW_FAMILIES[r.family][mode]);
      check(
        `${mode} default: every accent glow resolves to its frozen pre-theme colour`,
        wrong.length === 0,
        wrong
          .map((r) => `${r.sel} resolved ${r.got}, frozen ${GLOW_FAMILIES[r.family][mode]}`)
          .join(" | "),
      );
    }
    /* THE CAUSE, asserted separately from the consequence above. The eleven
       --accent-glow-rgb rules resolve identically in both modes only because
       the token is declared ONCE, outside the dark block. Redeclaring it in
       body.dark-mode is a one-line edit that looks like an omission being
       fixed, and the resolved-value assertion is what it breaks - but only
       this one names the reason. */
    const glowScope = JSON.parse(
      await exec(`(() => {
        const FAMILIES = ${JSON.stringify(Object.keys(GLOW_FAMILIES))};
        const out = {};
        for (const f of FAMILIES) out[f] = [];
        /* The media condition is carried down the walk, because this is an
           assertion about SCOPE and a redeclaration inside
           @media (prefers-color-scheme: dark) { :root { ... } } is a dark-mode
           declaration wearing a selector that does not say so. */
        const walk = (rules, cond) => {
          for (const rule of rules) {
            const at = rule.media ? (cond ? cond + ' && ' : '') + '@media ' + rule.conditionText : cond;
            if (rule.style && rule.selectorText) {
              for (const f of FAMILIES) {
                if (rule.style.getPropertyValue(f)) {
                  out[f].push((at ? at + ' ' : '') + rule.selectorText.trim());
                }
              }
            }
            if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules, at);
          }
        };
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
          if (rules) walk(rules, '');
        }
        return JSON.stringify(out);
      })()`),
    );
    /* Scope-COMPLETE on purpose: any selector carrying .dark-mode whatever it
       is attached to, plus anything nested under a dark colour-scheme query.
       The assertion is specifically about where a declaration lives, so a
       matcher that only recognises the one spelling in use today would report
       an absence as satisfied - the failure mode this project has hit before. */
    const darkDecl = (f) =>
      (glowScope[f] || []).filter(
        (s) => /\.dark-mode\b/.test(s) || /prefers-color-scheme:\s*dark/.test(s),
      );
    /* EXACTLY ONE, not "at least one". The scheme blocks declare this token
       too, so a floor of 1 is satisfied by them alone - deleting the :root
       declaration outright would have passed this assertion under its own
       name, leaving it to a sibling to report a defect this one is named for. */
    const baseDecl = (f) =>
      (glowScope[f] || []).filter((s) => s === ":root" || s === "body");
    check(
      "the mode-invariant glow token is declared once, outside the dark block",
      baseDecl("--accent-glow-rgb").length === 1 &&
        darkDecl("--accent-glow-rgb").length === 0 &&
        darkDecl("--danger-glow-rgb").length === 0,
      `--accent-glow-rgb declared by [${glowScope["--accent-glow-rgb"].join(", ")}], of which ${baseDecl("--accent-glow-rgb").length} at base scope (:root/body, must be exactly 1); dark-mode declarations: accent=[${darkDecl("--accent-glow-rgb").join(", ")}] danger=[${darkDecl("--danger-glow-rgb").join(", ")}] - eleven rules painted the LIGHT teal in dark mode before the theme system existed, so declaring this per mode changes the frozen dark default with nothing else in the suite able to see it`,
    );
    check(
      "the one genuinely mode-varying glow IS declared per mode",
      darkDecl("--accent-mode-glow-rgb").length === 1,
      `--accent-mode-glow-rgb dark declarations: [${darkDecl("--accent-mode-glow-rgb").join(", ")}] - exactly .app-update-btn.primary:hover differed by mode before tokenisation, and dropping that override would flatten it to the light halo`,
    );

    /* A glow a scheme cannot reach is the stranded-accent defect of 10c in a
       state no screenshot of a resting page can show. */
    for (const [mode, scheme] of SCHEME_STATES) {
      const got = await resolveGlows(mode, scheme, `${scheme} (glow probe)`);
      const stranded = glowRules
        .map((r, i) => ({ ...r, got: tripleOf(got[i]) }))
        .filter((r) => !r.got || r.got === GLOW_FAMILIES[r.family][mode]);
      check(
        `${scheme}: every accent glow is retinted, none left on the default halo`,
        stranded.length === 0,
        stranded
          .map((r) => `${r.sel} still ${r.got} (the ${mode} default for ${r.family})`)
          .join(" | "),
      );
    }

    /* THE RE-ADDED LITERAL, which every other assertion in this section is
       structurally blind to. A rule written as
         body.dark-mode .btn:hover { box-shadow: 0 2px 8px rgba(61,189,198,0.3) }
       carries no token name, so the collector never sees it, the inventory
       never misses it, the scope probe never reads it and the resting-state
       golden of sections 1-9 cannot reach a :hover rule at all. It would paint
       the pre-theme halo under every scheme with nothing failing.
       The sweep is over DECLARATIONS rather than the file's text so a
       reformat cannot defeat it, and CUSTOM PROPERTIES ARE EXCLUDED because
       the frozen triples legitimately live in exactly one place - the token
       declarations themselves (--accent-tint, --code-selection-bg and the
       three glow triples). Excluding by property KIND rather than by a list of
       names is what stops this going stale when a token is added. */
    /* THE FROZEN ACCENT FAMILY, as triples rather than as spellings. The
       needles are DERIVED from these so the spellings cannot drift apart, and
       so a fourth family member is one line rather than hand-written strings.
         39,158,167   #279EA7  the light default accent
         61,189,198   #3DBDC6  the dark default accent
         231,76,60    #e74c3c  the frozen danger red
         59,191,204   #3bbfcc  the dark welcome accent (two hex digits off the
                               app accent - see the note at styles.css:1659)

       THE HEX NEEDLE IS HERE BECAUSE AN EARLIER VERSION OF THIS COMMENT WAS
       WRONG, AND WRONG IN THE WAY THAT MATTERS. It recorded, as a measured
       fact, that Chromium canonicalises colour values entering the CSSOM - so
       `color: #279ea7` reads back as `rgb(39, 158, 167)` - and concluded that
       a hex needle could never match. The measurement was real but the
       conclusion did not hold, because CANONICALISATION DOES NOT HAPPEN TO A
       VALUE CONTAINING `var()`: such a value is stored as an unparsed token
       sequence. Measured, on this document:
         color: var(--nope, #279ea7)   -> reads back "var(--nope, #279ea7)"
         color: #279EA7                -> reads back "rgb(39, 158, 167)"
       So the ONE spelling that survives into the CSSOM unchanged is a hex
       inside a var() fallback - and `var(--primary-color, #279EA7)` is exactly
       the shape this codebase already writes (custom-styles.css:456 ships
       `var(--primary-color, #2d9cdb)`). It re-freezes the default accent under
       every scheme, and the old needle set could not see it. Hex is matched
       case-insensitively: the product spells it #279EA7, this list spells it
       lower. */
    const ACCENT_FAMILY = [
      [39, 158, 167],
      [61, 189, 198],
      [231, 76, 60],
      [59, 191, 204],
    ];
    /* An accent literal inside a print-only at-rule is the one legitimate
       case, and it is legitimate for a reason 10i proves rather than asserts:
       the export park removes `data-theme` before printToPDF captures, so
       every theme state prints the shipped light default. These two rules
       repaint a dark-mode link and blockquote in the LIGHT accent because the
       dark accent is chosen to sit on a dark surface, not on forced-white
       paper. They are excused BY NAME as well as by context, so a NEW print
       literal still has to be looked at. */
    const LITERAL_EXCUSALS = {
      "body.dark-mode #viewer a|color":
        "print forces the paper-legible light accent for dark-mode links",
      "body.dark-mode #viewer blockquote|border-left-color":
        "print forces the paper-legible light accent for dark-mode quote rules",
    };
    const literalUses = JSON.parse(
      await exec(`(() => {
        const FAMILY = ${JSON.stringify(ACCENT_FAMILY)};
        const NEEDLES = [];
        for (const f of FAMILY) {
          NEEDLES.push('rgb(' + f[0] + ', ' + f[1] + ', ' + f[2] + ')');
          NEEDLES.push('rgba(' + f[0] + ', ' + f[1] + ', ' + f[2]);
          NEEDLES.push('#' + f.map(function (n) {
            return n.toString(16).padStart(2, '0');
          }).join(''));
        }
        const hunt = (text) => {
          const flat = text.replace(/\\s+/g, ' ').toLowerCase();
          return NEEDLES.some((n) => flat.indexOf(n) !== -1);
        };
        /* CUSTOM PROPERTIES ARE EXCLUDED TEXTUALLY rather than structurally,
           because detection now reads cssText (see below) and cssText carries
           the token declarations too. The frozen triples legitimately live in
           exactly one place - the token declarations themselves - so removing
           every '--name: value' declaration is the same exclusion the old
           prop.startsWith('--') test made, expressed on the serialised form.
           The self-check below plants a custom property holding an accent and
           requires it NOT to be reported, which is the negative control this
           swap owes. */
        const stripCustom = (cssText) =>
          cssText.replace(/(^|;)\\s*--[^:;]+:[^;]*/g, '$1');
        const sweep = () => {
          const hits = [];
          let sheets = 0, unreadable = 0, rules = 0, decls = 0;
          const seen = [];
          const walk = (rules_, cond, kfName) => {
            for (const rule of rules_) {
              /* A @keyframes STEP has .style but no .selectorText - it carries
                 .keyText instead - so gating the walk on selectorText alone
                 silently dropped every keyframe declaration. Measured: 14 such
                 rules exist in this document, and styles.css already animates
                 box-shadow (notePulse). An accent pulse would have been a
                 stranded accent no assertion in 10c, 10d, 10f or 10g could
                 see. The enclosing @keyframes NAME is carried down because
                 keyText alone ('50%') names nothing an excusal or a failure
                 message could be read against. */
              const name = rule.selectorText
                || (rule.keyText ? '@keyframes ' + (kfName || '<anonymous>') + ' ' + rule.keyText : null);
              if (rule.style && name) {
                rules++;
                /* DETECTION READS cssText, NOT THE LONGHAND LIST, and that is
                   the whole point. A shorthand whose value contains var() is
                   stored as a pending-substitution value: Chromium exposes it
                   under the SHORTHAND name only, and every longhand reads back
                   as the empty string. Measured on this document:
                     border: 1.5px solid var(--x, rgb(59, 191, 204))
                       -> 17 longhands, ALL EMPTY, needle never matched
                   styles.css already writes 'border: 1.5px solid
                   var(--welcome-accent)', so this is the live shape, not a
                   contrived one. The longhand loop below still runs, but only
                   to name the offending property for the excusal key. */
                const scanText = stripCustom(rule.style.cssText || '');
                let ruleHit = hunt(scanText);
                let matchedProp = null;
                for (let i = 0; i < rule.style.length; i++) {
                  const prop = rule.style[i];
                  if (prop.startsWith('--')) continue;
                  const v = rule.style.getPropertyValue(prop);
                  if (v !== '') decls++;
                  if (!matchedProp && v !== '' && hunt(v)) matchedProp = prop;
                }
                if (ruleHit) {
                  hits.push({
                    key: name.trim() + '|' + (matchedProp || '<shorthand or var() fallback>'),
                    text: name.trim() + ' { ' + scanText.trim() + ' }',
                    conds: cond.slice(),
                    /* Measured in the live screen context rather than inferred
                       from the condition text: an empty chain applies, and a
                       chain applies only if EVERY enclosing condition does. */
                    appliesOnScreen: cond.every((c) => window.matchMedia(c).matches),
                  });
                }
              }
              if (rule.cssRules && rule.cssRules.length) {
                walk(
                  rule.cssRules,
                  rule.conditionText ? cond.concat([rule.conditionText]) : cond,
                  rule.name || kfName
                );
              }
            }
          };
          for (const sheet of document.styleSheets) {
            sheets++;
            let r; 
            try { r = sheet.cssRules; } catch (e) { unreadable++; continue; }
            seen.push((sheet.href || '<inline>').split('/').pop());
            if (r) walk(r, [], null);
          }
          return { hits: hits, sheets: sheets, unreadable: unreadable, rules: rules, decls: decls, seen: seen };
        };
        const before = sweep();
        /* POSITIVE CONTROL. A sweep that has stopped matching reports a clean
           product, so every spelling a re-added literal could plausibly be
           written in is planted and required to be caught - including the two
           the previous needle set was measured to miss. The '-clean' and
           '-custom' rules are NEGATIVE controls: an over-broad sweep that
           reported every rule, or one that stopped excluding token
           declarations, would catch them and fail this check. */
        const probe = document.createElement('style');
        probe.textContent =
          '.folia-literal-selfcheck-hex { color: #279ea7 }' +
          '.folia-literal-selfcheck-upperhex { color: #3DBDC6 }' +
          '.folia-literal-selfcheck-rgb { color: rgb(61, 189, 198) }' +
          '.folia-literal-selfcheck-rgba { box-shadow: 0 0 8px rgba(231, 76, 60, 0.3) }' +
          '.folia-literal-selfcheck-varfallback { color: var(--folia-unset, #279EA7) }' +
          '.folia-literal-selfcheck-shorthand { border: 1px solid var(--folia-unset, rgb(59, 191, 204)) }' +
          '@keyframes foliaLiteralSelfcheckKf { 50% { box-shadow: 0 0 8px rgba(39, 158, 167, 0.3) } }' +
          '.folia-literal-selfcheck-clean { color: rgb(1, 2, 3) }' +
          '.folia-literal-selfcheck-custom { --folia-selfcheck-token: #279ea7 }';
        document.head.appendChild(probe);
        const planted = sweep();
        probe.remove();
        const after = sweep();
        const plantedKeys = planted.hits
          .map((h) => h.key)
          .filter((k) => k.toLowerCase().indexOf('selfcheck') !== -1);
        return JSON.stringify({
          hits: before.hits,
          sheets: before.sheets,
          unreadable: before.unreadable,
          rules: before.rules,
          decls: before.decls,
          seen: before.seen,
          plantedKeys: plantedKeys,
          afterCount: after.hits.length,
        });
      })()`),
    );
    const CONTROL_SPELLINGS = ["hex", "upperhex", "rgb", "rgba", "varfallback", "shorthand", "kf"];
    const caughtSpellings = CONTROL_SPELLINGS.filter((s) =>
      literalUses.plantedKeys.some((k) =>
        s === "kf" ? k.toLowerCase().includes("selfcheckkf ") : k.toLowerCase().includes(`selfcheck-${s}|`),
      ),
    );
    const falsePositives = literalUses.plantedKeys.filter((k) => /-(clean|custom)\|/.test(k));
    check(
      "10f: the literal sweep catches every spelling a re-added accent can wear (positive control)",
      caughtSpellings.length === CONTROL_SPELLINGS.length &&
        falsePositives.length === 0 &&
        literalUses.afterCount === literalUses.hits.length,
      `caught ${caughtSpellings.length}/${CONTROL_SPELLINGS.length} spellings [${caughtSpellings.join(", ")}], missed [${CONTROL_SPELLINGS.filter((s) => !caughtSpellings.includes(s)).join(", ")}]; ${falsePositives.length} negative control(s) wrongly caught [${falsePositives.join(", ")}]; after removal ${literalUses.afterCount} vs baseline ${literalUses.hits.length}`,
    );
    /* THE VACUITY GUARD IS A NAMED RELATIONSHIP, NOT A THRESHOLD. A scan-count
       floor is satisfiable by the wrong stylesheet, and it cannot notice that
       one product sheet became unreadable and took all of its declarations
       with it - an absence that would otherwise be reported as cleanliness. */
    const wantSheets = ["styles.css", "custom-styles.css"];
    const missingSheets = wantSheets.filter((s) => !literalUses.seen.includes(s));
    check(
      "10f: the literal sweep actually read both product stylesheets",
      missingSheets.length === 0 && literalUses.unreadable === 0,
      `missing [${missingSheets.join(", ")}], ${literalUses.unreadable} unreadable of ${literalUses.sheets} sheet(s); read [${literalUses.seen.join(", ")}]`,
    );
    const literalUnexcused = literalUses.hits.filter((h) => !LITERAL_EXCUSALS[h.key]);
    const literalExcused = literalUses.hits.filter((h) => LITERAL_EXCUSALS[h.key]);
    check(
      "no rule paints a frozen accent literal outside a custom-property declaration",
      literalUnexcused.length === 0,
      `${literalUnexcused.length} literal use(s) across ${literalUses.rules} rules / ${literalUses.decls} declarations: ${literalUnexcused.map((h) => h.text).join(" | ")}`,
    );
    /* THE EXCUSAL GATE MEASURES WHETHER THE RULE APPLIES, RATHER THAN READING
       THE WORD "print" IN ITS CONDITION. Measured on screen, in this window:
         @media print          conditionText "print"          matches FALSE
         @media screen, print  conditionText "screen, print"  matches TRUE
         @media not print      conditionText "not print"      matches TRUE
       A substring test excuses all three. Both halves are required: naming
       print keeps a literal from hiding behind any old never-matching at-rule
       (which is what R331 plants), and not applying on screen keeps
       `screen, print` from being waved through (R333). */
    const badContext = literalExcused.filter(
      (h) => !h.conds.some((c) => /\bprint\b/.test(c)) || h.appliesOnScreen,
    );
    check(
      "10f: every excused accent literal is in an at-rule that names print and does not apply on screen",
      badContext.length === 0,
      badContext
        .map(
          (h) =>
            `${h.text} under [${h.conds.join(" / ") || "no at-rule"}]${h.appliesOnScreen ? " which APPLIES ON SCREEN" : ""}`,
        )
        .join(" | "),
    );
    const staleLiteralExcusals = Object.keys(LITERAL_EXCUSALS).filter(
      (k) => !literalUses.hits.some((h) => h.key === k),
    );
    check(
      "10f: no accent-literal excusal is stale",
      staleLiteralExcusals.length === 0,
      `${staleLiteralExcusals.join(", ")} no longer paint a frozen accent literal, so the excusal now only hides a future one`,
    );

    /* ── 10f2: a var() fallback that is a literal colour ────────────────────
       A LITERAL FALLBACK IS A DEFECT IN EITHER OF THE ONLY TWO STATES IT CAN
       BE IN, which is what makes this a rule rather than a preference:
         - the variable is always declared, so the fallback is unreachable -
           dead paint that reads as a deliberate choice, and that a future
           editor will change expecting an effect; or
         - the variable is sometimes undeclared, so the fallback really does
           paint - a colour belonging to NO scheme, on a surface every scheme
           believes it controls, which is exactly the stranded-accent defect
           10c exists to catch, wearing a spelling 10c cannot see.
       Measured before this was written: the product carried two, both in the
       theme-menu chrome added by this item (--primary-color -> #2d9cdb, the
       pre-Folia accent, and --text-secondary -> #777), and both were in the
       FIRST state - --primary-color resolved to #3DBDC6 on a probe element in
       the live document, so neither fallback could ever have painted.
       Deliberately NOT limited to the frozen accent family: the whole point is
       that these colours belong to no palette, so there is no family to
       enumerate. */
    /* THE CLASSIFIER IS THE ENGINE, NOT A SPELLING LIST. The first version
       tested the fallback against a regex naming five syntaxes (#hex, rgb,
       hsl, color()), which is a list of the colour notations I happened to
       think of - it says nothing about `red`, `oklch()`, `lab()`, or whatever
       CSS Color 6 adds next, and each omission is a silent hole rather than a
       failure. CSS.supports('color', v) asks the shipped Chromium the exact
       question the assertion is named for. The only judgement left is the
       small set of values that ARE valid colours but name no palette entry -
       currentColor, transparent and the CSS-wide keywords - which are
       legitimate fallbacks and are excluded explicitly.

       THE var() PARSER IS PAREN-AWARE, AND THAT IS A FIX RATHER THAN A
       REFINEMENT. The regex it replaces could not see a nested fallback:
       `var(--a, var(--b, #fff))` handed it ` var(--b, #fff)`, which does not
       start with a colour, and its lastIndex then skipped past the inner
       expression entirely - so a literal one level down was invisible. Worse,
       the negative control in the positive-control set (`a var() chain must
       NOT be caught`) certified exactly that escape as correct behaviour. The
       parser now recurses into every fallback, and `-nested-hex` is in the
       caught set. */
    const varFbProbe = `(() => {
      const NON_PALETTE = new Set([
        'currentcolor', 'transparent', 'inherit', 'initial', 'unset',
        'revert', 'revert-layer', 'none', 'auto',
      ]);
      const wordish = (ch) =>
        !!ch && (ch === '-' || ch === '_' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9'));
      const isColour = (raw) => {
        const t = String(raw).trim();
        if (!t) return false;
        const k = t.toLowerCase();
        if (NON_PALETTE.has(k)) return false;
        if (k.slice(0, 4) === 'var(') return false;
        try { return CSS.supports('color', t); } catch (e) { return false; }
      };
      /* Top-level tokens, so a fallback that is a whole shorthand -
         box-shadow: var(--glow, 0 0 4px red) - still surrenders its colour,
         while rgb(1, 2, 3) stays one token. */
      const topTokens = (s) => {
        const out = [];
        let depth = 0, cur = '';
        for (let i = 0; i < s.length; i++) {
          const ch = s[i];
          if (ch === '(') depth++;
          if (ch === ')') depth--;
          if (depth === 0 && (ch === ' ' || ch === ',' || ch === '\\t' || ch === '\\n')) {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
          } else cur += ch;
        }
        if (cur.trim()) out.push(cur.trim());
        return out;
      };
      const findVars = (s, out) => {
        /* CSS FUNCTION NAMES ARE CASE-INSENSITIVE AND THE CSSOM DOES NOT
           NORMALISE THEM. Measured in this Chromium: a rule written
           'color: VAR(--nope, #ff0000)' serialises back out of cssText as
           'VAR(--nope, #ff0000)', verbatim. A scanner that compared against the
           literal lowercase 'var(' therefore walked straight past a perfectly
           valid literal fallback - the exact escape this section exists to
           close, and the second one found in it.
           Quoted strings are skipped for the opposite reason: a rule written
           'content: "var(--x, red)"' also survives into cssText intact, and
           reporting the text inside a string as a fallback would be a false
           accusation.
           NOTE FOR EDITORS: this comment lives inside an exec() template
           literal, so it must never contain a backtick - the recorded trap,
           which bit again while this very comment was being written. */
        for (let i = 0; i < s.length; i++) {
          const q = s[i];
          if (q === '"' || q === "'") {
            for (i++; i < s.length; i++) {
              if (s[i] === '\\\\') i++;
              else if (s[i] === q) break;
            }
            continue;
          }
          if (s.slice(i, i + 4).toLowerCase() !== 'var(' || wordish(s[i - 1])) continue;
          let depth = 0, j = i + 3;
          for (; j < s.length; j++) {
            if (s[j] === '(') depth++;
            else if (s[j] === ')') { depth--; if (depth === 0) break; }
          }
          if (j >= s.length) break;
          const inner = s.slice(i + 4, j);
          let d = 0, comma = -1;
          for (let k = 0; k < inner.length; k++) {
            if (inner[k] === '(') d++;
            else if (inner[k] === ')') d--;
            else if (inner[k] === ',' && d === 0) { comma = k; break; }
          }
          const name = (comma < 0 ? inner : inner.slice(0, comma)).trim();
          const fb = comma < 0 ? null : inner.slice(comma + 1).trim();
          out.push({ name: name, fb: fb });
          if (fb) findVars(fb, out);
          i = j;
        }
      };
      const scan = () => {
        const literal = [];
        const seen = [];
        const inventory = [];
        const consumed = {};
        let rules = 0, fallbacks = 0;
        const walk = (list) => {
          for (const rule of list) {
            if (rule.style) {
              rules++;
              const txt = rule.cssText || '';
              const body = txt.slice(txt.indexOf('{') + 1, txt.lastIndexOf('}'));
              const found = [];
              findVars(body, found);
              for (const v of found) {
                if (v.fb === null) {
                  if (!consumed[v.name]) {
                    consumed[v.name] = rule.selectorText || '<no selector>';
                  }
                  continue;
                }
                fallbacks++;
                inventory.push((rule.selectorText || '<no selector>') + ' | ' + v.name + ' -> ' + v.fb);
                const hit = isColour(v.fb) ? v.fb : (topTokens(v.fb).filter(isColour)[0] || null);
                if (hit) {
                  literal.push({
                    selector: rule.selectorText || '<no selector>',
                    key: (rule.selectorText || '<no selector>') + '|' + v.name,
                    text: (rule.selectorText || '<no selector>') + ' { ' + v.name + ' -> ' + hit + ' }',
                  });
                }
              }
            }
            if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
          }
        };
        for (const sheet of document.styleSheets) {
          let r;
          try { r = sheet.cssRules; } catch (e) { continue; }
          seen.push((sheet.href || '<inline>').split('/').pop());
          if (r) walk(r);
        }
        return {
          literal: literal, rules: rules, fallbacks: fallbacks,
          seen: seen, inventory: inventory,
          consumed: Object.keys(consumed).sort(),
          consumedBy: consumed,
        };
      };

      const before = scan();
      /* THE PLANT GOES THROUGH THE REAL WALK. Scanning the probe sheet with a
         private copy of the matcher proves the matcher, not the instrument:
         a walk that skipped inline sheets, or bailed on the first
         cross-origin throw, would report a clean document while the private
         copy went on catching everything it was handed. The probe stylesheet
         is appended to document.head and picked up by the same
         document.styleSheets traversal the real claim rests on. */
      const probe = document.createElement('style');
      probe.textContent =
        '.folia-varfb-selfcheck-hex { color: var(--folia-unset-a, #123456) }' +
        '.folia-varfb-selfcheck-rgb { color: var(--folia-unset-b, rgb(1, 2, 3)) }' +
        '.folia-varfb-selfcheck-kw { color: var(--folia-unset-e, rebeccapurple) }' +
        '.folia-varfb-selfcheck-modern { color: var(--folia-unset-f, oklch(0.7 0.1 200)) }' +
        '.folia-varfb-selfcheck-nested-hex { color: var(--folia-unset-g, var(--folia-unset-h, #abcdef)) }' +
        '.folia-varfb-selfcheck-inside { box-shadow: var(--folia-unset-i, 0 0 4px red) }' +
        '.folia-varfb-selfcheck-upper { color: VAR(--folia-unset-l, #654321) }' +
        '.folia-varfb-selfcheck-ok-chain { color: var(--folia-unset-c, var(--primary-color)) }' +
        '.folia-varfb-selfcheck-ok-kw { color: var(--folia-unset-d, inherit) }' +
        '.folia-varfb-selfcheck-ok-transparent { color: var(--folia-unset-j, transparent) }' +
        '.folia-varfb-selfcheck-ok-quoted::after { content: "var(--folia-unset-m, #ff0000)" }' +
        '.folia-varfb-selfcheck-ok-length { gap: var(--folia-unset-k, 4px) }';
      document.head.appendChild(probe);
      const planted = scan();
      probe.remove();
      const after = scan();

      const only = (set) => set.literal.filter((h) => h.selector.indexOf('.folia-varfb-selfcheck') === 0).map((h) => h.selector);
      return JSON.stringify({
        before: before,
        plantedHits: only(planted),
        plantedSheets: planted.seen.length,
        plantedRules: planted.rules,
        plantedFallbacks: planted.fallbacks,
        afterCount: after.literal.length,
        afterRules: after.rules,
      });
    })()`;
    const varFb = JSON.parse(await exec(varFbProbe));
    const varFallbacks = varFb.before;
    /* POSITIVE CONTROL, and it carries the assertion below: an absence claim
       over a scan that has stopped matching is satisfied for free. The '-ok-'
       rules are NEGATIVE controls - a var() chain with no literal at any
       depth, a CSS-wide keyword, `transparent`, a non-colour length and a
       var() spelled INSIDE A QUOTED STRING are all legitimate and must NOT be
       caught, or the rule degenerates into "no fallbacks at all".

       THE LAST TWO ENTRIES ON EACH SIDE WERE ADDED AFTER A REVIEW FINDING AND
       BOTH HALVES WERE MEASURED FIRST, because a control that cannot
       discriminate is worse than none:
         - `VAR(` really does survive into the CSSOM verbatim. Chromium
           canonicalises a COLOUR on its way in (10i rests on that) but does
           NOT normalise a FUNCTION NAME's case, so a case-sensitive scanner
           has a real escape hatch, not a theoretical one.
         - `content: "var(--x, red)"` also survives intact, so a scanner that
           does not skip quoted strings reports a literal fallback for a
           string that paints no colour at all. */
    const wantCaught = [
      ".folia-varfb-selfcheck-hex",
      ".folia-varfb-selfcheck-rgb",
      ".folia-varfb-selfcheck-kw",
      ".folia-varfb-selfcheck-modern",
      ".folia-varfb-selfcheck-nested-hex",
      ".folia-varfb-selfcheck-inside",
      ".folia-varfb-selfcheck-upper",
    ];
    const wronglyCaught = varFb.plantedHits.filter((s) => s.includes("-ok-"));
    const missed = wantCaught.filter((s) => !varFb.plantedHits.includes(s));
    check(
      "10f2: the literal-fallback scan catches every colour spelling and spares a legitimate one (positive control)",
      missed.length === 0 && wronglyCaught.length === 0,
      `caught [${varFb.plantedHits.join(", ")}]; missed [${missed.join(", ")}]; wrongly caught [${wronglyCaught.join(", ")}]`,
    );
    /* THE PLANT MUST ALSO GO AWAY. Without this, a scan that returned a stale
       or cached result would satisfy the control above on the planted run and
       the claim below on the clean one, with neither ever re-reading the
       document. */
    check(
      "10f2: removing the planted stylesheet returns the scan to a clean document",
      varFb.afterCount === varFallbacks.literal.length && varFb.afterRules === varFallbacks.rules,
      `clean ${varFallbacks.literal.length} literal / ${varFallbacks.rules} rules, after-plant-removal ${varFb.afterCount} / ${varFb.afterRules}`,
    );
    /* VACUITY FLOORS, AND THE FIRST ATTEMPT AT THEM WAS A PAIR OF GUESSES.
       The claim is an ABSENCE, so a walk that reached nothing satisfies it
       perfectly - but `rules >= 500` and `fallbacks >= 5` were numbers I
       picked, and running them measured 488 rules and exactly ONE var()
       fallback in the entire product. Guessing had produced a floor the
       healthy tree fails and a floor no realistic breakage would trip.
       Both are now MEASURED relationships:
         - the plant adds an exact number of rules and of fallbacks, so the
           delta across the same traversal cannot rot as the stylesheets grow;
           and
         - the product's var() fallback INVENTORY is pinned by name, the same
           pattern 10f uses for the glow alphas. That is strictly stronger
           than a count: it proves the walk reached the product's own rules
           and not merely the plant, and it makes a new fallback - the thing
           this section exists to adjudicate - fail loudly and by name rather
           than slip under a threshold. */
    const PLANT_RULES = 12;
    /* TWELVE FALLBACKS FROM TWELVE RULES, AND THE ARITHMETIC IS NOT THE
       IDENTITY IT LOOKS LIKE - two rules pull it in opposite directions and
       both are load-bearing:
         + the -nested-hex rule spells two var() expressions,
           `var(--g, var(--h, #abcdef))`, and the recursion visits both. The
           regex this parser replaced saw one, so this is a standing check
           that the nested walk still happens.
         - the -ok-quoted rule spells a var() INSIDE A QUOTED STRING, which
           the parser must skip entirely, so it contributes a rule and NO
           fallback. Were the quote-skipping removed, this delta would read 13
           and the count would fail even though the '-ok-' selector would also
           show up in wronglyCaught - the two controls fail together on
           purpose, from opposite directions. */
    const PLANT_FALLBACKS = 12;
    check(
      "10f2: the literal-fallback scan really traversed the product's stylesheets",
      varFallbacks.seen.length >= 2 &&
        varFb.plantedSheets === varFallbacks.seen.length + 1 &&
        varFb.plantedRules - varFallbacks.rules === PLANT_RULES &&
        varFb.plantedFallbacks - varFallbacks.fallbacks === PLANT_FALLBACKS,
      `${varFallbacks.seen.length} sheet(s) [${varFallbacks.seen.join(", ")}] -> ${varFb.plantedSheets} with the plant; ` +
        `rules ${varFallbacks.rules} -> ${varFb.plantedRules} (delta ${varFb.plantedRules - varFallbacks.rules}, want ${PLANT_RULES}); ` +
        `fallbacks ${varFallbacks.fallbacks} -> ${varFb.plantedFallbacks} (delta ${varFb.plantedFallbacks - varFallbacks.fallbacks}, want ${PLANT_FALLBACKS})`,
    );
    /* THE RECORDED INVENTORY. One entry, and it is a LENGTH rather than a
       colour: the table-breakout budget legitimately falls back to 100% when
       no budget has been published yet. Adding a var() fallback to this
       codebase is rare enough, and consequential enough, that it should
       require a line here. */
    const VAR_FALLBACK_INVENTORY = [".markdown-body .table-container.table-breakout | --mv-breakout-budget -> 100%"];
    const invActual = (varFallbacks.inventory || []).slice().sort();
    const invWanted = VAR_FALLBACK_INVENTORY.slice().sort();
    check(
      "10f2: the product's var() fallback inventory is exactly what was recorded",
      invActual.length === invWanted.length && invActual.every((s, i) => s === invWanted[i]),
      `found [${invActual.join(" ; ")}], recorded [${VAR_FALLBACK_INVENTORY.join(" ; ")}]`,
    );
    check(
      "10f2: no rule falls back to a literal colour when a token is missing",
      varFallbacks.literal.length === 0,
      `${varFallbacks.literal.length} literal fallback(s) across ${varFallbacks.rules} rules / ${varFallbacks.fallbacks} var() fallback(s) in [${varFallbacks.seen.join(", ")}]: ${varFallbacks.literal.map((h) => h.text).join(" | ")}`,
    );
    /* THE CONVERSE, AND WITHOUT IT THE RULE ABOVE IS A TRADE RATHER THAN A
       FIX. "No literal fallbacks" removes the safety net; it does not say the
       net is unnecessary. A declaration reading `var(--text-secondary)` with
       no fallback becomes INVALID AT COMPUTED-VALUE TIME if the token is
       missing - for `color` that means it INHERITS, so a scheme block that
       forgot the token would silently paint the menu caption in the row's own
       ink. That is exactly the "reads as a row" defect R343 exists to prevent,
       arriving by a path R343 cannot see, because R343 watches the rule and
       this failure is in the token.
       READ IN ALL SIX STATES, because the risk is per-scheme: the defaults can
       carry every token while a curated block omits one.

       AN EXACT SET, NOT A FILTERED ONE, and that correction came from running
       it. The first form excluded a recorded list and asserted the remainder
       empty, on the premise that an unresolved token is always a mistake. It
       is not: `--tok-block-comment: inherit` is how this stylesheet SAYS
       "Solarized Light writes no rule for block comments", and a custom
       property declared `inherit` on body inherits from html, which has none,
       so it computes to the guaranteed-invalid value and reads back EMPTY -
       indistinguishable from a token nobody declared. Four light-default cells
       are deliberately in that state and reproducing it is the whole point of
       the frozen default.
       So the claim is equality in BOTH directions against a per-state table.
       A scheme that forgets a token appears as an EXTRA and fails; a cell that
       stops being deliberately-inherited appears as a MISSING and fails, which
       makes the table self-expiring in the same way the drift excusals are -
       an entry cannot outlive its reason. A filter could only ever have caught
       the first of those two. */
    const UNRESOLVED_BY_DESIGN = {
      /* Published onto the table container by JavaScript
         (renderer.js:5129 sets --table-breakout-width; --mv-breakout-applied is
         derived from it in the same rule), so body legitimately has neither. */
      "*": ["--mv-breakout-applied", "--table-breakout-width"],
      /* The four cells where Solarized Light declares no rule at all and the
         stylesheet reproduces that with `inherit` rather than by guessing a
         value. Every other state declares all four. */
      "default-light": [
        "--tok-block-comment",
        "--tok-function-name",
        "--tok-namespace",
        "--tok-operator",
      ],
    };
    const VAR_PROBE = `(() => {
      const names = ${JSON.stringify(varFallbacks.consumed)};
      const cs = getComputedStyle(document.body);
      const empty = [];
      for (const n of names) {
        if (!cs.getPropertyValue(n).trim()) empty.push(n);
      }
      return JSON.stringify(empty);
    })()`;
    const varMissing = [];
    const VAR_STATES = [
      ["light", null, "default-light"],
      ["dark", null, "default-dark"],
      ...SCHEME_STATES.map(([m, s]) => [m, s, s]),
    ];
    for (const [mode, scheme, label] of VAR_STATES) {
      await applySettled(mode, scheme, `10f3 ${label}`);
      const empty = JSON.parse(await exec(VAR_PROBE)).sort();
      const want = [
        ...UNRESOLVED_BY_DESIGN["*"],
        ...(UNRESOLVED_BY_DESIGN[label] || []),
      ].sort();
      for (const n of empty) {
        if (!want.includes(n)) {
          varMissing.push(
            `${label}: --${n.replace(/^--/, "")} does not resolve, consumed by ${varFallbacks.consumedBy[n]}`,
          );
        }
      }
      for (const n of want) {
        if (!empty.includes(n)) {
          varMissing.push(
            `${label}: ${n} now resolves, so its by-design entry must go`,
          );
        }
      }
    }
    check(
      "10f3: every token consumed without a fallback resolves, except exactly the cells recorded as deliberately inherited",
      varFallbacks.consumed.length >= 80 && varMissing.length === 0,
      `${varFallbacks.consumed.length} fallback-free token(s) consumed (floor 80); ` +
        `${varMissing.length} mismatch(es): ${varMissing.slice(0, 6).join(" | ")}`,
    );
    await applySettled("light", null, "restore after fallback-free token probe");

    await applySettled("light", null, "restore after glow probe");

    // ── 10g: contrast in the states getComputedStyle cannot reach ───────────
    // 10d samples RESTING surfaces, because that is all a sweep over
    // document.querySelectorAll('*') can see. Every :hover and :focus repaint
    // in the product is therefore outside its subject set - and that is not a
    // theoretical gap: .search-btn:hover was the ONE accent-background rule in
    // the stylesheet that did not also set --on-accent-fg, and it measured
    // 1.86:1 under abyss and 1.75:1 under ember, worse than the frozen
    // defaults' worst cell anywhere. Ten sections of assertions reported a
    // clean sweep over it.
    //
    // THE INSTRUMENT IS REPLAY, not a forced pseudo-class: the rule's own
    // declarations are written onto the REAL element as inline styles, which
    // beat every author rule, so what is measured is the element's resting
    // cascade with the hover rule applied on top - which is what :hover does.
    // Transitions are pinned off during the replay for the reason recorded at
    // settleTransitions(): a colour read while a transition is running is the
    // PREVIOUS state's colour, and here the replay itself is what starts it.
    const HOVER_PROBE = `(() => {
      function parse(c) {
        const m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(c);
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
      }
      function lum(c) {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      }
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      /* A TRANSLUCENT FILL IS COMPOSITED, NOT SKIPPED. The first version of
         this walk took the nearest ancestor with alpha >= 0.95 as the surface,
         which silently discarded the very layer the hover rule had just
         painted: .welcome-readme-btn:hover paints its accent tint at alpha
         0.10, so the ink was scored against the PAGE behind it and the ratio
         came out flattering. Compositing every layer from the backdrop forward
         measures what the eye actually receives. */
      function over(fg, bg) {
        return {
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a),
          a: 1,
        };
      }
      function surfaceOf(el) {
        const stack = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) {
            stack.push(c);
            if (c.a >= 0.999) break;
          }
        }
        let out = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
        return out;
      }
      /* THE ACCENT IS IDENTIFIED BY CHROMA, NOT BY NAME. An earlier gate
         compared the element's fill against the resolved --primary-color, so
         it saw exactly one of the product's accent variables; --accent-hover,
         --danger-bg-hover and --welcome-solid-hover all repaint elements and
         were invisible to it. Naming the family instead would trade one stale
         list for a longer one and would need a separate revert per limb.
         What actually matters is not WHICH variable painted the surface but
         whether the ink still has a relationship to it: ink chosen against a
         NEUTRAL surface has none once a SATURATED one is painted underneath.
         So the predicate is measured - achromatic rest, chromatic fill - and
         one revert proves the whole gate. */
      const chroma = (c) => Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
      /* focus-within IS LISTED BEFORE focus AND THAT IS NOT COSMETIC. The
         alternation is used both to DETECT a state selector and to strip it
         back to a bare one, and \\b sits happily between "focus" and the "-" of
         "focus-within". With the shorter alternative first, ":focus-within"
         strips to "-within" - a syntactically invalid selector, so
         querySelector throws, the rule lands in "unmatched", and a real hover
         surface leaves the subject set without anything failing. */
      const STATE = /:(hover|focus-within|focus-visible|focus|active)\\b/;
      const STATE_G = /:(hover|focus-within|focus-visible|focus|active)\\b/g;
      const collected = [];
      /* A GROUPING RULE THAT DOES NOT APPLY MUST NOT CONTRIBUTE SUBJECTS.
         @media print carries its own hover rules; replaying them on screen
         measures a pairing the reader can never see, and - worse - a print
         rule that legitimately drops a background would be scored as a
         stranded ink. matches() asks the engine rather than parsing the
         condition, so a future @supports or nested @media needs no new code. */
      const groupApplies = (rule) => {
        if (rule.media && rule.conditionText) {
          try { return window.matchMedia(rule.conditionText).matches; }
          catch (e) { return true; }
        }
        return true;
      };
      const walk = (rules) => {
        for (const rule of rules) {
          if (rule.style && rule.selectorText && STATE.test(rule.selectorText)) {
            /* A pseudo-ELEMENT paints no text of its own and cannot be
               selected, so replaying onto it is impossible; ::after glows are
               10f's subject, not this section's. */
            if (rule.selectorText.indexOf('::') === -1) {
              /* DECLARATIONS ARE PARSED OUT OF cssText, NOT read off
                 rule.style, and that is load-bearing rather than stylistic.
                 A SHORTHAND HOLDING var() IS A PENDING-SUBSTITUTION VALUE: the
                 CSSOM enumerates it as its longhands and serialises every one
                 of them as the EMPTY STRING. So the obvious loop over
                 rule.style[i] silently DROPS "background: var(--primary-color)"
                 - which is how every accent fill in the product is written.
                 Measured before this was fixed: .btn:hover replayed its accent
                 INK onto the element's RESTING grey and reported 1.23:1, a
                 fabricated failure, while the real accent-fill rules it exists
                 to check were never exercised at all. Same serialisation trap
                 the default-fidelity probe hit on border-color, in the other
                 direction. */
              const decls = [];
              const block = rule.cssText.slice(
                rule.cssText.indexOf('{') + 1, rule.cssText.lastIndexOf('}'));
              let depth = 0, quote = null, cur = '';
              const flush = () => {
                const t = cur.trim(); cur = '';
                if (!t) return;
                const c = t.indexOf(':');
                if (c <= 0) return;
                decls.push([t.slice(0, c).trim().toLowerCase(), t.slice(c + 1).trim()]);
              };
              for (const ch of block) {
                if (quote) { if (ch === quote) quote = null; cur += ch; continue; }
                if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
                else if (ch === ';' && depth === 0) { flush(); continue; }
                cur += ch;
              }
              flush();
              const paints = decls.some((d) => d[0] === 'background' ||
                d[0] === 'background-color' || d[0] === 'color' ||
                d[0] === 'stroke' || d[0] === 'fill');
              /* THE SELECTOR LIST IS SPLIT AND FILTERED PER PART. A rule
                 written ".a, .b:hover" tests true as a whole, and stripping
                 states across the whole string yields ".a, .b" - so ".a", an
                 element this rule never puts into a state, is replayed as if
                 it were a hover subject. Only the parts that carry a state are
                 kept. */
              if (paints) {
                const parts = [];
                let d2 = 0, q2 = null, buf = '';
                for (const ch of rule.selectorText) {
                  if (q2) { if (ch === q2) q2 = null; buf += ch; continue; }
                  if (ch === '"' || ch === "'") { q2 = ch; buf += ch; continue; }
                  if (ch === '(' || ch === '[') d2++;
                  else if (ch === ')' || ch === ']') d2--;
                  else if (ch === ',' && d2 === 0) { parts.push(buf); buf = ''; continue; }
                  buf += ch;
                }
                parts.push(buf);
                for (const p of parts) {
                  const t = p.trim();
                  if (t && STATE.test(t)) collected.push({ sel: t, decls: decls });
                }
              }
            }
          }
          if (rule.cssRules && rule.cssRules.length && groupApplies(rule)) walk(rule.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        if (rules) walk(rules);
      }
      const cells = [];
      const unmatched = [];
      let matched = 0;
      let declaredBg = 0, landedBg = 0;
      const droppedBg = [];
      /* The accent is resolved through the ENGINE rather than parsed out of
         the custom property, so the comparison below is between two values the
         engine produced and serialised the same way. */
      /* Chroma of every resting surface and every state fill, so the
         classifier's own separation can be asserted rather than assumed. */
      const chromaBands = [];
      const accentNoInk = [];
      const capped = [];
      const HOVER_ELS_CAP = 40;
      for (const r of collected) {
        const bare = r.sel.replace(STATE_G, '');
        let els = [];
        try { els = Array.prototype.slice.call(document.querySelectorAll(bare)); }
        catch (e) { els = []; }
        if (!els.length) { unmatched.push(r.sel); continue; }
        /* EVERY MATCH IS MEASURED, NOT THE FIRST. A single querySelector makes
           the subject set depend on document order: .context-menu-item:hover
           matches a dozen rows, and if the first happens to carry an icon while
           a later one carries only text, the text pairing is never scored.
           Measured: this took the subject set from 30 cells to 146.
           THE CAP IS A SAFETY VALVE, NOT A SAMPLING STRATEGY, and an assertion
           requires it never to fire. The widest rule in the product today
           reaches 30 nodes (.context-menu-item:hover), so a rule arriving at 40
           is one whose reach has changed, and the right response is to look at
           it rather than to quietly measure a prefix and report a clean sweep
           over a subject set that silently shrank. */
        if (els.length > HOVER_ELS_CAP) { capped.push(r.sel + ' x' + els.length); }
        els = els.slice(0, HOVER_ELS_CAP);
        matched++;
        for (const el of els) {
        const restSurf = surfaceOf(el);
        const saved = el.getAttribute('style');
        el.style.setProperty('transition', 'none', 'important');
        /* A VALUE CARRYING !important IS REJECTED BY setProperty AND THE
           DECLARATION SILENTLY DOES NOTHING. cssText hands back the priority
           inside the value string, so "#fff !important" must be split into the
           value and the priority argument before it will land. Everything here
           is replayed at "important" anyway, so the priority is not otherwise
           load-bearing - what matters is that the value stops being
           syntactically invalid. Uncaught, this is the fill-dropping failure
           the positive control below exists to name. */
        for (const d of r.decls) {
          el.style.setProperty(d[0], d[1].replace(/\\s*!\\s*important\\s*$/i, ''), 'important');
        }
        /* POSITIVE CONTROL FOR THE REPLAY ITSELF. Every measurement below is a
           pairing of an ink with a fill, and a replay that silently drops the
           fill produces a fully-formed, entirely fictitious ratio - it reads
           the hover ink against the RESTING background. That is not
           hypothetical: it is exactly what the CSSOM longhand enumeration did
           here before the cssText parse replaced it. So a rule that DECLARES a
           background must be observed to carry one inline afterwards. */
        const declaresBg = r.decls.some(
          (d) => d[0] === 'background' || d[0] === 'background-color');
        if (declaresBg) {
          declaredBg++;
          if (el.style.getPropertyValue('background') ||
              el.style.getPropertyValue('background-color')) landedBg++;
          else droppedBg.push(r.sel);
        }
        const cellsBefore = cells.length;
        /* Scoped to the replayed element's own subtree. Most buttons put their
           label in a <span>, so measuring the element itself would miss the
           ink entirely - the same finding that shaped CONTRAST_PROBE.
           ICONS COUNT, and they are the reason this probe exists at all: the
           defect that motivated the section (.search-btn:hover) paints no text
           whatsoever - its ink is an <svg> stroked with currentColor - so a
           text-only sweep would have reported the very rule it was written for
           as having nothing to measure. Icon ink is scored against WCAG 1.4.11
           (non-text contrast, 3:1), not 1.4.3's 4.5:1, because that is the
           criterion that actually applies to a graphical control. */
        const nodes = [el].concat([].slice.call(el.querySelectorAll('*')));
        for (const n of nodes) {
          const tag = n.tagName.toLowerCase();
          const paintsText = [].slice.call(n.childNodes).some(
            (x) => x.nodeType === 3 && x.textContent.trim());
          const ncs = getComputedStyle(n);
          let kind = null, inkSrc = null;
          if (paintsText) { kind = 'text'; inkSrc = ncs.color; }
          else if (tag === 'svg') {
            const stroke = ncs.stroke, fill = ncs.fill;
            const useStroke = stroke && stroke !== 'none';
            const useFill = fill && fill !== 'none';
            if (useStroke || useFill) { kind = 'icon'; inkSrc = useStroke ? stroke : fill; }
          }
          if (!kind) continue;
          let o = 1;
          for (let a = n; a; a = a.parentElement) {
            const v = parseFloat(getComputedStyle(a).opacity);
            o *= isNaN(v) ? 1 : v;
          }
          if (o === 0) continue;
          let bg = surfaceOf(n);
          const fg = parse(inkSrc);
          if (!bg || !fg) continue;
          const ink = o >= 0.999 ? fg : {
            r: o * fg.r + (1 - o) * bg.r,
            g: o * fg.g + (1 - o) * bg.g,
            b: o * fg.b + (1 - o) * bg.b,
          };
          cells.push({
            rule: r.sel,
            kind: kind,
            tag: tag + (n.className && typeof n.className === 'string' &&
              n.className.trim() ? '.' + n.className.trim().split(/\\s+/)[0] : ''),
            o: o,
            r: ratio(fg, bg),
            rEff: ratio(ink, bg),
            fg: 'rgb(' + fg.r + ',' + fg.g + ',' + fg.b + ')',
            bg: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')',
          });
        }
        /* THE CAUSE, asserted beside the consequence. A rule that repaints a
           NEUTRAL element with a SATURATED fill changes the surface its ink
           lands on, so it owns that ink - inherited colour was chosen against
           the neutral surface and has no relationship to the new one.
           Measuring the ratio catches this only in the states where the two
           happen to differ; naming the missing declaration catches it
           everywhere.
           THE REST->STATE SHAPE IS THE WHOLE POINT, and it is why this is not
           simply "the fill is an accent". Measured across all six states, six
           rules repaint with an accent variable and declare no ink -
           .editor-save-btn, .editor-exit-btn, .welcome-open-btn,
           .file-update-btn.reload, .app-update-btn.primary and
           .note-dialog-btn.primary - and every one of them is ALREADY a
           saturated button at rest (chroma 128-171), merely shifting to its
           hover shade. Their ink was chosen against the accent and is still
           correct over it, so demanding a redeclaration would be six false
           positives. Only a neutral resting surface orphans the ink.
           GATED ON THE ELEMENT ACTUALLY HAVING INK, and that is deliberately
           structural rather than an excusal list: .editor-splitter is exactly
           the neutral->saturated shape (chroma 0 -> 137) and carries neither
           text nor icon, so demanding a colour from it would be demanding a
           declaration with nothing to declare it for. Deriving the exemption
           from "produced no measurable cell" means a splitter that later gains
           a label stops being exempt by itself. */
        if (cells.length > cellsBefore) {
          const stateSurf = surfaceOf(el);
          chromaBands.push({ sel: r.sel, rest: chroma(restSurf),
            state: chroma(stateSurf) });
          if (chroma(restSurf) <= 40 && chroma(stateSurf) >= 40 &&
              !r.decls.some((d) => d[0] === 'color' || d[0] === 'stroke' ||
                d[0] === 'fill')) accentNoInk.push(r.sel);
        }
        if (saved === null) el.removeAttribute('style'); else el.setAttribute('style', saved);
        }
      }
      return JSON.stringify({
        collected: collected.length,
        collectedSels: collected.map((c) => c.sel),
        matched: matched,
        unmatched: unmatched, cells: cells, capped: capped,
        declaredBg: declaredBg, landedBg: landedBg, droppedBg: droppedBg,
        accentNoInk: accentNoInk, chromaBands: chromaBands,
      });
    })()`;

    /* THE INSTRUMENT'S OWN SELF-CHECK, and it exists because three of the
       hardenings above are INERT against today's stylesheet. Keeping
       :focus-within intact while stripping it, refusing to descend into an
       @media that does not apply, and lifting !important out of a value before
       setProperty will accept it all changed ZERO subjects when they landed.
       The comma split is the exception and IS live: two real rules here
       (.editor-splitter:hover, .editor-splitter.dragging and
       .mermaid-tpl-btn:hover, .mermaid-tpl-btn.active) pair a state part with a
       plain class part, and the old whole-selector strip replayed the class
       part as though it were a hover subject.
       This project's rule is that an unreachable guard is still a contract but
       must be restated where it CAN be falsified, so each one is exercised
       against a synthetic stylesheet injected into the real document and
       collected by the real walk. A copy of the parser would prove nothing
       about the parser that runs. */
    const HOVER_SELFCHECK_UP = `(() => {
      const s = document.createElement('style');
      s.id = '__sc_style';
      s.textContent = [
        '.__sc-a, .__sc-b:hover { color: rgb(1,2,3); background: rgb(4,5,6); }',
        '.__sc-c:focus-within { color: rgb(7,8,9); background: rgb(10,11,12); }',
        '@media print { .__sc-d:hover { color: rgb(13,14,15);' +
          ' background: rgb(16,17,18); } }',
        '.__sc-e:hover { color: rgb(19,20,21) !important;' +
          ' background: rgb(22,23,24) !important; }'
      ].join('\\n');
      document.head.appendChild(s);
      const host = document.createElement('div');
      host.id = '__sc_host';
      for (const c of ['__sc-a', '__sc-b', '__sc-c', '__sc-d', '__sc-e']) {
        const d = document.createElement('div');
        d.className = c;
        d.textContent = 'x';
        host.appendChild(d);
      }
      document.body.appendChild(host);
      return document.querySelectorAll('#__sc_host > div').length;
    })()`;
    const HOVER_SELFCHECK_DOWN = `(() => {
      for (const id of ['__sc_style', '__sc_host']) {
        const n = document.getElementById(id);
        if (n) n.remove();
      }
      return document.querySelectorAll('[class^="__sc-"]').length +
        (document.getElementById('__sc_style') ? 1 : 0);
    })()`;

    /* Cells are keyed by rule + the tag that painted them, disambiguated by
       occurrence: a rule like `.markdown-body tr:hover` legitimately paints
       several identical cells, and collapsing them by name would compare a
       scheme's first cell against the default's second. */
    const hoverPaths = (got) => {
      const seen = new Map(), out = [];
      for (const c of got.cells) {
        const base = `${c.rule} > ${c.tag}`;
        const n = (seen.get(base) || 0) + 1;
        seen.set(base, n);
        out.push(Object.assign({ path: n === 1 ? base : `${base}#${n}` }, c));
      }
      return out;
    };
    /* WCAG applies two DIFFERENT minima and this section respects both rather
       than picking the stricter one and calling it rigour: 1.4.3 asks 4.5:1 of
       text, 1.4.11 asks 3:1 of the graphical parts of a control. Holding icons
       to 4.5 would happen to pass today and would reject a future scheme for
       missing a bar the standard never set. */
    const HOVER_MIN = { text: 4.5, icon: 3 };
    const hoverBase = {};
    for (const mode of ["light", "dark"]) {
      await applySettled(mode, null, mode + " default (hover baseline)");
      hoverBase[mode] = JSON.parse(await exec(HOVER_PROBE));
    }

    /* Every selector here was verified by reading its consumer: each names a
       surface that genuinely does not exist in a resting document, so a replay
       has nothing to write onto. The list is asserted in BOTH directions - an
       unexcused miss fails, and an excusal that has stopped being needed fails
       too, so the map cannot quietly become a licence to lose coverage. */
    const HOVER_EXCUSALS = {
      ".notes-item:hover": "the notes panel renders one item per note; the census document carries none",
      ".mermaid-maximize-btn:hover": "injected into a rendered mermaid diagram, and the fixture has no diagram",
      ".code-copy-btn.copied:hover": "the .copied class exists only for the ~2s after a copy click",
      ".context-menu-item.disabled:hover": "the .disabled variant is applied only while an action is unavailable",
      ".note-tooltip-close:hover": "the tooltip is built on demand when a note marker is hovered",
      ".tools-menu-recent-item:hover": "the recent-files list is empty in the suite's isolated userData profile",
      ".tab:hover": "the tab strip renders only for open documents; this suite opens none",
      ".tab-close:hover": "same - no tab exists to carry a close button",
      "body.dark-mode .tab-close:hover": "same - no tab exists to carry a close button",
    };
    /* RUN IN BOTH MODES, and that is not symmetry for its own sake. A
       mode-scoped selector cannot be falsified from the wrong side: in light,
       body.dark-mode .tab-close misses because the BODY is not dark, so its
       excusal ("no tab exists to carry a close button") stays green forever
       even if a tab strip returns. Checking dark too means the excusal is
       tested against the absence it actually names. */
    {
      const planted = Number(await exec(HOVER_SELFCHECK_UP));
      const sc = JSON.parse(await exec(HOVER_PROBE));
      const left = Number(await exec(HOVER_SELFCHECK_DOWN));
      const has = (s) => sc.collectedSels.indexOf(s) !== -1;
      check(
        "hover replay self-check: the synthetic stylesheet was really installed and removed",
        planted === 5 && left === 0,
        `planted ${planted} elements, ${left} left behind`,
      );
      check(
        "hover replay self-check: a selector list contributes only the parts that carry a state",
        has(".__sc-b:hover") && !has(".__sc-a") && !has(".__sc-a, .__sc-b:hover"),
        `collected ${JSON.stringify(sc.collectedSels.filter((s) => s.indexOf("__sc") !== -1))}`,
      );
      check(
        "hover replay self-check: :focus-within is collected and strips to a valid bare selector",
        has(".__sc-c:focus-within") &&
          sc.unmatched.indexOf(".__sc-c:focus-within") === -1,
        `collected=${has(".__sc-c:focus-within")}, unmatched=${sc.unmatched.indexOf(".__sc-c:focus-within") !== -1}`,
      );
      check(
        "hover replay self-check: a rule inside a non-matching @media contributes nothing",
        !has(".__sc-d:hover"),
        "an @media print hover rule reached the on-screen subject set",
      );
      check(
        "hover replay self-check: a value carrying !important still lands on the probe element",
        has(".__sc-e:hover") && sc.droppedBg.indexOf(".__sc-e:hover") === -1,
        `collected=${has(".__sc-e:hover")}, droppedBg=${JSON.stringify(sc.droppedBg)}`,
      );
    }
    for (const mode of ["light", "dark"]) {
      const got = hoverBase[mode];
      console.log(
        `  note  hover replay (${mode}): collected ${got.collected}, ` +
          `matched ${got.matched}, cells ${got.cells.length}`,
      );
      check(
        `hover replay (${mode}): enough rules were collected, matched and measured`,
        got.collected >= 30 && got.matched >= 24 && got.cells.length >= 90,
        `collected ${got.collected}, matched ${got.matched}, cells ${got.cells.length}`,
      );
      const unexcused = got.unmatched.filter((s) => !HOVER_EXCUSALS[s]);
      check(
        `hover replay (${mode}): every rule the probe could not reach is a named, still-absent surface`,
        unexcused.length === 0,
        unexcused.join(" | "),
      );
      check(
        `hover replay (${mode}): no rule matched more elements than the probe measured`,
        got.capped.length === 0,
        `capped at ${got.capped.join(" | ")}`,
      );
      const stale = Object.keys(HOVER_EXCUSALS).filter(
        (s) => got.unmatched.indexOf(s) === -1,
      );
      check(
        `hover replay (${mode}): no excusal has outlived the absence it describes`,
        stale.length === 0,
        stale.join(" | "),
      );
    }

    /* THE POSITIVE CONTROL FOR THE INSTRUMENT, and it is not decorative: the
       first version of this probe read declarations off rule.style, which
       serialises a var()-bearing SHORTHAND as empty longhands. Every
       `background: var(--primary-color)` was silently dropped, so the accent
       rules this section exists to check were measured with the accent ink on
       the element's RESTING fill - .btn:hover reported a fully-formed,
       entirely fictitious 1.23:1. A dropped fill is indistinguishable from a
       real failure, which is exactly why it needs its own named assertion. */
    let bgDeclared = 0, bgLanded = 0;
    const bgDropped = [];
    const accentNoInk = new Set();
    const chromaSeen = [];
    const noteState = (got) => {
      bgDeclared += got.declaredBg;
      bgLanded += got.landedBg;
      for (const s of got.droppedBg) bgDropped.push(s);
      for (const s of got.accentNoInk) accentNoInk.add(s);
      for (const b of got.chromaBands) chromaSeen.push(b);
    };
    noteState(hoverBase.light);
    noteState(hoverBase.dark);

    for (const mode of ["light", "dark"]) {
      const worst = hoverPaths(hoverBase[mode])
        .slice()
        .sort((a, b) => a.rEff - b.rEff)
        .slice(0, 6)
        .map((c) => `${c.path} ${c.rEff.toFixed(2)}`);
      console.log(`  note  ${mode} default worst hover cells: ${worst.join(", ")}`);
    }

    /* THE DEFAULTS' HOVER CELLS ARE ASSERTED, NOT MERELY RECORDED, and this is
       the guard the section spent its first draft without. Every bar below is
       RELATIVE to a default measured in the same run, so a change that moved a
       default hover rule moved the yardstick with it and the whole section
       reported a clean sweep. That is not a hypothetical: adding
       --welcome-readme-ink-hover to :root instead of body repainted the DARK
       default's hover ink from #3bbfcc to #279EA7 - a plain violation of the
       byte-exactness requirement - and every one of these assertions passed.
       IT IS COMPARED AGAINST HEAD RATHER THAN AGAINST A STORED FIXTURE. A
       golden file records what the defaults looked like on the day someone
       remembered to regenerate it, and its provenance decays silently from
       then on; HEAD is the thing the requirement actually names. So both
       stylesheet generations are measured IN THE SAME RUN, through the same
       instrument, on the same DOM - the only difference between the two halves
       is which bytes the engine parsed. */
    const gitShow = (rel) =>
      require("child_process")
        .execFileSync("git", ["show", "HEAD:" + rel], {
          cwd: path.join(__dirname, ".."),
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
        });
    const headSheets = {
      "styles.css": gitShow("src/styles.css"),
      "custom-styles.css": gitShow("src/custom-styles.css"),
    };
    /* MEASURED THROUGH THE REAL CASCADE, NOT THROUGH THE REPLAY, and the
       difference is the whole reason this assertion needed a second
       instrument. The replay above writes ONE rule's declarations onto an
       element, which is the right tool for asking "does this rule set its own
       ink" but the wrong one for asking "does this element still look the
       same": HEAD spells the dark chrome as a base rule PLUS a
       `body.dark-mode` override, while the working tree folds both into one
       tokenised rule. Replaying the base rule alone reproduces a state the
       product never renders, so the first version of this check reported
       .nav-btn's backdrop moving and body.dark-mode .search-btn:hover going
       "gone" - three findings that were all artifacts of rules being
       reorganised, with no pixel behind any of them.
       So the state pseudo-classes are rewritten into real CLASSES - identical
       specificity, so every rule keeps its exact weight and order - and the
       ENGINE resolves the cascade. Cells are keyed by DOM POSITION rather than
       by rule, because the rule that paints an element is exactly the thing
       this change is allowed to alter; the pixel is not. */
    const toClasses = (css) =>
      css
        .replace(/:focus-visible/g, ".__st_fv")
        .replace(/:focus(?!-)/g, ".__st_foc")
        .replace(/:hover/g, ".__st_hov")
        .replace(/:active/g, ".__st_act");
    const genSheets = {
      head: {
        "styles.css": toClasses(headSheets["styles.css"]),
        "custom-styles.css": toClasses(headSheets["custom-styles.css"]),
      },
      tree: {
        "styles.css": toClasses(
          fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8")),
        "custom-styles.css": toClasses(
          fs.readFileSync(path.join(__dirname, "..", "src", "custom-styles.css"), "utf8")),
      },
    };
    const installGen = (texts) => `(() => {
      for (const s of Array.prototype.slice.call(
        document.querySelectorAll('style[data-head-swap]'))) s.remove();
      const links = Array.prototype.slice.call(
        document.querySelectorAll('link[rel="stylesheet"]'));
      const texts = ${JSON.stringify(texts)};
      let n = 0;
      for (const l of links) {
        const t = texts[l.getAttribute('href')];
        if (t === undefined) continue;
        const s = document.createElement('style');
        s.setAttribute('data-head-swap', l.getAttribute('href'));
        s.textContent = t;
        l.parentNode.insertBefore(s, l);
        l.disabled = true;
        n++;
      }
      /* TRANSITIONS ARE PINNED OFF FOR THE WHOLE MEASUREMENT, and without this
         the comparison is very nearly vacuous. Adding the state class starts
         the very transition the rule declares, and a computed colour read while
         a transition is running is the PREVIOUS state's colour - so every
         transitioned property reported its RESTING value in both halves and
         agreed perfectly. Measured: with this missing, the dark default's
         READ ME button reported rgb(59,191,204) on rgb(26,26,26) - its resting
         ink on the page - in both generations, while the hover rule it was
         supposed to be exercising painted an accent tint the probe never saw.
         Same trap recorded at settleTransitions(); here the probe's own class
         flip is what starts the clock. */
      if (!document.getElementById('__st_notrans')) {
        const k = document.createElement('style');
        k.id = '__st_notrans';
        k.textContent = '*, *::before, *::after { transition: none !important;' +
          ' animation: none !important; }';
        document.head.appendChild(k);
      }
      return n;
    })()`;
    /* One element is put into the state at a time. Flipping every hoverable
       element at once would repaint a menu item AND the panel behind it, which
       is a picture the product never draws and would compare two fictions
       rather than two realities. */
    const CASCADE_HELPERS = `
      function parse(c) {
        const m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(c);
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
      }
      function over(fg, bg) {
        return {
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a),
          a: 1,
        };
      }
      function surfaceOf(el) {
        const stack = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) { stack.push(c); if (c.a >= 0.999) break; }
        }
        let out = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
        return out;
      }
      const rnd = (c) => 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) +
        ',' + Math.round(c.b) + ')';
      function pathOf(el) {
        const p = [];
        for (let n = el; n && n !== document.body && n.parentElement; n = n.parentElement) {
          p.push(Array.prototype.indexOf.call(n.parentElement.children, n));
        }
        return p.reverse().join('/');
      }
      const CLASSES = ['__st_hov', '__st_fv', '__st_foc', '__st_act'];
    `;
    /* The bare selectors are gathered from whichever generation is installed;
       the caller takes the UNION of the two, so a rule present in only one of
       them still puts its element into the state in both. Otherwise a deleted
       rule would simply stop being measured - and a deletion that changes the
       picture is precisely what this exists to catch. */
    const COLLECT_STATE_SELECTORS = `(() => {
      ${CASCADE_HELPERS}
      const found = {};
      const walk = (rules) => {
        for (const rule of rules) {
          if (rule.style && rule.selectorText) {
            for (const cls of CLASSES) {
              if (rule.selectorText.indexOf('.' + cls) === -1) continue;
              if (rule.selectorText.indexOf('::') !== -1) continue;
              /* EACH COMMA PART IS FILTERED AND SPLIT IN TWO, and both halves
                 of that are fixes rather than tidying.

                 FILTERED: the old form mapped EVERY part of the list as soon as
                 ONE part carried the state class, so \`.a:hover, .b\` planted
                 the state on \`.b\` as well - an element with no state rule at
                 all. Those entries inflated the planned count without adding a
                 single measurable difference.

                 SPLIT: the old form stripped the class from the WHOLE selector
                 and then added it back to whatever that selector matched. For
                 a rule whose state sits on an ANCESTOR - and this product has
                 seven, e.g. \`.mermaid-container:hover .mermaid-maximize-btn\` -
                 that put the class on the DESCENDANT, so the rule never
                 matched and the state was never actually exercised while the
                 aggregate counts happily went on rising. The flip target is
                 now the compound that carries the class (up to the first
                 combinator) and the measure target is the full bare selector,
                 scoped to that host at query time. */
              const tok = '.' + cls;
              const bare = rule.selectorText.split(',')
                .map((s) => s.trim())
                .filter((s) => s.indexOf(tok) !== -1)
                .map((s) => {
                  const at = s.indexOf(tok);
                  const head = s.slice(0, at);
                  const tail = s.slice(at + tok.length);
                  const m = tail.match(/[\\s>+~]/);
                  const flip = (head + (m ? tail.slice(0, m.index) : tail)).trim();
                  const meas = (head + tail).trim();
                  /* THE THIRD PART IS THE PROOF THAT THE FLIP LANDED. The
                     installed generation sheets have already had \`:hover\` and
                     friends rewritten to \`.__st_hov\`, so this comma part, AS
                     WRITTEN, is the state rule's own selector. Carrying it
                     through lets the measurement assert that the rule really
                     matches once the class is applied, rather than assuming the
                     flip target was chosen correctly. */
                  return flip && meas
                    ? flip + ' ||| ' + meas + ' ||| ' + s.trim() : '';
                })
                .filter(Boolean);
              for (const b of bare) (found[cls] = found[cls] || []).push(b);
            }
          }
          if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        if (rules) walk(rules);
      }
      for (const k of Object.keys(found)) found[k] = [...new Set(found[k])];
      return JSON.stringify(found);
    })()`;
    /* One element is put into the state at a time. Flipping every hoverable
       element at once would repaint a menu item AND the panel behind it, a
       picture the product never draws - that would compare two fictions
       rather than two realities. */
    const measureStates = (plan) => `(() => {
      ${CASCADE_HELPERS}
      const plan = ${JSON.stringify(plan)};
      const out = {};
      const labels = {};
      /* ONE RECORD PER PLANNED SELECTOR, REPLACING TWO FLAT STRING LISTS.
         The lists were \`barren\` and \`unexercised\`, and the pair had three
         defects that a review round found by reading and that the assertions
         below could never have found by running.
         (1) DIFFERENT DOMAINS, IDENTICAL CONSUMER. A selector with no hosts
         hit \`continue\`, so it could never be a candidate for \`unexercised\`
         in that mode - while the consumer required a selector to be
         unexercised in BOTH modes. Every \`body.dark-mode ...\` state rule is
         barren by construction in light, so it could be dead in dark and still
         produce an empty intersection. The one assertion R372 is pointed at
         was structurally incapable of firing for exactly the rule family whose
         asymmetry its own comment spends a paragraph explaining.
         (2) DIFFERENT KEYS. \`barren\` was keyed by the flip selector and
         \`unexercised\` by the sentinel, so the two lists could not even be
         cross-referenced after the fact to recover the answer.
         (3) NO ERROR CHANNEL. Both \`catch\` arms fed the healthy path.
         A record carries the three facts separately - did it have hosts, did
         the rule match, did the query throw - so the consumer can apply the
         right domain to each instead of intersecting two different ones. */
      const sels = {};
      let elements = 0;
      const nameOf = (n) => n.tagName.toLowerCase() +
        (n.className && typeof n.className === 'string' && n.className.trim()
          ? '.' + n.className.trim().split(/\\s+/).join('.') : '') +
        (n.id ? '#' + n.id : '');
      for (const cls of Object.keys(plan)) {
        for (const entry of plan[cls]) {
          const bits = entry.split(' ||| ');
          const flipSel = bits[0];
          const measSel = bits.length > 1 ? bits[1] : bits[0];
          const sentSel = bits.length > 2 ? bits[2] : '';
          let hosts = [];
          const key = cls + ' ' + entry;
          const rec = sels[key] || (sels[key] = {
            cls: cls, flip: flipSel, sent: sentSel,
            hosts: 0, matched: false, cells: 0, err: '',
          });
          /* FAILS CLOSED. This used to be \`catch (e) { continue; }\`, which
             dropped the selector out of BOTH lists - so a flip target that
             stopped parsing was reported as neither barren nor unexercised
             but simply ceased to exist, and every total in the section went
             on looking healthy. The error is now a recorded fact with its own
             assertion. */
          try { hosts = Array.prototype.slice.call(document.querySelectorAll(flipSel)); }
          catch (e) { rec.err = 'flip: ' + (e && e.message ? e.message : 'threw'); continue; }
          rec.hosts = hosts.length;
          if (!hosts.length) continue;
          /* NO CAP. This was \`hosts.slice(0, 8)\` with nothing recording that a
             ninth match existed, so a regression on the ninth menu item was
             invisible and no count ever said so - \`.context-menu-item\` alone
             matches 30. The cap's recorded justification (putting every match
             into the state at once repaints pictures the product never draws)
             was never true of this loop: it flips ONE host, measures it, and
             removes the class again before touching the next. So the cap was a
             pure cost bound, and the cost was MEASURED rather than assumed -
             uncapped the sweep compared 602 cells instead of 376 with no
             increase in suite runtime, and 632 once the scaffold below reached
             the surfaces this document never builds. Coverage is bounded by
             the floors on \`compared\`, which are tied to that measurement. */
          for (const host of hosts) {
            host.classList.add(cls);
            /* MEASURED THROUGH THE SENTINEL, NOT THROUGH A CONTAINMENT FILTER.
               This was \`querySelectorAll(measSel)\` - the BARE selector, matched
               document-wide - narrowed with
               \`.filter((s) => s === host || host.contains(s))\`.
               Two things were wrong with that, and the first is a live hole:

               A SIBLING RULE CONTRIBUTED NOTHING AND EVERY GUARD STAYED GREEN.
               The splitter above deliberately handles \`+\` and \`~\`
               (\`tail.match(/[\\s>+~]/)\`), so \`.a:hover + .b\` yields
               flip \`.a\`, meas \`.a + .b\`. The element \`.a + .b\` finds is a
               SIBLING of the host, so \`host.contains(s)\` is false and it was
               filtered away: zero cells, no \`elements++\`, while \`barren\`
               saw hosts, the match check saw the sentinel match, and the cell
               floor could not notice because the loss was already baked into
               the number the floor was tied to.

               AND A SELF RULE OVER-COUNTED. For \`.a:hover\`, meas is \`.a\`,
               and the filter admitted any NESTED \`.a\` inside the host - an
               element the state was never applied to, measured as though it
               had been.

               The sentinel is the state rule's own selector with the flip
               class already in it, and exactly ONE host carries that class at
               a time. So it selects precisely the elements this rule paints
               for THIS host: siblings included, nested look-alikes excluded,
               no filter required. It is not a wider net - it is the exact one.
               The bare-selector path is kept only for a plan entry with no
               third part, which the collector does not currently emit. */
            let subs = [];
            try {
              subs = sentSel
                ? Array.prototype.slice.call(document.querySelectorAll(sentSel))
                : Array.prototype.slice.call(document.querySelectorAll(measSel))
                    .filter((s) => s === host || host.contains(s));
            } catch (e) {
              if (!rec.err) rec.err = 'meas: ' + (e && e.message ? e.message : 'threw');
              subs = [];
            }
            /* DID THE STATE RULE ACTUALLY MATCH? Everything else in this sweep
               is blind to the answer: the cells are read off whatever the
               measure selector finds, so a flip that lands on the wrong element
               yields exactly the same cell set, with the state simply never
               applied. That is not hypothetical - it is what the flip did for
               seven ancestor-state rules, silently, while the totals rose.
               ONCE ACROSS HOSTS, NOT PER HOST, and that is a correction rather
               than a softening: a descendant rule cannot match for a host that
               has no such descendant, and the product has plenty - not every
               context menu item carries an icon. Requiring it per host reported
               a rule as dead when it was merely inapplicable to one of thirty.
               It is now READ OFF THE SAME QUERY THAT PRODUCES THE CELLS rather
               than off a second, independent \`querySelector(sentSel)\` call.
               That retires the last fail-open arm in this loop - the old one
               was \`catch (e) { everMatched = true; }\`, which recorded an
               unparseable sentinel as exercised - and it removes the state
               where a selector could report "matched" while contributing zero
               cells, because now one query decides both. */
            if (subs.length) rec.matched = true;
            for (const el of subs) {
            elements++;
            const nodes = [el].concat(
              Array.prototype.slice.call(el.querySelectorAll('*')));
            for (const n of nodes) {
              const tag = n.tagName.toLowerCase();
              const paintsText = Array.prototype.slice.call(n.childNodes).some(
                (x) => x.nodeType === 3 && x.textContent.trim());
              const ncs = getComputedStyle(n);
              let kind = null, inkSrc = null;
              if (paintsText) { kind = 'text'; inkSrc = ncs.color; }
              else if (tag === 'svg') {
                const useStroke = ncs.stroke && ncs.stroke !== 'none';
                const useFill = ncs.fill && ncs.fill !== 'none';
                if (useStroke || useFill) {
                  kind = 'icon'; inkSrc = useStroke ? ncs.stroke : ncs.fill;
                }
              }
              if (!kind) continue;
              const fg = parse(inkSrc);
              if (!fg) continue;
              out[cls + '@' + pathOf(el) + '>' + pathOf(n) + ':' + kind] =
                rnd(fg) + ' on ' + rnd(surfaceOf(n));
              rec.cells++;
              labels[cls + '@' + pathOf(el) + '>' + pathOf(n) + ':' + kind] =
                cls.replace('__st_', ':') + ' ' + nameOf(el) +
                (n === el ? '' : ' > ' + nameOf(n)) +
                (n.textContent ? ' "' + n.textContent.trim().slice(0, 24) + '"' : '');
            }
            }
            host.classList.remove(cls);
          }
        }
      }
      return JSON.stringify({
        cells: out, labels: labels, elements: elements, sels: sels,
      });
    })()`;
    const removeHead = `(() => {
      for (const s of Array.prototype.slice.call(
        document.querySelectorAll('style[data-head-swap]'))) s.remove();
      const k = document.getElementById('__st_notrans');
      if (k) k.remove();
      for (const l of Array.prototype.slice.call(
        document.querySelectorAll('link[rel="stylesheet"]'))) l.disabled = false;
      return document.querySelectorAll('style[data-head-swap]').length +
        (document.getElementById('__st_notrans') ? 1 : 0);
    })()`;

    const gen = {};
    let installedCount = 0;
    /* THIRTEEN OF THE SIXTY-TWO PLANNED STATE SELECTORS MATCHED NOTHING, and
       nothing said so until `barren` was surfaced. They are surfaces this
       suite's document never builds - no tab bar, no note, no mermaid diagram,
       no copied/disabled variant - so a hover-colour regression on any of them
       was invisible to the frozen-default sweep. They are scaffolded rather
       than driven: this sweep swaps STYLESHEETS and compares the two results,
       so its subject only has to be an element carrying the right classes in
       the right ancestry. Both halves of the swap see the identical scaffold
       (the DOM is JS-built and is NOT swapped), so a scaffold whose markup is
       wrong yields the same cells twice and reports no drift - it can under-
       report, never false-report. Same precedent as section 9, which injects
       elements carrying Prism classes no bundled grammar emits.
       The ancestry is not guessed: `.mermaid-maximize-btn` and `.img-zoom-btn`
       are nested because their rules put the state on the CONTAINER, and every
       other flip target is a bare compound. Each carries text or an icon,
       because the probe records only nodes that paint ink.
       THE ATTACHMENT CHECK IS A MANIFEST, NOT A COUNT. It was `scaffolded >=
       17` against a real 20 - a magic floor of exactly the shape this section
       removes elsewhere, with three of twenty in slack, so the note-tooltip
       pair and the note label could all have been deleted while the assertion
       named for attaching them went on passing. A bare count is also blind to
       the thing that actually matters here: a review round pointed out that a
       scaffold can keep its element count while losing the ANCESTRY a rule
       depends on, in which case the sweep proves the scaffold rather than the
       product. Each required node is now asserted through the descendant path
       its state rule needs, and the total is pinned exactly. */
    const SCAFFOLD_MANIFEST = [
      ".tab-bar > .tab > .tab-title",
      ".tab-bar > .tab > .tab-close",
      ".context-menu > .context-menu-item.disabled",
      ".context-menu-item.disabled > svg",
      ".tools-menu-recent-item",
      ".mermaid-container > .mermaid-maximize-btn",
      ".img-zoom-container > .img-zoom-btn",
      ".code-copy-btn.copied",
      ".notes-item",
      ".note-label",
      ".note-tooltip > .note-tooltip-close",
    ];
    const SCAFFOLD_NODES = 20;
    const SCAFFOLD = `(() => {
      const d = document.createElement('div');
      d.id = '__st_scaffold';
      d.innerHTML =
        '<div class="tab-bar"><div class="tab"><span class="tab-title">scaffold.md</span>' +
        '<button class="tab-close">x</button></div></div>' +
        '<div class="context-menu"><div class="context-menu-item disabled">' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" ' +
        'height="16"></rect></svg><span>Disabled item</span></div></div>' +
        '<div class="tools-menu-recent-item">recent.md</div>' +
        '<div class="mermaid-container"><button class="mermaid-maximize-btn">M</button></div>' +
        '<div class="img-zoom-container"><button class="img-zoom-btn">Z</button></div>' +
        '<button class="code-copy-btn copied">Copied</button>' +
        '<div class="notes-item"><span>A scaffolded note</span></div>' +
        '<span class="note-label">label</span>' +
        '<div class="note-tooltip"><button class="note-tooltip-close">x</button></div>';
      document.body.appendChild(d);
      const missing = [];
      for (const sel of ${JSON.stringify(SCAFFOLD_MANIFEST)}) {
        if (d.querySelectorAll(sel).length !== 1) missing.push(sel);
      }
      return JSON.stringify({
        nodes: document.querySelectorAll('#__st_scaffold *').length,
        missing: missing,
      });
    })()`;
    const scaffold = JSON.parse(await exec(SCAFFOLD));
    const scaffolded = scaffold.nodes;
    check(
      "the state-sweep scaffold really attached the surfaces this document never builds",
      scaffolded === SCAFFOLD_NODES && scaffold.missing.length === 0,
      `${scaffolded} scaffold elements attached (expected ${SCAFFOLD_NODES}); ` +
        `missing ancestry: ${scaffold.missing.join(" | ") || "none"}`,
    );
    for (const which of ["tree", "head"]) {
      installedCount = await exec(installGen(genSheets[which]));
      const sels = JSON.parse(await exec(COLLECT_STATE_SELECTORS));
      gen[which] = { sels: sels, byMode: {} };
    }
    // The union, so a rule that exists in only one generation still puts its
    // element into the state in BOTH halves of the comparison.
    const plan = {};
    for (const which of ["tree", "head"]) {
      for (const [cls, list] of Object.entries(gen[which].sels)) {
        plan[cls] = [...new Set((plan[cls] || []).concat(list))];
      }
    }
    for (const which of ["tree", "head"]) {
      await exec(installGen(genSheets[which]));
      for (const mode of ["light", "dark"]) {
        await applySettled(mode, null, `${mode} default (${which} stylesheets)`);
        gen[which].byMode[mode] = JSON.parse(await exec(measureStates(plan)));
      }
    }
    const leftOver = await exec(removeHead);
    const scaffoldLeft = await exec(`(() => {
      const d = document.getElementById('__st_scaffold');
      if (d) d.remove();
      return document.querySelectorAll('#__st_scaffold').length;
    })()`);
    await applySettled("light", null, "restore working-tree stylesheets");

    check(
      "both stylesheet generations really were installed and then removed again",
      installedCount === 2 && leftOver === 0 && scaffoldLeft === 0,
      `installed ${installedCount} sheets, ${leftOver} left behind, ` +
        `${scaffoldLeft} scaffold roots left behind`,
    );
    const planned = Object.values(plan).reduce((n, l) => n + l.length, 0);
    /* THE THREE PREDICATES, EACH READ OVER ITS OWN DOMAIN. Every planned
       selector produces one record per mode; the record separates "did it have
       hosts" from "did the rule match" from "did a query throw", which the two
       flat lists this replaces could not do. Keyed by the plan entry itself so
       the same selector lines up across modes - the old lists used the flip
       selector on one side and the sentinel on the other, so they could not
       even be cross-referenced. */
    const selKeys = [
      ...new Set([
        ...Object.keys(gen.tree.byMode.light.sels),
        ...Object.keys(gen.tree.byMode.dark.sels),
      ]),
    ];
    const barrenKeys = [];
    const unexercisedKeys = [];
    const selectorErrors = [];
    for (const key of selKeys) {
      const recs = ["light", "dark"]
        .map((m) => gen.tree.byMode[m].sels[key])
        .filter(Boolean);
      const display = (recs[0].cls + " " + (recs[0].sent || recs[0].flip)).trim();
      for (const r of recs) if (r.err) selectorErrors.push(`${display}: ${r.err}`);
      // Barren only when NO mode could reach it - a rule scoped to one mode is
      // legitimately unreachable in the other.
      if (recs.every((r) => r.hosts === 0)) barrenKeys.push(display);
      const withHosts = recs.filter((r) => r.hosts > 0);
      if (withHosts.length && withHosts.every((r) => !r.matched)) {
        unexercisedKeys.push(display);
      }
    }
    const drift = [];
    let compared = 0;
    for (const mode of ["light", "dark"]) {
      const now = gen.tree.byMode[mode].cells;
      const was = gen.head.byMode[mode].cells;
      const lab = (k) =>
        gen.head.byMode[mode].labels[k] || gen.tree.byMode[mode].labels[k] || k;
      for (const [k, v] of Object.entries(was)) {
        if (!(k in now)) { drift.push(`${mode} ${lab(k)}: gone`); continue; }
        compared++;
        if (now[k] !== v) drift.push(`${mode} ${lab(k)}: ${v} -> ${now[k]}`);
      }
      for (const k of Object.keys(now)) {
        if (!(k in was)) drift.push(`${mode} ${lab(k)}: new`);
      }
    }
    console.log(
      `  note  cascade comparison: ${planned} state selectors, ` +
        `${gen.tree.byMode.light.elements} light / ` +
        `${gen.tree.byMode.dark.elements} dark elements put into state, ` +
        `${compared} cells compared; barren [${barrenKeys.join(", ") || "none"}]`,
    );
    /* A PLANNED SELECTOR THAT MATCHES NOTHING CONTRIBUTES NO CELLS AT ALL, and
       the aggregate counts go on rising regardless - which is exactly how the
       seven ancestor-state rules stayed unexercised while this sweep reported
       healthy totals. Thirteen selectors were barren before the scaffold above
       was added; the assertion is what keeps that from silently returning.
       IT IS EVALUATED ACROSS BOTH MODES, and that is not a detail: the flip
       target of `body.dark-mode .tab-close:hover` is `body.dark-mode
       .tab-close`, which CANNOT match in light mode by construction. A
       single-mode reading would have reported it permanently barren and either
       failed forever or been "fixed" by an excusal for a non-defect. Only a
       selector unreachable in BOTH modes is genuinely out of the sweep. */
    check(
      "every planned state selector reaches an element in at least one mode",
      barrenKeys.length === 0,
      `barren in both modes: ${barrenKeys.join(", ")}`,
    );
    /* THE FLIP MUST LAND ON THE ELEMENT THE RULE IS ABOUT, and this is the only
       assertion in the section that can tell. Everything else reads cells off
       the measured elements, which a mis-aimed flip does not change - so the
       ancestor-state defect produced an identical cell count with the state
       never applied, and was invisible to drift, to the floors, to `barren`
       and to the element counts alike. Measured, not assumed: putting the old
       whole-selector flip back moves not one number in this section.

       THE DOMAIN IS "MODES WHERE THE SELECTOR HAD HOSTS", NOT "BOTH MODES",
       and that correction is the whole point of the rewrite above. The old
       form intersected `unexercised` across both modes exactly as `barren` is
       intersected - but the two predicates do not share a domain. A selector
       with no hosts never reached the match check at all, so it was absent
       from that mode's `unexercised` list; requiring membership in BOTH lists
       therefore made the assertion unable to fire for every rule that is
       barren-by-construction in one mode. That is precisely the
       `body.dark-mode ...:hover` family - including the file's own worked
       example - so the guard was structurally blind to the rules its own
       comment was written about. Reading only the modes that had hosts keeps
       the asymmetry handled (a light-barren rule is judged on dark alone)
       without letting it excuse a dead rule. */
    check(
      "every state rule really matched once its element was put into the state",
      unexercisedKeys.length === 0,
      `had hosts but never matched: ${unexercisedKeys.slice(0, 8).join(", ")}` +
        (unexercisedKeys.length > 8 ? ` (+${unexercisedKeys.length - 8} more)` : ""),
    );
    /* NEITHER OF THE TWO ABOVE CAN SEE A SELECTOR THAT STOPPED PARSING, and
       before this both `catch` arms fed the healthy path: a throwing flip
       query `continue`d out of both lists, and a throwing sentinel query was
       recorded as a successful match. So a selector the browser rejected was
       reported as neither barren nor unexercised - it simply stopped existing,
       silently, while every total in the section went on looking right. That
       is this project's "an absence check that fails open" disease, twice in
       one loop. The errors now have their own subject and their own name. */
    check(
      "no planned state selector was dropped because a query threw",
      selectorErrors.length === 0,
      `${selectorErrors.length} selector(s) threw: ${selectorErrors.slice(0, 5).join(" | ")}`,
    );
    /* THE ONE THING THE SWAP CANNOT HOLD STILL. Only the CSS is exchanged; the
       DOM is built by JavaScript, which the swap leaves at the working tree's
       version. So chrome this change ADDS is present in both halves, and in
       the HEAD half it renders with whatever it inherits rather than with the
       rule that was written for it - a difference with no pixel behind it,
       because at HEAD the element did not exist at all. A surface that is new
       has no frozen baseline to be measured against. The exemption is named
       and its continued necessity is asserted, so it cannot quietly widen into
       a licence for the chrome around it. */
    const DEFAULT_DRIFT_EXCUSALS = {
      /* EMPTY, AND THAT IS A RESULT RATHER THAN AN OMISSION. This carried one
         entry - the "Light schemes" / "Dark schemes" group headings - for as
         long as that chrome was uncommitted. Once it landed at HEAD both halves
         of the swap render it from the same rule, the drift disappeared, and
         the stale-excusal guard below FAILED and named it. Removed on that
         measurement. An excusal here is a statement about what HEAD lacks, so
         it expires the moment the change is committed; the guard is what stops
         one outliving its reason and quietly pardoning a real regression. */
    };
    const driftExcusalUsed = new Set();
    const realDrift = drift.filter((d) => {
      for (const k of Object.keys(DEFAULT_DRIFT_EXCUSALS)) {
        if (d.includes(k)) { driftExcusalUsed.add(k); return false; }
      }
      return true;
    });
    /* FLOORS TIED TO A MEASUREMENT, NOT TO ROUND NUMBERS. These stood at
       `planned >= 30 && compared >= 200` against a measured 62 and 376 - so the
       sweep could have lost half its selectors and 47% of its cells and still
       reported itself pinned, which is the same magic-number disease as the
       licence guard's `> 200` against a real 220. Retied to what the sweep
       actually measures, printed on every run in the note above. A legitimate
       CSS change that removes a state rule will lower `planned` and fail here:
       that is the intended cost, because the alternative is a floor nobody
       re-reads. Raise them only after reading the printed counts.

       SPLIT OUT OF THE DRIFT CLAIM, and the split is a fix rather than tidying.
       The floors used to be `&&`-ed into the assertion named "neither frozen
       default has changed a single state colour since HEAD" - so R373
       (reinstate the 8-match cap) and R374 (remove the scaffold), neither of
       which changes a single colour, both failed under a name announcing a
       colour regression in the frozen defaults. This project treats a failure
       naming the wrong thing as the most expensive kind and rewrote R366's
       expect for exactly that reason; the same standard applies here. The two
       claims are now separate subjects with separate names, and the reverts
       point at the one they actually break. */
    check(
      "the state-cascade sweep still covers as much as it was measured to cover",
      planned >= 62 && compared >= 632,
      `${planned} state selectors planned (floor 62), ` +
        `${compared} cells compared against HEAD (floor 632)`,
    );
    check(
      "neither frozen default has changed a single state colour since HEAD",
      realDrift.length === 0,
      `${planned} state selectors planned, ${compared} cells compared against HEAD; ` +
        realDrift.slice(0, 12).join(" | ") +
        (realDrift.length > 12 ? ` (+${realDrift.length - 12} more)` : ""),
    );
    const staleDriftExcusals = Object.keys(DEFAULT_DRIFT_EXCUSALS).filter(
      (k) => !driftExcusalUsed.has(k),
    );
    check(
      "every default-drift excusal still names chrome that HEAD really lacks",
      staleDriftExcusals.length === 0,
      `no longer drifting, so the entries must go: ${staleDriftExcusals.join(", ")}`,
    );
    /* THE GUARD ABOVE IS INERT WHILE THE TABLE IS EMPTY - `[].every(...)` is
       true, so it has nothing to say and cannot fail. That is correct for what
       it checks, but it means the table's SIZE is unpinned, and an excusal
       added by hand would arrive silently and pardon a real regression from its
       first run. Asserted separately rather than folded in, because the two
       fail for different reasons and each should name its own: this one says an
       excusal was ADDED, the one above says an existing excusal EXPIRED. The
       measured count is 0 - see the table's own comment for why it emptied. */
    check(
      "the default-drift excusal table is still empty",
      Object.keys(DEFAULT_DRIFT_EXCUSALS).length === 0,
      `excusals present: ${Object.keys(DEFAULT_DRIFT_EXCUSALS).join(", ")}`,
    );

    for (const [mode, scheme] of SCHEME_STATES) {
      await applySettled(mode, scheme, scheme + " (hover)");
      const got = JSON.parse(await exec(HOVER_PROBE));
      noteState(got);
      const base = new Map(hoverPaths(hoverBase[mode]).map((c) => [c.path, c]));
      const cells = hoverPaths(got);

      const undimmed = cells.filter((c) => c.o >= 0.999);
      const shortfall = undimmed.filter((c) => c.rEff < HOVER_MIN[c.kind] - 0.005);
      check(
        `${scheme}: every hover cell it paints at full opacity meets its WCAG minimum`,
        undimmed.length >= 12 && shortfall.length === 0,
        `${undimmed.length} full-opacity cells; ` +
          shortfall
            .map((c) => `${c.path} ${c.rEff.toFixed(2)} < ${HOVER_MIN[c.kind]} (${c.fg} on ${c.bg})`)
            .join(" | "),
      );

      /* The two relative bars partition the cells by what the DEFAULT already
         achieved, so every cell is covered by exactly one of them and neither
         can be satisfied by the other's population. They exist because the
         absolute bar above is blind on both flanks: it cannot see a cell
         falling 8.0 -> 4.6, and it says nothing at all about the dimmed cells
         a scheme cannot reach without tokenising their opacity. */
      const kept = [], worsened = [];
      const paired = cells.filter((c) => base.has(c.path));
      for (const c of cells) {
        const b = base.get(c.path);
        if (!b) continue;
        const min = HOVER_MIN[c.kind];
        if (b.rEff >= min) { if (c.rEff < min - 0.005) kept.push([c, b]); }
        else if (c.rEff < b.rEff - 0.01) worsened.push([c, b]);
      }
      check(
        `${scheme}: every hover cell that met its minimum in the default still meets it`,
        paired.length >= 25 &&
          kept.length === 0,
        `${paired.length} of ${cells.length} scheme cells paired against ${base.size} default cells; ` +
          kept.map(([c, b]) => `${c.path} ${b.rEff.toFixed(2)} -> ${c.rEff.toFixed(2)}`).join(" | "),
      );
      check(
        `${scheme}: no hover cell that was already below its minimum in the default is made worse`,
        paired.length >= 25 && worsened.length === 0,
        worsened.map(([c, b]) => `${c.path} ${b.rEff.toFixed(2)} -> ${c.rEff.toFixed(2)}`).join(" | "),
      );
    }

    check(
      "hover replay: every rule that declares a background really carried one into the measurement",
      bgDeclared >= 100 && bgDropped.length === 0 && bgLanded === bgDeclared,
      `${bgLanded}/${bgDeclared} landed; dropped: ${bgDropped.join(" | ")}`,
    );
    check(
      "every hover rule that repaints a neutral element with a saturated fill sets its own ink",
      accentNoInk.size === 0,
      [...accentNoInk].join(" | "),
    );
    /* THE POSITIVE CONTROL FOR THE CLASSIFIER ABOVE. Splitting "neutral" from
       "saturated" at a chroma of 40 is only meaningful while nothing the
       product paints sits near 40, and that is a property of the palette, not
       a law - a future scheme with a muted accent would put the split inside
       its own data and the gate would start guessing. Measured across all six
       states the two clusters are 0-33 and 90-209, so the threshold has ~56
       units of clearance on each side. Asserting the GAP rather than the
       threshold means such a scheme fails loudly here, pointing at the
       classifier, instead of silently mis-sorting one rule somewhere else. */
    const ambiguous = chromaSeen.filter(
      (b) => (b.rest >= 34 && b.rest <= 89) || (b.state >= 34 && b.state <= 89),
    );
    check(
      "neutral and saturated fills stay far enough apart for the classifier to tell them apart",
      chromaSeen.length >= 100 && ambiguous.length === 0,
      `${chromaSeen.length} fills measured; ambiguous: ` +
        ambiguous.map((b) => `${b.sel} rest=${b.rest} state=${b.state}`).join(" | "),
    );
    await applySettled("light", null, "restore after hover probe");

    /* ── 10l: SELECTED CODE - the surface the product paints, not the one the
       stylesheet appears to describe ────────────────────────────────────────
       --code-selection-bg was the last colour in this item chosen rather than
       measured, and it is the only themed surface that is TRANSLUCENT on
       purpose, which is why no other section reaches it:
         - 10d skips fully transparent surfaces and reads RESTING backgrounds,
           and a ::selection background is neither;
         - 10g replays a rule's declarations onto a real element, and a
           pseudo-element cannot be selected, so it is skipped by construction;
         - the golden records painted colours, and nothing is selected while it
           is captured.

       THE FIRST VERSION OF THIS SECTION SCORED THE WRONG INK, and it is worth
       recording exactly how, because the mistake was invisible from the CSS.
       It composited the selection tint over the code background and scored the
       TOKEN colours against the result - which is what the stylesheet looks
       like it does, since the code ::selection rule overrides `background`.
       But the app-wide `::selection` rule further down also declares `color`,
       and nothing was overriding THAT, so selecting code replaced the entire
       syntax palette with one flat ink. Captured pixels settled it: an
       unselected block paints 1264 distinct colours and a selected one paints
       128. The section reported 3.5-4.4:1 for the four schemes while the
       reader was actually looking at 1.36, 1.55, 2.18 and 2.15. (Those last
       two were first written down as 1.48 and 1.59, which were honest readings
       taken before abyss's and ember's highlight alphas were raised to their
       shipped 35% and 32%. The two light schemes' pastels are opaque, so their
       figures could not go stale the same way - which is exactly how the
       staleness was spotted.)

       SO THE REGIME IS MEASURED FIRST, AND ASSERTED. Two are possible:
         FLAT    - a ::selection colour is declared, every token is painted in
                   it, and the thing to score is that ONE ink. It is body text
                   on a background, so the bar is 4.5:1.
         THROUGH - no ::selection colour is declared, the token colours survive
                   (Chromium does this for `color: currentColor`, measured),
                   and the thing to score is EVERY token. A syntax palette
                   cannot realistically hold 4.5:1 against a tinted background,
                   so the bar is 3:1, WCAG 1.4.11.
       Which regime the product is in is detected by reading the ::selection
       colour of tokens that have DIFFERENT resting colours: one distinct value
       across many distinct inks is flat by definition. It is asserted as well
       as detected, so flipping the regime is a decision someone has to make
       out loud rather than a side effect.

       THE VISIBILITY FLOOR IS THE OTHER HALF, and without it the section is
       trivially satisfiable: a nearly transparent selection scores perfectly
       on legibility while ceasing to be a selection at all. Both are asserted,
       and the floors are RECORDED MEASUREMENTS per state rather than one
       chosen number, because the light schemes highlight with opaque pastels
       (~1.27) and the dark ones with translucent accent tints (~1.95); a
       single shared bar would have to sit under the lower pair and would then
       be unable to see a regression in the higher four. The shared 1.2 is kept
       underneath as an absolute backstop for a scheme added later.

       THE SUBJECT IS EVERY RENDERED CODE BLOCK, not the first one. The fixture
       renders 13, and an earlier draft read only `querySelector` - the
       JavaScript block - so the worst ink in the HTML block was outside the
       claim while the assertion said "every token". */
    const SELECTION_FLAT_MIN = 4.5;
    const SELECTION_TOKEN_MIN = 3.0;
    /* Recorded from a run, then pinned. The light default's 12.05 is Solarized
       Light's own opaque navy and is by far the most visible highlight in the
       product; the light schemes' ~1.27 is a deliberate pastel. */
    const SELECTION_VISIBLE_FLOOR = {
      "light default": 12.0,
      "dark default": 1.9,
      clarity: 1.27,
      parchment: 1.26,
      abyss: 1.9,
      ember: 1.9,
    };
    /* The lower bar applied to a dimmed cell's EFFECTIVE ratio - see the
       assertion that consumes it for why a dimmed cell needs two bars. */
    const SELECTION_DIMMED_EFFECTIVE_MIN = 3.0;
    const selectionByState = {};
    for (const [mode, scheme] of [["light", null], ["dark", null], ...SCHEME_STATES]) {
      const label = scheme || mode + " default";
      await applySettled(mode, scheme, label + " (selection)");
      selectionByState[label] = JSON.parse(
        await exec(`(() => {
          const parse = (v) => {
            const m = String(v).match(/rgba?\\(([^)]+)\\)/);
            if (!m) return null;
            const p = m[1].split(',').map((s) => parseFloat(s.trim()));
            return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
          };
          const lum = (c) => {
            const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
            return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
          };
          const ratio = (a, b) => {
            const l1 = lum(a), l2 = lum(b);
            return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          };
          const over = (fg, bg) => ({
            r: fg.r * fg.a + bg.r * (1 - fg.a),
            g: fg.g * fg.a + bg.g * (1 - fg.a),
            b: fg.b * fg.a + bg.b * (1 - fg.a),
            a: 1,
          });
          /* THE BACKDROP IS RESOLVED PER NODE, not once for the block. A token
             can carry its own background - .token.entity does, and it is the
             cell 10a distinguishes from operator BY that background - so the
             selection over an entity composites onto a different colour than
             the selection over the code panel. Translucent layers in between
             are composited too rather than skipped.

             THE ALPHA THRESHOLDS MATCH THE OTHER FOUR BACKDROP WALKERS IN THIS
             FILE (10d, 10g, 10h, 10i) EXACTLY, and they did not always: this
             one was written with "> 0.001" / "> 0.999" while the rest use
             "> 0" / ">= 0.999". A layer at exactly a=0.999 was therefore
             OPAQUE to the other four and TRANSLUCENT here, so two sections
             could score the same stack against different backdrops and neither
             would look wrong on its own. Nothing in the product sits at that
             alpha today, which is precisely why it had to be fixed by reading
             rather than waiting for a failure.
             (NOTE THE QUOTES: this comment lives inside an exec() template
             literal, so a backtick here becomes a tagged template call. That
             has now cost seven diagnoses in this project.) */
          const backdropOf = (node) => {
            const stack = [];
            let n = node;
            while (n) {
              const c = parse(getComputedStyle(n).backgroundColor);
              if (c && c.a > 0) {
                stack.push(c);
                if (c.a >= 0.999) break;
              }
              n = n.parentElement;
            }
            let base = { r: 255, g: 255, b: 255, a: 1 };
            for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
            return base;
          };
          /* Opacity is CUMULATIVE and it thins the ink. An earlier draft
             skipped any token with opacity < 1, which silently dropped
             --tok-namespace - a cell that exists precisely because Solarized
             leaked an opacity of .7 into it. */
          const opacityOf = (node, stop) => {
            let o = 1, n = node;
            while (n) {
              const v = parseFloat(getComputedStyle(n).opacity);
              if (!isNaN(v)) o *= v;
              if (n === stop) break;
              n = n.parentElement;
            }
            return o;
          };
          const pres = [...document.querySelectorAll('.markdown-body pre[class*="language-"]')];
          if (!pres.length) return JSON.stringify({ error: 'no highlighted code block rendered' });
          /* THE FILL IS READ FROM THE CASCADE, NOT FROM THE VARIABLE.
             This used to paint a probe span with the DECLARED value of
             --code-selection-bg and measure that:

               probe.style.background = getComputedStyle(pres[0])
                 .getPropertyValue('--code-selection-bg').trim();

             which answers "what does the variable say" rather than "what does
             a selection paint". Every number this section reports - the
             composite, each legibility ratio, the visibility floor - is scored
             against that fill, so if the code ::selection rule ever stopped
             WINNING (a scheme-scoped rule at higher specificity, a rule that
             consumes a different variable, or the whole rule being dropped at
             parse time) the section would go on reporting a colour that no
             longer paints anything. That is the disjunction disease in its
             purest form, inside the section written to close it - and it is
             observable: under R357 the rule is annihilated and the real
             highlight becomes var(--primary-color), yet the old code still
             composited --code-selection-bg.

             getComputedStyle(el, '::selection') is a real end-to-end oracle in
             this Chromium - theme-census.js relies on it for the golden - and
             measured across all six states it returns EXACTLY the declared
             value today, so this change moves no number on a clean tree. It
             only removes the way the numbers could go phantom. */
          const paintedFill = getComputedStyle(pres[0], '::selection').backgroundColor;
          const selRaw = parse(paintedFill);
          if (!selRaw) return JSON.stringify({ error: 'unparseable selection colour' });
          /* The declared value is still read, but only to report whether the
             two agree. Keeping it as a SEPARATE observation is the point: it
             says "the rule routes through the variable" without being allowed
             to answer "this is what paints". */
          const probe = document.createElement('span');
          pres[0].appendChild(probe);
          probe.style.background = getComputedStyle(pres[0]).getPropertyValue('--code-selection-bg').trim();
          const declaredFill = getComputedStyle(probe).backgroundColor;
          probe.remove();
          /* THE INK NEEDS THE SAME PAIR, and it did not have one. The fill was
             the only channel with a painted-vs-declared comparison, which made
             it the only assertion able to notice the code selection rule being
             lost entirely in the four SCHEMES - the golden covers the two
             frozen defaults alone, and every contrast assertion here scores the
             DECLARED variables, so it stays green while the screen is wrong.
             Measured: that is exactly what R357 does.
             READ ACROSS EVERY BLOCK, not just the first. A rule targeting one
             language - code[class*="language-js"]::selection - would retint a
             single block and a first-block sample would never see it. */
          const inkProbe = document.createElement('span');
          pres[0].appendChild(inkProbe);
          inkProbe.style.color = getComputedStyle(pres[0]).getPropertyValue('--code-selection-fg').trim();
          const declaredInk = getComputedStyle(inkProbe).color;
          inkProbe.remove();
          const paintedFills = [...new Set(pres.map((p) => getComputedStyle(p, '::selection').backgroundColor))];
          const paintedInks = [...new Set(pres.map((p) => getComputedStyle(p, '::selection').color))];

          const cells = [];
          const seen = new Set();
          const restInks = new Set();
          const selInks = new Set();
          let tokenCount = 0;
          for (const pre of pres) {
            const subjects = [[':not(.token)', pre]];
            for (const t of pre.querySelectorAll('.token')) subjects.push([t.className.trim().split(/\\s+/).join('.'), t]);
            for (const [name, node] of subjects) {
              tokenCount++;
              const cs = getComputedStyle(node);
              const rest = parse(cs.color);
              if (!rest) continue;
              restInks.add(cs.color);
              const selCol = getComputedStyle(node, '::selection').color;
              if (selCol) selInks.add(selCol);
              const painted = parse(selCol) || rest;
              const o = opacityOf(node, pre.parentElement);
              const bg = over(selRaw, backdropOf(node));
              const ink = o < 0.999 ? over({ r: painted.r, g: painted.g, b: painted.b, a: o }, bg) : painted;
              const key = name + '|' + selCol + '|' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + '|' + o;
              if (seen.has(key)) continue;
              seen.add(key);
              cells.push({
                name: name,
                rest: cs.color,
                painted: selCol,
                opacity: o,
                on: 'rgb(' + Math.round(bg.r) + ', ' + Math.round(bg.g) + ', ' + Math.round(bg.b) + ')',
                ratio: ratio(ink, bg),
                choice: ratio(painted, bg),
              });
            }
          }
          cells.sort((a, b) => a.ratio - b.ratio);
          /* THE INLINE HIGHLIGHTED SURFACE, which every assertion above is
             blind to. The code selection rule is scoped to
             code[class*="language-"] as well as to pre, so it applies to
             INLINE highlighted code too - and inline code sits on
             --code-inline-bg, a different backdrop from --code-bg. The
             selection alphas were derived by measuring against --code-bg
             alone, so nothing had ever checked that the same translucent tint
             stays legible on the inline surface. The fixture renders one
             deliberately.
             NOTE FOR EDITORS: never a backtick in here. */
          const inlines = [...document.querySelectorAll('.markdown-body :not(pre) > code[class*="language-"]')];
          const inlineCells = [];
          const inlineSeen = new Set();
          for (const el of inlines) {
            const subjects = [[':not(.token)', el]];
            for (const t of el.querySelectorAll('.token')) subjects.push([t.className.trim().split(/\\s+/).join('.'), t]);
            for (const [name, node] of subjects) {
              const cs = getComputedStyle(node);
              const rest = parse(cs.color);
              if (!rest) continue;
              const selCol = getComputedStyle(node, '::selection').color;
              const painted = parse(selCol) || rest;
              const o = opacityOf(node, el.parentElement);
              const inlineFill = parse(getComputedStyle(el, '::selection').backgroundColor) || selRaw;
              const bg = over(inlineFill, backdropOf(node));
              const ink = o < 0.999 ? over({ r: painted.r, g: painted.g, b: painted.b, a: o }, bg) : painted;
              const key = name + '|' + selCol + '|' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + '|' + o;
              if (inlineSeen.has(key)) continue;
              inlineSeen.add(key);
              inlineCells.push({
                name: name,
                painted: selCol,
                opacity: o,
                on: 'rgb(' + Math.round(bg.r) + ', ' + Math.round(bg.g) + ', ' + Math.round(bg.b) + ')',
                ratio: ratio(ink, bg),
              });
            }
          }
          inlineCells.sort((a, b) => a.ratio - b.ratio);
          const inlineBehind = inlines.length ? backdropOf(inlines[0].parentElement) : null;
          const inlineOwn = inlines.length ? backdropOf(inlines[0]) : null;
          const inlineFill0 = inlines.length
            ? (parse(getComputedStyle(inlines[0], '::selection').backgroundColor) || selRaw)
            : null;
          const behind = backdropOf(pres[0]);
          const effective = over(selRaw, behind);
          return JSON.stringify({
            declared: getComputedStyle(pres[0]).getPropertyValue('--code-selection-bg').trim(),
            declaredFg: getComputedStyle(pres[0]).getPropertyValue('--code-selection-fg').trim(),
            paintedFill: paintedFill,
            declaredFill: declaredFill,
            declaredInk: declaredInk,
            paintedFills: paintedFills,
            paintedInks: paintedInks,
            alpha: selRaw.a,
            blocks: pres.length,
            langs: pres.map((p) => (String(p.className).match(/language-[\\w+#-]+/) || ['?'])[0]),
            tokenCount: tokenCount,
            restInks: restInks.size,
            selInks: [...selInks],
            effective: 'rgb(' + Math.round(effective.r) + ', ' + Math.round(effective.g) + ', ' + Math.round(effective.b) + ')',
            behind: 'rgb(' + Math.round(behind.r) + ', ' + Math.round(behind.g) + ', ' + Math.round(behind.b) + ')',
            visible: ratio(effective, behind),
            inlineBlocks: inlines.length,
            inlineFill: inlines.length ? getComputedStyle(inlines[0], '::selection').backgroundColor : null,
            inlineInk: inlines.length ? getComputedStyle(inlines[0], '::selection').color : null,
            inlineOn: inlineOwn ? 'rgb(' + Math.round(inlineOwn.r) + ', ' + Math.round(inlineOwn.g) + ', ' + Math.round(inlineOwn.b) + ')' : null,
            inlineEffective: inlineOwn && inlineFill0
              ? (function () { const e = over(inlineFill0, inlineOwn); return 'rgb(' + Math.round(e.r) + ', ' + Math.round(e.g) + ', ' + Math.round(e.b) + ')'; })()
              : null,
            inlineVisible: inlineOwn && inlineFill0 ? ratio(over(inlineFill0, inlineOwn), inlineOwn) : null,
            inlineBehind: inlineBehind ? 'rgb(' + Math.round(inlineBehind.r) + ', ' + Math.round(inlineBehind.g) + ', ' + Math.round(inlineBehind.b) + ')' : null,
            inlineCells: inlineCells,
            cells: cells,
          });
        })()`),
      );
    }
    await applySettled("light", null, "restore after selection probe");

    const selStates = Object.keys(selectionByState);
    const selErrors = selStates.filter((s) => selectionByState[s].error);
    /* THE BLOCK COVERAGE CLAIM IS AN EXACT IDENTITY, NOT A LOWER BOUND.
       This used to read `blocks < 12` while the fixture renders 13, under an
       assertion named "across EVERY rendered block" - so the worst block could
       stop rendering and the claim would still pass, and the comment justifying
       it even said "nearly all of them", which is not what the name promises.
       That is the guessed-floor shape this project keeps deleting.

       The set below is MEASURED, not chosen: twelve language-tagged fences plus
       one untagged fence that Prism classes `language-none`. Pinning the
       identity rather than the count means a fence losing its language (falling
       back to `none`) is caught too, which a count of 13 would wave through. */
    const SELECTION_LANGS = [
      "language-bash",
      "language-c",
      "language-cpp",
      "language-csharp",
      "language-css",
      "language-html",
      "language-java",
      "language-javascript",
      "language-json",
      "language-none",
      "language-python",
      "language-sql",
      "language-typescript",
    ];
    const langsOf = (s) => (selectionByState[s].langs || []).slice().sort().join(",");
    /* VACUITY GUARD. An empty or thin cell list clears every bar below it for
       free, so the subject is pinned before anything is scored.

       THE FLOORS ARE MEASURED, NOT CHOSEN. They used to be a bare `8` on both
       counts, which is the magic-number disease this file has already cured
       twice (the `entries.length > 200` licence guard against a real 220, and
       `SELECTION_VISIBLE_FLOOR["light default"]` sitting at a placeholder 1.0).
       A floor nothing can fail is not an assertion: the real subject is
       13 blocks / 8-9 resting inks / 55 cells in every one of the six states,
       so `>= 8` cells had 47 cells of slack and would have waved through a
       sweep that lost 85% of its coverage. The `note:` line below now prints
       all three counts per state on every run, so the floor can never again
       pass silently at a number nobody has read.

       WHY 55 IS THE SAME IN ALL SIX STATES, and why `>= 55` is therefore safe
       rather than brittle: a cell's key is `classSet|selectedInk|backdrop|
       opacity`, and every state here is FLAT (one selected ink across the whole
       block - see the regime note below), so the selected-ink component is
       constant and the partition is decided by the FIXTURE, not the palette.
       A future scheme that selected THROUGH (preserving token colours) would
       only ever ADD cells, so the floor cannot false-fail on one.

       THE OPACITY PARTITION CLAUSE THAT USED TO LIVE HERE WAS A TAUTOLOGY:
       it added the `>= 0.999` and `< 0.999` buckets and compared the sum to
       cells.length. Those two predicates are exact complements over every real
       number, and `opacityOf` seeds `o = 1` and multiplies only when
       `!isNaN(v)`, so `opacity` can never be NaN - the one value that could
       have made it fire. It asserted a hazard the code had already made
       impossible. What actually needs guarding is that BOTH buckets are
       non-empty where they should be, and the assertions below do that. */
    const thinStates = selStates.filter(
      (s) =>
        !selectionByState[s].error &&
        (langsOf(s) !== SELECTION_LANGS.slice().sort().join(",") ||
          selectionByState[s].blocks < 13 ||
          selectionByState[s].restInks < 8 ||
          selectionByState[s].cells.length < 55),
    );
    check(
      "10l: every theme state measured selected code across every rendered block",
      selStates.length === 6 && selErrors.length === 0 && thinStates.length === 0,
      `${selStates.length} state(s); errors [${selErrors.map((s) => s + ": " + selectionByState[s].error).join(", ")}]; thin [${thinStates
        .map(
          (s) =>
            `${s}: ${selectionByState[s].blocks} blocks [${langsOf(s)}] / ${selectionByState[s].restInks} inks / ${selectionByState[s].cells.length} cells`,
        )
        .join(", ")}]`,
    );
    /* THE FILL EVERY RATIO IS SCORED AGAINST MUST BE THE ONE THAT PAINTS.
       10l reads it from getComputedStyle(el, '::selection') rather than from
       --code-selection-bg (see the probe), and this assertion is what makes
       that meaningful in the other direction: the painted fill must still AGREE
       with the variable, so the rule is demonstrably routing through it and a
       scheme can retint it. Measured across all six states, the two are
       byte-identical; a divergence means some other rule has taken the fill
       over and every number this section reports is describing the wrong
       colour. */
    const fillDrift = selStates.filter(
      (s) =>
        !selectionByState[s].error &&
        selectionByState[s].paintedFill !== selectionByState[s].declaredFill,
    );
    check(
      "10l: the selection fill that paints is the one --code-selection-bg declares",
      selErrors.length === 0 && fillDrift.length === 0,
      fillDrift
        .map(
          (s) =>
            `${s}: paints ${selectionByState[s].paintedFill} but the variable says ${selectionByState[s].declaredFill}`,
        )
        .join(" | "),
    );
    /* AND THE INK, which had no such pair until a revert run proved it needed
       one. R357 deletes the whole code-selection rule; the fill assertion above
       is the ONLY thing in this section that notices for the four schemes,
       because the golden covers the two frozen defaults and every contrast
       assertion scores the DECLARED variables rather than what paints. An ink
       regression on the same path had nothing at all. */
    const inkDrift = selStates.filter(
      (s) =>
        !selectionByState[s].error &&
        selectionByState[s].paintedInks[0] !== selectionByState[s].declaredInk,
    );
    check(
      "10l: the selection ink that paints is the one --code-selection-fg declares",
      selErrors.length === 0 && inkDrift.length === 0,
      inkDrift
        .map(
          (s) =>
            `${s}: paints ${selectionByState[s].paintedInks[0]} but the variable says ${selectionByState[s].declaredInk}`,
        )
        .join(" | "),
    );
    /* BOTH CHANNELS, ACROSS EVERY BLOCK. The two assertions above sample the
       first block, which is enough for a rule that targets the whole surface
       and blind to one that does not: code[class*="language-js"]::selection is
       the same specificity and would retint exactly one of the thirteen. */
    const blockSpread = selStates.filter(
      (s) =>
        !selectionByState[s].error &&
        (selectionByState[s].paintedFills.length !== 1 || selectionByState[s].paintedInks.length !== 1),
    );
    check(
      "10l: every rendered block paints the same selection fill and ink, not just the first",
      selErrors.length === 0 && blockSpread.length === 0 && selStates.length === 6,
      blockSpread
        .map(
          (s) =>
            `${s}: fills [${selectionByState[s].paintedFills.join(", ")}] inks [${selectionByState[s].paintedInks.join(", ")}]`,
        )
        .join(" | "),
    );
    /* THE RECORDED FLOORS MUST DESCRIBE THE STATES THAT EXIST, and this guard
       is now the ONLY thing standing between a new scheme and an unfloored
       visibility bar.
       It used to share that job with a `Math.max(SELECTION_VISIBLE_MIN, MAP[label] || 0)`
       backstop at the consumer, which was dead code pretending to be a safety
       net: every recorded floor is >= 1.26, the backstop was 1.2, so the
       Math.max always returned the floor and the `|| 0` branch was
       unreachable - precisely BECAUSE this assertion forbids a state without
       an entry. A backstop that can only be reached by first failing another
       assertion protects nothing, and it made the real floors look optional.
       The consumer now reads the floor directly, so a state that ever did slip
       through would compare against `undefined` and fail loudly rather than
       quietly clearing a bar every scheme passes by construction.
       Every other recorded map in this file (wantDimmed, SCHEME_EXCUSALS,
       NEEDLE_EXCUSALS, DEFAULT_DRIFT_EXCUSALS) carries this guard; this one
       was the exception. */
    const floorKeys = Object.keys(SELECTION_VISIBLE_FLOOR).sort().join(",");
    check(
      "10l: every measured state has a recorded visibility floor, and no floor is left over",
      floorKeys === selStates.slice().sort().join(","),
      `floors [${floorKeys}] vs states [${selStates.slice().sort().join(",")}]`,
    );
    /* THE DIMMED BRANCH MUST BE EXERCISED, AND BY EXACTLY THE STATES THAT CAN
       EXERCISE IT. The second legibility bar below scores dimmed cells on their
       colour CHOICE, which is a weaker test than the effective ratio; an empty
       dimmed bucket makes it vacuous. It is empty in the three DARK states and
       that is correct rather than a hole: amendment 2 sets
       --tok-namespace-opacity to 1 in body.dark-mode, so no dark token is
       dimmed at all, and every dark cell is therefore scored on the STRICTER
       bar. The light states inherit Solarized Light's own 0.7 and do carry one.
       Asserting the exact split - rather than "at least one somewhere" - is
       what stops dimming quietly appearing in dark (which would move cells onto
       the weaker bar unnoticed) or quietly vanishing from light (which would
       leave the weaker bar checking nothing). */
    const dimmedStates = selStates.filter(
      (s) => !selectionByState[s].error && selectionByState[s].cells.some((c) => c.opacity < 0.999),
    );
    const wantDimmed = ["light default", "clarity", "parchment"];
    check(
      "10l: exactly the light states carry a dimmed selected token, matching amendment 2's reach",
      dimmedStates.slice().sort().join(",") === wantDimmed.slice().sort().join(","),
      `dimmed in [${dimmedStates.join(", ")}], expected [${wantDimmed.join(", ")}]`,
    );
    /* THE REGIME, ASSERTED RATHER THAN ASSUMED. One distinct ::selection colour
       across many distinct resting colours is a flat repaint by definition;
       many distinct values means the tokens survive. The product is flat in
       every state today, and it must be, because --code-selection-fg is what
       carries the legibility of the four schemes - three of which have no
       readable flat default available (their --on-accent-fg is near-black ink
       meant for a light accent button). If this ever flips, the bar below
       changes with it and that is a decision, not a detail. */
    const regime = {};
    for (const s of selStates) {
      const st = selectionByState[s];
      regime[s] = st.error ? "error" : st.selInks.length === 1 && st.restInks > 1 ? "flat" : "through";
    }
    const notFlat = selStates.filter((s) => regime[s] !== "flat");
    check(
      "10l: selected code is repainted in one flat ink in every state, not left as the syntax palette",
      notFlat.length === 0,
      notFlat
        .map((s) => `${s}: ${regime[s]} (${(selectionByState[s].selInks || []).length} selection ink(s) over ${selectionByState[s].restInks} resting)`)
        .join(" | ") || "all six flat",
    );
    for (const label of selStates) {
      const st = selectionByState[label];
      const bar = regime[label] === "through" ? SELECTION_TOKEN_MIN : SELECTION_FLAT_MIN;
      /* THE SAME SPLIT 10g USES, and for the same reason. A cell painted at
         full opacity is scored as the reader sees it. A cell the syntax layer
         DIMS is scored on the colour choice BEFORE the dimming, because the
         dimming is not the scheme's decision: --tok-namespace-opacity is 0.7
         in :root, leaked from Solarized Light, and every light scheme inherits
         it - the same leak amendment 2 identified and fixed for dark mode.
         Measured, this is not academic: parchment's dimmed namespace cell
         renders at 3.84:1 through its highlight while the ink it chose is
         7.86:1 there. Holding the scheme to 3.84 would demand a darker ink
         than any colour parchment declares, to compensate for a dimming it
         does not own; dropping the bar to 3:1 for dimmed cells would be the
         convenient answer rather than the right one. Scoring the choice is
         what 10g already decided, so 10l follows it instead of inventing a
         third rule.
         Compared RAW - rounding to two decimals before the test lets 4.496
         pass a 4.5 bar; the rounding belongs in the message only. */
      const undimmed = (st.cells || []).filter((c) => c.opacity >= 0.999 && c.ratio < bar);
      const dimmed = (st.cells || []).filter((c) => c.opacity < 0.999 && c.choice < bar);
      const where = `${st.declared} over ${st.behind} = ${st.effective}, ink ${st.declaredFg || "(inherited)"}`;
      check(
        `${label}: selected code at full opacity is legible against its own highlight (${bar}:1)`,
        !st.error && undimmed.length === 0,
        `${where}; ${undimmed.length} of ${(st.cells || []).length} cell(s) below: ` +
          undimmed
            .slice(0, 6)
            .map((c) => `${c.name} ${c.painted} on ${c.on} ${c.ratio.toFixed(2)}`)
            .join(" | "),
      );
      check(
        `${label}: selected code that inherits dimming chose a colour that was legible before it (${bar}:1)`,
        !st.error && dimmed.length === 0,
        `${where}; ${dimmed.length} dimmed cell(s) whose choice is below: ` +
          dimmed
            .slice(0, 6)
            .map((c) => `${c.name} ${c.painted} @${c.opacity} on ${c.on} choice ${c.choice.toFixed(2)} effective ${c.ratio.toFixed(2)}`)
            .join(" | "),
      );
      const floor = SELECTION_VISIBLE_FLOOR[label];
      check(
        `${label}: the selection highlight is still visible against the code behind it`,
        !st.error && st.visible >= floor,
        `${st.effective} against ${st.behind} = ${(st.visible || 0).toFixed(2)}, recorded floor ${floor}`,
      );
      /* A DIMMED CELL NEEDS A FLOOR OF ITS OWN, and until now it had none.
         The bar above scores dimmed cells on their colour CHOICE - the ratio
         the ink would have had before the inherited opacity - because the
         scheme owns the choice and 10g already decided that the dimming is
         Solarized Light's, not the scheme's. That is the right subject for
         blame, but it means the ratio the READER actually sees was bounded by
         nothing at all: parchment's namespace token renders at 3.84:1 today,
         under an assertion whose name says 4.5, and a scheme could take it to
         1.5 with the suite still green.
         So the effective ratio is floored too, one bar lower. 3:1 is not a
         second opinion about 4.5 - it is the large-text threshold, and it pins
         the 3.84 that ships without demanding parchment fix a dimming it does
         not own. */
      const dimmedFaint = (st.cells || []).filter(
        (c) => c.opacity < 0.999 && c.ratio < SELECTION_DIMMED_EFFECTIVE_MIN,
      );
      check(
        `${label}: selected code that inherits dimming is still readable after it (${SELECTION_DIMMED_EFFECTIVE_MIN}:1)`,
        !st.error && dimmedFaint.length === 0,
        `${where}; ${dimmedFaint.length} dimmed cell(s) below: ` +
          dimmedFaint
            .slice(0, 6)
            .map((c) => `${c.name} ${c.painted} @${c.opacity} on ${c.on} effective ${c.ratio.toFixed(2)}`)
            .join(" | "),
      );
      /* THE INLINE HIGHLIGHTED SURFACE. Everything above measures
         `pre[class*="language-"]`, but the code ::selection rule's selector
         list also names `code[class*="language-"]`, which matches INLINE
         highlighted code. That surface was in the rule's scope and outside
         every measurement of it.

         I EXPECTED THIS TO BE A DEFECT AND THE MEASUREMENT SAID OTHERWISE,
         which is the only reason the premise is now asserted rather than
         assumed. The suspicion was that inline code sits on --code-inline-bg,
         a different variable from the --code-bg the theme-7-contrast alphas
         were swept against, so the derived tints might not clear there. They
         do, because the backdrop is not what I read: the ported Prism rule
         `:not(pre) > code[class*="language-"] { background-color:
         var(--code-bg) }` wins over `.markdown-body code`, so inline
         HIGHLIGHTED code is painted on the very same --code-bg as a block.
         Measured on abyss, whose two variables differ: the painted backdrop is
         rgb(26,32,41) = --code-bg, not its --code-inline-bg #1e2531.
         --code-inline-bg paints only UNHIGHLIGHTED inline code, which carries
         no language- class and is therefore not matched by the code
         ::selection rule at all - it takes the app-wide accent selection, and
         is out of this section's scope by construction rather than by
         omission.
         That identity is asserted below, because it is the entire reason one
         swept alpha covers both surfaces. If it ever stops holding, the two
         bars here go on passing against a backdrop nobody derived them for.

         THE INK IS SINGLE BY CONSTRUCTION, and that is a fact about the
         PRODUCT rather than about the fixture: renderer.js highlightNewElements
         selects `pre code:not(.prism-highlighted)`, so Prism never runs on
         inline code and it carries no tokens at all. The loop below is written
         over whatever cells the probe finds anyway, so if that selector is ever
         widened the new token inks are scored without this assertion changing. */
      const inlineBar = regime[label] === "through" ? SELECTION_TOKEN_MIN : SELECTION_FLAT_MIN;
      const inlineFaint = (st.inlineCells || []).filter((c) => c.ratio < inlineBar);
      check(
        `${label}: selected INLINE highlighted code is legible against its own highlight (${inlineBar}:1)`,
        !st.error && (st.inlineCells || []).length > 0 && inlineFaint.length === 0,
        `${st.declared} over ${st.inlineOn} = ${st.inlineEffective}, ink ${st.inlineInk || "(inherited)"}; ` +
          `${inlineFaint.length} of ${(st.inlineCells || []).length} cell(s) below: ` +
          inlineFaint
            .slice(0, 6)
            .map((c) => `${c.name} ${c.painted} on ${c.on} ${c.ratio.toFixed(2)}`)
            .join(" | "),
      );
      /* The SAME recorded floors as the block surface, and that is sound only
         because of the backdrop identity asserted below - not because the two
         numbers happened to come out close. */
      check(
        `${label}: the selection highlight is still visible against INLINE code's own background`,
        !st.error && Number.isFinite(st.inlineVisible) && st.inlineVisible >= floor,
        `${st.inlineEffective} against ${st.inlineOn} = ` +
          `${Number.isFinite(st.inlineVisible) ? st.inlineVisible.toFixed(2) : "n/a"}, recorded floor ${floor}`,
      );
    }
    /* THE PREMISE, asserted once across all six states: inline highlighted code
       is painted on the SAME backdrop as a code block. Every alpha in
       theme-7-contrast was derived by sweeping against that one backdrop, so
       this identity is what lets a single derived tint cover both surfaces.
       Point the inline rule at --code-inline-bg instead - which reads like an
       obvious correction, since the variable is literally named for inline
       code - and the swept alphas no longer describe the surface they land on.
       Compared against the BLOCK's measured backdrop rather than against a
       literal colour, so it holds for every scheme added later. */
    const inlineBackdrop = selStates.filter(
      (s) => selectionByState[s].error || selectionByState[s].inlineOn !== selectionByState[s].behind,
    );
    check(
      "inline highlighted code sits on the same backdrop the selection alphas were derived against",
      inlineBackdrop.length === 0,
      inlineBackdrop
        .map((s) => `${s}: inline ${selectionByState[s].inlineOn} vs block ${selectionByState[s].behind}`)
        .join(" | ") || "all six states match",
    );
    /* THE SCOPE CLAIM, separate from the two bars above because it is the
       CAUSE and they are the consequence. If inline code ever stops matching
       the code ::selection rule it falls back to the app-wide accent selection
       - which is opaque, not a tint - and the bars would go on measuring
       something legible while the product had silently changed surface.
       Comparing the inline fill against the BLOCK fill is what pins "the same
       rule paints both", and it needs no literal colour of its own to do it. */
    const inlineScope = selStates.filter(
      (s) =>
        selectionByState[s].error ||
        !selectionByState[s].inlineBlocks ||
        selectionByState[s].inlineFill !== selectionByState[s].paintedFill,
    );
    check(
      "inline highlighted code is painted by the same code ::selection rule as a block",
      inlineScope.length === 0,
      inlineScope
        .map(
          (s) =>
            `${s}: n=${selectionByState[s].inlineBlocks} inline ${selectionByState[s].inlineFill} vs block ${selectionByState[s].paintedFill}`,
        )
        .join(" | ") || "all six states match",
    );
    console.log(
      `  note: selection - ` +
        selStates
          .map((s) => {
            const st = selectionByState[s];
            const und = (st.cells || []).filter((c) => c.opacity >= 0.999);
            const dim = (st.cells || []).filter((c) => c.opacity < 0.999);
            const worstU = und.reduce((m, c) => (m && m.ratio <= c.ratio ? m : c), null);
            const worstD = dim.reduce((m, c) => (m && m.choice <= c.choice ? m : c), null);
            const wU = worstU ? worstU.ratio : Infinity;
            const wD = worstD ? worstD.choice : Infinity;
            const d = dim.length;
            const n = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
            /* THE WORST CELL IS NAMED, NOT JUST SCORED. A bare ratio in a note
               is exactly the "a passing assertion never says what it passed
               at" gap that left SELECTION_VISIBLE_FLOOR sitting at a
               placeholder 1.0 - and it cost a diagnosis cycle again when three
               dark states moved and the note could not say whether the WORST
               CELL had changed or merely its ink. The name and the backdrop
               make that readable at a glance on every run. */
            const tag = (c) => (c ? `${c.name}@${c.on}` : "-");
            return (
              `${s} ${regime[s]} undimmed ${n(wU)} [${tag(worstU)}] ` +
              `dimmed(choice) ${n(wD)} [${tag(worstD)}] x${d} vis ${(st.visible || 0).toFixed(2)} ` +
              `subject ${st.blocks}b/${st.restInks}i/${(st.cells || []).length}c`
            );
          })
          .join(", "),
    );
    console.log(
      `  note: selection (inline highlighted code) - ` +
        selStates
          .map((s) => {
            const st = selectionByState[s];
            const ic = st.inlineCells || [];
            const worst = ic.reduce((m, c) => (m && m.ratio <= c.ratio ? m : c), null);
            const n = (x) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");
            return (
              `${s} n=${st.inlineBlocks} cells=${ic.length} on ${st.inlineOn} -> ${st.inlineEffective} ` +
              `worst ${n(worst && worst.ratio)} [${worst ? worst.name : "-"}] vis ${n(st.inlineVisible)}`
            );
          })
          .join(", "),
    );

    // ── 10h: the glyphs no element sweep can see ────────────────────────────
    // 10d walks document.querySelectorAll('*'), so its subject set is elements.
    // A ::before or ::after that carries `content` paints TEXT and has its own
    // colour, its own background and its own opacity - and it is not an
    // element, so it is invisible to that walk. 10g does not cover it either:
    // its collector explicitly SKIPS any selector containing '::', because a
    // pseudo-element cannot be selected and therefore cannot be replayed onto.
    // So the product's four glyph-painting pseudo rules - the two submenu
    // ticks, the drag-drop overlay label and the heading collapse arrow - sat
    // outside every contrast assertion in the suite.
    //
    // THE SUBJECT SET IS BUILT TWICE, FROM TWO INDEPENDENT DIRECTIONS, and
    // that is the whole design. The MEASUREMENT sweeps the live DOM, so a
    // pseudo painted by a rule nobody thought to look for is still scored. The
    // COVERAGE check sweeps the STYLESHEET, so a rule whose subject is absent
    // from the DOM - the failure mode R295 recorded, where an assertion walks
    // a document that no longer contains the thing it is named for - is
    // reported rather than silently dropping out of a clean sweep.
    const PSEUDO_PROBE = `(() => {
      function parse(c) {
        const m = /^rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)$/.exec(c);
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
      }
      function lum(c) {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      }
      const ratio = (a, b) => {
        const l1 = lum(a), l2 = lum(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      function over(fg, bg) {
        return {
          r: fg.r * fg.a + bg.r * (1 - fg.a),
          g: fg.g * fg.a + bg.g * (1 - fg.a),
          b: fg.b * fg.a + bg.b * (1 - fg.a),
          a: 1,
        };
      }
      function composite(stack) {
        let out = { r: 255, g: 255, b: 255, a: 1 };
        for (let i = stack.length - 1; i >= 0; i--) out = over(stack[i], out);
        return out;
      }
      /* THE PSEUDO'S OWN FILL IS THE FIRST LAYER, NOT A SEPARATE CASE. The
         drag-drop overlay paints its label on an accent tint at alpha 0.08 that
         belongs to the ::after itself; taking the ELEMENT's background as the
         surface would score that label against the bare page and report a
         ratio the reader never receives. Same compositing rule as 10g, applied
         one layer earlier. */
      function surfaceUnder(el, own) {
        const stack = [];
        if (own && own.a > 0) {
          stack.push(own);
          if (own.a >= 0.999) return composite(stack);
        }
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) { stack.push(c); if (c.a >= 0.999) break; }
        }
        return composite(stack);
      }
      /* WHAT COUNTS AS A GLYPH IS DECIDED BY THE VALUE, NOT BY THE RULE'S
         INTENT. content: "" is the product's own alignment spacer and paints
         nothing; content: url(...) paints an image, which has no text colour to
         score. Only a non-empty quoted string, or a value pulled from the
         document through attr()/counter(), puts ink on the screen. The same
         predicate is used on the COMPUTED value below and on the AUTHORED
         value in the coverage scan, so the two directions cannot disagree
         about what they are counting. */
      const GLYPH = (v) => {
        if (!v) return false;
        const s = String(v).trim();
        if (!s || s === 'none' || s === 'normal') return false;
        const q = s.match(/"[^"]*"|'[^']*'/g);
        if (q && q.join('').replace(/["']/g, '').trim()) return true;
        return /(^|[^-\\w])(attr|counter|counters)\\(/.test(s);
      };
      /* The overlay is put into the state the reader sees, by doing exactly
         what the product does at renderer.js:2138-2139 - the label comes from
         the product's own string table, never from a literal here, because a
         fabricated label would measure a surface the product might never
         paint. Restored before the probe returns, so every one of the six
         theme states scans an identical document and the equality guard below
         means something. */
      const hadDrop = document.body.classList.contains('drop-active');
      if (!hadDrop) {
        if (!document.body.dataset.dropLabel && typeof i18n === 'function') {
          try { document.body.dataset.dropLabel = i18n('drop.hint'); } catch (e) {}
        }
        document.body.classList.add('drop-active');
      }
      const cells = [];
      const seen = new Set();
      let scanned = 0, glyphs = 0, invisible = 0;
      const els = [document.body].concat([].slice.call(document.querySelectorAll('*')));
      for (const el of els) {
        scanned++;
        for (const pseudo of ['::before', '::after']) {
          const cs = getComputedStyle(el, pseudo);
          if (!cs || !GLYPH(cs.content)) continue;
          if (cs.display === 'none') continue;
          glyphs++;
          let o = parseFloat(cs.opacity);
          if (isNaN(o)) o = 1;
          for (let a = el; a; a = a.parentElement) {
            const v = parseFloat(getComputedStyle(a).opacity);
            o *= isNaN(v) ? 1 : v;
          }
          if (o === 0) { invisible++; continue; }
          const fg = parse(cs.color);
          const bg = surfaceUnder(el, parse(cs.backgroundColor));
          if (!fg || !bg) continue;
          /* WHETHER THE PSEUDO CHOOSES ITS OWN INK IS MEASURED, NOT LISTED,
             and it is what decides which bars can meaningfully apply to it.
             The heading collapse arrow declares no colour at all: it inherits
             the heading's, so the only lever a scheme has over it is the
             heading colour - which 10d already holds to an absolute 4.5 as a
             full-opacity text cell. Its 0.4 opacity is frozen with the
             defaults, so its RENDERED ratio is ~2.2 whatever a scheme does,
             and demanding that ratio never drift by 0.1 would forbid
             legitimate palette choices while protecting nothing. The two
             ticks and the overlay label DO declare their own colour, so they
             keep a lever of their own and stay in every bar. */
          const hostFg = getComputedStyle(el).color;
          const ownInk = cs.color !== hostFg;
          const hostPaintsText = [].slice.call(el.childNodes)
            .some((n) => n.nodeType === 3 && n.textContent.trim());
          let path = '', node = el;
          while (node && node.nodeType === 1) {
            const parent = node.parentElement;
            const idx = parent ? [].indexOf.call(parent.children, node) + 1 : 1;
            path = '>' + node.tagName.toLowerCase() + ':' + idx + path;
            node = parent;
          }
          path += pseudo;
          if (seen.has(path)) continue;
          seen.add(path);
          const sel = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
            (el.className && typeof el.className === 'string' && el.className.trim()
              ? '.' + el.className.trim().split(/\\s+/).join('.') : '') + pseudo;
          const ink = o >= 0.999 ? fg : {
            r: o * fg.r + (1 - o) * bg.r,
            g: o * fg.g + (1 - o) * bg.g,
            b: o * fg.b + (1 - o) * bg.b,
          };
          cells.push({
            path: path, sel: sel, o: o, r: ratio(fg, bg), rEff: ratio(ink, bg),
            ownInk: ownInk, hostPaintsText: hostPaintsText,
            fg: 'rgb(' + fg.r + ',' + fg.g + ',' + fg.b + ')',
            bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
          });
        }
      }
      /* THE COVERAGE HALF: every glyph-painting rule the stylesheet declares
         must have produced a measured cell. An assertion of absence over a
         swept DOM is only as wide as that DOM, so without this a rule whose
         subject is never built would leave the subject set with nothing
         failing anywhere. */
      const PSEUDO_SEL = /::?(before|after)\\b/;
      const PSEUDO_SEL_G = /::?(before|after)\\b/g;
      const glyphRules = [];
      const walk = (rules) => {
        for (const rule of rules) {
          if (rule.style && rule.selectorText && PSEUDO_SEL.test(rule.selectorText) &&
              GLYPH(rule.style.getPropertyValue('content'))) {
            for (const part of rule.selectorText.split(',')) {
              const t = part.trim();
              if (t && PSEUDO_SEL.test(t)) {
                const which = /::?after\\b/.test(t) ? '::after' : '::before';
                glyphRules.push({ sel: t, bare: t.replace(PSEUDO_SEL_G, '').trim(), pseudo: which });
              }
            }
          }
          if (rule.cssRules && rule.cssRules.length) walk(rule.cssRules);
        }
      };
      for (const sheet of document.styleSheets) {
        let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
        if (rules) walk(rules);
      }
      const uncovered = [];
      for (const g of glyphRules) {
        let hit = false;
        try {
          for (const el of document.querySelectorAll(g.bare)) {
            const cs = getComputedStyle(el, g.pseudo);
            if (cs && GLYPH(cs.content) && cs.display !== 'none') { hit = true; break; }
          }
        } catch (e) { hit = false; }
        if (!hit && uncovered.indexOf(g.sel) === -1) uncovered.push(g.sel);
      }
      if (!hadDrop) document.body.classList.remove('drop-active');
      /* The bare page, composited the same way and with NO pseudo fill on top.
         It is what the overlay label's surface would collapse to if the
         pseudo's own background ever stopped being the first layer, which is
         the one part of surfaceUnder() no value comparison can see. */
      const pb = surfaceUnder(document.body, null);
      return JSON.stringify({
        scanned: scanned, glyphs: glyphs, invisible: invisible,
        rules: glyphRules.map((g) => g.sel), uncovered: uncovered,
        dropLabel: document.body.dataset.dropLabel || '',
        pageBg: 'rgb(' + Math.round(pb.r) + ',' + Math.round(pb.g) + ',' + Math.round(pb.b) + ')',
        cells: cells,
      });
    })()`;

    const pseudoBase = {};
    for (const mode of ["light", "dark"]) {
      await applySettled(mode, null, mode + " default (pseudo baseline)");
      pseudoBase[mode] = JSON.parse(await exec(PSEUDO_PROBE));
    }
    const pBuckets = (s) => ({
      glyphs: s.glyphs,
      invisible: s.invisible,
      cells: s.cells.length,
      dimmed: s.cells.filter((c) => c.o < 0.999).length,
      undimmed: s.cells.filter((c) => c.o >= 0.999).length,
    });
    /* THE FLOOR IS ON THE PRODUCT'S RULES, NOT ON THE CELL COUNT, because the
       cell count is dominated by the heading arrows and would stay comfortably
       above any threshold while every hand-written rule in custom-styles.css
       quietly stopped matching.

       THE FLOOR SAID 4 AND THE MEASUREMENT SAYS 9, so it carried five rules of
       slack and would have passed with every tick and overlay rule deleted,
       leaving only heading arrows - the exact magic-floor shape this file
       removed from the selection sweep. `rules` counts COMMA-SEPARATED PARTS,
       one push per part, which is where the old count went wrong: it named the
       six-part heading list and then counted it as one.
       Measured inventory, 9 parts over 3 rules:
         styles.css        body.drop-active::after                     1
         styles.css        .markdown-body h1..h6::before  (six-part)   6
         custom-styles.css .custom-theme-option.active::before,
                           .custom-scheme-option.active::before        2
       (`custom-styles.css` .custom-*-option::before with `content: ""` is
       correctly excluded by the GLYPH predicate - it paints no glyph.)
       The count is printed in the `note:` line below on every run, so this
       floor cannot drift back into being unreadable. */
    check(
      "the pseudo-element sweep found the product's glyph-painting rules",
      pseudoBase.light.rules.length >= 9 && pseudoBase.dark.rules.length >= 9,
      `light ${pseudoBase.light.rules.length}, dark ${pseudoBase.dark.rules.length} rule(s): ${pseudoBase.light.rules.join(" | ")}`,
    );
    check(
      "every glyph-painting rule in the stylesheet reached a measured element",
      pseudoBase.light.uncovered.length === 0 && pseudoBase.dark.uncovered.length === 0,
      `unreached (so any contrast defect in them goes unreported): light [${pseudoBase.light.uncovered.join(" | ")}] dark [${pseudoBase.dark.uncovered.join(" | ")}]`,
    );
    /* POSITIVE CONTROL FOR THE OVERLAY ACTIVATION. body.drop-active::after is
       the one glyph surface no resting DOM contains, so the probe puts the
       body into that state itself. If the class or the label ever stops being
       what the product uses, the overlay simply produces no cell and the
       accent-on-tint pairing leaves the subject set with every assertion still
       green - the R295 failure exactly. */
    const dropCell = (s) => s.cells.some((c) => c.sel.indexOf("body") === 0 && c.sel.indexOf("::after") !== -1);
    check(
      "the drag-drop overlay label was really put into the state the reader sees",
      dropCell(pseudoBase.light) && dropCell(pseudoBase.dark) && pseudoBase.light.dropLabel !== "",
      `label=${JSON.stringify(pseudoBase.light.dropLabel)} light=${dropCell(pseudoBase.light)} dark=${dropCell(pseudoBase.dark)}`,
    );
    /* THE SECOND HALF OF THAT CONTROL, and it needs its own name because it
       fails under a different accident. The label is painted on a fill that
       belongs to the ::after, not to any element - an 8% tint of the accent
       over the page - so taking the ELEMENT's background as the surface would
       score it against the bare page and report a ratio the reader never
       receives. That mistake is invisible to every value comparison here: it
       does not strand a colour or drop a cell, it just measures the wrong
       pair, and it measures it in the flattering direction. Both defaults'
       labels read ~3.2 against the bare page and ~3.0 against their own tint,
       so the ONLY thing that can catch it is the surface itself. */
    const dropSurface = (s) => {
      const c = s.cells.find((x) => x.sel.indexOf("body") === 0 && x.sel.indexOf("::after") !== -1);
      return c ? c.bg : "";
    };
    check(
      "the overlay label was measured against its own tint, not the bare page beneath it",
      ["light", "dark"].every(
        (m) => dropSurface(pseudoBase[m]) && dropSurface(pseudoBase[m]) !== pseudoBase[m].pageBg,
      ),
      `light label-surface=${dropSurface(pseudoBase.light)} page=${pseudoBase.light.pageBg}; ` +
        `dark label-surface=${dropSurface(pseudoBase.dark)} page=${pseudoBase.dark.pageBg}`,
    );
    /* Both buckets occupied, for the same reason 10d asserts it: the bars
       below are SPLIT by this distinction, so an empty bucket makes one of
       them vacuous. The heading arrows are dimmed (opacity .4), the ticks and
       the overlay label are not. */
    check(
      "the defaults paint pseudo glyphs at BOTH full and reduced opacity",
      ["light", "dark"].every(
        (m) => pBuckets(pseudoBase[m]).dimmed > 0 && pBuckets(pseudoBase[m]).undimmed > 0,
      ),
      `light ${JSON.stringify(pBuckets(pseudoBase.light))}, dark ${JSON.stringify(pBuckets(pseudoBase.dark))}`,
    );
    /* RECORDED, NOT ASSERTED AWAY, exactly as 10d records the defaults' own
       sub-AA cells. The submenu tick is var(--primary-color) on the menu fill
       and the overlay label is the same accent on an 8% tint of itself; both
       are frozen by the byte-exact-default requirement, so the honest bar for
       them is the relative one below. A non-empty list is also what stops the
       relative bars being trivially true for every scheme. */
    check(
      "both defaults carry the pre-existing sub-AA pseudo cells the relative bars are measured against",
      ["light", "dark"].every((m) => pseudoBase[m].cells.filter((c) => c.rEff < 4.5).length > 0),
      `light ${pseudoBase.light.cells.filter((c) => c.rEff < 4.5).length}, dark ${pseudoBase.dark.cells.filter((c) => c.rEff < 4.5).length}`,
    );
    const pShow = (c) => `${c.sel} ${c.fg} on ${c.bg} o=${c.o.toFixed(2)} r=${c.r.toFixed(2)} rendered=${c.rEff.toFixed(2)}`;
    /* THE PAIRING KEY IS THE SELECTOR, NOT THE DOM PATH, and that is a real
       difference here rather than a stylistic one. 10d keys on the path because
       its population is 157 cells and a tag-name key would collapse dozens of
       them. This population is 8, and one of its members MOVES BY DESIGN: the
       submenu tick is drawn by .custom-scheme-option.active::before, so
       selecting a scheme relocates it to that scheme's row. Under a path key
       the tick read as two cells with no counterpart in the baseline, and the
       assertion written to catch a SHRINKING document instead reported the
       product working correctly. The selector carries .active, so it is stable
       across exactly the states the tick moves between. */
    const bySel = (s) => {
      const m = new Map();
      for (const c of s.cells) {
        const prev = m.get(c.sel);
        if (!prev || c.rEff < prev.rEff) m.set(c.sel, c);
      }
      return m;
    };
    /* THE EXEMPTION IS PROVEN, NOT DECLARED. An inherited-ink cell is only
       safely outside the relative bars if the ink it inherits is itself held
       to a bar somewhere - which is true exactly when the host element paints
       text of its own, because that is 10d's subject. The floor stops the
       exemption from quietly becoming the whole population. */
    for (const mode of ["light", "dark"]) {
      const inherited = pseudoBase[mode].cells.filter((c) => !c.ownInk);
      check(
        `${mode} default: every pseudo glyph that inherits its ink sits on an element 10d already scores`,
        inherited.length >= 3 && inherited.every((c) => c.hostPaintsText),
        `${inherited.length} inherited-ink cell(s); not text-painting: ${inherited.filter((c) => !c.hostPaintsText).map((c) => c.sel).join(" | ")}`,
      );
      check(
        `${mode} default: at least one pseudo glyph chooses its own ink, so the relative bars have a population`,
        pseudoBase[mode].cells.filter((c) => c.ownInk).length >= 2,
        `own-ink cells: ${pseudoBase[mode].cells.filter((c) => c.ownInk).map((c) => c.sel).join(" | ")}`,
      );
    }
    for (const [mode, scheme] of SCHEME_STATES) {
      await applySettled(mode, scheme, scheme + " (pseudo)");
      const cur = JSON.parse(await exec(PSEUDO_PROBE));
      const baseBySel = bySel(pseudoBase[mode]);
      check(
        `${scheme}: the pseudo sweep scanned the very same document its mode's default did`,
        JSON.stringify(pBuckets(cur)) === JSON.stringify(pBuckets(pseudoBase[mode])) &&
          cur.uncovered.length === 0 &&
          cur.cells.every((c) => baseBySel.has(c.sel)),
        `scheme ${JSON.stringify(pBuckets(cur))} vs default ${JSON.stringify(pBuckets(pseudoBase[mode]))}; uncovered [${cur.uncovered.join(" | ")}]; unpaired: ${cur.cells.filter((c) => !baseBySel.has(c.sel)).map((c) => c.sel).join(" | ")}`,
      );
      const pUndimmed = cur.cells.filter((c) => c.o >= 0.999 && c.rEff < 4.5);
      check(
        `${scheme}: every pseudo glyph it paints at full opacity meets WCAG AA (4.5:1)`,
        pUndimmed.length === 0,
        pUndimmed.map(pShow).join(" | "),
      );
      const pDimmed = cur.cells.filter((c) => c.o < 0.999 && c.r < 4.5);
      check(
        `${scheme}: every dimmed pseudo glyph's colour choice meets WCAG AA before the inherited dimming`,
        pDimmed.length === 0,
        pDimmed.map(pShow).join(" | "),
      );
      const pNovel = cur.cells.filter(
        (c) => c.ownInk && c.rEff < 4.5 && !(baseBySel.get(c.sel) && baseBySel.get(c.sel).rEff < 4.5),
      );
      check(
        `${scheme}: every pseudo glyph that RENDERS below AA also renders below AA in its mode's default`,
        pNovel.length === 0,
        pNovel
          .map((c) => `${pShow(c)} (default rendered ${baseBySel.get(c.sel) ? baseBySel.get(c.sel).rEff.toFixed(2) : "ABSENT"})`)
          .join(" | "),
      );
      const pWorse = cur.cells.filter(
        (c) =>
          c.ownInk &&
          baseBySel.has(c.sel) &&
          baseBySel.get(c.sel).rEff < 4.5 &&
          c.rEff < baseBySel.get(c.sel).rEff - 0.01,
      );
      check(
        `${scheme}: no pseudo glyph that was already below AA in the default is made worse`,
        pWorse.length === 0,
        pWorse
          .map((c) => `${c.sel} rendered ${baseBySel.get(c.sel).rEff.toFixed(2)} -> ${c.rEff.toFixed(2)}`)
          .join(" | "),
      );
    }
    console.log(
      `  note: pseudo glyph sweep: ${pseudoBase.light.rules.length} rules, ` +
        `${JSON.stringify(pBuckets(pseudoBase.light))} light / ${JSON.stringify(pBuckets(pseudoBase.dark))} dark`,
    );
    await applySettled("light", null, "restore after pseudo probe");

    // The welcome markup has served 10c, 10d, 10f and 10g; take it back out so
    // 10e and the final restore see the document the rest of the suite built.
    await exec(
      `(() => { const n = document.querySelector('[data-folia-welcome-probe]');
        if (n) n.remove(); return 1; })()`,
    );

    // ── 10e: behaviour - the registry's own rules ────────────────────────────
    // Everything above measures the STYLESHEET. These measure the JS that
    // decides which block applies, driven through window.foliaThemes rather
    // than a reimplementation of it.
    const beh = JSON.parse(
      await exec(`(() => {
        const T = window.foliaThemes, K = T.SCHEME_KEYS, out = {};
        const state = () => (document.body.getAttribute('data-theme') || 'none') + '/' +
          (document.body.classList.contains('dark-mode') ? 'dark' : 'light');

        // Picking a dark scheme from a light page must switch the MODE too -
        // that is what clicking it means to a reader.
        localStorage.setItem('themeMode', 'light');
        T.setScheme('abyss');
        out.crossMode = state();
        out.crossModePref = localStorage.getItem('themeMode');

        // A base scheme applies by REMOVING data-theme. Writing
        // data-theme="default-dark" instead would need a second copy of the
        // default appearance in the stylesheet, free to drift from the golden.
        T.setScheme('default-dark');
        out.baseApplies = state();

        // An unknown stored id - a downgrade, or a scheme withdrawn - falls
        // back to the mode's base rather than leaving the page half-applied.
        localStorage.setItem(K.dark, 'no-such-scheme-xyz');
        out.unknownFallback = T.schemeFor('dark').id;

        // A DARK id stored under the LIGHT key must not be applied over a light
        // page. This is the s.mode === mode term in schemeFor().
        localStorage.setItem(K.light, 'abyss');
        out.foreignModeFallback = T.schemeFor('light').id;
        localStorage.removeItem(K.light);
        localStorage.removeItem(K.dark);

        /* THE EXPORTED FUNCTION MUST BE TOTAL OVER THE STORED VALUE DOMAIN.
           themeMode is light|dark|desktop, so "desktop" is a legitimate thing
           for a caller to hold - but it is not a SCHEME mode, and passing it
           through unresolved read the literal localStorage key "undefined",
           matched nothing, and returned undefined from baseSchemeFor because
           no scheme carries mode "desktop". applyScheme() then throws on
           scheme.base inside a click handler, outside the one try that guards
           the parse-time call. Every internal caller happens to resolve the
           mode first, which is exactly why this was reachable only through the
           exported surface and invisible to every other assertion here. */
        try {
          const d = T.schemeFor('desktop');
          out.desktopTotal = d && d.id ? d.id : 'returned ' + String(d);
        } catch (e) {
          out.desktopTotal = 'threw: ' + e.message;
        }
        out.desktopExpected = matchMedia('(prefers-color-scheme: dark)').matches
          ? 'default-dark'
          : 'default-light';

        // An export owns the appearance until it has finished rasterising.
        localStorage.setItem('themeMode', 'dark');
        T.setScheme('ember');
        const before = state();
        beginExportThemeHold();
        parkExportScheme();
        out.parked = document.body.getAttribute('data-theme') || 'none';
        // While the hold is up, a scheme picked from the menu must NOT repaint
        // the page underneath printToPDF - and once the hold releases it must
        // land. A DIFFERENT scheme is picked on purpose: re-picking the one
        // already stored makes the release indistinguishable from restoring a
        // parked snapshot, and restoreExportScheme() reads the STORED
        // PREFERENCE (renderer.js:2300-2313 says so in as many words), which is
        // the only reason a mid-export menu pick lands at all.
        T.setScheme('abyss');
        out.heldNoOp = document.body.getAttribute('data-theme') || 'none';
        out.holdReportedUp = ${HELD}();
        endExportThemeHold();
        restoreExportScheme();
        out.restored = state();
        out.before = before;
        out.holdReportedDown = ${HELD}();
        return JSON.stringify(out);
      })()`),
    );
    check(
      "picking a scheme from the other mode switches the mode with it",
      beh.crossMode === "abyss/dark" && beh.crossModePref === "dark",
      `state=${beh.crossMode} themeMode=${beh.crossModePref}`,
    );
    check(
      "a base scheme applies by removing data-theme, not by declaring itself",
      beh.baseApplies === "none/dark",
      `state=${beh.baseApplies}`,
    );
    check(
      "an unknown stored scheme id falls back to the mode's base",
      beh.unknownFallback === "default-dark",
      `schemeFor('dark') returned ${beh.unknownFallback}`,
    );
    check(
      "a scheme id stored under the other mode's key is not applied",
      beh.foreignModeFallback === "default-light",
      `schemeFor('light') returned ${beh.foreignModeFallback}`,
    );
    check(
      "schemeFor is total over the themeMode value domain, including 'desktop'",
      beh.desktopTotal === beh.desktopExpected,
      `schemeFor('desktop') -> ${beh.desktopTotal} (the OS preference resolves to ${beh.desktopExpected}); anything else means the exported surface can hand applyScheme an undefined scheme and throw inside a click handler`,
    );
    check(
      "an export parks the scheme, so a dark scheme is not printed onto white paper",
      beh.parked === "none" && beh.before === "ember/dark",
      `before=${beh.before} parked=${beh.parked}`,
    );
    check(
      "a scheme picked mid-export lands only once the export releases",
      beh.heldNoOp === "none" && beh.holdReportedUp === true && beh.restored === "abyss/dark",
      `data-theme during hold=${beh.heldNoOp} held=${beh.holdReportedUp} after release=${beh.restored} - "abyss/dark" is the proof the release reads the STORED preference rather than replaying the value parked before the hold, which was ember`,
    );
    check(
      "the scheme is restored from the stored preference once the export releases",
      beh.restored === "abyss/dark" && beh.holdReportedDown === false,
      `restored=${beh.restored} held=${beh.holdReportedDown}`,
    );

    // ── 10i: THE PRINTED PAGE, AND THE TWO SCOPE BOUNDARIES ─────────────────
    /* Everything above measures the page on SCREEN. printToPDF renders it
       under `@media print`, which is a different cascade, and this is the only
       section that looks at it.

       IT ALSO CORRECTS AN ASSUMPTION THIS FILE USED TO CARRY. A first probe
       measured `body` and `#viewer` under print emulation, found all six theme
       states resolving to rgb(51,51,51) on white, and concluded the print
       stylesheet neutralises schemes on its own. It does not. Measuring the
       rest of the page shows the neutralisation is scoped:

         - unconditional: body, #viewer                (styles.css:2172,
                                                        custom-styles.css:341)
         - only when body.dark-mode is present: headings, p, li, td, th,
           blockquote, code, pre, table borders, links  (custom-styles.css:355-412)
         - never, in any mode: every .token.* syntax colour

       So on paper, a LIGHT scheme keeps its own code box and its own tokens,
       and a DARK scheme gets a forced-light code box (#f5f5f5) still painted
       with tokens chosen for a near-black one - measured at 2.05:1 (abyss
       keyword), 2.14 (default dark) and 2.38 (ember).

       None of that is reachable through the product, and the reason is the
       whole point of this section: `prepare-for-pdf-export` strips the scheme
       AND the dark class BEFORE main calls printToPDF (renderer.js:2445-2455,
       main.js:1075-1079), and printToPDF on the main window is the only path
       that ever renders this document to paper - there is no
       webContents.print() and no print accelerator anywhere in src/.

       THE GUARANTOR IS THEREFORE THE JS PARK, NOT THE STYLESHEET, and that is
       what the assertions below say. 10e already covers the park's own
       semantics from the registry side; this covers what the reader actually
       gets on paper, by driving the REAL handler over its REAL ready signal.

       Observation recorded rather than asserted: the handler reports ready
       after a double rAF, while the colour transitions a mode change starts
       run for 0.2-0.3s, so printToPDF can in principle capture a page still
       in flight. Asserting on that would be a timing bet; the settle below is
       this instrument being honest about what it measures, not a claim that
       the product waits. */
    const PRINT_SURFACES = [
      "body",
      "#viewer",
      "#viewer p",
      "#viewer a",
      "#viewer h1",
      "#viewer h2",
      "#viewer h3",
      "#viewer blockquote",
      "#viewer pre",
      "#viewer pre code",
      "#viewer th",
      "#viewer td",
      "#viewer .token.comment",
      "#viewer .token.keyword",
    ];
    const PRINT_PROBE = `(() => {
      const SELS = ${JSON.stringify(PRINT_SURFACES)};
      const parse = (s) => {
        const m = /rgba?\\(([^)]+)\\)/.exec(s || '');
        if (!m) return null;
        const p = m[1].split(',').map((x) => parseFloat(x));
        return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
      };
      const rgb = (c) => c ? 'rgb(' + Math.round(c.r) + ',' + Math.round(c.g) + ',' + Math.round(c.b) + ')' : 'none';
      /* Same compositing rule as 10d: walk up until an opaque fill is found,
         then flatten. A scheme that tints a code box with a translucent layer
         must not read as its opaque ancestor. */
      const surface = (el) => {
        const st = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0) { st.push(c); if (c.a >= 0.999) break; }
        }
        let out = { r: 255, g: 255, b: 255 };
        for (let i = st.length - 1; i >= 0; i--) {
          const c = st[i];
          out = {
            r: c.a * c.r + (1 - c.a) * out.r,
            g: c.a * c.g + (1 - c.a) * out.g,
            b: c.a * c.b + (1 - c.a) * out.b,
          };
        }
        return out;
      };
      const out = { cells: {}, missing: [] };
      for (const sel of SELS) {
        const el = sel === 'body' ? document.body : document.querySelector(sel);
        if (!el) { out.missing.push(sel); continue; }
        out.cells[sel] = rgb(parse(getComputedStyle(el).color)) + ' on ' + rgb(surface(el));
      }
      const h = document.querySelector('.header');
      out.headerDisplay = h ? getComputedStyle(h).display : 'ABSENT';
      out.printMediaActive = window.matchMedia('print').matches;
      /* THE CAUSE, NOT ONLY THE SYMPTOM. The colour comparison below can only
         see a transition that has already moved a sampled surface off its
         settled value, which makes it depend on how long the probe's own IPC
         round trip took - a hidden latency bet a review round called out. This
         reading does not: it names every animation that is RUNNING and whose
         target the print stylesheet actually paints, which is the invariant
         the export relies on regardless of when the sample lands.
         checkVisibility() is the filter because @media print hides the
         chrome - the header and its buttons, the search, notes, index and
         editor panels, and (since this work) the three in-content overlay
         buttons - that owns every transition still running at this moment.
         Measured at the ready signal: 31 running, 0 of them visible. */
      const nm = (el) => !el || !el.tagName ? 'none' : el.tagName.toLowerCase() +
        (el.className && typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
      /* PRINT-HIDDEN, NOT SCREEN-HIDDEN - and the difference is a real flake.
         checkVisibility() answers a question about the SCREEN while this
         assertion is named for what printToPDF captures, which is the same
         subject/measurement mismatch this suite calls a disjunction elsewhere.
         .code-copy-btn rests at opacity 0 and fades in, so the opacity filter
         below excludes it at rest and at full fade - but catches it MID-fade,
         where opacity is fractional and checkVisibility() says "visible". That
         reported "still animating a printed surface: background-color on
         button.code-copy-btn" in 5 of 6 states on one run in four, while
         @media print hides the button outright and it can never reach the PDF.
         So the print-hidden set is derived from the print stylesheet's own
         display:none rules rather than assumed, and an animation whose target
         matches one of them is excluded regardless of what the screen is
         doing. Deriving it means a chrome element that STOPS being hidden in
         print starts being policed here on the same day. */
      out.printHiddenSels = [];
      try {
        for (const sheet of document.styleSheets) {
          let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
          for (const r of rules || []) {
            if (!r.media || !/\\bprint\\b/.test(r.conditionText || r.media.mediaText || '')) continue;
            for (const inner of r.cssRules || []) {
              if (!inner.style || !inner.selectorText) continue;
              const d = (inner.style.getPropertyValue('display') || '').trim();
              if (d === 'none') out.printHiddenSels.push(inner.selectorText);
            }
          }
        }
      } catch (e) { out.printHiddenSels = []; }
      const hiddenInPrint = (el) => {
        for (const sel of out.printHiddenSels) {
          try { if (el.matches(sel) || el.closest(sel)) return true; } catch (e) {}
        }
        return false;
      };
      out.runningVisible = [];
      out.runningPrintHidden = 0;
      try {
        for (const a of document.getAnimations()) {
          if (a.playState !== 'running') continue;
          const t = a.effect && a.effect.target;
          if (!t || typeof t.checkVisibility !== 'function') continue;
          /* ALL THREE OPTIONS, and the default call is WRONG here. Bare
             checkVisibility() answers "is it laid out" - it does NOT consider
             opacity, so .code-copy-btn, which rests at opacity 0 and fades in
             on hover, reports VISIBLE and produced five false positives the
             first time this was run. The question this arm asks is "would a
             reader see it move", so the filter has to be the painting one. */
          if (!t.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
            contentVisibilityAuto: true,
          })) continue;
          if (hiddenInPrint(t)) { out.runningPrintHidden++; continue; }
          out.runningVisible.push(
            (a.transitionProperty || a.animationName || 'anim') + ' on ' + nm(t));
        }
      } catch (e) { out.runningVisible = ['PROBE FAILED: ' + (e && e.message)]; }
      out.residue = (document.body.getAttribute('data-theme') || 'none') + '/' +
        (document.body.classList.contains('dark-mode') ? 'dark' : 'light');
      return JSON.stringify(out);
    })()`;

    const PRINT_STATES = [
      ["light", null, "default-light"],
      ["light", "clarity", "clarity"],
      ["light", "parchment", "parchment"],
      ["dark", null, "default-dark"],
      ["dark", "abyss", "abyss"],
      ["dark", "ember", "ember"],
    ];
    const printRaw = {};
    const printPrepared = {};
    const mermaidCfg = {};
    const prepFailures = [];
    const printAtReady = {};
    let printAttached = false;
    const printRestored = {};
    try {
      win.webContents.debugger.attach("1.3");
      printAttached = true;
      await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
        media: "print",
      });
      for (const [mode, scheme, label] of PRINT_STATES) {
        await applySettled(mode, scheme, `10i ${label}`);
        // Measured BEFORE the export preparation: this is what the stylesheet
        // alone does, and it is what makes the claim below non-vacuous.
        printRaw[label] = JSON.parse(await exec(PRINT_PROBE));
        mermaidCfg[label] = await exec(
          `JSON.stringify({ dark: getMermaidConfig(true), light: getMermaidConfig(false) })`,
        );

        /* Waited on the PRODUCT'S OWN readiness signal - the same
           `pdf-export-ready` main.js:1076 blocks on - rather than on a DOM
           predicate. A predicate like "data-theme is absent" is ALREADY TRUE
           for default-light and would have measured nothing there while
           looking identical to a real wait. */
        /* COUNTED, NOT `once`. `ipcMain.once` resolves on the first signal and
           stops listening, so a handler that emitted `pdf-export-ready` TWICE
           - which makes main.js call printToPDF twice and produce a corrupt or
           duplicated export - was completely invisible to this section. The
           listener now stays attached for the whole state and reports how many
           signals really arrived. */
        let readySignals = 0;
        let settleReady;
        const onReady = () => {
          readySignals++;
          if (settleReady) settleReady("READY");
        };
        const ready = new Promise((resolve) => {
          settleReady = resolve;
          ipcMain.on("pdf-export-ready", onReady);
        });
        const timer = setTimeout(() => settleReady("TIMEOUT"), 15000);
        const t0 = Date.now();
        win.webContents.send("prepare-for-pdf-export");
        const readyOutcome = await ready;
        if (readyOutcome === "TIMEOUT") prepFailures.push(`${label}: no pdf-export-ready`);
        clearTimeout(timer);
        /* THE PAGE AS IT STANDS THE INSTANT THE PRODUCT SAYS "READY", captured
           BEFORE the settle loop below. main.js calls printToPDF the moment
           this signal arrives, so this - not the settled page measured after
           the loop - is what a reader's PDF actually contains.
           The handler reports ready after a double rAF (~18ms) while themed
           transitions run 0.2-0.3s, so a review round rated this a probable
           mid-transition capture. MEASURED, it is not one, for two independent
           reasons: document content carries no colour transitions at all
           (custom-styles.css replaced the inherited `transition: all` with
           targeted transitions on chrome), and every transition still running
           at this moment targets an element @media print hides - measured 31
           running, 0 of them visible under the print stylesheet.
           So the double rAF is sufficient BY ACCIDENT OF THE STYLESHEET, not
           by construction, and that is exactly why it needs pinning: adding
           `transition: background-color` to a printed surface would silently
           start capturing half-faded colours, with the settled measurement
           below still reporting everything correct.
           RECORDED ONLY WHEN THE SIGNAL REALLY ARRIVED. This used to be an
           unconditional assignment after the timeout branch, which made the
           whole assertion FAIL OPEN in the one regression it exists for: if
           the handler stopped emitting `pdf-export-ready`, the probe ran 15
           seconds later against a fully settled page, `readyDiffs` came back
           empty, six entries existed, and an assertion named "the page is
           already settled the instant the export reports ready" passed for six
           states in which nothing had reported ready. The outcome and the
           signal count now travel WITH the reading instead of being delegated
           to a separate `prepFailures` assertion that names something else. */
        printAtReady[label] = {
          ok: readyOutcome === "READY",
          signals: readySignals,
          latencyMs: 0,
          probe: null,
        };
        printAtReady[label].probe = JSON.parse(await exec(PRINT_PROBE));
        printAtReady[label].latencyMs = Date.now() - t0;
        // Now that the reading is taken, a late second signal is still a defect
        // and is still counted - the listener stays attached until the state's
        // export cycle has been released below.
        for (let i = 0; i < 60; i++) {
          const running = await settleTransitions();
          maxRunning = Math.max(maxRunning, running);
          if (running === 0) break;
          await new Promise((r) => setTimeout(r, 50));
        }
        printPrepared[label] = JSON.parse(await exec(PRINT_PROBE));

        // Release through the real result handler so the hold cannot leak into
        // the next state, and so restoreExportScheme() is exercised each pass.
        await exec(`(() => {
          window.__pdfReleaseSeen = false;
          window.__pdfReleaseOff = window.folia.onPdfExportResult(() => {
            window.__pdfReleaseSeen = true;
            window.__pdfReleaseOff();
          });
          return null;
        })()`);
        let releaseDelivered = false;
        try {
          win.webContents.send("pdf-export-result", {
            success: true, path: "C:/tmp/10i-probe.pdf",
          });
          const releaseDeadline = Date.now() + 15000;
          while (Date.now() < releaseDeadline) {
            releaseDelivered = await exec("window.__pdfReleaseSeen === true");
            if (releaseDelivered) break;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        } finally {
          await exec("window.__pdfReleaseOff(); null;");
        }
        /* WAITED ON THE PRODUCT'S OWN MERMAID SETTLE RATHER THAN ONLY ON A
           SLEEP, because the result handler is async and its tail is
           unbounded: setExportTheme() awaits updateMermaidTheme() and then
           whenMermaidSettled(), which PERF-07 defers in idle chunks. Left as a
           fixed sleep, a document with enough diagrams would still be
           re-theming state N while state N+1 was being measured.
           The independent result-delivery flag above lets the real
           handler reach its first await before settlement is observed:
           both observables this section reads - data-theme and the dark class -
           land SYNCHRONOUSLY. restoreExportScheme() sets the attribute
           directly, and setExportTheme() toggles the class before its first
           await. Timed on this fixture and on a 12-diagram variant, both
           reached their final value in 0.1-0.2 ms. */
        await exec(
          `(async () => { if (typeof whenMermaidSettled === 'function') await whenMermaidSettled(); return 1; })()`,
        );
        /* THE OTHER HALF OF THE PARK, MEASURED THROUGH ITS REAL CALL SITE.
           parkExportScheme()'s call site is pinned by R317; its partner's was
           not, because every test that exercises restore called the function
           DIRECTLY. Deleting `restoreExportScheme();` from the
           pdf-export-result handler therefore failed nothing, while leaving
           exactly the regression renderer.js argues these are separate
           primitives to prevent: a reader whose scheme was stripped for an
           export never gets it back for the rest of the session. */
        printRestored[label] = JSON.parse(
          await exec(
            `JSON.stringify({ attr: document.body.getAttribute('data-theme'),` +
              ` dark: document.body.classList.contains('dark-mode') })`,
          ),
        );
        printRestored[label].delivered = releaseDelivered;
        /* DETACHED ONLY HERE, at the end of the state's whole export cycle, so
           a signal that arrives LATE - after the reading, during the settle, or
           on the way through the result handler - is still counted against this
           state rather than leaking into the next one's tally. */
        ipcMain.removeListener("pdf-export-ready", onReady);
        printAtReady[label].signals = readySignals;
      }
    } finally {
      if (printAttached) {
        try {
          await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", { media: "" });
        } catch (e) {
          /* detaching matters more than restoring the media type */
        }
        try {
          win.webContents.debugger.detach();
        } catch (e) {
          /* already gone */
        }
      }
    }

    const printedStates = Object.keys(printPrepared);
    /* WITHOUT THIS, EVERY CLAIM BELOW PASSES ON THE SCREEN CASCADE. The park
       makes all six states identical whether or not print media is in effect,
       so a silently-failed Emulation.setEmulatedMedia would leave the
       invariance assertion green while measuring the wrong medium entirely.
       Two independent oracles: the engine's own matchMedia, and .header being
       hidden, which only the print block does. */
    const mediaBad = []
      .concat(Object.entries(printRaw), Object.entries(printPrepared))
      .filter(([, v]) => !(v.printMediaActive && v.headerDisplay === "none"))
      .map(([k, v]) => `${k}: matchMedia=${v.printMediaActive} header=${v.headerDisplay}`);
    check(
      "10i: the print stylesheet really was in effect for every printed measurement (positive control)",
      mediaBad.length === 0 && printedStates.length === PRINT_STATES.length,
      `${printedStates.length}/${PRINT_STATES.length} states measured; ${mediaBad.slice(0, 3).join(" | ")}`,
    );

    const refCells = printPrepared["default-light"] ? printPrepared["default-light"].cells : {};
    const measuredSels = Object.keys(refCells);
    const MUST_REACH = ["#viewer pre", "#viewer .token.comment", "#viewer .token.keyword"];
    const anyMissing = printedStates
      .filter((k) => printPrepared[k].missing.length)
      .map((k) => `${k}: ${printPrepared[k].missing.join(",")}`);
    check(
      "10i: the printed-page sweep reached the surfaces the print stylesheet never neutralises",
      measuredSels.length >= 9 &&
        MUST_REACH.every((s) => measuredSels.includes(s)) &&
        anyMissing.length === 0,
      `${measuredSels.length} surfaces measured; missing ${anyMissing.join(" | ") || "none"} - the token cells are the ones no @media print rule touches, so a sweep that loses them proves nothing`,
    );

    check(
      "10i: the export preparation completed through its own pdf-export-ready signal",
      prepFailures.length === 0,
      prepFailures.join(" | "),
    );

    /* THE PARK IS ONLY SAFE IF IT IS UNDONE, and this measures the undo
       through the real pdf-export-result handler rather than by calling
       restoreExportScheme() directly the way 10e and 10k do. PRINT_STATES
       carries [mode, scheme, label], so the expected landing state is the
       state the loop applied - and for a base state that means data-theme
       genuinely absent, not merely "some value". */
    const restoreMisses = PRINT_STATES.filter(([mode, scheme, label]) => {
      const got = printRestored[label];
      if (!got || !got.delivered) return true;
      return got.attr !== (scheme || null) || got.dark !== (mode === "dark");
    }).map(
      ([mode, scheme, label]) =>
        `${label} -> data-theme=${JSON.stringify(printRestored[label]?.attr ?? "<never measured>")} dark=${printRestored[label]?.dark} (wanted ${JSON.stringify(scheme || null)} / ${mode})`,
    );
    check(
      "10i: the export result handler puts the reader's scheme back, so an export does not strip it for the session",
      restoreMisses.length === 0 && Object.keys(printRestored).length === PRINT_STATES.length,
      restoreMisses.join(" | "),
    );

    // THE CAUSE. Named separately from the consequence below because the two
    // fail under different accidents: a scheme that stored its state somewhere
    // parkExportScheme() does not clear would fail this one first.
    const residue = printedStates
      .filter((k) => printPrepared[k].residue !== "none/light")
      .map((k) => `${k} -> ${printPrepared[k].residue}`);
    check(
      "10i: the export preparation leaves no scheme or dark-mode residue on the page printToPDF captures",
      residue.length === 0,
      residue.join(" | "),
    );

    // THE CONSEQUENCE.
    const printDiffs = [];
    for (const label of printedStates) {
      if (label === "default-light") continue;
      for (const sel of measuredSels) {
        if (printPrepared[label].cells[sel] !== refCells[sel]) {
          printDiffs.push(`${label} ${sel}: ${printPrepared[label].cells[sel]} != ${refCells[sel]}`);
        }
      }
    }
    check(
      "10i: every theme state prints each measured surface exactly as the shipped light default does",
      printDiffs.length === 0 && printedStates.length === PRINT_STATES.length,
      printDiffs.slice(0, 5).join(" | "),
    );

    /* THE HANDSHAKE ITSELF. Everything above measures the page AFTER this
       suite settled the transitions; main.js does not settle anything - it
       calls printToPDF as soon as pdf-export-ready arrives. So without this,
       a printed surface that faded into place over 0.3s would be captured
       half-way and every assertion above would still report it perfect.
       Compared against the settled reading of the same state rather than
       against a frozen table, so it stays a statement about TIMING alone and
       cannot drift into a second copy of the fidelity oracles.
       THREE INDEPENDENT ARMS, and the split is deliberate.
       (1) The SIGNAL arm: the state must have reported ready exactly once.
       Without it the whole check failed open on a handler that stopped
       signalling, and it was blind to a handler that signalled twice - which
       makes main.js call printToPDF twice.
       (2) The CAUSE arm: no animation that the print stylesheet actually
       paints may be running at that instant. This is the real invariant and
       it does not depend on when the sample lands.
       (3) The SYMPTOM arm: no sampled colour may differ from its settled
       value. This one DOES depend on the probe's IPC latency - it can only
       see a transition that has already moved - which is why the latency is
       measured and printed rather than assumed, and why arm (2) exists. */
    const readyDiffs = [];
    let worstLatency = 0;
    for (const label of printedStates) {
      const atReady = printAtReady[label];
      if (!atReady) {
        readyDiffs.push(`${label}: never measured at the ready signal`);
        continue;
      }
      worstLatency = Math.max(worstLatency, atReady.latencyMs);
      if (!atReady.ok) {
        readyDiffs.push(`${label}: never reported ready, so nothing was measured at it`);
        continue;
      }
      if (atReady.signals !== 1) {
        readyDiffs.push(
          `${label}: ${atReady.signals} pdf-export-ready signal(s), so printToPDF would run ${atReady.signals} time(s)`,
        );
      }
      if (atReady.probe.runningVisible.length) {
        readyDiffs.push(
          `${label} still animating a printed surface: ${atReady.probe.runningVisible.slice(0, 3).join(", ")}`,
        );
      }
      if (atReady.probe.residue !== printPrepared[label].residue) {
        readyDiffs.push(
          `${label} residue: atReady=${atReady.probe.residue} settled=${printPrepared[label].residue}`,
        );
      }
      for (const sel of measuredSels) {
        if (atReady.probe.cells[sel] !== printPrepared[label].cells[sel]) {
          readyDiffs.push(
            `${label} ${sel}: atReady=${atReady.probe.cells[sel]} settled=${printPrepared[label].cells[sel]}`,
          );
        }
      }
    }
    /* THE EXCLUSION MUST NOT BE ABLE TO SWALLOW THE ASSERTION. The probe now
       drops animations whose target the print stylesheet hides, which is
       correct but is also a filter standing between a real defect and a green
       run: derive a selector list that happens to match everything (a stray
       `*`, or a rule set gaining `display:none` on a container) and the arm
       above silently stops policing anything. So the derived list is pinned to
       its measured size and the number of animations it swallowed is printed
       on every run. */
    const printHidden = Object.values(printAtReady)
      .map((s) => s && s.probe && s.probe.printHiddenSels)
      .find((x) => Array.isArray(x)) || [];
    const swallowed = Object.entries(printAtReady)
      .map(([k, s]) => `${k}=${(s && s.probe && s.probe.runningPrintHidden) || 0}`)
      .join(" ");
    console.log(
      `  note  print-hidden selectors derived: ${printHidden.length}; running animations excluded per state: ${swallowed}`,
    );
    const PRINT_HIDDEN_SELS = 5;
    check(
      "10i: the print-hidden exclusion is derived from the print stylesheet and is the pinned measured size",
      printHidden.length === PRINT_HIDDEN_SELS &&
        !printHidden.some((s) => /^\s*\*\s*$/.test(s)),
      `derived ${printHidden.length} display:none selector(s) from @media print (pinned ${PRINT_HIDDEN_SELS}): ${printHidden.join(", ")} - this list is what the settle probe is allowed to ignore, so it growing unexpectedly is how that assertion goes quiet`,
    );
    const OVERLAY_BTNS = [".code-copy-btn", ".mermaid-maximize-btn", ".table-maximize-btn"];
    const overlayUnhidden = OVERLAY_BTNS.filter(
      (sel) => !printHidden.some((h) => h.split(",").some((p) => p.trim() === sel)),
    );
    check(
      "10i: the in-content overlay buttons are hidden in print, so a hovered copy or maximise button cannot print over the content",
      overlayUnhidden.length === 0,
      `${overlayUnhidden.join(", ") || "none"} still printable - each rests at opacity 0 and fades in on hover, so it is absent from a PDF only until something hovers it, and each is positioned ON TOP of content that does print`,
    );
    check(
      "10i: the page is already settled the instant the export reports ready, so printToPDF cannot capture a half-finished transition",
      readyDiffs.length === 0 &&
        printedStates.length === PRINT_STATES.length &&
        Object.keys(printAtReady).length === PRINT_STATES.length,
      `${Object.keys(printAtReady).length}/${PRINT_STATES.length} states, worst probe latency ` +
        `${worstLatency}ms; ${readyDiffs.slice(0, 5).join(" | ")}`,
    );
    /* THE ARM ABOVE THAT COMPARES COLOURS IS ONLY AS SHARP AS THIS NUMBER.
       The reading is taken one IPC round trip after the signal, so if that trip
       ever grew past the length of a transition the comparison would sample a
       settled page and report success for a page that had been in flight -
       vacuous, and indistinguishable from a real pass. Measured rather than
       assumed, printed on every run, and floored here so the assumption cannot
       rot silently. The ceiling is deliberately generous against the measured
       value: this is a guard against the assumption collapsing, not a
       performance budget, and a tight bound would false-fail on a loaded
       machine. R375's 0.5s transition delay sits above it by design, so that
       revert stays valid for any latency this assertion permits. */
    check(
      "10i: the ready-moment reading is taken close enough to the signal to still be a reading of that moment",
      worstLatency > 0 && worstLatency < 400,
      `worst probe latency after pdf-export-ready: ${worstLatency}ms (ceiling 400ms)`,
    );

    /* POSITIVE CONTROL FOR THE PARK, and the reason the assertion above is not
       a tautology. It measures the SAME six states under the SAME print media
       with the export preparation NOT run, and requires them to disagree - so
       the invariance above is demonstrably produced by the park rather than by
       the stylesheet.
       IF THIS EVER FAILS, the print CSS has been widened to neutralise schemes
       and tokens on its own. That is an improvement, not a regression: check
       that the park is still wanted, then retire this control deliberately.
       It must not be "fixed" by loosening it.
       THE BAR IS THE RELATIONSHIP, NOT A THRESHOLD. It used to read `>= 3` of
       5, a number with nothing behind it, which would have gone on passing
       after the print stylesheet quietly neutralised two of the four schemes.
       What the comment above actually claims is that the stylesheet neutralises
       NONE of them, so every non-reference state must differ - and that is what
       is asserted, with no room left between the claim and the check. */
    const rawRef = printRaw["default-light"] ? printRaw["default-light"].cells : {};
    const rawDiffering = printedStates.filter(
      (label) =>
        label !== "default-light" &&
        measuredSels.some((sel) => printRaw[label].cells[sel] !== rawRef[sel]),
    );
    check(
      "10i: the print stylesheet alone does not neutralise a scheme, so the export park is load-bearing (control)",
      printedStates.length === PRINT_STATES.length &&
        rawDiffering.length === printedStates.length - 1,
      `${rawDiffering.length} of ${printedStates.length - 1} states printed differently without the export preparation (${rawDiffering.join(",")}) - see the note above before changing this`,
    );

    /* THE MERMAID BOUNDARY. custom-theme.js:69-74 records in prose that mermaid
       is binary - two fixed palettes chosen by a boolean - which is why a
       same-mode scheme switch never re-themes a diagram and why there is no
       mixed-theme bug. This turns that prose into a measurement: the config is
       captured under all six theme states and must not move. */
    const cfgRef = mermaidCfg["default-light"];
    const cfgDrift = Object.keys(mermaidCfg).filter((k) => mermaidCfg[k] !== cfgRef);
    check(
      "10i: mermaid's configuration is decided by the mode alone, never by the scheme",
      cfgDrift.length === 0 && Object.keys(mermaidCfg).length === PRINT_STATES.length,
      `configuration moved under: ${cfgDrift.join(",")}`,
    );
    const cfgPair = JSON.parse(cfgRef || '{"dark":1,"light":1}');
    check(
      "10i: mermaid really does distinguish the two modes (positive control)",
      JSON.stringify(cfgPair.dark) !== JSON.stringify(cfgPair.light),
      "if the two modes produce the same config, the invariance above is satisfied by a function that discriminates nothing",
    );

    /* WHAT THE PRODUCT ACTUALLY HANDS TO MERMAID, which is a strictly different
       claim from the two above. Those call getMermaidConfig(true)/(false) with
       booleans THIS FILE supplies, so between them they establish only that a
       PURE FUNCTION is deterministic and discriminates on its argument. A
       mermaid that became scheme-aware through its own initialisation path - a
       call site keyed on data-theme, or a getMermaidConfig() that started
       consulting the scheme rather than its parameter - satisfies both of them
       while drawing six visibly different diagrams.

       The product has exactly TWO initialisation sites, and they take the
       boolean from different places, so both are covered here:
         renderer.js:102   ensureMermaid()'s onload  -> mermaidDesiredDark
         renderer.js:1751  applyMermaidTheme(isDark) -> its own parameter,
                           reached from the #darkModeToggle handler, which
                           reads the boolean off document.body's class list.

       MERMAID IS LAZY (PERF-03) AND THE THEME FIXTURE CONTAINS NO DIAGRAMS, so
       window.mermaid does not exist by default and BOTH sites are unreachable -
       measured: a first attempt at this captured 0 calls across all six states
       and read exactly like a product that never themes its diagrams. The
       bundle is therefore loaded through the product's OWN loader first. */
    const mermaidLoaded = await exec(`(async () => {
      try { await ensureMermaid(); } catch (e) { return 'failed: ' + e.message; }
      return typeof window.mermaid === 'object' && typeof window.mermaid.initialize === 'function'
        ? 'ok' : 'absent';
    })()`);
    check(
      "10i: the mermaid bundle really loaded, so its initialisation path is reachable at all (control)",
      mermaidLoaded === "ok",
      `ensureMermaid() left window.mermaid as: ${mermaidLoaded} - without it the capture below is vacuous`,
    );

    const mermaidReal = {};
    await exec(`(() => {
      window.__foliaMermaidCalls = [];
      window.__foliaMermaidWrapped = window.mermaid.initialize;
      window.mermaid.initialize = function (cfg) {
        window.__foliaMermaidCalls.push(JSON.stringify(cfg));
        return window.__foliaMermaidWrapped.apply(this, arguments);
      };
      return 1;
    })()`);
    try {
      for (const [mode, scheme, label] of PRINT_STATES) {
        /* Entered from the OPPOSITE mode on purpose. applyTheme() delegates to
           #darkModeToggle only `if (wantDark !== isDark)` (custom-theme.js:132),
           which is correct product behaviour - a same-mode scheme switch has
           nothing to tell a binary palette - but it means a straight walk down
           PRINT_STATES produces one initialise call in six. Forcing a genuine
           mode change per state makes every state exercise the re-theme site
           rather than inheriting the previous state's configuration. */
        await applySettled(mode === "dark" ? "light" : "dark", null, `10i mermaid pre-${label}`);
        await exec(`(() => { window.__foliaMermaidCalls = []; return 1; })()`);
        await applySettled(mode, scheme, `10i mermaid ${label}`);
        await exec(`(async () => { await whenMermaidSettled(); return 1; })()`);
        mermaidReal[label] = JSON.parse(
          await exec(`JSON.stringify({
            calls: window.__foliaMermaidCalls,
            /* The load-time site's argument, read as that site itself spells
               it - so a state that legitimately makes no re-theme call is
               still covered on the axis that decides the NEXT document. */
            onLoad: JSON.stringify(getMermaidConfig(mermaidDesiredDark)),
          })`),
        );
      }
    } finally {
      await exec(`(() => {
        if (window.__foliaMermaidWrapped) {
          window.mermaid.initialize = window.__foliaMermaidWrapped;
          delete window.__foliaMermaidWrapped;
        }
        delete window.__foliaMermaidCalls;
        return 1;
      })()`);
    }
    const wantByMode = {
      light: JSON.stringify(cfgPair.light),
      dark: JSON.stringify(cfgPair.dark),
    };
    const realMisses = [];
    let realCalls = 0;
    for (const [mode, , label] of PRINT_STATES) {
      const rec = mermaidReal[label] || { calls: [], onLoad: null };
      realCalls += rec.calls.length;
      if (!rec.calls.length) {
        realMisses.push(`${label}: a real mode change produced no initialise call`);
      }
      const wrong = rec.calls.filter((c) => c !== wantByMode[mode]);
      if (wrong.length) {
        realMisses.push(
          `${label}: ${wrong.length}/${rec.calls.length} re-theme call(s) did not match getMermaidConfig(${mode === "dark"})`,
        );
      }
      if (rec.onLoad !== wantByMode[mode]) {
        realMisses.push(`${label}: the load-time site would initialise with the other mode's palette`);
      }
    }
    check(
      "10i: the configuration the product really hands to mermaid.initialize is chosen by the mode alone",
      realMisses.length === 0 && realCalls >= PRINT_STATES.length,
      `${realCalls} initialise call(s) captured across ${PRINT_STATES.length} states: ${realMisses.slice(0, 4).join(" | ")}`,
    );

    /* THE POPUP BOUNDARY. Every popup is a separate BrowserWindow whose CSS is
       built in the MAIN process from a literal hex table selected by an
       isDarkMode boolean (main.js:1289 mermaid, :1653 image, :1962 table), so
       no scheme can reach one.

       THE MARKER SWEEP BELOW IS THE WEAKER HALF AND IT IS KEPT AS A SECOND
       LAYER, NOT AS THE CLAIM. It looks for scheme ids and `data-theme` in
       main.js text, so a scheme forwarded under a NEUTRAL key - `theme`,
       `palette`, `accent` - and consumed there under that name trips nothing:
       the main process would carry the scheme without ever spelling one.
       The leak can only originate in the renderer, at the five
       `ipcRenderer.send('open-*-popup', {...})` sites, so that is where the
       boundary is now asserted: the PAYLOAD'S OWN KEY SET, parsed out of the
       real object literals rather than matched against a marker list. A key
       named anything at all fails, which is exactly the case a marker list
       cannot express. */
    const rendererSrc = fs.readFileSync(
      path.join(__dirname, "..", "src", "renderer.js"),
      "utf8",
    );
    const POPUP_CHANNELS = ["open-mermaid-popup", "open-image-popup", "open-table-popup"];
    const POPUP_METHODS = {
      "open-mermaid-popup": "openMermaidPopup",
      "open-image-popup": "openImagePopup",
      "open-table-popup": "openTablePopup",
    };
    /* THE ONLY KEYS A POPUP PAYLOAD MAY CARRY. `isDarkMode` is the whole theme
       surface - a boolean - and everything else is document content. Frozen
       deliberately per channel rather than as one union, so a key legitimate on
       one surface cannot silently appear on another. */
    const POPUP_PAYLOAD_KEYS = {
      "open-mermaid-popup": ["svgContent", "isDarkMode"],
      "open-image-popup": ["src", "alt", "isDarkMode"],
      "open-table-popup": ["tableData", "isDarkMode"],
    };
    /* Reads the top-level keys of the object literal that follows a send call.
       Brace-matched rather than regex-scanned so a nested object (tableData is
       built by a call, but a future payload may not be) cannot contribute its
       own keys and read as a leak, and so a `}` inside a string cannot end the
       literal early. */
    const popupSites = [];
    for (const channel of POPUP_CHANNELS) {
      const needle = "window.folia." + POPUP_METHODS[channel] + "(";
      let at = rendererSrc.indexOf(needle);
      while (at !== -1) {
        const open = rendererSrc.indexOf("{", at);
        if (open === -1 || rendererSrc.slice(at + needle.length, open).trim() !== "") {
          popupSites.push({ channel, keys: null, why: "no object literal argument" });
        } else {
          let depth = 0;
          let end = -1;
          let quote = "";
          for (let i = open; i < rendererSrc.length; i++) {
            const ch = rendererSrc[i];
            if (quote) {
              if (ch === "\\") i++;
              else if (ch === quote) quote = "";
              continue;
            }
            if (ch === '"' || ch === "'" || ch === "`") {
              quote = ch;
              continue;
            }
            if (ch === "{" || ch === "[" || ch === "(") depth++;
            else if (ch === "}" || ch === "]" || ch === ")") {
              depth--;
              if (depth === 0) {
                end = i;
                break;
              }
            }
          }
          const body = end === -1 ? "" : rendererSrc.slice(open + 1, end);
          // Split on commas at depth 0 only, then take the identifier before
          // the colon - or the whole fragment, for shorthand properties.
          const keys = [];
          const frags = [];
          let depth2 = 0;
          let quote2 = "";
          let piece = "";
          const flush = () => {
            const frag = piece.trim();
            piece = "";
            if (!frag) return;
            const colon = frag.indexOf(":");
            keys.push((colon === -1 ? frag : frag.slice(0, colon)).trim());
            frags.push(frag);
          };
          for (let i = 0; i < body.length; i++) {
            const ch = body[i];
            if (quote2) {
              piece += ch;
              if (ch === "\\") piece += body[++i];
              else if (ch === quote2) quote2 = "";
              continue;
            }
            if (ch === '"' || ch === "'" || ch === "`") quote2 = ch;
            if (ch === "{" || ch === "[" || ch === "(") depth2++;
            else if (ch === "}" || ch === "]" || ch === ")") depth2--;
            if (ch === "," && depth2 === 0) {
              flush();
              continue;
            }
            piece += ch;
          }
          flush();
          /* THE VALUE, NOT JUST THE KEY. Everything above this point reduces a
             payload to its key NAMES, which is exactly enough to miss the
             likeliest scheme leak of all: the key stays `isDarkMode` and its
             VALUE learns about the scheme, e.g. `isDarkMode || dataset.theme
             === "ember"`. Two of the five sites spell the boolean as a
             shorthand backed by a local const on the preceding line, so the
             expression is not inside the literal at all and has to be resolved
             backwards from the send site before it can be compared. */
          let darkExpr = null;
          const darkFrag = frags.find((f) => /^isDarkMode\b/.test(f));
          if (darkFrag) {
            const colon = darkFrag.indexOf(":");
            if (colon !== -1) darkExpr = darkFrag.slice(colon + 1).trim();
            else {
              const back = rendererSrc.slice(Math.max(0, at - 600), at);
              const decl = /(?:const|let|var)\s+isDarkMode\s*=\s*([^;]+);/g;
              let d;
              let last = null;
              while ((d = decl.exec(back)) !== null) last = d[1];
              darkExpr = last === null ? null : last.trim();
            }
          }
          /* EXACTLY ONE PAYLOAD ARGUMENT. The key sweep reads the
             first object literal and stops, so a second argument carrying the
             scheme would be neither parsed nor sent through any assertion -
             and the runtime probe records args[0] alone, so it could not see
             one either. */
          let tail = "";
          if (end !== -1) {
            const rest = rendererSrc.slice(end + 1);
            const m = rest.match(/^\s*(.)/);
            tail = m ? m[1] : "";
          }
          popupSites.push({
            channel,
            keys,
            raw: body,
            darkExpr,
            singleArg: tail === ")",
            why: end === -1 ? "unterminated literal" : "",
          });
        }
        at = rendererSrc.indexOf(needle, at + needle.length);
      }
    }
    const popupKeyLeaks = popupSites.filter(
      (s) =>
        !s.keys ||
        s.keys.length === 0 ||
        s.keys.some((k) => !POPUP_PAYLOAD_KEYS[s.channel].includes(k)),
    );
    /* THE POSITIVE CONTROL. The parse walks source text, so a renamed channel,
       a reformat that puts the literal on the next argument, or a broken
       brace-matcher all yield an EMPTY subject set - and an empty set has no
       leaks. Every channel must have been found and every site parsed, or
       "no leaks" is describing nothing.

       THE COUNTS ARE MEASURED, NOT A FLOOR. A `>= 5` bar stood here and 5 was
       a number with nothing behind it: it happened to equal the real total, so
       it read like a measurement while being unable to notice a site
       DISAPPEARING as long as another appeared. The per-channel counts below
       were read off the source (renderer.js: mermaid at 4545 and 7988, table
       at 4891 and 8069, image at 5193 - the context-menu path and the
       maximise-button path for each surface that has both). An added site is a
       new payload literal that nobody has looked at, and a removed one silently
       narrows every leak claim below; both must be a decision. */
    const POPUP_SITE_COUNTS = {
      "open-mermaid-popup": 2,
      "open-image-popup": 1,
      "open-table-popup": 2,
    };
    const siteCountFaults = POPUP_CHANNELS.filter(
      (c) => popupSites.filter((s) => s.channel === c && s.keys).length !== POPUP_SITE_COUNTS[c],
    ).map(
      (c) =>
        `${c}: ${popupSites.filter((s) => s.channel === c && s.keys).length} parsed, expected ${
          POPUP_SITE_COUNTS[c]
        }`,
    );
    check(
      "10i: every popup-open payload in the renderer was really parsed (positive control)",
      siteCountFaults.length === 0 && popupSites.every((s) => s.keys),
      `${popupSites.length} send site(s): ${popupSites
        .map((s) => `${s.channel}[${s.keys ? s.keys.join("+") : s.why}]`)
        .join(" ")}${siteCountFaults.length ? " | " + siteCountFaults.join(" | ") : ""}`,
    );
    check(
      "10i: no popup-open payload carries anything but its content and the mode boolean",
      popupKeyLeaks.length === 0,
      `${popupKeyLeaks
        .map((s) => `${s.channel} sends {${s.keys ? s.keys.join(", ") : s.why}}`)
        .join(" | ")} - a popup is themed by a boolean in the main process, so a scheme reaching one moves a recorded scope boundary and needs a decision, not a passing test`,
    );

    /* AND THE SAME CLAIM AT RUNTIME, because the parse above reads what is
       WRITTEN and this reads what is SENT. Driven through the real
       .table-maximize-btn on the real rendered table, with ipcRenderer.send
       intercepted and swallowed so no BrowserWindow is opened. The table is the
       only popup surface the census fixture reaches - it has no diagram and no
       image - which is why the structural half above exists to cover the other
       four sites. */
    const popupSent = {};
    let popupProbeErr = "";
    try {
      await exec(`(() => {
        const { ipcRenderer } = require('electron');
        window.__popupSends = [];
        /* THE RAW METHOD, not a bound copy. Restoring a bound wrapper would
           leave ipcRenderer.send a DIFFERENT function object than the one this
           probe found, which is invisible today and breaks the moment anything
           compares the method by identity. */
        window.__popupRealSend = ipcRenderer.send;
        const realSend = window.__popupRealSend;
        ipcRenderer.send = (channel, ...args) => {
          if (typeof channel === 'string' && /^open-.*-popup$/.test(channel)) {
            window.__popupSends.push([channel, args[0]]);
            return;
          }
          return realSend.call(ipcRenderer, channel, ...args);
        };
        return 'ok';
      })()`);
      for (const [mode, scheme, label] of PRINT_STATES) {
        await applySettled(mode, scheme, `10i popup ${label}`);
        popupSent[label] = JSON.parse(
          await exec(`(() => {
            window.__popupSends.length = 0;
            const btn = document.querySelector('.table-maximize-btn');
            if (btn) btn.click();
            const [channel, payload] = window.__popupSends[0] || [null, null];
            return JSON.stringify({
              clicked: !!btn,
              channel,
              keys: payload ? Object.keys(payload).sort() : null,
              isDarkMode: payload ? payload.isDarkMode : null,
              /* SPELLED OUT RATHER THAN LEFT TO JSON.stringify's undefined
                 BEHAVIOUR. NOTE FOR EDITORS: this comment lives inside an
                 exec() template literal, so it must never contain a backtick.
                 JSON.stringify(undefined) returns the VALUE undefined, not a
                 string, so a payload that had lost its tableData entirely
                 produced 'content: undefined', which the outer stringify then
                 DROPPED from the object - and every state read back
                 identically absent, so "the content is the same in every
                 scheme" passed on a payload carrying no content at all. An
                 empty string is a value the assertion below can see. */
              content:
                payload && payload.tableData !== undefined
                  ? JSON.stringify(payload.tableData)
                  : '',
              bodyDark: document.body.classList.contains('dark-mode'),
              scheme: document.body.getAttribute('data-theme') || '',
            });
          })()`),
        );
      }
    } catch (e) {
      popupProbeErr = String((e && e.message) || e);
    } finally {
      await exec(`(() => {
        const { ipcRenderer } = require('electron');
        if (window.__popupRealSend) ipcRenderer.send = window.__popupRealSend;
        delete window.__popupRealSend;
        delete window.__popupSends;
        return 'ok';
      })()`).catch(() => {});
    }
    const popupStates = Object.keys(popupSent);
    const popupContents = new Set(popupStates.map((l) => popupSent[l].content));
    /* THE CONTENT MUST BE REAL BEFORE "IDENTICAL" MEANS ANYTHING. A set of one
       is satisfied just as well by six states that all sent nothing, so the
       sameness claim needs a subject: the payload has to carry a JSON object
       with at least one non-empty quoted cell in it. Measured on the census
       fixture's table, this is a few hundred characters; the floor is
       deliberately loose because what is being defended is "there is content",
       not its size. */
    const popupEmpty = popupStates.filter(
      (l) =>
        typeof popupSent[l].content !== "string" ||
        popupSent[l].content.length < 10 ||
        !/"[^"]+"/.test(popupSent[l].content),
    );
    const popupRuntimeMisses = popupStates.filter((l) => {
      const p = popupSent[l];
      return (
        !p.clicked ||
        p.channel !== "open-table-popup" ||
        !p.keys ||
        p.keys.join(",") !== POPUP_PAYLOAD_KEYS["open-table-popup"].slice().sort().join(",") ||
        p.isDarkMode !== p.bodyDark
      );
    });
    check(
      "10i: the payload a popup really receives is the same in every scheme but for the mode boolean",
      !popupProbeErr &&
        popupStates.length === PRINT_STATES.length &&
        popupRuntimeMisses.length === 0 &&
        popupEmpty.length === 0 &&
        popupContents.size === 1,
      `${popupProbeErr || ""}${popupStates.length}/${PRINT_STATES.length} states; ${
        popupContents.size
      } distinct payload content(s)${
        popupEmpty.length ? `; ${popupEmpty.length} state(s) sent no table content: ${popupEmpty.join(", ")}` : ""
      }; misses: ${
        popupRuntimeMisses
          .map((l) => `${l}=${JSON.stringify(popupSent[l])}`)
          .slice(0, 2)
          .join(" | ") || "none"
      }`,
    );

    const mainSrc = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
    const NON_BASE_IDS = ["clarity", "parchment", "abyss", "ember"];
    /* COMMENTS ARE REMOVED BEFORE THE SWEEP, AND THE IDS ARE MATCHED AS WORDS.
       Two shapes were tried here and each fails in the opposite direction:
         - a BARE substring test (what shipped) reports a leak for the word
           `Remember` in prose, because `ember` sits inside it;
         - a QUOTED-LITERAL test cannot see the leak that actually matters,
           because a popup handler builds its CSS as a TEMPLATE LITERAL, where
           `body[data-theme=ember]` carries no quotes around the id at all.
       Stripping comments removes the entire prose false-positive class at its
       source, after which a word-boundary match is both broad and quiet: the
       boundary rejects `Remember` (the preceding `m` is a word character)
       while accepting `data-theme=ember` and `.scheme-ember`. Both halves are
       planted and measured below rather than argued.

       The stripper treats a backtick as an ordinary quote and does NOT descend
       into an interpolation, so code inside one is scanned as if it were string
       content - which can only ever ADD subjects, never remove them. */
    /* THE STRIPPER IS SHARED, NOT COPIED. test/test-packaging.js needs the
       identical scanner for the Tabulator option oracle, and this file's own
       plan records what a second copy costs: post-upstream-merge.sh checked
       five overlay files twice with two different matchers, and the duplicate
       reported all five as MISSING while its twin passed. The regex-literal
       state below (the B6 fix) is exactly the kind of subtlety that would be
       repaired in one copy and not the other.
       See test/test-source-utils.js for the implementation and its rationale. */
    const schemeMentions = (text) => {
      const code = stripJsComments(text);
      const hits = [];
      for (const id of NON_BASE_IDS) {
        if (new RegExp("\\b" + id + "\\b").test(code)) hits.push(id);
      }
      for (const marker of ["data-theme", "--syn-", "--tok-"]) {
        if (code.includes(marker)) hits.push(marker);
      }
      return hits;
    };
    /* THE PLANTED CONTROL. The sweep's whole value is that it finds nothing,
       and a matcher that has stopped matching also finds nothing - the recorded
       "an absence check fails open" disease. Each fragment below states one
       half of the claim, and a wrong answer on any of them means the real
       sweep's silence describes the matcher rather than main.js.

       THE ID PLANTS DELIBERATELY SPELL NO MARKER. A fragment written as
       `body[data-theme=ember]` is caught by the `data-theme` marker whatever
       the id matcher does, so it cannot isolate the id path - measured, and it
       is why R362 first bit on only one plant. The two paths are planted
       separately. */
    const SWEEP_PLANTS = [
      ["unquoted id in a template literal", "const css = `body.theme-ember h1 { color: red }`;", true],
      ["hyphenated id in a string", 'el.className = "scheme-abyss";', true],
      ["quoted id", "if (name === 'parchment') return 1;", true],
      ["marker in a template literal", "const css = `body[data-theme=x] { color: red }`;", true],
      ["token variable", "const c = `var(--tok-keyword)`;", true],
      ["prose in a line comment", "// Remember to keep this in sync with the renderer.\n", false],
      ["prose in a block comment", "/* Kept separate for clarity, not for speed. */", false],
      ["an unrelated word", "const remembered = memberOf(list);", false],
      ["a themeless string", 'const s = "no scheme is named here";', false],
      /* THE REGEX-LITERAL PLANT. Without regex state the quote inside /"/g
         opens phantom string mode, the trailing line comment is never
         recognised as one, and its prose "ember" is reported as a leak. This
         plant fails on the old stripper and passes on the fixed one, which is
         what makes the fix a measurement rather than a claim. */
      [
        "a regex literal holding a quote does not desync the scanner",
        'x.replace(/"/g, "&q;");\n// this comment names ember and must be stripped\n',
        false,
      ],
      /* AND THE OTHER DIRECTION, which is the dangerous one: a // inside a
         STRING must survive, because a stripper that eats it deletes real code
         from the sweep's view and fails open. */
      ["a protocol-relative path in a string", 'const u = "//host/share/ember.css";', true],
      /* THE TWO INTERPOLATION PLANTS, and they exist because the two review
         models DISAGREED about them: one held that `${...}` hides a scheme
         reference from the sweep, the other traced the scanner and called it
         sound. Neither reading is worth carrying as an opinion, so both
         directions are planted and the suite decides on every run.

         The first is the CLAIM ITSELF. A backtick is a quote character here,
         so an interpolation's contents are scanned as string content - but
         every character is still EMITTED, so a scheme id inside `${}` remains
         visible to the id matcher. If that ever stops being true this plant
         goes clean and the sweep has a blind spot the size of every template
         in the file.

         The second is the failure that would actually matter: a nested
         template toggles the quote state twice, and an ODD number of toggles
         would leave the scanner desynchronised and start eating real code as
         comments. Balanced nesting must come back in sync, which is what the
         trailing comment measures - it can only be stripped if the scanner is
         back in code state at the end of the statement. */
      [
        "a scheme id inside a template interpolation is still visible",
        "const css = `body{color:${'ember'}}`;",
        true,
      ],
      [
        "a nested template inside an interpolation leaves the scanner in sync",
        "const s = `a${b ? `c` : d}e`;\n// this comment names abyss and must be stripped\n",
        false,
      ],
    ];
    const plantFaults = SWEEP_PLANTS.filter(
      ([, frag, wantCaught]) => schemeMentions(frag).length > 0 !== wantCaught,
    ).map(([name, , wantCaught]) => `${name}: expected ${wantCaught ? "caught" : "clean"}`);
    check(
      "10i: the scheme-leak sweep catches an unquoted id and ignores the same letters in prose (control)",
      plantFaults.length === 0 && SWEEP_PLANTS.length === 13,
      `${SWEEP_PLANTS.length} plants, ${plantFaults.length} wrong: ${
        plantFaults.join(" | ") || "none"
      }`,
    );
    /* THE LAZY-LOAD SITE'S ARGUMENT, which no runtime capture in this suite can
       reach. renderer.js:102 runs once inside ensureMermaid()'s onload, before
       any spy in section 10i exists and with no way to re-drive it: both
       `window.mermaid` and `mermaidLoadPromise` latch, and the latter is module
       scope, so the load path cannot be replayed from a probe. The runtime
       assertion therefore evaluates the site's own expression -
       getMermaidConfig(mermaidDesiredDark) - after every state, which pins the
       VALUE that expression yields but not the expression itself: rewrite :102
       to getMermaidConfig(false) and the recomputation is unchanged and green.
       R339 covers the other half (the recording), so what is left unguarded is
       exactly the argument text, and text is what this reads.
       BOTH sites are pinned as a set rather than the load site alone: a fix
       that pinned one and left the other addressable by index would move on the
       next edit that adds an initialise call. */
    const initArgs = [];
    /* SCANNED WITH COMMENTS STRIPPED, and that is not incidental: renderer.js
       has a comment at :3127 that spells mermaid.initialize() while explaining
       what the recording is for. Reading raw text found three sites and the
       third had an empty argument list - a measurement of prose.
       THE COUNT IS A CONTROL THAT A STRIP HAPPENED, NOT THAT IT WAS CORRECT,
       and the distinction was measured rather than assumed: raw source reads 3
       here and both a healthy stripper and the desynchronising one proposed in
       review read 2, because that particular line's fate depends on backtick
       parity at its offset rather than on the scanner being sound. The
       assertion that the strip was CORRECT is the surviving-comment sweep
       directly below. */
    const rendererCode = stripJsComments(rendererSrc);
    const INIT_RE = /mermaid\.initialize\(/g;
    let initM;
    while ((initM = INIT_RE.exec(rendererCode)) !== null) {
      const open = INIT_RE.lastIndex - 1;
      let depth = 0;
      let endI = -1;
      let q = "";
      for (let i = open; i < rendererCode.length; i++) {
        const ch = rendererCode[i];
        if (q) {
          if (ch === "\\") i++;
          else if (ch === q) q = "";
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") {
          q = ch;
          continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") {
          depth--;
          if (depth === 0) {
            endI = i;
            break;
          }
        }
      }
      initArgs.push(endI === -1 ? "<unterminated>" : rendererCode.slice(open + 1, endI).trim());
    }
    const MERMAID_INIT_ARGS = ["getMermaidConfig(mermaidDesiredDark)", "getMermaidConfig(isDark)"];
    const initFaults = initArgs
      .filter((a) => !MERMAID_INIT_ARGS.includes(a.replace(/\s+/g, " ").trim()))
      .map((a) => a.replace(/\s+/g, " ").slice(0, 90));
    check(
      "10i: both mermaid.initialize sites pass a palette chosen by a plain mode flag, spelled that way in the source",
      initArgs.length === 2 &&
        initFaults.length === 0 &&
        new Set(initArgs.map((a) => a.replace(/\s+/g, " ").trim())).size === 2,
      `${initArgs.length} initialise site(s) (expected 2): ${initArgs
        .map((a) => a.replace(/\s+/g, " ").slice(0, 60))
        .join(" | ")}${
        initFaults.length ? ` - unexpected argument(s): ${initFaults.join(" | ")}` : ""
      }`,
    );
    /* THE SHIPPED-SOURCE WITNESS, AND IT REPLACES ONE THAT ROTTED.
       R384 - the review-proposed "re-enter code mode at ${" change - used to be
       caught twice: by the plant table above, and by the initialise sweep
       reporting a phantom THIRD site because the desync left the commented-out
       call at renderer.js:3127 standing. That second witness has RETIRED. It
       was never a property of the transform; it was a property of the backtick
       parity at one offset, and ordinary edits to renderer.js moved it. Under
       the broken stripper that site now strips correctly by luck, so the
       initialise sweep reads 2 and passes while the transform is as harmful as
       it ever was.

       THIS is the stable form of the same claim, and the difference is that it
       is AGGREGATE. A desync that begins at the first interpolated template
       (measured: renderer.js line 339) mis-scans roughly every other region
       thereafter, so it cannot hide by parity - measured, healthy 0 surviving
       against 1014 for the proposed remedy, out of 3177 raw comment lines.
       A single-site witness could go quiet on any edit; this one cannot go
       quiet without the stripper actually being correct.

       WHY renderer.js ALONE. main.js legitimately leaves 39 comment lines
       standing, and that is the stripper working as designed rather than a
       defect: they live inside the popup HTML template literal (main.js
       2152-2434), and the stripper deliberately does not descend into a
       template - a comment inside one really is string content. Asserting zero
       there would be false, and pinning 39 would pin the popup's prose.

       THE FLOOR IS A VACUITY GUARD, NOT A PIN, and it is deliberately far
       below the measured count so ordinary comment edits cannot false-fail it:
       its only job is to prove the file was read and the matcher still
       matches, because a scan that finds no subjects reports the same zero as
       a scan that finds them all stripped - the recorded "an absence check
       fails open" disease. The measured count PRINTS on every run so the
       constant is never a number nobody has looked at. */
    const COMMENT_LEAD_RE = /^[ \t]*\/\//;
    const rawCommentLines = rendererSrc.split(/\r?\n/).filter((l) => COMMENT_LEAD_RE.test(l));
    const survivingComments = rendererCode
      .split(/\r?\n/)
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => COMMENT_LEAD_RE.test(line));
    check(
      "10i: the shared comment stripper leaves no line comment standing in renderer.js (the scanner never desynchronises)",
      rawCommentLines.length >= 100 && survivingComments.length === 0,
      `${rawCommentLines.length} raw comment line(s) (floor 100), ${
        survivingComments.length
      } surviving${
        survivingComments.length
          ? `: ${survivingComments
              .slice(0, 3)
              .map(([n, l]) => `${n}:${l.trim().slice(0, 50)}`)
              .join(" | ")}`
          : ""
      }`,
    );

    const schemeLeaks = schemeMentions(mainSrc);
    /* THE POPUP PAYLOADS, BY VALUE. The two checks near the parse reduce each
       payload to its key NAMES, and the runtime probe below drives exactly one
       of the five send sites (the census fixture has a table but no diagram and
       no image). Between them they leave the likeliest leak of all uncovered:
       the key stays `isDarkMode` and its VALUE learns about the scheme. Written
       out, the attack is `isDarkMode: isDarkMode || dataset.theme === "ember"` -
       an allowed key, an untouched key set, and at a site no click reaches.
       Placed here rather than beside the parse because it reuses schemeMentions,
       whose planted control sits directly above: the matcher this depends on is
       proven before it is trusted. */
    const MODE_EXPR = "document.body.classList.contains('dark-mode')";
    const norm = (s) => (s || "").replace(/\s+/g, "").replace(/"/g, "'");
    const popupValueFaults = [];
    for (const s of popupSites) {
      if (!s.keys) continue;
      if (s.darkExpr === null || s.darkExpr === undefined) {
        popupValueFaults.push(`${s.channel}: no isDarkMode value could be resolved`);
        continue;
      }
      if (norm(s.darkExpr) !== norm(MODE_EXPR)) {
        popupValueFaults.push(`${s.channel}: isDarkMode = ${s.darkExpr.trim()}`);
      }
      const leaked = schemeMentions(s.raw + ";" + s.darkExpr);
      if (leaked.length) popupValueFaults.push(`${s.channel}: payload mentions ${leaked.join("+")}`);
      if (!s.singleArg) popupValueFaults.push(`${s.channel}: send carries more than the payload`);
    }
    check(
      "10i: every popup payload derives its mode boolean from the mode alone, and carries nothing else",
      popupValueFaults.length === 0 && popupSites.filter((s) => s.keys).length === 5,
      `${popupSites.filter((s) => s.keys).length}/5 sites resolved; ${
        popupValueFaults.join(" | ") || "no faults"
      } - the key name is not the boundary, the expression behind it is`,
    );
    /* THE POSITIVE CONTROL FOR THE RESOLVER, and it is not optional: two of the
       five sites spell the boolean as a bare shorthand, so the expression lives
       on a preceding line and is found by searching BACKWARDS. A resolver that
       silently returned null for those would make the check above pass on three
       sites while reporting five, which is the same shape as every vacuity this
       suite has been bitten by. Both spellings must therefore be present. */
    const shorthandSites = popupSites.filter((s) => s.keys && !/isDarkMode\s*:/.test(s.raw));
    const inlineSites = popupSites.filter((s) => s.keys && /isDarkMode\s*:/.test(s.raw));
    check(
      "10i: the payload resolver really read both spellings of the mode boolean (control)",
      shorthandSites.length === 2 &&
        inlineSites.length === 3 &&
        shorthandSites.every((s) => s.darkExpr && s.darkExpr.includes("classList")),
      `${shorthandSites.length} shorthand site(s) (expected 2), ${inlineSites.length} inline (expected 3); shorthand resolved to: ${
        shorthandSites.map((s) => JSON.stringify(s.darkExpr)).join(", ") || "nothing"
      }`,
    );
    const popupsFound = POPUP_CHANNELS.filter((c) => mainSrc.includes('"' + c + '"'));
    /* THE POPUP HANDLERS, SLICED. `darkAware >= 20` used to stand here as the
       positive control, and 20 was a number with no relationship behind it -
       the real count is 56, so the sweep would have gone on passing after two
       of the three popup surfaces stopped being boolean-themed entirely.
       What is asserted instead is a property of EACH handler: it is bounded,
       it decides on isDarkMode, it paints literal colours, and it consumes NO
       custom property at all. That last one is the boundary itself rather than
       a proxy for it - a popup that reads a `var(--...)` is by construction
       participating in the token layer, whatever the variable is called, and it
       is the case a scheme-id marker list cannot express. Measured: 0 in all
       three handlers today. */
    const HANDLER_RE = /ipcMain\.on\(/g;
    const handlerStarts = [];
    for (let m = HANDLER_RE.exec(mainSrc); m; m = HANDLER_RE.exec(mainSrc)) {
      handlerStarts.push(m.index);
    }
    const popupHandlers = {};
    for (const c of POPUP_CHANNELS) {
      const at = mainSrc.indexOf('ipcMain.on("' + c + '"');
      if (at === -1) continue;
      const next = handlerStarts.find((i) => i > at);
      popupHandlers[c] = mainSrc.slice(at, next === undefined ? mainSrc.length : next);
    }
    const handlerFaults = [];
    for (const c of POPUP_CHANNELS) {
      const body = popupHandlers[c];
      if (!body) {
        handlerFaults.push(`${c}: no handler`);
        continue;
      }
      // Bounded: a slice running to end-of-file would swallow every later
      // handler and make the absence claims below meaningless.
      if (body.length === 0 || body.length >= mainSrc.length * 0.5) {
        handlerFaults.push(`${c}: slice ${body.length}/${mainSrc.length}`);
      }
      if (!/isDarkMode\s*\?/.test(body)) handlerFaults.push(`${c}: no isDarkMode decision`);
      if (!/#[0-9a-fA-F]{3,8}/.test(body)) handlerFaults.push(`${c}: no literal colours`);
      const vars = body.match(/var\(--[\w-]+/g) || [];
      if (vars.length) handlerFaults.push(`${c}: reads ${[...new Set(vars)].join(", ")}`);
      // Same matcher as the file-wide sweep, so the two cannot drift apart and
      // a handler is judged by exactly the rule the whole file is judged by.
      for (const marker of schemeMentions(body)) {
        handlerFaults.push(`${c}: mentions ${marker}`);
      }
    }
    check(
      "10i: every popup handler paints literal colours chosen by isDarkMode and reads no token-layer variable",
      popupsFound.length === POPUP_CHANNELS.length && handlerFaults.length === 0,
      `found ${popupsFound.length}/${POPUP_CHANNELS.length} popup channels; ${
        handlerFaults.join(" | ") || "no faults"
      }`,
    );
    check(
      "10i: the main process, which owns every popup window, knows nothing about colour schemes",
      schemeLeaks.length === 0,
      `main.js references ${schemeLeaks.join(", ")} - a popup consuming the scheme layer moves a recorded scope boundary and needs a decision, not a passing test`,
    );

    console.log(
      `  note: printed page: ${printedStates.length} states, ${measuredSels.length} surfaces; ` +
        `${rawDiffering.length} differ without the park, ${printDiffs.length} differ with it`,
    );

    // ── 10j: THE MENU, DRIVEN THE WAY A READER DRIVES IT ────────────────────
    /* EVERY OTHER ASSERTION IN THIS FILE CALLS window.foliaThemes.setScheme()
       DIRECTLY. That is the right subject for a colour claim - it is the
       shortest path to the state being measured - but it means the surface the
       user actually touches has never been exercised: the hamburger, the View
       flyout, the grace-period hover that reveals the panel, the per-row click
       listeners, the tick bookkeeping and the dismissal are all unproven. A
       scheme layer that is perfect and unreachable ships as no feature at all,
       and nothing above this line can tell the two apart.

       So this section starts at #menuBtn and ends at localStorage, touching
       nothing in between that a reader could not touch.

       REACHABILITY IS HIT-TESTED, NOT INFERRED FROM CLASSES. HTMLElement
       .click() fires the listener on a row that is zero-sized, clipped or
       buried under another panel, so a class-and-callback test would report a
       working menu for one the mouse can never land on. Each row is therefore
       resolved through document.elementFromPoint() at its own centre, and the
       probe is made two-sided by running the identical sweep with the menu
       CLOSED and requiring it to find nothing - otherwise a probe that says
       "reachable" unconditionally looks exactly like a healthy menu.
       (Known and accepted limit, same as test-visual-utils.js records:
       elementFromPoint ignores pointer-events:none, so a decorative overlay is
       invisible to it.) */
    const MENU_PATH_PROBE = `(() => {
      const out = { missing: [], steps: [], unreachable: [] };
      /* Start from a known-closed menu through the product's own dismissal
         path rather than by stripping classes by hand. */
      document.body.click();
      const ids = ['menuBtn', 'viewBtn', 'mainMenu', 'viewMenu', 'customThemeMenuItem'];
      const el = {};
      for (const id of ids) {
        el[id] = document.getElementById(id);
        if (!el[id]) out.missing.push(id);
      }
      if (out.missing.length) return JSON.stringify(out);
      /* HIT-TESTED, NOT JUST CLICKED. A bare .click() dispatches on a node
         whether or not a reader could ever reach it - a zero-size button, one
         behind an overlay, or one scrolled out of the panel all accept the
         event silently, and the step then reports the path as open. The scheme
         rows below are already hit-tested by REACH_PROBE for exactly that
         reason; the two ancestors that lead to them were not, so the very
         first two steps of "the real hamburger -> View -> Theme path" were the
         only ones not measured against the reader's ability to perform them. */
      const reach = (el, name) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) { out.unreachable.push(name + ':zero-size'); return; }
        const hit = document.elementFromPoint(
          Math.round(r.left + r.width / 2),
          Math.round(r.top + r.height / 2),
        );
        if (!hit) { out.unreachable.push(name + ':no-hit'); return; }
        if (hit !== el && !el.contains(hit)) {
          out.unreachable.push(name + ':occluded-by-' + (hit.id || hit.className || hit.tagName));
        }
      };
      reach(el.menuBtn, 'menuBtn');
      el.menuBtn.click();
      out.steps.push(['mainMenu', el.mainMenu.classList.contains('visible')]);
      reach(el.viewBtn, 'viewBtn');
      el.viewBtn.click();
      out.steps.push(['viewMenu', el.viewMenu.classList.contains('visible')]);
      reach(el.customThemeMenuItem, 'customThemeMenuItem');
      /* mouseenter does not bubble and is what custom-theme.js listens for -
         the grace-period hover, not a click. */
      el.customThemeMenuItem.dispatchEvent(new MouseEvent('mouseenter'));
      out.steps.push(['themeSubmenu', el.customThemeMenuItem.classList.contains('theme-open')]);
      return JSON.stringify(out);
    })()`;

    const REACH_PROBE = `(() => {
      const rows = Array.from(document.querySelectorAll('.custom-scheme-option'));
      const out = { total: rows.length, reachable: [], unreachable: [] };
      for (const row of rows) {
        const id = row.dataset.scheme || '?';
        const r = row.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) { out.unreachable.push(id + ':zero-size'); continue; }
        const hit = document.elementFromPoint(
          Math.round(r.left + r.width / 2),
          Math.round(r.top + r.height / 2),
        );
        if (!hit) { out.unreachable.push(id + ':no-hit'); continue; }
        if (hit === row || row.contains(hit)) out.reachable.push(id);
        else out.unreachable.push(id + ':occluded-by-' + (hit.id || hit.className || hit.tagName));
      }
      return JSON.stringify(out);
    })()`;

    const MENU_STATE_PROBE = `(() => {
      const b = document.body;
      const item = document.getElementById('customThemeMenuItem');
      return JSON.stringify({
        dataTheme: b.getAttribute('data-theme') || 'none',
        dark: b.classList.contains('dark-mode'),
        themeMode: localStorage.getItem('themeMode'),
        lightScheme: localStorage.getItem('themeLightScheme'),
        darkScheme: localStorage.getItem('themeDarkScheme'),
        modeTicked: Array.from(document.querySelectorAll('.custom-theme-option.active'))
          .map((e) => e.dataset.mode),
        schemeTicked: Array.from(document.querySelectorAll('.custom-scheme-option.active'))
          .map((e) => e.dataset.scheme),
        mainMenuOpen: document.getElementById('mainMenu').classList.contains('visible'),
        viewMenuOpen: document.getElementById('viewMenu').classList.contains('visible'),
        themeOpen: !!item && item.classList.contains('theme-open'),
      });
    })()`;

    await applySettled("light", null, "10j: start from the shipped default");

    const menuClosedReach = JSON.parse(await exec(REACH_PROBE));
    const menuPath = JSON.parse(await exec(MENU_PATH_PROBE));
    const menuOpenReach = JSON.parse(await exec(REACH_PROBE));

    check(
      "10j: the Themes submenu opens through the real hamburger -> View -> Theme path",
      menuPath.missing.length === 0 &&
        menuPath.steps.every(([, ok]) => ok) &&
        menuPath.unreachable.length === 0,
      `missing ${menuPath.missing.join(",") || "none"}; unreachable ${
        menuPath.unreachable.join(",") || "none"
      }; ${menuPath.steps.map(([k, v]) => `${k}=${v}`).join(" ")}`,
    );

    const MENU_IDS = ["default-light", "clarity", "parchment", "default-dark", "abyss", "ember"];
    check(
      "10j: every scheme in the registry has a row the mouse can actually land on",
      menuOpenReach.total === MENU_IDS.length &&
        MENU_IDS.every((id) => menuOpenReach.reachable.includes(id)),
      `${menuOpenReach.reachable.length}/${menuOpenReach.total} reachable; unreachable ${menuOpenReach.unreachable.join(", ") || "none"}`,
    );

    /* THE CONTROL THAT MAKES THE ASSERTION ABOVE MEAN SOMETHING. The rows are
       in the DOM whether or not the menu is open, so `total` must stay 6 while
       `reachable` empties - a probe reporting 0/0 would be broken, not strict. */
    check(
      "10j: no scheme row is reachable while the menu is closed (positive control)",
      menuClosedReach.total === MENU_IDS.length && menuClosedReach.reachable.length === 0,
      `${menuClosedReach.reachable.length}/${menuClosedReach.total} reachable with the menu shut: ${menuClosedReach.reachable.join(",")}`,
    );

    /* THE SUBMENU'S CHROME, WHICH THE STATE ASSERTIONS BELOW ARE STRUCTURALLY
       BLIND TO. Everything else in 10j reads CLASSES: `schemeTicked` is
       `.custom-scheme-option.active` mapped to its data-scheme, so it answers
       "did markActive() mark the right row" and nothing else. What turns that
       class into something a reader can see is a handful of CSS rules in
       custom-styles.css, and MEASURED by deleting the tick rule outright, the
       whole suite stayed green at 242/242: every row lost its checkmark, the
       menu became unreadable, and not one assertion moved.
       So this measures the RENDERED form of the same claim. R340 is that exact
       edit, kept permanently.

       LABEL ALIGNMENT IS THE STRONGER HALF, and it is why the gutter is
       checked by geometry rather than by reading any declaration. This
       assertion FAILED on its first run and named a real product defect: the
       rows inherit `justify-content: space-between` from .tools-submenu-item,
       which pushed every tick to the far left edge and every label to the far
       right, so the labels formed a 64px-ragged column and each tick sat ~140px
       from the row it marked. Both halves of the fix are load-bearing - packing
       from the start edge, and giving the ::before a WIDTH so a ticked and an
       unticked row reserve the same space - and reverting either one alone is
       enough to misalign the column, which is why R341 and R342 are separate.
       A Range over a SCHEME row's contents measures where the text really
       begins - the pseudo is not part of it - so nothing here restates a
       length. A MODE row is not the same shape: its first child is an inline
       SVG, so the same Range starts at the icon. That number is kept, named
       for the gutter it actually measures, and the mode label is read
       separately from its own text node. */
    const CHROME_PROBE = `(() => {
      const rows = Array.from(document.querySelectorAll('.custom-scheme-option'));
      const out = { rows: [], modeRows: [], captions: [], seps: [], rowFont: 0, open: false };
      /* THE PROBE'S OWN PRECONDITION, MEASURED RATHER THAN INHERITED. Every
         geometric claim below is read off getBoundingClientRect, and a closed
         submenu is display:none - so every rect collapses to zero, every label
         inset becomes exactly 0, and the alignment spread reads a perfect 0.
         A vacuous pass and a perfect result are the same number here, which is
         the one shape this project treats as unacceptable. The section leaves
         the menu open above; this records that it really was, so a future edit
         that reorders the section fails loudly instead of silently measuring
         an unpainted menu.

         THE SIZE CHECK IS THE LOAD-BEARING HALF AND 'open' ALONE WOULD NOT
         DO - measured, not assumed. R363 dismisses the menu through the
         product's own document.body.click() path and the probe still reports
         open=true: that click closes the PARENT dropdown, and nothing
         removes 'theme-open' from the item (custom-theme.js drops it only on a
         row click or the 200ms hover grace timer). So the class outlives the
         painted panel, and only the rects can tell. Both are reported so a
         failure names which half went.
         NOTE FOR EDITORS: never a backtick in here - this comment lives inside
         an exec() template literal and a backtick terminates it. */
      const host = document.getElementById('customThemeMenuItem');
      out.open = !!host && host.classList.contains('theme-open');
      for (const row of rows) {
        const cs = getComputedStyle(row, '::before');
        const rng = document.createRange();
        rng.selectNodeContents(row);
        const tr = rng.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        out.rows.push({
          id: row.dataset.scheme || '?',
          active: row.classList.contains('active'),
          /* An absent ::before computes content as 'none'; an empty one as a
             pair of quote characters. Both are "paints no glyph", and they are
             kept distinct in the report so a failure names which happened. */
          content: cs.content,
          /* THE GUTTER BOX'S OWN display. An inline-block display was
             declared on this rule and was DEAD: a generated box that is a flex
             item is BLOCKIFIED, so it computed to block regardless. Measured
             here, then deleted from the stylesheet - and the measurement is
             kept because it is load-bearing in its own right. If the row ever
             stops being a flex container this gutter becomes an inline box,
             a width on an inline box is ignored, and the whole fixed-width
             tick column silently stops working while every inset above still
             reads uniform.

             RECORDED COVERAGE GAP, in the same rule: the centred text-align is
             real and is NOT asserted anywhere. No DOM measurement can reach
             it - a pseudo-element has no client rect and its generated text
             cannot be put in a Range - so it was verified in PIXELS off a
             capturePage of the real open menu: at dpr 1.5 the tick's
             horizontal ink centroid inside this 12px box measures 9.83
             centred, 6.83 left-aligned, 12.76 right-aligned. That A/B is not
             promoted to an assertion on purpose: it would make this suite
             depend on window foreground state, and capturePage is known in
             this project to return stale frames, which is exactly how a suite
             that must survive a multi-hour revert run goes flaky.
             NOTE FOR EDITORS: never a backtick in here. */
          beforeDisplay: cs.display,
          labelLeft: Math.round(tr.left * 100) / 100,
          rowLeft: Math.round(rr.left * 100) / 100,
          w: Math.round(rr.width),
          h: Math.round(rr.height),
        });
        out.rowFont = parseFloat(getComputedStyle(row).fontSize) || 0;
      }
      /* THE MODE ROWS - Light / Dark / Follow Desktop - are PRE-EXISTING
         product UI that this work changed and nothing measured. At ca1ac9e
         their tick gutter was a pair of hand-tuned margins (6px beside the
         checkmark, 20px in place of it); it is now the same fixed 12px box the
         scheme rows use, so the whole submenu aligns as one column. That is a
         deliberate change to surfaces outside the scheme feature, and it is
         recorded here as a measurement rather than left as an omission. */
      for (const row of document.querySelectorAll('.custom-theme-option')) {
        const rng = document.createRange();
        rng.selectNodeContents(row);
        const tr = rng.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        /* A MODE ROW'S CONTENTS BEGIN WITH ITS ICON, NOT ITS TEXT. The scheme
           rows are built by assigning row.textContent, so a range over their
           contents really is a range over the label; the mode rows are built
           from an innerHTML string that puts an inline SVG first, so the same
           range starts at that icon. That makes the number above a measure of
           where the TICK GUTTER ends - useful, and asserted as such below - but
           it is not the label, and reading it as one hides an icon retune that
           pushes every mode label sideways while the gutter stays put. The text
           is therefore measured on its own node. NOTE FOR EDITORS: this comment
           lives inside an exec() template literal, so it must never contain a
           backtick. In a flex container the trailing text is an anonymous flex
           item and its leading whitespace is stripped, so this is the painted
           glyph start rather than the source string's. */
        let textLeft = null;
        const last = row.lastChild;
        if (last && last.nodeType === 3 && last.textContent.trim()) {
          const r2 = document.createRange();
          r2.selectNode(last);
          textLeft = Math.round(r2.getBoundingClientRect().left * 100) / 100;
        }
        const icon = row.querySelector('svg');
        out.modeRows.push({
          id: row.dataset.mode || '?',
          active: row.classList.contains('active'),
          labelLeft: Math.round(tr.left * 100) / 100,
          textLeft,
          iconW: icon ? Math.round(icon.getBoundingClientRect().width * 100) / 100 : 0,
          rowLeft: Math.round(rr.left * 100) / 100,
          w: Math.round(rr.width),
          h: Math.round(rr.height),
        });
      }
      for (const cap of document.querySelectorAll('.theme-scheme-group')) {
        const r = cap.getBoundingClientRect();
        const cs = getComputedStyle(cap);
        out.captions.push({
          text: (cap.textContent || '').trim(),
          w: Math.round(r.width), h: Math.round(r.height),
          font: parseFloat(cs.fontSize) || 0,
          cursor: cs.cursor,
          submenuItem: cap.classList.contains('tools-submenu-item'),
        });
      }
      for (const s of document.querySelectorAll('.theme-scheme-sep')) {
        out.seps.push(parseFloat(getComputedStyle(s).marginTop) || 0);
      }
      /* THE BASE SEPARATOR, MEASURED IN THE SAME PROBE, because without it the
         gap assertion is a disjunction: .theme-scheme-sep is applied ALONGSIDE
         .tools-menu-separator, whose own rule already sets a top margin, so
         "the margin is greater than zero" is satisfied whether or not the
         scheme rule contributes anything at all. Comparing the two is the only
         form of the claim that names this rule. A computed length is readable
         on a display:none subtree, so the tools menu being shut is fine. */
      const baseSep = document.querySelector('.tools-menu-separator:not(.theme-scheme-sep)');
      out.baseSep = baseSep ? parseFloat(getComputedStyle(baseSep).marginTop) || 0 : -1;
      return JSON.stringify(out);
    })()`;
    const chrome = JSON.parse(await exec(CHROME_PROBE));
    /* THE ONE DECLARATION IN THE GUTTER RULE THAT IS INERT IN THE SHIPPED
       LAYOUT BUT NOT DEAD, measured under the condition it exists for.

       The submenu panel is shrink-to-fit, so an over-long label widens the
       panel (measured 1005px) instead of compressing anything - which means
       `flex: 0 0 auto` can never bite as the product stands, and a plain
       revert of it would come back VACUOUS. Bounding the panel is an entirely
       ordinary future edit, and under it the default `flex: 0 1 auto` squeezes
       this fixed column on the OVERFLOWING ROW ALONE: measured inset 32 -> 28
       while its siblings hold at 32. That is precisely the per-row
       misalignment the fixed width exists to prevent, and it is invisible to
       every resting measurement above.

       So the panel is bounded and a label planted, deliberately, and the real
       rule is measured under it. The perturbation is undone and the undo is
       itself asserted, since a stranded max-width would silently reshape every
       later measurement.
       NOTE FOR EDITORS: never a backtick in here - this comment lives inside
       an exec() template literal and a backtick terminates it. */
    const SHRINK_PROBE = `(() => {
      const rows = Array.from(document.querySelectorAll('.custom-scheme-option'));
      if (rows.length < 2) return JSON.stringify({ error: 'no scheme rows' });
      const victim = rows[0];
      const panel = victim.parentElement;
      const oldLabel = victim.textContent;
      const oldMax = panel.style.maxWidth;
      const insets = () => rows.map((r) => {
        const rr = r.getBoundingClientRect();
        const rng = document.createRange();
        rng.selectNodeContents(r);
        return { id: r.dataset.scheme || '?', inset: Math.round((rng.getBoundingClientRect().left - rr.left) * 100) / 100 };
      });
      const style = document.createElement('style');
      style.id = '__shrink_probe';
      document.head.appendChild(style);
      const out = { victim: victim.dataset.scheme || '?' };
      out.before = insets();
      try {
        victim.textContent = 'A scheme name far too long for a bounded panel to hold without overflowing it';
        panel.style.maxWidth = '120px';
        void panel.offsetWidth;
        out.overflow = { scrollW: victim.scrollWidth, clientW: victim.clientWidth };
        out.shipped = insets();
        /* The counterfactual, applied to the REAL rule at the real
           specificity rather than to a copy of it on a probe node.
           THE SELECTOR MUST TRACK THE SHIPPED ONE. When the tick gutter was
           scoped under #customThemeMenuItem to match its packing rule, this
           injection - still written at the old class-only specificity - simply
           lost the cascade, the gutter did not move, and this control failed
           by name. That is the control working: an override that cannot
           override would have made the two assertions above vacuous without
           it. Same specificity, later in the sheet, so source order decides. */
        style.textContent = '#customThemeMenuItem .custom-theme-option::before, #customThemeMenuItem .custom-scheme-option::before { flex: 0 1 auto; }';
        void panel.offsetWidth;
        out.defaulted = insets();
      } finally {
        style.remove();
        victim.textContent = oldLabel;
        panel.style.maxWidth = oldMax;
        void panel.offsetWidth;
      }
      out.restored = insets();
      out.restoredLabel = victim.textContent;
      out.beforeLabel = oldLabel;
      out.restoredMax = panel.style.maxWidth;
      out.beforeMax = oldMax;
      out.styleGone = !document.getElementById('__shrink_probe');
      return JSON.stringify(out);
    })()`;
    const shrink = JSON.parse(await exec(SHRINK_PROBE));
    const spread = (list) => {
      const v = list.map((r) => r.inset);
      return Math.round((Math.max(...v) - Math.min(...v)) * 100) / 100;
    };
    check(
      "10j: the bounded-panel perturbation really does overflow the row it plants a label in (control)",
      !shrink.error &&
        shrink.overflow &&
        shrink.overflow.scrollW > shrink.overflow.clientW,
      `victim=${shrink.victim} scrollWidth=${shrink.overflow && shrink.overflow.scrollW} clientWidth=${
        shrink.overflow && shrink.overflow.clientW
      } - without a real overflow flex-shrink is never applied and the two assertions below are vacuous`,
    );
    check(
      "10j: the tick gutter keeps its width when the panel is bounded and a label overflows",
      !shrink.error && shrink.shipped && spread(shrink.shipped) === 0,
      `insets under a bounded panel: ${
        shrink.shipped && shrink.shipped.map((r) => `${r.id}=${r.inset}`).join(" ")
      } - a squeezed gutter on the overflowing row alone is exactly the misalignment the fixed width exists to prevent`,
    );
    check(
      "10j: dropping flex-shrink:0 really would squeeze that gutter (control)",
      !shrink.error && shrink.defaulted && spread(shrink.defaulted) > 0,
      `insets with the default flex: ${
        shrink.defaulted && shrink.defaulted.map((r) => `${r.id}=${r.inset}`).join(" ")
      } - if these are uniform too then the counterfactual changed nothing and the assertion above is not measuring this declaration`,
    );
    check(
      "10j: the bounded-panel perturbation was undone before anything else was measured",
      /* Restoration is judged against the insets measured BEFORE the
         perturbation, NOT against a uniform spread. Those are different
         claims: a uniform spread also asserts the gutter rule is correct, so
         any revert that breaks the rule would report a stranded perturbation
         it did not cause - a failure naming the wrong thing, which this
         project treats as the most expensive kind. */
      !shrink.error &&
        shrink.styleGone &&
        shrink.restored &&
        shrink.before &&
        JSON.stringify(shrink.restored) === JSON.stringify(shrink.before) &&
        shrink.restoredLabel === shrink.beforeLabel &&
        shrink.restoredMax === shrink.beforeMax,
      `styleGone=${shrink.styleGone} before=${JSON.stringify(
        shrink.before,
      )} restored=${JSON.stringify(shrink.restored)} label ${JSON.stringify(
        shrink.beforeLabel,
      )} -> ${JSON.stringify(shrink.restoredLabel)} maxWidth ${JSON.stringify(
        shrink.beforeMax,
      )} -> ${JSON.stringify(shrink.restoredMax)}`,
    );
    const paintsGlyph = (c) => !!c && c !== "none" && !/^["'][\s]*["']$/.test(c);
    const tickedRows = chrome.rows.filter((r) => r.active);
    const untickedRows = chrome.rows.filter((r) => !r.active);
    const rowsPainted = chrome.rows.length > 0 && chrome.rows.every((r) => r.w > 0 && r.h > 0);
    check(
      "10j: the scheme submenu was open and painted when its chrome was measured (probe self-guard)",
      chrome.open && rowsPainted && chrome.rows.length === MENU_IDS.length,
      `open=${chrome.open} rows=${chrome.rows.length}/${MENU_IDS.length} sizes ${chrome.rows
        .map((r) => `${r.id}=${r.w}x${r.h}`)
        .join(" ")}`,
    );
    check(
      "10j: a ticked scheme row really paints a checkmark, not just an .active class",
      tickedRows.length >= 2 && tickedRows.every((r) => paintsGlyph(r.content)),
      `${tickedRows.length} ticked row(s): ${tickedRows
        .map((r) => `${r.id} content=${r.content}`)
        .join(" | ")}`,
    );
    check(
      "10j: an unticked scheme row paints no checkmark (control)",
      untickedRows.length >= 2 && untickedRows.every((r) => !paintsGlyph(r.content)),
      `${untickedRows.length} unticked row(s): ${untickedRows
        .filter((r) => paintsGlyph(r.content))
        .map((r) => `${r.id} content=${r.content}`)
        .join(" | ")}`,
    );
    const labelLefts = chrome.rows.map((r) => Math.round((r.labelLeft - r.rowLeft) * 100) / 100);
    const labelSpread = labelLefts.length
      ? Math.max(...labelLefts) - Math.min(...labelLefts)
      : -1;
    check(
      "10j: every scheme label starts at the same x, so the tick gutter is reserved on unticked rows too",
      chrome.rows.length === MENU_IDS.length &&
        rowsPainted &&
        labelSpread >= 0 &&
        labelSpread <= 1,
      `label insets ${chrome.rows
        .map((r, i) => `${r.id}${r.active ? "*" : ""}=${labelLefts[i]}`)
        .join(" ")} (spread ${labelSpread}, painted ${rowsPainted})`,
    );
    /* THE CAPTIONS' OWN CODE COMMENT MAKES A CLAIM - "not focusable, not
       clickable, and deliberately not a .tools-submenu-item so the hover
       highlight cannot make them look actionable" - and this is that claim as
       a measurement rather than as prose. The font relationship is asserted
       against the row's own resolved size rather than against 10px, so it
       cannot rot when either size is retuned. */
    check(
      "10j: each scheme group carries a caption that renders, and reads as a caption rather than a row",
      chrome.captions.length >= 2 &&
        chrome.rowFont > 0 &&
        chrome.captions.every(
          (c) =>
            c.text.length > 0 &&
            c.w > 0 &&
            c.h > 0 &&
            c.font > 0 &&
            c.font < chrome.rowFont &&
            c.cursor !== "pointer" &&
            !c.submenuItem,
        ),
      `rows render at ${chrome.rowFont}px; captions ${JSON.stringify(chrome.captions)}`,
    );
    check(
      "10j: the divider above the scheme groups opens a WIDER gap than an ordinary menu separator",
      chrome.seps.length >= 1 &&
        chrome.baseSep > 0 &&
        chrome.seps.every((m) => m > chrome.baseSep),
      `scheme divider margin-top [${chrome.seps.join(
        ",",
      )}] against the base separator's ${chrome.baseSep} - equal values here mean this rule contributes nothing and the claim is being met by .tools-menu-separator alone`,
    );
    const gutterDisplays = [...new Set(chrome.rows.map((r) => r.beforeDisplay))];
    check(
      "10j: the tick gutter is a blockified flex item, which is what makes its fixed width mean anything",
      rowsPainted && gutterDisplays.length === 1 && gutterDisplays[0] === "block",
      `::before display: [${gutterDisplays.join(
        ", ",
      )}] - anything but "block" means the row has stopped being a flex container, and a width on an inline box is ignored`,
    );

    /* THE PRE-EXISTING MODE ROWS, WHICH THIS WORK CHANGED. Everything above
       measures the scheme rows this feature added; the Light / Dark / Follow
       Desktop rows predate it and their tick gutter was rebuilt underneath
       them - from `margin-right: 6px` beside the checkmark and `20px` in place
       of it, to the same fixed 12px box the scheme rows use.

       Both halves are asserted because they fail under different accidents.
       The first is the property the OLD margins were hand-tuned to approximate
       and is what a reader sees within one group; the second is the property
       the change was MADE for - one gutter for the whole submenu - and it is
       satisfied by neither group on its own, so no per-group assertion can
       reach it. A future edit retuning one group's gutter alone passes the
       first and fails the second, which is exactly the regression the old
       hand-tuned pair was one edit away from. */
    const modeLefts = chrome.modeRows.map(
      (r) => Math.round((r.labelLeft - r.rowLeft) * 100) / 100,
    );
    const modeSpread = modeLefts.length ? Math.max(...modeLefts) - Math.min(...modeLefts) : -1;
    const modePainted =
      chrome.modeRows.length > 0 && chrome.modeRows.every((r) => r.w > 0 && r.h > 0);
    check(
      "10j: every mode row's tick gutter ends at the same x, ticked or not",
      chrome.modeRows.length === 3 &&
        modePainted &&
        chrome.modeRows.some((r) => r.active) &&
        chrome.modeRows.some((r) => !r.active) &&
        modeSpread >= 0 &&
        modeSpread <= 1,
      `mode insets ${chrome.modeRows
        .map((r, i) => `${r.id}${r.active ? "*" : ""}=${modeLefts[i]}`)
        .join(" ")} (spread ${modeSpread}, painted ${modePainted})`,
    );
    /* AND THE SAME CHANGE AS A RECORDED DECISION, which the assertion above is
       not. That one says the rows are aligned TODAY; it is equally satisfied by
       a menu that was always aligned, so it cannot show that a pre-existing
       surface was deliberately changed. This one reads the ledger and asserts
       both halves of the entry: the recorded `was` really is a misaligned set
       (the premise the amendment was made on), and the live geometry really is
       the aligned one (the amendment is applied). Emptying the ledger, or
       restoring the old margins, each fail it on their own. */
    const gutterAmendment = CHROME_AMENDMENTS.find((a) => a.id === "mode-row tick gutter");
    /* THE PREMISE IS PINNED THREE WAYS, because "the recorded numbers are not
       all equal" is not a premise - both review models observed that ANY
       misaligned set satisfies it, so a `was` that had drifted to numbers
       nobody ever measured would still read as sound. These tie the reading to
       itself and to the sentence that explains it: the two unticked rows must
       AGREE (they were one measurement taken twice, not two), the ticked row
       must sit exactly the recorded delta to their left, and `why` must name
       that same delta in px. Change any single number and at least one of the
       three stops holding. */
    const wasActive = gutterAmendment ? gutterAmendment.was.active : null;
    const wasInactive = gutterAmendment ? gutterAmendment.was.inactive : [];
    const inactiveAgrees = wasInactive.length === 2 && wasInactive[0] === wasInactive[1];
    const wasDelta = inactiveAgrees && typeof wasActive === "number" ? wasInactive[0] - wasActive : -1;
    const whyDelta = gutterAmendment ? Number((/(\d+)px/.exec(gutterAmendment.why) || [])[1]) : NaN;
    check(
      "10j: the mode-row gutter change is recorded as a decision, and its premise still reads as one",
      CHROME_AMENDMENTS.length === 1 &&
        inactiveAgrees &&
        wasDelta > 0 &&
        wasDelta === whyDelta &&
        modePainted &&
        chrome.modeRows.length === 3 &&
        modeSpread >= 0 &&
        modeSpread <= 1,
      `ledger ${CHROME_AMENDMENTS.length} entry(ies); recorded was active=${wasActive} inactive=${wasInactive.join(
        "+",
      )} (delta ${wasDelta}, why says ${whyDelta}px) -> now ${modeLefts.join(
        "/",
      )} (spread ${modeSpread}); reason: ${gutterAmendment ? gutterAmendment.why : "NO LEDGER ENTRY"}`,
    );
    /* AND THE LABEL ITSELF, which the number above is not. A mode row's first
       child is its icon, so the inset above is where the GUTTER ends; the two
       coincide only while all three icons are the same width, and an icon
       retune moves every mode label without moving that inset at all. This
       reads the trailing text node on its own. */
    const modeTextLefts = chrome.modeRows.map((r) =>
      r.textLeft === null ? null : Math.round((r.textLeft - r.rowLeft) * 100) / 100,
    );
    const modeTextMeasured = modeTextLefts.every((v) => typeof v === "number");
    const modeTextSpread = modeTextMeasured
      ? Math.round((Math.max(...modeTextLefts) - Math.min(...modeTextLefts)) * 100) / 100
      : -1;
    check(
      "10j: every mode row's text label starts at the same x, ticked or not",
      chrome.modeRows.length === 3 &&
        modePainted &&
        modeTextMeasured &&
        chrome.modeRows.every((r) => r.iconW > 0) &&
        modeTextSpread >= 0 &&
        modeTextSpread <= 1,
      `mode text insets ${chrome.modeRows
        .map((r, i) => `${r.id}${r.active ? "*" : ""}=${modeTextLefts[i]}`)
        .join(" ")} (spread ${modeTextSpread}, icons ${chrome.modeRows
        .map((r) => r.iconW)
        .join("/")})`,
    );
    /* THE CONTROL THAT KEEPS THE PAIR HONEST. If the text range silently
       collapsed onto the icon - a changed row structure, a lost text node, a
       Range that failed to resolve - both numbers above would become the SAME
       number and both assertions would still pass, one of them vacuously. The
       label must measure strictly right of the gutter, by about an icon. */
    const modeTextGaps = modeTextMeasured
      ? chrome.modeRows.map((r, i) => Math.round((modeTextLefts[i] - modeLefts[i]) * 100) / 100)
      : [];
    check(
      "10j: the mode row's text really is a different measurement from its gutter (control)",
      modeTextMeasured &&
        modeTextGaps.length === 3 &&
        chrome.modeRows.every((r) => r.iconW > 0) &&
        modeTextGaps.every((g, i) => g >= chrome.modeRows[i].iconW),
      `text-minus-gutter ${modeTextGaps.join("/")} against icon widths ${chrome.modeRows
        .map((r) => r.iconW)
        .join("/")} - equal numbers here mean the text range collapsed onto the icon, and a zero icon width means nothing was painted to compare against`,
    );
    const gutterSpread =
      modeLefts.length && labelLefts.length
        ? Math.round(
            (Math.max(...modeLefts, ...labelLefts) - Math.min(...modeLefts, ...labelLefts)) * 100,
          ) / 100
        : -1;
    /* ONE GUTTER, TWO TEXT COLUMNS - and the second half of that sentence is
       why this assertion is no longer named "so the submenu is a single
       column". It is not one: the mode rows carry an icon the scheme rows do
       not, so their text starts an icon-width further right. Measured, not
       assumed - see the text assertion above. What the shared rule really buys
       is a single TICK column, which is the thing a reader's eye follows down
       the menu and the thing the old hand-tuned margins were one edit from
       losing. */
    check(
      "10j: mode rows and scheme rows share ONE tick gutter",
      modePainted && rowsPainted && gutterSpread >= 0 && gutterSpread <= 1,
      `mode [${modeLefts.join(",")}] scheme [${labelLefts.join(",")}] (spread ${gutterSpread})`,
    );

    /* Both base rows are included deliberately: a base scheme applies by
       REMOVING data-theme, so it is the one row whose success looks identical
       to the row having done nothing at all. It is only distinguishable
       because the row before it in this list leaves a scheme applied. */
    const MENU_CLICKS = [
      ["clarity", "light"],
      ["abyss", "dark"],
      ["default-dark", "dark"],
      ["parchment", "light"],
      ["ember", "dark"],
      ["default-light", "light"],
    ];
    const clickResults = [];
    const clickUnreachable = [];
    for (const [id, mode] of MENU_CLICKS) {
      const opened = JSON.parse(await exec(MENU_PATH_PROBE));
      if (opened.missing.length || !opened.steps.every(([, ok]) => ok)) {
        clickUnreachable.push(`${id}: submenu would not open`);
        continue;
      }
      const sel = `.custom-scheme-option[data-scheme=${JSON.stringify(id)}]`;
      /* CAPTURED BEFORE THE CLICK, because "leaving the other mode's alone" is
         a statement about a VALUE and not about a value's shape. Reading only
         afterwards, the strongest thing that can be said is that the other key
         holds some recognised scheme id - which a bug that overwrites it with
         a different valid id satisfies perfectly, and the tick check that
         follows would then agree with the clobbered store and pass too. */
      const before = JSON.parse(await exec(MENU_STATE_PROBE));
      const clicked = JSON.parse(
        await exec(`(() => {
          const row = document.querySelector(${JSON.stringify(sel)});
          if (!row) return JSON.stringify({ found: false });
          const r = row.getBoundingClientRect();
          const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2),
            Math.round(r.top + r.height / 2),
          );
          const reachable = !!hit && (hit === row || row.contains(hit));
          const label = row.textContent.trim();
          if (reachable) row.click();
          return JSON.stringify({ found: true, reachable: reachable, label: label });
        })()`),
      );
      if (!clicked.found || !clicked.reachable) {
        clickUnreachable.push(`${id}: found=${clicked.found} reachable=${clicked.reachable}`);
        continue;
      }
      // The row handler dismisses the menu on a 10ms timer (custom-theme.js),
      // so the dismissal is only observable after it has run.
      await new Promise((r) => setTimeout(r, 80));
      const state = JSON.parse(await exec(MENU_STATE_PROBE));
      clickResults.push({ id, mode, label: clicked.label, state, before });
    }

    check(
      "10j: every scheme row was reached and clicked as a mouse would reach it",
      clickUnreachable.length === 0 && clickResults.length === MENU_CLICKS.length,
      `${clickResults.length}/${MENU_CLICKS.length} clicked; ${clickUnreachable.join(" | ")}`,
    );

    const applyMisses = clickResults
      .filter((r) => {
        const isBase = r.id.startsWith("default-");
        const wantTheme = isBase ? "none" : r.id;
        return r.state.dataTheme !== wantTheme || r.state.dark !== (r.mode === "dark");
      })
      .map(
        (r) =>
          `${r.id} -> data-theme=${r.state.dataTheme} dark=${r.state.dark} (wanted ${r.mode})`,
      );
    check(
      "10j: clicking a scheme row applies that scheme, and switches mode with it",
      applyMisses.length === 0 && clickResults.length === MENU_CLICKS.length,
      applyMisses.join(" | "),
    );

    /* THE PERSISTENCE HALF, WHICH IS WHAT MAKES THE CHOICE SURVIVE A RESTART.
       Keyed per mode on purpose (SCHEME_KEYS), so a dark choice must land in
       themeDarkScheme and must NOT disturb themeLightScheme - the property
       that lets "Follow Desktop" answer at both ends of the day. */
    const storeMisses = clickResults
      .filter((r) => {
        const key = r.mode === "dark" ? "darkScheme" : "lightScheme";
        const other = r.mode === "dark" ? "lightScheme" : "darkScheme";
        const otherUntouched = (r.state[other] ?? null) === (r.before[other] ?? null);
        return r.state[key] !== r.id || r.state.themeMode !== r.mode || !otherUntouched;
      })
      .map(
        (r) =>
          `${r.id} -> themeMode=${r.state.themeMode} light=${r.state.lightScheme} dark=${r.state.darkScheme} (other key was ${JSON.stringify(r.before[r.mode === "dark" ? "lightScheme" : "darkScheme"] ?? null)}, is now ${JSON.stringify(r.state[r.mode === "dark" ? "lightScheme" : "darkScheme"] ?? null)})`,
      );
    check(
      "10j: the choice is stored under its own mode's key, leaving the other mode's alone",
      storeMisses.length === 0 && clickResults.length === MENU_CLICKS.length,
      storeMisses.join(" | "),
    );

    const stillOpen = clickResults
      .filter((r) => r.state.mainMenuOpen || r.state.viewMenuOpen || r.state.themeOpen)
      .map(
        (r) =>
          `${r.id} -> main=${r.state.mainMenuOpen} view=${r.state.viewMenuOpen} theme=${r.state.themeOpen}`,
      );
    check(
      "10j: choosing a scheme dismisses the menu it was chosen from",
      stillOpen.length === 0 && clickResults.length === MENU_CLICKS.length,
      stillOpen.join(" | "),
    );

    /* THE TICK IS A TWO-GROUP CLAIM, and that is the interesting part.
       markActive() ticks a scheme row when it is the stored choice for ITS OWN
       mode, so BOTH groups carry a tick at once and the reader can see what
       Follow Desktop will pick at either end of the day. Ticking only the
       active mode's group is the natural simplification and would leave the
       other group looking unset when it is not - so "exactly one per group"
       and "the tick names the stored id" are asserted separately from the
       count, because a one-group implementation still satisfies a bare count
       of 1. */
    const LIGHT_IDS = ["default-light", "clarity", "parchment"];
    const tickMisses = [];
    for (const r of clickResults) {
      const lit = r.state.schemeTicked.filter((s) => LIGHT_IDS.includes(s));
      const drk = r.state.schemeTicked.filter((s) => !LIGHT_IDS.includes(s));
      if (lit.length !== 1 || drk.length !== 1) {
        tickMisses.push(`${r.id}: ticked [${r.state.schemeTicked.join(",")}]`);
      } else if (lit[0] !== r.state.lightScheme || drk[0] !== r.state.darkScheme) {
        tickMisses.push(
          `${r.id}: ticked ${lit[0]}/${drk[0]} but stored ${r.state.lightScheme}/${r.state.darkScheme}`,
        );
      }
    }
    check(
      "10j: each scheme group carries exactly one tick, and it names that group's stored choice",
      tickMisses.length === 0 && clickResults.length === MENU_CLICKS.length,
      tickMisses.join(" | "),
    );

    const modeTickMisses = clickResults
      .filter((r) => r.state.modeTicked.length !== 1 || r.state.modeTicked[0] !== r.state.themeMode)
      .map((r) => `${r.id}: ticked [${r.state.modeTicked.join(",")}] for themeMode=${r.state.themeMode}`);
    check(
      "10j: exactly one mode row is ticked, and it names the stored themeMode",
      modeTickMisses.length === 0 && clickResults.length === MENU_CLICKS.length,
      modeTickMisses.join(" | "),
    );

    /* The ticks are painted by markActive() at the moment of the choice and are
       never re-applied on open, so this is the assertion that the row classes
       are not merely correct for one frame. It also covers the reader's real
       question - "which one am I on?" - which is only ever asked with the menu
       open. */
    await exec(MENU_PATH_PROBE);
    const reopened = JSON.parse(await exec(MENU_STATE_PROBE));
    const reopenedLight = reopened.schemeTicked.filter((s) => LIGHT_IDS.includes(s));
    const reopenedDark = reopened.schemeTicked.filter((s) => !LIGHT_IDS.includes(s));
    check(
      "10j: the ticks still describe the stored choice when the menu is reopened",
      reopenedLight.length === 1 &&
        reopenedDark.length === 1 &&
        reopenedLight[0] === reopened.lightScheme &&
        reopenedDark[0] === reopened.darkScheme &&
        reopened.modeTicked.length === 1 &&
        reopened.modeTicked[0] === reopened.themeMode,
      `reopened with ticks [${reopened.schemeTicked.join(",")}] / [${reopened.modeTicked.join(",")}] against stored ${reopened.lightScheme}/${reopened.darkScheme}/${reopened.themeMode}`,
    );

    /* The labels are what the reader chooses BY, so a row wired to the right id
       under the wrong label is a defect no state assertion can see. Compared
       against the registry the menu is built from rather than a second copy of
       the list. */
    const labelMisses = [];
    for (const r of clickResults) {
      const want = await exec(
        `(() => { const s = window.foliaThemes.SCHEMES.find((x) => x.id === ${JSON.stringify(r.id)}); return s ? s.label : ''; })()`,
      );
      if (r.label !== want) labelMisses.push(`${r.id}: row reads "${r.label}", registry says "${want}"`);
    }
    check(
      "10j: every row is labelled with its registry label",
      labelMisses.length === 0 && clickResults.length === MENU_CLICKS.length,
      labelMisses.join(" | "),
    );

    await exec(`(() => { document.body.click(); return 1; })()`);
    {
      let running = -1;
      for (let i = 0; i < 60; i++) {
        running = await settleTransitions();
        maxRunning = Math.max(maxRunning, running);
        if (running === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (running !== 0) settleFailures.push(`10j menu drive: ${running} still running`);
    }

    console.log(
      `  note: menu e2e: ${clickResults.length}/${MENU_CLICKS.length} rows driven from #menuBtn; ` +
        `${menuOpenReach.reachable.length} reachable open, ${menuClosedReach.reachable.length} closed`,
    );

    // ── 10j-overflow: viewport bounds, not an assumed minimum window size ──
    function toolbarOverflowProbe(action, recents) {
      const byId = (id) => document.getElementById(id);
      const faults = [];
      const rect = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom,
          width: r.width, height: r.height };
      };
      const reach = (el, scroll = true) => {
        if (!el) return false;
        if (scroll) el.scrollIntoView({ block: "nearest", inline: "nearest" });
        const r = rect(el);
        if (r.width < 1 || r.height < 1 || r.left < -1 || r.top < -1 ||
            r.right > innerWidth + 1 || r.bottom > innerHeight + 1) return false;
        for (let p = el.parentElement; p; p = p.parentElement) {
          const s = getComputedStyle(p);
          const b = rect(p);
          if (/auto|scroll|hidden|clip/.test(s.overflowX) &&
              (r.left < b.left + p.clientLeft - 1 ||
               r.right > b.left + p.clientLeft + p.clientWidth + 1)) return false;
          if (/auto|scroll|hidden|clip/.test(s.overflowY) &&
              (r.top < b.top + p.clientTop - 1 ||
               r.bottom > b.top + p.clientTop + p.clientHeight + 1)) return false;
        }
        const hit = document.elementFromPoint(
          r.left + r.width / 2, r.top + r.height / 2,
        );
        return !!hit && (hit === el || el.contains(hit));
      };
      const click = (id) => {
        const el = byId(id);
        if (!reach(el)) { faults.push(id + ":unreachable"); return false; }
        el.click();
        return true;
      };
      const open = (kind) => {
        document.body.click();
        if (!click("menuBtn") || !click(kind === "file" ? "fileBtn" : "viewBtn")) return;
        if (kind === "theme") {
          const item = byId("customThemeMenuItem");
          // In flow the parent includes the whole panel: hover its label,
          // not the centre of a box that can be taller than the scrollport.
          if (!reach(item.querySelector("span"))) faults.push("Theme:unreachable");
          else item.dispatchEvent(new MouseEvent("mouseenter"));
        }
      };
      if (action === "file") {
        localStorage.setItem("recentFiles", JSON.stringify(recents));
        open("file");
      } else if (action === "theme") open("theme");
      else if (action === "closed") document.body.click();

      const root = byId("mainMenu");
      const panelIds = ["mainMenu", "fileMenu", "viewMenu", "customThemeSubmenu"];
      const panels = Object.fromEntries(panelIds.map((id) => [id, rect(byId(id))]));
      const rows = [...document.querySelectorAll(
        ".custom-theme-option, .custom-scheme-option",
      )];
      const out = {
        faults, panels, width: innerWidth, height: innerHeight,
        compact: document.body.classList.contains("compact-header"),
        focus: document.activeElement.id,
        rootOverflow: getComputedStyle(root).overflowY,
        zoom: Number(getComputedStyle(byId("viewer")).zoom),
        headerZoom: Number(getComputedStyle(document.querySelector(".header")).zoom),
        choices: rows.map((row) => row.dataset.mode || row.dataset.scheme),
      };
      if (action === "theme" || action === "inspect") {
        root.scrollTop = 0;
        out.rootOverflows = root.scrollHeight > root.clientHeight + 1;
        out.rows = rows.map((row) => ({
          id: row.dataset.mode || row.dataset.scheme,
          reachable: reach(row), rect: rect(row),
        }));
        out.rootScrolled = root.scrollTop > 0;
        out.panels.mainMenu = rect(root);
      } else if (action === "file") {
        const list = byId("fileMenuRecent");
        const entries = [...list.querySelectorAll(".tools-menu-recent-item")];
        out.recents = entries.map((entry, i) => ({
          exact: !!recents[i] &&
            entry.querySelector(".tools-menu-recent-name").textContent === recents[i].name &&
            entry.querySelector(".tools-menu-recent-path").textContent === recents[i].path,
          ellipsized: [...entry.querySelectorAll("span")].every((span) =>
            span.clientWidth > 0 && span.scrollWidth > span.clientWidth + 1 &&
            getComputedStyle(span).textOverflow === "ellipsis"),
        }));
        root.scrollTop = 0;
        list.scrollTop = 0;
        out.rootOverflows = root.scrollHeight > root.clientHeight + 1;
        out.listOverflows = list.scrollHeight > list.clientHeight + 1;
        out.lastRecentReachable = reach(entries[entries.length - 1]);
        out.rootScrolled = root.scrollTop > 0;
        out.listScrolled = list.scrollTop > 0;
      } else if (action === "exclusion") {
        const visible = (id) => byId(id).classList.contains("visible");
        out.fileInitiallyOpen = visible("fileMenu") && !visible("viewMenu");
        click("viewBtn");
        out.onlyView = visible("mainMenu") && visible("viewMenu") &&
          !visible("fileMenu") && byId("fileBtn").getAttribute("aria-expanded") === "false";
        click("fileBtn");
        out.onlyFile = visible("mainMenu") && visible("fileMenu") &&
          !visible("viewMenu") && byId("viewBtn").getAttribute("aria-expanded") === "false";
      } else if (action === "closed") {
        out.closed = panelIds.every((id) => rect(byId(id)).width === 0);
        out.hiddenChoices = rows.length === 9 && rows.every((row) => !reach(row, false));
      }
      return out;
    }

    const overflowProbe = (action, recents = []) =>
      exec(`(${toolbarOverflowProbe.toString()})(${JSON.stringify(action)}, ${JSON.stringify(recents)})`);
    const originalBounds = win.getBounds();
    const originalContentSize = win.getContentSize();
    const overflowSaved = await exec(`({
      recents: localStorage.getItem("recentFiles"),
      zoomLabel: document.getElementById("zoomReset").textContent,
      focus: document.activeElement.id,
      themeOpen: document.getElementById("customThemeMenuItem").classList.contains("theme-open"),
      scrolls: ["mainMenu", "fileMenuRecent"].map((id) =>
        [id, document.getElementById(id).scrollTop]),
    })`);
    const overflowRecents = Array.from({ length: 12 }, (_, i) => ({
      name: `toolbar-${i}-<literal&name>-${"long-name-".repeat(30)}.md`,
      path: `C:\\toolbar-overflow\\${"long-directory\\".repeat(60)}file-${i}.md`,
      timestamp: Date.now() - i,
    }));
    const overflowStates = [];
    const overflowShots = [];
    const shotPrefix = `theme-toolbar-overflow-${process.pid}-${Date.now()}`;
    const resizeToolbar = async (width, height, alignBoundary = false) => {
      let requestedWidth = width;
      let measured;
      for (let attempt = 0; attempt < 3; attempt++) {
        win.setContentSize(requestedWidth, height);
        let achieved;
        let previous = "";
        let stable = 0;
        // At 125% display scale the same client area measured 701 DIP in
        // getContentSize() and 702 CSS px in the renderer. Integer rounding
        // must not prevent testing the actual viewport or its resize listener.
        try {
          // The callback adapts waitFor's exec slot to a cross-process predicate;
          // two stable framed samples also reject the preceding viewport.
          await waitFor(async () => {
            await exec(`new Promise(r => requestAnimationFrame(() =>
              requestAnimationFrame(() => r(true))))`);
            achieved = win.getContentSize();
            measured = await exec(`({ width: innerWidth, height: innerHeight,
              dpr: devicePixelRatio, compact: document.body.classList.contains("compact-header") })`);
            const current = JSON.stringify({ achieved, measured });
            stable = current === previous ? stable + 1 : 0;
            previous = current;
            return stable >= 1 &&
              Math.abs(measured.width - achieved[0]) <= 1 &&
              Math.abs(measured.height - achieved[1]) <= 1 &&
              measured.compact === (measured.width < 780);
          }, "true",
          "toolbar resize reaches the renderer and its compact-header state", 4000);
        } catch (error) {
          const failedResize = await exec(`({
            width: innerWidth, height: innerHeight, outerWidth, outerHeight,
            dpr: devicePixelRatio, compact: document.body.classList.contains("compact-header"),
            hidden: document.hidden, ready: document.readyState,
          })`);
          console.log(`  note: failed toolbar resize: ${JSON.stringify({
            requested: [requestedWidth, height], achieved, bounds: win.getBounds(), failedResize,
          })}`);
          throw error;
        }
        console.log(`  note: toolbar resize: ${JSON.stringify({
          requested: [requestedWidth, height], native: achieved, measured,
        })}`);
        // Some display scales skip a CSS integer width. Exercise the actual
        // viewport on each side of 780, rather than demand an unavailable 779.
        if (!alignBoundary || (measured.width < 780) === (width < 780)) {
          return [measured.width, measured.height];
        }
        requestedWidth += width - measured.width;
      }
      throw new Error(`cannot achieve toolbar boundary ${width}: ${JSON.stringify(measured)}`);
    };
    const boundedPanels = (state) => {
      const root = state.panels.mainMenu;
      const visible = Object.values(state.panels).filter((r) => r.width > 0);
      return root.width > 0 && root.height > 0 && root.top >= 0 &&
        root.bottom <= state.height + 1 && visible.every((r) =>
          r.height > 0 && r.left >= -1 && r.right <= state.width + 1 &&
          (state.compact || (r.top >= -1 && r.bottom <= state.height + 1)));
    };
    const nineChoicesReachable = (state) =>
      state.rows.length === 9 && state.rows.every((r) => r.reachable);
    const zoomToolbar = async () => {
      const before = await overflowProbe("inspect");
      const zoomWitness = await exec(`(() => {
        document.getElementById("zoomReset").click();
        for (let i = 0; i < 60 &&
          document.getElementById("zoomReset").textContent !== "400%"; i++) {
          document.getElementById("zoomIn").click();
        }
        return {
          label: document.getElementById("zoomReset").textContent,
          viewerZoom: Number(getComputedStyle(document.getElementById("viewer")).zoom),
        };
      })()`);
      const after = await overflowProbe("inspect");
      const same = ["mainMenu", "viewMenu", "customThemeSubmenu"].every((id) =>
        ["left", "top", "width", "height"].every((key) =>
          Math.abs(before.panels[id][key] - after.panels[id][key]) <= 1));
      await exec(`document.getElementById("zoomReset").click()`);
      return { zoomWitness, before, after, same };
    };
    try {
      await exec(`document.getElementById("zoomReset").click()`);
      await resizeToolbar(1000, 700);
      const wideFile = await overflowProbe("file", overflowRecents);
      overflowStates.push(wideFile);
      check(
        "10j-overflow: long recent paths cannot expand the wide File flyout beyond the viewport",
        !wideFile.compact && wideFile.faults.length === 0 &&
          boundedPanels(wideFile) && wideFile.lastRecentReachable &&
          wideFile.recents.length === overflowRecents.length &&
          wideFile.recents.every((r) => r.exact && r.ellipsized),
        JSON.stringify(wideFile),
      );
      overflowShots.push(await captureScreenshot(win, `${shotPrefix}-wide-file`));
      const wide = await overflowProbe("theme");
      overflowStates.push(wide);
      await exec(`document.getElementById("viewBtn").focus()`);
      const wideZoom = await zoomToolbar();
      const boundaries = [];
      for (const width of [780, 779]) {
        await resizeToolbar(width, 700, true);
        const state = await overflowProbe("inspect");
        boundaries.push(state);
        overflowStates.push(state);
      }
      check(
        "10j-overflow: the achieved wide/compact boundary preserves open panels and focused View",
        wide.width >= 780 && boundaries[0].width >= 780 && !boundaries[0].compact &&
          boundaries[1].width < 780 && boundaries[1].compact &&
          boundaries.every((s) => s.focus === "viewBtn" &&
            boundedPanels(s) && nineChoicesReachable(s)),
        JSON.stringify(boundaries),
      );

      const minimum = await resizeToolbar(1, 340);
      const repeatedMinimum = await resizeToolbar(2, 340);
      const minimumState = await overflowProbe("inspect");
      overflowStates.push(minimumState);
      check(
        "10j-overflow: the OS minimum viewport is measured by two clamped requests (control)",
        minimum[0] > 2 && minimum[0] === repeatedMinimum[0] &&
          minimumState.width === minimum[0] && minimumState.height === minimum[1] &&
          minimumState.compact && minimumState.focus === "viewBtn",
        JSON.stringify({ requested: [1, 2], minimum, repeatedMinimum, minimumState }),
      );
      check(
        "10j-overflow: all nine Theme choices remain hit-testable at the achieved minimum viewport",
        minimumState.faults.length === 0 && boundedPanels(minimumState) &&
          nineChoicesReachable(minimumState),
        JSON.stringify(minimumState),
      );
      check(
        "10j-overflow: the compact Theme root really overflows and scrolls to its last choice",
        minimumState.rootOverflows && minimumState.rootScrolled &&
          minimumState.rows.at(-1).reachable,
        JSON.stringify(minimumState),
      );
      overflowShots.push(await captureScreenshot(win, `${shotPrefix}-minimum-theme`));
      const narrowZoom = await zoomToolbar();
      check(
        "10j-overflow: real 100-to-400 percent document zoom leaves wide and compact toolbar geometry unchanged",
        [wideZoom, narrowZoom].every((z) => z.before.zoom === 1 &&
          z.zoomWitness.label === "400%" && z.zoomWitness.viewerZoom === 4 &&
          z.after.zoom === 4 && z.after.headerZoom === 1 &&
          z.same && boundedPanels(z.after) && nineChoicesReachable(z.after)) &&
          win.webContents.getZoomFactor() === 1,
        JSON.stringify({ wideZoom, narrowZoom }),
      );

      const file = await overflowProbe("file", overflowRecents);
      overflowStates.push(file);
      check(
        "10j-overflow: long recent filenames and paths stay literal and ellipsized in the bounded File panel",
        file.faults.length === 0 && boundedPanels(file) &&
          file.recents.length === overflowRecents.length &&
          file.recents.every((r) => r.exact && r.ellipsized),
        JSON.stringify(file),
      );
      check(
        "10j-overflow: both real scrollports move and the final recent path remains hit-testable",
        file.rootOverflows && file.listOverflows && file.rootScrolled &&
          file.listScrolled && file.lastRecentReachable,
        JSON.stringify(file),
      );
      overflowShots.push(await captureScreenshot(win, `${shotPrefix}-minimum-file`));
      const exclusion = await overflowProbe("exclusion");
      check(
        "10j-overflow: compact File and View remain mutually exclusive without closing the root",
        exclusion.faults.length === 0 && exclusion.fileInitiallyOpen &&
          exclusion.onlyView && exclusion.onlyFile,
        JSON.stringify(exclusion),
      );
      const closed = await overflowProbe("closed");
      check(
        "10j-overflow: outside dismissal removes every panel and all nine hit targets (negative control)",
        closed.closed && closed.hiddenChoices,
        JSON.stringify(closed),
      );

      await resizeToolbar(320, 340);
      const narrow = await overflowProbe("theme");
      overflowStates.push(narrow);
      await exec(`document.getElementById("viewBtn").focus()`);
      await resizeToolbar(1000, 700);
      const returnedWide = await overflowProbe("inspect");
      overflowStates.push(returnedWide);
      check(
        "10j-overflow: compact-to-wide resize restores left-opening flyouts without losing focus or reachability",
        narrow.compact && boundedPanels(narrow) && nineChoicesReachable(narrow) &&
          !returnedWide.compact && returnedWide.focus === "viewBtn" &&
          boundedPanels(returnedWide) && nineChoicesReachable(returnedWide) &&
          returnedWide.rootOverflow === "visible" &&
          returnedWide.panels.viewMenu.right <= returnedWide.panels.mainMenu.left + 1 &&
          returnedWide.panels.customThemeSubmenu.right <= returnedWide.panels.viewMenu.left + 1,
        JSON.stringify({ narrow, returnedWide }),
      );
      overflowShots.push(await captureScreenshot(win, `${shotPrefix}-returned-wide-theme`));
    } finally {
      await exec(`(() => {
        document.body.click();
        const saved = ${JSON.stringify(overflowSaved)};
        if (saved.recents === null) localStorage.removeItem("recentFiles");
        else localStorage.setItem("recentFiles", saved.recents);
        document.getElementById("customThemeMenuItem").classList.toggle("theme-open", saved.themeOpen);
        document.getElementById("zoomReset").click();
        const target = Number.parseInt(saved.zoomLabel, 10);
        const id = target >= 100 ? "zoomIn" : "zoomOut";
        for (let i = 0; i < 60 &&
          Number.parseInt(document.getElementById("zoomReset").textContent, 10) !== target; i++) {
          document.getElementById(id).click();
        }
      })()`);
      win.setBounds(originalBounds);
      await resizeToolbar(...originalContentSize);
      await exec(`(() => {
        const saved = ${JSON.stringify(overflowSaved)};
        for (const [id, top] of saved.scrolls) document.getElementById(id).scrollTop = top;
        const el = document.getElementById(saved.focus);
        if (el) el.focus(); else document.activeElement.blur();
      })()`);
    }
    console.log(`  note: toolbar overflow achieved viewports: ${
      overflowStates.map((s) => `${s.width}x${s.height}:${s.compact ? "flow" : "flyout"}`).join(", ")
    }; screenshots awaiting review: ${overflowShots.filter(Boolean).join(", ")}`);

    /* ── 10k. ONE STORED-MODE RESOLVER ─────────────────────────────────────
       The legacy-'darkMode' migration rule used to be written down five times:
       once in renderer.js's resolveDarkPreference() - which decides the dark
       CLASS - and four times in custom-theme.js as a bare
       `localStorage.getItem('themeMode') || 'desktop'`, which does NOT consult
       the legacy key. On a profile that has only ever run the legacy build the
       two therefore answer differently, and the difference is not academic:
       measured, with the OS resolving light, the class said dark while the
       scheme sites said light, so `data-theme` landed on a LIGHT scheme
       (parchment, body background rgb(244,239,228)) underneath `.dark-mode`.

       THAT STATE IS NOT REACHABLE IN THE SHIPPED APP TODAY, and this comment
       says so rather than overselling the fix: applyTheme() is the only writer
       of 'themeMode' and init() calls it unconditionally, so a stored scheme
       implies a stored mode. It was one deleted migration block away, and the
       resolvers really did disagree - which is what this section measures.

       The state is forced rather than waited for, and window.matchMedia is
       stubbed to answer LIGHT so the legacy value ('dark') and the raw
       fallback ('desktop' -> OS) cannot agree by accident on this machine.
       Assertion 2 is the positive control for exactly that: if the stub failed
       the two answers would coincide and every assertion below would pass for
       the wrong reason.

       Four of the five sites are driven through real product functions. The
       fifth - markActive()'s `mode || storedMode()` - has a single caller and
       that caller always passes a mode, so its fallback is unreachable and is
       left unified without an independent pin. */
    const resolverProbe = await exec(`(() => {
      const before = {
        themeMode: localStorage.getItem("themeMode"),
        darkMode: localStorage.getItem("darkMode"),
        light: localStorage.getItem("themeLightScheme"),
        dark: localStorage.getItem("themeDarkScheme"),
        cls: document.body.classList.contains("dark-mode"),
        attr: document.body.getAttribute("data-theme"),
      };
      const realMM = window.matchMedia;
      window.matchMedia = (q) => ({
        matches: false, media: q,
        addEventListener() {}, removeEventListener() {},
        addListener() {}, removeListener() {},
      });

      const out = { before: before };
      try {
        localStorage.removeItem("themeMode");
        localStorage.setItem("darkMode", "enabled");
        localStorage.setItem("themeLightScheme", "parchment");
        localStorage.setItem("themeDarkScheme", "ember");

        const t = window.foliaThemes;
        out.exportsResolver = typeof window.resolveStoredMode;

        // The exact expression every scheme site used before unification.
        out.rawRead = localStorage.getItem("themeMode") || "desktop";
        out.rawResolved = t.resolveMode(out.rawRead);
        out.legacyKey = localStorage.getItem("darkMode");

        out.overlayMode = t.storedMode();
        out.rendererMode =
          typeof window.resolveStoredMode === "function"
            ? window.resolveStoredMode()
            : "NOT-EXPORTED";

        // Site: restoreExportScheme() in renderer.js, driven for real.
        document.body.removeAttribute("data-theme");
        window.restoreExportScheme();
        out.exportRestoreAttr = document.body.getAttribute("data-theme");

        // Site: setScheme() in custom-theme.js. Picking a LIGHT scheme while
        // the migrated mode is dark is the one input that separates the two
        // resolvers: with the raw read the mode is 'desktop', the stubbed OS
        // resolves light, keepFollowing is TRUE and 'themeMode' is left on
        // 'desktop'; with the migrated mode it is 'dark', keepFollowing is
        // false, and the pick concretely switches the app to light.
        t.setScheme("parchment");
        out.afterSetScheme = localStorage.getItem("themeMode");
      } catch (e) {
        out.error = String((e && e.message) || e);
      } finally {
        window.matchMedia = realMM;
        const put = (k, v) =>
          v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
        put("themeMode", before.themeMode);
        put("darkMode", before.darkMode);
        put("themeLightScheme", before.light);
        put("themeDarkScheme", before.dark);
        document.body.classList.toggle("dark-mode", before.cls);
        if (before.attr === null) document.body.removeAttribute("data-theme");
        else document.body.setAttribute("data-theme", before.attr);
      }
      return out;
    })()`);

    check(
      "10k: renderer.js exports resolveStoredMode for the overlay to consume",
      resolverProbe.exportsResolver === "function",
      `typeof window.resolveStoredMode = ${resolverProbe.exportsResolver}; ` +
        `without it custom-theme.js silently falls back to the raw read this section exists to remove`,
    );

    check(
      "10k: positive control: the pre-unification raw read really does disagree here",
      resolverProbe.legacyKey === "enabled" &&
        resolverProbe.rawRead === "desktop" &&
        resolverProbe.rawResolved === "light",
      `legacy=${resolverProbe.legacyKey} raw=${resolverProbe.rawRead} ` +
        `rawResolved=${resolverProbe.rawResolved} (want enabled/desktop/light; ` +
        `if these agree with the migrated answer the matchMedia stub failed and 10k proves nothing)`,
    );

    check(
      "10k: the overlay's stored-mode helper honours the legacy darkMode key",
      resolverProbe.overlayMode === "dark",
      `foliaThemes.storedMode() = ${resolverProbe.overlayMode}, want dark${resolverProbe.error ? ` [${resolverProbe.error}]` : ""}`,
    );

    check(
      "10k: the overlay and renderer.js resolve the SAME stored mode",
      resolverProbe.overlayMode === resolverProbe.rendererMode,
      `overlay=${resolverProbe.overlayMode} renderer=${resolverProbe.rendererMode}`,
    );

    check(
      "10k: restoreExportScheme() applies the scheme of the migrated mode",
      resolverProbe.exportRestoreAttr === "ember",
      `data-theme after restoreExportScheme() = ${resolverProbe.exportRestoreAttr}, want ember ` +
        `(parchment means a light scheme was applied under the dark class)`,
    );

    check(
      "10k: setScheme() decides Follow Desktop from the migrated mode",
      resolverProbe.afterSetScheme === "light",
      `themeMode after setScheme('parchment') = ${resolverProbe.afterSetScheme}, want light ` +
        `(desktop means keepFollowing was computed from the un-migrated 'desktop')`,
    );

    {
      let running = -1;
      for (let i = 0; i < 60; i++) {
        running = await settleTransitions();
        maxRunning = Math.max(maxRunning, running);
        if (running === 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      if (running !== 0) settleFailures.push(`10k resolver: ${running} still running`);
    }

    // ─── 10m. CHROME FIDELITY AGAINST THE BASELINE COMMIT ───────────────────
    /* THE HARD CONSTRAINT, FOR THE SURFACES THE GOLDEN NEVER REACHED. Both
       models of a review round independently reported the same gap and it was
       real: theme-golden.json's `surfaces` map holds exactly ten selectors,
       all of them `body` or `#viewer`. Every chrome surface this work
       TOKENISED - the header, the search panel and its buttons and counter,
       the loading overlay, the welcome buttons and icons, the update banner,
       the toggle track - had its literal replaced by a var() with nothing
       comparing the result to what the app used to paint. A one-digit typo in
       any of them ships silently under a requirement that says the two
       defaults must look exactly as they did.

       IT IS DERIVED, NOT LISTED, and that is the whole point. A hand-written
       table of "chrome tokens to check" is a subject list chosen by the same
       person who wrote the code, and this project has been bitten four times
       by coverage narrower than the claim it is named for. Instead the
       baseline stylesheets are read straight out of the pinned commit and
       EVERY declaration in them is the subject. A new tokenised surface joins
       this assertion by existing; nobody has to remember it.

       THE COMPARISON IS DONE AFTER SUBSTITUTION, not token by token. Some
       tokens hold only a fragment of the value they serve - the update
       banner's glow is `rgba(var(--accent-mode-glow-rgb), 0.3)` inside a
       box-shadow, and the tint is an alpha over a colour - so comparing token
       values would need a per-token rule about what the token means. Resolving
       the whole declaration and comparing the RESULT compares what is painted,
       which is the thing the requirement is actually about. The var values are
       read from the LIVE cascade in each frozen default, so a scheme leaking
       into a default fails this too. */
    const baselineCss = (f) =>
      execSync(`git show ${BASELINE_COMMIT}:src/${f}`, {
        cwd: path.join(__dirname, ".."),
        maxBuffer: 1 << 28,
      }).toString();
    /* A tiny stylesheet reader, deliberately not a CSS parser: it tracks brace
       depth, remembers the selector at each level and emits declarations. It
       only has to read two files this project controls. */
    const readDecls = (css) => {
      const s = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
      const out = [];
      const stack = [];
      let i = 0;
      let start = 0;
      const flush = (text) => {
        const m = /^([-A-Za-z0-9]+)\s*:\s*([\s\S]+)$/.exec(text.trim());
        if (!m) return;
        out.push({
          at: stack.filter((x) => x.startsWith("@")).join("|"),
          sel: stack.filter((x) => !x.startsWith("@")).join(" >> "),
          prop: m[1],
          val: m[2].trim().replace(/\s+/g, " "),
        });
      };
      while (i < s.length) {
        const ch = s[i];
        if (ch === "{") {
          stack.push(s.slice(start, i).trim().replace(/\s+/g, " "));
          i++;
          start = i;
          continue;
        }
        if (ch === "}") {
          /* FLUSH BEFORE POPPING. CSS does not require a semicolon after a
             block's LAST declaration, so discarding the pending text here
             silently dropped one declaration per such block from a sweep whose
             whole claim is that it re-resolves EVERY baseline declaration.
             Nothing would have failed: the declaration simply leaves the
             subject set, which is this project's most-repeated defect shape -
             a subject list narrower than the claim made about it. */
          flush(s.slice(start, i));
          stack.pop();
          i++;
          start = i;
          continue;
        }
        if (ch === ";") {
          flush(s.slice(start, i));
          i++;
          start = i;
          continue;
        }
        i++;
      }
      return out;
    };
    const CSS_FILES = ["styles.css", "custom-styles.css"];

    /* A UNIT PIN FOR THE PARSER, BECAUSE THE PROPERTY IS CURRENTLY UNREACHABLE
       IN THE REAL FILES AND THAT WAS MEASURED RATHER THAN ASSUMED. CSS does not
       require a semicolon after a block's last declaration, and this parser used
       to discard the pending text at `}` - silently dropping one declaration per
       such block from a sweep whose entire claim is that it re-resolves EVERY
       baseline declaration. Nothing would have failed; the declaration just
       leaves the subject set.
       Measured on both sides of the comparison: baseline styles.css 1569 /
       custom-styles.css 188, current 1946 / 198, and the parse is IDENTICAL with
       and without the flush - both trees are prettier-formatted, so every block
       already terminates its last declaration. So the fix is inert today and the
       end-to-end counts cannot pin it. The property is pinned here instead, at
       the unit level, exactly as R202 and R372 were: an unreachable guard is
       still a contract, and the first hand-edited rule that omits a trailing
       semicolon makes it reachable with no warning. */
    const UNTERMINATED = "body { color: #010203 }\n.x { background: #040506;\n  border-color: #070809 }\n";
    const unitDecls = readDecls(UNTERMINATED);
    const unitKeys = unitDecls.map((d) => `${d.sel}|${d.prop}|${d.val}`);
    check(
      "10m: the declaration parser reads a block's last declaration when it has no trailing semicolon",
      unitKeys.length === 3 &&
        unitKeys.includes("body|color|#010203") &&
        unitKeys.includes(".x|background|#040506") &&
        unitKeys.includes(".x|border-color|#070809"),
      `parsed ${unitKeys.length}: ${JSON.stringify(unitKeys)}`,
    );

    const oldDecls = CSS_FILES.flatMap((f) => readDecls(baselineCss(f)).map((d) => ({ ...d, file: f })));
    const newDecls = CSS_FILES.flatMap((f) =>
      readDecls(fs.readFileSync(path.join(__dirname, "..", "src", f), "utf8")).map((d) => ({ ...d, file: f })),
    );
    const declKey = (d) => `${d.file}##${d.at}##${d.sel}##${d.prop}##${d.n}`;
    /* THE OCCURRENCE INDEX IS LOAD-BEARING AND IT WAS ADDED AFTER A FALSE
       POSITIVE, not before. Without it this comparison reported eight font
       changes that never happened: an @font-face block has no selector, so all
       five of them collapsed onto one key and each `src` was compared against
       whichever block happened to be read last. Numbering repeated
       (file, at-rule, selector, property) triples in document order pairs each
       block with its own counterpart. This is the third time in this project
       that an audit produced a confident wrong answer from a contaminated key -
       and the second time in this section alone. */
    const numberDecls = (list) => {
      const seen = new Map();
      for (const d of list) {
        const k = `${d.file}##${d.at}##${d.sel}##${d.prop}`;
        const n = seen.get(k) || 0;
        d.n = n;
        seen.set(k, n + 1);
      }
      return list;
    };
    numberDecls(oldDecls);
    numberDecls(newDecls);
    const newByKey = new Map(newDecls.map((d) => [declKey(d), d]));
    // A dark override that gets tokenised loses its `body.dark-mode ` prefix -
    // the value moves into the variable and the rule de-scopes to serve both
    // modes. That is the only rewrite shape this change used, so it is the
    // only one matched here; anything else lands in the unmatched ledger.
    const newBySel = new Map(newDecls.map((d) => [`${d.sel}##${d.prop}`, d]));
    const deScope = (sel) =>
      sel
        .split(", ")
        .map((x) => x.replace(/^(body)?\.dark-mode\s+/, ""))
        .filter((x, i, a) => a.indexOf(x) === i)
        .join(", ");

    // Live variable tables, one per frozen default, read from the cascade.
    const varsFor = async (mode) => {
      await applySettled(mode, null, `10m: read the ${mode} default's variables`);
      return JSON.parse(
        await exec(`(() => {
          const cs = getComputedStyle(document.body);
          const out = {};
          for (const sheet of document.styleSheets) {
            let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
            for (const r of rules || []) {
              if (!r.style) continue;
              for (const p of r.style) {
                if (p.startsWith('--') && !(p in out)) out[p] = cs.getPropertyValue(p).trim();
              }
            }
          }
          return JSON.stringify(out);
        })()`),
      );
    };
    const liveVars = { light: await varsFor("light"), dark: await varsFor("dark") };

    const subst = (val, mode, depth = 0) => {
      if (depth > 10) return val;
      return val.replace(
        /var\(\s*(--[A-Za-z0-9-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g,
        (m, name, fb) => {
          const v = liveVars[mode][name];
          if (v !== undefined && v !== "") return subst(v, mode, depth + 1);
          return fb !== undefined ? subst(fb.trim(), mode, depth + 1) : `<<UNRESOLVED:${name}>>`;
        },
      );
    };
    // Chromium hands back rgb()/rgba() from the cascade while the baseline
    // baked hex, and it drops a redundant alpha of 1. Comparing raw text would
    // report every single tokenised declaration as drift.
    const toRgb = (h) => {
      const s = h.length === 4 ? h[1] + h[1] + h[2] + h[2] + h[3] + h[3] : h.slice(1);
      return `rgb(${parseInt(s.slice(0, 2), 16)},${parseInt(s.slice(2, 4), 16)},${parseInt(s.slice(4, 6), 16)})`;
    };
    const normCss = (v) =>
      v
        .toLowerCase()
        .replace(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/g, toRgb)
        .replace(/\s+/g, "")
        .replace(/rgba?\(([^)]*)\)/g, (m, inner) => {
          const p = inner.split(",").map((x) => x.trim());
          if (p.length === 4 && (p[3] === "1" || p[3] === "1.0")) p.pop();
          return `rgb(${p.join(",")})`;
        });

    const sameSelDrift = [];
    const deScopedDrift = [];
    const unmatched = [];
    let sameSelSeen = 0;
    let deScopedSeen = 0;
    for (const o of oldDecls) {
      if (o.prop.startsWith("--")) continue;
      if (/\[data-theme/.test(o.sel)) continue;
      if (/var\(/.test(o.val)) continue;
      const mode = /\.dark-mode/.test(o.sel) ? "dark" : "light";
      const survivor = newByKey.get(declKey(o));
      if (survivor) {
        sameSelSeen++;
        const got = subst(survivor.val, mode);
        if (normCss(got) !== normCss(o.val))
          sameSelDrift.push(`{${o.sel}} ${o.prop}: was ${o.val}, now ${survivor.val} => ${got}`);
        continue;
      }
      const moved = newBySel.get(`${deScope(o.sel)}##${o.prop}`);
      if (moved && /var\(/.test(moved.val)) {
        deScopedSeen++;
        const got = subst(moved.val, mode);
        if (normCss(got) !== normCss(o.val))
          deScopedDrift.push(`{${o.sel}} ${o.prop}: was ${o.val}, now {${moved.sel}} ${moved.val} => ${got}`);
        continue;
      }
      unmatched.push(`${o.file} {${o.sel}} ${o.prop}: ${o.val}`);
    }
    /* THE FLOOR IS THE MEASURED CORPUS, NOT A ROUND NUMBER. This shipped as
       `>= 700` against a real 1455 - a guard that would stay green with 755
       baseline declarations, more than half the corpus, silently no longer
       being compared (a readDecls regression on a nesting shape, one sheet
       failing to load, a selector-normalisation change) while still claiming
       chrome fidelity. That is the same magic-floor disease as the `>= 30`
       and `>= 200` retied to `>= 62`/`>= 632` below, and the `>= 4` against 9
       that R340 exposed. Pinned just under the measurement so a deliberate
       addition moves it, and the count is printed either way. */
    const SAME_SEL_MIN = 1440; // measured: 1455
    console.log(`      10m measured: ${sameSelSeen} same-selector, ${deScopedSeen} de-scoped`);
    check(
      "10m: every baseline declaration that kept its selector still paints the baseline value",
      sameSelDrift.length === 0 && sameSelSeen >= SAME_SEL_MIN,
      `${sameSelSeen} baseline declaration(s) re-resolved through the live cascade, ${sameSelDrift.length} drifted${
        sameSelDrift.length ? ": " + sameSelDrift.join(" | ") : ""
      }`,
    );
    check(
      "10m: every dark override this work tokenised still paints the baseline value through its token",
      deScopedDrift.length === 0 && deScopedSeen >= 20,
      `${deScopedSeen} tokenised dark override(s) re-resolved, ${deScopedDrift.length} drifted${
        deScopedDrift.length ? ": " + deScopedDrift.join(" | ") : ""
      }`,
    );
    /* THE POSITIVE CONTROL, because the two assertions above are absence
       checks over a DERIVED subject list and this project has been bitten four
       times by an absence check that failed open. If the reader stopped
       reading, or substitution stopped substituting, or normalisation started
       calling everything equal, both would report a clean sweep over nothing.
       This pushes a value that is known to be wrong through the identical
       pipeline and requires it to be caught. */
    const controlDecl = { sel: ".header", prop: "background", val: "var(--header-bg)" };
    const controlGot = subst(controlDecl.val, "dark");
    check(
      "10m: the fidelity comparison can actually detect a changed value (positive control)",
      normCss(controlGot) === normCss("#2d2d2d") && normCss(controlGot) !== normCss("#2d2d2e"),
      `--header-bg resolves to ${controlGot} in the dark default; it must equal the baseline #2d2d2d and must NOT compare equal to a one-digit change`,
    );
    /* THE REMAINDER, CLASSIFIED BY REASON RATHER THAN COUNTED. A baseline
       declaration that neither kept its selector nor de-scoped is not
       necessarily a regression - most are the vendored dark Prism rules, whose
       grouped selectors were replaced wholesale by the --tok-* system that the
       golden's token tuples pin far more precisely than a selector match could.
       What must not happen is a NEW surface quietly joining that remainder.
       A bare total would let one removal cancel one addition, which is exactly
       the substitution that caught out the README section list, so each removal
       is bucketed by the reason it is excused and every bucket is pinned. An
       unclassified remainder fails by name. */
    const REMOVAL_REASONS = [
      {
        why: "vendored dark Prism rules, replaced by the --tok-* cells the golden pins directly",
        match: (u) => /\.token\.|code\[class\*=language-\]/.test(u),
        count: 10,
      },
      {
        why: "dark welcome accents, tokenised onto --welcome-accent at a de-scoped selector",
        match: (u) => /\.dark-mode \.welcome-/.test(u),
        count: 3,
      },
      {
        why: "the old ::before tick markup, replaced by the tick gutter this work added",
        match: (u) => /\.custom-theme-option/.test(u),
        count: 6,
      },
      {
        why: "a border-color longhand replaced by a border shorthand holding a var()",
        match: (u) => /\{body\.dark-mode \.search-btn\} border-color/.test(u),
        count: 1,
      },
    ];
    const unclassified = unmatched.filter((u) => !REMOVAL_REASONS.some((r) => r.match(u)));
    const badBuckets = REMOVAL_REASONS.filter((r) => unmatched.filter(r.match).length !== r.count).map(
      (r) => `${r.why}: ${unmatched.filter(r.match).length} (recorded ${r.count})`,
    );
    check(
      "10m: every baseline declaration that no longer matches any rule is a recorded removal",
      unclassified.length === 0 && badBuckets.length === 0,
      `${unmatched.length} unmatched total; ${unclassified.length} unclassified${
        unclassified.length ? ": " + unclassified.join(" | ") : ""
      }${badBuckets.length ? "; bucket drift: " + badBuckets.join("; ") : ""}`,
    );

    /* ── 10o. THE MODE ROWS AND THE OS-FOLLOWING PATH ──────────────────────
       BOTH REVIEWERS FOUND THIS HOLE INDEPENDENTLY, from opposite ends. The
       whole of 10j drives `.custom-scheme-option` rows and nothing had ever
       clicked a `.custom-theme-option` (mode) row, so applyTheme() through a
       real click, the tick moving, and the dismissal after a mode pick were
       unproven; and the `change` listener init() registers on the OS media
       query had no coverage of any kind, so a reader on "Follow Desktop"
       could stop following at sunset with every assertion green.

       THE OS FLIP IS REAL, NOT STUBBED. window.matchMedia returns a fresh
       MediaQueryList per call, so dispatching `change` on a new instance would
       not reach the listener the product registered on ITS instance - the test
       would pass against a copy of the mechanism rather than the mechanism.
       Emulation.setEmulatedMedia flips prefers-color-scheme in the engine, so
       the real listener fires for the real reason. That is also why this
       section owns its own debugger attach/detach rather than borrowing
       10i's: the two must not overlap. */
    /* THE MODE ROWS, DRIVEN AS A READER DRIVES THEM. Nothing had ever clicked
       a `.custom-theme-option`: all of 10j drives scheme rows, so applyTheme()
       through a real click, the tick moving between the three rows, and the
       "Follow Desktop" row - the only one whose mode is not a scheme mode and
       the only one that reaches resolveMode()'s matchMedia branch from the
       menu - were unproven end to end. applyTheme is deliberately NOT exported
       on window.foliaThemes, so clicking is not merely the realistic path, it
       is the only one.

       THE SNAPSHOT IS TAKEN HERE, BEFORE THE FIRST CLICK, not further down
       where the OS block needs it: the mode loop WRITES themeMode, so a
       snapshot taken after it would restore the section's own "desktop"
       rather than what this section inherited. */
    const before = JSON.parse(
      await exec(`(() => JSON.stringify({
        themeMode: localStorage.getItem("themeMode"),
        light: localStorage.getItem("themeLightScheme"),
        dark: localStorage.getItem("themeDarkScheme"),
      }))()`),
    );
    const modeRows = [];
    for (const want of ["light", "dark", "desktop"]) {
      /* THE FULL MENU PATH, exactly as 10j opens it for the scheme rows. A
         bare mouseenter on #customThemeMenuItem is not enough: the submenu
         panel only exists on screen once the hamburger and View menu above it
         are open, so elementFromPoint finds nothing and the row is reported
         unreachable - which is what a first attempt at this measured. */
      const opened = JSON.parse(await exec(MENU_PATH_PROBE));
      if (opened.missing.length || opened.unreachable.length) {
        modeRows.push({
          want,
          found: false,
          openBefore: false,
          reachable: false,
          why: `path: missing=[${opened.missing}] unreachable=[${opened.unreachable}]`,
        });
        continue;
      }
      const r = JSON.parse(
        await exec(`(() => {
          const item = document.getElementById('customThemeMenuItem');
          const row = document.querySelector('.custom-theme-option[data-mode="${want}"]');
          if (!row || !item) return JSON.stringify({ found: false });
          /* THE PANEL MUST BE OPEN BEFORE THE CLICK, or the "dismisses the
             menu" clause is an absence check over an already-empty set:
             nothing between 10j's last row click and here re-opens the
             submenu, so theme-open was false before the click as well as
             after, and R400 - deleting closeMenu() from this very branch -
             could not fail. Found by both reviewers independently. */
          const openBefore = item.classList.contains('theme-open');
          /* HIT-TESTED, NOT JUST CLICKED, for the same reason 10j hit-tests
             its scheme rows: a bare .click() fires on a row that is covered,
             clipped out of the panel or zero-sized, so "a reader can click
             this" stays unproven. The MODE rows had never been hit-tested at
             all. */
          const b = row.getBoundingClientRect();
          const hit = b.width < 1 || b.height < 1
            ? null
            : document.elementFromPoint(
                Math.round(b.left + b.width / 2),
                Math.round(b.top + b.height / 2),
              );
          const reachable = !!hit && (hit === row || row.contains(hit));
          if (reachable) row.click();
          return JSON.stringify({ found: true, openBefore, reachable });
        })()`),
      );
      if (!r.found || !r.reachable) {
        modeRows.push({ want, found: r.found, openBefore: r.openBefore, reachable: r.reachable });
        continue;
      }
      await new Promise((res) => setTimeout(res, 120));
      modeRows.push({
        want,
        found: true,
        openBefore: r.openBefore,
        reachable: r.reachable,
        ...JSON.parse(
          await exec(`(() => {
            const ticked = [...document.querySelectorAll('.custom-theme-option')]
              .filter((e) => e.classList.contains('active'))
              .map((e) => e.dataset.mode);
            return JSON.stringify({
              stored: localStorage.getItem('themeMode'),
              dark: document.body.classList.contains('dark-mode'),
              attr: document.body.getAttribute('data-theme'),
              ticked: ticked,
              open: document.getElementById('customThemeMenuItem').classList.contains('theme-open'),
            });
          })()`),
        ),
      });
    }
    const modeMisses = modeRows
      .filter(
        (m) =>
          !m.found ||
          !m.openBefore ||
          !m.reachable ||
          m.stored !== m.want ||
          m.ticked.join() !== m.want ||
          m.open,
      )
      .map(
        (m) =>
          `${m.want}: found=${m.found} openBefore=${m.openBefore} reachable=${m.reachable} stored=${m.stored} ticked=[${(m.ticked || []).join(",")}] stillOpen=${m.open}`,
      );
    check(
      "10o: clicking each mode row stores that mode, moves the tick to it alone, and dismisses the menu",
      modeRows.length === 3 && modeMisses.length === 0,
      `${modeMisses.join(" | ") || "no misses"} - exactly one row may carry the tick, and "desktop" is the row no other test reaches`,
    );
    const darkMisses = modeRows
      .filter((m) => m.found && m.want !== "desktop" && m.dark !== (m.want === "dark"))
      .map((m) => `${m.want} -> dark=${m.dark}`);
    check(
      "10o: a mode row click actually repaints the app, not just the preference",
      darkMisses.length === 0 && modeRows.filter((m) => m.found).length === 3,
      `${darkMisses.join(" | ") || "no misses"} - applyTheme() delegates the class to the original toggle, so a stored preference with an unchanged class is the failure this catches`,
    );

    const osProbe = { steps: [], error: null };
    let osAttached = false;
    try {
      win.webContents.debugger.attach("1.3");
      osAttached = true;
      const emulate = (value) =>
        win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value }],
        });
      /* The snapshot this restores from is taken ABOVE, before the mode loop's
         first click - taking it here would capture the "desktop" this section
         itself stored and restore the wrong value. */
      try {        /* THE BASELINE FLIP IS SETUP, NOT A MEASUREMENT. setEmulatedMedia only
           fires `change` when the value actually CHANGES, so if this machine's
           real preference already matches the first asserted value the
           listener never runs and the reading is just leftover state - which
           is exactly what the first draft of this section measured. Emulating
           light here makes the first asserted flip a genuine transition on any
           machine. */
        await exec(`(() => {
          localStorage.setItem("themeMode", "desktop");
          localStorage.setItem("themeLightScheme", "clarity");
          localStorage.setItem("themeDarkScheme", "abyss");
          window.__foliaOsFlips = 0;
          window.matchMedia("(prefers-color-scheme: dark)")
            .addEventListener("change", () => { window.__foliaOsFlips++; });
          return 1;
        })()`);
        await emulate("light");
        await waitFor(
          exec,
          `!document.body.classList.contains("dark-mode")`,
          "10o: the app to settle to the light baseline",
        );
        /* THE COUNTER IS ZEROED AFTER THE BASELINE FLIP, NOT BEFORE IT: the
           baseline is setup, and whether it counts depends on what this
           machine's real preference happens to be, which would make the pin
           below machine-dependent. From here on every increment is one of the
           three asserted flips. */
        await exec(`(() => { window.__foliaOsFlips = 0; return 1; })()`);
        for (const want of ["dark", "light", "dark"]) {
          await emulate(want);
          await waitFor(
            exec,
            `document.body.classList.contains("dark-mode") === ${JSON.stringify(want === "dark")}`,
            `10o: the app to follow the OS to ${want}`,
          );
          osProbe.steps.push({
            want,
            ...JSON.parse(
              await exec(`(() => JSON.stringify({
                dark: document.body.classList.contains("dark-mode"),
                attr: document.body.getAttribute("data-theme"),
                stored: localStorage.getItem("themeMode"),
              }))()`),
            ),
          });
        }
        osProbe.loopFlips = JSON.parse(
          await exec(`(() => JSON.stringify(window.__foliaOsFlips))()`),
        );
        /* THE NEGATIVE HALF: a reader who has PINNED a mode must not be
           dragged around by the OS. Without this the assertion above is
           satisfied by a listener that re-applies unconditionally, which is a
           different and worse bug than not listening at all. Pinned through
           the row rather than a function call, for the same reason as above.

           THE OS MUST BE PUT BACK TO LIGHT FIRST, and the omission was caught
           by R401 coming back VACUOUS rather than by reading. The flip loop
           above ends on "dark", so re-emulating dark here is a NO-OP -
           setEmulatedMedia fires `change` only on an actual value change - and
           the assertion was passing because the listener never ran at all,
           not because the guard held. Second instance of this exact trap in
           this one section. The counter is what stops it coming back a third
           time: CDP emulation is an ENGINE-LEVEL media change, so the
           listener installed before the loop above receives the same event
           the product's own listener receives, and a zero count means the
           flip never happened. It is reset rather than re-registered, because
           registering a second listener on a second MediaQueryList would
           double-count every flip. */
        await emulate("light");
        await waitFor(
          exec,
          `!document.body.classList.contains("dark-mode")`,
          "10o: the app to settle to light before the mode is pinned",
        );
        await exec(`(() => {
          window.__foliaOsFlips = 0;
          document.querySelector('.custom-theme-option[data-mode="light"]').click();
          return 1;
        })()`);
        /* LEFT AS A FIXED WAIT DELIBERATELY, unlike the four above. Those
           follow an emulate() and wait on an ASYNCHRONOUS engine event, which
           is a genuine bet on machine load. This one follows a row click whose
           handler runs SYNCHRONOUSLY, so the exec() round trip that comes next
           is already a task boundary and there is nothing to race. It is kept
           rather than deleted because removing it is an unproven behaviour
           change days from a release; it is annotated so it does not read as
           an oversight the next time this file is swept for sleeps. */
        await new Promise((r) => setTimeout(r, 120));
        await emulate("dark");
        /* THE NEGATIVE HALF HAS NO POSITIVE DOM SIGNAL TO WAIT ON - the whole
           claim is that NOTHING moves - so waiting on the app would be waiting
           for something that must never happen, i.e. a fixed sleep wearing a
           predicate's clothes. The flip COUNTER is the honest structural
           signal: it proves the engine really delivered the media change to a
           listener registered exactly like the product's, which is the
           precondition the assertion needs. A fixed sleep here was a bet on
           machine load, and under full-chain load losing that bet would have
           reported the guard as holding when the event had simply not arrived
           yet - the same shape as the R401 no-op trap this section already
           carries a counter for. */
        await waitFor(
          exec,
          `window.__foliaOsFlips >= 1`,
          "10o: the emulated OS flip to reach a media-query listener",
        );
        osProbe.pinned = JSON.parse(
          await exec(`(() => JSON.stringify({
            dark: document.body.classList.contains("dark-mode"),
            attr: document.body.getAttribute("data-theme"),
            stored: localStorage.getItem("themeMode"),
            flips: window.__foliaOsFlips,
          }))()`),
        );

        /* THE keepFollowing === TRUE BRANCH, which nothing reached. setScheme()
           normally switches the app to the chosen scheme's MODE; the one
           exception is a reader on Follow Desktop choosing a scheme whose mode
           the OS is already resolving to, where the choice must be recorded
           WITHOUT pinning the mode. Its own comment calls this out - "otherwise
           choosing a dark scheme at night would silently pin the app to dark
           for good" - and only the FALSE side was covered, with the true side
           appearing solely as a counterfactual in that comment. Driven here
           for real rather than against a stubbed matchMedia: Follow Desktop,
           OS resolving dark, pick a DARK scheme. */
        await exec(`(() => {
          document.querySelector('.custom-theme-option[data-mode="desktop"]').click();
          return 1;
        })()`);
        await new Promise((r) => setTimeout(r, 120));
        await exec(`(() => {
          document.querySelector('.custom-scheme-option[data-scheme="ember"]').click();
          return 1;
        })()`);
        await new Promise((r) => setTimeout(r, 120));
        osProbe.keepFollowing = JSON.parse(
          await exec(`(() => JSON.stringify({
            stored: localStorage.getItem("themeMode"),
            attr: document.body.getAttribute("data-theme"),
            dark: document.body.classList.contains("dark-mode"),
            remembered: localStorage.getItem("themeDarkScheme"),
          }))()`),
        );
      } finally {
        await win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "" }],
        });
        await exec(
          `(() => {
            const put = (k, v) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v));
            put("themeMode", ${JSON.stringify(before.themeMode)});
            put("themeLightScheme", ${JSON.stringify(before.light)});
            put("themeDarkScheme", ${JSON.stringify(before.dark)});
            return 1;
          })()`,
        );
      }
    } catch (e) {
      osProbe.error = String((e && e.message) || e);
    } finally {
      if (osAttached) {
        try { win.webContents.debugger.detach(); } catch (e) {}
      }
    }

    const osMisses = osProbe.steps
      .filter(
        (s) =>
          s.dark !== (s.want === "dark") ||
          s.attr !== (s.want === "dark" ? "abyss" : "clarity") ||
          s.stored !== "desktop",
      )
      .map((s) => `OS->${s.want} gave dark=${s.dark} data-theme=${s.attr} stored=${s.stored}`);
    check(
      "10o: on Follow Desktop, a real OS colour-scheme change re-themes the app and picks that mode's remembered scheme",
      osProbe.steps.length === 3 && osMisses.length === 0 && !osProbe.error,
      `${osProbe.steps.length}/3 flips; ${osMisses.join(" | ") || "no misses"}${osProbe.error ? ` [${osProbe.error}]` : ""} - the listener is registered on init()'s own MediaQueryList, so this drives prefers-color-scheme in the engine rather than dispatching a synthetic event at a fresh instance`,
    );
    check(
      "10o: positive control: the OS really did flip three times, so the assertion above is not reading a constant",
      osProbe.loopFlips === 3,
      `the page's own matchMedia listener saw ${osProbe.loopFlips} change event(s), expected 3 - the previous form of this control compared the observed data-theme values to each other, which the assertion above ALREADY pins per want, so it could only fail when that assertion had failed too; this counts engine-level media changes instead, which is the thing that can silently not happen`,
    );
    check(
      "10o: a pinned mode is NOT dragged around by the OS",
      !!osProbe.pinned &&
        osProbe.pinned.dark === false &&
        osProbe.pinned.stored === "light" &&
        osProbe.pinned.flips >= 1,
      `after pinning light and flipping the OS to dark: ${JSON.stringify(osProbe.pinned)} - a listener that re-applies unconditionally would follow the OS here and is a worse bug than one that never fires; flips is the positive control, because setEmulatedMedia only raises a change event on a real value change and a no-op flip makes this assertion pass for the worst possible reason`,
    );
    check(
      "10o: choosing a scheme whose mode the OS already resolves to records it WITHOUT pinning the mode",
      !!osProbe.keepFollowing &&
        osProbe.keepFollowing.stored === "desktop" &&
        osProbe.keepFollowing.remembered === "ember" &&
        osProbe.keepFollowing.attr === "ember" &&
        osProbe.keepFollowing.dark === true,
      `on Follow Desktop with the OS dark, clicking the ember (dark) row gave ${JSON.stringify(osProbe.keepFollowing)} - the choice must be remembered and painted while "desktop" survives, or picking a dark scheme at night silently pins the app to dark for good`,
    );

    // ─── 10n. THE TOGGLE SWITCH, THE ONE THEMED CONTROL WITH NO TEXT ────────
    /* IT HAD NO ASSERTION AT ALL AND IT SHIPPED STOCK LIGHT BLUE UNDER EVERY
       SCHEME. `.tools-toggle-item.active .tools-toggle-track` was a hardcoded
       #4fc3f7 - a colour belonging to no palette in this product - so every
       scheme painted the same sky blue against its own menu. No prior section
       could see it: it carries no text, so the contrast sweeps score nothing
       on it; it is not a hover or focus rule, so 10g never collects it; and it
       is not an accent literal, so the stranded-accent sweep does not know the
       value.

       IT IS SCORED AGAINST WCAG 1.4.11 (3:1, non-text contrast), which is the
       APPLICABLE standard - deliberately not 4.5:1 "to be safe", because a
       bar the standard never set would reject a future scheme for no reason.
       FOUR relations, and all four are needed: a track that disappears into
       the menu cannot be found, a track that disappears into the menu's HOVER
       fill cannot be found while the reader is pointing at it, a track that
       disappears behind its own thumb cannot be read, and an ON track that
       matches the OFF track carries no information at all, which is the
       entire job of a switch.

       THE UNIQUENESS CLAUSE HAS TWO HALVES AND ONLY THE FIRST WAS OBVIOUS.
       Distinctness across the four schemes catches one scheme copying
       ANOTHER's track. It does NOT catch the realistic accident - a scheme
       that was never given a track at all and inherits the frozen default's
       stock blue - because that value is distinct from all four. R389 came
       back WRONG-GUARD on exactly that hole: it pointed abyss back at
       #4fc3f7 and the set stayed size 4. Hence the explicit FROZEN_TOGGLE
       comparison beside it. */
    const TOGGLE_MIN = 3.0;
    const FROZEN_TOGGLE = "rgb(79, 195, 247)";
    const TOGGLE_STATES = [
      ["light", null, "light default"],
      ["dark", null, "dark default"],
      ...SCHEME_STATES.map(([m, s]) => [m, s, s]),
    ];
    const toggleCells = [];
    for (const [mode, scheme, name] of TOGGLE_STATES) {
      await applySettled(mode, scheme, `10n: ${name}`);
      toggleCells.push({
        name,
        frozen: !scheme,
        ...JSON.parse(
          await exec(`(() => {
            /* MEASURE THE PAINTED CONTROL, NOT THE TOKEN. This block used to
               read --toggle-on-bg off <body> and paint it onto a throwaway
               div, which is the same disjunction 10l already corrected for
               --code-selection-bg ("THE FILL IS READ FROM THE CASCADE, NOT
               FROM THE VARIABLE"): a higher-specificity
               body[data-theme=...] .tools-toggle-item.active .tools-toggle-track
               override would leave this green while the switch painted
               something else, and 10m would see no drift because the base rule
               is untouched.

               #fullscreenToggle is the subject on purpose - it is the ONLY
               user-visible toggle switch left in the app. #darkModeToggle is
               display:none'd by custom-theme.js (this feature replaced it) and
               #showNotesToggle carries an inline display:none. The .active
               class is forced rather than waited for: it is cosmetic here (it
               does not enter fullscreen), and in a test window fullscreen is
               off, so no toggle would otherwise be in the on state at all.

               Nothing here falls back. A missing element reports null and the
               assertions below fail loudly, rather than silently rescoring
               against <body> and reporting the page as if it were the menu. */
            const menu = document.getElementById('viewMenu');
            const item = document.getElementById('fullscreenToggle');
            const track = item && item.querySelector('.tools-toggle-track');
            const thumb = item && item.querySelector('.tools-toggle-thumb');
            const hadActive = item ? item.classList.contains('active') : false;
            const read = (el) => (el ? getComputedStyle(el).backgroundColor : null);

            let on = null, off = null;
            /* THE CLASS FLIP AND THE READ ARE SYNCHRONOUS, AND .tools-toggle-
               track CARRIES a 0.2s background transition. That pairing is the
               shape that produced a fully-formed wrong measurement elsewhere in
               this project: a colour read while a transition is running is the
               PREVIOUS state's colour, and it is indistinguishable from a real
               value. Here it is safe, but only for a reason that is nothing to
               do with this code - the View submenu is display:none while shut,
               so the track has no box and no transition can run on it, while
               getComputedStyle still resolves its colours exactly as it does
               for a painted element.
               That is accidental safety, so it is MEASURED rather than relied
               on: transitionsRunning is captured across both reads and pinned
               by an assertion below. A future edit that opens the menu before
               this section - which is exactly what 10o now does for the mode
               rows - would otherwise silently turn these four ratios into
               transients. */
            const runningOn = () =>
              (document.getAnimations ? document.getAnimations() : []).filter(
                (a) =>
                  a.effect &&
                  a.effect.target === track &&
                  a.constructor &&
                  a.constructor.name === 'CSSTransition',
              ).length;
            let transitionsRunning = 0;
            if (track) {
              item.classList.add('active');
              on = read(track);
              transitionsRunning += runningOn();
              item.classList.remove('active');
              off = read(track);
              transitionsRunning += runningOn();
              if (hadActive) item.classList.add('active');
            }
            const thumbBg = thumb ? (item.classList.add('active'), read(thumb)) : null;
            if (!hadActive && item) item.classList.remove('active');

            /* The hover fill is sourced from the hover RULE rather than
               assumed to be --bg-secondary, so retargeting that rule at a
               different token is visible here. :hover cannot be forced, so the
               rule's own declared value is resolved through a probe. */
            let hoverDecl = null;
            for (const sheet of document.styleSheets) {
              let rules; try { rules = sheet.cssRules; } catch (e) { continue; }
              for (const r of rules || []) {
                if (r.selectorText && /\\.tools-menu-item:hover(?![\\w-])/.test(r.selectorText)) {
                  const v = r.style.getPropertyValue('background') || r.style.getPropertyValue('background-color');
                  if (v) hoverDecl = v.trim();
                }
              }
            }
            let hoverBg = null;
            if (hoverDecl) {
              const probe = document.createElement('div');
              (menu || document.body).appendChild(probe);
              probe.style.background = hoverDecl;
              hoverBg = getComputedStyle(probe).backgroundColor;
              probe.remove();
            }
            return JSON.stringify({
              on, off, thumbBg,
              transitionsRunning,
              trackHasBox: track ? !!track.getClientRects().length : null,
              menuBg: read(menu),
              hoverBg, hoverDecl,
              foundMenu: !!menu, foundTrack: !!track, foundThumb: !!thumb,
            });
          })()`),
        ),
      });
    }
    const toggleScore = (a, b) => {
      const p = (c) => {
        const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
        return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
      };
      const L = (c) => {
        const f = (v) => {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const x = p(a);
      const y = p(b);
      if (!x || !y) return null;
      const l1 = L(x);
      const l2 = L(y);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    /* The thumb is MEASURED, not assumed white. Naming an assertion for the
       thumb while hardcoding rgb(255,255,255) decouples it from
       .tools-toggle-thumb's actual fill: retint or tokenise that rule and this
       kept certifying a byte-exactness that was no longer true. */
    for (const c of toggleCells) {
      c.vsThumb = toggleScore(c.on, c.thumbBg);
      c.vsMenu = toggleScore(c.on, c.menuBg);
      c.vsHover = toggleScore(c.on, c.hoverBg);
      c.vsOff = toggleScore(c.on, c.off);
    }
    const toggleResolved = toggleCells.filter(
      (c) => c.foundMenu && c.foundTrack && c.foundThumb && c.hoverBg,
    );
    check(
      "10n: no CSS transition was running on the toggle track while its colours were read",
      toggleCells.length > 0 &&
        toggleCells.every((c) => c.transitionsRunning === 0) &&
        toggleCells.every((c) => c.trackHasBox === false),
      toggleCells
        .map(
          (c) =>
            `${c.name}: running=${c.transitionsRunning} hasBox=${c.trackHasBox}`,
        )
        .join("; "),
    );
    check(
      "10n: every toggle surface resolved to a real element (the scores below are not measuring <body>)",
      toggleResolved.length === toggleCells.length && toggleCells.length > 0,
      `${toggleResolved.length}/${toggleCells.length} state(s) resolved #viewMenu + #fullscreenToggle's track and thumb + the .tools-menu-item:hover fill; unresolved: ${toggleCells
        .filter((c) => !(c.foundMenu && c.foundTrack && c.foundThumb && c.hoverBg))
        .map((c) => `${c.name}(menu=${c.foundMenu} track=${c.foundTrack} thumb=${c.foundThumb} hover=${c.hoverDecl})`)
        .join(", ") || "none"}`,
    );
    const toggleNote = toggleCells
      .map(
        (c) =>
          `${c.name} on=${c.on} thumb=${c.vsThumb == null ? "?" : c.vsThumb.toFixed(2)} menu=${
            c.vsMenu == null ? "?" : c.vsMenu.toFixed(2)
          } hover=${c.vsHover == null ? "?" : c.vsHover.toFixed(2)} off=${c.vsOff == null ? "?" : c.vsOff.toFixed(2)}`,
      )
      .join("; ");
    console.log(`      10n measured: ${toggleNote}`);
    check(
      "10n: the toggle track is a themed colour in every state, not one hardcoded blue",
      toggleCells.length === TOGGLE_STATES.length &&
        new Set(toggleCells.filter((c) => !c.frozen).map((c) => c.on)).size ===
          toggleCells.filter((c) => !c.frozen).length &&
        toggleCells.filter((c) => !c.frozen).every((c) => c.on !== FROZEN_TOGGLE),
      `${toggleCells.length} state(s) measured; scheme tracks: ${toggleCells
        .filter((c) => !c.frozen)
        .map((c) => `${c.name}=${c.on}`)
        .join(", ")} - a repeat means one scheme is inheriting another palette's switch, and ${FROZEN_TOGGLE} means a scheme never left the frozen default's stock blue at all`,
    );
    check(
      "10n: every scheme's toggle track meets WCAG 1.4.11 (3:1) against the thumb, the menu, the hover fill and the off state",
      toggleCells
        .filter((c) => !c.frozen)
        .every(
          (c) =>
            c.vsThumb >= TOGGLE_MIN &&
            c.vsMenu >= TOGGLE_MIN &&
            c.vsHover >= TOGGLE_MIN &&
            c.vsOff >= TOGGLE_MIN,
        ),
      `note: ${toggleNote}`,
    );
    /* THE LIGHT DEFAULT FAILS THREE OF THE FOUR RELATIONS AND IS PINNED, NOT
       BARRED. Stock #4fc3f7 measures 2.00:1 against its own white thumb in
       both modes, 1.84:1 against the LIGHT menu, and 1.30:1 against its own
       OFF track - a switch that is nearly invisible against the surface it
       sits on and barely distinguishable from its own off state.
       Both defaults are preserved byte-exact because the requirement freezing
       them outranks this bar.
       Writing that as an excusal from the bar would pardon any future value
       that also failed it, so the measured ratios are pinned instead: the
       defaults may keep exactly the appearance they shipped with and nothing
       else. A degradation fails; so does an improvement, which is correct -
       under a byte-exactness requirement an unrequested improvement is a
       regression.
       ALL FOUR RELATIONS ARE PINNED, and vsOff was missing from this table
       until a review round found it. Its absence was not cosmetic: the off
       track is the one surface a scheme author is most likely to leave stock
       while retinting the on state, so it is precisely the relation a
       half-finished scheme drifts on. R405 is the proof. */
    const FROZEN_TOGGLE_RATIOS = {
      "light default": { vsThumb: 2.0, vsMenu: 1.84, vsHover: 2.0, vsOff: 1.3 },
      "dark default": { vsThumb: 2.0, vsMenu: 8.69, vsHover: 7.75, vsOff: 5.18 },
    };
    const fmt = (v) => (v == null ? "?" : v.toFixed(2));
    for (const c of toggleCells.filter((x) => x.frozen))
      console.log(
        `      10n frozen ${c.name}: on=${c.on} thumb=${fmt(c.vsThumb)} menu=${fmt(c.vsMenu)} hover=${fmt(c.vsHover)} off=${fmt(c.vsOff)}`,
      );
    const frozenDrift = toggleCells
      .filter((c) => c.frozen)
      .filter(
        (c) =>
          c.on !== FROZEN_TOGGLE ||
          !["vsThumb", "vsMenu", "vsHover", "vsOff"].every(
            (k) => c[k] != null && Math.abs(c[k] - FROZEN_TOGGLE_RATIOS[c.name][k]) <= 0.02,
          ),
      )
      .map(
        (c) =>
          `${c.name}: ${c.on} thumb=${fmt(c.vsThumb)} menu=${fmt(c.vsMenu)} hover=${fmt(c.vsHover)} off=${fmt(c.vsOff)}`,
      );
    check(
      "10n: the frozen defaults keep the exact switch appearance they shipped with, sub-bar ratios included",
      toggleCells.filter((c) => c.frozen).length === 2 && frozenDrift.length === 0,
      `${frozenDrift.length} drifted${frozenDrift.length ? ": " + frozenDrift.join(", ") : ""}; recorded ${JSON.stringify(
        FROZEN_TOGGLE_RATIOS,
      )} at ${FROZEN_TOGGLE} - the light default's 1.84 against its own menu is a real defect this work is not permitted to fix`,
    );

    /* ---------------------------------------------------------------- 10p
       THE COPY BUTTON'S CONFIRMATION FILL - a themed ink painted onto a
       surface no scheme could reach.

       .code-copy-btn is fully tokenised (background var(--primary-color),
       color var(--on-accent-fg)). Its .copied override - the ~2s "Copied!"
       confirmation after a click - repainted ONLY the background, with a raw
       #27ae60 (#2ecc71 on hover). So all six states went on supplying the INK
       for a fill they had no way to influence, and the four white-ink states
       landed at 2.87:1 resting and 2.10:1 on hover.

       IT WAS PROVEN UNCOVERED BEFORE IT WAS FIXED, rather than assumed to be:
       planting a 1.0:1 fill in ONE scheme - leaving the frozen defaults
       untouched, so the fidelity sweeps could not mask the result - left the
       suite green at 351/351. Each existing section misses it for its own
       reason: 10d reads a RESTING document, where no .copied button exists;
       10g collects the hover rule but excuses it (HOVER_EXCUSALS) for the
       same reason; and the state sweep does scaffold one, but it compares
       against the BASELINE, which a raw literal reproduces perfectly. A
       surface can be covered three times over and still have no assertion
       asking whether a scheme can reach it at all. */
    const COPIED_PROBE = `(() => {
      let host = document.getElementById("__copiedProbe");
      if (!host) {
        host = document.createElement("div");
        host.id = "__copiedProbe";
        host.className = "code-block-container";
        host.innerHTML =
          "<pre><code>x</code></pre>" +
          "<button class='code-copy-btn copied'>Copied!</button>";
        document.body.appendChild(host);
      }
      const btn = host.querySelector(".code-copy-btn.copied");
      if (!btn) return JSON.stringify({ error: "no button" });
      const rest = getComputedStyle(btn);
      const out = {
        restBg: rest.backgroundColor,
        restFg: rest.color,
        declaredBg: rest.getPropertyValue("--success-bg").trim(),
        declaredHover: rest.getPropertyValue("--success-bg-hover").trim(),
        declaredFg: rest.getPropertyValue("--on-success-fg").trim(),
      };
      /* THE HOVER FILL IS REPLAYED FROM THE RULE, NOT RE-READ OFF THE
         VARIABLE. Re-reading --success-bg-hover would keep passing even if
         the rule stopped consuming it, and the LINKAGE is the half that
         actually breaks. The declaration block is sliced out of cssText
         rather than iterated off rule.style because a SHORTHAND HOLDING
         var() is a pending-substitution value: it enumerates as its
         longhands and serialises every one of them as the EMPTY STRING, so
         the obvious loop drops the fill silently. Recorded in 10g; it is the
         same trap here.
         NOTE FOR EDITORS: never a backtick inside this template literal. */
      let decl = null;
      for (const sheet of document.styleSheets) {
        let rules = null;
        try { rules = sheet.cssRules; } catch (e) { continue; }
        for (const r of rules || []) {
          if (r.selectorText === ".code-copy-btn.copied:hover") {
            const t = r.cssText;
            decl = t.slice(t.indexOf("{") + 1, t.lastIndexOf("}")).trim();
          }
        }
      }
      out.hoverDecl = decl;
      /* THE TRANSITION MUST BE SUPPRESSED ON THE PROBE OR THE REPLAY READS
         BACK THE RESTING COLOUR. .code-copy-btn carries "transition: all"
         (a recorded, deliberately-unfixed pre-existing item), so a computed
         read taken immediately after the assignment returns the PREVIOUS
         state - which is exactly the mid-transition trap recorded against
         10c/10d, and here it is indistinguishable from a hover rule that
         does nothing. Suppressing it is a measurement device, not a change
         to the claim: what is being asserted is the colour the rule arrives
         at, not the path it takes. The flush between the two assignments is
         load-bearing - without it the "transition: none" and the new fill
         land in the same style update and the engine still animates. */
      btn.style.cssText = "transition: none";
      void btn.offsetWidth;
      btn.style.cssText = (decl || "") + "; transition: none;";
      const hov = getComputedStyle(btn);
      out.hoverBg = hov.backgroundColor;
      out.hoverFg = hov.color;
      btn.style.cssText = "";
      return JSON.stringify(out);
    })()`;

    const copiedRgb = (s) => {
      const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(s || ""));
      return m ? [+m[1], +m[2], +m[3]] : null;
    };
    const copiedRatio = (a, b) => {
      if (!a || !b) return null;
      const ch = (v) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
      };
      const lum = (c) => 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
      const l1 = lum(a);
      const l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    const copied = {};
    for (const [cMode, cScheme] of [["light", null], ["dark", null], ...SCHEME_STATES]) {
      const cLabel = cScheme || `${cMode} default`;
      await applySettled(cMode, cScheme, `10p ${cLabel}`);
      copied[cLabel] = JSON.parse(await exec(COPIED_PROBE));
    }
    await exec(
      `(() => { const h = document.getElementById("__copiedProbe"); if (h) h.remove(); return "1"; })()`,
    );
    const copiedStates = Object.keys(copied);
    const copiedSchemes = SCHEME_STATES.map(([, s]) => s);

    /* THE POSITIVE CONTROL IS MANDATORY: a dropped fill is indistinguishable
       from a real failure, and it reads as the SAME colour the resting rule
       paints - i.e. as a hover rule that does nothing. */
    const copiedNoDecl = copiedStates.filter((s) => !copied[s].hoverDecl);
    const copiedNoMove = copiedStates.filter((s) => copied[s].hoverBg === copied[s].restBg);
    check(
      "10p: the copy-confirmation hover rule was really replayed in every state (positive control)",
      copiedStates.length === 6 && copiedNoDecl.length === 0 && copiedNoMove.length === 0,
      `${copiedStates.length} state(s); no declaration: ${JSON.stringify(copiedNoDecl)}; fill did not move: ${JSON.stringify(
        copiedNoMove,
      )}; light default decl ${JSON.stringify(copied["light default"] && copied["light default"].hoverDecl)}`,
    );

    /* THE STRANDED-SURFACE GUARD. A scheme that declares the tokens but whose
       rule stopped consuming them, or a scheme that simply never got them,
       both land back on the frozen literals - which is the defect itself. */
    const FROZEN_COPIED = {
      rest: "rgb(39, 174, 96)",
      hover: "rgb(46, 204, 113)",
      ink: "rgb(255, 255, 255)",
    };
    const copiedUndeclared = copiedStates.filter(
      (s) => !copied[s].declaredBg || !copied[s].declaredHover || !copied[s].declaredFg,
    );
    const copiedStranded = copiedSchemes.filter(
      (s) => copied[s].restBg === FROZEN_COPIED.rest || copied[s].hoverBg === FROZEN_COPIED.hover,
    );
    check(
      "10p: every scheme reaches the copy-confirmation fill instead of inheriting the frozen literal",
      copiedUndeclared.length === 0 && copiedStranded.length === 0,
      `undeclared: ${JSON.stringify(copiedUndeclared)}; stranded on ${FROZEN_COPIED.rest}/${
        FROZEN_COPIED.hover
      }: ${JSON.stringify(copiedStranded)}; fills ${JSON.stringify(
        Object.fromEntries(copiedSchemes.map((s) => [s, `${copied[s].restBg} -> ${copied[s].hoverBg}`])),
      )}`,
    );

    const COPIED_MIN = 4.5;
    const copiedSubAa = [];
    for (const s of copiedSchemes) {
      const c = copied[s];
      const rRest = copiedRatio(copiedRgb(c.restBg), copiedRgb(c.restFg));
      const rHover = copiedRatio(copiedRgb(c.hoverBg), copiedRgb(c.hoverFg));
      if (!(rRest >= COPIED_MIN)) copiedSubAa.push(`${s} resting ${rRest == null ? "?" : rRest.toFixed(2)}`);
      if (!(rHover >= COPIED_MIN)) copiedSubAa.push(`${s} hover ${rHover == null ? "?" : rHover.toFixed(2)}`);
    }
    check(
      "10p: every scheme's copy confirmation meets WCAG AA against its own ink, resting and on hover",
      copiedSchemes.length === 4 && copiedSubAa.length === 0,
      `${copiedSubAa.length} below ${COPIED_MIN}: ${JSON.stringify(copiedSubAa)}; measured ${JSON.stringify(
        Object.fromEntries(
          copiedSchemes.map((s) => [
            s,
            `${copiedRatio(copiedRgb(copied[s].restBg), copiedRgb(copied[s].restFg)).toFixed(2)}/${copiedRatio(
              copiedRgb(copied[s].hoverBg),
              copiedRgb(copied[s].hoverFg),
            ).toFixed(2)}`,
          ]),
        ),
      )}`,
    );

    /* THE FROZEN DEFAULTS KEEP THE EXACT APPEARANCE THEY SHIPPED WITH,
       SUB-AA RATIOS INCLUDED. Tokenising a surface is the easiest possible
       way to "improve" a default by accident, and the byte-exact constraint
       forbids it - so the defect is RECORDED here rather than fixed. */
    const FROZEN_COPIED_RATIOS = { rest: 2.87, hover: 2.1 };
    const copiedFrozenDrift = ["light default", "dark default"].filter((s) => {
      const c = copied[s];
      const rRest = copiedRatio(copiedRgb(c.restBg), copiedRgb(c.restFg));
      const rHover = copiedRatio(copiedRgb(c.hoverBg), copiedRgb(c.hoverFg));
      return (
        c.restBg !== FROZEN_COPIED.rest ||
        c.hoverBg !== FROZEN_COPIED.hover ||
        c.restFg !== FROZEN_COPIED.ink ||
        c.hoverFg !== FROZEN_COPIED.ink ||
        Math.abs(rRest - FROZEN_COPIED_RATIOS.rest) > 0.01 ||
        Math.abs(rHover - FROZEN_COPIED_RATIOS.hover) > 0.01
      );
    });
    check(
      "10p: both frozen defaults keep the exact copy-confirmation appearance, sub-AA ratios included",
      copiedFrozenDrift.length === 0,
      `${copiedFrozenDrift.length} drifted${
        copiedFrozenDrift.length ? ": " + JSON.stringify(copiedFrozenDrift.map((s) => copied[s])) : ""
      }; recorded ${JSON.stringify(FROZEN_COPIED_RATIOS)} on ${FROZEN_COPIED.rest}/${FROZEN_COPIED.hover}`,
    );

    /* THE LEDGER - because .copied was found by SWEEPING for its shape, and a
       sweep whose result is written into prose rots the moment someone adds a
       rule. Every screen-scope declaration that paints a literal colour is
       listed here with the reason it is allowed to. The defect shape is a
       MIXED-AUTHORITY pair: a themed ink over a raw fill (or the reverse), so
       no scheme owns both halves of the cell. Every entry below is instead a
       SELF-CONSISTENT literal pair, an overlay whose backdrop it also paints,
       or a mode-invariant decoration - measured, not assumed.

       PRINT-ONLY declarations are deliberately out of scope: they are already
       owned by 10k's print sweep and its excusals. The exclusion is on the
       at-rule being EXACTLY "@media print", so a rule in a "screen, print"
       group - which really does apply on screen - lands here as an
       unrecorded entry and fails loudly rather than being waved through by a
       substring match on the word print. */
    const LITERAL_PAINT_LEDGER = {
      "styles.css|.search-highlight|background-color": "self-consistent pair with its own #000 ink (14.97:1)",
      "styles.css|.search-highlight|color": "self-consistent pair, see above",
      "styles.css|.search-highlight.current|background-color":
        "self-consistent pair with its own #fff ink - a real 2.33:1 cell, but mode-invariant and therefore part of the frozen defaults",
      "styles.css|.search-highlight.current|color": "self-consistent pair, see above",
      "styles.css|.notes-item.search-highlight|background": "translucent tint over a themed row, no ink of its own",
      "styles.css|.note-dialog-overlay|background": "modal scrim, paints no ink",
      "styles.css|.note-label|color": "ink over the note's own author-chosen colour, which no scheme owns",
      "styles.css|.note-tooltip::-webkit-scrollbar-track|background": "translucent decoration on the tooltip's own dark surface",
      "styles.css|.note-tooltip::-webkit-scrollbar-thumb|background": "translucent decoration, see above",
      "styles.css|.note-tooltip::-webkit-scrollbar-thumb:hover|background": "translucent decoration, see above",
      "styles.css|.note-tooltip-title|color": "self-consistent with the tooltip's own literal dark backdrop",
      "styles.css|.note-tooltip-content|color": "self-consistent, see above",
      "styles.css|.note-tooltip-close|background": "self-consistent pair with its own #fff ink",
      "styles.css|.note-tooltip-close|color": "self-consistent pair, see above",
      "styles.css|.note-tooltip-close:hover|background": "self-consistent pair, see above",
      "styles.css|.tools-toggle-thumb|background": "un-themed switch knob, measured against every track by 10n",
      "styles.css|.img-zoom-btn|background": "self-consistent pair with its own #fff ink, over an image",
      "styles.css|.img-zoom-btn|color": "self-consistent pair, see above",
      "custom-styles.css|::-webkit-scrollbar-thumb|background": "translucent decoration, per-mode pair",
      "custom-styles.css|::-webkit-scrollbar-thumb:hover|background": "translucent decoration, see above",
      "custom-styles.css|body.dark-mode ::-webkit-scrollbar-thumb|background": "translucent decoration, see above",
      "custom-styles.css|body.dark-mode ::-webkit-scrollbar-thumb:hover|background": "translucent decoration, see above",
      "custom-styles.css|.tab-close:hover|background": "translucent tint over the themed tab, paints no ink",
      "custom-styles.css|body.dark-mode .tab-close:hover|background": "translucent tint, see above",
    };
    const PAINT_PROPS =
      /^(color|background|background-color|border(-(top|right|bottom|left))?-color|fill|stroke|outline-color)$/;
    const NAMED_COLOURS = [
      "white", "black", "red", "green", "blue", "gold", "orange", "gray", "grey", "silver",
      "yellow", "purple", "navy", "teal", "olive", "maroon", "lime", "aqua", "fuchsia",
      "pink", "brown", "cyan", "magenta",
    ];
    /* A VARIABLE BLOCK IS WHERE A LITERAL IS SUPPOSED TO LIVE. The whole point
       of the token layer is that every scheme spells its palette out as raw
       values in exactly these blocks; sweeping them would report the design as
       the defect. */
    const isVarBlockSel = (sel) =>
      /^(:root|body|html)$/.test(sel) || /^body\[data-theme=/.test(sel) || /^body\.dark-mode$/.test(sel);
    /* A value whose only colour is rgba(var(--x), a) is TOKENISED, not
       literal - strip that shape before looking for a literal. */
    const hasLiteralColour = (v) => {
      const s = v.replace(/rgba?\(\s*var\([^)]*\)[^)]*\)/g, "");
      return (
        /#[0-9a-fA-F]{3,8}\b/.test(s) ||
        /\brgba?\(/.test(s) ||
        new RegExp(`\\b(${NAMED_COLOURS.join("|")})\\b`, "i").test(s)
      );
    };
    const literalPaint = newDecls.filter(
      (d) =>
        !d.prop.startsWith("--") &&
        PAINT_PROPS.test(d.prop) &&
        !isVarBlockSel(d.sel) &&
        d.at !== "@media print" &&
        hasLiteralColour(d.val),
    );
    const literalKeys = literalPaint.map((d) => `${d.file}|${d.sel}|${d.prop}`);
    const ledgerKeys = Object.keys(LITERAL_PAINT_LEDGER);
    const unrecordedLiterals = [...new Set(literalKeys.filter((k) => !LITERAL_PAINT_LEDGER[k]))];
    const staleLedger = ledgerKeys.filter((k) => !literalKeys.includes(k));
    check(
      "10p: every screen-scope literal paint declaration is a recorded self-consistent cell, not a stranded fill",
      literalKeys.length >= 24 && unrecordedLiterals.length === 0 && staleLedger.length === 0,
      `${literalKeys.length} swept against ${ledgerKeys.length} recorded; unrecorded: ${JSON.stringify(
        unrecordedLiterals,
      )}; stale: ${JSON.stringify(staleLedger)}`,
    );

    /* THE LINKAGE, NAMING BOTH HALVES. A behavioural assertion cannot see the
       ink token stop being consumed: every state's --on-success-fg is
       currently the same colour as its --on-accent-fg, so deleting the
       declaration changes no pixel today and would silently strand the token
       as dead paint a future editor changes expecting an effect - the defect
       10f2 states generally for literal var() fallbacks. It names the fill
       AND the ink because a claim that names only one half leaves the other
       free to break (recorded against the code ::selection belt, which named
       only the background while the foreground was the half that broke). */
    const COPIED_RULE_SHAPE = [
      ".code-copy-btn.copied|background|var(--success-bg)",
      ".code-copy-btn.copied|color|var(--on-success-fg)",
      ".code-copy-btn.copied:hover|background|var(--success-bg-hover)",
    ];
    const copiedRuleDecls = newDecls
      .filter((d) => d.file === "styles.css" && d.at === "" && /^\.code-copy-btn\.copied(:hover)?$/.test(d.sel))
      .map((d) => `${d.sel}|${d.prop}|${d.val}`);
    const copiedShapeMissing = COPIED_RULE_SHAPE.filter((k) => !copiedRuleDecls.includes(k));
    check(
      "10p: the copy-confirmation rules consume the success tokens for both their fill and their ink",
      copiedShapeMissing.length === 0,
      `missing: ${JSON.stringify(copiedShapeMissing)}; declared: ${JSON.stringify(copiedRuleDecls)}`,
    );

    // Leave the page in the shipped default so nothing after this section - or
    // a screenshot taken from the same profile - inherits a scheme.
    await applySettled("light", null, "restore to shipped default");

    // Reported LAST so it covers every state 10c/10d measured. A colour read
    // while a transition is in flight is the PREVIOUS scheme's colour and is
    // indistinguishable from a surface the new scheme cannot reach, so if this
    // fails every accent-survival and contrast result above is unreliable -
    // which is a different and much worse thing than one of them failing.
    check(
      "every theme state settled its CSS transitions before it was measured",
      settleFailures.length === 0,
      settleFailures.join(" | "),
    );
    /* POSITIVE CONTROL FOR THE SETTLE, and it closes a fail-open hole the
       assertion above cannot see. settleTransitions() filters on
       `a instanceof CSSTransition` with a `typeof CSSTransition !== 'undefined'`
       guard. If that global is ever absent - a sandboxed renderer, a Chromium
       rename - the predicate is false for EVERY animation, `running` is 0 on
       the first poll, the loop breaks without waiting, settleFailures stays
       empty and the assertion above passes while no settling happened at all.
       R300 cannot catch it either: a stretched transition is still a
       CSSTransition, so a dead filter makes the stretch invisible.
       So this asserts the wait OBSERVED something. Theme changes reliably
       start `transition: background` on the update buttons, so a zero here
       means the instrument is broken, not that the page was already calm. */
    check(
      "the settle wait actually observed running CSS transitions (positive control)",
      maxRunning > 0,
      `the highest number of running transitions seen across every theme change was ${maxRunning} - if the filter is dead this is 0 and every settle above was a no-op`,
    );
  } catch (e) {
    check("harness ran without throwing", false, e && e.stack ? e.stack.slice(0, 400) : String(e));
  }

  clearTimeout(watchdog);
  finish();
});
