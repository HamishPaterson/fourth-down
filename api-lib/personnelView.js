import { TEAM_NAMES } from "../src/data.js";

export const PERSONNEL_VIEW_VERSION = 1;
export const QUESTIONABLE_OPPORTUNITY_FACTOR = 0.75;
export const AVAILABILITY_ABSENCE_PROBABILITY = Object.freeze({
  Active: 0,
  Probable: 0.08,
  Questionable: 0.25,
  Doubtful: 0.75,
  Out: 1,
  Inactive: 1,
  IR: 1,
  PUP: 1,
  Suspended: 1,
  NFI: 1,
  Unknown: null,
});

const aliases = {
  WAS: "WSH", LA: "LAR", JAC: "JAX", OAK: "LV", SD: "LAC", STL: "LAR",
};
const unavailable = new Set(["Doubtful", "Out", "Inactive", "IR", "PUP", "Suspended", "NFI"]);
const nameKey = (value) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\b\.?/g, "").replace(/[^a-z0-9]/g, "");

export function classifyPlayerAvailability(player, { sourceAvailable = true, observedAt } = {}) {
  if (!player || player.identityConflict || player.sourceConflict) return "UNKNOWN_IDENTITY";
  if (!sourceAvailable) return "UNKNOWN_SOURCE_UNAVAILABLE";
  if (player.inLineup === false) return "UNKNOWN_NOT_IN_LINEUP";
  if (player.position && !["QB", "RB", "FB", "WR", "TE"].includes(player.position)) return "UNSUPPORTED_ROLE";
  const observation = player.observationTimestamp || player.chartObservationTimestamp;
  const timestamp = typeof observation === "number" ? observation : Date.parse(observation);
  const at = Date.parse(observedAt || player.cutoff);
  if (player.eligibleBeforeCutoff === false ||
      Number.isFinite(timestamp) && Number.isFinite(at) &&
        (timestamp > at || at - timestamp > 7 * 86400000)) return "UNKNOWN_STALE";
  const states = { Active: "AVAILABLE", Probable: "EXPECTED_ACTIVE", Questionable: "QUESTIONABLE",
    Doubtful: "DOUBTFUL", Out: "OUT", Inactive: "OUT", IR: "IR", PUP: "PUP",
    Suspended: "SUSPENDED", NFI: "OUT" };
  return states[player.status] || (player.provenance?.statusSource === "unknown" &&
    !player.provenance?.live && !player.provenance?.chart ? "UNKNOWN_SOURCE_UNAVAILABLE" : "UNKNOWN_GAME_STATUS");
}

export function availableForPlayerBet(player, options) {
  return ["AVAILABLE", "EXPECTED_ACTIVE", "QUESTIONABLE"].includes(classifyPlayerAvailability(player, options)) &&
    player?.statusKnown === true && player.propEligible === true &&
    player.projectedAvailable !== false && player.eligibleBeforeCutoff === true;
}

export function canonicalTeam(value) {
  const code = String(value || "").trim().toUpperCase();
  return aliases[code] || code;
}

export function canonicalPosition(value) {
  const position = String(value || "").trim().toUpperCase().replace(/[\s_-]+/g, "");
  if (["WR", "LWR", "RWR", "SWR", "XWR", "ZWR", "WR1", "WR2", "WR3"].includes(position)) return "WR";
  if (["TE", "TE1", "TE2"].includes(position)) return "TE";
  if (["HB", "HALFBACK"].includes(position)) return "RB";
  if (["OL", "T", "OT"].includes(position)) return position === "OL" ? "OL" : "OT";
  if (["LG", "RG", "OG", "G", "GUARD"].includes(position)) return position === "LG" || position === "RG" ? position : "G";
  if (["LT", "RT", "C", "QB", "RB", "FB", "K", "PK", "P", "KR", "PR", "LS"].includes(position)) {
    return position === "PK" ? "K" : position;
  }
  if (["LDE", "RDE", "LEDG", "REDG"].includes(position)) return "DE";
  if (["DE"].includes(position)) return "DE";
  if (["DT", "LDT", "RDT", "DL"].includes(position)) return "DT";
  if (["LOLB", "ROLB"].includes(position)) return "OLB";
  if (["EDGE", "OLB"].includes(position)) return position;
  if (["ILB", "MLB", "LB", "MIKE", "WILL", "SAM", "LILB", "RILB", "WLB", "SLB"].includes(position)) return "LB";
  if (["CB", "LCB", "RCB", "NB", "NCB", "SLOT"].includes(position)) return "CB";
  if (["DB"].includes(position)) return "DB";
  if (["S", "FS", "SS"].includes(position)) return position;
  if (position === "NT") return "NT";
  return "UNKNOWN";
}

