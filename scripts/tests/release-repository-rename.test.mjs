import assert from "node:assert/strict";
import { test } from "node:test";
import { provenance, verifyReleaseSecurity } from "../release-security.mjs";
import { releaseFixture } from "./release-fixture.mjs";

const current = "example/renamed";
const historical = "example/pstack";
const repository = { id: 123, full_name: current };

function verifier(f, responses = [repository, repository]) {
  const calls = [];
  return {
    calls,
    run(program, args) {
      calls.push({ program, args });
      if (program === "gh") {
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return Buffer.from(JSON.stringify(response));
      }
      assert.equal(program, "fixture-cosign");
      assert.equal(
        args[args.indexOf("--certificate-identity") + 1],
        `https://github.com/${historical}/.github/workflows/release.yml@refs/heads/main`,
      );
      assert.equal(
        args[args.indexOf("--certificate-oidc-issuer") + 1],
        "https://token.actions.githubusercontent.com",
      );
      if (args[0] !== "verify-attestation") return Buffer.from("verified");
      const role = args.at(-1).includes("-web@") ? "web" : "worker";
      const sbom = args[args.indexOf("--type") + 1] === "cyclonedx";
      return Buffer.from(
        JSON.stringify({
          payload: Buffer.from(
            JSON.stringify({
              predicateType: sbom ? "https://cyclonedx.org/bom" : "https://slsa.dev/provenance/v1",
              subject: [
                { digest: { sha256: f.release.images[role].reference.split("@sha256:")[1] } },
              ],
              predicate: sbom
                ? { bomFormat: "CycloneDX", components: [{ name: "fixture" }] }
                : provenance(f.candidate, f.release.security, role),
            }),
          ).toString("base64"),
        }),
      );
    },
  };
}

test("published release survives a repository rename only after GitHub identity and exact signature verification", async (t) => {
  const f = await releaseFixture(t);
  const { run, calls } = verifier(f);
  await verifyReleaseSecurity(f.root, f.release, current, {
    allowRepositoryRename: true,
    binary: "fixture-cosign",
    run,
  });
  assert.deepEqual(
    calls.filter((call) => call.program === "gh").map((call) => call.args),
    [current, historical].map((name) => ["api", "--hostname", "github.com", `repos/${name}`]),
  );
  assert.equal(calls.filter((call) => call.program === "fixture-cosign").length, 7);
});

test("current release verification stays strict and never resolves an alias by default", async (t) => {
  const f = await releaseFixture(t);
  const calls = [];
  await assert.rejects(
    verifyReleaseSecurity(f.root, f.release, current, {
      binary: "fixture-cosign",
      run(program, args) {
        calls.push({ program, args });
        assert.equal(program, "fixture-cosign");
        assert.equal(
          args[args.indexOf("--certificate-identity") + 1],
          `https://github.com/${current}/.github/workflows/release.yml@refs/heads/main`,
        );
        return Buffer.from("verified");
      },
    }),
    /Image repository differs from trusted repository/,
  );
  assert.equal(calls.length, 1);
});

test("historical images cannot establish trust without matching GitHub repository identities", async (t) => {
  const f = await releaseFixture(t);
  for (const [responses, error] of [
    [[repository, { ...repository, id: 456 }], /identity differs/],
    [[repository, { ...repository, full_name: historical }], /does not resolve/],
    [[repository, { full_name: current }], /identity is invalid/],
    [[repository, { ...repository, id: "123" }], /identity is invalid/],
    [[{ ...repository, id: 0 }], /identity is invalid/],
    [[{ ...repository, full_name: "another/repository" }], /does not resolve/],
    [[repository, new Error("repository lookup failed")], /repository lookup failed/],
  ]) {
    const { run, calls } = verifier(f, responses);
    await assert.rejects(
      verifyReleaseSecurity(f.root, f.release, current, {
        allowRepositoryRename: true,
        binary: "fixture-cosign",
        run,
      }),
      error,
    );
    assert.ok(calls.every((call) => call.program === "gh"));
  }
});

test("both historical role images must name the same exact digest-pinned GitHub namespace", async (t) => {
  const f = await releaseFixture(t);
  const original = f.release.images.worker.reference;
  for (const reference of [
    original.replace(historical, "attacker/project"),
    original.replace("-worker@", "-web@"),
    original.replace("ghcr.io", "registry.example"),
    original.replace("ghcr.io", "ghcrXio"),
    original.replace(/@sha256:.+$/, ":latest"),
    `${original}/extra`,
  ]) {
    f.release.images.worker.reference = reference;
    const calls = [];
    await assert.rejects(
      verifyReleaseSecurity(f.root, f.release, current, {
        allowRepositoryRename: true,
        binary: "fixture-cosign",
        run: (...args) => calls.push(args),
      }),
      /historical image repository|Historical image repositories differ/,
    );
    assert.equal(calls.length, 0);
  }
});

test("GitHub rename confirmation never substitutes for signature verification", async (t) => {
  const f = await releaseFixture(t);
  const verifierRun = verifier(f);
  await assert.rejects(
    verifyReleaseSecurity(f.root, f.release, current, {
      allowRepositoryRename: true,
      binary: "fixture-cosign",
      run(program, args) {
        if (program === "fixture-cosign") throw new Error("historical signature rejected");
        return verifierRun.run(program, args);
      },
    }),
    /historical signature rejected/,
  );
  assert.equal(verifierRun.calls.length, 2);
});

test("an unchanged repository needs no GitHub rename lookup", async (t) => {
  const f = await releaseFixture(t);
  const { run, calls } = verifier(f);
  await verifyReleaseSecurity(f.root, f.release, historical, {
    allowRepositoryRename: true,
    binary: "fixture-cosign",
    run,
  });
  assert.equal(calls.length, 7);
  assert.ok(calls.every((call) => call.program === "fixture-cosign"));
});
