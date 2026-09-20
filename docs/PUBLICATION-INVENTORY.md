# Publication inventory

`npm run audit:publications` is an operator check of existing publication
evidence. It opens the configured database read-only, without migrations, and
compares finalized releases, finalized and pending journals, vault bindings,
all sealed manifests and required blob hashes, original publisher accounts,
publication events, exact Git source commits and release tag objects.
It never renders replacement bytes, repairs records, deletes orphans or starts
the server. Run it as a separate operator process; whole-vault verification is
not suitable for an HTTP request handler.

## Run and interpret

Use the application's database and vault settings. SQLite additionally requires
`DB_PATH`; PostgreSQL accepts `PG_URL` or `PGHOST`/`PGPORT`/`PGDATABASE`/`PGUSER`
and the mounted platform password. A local repository needs `STORE1=local`,
`LOCAL_STORE_ROOT` and `GAMES_DIR`. Online Forgejo needs `STORE1=forgejo`,
`FORGE_URL` and the mounted service token. Online results are observations,
not synchronized snapshots; concurrent publication can temporarily disagree.

The CLI writes JSON to stdout. `--output /private/new-report.json` creates a
new file with owner-only permissions and refuses to overwrite an existing file.
Exit codes: **0** verified inventory, **1** inconsistent inventory, **2** unable
to complete the check. Keep reports private: they identify projects/releases.

| Classification | Meaning and next step |
| --- | --- |
| healthy | Finalized records, preserved bytes and repository evidence agree. |
| recoverable | A complete native seal exists before journal/tag/finalization completion. Preserve it and retry the existing publication flow with its original identity. The audit itself does not publish. |
| missing | Required evidence, account, manifest, blob, tag or database relationship is absent. Preserve the stores and investigate the synchronized backup. |
| contradictory | Evidence disagrees or preserved bytes fail verification. Stop acceptance; do not regenerate or overwrite the release to hide the disagreement. |
| unavailable | A repository/source/tag could not be verified. Restore access and rerun; this does not prove absence. |
| unreferenced | A legacy seal has no publication record from which intent can be established. Retain it for operator investigation. |

Only healthy/recoverable publications can pass. Malformed manifests, corrupt or
missing blobs and interrupted staging also fail the vault audit. Valid
unreferenced content-addressed blobs are listed in `vault.orphans` and retained;
they do not alone fail acceptance. Findings retain every detected issue even
when a higher-priority classification is displayed. This is an inventory of
Forge publications, not every arbitrary user-created Git tag or event.

## Frozen Forgejo mode

`STORE1=forgejo-offline` reads the stopped Forgejo service's existing PostgreSQL
repository identities and protected-tag rules, then reads bare Git objects
directly from `FORGE_GIT_ROOT`. Set `FORGEJO_PG_URL`, or
`FORGEJO_PGHOST`/`FORGEJO_PGPORT`/`FORGEJO_PGDATABASE`/`FORGEJO_PGUSER` plus
`FORGEJO_PGPASSWORD` or `/run/secrets/forge_db_password`. No network Git fetch,
checkout, migration or repository visibility change is performed.

The adapter is qualified with the pinned **Forgejo 15.0.7** schema and requires
indexed physical repository IDs. Resolve older/missing identity bindings
through the normal supported reindex process before scheduling the outage.
It follows a renamed repository by physical ID and refuses symlinked/escaping
repository directories. An upgrade requires renewed schema and restore proof.

## Backup and restore

`deploy/backup.sh` stops both writers, runs the frozen audit through the running
gateway's exact image, and only then snapshots the stores. The checked backup
includes `publication-inventory.json` in `SHA256SUMS`. A failed audit prevents
backup acceptance; the cleanup path still attempts to restart the services.

Follow [the restore procedure](../deploy/RESTORE-DRILL.md) to rerun this check
against restored stores before starting either writer. A backup's saved report
does not replace a new restored-state check. The disposable exact-image drill
requires every completed journey publication to be healthy and compares the
before/after publication inventory, then downloads every frozen artifact with
an empty render cache. Image CI evidence is still required for each candidate.

`tools/test-publication-inventory.mjs` exercises SQLite and a unique temporary
schema in an explicitly disposable PostgreSQL database. `store2-pg-test.sh`
runs both, requiring schema creation permission on a caller-supplied dedicated
test database. The offline filesystem test uses real annotated Git tags; the
image restore drill covers real Forgejo PostgreSQL tables and volumes.
