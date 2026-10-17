#!/usr/bin/env node
// Amber Terminal as an MCP server, so your own Claude can use the terminal: the same functions as the screens
// (WIRP, GC, OMON, DES...), quotes, price history, security search, backtests, your watchlist and portfolio, and
// price alerts. Stdio JSON-RPC 2.0, no dependencies. The functions run in this process, so the app doesn't need to
// be open (alerts excepted: they're checked by the running app).
//   claude mcp add --scope user amber -- node /path/to/amber-terminal/scripts/mcp.js
//   node scripts/mcp.js --help      prints that line for this folder
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { relaunchForProxy } from "../lib/proxy.js";
import * as data from "../lib/providers.js";
import * as info from "../lib/market-info.js";
import * as store from "../lib/store.js";
import * as bbg from "../lib/bloomberg-fields.js";
import { INDICES, GENERICS } from "../public/js/securities.js";
import { parseTf, isIntraday } from "../public/lib/series.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FN_DIR = path.join(ROOT, "lib", "fn");
const VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
const TEXT_BUDGET = 14000; // characters of JSON per answer, so a big table doesn't flood the conversation

const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const f2 = (v, dp = 2) => (fin(v) ? v.toFixed(dp) : "?");
const sgn = (v, dp = 1) =>
  fin(v) ? `${v > 0 ? "+" : ""}${v.toFixed(dp)}` : "?";
const listOf = (v) =>
  (Array.isArray(v) ? v : String(v ?? "").split(","))
    .map((s) => String(s).trim())
    .filter(Boolean);
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);

