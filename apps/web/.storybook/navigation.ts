import { fn } from "storybook/test";

export const router = {
  refresh: fn(),
  replace: fn<(path: string) => void>(),
};

export function useRouter() {
  return router;
}
