#!/usr/bin/env bash
# Build real collaboration state on Forgejo + PostgreSQL, take a synchronized
# three-store backup, and restore it into fresh disposable volumes. When an S3
# test image is supplied, LFS lives only in S3 and that bucket is independently
# snapshotted/restored. The restored gateway starts with no render cache,
# proving Store 3 is genuinely derived.
set -euo pipefail

repo_dir="$(cd "$(dirname "$0")/.." && pwd)"
forgejo_image="${FORGEJO_TEST_IMAGE:-}"
postgres_image="${POSTGRES_TEST_IMAGE:-}"
utility_image="${ALPINE_TEST_IMAGE:-}"
gateway_image="${FORGE_GATEWAY_TEST_IMAGE:-}"
s3_image="${S3_TEST_IMAGE:-}"
for pair in "FORGEJO_TEST_IMAGE:$forgejo_image" "POSTGRES_TEST_IMAGE:$postgres_image" "ALPINE_TEST_IMAGE:$utility_image"; do
  key="${pair%%:*}"; value="${pair#*:}"
  if [[ ! "$value" =~ @sha256:[0-9a-f]{64}$ ]]; then
    printf '%s must be a digest-pinned image reference\n' "$key" >&2
    exit 2
  fi
  docker image inspect "$value" >/dev/null
done
if [ -n "$s3_image" ]; then
  if [[ ! "$s3_image" =~ @sha256:[0-9a-f]{64}$ ]]; then
    printf 'S3_TEST_IMAGE must be a digest-pinned image reference\n' >&2
    exit 2
  fi
  docker image inspect "$s3_image" >/dev/null
