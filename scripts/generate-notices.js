#!/usr/bin/env node
// ============================================
// generate-notices.js - build THIRD-PARTY-NOTICES.md from what actually ships
// ============================================
//
// Folia is MIT, and it is tempting to conclude that a permissively licensed
// product has nothing further to do. That is the wrong reading. Nearly every
// permissive licence in this tree - MIT, ISC, BSD, Apache-2.0 - grants the
// right to redistribute ON CONDITION that its own copyright notice and licence
// text are reproduced in the distribution. The obligation belongs to each
// dependency and is completely independent of the licence Folia chooses for
// itself. `build.files` ships `node_modules/**/*`, so all of them are in the
// installer, and until this file existed none of their notices were.
//
// Three sources have to be merged, because no single one sees everything:
//
//   1. The npm production tree. electron-builder prunes devDependencies but
//      ships the rest, so `npm ls --omit=dev --all` is the shipped set.
//   2. libs/, which is vendored by scripts/vendor-libs.js. Most of it is also
//      an npm dependency and so already covered - but Tabulator is NOT a
//      declared dependency at all. It exists only as a committed file, so a
//      dependency-tree walk cannot see it, and it would have been the one
//      component shipped with no notice and no version record anywhere.
//   3. Things that are not JavaScript packages: the Fira Code fonts (OFL-1.1,
//      which additionally requires the licence to travel beside the font files
//      themselves - see scripts/vendor-libs.js) and Electron/Chromium.
//
// Electron and Chromium are deliberately referenced rather than inlined:
// electron-builder already emits LICENSE.electron.txt and the ~8 MB
// LICENSES.chromium.html next to the executable, so copying them here would
// create a second copy that goes stale on every Electron bump.
//
// Regenerate with `npm run notices`. test-packaging.js regenerates it in
// memory and fails if the committed file differs, so adding a dependency
// without refreshing the notices is caught rather than shipped.
const { execFileSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "THIRD-PARTY-NOTICES.md");

// Shared by the README harvester and the "did we actually reproduce terms"
// assertion: a block that contains none of these operative phrases is a label
// or a badge, not a grant. The Blue Oak alternative is not padding - `sax`
// ships BlueOak-1.0.0, which is deliberately written in plain English and
// contains none of the traditional formulae ("Each contributor licenses you to
// do everything..." rather than "Permission is hereby granted"). It was found
// by measuring all 220 entries rather than by predicting which families exist.
const LICENCE_BODY_RE =
  /permission is hereby granted|permission to use, copy, modify|redistribution and use|WITHOUT WARRANT|each contributor licenses you|comes as is, without any warranty/i;

