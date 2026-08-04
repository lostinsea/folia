/**
 * Shared visual-check helpers for the Electron test harnesses.
 *
 * Why this exists
 * ---------------
 * The mermaid harness once passed 17 geometry assertions while the diagrams
 * were visually unreadable, and the bug was only found by looking at a
 * screenshot. The lesson was NOT "add pixel-diff baselines" - those are flaky
 * across GPU drivers, DPI and Electron versions, they say "something changed"
 * rather than "this is wrong", and they cannot express intent (white boxes are
 * correct in light mode). The lesson was:
 *
 *   screenshots find unknown-unknowns; assertions guard known invariants.
 *
 * So this module provides the two halves of that:
 *
 *   1. inspect() - a DOM probe for the things a human notices in a screenshot
 *      but that computed styles alone do not catch: an element being
 *      off-screen, collapsed to nothing, covered by something else, or clipped
 *      by an ancestor. These become ordinary deterministic assertions.
 *
 *   2. captureScreenshot() - screenshots as *artifacts*, never as baselines.
 *      Written to a gitignored screenshots/ directory on every run and on
 *      failure, so a human (or an agent that can read images) can look at them
 *      when something breaks. Nothing asserts on their contents.
 *
 * Anything discovered via (2) should be converted into an assertion in (1) so
 * that the same bug can never need a screenshot again.
 */

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// The in-page probe.
//
// This is a real function so it stays lintable and syntax-highlighted; it is
// serialized with toString() and injected. It therefore must not reference
// anything from this module's scope. It deliberately avoids backticks so the
// serialized source can be safely nested inside a template literal by callers.
// ---------------------------------------------------------------------------
function inPageVisualProbe() {
  window.__mdvVisual = {
    /**
     * Inspect every element matching `selector`.
     *
     * Returns one record per element plus an aggregate summary. A record is
     * "sound" when the element is rendered, on screen, big enough to see, not
     * covered by another element, and not clipped horizontally by an ancestor.
     */
    inspect: function (selector, options) {
      var opts = options || {};
      var minW = typeof opts.minWidth === "number" ? opts.minWidth : 2;
      var minH = typeof opts.minHeight === "number" ? opts.minHeight : 2;

      var vw = window.innerWidth;
      var vh = window.innerHeight;

      var records = [];
      var nodes = Array.prototype.slice.call(
        document.querySelectorAll(selector),
      );

      // Every check below is viewport-relative, so an element that happens to
      // sit below the fold reports as unsound no matter how healthy it is: all
      // five sample points land outside the viewport and `sampled` comes back
      // 0. That is a property of where the page happens to be scrolled, not of
      // the element, and it made the third diagram in any document permanently
      // red. Scroll each element into view first so the probe answers the
      // question it actually claims to answer: "when the user looks at this,
      // is it sound?"
      //
      // Scrolling is state, so capture every scrollable container up front and
      // put it back afterwards - callers assert on scroll position elsewhere
      // and a diagnostic probe must not move the thing under test.
      var doScroll =
        opts.scrollIntoView !== false && nodes.length > 0;
      var savedScroll = [];
      if (doScroll) {
        Array.prototype.forEach.call(
          document.querySelectorAll("*"),
          function (n) {
            if (
              n.scrollHeight > n.clientHeight + 1 ||
              n.scrollWidth > n.clientWidth + 1
            ) {
              savedScroll.push({
                el: n,
                top: n.scrollTop,
                left: n.scrollLeft,
              });
            }
          },
        );
      }

      nodes.forEach(function (el, i) {
        if (doScroll && typeof el.scrollIntoView === "function") {
          // block:'center' maximises the in-view area, which matters for an
          // element taller than the viewport: the centre sample still lands
          // inside even when the 15%/85% ones cannot.
          el.scrollIntoView({ block: "center", inline: "nearest" });
        }
        var rect = el.getBoundingClientRect();

        // --- rendered at all -------------------------------------------------
        // checkVisibility covers display:none, visibility:hidden, opacity:0 and
        // content-visibility on the element *and* its ancestors, which a naive
        // getComputedStyle(el).display check misses entirely.
        var rendered =
          typeof el.checkVisibility === "function"
            ? el.checkVisibility({
                checkOpacity: true,
                checkVisibilityCSS: true,
              })
            : rect.width > 0 && rect.height > 0;

        // --- actually within the viewport ------------------------------------
        var onScreen =
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < vh &&
          rect.left < vw;

        var bigEnough = rect.width >= minW && rect.height >= minH;

        // --- covered by something else ---------------------------------------
        // Sample the centre and four inset corners. A point is occluded when
        // the topmost element there is neither this element, nor inside it, nor
        // an ancestor of it (an ancestor hit just means we sampled padding).
        //
        // Descendant hits are deliberately treated as fine: an element covered
        // by its own content is the normal case - .mermaid is covered by its
        // own <svg>, #viewer by the rendered markdown - and calling that
        // occlusion would fail on every healthy container. The cost is that a
        // descendant acting as an opaque overlay reads as sound; content-level
        // assertions are the intended cover for that, not this probe.
        //
        // Second known limitation, stated rather than hidden: elementFromPoint
        // ignores pointer-events:none, so a purely decorative overlay drawn on
        // top of the element will not be detected here. Hit-testing is the only
        // cheap occlusion signal available without pixel comparison.
        var fractions = [
          [0.5, 0.5],
          [0.15, 0.15],
          [0.85, 0.15],
          [0.15, 0.85],
          [0.85, 0.85],
        ];
        var sampled = 0;
        var occluded = 0;
        var occluder = null;
        fractions.forEach(function (f) {
          var x = rect.left + rect.width * f[0];
          var y = rect.top + rect.height * f[1];
          if (x < 0 || y < 0 || x >= vw || y >= vh) return;
          sampled++;
          var hit = document.elementFromPoint(x, y);
          if (!hit) {
            occluded++;
            return;
          }
          if (hit === el || el.contains(hit) || hit.contains(el)) return;
          occluded++;
          if (!occluder) {
            occluder =
              hit.tagName.toLowerCase() +
              (hit.id ? "#" + hit.id : "") +
              (hit.className && typeof hit.className === "string"
                ? "." + hit.className.trim().split(/\s+/).join(".")
                : "");
          }
        });

        // --- clipped by an ancestor -----------------------------------------
        // Horizontal clipping is the one that silently eats content in a
        // fixed-width reading column; vertical is usually just normal scroll.
        var clippedX = false;
        var clippedY = false;
        var clipper = null;
        var a = el.parentElement;
        while (a && a !== document.documentElement) {
          var cs = window.getComputedStyle(a);
          var hidesX = cs.overflowX === "hidden" || cs.overflowX === "clip";
          var hidesY = cs.overflowY === "hidden" || cs.overflowY === "clip";
          if (hidesX || hidesY) {
            var ar = a.getBoundingClientRect();
            if (hidesX && (rect.left < ar.left - 1 || rect.right > ar.right + 1)) {
              clippedX = true;
              if (!clipper) clipper = a.tagName.toLowerCase() + (a.id ? "#" + a.id : "");
            }
            if (hidesY && (rect.top < ar.top - 1 || rect.bottom > ar.bottom + 1)) {
              clippedY = true;
              if (!clipper) clipper = a.tagName.toLowerCase() + (a.id ? "#" + a.id : "");
            }
          }
          a = a.parentElement;
        }

        // An element straddling the viewport edge can have every sample point
        // skipped. That would leave occluded === 0 and read as sound, which is
        // a false pass - the worst kind of failure for a test helper. Treat
        // "could not sample anything" as unsound in its own right.
        var sound =
          rendered &&
          onScreen &&
          bigEnough &&
          sampled > 0 &&
          occluded === 0 &&
          !clippedX;

        records.push({
          index: i,
          tag: el.tagName.toLowerCase(),
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          rendered: rendered,
          onScreen: onScreen,
          bigEnough: bigEnough,
          sampled: sampled,
          occluded: occluded,
          occluder: occluder,
          clippedX: clippedX,
          clippedY: clippedY,
          clipper: clipper,
          scrolledIntoView: doScroll,
          sound: sound,
        });
      });

      savedScroll.forEach(function (s) {
        s.el.scrollTop = s.top;
        s.el.scrollLeft = s.left;
      });

      var bad = records.filter(function (r) {
        return !r.sound;
      });

      return {
        selector: selector,
        count: records.length,
        soundCount: records.length - bad.length,
        unsound: bad,
        records: records,
      };
    },

    /**
     * Scroll an element into view and settle, so that on-screen and occlusion
     * checks mean something for content below the fold.
     */
    reveal: function (selector) {
      var el = document.querySelector(selector);
      if (!el) return false;
      el.scrollIntoView({ block: "center", inline: "nearest" });
      return true;
    },
  };
  return true;
}

