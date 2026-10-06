#!/bin/bash
# =============================================================================
# post-upstream-merge.sh
#
# Run this after merging upstream changes to re-apply our customizations
# that may have been overwritten.
#
# Usage:
#   ./scripts/post-upstream-merge.sh
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."

# Every `node -e` below reads ./package.json relatively, and `npm install` in
# step 6 installs into the CWD. Both were silently relying on the script being
# invoked from the repo root. Anchor the CWD instead - note that $ROOT is a
# Git Bash path (/c/repos/...) which bash resolves but native Windows node does
# NOT, so passing $ROOT into node makes it throw MODULE_NOT_FOUND; combined with
# a `2>/dev/null` that turns an assertion into a silent pass. Relative paths
# from a known CWD are the form that works on both.
cd "$ROOT"

echo "=== Applying post-merge customizations ==="

# -----------------------------------------------------------------------------
# 1. Electron version override
#    Upstream uses ^27, we need at least ^37 for the macOS _cornerMask CPU fix
#    (https://github.com/electron/electron/pull/48376), and ^41 to clear the
#    advisories that affect every Electron before 41.7.1.
#
#    Pinned to ^43, the current line. Electron 43+ needs Node >= 22.12 (see
#    .npmrc for why); the repo pins that in .nvmrc and enforces it via
#    engine-strict, so this pin and the Node pin must be raised together.
# -----------------------------------------------------------------------------
echo ""
echo "1. Pinning Electron to ^43..."
cd "$ROOT"
npm pkg set devDependencies.electron="^43.4.1"
echo "   ✓ package.json updated"

# -----------------------------------------------------------------------------
# 2. Ensure custom overlay files are referenced in index.html
# -----------------------------------------------------------------------------
echo ""
echo "2. Checking index.html references..."

check_line() {
  local file="$1"
  local pattern="$2"
  local label="$3"
  if grep -q "$pattern" "$file"; then
    echo "   ✓ $label already present"
  else
    echo "   ✗ MISSING: $label"
    echo "     → Add manually to index.html: $pattern"
    MISSING_REFS=1
  fi
}

MISSING_REFS=0
check_line "$ROOT/src/index.html" 'custom-styles.css'      '<link rel="stylesheet" href="custom-styles.css">'
check_line "$ROOT/src/index.html" 'custom-tabs.js'         '<script src="custom-tabs.js"></script>'
check_line "$ROOT/src/index.html" 'custom-performance.js'  '<script src="custom-performance.js"></script>'
check_line "$ROOT/src/index.html" 'custom-theme.js'        '<script src="custom-theme.js"></script>'
check_line "$ROOT/src/index.html" 'tabsContainer'          '<div id="tabsContainer" ...> - must be just before <div class="main-content">'
check_line "$ROOT/src/index.html" '<title>Folia</title>'  '<title>Folia</title>'

# There was an `app-title` check here, and it had rotted into the DIRECT
# OPPOSITE of what the rest of the repo asserts. The header was deliberately
# redesigned down to the hamburger alone (see the comment at the top of
# index.html: "there is no logo, product name or file-path row any more"), and
# three separate oracles now pin that ABSENCE - test-packaging.js checks that
# neither `class="app-title"` nor a `.app-title` rule comes back, and
# test-tab-refresh.js asserts appTitle === false and logoLink === false in the
# live DOM. This script was still telling the maintainer to re-add a
# `<span class="app-title">` inside a `#logoLink` that no longer exists either.
# Following that instruction would have made the test suite fail immediately.
#
# Product NAMING is still pinned, so nothing was lost by deleting it: the
# `<title>Folia</title>` check above covers the window title, and section 4
# below covers the BrowserWindow title in main.js.
#
# The general defect - a check in this script that has quietly stopped
# describing the tree - is now caught by test-packaging.js, which parses every
# check_line/check_html_script/check_html_absent/check_build_file call here and
# asserts each one still agrees with the file it names. See R514.

if [ "$MISSING_REFS" -eq 1 ]; then
  echo ""
  echo "   ⚠ Some custom references are missing from index.html."
  echo "     See docs/CUSTOMIZATIONS.md for where to add them."
  echo "     KEY POINTS:"
  echo "       - tabsContainer div must be added just before <div class=\"main-content\">"
  echo "       - <title> must say 'Folia' - a merge may reset it to the vendor name"
fi

