// /api/fn/ecst : the main US economic statistics from FRED (St. Louis Fed), keyless CSV, one series per request.
// Where FRED gives an index level (CPI, core PCE) or a total (payrolls), the year-on-year change or the
// monthly change is worked out here. Values are rounded to the precision the agencies publish before the
// change is taken, so the change always matches the two numbers shown.
import { cached } from "../providers.js";
import {
  fetchText,
  parseCsv,
  toNum,
  round,
  shiftMonths,
  nyToday,
} from "./gc.js";

const FRED = "https://fred.stlouisfed.org/graph/fredgraph.csv";

// FRED CSV -> [{ date, value }], oldest first, blank observations dropped.
export function parseFredCsv(text) {
  const [, ...rows] = parseCsv(text);
  return rows
    .map(([date, v]) => ({ date: (date || "").trim(), value: toNum(v) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.value != null);
}

// One FRED series from a start date. FRED once sent an empty 200 body, so an empty answer is retried once.
export function fredSeries(id, start) {
  return cached(`fred:${id}:${start}`, 6 * 3600e3, async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const rows = parseFredCsv(
        await fetchText(`${FRED}?id=${encodeURIComponent(id)}&cosd=${start}`, {
          what: "FRED (St. Louis Fed)",
        }),
      );
      if (rows.length) return rows;
    }
    throw Object.assign(
      new Error(`FRED sent no data for ${id}. Try again in a minute.`),
      { status: 502, upstream: true },
    );
  });
}

// Year-on-year % change from levels: each month against the same month a year earlier (exact date match).
export function yoy(rows) {
  const at = new Map(rows.map((r) => [r.date, r.value]));
  return rows
    .map((r) => {
      const base = at.get(shiftMonths(r.date, -12));
      return base ? { date: r.date, value: (r.value / base - 1) * 100 } : null;
    })
    .filter(Boolean);
}

// Change from the previous observation (payrolls: jobs added in the month). Skips across gaps honestly:
// a month missing from FRED leaves no change for the month after it.
export function monthlyDiff(rows) {
  const out = [];
  for (let i = 1; i < rows.length; i++)
    if (shiftMonths(rows[i - 1].date, 1) === rows[i].date)
      out.push({
        date: rows[i].date,
        value: rows[i].value - rows[i - 1].value,
      });
  return out;
}

