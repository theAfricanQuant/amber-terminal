// BDP and BDH, Bloomberg's Excel functions, as local URLs, plus the Bloomberg-style labels the API, the MCP server
// and search share.
//   GET /api/bdp?securities=AAPL US EQUITY,SPX INDEX&fields=NAME,PX_LAST,CHG_PCT_1D&format=csv
//   GET /api/bdh?security=AAPL US EQUITY&fields=PX_LAST,PX_VOLUME&start=2025-01-01&end=2025-12-31&per=W&format=csv
// Each field is filled from the free sources the screens use: daily bars for prices (Nasdaq, the crypto exchanges,
// Yahoo), Nasdaq's company profile and EPS history for US stocks. A field it can't fill comes back empty with a note.
import path from "node:path";
import * as data from "./providers.js";
import { toSecurity, INDICES, GENERICS } from "../public/js/securities.js";
import des from "./fn/des.js";

const bad = (message, status = 400) =>
  Object.assign(new Error(message), { status });

// ---------- fields ----------
// bdp: works in BDP. bdh: works in BDH. us: US-listed stocks only.
export const FIELDS = {
  NAME: { bdp: 1, what: "Name of the company, index, future or currency pair" },
  TICKER: { bdp: 1, what: "Ticker" },
  MARKET_SECTOR_DES: { bdp: 1, what: "Equity, Index, Comdty or Curncy" },
  EXCH_CODE: { bdp: 1, what: "Exchange code (US, LN, GR, JP...)" },
  CRNCY: { bdp: 1, what: "Currency the price is quoted in (GBp is pence)" },
  PX_LAST: {
    bdp: 1,
    bdh: 1,
    what: "Last price: the latest daily bar's close, live during the session",
  },
  PX_OPEN: { bdp: 1, bdh: 1, what: "Open" },
  PX_HIGH: { bdp: 1, bdh: 1, what: "High" },
  PX_LOW: { bdp: 1, bdh: 1, what: "Low" },
  PX_VOLUME: { bdp: 1, bdh: 1, what: "Volume (summed over the period in BDH)" },
  VOLUME: { bdp: 1, bdh: 1, what: "Same as PX_VOLUME" },
  PX_CLOSE_1D: { bdp: 1, what: "Previous close" },
  CHG_NET_1D: { bdp: 1, bdh: 1, what: "Change on the day" },
  CHG_PCT_1D: { bdp: 1, bdh: 1, what: "% change on the day" },
  CHG_PCT_5D: { bdp: 1, what: "% change over 5 trading days" },
  CHG_PCT_1M: { bdp: 1, what: "% change over 1 month" },
  CHG_PCT_YTD: { bdp: 1, what: "% change this year" },
  CHG_PCT_1YR: { bdp: 1, what: "% change over 1 year" },
  HIGH_52WEEK: { bdp: 1, what: "52-week high" },
  LOW_52WEEK: { bdp: 1, what: "52-week low" },
  VOLUME_AVG_30D: {
    bdp: 1,
    what: "Average daily volume, last 30 trading days",
  },
  LAST_UPDATE_DT: { bdp: 1, what: "Date of the latest price" },
  CUR_MKT_CAP: { bdp: 1, us: 1, what: "Market capitalisation, US dollars" },
  GICS_SECTOR_NAME: {
    bdp: 1,
    us: 1,
    what: "Sector (Nasdaq's sector names, close to GICS)",
  },
  GICS_INDUSTRY_NAME: {
    bdp: 1,
    us: 1,
    what: "Industry (Nasdaq's industry names)",
  },
  EQY_DVD_YLD_IND: { bdp: 1, us: 1, what: "Indicated dividend yield, %" },
  DVD_EX_DT: { bdp: 1, us: 1, what: "Latest ex-dividend date" },
  PE_RATIO: { bdp: 1, us: 1, what: "Price over the last four quarters' EPS" },
  TRAIL_12M_EPS: {
    bdp: 1,
    us: 1,
    what: "EPS over the last four reported quarters (Zacks, via Nasdaq)",
  },
  BEST_TARGET_PRICE: {
    bdp: 1,
    us: 1,
    what: "Analysts' consensus 12-month price target",
  },
};
export const BDP_FIELDS = Object.keys(FIELDS).filter((f) => FIELDS[f].bdp);
export const BDH_FIELDS = Object.keys(FIELDS).filter((f) => FIELDS[f].bdh);
const PRICE_FIELDS = new Set(
  BDP_FIELDS.filter(
    (f) =>
      f.startsWith("PX_") ||
      f.startsWith("CHG_") ||
      /52WEEK|VOLUME|LAST_UPDATE/.test(f),
  ),
);
const PROFILE_FIELDS = new Set([
  "CUR_MKT_CAP",
  "GICS_SECTOR_NAME",
  "GICS_INDUSTRY_NAME",
  "EQY_DVD_YLD_IND",
  "DVD_EX_DT",
  "BEST_TARGET_PRICE",
]);
const EPS_FIELDS = new Set(["PE_RATIO", "TRAIL_12M_EPS"]);

