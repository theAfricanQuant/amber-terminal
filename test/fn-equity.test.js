// COMP, EQS, PORT, DVD, EE and ANR: the maths checked against cases worked out by hand, and the parsers
// against public responses and synthetic broker-style CSV examples saved in fixtures/equity/.
// The server functions run on a fake network, so nothing here calls the internet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fx = (name) =>
  readFileSync(new URL(`./fixtures/equity/${name}`, import.meta.url), "utf8");
const fj = (name) => JSON.parse(fx(name));
const near = (a, b, tol = 1e-9, msg) =>
  assert.ok(Math.abs(a - b) <= tol, msg || `${a} is not within ${tol} of ${b}`);

// ---------- a fake network: url -> body ----------
let routes = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  const hit = routes.find(([re]) => re.test(u));
  if (!hit)
    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  const body = typeof hit[1] === "function" ? hit[1](u) : hit[1];
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
  });
};

const m = await import("../lib/fn/eq-math.js");
const eqs = await import("../lib/fn/eqs.js");
const dvd = await import("../lib/fn/dvd.js");
const ee = await import("../lib/fn/ee.js");
const anr = await import("../lib/fn/anr.js");
const port = await import("../lib/fn/eq-port.js");
const ui = await import("../public/js/fn/equity.js");

const DAY = 86400;
const T0 = Date.UTC(2026, 0, 5) / 1000;
const barsOf = (closes, start = T0, step = DAY) =>
  closes.map((c, i) => ({ time: start + i * step, close: c }));

// ---------- COMP ----------
test("COMP: range start is the same calendar date back, safe at month ends", () => {
  const oct15 = Date.UTC(2026, 9, 15) / 1000;
  assert.equal(m.rangeStart(oct15, "1Y"), Date.UTC(2025, 9, 15) / 1000);
  assert.equal(m.rangeStart(oct15, "5Y"), Date.UTC(2021, 9, 15) / 1000);
  assert.equal(m.rangeStart(oct15, "6M"), Date.UTC(2026, 3, 15) / 1000);
  assert.equal(m.rangeStart(oct15, "1M"), Date.UTC(2026, 8, 15) / 1000);
  assert.equal(
    m.rangeStart(Date.UTC(2026, 2, 31) / 1000, "1M"),
    Date.UTC(2026, 1, 28) / 1000,
  );
  assert.equal(
    m.rangeStart(Date.UTC(2024, 1, 29) / 1000, "1Y"),
    Date.UTC(2023, 1, 28) / 1000,
  );
});

test("COMP: rebases to 100, and return, volatility and drawdown match the hand calculation", () => {
  // Closes 100, 110, 99, 121. Daily returns +10%, -10%, +22.22% (22/99).
  // Mean 0.0740741; sample variance = (0.0259259^2 + 0.1740741^2 + 0.1481481^2) / 2 = 0.0264609
  // sd 0.1626681 x sqrt(252) = 2.582276 -> 258.23%. Worst fall from a peak: 110 -> 99 = -10%.
  const line = m.compLine(barsOf([100, 110, 99, 121]), T0);
  assert.deepEqual(
    line.points.map((p) => +p.value.toFixed(6)),
    [100, 110, 99, 121],
  );
  near(line.ret, 21, 1e-9);
  near(line.mdd, -10, 1e-9);
  near(line.vol, 258.2275769, 1e-6);
  assert.equal(line.first, 100);
  assert.equal(line.last, 121);
});

test("COMP: bars before the start are left out, and the first one after it is the base", () => {
  const line = m.compLine(barsOf([50, 80, 200, 220, 180]), T0 + 2 * DAY);
  assert.equal(line.from, T0 + 2 * DAY);
  assert.deepEqual(
    line.points.map((p) => +p.value.toFixed(9)),
    [100, 110, 90],
  );
  near(line.ret, -10, 1e-9);
  near(line.mdd, (180 / 220 - 1) * 100, 1e-9); // -18.18%, from the 220 peak, not the earlier 50
  assert.equal(m.compLine(barsOf([1, 2]), T0 + 5 * DAY), null);
});

