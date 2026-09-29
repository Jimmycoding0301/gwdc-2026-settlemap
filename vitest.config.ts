import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'server/**/*.test.ts', 'shared/**/*.test.ts'],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
