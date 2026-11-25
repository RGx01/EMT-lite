// The CSP check (design §7): the built page, served with the production headers from public/_headers
// (vite preview reads them), driven through the demo in Chromium. Runs in CI; locally it needs
// `npx playwright install chromium` once.
import { defineConfig } from '@playwright/test';

const PORT = 4174;   // not 4173, so a running `npm run preview` does not get in the way

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, browserName: 'chromium' },
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
