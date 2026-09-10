import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { discoverTests } from "./test-discovery.mjs";

export async function testRun(workspace, suite) {
  const files = await discoverTests(workspace, suite);
  const tsconfig = suite === "web-runtime" ? "../../apps/web/tsconfig.json" : null;
  const require = createRequire(path.join(path.resolve(workspace), "package.json"));
  const loader = pathToFileURL(require.resolve("tsx")).href;
  return { suite, files, loader, tsconfig, args: ["--import", loader, "--test", ...files] };
}

async function main() {
  const options = process.argv.slice(2);
  const list = options.includes("--list");
  const suites = options.filter((option) => option !== "--list");
  if (!suites.length || new Set(suites).size !== suites.length) {
    throw new Error(
      "Usage: node scripts/run-tests.mjs <suite...> [--list]; select each suite once.",
    );
  }
  const workspace = process.cwd();
  const runs = [];
  for (const suite of suites) runs.push(await testRun(workspace, suite));
  if (list) {
    process.stdout.write(`${JSON.stringify(runs, null, 2)}\n`);
    return;
  }
  for (const run of runs) {
    const env = { ...process.env };
    if (run.tsconfig) env.TSX_TSCONFIG_PATH = path.resolve(workspace, run.tsconfig);
    const child = spawn(process.execPath, run.args, { cwd: workspace, env, stdio: "inherit" });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (status, signal) =>
          resolve(status ?? (signal === "SIGINT" ? 130 : 143)),
        );
      });
      if (code !== 0) {
        process.exitCode = code;
        return;
      }
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
