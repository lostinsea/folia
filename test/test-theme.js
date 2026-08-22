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

const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");

const {
  GOLDEN_PATH,
  TOKEN_PROPS,
  BOX_PROPS,
  SURFACE_SELECTORS,
  waitForWindow,
  captureBothModes,
} = require("./theme-census");

const results = [];
let failed = 0;

function check(name, condition, detail) {
  const ok = !!condition;
  if (!ok) failed++;
  results.push(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : "  -> " + detail}`,
  );
}

function finish() {
  results.push(`=== ${results.length - failed}/${results.length} passed ===`);
  const text = results.join("\n") + "\n";
  fs.writeFileSync(path.join(__dirname, "test-theme-results.txt"), text);
  console.log(text);
  app.exit(failed === 0 ? 0 : 1);
}

const watchdog = setTimeout(() => {
  check("harness completed within 180s", false, "watchdog fired");
  finish();
}, 180000);

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
const DECIDED_AMENDMENTS = [
  "dark/entity.named-entity@.backgroundColor",
  "dark/namespace@.opacity",
  "dark/namespace@tag>attr-name.opacity",
  "dark/namespace@tag>tag.opacity",
  "dark/::selection.background",
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

require("../src/main.js");

app.whenReady().then(async () => {
  try {
    const win = await waitForWindow(BrowserWindow);
    const exec = (js) => win.webContents.executeJavaScript(js);

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

    const now = await captureBothModes(win);

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
          if (got[p] !== v) diffs.push(`${sel}.${p}: golden=${v} now=${got[p]}`);
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
    }
    // The dark amendment's premise, asserted against the golden like every
    // other one: the old value must really have been the near-invisible navy.
    check(
      "the dark ::selection amendment still describes the golden",
      golden.dark.selectionComputed.pre === DARK_CODE_SELECTION.was,
      `amendment says was=${DARK_CODE_SELECTION.was}, golden says ${golden.dark.selectionComputed.pre}`,
    );
    // Cheap belt: a rule must still exist and must still route through the
    // variable, so a scheme can retint it. The computed check above is what
    // proves it actually paints.
    const selRules = now.light.selection.filter((r) =>
      /language-/.test(r.selector),
    );
    check(
      "code ::selection rules still exist and consume the variable",
      selRules.length > 0 &&
        selRules.some((r) => /var\(\s*--code-selection-bg\s*[,)]/.test(r.css)),
      selRules.map((r) => r.css).join(" ").slice(0, 200),
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
    // - declared later - always wins on the real element. Measured, not assumed:
    // grepping the 16 files in libs/prismjs/components for each of these names
    // finds only bash's function-name. All six therefore render nowhere in the
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
  } catch (e) {
    check("harness ran without throwing", false, e && e.stack ? e.stack.slice(0, 400) : String(e));
  }

  clearTimeout(watchdog);
  finish();
});
