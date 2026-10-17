// TOP, CF, INSD and HDS: parsing and mapping checked against real responses saved in
// fixtures/newsfilings/, plus each server function run end to end on a fake network (no live calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.QT_TIMEOUT_MS = "500";
const fx = (name) =>
  readFileSync(
    new URL(`./fixtures/newsfilings/${name}`, import.meta.url),
    "utf8",
  );
const fj = (name) => JSON.parse(fx(name));

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

const top = await import("../lib/fn/top.js");
const cf = await import("../lib/fn/cf.js");
const insd = await import("../lib/fn/insd.js");
const hds = await import("../lib/fn/hds.js");

// ---------- TOP ----------
test("TOP reads the CNBC feed into title, link, source and time", () => {
  const items = top.parseFeed(fx("rss-cnbc.xml"), "CNBC");
  assert.equal(items.length, 4);
  for (const i of items) {
    assert.ok(i.title.length > 10);
    assert.match(i.url, /^https:\/\/www\.cnbc\.com\//);
    assert.equal(i.source, "CNBC");
    assert.ok(Number.isFinite(i.time));
  }
});

test("TOP turns numeric entities like &#x2019; into real characters", () => {
  const items = top.parseFeed(fx("rss-marketwatch.xml"), "MarketWatch");
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => !/&#|&[a-z]+;/.test(i.title)));
  assert.match(items[0].title, /^There’s a ‘monstrous bull market’/);
  assert.equal(
    top.unescapeEntities("a &#39;b&#39; &amp;#x41; &#x1F600; &bogus;"),
    "a 'b' &#x41; \u{1F600} &bogus;",
  );
});

test("TOP keeps only web links", () => {
  const xml = `<rss><channel><item><title>Bad</title><link>javascript:alert(1)</link></item><item><title>Good</title><link>https://example.com/a</link></item></channel></rss>`;
  assert.deepEqual(
    top.parseFeed(xml, "X").map((i) => i.title),
    ["Good"],
  );
});

test("TOP merges feeds newest first and drops repeated headlines", () => {
  const a = top.parseFeed(fx("rss-cnbc.xml"), "CNBC");
  const copy = {
    ...a[0],
    source: "WSJ",
    title: a[0].title.toUpperCase() + "!",
    time: Math.max(...a.map((i) => i.time)) + 60e3,
  };
  const merged = top.mergeNews([a, [copy]]);
  assert.equal(merged.length, 4, "the repeat is gone");
  assert.equal(merged[0].source, "WSJ", "the newest copy stays");
  for (let i = 1; i < merged.length; i++)
    assert.ok(merged[i - 1].time >= merged[i].time);
  assert.equal(top.mergeNews([a], 2).length, 2);
});

test("TOP moves the publisher out of Google News titles", () => {
  const items = top.parseGoogleNews(fx("rss-google.xml"));
  assert.equal(items.length, 3);
  assert.equal(items[0].source, "Yahoo");
  assert.ok(!items[0].title.endsWith("Yahoo"));
});

test("TOP merges every feed that answers, even when one is down", async () => {
  serve(
    [/search\.cnbc\.com/, 200, fx("rss-cnbc.xml")],
    [/dowjones\.io.*mw_topstories/, 200, fx("rss-marketwatch.xml")],
    [/./, 503, "down"],
  );
  const d = await top.loadNews("ALL");
  assert.equal(d.group, "ALL");
  assert.equal(d.items.length, 7);
  assert.deepEqual(d.feeds, ["CNBC", "MarketWatch"]);
  assert.match(d.source, /no answer from WSJ, FT, Bloomberg, Nasdaq/);
});

test("TOP falls back to Google News when the main feeds give almost nothing", async () => {
  serve([/news\.google\.com/, 200, fx("rss-google.xml")], [/./, 503, "down"]);
  const d = await top.loadNews("ALL");
  assert.deepEqual(d.feeds, ["Google News"]);
  assert.equal(d.items.length, 3);
});

test("TOP says what happened when every feed is down, and rejects unknown groups", async () => {
  serve([/./, 503, "down"]);
  await assert.rejects(
    top.loadNews("TECH"),
    (e) => e.status === 502 && /try again/i.test(e.message),
  );
  await assert.rejects(
    top.default({ group: "NOPE" }),
    (e) => e.status === 400 && /ALL, TECH, CRYPTO, ECON/.test(e.message),
  );
});

// ---------- CF ----------
test("CF finds a CIK from a ticker, including share classes", () => {
  const idx = cf.tickerIndex(fj("sec-tickers.json"));
  assert.equal(cf.lookupCik(idx, "aapl").cik, 320193);
  assert.equal(cf.lookupCik(idx, "BRK.B").cik, 1067983);
  assert.equal(cf.lookupCik(idx, "BRK-B").name, "BERKSHIRE HATHAWAY INC");
  assert.equal(cf.lookupCik(idx, "NOPE"), null);
});

test("CF builds document links and plain descriptions from the submissions API", () => {
  const rows = cf.filingRows(fj("sec-submissions-aapl.json"));
  const by = (form) => rows.find((r) => r.form === form);
  assert.equal(by("10-K").description, "Annual report");
  assert.equal(by("10-K").filed, "2025-10-31");
  assert.equal(by("10-K").period, "2025-09-27");
  assert.equal(
    by("10-K").url,
    "https://www.sec.gov/Archives/edgar/data/320193/000032019325000079/aapl-20250927.htm",
  );
  assert.equal(by("8-K").description, "Event report: results (earnings)");
  assert.equal(
    by("8-K/A").description,
    "Event report: executive or director change (amended)",
  );
  assert.equal(
    by("DEF 14A").description,
    "Proxy statement for the shareholder vote",
  );
  assert.equal(by("4").rawDoc, "form4.xml");
});

test("CF filters by form: 10-K and 8-K take amendments, 4 takes only Form 4", () => {
  const rows = cf.filingRows(fj("sec-submissions-aapl.json"));
  const forms = (w) => cf.filterForm(rows, w).map((r) => r.form);
  assert.deepEqual(forms("8-K"), ["8-K/A", "8-K"]);
  assert.deepEqual(forms("10-K"), ["10-K"]);
  assert.ok(forms("4").every((f) => f === "4" || f === "4/A"));
  assert.ok(!forms("4").includes("144"));
  assert.equal(forms("ALL").length, rows.length);
  assert.equal(cf.normForm("10k"), "10-K");
  assert.equal(cf.normForm(" 8 k "), "8-K");
  assert.equal(cf.normForm("form 4"), "4");
  assert.equal(cf.normForm("def 14a"), "DEF 14A");
  assert.equal(cf.normForm(""), "ALL");
});

test("CF reads Nasdaq's filings list for the fallback", () => {
  const rows = cf.parseNasdaqFilings(fj("nasdaq-filings-aapl.json"));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].form, "4");
  assert.equal(rows[0].filed, "2026-10-08");
  assert.equal(rows[0].period, "2026-10-06");
  assert.equal(rows[0].description, "Insider trade report");
  assert.match(rows[0].url, /^https:\/\/app\.quotemedia\.com\//);
});

