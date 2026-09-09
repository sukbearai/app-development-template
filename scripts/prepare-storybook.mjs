import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const output = new URL("../artifacts/storybook-msw/", import.meta.url);
await mkdir(output, { recursive: true });
await copyFile(
  require.resolve("msw/mockServiceWorker.js"),
  new URL("mockServiceWorker.js", output),
);
