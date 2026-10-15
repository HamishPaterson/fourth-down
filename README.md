# React + Vite

## Matchup Intelligence Phase 1

New predictions with exact-season/week team context include `matchupIntelligence`.
The Matchup page reads this from the prediction itself, never from newer metrics
attached to an older saved prediction. Snapshot selection, locking, persistence,
odds ingestion, Best Bets and Weekly Best Multi selection are unchanged.

Available NFLverse fields:

| Category | Measured attack | Named team's allowance | Metric-specific adjustment |
| --- | --- | --- | --- |
| Rushing | `rushingEpaPerPlay` | `rushingEpaAllowedPerPlay` | `opponentAdjusted.rushingEpaPerPlay` |
| Passing | `passingEpaPerPlay` | `passingEpaAllowedPerPlay` | `opponentAdjusted.passingEpaPerPlay` |
| Success | `successRate` | `defensiveSuccessRate` | `opponentAdjusted.successRate` |
| Explosive plays | `explosivePlayRate` | `explosivePlayRateAllowed` | `opponentAdjusted.explosivePlayRate` |
| Pressure | `pressureAllowedRate` | `pressureGeneratedRate` | None; reuse `pressureMatchup` |

EPA allowance has an offensive sign: **higher allowance helps the named attack**.
Rushing/passing blend 75% raw attack EPA with 25% adjusted attack EPA, then add
the named team's allowance. Success/explosive adjustments are residuals, not
absolute rates: their 25% residual is added to the raw attack rate before allowance.
Both teams are evaluated identically and the difference is centered.
Adjusted defense, when separately unavailable for a category, is not invented.
The score-based live Opponent-Network remains a separate, unchanged model layer.

There are no separate rushing/passing success rates, pass/rush explosive rates,
neutral-situation tendencies, charted pressure or blitz inputs. Pressure remains
the hit-or-sack proxy. Sack counts/rates exist but are not scored a second time.
The team artifact exposes `playsPerGame` but no complete pass/rush counts.
The cumulative volume-leader QB's dropbacks are not a team passing tendency.

Eligible schema-2 player `teamTotals.passAttempts + sacksAllowed` supply observed
dropbacks; these and `rushingAttempts` supply the pass/rush denominator. Mix is
unavailable when exact-week completion/cutoff provenance is missing (currently
weeks 2-5); those weeks are not backfilled. Expected mix starts with observed
style, allows at most 1.5 percentage points from the pass/rush matchup, at most
3.5 points from the baseline expected score gap, and applies existing weather
pass-ratio shift. Pass and rush sum to one, bounded at 30-80% passing.
Expected plays blend measured plays/game and existing pace-based possessions
equally, bounded at 48-82. The baseline is calculated once to avoid a circular
game-script feedback loop. New predictions pass this same mix into player
opportunity allocation; named roles and all player eligibility gates remain intact.
Without proven mix, pass/rush scoring uses fixed conservative half weights,
explicitly not an asserted team tendency.

These signals overlap overall/early-down EPA, success, explosive, coverage,
opponent-adjusted efficiency, scoring baseline and coarse roster-unit layers.
Consequently rushing/passing each cap at 0.20 points per side, success/explosives
at 0.06 each, with a shared absolute budget of at most **one margin point** before
the existing simulation. Sample confidence is capped at 0.8 and limited by both
teams' game/play samples. These are conservative initial coefficients, not fitted
or backtested estimates. The four correlated layers do not count as additional
independent data sources in win-probability confidence; data-health diagnostics
still expose them. No roster-unit multiplier is increased. Existing
pressure scoring is exposed once, not reapplied.

Structured signals record both named interactions, raw/adjusted metrics, exposure,
confidence, centered model points and the final expected-margin change from
removing only that layer. These ablations include existing saturation, rivalry,
weather and scoring simulation, so they are not additive final-score promises.
Unsupported, rounded-zero, <0.01-point or simulation-direction-reversed final-margin
effects cannot generate a matchup explanation. Deterministic templates use actual team names; no LLM call
or unsupported blitz/deep-pass/third-down/red-zone claims are generated.
The Matchup presentation further requires an absolute final-margin ablation of
at least 0.05 points. Smaller signals remain in scoring and structured diagnostics,
but neither Key Matchup Advantages nor the named-team lean summary displays them.
Lean reasons are selected only from the material factors actually displayed.
The page translates those structured metrics into named-team football prose;
raw values and layer-removal diagnostics remain in the prediction, not the
Matchup cards. Game style describes supported tendencies and game script rather
than presenting a percentage table. The scoring-component box is not displayed;
scoring and player-touchdown calculations are unchanged.
An old snapshot without structured signals does not receive new matchup explanations.
No artifacts or saved predictions are regenerated by this feature.

