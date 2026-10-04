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
const os = require("os");
const path = require("path");

// Must come before any window exists: this relocates the suite's userData off
// the developer's real profile, and app.setPath("userData") is silently ignored
// once the app is ready. See test-userdata-isolation.js for the measurement.
require("./test-userdata-isolation");

// ---------------------------------------------------------------------------
// Survive a closed stdout.
//
// Every suite reports through console.log. If the reader on the other end of
// the pipe goes away first - `| head`, `| Select-Object -First 20`, a killed
// pager, a CI step that stops consuming - the next write raises EPIPE. In a
// plain Node script that is a stack trace; under Electron the main process
// turns an uncaught exception into a MODAL DIALOG that blocks the run until a
// human clicks OK, which is exactly the opposite of what a test harness should
// do on a machine with no one watching. Observed for real:
//   Error: EPIPE: broken pipe, write ... at check (test-table-display.js:41)
//
// Losing output nobody is reading is harmless; hanging the suite is not. So
// swallow EPIPE specifically and let every other stream error surface. This is
// installed here rather than in each suite because all eight require this
// module, and it must be armed before the first assertion prints.
//
// A/B PROVEN, not assumed. An Electron script printing a line every 30ms into a
// pipe whose reader exits after the first chunk:
//   without this guard - the run HANGS indefinitely behind a window titled
//                        "Error" (observed as electron pid 25684) and has to be
//                        killed; stderr never even flushes.
//   with this guard    - runs to completion, no dialog, no stray process.
// Note that plain `node` does NOT reproduce it: Console defaults to
// ignoreErrors:true, so a bare Node script survives a closed stdout on its own.
// It is specifically Electron's uncaught-exception dialog that turns this into
// a hang, which is why the isolated Node reproduction was misleading at first.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (err) => {
    if (!err || err.code !== "EPIPE") throw err;
  });
}

// ---------------------------------------------------------------------------
// Keep the window laying out even when the desktop covers it.
//
// Chromium on Windows computes *native window occlusion*: when another window
// fully covers the app, the page is marked hidden
// (`document.visibilityState === "hidden"`) and layout is suspended to save
// work. That is correct behaviour for a real app and a disaster for a
// geometric test harness, because a suspended page stops updating
// `window.innerWidth` while the OS-level bounds keep tracking every resize.
//
// MEASURED, not inferred. Under a full `npm test` the table suite reported:
//   requested width 2000, outerWidth 2000, contentWidth 1988  (main process: correct)
//   innerWidth 988, documentElement.clientWidth 988           (renderer: frozen)
//   win.isVisible() true, isMinimized() false, focused true
//   document.hidden TRUE, visibilityState "hidden"            <- the actual cause
// The window really had resized; the page had simply stopped laying out. Ten
// geometric assertions then failed naming TABLES, and the same suite passed
// 95/95 in isolation - because in isolation nothing was covering the window.
//
// A/B proven with a forced-occlusion probe (a second opaque always-on-top
// window fully covering the target, then a resize of the covered window):
//   STOCK          hiddenWhileCovered=true   outerWidth STALE at 1200 after a
//                                            resize to 1900
//   WITH SWITCHES  hiddenWhileCovered=false  outerWidth 1900 (correct)
// Note the probe froze `outerWidth` where the suite froze `innerWidth`: WHICH
// renderer-side window metric goes stale is not fixed, so the invariant worth
// stating is the general one - an occluded page stops updating its own view of
// the window, and these switches stop the page being marked occluded at all.
//
// Disabled here rather than in each suite because every Electron harness
// requires this module, and rather than in main.js because the product should
// keep normal occlusion behaviour - this is a property of the test
// environment, not of the app.
//
// Three switches, because they cover three different mechanisms and the first
// alone is not enough on every Electron version:
//   CalculateNativeWinOcclusion - the Windows occlusion calculation itself
//   disable-backgrounding-occluded-windows - throttling once occluded
//   disable-renderer-backgrounding - throttling of non-foreground renderers
//
// `disable-features` is a VALUE switch, and appendSwitch REPLACES the value
// rather than adding to it. MEASURED, because the wording of the API suggests
// otherwise:
//   appendSwitch("disable-features", "FeatureAlpha")  -> "FeatureAlpha"
//   appendSwitch("disable-features", "FeatureBeta")   -> "FeatureBeta"   (!)
//   appendSwitch("disable-features", "Alpha,Beta")    -> "Alpha,Beta"
// So a second caller anywhere - a future suite, a product feature, a
// dependency - would silently switch this one back on, and the failure would
// surface as unexplained geometric flakiness rather than as anything naming
// occlusion. Merge with whatever is already there instead of assuming this is
// the only caller. The other two are boolean switches and stack fine.
const DISABLED_FEATURES = ["CalculateNativeWinOcclusion"];

