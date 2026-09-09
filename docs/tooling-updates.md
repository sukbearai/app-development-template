# Check upstream tooling sources

`tools/upstream-sources.json` records the upstream material used by vendored anti-slop and the adapted Hallmark skill. Each source record owns its pinned revision, upstream paths, local paths, attribution file, adaptation notes, and the tool's validation commands. Multiple Hallmark references can use different revisions. Each attribution file identifies one source revision; updating the metadata never rewrites that text.

Run the local check without network access:

```sh
pnpm tooling:upstream:check
```

The check validates repository identifiers, required local paths, reference coverage, and revision attribution. It does not verify vendored file bytes against GitHub. The deterministic tests run with `pnpm test:tools`.

Query GitHub explicitly to compare the pinned revisions with each repository's current default branch:

```sh
pnpm tooling:upstream:check --remote
pnpm tooling:upstream:check --remote --json
```

`GITHUB_TOKEN` or `GH_TOKEN` can supply optional GitHub authentication. The command does not print tokens or response bodies. Each request has a ten-second timeout. Remote checks are optional and do not run in required CI gates or pre-commit hooks.

| Status             | Meaning                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------- |
| `validated`        | Local metadata passed. No upstream query ran.                                             |
| `current`          | The pinned revision and upstream default branch head are identical.                       |
| `update-available` | The upstream head has commits after the pinned revision.                                  |
| `ahead`            | The pinned revision has commits after the upstream head.                                  |
| `diverged`         | Both histories have commits absent from the other.                                        |
| `unavailable`      | The API request, branch lookup, pinned-base lookup, or comparison could not be validated. |

The comparison uses the pinned revision as the base and the upstream head as the head. Results describe repository history. They do not determine whether listed source paths changed. GitHub's changed-file limits therefore cannot turn an incomplete file listing into a claim that the copied sources are unchanged. Use the compare link and recorded paths when reviewing relevance.

Valid comparisons exit successfully, including available updates and diverged histories. Invalid local metadata or any unavailable remote result exits with code 1. JSON output includes the status, source revision, paths, mode, adaptation, validation commands, and remote comparison details when available.

The command reads files and makes GitHub GET requests. It never fetches Git objects, changes files, installs packages, applies upstream changes, or sends notifications. It does not execute the recorded validation commands.

For an accepted anti-slop update, review the upstream diff, replace the complete source and license together, and update its README revision and matching source record. Run the recorded validation commands. For Hallmark, review each affected adaptation, update that reference's attribution and source record, and retain the older revisions of untouched references. Adding a reference requires its own record. Preserve the upstream license and project-specific behavior. npm package updates remain under Renovate's existing configuration.
