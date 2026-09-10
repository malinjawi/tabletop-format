#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";

const base = String(process.argv[2] || "").replace(/\/$/, ""), dbPath = process.argv[3];
if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(base) || !dbPath) {
  console.error("usage: security-check.mjs http://127.0.0.1:<port> <sqlite-db>"); process.exit(2);
}
let checks = 0;
const ok = (condition, message) => { if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${String(++checks).padStart(2, "0")}  ${message}`); };
const request = async (path, options = {}) => {
  const response = await fetch(base + path, options), type = response.headers.get("content-type") || "";
  const body = type.includes("json") ? await response.json() : await response.text();
  return { response, body };
};

const health = await request("/healthz");
ok(health.response.headers.get("x-content-type-options") === "nosniff"
  && health.response.headers.get("x-frame-options") === "DENY"
  && /frame-ancestors 'none'/.test(health.response.headers.get("content-security-policy") || "")
  && health.response.headers.get("x-request-id"), "security headers and a request ID cover every response");
const evil = await request("/healthz", { headers: { Origin: "https://evil.example" } });
ok(evil.response.status === 403 && !evil.response.headers.get("access-control-allow-origin"),
  "unlisted cross-origin requests are rejected without wildcard CORS");
const allowedOrigin = base.replace("127.0.0.1", "localhost");
const allowed = await request("/healthz", { headers: { Origin: allowedOrigin } });
ok(allowed.response.status === 200 && allowed.response.headers.get("access-control-allow-origin") === allowedOrigin,
  "the exact configured origin is reflected, not broadened");

const registration = await request("/api/auth/register", { method: "POST",
  headers: { "content-type": "application/json", "x-forge-browser": "1" },
  body: JSON.stringify({ handle: "security-owner", email: "Owner@Example.Test", password: "a-secure-test-password" }) });
const cookie = registration.response.headers.get("set-cookie")?.split(";")[0];
ok(registration.response.status === 201 && !registration.body.token && cookie
  && /HttpOnly/i.test(registration.response.headers.get("set-cookie"))
  && /SameSite=Lax/i.test(registration.response.headers.get("set-cookie")),
  "browser login returns an HttpOnly SameSite cookie and no script-readable bearer token");
const me = await request("/api/me", { headers: { Cookie: cookie } });
ok(me.response.status === 200 && me.body.handle === "security-owner", "the cookie authenticates the same-origin browser session");
const sessions = await request("/api/auth/sessions", { headers: { Cookie: cookie } });
ok(sessions.response.status === 200 && sessions.body.length === 1 && sessions.body[0].current,
  "active sessions are listable and individually revocable without exposing credentials");

const created = await request("/api/games", { method: "POST", headers: { Cookie: cookie, "content-type": "application/json" },
  body: JSON.stringify({ title: "Private Security Fixture", license: "proprietary",
    csv: "id,name,type,text,quantity\nprivate_card,Private Card,card,Secret draft.,1\n" }) });
ok(created.response.status === 201, "a private controlled-beta project can be created");
const slug = created.body.slug;
const refMarker = `/tmp/forge-unsafe-ref-${process.pid}`;
rmSync(refMarker, { force: true });
const unsafeRef = encodeURIComponent(`not-a-ref; : > ${refMarker}; #`);
const exactRef = created.body.commit;
const unsafeRefRequests = [
  `/api/games/${slug}/repository/file/game.yaml?ref=${unsafeRef}`,
  `/api/games/${slug}/rights?ref=${unsafeRef}`,
  `/api/games/${slug}/diff?from=${unsafeRef}&to=${exactRef}`,
  `/api/games/${slug}/diff?from=${exactRef}&to=${unsafeRef}`,
  `/api/jams/spark-jam/eligibility?game=${encodeURIComponent(slug)}&ref=${unsafeRef}`,
];
const unsafeRefResponses = [];
for (const path of unsafeRefRequests) unsafeRefResponses.push(await request(path, { headers: { Cookie: cookie } }));
const refCommandStayedData = !existsSync(refMarker);
rmSync(refMarker, { force: true });
ok(unsafeRefResponses.every(result => result.response.status === 422) && refCommandStayedData,
  "every public repository, rights, diff, and jam version selector rejects command-like refs as data");
const shortRef = exactRef.slice(0, 7);
const canonicalFile = await request(`/api/games/${slug}/repository/file/game.yaml?ref=${shortRef}`, { headers: { Cookie: cookie } });
const canonicalRights = await request(`/api/games/${slug}/rights?ref=${shortRef}`, { headers: { Cookie: cookie } });
const canonicalDiff = await request(`/api/games/${slug}/diff?from=${shortRef}&to=HEAD`, { headers: { Cookie: cookie } });
const canonicalEligibility = await request(`/api/jams/spark-jam/eligibility?game=${encodeURIComponent(slug)}&ref=${shortRef}`, { headers: { Cookie: cookie } });
const canonicalFork = await request(`/api/games/${slug}/fork`, { method: "POST",
  headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ ref: shortRef }) });