function mergeDisabledFeatures(existing, wanted) {
  const seen = String(existing || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const f of wanted) if (!seen.includes(f)) seen.push(f);
  return seen.join(",");
}

try {
  const { app } = require("electron");
  if (app && app.commandLine && !app.isReady()) {
    app.commandLine.appendSwitch(
      "disable-features",
      mergeDisabledFeatures(
        app.commandLine.getSwitchValue("disable-features"),
        DISABLED_FEATURES,
      ),
    );
    app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
  }
} catch {
  // Required from plain Node (the selfcheck does this) - nothing to do.
}

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

const SHOT_DIR = path.join(__dirname, "..", "screenshots");

// Tunable because UnknownVizError is a load-sensitive transient: if CI starts
// flaking, raise these rather than concluding capture is permanently broken.
const CAPTURE_RETRIES = 4;
const CAPTURE_RETRY_DELAY_MS = 250;
// Measured max wait for two animation frames on a visible window: 35ms. This
// is 7x that, and it is a CEILING rather than a delay - see settleFrame().
const FRAME_SETTLE_TIMEOUT_MS = 250;

/**
 * Wait for the compositor to have produced a frame that reflects the DOM as it
 * now stands, before asking for a copy of it.
 *
 * capturePage() hands back the last frame the compositor produced, which is not
 * necessarily the current one. MEASURED on this machine by flipping a
 * full-window background colour and capturing immediately: 8 of 30 captures
 * came back showing the PREVIOUS colour with the window focused, and 8 of 30
 * with another window on top - about 27% either way. Every wrong frame was
 * exactly the previous colour rather than a blend, so these are whole stale
 * frames, not tearing. Awaiting two animation frames first drove it to 0 of 60.
 *
 * Two things this deliberately does NOT do, both decided by measurement:
 *
 *  - it does not raise or focus the window. `showInactive()` + `moveTop()` +
 *    `focus()` + 350ms was the recipe carried in from an earlier investigation;
 *    measured against the double rAF it fixed nothing further (0 of 12 either
 *    way), while costing 350ms per shot and stealing focus from whatever the
 *    reader is doing - the same harm trapExternalOpens exists to prevent.
 *
 *  - it never awaits those frames unconditionally. On a HIDDEN window
 *    requestAnimationFrame never fires at all (measured: still pending after
 *    2s), so an unraced await would hang a suite forever, inside a function
 *    whose whole contract is that it cannot take a run down with it.
 */
async function settleFrame(win) {
  try {
    await Promise.race([
      win.webContents.executeJavaScript(
        "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))",
        true,
      ),
      new Promise((r) => setTimeout(r, FRAME_SETTLE_TIMEOUT_MS)),
    ]);
  } catch (e) {
    // Best effort: a capture with no settle is still better than no capture.
  }
}

/**
 * Capture a screenshot as a debugging artifact.
 *
 * Never compared against a baseline - see the module comment. Capture failures
 * are swallowed deliberately: a harness must not fail because a screenshot
 * could not be written. Failure to remove a stale screenshot is the exception:
 * that leaves false visual evidence and must fail the harness.
 *
 * But a swallowed failure must not leave the PREVIOUS run's image sitting at
 * the destination. That was observed live: `capturePage()` threw
 * `UnknownVizError` for one popup, the harness carried on, and a months-old
 * PNG stayed on disk looking exactly like a fresh one. Reviewing screenshots
 * is a primary verification step here, so a stale artifact is worse than no
 * artifact - it is a confident wrong answer. Two changes:
 *   - retry, because UnknownVizError is transient (it is the compositor not
 *     having produced a frame yet, not a permanent condition);
 *   - if every attempt fails, DELETE the destination so the gap is visible.
 */
