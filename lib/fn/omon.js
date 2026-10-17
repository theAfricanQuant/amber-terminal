// /api/fn/omon?symbol=AAPL&expiry=2&strikes=all : the option chain for one expiry of a US stock, ETF or index.
// CBOE's free delayed quotes file (every expiry, with IV, delta and open interest, about 15 minutes behind),
// and Nasdaq's option chain when CBOE doesn't answer (stocks and ETFs only, no IV or delta).
import { getJson, cached, NQ } from "../providers.js";

const CBOE = "https://cdn.cboe.com/api/global/delayed_quotes/options/";
const NEAR = 15; // strikes either side of the money by default

// The terminal names indices by Yahoo symbol (SPX is ^GSPC). CBOE files index options under _ROOT.
const YAHOO_INDEX = {
  "^GSPC": "SPX",
  "^SPX": "SPX",
  "^NDX": "NDX",
  "^RUT": "RUT",
  "^VIX": "VIX",
  "^XSP": "XSP",
};
const INDEX_ROOTS = new Set(Object.values(YAHOO_INDEX));
const NOT_OPTIONABLE =
  "Options are for US stocks, ETFs and the main US indices (SPX, NDX, RUT, VIX). Try AAPL, SPY or SPX.";

const fail = (message, status) => Object.assign(new Error(message), { status });

// "AAPL", "US:AAPL", "^GSPC", "SPX", "BRK.B" -> { ticker, file, index } or null when it can't have US options.
export function cboeSymbol(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/^(US|YAHOO):/, "");
  const idx =
    YAHOO_INDEX[s] ||
    (INDEX_ROOTS.has(s.replace(/^[_^]/, "")) ? s.replace(/^[_^]/, "") : null);
  if (idx) return { ticker: idx, file: `_${idx}`, index: true };
  if (/^[A-Z]{1,5}([./][A-Z])?$/.test(s)) {
    const t = s.replace("/", ".");
    return { ticker: t, file: t, index: false };
  }
  return null;
}

