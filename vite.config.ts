import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Pixi's own chunk is ~512 kB raw / ~145 kB gzipped and that is simply
    // what a WebGL engine costs. The limit is set just above it so the build
    // stays warning-free today but still shouts if the engine chunk grows or
    // a new oversized chunk appears. Gzipped total is the number that matters
    // on mobile data and is tracked in the README.
    chunkSizeWarningLimit: 550,
    // Pixi is the single largest dependency. Splitting it out keeps the app
    // chunk small enough to read in a bundle report and lets the browser
    // cache the engine across app deploys.
    rollupOptions: {
      output: {
        // Vite 8 bundles with Rolldown, where `manualChunks` is a function
        // rather than an object map.
        manualChunks: (id) => {
          if (id.includes('node_modules/pixi.js') || id.includes('node_modules/@pixi')) {
            return 'pixi';
          }
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) {
            return 'react';
          }
          return null;
        },
      },
    },
  },
});
