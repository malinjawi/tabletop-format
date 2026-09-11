# Controlled-beta deployment

Forge launches behind HTTPS as three digest-pinned services: the immutable
gateway image, Forgejo (repository truth), and Postgres (identity/conversation
state). R2 holds LFS objects. A dedicated `release-vault-data` filesystem volume
holds exact published artifact bytes outside the regenerable Store-3 cache. The
volume is pre-created and external to the Compose project, so even
`docker compose down -v` cannot remove it. Only an explicit Docker-volume
deletion can destroy it; never do that without a verified off-host backup.
The host proxy is the only public ingress;
Compose binds the gateway to loopback by default and does not expose Postgres.
Forgejo is configured to force every new repository private. Forge promotes
source visibility only after its rights index authorizes the public project;
an unverified or identity-conflicting repository remains private.

## 1. Build and promote the gateway

Resolve and record a Node base-image digest, then build from the clean release
commit. The build context excludes games, exports, local data and secrets.
The currently recovery-qualified multi-platform dependencies live in
`deploy/qualified-images.env`; changing any of them is a qualification change,
not routine deployment configuration.

```sh
release_commit=$(git rev-parse HEAD)
docker build \
  --build-arg NODE_IMAGE='node:24-bookworm-slim@sha256:<verified-digest>' \
  --build-arg FORGE_SOURCE_REVISION="$release_commit" \
  -f Dockerfile.prod -t registry.example/forge/platform:<release> .
docker push registry.example/forge/platform:<release>
docker buildx imagetools inspect registry.example/forge/platform:<release>
```

The same build-and-recovery proof runs in CI for every pull request and push to
`main`. Reproduce it locally before proposing a dependency or deployment change:

```sh
npm ci
FORGE_REQUIRE_CLEAN_TREE=1 npm run test:production-image
```

On a push to `main`, the tracked qualification workflow preserves the exact
image used by the recovery gate. Manual dispatches qualify but never publish.
Only after both qualification jobs succeed, a separate job publishes those
same image bytes to:

```text
ghcr.io/<repository-owner>/forge-platform:sha-<full-40-character-commit>
```

The publisher has only `packages: write`; the qualification jobs retain only
`contents: read`. It runs only for a push to `main`, creates no `latest`,
branch, or release tag, and refuses to overwrite an existing commit tag unless
that tag resolves to the exact same qualified image and revision. A safe rerun
therefore reuses the existing digest and repairs the workflow receipt. The job
records the resulting `@sha256:...` reference in its summary. Deploy using that
digest reference, not the tag. Registry administrators can still delete or
retag packages outside this workflow, so retain the workflow receipt and apply
organization retention controls where available. Image promotion does not
deploy a host, alter DNS, configure R2, or establish operator readiness.

GHCR package visibility is separate from repository visibility. Before booting
the host, either make this one container package public or configure a
read-only package credential on the host. Prove that the deployment identity
can pull the recorded digest directly; do not rely on an operator's interactive
registry session or change Forge source-repository visibility as a workaround.

Put the resulting `registry/...@sha256:...` reference in
`FORGE_GATEWAY_IMAGE`. Put tested digest references—not floating majors—in
`FORGEJO_IMAGE` and `POSTGRES_IMAGE`. A Forgejo major upgrade is a separate,
backup-tested migration; it is not bundled into an application deploy.
The current recovery profile is qualified on Forgejo 15.x and PostgreSQL 16.x;
`FORGEJO_VERSION` and `POSTGRES_MAJOR` make that compatibility decision explicit
and the host preflight verifies both values against the selected image metadata.
The gateway build fails unless it receives a source revision and stores that
commit in the standard OCI revision label. Build only from a clean commit; the
registry digest and revision label together identify the exact shipped source.
The image includes Chromium because card faces and designed rulebooks are
rendered from the same HTML/CSS engine used by the browser UI; an image that can
serve the API but cannot regenerate those assets is not a valid release image.
Before promotion, pass the built image's immutable local image ID (or registry
digest) as `FORGE_GATEWAY_TEST_IMAGE` to the strict launch gate. The recovery
drill rejects an image whose OCI revision is not the candidate `HEAD`, boots it
read-only against restored Forgejo/PostgreSQL stores, and verifies that it can
serve and verify every frozen release artifact from the independently restored
release vault while the disposable render cache remains empty. Set
`REQUIRE_GATEWAY_IMAGE_DRILL=1` to make that evidence mandatory.

## 2. Create configuration and secrets

