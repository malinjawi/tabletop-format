# Three-store restore drill

Run this before the first outside invite and after every Forgejo major upgrade.
The drill is successful only when repository truth, platform conversation and
permission state, and at least one LFS-backed release all work together.

## Isolation rules

- Use a disposable Compose project name, fresh PostgreSQL/Forgejo volumes,
  unused loopback ports, and a separate empty R2 bucket.
- Use the exact image IDs recorded in `manifest.txt` for the first restore.
- Never point the drill at the production databases, volumes, Forgejo origin,
  or LFS bucket. Never reuse the production platform service token.
- Restore copies of `forgejo-secret-key`, `forgejo-internal-token`,
  `forgejo-oauth2-jwt-secret`, and `lfs-jwt-secret` from the encrypted secret
  backup. These are installation identity, not disposable credentials. Do not
  rotate them as part of the drill.
- Keep the public release/download origin under operational control. TTS and
  VTT packages embed it; Forge persists the release origin and build identity
  so regeneration can remain byte-exact, but abandoning that DNS name would
  still strand links inside already-downloaded play packages.
- Keep the restored service private; its copied user sessions and password
  hashes are production-sensitive.

## Procedure

1. Verify `SHA256SUMS`, `node deploy/s3-snapshot.mjs verify --input
   <backup>/object-store`, `unzip -t forgejo.zip`, and `pg_restore --list` for
   both database dumps before provisioning anything.
2. Create a separate environment file with new origins, the database-backed
   invitation mode, database passwords, Forgejo service token, project name,
   ports, and `R2_LFS_BUCKET`.
   Copy the four recovery-critical Forgejo secrets listed above into the
   drill's isolated secret directory. Create the empty bucket with credentials
   scoped only to it. Restore `object-store/` into that bucket with
   `node deploy/s3-snapshot.mjs restore`, using the drill credential files and
   `--create-bucket` only when the S3 provider supports bucket creation. The
   command refuses a non-empty target and re-reads every restored object.
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
   be fetched. Reproduce an existing release receipt and download its exact PnP
   plus portable-project artifact.
8. Record date, backup ID, image IDs, checks, elapsed recovery time, and any
   manual intervention. Destroy only the explicitly named disposable project,
   volumes, credentials, and drill bucket after the evidence is retained.

Any missing repository, permission/review record, object, or reproducible
release is a failed restore and a stop condition for pilot invitations.
