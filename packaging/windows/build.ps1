# Build GM Session for Windows: PyInstaller onedir + optional Inno Setup installer.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1
# Requires: Python 3.10+, pip. Optional: Inno Setup 6 (ISCC.exe on PATH or default install).

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
Set-Location $ScriptDir

Write-Host "==> Repo: $RepoRoot"
Write-Host "==> Working dir: $ScriptDir"

$Venv = Join-Path $ScriptDir ".venv"
$Python = Join-Path $Venv "Scripts\python.exe"
$Pip = Join-Path $Venv "Scripts\pip.exe"

if (-not (Test-Path $Python)) {
    Write-Host "==> Creating venv at $Venv"
    python -m venv $Venv
}

Write-Host "==> Installing PyInstaller + PyYAML"
& $Pip install --upgrade pip | Out-Null
& $Pip install "pyinstaller>=6.0" "pyyaml>=6.0"

$Dist = Join-Path $ScriptDir "dist"
$Build = Join-Path $ScriptDir "build"
if (Test-Path $Dist) { Remove-Item -Recurse -Force $Dist }
if (Test-Path $Build) { Remove-Item -Recurse -Force $Build }

Write-Host "==> Running PyInstaller (gm-session.spec)"
& $Python -m PyInstaller --noconfirm --clean "gm-session.spec"

$AppDist = Join-Path $Dist "GM Session"
if (-not (Test-Path (Join-Path $AppDist "GM Session.exe"))) {
    throw "PyInstaller did not produce dist\GM Session\GM Session.exe"
}

# Stage editable campaign for the installer (prefer _internal layout from PyInstaller 6+)
$StagingCampaign = Join-Path $ScriptDir "staging-campaign"
if (Test-Path $StagingCampaign) { Remove-Item -Recurse -Force $StagingCampaign }

$Candidates = @(
    (Join-Path $AppDist "_internal\sample-campaign"),
    (Join-Path $AppDist "sample-campaign"),
    (Join-Path $RepoRoot "examples\sample-campaign")
)
$SourceCampaign = $null
foreach ($c in $Candidates) {
    if (Test-Path (Join-Path $c "world\scenes")) {
        $SourceCampaign = $c
        break
    }
}
if (-not $SourceCampaign) {
    throw "Could not find sample-campaign to stage for the installer"
}
Write-Host "==> Staging campaign from $SourceCampaign"
Copy-Item -Recurse -Force $SourceCampaign $StagingCampaign

Write-Host ""
Write-Host "PyInstaller output:"
Write-Host "  $AppDist"
Write-Host "  Executable: $(Join-Path $AppDist 'GM Session.exe')"

# Inno Setup (optional)
$Iscc = $null
$IsccCandidates = @(
    "ISCC.exe",
    "${env:LocalAppData}\Programs\Inno Setup 6\ISCC.exe",
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
)
foreach ($c in $IsccCandidates) {
    if ($c -eq "ISCC.exe") {
        $cmd = Get-Command ISCC.exe -ErrorAction SilentlyContinue
        if ($cmd) { $Iscc = $cmd.Source; break }
    } elseif (Test-Path $c) {
        $Iscc = $c
        break
    }
}

$SetupPath = $null
if ($Iscc) {
    Write-Host "==> Running Inno Setup: $Iscc"
    $OutputDir = Join-Path $ScriptDir "output"
    if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Path $OutputDir | Out-Null }
    & $Iscc "gm-session.iss"
    $SetupPath = Join-Path $OutputDir "GM-Session-Setup.exe"
    if (Test-Path $SetupPath) {
        Write-Host ""
        Write-Host "Installer:"
        Write-Host "  $SetupPath"
    } else {
        Write-Warning "ISCC finished but GM-Session-Setup.exe was not found in output\"
    }
} else {
    Write-Host ""
    Write-Host "Inno Setup (ISCC) not found — skipped installer."
    Write-Host "Install Inno Setup 6, then re-run this script, or compile gm-session.iss manually."
    Write-Host "You can still run the onedir build: dist\GM Session\GM Session.exe"
}

Write-Host ""
Write-Host "Done."
if ($SetupPath -and (Test-Path $SetupPath)) {
    Write-Host "Ship: $SetupPath"
} else {
    Write-Host "Ship (folder): $AppDist"
}