// ---------- securities and labels ----------
const SUFFIX = {
  L: "LN",
  DE: "GR",
  PA: "FP",
  AS: "NA",
  MC: "SM",
  MI: "IM",
  SW: "SW",
  T: "JP",
  HK: "HK",
  TO: "CN",
  AX: "AU",
  NS: "IN",
  BO: "IB",
  KS: "KS",
  TW: "TT",
  SI: "SP",
  SA: "BZ",
  MX: "MM",
  ST: "SS",
  OL: "NO",
  CO: "DC",
  HE: "FH",
  BR: "BB",
  IR: "ID",
  LS: "PL",
  VI: "AV",
};
const EXCH_CCY = {
  LN: "GBp",
  GR: "EUR",
  GY: "EUR",
  FP: "EUR",
  NA: "EUR",
  SM: "EUR",
  IM: "EUR",
  FH: "EUR",
  BB: "EUR",
  ID: "EUR",
  PL: "EUR",
  AV: "EUR",
  SW: "CHF",
  SE: "CHF",
  JP: "JPY",
  JT: "JPY",
  HK: "HKD",
  CN: "CAD",
  CT: "CAD",
  AU: "AUD",
  AT: "AUD",
  IN: "INR",
  IS: "INR",
  IB: "INR",
  KS: "KRW",
  TT: "TWD",
  SP: "SGD",
  BZ: "BRL",
  MM: "MXN",
  SS: "SEK",
  NO: "NOK",
  DC: "DKK",
};
const SECTOR_DES = {
  EQUITY: "Equity",
  INDEX: "Index",
  CMDTY: "Comdty",
  CRNCY: "Curncy",
  CRYPTO: "Curncy",
};

// "AAPL US EQUITY", "spx index", "BTC" -> the terminal's security object (id is the source symbol).
export function parseSecurity(text) {
  const words = String(text ?? "")
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
  const sec = words.length ? toSecurity(words) : null;
  if (!sec)
    throw bad(
      `"${String(text ?? "").slice(0, 40)}" isn't a security. Write it the terminal's way: AAPL US EQUITY, VOD LN EQUITY, SPX INDEX, CL1 COMDTY, EURUSD CURNCY or BTC.`,
    );
  return sec;
}

const roundTrip = (labels, id) =>
  labels.find((l) => toSecurity(l.toUpperCase().split(" "))?.id === id) || null;

// A source symbol (US:AAPL, YAHOO:VOD.L, YAHOO:^GSPC, FX:EURUSD, BINANCE:BTCUSDT) -> "VOD LN Equity". Every label is
// checked by parsing it back, and a symbol with no Bloomberg-style form is returned as it is (it still works).
export function labelForSymbol(sym) {
  const s = String(sym || "");
  const [ex, t] = s.includes(":")
    ? [s.slice(0, s.indexOf(":")), s.slice(s.indexOf(":") + 1)]
    : ["", s];
  const c = [];
  if (ex === "US") c.push(`${t} US Equity`);
  if (ex === "FX") c.push(`${t} Curncy`);
  if (ex === "BINANCE" && t.endsWith("USDT")) {
    const b = t.slice(0, -4);
    c.push(`${b === "BTC" ? "XBT" : b}USD Curncy`, `${b} Crypto`);
  }
  if (ex === "YAHOO" || ex === "") {
    const ix = Object.entries(INDICES).find(([, v]) => v[0] === t);
    const g = Object.entries(GENERICS).find(([, v]) => v[0] === t);
    const m = /^(.+)\.([A-Z]{1,2})$/.exec(t);
    if (ix) c.push(`${ix[0]} Index`);
    if (g) c.push(`${g[0]} Comdty`);
    if (t.startsWith("^")) c.push(`${t.slice(1)} Index`);
    if (t.endsWith("=F")) c.push(`${t.slice(0, -2)}1 Comdty`);
    if (/^[A-Z]{6}=X$/.test(t)) c.push(`${t.slice(0, 6)} Curncy`);
    if (m && SUFFIX[m[2]]) c.push(`${m[1]} ${SUFFIX[m[2]]} Equity`);
    if (ex === "" && t.endsWith("USDT"))
      c.push(
        `${t.slice(0, -4) === "BTC" ? "XBT" : t.slice(0, -4)}USD Curncy`,
        `${t.slice(0, -4)} Crypto`,
      );
    if (/^[A-Z0-9.-]+$/.test(t)) c.push(`${t} US Equity`);
  }
  const want = ["US", "YAHOO", "BINANCE"].includes(ex) ? t : s;
  return roundTrip(c, want) || s;
}

