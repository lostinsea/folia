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

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
