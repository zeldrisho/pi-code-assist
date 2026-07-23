# Development guide

Use this guide when changing the action, runtime, tests, or workflows.

## Requirements

Local development requires Vite+. Run `vp install` to provision the repository toolchain and dependencies. Use GitHub CLI for repository operations and `gomi` for recoverable local file removal.

The composite action uses the pinned Vite+ setup action and installs its exact-locked TypeScript runtime dependencies. For every invocation, the runtime creates a fresh installation under `RUNNER_TEMP`, installs the exact configured Pi version through Vite+ with lifecycle scripts disabled, and verifies it with `pi --version`.

Keep the action narrowly scoped around one non-interactive Pi invocation. Prefer the Pi CLI process boundary, keep event-specific orchestration in workflows or opt-in extensions, and add only narrowly validated typed inputs for concrete user needs. Do not expose a generic shell-like Pi argument input.

## Repository layout

| Path                                                          | Purpose                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------- |
| `action.yml`                                                  | User-facing action metadata and composition                    |
| `scripts/run.ts`                                              | Action lifecycle orchestration                                 |
| `scripts/{inputs,installation,process,invocation,outputs}.ts` | Runtime policy modules                                         |
| `extensions/github/`                                          | Bundled optional read/write GitHub extension                   |
| `tests/*.test.ts`                                             | Runtime, contract, extension, boundary, and failure-path tests |
| `vite.config.ts`                                              | Vite+ checks, tests, tasks, and build configuration            |
| `.github/workflows/ci.yml`                                    | Required `check` job                                           |
| `.github/workflows/release.yml`                               | Release Please strategy, validation, and release orchestration |
| `version.txt`                                                 | Release Please-managed current version                         |
| `docs/security.md`                                            | Security invariants for runtime and workflow changes           |
| `docs/releases.md`                                            | Owner-controlled release procedure                             |

## Validation

Run the complete suite before pushing:

```text
vp check
vp test
vp build
```

Vite+ formats, lints, type-checks, runs runtime and boundary tests, validates the README/action/runtime contract, tests the GitHub extension, and verifies the production build. CI and Release run the same commands and then exercise the composed action in a workflow step.

Runtime changes require boundary and failure-path coverage. Workflow changes must preserve read-only default permissions and pin every external action to a reviewed full commit SHA.

## Dependency reproducibility and updates

The supported direct Pi dependency is an exact version. The repository development graph is locked, while each required `pi-version` input intentionally resolves the selected release's declared transitive ranges. Registry integrity verification and the weekly CI compatibility run cover package-layout, executable-discovery, version, and SDK changes.

The bundled extension is tested against the version pinned in development dependencies, but callers must explicitly select their Pi version. To update the validated version, review the package provenance and resolved dependency tree, update the exact development and test pins, and run the complete suite. Callers can roll back by restoring their prior exact input.

Do not add automated dependency-update configuration or refresh pins routinely. For an applicable security advisory, select the smallest fixed version or reviewed replacement, verify its source and immutable identity, update only directly affected files, run the complete suite, and record the advisory and review evidence in the pull request.

Pi 0.80.10 currently reaches deprecated `node-domexception@1.0.0` transitively. No newer supported Pi release was available when this policy was recorded. Re-check the resolved tree during the next Pi update and remove this exception when upstream no longer installs it.

## Development workflow

Start from an up-to-date `main` and use a focused branch:

```text
git fetch --prune
git switch main
git pull --ff-only
git switch -c <type>/<short-description>
```

Use lowercase Conventional Commit descriptions. Before pushing, run the complete validation suite, fetch, and rebase onto `origin/main`; never merge `main` into a work branch.

Create a pull request only when explicitly requested to push or create one. Repository owners review and merge pull requests.

## Security-sensitive changes

Treat action inputs, repository files, model responses, and project-local Pi resources as untrusted. Read [`security.md`](security.md) before modifying `action.yml`, `scripts/run.ts`, permissions, installation behavior, or output handling.