export function normalizeAvailability({ injuryStatus, rosterStatus, chartStatus } = {}) {
  const medical = normalizeStatusText(injuryStatus);
  const roster = normalizeRosterText(rosterStatus);
  const chart = normalizeStatusText(chartStatus);
  const status = unavailable.has(roster) ? roster
    : medical !== "Unknown" ? medical
      : chart !== "Unknown" ? chart : "Unknown";
  return {
    status,
    statusKnown: status !== "Unknown",
    absenceProbability: AVAILABILITY_ABSENCE_PROBABILITY[status],
    projectedAvailable: !unavailable.has(status),
    propEligible: status === "Active" || status === "Probable" || status === "Questionable",
    opportunityFactor: status === "Questionable" ? QUESTIONABLE_OPPORTUNITY_FACTOR : 1,
  };
}

function normalizeStatusText(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "Unknown";
  if (/\b(non[- ]football injury|nfi)\b/.test(text)) return "NFI";
  if (/\b(physically unable to perform|pup)\b/.test(text)) return "PUP";
  if (/\b(injured reserve|injured-reserve)\b/.test(text) || text === "ir") return "IR";
  if (/\b(suspended|suspension)\b/.test(text)) return "Suspended";
  if (/\b(inactive|inact)\b/.test(text)) return "Inactive";
  if (/\b(doubtful)\b/.test(text)) return "Doubtful";
  if (/\b(questionable|quest)\b/.test(text)) return "Questionable";
  if (/\b(probable)\b/.test(text)) return "Probable";
  if (/\b(out|ruled out)\b/.test(text)) return "Out";
  if (/^(active|healthy|full)$/.test(text)) return "Active";
  return "Unknown";
}

function normalizeRosterText(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "Unknown";
  if (/\b(non[- ]football injury|nfi)\b/.test(text)) return "NFI";
  if (/\b(physically unable to perform|pup)\b/.test(text)) return "PUP";
  if (/\b(injured reserve|injured-reserve)\b/.test(text) || text === "ir") return "IR";
  if (/\b(suspended|suspension)\b/.test(text)) return "Suspended";
  if (/\b(inactive|inact)\b/.test(text)) return "Inactive";
  return "Unknown";
}

function timestamp(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : null;
}

function flattenLivePlayers(roster) {
  const groups = roster?.groups;
  if (!groups || typeof groups !== "object") return [];
  return Object.values(groups).flat().filter((player) => player && typeof player === "object")
    .map((player) => ({
      ...player,
      gsisId: player.gsisId || player.gsis_id || null,
      fullName: player.fullName || player.full_name || null,
      depthChartPosition: player.depthChartPosition || player.depth_chart_position || null,
      depthChartOrder: player.depthChartOrder ?? player.depth_chart_order ?? null,
      injuryStatus: player.injuryStatus ?? player.injury_status ?? null,
    }));
}

function findLiveMatch(chartPlayer, livePlayers, team) {
  const exact = livePlayers.filter((player) => player.gsisId &&
    String(player.gsisId) === String(chartPlayer.gsisId));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const byName = livePlayers.filter((player) => canonicalTeam(player.team) === team &&
    canonicalPosition(player.depthChartPosition || player.position) === chartPlayer.position &&
    nameKey(player.fullName) === nameKey(chartPlayer.name));
  return byName.length === 1 ? byName[0] : null;
}