// ---------- the function catalog ----------
// Each code maps to its lib/fn file (or a small runner) and the query it expects. `arg` is the parameter a plain
// string in `args` fills. Files added to lib/fn later show up on their own, described by their header comment.
const GLCO = [
  "CL1",
  "CO1",
  "NG1",
  "HO1",
  "XB1",
  "GC1",
  "SI1",
  "HG1",
  "PL1",
  "PA1",
  "C1",
  "W1",
  "S1",
  "KC1",
  "SB1",
  "CC1",
  "CT1",
  "LC1",
  "LH1",
];
const FXC = ["EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "CNY"];

async function boardOf(entries, label) {
  const { board } = await loadFn("board");
  const rows = await board(entries.map((e) => e[1]));
  return {
    rows: entries.map(([code, sym, name]) => {
      const r = rows[sym] || {};
      return {
        security: `${code} ${label}`,
        name,
        price: r.price,
        change: r.change,
        changePct: r.changePct,
        ytdPct: r.ytdPct,
        low52: r.low52,
        high52: r.high52,
      };
    }),
    source:
      "Yahoo Finance public prices (some exchanges delayed up to 15 minutes)",
  };
}

const FN = {
  WIRP: {
    file: "wirp",
    what: "The Fed rate path priced by fed funds futures, per FOMC meeting: the rate expected after each meeting, the step in basis points and the odds of a 25 bp move",
    source:
      "CME 30-day fed funds futures via Yahoo (about 10 minutes delayed), EFFR from the New York Fed",
  },
  GC: {
    file: "gc",
    arg: "country",
    argHint:
      "country: US (default, the Treasury's official curve), USLIVE, UK, DE, JP...",
    what: "Government bond yield curve, 1 month to 30 years, against a week, a month and a year ago, with the 2s10s spread (10-year minus 2-year, in bp)",
    source:
      "US Treasury daily par yield curve; CNBC live yields for other countries",
  },
  BTMM: {
    file: "btmm",
    what: "US money markets: SOFR, EFFR with the Fed's target range, OBFR, Treasury bill yields and the 2- and 10-year notes",
    source: "New York Fed reference rates, US Treasury bill and note yields",
  },
  CBRT: {
    file: "cbrt",
    what: "Policy rates of the main central banks, with the date and size of each one's last move",
    source: "BIS central bank policy rates; New York Fed for the Fed's range",
  },
  ECST: {
    file: "ecst",
    what: "Main US economic statistics (CPI, core PCE, unemployment, payrolls, GDP, 2- and 10-year yields, fed funds, consumer sentiment), latest against previous, with history",
    source: "FRED, St. Louis Fed",
  },
  ECO: {
    file: "eco",
    what: "Economic calendar for today and the next four days: each release with actual, consensus and previous figures",
    source: "Nasdaq economic calendar (Forex Factory when Nasdaq is down)",
  },
  COT: {
    file: "cot",
    arg: "market",
    argHint:
      "market, for one market's history: ES, NQ, TY, EUR, JPY, BTC, GOLD...",
    what: "CFTC Commitments of Traders: how leveraged funds, asset managers, dealers and managed money are positioned in the main futures",
    source: "CFTC Commitments of Traders, weekly",
  },
  TOP: {
    file: "top",
    arg: "group",
    argHint: "ALL, TECH, CRYPTO or ECON",
    what: "Top market news headlines, newest first",
    source:
      "CNBC, WSJ, MarketWatch, FT, Bloomberg and Nasdaq public headline feeds",
  },
  MOST: {
    file: "most",
    what: "The day's most active US stocks, biggest gainers and biggest losers",
    source: "Nasdaq market movers",
  },
  WEI: {
    what: "World equity indices: level, change, % change, YTD and 52-week range",
    run: () =>
      boardOf(
        Object.entries(INDICES).map(([c, [s, n]]) => [c, s, n]),
        "Index",
      ),
    source: "Yahoo Finance public prices",
  },
  GLCO: {
    what: "Commodities (energy, metals, agriculture): front-month futures, change, YTD and 52-week range",
    run: () =>
      boardOf(
        GLCO.map((c) => [c, ...GENERICS[c]]),
        "Comdty",
      ),
    source: "Yahoo Finance front-month futures (delayed)",
  },
  FXC: {
    what: "Major currencies against the US dollar: rate and % change today",
    run: () =>
      boardOf(
        FXC.map((c) => [`${c}USD`, `${c}USD=X`, `${c} / USD`]),
        "Curncy",
      ),
    source: "Yahoo Finance FX",
  },
  CRYPTO: {
    what: "Crypto monitor: the most traded coins with price, 24-hour change and volume",
    run: async () => ({
      rows: (await data.cryptoScreener())
        .sort((a, b) => (b.volume || 0) - (a.volume || 0))
        .slice(0, 40),
      source: "Binance 24-hour tickers, live",
    }),
    source: "Binance 24-hour tickers, live",
  },
  EQS: {
    file: "eqs",
    arg: "preset",
    argHint:
      "preset words (MEGA, LARGE, MID, SMALL, TECH, FINANCE, HEALTH, ENERGY, GAINERS, LOSERS, ACTIVE...) or an object: sector, country, capMin, capMax, priceMin, priceMax, chgMin, chgMax, volMin (10B, 500M), sort (marketCap, changePct, volume, price), dir",
    what: "Equity screener over every US-listed stock: filter by sector, market cap, price, day's change, volume and country",
    source: "Nasdaq stock screener",
  },
  COMP: {
    file: "eq-comp",
    multi: true,
    arg: "range",
    argHint:
      "range: 1M, 6M, 1Y (default) or 5Y; security takes up to six, comma separated",
    what: "Compare up to six securities rebased to 100, with return, annualised volatility and maximum drawdown",
    source: "Daily bars from the chart sources",
  },
  DES: {
    file: "des",
    needs: true,
    what: "Company description and key data: sector, industry, market cap, dividend, 52-week range, YTD",
    source: "Nasdaq company profile (US stocks), Yahoo Finance prices",
  },
  FA: {
    needs: true,
    arg: "frequency",
    argHint: "annual (default) or quarterly",
    what: "Financial statements: income statement, balance sheet, cash flow and ratios (US stocks, thousands of dollars)",
    source: "Nasdaq financial statements",
    run: ({ sec, q }) =>
      info.financials(
        sec.id,
        /^q/i.test(q.frequency || "") ? "quarterly" : "annual",
      ),
  },
  CN: {
    needs: true,
    what: "News for one company or coin",
    source: "Nasdaq news by symbol, plus public RSS",
    run: ({ sec }) => info.news(sec.id),
  },
  CF: {
    file: "cf",
    needs: true,
    arg: "form",
    argHint: "ALL, 10-K, 10-Q, 8-K or 4",
    what: "SEC filings, newest first, with links",
    source: "SEC EDGAR",
  },
  INSD: {
    file: "insd",
    needs: true,
    what: "Insider buys and sells from SEC Form 4 filings: who, role, shares, price, value, date",
    source: "SEC Form 4 filings",
  },
  HDS: {
    file: "hds",
    needs: true,
    what: "Biggest institutional holders from 13F filings, with changes in their positions",
    source: "Nasdaq institutional holdings (13F, quarterly)",
  },
  OMON: {
    file: "omon",
    needs: true,
    arg: "expiry",
    argHint:
      "expiry number (1 = nearest, 2 = next...), add ALL for every strike",
    what: "Options chain for one expiry with implied volatility, delta, open interest, put/call ratios and the implied move",
    source: "CBOE delayed option quotes (about 15 minutes behind)",
    parse: (s) => ({
      expiry: /\d+/.exec(s)?.[0],
      strikes: /\bALL\b/i.test(s) ? "all" : undefined,
    }),
  },
  ANR: {
    file: "anr",
    needs: true,
    what: "Analyst ratings for US stocks: buy, hold and sell counts and the 12-month price targets",
    source: "Nasdaq analyst consensus",
  },
  EE: {
    file: "ee",
    needs: true,
    what: "Earnings estimates for US stocks: consensus EPS by quarter and year, revisions, recent surprises, next report date",
    source: "Zacks consensus via Nasdaq",
  },
  DVD: {
    file: "dvd",
    needs: true,
    what: "Dividend history, next ex-date, yield and how often it pays (US stocks)",
    source: "Nasdaq dividend history, Yahoo as the fallback",
  },
  ERN: {
    arg: "days",
    argHint: "days ahead, default 5",
    what: "Earnings calendar: which companies report in the next few days, with EPS forecasts",
    source: "Nasdaq earnings calendar",
    run: ({ q }) => info.earnings(Math.min(30, Number(q.days) || 5)),
  },
  HP: {
    needs: true,
    what: "Historical prices: the last 30 daily bars (use the history tool for more)",
    source: "Daily bars from the chart sources",
    run: async ({ sec }) => historyData(sec, { timeframe: "1D", bars: 30 }),
  },
  BTST: {
    file: "btst",
    needs: true,
    arg: "strategy",
    argHint: "a preset 1 to 5 or a strategy JSON (see the backtest tool)",
    what: "Backtest a strategy on daily, hourly or weekly bars, then run the quant checks",
    source: "Daily bars from the chart sources; the test runs on this computer",
  },
  CRED: { file: "cred", what: "Credit spreads: ICE BofA option-adjusted spreads for investment-grade and high-yield company bonds over Treasuries (index spreads, not single bonds or CDS)", source: "FRED (ICE BofA indices), posted the next business day" },
  AUCT: { file: "auct", what: "US Treasury auctions, coming up and just held, with results", source: "TreasuryDirect" },
  CT: { file: "ct", needs: true, what: "Futures curve for one market (e.g. CL1 COMDTY, GC1 COMDTY, ES1 COMDTY): each coming contract month's price, contango or backwardation", source: "Yahoo Finance futures contracts (about 10 minutes delayed)" },
  OVDV: { file: "ovdv", needs: true, arg: "expiry", argHint: "expiry number to show its smile", what: "Implied volatility surface of a US stock, ETF or index: the smile by strike and the term structure by expiry (with the VIX family for SPX)", source: "CBOE delayed option quotes" },
  PORT: {
    file: "eq-port",
    what: "Your portfolio (typed into PORT): value, profit and loss, weights, beta against the S&P 500, volatility and sector mix",
    source: "Your holdings in data/state.json, live prices",
  },
};

async function loadFn(name) {
  return import(pathToFileURL(path.join(FN_DIR, `${name}.js`)).href);
}

function headerOf(file) {
  try {
    return fs
      .readFileSync(path.join(FN_DIR, file), "utf8")
      .split("\n")
      .slice(0, 6)
      .filter((l) => l.startsWith("//"))
      .map((l) => l.slice(2).trim())
      .join(" ");
  } catch {
    return "";
  }
}

// Every function this install has: the table above (where the file exists) plus any lib/fn file it doesn't name.
function catalog() {
  const files = new Set(
    fs
      .readdirSync(FN_DIR)
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.slice(0, -3)),
  );
  const out = {};
  for (const [code, f] of Object.entries(FN))
    if (!f.file || files.has(f.file)) out[code] = { code, ...f };
  const named = new Set([
    "board",
    ...Object.values(FN)
      .map((f) => f.file)
      .filter(Boolean),
  ]);
  for (const name of [...files].sort()) {
    if (named.has(name)) continue;
    const head = headerOf(`${name}.js`);
    const m = /^\/api\/fn\/[a-z0-9-]+(?:\[?\?([^\s\]]*)\]?)?\s*:\s*(.+)$/.exec(
      head,
    );
    if (!m) continue; // a helper, not a function
    const code =
      /\bPowers ([A-Z]{2,8})\b/.exec(head)?.[1] ||
      name.replace(/[^a-z0-9]/gi, "").toUpperCase();
    if (out[code]) continue;
    const params = (m[1] || "")
      .split("&")
      .map((kv) => kv.split("=")[0])
      .filter(Boolean);
    out[code] = {
      code,
      file: name,
      needs: params.includes("symbol"),
      arg: params.find((p) => p !== "symbol"),
      what: m[2].split(/(?<=[.:])\s/)[0].replace(/[.:]$/, ""),
      source: "named in each result",
    };
  }
  return out;
}

