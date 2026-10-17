#!/usr/bin/env node
// Amber Terminal server. Node 18+ and nothing else: no npm install, no build step.
//   node server.js            start on http://localhost:3787 (or the next free port)
//   node server.js --open     start and open your browser
//   PORT=4000 node server.js  pick a port

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { isIP } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as data from "./lib/providers.js";
import * as info from "./lib/market-info.js";
import * as bbg from "./lib/bloomberg-fields.js";
import { registerIndicator, BY_ID } from "./public/lib/indicators.js";
import { conditionFn } from "./public/lib/backtest.js";
import { relaunchForProxy, proxyNote } from "./lib/proxy.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const CUSTOM = path.join(ROOT, "custom");
const VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;
const HOST = process.env.HOST || "127.0.0.1";
const START_PORT = Number(process.env.PORT) || 3787;
const PUBLIC_DEMO_ENV = process.env.PUBLIC_DEMO === "1";
const PUBLIC_DEMO_HOST_ENV = process.env.PUBLIC_DEMO_HOST || process.env.PUBLIC_HOST || "";
const alerts = PUBLIC_DEMO_ENV ? null : await import("./lib/alerts.js");
const store = PUBLIC_DEMO_ENV ? null : await import("./lib/store.js");
const ptq = PUBLIC_DEMO_ENV ? null : await import("./lib/ptq.js");
const PUBLIC_READ_ROUTES = new Set([
  "/api/config",
  "/api/health",
  "/api/resolve",
  "/api/search",
  "/api/spread",
  "/api/candles",
  "/api/quotes",
  "/api/calendar",
  "/api/earnings",
  "/api/dividends",
  "/api/news",
  "/api/financials",
  "/api/screener",
  "/api/bdp",
  "/api/bdh",
]);
// These functions only read public provider data or perform bounded market calculations. Stateful
// workspace/portfolio history, alert logs, document URL fetches and PTQ stay local-only.
const PUBLIC_FN_ALLOWLIST = new Set([
  "anr",
  "auct",
  "board",
  "btmm",
  "btst",
  "cbrt",
  "cf",
  "cot",
  "cred",
  "ct",
  "des",
  "dvd",
  "eco",
  "ecst",
  "ee",
  "eq-comp",
  "eqs",
  "gc",
  "hds",
  "insd",
  "most",
  "omon",
  "ovdv",
  "top",
  "wirp",
]);
const PUBLIC_CACHEABLE = new Set([
  ...PUBLIC_READ_ROUTES,
  ...[...PUBLIC_FN_ALLOWLIST].map((name) => `/api/fn/${name}`),
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

const PUBLIC_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
});

// ---------- helpers ----------
const httpError = (status, message) => Object.assign(new Error(message), { status });

function send(res, status, body, headers = {}) {
  const isStr = typeof body === "string" || Buffer.isBuffer(body);
  const payload = isStr ? body : JSON.stringify(body);
  const cache = res._publicCache;
  const finalHeaders = {
    ...(res._securityHeaders || {}),
    "Content-Type": isStr ? "text/plain; charset=utf-8" : "application/json",
    "Cache-Control": "no-store",
    ...(cache ? { "Cache-Control": cache.cacheControl, "X-Amber-Cache": "MISS" } : {}),
    ...headers,
  };
  res.writeHead(status, finalHeaders);
  cache?.put(status, payload, {
    "Content-Type": finalHeaders["Content-Type"],
    "Cache-Control": finalHeaders["Cache-Control"],
  });
  res.end(payload);
}

function hostName(raw) {
  const value = String(raw || "").trim().toLowerCase().replace(/\.$/, "");
  if (!value) return "";
  if (value.startsWith("[")) return value.split("]")[0].slice(1);
  const colon = value.lastIndexOf(":");
  return colon > -1 && /^\d+$/.test(value.slice(colon + 1))
    ? value.slice(0, colon)
    : value;
}

function normalizePublicHost(raw) {
  const host = hostName(raw);
  if (!host || host.includes("/") || /\s/.test(host) || host.includes(":"))
    return "";
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host))
    return "";
  return host;
}

const numberEnv = (value, fallback, min, max) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

