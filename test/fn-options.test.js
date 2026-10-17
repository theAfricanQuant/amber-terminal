// OMON, ECO and MOST: parsing and maths checked against real responses saved in fixtures/options/
// (captured 15 Oct 2026), plus each server function run end to end on a fake network (no live calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fj = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/options/${name}`, import.meta.url),
      "utf8",
    ),
  );
const CAPTURED = "2026-10-15";

// ---------- a fake network: url -> { status, body } ----------
let routes = [];
const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  const hit = routes.find(([re]) => re.test(u));
  if (!hit)
    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  const [, status, body] = hit;
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
  });
};
const serve = (...r) => {
  routes = r;
  calls.length = 0;
};

const omon = await import("../lib/fn/omon.js");
const eco = await import("../lib/fn/eco.js");
const most = await import("../lib/fn/most.js");

// Fixture expiries are dated from the capture day; move them so they're still open whenever the tests run.
const shift = Math.round(
  (Date.parse(omon.nyToday()) - Date.parse(CAPTURED)) / 86400e3,
);
const moveDate = (iso) => eco.addDays(iso, shift);
function cboeToday(name) {
  const j = fj(name);
  for (const o of j.data.options)
    o.option = o.option.replace(/(\d{6})([CP]\d{8})$/, (_, d, rest) => {
      const iso = moveDate(`20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}`);
      return `${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8)}${rest}`;
    });
  return j;
}
function nasdaqChainToday() {
  const j = fj("nasdaq-chain-aapl.json");
  for (const r of j.data.table.rows)
    if (r.expirygroup) {
      const d = new Date(
        `${moveDate(new Date(`${r.expirygroup} 12:00 UTC`).toISOString().slice(0, 10))}T12:00:00Z`,
      );
      r.expirygroup = d.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      });
    }
  return j;
}

// ---------- OMON: symbols ----------
test("OMON maps terminal symbols to CBOE's file names, indices with an underscore", () => {
  assert.deepEqual(omon.cboeSymbol("AAPL"), {
    ticker: "AAPL",
    file: "AAPL",
    index: false,
  });
  assert.deepEqual(omon.cboeSymbol("US:SPY"), {
    ticker: "SPY",
    file: "SPY",
    index: false,
  });
  assert.deepEqual(omon.cboeSymbol("^GSPC"), {
    ticker: "SPX",
    file: "_SPX",
    index: true,
  });
  assert.equal(omon.cboeSymbol("YAHOO:^NDX").file, "_NDX");
  assert.equal(omon.cboeSymbol("^RUT").file, "_RUT");
  assert.equal(omon.cboeSymbol("^VIX").file, "_VIX");
  assert.equal(omon.cboeSymbol("SPX").file, "_SPX");
  assert.equal(omon.cboeSymbol("BRK.B").file, "BRK.B");
  for (const bad of ["BTCUSDT", "FX:EURUSD", "^FTSE", "GC=F", "", null])
    assert.equal(omon.cboeSymbol(bad), null, String(bad));
});

test("OMON reads OCC option symbols, including weekly and adjusted roots", () => {
  assert.deepEqual(omon.parseOcc("AAPL261016C00342500"), {
    root: "AAPL",
    expiry: "2026-10-16",
    type: "C",
    strike: 342.5,
  });
  assert.deepEqual(omon.parseOcc("SPXW261120P07700000"), {
    root: "SPXW",
    expiry: "2026-11-20",
    type: "P",
    strike: 7700,
  });
  assert.equal(omon.parseOcc("AAPL1261016C00342500").root, "AAPL1");
  assert.equal(omon.parseOcc("not an option"), null);
});

// ---------- OMON: chain parsing ----------
test("OMON parses CBOE's file into open expiries with calls and puts side by side", () => {
  const c = omon.parseCboe(fj("cboe-aapl.json"), CAPTURED);
  assert.equal(c.price, 345.49);
  assert.equal(c.change, 2.53);
  assert.equal(c.iv30, 26.246);
  assert.equal(c.asOf, "2026-10-15T12:16:51Z");
  // 14 Oct had already expired on the 15th.
  assert.deepEqual(
    c.expiries.map((e) => e.date),
    ["2026-10-16", "2026-10-23"],
  );
  const rows = c.expiries[0].rows;
  assert.deepEqual(
    rows.map((r) => r.strike),
    [...rows.map((r) => r.strike)].sort((a, b) => a - b),
  );
  const k345 = rows.find((r) => r.strike === 345);
  assert.deepEqual(k345.call, {
    bid: 1.75,
    ask: 1.96,
    last: 1.83,
    iv: 0.262,
    delta: 0.4001,
    volume: 44030,
    oi: 31207,
  });
  assert.equal(k345.put.delta < 0, true);
  // No IV and no trades come back as null, not 0.
  assert.ok(
    rows
      .flatMap((r) => [r.call, r.put])
      .every((q) => q.iv === null || q.iv > 0),
  );
});

