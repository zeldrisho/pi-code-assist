#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_directory="$(mktemp -d)"
cleanup() {
  if [[ "${CI:-}" == "true" ]]; then
    rm -rf -- "$temporary_directory"
  elif command -v gomi >/dev/null 2>&1; then
    gomi "$temporary_directory"
  else
    printf 'Test files left at %s (install gomi to enable cleanup).\n' "$temporary_directory" >&2
  fi
}
trap cleanup EXIT

fail() {
  printf 'Test failure: %s\n' "$*" >&2
  exit 1
}

mkdir -p \
  "$temporary_directory/workspace/project" \
  "$temporary_directory/workspace/pi-package" \
  "$temporary_directory/outside" \
  "$temporary_directory/runner"
ln -s "$temporary_directory/outside" "$temporary_directory/workspace/project/outside-link"

fake_pi="$temporary_directory/fake-pi"
cat > "$fake_pi" <<'SCRIPT'
#!/usr/bin/env bash
printf '%s\0' "$@" > "$PI_AGENT_TEST_ARGS"
cat > "$PI_AGENT_TEST_STDIN"
case "${PI_AGENT_TEST_MODE:-success}" in
  success) printf 'review complete\nsecond line\n' ;;
  fail) printf 'partial response\n'; exit 23 ;;
  sized) head -c "${PI_AGENT_TEST_SIZE:?}" /dev/zero | tr '\0' x ;;
  unicode) python3 -c 'print("😀" * 100000, end="")' ;;
  *) exit 99 ;;
esac
SCRIPT
chmod +x "$fake_pi"

output_file="$temporary_directory/output"
arguments_file="$temporary_directory/arguments"
stdin_file="$temporary_directory/stdin"
prompt=$'-Review this; echo NOT_EXECUTED\nthen summarize'

run_pi() {
  : > "$output_file"
  env \
    GITHUB_ACTION_PATH="$repository_root" \
    GITHUB_REPOSITORY=example/repository \
    GITHUB_WORKSPACE="$temporary_directory/workspace" \
    RUNNER_TEMP="$temporary_directory/runner" \
    GITHUB_OUTPUT="$output_file" \
    GITHUB_RUN_ID=123 \
    GITHUB_RUN_ATTEMPT=1 \
    PI_AGENT_TEST_BIN="$fake_pi" \
    PI_AGENT_TEST_ARGS="$arguments_file" \
    PI_AGENT_TEST_STDIN="$stdin_file" \
    PI_AGENT_INPUT_PROMPT="$prompt" \
    PI_AGENT_INPUT_API_KEY= \
    PI_AGENT_INPUT_PROVIDER=opencode \
    PI_AGENT_INPUT_MODEL=test-model \
    PI_AGENT_INPUT_THINKING=medium \
    PI_AGENT_INPUT_TOOLS=read,grep \
    PI_AGENT_INPUT_PROJECT_TRUST=false \
    PI_AGENT_INPUT_PACKAGES= \
    PI_AGENT_GITHUB_TOKEN= \
    PI_AGENT_INPUT_GITHUB_TOOLS=none \
    PI_AGENT_INPUT_VERSION=0.80.10 \
    PI_AGENT_INPUT_WORKING_DIRECTORY=project \
    "$@" \
    "$repository_root/scripts/run.sh"
}

load_arguments() {
  mapfile -d '' -t arguments < "$arguments_file"
}

has_argument() {
  local expected="$1" argument
  for argument in "${arguments[@]}"; do
    [[ "$argument" == "$expected" ]] && return 0
  done
  return 1
}

argument_contains() {
  local expected="$1" argument
  for argument in "${arguments[@]}"; do
    [[ "$argument" == *"$expected"* ]] && return 0
  done
  return 1
}

run_pi >/dev/null
load_arguments
has_argument --print || fail '--print was not passed'
has_argument --no-session || fail '--no-session was not passed'
has_argument --no-approve || fail '--no-approve was not passed'
has_argument read,grep || fail 'tool allowlist was not passed'
! has_argument "$prompt" || fail 'prompt was passed as a command-line argument'
[[ "$(< "$stdin_file")" == "$prompt" ]] || fail 'prompt was not preserved through standard input'
grep -q '^response-path=' "$output_file" || fail 'response-path output is missing'
grep -q '^response<<' "$output_file" || fail 'multiline response output is missing'
grep -q '^review complete$' "$output_file" || fail 'response content is missing'

run_pi PI_AGENT_INPUT_THINKING= >/dev/null
load_arguments
! has_argument --thinking || fail 'omitted thinking level unexpectedly overrode Pi defaults'

for thinking in off minimal low medium high xhigh max; do
  run_pi PI_AGENT_INPUT_THINKING="$thinking" >/dev/null
  load_arguments
  has_argument "$thinking" || fail "thinking level was not passed: $thinking"
done

if run_pi PI_AGENT_INPUT_THINKING=extreme >/dev/null 2>&1; then
  fail 'unsupported thinking level was accepted'
fi
if run_pi PI_AGENT_INPUT_PROJECT_TRUST=maybe >/dev/null 2>&1; then
  fail 'invalid project-trust value was accepted'
fi
if run_pi PI_AGENT_INPUT_VERSION=latest >/dev/null 2>&1; then
  fail 'non-exact version was accepted'
fi
if run_pi PI_AGENT_INPUT_GITHUB_TOOLS=admin >/dev/null 2>&1; then
  fail 'invalid GitHub tool mode was accepted'
