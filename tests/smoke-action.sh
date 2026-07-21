#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_directory="$(mktemp -d)"
cleanup() {
  if command -v gomi >/dev/null 2>&1; then
    gomi "$temporary_directory"
  else
    printf 'Smoke-test files left at %s (install gomi to enable cleanup).\n' \
      "$temporary_directory" >&2
  fi
}
trap cleanup EXIT

fixture="$temporary_directory/action"
workspace="$temporary_directory/workspace"
runner="$temporary_directory/runner"
mkdir -p "$fixture/scripts" "$workspace" "$runner"
cp "$repository_root/action.yml" "$fixture/action.yml"
cp "$repository_root/scripts/run.sh" "$fixture/scripts/run.sh"
chmod +x "$fixture/scripts/run.sh"

fake_pi="$temporary_directory/fake-pi"
cat > "$fake_pi" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\0' "$@" > "$PI_AGENT_TEST_ARGS"
cat > "$PI_AGENT_TEST_STDIN"
printf 'isolated action smoke test passed\n'
SCRIPT
chmod +x "$fake_pi"

output_file="$temporary_directory/output"
arguments_file="$temporary_directory/arguments"
stdin_file="$temporary_directory/stdin"
GITHUB_ACTION_PATH="$fixture" \
GITHUB_WORKSPACE="$workspace" \
RUNNER_TEMP="$runner" \
GITHUB_OUTPUT="$output_file" \
GITHUB_RUN_ID=456 \
GITHUB_RUN_ATTEMPT=1 \
PI_AGENT_TEST_BIN="$fake_pi" \
PI_AGENT_TEST_ARGS="$arguments_file" \
PI_AGENT_TEST_STDIN="$stdin_file" \
PI_AGENT_INPUT_PROMPT='Run from an isolated action fixture.' \
PI_AGENT_INPUT_PROJECT_TRUST=false \
PI_AGENT_INPUT_VERSION=0.80.10 \
PI_AGENT_INPUT_WORKING_DIRECTORY=. \
  "$fixture/scripts/run.sh" >/dev/null

grep -q '^response-path=' "$output_file"
grep -q '^isolated action smoke test passed$' "$output_file"
mapfile -d '' -t arguments < "$arguments_file"
[[ " ${arguments[*]} " != *' Run from an isolated action fixture. '* ]]
[[ "$(< "$stdin_file")" == 'Run from an isolated action fixture.' ]]

printf 'Isolated action smoke test passed.\n'
