import { defineConfig } from 'vitest/config';

// happy-dom gives us a cheap localStorage / window / document shim so
// tests that exercise browser-side code (config migration, future DOM
// integration) can run without a full jsdom overhead. Kept separate
// from vite.config.ts so build-time options don't leak into tests.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
});
