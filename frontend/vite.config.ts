import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        timeout: 600_000,        // 10 min proxy timeout
        proxyTimeout: 600_000,   // upstream response timeout
      },
    },
  },
})
