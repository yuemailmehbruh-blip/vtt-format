; Inno Setup script for GM Session
; Expects:
;   dist\GM Session\          — PyInstaller onedir output
;   staging-campaign\         — sample campaign copied by build.ps1
; Build: run packaging\windows\build.ps1 (or ISCC gm-session.iss after pyinstaller)

#define MyAppName "GM Session"
; build.ps1 passes /DMyAppVersion=<apps/gm-session/VERSION>; fallback only for manual ISCC runs.
#ifndef MyAppVersion
  #define MyAppVersion "0.0.0-dev"
#endif
#define MyAppPublisher "vtt-format"
#define MyAppExeName "GM Session.exe"

[Setup]
AppId={{A7C3E91F-4B2D-4E8A-9F11-GMSESSION0001}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir=output
OutputBaseFilename=GM-Session-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; PyInstaller onedir payload
Source: "dist\GM Session\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; Editable sample campaign beside the executable. onlyifdoesntexist: an update/reinstall
; must never overwrite the user's campaign (sheets, actors, scenes, tokens); only missing
; files are seeded. uninsneveruninstall keeps the campaign if the app is uninstalled.
Source: "staging-campaign\*"; DestDir: "{app}\campaign"; Flags: onlyifdoesntexist uninsneveruninstall recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""GM Session players (TCP 8766)"""; Flags: runhidden; Check: IsAdmin; RunOnceId: "DelFwRule"

[Run]
; 0.7.0: players on other computers connect to the GM's player port (TCP 8766).
; When the installer runs elevated, add an inbound allow rule for that port; otherwise
; Windows shows its own "allow on private networks" prompt the first time GM Session
; starts hosting (click Allow). runhidden + no error if netsh fails.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""GM Session players (TCP 8766)"""; Flags: runhidden; Check: IsAdmin
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""GM Session players (TCP 8766)"" dir=in action=allow protocol=TCP localport=8766 profile=private,domain"; Flags: runhidden; Check: IsAdmin; StatusMsg: "Allowing player connections (TCP 8766) in Windows Firewall..."
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
