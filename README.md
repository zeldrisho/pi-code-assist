# Pi Agent for GitHub Actions

Run the [Pi coding agent](https://pi.dev/) as a small, composable GitHub Action. The action installs an exact Pi version, runs one non-interactive prompt, streams the response to the job log, and exposes it to later steps.

The safe defaults are read-only tools and **untrusted** project-local Pi configuration. The action does not post comments, push commits, or broaden `GITHUB_TOKEN` permissions by itself.

## Quick start

```yaml
name: Pi review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    # Repository secrets are normally unavailable to pull requests from forks.
    if: github.event.pull_request.head.repo.fork == false
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          fetch-depth: 0

      - id: pi
        uses: zeldrisho/pi-agent@0123456789abcdef0123456789abcdef01234567
        env:
          OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
        with:
          provider: opencode
          model: deepseek-v4-flash-free
          prompt: |
            Review this pull request. Use git diff against the base branch.
            Report only actionable correctness, security, and test issues.

      - name: Post review
        env:
          GH_TOKEN: ${{ github.token }}
          RESPONSE_FILE: ${{ steps.pi.outputs.response-path }}
        run: gh pr comment "${{ github.event.pull_request.number }}" --body-file "$RESPONSE_FILE"
```

Replace the example revision with a reviewed full commit SHA. Pinning actions prevents an upstream tag from changing the code your workflow executes.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `prompt` | Yes | — | Instruction sent to Pi. Passed as data, not interpolated into shell code. |
| `api-key` | No | — | Provider API key. Store it in GitHub Actions secrets. |
| `provider` | No | Pi default | Pi provider name, such as `opencode`. |
| `model` | No | Pi default | Model ID or pattern accepted by Pi. |
| `thinking` | No | `medium` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. |
| `tools` | No | `read,grep,find,ls` | Comma-separated tool allowlist. Set `all` to use Pi's defaults, including write-capable tools. |
| `project-trust` | No | `false` | Set to `true` to load project `.pi` settings and executable project extensions. |
| `pi-version` | No | `0.80.10` | Exact Pi package version. Floating tags and ranges are rejected. |
| `working-directory` | No | `.` | Existing directory below `GITHUB_WORKSPACE`. |

Provider-specific environment variables such as `OPENCODE_API_KEY` also work because Pi inherits the step environment:

```yaml
- uses: zeldrisho/pi-agent@0123456789abcdef0123456789abcdef01234567
  env:
    OPENCODE_API_KEY: ${{ secrets.OPENCODE_API_KEY }}
  with:
    provider: opencode
    model: deepseek-v4-flash-free
    prompt: Summarize the repository architecture.
```

See the [DeepSeek V4 Flash Free model page](https://pi.dev/models/opencode/deepseek-v4-flash-free?name=deepseek-v4-flash-free) for its current Pi configuration.

## Outputs

| Output | Description |
| --- | --- |
| `response` | Pi's text response. Suitable for short downstream expressions. |
| `response-path` | Absolute response file path. Prefer this for comments and other multiline or potentially large results. |

GitHub limits output sizes. This action rejects responses above 900 KB; the streamed job log remains available.

## Allowing changes

Pi is read-only by default. To let it edit the checked-out repository, explicitly opt in:

```yaml
with:
  tools: all
  prompt: Fix the failing tests and explain the changes.
```

This changes only files in the runner workspace. Pushing a branch or opening a pull request requires separate workflow steps and explicit `contents: write` permission.

## Security

AI-agent workflows process untrusted repository and event content. In particular:

- do not expose secrets to workflows triggered by untrusted forks;
- avoid `pull_request_target` when checking out and executing pull-request code;
- keep `project-trust: false` unless `.pi` extensions and settings are reviewed;
- grant the job only the minimum `GITHUB_TOKEN` permissions;
- use read-only tools for review tasks;
- pin this and all third-party actions to full commit SHAs; and
- treat model output as untrusted data in later shell and API steps.

Project context files can still influence the model even when project trust is disabled. Project trust controls project-local settings and executable resources; it is not a prompt-injection defense.

Maintainers should preserve the review checklist in [`docs/security.md`](docs/security.md) when changing the runtime or workflow.

## Development

```bash
bash -n scripts/run.sh tests/*.sh
shellcheck scripts/run.sh tests/*.sh
actionlint
./tests/run.sh
./tests/smoke-action.sh
```

CI runs Actionlint 1.7.7. The action is intentionally a dependency-free composite action. Pi is installed under `RUNNER_TEMP`, with install scripts, audit, telemetry, and startup update checks disabled.

## References

- [Pi CLI usage](https://pi.dev/docs/latest/usage)
- [Pi security and project trust](https://pi.dev/docs/latest/security)
- [GitHub action metadata](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)
- [GitHub Marketplace actions](https://github.com/marketplace?type=actions)

## License

[MIT](LICENSE)
