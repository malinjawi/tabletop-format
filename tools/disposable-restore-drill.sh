#!/usr/bin/env bash
# Build real collaboration state on Forgejo + PostgreSQL, take a synchronized
# three-store backup, and restore it into fresh disposable volumes. The restored
# gateway starts with no render cache, proving Store 3 is genuinely derived.
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
forgejo_image="${FORGEJO_TEST_IMAGE:-}"
postgres_image="${POSTGRES_TEST_IMAGE:-}"
utility_image="${ALPINE_TEST_IMAGE:-}"
for pair in "FORGEJO_TEST_IMAGE:$forgejo_image" "POSTGRES_TEST_IMAGE:$postgres_image" "ALPINE_TEST_IMAGE:$utility_image"; do
  key="${pair%%:*}"; value="${pair#*:}"
  if [[ ! "$value" =~ @sha256:[0-9a-f]{64}$ ]]; then
    printf '%s must be a digest-pinned image reference\n' "$key" >&2
    exit 2
  fi
  docker image inspect "$value" >/dev/null
done
forgejo_version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$forgejo_image")"
if [[ ! "$forgejo_version" =~ ^15\. ]]; then
  printf 'Forgejo recovery is qualified on 15.x; %s reports %s\n' "$forgejo_image" "${forgejo_version:-no version label}" >&2
  exit 2
fi
postgres_major="$(docker image inspect --format '{{json .Config.Env}}' "$postgres_image" | node -e '
  let value="";process.stdin.on("data",chunk=>value+=chunk).on("end",()=>{
    const item=(JSON.parse(value)||[]).find(entry=>entry.startsWith("PG_MAJOR="));process.stdout.write(item?item.slice(9):"");
  });')"
if [ "$postgres_major" != "16" ]; then
  printf 'PostgreSQL recovery is qualified on major 16; %s reports %s\n' "$postgres_image" "${postgres_major:-unknown}" >&2
  exit 2
fi

run_id="$(date -u +%Y%m%d%H%M%S)-$$"
prefix="forge-restore-$run_id"
network="$prefix-net"
source_pg="$prefix-source-db"; source_forgejo="$prefix-source-forgejo"
restore_pg="$prefix-restore-db"; restore_forgejo="$prefix-restore-forgejo"
restore_helper="$prefix-restore-helper"
source_pg_volume="$prefix-source-pg"; source_forgejo_volume="$prefix-source-forgejo-data"
restore_pg_volume="$prefix-restore-pg"; restore_forgejo_volume="$prefix-restore-forgejo-data"
secret_volume="$prefix-secrets"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/forge-restore-drill.XXXXXX")"
gateway_pid=""

cleanup(){
  status=$?
  [ -n "$gateway_pid" ] && kill "$gateway_pid" >/dev/null 2>&1 || true
  docker container rm --force "$source_forgejo" "$restore_forgejo" "$source_pg" "$restore_pg" "$restore_helper" >/dev/null 2>&1 || true
  docker volume rm "$source_pg_volume" "$source_forgejo_volume" "$restore_pg_volume" "$restore_forgejo_volume" "$secret_volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  if [ "${FORGE_KEEP_RESTORE_DRILL:-0}" = "1" ]; then
    printf 'restore drill evidence retained at %s\n' "$scratch" >&2
  else
    case "$scratch" in "${TMPDIR:-/tmp}"/forge-restore-drill.*) find "$scratch" -depth -delete 2>/dev/null || true ;; esac
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

read -r source_pg_port source_forgejo_port restore_pg_port restore_forgejo_port gateway_port < <(
  node -e 'const n=require("net"),s=Array.from({length:5},()=>n.createServer());Promise.all(s.map(x=>new Promise(r=>x.listen(0,"127.0.0.1",r)))).then(()=>{console.log(s.map(x=>x.address().port).join(" "));s.forEach(x=>x.close())})'
)
source_origin="http://127.0.0.1:$source_forgejo_port"
restore_origin="http://127.0.0.1:$restore_forgejo_port"
gateway_origin="http://127.0.0.1:$gateway_port"
postgres_password="postgres-$run_id"; forgejo_password="forgejo-$run_id"; platform_password="platform-$run_id"
admin_user="launch-gate"; admin_password="disposable-$run_id-pass"

