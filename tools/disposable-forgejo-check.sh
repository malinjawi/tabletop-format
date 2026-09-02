#!/usr/bin/env bash
# Boot a fresh digest-pinned Forgejo, run the real Store-1 journey, then remove
# only the uniquely named disposable container and volume created here.
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
image="${FORGEJO_TEST_IMAGE:-}"
if [[ ! "$image" =~ @sha256:[0-9a-f]{64}$ ]]; then
  printf 'FORGEJO_TEST_IMAGE must be a digest-pinned image reference\n' >&2
  exit 2
fi
docker image inspect "$image" >/dev/null

run_id="$(date -u +%Y%m%d%H%M%S)-$$"
container_name="forge-conformance-$run_id"
volume_name="forge-conformance-$run_id-data"
port="$(node -e 'const n=require("net");const s=n.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')"
origin="http://127.0.0.1:$port"
admin_user="launch-gate"
admin_password="disposable-${run_id}-pass"

cleanup() {
  docker container rm --force "$container_name" >/dev/null 2>&1 || true
  docker volume rm "$volume_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker volume create "$volume_name" >/dev/null
docker run --detach --name "$container_name" \
  --publish "127.0.0.1:$port:3000" \
  --env USER_UID=1000 --env USER_GID=1000 \
  --env FORGEJO__security__INSTALL_LOCK=true \
  --env FORGEJO__service__DISABLE_REGISTRATION=true \
  --env FORGEJO__server__ROOT_URL="$origin/" \
  --env FORGEJO__server__LFS_START_SERVER=true \
  --env FORGEJO__database__DB_TYPE=sqlite3 \
  --volume "$volume_name:/data" \
  "$image" >/dev/null

ready=0
for _attempt in $(seq 1 120); do
  if curl -fsS "$origin/api/healthz" >/dev/null 2>&1; then ready=1; break; fi
  if ! docker container inspect "$container_name" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
    docker logs "$container_name" >&2
    exit 1
  fi
  sleep 0.25
done
if [ "$ready" != "1" ]; then
  docker logs "$container_name" >&2
  printf 'Forgejo did not become healthy at %s\n' "$origin" >&2
  exit 1
fi

docker exec --user 1000 "$container_name" forgejo admin user create \
  --config /data/gitea/conf/app.ini \
  --username "$admin_user" --password "$admin_password" \
  --email launch-gate@example.invalid --admin --must-change-password=false >/dev/null

FORGE_URL="$origin" ADMIN_USER="$admin_user" ADMIN_PASS="$admin_password" \
  FORGE_ALLOW_FIXTURE_DELETE=1 "$repo_dir/journey-forgejo.sh"

printf '\nDISPOSABLE FORGEJO GREEN — real service journey passed at a digest-pinned image.\n'