const canonicalPlaytest = await request(`/api/games/${slug}/playtests`, { method: "POST",
  headers: { Cookie: cookie, "content-type": "application/json" },
  body: JSON.stringify({ id: "canonical-version-ref", version_ref: shortRef, players: [{ name: "Owner", result: "win" }] }) });
ok(/^[0-9a-f]{40}$/.test(exactRef)
  && canonicalFile.response.status === 200
  && canonicalRights.response.status === 200 && canonicalRights.body.source_sha === exactRef
  && canonicalDiff.response.status === 200 && canonicalDiff.body.from === exactRef && canonicalDiff.body.to === exactRef
  && canonicalEligibility.response.status === 200 && canonicalEligibility.body.ref === exactRef
  && canonicalFork.response.status === 201 && canonicalFork.body.source_ref === exactRef
    && /^[0-9a-f]{40}$/.test(canonicalFork.body.commit)
  && canonicalPlaytest.response.status === 201 && canonicalPlaytest.body.pinned === exactRef
    && /^[0-9a-f]{40}$/.test(canonicalPlaytest.body.commit),
  "legacy short selectors resolve to full object IDs before snapshots, forks, playtests, rights, diffs, or jam responses persist them");
const ownerStar = await request(`/api/stars/${slug}`, { method: "PUT", headers: { Cookie: cookie } });
const hidden = await request(`/api/games/${slug}/cards`), ownerRead = await request(`/api/games/${slug}/cards`, { headers: { Cookie: cookie } });
const publicCatalog = await request("/api/catalog?limit=50");
const publicDiscovery = await request("/api/discover");
const publicActivity = await request("/api/activity");
const privateEligibility = await request(`/api/jams/spark-jam/eligibility?game=${encodeURIComponent(slug)}`);
ok(ownerStar.response.status === 200 && hidden.response.status === 404 && ownerRead.response.status === 200
  && !publicCatalog.body.items.some(game => game.slug === slug)
  && !publicDiscovery.body.some(game => game.slug === slug)
  && !publicActivity.body.some(event => event.game_slug === slug)
  && privateEligibility.response.status === 404,
  "private source, direct routes, discovery, activity, and jam eligibility are all denied signed out");

const apiAccount = await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ handle: "connector-user", email: "connector@example.test", password: "another-secure-password" }) });
const strangerToken = apiAccount.body.token;
const collaboratorAccount = await request("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ handle: "security-maintainer", email: "maintainer@example.test", password: "maintainer-secure-password" }) });
const maintainerToken = collaboratorAccount.body.token;
const bearer = token => ({ Authorization: `Bearer ${token}` });
const db = new DatabaseSync(dbPath), stored = db.prepare("SELECT token FROM sessions").all().map(row => row.token);
ok(apiAccount.response.status === 201 && collaboratorAccount.response.status === 201
  && /^[0-9a-f]{64}$/.test(strangerToken) && /^[0-9a-f]{64}$/.test(maintainerToken)
  && !stored.includes(strangerToken) && !stored.includes(maintainerToken),
  "API/connector bearer tokens are persisted only as one-way digests");

const strangerStar = await request(`/api/stars/${slug}`, { method: "PUT", headers: bearer(strangerToken) });
ok(strangerStar.response.status === 404,
  "an unrelated signed-in user cannot probe or mutate a private project through stars");

const strangerRead = await request(`/api/games/${slug}/cards`, { headers: bearer(strangerToken) });
const ownerAccess = await request(`/api/games/${slug}/access`, { headers: { Cookie: cookie } });
ok(strangerRead.response.status === 404 && ownerAccess.response.status === 200
  && ownerAccess.body.isOwner && !ownerAccess.body.ownerless && !ownerAccess.body.sandbox
  && ownerAccess.body.canWrite && ownerAccess.body.canReview && ownerAccess.body.canMerge && ownerAccess.body.canRelease,
  "a private owned project is hidden from unrelated users while its owner retains every capability");

const grant = await request(`/api/games/${slug}/collaborators/security-maintainer`, { method: "PUT",
  headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ role: "maintainer" }) });
