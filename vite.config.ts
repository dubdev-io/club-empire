import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * GitHub Pages serves a project site from `https://<org>.github.io/<repo>/`, so
 * every asset URL in the build has to carry that prefix or the page loads and
 * then 404s on its own JavaScript.
 *
 * Applied to `build` only. The dev server keeps serving from `/`, because
 * moving it to `/club-empire/` would change the URL every developer and the
 * screenshot driver already have. `CLUB_EMPIRE_BASE` overrides both, which is
 * what a different host (a root-served bucket, say) would need — and DUB-9
 * leaves the hosting choice with the owner.
 */
const PAGES_BASE = '/club-empire/';

/**
 * Short commit SHA for the overlay's `build` field.
 *
 * `GITHUB_SHA` is what CI has; `git rev-parse` is what a local build has.
 * Neither is fatal if missing — a build that cannot name itself is still a
 * build, it just produces a frame-rate number nobody can tie to a commit, and
 * saying `unknown` is the honest way to admit that.
 */
function resolveBuildSha(): string {
  const fromCi = process.env.GITHUB_SHA;
  if (fromCi !== undefined && fromCi !== '') return fromCi.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: process.env.CLUB_EMPIRE_BASE ?? (command === 'build' ? PAGES_BASE : '/'),
  define: {
    __CLUB_BUILD__: JSON.stringify(command === 'build' ? resolveBuildSha() : 'dev'),
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: 'es2022',
    // Off by default: the maps are ~3.4 MB of host payload and they publish
    // readable source. They are not fetched unless devtools is open, so they
    // do not count against the 4 MB transferred budget, but there is no reason
    // to host them for every build. `npm run build:debug` turns them back on
    // when a readable stack trace off a real device is worth more than the
    // payload.
    sourcemap: process.env.CLUB_EMPIRE_SOURCEMAP === 'true',
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
}));
