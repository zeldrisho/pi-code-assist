# Agent Instructions

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
- Keep at most one local work branch besides `main`; if one exists, ask before creating, replacing, or deleting it.
- Rebase the active work branch onto `origin/main`; never merge `main` into it.
- Before deleting a branch with a gone upstream, use `git cherry origin/main <branch>` to account for squash or rebase merges; preserve and rebase branches with unique patches.
- Only when explicitly asked to push or create a pull request, push the work branch and create the pull request; never merge it.
- Never rewrite commits that are merged, tagged, or released.

## Constraints

- Keep action dependencies exact-pinned and compatible with GitHub-hosted Ubuntu runners.
- Pass action inputs as data; never evaluate or interpolate the prompt as executable code.
- Preserve the read-only and untrusted-project defaults.
- Keep external `uses:` references pinned to full 40-character commit SHAs.
- Add boundary and failure-path tests for runtime changes.
- Do not hand-edit Release Please branches or generated release artifacts to bypass checks.
- Do not create tags or GitHub releases outside Release Please.
- Release Please pull requests require owner approval for the exact version before merge.