function createPublicCache(config) {
  const entries = new Map();
  let bytes = 0;
  const remove = (key) => {
    const old = entries.get(key);
    if (!old) return;
    bytes -= old.bytes;
    entries.delete(key);
  };
  const trim = () => {
    while (entries.size > config.cacheMax || bytes > config.cacheBytes) {
      const first = entries.keys().next().value;
      if (first === undefined) break;
      remove(first);
    }
  };
  return {
    get(key) {
      const item = entries.get(key);
      if (!item) return null;
      if (item.expiresAt <= Date.now()) {
        remove(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, item);
      return item;
    },
    put(key, status, body, headers) {
      if (status !== 200 || typeof body !== "string") return;
      const size = Buffer.byteLength(body);
      if (size > config.cacheEntryBytes) return;
      remove(key);
      entries.set(key, {
        status,
        body,
        headers,
        bytes: size,
        expiresAt: Date.now() + config.cacheTtlMs,
      });
      bytes += size;
      trim();
    },
  };
}

function createRuntimeConfig(overrides = {}) {
  const publicDemo = overrides.publicDemo ?? PUBLIC_DEMO_ENV;
  const publicHost = normalizePublicHost(
    overrides.publicHost ?? PUBLIC_DEMO_HOST_ENV,
  );
  if (publicDemo && !publicHost)
    throw new Error(
      "PUBLIC_DEMO=1 requires PUBLIC_DEMO_HOST with a hostname such as amber.sisengai.com",
    );
  const config = {
    publicDemo,
    publicHost,
    bindHost: publicDemo ? "127.0.0.1" : HOST,
    rateLimitMax: numberEnv(
      overrides.rateLimitMax ?? process.env.PUBLIC_RATE_LIMIT_MAX,
      120,
      1,
      10000,
    ),
    rateLimitWindowMs: numberEnv(
      overrides.rateLimitWindowMs ?? process.env.PUBLIC_RATE_LIMIT_WINDOW_MS,
      60e3,
      100,
      3600e3,
    ),
    cacheTtlMs: numberEnv(
      overrides.cacheTtlMs ?? process.env.PUBLIC_CACHE_TTL_MS,
      5e3,
      100,
      3600e3,
    ),
    cacheMax: numberEnv(
      overrides.cacheMax ?? process.env.PUBLIC_CACHE_MAX,
      128,
      1,
      1000,
    ),
    cacheEntryBytes: numberEnv(
      overrides.cacheEntryBytes ?? process.env.PUBLIC_CACHE_ENTRY_BYTES,
      512 * 1024,
      1024,
      10 * 1024 * 1024,
    ),
    cacheBytes: numberEnv(
      overrides.cacheBytes ?? process.env.PUBLIC_CACHE_BYTES,
      8 * 1024 * 1024,
      16 * 1024,
      64 * 1024 * 1024,
    ),
    rateMaxKeys: numberEnv(
      overrides.rateMaxKeys ?? process.env.PUBLIC_RATE_MAX_KEYS,
      10000,
      100,
      100000,
    ),
    rate: new Map(),
  };
  config.cache = createPublicCache(config);
  return config;
}

function loopbackAddress(address) {
  const a = String(address || "").replace(/^::ffff:/, "");
  return a === "127.0.0.1" || a === "::1" || a === "::";
}

function validIp(value) {
  return isIP(String(value || "").trim()) > 0;
}

// Only trust forwarded addresses from the loopback reverse proxy. Direct non-loopback clients cannot
// choose their bucket with a spoofed X-Forwarded-For header.
function clientIp(req) {
  const remote = req.socket?.remoteAddress || "unknown";
  if (loopbackAddress(remote)) {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((x) => x.trim())
      .find(validIp);
    const real = String(req.headers["x-real-ip"] || "").trim();
    if (forwarded) return forwarded;
    if (validIp(real)) return real;
  }
  return remote;
}

function trimRateBuckets(config, now) {
  for (const [key, item] of config.rate) {
    if (now - item.startedAt >= config.rateLimitWindowMs) config.rate.delete(key);
  }
  while (config.rate.size > config.rateMaxKeys) {
    const first = config.rate.keys().next().value;
    if (first === undefined) break;
    config.rate.delete(first);
  }
}

function rateLimited(req, config) {
  if (!config.publicDemo) return null;
  const now = Date.now();
  trimRateBuckets(config, now);
  const key = clientIp(req);
  let item = config.rate.get(key);
  if (!item || now - item.startedAt >= config.rateLimitWindowMs) {
    item = { startedAt: now, count: 0 };
    config.rate.set(key, item);
  }
  item.count += 1;
  if (item.count <= config.rateLimitMax) return null;
  return Math.max(
    1,
    Math.ceil((config.rateLimitWindowMs - (now - item.startedAt)) / 1000),
  );
}

function publicRouteAllowed(p, method) {
  const read = method === "GET" || method === "HEAD";
  if (PUBLIC_READ_ROUTES.has(p)) return read;
  if (p === "/api/scan") return method === "POST";
  const match = /^\/api\/fn\/([a-z0-9-]{1,40})$/.exec(p);
  return Boolean(match && read && PUBLIC_FN_ALLOWLIST.has(match[1]));
}

function enforcePublicQuery(p, q) {
  const tooLong = (value, max, label) => {
    if (String(value || "").length > max) throw httpError(400, `${label} is too long`);
  };
  if (p.startsWith("/api/fn/")) tooLong(q.symbol, 80, "Symbol");
  if (p === "/api/search") tooLong(q.q, 80, "Search query");
  if (p === "/api/resolve" || p === "/api/spread")
    tooLong(q.symbol, 80, "Symbol");
  if (p === "/api/candles") {
    tooLong(q.symbol, 80, "Symbol");
    const limit = Number(q.limit || 500);
    if (!Number.isFinite(limit) || limit < 10 || limit > 500)
      throw httpError(400, "Public charts allow 10 to 500 bars");
  }
  if (p === "/api/quotes") {
    const symbols = String(q.symbols || "").split(",").filter(Boolean);
    if (!symbols.length || symbols.length > 25)
      throw httpError(400, "Public quotes allow 1 to 25 symbols");
    if (symbols.some((symbol) => symbol.length > 40))
      throw httpError(400, "A public quote symbol is too long");
  }
  if (p === "/api/bdp") {
    const securities = String(q.securities || q.security || "")
      .split(",")
      .filter(Boolean);
    const fields = String(q.fields || "").split(",").filter(Boolean);
    if (securities.length > 5 || fields.length > 15)
      throw httpError(400, "Public BDP allows at most 5 securities and 15 fields");
  }
  if (p === "/api/bdh") {
    const fields = String(q.fields || "").split(",").filter(Boolean);
    if (fields.length > 15) throw httpError(400, "Public BDH allows at most 15 fields");
    const today = new Date().toISOString().slice(0, 10);
    const end = bbg.parseDate(q.end, today);
    const start = bbg.parseDate(q.start, bbg.parseDate("-1Y"));
    const oldest = new Date(`${end}T00:00:00Z`);
    oldest.setUTCFullYear(oldest.getUTCFullYear() - 2);
    if (
      Date.parse(`${start}T00:00:00Z`) > Date.parse(`${end}T00:00:00Z`) ||
      Date.parse(`${start}T00:00:00Z`) < oldest.getTime()
    )
      throw httpError(400, "Public BDH history is limited to two years");
  }
  if (p === "/api/fn/board") {
    const symbols = String(q.symbols || "").split(",").filter(Boolean);
    if (symbols.length > 25) throw httpError(400, "Public boards allow at most 25 symbols");
  }
  if (p === "/api/earnings" || p === "/api/dividends") {
    const days = Number(q.days || 5);
    if (!Number.isInteger(days) || days < 1 || days > 30)
      throw httpError(400, "Public calendars allow 1 to 30 days");
  }
  if (p === "/api/fn/btst") {
    if (!/^[1-5]$/.test(String(q.strategy || "1")))
      throw httpError(400, "Public backtests allow preset strategies 1 to 5 only");
    if (q.tf && !["D", "W"].includes(String(q.tf).toUpperCase()))
      throw httpError(400, "Public backtests allow daily or weekly bars");
  }
  if (p === "/api/fn/top") tooLong(q.group, 40, "News group");
  if (p === "/api/fn/cot") tooLong(q.market, 40, "Market");
}

const PUBLIC_SCAN_MAX_NUMBER = 1_000_000;
const PUBLIC_SCAN_MAX_WINDOW = 400;
const PUBLIC_SCAN_SOURCE_VALUES = new Set([
  "open",
  "high",
  "low",
  "close",
  "volume",
  "hl2",
  "hlc3",
  "ohlc4",
  "hlcc4",
]);
const PUBLIC_SCAN_WINDOW_KEYS = new Set([
  "length",
  "fast",
  "slow",
  "short",
  "long",
  "signal",
  "wma",
  "roc1",
  "roc2",
  "roc3",
  "roc4",
  "sma1",
  "sma2",
  "sma3",
  "sma4",
  "rsiLength",
  "streakLength",
  "rankLength",
  "k",
  "smoothK",
  "d",
  "smoothD",
  "stochLength",
  "diLength",
  "adxSmoothing",
  "atrLength",
  "p",
  "q",
  "conversion",
  "base",
  "spanB",
  "displacement",
  "jawLength",
  "jawOffset",
  "teethLength",
  "teethOffset",
  "lipsLength",
  "lipsOffset",
  "left",
  "right",
  "depth",
  "maLength",
  "lookback",
  "minHistory",
  "rows",
  "periods",
]);
const isRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

function validatePublicIndicator(key, spec) {
  if (!isRecord(spec) || typeof spec.id !== "string" || !BY_ID[spec.id])
    throw httpError(400, `Public scan indicator "${key}" is unknown`);
  const def = BY_ID[spec.id];
  const params = spec.params === undefined ? {} : spec.params;
  if (!isRecord(params))
    throw httpError(400, `Public scan indicator "${key}" params must be an object`);
  const inputs = new Map((def.inputs || []).map((input) => [input.key, input]));
  for (const [param, value] of Object.entries(params)) {
    const input = inputs.get(param);
    if (!input) throw httpError(400, `Public scan indicator "${key}" has an unknown parameter "${param}"`);
    if (input.type === "source") {
      if (typeof value !== "string" || !PUBLIC_SCAN_SOURCE_VALUES.has(value))
        throw httpError(400, `Public scan indicator "${key}" source is invalid`);
      continue;
    }
    if (input.type === "select") {
      if (typeof value !== "string" || !input.options?.includes(value))
        throw httpError(400, `Public scan indicator "${key}" parameter "${param}" is invalid`);
      continue;
    }
    if (input.type === "int") {
      const max = PUBLIC_SCAN_WINDOW_KEYS.has(param) ? PUBLIC_SCAN_MAX_WINDOW : PUBLIC_SCAN_MAX_NUMBER;
      const min = input.min ?? 1;
      if (!Number.isSafeInteger(value) || value < min || value > max)
        throw httpError(400, `Public scan indicator "${key}" parameter "${param}" must be an integer from ${min} to ${max}`);
      continue;
    }
    if (input.type === "float" || input.type === "time") {
      if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > PUBLIC_SCAN_MAX_NUMBER)
        throw httpError(400, `Public scan indicator "${key}" parameter "${param}" must be a finite number within ±${PUBLIC_SCAN_MAX_NUMBER}`);
      if (spec.id === "alma" && param === "offset" && (value < 0 || value > 1))
        throw httpError(400, `Public scan indicator "${key}" offset must be between 0 and 1`);
      if (spec.id === "alma" && param === "sigma" && value <= 0)
        throw httpError(400, `Public scan indicator "${key}" sigma must be greater than 0`);
    }
  }
}