async function captureScreenshot(win, name) {
  let safe = "unnamed";
  let file = null;
  let lastErr = null;

  try {
    // A hostile or non-string name is a capture failure rather than a harness
    // failure, matching the ordinary capture-error contract.
    safe = String(name).replace(/[^a-z0-9._-]+/gi, "-");
    file = path.join(SHOT_DIR, safe + ".png");

    for (let attempt = 0; attempt < CAPTURE_RETRIES; attempt++) {
      try {
        if (win.isDestroyed && win.isDestroyed()) {
          lastErr = new Error("window already destroyed");
          break;
        }
        fs.mkdirSync(SHOT_DIR, { recursive: true });
        await settleFrame(win);
        const img = await win.webContents.capturePage();
        // A capture can succeed and still be empty if no frame was produced.
        if (img.isEmpty()) throw new Error("captured an empty frame");
        fs.writeFileSync(file, img.toPNG());
        return file;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, CAPTURE_RETRY_DELAY_MS));
      }
    }

  } catch (e) {
    lastErr = lastErr || e;
  }

  // Do not report that stale evidence was removed until it really was. A
  // locked/permission-denied file is still plausible-looking evidence from a
  // previous run, so returning null (or logging success) would be a false
  // visual pass. Let it fail the caller before that artifact can be used.
  if (file && fs.existsSync(file)) {
    try {
      fs.unlinkSync(file);
    } catch (error) {
      const removalError = new Error(
        `could not remove stale screenshot ${file}: ${error && error.message ? error.message : error}`,
      );
      removalError.code = error && error.code;
      removalError.cause = error;
      throw removalError;
    }
  }

  console.log(
    "could not capture screenshot " +
      safe +
      ": " +
      (lastErr && lastErr.message) +
      " (removed any stale " +
      safe +
      ".png so it cannot be mistaken for this run)",
  );
  return null;
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
 * Reject with a tagged, identifiable error if `p` has not settled in `ms`.
 *
 * Used only to bound the sentinel's own renderer round-trips: the instrument
 * must never be able to hang the harness, because a hang surfaces as an opaque
 * suite-wide timeout that names neither the phase nor the window.
 */