test("COMP: crypto volatility uses 365 days a year, everything else 252", () => {
  const closes = [100, 102, 99, 103, 101, 104];
  const sd = m.stdevSample(m.returns(closes));
  near(m.annualVol(closes, 252), sd * Math.sqrt(252) * 100, 1e-12);
  near(
    m.annualVol(closes, 365) / m.annualVol(closes, 252),
    Math.sqrt(365 / 252),
    1e-12,
  );
});

test("COMP: securities split into groups of ticker, exchange code and yellow key", () => {
  assert.deepEqual(ui.secGroups(["AAPL", "MSFT", "NVDA"]), [
    ["AAPL"],
    ["MSFT"],
    ["NVDA"],
  ]);
  assert.deepEqual(ui.secGroups(["NDX", "INDEX", "SPX", "INDEX"]), [
    ["NDX", "INDEX"],
    ["SPX", "INDEX"],
  ]);
  assert.deepEqual(
    ui.secGroups(["VOD", "LN", "AAPL", "US", "EQUITY", "BTC", "GC1", "COMDTY"]),
    [["VOD", "LN"], ["AAPL", "US", "EQUITY"], ["BTC"], ["GC1", "COMDTY"]],
  );
  assert.equal(ui.PALETTE.length, 6);
  assert.equal(new Set(ui.PALETTE).size, 6);
});

// ---------- EQS ----------
const rows = fj("nasdaq-screener-rows.json");

test("EQS: amounts read with K, M, B and T", () => {
  assert.equal(eqs.amount("10B"), 10e9);
  assert.equal(eqs.amount("2.5k"), 2500);
  assert.equal(eqs.amount("1,000"), 1000);
  assert.equal(eqs.amount("-5"), -5);
  assert.equal(eqs.amount("1.2T"), 1.2e12);
  assert.equal(eqs.amount(""), null);
  assert.equal(eqs.amount("lots"), null);
});

test("EQS: LARGE TECH keeps only technology stocks worth $10B or more, biggest first", () => {
  const f = eqs.filtersFrom({ preset: "LARGE TECH" });
  assert.deepEqual(
    { sector: f.sector, capMin: f.capMin, sort: f.sort, dir: f.dir },
    { sector: "Technology", capMin: 10e9, sort: "marketCap", dir: "desc" },
  );
  const { total, rows: out } = eqs.screen(rows, f);
  const expected = rows
    .filter((r) => r.sector === "Technology" && r.marketCap >= 10e9)
    .sort((a, b) => b.marketCap - a.marketCap)
    .map((r) => r.ticker);
  assert.ok(expected.length >= 5);
  assert.equal(total, expected.length);
  assert.deepEqual(
    out.map((r) => r.ticker),
    expected,
  );
  assert.equal(out[0].ticker, "NVDA");
  assert.ok(!out.some((r) => r.ticker === "JPM" || r.ticker === "KO"));
});

test("EQS: every filter on the form, and stocks with no market cap can't pass a cap filter", () => {
  const f = eqs.filtersFrom({
    priceMin: "50",
    priceMax: "400",
    chgMin: "-1",
    chgMax: "2",
    volMin: "1M",
    country: "United States",
    sort: "price",
    dir: "asc",
  });
  const { rows: out } = eqs.screen(rows, f);
  assert.ok(out.length > 0);
  for (const r of out) {
    assert.ok(r.price >= 50 && r.price <= 400, r.ticker);
    assert.ok(r.changePct >= -1 && r.changePct <= 2, r.ticker);
    assert.ok(r.volume >= 1e6, r.ticker);
    assert.equal(r.country, "United States");
  }
  assert.deepEqual(
    out.map((r) => r.price),
    out.map((r) => r.price).sort((a, b) => a - b),
  );
  const noCap = rows.find((r) => !r.marketCap);
  assert.ok(noCap, "fixture has a stock with no market cap");
  assert.ok(
    !eqs
      .screen(rows, eqs.filtersFrom({ capMax: "1T" }))
      .rows.some((r) => r.ticker === noCap.ticker),
  );
  assert.ok(
    eqs
      .screen(rows, eqs.filtersFrom({}))
      .rows.some((r) => r.ticker === noCap.ticker),
  );
});

