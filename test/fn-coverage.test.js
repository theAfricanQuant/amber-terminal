// CRED, AUCT, CT, OVDV and DES outside the US, offline: trimmed real responses saved on 15 Oct 2026 in
// test/fixtures/coverage, run through the same parse and maths code the server uses. The Yahoo session (cookie +
// crumb, renewed once on a 401) runs against a fake network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { parseFredCsv } from "../lib/fn/ecst.js";
import {
  spreadRow,
  percentile,
  businessDaysBetween,
  SERIES,
} from "../lib/fn/cred.js";
import { auctionRow, splitAuctions } from "../lib/fn/auct.js";
import {
  rootOf,
  contractMonths,
  contractSymbol,
  lastBar,
  curveShape,
  buildCurve,
  GENERIC,
  ROOTS,
} from "../lib/fn/ct.js";
import {
  pickTenors,
  smilePoints,
  ivAtMoneyness,
  ivAtDelta,
  surfaceRow,
  vixShape,
  vixRows,
} from "../lib/fn/ovdv.js";
import { parseCboe } from "../lib/fn/omon.js";
import {
  quoteSummary,
  parseProfile,
  resetYahooSession,
} from "../lib/fn/des.js";

const fx = (f) =>
  readFileSync(new URL(`./fixtures/coverage/${f}`, import.meta.url), "utf8");
const json = (f) => JSON.parse(fx(f));
const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const CAPTURED = "2026-10-15";

// ---------- CRED ----------
test("CRED: US high yield spread, changes and one-year range from FRED's CSV", () => {
  const rows = parseFredCsv(fx("fred-BAMLH0A0HYM2.csv"));
  const hy = SERIES.find((s) => s.id === "BAMLH0A0HYM2");
  const r = spreadRow(hy, rows, CAPTURED);
  assert.equal(r.date, "2026-10-13");
  assert.equal(r.bp, 316); // 3.16%
  assert.equal(r.chg1w, 13); // vs 6 Oct, 3.03%
  assert.equal(r.chg1m, 51); // 13 Sep was a Sunday: Fri 11 Sep, 2.65%
  assert.equal(r.chg1y, -2); // 13 Oct 2025, 3.18%
  assert.equal(r.low1y, 260);
  assert.equal(r.high1y, 346);
  assert.equal(r.pctile, 91);
  assert.equal(r.behind, 2); // Wed 14 and Thu 15 Oct
  assert.equal(r.history.at(-1).bp, 316);
});

test("CRED: percentile counts the earlier days of the past year below today, ties as half", () => {
  const days = (vals) =>
    vals.map((value, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      value,
    }));
  assert.equal(percentile(days([1, 2, 3, 4, 5])), 100);
  assert.equal(percentile(days([5, 4, 3, 2, 1])), 0);
  assert.equal(percentile(days([1, 3, 2])), 50);
  assert.equal(percentile(days([2, 2, 2])), 50);
  // Older than a year doesn't count.
  assert.equal(
    percentile([
      { date: "2024-01-01", value: 9 },
      { date: "2025-06-01", value: 1 },
      { date: "2026-01-01", value: 5 },
    ]),
    100,
  );
  assert.equal(percentile([{ date: "2026-01-01", value: 1 }]), null);
});

test("CRED: business days skip weekends", () => {
  assert.equal(businessDaysBetween("2026-10-13", "2026-10-15"), 2);
  assert.equal(businessDaysBetween("2026-10-09", "2026-10-12"), 1); // Fri to Mon
  assert.equal(businessDaysBetween("2026-10-15", "2026-10-15"), 0);
});

// ---------- AUCT ----------
test("AUCT: each kind of security reads its own rate", () => {
  const done = json("treasurydirect-auctioned.json");
  const find = (cusip, date) =>
    auctionRow(
      done.find((r) => r.cusip === cusip && r.auctionDate.startsWith(date)),
    );
  const ten = find("91282CRF0", "2026-10-07");
  assert.equal(ten.name, "10-year note");
  assert.equal(ten.left, "9-year 10-month");
  assert.equal(ten.rate, 5.3);
  assert.equal(ten.rateKind, "yield");
  assert.equal(ten.coupon, 4.625);
  assert.equal(ten.bidToCover, 2.77);
  assert.equal(ten.offering, 39e9);
  assert.equal(ten.issue, "2026-10-15");
  const bill = find("912797WZ6", "2026-10-14");
  assert.equal(bill.name, "17-week bill");
  assert.equal(bill.rate, 4.195);
  assert.equal(bill.rateKind, "discount rate");
  assert.equal(bill.coupon, null);
  assert.equal(bill.left, null);
  const frn = find("91282CRD5", "2026-09-23");
  assert.equal(frn.type, "FRN");
  assert.equal(frn.name, "2-year FRN");
  assert.equal(frn.rate, 0.04);
  assert.equal(frn.rateKind, "margin");
  const tips = find("91282CRE3", "2026-09-17");
  assert.equal(tips.rate, 2.653);
  assert.equal(tips.rateKind, "real yield");
  const three = find("91282CRQ6", "2026-10-06");
  assert.equal(three.reopening, false);
  assert.equal(three.left, null);
});

