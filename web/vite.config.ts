import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:4100',
        changeOrigin: true,
        // Keep the event stream flowing: no buffering, no compression.
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.setHeader('accept-encoding', 'identity'));
          proxy.on('proxyRes', (res) => {
            if (String(res.headers['content-type'] ?? '').includes('text/event-stream')) {
              res.headers['cache-control'] = 'no-cache, no-transform';
              res.headers['x-accel-buffering'] = 'no';
            }
          });
        },
      },
    },
  },
});