function queryFor(f, args) {
  const q = {};
  if (args && typeof args === "object" && !Array.isArray(args)) {
    for (const [k, v] of Object.entries(args))
      if (v != null)
        q[k] = typeof v === "object" ? JSON.stringify(v) : String(v);
  } else if (args != null && String(args).trim() !== "") {
    const s = String(args).trim();
    if (f.parse) Object.assign(q, f.parse(s));
    else if (/^[\w.-]+=/.test(s))
      for (const [k, v] of new URLSearchParams(
        s.replace(/\s+(?=[\w.-]+=)/g, "&"),
      ))
        q[k] = v;
    else if (f.arg) q[f.arg] = s;
  }
  return q;
}

async function runFunction(code, security, args) {
  const fns = catalog();
  const key = String(code || "")
    .trim()
    .toUpperCase();
  const f = fns[key];
  if (!f)
    throw bad(
      `There's no function called ${code || "(blank)"}. Codes: ${Object.keys(fns).join(", ")}.`,
    );
  const q = queryFor(f, args);
  let sec = null;
  if (f.multi) {
    const secs = listOf(security).slice(0, 6).map(bbg.parseSecurity);
    if (!secs.length)
      throw bad(
        `${key} needs securities, comma separated, like AAPL US EQUITY,MSFT US EQUITY,SPX INDEX.`,
      );
    q.symbols = secs.map((s) => s.id).join(",");
  } else if (f.needs) {
    if (!String(security ?? "").trim())
      throw bad(
        `${key} needs a security, like AAPL US EQUITY. Use search_security to find one from a name.`,
      );
    sec = bbg.parseSecurity(security);
    q.symbol = sec.id;
  }
  const out = f.run
    ? await f.run({ sec, q })
    : await (await loadFn(f.file)).default(q);
  if (out == null)
    throw bad(
      `${key} has no data right now (the app may be in offline mode).`,
      503,
    );
  return { f, key, sec, out };
}

// ---------- one-line summaries ----------
const SUMMARY = {
  WIRP(d) {
    const m = d.meetings?.[0];
    if (!m) return null;
    const last = d.meetings.at(-1);
    const n = Math.abs(m.stepMoves ?? m.stepBp / 25);
    const dir = m.stepBp >= 0 ? "hike" : "cut";
    const odds =
      n < 1
        ? `${Math.round(n * 100)}% odds of a 25 bp ${dir}`
        : `${n.toFixed(1)} × 25 bp ${dir}s priced`;
    return `Next FOMC ${m.date}: futures price ${f2(m.after)}% after the meeting against ${f2(m.before)}% now (${sgn(m.stepBp)} bp, ${odds}). By ${last.date}: ${f2(last.after)}% (${sgn(last.cumBp)} bp in all). Fed target ${d.effr?.from}-${d.effr?.to}%, EFFR ${d.effr?.rate}% on ${d.effr?.date}.`;
  },
  GC(d) {
    const c = d.curves?.[0];
    if (!c) return null;
    const v = c.values || {};
    const pts = ["3M", "2Y", "5Y", "10Y", "30Y"]
      .filter((k) => fin(v[k]))
      .map((k) => `${k} ${f2(v[k])}%`);
    const s = d.spread;
    return `${d.name}, ${c.label || "latest"} ${c.date || ""}: ${pts.join(", ")}${s && fin(s.bp) ? `; 2s10s ${sgn(s.bp, 0)} bp${s.inverted ? " (inverted)" : ""}` : ""}.`;
  },
  BTMM(d) {
    const r = [...(d.funding || []), ...(d.bills || []), ...(d.notes || [])]
      .filter((x) => fin(x.rate))
      .map((x) => `${x.key} ${f2(x.rate)}%`);
    return `${r.join(", ")}${d.target ? `. Fed target ${d.target.from}-${d.target.to}%` : ""}.`;
  },
  DES(d) {
    const p = d.price || {};
    return `${d.name || d.symbol}${d.sector ? ` (${d.sector})` : ""}: ${p.price ?? "?"}, ${sgn(p.changePct, 2)}% today, ${sgn(p.ytdPct)}% this year, 52-week ${p.low52 ?? "?"} to ${p.high52 ?? "?"}.`;
  },
  OMON(d) {
    return `${d.symbol} ${d.price}: expiry ${d.expiry?.date} (${d.expiry?.days} days), implied move ±${f2(d.move?.pct, 1)}% (±$${f2(d.move?.dollars)}), 30-day IV ${f2(d.iv30, 1)}%, put/call open interest ${f2(d.totals?.pcOi)}.`;
  },
  BTST(d) {
    const r = d.results || {};
    return `${d.strategy} on ${d.symbol} (${d.timeframe}, ${d.from} to ${d.to}): ${sgn(r.netResultPct)}% against buy-and-hold ${sgn(r.buyAndHoldPct)}%, worst drop ${f2(r.maxDrawdownPct, 1)}%, ${r.trades} trades, ${f2(r.winningTradesPct, 0)}% winners. Quant checks passed: ${d.quantChecks?.passed} of ${d.quantChecks?.of}.`;
  },
  CBRT(d) {
    return `${d.rows?.length} central banks: ${(d.rows || [])
      .slice(0, 6)
      .map((r) => `${r.bank} ${r.rate}%`)
      .join(", ")}.`;
  },
};

function summarize(key, f, out) {
  try {
    const s = SUMMARY[key]?.(out);
    if (s) return s;
  } catch {
    /* fall through to the plain summary */
  }
  const arr = Object.entries(out || {})
    .filter(([, v]) => Array.isArray(v))
    .sort((a, b) => b[1].length - a[1].length)[0];
  return `${key}: ${f.what.split(/[:(]/)[0].trim()}${arr ? ` (${arr[1].length} ${arr[0]})` : ""}.`;
}

// ---------- trimming ----------
const SERIES = /history|spark|series|bars|candles|equity|points/i;
function trimDeep(v, cap, key = "") {
  if (Array.isArray(v)) {
    const series = SERIES.test(key);
    const n = series ? Math.max(3, Math.floor(cap / 3)) : cap;
    const kept = v.length > n ? (series ? v.slice(-n) : v.slice(0, n)) : v;
    const out = kept.map((x) => trimDeep(x, cap, key));
    if (v.length > n)
      out[series ? "unshift" : "push"](`(${v.length - n} more not shown)`);
    return out;
  }
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v))
      if (k !== "spark") o[k] = trimDeep(x, cap, k);
    return o;
  }
  if (typeof v === "string" && v.length > 500) return `${v.slice(0, 500)}…`;
  if (fin(v) && !Number.isInteger(v)) return Number(v.toPrecision(8));
  return v;
}
function compact(out) {
  let s = "";
  for (const cap of [80, 40, 20, 10, 5, 3]) {
    s = JSON.stringify(trimDeep(out, cap));
    if (s.length <= TEXT_BUDGET) return s;
  }
  return `${s.slice(0, TEXT_BUDGET)} …(cut to fit)`;
}

const answer = (summary, out) => {
  const src =
    out?.source && typeof out.source === "string"
      ? `\nSource: ${out.source}`
      : "";
  return `${summary}${src}\n\n${compact(out)}`;
};

