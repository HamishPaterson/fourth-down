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

## Odds provider migration — Phase 1

Phase 1 adds a server-only, provider-neutral odds domain and an explicit
ParlayAPI adapter under `api-lib/oddsProviders/`. The adapter supports events,
core odds and player props, preserves provider/raw-market provenance, and maps
only the Parlay market keys established by the provider audit. Unknown market
variants remain distinct unless a future adapter configuration explicitly
registers an alias.

This phase is **not a production cutover**. Existing SharpAPI snapshots and
routes remain the active rollback path; normal browser reads remain cache-only.
The new controlled refresh service is not called from UI, prediction, Best Bets,
Weekly Multi, or cron handlers. Production storage is not connected. Adapter
tests use mocked fetch responses and must never contact a live provider.

Normalized snapshots require explicit completeness evidence before replacing a
known-good complete snapshot. The in-memory repository is the storage-boundary
reference implementation. Parlay props pages are sequential, counted
individually, never retried automatically, and guarded by a maximum-page limit,
offset-loop protection, and the configured credit budget. Missing/unusable
completeness headers remain `UNKNOWN`.

Server-side configuration is reserved for a later approved cutover:

```text
ODDS_PROVIDER_PRIMARY=parlay
ODDS_PROVIDER_FALLBACKS=theoddsapi,propline
PARLAY_MONTHLY_CREDIT_LIMIT=1000
PARLAY_AUTOMATIC_CREDIT_BUDGET=800
```

The provider-selection settings are not wired into current production reads.
Credit limits default to zero in code, so paid refreshes fail closed until
explicitly configured. `PARLAY_API_KEY` is read only by the server-side adapter
and must never use a `VITE_` prefix or be exposed to browser code.

### Phase 2: persistent boundary (not activated)

`supabase/odds_provider_cache.sql` is an **unapplied**, additive migration.
Do not execute it against Production in this phase. The existing Sharp table's
conflict key is `(sport, season, week, market)`, which excludes provider, bookmaker,
player, side and line. Reusing that upsert would overwrite other providers and
cannot atomically publish a multi-market refresh. The separate provider tables
leave Sharp's schema, routes, reads and writes unchanged.

The new Supabase repository uses the existing server-only service-role client
pattern. Normal cache readers contain no provider dependency. They read only the
current promoted COMPLETE generation, preserving prior complete data on failure,
with stale/attempt diagnostics and optional event/market/player filtering.
Quote identity includes provider, scope, event, bookmaker, canonical/raw market,
player, selection, side and line, never a timestamp or price. Each generation
retains history; new prices do not mutate earlier generations or copied Multi
quote locks. Refresh IDs are included in future quote-lock copies.

The explicit refresh pipeline validates authoritative event/week/team context,
all requested event/market coverage, prices and player eligibility, writes a
candidate, reads and validates it again, then atomically promotes a fenced current
pointer. Candidates and partial page sets are never visible as current. Older
provider timestamps cannot replace matching current quotes. No cross-provider
price blending occurs. Missing full coverage deliberately blocks promotion;
an operator must investigate rather than pad missing events or markets.

Database-clock 120-second leases use owner tokens, renewal before every paid page,
owner-only release and expired-lease recovery. Credit reservations use a
provider/month PostgreSQL advisory transaction lock, so different resources and
server instances share the same budget. Each props page reserves 3 credits; the
US h2h/spreads/totals request reserves 3. No request is intentionally dispatched
when its documented maximum would exceed the monthly limit or, for automatic
calls, the automatic budget. This cannot guarantee that unexpected provider
overcharges never exceed those limits after dispatch. Actual charges are recorded
honestly, never clamped: `expected_credits` retains the reservation,
`observed_credits` retains the actual charge, and `overrun_credits` records any
positive difference. `COST_OVERRUN` atomically suspends all later paid automatic
and manual calls for that provider/month, including previously reserved calls
that have not dispatched. There is no automatic paid retry.
Outstanding dispatched requests also block later paid reservations and dispatches
until reconciled, serializing paid calls across scopes for that provider/month.
If their owner/lease is lost, the next paid attempt atomically records
`CHARGE_UNKNOWN` and sticky suspension before refusing the call.

