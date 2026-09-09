import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { toolchain } from "./toolchain.mjs";

async function certificate(directory, command, secrets) {
  const at = (name) => path.join(directory, name);
  await command("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=Published release rehearsal CA",
    "-keyout",
    at("ca.key"),
    "-out",
    at("ca.crt"),
  ]);
  await command("openssl", [
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=localhost",
    "-keyout",
    at("server.key"),
    "-out",
    at("server.csr"),
  ]);
  await writeFile(
    at("server.ext"),
    "subjectAltName=DNS:localhost,DNS:kafka,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
  );
  await command("openssl", [
    "x509",
    "-req",
    "-in",
    at("server.csr"),
    "-CA",
    at("ca.crt"),
    "-CAkey",
    at("ca.key"),
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    at("server.ext"),
    "-out",
    at("server.crt"),
  ]);
  const storePassword = randomBytes(24).toString("hex");
  secrets.push(storePassword);
  await command(
    "openssl",
    [
      "pkcs12",
      "-export",
      "-in",
      at("server.crt"),
      "-inkey",
      at("server.key"),
      "-certfile",
      at("ca.crt"),
      "-out",
      at("server.p12"),
      "-passout",
      "env:PSTACK_REHEARSAL_STORE_PASSWORD",
    ],
    {
      env: { ...process.env, PSTACK_REHEARSAL_STORE_PASSWORD: storePassword },
    },
  );
  return storePassword;
}

