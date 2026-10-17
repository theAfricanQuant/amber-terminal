// Rates and economics functions (GC, BTMM, WIRP, ECST, CBRT, COT), offline: trimmed real responses saved on
// 15 Oct 2026 in test/fixtures/rates, run through the same parse and compute code the server uses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import gc, {
  parseCsv,
  parseTreasuryCsv,
  byTenor,
  usCurves,
  spread2s10s,
  cnbcCurve,
  COUNTRIES,
  countryCode,
  shiftMonths,
  toNum,
} from "../lib/fn/gc.js";
import { nyfedRow, dayRow } from "../lib/fn/btmm.js";
import { impliedPath, contractMonths, zqSymbol, FOMC } from "../lib/fn/wirp.js";
import {
  parseFredCsv,
  yoy,
  monthlyDiff,
  buildRow,
  SERIES,
} from "../lib/fn/ecst.js";
import { parseBis, lastChange } from "../lib/fn/cbrt.js";
import { cotRow, marketKey } from "../lib/fn/cot.js";
import { rowFrom } from "../lib/fn/board.js";
import { describeStep } from "../public/js/fn/rates.js";

const fx = (f) =>
  readFileSync(new URL(`./fixtures/rates/${f}`, import.meta.url), "utf8");
const json = (f) => JSON.parse(fx(f));
const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

const curveRows = () =>
  byTenor([
    ...parseTreasuryCsv(fx("treasury-curve-2025.csv")),
    ...parseTreasuryCsv(fx("treasury-curve-2026.csv")),
  ]).sort((a, b) => (a.date < b.date ? -1 : 1));

// ---------- shared helpers ----------
test("CSV reader handles quotes, doubled quotes, commas inside quotes and CRLF", () => {
  assert.deepEqual(parseCsv('a,"b, c","say ""hi"""\r\n1,,3\r\n'), [
    ["a", "b, c", 'say "hi"'],
    ["1", "", "3"],
  ]);
  assert.equal(toNum("4.745%"), 4.745);
  assert.equal(toNum("UNCH"), null);
  assert.equal(toNum(""), null);
});

test("month arithmetic clamps to the end of the month", () => {
  assert.equal(shiftMonths("2026-03-31", -1), "2026-02-28");
  assert.equal(shiftMonths("2024-02-29", -12), "2023-02-28");
  assert.equal(shiftMonths("2026-10-14", -12), "2025-10-14");
});

// ---------- GC ----------
test("GC: Treasury par curve has every tenor from 1 month to 30 years", () => {
  const c = usCurves(curveRows());
  assert.deepEqual(c.tenors, [
    "1M",
    "1.5M",
    "2M",
    "3M",
    "4M",
    "6M",
    "1Y",
    "2Y",
    "3Y",
    "5Y",
    "7Y",
    "10Y",
    "20Y",
    "30Y",
  ]);
  const [now, w, m, y] = c.curves;
  assert.equal(now.date, "2026-10-14");
  assert.equal(now.values["10Y"], 5.19);
  assert.equal(now.values["2Y"], 4.82);
  assert.equal(now.values["30Y"], 5.52);
  // 1 week, 1 month and 1 year before 14 Oct 2026 (all trading days).
  assert.deepEqual(
    [w.date, m.date, y.date],
    ["2026-10-07", "2026-09-14", "2025-10-14"],
  );
  assert.equal(w.values["10Y"], 5.28);
  assert.equal(y.values["10Y"], 4.03);
  assert.equal(y.values["2Y"], 3.48);
});

test("GC: a target date with no trading falls back to the trading day before", () => {
  // 12 Oct 2026 was Columbus Day: the Treasury market was shut, so a week before 19 Oct is 9 Oct.
  const rows = curveRows();
  const c = usCurves([
    ...rows,
    { date: "2026-10-19", values: rows.at(-1).values },
  ]);
  assert.equal(c.curves[1].date, "2026-10-09");
});

