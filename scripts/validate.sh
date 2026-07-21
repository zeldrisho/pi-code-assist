#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

bash -n scripts/*.sh tests/*.sh
shellcheck scripts/*.sh tests/*.sh
if command -v actionlint >/dev/null 2>&1; then
  actionlint
else
  go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.7
fi
./tests/run.sh
./tests/github-tools.sh
./tests/contract.sh
./tests/smoke-action.sh
git diff --check
