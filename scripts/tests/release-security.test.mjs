import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { checkExecutableReferences } from "../check-supply-chain.mjs";
import {
  checkAttestation,
  checkAudit,
  checkDatabase,
  checkReport,
  scanCandidate,
  provenance,
  trustArguments,
  verifyReleaseSecurity,
  verifyScanEvidence,
} from "../release-security.mjs";
import { releaseFixture } from "./release-fixture.mjs";

test("mutable actions, frontend, middleware and build overrides are rejected", () => {
  for (const [file, source] of [
    ["ci.yml", "uses: actions/checkout@v4"],
    ["Dockerfile", "# syntax=docker/dockerfile:1"],
    ["compose.yml", "image: postgres:17-alpine"],
    ["Dockerfile", "ARG NODE_IMAGE=anything"],
  ])
    assert.throws(() => checkExecutableReferences(source, file));
});
test("slot images come from verified release variables without mutable defaults", () => {
  const file = "deploy/compose/slots.yml";
  for (const role of ["WEB", "WORKER"])
    checkExecutableReferences(
      `image: \u0024{PSTACK_${role}_IMAGE:?Use release:plan to obtain a verified digest reference}`,
      file,
    );
  assert.throws(() => checkExecutableReferences("image: ${PSTACK_WEB_IMAGE:-web:latest}", file));
  assert.throws(() => checkExecutableReferences("image: nginx:latest", file));
});
test("audit and scanner malformed output and HIGH findings cannot pass", () => {
  assert.throws(() => checkAudit({ metadata: { vulnerabilities: {} } }));
  assert.throws(() => checkAudit({ metadata: { vulnerabilities: { high: 1, critical: 0 } } }));
  assert.throws(() =>
    checkReport(
      {
        SchemaVersion: 2,
        ArtifactType: "container_image",
        Metadata: { ImageID: "x" },
        Results: [],
      },
      "x",
    ),
  );
  assert.throws(
    () =>
      checkReport(
        {
          SchemaVersion: 2,
          ArtifactType: "container_image",
          Metadata: { ImageID: "x" },
          Results: [
            {
              Class: "os-pkgs",
              Vulnerabilities: [{ Severity: "HIGH", VulnerabilityID: "CVE-test", PkgName: "test" }],
            },
          ],
        },
        "x",
      ),
    /Blocked/,
  );
  assert.throws(
    () => checkDatabase({ UpdatedAt: "2000-01-01", NextUpdate: "2000-01-02" }),
    /Stale/,
  );
});
test("scan binds source, archive, reports and SBOM and expires", async (t) => {
  const f = await releaseFixture(t);
  await verifyScanEvidence(f.root, f.candidate, f.release.security);
  await assert.rejects(
    verifyScanEvidence(f.root, f.candidate, f.release.security, {
      fresh: true,
      now: Date.now() + 8 * 86400000,
    }),
    /Expired/,
  );
  const scan = JSON.parse(await readFile(f.securityFile, "utf8"));
  await writeFile(path.join(f.root, scan.images.web.sbom.path), "tampered");
  await assert.rejects(
    verifyScanEvidence(f.root, f.candidate, f.release.security),
    /content mismatch/,
  );
});
test("scanner execution error creates no passing evidence", async (t) => {
  const f = await releaseFixture(t);
  const output = path.join(f.root, "artifacts/scanner-failure");
  await assert.rejects(
    scanCandidate(f.root, f.candidate, output, () => {
      throw new Error("scanner unavailable");
    }),
    /scanner unavailable/,
  );
  await assert.rejects(readFile(path.join(output, "security.json")), { code: "ENOENT" });
});
test("signature rejection stops verification and trust is the configured repo workflow", async (t) => {
  const f = await releaseFixture(t);
  const calls = [];
  await assert.rejects(
    verifyReleaseSecurity(f.root, f.release, "example/pstack", {
      binary: "fixture-cosign",
      run: (program, args) => {
        calls.push({ program, args });
        throw new Error("signature rejected");
      },
    }),
    /signature rejected/,
  );
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].args.includes(
      "https://github.com/example/pstack/.github/workflows/release.yml@refs/heads/main",
    ),
  );
  assert.throws(() => trustArguments("bad repo"));
});
test("attestation must bind exact digest and predicate while allowing JSON key order", () => {
  const reference = `ghcr.io/example/pstack-web@sha256:${"a".repeat(64)}`;
  const envelope = (predicate, digest = "a".repeat(64)) =>
    Buffer.from(
      JSON.stringify({
        payload: Buffer.from(
          JSON.stringify({
            predicateType: "https://cyclonedx.org/bom",
            subject: [{ digest: { sha256: digest } }],
            predicate,
          }),
        ).toString("base64"),
      }),
    );
  checkAttestation(
    envelope({ b: 2, a: 1 }),
    { a: 1, b: 2 },
    reference,
    "https://cyclonedx.org/bom",
  );
  assert.throws(() =>
    checkAttestation(envelope({ a: 2 }), { a: 1 }, reference, "https://cyclonedx.org/bom"),
  );
  assert.throws(() =>
    checkAttestation(
      envelope({ a: 1 }, "b".repeat(64)),
      { a: 1 },
      reference,
      "https://cyclonedx.org/bom",
    ),
  );
});

test("historical scan remains readable and an expired signed release requests a fresh archive scan", async (t) => {
  const f = await releaseFixture(t);
  const evidence = JSON.parse(await readFile(f.securityFile, "utf8"));
  const scannedAt = new Date(Date.now() - 8 * 86400000).toISOString();
  evidence.scannedAt = scannedAt;
  await f.put(evidence.database.path, {
    UpdatedAt: scannedAt,
    NextUpdate: new Date(Date.parse(scannedAt) + 86400000).toISOString(),
  });
  evidence.database = await f.ref(evidence.database.path);
  await f.put(f.release.security.path, evidence);
  f.release.security = await f.ref(f.release.security.path);
  await f.put("artifacts/release.json", f.release);
  await verifyScanEvidence(f.root, f.candidate, f.release.security);
  const calls = [];
  await assert.rejects(
    verifyReleaseSecurity(f.root, f.release, "example/pstack", {
      binary: "fixture-cosign",
      run: (program, args) => {
        calls.push({ program, args });
        if (program === "docker") throw new Error("fresh archive scanner requested");
        if (args[0] !== "verify-attestation") return Buffer.from("verified");
        const role = args.at(-1).includes("-web@") ? "web" : "worker";
        const type = args[args.indexOf("--type") + 1];
        const predicate =
          type === "cyclonedx"
            ? { bomFormat: "CycloneDX", components: [{ name: "fixture" }] }
            : provenance(f.candidate, f.release.security, role);
        return Buffer.from(
          JSON.stringify({
            payload: Buffer.from(
              JSON.stringify({
                predicateType:
                  type === "cyclonedx"
                    ? "https://cyclonedx.org/bom"
                    : "https://slsa.dev/provenance/v1",
                subject: [
                  { digest: { sha256: f.release.images[role].reference.split("@sha256:")[1] } },
                ],
                predicate,
              }),
            ).toString("base64"),
          }),
        );
      },
    }),
    /fresh archive scanner requested/,
  );
  assert.equal(calls.filter((call) => call.program === "fixture-cosign").length, 7);
});
