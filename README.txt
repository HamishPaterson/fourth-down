FOURTH DOWN FAVOURITE-TEAM NAV INSTALLER

1. Extract this ZIP.
2. Copy apply-favourite-nav.ps1 into:
   C:\Users\HamishPaterson\fourth-down
3. From PowerShell in that folder, run:
   powershell -ExecutionPolicy Bypass -File .\apply-favourite-nav.ps1
4. Build:
   npm run build
5. Deploy:
   git add .
   git commit -m "Theme navigation with favourite team colours"
   git push

The script creates backups before changing anything.
It writes a complete replacement src\index.css using your current working stylesheet plus the favourite-team navigation rules.
It also adds getTeamTheme to App.jsx and places the favourite-team variables on app-shell, allowing the header and navigation to inherit them on every page.
