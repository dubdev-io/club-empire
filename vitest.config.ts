import { defineConfig } from 'vitest/config';

// The shell's tests cover pure logic only — the simulation loop and the save
// codec. Neither needs a DOM, so we stay on the fast `node` environment and
// fake `localStorage` with a plain in-memory object in the test itself.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
