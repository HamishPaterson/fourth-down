import process from "node:process";
import { pathToFileURL } from "node:url";
import { createPredictionRefreshBatch } from "../api-lib/predictionRefresh.js";

export async function runPredictionRefreshBuild(args, {
  environment = process.env,
  createBatch = createPredictionRefreshBatch,
} = {}) {
  if (args.length !== 1 || !["--dry-run", "--save-week6"].includes(args[0])) {
    throw new Error("Specify exactly --dry-run or --save-week6; no default refresh action");
  }
  if (environment.VERCEL !== "1" || environment.VERCEL_ENV !== "production" || !environment.VERCEL_URL) {
    throw new Error("Prediction refresh requires an authenticated remote Vercel Production build");
  }
  const dryRun = args[0] === "--dry-run";
  let status = 200, body;
  const response = {
    setHeader() {}, status(code) { status = code; return this; },
    json(value) { body = value; return this; },
  };
  await createBatch({}, { oneTimeWeek6: true })({
    method: dryRun ? "GET" : "POST", body: { dryRun },
  }, response);
  if (status !== 200) throw new Error("Prediction refresh build failed; inspect the batch failure diagnostics");
  if (body?.dryRun !== dryRun || (dryRun && body.writes !== 0)) {
    throw new Error("Unexpected prediction refresh mode/write result");
  }
  return body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runPredictionRefreshBuild(process.argv.slice(2));
    console.log(JSON.stringify(result));
  } catch {
    console.error("Prediction refresh build failed; no automatic retry. Inspect batch diagnostics.");
    process.exitCode = 1;
  }
}