## Matchup Intelligence Phase 2A: third down and red zone

### Protected prediction-only refresh

Temporary administrative action:
`/api/nfl/game-stats?action=admin-prediction-refresh`. It rejects environments
other than `VERCEL_ENV=production` and requires a dedicated Production-only
`PREDICTION_REFRESH_TOKEN` in the Authorization Bearer header, never CRON_SECRET.
Provision the token securely; never place it in a URL, browser bundle or logs.
GET always dry-runs, ignoring write query parameters and request bodies.
POST requires `Content-Type: application/json` and exactly `{"dryRun":false}`.
No cron is registered. No Production invocation is part of installation.

This temporary action is restricted to all 14 games in 2026 Week 6. It uses the
same generation, whole-batch validation and persistence implementation as the
protected refresh below. A save attempt returns 409 before generation when all
14 authoritative records already pass current feature/schema, network, player,
candidate-pool and score consistency validation. Otherwise all 14 predictions
are generated and validated before the first write. Responses contain aggregate
counts/versions and failed game/reason diagnostics, not input payloads or secrets.
This is a completed-batch idempotency guard, not an atomic concurrent-job lock;
invoke saves serially. Existing per-record optimistic writes are nontransactional.
Record/verify the locked Multi externally; the action never accesses its table.
Remove this temporary action and its dedicated environment token after the
successful Production refresh and verification.

`/api/nfl/game-stats?action=refresh-predictions` requires `Authorization: Bearer <CRON_SECRET>`.
GET and POST default to an in-memory dry run; only POST with JSON
`{"dryRun":false}` saves. No cron invokes this route. Do not call the write mode
without explicit approval.

The refresh loads the complete current-week schedule and stored core/player odds,
loads completed season games once, and computes one validated 32-team weekly
Opponent-Network for every game. There is no persistent network cache. Provider
pagination is sequential, paced at 12.5 seconds, with up to three same-page 429
retries honoring Retry-After seconds/dates; fallback backoff is bounded at eight
seconds with small jitter. HTTP failures and non-JSON/malformed responses fail
explicitly without parsing provider error text as JSON.
Both server functions allow 60 seconds. Schedule requests have a 55-second
budget and a ten-second per-request timeout; a Retry-After longer than the
remaining budget fails explicitly rather than retrying early or using partial data.

Prediction feature version 1 and Matchup Intelligence schema version 2 are stored
in existing snapshot JSON (no database migration). Required Phase 1/2A, successful
network state, player projections, current qualified-candidate pool and score/
probability consistency are checked for the entire batch before any writes.
Complete current-feature authoritative records are reused regardless of age;
pre-feature records can upgrade before kickoff, but browser partial records
cannot replace authoritative records and frozen/graded records cannot upgrade.
All predictions remain model-v11; scoring formulas are unchanged.

This path reads/writes only prediction snapshots, apart from reading stored odds
and other model inputs. It never prepares/selects/locks a Weekly Multi or calls
SharpAPI. Persistence uses existing optimistic per-record writes, not a database
transaction: a storage failure after validation may leave some records refreshed;
it reports an error and a subsequent run reuses complete records. The locked
Weekly Multi is independent and untouched.

Phase 2A requires `situational` schema-1 team data. The regenerated checked-in
artifact supports all 32 teams for Week 6; Weeks 2-5 remain unavailable because
their situational evidence was observed after those historical cutoffs. Saved
pre-Phase-2A predictions remain unchanged until an authorized prediction refresh.

The extractor audits non-null raw-field coverage, joins regular-season games to
proven final-status schedule observations before the weekly first kickoff, and
deduplicates game/play IDs. Conflicting identities fail generation. Completion
observations and source observation time are retained. Later source snapshots
are not represented as pre-cutoff historical evidence. Runtime rejects wrong
season/week, mismatched cutoffs, future/duplicate provenance and invalid counts.
The existing garbage-time-filtered Phase 1 extraction and formulas are unchanged.
Situational extraction instead examines complete raw drives: filtering a drive
by win probability would bias both entry counts and terminal outcomes.