test("OMON keeps SPX's AM monthly and SPXW's PM weekly on the same day as separate expiries", () => {
  const c = omon.parseCboe(fj("cboe-spx.json"), CAPTURED);
  assert.deepEqual(
    c.expiries.map((e) => `${e.date} ${e.root}`),
    ["2026-10-15 SPXW", "2026-11-20 SPX", "2026-11-20 SPXW"],
  );
  assert.ok(Math.abs(c.price - 7718.94) < 0.01);
});

test("OMON leaves out adjusted contracts (roots ending in a digit)", () => {
  const q = {
    bid: 1,
    ask: 2,
    last: null,
    iv: 0.3,
    delta: 0.5,
    volume: 0,
    oi: 0,
  };
  const list = omon.buildExpiries(
    ["AAPL261016C00100000", "AAPL261016P00100000", "AAPL1261016C00100000"].map(
      (s) => ({ ...omon.parseOcc(s), quote: q }),
    ),
    CAPTURED,
  );
  assert.deepEqual(
    list.map((e) => e.root),
    ["AAPL"],
  );
});

test("OMON reads Nasdaq's option chain as the fallback, with no IV or delta", () => {
  const c = omon.parseNasdaqChain(
    fj("nasdaq-chain-aapl.json"),
    "AAPL",
    CAPTURED,
  );
  assert.equal(c.price, 342.96);
  assert.deepEqual(
    c.expiries.map((e) => e.date),
    ["2026-10-16", "2026-10-19"],
  );
  const r = c.expiries[0].rows.find((x) => x.strike === 337.5);
  assert.deepEqual(r.call, {
    bid: null,
    ask: null,
    last: 6.1,
    iv: null,
    delta: null,
    volume: 971,
    oi: 5648,
  });
  assert.equal(r.put.bid, 0.83);
});

// ---------- OMON: the numbers ----------
test("OMON finds the at-the-money strike and the strikes either side of it", () => {
  const rows = omon.parseCboe(fj("cboe-aapl.json"), CAPTURED).expiries[0].rows;
  assert.equal(omon.atmStrike(rows, 345.49), 345);
  assert.equal(omon.atmStrike(rows, 343.9), 345);
  assert.equal(omon.atmStrike(rows, 1000), 360);
  assert.equal(omon.atmStrike([], 100), null);
  const near = omon.nearStrikes(rows, 345, 2);
  assert.deepEqual(
    near.map((r) => r.strike),
    [340, 342.5, 345, 347.5, 350],
  );
  assert.equal(
    omon.nearStrikes(rows, 330, 2)[0].strike,
    330,
    "clipped at the lowest strike",
  );
  assert.equal(omon.nearStrikes(rows, 345, Infinity).length, rows.length);
});

test("OMON totals volume and open interest and works out put/call ratios", () => {
  const rows = omon.parseCboe(fj("cboe-aapl.json"), CAPTURED).expiries[0].rows;
  const t = omon.totals(rows);
  const sum = (side, k) => rows.reduce((s, r) => s + (r[side]?.[k] || 0), 0);
  assert.equal(t.callVolume, sum("call", "volume"));
  assert.equal(t.putOi, sum("put", "oi"));
  assert.equal(t.callVolume, 237040);
  assert.equal(t.putVolume, 183035);
  assert.ok(Math.abs(t.pcVolume - 183035 / 237040) < 1e-12);
  assert.ok(Math.abs(t.pcOi - t.putOi / t.callOi) < 1e-12);
  assert.equal(omon.putCallRatio(5, 0), null);
});

test("OMON prices the implied move from the at-the-money straddle", () => {
  const rows = omon.parseCboe(fj("cboe-aapl.json"), CAPTURED).expiries[0].rows;
  const m = omon.impliedMove(rows, 345.49);
  // 345 call 1.75 / 1.96 and put 3.45 / 3.90: mids 1.855 + 3.675.
  assert.equal(m.strike, 345);
  assert.ok(Math.abs(m.call - 1.855) < 1e-9);
  assert.ok(Math.abs(m.put - 3.675) < 1e-9);
  assert.ok(Math.abs(m.dollars - 5.53) < 1e-9);
  assert.ok(Math.abs(m.pct - (5.53 / 345.49) * 100) < 1e-9);
  // One-sided quotes fall back to the last trade; nothing at all means no move.
  assert.equal(omon.mid({ bid: 0, ask: 2, last: 1.5 }), 1.5);
  assert.equal(
    omon.impliedMove(
      [
        {
          strike: 10,
          call: { bid: 0, ask: 0, last: null },
          put: { bid: 1, ask: 1.2 },
        },
      ],
      10,
    ),
    null,
  );
});