# -----------------------------------------------------------------------------
# 3. Ensure custom files are in package.json build list
# -----------------------------------------------------------------------------
echo ""
echo "3. Checking package.json build files list..."

check_build_file() {
  local filename="$1"
  if node -e "
    const pkg = require('./package.json');
    const files = pkg.build && pkg.build.files || [];
    let found = false;
    for (const entry of files) {
      if (typeof entry !== 'string') continue;
      const excluded = entry.startsWith('!');
      const pattern = (excluded ? entry.slice(1) : entry).replace(/\\\\/g, '/');
      if (pattern.includes('$filename')) found = !excluded;
    }
    process.exit(found ? 0 : 1);
  " 2>/dev/null; then
    echo "   ✓ $filename present in build.files"
  else
    echo "   ✗ MISSING: $filename not in package.json build.files"
    MISSING_BUILD=1
  fi
}

MISSING_BUILD=0
check_build_file "custom-styles.css"
check_build_file "custom-tabs.js"
check_build_file "custom-performance.js"
check_build_file "custom-theme.js"
check_build_file "app-icon.png"

if [ "$MISSING_BUILD" -eq 1 ]; then
  echo ""
  echo "   ⚠ Some files are missing from package.json build.files."
  echo "     Add them inside the build.files array in package.json."
fi

# -----------------------------------------------------------------------------
# 4. Ensure main.js has performance fixes and correct branding
# -----------------------------------------------------------------------------
echo ""
echo "4. Checking main.js..."
if grep -q 'backgroundThrottling.*true' "$ROOT/src/main.js"; then
  echo "   ✓ backgroundThrottling: true is present"
else
  echo "   ✗ MISSING: backgroundThrottling: true not found in main.js"
  echo "     → Add 'backgroundThrottling: true' to webPreferences in new BrowserWindow()"
fi

if grep -q "window-visibility-changed" "$ROOT/src/main.js"; then
  echo "   ✓ window-visibility-changed IPC events present"
else
  echo "   ✗ MISSING: window-visibility-changed IPC not found in main.js"
  echo "     → Add mainWindow.on('hide'/'show'/'minimize'/'restore') IPC sends"
fi

if grep -q "window-state.json\|loadWindowState\|saveWindowState" "$ROOT/src/main.js"; then
  echo "   ✓ Window state persistence (loadWindowState/saveWindowState) present"
else
  echo "   ✗ MISSING: window state persistence not found in main.js"
  echo "     → Add loadWindowState/saveWindowState functions and wire into createWindow()"
  echo "     → See docs/CUSTOMIZATIONS.md section 'Window state persistence'"
fi

if grep -q "app\.on.*open-file" "$ROOT/src/main.js"; then
  echo "   ✓ macOS open-file event handler present"
else
  echo "   ✗ MISSING: app.on('open-file') handler not found in main.js"
  echo "     → Add open-file handler before app.whenReady() so double-clicking .md files works"
fi

if grep -q "title:.*Folia" "$ROOT/src/main.js"; then
  echo "   ✓ BrowserWindow title is 'Folia'"
else
  echo "   ✗ WRONG TITLE: main.js BrowserWindow title should be 'Folia'"
  echo "     → Set title: 'Folia' in new BrowserWindow()"
fi

if grep -q "app-icon" "$ROOT/src/main.js"; then
  echo "   ✓ BrowserWindow / dock icon uses app-icon.png"
else
  echo "   ✗ WRONG ICON in main.js: icon references should use 'app-icon.png'"
  echo "     → Replace all 'logo.ico' with 'app-icon.png' in BrowserWindow options"
  echo "     → Ensure app.dock.setIcon uses 'app-icon.png' (macOS dev mode)"
fi

if grep -q "app-icon" "$ROOT/package.json"; then
  echo "   ✓ package.json build icons use app-icon.png"
else
  echo "   ✗ WRONG ICON in package.json: build.mac.icon and build.linux.icon should be 'app-icon.png'"
  echo "     → Set mac.icon and linux.icon to 'app-icon.png' in the build section"
fi

# -----------------------------------------------------------------------------
# 5. Ensure renderer.js exposes window.* exports for custom overlay modules
#    (custom-tabs.js and custom-performance.js depend on these)
# -----------------------------------------------------------------------------
echo ""
echo "5. Checking renderer.js window exports..."

