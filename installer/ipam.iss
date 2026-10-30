; IPAM installer (Inno Setup 6).
; Build: node scripts/build-exe.mjs, then
;   iscc /DAppVersion=1.1.0 installer\ipam.iss
; Output: release\IPAM-Setup-<version>.exe
;
; Installs ipam.exe as the Windows service "IPAM" (through NSSM), keeps data in
; C:\ProgramData\IPAM (readable only by SYSTEM and Administrators) and opens the
; chosen TCP port in Windows Firewall. Re-running a newer setup upgrades in place
; and keeps the data. Silent: IPAM-Setup.exe /VERYSILENT /PORT=3000

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define SourceDir "..\release\ipam"
#define ServiceName "IPAM"

[Setup]
AppId={{FB291BD4-140F-45F4-8E47-1E3A1AB13E31}
AppName=IPAM
AppVersion={#AppVersion}
AppVerName=IPAM {#AppVersion}
AppPublisher=Benny007-king
AppPublisherURL=https://github.com/Benny007-king/IPAM
AppSupportURL=https://github.com/Benny007-king/IPAM/issues
AppUpdatesURL=https://github.com/Benny007-king/IPAM/releases
VersionInfoVersion={#AppVersion}
VersionInfoDescription=IPAM - IP Address Management setup
DefaultDirName={autopf}\IPAM
DefaultGroupName=IPAM
DisableProgramGroupPage=yes
LicenseFile=..\LICENSE
OutputDir=..\release
OutputBaseFilename=IPAM-Setup-{#AppVersion}
SetupIconFile=..\ipam.ico
UninstallDisplayIcon={app}\ipam.ico
UninstallDisplayName=IPAM - IP Address Management
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
CloseApplications=no
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "firewall"; Description: "Allow other computers to open IPAM (adds a Windows Firewall rule for the chosen port)"
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Dirs]
Name: "{commonappdata}\IPAM"
Name: "{commonappdata}\IPAM\logs"

[Files]
Source: "{#SourceDir}\ipam.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\better_sqlite3.node"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\nssm.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\README.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceDir}\LICENSE.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\ipam.ico"; DestDir: "{app}"; Flags: ignoreversion

[INI]
; Tells ipam.exe where the installed copy keeps its data, also when it is run by
; hand (e.g. "ipam.exe --reset-admin" from an administrator command prompt).
Filename: "{app}\ipam.ini"; Section: "IPAM"; Key: "DataDir"; String: "{commonappdata}\IPAM"
Filename: "{app}\Open IPAM.url"; Section: "InternetShortcut"; Key: "URL"; String: "http://localhost:{code:GetPort}/"
Filename: "{app}\Open IPAM.url"; Section: "InternetShortcut"; Key: "IconFile"; String: "{app}\ipam.ico"
Filename: "{app}\Open IPAM.url"; Section: "InternetShortcut"; Key: "IconIndex"; String: "0"

[Icons]
Name: "{group}\Open IPAM"; Filename: "{app}\Open IPAM.url"; IconFilename: "{app}\ipam.ico"
Name: "{group}\IPAM logs"; Filename: "{commonappdata}\IPAM\logs"
Name: "{group}\Uninstall IPAM"; Filename: "{uninstallexe}"
Name: "{autodesktop}\IPAM"; Filename: "{app}\Open IPAM.url"; IconFilename: "{app}\ipam.ico"; Tasks: desktopicon

[Registry]
Root: HKLM; Subkey: "Software\IPAM"; ValueType: string; ValueName: "Port"; ValueData: "{code:GetPort}"; Flags: uninsdeletekey
Root: HKLM; Subkey: "Software\IPAM"; ValueType: string; ValueName: "Version"; ValueData: "{#AppVersion}"

[Run]
; The data folder holds the database, its connection settings and the session
; secret: SYSTEM and Administrators only.
Filename: "{sys}\icacls.exe"; Parameters: """{commonappdata}\IPAM"" /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F"; Flags: runhidden waituntilterminated; StatusMsg: "Protecting the data folder..."
; "install" fails harmlessly when upgrading (the service exists); every "set" applies either way.
Filename: "{app}\nssm.exe"; Parameters: "install {#ServiceName} ""{app}\ipam.exe"""; Flags: runhidden waituntilterminated; StatusMsg: "Registering the IPAM service..."
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} Application ""{app}\ipam.exe"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppDirectory ""{app}"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppEnvironmentExtra NODE_ENV=production IPAM_SERVICE=1 ""DATA_DIR={commonappdata}\IPAM"" PORT={code:GetPort}"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} DisplayName ""IPAM - IP Address Management"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} Description ""IP address management web service (http://localhost:{code:GetPort}/)"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} Start SERVICE_AUTO_START"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppExit Default Restart"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppRestartDelay 5000"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppStdout ""{commonappdata}\IPAM\logs\ipam.log"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppStderr ""{commonappdata}\IPAM\logs\ipam.log"""; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppRotateFiles 1"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppRotateOnline 1"; Flags: runhidden waituntilterminated
Filename: "{app}\nssm.exe"; Parameters: "set {#ServiceName} AppRotateBytes 5242880"; Flags: runhidden waituntilterminated
; Firewall: always clear the old rule, add it back when the task is ticked.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""IPAM"""; Flags: runhidden waituntilterminated
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""IPAM"" dir=in action=allow protocol=TCP localport={code:GetPort} program=""{app}\ipam.exe"" description=""IPAM web interface"""; Flags: runhidden waituntilterminated; Tasks: firewall
Filename: "{app}\nssm.exe"; Parameters: "start {#ServiceName}"; Flags: runhidden waituntilterminated; StatusMsg: "Starting IPAM..."
Filename: "http://localhost:{code:GetPort}/"; Description: "Open IPAM in the browser"; Flags: postinstall shellexec nowait skipifsilent

[UninstallRun]
Filename: "{app}\nssm.exe"; Parameters: "stop {#ServiceName}"; Flags: runhidden waituntilterminated; RunOnceId: "StopService"
Filename: "{app}\nssm.exe"; Parameters: "remove {#ServiceName} confirm"; Flags: runhidden waituntilterminated; RunOnceId: "RemoveService"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""IPAM"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveFirewallRule"

[UninstallDelete]
Type: files; Name: "{app}\Open IPAM.url"
Type: files; Name: "{app}\ipam.ini"

[Code]
var
  PortPage: TInputQueryWizardPage;

{ /PORT=... on the command line, else the port of the previous install, else 3000. }
function DefaultPort(): String;
var
  Previous: String;
begin
  Result := ExpandConstant('{param:PORT|}');
  if Result = '' then
  begin
    if RegQueryStringValue(HKLM, 'Software\IPAM', 'Port', Previous) and (Previous <> '') then
      Result := Previous
    else
      Result := '3000';
  end;
end;

procedure InitializeWizard;
begin
  PortPage := CreateInputQueryPage(wpSelectTasks,
    'Web port', 'Which port should IPAM listen on?',
    'IPAM runs as a Windows service with its own web server. After setup, browse to ' +
    'http://<this computer>:<port>/ and sign in as admin / admin123.');
  PortPage.Add('Port (1-65535):', False);
  PortPage.Values[0] := DefaultPort();
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Port: Integer;
begin
  Result := True;
  if (PortPage <> nil) and (CurPageID = PortPage.ID) then
  begin
    Port := StrToIntDef(Trim(PortPage.Values[0]), 0);
    if (Port < 1) or (Port > 65535) then
    begin
      MsgBox('Enter a port number between 1 and 65535.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function GetPort(Param: String): String;
begin
  if PortPage <> nil then
    Result := Trim(PortPage.Values[0])
  else
    Result := DefaultPort();
end;

{ Upgrades: stop the running service so its files can be replaced. }
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Nssm: String;
begin
  Result := '';
  Nssm := ExpandConstant('{app}\nssm.exe');
  if FileExists(Nssm) then
    Exec(Nssm, 'stop {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    DataDir := ExpandConstant('{commonappdata}\IPAM');
    if DirExists(DataDir) and not UninstallSilent() then
    begin
      if MsgBox('Also delete your IPAM data?' + #13#10#13#10 +
                DataDir + #13#10 + '(the built-in database, connection settings and logs)' + #13#10#13#10 +
                'Choose No to keep it for a later reinstall. An external database is never touched.',
                mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;
