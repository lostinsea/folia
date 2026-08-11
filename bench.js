// bench.js - repo-root entry point for the benchmark runner.
//
// This exists for one mechanical reason. Electron derives app.getAppPath() from
// the directory of the entry script, and main.js loads its window with
// loadFile("index.html"), which resolves against that path. Launching
// `electron bench/run.js` therefore looks for bench/index.html, fails with
// ERR_FILE_NOT_FOUND, and leaves a blank window in which every renderer symbol
// is undefined - the failure is silent from the main process's side, which is
// how it cost a full 900s watchdog timeout the first time.
//
// This is also why all eleven test suites sit at the repo root. The benchmark
// keeps its substance in bench/ and puts only this line at the root.
require("./bench/run.js");
