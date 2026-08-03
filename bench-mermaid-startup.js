// Compares real app startup with the mermaid bundle eagerly loaded vs not.
//
// Methodology notes, because the first attempt produced unusable numbers:
//  - Variants are interleaved run-by-run, not in blocks, so machine drift and
//    background load hit both equally.
//  - Each run gets a fresh IN-MEMORY session partition (no `persist:` prefix).
//    Persistent partitions wrote to disk and the accumulating churn dominated
//    the signal; in-memory ones also guarantee a cold V8 code cache, which is
//    the cost a real user actually pays on launch.
//  - Reported statistic is the MINIMUM. Startup timing noise is one-sided
//    (things can only make a run slower), so the minimum is the most stable
//    estimator of true cost. Median and full sample list are printed too.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = __dirname;
const RUNS = 7;

app.on('window-all-closed', () => {}); // the benchmark destroys windows between runs

function buildVariant(name, eager) {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const PURIFY = '<script src="libs/vendor/purify.min.js"></script>';
  if (eager) {
    // index.html no longer carries the tag (PERF-03), so the "before" variant is
    // reconstructed by putting it back exactly where it used to sit.
    if (!html.includes(PURIFY)) throw new Error('purify script tag not found');
    html = html.replace(
      PURIFY,
      '<script src="libs/vendor/mermaid.min.js"></script>\n    ' + PURIFY,
    );
  }
  const out = path.join(ROOT, name);
  fs.writeFileSync(out, html, 'utf8');
  return out;
}

async function oneRun(file, tag, i) {
  const win = new BrowserWindow({
    width: 1400, height: 900, show: false,
    webPreferences: {
      nodeIntegration: true, contextIsolation: false, webSecurity: false,
      partition: `bench-${tag}-${i}-${Date.now()}`,
    },
  });
  const t0 = Date.now();
  await win.loadFile(file);
  await win.webContents.executeJavaScript(
    `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`,
  );
  const ms = Date.now() - t0;
  win.destroy();
  await sleep(400);
  return ms;
}

const min = (a) => Math.min(...a);
const med = (a) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
const fmt = (label, a) => `${label}: min ${min(a)}  median ${med(a)}   [${a.join(', ')}]`;

app.whenReady().then(async () => {
  const withM = buildVariant('bench-with.html', true);   // eager tag restored
  const withoutM = buildVariant('bench-without.html', false); // shipped lazy build

  const A = [];
  const B = [];
  // One warm-up pair, discarded: the very first window in a process pays
  // one-time GPU/compositor setup that belongs to neither variant.
  await oneRun(withM, 'warm', 0);
  await oneRun(withoutM, 'warm', 1);

  for (let i = 0; i < RUNS; i++) {
    A.push(await oneRun(withM, 'with', i));
    B.push(await oneRun(withoutM, 'without', i));
  }

  const out = [
    fmt('with mermaid   ', A),
    fmt('without mermaid', B),
    '',
    `delta (min):    ${min(A) - min(B)} ms`,
    `delta (median): ${med(A) - med(B)} ms`,
  ];
  fs.writeFileSync(path.join(ROOT, 'bench-mermaid-load.txt'), out.join('\n'), 'utf8');
  fs.unlinkSync(withM);
  fs.unlinkSync(withoutM);
  app.exit(0);
}).catch((e) => {
  fs.writeFileSync(path.join(ROOT, 'bench-mermaid-load.txt'), 'FAILED: ' + e.stack);
  app.exit(1);
});
