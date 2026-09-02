#!/usr/bin/env bash
# Produce one synchronized, validated backup of Forgejo + both PostgreSQL DBs.
# The write path is deliberately stopped because Forgejo documents that
# PostgreSQL + S3-compatible storage cannot be backed up consistently live.
set -euo pipefail

deploy_dir="$(cd "$(dirname "$0")" && pwd)"
destination="${1:-}"
env_file="${FORGE_ENV_FILE:-$deploy_dir/.env}"
project_name="${FORGE_COMPOSE_PROJECT:-forge}"

if [ -z "$destination" ]; then
  printf 'usage: FORGE_BACKUP_ACK_DOWNTIME=1 %s /absolute/backup-parent\n' "$0" >&2
  exit 2
fi
if [ "${FORGE_BACKUP_ACK_DOWNTIME:-0}" != "1" ]; then
  printf 'refusing to stop writes without FORGE_BACKUP_ACK_DOWNTIME=1\n' >&2
  exit 2
fi
if [ ! -f "$env_file" ]; then
  printf 'missing deployment environment: %s\n' "$env_file" >&2
  exit 2
fi
env_value() {
  node -e '
    const fs=require("fs"), path=process.argv[1], wanted=process.argv[2];
    let found=null;
    for(const raw of fs.readFileSync(path,"utf8").split(/\r?\n/)){
      const match=raw.trim().match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      if(!match||match[1]!==wanted)continue;
      let value=match[2].trim();
      if((value.startsWith("\"")&&value.endsWith("\""))||(value.startsWith("\x27")&&value.endsWith("\x27")))value=value.slice(1,-1);
      found=value;
    }
    if(found===null)process.exit(2);
    process.stdout.write(found);
  ' "$env_file" "$1"
}
r2_account_id="${R2_ACCOUNT_ID:-$(env_value R2_ACCOUNT_ID)}"
r2_bucket="${R2_LFS_BUCKET:-$(env_value R2_LFS_BUCKET)}"
secret_setting="${FORGE_SECRET_DIR:-$(env_value FORGE_SECRET_DIR)}"
case "$secret_setting" in
  /*) secret_dir="$secret_setting" ;;
  *) secret_dir="$deploy_dir/$secret_setting" ;;
esac
for secret in r2-access-key r2-secret-key; do
  [ -f "$secret_dir/$secret" ] || { printf 'missing object-store credential file: %s\n' "$secret_dir/$secret" >&2; exit 2; }
done
mkdir -p "$destination"
destination="$(cd "$destination" && pwd)"
case "$destination" in
  /|/Users|/home|/var) printf 'backup parent is too broad: %s\n' "$destination" >&2; exit 2 ;;
esac

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work_dir="$(mktemp -d "$destination/.forge-backup-$stamp.XXXXXX")"
final_dir="$destination/forge-backup-$stamp"
compose=(docker compose --project-name "$project_name" --env-file "$env_file" -f "$deploy_dir/docker-compose.prod.yml")
services_stopped=0

restart_services() {
  if [ "$services_stopped" = "1" ]; then
    "${compose[@]}" up -d forgejo gateway >/dev/null
  fi
}
trap restart_services EXIT INT TERM

for service in db forgejo gateway; do
  if ! "${compose[@]}" ps --status running --services | grep -qx "$service"; then
    printf 'required service is not running: %s\n' "$service" >&2
    exit 1
  fi
done

printf 'Stopping Forge writes for a synchronized backup…\n'
"${compose[@]}" stop gateway forgejo >/dev/null
services_stopped=1

# Forgejo's dump cannot be treated as a snapshot of remote S3/R2 state. With
# all writers stopped, independently copy every object from the dedicated LFS
# bucket into a checked, key-safe local snapshot.
node "$deploy_dir/s3-snapshot.mjs" backup \
  --endpoint "https://$r2_account_id.r2.cloudflarestorage.com" \
  --bucket "$r2_bucket" --region auto \
  --access-key-file "$secret_dir/r2-access-key" \
  --secret-key-file "$secret_dir/r2-secret-key" \
  --output "$work_dir/object-store"

# `forgejo dump` captures repository/application files and may include local LFS
# material. The independent object-store snapshot above is authoritative for
# production LFS. Quiet stdout is the ZIP byte stream; diagnostics remain on
# stderr.
"${compose[@]}" run --rm --no-deps -T -u 1000 forgejo \
  forgejo dump --file - --type zip --database postgres --skip-log --quiet \
  > "$work_dir/forgejo.zip"
"${compose[@]}" exec -T db pg_dump -U postgres -Fc platform > "$work_dir/platform.dump"
"${compose[@]}" exec -T db pg_dump -U postgres -Fc forgejo > "$work_dir/forgejo.dump"

unzip -tqq "$work_dir/forgejo.zip"
"${compose[@]}" exec -T db pg_restore --list < "$work_dir/platform.dump" >/dev/null
"${compose[@]}" exec -T db pg_restore --list < "$work_dir/forgejo.dump" >/dev/null

{
  printf 'created_utc=%s\n' "$stamp"
  printf 'compose_project=%s\n' "$project_name"
  printf 'source_commit=%s\n' "$(git -C "$deploy_dir/.." rev-parse HEAD 2>/dev/null || printf unknown)"
  printf 'object_store_bucket=%s\n' "$r2_bucket"
  printf 'object_store_objects=%s\n' "$(node -e 'process.stdout.write(String(require(process.argv[1]).objects.length))' "$work_dir/object-store/manifest.json")"
  for service in gateway forgejo db; do
    container_id="$("${compose[@]}" ps --all -q "$service")"
    printf '%s_image=%s\n' "$service" "$(docker inspect --format '{{.Image}}' "$container_id")"
  done
} > "$work_dir/manifest.txt"

node "$deploy_dir/s3-snapshot.mjs" verify --input "$work_dir/object-store"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$work_dir" && sha256sum forgejo.zip platform.dump forgejo.dump object-store/manifest.json manifest.txt > SHA256SUMS)
else
  (cd "$work_dir" && shasum -a 256 forgejo.zip platform.dump forgejo.dump object-store/manifest.json manifest.txt > SHA256SUMS)
fi

restart_services
services_stopped=0
trap - EXIT INT TERM
mv "$work_dir" "$final_dir"
printf 'Backup complete: %s\n' "$final_dir"
printf 'Repositories, both databases, and the LFS object bucket are captured. Copy this directory off-host, then run the restore drill.\n'
