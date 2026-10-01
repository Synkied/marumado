import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Dev server proxies the API to the Django backend (`uv run python manage.py serve`).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    proxy: { '/api': { target: 'http://127.0.0.1:7878', ws: true } },
  },
})
