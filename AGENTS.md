# Agent Instructions

## Commands

| Task | Command |
| --- | --- |
| Complete validation | `./scripts/validate.sh` |
| Check shell syntax | `bash -n scripts/*.sh tests/*.sh` |
| Lint shell | `shellcheck scripts/*.sh tests/*.sh` |
| Validate workflows | `actionlint` |
| Run behavior tests | `./tests/run.sh` |
| Test GitHub extension | `./tests/github-tools.sh` |
| Check action contract | `./tests/contract.sh` |
| Smoke-test isolated action files | `./tests/smoke-action.sh` |

## Sources of Truth

| Need | Source |
| --- | --- |
| User-facing action contract | `README.md` and `action.yml` |
| Runtime behavior | `scripts/run.sh` |
| Development guide | `docs/development.md` |
| Security invariants | `docs/security.md` |
| Release process | `docs/releases.md` |
| Release configuration | `.github/workflows/release.yml` |

## Git Workflow

- Before starting work, fetch and prune remote refs and reconcile local and remote state.
- Rebase work branches onto `origin/main`; never merge `main` into them.
- Create a pull request only when explicitly asked to push or create one.
- When explicitly asked to push, push the work branch and create a pull request.
- Never rewrite commits that are merged, tagged, or released.

## Constraints

- Keep the action dependency-free and compatible with GitHub-hosted Ubuntu runners.
- Pass action inputs as data; never evaluate or interpolate the prompt as shell code.
- Preserve the read-only and untrusted-project defaults.
- Keep external `uses:` references pinned to full 40-character commit SHAs.
- Add boundary and failure-path tests for runtime changes.
- Agents may prepare branches and pull requests, but must not merge them.
- Do not hand-edit Release Please branches or generated release artifacts to bypass checks.
- Do not create tags or GitHub releases outside Release Please.
- Release Please pull requests require owner approval for the exact version before merge.
