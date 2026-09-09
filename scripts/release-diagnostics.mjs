export class PublicationError extends Error {
  constructor(stage, cause) {
    super(`Publication failed at ${stage}`, { cause });
    this.stage = stage;
  }
}
function redact(value, env) {
  let text = String(value);
  const secrets = Object.entries(env)
    .filter(([name, secret]) => /TOKEN|PASSWORD|SECRET|KEY|CREDENTIAL|AUTH/i.test(name) && secret)
    .map(([, secret]) => secret)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}${parsed.search ? "?[redacted]" : ""}`;
      } catch {
        return "[redacted URL]";
      }
    })
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[redacted authorization]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
    .replace(/((?:token|password|secret|authorization)["']?\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\p{Cc}/gu, (character) => (["\n", "\t"].includes(character) ? character : ""))
    .slice(0, 4096);
}
export function publicationFailure(error, env = process.env) {
  const cause = error instanceof PublicationError ? error.cause : error;
  const subprocess =
    cause instanceof Error && ("stderr" in cause || "status" in cause || "spawnargs" in cause);
  return {
    stage: error instanceof PublicationError ? error.stage : "initialization",
    code: /^[A-Z][A-Z0-9_]{0,63}$/.test(cause?.code) ? cause.code : null,
    exitCode: Number.isInteger(cause?.status) ? cause.status : null,
    signal: /^SIG[A-Z0-9]+$/.test(cause?.signal) ? cause.signal : null,
    message: subprocess
      ? "External command failed"
      : redact(cause?.message ?? "Unknown error", env),
    stderr: subprocess ? redact(cause.stderr ?? "", env) : null,
  };
}
