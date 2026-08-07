// Proves migrateLegacyUserData copies a legacy profile across the 1.0 rename,
// that it retries after an interrupted copy, and that it stops once the copy
// has genuinely completed.
//
// The function is executed out of main.js rather than reimplemented here: the
// source text is sliced and evaluated against a stubbed `app`, so what runs is
// the shipped code. If main.js is refactored such that the slice no longer
// matches, this fails loud rather than silently testing nothing.
const fs = require("fs");
const os = require("os");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "main.js"), "utf8");
const start = src.indexOf("const LEGACY_USERDATA_NAME");
const end = src.indexOf("migrateLegacyUserData();", start);
if (start === -1 || end === -1) {
  console.error("FAIL could not extract migrateLegacyUserData from main.js");
  process.exit(1);
}
const body = src.slice(start, end);

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("PASS  " + name);
    pass++;
  } else {
    console.log("FAIL  " + name + (detail ? "  " + detail : ""));
    fail++;
  }
}

function build(userDataPath, fsImpl) {
  const app = { getPath: () => userDataPath };
  // eslint-disable-next-line no-new-func
  return new Function(
    "app",
    "fs",
    "path",
    "console",
    body +
      "\nreturn { migrate: migrateLegacyUserData, legacyName: LEGACY_USERDATA_NAME, sentinel: MIGRATION_SENTINEL };"
  )(app, fsImpl || fs, path, { log() {}, warn() {} });
}

function run(userDataPath) {
  build(userDataPath).migrate();
}

// Runs the real function against a recording `fs`, so the harness can observe
// WHICH filesystem calls the shipped code makes rather than only the state it
// leaves behind. Needed because the end state cannot distinguish a rename from
// a copy: the staging area is deleted on success either way, so every
// after-the-fact assertion about it passes for both. (Found by the revert
// harness - the first version of this test asserted on the deleted staging
// directory and was vacuous.)
function runSpied(userDataPath) {
  const calls = { renameSync: 0, copyFileSync: 0 };
  const spy = Object.create(fs);
  for (const name of Object.keys(calls)) {
    spy[name] = (...args) => {
      calls[name]++;
      return fs[name](...args);
    };
  }
  build(userDataPath, spy).migrate();
  return calls;
}

// The names the product uses are read back out of the source, so every fixture
// below is built from the same value the shipped code reads. Hardcoding
// "markdown-viewer" on both sides of the comparison would make the copy
// assertions pass no matter what main.js said.
const meta = build(path.join(os.tmpdir(), "folia-meta-probe"));
const LEGACY_NAME = meta.legacyName;
const SENTINEL = meta.sentinel;

// ...and the literal itself is pinned exactly once, here. Source of truth:
// Electron derives userData from app.getName(), which is package.json `name`.
// That field read "markdown-viewer" for every release up to and including
// 2.0.7, which is what any existing installation on disk will be using.
check(
  'the legacy directory name is the pre-rename package name "markdown-viewer"',
  LEGACY_NAME === "markdown-viewer",
  "got " + JSON.stringify(LEGACY_NAME)
);
check("a completion sentinel is used at all", typeof SENTINEL === "string" && SENTINEL.length > 0);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "folia-migrate-test-"));
const legacy = path.join(root, LEGACY_NAME);
const target = path.join(root, "Folia");

// --- case 1: legacy profile exists, new one does not -> copied
fs.mkdirSync(path.join(legacy, "Local Storage", "leveldb"), { recursive: true });
fs.writeFileSync(path.join(legacy, "window-state.json"), '{"width":1280}');
fs.writeFileSync(path.join(legacy, "Local Storage", "leveldb", "000003.log"), "recent-files-payload");

check("the legacy profile really exists, so the copy can fail", fs.existsSync(legacy));
check("the target really does not exist yet", !fs.existsSync(target));

run(target);

check("the new userData directory is created", fs.existsSync(target));
check(
  "window-state.json is carried across",
  fs.existsSync(path.join(target, "window-state.json")) &&
    fs.readFileSync(path.join(target, "window-state.json"), "utf8") === '{"width":1280}'
);
check(
  "nested Local Storage (recent files, tabs, theme) is carried across",
  fs.existsSync(path.join(target, "Local Storage", "leveldb", "000003.log")) &&
    fs.readFileSync(path.join(target, "Local Storage", "leveldb", "000003.log"), "utf8") ===
      "recent-files-payload"
);
check("the legacy profile is copied, not moved, so an older build still works", fs.existsSync(legacy));
check("a completion sentinel is written once the copy succeeds", fs.existsSync(path.join(target, SENTINEL)));

