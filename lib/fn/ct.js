// /api/fn/ct?symbol=CL=F : a futures curve. The next contract months of one market, each priced from its own
// Yahoo Finance contract symbol (CLZ26.NYM, GCG27.CMX, ESH27.CME), the way WIRP prices the fed funds strip.
// Yahoo's futures run about 10 minutes behind. Months that haven't traded today keep their last price, are
// marked, and are left out of the curve so it compares like with like.
import { getJson, cached, YAHOO_UA } from "../providers.js";
import { round, nyToday } from "./gc.js";

const CODES = "FGHJKMNQUVXZ";
const ALL = CODES;
const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
export const MAX_CONTRACTS = 12;

// Yahoo root -> exchange suffix, the months the exchange lists and trades actively, and a plain name.
export const ROOTS = {
  CL: { exch: "NYM", cycle: ALL, name: "WTI crude oil", unit: "$ a barrel" },
  BZ: { exch: "NYM", cycle: ALL, name: "Brent crude oil", unit: "$ a barrel" },
  NG: { exch: "NYM", cycle: ALL, name: "Natural gas", unit: "$ per mmBtu" },
  HO: { exch: "NYM", cycle: ALL, name: "Heating oil", unit: "$ a gallon" },
  RB: { exch: "NYM", cycle: ALL, name: "Gasoline", unit: "$ a gallon" },
  GC: { exch: "CMX", cycle: "GJMQVZ", name: "Gold", unit: "$ an ounce" },
  SI: { exch: "CMX", cycle: "HKNUZ", name: "Silver", unit: "$ an ounce" },
  HG: { exch: "CMX", cycle: ALL, name: "Copper", unit: "$ a pound" },
  PL: { exch: "NYM", cycle: "FJNV", name: "Platinum", unit: "$ an ounce" },
  PA: { exch: "NYM", cycle: "HMUZ", name: "Palladium", unit: "$ an ounce" },
  ZC: { exch: "CBT", cycle: "HKNUZ", name: "Corn", unit: "cents a bushel" },
  ZW: { exch: "CBT", cycle: "HKNUZ", name: "Wheat", unit: "cents a bushel" },
  ZS: {
    exch: "CBT",
    cycle: "FHKNQUX",
    name: "Soybeans",
    unit: "cents a bushel",
  },
  KC: { exch: "NYB", cycle: "HKNUZ", name: "Coffee", unit: "cents a pound" },
  SB: { exch: "NYB", cycle: "HKNV", name: "Sugar", unit: "cents a pound" },
  CC: { exch: "NYB", cycle: "HKNUZ", name: "Cocoa", unit: "$ a tonne" },
  CT: { exch: "NYB", cycle: "HKNVZ", name: "Cotton", unit: "cents a pound" },
  LE: {
    exch: "CME",
    cycle: "GJMQVZ",
    name: "Live cattle",
    unit: "cents a pound",
  },
  HE: {
    exch: "CME",
    cycle: "GJKMNQVZ",
    name: "Lean hogs",
    unit: "cents a pound",
  },
  ES: {
    exch: "CME",
    cycle: "HMUZ",
    name: "E-mini S&P 500",
    unit: "index points",
  },
  NQ: {
    exch: "CME",
    cycle: "HMUZ",
    name: "E-mini Nasdaq 100",
    unit: "index points",
  },
  YM: { exch: "CBT", cycle: "HMUZ", name: "E-mini Dow", unit: "index points" },
  RTY: {
    exch: "CME",
    cycle: "HMUZ",
    name: "E-mini Russell 2000",
    unit: "index points",
  },
  ZN: { exch: "CBT", cycle: "HMUZ", name: "10-year T-note", unit: "points" },
  ZB: { exch: "CBT", cycle: "HMUZ", name: "30-year T-bond", unit: "points" },
  ZF: { exch: "CBT", cycle: "HMUZ", name: "5-year T-note", unit: "points" },
  ZT: { exch: "CBT", cycle: "HMUZ", name: "2-year T-note", unit: "points" },
};