fi
if [ -n "$gateway_image" ]; then
  if [[ ! "$gateway_image" =~ @sha256:[0-9a-f]{64}$ && ! "$gateway_image" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf 'FORGE_GATEWAY_TEST_IMAGE must be a registry digest or immutable local image ID\n' >&2
    exit 2
  fi
  docker image inspect "$gateway_image" >/dev/null
  gateway_revision="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$gateway_image")"
  candidate_revision="$(git -C "$repo_dir" rev-parse HEAD)"
  if [ "$gateway_revision" != "$candidate_revision" ]; then
    printf 'gateway image revision %s does not match launch candidate %s\n' "${gateway_revision:-missing}" "$candidate_revision" >&2
    exit 2
  fi
fi
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
source_s3="$prefix-source-s3"; restore_s3="$prefix-restore-s3"
restore_helper="$prefix-restore-helper"
source_gateway="$prefix-source-gateway"
gateway_container="$prefix-gateway"
source_pg_volume="$prefix-source-pg"; source_forgejo_volume="$prefix-source-forgejo-data"
restore_pg_volume="$prefix-restore-pg"; restore_forgejo_volume="$prefix-restore-forgejo-data"
source_s3_volume="$prefix-source-s3-data"; restore_s3_volume="$prefix-restore-s3-data"
secret_volume="$prefix-secrets"
source_gateway_volume="$prefix-source-gateway-data"
gateway_volume="$prefix-gateway-data"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/forge-restore-drill.XXXXXX")"
gateway_pid=""

cleanup(){
  status=$?
  [ -n "$gateway_pid" ] && kill "$gateway_pid" >/dev/null 2>&1 || true
  docker container rm --force "$source_forgejo" "$restore_forgejo" "$source_pg" "$restore_pg" "$source_s3" "$restore_s3" "$restore_helper" "$source_gateway" "$gateway_container" >/dev/null 2>&1 || true
  docker volume rm "$source_pg_volume" "$source_forgejo_volume" "$restore_pg_volume" "$restore_forgejo_volume" "$source_s3_volume" "$restore_s3_volume" "$secret_volume" "$source_gateway_volume" "$gateway_volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  if [ "${FORGE_KEEP_RESTORE_DRILL:-0}" = "1" ]; then
    printf 'restore drill evidence retained at %s\n' "$scratch" >&2
  else
    case "$scratch" in "${TMPDIR:-/tmp}"/forge-restore-drill.*) find "$scratch" -depth -delete 2>/dev/null || true ;; esac
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

read -r source_pg_port source_forgejo_port restore_pg_port restore_forgejo_port gateway_port source_s3_port restore_s3_port < <(
  node -e 'const n=require("net"),s=Array.from({length:7},()=>n.createServer());Promise.all(s.map(x=>new Promise(r=>x.listen(0,"127.0.0.1",r)))).then(()=>{console.log(s.map(x=>x.address().port).join(" "));s.forEach(x=>x.close())})'
)
source_origin="http://127.0.0.1:$source_forgejo_port"
restore_origin="http://127.0.0.1:$restore_forgejo_port"
gateway_origin="http://127.0.0.1:$gateway_port"
postgres_password="postgres-$run_id"; forgejo_password="forgejo-$run_id"; platform_password="platform-$run_id"
admin_user="launch-gate"; admin_password="disposable-$run_id-pass"
journey_invite="restore-drill-$run_id-invite"
s3_access="forgeaccess$run_id"; s3_secret="forge-secret-$run_id-password"
s3_bucket="forge-lfs-${run_id//[^a-zA-Z0-9-]/-}"

mkdir -p "$scratch/secrets" "$scratch/backup" "$scratch/staging" "$scratch/restored-cache" "$scratch/restored-farm"
chmod 700 "$scratch/secrets"
umask 077
printf '%s\n' "$forgejo_password" > "$scratch/secrets/forgejo-db-password"
openssl rand -base64 32 > "$scratch/secrets/forgejo-secret-key"
openssl rand -base64 32 > "$scratch/secrets/forgejo-internal-token"
openssl rand -base64 32 > "$scratch/secrets/forgejo-oauth2-jwt-secret"
openssl rand -base64 32 > "$scratch/secrets/lfs-jwt-secret"
printf '%s\n' "$s3_access" > "$scratch/secrets/s3-access-key"
printf '%s\n' "$s3_secret" > "$scratch/secrets/s3-secret-key"

docker network create "$network" >/dev/null
for volume in "$source_pg_volume" "$source_forgejo_volume" "$restore_pg_volume" "$restore_forgejo_volume" "$secret_volume"; do
  docker volume create "$volume" >/dev/null
done
if [ -n "$s3_image" ]; then
  docker volume create "$source_s3_volume" >/dev/null
  docker volume create "$restore_s3_volume" >/dev/null
fi
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
wait_s3(){
  local container="$1" origin="$2"
  for _attempt in $(seq 1 240); do
    curl -fsS "$origin/minio/health/ready" >/dev/null 2>&1 && return 0
    if ! docker container inspect "$container" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
      docker logs "$container" >&2; return 1
    fi
    sleep 0.25
  done
  docker logs "$container" >&2
  return 1
}
start_s3(){
  local container="$1" volume="$2" port="$3"
  docker run --detach --name "$container" --network "$network" \
    --publish "127.0.0.1:$port:9000" \
    --env MINIO_ROOT_USER="$s3_access" --env MINIO_ROOT_PASSWORD="$s3_secret" \
    --volume "$volume:/data" "$s3_image" server /data --address :9000 >/dev/null
  wait_s3 "$container" "http://127.0.0.1:$port"
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
  local container="$1" volume="$2" database_host="$3" origin="$4" port="$5" s3_host="${6:-}"
  local s3_args=()
  if [ -n "$s3_host" ]; then
    s3_args=(
      --env FORGEJO__lfs__STORAGE_TYPE=minio
      --env "FORGEJO__lfs__MINIO_ENDPOINT=$s3_host:9000"
      --env "FORGEJO__lfs__MINIO_ACCESS_KEY_ID=$s3_access"
      --env "FORGEJO__lfs__MINIO_SECRET_ACCESS_KEY=$s3_secret"
      --env "FORGEJO__lfs__MINIO_BUCKET=$s3_bucket"
      --env FORGEJO__lfs__MINIO_LOCATION=us-east-1
      --env FORGEJO__lfs__MINIO_USE_SSL=false
      --env FORGEJO__lfs__MINIO_BUCKET_LOOKUP=path
      --env FORGEJO__lfs__MINIO_CHECKSUM_ALGORITHM=md5
      --env FORGEJO__lfs__SERVE_DIRECT=false
    )
  fi
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
    "${s3_args[@]}" \
    --volume "$volume:/data" --volume "$secret_volume:/run/forge-secrets:ro" \
    "$forgejo_image" >/dev/null
  wait_forgejo "$container" "$origin"
}
mint_forge_token(){
  local origin="$1" name="$2"
  curl -fsS -u "$admin_user:$admin_password" -X POST -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"scopes\":[\"all\"]}" \
    "$origin/api/v1/users/$admin_user/tokens" \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(JSON.parse(s).sha1||''))"
}
write_gateway_secrets(){
  local token="$1"
  docker run --rm --volume "$secret_volume:/secrets" \
    --env FORGE_TOKEN_VALUE="$token" --env PLATFORM_PASSWORD_VALUE="$platform_password" \
    "$utility_image" sh -eu -c '
      umask 077
      printf "%s\n" "$FORGE_TOKEN_VALUE" > /secrets/forge-token
      printf "%s\n" "$PLATFORM_PASSWORD_VALUE" > /secrets/platform-db-password
      chown 1000:1000 /secrets/forge-token /secrets/platform-db-password
      chmod 0400 /secrets/forge-token /secrets/platform-db-password
    '
}
start_gateway(){
  local container="$1" volume="$2" database_host="$3" forgejo_host="$4"
  docker run --detach --name "$container" --network "$network" \
    --publish "127.0.0.1:$gateway_port:8420" --read-only --tmpfs /tmp:size=536870912,mode=1777 \
    --volume "$volume:/app/data" --volume "$secret_volume:/run/secrets:ro" \
    --env STORE1=forgejo --env FORGE_URL="http://$forgejo_host:3000" \
    --env DB=postgres --env PGHOST="$database_host" --env PGPORT=5432 \
    --env PGDATABASE=platform --env PGUSER=platform \
    --env CACHE_DIR=/app/data/cache --env FARM_DIR=/app/data/forge-farm \
    --env FORGE_HUB_PATH=/app/data/hub.html \
    --env FORGE_PUBLIC_ORIGIN="$gateway_origin" --env FORGE_ALLOWED_ORIGINS="$gateway_origin" \
    --env FORGE_HTTPS=1 --env FORGE_REGISTRATION_MODE=invite --env FORGE_INVITE_CODE="$journey_invite" \
    --env FORGE_OPERATOR_NAME='Forge restore drill' --env FORGE_CONTACT_EMAIL=operator@forge.test \
    --env FORGE_BUILD_ID="$gateway_image" \
    "$gateway_image" /bin/sh -ec '
      export FORGE_TOKEN="$(cat /run/secrets/forge-token)"
      export PGPASSWORD="$(cat /run/secrets/platform-db-password)"
      exec node server.mjs --port 8420
    ' >/dev/null
  for _attempt in $(seq 1 120); do
    curl -fsS "$gateway_origin/healthz" >/dev/null 2>&1 && return 0
    if ! docker container inspect "$container" --format '{{.State.Running}}' 2>/dev/null | grep -qx true; then
      docker logs "$container" >&2
      return 1
    fi
    sleep 0.25
  done
  docker logs "$container" >&2
  return 1
}

