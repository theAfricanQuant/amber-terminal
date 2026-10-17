// /api/fn/board?symbols=^GSPC,GC=F,EURUSD=X : last price, day change, YTD and 52-week range for a list of
// Yahoo symbols, from Yahoo's public spark endpoint (one request per 20 symbols, no key). Powers WEI, GLCO, FXC.
import { getJson, cached, YAHOO_UA as UA } from "../providers.js";


export function rowFrom(sym, v) {
  const closes = (v.close || []).map(Number);
  const times = v.timestamp || [];
  const valid = closes
    .map((c, i) => [times[i], c])
    .filter(([, c]) => Number.isFinite(c) && c > 0);
  const price = Number.isFinite(v.fulldayPrice)
    ? v.fulldayPrice
    : valid.at(-1)?.[1];
  const prev = Number.isFinite(v.previousClose)
    ? v.previousClose
    : valid.at(-2)?.[1];
  const year = new Date().getUTCFullYear();
  const jan = valid
    .filter(([t]) => new Date(t * 1000).getUTCFullYear() < year)
    .at(-1)?.[1];
  const highs = valid.map(([, c]) => c);
  return {
    symbol: sym,
    price,
    change: Number.isFinite(v.fulldayChange) ? v.fulldayChange : price - prev,
    changePct: Number.isFinite(v.fulldayChangePercent)
      ? v.fulldayChangePercent
      : ((price - prev) / prev) * 100,
    ytdPct: jan ? ((price - jan) / jan) * 100 : null,
    high52: highs.length ? Math.max(...highs) : null,
    low52: highs.length ? Math.min(...highs) : null,
    spark: valid.slice(-30).map(([, c]) => c),
    time: times.at(-1) || null,
  };
}

export async function board(symbols) {
  const list = [...new Set(symbols)].slice(0, 120);
  const out = {};
  for (let i = 0; i < list.length; i += 20) {
    const part = list.slice(i, i + 20);
    const path = `/v8/finance/spark?symbols=${encodeURIComponent(part.join(","))}&range=1y&interval=1d`;
    // query1 and query2 rate-limit separately, so a 429 on one is often fine on the other.
    const d = await cached(`spark:${part.join(",")}`, 30e3, () =>
      getJson(`https://query1.finance.yahoo.com${path}`, UA).catch(() => getJson(`https://query2.finance.yahoo.com${path}`, UA)),
    );
    for (const [k, v] of Object.entries(d || {})) out[k] = rowFrom(k, v);
  }
  return out;
}

export default async function (q) {
  const symbols = String(q.symbols || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!symbols.length)
    throw Object.assign(new Error("Send ?symbols=^GSPC,GC=F"), { status: 400 });
  return {
    source:
      "Yahoo Finance (public, prices can be delayed up to 15 minutes for some exchanges)",
    rows: await board(symbols),
  };
}
