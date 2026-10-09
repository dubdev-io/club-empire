import { defineConfig } from 'vitest/config';

// The shell's tests cover pure logic only — the simulation loop and the save
// codec. Neither needs a DOM, so we stay on the fast `node` environment and
// fake `localStorage` with a plain in-memory object in the test itself.
//
// `tools/` is in scope for the same reason: the measurement harnesses there
// decide numbers people act on, and the pure half of that arithmetic is worth
// pinning without a browser (DUB-54). The browser-driving half is verified by
// running the tool, not from here.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
});