Third-down denominators require a real run/pass, down 3 and exactly one of
`third_down_converted`/`third_down_failed`. No-plays, kneels, spikes, unresolved
teams/outcomes and future games do not count. Accepted penalties can count only
with a non-nullified, resolved opportunity; nullified penalty plays cannot.
Offensive conversions equal the matched defensive conversions allowed.
Distance diagnostics are short **1-3**, medium **4-6**, long **7+ yards**;
unknown/zero distances stay outside buckets. Buckets have **zero model weight**.

Red-zone trips require a real eligible snap starting 1-20 yards from the goal
line, grouped once by game and `fixed_drive`, and a consistent known
`fixed_drive_result`. A TD additionally requires an observed offensive touchdown
credited to that possession team somewhere in the complete drive, including
after leaving the red zone. Missing/conflicting outcomes or possession are
excluded with counts, not counted as failures. Defensive TDs are not offensive
TDs; field goals are completed non-TD trips. This is TDs/trip, not scoring/drives.
Run/pass and field-goal/punt scrimmage snaps can establish entry; kickoffs and
extra points cannot. An immediate known field goal inside the 20 is not lost
merely because that possession had no earlier run/pass snap in the red zone.
The raw source's nonexistent `drive_result` is not used.

For each metric, use the eligible league rate `L` (at least 100 third downs or
40 red-zone trips). Each offense and allowance rate is regressed with
`r = (conversions + k*L)/(opportunities + k)`, with `k=40` third downs and
`k=16` red-zone trips. Match each named attack to the other named team's
allowance: `I = ((r_off-L) + (r_allowed-L))/2`. Larger allowances help that
attack, not that defense. Confidence is the minimum of all four relevant
`n/(n+k)` values, capped at .85. Both metrics must have valid matched samples;
tiny samples are strongly regressed and receive little weight.

Each home-side point contribution is
`clamp(1.5 * confidence * (I_home-I_away)/2, -.125, .125)`;
away receives its negative. Thus the individual margin cap is **.25 points**.
The two effects share an absolute **.4-point pre-simulation margin budget**,
including opposing effects, with a .004 rounding reserve (scale summed absolute
home points to .198 before three-decimal engine rounding).
These are conservative initial weights, not fitted historical coefficients.
The averaging of attack/allowance, shrinkage, confidence attenuation and shared
cap limit overlap with EPA, success, scoring-drive rates and scoring baseline.
The existing offensive-only situational layer is preserved, not duplicated at
full strength or reweighted. Phase 1 formulas, its diagnostics (evaluated before
Phase 2A), pressure and Opponent-Network are unchanged. Phase 2A adds no independent
win-probability confidence source.

`matchupIntelligence.situational` retains per-team offense/allowance counts and
rates, regression, league rate, confidence, uncapped/capped centered points,
shared scale and the total final-margin ablation against Phase 1. Each signal
also records its actual one-layer final-margin removal effect with both new
signals in place; these effects need not add exactly after simulation.
The normal page shows only named-team football prose under THIRD-DOWN ADVANTAGE
or RED-ZONE ADVANTAGE when confidence is at least **.40**, direction agrees and
absolute final-margin ablation is at least **.05 points**. No empty situational
cards or raw diagnostics appear. Phase 1 displayed factors retain their slots;
lean reasons rank material effects, so weaker situational effects cannot displace
stronger Phase 1 reasons. Unsupported old saved predictions are never retrofitted.

## Weekly Best Multi locking

The intended lock is Thursday 10:00 **AEST**, fixed UTC+10
(`Australia/Brisbane`, not daylight-saving Sydney time). The lock calculation
uses Thursday 00:00 UTC. Hobby cron times are **hour windows, not exact invocation
times**. The authenticated `/api/weekly-multi/prepare` job runs Wednesday within
23:00-23:59 UTC (Thursday 09:00-09:59 AEST); daily invocations on other days are
no-ops. Required market jobs run earlier; the last is player completions in the
22:00 UTC hour. Rush attempts moved from 23:00 to 10:00 UTC. Preparation always
checks stored snapshot freshness, rather than assuming the jobs ran in order.

`/api/weekly-multi/lock` runs Thursday within 00:00-00:59 UTC, with a second
01:00-01:59 UTC invocation for retry/finalization. Other days are no-ops.
Both lock invocations execute the same protected orchestration:
1. Resolve season/week from scheduled games; return any immutable existing Multi.
2. Require all games to be pre-kickoff and both stored odds sets to be fresh.
3. Generate predictions using `getFullGamePrediction` and its existing model,
   player projections and Best Bets. Server input adapters call existing handlers;
   no browser, alternate prediction formulas or SharpAPI calls are involved.
