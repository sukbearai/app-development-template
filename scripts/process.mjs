import { spawn } from "node:child_process";
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", shell: false, ...options });
    let output = "";
    if (child.stdout) child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(output);
      else reject(new Error(`${command} failed (${signal || code})`));
    });
  });
}