// how: level | yoy | diff. dp: decimals the agency publishes. change: "pts" (percentage points), "bp", "k" or "pts".
export const SERIES = [
  {
    key: "CPI",
    id: "CPIAUCNS",
    name: "CPI inflation, year on year",
    how: "yoy",
    unit: "%",
    dp: 1,
    freq: "M",
    change: "pts",
    note: "Worked out here from the CPI-U index level (CPIAUCNS, not seasonally adjusted, as the BLS headline is).",
  },
  {
    key: "CORECPI",
    id: "CPILFENS",
    name: "Core CPI (no food or energy), year on year",
    how: "yoy",
    unit: "%",
    dp: 1,
    freq: "M",
    change: "pts",
    note: "Worked out here from the core CPI index level (CPILFENS, not seasonally adjusted, as the BLS headline is).",
  },
  {
    key: "COREPCE",
    id: "PCEPILFE",
    name: "Core PCE prices, year on year (the Fed's target measure)",
    how: "yoy",
    unit: "%",
    dp: 1,
    freq: "M",
    change: "pts",
    note: "Worked out here from the core PCE price index level (PCEPILFE, seasonally adjusted, as BEA reports it).",
  },
  {
    key: "UNRATE",
    id: "UNRATE",
    name: "Unemployment rate",
    how: "level",
    unit: "%",
    dp: 1,
    freq: "M",
    change: "pts",
    note: "As published by the BLS (UNRATE).",
  },
  {
    key: "NFP",
    id: "PAYEMS",
    name: "Nonfarm payrolls, jobs added in the month",
    how: "diff",
    unit: "k",
    dp: 0,
    freq: "M",
    change: "k",
    note: "Worked out here as the change in total nonfarm jobs (PAYEMS, thousands, seasonally adjusted).",
  },
  {
    key: "GDP",
    id: "A191RL1Q225SBEA",
    name: "Real GDP growth, quarter on quarter, annualised",
    how: "level",
    unit: "%",
    dp: 1,
    freq: "Q",
    change: "pts",
    note: "As published by BEA (A191RL1Q225SBEA).",
  },
  {
    key: "UST10",
    id: "DGS10",
    name: "10-year Treasury yield",
    how: "level",
    unit: "%",
    dp: 2,
    freq: "D",
    change: "bp",
    note: "Daily close, from the Treasury via FRED (DGS10).",
  },
  {
    key: "UST2",
    id: "DGS2",
    name: "2-year Treasury yield",
    how: "level",
    unit: "%",
    dp: 2,
    freq: "D",
    change: "bp",
    note: "Daily close, from the Treasury via FRED (DGS2).",
  },
  {
    key: "FF",
    id: "DFF",
    name: "Fed funds effective rate",
    how: "level",
    unit: "%",
    dp: 2,
    freq: "D",
    change: "bp",
    note: "Daily, from the New York Fed via FRED (DFF).",
  },
  {
    key: "SENT",
    id: "UMCSENT",
    name: "Consumer sentiment (University of Michigan)",
    how: "level",
    unit: "index",
    dp: 1,
    freq: "M",
    change: "pts",
    note: "Index, 1966 = 100 (UMCSENT). FRED posts it about a month after the survey.",
  },
];

// Raw FRED rows -> the row the screen shows, plus its history for the chart.
export function buildRow(s, raw, today = nyToday()) {
  const series =
    s.how === "yoy" ? yoy(raw) : s.how === "diff" ? monthlyDiff(raw) : raw;
  const shown = series.map((r) => ({
    date: r.date,
    value: round(r.value, s.dp),
  }));
  const last = shown.at(-1),
    prev = shown.at(-2);
  const diff = last && prev ? last.value - prev.value : null;
  const keepFrom = shiftMonths(today, s.freq === "D" ? -60 : -120);
  return {
    key: s.key,
    id: s.id,
    name: s.name,
    unit: s.unit,
    dp: s.dp,
    freq: s.freq,
    changeIn: s.change,
    note: s.note,
    value: last?.value ?? null,
    date: last?.date ?? null,
    prev: prev?.value ?? null,
    prevDate: prev?.date ?? null,
    change:
      diff == null
        ? null
        : s.change === "bp"
          ? round(diff * 100, 0)
          : round(diff, s.dp),
    history: shown.filter((r) => r.date >= keepFrom),
  };
}

export default async function () {
  const year = +nyToday().slice(0, 4);
  const rows = await Promise.all(
    SERIES.map(async (s) => {
      // Daily series: 6 years back. Monthly and quarterly: 11, so the 10-year chart has its year-on-year base.
      const start = `${year - (s.freq === "D" ? 6 : 11)}-01-01`;
      try {
        return buildRow(s, await fredSeries(s.id, start));
      } catch (e) {
        return {
          key: s.key,
          id: s.id,
          name: s.name,
          note: s.note,
          error: e.message,
          history: [],
        };
      }
    }),
  );
  if (rows.every((r) => r.error))
    throw Object.assign(
      new Error(
        `FRED didn't send any statistics (${rows[0].error}) Try again in a few minutes.`,
      ),
      { status: 502, upstream: true },
    );
  return {
    rows,
    notFree:
      "The ISM manufacturing index isn't here: ISM licenses it, and FRED no longer carries it.",
    source:
      "FRED, St. Louis Fed (data from BLS, BEA, the Treasury, the Fed and the University of Michigan), updated on each release",
  };
}
