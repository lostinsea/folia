# Release Guide

This document explains how to create releases for Folia.

**Two paths can put a release on GitHub, and only one of them should.** The tag
workflow (`.github/workflows/release.yml`) builds on GitHub runners, attests
what it built, and is the supported way to publish Folia — see "Publishing a
release" below and "Build provenance" in [`BUILD.md`](BUILD.md).

`npm run release` (`scripts/release.js`) is the older local path. It builds on a
workstation and uploads with `gh`, and what it uploads carries **no** GitHub
attestation, so `gh attestation verify` fails on those files — correctly. It is
also **not** a completeness check: it publishes whatever it happens to find. It
remains useful for local packaging, rehearsing the mechanics and dry runs, but
it should not be used to publish official Folia releases.

## Publishing a release (the supported path)

The workflow path, in order. Each step is here because skipping it produces a
release that looks finished and is not.

1. Bump `version` in **both** `package.json` and `package-lock.json`
   (`npm pkg set version=X.X.X`, then `npm install --package-lock-only`),
   commit and push. `npm ci` in the workflow fails outright if the two
   disagree.
2. Tag and push the tag:
   ```bash
   git tag -a vX.X.X -m "Folia X.X.X"
   git push origin vX.X.X
   ```
3. Check whether the tag push started the release workflow. Do not dispatch a
   duplicate run. If no run exists for the exact tag and commit, dispatch
   **against the tag ref, never a branch:**
   ```bash
   gh workflow run release.yml --repo lostinsea/folia --ref vX.X.X
   ```
   `attest` and `create-release` are both gated on a tag ref, so a dispatch
   against `main` builds all three platforms and then attests and publishes
   nothing.
4. Watch the run: `gh run watch <id> --repo lostinsea/folia --exit-status`.
   The `attest` job must complete before publication — `create-release`
   declares `needs: [release, attest]`, so a failed attestation blocks the
   release rather than yielding an unattested one.
5. After publication, verify a **downloaded** artifact rather than trusting the
   run page:
   ```bash
   gh release download vX.X.X --repo lostinsea/folia \
     --pattern "Folia-Setup-X.X.X.exe"
   gh attestation verify Folia-Setup-X.X.X.exe \
     --repo lostinsea/folia \
     --signer-workflow lostinsea/folia/.github/workflows/release.yml \
     --source-ref refs/tags/vX.X.X \
     --source-digest <exact-tagged-commit>
   ```
6. Download every asset. Check sizes and SHA256 against GitHub's asset digests.
   Check every updater manifest's version, filenames, sizes and base64 SHA512
   against its downloaded target. Verify provenance for every runnable binary,
   pinned to the exact commit as well as the tag, workflow and run.
7. Inspect the actual Windows package and view its UI using an isolated profile.
   Do not install it unless installation is separately authorized. Linux/macOS
   builds and attestations do not prove live UI behavior on Windows.

**Do not patch a gap in that sequence with `npm run release`.** A locally cut
release carries no attestation, so uploading over an attested tag replaces
verifiable artifacts with unverifiable ones. If a release already exists, that
script attempts to delete and recreate it, deletes the local tag, and attempts
to delete the remote tag when `origin` matches the repository in
`package.json`. Its GitHub commands are pinned to that repository, but this
does not prevent replacement of its own releases: GitHub's immutable-releases
feature is a separate opt-in and is not adopted here.

## Prerequisites

Both paths need the GitHub CLI. The rest of this document describes the local
script, so unless noted otherwise it applies to that path only.

1. **GitHub CLI (gh)** installed and authenticated
   ```bash
   # Install (Ubuntu/Debian)
   sudo apt install gh

   # Install (Windows)
   winget install GitHub.cli

   # Authenticate
   gh auth login
   ```

   Verifying release provenance additionally needs a `gh` recent enough to have
   the `gh attestation` command group — `gh attestation verify --help` is the
   check.

2. **Node.js and npm** installed

3. **Git repository** properly configured with remote

## The local script (legacy, unattested)

> **Nothing in this section produces build provenance, and nothing in it
> guarantees a complete release.** Use it for local packaging, for rehearsing
> the mechanics with `--dry-run`, and for testing installers you build for
> yourself. Publish through the workflow above.

### Interactive run

```bash
npm run release
```

This will:
1. Check prerequisites
2. Show current version and prompt for new version (patch/minor/major/custom)
3. Ask for confirmation
4. Build for Windows, and for Linux when the host can
5. Create a GitHub release from whatever artifacts it then finds

### Specify Version Directly

```bash
npm run release -- 1.7.0
```

### Dry Run (Preview)

```bash
npm run release -- --dry-run
npm run release -- --dry-run 1.7.0
```