test("EQS: GAINERS sorts by the day's move and skips pennies and tiny companies", () => {
  const { rows: out } = eqs.screen(
    rows,
    eqs.filtersFrom({ preset: "GAINERS" }),
  );
  for (const r of out)
    assert.ok(
      r.changePct >= 0 && r.price >= 5 && r.marketCap >= 300e6,
      r.ticker,
    );
  for (let i = 1; i < out.length; i++)
    assert.ok(out[i - 1].changePct >= out[i].changePct);
});

test("EQS: at most 200 rows go to the browser, with the full count", () => {
  const many = Array.from({ length: 250 }, (_, i) => ({
    ticker: `T${String(i).padStart(3, "0")}`,
    price: 10 + i,
    changePct: 0,
    volume: 1e6,
    marketCap: 1e9 + i,
    sector: "Technology",
    country: "United States",
  }));
  const res = eqs.screen(many, eqs.filtersFrom({ sort: "ticker" }));
  assert.equal(res.total, 250);
  assert.equal(res.rows.length, eqs.MAX_ROWS);
  assert.equal(res.rows[0].ticker, "T000");
});

test("EQS: the server function screens Nasdaq's list end to end", async () => {
  const raw = rows.map((r) => ({
    symbol: r.ticker,
    name: r.name,
    lastsale: `$${r.price}`,
    pctchange: `${r.changePct}%`,
    volume: String(r.volume),
    marketCap: String(r.marketCap),
    sector: r.sector,
    industry: r.industry,
    country: r.country,
  }));
  routes = [
    [/api\.nasdaq\.com\/api\/screener\/stocks/, { data: { rows: raw } }],
    [/api\.nasdaq\.com\/api\/quote\/watchlist/, { data: [] }],
  ];
  const d = await eqs.default({ preset: "MEGA", sort: "marketCap" });
  assert.equal(d.universe, rows.length);
  assert.ok(d.rows.every((r) => r.marketCap >= 200e9));
  assert.equal(d.rows[0].ticker, "NVDA");
  assert.equal(d.sectors[0].name, eqs.facets(rows).sectors[0].name);
  assert.match(d.source, /Nasdaq/);
});

// ---------- PORT ----------
test("PORT: value, cost, P&L, today's change and weights, worked out by hand", () => {
  const { rows: r, totals: t } = m.valueHoldings([
    // 10 at 100, now 120, up 20% today (so 100 yesterday)
    { sec: "AAA", shares: 10, cost: 100, price: 120, changePct: 20, fx: 1 },
    // 5 at 50, now 40, down 20% today (so 50 yesterday)
    { sec: "BBB", shares: 5, cost: 50, price: 40, changePct: -20, fx: 1 },
    // 1,000 London shares bought at 70p, now 120p, flat today; $1.32 per pound -> $0.0132 per penny
    {
      sec: "VOD LN",
      shares: 1000,
      cost: 70,
      price: 120,
      changePct: 0,
      fx: 0.0132,
    },
  ]);
  near(r[0].value, 1200, 1e-9);
  near(r[0].pnl, 200, 1e-9);
  near(r[0].pnlPct, 20, 1e-9);
  near(r[0].dayChg, 200, 1e-9);
  near(r[1].value, 200, 1e-9);
  near(r[1].pnl, -50, 1e-9);
  near(r[1].pnlPct, -20, 1e-9);
  near(r[1].dayChg, -50, 1e-9);
  near(r[2].value, 1584, 1e-9);
  near(r[2].costValue, 924, 1e-9);
  near(r[2].pnl, 660, 1e-9);
  near(t.value, 2984, 1e-9);
  near(t.cost, 2174, 1e-9);
  near(t.pnl, 810, 1e-9);
  near(t.pnlPct, (810 / 2174) * 100, 1e-9);
  near(t.dayChg, 150, 1e-9);
  near(t.dayChgPct, (150 / 2834) * 100, 1e-9); // against yesterday's value, 2,984 - 150
  near(r[0].weight, (1200 / 2984) * 100, 1e-9);
  near(r[1].weight, (200 / 2984) * 100, 1e-9);
  near(r[2].weight, (1584 / 2984) * 100, 1e-9);
  near(
    r.reduce((s, x) => s + x.weight, 0),
    100,
    1e-9,
  );
});