The recommended path creates a new configuration and all ten protected secret
files without putting credential values on the command line or in terminal
output. Supply R2 credentials as existing owner-readable files. The command
defaults Forgejo and PostgreSQL to the recovery-qualified digests, generates
their database and installation secrets, copies the R2 values with mode `0600`,
and deliberately leaves only the first-boot Forge token empty. It refuses to
overwrite either target:

```sh
node deploy/bootstrap.mjs \
  --forge-origin https://forge.example \
  --git-origin https://git.forge.example \
  --operator "Named accountable operator" \
  --contact support@example.com \
  --gateway-image registry.example/forge/platform@sha256:<promoted-digest> \
  --r2-account-id <32-hex-account-id> \
  --r2-bucket forge-lfs \
  --r2-access-key-file /secure/input/r2-access-key \
  --r2-secret-key-file /secure/input/r2-secret-key \
  --release-vault-volume forge-release-vault-production \
  --backup-destination /encrypted/off-host/forge-backups

set -a
. deploy/.env
set +a
docker volume create "$FORGE_RELEASE_VAULT_VOLUME"
node deploy/preflight.mjs --env deploy/.env --first-boot
```

The generated `.env` is safe to load with the shell commands in this runbook.
Inspect it before first boot; it contains public configuration and image
references, never secret values. The expanded commands below document the same
process for recovery and manual audit.

The normal automated test uses non-sensitive temporary values. Before changing
the qualified Forgejo image, exercise its real secret CLI in an isolated,
networkless, read-only container:

```sh
node tools/test-deploy-bootstrap.mjs --real-forgejo
```

```sh
cd deploy
cp .env.example .env
mkdir -m 700 .secrets
for name in pg-super-password forge-db-password platform-db-password; do
  openssl rand -base64 32 > ".secrets/$name"
  chmod 600 ".secrets/$name"
done

set -a
. ./.env
set +a
for pair in \
  forgejo-secret-key:SECRET_KEY \
  forgejo-internal-token:INTERNAL_TOKEN \
  forgejo-oauth2-jwt-secret:JWT_SECRET \
  lfs-jwt-secret:LFS_JWT_SECRET; do
  file="${pair%%:*}"
  kind="${pair#*:}"
  docker run --rm --entrypoint forgejo "$FORGEJO_IMAGE" generate secret "$kind" > ".secrets/$file"
  chmod 600 ".secrets/$file"
done
```

The secret command names above are the supported Forgejo CLI surface; do not
substitute generic random strings for installation keys without checking the
running major version's [Forgejo CLI documentation](https://forgejo.org/docs/latest/admin/command-line/).

Create `.secrets/r2-access-key` and `.secrets/r2-secret-key` from a credential
limited to the Forge LFS bucket. Create an empty `.secrets/forge-token` for the
first boot. Fill `.env`, including the exact HTTPS origins and the
`database` invitation backend. Forge stores only invitation-token digests in
PostgreSQL; there is no reusable cohort code in `.env`. Neither `.env` nor
`.secrets/` is tracked by Git.
`FORGE_SECRET_DIR` may be an absolute path when secrets are mounted from an
encrypted host volume; relative paths resolve from `deploy/`, exactly as Compose
does.

Pre-create the release vault named in `.env` exactly once. Compose treats it as
external and will refuse to invent or delete it:

```sh
set -a
. ./.env
set +a
docker volume create "$FORGE_RELEASE_VAULT_VOLUME"
```

## 3. First boot and scoped Forgejo service account

Start Postgres and Forgejo first:

```sh
docker compose -f docker-compose.prod.yml up -d db forgejo
docker compose -f docker-compose.prod.yml exec -u 1000 forgejo \
  forgejo admin user create --admin --username forge-platform-bootstrap \
  --email admin@example.invalid --random-password
```

Use that one-time bootstrap account to create a dedicated platform service
account/token with only the repository/user scopes the tested Store-1 adapter
needs. Save the token (and only the token) in `.secrets/forge-token`, remove or
demote the bootstrap account, then start the gateway:

```sh
chmod 600 .secrets/forge-token
docker compose -f docker-compose.prod.yml up -d
```

After the gateway is healthy, issue one invitation per intended participant:

```sh
docker compose -f docker-compose.prod.yml exec gateway \
  node tools/pilot-invite.mjs create --label "Amina" --cohort beta-01 --hours 168
docker compose -f docker-compose.prod.yml exec gateway \
  node tools/pilot-invite.mjs list
docker compose -f docker-compose.prod.yml exec gateway \
  node tools/pilot-invite.mjs revoke inv_0123456789abcdef
```