An unknown post-dispatch charge, even for a successful response, retains the full
reservation as `CHARGE_UNKNOWN` and also suspends paid calls. Later exact evidence
can reconcile the charge but never silently clears suspension. Only a known
pre-dispatch failure releases its reservation (`PRE_DISPATCH_FAILURE`). A worker
crash never automatically releases possibly consumed credits. Suspension is
sticky; this phase exposes no administrative reset RPC or route. Any future reset
must be separately authorized and auditable. Cached COMPLETE generations remain
readable. Reconciliation is idempotent. Unbound repositories
cannot be used for paid adapter calls. Explicitly free events calls are logged
without paid reservations, retain the adapter timeout, and are not retried.

`createProviderRefreshOperation` is a server-only operation factory, **not a new
public API route or cron**. It requires POST and the existing timing-safe
`Bearer CRON_SECRET` operational authorization. Supply a trusted server context
loader (authoritative event mappings and exact-week player artifact); request
bodies cannot supply identities, credentials or budgets. No default context
loader or application/cron wiring is activated in this phase.

Refresh reasons are machine codes only: `SCHEDULED_REFRESH`,
`MANUAL_ADMIN_REFRESH`, `INITIAL_PROVIDER_VALIDATION`, or `RECOVERY_REFRESH`.
The operation, domain, repository and SQL reject all other values, including
free-form request text. Persisted failures use a bounded allowlist of failure
codes and structured HTTP/usage state, not exceptions, headers, provider bodies
or remote messages.

- `plan`: no provider calls or writes; reports minimum/maximum estimated credits.
- `dry-run`: requires a server-supplied fixture; validates without repository
  creation, provider calls, quote writes, promotion or ledger writes. Live paid
  dry runs are intentionally disabled because usage must not escape accounting.
- `persist`: explicitly authorized only; distributed lease, per-page reservation,
  candidate validation and atomic promotion. Do not invoke live in Phase 2.

The migration grants RPC execution and table reads only to `service_role`; clients
cannot mutate tables directly. No credentials or request headers are persisted.
Tests use mocked fetch and a local embedded PostgreSQL fixture (`@electric-sql/pglite`)
to execute the migration and transactional RPCs without contacting Supabase.
This local engine queues requests; multi-instance fencing/reservation tests verify
database state transitions, not a production multi-connection load test.

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

Legacy saved Anytime TD empty states are normalized at the Predictions display
boundary using only saved TD projections, personnel evidence, quotes and
TD-specific rejection diagnostics. Current structured reasons remain authoritative.
Unknown or mixed evidence produces an honest aggregate unavailable state; this
compatibility path never recovers a betting candidate, recalculates model output,
fetches providers or rewrites a saved prediction. Empty betting probabilities
display `Unavailable`, not a fabricated zero.

Completed games remain on Predictions below incomplete games in kickoff order.
The View dropdown's Completed Games option filters the same loaded rows. Final
status and scores reuse the Results schedule source; matching includes season,
week, ordered team codes and kickoff, never display names or elapsed time.
Completed cards retain the saved projection alongside a separate final score and
pick outcome (ties remain neutral). Their saved Best Bets are historical only:
current-market display reassessment is skipped and no forecast is regenerated.
The Results page's grading and persistence behaviour is unchanged.

The Predictions page consumes the returned shared ledger directly, even when
browser storage is full or unavailable. Saved Best Bets remain display-only:
each saved candidate must retain a validated current quote at the same bookmaker,
selection, line and price, plus existing eligibility/edge/EV gates. The page requests a read-only current betting assessment using the existing saved
model output, verified lineup evidence and stored quotes; it does not generate
predictions, fetch providers or write saved rows. Changed quotes require that
assessment rather than borrowing a saved line's probability. Highlights
use qualifying candidates only, never legacy highlight-only rejected offers.
The current display list includes every qualifying candidate, so a one-game
recommendation shortlist cannot hide an independently eligible spread.

## Matchup Intelligence Phase 2A: third down and red zone

### Protected prediction-only refresh

