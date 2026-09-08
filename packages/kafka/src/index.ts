import { readFileSync } from "node:fs";
import type { KafkaConfig, SASLOptions } from "kafkajs";

function readCertificate(env: NodeJS.ProcessEnv, name: string) {
  const file = env[name];
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new Error(`${name} could not be read`);
  }
}

function readSasl(env: NodeJS.ProcessEnv): SASLOptions {
  const username = env.KAFKA_SASL_USERNAME;
  const password = env.KAFKA_SASL_PASSWORD;
  if (!username) throw new Error("KAFKA_SASL_USERNAME is required for SASL_SSL");
  if (!password) throw new Error("KAFKA_SASL_PASSWORD is required for SASL_SSL");
  const mechanism = env.KAFKA_SASL_MECHANISM;
  switch (mechanism) {
    case "plain":
    case "scram-sha-256":
    case "scram-sha-512":
      return { mechanism, username, password };
    default:
      throw new Error("KAFKA_SASL_MECHANISM must be plain, scram-sha-256 or scram-sha-512");
  }
}

export function readKafkaConfig(env: NodeJS.ProcessEnv = process.env): KafkaConfig {
  const brokers = (env.KAFKA_BROKERS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!brokers.length) throw new Error("KAFKA_BROKERS is required");
  const protocol = env.KAFKA_SECURITY_PROTOCOL ?? "PLAINTEXT";
  if (protocol !== "PLAINTEXT" && protocol !== "SSL" && protocol !== "SASL_SSL")
    throw new Error("KAFKA_SECURITY_PROTOCOL must be PLAINTEXT, SSL or SASL_SSL");
  const tlsFields = ["KAFKA_SSL_CA_FILE", "KAFKA_SSL_CERT_FILE", "KAFKA_SSL_KEY_FILE"];
  const saslFields = ["KAFKA_SASL_MECHANISM", "KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD"];
  if (protocol === "PLAINTEXT" && tlsFields.some((name) => env[name]))
    throw new Error("KAFKA_SSL_* settings require SSL or SASL_SSL");
  if (protocol !== "SASL_SSL" && saslFields.some((name) => env[name]))
    throw new Error("KAFKA_SASL_* settings require SASL_SSL");
  const config: KafkaConfig = { brokers, clientId: env.KAFKA_CLIENT_ID || "app-template-worker" };
  if (protocol === "PLAINTEXT") return config;
  if (Boolean(env.KAFKA_SSL_CERT_FILE) !== Boolean(env.KAFKA_SSL_KEY_FILE))
    throw new Error("KAFKA_SSL_CERT_FILE and KAFKA_SSL_KEY_FILE must be configured together");
  const ca = readCertificate(env, "KAFKA_SSL_CA_FILE");
  const cert = readCertificate(env, "KAFKA_SSL_CERT_FILE");
  const key = readCertificate(env, "KAFKA_SSL_KEY_FILE");
  config.ssl = {
    rejectUnauthorized: true,
  };
  if (ca !== undefined) config.ssl.ca = [ca];
  if (cert !== undefined) {
    config.ssl.cert = cert;
    config.ssl.key = key;
  }
  if (protocol === "SASL_SSL") config.sasl = readSasl(env);
  return config;
}
