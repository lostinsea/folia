#!/usr/bin/env node
// ============================================
// vendor-libs.js - copy runtime libraries out of node_modules
// ============================================
//
// index.html used to pull marked, mermaid and DOMPurify from a public CDN at
// runtime. In a window with `nodeIntegration: true` that is a remote code
// execution path: anyone able to tamper with the CDN response (a compromised
// CDN, a hostile network, DNS spoofing) gets `require("child_process")` on the
// user's machine. DOMPurify being one of them is worse still - the sanitiser
// protecting against malicious markdown was itself fetched over the network.
//
// It also meant the app could not render anything offline, and that the
// versions in package.json were decorative: `npm audit` inspected the npm tree
// while the app actually ran whatever the CDN served.
//
// This copies the real installed builds into libs/vendor/ so the app runs the
// audited versions. It runs on `postinstall`, so the copies cannot drift from
// package.json.

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "libs", "vendor");

// [package, file within the package, destination name]
const LIBS = [
  ["marked", "lib/marked.umd.js", "marked.min.js"],
  ["mermaid", "dist/mermaid.min.js", "mermaid.min.js"],
  ["dompurify", "dist/purify.min.js", "purify.min.js"],
];

// styles.css declares @font-face rules pointing at fonts/FiraCode-*.ttf.
// fonts/ is a BUILD OUTPUT (gitignored, see .gitignore), so the TTFs need a
// tracked source; assets/fonts/ is it. They used to live in the bundled
// vscode-extension subtree, which was dropped from this fork - had they not
// been relocated first, a clean clone would have vendored no TTFs, the
// @font-face rules would have failed silently, and code blocks would have
// dropped to a generic monospace with nothing reporting why.
const FONT_SRC = path.join(ROOT, "assets", "fonts");
const FONT_OUT = path.join(ROOT, "fonts");

// OmniWare's hand-drawn look depends on two Google fonts, which it pulled with
// an `@import url('https://fonts.googleapis.com/...')` inside its embedded
// stylesheet. In the desktop app that import is refused by the popup CSP
// (style-src 'unsafe-inline' only), so every OmniWare diagram silently fell
// back to generic `cursive` - the feature looked broken and nothing said why.
//
// Relaxing the CSP to allow fonts.googleapis.com would have fixed the symptom
// while reintroducing exactly what SEC-16 removed: a remote fetch on render,
// which also leaks the reader's IP and fails offline. Vendoring is the same
// answer that was already applied to marked/mermaid/DOMPurify and Fira Code.
//
// woff2 only: every renderer this app runs in is Chromium, and the .woff
// fallback would double the shipped bytes for no one.
const WEB_FONTS = [
  ["@fontsource/architects-daughter", "architects-daughter-latin-400-normal.woff2"],
  ["@fontsource/patrick-hand", "patrick-hand-latin-400-normal.woff2"],
];

function copy(from, to, label) {
  if (!fs.existsSync(from)) {
    throw new Error(`vendor-libs: missing ${label} at ${from}`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const kb = (fs.statSync(to).size / 1024).toFixed(0);
  console.log(`  ${path.relative(ROOT, to)}  (${kb} KB)`);
}

function main() {
  console.log("Vendoring runtime libraries into libs/vendor ...");
  const versions = {};

  for (const [pkg, file, dest] of LIBS) {
    const pkgDir = path.join(ROOT, "node_modules", pkg);
    const meta = JSON.parse(
      fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
    );
    versions[pkg] = meta.version;
    copy(path.join(pkgDir, file), path.join(OUT, dest), pkg);
  }

  // Not optional and not silently skippable: styles.css names each TTF
  // explicitly, and a missing file is invisible at runtime (the @font-face
  // rule just never matches). So read the filenames the stylesheet actually
  // asks for and require every one of them - if a weight is added to the CSS
  // without adding the file, vendoring fails here instead of degrading to a
  // generic monospace in front of the user.
  console.log("Vendoring Fira Code ...");
  const cssText = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
  const wanted = [
    ...new Set(
      [
        ...cssText.matchAll(
          /url\(\s*['"]?fonts\/([^'")?#]+\.ttf)(?:[?#][^'")]*)?['"]?\s*\)/gi,
        ),
      ].map((m) => m[1]),
    ),
  ];
  if (wanted.length === 0) {
    throw new Error(
      "vendor-libs: styles.css references no fonts/*.ttf - the @font-face " +
        "rules were removed or this regex stopped matching them",
    );
  }
  // Vendoring must be AUTHORITATIVE, not merely additive. Copying the wanted
  // files while leaving unknown ones behind means fonts/ is the union of every
  // version of this script that has ever run on the machine. That is not
  // hypothetical: FiraCode-Retina.ttf is referenced by nothing and used to be
  // copied here by the previous "copy every *.ttf" implementation, and
  // build.files ships `fonts/**/*` wholesale - so on any existing checkout it
  // would keep shipping ~285 KB of dead bytes for as long as nobody ran
  // `git clean`. test-packaging.js enumerates fonts/ FROM DISK, so it would
  // have gone on happily asserting the stale file was packaged correctly.
  if (fs.existsSync(FONT_OUT)) {
    for (const f of fs.readdirSync(FONT_OUT).filter((n) => /\.ttf$/i.test(n))) {
      if (!wanted.includes(f)) {
        fs.unlinkSync(path.join(FONT_OUT, f));
        console.log(`  removed stale fonts/${f}`);
      }
    }
  }
  for (const f of wanted) {
    copy(path.join(FONT_SRC, f), path.join(FONT_OUT, f), "font");
  }

  console.log("Vendoring OmniWare's hand-drawn fonts ...");
  for (const [pkg, file] of WEB_FONTS) {
    const pkgDir = path.join(ROOT, "node_modules", pkg);
    const meta = JSON.parse(
      fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"),
    );
    versions[pkg] = meta.version;
    copy(path.join(pkgDir, "files", file), path.join(FONT_OUT, file), pkg);
  }

  // Recorded so the shipped versions are auditable without unminifying.
  fs.writeFileSync(
    path.join(OUT, "VERSIONS.json"),
    JSON.stringify({ generatedBy: "scripts/vendor-libs.js", versions }, null, 2) +
      "\n",
    "utf8",
  );
  console.log("Done:", JSON.stringify(versions));
}

main();