// OCC option symbol: root, then YYMMDD, C or P, and the strike times 1000 in 8 digits.
const OCC = /^([A-Z0-9.]+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
export function parseOcc(sym) {
  const m = OCC.exec(String(sym || "").replace(/\s+/g, ""));
  if (!m) return null;
  return {
    root: m[1],
    expiry: `20${m[2]}-${m[3]}-${m[4]}`,
    type: m[5],
    strike: Number(m[6]) / 1000,
  };
}

// Today's date in New York, where US options expire.
export function nyToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const num = (v) => {
  if (v == null || v === "" || v === "--") return null;
  const x =
    typeof v === "number" ? v : parseFloat(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(x) ? x : null;
};

// Group contracts into expiries (one per date and root, so SPX's AM monthly and SPXW's PM weekly on the same
// Friday stay apart), each with its strikes sorted and the call and put side by side.
// Roots ending in a digit (AAPL1) are adjusted contracts after a split or merger, so they're left out.
export function buildExpiries(contracts, today) {
  const byKey = new Map();
  for (const c of contracts) {
    if (!c || c.expiry < today) continue;
    const key = `${c.expiry} ${c.root}`;
    if (!byKey.has(key))
      byKey.set(key, { date: c.expiry, root: c.root, strikes: new Map() });
    const strikes = byKey.get(key).strikes;
    if (!strikes.has(c.strike))
      strikes.set(c.strike, { strike: c.strike, call: null, put: null });
    strikes.get(c.strike)[c.type === "C" ? "call" : "put"] = c.quote;
  }
  let list = [...byKey.values()];
  const standard = list.filter((e) => !/\d$/.test(e.root));
  if (standard.length) list = standard;
  return list
    .sort(
      (a, b) => a.date.localeCompare(b.date) || a.root.localeCompare(b.root),
    )
    .map((e) => ({
      date: e.date,
      root: e.root,
      rows: [...e.strikes.values()].sort((a, b) => a.strike - b.strike),
    }));
}

// CBOE's delayed quotes file -> { price, change, changePct, iv30, asOf, expiries }.
export function parseCboe(j, today) {
  const d = j?.data;
  if (!d || !Array.isArray(d.options)) return null;
  const contracts = d.options.map((o) => {
    const c = parseOcc(o.option);
    if (!c) return null;
    c.quote = {
      bid: num(o.bid),
      ask: num(o.ask),
      last: num(o.last_trade_price) || null,
      iv: num(o.iv) > 0 ? num(o.iv) : null,
      delta: num(o.delta),
      volume: num(o.volume) || 0,
      oi: num(o.open_interest) || 0,
    };
    return c;
  });
  return {
    price: num(d.current_price),
    change: num(d.price_change),
    changePct: num(d.price_change_percent),
    iv30: num(d.iv30),
    asOf: j.timestamp ? `${String(j.timestamp).replace(" ", "T")}Z` : null,
    expiries: buildExpiries(contracts, today),
  };
}

const MONTHS = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};
const isoFromWords = (s) => {
  const m = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(String(s || "").trim());
  const mo = m && MONTHS[m[1].toLowerCase()];
  return mo
    ? `${m[3]}-${String(mo).padStart(2, "0")}-${m[2].padStart(2, "0")}`
    : null;
};

// Nasdaq's option chain: a header row per expiry ("October 16, 2026"), then one row per strike with the call
// (c_*) and put (p_*) side by side. No IV or delta (Nasdaq's greeks page gives IV as 0).
export function parseNasdaqChain(j, ticker, today) {
  const rows = j?.data?.table?.rows;
  if (!Array.isArray(rows)) return null;
  const side = (r, p) => ({
    bid: num(r[`${p}_Bid`]),
    ask: num(r[`${p}_Ask`]),
    last: num(r[`${p}_Last`]),
    iv: null,
    delta: null,
    volume: num(r[`${p}_Volume`]) || 0,
    oi: num(r[`${p}_Openinterest`]) || 0,
  });
  const contracts = [];
  let expiry = null;
  for (const r of rows) {
    if (r.expirygroup) {
      expiry = isoFromWords(r.expirygroup);
      continue;
    }
    const strike = num(r.strike);
    if (!expiry || strike == null) continue;
    contracts.push({
      root: ticker,
      expiry,
      type: "C",
      strike,
      quote: side(r, "c"),
    });
    contracts.push({
      root: ticker,
      expiry,
      type: "P",
      strike,
      quote: side(r, "p"),
    });
  }
  return {
    price: num(/\$([\d,.]+)/.exec(j.data.lastTrade || "")?.[1]),
    change: null,
    changePct: null,
    iv30: null,
    asOf: null,
    expiries: buildExpiries(contracts, today),
  };
}

// The strike nearest the underlying price, from strikes quoted on both sides when there are any.
export function atmStrike(rows, price) {
  if (!rows?.length || !Number.isFinite(price)) return null;
  const both = rows.filter((r) => r.call && r.put);
  let best = null;
  for (const r of both.length ? both : rows)
    if (!best || Math.abs(r.strike - price) < Math.abs(best.strike - price))
      best = r;
  return best.strike;
}

// The ATM strike and n strikes either side of it (all of them when n is Infinity).
export function nearStrikes(rows, atm, n = NEAR) {
  if (!Number.isFinite(n)) return rows;
  const i = Math.max(
    0,
    rows.findIndex((r) => r.strike === atm),
  );
  return rows.slice(Math.max(0, i - n), i + n + 1);
}

// Volume and open interest for the whole expiry, calls against puts.
export function totals(rows) {
  const t = { callVolume: 0, putVolume: 0, callOi: 0, putOi: 0 };
  for (const r of rows) {
    t.callVolume += r.call?.volume || 0;
    t.putVolume += r.put?.volume || 0;
    t.callOi += r.call?.oi || 0;
    t.putOi += r.put?.oi || 0;
  }
  return {
    ...t,
    pcVolume: putCallRatio(t.putVolume, t.callVolume),
    pcOi: putCallRatio(t.putOi, t.callOi),
  };
}

export const putCallRatio = (puts, calls) => (calls > 0 ? puts / calls : null);

// Mid of bid and ask when both are quoted, otherwise the last trade.
export function mid(q) {
  if (!q) return null;
  if (q.bid > 0 && q.ask > 0) return (q.bid + q.ask) / 2;
  return q.last > 0 ? q.last : null;
}

// The move the market prices in by expiry: the at-the-money straddle (call + put), in dollars and as a share
// of the underlying price.
export function impliedMove(rows, price, atm = atmStrike(rows, price)) {
  const r = rows?.find((x) => x.strike === atm);
  const c = mid(r?.call),
    p = mid(r?.put);
  if (c == null || p == null || !(price > 0)) return null;
  const straddle = c + p;
  return {
    strike: atm,
    call: c,
    put: p,
    dollars: straddle,
    pct: (straddle / price) * 100,
  };
}

// 1-based expiry number ("OMON 2") or a date ("2026-11-20"); out of range picks the nearest end.
export function pickExpiry(expiries, want) {
  const w = String(want ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) {
    const i = expiries.findIndex((e) => e.date === w);
    if (i >= 0) return i;
  }
  const n = parseInt(w, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), expiries.length) - 1 : 0;
}

