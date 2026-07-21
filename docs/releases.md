# Release guide

Release Please maintains the version, changelog, tags, and GitHub releases for this single-action repository. Consumers should continue to pin the action to a reviewed full commit SHA.

## Release invariants

- Release Please owns `version.txt`, `.release-please-manifest.json`, and generated `CHANGELOG.md` entries.
- Do not hand-edit a Release Please branch or generated release artifacts to bypass checks.
- Only the repository owner merges pull requests.
- Confirm the exact version and source commit before merging a release pull request.
- Do not create, move, or recreate release tags manually.
- Keep workflow actions pinned to reviewed full commit SHAs.

## Configuration

This is a single-component repository using the `simple` strategy. Manifest mode set the custom initial version to `0.1.0`; `.release-please-manifest.json` now records the latest released root-component version. Release Please maintains that manifest, `version.txt`, and `CHANGELOG.md`. Releases use immutable `v<version>` tags without a component prefix.

`.github/workflows/release.yml` runs on pushes to `main`. It validates the pushed commit before granting its release job `contents: write` and `pull-requests: write`. The workflow uses the repository `GITHUB_TOKEN`; no personal token or publishing credential is required. Repository Actions settings must allow GitHub Actions to create pull requests; the workflow does not approve them.

GitHub suppresses workflow events created by `GITHUB_TOKEN`. A newly created or updated release pull request therefore needs a manual CI dispatch against its head branch before it can satisfy the protected `check` requirement:

```bash
gh workflow run CI --repo zeldrisho/pi-agent --ref <release-please-branch>
gh run list --repo zeldrisho/pi-agent --workflow CI --branch <release-please-branch> --limit 5
```

## Release procedure

1. Merge ordinary Conventional Commit pull requests through the protected rebase-only workflow.
2. Confirm the Release workflow validated `main` and proposed the expected version and changelog.
3. Do not modify the generated release branch. Manually dispatch CI for its head branch and confirm the `check` job succeeds on the release commit.
4. Review the release pull request's `CHANGELOG.md`, `version.txt`, and `.release-please-manifest.json` changes.
5. The repository owner rebase-merges the release pull request only after approving the exact version.
6. Confirm the next Release workflow created one `v<version>` tag and one GitHub release at the approved commit.
7. Verify the tag is immutable and advise consumers to use the released commit SHA rather than a floating tag.

## Escalation conditions

Stop and notify the repository owner if:

- the proposed version, changelog, source commit, tag, or release count is unexpected;
- generated release files fail validation;
- CI did not run against the release pull request's exact head commit;
- updating a branch would require merging `main` into it;
- an operation would bypass branch protection or rewrite a merged, tagged, or released commit; or
- a pull-request merge, tag, or GitHub release lacks explicit version-specific approval.
