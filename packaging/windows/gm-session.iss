; Inno Setup script for GM Session
; Expects:
;   dist\GM Session\          — PyInstaller onedir output
;   staging-campaign\         — sample campaign copied by build.ps1
; Build: run packaging\windows\build.ps1 (or ISCC gm-session.iss after pyinstaller)

#define MyAppName "GM Session"
#define MyAppVersion "0.5.4"
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
; Editable sample campaign beside the executable
Source: "staging-campaign\*"; DestDir: "{app}\campaign"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent
