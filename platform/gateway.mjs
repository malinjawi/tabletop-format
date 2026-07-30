/**
 * gateway.mjs — the API gateway kernel. ZERO dependencies (~90 lines).
 *
 * The connective tissue the stores plug into: a middleware pipeline
 * (CORS → rate-limit → readonly-gate → auth-attach → route → error envelope),
 * a route table with :params, structured request logs, /healthz, and a
 * self-documenting GET /api index generated from the table itself.
 * This is Block G's shape; Fastify can replace the kernel later without
 * touching a single route handler (they only see ctx).
 */
import { createServer } from "node:http";

export function createGateway({ name = "gateway", version = "0" } = {}) {
  const routes = [];   // {method, pattern, parts, handler, desc}
  const middleware = [];

  function route(method, pattern, handler, desc = "") {
    routes.push({ method, pattern, parts: pattern.split("/").filter(Boolean), handler, desc });
  }
  const use = (fn) => middleware.push(fn);

  function match(method, pathParts) {
    outer: for (const r of routes) {
      if (r.method !== method) continue;
      const params = {};
      const wild = r.parts[r.parts.length - 1] === "*";
      if (!wild && r.parts.length !== pathParts.length) continue;
      if (wild && pathParts.length < r.parts.length - 1) continue;
      for (let i = 0; i < r.parts.length; i++) {
        const rp = r.parts[i];
        if (rp === "*") { params["*"] = pathParts.slice(i).map(decodeURIComponent).join("/"); break; }
        if (rp.startsWith(":")) params[rp.slice(1)] = decodeURIComponent(pathParts[i] ?? "");
        else if (rp !== pathParts[i]) continue outer;
      }
      return { r, params };
    }
    return null;
  }

  function listen(port, cb, _tries = 0) {
    const server = createServer(async (req, res) => {
      const t0 = Date.now();
      const url = new URL(req.url, `http://localhost:${port}`);
      const parts = url.pathname.split("/").filter(Boolean);
      const ctx = {
        req, res, url, params: {},
        body: null,
        sent: false,
        send(code, body, type = "application/json") {
          if (ctx.sent) return; ctx.sent = true;
          const data = type === "application/json" ? JSON.stringify(body, null, 2) : body;
          res.writeHead(code, { "content-type": type,
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
            "access-control-allow-headers": "content-type, authorization" });
          res.end(data);
          console.log(`${req.method} ${url.pathname} ${code} ${Date.now() - t0}ms`);
        },
        sendRaw(code, buf, headers) {
          if (ctx.sent) return; ctx.sent = true;
          res.writeHead(code, { "access-control-allow-origin": "*", ...headers });
          res.end(buf);
          console.log(`${req.method} ${url.pathname} ${code} ${Date.now() - t0}ms`);
        },
      };
      try {
        for (const m of middleware) { await m(ctx); if (ctx.sent) return; }
        if (url.pathname === "/healthz")
          return ctx.send(200, { ok: true, name, version, uptime_s: Math.round(process.uptime()) });
        if (url.pathname === "/api" && req.method === "GET")
          return ctx.send(200, { name, version, routes: routes.map(r => `${r.method} ${r.pattern}${r.desc ? "  — " + r.desc : ""}`) });
        const m = match(req.method, parts);
        if (!m) return ctx.send(404, { error: "not found", hint: "GET /api lists routes" });
        ctx.params = m.params;
        await m.r.handler(ctx);
        if (!ctx.sent) ctx.send(500, { error: "handler sent nothing" });
      } catch (e) {
        if (!ctx.sent) ctx.send(500, { error: String(e.message ?? e) });
        else console.error("post-send error:", e.message);
      }
    });
    server.on("error", (e) => {
      if (e.code === "EADDRINUSE" && _tries < 20) {
        console.error(`port ${port} in use — trying ${port + 1}…`);
        setTimeout(() => listen(port + 1, cb, _tries + 1), 0);
      } else throw e;
    });
    server.listen(port, () => { if (cb) cb(port); });
    return server;
  }

  return { route, use, listen };
}

export const readBody = (req, maxBytes = 1024 * 1024) => new Promise((ok, no) => {
  const chunks = []; let n = 0;
  req.on("data", c => { n += c.length; if (n > maxBytes) { no(new Error("body too large")); req.destroy(); return; } chunks.push(c); });
  req.on("end", () => ok(Buffer.concat(chunks)));
});
