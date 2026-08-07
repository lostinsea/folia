// ============================================
// test-packaging.js - do the files the app loads at runtime actually ship?
// ============================================
//
// package.json's `build.files` is an explicit allowlist, so anything added to
// the app that is loaded by path - a preload script, a vendored library, a font
// - is silently absent from packaged builds unless it is also added here. The
// failure is invisible in development, where everything is read straight from
// the working tree, and only shows up as a broken feature in a shipped build.
//
// This walks the real runtime references (preload paths in main.js, <script>
// and <link> in index.html, @font-face URLs in styles.css) and asserts each is
// matched by the allowlist.
//
// Run: node test-packaging.js

const fs = require("fs");
const path = require("path");
const os = require("os");

const ROOT = __dirname;
let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? " - " + detail : ""}`);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// electron-builder uses glob semantics; only the small subset this manifest
// actually uses needs to be understood here.
function patternToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` crosses directory separators; `**/` may also match zero segments
        // so that "libs/**/*" matches "libs/x.js" as well as "libs/a/x.js".
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return new RegExp("^" + out + "$", "i");
}

function isPackaged(files, rel) {
  const norm = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  let included = false;
  for (const entry of files) {
    const negated = entry.startsWith("!");
    const re = patternToRegExp(negated ? entry.slice(1) : entry);
    if (re.test(norm)) included = !negated;
  }
  return included;
}

