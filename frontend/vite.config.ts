import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// Dev server proxies the API to the Django backend (`uv run python manage.py serve`).
export default defineConfig({
  plugins: [react()],
  define: { __MARUMADO_VERSION__: JSON.stringify(version) },
  server: {
    // Localhost only by default. MARUMADO_DEV_HOST=1 binds 0.0.0.0, which exposes the dev server — and through its
    // /api proxy, the backend and its access token — to everyone on the LAN over plain HTTP.
    host: process.env.MARUMADO_DEV_HOST === '1',
    proxy: { '/api': { target: 'http://127.0.0.1:7878', ws: true } },
  },
})
