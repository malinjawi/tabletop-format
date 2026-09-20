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
  "$image_id" /bin/sh -ec 'node --version && chromium --version && git --version && python3 --version && python3 tools/test_print_ready.py'

printf '\n== Qualify exact gateway image with real stores and synchronized recovery ==\n'
qualification_log="$(mktemp "${TMPDIR:-/tmp}/forge-image-qualification.XXXXXX")"
trap 'rm -f "$qualification_log"' EXIT
FORGE_GATEWAY_TEST_IMAGE="$image_id" \
  "$root/tools/disposable-restore-drill.sh" | tee "$qualification_log"

if [ -n "${FORGE_QUALIFICATION_RECEIPT_PATH:-}" ]; then
  node --input-type=module - "$qualification_log" "$candidate_revision" "$image_id" "$FORGE_QUALIFICATION_RECEIPT_PATH" <<'NODE'
import {readFileSync,writeFileSync} from "node:fs";
const [log,commit,imageId,output]=process.argv.slice(2);
const prefix="FORGE_RESTORE_ARTIFACT_RECEIPT ";
const lines=readFileSync(log,"utf8").split("\n").filter(line=>line.startsWith(prefix));
if(lines.length!==1)throw new Error("Expected exactly one restored-artifact receipt");
const restored=JSON.parse(lines[0].slice(prefix.length));
if(restored.format!=="forge-restore-artifact-receipt"||!restored.artifacts?.length
  ||restored.artifacts.some(a=>!Number.isSafeInteger(a.bytes)||a.bytes<=0||!/^[a-f0-9]{64}$/.test(a.sha256)))
  throw new Error("Invalid restored-artifact evidence");
const ciRun=process.env.GITHUB_RUN_ID
  ?`${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`:null;
writeFileSync(output,JSON.stringify({format:"forge-qualification-receipt",version:1,
  source_commit:commit,ci_run:ciRun,local_image_id:imageId,registry_reference:null,
  image_recovery_passed:true,product_gate_passed:null,restored_fixture:restored},null,2)+"\n",{flag:"wx",mode:0o600});
NODE
fi

printf '\nPRODUCTION IMAGE QUALIFIED — %s records %s and reproduced the frozen release after restore.\n' \
  "$image_id" "$candidate_revision"
