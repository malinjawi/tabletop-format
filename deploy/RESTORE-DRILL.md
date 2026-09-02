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
- Keep the restored service private; its copied user sessions and password
  hashes are production-sensitive.

## Procedure

1. Verify `SHA256SUMS`, `unzip -t forgejo.zip`, and `pg_restore --list` for both
   database dumps before provisioning anything.
2. Create a separate environment file with new origins, invite code, database
   secrets, Forgejo service token, project name, ports, and `R2_LFS_BUCKET`.
   Create that empty bucket with credentials scoped only to it.
3. Start only the fresh PostgreSQL service. Drop/recreate its empty `platform`
   and `forgejo` databases, then restore `platform.dump` and `forgejo.dump`
   with `pg_restore --clean --if-exists --no-owner`. The independent dump is
   authoritative; do not import `forgejo-db.sql` from the ZIP.
4. Expand `forgejo.zip` in a private staging directory. Populate the fresh
   Forgejo volume using the container layout: `repos/` goes to
   `/data/git/repositories`, `data/lfs/` is copied into the isolated LFS bucket,
   and the remaining `data/` content goes under `/data/gitea`. Retain the fresh
   environment-generated `app.ini` so production origins and credentials are
   not resurrected from the archive. Ownership must be UID/GID 1000.
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
