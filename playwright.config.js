const { defineConfig } = require('@playwright/test');

const headless = process.env.PERF_HEADLESS === 'true' ? true : false;
const maximize = process.env.PERF_MAXIMIZE === 'true' ? true : !headless;
const kiosk = process.env.PERF_KIOSK === 'true' ? true : false;

module.exports = defineConfig({
  testDir: 'tests/playwright',
  timeout: 5 * 60 * 1000,
  expect: { timeout: 30 * 1000 },
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: 'tests/playwright-artifacts/html-report', open: 'never' }]],
  outputDir: 'tests/playwright-artifacts/test-results',
  use: {
    headless,
    viewport: maximize ? null : {
      width: Number(process.env.PERF_VIEWPORT_W || 1920),
      height: Number(process.env.PERF_VIEWPORT_H || 1080)
    },
    launchOptions: maximize ? { args: kiosk ? ['--start-maximized', '--kiosk'] : ['--start-maximized'] } : {},
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  workers: 1
});
