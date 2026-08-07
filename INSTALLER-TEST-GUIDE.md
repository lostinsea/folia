# Installer Testing Guide

This guide helps you test the Windows installer to ensure everything works correctly before distribution.

## Quick Test Checklist

### Before Testing
- [ ] Build the installer: `npm run build-installer`
- [ ] Verify installer exists in `dist/` folder
- [ ] Close any running instances of the application

### Installation Test

1. **Run the Installer**
   - Double-click `Folia-Setup-1.0.0.exe`
   - UAC prompt should appear (requires admin rights)

2. **License Agreement**
   - [ ] License text appears correctly
   - [ ] "I Agree" button is clickable

3. **Installation Directory**
   - [ ] Default path shows: `C:\Program Files\Folia`
   - [ ] "Browse" button allows changing install location
   - [ ] Selected path is remembered

4. **Installation Options**
   - [ ] "Create Desktop shortcut" checkbox appears
   - [ ] Options can be checked/unchecked

5. **Installation Progress**
   - [ ] Progress bar shows during installation
   - [ ] No errors appear during installation
   - [ ] Installation completes successfully

6. **Post-Installation**
   - [ ] "Run Folia" checkbox appears
   - [ ] Application launches if checkbox is selected

### Verification Tests

#### Desktop Shortcut
- [ ] Desktop shortcut created (if option was selected)
- [ ] Shortcut has correct icon
- [ ] Double-clicking shortcut launches application

#### Start Menu
- [ ] Start Menu folder exists: `Start > Folia`
- [ ] Shortcut launches application
- [ ] Uninstall shortcut is present

#### File Associations

> **Note:** `build.fileAssociations` is not set in `package.json`, so the
> installer registers **no** file associations. The checks below therefore
> document expected behaviour if associations are added later — today the
> honest expected result for every one of them is "not associated". Verified
> against the build config rather than assumed. The `.ow` OmniWare format was
> removed from the product, so it is no longer listed.

Create test files:
```bash
echo # Test Markdown > test.md
echo graph TD; A-->B; > test.mmd
echo graph TD; A-->B; > test.mermaid
```

Test each file type (only once `build.fileAssociations` exists):
- [ ] `.md` files show the Folia icon
- [ ] `.mmd` files show the Folia icon
- [ ] `.mermaid` files show the Folia icon
- [ ] Double-clicking `.md` opens in Folia
- [ ] Double-clicking `.mmd` opens in Folia
- [ ] Double-clicking `.mermaid` opens in Folia
- [ ] Right-click > "Open with" shows Folia

#### Application Functionality
- [ ] Application window opens correctly
- [ ] All UI elements render properly
- [ ] Can open markdown files via File menu
- [ ] Mermaid diagrams render correctly
- [ ] PDF export works
- [ ] Search functionality works
- [ ] Recent files are tracked
- [ ] Zoom controls work

#### Programs and Features
- [ ] Open "Add/Remove Programs" (Windows Settings > Apps)
- [ ] "Folia" appears in list
- [ ] Version number is correct (1.0.0)
- [ ] Publisher shows as the signing certificate's subject, or is blank on an
      unsigned build (`build.win.signtoolOptions` is null — see BUILD.md)
- [ ] Install location shows correct path

### Uninstallation Test

1. **Via Add/Remove Programs**
   - [ ] Open Settings > Apps > Installed apps
   - [ ] Find "Folia"
   - [ ] Click "Uninstall"
   - [ ] Uninstaller launches
   - [ ] Progress bar shows during uninstallation
   - [ ] Uninstall completes without errors

2. **Via Start Menu**
   - [ ] Start > Folia > Uninstall
   - [ ] Uninstaller launches and completes

3. **Post-Uninstallation**
   - [ ] Application removed from Programs and Features
   - [ ] Desktop shortcut removed (if created)
   - [ ] Start Menu folder removed
   - [ ] Installation directory removed: `C:\Program Files\Folia`
   - [ ] File associations reverted (optional, depends on user settings)

### Clean Reinstallation
- [ ] After uninstall, run installer again
- [ ] Installation proceeds without errors
- [ ] All features work as expected

## Test Environments

Test on multiple Windows versions if possible:

### Minimum Testing
- [ ] Windows 10 (latest)
- [ ] Windows 11

### Comprehensive Testing
- [ ] Windows 10 Home
- [ ] Windows 10 Pro
- [ ] Windows 11 Home
- [ ] Windows 11 Pro
- [ ] Fresh Windows install (no previous version)
- [ ] Upgrade installation (previous version installed)

## Common Issues

### Issue: UAC Prompt Doesn't Appear
**Cause**: Installer requires admin rights
**Solution**: Right-click installer > "Run as administrator"

### Issue: File Associations Don't Work
**Cause**: Windows needs to refresh file associations
**Solution**:
1. Uninstall completely
2. Restart Windows
3. Reinstall

### Issue: "Windows protected your PC" SmartScreen
**Cause**: Unsigned executable
**Solution**:
- Click "More info"
- Click "Run anyway"
- (For production: Get code signing certificate)

### Issue: Desktop Shortcut Missing
**Cause**: Option was not selected during install
**Solution**:
- Find in Start Menu
- Right-click > "Pin to taskbar" or manually create shortcut

### Issue: Old Version Remains After Uninstall
**Cause**: Files in use or incomplete uninstall
**Solution**:
1. Close all instances of the application
2. Uninstall via Add/Remove Programs
3. Manually delete `C:\Program Files\Folia` if it remains
4. Delete `%APPDATA%\Folia` if needed

## Automation Testing (Advanced)

For automated testing, use silent installation:

```batch
REM Install silently
Folia-Setup-1.0.0.exe /S

REM Wait for installation
timeout /t 10

REM Test if installed
if exist "C:\Program Files\Folia\Folia.exe" (
    echo [PASS] Installation successful
) else (
    echo [FAIL] Installation failed
)

REM Uninstall silently
"C:\Program Files\Folia\Uninstall Folia.exe" /S

REM Wait for uninstallation
timeout /t 10

REM Test if uninstalled
if not exist "C:\Program Files\Folia" (
    echo [PASS] Uninstallation successful
) else (
    echo [FAIL] Uninstallation failed
)
```

## Report Template

After testing, fill out this report:

```
INSTALLER TEST REPORT
=====================

Date: _____________
Tester: _____________
Windows Version: _____________
Build Version: 2.0.4

Installation: PASS / FAIL
Desktop Shortcut: PASS / FAIL
Start Menu: PASS / FAIL
File Associations: PASS / FAIL
Application Launch: PASS / FAIL
Functionality: PASS / FAIL
Uninstallation: PASS / FAIL

Issues Found:
_____________________________________________
_____________________________________________

Notes:
_____________________________________________
_____________________________________________

Overall Result: PASS / FAIL
Approved for Release: YES / NO
```

## Next Steps

After successful testing:
1. Update changelog with tested features
2. Tag release in Git: `git tag v2.0.4`
3. Create GitHub release with installer attached
4. Update documentation with any findings
5. Announce release to users