function main() {
  console.log("\n=== Packaging allowlist ===\n");

  const pkg = JSON.parse(read("package.json"));
  const files = pkg.build && pkg.build.files;
  check("package.json declares build.files", Array.isArray(files) && files.length > 0);
  if (!Array.isArray(files)) {
    console.log("\nCannot continue without build.files.\n");
    process.exit(1);
  }

  // Sanity-check the matcher itself, so a broken matcher cannot make the real
  // assertions below pass vacuously.
  check("matcher: exact name matches", isPackaged(["main.js"], "main.js"));
  check("matcher: exact name does not over-match", !isPackaged(["main.js"], "other.js"));
  check("matcher: ** matches nested", isPackaged(["libs/**/*"], "libs/vendor/x.js"));
  check("matcher: ** matches direct child", isPackaged(["libs/**/*"], "libs/x.js"));
  check("matcher: negation excludes", !isPackaged(["a/**/*", "!a/b.js"], "a/b.js"));
  check(
    "matcher: a file that is genuinely absent is reported absent",
    !isPackaged(files, "definitely-not-shipped-xyz.js"),
  );

  const referenced = new Set();

  // 1. Preload scripts referenced from the main process.
  const mainJs = read("main.js");
  const preloadRe = /preload:\s*path\.join\(\s*__dirname\s*,\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let m;
  while ((m = preloadRe.exec(mainJs))) referenced.add(m[1]);
  check("found at least one preload reference in main.js", referenced.size > 0);

  // 2. Scripts and stylesheets loaded by the renderer document.
  const indexHtml = read("index.html");
  const srcRe = /<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"':]+)["']/gi;
  while ((m = srcRe.exec(indexHtml))) {
    const ref = m[1].replace(/^\.\//, "");
    if (!/^(https?:|data:|#)/i.test(ref)) referenced.add(ref);
  }

  // 3. Font files referenced by @font-face, which have no import statement to
  //    give them away and so are especially easy to leave out.
  const css = read("styles.css");
  const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  while ((m = urlRe.exec(css))) {
    const ref = m[1].replace(/^\.\//, "");
    if (!/^(https?:|data:)/i.test(ref)) referenced.add(ref);
  }

  // 4. Assets loaded lazily at runtime by injecting a <script> or <link>, or by
  //    any other runtime construct. These have no static tag in index.html, so
  //    step 2 cannot see them - which is the same invisibility problem this
  //    whole file exists for, one level deeper. Removing mermaid's eager
  //    <script> tag for PERF-03 silently dropped it from this test's coverage
  //    until this step was added.
  //
  //    The scan is deliberately construct-agnostic: it matches any string
  //    literal that looks like a shipped asset path, so `new Worker(...)`,
  //    `setAttribute('src', ...)`, `import(...)` and `new URL(...)` are all
  //    caught without needing a rule each. An earlier version keyed on
  //    `.src = '...'` specifically, which meant a future asset added through
  //    any other construct would have slipped past in silence.
  //
  //    Over-matching is the safe direction here: a path named in a comment or
  //    an error message only adds an assertion that the file ships, which it
  //    should. Under-matching is the failure that actually costs anything.
  const runtimeSources = fs
    .readdirSync(ROOT)
    .filter((f) => f.endsWith(".js") && !/^(test-|bench-|probe-)/.test(f));
  const assetLiteralRe =
    /['"`]((?:libs|fonts|assets)\/[^'"`$\\\s]+\.(?:js|mjs|css|woff2?|ttf|eot|svg|png|jpg|gif))['"`]/g;
  // A path built by interpolation cannot be resolved statically. Rather than
  // quietly missing it, say so.
  const unresolvableRe = /`(?:libs|fonts|assets)\/[^`]*\$\{/g;
  const unresolvable = [];
  for (const file of runtimeSources) {
    const src = read(file);
    while ((m = assetLiteralRe.exec(src))) referenced.add(m[1]);
    if (unresolvableRe.test(src)) unresolvable.push(file);
    unresolvableRe.lastIndex = 0;
  }
  check(
    "no runtime asset path is built by interpolation the scanner cannot resolve",
    unresolvable.length === 0,
    `template-literal asset paths in ${unresolvable.join(", ")} cannot be ` +
      "checked statically; either make the path a literal or extend this step",
  );
  // A canary rather than a count. "at least one dynamic reference exists" was
  // satisfied by mermaid alone, so it stayed green - and stayed reassuring -
  // even if a newly added lazy asset was being missed entirely.
  check(
    "the known lazily-loaded bundle is discovered by the scanner",
    referenced.has("libs/vendor/mermaid.min.js"),
    "mermaid.min.js is injected at runtime by ensureMermaid() but this scan " +
      "did not find it; if lazy loading was removed, delete this check, but " +
      "if the loader merely changed shape, the scanner is now blind",
  );

  console.log(`\n  ${referenced.size} runtime references discovered\n`);

  for (const ref of [...referenced].sort()) {
    const onDisk = fs.existsSync(path.join(ROOT, ref));
    // A reference that does not exist on disk is a separate (worse) bug, but
    // it is not a packaging bug, so report it distinctly rather than as a
    // missing allowlist entry.
    check(
      `${ref} exists on disk`,
      onDisk,
      onDisk ? "" : "referenced at runtime but not present",
    );
    if (onDisk) {
      check(`${ref} is in build.files`, isPackaged(files, ref));
    }
  }

  // Explicit regression guards for the two files this suite was written for.
  check("popup-preload.js is in build.files", isPackaged(files, "popup-preload.js"));
  // fonts/ is a BUILD OUTPUT (gitignored) produced by scripts/vendor-libs.js
  // from the tracked assets/fonts/. Asserting only on fonts/ would therefore
  // keep passing on a machine that has stale build output while the SOURCE has
  // been deleted from the repo - and the first sign of trouble would be a
  // postinstall failure on someone else's clean clone, or nothing at all in an
  // environment that installs with scripts disabled. So assert the source too.
  const fontSrcDir = path.join(ROOT, "assets", "fonts");
  check(
    "assets/fonts is present and populated (tracked source for font vendoring)",
    fs.existsSync(fontSrcDir) &&
      fs.readdirSync(fontSrcDir).some((f) => /\.ttf$/i.test(f)),
    fs.existsSync(fontSrcDir) ? fs.readdirSync(fontSrcDir).join(",") : "absent",
  );
  const fontFiles = fs.existsSync(path.join(ROOT, "fonts"))
    ? fs.readdirSync(path.join(ROOT, "fonts")).filter((f) => /\.ttf$/i.test(f))
    : [];
  check("vendored fonts exist", fontFiles.length > 0);
  for (const f of fontFiles) {
    check(`fonts/${f} is in build.files`, isPackaged(files, "fonts/" + f));
  }

  // Shipping the right file list is useless if electron-builder refuses the
  // configuration outright. The 24 -> 26 upgrade removed `win.sign` (signing
  // moved under `win.signtoolOptions`), which made EVERY packaged build fail
  // at the schema-validation step - invisible to the whole test suite, because
  // tests run from the working tree and never invoke the packager. The release
  // workflow would have been the first thing to find out.
  //
  // electron-builder ships its own JSON schema and validates against it with
  // ajv. We do the same thing here rather than hand-rolling a key walker: a
  // first attempt only compared top-level key names per section, which caught
  // the `win.sign` case but was blind to nested objects (`win.target[].*`,
  // `extraResources[].*`, `directories.*`), to value-type changes
  // (`win.icon` becoming an object), and to any section not in a hard-coded
  // list. Delegating to the real validator covers all of those for free and
  // cannot drift out of step with the sections the config actually uses.
  const schemaPath = path.join(
    ROOT,
    "node_modules",
    "app-builder-lib",
    "scheme.json",
  );
  if (!fs.existsSync(schemaPath)) {
    check("electron-builder schema is available to validate against", false,
      "node_modules/app-builder-lib/scheme.json not found");
  } else {
    let Ajv = null;
    try {
      Ajv = require("ajv");
    } catch {
      /* reported by the assertion below */
    }
    // Without this the whole check would silently vanish, which is exactly the
    // blind spot that let the broken build ship in the first place.
    check("ajv is available to validate the build config", Boolean(Ajv));
    if (Ajv) {
      const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
      let validate = null;
      try {
        validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
      } catch (err) {
        check("electron-builder schema compiles", false, err.message);
      }
      if (validate) {
        const ok = validate(pkg.build);
        const detail = ok
          ? ""
          : validate.errors
              .map((e) => `${e.instancePath || "(root)"} ${e.message}`)
              .slice(0, 6)
              .join(" | ");
        check(
          "package.json build config satisfies the electron-builder schema",
          ok,
          detail,
        );
      }
    }
  }

  // The auto-update feed must never point at the parent project. `publish` is
  // null today (updates deliberately disabled — see BUILD.md), but if it is
  // ever enabled it has to target this fork's own releases: pointing it at
  // OmniCoreST would let upstream binaries silently replace a fork build,
  // discarding every fix in this repo. Deliberately permissive about *whether*
  // publishing is enabled, strict about *where* it points.
  //
  // The first version of this check only looked at `p.owner`, which review
  // showed was easy to walk around. electron-builder accepts a provider
  // shorthand string ("github"), an object with no owner/repo at all, and a
  // combined `repo: "owner/name"` form; in every one of those cases it falls
  // back to `package.json.repository` to resolve the target. A `generic`
  // provider names the host in `url` instead. `publish` can also be set per
  // platform, not just at the root. All of those are covered below.
  {
    const PARENT = /(^|[/.:@-])omnicorest($|[/.:-])/i;
    const roots = [pkg.build && pkg.build.publish];
    for (const plat of ["win", "mac", "linux"]) {
      if (pkg.build && pkg.build[plat]) roots.push(pkg.build[plat].publish);
    }
    const repoUrl =
      (pkg.repository &&
        (typeof pkg.repository === "string"
          ? pkg.repository
          : pkg.repository.url)) ||
      "";
    const reasons = [];
    for (const root of roots) {
      if (root == null) continue;
      for (const p of [].concat(root)) {
        // Provider shorthand — target is resolved from package.json.repository.
        if (typeof p === "string") {
          if (PARENT.test(repoUrl)) {
            reasons.push(`"${p}" shorthand resolves via repository ${repoUrl}`);
          }
          continue;
        }
        if (!p || typeof p !== "object") continue;
        if (typeof p.owner === "string" && PARENT.test(p.owner)) {
          reasons.push(`owner ${p.owner}`);
          continue;
        }
        if (typeof p.repo === "string" && PARENT.test(p.repo)) {
          reasons.push(`repo ${p.repo}`);
          continue;
        }
        if (typeof p.url === "string" && PARENT.test(p.url)) {
          reasons.push(`url ${p.url}`);
          continue;
        }
        // No explicit target: electron-builder falls back to the repository
        // field, so this is only safe if that field is not the parent.
        if (!p.owner && !p.repo && !p.url && PARENT.test(repoUrl)) {
          reasons.push(
            `provider ${p.provider || "?"} resolves via repository ${repoUrl}`,
          );
        }
      }
    }
    check(
      "update feed does not point at the upstream parent repo",
      reasons.length === 0,
      reasons.length ? `publishes from ${reasons.join("; ")}` : "",
    );
  }

  // scripts/post-upstream-merge.sh re-pins Electron with `npm pkg set`. If that
  // pin ever drifts below what package.json actually declares, running the
  // script — which the docs tell you to do after every upstream merge —
  // silently DOWNGRADES Electron and reintroduces the advisories the upgrade
  // cleared. Nothing else in the repo ties these two numbers together.
  {
    const scriptPath = path.join(__dirname, "scripts", "post-upstream-merge.sh");
    const declared =
      (pkg.devDependencies && pkg.devDependencies.electron) || "";
    if (!fs.existsSync(scriptPath)) {
      check("post-upstream-merge.sh exists to be checked", false);
    } else {
      const script = fs.readFileSync(scriptPath, "utf8");
      const m = script.match(/npm pkg set devDependencies\.electron="([^"]+)"/);
      check(
        "post-upstream-merge.sh pins an Electron version",
        Boolean(m),
        m ? "" : "no `npm pkg set devDependencies.electron=` line found",
      );
      if (m) {
        check(
          "post-upstream-merge.sh cannot downgrade Electron",
          m[1] === declared,
          m[1] === declared
            ? ""
            : `script pins ${m[1]} but package.json declares ${declared}`,
        );
      }
    }
  }

  // The README states the Electron version in several places. Nothing tied
  // those numbers to package.json, and they DID rot: the badge and the macOS
  // fix table said 37, the tech-stack list still said 27, and the description
  // of post-upstream-merge.sh claimed it re-pins to ^37 while the script
  // actually pins ^43. A reader following that text would conclude the fork
  // ships a runtime three majors older than it does, with the security
  // advisories that implies.
  //
  // Only claims about what THIS FORK ships are checked. The README also says
  // "Upstream Electron 27 triggers a macOS WindowServer bug", which is a
  // correct historical statement about the PARENT project and must stay 27 -
  // so this deliberately matches specific claim shapes rather than every
  // "Electron <number>" in the file.
  {
    const declared =
      (pkg.devDependencies && pkg.devDependencies.electron) || "";
    const wantMajor = (declared.match(/(\d+)/) || [])[1];
    const readme = read("README.md");
    const claims = [
      ["shields.io badge", /badge\/Electron-(\d+)/],
      ["macOS fix table row", /\|\s*\*\*Electron (\d+)\*\*\s*\|/],
      ["re-pin description", /re-pins Electron to `\^(\d+)`/],
      ["tech-stack list", /-\s*\*\*Electron (\d+)[.\d]*\*\*\s*-/],
    ];
    check(
      "package.json declares an Electron version to check the README against",
      Boolean(wantMajor),
      declared,
    );
    for (const [where, re] of claims) {
      const m = readme.match(re);
      check(
        `README ${where} states the Electron major this fork actually ships`,
        Boolean(m) && m[1] === wantMajor,
        m
          ? `README says ${m[1]}, package.json declares ${declared}`
          : `no match for ${re} - claim removed or reworded, so it is no longer checked`,
      );
    }
  }

  // ==========================================================================
  // PRODUCT IDENTITY
  // ==========================================================================
  // The 1.0 rebrand replaced the upstream vendor's identity with this project's
  // own. These are not cosmetic assertions: `appId` and the app name decide the
  // Windows install target, the single-instance lock and, through Electron's
  // userData path, where the user's recent-file list and tab session live.
  // Silently drifting back to the old identity would strand user data and point
  // installs at the vendor's namespace.
  {
    check(
      "package.json declares a productName, so Electron and the installer agree on the app name",
      pkg.productName === "Folia",
      `productName=${JSON.stringify(pkg.productName)}`,
    );
    check(
      "package name matches the product",
      pkg.name === "folia",
      `name=${JSON.stringify(pkg.name)}`,
    );

    // build.productName, not root productName, is what electron-builder uses
    // to name the executable, the Program Files directory and the Add/Remove
    // Programs entry (it resolves build.productName || productName || name).
    // The two are separate keys, so renaming the root one alone produced a
    // build whose RUNTIME called itself Folia while the INSTALLER still called
    // itself Markdown Viewer. Pinned explicitly rather than left to the
    // vendor-mark sweep below, which only looks for the vendor's name.
    check(
      "build.productName names the installer, so the installed app is not the old name",
      pkg.build && pkg.build.productName === "Folia",
      `build.productName=${JSON.stringify(pkg.build && pkg.build.productName)}`,
    );

    // The name a USER SEES, which is a third place the product name lives and
    // was the one left behind by the rename. index.html carried BOTH a full
    // title and an abbreviated `.app-title-short` shown by the compact header
    // below 780px, and the abbreviation still read "MV" - Markdown Viewer.
    // It survived the rename because a two-letter string in markup is not
    // something anyone greps for, which is the argument for deriving the
    // assertion from package.json rather than hard-coding "Folia" again here:
    // a fourth copy checked against a third copy proves only that two files
    // agree.
    {
      const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
      const productName = (pkg.build && pkg.build.productName) || pkg.productName;
      const titleTag = /<title>([^<]*)<\/title>/i.exec(html);
      const appTitle = /<span class="app-title">([^<]*)<\/span>/i.exec(html);
      check(
        "the window title is the product name",
        Boolean(titleTag) && titleTag[1].trim() === productName,
        `<title>=${titleTag && JSON.stringify(titleTag[1])} productName=${productName}`,
      );
      check(
        "the visible header title is the product name",
        Boolean(appTitle) && appTitle[1].trim() === productName,
        `.app-title=${appTitle && JSON.stringify(appTitle[1])} productName=${productName}`,
      );
      // No second, abbreviated copy of the name to keep in step by hand.
      check(
        "the header carries no abbreviated second copy of the product name",
        !/app-title-short/.test(html) &&
          !/app-title-short/.test(fs.readFileSync(path.join(ROOT, "custom-styles.css"), "utf8")),
        "app-title-short still present",
      );
    }

    // The vendor's MIT grant covers the code, not their marks. Renaming means
    // the marks are actually gone from what we ship, not merely relabelled.
    const VENDOR = /omnicore/i;
    // The pre-rename generic name is a separate hazard: it carries no vendor
    // mark, so the VENDOR sweep is blind to it, and a field left behind on it
    // silently reintroduces the old identity.
    const STALE_PRODUCT = /markdown[\s-]?viewer/i;
    const identityFields = {
      name: pkg.name,
      productName: pkg.productName,
      "build.productName": pkg.build && pkg.build.productName,
      description: pkg.description,
      homepage: pkg.homepage,
      "author.name": pkg.author && pkg.author.name,
      "build.appId": pkg.build && pkg.build.appId,
      "build.nsis.shortcutName":
        pkg.build && pkg.build.nsis && pkg.build.nsis.shortcutName,
      "build.linux.maintainer":
        pkg.build && pkg.build.linux && pkg.build.linux.maintainer,
      "build.win.artifactName":
        pkg.build && pkg.build.win && pkg.build.win.artifactName,
      "build.nsis.artifactName":
        pkg.build && pkg.build.nsis && pkg.build.nsis.artifactName,
    };
    const branded = Object.entries(identityFields)
      .filter(([, v]) => typeof v === "string" && VENDOR.test(v))
      .map(([k, v]) => `${k}=${v}`);
    check(
      "no vendor branding survives in the shipped package identity",
      branded.length === 0,
      branded.join("; "),
    );

    // Fields exempt from the stale-name sweep, each for a distinct reason:
    //   homepage      - the GitHub repository really is still named
    //                   markdown-viewer, so this must keep that slug or it
    //                   points at nothing. Renaming the repo is an
    //                   owner-only decision, separate from the product rename.
    //   description   - "markdown viewer" is the product CATEGORY, and saying
    //                   what the app is is the field's entire job. Sweeping it
    //                   would force prose that avoids naming its own category.
    // Everything left is used as an IDENTIFIER by Electron, electron-builder
    // or the OS, and none of those may still say the old name.
    const STALE_EXEMPT = new Set(["homepage", "description"]);
    const stale = Object.entries(identityFields)
      .filter(([k]) => !STALE_EXEMPT.has(k))
      .filter(([, v]) => typeof v === "string" && STALE_PRODUCT.test(v))
      .map(([k, v]) => `${k}=${v}`);
    check(
      "no pre-rename product name survives in the shipped package identity",
      stale.length === 0,
      stale.join("; "),
    );

    check(
      "appId is this project's own reverse-DNS namespace, not the vendor's",
      typeof (pkg.build && pkg.build.appId) === "string" &&
        pkg.build.appId === "io.github.lostinsea.folia",
      `appId=${pkg.build && pkg.build.appId}`,
    );

    // On Windows the taskbar, jump list, pinning and toast notifications all
    // identify the app by its AppUserModelID, NOT by its window title. With no
    // explicit call the runtime falls back to a default id, so a correctly
    // titled window can still group and notify under a different identity -
    // which is exactly the kind of half-finished rename this block exists to
    // catch.
    //
    // Asserted on main.js's source rather than on the running app because the
    // packaging suite is not an Electron harness. Two separate things are
    // pinned: that the call exists at all, and that its argument is DERIVED
    // from build.appId rather than a second copy of the string. A hardcoded
    // literal here would drift the moment appId changed, silently splitting
    // one app into two Windows identities - the failure mode is invisible in
    // the UI, so only a structural assertion catches it.
    const mainSrc = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
    check(
      "main.js sets an explicit AppUserModelId, so Windows groups and notifies as Folia",
      /app\.setAppUserModelId\(/.test(mainSrc),
      "no setAppUserModelId call found in main.js",
    );
    check(
      "the AppUserModelId is read from build.appId rather than duplicated as a literal",
      /appId\s*\}\s*=\s*require\(["']\.\/package\.json["']\)\.build/.test(
        mainSrc,
      ) && !/setAppUserModelId\(\s*["']/.test(mainSrc),
      "expected the id to come from package.json build.appId",
    );

    // The letterhead PNG was deleted with Corporate Mode. If the allowlist
    // still named it, electron-builder would fail the build on a missing file.
    check(
      "the deleted letterhead asset is not still on the build allowlist",
      !files.some((f) => /letterhead/i.test(String(f))),
      files.filter((f) => /letterhead/i.test(String(f))).join(", "),
    );

    // Installer filenames are what release.js and electron-updater agree on.
    // The old config emitted dot-separated names while release.js hunted for
    // dash-separated ones, so the rename step it ran was permanently dead.
    for (const [where, value] of [
      ["win", pkg.build && pkg.build.win && pkg.build.win.artifactName],
      ["nsis", pkg.build && pkg.build.nsis && pkg.build.nsis.artifactName],
    ]) {
      check(
        `${where} artifactName uses dashes, matching what release.js expects`,
        typeof value === "string" &&
          value.startsWith("Folia-") &&
          !/\s/.test(value),
        `${where} artifactName=${JSON.stringify(value)}`,
      );
    }

    // release.js spells the expected filenames out in its dry-run listing and
    // its release notes. Those must track build config or the notes tell users
    // to download files that were never produced.
    {
      const rel = fs.readFileSync(
        path.join(__dirname, "scripts", "release.js"),
        "utf8",
      );
      check(
        "release.js no longer references the vendor's installer names",
        !VENDOR.test(rel),
        (rel.match(/.*omnicore.*/gi) || []).slice(0, 3).join(" | "),
      );
      check(
        "release.js dropped the dead space-to-dash installer rename",
        !/renameWindowsInstaller/.test(rel),
      );

      // Every `gh release` call is pinned with --repo so it cannot resolve the
      // target from git remotes. This checkout carries three remotes and two
      // of them are other people's repositories, so an unpinned
      // `gh release delete --yes` could destroy releases on the vendor's
      // project. Counted rather than pattern-spotted: a single new unpinned
      // call is exactly the regression worth catching, and it would be
      // invisible to a "does --repo appear anywhere" check.
      {
        // Scoped to real invocations - `exec(`gh release …`)` - not to any
        // occurrence of the words. The first attempt matched free text and
        // flagged a comment and a log message that merely NAME the command,
        // which would have trained the next reader to ignore this assertion.
        const GH_CALL = new RegExp("exec\\(`gh release [^`]*`", "g");
        const ghCalls = rel.match(GH_CALL) || [];
        const unpinned = ghCalls.filter((c) => !/\$\{ghRepo\}|--repo/.test(c));
        check(
          "every gh release call is pinned to an explicit --repo",
          ghCalls.length >= 4 && unpinned.length === 0,
          `calls=${ghCalls.length} unpinned=${JSON.stringify(unpinned)}`,
        );
      }

      // The --repo pin covers `gh`, not `git`. Deleting a REMOTE tag is the
      // one destructive git operation in the script and it targets `origin`,
      // which is not guaranteed to be the repo package.json names - the same
      // hazard, one tool over. Assert the verification exists rather than that
      // the push exists, so restructuring is free but removing the guard is not.
      check(
        "the remote tag delete verifies origin against the package.json repo",
        /remoteSlug\(['"]origin['"]\)/.test(rel) &&
          /git push origin :refs\/tags\//.test(rel) &&
          rel.indexOf("remoteSlug('origin')") < rel.indexOf("git push origin :refs/tags/"),
        "expected remoteSlug('origin') to be checked before the remote tag delete",
      );

      // The release notes and the build config are written in different files
      // and drifted apart: the notes told every user "existing installations
      // will automatically detect this update" while `build.publish` was null,
      // so no feed existed and nobody ever updated. Couple them, in whichever
      // direction the project later chooses.
      const publishEnabled = Boolean(
        pkg.build &&
          pkg.build.publish !== null &&
          pkg.build.publish !== undefined,
      );
      const promisesAutoUpdate =
        /automatically detect this update|will auto-?update/i.test(rel);
      check(
        publishEnabled
          ? "release notes may promise auto-update because publishing is configured"
          : "release notes do not promise auto-update while publishing is disabled",
        publishEnabled || !promisesAutoUpdate,
        `build.publish=${JSON.stringify(pkg.build && pkg.build.publish)}`,
      );

      // Same drift, second symptom: the dry-run listing advertised update
      // manifests that a publish-less build never emits, so a dry run showed
      // artifacts the real run could not produce.
      const dryRunListsManifests = /['"`]latest(-\w+)?\.yml['"`]/.test(rel);
      check(
        publishEnabled
          ? "dry-run artifact list may include update manifests because publishing is configured"
          : "dry-run artifact list does not advertise update manifests that are never built",
        publishEnabled || !dryRunListsManifests,
        dryRunListsManifests
          ? (rel.match(/.*['"`]latest(-\w+)?\.yml['"`].*/g) || [])
              .slice(0, 2)
              .join(" | ")
          : "",
      );

      // Everything above reads release.js as TEXT. The next block runs it.
      //
      // A native-Windows host cannot build Linux artifacts, but the dry-run
      // listing and the published release notes both named an AppImage and a
      // DEB unconditionally - so a Windows release shipped download
      // instructions for two files that were never uploaded. Text assertions
      // cannot see that, because the strings are present in the source either
      // way; only running the code with a known artifact set can.
      //
      // The real source is evaluated (minus its trailing `main()` call), not a
      // copy, so this cannot pass against code that no longer ships.
      {
        const MAIN_CALL = "main().catch(";
        const cut = rel.indexOf(MAIN_CALL);
        check(
          "release.js still ends with the main() entry point the harness slices off",
          cut > 0,
          "expected to find " + JSON.stringify(MAIN_CALL),
        );

        if (cut > 0) {
          const body =
            rel.slice(0, cut).replace(/^#![^\n]*/, "") +
            "\nreturn { willBuildLinux, getArtifacts, createGitHubRelease," +
            " setDryRun: (v) => { dryRun = v; } };\n";
          const api = new Function(
            "require",
            "__dirname",
            "process",
            "console",
            body,
          )(
            require,
            path.join(__dirname, "scripts"),
            process,
            console,
          );
          api.setDryRun(true);

          // logDryRun -> log -> console.log, so the notes come back through
          // stdout. Capture rather than re-derive them.
          const captured = [];
          const realLog = console.log;
          console.log = (...a) => captured.push(a.join(" "));
          let notesFor;
          try {
            notesFor = (files) => {
              captured.length = 0;
              api.createGitHubRelease(
                "9.9.9",
                files.map((f) => path.join(__dirname, "dist", f)),
              );
              return captured.join("\n");
            };

            const winOnly = notesFor([
              "Folia-Setup-9.9.9.exe",
              "Folia-Setup-9.9.9.exe.blockmap",
            ]);
            const allThree = notesFor([
              "Folia-Setup-9.9.9.exe",
              "Folia-9.9.9.AppImage",
              "folia_9.9.9_amd64.deb",
            ]);

            const listedArtifacts = (() => {
              captured.length = 0;
              api.getArtifacts("9.9.9");
              return captured.join("\n");
            })();

            console.log = realLog;

            check(
              "release notes name the Windows installer that was collected",
              /Folia-Setup-9\.9\.9\.exe/.test(winOnly),
            );
            check(
              "release notes do not offer Linux downloads that were not built",
              !/AppImage|\.deb/i.test(winOnly),
              (winOnly.match(/.*(AppImage|\.deb).*/gi) || [])
                .slice(0, 2)
                .join(" | "),
            );
            check(
              "release notes do offer Linux downloads when they were built",
              /Folia-9\.9\.9\.AppImage/.test(allThree) &&
                /folia_9\.9\.9_amd64\.deb/.test(allThree),
            );

            // Independent oracle: decided from the host, not from the
            // implementation's own willBuildLinux(). On this machine the two
            // must agree; asserting only "list matches willBuildLinux()" would
            // pass against a helper that always returned true.
            const hostCanBuildLinux =
              process.platform !== "win32" ||
              fs.existsSync("/proc/version");
            const listsLinux = /AppImage|\.deb/i.test(listedArtifacts);
            check(
              "the dry-run artifact list advertises Linux builds only where they can be produced",
              listsLinux === hostCanBuildLinux,
              `platform=${process.platform} hostCanBuildLinux=${hostCanBuildLinux} listsLinux=${listsLinux}`,
            );
            check(
              "willBuildLinux() agrees with the host it is running on",
              api.willBuildLinux() === hostCanBuildLinux,
            );
          } finally {
            console.log = realLog;
          }

          // The scan half of getArtifacts, driven against a real directory.
          // dist/ is never cleaned, so a previous version's installer sits
          // there matching the same patterns; uploading it attaches a
          // wrong-version binary to the release. DIST_DIR derives from
          // __dirname, so a fake root gives the real function a real directory
          // to walk without touching this checkout's dist/.
          const fakeRoot = fs.mkdtempSync(
            path.join(os.tmpdir(), "folia-release-scan-"),
          );
          try {
            fs.mkdirSync(path.join(fakeRoot, "scripts"));
            fs.mkdirSync(path.join(fakeRoot, "dist"));
            fs.writeFileSync(
              path.join(fakeRoot, "package.json"),
              JSON.stringify({ version: "9.9.9" }),
            );
            const dist = path.join(fakeRoot, "dist");
            for (const f of [
              "Folia-Setup-9.9.9.exe",
              "Folia-Setup-9.9.9.exe.blockmap",
              "Folia-Setup-9.9.8.exe",
              "Folia-9.9.8.AppImage",
              "notes.txt",
            ]) {
              fs.writeFileSync(path.join(dist, f), "x");
            }

            const scanApi = new Function(
              "require",
              "__dirname",
              "process",
              "console",
              body,
            )(
              require,
              path.join(fakeRoot, "scripts"),
              process,
              console,
            );

            const quiet = [];
            const realLog2 = console.log;
            console.log = (...a) => quiet.push(a.join(" "));
            let found;
            try {
              found = scanApi
                .getArtifacts("9.9.9")
                .map((p) => path.basename(p));
            } finally {
              console.log = realLog2;
            }

            check(
              "the artifact scan collects this version's files",
              found.includes("Folia-Setup-9.9.9.exe") &&
                found.includes("Folia-Setup-9.9.9.exe.blockmap"),
              JSON.stringify(found),
            );
            check(
              "the artifact scan ignores a previous version left in dist/",
              !found.some((f) => f.includes("9.9.8")),
              JSON.stringify(found),
            );
            check(
              "the stale files really were there, so the filter had something to reject",
              fs.existsSync(path.join(dist, "Folia-9.9.8.AppImage")),
            );
          } finally {
            fs.rmSync(fakeRoot, { recursive: true, force: true });
          }
        }
      }
    }
  }

    // The welcome screen's version badge must come from app.getVersion() at
    // runtime, never from a literal in the markup. The old markup hardcoded
    // "v2.0.0" and was still claiming it after the 1.0 rebrand, because nothing
    // made the two agree.
    {
      const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      const m = html.match(
        /id="welcomeVersion"[^>]*>([^<]*)</,
      );
      check(
        "the welcome version badge carries no hardcoded version literal",
        Boolean(m) && m[1].trim() === "",
        m ? `badge contains ${JSON.stringify(m[1])}` : "welcomeVersion element not found",
      );
    }

  // ------------------------------------------------------------------
  // Third-party licence compliance.
  //
  // Folia being MIT does not discharge anything here. MIT, ISC, BSD and
  // Apache-2.0 each grant redistribution ON CONDITION that their own copyright
  // notice and licence text are reproduced in the distribution. That obligation
  // belongs to each dependency, and `build.files` ships `node_modules/**/*`, so
  // every one of them is in the installer.
  // ------------------------------------------------------------------
  {
    const NOTICES = "THIRD-PARTY-NOTICES.md";
    const noticesPath = path.join(ROOT, NOTICES);
    check("the third-party notices file exists", fs.existsSync(noticesPath));

    // WHERE THESE FILES ACTUALLY SHIP - measured against a real
    // `electron-builder --win dir` build with probe files planted in each
    // position, not reasoned from the docs:
    //
    //   probe listed BEFORE `!**/*.md`         -> not in asar
    //   probe listed AFTER  `!**/*.md`         -> IN asar   (order IS honoured)
    //   probe in build.files AND extraResources -> NOT in asar, in resources/
    //   probe in build.files only               -> IN asar
    //
    // The third line is the one that matters here: electron-builder removes a
    // file from the asar when it is also an extraResources source, so it is
    // not shipped twice. So listing an extraResources file in `build.files` as
    // well changes nothing - it is dead configuration that reads as
    // load-bearing. An earlier version of this file did exactly that and had a
    // revert entry "proving" it, which could only ever have been vacuous.
    // extraResources is the whole mechanism, so that is what is asserted.
    const extra = (pkg.build && pkg.build.extraResources) || [];
    check(
      "the notices file ships unpacked in resources/, where a reader can find it",
      extra.some((e) => (e && e.from) === NOTICES),
      JSON.stringify(extra),
    );
    check(
      "the notices file is not also listed in build.files (that entry is inert)",
      !files.includes(NOTICES),
      `files: ${JSON.stringify(files.filter((f) => /\.md$|\.txt$/.test(f)))}`,
    );
    // The same trap, for the two files that were in both lists for the same
    // reason. main.js:2639 resolves README from process.resourcesPath when
    // packaged, which is only correct because extraResources is what puts it
    // there.
    for (const f of ["README.md", "LICENSE.txt"]) {
      check(
        `${f} ships via extraResources and is not duplicated into build.files`,
        extra.some((e) => (e && e.from) === f) && !files.includes(f),
        `inExtra=${extra.some((e) => (e && e.from) === f)} inFiles=${files.includes(f)}`,
      );
    }

    // The generator reads the dependency tree that is actually installed, so
    // regenerating in memory and comparing catches the case that matters:
    // a dependency added, removed or upgraded without refreshing the notices.
    if (fs.existsSync(noticesPath)) {
      let regenerated = null;
      let genErr = null;
      let gen = null;
      try {
        gen = require("./scripts/generate-notices");
        regenerated = gen.build();
      } catch (e) {
        genErr = e;
      }
      check("the notices generator runs", regenerated !== null, genErr && genErr.message);
      if (regenerated) {
        const committed = fs.readFileSync(noticesPath, "utf8");
        check(
          "the committed notices file is not stale",
          committed === regenerated,
          `committed ${committed.length} bytes, regenerated ${regenerated.length} bytes - run \`npm run notices\``,
        );

        // A second source describing the same tree. NOTE ON ITS STRENGTH: the
        // generator now reads package-lock.json directly (it used to walk
        // `npm ls`, which reported 259 packages against the lockfile's 219
        // because it includes EXTRANEOUS ones left behind by earlier
        // installs - jsdom among them, which is demonstrably absent from the
        // built asar). That fix made this oracle share a source with the
        // generator, so it no longer checks the SOURCE - it checks the walk,
        // the dedupe and the rendering between that source and the output. The
        // asar oracle below is the one that is genuinely independent.
        const lockPath = path.join(ROOT, "package-lock.json");
        if (fs.existsSync(lockPath)) {
          const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          const prod = new Set();
          for (const [p, meta] of Object.entries(lock.packages || {})) {
            if (!p.startsWith("node_modules/")) continue;
            if (meta.dev || meta.devOptional) continue;
            prod.add(p.slice(p.lastIndexOf("node_modules/") + "node_modules/".length));
          }
          const documented = new Set(
            (committed.match(/^### (.+?)(?: \d[^\s]*)?$/gm) || []).map((h) =>
              h.replace(/^### /, "").replace(/ \d[^\s]*$/, ""),
            ),
          );
          const missing = [...prod].filter((n) => !documented.has(n));
          check(
            "every production dependency in package-lock.json has a notice",
            prod.size > 0 && missing.length === 0,
            `${prod.size} production packages, ${missing.length} undocumented: ${missing.slice(0, 8).join(", ")}`,
          );
        }

        // THE INDEPENDENT ORACLE: what electron-builder actually put in the
        // asar. Not derived from package.json or package-lock.json at all, so
        // it is the only check here that can catch the generator and its input
        // agreeing with each other and both being wrong about the product.
        // Skipped when there is no build, because requiring one would make the
        // suite depend on a 4-minute step; the checks above still run.
        const asarPath = path.join(ROOT, "dist", "win-unpacked", "resources", "app.asar");
        // Only trusted when the build is NEWER than the lockfile. A stale asar
        // produces a confident FALSE FAILURE - add a dependency without
        // rebuilding and the notices correctly document a package the old asar
        // cannot contain, which this would report as over-inclusion. An oracle
        // that fails for reasons unrelated to the thing it measures gets
        // muted by whoever hits it next, so it is skipped instead.
        const asarFresh =
          fs.existsSync(asarPath) &&
          fs.existsSync(lockPath) &&
          fs.statSync(asarPath).mtimeMs >= fs.statSync(lockPath).mtimeMs;
        if (asarFresh) {
          let shipped = null;
          try {
            const asar = require("@electron/asar");
            shipped = new Set();
            for (const f of asar.listPackage(asarPath)) {
              const m = /^.*\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\/package\.json$/.exec(
                f.replace(/\\/g, "/"),
              );
              if (m) shipped.add(m[1]);
            }
          } catch {
            shipped = null;
          }
          if (shipped && shipped.size > 0) {
            // Names only. Reading each package.json out of the asar to compare
            // versions would be stronger still, but the failure this guards
            // against - a package shipping with no notice at all - is a name
            // level fact, and the staleness check above pins the versions.
            const documented = new Set(
              (regenerated.match(/^### .+$/gm) || []).map((h) =>
                h.replace(/^### /, "").replace(/ [^ ]+$/, ""),
              ),
            );
            const undocumented = [...shipped].filter((n) => !documented.has(n));
            check(
              "every package inside the built app.asar has a notice",
              undocumented.length === 0,
              `${shipped.size} packages in the asar, ${undocumented.length} undocumented: ${undocumented
                .slice(0, 8)
                .join(", ")}`,
            );
            // The other direction, and the one that caught the original
            // defect: documenting a package that does not ship describes the
            // developer's workstation rather than the product, and two
            // developers would produce different files from the same commit.
            // Tabulator and Fira Code are vendored files rather than packages,
            // so they are legitimately absent from node_modules.
            const VENDORED = new Set(["Tabulator", "Fira"]);
            const overIncluded = [...documented].filter(
              (n) => !shipped.has(n) && !VENDORED.has(n),
            );
            check(
              "the notices document nothing that is absent from the built app.asar",
              overIncluded.length === 0,
              `${overIncluded.length} over-included: ${overIncluded.slice(0, 8).join(", ")}`,
            );
          }
        }

        // Six shipped packages publish no licence file. Their terms live only
        // in a README, and `!**/*.md` strips READMEs out of the packaged app,
        // so before this the text existed NOWHERE in the distribution. An
        // entry that says "ships no licence file" is an admission that the
        // condition attached to the grant was not met, not a notice.
        check(
          "no shipped package is left with a placeholder instead of licence terms",
          !/ships no licence file/.test(regenerated),
          (regenerated.match(/^### .+\n(?:[\s\S]{0,900}?ships no licence file)/gm) || [])
            .map((s) => s.split("\n")[0])
            .slice(0, 8)
            .join(", "),
        );
        // Stronger than "there is a fenced block": a block containing none of
        // the operative phrases is a badge or a pointer, not a grant.
        {
          const entries = regenerated.split(/^### /m).slice(1);
          const toothless = entries.filter((e) => !gen.LICENCE_BODY_RE.test(e));
          check(
            "every component entry reproduces operative licence language",
            entries.length > 200 && toothless.length === 0,
            `${entries.length} entries, ${toothless.length} without: ${toothless
              .map((e) => e.split("\n")[0])
              .slice(0, 8)
              .join(", ")}`,
          );
        }
        // Where canonical text is used it must SAY so. Presenting a
        // reconstructed licence as if it had been copied from the package
        // would be the more damaging error of the two.
        check(
          "canonical licence text is labelled as reconstructed, not passed off as the package's own",
          !/canonical text of that licence/.test(regenerated) ||
            /publishes no licence file and no licence text in its README/.test(regenerated),
          "canonical block present without its provenance note",
        );

        check(
          "the vendored Tabulator is documented despite not being an npm dependency",
          /^### Tabulator \d+\.\d+\.\d+$/m.test(committed),
          "no versioned Tabulator heading",
        );
        check(
          "Fira Code is documented",
          /^### Fira Code/m.test(committed) && committed.includes("OFL-1.1"),
        );
        // A dual licence is an offer, not a description; the notice has to say
        // which limb was taken or downstream cannot tell what terms they got.
        // Checking the ELECTION TEXT alone would be weak, because the licence
        // body reproduced underneath is chosen by a separate code path: for
        // dompurify the Apache `LICENSE` beats the MPL `LICENSE-MPL` on a
        // shortest-filename tiebreak, so the two agreed only by coincidence.
        // These assert the body actually matches the election.
        const elections = [
          {
            heading: "dompurify",
            spdx: "(MPL-2.0 OR Apache-2.0)",
            elected: "Apache-2.0",
            body: /Apache License/,
            rejected: /Mozilla Public License/,
          },
          { heading: "jszip", spdx: "(MIT OR GPL-3.0-or-later)", elected: "MIT", body: /MIT License/ },
        ];
        // Checked against the REGENERATED text, not the committed copy. A
        // generator regression shows up in what it produces now; the committed
        // file would only catch it one `npm run notices` later, by which point
        // the wrong licence has already shipped. The staleness assertion above
        // ties the two together, so checking the live output is strictly
        // stronger rather than a different subject.
        for (const e of elections) {
          // No `m` flag: with it, the `$` in the lookahead would match the end
          // of the first LINE, truncating every entry to nothing - which made
          // the negative "does not contain the rejected limb" check pass
          // vacuously while the positive ones failed.
          const m = new RegExp(
            `\\n### ${e.heading} [^\\n]*\\n([\\s\\S]*?)(?=\\n### |$)`,
          ).exec(regenerated);
          if (!m) {
            check(`${e.heading} appears in the notices`, false, "no heading found");
            continue;
          }
          const entry = m[1];
          check(
            `${e.heading}'s entry names the licence Folia elects`,
            entry.includes(`elects **${e.elected}**`),
            entry.split("\n").slice(0, 6).join(" | "),
          );
          check(
            `${e.heading}'s reproduced licence text is the one elected, not merely the one that sorted first`,
            e.body.test(entry),
            `entry does not contain ${e.body}`,
          );
          if (e.rejected) {
            check(
              `${e.heading} does not reproduce the rejected limb's text instead`,
              !e.rejected.test(entry),
            );
          }
        }

        // An SPDX `AND` is not an offer to choose from, it is two obligations
        // at once - so the election machinery above is not just inapplicable
        // here, it would be actively wrong. This is driven off the SPDX
        // expression rather than off a list of package names, so a future
        // conjunctive dependency is caught without anyone remembering that
        // conjunctive licences exist as a category.
        const conjunctive = [];
        {
          const re = /\n### ([^\s]+) [^\n]*\n([\s\S]*?)(?=\n### |$)/g;
          let m;
          while ((m = re.exec(regenerated)) !== null) {
            if (/^- Licence: [^\n]*\sAND\s/m.test(m[2])) {
              conjunctive.push({ name: m[1], entry: m[2] });
            }
          }
        }
        check(
          "the tree still contains the conjunctively-licensed package these assertions are about",
          conjunctive.some((c) => c.name === "pako"),
          `conjunctive entries found: ${conjunctive.map((c) => c.name).join(", ") || "none"}`,
        );
        for (const c of conjunctive) {
          check(
            `${c.name} does not claim an election it cannot make`,
            !/elects \*\*/.test(c.entry),
          );
          check(
            `${c.name} says plainly that every limb applies`,
            /No election is made or possible/.test(c.entry),
          );
          // The substantive check: not "is there a second block" but "are the
          // second licence's OWN operative clauses present". Zlib's clause 1
          // and clause 3 appear in no other licence family in this tree, so
          // this cannot be satisfied by the MIT text already there.
          check(
            `${c.name} reproduces the operative terms of every limb, not just the first`,
            /origin of this software must not be misrepresented/i.test(c.entry) &&
              /may not be removed or altered/i.test(c.entry),
            c.entry.slice(0, 200),
          );
          check(
            `${c.name} states which part of the package the additional terms cover`,
            /Additional terms for `[^`]+`/.test(c.entry),
          );
        }

        // Sensitivity probe. The guard's whole justification is that a missing
        // limb is INVISIBLE in the output - the entry still names the full
        // expression and still reproduces a real licence - so the guard must be
        // shown to fire rather than assumed to. Driving it with a synthetic
        // component is deliberate: waiting for a real conjunctive package to
        // lose its extra block would make this assertion permanently vacuous.
        let guardFired = false;
        try {
          gen.assertConjunctiveCovered([
            { name: "pako", version: "0.0.0", spdx: "(MIT AND Zlib)", extraLicences: [] },
          ]);
        } catch (err) {
          guardFired = /Conjunctive/.test(err.message);
        }
        check(
          "the conjunctive-licence guard really rejects an entry that drops a limb",
          guardFired,
        );
        // ...and does not fire on a licence that merely contains the letters
        // AND, which would make it noise that gets disabled.
        let falsePositive = false;
        try {
          gen.assertConjunctiveCovered([
            { name: "standard", version: "1.0.0", spdx: "MIT", extraLicences: [] },
          ]);
        } catch {
          falsePositive = true;
        }
        check("the conjunctive-licence guard does not fire on single licences", !falsePositive);

        // core.autocrlf=true is set on this repo and LICENSE is already
        // `i/lf w/crlf`. If the notices file were not pinned to LF in
        // .gitattributes, a fresh clone would hold CRLF while the generator
        // keeps emitting LF, and the byte-for-byte staleness check above would
        // fail on a clean checkout with no way to fix it - regenerating writes
        // LF and git converts it straight back.
        check(
          "the committed notices file is LF, as .gitattributes pins it",
          !committed.includes("\r"),
          `${(committed.match(/\r/g) || []).length} CR bytes present`,
        );
        const attrs = fs.readFileSync(path.join(ROOT, ".gitattributes"), "utf8");
        check(
          ".gitattributes pins the generated notices to LF",
          /^THIRD-PARTY-NOTICES\.md\s+text\s+eol=lf\s*$/m.test(attrs),
        );
        // Verbatim third-party licence texts. Their provenance rests on a
        // byte-for-byte match with the upstream artifact (the OFL as SIL
        // publishes it; Tabulator's licence as it comes out of `npm pack`), so
        // an end-of-line rewrite on checkout would break that verification -
        // and for the OFL it would alter the very file clause 2 requires to
        // travel with the font binaries. This is also not hypothetical: git's
        // own core.safecrlf guard REFUSED to stage these files until they were
        // pinned, because the LF -> repo -> CRLF round trip is not reversible.
        for (const f of ["assets/fonts/LICENSE-FiraCode.txt", "libs/tabulator/LICENSE"]) {
          const pinned = new RegExp(
            `^${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+text\\s+eol=lf\\s*$`,
            "m",
          ).test(attrs);
          check(`.gitattributes pins ${f} to LF so it stays byte-faithful`, pinned);
          const p = path.join(ROOT, f);
          check(
            `${f} is stored with LF endings, as pinned`,
            fs.existsSync(p) && !fs.readFileSync(p, "utf8").includes("\r\n"),
          );
        }
      }
    }

    // Apache-2.0 section 4(d) makes propagating a dependency's NOTICE file a
    // condition of redistribution, and it is a SEPARATE obligation from
    // reproducing the licence text. Nothing in this tree ships one today, so
    // the scan below finds nothing - which is why the collector is proved
    // sensitive first. An assertion that scans for something that does not
    // exist, using a collector that has never been shown to detect anything,
    // is two vacuous checks agreeing with each other.
    {
      const gen = require("./scripts/generate-notices");
      const probe = fs.mkdtempSync(path.join(os.tmpdir(), "folia-notice-"));
      try {
        const withNotice = path.join(probe, "with");
        const withoutNotice = path.join(probe, "without");
        fs.mkdirSync(withNotice);
        fs.mkdirSync(withoutNotice);
        fs.writeFileSync(path.join(withNotice, "NOTICE"), "Example Corp\nDerived from X.\n");
        fs.writeFileSync(path.join(withoutNotice, "LICENSE"), "MIT\n");
        const hit = gen.readNoticeText(withNotice);
        const miss = gen.readNoticeText(withoutNotice);
        check(
          "the NOTICE collector detects a NOTICE file and ignores a licence-only package",
          Boolean(hit) && hit.text.includes("Example Corp") && miss === null,
          `hit=${JSON.stringify(hit)} miss=${JSON.stringify(miss)}`,
        );
      } finally {
        fs.rmSync(probe, { recursive: true, force: true });
      }

      // The README harvester needs the same treatment, and for a sharper
      // reason: its first version returned null for EVERY package, and that
      // presented as "no package happens to state its licence in prose"
      // rather than as a failure. (`\Z` is not a JavaScript escape - it
      // matches a literal "Z" - and the heading-level lookahead was inverted.)
      // A harvester that cannot be shown to harvest is indistinguishable from
      // one that is broken.
      {
        const probe2 = fs.mkdtempSync(path.join(os.tmpdir(), "folia-readme-"));
        try {
          const real = path.join(probe2, "real");
          const label = path.join(probe2, "label");
          const trailing = path.join(probe2, "trailing");
          for (const d of [real, label, trailing]) fs.mkdirSync(d);
          const MIT =
            "Copyright (c) 2013 Example Person &lt;p@example.com&gt;\n\n" +
            "Permission is hereby granted, free of charge, to any person obtaining a copy " +
            "of this software and associated documentation files (the \"Software\"), to deal " +
            "in the Software without restriction, including without limitation the rights " +
            "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell " +
            "copies of the Software, subject to the following conditions:\n\n" +
            "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND.\n";
          fs.writeFileSync(path.join(real, "README.md"), `# thing\n\n## License\n\n${MIT}`);
          // The failure mode that matters most: a heading whose body is just
          // the SPDX id. Reproducing that would satisfy a naive "has a licence
          // section" check while discharging nothing.
          fs.writeFileSync(path.join(label, "README.md"), "# thing\n\n## License\n\nMIT\n");
          fs.writeFileSync(
            path.join(trailing, "README.md"),
            `# thing\n\n## License\n\n${MIT}\n## Contributing\n\nSend patches to nobody.\n`,
          );
          const hit = gen.readLicenseFromReadme(real);
          const miss = gen.readLicenseFromReadme(label);
          const bounded = gen.readLicenseFromReadme(trailing);
          check(
            "the README harvester extracts real licence prose and rejects a bare SPDX label",
            Boolean(hit) && /Permission is hereby granted/.test(hit.text) && miss === null,
            `hit=${hit && hit.text.length} miss=${JSON.stringify(miss)}`,
          );
          check(
            "the README harvester decodes HTML entities in the copyright line",
            Boolean(hit) && hit.text.includes("<p@example.com>") && !hit.text.includes("&lt;"),
            hit && hit.text.split("\n")[0],
          );
          check(
            "the README harvester stops at the next heading of the same level",
            Boolean(bounded) && !/Send patches/.test(bounded.text),
            bounded && bounded.text.slice(-80),
          );
          // spdxFromReadme fires for no package in the tree today (`error`
          // turned out to declare MIT through the legacy `licenses` array in
          // its package.json, which spdxOf already handles). Kept as a guard
          // for the next such package, and proved sensitive so that it is a
          // guard rather than dead code.
          check(
            "the README SPDX declaration reader discriminates",
            gen.spdxFromReadme(label) === null &&
              gen.spdxFromReadme(
                (() => {
                  const d = path.join(probe2, "declared");
                  fs.mkdirSync(d);
                  fs.writeFileSync(path.join(d, "README.md"), "# t\n\n## MIT Licenced\n\nhi\n");
                  return d;
                })(),
              ) === "MIT",
            `label=${gen.spdxFromReadme(label)}`,
          );
        } finally {
          fs.rmSync(probe2, { recursive: true, force: true });
        }
      }

      // Now the real tree, using the same collector that was just shown to work.
      const modules = path.join(ROOT, "node_modules");
      const unpropagated = [];
      if (fs.existsSync(noticesPath) && fs.existsSync(modules)) {
        const committedText = fs.readFileSync(noticesPath, "utf8");
        const stack = [modules];
        while (stack.length) {
          const dir = stack.pop();
          let entries = [];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            continue;
          }
          if (entries.some((e) => e.isFile() && e.name === "package.json")) {
            const n = gen.readNoticeText(dir);
            if (n && !committedText.includes(n.text.slice(0, 120))) {
              unpropagated.push(path.relative(modules, dir).replace(/\\/g, "/"));
            }
          }
          for (const e of entries) {
            if (e.isDirectory() && (e.name === "node_modules" || !e.name.startsWith("."))) {
              stack.push(path.join(dir, e.name));
            }
          }
        }
      }
      check(
        "no dependency ships a NOTICE file that the notices omit",
        unpropagated.length === 0,
        `unpropagated: ${unpropagated.slice(0, 8).join(", ")}`,
      );
    }

    // OFL-1.1 clause 2 is stricter than the MIT-style notices above: the
    // licence has to travel WITH the font files, not merely be reproduced
    // somewhere in the distribution.
    check(
      "the OFL ships beside the fonts it covers",
      fs.existsSync(path.join(ROOT, "fonts", "LICENSE-FiraCode.txt")) &&
        isPackaged(files, "fonts/LICENSE-FiraCode.txt"),
    );
    check(
      "Tabulator's licence ships beside the code it covers",
      fs.existsSync(path.join(ROOT, "libs", "tabulator", "LICENSE")) &&
        isPackaged(files, "libs/tabulator/LICENSE"),
    );

    // LICENSE and LICENSE.txt both exist because both are load-bearing:
    // GitHub's licence detection and README's link want `LICENSE`, while the
    // NSIS installer agreement page is configured to `LICENSE.txt`. Two files
    // that must agree by discipline alone had already drifted - one said 2025
    // and the other 2026 - so the agreement is asserted rather than assumed.
    const licA = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    const licB = fs.readFileSync(path.join(ROOT, "LICENSE.txt"), "utf8");
    check(
      "LICENSE and LICENSE.txt have not drifted apart",
      licA === licB,
      "the NSIS installer shows LICENSE.txt; GitHub and README show LICENSE",
    );
    // MIT requires the ORIGINAL copyright notice to be retained in derivative
    // works, so the upstream line is not optional and must not be replaced by
    // the fork's own.
    check(
      "LICENSE retains the upstream copyright, as MIT requires of a derivative",
      /Copyright \(c\) [\d-]*2025[\d-]* Omnicore/.test(licA),
      licA.split("\n").slice(0, 5).join(" | "),
    );
    check(
      "LICENSE also asserts the fork's own copyright",
      /Copyright \(c\) .*Folia/.test(licA),
      licA.split("\n").slice(0, 5).join(" | "),
    );
    check(
      "the NSIS installer agreement points at a licence file that exists",
      Boolean(pkg.build && pkg.build.nsis && pkg.build.nsis.license) &&
        fs.existsSync(path.join(ROOT, pkg.build.nsis.license)),
      pkg.build && pkg.build.nsis && pkg.build.nsis.license,
    );
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