Changes no files and publishes nothing. It does still run the prerequisite
checks and the pre-build `npm run test:packaging`; the builds, the strict
post-build check and every `gh` release command are skipped and printed
instead.

### Skip Build (Use existing artifacts)

```bash
npm run release -- --skip-build
npm run release -- --skip-build 1.7.0
```

Skips the build step and uses existing files in `dist/` folder. Useful when you've already built the artifacts.

### Combine Options

```bash
npm run release -- --dry-run --skip-build 1.7.0
```

## What the script actually does

1. **Checks prerequisites** - `gh` installed, `gh` authenticated, and a git
   repository
2. **Version selection** - interactive menu, or the version passed as an
   argument
3. **Checks packaging and licence notices** - runs `npm run test:packaging`
   before anything is built or pushed
4. **Updates `package.json`** - if the version changed. **`package-lock.json`
   is left alone**, so the two then disagree until that is fixed by hand, and
   the workflow's `npm ci` fails on exactly that disagreement
5. **Commits and pushes the bump** - only if the version changed; commit and
   push errors are ignored, so either can fail without stopping the release
6. **Attempts the Windows build** (NSIS installer) and, where the host can, the
   **Linux** build (AppImage and `.deb`). A Windows failure aborts the run on
   WSL and native Windows but is logged and swallowed elsewhere; a Linux
   failure is always logged and swallowed. There is no macOS build in this
   script at all
7. **Re-runs `npm run test:packaging`** with `PACKAGING_STRICT=1`, which turns a
   skipped oracle into a failure. It is skipped entirely in a dry run, and
   under `--skip-build` it judges the `dist/win-unpacked` archive already on
   disk — failing rather than passing if that archive is absent or older than
   `package-lock.json`
8. **Collects artifacts** - pattern-matches `dist/`, warns about and skips
   files whose names do not contain the version being released (a substring
   check on the filename, and update manifests are exempt from it), and aborts
   only if it finds nothing at all
9. **Creates the GitHub release** - deleting and recreating an existing release
   on the same tag, then uploading what was collected, with notes derived from
   those files

## Artifacts the local script produces

A run in which both builds succeed produces these; a partial run publishes a
subset:

| File | Platform | Description |
|------|----------|-------------|
| `Folia-Setup-X.X.X.exe` | Windows | NSIS installer |
| `Folia-Setup-X.X.X.exe.blockmap` | Windows | Block map emitted alongside the installer |
| `Folia-X.X.X.AppImage` | Linux | Portable AppImage |
| `folia_X.X.X_amd64.deb` | Linux | Debian package |

**That list is not enforced.** The script's dry-run list varies only with
whether the host can build Linux; it is printed by `--dry-run` and compared
against nothing. A real run globs `dist/` instead,
keeps whatever matches its patterns and carries the version being released as a
substring of the filename, and fails only when it finds nothing whatsoever. So a
release can go out with the Windows installer alone — a Linux build that failed
is logged and skipped, not treated as an error — and nothing afterwards reports
the release as incomplete. Check what was uploaded before announcing it.

The workflow publishes a wider set — it also builds the Windows portable `.exe`
and the macOS `.dmg`, on runners of the matching OS — and it attests the
Windows `.exe` files, the `.dmg`, the `.AppImage` and the `.deb`. It also checks
each leg's output before uploading it and fails the run if a required file is
missing, rather than publishing what survived. See "Build provenance" in
[`BUILD.md`](BUILD.md).

**Whatever `latest*.yml` files are sitting in `dist/` are uploaded.** They are
the update manifests `electron-updater` polls; without the one for a platform in
the release assets, an installed build on it cannot see the release. `latest.yml`
is written by the Windows build and `latest-linux.yml` by the Linux build, so a
skipped build produces no fresh manifest for its platform — and because
manifests are exempt from the version filter, one left over from an earlier
build is uploaded rather than rejected. See `BUILD.md`, "Auto-update".

## Platform Notes

Which host you run the local script on decides which artifacts exist at all,
and therefore what a "successful" run publishes.

### Running from WSL (widest local coverage)
- Windows build uses PowerShell automatically
- Linux build runs natively
- Both platforms built in single run

### Running from Native Windows
- Windows build runs natively
- Linux build skipped (use WSL for Linux builds)

### Running from Native Linux
- Linux build runs natively
- Windows build requires Wine (may not work)

## Troubleshooting

### "GitHub CLI is not installed"
Install gh from https://cli.github.com/

### "GitHub CLI is not authenticated"
Run `gh auth login` and follow the prompts

### "No artifacts found in dist/"
Run without `--skip-build` or build manually first:
```bash
npm run build-installer  # Windows
npm run build-linux      # Linux
```

### Build fails on WSL
Ensure you have the required dependencies:
```bash
sudo apt update
sudo apt install -y libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils libatspi2.0-0 libsecret-1-0
```