test("GC: 2s10s spread is 10-year minus 2-year in basis points, hand-checked", () => {
  const s = spread2s10s(usCurves(curveRows()).curves[0].values);
  // 5.19% - 4.82% = 0.37 points = 37bp. Positive, so not inverted.
  assert.deepEqual(s, {
    bp: 37,
    inverted: false,
    twoYear: 4.82,
    tenYear: 5.19,
  });
  // One year earlier: 4.03% - 3.48% = 55bp.
  assert.equal(spread2s10s(usCurves(curveRows()).curves[3].values).bp, 55);
  // An inverted curve, as in 2023: 2-year 5.05%, 10-year 3.97% = -108bp.
  assert.deepEqual(spread2s10s({ "2Y": 5.05, "10Y": 3.97 }), {
    bp: -108,
    inverted: true,
    twoYear: 5.05,
    tenYear: 3.97,
  });
  assert.equal(spread2s10s({ "10Y": 4 }), null);
});

test("GC: CNBC live curve (UK) keeps known tenors and skips unknown symbols", () => {
  const c = cnbcCurve(json("cnbc-uk.json"), COUNTRIES.UK);
  assert.deepEqual(c.tenors, [
    "1Y",
    "2Y",
    "3Y",
    "5Y",
    "7Y",
    "10Y",
    "15Y",
    "20Y",
    "30Y",
  ]);
  const [now, prev] = c.curves;
  assert.equal(now.values["10Y"], 5.3166);
  assert.equal(prev.values["10Y"], 5.4302);
  // The newest quote time, with CNBC's "-0400" and "+0000" offsets both read correctly.
  assert.equal(now.date, "2026-10-15T12:39:30.000Z");
  assert.equal(spread2s10s(now.values).bp, 48.9); // 5.3166 - 4.8272 = 0.4894
});

test("GC: country words map to codes", () => {
  assert.equal(countryCode("GERMANY"), "DE");
  assert.equal(countryCode("us live"), "USLIVE");
  assert.equal(countryCode(undefined), "US");
  assert.equal(countryCode("ZZ"), null);
});

test("GC route: US from the Treasury CSV, with fetch faked", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const file = u.includes("/2026/")
      ? "treasury-curve-2026.csv"
      : u.includes("/2025/")
        ? "treasury-curve-2025.csv"
        : null;
    return new Response(file ? fx(file) : "Date\n", { status: 200 });
  };
  try {
    const d = await gc({});
    assert.equal(d.kind, "history");
    assert.equal(d.curves[0].date, "2026-10-14");
    assert.equal(d.spread.bp, 37);
    assert.equal(d.tenors.length, 14);
    assert.match(d.source, /Treasury/);
    await assert.rejects(gc({ country: "ZZ" }), /No yield curve/);
  } finally {
    globalThis.fetch = real;
  }
});

// ---------- BTMM ----------
test("BTMM: NY Fed rows give the rate, the day change and the Fed's target range", () => {
  const e = nyfedRow(json("nyfed-effr.json"));
  assert.deepEqual(
    {
      rate: e.rate,
      date: e.date,
      prev: e.prev,
      changeBp: e.changeBp,
      from: e.targetFrom,
      to: e.targetTo,
    },
    {
      rate: 3.88,
      date: "2026-10-13",
      prev: 3.88,
      changeBp: 0,
      from: 3.75,
      to: 4,
    },
  );
  const s = nyfedRow(json("nyfed-sofr.json"));
  assert.equal(s.rate, 3.88);
  assert.equal(s.prev, 3.89);
  assert.equal(s.changeBp, -1);
  // SOFR sits near EFFR, as it should.
  assert.ok(Math.abs(s.rate - e.rate) < 0.25);
});

test("BTMM: bill yields use the coupon-equivalent column", () => {
  const rows = byTenor(parseTreasuryCsv(fx("treasury-bills-2026.csv")));
  assert.deepEqual(Object.keys(rows[0].values).sort(), [
    "13W",
    "17W",
    "26W",
    "4W",
    "52W",
    "6W",
    "8W",
  ]);
  const b = dayRow(rows, "13W");
  assert.deepEqual(b, {
    rate: 4.2,
    date: "2026-10-14",
    prev: 4.19,
    prevDate: "2026-10-13",
    changeBp: 1,
  });
  assert.equal(dayRow(rows, "52W").rate, 4.5);
});

// ---------- WIRP ----------
const zqAvg = () => {
  const spark = json("yahoo-zq-spark.json");
  const avg = {};
  for (const c of contractMonths("2026-10-15"))
    if (spark[c.symbol])
      avg[c.key] = 100 - rowFrom(c.symbol, spark[c.symbol]).price;
  return avg;
};

