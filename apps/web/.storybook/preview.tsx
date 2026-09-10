import type { Preview } from "@storybook/react-vite";
import { mswLoader } from "msw-storybook-addon/csf3";
import { setupWorker } from "msw/browser";
import "../app/globals.css";
import { router } from "./navigation";
import { AppQueryProvider } from "../components/providers/query-provider";

const preview: Preview = {
  decorators: [
    (Story) => (
      <AppQueryProvider>
        <Story />
      </AppQueryProvider>
    ),
  ],
  loaders: [
    mswLoader(async () => {
      const worker = setupWorker();
      await worker.start({
        quiet: true,
        onUnhandledRequest(request, print) {
          if (new URL(request.url).pathname.startsWith("/api/")) print.error();
        },
      });
      return worker;
    }),
  ],
  parameters: { layout: "padded" },
  beforeEach() {
    router.refresh.mockClear();
    router.replace.mockClear();
  },
};

export default preview;