test("CF serves SEC filings for a US ticker", async () => {
  serve(
    [/company_tickers\.json/, 200, fj("sec-tickers.json")],
    [/submissions\/CIK0000320193\.json/, 200, fj("sec-submissions-aapl.json")],
  );
  const d = await cf.default({ symbol: "US:AAPL", form: "10-K" });
  assert.equal(d.name, "Apple Inc.");
  assert.equal(d.cik, "0000320193");
  assert.equal(d.form, "10-K");
  assert.equal(d.filings.length, 1);
  assert.equal(d.filings[0].form, "10-K");
  assert.match(d.source, /SEC EDGAR/);
  const sent = calls.find((u) => /submissions/.test(u));
  assert.ok(sent);
});

test("CF refuses non-US securities in plain words", async () => {
  await assert.rejects(
    cf.default({ symbol: "BINANCE:BTCUSDT" }),
    (e) => e.status === 422 && /US-listed/.test(e.message),
  );
});

test("CF falls back to Nasdaq when the SEC does not answer", async () => {
  serve(
    [/sec\.gov/, 503, "busy"],
    [/api\.nasdaq\.com.*sec-filings/, 200, fj("nasdaq-filings-aapl.json")],
  );
  const d = await cf.default({ symbol: "US:MSFT" });
  assert.equal(d.filings.length, 3);
  assert.match(d.source, /Nasdaq/);
});

