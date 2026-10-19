import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  workers: 1,
  use: { viewport: { width: 1200, height: 800 }, screenshot: 'only-on-failure' },
});
