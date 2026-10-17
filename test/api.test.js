// BDP and BDH (lib/bloomberg-fields.js and the /api/bdp, /api/bdh, /api/about routes), offline.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

process.env.QT_OFFLINE = "1";
process.env.QT_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "qt-api-"));
const bbg = await import("../lib/bloomberg-fields.js");
const { start } = await import("../server.js");
let server, base, port;

before(async () => {
  const s = await start(40000 + Math.floor(Math.random() * 1000));
  server = s.server;
  port = s.port;
  base = `http://127.0.0.1:${port}`;
});
after(() => server.close());

const at = (date, o) => ({
  time: Date.parse(`${date}T00:00:00Z`) / 1000,
  volume: 10,
  ...o,
});

test("securities parse the terminal's way and label back the Bloomberg way", () => {
  const cases = {
    "AAPL US EQUITY": ["AAPL", "AAPL US Equity"],
    "vod ln equity": ["VOD.L", "VOD LN Equity"],
    "SPX INDEX": ["^GSPC", "SPX Index"],
    "CL1 COMDTY": ["CL=F", "CL1 Comdty"],
    "EURUSD CURNCY": ["FX:EURUSD", "EURUSD Curncy"],
    BTC: ["BTCUSDT", "XBTUSD Curncy"],
  };
  for (const [text, [id, label]] of Object.entries(cases)) {
    const sec = bbg.parseSecurity(text);
    assert.equal(sec.id, id, text);
    assert.equal(bbg.labelOf(sec), label, text);
    assert.equal(bbg.parseSecurity(label).id, id, `${label} parses back`);
  }
  assert.equal(bbg.labelForSymbol("US:MSFT"), "MSFT US Equity");
  assert.equal(bbg.labelForSymbol("YAHOO:7203.T"), "7203 JP Equity");
  assert.equal(bbg.labelForSymbol("YAHOO:^N225"), "NKY Index");
  assert.equal(
    bbg.labelForSymbol("BINANCE:ETHBTC"),
    "BINANCE:ETHBTC",
    "no Bloomberg form, so the source symbol",
  );
  assert.throws(() => bbg.parseSecurity("  "), /isn't a security/);
});

test("price fields come from the daily bars", () => {
  const bars = [
    at("2025-06-30", { open: 90, high: 95, low: 80, close: 90 }),
    at("2025-12-31", { open: 100, high: 101, low: 99, close: 100 }),
    at("2026-01-02", { open: 100, high: 112, low: 98, close: 110 }),
    at("2026-01-05", {
      open: 110,
      high: 121,
      low: 109,
      close: 121,
      volume: 30,
    }),
  ];
  const f = bbg.priceFields(bars);
  assert.equal(f.PX_LAST, 121);
  assert.equal(f.PX_CLOSE_1D, 110);
  assert.equal(f.CHG_NET_1D, 11);
  assert.equal(f.CHG_PCT_1D, 10);
  assert.equal(f.CHG_PCT_YTD, 21);
  assert.equal(f.HIGH_52WEEK, 121);
  assert.equal(f.LOW_52WEEK, 80);
  assert.equal(f.VOLUME_AVG_30D, 15);
  assert.equal(f.LAST_UPDATE_DT, "2026-01-05");
});

test("BDH rolls daily bars up to weeks and months, dated by the last trading day", () => {
  const bars = [
    at("2026-01-30", { open: 9, high: 10, low: 8, close: 10 }), // Friday, before the range
    at("2026-02-02", { open: 10, high: 12, low: 9, close: 11 }), // Monday
    at("2026-02-03", { open: 11, high: 15, low: 10, close: 14 }),
    at("2026-02-06", { open: 14, high: 14, low: 7, close: 8 }), // Friday
    at("2026-02-09", { open: 8, high: 9, low: 8, close: 9 }), // next Monday
    at("2026-03-02", { open: 9, high: 9, low: 9, close: 9 }),
  ];
  const range = { start: "2026-02-01", end: "2026-03-31" };
  const w = bbg.periodRows(bars, { ...range, per: "W" });
  assert.deepEqual(
    w.map((r) => r.date),
    ["2026-02-06", "2026-02-09", "2026-03-02"],
  );
  assert.deepEqual(
    [w[0].PX_OPEN, w[0].PX_HIGH, w[0].PX_LOW, w[0].PX_LAST, w[0].PX_VOLUME],
    [10, 15, 7, 8, 30],
  );
  const m = bbg.periodRows(bars, { ...range, per: "M" });
  assert.deepEqual(
    m.map((r) => [r.date, r.PX_LAST]),
    [
      ["2026-02-09", 9],
      ["2026-03-02", 9],
    ],
  );
  const d = bbg.periodRows(bars, { ...range, per: "D" });
  assert.equal(
    d[0].CHG_PCT_1D,
    10,
    "the first day's change uses the bar before the range",
  );
});

test("dates: ISO, compact and relative; nonsense is refused in plain words", () => {
  assert.equal(bbg.parseDate("2025-01-31"), "2025-01-31");
  assert.equal(bbg.parseDate("20250131"), "2025-01-31");
  assert.match(bbg.parseDate("-1Y"), /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(bbg.parseDate("", "x"), "x");
  assert.throws(() => bbg.parseDate("2025-13-45"), /isn't a date/);
});

test("CSV quotes what needs quoting", () => {
  const csv = bbg.toCsv(
    ["security", "NAME"],
    [
      { security: "A", NAME: 'Big, "Co"' },
      { security: "B", NAME: null },
    ],
  );
  assert.equal(csv, 'security,NAME\r\nA,"Big, ""Co"""\r\nB,\r\n');
});

test("GET /api/bdh works without the app header, as CSV and JSON", async () => {
  const q =
    "security=BTC&fields=PX_OPEN,PX_HIGH,PX_LOW,PX_LAST,PX_VOLUME&start=2026-01-01&end=2026-03-31&per=M";
  const r = await fetch(`${base}/api/bdh?${q}&format=csv`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/csv/);
  const lines = (await r.text()).trim().split(/\r?\n/);
  assert.equal(lines[0], "date,PX_OPEN,PX_HIGH,PX_LOW,PX_LAST,PX_VOLUME");
  assert.equal(lines.length, 4, "three months");
  assert.ok(
    lines
      .slice(1)
      .every((l) =>
        /^2026-0[123]-\d\d,[\d.]+,[\d.]+,[\d.]+,[\d.]+,[\d.]+$/.test(l),
      ),
    lines.join("\n"),
  );
  const j = await (
    await fetch(`${base}/api/bdh?${q}&fields=PX_LAST,NOT_A_FIELD`)
  ).json();
  assert.equal(j.label, "XBTUSD Curncy");
  assert.equal(j.rows.length, 3);
  assert.equal(j.rows[0].NOT_A_FIELD, null);
  assert.match(j.notes.join(" "), /NOT_A_FIELD: not a BDH field/);
});

test("GET /api/bdp fills what it can and says what it can't", async () => {
  const j = await (
    await fetch(
      `${base}/api/bdp?securities=BTC,EURUSD%20CURNCY,SPX%20INDEX&fields=NAME,PX_LAST,CHG_PCT_1D,CUR_MKT_CAP`,
    )
  ).json();
  assert.deepEqual(
    j.rows.map((r) => r.security),
    ["BTC", "EURUSD CURNCY", "SPX INDEX"],
  );
  assert.equal(j.rows[1].NAME, "EUR-USD X-RATE");
  assert.equal(j.rows[2].NAME, "S&P 500");
  assert.ok(j.rows.every((r) => r.PX_LAST > 0));
  assert.ok(j.rows.every((r) => r.CUR_MKT_CAP === null));
  assert.match(j.notes.join(" "), /US-listed stocks only/);
  const csv = await (
    await fetch(`${base}/api/bdp?securities=BTC&fields=NAME,PX_LAST&format=csv`)
  ).text();
  assert.match(csv, /^security,NAME,PX_LAST\r\nBTC,BTC-USD,[\d.]+\r\n$/);
  const missing = await fetch(`${base}/api/bdp`);
  assert.equal(missing.status, 400);
  assert.match((await missing.json()).error, /securities/);
});

test("GET /api/about tells the screens where this install lives", async () => {
  const a = await (await fetch(`${base}/api/about`)).json();
  assert.equal(a.port, port);
  assert.ok(fs.existsSync(path.join(a.dir, "scripts", "mcp.js")));
  assert.match(a.mcp, /^claude mcp add --scope user amber -- node .*mcp\.js"?$/);
  assert.ok(
    a.fields.bdp.includes("PX_LAST") && a.fields.bdh.includes("PX_VOLUME"),
  );
});

test("the API still only answers to this computer", async () => {
  const status = await new Promise((resolve, reject) => {
    http
      .get(
        {
          host: "127.0.0.1",
          port,
          path: "/api/bdp?securities=BTC",
          headers: { Host: "evil.example" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      )
      .on("error", reject);
  });
  assert.equal(status, 403);
});
