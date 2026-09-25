import { defineConfig, devices } from '@playwright/test';

// E2E_PORT lets several checkouts (e.g. git worktrees) run the suite at the
// same time: each run starts its own dev server on its own port instead of
// reusing whichever server already listens on 3000.
const PORT = Number(process.env.E2E_PORT ?? 3000);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',

    // Fixed viewport so layout assertions see a consistent size
    viewport: { width: 1280, height: 720 },

    actionTimeout: 10000,
  },

  // The app requires the Screen Capture API and officially supports
  // Chromium-based browsers only (see README), so E2E runs on Chromium alone.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `npm run dev -- --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