function validatePublicScan(body) {
  const symbols = Array.isArray(body.symbols) ? body.symbols : [];
  const rules = Array.isArray(body.rules) ? body.rules : [];
  if (symbols.length > 20) throw httpError(400, "Public scans allow at most 20 symbols");
  if (rules.length > 6) throw httpError(400, "Public scans allow at most 6 rules");
  if (body.indicators !== undefined) {
    if (!isRecord(body.indicators)) throw httpError(400, "Public scan indicators must be an object");
    const indicators = Object.entries(body.indicators);
    if (indicators.length > 8) throw httpError(400, "Public scans allow at most 8 indicators");
    for (const [key, spec] of indicators) validatePublicIndicator(key, spec);
  }
  if (symbols.some((symbol) => typeof symbol !== "string" || symbol.length > 40))
    throw httpError(400, "Public scan symbols must be short strings");
  if (rules.some((rule) => !rule || typeof rule !== "object" || Array.isArray(rule)))
    throw httpError(400, "Public scan rules must be objects");
}

function publicCacheStart(req, res, config, p) {
  if (!config.publicDemo || req.method !== "GET" || !PUBLIC_CACHEABLE.has(p))
    return false;
  const key = `${req.method}:${req.url}`;
  const hit = config.cache.get(key);
  if (hit) {
    res.writeHead(hit.status, {
      ...(res._securityHeaders || {}),
      ...hit.headers,
      "X-Amber-Cache": "HIT",
    });
    res.end(hit.body);
    return true;
  }
  res._publicCache = {
    cacheControl: `public, max-age=${Math.max(1, Math.floor(config.cacheTtlMs / 1000))}`,
    put: (status, body, headers) => config.cache.put(key, status, body, headers),
  };
  return false;
}

