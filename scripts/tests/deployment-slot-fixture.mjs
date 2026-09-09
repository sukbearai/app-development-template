import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { evidenceReference } from "../verification-evidence.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { slotRuntime } from "../deployment-slots.mjs";

export async function fixtureVerify(root, file) {
  return {
    release: JSON.parse(await readFile(file, "utf8")),
    manifest: await evidenceReference(root, file),
  };
}
export function fixtureRuntime(target, barrier) {
  const runtime = slotRuntime(target, async (args, env) => {
    try {
      return (
        await promisify(execFile)("docker", args, { env, maxBuffer: 8 * 1024 * 1024 })
      ).stdout.trim();
    } catch (error) {
      throw new Error(`fixture docker ${args.join(" ")}: ${error.stderr}`);
    }
  });
  runtime.schema = async () => {};
  if (barrier) {
    const original = runtime[barrier];
    runtime[barrier] = async (...args) => {
      const value = await original(...args);
      process.kill(process.pid, "SIGKILL");
      return value;
    };
  }
  return runtime;
}
export async function writeSlotFixture(root, target, image) {
  await mkdir(root, { recursive: true });
  await writeFile(target.envFile, "");
  const webCode = `const http=require('http'),fs=require('fs');
  http.createServer((q,r)=>{if(q.url==='/api/system/health'&&process.env.FIXTURE_UNHEALTHY==='1'){r.writeHead(503);r.end('{}');return}const answer=()=>{if(q.url==='/write')fs.appendFileSync('/proof/writes','ok\\n');r.end(JSON.stringify({data:{status:'ok'},replica:require('os').hostname(),version:process.env.FIXTURE_VERSION}))};
  if(q.url==='/long'){fs.writeFileSync('/proof/long-started','yes');const timer=setInterval(()=>{if(fs.existsSync('/proof/release-long')){clearInterval(timer);answer()}},100);r.on('close',()=>clearInterval(timer))}else answer()}).listen(3000,'0.0.0.0');`;
  const common = { image: "${PSTACK_WEB_IMAGE}", networks: ["shared"], volumes: ["proof:/proof"] };
  await writeFile(
    target.composeFiles[0],
    JSON.stringify({
      services: {
        migrate: {
          ...common,
          environment: { PGOPTIONS: "-c lock_timeout=1000 -c statement_timeout=120000" },
          entrypoint: [
            "node",
            "-e",
            "if(process.argv.includes('db:migrate'))require('fs').appendFileSync('/proof/migrations','once\\n')",
            "--",
          ],
          command: ["pnpm", "--filter", "@pstack/database", "db:migrate"],
        },
        web: {
          ...common,
          command: ["node", "-e", webCode],
          environment: {
            WEB_REPLICAS: "${WEB_REPLICAS}",
            RATE_LIMIT_DRIVER: "redis",
            UPLOAD_STORAGE_SHARED: "true",
          },
          healthcheck: {
            test: ["CMD", "node", "-e", "process.exit(process.env.FIXTURE_UNHEALTHY==='1'?1:0)"],
            interval: "1s",
            timeout: "2s",
            retries: 20,
          },
          stop_grace_period: "10s",
        },
      },
      networks: { shared: { external: true, name: target.network } },
      volumes: { proof: { external: true, name: `${target.project}-data` } },
    }),
  );
  for (const [name, version] of [
    ["old", "1.0.0"],
    ["next", "1.0.1"],
    ["bad", "1.0.2"],
  ]) {
    const selected = image[name] ?? image;
    const release = {
      version,
      images: Object.fromEntries(
        ["web", "worker"].map((role) => [
          role,
          { id: selected.Id, reference: selected.reference, platform: target.platform },
        ]),
      ),
      compatibility: {
        migrationLedgerSha256: "a".repeat(64),
        recoveryProtocol: "pstack-recovery-v2",
        rollbackVersions: ["1.0.0"],
      },
    };
    await writeFile(path.join(root, `${name}.json`), JSON.stringify(release));
    await writeFile(path.join(root, `${name}.json.sigstore.json`), "{}");
  }
}
