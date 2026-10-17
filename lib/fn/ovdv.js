// /api/fn/ovdv?symbol=SPX&expiry=3 : the implied volatility surface of a US stock, ETF or index, built from the
// same CBOE delayed option chain OMON shows (it is OMON's own fetch, parse and one-minute cache, called once
// per expiry). One expiry near each standard tenor (1 week to 1 year), so an index with daily expiries still
// gets a surface that spans the year. For SPX, the VIX family of indices gives the market's own term structure.
import omon, { cboeSymbol } from "./omon.js";
import { lastBar } from "./ct.js";
import { cached, getJson, YAHOO_UA } from "../providers.js";

export const TENORS = [7, 14, 30, 60, 90, 180, 270, 365];
export const MONEYNESS = [80, 90, 95, 100, 105, 110, 120];
export const VIX = [
  { symbol: "^VIX9D", label: "VIX9D", name: "9 days", days: 9 },
  { symbol: "^VIX", label: "VIX", name: "30 days", days: 30 },
  { symbol: "^VIX3M", label: "VIX3M", name: "3 months", days: 91 },
  { symbol: "^VIX6M", label: "VIX6M", name: "6 months", days: 182 },
  { symbol: "^VIX1Y", label: "VIX1Y", name: "1 year", days: 365 },
];
const MIN_DAYS = 2; // the last day or two before expiry gives wild IVs
const fail = (message, status) => Object.assign(new Error(message), { status });
const fin = Number.isFinite;

// One expiry per tenor: the date nearest each target, each date used once, in date order.
// expiries: OMON's list [{ n, date, root, days }]. Same-date duplicates (SPX and SPXW) keep the first.
export function pickTenors(expiries, targets = TENORS, minDays = MIN_DAYS) {
  const byDate = new Map();
  for (const e of expiries)
    if (e.days >= minDays && !byDate.has(e.date)) byDate.set(e.date, e);
  const list = [...byDate.values()];
  const picked = new Map();
  for (const t of targets) {
    if (!list.length) break;
    // Skip tenors far beyond the last listed expiry rather than repeating the last one.
    const best = list.reduce((a, e) =>
      Math.abs(e.days - t) < Math.abs(a.days - t) ? e : a,
    );
    if (Math.abs(best.days - t) <= Math.max(4, t * 0.35))
      picked.set(best.date, best);
  }
  return [...picked.values()].sort((a, b) => a.days - b.days);
}

// The smile: out-of-the-money options only (puts below the spot price, calls at or above it), with a live bid,
// since those are the ones that trade and whose IV means something. IV and moneyness in percent.
export function smilePoints(rows, spot) {
  const out = [];
  for (const r of rows || []) {
    const put = r.strike < spot;
    const q = put ? r.put : r.call;
    if (!q || !(q.bid > 0) || !(q.iv > 0) || q.iv > 5) continue;
    out.push({
      strike: r.strike,
      m: (r.strike / spot) * 100,
      iv: q.iv * 100,
      delta: fin(q.delta) ? q.delta : null,
      side: put ? "put" : "call",
    });
  }
  return out;
}

const lerp = (x, x0, x1, y0, y1) =>
  x1 === x0 ? (y0 + y1) / 2 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0);

// IV at a moneyness (strike as % of spot), straight-line between the two nearest strikes. Null outside.
export function ivAtMoneyness(points, m) {
  const p = [...points].sort((a, b) => a.m - b.m);
  for (let i = 1; i < p.length; i++)
    if (p[i - 1].m <= m && m <= p[i].m)
      return lerp(m, p[i - 1].m, p[i].m, p[i - 1].iv, p[i].iv);
  return null;
}

// IV at a delta: 25-delta put = the put whose delta is -0.25, straight-line between the two puts either side.
// Uses out-of-the-money options with a bid (|delta| below 0.5). Null when no pair brackets the target.
export function ivAtDelta(points, target) {
  const side = target < 0 ? "put" : "call";
  const p = points
    .filter((x) => x.side === side && fin(x.delta) && Math.abs(x.delta) < 0.5)
    .sort((a, b) => a.delta - b.delta);
  for (let i = 1; i < p.length; i++)
    if (p[i - 1].delta <= target && target <= p[i].delta)
      return lerp(target, p[i - 1].delta, p[i].delta, p[i - 1].iv, p[i].iv);
  return null;
}

// One row of the surface for one expiry.
export function surfaceRow(points) {
  const atm = ivAtMoneyness(points, 100);
  const put25 = ivAtDelta(points, -0.25),
    call25 = ivAtDelta(points, 0.25);
  return {
    atm,
    put10: ivAtDelta(points, -0.1),
    put25,
    call25,
    call10: ivAtDelta(points, 0.1),
    skew: fin(put25) && fin(call25) ? put25 - call25 : null,
    byMoneyness: Object.fromEntries(
      MONEYNESS.map((m) => [m, ivAtMoneyness(points, m)]),
    ),
  };
}

