; Keep the existing NSIS installation folder across an assisted upgrade.
; Display name, executable, shortcuts, and artifact names remain Markaloo.
!undef APP_FILENAME
!define APP_FILENAME "Folia"

!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING

  ; PowerShell detects any process in the install folder. Its tasklist fallback
  ; only checks Markaloo.exe, so check the previous executable separately.
  ${If} $IsPowerShellAvailable != 0
  ${AndIf} ${FileExists} "$INSTDIR\Folia.exe"
    !insertmacro FIND_PROCESS "Folia.exe" $R0
    ${If} $R0 == 0
      ${If} ${isUpdated}
        Sleep 1000
        Goto closeLegacyApp
      ${EndIf}
      MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION "$(appRunning)" /SD IDOK IDOK closeLegacyApp
      Quit

      closeLegacyApp:
      DetailPrint "$(appClosing)"
      !insertmacro KILL_PROCESS "Folia.exe" 0
      Sleep 300
      StrCpy $R1 0

      waitForLegacyApp:
        IntOp $R1 $R1 + 1
        !insertmacro FIND_PROCESS "Folia.exe" $R0
        ${If} $R0 != 0
          Goto legacyAppClosed
        ${EndIf}
        Sleep 1000
        !insertmacro KILL_PROCESS "Folia.exe" 1
        !insertmacro FIND_PROCESS "Folia.exe" $R0
        ${If} $R0 != 0
          Goto legacyAppClosed
        ${EndIf}
        ${If} $R1 > 1
          MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY waitForLegacyApp
          Quit
        ${EndIf}
        Goto waitForLegacyApp

      legacyAppClosed:
    ${EndIf}
  ${EndIf}
!macroend