// Canonical SPDX licence texts, used ONLY for packages that publish neither a
// licence file nor licence prose in a README. Six shipped packages are in that
// position, and `!**/*.md` strips READMEs out of the packaged app anyway, so
// without this the terms of those packages would exist nowhere in the
// distribution at all. Licence texts are published to be copied verbatim; what
// must not be invented is the copyright line, so the holder is taken from the
// package's own `author` field and the year is left as the SPDX placeholder
// rather than guessed. Every such entry says so on its face.
const CANONICAL = {
  MIT: `MIT License

Copyright (c) <year> {holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  ISC: `ISC License

Copyright (c) <year> {holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.`,
};

// The `author` field is `string | { name, email }`; both forms are in the tree.
function authorOf(pj) {
  const a = pj.author || (Array.isArray(pj.contributors) && pj.contributors[0]);
  if (!a) return null;
  const s = typeof a === "string" ? a : [a.name, a.email && `<${a.email}>`].filter(Boolean).join(" ");
  return s.trim() || null;
}

// The version a vendored file reports about itself is better evidence than a
// number written down beside it, which can only ever drift. Tabulator's bundle
// opens with `/* Tabulator v6.2.5 (c) Oliver Folkerd 2024 */`, so the version
// is read back out of the artifact that actually ships. If that banner ever
// stops matching, this throws rather than quietly reporting a stale version.
function vendoredTabulatorVersion() {
  const file = path.join(ROOT, "libs", "tabulator", "tabulator.min.js");
  const head = fs.readFileSync(file, "utf8").slice(0, 200);
  const m = /Tabulator\s+v(\d+\.\d+\.\d+)/.exec(head);
  if (!m) {
    throw new Error(
      `Could not read a version banner from ${path.relative(ROOT, file)}. ` +
        "Tabulator is not an npm dependency, so this banner is the only " +
        "record of which version ships.",
    );
  }
  return m[1];
}

// Components that ship but are invisible to a dependency-tree walk.
const EXTRA = [
  {
    name: "Tabulator",
    version: vendoredTabulatorVersion(),
    spdx: "MIT",
    homepage: "https://tabulator.info/",
    note:
      "Vendored into libs/tabulator/ rather than installed from npm, so it " +
      "does not appear in the dependency tree. The vendored bundle was " +
      "verified byte-identical (modulo line endings) to tabulator-tables on " +
      "npm at the version above, and this licence text is that release's own " +
      "LICENSE file, copied to libs/tabulator/LICENSE so it ships beside the " +
      "code it covers.",
    licenseFile: path.join(ROOT, "libs", "tabulator", "LICENSE"),
  },
  {
    name: "Fira Code",
    version: null,
    spdx: "OFL-1.1",
    homepage: "https://github.com/tonsky/FiraCode",
    note:
      "The application typeface. Shipped as fonts/FiraCode-*.ttf, with a copy " +
      "of this licence beside them as fonts/LICENSE-FiraCode.txt, which " +
      "clause 2 of the OFL requires.",
    licenseFile: path.join(ROOT, "assets", "fonts", "LICENSE-FiraCode.txt"),
  },
];

// A dual licence is an OFFER, not a description: the redistributor picks one
// and the notice has to say which, or downstream cannot tell what terms they
// received. Recorded here rather than decided silently inside the formatter.
//
// `marker` is load-bearing, not documentation. dompurify ships BOTH an Apache
// `LICENSE` and an MPL `LICENSE-MPL`, and the generic "shortest filename wins"
// rule happens to select the Apache one - which is the elected licence purely
// by coincidence. Rename either file upstream and the notices would reproduce
// MPL text under an "elects Apache-2.0" banner. The marker makes the election
// choose the file instead of merely describing whatever the sort picked.
const DUAL_ELECTION = {
  "(MIT OR GPL-3.0-or-later)": {
    chosen: "MIT",
    why: "Folia is MIT-licensed; electing MIT keeps the whole distribution permissive.",
    marker: /\bMIT License\b/i,
  },
  "(MPL-2.0 OR Apache-2.0)": {
    chosen: "Apache-2.0",
    why: "Apache-2.0 carries no per-file source-disclosure obligation, unlike MPL-2.0.",
    marker: /\bApache License\b/i,
  },
};

function readLicenseText(dir, prefer) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  // Prefer an exact LICENSE over LICENSE-MIT etc. so a package offering several
  // does not have one picked at random by directory order.
  const ranked = entries
    .filter((f) => /^(LICEN[CS]E|COPYING|UNLICENSE)/i.test(f))
    .filter((f) => {
      try {
        return fs.statSync(path.join(dir, f)).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (!ranked.length) return null;

  const load = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n").trim();
    } catch {
      return null;
    }
  };

  // When the package is dual-licensed, the file whose TEXT is the elected
  // licence wins over the file whose NAME happens to sort first. A package
  // shipping one combined file (jszip states both offers in a single
  // LICENSE.markdown) still matches, because the marker is searched in the
  // text rather than in the filename.
  if (prefer) {
    for (const f of ranked) {
      const text = load(f);
      if (text && prefer.test(text)) return { file: f, text };
    }
  }
  const text = load(ranked[0]);
  return text === null ? null : { file: ranked[0], text };
}

// A NOTICE file is NOT just another licence file, which is why it is collected
// separately rather than folded into the ranking above. Apache-2.0 section 4(d)
// makes propagating it a hard condition of redistribution: if a package ships
// one, its contents must appear in the derivative work's own notices. Nothing
// in this tree ships one today (measured: 0 of 265 production packages), so
// this is a guard against a future dependency introducing the obligation
// silently rather than a fix for a present breach.
function readNoticeText(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const found = entries
    .filter((f) => /^NOTICE(\.|$)/i.test(f))
    .filter((f) => {
      try {
        return fs.statSync(path.join(dir, f)).isFile();
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (!found.length) return null;
  try {
    return {
      file: found[0],
      text: fs.readFileSync(path.join(dir, found[0]), "utf8").replace(/\r\n/g, "\n").trim(),
    };
  } catch {
    return null;
  }
}

function spdxOf(pj) {
  if (typeof pj.license === "string") return pj.license;
  if (pj.license && typeof pj.license.type === "string") return pj.license.type;
  if (Array.isArray(pj.licenses)) return pj.licenses.map((l) => l.type).join(" OR ");
  return null;
}

// Some packages ship no licence file at all and state their terms only in the
// README. That is a real gap rather than a cosmetic one here: `build.files`
// ends with `!**/*.md`, which strips READMEs out of node_modules in the
// packaged app, so for those packages the licence text would exist NOWHERE in
// the distribution - not as a licence file, not as a README, and not in the
// notices. Harvesting the README's licence section is what puts it back.
function readLicenseFromReadme(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const readme = entries.find((f) => /^readme(\.|$)/i.test(f));
  if (!readme) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(dir, readme), "utf8").replace(/\r\n/g, "\n");
  } catch {
    return null;
  }
  // Done line by line rather than with one regex. The regex version of this
  // silently harvested NOTHING: `\Z` is not a JavaScript escape (it matches a
  // literal "Z"), and the "same or higher level" lookahead `\1#*` actually
  // matched same-or-DEEPER. Both mistakes read as plausible and neither throws,
  // so the function returned null for every package and the failure presented
  // as "no package happens to document its licence in prose".
  const lines = text.split("\n");
  const atxLevel = (l) => {
    const m = /^(#{1,6})[ \t]+\S/.exec(l);
    return m ? m[1].length : 0;
  };
  const isSetextRule = (l) => /^[-=]{3,}[ \t]*$/.test(l);
  const looksLikeLicenceTitle = (l) => /^[ \t]*#{0,6}[ \t]*\(?(the[ \t]+)?[a-z0-9 .+-]*licen[cs]e/i.test(l);

  let start = -1;
  let headingLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const lvl = atxLevel(lines[i]);
    if (lvl && looksLikeLicenceTitle(lines[i])) {
      start = i + 1;
      headingLevel = lvl;
      break;
    }
    // Setext: a title line underlined by --- or ===.
    if (!lvl && looksLikeLicenceTitle(lines[i]) && i + 1 < lines.length && isSetextRule(lines[i + 1])) {
      start = i + 2;
      headingLevel = lines[i + 1][0] === "=" ? 1 : 2;
      break;
    }
  }
  if (start < 0) return null;

  const body = [];
  for (let i = start; i < lines.length; i++) {
    const lvl = atxLevel(lines[i]);
    // Stop at the next heading of the same or higher level (fewer or equal
    // hashes), so a trailing "## Contributing" is not swallowed but a
    // "### Exceptions" nested inside the licence section is kept.
    if (lvl && lvl <= headingLevel) break;
    if (i + 1 < lines.length && isSetextRule(lines[i + 1]) && lines[i].trim()) break;
    body.push(lines[i]);
  }
  // READMEs are markdown, so the copyright line is commonly HTML-escaped
  // (browser-split publishes `&lt;julian@juliangruber.com&gt;`). Reproducing
  // the escaped form would misstate the copyright holder's address.
  const trimmed = body
    .join("\n")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
  // A one-line "MIT" pointer is a label, not the licence text. Reproducing it
  // would satisfy the assertion while discharging nothing.
  if (trimmed.length < 200 || !LICENCE_BODY_RE.test(trimmed)) return null;
  return { file: readme, text: trimmed };
}

// A README heading like "## MIT Licenced" (the `error` package) is the only
// statement of terms some packages make: no `license` field, no licence file,
// no prose. It is a declaration, not licence text, so it feeds the SPDX
// identifier rather than the text block.
function spdxFromReadme(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const readme = entries.find((f) => /^readme(\.|$)/i.test(f));
  if (!readme) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(dir, readme), "utf8");
  } catch {
    return null;
  }
  const m = /\b(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0)\b[ \t]+licen[cs]/i.exec(text);
  return m ? m[1].toUpperCase().replace("APACHE-2.0", "Apache-2.0") : null;
}

// The set of packages that actually ships is the one `npm ci` installs, which
// is exactly package-lock.json's non-dev tree - and it is what electron-builder
// prunes to. Reading it directly rather than shelling out to `npm ls` fixes a
// real defect: `npm ls` reports whatever is on disk, INCLUDING packages left
// behind by earlier installs. On this machine it reported 259 packages against
// the lockfile's 219, among them jsdom@30.0.0, which npm itself marks
// `extraneous` and which is demonstrably absent from the built app.asar. The
// notices were therefore describing the workstation rather than the product,
// and would differ between developers.
function productionPackages() {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
  const out = [];
  for (const [key, meta] of Object.entries(lock.packages || {})) {
    if (!key.startsWith("node_modules/")) continue;
    if (meta.dev || meta.devOptional) continue;
    out.push({ dir: path.join(ROOT, key), optional: Boolean(meta.optional) });
  }
  return out;
}

function collect() {
  const byKey = new Map();
  for (const { dir, optional } of productionPackages()) {
    let pj;
    try {
      pj = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch {
      // An optional dependency that does not install on this platform is
      // absent by design and must not abort generation; anything else missing
      // means node_modules disagrees with the lockfile, which is worth saying
      // out loud rather than silently dropping a package from the notices.
      if (!optional) {
        throw new Error(
          `${path.relative(ROOT, dir)} is in package-lock.json but not installed. ` +
            "Run `npm ci` before `npm run notices` so the notices describe a clean tree.",
        );
      }
      continue;
    }
    const key = `${pj.name}@${pj.version}`;
    if (byKey.has(key)) continue;
    let spdx = spdxOf(pj);
    const elect = spdx ? DUAL_ELECTION[spdx] : null;
    let lic = readLicenseText(dir, elect && elect.marker);
    let fromReadme = false;
    let canonical = null;
    if (!lic) {
      lic = readLicenseFromReadme(dir);
      fromReadme = Boolean(lic);
    }
    let spdxSource = spdx ? "package.json" : null;
    if (!lic) {
      if (!spdx) {
        const declared = spdxFromReadme(dir);
        if (declared) {
          spdx = declared;
          spdxSource = "README";
        }
      }
      const template = spdx && CANONICAL[spdx];
      if (template) {
        const holder = authorOf(pj);
        lic = { file: null, text: template.replace("{holder}", holder || "<copyright holders>") };
        canonical = { spdx, holder, spdxSource };
      }
    }
    const notice = readNoticeText(dir);
    byKey.set(key, {
      name: pj.name,
      version: pj.version,
      // khroma ships a licence file but no `license` field, so trusting the
      // field alone would have reported it as unlicensed.
      spdx: spdx || (lic ? "see licence text below" : null),
      homepage:
        pj.homepage ||
        (pj.repository && (pj.repository.url || pj.repository)) ||
        `https://www.npmjs.com/package/${pj.name}`,
      licenseFile: lic ? lic.file : null,
      licenseText: lic ? lic.text : null,
      licenseFromReadme: fromReadme,
      licenseCanonical: canonical,
      noticeFile: notice ? notice.file : null,
      noticeText: notice ? notice.text : null,
      note: null,
    });
  }

  const extras = EXTRA.map((e) => {
    const out = Object.assign({}, e);
    if (e.licenseFile) {
      out.licenseText = fs
        .readFileSync(e.licenseFile, "utf8")
        .replace(/\r\n/g, "\n")
        .trim();
      out.licenseFile = path.relative(ROOT, e.licenseFile).replace(/\\/g, "/");
    }
    return out;
  });

  return [...byKey.values(), ...extras].sort((a, b) =>
    a.name.localeCompare(b.name, "en") || String(a.version).localeCompare(String(b.version)),
  );
}

function render(components) {
  const lines = [];
  lines.push("# Third-party notices");
  lines.push("");
  lines.push(
    "Folia is distributed under the MIT licence (see `LICENSE`). It also " +
      "redistributes the components listed below, each under its own terms.",
  );
  lines.push("");
  lines.push(
    "Almost every licence here grants redistribution **on condition that its " +
      "copyright notice and licence text are reproduced**. That obligation is " +
      "the component's, not Folia's, and it is not discharged by Folia also " +
      "being permissively licensed - which is why this file exists and ships " +
      "inside the application.",
  );
  lines.push("");
  lines.push(
    "This file is generated by `scripts/generate-notices.js` (`npm run " +
      "notices`) from the dependency tree that is actually packaged, plus the " +
      "vendored components that are not npm packages. Do not edit it by hand.",
  );
  lines.push("");
  lines.push("## Electron and Chromium");
  lines.push("");
  lines.push(
    "Electron (MIT) and the Chromium content module (BSD-3-Clause and others) " +
      "are shipped by electron-builder, which writes their full notices next " +
      "to the executable as `LICENSE.electron.txt` and " +
      "`LICENSES.chromium.html`. They are referenced rather than copied here " +
      "so there is only one copy to keep current across Electron upgrades.",
  );
  lines.push("");

  // A summary table first: the question asked of a notices file in practice is
  // "is there anything copyleft in here", and that should not require reading
  // a megabyte of licence text.
  const counts = new Map();
  for (const c of components) {
    const k = c.spdx || "UNDECLARED";
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  lines.push("## Licence summary");
  lines.push("");
  lines.push("| Licence | Components |");
  lines.push("| --- | --- |");
  for (const [k, v] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const elect = DUAL_ELECTION[k];
    lines.push(`| ${k}${elect ? ` (Folia elects **${elect.chosen}**)` : ""} | ${v} |`);
  }
  lines.push("");
  for (const [k, e] of Object.entries(DUAL_ELECTION)) {
    if (!counts.has(k)) continue;
    lines.push(`Under \`${k}\` Folia elects **${e.chosen}**. ${e.why}`);
    lines.push("");
  }

  lines.push(`## Components (${components.length})`);
  lines.push("");
  for (const c of components) {
    lines.push(`### ${c.name}${c.version ? ` ${c.version}` : ""}`);
    lines.push("");
    lines.push(`- Licence: ${c.spdx || "not declared"}`);
    if (c.homepage) lines.push(`- Home: ${String(c.homepage).replace(/^git\+/, "")}`);
    if (c.note) lines.push(`- ${c.note}`);
    // Stated on the entry itself, not only in the summary table above. jszip's
    // licence file sets out BOTH offers in one document, so its text below
    // contains the full GPLv3 as well as the MIT terms; a reader who lands on
    // that entry needs to see which limb was taken without scrolling back.
    if (c.spdx && DUAL_ELECTION[c.spdx]) {
      const e = DUAL_ELECTION[c.spdx];
      lines.push(
        `- Dual-licensed. Folia elects **${e.chosen}**; the other offer is not ` +
          `relied on. ${e.why}`,
      );
    }
    lines.push("");
    if (c.licenseText) {
      if (c.licenseFromReadme) {
        // Said explicitly, because where the text came from affects how much
        // weight a reader should give it: this is the package's own statement
        // of terms, but it was published in prose rather than in a licence
        // file, so the exact wording is the author's README wording.
        lines.push(
          `Terms as stated in the package's \`${c.licenseFile}\` (it ships no ` +
            "separate licence file):",
        );
        lines.push("");
      }
      if (c.licenseCanonical) {
        // The provenance of this block is different in kind from every other
        // one in this file - it was not copied from the package - so it is
        // labelled rather than presented as the package's own text.
        lines.push(
          `This package publishes no licence file and no licence text in its ` +
            `README. It declares \`${c.licenseCanonical.spdx}\`` +
            (c.licenseCanonical.spdxSource === "README"
              ? " in its README (it has no `license` field in `package.json`)"
              : " in its `package.json`") +
            `. The canonical text of that licence is reproduced below; the ` +
            (c.licenseCanonical.holder
              ? "copyright holder is taken from the package's own `author` field"
              : "package names no author, so the copyright holder is left as the SPDX placeholder") +
            ", and the year is left as the SPDX placeholder rather than guessed.",
        );
        lines.push("");
      }
      lines.push("```");
      lines.push(c.licenseText);
      lines.push("```");
    } else {
      // Said plainly rather than papered over. A package that declares a
      // licence but ships no text still has to be reported honestly; the SPDX
      // identifier above is the authoritative statement in that case.
      lines.push(
        "_This package ships no licence file. The SPDX identifier declared in " +
          "its `package.json` is reproduced above._",
      );
    }
    if (c.noticeText) {
      // Apache-2.0 section 4(d): the NOTICE file's attribution text must be
      // reproduced in derivative works. It is a separate obligation from
      // reproducing the licence, so it gets its own labelled block.
      lines.push("");
      lines.push(
        `Attribution notice (\`${c.noticeFile}\`), reproduced as required by ` +
          "Apache-2.0 section 4(d):",
      );
      lines.push("");
      lines.push("```");
      lines.push(c.noticeText);
      lines.push("```");
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

function build() {
  return render(collect());
}

function main() {
  const text = build();
  const previous = fs.existsSync(OUT) ? fs.readFileSync(OUT, "utf8") : null;
  fs.writeFileSync(OUT, text, "utf8");
  const hash = crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
  console.log(
    `${path.relative(ROOT, OUT)}: ${(text.length / 1024).toFixed(0)} KB, sha256:${hash}` +
      (previous === text ? " (unchanged)" : " (updated)"),
  );
}

module.exports = {
  build,
  collect,
  render,
  readLicenseText,
  readNoticeText,
  readLicenseFromReadme,
  spdxFromReadme,
  CANONICAL,
  LICENCE_BODY_RE,
};

if (require.main === module) main();
