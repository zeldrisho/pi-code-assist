#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

shared_test_root="$(mktemp -d)"
cleanup() {
  if [[ "${CI:-}" == "true" ]]; then
    rm -rf -- "$shared_test_root"
  elif command -v gomi >/dev/null 2>&1; then
    gomi "$shared_test_root"
  else
    printf 'Validation files left at %s (install gomi to enable cleanup).\n' "$shared_test_root" >&2
  fi
}
trap cleanup EXIT

bash -n scripts/*.sh tests/*.sh
shellcheck scripts/*.sh tests/*.sh
if command -v actionlint >/dev/null 2>&1; then
  actionlint
else
  go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
fi
./tests/run.sh
PI_AGENT_TEST_SHARED_ROOT="$shared_test_root" ./tests/install.sh
PI_AGENT_TEST_SHARED_ROOT="$shared_test_root" ./tests/github-tools.sh
./tests/contract.sh
./tests/smoke-action.sh
git diff --check