function withTimeout(p, ms, tag) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => {
      const e = new Error(`timed out after ${ms}ms: ${tag}`);
      e.isTimeout = true;
      e.tag = tag;
      reject(e);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

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
 * @param {number} [opts.drainTimeoutMs] budget for each renderer round-trip
 */
function startErrorSentinel(win, opts) {
  const o = opts || {};
  const label = o.label || "sentinel";
  const ignore = o.ignore || [];
  const ignoreKinds = new Set(o.ignoreKinds || []);
  const hits = [];
  const mutes = [];
  // Places where the sentinel could not reach the renderer within its budget.
  // A stalled instrument is not a clean run, so this is reported alongside the
  // hits and the suites assert it is empty.
  const stalls = [];
  const seen = new Set();
  let muted = null;
  let shots = 0;
  let stopped = false;
  let timer = null;
  let inFlight = Promise.resolve();
  // Async record() calls started from the console listener, which has no
  // caller to await it. stop() and drain() settle these before reporting.
  const pending = [];
  const track = (p) => {
    pending.push(p);
    return p;
  };

  // A call issued while the window was alive and destroyed mid-flight never
  // settles - Electron leaves the executeJavaScript promise pending forever
  // rather than rejecting it. For popups, which this suite closes as it goes,
  // that is ordinary teardown and not an instrument failure. It is only a real
  // stall if the window is still there and simply did not answer.
  const noteStall = (e) => {
    if (!e || !e.isTimeout) return;
    if (win.isDestroyed()) return;
    stalls.push({ phase: e.tag, at: new Date().toISOString() });
  };

  const record = async (kind, detail) => {
    if (ignoreKinds.has(kind)) return;
    const key = kind + "|" + detail;
    if (seen.has(key)) return;
    seen.add(key);
    if (muted) {
      muted.suppressed.push({ kind, detail });
      return;
    }
    // Record the hit BEFORE anything async. `stopped` must not gate this:
    // stop() can be reached while a scan is mid-flight, and dropping the hit
    // there would turn a real error observed in the last poll into a clean
    // run. Only the screenshot - which needs a live window - is skipped once
    // the window is going away.
    const hit = { kind, detail, shot: null };
    hits.push(hit);
    if (!stopped && shots < 12 && !win.isDestroyed()) {
      shots += 1;
      // Capture before anything else can repaint over it. The screenshot is an
      // artifact for a human; the hit itself is what the assertion reads.
      hit.shot = await captureScreenshot(win, `${label}-error-${shots}`);
    }
  };

  // Electron delivers the console event as one details object. Reject an
  // incomplete event so a contract change cannot be reported as a clean run.
  const onConsole = (details) => {
    if (
      !details ||
      typeof details !== "object" ||
      typeof details.level !== "string" ||
      typeof details.message !== "string" ||
      typeof details.sourceId !== "string" ||
      !Number.isFinite(details.lineNumber)
    ) {
      throw new Error("console-message details omitted level, message, source, or line");
    }
    const text = details.message;
    const isError = details.level === "error" || /^\s*Uncaught\b/.test(text);
    if (!isError) return;
    if (ignore.some((re) => re.test(text))) return;
    // Tracked so stop() and drain() can wait for it. record() is async because
    // of the screenshot, and an unawaited one could otherwise land in `hits`
    // after the suite had already read its supposedly final report.
    track(record("console-error", `${text} @ ${details.sourceId}:${details.lineNumber}`));
  };
  win.webContents.on("console-message", onConsole);

  // Backstop for the external-open trap.
  //
  // Every windowed suite installs it explicitly, and should keep doing so:
  // that call is AWAITED, so it is deterministic, and a suite that clicks a
  // link needs the trap armed before the click rather than a moment later.
  // This is the safety net for the suite nobody has written yet. Arming it
  // here as well costs one IPC round trip and means a new windowed suite
  // cannot leak simply by forgetting a line.
  //
  // Fire-and-forget but TRACKED, so stop() waits for it rather than leaving an
  // executeJavaScript in flight against a window that is being torn down.
  // Popups (nodeIntegration: false) have no require(), so the trap reports
  // false there and nothing is patched - correct, since a realm with no Node
  // cannot reach the shell at all.
  track(trapExternalOpens(win).catch(() => {}));

  // One scan at a time, chained rather than overlapped. setInterval with an
  // async callback fires again whether or not the previous scan finished, so a
  // slow executeJavaScript (or a screenshot) used to let scans pile up and
  // interleave their record() calls.
  const scanOnce = async () => {
    if (stopped || win.isDestroyed()) return;
    try {
      const found = await win.webContents.executeJavaScript(ERROR_SCAN_SOURCE, true);
      for (const f of found || []) await record(f.kind, f.detail);
    } catch (e) {
      /* the page is mid-navigation or the harness is tearing down */
    }
  };
  const tick = () => {
    if (stopped) return;
    inFlight = scanOnce().finally(() => {
      if (!stopped) timer = setTimeout(tick, o.intervalMs || 300);
    });
  };
  timer = setTimeout(tick, o.intervalMs || 300);

  /**
   * Wait until everything the renderer has already emitted has reached us.
   *
   * console-message crosses an IPC boundary, so it does NOT arrive just
   * because an awaited executeJavaScript resolved. Without this, closing a
   * mute right after a probe is a race: the violation the mute exists to
   * absorb can land a moment later, unmuted, and fail the run
   * non-deterministically.
   *
   * The round trip forces the renderer to process a message from us, which
   * flushes what it queued before; the scan then covers the DOM side.
   */
  const drain = async () => {
    if (!win.isDestroyed()) {
      try {
        // Bounded: a renderer wedged behind a native dialog (or one Chromium
        // has throttled while occluded) never settles executeJavaScript, and an
        // unbounded await here hangs the whole harness at teardown - reported
        // only as an opaque suite-level timeout. A stall is a finding, so it is
        // recorded and surfaced in the report rather than waited on forever.
        await withTimeout(
          win.webContents.executeJavaScript("void 0", true),
          o.drainTimeoutMs || 5000,
          "renderer round-trip",
        );
        await new Promise((r) => setTimeout(r, 60));
        await withTimeout(scanOnce(), o.drainTimeoutMs || 5000, "dom scan");
      } catch (e) {
        noteStall(e);
        /* otherwise: the page is mid-navigation or the harness is tearing down */
      }
    }
    await Promise.allSettled(pending);
    pending.length = 0;
  };

  return {
    drain,
    /** Suppress recording while a deliberately-failing scenario runs. */
    async mute(reason) {
      // Drain first: anything already emitted belongs to the *previous*
      // section and must not be swallowed by this mute.
      await drain();
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
    async unmute() {
      // Drain before lifting the mute, so a violation still in flight from the
      // deliberate failure is absorbed by the mute that was opened for it.
      await drain();
      if (muted) mutes.push(muted);
      muted = null;
      // Forget what was seen while muted, so a problem that outlives the
      // muted window is still reported once it does.
      seen.clear();
    },
    async stop() {
      // Stop scheduling new scans before draining, so the final drain is the
      // last thing that touches the window.
      clearTimeout(timer);
      await drain();
      stopped = true;
      // Whatever was already running still gets to finish and report - but
      // bounded, for the same reason drain() is: a scan awaiting a wedged
      // renderer must not be able to hang teardown.
      try {
        await withTimeout(
          Promise.allSettled([inFlight, ...pending]),
          o.drainTimeoutMs || 5000,
          "settle in-flight scans",
        );
      } catch (e) {
        noteStall(e);
      }
      try {
        win.webContents.off("console-message", onConsole);
      } catch (e) {
        /* window already gone */
      }
      return { hits, mutes, stalls };
    },
  };
}

/**
 * Reason string on the mute proveSentinelAlive() opens. Exported so a suite that
 * asserts on the *extent* of its blind spots can subtract the liveness window
 * without loosening the assertion to a bare count.
 */
const LIVENESS_MUTE_REASON = "sentinel liveness probe";

/**
 * Prove a sentinel is actually watching, by making it catch something on
 * purpose.
 *
 * Without this, "no errors were recorded" is indistinguishable from "the
 * watcher stopped working" — the exact vacuity this harness exists to avoid. It
 * exercises BOTH detection paths independently, because they fail
 * independently: the main-process console-message listener (which an Electron
 * signature change could silently break) and the in-page DOM poll (which a
 * navigation, a destroyed window or a rejected executeJavaScript could stall).
 *
 * Runs inside a mute, so the probes it provokes never count as findings.
 *
 * @returns {Promise<{console: boolean, dom: boolean}>} which paths reported.
 */
async function proveSentinelAlive(win, sentinel) {
  const marker = "sentinel-liveness-probe-" + Date.now();
  await sentinel.mute(LIVENESS_MUTE_REASON);
  try {
    await win.webContents.executeJavaScript(
      `(() => {
         console.error(${JSON.stringify(marker)});
         // The DOM path looks for mermaid's error graphic by its phrases; give
         // it one, in a node that is removed again immediately afterwards.
         const d = document.createElement('div');
         d.id = ${JSON.stringify(marker)};
         d.textContent = 'Syntax error in text';
         d.style.cssText = 'position:fixed;left:-9999px;top:0;';
         document.body.appendChild(d);
       })()`,
      true,
    );
    // drain() runs a full scan and flushes queued console messages, so both
    // paths have had their chance by the time it returns.
    await sentinel.drain();
    const m = sentinel.currentMute();
    const got = (m && m.suppressed) || [];
    const result = {
      console: got.some((s) => s.kind === "console-error" && s.detail.includes(marker)),
      dom: got.some((s) => s.kind === "error-text-on-screen"),
    };
    await win.webContents.executeJavaScript(
      `(() => { const n = document.getElementById(${JSON.stringify(marker)}); if (n) n.remove(); })()`,
      true,
    );
    return result;
  } finally {
    await sentinel.unmute();
  }
}

// ---------------------------------------------------------------------------
// Keep the suite inside its own window.
//
// The app hands external links to the operating system: renderer.js does
// `shell.openExternal(url)` for any http(s) anchor, and again for the logo. A
// suite that dispatches a REAL click on a REAL anchor - which is exactly what
// this project's rules demand, since asserting on source text proves nothing -
// therefore launches the user's default browser.
//
// REPORTED BY THE USER, not theorised: every `npm run test:patch` opened
// https://example.invalid/x in whatever browser they were working in, stealing
// focus from the page they were on, and the tabs accumulated - one per suite
// run, and a full revert-proof chain runs the suite dozens of times.
//
// Two properties matter here beyond politeness:
//   * a harness that reaches OUT of its process is not hermetic. The run's
//     result now depends on a browser, a default-handler registration and a
//     network stack that no assertion describes.
//   * the leak was SILENT. Nothing failed, so it survived until a human
//     noticed their tab bar.
//
// So the trap is installed centrally rather than at the one call site known to
// leak today. The renderer copy is what has to be patched: `shell.openExternal`
// in a nodeIntegration renderer is a proxy that reaches the browser process
// over internal IPC, so patching the main process's own `shell` module does
// NOT intercept it (measured - main.js never calls openExternal at all, and
// the leak still happened).
//
// `shell.openPath` is trapped for the same reason, and it is the WORSE of the
// two: it hands a path to the OS shell, which launches the registered
// application - a PDF viewer, Explorer, an editor. renderer.js reaches it from
// the local-file branch of the same anchor handler, so a future test that
// clicks a link resolving to a .txt or a folder would start launching
// applications on the user's desktop. Only the security suite stubbed it, and
// only locally.
//
// A RELOAD DROPS THE TRAP, AND THAT WAS MEASURED, NOT ASSUMED.
// test-mermaid-render.js reloads the window mid-suite to get a clean JS realm.
// A probe across that reload reported:
//   before  { flag: true,  openExternalPatched: true  }
//   after   { flag: false, openExternalPatched: false }
// - both the marker and the patched function are gone, because the realm and
// its `require('electron')` module instance are rebuilt. Every assertion after
// that point ran with the real opener live again. A one-shot install is
// therefore not enough: the trap re-arms itself on every `did-finish-load`, so
// no suite has to remember to re-apply it after a reload or a navigation.
//
// Suites that want to ASSERT an external open read `readExternalOpens(win)`.
// That is strictly better than the alternative of letting the real call
// through: the assertion gets the exact URL instead of inferring the open from
// a side effect it cannot see.
// ---------------------------------------------------------------------------
const EXTERNAL_TRAP_SOURCE = `
  (() => {
    // Popups run with nodeIntegration disabled, so there is no require() and
    // nothing in that realm can reach the shell in the first place. Report
    // false rather than throwing, so a caller can arm every window it owns
    // without knowing which ones have Node.
    if (typeof require !== 'function') return false;
    const { shell } = require('electron');
    // The bucket is created by the recorder itself rather than only here. A
    // suite that clears window state (or a realm that survives while the page
    // does not) would otherwise make the recorder throw INSIDE the shell proxy,
    // where nothing awaits it: the URL would go unrecorded, no assertion would
    // trip, and the tab would already be open. Failing open like that is the
    // one outcome this trap exists to prevent.
    const rec = (name, value) => {
      const bucket = window[name] || (window[name] = []);
      bucket.push(String(value));
    };
    if (!window.__externalTrapInstalled) {
      window.__externalTrapInstalled = true;
      shell.openExternal = (url) => { rec('__externalOpens', url); return Promise.resolve(); };
      // openPath resolves to an error STRING ('' means success), not to void.
      shell.openPath = (p) => { rec('__shellOpens', p); return Promise.resolve(''); };
    }
    if (!window.__externalOpens) window.__externalOpens = [];
    if (!window.__shellOpens) window.__shellOpens = [];
    return window.__externalTrapInstalled === true;
  })()
`;

// webContents that already re-arm themselves. A WeakSet rather than a flag on
// the object: the harness must not add properties to Electron's own objects,
// and this drops the entry when the window is collected.
const trapRearmed = new WeakSet();

async function trapExternalOpens(win) {
  const wc = win.webContents;
  if (!trapRearmed.has(wc)) {
    trapRearmed.add(wc);
    // Not `once`: a suite may reload more than once, and a navigation is the
    // only moment at which the trap can silently disappear.
    wc.on("did-finish-load", () => {
      wc.executeJavaScript(EXTERNAL_TRAP_SOURCE, true).catch(() => {
        /* window went away mid-navigation; nothing left to protect */
      });
    });
  }
  return wc.executeJavaScript(EXTERNAL_TRAP_SOURCE, true);
}

async function readExternalOpens(win) {
  return win.webContents.executeJavaScript(`(window.__externalOpens || []).slice()`, true);
}

async function readShellOpens(win) {
  return win.webContents.executeJavaScript(`(window.__shellOpens || []).slice()`, true);
}

async function clearExternalOpens(win) {
  return win.webContents.executeJavaScript(
    `(() => {
       if (window.__externalOpens) window.__externalOpens.length = 0;
       if (window.__shellOpens) window.__shellOpens.length = 0;
       return true;
     })()`,
    true,
  );
}

/**
 * Wait for the trap to be armed, without asserting.
 *
 * The re-arm after a reload is asynchronous with respect to the
 * `did-finish-load` the SUITE is awaiting - both listeners fire on the same
 * event, and ours has an IPC round trip to make. A suite that wants to assert
 * the trap survived a reload must therefore poll rather than read once, or it
 * is asserting on a race. Returns a boolean instead of throwing so the caller
 * can report it as an ordinary failed assertion.
 */
async function waitForExternalTrap(win, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let armed = false;
    try {
      armed = await win.webContents.executeJavaScript(
        `window.__externalTrapInstalled === true`,
        true,
      );
    } catch (e) {
      /* mid-navigation */
    }
    if (armed) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ---------------------------------------------------------------------------
// Temp directories that are removed however the suite ends.
//
// THE DEFECT THIS FIXES IS NOT "the suites are untidy". Every suite except
// test-popup-security's download probe already called fs.rmSync on its temp
// dir - but on the NORMAL COMPLETION PATH ONLY. Read test-tab-refresh.js's
// tail: the rmSync sits between the summary line and the final app.exit, so
// the 180s watchdog's app.exit(1), the "no BrowserWindow was created" bail and
// any throw that escapes all skip it. The runs that leak are therefore exactly
// the runs that already went wrong, which is the worst possible correlation:
// a timeout leaves debris, and the debris makes the next run worse.
//
// MEASURED on this machine before writing any of this - stale dirs by prefix:
//   mdv-dl-   34   test-popup-security.js:1250, never cleaned at all
//   mdv-e2e-  13   test-tab-refresh.js:25, cleaned only on the happy path
//   mdv-sec- / mdv-search- / mdv-patch- / mdv-mermaid-   ZERO
// The zeros are the control: those four suites had been ending normally, so
// their existing cleanup ran. Same code shape, different outcome, and the
// difference is entirely which exit path was taken.
//
// A LEAKED TEMP DIR IS NOT INERT, which is what makes this worth structural
// work rather than a manual sweep. The hermeticity investigation found 43
// orphaned mdv-e2e-* dirs of which exactly ONE still held guard-big.md - the
// 260 KB fixture that, once persisted into the then-shared Electron session,
// raised a main-process modal on startup and blocked EVERY subsequent suite
// behind a dialog no in-process watchdog could clear.
//
// WHY process.on("exit") IS THE RIGHT HOOK, and it was measured rather than
// assumed - the concern is real, because app.exit() is documented to terminate
// immediately and does NOT emit will-quit or quit:
//   probe A (npx electron): app.exit(0) after whenReady
//                           -> seen: ["process:exit"]   will-quit/quit ABSENT
//   probe B: three nested dirs (subdirs + a 64 KB file) removed with a
//            recursive rmSync inside that same handler
//                           -> removed 3, failed [], goneAfter [t,t,t],
//                              0 stragglers left on disk
//   probe C: a try/finally wrapped directly around that same app.exit(0)
//                           -> seen: ["process:exit"] ONLY - neither the
//                              statement after app.exit() nor the `finally`
//                              block ran at all
// So the handler runs and a recursive removal COMPLETES inside it, which is
// the claim that actually matters - a half-executed sweep during teardown
// would look identical from the outside.
//
// PROBE C IS WHY THIS REGISTRY EXISTS AT ALL, and it is what splits the two
// tiers of suite. app.exit() terminates mid-stack and unwinds nothing, so a
// try/finally CANNOT clean up an Electron suite - which is exactly the shape
// of the leak: the rmSync sits on the normal-completion path and is skipped by
// the watchdog app.exit(1), the no-window bail and any escaping throw. The
// plain-node suites have the opposite property (no app, so `finally` always
// runs) and already use it: test-packaging.js cleans all three of its temp
// dirs in finally blocks, and its prefixes measure ZERO stale dirs against
// mdv-dl-'s 34. They are deliberately NOT wired into this registry - their own
// tier's idiom is proven to work and importing an Electron harness seam into a
// plain-node suite would buy nothing.
//
// RESIDUAL, stated rather than implied: a SIGKILL or a killed console still
// leaks, because no in-process hook can survive that. That is strictly better
// than today and is why the removal is also idempotent - a stale dir from a
// killed run is simply removed by force on a later sweep.
const REGISTERED_TEMP_DIRS = new Set();

/**
 * Create a temp directory that is removed when this process exits, whatever
 * exit path it takes. Drop-in for fs.mkdtempSync(path.join(os.tmpdir(), p)).
 */
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  REGISTERED_TEMP_DIRS.add(dir);
  return dir;
}

/**
 * Remove a registered temp dir early. Suites that already clean up on their
 * happy path keep doing so - removing debris sooner is strictly better - and
 * this de-registers it so the exit sweep does not report work it did not do.
 *
 * DE-REGISTER ONLY ONCE THE DIRECTORY IS ACTUALLY GONE. The comment above says
 * "a later sweep or a manual clean will get it", and for the sweep that was not
 * true: the delete ran BEFORE the removal, so a removal that failed - a Windows
 * lock, a child still holding a handle - handed the caller a silent leak with
 * nothing left owning it. The exit sweep had already been told to forget it.
 * Removing first and de-registering only on a verified absence keeps the sweep
 * as the owner of exactly the directories that still exist, which is what makes
 * TEMP_SWEEP.failed an honest report rather than a subset of the real damage.
 */
function releaseTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* ownership stays with the exit sweep; see below */
  }
  let gone = false;
  try {
    gone = !fs.existsSync(dir);
  } catch (e) {
    gone = false;
  }
  if (gone) REGISTERED_TEMP_DIRS.delete(dir);
  return gone;
}

