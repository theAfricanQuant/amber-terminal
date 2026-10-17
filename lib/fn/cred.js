// /api/fn/cred : credit spreads. The ICE BofA option-adjusted spreads on FRED's keyless fredgraph.csv: how much
// more than Treasuries a basket of company bonds yields, after taking out the value of any call option.
// These are index spreads (thousands of bonds averaged), not single bonds and not credit default swaps.
// FRED posts each day's value the next business day, around 10:30am Central (11:30am New York): seen on
// 14 Oct 2026, when the 13 Oct value was posted at 10:26am CDT.
import { fredSeries } from "./ecst.js";
import { round, shiftDays, shiftMonths, onOrBefore, nyToday } from "./gc.js";

export const SERIES = [
  {
    key: "IG",
    id: "BAMLC0A0CM",
    name: "US investment grade",
    what: "US company bonds rated BBB- or better",
  },
  {
    key: "BBB",
    id: "BAMLC0A4CBBB",
    name: "US BBB",
    what: "the lowest investment-grade rating, one step above junk",
  },
  {
    key: "HY",
    id: "BAMLH0A0HYM2",
    name: "US high yield",
    what: "US company bonds rated below BBB-, also called junk bonds",
  },
  {
    key: "CCC",
    id: "BAMLH0A3HYC",
    name: "US CCC and lower",
    what: "the riskiest high-yield bonds",
  },
  {
    key: "EHY",
    id: "BAMLHE00EHYIOAS",
    name: "Euro high yield",
    what: "high-yield company bonds issued in euros",
  },
];

// Where today's value sits in the past year: the share of earlier days (within a year) when it was lower.
// Ties count half. 100 = the widest in a year, 0 = the tightest.
export function percentile(rows, latest = rows.at(-1)) {
  if (!latest) return null;
  const from = shiftMonths(latest.date, -12);
  const past = rows.filter((r) => r.date >= from && r.date < latest.date);
  if (!past.length) return null;
  let below = 0;
  for (const r of past)
    below += r.value < latest.value ? 1 : r.value === latest.value ? 0.5 : 0;
  return (below / past.length) * 100;
}

// Monday to Friday days after `from`, up to and including `to`.
export function businessDaysBetween(from, to) {
  let n = 0;
  for (let d = shiftDays(from, 1); d <= to; d = shiftDays(d, 1)) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

// rows: FRED observations in percent, oldest first -> one table row, spreads and changes in basis points.
export function spreadRow(s, rows, today = nyToday()) {
  const last = rows.at(-1);
  if (!last) return { ...s, error: "No data" };
  const bp = (v) => round(v * 100, 0);
  const chg = (back) => {
    const r = onOrBefore(rows, back);
    return r ? round((last.value - r.value) * 100, 0) : null;
  };
  const year = rows.filter((r) => r.date >= shiftMonths(last.date, -12));
  return {
    key: s.key,
    id: s.id,
    name: s.name,
    what: s.what,
    date: last.date,
    bp: bp(last.value),
    chg1w: chg(shiftDays(last.date, -7)),
    chg1m: chg(shiftMonths(last.date, -1)),
    chg1y: chg(shiftMonths(last.date, -12)),
    pctile: round(percentile(rows, last), 0),
    low1y: bp(Math.min(...year.map((r) => r.value))),
    high1y: bp(Math.max(...year.map((r) => r.value))),
    behind: businessDaysBetween(last.date, today),
    history: rows.map((r) => ({ date: r.date, bp: bp(r.value) })),
  };
}

export default async function () {
  const today = nyToday();
  // Three years: the one-year maths needs a year and a bit; the chart shows all of it.
  const start = shiftMonths(today, -36);
  const rows = await Promise.all(
    SERIES.map(async (s) => {
      try {
        return spreadRow(s, await fredSeries(s.id, start), today);
      } catch (e) {
        return {
          key: s.key,
          id: s.id,
          name: s.name,
          what: s.what,
          error: e.message,
        };
      }
    }),
  );
  if (rows.every((r) => r.error))
    throw Object.assign(
      new Error(
        "FRED (St. Louis Fed) didn't send any credit spreads. Try again in a minute.",
      ),
      { status: 502, upstream: true },
    );
  return {
    today,
    rows,
    source:
      "ICE BofA option-adjusted spread indices via FRED (St. Louis Fed). Daily, posted the next business day around 11:30am New York time",
  };
}
