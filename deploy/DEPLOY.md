# Controlled-alpha deployment

Forge launches behind HTTPS as three digest-pinned services: the immutable
gateway image, Forgejo (repository truth), and Postgres (identity/conversation
state). R2 holds LFS objects. The host proxy is the only public ingress;
Compose binds the gateway to loopback by default and does not expose Postgres.

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
regenerate every frozen release artifact from an empty cache. Set
`REQUIRE_GATEWAY_IMAGE_DRILL=1` to make that evidence mandatory.

## 2. Create configuration and secrets

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
first boot. Fill `.env`, including the exact HTTPS origins and a rotating alpha
invite code. Neither `.env` nor `.secrets/` is tracked by Git.
`FORGE_SECRET_DIR` may be an absolute path when secrets are mounted from an
encrypted host volume; relative paths resolve from `deploy/`, exactly as Compose
does.

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
It verifies DNS/TLS and HSTS, both service health endpoints, and a signed,
read-only list request to the configured R2 bucket. It never prints secret
values. Keep its evidence beside the restore-drill record, not in Git:

```sh
node deploy/preflight.mjs --env deploy/.env --online \
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
API or HTML responses. Immutable `/cache/*` responses may be cached only when
Forge itself returns `public, max-age=31536000, immutable`.

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
(or add `FORGE_DEPLOY_ONLINE=1` after DNS/TLS is live):

```sh
FORGE_DEPLOY_ENV=deploy/.env \
REQUIRE_DEPLOY_PREFLIGHT=1 \
./launch-gate.sh
```

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
is evaluated with `npm run pilot:report -- /path/to/cohort.json`.

## 7. Backup and restore drill

Forgejo's supported consistency model for PostgreSQL plus S3-compatible object
storage requires a short write outage. Do not take three independent live
copies and call them one backup. Announce a maintenance window, then run:

```sh
cd deploy
set -a
. ./.env
set +a
FORGE_BACKUP_ACK_DOWNTIME=1 ./backup.sh "$FORGE_BACKUP_DESTINATION"
```

The script stops the gateway and Forgejo, creates a Forgejo archive (including
repositories and LFS objects), makes independent custom-format dumps of both
PostgreSQL databases, validates all three files, records hashes and exact image
IDs, then restarts the services even if the backup fails. Copy the completed
directory to encrypted storage away from the host.

R2 does not provide an S3 object-versioning safety net. The Forgejo archive is
therefore the recoverable LFS copy; bucket-scoped credentials and an R2 bucket
lock reduce accidental deletion risk but are not a backup. Follow
[`RESTORE-DRILL.md`](RESTORE-DRILL.md) to restore into a separate project,
database volumes, ports, and LFS bucket. Store-3 render/export cache and the
generated hub are derived and deliberately excluded.

## 8. Operational stop conditions

Pause invitations if any of these occur: restore drill fails, private content
is readable signed out, release receipts do not reproduce, export workers
exceed quotas, the Sheets connector promotes a candidate that was not the one
reviewed, or moderation/takedown contact is unavailable. The controlled alpha
is a learning launch, not permission to weaken those boundaries.
