import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: ".",
  testMatch: "smoke.spec.ts",
  outputDir: "../../../artifacts/storybook-smoke",
  use: {
    baseURL: "http://127.0.0.1:6106",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm storybook:preview",
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    url: "http://127.0.0.1:6106/index.json",
    reuseExistingServer: false,
  },
});
