FOURTH DOWN FAVOURITE-TEAM THEME

Replace these four files:

src/pages/Home.jsx
src/pages/TeamDetail.jsx
src/services/teamThemes.js
src/index.css

Home now uses the saved favourite team's logo, full team name, primary colour and secondary colour.
Franchise pages use stronger team colour coverage across summary cards, information cards, ratings, roster tabs, position groups, player cards and inner metadata tiles.
The subtle logo watermark remains.

Then run:

npm run build
git add .
git commit -m "Add favourite-team Home and stronger franchise themes"
git push
