# Development guide

Use this guide when changing the action, runtime, tests, or workflows.

## Requirements

Local validation requires Bash, ShellCheck, and Actionlint. Use GitHub CLI for repository operations and `gomi` for recoverable local file removal.

The action itself remains a dependency-free composite action. Its runtime installs the exact configured Pi version under `RUNNER_TEMP`. Validation also type-checks the bundled extension with exactly pinned test-only TypeScript and Node type packages; those packages are never installed by the action runtime.

Keep the action narrowly scoped around one non-interactive Pi invocation. Prefer the Pi CLI process boundary, keep event-specific orchestration in workflows or opt-in extensions, and add only narrowly validated typed inputs for concrete user needs. Do not expose a generic shell-like Pi argument input.

## Repository layout

| Path | Purpose |
| --- | --- |
| `action.yml` | User-facing action metadata and composition |
| `scripts/run.sh` | Input validation, Pi installation, execution, and outputs |
| `extensions/github-tools.ts` | Optional read/write GitHub tools loaded into Pi |
| `tests/run.sh` | Runtime behavior and failure-path tests |
| `tests/smoke-action.sh` | Isolated action-file smoke test |
| `.github/workflows/ci.yml` | Required `check` job |
| `.github/workflows/release.yml` | Release Please strategy, validation, and release orchestration |
| `version.txt` | Release Please-managed current version |
| `docs/security.md` | Security invariants for runtime and workflow changes |
| `docs/releases.md` | Owner-controlled release procedure |

## Validation

Run the complete suite before pushing:

```bash
./scripts/validate.sh
```

The shared script runs shell syntax and ShellCheck, Actionlint, runtime behavior and boundary tests, the GitHub extension harness against the configured Pi version, README/action contract checks, the isolated action smoke test, and whitespace checks. CI and Release both invoke it and then exercise the composed action in a workflow step.

Runtime changes require boundary and failure-path coverage. Workflow changes must preserve read-only default permissions and pin every external action to a reviewed full commit SHA.

## Dependency reproducibility and updates

The supported direct Pi dependency is an exact version, but npm is allowed to resolve Pi's declared transitive ranges at install time. This is an explicit compatibility trade-off: npm verifies the registry-provided integrity for each downloaded package, while the repository does not claim a fully locked transitive graph. CI performs a credential-free real installation on every validation run and on a weekly schedule so package-layout, executable-discovery, version, and SDK compatibility changes fail promptly.

A `pi-version` override must also be exact. It intentionally resolves that version's own current transitive graph and is the workflow owner's compatibility choice; the bundled extension is guaranteed only against the default version validated here. To update the default, review the package provenance and resolved dependency tree, change both contract-checked version declarations, and run the complete suite. Roll back by restoring the prior exact default; callers using a custom version can similarly restore their prior exact input.

Do not add automated dependency-update configuration or refresh pins routinely. For an applicable security advisory, select the smallest fixed version or reviewed replacement, verify its source and immutable identity, update only directly affected files, run the complete suite, and record the advisory and review evidence in the pull request.

Pi 0.80.10 currently reaches deprecated `node-domexception@1.0.0` through `@google/genai`, `google-auth-library`, `gaxios`, `node-fetch`, and `fetch-blob`. No newer supported Pi release was available when this policy was recorded. The package is transitive and is not added directly; re-check the resolved tree during the next Pi update and remove this exception when upstream no longer installs it.

## Development workflow

Start from an up-to-date `main` and use a focused branch:

```bash
git fetch --prune
git switch main
git pull --ff-only
git switch -c <type>/<short-description>
```

Use lowercase Conventional Commit descriptions. Before pushing, run the complete validation suite, fetch, and rebase onto `origin/main`; never merge `main` into a work branch.

Create a pull request only when explicitly requested to push or create one. Repository owners review and merge pull requests.

## Security-sensitive changes

Treat action inputs, repository files, model responses, and project-local Pi resources as untrusted. Read [`security.md`](security.md) before modifying `action.yml`, `scripts/run.sh`, permissions, installation behavior, or output handling.
