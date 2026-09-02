import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

import { deterministicZip } from "./deterministic-zip.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VENV_PYTHON = process.platform === "win32" ? join(ROOT, ".venv", "Scripts", "python.exe") : join(ROOT, ".venv", "bin", "python");
const PYTHON = process.env.FORGE_PYTHON || (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");
export const RULEBOOK_PIPELINE_MANIFEST = "rules/pipeline.yaml";
export const RULEBOOK_PIPELINE_VERSION = 1;
export const RULEBOOK_SOURCE_CACHE = process.env.FORGE_RULEBOOK_SOURCE_CACHE
  || join(ROOT, "data", "rulebook-sources");

const sha256 = value => createHash("sha256").update(value).digest("hex");

function safeRel(value, label = "path") {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\"))
    throw new Error(`${label} must be a safe relative path: ${value}`);
  if (value.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error(`${label} must be a safe relative path: ${value}`);
  return value;
}

function inside(root, rel, label = "path") {
  safeRel(rel, label);
  const base = resolve(root), path = resolve(base, rel), check = relative(base, path);
  if (check === ".." || check.startsWith(`..${sep}`) || isAbsolute(check))
    throw new Error(`${label} escapes its root: ${rel}`);
  return path;
}

function walk(dir, prefix = "") {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name), rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(full, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

function validateManifest(doc) {
  if (!doc || doc.version !== RULEBOOK_PIPELINE_VERSION || !Array.isArray(doc.pipelines) || !doc.pipelines.length)
    throw new Error(`${RULEBOOK_PIPELINE_MANIFEST} is incomplete`);
  const ids = new Set();
  for (const pipeline of doc.pipelines) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(pipeline.id || "")) throw new Error(`invalid rulebook pipeline id '${pipeline.id}'`);
    if (ids.has(pipeline.id)) throw new Error(`duplicate rulebook pipeline id '${pipeline.id}'`);
    ids.add(pipeline.id);
    if (pipeline.type !== "nsg-rules-yaml") throw new Error(`unsupported rulebook adapter '${pipeline.type}'`);
    if (!pipeline.source || pipeline.source.kind !== "git") throw new Error(`pipeline '${pipeline.id}' must declare a Git source`);
    let sourceUrl;
    try { sourceUrl = new URL(pipeline.source.url); } catch { throw new Error(`pipeline '${pipeline.id}' has an invalid source URL`); }
    if (sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password)
      throw new Error(`pipeline '${pipeline.id}' source must be public HTTPS without credentials`);
    if (!/^[a-f0-9]{40}$/.test(pipeline.source.ref || ""))
      throw new Error(`pipeline '${pipeline.id}' source must be pinned to a 40-character commit`);
    if (pipeline.overlay_root && !pipeline.overlay_root.startsWith("rules/"))
      throw new Error(`pipeline '${pipeline.id}' overlay_root must stay under rules/`);
    if (!Array.isArray(pipeline.outputs) || !pipeline.outputs.length)
      throw new Error(`pipeline '${pipeline.id}' must declare outputs`);
  }
  if (!ids.has(doc.active)) throw new Error(`active rulebook pipeline '${doc.active}' does not exist`);
  const active = doc.pipelines.find(pipeline => pipeline.id === doc.active);
  if (active.status !== "active") throw new Error(`active rulebook pipeline '${doc.active}' must have status active`);
  if (doc.pipelines.filter(pipeline => pipeline.status === "active").length !== 1)
    throw new Error(`exactly one rulebook pipeline must have status active`);
  return doc;
}

export function loadRulebookPipeline(gameDir) {
  const path = join(resolve(gameDir), RULEBOOK_PIPELINE_MANIFEST);
  if (!existsSync(path)) return null;
  const registry = validateManifest(yaml.load(readFileSync(path, "utf8")));
  const active = registry.pipelines.find(pipeline => pipeline.id === registry.active);
  const overlayRoot = active.overlay_root ? inside(gameDir, active.overlay_root, "overlay_root") : null;
  const overlayFiles = overlayRoot ? walk(overlayRoot).map(rel => `${active.overlay_root}/${rel}`) : [];
  return {
    manifest_path: RULEBOOK_PIPELINE_MANIFEST,
    registry,
    active,
    overlay_files: overlayFiles,
    source_lock: `git:${active.source.url}#${active.source.ref}`,
  };
}

export function rulebookPipelineMetadata(loaded) {
  if (!loaded) return null;
  const { registry, active } = loaded;
  return {
    version: registry.version,
    active: registry.active,
    manifest_path: loaded.manifest_path,
    source_lock: loaded.source_lock,
    overlay_files: loaded.overlay_files,
    pipeline: {
      id: active.id,
      type: active.type,
      label: active.label,
      description: active.description || "",
      status: active.status,
      overlay_root: active.overlay_root || null,
      source: active.source,
      native_inputs: active.native_inputs || [],
      outputs: active.outputs,
    },
  };
}

function sourceCachePath(source) {
  const key = sha256(`${source.url}\n${source.ref}`).slice(0, 24);
  return join(RULEBOOK_SOURCE_CACHE, key);
}

function ensureSource(source, { allowNetwork = false } = {}) {
  const cachePath = sourceCachePath(source);
  if (existsSync(join(cachePath, ".git"))) {
    const got = execFileSync("git", ["-C", cachePath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (got === source.ref) return { path: cachePath, fetched: false };
    rmSync(cachePath, { recursive: true, force: true });
  }
  if (!allowNetwork) throw new Error("native rulebook source is not cached; build once with network access enabled");
  const url = new URL(source.url);
  // The initial adapter deliberately accepts GitHub only. Expanding this is a
  // security decision, not a manifest edit: server-side Git fetches must not
  // become an SSRF or credential surface.
  if (url.hostname.toLowerCase() !== "github.com") throw new Error("native rulebook Git sources are currently restricted to github.com");
  mkdirSync(dirname(cachePath), { recursive: true });
  const temp = mkdtempSync(join(dirname(cachePath), ".fetch-"));
  try {
    execFileSync("git", ["init", "-q", temp], { stdio: "pipe" });
    execFileSync("git", ["-C", temp, "remote", "add", "origin", source.url], { stdio: "pipe" });
    execFileSync("git", ["-C", temp, "fetch", "-q", "--depth", "1", "origin", source.ref], { stdio: "pipe" });
    execFileSync("git", ["-C", temp, "checkout", "-q", "--detach", "FETCH_HEAD"], { stdio: "pipe" });
    const got = execFileSync("git", ["-C", temp, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (got !== source.ref) throw new Error(`native rulebook source resolved to ${got}, expected ${source.ref}`);
    rmSync(join(temp, ".git", "hooks"), { recursive: true, force: true });
    cpSync(temp, cachePath, { recursive: true });
  } finally { rmSync(temp, { recursive: true, force: true }); }
  return { path: cachePath, fetched: true };
}

const NSG_OVERLAY_PREFIXES = ["data/input/", "data/changelogs/", "data/images/", "data/templates/"];
function applyOverlay(gameDir, pipeline, workDir) {
  if (!pipeline.overlay_root) return [];
  const root = inside(gameDir, pipeline.overlay_root, "overlay_root"), applied = [];
  for (const rel of walk(root)) {
    const target = rel === "config.yaml" || NSG_OVERLAY_PREFIXES.some(prefix => rel.startsWith(prefix));
    if (!target) throw new Error(`unsupported NSG rulebook overlay path '${rel}'`);
    const from = inside(root, rel, "overlay file"), to = inside(workDir, rel, "overlay destination");
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    applied.push(`${pipeline.overlay_root}/${rel}`);
  }
  return applied;
}

function enableExtraNsgChapters(workDir, pipeline, overlays) {
  const prefix = `${pipeline.overlay_root}/data/input/`;
  const extras = overlays.filter(path => path.startsWith(prefix) && path.endsWith(".yaml"))
    .map(path => basename(path, ".yaml"));
  if (!extras.length) return [];
  const parserPath = join(workDir, "rules_doc_generator", "input", "yaml", "parser.py");
  const marker = "  chapters = list(map(read_chapter_from_file, chapter_files))";
  const source = readFileSync(parserPath, "utf8");
  if (!source.includes(marker)) throw new Error("pinned NSG adapter no longer exposes the expected chapter list");
  const unique = [...new Set(extras)].sort();
  writeFileSync(parserPath, source.replace(marker,
    `  chapter_files += ${JSON.stringify(unique)}  # Forge game-owned native chapters\n${marker}`));
  return unique;
}

function copyIfExists(from, to) {
  if (!existsSync(from)) return false;
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { recursive: true });
  return true;
}

function outputRecord(path, id, format, label) {
  const bytes = readFileSync(path);
  return { id, label, format, file: basename(path), size: bytes.length, sha256: sha256(bytes) };
}

function nativeSourceBundle(gameDir, loaded) {
  const entries = new Map();
  const add = rel => {
    const path = inside(gameDir, rel, "rulebook package file");
    if (existsSync(path) && lstatSync(path).isFile()) entries.set(rel, readFileSync(path));
  };
  add(loaded.manifest_path);
  for (const rel of loaded.overlay_files) add(rel);
  const readme = `Forge native rulebook source package\n\nPipeline: ${loaded.active.label}\nAdapter: ${loaded.active.type}\nSource: ${loaded.active.source.url}\nPinned commit: ${loaded.active.source.ref}\nLicense status: ${loaded.active.source.license_status}\n\nThe upstream source is locked by URL and commit rather than copied into this package.\nGame-owned native overlays, when present, are included under ${loaded.active.overlay_root || "rules/"}.\n`;
  entries.set("README.txt", Buffer.from(readme));
  return deterministicZip(entries);
}

export function buildRulebookPipeline(gamePath, outPath, {
  allowNetwork = false,
  buildPdf = true,
  dockerImage = process.env.FORGE_RULEBOOK_DOCKER_IMAGE || "forge-rulebook-nsg:1",
} = {}) {
  const gameDir = resolve(gamePath), outDir = resolve(outPath), loaded = loadRulebookPipeline(gameDir);
  if (!loaded) throw new Error(`game has no ${RULEBOOK_PIPELINE_MANIFEST}`);
  const pipeline = loaded.active;
  if (pipeline.type !== "nsg-rules-yaml") throw new Error(`unsupported rulebook adapter '${pipeline.type}'`);
  const source = ensureSource(pipeline.source, { allowNetwork });
  const sourceDateEpoch = execFileSync("git", ["-C", source.path, "show", "-s", "--format=%ct", pipeline.source.ref], { encoding: "utf8" }).trim();
  const reproducibleEnv = { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch, FORCE_SOURCE_DATE: "1" };
  const tempRoot = mkdtempSync(join(tmpdir(), "forge-rulebook-")), workDir = join(tempRoot, "source");
  let compiler = null;
  try {
    cpSync(source.path, workDir, { recursive: true, filter: path => !path.includes(`${sep}.git${sep}`) && !path.endsWith(`${sep}.git`) });
    const overlays = applyOverlay(gameDir, pipeline, workDir);
    const extraChapters = enableExtraNsgChapters(workDir, pipeline, overlays);
    // Generate the native intermediate formats with the upstream generator.
    execFileSync(PYTHON, ["-X", "utf8", "-m", "rules_doc_generator"], { cwd: workDir, stdio: "pipe" });
    if (buildPdf) {
      let latexmk = null;
      try { latexmk = execFileSync("sh", ["-lc", "command -v latexmk"], { encoding: "utf8" }).trim(); } catch {}
      if (latexmk) {
        compiler = "latexmk";
        for (const folder of ["latex", "latex_annotated"]) {
          if (!existsSync(join(workDir, folder))) continue;
          const tex = readdirSync(join(workDir, folder)).find(file => file.endsWith(".tex"));
          if (tex) execFileSync(latexmk, ["-pdf", "-shell-escape", `-jobname=${folder}/%A`, `${folder}/${tex}`], { cwd: workDir, stdio: "pipe", env: reproducibleEnv });
        }
      } else {
        let tectonic = null, rsvg = null;
        try { tectonic = execFileSync("sh", ["-lc", "command -v tectonic"], { encoding: "utf8" }).trim(); } catch {}
        try { rsvg = execFileSync("sh", ["-lc", "command -v rsvg-convert"], { encoding: "utf8" }).trim(); } catch {}
        if (tectonic && rsvg) {
          compiler = "tectonic+rsvg";
          for (const file of readdirSync(join(workDir, "data", "images")).filter(file => file.endsWith(".svg")))
            execFileSync(rsvg, ["-f", "pdf", "--width", "256", "--height", "256", "--keep-aspect-ratio", "-o", join(workDir, "data", "images", `${basename(file, ".svg")}.pdf`), join(workDir, "data", "images", file)], { stdio: "pipe" });
          for (const folder of ["latex", "latex_annotated"]) {
            if (!existsSync(join(workDir, folder))) continue;
            const tex = readdirSync(join(workDir, folder)).find(file => file.endsWith(".tex"));
            if (!tex) continue;
            const texPath = join(workDir, folder, tex), original = readFileSync(texPath, "utf8");
            writeFileSync(texPath, original
              .replace("\\usepackage[sfdefault]{atkinson}\n\\usepackage[T1]{fontenc}", "\\usepackage[T1]{fontenc}\n\\usepackage[sfdefault]{atkinson}")
              .replace("\\usepackage{svg}", "% SVGs preconverted by Forge's Tectonic adapter")
              .replace("\\DeclareUnicodeCharacter{25C6}{$\\blacklozenge$}", "% Unicode diamond normalized by Forge's Tectonic adapter")
              .replace("\\graphicspath{{data/images/}}", "\\graphicspath{{../data/images/}}")
              .replaceAll("◆", "$\\blacklozenge$")
              .replaceAll("\\includesvg", "\\includegraphics"));
            execFileSync(tectonic, ["--keep-logs", "--outdir", folder, `${folder}/${tex}`], { cwd: workDir, stdio: "pipe", timeout: 10 * 60_000, env: reproducibleEnv });
          }
        } else {
          compiler = "docker+latexmk";
          try { execFileSync("docker", ["image", "inspect", dockerImage], { stdio: "ignore" }); }
          catch { execFileSync("docker", ["build", "-q", "-t", dockerImage, "."], { cwd: workDir, stdio: "pipe", timeout: 20 * 60_000 }); }
          const mount = `${workDir}:/workdir`;
          const command = [
            "set -eu",
            "for d in latex latex_annotated; do",
            "  [ -d \"$d\" ] || continue",
            "  f=$(find \"$d\" -maxdepth 1 -name '*.tex' -print -quit)",
            "  [ -n \"$f\" ] || continue",
            "  latexmk -pdf -shell-escape -jobname=\"$d/%A\" \"$f\"",
            "done",
          ].join("\n");
          execFileSync("docker", ["run", "--rm", "--network", "none", "-e", `SOURCE_DATE_EPOCH=${sourceDateEpoch}`, "-e", "FORCE_SOURCE_DATE=1", "-v", mount, "-w", "/workdir", dockerImage, "bash", "-lc", command], { stdio: "pipe", timeout: 10 * 60_000 });
        }
      }
    }

    mkdirSync(outDir, { recursive: true });
    const outputs = [];
    const html = join(workDir, "html", "rules.html");
    if (copyIfExists(html, join(outDir, "rules.html"))) outputs.push(outputRecord(join(outDir, "rules.html"), "web", "html", "Official web rules"));
    for (const asset of ["rules.css", "extended.css", "rules.js", "click.svg", "credit.svg", "interrupt.svg", "link.svg", "mu.svg", "recurring.svg", "rez.svg", "sub.svg", "trash.svg", "trashcost.svg", "preview_placeholder.jpg"])
      copyIfExists(join(workDir, "html", asset), join(outDir, asset));
    const json = join(workDir, "json", "rules.json");
    if (copyIfExists(json, join(outDir, "rules.json"))) outputs.push(outputRecord(join(outDir, "rules.json"), "structured", "json", "Structured rules JSON"));
    const tex = existsSync(join(workDir, "latex")) ? readdirSync(join(workDir, "latex")).find(file => file.endsWith(".tex")) : null;
    if (tex && copyIfExists(join(workDir, "latex", tex), join(outDir, "rules.tex"))) outputs.push(outputRecord(join(outDir, "rules.tex"), "latex", "tex", "Production LaTeX"));
    const normalPdf = existsSync(join(workDir, "latex")) ? readdirSync(join(workDir, "latex")).find(file => file.endsWith(".pdf")) : null;
    if (normalPdf && copyIfExists(join(workDir, "latex", normalPdf), join(outDir, "rules.pdf"))) outputs.push(outputRecord(join(outDir, "rules.pdf"), "pdf", "pdf", "Official-style rules PDF"));
    const annotatedPdf = existsSync(join(workDir, "latex_annotated")) ? readdirSync(join(workDir, "latex_annotated")).find(file => file.endsWith(".pdf")) : null;
    if (annotatedPdf && copyIfExists(join(workDir, "latex_annotated", annotatedPdf), join(outDir, "rules-annotated.pdf"))) outputs.push(outputRecord(join(outDir, "rules-annotated.pdf"), "annotated-pdf", "pdf", "Annotated changes PDF"));
    const sourceZipPath = join(outDir, "rules-source.zip");
    writeFileSync(sourceZipPath, nativeSourceBundle(gameDir, loaded));
    outputs.push(outputRecord(sourceZipPath, "native-source", "zip", "Native source package"));
    if (!outputs.some(output => output.format === "html")) throw new Error("native rulebook generator did not produce HTML");
    if (buildPdf && !outputs.some(output => output.id === "pdf")) throw new Error("native rulebook generator did not produce the PDF");

    const build = {
      format: "forge-rulebook-build",
      version: 1,
      adapter: pipeline.type,
      pipeline: pipeline.id,
      compiler,
      source_date_epoch: sourceDateEpoch,
      source: { ...pipeline.source, fetched: source.fetched },
      overlays,
      extra_chapters: extraChapters,
      deterministic_input: `sha256:${sha256(Buffer.from(`${loaded.source_lock}\n${overlays.map(rel => `${rel}:${sha256(readFileSync(inside(gameDir, rel)))}`).join("\n")}`))}`,
      outputs,
    };
    writeFileSync(join(outDir, "rulebook-build.json"), `${JSON.stringify(build, null, 2)}\n`);
    return { outDir, build, loaded };
  } finally { rmSync(tempRoot, { recursive: true, force: true }); }
}