// ---------- history ----------
const TFS = ["1m", "5m", "15m", "30m", "1h", "4h", "1D", "1W", "1M"];
async function historyData(
  sec,
  { timeframe = "1D", bars = 60, start, end } = {},
) {
  const tf = TFS.find((t) => t === timeframe) || TFS.find((t) => t.toLowerCase() === String(timeframe).toLowerCase()) || String(timeframe);
  let secs;
  try {
    secs = parseTf(tf).seconds;
  } catch {
    throw bad(`timeframe must be one of ${TFS.join(", ")}.`);
  }
  const n = Math.max(2, Math.min(400, Math.round(Number(bars) || 60)));
  const from = start ? bbg.parseDate(start) : null;
  const to = end ? bbg.parseDate(end) : null;
  const limit = from
    ? Math.min(
        20000,
        Math.ceil(
          (Date.now() - Date.parse(`${from}T00:00:00Z`)) / 1000 / secs,
        ) + 10,
      )
    : n;
  const r = await data.getCandles(sec.id, tf, limit);
  const intra = isIntraday(tf);
  const stamp = (t) =>
    intra
      ? new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")
      : day(t);
  let c = r.candles.filter(
    (b) => (!from || day(b.time) >= from) && (!to || day(b.time) <= to),
  );
  const notes = [...(r.notes || [])];
  if (c.length > 400) {
    notes.push(
      `${c.length} bars in that range; showing the last 400. Use a longer timeframe for the whole range.`,
    );
    c = c.slice(-400);
  }
  if (!from) c = c.slice(-n);
  const p = (v) => (fin(v) ? Number(v.toPrecision(7)) : null);
  return {
    security: bbg.labelOf(sec),
    symbol: r.symbol,
    timeframe: tf,
    columns: ["time", "open", "high", "low", "close", "volume"],
    rows: c.map((b) => [
      stamp(b.time),
      p(b.open),
      p(b.high),
      p(b.low),
      p(b.close),
      b.volume || 0,
    ]),
    notes,
    source: `${r.provider}${intra ? "" : " daily bars"}`,
  };
}

function historySummary(h) {
  const rows = h.rows;
  if (!rows.length)
    return `${h.security}: no ${h.timeframe} bars in that range.`;
  const hi = Math.max(...rows.map((r) => r[2]));
  const lo = Math.min(...rows.map((r) => r[3]));
  const chg = (rows.at(-1)[4] / rows[0][1] - 1) * 100;
  return `${h.security}, ${rows.length} ${h.timeframe} bars from ${rows[0][0]} to ${rows.at(-1)[0]}: last close ${rows.at(-1)[4]}, high ${hi}, low ${lo}, ${sgn(chg, 2)}% over the period.`;
}

// ---------- the running app (alerts live there) ----------
async function runningApp() {
  const first = Number(process.env.PORT) || 3787;
  const same = (a) =>
    !!a && path.resolve(a).toLowerCase() === path.resolve(ROOT).toLowerCase();
  const hits = await Promise.all(
    Array.from({ length: 21 }, async (_, i) => {
      try {
        const h = await (
          await fetch(`http://127.0.0.1:${first + i}/api/health`, {
            signal: AbortSignal.timeout(2000),
          })
        ).json();
        return h.app === "amber-terminal" && same(h.root)
          ? `http://127.0.0.1:${first + i}`
          : null;
      } catch {
        return null;
      }
    }),
  );
  return hits.find(Boolean) || null;
}

