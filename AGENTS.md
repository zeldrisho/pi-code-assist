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

- Before starting work, fetch and prune remote refs and reconcile local and remote state.
- Rebase work branches onto `origin/main`; never merge `main` into them.
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
