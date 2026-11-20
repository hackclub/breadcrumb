# Disposable Windows CI only. Refuses to touch an existing Breadcrumb install/library.
param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$Installer = (Resolve-Path $Installer).Path
$data = Join-Path $env:LOCALAPPDATA 'Breadcrumb'
if (Test-Path $data) { throw 'Existing Breadcrumb data or installation found; use a disposable Windows account.' }
$existing = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'Breadcrumb' }
if ($existing) { throw 'Existing Breadcrumb registration found; use a disposable Windows account.' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('breadcrumb-installer-' + [guid]::NewGuid())
$install = Join-Path $root 'Path with spaces\Breadcrumb'
New-Item $root -ItemType Directory | Out-Null
$results = [Collections.Generic.List[string]]::new()

function Assert($condition, [string]$message) { if (-not $condition) { throw $message } }
function Run([string]$exe, [string]$arguments) {
    Write-Host "Running $(Split-Path $exe -Leaf) $arguments"
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru
    if (-not $process.WaitForExit(300000)) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        throw 'Installer did not exit within five minutes'
    }
    Assert ($process.ExitCode -eq 0) "$exe exited $($process.ExitCode)"
}
function Installed {
    foreach ($file in 'breadcrumb-desktop.exe', 'breadcrumb-engine.exe', 'breadcrumb-capture.exe', 'uninstall.exe') {
        Assert (Test-Path (Join-Path $install $file)) "Missing installed file: $file"
    }
    $entry = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -eq 'Breadcrumb' -and $_.InstallLocation.Trim('"') -eq $install }
    Assert ($null -ne $entry) 'Per-user uninstall registration is missing'
}
function Uninstall([switch]$DeleteData) {
    $arguments = '/S'
    if ($DeleteData) { $arguments += ' /DELETEAPPDATA' }
    Run (Join-Path $install 'uninstall.exe') $arguments
    # The launcher can exit before its temporary uninstaller. Wait for all
    # observable cleanup, not just the first deleted file.
    $clean = $false
    for ($i = 0; $i -lt 150; $i++) {
        $files = 'breadcrumb-desktop.exe', 'breadcrumb-engine.exe', 'breadcrumb-capture.exe' |
            Where-Object { Test-Path (Join-Path $install $_) }
        $key = Get-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
        $startup = if ($null -ne $key) { $key.GetValue('Breadcrumb', $null) } else { $null }
        if (-not $files -and $null -eq $startup -and (-not $DeleteData -or -not (Test-Path $data))) {
            $clean = $true
            break
        }
        Start-Sleep -Milliseconds 200
    }
    Assert $clean 'Uninstall did not finish removing its files, autostart or requested data'

}

try {
    Run $Installer "/S /D=$install"
    Installed
    $results.Add('Fresh per-user install, sidecars, uninstall registration, path containing spaces')

    New-Item $data -ItemType Directory -Force | Out-Null
    $fixtures = @{
        'library.json' = '{"version":1,"observations":[],"clips":[],"markers":[]}'
        'settings.json' = '{"retentionHours":0,"storageGiB":20}'
        'desktop-state.json' = '{"recording":false,"exclusions":["synthetic-private.exe"]}'
        'connection.json' = '{"server":"https://example.invalid","autoSync":false}'
    }
    $hashes = @{}
    foreach ($file in $fixtures.Keys) {
        $path = Join-Path $data $file
        [IO.File]::WriteAllText($path, $fixtures[$file])
        $hashes[$file] = (Get-FileHash $path -Algorithm SHA256).Hash
    }
    Run $Installer "/S /D=$install"
    Installed
    foreach ($file in $fixtures.Keys) {
        Assert ((Get-FileHash (Join-Path $data $file) -Algorithm SHA256).Hash -eq $hashes[$file]) "Repair changed $file"
    }
    $results.Add('Same-version repair preserves history, settings, recording and connection fixtures')

    New-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'Breadcrumb' -Value ('"' + (Join-Path $install 'breadcrumb-desktop.exe') + '"') -Force | Out-Null
    Uninstall
    foreach ($file in $fixtures.Keys) {
        Assert ((Get-FileHash (Join-Path $data $file) -Algorithm SHA256).Hash -eq $hashes[$file]) "Default uninstall changed $file"
    }
    $results.Add('Default uninstall preserves data and removes autostart')

    Run $Installer "/S /D=$install"
    Installed
    foreach ($file in $fixtures.Keys) {
        Assert ((Get-FileHash (Join-Path $data $file) -Algorithm SHA256).Hash -eq $hashes[$file]) "Reinstall changed $file"
    }
    $results.Add('Reinstall preserves existing data')
    Uninstall -DeleteData
    for ($i = 0; $i -lt 150 -and (Test-Path $data); $i++) { Start-Sleep -Milliseconds 200 }
    Assert (-not (Test-Path $data)) 'Explicit Delete app data did not remove the actual Go library'
    $results.Add('Explicit Delete app data removes the actual library')
    @{ installer = (Split-Path $Installer -Leaf); sha256 = (Get-FileHash $Installer -Algorithm SHA256).Hash; passed = $results } | ConvertTo-Json -Depth 3
} finally {
    if (Test-Path (Join-Path $install 'uninstall.exe')) {
        try { Uninstall } catch { Write-Warning 'Test install cleanup failed; inspect the job log.' }
    }
    if (Test-Path $root) { Remove-Item $root -Recurse -Force }
}
