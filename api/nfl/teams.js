export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!process.env.BALLDONTLIE_API_KEY) return res.status(500).json({ error: 'BALLDONTLIE_API_KEY is not configured' })
  try {
    const response = await fetch('https://api.balldontlie.io/nfl/v1/teams', {
      headers: { Authorization: process.env.BALLDONTLIE_API_KEY, Accept: 'application/json' },
    })
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = { error: text || 'Invalid upstream response' } }
    res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=604800')
    return res.status(response.status).json(data)
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load teams', details: error instanceof Error ? error.message : String(error) })
  }
}