The create command prints a high-entropy bearer token exactly once. Deliver it
only to that participant. `list` shows available, redeemed, expired, and
revoked records without exposing either the token or its digest. Invitations
expire after seven days by default, can be shortened with `--hours`, and can
never be replayed. Finalize `FORGE_OPERATOR_NAME` and `FORGE_CONTACT_EMAIL`
before issuing invitations: those values are rendered into the policy text and
therefore change its exact policy-set identifier.

Registration shows direct links to the Terms, Community Rules, and Privacy
Notice beside an unchecked control. The account button remains disabled until
the participant affirmatively accepts the current set. The server rejects a
missing or stale policy set, and writes the invitation redemption, account, and
acceptance in one transaction. Each receipt retains the exact rendered text,
four content hashes, visible notice, server timestamp, account, and gateway
build; `/api/me` returns its identifiers and hashes to that participant. A
failed acceptance leaves the invitation available. These receipts are included
in the normal PostgreSQL backup and verified by the restore drill. They are
operational evidence, not a substitute for jurisdiction-specific legal review.

### Project-kind transitions

`forge/project.json` declares whether a project is owned or an explicit public
sandbox. After a hosted repository receives a stable Forgejo repository ID,
Forge treats that project kind as immutable: editing repository content cannot
silently expand its write or merge authority. The controlled beta deliberately
has no in-place sandbox toggle. To retire a sandbox or move work into normal
ownership, create an owned project, carry the work through the ordinary
fork/proposal review path, verify its rights, and archive the old sandbox. To
create a new sandbox, use an operator-reviewed import with a new project and
repository identity. Record either transition in the pilot operations log.

After registration, verify the receipt without opening PostgreSQL or printing
the participant's email or any policy body:

```sh
docker compose -f docker-compose.prod.yml exec gateway \
  node tools/pilot-account.mjs policy --handle amina --require-current
```

`verified-current` means the receipt is internally intact and matches the
policy text rendered from this gateway's current operator/contact settings.
Without `--require-current`, an intact older receipt is reported as
`verified-prior`; that is useful for audit history but is not sufficient for a
cohort that requires the current terms. A corrupt snapshot or a missing current
receipt exits nonzero.

## Participant data access and privacy requests

A signed-in participant can choose **Download my data** from the account menu.
`GET /api/me/export` returns a `no-store` JSON attachment built from an explicit
field allowlist: account and policy evidence, authored discussion/review
activity, social state, connector metadata, and operator access events. It
contains no password hash, session/invitation/recovery token or digest, PR
repository snapshot, generated artifact body, release rights manifest, or
build receipt. The production restore drill verifies that this export survives
recovery with those exclusions intact.

The export points participants to the separate Forge project package for their
portable game source. Requests for retained security logs, correction,
deletion, or an export when login is unavailable go to `FORGE_CONTACT_EMAIL`.
Authenticate the requester through the agreed pilot channel, issue account
recovery when appropriate, and preserve authorship required by shared Git
history. Do not perform direct row deletion: document what can be corrected,
removed, anonymized, or de-indexed and obtain jurisdiction-specific advice for
the real operator before public registration or paid service.

If a participant loses access, issue a short-lived recovery token instead of
editing the database or setting a password for them:

```sh
docker compose -f docker-compose.prod.yml exec gateway \
  node tools/pilot-account.mjs reset --handle amina --hours 1
docker compose -f docker-compose.prod.yml exec gateway \
  node tools/pilot-account.mjs resets
docker compose -f docker-compose.prod.yml exec gateway \
  node tools/pilot-account.mjs revoke rst_0123456789abcdef
```

Send the one-use token to the named participant through the agreed pilot
channel. They choose their own new password from **Sign in → Reset password**.
Redemption revokes every existing session; issuing another token automatically
revokes any older outstanding token. The database and audit listing retain
only the digest, reset ID, account, timestamps, and status.

Suspend access without deleting the participant or their authored history:

```sh
docker compose -f docker-compose.prod.yml exec gateway \
  node tools/pilot-account.mjs suspend --handle amina \
    --reason "participant requested access pause"
docker compose -f docker-compose.prod.yml exec gateway \
  node tools/pilot-account.mjs status --handle amina
docker compose -f docker-compose.prod.yml exec gateway \
  node tools/pilot-account.mjs restore --handle amina \
    --reason "participant confirmed return"
```

The production container supplies the declared `FORGE_OPERATOR_NAME`; direct
development use must pass `--operator`. Suspension atomically revokes every
session and outstanding recovery token, blocks login with the same generic
credential error, and writes an immutable operator/reason event. Restoration
does not invent a password or session—the participant signs in normally.
Never put private complaint details in `--reason`; use a short operational
description and keep sensitive case notes in the operator's protected system.