const daysBetween = (from, to) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400e3,
  );

async function nasdaqChain(sym, today) {
  const to = `${Number(today.slice(0, 4)) + 4}${today.slice(4)}`;
  for (const cls of ["stocks", "etf"]) {
    const j = await getJson(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym.ticker)}/option-chain?assetclass=${cls}&limit=5000&fromdate=${today}&todate=${to}&money=all&type=all`,
      NQ,
    ).catch(() => null);
    const chain = parseNasdaqChain(j, sym.ticker, today);
    if (chain?.expiries.length) return chain;
  }
  return null;
}

function loadChain(sym) {
  return cached(`omon:${sym.file}`, 60e3, async () => {
    const today = nyToday();
    let cboeErr;
    try {
      const chain = parseCboe(
        await getJson(`${CBOE}${encodeURIComponent(sym.file)}.json`),
        today,
      );
      if (chain?.expiries.length)
        return {
          ...chain,
          source: "CBOE delayed option quotes (about 15 minutes behind)",
        };
    } catch (e) {
      cboeErr = e;
    }
    const nq = sym.index ? null : await nasdaqChain(sym, today);
    if (nq)
      return {
        ...nq,
        source: "Nasdaq option chain (CBOE didn't answer, so no IV or delta)",
      };
    if (!cboeErr || cboeErr.status === 403 || cboeErr.status === 404)
      throw fail(
        `No listed options found for ${sym.ticker}. ${NOT_OPTIONABLE}`,
        404,
      );
    throw fail(
      `CBOE's option quotes couldn't be reached (${cboeErr.message}). Try again in a minute.`,
      502,
    );
  });
}

export default async function (q) {
  const sym = cboeSymbol(q.symbol);
  if (!sym) throw fail(NOT_OPTIONABLE, 400);
  const chain = await loadChain(sym);
  const today = nyToday();
  const expiries = chain.expiries.filter((e) => e.date >= today);
  if (!expiries.length)
    throw fail(`${sym.ticker} has no open option expiries right now.`, 404);
  const i = pickExpiry(expiries, q.expiry);
  const exp = expiries[i];
  const all = String(q.strikes || "").toLowerCase() === "all";
  const atm = atmStrike(exp.rows, chain.price);
  const sameDay = (e) => expiries.filter((x) => x.date === e.date).length > 1;
  return {
    symbol: sym.ticker,
    index: sym.index,
    price: chain.price,
    change: chain.change,
    changePct: chain.changePct,
    iv30: chain.iv30,
    asOf: chain.asOf,
    expiries: expiries.map((e, n) => ({
      n: n + 1,
      date: e.date,
      root: sameDay(e) ? e.root : null,
      days: daysBetween(today, e.date),
    })),
    expiry: {
      n: i + 1,
      date: exp.date,
      root: exp.root,
      days: daysBetween(today, exp.date),
    },
    atm,
    strikes: { shown: all ? "all" : NEAR, total: exp.rows.length },
    rows: nearStrikes(exp.rows, atm, all ? Infinity : NEAR),
    totals: totals(exp.rows),
    move: impliedMove(exp.rows, chain.price, atm),
    source: chain.source,
  };
}
