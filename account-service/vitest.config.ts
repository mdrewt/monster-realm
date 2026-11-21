import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // The server tests start real processes and bind real sockets.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
