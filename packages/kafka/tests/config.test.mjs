import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readKafkaConfig } from "../src/index.ts";

const base = { KAFKA_BROKERS: " first:9092, second:9092, " };
test("plaintext defaults preserve broker parsing and reject misplaced security settings", () => {
  assert.deepEqual(readKafkaConfig(base), { brokers: ["first:9092", "second:9092"], clientId: "app-template-worker" });
  for (const protocol of ["SASL_PLAINTEXT", "ssl", "", "secret-invalid-value"])
    assert.throws(() => readKafkaConfig({ ...base, KAFKA_SECURITY_PROTOCOL: protocol }), /KAFKA_SECURITY_PROTOCOL must/);
  assert.throws(() => readKafkaConfig({}), /KAFKA_BROKERS is required/);
  for (const key of ["KAFKA_SSL_CA_FILE", "KAFKA_SSL_CERT_FILE", "KAFKA_SSL_KEY_FILE", "KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD", "KAFKA_SASL_MECHANISM"])
    assert.throws(() => readKafkaConfig({ ...base, [key]: "secret" }), /settings require/);
});

test("TLS always verifies server identity and supports system roots and paired client certificates", async () => {
  const env = { ...base, KAFKA_SECURITY_PROTOCOL: "SSL" };
  assert.deepEqual(readKafkaConfig(env).ssl, { rejectUnauthorized: true });
  for (const key of ["KAFKA_SSL_CERT_FILE", "KAFKA_SSL_KEY_FILE"])
    assert.throws(() => readKafkaConfig({ ...env, [key]: "/private/secret" }), /configured together/);
  assert.throws(() => readKafkaConfig({ ...env, KAFKA_SASL_PASSWORD: "secret" }), /require SASL_SSL/);
  const directory = await mkdtemp(path.join(os.tmpdir(), "kafka-config-"));
  try {
    for (const kind of ["CA", "CERT", "KEY"]) {
      const file = path.join(directory, kind);
      await writeFile(file, `fixture-${kind}`, { mode: 0o600 });
      env[`KAFKA_SSL_${kind}_FILE`] = file;
    }
    assert.deepEqual(readKafkaConfig(env).ssl, { rejectUnauthorized: true, ca: ["fixture-CA"], cert: "fixture-CERT", key: "fixture-KEY" });
    for (const kind of ["CA", "CERT", "KEY"]) {
      const field = `KAFKA_SSL_${kind}_FILE`;
      assert.throws(() => readKafkaConfig({ ...env, [field]: "/private/secret/missing" }), (error) => error.message === `${field} could not be read` && error.cause === undefined);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SASL requires TLS, an explicit supported mechanism and both credentials", () => {
  const env = { ...base, KAFKA_SECURITY_PROTOCOL: "SASL_SSL", KAFKA_SASL_USERNAME: " user ", KAFKA_SASL_PASSWORD: " password " };
  for (const mechanism of ["plain", "scram-sha-256", "scram-sha-512"]) {
    const config = readKafkaConfig({ ...env, KAFKA_SASL_MECHANISM: mechanism });
    assert.deepEqual(config.sasl, { mechanism, username: " user ", password: " password " });
    assert.equal(config.ssl.rejectUnauthorized, true);
  }
  for (const mechanism of [undefined, "PLAIN", "oauthbearer", "scram-sha256"])
    assert.throws(() => readKafkaConfig({ ...env, KAFKA_SASL_MECHANISM: mechanism }), /KAFKA_SASL_MECHANISM must/);
  for (const key of ["KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD"])
    assert.throws(() => readKafkaConfig({ ...env, KAFKA_SASL_MECHANISM: "plain", [key]: "" }), new RegExp(`${key} is required`));
});
