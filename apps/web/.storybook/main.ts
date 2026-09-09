import { fileURLToPath } from "node:url";
import type { StorybookConfig } from "@storybook/react-vite";
import react from "@vitejs/plugin-react";

const config: StorybookConfig = {
  stories: ["../stories/**/*.stories.tsx"],
  addons: ["@storybook/addon-vitest", "msw-storybook-addon"],
  framework: {
    name: "@storybook/react-vite",
    options: { builder: { viteConfigPath: ".storybook/vite.config.ts" } },
  },
  staticDirs: ["../../../artifacts/storybook-msw"],
  async viteFinal(config) {
    const { mergeConfig } = await import("vite");
    return mergeConfig(config, {
      plugins: [react()],
      resolve: {
        alias: {
          "@": fileURLToPath(new URL("../", import.meta.url)),
          "next/navigation": fileURLToPath(new URL("./navigation.ts", import.meta.url)),
        },
      },
    });
  },
};

export default config;
