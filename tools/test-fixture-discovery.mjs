#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createLocalStore } from "../platform/store1-local.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const scratch = mkdtempSync(join(tmpdir(), "forge-fixture-discovery."));
const games = join(scratch, "examples");
const previousGlobalGitConfig = process.env.GIT_CONFIG_GLOBAL;
const seed = (relativePath) => {
  const path = join(games, relativePath, "game.yaml");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `title: ${relativePath}\nlicense: CC0-1.0\n`);
};
const git = (...args) => spawnSync("git", ["-C", scratch, ...args], { encoding: "utf8" });

try {
  seed("public-game");
  seed("_fixtures/private-fixture");
  assert.equal(git("init").status, 0);
  const emptyGlobalGitConfig = join(scratch, ".git", "empty-global-config");
  writeFileSync(emptyGlobalGitConfig, "");
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalGitConfig;
  writeFileSync(join(scratch, "unrelated.txt"), "commit before either game was versioned\n");
  assert.equal(git("add", "unrelated.txt").status, 0);
  assert.equal(git("-c", "user.name=Forge Test", "-c", "user.email=forge@example.test",
    "commit", "-m", "unrelated history").status, 0);
  const unrelatedRef = git("rev-parse", "HEAD").stdout.trim();
  assert.equal(git("add", ".").status, 0);
  assert.equal(git("-c", "user.name=Forge Test", "-c", "user.email=forge@example.test",
    "commit", "-m", "fixtures").status, 0);

  const safeStore = createLocalStore({ root: scratch, gamesDir: games });
  assert.deepEqual(safeStore.list(), ["public-game"]);
  assert.equal(safeStore.has("private-fixture"), false);
  assert.equal(safeStore.dir("private-fixture"), null);
  assert.equal(safeStore.isFixture("private-fixture"), false);
  await assert.rejects(() => safeStore.materialize("public-game", "HEAD; echo unsafe"),
    error => error?.status === 422 && /version reference/.test(error.message),
    "the local Store1 boundary rejects command-like refs before invoking Git");
  const head = await safeStore.headSha("public-game");
  assert.match(head, /^[0-9a-f]{40}$/, "the local Store1 head is authoritative, never abbreviated");
  assert.throws(() => safeStore.resolveRef("public-game", unrelatedRef),
    error => error?.status === 422 && /unavailable/.test(error.message),
    "an unrelated monorepo commit cannot masquerade as a version of this project");
  assert.equal(await safeStore.resolveRef("public-game", head.slice(0, 7)), head,
    "a legacy abbreviated input resolves to its authoritative full object ID");
  writeFileSync(join(scratch, "unrelated-after-game.txt"), "the project tree exists, but this is not its revision\n");
  assert.equal(git("add", "unrelated-after-game.txt").status, 0);
  assert.equal(git("-c", "user.name=Forge Test", "-c", "user.email=forge@example.test",
    "commit", "-m", "another project's change").status, 0);
  const unrelatedAfterGame = git("rev-parse", "HEAD").stdout.trim();
  assert.equal(safeStore.headSha("public-game"), head,
    "an unrelated monorepo commit is not reported as this project's head");
  assert.equal(safeStore.resolveRef("public-game", "HEAD"), head,
    "the local HEAD selector means this project's head, not the monorepo's global head");
  assert.throws(() => safeStore.resolveRef("public-game", unrelatedAfterGame),
    error => error?.status === 422 && /unavailable/.test(error.message),
    "a commit that merely contains the game but did not change it cannot be pinned as its version");
  const release = safeStore.createReleaseTag("public-game", "v1.0", head,
    "test release", "Forge Test <forge@example.test>");
  assert.match(release.target, /^[0-9a-f]{40}$/);
  assert.match(release.tagObject, /^[0-9a-f]{40}$/);
  assert.equal(await safeStore.resolveRef("public-game", "v1.0"), head,
    "a local release name resolves through this game's namespaced tag to the full commit ID");
  const released = await safeStore.materialize("public-game", "v1.0", { resolveLfs: false });
  try {
    assert.equal(existsSync(join(released.dir, "game.yaml")), true,
      "a validated public v* release name resolves only to this local game's namespaced tag");
  } finally { released.cleanup(); }

  const raceBase = safeStore.headSha("public-game");
  const raceContents = [
    "title: concurrent alpha\nlicense: CC0-1.0\n",
    "title: concurrent beta\nlicense: CC0-1.0\n",
  ];
  const race = await Promise.allSettled(raceContents.map((content, index) =>
    safeStore.writeFiles("public-game", [{ path: "game.yaml", content }],
      `concurrent update ${index + 1}`, "Forge Test <forge@example.test>", { expectedRef: raceBase })));
  const winners = race.map((result, index) => ({ result, index }))
    .filter(({ result }) => result.status === "fulfilled");
  const losers = race.map((result, index) => ({ result, index }))
    .filter(({ result }) => result.status === "rejected");
  assert.equal(winners.length, 1, "exactly one same-base local write commits");
  assert.equal(losers.length, 1, "the competing same-base local write is rejected");
  const winner = winners[0], loser = losers[0];
  assert.equal(loser.result.reason?.code, "STORE1_EXPECTED_REF_MISMATCH");
  assert.equal(loser.result.reason?.status, 409);
  assert.equal(loser.result.reason?.written, false);
  assert.equal(loser.result.reason?.expectedRef, raceBase);
  assert.equal(loser.result.reason?.currentRef, winner.result.value.sha);
  assert.equal(readFileSync(join(games, "public-game", "game.yaml"), "utf8"), raceContents[winner.index],
    "the rejected concurrent write cannot overwrite the winning committed tree");
  assert.equal(safeStore.headSha("public-game"), winner.result.value.sha,
    "the project head remains the single winning compare-and-commit revision");

  const createOnlyPath = "playtests/stable-session.json";
  const firstSession = '{"id":"stable-session","winner":"first"}\n';
  await safeStore.writeFiles("public-game", [{ path: createOnlyPath, content: firstSession }],
    "create stable session", "Forge Test <forge@example.test>", { createOnlyPaths: [createOnlyPath] });
  await assert.rejects(() => safeStore.writeFiles("public-game", [{ path: createOnlyPath,
    content: '{"id":"stable-session","winner":"second"}\n' }], "replace stable session",
  "Forge Test <forge@example.test>", { createOnlyPaths: [createOnlyPath] }),
  error => error?.code === "STORE1_PATH_EXISTS" && error?.status === 409 && error?.written === false,
  "the local create-only contract rejects an existing path inside its mutation lock");
  assert.equal(readFileSync(join(games, "public-game", createOnlyPath), "utf8"), firstSession,
    "a rejected local create-only write cannot overwrite the existing bytes");

  const updated = await safeStore.writeFiles("public-game", [{ path: "game.yaml",
    content: "title: updated\nlicense: CC0-1.0\n" }], "update public game", "Forge Test <forge@example.test>");
  assert.match(updated.sha, /^[0-9a-f]{40}$/);
  assert.equal(updated.sha, safeStore.headSha("public-game"));
  assert.equal(git("show", "-s", "--format=%an <%ae>", updated.sha).stdout.trim(),
    "Forge Test <forge@example.test>", "the signed-in person remains the commit author");
  assert.equal(git("show", "-s", "--format=%cn <%ce>", updated.sha).stdout.trim(),
    "Forge Platform <noreply@forge.local>", "Forge supplies a portable deterministic committer");
  const unchanged = await safeStore.writeFiles("public-game", [{ path: "game.yaml",
    content: "title: updated\nlicense: CC0-1.0\n" }], "no-op", "Forge Test <forge@example.test>");
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.sha, updated.sha, "even no-op writes return the project's full head, not a global short ref");

  const testStore = createLocalStore({ root: scratch, gamesDir: games, includeFixtures: true });
  assert.deepEqual(testStore.list().sort(), ["private-fixture", "public-game"]);
  assert.equal(testStore.dir("private-fixture"), join(games, "_fixtures", "private-fixture"));
  assert.equal(testStore.isFixture("private-fixture"), true);
  assert.equal(testStore.isFixture("public-game"), false);

  const venvPython = join(ROOT, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const python = process.env.FORGE_PYTHON || (existsSync(venvPython) ? venvPython : "python3");
  const discovery = spawnSync(python, ["-c", [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "from build_hub import discover_games",
    "base = sys.argv[2]",
    "print(json.dumps({",
    "  'default': [p.name for p in discover_games(base)],",
    "  'explicit': [p.name for p in discover_games(base, True)],",
    "}))",
  ].join("\n"), join(ROOT, "tools"), games], { encoding: "utf8" });
  assert.equal(discovery.status, 0, discovery.stderr);
  assert.deepEqual(JSON.parse(discovery.stdout), {
    default: ["public-game"], explicit: ["private-fixture", "public-game"],
  });

  const productionBuild = spawnSync(python, [join(ROOT, "tools", "build_hub.py"),
    "--shell", "--include-fixtures", "--games", games, "-o", join(scratch, "hub.html")], {
    cwd: ROOT, encoding: "utf8", env: { ...process.env, NODE_ENV: "production" },
  });
  assert.notEqual(productionBuild.status, 0);
  assert.match(`${productionBuild.stdout}\n${productionBuild.stderr}`, /production cannot include internal test fixtures/);

  const production = spawnSync(process.execPath, [join(ROOT, "server.mjs"), "--port", "0"], {
    cwd: ROOT, encoding: "utf8",
    env: { ...process.env, NODE_ENV: "production", FORGE_INCLUDE_TEST_FIXTURES: "1" },
  });
  assert.notEqual(production.status, 0);
  assert.match(`${production.stdout}\n${production.stderr}`, /production cannot include internal test fixtures/);

  console.log("FIXTURE DISCOVERY GREEN — hidden by default, explicit in tests, forbidden in production.");
} finally {
  if (previousGlobalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = previousGlobalGitConfig;
  rmSync(scratch, { recursive: true, force: true });
}
