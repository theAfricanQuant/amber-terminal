// DS (document search) and SURP (economic surprises): query building, quote handling, result parsing,
// surprise maths and the market-reaction join, checked against trimmed real responses in fixtures/docsearch/,
// plus both server functions run end to end on a fake network (no live calls).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.QT_TIMEOUT_MS = "500";
const dataDir = mkdtempSync(path.join(tmpdir(), "amber-ds-"));
process.env.QT_DATA_DIR = dataDir;
process.on("exit", () => rmSync(dataDir, { recursive: true, force: true }));

const fx = (name) =>
  readFileSync(
    new URL(`./fixtures/docsearch/${name}`, import.meta.url),
    "utf8",
  );
const fj = (name) => JSON.parse(fx(name));

// ---------- a fake network: url -> { status, body } ----------
let routes = [];
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, headers: opts.headers || {} });
  const hit = routes.find(([re]) => re.test(u));
  if (!hit)
    throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  const [, status, body] = hit;
  const b = typeof body === "function" ? body(u) : body;
  return new Response(typeof b === "string" ? b : JSON.stringify(b), {
    status,
  });
};
const serve = (...r) => {
  routes = r;
  calls.length = 0;
};

const ds = await import("../lib/fn/ds.js");
const surp = await import("../lib/fn/surp.js");
const { parseYahoo } = await import("../lib/providers.js");
const store = await import("../lib/store.js");
const surpEco = await import("../lib/fn/eco.js");
const { companyFor } = await import("../public/js/fn/docsearch.js");

// ---------- DS: quote handling ----------
test("DS joins a quoted phrase the command line split and uppercased, and lowercases it", () => {
  const args = ['"GOING', 'CONCERN"'];
  assert.deepEqual(ds.parseSearch(args.join(" ")), {
    query: '"going concern"',
    form: null,
    range: null,
  });
});

test("DS pulls the form and date words out of the search and keeps the rest", () => {
  assert.deepEqual(ds.parseSearch("BUYBACK 8-K"), {
    query: "buyback",
    form: "8-K",
    range: null,
  });
  assert.deepEqual(ds.parseSearch('"GOING CONCERN" 10K 5Y'), {
    query: '"going concern"',
    form: "10-K",
    range: "5Y",
  });
  assert.deepEqual(ds.parseSearch("TARIFF 10-Q 30D"), {
    query: "tariff",
    form: "10-Q",
    range: "30D",
  });
  // Inside quotes a form word is part of the phrase.
  assert.equal(
    ds.parseSearch('"FILED ON FORM 8-K"').query,
    '"filed on form 8-k"',
  );
});

test("DS reads curly quotes, an unclosed quote, and OR, AND, NOT only between two terms", () => {
  assert.equal(
    ds.parseSearch("“MATERIAL WEAKNESS” OR RESTATEMENT").query,
    '"material weakness" OR restatement',
  );
  assert.equal(ds.parseSearch('"GOING CONCERN').query, '"going concern"');
  assert.equal(
    ds.parseSearch("BUYBACK NOT REPURCHASE").query,
    "buyback NOT repurchase",
  );
  assert.equal(ds.parseSearch("NOT OR").query, "not or");
  assert.equal(ds.parseSearch("TARIFF -CHINA").query, "tariff -china");
  assert.equal(ds.parseSearch("").query, "");
});

// ---------- DS: query building ----------
test("DS builds EDGAR's search URL: custom dates, the form and the company's 10-digit CIK", () => {
  const u = new URL(
    ds.buildUrl({
      query: '"going concern"',
      form: "10-K",
      range: "1Y",
      today: "2026-10-15",
    }),
  );
  assert.equal(
    u.origin + u.pathname,
    "https://efts.sec.gov/LATEST/search-index",
  );
  assert.equal(u.searchParams.get("q"), '"going concern"');
  assert.equal(u.searchParams.get("dateRange"), "custom");
  assert.equal(u.searchParams.get("startdt"), "2025-10-15");
  assert.equal(u.searchParams.get("enddt"), "2026-10-15");
  assert.equal(u.searchParams.get("forms"), "10-K");
  assert.equal(u.searchParams.has("ciks"), false);
  assert.match(u.search, /q=%22going%20concern%22/); // spaces as %20, the way sec.gov sends them

  const a = new URL(
    ds.buildUrl({
      query: "tariff",
      form: "ALL",
      range: "30D",
      cik: 320193,
      today: "2026-10-15",
    }),
  );
  assert.equal(a.searchParams.get("ciks"), "0000320193");
  assert.equal(a.searchParams.has("forms"), false);
  assert.equal(a.searchParams.get("startdt"), "2026-09-15");
  assert.equal(ds.rangeDates("5Y", "2026-10-15").start, "2021-10-15");
});