// --- case 2: migration already completed -> no-op, must not clobber
fs.writeFileSync(path.join(target, "window-state.json"), '{"width":900}');
fs.writeFileSync(path.join(legacy, "added-after-migration.json"), '{"late":true}');
run(target);
check(
  "a second launch does not overwrite the migrated profile",
  fs.readFileSync(path.join(target, "window-state.json"), "utf8") === '{"width":900}'
);
check(
  "a completed migration does not keep re-importing the legacy profile",
  !fs.existsSync(path.join(target, "added-after-migration.json"))
);

// --- case 3: no legacy profile -> clean no-op, no directory conjured
const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "folia-migrate-test2-"));
const target2 = path.join(root2, "Folia");
run(target2);
check("a fresh install with no legacy profile does not create a userData directory", !fs.existsSync(target2));

// --- case 4: legacy path exists but is a FILE, not a directory
const root3 = fs.mkdtempSync(path.join(os.tmpdir(), "folia-migrate-test3-"));
fs.writeFileSync(path.join(root3, LEGACY_NAME), "not a directory");
const target3 = path.join(root3, "Folia");
let threw = false;
try {
  run(target3);
} catch (e) {
  threw = true;
}
check("a legacy path that is a file is ignored rather than throwing", !threw && !fs.existsSync(target3));

// --- case 5: THE REGRESSION THIS SHAPE EXISTS FOR.
// cpSync is not atomic. An interrupted first launch - a crash, or an EBUSY on
// a LevelDB lock still held by a running 2.0.7 - leaves the target directory
// present but incomplete. Gating on `fs.existsSync(target)` would read that as
// "already migrated" and never retry, stranding the user on a half-copied
// profile permanently. The sentinel makes the incomplete attempt retryable.
const root4 = fs.mkdtempSync(path.join(os.tmpdir(), "folia-migrate-test4-"));
const legacy4 = path.join(root4, LEGACY_NAME);
const target4 = path.join(root4, "Folia");
fs.mkdirSync(path.join(legacy4, "Local Storage", "leveldb"), { recursive: true });
fs.writeFileSync(path.join(legacy4, "window-state.json"), '{"width":1440}');
fs.writeFileSync(path.join(legacy4, "Local Storage", "leveldb", "000003.log"), "the-important-payload");
// Simulate the interrupted copy: the directory and one cheap file made it, the
// nested Local Storage did not, and no sentinel was ever written.
fs.mkdirSync(target4, { recursive: true });
fs.writeFileSync(path.join(target4, "window-state.json"), '{"width":1440}');

check(
  "the interrupted state is really incomplete, so the retry can fail",
  fs.existsSync(target4) &&
    !fs.existsSync(path.join(target4, SENTINEL)) &&
    !fs.existsSync(path.join(target4, "Local Storage", "leveldb", "000003.log"))
);

run(target4);

check(
  "an interrupted migration is retried and completes on the next launch",
  fs.existsSync(path.join(target4, "Local Storage", "leveldb", "000003.log")) &&
    fs.readFileSync(path.join(target4, "Local Storage", "leveldb", "000003.log"), "utf8") ===
      "the-important-payload"
);
check("the completed retry writes the sentinel", fs.existsSync(path.join(target4, SENTINEL)));

// --- case 6: a retry must not clobber files the user changed in the new profile
//
// Deliberately carries TWO files, because one is not enough to discriminate.
// A file present on both sides (STALE vs NEWER) only catches a revert to
// `force: true`; a revert to the old existsSync gate would ALSO leave NEWER
// intact, by returning early and copying nothing. The gap file - present only
// in the legacy profile - is what makes this case fail against that shape too,
// so the assertion is one-directional without it.
const root5 = fs.mkdtempSync(path.join(os.tmpdir(), "folia-migrate-test5-"));
const legacy5 = path.join(root5, LEGACY_NAME);
const target5 = path.join(root5, "Folia");
fs.mkdirSync(path.join(legacy5, "Local Storage", "leveldb"), { recursive: true });
fs.writeFileSync(path.join(legacy5, "window-state.json"), '{"width":"STALE"}');
fs.writeFileSync(path.join(legacy5, "Local Storage", "leveldb", "000003.log"), "gap-payload");
fs.mkdirSync(target5, { recursive: true });
fs.writeFileSync(path.join(target5, "window-state.json"), '{"width":"NEWER"}');

