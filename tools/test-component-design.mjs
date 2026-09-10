#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildComponentProduction, componentDialValues, componentFamily, componentQuantity, defaultComponentDesign, loadComponentDesign, renderComponentSvg } from "./lib/component-design.mjs";
import { analyzeComponentSvgImport, buildComponentSvgProject, parseComponentSvg } from "./lib/component-svg.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const game = join(root, "examples", "ember"), pieces = JSON.parse(await (await import("node:fs/promises")).readFile(join(game, "components/tokens.json"), "utf8"));
const design = loadComponentDesign(game);
assert.equal(design.version, 1);
assert.equal(componentFamily(design, pieces[0]).id, "ember-token");
assert.equal(componentFamily(design, pieces[2]).id, "ember-dial");
assert.equal(componentFamily(defaultComponentDesign(), { kind: "token", template_id: "square-tile" }).id, "square-tile",
  "an explicit family binding must win over the first matching kind family");
assert.equal(componentQuantity(pieces[0], design), 20);
assert.equal(componentQuantity(pieces[1], design), 6);

const spark = renderComponentSvg(game, pieces[0], design);
assert.match(spark, /width="24mm" height="24mm"/);
assert.match(spark, /data-forge-piece="spark_token"/);
assert.match(spark, /data-forge-area="bleed"/);
assert.match(spark, /data-forge-guide="trim"/);
assert.doesNotMatch(spark, /data-forge-guide="safe"/, "safe-area guidance must not print on production faces");
assert.match(spark, />SPARK<|>spark</i);
const ashBack = renderComponentSvg(game, pieces[1], design, { side: "back" });
assert.match(ashBack, /data-forge-side="back"/);
assert.match(ashBack, />SPENT ASH</);
assert.deepEqual(componentDialValues(pieces[2]), [5, 6, 7, 8, 9]);
const dial = renderComponentSvg(game, pieces[2], design);
assert.match(dial, /data-forge-dial-scale="5,6,7,8,9"/);
assert.match(dial, /data-forge-hardware-guide="center-hole"/);
assert.deepEqual(componentDialValues({ kind: "dial", attributes: { start_value: 0, max_value: 100, step: 1 } }), []);
const counter = renderComponentSvg(game, { id: "round_counter", name: "Health", kind: "counter",
  quantity: 1, attributes: { start_value: 3 }, size_mm: { width: 20, height: 20 } }, design);
assert.match(counter, /data-forge-counter-value="start"[^>]*>3</);
assert.doesNotMatch(counter, />◆</);

const first = buildComponentProduction(game, { sourceRef: "abc123" });
const second = buildComponentProduction(game, { sourceRef: "abc123" });
assert.equal(first.manifest.profile, "forge-component-production");
assert.equal(first.manifest.source_ref, "abc123");
assert.deepEqual(first.manifest.totals, { piece_types: 3, declared_physical_pieces: 17,
  physical_pieces: 28, printed_faces: 34,
  front_pages: 1, back_pages: 1, large_piece_pages: 0, setup_maps: 0, pages: 2 });
assert.deepEqual(first.manifest.excluded_from_cut_sheets, []);
assert.equal(first.manifest.pieces[0].per_player, true);
assert.equal(first.manifest.pieces[0].declared_quantity, 10);
assert.equal(first.manifest.pieces[0].resolved_quantity, 20);
assert.deepEqual(first.manifest.quantity_resolution, { status: "resolved", player_count: 2,
  rule: "Pieces marked per_player are multiplied by the versioned production.player_count." });
assert(first.entries.has("faces/spark_token.svg"));
assert(first.entries.has("faces/flame_dial.svg"));
assert(first.entries.has("faces/ash_token-back.svg"));
assert(first.entries.has("cut-sheets/01-a4.svg"));
assert(first.entries.has("cut-sheets/01-a4-back.svg"));
assert(first.entries.has("family-templates/ember-token.svg"));
assert(first.entries.has("family-templates/manifest.json"));
assert.match(first.entries.get("cut-sheets/01-a4.svg").toString(), /data-forge-page="1"/);
assert.match(first.entries.get("cut-sheets/01-a4-back.svg").toString(), /data-forge-duplex="long-edge-mirrored"/);
assert.equal(first.manifest.pieces.find(piece => piece.id === "ash_token").sides, 2);
assert.equal(first.manifest.duplex.print_scale, "100%");
assert.equal(first.manifest.family_templates.length, 2);
assert(first.manifest.family_round_trip.supported.includes("move and resize declared region boxes"));
assert.deepEqual([...first.entries.entries()].map(([name, bytes]) => [name, bytes.toString()]),
  [...second.entries.entries()].map(([name, bytes]) => [name, bytes.toString()]));

const svgKit = buildComponentSvgProject(design, pieces, { sourceRef: "abc123" });
const familySvg = svgKit.entries.get("family-templates/ember-token.svg").toString();
const parsed = parseComponentSvg(familySvg);
assert.equal(parsed.meta.family, "ember-token");
assert.equal(parsed.objects, 2);
assert.equal(analyzeComponentSvgImport(design, familySvg).changes.length, 0, "untouched family SVG must be a no-op");
const editedSvg = familySvg
  .replace('fill="#2d1d18"', 'fill="#123456"')
  .replace('data-forge-component-region="name"', 'data-forge-component-region="name" transform="translate(1,0)"');
