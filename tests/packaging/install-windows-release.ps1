$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'Ephemeral Windows runner required' }
$tag = $env:BUGU_VERIFY_TAG
if ($tag -notmatch '^v[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Invalid release tag' }
$version = $tag.Substring(1)
$out = Join-Path $env:GITHUB_WORKSPACE 'test-results/windows-installed'
New-Item -ItemType Directory -Force $out | Out-Null
$download = Join-Path $env:RUNNER_TEMP 'bugu-release-download'
New-Item -ItemType Directory -Force $download | Out-Null
$name = "BUGU-$version-Windows-x64-Setup.exe"
& gh release download $tag --repo $env:GITHUB_REPOSITORY --pattern $name --pattern SHA256SUMS --dir $download
if ($LASTEXITCODE -ne 0) { throw 'Release download failed' }
$installer = Join-Path $download $name
$expected = (Get-Content (Join-Path $download 'SHA256SUMS') | Where-Object { $_.EndsWith("  $name") }).Split(' ')[0]
$actual = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Installer checksum mismatch' }
$installDir = Join-Path $env:RUNNER_TEMP 'BUGU 安装验证'
$process = Start-Process -FilePath $installer -ArgumentList "/S /D=$installDir" -PassThru
if (-not $process.WaitForExit(120000)) { Stop-Process -Id $process.Id -Force; throw 'Installer timed out' }
if ($process.ExitCode -ne 0) { throw "Installer exit: $($process.ExitCode)" }
$exe = Join-Path $installDir 'BUGU 不咕.exe'
if (-not (Test-Path $exe)) { throw 'Installed executable missing' }
"BUGU_INSTALLED_EXE=$exe" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
"BUGU_EXPECTED_VERSION=$version" | Out-File -FilePath $env:GITHUB_ENV -Append -Encoding utf8
# First launch without debugger/instrumentation, as a normal user would start it.
$app = Start-Process -FilePath $exe -PassThru -RedirectStandardOutput (Join-Path $out 'plain-stdout.txt') -RedirectStandardError (Join-Path $out 'plain-stderr.txt')
Start-Sleep -Seconds 12
$app.Refresh()
$state = @{ installerSha256=$actual; installerExit=$process.ExitCode; executable=$exe; exited=$app.HasExited; title=$app.MainWindowTitle; pid=$app.Id }
if ($app.HasExited) { $state.exitCode=$app.ExitCode }
$state | ConvertTo-Json | Out-File (Join-Path $out 'plain-launch.json') -Encoding utf8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$image = New-Object System.Drawing.Bitmap $bounds.Width,$bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($image)
try {
  $graphics.CopyFromScreen($bounds.Location,[System.Drawing.Point]::Empty,$bounds.Size)
  $image.Save((Join-Path $out 'plain-desktop.png'))
} finally { $graphics.Dispose(); $image.Dispose() }
if (-not $app.HasExited) { & taskkill /PID $app.Id /T /F | Out-Null }
# The verification process owns all BUGU processes on this fresh runner.
Get-Process -Name 'BUGU 不咕' -ErrorAction SilentlyContinue | Stop-Process -Force