// Index and bond futures: their curve is about interest and dividends or coupons, not storage.
const FINANCIAL = new Set(["ES", "NQ", "YM", "RTY", "ZN", "ZB", "ZF", "ZT"]);

// The terminal's generic tickers (public/js/securities.js GENERICS) -> Yahoo roots.
export const GENERIC = {
  CL1: "CL",
  CO1: "BZ",
  NG1: "NG",
  HO1: "HO",
  XB1: "RB",
  GC1: "GC",
  SI1: "SI",
  HG1: "HG",
  PL1: "PL",
  PA1: "PA",
  C1: "ZC",
  W1: "ZW",
  S1: "ZS",
  KC1: "KC",
  SB1: "SB",
  CC1: "CC",
  CT1: "CT",
  LC1: "LE",
  LH1: "HE",
  ES1: "ES",
  NQ1: "NQ",
  YM1: "YM",
  RTY1: "RTY",
  TY1: "ZN",
  US1: "ZB",
  FV1: "ZF",
  TU1: "ZT",
};

const NOT_FUTURES = `CT needs a futures market, for example CL1 COMDTY CT. It covers ${Object.keys(GENERIC).join(", ")}.`;
const fail = (message, status) => Object.assign(new Error(message), { status });

// "CL=F", "YAHOO:CL=F", "CL1", "CL", "CLZ26", "CLZ26.NYM" -> "CL", or null.
export function rootOf(raw) {
  const s = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/^(YAHOO|US):/, "");
  const m =
    /^([A-Z]{1,3})=F$/.exec(s) ||
    /^([A-Z]{1,3})[FGHJKMNQUVXZ]\d{2}(?:\.[A-Z]{3}|=F)?$/.exec(s);
  const r = GENERIC[s] || GENERIC[`${s}1`] || (m ? m[1] : s);
  return ROOTS[r] ? r : null;
}

export const contractSymbol = (root, y, m) =>
  `${root}${CODES[m - 1]}${String(y).slice(-2)}.${ROOTS[root].exch}`;

