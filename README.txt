FOURTH DOWN VISUAL OVERHAUL

Replace these files in your existing project:

src/components/Header.jsx
src/components/Navigation.jsx
src/pages/Home.jsx
src/pages/TeamDetail.jsx
src/index.css

This package is compatible with the current App.jsx props:
- Header receives onHome
- Navigation receives page and onChange
- Home receives favoriteTeam and onNavigate
- TeamDetail receives team and onBack

Then run:

npm run build
git add .
git commit -m "Apply Fourth Down premium visual overhaul"
git push
