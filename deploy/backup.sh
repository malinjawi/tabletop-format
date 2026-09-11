#!/usr/bin/env bash
# Produce one synchronized, validated backup of Forgejo, both PostgreSQL DBs,
# the immutable release-artifact vault, and the remote LFS object store.
# The write path is deliberately stopped because Forgejo documents that
# PostgreSQL + S3-compatible storage cannot be backed up consistently live.
set -euo pipefail

deploy_dir="$(cd "$(dirname "$0")" && pwd -P)"
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
compose=(docker compose --project-name "$project_name" --env-file "$env_file" -f "$deploy_dir/docker-compose.prod.yml")
services_stop_attempted=0
vault_snapshot_container=""
backup_lock_dir=""
backup_lock_owned=0
work_dir=""
final_dir="$destination/forge-backup-$stamp"
if [ -e "$final_dir" ]; then
  printf 'refusing to overwrite an existing completed backup: %s\n' "$final_dir" >&2
  exit 1
fi

restart_services() {
  if [ "$services_stop_attempted" = "1" ]; then
    if "${compose[@]}" up -d forgejo gateway >/dev/null; then
      services_stop_attempted=0
      return 0
    fi
    printf 'failed to restart Forgejo/gateway after the backup attempt; operator intervention is required\n' >&2
    return 1
  fi
  return 0
}
release_backup_lock() {
  if [ "$backup_lock_owned" = "1" ] && [ -n "$backup_lock_dir" ]; then
    rm -f "$backup_lock_dir/owner"
    rmdir "$backup_lock_dir" 2>/dev/null || true
    backup_lock_owned=0
  fi
}
cleanup_backup() {
  status=$?
  trap - EXIT INT TERM
  set +e
  if [ -n "$vault_snapshot_container" ]; then
    docker rm --force --volumes "$vault_snapshot_container" >/dev/null 2>&1 || true
  fi
  restart_services
  restart_status=$?
  release_backup_lock
  if [ "$status" = "0" ] && [ "$restart_status" != "0" ]; then status="$restart_status"; fi
  exit "$status"
}
trap cleanup_backup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for service in db forgejo gateway; do
  if ! "${compose[@]}" ps --status running --services | grep -qx "$service"; then
    printf 'required service is not running: %s\n' "$service" >&2
    exit 1
  fi
done
gateway_container_id="$("${compose[@]}" ps -q gateway)"
vault_volume_name="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/vault"}}{{.Name}}{{end}}{{end}}' "$gateway_container_id")"
gateway_image_id="$(docker inspect --format '{{.Image}}' "$gateway_container_id")"
if [ -z "$vault_volume_name" ] || [[ ! "$vault_volume_name" =~ ^[A-Za-z0-9_.-]+$ ]]; then
  printf 'running gateway does not have a safe named release vault mounted at /app/vault\n' >&2
  exit 1
fi
if [[ ! "$gateway_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  printf 'could not resolve the running gateway image ID\n' >&2
  exit 1
fi

# A backup owns the write outage for this deployment. Without one global,
# create-only lock, concurrent operators can restart writers underneath one
# another's database/object snapshots. The lock key does not disclose paths or
# credentials and is shared even when the two invocations choose different
# backup destinations.
backup_lock_key="$(node -e 'const c=require("crypto");process.stdout.write(c.createHash("sha256").update(process.argv[1]).digest("hex").slice(0,32))' "$vault_volume_name")"
backup_lock_dir="/tmp/forge-backup-$backup_lock_key.lock"
if ! mkdir -m 700 "$backup_lock_dir" 2>/dev/null; then
  printf 'another backup owns the write outage for Compose project %s (lock %s)\n' "$project_name" "$backup_lock_dir" >&2
  exit 1
fi
backup_lock_owned=1
printf 'pid=%s\nproject=%s\nvault=%s\n' "$$" "$project_name" "$vault_volume_name" > "$backup_lock_dir/owner"

work_dir="$(mktemp -d "$destination/.forge-backup-$stamp.XXXXXX")"

printf 'Stopping Forge writes for a synchronized backup…\n'
services_stop_attempted=1
"${compose[@]}" stop gateway forgejo >/dev/null

# Release artifacts are not a disposable cache. Snapshot the dedicated vault
# through the exact deployed gateway image after every writer has stopped. An
# anonymous helper volume avoids exposing the host backup path inside the
# application container; docker cp gives ownership back to the invoking host
# operator. The snapshotter rejects symlinks and all non-regular vault entries.
vault_snapshot_container="forge-vault-snapshot-$(node -e 'process.stdout.write(require("crypto").randomBytes(8).toString("hex"))')"
docker run --name "$vault_snapshot_container" --read-only --network none \
  --cap-drop ALL --cap-add DAC_OVERRIDE --cap-add DAC_READ_SEARCH \
  --security-opt no-new-privileges:true --user 0:0 \
  --volume "$vault_volume_name:/app/vault:ro" --volume /snapshot \
  --entrypoint node "$gateway_image_id" \
  deploy/release-vault-snapshot.mjs backup \
  --source /app/vault --output /snapshot/release-vault
docker cp "$vault_snapshot_container:/snapshot/release-vault" "$work_dir/"
docker rm --force --volumes "$vault_snapshot_container" >/dev/null
vault_snapshot_container=""
node "$deploy_dir/release-vault-snapshot.mjs" verify --input "$work_dir/release-vault"

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
  printf 'release_vault_files=%s\n' "$(node -e 'process.stdout.write(String(require(process.argv[1]).files.length))' "$work_dir/release-vault/manifest.json")"
  printf 'release_vault_bytes=%s\n' "$(node -e 'process.stdout.write(String(require(process.argv[1]).total_bytes))' "$work_dir/release-vault/manifest.json")"
  printf 'object_store_bucket=%s\n' "$r2_bucket"
  printf 'object_store_objects=%s\n' "$(node -e 'process.stdout.write(String(require(process.argv[1]).objects.length))' "$work_dir/object-store/manifest.json")"
  for service in gateway forgejo db; do
    container_id="$("${compose[@]}" ps --all -q "$service")"
    printf '%s_image=%s\n' "$service" "$(docker inspect --format '{{.Image}}' "$container_id")"
  done
} > "$work_dir/manifest.txt"

node "$deploy_dir/s3-snapshot.mjs" verify --input "$work_dir/object-store"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$work_dir" && sha256sum forgejo.zip platform.dump forgejo.dump object-store/manifest.json release-vault/manifest.json manifest.txt > SHA256SUMS)
else
  (cd "$work_dir" && shasum -a 256 forgejo.zip platform.dump forgejo.dump object-store/manifest.json release-vault/manifest.json manifest.txt > SHA256SUMS)
fi

restart_services
mv "$work_dir" "$final_dir"
release_backup_lock
trap - EXIT INT TERM
printf 'Backup complete: %s\n' "$final_dir"
printf 'Repositories, both databases, the release-artifact vault, and the LFS object bucket are captured. Copy this directory off-host, then run the restore drill.\n'