test("AUCT: upcoming soonest first, results newest first, an auction never in both", () => {
  const up = json("treasurydirect-upcoming.json");
  const done = json("treasurydirect-auctioned.json");
  const { upcoming, recent } = splitAuctions(up, done, CAPTURED);
  assert.equal(upcoming.length, 7);
  assert.equal(upcoming[0].auction, "2026-10-15");
  assert.equal(upcoming[0].offering, 110e9);
  assert.equal(upcoming.find((r) => r.cusip === "912797TM9").offering, null); // amount not announced yet
  assert.ok(
    upcoming.every((r, i) => i === 0 || r.auction >= upcoming[i - 1].auction),
  );
  assert.equal(recent[0].auction, "2026-10-14");
  assert.ok(
    recent.every((r, i) => i === 0 || r.auction <= recent[i - 1].auction),
  );
  // Once today's 4-week bill has a result, it moves from upcoming to recent.
  const result = {
    ...up[0],
    highDiscountRate: "3.990000",
    bidToCoverRatio: "2.500000",
  };
  const after = splitAuctions(up, [result, ...done], CAPTURED);
  assert.equal(after.upcoming.length, 6);
  assert.equal(after.recent[0].cusip, up[0].cusip);
  assert.equal(after.recent[0].rate, 3.99);
});

// ---------- CT ----------
test("CT: generic tickers and Yahoo symbols map to roots and exchanges", () => {
  assert.equal(rootOf("CL=F"), "CL");
  assert.equal(rootOf("YAHOO:GC=F"), "GC");
  assert.equal(rootOf("CL1"), "CL");
  assert.equal(rootOf("CO1"), "BZ");
  assert.equal(rootOf("C1"), "ZC");
  assert.equal(rootOf("TY1"), "ZN");
  assert.equal(rootOf("ES"), "ES");
  assert.equal(rootOf("CLZ26.NYM"), "CL");
  assert.equal(rootOf("CLZ26=F"), "CL");
  assert.equal(rootOf("AAPL"), null);
  assert.equal(rootOf("EURUSD=X"), null);
  for (const [g, r] of Object.entries(GENERIC))
    assert.ok(ROOTS[r], `${g} -> ${r}`);
  assert.equal(contractSymbol("GC", 2026, 12), "GCZ26.CMX");
  assert.equal(contractSymbol("NG", 2027, 1), "NGF27.NYM");
  assert.equal(contractSymbol("ES", 2026, 12), "ESZ26.CME");
  assert.equal(contractSymbol("ZC", 2026, 12), "ZCZ26.CBT");
});

test("CT: contract months follow each market's listing cycle", () => {
  const cl = contractMonths("CL", CAPTURED);
  assert.equal(cl.length, 14);
  assert.deepEqual(
    cl.slice(0, 3).map((c) => c.code),
    ["CLV26", "CLX26", "CLZ26"],
  );
  assert.equal(cl[2].label, "Dec 2026");
  assert.deepEqual(
    contractMonths("GC", CAPTURED, 5).map((c) => c.code),
    ["GCV26", "GCZ26", "GCG27", "GCJ27", "GCM27"],
  );
  assert.deepEqual(
    contractMonths("ES", CAPTURED, 4).map((c) => c.code),
    ["ESZ26", "ESH27", "ESM27", "ESU27"],
  );
  assert.deepEqual(
    contractMonths("ZS", CAPTURED, 4).map((c) => c.code),
    ["ZSX26", "ZSF27", "ZSH27", "ZSK27"],
  );
});