export function labelOf(sec) {
  const c = [];
  if (sec.sector === "CRYPTO")
    c.push(
      `${sec.ticker === "BTC" ? "XBT" : sec.ticker}USD Curncy`,
      `${sec.ticker} Crypto`,
    );
  else if (!/[:=^]/.test(sec.ticker))
    c.push(
      sec.sector === "EQUITY"
        ? `${sec.ticker} ${sec.exch || "US"} Equity`
        : `${sec.ticker} ${SECTOR_DES[sec.sector] || "Equity"}`,
    );
  return roundTrip(c, sec.id) || labelForSymbol(sec.id);
}

const isUsStock = (sec) =>
  sec.sector === "EQUITY" && /^[A-Z0-9-]{1,10}$/.test(sec.id);

// The line that connects Claude Code to this install.
export function mcpCommand(dir) {
  const file = path.join(dir, "scripts", "mcp.js");
  return `claude mcp add --scope user amber -- node ${/\s/.test(file) ? `"${file}"` : file}`;
}

// ---------- small helpers ----------
const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
const fin = (v) => typeof v === "number" && Number.isFinite(v);
const rnd = (v, dp = 6) => (fin(v) ? Number(v.toFixed(dp)) : null);
// Prices to 7 significant figures: Yahoo sends floats like 7681.450195 for 7681.45.
const px = (v) => (fin(v) ? Number(v.toPrecision(7)) : null);
const net = (a, b) => (fin(a) && fin(b) ? rnd(px(a) - px(b)) : null);
const pctChg = (a, b) =>
  fin(a) && fin(b) && b ? rnd((a / b - 1) * 100, 4) : null;
const numOf = (s) => {
  const v = parseFloat(String(s ?? "").replace(/[$,%\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};
const MONTHS = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};
const isoOf = (s) => {
  const m = /^([A-Z][a-z]{2})\w* (\d{1,2}), (\d{4})$/.exec(
    String(s ?? "").trim(),
  );
  return m && MONTHS[m[1]]
    ? `${m[3]}-${String(MONTHS[m[1]]).padStart(2, "0")}-${m[2].padStart(2, "0")}`
    : null;
};
const listOf = (v, max) =>
  [
    ...new Set(
      (Array.isArray(v) ? v : String(v ?? "").split(","))
        .map((s) => String(s).trim())
        .filter(Boolean),
    ),
  ].slice(0, max);
const fieldsOf = (v, dflt) => {
  const f = listOf(v, 40).map((s) => s.toUpperCase());
  return f.length ? f : dflt;
};

async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
      }
    }),
  );
  return out;
}

