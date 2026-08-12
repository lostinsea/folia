#!/usr/bin/env node

/**
 * Release Script for Folia
 *
 * This script automates the release process:
 * 1. Prompts for version
 * 2. Builds for Windows and Linux
 * 3. Creates a GitHub release
 * 4. Uploads all build artifacts to that release
 *
 * Note: installed builds auto-update from this fork's own GitHub releases
 * (build.publish - see docs/BUILD.md), so the latest*.yml manifests must be
 * uploaded alongside the installers or no client can see the release.
 * The portable .exe never self-updates.
 *
 * Prerequisites:
 * - GitHub CLI (gh) installed and authenticated
 * - Node.js and npm
 *
 * Usage:
 *   npm run release              # Interactive - asks for version
 *   npm run release -- 1.7.0     # Use specified version
 *   npm run release -- --skip-build  # Skip build, just create release
 *   npm run release -- --dry-run     # Simulate release without executing
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT_DIR = path.join(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const DIST_DIR = path.join(ROOT_DIR, 'dist');

// The real release path uses `gh`, which targets whatever repo the checkout
// points at. The dry-run path used to print a hard-coded upstream URL, so a
// dry run reported that it would publish to the parent project. Derive it from
// package.json instead so the two can never disagree.
function repoSlug() {
  try {
    const repo = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')).repository;
    const url = typeof repo === 'string' ? repo : repo && repo.url;
    const m = url && url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return 'unknown/unknown';
}

// `gh` calls are pinned with --repo, but plain `git` calls are not: `git push
// origin :refs/tags/X` deletes a tag on whatever `origin` happens to point at.
// That is the same hazard the --repo pin exists for - this checkout carries
// three remotes and two of them are other people's repositories - so the
// remote is verified against the same source of truth rather than trusted by
// name. Returns the remote's slug, or null if it cannot be determined.
function remoteSlug(remote) {
  try {
    const url = execSync(`git remote get-url ${remote}`, {
      cwd: ROOT_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = colors.reset) {
  console.log(`${color}${message}${colors.reset}`);
}

function logStep(step, message) {
  log(`\n[${'='.repeat(50)}]`, colors.cyan);
  log(`[Step ${step}] ${message}`, colors.bright + colors.cyan);
  log(`[${'='.repeat(50)}]`, colors.cyan);
}

function logSuccess(message) {
  log(`✓ ${message}`, colors.green);
}

function logError(message) {
  log(`✗ ${message}`, colors.red);
}

function logInfo(message) {
  log(`ℹ ${message}`, colors.blue);
}

function logWarning(message) {
  log(`⚠ ${message}`, colors.yellow);
}

function logDryRun(message) {
  log(`[DRY-RUN] ${message}`, colors.yellow);
}

// Global dry-run flag
let dryRun = false;

function exec(command, options = {}) {
  if (dryRun && !options.allowInDryRun) {
    logDryRun(`Would run: ${command}`);
    return options.dryRunReturn || '';
  }
  logInfo(`Running: ${command}`);
  try {
    const result = execSync(command, {
      cwd: ROOT_DIR,
      stdio: options.silent ? 'pipe' : 'inherit',
      encoding: 'utf8',
      ...options
    });
    return result;
  } catch (error) {
    if (!options.ignoreError) {
      logError(`Command failed: ${command}`);
      throw error;
    }
    return null;
  }
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
}

function writePackageJson(pkg) {
  if (dryRun) {
    logDryRun(`Would update package.json with version ${pkg.version}`);
    return;
  }
  fs.writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + '\n');
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function askForVersion(currentVersion) {
  log('\n📦 Version Selection\n', colors.bright + colors.yellow);
  log(`Current version: ${currentVersion}`, colors.cyan);

  const [major, minor, patch] = currentVersion.split('.').map(Number);
  const suggestions = {
    1: `${major}.${minor}.${patch + 1}`,  // patch
    2: `${major}.${minor + 1}.0`,          // minor
    3: `${major + 1}.0.0`                  // major
  };

  log('\nVersion options:', colors.yellow);
  log(`  1) ${suggestions[1]} (patch)`, colors.reset);
  log(`  2) ${suggestions[2]} (minor)`, colors.reset);
  log(`  3) ${suggestions[3]} (major)`, colors.reset);
  log(`  4) Keep current (${currentVersion})`, colors.reset);
  log(`  5) Enter custom version`, colors.reset);

  const choice = await prompt('\nSelect option (1-5): ');

  switch (choice) {
    case '1':
      return suggestions[1];
    case '2':
      return suggestions[2];
    case '3':
      return suggestions[3];
    case '4':
      return currentVersion;
    case '5':
      const custom = await prompt('Enter version (e.g., 1.7.0): ');
      if (!/^\d+\.\d+\.\d+$/.test(custom)) {
        logError('Invalid version format. Use semver (e.g., 1.7.0)');
        process.exit(1);
      }
      return custom;
    default:
      logError('Invalid option');
      process.exit(1);
  }
}

async function confirmRelease(version) {
  if (dryRun) {
    log(`\n⚠️  DRY-RUN: Would release version ${version}`, colors.yellow);
    return;
  }
  log(`\n⚠️  You are about to release version ${version}`, colors.yellow);
  const confirm = await prompt('Continue? (y/n): ');
  if (confirm.toLowerCase() !== 'y') {
    log('Release cancelled.', colors.yellow);
    process.exit(0);
  }
}

function updateVersion(version) {
  const pkg = readPackageJson();
  if (pkg.version !== version) {
    pkg.version = version;
    writePackageJson(pkg);
    logSuccess(`Version updated to ${version}`);
    return true;
  }
  return false;
}

function checkPrerequisites() {
  logStep(1, 'Checking prerequisites');

  // Check GitHub CLI
  try {
    exec('gh --version', { silent: true, allowInDryRun: true });
    logSuccess('GitHub CLI (gh) is installed');
  } catch {
    logError('GitHub CLI (gh) is not installed');
    logInfo('Install it from: https://cli.github.com/');
    process.exit(1);
  }

  // Check gh auth status
  try {
    exec('gh auth status', { silent: true, allowInDryRun: true });
    logSuccess('GitHub CLI is authenticated');
  } catch {
    logError('GitHub CLI is not authenticated');
    logInfo('Run: gh auth login');
    process.exit(1);
  }

  // Check if we're in a git repo
  try {
    exec('git rev-parse --git-dir', { silent: true, allowInDryRun: true });
    logSuccess('Git repository detected');
  } catch {
    logError('Not a git repository');
    process.exit(1);
  }
}

function isWSL() {
  try {
    const release = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
    return release.includes('microsoft') || release.includes('wsl');
  } catch {
    return false;
  }
}

function willBuildLinux() {
  // Native Windows cannot produce Linux artifacts without WSL. This is the one
  // source of truth for that fact: the dry run, the artifact list and the
  // release notes all consult it, so they cannot drift apart and promise
  // downloads the real run never produces.
  return isWSL() || process.platform !== 'win32';
}

function buildWindows() {
  logStep(2, 'Building for Windows');

  if (dryRun) {
    if (isWSL()) {
      logDryRun('Would run Windows build via PowerShell (WSL detected)');
    } else if (process.platform === 'win32') {
      logDryRun('Would run Windows build (native Windows)');
    } else {
      logDryRun('Would attempt Windows build (requires Wine)');
    }
    return;
  }

  try {
    if (isWSL()) {
      // Running in WSL - use PowerShell for Windows build
      logInfo('Detected WSL environment, using PowerShell');
      exec('powershell.exe -Command "npm run build-installer"', { timeout: 600000 });
    } else if (process.platform === 'win32') {
      // Native Windows
      exec('npm run build-installer', { timeout: 600000 });
    } else {
      // Native Linux/macOS - need Wine for Windows builds
      logInfo('Attempting Windows build (requires Wine on Linux)');
      exec('npm run build-installer', { timeout: 600000 });
    }
    logSuccess('Windows build completed');
  } catch (error) {
    if (process.platform !== 'win32' && !isWSL()) {
      logInfo('Windows build skipped (not on Windows/WSL)');
    } else {
      logError('Windows build failed');
      throw error;
    }
  }
}

function buildLinux() {
  logStep(3, 'Building for Linux');

  if (dryRun) {
    if (willBuildLinux()) {
      logDryRun('Would run Linux build');
    } else {
      logDryRun('Would skip Linux build (native Windows without WSL)');
    }
    return;
  }

  if (!willBuildLinux()) {
    logInfo('Linux build skipped (run from WSL or Linux for Linux builds)');
    return;
  }

  try {
    exec('npm run build-linux', { timeout: 600000 });
    logSuccess('Linux build completed');
  } catch (error) {
    logInfo('Linux build failed or skipped');
  }
}

function getArtifacts(version) {
  logStep(4, 'Collecting build artifacts');

  if (dryRun) {
    // Must match what electron-builder actually emits. `build.publish` targets
    // this fork's GitHub releases, so the update manifests ARE written and
    // have to be listed: a dry run that disagrees with the real run is worse
    // than no dry run at all, and this list was wrong in both directions at
    // different times - it once promised manifests a publish-less build could
    // never produce, and would now omit manifests the release must upload or
    // no installed build ever sees the release.
    const expectedArtifacts = [
      `Folia-Setup-${version}.exe`,
      `Folia-Setup-${version}.exe.blockmap`,
      'latest.yml'
    ];
    // Only list what this host can actually produce. Listing the Linux
    // artifacts on native Windows made the dry run describe a release that the
    // real run cannot assemble - the same class of lie as the update manifests
    // above.
    if (willBuildLinux()) {
      expectedArtifacts.push(`Folia-${version}.AppImage`);
      expectedArtifacts.push(`folia_${version}_amd64.deb`);
      expectedArtifacts.push('latest-linux.yml');
    }
    logDryRun('Expected artifacts:');
    expectedArtifacts.forEach(a => logDryRun(`  - ${a}`));
    return expectedArtifacts.map(a => path.join(DIST_DIR, a));
  }

  const artifacts = [];
  const stale = [];

  if (!fs.existsSync(DIST_DIR)) {
    logError('dist/ directory not found. Run build first.');
    process.exit(1);
  }

  const files = fs.readdirSync(DIST_DIR);

  // Find relevant files. The update manifests are what make an installed build
  // able to see this release at all, so they are uploaded alongside the
  // installers rather than treated as build debris.
  const patterns = [
    /Setup.*\.exe$/i,
    /\.AppImage$/i,
    /\.deb$/i,
    /^latest.*\.yml$/i,
    /\.blockmap$/i
  ];

  for (const file of files) {
    for (const pattern of patterns) {
      if (pattern.test(file)) {
        const filePath = path.join(DIST_DIR, file);
        if (fs.statSync(filePath).isFile()) {
          // dist/ is not cleaned between builds, so a previous version's
          // installer - or a Linux artifact left over from a WSL run - is still
          // sitting there and matches these patterns exactly. Uploading it
          // attaches a differently-versioned binary to this release under a
          // name that looks right. electron-builder puts the version in every
          // artifact filename except the update manifests, which are rewritten
          // on every publishing build.
          if (!file.includes(version) && !/^latest.*\.yml$/i.test(file)) {
            stale.push(file);
          } else {
            artifacts.push(filePath);
            logSuccess(`Found: ${file}`);
          }
        }
        break;
      }
    }
  }

  if (stale.length > 0) {
    logWarning(`Ignoring ${stale.length} artifact(s) from another version: ${stale.join(', ')}`);
  }

  if (artifacts.length === 0) {
    logError('No artifacts found in dist/ directory');
    process.exit(1);
  }

  logInfo(`Total artifacts: ${artifacts.length}`);
  return artifacts;
}

function createGitHubRelease(version, artifacts) {
  logStep(5, 'Creating GitHub release');

  const tag = `v${version}`;
  const title = `v${version}`;

  // The Downloads section is derived from the artifacts actually collected,
  // not from a fixed list. A native-Windows release has no Linux build, and a
  // Linux build that failed leaves nothing to link to either - in both cases a
  // hardcoded list published dead download instructions naming files that were
  // never uploaded.
  const names = artifacts.map(a => path.basename(a));
  const downloads = [];
  const setup = names.find(n => /Setup.*\.exe$/i.test(n));
  const appImage = names.find(n => /\.AppImage$/i.test(n));
  const deb = names.find(n => /\.deb$/i.test(n));
  if (setup) downloads.push(`- **Windows**: Download \`${setup}\``);
  if (appImage) downloads.push(`- **Linux AppImage**: Download \`${appImage}\``);
  if (deb) downloads.push(`- **Linux DEB**: Download \`${deb}\``);

  const runStep = appImage
    ? '2. Run the installer (Windows) or make executable and run (Linux AppImage)'
    : '2. Run the installer';

  // Release notes describe the update path the build actually has. This block
  // was previously the opposite claim ("Folia does not auto-update"), correct
  // while `build.publish` was null; it now targets this fork's own releases, so
  // an installed NSIS build really does find this release on its own. The
  // portable .exe genuinely does not - electron-updater cannot replace a
  // running single-file executable, which is why main.js carries a separate
  // `isPortable` path - so it is called out rather than glossed over.
  const releaseNotes = `## Folia v${version}

### Downloads
${downloads.join('\n')}

### Updating
Installed builds check for updates automatically and will offer this version.
You can also check on demand from the Help menu. The portable .exe does not
self-update - download it again to upgrade. Settings, recent files and open
tabs are preserved either way.

### Installation
1. Download the appropriate file for your OS
${runStep}
`;

  if (dryRun) {
    logDryRun(`Would check if release ${tag} exists`);
    logDryRun(`Would create release with tag: ${tag}`);
    logDryRun(`Would upload ${artifacts.length} artifacts`);
    logDryRun('Release notes would be:');
    releaseNotes.split('\n').forEach(line => logDryRun(`  ${line}`));
    return `https://github.com/${repoSlug()}/releases/tag/${tag}`;
  }

  // Every `gh` call is pinned to the repository named in package.json.
  //
  // Without --repo, `gh` resolves the target from the git remotes, and this
  // checkout has three: origin (this fork), the parent it was forked from, and
  // the original vendor's repository. Measured here, a bare `gh repo view`
  // resolved to the VENDOR's repository, not ours. Since the block below runs
  // `gh release delete --yes`, an unpinned call could destroy releases on
  // somebody else's project. repoSlug() was already used for the dry-run URL;
  // the live calls have to agree with it.
  const repo = repoSlug();
  if (repo === "unknown/unknown") {
    logError("Cannot determine the target repository from package.json.");
    logError("Refusing to run gh release commands that could target the wrong repo.");
    process.exit(1);
  }
  const ghRepo = `--repo ${repo}`;

  // Check if release already exists
  try {
    exec(`gh release view ${tag} ${ghRepo}`, { silent: true });
    logInfo(`Release ${tag} already exists, deleting...`);
    exec(`gh release delete ${tag} ${ghRepo} --yes`, { ignoreError: true });
    exec(`git tag -d ${tag}`, { ignoreError: true, silent: true });
    // Deleting the REMOTE tag is the one destructive git operation here, and
    // `origin` is not guaranteed to be the repo package.json names. Verified
    // against repoSlug() rather than assumed, and skipped loudly on a
    // mismatch: silently deleting a tag on somebody else's repository is
    // exactly the failure the --repo pin above was added to prevent.
    const originSlug = remoteSlug('origin');
    if (originSlug && originSlug.toLowerCase() === repo.toLowerCase()) {
      exec(`git push origin :refs/tags/${tag}`, { ignoreError: true, silent: true });
    } else {
      logWarning(
        `Skipping remote tag delete: origin is ${originSlug || 'unresolvable'}, ` +
          `but package.json names ${repo}. Delete the tag manually if needed.`,
      );
    }
  } catch {
    // Release doesn't exist, that's fine
  }

  // Write release notes to temp file
  const notesPath = path.join(ROOT_DIR, '.release-notes.md');
  fs.writeFileSync(notesPath, releaseNotes);

  // Create the release
  const artifactArgs = artifacts.map(a => `"${a}"`).join(' ');
  exec(`gh release create ${tag} ${ghRepo} --title "${title}" --notes-file "${notesPath}" ${artifactArgs}`);

  // Clean up
  fs.unlinkSync(notesPath);

  logSuccess(`GitHub release ${tag} created successfully!`);

  // Get release URL
  const releaseUrl = exec(`gh release view ${tag} ${ghRepo} --json url --jq .url`, { silent: true }).trim();
  logInfo(`Release URL: ${releaseUrl}`);

  return releaseUrl;
}

function commitVersionBump(version) {
  logInfo('Committing version bump...');
  exec(`git add package.json`);
  exec(`git commit -m "Bump version to ${version}"`, { ignoreError: true });
  exec(`git push`, { ignoreError: true });
  logSuccess('Version bump committed and pushed');
}

async function main() {
  const args = process.argv.slice(2);
  const skipBuild = args.includes('--skip-build');
  dryRun = args.includes('--dry-run');
  const versionArg = args.find(a => /^\d+\.\d+\.\d+$/.test(a));

  log('\n🚀 Folia Release Script\n', colors.bright + colors.cyan);

  if (dryRun) {
    log('⚠️  DRY-RUN MODE - No changes will be made\n', colors.yellow);
  }

  // Check prerequisites
  checkPrerequisites();

  // Get current version
  const currentVersion = readPackageJson().version;

  // Determine version
  let version;
  if (versionArg) {
    version = versionArg;
    logInfo(`Using specified version: ${version}`);
  } else {
    version = await askForVersion(currentVersion);
  }

  // Confirm
  await confirmRelease(version);

  // Licence compliance and packaging, BEFORE the version bump is committed and
  // pushed. The notices are generated from package-lock.json, so a stale or
  // incomplete THIRD-PARTY-NOTICES.md is invisible until something checks it -
  // and this script previously went straight from confirmation to build, which
  // meant a hand-driven release could publish binaries whose notices no oracle
  // had ever consulted. Failing here costs the operator a re-run; failing to
  // check ships a licence breach.
  //
  // Runs in a dry run too, like the other read-only prerequisite checks above:
  // a dry run that reports "would release" while the notices are stale is
  // exactly the reassurance nobody should be given.
  logInfo('Checking packaging and licence notices...');
  exec('npm run test:packaging', { allowInDryRun: true });
  logSuccess('Packaging and licence notices OK');

  // Update version in package.json if needed
  const versionChanged = updateVersion(version);
  if (versionChanged) {
    commitVersionBump(version);
  }

  // Build
  if (!skipBuild) {
    buildWindows();
    buildLinux();
  } else {
    logInfo('Skipping build (--skip-build flag)');
  }

  // The check above runs BEFORE the build, where the oracles that read the
  // built app.asar have nothing to read and therefore skip() themselves. That
  // verifies the notices against package-lock.json but says nothing about the
  // archive that is one step away from being uploaded. PACKAGING_STRICT=1
  // turns any skipped oracle into a failure, so this second run either
  // inspects the real artifact or refuses to continue.
  //
  // It runs on the --skip-build path too, and deliberately so: those artifacts
  // are the least verified of all, having been built at some unknown earlier
  // point. If the version bump has since rewritten package-lock.json the asar
  // is genuinely stale, the oracles skip, and strict mode says so.
  //
  // NOT allowInDryRun, unlike the pre-build check: a dry run does not build,
  // so demanding a fresh asar there would fail on the absence of work the dry
  // run was never going to do. Nothing is published in a dry run either.
  //
  // env must spread process.env - execSync replaces the child environment
  // wholesale when `env` is given, so PATH and npm's own variables would
  // otherwise be blanked.
  logInfo('Verifying the built artifacts against the licence notices...');
  exec('npm run test:packaging', {
    env: { ...process.env, PACKAGING_STRICT: '1' }
  });
  logSuccess('Built artifacts match the licence notices');

  // Collect artifacts
  const artifacts = getArtifacts(version);

  // Create GitHub release
  const releaseUrl = createGitHubRelease(version, artifacts);

  // Done!
  log('\n' + '='.repeat(60), dryRun ? colors.yellow : colors.green);
  if (dryRun) {
    log('🔍 DRY-RUN COMPLETED - No changes were made', colors.bright + colors.yellow);
  } else {
    log('🎉 Release completed successfully!', colors.bright + colors.green);
  }
  log('='.repeat(60), dryRun ? colors.yellow : colors.green);
  log(`\nVersion: ${version}`, colors.cyan);
  log(`Release: ${releaseUrl}`, colors.cyan);
  log(`Artifacts: ${artifacts.length} files ${dryRun ? 'would be' : ''} uploaded\n`, colors.cyan);

  if (dryRun) {
    log('Run without --dry-run to execute the release.\n', colors.yellow);
  }
}

main().catch(error => {
  logError(`Release failed: ${error.message}`);
  process.exit(1);
});
