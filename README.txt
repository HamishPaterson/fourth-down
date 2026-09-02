FOURTH DOWN MATCHUP-COLOUR SCHEDULE

Replace only:

src/pages/Schedule.jsx
src/index.css

Each schedule card now fades from the away team's primary and secondary colours on the left into the home team's colours on the right.
Both team logos also appear as subtle background watermarks.
The live schedule endpoint, week selection, refresh control, local date/time conversion and Matchup navigation are preserved.

Then run:

npm run build
git add .
git commit -m "Add team colour gradients to schedule matchups"
git push
