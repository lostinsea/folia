// Shared definition of the theme census.
//
// The capture script and the assertion suite MUST measure exactly the same
// things in exactly the same way, or the comparison is meaningless - a golden
// recorded with one probe and checked with a slightly different one reports
// differences that are artifacts of the probe. So the probe source, the
// property lists, the paths AND THE DRIVING SEQUENCE live here once and are
// imported by both. The sequence matters as much as the probe: if one side
// renders and switches mode differently from the other, the comparison is
// measuring the difference between two harnesses, not two stylesheets.
const fs = require("fs");
const path = require("path");

const FIXTURE_PATH = path.join(__dirname, "fixtures", "syntax-census.md");
const GOLDEN_PATH = path.join(__dirname, "fixtures", "theme-golden.json");

// The tuple that decides how a syntax token LOOKS. Measured, not guessed: a
// census over `color` alone reports 18 distinct cells, but `entity` differs
// from `operator` by backgroundColor and cursor, and `namespace` from `tag` by
// opacity, taking it to 23. Dropping any of these lets a real regression
// through.
const TOKEN_PROPS = [
  "color",
  "backgroundColor",
  "opacity",
  "fontWeight",
  "fontStyle",
  "cursor",
];

// The code box. The GEOMETRY properties here (padding, margin, radius,
// tab-size, white-space, hyphens, line-height) were measured identical in both
// modes and all came from the vendored light Solarized stylesheet, so dark mode
// depended on the light theme's file for them; they are recorded so that
// inlining that file cannot quietly lose them. The COLOUR properties below -
// backgroundColor, color, the four border colours, boxShadow - are per-mode and
// are recorded for the opposite reason: to catch a mode picking up the other
// one's value.
const BOX_PROPS = [
  "fontFamily",
  "fontSize",
  "lineHeight",
  "tabSize",
  "whiteSpace",
  "hyphens",
  "wordBreak",
  "overflowWrap",
  // The vendored theme declared these three on the code box too. `wordWrap` is
  // an alias of overflowWrap and is already above; these two are not, and
  // nothing else in the suite watches them.
  "textAlign",
  "wordSpacing",
  "padding",
  "margin",
  "borderRadius",
  // Border and shadow come from `.markdown-body pre`, not from the vendored
  // Prism file - but they are part of how the code box LOOKS, a scheme will
  // eventually want to move them, and nothing else in this suite watches them.
  // Recorded as longhands per side: the `border` shorthand serialises to the
  // empty string whenever the four sides disagree, which would compare equal
  // against an equally-empty golden and guard nothing.
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderTopStyle",
  "borderRightStyle",
  "borderBottomStyle",
  "borderLeftStyle",
  "borderTopColor",
  "borderRightColor",
  "borderBottomColor",
  "borderLeftColor",
  "boxShadow",
  "overflow",
  "backgroundColor",
  "color",
  "textShadow",
];

// Reading-surface elements outside code. These are what a reader spends most of
// their time looking at, so a scheme that gets them wrong is the most visible
// possible failure - and none of them are covered by the token census.
const SURFACE_SELECTORS = {
  body: ["backgroundColor", "color"],
  "#viewer": ["color"],
  "#viewer h1": ["color", "borderBottomColor"],
  "#viewer h2": ["color", "borderBottomColor"],
  "#viewer p": ["color"],
  "#viewer a": ["color"],
  "#viewer blockquote": ["backgroundColor", "color", "borderLeftColor"],
  "#viewer th": ["backgroundColor", "color", "borderBottomColor"],
  "#viewer td": ["backgroundColor", "color"],
  // The fixture deliberately carries TWO body rows, because
  // `tr:last-child td { border-bottom: none }` unpaints the last one - a single
  // row measures `currentColor` and records a border that is never drawn.
  "#viewer tbody tr:first-child td": ["borderBottomColor"],
};

