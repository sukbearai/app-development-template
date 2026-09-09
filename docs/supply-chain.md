# Supply chain checks

`pnpm supply-chain:check` rejects mutable Docker frontend/base images, middleware images and GitHub Actions references. It also checks executable script image defaults. `pnpm security:audit` queries production dependency vulnerabilities and blocks HIGH and CRITICAL findings. Both checks are required by the verification plan. `scripts/toolchain-lock.json` records the reviewed image digests, action commit SHAs, scanner digest, cosign binary checksums, pnpm tarball integrity and vulnerability policy. Updating a tag without updating its digest does not update the executable artifact.

Test and backup image overrides must include a SHA-256 digest; enterprise registry mirrors can supply their own immutable reference.

The Dockerfile verifies the downloaded pnpm tarball against the lock's SHA-512 before installation. Docker base image overrides are removed. Release Compose replaces application image references with the verified digest and disables builds. Deployments must check the rendered Compose configuration because another Compose file can override source defaults.

## Scan the tested archives

```sh
pnpm release:scan --candidate artifacts/release-candidate/candidate.json --output artifacts/release
```

The pinned Trivy container scans each candidate's saved Docker archive. The scanner's image config digest must equal the tested candidate. A scan writes CycloneDX SBOMs, JSON vulnerability reports, pnpm audit output, vulnerability database metadata and the database file hash. `security.json` binds those files to the candidate source and archive hashes. HIGH and CRITICAL findings block publication, including findings without a fixed version. Scanner failures, empty or malformed reports, missing evidence and database download errors also fail. No exception or skip switch is implemented.

Database metadata must be at most 48 hours old when scanning. Current scan evidence expires after seven days. Historical manifests retain their original signed evidence. After signature verification, deployment rescans the exact saved candidate archives when their scan has expired or the local scanner/policy has changed. Fresh reports go under `artifacts/security-rescan/`; the signed release and bundle are never overwritten. A current vulnerability or scanner failure prevents deployment and rollback. Publication retries preserve original bytes and reject expired evidence; start a new candidate for an expired unpublished draft.

`release:publish --apply` requires a passing scan before uploading images. It signs exact registry digests, attests each image's SBOM and SLSA provenance, signs the final manifest bytes, and verifies every signature and attestation before uploading release assets or promoting the draft. The expected signer is exactly:

```text
issuer: https://token.actions.githubusercontent.com
identity: https://github.com/OWNER/REPO/.github/workflows/release.yml@refs/heads/main
```

The repository comes from deployment configuration, not the release manifest. The GitHub publish job has `id-token: write`. A local key is used only by the disposable `node scripts/test-security-tools.mjs` tool test; the production CLI has no local key or unsigned mode.

`delivery-evidence.tar.gz` contains the manifest, `release.json.sigstore.json`, security evidence, SBOMs, vulnerability reports, provenance and original tested archives. Preserve its directory structure when extracting. Retrying partial publication reuses the original scan and manifest bundle, so asset bytes remain identical. A signature or attestation failure retains the draft. A registry's refusal to store signatures is a publication failure.

## Release configuration

Set repository variable `RELEASE_APP_ID` and secret `RELEASE_APP_PRIVATE_KEY` for the GitHub App used by release-please. Install the App on the repository with contents, issues and pull request write permission. Missing configuration fails with an actionable message before version automation. It is a repository readiness issue; changing source code cannot create valid App credentials. Explicit recovery uses the original draft and workflow artifact and does not need to recreate the release PR.

The local tests cover scan policy rejection, modified SBOMs, stale evidence, signing rejection before promotion and retry archive identity. `node scripts/test-security-tools.mjs` downloads the checksum-pinned cosign binary and proves valid signing, wrong-key rejection and byte-tampering rejection with disposable keys. GitHub OIDC issuance, registry signature storage and actual release promotion require the configured workflow and are separate from local tool verification.

For a compatible update, supply both `--previous path/to/previous/release.json` and `--rollback-proof path/to/proof.json` to `release:publish`. The publisher verifies the predecessor signatures and current security state, validates the proof against both candidates, and includes the proof and its raw drill evidence in the delivery archive. Without both inputs, the new release advertises no automatic rollback compatibility.

## Predecessor and publication retry

The release workflow selects the highest strictly lower published application version before producing rollback evidence. Drafts and the current candidate are excluded. It downloads the predecessor's `release.json` and `delivery-evidence.tar.gz`, checks both GitHub asset hashes and sizes, validates archive members before extraction, and verifies the published tag, source and signatures. Python 3 is required for archive validation. Archives cannot contain absolute paths, parent traversal, control characters, links, duplicate entries or special files.

Each predecessor has an independent extraction root at `artifacts/predecessor`. Its original relative paths remain unchanged. `artifacts/predecessor.json` records the current candidate identity and the original predecessor selection. This separation allows successive releases to use the same `artifacts/release/*` paths without replacing current candidate evidence.

On a fresh release, the workflow runs `release-rollback-proof.mjs` against that predecessor and the tested candidate, then passes `--previous-root`, `--previous` and `--rollback-proof` to the publisher. A first release records an explicit null predecessor. If a published predecessor exists, publication requires its matching proof.

An explicit workflow retry restores the original selection, downloaded assets and rollback proof from the original run artifact. It verifies these files again and refuses missing selection/proof, changed asset bytes or a different published predecessor. It does not redownload the predecessor or regenerate the rollback proof. A retry after a newer predecessor was published requires a new candidate verification run.
