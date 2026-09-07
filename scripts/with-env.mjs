#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvironment } from "./env.mjs";
import { run } from "./process.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnvironment(root);
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("with-env requires a command");
await run(command, args, { cwd: root });
