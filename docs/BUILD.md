# Building Folia

This guide explains how to create a standalone executable (.exe) file.

## Prerequisites

1. **Node.js** installed (https://nodejs.org/)
2. **Git Bash** or **Command Prompt** on Windows

## Step-by-Step Build Instructions

### 1. Install Dependencies

Open terminal in the project folder and run:
```bash
npm install
```

This will install all required packages including electron-builder.

If it fails while downloading Electron itself, see
"Building behind a restrictive network" below — that step reaches
`github.com` directly and is the first thing a filtered network blocks.

### 2. Build Standalone EXE

To create a **portable .exe** file (no installation required):
```bash
npm run build
```

**Wait time:** 2-5 minutes depending on your computer

### 3. Find Your EXE

After the build completes, look in the `dist/` folder:
```
dist/
├── Folia-<version>.exe    <- portable, single file
└── win-unpacked/          <- the same app, unpacked
    └── Folia.exe
```

The portable `.exe` is your **standalone executable**. The version in the
filename comes from `version` in `package.json`.

Both the portable exe and the unpacked binary take their name from
`build.productName`, so the running process appears as **`Folia`** in Task
Manager and `Get-Process`.

## Alternative Build Options

### F22 shutdown-performance acceptance gate

Run this separately on an otherwise idle Windows machine:

```bash
npm run bench:f22
```

It holds an exclusive performance lock and launches isolated Electron workers,
so it is intentionally **not** part of `npm test`. The gate checks the shutdown
path at 50KB, 500KB and 2MB across 1, 10 and 25 tabs, and then two worst cases
at 2MB x 25 tabs with **every** open document edited — once with LF line
endings and once with CRLF, which take different paths through the dirty
comparison. Every observation is judged on its raw p95; the three-decimal
figures in the output are for reading, not for gating.

Allow appreciably longer than the clean matrix alone: the all-dirty
observations rebuild and compare 50MB of document text per sample.

**Keeping the numbers.** The run deletes its working directory on the way out,
so the results have to be captured as they are produced. Every run prints one
greppable line carrying the **raw** p95 of every observation:

```
F22-RESULT-JSON {"budgetMs":16.7,"failures":0,"summary":[...]}
```

and setting `F22_RESULT_FILE` additionally writes the full record — every raw
sample, both raw and rounded statistics, the budget verdict and the all-dirty
filename oracle — to a path of your choosing, through a temporary file that is
renamed into place so a half-written record can never be read as a result:

```bash
$env:F22_RESULT_FILE = "C:\some\where\f22-run-1.json"; npm run bench:f22
```

Nothing is written unless that variable is set, and the path is yours: choose
one outside the repository so a gate run never leaves an artefact to be
committed by accident. It is written before the lock is released, so a run
stopped with Ctrl+C still leaves its partial numbers behind.

### CI revert audits

CI runs two read-only audits of the revert harness. `--anchors` is a step of
the main test job; `--expects` has its own job, because it runs the suites
again and would otherwise double the wall clock:

```bash
node scripts/prove-table-fixes.js --anchors   # the text each record perturbs
node scripts/prove-table-fixes.js --expects   # the assertions each record names
```

Neither rewrites the working tree. The harness's third mode — a bare
invocation, which applies each revert in place — **must not** run in CI or
alongside any edit; see *Parallel delivery without reducing quality* in
`docs/PLANNED-WORK.md`.

### Windows Installer (for distribution)
```bash
npm run build-installer
```
Creates: `dist/Folia-Setup-<version>.exe`

### Build Everything
```bash
npm run build-all
```
Creates both portable exe and installer.

## File Sizes

- **Portable EXE:** ~150-200 MB (includes Electron runtime)
- **Installer:** ~150-200 MB compressed

## Distribution

The portable .exe file can be:
- ✅ Copied to any Windows PC
- ✅ Run without installation
- ✅ Placed on USB drive
- ✅ Shared with colleagues
- ✅ Run from network drive

## Building behind a restrictive network

Nothing in this section is needed on a normal connection, and none of it applies
to the GitHub-hosted release runners — they reach `github.com` directly. It
matters for a clone on a corporate network where outbound egress is filtered.

**There are three independent downloads, with three separate switches.** They
fail one at a time, so fixing one does not fix the next.

### 1. The npm registry — `npm install` resolving packages

Controlled by `.npmrc` (`registry=...`). Note that this repo's committed
`package-lock.json` already pins every `resolved` URL to a public Microsoft
mirror rather than to `registry.npmjs.org`; it is publicly fetchable without
auth, and the release workflow installs through it on all three runner OSes.

### 2. The Electron binary — electron's `postinstall`

`npm install` runs `node_modules/electron/install.js`, which fetches a ~100 MB
zip through `@electron/get`. The URL is assembled as `<base><dir>/<file>`:

```
https://github.com/electron/electron/releases/download/  v43.4.1/  electron-v43.4.1-win32-x64.zip
                       ELECTRON_MIRROR                ELECTRON_CUSTOM_DIR
```

```powershell
$env:ELECTRON_MIRROR = "https://<host>/electron/"   # trailing slash required
npm install
```

- **`ELECTRON_CUSTOM_DIR` is the one that catches people out.** The directory
  segment defaults to the version *with* its leading `v` (`v43.4.1`). Most
  mirrors lay the files out without it, so they also need
  `$env:ELECTRON_CUSTOM_DIR = "{{ version }}"` — the placeholder is substituted
  with the bare version.
- **The mirror only has to serve the zip.** Checksums are read from the local
  `node_modules/electron/checksums.json`, so no `SHASUMS256.txt` is required
  unless you set `electron_use_remote_checksums`.
- **A populated cache means no network at all.** Downloads are cached in
  `%LOCALAPPDATA%\electron\Cache` (override with `electron_config_cache`), and
  `install.js` exits immediately when `node_modules/electron/dist/version`
  already matches. Copying that cache in from a machine that can reach GitHub is
  a valid unblock on its own.

### 3. The electron-builder toolset — `npm run build`

Packaging fetches its own tools (NSIS, `winCodeSign`) from a *different*
release repo, and **`ELECTRON_MIRROR` deliberately cannot redirect them** —
electron-builder pins those URLs before `@electron/get` reads the environment.
Use the separate variable:

```powershell
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://<host>/electron-builder-binaries/"
npm run build
```

Cached under `%LOCALAPPDATA%\electron-builder\Cache` (override with
`ELECTRON_BUILDER_CACHE`), so this is a first-build-only cost.

Do **not** reach for `electronDownload.strictSSL: false` to get past a
TLS-intercepting proxy. It disables certificate validation for every Electron
and tool download; electron-builder itself logs a warning saying so. Install the
proxy's CA into the trust store instead.

## Troubleshooting

**Build fails?**
- Delete `node_modules` folder
- Run `npm install` again
- Try `npm run build` again

**Build fails with `configuration.win should be one of these: null`?**
- An unknown key is present in a `build.*` section. Run `npm run test:packaging`
  — it names the offending key. See the Code Signing note above.

**Build fails with `EPERM: operation not permitted, rename ...` inside
`%LOCALAPPDATA%\electron-builder\Cache\nsis-resources-*`?**
- A lock held by antivirus or indexing, not a configuration problem. Delete the
  `electron-builder\Cache` folder and `dist/`, then rebuild.

**Missing icon?**
- Ensure `assets/logo.png` is present (regenerate with `node scripts/generate-logo.js`)

**Antivirus blocks exe?**
- This is normal for unsigned executables
- Add exception or sign the executable with a code signing certificate

**Need developer tools in an installed build?**
- `F12` opens them only when Folia runs from source. In a packaged build the
  toggle is gated, because the renderer runs with `nodeIntegration: true` and so
  the console is a Node REPL with the user's full filesystem rights — a shipped
  build should not hand that to whoever is at the keyboard on one keystroke.
- Start the installed app with `FOLIA_DEVTOOLS=1` in the environment to re-enable
  it: `$env:FOLIA_DEVTOOLS="1"; & "$env:LOCALAPPDATA\Programs\Folia\Folia.exe"`.
- Electron's default application menu is removed at startup as well. It is never
  displayed — every window already calls `setMenu(null)` — but its `View` submenu
  binds Toggle Developer Tools to `Ctrl+Shift+I`, which was measured to work on a
  window that omits that call. `test-render-security.js` asserts no application
  menu survives startup, and `test-packaging.js` asserts the `F12` gate.
- Both are interim controls. The durable fix is SEC-08 (`contextIsolation` plus a
  preload bridge), after which a console in the renderer is no longer a console
  in Node.

## Code Signing (Optional)

For production distribution, consider code signing to avoid Windows SmartScreen
warnings:

1. Purchase a code signing certificate.
2. Configure it in `package.json` under **`build.win.signtoolOptions`**:
   ```json
   "win": {
     "signtoolOptions": {
       "certificateFile": "path/to/cert.pfx",
       "certificatePassword": "..."
     }
   }
   ```
3. Prefer supplying the password from an environment variable
   (`CSC_KEY_PASSWORD`) over committing it.

> **electron-builder 26 moved these keys.** In v24 and earlier the settings
> lived directly on `build.win` (`win.sign`, `win.certificateFile`,
> `win.certificatePassword`, `win.signingHashAlgorithms`, `win.publisherName`).
> In v26 they all moved under `win.signtoolOptions`, and because every platform
> section in electron-builder's schema is `additionalProperties: false`, leaving
> an old key in place **aborts the entire build** — not just signing.
>
> The failure is easy to misread: it reports
> `configuration.win should be one of these: null`, which is a generic `anyOf`
> failure and names no key. This repo hit exactly that. `npm run test:packaging`
> now validates every `build.*` section against
> `node_modules/app-builder-lib/scheme.json` and names any rejected key, so the
> next breaking rename is caught in milliseconds instead of during a release.
>
> Azure Trusted Signing is the other option, under `win.azureSignOptions`;
> it cannot be combined with `signtoolOptions`.

## Auto-update

`build.publish` targets this fork's own GitHub releases:

```json
"publish": [{ "provider": "github", "owner": "lostinsea", "repo": "folia" }]
```

electron-builder therefore writes `app-update.yml` into the package and emits
`latest.yml` (plus `latest-linux.yml` / `latest-mac.yml`) alongside the
installers. `electron-updater` reads the former at runtime and fetches the
latter from the release assets. Verified on a real build: `app-update.yml`
resolves to `github.com/lostinsea/folia`, and until the first release
is published the check simply returns 404 and is swallowed by the existing
handler.

**It must never point at a parent repo.** `OmniCoreST/omnicore-markdown-viewer`
and `yumedzi/markdown-viewer` publish their own releases; aiming the feed at
either would let their binaries silently replace a Folia build and discard every
fix in this repository. `test-packaging.js` asserts this and covers the shapes
that make it easy to get wrong — the `"github"` provider shorthand, an object
with no `owner`/`repo`, the combined `repo: "owner/name"` form and a per-platform
`publish` block all fall back to `package.json.repository`. The fork's `version`
is independent of either parent's and is not expected to track them.

Every `build*` script passes `--publish never`. electron-builder still generates
the manifests; it just does not upload them, because uploading is the release
workflow's job (`create-release` in `.github/workflows/release.yml`, the only job
holding `contents: write`). Without the flag electron-builder's default
`onTagOrDraft` would publish from inside the build matrix as well, racing that
job with three concurrent uploads of the same tag.

