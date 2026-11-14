import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(import.meta.dirname, './src') } },
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
