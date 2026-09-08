import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assessDeploymentConfig } from "../src/production-config.ts";
import { envSchema } from "../src/env-schema.ts";

const local = {
  METRICS_TOKEN: "A".repeat(43),
  APP_ORIGIN: "https://app.acme.internal",
  DATABASE_URL: "postgresql://app:random-deployment-credential@db:5432/app",
  UPLOAD_STORAGE_DRIVER: "local",
  UPLOAD_STORAGE_DIR: "/srv/app/uploads",
};
const s3 = {
  ...local, UPLOAD_STORAGE_DRIVER: "s3", WEB_REPLICAS: "2", RATE_LIMIT_DRIVER: "redis",
  REDIS_URL: "rediss://cache:6379", OBJECT_STORAGE_ENDPOINT: "https://objects.acme.internal",
  OBJECT_STORAGE_ACCESS_KEY: "provisioned-access-key", OBJECT_STORAGE_SECRET_KEY: "provisioned-secret-key",
  OBJECT_STORAGE_BUCKET: "app-files",
};

for (const [name, values, key, code] of [
  ["metrics placeholder", { METRICS_TOKEN: "replace_me_with_a_random_metrics_token" }, "METRICS_TOKEN", "PLACEHOLDER_CREDENTIAL"],
  ["missing metrics token", { METRICS_TOKEN: undefined }, "METRICS_TOKEN", "REQUIRED"],
  ["disabled metrics token", { METRICS_TOKEN: "" }, "METRICS_TOKEN", "REQUIRED"],
  ["missing origin", { APP_ORIGIN: undefined }, "APP_ORIGIN", "REQUIRED"],
  ["HTTP origin", { APP_ORIGIN: "http://app.acme.internal" }, "APP_ORIGIN", "HTTPS_REQUIRED"],
  ["origin path", { APP_ORIGIN: "https://app.acme.internal/path" }, "APP_ORIGIN", "INVALID_VALUE"],
  ["explicit insecure cookie", { SESSION_COOKIE_SECURE: "false" }, "SESSION_COOKIE_SECURE", "SECURE_COOKIE_REQUIRED"],
  ["invalid cookie override", { SESSION_COOKIE_SECURE: "perhaps" }, "SESSION_COOKIE_SECURE", "INVALID_VALUE"],
  ["missing database", { DATABASE_URL: undefined }, "DATABASE_URL", "REQUIRED"],
  ["database fragment", { DATABASE_URL: `${local.DATABASE_URL}#secret` }, "DATABASE_URL", "INVALID_DATABASE_URL"],
  ["database query override", { DATABASE_URL: `${local.DATABASE_URL}?password=changeme` }, "DATABASE_URL", "INVALID_DATABASE_URL"],
  ["invalid database URL", { DATABASE_URL: "https://db/app" }, "DATABASE_URL", "INVALID_DATABASE_URL"],
  ["database placeholder", { DATABASE_URL: "postgres://app:local-development-only@db/app" }, "DATABASE_URL", "PLACEHOLDER_CREDENTIAL"],
  ["encoded placeholder", { DATABASE_URL: "postgres://app:%63hangeme@db/app" }, "DATABASE_URL", "PLACEHOLDER_CREDENTIAL"],
  ["invalid URL escape", { DATABASE_URL: "postgres://app:%zz@db/app" }, "DATABASE_URL", "INVALID_URL"],
  ["implicit storage", { UPLOAD_STORAGE_DRIVER: undefined }, "UPLOAD_STORAGE_DRIVER", "REQUIRED"],
  ["relative storage", { UPLOAD_STORAGE_DIR: ".uploads" }, "UPLOAD_STORAGE_DIR", "ABSOLUTE_PATH_REQUIRED"],
  ["multiple replicas need Redis", { WEB_REPLICAS: "2" }, "RATE_LIMIT_DRIVER", "SHARED_RATE_LIMIT_REQUIRED"],
  ["multiple replicas need shared storage", { WEB_REPLICAS: "2", RATE_LIMIT_DRIVER: "redis", REDIS_URL: "redis://cache:6379" }, "UPLOAD_STORAGE_SHARED", "SHARED_STORAGE_REQUIRED"],
  ["Redis missing URL", { RATE_LIMIT_DRIVER: "redis" }, "REDIS_URL", "REQUIRED"],
  ["Redis invalid database", { RATE_LIMIT_DRIVER: "redis", REDIS_URL: "redis://cache/invalid" }, "REDIS_URL", "INVALID_URL"],
  ["Redis wrong protocol", { RATE_LIMIT_DRIVER: "redis", REDIS_URL: "https://cache" }, "REDIS_URL", "INVALID_URL"],
  ["Redis placeholder", { RATE_LIMIT_DRIVER: "redis", REDIS_URL: "redis://:changeme@cache:6379" }, "REDIS_URL", "PLACEHOLDER_CREDENTIAL"],
  ["invalid concurrency", { UPLOAD_MAX_CONCURRENT: "65" }, "UPLOAD_MAX_CONCURRENT", "INVALID_VALUE"],
  ["noninteger replicas", { WEB_REPLICAS: "1.5" }, "WEB_REPLICAS", "INVALID_VALUE"],
  ["invalid token", { METRICS_TOKEN: " secret " }, "METRICS_TOKEN", "INVALID_VALUE"],
  ["invalid shared boolean", { UPLOAD_STORAGE_SHARED: "yes" }, "UPLOAD_STORAGE_SHARED", "INVALID_VALUE"],
  ["invalid drain", { WEB_SHUTDOWN_TIMEOUT_MS: "0" }, "WEB_SHUTDOWN_TIMEOUT_MS", "INVALID_VALUE"],
  ["grace below default drain", { WEB_STOP_GRACE_PERIOD: "10s" }, "WEB_STOP_GRACE_PERIOD", "INSUFFICIENT_GRACE"],
  ["grace equals drain", { WEB_SHUTDOWN_TIMEOUT_MS: "40000", WEB_STOP_GRACE_PERIOD: "40s" }, "WEB_STOP_GRACE_PERIOD", "INSUFFICIENT_GRACE"],
  ["invalid publisher", { OUTBOX_PUBLISHER: "typo" }, "OUTBOX_PUBLISHER", "INVALID_VALUE"],
  ["diagnostic Kafka selection", { ASYNC_RUNTIME_PUBLISHER: "kafka" }, "KAFKA_SECURITY_PROTOCOL", "TLS_REQUIRED"],
  ["Kafka missing brokers", { OUTBOX_PUBLISHER: "kafka", KAFKA_SECURITY_PROTOCOL: "SSL" }, "KAFKA_BROKERS", "INVALID_KAFKA_CONFIG"],
  ["plaintext Kafka", { OUTBOX_PUBLISHER: "kafka", KAFKA_BROKERS: "broker:9092" }, "KAFKA_SECURITY_PROTOCOL", "TLS_REQUIRED"],
  ["Kafka invalid SASL", { OUTBOX_PUBLISHER: "kafka", KAFKA_BROKERS: "broker:9092", KAFKA_SECURITY_PROTOCOL: "SASL_SSL" }, "KAFKA_BROKERS", "INVALID_KAFKA_CONFIG"],
  ["Kafka unreadable certificate", { OUTBOX_PUBLISHER: "kafka", KAFKA_BROKERS: "broker:9092", KAFKA_SECURITY_PROTOCOL: "SSL", KAFKA_SSL_CA_FILE: "/nonexistent/private-certificate" }, "KAFKA_BROKERS", "INVALID_KAFKA_CONFIG"],
]) {
  test(`deployment rejects ${name}`, () => {
    const issues = assessDeploymentConfig({ ...local, ...values });
    assert.ok(issues.some((issue) => issue.key === key && issue.code === code), JSON.stringify(issues));
  });
}