// ---------- DS: result parsing ----------
test("DS reads company name, tickers and CIK from EDGAR's display names", () => {
  assert.deepEqual(
    ds.parseDisplayName("Apple Inc.  (AAPL)  (CIK 0000320193)"),
    { name: "Apple Inc.", tickers: ["AAPL"], cik: "320193" },
  );
  assert.deepEqual(
    ds.parseDisplayName(
      "PROSPECT CAPITAL CORP  (PSEC, PSEC-PA)  (CIK 0001287032)",
    ).tickers,
    ["PSEC", "PSEC-PA"],
  );
  assert.deepEqual(
    ds.parseDisplayName("Palisades Venture Inc.  (CIK 0002010982)"),
    { name: "Palisades Venture Inc.", tickers: [], cik: "2010982" },
  );
});

test("DS turns EDGAR hits into one row per filing, newest first, with a working document link", () => {
  const rows = ds.parseHits(fj("efts-going-concern-10k.json"));
  assert.equal(rows.length, 5);
  assert.deepEqual(
    rows.map((r) => r.filed),
    [...rows.map((r) => r.filed)].sort().reverse(),
  );
  const tglo = rows.find((r) => r.ticker === "TGLO");
  assert.equal(tglo.company, "THEGLOBE COM INC");
  assert.equal(tglo.form, "10-K");
  assert.equal(tglo.document, "Main document");
  assert.equal(
    tglo.url,
    "https://www.sec.gov/Archives/edgar/data/1066684/000110465926038019/tglo-20251231x10k.htm",
  );
  assert.equal(
    tglo.filingUrl,
    "https://www.sec.gov/Archives/edgar/data/1066684/000110465926038019/0001104659-26-038019-index.htm",
  );
  assert.equal(rows.find((r) => !r.ticker).ticker, null);
  assert.ok(rows.every((r) => r.snippet === null)); // EDGAR's search sends no matching text

  // Two documents of one filing make one row.
  const raw = fj("efts-buyback-8k.json");
  const bb = ds.parseHits(raw);
  assert.equal(
    bb.length,
    new Set(raw.hits.hits.map((h) => h._source.adsh)).size,
  );
  assert.ok(bb.length < raw.hits.hits.length);
  assert.ok(bb.some((r) => /^Exhibit 99\.1$/.test(r.document)));
});

test("DS names the searched company even when another filer is listed first", () => {
  const rows = ds.parseHits(fj("efts-aapl-tariff.json"), { cik: 320193 });
  assert.equal(rows.length, 6);
  assert.ok(
    rows.every((r) => r.company === "Apple Inc." && r.ticker === "AAPL"),
  );
  const letter = rows.find((r) => r.form === "PX14A6G");
  assert.equal(letter.others, 1);
  assert.equal(letter.title, "NATIONAL LEGAL AND POLICY CENTER - PX14A6G");
  assert.equal(rows.find((r) => r.form === "10-Q").title, null);
});

