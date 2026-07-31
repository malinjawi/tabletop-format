#!/usr/bin/env node
/** sheet-mock.mjs — stands in for a published Google Sheet in tests.
 *  GET  /sheet.csv        → current CSV
 *  POST /_set             → replace the CSV (simulates the designer editing it)
 *  Usage: node tools/sheet-mock.mjs --port 4500 [--csv <file>] */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
let CSV = arg("--csv", null) ? readFileSync(arg("--csv"), "utf8")
  : "name,type,text,cost\nSpark,unit,Deal 1 damage.,1\nWall,unit,Blocks.,2\n";
createServer((req, res) => {
  if (req.method === "POST" && req.url.startsWith("/_set")) {
    let b = ""; req.on("data", d => b += d);
    req.on("end", () => { CSV = b; res.writeHead(200).end("ok"); });
    return;
  }
  if (req.url.startsWith("/html")) { res.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><html>nope</html>"); return; }
  res.writeHead(200, { "content-type": "text/csv" }).end(CSV);
}).listen(parseInt(arg("--port", "4500"), 10), () => console.error("sheet-mock up"));
