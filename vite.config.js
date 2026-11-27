import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// Local `npm run dev` only (never the production build, never tests):
// - Sign-in: reuse the public Supabase URL and anon key from .env.local, which
//   Vercel stores without the VITE_ prefix the browser needs.
// - Data: Vite has no /api routes, so read-only GET requests go to the live app
//   with the signed-in user's own session. Anything that writes is refused locally.
const LIVE_APP = 'https://fourth-down-coral.vercel.app'

export default defineConfig(({ command, mode }) => {
  const localDev = command === 'serve' && mode === 'development' && !process.env.NODE_TEST_CONTEXT
  if (localDev) {
    const env = loadEnv(mode, process.cwd(), '')
    process.env.VITE_SUPABASE_URL ||= env.VITE_SUPABASE_URL || env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || ''
    process.env.VITE_SUPABASE_ANON_KEY ||= env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  }
  return {
    plugins: [react()],
    server: localDev
      ? {
          proxy: {
            '/api': {
              target: LIVE_APP,
              changeOrigin: true,
              // Read-only: returning false makes Vite answer 404 instead of forwarding.
              bypass: (req) => (req.method === 'GET' || req.method === 'HEAD' ? undefined : false),
            },
          },
        }
      : undefined,
  }
})