test("DS finds the matching sentences in a filing's HTML", () => {
  const text = ds.htmlToText(fx("sec-doc-going-concern.htm"));
  assert.ok(!/<|&nbsp;|&#/.test(text));
  const p = ds.passages(text, '"going concern"');
  assert.equal(p.matches, 7);
  assert.equal(p.passages.length, 3);
  assert.ok(p.passages.every((s) => /going concern/i.test(s)));
  assert.ok(
    p.passages.some(
      (s) =>
        s ===
        "RISK FACTORS Risks Relating to Our Business We may not be able to continue as a going concern.",
    ),
  );
  assert.deepEqual(
    ds.searchTerms('"going concern" OR bankruptcy NOT tariff -china'),
    ["going concern", "bankruptcy"],
  );
  assert.equal(
    ds.passages("Apple Inc. raised prices. Tariffs rose.", "tariff")
      .passages[0],
    "Tariffs rose.",
  );
});

test("DS end to end: market-wide and within one company, SEC user agent, cached", async () => {
  serve(
    [/efts\.sec\.gov.*ciks=0000320193/, 200, fj("efts-aapl-tariff.json")],
    [/efts\.sec\.gov/, 200, fj("efts-going-concern-10k.json")],
    [/sec\.gov\/files\/company_tickers\.json/, 200, fj("sec-tickers.json")],
  );
  const d = await ds.default({ q: '"GOING CONCERN" 10-K' });
  assert.equal(d.query, '"going concern"');
  assert.equal(d.form, "10-K");
  assert.equal(d.range, "1Y");
  assert.equal(d.total, 2743);
  assert.equal(d.rows.length, 5);
  assert.match(d.source, /SEC EDGAR full-text search/);
  assert.match(
    d.searchUrl,
    /^https:\/\/www\.sec\.gov\/edgar\/search\/#\/q=%22going%20concern%22/,
  );
  const efts = calls.find((c) => /efts/.test(c.url));
  assert.match(efts.headers["User-Agent"], /^AmberTerminal/);
  assert.match(efts.url, /forms=10-K/);

  const a = await ds.default({ q: "TARIFF", symbol: "AAPL" });
  assert.deepEqual(a.company, {
    ticker: "AAPL",
    cik: 320193,
    name: "Apple Inc.",
  });
  assert.equal(a.rows.length, 6);
  assert.ok(calls.some((c) => /ciks=0000320193/.test(c.url)));

  const n = calls.length;
  await ds.default({ q: "TARIFF", symbol: "AAPL" });
  assert.equal(
    calls.length,
    n,
    "a repeat search inside 10 minutes makes no request",
  );

  await assert.rejects(ds.default({ q: "" }), /Type what to search for/);
  await assert.rejects(
    ds.default({ q: "x", doc: "https://example.com/a.htm" }),
    /Only documents on sec.gov/,
  );
});

test("DS scopes to a company only when the command named it", () => {
  const panel = { sec: null };
  assert.equal(companyFor(panel, false), null);
  panel.sec = {
    raw: "AAPL US EQUITY",
    ticker: "AAPL",
    sector: "EQUITY",
    exch: "US",
    id: "AAPL",
  };
  assert.equal(companyFor(panel, false), null); // AAPL DES, then DS "going concern": every company
  assert.equal(companyFor(panel, true)?.ticker, "AAPL"); // AAPL US EQUITY DS tariff
  assert.equal(companyFor(panel, false), null); // then DS "going concern" in the same panel
  panel.sec = { raw: "SPX INDEX", ticker: "SPX", sector: "INDEX", id: "^GSPC" };
  assert.equal(companyFor(panel, true), null);
  panel.sec = {
    raw: "VOD LN EQUITY",
    ticker: "VOD",
    sector: "EQUITY",
    exch: "LN",
    id: "VOD.L",
  };
  assert.equal(companyFor(panel, true), null);
});

// ---------- SURP: surprise maths ----------
test("SURP reads Nasdaq's figures and works out the surprise in the release's units", () => {
  assert.deepEqual(surp.parseValue("1,710K"), { v: 1710, unit: "K", dp: 0 });
  assert.deepEqual(surp.parseValue("-11.120M"), {
    v: -11.12,
    unit: "M",
    dp: 3,
  });
  assert.deepEqual(surp.parseValue("3.7%"), { v: 3.7, unit: "%", dp: 1 });
  assert.equal(surp.parseValue(null), null);
  assert.equal(surp.parseValue("n/a"), null);
  assert.deepEqual(surp.surpriseOf("0.3%", "0.2%"), {
    value: 0.1,
    unit: "%",
    dp: 1,
  }); // not 0.09999
  assert.deepEqual(surp.surpriseOf("162K", "55K"), {
    value: 107,
    unit: "K",
    dp: 0,
  });
  assert.deepEqual(surp.surpriseOf("46.3", "47.5"), {
    value: -1.2,
    unit: "",
    dp: 1,
  });
  assert.deepEqual(surp.surpriseOf("1,700K", "1.75M"), {
    value: -50,
    unit: "K",
    dp: 0,
  });
  assert.equal(surp.surpriseOf("3.7%", null), null);
});

const nasdaqDay = (day) => {
  const { parseNasdaqDay } = surpEco;
  return parseNasdaqDay(fj(`nasdaq-eco-${day}.json`), day);
};

test("SURP picks the main releases from a day and tells the monthly figure from the yearly one", () => {
  const cpi = surp.classifyDay(nasdaqDay("2026-10-14"), "2026-10-14");
  const by = Object.fromEntries(cpi.map((r) => [r.id, r]));
  assert.deepEqual(Object.keys(by).sort(), [
    "CORE-CPI-MM",
    "CORE-CPI-YY",
    "CPI-MM",
    "CPI-YY",
  ]);
  assert.equal(by["CPI-YY"].actual, "3.7%");
  assert.equal(by["CPI-YY"].surprise, 0.1);
  assert.equal(by["CPI-MM"].actual, "0.6%");
  assert.equal(by["CPI-MM"].surprise, 0);
  assert.equal(by["CORE-CPI-MM"].name, "Core CPI m/m");
  assert.equal(by["CORE-CPI-YY"].consensus, "2.5%");

  const thu = surp.classifyDay(nasdaqDay("2026-10-15"), "2026-10-15");
  const ids = thu.map((r) => r.id);
  // Core PPI comes monthly first one month and yearly first the next: size, not order, decides.
  assert.equal(thu.find((r) => r.id === "CORE-PPI-MM").actual, "0.7%");
  assert.equal(thu.find((r) => r.id === "PPI-YY").actual, "6.3%");
  assert.ok(ids.includes("RETAIL-MM"));
  assert.ok(
    !ids.includes("RETAIL-YY"),
    "the yearly retail figure has no survey, so no surprise",
  );
  assert.ok(
    !thu.some((r) => /continuing/i.test(r.name)),
    "continuing claims aren't a main release",
  );
  assert.equal(thu.find((r) => r.id === "CLAIMS").surprise, 0);

  const jobs = surp.classifyDay(nasdaqDay("2026-10-02"), "2026-10-02");
  const nfp = jobs.find((r) => r.id === "NFP");
  assert.deepEqual(
    [nfp.actual, nfp.consensus, nfp.previous, nfp.surprise, nfp.unit],
    ["29K", "89K", "133K", -60, "K"],
  );
  assert.equal(jobs.find((r) => r.id === "UNEMP").surprise, 0.1);
  assert.ok(
    !jobs.some((r) => /Private|Government|Manufacturing payrolls/.test(r.name)),
  );
});

test("SURP gives a surprise in standard deviations once a release has four or more", () => {
  const rows = [1, -1, 2, -2]
    .map((s, i) => ({ id: "X", surprise: s, day: `d${i}` }))
    .concat([{ id: "Y", surprise: 3 }]);
  const out = surp.addZ(rows);
  const sd = Math.sqrt((1 + 1 + 4 + 4) / 3);
  assert.equal(out[2].z, Number((2 / sd).toFixed(1)));
  assert.equal(out[0].n, 4);
  assert.equal(out.find((r) => r.id === "Y").z, null);
});

// ---------- SURP: the market-reaction join ----------
test("SURP joins each release day to that day's S&P 500, 10-year yield and EURUSD moves", () => {
  const bars = (f) => parseYahoo(fj(f), "1D");
  const mkt = {
    spx: surp.closesByDay(bars("yahoo-gspc-1d.json")),
    tnx: surp.closesByDay(bars("yahoo-tnx-1d.json")),
    eur: surp.closesByDay(bars("yahoo-eurusd-1d.json")),
  };
  const day = "2026-10-14";
  const spx = mkt.spx.get(day);
  const tnx = mkt.tnx.get(day);
  const eur = mkt.eur.get(day);
  assert.ok(spx && tnx && eur, "every series has a bar on the CPI day");
  const r = surp.reactionOn(day, mkt);
  assert.equal(r.spx, Number(((spx.close / spx.prev - 1) * 100).toFixed(2)));
  assert.equal(r.us10y, Number(((tnx.close - tnx.prev) * 100).toFixed(1)));
  assert.equal(r.eurusd, Number(((eur.close / eur.prev - 1) * 100).toFixed(2)));
  assert.ok(
    Math.abs(r.spx) < 5 && Math.abs(r.us10y) < 40 && Math.abs(r.eurusd) < 3,
  );
  // A weekend or holiday has no bar, so no move.
  assert.deepEqual(surp.reactionOn("2026-10-11", mkt), {
    spx: null,
    us10y: null,
    eurusd: null,
  });
  // The first bar has nothing before it.
  const first = new Date(bars("yahoo-gspc-1d.json")[0].time * 1000)
    .toISOString()
    .slice(0, 10);
  assert.equal(mkt.spx.has(first), false);
});

// ---------- SURP: the log, end to end ----------
test("SURP end to end: walks back through the days, logs them, and asks for a past day only once", async () => {
  const days = {
    "2026-10-15": "2026-10-14",
    "2026-10-16": "2026-10-15",
    "2026-10-03": "2026-10-02",
  };
  // Other weekdays get one real released row that isn't a main release; one day comes back empty.
  const filler = fj("nasdaq-eco-2026-10-14.json").data.rows.filter(
    (r) => r.eventName === "MBA Mortgage Applications",
  );
  const nasdaq = (u) => {
    const asked = /date=(\d{4}-\d{2}-\d{2})/.exec(u)[1];
    if (days[asked]) return fj(`nasdaq-eco-${days[asked]}.json`);
    return { data: { rows: asked === "2026-10-08" ? [] : filler } };
  };
  serve(
    [/api\.nasdaq\.com\/api\/calendar\/economicevents/, 200, nasdaq],
    [/finance\/chart\/%5EGSPC/, 200, fj("yahoo-gspc-1d.json")],
    [/finance\/chart\/%5ETNX/, 200, fj("yahoo-tnx-1d.json")],
    [/finance\/chart\/EURUSD%3DX/, 200, fj("yahoo-eurusd-1d.json")],
  );
  const d = await surp.buildSurp("2026-10-15");
  const asked = calls.filter((c) => /economicevents/.test(c.url));
  // One request a weekday, plus one more try for the day that came back empty, with a fresh cache-buster.
  assert.equal(asked.length, surp.windowDays("2026-10-15").length + 1);
  const tries = asked
    .filter((c) => /date=2026-10-08&/.test(c.url))
    .map((c) => /_=([^&]+)/.exec(c.url)[1]);
  assert.equal(tries.length, 2);
  assert.notEqual(tries[0], tries[1]);
  assert.ok(
    asked.every((c) => !/date=2026-10-1[12]\b/.test(c.url)),
    "weekends are skipped",
  );
  assert.ok(
    asked.some((c) => /date=2026-10-16/.test(c.url)),
    "today is asked for as tomorrow (Nasdaq's offset)",
  );

  const cpi = d.rows.find((r) => r.id === "CPI-YY");
  assert.equal(cpi.day, "2026-10-14");
  assert.equal(typeof cpi.spx, "number");
  assert.equal(typeof cpi.us10y, "number");
  assert.equal(cpi.partial, false);
  assert.equal(d.rows.find((r) => r.id === "CLAIMS").partial, true);
  assert.equal(d.rows[0].day, "2026-10-15", "newest first");
  assert.match(d.source, /Nasdaq economic calendar/);

  const log = store.read("eco-log");
  assert.equal(
    log.days["2026-10-07"],
    undefined,
    "an empty answer for a past day isn't logged",
  );
  assert.deepEqual(d.missed, ["2026-10-07"]);
  assert.match(d.source, /didn't answer for 1 day/);
  assert.equal(log.days["2026-10-14"].final, true);
  assert.equal(
    log.days["2026-10-15"].final,
    false,
    "today stays open until it's over",
  );
  assert.ok(log.days["2026-10-14"].rows.every((r) => r.actual));
  assert.ok(
    log.days["2026-10-14"].rows.some(
      (r) => r.event === "CPI" && r.actual === "3.7%",
    ),
  );

  serve(...routes);
  await surp.buildSurp("2026-10-15");
  const again = calls.filter((c) => /economicevents/.test(c.url));
  assert.deepEqual(
    again.map((c) => /date=([\d-]+)/.exec(c.url)[1]).sort(),
    ["2026-10-08", "2026-10-08", "2026-10-16"],
    "only today and the day that came back empty are asked for again",
  );
});

test("SURP keeps a past day as first logged (point in time)", () => {
  const log = { days: {} };
  const rows = [
    {
      time: "t",
      country: "United States",
      event: "CPI",
      actual: "3.7%",
      consensus: "3.6%",
      previous: "3.4%",
    },
  ];
  assert.equal(surp.mergeDay(log, "2026-10-14", rows, "2026-10-15"), true);
  const revised = [{ ...rows[0], actual: "3.8%" }];
  assert.equal(surp.mergeDay(log, "2026-10-14", revised, "2026-10-15"), false);
  assert.equal(log.days["2026-10-14"].rows[0].actual, "3.7%");
  assert.equal(surp.mergeDay(log, "2026-10-15", rows, "2026-10-15"), true);
  assert.equal(surp.mergeDay(log, "2026-10-15", revised, "2026-10-15"), true);
  assert.equal(log.days["2026-10-15"].rows[0].actual, "3.8%");
});
