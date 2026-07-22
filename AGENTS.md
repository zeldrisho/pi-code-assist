# Agent Instructions

## Toolchain

- Use Vite+ for runtime, package management, checks, tests, tasks, and builds.
- Write runtime and test code in TypeScript; do not add Node/npm commands or `.sh`, `.js`, or `.cjs` files.

## Commands

| Task                         | Command                           |
| ---------------------------- | --------------------------------- |
| Install dependencies         | `vp install`                      |
| Format, lint, and type-check | `vp check`                        |
| Run tests                    | `vp test`                         |
| Run one test file            | `vp test tests/<name>.test.ts`    |
| Build                        | `vp build`                        |
| Complete validation          | `vp check && vp test && vp build` |

## Sources of Truth

| Need                        | Source                              |
| --------------------------- | ----------------------------------- |
| User-facing action contract | `README.md` and `action.yml`        |
| Runtime behavior            | `scripts/run.ts`                    |
| Toolchain configuration     | `vite.config.ts` and `package.json` |
| Development guide           | `docs/development.md`               |
| Security invariants         | `docs/security.md`                  |
| Release process             | `docs/releases.md`                  |
| Release configuration       | `.github/workflows/release.yml`     |

## Git Workflow

- Before starting work, run `git fetch --prune origin` and reconcile local and remote state.
- Keep local `main` aligned with `origin/main`; create a work branch before making commits.
- Keep only one local work branch in addition to `main`; reuse it or ask before replacing it.
- Rebase the active work branch onto `origin/main`; never merge `main` into it.
- Treat `git branch --no-merged` as unreliable after squash or rebase merges; verify patch equivalence with `git cherry origin/main <branch>`.
- Delete a local branch with a gone upstream only after all its patches are present on `origin/main`; preserve and rebase branches with unique commits.
- Create a pull request only when explicitly asked to push or create one.
- When explicitly asked to push, push the work branch and create a pull request.
- Never rewrite commits that are merged, tagged, or released.

## Constraints

- Keep action dependencies exact-pinned and compatible with GitHub-hosted Ubuntu runners.
- Pass action inputs as data; never evaluate or interpolate the prompt as executable code.
- Preserve the read-only and untrusted-project defaults.
- Keep external `uses:` references pinned to full 40-character commit SHAs.
- Add boundary and failure-path tests for runtime changes.
- Agents may prepare branches and pull requests, but must not merge them.
- Do not hand-edit Release Please branches or generated release artifacts to bypass checks.
- Do not create tags or GitHub releases outside Release Please.
- Release Please pull requests require owner approval for the exact version before merge.
