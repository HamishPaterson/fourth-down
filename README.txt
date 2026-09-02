FOURTH DOWN CORRECTED BRANDING

This intentionally changes only:
- src/components/Header.jsx
- src/index.css branding section
- index.html favicon/title
- public/branding assets

It does NOT change Home.jsx, App.jsx, Navigation.jsx, Teams.jsx, TeamDetail.jsx, Schedule.jsx, or Matchup.jsx.

INSTALL
1. Extract this ZIP.
2. Open PowerShell in C:\Users\HamishPaterson\fourth-down
3. Run:
   powershell -ExecutionPolicy Bypass -File "C:\path\to\fourth-down-corrected-branding\apply-corrected-branding.ps1"
4. Build:
   npm run build
5. Deploy:
   git add .
   git commit -m "Apply corrected Fourth Down header branding"
   git push

Backups are created in corrected-branding-backup.
