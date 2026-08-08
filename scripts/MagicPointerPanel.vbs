Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
ScriptDir = FSO.GetParentFolderName(WScript.ScriptFullName)
ProjectDir = FSO.GetParentFolderName(ScriptDir)
RuntimeDir = ProjectDir & "\data\runtime"
If Not FSO.FolderExists(ProjectDir & "\data") Then FSO.CreateFolder(ProjectDir & "\data")
If Not FSO.FolderExists(RuntimeDir) Then FSO.CreateFolder(RuntimeDir)
LogPath = RuntimeDir & "\launcher.log"
Set LogFile = FSO.OpenTextFile(LogPath, 8, True)
LogFile.WriteLine Now & " launch Magic Pointer unified launcher"
LogFile.Close
Cmd = "cmd.exe /d /c """ & ScriptDir & "\start_electron_overlay.bat"""
WshShell.Run Cmd, 0, False
