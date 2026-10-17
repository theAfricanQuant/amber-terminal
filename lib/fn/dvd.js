// /api/fn/dvd?symbol=AAPL : dividend history, the next ex-date, yield and how often it pays, for US stocks.
// Nasdaq publishes full history (with record and payment dates) for Nasdaq-listed stocks. For NYSE and
// other listings Nasdaq says it has none, so the ex-dates and amounts come from Yahoo's price history.
import {
  getJson,
  cached,
  NQ,
  YAHOO_UA,
  resolve,
  getQuotes,
} from "../providers.js";

const toIso = (mdy) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(mdy || "").trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};
const money = (s) => {
  const v = parseFloat(String(s ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};

export function parseNasdaq(j) {
  const rows = j?.data?.dividends?.rows;
  if (!Array.isArray(rows)) return null;
  return rows
    .map((r) => ({
      exDate: toIso(r.exOrEffDate),
      amount: money(r.amount),
      type: r.type || "Cash",
      declared: toIso(r.declarationDate),
      record: toIso(r.recordDate),
      paid: toIso(r.paymentDate),
      currency: r.currency || "USD",
    }))
    .filter((r) => r.exDate && r.amount != null)
    .sort((a, b) => b.exDate.localeCompare(a.exDate));
}

export function parseYahoo(j) {
  const r = j?.chart?.result?.[0];
  if (!r) return null;
  const off = r.meta?.gmtoffset || 0;
  return Object.values(r.events?.dividends || {})
    .map((d) => ({
      exDate: new Date((d.date + off) * 1000).toISOString().slice(0, 10),
      amount: d.amount,
      type: "Cash",
      currency: r.meta?.currency || "USD",
    }))
    .filter((d) => Number.isFinite(d.amount))
    .sort((a, b) => b.exDate.localeCompare(a.exDate));
}

const FREQ = [
  [45, 12, "Monthly"],
  [120, 4, "Quarterly"],
  [240, 2, "Twice a year"],
  [Infinity, 1, "Once a year"],
];
const days = (a, b) => (Date.parse(a) - Date.parse(b)) / 86400e3;

// history: newest first. today: "YYYY-MM-DD". price: last price in the same currency.
export function summarize(history, price, today) {
  const regular = history.filter(
    (d) => /cash/i.test(d.type) && !/special/i.test(d.type),
  );
  const recent = regular.slice(0, 9);
  const gaps = recent
    .slice(1)
    .map((d, i) => days(recent[i].exDate, d.exDate))
    .sort((a, b) => a - b);
  const gap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null;
  const f = gap == null ? null : FREQ.find(([max]) => gap < max);
  const last = regular[0] || null;
  const next = history.filter((d) => d.exDate > today).at(-1) || null;
  // A payer that has skipped two of its usual payments has probably stopped: don't quote a yield.
  const stopped = !!(last && gap && days(today, last.exDate) > gap * 2 + 15);
  const perYear = f && !stopped ? f[1] : null;
  const indicated = perYear && last ? last.amount * perYear : null;
  const yearAgo = new Date(Date.parse(today) - 365 * 86400e3)
    .toISOString()
    .slice(0, 10);
  const trailing = history
    .filter((d) => d.exDate > yearAgo && d.exDate <= today)
    .reduce((s, d) => s + d.amount, 0);
  return {
    frequency: stopped
      ? "No recent dividend"
      : f
        ? f[2]
        : regular.length
          ? "Not enough history"
          : "Doesn't pay",
    perYear,
    lastAmount: last?.amount ?? null,
    lastExDate: history.find((d) => d.exDate <= today)?.exDate || null,
    nextExDate: next?.exDate || null,
    nextPayDate: next?.paid || null,
    nextAmount: next?.amount ?? null,
    indicatedAnnual: indicated,
    yieldPct: indicated && price ? (indicated / price) * 100 : null,
    trailing12m: trailing || null,
    trailingYieldPct: trailing && price ? (trailing / price) * 100 : null,
  };
}

export const nyToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(
    new Date(),
  );

export default async function (q) {
  const sym = await resolve(q.symbol);
  if (sym.exchange !== "US")
    throw Object.assign(
      new Error(
        "DVD covers US-listed stocks (Nasdaq's and Yahoo's free dividend data).",
      ),
      {
        status: 400,
      },
    );
  const t = sym.ticker;
  const data = await cached(`dvd:${t}`, 3 * 3600e3, async () => {
    const nq = await getJson(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(t)}/dividends?assetclass=stocks`,
      NQ,
    ).catch(() => null);
    let history = parseNasdaq(nq);
    let from = "Nasdaq dividend history";
    if (!history?.length) {
      const y = await getJson(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=10y&events=div`,
        YAHOO_UA,
      ).catch(() => null);
      history = parseYahoo(y) || [];
      from =
        "Yahoo Finance dividend events (ex-dates and amounts; Nasdaq only publishes history for Nasdaq-listed stocks)";
    }
    return { history, from };
  });
  const quotes = await getQuotes([sym.id]).catch(() => ({}));
  const price = quotes[sym.id]?.price || null;
  return {
    symbol: t,
    price,
    ...summarize(data.history, price, nyToday()),
    history: data.history.slice(0, 60),
    source: `${data.from}. Yield = latest regular dividend x payments a year / live price (Nasdaq)`,
  };
}
