import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";

const { open, rename } = fs;
const log = process.env.TEST_BACKUP_SYNC_LOG;
if (!log) throw new Error("TEST_BACKUP_SYNC_LOG is required by the backup sync fixture");
const record = (event) => appendFileSync(log, JSON.stringify(event) + "\n");
fs.open = async function (file, ...args) {
  const handle = await open(file, ...args);
  const sync = handle.sync.bind(handle);
  handle.sync = async () => {
    const filename = path.resolve(file);
    if (filename === process.env.TEST_BACKUP_SYNC_FAILURE) {
      record({ type: "sync-failure", path: filename });
      throw new Error("Injected backup ancestor fsync failure");
    }
    await sync();
    record({ type: "sync", path: filename });
  };
  return handle;
};
fs.rename = async function (source, destination) {
  await rename(source, destination);
  record({ type: "publish", path: path.resolve(destination) });
};
syncBuiltinESMExports();