printf '== Build source state on real Forgejo + PostgreSQL%s ==\n' "$([ -n "$s3_image" ] && printf ' + S3 LFS' || true)"
start_postgres "$source_pg" "$source_pg_volume" "$source_pg_port"
printf '  ✓ source PostgreSQL ready\n'
if [ -n "$s3_image" ]; then
  start_s3 "$source_s3" "$source_s3_volume" "$source_s3_port"
  node "$repo_dir/deploy/s3-snapshot.mjs" create \
    --endpoint "http://127.0.0.1:$source_s3_port" --bucket "$s3_bucket" --region us-east-1 \
    --access-key-file "$scratch/secrets/s3-access-key" --secret-key-file "$scratch/secrets/s3-secret-key" >/dev/null
  printf '  ✓ source S3 bucket ready\n'
fi
start_forgejo "$source_forgejo" "$source_forgejo_volume" "$source_pg" "$source_origin" "$source_forgejo_port" "$([ -n "$s3_image" ] && printf '%s' "$source_s3" || true)"
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
if [ -n "$gateway_image" ]; then
  source_gateway_token="$(mint_forge_token "$source_origin" source-gateway)"
  [ -n "$source_gateway_token" ] || { printf 'could not mint source gateway token\n' >&2; exit 1; }
  docker volume create "$source_gateway_volume" >/dev/null
  write_gateway_secrets "$source_gateway_token"
  start_gateway "$source_gateway" "$source_gateway_volume" "$source_pg" "$source_forgejo"
  source_gateway_args=(FORGE_EXISTING_GATEWAY_URL="$gateway_origin")
else
  source_gateway_args=(DB=postgres PG_URL="postgres://platform:$platform_password@127.0.0.1:$source_pg_port/platform")
fi
if ! env FORGE_URL="$source_origin" ADMIN_USER="$admin_user" ADMIN_PASS="$admin_password" \
  FORGE_ALLOW_FIXTURE_DELETE=1 FORGE_JOURNEY_INVITE_CODE="$journey_invite" "${source_gateway_args[@]}" \
  "$repo_dir/journey-forgejo.sh" > "$source_journey_log" 2>&1; then
  cat "$source_journey_log" >&2
  [ -z "$gateway_image" ] || docker logs "$source_gateway" >&2
  exit 1
fi
tail -n 4 "$source_journey_log"

printf '\n== Freeze writes and create synchronized backup ==\n'
if [ -n "$gateway_image" ]; then
  docker stop "$source_gateway" >/dev/null
  docker rm "$source_gateway" >/dev/null
  docker volume rm "$source_gateway_volume" >/dev/null
