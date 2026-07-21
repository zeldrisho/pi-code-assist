#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(awk '/default: [0-9]+\.[0-9]+\.[0-9]+/{ print $2; exit }' "$repository_root/action.yml")"
[[ -n "$version" ]] || { printf 'Unable to read configured Pi version.\n' >&2; exit 1; }
temporary_directory="$(mktemp -d)"
cleanup() {
  if [[ "${CI:-}" == "true" ]]; then
    rm -rf -- "$temporary_directory"
  elif command -v gomi >/dev/null 2>&1; then
    gomi "$temporary_directory"
  else
    printf 'Installation test files left at %s (install gomi to enable cleanup).\n' "$temporary_directory" >&2
  fi
}
trap cleanup EXIT
mkdir -p "$temporary_directory/workspace" "$temporary_directory/runner"

output="$(env \
  GITHUB_WORKSPACE="$temporary_directory/workspace" \
  RUNNER_TEMP="$temporary_directory/runner" \
  GITHUB_OUTPUT="$temporary_directory/output" \
  PI_AGENT_INPUT_PROMPT=installation-probe \
  PI_AGENT_INPUT_VERSION="$version" \
  PI_AGENT_TEST_INSTALL_ONLY=true \
  "$repository_root/scripts/run.sh")"

[[ "$output" == *"Pi $version installation verified."* ]] || {
  printf 'Installed Pi did not report the configured version: %s\n' "$output" >&2
  exit 1
}
[[ -x "$temporary_directory/runner/pi-agent-$version/node_modules/.bin/pi" ]] || {
  printf 'Pi executable was not installed under RUNNER_TEMP.\n' >&2
  exit 1
}
printf 'Real Pi installation test passed.\n'