test("deployment accepts explicit local, S3, or attested shared local configurations without NODE_ENV", () => {
  for (const config of [local, s3, { ...local, DATABASE_URL: "postgres://postgres:generated-password@db/app?sslmode=require" }, { ...s3, UPLOAD_STORAGE_DRIVER: "local", UPLOAD_STORAGE_SHARED: "true" },
    { ...local, WEB_SHUTDOWN_TIMEOUT_MS: "30000", WEB_STOP_GRACE_PERIOD: "40s" },
    { ...local, OUTBOX_PUBLISHER: "kafka", KAFKA_BROKERS: "broker:9092", KAFKA_SECURITY_PROTOCOL: "SSL" },
    { ...local, OUTBOX_PUBLISHER: "kafka", KAFKA_BROKERS: "broker:9092", KAFKA_SECURITY_PROTOCOL: "SASL_SSL", KAFKA_SASL_MECHANISM: "scram-sha-512", KAFKA_SASL_USERNAME: "app", KAFKA_SASL_PASSWORD: "generated-kafka-credential" },
  ]) assert.deepEqual(assessDeploymentConfig(config), []);
});

test("selected S3 needs explicit config and deployed credentials", () => {
  for (const key of ["OBJECT_STORAGE_ENDPOINT", "OBJECT_STORAGE_ACCESS_KEY", "OBJECT_STORAGE_SECRET_KEY", "OBJECT_STORAGE_BUCKET"])
    assert.ok(assessDeploymentConfig({ ...s3, [key]: undefined }).some((issue) => issue.key === key && issue.code === "REQUIRED"));
  assert.ok(assessDeploymentConfig({ ...s3, OBJECT_STORAGE_SECRET_KEY: "local-development-only" }).some((issue) => issue.code === "PLACEHOLDER_CREDENTIAL"));
  assert.ok(assessDeploymentConfig({ ...s3, OBJECT_STORAGE_ENDPOINT: "ftp://objects" }).some((issue) => issue.code === "INVALID_STORAGE_URL"));
});