test("OMON picks an expiry by number or date and keeps it in range", () => {
  const ex = [
    { date: "2026-10-16" },
    { date: "2026-10-23" },
    { date: "2026-10-30" },
  ];
  assert.equal(omon.pickExpiry(ex, undefined), 0);
  assert.equal(omon.pickExpiry(ex, "2"), 1);
  assert.equal(omon.pickExpiry(ex, "99"), 2);
  assert.equal(omon.pickExpiry(ex, "0"), 0);
  assert.equal(omon.pickExpiry(ex, "2026-10-30"), 2);
});

// ---------- OMON end to end ----------
test("OMON serves the chain for AAPL from CBOE: 15 strikes either side, totals and the move", async () => {
  serve([
    /cdn\.cboe\.com\/api\/global\/delayed_quotes\/options\/AAPL\.json$/,
    200,
    cboeToday("cboe-aapl.json"),
  ]);
  const d = await omon.default({ symbol: "AAPL" });
  assert.equal(d.symbol, "AAPL");
  assert.equal(d.price, 345.49);
  assert.equal(d.expiries.length, 2);
  assert.deepEqual(d.expiry, {
    n: 1,
    date: moveDate("2026-10-16"),
    root: "AAPL",
    days: 1,
  });
  assert.equal(d.atm, 345);
  // 13 strikes in this expiry, so all of them fit inside 15 either side.
  assert.equal(d.rows.length, 13);
  assert.equal(d.strikes.total, 13);
  assert.ok(d.move.pct > 1 && d.move.pct < 2);
  assert.match(d.source, /CBOE/);
  const two = await omon.default({
    symbol: "AAPL",
    expiry: "2",
    strikes: "all",
  });
  assert.equal(two.expiry.n, 2);
  assert.equal(two.strikes.shown, "all");
  assert.equal(
    calls.length,
    1,
    "the second request comes from the 60-second cache",
  );
});

test("OMON maps SPX to CBOE's _SPX file", async () => {
  serve([
    /delayed_quotes\/options\/_SPX\.json$/,
    200,
    cboeToday("cboe-spx.json"),
  ]);
  const d = await omon.default({ symbol: "^GSPC" });
  assert.equal(d.symbol, "SPX");
  assert.equal(d.index, true);
  assert.equal(d.expiries.length, 3);
  // Two roots on one date are told apart in the picker; a date with one root isn't.
  assert.deepEqual(
    d.expiries.map((e) => e.root),
    [null, "SPX", "SPXW"],
  );
});

test("OMON falls back to Nasdaq's option chain when CBOE fails", async () => {
  serve(
    [/cdn\.cboe\.com/, 503, "busy"],
    [
      /api\.nasdaq\.com\/api\/quote\/MSFT\/option-chain\?assetclass=stocks/,
      200,
      nasdaqChainToday(),
    ],
  );
  const d = await omon.default({ symbol: "MSFT" });
  assert.equal(d.price, 342.96);
  assert.equal(d.expiries.length, 2);
  assert.match(d.source, /Nasdaq/);
  assert.ok(d.rows.every((r) => r.call.iv === null));
});

test("OMON explains what to try for things that have no US options", async () => {
  await assert.rejects(
    omon.default({ symbol: "BTCUSDT" }),
    (e) =>
      e.status === 400 &&
      /US stocks, ETFs and the main US indices/.test(e.message),
  );
  serve(
    [/cdn\.cboe\.com/, 403, "no"],
    [/api\.nasdaq\.com/, 200, { data: null, status: { rCode: 400 } }],
  );
  await assert.rejects(
    omon.default({ symbol: "ZZZZ" }),
    (e) =>
      e.status === 404 && /No listed options found for ZZZZ/.test(e.message),
  );
});

