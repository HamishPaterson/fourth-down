$ErrorActionPreference = "Stop"

$packageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Get-Location

$required = @(
  "src\index.css",
  "src\components\Header.jsx",
  "src\pages\Home.jsx",
  "index.html"
)

foreach ($relativePath in $required) {
  if (-not (Test-Path (Join-Path $projectRoot $relativePath))) {
    throw "Could not find $relativePath. Run this script from the fourth-down project folder."
  }
}

$backupRoot = Join-Path $projectRoot "branding-backup"
New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
Copy-Item (Join-Path $projectRoot "src\index.css") (Join-Path $backupRoot "index.css") -Force
Copy-Item (Join-Path $projectRoot "src\components\Header.jsx") (Join-Path $backupRoot "Header.jsx") -Force
Copy-Item (Join-Path $projectRoot "src\pages\Home.jsx") (Join-Path $backupRoot "Home.jsx") -Force
Copy-Item (Join-Path $projectRoot "index.html") (Join-Path $backupRoot "index.html") -Force

$brandingTarget = Join-Path $projectRoot "public\branding"
New-Item -ItemType Directory -Path $brandingTarget -Force | Out-Null
Copy-Item (Join-Path $packageRoot "public\branding\*") $brandingTarget -Force
Copy-Item (Join-Path $packageRoot "src\components\Header.jsx") (Join-Path $projectRoot "src\components\Header.jsx") -Force
Copy-Item (Join-Path $packageRoot "src\pages\Home.jsx") (Join-Path $projectRoot "src\pages\Home.jsx") -Force

$cssPath = Join-Path $projectRoot "src\index.css"
$css = Get-Content $cssPath -Raw
$marker = "/* Fourth Down brand asset integration */"
if ($css.Contains($marker)) {
  $css = $css.Substring(0, $css.IndexOf($marker)).TrimEnd()
}
$brandCss = Get-Content (Join-Path $packageRoot "branding.css") -Raw
Set-Content -Path $cssPath -Value ($css + "`r`n`r`n" + $brandCss) -Encoding utf8

$htmlPath = Join-Path $projectRoot "index.html"
$html = Get-Content $htmlPath -Raw
$html = [regex]::Replace($html, '<title>.*?</title>', '<title>Fourth Down</title>', 'IgnoreCase')
$html = [regex]::Replace($html, '<link[^>]+rel=["''](?:icon|shortcut icon)["''][^>]*>\s*', '', 'IgnoreCase')
$html = $html.Replace('</head>', "  <link rel=`"icon`" type=`"image/png`" sizes=`"32x32`" href=`"/branding/favicon-32.png`" />`r`n  <link rel=`"apple-touch-icon`" href=`"/branding/app-icon-192.png`" />`r`n</head>")
Set-Content -Path $htmlPath -Value $html -Encoding utf8

Write-Host "Fourth Down branding installed." -ForegroundColor Green
Write-Host "Backups saved in branding-backup." -ForegroundColor Cyan
Write-Host "Run npm run build next." -ForegroundColor Yellow
