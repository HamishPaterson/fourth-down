FOURTH DOWN MONOCHROME THEME

Replace these two files in your project:

src/pages/TeamDetail.jsx
src/index.css

The app becomes black, white and grey globally.
A selected franchise page uses that team's local PNG logo as a large grayscale background watermark.
The normal foreground team logo remains visible.

Then run:

npm run build
git add .
git commit -m "Apply monochrome theme with team logo backgrounds"
git push