test("PORT: a holding with no price or no cost stays out of the totals it can't add to", () => {
  const { rows: r, totals: t } = m.valueHoldings([
    { shares: 2, cost: 10, price: 15, changePct: 0, fx: 1 },
    { shares: 3, cost: null, price: 20, changePct: 0, fx: 1 },
    { shares: 4, cost: 5, price: undefined, changePct: undefined, fx: 1 },
  ]);
  assert.equal(r[1].pnl, null);
  assert.equal(r[2].value, null);
  near(t.value, 90, 1e-9);
  near(t.cost, 20, 1e-9); // only priced holdings' cost
});

test("PORT: beta is covariance over the market's variance (hand-checked case)", () => {
  // Market returns alternate +1%/-1% (mean 0), so beta = sum(a*m) / sum(m*m) = 13 / 10 = 1.3.
  const mk = [1, -1, 1, -1, 1, -1, 1, -1, 1, -1].map((x) => x / 100);
  const a = [2, 0, 1, -1, 3, -2, 1, 0, 2, -1].map((x) => x / 100);
  near(m.beta(a, mk), 1.3, 1e-12);
  near(m.beta(mk, mk), 1, 1e-12);
  near(
    m.beta(
      mk.map((x) => 2 * x + 0.001),
      mk,
    ),
    2,
    1e-12,
  );
  near(
    m.beta(
      mk.map((x) => -x),
      mk,
    ),
    -1,
    1e-12,
  );
  assert.equal(m.beta([0.01, 0.02], [0.01, 0.02]), null); // too few days to say
});

test("PORT: returns line up on the days both traded (weekend crypto, holidays)", () => {
  // Market trades Mon-Fri; the coin trades every day. Friday -> Monday is one return for both.
  const mon = Date.UTC(2026, 9, 5) / 1000;
  const market = [0, 1, 2, 3, 4, 7, 8].map((d, i) => ({
    time: mon + d * DAY,
    close: [100, 101, 99, 100, 102, 103, 101][i],
  }));
  const coin = Array.from({ length: 9 }, (_, d) => ({
    time: mon + d * DAY + 3600,
    close: 1000 + d * 10,
  }));
  const { a, b } = m.alignedReturns(coin, market);
  assert.equal(a.length, 6);
  near(b[0], 0.01, 1e-12);
  near(a[4], 1070 / 1040 - 1, 1e-12); // Friday (1040) to Monday (1070)
  near(b[4], 103 / 102 - 1, 1e-12);
});

test("PORT: risk for the portfolio; a holding that is the market has beta 1", () => {
  const closes = [
    100, 101, 99, 102, 103, 101, 104, 106, 105, 107, 108, 106, 109,
  ];
  const market = barsOf(closes);
  // Every daily move twice the market's, compounded: beta 2.
  const double = barsOf(
    closes.reduce(
      (acc, c, i) => [...acc, i ? acc[i - 1] * (1 + 2 * (c / closes[i - 1] - 1)) : 100],
      [],
    ),
  );
  const rowsIn = [
    { value: 3000, bars: market },
    { value: 1000, bars: barsOf(closes.map((c) => c * 2)) },
  ];
  const r = port.risk(rowsIn, market);
  near(rowsIn[0].beta, 1, 1e-12);
  near(rowsIn[1].beta, 1, 1e-12);
  near(r.beta, 1, 1e-12);
  near(r.vol, m.annualVol(closes), 1e-9); // both holdings move like the market
  const one = [{ value: 1000, bars: double }];
  near(port.risk(one, market).beta, 2, 1e-9);
  near(one[0].vol, 2 * m.annualVol(closes), 1e-9);
});

test("PORT: sector mix adds up values by sector", () => {
  const mix = port.sectorMix([
    { value: 300, sector: "Technology" },
    { value: 100, sector: "Crypto" },
    { value: 100, sector: "Technology" },
    { value: null, sector: "Index" },
  ]);
  assert.deepEqual(mix, [
    { sector: "Technology", value: 400, weight: 80 },
    { sector: "Crypto", value: 100, weight: 20 },
  ]);
});

test("PORT: saved holdings are cleaned before use", () => {
  assert.deepEqual(
    port.cleanHoldings([
      { sec: " nvda ", shares: "10", cost: "120" },
      { sec: "BTC", shares: 0.5 },
      { sec: "AAPL", shares: 0, cost: 1 },
      { sec: "", shares: 1 },
      null,
    ]),
    [
      { sec: "NVDA", shares: 10, cost: 120 },
      { sec: "BTC", shares: 0.5, cost: null },
    ],
  );
});