check_renderer() {
  local symbol="$1"
  local hint="$2"
  if grep -q "$symbol" "$ROOT/src/renderer.js"; then
    echo "   ✓ $symbol exported"
  else
    echo "   ✗ MISSING: $symbol not found in renderer.js"
    echo "     → $hint"
    MISSING_RENDERER=1
  fi
}

MISSING_RENDERER=0
check_renderer "window\.renderMarkdown"    "Append 'window.renderMarkdown = renderMarkdown;' at end of renderer.js"
check_renderer "window\.fs"               "Append 'window.fs = fs;' at end of renderer.js"
check_renderer "window\.ipcRenderer"      "Append 'window.ipcRenderer = ipcRenderer;' at end of renderer.js"
check_renderer "window\.updateFileInfo"   "Append 'window.updateFileInfo = updateFileInfo;' at end of renderer.js"
check_renderer "Object.defineProperty.*currentFilePath" \
               "Append Object.defineProperty getter/setter for currentFilePath at end of renderer.js"
check_renderer "Object.defineProperty.*originalMarkdown" \
               "Append Object.defineProperty getter/setter for originalMarkdown at end of renderer.js"

if [ "$MISSING_RENDERER" -eq 1 ]; then
  echo ""
  echo "   ⚠ renderer.js is missing window exports — custom tabs/performance overlays will break."
  echo "     See docs/CUSTOMIZATIONS.md section 'renderer.js exports' for the full block to append."
fi

# -----------------------------------------------------------------------------
# 6. Reinstall dependencies with updated Electron version
# -----------------------------------------------------------------------------
echo ""
echo "6. Running npm install to apply Electron upgrade..."
npm install
echo "   ✓ Dependencies installed"

# -----------------------------------------------------------------------------
# 7. Verify custom overlay scripts are loaded in index.html
# -----------------------------------------------------------------------------
echo ""
echo "7. Checking index.html loads all custom overlay scripts..."

check_html_script() {
  local script="$1"
  if grep -q "src=\"$script\"" "$ROOT/src/index.html"; then
    echo "   ✓ $script present"
  else
    echo "   ✗ MISSING: $script not found in index.html"
    echo "     → Add '<script src=\"$script\"></script>' before </body>"
  fi
}

check_html_script "custom-collapse.js"
check_html_script "custom-tabs.js"
check_html_script "custom-theme.js"
check_html_script "custom-performance.js"
check_html_script "utils.js"
check_html_script "mermaid-config.js"
check_html_script "context-menu-utils.js"
check_html_script "file-helpers-core.js"
check_html_script "emoji-map.js"
check_html_script "emoji-parser.js"

if node -e "
  const fs = require('fs');
  const html = fs.readFileSync('src/index.html', 'utf8');
  const emojiMap = '<script src=\"emoji-map.js\"></script>';
  const emojiParser = '<script src=\"emoji-parser.js\"></script>';
  const utils = '<script src=\"utils.js\"></script>';
  const mermaidConfig = '<script src=\"mermaid-config.js\"></script>';
  const contextMenu = '<script src=\"context-menu-utils.js\"></script>';
  const fileHelpersCore = '<script src=\"file-helpers-core.js\"></script>';
  const renderer = '<script src=\"renderer.js\"></script>';
  const customTabs = '<script src=\"custom-tabs.js\"></script>';
  const emojiMapAt = html.indexOf(emojiMap);
  const emojiParserAt = html.indexOf(emojiParser);
  const utilsAt = html.indexOf(utils);
  const mermaidConfigAt = html.indexOf(mermaidConfig);
  const contextMenuAt = html.indexOf(contextMenu);
  const fileHelpersCoreAt = html.indexOf(fileHelpersCore);
  const rendererAt = html.indexOf(renderer);
  const customTabsAt = html.indexOf(customTabs);
  process.exit(
    emojiMapAt >= 0 &&
      emojiParserAt > emojiMapAt &&
      utilsAt > emojiParserAt &&
      rendererAt > emojiParserAt &&
      html.indexOf(emojiMap, emojiMapAt + emojiMap.length) === -1 &&
      html.indexOf(emojiParser, emojiParserAt + emojiParser.length) === -1 &&
      html.indexOf(renderer, rendererAt + renderer.length) === -1 &&
      utilsAt >= 0 &&
      mermaidConfigAt > utilsAt &&
      contextMenuAt > mermaidConfigAt &&
      fileHelpersCoreAt > contextMenuAt &&
      rendererAt > fileHelpersCoreAt &&
      rendererAt > contextMenuAt &&
      customTabsAt > contextMenuAt &&
      customTabsAt > fileHelpersCoreAt &&
      customTabsAt > rendererAt &&
      html.indexOf(mermaidConfig, mermaidConfigAt + mermaidConfig.length) === -1 &&
      html.indexOf(contextMenu, contextMenuAt + contextMenu.length) === -1 &&
      html.indexOf(fileHelpersCore, fileHelpersCoreAt + fileHelpersCore.length) === -1
      ? 0
      : 1,
  );
