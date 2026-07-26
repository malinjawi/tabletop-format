#!/usr/bin/env node
/**
 * lfs-mock-server.mjs — faithful Git LFS "basic" transfer server, ZERO deps.
 * Usage: node tools/lfs-mock-server.mjs [--port 9410] [--store DIR]
 *
 * Stands in for Forgejo's LFS endpoint in tests: implements POST /objects/batch
 * (upload+download), PUT/GET object transfer, verify — and stores blobs using the
 * EXACT R2 key layout from SPEC §7 (lfs/{oid[0:2]}/{oid[2:4]}/{oid}), so the e2e
 * suite exercises the same content-addressed structure production will have.
 * The Phase-1 spike replaces this with real Forgejo+R2; the client code doesn't change.
 */
import { createServer } from "node:http";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { oidKey } from "./lib/lfs.mjs";

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i > -1 ? args[i + 1] : d; };
const PORT = parseInt(opt("--port", "9410"), 10);
const STORE = opt("--store", "/tmp/lfs-mock-store");
const objPath = (oid) => join(STORE, oidKey(oid));

const readBody = (req) => new Promise((ok) => {
  const chunks = []; req.on("data", c => chunks.push(c));
  req.on("end", () => ok(Buffer.concat(chunks)));
});

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "POST" && url.pathname === "/objects/batch") {
      const { operation, objects } = JSON.parse((await readBody(req)).toString());
      const out = objects.map(({ oid, size }) => {
        const have = existsSync(objPath(oid));
        const o = { oid, size };
        if (operation === "upload" && !have)
          o.actions = { upload: { href: `http://localhost:${PORT}/objects/${oid}` },
                        verify: { href: `http://localhost:${PORT}/verify` } };
        if (operation === "download") {
          if (have) o.actions = { download: { href: `http://localhost:${PORT}/objects/${oid}` } };
          else o.error = { code: 404, message: "object not found" };
        }
        return o;
      });
      res.writeHead(200, { "Content-Type": "application/vnd.git-lfs+json" });
      return res.end(JSON.stringify({ transfer: "basic", objects: out }));
    }
    if (req.method === "PUT" && url.pathname.startsWith("/objects/")) {
      const oid = url.pathname.split("/").pop();
      const buf = await readBody(req);
      mkdirSync(dirname(objPath(oid)), { recursive: true });
      writeFileSync(objPath(oid), buf);
      res.writeHead(200); return res.end();
    }
    if (req.method === "GET" && url.pathname.startsWith("/objects/")) {
      const oid = url.pathname.split("/").pop();
      if (!existsSync(objPath(oid))) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      return res.end(readFileSync(objPath(oid)));
    }
    if (req.method === "POST" && url.pathname === "/verify") {
      const { oid } = JSON.parse((await readBody(req)).toString());
      res.writeHead(existsSync(objPath(oid)) ? 200 : 404); return res.end();
    }
    res.writeHead(404); res.end();
  } catch (e) { res.writeHead(500); res.end(String(e)); }
}).listen(PORT, () => console.log(`lfs-mock on :${PORT}, store=${STORE} (R2 key layout)`));
