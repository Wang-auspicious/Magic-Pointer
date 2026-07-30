; electron-builder owns shortcut creation/removal. This hook only offers an
; explicit, default-safe purge of mutable user data during uninstall.

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
