#!/usr/bin/env node
/**
 * End-to-end stress probe for the generic Forge -> Affinity production bridge.
 * It creates an unrelated temporary game, commits every production input, and
 * asks the real local Affinity process to create native documents and PNGs.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_TOOL = join(ROOT, 'tools', 'affinity-bridge.mjs');
const WORKER_TOOL = join(ROOT, 'tools', 'affinity-mcp-worker.mjs');
const repo = mkdtempSync(join(tmpdir(), 'forge-affinity-live-'));
const game = 'affinity-stress-lab';
const gameDir = join(repo, game);
const bridgeDir = mkdtempSync(join(homedir(), 'Desktop', 'Forge Affinity', 'stress-'));
const configPath = join(gameDir, 'templates', 'affinity', 'forge-affinity.json');
const cardsPath = join(gameDir, 'components', 'cards.json');
let commitCount = 0;

function run(command, args, { ok = true, timeout = 180000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Forge Live Stress', GIT_AUTHOR_EMAIL: 'stress@example.invalid', GIT_COMMITTER_NAME: 'Forge Live Stress', GIT_COMMITTER_EMAIL: 'stress@example.invalid' },
  });
  if (ok && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result;
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function json(path, value) {
  write(path, JSON.stringify(value, null, 2) + '\n');
}

function commit(message) {
  run('git', ['-C', repo, 'add', '.']);
  run('git', ['-C', repo, 'commit', '-qm', `${++commitCount}: ${message}`]);
  return run('git', ['-C', repo, 'rev-parse', 'HEAD']).stdout.trim();
}

function prepare() {
  run(process.execPath, [BRIDGE_TOOL, 'prepare', '--game', gameDir, '--bridge', bridgeDir]);
  return JSON.parse(readFileSync(join(bridgeDir, 'input.json'), 'utf8'));
}

function render({ endpoint, ok = true } = {}) {
  const args = [WORKER_TOOL, 'run', '--bridge', bridgeDir, '--timeout', '30000'];
  if (endpoint) args.push('--endpoint', endpoint);
  const result = run(process.execPath, args, { ok, timeout: 60000 });
  const status = JSON.parse(readFileSync(join(bridgeDir, 'status.json'), 'utf8'));
  return { result, status };
}

function updateCard(mutator, message) {
  const cards = JSON.parse(readFileSync(cardsPath, 'utf8'));
  mutator(cards[0]);
  json(cardsPath, cards);
  commit(message);
  return prepare();
}

run('git', ['-C', repo, 'init', '-q']);
const card = {
  id: 'lantern_keeper',
  name: 'Lantern Keeper',
  type: 'Companion',
  tags: ['Spirit', 'Guide'],
  text: 'Reveal 1 danger.',
  flavor: 'Her light remembers.',
};
const printing = { id: 'lantern_alpha', card_id: card.id, set: 'First Light', number: '007' };
const config = {
  schema_version: 2,
  kind: 'forge-affinity-binding',
  game,
  card_id: card.id,
  printing_id: printing.id,
  bridge_dir: bridgeDir,
  template: 'templates/affinity/fantasy-card.svg',
  native_document: 'lantern-keeper.af',
  bindings: [
    { field: 'name', layer: 'forge:name' },
    { field: 'type', layer: 'forge:type', transform: 'uppercase' },
    { field: 'tags', layer: 'forge:tags', transform: 'join', separator: ' · ' },
    { field: 'text', layer: 'forge:text' },
    { field: 'flavor', layer: 'forge:flavor' },
    { source: 'printing', field: 'set', layer: 'forge:set' },
    { source: 'printing', field: 'number', layer: 'forge:number' },
  ],
};
json(cardsPath, [card]);
json(join(gameDir, 'components', 'printings.json'), [printing]);
json(configPath, config);
write(join(gameDir, 'templates', 'affinity', 'fantasy-card.svg'), `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="63mm" height="88mm" viewBox="0 0 630 880">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#16233d"/><stop offset="1" stop-color="#5f315f"/></linearGradient></defs>
  <rect width="630" height="880" rx="30" fill="url(#bg)"/><rect x="18" y="18" width="594" height="844" rx="24" fill="none" stroke="#f5c96a" stroke-width="6"/>
  <circle cx="315" cy="310" r="190" fill="#f3bf57" opacity=".18"/><path d="M315 115l35 110 116 0-94 68 36 111-93-69-94 69 36-111-94-68 116 0z" fill="#f3bf57" opacity=".65"/>
  <g inkscape:groupmode="layer" inkscape:label="Forge-bound fields">
    <text inkscape:label="forge:name" x="315" y="78" text-anchor="middle" fill="#fff7df" font-family="Georgia" font-size="38" font-weight="bold">Name</text>
    <text inkscape:label="forge:type" x="315" y="530" text-anchor="middle" fill="#f5c96a" font-family="Arial" font-size="22" font-weight="bold">TYPE</text>
    <text inkscape:label="forge:tags" x="315" y="566" text-anchor="middle" fill="#fff7df" font-family="Arial" font-size="20">Tags</text>
    <text inkscape:label="forge:text" x="55" y="640" fill="#fff" font-family="Arial" font-size="23">Rules</text>
    <text inkscape:label="forge:flavor" x="55" y="715" fill="#e5d7e8" font-family="Georgia" font-size="19" font-style="italic">Flavor</text>
    <text inkscape:label="forge:set" x="55" y="830" fill="#f5c96a" font-family="Arial" font-size="16">Set</text>
    <text inkscape:label="forge:number" x="575" y="830" text-anchor="end" fill="#f5c96a" font-family="Arial" font-size="16">000</text>
  </g>
</svg>\n`);
commit('baseline generic fantasy card');

const report = [];
let input = prepare();
let outcome = render();
assert.equal(outcome.status.state, 'ready');
assert.equal(input.game, game);
assert.equal(input.provenance.reproducible, true);
report.push({ case: 'generic baseline', state: 'ready', png: input.render.absolute_path });

input = updateCard(value => {
  value.name = '守灯人 — حارسة النور 🏮';
  value.tags = [];
  value.text = '';
  value.flavor = 'Café, “quotes”, emoji ✨, RTL العربية, CJK 日本語.';
}, 'Unicode, RTL, emoji, and empty fields');
outcome = render();
assert.equal(outcome.status.state, 'ready');
report.push({ case: 'Unicode + RTL + emoji + empty', state: 'ready', png: input.render.absolute_path });

input = updateCard(value => {
  value.name = 'A Name Intentionally Far Too Long for a Normal Poker-Sized Card Header Without Any Automatic Fitting';
  value.text = 'Very long rules text. '.repeat(35);
}, 'extreme text lengths');
outcome = render({ ok: false });
assert.equal(outcome.status.state, 'error');
assert.match(outcome.status.error, /Production preflight failed/);
assert.ok(outcome.status.preflight.errors.length > 0);
report.push({ case: 'extreme text', state: 'blocked-by-production-preflight', errors: outcome.status.preflight.errors });

input = updateCard(value => {
  value.name = 'Lantern Keeper';
  value.text = 'Reveal 1 danger.';
  value.flavor = 'Her light remembers.';
}, 'restore production-safe text');
outcome = render();
assert.equal(outcome.status.state, 'ready');

// A failed local endpoint must produce an error status, and the same immutable
// input must recover when Affinity becomes available again.
outcome = render({ endpoint: 'http://localhost:6799/sse', ok: false });
assert.equal(outcome.status.state, 'error');
outcome = render();
assert.equal(outcome.status.state, 'ready');
report.push({ case: 'Affinity offline then recovery', state: 'recovered' });

const broken = structuredClone(config);
broken.bindings[0].layer = 'forge:missing-layer';
json(configPath, broken);
commit('deliberately missing layer');
prepare();
outcome = render({ ok: false });
assert.equal(outcome.status.state, 'error');
assert.match(outcome.status.error, /Missing Affinity layer/);
assert.ok(Array.isArray(outcome.status.layer_inventory));
report.push({ case: 'missing template layer', state: 'failed-clearly', inventory: outcome.status.layer_inventory });

json(configPath, config);
commit('repair missing layer');
input = prepare();
outcome = render();
assert.equal(outcome.status.state, 'ready');
report.push({ case: 'repair after bad config', state: 'ready', png: input.render.absolute_path });

process.stdout.write(JSON.stringify({ repo, bridge: bridgeDir, report }, null, 2) + '\n');