check(
  "the target really starts with the newer file and without the gap file",
  fs.readFileSync(path.join(target5, "window-state.json"), "utf8") === '{"width":"NEWER"}' &&
    !fs.existsSync(path.join(target5, "Local Storage", "leveldb", "000003.log"))
);

run(target5);
check(
  "a retry fills gaps without overwriting newer files in the target profile",
  fs.readFileSync(path.join(target5, "window-state.json"), "utf8") === '{"width":"NEWER"}'
);
check(
  "the same retry still copies files the target does not have yet",
  fs.existsSync(path.join(target5, "Local Storage", "leveldb", "000003.log")) &&
    fs.readFileSync(path.join(target5, "Local Storage", "leveldb", "000003.log"), "utf8") ===
      "gap-payload"
);

// --- case 7: the staging area is a real intermediate, and it is cleaned up
//
// This is what buys the no-truncation property, so it is asserted rather than
// assumed. A plain recursive copy writes each destination file incrementally,
// so an interruption leaves a TRUNCATED file; on the next launch that file
// exists, a no-clobber copy skips it, and the migration marks itself complete -
// a corrupted profile blessed as good, permanently. Staging + per-file rename
// removes the window entirely: within one volume a rename is atomic, so a
// destination file is either absent or whole.
//
// Note this PREVENTS torn files rather than repairing them. That is sufficient
// and not a gap: no released build ever used the copy-directly-into-target
// shape, so a torn file cannot already exist in the wild.
const root6 = fs.mkdtempSync(path.join(os.tmpdir(), "folia-migrate-test6-"));
const legacy6 = path.join(root6, LEGACY_NAME);
const target6 = path.join(root6, "Folia");
const staging6 = path.join(root6, ".folia-migrate-staging");
fs.mkdirSync(legacy6, { recursive: true });
fs.writeFileSync(path.join(legacy6, "window-state.json"), '{"width":1600}');
// Debris from a previous run that died mid-copy: a half-written file plus a
// file that was never in the legacy profile at all. Neither may reach the
// profile - merging debris is how an interrupted run corrupts the next one.
fs.mkdirSync(staging6, { recursive: true });
fs.writeFileSync(path.join(staging6, "window-state.json"), '{"width":TRUNCA');
fs.writeFileSync(path.join(staging6, "junk-from-dead-run.json"), "{}");

check(
  "stale staging debris really exists, so the wipe can fail",
  fs.existsSync(path.join(staging6, "junk-from-dead-run.json"))
);

run(target6);

check(
  "a stale staging area is wiped rather than merged into the profile",
  !fs.existsSync(path.join(target6, "junk-from-dead-run.json"))
);
check(
  "the profile gets the legacy content, not the half-written staging copy",
  fs.readFileSync(path.join(target6, "window-state.json"), "utf8") === '{"width":1600}'
);
check(
  "the staging area does not survive a successful migration",
  !fs.existsSync(staging6)
);

// --- case 8: files reach the profile by rename, not by copy
//
// The mechanism, not the outcome. Both a rename and a copy leave the same end
// state - and the staging area is deleted on success either way - so nothing
// observable AFTERWARDS can tell them apart. Observed through a recording `fs`
// instead. This matters because only the rename is atomic: a copy writes the
// destination incrementally, so an interruption leaves a truncated file that
// the next launch will see as "exists" and skip.
const root7 = fs.mkdtempSync(path.join(os.tmpdir(), "folia-migrate-test7-"));
const legacy7 = path.join(root7, LEGACY_NAME);
const target7 = path.join(root7, "Folia");
fs.mkdirSync(path.join(legacy7, "Local Storage"), { recursive: true });
fs.writeFileSync(path.join(legacy7, "window-state.json"), '{"width":1700}');
fs.writeFileSync(path.join(legacy7, "Local Storage", "leveldb.log"), "payload");

const spied = runSpied(target7);

check(
  "the spied migration really did migrate, so the call counts describe real work",
  fs.existsSync(path.join(target7, "Local Storage", "leveldb.log")) &&
    fs.existsSync(path.join(target7, SENTINEL))
);
check(
  "every file reaches the profile by an atomic rename",
  spied.renameSync >= 2,
  "renameSync=" + spied.renameSync + " copyFileSync=" + spied.copyFileSync
);
check(
  "no file is written into the profile by a non-atomic copy",
  spied.copyFileSync === 0,
  "copyFileSync=" + spied.copyFileSync
);

for (const dir of [root, root2, root3, root4, root5, root6, root7]) {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("\n=== " + pass + "/" + (pass + fail) + " passed ===");
process.exit(fail ? 1 : 0);
