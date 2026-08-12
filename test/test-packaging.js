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
const { execFileSync } = require("child_process");

// The repository root, which is this suite's subject - it reads package.json,
// build.files, the shipped sources and the docs. It is one level up now that
// the suites live in test/, and every path here goes through ROOT rather than
// __dirname so that stays true in one place.
const ROOT = path.join(__dirname, "..");
// The application's own source. `libs/` (vendored third party), `fonts/` (a
// gitignored BUILD OUTPUT of scripts/vendor-libs.js) and `assets/` (tracked
// image and font sources) are deliberately SIBLINGS of it rather than children:
// vendored code carries its own LICENSE and .gitattributes pins, and build
// output does not belong inside a source tree. The cost of that decision is
// that references crossing out of src/ are relative (`../libs/...`), which is
// why the discovery below resolves each reference against the directory of the
// file it was found in rather than against ROOT.
const SRC = path.join(ROOT, "src");
let pass = 0;
let fail = 0;
const skipped = [];

// A conditional block that quietly does nothing leaves no trace in the output
// and simply lowers the assertion count, which is indistinguishable from an
// assertion never having existed. Measured: touching package-lock.json after a
// build silently removed the two asar oracles below and the suite still
// reported "0 failed". Skips are therefore announced and counted.
//
// Announcing is enough for a developer reading the output, but not for CI,
// where nobody reads it. PACKAGING_STRICT=1 turns any skip into a failure, so
// a release job can require that the oracles actually RAN rather than merely
// that nothing failed.
function skip(name, reason) {
  skipped.push(name);
  console.log(`  SKIP  ${name}${reason ? " - " + reason : ""}`);
}

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

