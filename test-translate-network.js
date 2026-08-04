// Proves the translation path works end-to-end through the IPC route added for
// SEC-09: renderer -> main process -> Google -> back, with the renderer under
// `connect-src 'none'`.
//
// Deliberately NOT part of `npm test`. It needs the network and a live
// third-party API, and a suite that fails when someone is offline teaches
// people to ignore failures. The assertion suite covers the parts that can be
// tested hermetically (the handler exists, and it validates its language tag);
// this covers the part that cannot (the request is actually well-formed and the
// response is actually parsed).
//
//   npm run test:translate
//
// Expected output:  TRANSLATE-E2E OK:Bonjour le monde
const { app, BrowserWindow } = require("electron");
require("./main.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(3000);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    console.log(
      "FAIL  no window at ready - another instance is probably holding the " +
        "single-instance lock.",
    );
    return app.exit(1);
  }

  const out = await win.webContents.executeJavaScript(
    `require('electron').ipcRenderer
       .invoke('translate-text', { text: 'hello world', targetLang: 'fr' })
       .then(v => 'OK:' + v, e => 'ERR:' + (e && e.message))`,
    true,
  );
  console.log("TRANSLATE-E2E " + out);

  // Any non-empty, actually-translated result proves the round trip. The exact
  // wording is the API's business; pinning it would make this fail on their
  // next model update rather than on our regression.
  const ok = out.startsWith("OK:") && out.length > 3 && out !== "OK:hello world";
  console.log(ok ? "=== 1/1 passed ===" : "=== 0/1 passed ===");
  app.exit(ok ? 0 : 1);
});
