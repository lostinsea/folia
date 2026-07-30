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

// styles.css declares @font-face rules pointing at fonts/FiraCode-*.ttf, but
// that directory only existed in the vscode-extension subtree, so the rules
// silently failed and the app fell back to the Google Fonts CDN.
const FONT_SRC = path.join(ROOT, "vscode-extension", "media", "fonts");
const FONT_OUT = path.join(ROOT, "fonts");

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

  if (fs.existsSync(FONT_SRC)) {
    console.log("Vendoring Fira Code ...");
    for (const f of fs.readdirSync(FONT_SRC).filter((n) => /\.ttf$/i.test(n))) {
      copy(path.join(FONT_SRC, f), path.join(FONT_OUT, f), "font");
    }
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