test("CF explains an unknown ticker and an unreachable SEC", async () => {
  serve(
    [/company_tickers\.json/, 200, fj("sec-tickers.json")],
    [/./, 503, "no"],
  );
  await assert.rejects(
    cf.default({ symbol: "US:ZZZZQ" }),
    (e) => e.status === 404 && /try a company ticker/.test(e.message),
  );
  serve([/./, 503, "no"]);
  await assert.rejects(
    cf.default({ symbol: "US:INTC" }),
    (e) => e.status === 502 && /Try again/.test(e.message),
  );
});

// ---------- INSD ----------
test("INSD reads a planned sale on a Form 4", () => {
  const f = insd.parseForm4(fx("sec-form4-aapl.xml"));
  assert.equal(f.issuerCik, 320193);
  assert.equal(f.name, "Newstead Jennifer");
  assert.equal(f.role, "SVP, GC and Government Affairs");
  assert.equal(f.trades.length, 1);
  assert.deepEqual(f.trades[0], {
    date: "2026-10-06",
    code: "S",
    shares: 2399,
    price: 332.01,
    acquired: "D",
    held: 39593,
    owned: "Direct",
    plan: true,
  });
});

test("INSD reads a gift held through a trust, with no price", () => {
  const f = insd.parseForm4(fx("sec-form4-nvda.xml"));
  assert.equal(
    f.name,
    "Coxe Tench",
    "all-capitals names are put in normal case",
  );
  assert.equal(f.role, "Director");
  assert.equal(f.trades.length, 1, "holdings lines are not trades");
  const t = f.trades[0];
  assert.equal(t.code, "G");
  assert.equal(t.shares, 500000);
  assert.equal(t.price, 0);
  assert.equal(t.owned, "Indirect");
  assert.equal(t.plan, true, "the footnote names a Rule 10b5-1 plan");
});

test("INSD reads an open-market buy", () => {
  const f = insd.parseForm4(fx("sec-form4-intc-buy.xml"));
  assert.equal(f.name, "Tan Lip Bu");
  assert.equal(f.role, "CEO, Director");
  const t = f.trades[0];
  assert.deepEqual(
    [t.code, t.shares, t.price, t.date, t.acquired, t.plan, t.owned],
    ["P", 105263, 95, "2026-08-11", "A", false, "Indirect"],
  );
  const row = insd.toRow({ ...t, value: t.shares * t.price }, f, {
    filed: "2026-08-12",
    url: "https://www.sec.gov/x",
  });
  assert.equal(row.type, "Buy");
  assert.equal(row.side, "buy");
  assert.equal(row.value, 105263 * 95);
});

test("INSD joins lots sold the same day into one row at their average price", () => {
  const f = insd.parseForm4(fx("sec-form4-pypl-lots.xml"));
  assert.equal(f.trades.length, 3);
  const merged = insd.mergeTrades(
    f.trades.map((t) => ({ ...t, accession: "a" })),
  );
  assert.equal(merged.length, 1);
  const m = merged[0];
  const shares = f.trades.reduce((a, t) => a + t.shares, 0);
  const value = f.trades.reduce((a, t) => a + t.shares * t.price, 0);
  assert.equal(m.shares, shares);
  assert.ok(Math.abs(m.value - value) < 1e-6);
  assert.ok(Math.abs(m.price - value / shares) < 1e-9);
  assert.equal(m.held, f.trades.at(-1).held, "shares owned after the last lot");
  assert.equal(m.plan, true);
  // a gift has no price: the row shows none rather than a zero
  const gift = insd.mergeTrades([
    { ...insd.parseForm4(fx("sec-form4-nvda.xml")).trades[0], accession: "b" },
  ])[0];
  assert.equal(gift.price, null);
  assert.equal(gift.value, null);
});

test("INSD names each transaction code in plain words and colours only market trades", () => {
  assert.deepEqual(insd.typeOf("P"), ["Buy", "buy"]);
  assert.deepEqual(insd.typeOf("S"), ["Sell", "sell"]);
  assert.deepEqual(insd.typeOf("F"), ["Tax withheld", null]);
  assert.deepEqual(insd.typeOf("M"), ["Option exercise", null]);
  assert.deepEqual(insd.typeOf("Q"), ["Code Q", null]);
});

