Set WshShell = CreateObject("WScript.Shell")
Set FSO = CreateObject("Scripting.FileSystemObject")
ProjectDir = FSO.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = ProjectDir
RuntimeDir = ProjectDir & "\data\runtime"
If Not FSO.FolderExists(ProjectDir & "\data") Then FSO.CreateFolder(ProjectDir & "\data")
If Not FSO.FolderExists(RuntimeDir) Then FSO.CreateFolder(RuntimeDir)
LogPath = RuntimeDir & "\launcher.log"
ErrPath = RuntimeDir & "\app_error.log"
If FSO.FileExists(ErrPath) Then FSO.DeleteFile ErrPath, True
UserProfile = WshShell.ExpandEnvironmentStrings("%USERPROFILE%")
Pythonw = UserProfile & "\scoop\apps\python\current\pythonw.exe"
If Not FSO.FileExists(Pythonw) Then Pythonw = UserProfile & "\AppData\Local\Programs\Python\Python314\pythonw.exe"
If Not FSO.FileExists(Pythonw) Then Pythonw = UserProfile & "\AppData\Local\Programs\Python\Python313\pythonw.exe"
If Not FSO.FileExists(Pythonw) Then Pythonw = "pythonw.exe"
Set LogFile = FSO.OpenTextFile(LogPath, 8, True)
LogFile.WriteLine Now & " launch via " & Pythonw
LogFile.Close
Cmd = """" & Pythonw & """ -m app.main --toggle-panel"
WshShell.Run Cmd, 0, False
