#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = join(ROOT, 'tools', 'affinity-bridge.mjs');
let passed = 0;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Forge Test', GIT_AUTHOR_EMAIL: 'forge@example.invalid', GIT_COMMITTER_NAME: 'Forge Test', GIT_COMMITTER_EMAIL: 'forge@example.invalid' },
  });
  if (options.ok !== false && result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  return result;
}

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

function json(path, value) {
  write(path, JSON.stringify(value, null, 2) + '\n');
}

function commit(repo, message = 'fixture') {
  run('git', ['add', '.'], { cwd: repo });
  run('git', ['commit', '-qm', message], { cwd: repo });
}

function makeFixture(game = 'aurora-deck', { tracked = true, layoutSource } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'forge-affinity-test-'));
  const gameDir = join(repo, game);
  const bridgeDir = join(gameDir, '.forge', 'affinity');
  run('git', ['init', '-q'], { cwd: repo });
  const cards = [{
    id: 'card_one',
    name: 'Café Ω \"quoted\" \\ slash\u2028line\u2029paragraph',
    type: 'Event',
    tags: ['co-op', '夜'],
    text: 'Choose </script> & continue. [spark]',
    attributes: { power: 3 },
  }];
  const printings = [{ id: 'print_one', card_id: 'card_one', rarity: 'prototype' }];
  const config = {
    schema_version: 2,
    kind: 'forge-affinity-binding',
    game,
    ...(layoutSource ? { layout_source: layoutSource } : {}),
    card_id: 'card_one',
    printing_id: 'print_one',
    bridge_dir: bridgeDir,
    template: 'templates/affinity/card.svg',
    native_document: 'card-one.af',
    resources: ['assets/mark.png'],
    bindings: [
      { field: 'name', layer: 'forge:name' },
      { field: 'tags', layer: 'forge:tags', transform: 'join', separator: ' / ' },
      { field: 'text', layer: 'forge:text' },
      { source: 'printing', field: 'rarity', layer: 'forge:rarity', transform: 'uppercase' },
      { field: 'missing', layer: 'forge:optional', optional: true },
    ],
  };
  json(join(gameDir, 'components', 'cards.json'), cards);
  json(join(gameDir, 'components', 'printings.json'), printings);
  json(join(gameDir, 'templates', 'affinity', 'forge-affinity.json'), config);
  write(join(gameDir, 'templates', 'affinity', 'card.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="420"><rect width="300" height="420" fill="#123"/><text id="forge:name">Name</text><text id="forge:tags">Tags</text><text id="forge:text">Text</text><text id="forge:rarity">Rarity</text><text id="forge:optional">Optional</text></svg>\n`);
  write(join(gameDir, 'assets', 'mark.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  if (tracked) commit(repo);
  return { repo, gameDir, bridgeDir, cards, config };
}

function prepare(fixture, ok = true, overrideBridge = true) {
  const args = [BRIDGE, 'prepare', '--game', fixture.gameDir];
  if (overrideBridge) args.push('--bridge', fixture.bridgeDir);
  return run(process.execPath, args, { cwd: ROOT, ok });
}

function input(fixture) {
  return JSON.parse(readFileSync(join(fixture.bridgeDir, 'input.json'), 'utf8'));
}

function check(name, fn) {
  fn();
  passed++;
  process.stdout.write(`✓ ${name}\n`);
}

const cleanups = [];
try {
  check('prepares a non-NSG game with no NSG assumptions', () => {
    const f = makeFixture(); cleanups.push(f.repo);
    prepare(f);
    const value = input(f);
    assert.equal(value.game, 'aurora-deck');
    assert.equal(value.provenance.reproducible, true);
    assert.equal(value.bindings.find(item => item.source === 'printing').value, 'prototype');
    assert.equal(JSON.stringify(value).toLowerCase().includes('netrunner'), false);
  });

  check('consumes the shared production contract without duplicating field bindings', () => {
    const f = makeFixture('shared-production'); cleanups.push(f.repo);
    const production = {
      schema_version: 1,
      kind: 'forge-production',
      card: { w_mm: 63.5, h_mm: 88.9 },
      templates: [{
        id: 'card_one', renderer: 'svg', match: { id: 'card_one' },
        template: 'templates/affinity/card.svg', resources: ['assets/mark.png'],
        bindings: f.config.bindings,
        baselines: { card_one: { signature: 'fnv1a:00000000', values: {} } },
      }],
    };
    json(join(f.gameDir, 'templates', 'production.json'), production);
    const adapter = {
      schema_version: 2, kind: 'forge-affinity-binding', game: 'shared-production',
      card_id: 'card_one', printing_id: 'print_one', bridge_dir: f.bridgeDir,
      production: 'templates/production.json', production_template: 'card_one',
      native_document: 'card-one.af',
    };
    json(join(f.gameDir, 'templates', 'affinity', 'forge-affinity.json'), adapter);
    commit(f.repo, 'share production bindings');
    prepare(f);
    const value = input(f);
    assert.deepEqual(value.bindings.map(binding => binding.field), f.config.bindings.map(binding => binding.field));
    assert.equal(value.provenance.production_path, 'templates/production.json');
    assert.equal('bindings' in adapter, false);
  });

  check('ignores dirty card, template, resource, and config edits', () => {
    const f = makeFixture('dirty-proof'); cleanups.push(f.repo);
    prepare(f);
    const before = input(f);
    const stagedBefore = readFileSync(before.document.template, 'utf8');
    const cards = structuredClone(f.cards); cards[0].name = 'UNCOMMITTED';
    json(join(f.gameDir, 'components', 'cards.json'), cards);
    write(join(f.gameDir, 'templates', 'affinity', 'card.svg'), '<svg>UNCOMMITTED</svg>');
    write(join(f.gameDir, 'assets', 'mark.png'), 'UNCOMMITTED');
    const config = structuredClone(f.config); config.bindings[0].layer = 'uncommitted-layer';
    json(join(f.gameDir, 'templates', 'affinity', 'forge-affinity.json'), config);
    prepare(f);
    const after = input(f);
    assert.equal(after.bindings[0].value, before.bindings[0].value);
    assert.equal(after.bindings[0].layer, before.bindings[0].layer);
    assert.equal(after.production_hash, before.production_hash);
    assert.equal(readFileSync(after.document.template, 'utf8'), stagedBefore);
  });

  check('advances data and layout identities only after commits', () => {
    const f = makeFixture('commit-proof'); cleanups.push(f.repo);
    prepare(f); const first = input(f);
    const cards = structuredClone(f.cards); cards[0].attributes.power = 9;
    json(join(f.gameDir, 'components', 'cards.json'), cards); commit(f.repo, 'card change');
    prepare(f); const second = input(f);
    assert.notEqual(second.commit_sha, first.commit_sha);
    assert.notEqual(second.input_hash, first.input_hash);
    assert.equal(second.production_hash, first.production_hash);
    write(join(f.gameDir, 'templates', 'affinity', 'card.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text id="forge:name">V2</text></svg>');
    commit(f.repo, 'layout change'); prepare(f); const third = input(f);
    assert.notEqual(third.production_hash, second.production_hash);
    assert.notEqual(third.document.native, second.document.native);
  });

  check('safely embeds quotes, markup, Unicode, U+2028, and U+2029', () => {
    const f = makeFixture('unicode-proof'); cleanups.push(f.repo);
    prepare(f);
    const script = readFileSync(join(f.bridgeDir, 'forge-affinity-sync.js'), 'utf8');
    assert.equal(script.includes('__FORGE_INPUT_JSON__'), false);
    assert.equal(script.includes('\u2028'), false);
    assert.equal(script.includes('\u2029'), false);
    assert.match(script, /\\u2028/);
    assert.match(script, /\\u2029/);
    assert.match(script, /<\/script>/);
    run(process.execPath, ['--check', join(f.bridgeDir, 'forge-affinity-sync.js')]);
  });

  check('rejects uncommitted production config by default', () => {
    const f = makeFixture('untracked-config', { tracked: false }); cleanups.push(f.repo);
    json(join(f.repo, 'placeholder.json'), {});
    run('git', ['add', 'placeholder.json'], { cwd: f.repo });
    run('git', ['commit', '-qm', 'placeholder'], { cwd: f.repo });
    const result = prepare(f, false);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config is not committed/);
  });

  check('allows an explicit non-authoritative working-tree development layout', () => {
    const f = makeFixture('working-layout', { layoutSource: 'working-tree' }); cleanups.push(f.repo);
    prepare(f);
    assert.equal(input(f).provenance.reproducible, false);
    write(join(f.gameDir, 'templates', 'affinity', 'card.svg'), '<svg xmlns="http://www.w3.org/2000/svg">DIRTY DEV</svg>');
    prepare(f);
    assert.match(readFileSync(input(f).document.template, 'utf8'), /DIRTY DEV/);
  });

  for (const scenario of [
    ['template traversal', config => { config.template = '../../outside.svg'; }, /template escapes/],
    ['resource traversal', config => { config.resources = ['../../outside.png']; }, /resource escapes/],
    ['bridge traversal', config => { config.bridge_dir = '/tmp/forge-escape'; }, /bridge_dir must stay/, false],
    ['native document traversal', config => { config.native_document = '../../outside.af'; }, /native_document must/],
    ['game mismatch', config => { config.game = 'another-game'; }, /does not match directory/],
    ['unknown transform', config => { config.bindings[0].transform = 'execute-anything'; }, /unsupported transform/],
    ['unknown source', config => { config.bindings[0].source = 'environment'; }, /unsupported source/],
    ['unsafe field path', config => { config.bindings[0].field = '__proto__.polluted'; }, /unsafe field path/],
    ['duplicate target layer', config => { config.bindings[1].layer = config.bindings[0].layer; }, /duplicates layer/],
  ]) {
    check(`rejects ${scenario[0]}`, () => {
      const f = makeFixture(`reject-${scenario[0].replaceAll(' ', '-')}`); cleanups.push(f.repo);
      const config = structuredClone(f.config); scenario[1](config);
      json(join(f.gameDir, 'templates', 'affinity', 'forge-affinity.json'), config);
      if (scenario[0] === 'template traversal') write(join(f.repo, 'outside.svg'), '<svg/>');
      if (scenario[0] === 'resource traversal') write(join(f.repo, 'outside.png'), 'x');
      commit(f.repo, 'bad config');
      const result = prepare(f, false, scenario[3] !== false);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, scenario[2]);
    });
  }

  check('rejects working-tree resource symlinks that escape the game', () => {
    const f = makeFixture('symlink-proof', { layoutSource: 'working-tree' }); cleanups.push(f.repo);
    const outside = join(f.repo, 'outside.png');
    write(outside, 'outside');
    rmSync(join(f.gameDir, 'assets', 'mark.png'));
    symlinkSync(outside, join(f.gameDir, 'assets', 'mark.png'));
    const result = prepare(f, false);
    assert.match(result.stderr, /resource resolves outside/);
  });

  check('rejects missing required fields but normalizes optional fields', () => {
    const f = makeFixture('field-contract'); cleanups.push(f.repo);
    prepare(f);
    assert.equal(input(f).bindings.find(item => item.field === 'missing').value, '');
    const config = structuredClone(f.config); config.bindings.at(-1).optional = false;
    json(join(f.gameDir, 'templates', 'affinity', 'forge-affinity.json'), config); commit(f.repo, 'required');
    const result = prepare(f, false);
    assert.match(result.stderr, /has no field 'missing'/);
  });

  check('rejects oversized binding payloads before generating Affinity code', () => {
    const f = makeFixture('payload-limit'); cleanups.push(f.repo);
    const cards = structuredClone(f.cards); cards[0].text = 'x'.repeat(1024 * 1024 + 1);
    json(join(f.gameDir, 'components', 'cards.json'), cards); commit(f.repo, 'oversized');
    const result = prepare(f, false);
    assert.match(result.stderr, /1 MiB safety limit/);
  });

  process.stdout.write(`\n${passed} Affinity bridge stress checks passed.\n`);
} finally {
  for (const path of cleanups) rmSync(path, { recursive: true, force: true });
}
