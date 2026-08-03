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

      nodes.forEach(function (el, i) {
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
          sound: sound,
        });
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

module.exports = {
  VISUAL_PROBE_SOURCE,
  inspectVisual,
  captureScreenshot,
  SHOT_DIR,
};
