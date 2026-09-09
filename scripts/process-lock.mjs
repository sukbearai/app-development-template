import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const held = new Set();
export function heldLockDescriptors() {
  return [...held];
}

export async function acquireProcessLock(lockPath) {
  const handle = await open(
    lockPath,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    // flock belongs to the shared open file description. The parent retains it after
    // the short helper exits; closing this descriptor or parent death releases it.
    const child = spawn(
      "python3",
      ["-c", "import fcntl; fcntl.flock(3,fcntl.LOCK_EX|fcntl.LOCK_NB)"],
      {
        stdio: ["ignore", "ignore", "ignore", handle.fd],
      },
    );
    await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("STATE_LOCKED"))));
    });
    held.add(handle.fd);
    return async () => {
      held.delete(handle.fd);
      await handle.close();
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
