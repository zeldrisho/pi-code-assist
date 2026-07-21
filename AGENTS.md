# Agent Instructions

## Commands

| Task | Command |
| --- | --- |
| Check shell syntax | `bash -n scripts/run.sh tests/*.sh` |
| Lint shell | `shellcheck scripts/run.sh tests/*.sh` |
| Validate workflows | `actionlint` |
| Run behavior tests | `./tests/run.sh` |
| Smoke-test isolated action files | `./tests/smoke-action.sh` |

## Sources of Truth

| Need | Source |
| --- | --- |
| User-facing action contract | `README.md` and `action.yml` |
| Runtime behavior | `scripts/run.sh` |
| Security invariants | `docs/security.md` |

## Constraints

- Keep the action dependency-free and compatible with GitHub-hosted Ubuntu runners.
- Pass action inputs as data; never evaluate or interpolate the prompt as shell code.
- Preserve the read-only and untrusted-project defaults.
- Keep external `uses:` references pinned to full 40-character commit SHAs.
- Add boundary and failure-path tests for runtime changes.
- Agents may prepare branches and pull requests, but must not merge, tag, publish, or release without explicit approval.