// Reported so the sweep is observable rather than a silent side effect: an
// assertion that "no temp dirs remain" is an ABSENCE check and fails open, so
// the selfcheck needs a positive signal that the sweep actually ran and how
// much it removed.
const TEMP_SWEEP = { swept: 0, failed: [], ran: false };

function sweepTempDirs() {
  TEMP_SWEEP.ran = true;
  const failed = [];
  // A SNAPSHOT, because the set is mutated below. Iterating a Set while
  // deleting from it is defined but reads as an accident waiting to happen.
  for (const dir of [...REGISTERED_TEMP_DIRS]) {
    let gone = false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      // Re-read rather than inferred from "rmSync did not throw": force:true
      // swallows ENOENT, and on Windows a removal can return without the
      // directory actually being gone.
      gone = !fs.existsSync(dir);
      if (!gone) {
        const detail = dir + ": still present after rmSync";
        TEMP_SWEEP.failed.push(detail);
        failed.push(detail);
      }
    } catch (e) {
      // Never throw from an exit handler: under Electron an uncaught
      // exception becomes a modal dialog, i.e. the exact hang the EPIPE guard
      // above exists to prevent, and it would arrive after the summary line
      // where nobody would connect it to cleanup.
      const detail = dir + ": " + (e && e.code ? e.code : e);
      TEMP_SWEEP.failed.push(detail);
      failed.push(detail);
    }
    // DE-REGISTER ONLY WHAT IS ACTUALLY GONE. This used to clear() the whole
    // set at the end, which threw away the failures too - so the second sweep
    // (the app.exit wrapper and the process-exit hook are both wired to this)
    // had nothing left to retry, and the "removal is idempotent, a stale dir
    // from a killed run is simply removed by force on a later sweep" claim in
    // the header above was true only for directories that had never failed.
    // Keeping failures registered is what makes the second call a retry rather
    // than a no-op, and it is what keeps a leak owned instead of orphaned.
    if (gone) {
      REGISTERED_TEMP_DIRS.delete(dir);
      TEMP_SWEEP.swept++;
    }
  }
  return failed;
}

