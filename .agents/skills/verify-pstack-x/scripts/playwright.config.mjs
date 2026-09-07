import { defineConfig } from '@playwright/test';

const output = process.env.PSTACK_VERIFY_OUTPUT;
if (!output) throw new Error('Use scripts/run.sh to allocate an evidence directory.');
const baseURL = `http://127.0.0.1:${process.env.PSTACK_VERIFY_PORT}`;

export default defineConfig({
  testDir: '.',
  testMatch: 'app.spec.mjs',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  outputDir: `${output}/test-results`,
  reporter: [
    ['list'],
    ['json', { outputFile: `${output}/results.json` }],
    ['html', { outputFolder: `${output}/report`, open: 'never' }],
  ],
  use: {
    browserName: 'chromium',
    baseURL,
    viewport: { width: 1280, height: 800 },
    trace: 'on',
    screenshot: 'on',
    video: 'off',
  },
  webServer: {
    command: `pnpm run dev --hostname 127.0.0.1 --port ${process.env.PSTACK_VERIFY_PORT}`,
    cwd: process.cwd(),
    url: `${baseURL}/api/hello`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
