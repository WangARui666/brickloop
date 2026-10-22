; Remove the file-type keys this installer created; electron-builder only removes the ProgIDs.
!macro BrickloopRemoveExtension EXT PROGID
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}"
  ReadRegStr $0 HKCU "Software\Classes\${EXT}" ""
  StrCmp $0 "${PROGID}" 0 +2
    DeleteRegKey HKCU "Software\Classes\${EXT}"
!macroend

!macro customUnInstall
  !insertmacro BrickloopRemoveExtension ".brkl" "Brickloop.Project"
  !insertmacro BrickloopRemoveExtension ".brklpack" "Brickloop.Pack"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