test("INSD reads Nasdaq's insider list for the fallback", () => {
  const rows = insd.parseNasdaqInsiders(fj("nasdaq-insider-aapl.json"));
  assert.equal(rows.length, 8);
  assert.deepEqual(
    [
      rows[0].name,
      rows[0].role,
      rows[0].date,
      rows[0].type,
      rows[0].side,
      rows[0].shares,
      rows[0].price,
      rows[0].held,
      rows[0].plan,
    ],
    [
      "Newstead Jennifer",
      "Officer",
      "2026-10-06",
      "Sell",
      "sell",
      2399,
      332.01,
      39593,
      true,
    ],
  );
  assert.equal(rows[0].value, 2399 * 332.01);
  const nonMarket = rows.find((r) => /not a market trade/.test(r.type));
  assert.equal(nonMarket.side, null);
  const exercise = rows.find((r) => r.type === "Option exercise");
  assert.equal(exercise.price, null);
});

const secRoutes = (extra = []) => [
  [/company_tickers\.json/, 200, fj("sec-tickers.json")],
  [/submissions\/CIK0000320193\.json/, 200, fj("sec-submissions-aapl.json")],
  [
    /Archives\/edgar\/data\/320193\/[0-9]+\/form4\.xml/,
    200,
    fx("sec-form4-aapl.xml"),
  ],
  ...extra,
];

test("INSD lists the latest insider trades from the SEC's Form 4 files", async () => {
  serve(...secRoutes());
  const d = await insd.default({ symbol: "US:AAPL" });
  assert.equal(d.name, "Apple Inc.");
  assert.ok(d.rows.length >= 1);
  const sale = d.rows.find((r) => r.name === "Newstead Jennifer");
  assert.equal(sale.type, "Sell");
  assert.equal(sale.side, "sell");
  assert.equal(sale.shares, 2399);
  assert.equal(sale.price, 332.01);
  assert.ok(Math.abs(sale.value - 2399 * 332.01) < 1e-6);
  assert.match(
    sale.url,
    /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/320193\/0001140361/,
  );
  // the SEC was asked for the raw XML, not the styled page
  assert.ok(calls.some((u) => /\/form4\.xml$/.test(u) && !/xslF345/.test(u)));
  for (let i = 1; i < d.rows.length; i++)
    assert.ok(d.rows[i - 1].date >= d.rows[i].date);
});

test("INSD skips Form 4s where the company is the investor, not the issuer", async () => {
  // Alphabet's list pointing at Apple's Form 4s: none are about Alphabet's own shares
  serve(
    [/company_tickers\.json/, 200, fj("sec-tickers.json")],
    [/submissions\/CIK0001652044\.json/, 200, fj("sec-submissions-aapl.json")],
    ...secRoutes(),
  );
  const d = await insd.default({ symbol: "US:GOOGL" });
  assert.deepEqual(d.rows, []);
  assert.match(d.source, /none filed recently/);
});

test("INSD falls back to Nasdaq when no Form 4 can be read", async () => {
  // new accession numbers, so nothing is cached from the test above
  const sub = fj("sec-submissions-aapl.json");
  sub.filings.recent.accessionNumber = sub.filings.recent.accessionNumber.map((a) => `9${a.slice(1)}`);
  serve(
    [/company_tickers\.json/, 200, fj("sec-tickers.json")],
    [/submissions\/CIK0001045810\.json/, 200, sub],
    [/Archives\/edgar/, 503, "busy"],
    [/api\.nasdaq\.com.*insider-trades/, 200, fj("nasdaq-insider-aapl.json")],
  );
  const d = await insd.default({ symbol: "US:NVDA" });
  assert.equal(d.rows.length, 8);
  assert.match(d.source, /Nasdaq/);
});

test("INSD refuses non-US securities and explains an unknown ticker", async () => {
  await assert.rejects(
    insd.default({ symbol: "YAHOO:VOD.L" }),
    (e) => e.status === 422,
  );
  serve(
    [/company_tickers\.json/, 200, fj("sec-tickers.json")],
    [/./, 503, "no"],
  );
  await assert.rejects(
    insd.default({ symbol: "US:ZZZZQ" }),
    (e) => e.status === 404 && /No insider filings/.test(e.message),
  );
});