const maintainerRead = await request(`/api/games/${slug}/cards`, { headers: bearer(maintainerToken) });
const maintainerAccess = await request(`/api/games/${slug}/access`, { headers: bearer(maintainerToken) });
const maintainerRelease = await request(`/api/games/${slug}/releases`, { method: "POST",
  headers: { ...bearer(maintainerToken), "content-type": "application/json" }, body: JSON.stringify({ tag: "v0.1" }) });
ok(grant.response.status === 200 && maintainerRead.response.status === 200
  && maintainerAccess.body.role === "maintainer" && maintainerAccess.body.canWrite
  && maintainerAccess.body.canReview && maintainerAccess.body.canMerge && !maintainerAccess.body.canRelease
  && maintainerRelease.response.status === 403,
  "an explicit private-project maintainer can read/write/review/merge but cannot cut the owner's release");

const maintainerRights = await request(`/api/games/${slug}/rights`, { method: "PUT",
  headers: { ...bearer(maintainerToken), "content-type": "application/json" }, body: "{}" });
const maintainerRawRights = await request(`/api/games/${slug}/repository/file/forge/rights.json`, { method: "PUT",
  headers: { ...bearer(maintainerToken), "content-type": "application/json" },
  body: JSON.stringify({ content: "{}", message: "attempt governance bypass" }) });
const maintainerRawPolicy = await request(`/api/games/${slug}/repository/file/forge/collaboration.json`, { method: "PUT",
  headers: { ...bearer(maintainerToken), "content-type": "application/json" },
  body: JSON.stringify({ content: "{}", message: "attempt access bypass" }) });
ok(maintainerRights.response.status === 403 && maintainerRawRights.response.status === 403
  && maintainerRawPolicy.response.status === 403,
  "maintainers cannot bypass owner-only legal or access governance through specialized or raw file routes");

const ownerIssue = await request(`/api/games/${slug}/issues`, { method: "POST",
  headers: { Cookie: cookie, "content-type": "application/json" }, body: JSON.stringify({ title: "Maintainer close check" }) });
const maintainerClose = await request(`/api/games/${slug}/issues/${ownerIssue.body.number}/close`, { method: "POST",
  headers: bearer(maintainerToken) });
ok(ownerIssue.response.status === 201 && maintainerClose.response.status === 200 && maintainerClose.body.status === "closed",
  "the real admin route accepts an explicitly granted private-project maintainer");

const ownerId = db.prepare("SELECT id FROM users WHERE handle = 'security-owner'").get().id;
db.prepare(`INSERT INTO jam_entries
  (jam_id, game_slug, user_id, submitted_at, qualified, state, team_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)`)
  .run("spark-jam", slug, ownerId, Date.now(), 1, "draft", "[]");
db.prepare(`INSERT INTO export_jobs
  (id, game_slug, ref, kind, exporter_version, status, progress, attempt, input_hash, created_by, budget_json, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`)
  .run("job_private_legacy", slug, "abcdef0", "pnp", 1, "failed", 0, 1, "f".repeat(64), "{}", Date.now());
const anonymousJam = await request("/api/jams/spark-jam");
const ownerJam = await request("/api/jams/spark-jam", { headers: { Cookie: cookie } });
const strangerLegacyJob = await request("/api/export-jobs/job_private_legacy", { headers: bearer(strangerToken) });
const ownerLegacyJob = await request("/api/export-jobs/job_private_legacy", { headers: { Cookie: cookie } });
ok(!anonymousJam.body.entries.some(entry => entry.game_slug === slug),
  "private jam drafts are absent from anonymous jam views");
ok(ownerJam.body.entries.some(entry => entry.game_slug === slug),
  "a private jam draft remains visible to its owner");
ok(strangerLegacyJob.response.status === 404,
  "legacy export-job receipts for private projects are hidden from strangers");
ok(ownerLegacyJob.response.status === 200,
  "legacy export-job receipts remain available to the project owner");

db.prepare("UPDATE games SET owner_id = NULL, visibility = 'private' WHERE slug = ?").run(slug);
const privateOwnerlessAnon = await request(`/api/games/${slug}/cards`);
const privateOwnerlessStranger = await request(`/api/games/${slug}/access`, { headers: bearer(strangerToken) });
const privateOwnerlessWrite = await request(`/api/games/${slug}/cards`, { method: "PUT",
  headers: { ...bearer(strangerToken), "content-type": "application/json" }, body: JSON.stringify(ownerRead.body) });
