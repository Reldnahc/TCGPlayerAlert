#ifndef SourceDir
  #error SourceDir must point to the staged application directory.
#endif
#ifndef AppVersion
  #error AppVersion must be supplied by the packaging script.
#endif
#ifndef OutputDir
  #error OutputDir must be supplied by the packaging script.
#endif

[Setup]
AppId={{E54755E5-F057-4C67-B62B-38C9D23ED2FD}
AppName=TCGPlayerAlert
AppVersion={#AppVersion}
AppVerName=TCGPlayerAlert {#AppVersion}
AppPublisher=Reldnahc
AppPublisherURL=https://github.com/Reldnahc/TCGPlayerAlert
AppSupportURL=https://github.com/Reldnahc/TCGPlayerAlert/issues
AppUpdatesURL=https://github.com/Reldnahc/TCGPlayerAlert/releases
VersionInfoVersion={#AppVersion}.0
DefaultDirName={localappdata}\Programs\TCGPlayerAlert
DefaultGroupName=TCGPlayerAlert
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=TCGPlayerAlert-Setup-{#AppVersion}-win-x64
SetupIconFile={#SourceDir}\TCGPlayerAlert.ico
UninstallDisplayIcon={app}\TCGPlayerAlert.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=yes
SetupLogging=yes

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked
Name: "startup"; Description: "Start TCGPlayerAlert when I sign in"; GroupDescription: "Startup:"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\TCGPlayerAlert"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\TCGPlayerAlert.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\TCGPlayerAlert.ico"
Name: "{autodesktop}\TCGPlayerAlert"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\TCGPlayerAlert.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\TCGPlayerAlert.ico"; Tasks: desktopicon
Name: "{userstartup}\TCGPlayerAlert"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\TCGPlayerAlert.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\TCGPlayerAlert.ico"; Tasks: startup

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\TCGPlayerAlert.vbs"""; Description: "Launch TCGPlayerAlert"; WorkingDir: "{app}"; Flags: nowait postinstall runascurrentuser; Check: InteractiveLaunchAllowed
Filename: "{sys}\wscript.exe"; Parameters: """{app}\TCGPlayerAlert.vbs"""; WorkingDir: "{app}"; Flags: nowait runascurrentuser; Check: AutoLaunchRequested

[Code]
function InteractiveLaunchAllowed: Boolean;
begin
  Result := not WizardSilent;
end;

function AutoLaunchRequested: Boolean;
begin
  Result := ExpandConstant('{param:AUTOLAUNCH|0}') = '1';
end;
