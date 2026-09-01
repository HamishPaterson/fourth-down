export async function getTeams(signal) {
  const response = await fetch('/api/nfl/teams', { signal })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || `Teams request failed (${response.status})`)
  return Array.isArray(body.data) ? body.data : []
}