async function readBody(req, limit = 2e6) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit)
      throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw httpError(400, "The request body isn't valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw httpError(400, "The request body must be a JSON object");
  return body;
}

// The server only answers to this machine's browser in local mode. Writes need a custom header, which a
// random website can't add to a cross-site request, so other pages can't drive your terminal. Public mode
// instead accepts only the configured reverse-proxy host; it never widens this to arbitrary Host headers.
function allowed(req, config) {
  const host = hostName(req.headers.host || "");
  if (config.publicDemo) return host === config.publicHost;
  const okHosts = new Set(["localhost", "127.0.0.1", "::1", ...lanAddresses()]);
  if (!okHosts.has(host)) return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    if (req.headers["x-qt"] !== "1") return false;
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host) return false;
      } catch {
        return false; // "null" and other opaque origins
      }
    }
  }
  return true;
}

function lanAddresses() {
  if (HOST === "127.0.0.1" || HOST === "localhost") return [];
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(Boolean)
    .map((i) => i.address);
}

function serveStatic(res, baseDir, rel) {
  const file = path.normalize(path.join(baseDir, rel));
  if (!file.startsWith(baseDir + path.sep)) return send(res, 403, "Forbidden");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, "Not found");
    res.writeHead(200, {
      ...(res._securityHeaders || {}),
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": rel.startsWith("vendor/")
        ? "public, max-age=86400"
        : "no-cache",
    });
    fs.createReadStream(file).pipe(res);
  });
}