mkdir -p "$scratch/secrets" "$scratch/backup" "$scratch/staging" "$scratch/restored-cache" "$scratch/restored-farm"
chmod 700 "$scratch/secrets"
umask 077
printf '%s\n' "$forgejo_password" > "$scratch/secrets/forgejo-db-password"
openssl rand -base64 32 > "$scratch/secrets/forgejo-secret-key"
openssl rand -base64 32 > "$scratch/secrets/forgejo-internal-token"
openssl rand -base64 32 > "$scratch/secrets/forgejo-oauth2-jwt-secret"
openssl rand -base64 32 > "$scratch/secrets/lfs-jwt-secret"

docker network create "$network" >/dev/null
for volume in "$source_pg_volume" "$source_forgejo_volume" "$restore_pg_volume" "$restore_forgejo_volume" "$secret_volume"; do
  docker volume create "$volume" >/dev/null
done
docker run --rm --volume "$secret_volume:/secrets" \
  --env FORGEJO_DB_PASSWORD="$(tr -d '\n' < "$scratch/secrets/forgejo-db-password")" \
  --env FORGEJO_SECRET_KEY="$(tr -d '\n' < "$scratch/secrets/forgejo-secret-key")" \
  --env FORGEJO_INTERNAL_TOKEN="$(tr -d '\n' < "$scratch/secrets/forgejo-internal-token")" \
  --env FORGEJO_OAUTH2_JWT_SECRET="$(tr -d '\n' < "$scratch/secrets/forgejo-oauth2-jwt-secret")" \
  --env FORGEJO_LFS_JWT_SECRET="$(tr -d '\n' < "$scratch/secrets/lfs-jwt-secret")" \
  "$utility_image" sh -eu -c '
    umask 077
    printf "%s\n" "$FORGEJO_DB_PASSWORD" > /secrets/forgejo-db-password
    printf "%s\n" "$FORGEJO_SECRET_KEY" > /secrets/forgejo-secret-key
    printf "%s\n" "$FORGEJO_INTERNAL_TOKEN" > /secrets/forgejo-internal-token
    printf "%s\n" "$FORGEJO_OAUTH2_JWT_SECRET" > /secrets/forgejo-oauth2-jwt-secret
    printf "%s\n" "$FORGEJO_LFS_JWT_SECRET" > /secrets/lfs-jwt-secret
    chown 1000:1000 /secrets/*
    chmod 0400 /secrets/*
  '

wait_postgres(){
  local container="$1" stable=0
  for _attempt in $(seq 1 120); do
    if docker exec "$container" psql -U postgres -d postgres -Atqc 'SELECT 1' >/dev/null 2>&1; then
      stable=$((stable + 1))
      [ "$stable" -lt 3 ] || return 0
    else
      stable=0
    fi
    sleep 0.25
  done
  docker logs "$container" >&2
  return 1
}
start_postgres(){
  local container="$1" volume="$2" port="$3"
  docker run --detach --name "$container" --network "$network" \
    --publish "127.0.0.1:$port:5432" \
    --env POSTGRES_PASSWORD="$postgres_password" \
    --volume "$volume:/var/lib/postgresql/data" "$postgres_image" >/dev/null
  wait_postgres "$container"
  docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "CREATE ROLE forgejo LOGIN PASSWORD '$forgejo_password'" >/dev/null
  docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "CREATE ROLE platform LOGIN PASSWORD '$platform_password'" >/dev/null
  docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "CREATE DATABASE forgejo OWNER forgejo" >/dev/null
  docker exec "$container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "CREATE DATABASE platform OWNER platform" >/dev/null
}
wait_forgejo(){
  local container="$1" origin="$2"
  for _attempt in $(seq 1 240); do
    curl -fsS "$origin/api/healthz" >/dev/null 2>&1 && return 0
    if ! docker container inspect "$container" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
      docker logs "$container" >&2; return 1
    fi
    sleep 0.25
  done
  docker logs "$container" >&2
  return 1
}
start_forgejo(){
  local container="$1" volume="$2" database_host="$3" origin="$4" port="$5"
  docker run --detach --name "$container" --network "$network" \
    --publish "127.0.0.1:$port:3000" \
    --env USER_UID=1000 --env USER_GID=1000 \
    --env FORGEJO__security__INSTALL_LOCK=true \
    --env FORGEJO__security__SECRET_KEY__FILE=/run/forge-secrets/forgejo-secret-key \
    --env FORGEJO__security__INTERNAL_TOKEN__FILE=/run/forge-secrets/forgejo-internal-token \
    --env FORGEJO__oauth2__JWT_SIGNING_ALGORITHM=HS256 \
    --env FORGEJO__oauth2__JWT_SECRET__FILE=/run/forge-secrets/forgejo-oauth2-jwt-secret \
    --env FORGEJO__service__DISABLE_REGISTRATION=true \
    --env FORGEJO__server__ROOT_URL="$origin/" \
    --env FORGEJO__server__LFS_START_SERVER=true \
    --env FORGEJO__server__LFS_JWT_SECRET__FILE=/run/forge-secrets/lfs-jwt-secret \
    --env FORGEJO__database__DB_TYPE=postgres \
    --env FORGEJO__database__HOST="$database_host:5432" \
    --env FORGEJO__database__NAME=forgejo \
    --env FORGEJO__database__USER=forgejo \
    --env FORGEJO__database__PASSWD_URI=file:/run/forge-secrets/forgejo-db-password \
    --volume "$volume:/data" --volume "$secret_volume:/run/forge-secrets:ro" \
    "$forgejo_image" >/dev/null
  wait_forgejo "$container" "$origin"
}

printf '== Build source state on real Forgejo + PostgreSQL ==\n'
start_postgres "$source_pg" "$source_pg_volume" "$source_pg_port"
printf '  ✓ source PostgreSQL ready\n'
start_forgejo "$source_forgejo" "$source_forgejo_volume" "$source_pg" "$source_origin" "$source_forgejo_port"
printf '  ✓ source Forgejo ready\n'
if ! admin_create_output="$(docker exec --user 1000 "$source_forgejo" forgejo admin user create \
  --config /data/gitea/conf/app.ini --username "$admin_user" --password "$admin_password" \
  --email launch-gate@example.invalid --admin --must-change-password=false 2>&1)"; then
  printf '%s\n' "$admin_create_output" >&2
  docker logs "$source_forgejo" >&2
  exit 1
fi
printf '  ✓ disposable administrator created\n'
source_journey_log="$scratch/source-journey.log"
if ! FORGE_URL="$source_origin" ADMIN_USER="$admin_user" ADMIN_PASS="$admin_password" \
  FORGE_ALLOW_FIXTURE_DELETE=1 DB=postgres \
  PG_URL="postgres://platform:$platform_password@127.0.0.1:$source_pg_port/platform" \
  "$repo_dir/journey-forgejo.sh" > "$source_journey_log" 2>&1; then
  cat "$source_journey_log" >&2
  exit 1
fi
tail -n 4 "$source_journey_log"

printf '\n== Freeze writes and create synchronized backup ==\n'
docker stop "$source_forgejo" >/dev/null
docker run --rm --user 1000 --network "$network" \
  --volume "$source_forgejo_volume:/data" \
  --volume "$secret_volume:/run/forge-secrets:ro" \
  "$forgejo_image" forgejo dump --config /data/gitea/conf/app.ini \
  --file - --type zip --database postgres --skip-log --quiet \
  > "$scratch/backup/forgejo.zip"
docker exec "$source_pg" pg_dump -U postgres -Fc platform > "$scratch/backup/platform.dump"
docker exec "$source_pg" pg_dump -U postgres -Fc forgejo > "$scratch/backup/forgejo.dump"
unzip -tqq "$scratch/backup/forgejo.zip"
docker exec -i "$source_pg" pg_restore --list < "$scratch/backup/platform.dump" >/dev/null
docker exec -i "$source_pg" pg_restore --list < "$scratch/backup/forgejo.dump" >/dev/null
{
  printf 'created_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'forgejo_image=%s\n' "$forgejo_image"
  printf 'postgres_image=%s\n' "$postgres_image"
  for secret in "$scratch"/secrets/*; do
    printf '%s_sha256=%s\n' "$(basename "$secret")" "$(shasum -a 256 "$secret" | awk '{print $1}')"
  done
} > "$scratch/backup/manifest.txt"
(cd "$scratch/backup" && shasum -a 256 forgejo.zip platform.dump forgejo.dump manifest.txt > SHA256SUMS)
(cd "$scratch/backup" && shasum -a 256 -c SHA256SUMS >/dev/null)

printf '\n== Restore into fresh database and repository volumes ==\n'
start_postgres "$restore_pg" "$restore_pg_volume" "$restore_pg_port"
docker exec -i "$restore_pg" pg_restore --exit-on-error -U postgres --no-owner --role=platform -d platform \
  < "$scratch/backup/platform.dump" >/dev/null
docker exec -i "$restore_pg" pg_restore --exit-on-error -U postgres --no-owner --role=forgejo -d forgejo \
  < "$scratch/backup/forgejo.dump" >/dev/null
unzip -q "$scratch/backup/forgejo.zip" -d "$scratch/staging"
docker run --detach --name "$restore_helper" --volume "$restore_forgejo_volume:/data" \
  "$utility_image" sleep 300 >/dev/null
docker exec "$restore_helper" mkdir -p /data/git/repositories /data/gitea
[ ! -d "$scratch/staging/repos" ] || docker cp "$scratch/staging/repos/." "$restore_helper:/data/git/repositories/"
[ ! -d "$scratch/staging/data" ] || docker cp "$scratch/staging/data/." "$restore_helper:/data/gitea/"
[ ! -d "$scratch/staging/custom" ] || docker cp "$scratch/staging/custom/." "$restore_helper:/data/gitea/"
docker exec "$restore_helper" sh -eu -c '
    if [ -d /data/gitea/lfs ]; then
      [ ! -e /data/git/lfs ]
      mv /data/gitea/lfs /data/git/lfs
    fi
    mkdir -p /data/git/.ssh /data/gitea/conf /data/gitea/log /data/ssh
    rm -f /data/gitea/conf/app.ini
    chown -R 1000:1000 /data
    chmod 0700 /data/git/.ssh
  '
docker rm --force "$restore_helper" >/dev/null
start_forgejo "$restore_forgejo" "$restore_forgejo_volume" "$restore_pg" "$restore_origin" "$restore_forgejo_port"
if ! doctor_output="$(docker exec --user 1000 "$restore_forgejo" forgejo doctor check --all \
  --config /data/gitea/conf/app.ini --log-file /tmp/doctor.log 2>&1)"; then
  printf '%s\n' "$doctor_output" >&2
  docker exec "$restore_forgejo" sh -c 'test ! -f /tmp/doctor.log || cat /tmp/doctor.log' >&2
  exit 1
fi
printf '  ✓ Forgejo doctor accepted restored repository and configuration state\n'

forge_token="$(curl -fsS -u "$admin_user:$admin_password" -X POST -H 'Content-Type: application/json' \
  -d '{"name":"restore-verifier","scopes":["all"]}' \
  "$restore_origin/api/v1/users/$admin_user/tokens" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).sha1||''))")"
[ -n "$forge_token" ] || { printf 'could not mint restored Forgejo token\n' >&2; exit 1; }

if find "$scratch/restored-cache" -type f -print -quit | grep -q .; then
  printf 'restored Store 3 must begin empty\n' >&2; exit 1
fi
STORE1=forgejo FORGE_URL="$restore_origin" FORGE_TOKEN="$forge_token" \
  FORGE_BASIC="$admin_user:$admin_password" DB=postgres \
  PG_URL="postgres://platform:$platform_password@127.0.0.1:$restore_pg_port/platform" \
  CACHE_DIR="$scratch/restored-cache" FARM_DIR="$scratch/restored-farm" \
  FORGE_HUB_PATH="$scratch/restored-hub.html" FORGE_REGISTRATION_MODE=closed \
  node "$repo_dir/server.mjs" --port "$gateway_port" > "$scratch/restored-gateway.log" 2>&1 &
gateway_pid=$!
for _attempt in $(seq 1 120); do
  curl -fsS "$gateway_origin/healthz" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS "$gateway_origin/healthz" >/dev/null || { tail -80 "$scratch/restored-gateway.log" >&2; exit 1; }
FORGE_URL="$restore_origin" FORGE_TOKEN="$forge_token" \
  node "$repo_dir/tools/restore-verify.mjs" "$gateway_origin"

printf '\nDISPOSABLE RESTORE DRILL GREEN — synchronized backup restored into fresh volumes; Store 3 rebuilt exact released bytes.\n'
