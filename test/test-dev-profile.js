// Proves devProfileDecision(): a development run (`electron .`) is given a
// profile of its own instead of silently sharing the installed app's, and -
// just as important - DECLINES to move a profile something else has already
// relocated.
//
// The function is executed out of main.js rather than reimplemented here: the
// source text is sliced and evaluated, so what runs is the shipped code. If
// main.js is refactored such that the slice no longer matches, this fails loud
// rather than silently testing nothing.
//
// Pure, so it is driven directly against a stub rather than by booting Electron
// twice and looking at where files landed. The three inputs it reads are the
// three a stub can supply: isPackaged, getName() and getPath().
//
// The positive half cannot be asserted from inside a windowed suite, because
// every windowed suite requires test-userdata-isolation.js first and the
// decision correctly declines once a profile has been relocated - so there the
// answer is always "already-relocated". test/test-startup-perf.js asserts that
// NEGATIVE half live, which is where the damage would show; this is where the
// positive half is reachable at all.
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("PASS  " + name);
    pass++;
  } else {
    // Separator is "  -> ", matching every other suite: the revert harness
    // recovers an assertion NAME by splitting a FAIL line there, so a suite
    // that formats its evidence differently lets a revert's `expect` regex be
    // satisfied by evidence text instead of by the assertion it names.
    console.log("FAIL  " + name + (detail ? "  -> " + detail : ""));
    fail++;
  }
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "folia-dev-profile-test-"));
// Plain-node tier, so no Electron app.exit() can terminate mid-stack and the
// removal below on the normal path is reached in the ordinary case. This hook
// covers the two paths that skip it: an escaping throw from any check, and the
// early process.exit(1) in the extraction guard immediately below - both of
// which would otherwise strand the tree. Deliberately NOT the shared registry
// in test-visual-utils.js: that seam exists for the two ways an ELECTRON suite
// can terminate without reaching a removal - app.exit() unwinds nothing, so no
// finally runs, and (measured, correcting an earlier note in this repo that
// claimed otherwise) it does not reliably run process.on("exit") either, since
// whether the exit hook fires depends on whether app.exit() is reached while
// still inside the ready event's own native dispatch. Neither hazard exists
// here: this suite has no app to exit, so its exit hook always runs, and
// importing an Electron harness module into a plain-node suite would buy
// nothing.
process.on("exit", () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (_) {
    /* best effort; a later run's mkdtemp is unaffected either way */
  }
});
const devStart = src.indexOf("const DEV_PROFILE_SUFFIX");
const devEnd = src.indexOf("function applyDevProfile", devStart);
if (devStart === -1 || devEnd === -1) {
  console.error("FAIL could not extract devProfileDecision from main.js");
  process.exit(1);
}
// eslint-disable-next-line no-new-func
const decide = new Function(
  "path",
  src.slice(devStart, devEnd) + "\nreturn devProfileDecision;"
)(path);

function fakeApp(o) {
  return {
    isPackaged: !!o.isPackaged,
    getName: () => o.name,
    getPath: (k) => (k === "appData" ? o.appData : o.userData),
  };
}
const APPDATA = path.join(root, "roaming");
const devDecision = decide(
  fakeApp({ name: "Folia", appData: APPDATA, userData: path.join(APPDATA, "Folia") })
);

