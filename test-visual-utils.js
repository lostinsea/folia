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
    // Tracked so stop() and drain() can wait for it. record() is async because
    // of the screenshot, and an unawaited one could otherwise land in `hits`
    // after the suite had already read its supposedly final report.
    track(record("console-error", `${text} @ ${src || "?"}:${line || 0}`));
  };
  win.webContents.on("console-message", onConsole);

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

module.exports = {
  VISUAL_PROBE_SOURCE,
  inspectVisual,
  captureScreenshot,
  startErrorSentinel,
  proveSentinelAlive,
  LIVENESS_MUTE_REASON,
  SHOT_DIR,
};
