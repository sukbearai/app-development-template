import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

export const toolchain = JSON.parse(
  await readFile(new URL("./toolchain-lock.json", import.meta.url), "utf8"),
);
export function lockedImage(name, override) {
  const image = override || toolchain.images[name];
  assert.match(
    image,
    /^[A-Za-z0-9][A-Za-z0-9._/:-]*@sha256:[a-f0-9]{64}$/,
    "Image override must include an immutable sha256 digest",
  );
  return image;
}