4. Validate the entire generated batch before writing. Save current complete
   authoritative snapshots, then re-read and verify eligibility for every game.
5. Only after successful persistence, invoke the existing selection/lock logic.

Preparation and lock do not race: **each lock request waits for its own preparation
and persistence verification**. An early, late, missing or failed preparation job
cannot make an unprepared lock proceed. Optimistic compare-and-swap writes and
unique insert recovery preserve the first fresh complete server candidates across
concurrent invocations. Stale model-v6 and incomplete score-only snapshots cannot
block upgrades. Browser saves cannot replace server-owned records; final and
post-kickoff predictions are protected. A shared snapshot builder is used by
both the browser's full Predictions pipeline and the server refresh.

The authoritative lock timestamp remains 10:00 AEST. Hobby cannot guarantee actual
execution at that instant, nor generation before it; late execution is reported,
never backdated. The existing 10:30 AEST deadline still governs partial selections;
the second cron finalizes when invoked after it and before kickoff. Failed
generation or persistence **never** finalizes an unsafe empty Multi. With complete
predictions but insufficient eligible bets, the existing honest partial/zero-leg
record is allowed at the deadline, with its reason. `dryRun=1` validates generation
and selection without saving predictions or locking.

Deploy with production cron execution, `CRON_SECRET`, Supabase service-role
select/insert/update permissions for predictions (plus select/insert for Multis),
and the existing provider credentials configured. The schedule function includes
the roster ratings file and uses a 60-second limit. Keep validated exact-week
team/player artifacts current; this pipeline does not regenerate them.
Apply `supabase/weekly_best_multis.sql` before enabling the pipeline on legacy
databases. It adds the lock metadata columns without rewriting any existing
records, enforces the season/week unique key, retains immutability and reloads
the PostgREST schema cache. Orchestration checks this schema before generating
predictions, so an outdated deployment fails explicitly without needless refreshes.
Retries reuse eligible complete authoritative predictions. Legacy Best Bets
payloads can receive a server-only candidate-version upgrade using stored odds,
the same saved projections and verified exact-week depth charts; scores, model
version and prediction generation timestamp do not change. Frozen/post-kickoff
records and existing Multis cannot receive this upgrade.
Safe stage/count/freshness/status logs expose failed preparation and persistence.
Reading the page only polls shared storage; it does not generate or lock a Multi.
All devices read the immutable `weekly_best_multis` record. The unique
season/week constraint and duplicate-insert recovery keep concurrent invocations
on the same record; neither a page refresh nor new odds reconstructs it.

Best Bets persists its full qualified candidate set separately from its capped
display recommendations. Weekly Multi ranks that complete pool by EV, edge and
model probability, without per-family quotas: multiple receiving or rushing
props may coexist from different games. Moneyline matching uses exact canonical
team identity, never a substring such as NE inside New York Jets.
Verified point-in-time depth charts for both teams satisfy candidate personnel
readiness when live injury/performance enrichment is unavailable; they do not
claim injury coverage or change the saved scoring model. Missing, future-dated
or wrong-week depth evidence still withholds bets, and player role/data-quality
floors and minimum edge/EV are unchanged.
Player-prop model probabilities currently use fixed logistic scales and require
future point-in-time calibration against full-game results and historical lines.
They are mechanically reproducible model estimates, not historically calibrated
win rates or proven hit rates.
Stored offers retain allowlisted provider quote IDs, original decimal/American
prices, line, period, activity/main-line flags and quote/fetch timestamps.
Best Bets candidate version 3 validates offers before consensus selection or EV
ranking; Weekly Multi independently validates the current matching offer and
requires its actual price to match the saved candidate.
Quarantined offers remain in `bestBets.quarantinedOffers` with specific reasons
and evidence, but never enter displayed recommendations or the qualified pool.
No provider price is rewritten and there is no maximum-odds cap.