const privateOwnerlessRelease = await request(`/api/games/${slug}/releases`, { method: "POST",
  headers: { ...bearer(strangerToken), "content-type": "application/json" }, body: JSON.stringify({ tag: "v0.1" }) });
ok(privateOwnerlessAnon.response.status === 404 && privateOwnerlessStranger.response.status === 404
  && privateOwnerlessWrite.response.status === 404 && privateOwnerlessRelease.response.status === 404,
  "a private ownerless fixture fails closed for anonymous and unrelated signed-in users across read, write, and release routes");

const privateOwnerlessMaintainer = await request(`/api/games/${slug}/access`, { headers: bearer(maintainerToken) });
const privateOwnerlessMaintainerRelease = await request(`/api/games/${slug}/releases`, { method: "POST",
  headers: { ...bearer(maintainerToken), "content-type": "application/json" }, body: JSON.stringify({ tag: "v0.1" }) });
ok(privateOwnerlessMaintainer.response.status === 200 && !privateOwnerlessMaintainer.body.sandbox
  && privateOwnerlessMaintainer.body.canWrite && privateOwnerlessMaintainer.body.canReview
  && privateOwnerlessMaintainer.body.canMerge && !privateOwnerlessMaintainer.body.canRelease
  && privateOwnerlessMaintainerRelease.response.status === 403,
  "only an explicitly recorded maintainer retains bounded access to a private ownerless fixture");

db.prepare("UPDATE games SET visibility = 'public' WHERE slug = ?").run(slug);
const publicOwnerlessAnon = await request(`/api/games/${slug}/access`);
const publicOwnerlessStranger = await request(`/api/games/${slug}/access`, { headers: bearer(strangerToken) });
const publicOwnerlessRelease = await request(`/api/games/${slug}/releases`, { method: "POST",
  headers: { ...bearer(strangerToken), "content-type": "application/json" }, body: JSON.stringify({ tag: "bad" }) });
const sandboxIssue = await request(`/api/games/${slug}/issues`, { method: "POST",
  headers: { ...bearer(maintainerToken), "content-type": "application/json" }, body: JSON.stringify({ title: "Public sandbox close check" }) });
const sandboxClose = await request(`/api/games/${slug}/issues/${sandboxIssue.body.number}/close`, { method: "POST",
  headers: bearer(strangerToken) });
ok(publicOwnerlessAnon.response.status === 200 && !publicOwnerlessAnon.body.sandbox
  && !publicOwnerlessAnon.body.canWrite && !publicOwnerlessAnon.body.canMerge && !publicOwnerlessAnon.body.canRelease
  && !publicOwnerlessStranger.body.sandbox && !publicOwnerlessStranger.body.canWrite
  && !publicOwnerlessStranger.body.canReview && !publicOwnerlessStranger.body.canMerge && !publicOwnerlessStranger.body.canRelease
  && publicOwnerlessRelease.response.status === 403
  && sandboxIssue.response.status === 201 && sandboxClose.response.status === 403,
  "a PUBLIC ownerless project stays readable but fails closed for write, admin, and release routes");

db.prepare("UPDATE games SET owner_id = ?, visibility = 'private' WHERE slug = ?").run(ownerId, slug);
db.close();

const activeSvg = await request(`/api/games/${slug}/assets?path=assets/art/active.svg`, { method: "POST",
  headers: { Cookie: cookie, "content-type": "image/svg+xml" }, body: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>' });
ok(activeSvg.response.status === 422 && /event handlers/.test(activeSvg.body.error), "active SVG is rejected before Git/LFS");
const malformed = await request(`/api/games/${slug}/cards`, { method: "PUT",
  headers: { Cookie: cookie, "content-type": "application/json" }, body: "{" });
ok(malformed.response.status === 400 && malformed.body.request_id, "malformed JSON is a bounded 400 with a traceable envelope");

const logout = await request("/api/auth/logout", { method: "POST", headers: { Cookie: cookie } });
const afterLogout = await request("/api/me", { headers: { Cookie: cookie } });
ok(logout.response.status === 200 && afterLogout.response.status === 401, "sign-out revokes the server session, not only local UI state");

let limited = false;
for (let i = 0; i < 15; i++) {
  const attempt = await request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ handle: "nobody", password: "wrong-password" }) });
  if (attempt.response.status === 429) { limited = attempt.response.headers.has("retry-after"); break; }
}
ok(limited, "authentication has its own stricter rate bucket and Retry-After response");
console.log(`\nSECURITY GREEN — ${checks} public-boundary checks passed.`);