check(
  "a development run is redirected to a profile of its own",
  devDecision.reason === "dev" &&
    path.resolve(devDecision.target) === path.resolve(path.join(APPDATA, "Folia-dev")),
  JSON.stringify(devDecision)
);
check(
  "the development profile is a SIBLING of the standard one, not inside it",
  path.dirname(path.resolve(devDecision.target)) === path.resolve(APPDATA) &&
    path.resolve(devDecision.target) !== path.resolve(path.join(APPDATA, "Folia")),
  JSON.stringify(devDecision)
);
// The suffix is appended to app.getName() rather than to a literal, so a rename
// of the product keeps the two profiles siblings instead of stranding the dev
// one beside a name nothing uses.
const renamedDecision = decide(
  fakeApp({ name: "Renamed", appData: APPDATA, userData: path.join(APPDATA, "Renamed") })
);
check(
  "the development profile name is derived from the app name, not hardcoded",
  renamedDecision.reason === "dev" &&
    path.resolve(renamedDecision.target) === path.resolve(path.join(APPDATA, "Renamed-dev")),
  JSON.stringify(renamedDecision)
);
check(
  "a packaged build is never redirected",
  decide(
    fakeApp({
      isPackaged: true,
      name: "Folia",
      appData: APPDATA,
      userData: path.join(APPDATA, "Folia"),
    })
  ).target === null,
  JSON.stringify(
    decide(
      fakeApp({
        isPackaged: true,
        name: "Folia",
        appData: APPDATA,
        userData: path.join(APPDATA, "Folia"),
      })
    )
  )
);
// The one that protects the harness: every windowed suite relocates userData
// before main.js loads, and clobbering that would put them all back in one
// shared profile - silently, since nothing downstream checks whose profile it
// got. Deliberately not a COUNT: a hand-maintained number is exactly the thing
// that goes stale, and a stale one reads as precision it no longer has.
const relocated = decide(
  fakeApp({
    name: "Folia",
    appData: APPDATA,
    userData: path.join(os.tmpdir(), "folia-test-userdata", "some-suite"),
  })
);
check(
  "an already-relocated profile is left exactly where it was",
  relocated.target === null && relocated.reason === "already-relocated",
  JSON.stringify(relocated)
);
// Cheap on Windows, load-bearing on Linux: the comparison is path.resolve on
// both sides and deliberately NOT lowercased. Lowercasing would report two
// genuinely different directories as the same one on a case-sensitive
// filesystem, and the failure direction matters - "same" means "nothing has
// relocated this", which is the branch that overwrites.
const caseDecision = decide(
  fakeApp({ name: "Folia", appData: APPDATA, userData: path.join(APPDATA, "FOLIA") })
);
check(
  "a userData path differing only in case is treated as a relocation, not as the default",
  caseDecision.target === null && caseDecision.reason === "already-relocated",
  JSON.stringify(caseDecision)
);

// root is removed by the process.on("exit") hook registered beside its mkdtemp.

