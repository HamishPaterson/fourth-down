# React + Vite

## Point-in-time depth charts and personnel

The nflverse depth archive uses `dt` snapshot timestamps, not prediction weeks.
The extractor in `api-lib/depthCharts.js` selects the latest whole team snapshot
at or before each week's first scheduled regular-season kickoff, established from
dated BALLDONTLIE games. No reliable cutoff means no lineup adjustment.
Season filtering uses the timestamp year because this archive has no season column.
Stable ESPN IDs (GSIS fallback), canonical team aliases, latest player ownership,
formation slots and rank prevent archive/transfer/duplicate accumulation.
WR ranks 1/2/3 occupy distinct slots; counting only rank 1 loses legitimate starters.
Optional FB/nickel roles remain separately recorded, not additional base-unit starters.
Conflicting identities/slots and impossible counts invalidate the lineup; counts
are derived, never padded or clamped to 11. Missing names do not erase stable IDs.

Schema-version-2 provenance and count consistency are required by the existing
`.04`/`.3`-cap lineup layer. Legacy `expectedLineup.rows`, `projectedStarters`
and `offensiveLineStarters` are archive aggregates, not current lineups;
`schemaValidated` in the old artifact is insufficient. Only that legacy lineup
contribution is disabled; unrelated NFLverse metrics remain available.

Weekly live QB/injury and roster-rating sources must prove their observation time
is at/before the same cutoff. Later or undated sources are excluded, including in
the secondary matchup path; genuinely current pre-cutoff data keeps existing weights.
Missing QB sources retain available-source renormalization. Missing roster units
are unavailable rather than synthetic average players. Undated current Sleeper
injuries cannot be backfilled into historical weeks. The depth archive itself
contains no injury/availability fields: absent status stays unknown, not confirmed
active. Only explicit contemporaneous status fields can remove a declared starter.
Ambiguous QB depth never selects an arbitrary player; archived QB identity alone
does not prove game availability or supply historical QB-performance adjustments.

After explicit approval, supply `BALLDONTLIE_API_KEY` in the process environment
and run `npm run update:nflverse -- 2026`. This refreshes the whole existing team
artifact, so it is intentionally **not run during the integrity repair**.
Review the resulting weekly cutoffs/counts before deployment. No historical lineup
can be reconstructed from the legacy aggregate alone.

Regression history in `api-lib/fixtures/depth-chart-history.csv` is a verbatim
NYG QB/WR subset of the public 2026 depth archive inspected on 2026-10-14, paired
with first-game kickoffs from BALLDONTLIE for weeks 2 and 6. Synthetic edge-case
tests are separately labeled; they are not claims about actual transfers/injuries.
Schedule revision history and historical injury reports are not available.
Player projections still choose the historical passing-volume leader and require
a separate repair. Tiny lineup signals can be masked or locally reversed by the
existing discrete scoring simulation; this repair does not change that engine.

## Opponent-Network endpoint

`api/nfl/opponent-network.js` uses only completed regular-season BALLDONTLIE games
from the requested season and before the target week. Canonical matchup keys and
source IDs prevent duplicate counting; conflicting duplicates fail to an explicit
neutral response. `prepareNetworkGames` exposes normalized game IDs, teams, scores,
weeks and weights for in-memory provenance tests (not production logging).

The live network is distinct from the checked-in NFLverse opponent-adjusted metrics.
It keeps 32 team nodes, uses each team's latest four games, and propagates offense
and defense around the existing 22-point baseline for 30 mean-centered iterations.
Half-step relaxation prevents a two-cycle that otherwise zeroes one-game networks.
Teams without games remain neutral and are excluded from centering; a matchup
missing either team's history receives an unavailable, zero-confidence layer.
There is no explicit home-field adjustment in this network.

The original tail was truncated in every recoverable revision. Its restored helpers
are **reconstructed, not recovered original formulas**: the existing NFLverse
recency curve `[1, .95, .85, .75]` then `.65` uses age relative to the latest eligible
week; volatility discounts by `22 / (22 + abs(margin))`. Common-opponent performance
is weighted margin plus opponent overall strength, with the mean home-minus-away
comparison capped at one point. Exact historical volatility/common-opponent
coefficients are unavailable; these bounded reconstructions are not calibrated.
The original final difference cap (6), raw point cap (1), confidence formula
and confidence cap (.9) are retained. No new matchup metrics feed scoring.

Game-level scores are not persisted in the generated NFLverse artifacts. Network
regressions use controlled provider fixtures; verifying current live game coverage
requires a working provider response, not inference from NFLverse aggregates.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