The existing refresh route saves one snapshot at a time; it is not an atomic
weekly replacement. The trusted-server module `api-lib/atomicPredictionWeek.js`
instead validates a complete, unchanged 14-game 2026 Week 8 batch and calls
`replace_prediction_week` once. It has no browser endpoint and never retries.
Apply only the reviewed `supabase/atomic_prediction_week.sql` migration before
using this module. The additive RPC is executable only by `service_role`.
It checks the database-issued preflight fingerprint, takes a transaction advisory
lock and a short table write fence (also covering existing single-row writers),
upserts on `(season, week, away_code, home_code)` without changing existing row
UUIDs or creation timestamps, and verifies all 14 plus their complete payload
fingerprint before commit. The locked existing manifest must match, so this
repair cannot add an unexpected game. Other weeks are never updated. Function
owners are `postgres`, execution is security-invoker, and `search_path` is limited
to `pg_catalog` with application objects schema-qualified. Existing prediction
RLS and browser read policy are unchanged. Failure rolls back prediction
writes in a subtransaction and commits only a bounded rejection audit; transport
or outer-transaction failures may also roll back that audit. Replayed operation
IDs, changed fingerprints, frozen/graded rows, and incomplete batches fail closed.
The table write fence briefly serializes unrelated prediction writers, but does
not change the existing single-snapshot persistence contract.

`/api/nfl/game-stats?action=refresh-predictions` requires `Authorization: Bearer <CRON_SECRET>`.
GET and POST default to an in-memory dry run; only POST with JSON
`{"dryRun":false}` saves. No cron invokes this route. Do not call the write mode
without explicit approval.

Normalized refresh games retain the authoritative schedule `id` as a positive
integer string through generation and the saved snapshot's `game.id`. Missing or
malformed IDs, conflicting season/week/team/kickoff provenance for one ID, and
different IDs for the same matchup fail before generation. The audited CHI–SEA
reconciliation receives that canonical ID; it is never reconstructed from names.
Saved-bet reassessment and client quote validation share `savedGameIdentity`:
only `snapshot.game.id` supplies schedule identity, while the top-level snapshot
ID remains prediction-record identity. Missing or conflicting canonical context
fails closed with an explicit error or candidate diagnostic.

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

By default this path writes only prediction snapshots, apart from reading stored odds
and other model inputs. It never selects/locks a Weekly Multi or calls
SharpAPI. Persistence uses existing optimistic per-record writes, not a database
transaction: a storage failure after validation may leave some records refreshed;
it reports an error and a subsequent run reuses complete records. The locked
Weekly Multi is independent and untouched. The explicit future-lock option below
also saves an immutable expected-game plan. Week 7 prediction refreshes are prohibited.

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
Both invocations now execute the same **saved-state-only** audited pipeline:
1. Record the invocation and authorization outcome; return any existing immutable lock.
2. Read the pre-lock immutable expected-game plan and saved predictions.
3. Read normalized persisted core/prop quotes, without calling any odds provider,
   fetching a schedule, generating predictions or repairing candidates.
4. Append a sanitized immutable input manifest before selection; evaluate readiness.
5. Append the result manifest, then insert a lock only with five eligible unique
   matchups. Insufficient candidates leave no fabricated partial/empty lock.

Before the scheduled lock, a separately authorized administrator must prepare the
complete current-model prediction batch. Use the existing protected prediction-only
refresh with JSON `{"dryRun":true,"prepareWeeklyLock":true}` first. Only an
explicitly approved POST with `{"dryRun":false,"prepareWeeklyLock":true}` writes:
it verifies pre-lock authoritative provenance, saves predictions, re-reads the
complete batch, and saves the immutable expected-game plan. This is **not** a cron
or page action. It may acquire the existing model's inputs; never invoke it as
part of a read-only readiness check. Keep exact-week team/player artifacts and
persisted Sharp quotes current through separately approved upstream operations.
No source-data regeneration is performed here. Conflicting plans fail rather
than being overwritten. An interrupted batch has no ready plan until verification
succeeds. Explicit pre-lock refreshes may replace stale/unproven server snapshots;
ordinary refresh reuse rules remain unchanged.

`evaluateWeeklyMultiReadiness` in `api-lib/weeklyMultiReadiness.js` is pure and
read-only. Supply the saved plan, saved prediction rows (via `savedPredictionRows`),
persisted normalized odds, and an explicit clock. It returns READY, NOT_READY,
DEGRADED_NON_BLOCKING or UNKNOWN, expected/saved/authoritative/current-model/
complete counts, per-market freshness, projection/personnel/availability coverage,
eligible bets, unique matchups, five-leg feasibility and bounded blocking reasons.
It performs no refresh, provider request or database write.

