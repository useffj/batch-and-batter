#!/usr/bin/env bash
set -euo pipefail

# Other hosting branches keep their existing source, configuration and caches.
if [[ "${AWS_BRANCH:?Amplify branch identity is required}" != main ]]; then
  exit 0
fi

# Immutable, reviewed Job 9 security candidate. Never accept an environment pin.
readonly candidate=6131e86eacb1d284a6a6249075a9f66f745e61b9
readonly web_tree=8998f089ab42fab9821f86abef32c049f53d8fcf
readonly node_blob=60ade1ae01e833a5c291c47883bf26fb031f7727
[[ "${CHECKOUT_SUBMISSION_MODE:-}" == locked ]] || {
  echo 'Public candidate requires CHECKOUT_SUBMISSION_MODE=locked.' >&2
  exit 1
}
[[ "${STOREFRONT_API_BASE_URL:-}" == https://7otpu9y03a.execute-api.us-east-2.amazonaws.com ]] || {
  echo 'Public candidate requires the reviewed existing API.' >&2
  exit 1
}
readonly root="$(git rev-parse --show-toplevel)"
[[ "$(pwd -P)" == "$(cd "$root/web" && pwd -P)" ]]

# Fetch failure is fatal even if a stale local object happens to exist.
git fetch --no-tags origin "$candidate"
[[ "$(git rev-parse 'FETCH_HEAD^{commit}')" == "$candidate" ]]
[[ "$(git rev-parse "$candidate:web")" == "$web_tree" ]]
[[ "$(git rev-parse "$candidate:.nvmrc")" == "$node_blob" ]]

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
git -C "$root" archive "$candidate" web .nvmrc | tar -xf - -C "$stage"

# Retain appRoot web and .next SSR artifact handling, but remove ALL restored
# caches, dependency installations, environment files and newer main web source.
# Do not remove web itself: Amplify's shell is already inside that directory.
find "$root/web" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -R "$stage/web/." "$root/web/"
cp "$stage/.nvmrc" "$root/.nvmrc"
diff -qr "$stage/web" "$root/web"
[[ "$(git hash-object "$root/.nvmrc")" == "$node_blob" ]]
echo "Verified public candidate $candidate; web tree $web_tree; checkout locked."