// ---------- custom indicators (your own "Pine scripts", as plain JS files in /custom) ----------
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "indicator";
const customErrors = {};

function listCustom() {
  fs.mkdirSync(CUSTOM, { recursive: true });
  return fs
    .readdirSync(CUSTOM)
    .filter((f) => f.endsWith(".js"))
    .map((f) => ({
      file: f,
      id: `custom:${f.replace(/\.js$/, "")}`,
      mtime: fs.statSync(path.join(CUSTOM, f)).mtimeMs,
      error: customErrors[f] || null,
    }));
}

async function loadCustom(file) {
  try {
    const full = path.join(CUSTOM, file);
    const mod = await import(
      `${pathToFileURL(full).href}?v=${fs.statSync(full).mtimeMs}`
    );
    registerIndicator({
      ...mod.default,
      id: `custom:${file.replace(/\.js$/, "")}`,
    });
    delete customErrors[file];
  } catch (e) {
    customErrors[file] = e.message;
  }
}

// ---------- server-sent events (alerts pop up in the browser) ----------
const clients = new Set();
function broadcast(type, payload) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
if (!PUBLIC_DEMO_ENV) alerts.onFire((e) => broadcast("alert", e));
if (!PUBLIC_DEMO_ENV) setInterval(() => {
  for (const res of clients) res.write(": keep-alive\n\n");
}, 25000).unref();

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

