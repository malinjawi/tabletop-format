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
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { pipeline } from "node:stream/promises";

export function createGateway({ name = "gateway", version = "0", allowedOrigins = [], production = false,
  https = false, host = undefined, health = {} } = {}) {
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
      const requestId = String(req.headers["x-request-id"] || randomUUID()).slice(0, 128);
      const origin = String(req.headers.origin || "");
      const corsOrigin = origin && allowedOrigins.includes(origin) ? origin : "";
      const securityHeaders = {
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "strict-origin-when-cross-origin",
        "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
        "content-security-policy": "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; script-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:",
        ...(https ? { "strict-transport-security": "max-age=31536000; includeSubDomains" } : {}),
        "x-request-id": requestId,
      };
      const responseAbort=new AbortController();
      res.once("close",()=>{if(!res.writableFinished)responseAbort.abort();});
      const ctx = {
        req, res, url, params: {},
        signal:responseAbort.signal,
        body: null,
        sent: false,
        requestId,
        corsOrigin,
        headers: {},
        setHeader(name, value) { ctx.headers[String(name).toLowerCase()] = value; },
        send(code, body, type = "application/json") {
          if (ctx.sent) return; ctx.sent = true;
          const data = type === "application/json" ? JSON.stringify(body, null, 2) : body;
          const raw = Buffer.from(data ?? ""), compress = raw.length >= 1024
            && /^(text\/|application\/(json|javascript))/.test(type)
            && /(?:^|,)\s*gzip(?:\s*;|\s*,|$)/i.test(String(req.headers["accept-encoding"] || ""));
          const payload = compress ? gzipSync(raw, { level: 6 }) : raw;
          res.writeHead(code, { ...securityHeaders, ...ctx.headers,
            "content-type": type, "content-length": String(payload.length), "vary": corsOrigin ? "Accept-Encoding, Origin" : "Accept-Encoding",
            ...(compress ? { "content-encoding": "gzip" } : {}),
            ...(corsOrigin ? { "access-control-allow-origin": corsOrigin,
              "access-control-allow-credentials": "true",
              "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
              "access-control-allow-headers": "content-type, authorization, x-forge-browser" } : {}) });
          res.end(payload);
          console.log(`${requestId} ${req.method} ${url.pathname} ${code} ${Date.now() - t0}ms`);
        },
        async sendStream(code,stream,headers) {
          if(ctx.sent||responseAbort.signal.aborted){stream.destroy();return;}
          ctx.sent=true;
          res.writeHead(code,{...securityHeaders,...ctx.headers,
            ...(corsOrigin?{"access-control-allow-origin":corsOrigin,"access-control-allow-credentials":"true","vary":"Origin"}:{}),...headers});
          try{await pipeline(stream,res,{signal:responseAbort.signal});}
          finally{console.log(`${requestId} ${req.method} ${url.pathname} ${code} ${Date.now()-t0}ms`);}
        },
        sendRaw(code, buf, headers) {
          if (ctx.sent) return; ctx.sent = true;
          res.writeHead(code, { ...securityHeaders, ...ctx.headers,
            ...(corsOrigin ? { "access-control-allow-origin": corsOrigin,
              "access-control-allow-credentials": "true", "vary": "Origin" } : {}), ...headers });
          res.end(buf);
          console.log(`${requestId} ${req.method} ${url.pathname} ${code} ${Date.now() - t0}ms`);
        },
      };
      try {
        if (origin && !corsOrigin) return ctx.send(403, { error: "origin not allowed", request_id: requestId });
        for (const m of middleware) { await m(ctx); if (ctx.sent) return; }
        if (url.pathname === "/healthz")
          return ctx.send(200, { ok: true, name, version, uptime_s: Math.round(process.uptime()), ...health });
        if (url.pathname === "/api" && req.method === "GET")
          return ctx.send(200, { name, version, routes: routes.map(r => `${r.method} ${r.pattern}${r.desc ? "  — " + r.desc : ""}`) });
        const m = match(req.method, parts);
        if (!m) return ctx.send(404, { error: "not found", hint: "GET /api lists routes" });
        ctx.params = m.params;
        await m.r.handler(ctx);
        if (!ctx.sent) ctx.send(500, { error: "handler sent nothing" });
      } catch (e) {
        const candidateStatus = Number(e?.status);
        const status = Number.isInteger(candidateStatus) && candidateStatus >= 400 && candidateStatus <= 599
          ? candidateStatus : 500;
        const message = status < 500 || !production ? String(e?.message ?? e) : "internal server error";
        if (!ctx.sent) ctx.send(status, { error: message, request_id: requestId });
        else console.error("post-send error:", e.message);
        if (status >= 500) console.error(`${requestId} request failed:`, e?.stack || e);
      }
    });
    server.on("error", (e) => {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code === "EADDRINUSE" && _tries < 20) {
        console.error(`port ${port} in use — trying ${port + 1}…`);
        setTimeout(() => listen(port + 1, cb, _tries + 1), 0);
      } else throw e;
    });
    server.listen(port, host, () => { if (cb) cb(port); });
    return server;
  }

  return { route, use, listen };
}

export const readBody = (req, maxBytes = 1024 * 1024) => new Promise((ok, no) => {
  const chunks = []; let n = 0;
  req.on("data", c => { n += c.length; if (n > maxBytes) {
    const error = Object.assign(new Error("body too large"), { status: 413 }); no(error); req.destroy(); return;
  } chunks.push(c); });
  req.on("end", () => ok(Buffer.concat(chunks)));
});