test("CT: a month with no close today keeps its last price and date", () => {
  const ts = [
    Date.UTC(2026, 9, 13, 4) / 1000,
    Date.UTC(2026, 9, 14, 4) / 1000,
    Date.UTC(2026, 9, 15, 4) / 1000,
  ];
  const stale = lastBar({ timestamp: ts, close: [10, 11, null] });
  assert.equal(stale.price, 11);
  assert.equal(stale.date, "2026-10-14");
  assert.equal(stale.change, 1);
  close(stale.changePct, 10, 1e-9);
  const b = lastBar({ timestamp: ts, close: [10, 11, 12.1] });
  assert.equal(b.date, "2026-10-15");
  close(b.change, 1.1, 1e-12);
  assert.equal(lastBar({ timestamp: ts, close: [null, null, null] }), null);
});

test("CT: contango and backwardation are last month against first, in percent", () => {
  const pts = (...p) => p.map((price, i) => ({ label: `M${i}`, price }));
  const up = curveShape(pts(100, 104, 110));
  assert.equal(up.shape, "contango");
  close(up.spreadPct, 10);
  close(up.nextPct, 4);
  const down = curveShape(pts(96, 90, 81.6));
  assert.equal(down.shape, "backwardation");
  close(down.spreadPct, -15);
  assert.equal(curveShape(pts(100, 100.05)).shape, "flat");
  // Natural gas: winter peak and spring trough between ends that match.
  const ng = curveShape(pts(3.22, 3.55, 3.96, 2.67, 3.22));
  assert.equal(ng.peak.label, "M2");
  assert.equal(ng.trough.label, "M3");
  assert.equal(curveShape(pts(100, 101, 102)).peak, null);
  assert.equal(curveShape(pts(100)), null);
});

test("CT: WTI curve from Yahoo's contract strip, expired front month dropped", () => {
  const months = contractMonths("CL", CAPTURED);
  const d = buildCurve(months, json("yahoo-cl-spark.json"));
  assert.equal(d.session, "2026-10-15");
  assert.equal(d.contracts.length, 12);
  assert.equal(d.contracts[0].code, "CLX26"); // October expired on 22 Sep: Yahoo sends nothing for it
  assert.equal(d.contracts[0].price, 96.08);
  close(d.contracts[0].change, 0.99, 1e-9);
  assert.ok(d.contracts.every((c) => c.current));
  assert.deepEqual(d.missing, []);
  assert.equal(d.curve.shape, "backwardation");
  assert.equal(d.curve.first.label, "Nov 2026");
  assert.equal(d.curve.last.label, "Oct 2027");
  close(d.curve.spreadPct, (81.22 / 96.08 - 1) * 100);
});

test("CT: gold months that haven't traded today are marked and left out of the curve", () => {
  const d = buildCurve(
    contractMonths("GC", CAPTURED),
    json("yahoo-gc-spark.json"),
  );
  const by = Object.fromEntries(d.contracts.map((c) => [c.code, c]));
  assert.equal(by.GCV26.current, false);
  assert.equal(by.GCV26.date, "2026-10-14");
  assert.equal(by.GCV26.price, 4084.8);
  assert.equal(by.GCZ26.current, true);
  assert.equal(by.GCJ28.current, false);
  assert.equal(d.curve.shape, "contango");
  assert.equal(d.curve.first.label, "Dec 2026");
  assert.equal(d.curve.last.label, "Jun 2028");
  close(d.curve.spreadPct, (4507.8 / 4178 - 1) * 100);
});

test("CT: months missing in the middle are named", () => {
  const months = contractMonths("CL", CAPTURED);
  const spark = json("yahoo-cl-spark.json");
  delete spark["CLF27.NYM"];
  const d = buildCurve(months, spark);
  assert.deepEqual(d.missing, ["Jan 2027"]);
});

// ---------- OVDV ----------
const spx = () => parseCboe(json("cboe-spx-surface.json"), CAPTURED);

test("OVDV: one expiry per tenor, nearest date, no repeats", () => {
  const days = [
    0, 1, 2, 3, 7, 8, 14, 21, 28, 30, 35, 63, 91, 182, 273, 365, 730,
  ];
  const list = days.map((d, i) => ({
    n: i + 1,
    date: `d${String(d).padStart(3, "0")}`,
    root: "X",
    days: d,
  }));
  assert.deepEqual(
    pickTenors(list).map((e) => e.days),
    [7, 14, 30, 63, 91, 182, 273, 365],
  );
  // Only two months listed: no 6-month or 1-year column made up from the last expiry.
  assert.deepEqual(
    pickTenors(list.filter((e) => e.days <= 63)).map((e) => e.days),
    [7, 14, 30, 63],
  );
  // SPX and SPXW on the same date: the first one listed is kept.
  const dup = [
    { n: 1, date: "a", root: "SPX", days: 30 },
    { n: 2, date: "a", root: "SPXW", days: 30 },
  ];
  assert.equal(pickTenors(dup)[0].root, "SPX");
});

