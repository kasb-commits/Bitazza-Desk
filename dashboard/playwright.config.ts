import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3002',
    headless: true,
    channel: 'chrome',
    viewport: { width: 1400, height: 900 },
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { channel: 'chrome' } },
  ],
});
