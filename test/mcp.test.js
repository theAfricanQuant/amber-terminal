// The MCP server (scripts/mcp.js), spoken to over stdio the way Claude Code does, offline.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP = path.join(ROOT, "scripts", "mcp.js");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "qt-mcp-"));
fs.writeFileSync(
  path.join(DATA, "state.json"),
  JSON.stringify({
    amberWatch: { lists: { MAIN: ["SPX INDEX", "BTC"] } },
    amberPort: [{ sec: "AAPL US EQUITY", shares: 10, cost: 150 }],
  }),
);

let child;
let buf = "";
const waiting = new Map();
const unsolicited = [];
function send(msg) {
  child.stdin.write(`${typeof msg === "string" ? msg : JSON.stringify(msg)}\n`);
}
let nextId = 1;
function call(method, params) {
  const id = nextId++;
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}
const tool = async (name, args) =>
  (await call("tools/call", { name, arguments: args })).result;

before(() => {
  child = spawn(process.execPath, [MCP], {
    env: { ...process.env, QT_OFFLINE: "1", QT_DATA_DIR: DATA, PORT: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const msg = JSON.parse(line); // every stdout line must be JSON-RPC
      const key = Array.isArray(msg) ? "batch" : msg.id;
      if (waiting.has(key)) {
        waiting.get(key)(msg);
        waiting.delete(key);
      } else unsolicited.push(msg);
    }
  });
});
after(() => child.kill());

test("--help prints the line that connects Claude Code", () => {
  const r = spawnSync(process.execPath, [MCP, "--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes(`claude mcp add --scope user amber -- node `), r.stdout);
  assert.ok(r.stdout.includes(path.join("scripts", "mcp.js")));
});

test("initialize agrees a protocol version, and notifications get no reply", async () => {
  const r = await call("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.serverInfo.name, "amber");
  const older = await call("initialize", { protocolVersion: "2024-11-05" });
  assert.equal(
    older.result.protocolVersion,
    "2024-11-05",
    "an older client keeps its version",
  );
  const future = await call("initialize", { protocolVersion: "2099-01-01" });
  assert.equal(
    future.result.protocolVersion,
    "2025-06-18",
    "an unknown version gets the newest",
  );
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const ping = await call("ping");
  assert.deepEqual(ping.result, {});
  assert.equal(unsolicited.length, 0);
});

test("tools/list describes every tool with a schema", async () => {
  const { tools } = (await call("tools/list")).result;
  const names = tools.map((t) => t.name);
  for (const n of [
    "terminal_function",
    "quote",
    "history",
    "search_security",
    "list_functions",
    "backtest",
    "workspace",
    "alerts",
  ])
    assert.ok(names.includes(n), n);
  for (const t of tools) {
    assert.equal(t.inputSchema.type, "object", t.name);
    assert.ok(t.description.length > 40, t.name);
  }
  const fn = tools.find((t) => t.name === "terminal_function");
  for (const code of ["WIRP", "GC", "DES", "OMON", "BTMM", "EQS", "BTST"])
    assert.ok(fn.inputSchema.properties.function.enum.includes(code), code);
  assert.match(fn.description, /WIRP: The Fed rate path/);
  assert.match(
    tools.find((t) => t.name === "backtest").description,
    /entryLong/,
  );
});

test("tools/call runs functions in-process", async () => {
  const list = await tool("list_functions", {});
  assert.match(list.content[0].text, /"code":"WIRP"/);
  const h = await tool("history", { security: "BTC", bars: 5 });
  assert.equal(h.isError, undefined);
  const body = JSON.parse(
    h.content[0].text.split("\n\n").slice(1).join("\n\n"),
  );
  assert.equal(body.security, "XBTUSD Curncy");
  assert.equal(body.rows.length, 5);
  assert.deepEqual(body.columns, [
    "time",
    "open",
    "high",
    "low",
    "close",
    "volume",
  ]);
  const q = await tool("quote", { securities: ["BTC", "EURUSD CURNCY"] });
  assert.match(q.content[0].text, /^BTC [\d.]+ \(/);
});

test("the user's own watchlist and portfolio", async () => {
  const w = await tool("workspace", { with_prices: false });
  const body = JSON.parse(
    w.content[0].text.split("\n\n").slice(1).join("\n\n"),
  );
  assert.deepEqual(body.watchlists.MAIN, ["SPX INDEX", "BTC"]);
  assert.equal(body.portfolio.holdings[0].sec, "AAPL US EQUITY");
});

test("mistakes come back in plain words", async () => {
  const noSec = await tool("terminal_function", { function: "DES" });
  assert.equal(noSec.isError, true);
  assert.match(
    noSec.content[0].text,
    /DES needs a security, like AAPL US EQUITY/,
  );
  const noFn = await tool("terminal_function", { function: "NOPE" });
  assert.match(noFn.content[0].text, /no function called NOPE/);
  const create = await tool("alerts", {
    action: "create",
    security: "BTC",
    condition: "above",
    level: 1,
  });
  assert.equal(create.isError, true);
  assert.match(create.content[0].text, /running app/);
  const unknownTool = await call("tools/call", { name: "nope", arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
  const unknownMethod = await call("resources/subscribe", {});
  assert.equal(unknownMethod.error.code, -32601);
});

test("a bad line gets a parse error, and a batch gets a batch", async () => {
  const parse = new Promise((resolve) => waiting.set(null, resolve));
  send("{not json");
  assert.equal((await parse).error.code, -32700);
  const batch = new Promise((resolve) => waiting.set("batch", resolve));
  send([
    { jsonrpc: "2.0", id: 900, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]);
  const r = await batch;
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 900);
});
