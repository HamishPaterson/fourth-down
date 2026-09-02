$ErrorActionPreference = "Stop"

$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Get-Location
$cssPath = Join-Path $projectRoot "src\index.css"
$headerPath = Join-Path $projectRoot "src\components\Header.jsx"
$htmlPath = Join-Path $projectRoot "index.html"

foreach ($path in @($cssPath, $headerPath, $htmlPath)) {
  if (-not (Test-Path $path)) {
    throw "Required project file not found: $path"
  }
}

$backupRoot = Join-Path $projectRoot "corrected-branding-backup"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
Copy-Item $cssPath (Join-Path $backupRoot "index.css") -Force
Copy-Item $headerPath (Join-Path $backupRoot "Header.jsx") -Force
Copy-Item $htmlPath (Join-Path $backupRoot "index.html") -Force

$brandingTarget = Join-Path $projectRoot "public\branding"
New-Item -ItemType Directory -Path $brandingTarget -Force | Out-Null
Copy-Item (Join-Path $packageRoot "public\branding\*") $brandingTarget -Force
Copy-Item (Join-Path $packageRoot "src\components\Header.jsx") $headerPath -Force

$css = Get-Content $cssPath -Raw
foreach ($marker in @(
  "/* Fourth Down brand asset integration */",
  "/* Corrected Fourth Down header branding */"
)) {
  if ($css.Contains($marker)) {
    $css = $css.Substring(0, $css.IndexOf($marker)).TrimEnd()
  }
}
$brandingCss = Get-Content (Join-Path $packageRoot "branding.css") -Raw
Set-Content -Path $cssPath -Value ($css + "`r`n`r`n" + $brandingCss) -Encoding utf8

$html = Get-Content $htmlPath -Raw
$html = [regex]::Replace($html, '<title>.*?</title>', '<title>Fourth Down</title>', 'IgnoreCase')
$html = [regex]::Replace($html, '<link[^>]+rel=["''](?:icon|shortcut icon|apple-touch-icon)["''][^>]*>\s*', '', 'IgnoreCase')
$html = $html.Replace('</head>', "  <link rel=`"icon`" type=`"image/png`" sizes=`"32x32`" href=`"/branding/favicon-32.png`" />`r`n  <link rel=`"apple-touch-icon`" href=`"/branding/app-icon-192.png`" />`r`n</head>")
Set-Content -Path $htmlPath -Value $html -Encoding utf8

Write-Host "Corrected Fourth Down branding installed." -ForegroundColor Green
Write-Host "Home.jsx and all team/schedule/matchup files were not changed." -ForegroundColor Cyan
Write-Host "Run npm run build next." -ForegroundColor Yellow
