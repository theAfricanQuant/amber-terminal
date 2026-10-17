// /api/fn/eq-comp?symbols=AAPL,MSFT,^GSPC&range=1Y : up to six securities rebased to 100 from the same
// start date, with price return, annualised volatility and maximum drawdown over the range. Powers COMP.
import { getCandles, resolve, kindOf } from "../providers.js";
import { rangeStart, compLine, TRADING_DAYS, CRYPTO_DAYS } from "./eq-math.js";

export const RANGES = { "1M": 60, "6M": 200, "1Y": 400, "5Y": 1900 };

export default async function (q) {
  const range = RANGES[q.range] ? q.range : "1Y";
  const symbols = String(q.symbols || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (!symbols.length)
    throw Object.assign(
      new Error("Name at least one security, like COMP AAPL MSFT"),
      { status: 400 },
    );
  const loaded = await Promise.all(
    symbols.map(async (symbol) => {
      try {
        const sym = await resolve(symbol);
        const res = await getCandles(symbol, "1D", RANGES[range]);
        return {
          symbol,
          id: sym.id,
          crypto: kindOf(sym.id) === "crypto",
          provider: res.provider,
          bars: res.candles,
        };
      } catch (e) {
        return { symbol, error: e.message };
      }
    }),
  );
  const ok = loaded.filter((l) => l.bars?.length);
  if (!ok.length)
    throw Object.assign(
      new Error(
        `No prices loaded. ${loaded.map((l) => `${l.symbol}: ${l.error}`).join(" ")}`,
      ),
      {
        status: 502,
      },
    );
  // One start date for every line: the range back from the latest close any of them has.
  const end = Math.max(...ok.map((l) => l.bars.at(-1).time));
  const start = rangeStart(end, range);
  const series = loaded.map((l) => {
    if (!l.bars) return { symbol: l.symbol, error: l.error };
    const line = compLine(l.bars, start, l.crypto ? CRYPTO_DAYS : TRADING_DAYS);
    if (!line)
      return {
        symbol: l.symbol,
        id: l.id,
        error: "Not enough prices in this range",
      };
    return {
      symbol: l.symbol,
      id: l.id,
      provider: l.provider,
      perYear: l.crypto ? CRYPTO_DAYS : TRADING_DAYS,
      ...line,
    };
  });
  const providers = [...new Set(ok.map((l) => l.provider))].join(", ");
  return {
    range,
    start,
    end,
    series,
    source: `Daily closes from ${providers}. Price return only (dividends not added back); stocks may be delayed`,
  };
}