Windows and macOS builds are both **unsigned**: `build.win.signtoolOptions` is
`null` and no macOS identity is configured. Measured on the published v0.1.0
installer — `Get-AuthenticodeSignature` reports `NotSigned`, despite
electron-builder logging a `signing with signtool.exe` line for every artifact,
which it prints whether or not a certificate was supplied. So SmartScreen warns
on Windows, Gatekeeper warns on macOS, and macOS auto-update will fail signature
validation until an identity is configured. Release notes must say so; a user
who is told nothing reasonably concludes the download is corrupt.

## Cutting a release

**`git push origin v0.1.0` does not start anything.** The workflow declares a
`push` trigger on `v*` tags and that trigger has never once fired on this
repository. Measured rather than assumed: two separate pushes of `v0.1.0` and a
throwaway `v0.0.0-trigger-probe` tag all completed successfully at the git
level and produced zero workflow runs, while `workflow_dispatch` through the
same credentials started a run within seconds. GitHub suppresses the delivery,
not the workflow — `actions/permissions` reports `enabled: true` and the
workflow's own state is `active`. This is fork behaviour, and its failure mode
is the worst kind: the push succeeds, nothing reports a problem, and the release
simply never appears.

Dispatch **on the tag ref**, not on a branch:

```bash
git tag -a v0.1.0 -m "Folia 0.1.0"
git push origin v0.1.0
gh workflow run release.yml --repo lostinsea/folia --ref v0.1.0
gh run watch <id> --repo lostinsea/folia --exit-status
```

The `--ref v0.1.0` is load-bearing. `create-release` is gated on
`startsWith(github.ref, 'refs/tags/')`, so a dispatch against `main` builds all
three platforms, uploads the artifacts to the run, and then publishes nothing —
a green run with no release at the end of it.

Bump `version` in **both** `package.json` and `package-lock.json` before
tagging. The workflow installs with `npm ci`, which fails outright when the two
disagree, so a bump that touched only `package.json` breaks the build it exists
to produce. `npm pkg set version=X` alone does not update the lockfile;
`npm install --package-lock-only` after it does.

After the run, verify the update manifest actually describes the artifact that
was uploaded — the two are produced by different jobs on different machines:

```bash
gh release download <tag> --pattern "latest.yml" --pattern "Folia-Setup-<v>.exe"
# the base64 sha512 in latest.yml must equal the installer's own
```

## Clean Build

To start fresh:
```bash
# Delete build artifacts
rmdir /s /q dist
rmdir /s /q node_modules

# Reinstall and build
npm install
npm run build
```
