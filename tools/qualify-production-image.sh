#!/usr/bin/env bash
# Build the candidate from its qualified base and prove that the same immutable
# image can create, back up, restore, and byte-reproduce a real Forge release.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

candidate_revision="$(git rev-parse HEAD)"
if [ "${FORGE_REQUIRE_CLEAN_TREE:-0}" = "1" ] && [ -n "$(git status --porcelain)" ]; then
  printf 'release image qualification requires a clean committed tree\n' >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
. "$root/deploy/qualified-images.env"
set +a

for pair in \
  "NODE_TEST_IMAGE:$NODE_TEST_IMAGE" \
  "FORGEJO_TEST_IMAGE:$FORGEJO_TEST_IMAGE" \
  "POSTGRES_TEST_IMAGE:$POSTGRES_TEST_IMAGE" \
  "ALPINE_TEST_IMAGE:$ALPINE_TEST_IMAGE" \
  "S3_TEST_IMAGE:$S3_TEST_IMAGE"; do
  name="${pair%%:*}"
  value="${pair#*:}"
  if [[ ! "$value" =~ @sha256:[0-9a-f]{64}$ ]]; then
    printf '%s must be an immutable digest reference\n' "$name" >&2
    exit 2
  fi
  docker pull "$value"
done

image_tag="forge-platform:qualification-${candidate_revision:0:12}"
docker build --pull \
  --build-arg NODE_IMAGE="$NODE_TEST_IMAGE" \
  --build-arg FORGE_SOURCE_REVISION="$candidate_revision" \
  --tag "$image_tag" --file Dockerfile.prod .
image_id="$(docker image inspect --format '{{.Id}}' "$image_tag")"

[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")" = "$candidate_revision" ]
[ "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.licenses"}}' "$image_id")" = "Apache-2.0" ]
[ "$(docker image inspect --format '{{.Config.User}}' "$image_id")" = "node" ]
docker run --rm --read-only --tmpfs /tmp:size=67108864,mode=1777 \
  "$image_id" /bin/sh -ec 'node --version && chromium --version && git --version && python3 --version'

printf '\n== Qualify exact gateway image with real stores and synchronized recovery ==\n'
FORGE_GATEWAY_TEST_IMAGE="$image_id" \
  "$root/tools/disposable-restore-drill.sh"

printf '\nPRODUCTION IMAGE QUALIFIED — %s records %s and reproduced the frozen release after restore.\n' \
  "$image_id" "$candidate_revision"
