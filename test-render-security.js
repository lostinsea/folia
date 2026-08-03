// End-to-end security regression harness for the render pipeline.
// Run with: npm run test:security
//
// Boots the real main.js, then drives window.renderMarkdown() with the exact
// payloads from SECURITY-AUDIT.md (SEC-01 through SEC-04) and asserts that none
// of them execute. Every attack test is paired with a feature test, because the
// remedy - making DOMPurify the last step in the pipeline instead of the third
// of nine - is exactly the kind of change that can silently stop mermaid,
// sliders, OmniWare or @@@html blocks from rendering at all.
//
// Payloads set window.__pwned rather than spawning a process. The property that
// matters is whether attacker-authored script runs in the Node-privileged
// renderer at all; what it would then choose to do is not in question.
const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

require("./main.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mdv-sec-"));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(win) {
  const exec = (code) => win.webContents.executeJavaScript(code, true);

  // Render `md` through the chosen pipeline and report whether any payload
  // managed to run. `settle` covers mermaid/iframe work that lands after the
  // render promise resolves.
  async function render(md, mode, settle = 900) {
    await exec(`
      (async () => {
        window.__pwned = null;
        window.__lastRenderError = null;
        try {
          await window.renderMarkdown(${JSON.stringify(md)}, ${JSON.stringify(mode)});
        } catch (e) {
          window.__lastRenderError = String(e && e.message || e);
        }
        return null;
      })()
    `);
    await sleep(settle);
    return exec(`window.__pwned`);
  }

  const viewerHtml = () => exec(`document.getElementById('viewer').innerHTML`);

  // ==========================================================================
  // SEC-02 - mermaid fence body injected raw after DOMPurify
  // ==========================================================================
  const mermaidPayload =
    "# Doc\n\n```mermaid\n<img src=x onerror=\"window.__pwned='mermaid-full'\">\n```\n";

  check(
    "SEC-02 mermaid fence payload does not execute (full render)",
    (await render(mermaidPayload, "full")) === null,
    "window.__pwned was set from a mermaid fence body",
  );

  check(
    "SEC-02 mermaid fence payload does not execute (light-format render)",
    (await render(
      "# Doc\n\n```mermaid\n<img src=x onerror=\"window.__pwned='mermaid-light'\">\n```\n",
      "light-format",
    )) === null,
    "window.__pwned was set via the light-format path",
  );

  // The body must survive as *text*, not as markup.
  const mermaidEscaped = await exec(`
    (() => {
      const el = document.querySelector('pre.mermaid');
      if (!el) return { found: false };
      return { found: true, imgChildren: el.querySelectorAll('img').length };
    })()
  `);
  check(
    "SEC-02 mermaid body is inserted as text, not as an element",
    mermaidEscaped.found === false || mermaidEscaped.imgChildren === 0,
    JSON.stringify(mermaidEscaped),
  );

  // ==========================================================================
  // SEC-03 - image-slider src/alt injected raw after DOMPurify
  // ==========================================================================
  const sliderPayload =
    "# Doc\n\n<!-- slider-start -->\n" +
    "![\" onerror=\"window.__pwned='slider'](a.png)\n" +
    "![second](b.png)\n" +
    "<!-- slider-end -->\n";

  check(
    "SEC-03 slider alt-attribute breakout does not execute",
    (await render(sliderPayload, "full")) === null,
    "window.__pwned was set from a slider alt attribute",
  );

  // ==========================================================================
  // SEC-04 - OmniWare renderer output injected raw after DOMPurify
  // ==========================================================================
  const omniwarePayload =
    "# Doc\n\n```omniware\n@nav\n  <img src=x onerror=window.__pwned='omniware'> | Home\n```\n";

  check(
    "SEC-04 OmniWare DSL payload does not execute",
    (await render(omniwarePayload, "full")) === null,
    "window.__pwned was set from an OmniWare nav label",
  );

  // ==========================================================================
  // SEC-01 - @@@html blocks reach window.parent
  // ==========================================================================
  const rawHtmlPayload =
    "# Doc\n\n@@@html\n" +
    "<p id=rawhtml-marker>raw html body</p>\n" +
    "<scr" + "ipt>try{window.parent.__pwned='iframe'}catch(e){}</scr" + "ipt>\n" +
    "@@@\n";

  check(
    "SEC-01 @@@html iframe cannot reach window.parent (full render)",
    (await render(rawHtmlPayload, "full", 2200)) === null,
    "an @@@html block wrote to window.parent - the iframe is same-origin",
  );

  check(
    "SEC-01 @@@html iframe cannot reach window.parent (light-format render)",
    (await render(rawHtmlPayload, "light-format", 2200)) === null,
    "light-format path allowed parent access",
  );

  // The sandbox attribute must be present AND must not re-grant same-origin,
  // because sandbox="allow-scripts allow-same-origin" is equivalent to no
  // sandbox at all for this purpose.
  //
  // hasPayload is asserted here on purpose: if the pipeline ever drops srcdoc
  // entirely (DOMPurify does exactly that when the value contains a <script>),
  // the two attack tests above would pass for the wrong reason - nothing ran
  // because nothing loaded. This makes that failure mode loud instead of silent.
  const iframeAttrs = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { found: false };
      const sd = f.getAttribute('srcdoc') || '';
      return {
        found: true,
        sandbox: f.getAttribute('sandbox'),
        hasSrcdoc: !!sd,
        hasPayload: sd.includes('window.parent.__pwned')
      };
    })()
  `);
  check(
    "SEC-01 @@@html iframe carries a real sandbox without allow-same-origin",
    iframeAttrs.found === true &&
      typeof iframeAttrs.sandbox === "string" &&
      iframeAttrs.sandbox.includes("allow-scripts") &&
      !iframeAttrs.sandbox.includes("allow-same-origin"),
    JSON.stringify(iframeAttrs),
  );

  check(
    "SEC-01 the attack actually loaded, so the two tests above are not vacuous",
    iframeAttrs.hasSrcdoc === true && iframeAttrs.hasPayload === true,
    JSON.stringify(iframeAttrs),
  );

  // ==========================================================================
  // Feature preservation - the remedy must not break what it protects
  // ==========================================================================

  // Mermaid still renders to SVG. Asserting only that *an* svg exists is too
  // weak: mermaid emits an svg for parse failures too, so a broken escape would
  // still "pass". Assert it is a real flowchart carrying the node labels.
  await render(
    "# Doc\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n",
    "full",
    2500,
  );
  const mermaidSvg = await exec(`
    (() => {
      const el = document.querySelector('pre.mermaid');
      const svg = el && el.querySelector('svg');
      if (!svg) return { present: !!el, hasSvg: false };
      const labels = Array.from(svg.querySelectorAll('text,tspan,foreignObject'))
        .map(t => (t.textContent || '').trim());
      return {
        present: true,
        hasSvg: true,
        role: svg.getAttribute('aria-roledescription'),
        nodeCount: svg.querySelectorAll('g.node').length,
        hasLabels: labels.includes('Start') && labels.includes('End'),
        isError: /syntax error|mermaid version/i.test(svg.textContent || ''),
        src: el.getAttribute('data-mermaid-src')
      };
    })()
  `);
  check(
    "FEATURE mermaid diagram still renders to SVG",
    mermaidSvg.present && mermaidSvg.hasSvg,
    JSON.stringify(mermaidSvg),
  );
  check(
    "FEATURE mermaid SVG is a real diagram with its labels, not an error graphic",
    mermaidSvg.hasSvg === true &&
      mermaidSvg.isError === false &&
      mermaidSvg.nodeCount === 2 &&
      mermaidSvg.hasLabels === true,
    JSON.stringify(mermaidSvg),
  );

  // Mermaid syntax containing '<' must round-trip. Class diagrams use '<|--',
  // which an over-eager escape would corrupt into something mermaid rejects.
  await render(
    "# Doc\n\n```mermaid\nclassDiagram\n  Animal <|-- Duck\n```\n",
    "full",
    2500,
  );
  const mermaidAngle = await exec(`
    (() => {
      const el = document.querySelector('pre.mermaid');
      if (!el) return { present: false };
      return {
        present: true,
        src: el.dataset.mermaidSrc || '',
        hasSvg: !!el.querySelector('svg')
      };
    })()
  `);
  check(
    "FEATURE mermaid source containing '<|--' survives intact",
    mermaidAngle.present &&
      mermaidAngle.src.includes("<|--") &&
      mermaidAngle.hasSvg,
    JSON.stringify(mermaidAngle),
  );

  // Slider still renders every slide with its real src and alt.
  await render(
    "# Doc\n\n<!-- slider-start -->\n![one](a.png)\n![two](b.png)\n<!-- slider-end -->\n",
    "full",
  );
  const slider = await exec(`
    (() => {
      const s = document.querySelector('.image-slider');
      if (!s) return { present: false };
      const imgs = [...s.querySelectorAll('.slider-slide img')];
      return {
        present: true,
        slides: s.querySelectorAll('.slider-slide').length,
        dots: s.querySelectorAll('.slider-dot').length,
        srcs: imgs.map(i => i.getAttribute('src')),
        alts: imgs.map(i => i.getAttribute('alt')),
        zoomBtns: s.querySelectorAll('.img-zoom-btn').length
      };
    })()
  `);
  check(
    "FEATURE image slider still renders slides, dots, srcs and alts",
    slider.present &&
      slider.slides === 2 &&
      slider.dots === 2 &&
      slider.zoomBtns === 2 &&
      slider.srcs.join(",").includes("a.png") &&
      slider.alts.join(",") === "one,two",
    JSON.stringify(slider),
  );

  // OmniWare still renders real markup.
  await render("# Doc\n\n```omniware\n@nav\n  Brand | Home | About\n```\n", "full");
  const omni = await exec(`
    (() => {
      const el = document.querySelector('.omniware-rendered');
      if (!el) return { present: false };
      return {
        present: true,
        hasNav: !!el.querySelector('.ow-nav-logo, .ow-nav-item'),
        text: el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80),
        dsl: el.getAttribute('data-omniware-dsl')
      };
    })()
  `);
  check(
    "FEATURE OmniWare block still renders its wireframe markup",
    omni.present && omni.hasNav && omni.text.includes("Home"),
    JSON.stringify(omni),
  );

  // @@@html still displays its content (sandboxed, but not blank).
  await render(
    "# Doc\n\n@@@html\n<p id=rawhtml-marker>hello from raw html</p>\n@@@\n",
    "full",
    2000,
  );
  const rawHtml = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { present: false };
      const sd = f.getAttribute('srcdoc') || '';
      return {
        present: true,
        srcdocHasBody: sd.includes('hello from raw html'),
        sandbox: f.getAttribute('sandbox')
      };
    })()
  `);
  check(
    "FEATURE @@@html block still carries its content into the iframe",
    rawHtml.present && rawHtml.srcdocHasBody,
    JSON.stringify(rawHtml),
  );

  // Ordinary markdown must be completely unaffected.
  await render(
    "# Title\n\n## Sub\n\nSome **bold** and `code` and [a link](https://example.invalid).\n\n" +
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n" +
      "```js\nconst x = 1;\n```\n\n" +
      "![pic](local.png)\n\n" +
      "<span style=\"color:red\" class=\"keepme\">inline html</span>\n",
    "full",
    1200,
  );
  const basics = await exec(`
    (() => {
      const v = document.getElementById('viewer');
      const span = v.querySelector('span.keepme');
      return {
        h1: v.querySelectorAll('h1').length,
        h2: v.querySelectorAll('h2').length,
        strong: v.querySelectorAll('strong').length,
        code: v.querySelectorAll('code').length,
        link: !!v.querySelector('a[href="https://example.invalid"]'),
        table: v.querySelectorAll('table tbody tr').length,
        pre: v.querySelectorAll('pre').length,
        img: !!v.querySelector('img[src="local.png"]'),
        inlineSpan: !!span,
        spanStyle: span ? span.getAttribute('style') : null
      };
    })()
  `);
  check(
    "FEATURE ordinary markdown still renders (headings, table, code, link, img)",
    basics.h1 >= 1 &&
      basics.h2 >= 1 &&
      basics.strong >= 1 &&
      basics.link &&
      basics.table === 1 &&
      basics.pre >= 1 &&
      basics.img,
    JSON.stringify(basics),
  );
  check(
    "FEATURE inline HTML with class and style attributes still survives",
    basics.inlineSpan && !!basics.spanStyle,
    JSON.stringify(basics),
  );

  // Data-URI images are placeholder-swapped around DOMPurify; moving the
  // sanitize step is exactly what could break that dance.
  const tinyPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await render(`# Doc\n\n![tiny](${tinyPng})\n`, "full", 1000);
  const dataUri = await exec(`
    (() => {
      const img = document.querySelector('#viewer img');
      return { src: img ? img.getAttribute('src') : null };
    })()
  `);
  check(
    "FEATURE data-URI images survive the sanitize step",
    typeof dataUri.src === "string" && dataUri.src.startsWith("data:image/png;base64,"),
    JSON.stringify(dataUri),
  );

  // A javascript: URL must not survive, in either path.
  await render("# Doc\n\n[click](javascript:window.__pwned='link')\n", "full");
  const jsLink = await exec(`
    (() => {
      const a = document.querySelector('#viewer a');
      return { href: a ? a.getAttribute('href') : null };
    })()
  `);
  check(
    "SANITIZER javascript: URLs are still stripped from links",
    !jsLink.href || !/^javascript:/i.test(jsLink.href.trim()),
    JSON.stringify(jsLink),
  );

  // Both render paths must agree; a payload blocked on one and not the other is
  // exactly the inconsistency SEC-26 describes.
  check(
    "SEC-26 slider payload is blocked on the light-format path too",
    (await render(sliderPayload, "light-format")) === null,
    "light-format path executed the slider payload",
  );
  check(
    "SEC-26 OmniWare payload is blocked on the light-format path too",
    (await render(omniwarePayload, "light-format")) === null,
    "light-format path executed the OmniWare payload",
  );

  // ==========================================================================
  // Raw-HTML frame ownership
  //
  // @@@html documents are attached with setAttribute *after* sanitization, so
  // the only thing stopping arbitrary markdown from picking one up is how the
  // frames are keyed. These pin that: a forged marker must get nothing, and a
  // frame must never keep showing a previous document's content.
  // ==========================================================================

  // Render a real @@@html block and capture the key the renderer assigned.
  await render(
    "# Doc\n\n@@@html\n<p id=owned-marker>owned raw html</p>\n@@@\n",
    "full",
    2200,
  );
  const realKey = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      return f ? { key: f.dataset.rawhtmlKey || null, len: (f.getAttribute('srcdoc')||'').length } : null;
    })()
  `);
  check(
    "FEATURE @@@html frame is keyed by content and receives its document",
    realKey && typeof realKey.key === "string" && realKey.key.length > 0 && realKey.len > 0,
    JSON.stringify(realKey),
  );

  // Same key, but authored directly in markdown in a document that contains no
  // @@@html block at all. The frame must come back empty - if it does not, raw
  // HTML from a previously viewed file is leaking into this one.
  const forged =
    "# Doc\n\n<iframe class=\"raw-html-block\" data-rawhtml-key=\"" +
    String(realKey && realKey.key) +
    "\"></iframe>\n";
  await render(forged, "full", 2200);
  const forgedState = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { present: false };
      const sd = f.getAttribute('srcdoc') || '';
      return { present: true, srcdocLen: sd.length, leaked: sd.includes('owned raw html') };
    })()
  `);
  check(
    "SEC-01 a markdown-authored raw-html marker receives no document",
    forgedState.present === false ||
      (forgedState.srcdocLen === 0 && forgedState.leaked === false),
    JSON.stringify(forgedState),
  );

  // Same document, this time containing the real @@@html block AND a forged
  // marker reusing its key. The key is derived from public content, so an
  // author can always compute it; what must not happen is the forged frame
  // getting a second copy of the block's document.
  const sameRender =
    "# Doc\n\n@@@html\n<p id=owned-marker>owned raw html</p>\n@@@\n\n" +
    "<iframe class=\"raw-html-block\" data-rawhtml-key=\"" +
    String(realKey && realKey.key) +
    "\"></iframe>\n";
  await render(sameRender, "full", 2500);
  const sameRenderState = await exec(`
    (() => {
      const fs = Array.from(document.querySelectorAll('iframe.raw-html-block'));
      return {
        count: fs.length,
        filled: fs.filter(f => (f.getAttribute('srcdoc')||'').includes('owned raw html')).length
      };
    })()
  `);
  check(
    "SEC-01 a forged marker cannot claim a second copy of a block in the same render",
    sameRenderState.count >= 1 && sameRenderState.filled === 1,
    JSON.stringify(sameRenderState),
  );

  // ...but two genuinely identical @@@html blocks must both still render.
  await render(
    "# Doc\n\n@@@html\n<p>twin</p>\n@@@\n\n@@@html\n<p>twin</p>\n@@@\n",
    "full",
    2500,
  );
  const twins = await exec(`
    (() => {
      const fs = Array.from(document.querySelectorAll('iframe.raw-html-block'));
      return {
        count: fs.length,
        filled: fs.filter(f => (f.getAttribute('srcdoc')||'').includes('twin')).length
      };
    })()
  `);
  check(
    "FEATURE two identical @@@html blocks both receive their document",
    twins.count === 2 && twins.filled === 2,
    JSON.stringify(twins),
  );

  // The resize channel is the only way a sandboxed @@@html frame can influence  // the host, and it now identifies the sender by matching event.source against
  // the managed frames. If contentWindow does not match for an opaque-origin
  // srcdoc frame, that check silently kills the feature - so assert the height
  // is actually applied, end to end, rather than trusting the code shape.
  await render(
    "# Doc\n\n@@@html\n<div style=\"height:640px\">tall</div>\n@@@\n",
    "full",
    3500,
  );
  const resized = await exec(`
    (() => {
      const f = document.querySelector('iframe.raw-html-block');
      if (!f) return { present: false };
      return { present: true, height: parseInt(f.style.height || '0', 10) };
    })()
  `);
  check(
    "FEATURE sandboxed @@@html frame can still report its height to the host",
    resized.present === true && resized.height >= 600,
    JSON.stringify(resized),
  );

  // ==========================================================================
  // Local image paths - the sanitizer hook must be narrow
  //
  // Drive-letter and file:///<drive> paths are ordinary usage in a local
  // viewer. UNC and remote file://host paths are not: on Windows an <img>
  // pointing at a remote SMB share is fetched automatically and can hand the
  // user's NTLM credentials to a host named by untrusted markdown.
  // ==========================================================================
  await render(
    "# Doc\n\n" +
      "<img id=i1 src=\"C:\\pics\\a.png\">\n\n" +
      "<img id=i2 src=\"file:///C:/pics/b.png\">\n\n" +
      "<img id=i3 src=\"\\\\attacker\\share\\c.png\">\n\n" +
      "<img id=i4 src=\"file://attacker/share/d.png\">\n\n" +
      "<img id=i5 src=\"img/e.png\">\n\n" +
      "<img id=i6 src=\"//attacker/share/f.png\">\n",
    "full",
    1500,
  );
  const imgs = await exec(`
    (() => {
      const g = (id) => {
        const el = document.getElementById(id);
        return el ? (el.getAttribute('src') || '') : null;
      };
      return { i1: g('i1'), i2: g('i2'), i3: g('i3'), i4: g('i4'), i5: g('i5'), i6: g('i6') };
    })()
  `);
  check(
    "FEATURE local drive-letter and file:///<drive> image paths are preserved",
    imgs.i1 === "C:\\pics\\a.png" && imgs.i2 === "file:///C:/pics/b.png",
    JSON.stringify(imgs),
  );
  check(
    "SEC-hook UNC, protocol-relative and remote file:// image paths are stripped",
    !imgs.i3 && !imgs.i4 && !imgs.i6,
    JSON.stringify(imgs),
  );
  check(
    "FEATURE ordinary relative image paths are unaffected by the hook",
    imgs.i5 === "img/e.png",
    JSON.stringify(imgs),
  );

  // Nothing above should have produced an uncaught renderer error.
  const errs = await exec(`window.__e2eErrors`);
  check(
    "no uncaught renderer errors",
    Array.isArray(errs) && errs.length === 0,
    JSON.stringify(errs),
  );
}

app.whenReady().then(async () => {
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
    console.log(
      "FAIL  harness threw:",
      error && error.stack ? error.stack : error,
    );
    results.push({ name: "harness", ok: false });
  }

  const failed = results.filter((r) => !r.ok).length;
  clearTimeout(watchdog);
  console.log(`\n=== ${results.length - failed}/${results.length} passed ===`);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  app.exit(failed === 0 ? 0 : 1);
});
