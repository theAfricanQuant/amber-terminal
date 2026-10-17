import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.QT_OFFLINE = "1";
process.env.PUBLIC_DEMO = "1";
process.env.PUBLIC_DEMO_HOST = "amber.sisengai.com";
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "qt-public-demo-"));
process.env.QT_DATA_DIR = path.join(dataDir, "server-state");

const { start } = await import("../server.js");
assert.equal(fs.existsSync(process.env.QT_DATA_DIR), false, "public startup must not create the local state directory");
const PUBLIC_HOST = "amber.sisengai.com";
const randomPort = () => 43000 + Math.floor(Math.random() * 1000);
let server;
let base;

const requestAt = (origin, url, init = {}, host = PUBLIC_HOST) =>
  new Promise((resolve, reject) => {
    const target = new URL(`${origin}${url}`);
    const body = init.body == null ? null : String(init.body);
    const headers = { Host: host, ...(init.headers || {}) };
    if (body && !headers["Content-Length"]) headers["Content-Length"] = Buffer.byteLength(body);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method || "GET",
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode,
            headers: { get: (name) => res.headers[String(name).toLowerCase()] || null },
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });

const request = (url, init = {}, host = PUBLIC_HOST) =>
  requestAt(base, url, init, host);

before(async () => {
  const s = await start(randomPort(), 20, {
    publicDemo: true,
    publicHost: PUBLIC_HOST,
    rateLimitMax: 100,
  });
  server = s.server;
  base = `http://127.0.0.1:${s.port}`;
});

after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("public demo binds to loopback and serves only the configured host", async () => {
  assert.throws(
    () => start(randomPort(), 0, { publicDemo: true, publicHost: "" }),
    /PUBLIC_DEMO=1 requires PUBLIC_DEMO_HOST/,
  );
  assert.throws(
    () => start(randomPort(), 0, { publicDemo: false }),
    /PUBLIC_DEMO must be set before importing server\.js/,
  );
  assert.equal(server.address().address, "127.0.0.1");
  assert.equal((await request("/api/config")).status, 200);
  assert.equal((await request("/api/health")).status, 200);
  assert.equal((await request("/")).status, 200);
  assert.equal((await request("/api/health", {}, "evil.example")).status, 403);
});

test("public read responses are bounded in memory and cached", async () => {
  const first = await request("/api/health?cache-test=1");
  const firstBody = await first.text();
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("x-amber-cache"), "MISS");
  const second = await request("/api/health?cache-test=1");
  const secondBody = await second.text();
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("x-amber-cache"), "HIT");
  assert.equal(secondBody, firstBody);
});

test("public client state stays in the visitor's localStorage", async () => {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    },
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error("public state must not call the server");
  };
  try {
    const client = await import(`../public/js/api.js?public-test=${Date.now()}`);
    client.configureRuntime({ publicDemo: true });
    await client.api.put("/api/state", { guestLayout: 2 });
    assert.deepEqual(await client.api.get("/api/state"), { guestLayout: 2 });
    assert.equal(values.size, 1);
  } finally {
    globalThis.fetch = previousFetch;
    delete globalThis.window;
  }
});


test("public demo visibly preserves Bloomberg and chart-engine disclosures", () => {
  const source = fs.readFileSync(new URL("../public/js/fn/meta.js", import.meta.url), "utf8");
  assert.match(source, /independent project[\s\S]*not affiliated with, endorsed by, or connected to Bloomberg L\.P\./);
  assert.match(source, /TradingView Lightweight Charts/);
  assert.match(source, /Apache License 2\.0/);
});

test("public mode denies shared state and every stateful or dangerous route", async () => {
  const denied = [
    "/api/state",
    "/api/alerts",
    "/api/alerts/log",
    "/api/events",
    "/api/webhook-test",
    "/api/custom",
    "/api/ptq/status",
    "/api/shutdown",
    "/api/about",
    "/api/probe",
    "/api/fn/ds?doc=https%3A%2F%2Fexample.com%2Finput",
    "/api/fn/surp",
  ];
  for (const route of denied) {
    const r = await request(route);
    assert.equal(r.status, 403, route);
  }
  const write = await request("/api/state", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guest: "must not persist" }),
  });
  assert.equal(write.status, 403);
  assert.equal(fs.existsSync(path.join(dataDir, "state.json")), false);
});

test("public computation and request-size limits are enforced", async () => {
  const scan = await request("/api/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      symbols: Array.from({ length: 21 }, (_, i) => `S${i}`),
      rules: [],
    }),
  });
  assert.equal(scan.status, 400);

  const backtest = await request("/api/fn/btst?symbol=BTC&strategy=%7B%22entryLong%22%3A%5B%5D%7D");
  assert.equal(backtest.status, 400);

  const tooManyBars = await request("/api/candles?symbol=BTCUSDT&tf=1D&limit=501");
  assert.equal(tooManyBars.status, 400);
});

test("public scans validate indicator ids, parameter types, and finite bounds", async () => {
  const post = (indicators) =>
    request("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbols: [], rules: [], indicators }),
    });
  for (const indicators of [
    { nope: { id: "not-an-indicator" } },
    { alma: { id: "alma", params: { length: "20" } } },
    { alma: { id: "alma", params: { length: 1_000_000 } } },
    { alma: { id: "alma", params: { offset: 2 } } },
    { alma: { id: "alma", params: { sigma: 0 } } },
    { alma: { id: "alma", params: { sigma: null } } },
  ]) {
    assert.equal((await post(indicators)).status, 400, JSON.stringify(indicators));
  }
  assert.equal(
    (await post({ alma: { id: "alma", params: { length: 20, offset: 0.85, sigma: 6 } } })).status,
    200,
  );
});

test("public BDH rejects absolute and relative history beyond two years", async () => {
  assert.equal(
    (await request("/api/bdh?security=BTC&fields=PX_LAST&start=1900-01-01")).status,
    400,
  );
  assert.equal(
    (await request("/api/bdh?security=BTC&fields=PX_LAST&start=-3Y")).status,
    400,
  );
  assert.equal(
    (await request("/api/bdh?security=BTC&fields=PX_LAST")).status,
    200,
  );
});

test("public responses include compatible baseline security headers", async () => {
  for (const path of ["/", "/css/terminal.css", "/api/health"]) {
    const r = await request(path);
    assert.equal(r.status, 200, path);
    assert.match(r.headers.get("content-security-policy") || "", /default-src 'self'/, path);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(r.headers.get("x-frame-options"), "DENY", path);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer", path);
  }
});

test("TradingView chart attribution remains enabled in both chart helpers", () => {
  const source = fs.readFileSync(new URL("../public/js/ui.js", import.meta.url), "utf8");
  assert.equal((source.match(/attributionLogo:\s*true/g) || []).length, 2);
  assert.doesNotMatch(source, /attributionLogo:\s*false/);
});

test("public rate limiting buckets requests and remains bounded", async () => {
  const limited = await start(randomPort(), 20, {
    publicDemo: true,
    publicHost: PUBLIC_HOST,
    rateLimitMax: 2,
    rateLimitWindowMs: 10_000,
    rateMaxKeys: 100,
  });
  const get = () =>
    requestAt(`http://127.0.0.1:${limited.port}`, "/api/health", {
      headers: { "X-Forwarded-For": "203.0.113.7" },
    });
  try {
    assert.equal((await get()).status, 200);
    assert.equal((await get()).status, 200);
    const blocked = await get();
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get("retry-after")) >= 1);
  } finally {
    limited.server.close();
  }
});
