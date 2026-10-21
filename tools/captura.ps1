param([string]$name, [string]$theme = 'dark', [string]$actions = '[]', [int]$w = 1000, [int]$h = 1300, [string]$tex = '')
# Genera la página del arnés y la captura con Edge sin ventana.
$s = Join-Path $PSScriptRoot 'capturas'; New-Item -ItemType Directory -Force $s | Out-Null
$root = Split-Path $PSScriptRoot -Parent
$html = Join-Path $s "$name.html"
$acts = Join-Path $s "$name.json"
[IO.File]::WriteAllText($acts, $actions)
if ($tex) { node (Join-Path $PSScriptRoot 'captura.js') $root $html $theme $acts $tex } else { node (Join-Path $PSScriptRoot 'captura.js') $root $html $theme $acts }
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
if (-not (Test-Path $edge)) { $edge = 'C:\Program Files\Microsoft\Edge\Application\msedge.exe' }
$png = Join-Path $s "$name.png"
if (Test-Path $png) { [IO.File]::Delete($png) }
$url = 'file:///' + ($html -replace '\\', '/')
$profile = Join-Path $s 'edge-profile'
$p = Start-Process $edge -ArgumentList '--headless=new', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', "--user-data-dir=$profile", "--window-size=$w,$h", '--virtual-time-budget=9000', "--screenshot=$png", $url -PassThru -WindowStyle Hidden
$p | Wait-Process -Timeout 90 -ErrorAction SilentlyContinue
"captura: $(Test-Path $png)"