// ---------- ECO ----------
test("ECO asks Nasdaq for the next date, since it files each day's events one date late", () => {
  assert.equal(eco.nasdaqDateFor("2026-10-15"), "2026-10-16");
  assert.equal(eco.addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(eco.addDays("2026-12-31", 1), "2027-01-01");
});

test("ECO cleans Nasdaq's empty cells and entities", () => {
  assert.equal(eco.cell("&nbsp;"), null);
  assert.equal(eco.cell(" "), null);
  assert.equal(eco.cell(null), null);
  assert.equal(eco.cell("S&amp;P Global"), "S&P Global");
  assert.equal(eco.cell(" 1,710K "), "1,710K");
});

test("ECO reads a Nasdaq day: New York times to UTC, actuals, all-day holidays", () => {
  const rows = eco.parseNasdaqDay(fj("nasdaq-eco.json"), CAPTURED);
  assert.equal(rows.length, 12);
  const ip = rows.find((r) => r.country === "Japan");
  assert.deepEqual(ip, {
    day: CAPTURED,
    time: "2026-10-15T04:30:00.000Z",
    when: null,
    country: "Japan",
    event: "Industrial Production",
    actual: "-2.4%",
    consensus: "-1.7%",
    previous: "-0.2%",
    impact: null,
  });
  const claims = rows.find((r) => r.event === "Initial Jobless Claims");
  assert.equal(claims.time, "2026-10-15T12:30:00.000Z");
  assert.equal(claims.actual, null);
  assert.equal(claims.consensus, "199K");
  assert.ok(rows.some((r) => r.event === "External Migration & Visitors"));
  const holiday = rows.find((r) => r.time === null);
  assert.equal(holiday.when, "All day");
  // New York winter time is five hours behind UTC.
  const dec = eco.parseNasdaqDay(
    {
      data: {
        rows: [{ gmt: "08:30", country: "United States", eventName: "CPI" }],
      },
    },
    "2026-12-10",
  );
  assert.equal(dec[0].time, "2026-12-10T13:30:00.000Z");
});

test("ECO maps Forex Factory rows into the same shape, with importance and no actuals", () => {
  const rows = eco.fromForexFactory(fj("ff-calendar.json"));
  assert.equal(rows.length, 8);
  for (const r of rows) {
    assert.equal(r.actual, null);
    assert.match(r.day, /^2026-10-1[56]$/);
    assert.ok(r.impact);
    assert.ok(r.time.endsWith("Z"));
  }
});

test("ECO loads five days from Nasdaq with a cache-buster, sorted by time", async () => {
  serve([
    /api\.nasdaq\.com\/api\/calendar\/economicevents\?date=\d{4}-\d{2}-\d{2}&_=\d+$/,
    200,
    fj("nasdaq-eco.json"),
  ]);
  const d = await eco.loadEco(CAPTURED);
  assert.equal(calls.length, 5);
  assert.match(calls[0], /date=2026-10-16&/);
  assert.match(calls[4], /date=2026-10-20&/);
  assert.equal(d.impact, false);
  assert.equal(d.rows.length, 60);
  for (let i = 1; i < d.rows.length; i++) {
    const [a, b] = [d.rows[i - 1], d.rows[i]];
    assert.ok(
      a.day < b.day ||
        (a.day === b.day && (a.time === null || (b.time && a.time <= b.time))),
      `row ${i} out of order`,
    );
  }
  assert.match(d.source, /^Nasdaq economic calendar/);
});

test("ECO falls back to Forex Factory when Nasdaq fails", async () => {
  serve(
    [/api\.nasdaq\.com/, 503, "busy"],
    [
      /nfs\.faireconomy\.media\/ff_calendar_thisweek\.json/,
      200,
      fj("ff-calendar.json"),
    ],
  );
  const d = await eco.loadEco(CAPTURED);
  assert.equal(d.impact, true);
  assert.equal(d.rows.length, 8);
  assert.match(d.source, /Forex Factory/);
});

// ---------- MOST ----------
test("MOST reads a movers row: % change worked out for the volume list", () => {
  const r = most.parseRow(
    {
      symbol: "NVDA",
      name: "NVIDIA Corporation",
      lastSalePrice: "$221.3",
      lastSaleChange: "-7.22",
      change: "115,974,373.199869",
    },
    "volume",
  );
  assert.equal(r.volume, 115974373);
  assert.ok(Math.abs(r.changePct - (-7.22 / 228.52) * 100) < 1e-9);
  const g = most.parseRow(
    {
      symbol: "BSP",
      name: "Bending Spoons",
      lastSalePrice: "$53.46",
      lastSaleChange: "+15.6",
      change: "+41.2044%",
    },
    "pct",
  );
  assert.equal(g.changePct, 41.2044);
  assert.equal(g.volume, null);
});

test("MOST drops warrants, rights, units and sub-$1 shares", () => {
  const junk = (ticker, name, price) => most.isJunk({ ticker, name, price });
  assert.equal(junk("GLNDW", "Greenland Energy Company Warrant", 1.01), true);
  assert.equal(junk("HCICR", "Hennessy Capital Share Rights", 1.2), true);
  assert.equal(junk("TGL", "Treasure Global Inc.", 0.45), true);
  assert.equal(junk("NVDA", "NVIDIA Corporation", 221.3), false);
  assert.equal(junk("UNH", "UnitedHealth Group", 300), false);
});

test("MOST builds the three tabs from Nasdaq's market movers", () => {
  const m = most.parseMovers(fj("nasdaq-movers.json"));
  assert.equal(m.asOf, "Oct 14, 2026 4:15 PM ET");
  assert.deepEqual(Object.keys(m.tabs), ["VOLUME", "GAINERS", "LOSERS"]);
  const all = Object.values(m.tabs).flatMap((s) => s.flatMap((x) => x.rows));
  assert.ok(
    all.every(
      (r) => r.price >= 1 && !/W$/.test(r.ticker.length === 5 ? r.ticker : ""),
    ),
  );
  const shares = m.tabs.VOLUME[0].rows;
  assert.equal(
    new Set(shares.map((r) => r.ticker)).size,
    shares.length,
    "no duplicate tickers",
  );
  assert.ok(
    shares.every((r, i) => i === 0 || shares[i - 1].volume >= r.volume),
  );
  assert.equal(m.tabs.VOLUME[1].rows[0].ticker, "SPY");
  const ndxUp = m.tabs.GAINERS[1].rows;
  assert.ok(
    ndxUp.every(
      (r, i) =>
        r.changePct > 0 && (i === 0 || ndxUp[i - 1].changePct >= r.changePct),
    ),
  );
  const ndxDown = m.tabs.LOSERS[1].rows;
  assert.ok(
    ndxDown.every(
      (r, i) =>
        r.changePct < 0 && (i === 0 || ndxDown[i - 1].changePct <= r.changePct),
    ),
  );
  assert.equal(most.parseMovers({ data: null }), null);
});

test("MOST ranks the screener the old way when the movers fail", async () => {
  const tabs = most.fromScreener(
    JSON.parse(
      readFileSync(
        new URL("./fixtures/screener-us.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  for (const k of ["VOLUME", "GAINERS", "LOSERS"])
    assert.ok(tabs[k][0].rows.every((r) => r.marketCap > 3e8));
  const g = tabs.GAINERS[0].rows;
  assert.ok(g.every((r, i) => i === 0 || g[i - 1].changePct >= r.changePct));

  serve(
    [/api\/marketmovers/, 503, "busy"],
    [
      /api\/screener\/stocks/,
      200,
      {
        data: {
          rows: [
            {
              symbol: "AAPL",
              name: "Apple Inc.",
              lastsale: "$342.96",
              pctchange: "0.50%",
              volume: "40000000",
              marketCap: "5000000000000",
              sector: "Technology",
            },
            {
              symbol: "TINY",
              name: "Tiny Co",
              lastsale: "$3.00",
              pctchange: "30%",
              volume: "900000",
              marketCap: "1000000",
              sector: "Industrials",
            },
          ],
        },
      },
    ],
    [/api\/quote\/watchlist/, 503, "busy"],
  );
  const d = await most.loadMost();
  assert.deepEqual(
    d.tabs.GAINERS[0].rows.map((r) => r.ticker),
    ["AAPL"],
  );
  assert.match(d.source, /screener/);
});

test("MOST serves Nasdaq's movers through the cached function", async () => {
  serve([
    /api\.nasdaq\.com\/api\/marketmovers\?assetclass=stocks&exchangestatus=currentMarket&limit=100$/,
    200,
    fj("nasdaq-movers.json"),
  ]);
  const d = await most.default();
  assert.match(d.source, /^Nasdaq market movers.*Oct 14, 2026 4:15 PM ET/);
  assert.ok(d.tabs.GAINERS[0].rows.length >= 1);
});

// ---------- the screens ----------
test("OMON, ECO and MOST screens are registered with a render function", async () => {
  const screens = (await import("../public/js/fn/options.js")).default;
  assert.deepEqual(
    screens.map((s) => s.id),
    ["OMON"],
  );
  assert.equal(screens[0].needs, true);
  const cal = (await import("../public/js/fn/calendar.js")).default;
  for (const s of [...screens, ...cal]) {
    assert.equal(typeof s.render, "function");
    assert.ok(s.name && s.source && s.group);
  }
  assert.match(cal.find((s) => s.id === "ECO").source, /Nasdaq/);
});
