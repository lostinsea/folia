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
- Ensure `logo.png` is in the project root folder

**Antivirus blocks exe?**
- This is normal for unsigned executables
- Add exception or sign the executable with a code signing certificate

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
"publish": [{ "provider": "github", "owner": "lostinsea", "repo": "markdown-viewer" }]
```

electron-builder therefore writes `app-update.yml` into the package and emits
`latest.yml` (plus `latest-linux.yml` / `latest-mac.yml`) alongside the
installers. `electron-updater` reads the former at runtime and fetches the
latter from the release assets. Verified on a real build: `app-update.yml`
resolves to `github.com/lostinsea/markdown-viewer`, and until the first release
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

Windows builds are signed (`build.win.signtoolOptions`); macOS builds are not,
so macOS auto-update will fail signature validation until they are.

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
