# Copilot Instructions

## Project Guidelines
- For Weekly Best Multi, do not expose or persist a top-15 audit table. Keep five legs, use market-specific recommendation.modelProbability, require positive edge at every threshold, rank by expected value/edge then model probability, enforce one leg per matchup and exclude stale/fallback data. Relax the probability threshold from 65% by 2.5 percentage points until five legs or a 55% floor; show any fewer qualifying legs without padding and display the final threshold. Keep changes isolated to Weekly Best Multi and preserve ticks/crosses.

## General Instructions
- After each task or step, provide a brief synopsis of what was done and clearly state what is required next; for staged work, stop after the current step and wait for the user's next instruction when requested.