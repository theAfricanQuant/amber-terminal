// /api/fn/eqs?sector=Technology&capMin=10B&sort=marketCap : the equity screener. Filters Nasdaq's list of
// every US-listed stock (about 7,000) here on your machine, so the browser only gets the rows it shows.
import { nasdaqScreener } from "../providers.js";

export const MAX_ROWS = 200;
const SORTS = [
  "ticker",
  "name",
  "price",
  "changePct",
  "volume",
  "marketCap",
  "sector",
  "country",
];

// Words you can type after EQS. Each sets some of the form's fields.
export const PRESETS = {
  MEGA: { capMin: 200e9 },
  LARGE: { capMin: 10e9 },
  MID: { capMin: 2e9, capMax: 10e9 },
  SMALL: { capMin: 300e6, capMax: 2e9 },
  MICRO: { capMax: 300e6 },
  TECH: { sector: "Technology" },
  FINANCE: { sector: "Finance" },
  HEALTH: { sector: "Health Care" },
  ENERGY: { sector: "Energy" },
  INDUSTRIALS: { sector: "Industrials" },
  UTILITIES: { sector: "Utilities" },
  STAPLES: { sector: "Consumer Staples" },
  DISCRETIONARY: { sector: "Consumer Discretionary" },
  MATERIALS: { sector: "Basic Materials" },
  TELECOM: { sector: "Telecommunications" },
  REALESTATE: { sector: "Real Estate" },
  US: { country: "United States" },
  GAINERS: {
    sort: "changePct",
    dir: "desc",
    chgMin: 0,
    priceMin: 5,
    capMin: 300e6,
  },
  LOSERS: {
    sort: "changePct",
    dir: "asc",
    chgMax: 0,
    priceMin: 5,
    capMin: 300e6,
  },
  ACTIVE: { sort: "volume", dir: "desc" },
};

// "10B", "500M", "2.5K", "1,000" -> a number. Blank -> null.
export function amount(v) {
  if (v == null || v === "") return null;
  const m = /^\s*(-?[\d,]*\.?\d+)\s*([KMBT])?\s*$/i.exec(String(v));
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const mult =
    { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[(m[2] || "").toUpperCase()] || 1;
  return n * mult;
}

// Query and preset words -> one filter object.
export function filtersFrom(q = {}) {
  const f = {};
  for (const w of String(q.preset || "")
    .toUpperCase()
    .split(/[\s,]+/)
    .filter(Boolean))
    Object.assign(f, PRESETS[w] || {});
  for (const k of [
    "capMin",
    "capMax",
    "priceMin",
    "priceMax",
    "chgMin",
    "chgMax",
    "volMin",
  ]) {
    const v = amount(q[k]);
    if (v != null) f[k] = v;
  }
  for (const k of ["sector", "country"]) if (q[k]) f[k] = String(q[k]);
  if (SORTS.includes(q.sort)) f.sort = q.sort;
  if (q.dir === "asc" || q.dir === "desc") f.dir = q.dir;
  f.sort ||= "marketCap";
  f.dir ||= ["ticker", "name", "sector", "country"].includes(f.sort)
    ? "asc"
    : "desc";
  return f;
}

const within = (v, lo, hi) =>
  (lo == null || v >= lo) && (hi == null || v <= hi);

export function screen(rows, f) {
  const hit = rows.filter(
    (r) =>
      (!f.sector || r.sector === f.sector) &&
      (!f.country || r.country === f.country) &&
      // A stock with no market cap on file can't pass a market-cap filter.
      (f.capMin == null && f.capMax == null
        ? true
        : r.marketCap > 0 && within(r.marketCap, f.capMin, f.capMax)) &&
      within(r.price, f.priceMin, f.priceMax) &&
      within(r.changePct, f.chgMin, f.chgMax) &&
      (f.volMin == null || r.volume >= f.volMin),
  );
  const k = f.sort || "marketCap";
  const sign = f.dir === "asc" ? 1 : -1;
  hit.sort((a, b) => {
    const x = a[k],
      y = b[k];
    const c =
      typeof x === "string" || typeof y === "string"
        ? String(x ?? "").localeCompare(String(y ?? ""))
        : (x ?? 0) - (y ?? 0);
    return c * sign || a.ticker.localeCompare(b.ticker);
  });
  return { total: hit.length, rows: hit.slice(0, MAX_ROWS) };
}

// The sectors and countries in the list, most common first, for the form's drop-downs.
export function facets(rows) {
  const count = (k) => {
    const m = new Map();
    for (const r of rows) if (r[k]) m.set(r[k], (m.get(r[k]) || 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  };
  return { sectors: count("sector"), countries: count("country") };
}

export default async function (q) {
  const all = await nasdaqScreener("stocks");
  const f = filtersFrom(q);
  const { total, rows } = screen(all, f);
  return {
    filters: f,
    universe: all.length,
    total,
    rows: rows.map(
      ({
        ticker,
        name,
        price,
        changePct,
        volume,
        marketCap,
        sector,
        industry,
        country,
        live,
      }) => ({
        ticker,
        name: name.trim(),
        price,
        changePct,
        volume,
        marketCap,
        sector,
        industry,
        country,
        live,
      }),
    ),
    ...facets(all),
    source:
      "Nasdaq stock screener, every US-listed stock. The 200 largest carry live quotes; the rest are as of the last close",
  };
}
