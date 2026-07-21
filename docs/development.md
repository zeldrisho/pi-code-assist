# Development guide

Use this guide when changing the action, runtime, tests, or workflows.

## Requirements

Local validation requires Bash, ShellCheck, and Actionlint. Use GitHub CLI for repository operations and `gomi` for recoverable local file removal.

The action itself remains a dependency-free composite action. Its runtime installs the exact configured Pi version under `RUNNER_TEMP`.

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

## Dependency updates

Do not add automated dependency-update configuration or refresh pins routinely. For an applicable security advisory, select the smallest fixed version or reviewed replacement, verify its source and immutable identity, update only directly affected files, run the complete suite, and record the advisory and review evidence in the pull request.

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
