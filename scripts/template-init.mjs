#!/usr/bin/env node
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function parseName(args) {
  if (args.length !== 2 || args[0] !== "--name" || !/^[a-z][a-z0-9-]{1,62}$/.test(args[1]))
    throw new Error("Usage: pnpm template:init --name lowercase-project-name");
  return args[1];
}

function setAppName(contents, name) {
  const line = `APP_NAME=${JSON.stringify(name)}`;
  if (/^\s*APP_NAME\s*=.*$/m.test(contents)) return contents.replace(/^\s*APP_NAME\s*=.*$/m, line);
  return `${line}\n${contents}`;
}

async function main() {
  const name = parseName(process.argv.slice(2).filter((arg) => arg !== "--"));
  const file = path.join(root, "package.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.name = name;
  await writeFile(file, JSON.stringify(manifest, null, 2) + "\n");
  const envExample = path.join(root, ".env.example");
  await writeFile(envExample, setAppName(await readFile(envExample, "utf8"), name));
  try {
    await copyFile(envExample, path.join(root, ".env"), constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const envFile = path.join(root, ".env");
    await writeFile(envFile, setAppName(await readFile(envFile, "utf8"), name));
  }
  console.log(
    `Project renamed to ${name}. APP_NAME is synchronized; other .env and workspace package names are preserved. Edit credentials and ports in .env before use.`,
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
