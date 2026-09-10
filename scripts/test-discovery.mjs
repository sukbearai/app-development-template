import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

export const testSuites = ["unit", "integration", "web-runtime"];

export async function inspectTestLayout(workspace, declaredSuites = []) {
  const files = Object.fromEntries(testSuites.map((suite) => [suite, []]));
  const findings = [];
  const report = (file, rule, message) => findings.push({ file, rule, message });
  try {
    if ((await lstat(path.join(workspace, "tests"))).isSymbolicLink()) {
      report("tests", "test-symlink", "Keep the tests directory inside its workspace.");
      return { files, findings };
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(path.join(workspace, directory), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT" && directory === "tests") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const file = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        report(file, "test-symlink", "Keep test files in one suite without symbolic links.");
      } else if (entry.isDirectory()) {
        await visit(file);
      } else if (/\.test(?:\.|$)/.test(entry.name)) {
        const suite = file.split("/")[1];
        if (!testSuites.includes(suite)) {
          report(file, "test-suite", "Move executable tests into tests/<suite>/.");
        } else if (!entry.name.endsWith(".test.mjs")) {
          report(file, "test-extension", "Use the .test.mjs extension for executable tests.");
        } else {
          files[suite].push(file);
        }
      }
    }
  }
  await visit("tests");
  for (const suite of declaredSuites) {
    if (!testSuites.includes(suite)) {
      report("package.json", "test-suite", `Unknown test suite: ${suite}`);
    } else if (files[suite].length === 0) {
      report(`tests/${suite}`, "test-empty", `Declared test suite ${suite} has no tests.`);
    }
  }
  for (const suite of testSuites) files[suite].sort();
  return { files, findings };
}

export async function discoverTests(workspace, suite) {
  const { files, findings } = await inspectTestLayout(workspace, [suite]);
  if (findings.length) {
    throw new Error(
      findings.map(({ file, rule, message }) => `${file}: ${rule}: ${message}`).join("\n"),
    );
  }
  return files[suite];
}