// The calendar date n months before a date string.
function monthsBefore(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

// Price fields from daily bars (the last ~400, enough for a year back and the start of the year).
export function priceFields(bars) {
  const last = bars.at(-1);
  if (!last) return {};
  const prev = bars.at(-2);
  const lastDay = day(last.time);
  const onOrBefore = (d) => {
    for (let i = bars.length - 1; i >= 0; i--)
      if (day(bars[i].time) <= d) return bars[i];
    return null;
  };
  const year = lastDay.slice(0, 4);
  const yearEnd = [...bars]
    .reverse()
    .find((b) => day(b.time).slice(0, 4) < year);
  const yearAgo = monthsBefore(lastDay, 12);
  const yr = bars.filter((b) => day(b.time) > yearAgo);
  const vols = bars
    .slice(-30)
    .map((b) => b.volume)
    .filter((v) => v > 0);
  const vol = last.volume > 0 ? last.volume : null;
  return {
    PX_LAST: px(last.close),
    PX_OPEN: px(last.open),
    PX_HIGH: px(last.high),
    PX_LOW: px(last.low),
    PX_VOLUME: vol,
    VOLUME: vol,
    PX_CLOSE_1D: px(prev?.close),
    CHG_NET_1D: net(last.close, prev?.close),
    CHG_PCT_1D: pctChg(last.close, prev?.close),
    CHG_PCT_5D: pctChg(last.close, bars.at(-6)?.close),
    CHG_PCT_1M: pctChg(last.close, onOrBefore(monthsBefore(lastDay, 1))?.close),
    CHG_PCT_YTD: pctChg(last.close, yearEnd?.close),
    CHG_PCT_1YR:
      day(bars[0].time) <= yearAgo
        ? pctChg(last.close, onOrBefore(yearAgo)?.close)
        : null,
    HIGH_52WEEK: yr.length ? px(Math.max(...yr.map((b) => b.high))) : null,
    LOW_52WEEK: yr.length ? px(Math.min(...yr.map((b) => b.low))) : null,
    VOLUME_AVG_30D: vols.length
      ? Math.round(vols.reduce((a, b) => a + b, 0) / vols.length)
      : null,
    LAST_UPDATE_DT: lastDay,
  };
}

function staticFields(sec) {
  const ccy =
    sec.sector === "EQUITY"
      ? isUsStock(sec) || !sec.exch || sec.exch === "US"
        ? "USD"
        : EXCH_CCY[sec.exch] || null
      : sec.sector === "CRNCY"
        ? sec.ticker.slice(3) || null
        : sec.sector === "CRYPTO" || sec.sector === "CMDTY"
          ? "USD"
          : null;
  return {
    TICKER: sec.ticker,
    MARKET_SECTOR_DES: SECTOR_DES[sec.sector] || null,
    EXCH_CODE: sec.sector === "EQUITY" ? sec.exch || "US" : null,
    CRNCY: ccy,
    NAME:
      sec.name ||
      (sec.sector === "CRNCY" && sec.ticker.length === 6
        ? `${sec.ticker.slice(0, 3)}-${sec.ticker.slice(3)} X-RATE`
        : null) ||
      (sec.sector === "CRYPTO" ? `${sec.ticker}-USD` : null),
  };
}

// A company name from the same search the command line uses, for ETFs and listings with no Nasdaq profile.
async function nameFromSearch(sec) {
  const hits = await data.search(sec.ticker).catch(() => []);
  const want = isUsStock(sec) ? `US:${sec.id}` : `YAHOO:${sec.id}`;
  return hits.find((h) => h.symbol === want)?.name?.trim() || null;
}

const epsCache = (ticker) =>
  data.cached(`bbg:eps:${ticker}`, 6 * 3600e3, () =>
    data.getJson(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(ticker)}/eps`,
      data.NQ,
    ),
  );

// ---------- BDP ----------
async function oneBdp(text, fields, used) {
  const row = { security: text };
  const notes = [];
  let sec;
  try {
    sec = parseSecurity(text);
  } catch (e) {
    for (const f of fields) row[f] = null;
    return { row, notes: [e.message] };
  }
  const vals = staticFields(sec);
  const want = new Set(fields.filter((f) => FIELDS[f]?.bdp));
  const us = isUsStock(sec);
  const needPx = [...want].some((f) => PRICE_FIELDS.has(f) || f === "PE_RATIO");
  const needProfile =
    us &&
    ([...want].some((f) => PROFILE_FIELDS.has(f)) ||
      (want.has("NAME") && !vals.NAME));
  const needEps = us && [...want].some((f) => EPS_FIELDS.has(f));
  const [px, prof, eps] = await Promise.all([
    needPx
      ? data.getCandles(sec.id, "1D", 400).catch((e) => {
          notes.push(`${text}: no prices (${e.message})`);
          return null;
        })
      : null,
    needProfile ? des({ symbol: sec.id }).catch(() => null) : null,
    needEps ? epsCache(sec.id).catch(() => null) : null,
  ]);
  if (px) {
    Object.assign(vals, priceFields(px.candles));
    used.add(`${px.provider} daily bars`);
  }
  if (prof) {
    used.add("Nasdaq company profile");
    const stat = (label) => prof.stats?.find((s) => s.label === label)?.value;
    Object.assign(vals, {
      NAME: vals.NAME || prof.name || null,
      CUR_MKT_CAP: numOf(stat("Market Cap")),
      GICS_SECTOR_NAME: prof.sector || stat("Sector") || null,
      GICS_INDUSTRY_NAME: prof.industry || stat("Industry") || null,
      EQY_DVD_YLD_IND: numOf(stat("Current Yield")),
      DVD_EX_DT: isoOf(stat("Ex Dividend Date")),
      BEST_TARGET_PRICE: numOf(stat("1 Year Target")),
    });
  }
  if (eps) {
    const q = (eps.data?.earningsPerShare || []).filter(
      (e) => e.type === "PreviousQuarter" && fin(e.earnings),
    );
    if (q.length >= 4) {
      used.add("Nasdaq EPS history (Zacks)");
      vals.TRAIL_12M_EPS = rnd(
        q.slice(-4).reduce((a, e) => a + e.earnings, 0),
        4,
      );
      if (vals.TRAIL_12M_EPS > 0 && fin(vals.PX_LAST))
        vals.PE_RATIO = rnd(vals.PX_LAST / vals.TRAIL_12M_EPS, 2);
    }
  }
  if (want.has("NAME") && !vals.NAME && sec.sector === "EQUITY")
    vals.NAME = await nameFromSearch(sec);
  for (const f of fields) row[f] = want.has(f) ? (vals[f] ?? null) : null;
  return { row, notes, notUs: !us };
}

export async function bdp(q = {}) {
  const secs = listOf(q.securities ?? q.security, 50);
  if (!secs.length)
    throw bad(
      "Add the securities, comma separated: ?securities=AAPL US EQUITY,SPX INDEX",
    );
  const fields = fieldsOf(q.fields, ["NAME", "PX_LAST", "CHG_PCT_1D"]);
  const notes = unknownNotes(fields, "bdp");
  const used = new Set();
  const out = await mapLimit(secs, 4, (s) => oneBdp(s, fields, used));
  for (const o of out) notes.push(...o.notes);
  const usOnly = fields.filter((f) => FIELDS[f]?.us);
  const others = out.filter((o) => o.notUs).map((o) => o.row.security);
  if (usOnly.length && others.length)
    notes.push(
      `${usOnly.join(", ")} ${usOnly.length > 1 ? "are" : "is"} filled for US-listed stocks only, so ${usOnly.length > 1 ? "they're" : "it's"} empty for ${others.join(", ")}.`,
    );
  return {
    fields,
    rows: out.map((o) => o.row),
    notes,
    source: used.size
      ? [...used].join(", ")
      : "Amber Terminal's security table",
  };
}

function unknownNotes(fields, kind) {
  const unknown = fields.filter((f) => !FIELDS[f]?.[kind]);
  if (!unknown.length) return [];
  return [
    `${unknown.join(", ")}: not a ${kind.toUpperCase()} field Amber can fill from free sources, so ${unknown.length > 1 ? "they come" : "it comes"} back empty. ${kind.toUpperCase()} fields: ${(kind === "bdp" ? BDP_FIELDS : BDH_FIELDS).join(", ")}.`,
  ];
}

// ---------- BDH ----------
const PER = {
  D: "D",
  DAILY: "D",
  W: "W",
  WEEKLY: "W",
  M: "M",
  MONTHLY: "M",
  Q: "Q",
  QUARTERLY: "Q",
  Y: "Y",
  YEARLY: "Y",
  A: "Y",
};
const todayIso = () => new Date().toISOString().slice(0, 10);

// 2025-01-01, 20250101, or relative to today like -1Y, -6M, -2W, -30D.
export function parseDate(v, fallback) {
  const s = String(v ?? "")
    .trim()
    .toUpperCase();
  if (!s) return fallback;
  let m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    if (!Number.isNaN(Date.parse(`${iso}T00:00:00Z`))) return iso;
  }
  m = /^-(\d{1,4})([DWMY])$/.exec(s);
  if (m) {
    const d = new Date(`${todayIso()}T00:00:00Z`);
    const n = Number(m[1]);
    if (m[2] === "D") d.setUTCDate(d.getUTCDate() - n);
    if (m[2] === "W") d.setUTCDate(d.getUTCDate() - 7 * n);
    if (m[2] === "M") d.setUTCMonth(d.getUTCMonth() - n);
    if (m[2] === "Y") d.setUTCFullYear(d.getUTCFullYear() - n);
    return d.toISOString().slice(0, 10);
  }
  throw bad(
    `"${String(v).slice(0, 20)}" isn't a date. Use 2025-01-31, 20250131, or -1Y, -6M, -30D for a time before today.`,
  );
}

