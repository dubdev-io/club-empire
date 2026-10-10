import { defineConfig } from 'vitest/config';

// The shell's tests cover pure logic only — the simulation loop and the save
// codec. Neither needs a DOM, so we stay on the fast `node` environment and
// fake `localStorage` with a plain in-memory object in the test itself.
//
// `tools/` is included for the same reason: the verification tools are allowed
// to have pure decisions in them, and when one of those decides whether a run
// passes it needs the same gate the shipping code gets. `measure:boot`'s does
// (DUB-21). Nothing here drives a browser — the drivers guard their entry
// points so importing them is inert.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
});
