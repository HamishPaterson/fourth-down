// One-off generator: splice the generic functions from the migration into the
// minimal production correction file so the drift-guard test cannot diverge.
import { readFile, writeFile } from "node:fs/promises";

const migrationPath = new URL("../supabase/atomic-prediction-week-generic.sql", import.meta.url);
const correctionPath = new URL("../supabase/atomic-timeout-function-correction.sql", import.meta.url);
const migration = (await readFile(migrationPath, "utf8")).replace(/\r\n/g, "\n");

const extract = (signature) => {
  const start = migration.indexOf(`create or replace function public.${signature}`);
  if (start === -1) throw new Error(`missing ${signature}`);
  const end = migration.indexOf("\nend $$;", start);
  if (end === -1) throw new Error(`unterminated ${signature}`);
  return migration.slice(start, end + "\nend $$;".length);
};

const state = extract("prediction_week_state(p_season integer, p_week integer)");
const replace = extract("replace_prediction_week(p jsonb)");

const correction = `-- Minimal production correction: generic atomic weekly prediction persistence.
-- Replaces the hard-coded 2026 Week 8 / 14-game production scope with validated
-- request values. Apply once in the Supabase SQL editor; do NOT rerun the
-- original migration. Preserves every guarantee: service-role only, atomic
-- all-or-nothing, stale fingerprint, season/week-specific locking, UUID
-- preservation, identity/provenance validation, rollback on failure.
begin;

-- Relax the audit-table scope checks so any validated season/week/count is recorded.
alter table public.prediction_week_replacements drop constraint prediction_week_replacements_season_check;
alter table public.prediction_week_replacements drop constraint prediction_week_replacements_week_check;
alter table public.prediction_week_replacements drop constraint prediction_week_replacements_expected_count_check;
alter table public.prediction_week_replacements add constraint prediction_week_replacements_season_check check (season >= 2002);
alter table public.prediction_week_replacements add constraint prediction_week_replacements_week_check check (week between 1 and 18);
alter table public.prediction_week_replacements add constraint prediction_week_replacements_expected_count_check check (expected_count between 1 and 16);

-- Drop the legacy no-arg state reader; the generic form replaces it.
drop function if exists public.prediction_week_state();

${state}

${replace}

alter function public.prediction_week_state(integer, integer) owner to postgres;
alter function public.replace_prediction_week(jsonb) owner to postgres;
revoke all on function public.prediction_week_state(integer, integer) from public, anon, authenticated;
revoke all on function public.replace_prediction_week(jsonb) from public, anon, authenticated;
grant execute on function public.prediction_week_state(integer, integer) to service_role;
grant execute on function public.replace_prediction_week(jsonb) to service_role;

notify pgrst, 'reload schema';
commit;
`;

await writeFile(correctionPath, correction);
console.log(`wrote ${correctionPath.pathname} (${correction.length} bytes)`);