function periodKey(date, per) {
  if (per === "M") return date.slice(0, 7);
  if (per === "Y") return date.slice(0, 4);
  if (per === "Q")
    return `${date.slice(0, 4)}Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`;
  if (per === "W") {
    const d = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400e3);
    return String(d - ((d + 3) % 7)); // the Monday of its week (1970-01-01 was a Thursday)
  }
  return date;
}

// Daily bars -> one row per period, labelled with the period's last trading day (as Bloomberg does).
export function periodRows(bars, { start, end, per = "D" }) {
  const rows = [];
  let cur = null;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const date = day(b.time);
    if (date < start || date > end) continue;
    const prev = bars[i - 1];
    const key = periodKey(date, per);
    if (!cur || cur.key !== key) {
      cur = {
        key,
        date,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: 0,
      };
      rows.push(cur);
    }
    Object.assign(cur, {
      date,
      high: Math.max(cur.high, b.high),
      low: Math.min(cur.low, b.low),
      close: b.close,
      volume: cur.volume + (b.volume || 0),
      chg: prev ? net(b.close, prev.close) : null,
      chgPct: prev ? pctChg(b.close, prev.close) : null,
    });
  }
  return rows.map((r) => ({
    date: r.date,
    PX_OPEN: px(r.open),
    PX_HIGH: px(r.high),
    PX_LOW: px(r.low),
    PX_LAST: px(r.close),
    PX_VOLUME: r.volume || null,
    VOLUME: r.volume || null,
    CHG_NET_1D: r.chg,
    CHG_PCT_1D: r.chgPct,
  }));
}

