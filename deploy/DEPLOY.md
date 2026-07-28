# DEPLOY — the platform, production-shaped

One VM with Docker is enough to start. Every step below exists because a test
proved it matters (spike A–G, journey-forgejo, store2-pg-test) — nothing here
is speculative.

## 0. What runs where

| Piece | Container | State | Loss tolerance |
|---|---|---|---|
| Gateway (server.mjs) | `gateway` | none (Store-3 cache only) | disposable — cache regenerates (DA-5) |
| Forgejo (Store 1) | `forgejo` | repos + LFS metadata | **the product** — back it up (step 6) |
| LFS blobs | Cloudflare R2 | game assets | R2 durability + versioning |
| Postgres (Store 2 ×2) | `db` | forge DB + platform DB | platform DB is a rebuildable index for games (DA-3/DA-9); users/stars/claims need backup |

## 1. Boot

    cd deploy
    cp .env.example .env        # fill in — generator one-liner is in the file
    docker compose -f docker-compose.prod.yml up -d

Create the R2 bucket (`forge-lfs`) in Cloudflare first. For a dry run without
R2, switch the forgejo `lfs` block to `FORGEJO__lfs__STORAGE_TYPE=local` (the
spike default) — the platform code is identical either way.

## 2. Forgejo admin (once)

    docker compose -f docker-compose.prod.yml exec -u 1000 forgejo \
      forgejo admin user create --admin --username "$FORGE_ADMIN_USER" \
      --password "$FORGE_ADMIN_PASS" --email admin@your-domain

## 3. Mint the platform token (once)

    curl -s -u "$FORGE_ADMIN_USER:$FORGE_ADMIN_PASS" -X POST \
      -H "Content-Type: application/json" -d '{"name":"platform","scopes":["all"]}' \
      http://localhost:3000/api/v1/users/$FORGE_ADMIN_USER/tokens
    # → put the sha1 into .env as FORGE_TOKEN, then: docker compose ... up -d gateway

## 4. Verify — the same suites that verified everything else

    ./store2-pg-test.sh                                   # both DB drivers conformant
    FORGE_URL=http://localhost:3000 ./journey-forgejo.sh  # 30 assertions, full prod profile
    curl -s localhost:8420/healthz

## 5. Edge

Put a CDN/reverse proxy (Cloudflare in front of :8420) with TLS.
`/cache/*` responses already carry `immutable, max-age=31536000` — let the CDN
honor them and the TTS-links-never-rot property costs you almost nothing.
Rate limiting also exists in-process (120/min/IP) as a second layer.

## 6. Backups (drill it once before launch)

    # Store 1 — the product:
    docker compose -f docker-compose.prod.yml exec -u 1000 forgejo forgejo dump -f /tmp/dump.zip
    # Store 2 — people & conversation:
    docker compose -f docker-compose.prod.yml exec db pg_dump -U postgres platform > platform.sql
    # Store 3 — nothing to back up, ever (DA-5: derived).

## 7. Known-by-test production facts

- `webhook.ALLOWED_HOST_LIST` must name the gateway host — Forgejo's SSRF
  guard silently drops deliveries to private addresses otherwise (spike F1).
- LFS routes 404 unless `LFS_START_SERVER=true` + a JWT secret (spike C2).
- R2-as-minio needs `MINIO_CHECKSUM_ALGORITHM=md5` and `SERVE_DIRECT=false`
  first (gitea #32407); revisit SERVE_DIRECT once stable for direct-to-R2 serving.
- Forgejo 11's contents API honors `.gitattributes` (the #18297 bypass is
  fixed); the platform still writes LFS explicitly — correct on every version.
- Postgres `INTEGER` is 32-bit: epoch-ms columns are `BIGINT` in migrations.
- `pg` is the single production npm dependency; dev and CI stay zero-dep.
