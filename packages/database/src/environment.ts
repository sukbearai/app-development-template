import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
export function loadEnvironment(root = workspaceRoot(), target: NodeJS.ProcessEnv = process.env) {
  for (const name of [".env.local", ".env"]) {
    const file = path.join(root, name);
    if (!existsSync(file)) continue;
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8"))))
      if (target[key] === undefined) target[key] = value;
  }
  return target;
}

function workspaceRoot() {
  let current = process.cwd();
  while (!existsSync(path.join(current, "pnpm-workspace.yaml"))) {
    const parent = path.dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
  return current;
}
