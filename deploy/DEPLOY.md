# Controlled-alpha deployment

Forge launches behind HTTPS as three digest-pinned services: the immutable
gateway image, Forgejo (repository truth), and Postgres (identity/conversation
state). R2 holds LFS objects. The host proxy is the only public ingress;
Compose binds the gateway to loopback by default and does not expose Postgres.

## 1. Build and promote the gateway

Resolve and record a Node base-image digest, then build from the clean release
commit. The build context excludes games, exports, local data and secrets.

```sh
docker build \
  --build-arg NODE_IMAGE='node:22-bookworm-slim@sha256:<verified-digest>' \
  -f Dockerfile.prod -t registry.example/forge/platform:<release> .
docker push registry.example/forge/platform:<release>
docker buildx imagetools inspect registry.example/forge/platform:<release>
```

Put the resulting `registry/...@sha256:...` reference in
`FORGE_GATEWAY_IMAGE`. Put tested digest references—not floating majors—in
`FORGEJO_IMAGE` and `POSTGRES_IMAGE`. A Forgejo major upgrade is a separate,
backup-tested migration; it is not bundled into an application deploy.

## 2. Create configuration and secrets

```sh
cd deploy
cp .env.example .env
mkdir -m 700 .secrets
for name in pg-super-password forge-db-password platform-db-password lfs-jwt-secret; do
  openssl rand -base64 32 > ".secrets/$name"
  chmod 600 ".secrets/$name"
done
```

Create `.secrets/r2-access-key` and `.secrets/r2-secret-key` from a credential
limited to the Forge LFS bucket. Create an empty `.secrets/forge-token` for the
first boot. Fill `.env`, including the exact HTTPS origins and a rotating alpha
invite code. Neither `.env` nor `.secrets/` is tracked by Git.

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

## 4. Edge contract

Terminate TLS at the host proxy/CDN and forward to `127.0.0.1:8420`. Preserve
the real client address and set `FORGE_TRUST_PROXY=1` only for that trusted
proxy path. Forward the original `Host` and `X-Forwarded-Proto`. Do not cache
API or HTML responses. Immutable `/cache/*` responses may be cached only when
Forge itself returns `public, max-age=31536000, immutable`.

The application refuses production startup with HTTP, local Store-1, missing
Forge credentials, or open registration. Browser sessions are HttpOnly,
Secure, SameSite cookies; connector sessions remain revocable bearer tokens.

## 5. Release gate

Run the single release gate against the exact release commit before deploying:

```sh
npm ci
FORGE_REQUIRE_CLEAN_TREE=1 \
FORGE_CONFORMANCE_PG_URL='postgres://…/forge_conformance' \
FORGE_LIVE_URL='http://127.0.0.1:3000' \
FORGE_LIVE_ADMIN_USER='launch-gate' \
FORGE_LIVE_ADMIN_PASS='…' \
REQUIRE_PRODUCTION_BACKENDS=1 \
./launch-gate.sh
```

Use dedicated disposable backend instances. The live journey purges its exact
fixture users and refuses to run without the guard set by `launch-gate.sh`. Do
not point conformance at a database or Forgejo server that contains user work.

After deployment verify `/healthz`, a login/logout cycle, a private-project
404 while signed out, a Sheet dry run and commit, a PR approval/merge, and one
release with PnP/TTS/TTC/project receipts.

## 6. Backup and restore drill

Back up before every Forgejo/database upgrade and daily during the alpha:

```sh
docker compose -f docker-compose.prod.yml exec -u 1000 forgejo \
  forgejo dump --file /data/backup/forgejo.zip
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U postgres -Fc platform > platform.dump
docker compose -f docker-compose.prod.yml exec -T db \
  pg_dump -U postgres -Fc forgejo > forgejo.dump
```

R2 versioning must be enabled for the LFS bucket. Store encrypted copies away
from this host. At least once before inviting users, restore all three stores
into a disposable environment and run the Forgejo journey. Store-3 render and
export cache is derived and is deliberately not backed up.

## 7. Operational stop conditions

Pause invitations if any of these occur: restore drill fails, private content
is readable signed out, release receipts do not reproduce, export workers
exceed quotas, the Sheets connector promotes a candidate that was not the one
reviewed, or moderation/takedown contact is unavailable. The controlled alpha
is a learning launch, not permission to weaken those boundaries.