fi
if run_pi PI_AGENT_INPUT_GITHUB_TOOLS=read >/dev/null 2>&1; then
  fail 'GitHub tools were enabled without a token'
fi
if run_pi \
  GITHUB_REPOSITORY=invalid \
  PI_AGENT_INPUT_GITHUB_TOOLS=read \
  PI_AGENT_GITHUB_TOKEN=github-secret >/dev/null 2>&1; then
  fail 'GitHub tools accepted an invalid repository'
fi

run_pi PI_AGENT_INPUT_PROJECT_TRUST=true >/dev/null
load_arguments
has_argument --approve || fail 'trusted project did not pass --approve'
! has_argument --no-approve || fail 'trusted project also passed --no-approve'

run_pi PI_AGENT_INPUT_TOOLS=all >/dev/null
load_arguments
! has_argument --tools || fail 'tools=all unexpectedly passed --tools'

packages=$'npm:example-pi-package@1.2.3\ngit:github.com/example/pi-package@0123456789abcdef0123456789abcdef01234567\n./pi-package'
run_pi PI_AGENT_INPUT_PACKAGES="$packages" >/dev/null
load_arguments
has_argument npm:example-pi-package@1.2.3 || fail 'npm Pi package was not passed'
has_argument git:github.com/example/pi-package@0123456789abcdef0123456789abcdef01234567 || \
  fail 'git Pi package was not passed'
has_argument "$temporary_directory/workspace/pi-package" || fail 'workspace Pi package was not resolved'
if run_pi PI_AGENT_INPUT_PACKAGES=npm:example-pi-package@latest >/dev/null 2>&1; then
  fail 'floating npm Pi package was accepted'
fi
if run_pi PI_AGENT_INPUT_PACKAGES=npm:@invalid-scope@1.2.3 >/dev/null 2>&1; then
  fail 'malformed scoped npm Pi package was accepted'
fi
if run_pi PI_AGENT_INPUT_PACKAGES=git:github.com/example/pi-package@main >/dev/null 2>&1; then
  fail 'floating git Pi package was accepted'
fi
if run_pi PI_AGENT_INPUT_PACKAGES=./project/outside-link >/dev/null 2>&1; then
  fail 'Pi package symlink escape was accepted'
fi

run_pi \
  PI_AGENT_INPUT_GITHUB_TOOLS=read \
  PI_AGENT_GITHUB_TOKEN=github-secret >/dev/null
load_arguments
has_argument "$repository_root/extensions/github-tools.ts" || fail 'GitHub extension was not loaded'
has_argument 'read,grep,get_issue_or_pr_thread,get_pr_diff,get_ci_status,get_workflow_run_logs' || \
  fail 'read-only GitHub tools were not enabled'

run_pi \
  PI_AGENT_INPUT_GITHUB_TOOLS=write \
  PI_AGENT_GITHUB_TOKEN=github-secret >/dev/null
load_arguments
argument_contains create_pull_request || fail 'write GitHub tools were not enabled'

mask_output="$temporary_directory/mask-output"
run_pi \
  PI_AGENT_INPUT_API_KEY=test-secret \
  PI_AGENT_INPUT_GITHUB_TOOLS=read \
  PI_AGENT_GITHUB_TOKEN=github-secret > "$mask_output"
grep -Fxq '::add-mask::test-secret' "$mask_output" || fail 'API key was not masked'
grep -Fxq '::add-mask::github-secret' "$mask_output" || fail 'GitHub token was not masked'
load_arguments
has_argument test-secret || fail 'API key was not passed to Pi'

failure_output="$temporary_directory/failure-output"
if run_pi PI_AGENT_TEST_MODE=fail > /dev/null 2> "$failure_output"; then
  fail 'Pi failure was not propagated'
fi
grep -q 'Pi exited with status 23' "$failure_output" || fail 'Pi exit status was not reported'
grep -q '^response-path=' "$output_file" || fail 'failed Pi run did not expose response-path'

for size in 399999 400000; do
  run_pi PI_AGENT_TEST_MODE=sized PI_AGENT_TEST_SIZE="$size" >/dev/null || \
    fail "response at or below the documented boundary was rejected: $size"
done
run_pi PI_AGENT_TEST_MODE=unicode >/dev/null || fail '400,000-byte multibyte Unicode response was rejected'
if run_pi PI_AGENT_TEST_MODE=sized PI_AGENT_TEST_SIZE=400001 >/dev/null 2> "$temporary_directory/oversized-error"; then
  fail 'response above the documented boundary was accepted'
fi
grep -q 'response exceeds the 400000-byte GitHub Actions response limit; use response-path instead' \
  "$temporary_directory/oversized-error" || fail 'oversized response error was not reported'
grep -q '^response-path=' "$output_file" || fail 'oversized response did not expose response-path'

if run_pi PI_AGENT_INPUT_WORKING_DIRECTORY=.. >/dev/null 2>&1; then
  fail 'parent working directory was accepted'
fi
if run_pi PI_AGENT_INPUT_WORKING_DIRECTORY=project/outside-link >/dev/null 2>&1; then
  fail 'symlink escape from workspace was accepted'
fi
if run_pi PI_AGENT_INPUT_WORKING_DIRECTORY=missing >/dev/null 2>&1; then
  fail 'missing working directory was accepted'
fi
if run_pi PI_AGENT_INPUT_WORKING_DIRECTORY=/tmp >/dev/null 2>&1; then
  fail 'absolute working directory was accepted'
fi

printf 'All behavior tests passed.\n'
