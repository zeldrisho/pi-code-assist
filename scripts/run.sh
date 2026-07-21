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

thinking="${PI_AGENT_INPUT_THINKING:-}"
case "$thinking" in
  ''|off|minimal|low|medium|high|xhigh|max) ;;
  *) fail "unsupported thinking level: $thinking" ;;
esac

project_trust="${PI_AGENT_INPUT_PROJECT_TRUST:-false}"
case "$project_trust" in
  true|false) ;;
  *) fail 'project-trust must be true or false' ;;
esac

github_tools="${PI_AGENT_INPUT_GITHUB_TOOLS:-none}"
case "$github_tools" in
  none) ;;
  read|write)
    [[ -n "${PI_AGENT_GITHUB_TOKEN:-}" ]] || \
      fail 'GitHub Actions token is unavailable while github-tools is enabled'
    [[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || \
      fail 'GITHUB_REPOSITORY must identify an owner/repository'
    [[ -n "${GITHUB_ACTION_PATH:-}" ]] || fail 'GITHUB_ACTION_PATH is not set'
    [[ -f "$GITHUB_ACTION_PATH/extensions/github-tools.ts" ]] || \
      fail 'bundled GitHub extension is missing'
    ;;
  *) fail 'github-tools must be none, read, or write' ;;
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

package_sources=()
while IFS= read -r source || [[ -n "$source" ]]; do
  source="${source%$'\r'}"
  [[ -n "$source" ]] || continue
  if [[ "$source" =~ ^npm:((@[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)|([A-Za-z0-9_.-]+))@[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
    package_sources+=("$source")
  elif [[ "$source" =~ ^git:.+@[0-9a-fA-F]{40}$ ]] && [[ ! "$source" =~ [[:space:]] ]]; then
    package_sources+=("$source")
  elif [[ "$source" == ./* ]]; then
    package_path="$(realpath -e "$workspace/$source")" || fail "package path does not exist: $source"
    case "$package_path/" in
      "$workspace/"*) package_sources+=("$package_path") ;;
      *) fail "package path must stay within GITHUB_WORKSPACE: $source" ;;
    esac
  else
    fail "package must be an exact-pinned npm/git source or a workspace-relative path: $source"
  fi
done <<< "${PI_AGENT_INPUT_PACKAGES:-}"

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
if [[ -n "${PI_AGENT_GITHUB_TOKEN:-}" ]]; then
  printf '::add-mask::%s\n' "$PI_AGENT_GITHUB_TOKEN"
fi

args=(--print --no-session)
[[ -n "$thinking" ]] && args+=(--thinking "$thinking")
[[ "$project_trust" == true ]] && args+=(--approve) || args+=(--no-approve)
[[ -n "${PI_AGENT_INPUT_PROVIDER:-}" ]] && args+=(--provider "$PI_AGENT_INPUT_PROVIDER")
[[ -n "${PI_AGENT_INPUT_MODEL:-}" ]] && args+=(--model "$PI_AGENT_INPUT_MODEL")
[[ -n "${PI_AGENT_INPUT_API_KEY:-}" ]] && args+=(--api-key "$PI_AGENT_INPUT_API_KEY")
for source in "${package_sources[@]}"; do
  args+=(--extension "$source")
done

selected_tools="${PI_AGENT_INPUT_TOOLS:-}"
if [[ "$github_tools" != none ]]; then
  args+=(--extension "$GITHUB_ACTION_PATH/extensions/github-tools.ts")
  github_tool_names='get_issue_or_pr_thread,get_pr_diff,get_ci_status,get_workflow_run_logs'
  if [[ "$github_tools" == write ]]; then
    github_tool_names+=',post_comment,create_pull_request_review,create_pull_request,update_pull_request'
  fi
  if [[ -n "$selected_tools" && "$selected_tools" != all ]]; then
    selected_tools+=",$github_tool_names"
  fi
fi
if [[ -n "$selected_tools" && "$selected_tools" != all ]]; then
  args+=(--tools "$selected_tools")
fi
# GitHub measures job outputs approximately as UTF-16 and caps them at 1 MB.
# A 400,000-byte UTF-8 payload is at most 800,000 UTF-16 bytes, leaving room
# for the output key, delimiter, newline, and other job outputs.
response_output_max_bytes=400000
response_file="$(mktemp "$RUNNER_TEMP/pi-agent-response-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-1}-XXXXXX.txt")"
export PI_SKIP_VERSION_CHECK=1
export PI_TELEMETRY=0
export PI_AGENT_GITHUB_TOOLS="$github_tools"
if [[ "$github_tools" != none ]]; then
  export GH_TOKEN="$PI_AGENT_GITHUB_TOKEN"
  unset PI_AGENT_GITHUB_TOKEN
fi

set +e
(
  cd "$working_directory"
  printf '%s' "$PI_AGENT_INPUT_PROMPT" | "$pi_bin" "${args[@]}"
  exit "${PIPESTATUS[1]}"
) | tee "$response_file"
status=${PIPESTATUS[0]}
set -e

printf 'response-path=%s\n' "$response_file" >> "$GITHUB_OUTPUT"
if (( $(wc -c < "$response_file") > response_output_max_bytes )); then
  fail "response exceeds the ${response_output_max_bytes}-byte GitHub Actions response limit; use response-path instead"
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
