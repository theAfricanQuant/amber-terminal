// The maths behind COMP and PORT, kept pure so the tests can check it by hand.
// Returns are simple daily returns (close / previous close - 1). Volatility is their sample standard
// deviation times the square root of the trading days in a year: 252 for markets that close at weekends,
// 365 for crypto, which trades every day.

export const TRADING_DAYS = 252;
export const CRYPTO_DAYS = 365;

const finite = (v) => typeof v === "number" && Number.isFinite(v);
export const dayKey = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// The same calendar date `range` before `end` (unix seconds): 1M, 6M, 1Y, 5Y.
export function rangeStart(end, range) {
  const d = new Date(end * 1000);
  const n = parseInt(range, 10) || 1;
  // Month-end safe: a month back from 31 March is 28 (or 29) February, not 3 March.
  const day = d.getUTCDate();
  d.setUTCDate(1);
  if (/M$/.test(range)) d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  const last = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return Math.floor(d.getTime() / 1000);
}

export function returns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++)
    if (finite(closes[i]) && finite(closes[i - 1]) && closes[i - 1] !== 0)
      out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

export function stdevSample(xs) {
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

// Annualised volatility in percent.
export function annualVol(closes, perYear = TRADING_DAYS) {
  const sd = stdevSample(returns(closes));
  return sd == null ? null : sd * Math.sqrt(perYear) * 100;
}

// Worst fall from a running peak, in percent (zero or negative).
export function maxDrawdown(closes) {
  let peak = -Infinity,
    worst = 0;
  for (const c of closes) {
    if (!finite(c)) continue;
    if (c > peak) peak = c;
    worst = Math.min(worst, c / peak - 1);
  }
  return worst * 100;
}

export const totalReturn = (closes) =>
  closes.length > 1 ? (closes.at(-1) / closes[0] - 1) * 100 : null;

// One COMP line: bars from `start` on, rebased so the first close is 100, with the range's stats.
export function compLine(bars, start, perYear = TRADING_DAYS) {
  const inRange = bars.filter(
    (b) => b.time >= start && finite(b.close) && b.close > 0,
  );
  if (inRange.length < 2) return null;
  const closes = inRange.map((b) => b.close);
  const base = closes[0];
  return {
    from: inRange[0].time,
    to: inRange.at(-1).time,
    first: base,
    last: closes.at(-1),
    ret: totalReturn(closes),
    vol: annualVol(closes, perYear),
    mdd: maxDrawdown(closes),
    points: inRange.map((b) => ({
      time: b.time,
      value: (b.close / base) * 100,
    })),
  };
}

// Two price series lined up on the days both traded, as pairs of simple returns.
export function alignedReturns(barsA, barsB) {
  const b = new Map(barsB.map((x) => [dayKey(x.time), x.close]));
  const pairs = barsA
    .map((x) => [x.close, b.get(dayKey(x.time))])
    .filter(([p, q]) => finite(p) && finite(q) && p > 0 && q > 0);
  const ra = [],
    rb = [];
  for (let i = 1; i < pairs.length; i++) {
    ra.push(pairs[i][0] / pairs[i - 1][0] - 1);
    rb.push(pairs[i][1] / pairs[i - 1][1] - 1);
  }
  return { a: ra, b: rb };
}

// Beta of returns `a` against market returns `m`: covariance over the market's variance.
export function beta(a, m) {
  const n = Math.min(a.length, m.length);
  if (n < 10) return null;
  const ma = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const mm = m.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let cov = 0,
    v = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - ma) * (m[i] - mm);
    v += (m[i] - mm) ** 2;
  }
  return v ? cov / v : null;
}

// The last `days` calendar days of bars.
export const lastDays = (bars, days = 365) =>
  bars.length
    ? bars.filter((b) => b.time >= bars.at(-1).time - days * 86400)
    : [];

// Holdings valued in US dollars. Each: { shares, cost (per unit, in the price's currency), price,
// changePct (today's move, percent), fx (US dollars per unit of the price's currency) }.
export function valueHoldings(list) {
  const rows = list.map((h) => {
    const fx = finite(h.fx) ? h.fx : null;
    const priced = finite(h.price) && fx != null;
    const value = priced ? h.shares * h.price * fx : null;
    const costValue =
      finite(h.cost) && fx != null ? h.shares * h.cost * fx : null;
    const pnl = value != null && costValue != null ? value - costValue : null;
    const prev =
      priced && finite(h.changePct) ? h.price / (1 + h.changePct / 100) : null;
    const dayChg = prev != null ? h.shares * (h.price - prev) * fx : null;
    return {
      ...h,
      value,
      costValue,
      pnl,
      pnlPct:
        pnl != null && costValue ? (pnl / Math.abs(costValue)) * 100 : null,
      dayChg,
    };
  });
  const sum = (k) => rows.reduce((s, r) => s + (finite(r[k]) ? r[k] : 0), 0);
  const total = sum("value");
  for (const r of rows)
    r.weight = r.value != null && total ? (r.value / total) * 100 : null;
  const cost = rows
    .filter((r) => r.value != null)
    .reduce((s, r) => s + (r.costValue || 0), 0);
  const dayChg = sum("dayChg");
  return {
    rows,
    totals: {
      value: total,
      cost,
      pnl: total - cost,
      pnlPct: cost ? ((total - cost) / Math.abs(cost)) * 100 : null,
      dayChg,
      dayChgPct: total - dayChg ? (dayChg / (total - dayChg)) * 100 : null,
    },
  };
}

// The portfolio's daily returns at today's weights, on the days every holding traded.
export function portfolioReturns(series) {
  // series: [{ weight (fraction), bars }]
  const live = series.filter((s) => s.weight && s.bars?.length);
  if (!live.length) return [];
  const maps = live.map(
    (s) => new Map(s.bars.map((b) => [dayKey(b.time), b.close])),
  );
  const days = [...maps[0].keys()]
    .filter((d) => maps.every((m) => finite(m.get(d)) && m.get(d) > 0))
    .sort();
  const out = [];
  for (let i = 1; i < days.length; i++)
    out.push(
      live.reduce(
        (s, x, j) =>
          s + x.weight * (maps[j].get(days[i]) / maps[j].get(days[i - 1]) - 1),
        0,
      ),
    );
  return out;
}

export function volOfReturns(rs, perYear = TRADING_DAYS) {
  const sd = stdevSample(rs);
  return sd == null ? null : sd * Math.sqrt(perYear) * 100;
}

// Not a screen: /api/fn/eq-math answers 404 like any unknown function.
export default function () {
  throw Object.assign(new Error("No terminal function called eq-math"), {
    status: 404,
  });
}