async function appCall(base, method, url, body) {
  const r = await fetch(base + url, {
    method,
    headers: { "x-qt": "1", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw bad(j.error || `The app answered ${r.status}`, r.status);
  return j;
}

const OPS = {
  above: "crossesAbove",
  below: "crossesBelow",
  crosses_above: "crossesAbove",
  crosses_below: "crossesBelow",
  crosses: "crosses",
  ">": ">",
  "<": "<",
  ">=": ">=",
  "<=": "<=",
  crossesAbove: "crossesAbove",
  crossesBelow: "crossesBelow",
};

// ---------- the strategy format, for the backtest tool ----------
const STRATEGY_HELP = `A strategy is JSON. Rules are { left, op, right }; every rule in a list must be true. Operands: a number, a price field (open, high, low, close, volume, hl2, hlc3, ohlc4), an indicator key, or an indicator output like "macd.signal" or "bb.upper". ops: >, <, >=, <=, crossesAbove, crossesBelow, crosses. Signals are read on a bar's close and filled at the next bar's open.
{
  "name": "EMA cross",
  "indicators": { "fast": { "id": "ema", "params": { "length": 9 } }, "slow": { "id": "ema", "params": { "length": 21 } } },
  "entryLong": [ { "left": "fast", "op": "crossesAbove", "right": "slow" } ],
  "exitLong": [ { "left": "fast", "op": "crossesBelow", "right": "slow" } ],
  "entryShort": [], "exitShort": [],
  "exitMatch": "all",            // or "any": exit on whichever exit rule fires first
  "maxBarsInTrade": 0,           // time exit after this many bars (0 = off)
  "stopLossPct": 0, "takeProfitPct": 0, "trailingStopPct": 0,
  "initialCapital": 10000, "positionPct": 100, "feePct": 0.1, "slippagePct": 0.05
}
Indicators (id, params, outputs): sma/ema/wma/hma/vwma { length } value; rsi { length } value; macd {} macd, signal, hist; bb { length, mult } upper, basis, lower; donchian { length } upper, basis, lower; kc upper, basis, lower; atr { length } value; stoch k, d; adx adx; dmi adx, plus, minus; supertrend { atrLength, factor } with "output": "direction" (below 0 = uptrend); roc, mom, cci, mfi, willr, obv, vwap value.
Presets: 1 EMA cross (9/21), 2 RSI mean reversion (30/55), 3 Supertrend follow, 4 MACD + 200 EMA trend filter, 5 Bollinger breakout.`;

// ---------- tools ----------
const SEC_HINT =
  "Write securities the terminal's way: AAPL US EQUITY, VOD LN EQUITY, SPX INDEX, CL1 COMDTY, EURUSD CURNCY, XBTUSD CURNCY (or BTC). Use search_security to find one from a company name.";

function functionCatalogText(fns) {
  return Object.values(fns)
    .map(
      (f) =>
        `${f.code}${f.multi ? " [securities]" : f.needs ? " [security]" : ""}: ${f.what}${f.argHint ? `. args: ${f.argHint}` : f.arg ? `. args: ${f.arg}` : ""}`,
    )
    .join("\n");
}

const TOOLS = {
  terminal_function: {
    title: "Run a terminal function",
    describe: (fns) =>
      `Runs one of Amber Terminal's Bloomberg-style functions on free public data. Returns a one-line summary, the source, and the function's data as JSON (long tables trimmed). Pick the code by what you need:\n${functionCatalogText(fns)}\n[security] means it needs \`security\`. ${SEC_HINT} For prices use quote, for price history use history, for a strategy test use backtest.`,
    schema: (fns) => ({
      type: "object",
      properties: {
        function: {
          type: "string",
          enum: Object.keys(fns),
          description:
            "The function code, e.g. WIRP for the Fed rate path, GC for the yield curve, DES for a company.",
        },
        security: {
          type: "string",
          description:
            "For functions marked [security]: e.g. AAPL US EQUITY. COMP takes up to six, comma separated.",
        },
        args: {
          anyOf: [{ type: "string" }, { type: "number" }, { type: "object" }],
          description:
            "Optional. A word or number the function takes (its args in the list above, e.g. GC 'UK', COT 'GOLD', OMON '2', FA 'quarterly'), or an object of query parameters.",
        },
      },
      required: ["function"],
    }),
    async run(a) {
      const { f, key, out } = await runFunction(a.function, a.security, a.args);
      return answer(summarize(key, f, out), out);
    },
  },
  quote: {
    title: "Quotes",
    describe: () =>
      `Latest price, change and % change on the day for one or more securities (stocks, ETFs, indices, futures, currencies, crypto), with the date of the price, this year's change and the 52-week range. ${SEC_HINT} Public quotes, some up to 15 minutes behind; crypto is live.`,
    schema: () => ({
      type: "object",
      properties: {
        securities: {
          anyOf: [
            { type: "array", items: { type: "string" } },
            { type: "string" },
          ],
          description:
            'One or more securities, e.g. ["AAPL US EQUITY", "SPX INDEX", "CL1 COMDTY"].',
        },
      },
      required: ["securities"],
    }),
    async run(a) {
      const secs = listOf(a.securities).slice(0, 30);
      if (!secs.length)
        throw bad("Give at least one security, like AAPL US EQUITY.");
      const out = await bbg.bdp({
        securities: secs,
        fields: [
          "NAME",
          "PX_LAST",
          "CHG_NET_1D",
          "CHG_PCT_1D",
          "CHG_PCT_YTD",
          "LOW_52WEEK",
          "HIGH_52WEEK",
          "LAST_UPDATE_DT",
        ],
      });
      const line = out.rows
        .map((r) =>
          fin(r.PX_LAST)
            ? `${r.security} ${r.PX_LAST} (${sgn(r.CHG_NET_1D, 2)}, ${sgn(r.CHG_PCT_1D, 2)}%)`
            : `${r.security}: no price`,
        )
        .join("; ");
      return answer(`${line}.`, out);
    },
  },
  history: {
    title: "Price history",
    describe: () =>
      `Price history (open, high, low, close, volume) for one security: the last N bars, or a date range. Timeframes: ${TFS.join(", ")}. Daily history goes back 10 years or more for most markets; free intraday stock data is short. ${SEC_HINT}`,
    schema: () => ({
      type: "object",
      properties: {
        security: {
          type: "string",
          description: "e.g. AAPL US EQUITY, SPX INDEX, BTC",
        },
        timeframe: {
          type: "string",
          enum: TFS,
          description: "Bar size, default 1D",
        },
        bars: {
          type: "integer",
          minimum: 2,
          maximum: 400,
          description:
            "How many recent bars, default 60 (ignored when start is given)",
        },
        start: {
          type: "string",
          description:
            "Optional start date, YYYY-MM-DD or relative like -6M, -1Y",
        },
        end: { type: "string", description: "Optional end date, YYYY-MM-DD" },
      },
      required: ["security"],
    }),
    async run(a) {
      const h = await historyData(bbg.parseSecurity(a.security), a);
      return answer(historySummary(h), h);
    },
  },
  search_security: {
    title: "Find a security",
    describe: () =>
      "Find a security by company name or ticker (stocks worldwide, ETFs, crypto, currencies) and get its terminal label, like 'AAPL US Equity', 'VOD LN Equity' or 'XBTUSD Curncy', to use with the other tools.",
    schema: () => ({
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "A name or ticker, e.g. 'nvidia', 'vodafone', 'gold'",
        },
      },
      required: ["query"],
    }),
    async run(a) {
      const q = String(a.query || "").trim();
      if (!q) throw bad("Give a name or ticker to search for.");
      const rows = (await data.search(q))
        .slice(0, 15)
        .map((r) => ({
          security: bbg.labelForSymbol(r.symbol),
          name: r.name?.trim(),
          type: r.type,
          exchange: r.exchange,
          sourceSymbol: r.symbol,
        }));
      const out = {
        query: q,
        results: rows,
        source:
          "Nasdaq and Yahoo symbol search, the crypto exchanges' symbol lists",
      };
      return answer(
        rows.length
          ? `Best match for "${q}": ${rows[0].security} (${rows[0].name}).`
          : `Nothing found for "${q}".`,
        out,
      );
    },
  },
  list_functions: {
    title: "List the functions",
    describe: () =>
      "Every terminal function code: what it shows, whether it needs a security, the arguments it takes and where its data comes from.",
    schema: () => ({ type: "object", properties: {} }),
    async run() {
      const fns = catalog();
      const rows = Object.values(fns).map((f) => ({
        code: f.code,
        what: f.what,
        needs: f.multi
          ? "securities"
          : f.needs
            ? "a security"
            : "nothing (market-wide)",
        args: f.argHint || f.arg || null,
        source: f.source,
      }));
      return `${rows.length} functions. Run any of them with terminal_function.\n\n${JSON.stringify(rows)}`;
    },
  },
  backtest: {
    title: "Backtest a strategy",
    describe: () =>
      `Backtest a trading rule on one security's history, then run the quant checks (out-of-sample, nearby settings, double costs, trade reshuffle). Turn a plain-English rule into the strategy JSON below, or use a preset number. Results are what the rules did on past prices, not a forecast.\n${STRATEGY_HELP}`,
    schema: () => ({
      type: "object",
      properties: {
        security: {
          type: "string",
          description: "e.g. SPY US EQUITY, BTC, GC1 COMDTY",
        },
        strategy: {
          anyOf: [
            { type: "object" },
            { type: "integer", minimum: 1, maximum: 5 },
            { type: "string" },
          ],
          description:
            "A strategy object in the format above, or a preset number 1 to 5",
        },
        timeframe: {
          type: "string",
          enum: ["D", "H", "W"],
          description: "D daily (default), H hourly, W weekly",
        },
      },
      required: ["security", "strategy"],
    }),
    async run(a) {
      const strategy =
        typeof a.strategy === "object"
          ? JSON.stringify(a.strategy)
          : String(a.strategy ?? "1");
      const { f, key, out } = await runFunction("BTST", a.security, {
        strategy,
        tf: a.timeframe || "D",
      });
      return answer(summarize(key, f, out), out);
    },
  },
  workspace: {
    title: "My watchlist and portfolio",
    describe: () =>
      "The user's own watchlists and portfolio saved in Amber Terminal, with live prices: each watchlist security's price and change, and for the portfolio its value, profit and loss, weights, beta and volatility. Use it when the user says 'my watchlist', 'my portfolio', 'my stocks' or 'my positions'.",
    schema: () => ({
      type: "object",
      properties: {
        with_prices: {
          type: "boolean",
          description:
            "Add live prices and the portfolio's valuation (default true)",
        },
      },
    }),
    async run(a) {
      const st = store.read("state", {}) || {};
      const lists =
        st.amberWatch?.lists && typeof st.amberWatch.lists === "object"
          ? st.amberWatch.lists
          : {};
      const holdings = Array.isArray(st.amberPort)
        ? st.amberPort
        : Array.isArray(st.amberPort?.holdings)
          ? st.amberPort.holdings
          : [];
      const prices = a.with_prices !== false;
      const out = { watchlists: {}, notes: [] };
      for (const [name, items] of Object.entries(lists))
        out.watchlists[name] = (Array.isArray(items) ? items : [])
          .map((x) =>
            typeof x === "string"
              ? x
              : x?.sec || x?.code || x?.ticker || x?.symbol,
          )
          .filter(Boolean);
      const all = [...new Set(Object.values(out.watchlists).flat())].slice(
        0,
        40,
      );
      if (!all.length)
        out.notes.push(
          "No watchlist saved yet. Type W in the terminal to start one.",
        );
      else if (prices)
        out.watchlistQuotes = (
          await bbg.bdp({
            securities: all,
            fields: [
              "NAME",
              "PX_LAST",
              "CHG_NET_1D",
              "CHG_PCT_1D",
              "CHG_PCT_YTD",
            ],
          })
        ).rows;
      if (!holdings.length) {
        out.notes.push(
          "No portfolio saved yet. Type PORT in the terminal to add holdings.",
        );
        out.portfolio = null;
      } else if (prices && fs.existsSync(path.join(FN_DIR, "eq-port.js"))) {
        out.portfolio = await (
          await loadFn("eq-port")
        )
          .default({})
          .catch((e) => {
            out.notes.push(
              `The portfolio couldn't be valued just now: ${e.message}`,
            );
            return { holdings };
          });
      } else out.portfolio = { holdings };
      out.source =
        "Your lists in data/state.json; prices from the chart sources";
      const pv = out.portfolio;
      const total = pv && (pv.totals?.value ?? pv.total?.value ?? pv.value);
      const summary = `${Object.keys(out.watchlists).length} watchlist(s) with ${all.length} securities; ${holdings.length} portfolio holding(s)${fin(total) ? `, worth ${total.toFixed(2)} USD` : ""}.`;
      return answer(summary, out);
    },
  },
  alerts: {
    title: "Price alerts",
    describe: () =>
      "List the price alerts set in Amber Terminal, or create one (e.g. 'tell me when AAPL goes above 350'). Alerts are checked by the running app, which shows them on screen and can post to a webhook; creating one needs the app open.",
    schema: () => ({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create"],
          description: "list (default) or create",
        },
        security: {
          type: "string",
          description: "For create: e.g. AAPL US EQUITY, BTC",
        },
        condition: {
          type: "string",
          enum: ["above", "below", "crosses"],
          description: "For create: price crosses above, below, or either way",
        },
        level: { type: "number", description: "For create: the price level" },
        timeframe: {
          type: "string",
          description: "Bars the alert checks, default 1m",
        },
        message: {
          type: "string",
          description: "Optional text shown when it fires",
        },
      },
    }),
    async run(a) {
      const { describe } = await import("../lib/alerts.js");
      const base = await runningApp();
      const show = (x) => ({
        id: x.id,
        security: bbg.labelForSymbol(x.symbol),
        alert: describe({ ...x, message: "" }),
        message: x.message || undefined,
        active: x.active,
        fired: x.fired,
        timeframe: x.tf,
        created: x.createdAt,
      });
      if ((a.action || "list") === "list") {
        const list = base
          ? await appCall(base, "GET", "/api/alerts")
          : store.read("alerts", []);
        const out = {
          alerts: list.map(show),
          source: base
            ? "The running app"
            : "data/alerts.json (the app isn't running, so these aren't being checked right now)",
        };
        return answer(
          `${list.length} alert(s), ${list.filter((x) => x.active).length} active.`,
          out,
        );
      }
      if (a.action !== "create")
        throw bad('action must be "list" or "create".');
      if (!base)
        throw bad(
          "Alerts are checked by the running app. Start it with node scripts/launch.js, then ask again.",
          409,
        );
      const sec = bbg.parseSecurity(a.security);
      const op = OPS[a.condition || "above"];
      if (!op) throw bad("condition must be above, below or crosses.");
      if (!fin(Number(a.level))) throw bad("Give the price level as a number.");
      const sym = await data.resolve(sec.id);
      const made = await appCall(base, "POST", "/api/alerts", {
        symbol: sym.id,
        tf: a.timeframe || "1m",
        left: "close",
        op,
        right: Number(a.level),
        message: a.message || "",
      });
      return answer(`Alert set: ${describe({ ...made, message: "" })}.`, {
        alert: show(made),
        source: "The running app",
      });
    },
  },
};