test("PORT: ADD and DEL from the command line", () => {
  let r = ui.editPort([], "ADD", ["NVDA", "10", "120"]);
  assert.deepEqual(r.list, [{ sec: "NVDA", shares: 10, cost: 120 }]);
  r = ui.editPort(r.list, "ADD", ["VOD", "LN", "1000", "70.5"]);
  r = ui.editPort(r.list, "ADD", ["NVDA", "US", "12", "125"]); // same security: replaced, not doubled
  assert.deepEqual(r.list, [
    { sec: "VOD LN", shares: 1000, cost: 70.5 },
    { sec: "NVDA US", shares: 12, cost: 125 },
  ]);
  r = ui.editPort(r.list, "ADD", ["BTC", "0.25"]);
  assert.deepEqual(r.list.at(-1), { sec: "BTC", shares: 0.25, cost: null });
  r = ui.editPort(r.list, "DEL", ["NVDA"]);
  assert.deepEqual(
    r.list.map((h) => h.sec),
    ["VOD LN", "BTC"],
  );
  assert.ok(ui.editPort(r.list, "DEL", ["TSLA"]).error);
  assert.ok(ui.editPort(r.list, "ADD", ["TSLA"]).error);
});

// ---------- PORT IMPORT ----------
test("PORT IMPORT: numbers as brokers write them", () => {
  assert.equal(ui.csvNumber("$1,234.50"), 1234.5);
  assert.equal(ui.csvNumber("(4,532.40)"), -4532.4);
  assert.equal(ui.csvNumber("+44.16%"), 44.16);
  assert.equal(ui.csvNumber("--"), null);
  assert.equal(ui.csvNumber(""), null);
  assert.equal(ui.csvNumber("N/A"), null);
});

test("PORT IMPORT: CSV cells with quotes, commas inside quotes, and tab or semicolon files", () => {
  assert.deepEqual(ui.csvRows('a,"b, c","say ""hi"""\r\n1,2,3'), [
    ["a", "b, c", 'say "hi"'],
    ["1", "2", "3"],
  ]);
  assert.deepEqual(ui.csvRows("Symbol\tQuantity\nAAPL\t5\n"), [
    ["Symbol", "Quantity"],
    ["AAPL", "5"],
  ]);
  assert.deepEqual(
    ui.parseHoldingsCsv("Symbol;Quantity;Average price\nAAPL;5;100.0\n")
      .holdings[0].sec,
    "AAPL",
  );
});