export function buildPersonnelView({ team, lineup, roster, cutoff, season, week, observedAt = new Date().toISOString() } = {}) {
  const code = canonicalTeam(team);
  const cutoffTime = timestamp(cutoff);
  const chartTime = timestamp(lineup?.snapshotAt);
  const chartEligible = cutoffTime !== null && chartTime !== null && chartTime <= cutoffTime &&
    lineup?.schemaVersion === 2 && Array.isArray(lineup?.roster) &&
    Number(lineup?.season) === Number(season) && Number(lineup?.predictionWeek) === Number(week) &&
    Number.isInteger(Number(week)) && Number(week) >= 1;
  const rosterTime = timestamp(roster?.sourceAsOf);
  const liveEligible = cutoffTime !== null && rosterTime !== null && rosterTime <= cutoffTime &&
    canonicalTeam(roster?.team) === code;
  const livePlayers = liveEligible ? flattenLivePlayers(roster)
    .filter((player) => canonicalTeam(player.team) === code) : [];
  const leagueTeams = new Map((liveEligible ? roster?.leagueIdentityIndex || [] : [])
    .filter((player) => player?.gsisId && player?.team)
    .map((player) => [String(player.gsisId), canonicalTeam(player.team)]));
  const chartRows = chartEligible && canonicalTeam(lineup?.team || code) === code
    ? [...(lineup?.roster || [])] : [];
  const chartRecords = chartRows.map((chart) => {
    const position = canonicalPosition(chart.position);
    const live = findLiveMatch({ ...chart, position }, livePlayers, code);
    const liveTeam = canonicalTeam(live?.team);
    const transferredTo = chart.gsisId ? leagueTeams.get(String(chart.gsisId)) : null;
    const transferred = Boolean(transferredTo && transferredTo !== code);
    const sourceConflict = transferred || Boolean(live && (liveTeam !== code ||
      (canonicalPosition(live.depthChartPosition || live.position) !== position)));
    const availability = normalizeAvailability({
      injuryStatus: live?.injuryStatus,
      rosterStatus: live?.status,
      chartStatus: chart.status,
    });
    const liveAvailability = normalizeAvailability({
      injuryStatus: live?.injuryStatus,
      rosterStatus: live?.status,
    });
    const liveDepth = Number(live?.depthChartOrder);
    const chartRank = Number(chart.rank);
    const rank = liveEligible && Number.isInteger(liveDepth) && liveDepth > 0 ? liveDepth : chartRank;
    const identityConflict = sourceConflict || Boolean(live && live.gsisId &&
      String(live.gsisId) !== String(chart.gsisId));
    const identity = chart.gsisId || chart.playerId;
    return {
      playerId: String(chart.playerId || identity),
      canonicalId: String(chart.gsisId || identity),
      gsisId: chart.gsisId || null,
      name: chart.name || live?.fullName || null,
      team: code,
      position,
      group: chart.group,
      slot: chart.slot,
      chartRank,
      liveRank: Number.isInteger(liveDepth) && liveDepth > 0 ? liveDepth : null,
      rank,
      chartStarter: chartRank === 1,
      liveStarter: liveEligible && liveDepth === 1,
      status: availability.status,
      statusKnown: availability.statusKnown,
      absenceProbability: availability.absenceProbability,
      opportunityFactor: availability.opportunityFactor,
      observationTimestamp: availability.statusKnown
        ? (live && liveAvailability.statusKnown ? rosterTime : chartTime) : null,
      cutoff: cutoff || null,
      chartObservationTimestamp: chartTime ? new Date(chartTime).toISOString() : null,
      liveObservationTimestamp: liveEligible ? new Date(rosterTime).toISOString() : null,
      eligibleBeforeCutoff: cutoffTime !== null && (!chartTime || chartTime <= cutoffTime) &&
        (!liveEligible || rosterTime <= cutoffTime),
      projectedAvailable: availability.projectedAvailable && !sourceConflict,
      propEligible: availability.propEligible && !sourceConflict,
      exclusionReason: transferred ? `Player now listed with ${transferredTo}`
        : sourceConflict ? "Conflicting team or position identity"
        : !availability.projectedAvailable ? `Unavailable status: ${availability.status}` : null,
      replacementFor: null,
      identityConflict,
      sourceConflict,
      livePlayerId: live?.id || null,
      liveDepthSupported: liveEligible && Number.isInteger(liveDepth) && liveDepth > 0,
      confidence: live ? "matched-by-identity" : "chart-only",
      provenance: {
        chart: chartTime ? { observedAt: new Date(chartTime).toISOString(), playerId: chart.playerId } : null,
        live: liveEligible && live ? { observedAt: new Date(rosterTime).toISOString(), playerId: live.id } : null,
        statusSource: availability.statusKnown
          ? (live && liveAvailability.statusKnown ? "live-personnel-status" : "point-in-time-chart") : "unknown",
      },
    };
  }).filter((record) => record.position !== "UNKNOWN");
  const chartIds = new Set(chartRecords.map((player) => player.canonicalId));
  const liveRecords = livePlayers.filter((live) => live.gsisId && !chartIds.has(String(live.gsisId)))
    .map((live) => {
      const position = canonicalPosition(live.depthChartPosition || live.position);
      const liveDepth = Number(live.depthChartOrder);
      const availability = normalizeAvailability({ injuryStatus: live.injuryStatus, rosterStatus: live.status });
      const group = groupForPosition(position);
      if (!group || position === "UNKNOWN") return null;
      return {
        playerId: String(live.id || live.gsisId),
        canonicalId: String(live.gsisId),
        gsisId: String(live.gsisId),
        name: live.fullName || null,
        team: code,
        position,
        group,
        slot: null,
        chartRank: null,
        liveRank: Number.isInteger(liveDepth) && liveDepth > 0 ? liveDepth : null,
        rank: Number.isInteger(liveDepth) && liveDepth > 0 ? liveDepth : null,
        chartStarter: false,
        liveStarter: Number.isInteger(liveDepth) && liveDepth === 1,
        status: availability.status,
        statusKnown: availability.statusKnown,
        absenceProbability: availability.absenceProbability,
        opportunityFactor: availability.opportunityFactor,
        observationTimestamp: availability.statusKnown ? new Date(rosterTime).toISOString() : null,
        cutoff: cutoff || null,
        chartObservationTimestamp: null,
        liveObservationTimestamp: new Date(rosterTime).toISOString(),
        eligibleBeforeCutoff: true,
        projectedAvailable: availability.projectedAvailable,
        propEligible: availability.propEligible,
        exclusionReason: availability.projectedAvailable ? null : `Unavailable status: ${availability.status}`,
        replacementFor: null,
        identityConflict: false,
        sourceConflict: false,
        livePlayerId: live.id || null,
        liveDepthSupported: Number.isInteger(liveDepth) && liveDepth > 0,
        confidence: "live-identity",
        provenance: { chart: null, live: { observedAt: new Date(rosterTime).toISOString(), playerId: live.id },
          statusSource: availability.statusKnown ? "live-injury-status" : "unknown" },
      };
    }).filter(Boolean);
  chartRecords.push(...liveRecords);
  for (const player of chartRecords) {
    player.availabilityState = classifyPlayerAvailability(player, {
      sourceAvailable: chartEligible || liveEligible, observedAt,
    });
  }

  const qbs = chartRecords.filter((player) => player.group === "QB");
  const chartStarterId = lineup?.startingQuarterback?.gsisId || lineup?.startingQuarterback?.playerId;
  const declaredQbs = Array.isArray(lineup?.players)
    ? lineup.players.filter((player) => player.group === "QB") : [];
  const chartStarter = chartEligible && lineup?.available === true && lineup?.schemaValidated === true &&
    chartStarterId && declaredQbs.length === 1 &&
    (declaredQbs[0].gsisId === chartStarterId || declaredQbs[0].playerId === chartStarterId)
    ? qbs.find((player) => player.gsisId === String(chartStarterId) ||
      player.canonicalId === String(chartStarterId) || player.playerId === String(chartStarterId)) || null
    : null;
  const liveStarters = qbs.filter((player) => player.liveStarter);
  let selected = liveStarters.length === 1 ? liveStarters[0] : chartStarter;
  const teamName = TEAM_NAMES[code] || code;
  let reason = "Point-in-time depth chart selected the starting quarterback";
  let conflict = false;
  if (liveStarters.length > 1) {
    selected = null;
    conflict = true;
    reason = `${teamName}: quarterback identity conflict is unresolved; multiple live depth-chart starters are supported`;
  } else if (selected && chartStarter && selected.canonicalId !== chartStarter.canonicalId) {
    conflict = true;
    reason = liveEligible
      ? `${teamName}: point-in-time evidence resolves the QB conflict; ${selected.name} replaces ${chartStarter.name}`
      : "Conflicting QB identities without a timely resolving observation";
    if (!liveEligible) selected = null;
  }

  function groupForPosition(position) {
    if (position === "QB") return "QB";
    if (["RB", "FB"].includes(position)) return "RB";
    if (position === "WR") return "WR";
    if (position === "TE") return "TE";
    if (["LT", "RT", "OT", "LG", "RG", "G", "C", "OL"].includes(position)) return "OL";
    if (["EDGE", "DE", "DT", "NT"].includes(position)) return "front";
    if (["LB", "OLB"].includes(position)) return "LB";
    if (["CB", "DB", "S", "FS", "SS"].includes(position)) return "DB";
    return null;
  }
  if (selected && (!selected.eligibleBeforeCutoff || selected.sourceConflict)) selected = null;
  let replacement = null;
  if (selected && !selected.projectedAvailable) {
    replacement = qbs.filter((player) => player.rank > selected.rank && player.projectedAvailable &&
      player.statusKnown && player.eligibleBeforeCutoff && !player.sourceConflict)
      .sort((a, b) => a.rank - b.rank)[0] || null;
    if (replacement) {
      replacement.replacementFor = selected.canonicalId;
      selected = replacement;
      reason = `${teamName}: ${replacement.name} is the next point-in-time available quarterback, replacing ${chartStarter?.name || "the unavailable starter"}`;
    } else {
      reason = `${teamName}: starting QB ${selected.name} is unavailable; replacement identity is unresolved`;
      selected = null;
    }
  } else if (selected && !selected.statusKnown) {
    reason = "Starting QB identity is supported; health remains unknown and betting eligibility is withheld";
  } else if (selected && !selected.propEligible) {
    reason = `Starting QB is not eligible: ${selected.status}`;
    selected = null;
  }
  if (conflict && !liveEligible) selected = null;
  const replacementByStarter = new Map();
  for (const group of ["QB", "RB", "WR", "TE", "OL", "front", "LB", "DB"]) {
    const groupRows = chartRecords.filter((player) =>
      player.group === group || (group === "OL" && ["LT", "RT", "OT", "G", "C"].includes(player.position)) ||
      (group === "front" && ["EDGE", "DE", "DT", "NT"].includes(player.position)) ||
      (group === "LB" && player.position === "LB") || (group === "DB" && ["CB", "DB", "S", "FS", "SS"].includes(player.position)));
    for (const starter of groupRows.filter((player) => player.chartStarter && !player.projectedAvailable)) {
      const next = groupRows.filter((player) => player.position === starter.position && player.rank > starter.rank &&
        player.projectedAvailable && player.statusKnown && player.eligibleBeforeCutoff && !player.sourceConflict)
        .sort((a, b) => a.rank - b.rank)[0];
      if (next) {
        next.replacementFor = starter.canonicalId;
        replacementByStarter.set(starter.canonicalId, next.canonicalId);
      }
    }
  }
  const players = chartRecords.map((player) => ({
    ...player,
    replacementId: replacementByStarter.get(player.canonicalId) || null,
    qbSelected: selected?.canonicalId === player.canonicalId,
  }));
  const known = players.filter((player) => player.statusKnown).length;
  return {
    version: PERSONNEL_VIEW_VERSION,
    team: code,
    season: lineup?.season ?? null,
    week: lineup?.predictionWeek ?? null,
    cutoff: cutoff || null,
    generatedAt: observedAt,
    chart: { available: chartEligible && lineup?.available === true, observedAt: chartTime ? new Date(chartTime).toISOString() : null },
    live: { available: liveEligible, observedAt: rosterTime ? new Date(rosterTime).toISOString() : null },
    statusCoverage: { known: known, total: players.length, complete: players.length > 0 && known === players.length },
    players,
    quarterback: {
      player: selected,
      chartStarter: chartStarter?.canonicalId || null,
      liveStarter: liveStarters.length === 1 ? liveStarters[0].canonicalId : null,
      conflict,
      resolved: Boolean(selected) || !chartStarter,
      reason,
      source: selected?.liveStarter ? "live-depth" : selected ? "point-in-time-chart" : "withheld",
      replacement: selected?.replacementFor ? selected.canonicalId : null,
    },
    units: Object.fromEntries(["front", "LB", "DB"].map((group) => {
      const rows = players.filter((player) => player.group === group);
      return [group, {
        available: rows.length > 0,
        statusKnown: rows.filter((player) => player.statusKnown).length,
        unavailable: rows.filter((player) => !player.projectedAvailable).map((player) => player.canonicalId),
        replacements: rows.filter((player) => player.replacementFor).map((player) => ({
          playerId: player.canonicalId, replaces: player.replacementFor,
        })),
        sourceConflict: rows.some((player) => player.sourceConflict),
      }];
    })),
  };
}
