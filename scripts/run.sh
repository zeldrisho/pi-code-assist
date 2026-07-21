#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'Pi Agent: %s\n' "$*" >&2
  exit 1
}

[[ -n "${GITHUB_WORKSPACE:-}" ]] || fail 'GITHUB_WORKSPACE is not set'
[[ -n "${RUNNER_TEMP:-}" ]] || fail 'RUNNER_TEMP is not set'
[[ -n "${GITHUB_OUTPUT:-}" ]] || fail 'GITHUB_OUTPUT is not set'
[[ -n "${PI_AGENT_INPUT_PROMPT:-}" ]] || fail 'prompt is required'

version="${PI_AGENT_INPUT_VERSION:-0.80.10}"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]] || \
  fail 'pi-version must be an exact semantic version'

thinking="${PI_AGENT_INPUT_THINKING:-medium}"
case "$thinking" in
  off|minimal|low|medium|high|xhigh|max) ;;
  *) fail "unsupported thinking level: $thinking" ;;
esac

project_trust="${PI_AGENT_INPUT_PROJECT_TRUST:-false}"
case "$project_trust" in
  true|false) ;;
  *) fail 'project-trust must be true or false' ;;
esac

workspace="$(realpath "$GITHUB_WORKSPACE")"
requested_directory="${PI_AGENT_INPUT_WORKING_DIRECTORY:-.}"
[[ "$requested_directory" != /* ]] || fail 'working-directory must be relative to GITHUB_WORKSPACE'
working_directory="$(realpath -e "$workspace/$requested_directory")" || \
  fail "working-directory does not exist: $requested_directory"
case "$working_directory/" in
  "$workspace/"*) ;;
  *) fail 'working-directory must stay within GITHUB_WORKSPACE' ;;
esac
[[ -d "$working_directory" ]] || fail 'working-directory must be a directory'

if [[ -n "${PI_AGENT_TEST_BIN:-}" ]]; then
  pi_bin="$PI_AGENT_TEST_BIN"
else
  install_root="$RUNNER_TEMP/pi-agent-$version"
  pi_bin="$install_root/node_modules/.bin/pi"
  if [[ ! -x "$pi_bin" ]]; then
    printf 'Installing Pi %s...\n' "$version"
    npm install \
      --prefix "$install_root" \
      --no-audit \
      --no-fund \
      --ignore-scripts \
      "@earendil-works/pi-coding-agent@$version"
  fi
fi
[[ -x "$pi_bin" ]] || fail "Pi executable not found: $pi_bin"

if [[ -n "${PI_AGENT_INPUT_API_KEY:-}" ]]; then
  printf '::add-mask::%s\n' "$PI_AGENT_INPUT_API_KEY"
fi

args=(--print --no-session --thinking "$thinking")
[[ "$project_trust" == true ]] && args+=(--approve) || args+=(--no-approve)
[[ -n "${PI_AGENT_INPUT_PROVIDER:-}" ]] && args+=(--provider "$PI_AGENT_INPUT_PROVIDER")
[[ -n "${PI_AGENT_INPUT_MODEL:-}" ]] && args+=(--model "$PI_AGENT_INPUT_MODEL")
[[ -n "${PI_AGENT_INPUT_API_KEY:-}" ]] && args+=(--api-key "$PI_AGENT_INPUT_API_KEY")
if [[ -n "${PI_AGENT_INPUT_TOOLS:-}" && "${PI_AGENT_INPUT_TOOLS}" != all ]]; then
  args+=(--tools "$PI_AGENT_INPUT_TOOLS")
fi
response_file="$(mktemp "$RUNNER_TEMP/pi-agent-response-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-XXXXXX.txt")"
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0

set +e
(
  cd "$working_directory"
  printf '%s' "$PI_AGENT_INPUT_PROMPT" | "$pi_bin" "${args[@]}"
  exit "${PIPESTATUS[1]}"
) | tee "$response_file"
status=${PIPESTATUS[0]}
set -e

printf 'response-path=%s\n' "$response_file" >> "$GITHUB_OUTPUT"
if (( $(wc -c < "$response_file") > 900000 )); then
  fail 'response exceeds the safe GitHub Actions output size; use response-path instead'
fi

delimiter="pi_agent_output_${RANDOM}_${RANDOM}"
while grep -Fxq "$delimiter" "$response_file"; do
  delimiter="pi_agent_output_${RANDOM}_${RANDOM}"
done
{
  printf 'response<<%s\n' "$delimiter"
  cat "$response_file"
  printf '\n%s\n' "$delimiter"
} >> "$GITHUB_OUTPUT"

(( status == 0 )) || fail "Pi exited with status $status"