Do not put a Forgejo admin password in the gateway environment. Rotate the
service token by updating the secret file and recreating only the gateway.
Forge uses that same token for LFS: it resolves the token owner through
Forgejo's authenticated `/user` API, then sends the username and token with
HTTP Basic authentication. No account password or second identity setting is
needed. Forgejo is configured with `LFS_SERVE_DIRECT=false`, so LFS action URLs
remain Forgejo-proxied; the gateway routes those actions over the private
`http://forgejo:3000` network path instead of depending on public-DNS hairpinning.

## 4. Preflight the actual host and TLS edge

Install Caddy on the host, copy `Caddyfile.example` to its configuration, and
load the values from `.env`. Caddy is the only public process; Compose keeps
Forge and Forgejo on loopback. Before first boot, the service token may be the
documented empty file:

```sh
node deploy/preflight.mjs --env deploy/.env --first-boot
```

After the scoped Forgejo token exists and DNS is live, run the online preflight.
It verifies DNS/TLS and HSTS, both service health endpoints, versioned preview
assets through the public Forge address, and a signed, read-only list request
to the configured R2 bucket. Select an existing public game with artwork using
`--preview-game <storage-slug>`; otherwise the first catalog game is used.
The asset check samples up to 32 URLs emitted by that game's actual preview,
including available image/font formats. Missing assets, redirects, HTML error
pages, unresolved LFS pointers, and unpinned versions fail the preflight. This
checks the deployed proxy and permissions as an anonymous visitor; it does not
enable private fixtures. Keep its evidence beside the restore-drill record,
not in Git:

```sh
node deploy/preflight.mjs --env deploy/.env --online \
  --preview-game ember \
  --evidence /encrypted/off-host/evidence/forge-preflight-$(date -u +%Y%m%dT%H%M%SZ).json
```

