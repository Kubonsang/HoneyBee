Unicode true
!include "FileFunc.nsh"
RequestExecutionLevel user
Name "HoneyBee installation preview"
VIProductVersion "${APP_VERSION_NUMERIC}"
VIAddVersionKey "ProductName" "HoneyBee"
VIAddVersionKey "ProductVersion" "${APP_VERSION}"
VIAddVersionKey "FileVersion" "${APP_VERSION}"
VIAddVersionKey "FileDescription" "HoneyBee Setup"
VIAddVersionKey "LegalCopyright" "HoneyBee contributors"
OutFile "${SETUP_OUTPUT}"
InstallDir "$LOCALAPPDATA\HoneyBee"
SetCompressor zlib
ShowInstDetails show
Page instfiles

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\bundle"
  File /r "${SETUP_BUNDLE}\*"
  StrCpy $1 ""
  IfSilent +2
    StrCpy $1 "--install-service"
  ${GetParameters} $2
  ClearErrors
  ${GetOptions} $2 "/REPAIR" $3
  IfErrors repair_option_done
  StrCpy $1 "$1 --repair"
repair_option_done:
  ClearErrors
  ${GetOptions} $2 "/ADOPT" $3
  IfErrors adopt_option_done
  StrCpy $1 "$1 --adopt-projects"
adopt_option_done:
  ClearErrors
  ExecWait '"$PLUGINSDIR\bundle\payload\versions\${APP_VERSION}\runtime\node.exe" "$PLUGINSDIR\bundle\setup-entry.mjs" "$INSTDIR" $1' $0
  IfErrors stopped
  StrCmp $0 0 ready
  StrCmp $0 4 updated
  StrCmp $0 2 needs_service
  StrCmp $0 3 needs_git
  Goto stopped
ready:
  DetailPrint "HoneyBee application installed. Storage health check passed."
  IfSilent +2
    Exec '"$INSTDIR\HoneyBeeLauncher.exe"'
  SetErrorLevel 0
  Goto done
updated:
  DetailPrint "HoneyBee update completed and the selected version was restarted."
  SetErrorLevel 0
  Goto done
needs_service:
  DetailPrint "HoneyBee application installed. Storage requires attention."
  DetailPrint "Diagnostics: $INSTDIR\.setup-pending\health.json"
  DetailPrint "Repair diagnostics: $INSTDIR\update\repairs\repair-*\health.json"
  IfSilent +2
    MessageBox MB_OK|MB_ICONEXCLAMATION "HoneyBee needs attention. Installation or update may have been cancelled or recovered. Existing project data and recovery evidence were preserved. See the health report and update evidence in the installation folder."
  SetErrorLevel 2
  Goto done
needs_git:
  DetailPrint "Git for Windows is required to use HoneyBee."
  DetailPrint "Install Git, enable command-line PATH access, then close and rerun Setup."
  IfSilent git_done
  MessageBox MB_YESNO|MB_ICONEXCLAMATION "HoneyBee requires Git for Windows. Install Git with command-line PATH access, then close and rerun HoneyBee Setup. Open the official Git download page?" IDNO git_done
  ExecShell "open" "https://git-scm.com/downloads/win"
git_done:
  SetErrorLevel 3
  Abort "Git for Windows is required."
stopped:
  DetailPrint "Setup stopped. Existing files and recovery evidence were preserved."
  SetErrorLevel 1
  Abort "Setup could not complete."
done:
SectionEnd
