import { defineConfig } from 'vitest/config';

// The shell's tests cover pure logic only — the simulation loop and the save
// codec. Neither needs a DOM, so we stay on the fast `node` environment and
// fake `localStorage` with a plain in-memory object in the test itself.
//
// `tools/` is included because the screenshot driver's gates (DUB-108) decide
// whether a shot is captured or the run fails loudly, and that decision is
// pure enough to test without a browser. The driver only opens a CDP socket
// when it is the entry script, so importing it from a test is safe.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
});