// The next listed months from this month on, in the market's cycle. Two extra, since the front month may
// have expired already this month.
export function contractMonths(root, today, n = MAX_CONTRACTS + 2) {
  const { cycle } = ROOTS[root];
  let [y, m] = today.split("-").map(Number);
  const out = [];
  for (let i = 0; i < 48 && out.length < n; i++) {
    if (cycle.includes(CODES[m - 1]))
      out.push({
        symbol: contractSymbol(root, y, m),
        code: `${root}${CODES[m - 1]}${String(y).slice(-2)}`,
        month: `${y}-${String(m).padStart(2, "0")}`,
        label: `${MON[m - 1]} ${y}`,
      });
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
  return out;
}

const isoDay = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

// One spark entry -> { price, date, change, changePct }: the last daily close and the close before it.
// Yahoo leaves today's close empty for a month that hasn't traded today, so its price is the last day it did.
export function lastBar(v) {
  const t = v?.timestamp || [];
  const c = v?.close || [];
  const bars = t
    .map((ts, i) => [isoDay(ts), Number(c[i])])
    .filter(([, x]) => Number.isFinite(x) && x > 0);
  if (!bars.length) return null;
  const [date, price] = bars.at(-1);
  const prev = bars.at(-2)?.[1];
  return {
    price,
    date,
    change: prev ? price - prev : null,
    changePct: prev ? (price / prev - 1) * 100 : null,
  };
}

// Contango when later months cost more than the front, backwardation when they cost less.
// The spread is last against first, in percent. "Humped" when a month in between sits more than 1% above both
// ends or below both (seasonal markets like natural gas do this).
export function curveShape(points) {
  const p = points.filter((x) => Number.isFinite(x.price));
  if (p.length < 2) return null;
  const first = p[0],
    last = p.at(-1);
  const spreadPct = (last.price / first.price - 1) * 100;
  const shape =
    Math.abs(spreadPct) < 0.1
      ? "flat"
      : spreadPct > 0
        ? "contango"
        : "backwardation";
  const mid = p.slice(1, -1);
  const hi = Math.max(first.price, last.price),
    lo = Math.min(first.price, last.price);
  const peak = mid.reduce((a, x) => (!a || x.price > a.price ? x : a), null);
  const trough = mid.reduce((a, x) => (!a || x.price < a.price ? x : a), null);
  const humpUp = peak && peak.price > hi * 1.01 ? peak : null;
  const humpDown = trough && trough.price < lo * 0.99 ? trough : null;
  return {
    shape,
    spreadPct,
    first: { label: first.label, price: first.price },
    last: { label: last.label, price: last.price },
    nextPct: (p[1].price / first.price - 1) * 100,
    peak: humpUp ? { label: humpUp.label, price: humpUp.price } : null,
    trough: humpDown ? { label: humpDown.label, price: humpDown.price } : null,
  };
}

// months (from contractMonths) + spark JSON -> contracts. The newest trading day among them is the session;
// a month priced on an earlier day is marked stale, and one with nothing for 10 days or more is dropped (expired
// or not listed yet).
export function buildCurve(months, spark, n = MAX_CONTRACTS) {
  const rows = months
    .map((c) => {
      const b = lastBar(spark?.[c.symbol]);
      return b ? { ...c, ...b } : null;
    })
    .filter(Boolean);
  const session = rows.reduce((a, r) => (r.date > a ? r.date : a), "");
  const cutoff = session
    ? new Date(Date.parse(`${session}T00:00:00Z`) - 10 * 86400e3)
        .toISOString()
        .slice(0, 10)
    : "";
  const contracts = rows
    .filter((r) => r.date >= cutoff)
    .slice(0, n)
    .map((r) => ({ ...r, current: r.date === session }));
  const shown = new Set(contracts.map((c) => c.symbol));
  const firstShown = months.findIndex((c) => shown.has(c.symbol));
  const lastShown = months.findLastIndex((c) => shown.has(c.symbol));
  // Months inside the range Yahoo had nothing for (the expired front month doesn't count).
  const missing = months
    .slice(Math.max(0, firstShown), lastShown + 1)
    .filter((c) => !shown.has(c.symbol))
    .map((c) => c.label);
  return {
    session: session || null,
    contracts,
    missing,
    curve: curveShape(contracts.filter((c) => c.current)),
  };
}

async function spark(symbols) {
  const path = `/v8/finance/spark?symbols=${encodeURIComponent(symbols.join(","))}&range=1mo&interval=1d`;
  return getJson(`https://query1.finance.yahoo.com${path}`, YAHOO_UA).catch(
    () => getJson(`https://query2.finance.yahoo.com${path}`, YAHOO_UA),
  );
}

export default async function (q) {
  const root = rootOf(q.symbol);
  if (!root) throw fail(NOT_FUTURES, 400);
  const meta = ROOTS[root];
  const generic = Object.keys(GENERIC).find((k) => GENERIC[k] === root);
  return cached(`ct:${root}`, 2 * 60e3, async () => {
    const months = contractMonths(root, nyToday());
    let j;
    try {
      j = await spark(months.map((c) => c.symbol));
    } catch (e) {
      throw Object.assign(
        new Error(
          `Yahoo Finance didn't send ${meta.name} futures prices (${e.message}). Try again in a minute.`,
        ),
        { status: 502, upstream: true },
      );
    }
    const built = buildCurve(months, j);
    if (!built.contracts.length)
      throw Object.assign(
        new Error(
          `Yahoo Finance sent no ${meta.name} contract prices. Try again in a minute.`,
        ),
        { status: 502, upstream: true },
      );
    return {
      root,
      generic,
      name: meta.name,
      unit: meta.unit,
      exchange: meta.exch,
      financial: FINANCIAL.has(root),
      ...built,
      contracts: built.contracts.map((c) => ({
        ...c,
        change: round(c.change, 6),
        changePct: round(c.changePct, 4),
      })),
      source: `${meta.name} futures, one Yahoo Finance symbol per contract month (about 10 minutes delayed)`,
    };
  });
}