async function checkDiagnosticLogging() {
  const starts = [...src.matchAll(/^const logFilePath = /gm)];
  const ends = [...src.matchAll(/^\/\/ APPLICATION STATE\r?$/gm)];
  const located =
    starts.length === 1 &&
    ends.length === 1 &&
    ends[0].index > starts[0].index;
  check("the diagnostic logging block was located uniquely", located);
  if (!located) return;
  const code = src.slice(starts[0].index, ends[0].index);
  check(
    "the extracted diagnostic logger includes real startup calls",
    code.includes('log("=== Application started ===");') &&
      code.includes('log("User data path:", app.getPath("userData"));'),
  );

  function load(label, packaged, value, existing = false, failOpen = false) {
    const profile = path.join(root, label);
    fs.mkdirSync(profile);
    const file = path.join(profile, "debug.log");
    if (existing) fs.writeFileSync(file, "retained private diagnostic\n");
    if (failOpen) fs.mkdirSync(file);
    const before = existing
      ? { bytes: fs.readFileSync(file), stat: fs.statSync(file) }
      : null;
    const observed = { opens: 0, messages: [], errors: [], nativeErrors: [] };
    const env = value === undefined ? {} : { FOLIA_DIAGNOSTIC_LOG: value };
    const runtime = vm.runInNewContext(
      code + "\n({ log, logStream });",
      {
        app: { isPackaged: packaged, getPath: () => profile },
        path,
        process: { env },
        fs: {
          createWriteStream(...args) {
            observed.opens++;
            const stream = fs.createWriteStream(...args);
            stream.on("error", (err) => observed.nativeErrors.push(err));
            return stream;
          },
        },
        console: {
          log: (...args) => observed.messages.push(args),
          error: (...args) => observed.errors.push(args),
        },
      },
    );
    return { ...runtime, profile, file, before, observed, packaged };
  }

  function closed(stream) {
    if (!stream || stream.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("diagnostic test stream did not close within 5 seconds")),
        5000,
      );
      stream.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  function skipsFormatting(runtime) {
    let serializations = 0;
    let error = null;
    try {
      runtime.log({
        toJSON() {
          serializations++;
          throw new Error("disabled file serialization must be unreachable");
        },
      });
    } catch (err) {
      error = err;
    }
    return { passed: serializations === 0 && error === null, error };
  }

  const disabled = [
    ["packaged-unset-fresh", true, undefined, false],
    ["development-unset-fresh", false, undefined, false],
    ["packaged-zero-fresh", true, "0", false],
    ["packaged-unrecognized-fresh", true, "true", false],
    ["packaged-leading-zero-fresh", true, "01", false],
    ["packaged-whitespace-fresh", true, " 1 ", false],
    ["packaged-unset-existing", true, undefined, true],
    ["development-unset-existing", false, undefined, true],
  ];
  for (const [label, packaged, value, existing] of disabled) {
    const runtime = load(label, packaged, value, existing);
    const skipped = skipsFormatting(runtime);
    const close = closed(runtime.logStream);
    if (runtime.logStream) runtime.logStream.end();
    await close;
    check(
      `disabled diagnostic logging (${label}) opens no sink`,
      runtime.observed.opens === 0,
    );
    const after = existing ? fs.statSync(runtime.file) : null;
    check(
      `disabled diagnostic logging (${label}) leaves its log state unchanged`,
      existing
        ? fs.readFileSync(runtime.file).equals(runtime.before.bytes) &&
            after.dev === runtime.before.stat.dev &&
            after.ino === runtime.before.stat.ino &&
            after.size === runtime.before.stat.size &&
            after.mtimeMs === runtime.before.stat.mtimeMs
        : !fs.existsSync(runtime.file),
    );
    check(
      `disabled diagnostic logging (${label}) skips file serialization`,
      skipped.passed,
      skipped.error && skipped.error.message,
    );
    check(
      `diagnostic logging (${label}) preserves development-only console output`,
      packaged
        ? runtime.observed.messages.length === 0
        : runtime.observed.messages.some((args) => args[0] === "=== Application started ==="),
    );
  }

  for (const packaged of [true, false]) {
    for (const existing of [false, true]) {
      const mode = `${packaged ? "packaged" : "development"}-${existing ? "existing" : "fresh"}`;
      const runtime = load(`${mode}-enabled`, packaged, "1", existing);
      runtime.log("controlled diagnostic marker");
      const close = closed(runtime.logStream);
      if (runtime.logStream) runtime.logStream.end();
      await close;
      check(
        `exact diagnostic opt-in (${mode}) opens one native sink`,
        runtime.observed.opens === 1 && runtime.logStream && runtime.logStream.closed,
      );
      const body = fs.existsSync(runtime.file) ? fs.readFileSync(runtime.file, "utf8") : null;
      check(
        `exact diagnostic opt-in (${mode}) retains startup and controlled output`,
        body !== null &&
          (!existing || body.startsWith("retained private diagnostic\n")) &&
          body.includes("=== Application started ===") &&
          body.includes("controlled diagnostic marker"),
      );
    }
  }

  const failed = load("enabled-open-failure", true, "1", false, true);
  check(
    "the diagnostic open-failure fixture is a real directory",
    fs.statSync(failed.file).isDirectory(),
  );
  await closed(failed.logStream);
  check(
    "the diagnostic error sentinel saw a real native open failure",
    failed.observed.opens === 1 &&
      failed.observed.nativeErrors.length === 1 &&
      failed.logStream &&
      failed.logStream.closed &&
      failed.logStream.destroyed,
  );
  check(
    "diagnostic file failures are explicitly reported to the console",
    failed.observed.errors.some(
      (args) =>
        args[0] === "Diagnostic file logging failed:" &&
        args[1] === failed.observed.nativeErrors[0],
    ),
  );
  const skipped = skipsFormatting(failed);
  check(
    "a failed diagnostic sink skips subsequent file serialization",
    skipped.passed,
    skipped.error && skipped.error.message,
  );
}

checkDiagnosticLogging().then(
  () => {
    console.log("\n=== " + pass + "/" + (pass + fail) + " passed ===");
    process.exit(fail ? 1 : 0);
  },
  (err) => {
    console.error("FAIL  diagnostic logging controls could not complete  -> " + err.stack);
    process.exit(1);
  },
);
