# Security invariants

Use this checklist when reviewing changes to `action.yml`, `scripts/run.sh`, bundled extensions, or workflows.

- Treat every action input, repository file, context file, and model response as untrusted data.
- Pass `prompt` through standard input as data; never evaluate it or construct a shell command from it.
- Accept only exact Pi versions and install with lifecycle scripts, audit, funding messages, telemetry, and update checks disabled.
- Resolve `working-directory` canonically and require it to remain inside `GITHUB_WORKSPACE`, including through symlinks.
- Default to the read-only tool allowlist, no GitHub tools, and `--no-approve`; broaden any of them only through explicit inputs.
- Remember that project trust controls project-local Pi configuration and executable resources, not context files or tool sandboxing.
- Do not use prompt sanitization as a substitute for trust boundaries, minimal tools, and least-privilege workflow permissions.
- Treat Pi packages as executable code. Require immutable npm/git identities, constrain local package paths to the workspace, and load packages only when explicitly configured or through a trusted project.
- Mask supplied API keys and GitHub tokens before invoking Pi and never copy them into action outputs.
- Preserve Pi's exit status when streaming through `tee`; a partial response must not turn a failed run into success.
- Bound expression-safe output. Keep the response file available when the `response` output is too large.
- Do not grant token permissions, post comments, push commits, or execute model output implicitly. GitHub write tools must require explicit action inputs and workflow permissions.
- Keep GitHub reads paginated and bounded with explicit truncation metadata, pass API request bodies through protected temporary files rather than shell interpolation, and clean those files after success or failure.
- Require GitHub commit tools to stage explicit workspace-relative paths, reject traversal and symlink escapes, and reject cross-repository pull-request updates.
- If future features manage temporary credentials or trusted configuration, clean them up in a separate `always()` action step so process failures cannot skip cleanup.
- Keep every external action pinned to a reviewed full commit SHA.

Run all commands in `AGENTS.md` before proposing a runtime or workflow change.