// ::selection is recorded TWO ways, and both are needed.
//
// `getComputedStyle(el, '::selection')` is a real end-to-end oracle - it answers
// what the user would actually see selected - so it catches a consuming rule
// that stops consuming (a typo in the var name, or `background` changed to
// `color`), which reading the variable's declared value cannot. An earlier
// comment here claimed getComputedStyle could not see ::selection at all; that
// is false in this Chromium and it cost the suite a real assertion.
//
// The raw cascade rules are ALSO recorded, because they carry something the
// computed value does not: whether the colour was BAKED or resolved through a
// variable. In the pre-refactor tree the vendored stylesheet baked it, so a
// golden whose code ::selection is a literal colour is self-evidently a
// pre-refactor golden. That is a non-circular integrity gate on the baseline.
const CENSUS_PROBE_SOURCE = `(() => {
  const TP = ${JSON.stringify(TOKEN_PROPS)};
  const BP = ${JSON.stringify(BOX_PROPS)};
  const SS = ${JSON.stringify(SURFACE_SELECTORS)};
  const tuple = (el, props) => {
    const cs = getComputedStyle(el);
    const o = {};
    props.forEach((p) => (o[p] = cs[p]));
    return o;
  };
  const classSet = (el) =>
    [...el.classList].filter((c) => c !== 'token').sort().join('.');
  // THE KEY MUST CARRY THE ANCESTOR TOKEN CHAIN. Keying on the class-set alone
  // and keeping the first occurrence silently erases every CONTEXT-DEPENDENT
  // difference - which is exactly the class of difference a token whose source
  // theme declared NO rule exhibits, because such a token inherits its colour
  // from whatever encloses it. A review caught five light-mode elements that had
  // changed colour while a class-set-keyed census reported zero differences:
  // 'namespace' inside 'attr-name' was cyan, inside 'tag' blue, and bare in C#
  // base00 - one key, three colours, only the first ever compared.
  const tokenPath = (el) => {
    const parts = [];
    for (let p = el.parentElement; p && p.id !== 'viewer'; p = p.parentElement) {
      if (p.classList.contains('token')) parts.unshift(classSet(p));
    }
    return parts.join('>');
  };
  const tokens = {};
  document.querySelectorAll('#viewer .token').forEach((t) => {
    const key = (classSet(t) || '(bare)') + '@' + tokenPath(t);
    if (!tokens[key]) tokens[key] = tuple(t, TP);
  });
  const box = {};
  [['pre', '#viewer pre[class*=language-]'],
   ['preCode', '#viewer pre[class*=language-] code'],
   ['inlineCode', '#viewer p code'],
   ['inlineLangCode', '#viewer p code[class*=language-]'],
   // The block form the AUTHOR gave no language. Prism still stamps
   // language-none on it, so a pre:not([class]) selector would match nothing
   // once highlighting lands; selecting by id also stops it silently starting
   // to match some other element if the fixture changes.
   ['preNoLang', '#viewer pre#census-nolang'],
   ['preNoLangCode', '#viewer pre#census-nolang code']].forEach(([k, sel]) => {
    const el = document.querySelector(sel);
    box[k] = el ? tuple(el, BP) : null;
  });
  const surfaces = {};
  Object.keys(SS).forEach((sel) => {
    const el = document.querySelector(sel);
    surfaces[sel] = el ? tuple(el, SS[sel]) : null;
  });
  const selection = [];
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch (e) { continue; }
    for (const r of rules || []) {
      if (r.selectorText && /::(-moz-)?selection/.test(r.selectorText)) {
        selection.push({ selector: r.selectorText, css: r.style.cssText });
      }
    }
  }
  selection.sort((a, b) => (a.selector < b.selector ? -1 : 1));
  // The end-to-end half: what a selection would ACTUALLY paint, per element.
  const selectionComputed = {};
  [['pre', '#viewer pre[class*=language-]'],
   ['preCode', '#viewer pre[class*=language-] code'],
   ['body', 'body']].forEach(([k, sel]) => {
    const el = document.querySelector(sel);
    selectionComputed[k] = el
      ? getComputedStyle(el, '::selection').backgroundColor
      : null;
  });
  return JSON.stringify({ tokens, box, surfaces, selection, selectionComputed });
})()`;

// Switching mode goes through the REAL toggle, because that is the path the
// product uses and it carries the mermaid re-theming side effects.
function applyModeInPage(mode) {
  return `(() => {
    const want = ${JSON.stringify(mode)} === 'dark';
    if (document.body.classList.contains('dark-mode') !== want) {
      document.getElementById('darkModeToggle').click();
    }
    return document.body.classList.contains('dark-mode');
  })()`;
}

// Waiting on OBSERVABLE CONDITIONS, never on a duration. The project has been
// bitten by this exact disease before (684ffe7: "screenshots showed the previous
// frame about a quarter of the time"). A fixed sleep is not merely slow - if
// Prism has only PARTIALLY finished, the first element matching a census key can
// be a different element than it was at capture time, so the fidelity assertion
// can pass or fail non-deterministically rather than failing honestly.
async function waitFor(exec, expr, label, timeout = 30000) {
  const started = Date.now();
  for (;;) {
    if (await exec(`!!(${expr})`)) return;
    if (Date.now() - started > timeout) {
      throw new Error(`timed out after ${timeout}ms waiting for ${label}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Highlighting finishes asynchronously and in chunks, so "some tokens exist" is
// not enough - the count has to STOP changing.
async function waitForStableTokens(exec, timeout = 30000) {
  const started = Date.now();
  let last = -1;
  let steady = 0;
  for (;;) {
    const n = await exec(`document.querySelectorAll('#viewer .token').length`);
    steady = n > 0 && n === last ? steady + 1 : 0;
    last = n;
    if (steady >= 3) return n;
    if (Date.now() - started > timeout) {
      throw new Error(`token count never settled (last ${n})`);
    }
    await new Promise((r) => setTimeout(r, 120));
  }
}

async function waitForWindow(BrowserWindow, timeout = 30000) {
  const started = Date.now();
  for (;;) {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.webContents.isLoading()) return win;
    if (Date.now() - started > timeout) throw new Error("no window appeared");
    await new Promise((r) => setTimeout(r, 100));
  }
}

// The single driving sequence. Both the capture script and the suite call this,
// so a golden can never be recorded through a different sequence than the one
// that later checks it.
async function captureBothModes(win) {
  const exec = (js) => win.webContents.executeJavaScript(js);
  win.unmaximize();
  win.setBounds({ x: 30, y: 30, width: 1500, height: 1000 });
  await waitFor(exec, `document.getElementById('viewer')`, "#viewer");
  const markdown = fs.readFileSync(FIXTURE_PATH, "utf8");
  await exec(`renderMarkdown(${JSON.stringify(markdown)}, "full")`);
  await waitForStableTokens(exec);

  const captured = {};
  for (const mode of ["light", "dark"]) {
    await exec(applyModeInPage(mode));
    await waitFor(
      exec,
      `document.body.classList.contains('dark-mode') === ${mode === "dark"}`,
      `${mode} mode to be applied`,
    );
    await waitForStableTokens(exec);
    captured[mode] = JSON.parse(await exec(CENSUS_PROBE_SOURCE));
  }
  return captured;
}

module.exports = {
  FIXTURE_PATH,
  GOLDEN_PATH,
  TOKEN_PROPS,
  BOX_PROPS,
  SURFACE_SELECTORS,
  CENSUS_PROBE_SOURCE,
  applyModeInPage,
  waitFor,
  waitForStableTokens,
  waitForWindow,
  captureBothModes,
};
