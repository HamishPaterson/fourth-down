# React + Vite

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
