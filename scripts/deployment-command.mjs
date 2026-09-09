import { spawn } from "node:child_process";
import { heldLockDescriptors } from "./process-lock.mjs";

export function dockerCommand(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe", ...heldLockDescriptors()],
    });
    const chunks = [];
    let bytes = 0;
    let failure = false;
    const stop = () => {
      failure = true;
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") reject(new Error("DOCKER_COMMAND_FAILED"));
        }
      }
    };
    const deadline = setTimeout(stop, 180000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) stop();
      else chunks.push(chunk);
    });
    // Do not retain Docker stderr: rendered environments may contain credentials.
    child.stderr.on("data", () => {});
    child.once("error", () => {
      clearTimeout(deadline);
      reject(new Error("DOCKER_COMMAND_FAILED"));
    });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (code === 0 && !failure) resolve(Buffer.concat(chunks).toString("utf8").trim());
      else reject(new Error("DOCKER_COMMAND_FAILED"));
    });
  });
}