test("WIRP: contract strip runs from this month past the last listed meeting", () => {
  const m = contractMonths("2026-10-15");
  assert.equal(m[0].symbol, "ZQV26.CBT");
  assert.equal(m.at(-1).symbol, "ZQF28.CBT");
  assert.equal(m.length, 16);
  assert.equal(zqSymbol(2027, 6), "ZQM27.CBT");
  assert.equal(FOMC.length, 16);
  for (const d of FOMC)
    assert.equal(
      new Date(`${d}T12:00:00Z`).getUTCDay(),
      3,
      `${d} is a Wednesday`,
    );
});

test("WIRP: implied rates are 100 minus the futures price", () => {
  const avg = zqAvg();
  close(avg["2026-10"], 3.887); // 100 - 96.113
  close(avg["2026-11"], 3.955); // 100 - 96.045
  close(avg["2026-12"], 4.11); // 100 - 95.89
  close(avg["2027-03"], 4.345); // 100 - 95.655
});

test("WIRP: meeting path hand-checked from 15 Oct 2026 prices, EFFR 3.88%", () => {
  const p = impliedPath({ effr: 3.88, avg: zqAvg(), today: "2026-10-15" });
  assert.equal(p[0].date, "2026-10-28");
  // 28 Oct: decision on day 28 of 31, only 3 days left, so the November contract gives the rate after: 3.955%.
  assert.equal(p[0].contract, "2026-11");
  close(p[0].after, 3.955);
  close(p[0].stepBp, 7.5);
  close(p[0].moves, 0.3); // 7.5bp of a 25bp move
  // 9 Dec: 9 days at 3.955%, 22 at the new rate, December averages 4.11%.
  // after = (4.11 x 31 - 3.955 x 9) / 22 = (127.41 - 35.595) / 22 = 4.1734090...
  assert.equal(p[1].contract, "2026-12");
  close(p[1].after, 91.815 / 22);
  close(p[1].cumBp, (91.815 / 22 - 3.88) * 100); // 29.34bp above today
  close(p[1].moves, (91.815 / 22 - 3.88) / 0.25); // 1.17 hikes priced by December
  // 27 Jan 2027: last week of January, so February's 4.275% is the rate after.
  assert.equal(p[2].contract, "2027-02");
  close(p[2].after, 4.275);
  // 17 Mar 2027: (4.345 x 31 - 4.275 x 17) / 14 = 62.02 / 14 = 4.43
  close(p[3].after, 4.43);
  // 8 Dec 2027: (4.60 x 31 - 4.635 x 8) / 23 = 105.52 / 23
  const dec27 = p.find((x) => x.date === "2027-12-08");
  close(dec27.after, 105.52 / 23);
  assert.equal(p.length, 10); // every meeting after today
});

test("WIRP: a cut reads as a cut, and a missing contract stops the chain", () => {
  const p = impliedPath({
    effr: 4,
    avg: { "2026-11": 3.875, "2026-12": 3.75 },
    today: "2026-10-15",
  });
  close(p[0].stepBp, -12.5);
  close(p[0].moves, -0.5);
  // December: (3.75 x 31 - 3.875 x 9) / 22
  close(p[1].after, (3.75 * 31 - 3.875 * 9) / 22);
  assert.equal(p.length, 2); // no February price, so January's meeting isn't guessed
  assert.equal(
    impliedPath({ effr: 4, avg: {}, today: "2028-01-01" }).length,
    0,
  );
});

test("WIRP: the probability-style reading of a meeting's move", () => {
  assert.equal(describeStep(0.3), "30% chance of a 25bp hike");
  assert.equal(describeStep(-0.874), "87% chance of a 25bp cut");
  assert.equal(describeStep(1.4), "25bp hike priced, 40% chance of 50bp");
  assert.equal(describeStep(-2), "50bp cut priced");
  assert.equal(describeStep(0.002), "No change priced");
});