Every selected quote must match its exact bookmaker, market, selection, line,
price, ID and original timestamp. Both quote and snapshot capture must exist
before the cutoff. Aggregate stale/missing-market diagnostics remain intact;
stale totals do not veto unrelated fresh moneyline/spread legs. However the
existing model can use spread/total calibration: recorded model dependencies
must themselves remain fresh. No scoring formula was changed. Unknown personnel
does not become eligible: only verified AVAILABLE, EXPECTED_ACTIVE or QUESTIONABLE
players with existing role/identity/point-in-time eligibility can qualify.
Player roles retain the existing 55% confidence floor; availability evidence older
than seven days, or observed after the applicable cutoff, remains ineligible.
The dedicated Anytime TD card is an independent Model Pick (`anytimeTdModelPick`),
not the priced betting output (`anytimeTdScorer`). It ranks saved TD probability
first, with role confidence (55% minimum) as eligibility and a tie-breaker, using
the existing model/role/data-quality confidence calculation. A resolved matchup
identity and supported pre-cutoff projected role are required. Confirmed inactive,
conflicted, stale or unsupported players are excluded. Unknown health is disclosed
and may retain a supported model projection; it is never relabelled active and
does not grant priced betting eligibility. No bookmaker price, edge or EV is
needed to select the model player. An independently validated current price may
be displayed for that same player, but never changes the selection.

The separate priced TD output retains identity, event/team, personnel, role,
probability, freshness, positive-edge and existing edge/EV gates. Supplied
malformed prices (including zero and non-finite values) are INVALID_PRICE, never
missing prices or a model-only betting fallback. Primary reason order is projection,
identity, availability, role/quality, invalid price, stale price, missing price,
non-positive edge, probability, edge/EV thresholds, then the aggregate empty state.
Legacy saved diagnostic codes remain readable; new records use explicit
PLAYER_IDENTITY_MISMATCH, PLAYER_AVAILABILITY_UNKNOWN,
PLAYER_PROJECTION_UNAVAILABLE and ROLE_CONFIDENCE_INSUFFICIENT codes.

Server provenance requires prediction ID, current model identity, complete inputs,
generation cutoff and server authority. Predictions must have been generated
strictly before the scheduled cutoff and within 24 hours. Browser saves cannot
claim or replace server provenance, including while adding final results.
Later predictions/quotes cannot fill missing lock-time evidence. Historical
Week 7 and all earlier missing locks remain prohibited; existing records and
displays are not rewritten. Late successful retries report actual execution time
and generated-late state, never backdate generation.

**Deployment prerequisite (not applied by this change):** after the existing
`supabase/weekly_best_multis.sql`, separately review/apply
`supabase/weekly_multi_lock_audit.sql`. It creates append-only service-role-only
plans, manifests and execution events, adds the immutable manifest reference to
future locks, and rejects historical or incomplete new locks. Missing audit
storage fails closed. This is unrelated to the dormant Parlay provider-cache
migration; do not apply that migration or activate Parlay for this repair.

`dryRun=1` on prepare/lock evaluates saved inputs and appends audit evidence but
does not save predictions or a Multi. Capture/result manifests retain safe
prediction/quote IDs, timestamps, ranking inputs, identity/availability states,
candidate rejections and selected offers; no raw provider bodies, credentials,
request headers or exception text are stored. Manifest payloads carry SHA-256
digests and are immutable alongside execution events.

For scheduler diagnosis query `weekly_multi_lock_executions` ordered by `id`,
filtered by `scheduled_at`, then group by `operation_id`.
`summarizeLockExecution` distinguishes authorization failure, handler failure or
incomplete execution, readiness failure, no eligible candidates, existing lock,
and success. Missing records mean UNKNOWN/NO_INVOCATION_RECORDED, **not proof**
that the scheduler never invoked; correlate with platform scheduler logs.
Safe structured console events remain useful if audit storage itself fails.
The Thursday 10:00 Brisbane schedule and Sharp-backed production provider are
unchanged. Hobby invocation windows still cannot guarantee exact-second execution.
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