Pair validation requires matching event/player/market/period/classification,
line and provider market ID where supplied. Missing sides are rejected when a
source explicitly requires pairs, or at least two observed groups are paired
and at least 80% of that book/market's groups contain both sides; a normally
one-sided feed is not treated as a missing-pair error. Gross paired implied
probability sums below 0.90 or above 1.25 are quarantined (stored Week 6 pairs
range from 1.0559 to 1.0656). Decimal/American conversion allows 0.0051 decimal
rounding tolerance. Same-line cross-book outliers require two independent peers
agreeing within five probability points, a discrepancy over twenty points and
at least a threefold probability ratio. Different lines are never equivalent:
ladder inversions require a lower Over/higher Under with over twenty points
less implied probability and at least three times the decimal payout.
Alternate/main and period scopes are kept separate. Inactive/live, unsupported,
invalid-priced, stale (over 30 hours) or future-dated (over one minute) offers
are withheld; missing legacy metadata is not represented as provider-verified.
There is at most one Anytime TD leg and one leg per game. An unpriced TD is
evaluated using TD probability times role confidence, ranks after priced value
bets, and never receives invented odds, edge or EV. Probability gates still
relax from 65% to 55%. Normal success requires exactly five distinct-game legs;
proven input/market insufficiency is reported as an exceptional honest partial,
never padded to five.
Missing or invalid leg odds display "Odds unavailable"; combined odds remain
"Pending" until every leg has a usable finite price.

Predictions and Matchup use the same complete shared prediction, including its
version and timestamp. Displayed totals are the sum of the saved scores.
Matchup does not generate or save pre-kickoff partial predictions. Current
market displays use canonical team identity, orientation and kickoff matching;
the market pick comes from genuine moneyline prices, not a spread-derived score.
The read handler owns cache headers and sets them before sending its response.

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
Tiny lineup signals can be masked or locally reversed by the
existing discrete scoring simulation; this repair does not change that engine.

## Point-in-time player projections

Player metrics now require schema 2, the exact season/prediction week and the same
weekly cutoff as the depth lineup. Older-week fallback and the legacy checked-in
player artifact are rejected with explicit reasons, not silently treated as current.
Game provenance records source game IDs, participants, week, kickoff and a proven
final-status timestamp (`completed_at`, or conservatively `updated_at` on a final
schedule record). Undated/unproven completions, future games and postseason are
excluded. Missing eligible PBP coverage or conflicting duplicate plays fails
generation explicitly; identical plays/games are counted once.

The latest eligible depth snapshot also retains its full deduplicated roster,
without changing starter counts or personnel weights. Stable GSIS identity and
current team ownership gate all named players, including reserve RB/WR/TE roles.
An ambiguous QB slot suppresses QB identity, not independently valid non-QB roles.
The verified weekly QB supersedes the passing-volume leader and uses only their
own eligible passing/sack/rushing/scramble profile. Team/game-script opportunity
volume and existing pass/run/pressure matchup coefficients remain unchanged.
No verified QB or no eligible own passing sample means **no named passing
projection**; independently supported receivers/rushers can remain. Receivers
then use observed aggregate team passing context, not an invented named QB.
Unavailable/unsupported players are excluded and supported opportunity shares
renormalized. A transferred player's old-team profile is not transplanted.
Recent usage uses the last two actual team games, including zero-usage games,
not the player's last two appearances. Explicit pre-cutoff statuses retain the
existing availability rules; unknown health remains explicitly unknown.

There is no new statistical regression prior: existing rate caps and sample/role
confidence remain; no-sample named projections are omitted. Interceptions and
scrambles are retained as profile evidence, not new scoring interactions.
The Anytime TD equation remains `1 - exp(-expectedTDs)`. Dedicated scorer ranking
uses TD probability times role confidence; data quality does not multiply into
the scorer score. Displayed probability remains the raw model TD probability.
Unsupported roles/identities do not produce a scorer.
Best Bets and Weekly Best Multi continue consuming the same downstream outputs.

After explicit approval, regenerate depth context using
`npm run update:nflverse -- 2026`, then player metrics using
`node scripts/update-nflverse-players.mjs 2026`, with `BALLDONTLIE_API_KEY` set.
NFLverse downloads need no key. Both existing production artifacts remain untouched
during this repair. Regeneration rebuilds available weekly entries, not saved
predictions. Historical reconstruction requires archived depth plus proven
pre-cutoff final timestamps; missing completion evidence cannot be invented.
Generation may occur later than the cutoff, but included games must have proven
earlier completion. Revised PBP/schedule sources are not an immutable historical
as-observed archive, so exact historical source-version reproducibility is not
guaranteed. No arbitrary stale-days threshold is used: exact-week coverage and
source/game provenance, rather than a recent file timestamp alone, are required.

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
