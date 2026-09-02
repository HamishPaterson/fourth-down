FOURTH DOWN DOMINANT TEAM COLOURS

Replace these five files:

src/pages/Home.jsx
src/pages/Teams.jsx
src/pages/TeamDetail.jsx
src/services/teamThemes.js
src/index.css

Changes:
- Every team card on the Teams page uses its own primary and secondary colours.
- Each team card includes a subtle team-logo watermark.
- Favourite-team Home hero and supporting tiles use stronger team colours.
- Franchise hero, summary cards, information cards, ratings, roster tabs, position groups, player cards, and player metadata use substantially stronger colour coverage.

Then run:

npm run build
git add .
git commit -m "Increase team colours across Home Teams and franchise pages"
git push