// VIX term structure: contango when 30-day VIX is below 3-month VIX (the usual, calm shape), inverted when
// above (near-term fear, usually in a sell-off). `steady` says whether every step up the curve rises.
export function vixShape(rows) {
  const v = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  if (!fin(v.VIX) || !fin(v.VIX3M)) return null;
  const ratio = v.VIX / v.VIX3M;
  const vals = rows.map((r) => r.value).filter(fin);
  const steady = vals.every((x, i) => i === 0 || x >= vals[i - 1]);
  return {
    shape:
      Math.abs(ratio - 1) < 0.005
        ? "flat"
        : ratio < 1
          ? "contango"
          : "inverted",
    ratio,
    steady,
  };
}

// Each index's last close and the date of it (the VIX trades nearly round the clock, the others close daily,
// so they can be a day apart before New York opens).
export function vixRows(spark) {
  return VIX.map((x) => {
    const b = lastBar(spark?.[x.symbol]);
    return {
      ...x,
      value: b ? b.price : null,
      change: b && fin(b.change) ? b.change : null,
      date: b ? b.date : null,
    };
  });
}

async function vixTerm() {
  const path = `/v8/finance/spark?symbols=${encodeURIComponent(VIX.map((x) => x.symbol).join(","))}&range=1mo&interval=1d`;
  const j = await cached("ovdv:vix", 2 * 60e3, () =>
    getJson(`https://query1.finance.yahoo.com${path}`, YAHOO_UA).catch(() =>
      getJson(`https://query2.finance.yahoo.com${path}`, YAHOO_UA),
    ),
  );
  const rows = vixRows(j);
  return { rows, ...vixShape(rows) };
}

export default async function (q) {
  const sym = cboeSymbol(q.symbol);
  if (!sym)
    throw fail(
      "The volatility surface is for US stocks, ETFs and the main US indices. Try SPX INDEX OVDV or AAPL US EQUITY OVDV.",
      400,
    );
  const want = parseInt(q.expiry, 10);
  return cached(`ovdv:${sym.file}:${want || ""}`, 2 * 60e3, async () => {
    const first = await omon({ symbol: sym.ticker, expiry: 1, strikes: "all" });
    const picks = pickTenors(first.expiries);
    if (!picks.length)
      throw fail(
        `${sym.ticker} has no option expiries far enough out for a surface.`,
        404,
      );
    const chains = await Promise.all(
      picks.map((e) =>
        omon({ symbol: sym.ticker, expiry: e.n, strikes: "all" }),
      ),
    );
    const spot = first.price;
    const expiries = chains.map((c) => {
      const pts = smilePoints(c.rows, spot);
      return {
        date: c.expiry.date,
        root: c.expiry.root,
        days: c.expiry.days,
        points: pts.length,
        ...surfaceRow(pts),
        smile: pts,
      };
    });
    if (!expiries.some((e) => fin(e.atm)))
      throw fail(
        `No implied volatility came back for ${sym.ticker}. ${
          /Nasdaq/.test(first.source)
            ? "CBOE didn't answer and the Nasdaq fallback has no IV."
            : chains.every((c) => c.rows.every((r) => !(r.call?.bid > 0) && !(r.put?.bid > 0)))
              ? "CBOE's delayed file has no quotes in it yet: it is blank for the first minutes after the 9:30am New York open, since it runs 15 minutes behind. Try again shortly."
              : "Try again in a minute."
        }`,
        502,
      );
    // The smile shown: the one asked for (1-based), else the one nearest a month out.
    const pick =
      want >= 1 && want <= expiries.length
        ? want - 1
        : expiries.reduce(
            (a, e, i) =>
              Math.abs(e.days - 30) < Math.abs(expiries[a].days - 30) ? i : a,
            0,
          );
    const chosen = expiries[pick];
    // Keep the chart to the strikes that matter: between the 2-delta put and the 2-delta call.
    const smile = chosen.smile.filter(
      (p) => !fin(p.delta) || Math.abs(p.delta) >= 0.02,
    );
    const vix = sym.ticker === "SPX" ? await vixTerm().catch(() => null) : null;
    return {
      symbol: sym.ticker,
      index: sym.index,
      price: spot,
      iv30: first.iv30,
      asOf: first.asOf,
      pick: pick + 1,
      expiries: expiries.map(({ smile: _, ...e }) => e),
      smile: { date: chosen.date, days: chosen.days, points: smile },
      vix,
      source: `${first.source}${vix ? "; VIX indices from Cboe via Yahoo Finance" : ""}`,
    };
  });
}
