// /api/fn/btst?symbol=SPY%20US%20EQUITY&strategy=1&tf=D : run a backtest and the quant checks on this computer.
// strategy is a preset number (1 to 5, the same list as the BTST screen) or a JSON strategy in the format at the top of
// public/lib/backtest.js, so Claude can turn a plain-English rule into a test.
import { getCandles } from "../providers.js";
import { toSecurity } from "../../public/js/securities.js";
import { backtest, EXAMPLE_STRATEGIES } from "../../public/lib/backtest.js";
import { quantChecks } from "../../public/lib/quant.js";

const TFS = { D: ["1D", 2000], H: ["1h", 3000], W: ["1W", 600] };
const PRESETS = Object.keys(EXAMPLE_STRATEGIES);
const bad = (m) => Object.assign(new Error(m), { status: 400 });

export function readStrategy(raw) {
  const s = String(raw ?? "1").trim();
  if (/^\d$/.test(s)) {
    const name = PRESETS[+s - 1];
    if (!name)
      throw bad(
        `Preset strategies are 1 to ${PRESETS.length}: ${PRESETS.map((n, i) => `${i + 1} ${n}`).join(", ")}.`,
      );
    return { name, ...EXAMPLE_STRATEGIES[name] };
  }
  let j;
  try {
    j = JSON.parse(s);
  } catch {
    throw bad(
      "strategy must be a preset number or a JSON strategy (see the format at the top of public/lib/backtest.js).",
    );
  }
  if (
    !j ||
    typeof j !== "object" ||
    !(j.entryLong?.length || j.entryShort?.length)
  )
    throw bad(
      "A strategy needs at least one entry rule (entryLong or entryShort).",
    );
  return j;
}

// The terminal's own tickers ("SPY US EQUITY", "BTC") or a source symbol ("SPY", "BTCUSDT", "^GSPC").
export function symbolFor(raw) {
  const words = String(raw || "")
    .toUpperCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length)
    throw bad(
      "Send ?symbol=SPY US EQUITY (or any ticker the terminal understands).",
    );
  return toSecurity(words)?.id || words[0];
}

export default async function (q) {
  const symbol = symbolFor(q.symbol || q.security);
  const strat = { feePct: 0.1, slippagePct: 0.05, ...readStrategy(q.strategy) };
  const tfKey = TFS[String(q.tf || "D").toUpperCase()]
    ? String(q.tf || "D").toUpperCase()
    : "D";
  const [tf, n] = TFS[tfKey];
  const res = await getCandles(symbol, tf, n);
  const bars = res.candles;
  if (bars.length < 300)
    throw Object.assign(
      new Error(
        `Only ${bars.length} bars of history for ${symbol} on ${tf}. The checks need at least 300.`,
      ),
      { status: 422 },
    );
  const r = backtest(bars, strat);
  const q2 = quantChecks(bars, strat, { mcRuns: 1000 });
  const s = r.stats;
  return {
    symbol: res.symbol,
    timeframe: tf,
    bars: bars.length,
    from: new Date(bars[0].time * 1000).toISOString().slice(0, 10),
    to: new Date(bars.at(-1).time * 1000).toISOString().slice(0, 10),
    strategy: strat.name || "custom",
    results: {
      netResultPct: s.netProfitPct,
      buyAndHoldPct: s.buyHoldPct,
      maxDrawdownPct: s.maxDrawdownPct,
      trades: s.totalTrades,
      winningTradesPct: s.winRatePct,
      profitFactor: s.profitFactor,
      sharpe: s.sharpe,
      timeInMarketPct: s.exposurePct,
      costs: s.feesAndSlippage,
    },
    quantChecks: {
      passed: q2.passed,
      of: q2.gates.length,
      checks: q2.gates.map((g) => ({
        check: g.label,
        pass: g.pass,
        found: g.value,
      })),
    },
    note: "A backtest shows what rules did on past prices. The checks ask whether that would survive new data, nearby settings, double costs and a reshuffle of the same trades. Passing doesn't make a strategy profitable.",
    source: `${res.provider} bars; backtest and checks run on this computer`,
  };
}
