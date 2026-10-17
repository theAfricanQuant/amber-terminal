// Workspace pieces, offline: the security lookup's Bloomberg-style labels (real /api/search answers saved on
// 15 Oct 2026 in test/fixtures/workspace), yield tickers, CSV export, source links, the watchlist and alerts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  toSecurity,
  bbgCode,
  yahooSymbol,
  searchLabel,
  lookupList,
  cleanName,
  YIELDS,
} from "../public/js/securities.js";
import { parse, securityQuery } from "../public/js/commands.js";
import { buildCsv, csvCell, csvName, linkSources } from "../public/js/ui.js";
import {
  editWatch,
  watchRows,
  alertArgs,
  alertRule,
  alertStatus,
  alertText,
  DEFAULT_WATCH,
} from "../public/js/fn/workspace.js";

const fixture = (q) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/workspace/search-${q}.json`, import.meta.url),
      "utf8",
    ),
  );
const codes = (list) => list.map((r) => r.code);

test("lookup: typing apple offers AAPL US EQUITY first, named the way the terminal names it", () => {
  const list = lookupList(fixture("apple"), "apple");
  assert.deepEqual(list[0], { code: "AAPL US EQUITY", name: "Apple Inc." });
  assert.ok(list.length <= 8);
  assert.ok(
    !codes(list).some((c) => /=F|AAPL19/.test(c)),
    "stock futures and unmapped exchanges are left out",
  );
});

test("lookup: Yahoo's London listing becomes VOD LN EQUITY, structured notes are dropped", () => {
  const list = lookupList(fixture("vod"), "vod");
  assert.ok(codes(list).includes("VOD LN EQUITY"));
  assert.ok(codes(list).includes("VOD US EQUITY"));
  assert.equal(
    list.find((r) => r.code === "VOD LN EQUITY").name,
    "Vodafone Group PLC",
  );
  assert.ok(
    !codes(list).some((c) => /XX US/.test(c)),
    "mutual funds and CDs are not securities to open",
  );
});

test("lookup: BTC is one crypto row, not a row per exchange or quote currency", () => {
  const list = lookupList(fixture("btc"), "btc");
  assert.deepEqual(list[0], { code: "BTC CRYPTO", name: "Bitcoin" });
  assert.equal(codes(list).filter((c) => c === "BTC CRYPTO").length, 1);
  assert.ok(!codes(list).some((c) => /^BTC(EUR|TRY|U)\b/.test(c)));
});

test("lookup: gold finds the stock, the future and spot gold", () => {
  const list = codes(lookupList(fixture("gold"), "gold"));
  assert.equal(list[0], "GOLD US EQUITY");
  assert.ok(list.includes("GC1 COMDTY"));
  assert.ok(list.includes("XAUUSD CURNCY"));
});

test("lookup: the terminal's own names work with no network answer", () => {
  assert.deepEqual(codes(lookupList([], "spx")), ["SPX INDEX"]);
  assert.ok(codes(lookupList([], "nikkei")).includes("NKY INDEX"));
  assert.ok(codes(lookupList([], "10-year")).includes("USGG10YR INDEX"));
  assert.equal(lookupList([], "bitcoin")[0].code, "BTC CRYPTO");
});

test("searchLabel: each source's symbols map to Bloomberg-style codes", () => {
  const L = (symbol, type = "", name = "") =>
    searchLabel({ symbol, type, name })?.code ?? null;
  assert.equal(L("US:NVDA", "stocks"), "NVDA US EQUITY");
  assert.equal(L("US:SPY", "etf"), "SPY US EQUITY");
  assert.equal(L("US:GOLDX", "mutualfunds"), null);
  assert.equal(L("BINANCE:ETHUSDT", "crypto"), "ETH CRYPTO");
  assert.equal(L("BINANCE:EURUSDT", "crypto"), null);
  assert.equal(L("COINBASE:BTC-USD", "crypto"), null);
  assert.equal(L("FX:EURUSD", "forex"), "EURUSD CURNCY");
  assert.equal(L("YAHOO:EURUSD=X", "currency"), "EURUSD CURNCY");
  assert.equal(L("YAHOO:JPY=X", "currency"), "USDJPY CURNCY");
  assert.equal(L("YAHOO:^GSPC", "index"), "SPX INDEX");
  assert.equal(L("YAHOO:^TNX", "index"), "USGG10YR INDEX");
  assert.equal(L("YAHOO:CL=F", "future"), "CL1 COMDTY");
  assert.equal(L("YAHOO:MGC=F", "future"), null);
  assert.equal(L("YAHOO:SAP.DE", "equity"), "SAP GR EQUITY");
  assert.equal(L("YAHOO:7203.T", "equity"), "7203 JP EQUITY");
  assert.equal(L("YAHOO:RELIANCE.NS", "equity"), "RELIANCE IN EQUITY");
  assert.equal(L("YAHOO:VOD.JO", "equity"), null);
});

test("cleanName: share-class boilerplate goes, shouting gets tidied", () => {
  assert.equal(cleanName("Apple Inc. Common Stock"), "Apple Inc.");
  assert.equal(
    cleanName("Alphabet Inc. Class A Common Stock"),
    "Alphabet Inc. Class A",
  );
  assert.equal(
    cleanName("Vodafone Group Plc American Depositary Shares"),
    "Vodafone Group Plc",
  );
  assert.equal(
    cleanName("VODAFONE GROUP PLC ORD USD0.20 "),
    "Vodafone Group PLC",
  );
});

test("securityQuery: looks up names, leaves functions, yellow keys and options alone", () => {
  assert.deepEqual(securityQuery("apple"), { query: "APPLE", start: 0 });
  assert.deepEqual(securityQuery("OMON app"), { query: "APP", start: 1 });
  assert.deepEqual(securityQuery("bank of am"), {
    query: "BANK OF AM",
    start: 0,
  });
  for (const t of [
    "a",
    "GP",
    "DES",
    "AAPL ",
    "AAPL US EQUITY DE",
    "GP 1Y",
    "VOD LN",
    "",
  ])
    assert.equal(securityQuery(t), null, t);
});

test("yields: USGG tickers chart Yahoo's Treasury yield indices", () => {
  const want = {
    USGG3M: "^IRX",
    USGG5YR: "^FVX",
    USGG10YR: "^TNX",
    USGG30YR: "^TYX",
  };
  for (const [t, id] of Object.entries(want)) {
    const s = toSecurity([t, "INDEX"]);
    assert.equal(s.id, id);
    assert.equal(s.sector, "INDEX");
    assert.match(s.name, /Treasury/);
    assert.equal(toSecurity([t]).id, id, `${t} works without the yellow key`);
  }
  assert.equal(Object.keys(YIELDS).length, 4);
  const p = parse("USGG10YR INDEX GP");
  assert.equal(p.fn, "GP");
  assert.equal(p.sec.id, "^TNX");
  assert.equal(toSecurity(["CT10", "GOVT"]).id, "^TNX");
});

test("parser: watchlist edits, options after a function, and a ticker that is also a function code", () => {
  assert.deepEqual(parse("W ADD VOD LN"), {
    fn: "W",
    sec: null,
    args: ["ADD", "VOD", "LN"],
  });
  assert.deepEqual(parse("W DEL NVDA"), {
    fn: "W",
    sec: null,
    args: ["DEL", "NVDA"],
  });
  const hp = parse("AAPL US EQUITY HP W");
  assert.equal(hp.fn, "HP");
  assert.equal(hp.sec.raw, "AAPL US EQUITY");
  assert.deepEqual(hp.args, ["W"]);
  const way = parse("W US EQUITY DES");
  assert.equal(way.fn, "DES");
  assert.equal(way.sec.ticker, "W");
  assert.deepEqual(parse("ALRT BTC ABOVE 1").args, ["BTC", "ABOVE", "1"]);
});

test("bbgCode and yahooSymbol: one canonical label and the board's symbol for each kind", () => {
  const cases = [
    [["AAPL"], "AAPL US EQUITY", "AAPL"],
    [["VOD", "LN"], "VOD LN EQUITY", "VOD.L"],
    [["SPX"], "SPX INDEX", "^GSPC"],
    [["BTC"], "BTC CRYPTO", "BTC-USD"],
    [["GC1", "COMDTY"], "GC1 COMDTY", "GC=F"],
    [["EURUSD", "CURNCY"], "EURUSD CURNCY", "EURUSD=X"],
    [["USGG10YR", "INDEX"], "USGG10YR INDEX", "^TNX"],
  ];
  for (const [w, code, y] of cases) {
    const s = toSecurity(w);
    assert.equal(bbgCode(s), code);
    assert.equal(yahooSymbol(s), y);
  }
  for (const c of DEFAULT_WATCH)
    assert.equal(
      bbgCode(toSecurity(c.split(" "))),
      c,
      "defaults are already canonical",
    );
});

test("CSV: cells Excel reads as numbers, titles between tables, a dated file name", () => {
  assert.equal(csvCell("6,712.34"), "6712.34");
  assert.equal(csvCell("+1,234.5%"), "+1234.5%");
  assert.equal(csvCell("—"), "");
  assert.equal(csvCell('Apple, "Inc"'), '"Apple, ""Inc"""');
  assert.equal(csvCell("2.3T"), "2.3T");
  const csv = buildCsv(
    [
      {
        title: "Americas",
        rows: [
          ["Ticker", "Value"],
          ["SPX", "6,712.34"],
        ],
      },
      { title: null, rows: [] },
      {
        title: "Europe",
        rows: [
          ["Ticker", "Value"],
          ["UKX", "9,100.10"],
        ],
      },
    ],
    { heading: "WEI World equity indices", footer: "Source: Yahoo Finance" },
  );
  assert.equal(
    csv,
    "WEI World equity indices\r\n\r\nAmericas\r\nTicker,Value\r\nSPX,6712.34\r\n\r\nEurope\r\nTicker,Value\r\nUKX,9100.10\r\n\r\nSource: Yahoo Finance\r\n",
  );
  const d = new Date(2026, 9, 15);
  assert.equal(
    csvName("DES", "AAPL US EQUITY", d),
    "DES-AAPL_US_EQUITY-2026-10-15.csv",
  );
  assert.equal(csvName("WEI", "", d), "WEI-2026-10-15.csv");
});

test("source links: known names become links to the public source, the rest stays text", () => {
  const h = linkSources(
    "New York Fed reference rates; US Treasury bill and note yields",
  );
  assert.match(
    h,
    /<a href="https:\/\/www\.newyorkfed\.org\/markets\/reference-rates" target="_blank" rel="noopener noreferrer">New York Fed<\/a>/,
  );
  assert.match(
    h,
    /<a href="https:\/\/home\.treasury\.gov\/[^"]+"[^>]*>US Treasury<\/a> bill/,
  );
  assert.match(
    linkSources("SEC EDGAR, the official US filing system"),
    /edgar\/search\/[^>]*>SEC EDGAR<\/a>/,
  );
  assert.match(
    linkSources("Yahoo Finance FX"),
    /finance\.yahoo\.com\/[^>]*>Yahoo Finance<\/a>/,
  );
  assert.match(
    linkSources("CFTC Commitments of Traders"),
    /publicreporting\.cftc\.gov/,
  );
  assert.match(
    linkSources("CBOE delayed option quotes"),
    /cboe\.com\/delayed_quotes/,
  );
  assert.match(linkSources("FRED, St. Louis Fed"), /fred\.stlouisfed\.org/);
  assert.equal(
    linkSources("second sector <b>"),
    "second sector &lt;b&gt;",
    "no link inside other words, text escaped",
  );
});

test("watchlist: add, no duplicates, delete by ticker, mistakes leave the list alone", () => {
  let list = ["SPX INDEX", "AAPL US EQUITY"];
  let r = editWatch(list, "ADD", ["NVDA"]);
  assert.deepEqual(r.list, ["SPX INDEX", "AAPL US EQUITY", "NVDA US EQUITY"]);
  list = r.list;
  r = editWatch(list, "ADD", ["VOD", "LN"]);
  assert.equal(r.code, "VOD LN EQUITY");
  list = r.list;
  r = editWatch(list, "add", ["aapl", "us", "equity"]);
  assert.equal(r.list, list, "already there");
  r = editWatch(list, "DEL", ["NVDA"]);
  assert.ok(!r.list.includes("NVDA US EQUITY"));
  r = editWatch(list, "DEL", ["VOD"]);
  assert.ok(!r.list.includes("VOD LN EQUITY"), "W DEL VOD finds VOD LN EQUITY");
  assert.ok(editWatch(list, "DEL", ["TSLA"]).error);
  assert.ok(editWatch(list, "ADD", []).error);
  assert.ok(editWatch(list, "SWAP", ["X"]).error);
  assert.equal(editWatch(list, "SWAP", ["X"]).list, list);
});

test("watchlist rows: Yahoo's board fills the row, crypto takes the live exchange price", () => {
  const board = {
    "^GSPC": {
      price: 6700,
      change: 10,
      changePct: 0.15,
      ytdPct: 12,
      low52: 5000,
      high52: 6800,
      spark: [1, 2],
    },
    "BTC-USD": {
      price: 80000,
      change: 0,
      changePct: 0,
      ytdPct: 20,
      low52: 60000,
      high52: 81000,
      spark: [1, 3],
    },
  };
  const quotes = { "BINANCE:BTCUSDT": { price: 82000, changePct: 2.5 } };
  const [spx, btc, missing] = watchRows(
    ["SPX INDEX", "BTC CRYPTO", "ZZZZ US EQUITY"],
    board,
    quotes,
    { "BTC CRYPTO": "Bitcoin" },
  );
  assert.equal(spx.price, 6700);
  assert.equal(spx.name, "S&P 500");
  assert.equal(btc.price, 82000);
  assert.equal(btc.changePct, 2.5);
  assert.ok(Math.abs(btc.change - (82000 - 82000 / 1.025)) < 1e-6);
  assert.equal(
    btc.high52,
    82000,
    "a live price past the 52-week high moves it",
  );
  assert.equal(btc.ytdPct, 20);
  assert.equal(missing.price, undefined);
  assert.equal(missing.sector, "EQUITY");
});

test("alerts: command words and form values become the engine's rule", () => {
  assert.deepEqual(alertArgs(["BTC", "ABOVE", "70000"]), {
    words: ["BTC"],
    dir: "above",
    level: "70000",
  });
  assert.deepEqual(alertArgs(["AAPL", "US", "EQUITY", "BELOW", "200"]), {
    words: ["AAPL", "US", "EQUITY"],
    dir: "below",
    level: "200",
  });
  assert.equal(alertArgs(["ABOVE", "1"]), null);
  const { rule, code } = alertRule(["BTC"], "above", "1");
  assert.equal(code, "BTC CRYPTO");
  assert.deepEqual(rule, {
    symbol: "BTCUSDT",
    tf: "1m",
    left: "close",
    op: ">=",
    right: 1,
    trigger: "once",
    message: "BTC CRYPTO above 1",
  });
  assert.equal(alertRule(["VOD", "LN"], "below", "1,200").rule.symbol, "VOD.L");
  assert.equal(alertRule(["VOD", "LN"], "below", "1,200").rule.right, 1200);
  assert.equal(alertRule(["SPX"], "below", "6000").rule.op, "<=");
  assert.ok(alertRule([], "above", "1").error);
  assert.ok(alertRule(["BTC"], "sideways", "1").error);
  assert.ok(alertRule(["BTC"], "above", "").error);
  assert.ok(alertRule(["BTC"], "above", "lots").error);
  assert.equal(alertStatus({ active: true }), "Watching");
  assert.match(
    alertStatus({
      active: false,
      fired: 1,
      lastFiredAt: "2026-10-15T12:00:00Z",
    }),
    /^Fired /,
  );
  assert.equal(
    alertText({ symbol: "BINANCE:BTCUSDT", op: "crossesAbove", right: 100000 }),
    "BINANCE:BTCUSDT crosses above 100000",
  );
});
