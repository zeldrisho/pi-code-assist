# Pi Code Assist

Run the [Pi coding agent](https://pi.dev/) as a small, composable GitHub Action. The action installs an exact Pi version, runs one non-interactive prompt, streams the response to the job log, and exposes it to later steps.

The safe defaults are read-only tools and **untrusted** project-local Pi configuration. The action does not post comments, push commits, or broaden `GITHUB_TOKEN` permissions by itself.

## Quick start

```yaml
name: Pi Code Assist

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    # Repository secrets are unavailable to fork and Dependabot pull requests.
    if: github.event.pull_request.head.repo.fork == false && github.actor != 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          fetch-depth: 0
          persist-credentials: false

      - id: pi
        # Known-good immutable pin; check Releases for a newer reviewed version.
        uses: zeldrisho/pi-code-assist@5155bb17f9d6d99bc2f9aef87f6b8df65c3283cc # v0.2.1
        with:
          api-key: ${{ secrets.OPENCODE_API_KEY }}
          provider: opencode
          model: deepseek-v4-flash-free
          pi-version: 0.80.10
          github-tools: read
          prompt: |
            Review this pull request using the GitHub PR diff tool and checked-out files.
            Report only actionable correctness, security, and test issues.

      - name: Post review
        env:
          GH_TOKEN: ${{ github.token }}
          RESPONSE_FILE: ${{ steps.pi.outputs.response-path }}
        run: gh pr comment "${{ github.event.pull_request.number }}" --body-file "$RESPONSE_FILE"
```

The example uses known-good immutable pins rather than automatically tracking the newest code. Before adopting it, check [Releases](https://github.com/zeldrisho/pi-code-assist/releases) for a newer version and replace the action revision with that release's full commit SHA. Immutable pins prevent upstream tags from changing the code your workflow executes.

## Inputs

| Input               | Required | Default             | Description                                                                                                                                                                     |
| ------------------- | -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt`            | Yes      | —                   | Instruction sent to Pi. Passed as data, not interpolated into shell code.                                                                                                       |
| `api-key`           | Yes      | —                   | Provider API key. Store it in GitHub Actions secrets.                                                                                                                           |
| `provider`          | Yes      | —                   | Pi provider name, such as `opencode`.                                                                                                                                           |
| `model`             | Yes      | —                   | Model ID or pattern accepted by Pi.                                                                                                                                             |
| `thinking`          | No       | Pi default          | Optional override: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. When omitted, Pi selects its configured default and adapts it to the model's supported levels. |
| `tools`             | No       | `read,grep,find,ls` | Comma-separated tool allowlist. Set `all` to use Pi's defaults, including write-capable tools.                                                                                  |
| `project-trust`     | No       | `false`             | Set to `true` to load project `.pi` settings and executable project extensions.                                                                                                 |
| `packages`          | No       | —                   | Exact-pinned npm/git Pi packages or package paths from the checked-out workspace, one per line.                                                                                 |
| `github-tools`      | No       | `none`              | `none` disables GitHub-aware tools and does not pass the job token to Pi. `read` or `write` adds GitHub-aware tools using the job's `github-actions[bot]` identity.             |
| `pi-version`        | Yes      | —                   | Exact Pi package version. Floating tags and ranges are rejected.                                                                                                                |
| `working-directory` | No       | `.`                 | Existing directory below `GITHUB_WORKSPACE`.                                                                                                                                    |

Pass the required `api-key` input from a GitHub Actions secret. Pi inherits provider-specific environment variables, but they do not replace this required action input.

Browse [Pi models](https://pi.dev/models) to choose a provider and model for your workflow.

## Outputs

| Output          | Description                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| `response`      | Pi's text response. Suitable for short downstream expressions.                                          |
| `response-path` | Absolute response file path. Prefer this for comments and other multiline or potentially large results. |

GitHub limits job outputs using an approximate UTF-16 measurement. The `response` output supports at most **400,000 UTF-8 bytes**, including multibyte text; larger responses fail with an instruction to use `response-path`. The response file and streamed job log remain available.

## Pi packages

Load custom Pi packages entirely on the GitHub runner with the `packages` input:

```yaml
with:
  packages: npm:@zeldrisho/pi-web-fetch@0.3.0
  tools: all
```

Npm packages require exact semantic versions and git packages require full 40-character commit SHAs. Multiple packages may be provided one per line. Workspace package paths must begin with `./`; they are resolved from `GITHUB_WORKSPACE`, must already exist in the checkout, and cannot escape through symlinks. Packages are loaded temporarily for this Pi invocation and can contain executable extensions; review them before use. Custom package tools must also be selected through `tools`, or use `tools: all`.

Trusted project `.pi/settings.json` files may also declare packages when `project-trust: true`. The explicit `packages` input works independently of project trust because supplying it is itself an opt-in to execute that package.

## GitHub-aware tasks

Set `github-tools` to expose event-aware GitHub tools. `read` provides issue/PR threads, PR diffs, CI status, and workflow logs. `write` additionally provides comments, pull-request reviews, and tools to create or update pull requests.

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: write

steps:
  - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
    with:
      fetch-depth: 0

  - uses: zeldrisho/pi-code-assist@0123456789abcdef0123456789abcdef01234567
    with:
      api-key: ${{ secrets.OPENCODE_API_KEY }}
      github-tools: write
      tools: all
      provider: opencode
      model: deepseek-v4-flash-free
      pi-version: 0.80.10
      prompt: Implement the requested change and create a pull request.
```

### Automate labeled issues

For a copy-paste workflow that lets a maintainer apply an `ai-fix` label and have Pi implement the issue and open a pull request, see [Issue-to-PR automation](docs/issue-to-pr.md). The guide covers permissions, repository settings, prompt-injection boundaries, retries, labeling limitations, and branch-protection expectations.

GitHub read tools paginate within fixed limits of 5 pages and 500 records and bound each result to 50 KB / 2,000 lines. Tool result details report record counts, truncation, and continuation API paths. Diffs are streamed into a bounded head collector and logs into a bounded tail collector, so arbitrarily large command output is not retained in memory; their details report the complete byte and line counts and whether output was omitted.

GitHub tools automatically use the job-scoped token and act as `github-actions[bot]`; user PATs and GitHub App tokens are not accepted. The action does not grant permissions itself, so write tools work only when the workflow explicitly grants the corresponding permissions. Creating or updating a pull request also requires checkout credentials capable of pushing to the repository; pull requests from forks are not updated. Events created by `github-actions[bot]` generally do not trigger additional workflow runs. Keep `github-tools: none` or `read` for untrusted triggers, and restrict who can invoke workflows with write access.

## Allowing changes

Pi is read-only by default. To let it edit the checked-out repository, explicitly opt in:

```yaml
with:
  tools: all
  prompt: Fix the failing tests and explain the changes.
```

This changes only files in the runner workspace. Without `github-tools: write`, pushing a branch or opening a pull request requires separate workflow steps. GitHub write tools can perform those operations only with explicit token permissions and checkout credentials capable of pushing.

The pull-request creation and update tools require an explicit non-empty list of workspace-relative file paths. Only those files are staged and committed; traversal and symlink escapes are rejected, and unrelated workspace changes remain uncommitted. Updating a pull request also requires the checkout to be on that same-repository pull request's branch.

## Security

AI-agent workflows process untrusted repository and event content. In particular:

- do not expose secrets to workflows triggered by untrusted forks;
- avoid `pull_request_target` when checking out and executing pull-request code;
- keep `project-trust: false` unless `.pi` extensions and settings are reviewed;
- grant the job only the minimum `GITHUB_TOKEN` permissions;
- use read-only tools for review tasks;
- pin this and all third-party actions to full commit SHAs;
- treat model output as untrusted data in later shell and API steps;
- treat explicitly configured Pi packages as executable code and pin npm/git sources immutably; and
- enable GitHub write tools only for authorized triggers with narrowly scoped token permissions.

Project context files can still influence the model even when project trust is disabled. Project trust controls project-local settings and executable resources; it is not a prompt-injection defense.

## References

- [Pi CLI usage](https://pi.dev/docs/latest/usage)
- [Pi security and project trust](https://pi.dev/docs/latest/security)

## License

[MIT](LICENSE)
