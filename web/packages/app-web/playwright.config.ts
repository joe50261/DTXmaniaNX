import { defineConfig, devices } from '@playwright/test';

// Vite's config.ts uses GITHUB_ACTIONS to switch the SPA base between
// `/DTXmaniaNX/` (project-Pages URL) and `/` (local). The built dist
// bakes that base into index.html, so `vite preview` serves the app at
// whichever path the build targeted — Playwright's baseURL must match.
const base = process.env.GITHUB_ACTIONS ? '/DTXmaniaNX/' : '/';
const baseURL = `http://localhost:4173${base}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm preview --host 127.0.0.1 --port 4173 --strictPort',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
