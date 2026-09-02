#!/usr/bin/env node
/**
 * Publish committed Forge card data to the local Affinity production bridge.
 * The important invariant is that canonical values come from `git show HEAD`,
 * not from the working tree. A designer can experiment freely; only a commit
 * advances the production input.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_SOURCE = join(ROOT, 'integrations', 'affinity', 'forge-affinity-sync.js');

function die(message) {
  console.error(`affinity-bridge: ${message}`);
  process.exit(1);
}

function argsOf(argv) {
  const out = { command: argv[0] || 'prepare' };
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) die(`unexpected argument '${arg}'`);
    const key = arg.slice(2).replace(/-/g, '_');
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) die(`missing value for ${arg}`);
    out[key] = value;
    i++;
  }
  return out;
}

function git(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || `git ${args.join(' ')} failed`).trim());
  return result.stdout.trimEnd();
}

function gitBytes(cwd, ...args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error((result.stderr?.toString() || result.stdout?.toString() || `git ${args.join(' ')} failed`).trim());
  return result.stdout;
}

function readAt(repo, ref, relPath) {
  return git(repo, 'show', `${ref}:${relPath.split(sep).join('/')}`);
}

function readBytesAt(repo, ref, relPath) {
  return gitBytes(repo, 'show', `${ref}:${relPath.split(sep).join('/')}`);
}

function existsAt(repo, ref, relPath) {
  const result = spawnSync('git', ['-C', repo, 'cat-file', '-e', `${ref}:${relPath.split(sep).join('/')}`]);
  return result.status === 0;
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function contained(base, value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || isAbsolute(value)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const path = resolve(base, value);
  if (!within(base, path)) throw new Error(`${label} escapes the game directory: ${value}`);
  return path;
}

function existingContained(base, value, label) {
  const path = contained(base, value, label);
  if (!existsSync(path)) throw new Error(`${label} does not exist: ${value}`);
  const real = realpathSync(path);
  if (!within(base, real)) throw new Error(`${label} resolves outside the game directory: ${value}`);
  return real;
}

function gameRelative(repo, gameDir, value, label) {
  const path = contained(gameDir, value, label);
  return relative(repo, path);
}

function safeSegment(value, label) {
  const raw = String(value || '');
  if (!raw || raw.includes('\0') || raw === '.' || raw === '..' || raw.includes('/') || raw.includes('\\')) {
    throw new Error(`${label} must be one filename-safe identifier`);
  }
  return raw;
}

function jsLiteral(value) {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function getPath(object, path) {
  return path.split('.').reduce((value, key) => value == null || !Object.hasOwn(value, key) ? undefined : value[key], object);
}

function matches(object, match) {
  return Object.entries(match || {}).every(([path, wanted]) => {
    const value = getPath(object, path);
    const choices = Array.isArray(wanted) ? wanted : [wanted];
    return choices.some(choice => JSON.stringify(choice ?? null) === JSON.stringify(value ?? null));
  });
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function bytesHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function mediaType(path) {
  return ({
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  })[extname(path).toLowerCase()] || 'application/octet-stream';
}

function inlineSvgImages(source, templatePath, declaredFiles) {
  return source.replace(/\b((?:xlink:)?href)=(['"])([^'"#]+)\2/g, (match, attribute, quote, href) => {
    if (/^(?:data:|https?:|file:)/i.test(href)) return match;
    const target = resolve(dirname(templatePath), href);
    if (!declaredFiles.has(target)) throw new Error(`SVG image '${href}' must be listed in Affinity resources`);
    const data = declaredFiles.get(target).toString('base64');
    return `${attribute}=${quote}data:${mediaType(target)};base64,${data}${quote}`;
  });
}

function localPath(base, value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return resolve(base, value);
}

function canonicalWritePath(path) {
  let cursor = path;
  const suffix = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...suffix);
}

function safeBridgePath(gameDir, value) {
  const bridge = canonicalWritePath(localPath(gameDir, value));
  const roots = [gameDir, resolve(homedir(), 'Desktop', 'Forge Affinity')];
  if (!roots.some(root => within(root, bridge))) {
    throw new Error(`bridge_dir must stay inside the game or ${join(homedir(), 'Desktop', 'Forge Affinity')}`);
  }
  return bridge;
}

function validateConfig(config, gameDir) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Affinity config must be a JSON object');
  if (config.kind !== 'forge-affinity-binding') throw new Error("Affinity config kind must be 'forge-affinity-binding'");
  if (![1, 2].includes(config.schema_version)) throw new Error('unsupported Affinity config schema_version');
  const inferredGame = basename(gameDir);
  config.game = config.game || inferredGame;
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(config.game)) throw new Error('Affinity config game must be a safe slug');
  if (config.game !== inferredGame) throw new Error(`Affinity config game '${config.game}' does not match directory '${inferredGame}'`);
  safeSegment(config.card_id, 'card_id');
  safeSegment(config.printing_id, 'printing_id');
  const usesProduction = typeof config.production === 'string' && config.production.trim();
  if (usesProduction) {
    contained(gameDir, config.production, 'production contract');
    safeSegment(config.production_template, 'production_template');
    if (config.template !== undefined || config.bindings !== undefined || config.resources !== undefined) {
      throw new Error('Affinity config must reference production bindings or embed legacy bindings, not both');
    }
  } else if (config.production_template !== undefined) {
    throw new Error('production_template requires production');
  }
  if (!usesProduction) validateBindings(config.bindings, 'Affinity config');
  if (!usesProduction && typeof config.template !== 'string') throw new Error('Affinity config needs a template');
  if (config.template !== undefined) contained(gameDir, config.template, 'template');
  if (config.resources !== undefined && (!Array.isArray(config.resources) || config.resources.some(value => typeof value !== 'string'))) {
    throw new Error('Affinity config resources must be relative path strings');
  }
  if (!['commit', 'working-tree', undefined].includes(config.layout_source)) {
    throw new Error("layout_source must be 'commit' or 'working-tree'");
  }
  if (config.preflight !== undefined && (!config.preflight || typeof config.preflight !== 'object' || Array.isArray(config.preflight))) {
    throw new Error('preflight must be an object');
  }
  return config;
}

function validateBindings(bindings, label = 'Production contract') {
  if (!Array.isArray(bindings) || !bindings.length || bindings.length > 256) {
    throw new Error(`${label} bindings must contain 1–256 entries`);
  }
  const transforms = new Set([undefined, 'type-label', 'join', 'uppercase', 'lowercase', 'json']);
  const modes = new Set([undefined, 'plain', 'token-text', 'choice']);
  const layers = new Set();
  for (const [index, binding] of bindings.entries()) {
    if (!binding || typeof binding !== 'object') throw new Error(`binding ${index} must be an object`);
    if (typeof binding.layer !== 'string' || !binding.layer.trim()) throw new Error(`binding ${index} needs a layer`);
    if (!['card', 'printing'].includes(binding.source || 'card')) throw new Error(`binding ${index} has unsupported source '${binding.source}'`);
    if (typeof binding.field !== 'string' || !binding.field.trim()) throw new Error(`binding ${index} needs a field`);
    const pathParts = binding.field.split('.');
    if (pathParts.some(part => !/^[a-z0-9_-]+$/i.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part))) {
      throw new Error(`binding ${index} has an unsafe field path '${binding.field}'`);
    }
    const layerKey = binding.layer.trim().toLowerCase();
    if (layers.has(layerKey)) throw new Error(`binding ${index} duplicates layer '${binding.layer}'`);
    layers.add(layerKey);
    if (!transforms.has(binding.transform)) throw new Error(`binding ${index} has unsupported transform '${binding.transform}'`);
    if (!modes.has(binding.mode)) throw new Error(`binding ${index} has unsupported mode '${binding.mode}'`);
    if (binding.font_family !== undefined && (typeof binding.font_family !== 'string' || !binding.font_family.trim())) {
      throw new Error(`binding ${index} font_family must be a non-empty string`);
    }
    if (binding.font_postscript !== undefined && (typeof binding.font_postscript !== 'string' || !binding.font_postscript.trim())) {
      throw new Error(`binding ${index} font_postscript must be a non-empty string`);
    }
    if (binding.font_weight !== undefined && (!Number.isInteger(binding.font_weight) || binding.font_weight < 100 || binding.font_weight > 900)) {
      throw new Error(`binding ${index} font_weight must be an integer from 100 to 900`);
    }
    if (binding.aliases !== undefined && (!Array.isArray(binding.aliases) || binding.aliases.some(value => typeof value !== 'string'))) {
      throw new Error(`binding ${index} aliases must be strings`);
    }
  }
  return bindings;
}

function loadContext(options) {
  const gameDir = realpathSync(resolve(options.game || die('--game is required')));
  const configPath = existingContained(gameDir, options.config || 'templates/affinity/forge-affinity.json', 'config path');
  const repo = realpathSync(git(gameDir, 'rev-parse', '--show-toplevel'));
  const gameRel = relative(repo, gameDir);
  if (gameRel.startsWith('..')) throw new Error('game must live inside its Git repository');
  const ref = options.ref || 'HEAD';
  const commitSha = git(repo, 'rev-parse', ref);
  const configRel = relative(repo, configPath);
  const bootstrap = JSON.parse(readFileSync(configPath, 'utf8'));
  const committedConfig = existsAt(repo, commitSha, configRel);
  const layoutSource = bootstrap.layout_source || 'commit';
  if (layoutSource === 'commit' && !committedConfig) {
    throw new Error(`Affinity config is not committed at ${commitSha.slice(0, 12)}; commit it or explicitly set layout_source to 'working-tree' for a non-authoritative development render`);
  }
  const configBytes = layoutSource === 'commit' ? readBytesAt(repo, commitSha, configRel) : readFileSync(configPath);
  let config = validateConfig(JSON.parse(configBytes.toString('utf8')), gameDir);
  let productionBytes = null;
  let productionRel = null;
  let productionTemplate = null;
  if (config.production) {
    const productionPath = contained(gameDir, config.production, 'production contract');
    productionRel = relative(repo, productionPath);
    if (layoutSource === 'commit' && !existsAt(repo, commitSha, productionRel)) {
      throw new Error(`production contract is not committed at ${commitSha.slice(0, 12)}: ${config.production}`);
    }
    if (layoutSource === 'working-tree') existingContained(gameDir, config.production, 'production contract');
    productionBytes = layoutSource === 'commit' ? readBytesAt(repo, commitSha, productionRel) : readFileSync(productionPath);
    const production = JSON.parse(productionBytes.toString('utf8'));
    if (production?.kind !== 'forge-production' || production.schema_version !== 1 || !Array.isArray(production.templates)) {
      throw new Error('invalid Forge production contract');
    }
    productionTemplate = production.templates.find(template => template?.id === config.production_template);
    if (!productionTemplate) throw new Error(`production template '${config.production_template}' not found`);
    if (productionTemplate.renderer !== 'svg') throw new Error(`production template '${productionTemplate.id}' has unsupported renderer '${productionTemplate.renderer}'`);
    validateBindings(productionTemplate.bindings, `Production template '${productionTemplate.id}'`);
    config = {
      ...config,
      template: productionTemplate.template,
      resources: productionTemplate.resources || [],
      bindings: productionTemplate.bindings,
    };
  }
  const cardsRel = gameRelative(repo, gameDir, config.cards || 'components/cards.json', 'cards path');
  const printingsRel = gameRelative(repo, gameDir, config.printings || 'components/printings.json', 'printings path');
  const cards = JSON.parse(readAt(repo, commitSha, cardsRel));
  const printings = JSON.parse(readAt(repo, commitSha, printingsRel));
  if (!Array.isArray(cards) || !Array.isArray(printings)) throw new Error('cards and printings must be JSON arrays');
  const cardMatches = cards.filter(item => item && item.id === config.card_id);
  if (!cardMatches.length) throw new Error(`commit ${commitSha.slice(0, 7)} has no card '${config.card_id}'`);
  if (cardMatches.length > 1) throw new Error(`commit ${commitSha.slice(0, 7)} has duplicate card id '${config.card_id}'`);
  const [card] = cardMatches;
  if (productionTemplate && !matches(card, productionTemplate.match)) {
    throw new Error(`card '${card.id}' does not match production template '${productionTemplate.id}'`);
  }
  const printingMatches = printings.filter(item => item && item.id === config.printing_id);
  if (printingMatches.length > 1) throw new Error(`commit ${commitSha.slice(0, 7)} has duplicate printing id '${config.printing_id}'`);
  const [printing] = printingMatches;
  if (!printing || printing.card_id !== card.id) throw new Error(`printing '${config.printing_id}' does not belong to '${card.id}'`);
  const bridgeDir = safeBridgePath(gameDir, options.bridge || config.bridge_dir || '.forge/affinity');
  const template = contained(gameDir, config.template, 'template');
  const templateRel = relative(repo, template);
  if (layoutSource === 'commit' && !existsAt(repo, commitSha, templateRel)) throw new Error(`template is not committed at ${commitSha.slice(0, 12)}: ${config.template}`);
  if (layoutSource === 'working-tree') existingContained(gameDir, config.template, 'template');
  return { gameDir, configPath, configBytes, config, repo, gameRel, ref, commitSha, cards, printings, card, printing, bridgeDir, template, templateRel, layoutSource, productionBytes, productionRel, productionTemplate };
}

function publish(options, previousSha = null) {
  const ctx = loadContext(options);
  const { config, bridgeDir, card, printing, commitSha } = ctx;
  const commitShort = commitSha.slice(0, 12);
  const renderFile = `${safeSegment(config.printing_id, 'printing_id')}.png`;
  const renderDir = join(bridgeDir, 'renders', commitSha);
  const inputPath = join(bridgeDir, 'input.json');
  const statusPath = join(bridgeDir, 'status.json');
  const configuredScript = join(bridgeDir, 'forge-affinity-sync.js');
  mkdirSync(renderDir, { recursive: true });

  // Affinity 3.2 scripts are intentionally restricted to the user-approved
  // Desktop tree. Stage the editable template and its explicitly declared
  // resources into the bridge rather than granting it access to the repo.
  const sourceRoot = join(bridgeDir, 'source');
  const templateRel = config.template;
  const stagedTemplate = join(sourceRoot, templateRel);
  const templateBytes = ctx.layoutSource === 'commit'
    ? readBytesAt(ctx.repo, commitSha, ctx.templateRel)
    : readFileSync(ctx.template);
  const resources = (config.resources || []).map(resource => {
    const from = ctx.layoutSource === 'working-tree'
      ? existingContained(ctx.gameDir, resource, 'resource')
      : contained(ctx.gameDir, resource, 'resource');
    const resourceRel = relative(ctx.repo, from);
    if (ctx.layoutSource === 'commit' && !existsAt(ctx.repo, commitSha, resourceRel)) {
      throw new Error(`declared Affinity resource is not committed at ${commitSha.slice(0, 12)}: ${resource}`);
    }
    if (ctx.layoutSource === 'working-tree' && !existsSync(from)) throw new Error(`declared Affinity resource does not exist: ${resource}`);
    const bytes = ctx.layoutSource === 'commit' ? readBytesAt(ctx.repo, commitSha, resourceRel) : readFileSync(from);
    return { resource, from, bytes, sha256: bytesHash(bytes) };
  });
  const productionHash = hash({
    config: bytesHash(ctx.configBytes),
    production: ctx.productionBytes ? bytesHash(ctx.productionBytes) : null,
    template: bytesHash(templateBytes),
    resources: resources.map(({ resource, sha256 }) => ({ resource, sha256 })),
  });
  mkdirSync(dirname(stagedTemplate), { recursive: true });
  const declaredFiles = new Map(resources.map(item => [item.from, item.bytes]));
  const stagedSource = extname(ctx.template).toLowerCase() === '.svg'
    ? inlineSvgImages(templateBytes.toString('utf8'), ctx.template, declaredFiles)
    : templateBytes;
  writeFileSync(stagedTemplate, stagedSource);
  for (const { resource, bytes } of resources) {
    const to = join(sourceRoot, resource);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, bytes);
  }

  const baselineValues = ctx.productionTemplate?.baselines?.[card.id]?.values || null;
  const bindings = config.bindings.map(binding => {
    const source = (binding.source || 'card') === 'printing' ? printing : card;
    const value = getPath(source, binding.field);
    if (value === undefined && !binding.optional) throw new Error(`card '${card.id}' has no field '${binding.field}'`);
    const normalized = value ?? '';
    if (JSON.stringify(normalized).length > 1024 * 1024) throw new Error(`binding '${binding.field}' exceeds the 1 MiB safety limit`);
    const out = { ...binding, source: binding.source || 'card', value: normalized };
    if (baselineValues && Object.hasOwn(baselineValues, binding.field)) {
      out.baseline_value = baselineValues[binding.field];
    }
    return out;
  });
  const preflight = {
    check_document_bounds: config.preflight?.check_document_bounds !== false,
    tolerance: Number(config.preflight?.tolerance ?? 0.5),
  };
  if (!Number.isFinite(preflight.tolerance) || preflight.tolerance < 0 || preflight.tolerance > 100) {
    throw new Error('preflight tolerance must be a number from 0 to 100');
  }
  const identity = { game: config.game, commit_sha: commitSha, card_id: card.id, printing_id: printing.id, production_hash: productionHash, bindings, preflight };
  const inputHash = hash(identity);
  const nativeDocument = config.native_document || `${safeSegment(config.card_id, 'card_id')}.af`;
  if (basename(nativeDocument) !== nativeDocument || extname(nativeDocument).toLowerCase() !== '.af') {
    throw new Error('native_document must be one .af filename');
  }
  const nativePath = join(bridgeDir, 'documents', `${commitSha}-${productionHash.slice(0, 12)}`, nativeDocument);
  mkdirSync(dirname(nativePath), { recursive: true });
  const input = {
    schema_version: 1,
    kind: 'forge-affinity-input',
    game: config.game,
    commit_sha: commitSha,
    commit_short: commitShort,
    input_hash: inputHash,
    production_hash: productionHash,
    provenance: {
      data_source: 'commit',
      layout_source: ctx.layoutSource,
      reproducible: ctx.layoutSource === 'commit',
      config_path: relative(ctx.gameDir, ctx.configPath),
      production_path: ctx.productionRel ? relative(ctx.gameRel ? join(ctx.repo, ctx.gameRel) : ctx.gameDir, join(ctx.repo, ctx.productionRel)) : null,
    },
    card: { id: card.id, name: card.name },
    printing_id: printing.id,
    bindings,
    preflight,
    document: { template: stagedTemplate, native: nativePath },
    render: { absolute_path: join(renderDir, renderFile), file: renderFile },
    status_path: statusPath,
    generated_at: new Date().toISOString(),
  };
  atomicJson(inputPath, input);

  const sourceScript = readFileSync(SCRIPT_SOURCE, 'utf8');
  if (!sourceScript.includes('__FORGE_INPUT_JSON__')) throw new Error('Affinity sync source has no input sentinel');
  const script = sourceScript.replace('__FORGE_INPUT_JSON__', jsLiteral(input));
  writeFileSync(configuredScript, script);
  const manifest = {
    schema_version: 1,
    game: config.game,
    card_id: card.id,
    printing_id: printing.id,
    active_commit: commitSha,
    input: inputPath,
    script: configuredScript,
    status: statusPath,
    render: input.render.absolute_path,
  };
  atomicJson(join(bridgeDir, 'manifest.json'), manifest);

  if (previousSha !== commitSha) {
    console.log(`Affinity input: ${config.game}/${card.id} @ ${commitShort}`);
    console.log(`Script: ${configuredScript}`);
    console.log(`Native document: ${nativePath}`);
    console.log(`Expected render: ${input.render.absolute_path}`);
  }
  return { commitSha, input, manifest };
}

function status(options) {
  const ctx = loadContext(options);
  const inputPath = join(ctx.bridgeDir, 'input.json');
  const statusPath = join(ctx.bridgeDir, 'status.json');
  const input = existsSync(inputPath) ? JSON.parse(readFileSync(inputPath, 'utf8')) : null;
  const render = existsSync(statusPath) ? JSON.parse(readFileSync(statusPath, 'utf8')) : null;
  const current = !!(input && render && render.state === 'ready' && input.commit_sha === render.commit_sha && input.input_hash === render.input_hash);
  console.log(JSON.stringify({ current, input, render }, null, 2));
}

async function watch(options) {
  const interval = Math.max(500, Number(options.interval || 1000));
  let previousSha = null;
  console.log(`Watching committed Forge state every ${interval}ms. Working-copy edits are ignored.`);
  while (true) {
    try {
      const result = publish(options, previousSha);
      previousSha = result.commitSha;
    } catch (error) {
      console.error(`affinity-bridge: ${error.message}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, interval));
  }
}

const options = argsOf(process.argv.slice(2));
try {
  if (options.command === 'prepare') publish(options);
  else if (options.command === 'status') status(options);
  else if (options.command === 'watch') await watch(options);
  else die(`unknown command '${options.command}' (use prepare, watch, or status)`);
} catch (error) {
  die(error.message || String(error));
}
