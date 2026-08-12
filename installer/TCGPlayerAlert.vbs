Option Explicit

Dim shell, fileSystem, applicationDirectory, command, exitCode, logPath
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

applicationDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
command = Quote(applicationDirectory & "\runtime\node.exe") & " " & _
  Quote(applicationDirectory & "\app\dist\windows-launcher.js") & " --install-root " & _
  Quote(applicationDirectory)

exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then
  logPath = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & _
    "\TCGPlayerAlert\logs\launcher.log"
  MsgBox "TCGPlayerAlert could not start." & vbCrLf & vbCrLf & _
    "Details were written to:" & vbCrLf & logPath, _
    vbCritical, "TCGPlayerAlert"
End If

Function Quote(value)
  Quote = Chr(34) & value & Chr(34)
End Function
