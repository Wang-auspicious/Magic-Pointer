; electron-builder owns shortcut creation/removal. This hook only offers an
; explicit, default-safe purge of mutable user data during uninstall.

; Preserve the 1.0.54 /cwd default before NSIS removes the old installation tree.
!macro customInit
  IfFileExists "$LOCALAPPDATA\Magic Pointer\workspace.txt" mp_workspace_done
  IfFileExists "$INSTDIR\resources\app\data\runtime\workspace.txt" 0 mp_workspace_done
  CreateDirectory "$LOCALAPPDATA\Magic Pointer"
  ClearErrors
  CopyFiles /SILENT "$INSTDIR\resources\app\data\runtime\workspace.txt" "$LOCALAPPDATA\Magic Pointer"
  IfErrors 0 mp_workspace_done
  Abort "无法保留已选工作区；安装已停止。"
  mp_workspace_done:
!macroend

!macro customUnInit
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否同时删除 Magic Pointer 的用户数据（设置、日志、缓存）？$\n位置：$LOCALAPPDATA\Magic Pointer" \
    /SD IDNO IDYES mp_purge IDNO mp_keep

  mp_purge:
    RMDir /r "$LOCALAPPDATA\Magic Pointer"
    Goto mp_done

  mp_keep:
    Goto mp_done

  mp_done:
!macroend
