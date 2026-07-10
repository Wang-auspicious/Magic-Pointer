Option Explicit

Function JsonEscape(value)
    Dim text
    text = CStr(value)
    text = Replace(text, "\", "\\")
    text = Replace(text, """", "\""")
    text = Replace(text, vbCr, "\r")
    text = Replace(text, vbLf, "\n")
    text = Replace(text, vbTab, "\t")
    JsonEscape = text
End Function

Function JsonString(value)
    JsonString = """" & JsonEscape(value) & """"
End Function

Function JsonBool(value)
    If CBool(value) Then
        JsonBool = "true"
    Else
        JsonBool = "false"
    End If
End Function

Dim progId, app, doc, selection, output
progId = "Word.Application"
If WScript.Arguments.Count > 0 Then progId = WScript.Arguments(0)

On Error Resume Next
Set app = GetObject(, progId)
If Err.Number <> 0 Then
    output = "{""ok"":false,""error"":" & JsonString(Err.Description) & "}"
    WScript.StdOut.WriteLine output
    WScript.Quit 1
End If
Err.Clear

Set doc = app.ActiveDocument
If Err.Number <> 0 Or doc Is Nothing Then
    output = "{""ok"":false,""error"":""No active Word document""}"
    WScript.StdOut.WriteLine output
    WScript.Quit 1
End If
Err.Clear

Set selection = app.Selection
If Err.Number <> 0 Or selection Is Nothing Then
    output = "{""ok"":false,""error"":""No Word selection""}"
    WScript.StdOut.WriteLine output
    WScript.Quit 1
End If
Err.Clear

Dim hwnd, documentFullName, documentName, documentPath, documentSaved
Dim selectionType, selectionStart, selectionEnd, selectionText
hwnd = app.ActiveWindow.Hwnd
documentFullName = doc.FullName
documentName = doc.Name
documentPath = doc.Path
documentSaved = doc.Saved
selectionType = selection.Type
selectionStart = selection.Start
selectionEnd = selection.End
If CLng(selectionEnd) > CLng(selectionStart) Then
    selectionText = selection.Text
Else
    selectionText = ""
End If

output = "{""ok"":true"
output = output & ",""hwnd"":" & CStr(hwnd)
output = output & ",""document"":" & JsonString(documentFullName)
output = output & ",""document_name"":" & JsonString(documentName)
output = output & ",""document_path"":" & JsonString(documentPath)
output = output & ",""document_saved"":" & JsonBool(documentSaved)
output = output & ",""selection_type"":" & JsonString(selectionType)
output = output & ",""selection_start"":" & CStr(selectionStart)
output = output & ",""selection_end"":" & CStr(selectionEnd)
output = output & ",""text"":" & JsonString(selectionText)
output = output & "}"
WScript.StdOut.WriteLine output
