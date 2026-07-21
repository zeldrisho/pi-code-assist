#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(awk '/default: [0-9]+\.[0-9]+\.[0-9]+/{ print $2; exit }' "$repository_root/action.yml")"
[[ -n "$version" ]] || { printf 'Unable to read configured Pi version.\n' >&2; exit 1; }

if [[ -n "${PI_AGENT_TEST_SHARED_ROOT:-}" ]]; then
  dependency_root="$PI_AGENT_TEST_SHARED_ROOT/runner/pi-agent-$version"
  [[ -x "$dependency_root/node_modules/.bin/pi" ]] || {
    printf 'Shared Pi installation is missing; run tests/install.sh first.\n' >&2
    exit 1
  }
else
  dependency_root="$(mktemp -d)"
  cleanup() {
    if [[ "${CI:-}" == "true" ]]; then
      rm -rf -- "$dependency_root"
    elif command -v gomi >/dev/null 2>&1; then
      gomi "$dependency_root"
    else
      printf 'Extension test files left at %s (install gomi to enable cleanup).\n' "$dependency_root" >&2
    fi
  }
  trap cleanup EXIT
fi

packages=("typescript@5.9.3" "@types/node@22.18.0")
if [[ -z "${PI_AGENT_TEST_SHARED_ROOT:-}" ]]; then
  packages+=("@earendil-works/pi-coding-agent@$version")
fi
npm install \
  --prefix "$dependency_root" \
  --no-audit \
  --no-fund \
  --ignore-scripts \
  "${packages[@]}" >/dev/null

package_root="$dependency_root/node_modules/@earendil-works/pi-coding-agent"
cp "$repository_root/extensions/github-tools.ts" "$package_root/github-tools.ts"
cp "$repository_root/tests/github-tools.cjs" "$package_root/github-tools.test.cjs"
"$dependency_root/node_modules/.bin/tsc" \
  --noEmit \
  --strict \
  --skipLibCheck \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --typeRoots "$dependency_root/node_modules/@types" \
  --types node \
  "$package_root/github-tools.ts"
(
  cd "$package_root"
  node github-tools.test.cjs
)