export async function bdh(q = {}) {
  const text = String(q.security ?? q.securities ?? "")
    .split(",")[0]
    .trim();
  if (!text) throw bad("Add the security: ?security=AAPL US EQUITY");
  const sec = parseSecurity(text);
  const fields = fieldsOf(q.fields, ["PX_LAST"]);
  const per = PER[String(q.per || q.periodicity || "D").toUpperCase()];
  if (!per)
    throw bad(
      `per must be D, W, M, Q or Y (daily, weekly, monthly, quarterly, yearly), not "${String(q.per).slice(0, 12)}".`,
    );
  const end = parseDate(q.end, todayIso());
  const start = parseDate(q.start, parseDate("-1Y"));
  if (start > end) throw bad(`start (${start}) is after end (${end}).`);
  const days =
    Math.ceil((Date.now() - Date.parse(`${start}T00:00:00Z`)) / 86400e3) + 10;
  const res = await data.getCandles(
    sec.id,
    "1D",
    Math.min(20000, Math.max(10, days)),
  );
  const all = periodRows(res.candles, { start, end, per });
  const notes = [...unknownNotes(fields, "bdh"), ...(res.notes || [])];
  const first = res.candles[0] && day(res.candles[0].time);
  if (
    first &&
    first > start &&
    Date.parse(first) - Date.parse(start) > 7 * 86400e3
  )
    notes.push(
      `The free history for ${text} from ${res.provider} starts on ${first}.`,
    );
  if (!all.length)
    notes.push(`No prices for ${text} between ${start} and ${end}.`);
  return {
    security: text,
    label: labelOf(sec),
    symbol: res.symbol,
    per,
    start,
    end,
    fields,
    rows: all.map((r) =>
      Object.fromEntries([
        ["date", r.date],
        ...fields.map((f) => [f, FIELDS[f]?.bdh ? (r[f] ?? null) : null]),
      ]),
    ),
    notes,
    source: `${res.provider} daily bars${per === "D" ? "" : `, rolled up to ${{ W: "weeks", M: "months", Q: "quarters", Y: "years" }[per]} here`}`,
  };
}

// ---------- CSV ----------
const cell = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(cols, rows) {
  return `${[cols.map(cell).join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n")}\r\n`;
}
// BDH: date then the fields. BDP: security then the fields.
export const csvOf = (out) =>
  toCsv(
    [out.per ? "date" : "security", ...out.fields],
    out.rows,
  );
