import vinext from "vinext";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [vinext()],
  ssr: { external: ["pg", "redis", "@aws-sdk/client-s3", "kafkajs", "drizzle-orm"] },
});
