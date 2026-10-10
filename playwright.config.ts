import { defineConfig, devices } from '@playwright/test';

/**
 * The local-only flows at phone + desktop sizes, in both themes (npm run e2e).
 * Sync flows (claim, second device, PT sharing) need a real Supabase project: not covered here yet.
 */
const PORT = 5199;
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', serviceWorkers: 'block' },
  webServer: {
    // Empty Supabase env: the app runs fully local, exactly like before sync is set up.
    command: `npx vite --port ${PORT} --strictPort`,
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    { name: 'phone-dark', use: { ...devices['Pixel 7'], colorScheme: 'dark' } },
    { name: 'phone-light', use: { ...devices['Pixel 7'], colorScheme: 'light' } },
    { name: 'desktop-dark', use: { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' } },
    { name: 'desktop-light', use: { viewport: { width: 1280, height: 800 }, colorScheme: 'light' } },
  ],
});
