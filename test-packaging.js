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

  console.log(`\n=== ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
