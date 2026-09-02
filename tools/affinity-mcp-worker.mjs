#!/usr/bin/env node
/**
 * Execute prepared Forge card payloads through Affinity's localhost MCP
 * scripting endpoint. Affinity owns the native document and PNG export; this
 * worker owns retries and the status file consumed by Forge's UI.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

function die(message) {
  console.error(`affinity-mcp-worker: ${message}`);
  process.exit(1);
}

function argsOf(argv) {
  const out = { command: argv[0] || 'run' };
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

function expandPath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function within(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function bridgePath(value) {
  const bridge = expandPath(value || die('--bridge is required'));
  const allowed = resolve(homedir(), 'Desktop', 'Forge Affinity');
  if (!within(allowed, bridge)) throw new Error(`bridge must be inside ${allowed}`);
  return bridge;
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

function localEndpoint(value) {
  const url = new URL(value || 'http://localhost:6767/sse');
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)) {
    throw new Error('Affinity endpoint must be localhost');
  }
  return url;
}

function loadJob(bridge) {
  const inputPath = resolve(bridge, 'input.json');
  const manifestPath = resolve(bridge, 'manifest.json');
  if (!existsSync(inputPath) || !existsSync(manifestPath)) throw new Error('bridge is not prepared yet');
  const input = json(inputPath);
  const manifest = json(manifestPath);
  if (manifest.active_commit !== input.commit_sha) throw new Error('bridge input and manifest are being updated; retrying');
  const scriptPath = resolve(manifest.script);
  const statusPath = resolve(manifest.status);
  if (!within(bridge, scriptPath) || !within(bridge, statusPath)) throw new Error('manifest path escapes the bridge');
  const script = readFileSync(scriptPath, 'utf8');
  const scriptHash = createHash('sha256').update(script).digest('hex');
  return { input, manifest, script, statusPath, key: `${input.input_hash}:${scriptHash}` };
}

function outputJson(result) {
  if (result.isError) throw new Error('Affinity rejected the script');
  const output = (result.content || []).filter(item => item.type === 'text').map(item => item.text || '').join('\n').trim();
  for (const line of output.split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && value.status) return value;
    } catch {
      // Affinity can include ordinary console messages beside the result.
    }
  }
  throw new Error(`Affinity returned no Forge status${output ? `: ${output.slice(0, 500)}` : ''}`);
}

function validateStatus(job, status) {
  const { input } = job;
  if (status.commit_sha !== input.commit_sha || status.input_hash !== input.input_hash || status.card_id !== input.card.id) {
    throw new Error('Affinity returned status for a different Forge input');
  }
  if (status.state === 'ready' && !existsSync(input.render.absolute_path)) {
    throw new Error('Affinity reported ready without producing the PNG');
  }
  return status;
}

async function execute(job, endpoint, timeout) {
  const client = new Client({ name: 'forge-affinity-worker', version: '0.1.0' });
  const transport = new SSEClientTransport(endpoint);
  try {
    await client.connect(transport);
    // Affinity requires this on every new connector session before scripts.
    await client.callTool({ name: 'read_sdk_documentation_topic', arguments: { filename: 'preamble' } });
    const result = await client.callTool(
      { name: 'execute_script', arguments: { script: job.script } },
      undefined,
      { timeout },
    );
    return outputJson(result);
  } finally {
    await transport.close().catch(() => {});
  }
}

function runningStatus(input) {
  return {
    schema_version: 1,
    state: 'rendering',
    game: input.game,
    card_id: input.card.id,
    printing_id: input.printing_id,
    commit_sha: input.commit_sha,
    commit_short: input.commit_short,
    input_hash: input.input_hash,
    updated_at: new Date().toISOString(),
  };
}

function errorStatus(input, error) {
  return {
    ...runningStatus(input),
    state: 'error',
    error: error?.stack || error?.message || String(error),
    updated_at: new Date().toISOString(),
  };
}

async function runOnce(options) {
  const bridge = bridgePath(options.bridge);
  const endpoint = localEndpoint(options.endpoint);
  const timeout = Math.max(5000, Number(options.timeout || 120000));
  const job = loadJob(bridge);
  atomicJson(job.statusPath, runningStatus(job.input));
  try {
    const payload = await execute(job, endpoint, timeout);
    const status = validateStatus(job, payload.status);
    atomicJson(job.statusPath, status);
    if (status.state !== 'ready') {
      const error = new Error(status.error || 'Affinity render failed');
      error.affinityStatus = status;
      throw error;
    }
    console.log(`Affinity render ready: ${job.input.card.id} @ ${job.input.commit_short}`);
    return { job, status };
  } catch (error) {
    atomicJson(job.statusPath, error.affinityStatus || errorStatus(job.input, error));
    throw error;
  }
}

async function watch(options) {
  const bridge = bridgePath(options.bridge);
  const interval = Math.max(500, Number(options.interval || 1000));
  const retry = Math.max(2000, Number(options.retry || 5000));
  let lastKey = null;
  let lastAttempt = 0;
  console.log(`Watching Affinity production input every ${interval}ms.`);
  while (true) {
    try {
      const job = loadJob(bridge);
      const prior = existsSync(job.statusPath) ? json(job.statusPath) : null;
      const current = prior?.state === 'ready'
        && prior.commit_sha === job.input.commit_sha
        && prior.input_hash === job.input.input_hash
        && existsSync(job.input.render.absolute_path);
      const now = Date.now();
      if (!current && (job.key !== lastKey || now - lastAttempt >= retry)) {
        lastKey = job.key;
        lastAttempt = now;
        await runOnce(options);
      }
    } catch (error) {
      console.error(`affinity-mcp-worker: ${error.message || error}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, interval));
  }
}

const options = argsOf(process.argv.slice(2));
try {
  if (options.command === 'run') await runOnce(options);
  else if (options.command === 'watch') await watch(options);
  else die(`unknown command '${options.command}' (use run or watch)`);
} catch (error) {
  die(error.message || String(error));
}