"; then
  echo "   ✓ emoji-map.js and emoji-parser.js load once before renderer.js; context-menu and file helpers precede consumers"
else
  echo "   ✗ ORDER: loader scripts must load once before their renderer and tab consumers"
  exit 1
fi

# Removed features must STAY removed. custom-language.js came from the
# intermediate fork, not from upstream, so a merge from that side can
# resurrect it; index.html would then load a file that no longer exists.
check_html_absent() {
  local script="$1"
  if grep -q "src=\"$script\"" "$ROOT/src/index.html"; then
    echo "   ✗ RESURRECTED: $script is registered in index.html but was removed from this fork"
    echo "     → Delete the <script src=\"$script\"></script> tag; do not re-add the file"
  else
    echo "   ✓ $script correctly absent"
  fi
}

check_html_absent "custom-language.js"

# -----------------------------------------------------------------------------
# 8. Verify custom overlay scripts are in build.files (package.json)
# -----------------------------------------------------------------------------
echo ""
echo "8. Checking package.json build.files for overlay scripts..."

# These used to be checked by a second, hand-rolled `grep -q "\"$file\""`
# helper that duplicated check_build_file above. The duplication was not
# harmless: the grep matched the filename WITH its surrounding quotes, so it
# broke the moment the sources moved into src/ and the entries became
# "src/custom-tabs.js" - reporting five files MISSING that were correctly
# declared, while the substring-based section 3 went on passing. Reuse the one
# helper so the two can never disagree again.
check_build_file "custom-collapse.js"
check_build_file "custom-tabs.js"
check_build_file "custom-theme.js"
check_build_file "custom-performance.js"
check_build_file "custom-styles.css"
check_build_file "mermaid-config.js"
check_build_file "context-menu-utils.js"
check_build_file "file-helpers-core.js"
check_build_file "file-helpers.js"
check_build_file "emoji-map.js"
check_build_file "emoji-parser.js"

if [ "$MISSING_BUILD" -eq 1 ]; then
  echo "   ✗ One or more required customizations are missing from build.files"
  exit 1
fi

# The mirror image, and the more dangerous half: this asserts an ABSENCE, so a
# matcher that has stopped matching reports success. The old exact-quote grep
# would have waved "src/custom-language.js" straight back into the build with a
# ✓ beside it. Substring matching keeps it honest regardless of directory.
if node -e "
  const files = (require('./package.json').build || {}).files || [];
  process.exit(files.some(f => typeof f === 'string' && f.includes('custom-language.js')) ? 0 : 1);
"; then
  echo "   ✗ RESURRECTED: custom-language.js is back in build.files but was removed from this fork"
  echo "     → Remove it from the build.files array in package.json"
else
  echo "   ✓ custom-language.js correctly absent from build.files"
fi

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
echo ""
echo "=== Done ==="
echo ""
echo "Customizations applied:"
echo "  • Electron pinned to ^43 (macOS idle CPU fix + security advisories)"
echo "  • Tabbed multi-file viewing overlay (custom-tabs.js)"
echo "  • Theme submenu overlay (custom-theme.js)"
echo "  • Startup/render performance overlay (custom-performance.js)"
echo "  • Collapse/Expand All overlay (custom-collapse.js)"
echo ""
echo "Removed features that must stay removed:"
echo "  • Interface localisation (Turkish/Ukrainian, custom-language.js) - English only"
echo "  • Document translation, image slider"
echo ""
echo "Next steps:"
echo "  1. Run 'npm start' to test the app"
echo "  2. Verify: tabs (tabsContainer div in index.html), scrollbar, compact header, PDF export"
echo "  3. Check CPU usage in Activity Monitor when app is idle"
echo "  4. Verify the toolbar has File and View only - no Tools menu, no language switcher"
echo "  5. Test View > Theme submenu and View > Collapse All / Expand All"
echo "  6. Run 'npm test' - the packaging suite fails if a removed feature came back"
echo ""
