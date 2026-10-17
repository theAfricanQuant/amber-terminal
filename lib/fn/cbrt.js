// /api/fn/cbrt : policy rates of the main central banks, from the Bank for International Settlements'
// WS_CBPOL dataset (daily series, collected from each central bank, usually a few days behind).
// The date and size of each bank's last move are found by walking its daily history back to the last change.
// The Fed row adds today's target range from the New York Fed. If BIS doesn't answer, the ECB, the Bank of
// England and the Fed come straight from their own sources.
import { getJson, cached } from "../providers.js";
import { fetchText, parseCsv, toNum, round } from "./gc.js";

export const BANKS = [
  {
    area: "US",
    bank: "Federal Reserve",
    country: "United States",
    note: "BIS shows the middle of the target range",
  },
  {
    area: "XM",
    bank: "European Central Bank",
    country: "Euro area",
    note: "Deposit facility rate",
  },
  {
    area: "GB",
    bank: "Bank of England",
    country: "United Kingdom",
    note: "Bank Rate",
  },
  {
    area: "JP",
    bank: "Bank of Japan",
    country: "Japan",
    note: "Target for the overnight call rate",
  },
  {
    area: "CH",
    bank: "Swiss National Bank",
    country: "Switzerland",
    note: "SNB policy rate",
  },
  {
    area: "CA",
    bank: "Bank of Canada",
    country: "Canada",
    note: "Overnight rate target",
  },
  {
    area: "AU",
    bank: "Reserve Bank of Australia",
    country: "Australia",
    note: "Cash rate target",
  },
  {
    area: "NZ",
    bank: "Reserve Bank of New Zealand",
    country: "New Zealand",
    note: "Official cash rate",
  },
  {
    area: "SE",
    bank: "Sveriges Riksbank",
    country: "Sweden",
    note: "Policy rate",
  },
  { area: "NO", bank: "Norges Bank", country: "Norway", note: "Deposit rate" },
  {
    area: "CN",
    bank: "People's Bank of China",
    country: "China",
    note: "1-year loan prime rate",
  },
  {
    area: "IN",
    bank: "Reserve Bank of India",
    country: "India",
    note: "Repo rate",
  },
  {
    area: "KR",
    bank: "Bank of Korea",
    country: "South Korea",
    note: "Base rate",
  },
  {
    area: "ID",
    bank: "Bank Indonesia",
    country: "Indonesia",
    note: "7-day reverse repo rate",
  },
  {
    area: "BR",
    bank: "Central Bank of Brazil",
    country: "Brazil",
    note: "Selic target",
  },
  {
    area: "MX",
    bank: "Bank of Mexico",
    country: "Mexico",
    note: "Overnight interbank target",
  },
  {
    area: "ZA",
    bank: "South African Reserve Bank",
    country: "South Africa",
    note: "Repo rate",
  },
  {
    area: "TR",
    bank: "Central Bank of Turkey",
    country: "Turkey",
    note: "1-week repo rate",
  },
];

const START = "2019-01-01";
const bisUrl = () =>
  `https://stats.bis.org/api/v1/data/WS_CBPOL/D.${BANKS.map((b) => b.area).join("+")}/all?startPeriod=${START}&detail=dataonly&format=csv`;

// BIS CSV (FREQ,REF_AREA,TIME_PERIOD,OBS_VALUE) -> { AREA: [[date, value]] } oldest first, gaps dropped.
export function parseBis(text) {
  const [head = [], ...rows] = parseCsv(text);
  const col = (n) => head.findIndex((h) => h.trim() === n);
  const [a, t, v] = [col("REF_AREA"), col("TIME_PERIOD"), col("OBS_VALUE")];
  const out = {};
  for (const r of rows) {
    const value = toNum(r[v]);
    if (value == null || !/^\d{4}-\d{2}-\d{2}$/.test(r[t])) continue;
    (out[r[a]] ||= []).push([r[t], value]);
  }
  for (const k in out) out[k].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  return out;
}

