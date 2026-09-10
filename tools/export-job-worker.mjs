#!/usr/bin/env node
// One isolated export attempt. The gateway gives this process an exact,
// already-materialized source tree and a private staging directory. It has no
// database/Forge credentials; success is a checksummed manifest, not a partial
// cache directory.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { deterministicZip } from "./lib/deterministic-zip.mjs";
import { buildNandeckProject } from "./lib/nandeck-layout.mjs";
import { buildPnpinkProject } from "./lib/pnpink.mjs";
import { buildSquibProject } from "./lib/squib.mjs";
import { buildSvgDesignProject } from "./lib/svg-design.mjs";
import { buildRulebookPipeline } from "./lib/rulebook-pipeline.mjs";
import { buildRulebookPublication } from "./lib/rulebook-publication.mjs";
import { buildForgeDataWorkingCopy } from "./lib/forge-project.mjs";
import { buildComponentProduction } from "./lib/component-design.mjs";
import { buildForgeWorkbook } from "./lib/workbook.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENV_PYTHON = process.platform === "win32" ? join(ROOT, ".venv", "Scripts", "python.exe") : join(ROOT, ".venv", "bin", "python");
const PYTHON = process.env.FORGE_PYTHON || (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");
const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { source_dir: source, stage_dir: out, kind, slug, ref, public_origin: origin,
  allow_network: allowNetwork, build_pdf: buildPdf, names, budget } = input;
mkdirSync(out, { recursive: true });

const run = (command, args) => execFileSync(command, args, { stdio: "pipe", timeout: budget.child_timeout_ms,
  maxBuffer: budget.max_log_bytes });
if (kind === "pnp") {
  run(PYTHON, [join(ROOT, "tools/export_pnp.py"), source]);
  const pdf = readdirSync(join(source, "exports")).find(file => file.endsWith("-pnp.pdf"));
  if (!pdf) throw new Error("PnP exporter produced no PDF");
  cpSync(join(source, "exports", pdf), join(out, "pnp.pdf"));
} else if (kind === "print") {
  run(PYTHON, [join(ROOT, "tools/export_print_ready.py"), source, "--ref", ref]);
  const built = join(source, "exports", "print-ready"), artifact = suffix => readdirSync(built).find(file => file.endsWith(suffix));
  for (const [suffix, target] of [["-print-ready.zip", "print-ready.zip"], ["-print-at-home-a4.pdf", "print-a4.pdf"],
    ["-print-at-home-letter.pdf", "print-letter.pdf"], ["-press-rgb.pdf", "print-press-rgb.pdf"]]) {
    const found = artifact(suffix); if (!found) throw new Error(`print exporter did not produce ${suffix}`);
    cpSync(join(built, found), join(out, target));
  }
  const cmyk = artifact("-press-cmyk-pdfx1a.pdf");
  if (cmyk) cpSync(join(built, cmyk), join(out, "print-press-cmyk.pdf"));
} else if (kind === "ttc") {
  run(PYTHON, [join(ROOT, "tools/export_ttc.py"), source]);
  const zip = readdirSync(join(source, "exports/ttc")).find(file => file.endsWith("-ttc.zip"));
  if (!zip) throw new Error("Tabletop Club exporter produced no ZIP");
  cpSync(join(source, "exports/ttc", zip), join(out, names.ttc));
} else if (kind === "ttpg") {
  const built = join(source, "exports", "ttPG");
  run(PYTHON, [join(ROOT, "tools/export_ttpg.py"), source, "--ref", ref, "--output-dir", built]);
  const zip = readdirSync(built).find(file => file.includes("-ttpg-v") && file.endsWith(".zip"));
  if (!zip) throw new Error("Tabletop Playground exporter produced no ZIP");
  cpSync(join(built, zip), join(out, names.ttpg));
  cpSync(join(built, "ttpg-manifest.json"), join(out, "ttpg-manifest.json"));
} else if (kind === "project") {
  const projectOut = join(source, "exports", "forge-project");
  run(process.execPath, [join(ROOT, "tools/export-forge-project.mjs"), source, projectOut, "--source-ref", ref]);
  const zip = readdirSync(projectOut).find(file => file.endsWith(".forge-project.zip"));
  if (!zip) throw new Error("project exporter produced no .forge-project.zip");
  cpSync(join(projectOut, zip), join(out, names.project));
} else if (kind === "data") {
  const built = buildForgeDataWorkingCopy(source, { sourceRef: ref });
  writeFileSync(join(out, names.data), built.archive);
  writeFileSync(join(out, names.data_workbook), buildForgeWorkbook(built.archive).workbook);
  for (const table of ["cards", "printings", "tokens"])
    if (built.entries.has(`editable/${table}.csv`)) writeFileSync(join(out, `${table}.csv`), built.entries.get(`editable/${table}.csv`));
} else if (kind === "nandeck") {
  const built = buildNandeckProject(source, { assetPrefix: "", preferLocalArt: false });
  writeFileSync(join(out, names.nandeck), deterministicZip(built.entries));
} else if (kind === "svg") {
  const built = buildSvgDesignProject(source);
  writeFileSync(join(out, names.svg), deterministicZip(built.entries));
} else if (kind === "pnpink") {
  const built = buildPnpinkProject(source);
  writeFileSync(join(out, names.pnpink), deterministicZip(built.entries));
} else if (kind === "squib") {
  const built = buildSquibProject(source, { sourceRef: ref });
  writeFileSync(join(out, names.squib), deterministicZip(built.entries));
} else if (kind === "components") {
  const built = buildComponentProduction(source, { sourceRef: ref });
  writeFileSync(join(out, names.components), deterministicZip(built.entries));
  for (const [name, bytes] of built.entries) if (name.startsWith("cut-sheets/")) {
    const target = join(out, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes);
  }
} else if (kind === "rulebook") {
  buildRulebookPipeline(source, out, { allowNetwork, buildPdf });
} else if (kind === "publication") {
  await buildRulebookPublication(source, out, { buildPdf });
} else if (kind === "vtt") {
  const faces = join(out, "vtt-faces"); mkdirSync(faces, { recursive: true });
  run(process.execPath, [join(ROOT, "tools/render_cards.mjs"), source, faces]);
  const faceBase = `${String(origin).replace(/\/$/, "")}/cache/exports/${encodeURIComponent(slug)}/${ref}/vtt-faces`;
  run(PYTHON, [join(ROOT, "tools/export_vtt.py"), source, "--face-base-url", faceBase,
    "--out-dir", out, "--ref", ref, "--bundle-faces-dir", faces,
    "--json-name", names.vtt_json, "--package-name", names.vtt_package]);
} else if (kind === "tts") {
  const count = JSON.parse(readFileSync(join(source, "components", "printings.json"), "utf8")).length;
  const base = `${String(origin).replace(/\/$/, "")}/cache/exports/${encodeURIComponent(slug)}/${ref}`;
  run(PYTHON, [join(ROOT, "tools/export_tts.py"), source,
    "--face-url", `${base}/${count > 70 ? "sheet-{sheet}.png" : "sheet.png"}`, "--back-url", `${base}/back.png`,
    "--component-base-url", `${base}/tts-components`, "--ref", ref]);
  const tts = join(source, "exports", "tts"), save = readdirSync(tts).find(file => file.endsWith(".json") && file !== "tts-manifest.json");
  if (!save) throw new Error("TTS exporter produced no save");
  cpSync(join(tts, save), join(out, "tts.json"));
  for (const sheet of readdirSync(tts).filter(file => /^sheet(?:-\d+)?\.png$/.test(file))) cpSync(join(tts, sheet), join(out, sheet));
  cpSync(join(tts, "back.png"), join(out, "back.png"));
  cpSync(join(tts, "tts-manifest.json"), join(out, "tts-manifest.json"));
  if (existsSync(join(tts, "components"))) cpSync(join(tts, "components"), join(out, "tts-components"), { recursive: true });
} else throw new Error(`unknown export kind '${kind}'`);

const files = [];
const walk = dir => {
  for (const name of readdirSync(dir)) {
    if (name === ".job.json" || name === "forge-export-manifest.json") continue;
    const file = join(dir, name), stat = statSync(file);
    if (stat.isDirectory()) walk(file);
    else files.push({ name: relative(out, file).replaceAll("\\", "/"), bytes: stat.size,
      sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
  }
};
walk(out);
const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
if (files.length > budget.max_files) throw new Error(`export produced ${files.length} files; budget is ${budget.max_files}`);
if (bytes > budget.max_output_bytes) throw new Error(`export produced ${bytes} bytes; budget is ${budget.max_output_bytes}`);
const manifest = { format: "forge-export-attempt", version: 1, kind, exporter_version: input.exporter_version,
  slug, ref, files, totals: { files: files.length, bytes }, budget };
writeFileSync(join(out, "forge-export-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
process.stdout.write(JSON.stringify(manifest));
