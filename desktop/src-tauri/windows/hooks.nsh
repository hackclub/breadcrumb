; Keep local history on normal uninstall and on every upgrade. Only the explicit
; "Delete app data" choice (or /DELETEAPPDATA) removes the Go engine's library.
!macro NSIS_HOOK_POSTUNINSTALL
  ClearErrors
  ${GetOptions} $CMDLINE "/DELETEAPPDATA" $0
  ${IfNot} ${Errors}
    StrCpy $DeleteAppDataCheckboxState 1
  ${EndIf}
  ClearErrors
  ${If} $DeleteAppDataCheckboxState = 1
  ${AndIf} $UpdateMode <> 1
    SetShellVarContext current
    RMDir /r "$LOCALAPPDATA\Breadcrumb"
  ${EndIf}
!macroend
