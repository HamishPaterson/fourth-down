// Waits for Vercel to report the pushed commit as deployed.
const [repository, sha] = process.argv.slice(2);
if (!/^[\w.-]+\/[\w.-]+$/.test(repository || "") || !/^[0-9a-f]{40}$/.test(sha || "")) throw new Error("repository and commit required");
const started = Date.now();
while (Date.now() - started < 15 * 60000) {
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}/status`, {
    headers: { accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  const body = response.ok ? await response.json() : {};
  if (body.state === "success" && body.statuses?.length) { console.log("Deployed."); process.exit(0); }
  if (["failure", "error"].includes(body.state)) { console.error("Deployment failed."); process.exit(1); }
  await new Promise((resolve) => setTimeout(resolve, 15000));
}
console.error("Timed out waiting for the deployment.");
process.exit(1);
