import { createWeeklyMultiClient, resolveDisplayWeekContext } from "../../api-lib/weeklyMulti.js";

export function createWeeklyMultiCurrentHandler(overrides = {}) {
  const createClient = overrides.createClient || createWeeklyMultiClient;
  const getNow = overrides.getNow || (() => new Date());
  const resolveDisplayContext = overrides.resolveDisplayContext || ((now) =>
    resolveDisplayWeekContext(now, { fetchGames: overrides.fetchGames }));

  return async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const now = getNow();
    const context = await resolveDisplayContext(now);
    if (!context.available) {
      return res.status(200).json({
        status: "not ready",
        locked: false,
        placeholder: false,
        season: context.season,
        week: context.week,
        lockAt: context.lockAt,
        reason: context.reason,
        message: "Weekly Best Multi is not ready yet. Please check back later.",
      });
    }
    if (context.placeholder) {
      return res.status(200).json({
        status: "before lock",
        locked: false,
        placeholder: true,
        season: context.season,
        week: context.week,
        lockAt: context.lockAt,
      });
    }
    const supabase = createClient();
    const { data, error } = await supabase
      .from("weekly_best_multis")
      .select("*")
      .eq("season", context.season)
      .eq("week", context.week)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      const firstKickoff = new Date(context.firstKickoffAt || "").getTime();
      if (Number.isFinite(firstKickoff) && now.getTime() >= firstKickoff) {
        return res.status(200).json({
          status: "missed",
          locked: false,
          season: context.season,
          week: context.week,
          firstKickoffAt: context.firstKickoffAt,
          message: "No Weekly Best Multi was locked for this week.",
        });
      }
      return res.status(200).json({
        status: "not ready",
        locked: false,
        season: context.season,
        week: context.week,
        lockAt: context.lockAt,
        message: "Weekly Best Multi is not ready yet. Please check back later.",
      });
    }
    return res.status(200).json({ status: data.generated_late ? "generated late" : data.partial ? "partial" : "locked", locked: true, season: data.season, week: data.week, record: data });
  } catch (error) {
    console.error("Weekly Best Multi read failed", error);
    return res.status(500).json({ error: "Weekly Best Multi read failed" });
  }
  };
}

export default createWeeklyMultiCurrentHandler();
