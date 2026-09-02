/*
 * Forge -> Affinity card sync (Affinity 3.2+)
 *
 * This file runs directly through Affinity's local scripting connector.
 * `tools/affinity-bridge.mjs` writes a configured copy beside the bridge input
 * and replaces the sentinel below with an immutable Git payload. The source
 * cannot run unconfigured: a production document must never bind to the wrong
 * game or to uncommitted working-copy data.
 */
'use strict';

const { Document, FileExportOptions } = require('/document.js');
const { FileSystemApi } = require('/fs.js');
const { FontWeight } = require('/fonts.js');
const { Transform } = require('/geometry.js');
const { TextSelection } = require('/selections.js');
const { StoryDelta } = require('/storydelta.js');

const INPUT = __FORGE_INPUT_JSON__;

function nodeName(node) {
  const candidates = [node.userDescription, node.description, node.defaultDescriptionForDisplay, node.defaultDescription];
  return candidates.find(value => typeof value === 'string' && value.trim()) || '';
}

function nodeInventory(doc) {
  const out = [];
  for (const node of doc.layers.all) {
    const box = node.spreadVisibleBox;
    out.push({
      name: nodeName(node),
      user_description: node.userDescription || '',
      kind: node.isTextNode ? 'text' : (node.constructor && node.constructor.name) || 'node',
      text: node.isTextNode ? node.text : undefined,
      box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : undefined,
    });
  }
  return out;
}

function aliases(binding) {
  const names = [binding.layer].concat(binding.aliases || []);
  return names.filter(Boolean).map(name => String(name).trim().toLowerCase());
}

function findNode(doc, binding) {
  const wanted = aliases(binding);
  for (const node of doc.layers.all) {
    const names = [node.userDescription, node.description, node.defaultDescriptionForDisplay, node.defaultDescription]
      .filter(Boolean).map(value => String(value).trim().toLowerCase());
    if (names.some(name => wanted.includes(name))) return node;
  }
  return null;
}

function descendants(node) {
  const out = [];
  const visit = parent => {
    for (const child of parent.children || []) {
      out.push(child);
      visit(child);
    }
  };
  visit(node);
  return out;
}

function textNodes(node) {
  if (node.isTextNode) return [node];
  return descendants(node).filter(child => child.isTextNode);
}

function formatValue(value, binding) {
  if (binding.transform === 'type-label') return String(value || '').toUpperCase() + ':';
  if (binding.transform === 'join') return Array.isArray(value) ? value.join(binding.separator || ', ') : String(value || '');
  if (binding.transform === 'uppercase') return String(value || '').toUpperCase();
  if (binding.transform === 'lowercase') return String(value || '').toLowerCase();
  if (binding.transform === 'json') return JSON.stringify(value);
  return value == null ? '' : String(value);
}

function replaceText(node, text) {
  // Affinity 3.2.3's TextNode.setText() currently calls the nonexistent
  // TextSelection.from(). Build the documented text selection explicitly.
  const selection = node.selfSelection;
  const range = { begin: 0, end: node.story.length };
  selection.addSubSelectionForNode(node, TextSelection.create([range]));
  node.document.setText(text, selection);
}

function styleText(doc, node, binding) {
  const deltas = [];
  if (binding.font_postscript) {
    // PostScript identity selects an exact installed face and avoids variable
    // font weight ambiguity in Affinity's SVG importer.
    deltas.push(StoryDelta.createPostscriptName(binding.font_postscript));
  } else {
    if (binding.font_family) deltas.push(StoryDelta.createFamilyName(binding.font_family));
    if (binding.font_weight) {
      const weights = {
        100: FontWeight.Thin, 200: FontWeight.ExtraLight, 300: FontWeight.Light,
        400: FontWeight.Normal, 500: FontWeight.Medium, 600: FontWeight.SemiBold,
        700: FontWeight.Bold, 800: FontWeight.ExtraBold, 900: FontWeight.Black,
      };
      deltas.push(StoryDelta.createWeight(weights[binding.font_weight] || FontWeight.Normal));
    }
  }
  if (!deltas.length) return;
  const selection = node.selfSelection;
  selection.addSubSelectionForNode(node, TextSelection.create([{ begin: 0, end: node.story.length }]));
  const delta = deltas.length === 1 ? deltas[0] : StoryDelta.createComposite(deltas);
  doc.formatText(delta, selection);
}