// [[date, value]] -> latest rate, its date, and the last day it changed (the day the new rate took effect).
export function lastChange(series) {
  if (!series?.length) return null;
  const [asOf, rate] = series.at(-1);
  for (let i = series.length - 1; i > 0; i--)
    if (series[i][1] !== series[i - 1][1])
      return {
        rate,
        asOf,
        changed: series[i][0],
        prev: series[i - 1][1],
        changeBp: round((series[i][1] - series[i - 1][1]) * 100, 0),
      };
  return {
    rate,
    asOf,
    changed: null,
    prev: null,
    changeBp: null,
    since: series[0][0],
  };
}

async function fedTarget() {
  const j = await cached("nyfed:effr1", 15 * 60e3, () =>
    getJson(
      "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json",
    ),
  );
  const r = j.refRates[0];
  return {
    from: +r.targetRateFrom,
    to: +r.targetRateTo,
    date: r.effectiveDate,
  };
}

// Fallback: the ECB deposit rate, Bank Rate and the Fed's range, each from the bank itself.
async function fallback(err) {
  const [ecb, boe, fed] = await Promise.all([
    fetchText(
      `https://data-api.ecb.europa.eu/service/data/FM/D.U2.EUR.4F.KR.DFR.LEV?startPeriod=${START}&format=csvdata&detail=dataonly`,
      { what: "The ECB" },
    )
      .then((t) => {
        const [h, ...r] = parseCsv(t);
        const [ti, vi] = [h.indexOf("TIME_PERIOD"), h.indexOf("OBS_VALUE")];
        return r.map((x) => [x[ti], toNum(x[vi])]).filter(([, v]) => v != null);
      })
      .catch(() => null),
    fetchText(
      `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=01/Jan/2019&Dateto=now&SeriesCodes=IUDBEDR&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`,
      { what: "The Bank of England" },
    )
      .then((t) =>
        parseCsv(t)
          .slice(1)
          .map(([d, v]) => [
            new Date(`${d} UTC`).toISOString().slice(0, 10),
            toNum(v),
          ])
          .filter(([, v]) => v != null)
          .sort((x, y) => (x[0] < y[0] ? -1 : 1)),
      )
      .catch(() => null),
    fedTarget().catch(() => null),
  ]);
  const rows = [];
  if (fed)
    rows.push({
      ...BANKS[0],
      rate: (fed.from + fed.to) / 2,
      asOf: fed.date,
      target: fed,
      changed: null,
    });
  if (ecb?.length) rows.push({ ...BANKS[1], ...lastChange(ecb) });
  if (boe?.length) rows.push({ ...BANKS[2], ...lastChange(boe) });
  if (!rows.length)
    throw Object.assign(
      new Error(
        `The BIS didn't send policy rates (${err.message}), and the ECB, Bank of England and New York Fed didn't either. Try again in a few minutes.`,
      ),
      { status: 502, upstream: true },
    );
  return rows;
}

export default async function () {
  let rows,
    partial = false;
  try {
    const data = await cached("bis:cbpol", 12 * 3600e3, async () =>
      parseBis(
        await fetchText(bisUrl(), {
          what: "The BIS (Bank for International Settlements)",
          timeout: 30000,
        }),
      ),
    );
    rows = BANKS.map((b) => ({
      ...b,
      ...(lastChange(data[b.area]) || { error: "No data from BIS" }),
    }));
    const fed = await fedTarget().catch(() => null);
    if (fed) rows[0].target = fed;
  } catch (e) {
    rows = await fallback(e);
    partial = true;
  }
  return {
    rows,
    partial,
    source: partial
      ? "ECB, Bank of England and New York Fed directly (the BIS didn't answer)"
      : "BIS central bank policy rates (from each central bank, a few days behind); Fed target range from the New York Fed",
  };
}