test("PORT IMPORT: a Schwab-style export (preamble line, cost basis as a total)", () => {
  const r = ui.parseHoldingsCsv(fx("schwab-positions.csv"));
  assert.deepEqual(r.holdings, [
    { sec: "AAPL", shares: 2, cost: 100 },
    { sec: "NVDA", shares: 3, cost: 100 },
    { sec: "VTI", shares: 4, cost: 100 },
  ]);
  assert.deepEqual(
    r.skipped.map((s) => s.text),
    ["AAPL 01/01/2030 500.00 C", "Cash & Cash Investments", "Account Total"],
  );
  assert.equal(r.columns.shares, "Qty (Quantity)");
  assert.match(r.columns.cost, /^Cost Basis \(a total/);
});

test("PORT IMPORT: a Fidelity-style export (two lots of one stock, cash sweep, footer notes)", () => {
  const r = ui.parseHoldingsCsv(fx("fidelity-positions.csv"));
  assert.equal(r.columns.cost, "Average Cost Basis");
  assert.deepEqual(
    r.holdings.map((h) => [h.sec, h.shares]),
    [
      ["MSFT", 5],
      ["KO", 3],
      ["FXAIX", 4.5],
    ],
  );
  // Two MSFT lots at $5 and $7 average to $6.20 per share.
  near(r.holdings[0].cost, 6.2, 1e-6);
  near(r.holdings[1].cost, 8, 1e-9);
  assert.deepEqual(
    r.skipped.map((s) => [s.text, s.why]),
    [
      ["SPAXX**", "No quantity"],
      ["Pending Activity", "Not a stock, fund or crypto ticker"],
    ],
  );
});

test("PORT IMPORT: an Interactive Brokers-style statement (sections, class shares, non-dollar, options)", () => {
  const r = ui.parseHoldingsCsv(fx("ibkr-activity.csv"));
  assert.equal(r.columns.cost, "Cost Price");
  assert.deepEqual(r.holdings, [
    { sec: "AMD", shares: 2, cost: 10 },
    { sec: "BRK-B", shares: 1, cost: 100 },
    { sec: "BKNG", shares: 1, cost: 1000 },
    { sec: "ETH", shares: 0.5, cost: 1000 },
  ]);
  assert.deepEqual(
    r.skipped.map((s) => s.text),
    ["VOD", "SPY 01JAN30 500 P"],
  );
  assert.match(r.skipped[0].why, /GBP/);
});

test("PORT IMPORT: a file without the columns says so, and imports merge by security", () => {
  assert.ok(ui.parseHoldingsCsv("Name,Value\nApple,100\n").error);
  const merged = ui.mergePort(
    [
      { sec: "AAPL", shares: 1, cost: 1 },
      { sec: "TSLA", shares: 2, cost: 2 },
    ],
    [{ sec: "AAPL", shares: 50, cost: 185 }],
  );
  assert.deepEqual(merged, [
    { sec: "TSLA", shares: 2, cost: 2 },
    { sec: "AAPL", shares: 50, cost: 185 },
  ]);
});

// ---------- DVD ----------
test("DVD: Nasdaq's history parses to ISO dates and dollar amounts", () => {
  const h = dvd.parseNasdaq(fj("nasdaq-dividends-aapl.json"));
  assert.equal(h.length, 12);
  assert.deepEqual(h[0], {
    exDate: "2026-08-10",
    amount: 0.27,
    type: "Cash",
    declared: "2026-07-30",
    record: "2026-08-10",
    paid: "2026-08-13",
    currency: "USD",
  });
  for (let i = 1; i < h.length; i++) assert.ok(h[i - 1].exDate > h[i].exDate);
  // NYSE stocks: Nasdaq answers with no rows, so the Yahoo fallback runs.
  assert.equal(dvd.parseNasdaq(fj("nasdaq-dividends-ko.json")), null);
});

test("DVD: Yahoo's dividend events give New York ex-dates", () => {
  const h = dvd.parseYahoo(fj("yahoo-chart-div-ko.json"));
  assert.equal(h.length, 12);
  assert.deepEqual(h[0], {
    exDate: "2026-09-15",
    amount: 0.53,
    type: "Cash",
    currency: "USD",
  });
  assert.equal(h.at(-1).exDate, "2023-11-30");
});

test("DVD: yield, frequency and the last 12 months, by hand for Apple", () => {
  const s = dvd.summarize(
    dvd.parseNasdaq(fj("nasdaq-dividends-aapl.json")),
    346.93,
    "2026-10-15",
  );
  assert.equal(s.frequency, "Quarterly");
  assert.equal(s.perYear, 4);
  near(s.indicatedAnnual, 1.08, 1e-12); // $0.27 x 4
  near(s.yieldPct, (1.08 / 346.93) * 100, 1e-12); // 0.3113%, Nasdaq shows 0.31%
  near(s.trailing12m, 0.27 + 0.27 + 0.26 + 0.26, 1e-12); // ex-dates Nov 2025 to Aug 2026
  assert.equal(s.lastExDate, "2026-08-10");
  assert.equal(s.nextExDate, null);
});

test("DVD: an announced ex-date shows as next; monthly payers and stopped payers", () => {
  const h = [
    { exDate: "2026-11-09", amount: 0.28, type: "Cash", paid: "2026-11-12" },
    ...dvd.parseNasdaq(fj("nasdaq-dividends-aapl.json")),
  ];
  const s = dvd.summarize(h, 350, "2026-10-15");
  assert.equal(s.nextExDate, "2026-11-09");
  assert.equal(s.nextPayDate, "2026-11-12");
  near(s.indicatedAnnual, 1.12, 1e-12); // the announced $0.28 x 4
  const monthly = Array.from({ length: 13 }, (_, i) => ({
    exDate: new Date(Date.UTC(2025, 9 + i, 1)).toISOString().slice(0, 10),
    amount: 0.1,
    type: "Cash",
  })).reverse();
  const mo = dvd.summarize(monthly, 12, "2026-10-15");
  assert.equal(mo.frequency, "Monthly");
  near(mo.indicatedAnnual, 1.2, 1e-12);
  near(mo.yieldPct, 10, 1e-9);
  const stopped = dvd.summarize(
    [
      { exDate: "2024-03-01", amount: 0.5, type: "Cash" },
      { exDate: "2023-12-01", amount: 0.5, type: "Cash" },
      { exDate: "2023-09-01", amount: 0.5, type: "Cash" },
    ],
    20,
    "2026-10-15",
  );
  assert.equal(stopped.frequency, "No recent dividend");
  assert.equal(stopped.yieldPct, null);
  assert.equal(dvd.summarize([], 20, "2026-10-15").frequency, "Doesn't pay");
});

test("DVD: the server function falls back to Yahoo for an NYSE stock", async () => {
  routes = [
    [
      /api\.nasdaq\.com\/api\/quote\/KO\/dividends/,
      fx("nasdaq-dividends-ko.json"),
    ],
    [
      /query1\.finance\.yahoo\.com\/v8\/finance\/chart\/KO/,
      fx("yahoo-chart-div-ko.json"),
    ],
    [/api\.nasdaq\.com\/api\/screener\/etf/, { data: { rows: [] } }],
    [
      /api\.nasdaq\.com\/api\/quote\/watchlist/,
      {
        data: [
          {
            symbol: "KO",
            lastSalePrice: "$93.16",
            percentageChange: "+1.50%",
            volume: "1,000",
          },
        ],
      },
    ],
  ];
  const d = await dvd.default({ symbol: "KO" });
  assert.equal(d.price, 93.16);
  assert.equal(d.frequency, "Quarterly");
  near(d.yieldPct, ((0.53 * 4) / 93.16) * 100, 1e-12);
  assert.match(d.source, /Yahoo/);
  await assert.rejects(dvd.default({ symbol: "VOD.L" }), /US-listed/);
});

// ---------- EE, ANR ----------
test("EE: consensus estimates and the last four surprises", () => {
  const f = ee.parseForecast(fj("nasdaq-earnings-forecast-aapl.json"));
  assert.equal(f.quarterly.length, 5);
  assert.deepEqual(f.quarterly[0], {
    period: "Sep 2026",
    consensus: 1.99,
    high: 2.09,
    low: 1.96,
    estimates: 7,
    up: 1,
    down: 0,
  });
  assert.equal(f.yearly[1].consensus, 9.54);
  const s = ee.parseSurprise(fj("nasdaq-earnings-surprise-aapl.json"));
  assert.equal(s.length, 4);
  assert.deepEqual(s[0], {
    period: "Jun 2026",
    reported: "7/30/2026",
    eps: 1.91,
    consensus: 1.88,
    surprisePct: 1.6,
    beat: "Beat",
  });
  // Nasdaq's surprise matches (EPS - forecast) / forecast.
  for (const r of s)
    near(r.surprisePct, ((r.eps - r.consensus) / r.consensus) * 100, 0.01);
});

test("ANR: buy, hold and sell counts and price targets", () => {
  const t = anr.parseTargets(fj("nasdaq-targetprice-aapl.json"));
  assert.deepEqual(
    {
      buy: t.buy,
      hold: t.hold,
      sell: t.sell,
      analysts: t.analysts,
      low: t.low,
      mean: t.mean,
      high: t.high,
    },
    {
      buy: 16,
      hold: 9,
      sell: 4,
      analysts: 29,
      low: 245,
      mean: 338.31,
      high: 400,
    },
  );
  assert.equal(t.consensus, "Buy");
  assert.equal(t.history.length, 13);
  assert.deepEqual(t.history.at(-1), {
    date: "10/01/2026",
    buy: 15,
    hold: 9,
    sell: 4,
    consensus: "Buy",
    meanTarget: 338.31,
  });
  // The ratings endpoint names the same 29 analysts' firms.
  assert.equal(
    fj("nasdaq-ratings-aapl.json").data.brokerNames.length,
    t.analysts,
  );
});