// ---------- ECST ----------
test("ECST: CPI year on year from index levels, hand-checked", () => {
  const raw = parseFredCsv(fx("fred-CPIAUCNS.csv"));
  // October 2025 is blank on FRED (no CPI was published that month), so it's dropped.
  assert.ok(!raw.some((r) => r.date === "2025-10-01"));
  const y = yoy(raw);
  // Sep 2026 336.940 / Sep 2025 324.800 = +3.738%; Aug 334.980 / 323.976 = +3.396%.
  close(y.at(-1).value, (336.94 / 324.8 - 1) * 100);
  const row = buildRow(
    SERIES.find((s) => s.key === "CPI"),
    raw,
    "2026-10-15",
  );
  assert.deepEqual(
    { value: row.value, prev: row.prev, change: row.change, date: row.date },
    { value: 3.7, prev: 3.4, change: 0.3, date: "2026-09-01" },
  );
});

test("ECST: payrolls are the monthly change in total jobs, and gaps aren't bridged", () => {
  const row = buildRow(
    SERIES.find((s) => s.key === "NFP"),
    parseFredCsv(fx("fred-PAYEMS.csv")),
    "2026-10-15",
  );
  // 159,044 - 159,015 = 29k in September; 159,015 - 158,882 = 133k in August.
  assert.deepEqual(
    { value: row.value, prev: row.prev, change: row.change },
    { value: 29, prev: 133, change: -104 },
  );
  const gap = monthlyDiff([
    { date: "2025-09-01", value: 100 },
    { date: "2025-11-01", value: 130 },
    { date: "2025-12-01", value: 150 },
  ]);
  assert.deepEqual(gap, [{ date: "2025-12-01", value: 20 }]);
});

test("ECST: unemployment is shown as published", () => {
  const row = buildRow(
    SERIES.find((s) => s.key === "UNRATE"),
    parseFredCsv(fx("fred-UNRATE.csv")),
    "2026-10-15",
  );
  assert.deepEqual(
    { value: row.value, prev: row.prev, change: row.change },
    { value: 4.2, prev: 4.1, change: 0.1 },
  );
});

// ---------- CBRT ----------
test("CBRT: last change date and size from the BIS daily series", () => {
  const d = parseBis(fx("bis-cbpol.csv"));
  const us = lastChange(d.US);
  // BIS records the middle of the Fed's range: 3.625 -> 3.875 on 17 Sep 2026, a 25bp hike.
  assert.deepEqual(us, {
    rate: 3.875,
    asOf: "2026-10-13",
    changed: "2026-09-17",
    prev: 3.625,
    changeBp: 25,
  });
  const tr = lastChange(d.TR);
  assert.equal(tr.changeBp, -100);
  assert.equal(tr.rate, 37);
  const gb = lastChange(d.GB);
  assert.equal(gb.changed, "2025-12-18");
  assert.equal(gb.rate, 3.75);
  // A series that never changes says since when.
  assert.deepEqual(
    lastChange([
      ["2026-01-01", 2],
      ["2026-02-01", 2],
    ]),
    {
      rate: 2,
      asOf: "2026-02-01",
      changed: null,
      prev: null,
      changeBp: null,
      since: "2026-01-01",
    },
  );
});

// ---------- COT ----------
test("COT: net positions and week-on-week changes, financial futures", () => {
  const r = cotRow(json("cftc-tff-es.json")[0], "tff");
  assert.equal(r.date, "2026-10-06");
  assert.equal(r.oi, 1932227);
  const [lev, am, dealer] = r.groups;
  assert.equal(lev.net, 113223 - 528310);
  assert.equal(lev.chg, -12230 - 30368);
  assert.equal(am.net, 1106717 - 200102);
  assert.equal(dealer.net, 201165 - 802006);
});

test("COT: the CFTC's change fields match the difference between two weeks (gold)", () => {
  const [now, before] = json("cftc-disagg-gold.json").map((x) =>
    cotRow(x, "dis"),
  );
  assert.equal(now.groups[0].net, 127101 - 16114); // managed money
  for (let i = 0; i < 3; i++)
    assert.equal(now.groups[i].chg, now.groups[i].net - before.groups[i].net);
  assert.equal(now.groups[2].short, 239630); // swap dealers, from the double-underscore field
});

test("COT: market words", () => {
  assert.equal(marketKey("GOLD"), "GOLD");
  assert.equal(marketKey("crude"), "OIL");
  assert.equal(marketKey("SPX"), "ES");
  assert.equal(marketKey("YEN"), "JPY");
  assert.equal(marketKey("XYZ"), null);
});