Caddy expands `{$NAME}` variables before parsing and automatically supplies the
forwarded host/protocol headers used here; see the official
[Caddyfile environment-variable](https://caddyserver.com/docs/caddyfile-tutorial#environment-variables)
and [reverse-proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
documentation. The R2 check uses its documented S3 endpoint, `auto` region, and
`ListObjectsV2` support from the [R2 S3 compatibility reference](https://developers.cloudflare.com/r2/api/s3/api/).

## 5. Edge contract

Terminate TLS at the host proxy/CDN and forward the Forge origin to
`127.0.0.1:8420` and the Git/Forgejo origin to
`127.0.0.1:${FORGEJO_BIND_PORT:-3000}`. Preserve
the real client address and set `FORGE_TRUST_PROXY=1` only for that trusted
proxy path. Forward the original `Host` and `X-Forwarded-Proto`. Do not cache
API or HTML responses. Forge's `/cache/*` paths are content-addressed, but a
project can still move from public to private. Honor Forge's response policy:
public artifacts currently require revalidation and private artifacts are
`private, no-store`. Never override those headers at the CDN.

Both application ports bind to loopback; TLS is the only public ingress. The
application refuses production startup with HTTP, local Store-1, missing
Forge credentials, or open registration. Browser sessions are HttpOnly,
Secure, SameSite cookies; connector sessions remain revocable bearer tokens.

## 6. Release gate

Run the single release gate against the exact release commit before deploying:

```sh
npm ci
FORGE_REQUIRE_CLEAN_TREE=1 \
FORGE_CONFORMANCE_PG_URL='postgres://…/forge_conformance' \
FORGEJO_TEST_IMAGE='codeberg.org/forgejo/forgejo@sha256:<tested-digest>' \
REQUIRE_PRODUCTION_BACKENDS=1 \
./launch-gate.sh
```

On the actual host, make the same gate require the offline deployment preflight
(or add `FORGE_DEPLOY_ONLINE=1` after DNS/TLS is live, and
`FORGE_DEPLOY_PREVIEW_GAME=<storage-slug>` to select the public smoke-test game):

```sh
FORGE_DEPLOY_ENV=deploy/.env \
REQUIRE_DEPLOY_PREFLIGHT=1 \
./launch-gate.sh
```

The protected product gate also opens public and explicitly enabled local
fixture card previews in Chromium and checks that rendered images and fonts
decode. The online host preflight is a separate required proof before pilot
approval, so a green health endpoint alone cannot qualify the public preview.

The digest-pinned helper is the safe default: it creates a fresh Forgejo
container and volume, runs the journey, and removes them. To test an already
deployed isolated Forgejo instead, set `FORGE_LIVE_URL`,
`FORGE_LIVE_ADMIN_USER`, and `FORGE_LIVE_ADMIN_PASS`; that journey purges its
exact fixture users. Never point conformance at a database or Forgejo server
that contains user work.
For a repeatable local proof against the actual Forgejo image before registry
promotion, run:

```sh
FORGEJO_TEST_IMAGE='codeberg.org/forgejo/forgejo@sha256:<tested-digest>' \
  npm run test:forgejo:disposable
```

That helper creates and later removes only its uniquely named disposable
container and volume. It refuses floating image tags.

After deployment verify `/healthz`, a login/logout cycle, a private-project
404 while signed out, a Sheet dry run and commit, a PR approval/merge, and one
release with PnP/TTS/TTC/project receipts.

Start with the read-only probe (it creates no accounts or content):

```sh
FORGE_SMOKE_EXPECT_PROJECTS='community/cards-against-humanity,community/secret-hitler' \
  node tools/alpha-readiness.mjs https://forge.example --production
```

Then run the mutating two-person path with disposable pilot accounts. Use the
cohort protocol and success/stop thresholds in
[`../docs/CONTROLLED-ALPHA-PILOT.md`](../docs/CONTROLLED-ALPHA-PILOT.md).
The first cohort is exactly five people; its evidence remains outside Git and
is evaluated with `npm run pilot:report -- /path/to/cohort.json`. The evaluator
opens both `preflight_evidence` and the Sheets `package_receipt`, verifies their
green checks and file hashes, and binds their commit, origin, and image digests
to the candidate in the cohort record. Keep those files available beside the
private record; manually setting the result fields cannot substitute evidence
from the exact deployed candidate.

## 7. Backup and restore drill

Forgejo's supported consistency model for PostgreSQL plus S3-compatible object
storage requires a short write outage. Do not take separate live copies of the
durable stores and call them one backup. Announce a maintenance window, then run:

```sh
cd deploy
set -a
. ./.env
set +a
FORGE_BACKUP_ACK_DOWNTIME=1 ./backup.sh "$FORGE_BACKUP_DESTINATION"
```

The script takes a fail-closed lock for the Compose project, then stops the
gateway and Forgejo, semantically audits and snapshots every regular file
in the dedicated release-artifact vault, snapshots every object in the dedicated
R2 LFS bucket, creates a Forgejo repository archive, makes independent
custom-format dumps of both PostgreSQL databases, and validates every layer.
Vault symlinks and non-regular files fail the backup. It records object/file
hashes and exact image IDs, then attempts to restart the services even if backup
fails and reports a restart failure for operator intervention. A second backup
cannot begin while the first owns the write outage. If the process is killed in
a way that bypasses traps, inspect the exact lock path and recorded PID printed
by the next attempt; remove that one lock only after proving the process is gone.
Copy the completed directory to encrypted storage away from the host.

Current qualification boundary: these checks validate each durable store, but
do not yet reconcile every finalized and interrupted Store-2 publication against
the complete vault inventory in one report. Keep public deployment blocked until
that all-release reconciliation is automated and passes on both backup and
restore. The recovery-critical Forgejo keys listed in `RESTORE-DRILL.md` also
remain a separately protected encrypted backup input; the backup script does not
copy secret values into its artifact.

Do not treat `forgejo dump` as a backup of remote object storage. Forgejo's
[official backup guidance](https://forgejo.org/docs/latest/admin/upgrade/#backup)
requires a synchronized point-in-time copy of every configured storage backend,
and its [storage reference](https://forgejo.org/docs/latest/admin/setup/storage/)
defines LFS as a distinct S3-backed subsystem. R2 does not provide Forge with an
automatic object-versioning safety net, so `object-store/` in this backup is the
recoverable LFS copy; bucket-scoped credentials and an R2 bucket lock reduce
accidental deletion risk but are not a backup. Follow
[`RESTORE-DRILL.md`](RESTORE-DRILL.md) to restore into a separate project,
database volumes, ports, LFS bucket, and empty release-vault volume. Store-3
render/export cache, the Forgejo checkout farm, and the generated hub are derived
and deliberately excluded. Unlike Store 3, `release-vault/` is recovery-critical:
it contains published bytes that must remain available even when their historical
exporter is no longer present.

## 8. Operational stop conditions

Pause invitations if any of these occur: restore drill fails, private content
is readable signed out, release receipts do not reproduce, export workers
exceed quotas, the Sheets connector promotes a candidate that was not the one
reviewed, or moderation/takedown contact is unavailable. The controlled beta
is a learning launch, not permission to weaken those boundaries.