process.on("exit", () => {
  if (sweepTempDirs().length > 0) process.exitCode = 1;
});

// AND THE HOOK ALONE DOES NOT COVER THE PATH THAT MATTERS MOST. Probe A above
// was recorded as proving "app.exit() runs process.on('exit')". That is only
// CONDITIONALLY true, and probe A hid the condition by reaching app.exit from
// a setTimeout. Re-measured, five contexts, all inside whenReady().then(...):
//   app.exit(0) called synchronously in the then callback  handler DID NOT run
//   queueMicrotask(() => app.exit(0))                      handler DID NOT run
//   Promise.resolve().then(() => app.exit(0))              handler DID NOT run
//   setImmediate(() => app.exit(0))                        handler ran
//   setTimeout(() => app.exit(0), 0)                       handler ran
// and four realistic suite shapes:
//   await Promise.resolve(); app.exit(0)                   handler DID NOT run
//   await sleep(0) / await sleep(50); app.exit(0)          handler ran
//   new BrowserWindow(); await win.loadURL(u); app.exit(0) handler ran
// Repeated 5x per shape with the full child payload: the microtask exit wrote
// its report 0/5 times, the setImmediate exit 5/5.
//
// THE AXIS IS WHETHER app.exit() IS REACHED WHILE STILL INSIDE THE READY
// EVENT'S OWN NATIVE DISPATCH - within the microtask checkpoint that drains at
// the end of it. Any macrotask boundary (a timer, a window load, real IPC)
// moves the call out of that dispatch and the handlers run normally. Every
// windowed suite loads a window, so the hook does cover today's tails - but an
// early bail-out ("no BrowserWindow was created") is exactly the shape that
// exits inside that first dispatch, and it is also exactly the run that has
// already gone wrong, which is the correlation this whole section exists for.
//
// So the sweep ALSO runs from app.exit itself, synchronously, before
// delegating. That is deterministic whichever dispatch the call is reached
// from, and process.on("exit") stays as the backstop for every other exit path
// (a natural return, process.exit, plain-node use). app.on("will-quit") is NOT
// an option: app.exit() does not emit it (probe A). The two are idempotent
// together - each successful removal de-registers that directory, so the
// second call finds only a prior failed removal to retry and cannot
// double-count successful cleanup.
try {
  const electron = require("electron");
  const app = electron && typeof electron === "object" ? electron.app : null;
  if (app && typeof app.exit === "function" && !app.__foliaTempSweepWrapped) {
    const realExit = app.exit.bind(app);
    app.exit = function (...args) {
      let cleanupFailed = false;
      try {
        cleanupFailed = sweepTempDirs().length > 0;
      } catch (e) {
        // Cleanup must never stop a suite from terminating, and a throw here
        // would become a modal dialog - the hang the EPIPE guard exists for.
        cleanupFailed = true;
      }
      // A failed recursive sweep is a test failure, not incidental teardown
      // noise. In particular, app.exit(0) must not turn leaked state into a
      // green process result after its suite already printed a success footer.
      return realExit(cleanupFailed ? 1 : args[0]);
    };
    app.__foliaTempSweepWrapped = true;
  }
} catch {
  // Required from plain Node - that tier is covered by the hook above.
}

module.exports = {
  VISUAL_PROBE_SOURCE,
  inspectVisual,
  captureScreenshot,
  tempDir,
  releaseTempDir,
  // Exported for the selfcheck: see TEMP_SWEEP above - the natural assertion
  // here is an absence, so the sweep has to be able to report that it ran.
  TEMP_SWEEP,
  sweepTempDirs,
  REGISTERED_TEMP_DIRS,
  startErrorSentinel,
  trapExternalOpens,
  readExternalOpens,
  readShellOpens,
  clearExternalOpens,
  waitForExternalTrap,
  proveSentinelAlive,
  LIVENESS_MUTE_REASON,
  SHOT_DIR,
  // Exported for the selfcheck only: the merge is the load-bearing half of the
  // occlusion fix (appendSwitch replaces rather than appends), so it has to be
  // assertable rather than trusted.
  mergeDisabledFeatures,
  DISABLED_FEATURES,
};