// ---------- routes ----------
async function handle(req, res, config) {
  if (!allowed(req, config))
    return send(
      res,
      403,
      config.publicDemo
        ? "Forbidden: use the configured public demo host."
        : "Forbidden: Amber Terminal only answers to this computer.",
    );
  if (config.publicDemo) {
    const retryAfter = rateLimited(req, config);
    if (retryAfter)
      return send(
        res,
        429,
        { error: "Too many requests. Try again shortly." },
        { "Retry-After": String(retryAfter) },
      );
  }
  if (String(req.url || "").length > (config.publicDemo ? 4096 : 100000))
    return send(res, 414, "Request URL too long");
  const url = new URL(req.url, "http://localhost");
  let p;
  try {
    p = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, "Bad URL");
  }
  if (config.publicDemo) {
    const read = req.method === "GET" || req.method === "HEAD";
    if (p.startsWith("/api/")) {
      if (!publicRouteAllowed(p, req.method))
        return send(res, 403, { error: "This route is disabled in public demo mode." });
    } else if (!read || p.startsWith("/custom/")) {
      return send(res, 403, { error: "This route is disabled in public demo mode." });
    }
  }
  const q = Object.fromEntries(url.searchParams);
  if (config.publicDemo) enforcePublicQuery(p, q);
  if (publicCacheStart(req, res, config, p)) return;

  if (!p.startsWith("/api/")) {
    if (p === "/" || p === "/index.html")
      return serveStatic(res, PUBLIC, "index.html");
    if (p.startsWith("/custom/")) return serveStatic(res, CUSTOM, p.slice(8));
    return serveStatic(res, PUBLIC, p.slice(1));
  }

  try {
    if (p === "/api/config")
      return send(res, 200, { publicDemo: config.publicDemo });
    if (p === "/api/health") {
      if (config.publicDemo)
        return send(res, 200, {
          ok: true,
          app: "amber-terminal",
          version: VERSION,
          publicDemo: true,
        });
      return send(res, 200, {
        ok: true,
        app: "amber-terminal",
        root: ROOT,
        version: VERSION,
        node: process.version,
        platform: process.platform,
        providers: data.health,
        yahoo: data.yahooAvailable() ? "available" : "rate limited",
        alerts: alerts.list().filter((a) => a.active).length,
      });
    }
    if (p === "/api/probe") return send(res, 200, await data.probeAll());
    if (p === "/api/resolve")
      return send(res, 200, await data.resolve(q.symbol));
    if (p === "/api/search") return send(res, 200, await data.search(q.q));
    if (p === "/api/spread") return send(res, 200, await data.getSpread(q.symbol));
    if (p === "/api/candles")
      return send(
        res,
        200,
        await data.getCandles(
          q.symbol,
          q.tf || "1D",
          config.publicDemo ? Math.min(Number(q.limit) || 500, 500) : q.limit,
        ),
      );
    if (p === "/api/quotes")
      return send(
        res,
        200,
        await data.getQuotes(
          (q.symbols || "")
            .split(",")
            .filter(Boolean)
            .slice(0, config.publicDemo ? 25 : 200),
        ),
      );
    if (p === "/api/calendar")
      return send(res, 200, await data.economicCalendar());
    if (p === "/api/earnings") return send(res, 200, await info.earnings(Number(q.days) || 5));
    if (p === "/api/dividends") return send(res, 200, await info.dividends(Number(q.days) || 5));
    if (p === "/api/news") return send(res, 200, await info.news(q.symbol));
    if (p === "/api/financials") return send(res, 200, await info.financials(q.symbol, q.frequency));
    if (p === "/api/screener") {
      const u = q.universe || "crypto";
      const rows =
        u === "crypto"
          ? await data.cryptoScreener()
          : await data.nasdaqScreener(u === "etf" ? "etf" : "stocks");
      return send(res, 200, rows);
    }
    if (p === "/api/scan" && req.method === "POST") {
      const body = await readBody(req, config.publicDemo ? 100e3 : 2e6);
      if (!Array.isArray(body.symbols) || !Array.isArray(body.rules ?? []))
        throw httpError(400, "Send { symbols: [...], rules: [...] }");
      if (config.publicDemo) validatePublicScan(body);
      const maxSymbols = config.publicDemo ? 20 : 150;
      const symbols = body.symbols.slice(0, maxSymbols);
      const rules = body.rules || [];
      const results = await mapLimit(symbols, config.publicDemo ? 2 : 4, async (symbol) => {
        try {
          const { candles } = await data.getCandles(
            symbol,
            body.tf || "1D",
            400,
          );
          const make = conditionFn(candles, body.indicators || {});
          const i = candles.length - 1;
          const passes = rules.map((r) => make(r)(i));
          return {
            symbol,
            pass: passes.every(Boolean),
            passes,
            close: candles[i].close,
          };
        } catch (e) {
          return { symbol, error: e.message };
        }
      });
      return send(res, 200, results);
    }
    if (p === "/api/state") {
      if (req.method === "GET") return send(res, 200, store.read("state", {}));
      if (req.method === "PUT") {
        const patch = await readBody(req, 20e6);
        const next = { ...store.read("state", {}), ...patch };
        store.write("state", next);
        return send(res, 200, { ok: true });
      }
    }
    if (p === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("retry: 3000\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (p === "/api/alerts") {
      if (req.method === "GET") return send(res, 200, alerts.list());
      if (req.method === "POST")
        return send(res, 200, alerts.add(await readBody(req)));
    }
    if (p === "/api/alerts/log") return send(res, 200, alerts.history());
    if (p === "/api/alerts/check" && req.method === "POST") {
      await alerts.evaluate();
      return send(res, 200, { ok: true });
    }
    if (p.startsWith("/api/alerts/")) {
      const id = p.split("/")[3];
      if (req.method === "DELETE") {
        alerts.remove(id);
        return send(res, 200, { ok: true });
      }
      if (req.method === "PATCH")
        return send(res, 200, alerts.update(id, await readBody(req)));
    }
    if (p === "/api/webhook-test" && req.method === "POST") {
      const { url: hook } = await readBody(req);
      if (!/^https?:\/\/[^\s]+$/i.test(String(hook || "")))
        throw httpError(400, "Webhook must be an http(s) URL");
      const r = await fetch(hook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: "Amber Terminal test alert",
          content: "Amber Terminal test alert",
        }),
        signal: AbortSignal.timeout(10000),
      });
      return send(res, 200, { ok: r.ok, status: r.status });
    }
    if (p === "/api/custom") {
      if (req.method === "GET") return send(res, 200, listCustom());
      if (req.method === "POST") {
        const { name, code } = await readBody(req);
        if (!code || !/export\s+default/.test(code))
          throw Object.assign(
            new Error(
              "The file must `export default { name, calc(bars, params, ta) { ... } }`",
            ),
            { status: 400 },
          );
        const file = `${slug(name)}.js`;
        fs.mkdirSync(CUSTOM, { recursive: true });
        fs.writeFileSync(path.join(CUSTOM, file), code);
        await loadCustom(file);
        return send(
          res,
          customErrors[file] ? 400 : 200,
          customErrors[file]
            ? { error: customErrors[file], file }
            : { ok: true, file, id: `custom:${file.replace(/\.js$/, "")}` },
        );
      }
    }
    if (p.startsWith("/api/custom/") && req.method === "DELETE") {
      const file = path.basename(p.slice(12));
      fs.rmSync(path.join(CUSTOM, file), { force: true });
      return send(res, 200, { ok: true });
    }
    if (p === "/api/shutdown" && req.method === "POST") {
      // Lets the installer stop a running copy before updating it, on any OS.
      send(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 100);
      return;
    }
    // PTQ connector: reads and fail-safe controls only. There is no route here that arms a
    // strategy or places an order; that stays inside PTQ (`ptq arm-strategy`).
    if (p === "/api/ptq/status") return send(res, 200, await ptq.status());
    if (p === "/api/ptq/overview") return send(res, 200, await ptq.overview());
    if (p === "/api/ptq/check" && req.method === "POST") {
      try {
        return send(res, 200, await ptq.check(await readBody(req)));
      } catch (e) {
        return send(res, e.status || 502, { error: e.message, code: e.code, problems: e.problems || [], notes: e.notes || [] });
      }
    }
    if (p === "/api/ptq/kill-switch" && req.method === "POST") return send(res, 200, await ptq.engageKillSwitch());
    const disarmMatch = /^\/api\/ptq\/arms\/([^/]+)\/disarm$/.exec(p);
    if (disarmMatch && req.method === "POST") return send(res, 200, await ptq.disarm(decodeURIComponent(disarmMatch[1])));
    // Bloomberg's Excel functions as URLs, for Excel (Data > From Web), pandas.read_csv and scripts. Read-only GETs,
    // so no app header is needed; the server still only answers to this computer.
    if (p === "/api/about")
      return send(res, 200, {
        app: "amber-terminal",
        dir: ROOT,
        port: req.socket.localPort,
        version: VERSION,
        mcp: bbg.mcpCommand(ROOT),
        fields: { bdp: bbg.BDP_FIELDS, bdh: bbg.BDH_FIELDS },
      });
    if (p === "/api/bdp" || p === "/api/bdh") {
      const out = p === "/api/bdp" ? await bbg.bdp(q) : await bbg.bdh(q);
      if (String(q.format || "").toLowerCase() === "csv")
        return send(res, 200, bbg.csvOf(out), { "Content-Type": "text/csv; charset=utf-8" });
      return send(res, 200, out);
    }
    // Terminal functions: /api/fn/<name> runs lib/fn/<name>.js, one file per data source.
    const fm = /^\/api\/fn\/([a-z0-9-]{1,40})$/.exec(p);
    if (fm) {
      const mod = await loadFn(fm[1]);
      if (!mod) throw httpError(404, `No terminal function called ${fm[1]}`);
      return send(res, 200, await mod.default(q));
    }
    return send(res, 404, { error: "Unknown endpoint" });
  } catch (e) {
    // Upstream failures are a bad gateway, whatever status the provider used.
    const code = e.upstream ? 502 : e.status >= 400 && e.status < 600 ? e.status : 500;
    return send(res, code, { error: e.message });
  }
}