test("OVDV: interpolation by moneyness and by delta", () => {
  const pts = [
    { m: 90, iv: 20, delta: -0.1, side: "put" },
    { m: 95, iv: 16, delta: -0.3, side: "put" },
    { m: 98, iv: 14, delta: -0.45, side: "put" },
    { m: 102, iv: 12, delta: 0.4, side: "call" },
    { m: 105, iv: 11, delta: 0.2, side: "call" },
  ];
  close(ivAtMoneyness(pts, 100), 13);
  close(ivAtMoneyness(pts, 92.5), 18);
  assert.equal(ivAtMoneyness(pts, 80), null);
  close(ivAtDelta(pts, -0.25), 17); // a quarter of the way from -0.3 (16) to -0.1 (20)
  close(ivAtDelta(pts, 0.25), 11.25);
  assert.equal(ivAtDelta(pts, -0.05), null);
});

test("OVDV: SPX surface from CBOE's chain: out-of-the-money smile, put skew", () => {
  const chain = spx();
  const S = chain.price;
  assert.deepEqual(
    chain.expiries.map((e) => e.date),
    ["2026-10-22", "2026-11-13", "2026-12-18"],
  );
  const month = chain.expiries[1];
  const pts = smilePoints(month.rows, S);
  assert.equal(pts.length, 31); // every strike 50 points apart within 10% of spot
  assert.ok(
    pts.every((p) => (p.strike < S ? p.side === "put" : p.side === "call")),
  );
  // At the money: straight line between the 7700 put and the 7750 call.
  const p7700 = month.rows.find((r) => r.strike === 7700).put;
  const c7750 = month.rows.find((r) => r.strike === 7750).call;
  const row = surfaceRow(pts);
  const m0 = (7700 / S) * 100,
    m1 = (7750 / S) * 100;
  close(
    row.atm,
    p7700.iv * 100 + ((100 - m0) * (c7750.iv - p7700.iv) * 100) / (m1 - m0),
    1e-9,
  );
  assert.ok(row.atm > 10 && row.atm < 20, `ATM ${row.atm}`);
  assert.ok(
    row.put25 > row.atm && row.atm > row.call25,
    "equity index skew: puts dearer than calls",
  );
  close(row.skew, row.put25 - row.call25);
  close(row.byMoneyness[100], row.atm);
  assert.ok(ivAtMoneyness(pts, 92) > row.byMoneyness[95]);
  assert.equal(row.byMoneyness[80], null); // no strikes that far out in this trimmed file: no number made up
});

test("OVDV: VIX term structure shape", () => {
  const rows = vixRows(json("yahoo-vix-spark.json"));
  assert.deepEqual(
    rows.map((r) => r.value),
    [14.59, 17.52, 18.79, 20.49, 21.94],
  );
  assert.equal(rows[1].date, "2026-10-15");
  assert.equal(rows[2].date, "2026-10-14"); // today's close not in yet: yesterday's, with its own date
  const s = vixShape(rows);
  assert.equal(s.shape, "contango");
  close(s.ratio, 17.52 / 18.79);
  assert.equal(s.steady, true);
  const mk = (a) =>
    a.map((value, i) => ({
      label: ["VIX9D", "VIX", "VIX3M", "VIX6M", "VIX1Y"][i],
      value,
    }));
  const inv = vixShape(mk([32, 28, 24, 23, 22]));
  assert.equal(inv.shape, "inverted");
  assert.equal(inv.steady, false);
  assert.equal(vixShape(mk([15, 18, 18.05, 19, 18.5])).shape, "flat");
  assert.equal(vixShape(mk([15, null, 18, 19, 20])), null);
});