Team PBP regeneration now gates each prediction week's sample on matching
regular-season games with completion observations at or before its kickoff cutoff
and source observation. Recency is anchored to the latest game week in that
eligible sample, never the latest week in the download. Existing multipliers
remain 1.00, 0.95, 0.85, 0.75 and 0.65 for older weeks. An empty sample has no
recency reference and no fabricated numeric performance. The artifact still retains
independently eligible canonical team, lineup, personnel and kicker-identity context;
PBP, opponent-adjusted, snap and situational availability are reported separately in
each team's component availability/provenance. `teamMetricsAuditsByWeek` records the
eligible sample and its reason when unavailable. Later completion observations cannot
reconstruct earlier as-observed history. Snap participation is restricted to the same
eligible team/game weeks.

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
and run `npm run update:nflverse -- 2026`. The updater validates the existing team
artifact before external reads, selects the next scheduled prediction-week cutoff,
and replaces only that week's context. All non-target contexts are retained.
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

Explicitly unavailable weather (`weatherAvailable: false`) uses the existing
neutral multipliers and zero additive shift, without synthesizing observations.
The saved weather object retains its unavailable reason and provenance. Indoor
and null-weather behavior is unchanged; validated measured fallbacks retain
normal weather effects. Supposedly available outdoor weather requires finite
wind, temperature and rain/precipitation measurements; malformed supplied
measurements fail explicitly. Weather-impact and special-teams simulation outputs
are checked for non-finite values before they can enter a saved prediction.

The audited 2026 Week 8 CHI-at-SEA core event has provider kickoffs one to five
minutes after schedule game `1392336` (`2026-11-03T01:15:00.000Z`). Its read-side
mapping is narrowly reconciled only for that exact season/week/team order,
schedule ID/kickoff and provider event ID, with matching SharpAPI snapshot
provenance and exactly one candidate within five minutes. Ambiguity fails closed.
The returned event retains its provider ID/time and adds `scheduleMapping`
discrepancy provenance; no stored odds or schedule timestamps are rewritten.
Every other event retains exact kickoff matching. Moneyline consensus and the
existing spread/total display fallback are unchanged.

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
The Anytime TD equation remains `1 - exp(-expectedTDs)`. The Model Pick ranks raw
TD probability first, independently of pricing; displayed probability remains the
saved model probability. Role confidence remains an eligibility requirement.
Unsupported roles/identities do not produce a scorer. Priced Best Bets and Weekly
Best Multi retain their existing betting outputs and eligibility rules; the model
display fallback never enters those candidate pools.