// ---------- JSON-RPC ----------
const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

export async function handle(msg) {
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map(handle))).filter(Boolean);
    return out.length ? out : null;
  }
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string")
    return msg && "id" in msg
      ? fail(msg.id ?? null, -32600, "Invalid request")
      : null;
  const notification = !("id" in msg);
  const { id, method, params = {} } = msg;
  try {
    switch (method) {
      case "initialize":
        return ok(id, {
          protocolVersion: PROTOCOLS.includes(params.protocolVersion)
            ? params.protocolVersion
            : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "amber",
            title: "Amber Terminal",
            version: VERSION,
          },
          instructions:
            "Amber Terminal: a free, Bloomberg-style market terminal on public data. Use terminal_function for the function codes (WIRP Fed path, GC yield curve, DES company, OMON options...), quote for prices, history for bars, search_security to find a ticker, backtest to test a rule, workspace for the user's own watchlist and portfolio. Name the source and the date of every number you use.",
        });
      case "ping":
        return notification ? null : ok(id, {});
      case "tools/list": {
        const fns = catalog();
        return ok(id, {
          tools: Object.entries(TOOLS).map(([name, t]) => ({
            name,
            title: t.title,
            description: t.describe(fns),
            inputSchema: t.schema(fns),
          })),
        });
      }
      case "tools/call": {
        const t = TOOLS[params.name];
        if (!t)
          return fail(
            id,
            -32602,
            `Unknown tool: ${params.name}. Tools: ${Object.keys(TOOLS).join(", ")}`,
          );
        try {
          return ok(id, {
            content: [
              { type: "text", text: await t.run(params.arguments || {}) },
            ],
          });
        } catch (e) {
          return ok(id, {
            content: [{ type: "text", text: e.message || String(e) }],
            isError: true,
          });
        }
      }
      default:
        return notification
          ? null
          : fail(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    return notification
      ? null
      : fail(id, -32603, e.message || "Internal error");
  }
}

function serve() {
  // stdout carries the protocol only; anything a library prints goes to stderr.
  for (const k of ["log", "info", "debug", "warn"])
    console[k] = (...a) => console.error(...a);
  const write = (m) => m && process.stdout.write(`${JSON.stringify(m)}\n`);
  let pending = 0;
  let closed = false;
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return write(
        fail(
          null,
          -32700,
          "Parse error: each message must be one line of JSON",
        ),
      );
    }
    pending++;
    try {
      write(await handle(msg));
    } finally {
      pending--;
      if (closed && !pending) process.exit(0);
    }
  });
  rl.on("close", () => {
    closed = true;
    if (!pending) process.exit(0);
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(
      `Amber Terminal MCP server ${VERSION}: lets your own Claude use the terminal.\n\nConnect Claude Code (run this once):\n\n  ${bbg.mcpCommand(ROOT)}\n\nThen ask Claude things like "What does the futures market price for the next Fed meeting?"\nOther MCP clients: run "node ${path.join(ROOT, "scripts", "mcp.js")}" over stdio.\nTools: ${Object.keys(TOOLS).join(", ")}.`,
    );
    process.exit(0);
  }
  const relaunched = relaunchForProxy();
  if (relaunched) process.exit(await relaunched);
  serve();
}
