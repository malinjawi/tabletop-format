import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "../..");
const VENV_PYTHON = process.platform === "win32" ? join(ROOT, ".venv", "Scripts", "python.exe") : join(ROOT, ".venv", "bin", "python");
const PYTHON = process.env.FORGE_PYTHON || (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");
export const FORGE_WORKBOOK_FORMAT = "forge-tabular-workbook";
export const FORGE_WORKBOOK_VERSION = 1;
export const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;

function run(args) {
  try {
    return execFileSync(PYTHON, [join(ROOT, "tools", "workbook_adapter.py"), ...args], {
      cwd: ROOT, encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const raw = String(error.stderr || error.stdout || error.message || error).trim();
    try { throw new Error(JSON.parse(raw).error || raw); }
    catch (parsed) { if (parsed instanceof SyntaxError) throw new Error(raw || "workbook adapter failed"); throw parsed; }
  }
}

export function buildForgeWorkbook(projectArchive) {
  const temp = mkdtempSync(join(tmpdir(), "forge-workbook-build-"));
  try {
    const project = join(temp, "working-copy.zip"), output = join(temp, "working-copy.xlsx");
    writeFileSync(project, projectArchive);
    const metadata = JSON.parse(run(["export", project, output]));
    return { metadata, workbook: readFileSync(output) };
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function inspectForgeWorkbook(source) {
  if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array)) throw new Error("workbook source must be bytes");
  if (source.length > MAX_WORKBOOK_BYTES) throw new Error("workbook is larger than 10 MB");
  const temp = mkdtempSync(join(tmpdir(), "forge-workbook-read-"));
  try {
    const workbook = join(temp, "returned.xlsx"), output = join(temp, "inspection.json");
    writeFileSync(workbook, source);
    run(["inspect", workbook, output]);
    const parsed = JSON.parse(readFileSync(output, "utf8"));
    if (parsed.format !== FORGE_WORKBOOK_FORMAT || parsed.version !== FORGE_WORKBOOK_VERSION)
      throw new Error(`unsupported Forge workbook format ${parsed.format} v${parsed.version}`);
    return parsed;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

export function inspectWorkbookCandidate(source) {
  if (!Buffer.isBuffer(source) && !(source instanceof Uint8Array)) throw new Error("workbook source must be bytes");
  if (source.length > MAX_WORKBOOK_BYTES) throw new Error("workbook is larger than 10 MB");
  const temp = mkdtempSync(join(tmpdir(), "forge-workbook-candidate-"));
  try {
    const workbook = join(temp, "candidate.xlsx"), output = join(temp, "candidate.json");
    writeFileSync(workbook, source);
    run(["inspect-candidate", workbook, output]);
    const parsed = JSON.parse(readFileSync(output, "utf8"));
    if (parsed.format !== "forge-workbook-candidate" || parsed.version !== 1)
      throw new Error(`unsupported workbook candidate ${parsed.format} v${parsed.version}`);
    return parsed;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
