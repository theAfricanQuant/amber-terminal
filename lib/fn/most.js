// /api/fn/most : the day's most active US stocks, biggest gainers and biggest losers.
// Nasdaq's market movers (real time in the session; before the open it shows the last session), and the
// Nasdaq stock screener ranked the same way when the movers don't answer.
import { getJson, cached, NQ, nasdaqScreener } from "../providers.js";

const num = (s) => {
  if (s == null) return null;
  const v = parseFloat(String(s).replace(/[$,%+\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};

// One row of a movers table. The "change" column is share volume or % change, depending on the table.
export function parseRow(r, kind) {
  const price = num(r.lastSalePrice);
  const change = num(r.lastSaleChange);
  const prev = price != null && change != null ? price - change : null;
  return {
    ticker: String(r.symbol || "").trim(),
    name: String(r.name || "").trim(),
    price,
    change,
    changePct:
      kind === "volume"
        ? prev > 0
          ? (change / prev) * 100
          : null
        : num(r.change),
    volume: kind === "volume" ? Math.round(num(r.change) || 0) : null,
  };
}

// Warrants, rights and units (Nasdaq's fifth-letter W, R and U) and sub-$1 shares crowd the raw lists.
export const isJunk = (r) =>
  !(r.price >= 1) ||
  /^[A-Z]{4}[WRU]$/.test(r.ticker) ||
  /\b(warrants?|rights?|units?)\b/i.test(r.name);

const clean = (rows) => {
  const seen = new Set();
  return rows.filter(
    (r) => r.ticker && !isJunk(r) && !seen.has(r.ticker) && seen.add(r.ticker),
  );
};

// Nasdaq's market movers -> sections for each tab.
export function parseMovers(j) {
  const s = j?.data?.STOCKS;
  if (!s) return null;
  const list = (key, kind) =>
    (s[key]?.table?.rows || []).map((r) => parseRow(r, kind));
  const ndx = list("Nasdaq100Movers", "pct").filter((r) => r.changePct != null);
  const up = [...ndx]
    .sort((a, b) => b.changePct - a.changePct)
    .filter((r) => r.changePct > 0)
    .slice(0, 10);
  const down = [...ndx]
    .sort((a, b) => a.changePct - b.changePct)
    .filter((r) => r.changePct < 0)
    .slice(0, 10);
  const tabs = {
    VOLUME: [
      {
        title: "Most shares traded, US stocks $1 and over",
        rows: clean(list("MostActiveByShareVolume", "volume")),
      },
      {
        title: "Most money traded",
        rows: clean(list("MostActiveByDollarVolume", "pct")),
      },
    ],
    GAINERS: [
      {
        title: "Biggest gains, US stocks $1 and over",
        rows: clean(list("MostAdvanced", "pct")),
      },
      { title: "Biggest gains in the Nasdaq 100", rows: up },
    ],
    LOSERS: [
      {
        title: "Biggest falls, US stocks $1 and over",
        rows: clean(list("MostDeclined", "pct")),
      },
      { title: "Biggest falls in the Nasdaq 100", rows: down },
    ],
  };
  const asOf =
    s.MostActiveByShareVolume?.dataAsOf || s.MostAdvanced?.dataAsOf || null;
  const any = Object.values(tabs).some((secs) =>
    secs.some((x) => x.rows.length),
  );
  return any
    ? { tabs, asOf: asOf ? asOf.replace(/^Data as of /, "") : null }
    : null;
}

// The fallback: the screener's companies over $300M, ranked by volume and by % change.
export function fromScreener(rows) {
  const big = rows
    .filter((r) => (r.marketCap || 0) > 3e8)
    .map((r) => ({
      ticker: r.ticker,
      name: r.name,
      price: r.price,
      change: null,
      changePct: r.changePct,
      volume: r.volume,
      marketCap: r.marketCap,
      sector: r.sector,
    }));
  const top = (cmp) => [...big].sort(cmp).slice(0, 50);
  return {
    VOLUME: [
      {
        title: "Most shares traded, companies over $300M",
        rows: top((a, b) => (b.volume || 0) - (a.volume || 0)),
      },
    ],
    GAINERS: [
      {
        title: "Biggest gains, companies over $300M",
        rows: top((a, b) => (b.changePct || 0) - (a.changePct || 0)),
      },
    ],
    LOSERS: [
      {
        title: "Biggest falls, companies over $300M",
        rows: top((a, b) => (a.changePct || 0) - (b.changePct || 0)),
      },
    ],
  };
}

// Market movers first, the screener when they fail. Not cached; the default export caches it.
export async function loadMost() {
  try {
    const m = parseMovers(
      await getJson("https://api.nasdaq.com/api/marketmovers?assetclass=stocks&exchangestatus=currentMarket&limit=100", NQ),
    );
    if (!m) throw new Error("Nasdaq's market movers came back empty");
    return {
      tabs: m.tabs,
      asOf: m.asOf,
      source: `Nasdaq market movers, real time in the session${m.asOf ? ` (data as of ${m.asOf})` : ""}`,
    };
  } catch (e) {
    const rows = await nasdaqScreener("stocks").catch(() => []);
    if (!rows.length)
      throw Object.assign(new Error(`Market movers couldn't be loaded (${e.message}). Try again in a minute.`), { status: 502 });
    return {
      tabs: fromScreener(rows),
      asOf: null,
      source: "Nasdaq stock screener, last close with live prices for the biggest names (market movers didn't answer)",
    };
  }
}

export default async function () {
  return cached("most", 60e3, loadMost);
}
