; electron-builder's normal uninstall ends with RMDir /r $INSTDIR. Its bundled
; NSIS 3.0.4.1 otherwise misses dependency filenames whose full path exceeds
; MAX_PATH. Change only the representation of the existing installation path;
; the native uninstall still owns deletion, shortcuts, registry and user-data
; policy. Keep its separate atomic update/restore path entirely unchanged.
!macro customUnInstall
  ${IfNot} ${isUpdated}
    Push $0
    Push $1
    StrCpy $0 "$INSTDIR" 4
    ${If} $0 != "\\?\"
      StrCpy $0 "$INSTDIR" 2
      ${If} $0 == "\\"
        StrCpy $0 "$INSTDIR" "" 2
        StrCpy $INSTDIR "\\?\UNC\$0"
      ${Else}
        StrCpy $0 "$INSTDIR" 1 1
        StrCpy $1 "$INSTDIR" 1 2
        ${If} $0 == ":"
        ${AndIf} $1 == "\"
          StrCpy $INSTDIR "\\?\$INSTDIR"
        ${EndIf}
      ${EndIf}
    ${EndIf}
    Pop $1
    Pop $0
  ${EndIf}
!macroend