export function trustedFetch(ca) {
  return async (url, options) => {
    const request = new Request(url, options);
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : null;
    return await new Promise((resolve, reject) => {
      const outgoing = https.request(
        request.url,
        {
          method: request.method,
          headers: Object.fromEntries(request.headers),
          ca,
          signal: request.signal,
        },
        (incoming) => {
          const chunks = [];
          let bytes = 0;
          incoming.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) incoming.destroy(new Error("REHEARSAL_RESPONSE_TOO_LARGE"));
            else chunks.push(chunk);
          });
          incoming.once("error", reject);
          incoming.once("end", () => {
            try {
              resolve(
                new Response(
                  [204, 205, 304].includes(incoming.statusCode) ? null : Buffer.concat(chunks),
                  {
                    status: incoming.statusCode,
                    headers: Object.fromEntries(
                      Object.entries(incoming.headers).map(([key, value]) => [
                        key,
                        Array.isArray(value) ? value.join(", ") : value,
                      ]),
                    ),
                  },
                ),
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  };
}

export async function createRehearsalTarget(
  directory,
  project,
  repository,
  platform,
  docker,
  command,
  secrets,
) {
  const at = (name) => path.join(directory, name);
  const password = randomBytes(32).toString("hex");
  const adminPassword = randomBytes(32).toString("hex");
  const kafkaPassword = randomBytes(32).toString("hex");
  const metricsToken = randomBytes(32).toString("hex");
  secrets.push(password, adminPassword, kafkaPassword, metricsToken);
  const storePassword = await certificate(directory, command, secrets);
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const origin = `https://127.0.0.1:${port}`;
  const [context] = JSON.parse(await docker(["context", "inspect", "default"]));
  const target = {
    schemaVersion: 1,
    id: project,
    project,
    context: "default",
    endpoint: context.Endpoints.docker.Host,
    repository,
    platform,
    composeFiles: [at("compose.json")],
    envFile: at("application.env"),
    stateDirectory: at("state"),
    services: ["web", "worker"],
    readinessUrl: `${origin}/api/system/health`,
    timeoutSeconds: 180,
  };
  assert.ok(target.endpoint.startsWith("unix:///"), "A local Docker socket is required");
  const environment = {
    NODE_ENV: "production",
    DATABASE_URL: `postgres://app:${password}@postgres:5432/app`,
    APP_NAME: "Published release rehearsal",
    APP_ORIGIN: origin,
    SESSION_COOKIE_SECURE: "true",
    METRICS_TOKEN: metricsToken,
    RATE_LIMIT_DRIVER: "memory",
    LOGIN_RATE_LIMIT_MAX: "100",
    UPLOAD_STORAGE_DRIVER: "local",
    UPLOAD_STORAGE_DIR: "/app/uploads",
    KAFKA_BROKERS: "kafka:9092",
    KAFKA_CLIENT_ID: project,
    KAFKA_CONSUMER_GROUP_ID: project,
    KAFKA_SECURITY_PROTOCOL: "SASL_SSL",
    KAFKA_SSL_CA_FILE: "/security/ca.crt",
    KAFKA_SASL_MECHANISM: "plain",
    KAFKA_SASL_USERNAME: "rehearsal",
    KAFKA_SASL_PASSWORD: kafkaPassword,
    OUTBOX_PUBLISHER: "kafka",
    ASYNC_RUNTIME_PUBLISHER: "kafka",
    OUTBOX_POLL_INTERVAL_MS: "200",
    ASYNC_RUNTIME_TOPICS: "app.tasks,telemetry.events,files.events,audit.events",
    WORKER_HEARTBEAT_PATH: "/tmp/pstack-worker-heartbeat.json",
    APP_TEMPLATE_WORKER_SKIP_ENV_FILES: "1",
    BOOTSTRAP_ADMIN_ACCOUNT: "admin",
    BOOTSTRAP_ADMIN_PASSWORD: adminPassword,
  };
  await writeFile(
    target.envFile,
    Object.entries(environment)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    at("server.properties"),
    [
      "process.roles=broker,controller",
      "node.id=1",
      "controller.quorum.voters=1@localhost:9093",
      "listeners=EXTERNAL://:9092,CONTROLLER://localhost:9093,INTERNAL://localhost:9094",
      "advertised.listeners=EXTERNAL://kafka:9092,INTERNAL://localhost:9094",
      "listener.security.protocol.map=EXTERNAL:SASL_SSL,CONTROLLER:PLAINTEXT,INTERNAL:PLAINTEXT",
      "controller.listener.names=CONTROLLER",
      "inter.broker.listener.name=INTERNAL",
      "sasl.enabled.mechanisms=PLAIN",
      `listener.name.external.plain.sasl.jaas.config=org.apache.kafka.common.security.plain.PlainLoginModule required user_rehearsal="${kafkaPassword}";`,
      "ssl.keystore.type=PKCS12",
      "ssl.keystore.location=/security/server.p12",
      `ssl.keystore.password=${storePassword}`,
      "ssl.client.auth=none",
      "offsets.topic.replication.factor=1",
      "transaction.state.log.replication.factor=1",
      "transaction.state.log.min.isr=1",
      "group.initial.rebalance.delay.ms=0",
      "log.dirs=/var/lib/kafka/data",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    at("nginx.conf"),
    `events {}\nhttp { resolver 127.0.0.11 valid=1s; server { listen 443 ssl; ssl_certificate /security/server.crt; ssl_certificate_key /security/server.key; location / { set $application web:3000; proxy_pass http://$application; proxy_set_header Host $http_host; proxy_set_header X-Forwarded-Proto https; } } }\n`,
  );
  const app = {
    image: "${PSTACK_WEB_IMAGE}",
    environment: Object.fromEntries(Object.keys(environment).map((key) => [key, `\${${key}}`])),
    init: true,
    volumes: ["uploads:/app/uploads", `${at("ca.crt")}:/security/ca.crt:ro`],
    stop_grace_period: "40s",
  };
  const healthcheck = (test) => ({
    test: ["CMD", ...test],
    interval: "3s",
    timeout: "10s",
    retries: 60,
  });
  await writeFile(
    target.composeFiles[0],
    JSON.stringify({
      services: {
        postgres: {
          image: toolchain.images.postgres,
          environment: { POSTGRES_USER: "app", POSTGRES_DB: "app", POSTGRES_PASSWORD: password },
          volumes: ["database:/var/lib/postgresql/data"],
          healthcheck: healthcheck(["pg_isready", "-U", "app", "-d", "app"]),
        },
        kafka: {
          image: toolchain.images.kafka,
          user: "0:0",
          volumes: [
            `${at("server.properties")}:/security/server.properties:ro`,
            `${at("server.p12")}:/security/server.p12:ro`,
            "kafka-data:/var/lib/kafka/data",
          ],
          entrypoint: ["/bin/bash", "-ec"],
          command: [
            "/opt/kafka/bin/kafka-storage.sh format --ignore-formatted --cluster-id MkU3OEVBNTcwNTJENDM2Qk --config /security/server.properties >/dev/null && exec /opt/kafka/bin/kafka-server-start.sh /security/server.properties",
          ],
        },
        ingress: {
          image: toolchain.images.nginx,
          ports: [`127.0.0.1:${port}:443`],
          volumes: [
            `${at("nginx.conf")}:/etc/nginx/nginx.conf:ro`,
            `${at("server.crt")}:/security/server.crt:ro`,
            `${at("server.key")}:/security/server.key:ro`,
          ],
        },
        migrate: { ...app, command: ["pnpm", "--filter", "@pstack/database", "db:migrate"] },
        web: {
          ...app,
          healthcheck: healthcheck([
            "node",
            "-e",
            "fetch('http://127.0.0.1:3000/api/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ]),
        },
        worker: {
          ...app,
          image: "${PSTACK_WORKER_IMAGE}",
          healthcheck: healthcheck([
            "pnpm",
            "--filter",
            "@pstack/worker",
            "exec",
            "tsx",
            "src/index.ts",
            "health",
            "--live",
          ]),
        },
      },
      volumes: { database: {}, "kafka-data": {}, uploads: {} },
    }),
    { mode: 0o600 },
  );
  const targetFile = at("target.json");
  await writeFile(targetFile, JSON.stringify(target), { mode: 0o600 });
  return {
    target,
    targetFile,
    origin,
    adminPassword,
    ca: await readFile(at("ca.crt")),
    caFile: at("ca.crt"),
  };
}