const fnCache = new Map();
async function loadFn(name) {
  if (!fnCache.has(name)) {
    const file = path.join(ROOT, "lib", "fn", `${name}.js`);
    fnCache.set(name, fs.existsSync(file) ? await import(pathToFileURL(file).href) : null);
  }
  return fnCache.get(name);
}

// ---------- start ----------
function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    /* no desktop: the URL is printed anyway */
  }
}

export function start(port = START_PORT, tries = 20, overrides = {}) {
  const config = createRuntimeConfig(overrides);
  if (config.publicDemo !== PUBLIC_DEMO_ENV)
    throw new Error(
      "PUBLIC_DEMO must be set before importing server.js; runtime overrides cannot switch modes",
    );
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (config.publicDemo) res._securityHeaders = PUBLIC_SECURITY_HEADERS;
      handle(req, res, config).catch((e) => {
        if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      });
    });
    server.once("error", (e) => {
      if (e.code === "EADDRINUSE" && tries > 0)
        resolve(start(port + 1, tries - 1, overrides));
      else reject(e);
    });
    server.listen(port, config.bindHost, () => resolve({ server, port }));
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const relaunched = isMain ? relaunchForProxy() : null;
if (relaunched) process.exit(await relaunched);
if (isMain) {
  const config = createRuntimeConfig();
  if (!config.publicDemo)
    for (const c of listCustom()) await loadCustom(c.file);
  const { port } = await start();
  const url = `http://localhost:${port}`;
  if (!config.publicDemo) alerts.start();
  console.log(
    `\n  Amber Terminal ${VERSION} is running\n\n  Open:  ${url}\n  Stop:  Ctrl+C\n  Data:  ${config.publicDemo ? "browser localStorage only (public demo)" : store.DATA_DIR}\n`,
  );
  if (config.publicDemo)
    console.log(
      `  PUBLIC DEMO: host ${config.publicHost}; anonymous state, alerts, webhooks, custom code, PTQ and local diagnostics are disabled.\n`,
    );
  if (proxyNote()) console.log(`  ${proxyNote()}\n`);
  if (!config.publicDemo && HOST !== "127.0.0.1" && HOST !== "localhost")
    console.log(
      `  Also on your network: ${lanAddresses()
        .filter((a) => a.includes(".") && a !== "127.0.0.1")
        .map((a) => `http://${a}:${port}`)
        .join("  ")}\n`,
    );
  if (process.argv.includes("--open") || process.env.QT_OPEN === "1")
    openBrowser(url);
  const bye = () => {
    console.log("\n  Stopped.");
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}
