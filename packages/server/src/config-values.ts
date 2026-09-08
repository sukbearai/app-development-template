import { z } from "zod";

export const booleanString = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

export const appOriginSchema = z.url().transform((value) => new URL(value)).refine((url) => {
  return ["http:", "https:"].includes(url.protocol) &&
    !url.username && !url.password && url.pathname === "/" &&
    !url.search && !url.hash;
}, "APP_ORIGIN must be an HTTP(S) origin without credentials, path, query, or fragment")
  .transform((url) => url.origin);
