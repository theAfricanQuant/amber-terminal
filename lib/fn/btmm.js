// /api/fn/btmm : US money markets. Overnight rates (SOFR, EFFR with the Fed's target range, OBFR) from the
// New York Fed's Markets API, published about 8 to 9am New York time for the previous business day.
// Treasury bill yields and the 2- and 10-year notes from the Treasury's daily tables (each evening).
// If the New York Fed doesn't answer, the same rates come from FRED.
import { getJson, cached } from "../providers.js";
import { treasuryRows, round } from "./gc.js";
import { fredSeries } from "./ecst.js";

const NYFED = "https://markets.newyorkfed.org/api/rates";
export const FUNDING = [
  {
    key: "SOFR",
    path: "secured/sofr",
    fred: "SOFR",
    name: "SOFR",
    what: "Secured overnight financing rate: the cost of borrowing cash overnight against Treasuries",
  },
  {
    key: "EFFR",
    path: "unsecured/effr",
    fred: "EFFR",
    name: "Fed funds (EFFR)",
    what: "What banks pay each other overnight; the Fed steers it inside its target range",
  },
  {
    key: "OBFR",
    path: "unsecured/obfr",
    fred: "OBFR",
    name: "Overnight bank funding (OBFR)",
    what: "Fed funds plus overnight eurodollar borrowing by US banks",
  },
];

// NY Fed { refRates: [...] } -> latest, previous and the change in basis points.
export function nyfedRow(json) {
  const list = (json?.refRates || [])
    .filter((r) => Number.isFinite(+r.percentRate))
    .sort((a, b) => (a.effectiveDate < b.effectiveDate ? 1 : -1));
  const [a, b] = list;
  if (!a) return null;
  return {
    rate: +a.percentRate,
    date: a.effectiveDate,
    prev: b ? +b.percentRate : null,
    prevDate: b?.effectiveDate ?? null,
    changeBp: b ? round((a.percentRate - b.percentRate) * 100, 0) : null,
    targetFrom: a.targetRateFrom != null ? +a.targetRateFrom : null,
    targetTo: a.targetRateTo != null ? +a.targetRateTo : null,
  };
}

// FRED rows -> the same shape (no target range there).
function fredRow(rows) {
  const [b, a] = rows.slice(-2);
  if (!a) return null;
  return {
    rate: a.value,
    date: a.date,
    prev: b.value,
    prevDate: b.date,
    changeBp: round((a.value - b.value) * 100, 0),
  };
}

// The last two days a Treasury column has a value: latest, previous, change in basis points.
export function dayRow(rows, key) {
  const have = rows.filter((r) => r.values[key] != null);
  const a = have.at(-1),
    b = have.at(-2);
  if (!a) return null;
  return {
    rate: a.values[key],
    date: a.date,
    prev: b ? b.values[key] : null,
    prevDate: b?.date ?? null,
    changeBp: b ? round((a.values[key] - b.values[key]) * 100, 0) : null,
  };
}

export async function funding(f) {
  try {
    return {
      ...nyfedRow(
        await cached(`nyfed:${f.key}`, 15 * 60e3, () =>
          getJson(`${NYFED}/${f.path}/last/2.json`),
        ),
      ),
      from: "New York Fed",
    };
  } catch {
    const year = new Date().getUTCFullYear();
    const row = fredRow(await fredSeries(f.fred, `${year - 1}-01-01`));
    if (!row) throw new Error(`No ${f.name} data`);
    return { ...row, from: "FRED" };
  }
}

const BILLS = [
  ["4W", "4-week bill"],
  ["13W", "13-week (3-month) bill"],
  ["26W", "26-week (6-month) bill"],
  ["52W", "52-week (1-year) bill"],
];
const NOTES = [
  ["2Y", "2-year note"],
  ["10Y", "10-year note"],
];

export default async function () {
  const [fund, bills, curve] = await Promise.all([
    Promise.all(
      FUNDING.map((f) => funding(f).catch((e) => ({ error: e.message }))),
    ),
    treasuryRows("daily_treasury_bill_rates").catch((e) => ({
      error: e.message,
    })),
    treasuryRows("daily_treasury_yield_curve").catch((e) => ({
      error: e.message,
    })),
  ]);
  const effr = fund[1];
  const fundingRows = FUNDING.map((f, i) => ({
    key: f.key,
    name: f.name,
    what: f.what,
    ...fund[i],
    note:
      f.key === "EFFR" && effr.targetFrom != null
        ? `Fed target range ${effr.targetFrom.toFixed(2)}% to ${effr.targetTo.toFixed(2)}%`
        : fund[i].from === "FRED"
          ? "From FRED (the New York Fed didn't answer)"
          : "",
  }));
  const tsyRows = (rows, list) =>
    list.map(([k, name]) => ({
      key: k,
      name,
      ...(rows.error
        ? { error: rows.error }
        : dayRow(rows, k) || { error: "No data" }),
    }));
  if (fundingRows.every((r) => r.error) && bills.error && curve.error)
    throw Object.assign(
      new Error(
        "Neither the New York Fed nor the US Treasury sent data. Check your internet connection and try again in a minute.",
      ),
      { status: 502, upstream: true },
    );
  return {
    funding: fundingRows,
    target:
      effr.targetFrom != null
        ? { from: effr.targetFrom, to: effr.targetTo }
        : null,
    bills: tsyRows(bills, BILLS),
    notes: tsyRows(curve, NOTES),
    source:
      "New York Fed reference rates (published each morning for the previous business day); US Treasury bill and par yields (each evening)",
  };
}