function applyPlain(doc, node, value, binding) {
  const nodes = textNodes(node);
  if (!nodes.length) throw new Error(`Layer '${binding.layer}' contains no editable text`);
  const text = formatValue(value, binding);
  for (const textNode of nodes) {
    replaceText(textNode, text);
    styleText(doc, textNode, binding);
  }
}

function setNodeVisible(doc, node, visible) {
  doc.setVisible(Boolean(visible), node.selfSelection);
}

function choiceValue(node) {
  const match = nodeName(node).match(/(?:^|\s)choice:([^\s]+)$/i);
  return match ? match[1] : null;
}

function applyChoice(doc, node, value, binding) {
  const choices = [node].concat(descendants(node)).map(candidate => ({
    node: candidate,
    value: choiceValue(candidate),
  })).filter(candidate => candidate.value !== null);
  if (!choices.length) throw new Error(`Layer '${binding.layer}' contains no choice:<value> layers`);
  const wanted = String(formatValue(value, binding));
  const selected = choices.filter(choice => choice.value === wanted);
  if (!selected.length) {
    throw new Error(`Layer '${binding.layer}' has no exact choice for '${wanted}'`);
  }
  for (const choice of choices) setNodeVisible(doc, choice.node, choice.value === wanted);
}

function moveNodeX(doc, node, targetX) {
  const box = node && node.spreadVisibleBox;
  if (!box || !Number.isFinite(targetX)) return;
  const dx = targetX - box.x;
  if (Math.abs(dx) > 0.01) doc.applyTransform(Transform.createTranslate(dx, 0), node.selfSelection);
}

function tokenNode(node, expected) {
  const wanted = [`forge:token:${expected}`, `token:${expected}`, `token-${expected}`];
  return descendants(node).find(candidate => wanted.includes(nodeName(candidate).trim().toLowerCase())) || null;
}

function applyTokenText(doc, node, value, binding) {
  const nodes = textNodes(node);
  if (!nodes.length) throw new Error(`Layer '${binding.layer}' contains no editable text`);
  const text = String(value || '');
  const token = text.match(/\[([a-z0-9_-]+)\]/i);
  const expected = String(binding.token || token?.[1] || '').toLowerCase();
  const graphic = tokenNode(node, expected);
  if (!token) {
    replaceText(nodes[0], text);
    styleText(doc, nodes[0], binding);
    for (let i = 1; i < nodes.length; i++) replaceText(nodes[i], '');
    if (graphic) setNodeVisible(doc, graphic, false);
    return;
  }
  const before = text.slice(0, token.index);
  const after = text.slice(token.index + token[0].length);
  if (token[1].toLowerCase() !== expected) {
    throw new Error(`Layer '${binding.layer}' supports [${expected}], not ${token[0]}`);
  }
  if (!graphic) throw new Error(`Layer '${binding.layer}' has no editable vector for [${expected}]`);
  replaceText(nodes[0], before);
  if (nodes.length > 1) replaceText(nodes[nodes.length - 1], after);
  styleText(doc, nodes[0], binding);
  if (nodes.length > 1) styleText(doc, nodes[nodes.length - 1], binding);
  setNodeVisible(doc, graphic, true);
  const prefixBox = nodes[0].spreadVisibleBox;
  if (prefixBox) moveNodeX(doc, graphic, prefixBox.x + prefixBox.width + 3);
  const graphicBox = graphic.spreadVisibleBox;
  if (graphicBox && nodes.length > 1) moveNodeX(doc, nodes[nodes.length - 1], graphicBox.x + graphicBox.width + 2);
}

function hasBaseline(binding) {
  return Object.prototype.hasOwnProperty.call(binding, 'baseline_value');
}

function isBaseline(binding) {
  return hasBaseline(binding) && JSON.stringify(binding.value ?? null) === JSON.stringify(binding.baseline_value ?? null);
}

function plainBox(box) {
  return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
}

