$ErrorActionPreference = "Stop"

$projectRoot = Get-Location
$cssPath = Join-Path $projectRoot "src\index.css"
$appPath = Join-Path $projectRoot "src\App.jsx"

if (-not (Test-Path $cssPath)) {
  throw "Could not find src\index.css. Run this script from the fourth-down project folder."
}

if (-not (Test-Path $appPath)) {
  throw "Could not find src\App.jsx. Run this script from the fourth-down project folder."
}

$cssBackup = "$cssPath.before-favourite-nav.bak"
$appBackup = "$appPath.before-favourite-nav.bak"
Copy-Item $cssPath $cssBackup -Force
Copy-Item $appPath $appBackup -Force

$marker = "/* Favourite-team navigation and header theme */"
$css = Get-Content $cssPath -Raw

if ($css.Contains($marker)) {
  $css = $css.Substring(0, $css.IndexOf($marker)).TrimEnd()
}

$navCss = @'

/* Favourite-team navigation and header theme */
.premium-header {
  border-color: color-mix(in srgb, var(--team-secondary) 38%, rgba(255,255,255,.14));
  background:
    radial-gradient(circle at 10% 0%, color-mix(in srgb, var(--team-primary) 24%, transparent), transparent 38%),
    linear-gradient(100deg, color-mix(in srgb, var(--team-primary) 25%, #0b0b0b), color-mix(in srgb, var(--team-secondary) 10%, #080808));
  box-shadow: 0 16px 48px color-mix(in srgb, var(--team-primary) 18%, transparent);
}

.brand-mark {
  color: #ffffff;
  border: 1px solid var(--team-secondary);
  background: linear-gradient(135deg, var(--team-primary), color-mix(in srgb, var(--team-secondary) 58%, var(--team-primary)));
  box-shadow: 0 10px 28px color-mix(in srgb, var(--team-primary) 38%, transparent);
}

.brand small {
  color: color-mix(in srgb, var(--team-secondary) 82%, white 18%);
}

.header-status-item {
  border-color: color-mix(in srgb, var(--team-secondary) 35%, rgba(255,255,255,.14));
  background: color-mix(in srgb, var(--team-primary) 21%, #111111);
}

.header-status-item svg {
  color: var(--team-secondary);
}

.premium-nav {
  border-color: color-mix(in srgb, var(--team-secondary) 48%, #333333);
  background: linear-gradient(90deg, color-mix(in srgb, var(--team-primary) 35%, #090909), color-mix(in srgb, var(--team-secondary) 18%, #090909));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 14px 34px color-mix(in srgb, var(--team-primary) 28%, transparent);
}

.premium-nav .nav-button {
  color: #d1d5db;
  border: 1px solid color-mix(in srgb, var(--team-primary) 38%, #242424);
  background: color-mix(in srgb, var(--team-primary) 26%, #111111);
  transition: color .18s ease, background .18s ease, border-color .18s ease, transform .18s ease, box-shadow .18s ease;
}

.premium-nav .nav-button svg {
  color: color-mix(in srgb, var(--team-secondary) 78%, white 22%);
}

.premium-nav .nav-button:hover {
  color: #ffffff;
  border-color: var(--team-secondary);
  background: linear-gradient(135deg, color-mix(in srgb, var(--team-primary) 58%, #111111), color-mix(in srgb, var(--team-secondary) 24%, #111111));
  transform: translateY(-1px);
  box-shadow: 0 8px 20px color-mix(in srgb, var(--team-primary) 26%, transparent);
}

.premium-nav .nav-button.active {
  color: #ffffff;
  border-color: var(--team-secondary);
  background: linear-gradient(135deg, var(--team-primary), color-mix(in srgb, var(--team-secondary) 62%, var(--team-primary)));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.18), 0 9px 24px color-mix(in srgb, var(--team-primary) 44%, transparent);
}

.premium-nav .nav-button.active svg {
  color: #ffffff;
}

@media (max-width: 620px) {
  .premium-nav {
    background: linear-gradient(90deg, color-mix(in srgb, var(--team-primary) 42%, #090909), color-mix(in srgb, var(--team-secondary) 22%, #090909));
  }
}
'@

# This writes a complete replacement index.css using the current working stylesheet
# plus the navigation theme, without requiring a manual merge.
Set-Content -Path $cssPath -Value ($css + $navCss) -Encoding utf8

$app = Get-Content $appPath -Raw
$themeImport = 'import { getTeamTheme } from "./services/teamThemes.js";'

if (-not $app.Contains($themeImport)) {
  $lastImport = [regex]::Matches($app, '(?m)^import .+;$') | Select-Object -Last 1
  if ($null -eq $lastImport) {
    throw "Could not locate the import section in src\App.jsx."
  }

  $insertAt = $lastImport.Index + $lastImport.Length
  $app = $app.Insert($insertAt, "`r`n$themeImport")
}

$app = $app.Replace(
  '<div className="app-shell">',
  '<div className="app-shell" style={getTeamTheme(favoriteTeam)}>'
)

Set-Content -Path $appPath -Value $app -Encoding utf8

Write-Host "Updated src\index.css and src\App.jsx" -ForegroundColor Green
Write-Host "Backups created:" -ForegroundColor Cyan
Write-Host "  $cssBackup"
Write-Host "  $appBackup"
Write-Host "Run npm run build next." -ForegroundColor Yellow
