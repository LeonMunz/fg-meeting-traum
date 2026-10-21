import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import {
  e2eRealtimeDisconnectPlugin,
} from './vite.e2e.realtime-proxy.ts'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // E2E-only SSE disconnect harness (RT-06C1): active in this
    // config only, reachable only on the loopback-bound E2E server,
    // session-scoped and fail-closed. It changes no product,
    // production, or Django behavior.
    e2eRealtimeDisconnectPlugin({
      host: '127.0.0.1',
      port: 8010,
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8010',
        changeOrigin: true,
      },
    },
  },
})
