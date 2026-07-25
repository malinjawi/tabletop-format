# Deploying the beta

Two tiers. Tier 1 is enough to launch; Tier 2 adds the live write-path playground.

## Tier 1 — static beta on GitHub Pages (free, ~10 minutes, no server)

What visitors get: the landing page, the full hub (all tabs, real data), two
in-browser card editors, and downloadable PnP PDFs / TTS mods. Everything
interactive except server-side saves.

```bash
./build_beta.sh                      # assembles beta-site/
# replace YOUR-ORG/YOUR-REPO in beta-site/index.html with your real repo URL

git checkout --orphan gh-pages
git rm -rf . && cp -r beta-site/* . && rm -rf beta-site
git add -A && git commit -m "beta site"
git push origin gh-pages
# GitHub repo → Settings → Pages → deploy from gh-pages branch
```

Or Cloudflare Pages: create project → direct upload → drop the `beta-site/`
folder. Done. (Cloudflare also gives you a free custom domain + analytics.)

## Tier 2 — live playground on a VPS (~€5/mo, ~30 minutes)

What visitors get additionally: the REST API and the magic trick — edit cards,
PUT, and watch a git commit appear with an auto-written message. Run it as a
communal sandbox that resets nightly.

```bash
# on a fresh Hetzner/any VPS with Docker:
git clone <your-repo> && cd <your-repo>
docker build -t forge-beta .
docker run -d --name forge-beta --restart unless-stopped -p 127.0.0.1:8420:8420 forge-beta

# nightly reset (communal sandbox wipes to baseline):
echo '5 4 * * * root docker rm -f forge-beta && docker run -d --name forge-beta --restart unless-stopped -p 127.0.0.1:8420:8420 forge-beta' > /etc/cron.d/forge-reset

# TLS + domain via Caddy (auto-HTTPS):
apt install -y caddy
printf 'beta.yourdomain.tld {\n  reverse_proxy 127.0.0.1:8420\n}\n' > /etc/caddy/Caddyfile
systemctl reload caddy
```

Built-in guards: 120 req/min/IP rate limit, 1MB body cap, `--readonly` flag
for showcase mode, all writes validated with rollback on failure.

## Beta copy suggestions

- Banner on the playground: "Communal sandbox — resets nightly at 04:05 UTC.
  Clone the repo to keep your work."
- Link the repo everywhere. The pitch is portability; prove it constantly.

## Launch checklist

1. Name chosen, `YOUR-ORG/YOUR-REPO` links replaced (grep for it)
2. Repo pushed public (bundle → `git clone tabletop-format.bundle`)
3. `./e2e.sh` green on your machine
4. Tier 1 live → smoke-test on phone + desktop
5. (Optional) Tier 2 live → PUT round-trip test from DEPLOY steps
6. Post devlog #1 with the beta URL — the outreach kit's "try it" links now
   point at a real thing
