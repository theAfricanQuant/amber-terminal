// /api/fn/eq-port : the holdings you typed into PORT (saved as amberPort in data/state.json), valued at
// live prices in US dollars, with profit and loss, weights, beta against the S&P 500 and volatility over
// the last year of daily returns, and the sector mix. Your numbers only; nothing here is advice.
import {
  getJson,
  cached,
  YAHOO_UA,
  resolve,
  getQuotes,
  getCandles,
  kindOf,
  nasdaqScreener,
} from "../providers.js";
import { board } from "./board.js";
import * as store from "../store.js";
import { toSecurity } from "../../public/js/securities.js";
import {
  valueHoldings,
  alignedReturns,
  beta,
  lastDays,
  returns,
  volOfReturns,
  portfolioReturns,
  TRADING_DAYS,
  CRYPTO_DAYS,
} from "./eq-math.js";

// Prices quoted in minor units (pence, cents, agorot) and the currency they belong to.
const MINOR = {
  GBp: ["GBP", 0.01],
  GBX: ["GBP", 0.01],
  ZAc: ["ZAR", 0.01],
  ILA: ["ILS", 0.01],
};

export function cleanHoldings(list) {
  return (Array.isArray(list) ? list : [])
    .map((h) => ({
      sec: String(h?.sec || "")
        .toUpperCase()
        .trim()
        .replace(/\s+/g, " "),
      shares: Number(h?.shares),
      cost: h?.cost === "" || h?.cost == null ? null : Number(h.cost),
    }))
    .filter((h) => h.sec && Number.isFinite(h.shares) && h.shares !== 0)
    .map((h) => ({ ...h, cost: Number.isFinite(h.cost) ? h.cost : null }))
    .slice(0, 100);
}

// Beta and volatility for each holding, then for the whole portfolio at today's weights.
export function risk(rows, market) {
  const mkt = lastDays(market || [], 365);
  for (const r of rows) {
    const bars = lastDays(r.bars || [], 365);
    const pair = alignedReturns(bars, mkt);
    r.beta = beta(pair.a, pair.b);
    r.vol = bars.length
      ? volOfReturns(
          returns(bars.map((b) => b.close)),
          r.crypto ? CRYPTO_DAYS : TRADING_DAYS,
        )
      : null;
  }
  const total = rows.reduce((s, r) => s + (r.value || 0), 0);
  const priced = rows.filter((r) => r.value);
  const allBeta = priced.length && priced.every((r) => r.beta != null);
  const port = portfolioReturns(
    priced.map((r) => ({
      weight: r.value / total,
      bars: lastDays(r.bars || [], 365),
    })),
  );
  return {
    beta: allBeta
      ? priced.reduce((s, r) => s + (r.value / total) * r.beta, 0)
      : null,
    vol:
      port.length > 10
        ? volOfReturns(
            port,
            priced.every((r) => r.crypto) ? CRYPTO_DAYS : TRADING_DAYS,
          )
        : null,
  };
}

export function sectorMix(rows) {
  const total = rows.reduce((s, r) => s + (r.value || 0), 0);
  const m = new Map();
  for (const r of rows)
    if (r.value) m.set(r.sector, (m.get(r.sector) || 0) + r.value);
  return [...m]
    .map(([sector, value]) => ({
      sector,
      value,
      weight: total ? (value / total) * 100 : null,
    }))
    .sort((a, b) => b.value - a.value);
}