// The component names in a notices document, one place rather than three.
// The trailing token is stripped only when it is VERSION-SHAPED. A blanket
// `/ [^ ]+$/` looks equivalent on today's data but is not: "### Fira Code"
// carries no version, so it was being truncated to "Fira" - which is why the
// vendored-file allowlist below used to have to name the half-word "Fira" to
// match. Any future version-less entry ("Noto Sans", "Source Sans") would have
// hit the same trap, and the failure mode is a MISSING licence notice going
// unnoticed, which is the one outcome this file exists to prevent.
function documentedNames(notices) {
  return new Set(
    (notices.match(/^### .+$/gm) || []).map((h) =>
      h.replace(/^### /, "").replace(/ \d[^ ]*$/, ""),
    ),
  );
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
  // A reference is relative to the FILE THAT MAKES IT, not to the repository
  // root. That distinction did not exist while every referring file sat at the
  // root, and it is exactly what the src/ move introduced: `../libs/x.js` in
  // src/index.html and `libs/x.js` in a root-level file name the same file.
  // Resolving here - once - keeps every downstream assertion (exists on disk,
  // is in build.files, the mermaid canary) speaking one vocabulary: paths
  // relative to the repository root, in POSIX form, which is what build.files
  // is written in.
  const addRef = (fromDir, ref) => {
    const abs = path.resolve(fromDir, ref);
    referenced.add(path.relative(ROOT, abs).replace(/\\/g, "/"));
  };

  // 1. Preload scripts referenced from the main process.
  const mainJs = read("src/main.js");
  const preloadRe = /preload:\s*path\.join\(\s*__dirname\s*,\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let m;
  while ((m = preloadRe.exec(mainJs))) addRef(SRC, m[1]);
  check("found at least one preload reference in main.js", referenced.size > 0);

  // 2. Scripts and stylesheets loaded by the renderer document.
  const indexHtml = read("src/index.html");
  const srcRe = /<(?:script[^>]*\ssrc|link[^>]*\shref)=["']([^"':]+)["']/gi;
  while ((m = srcRe.exec(indexHtml))) {
    const ref = m[1].replace(/^\.\//, "");
    if (!/^(https?:|data:|#)/i.test(ref)) addRef(SRC, ref);
  }

  // 3. Font files referenced by @font-face, which have no import statement to
  //    give them away and so are especially easy to leave out.
  const css = read("src/styles.css");
  const urlRe = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  while ((m = urlRe.exec(css))) {
    const ref = m[1].replace(/^\.\//, "");
    if (!/^(https?:|data:)/i.test(ref)) addRef(SRC, ref);
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
    .readdirSync(SRC)
    .filter((f) => f.endsWith(".js") && !/^(test-|bench-|probe-)/.test(f));
  const assetLiteralRe =
    /['"`]((?:\.\.\/)?(?:libs|fonts|assets)\/[^'"`$\\\s]+\.(?:js|mjs|css|woff2?|ttf|eot|svg|png|jpg|gif))['"`]/g;
  // A path built by interpolation cannot be resolved statically. Rather than
  // quietly missing it, say so.
  const unresolvableRe = /`(?:\.\.\/)?(?:libs|fonts|assets)\/[^`]*\$\{/g;
  const unresolvable = [];
  for (const file of runtimeSources) {
    const src = read("src/" + file);
    while ((m = assetLiteralRe.exec(src))) addRef(SRC, m[1]);
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
  //
  // It is also the guard on the src/ move: the sweep above reads a DIRECTORY,
  // so pointing it at the wrong one yields an empty file list and a silent
  // pass. Measured by forcing the sweep to return nothing - this canary is one
  // of three assertions that fire.
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
  check("popup-preload.js is in build.files", isPackaged(files, "src/popup-preload.js"));
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

  // Production dependencies and bare requires must be the SAME set, in both
  // directions. This is the general form of the finding that shrank app.asar
  // from 153.6 MB to 23.2 MB: `build.files` ships `node_modules/**/*` and
  // electron-builder prunes only devDependencies, so a package declared in
  // `dependencies` is installed into every user's machine whether any shipped
  // line requires it or not. That sweep was done by hand once; this is the
  // version that keeps being true.
  //
  // The reverse direction matters just as much and fails far more loudly: a
  // bare require with no matching dependency works forever on the developer's
  // machine, where the package is present transitively or left over from an
  // earlier install, and throws on a clean install.
  {
    const shippedJs = fs
      .readdirSync(SRC)
      .filter(
        (f) =>
          f.endsWith(".js") &&
          !/^(test-|bench-|probe-)/.test(f) &&
          isPackaged(files, "src/" + f),
      );
    const builtins = new Set(require("module").builtinModules);
    const required = new Map();
    const bareRe = /\brequire\(\s*["']([^"'.\/][^"']*)["']\s*\)/g;
    for (const f of shippedJs) {
      const src = read("src/" + f);
      let mm;
      while ((mm = bareRe.exec(src))) {
        // Scoped and subpath specifiers resolve to their package root.
        const spec = mm[1];
        const pkgName = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        if (builtins.has(pkgName) || pkgName === "electron" || pkgName.startsWith("node:")) continue;
        if (!required.has(pkgName)) required.set(pkgName, new Set());
        required.get(pkgName).add(f);
      }
    }
    const declared = new Set(Object.keys(pkg.dependencies || {}));

    // Vacuity floor. A regex that silently stops matching - because requires
    // move behind a helper, or the shipped-file filter changes shape - would
    // otherwise satisfy both assertions below by finding nothing at all.
    //
    // Tied to the DECLARED count rather than a constant, because a constant
    // floor sits at whatever today's number is and a dependency removal walks
    // straight under it. Two of anything is not a meaningful floor when the
    // tree declares exactly two production dependencies.
    check(
      "the bare-require scan found something to check",
      required.size >= declared.size && declared.size > 0,
      `${required.size} bare require(s) across ${shippedJs.length} shipped file(s): ` +
        `${[...required.keys()].join(", ")} - fewer than the ${declared.size} declared ` +
        "dependencies, so the scan or the file filter has gone blind",
    );

    const undeclared = [...required.keys()].filter((n) => !declared.has(n));
    check(
      "every bare require in shipped code is a declared production dependency",
      undeclared.length === 0,
      undeclared
        .map((n) => `${n} (required by ${[...required.get(n)].join(", ")})`)
        .join("; ") + " - present on this machine, absent on a clean install",
    );

    const unused = [...declared].filter((n) => !required.has(n));
    check(
      "every production dependency is actually required by shipped code",
      unused.length === 0,
      `${unused.join(", ")} ship into every installer but nothing loads them; ` +
        "they belong in devDependencies, or the require that justified them is gone",
    );
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
  // null today (updates deliberately disabled — see docs/BUILD.md), but if it is
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

    // Auto-update is now ENABLED, and the negative check above passes just as
    // happily when it is off - `publish: null` points at nobody, including the
    // parent. These assert the positive fact, so silently reverting to null
    // (which is where this started) fails rather than reading as compliant.
    const publishCfg = [].concat(pkg.build && pkg.build.publish ? pkg.build.publish : []);
    const github = publishCfg.filter(
      (p) => p && typeof p === "object" && p.provider === "github",
    );
    check(
      "auto-update publishes to this fork's own GitHub releases",
      github.length === 1 && github[0].owner === "lostinsea" && github[0].repo === "folia",
      `build.publish=${JSON.stringify(pkg.build && pkg.build.publish)} - electron-builder writes no app-update.yml without it, so installed builds can never see a release`,
    );

    // Every build script must pass --publish never. electron-builder's default
    // is onTagOrDraft: with publish configured, a tag build inside the release
    // matrix would upload on all three legs at once, racing the create-release
    // job that is meant to be the single writer. This was invisible while
    // publish was null, because nothing could upload regardless.
    const buildScripts = Object.entries(pkg.scripts || {}).filter(([k, v]) =>
      /^build/.test(k) && /electron-builder/.test(v),
    );
    const unguarded = buildScripts.filter(([, v]) => !/--publish\s+never/.test(v)).map(([k]) => k);
    check(
      "every electron-builder script disables implicit publishing",
      buildScripts.length >= 4 && unguarded.length === 0,
      `${buildScripts.length} build scripts, ${unguarded.length} without --publish never: ${unguarded.join(", ")}`,
    );

    // Every Electron suite must run against an ISOLATED userData profile.
    //
    // The suites used to share ONE profile between them, and eight of them
    // require ../src/main.js, so main.js's "confirm-large-render" handler was
    // live in all eight and each opened a real window. A restored session
    // holding an expensive document reached dialog.showMessageBoxSync(), which
    // is modal IN THE MAIN PROCESS and so cannot be dismissed by any stub,
    // watchdog or renderer-side patch - the process that would run the rescue
    // is the process that is blocked. test-tab-refresh's own 260KB guard-big.md
    // fixture is persisted by saveTabs() the moment its tab is created, so a
    // killed run planted a landmine that stopped every LATER suite until a
    // human clicked. A/B measured: seeded profile hung with zero assertions,
    // empty profile finished 7/7 in 8s.
    //
    // THE REQUIRE MUST BE AT MODULE SCOPE. app.setPath("userData", ...) is
    // ignored once the app is ready, so an indented require - inside a
    // function, a ready handler or a try block - establishes nothing. That is
    // not hypothetical: test-render-patch.js reached the shared helper only
    // from inside `async function run(win)`, long after the window had loaded.
    // A check that accepted a require anywhere in the file would have passed
    // for that suite while it ran unisolated.
    //
    // This lives in the PACKAGING suite because it is a property of the test
    // estate as a whole - a tenth suite added later is exactly what a per-suite
    // assertion cannot see.
    const ISOLATION_AT_MODULE_SCOPE =
      /^(?:const\s+\w+\s*=\s*)?require\(["']\.\/test-userdata-isolation["']\);?\s*$/m;
    const electronSuites = Object.values(pkg.scripts || {})
      .flatMap((v) => [...v.matchAll(/electron\s+(test\/[\w.-]+\.js)/g)].map((m) => m[1]))
      .filter((v, i, a) => a.indexOf(v) === i);
    const unisolated = electronSuites.filter((rel) => {
      const abs = path.join(ROOT, rel);
      if (!fs.existsSync(abs)) return true;
      return !ISOLATION_AT_MODULE_SCOPE.test(fs.readFileSync(abs, "utf8"));
    });
    check(
      "every Electron test suite establishes an isolated userData profile",
      electronSuites.length >= 8 && unisolated.length === 0,
      `${electronSuites.length} suites; missing: ${unisolated.join(", ") || "none"}`,
    );

    // The isolation module only works because it refuses to run late. Without
    // that throw it would silently no-op and every assertion above would keep
    // passing while the suites ran against a shared profile again - an absence
    // assertion failing open, the defect class this project keeps rediscovering.
    check(
      "the isolation module refuses to run after the app is ready",
      /app\.isReady\(\)/.test(
        fs.readFileSync(path.join(ROOT, "test", "test-userdata-isolation.js"), "utf8"),
      ),
    );

    // Auto-update exists for the packaged app only if an app-update.yml is
    // packed beside it, and electron-builder writes that file ONLY when an
    // NSIS (or updater-aware appx) target is part of the build - read out of
    // app-builder-lib's own isSuitableWindowsTarget(), not assumed. A
    // portable-only build therefore ships an app that cannot check for
    // updates at all, silently, while main.js still carries a whole portable
    // update-install path (the temp batch script) that can never be reached.
    //
    // `npm run build` is exactly such a build, which is why the artefact-level
    // assertion further down has to state its precondition instead of reading
    // whichever target happened to run last. THIS assertion is the
    // order-independent half: whatever the release workflow runs must include
    // an auto-updatable target.
    const workflowPath = path.join(ROOT, ".github", "workflows", "release.yml");
    if (fs.existsSync(workflowPath)) {
      const wf = fs.readFileSync(workflowPath, "utf8");
      const winScripts = [...wf.matchAll(/run:\s*npm run (build[\w-]*)/g)]
        .map((m) => m[1])
        .filter((s) => /electron-builder --win/.test((pkg.scripts || {})[s] || ""));
      const updatable = winScripts.filter((s) => {
        const cmd = pkg.scripts[s];
        // `--win` with no target list builds the configured win.target set.
        // The negative lookahead matters: without it `--win --publish never`
        // parses "--publish" as a target list (a `-` inside the character
        // class), and a correctly configured build reads as having no nsis
        // target at all.
        const explicit = cmd.match(/--win\s+(?!-)([\w,-]+)/);
        const targets = explicit
          ? explicit[1].split(",")
          : [].concat((pkg.build && pkg.build.win && pkg.build.win.target) || []);
        return targets.some((t) => /^nsis/.test(typeof t === "string" ? t : t.target || ""));
      });
      check(
        "the Windows release build includes an auto-updatable target",
        winScripts.length > 0 && updatable.length === winScripts.length,
        `release.yml runs ${winScripts.join(", ") || "no Windows build"}; ` +
          `${updatable.length} of ${winScripts.length} include an nsis target - ` +
          "without one electron-builder writes no app-update.yml and the " +
          "shipped app can never check for updates",
      );
    }
  }

  // scripts/post-upstream-merge.sh re-pins Electron with `npm pkg set`. If that
  // pin ever drifts below what package.json actually declares, running the
  // script — which the docs tell you to do after every upstream merge —
  // silently DOWNGRADES Electron and reintroduces the advisories the upgrade
  // cleared. Nothing else in the repo ties these two numbers together.
  {
    const scriptPath = path.join(ROOT, "scripts", "post-upstream-merge.sh");
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
  // The claim SHAPES are rewritten whenever the README is, and three of the
  // four were invalidated by the Folia rewrite - which the suite reported as
  // four named failures rather than silently checking nothing, because a
  // missing match is a failure here and not a skip. That is the property worth
  // preserving: these must be re-pointed by hand at each rewrite.
  {
    const declared =
      (pkg.devDependencies && pkg.devDependencies.electron) || "";
    const wantMajor = (declared.match(/(\d+)/) || [])[1];
    const readme = read("README.md");
    const claims = [
      ["what-changed summary", /Electron upgraded to (\d+)/],
      ["tech-stack table row", /\|\s*Electron\s*\|\s*(\d+)/],
      ["install-notes prose", /Electron (\d+) downloads its binary lazily/],
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

  // The README describes a POLICY - editing is edit-mode only, notes are the
  // one exception and save themselves - and a policy described in prose rots
  // the moment the mechanism behind it moves. This is the same defect class as
  // the Electron version claims above, with a worse failure: a reader who is
  // told the document is read-only in view mode, and is wrong, edits a file
  // they believed they were only reading.
  //
  // WHAT THIS PAIR IS, HONESTLY. The behavioural oracle for all three policies
  // already exists and is not here: test-render-patch.js dispatches real
  // contextmenu events in both modes and measures OBSERVED visibility, and
  // drives the real note dialogs with disk bytes as the oracle. This suite is
  // not windowed, so it cannot do that. What it adds is the LINK between the
  // shipped prose and the mechanism named in it - the axis the behavioural
  // suite cannot see, because a test that drives the product is blind to the
  // README drifting away from it.
  //
  // THE MECHANISM HALVES ARE STRUCTURAL, NOT SUBSTRING MATCHES, and that
  // distinction was earned: a reviewer measured the first version and found two
  // of the three could not fail. `/autoSaveViewModeNote\(\)/` matched four
  // lines, of which one was a COMMENT and one the function's own definition, so
  // deleting both call sites - i.e. actually breaking auto-save - left it
  // green. `/function editOnlyAlwaysVisibleItems\(\)/` matched the definition
  // alone, so emptying the returned list left it green. Each mechanism half now
  // parses the function it names and asserts something the disabled version
  // could not satisfy: the gate call must be a live statement inside
  // showContextMenu (not commented out, not a stray reference elsewhere), the
  // gate's item list must actually name the eight controls the README
  // enumerates, and auto-save must have at least two live call sites.
  //
  // A reworded or deleted claim is a FAILURE, not a skip - otherwise rewriting
  // the section silently switches the check off, which is exactly what happened
  // to three of the four Electron claims.
  {
    const readme = read("README.md");
    const rendererSrc = read("src/renderer.js");
    // Brace-matched body extraction. Substring searches over a 9000-line file
    // cannot distinguish a definition from a call from a mention in a comment,
    // which is the whole reason the first version of these oracles was weak.
    const bodyOf = (src, signature) => {
      const start = src.indexOf(signature);
      if (start < 0) return null;
      let i = src.indexOf("{", start);
      if (i < 0) return null;
      let depth = 0;
      for (let j = i; j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") {
          depth--;
          if (depth === 0) return src.slice(i + 1, j);
        }
      }
      return null;
    };
    // Lines that are entirely a `//` comment are not mechanism.
    const liveLines = (body) =>
      String(body || "")
        .split(/\r?\n/)
        .filter((l) => !/^\s*(\/\/|\*)/.test(l));

    const gateCallIsLive = (src) => {
      const body = bodyOf(src, "function showContextMenu(");
      return liveLines(body).some((l) => /^\s*applyEditModeMenuGating\(\);\s*$/.test(l));
    };
    // Exactly the controls the README bullet enumerates, so the prose and the
    // list close the loop on each other.
    const GATED_ITEMS = [
      "ctxBold", "ctxItalic", "ctxCode", "ctxList",
      "ctxRemoveFormat", "ctxInsertImage", "ctxInsertMermaid", "ctxInsertTable",
    ];
    const gateOwnsTheItems = (src) => {
      const body = liveLines(bodyOf(src, "function editOnlyAlwaysVisibleItems(")).join("\n");
      return GATED_ITEMS.every((id) => body.includes(id));
    };
    const autoSaveIsWired = (src) => {
      const defStart = src.indexOf("function autoSaveViewModeNote(");
      const calls = liveLines(src).filter(
        (l) => /autoSaveViewModeNote\(\)/.test(l) && !/^\s*function /.test(l),
      );
      return defStart >= 0 && calls.length >= 2;
    };

    const claims = [
      [
        "states that document editing is confined to edit mode",
        /In view mode the document is read-only/,
        "the context menu is gated on edit mode",
        gateCallIsLive,
      ],
      [
        "names the inline formatting commands as edit-mode only",
        /\*\*Edit mode only\*\*[^\n]*inline formatting/,
        "the gate owns those items and restores them in edit mode",
        gateOwnsTheItems,
      ],
      [
        "promises a view-mode note is written to the file immediately",
        /a note made in view mode is written to the file as soon as you confirm it/,
        "the note commit helpers auto-save",
        autoSaveIsWired,
      ],
    ];
    for (const [what, readmeRe, mechanism, mechanismFn] of claims) {
      check(
        `the README ${what}`,
        readmeRe.test(readme),
        `no match for ${readmeRe} - claim removed or reworded, so it is no longer checked`,
      );
      check(
        `...and ${mechanism}, so that claim is still true`,
        mechanismFn(rendererSrc) === true,
        `the mechanism named by this claim is no longer live in renderer.js`,
      );
    }
  }

  // Three README claims about things that live in package.json and index.html
  // rather than in renderer.js, all three of which were WRONG when a reviewer
  // measured them against the build configuration:
  //
  //  - the file-associations sentence promised the installer registers all
  //    seven supported extensions; it registers three;
  //  - the download table listed three artefacts out of five, silently hiding
  //    the Windows portable build and the macOS dmg that release.yml publishes;
  //  - the right-click bullet offered "insert / edit / delete ... images", and
  //    there is no image-edit control anywhere in the app.
  //
  // All three are the same shape: prose describing a MACHINE-READABLE fact that
  // nothing compared it against. So the oracle is the build config itself,
  // never a second copy of the sentence.
  {
    const readme = read("README.md");
    const indexSrc = read("src/index.html");

    const winAssoc = ((pkg.build.win || {}).fileAssociations || []).map((a) => a.ext).sort();
    check(
      "the build declares the file associations the README's claim is checked against",
      winAssoc.length > 0,
      JSON.stringify(winAssoc),
    );
    // The README names them inline, so the comparison is against the sentence a
    // reader actually reads rather than against a list maintained beside it.
    const claimed = (readme.match(/The installer registers Folia as a handler for ([^\n]+?)\n/) || [])[1] || "";
    const claimedExts = [...claimed.matchAll(/`\.([a-z]+)`/g)].map((m) => m[1]).sort();
    check(
      "the README names exactly the extensions the installer actually registers",
      claimedExts.length === winAssoc.length
        && claimedExts.every((e, i) => e === winAssoc[i]),
      JSON.stringify({ readme: claimedExts, build: winAssoc }),
    );

    // Every artefact the release workflow publishes has to appear in the
    // download table, or a reader concludes their platform is unsupported.
    const targets = []
      .concat((pkg.build.win || {}).target || [])
      .concat((pkg.build.mac || {}).target || [])
      .concat((pkg.build.linux || {}).target || [])
      .map((t) => (typeof t === "string" ? t : t.target));
    const TABLE_EVIDENCE = {
      nsis: /Folia-Setup-X\.X\.X\.exe/,
      portable: /\| Windows \| `Folia X\.X\.X\.exe`/,
      dmg: /Folia-X\.X\.X\.dmg/,
      AppImage: /Folia-X\.X\.X\.AppImage/,
      deb: /folia_X\.X\.X_amd64\.deb/,
    };
    check(
      "every build target is one the download-table check knows how to look for",
      targets.every((t) => TABLE_EVIDENCE[t]),
      JSON.stringify(targets),
    );
    const missingRows = targets.filter((t) => TABLE_EVIDENCE[t] && !TABLE_EVIDENCE[t].test(readme));
    check(
      "the README's download table lists every artefact the release publishes",
      missingRows.length === 0,
      JSON.stringify({ missing: missingRows, targets }),
    );

    // The image half of the right-click bullet. There is an insert control and
    // a delete control and no edit control, so the day someone adds one this
    // fires and the bullet gets updated in the same change - which is the only
    // moment anybody would remember to.
    check(
      "the app still has no image-edit control, as the right-click bullet now says",
      !/ctxEditImage/.test(indexSrc) && /ctxDeleteImage/.test(indexSrc) && /ctxInsertImage/.test(indexSrc),
      "an image control was added or removed without the README bullet moving with it",
    );

    // "The Mermaid and table dialogs are resizable" - named rather than
    // generalised, because the note, find-note and edit-text dialogs are NOT.
    // Asserted as an exact set so widening the CSS without widening the prose
    // fails, and so does the reverse.
    const resizable = [...read("src/styles.css").matchAll(/([^\n{}]+)\{[^}]*resize:\s*both[^}]*\}/g)]
      .map((m) => m[1].trim())
      .sort();
    check(
      "exactly the two dialogs the README names are the resizable ones",
      resizable.length === 2
        && resizable[0] === ".mermaid-template-dialog"
        && resizable[1] === ".table-insert-dialog",
      JSON.stringify(resizable),
    );
    check(
      "the README names those two dialogs rather than claiming all dialogs resize",
      /The Mermaid and table dialogs are resizable/.test(readme),
      "the dialog-resize claim was reworded, so it is no longer checked",
    );
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
      const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
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
          !/app-title-short/.test(fs.readFileSync(path.join(SRC, "custom-styles.css"), "utf8")),
        "app-title-short still present",
      );
    }

    // The vendor's MIT grant covers the code, not their marks. Renaming means
    // the marks are actually gone from what we ship, not merely relabelled.
    const VENDOR = /omnicore/i;

    // README.md is a SHIPPED, USER-FACING surface, not just repository prose:
    // it goes into the installer via extraResources and is what the in-app
    // welcome button opens. It was also the single largest remaining piece of
    // vendor branding - it described the vendor's product, by name, to anyone
    // who opened it - which both independent licence reviews rated blocking,
    // on the grounds that shipping it misrepresents who publishes the app.
    //
    // The vendor's name is still allowed in ONE place, and deliberately so:
    // LICENSE names three copyright holders, and a reader who meets two
    // unfamiliar names there needs the README to say why. So this does not
    // sweep the name out entirely - it pins it to the provenance section,
    // which is the assertion that actually expresses the intent. A vendor
    // mention drifting back into the product description would fail here
    // while the legitimate attribution keeps passing.
    {
      const readmeSrc = read("README.md");
      const productName = (pkg.build && pkg.build.productName) || pkg.productName;
      const readmeLines = readmeSrc.split(/\r?\n/);

      const h1 = readmeLines.find((l) => /^#\s+\S/.test(l));
      check(
        "the README titles itself with the product name, not the vendor's",
        Boolean(h1) && h1.replace(/^#\s+/, "").trim() === productName,
        `README H1=${JSON.stringify(h1)} productName=${productName}`,
      );

      // FOUND BY A PROBE, NOT BY THIS SUITE, which is why it is here now: an
      // edit that inserted two sections above `## Development` consumed that
      // heading and left its body - the install and test commands - hanging
      // under the section before it. All 197 assertions passed. Opening the
      // README in the app and listing the rendered <h2>s is what showed 12
      // headings where there should have been 13.
      //
      // The oracle is the SECTION LIST, not a line count or a total, because
      // those tolerate exactly the substitution that happened here (one
      // heading gained, one lost, structure still "plausible"). Renaming a
      // section is a deliberate act and updating this list with it is correct;
      // silently absorbing one is not. Headings inside fenced code blocks are
      // excluded - `# nvm-windows does not read .nvmrc` in the build snippet
      // is a shell comment, and counting it would make this assertion a
      // description of the file's punctuation rather than of its structure.
      {
        const REQUIRED_SECTIONS = [
          "What Folia is",
          "What changed in Folia",
          "Features",
          "Installation",
          "Controls",
          "Supported files",
          "Mermaid",
          "Technology",
          "Engineering",
          "Where this is going",
          "Development",
          "Contributing",
          "License",
        ];
        let fenced = false;
        const sections = [];
        for (const l of readmeLines) {
          if (/^\s*```/.test(l)) {
            fenced = !fenced;
            continue;
          }
          if (fenced) continue;
          const m = /^##\s+(\S.*?)\s*$/.exec(l);
          if (m) sections.push(m[1]);
        }
        const missing = REQUIRED_SECTIONS.filter((s) => !sections.includes(s));
        check(
          "every section the shipped README promises a reader is still present",
          missing.length === 0,
          `missing: ${missing.join(", ")} | found: ${sections.join(" / ")}`,
        );
        // Without this, deleting the whole list above would leave the check
        // above trivially satisfied.
        check(
          "the README section sweep really parsed a document structure",
          sections.length >= REQUIRED_SECTIONS.length,
          `parsed only ${sections.length} level-2 headings`,
        );
      }

      // Embedded images are REDACTED rather than having their whole line
      // dropped: base64 is drawn from an alphabet that can spell anything, so
      // a blob is not evidence of branding - but dropping the line would also
      // blind these sweeps to anything else sharing it, which is a real hole
      // in a file whose longest lines are images.
      const prose = readmeSrc
        .split(/\r?\n/)
        .map((l, i) => [i + 1, l.replace(/data:image\/[A-Za-z0-9+/=;,.-]+/g, "data:image/<redacted>")]);

      // What extraResources genuinely ships, read from package.json rather than
      // restated here. Both the image and the link assertions below judge
      // against this same list, because both are asking the same question: is
      // this thing still there after installation?
      const extraTargets = ((pkg.build && pkg.build.extraResources) || []).map(
        (e) => (typeof e === "string" ? e : e.to || e.from),
      );

      const provStart = prose.findIndex(([, l]) => /^###\s+Provenance\b/.test(l));
      check(

        "the README has a provenance section, which is where upstream attribution belongs",
        provStart !== -1,
        "no '### Provenance' heading found",
      );
      const provEnd =
        provStart === -1
          ? -1
          : (() => {
              const rest = prose.slice(provStart + 1);
              const nxt = rest.findIndex(([, l]) => /^#{1,3}\s+\S/.test(l));
              return nxt === -1 ? prose.length : provStart + 1 + nxt;
            })();

      const vendorHits = prose
        .map((e, idx) => [idx, e])
        .filter(([, [, l]]) => VENDOR.test(l));
      const strayVendor = vendorHits
        .filter(([idx]) => provStart === -1 || idx < provStart || idx >= provEnd)
        .map(([, [n, l]]) => `${n}: ${l.trim().slice(0, 60)}`);
      check(
        "vendor branding in the README is confined to the provenance section",
        strayVendor.length === 0,
        strayVendor.join(" | "),
      );
      check(
        "the provenance section does credit the upstream authors, so LICENSE's names are explained",
        provStart !== -1 &&
          vendorHits.some(
            ([idx]) => idx >= provStart && idx < provEnd,
          ),
        "provenance section names no upstream vendor",
      );

      // The images used to be `data:` URIs, and the comment here used to
      // explain why: a document rendered by this app had baseURI = the app's
      // own index.html, so a relative <img src> resolved against the asar and
      // never loaded (measured: naturalWidth 0 for markdown image syntax, for
      // './'-prefixed paths and for raw <img src> alike, against 512 for a
      // data: URI).
      //
      // BOTH HALVES OF THAT HAVE SINCE CHANGED, and the fix for one surface was
      // silently breaking the other. `resolveDocumentRelativeImageSrc()`
      // (renderer.js) now resolves a relative src against the directory of the
      // file being viewed, so the app-side reason to embed is gone. Meanwhile
      // GitHub's markdown sanitizer permits only http(s) in an <img src> and
      // strips `data:` outright, so every screenshot in this README rendered as
      // a broken-image icon on the project's own front page - REPORTED BY THE
      // USER, because nothing here could see it.
      //
      // So the rule inverts. It is pinned in both directions on purpose: the
      // no-data: half is what keeps GitHub working, and the ships-beside half
      // is what keeps the installed app working, and each is invisible from the
      // surface the other one serves.
      {
        const imgs = prose
          .flatMap(([n, l]) =>
            [...l.matchAll(/<img\s[^>]*src="([^"]*)"/gi)].map((m) => [n, m[1]]),
          );
        const relImgs = imgs.filter(([, s]) => !/^(https?:|data:)/i.test(s));

        // A vacuity floor, not a specification: without it, a README that had
        // lost its images entirely would satisfy every assertion below.
        check(
          "the README carries images, so the assertions about them have something to judge",
          relImgs.length >= 4,
          `found ${relImgs.length} relative images among ${imgs.length} total`,
        );

        const embedded = imgs
          .filter(([, s]) => /^data:/i.test(s))
          .map(([n]) => `line ${n}`);
        check(
          "no README image is embedded as a data: URI, which GitHub strips",
          embedded.length === 0,
          embedded.join(" | "),
        );

        const missingOnDisk = relImgs
          .filter(([, s]) => !fs.existsSync(path.join(ROOT, s.replace(/[?#].*$/, ""))))
          .map(([n, s]) => `${n}: ${s}`);
        check(
          "every README image exists in the repository, so GitHub can serve it",
          missingOnDisk.length === 0,
          missingOnDisk.join(" | "),
        );

        // The installed README sits in resources/ with only what
        // extraResources put beside it, and the app resolves a relative src
        // against the README's OWN directory - so an image that is not shipped
        // at the same relative path is a broken image in the packaged product
        // while looking perfect on GitHub. Read from extraResources rather than
        // restated, so adding an image outside a shipped directory fails here.
        const unshipped = relImgs
          .filter(([, s]) => {
            const t = s.replace(/[?#].*$/, "");
            return !extraTargets.some((e) => t === e || t.startsWith(e + "/"));
          })
          .map(([n, s]) => `${n}: ${s}`);
        check(
          "every README image also ships beside the installed README, so the app can render it",
          unshipped.length === 0,
          `${unshipped.join(" | ")} - not under extraResources (${extraTargets.join(", ")})`,
        );
      }

      // MEASURED on the real open path, and the reason the shields.io badges
      // were dropped: all three loaded over the network (naturalWidth 210, 78
      // and 90). `img-src` deliberately permits `https:` - docs/SECURITY-AUDIT.md
      // records that as a considered trade, because remote images in markdown
      // are a real feature - so the CSP does not stop them and was never meant
      // to. The problem is not the directive, it is that the app's OWN bundled
      // documentation was exercising it: opening the README sent a request to
      // a third party every time, which is a read receipt issued by a file
      // whose opening paragraph promises the app works entirely offline.
      // Anything genuinely remote in a user's own document is still their
      // business; this pins only what THIS project ships.
      const remote = prose
        .filter(([, l]) =>
          /<img\s[^>]*src="https?:/i.test(l) ||
          /!\[[^\]]*\]\(\s*https?:\/\//i.test(l))
        .map(([n, l]) => `${n}: ${l.trim().slice(0, 70)}`);
      check(
        "the shipped README fetches no images over the network when the app opens it",
        remote.length === 0,
        remote.join(" | "),
      );

      // A relative LINK in the README must point at something that is actually
      // there after installation, and "there" is not the repository. MEASURED:
      // relative links resolve against the DOCUMENT's own directory (unlike
      // images, which resolve against index.html - the app is inconsistent, and
      // that is tracked separately), and in an install the README sits in
      // resources/ with only whatever extraResources put beside it. A probe of
      // the first draft found 7 of its 8 relative targets missing there,
      // including `LICENSE` - which ships only as `LICENSE.txt`.
      //
      // The failure is quiet and it is on a page the app itself offers from the
      // welcome screen, so nothing about running the app would reveal it, and
      // every one of those links works perfectly on GitHub. Repository-only
      // documents are therefore absolute URLs now; this pins the rest to what
      // extraResources genuinely ships, reading that list rather than repeating
      // it, so adding a link to an unshipped doc fails here.
      {
        const extras = extraTargets;
        const linkTargets = [];
        for (const [n, l] of prose) {
          for (const m of l.matchAll(/\]\(([^)\s]+)\)/g)) {
            const t = m[1];
            if (/^(https?:|mailto:|#|data:)/i.test(t)) continue;
            linkTargets.push([n, t.replace(/#.*$/, "")]);
          }
        }
        check(
          "the README does link to local files, so this assertion has something to judge",
          linkTargets.length > 0,
          "no relative links found at all",
        );
        const dangling = linkTargets
          .filter(([, t]) => !extras.includes(t))
          .map(([n, t]) => `${n}: ${t}`);
        check(
          "every relative README link points at a file that ships beside it",
          dangling.length === 0,
          `${dangling.join(", ")} - not in extraResources (${extras.join(", ")})`,
        );
      }
    }

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

    // Fields exempt from the stale-name sweep:
    //   description   - "markdown viewer" is the product CATEGORY, and saying
    //                   what the app is is the field's entire job. Sweeping it
    //                   would force prose that avoids naming its own category.
    // `homepage` used to be exempt too, because the GitHub repository was
    // still named markdown-viewer and the URL had to keep that slug to point
    // at anything. The repository is now lostinsea/folia, so the exemption is
    // gone and the URL is swept like every other identifier. GitHub keeps the
    // old slug redirecting, which is exactly why this needs an oracle: a stale
    // homepage would go on working indefinitely and nothing would notice.
    // Everything left is used as an IDENTIFIER by Electron, electron-builder
    // or the OS, and none of those may still say the old name.
    const STALE_EXEMPT = new Set(["description"]);
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
    const mainSrc = fs.readFileSync(path.join(SRC, "main.js"), "utf8");
    check(
      "main.js sets an explicit AppUserModelId, so Windows groups and notifies as Folia",
      /app\.setAppUserModelId\(/.test(mainSrc),
      "no setAppUserModelId call found in main.js",
    );
    check(
      "the AppUserModelId is read from build.appId rather than duplicated as a literal",
      /appId\s*\}\s*=\s*require\(["']\.{1,2}\/package\.json["']\)\.build/.test(
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
        path.join(ROOT, "scripts", "release.js"),
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
            path.join(ROOT, "scripts"),
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
                files.map((f) => path.join(ROOT, "dist", f)),
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
      const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
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
        gen = require("../scripts/generate-notices");
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

        // COMPLIANCE, and the gap that let a 130 MB packaging win silently
        // become a licence breach. Moving marked/mermaid/dompurify/prismjs to
        // devDependencies removed them from the lockfile's non-dev tree, and
        // the generator derived its package set from exactly that - so the
        // notices lost them while their code went on shipping inside
        // libs/vendor/*.js and libs/prismjs/. Nothing failed. The oracle here
        // is deliberately INDEPENDENT of the generator's own VENDORED_ROOTS:
        // it reads the LIBS table out of scripts/vendor-libs.js (the thing
        // that actually performs the vendoring) plus the committed libs/
        // subdirectories, so vendoring a new library without documenting it
        // fails rather than passing by omission.
        const vendorSrc = read("scripts/vendor-libs.js");
        const libsTable = /const LIBS = \[([\s\S]*?)\];/.exec(vendorSrc);
        const vendoredHere = new Set();
        if (libsTable) {
          for (const m of libsTable[1].matchAll(/\[\s*"([^"]+)"/g)) {
            vendoredHere.add(m[1]);
          }
        }
        // libs/prismjs and libs/tabulator are COMMITTED rather than produced by
        // vendor-libs.js, so the LIBS table cannot see them. EVERY committed
        // libs/ subdirectory counts: requiring a matching node_modules/<name>
        // (as this first did) quietly excused exactly the case that needs
        // policing most - Tabulator is not an npm dependency at all, so it was
        // covered only by the "committed file is not stale" assertion, which
        // anyone could satisfy by deleting its EXTRA entry and regenerating.
        const libsDir = path.join(ROOT, "libs");
        if (fs.existsSync(libsDir)) {
          for (const e of fs.readdirSync(libsDir, { withFileTypes: true })) {
            if (!e.isDirectory() || e.name === "vendor") continue;
            vendoredHere.add(e.name);
          }
        }
        check(
          "the vendoring oracle found the libraries it is meant to police",
          vendoredHere.size >= 4,
          `found ${vendoredHere.size}: ${[...vendoredHere].join(", ")} - the LIBS table or libs/ layout moved, so this check stopped checking`,
        );        // A cardinality check alone would be satisfied by any four names. These

        // The root set every vendored-library oracle below scopes itself by.
        // It is the UNION of the structurally discovered set and the
        // generator's own list, never the generator's list alone. Both review
        // models independently found the same residual hole: an oracle scoped
        // by gen.VENDORED_ROOTS silently stops looking at a root the moment
        // that list loses it, so a coordinated edit - drop "marked" from
        // VENDORED_ROOTS and move it back to dependencies - would restore the
        // double-shipping this whole item exists to remove while every
        // assertion here stayed green. Unioning makes the scope monotonic:
        // shrinking VENDORED_ROOTS can never shrink what gets checked.
        const vendoredRootNames = new Set([...vendoredHere, ...gen.VENDORED_ROOTS]);
        // A cardinality check alone would be satisfied by any four names. These
        // are the four whose code is known to ship, so name them: drift that
        // swaps one for another has to be noticed rather than counted.
        const missingRoots = ["marked", "mermaid", "dompurify", "prismjs"].filter(
          (n) => !vendoredHere.has(n),
        );
        check(
          "the vendoring oracle is policing the libraries that actually ship",
          missingRoots.length === 0,
          `${missingRoots.join(", ")} not discovered - if a library really was dropped, remove it from libs/ and from the generator too`,
        );
        // Directory names are lower case ("libs/tabulator") while the notice
        // heading is the project's own capitalisation ("Tabulator 6.2.5"), so
        // the comparison has to be case-insensitive or it reports a false
        // breach for the one library it was just widened to cover.
        const documentedLower = new Set([...documentedNames(regenerated)].map((n) => n.toLowerCase()));
        const undocumentedVendored = [...vendoredHere].filter(
          (n) => !documentedLower.has(n.toLowerCase()),
        );
        check(
          "every library vendored into libs/ has a notice",
          undocumentedVendored.length === 0,
          `${undocumentedVendored.join(", ")} - code ships inside libs/ but is documented nowhere; how it got there (npm devDependency, or committed by hand like Tabulator) does not change the obligation`,
        );

        // VERSION-level, and not merely a stricter version of the check above.
        // mermaid bundles marked 16.4.2 while this repository's own root copy
        // is marked 9.1.6. Both ship. If the lockfile walk ever resolved
        // mermaid's dependency to the ROOT entry instead of the nested one -
        // the single most plausible regression in resolveLockKey() - the
        // notices would still contain a heading called "marked", so every
        // name-level assertion here would stay green while the licence for the
        // code actually inside libs/vendor/mermaid.min.js went missing.
        //
        // The expectation is read STRUCTURALLY out of the lockfile rather than
        // from the generator's own closure. That distinction is not academic:
        // this assertion was first written against gen.vendoredPackages() and
        // was CIRCULAR - reverting resolveLockKey() to a root-only lookup moved
        // the expectation and the output together, and the assertion passed
        // while documenting the wrong version. A nested lockfile key IS a
        // private copy belonging to its parent by construction, so no
        // resolution logic is needed to know it must be documented.
        //
        // Assumes vendored roots are unscoped and unaliased: a scoped root
        // (@scope/name) would need `node_modules/@scope/name/node_modules/`,
        // and an `npm:` alias would make the folder name differ from the
        // package name the heading is written from. Neither shape exists here.
        const lockPkgs = JSON.parse(read("package-lock.json")).packages || {};
        const nestedUnderVendored = Object.keys(lockPkgs).filter((k) =>
          [...vendoredRootNames].some((r) => k.includes(`node_modules/${r}/node_modules/`)),
        );
        check(
          "the duplicate-version oracle found the nested copies it exists to police",
          nestedUnderVendored.length > 0,
          "no vendored root has a private nested dependency in the lockfile - this check is no longer checking anything",
        );
        const headings = new Set((regenerated.match(/^### .+$/gm) || []).map((h) => h.slice(4)));
        const missingVersions = nestedUnderVendored
          .map((k) => ({
            name: k.slice(k.lastIndexOf("node_modules/") + "node_modules/".length),
            version: (lockPkgs[k] || {}).version,
          }))
          .filter((p) => p.version && !headings.has(`${p.name} ${p.version}`));
        check(
          "every bundled version is documented, including duplicate versions of the same package",
          missingVersions.length === 0,
          `${missingVersions.length} missing: ${missingVersions
            .slice(0, 8)
            .map((p) => `${p.name}@${p.version}`)
            .join(", ")} - a nested lockfile entry is a private copy bundled into its parent, so the parent's bundle contains THAT version`,
        );

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
          let shippedFiles = null;
          let asarErr = null;
          try {
            const asar = require("@electron/asar");
            shipped = new Set();
            shippedFiles = new Set();
            for (const f of asar.listPackage(asarPath)) {
              const norm = f.replace(/\\/g, "/");
              shippedFiles.add(norm);
              const m = /^.*\/node_modules\/(@[^/]+\/[^/]+|[^/]+)\/package\.json$/.exec(norm);
              if (m) shipped.add(m[1]);
            }
          } catch (e) {
            asarErr = e;
            shipped = null;
            shippedFiles = null;
          }
          // A build exists and is fresh, so these oracles are OWED. Letting a
          // failure to read it fall through to `if (shipped)` would delete the
          // only assertions that inspect the actual artefact, with neither a
          // FAIL nor a SKIP - the same silent disappearance the skip()
          // mechanism was added to end, just via a different door.
          check(
            "the built app.asar can be inspected",
            shippedFiles !== null && shipped.size > 0,
            asarErr
              ? `@electron/asar threw: ${asarErr.message}`
              : "archive read but no node_modules package.json found in it",
          );
          if (shippedFiles) {
            // build.files states the INTENT to package libs/; this is the FACT
            // that it happened. The distinction stopped being academic when
            // marked/mermaid/dompurify/prismjs moved to devDependencies: from
            // that point libs/ is the ONLY copy of those libraries in the
            // installer, so a globbing change that dropped it would take the
            // renderer's syntax highlighting and every diagram with it, and
            // the two existing "in build.files" assertions would still pass.
            for (const rel of [
              "libs/vendor/marked.min.js",
              "libs/vendor/mermaid.min.js",
              "libs/vendor/purify.min.js",
              "libs/prismjs/components/prism-core.min.js",
            ]) {
              check(
                `${rel} is really inside the built app.asar`,
                shippedFiles.has("/" + rel),
                "declared in build.files but absent from the archive - this is now the only copy that ships",
              );
            }
          }

          // app-update.yml is what makes the packaged app able to find an
          // update at all: electron-updater reads it from resourcesPath, and
          // without it every check fails at config load. It is the
          // artefact-level fact behind the config-level assertion earlier -
          // the same intent/fact split as the libs/ bundles above.
          //
          // Its PRECONDITION has to be stated, and getting that wrong is how
          // this assertion first failed: electron-builder writes the file only
          // when an nsis target is in the build (app-builder-lib's
          // isSuitableWindowsTarget), so `npm run build` - portable only -
          // leaves win-unpacked with no feed, and the assertion was really
          // reading whichever target happened to build last. A skip that names
          // the remedy is honest; a failure would be blaming the tree for the
          // command the developer chose.
          const updateYml = path.join(
            ROOT, "dist", "win-unpacked", "resources", "app-update.yml",
          );
          if (!fs.existsSync(updateYml)) {
            skip(
              "packaged update feed config",
              "the last build produced no auto-updatable target, so electron-builder " +
                "wrote no app-update.yml - run `npm run build-all` (what release.yml runs)",
            );
          } else {
            const updateCfg = fs.readFileSync(updateYml, "utf8");
            check(
              "the packaged app carries an update feed config",
              /provider:\s*github/.test(updateCfg) &&
                /owner:\s*lostinsea/.test(updateCfg) &&
                /repo:\s*folia/.test(updateCfg),
              `app-update.yml does not name this fork: ${updateCfg.replace(/\s+/g, " ").trim()}`,
            );
          }
          if (shipped && shipped.size > 0) {
            const vendoredClosure = gen.vendoredPackageNames();
            // Names only. Reading each package.json out of the asar to compare
            // versions would be stronger still, but the failure this guards
            // against - a package shipping with no notice at all - is a name
            // level fact, and the staleness check above pins the versions.
            const documented = documentedNames(regenerated);
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
            // so they are legitimately absent from node_modules. ("Fira Code"
            // in full now - it used to be spelled "Fira" here only because the
            // name parser truncated version-less headings.) So is the whole
            // marked/mermaid/dompurify/prismjs closure: that code ships
            // pre-bundled under libs/, which is why it is a devDependency and
            // why it has no directory in the asar. The exemption is taken from
            // the generator rather than hard-coded so the two cannot drift.
            const VENDORED = new Set(["Tabulator", "Fira Code"]);
            for (const n of vendoredClosure) VENDORED.add(n);
            const overIncluded = [...documented].filter(
              (n) => !shipped.has(n) && !VENDORED.has(n),
            );
            check(
              "the notices document nothing that is absent from the built app.asar",
              overIncluded.length === 0,
              `${overIncluded.length} over-included: ${overIncluded.slice(0, 8).join(", ")}`,
            );

            // THE 130 MB GUARD. build.files ships `node_modules/**/*`, so
            // every production dependency lands in the asar whether any
            // shipped file requires it or not. Measured: marked, mermaid,
            // dompurify and prismjs were production dependencies and
            // contributed 130.4 MB to a 153.6 MB asar, while the renderer
            // loaded none of them from node_modules - it loads the vendored
            // bundles under libs/. Nothing failed, because a package that
            // ships and is documented satisfies both oracles above; the cost
            // was invisible to every assertion in this suite.
            //
            // Policed over the whole CLOSURE, not just the four roots. The
            // roots are the obvious regression; the transitives are the likely
            // one - d3, cytoscape, katex and dagre are already inlined into
            // libs/vendor/mermaid.min.js, so a future production dependency
            // that pulls any of them in ships that code TWICE while every
            // other assertion here stays green. Measured against the current
            // build: the closure (105 packages) and the asar's node_modules
            // (94 packages) do not intersect at all, so this is a genuine
            // widening rather than a rule the tree already violates.
            //
            // The structurally discovered roots are unioned in for the same
            // reason as vendoredRootNames above, and the shape of the hole was
            // MEASURED rather than taken on the reviewer's description of it.
            // Both models proposed the same compound regression - drop a root
            // from VENDORED_ROOTS and move it back to dependencies - using
            // `marked` as the example. Building that exact state (asar 24.1 MB,
            // marked back in node_modules) showed the closure-only guard
            // catching it anyway: mermaid depends on marked, so marked stays in
            // the closure even when it is not a root. The reviewers' conclusion
            // was right and their example was wrong.
            //
            // Reachability of each root via the other three, measured:
            //   marked    -> still reachable (via mermaid)
            //   dompurify -> still reachable (via mermaid)
            //   mermaid   -> NOT reachable, closure collapses 105 -> 4
            //   prismjs   -> NOT reachable, closure 105 -> 104
            // So for mermaid and prismjs the closure-only guard is
            // structurally incapable of naming them, for any asar contents.
            // That is what the union fixes. No revert entry pins it, because
            // the two sets are disjoint in the current tree and such an entry
            // would be permanently vacuous - the same reason R110b was deleted
            // rather than kept.
            const vendorDirs = [...new Set([...vendoredClosure, ...vendoredRootNames])].filter(
              (n) => shipped.has(n),
            );
            check(
              "no vendored library is also shipped as a node_modules copy",
              vendorDirs.length === 0,
              `${vendorDirs.join(", ")} ship twice - once under libs/ and again in node_modules; they belong in devDependencies`,
            );
          }
        } else {
          skip(
            "built app.asar oracles",
            fs.existsSync(asarPath)
              ? "dist build is older than package-lock.json - run `npm run build`"
              : "no dist build present - run `npm run build`",
          );
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
          // The vacuity guard used to be a hard-coded `entries.length > 200`
          // against a real count of 220. Twenty packages of headroom made it
          // a false failure waiting to happen, and it fired as exactly that:
          // a run with a smaller (deliberately broken) tree reported "107
          // entries, 0 WITHOUT" - a failure whose own diagnostic said nothing
          // was wrong. Tied to the collected component list instead, so it
          // measures a relationship rather than a remembered number.
          const collected = gen.collect().length;
          check(
            "every component entry reproduces operative licence language",
            collected > 0 && entries.length === collected && toothless.length === 0,
            `${collected} components collected, ${entries.length} rendered as entries, ${toothless.length} without operative language: ${toothless
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
          { heading: "dompurify", spdx: "(MPL-2.0 OR Apache-2.0)", elected: "Apache-2.0", body: /Apache License/, rejected: /Mozilla Public License/ },
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
        // NO REAL CONJUNCTIVE PACKAGE REMAINS. pako - `(MIT AND Zlib)` - was
        // the only one, and it left with html-to-docx's 70-package closure,
        // taking jszip's `(MIT OR GPL-3.0-or-later)` dual election with it.
        // The vacuity guard that asserted pako's presence was removed with it
        // rather than retargeted, because there is nothing to retarget it to.
        //
        // That costs less than it looks. The loop below still runs for any
        // conjunctive package that arrives later, and the machinery itself is
        // covered by the SYNTHETIC sensitivity probe further down - which was
        // written that way on purpose, precisely so this coverage would not
        // depend on a particular package staying in the tree. The election
        // assertions above are still driven by a real package (dompurify).
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
        // Since pako left the tree, this probe is the ONLY thing covering the
        // conjunctive path, which is exactly the case it was designed for. The
        // name is deliberately not a real package, so nobody greps for it and
        // concludes the dependency is still installed.
        let guardFired = false;
        try {
          gen.assertConjunctiveCovered([
            { name: "synthetic-conjunctive-fixture", version: "0.0.0", spdx: "(MIT AND Zlib)", extraLicences: [] },
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

        // The guard has four clauses and the two probes above reach only the
        // first (`!entry`). The rest are reachable only with a POPULATED table,
        // which the tree cannot supply while CONJUNCTIVE is legitimately empty -
        // so the table itself is the fixture. Restored in `finally`, because a
        // leaked entry would silently weaken every later assertion in this
        // process rather than failing one.
        const probeName = "synthetic-conjunctive-fixture";
        const realEntry = Object.prototype.hasOwnProperty.call(gen.CONJUNCTIVE, probeName)
          ? gen.CONJUNCTIVE[probeName]
          : undefined;
        const throwsWith = (entry, extraLicences, spdx) => {
          gen.CONJUNCTIVE[probeName] = entry;
          try {
            gen.assertConjunctiveCovered([
              { name: probeName, version: "0.0.0", spdx, extraLicences },
            ]);
            return false;
          } catch (err) {
            return /Conjunctive/.test(err.message);
          }
        };
        try {
          const limb = [{ file: "lib/zlib/README", spdx: "Zlib", covers: "lib/zlib/", text: "x" }];
          check(
            "the conjunctive guard fires when a table entry exists but no extra limb was collected",
            throwsWith({ spdx: "(MIT AND Zlib)" }, [], "(MIT AND Zlib)"),
          );
          check(
            "the conjunctive guard fires when the table entry describes a different expression",
            throwsWith({ spdx: "(MIT AND ISC)" }, limb, "(MIT AND Zlib)"),
          );
          // POSITIVE CONTROL, and it is the load-bearing one: without it every
          // assertion above is satisfied by a guard that throws unconditionally,
          // which would fail the build on the first real conjunctive dependency
          // and get deleted as noise - the precise outcome the guard exists to
          // avoid.
          check(
            "the conjunctive guard accepts a fully described conjunctive licence",
            !throwsWith({ spdx: "(MIT AND Zlib)" }, limb, "(MIT AND Zlib)"),
          );
        } finally {
          if (realEntry === undefined) delete gen.CONJUNCTIVE[probeName];
          else gen.CONJUNCTIVE[probeName] = realEntry;
        }

        // RENDER-level sensitivity probe, and it is NOT a stricter version of
        // the guard probe above. The guard only asks whether `extraLicences`
        // was POPULATED; it says nothing about whether the renderer emits it.
        // Those are two different failure modes and the second is the more
        // dangerous one - the guard is satisfied, the generator runs happily,
        // and the notices silently lose a binding limb.
        //
        // Synthetic for the same reason as the guard probe: pako left with
        // html-to-docx's closure and no conjunctive package remains, so a probe
        // driven by the real tree would be permanently vacuous. That is exactly
        // what happened to R141/R142, which named these properties and could
        // not break either of them.
        const conjRendered = gen.render([
          {
            name: "synthetic-conjunctive-fixture",
            version: "0.0.0",
            spdx: "(MIT AND Zlib)",
            licenseText: "MIT BODY, first limb only.",
            extraLicences: [
              {
                file: "lib/zlib/README",
                spdx: "Zlib",
                covers: "lib/zlib/",
                why: "Fixture: the package states that this folder carries the second limb.",
                // Zlib's clause 1 and clause 3, which appear in no other
                // licence family here - so the assertion cannot be satisfied by
                // the MIT text already present in the same entry.
                text:
                  "The origin of this software must not be misrepresented. " +
                  "This notice may not be removed or altered from any source distribution.",
              },
            ],
          },
        ]);
        check(
          "a conjunctive entry reproduces the operative terms of every limb, not just the first",
          /origin of this software must not be misrepresented/i.test(conjRendered) &&
            /may not be removed or altered/i.test(conjRendered),
          conjRendered.slice(0, 200),
        );
        check(
          "a conjunctive entry states which part of the package the extra terms cover",
          /Additional terms for `lib\/zlib\/` \(Zlib\)/.test(conjRendered),
          conjRendered.slice(0, 200),
        );
        check(
          "a conjunctive entry says plainly that no election is made, and claims none",
          /No election is made or possible/.test(conjRendered) &&
            !/elects \*\*/.test(conjRendered),
          conjRendered.slice(0, 200),
        );
        // Sensitivity in the other direction: the probe above would still pass
        // if render() dropped the PRIMARY licence text and emitted only the
        // extra limbs. Named separately so R142 can list it in mustPass, which
        // is what makes that revert say "the extra limbs were lost" rather than
        // "conjunctive rendering broke somehow".
        check(
          "a conjunctive entry still reproduces the primary licence text",
          /MIT BODY, first limb only\./.test(conjRendered),
          conjRendered.slice(0, 200),
        );

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

        // The logo SVG is generated, like the notices above, and needs the same
        // pin for the same reason - but it earned its own assertion by failing
        // in a worse way than the others. `git add -A` ABORTED on safecrlf, and
        // the `git commit` that ran next still SUCCEEDED, capturing only the
        // paths that happened to be staged already. The result was a commit
        // that looked ordinary and contained a fraction of the change. Nothing
        // about an aborted add stops the commit after it, so the guard has to
        // live here rather than relying on noticing the abort.
        {
          const pinned = /^assets\/logo\.svg\s+text\s+eol=lf\s*$/m.test(attrs);
          check(".gitattributes pins the generated logo SVG to LF", pinned);
          const p = path.join(ROOT, "assets", "logo.svg");
          check(
            "assets/logo.svg is stored with LF endings, as pinned",
            fs.existsSync(p) && !fs.readFileSync(p, "utf8").includes("\r\n"),
          );
        }

        // A LONE CR - a \r that is not part of a \r\n pair - silently disables
        // git's end-of-line normalisation for the ENTIRE file. git's own
        // text/binary heuristic classifies such a file as `-text`, after which
        // core.autocrlf stops converting it and the working tree's CRLF is
        // committed verbatim. Nothing announces this: `git diff --numstat`
        // still counts it as text, `git status` is silent, and the file reads
        // normally in every editor. The only symptom is an implausibly large
        // diffstat - here, a 285-line change to this very file was committed as
        // 1913 insertions / 1642 deletions because one stray \r had been
        // introduced by an automated edit.
        //
        // The .gitattributes pins above defend six specific generated or
        // verbatim files. They cannot defend the rest of the tree, because the
        // damage does not come from a missing pin - it comes from a byte that
        // should never have been written. So this checks the bytes.
        {
          let tracked = null;
          try {
            tracked = execFileSync("git", ["ls-files", "--eol", "-z"], {
              cwd: ROOT,
              encoding: "utf8",
              maxBuffer: 32 * 1024 * 1024,
            });
          } catch {
            tracked = null;
          }

          if (tracked === null) {
            skip(
              "tracked-source end-of-line hygiene",
              "git is unavailable or this is not a checkout; run inside the repository to enable",
            );
          } else {
            // Extensions whose contents are text by construction. Deliberately
            // an allow-list rather than a deny-list: a new binary format added
            // to the repo must not be able to fail this by accident, whereas a
            // new source extension that goes unchecked is a gap this comment
            // exists to make visible.
            const TEXT_EXT = new Set([
              ".js",
              ".cjs",
              ".mjs",
              ".json",
              ".md",
              ".css",
              ".html",
              ".yml",
              ".yaml",
              ".txt",
              ".svg",
              ".sh",
            ]);

            const rows = tracked.split("\0").filter(Boolean);
            const loneCr = [];
            const notText = [];
            let scanned = 0;

            for (const row of rows) {
              // `i/lf    w/crlf  attr/text=auto  <path>` - the path is
              // separated from the attribute columns by a TAB, and a path may
              // itself contain spaces, so split on the tab and nothing else.
              const tab = row.indexOf("\t");
              if (tab === -1) continue;
              const cols = row.slice(0, tab);
              const rel = row.slice(tab + 1);
              if (!TEXT_EXT.has(path.extname(rel).toLowerCase())) continue;

              const abs = path.join(ROOT, rel);
              if (!fs.existsSync(abs)) continue; // staged deletion mid-run
              scanned += 1;

              // git's own verdict. `-text` means normalisation is OFF for this
              // file, whatever .gitattributes or core.autocrlf say.
              if (/(^|\s)i\/-text(\s|$)/.test(cols)) notText.push(rel);

              const buf = fs.readFileSync(abs, "latin1");
              const hits = buf.match(/\r(?!\n)/g);
              if (hits) loneCr.push(`${rel} (${hits.length})`);
            }

            // Without this the whole block would pass by scanning nothing - the
            // exact shape of vacuous green this suite has been bitten by before.
            check(
              "the end-of-line sweep actually reached the tracked source files",
              scanned >= 30,
              `${scanned} text files scanned`,
            );
            check(
              "no tracked source file contains a lone CR, which would silently disable EOL normalisation",
              loneCr.length === 0,
              loneCr.slice(0, 10).join(", "),
            );
            check(
              "git classifies every tracked source file as text, so autocrlf still applies to it",
              notText.length === 0,
              notText.slice(0, 10).join(", "),
            );
          }
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
      const gen = require("../scripts/generate-notices");
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
      /Copyright \(c\) .*lostinsea/.test(licA),
      licA.split("\n").slice(0, 5).join(" | "),
    );
    // The intermediate fork's author never added a copyright line for himself,
    // so MIT's retention clause does not strictly compel this one. It is here
    // because his authorship is a FACT about the code this fork ships (43
    // commits in the inherited history, measured with `git shortlog -s`), and
    // copyright vests in an author whether or not he asserts it in a file.
    // Asserted rather than left to discipline: a future rewrite of the header
    // would otherwise drop an attribution that nothing else in the tree records.
    check(
      "LICENSE credits the intermediate fork's author, whose code this fork inherits",
      /Copyright \(c\) .*Moyseyenko/.test(licA),
      licA.split("\n").slice(0, 5).join(" | "),
    );
    check(
      "the NSIS installer agreement points at a licence file that exists",
      Boolean(pkg.build && pkg.build.nsis && pkg.build.nsis.license) &&
        fs.existsSync(path.join(ROOT, pkg.build.nsis.license)),
      pkg.build && pkg.build.nsis && pkg.build.nsis.license,
    );
  }

  // ── Localisation removal ─────────────────────────────────────────────────
  // The Turkish and Ukrainian locales and the language switcher were removed:
  // both arrived from the two upstream forks and neither served this product.
  // These oracles are static because the failure mode is a *leftover*, and a
  // leftover is a source fact. The i18n() seam is deliberately retained, so
  // "no localisation" cannot be asserted by its absence - it has to be
  // asserted against the specific machinery that was taken out.
  {
    const rendererSrc = fs.readFileSync(path.join(SRC, "renderer.js"), "utf8");
    const htmlSrc = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
    // "Shipped" is defined by package.json build.files, not by a hand-kept list
    // here. An earlier version of this block scanned only renderer.js,
    // index.html and custom-*.js while claiming to cover every shipped file -
    // which silently exempted main.js, popup-preload.js and the seven helper
    // modules from the leftover sweep. Deriving the list from the manifest
    // means adding a script to the package automatically puts it in scope.
    const shippedScripts = pkg.build.files.filter(
      (f) => /^[^!*]+\.js$/.test(f) && fs.existsSync(path.join(ROOT, f)),
    );
    const allSrc =
      htmlSrc +
      "\n" +
      shippedScripts
        .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
        .join("\n");

    // Vacuity guard: if the manifest filter matched nothing (or almost
    // nothing) every "is gone" assertion below would pass by scanning air.
    check(
      "the shipped-script list really was resolved from the packaging manifest",
      shippedScripts.length >= 12 &&
        shippedScripts.includes("src/renderer.js") &&
        shippedScripts.includes("src/main.js") &&
        shippedScripts.includes("src/popup-preload.js"),
      `${shippedScripts.length}: ${shippedScripts.join(", ")}`,
    );

    check(
      "the language switcher is gone from every shipped script",
      !/interfaceLang|applyInterfaceLang|langSubmenu|data-lang=/.test(allSrc),
      (allSrc.match(/interfaceLang|applyInterfaceLang|langSubmenu|data-lang=/g) || [])
        .join(", "),
    );

    check(
      "the Ukrainian overlay file is deleted, not merely unregistered",
      !fs.existsSync(path.join(ROOT, "custom-language.js")) &&
        !/custom-language\.js/.test(htmlSrc) &&
        !JSON.stringify(pkg.build.files).includes("custom-language.js"),
      "custom-language.js still present on disk, in index.html, or in build.files",
    );

    check(
      "the emptied Tools menu was removed rather than left as a dead button",
      !/id="toolsBtn"|id="toolsMenu"/.test(htmlSrc) &&
        !/toolsBtn|toolsMenu/.test(rendererSrc),
      "toolsBtn/toolsMenu references survive",
    );

    // The View menu shares the .tools-* CSS class family with the removed
    // Tools menu, and custom-theme.js injects its Theme submenu into it. A
    // deletion that took the classes with it would silently unstyle both, so
    // the survivors are pinned explicitly.
    const cssSrc = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
    check(
      "the shared submenu styling the Theme menu depends on survived the removal",
      // Anchored at line start on purpose: an unanchored /\.tools-submenu\s*\{/
      // is also satisfied by the descendant selector
      // ".tools-menu-item.has-submenu:hover > .tools-submenu {", so deleting
      // the standalone rule that actually positions and hides the panel left
      // the check green. R175 measured that.
      /^\.tools-submenu\s*\{/m.test(cssSrc) &&
        /^\.tools-submenu-item\s*\{/m.test(cssSrc) &&
        /^\.submenu-arrow\s*\{/m.test(cssSrc) &&
        /\.tools-menu-item\.has-submenu:hover\s*>\s*\.tools-submenu\s*\{/.test(
          cssSrc,
        ) &&
        /id="viewMenu"/.test(htmlSrc),
      "custom-theme.js builds .tools-menu-item.has-submenu > .tools-submenu inside #viewMenu",
    );

    // UI_STRINGS is now a flat single-locale table. Parse it and require every
    // key to have a consumer. Without this the table silently accumulates dead
    // entries: 19 were already unreferenced before the locales were removed,
    // and nothing would ever have said so.
    const lines = rendererSrc.split(/\r?\n/);
    const iDecl = lines.indexOf("const UI_STRINGS = {");
    const iEnd = lines.indexOf("};", iDecl);
    const tableBody = lines.slice(iDecl + 1, iEnd).join("\n");
    const uiKeys = [];
    const keyRe = /'((?:[^'\\]|\\.)*)':\s*'/g;
    let km;
    while ((km = keyRe.exec(tableBody))) uiKeys.push(km[1]);

    check(
      "UI_STRINGS is a flat single-locale table",
      iDecl >= 0 && iEnd > iDecl && !/^\s{2}(en|tr|uk):\s*\{/m.test(tableBody),
      `iDecl=${iDecl} iEnd=${iEnd}`,
    );

    // Vacuity guard: a parse that finds nothing would make the sweep below
    // pass by measuring an empty set.
    check(
      "the UI string table really was parsed",
      uiKeys.length >= 100,
      `${uiKeys.length} keys parsed`,
    );

    // Reference syntaxes recognised here: i18n('key'), the data-i18n family,
    // and custom-tabs.js's local t('key', fallback) wrapper. That wrapper is
    // the reason this list is explicit rather than a bare i18n() match - an
    // overlay key reachable ONLY through t() would otherwise be swept up as
    // dead and deleted. Any future indirection must be added here too.
    const orphaned = uiKeys.filter((k) => {
      const q = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return (
        !new RegExp(`i18n\\(\\s*['"\`]${q}['"\`]`).test(allSrc) &&
        !new RegExp(`\\bt\\(\\s*['"\`]${q}['"\`]`).test(allSrc) &&
        !new RegExp(`data-i18n(?:-title|-placeholder)?="${q}"`).test(allSrc)
      );
    });
    check(
      "every UI string has a consumer",
      orphaned.length === 0,
      `${orphaned.length} unreferenced: ${orphaned.join(", ")}`,
    );
  }

  // ── Word export removal ──────────────────────────────────────────────────
  // Export to Word was removed with its html-to-docx dependency. The removal
  // is worth pinning for two reasons that pull in different directions:
  //
  //  - html-to-docx was one of only two production dependencies, and its
  //    closure was 70 packages / 13.00 MB that nothing else in the tree
  //    shared. A re-added `dependencies` entry ships that to every user again
  //    whether or not any code calls it, which is the R159 failure mode.
  //  - The renderer-side rasteriser (mermaidToPngDataUrl) was left with NO
  //    caller once the Word handler went, so it was removed too. Dead code
  //    that is still tested reads as live code to the next maintainer.
  //
  // Static oracles, because a leftover is a source fact.
  {
    const shippedScripts = pkg.build.files.filter(
      (f) => /^[^!*]+\.js$/.test(f) && fs.existsSync(path.join(ROOT, f)),
    );
    const htmlSrc = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
    const allSrc =
      htmlSrc +
      "\n" +
      shippedScripts
        .map((f) => fs.readFileSync(path.join(ROOT, f), "utf8"))
        .join("\n");

    check(
      "html-to-docx is gone from the manifest, the lockfile and node_modules",
      !Object.prototype.hasOwnProperty.call(pkg.dependencies || {}, "html-to-docx") &&
        !Object.prototype.hasOwnProperty.call(
          pkg.devDependencies || {},
          "html-to-docx",
        ) &&
        !fs.existsSync(path.join(ROOT, "node_modules", "html-to-docx")) &&
        !fs
          .readFileSync(path.join(ROOT, "package-lock.json"), "utf8")
          .includes("html-to-docx"),
      "a surviving entry in any of the four reinstalls the whole 70-package closure",
    );

    // Stated as a bound rather than an exact set so that adding a dependency
    // is a deliberate act with a visible cost, not a silent one.
    check(
      "the tree still declares exactly one production dependency",
      Object.keys(pkg.dependencies || {}).length === 1 &&
        Object.prototype.hasOwnProperty.call(
          pkg.dependencies || {},
          "electron-updater",
        ),
      JSON.stringify(Object.keys(pkg.dependencies || {})),
    );

    check(
      "the Word export path is gone from every shipped script",
      !/exportWord|export-word|word-export|HTMLtoDOCX|html-to-docx/.test(allSrc),
      (
        allSrc.match(
          /exportWord|export-word|word-export|HTMLtoDOCX|html-to-docx/g,
        ) || []
      ).join(", "),
    );

    check(
      "the Word menu item was removed rather than left hidden",
      !/id="exportWord"/.test(htmlSrc) && !/\.docx/.test(allSrc),
      "an #exportWord element or a .docx mention survives in the shipped source",
    );

    // The name of the format is not the only way it can come back. The Word
    // MIME types are what a save dialog filter and a Blob type are written
    // with, and neither contains the string "docx" or "word-export", so the
    // sweeps above would both pass while a half-restored export path sat in
    // the tree. Cheap to state, and it costs nothing while the feature is gone.
    check(
      "no Word document MIME type survives in any shipped script",
      !/wordprocessingml|application\/msword/i.test(allSrc),
      (allSrc.match(/wordprocessingml|application\/msword/gi) || []).join(", "),
    );

    // Dead UI strings are already swept generally, a few assertions above
    // ("every UI string has a consumer"), and that sweep is strictly stronger
    // than a Word-specific one: it requires each key to appear in a CALL
    // position rather than merely somewhere in the file. It is what caught the
    // orphaned 'mermaid.error' string this removal left behind, so the six
    // labels the Word menu item owned need no separate assertion here.

    // The rasteriser existed only to embed diagrams into the DOCX. Leaving it
    // behind would keep ~120 lines of renderer parsed on every launch, plus
    // the two test sections that measured it, for a feature that no longer
    // exists. The image-zoom popup does its own rasterising in its own window.
    check(
      "the orphaned export rasteriser was removed with its only caller",
      !/mermaidToPngDataUrl/.test(allSrc),
      "mermaidToPngDataUrl survives with no caller",
    );
  }

  const strict = process.env.PACKAGING_STRICT === "1";
  if (strict && skipped.length) {
    check(
      "no oracle was skipped (PACKAGING_STRICT=1)",
      false,
      `skipped: ${skipped.join(", ")} - the release must verify the artefact, not merely fail to contradict it`,
    );
  }
  console.log(
    `\n=== ${pass} passed, ${fail} failed${skipped.length ? `, ${skipped.length} SKIPPED: ${skipped.join(", ")}` : ""} ===\n`,
  );
  process.exit(fail === 0 ? 0 : 1);
}

main();