test("schema remains importable without environment loading or mutation", () => {
  const raw = Object.freeze({ ...local });
  assert.deepEqual(assessDeploymentConfig(raw), []);
  assert.equal(envSchema.parse({}).UPLOAD_MAX_CONCURRENT, 2);
  assert.equal(envSchema.parse({}).UPLOAD_STORAGE_SHARED, false);
  assert.equal(envSchema.parse({}).METRICS_TOKEN, undefined);
  assert.equal(envSchema.parse({ METRICS_TOKEN: "" }).METRICS_TOKEN, undefined);
  for (const token of ["A".repeat(32), "_-aZ09".repeat(8), "A".repeat(256)])
    assert.equal(envSchema.parse({ METRICS_TOKEN: token }).METRICS_TOKEN, token);
  for (const token of ["A".repeat(31), "A".repeat(257), ` ${"A".repeat(32)}`, "é".repeat(32), "A".repeat(32) + "\n"])
    assert.equal(envSchema.safeParse({ METRICS_TOKEN: token }).success, false);
});

const script = fileURLToPath(new URL("../scripts/config-check.ts", import.meta.url));
const tsx = import.meta.resolve("tsx");
function runCli(args, env) {
  const cwd = mkdtempSync(path.join(tmpdir(), "pstack-config-check-"));
  try {
    writeFileSync(path.join(cwd, ".env"), "");
    return spawnSync(process.execPath, ["--import", tsx, script, ...args], {
      cwd, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 10000,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("explicit CLI deployment policy applies without NODE_ENV", () => {
  const failed = runCli(["--deployment"], {});
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /APP_ORIGIN \[REQUIRED\]/);
  const passed = runCli(["--deployment"], local);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /Deployment configuration valid/);
});

test("CLI rejects unknown and repeated arguments without echoing them", () => {
  for (const args of [["--private-secret"], ["--deployment", "--deployment"]]) {
    const result = runCli(args, local);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Usage: config:check \[--deployment\]/m);
    assert.ok(!result.stderr.includes("--private-secret"));
  }
});

test("CLI never reflects schema inputs, URLs, credentials, or certificate paths", () => {
  const secret = "TOP_SECRET_VALUE_!";
  for (const args of [[], ["--deployment"]]) {
    for (const env of [
      { ...local, UPLOAD_MAX_CONCURRENT: secret, METRICS_TOKEN: secret },
      { ...local, APP_ORIGIN: `https://user:${secret}@private.invalid/path`, DATABASE_URL: secret },
      { ...local, OUTBOX_PUBLISHER: "kafka", KAFKA_BROKERS: "broker:9092", KAFKA_SECURITY_PROTOCOL: "SSL", KAFKA_SSL_CA_FILE: `/private/${secret}` },
    ]) {
      const result = runCli(args, env);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
      if (args.length) assert.equal(result.status, 1, result.stderr);
    }
  }
});

test("ordinary local production CLI policy remains compatible", () => {
  for (const env of [{}, { NODE_ENV: "production", DATABASE_URL: "postgres://app:local-development-only@localhost/app", APP_ORIGIN: "http://localhost:3100", UPLOAD_STORAGE_DIR: ".uploads", SESSION_COOKIE_SECURE: "false" }]) {
    const result = runCli([], env);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Configuration valid/);
  }
});
