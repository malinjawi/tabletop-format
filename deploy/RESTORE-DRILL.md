# Durable-store restore drill

Run this before the first outside invite and after every Forgejo major upgrade.
The drill is successful only when repository truth, platform conversation and
permission state, and at least one LFS-backed release all work together.

## Isolation rules

- Use a disposable Compose project name, fresh PostgreSQL/Forgejo/release-vault
  volumes, unused loopback ports, and a separate empty R2 bucket.
- Use the exact image IDs recorded in `manifest.txt` for the first restore.
- Never point the drill at the production databases, volumes, Forgejo origin,
  or LFS bucket. Never reuse the production platform service token.
- Restore copies of `forgejo-secret-key`, `forgejo-internal-token`,
  `forgejo-oauth2-jwt-secret`, and `lfs-jwt-secret` from the encrypted secret
  backup. These are installation identity, not disposable credentials. Do not
  rotate them as part of the drill.
- Keep the public release/download origin under operational control. TTS and
  VTT packages embed it; the release vault preserves their exact published
  bytes, but abandoning that DNS name would still strand links inside already-
  downloaded play packages.
- Keep the restored service private; its copied user sessions and password
  hashes are production-sensitive.

## Procedure

1. Verify `SHA256SUMS`, `node deploy/s3-snapshot.mjs verify --input
   <backup>/object-store`, `node deploy/release-vault-snapshot.mjs verify
   --input <backup>/release-vault`, `unzip -t forgejo.zip`, and `pg_restore
   --list` for both database dumps before provisioning anything.
2. Create a separate environment file with new origins, the database-backed
   invitation mode, database passwords, Forgejo service token, project name,
   ports, and `R2_LFS_BUCKET`.
   Copy the four recovery-critical Forgejo secrets listed above into the
   drill's isolated secret directory. Create the empty bucket with credentials
   scoped only to it. Restore `object-store/` into that bucket with
   `node deploy/s3-snapshot.mjs restore`, using the drill credential files and
   `--create-bucket` only when the S3 provider supports bucket creation. The
   command refuses a non-empty target and re-reads every restored object.
   Give this disposable environment its own explicit external vault name and
   create that empty volume before starting the gateway. Restore through the
   exact recorded gateway image with a networkless root helper. The helper has
   only the filesystem capabilities needed to read an owner-only backup,
   populate the empty volume, and hand it to the UID/GID 1000 gateway:

   ```sh
   backup_dir=/absolute/path/to/forge-backup-YYYYMMDDTHHMMSSZ
   set -a
   . ./.env
   set +a
   docker volume create "$FORGE_RELEASE_VAULT_VOLUME"
   docker run --rm --read-only --network none --user 0:0 \
     --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add DAC_READ_SEARCH \
     --security-opt no-new-privileges:true \
     --volume "$FORGE_RELEASE_VAULT_VOLUME:/app/vault" \
     --volume "$backup_dir/release-vault:/restore/release-vault:ro" \
     --entrypoint /bin/sh "$FORGE_GATEWAY_IMAGE" -ec '
       node deploy/release-vault-snapshot.mjs restore \
         --input /restore/release-vault --output /app/vault
       chown -R 1000:1000 /app/vault
     '
   ```

   The restore command refuses any non-empty destination, re-hashes the complete
   tree, and performs a semantic vault audit before ownership changes. Never
   reuse the production `FORGE_RELEASE_VAULT_VOLUME` in a drill and never point
   this helper at the production vault.
3. Start only the fresh PostgreSQL service. Drop/recreate its empty `platform`
   and `forgejo` databases, then restore `platform.dump` and `forgejo.dump`
   with `pg_restore --clean --if-exists --no-owner`. The independent dump is
   authoritative; do not import `forgejo-db.sql` from the ZIP.
4. Expand `forgejo.zip` in a private staging directory. Populate the fresh
   Forgejo volume using the container layout: `repos/` goes to
   `/data/git/repositories`, while the remaining `data/` content goes under
   `/data/gitea`. The independently restored object-store snapshot—not any
   incidental `data/lfs/` directory in the ZIP—is authoritative for production
   LFS. Do not restore
   `data/conf/app.ini`; the drill Compose file rebuilds configuration for the
   drill origins and databases while pointing at restored copies of the same
   encryption/signing secret files. Ownership must be UID/GID 1000. Pre-create
   `/data/git/.ssh`, `/data/gitea/conf`, `/data/gitea/log`, and `/data/ssh` as
   UID/GID 1000 (`.ssh` mode `0700`); otherwise the container entrypoint may see
   the restored parent ownership, skip its recursive repair, and then create
   root-owned runtime directories that Forgejo cannot use.
5. Start Forgejo with the recorded image. Run
   `forgejo doctor check --all --log-file /tmp/doctor.log`, create a new scoped
   platform token, place it in the drill secret file, then start the gateway.
6. Run `node tools/alpha-readiness.mjs <drill-origin> --production`, sign in as
   a copied pilot account, and execute the disposable two-person journey.
7. Verify one known project has the expected HEAD SHA and attribution, one
   discussion/review and role assignment exist, and an LFS-backed art asset can
   be fetched. Download an existing release's exact PnP plus portable-project
   artifact from the restored release vault and compare both with their frozen
   receipt. Then clear only Store 3 and repeat the downloads to prove the vault,
   rather than a surviving cache file, supplied the published bytes.
8. Record date, backup ID, image IDs, checks, elapsed recovery time, and any
   manual intervention. Destroy only the explicitly named disposable project,
   volumes, credentials, and drill bucket after the evidence is retained.

Any missing repository, permission/review record, LFS object, vault object, or
byte-exact release is a failed restore and a stop condition for pilot invitations.