fi
docker stop "$source_forgejo" >/dev/null
if [ -n "$s3_image" ]; then
  node "$repo_dir/deploy/s3-snapshot.mjs" backup \
    --endpoint "http://127.0.0.1:$source_s3_port" --bucket "$s3_bucket" --region us-east-1 \
    --access-key-file "$scratch/secrets/s3-access-key" --secret-key-file "$scratch/secrets/s3-secret-key" \
    --output "$scratch/backup/object-store"
  node -e 'const m=require(process.argv[1]);if(!m.objects.length)throw Error("S3 LFS journey created no objects")' \
    "$scratch/backup/object-store/manifest.json"
fi
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
  [ -z "$s3_image" ] || printf 's3_image=%s\n' "$s3_image"
  for secret in "$scratch"/secrets/*; do
    printf '%s_sha256=%s\n' "$(basename "$secret")" "$(shasum -a 256 "$secret" | awk '{print $1}')"
  done
} > "$scratch/backup/manifest.txt"
snapshot_manifest=()
[ -z "$s3_image" ] || snapshot_manifest=(object-store/manifest.json)
(cd "$scratch/backup" && shasum -a 256 forgejo.zip platform.dump forgejo.dump manifest.txt "${snapshot_manifest[@]}" > SHA256SUMS)
(cd "$scratch/backup" && shasum -a 256 -c SHA256SUMS >/dev/null)
if [ -n "$s3_image" ]; then
  node "$repo_dir/deploy/s3-snapshot.mjs" verify --input "$scratch/backup/object-store"
  docker stop "$source_s3" >/dev/null
fi

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
if [ -n "$s3_image" ]; then
  start_s3 "$restore_s3" "$restore_s3_volume" "$restore_s3_port"
  node "$repo_dir/deploy/s3-snapshot.mjs" restore \
    --endpoint "http://127.0.0.1:$restore_s3_port" --bucket "$s3_bucket" --region us-east-1 \
    --access-key-file "$scratch/secrets/s3-access-key" --secret-key-file "$scratch/secrets/s3-secret-key" \
    --input "$scratch/backup/object-store" --create-bucket
fi
start_forgejo "$restore_forgejo" "$restore_forgejo_volume" "$restore_pg" "$restore_origin" "$restore_forgejo_port" "$([ -n "$s3_image" ] && printf '%s' "$restore_s3" || true)"
if ! doctor_output="$(docker exec --user 1000 "$restore_forgejo" forgejo doctor check --all \
  --config /data/gitea/conf/app.ini --log-file /tmp/doctor.log 2>&1)"; then
  printf '%s\n' "$doctor_output" >&2
  docker exec "$restore_forgejo" sh -c 'test ! -f /tmp/doctor.log || cat /tmp/doctor.log' >&2
  exit 1
fi
printf '  ✓ Forgejo doctor accepted restored repository and configuration state\n'

forge_token="$(mint_forge_token "$restore_origin" restore-verifier)"
[ -n "$forge_token" ] || { printf 'could not mint restored Forgejo token\n' >&2; exit 1; }

if [ -n "$gateway_image" ]; then
  docker volume create "$gateway_volume" >/dev/null
  write_gateway_secrets "$forge_token"
  start_gateway "$gateway_container" "$gateway_volume" "$restore_pg" "$restore_forgejo"
else
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
fi
if [ -z "$gateway_image" ]; then
  for _attempt in $(seq 1 120); do
    curl -fsS "$gateway_origin/healthz" >/dev/null 2>&1 && break
    sleep 0.25
  done
  curl -fsS "$gateway_origin/healthz" >/dev/null || { tail -80 "$scratch/restored-gateway.log" >&2; exit 1; }
fi
if ! FORGE_URL="$restore_origin" FORGE_TOKEN="$forge_token" \
  node "$repo_dir/tools/restore-verify.mjs" "$gateway_origin"; then
  if [ -n "$gateway_image" ]; then
    printf '\n== Failed gateway container log ==\n' >&2
    docker logs "$gateway_container" >&2
  fi
  exit 1
fi

if [ -n "$gateway_image" ]; then
  printf '\nDISPOSABLE RESTORE DRILL GREEN — synchronized repository, database%s backup restored into fresh services; the exact release image rebuilt Store 3 and exact released bytes.\n' "$([ -n "$s3_image" ] && printf ', and S3 object' || true)"
else
  printf '\nDISPOSABLE RESTORE DRILL GREEN — synchronized backup restored into fresh volumes; Store 3 rebuilt exact released bytes.\n'
fi
