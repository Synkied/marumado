import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// Dev server proxies the API to the Django backend (`uv run python manage.py serve`).
export default defineConfig({
  plugins: [react()],
  define: { __MARUMADO_VERSION__: JSON.stringify(version) },
  server: {
    host: true,
    proxy: { '/api': { target: 'http://127.0.0.1:7878', ws: true } },
  },
})