// ---------- DES outside the US: Yahoo session and profile ----------
test("DES: Vodafone profile from Yahoo's quoteSummary", () => {
  const p = parseProfile(
    json("yahoo-quotesummary-vod.json").quoteSummary.result[0],
  );
  assert.equal(p.name, "Vodafone Group Public Limited Company");
  assert.equal(p.sector, "Communication Services");
  assert.equal(p.industry, "Telecom Services");
  assert.equal(p.region, "United Kingdom");
  assert.equal(p.website, "https://www.vodafone.com");
  assert.match(
    p.description,
    /^Vodafone Group Public Limited Company provides telecommunication/,
  );
  const s = Object.fromEntries(p.stats.map((x) => [x.label, x.value]));
  assert.equal(s.Exchange, "LSE");
  assert.equal(s.Currency, "GBp (pence)");
  assert.equal(s["Market value"], "27.84B GBP"); // the price is in pence, the market value in pounds
  assert.equal(s["P/E (last 12 months)"], undefined); // loss-making: Yahoo sends no trailing P/E
  assert.equal(s["P/E (next 12 months)"], "12.02");
  assert.equal(s["Dividend yield"], "3.38%");
  assert.equal(s["52-week range"], "85.08 to 132.07");
  assert.equal(s.Employees, "91,128");
  assert.equal(p.low52, 85.08); // fed to the price line, so both show the same range
  assert.equal(p.high52, 132.072);
  assert.equal(parseProfile(null), null);
});

function fakeYahoo(script) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, cookie: opts.headers?.Cookie || null });
    const step = script.find((s) => s.match.test(u) && !s.used);
    if (!step) throw new TypeError(`unexpected fetch ${u}`);
    if (step.once) step.used = true;
    return step.reply(u);
  };
  return calls;
}
const cookieReply = (v) => () =>
  new Response("", {
    status: 404,
    headers: { "set-cookie": `A3=${v}; Domain=.yahoo.com; Path=/` },
  });
const vod = fx("yahoo-quotesummary-vod.json");

test("DES: a stale crumb (401) gets one fresh session and one retry", async () => {
  resetYahooSession();
  let crumbs = 0;
  const calls = fakeYahoo([
    { match: /fc\.yahoo\.com/, reply: cookieReply("first") },
    { match: /getcrumb/, reply: () => new Response(`crumb${++crumbs}`) },
    {
      match: /quoteSummary.*crumb=crumb1/,
      reply: () =>
        new Response('{"finance":{"error":{"code":"Unauthorized"}}}', {
          status: 401,
        }),
    },
    { match: /quoteSummary.*crumb=crumb2/, reply: () => new Response(vod) },
  ]);
  const r = await quoteSummary("VOD.L", [
    "assetProfile",
    "summaryDetail",
    "price",
  ]);
  assert.equal(r.price.longName, "Vodafone Group Public Limited Company");
  assert.deepEqual(
    calls.map((c) => new URL(c.url).pathname),
    [
      "/",
      "/v1/test/getcrumb",
      "/v10/finance/quoteSummary/VOD.L",
      "/",
      "/v1/test/getcrumb",
      "/v10/finance/quoteSummary/VOD.L",
    ],
  );
  assert.equal(calls[1].cookie, "A3=first");
  assert.match(
    calls[2].url,
    /modules=assetProfile,summaryDetail,price&crumb=crumb1/,
  );
  // The session is kept: the next lookup is one request.
  calls.length = 0;
  await quoteSummary("VOD.L", ["price"]);
  assert.equal(calls.length, 1);
});

test("DES: a second 401 gives up instead of looping, and 404 says there's no profile", async () => {
  resetYahooSession();
  const calls = fakeYahoo([
    { match: /fc\.yahoo\.com/, reply: cookieReply("x") },
    { match: /getcrumb/, reply: () => new Response("abc") },
    {
      match: /quoteSummary\/NOPE/,
      reply: () => new Response("{}", { status: 404 }),
    },
    { match: /quoteSummary/, reply: () => new Response("{}", { status: 401 }) },
  ]);
  await assert.rejects(quoteSummary("VOD.L", ["price"]), /HTTP 401/);
  assert.equal(calls.filter((c) => /quoteSummary/.test(c.url)).length, 2);
  await assert.rejects(
    quoteSummary("NOPE.L", ["price"]),
    (e) => e.status === 404 && /no profile/.test(e.message),
  );
});

test("DES: no cookie from fc.yahoo.com falls back to finance.yahoo.com; a bad crumb is refused", async () => {
  resetYahooSession();
  const calls = fakeYahoo([
    { match: /fc\.yahoo\.com/, reply: () => new Response("", { status: 404 }) },
    { match: /finance\.yahoo\.com\/$/, reply: cookieReply("fallback") },
    {
      match: /getcrumb/,
      reply: () =>
        new Response("<html>Too Many Requests</html>", { status: 429 }),
    },
  ]);
  await assert.rejects(quoteSummary("VOD.L", ["price"]), /HTTP 429/);
  assert.equal(calls[2].cookie, "A3=fallback");
});