const edited = analyzeComponentSvgImport(design, editedSvg);
assert.equal(edited.conflicts.length, 0);
assert.deepEqual(edited.changes.map(change => change.path), ["style.fill", "regions.name.x"]);
assert.equal(edited.candidate.families[0].style.fill, "#123456");
assert.equal(edited.candidate.families[0].regions.find(region => region.id === "name").x, 18);
const concurrent = structuredClone(design); concurrent.families[0].style.fill = "#654321";
const conflict = analyzeComponentSvgImport(concurrent, editedSvg);
assert.equal(conflict.stale, true);
assert.deepEqual(conflict.conflicts.map(item => item.path), ["style.fill"]);
assert.throws(() => parseComponentSvg(familySvg.replace("</svg>", "<script>alert(1)</script></svg>")), /unsafe/);
assert.throws(() => parseComponentSvg(familySvg.replace("</svg>", '<path d="M0 0 L5 5"/></svg>')), /unmapped path/);
assert.throws(() => parseComponentSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), /missing Forge component metadata/);

const posterGame = mkdtempSync(join(tmpdir(), "forge-component-poster-"));
try {
  mkdirSync(join(posterGame, "components"), { recursive: true });
  mkdirSync(join(posterGame, "templates"), { recursive: true });
  mkdirSync(join(posterGame, "setups"), { recursive: true });
  mkdirSync(join(posterGame, "assets", "components"), { recursive: true });
  mkdirSync(join(posterGame, "forge"), { recursive: true });
  writeFileSync(join(posterGame, "game.yaml"), "id: poster-test\ntitle: Poster test\nsymbols: []\n");
  writeFileSync(join(posterGame, "assets", "components", "map.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
  writeFileSync(join(posterGame, "forge", "rights.json"), JSON.stringify({ format: "forge-rights", version: 1,
    project: { license: "CC-BY-4.0", owner: "Poster maker" }, default: { license: "CC-BY-4.0", status: "original",
      copyright: ["Poster maker"], redistribution: "allowed" }, files: [] }, null, 2));
  writeFileSync(join(posterGame, "components", "tokens.json"), JSON.stringify([{
    id: "marker_before", name: "Marker before board", kind: "token", template_id: "round-token", quantity: 20,
    size_mm: { width: 20, height: 20 }, description: "Fills rows before an oversized piece",
  }, {
    id: "map_board", name: "Map board", kind: "board", template_id: "generic-piece", quantity: 1,
    size_mm: { width: 310, height: 220 }, art: "assets/components/map.png", description: "Oversize manufacturing proof",
  }, {
    id: "marker_after", name: "Marker after board", kind: "token", template_id: "round-token", quantity: 1,
    size_mm: { width: 20, height: 20 }, description: "Must remain on the same compact cut sheet",
  }], null, 2));
  const posterDesign = defaultComponentDesign();
  posterDesign.production.large_piece_overlap_mm = 10;
  writeFileSync(join(posterGame, "templates", "component-design.json"), JSON.stringify(posterDesign, null, 2));
  writeFileSync(join(posterGame, "setups", "table.yaml"), `schema_version: 1
id: poster-table
name: Poster table
board: { width: 1600, height: 1000, background: "#17211f" }
seats:
  - { id: player-one, name: Player one, position: { x: 800, y: 950 } }
zones:
  - { id: center, name: Center, kind: play, position: { x: 300, y: 200 }, size: { width: 1000, height: 600 } }
stacks: []
pieces:
  - { id: map-board-piece, component_id: map_board, position: { x: 800, y: 500 }, rotation: 90 }
`);
  const poster = buildComponentProduction(posterGame, { sourceRef: "poster123" });
  assert.deepEqual(poster.manifest.excluded_from_standard_cut_sheets, ["map_board"]);
  assert.deepEqual(poster.manifest.excluded_from_cut_sheets, []);
  assert.equal(poster.manifest.large_piece_tiles[0].columns, 2);
  assert.equal(poster.manifest.large_piece_tiles[0].rows, 1);
  assert.equal(poster.manifest.large_piece_tiles[0].overlap_mm, 10);
  assert.equal(poster.manifest.totals.large_piece_pages, 2);
  assert.equal(poster.manifest.totals.front_pages, 1,
    "an oversized piece between small pieces must not force a mostly empty extra cut sheet");
  assert.equal(poster.manifest.totals.setup_maps, 1);
  assert.equal(poster.manifest.totals.pages, 4);
  assert.match(poster.entries.get("cut-sheets/01-a4.svg").toString(), /Marker before board/);
  assert.match(poster.entries.get("cut-sheets/01-a4.svg").toString(), /Marker after board/);
  assert(poster.entries.has("large-pieces/map_board-01-front-r1c1-a4.svg"));
  assert.match(poster.entries.get("large-pieces/map_board-01-front-r1c2-a4.svg").toString(),
    /data-forge-column="2"[^>]+data-forge-overlap-mm="10"/);
  assert(poster.entries.has("setup-maps/poster-table.svg"));
  assert.match(poster.entries.get("setup-maps/poster-table.svg").toString(),
    /data-forge-component-placement="map-board-piece"/);
  assert.deepEqual(poster.manifest.setup_maps[0].placements[0], { id: "map-board-piece", component_id: "map_board",
    quantity: 1, position: { x: 800, y: 500 }, rotation: 90, face: "front" });
  assert(poster.manifest.source_files.includes("setups/table.yaml"));
  assert(poster.manifest.source_files.includes("assets/components/map.png"));
  assert.equal(poster.manifest.pieces.find(piece => piece.id === "map_board").artwork[0].rights.status, "original");
  assert.equal(poster.manifest.artwork_rights.dependencies[0].copyright[0], "Poster maker");
} finally { rmSync(posterGame, { recursive: true, force: true }); }

console.log("component families → bounded SVG round trip → faces → quantity-aware cut sheets → oversize poster tiles verified");
