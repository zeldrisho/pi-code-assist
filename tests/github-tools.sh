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
    printf 'Extension test files left at %s (install gomi to enable cleanup).\n' "$temporary_directory" >&2
  fi
}
trap cleanup EXIT

version="$(awk '/default: [0-9]+\.[0-9]+\.[0-9]+/{ print $2; exit }' "$repository_root/action.yml")"
[[ -n "$version" ]] || { printf 'Unable to read configured Pi version.\n' >&2; exit 1; }

npm install \
  --prefix "$temporary_directory" \
  --no-audit \
  --no-fund \
  --ignore-scripts \
  "@earendil-works/pi-coding-agent@$version" \
  "typescript@5.9.3" \
  "@types/node@22.18.0" >/dev/null

package_root="$temporary_directory/node_modules/@earendil-works/pi-coding-agent"
cp "$repository_root/extensions/github-tools.ts" "$package_root/github-tools.ts"
cp "$repository_root/tests/github-tools.cjs" "$package_root/github-tools.test.cjs"
"$temporary_directory/node_modules/.bin/tsc" \
  --noEmit \
  --strict \
  --skipLibCheck \
  --target ES2022 \
  --module NodeNext \
  --moduleResolution NodeNext \
  --typeRoots "$temporary_directory/node_modules/@types" \
  --types node \
  "$package_root/github-tools.ts"
(
  cd "$package_root"
  node github-tools.test.cjs
)
