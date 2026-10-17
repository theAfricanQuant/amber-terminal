// /api/fn/anr?symbol=AAPL : analyst ratings for US stocks. How many analysts say buy, hold and sell, the
// 12-month price targets (low, mean, high) against the live price, the monthly history of both, and the
// firms covering it. Nasdaq publishes this consensus for free; analyst-by-analyst detail is paid data.
import { getJson, cached, NQ, resolve, getQuotes } from "../providers.js";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseTargets(j) {
  const o = j?.data?.consensusOverview || {};
  const history = (j?.data?.historicalConsensus || []).map((h) => ({
    date: h.z?.date || null,
    buy: num(h.z?.buy),
    hold: num(h.z?.hold),
    sell: num(h.z?.sell),
    consensus: h.z?.consensus || null,
    meanTarget: num(h.y),
  }));
  const buy = num(o.buy),
    hold = num(o.hold),
    sell = num(o.sell);
  return {
    buy,
    hold,
    sell,
    analysts: [buy, hold, sell].every((v) => v != null)
      ? buy + hold + sell
      : null,
    consensus: history.at(-1)?.consensus || null,
    low: num(o.lowPriceTarget),
    mean: num(o.priceTarget),
    high: num(o.highPriceTarget),
    history,
  };
}

export default async function (q) {
  const sym = await resolve(q.symbol);
  if (sym.exchange !== "US")
    throw Object.assign(
      new Error(
        "ANR covers US-listed stocks (Nasdaq's free analyst consensus).",
      ),
      {
        status: 400,
      },
    );
  const t = encodeURIComponent(sym.ticker);
  const base = await cached(`anr:${t}`, 3 * 3600e3, async () => {
    const [tp, rt] = await Promise.all([
      getJson(`https://api.nasdaq.com/api/analyst/${t}/targetprice`, NQ).catch(
        () => null,
      ),
      getJson(`https://api.nasdaq.com/api/analyst/${t}/ratings`, NQ).catch(
        () => null,
      ),
    ]);
    const targets = parseTargets(tp);
    if (targets.analysts == null && targets.mean == null)
      throw Object.assign(
        new Error(`Nasdaq has no analyst ratings for ${sym.ticker}.`),
        { status: 404 },
      );
    return {
      ...targets,
      firms: rt?.data?.brokerNames || [],
      changes: (rt?.data?.upgradesDowngrades || []).slice(0, 20),
    };
  });
  const quotes = await getQuotes([sym.id]).catch(() => ({}));
  const price = quotes[sym.id]?.price || null;
  return {
    symbol: sym.ticker,
    price,
    upsidePct: price && base.mean ? (base.mean / price - 1) * 100 : null,
    ...base,
    source:
      "Analyst consensus via Nasdaq (Zacks), updated daily; live price from Nasdaq",
  };
}
