// Production-mode qualification uses real time and isolated jam content. Never
// change the production clock or extend the actual repository's event dates.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import yaml from "js-yaml";

export function createJourneyJams(destination, at = Date.now()) {
  if (!Number.isFinite(at)) throw new Error("journey fixture time must be finite");
  const output = resolve(destination);
  if (existsSync(output)) throw new Error("journey jam destination must be new");
  mkdirSync(output, { recursive: true });
  cpSync(resolve(import.meta.dirname, "../jams"), output, { recursive: true });
  const path = join(output, "spark-jam.yaml");
  const jam = yaml.load(readFileSync(path, "utf8"));
  const date = days => new Date(at + days * 86_400_000).toISOString();
  jam.starts_at = date(-1);
  jam.submissions_close_at = date(7);
  jam.judging_ends_at = date(14);
  jam.results_at = date(15);
  writeFileSync(path, yaml.dump(jam, { lineWidth: -1 }));
  // The drill protects secrets with umask 077; this separate, non-secret
  // content mount must still be readable by the production container's UID.
  chmodSync(output, 0o755);
  for (const entry of readdirSync(output, { withFileTypes: true })) {
    if (!entry.isFile()) throw new Error("journey jams must contain only regular content files");
    chmodSync(join(output, entry.name), 0o644);
  }
  return jam;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("usage: node tools/journey-jams.mjs NEW_DIRECTORY");
  createJourneyJams(process.argv[2]);
}