// ---------- HDS ----------
test("HDS reads Nasdaq's holders with each holder's share of the company", () => {
  const d = hds.parseNasdaqHolders(fj("nasdaq-holdings-aapl.json"));
  assert.deepEqual(d.summary, {
    ownedPct: 76.56,
    holders: 6428,
    shares: 11172625577,
    increased: 2847,
    decreased: 3165,
    newPositions: 189,
    soldOut: 95,
  });
  assert.equal(d.rows.length, 5);
  const v = d.rows[0];
  assert.equal(v.name, "Vanguard Group Inc");
  assert.equal(v.shares, 1426283914);
  assert.equal(v.change, 26856752);
  assert.equal(v.changePct, 1.919);
  assert.equal(v.date, "2025-12-31");
  assert.equal(v.value, 489158331 * 1000, "Nasdaq quotes thousands of dollars");
  assert.ok(Math.abs(v.pctOfCompany - (1426283914 / 14594e6) * 100) < 1e-9);
  assert.equal(hds.parseNasdaqHolders({ data: null }), null);
});

test("HDS reads Yahoo's owners for the fallback", () => {
  const d = hds.parseYahooHolders(fj("yahoo-holdings-aapl.json"));
  assert.equal(d.rows.length, 3);
  const b = d.rows[0];
  assert.equal(b.name, "Blackrock Inc.");
  assert.equal(b.shares, 1162996939);
  assert.ok(Math.abs(b.pctOfCompany - 7.97) < 1e-9);
  assert.ok(Math.abs(b.changePct - 1.6) < 1e-9);
  assert.ok(Math.abs(b.change - (1162996939 - 1162996939 / 1.016)) < 1);
  assert.equal(b.date, "2026-06-30");
  assert.ok(Math.abs(d.summary.ownedPct - 66.326) < 1e-9);
  assert.equal(d.summary.holders, 7697);
  assert.equal(hds.parseYahooHolders({ quoteSummary: { result: null } }), null);
});

test("HDS turns Set-Cookie headers into one Cookie header", () => {
  assert.equal(
    hds.cookieHeader([
      "A3=abc; Expires=Fri, 15 Oct 2027 00:00:00 GMT; Path=/",
      "B=x; Path=/",
    ]),
    "A3=abc; B=x",
  );
  assert.equal(hds.cookieHeader(null), "");
});

test("HDS serves Nasdaq's holders for a US ticker and keeps them for a while", async () => {
  serve([
    /api\.nasdaq\.com.*institutional-holdings/,
    200,
    fj("nasdaq-holdings-aapl.json"),
  ]);
  const d = await hds.default({ symbol: "US:AAPL" });
  assert.equal(d.rows.length, 5);
  assert.match(d.source, /13F/);
  const again = await hds.default({ symbol: "US:AAPL" });
  assert.equal(again.rows.length, 5);
  assert.equal(calls.length, 1, "the second lookup came from the cache");
});

test("HDS falls back to Yahoo when Nasdaq does not answer", async () => {
  serve(
    [/api\.nasdaq\.com/, 503, "busy"],
    [/fc\.yahoo\.com/, 404, ""],
    [/getcrumb/, 200, "abc123"],
    [/quoteSummary\/MSFT.*crumb=abc123/, 200, fj("yahoo-holdings-aapl.json")],
  );
  const d = await hds.default({ symbol: "US:MSFT" });
  assert.equal(d.rows.length, 3);
  assert.match(d.source, /Yahoo/);
});

test("HDS refuses non-US securities and says when nothing can be loaded", async () => {
  await assert.rejects(
    hds.default({ symbol: "BINANCE:BTCUSDT" }),
    (e) => e.status === 422,
  );
  serve([/./, 503, "no"]);
  await assert.rejects(
    hds.default({ symbol: "US:XOM" }),
    (e) => e.status === 502 && /Try again/.test(e.message),
  );
});

// ---------- the screens ----------
test("the four screens are registered with a group and a render function", async () => {
  const screens = (await import("../public/js/fn/newsfilings.js")).default;
  const byId = Object.fromEntries(screens.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(byId).sort(), ["CF", "HDS", "INSD", "TOP"]);
  assert.equal(byId.TOP.group, "News");
  assert.ok(!byId.TOP.needs, "TOP is market-wide");
  for (const id of ["CF", "INSD", "HDS"]) assert.equal(byId[id].needs, true);
  for (const s of screens) {
    assert.equal(typeof s.render, "function");
    assert.ok(s.name && s.source);
  }
});