function preflightDocument(doc, input) {
  const config = input.preflight || {};
  const documentBox = plainBox(doc.rootNode.baseBox);
  const errors = [];
  if (config.check_document_bounds !== false && documentBox) {
    const tolerance = Number(config.tolerance || 0);
    const minX = documentBox.x - tolerance;
    const minY = documentBox.y - tolerance;
    const maxX = documentBox.x + documentBox.width + tolerance;
    const maxY = documentBox.y + documentBox.height + tolerance;
    for (const binding of input.bindings) {
      if (binding.preflight === false) continue;
      const root = findNode(doc, binding);
      if (!root) continue;
      for (const node of textNodes(root)) {
        const box = plainBox(node.spreadVisibleBox);
        if (!box) continue;
        const outside = box.x < minX || box.y < minY || box.x + box.width > maxX || box.y + box.height > maxY;
        if (outside) errors.push({ field: binding.field, layer: binding.layer, reason: 'outside-document-bounds', box });
      }
    }
  }
  if (errors.length) {
    const error = new Error(`Production preflight failed: ${errors.map(item => `${item.field} exceeds the document`).join(', ')}`);
    error.preflight = { document_box: documentBox, errors };
    throw error;
  }
  return { document_box: documentBox, errors: [] };
}

function findOpenDocument(path) {
  for (const doc of Document.all) if (doc.path === path) return doc;
  return null;
}

function getDocument(input) {
  let doc = findOpenDocument(input.document.native);
  if (doc) return doc;
  if (FileSystemApi.exists(input.document.native)) return Document.load(input.document.native);
  doc = findOpenDocument(input.document.template) || Document.load(input.document.template);
  doc.saveAs(input.document.native);
  return doc;
}

function exportPng(doc, path) {
  const options = FileExportOptions.createWithPresetName('PNG');
  const records = doc.export(path, options, null, null);
  let failed = null;
  for (const record of records.all) {
    if (!record.isSuccess) failed = record.errorMessage ? `${record.errorMessage.title}: ${record.errorMessage.reason}` : 'Affinity export failed';
  }
  if (failed) throw new Error(failed);
}

function failureStatus(input, error, doc) {
  const status = {
    schema_version: 1,
    state: 'error',
    game: input && input.game,
    card_id: input && input.card && input.card.id,
    printing_id: input && input.printing_id,
    commit_sha: input && input.commit_sha,
    commit_short: input && input.commit_short,
    input_hash: input && input.input_hash,
    error: error && (error.stack || error.message || String(error)),
    updated_at: new Date().toISOString(),
  };
  if (error && error.preflight) status.preflight = error.preflight;
  if (doc) status.layer_inventory = nodeInventory(doc);
  return status;
}

function syncOnce(input, options = {}) {
  let doc = null;
  try {
    if (!input || input.kind !== 'forge-affinity-input') throw new Error('Run tools/affinity-bridge.mjs first; this source script is not configured.');
    doc = getDocument(input);
    const applied = [];
    for (const binding of input.bindings) {
      const node = findNode(doc, binding);
      if (!node) throw new Error(`Missing Affinity layer '${binding.layer}' for Forge field '${binding.field}'`);
      const baseline = isBaseline(binding);
      if (hasBaseline(binding)) setNodeVisible(doc, node, !baseline);
      if (baseline) {
        applied.push(binding.field);
        continue;
      }
      if (binding.mode === 'token-text') applyTokenText(doc, node, binding.value, binding);
      else if (binding.mode === 'choice') applyChoice(doc, node, binding.value, binding);
      else applyPlain(doc, node, binding.value, binding);
      applied.push(binding.field);
    }
    const preflight = preflightDocument(doc, input);
    doc.save();
    exportPng(doc, input.render.absolute_path);
    const status = {
      schema_version: 1,
      state: 'ready',
      game: input.game,
      card_id: input.card.id,
      printing_id: input.printing_id,
      commit_sha: input.commit_sha,
      commit_short: input.commit_short,
      input_hash: input.input_hash,
      preview_file: input.render.file,
      applied_fields: applied,
      document: input.document.native,
      preflight,
      updated_at: new Date().toISOString(),
    };
    return { changed: true, status };
  } catch (error) {
    if (!options.silent) alert(`Forge Affinity sync failed:\n${error.message || error}`);
    return { changed: false, status: failureStatus(input, error, doc) };
  }
}

// MCP execution does not invoke CommonJS exports. Keep this file directly
// executable and let the external worker decide when a new Git input exists.
console.log(JSON.stringify(syncOnce(INPUT, { silent: true })));