async function yahooCurrency(sym) {
  const j = await cached(`ccy:${sym}`, 24 * 3600e3, () =>
    getJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`,
      YAHOO_UA,
    ),
  );
  return j?.chart?.result?.[0]?.meta?.currency || null;
}

async function sectors() {
  const [st, etf] = await Promise.all([
    nasdaqScreener("stocks").catch(() => []),
    nasdaqScreener("etf").catch(() => []),
  ]);
  const m = new Map();
  for (const r of etf) m.set(r.ticker, "ETF");
  for (const r of st) if (r.sector) m.set(r.ticker, r.sector);
  return m;
}

export async function valuePortfolio(holdings) {
  const list = cleanHoldings(holdings);
  const notes = [];
  const parsed = await Promise.all(
    list.map(async (h) => {
      const sec = toSecurity(h.sec.split(" "));
      try {
        const sym = await resolve(sec?.id || h.sec);
        return {
          ...h,
          sym: sec?.id || h.sec,
          kind: sec?.sector,
          name: sec?.name,
          id: sym.id,
          exchange: sym.exchange,
          ticker: sym.ticker,
        };
      } catch (e) {
        return { ...h, error: e.message };
      }
    }),
  );
  const ok = parsed.filter((p) => p.id);
  // Live prices: Nasdaq for US stocks, the exchanges for crypto, Yahoo for everything else.
  const direct = ok.filter(
    (p) => p.exchange === "US" || kindOf(p.id) === "crypto",
  );
  const yahoo = ok.filter((p) => !direct.includes(p));
  const ySym = (p) => (p.exchange === "FX" ? `${p.ticker}=X` : p.ticker);
  const [quotes, yRows, sectorOf, market] = await Promise.all([
    direct.length ? getQuotes(direct.map((p) => p.id)).catch(() => ({})) : {},
    yahoo.length ? board(yahoo.map(ySym)).catch(() => ({})) : {},
    sectors(),
    getCandles("^GSPC", "1D", 400)
      .then((r) => ({ name: "S&P 500", bars: r.candles }))
      .catch(() =>
        getCandles("SPY", "1D", 400)
          .then((r) => ({
            name: "S&P 500 (through the SPY fund)",
            bars: r.candles,
          }))
          .catch(() => null),
      ),
  ]);
  for (const p of yahoo) {
    p.currency =
      p.exchange === "FX"
        ? p.ticker.slice(3)
        : await yahooCurrency(ySym(p)).catch(() => null);
    const q = yRows[ySym(p)];
    if (q) Object.assign(p, { price: q.price, changePct: q.changePct });
  }
  for (const p of direct) {
    p.currency = "USD";
    p.crypto = kindOf(p.id) === "crypto";
    const q = quotes[p.id];
    if (q?.price) Object.assign(p, { price: q.price, changePct: q.changePct });
  }
  // US dollars per unit of each currency, from Yahoo's FX quotes.
  const need = [
    ...new Set(
      yahoo
        .map((p) => MINOR[p.currency]?.[0] || p.currency)
        .filter((c) => c && c !== "USD"),
    ),
  ];
  const fx = need.length
    ? await board(need.map((c) => `${c}USD=X`)).catch(() => ({}))
    : {};
  for (const p of ok) {
    const [base, mult] = MINOR[p.currency] || [p.currency, 1];
    p.fx =
      base === "USD"
        ? 1
        : fx[`${base}USD=X`]?.price
          ? fx[`${base}USD=X`].price * mult
          : null;
    if (p.price != null && p.fx == null)
      notes.push(
        `No ${p.currency || "currency"} rate for ${p.sec}, so it isn't in the totals.`,
      );
    p.sector =
      sectorOf.get(p.ticker) ||
      (p.crypto
        ? "Crypto"
        : { INDEX: "Index", CMDTY: "Commodity", CRNCY: "Currency" }[p.kind] ||
          (p.exchange === "US" ? "No sector on file" : "Non-US stock, no sector"));
  }
  await Promise.all(
    ok.map(async (p) => {
      p.bars = await getCandles(p.sym, "1D", 400)
        .then((r) => r.candles)
        .catch(() => null);
    }),
  );
  const { rows, totals } = valueHoldings(parsed);
  const r = risk(rows, market?.bars);
  for (const p of parsed) if (p.error) notes.push(`${p.sec}: ${p.error}`);
  if (!market)
    notes.push("The S&P 500 history didn't load, so beta isn't shown.");
  if (ok.some((p) => p.crypto))
    notes.push(
      "Crypto day change is the last 24 hours; crypto is priced in USDT, taken as US dollars.",
    );
  if (yahoo.some((p) => p.currency && p.currency !== "USD"))
    notes.push(
      "Non-dollar holdings: cost is in the price's own currency, and both are converted at today's rate.",
    );
  return {
    holdings: rows.map(({ bars, sym, ...rest }) => rest),
    totals: { ...totals, ...r },
    sectors: sectorMix(rows),
    market: market?.name || null,
    notes,
  };
}

export default async function () {
  const holdings = store.read("state", {}).amberPort || [];
  return {
    ...(await valuePortfolio(holdings)),
    source:
      "Your holdings (data/state.json). Prices: Nasdaq (US stocks), the crypto exchanges, Yahoo (the rest and FX). Beta and volatility from the last year of daily closes",
  };
}
