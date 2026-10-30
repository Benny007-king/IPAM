# Release smoke test for the Windows installer. Runs in CI on a throwaway runner:
# it installs a Windows service and a firewall rule, so do not run it on your PC.
#   install -> service up -> sign in -> segment + live ping -> data folder locked down
#   -> upgrade in place keeps the data -> uninstall removes service and rule, keeps data
$ErrorActionPreference = 'Stop'
$Port = 3555
$Base = "http://localhost:$Port"
$Setup = (Get-ChildItem "$PSScriptRoot\..\release\IPAM-Setup-*.exe" | Select-Object -First 1).FullName
$DataDir = "$env:ProgramData\IPAM"
$AppDir = "$env:ProgramFiles\IPAM"
if (-not $Setup) { throw 'release\IPAM-Setup-*.exe not found - build it first' }

function Step($text) { Write-Host "`n=== $text" -ForegroundColor Cyan }
function Assert($cond, $text) {
  if (-not $cond) { throw "FAILED: $text" }
  Write-Host "  ok  $text"
}
function Run-Setup($exe, [string[]]$extra) {
  $p = Start-Process $exe -ArgumentList (@('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART') + $extra) -Wait -PassThru
  Assert ($p.ExitCode -eq 0) "$([IO.Path]::GetFileName($exe)) exited with $($p.ExitCode)"
}
function Wait-Healthy($seconds = 60) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { $h = Invoke-RestMethod "$Base/api/health" -TimeoutSec 3; if ($h.status -eq 'ok') { return $h } } catch {}
    Start-Sleep -Milliseconds 500
  }
  if (Test-Path "$DataDir\logs\ipam.log") { Get-Content "$DataDir\logs\ipam.log" -Tail 40 | Write-Host }
  throw "IPAM did not become healthy on port $Port within $seconds s"
}
function Sign-In {
  $body = @{ username = 'admin'; password = 'admin123'; type = 'local' } | ConvertTo-Json
  Invoke-RestMethod "$Base/api/auth/login" -Method Post -Body $body -ContentType 'application/json' -SessionVariable s | Out-Null
  return $s
}
# A JSON array as a real list on both PowerShell 5.1 and 7 (Invoke-RestMethod
# hands an array over as ONE object, so @(...) would wrap it in another array).
function Get-List($path, $session) {
  $json = (Invoke-WebRequest "$Base$path" -WebSession $session -UseBasicParsing).Content
  $items = [System.Collections.Generic.List[object]]::new()
  foreach ($x in ($json | ConvertFrom-Json)) { foreach ($y in $x) { $items.Add($y) } }
  return , $items
}
function Show-Log {
  if (Test-Path "$DataDir\logs\ipam.log") { Write-Host '--- ipam.log ---'; Get-Content "$DataDir\logs\ipam.log" -Tail 40 | Write-Host }
}
trap { Show-Log; throw }

Step "Install $([IO.Path]::GetFileName($Setup)) on port $Port"
Run-Setup $Setup @("/PORT=$Port", "/LOG=$PSScriptRoot\..\release\install.log")
$svc = Get-Service IPAM
Assert ($svc.StartType -eq 'Automatic') 'service starts with Windows'
$h = Wait-Healthy
Assert ((Get-Service IPAM).Status -eq 'Running') 'service is running'
Write-Host "  IPAM $($h.version) answers on $Base"
Assert (Test-Path "$AppDir\ipam.exe") 'ipam.exe installed in Program Files'
Assert (Test-Path "$DataDir\ipam.db") 'database created in ProgramData'

Step 'Web UI and API'
$page = Invoke-WebRequest "$Base/" -UseBasicParsing
Assert ($page.Content -match 'id="root"') 'web UI is served'
$s = Sign-In
$seg = Invoke-RestMethod "$Base/api/segments" -Method Post -WebSession $s -ContentType 'application/json' `
  -Body (@{ name = 'Loopback'; network = '127.0.0.0'; subnet_mask = '/30'; description = 'installer test' } | ConvertTo-Json)
Assert ($seg.id -gt 0) 'segment created'
$deadline = (Get-Date).AddSeconds(150)
do {
  Start-Sleep 5
  $ips = Get-List "/api/segments/$($seg.id)/ips" $s
  $online = ($ips | Where-Object { $_.status -eq 'online' } | Measure-Object).Count
} while ($online -lt 2 -and (Get-Date) -lt $deadline)
Write-Host ('  ' + (($ips | ForEach-Object { "$($_.ip_address)=$($_.status)" }) -join ', '))
Assert ($ips.Count -eq 2) 'segment populated with its 2 hosts'
Assert ($online -eq 2) 'the service pings them (both online)'

Step 'Data folder and firewall'
$acl = Get-Acl $DataDir
$who = $acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value }
Assert (-not ($who -contains 'S-1-5-32-545')) 'Users cannot read the data folder'
Assert ($who -contains 'S-1-5-18') 'SYSTEM has access'
Assert (Test-Path "$DataDir\.jwt-secret") 'a per-install session secret was generated'
$rule = netsh advfirewall firewall show rule name=IPAM
Assert ($LASTEXITCODE -eq 0 -and ($rule -match "$Port")) "firewall rule for port $Port exists"

Step 'Upgrade in place (same setup again)'
Run-Setup $Setup @()
Wait-Healthy | Out-Null
$s = Sign-In
$after = Get-List '/api/segments' $s
Assert (($after | Where-Object { $_.name -eq 'Loopback' } | Measure-Object).Count -eq 1) 'data kept across the upgrade'
Assert ((Get-ItemProperty 'HKLM:\Software\IPAM').Port -eq "$Port") 'the chosen port is remembered'

Step 'Uninstall'
Run-Setup "$AppDir\unins000.exe" @()
Start-Sleep 2
Assert (-not (Get-Service IPAM -ErrorAction SilentlyContinue)) 'service removed'
netsh advfirewall firewall show rule name=IPAM | Out-Null
Assert ($LASTEXITCODE -ne 0) 'firewall rule removed'
Assert (Test-Path "$DataDir\ipam.db") 'data kept after a silent uninstall'

Write-Host "`nInstaller test passed." -ForegroundColor Green