/** JS source that installs window.__mdvVisual in the page. */
const VISUAL_PROBE_SOURCE = "(" + inPageVisualProbe.toString() + ")()";

/**
 * Install the probe, then inspect a selector.
 * Re-installing is cheap and makes each call independent of ordering.
 */
async function inspectVisual(win, selector, options) {
  await win.webContents.executeJavaScript(VISUAL_PROBE_SOURCE, true);
  return win.webContents.executeJavaScript(
    "window.__mdvVisual.inspect(" +
      JSON.stringify(selector) +
      "," +
      JSON.stringify(options || {}) +
      ")",
    true,
  );
}

const SHOT_DIR = path.join(__dirname, "screenshots");

/**
 * Capture a screenshot as a debugging artifact.
 *
 * Never compared against a baseline - see the module comment. Failures are
 * swallowed deliberately: a harness must not fail because a screenshot could
 * not be written.
 */
async function captureScreenshot(win, name) {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const img = await win.webContents.capturePage();
    const safe = String(name).replace(/[^a-z0-9._-]+/gi, "-");
    const file = path.join(SHOT_DIR, safe + ".png");
    fs.writeFileSync(file, img.toPNG());
    return file;
  } catch (e) {
    console.log("could not capture screenshot " + name + ": " + e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Error sentinel.
//
// Written after a run was observed to *show* errors on screen while every
// assertion passed. That is the exact failure mode this module exists to close:
// end-of-run screenshots only capture the final frame, and a red error graphic
// that appears mid-suite and is then overwritten by the next render leaves no
// trace in either the screenshots or the results.
//
// The sentinel watches continuously instead of at chosen moments, from two
// independent angles:
//
//   * the renderer's console, via webContents 'console-message'. This is the
//     only way to see a script parse failure, a CSP refusal or a rejected
//     promise, none of which leave anything in the DOM.
//   * the rendered document, polled. Some errors are *only* visual - mermaid
//     draws its own red "Syntax error" graphic and reports nothing, and a
//     broken <img> is silent by design.
//
// On the first sighting of each distinct problem it captures a screenshot, so
// there is always an artifact showing what was on screen at that instant.
//
// Deliberate negative tests need mute()/unmute() around them, and those
// windows are reported too - an un-reviewed mute is how a sentinel quietly
// stops being a gate.
// ---------------------------------------------------------------------------

function inPageErrorScan() {
  var out = [];
  var seenText = {};

  function push(kind, detail) {
    var key = kind + "|" + detail;
    if (seenText[key]) return;
    seenText[key] = true;
    out.push({ kind: kind, detail: String(detail).slice(0, 200) });
  }

  function scanDoc(doc, where) {
    if (!doc || !doc.body) return;

    // Mermaid's own failure graphic. It reports nothing to the console: the
    // library catches the parse error and draws a bomb icon plus the words
    // "Syntax error in text", so the DOM is the only place it is visible.
    var errSvgs = doc.querySelectorAll(
      'svg[aria-roledescription="error"], .mermaid svg .error-icon, .mermaid svg .error-text',
    );
    if (errSvgs.length) push("mermaid-error-graphic", where + " x" + errSvgs.length);

    var body = doc.body.textContent || "";
    var phrases = [
      "Syntax error in text",
      "Mermaid Rendering Error",
      "Uncaught SyntaxError",
      "SyntaxError:",
      "No diagram type detected",
    ];
    for (var i = 0; i < phrases.length; i++) {
      if (body.indexOf(phrases[i]) >= 0) push("error-text-on-screen", where + ": " + phrases[i]);
    }

    // A broken image is only detectable once it has settled: `complete` is
    // true both for a finished load and for a failed one, and naturalWidth
    // separates them. Images with no src are skipped - those are placeholders
    // the app fills in later, not failures.
    var imgs = doc.querySelectorAll("img");
    for (var j = 0; j < imgs.length; j++) {
      var im = imgs[j];
      if (!im.getAttribute("src")) continue;
      if (im.complete && im.naturalWidth === 0) {
        push("broken-image", where + ": " + String(im.getAttribute("src")).slice(0, 120));
      }
    }
  }

  scanDoc(document, "top");

  // Same-origin frames only. The @@@html sandbox frames are origin-opaque on
  // purpose, so reaching into them throws; that is the feature working, not a
  // gap, and their content is author HTML the app makes no promises about.
  var frames = document.querySelectorAll("iframe");
  for (var k = 0; k < frames.length; k++) {
    try {
      scanDoc(frames[k].contentDocument, "frame" + k);
    } catch (e) {
      /* opaque origin - expected */
    }
  }

  return out;
}

const ERROR_SCAN_SOURCE = "(" + inPageErrorScan.toString() + ")()";

/**
 * Start watching a window for errors. Returns a handle; call stop() at the end
 * of the suite and assert on the report.
 *
 * @param {BrowserWindow} win
 * @param {object} [opts]
 * @param {string} [opts.label]      prefix for screenshot filenames
 * @param {RegExp[]} [opts.ignore]   console messages that are expected noise
 * @param {string[]} [opts.ignoreKinds] whole categories to skip, e.g.
 *        "broken-image" for a suite whose fixtures point at paths that are
 *        deliberately absent
 * @param {number} [opts.intervalMs] DOM poll period
 */
function startErrorSentinel(win, opts) {
  const o = opts || {};
  const label = o.label || "sentinel";
  const ignore = o.ignore || [];
  const ignoreKinds = new Set(o.ignoreKinds || []);
  const hits = [];
  const mutes = [];
  const seen = new Set();
  let muted = null;
  let shots = 0;
  let stopped = false;

  const record = async (kind, detail) => {
    if (stopped) return;
    if (ignoreKinds.has(kind)) return;
    const key = kind + "|" + detail;
    if (seen.has(key)) return;
    seen.add(key);
    if (muted) {
      muted.suppressed.push({ kind, detail });
      return;
    }
    // Capture before anything else can repaint over it. The screenshot is an
    // artifact for a human; the hit itself is what the assertion reads.
    let shot = null;
    if (shots < 12) {
      shots += 1;
      shot = await captureScreenshot(win, `${label}-error-${shots}`);
    }
    hits.push({ kind, detail, shot });
  };

  // Electron changed this event's signature; accept both forms rather than
  // pinning to one and silently receiving `undefined` after an upgrade.
  const onConsole = (event, level, message, line, sourceId) => {
    const lvl = event && typeof event === "object" && "level" in event ? event.level : level;
    const msg = event && typeof event === "object" && "message" in event ? event.message : message;
    const src =
      event && typeof event === "object" && "sourceId" in event ? event.sourceId : sourceId;
    const text = String(msg || "");
    const isError = lvl === "error" || lvl === 3 || /^\s*Uncaught\b/.test(text);
    if (!isError) return;
    if (ignore.some((re) => re.test(text))) return;
    record("console-error", `${text} @ ${src || "?"}:${line || 0}`);
  };
  win.webContents.on("console-message", onConsole);

  const timer = setInterval(async () => {
    if (stopped || win.isDestroyed()) return;
    try {
      const found = await win.webContents.executeJavaScript(ERROR_SCAN_SOURCE, true);
      for (const f of found || []) await record(f.kind, f.detail);
    } catch (e) {
      /* the page is mid-navigation or the harness is tearing down */
    }
  }, o.intervalMs || 300);

  return {
    /** Suppress recording while a deliberately-failing scenario runs. */
    mute(reason) {
      muted = { reason, suppressed: [] };
      // Dedupe state is per-window: a message already seen unmuted must still
      // be captured here, or a mute could silently record nothing and the
      // "the probe really did fire" assertions would go vacuous.
      seen.clear();
    },
    /** The mute currently in effect, so a suite can assert it caught what it opened for. */
    currentMute() {
      return muted;
    },
    unmute() {
      if (muted) mutes.push(muted);
      muted = null;
      // Forget what was seen while muted, so a problem that outlives the
      // muted window is still reported once it does.
      seen.clear();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      try {
        win.webContents.off("console-message", onConsole);
      } catch (e) {
        /* window already gone */
      }
      return { hits, mutes };
    },
  };
}

module.exports = {
  VISUAL_PROBE_SOURCE,
  inspectVisual,
  captureScreenshot,
  startErrorSentinel,
  SHOT_DIR,
};