After explicit approval, regenerate depth context using
`npm run update:nflverse -- 2026`, then player metrics using
`node scripts/update-nflverse-players.mjs 2026 8`, with `BALLDONTLIE_API_KEY` set.
The player updater requires an explicit season and prediction week; it never infers
the target from the latest PBP row. Before network access it checks the exact local
team-artifact week, cutoff and `referenceWeek`, including all 32 target lineups.
The source timestamp is observed after fetches and rechecked against that cutoff;
lineup snapshots must precede observation. Completed season/week/cutoff/observation
filtering happens before identity resolution. Only the requested player week is
replaced; earlier weeks remain unchanged.
The team updater requires complete cumulative PBP coverage, including games already
represented by older contexts. All three NFLverse sources (PBP, snaps and depth)
are required; an unavailable source fails without replacing the runtime artifact.
Depth-chart CSV assets are resolved from the official nflverse `depth_charts`
release metadata (published gzip CSV preferred, otherwise published plain CSV).
There is no guessed-URL retry, roster substitution or prior-week artifact fallback.
The timestamped depth schema and all 32 teams' pre-cutoff, pre-observation source
coverage are required. Post-observation snapshots cannot supply current personnel.
The target context must also retain exact-week roster/cutoff provenance and a
matching kicker identity; a prior-week personnel context fails validation before
publication and again when the temporary artifact is validated.
Official documentation describes the post-2024 timestamped schema:
https://nflreadr.nflverse.com/articles/dictionary_depth_charts.html.
A uniquely named same-directory temporary file is reread, parsed and validated
before atomic rename. Failure cleans only that temporary file and preserves the
original runtime bytes. The player artifact is never a team-updater destination.
For player PBP, all 37 directly consumed source columns are required: game/team/week
identity, regular-season/play fields, play-level passing/rushing/receiving values,
and player IDs/names (`PLAYER_SOURCE_REQUIRED_FIELDS` in the updater). There are
no optional source columns whose absence is treated as zero (including
`yards_after_catch` and the `pass` fallback input). Malformed numeric values fail;
blank relevant metric inputs fail, while non-applicable blanks remain legitimate.
Passing and rushing applicability uses NFLverse play types and pass/rush,
sack and scramble indicators, not player identifiers alone. Administrative
end-quarter rows may have null attempt fields. Two-point attempts are excluded
from ordinary player-stat totals; their null ordinary yardage is not zero-filled.
Air yards and YAC remain null in parsed non-applicable plays.
Targets, red/goal-line
and end-zone flags, and receiving touchdowns are derived from those inputs. Target
players require a GSIS ID and full canonical name. The complete authoritative
`expectedLineup.roster`, not just selected starters, supplies canonical identity
and cutoff-team ownership. Valid pre-cutoff selected-lineup identities absent from
the roster may supplement that universe only without ID/name/team conflicts;
this does not fabricate roster membership or transaction history.
An exact GSIS match takes priority over source-name similarity. Exact unique
full-name/team roster evidence can resolve missing PBP IDs; abbreviated names,
unknown/conflicting IDs and ambiguous names cannot. Invalid/missing roster IDs
are excluded and reported, never synthesized. Historical PBP on another team
remains excluded against authoritative cutoff ownership.
Canonical names such as `J. Michael Sturdivant` retain two fully specified name
components; `B.Allen`, `B. Allen` and partial names cannot establish identity.
Roster-only positions are labeled `expectedRoster`; selected-lineup positions
retain `expectedLineup`. Roster membership never grants starter confidence,
confirmed activity or verified health: downstream depth/slot/rank evidence
continues to govern projected participation. Position and health are explicitly labeled
`inferred` and `Unknown`/`Unavailable` when unavailable from the lineup/source.
Historical reconstruction requires archived depth plus proven
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

The score-based network is distinct from the NFLverse metric-specific
opponent-adjusted metrics and from ESPN SOS. New team-updater targets also retain
a separately labelled `opponentNetworkByWeek` snapshot, using the existing network
solver and only final schedule games with matching eligible NFLverse PBP. The
endpoint reuses that validated snapshot for the exact week without a provider
request. Older weeks without a stored network retain the existing endpoint path.
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

Network regressions use controlled provider fixtures. New network snapshots retain
normalized scores and matching game-level PBP/completion provenance; performance
metrics are never fabricated from those scores. Historical network snapshots, when
present, are not regenerated by a later target-week update.

## Independent ESPN model inputs

The current ESPN snapshot contains the authoritative supplied FPI and Efficiency
tables, including records, exact trend strings, components and schedule ranks.
Import validation requires all 32 canonical teams, matching records and complete
rank permutations. No ESPN/NFLverse blending occurs during ingestion.

`getTeamRatings` exposes raw ESPN FPI points, not synthetic 0-100 ratings and not
the former baseline/efficiency pre-blend. Team rating labels identify ESPN FPI.
The engine's `inputEvidence` contract retains raw ESPN, NFLverse, score-based
Opponent Network, personnel and game context independently. The existing
`round(clamp(75 + FPI component * 3, 50, 100))` scale is applied only inside the
model's existing rating-unit slots; existing scoring coefficients are unchanged.
It is a model mapping, not a purported ESPN-reported value.

FPI overall/offense/defense use the existing strength/component scoring paths.
FPI rank/trend/ST, the four efficiencies and their ranks, SOS/remaining SOS/AVGWP
and record remain explicit diagnostic evidence: the model has no independent
coefficients for them after removal of the pre-blend, so no new weights are
invented. NFLverse special-teams/kicker paths and all betting eligibility/selection
rules are unchanged. Existing saved predictions are never recalculated on read.

Team-level diagnostics may run without an exact-week player artifact. In that
case player projections remain explicitly unavailable, no earlier-week players
are reused, and player-derived play mix is unavailable. Existing conservative
matchup exposure and kicker-health safety fallbacks remain explicit; missing
health observations do not establish active personnel. Validation dry runs do not
save predictions or create betting outputs.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
