// /api/fn/gc?country=US : government bond yield curves.
// US: the Treasury's official daily par yield curve (1 month to 30 years, published each evening for that
// day's close), latest against 1 week, 1 month and 1 year ago.
// US LIVE and other countries: CNBC's real-time bond quotes, now against the previous close.
// Also home to the small CSV and Treasury helpers the other rates functions share.
import { getJson, cached, YAHOO_UA } from "../providers.js";

// ---------- shared helpers ----------
const fail = (message, status = 502) =>
  Object.assign(new Error(message), { status, upstream: status >= 500 });

// Plain fetch for CSV endpoints, with a timeout and a plain-words error.
export async function fetchText(
  url,
  { what = new URL(url).host, timeout = 15000, headers = {} } = {},
) {
  let res;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", ...headers },
      signal: AbortSignal.timeout(timeout),
    });
  } catch (e) {
    const why =
      e.name === "TimeoutError"
        ? "it took too long to answer"
        : "it couldn't be reached";
    throw fail(`${what} didn't send data (${why}). Try again in a minute.`);
  }
  if (!res.ok)
    throw fail(
      `${what} sent an error (HTTP ${res.status}). Try again in a minute.`,
    );
  return res.text();
}

// Small CSV reader: quoted fields, doubled quotes, CRLF.
export function parseCsv(text) {
  const rows = [];
  let row = [],
    field = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') ((field += '"'), i++);
      else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(field), (field = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.length > 1 || row[0] !== "") rows.push(row);
      ((row = []), (field = ""));
    } else field += c;
  }
  if (field !== "" || row.length) (row.push(field), rows.push(row));
  return rows;
}

// "4.82", "4.745%", "1,234" -> number; blanks, "N/A", "UNCH" -> null.
export function toNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v ?? "").replace(/[%,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export const round = (v, d = 0) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

// Today's date in New York, as YYYY-MM-DD. US rates live on New York time.
export const nyToday = (now = new Date()) =>
  now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });

export function shiftDays(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Same day n months away, clamped to the month's last day (31 Mar minus 1 month is 28 or 29 Feb).
export function shiftMonths(iso, n) {
  const [y, m, day] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(
    Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0),
  ).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return t.toISOString().slice(0, 10);
}

// The last row dated on or before the target (rows ascending by date).
export function onOrBefore(rows, iso) {
  for (let i = rows.length - 1; i >= 0; i--)
    if (rows[i].date <= iso) return rows[i];
  return null;
}

// ---------- US Treasury ----------
const TREASURY =
  "https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv";
export const treasuryUrl = (type, year) =>
  `${TREASURY}/${year}/all?type=${type}&field_tdr_date_value=${year}&page&_format=csv`;

// Treasury CSV -> [{ date: "YYYY-MM-DD", values: { <column>: number|null } }], oldest first.
export function parseTreasuryCsv(text) {
  const [head = [], ...rows] = parseCsv(text);
  const cols = head.slice(1).map((h) => h.trim());
  const out = [];
  for (const r of rows) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((r[0] || "").trim());
    if (!m) continue;
    out.push({
      date: `${m[3]}-${m[1]}-${m[2]}`,
      values: Object.fromEntries(cols.map((c, i) => [c, toNum(r[i + 1])])),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// "1 Mo" -> 1M, "1.5 Month" -> 1.5M, "10 Yr" -> 10Y; "13 WEEKS COUPON EQUIVALENT" -> 13W.
export function tenorKey(col) {
  const m = /^([\d.]+)\s*(Mo|Month|Yr|Year)s?$/i.exec(col.trim());
  if (m) return `${m[1]}${/^m/i.test(m[2]) ? "M" : "Y"}`;
  const w = /^(\d+)\s*WEEKS?\s+COUPON\s+EQUIVALENT$/i.exec(col.trim());
  return w ? `${w[1]}W` : null;
}

export const tenorMonths = (t) => {
  const n = parseFloat(t);
  return t.endsWith("Y") ? n * 12 : t.endsWith("W") ? (n * 12) / 52 : n;
};
export const sortTenors = (list) =>
  [...list].sort((a, b) => tenorMonths(a) - tenorMonths(b));

// Rows keyed by tenor instead of the Treasury's column names.
export const byTenor = (rows) =>
  rows.map((r) => ({
    date: r.date,
    values: Object.fromEntries(
      Object.entries(r.values)
        .map(([c, v]) => [tenorKey(c), v])
        .filter(([k, v]) => k && v != null),
    ),
  }));

// One year of a Treasury table (type: daily_treasury_yield_curve or daily_treasury_bill_rates), keyed by tenor.
// Treasury answers fast with a user-agent and slowly (about 19 seconds) without one.
export function treasuryYear(type, year) {
  const past = year < +nyToday().slice(0, 4);
  return cached(
    `tsy:${type}:${year}`,
    past ? 24 * 3600e3 : 15 * 60e3,
    async () =>
      byTenor(
        parseTreasuryCsv(
          await fetchText(treasuryUrl(type, year), {
            what: "The US Treasury website",
            timeout: 30000,
          }),
        ),
      ),
  );
}

// This year and last year joined, oldest first, one row per date.
export async function treasuryRows(type) {
  const y = +nyToday().slice(0, 4);
  const [prev, cur] = await Promise.all([
    treasuryYear(type, y - 1).catch(() => []),
    treasuryYear(type, y).catch((e) => (e.status ? Promise.reject(e) : [])),
  ]);
  const seen = new Map();
  for (const r of [...prev, ...cur]) seen.set(r.date, r);
  return [...seen.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

// The latest curve with the curves 1 week, 1 month and 1 year before it.
export function usCurves(rows) {
  const latest = rows.at(-1);
  if (!latest) return null;
  const picks = [
    ["now", "Latest close", latest.date],
    ["1W", "1 week ago", shiftDays(latest.date, -7)],
    ["1M", "1 month ago", shiftMonths(latest.date, -1)],
    ["1Y", "1 year ago", shiftMonths(latest.date, -12)],
  ];
  const curves = picks
    .map(([key, label, target]) => {
      const r = onOrBefore(rows, target);
      return r && { key, label, date: r.date, values: r.values };
    })
    .filter(Boolean);
  return { tenors: sortTenors(Object.keys(latest.values)), curves };
}

// 2s10s: the 10-year yield minus the 2-year, in basis points (1bp = 0.01%). Below zero the curve is inverted.
export function spread2s10s(values) {
  const a = values?.["2Y"],
    b = values?.["10Y"];
  if (a == null || b == null) return null;
  const bp = round((b - a) * 100, 1);
  return { bp, inverted: bp < 0, twoYear: a, tenYear: b };
}

// ---------- CNBC live yields ----------
// CNBC's quote feed is unofficial and undocumented; it answers a short user-agent with real-time yields.
const CNBC =
  "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol";
export const COUNTRIES = {
  US: { label: "US", name: "US Treasury par yield curve" },
  USLIVE: {
    label: "US LIVE",
    name: "US Treasuries, live market yields",
    tenors: [
      "1M",
      "2M",
      "3M",
      "4M",
      "6M",
      "1Y",
      "2Y",
      "3Y",
      "5Y",
      "7Y",
      "10Y",
      "20Y",
      "30Y",
    ],
    sym: (t) => `US${t}`,
  },
  UK: {
    label: "UK",
    name: "UK gilts",
    tenors: ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"],
    sym: (t) => `GB${t}-GB`,
  },
  DE: {
    label: "GERMANY",
    name: "German Bunds",
    tenors: ["6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"],
    sym: (t) => `DE${t}-DE`,
  },
  FR: {
    label: "FRANCE",
    name: "French OATs",
    tenors: ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"],
    sym: (t) => `FR${t}-FR`,
  },
  IT: {
    label: "ITALY",
    name: "Italian BTPs",
    tenors: ["6M", "1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y", "20Y", "30Y"],
    sym: (t) => `IT${t}-IT`,
  },
  // The 15-year is left out: CNBC's quote for it sits far off the curve (4.3% against 2.9% at 10 years).
  JP: {
    label: "JAPAN",
    name: "Japanese government bonds",
    tenors: ["3M", "6M", "2Y", "3Y", "5Y", "10Y", "20Y", "30Y", "40Y"],
    sym: (t) => `JP${t}-JP`,
  },
  CA: {
    label: "CANADA",
    name: "Government of Canada bonds",
    tenors: ["1M", "3M", "6M", "1Y", "2Y", "3Y", "5Y", "10Y", "20Y", "30Y"],
    sym: (t) => `CA${t}-CA`,
  },
  AU: {
    label: "AUSTRALIA",
    name: "Australian government bonds",
    tenors: ["1Y", "2Y", "3Y", "5Y", "7Y", "10Y", "15Y"],
    sym: (t) => `AU${t}-AU`,
  },
};
const ALIASES = {
  USA: "US",
  GB: "UK",
  GERMANY: "DE",
  FRANCE: "FR",
  ITALY: "IT",
  JAPAN: "JP",
  CANADA: "CA",
  AUSTRALIA: "AU",
  LIVE: "USLIVE",
  "US LIVE": "USLIVE",
};
export const countryCode = (c) => {
  const k = String(c || "US")
    .toUpperCase()
    .trim();
  return COUNTRIES[k] ? k : ALIASES[k] || null;
};

// CNBC's "2026-10-15T08:22:33.000-0400" -> ISO in UTC.
const cnbcTime = (s) => {
  const t = Date.parse(String(s || "").replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

export function cnbcCurve(json, cfg) {
  const list = [].concat(json?.FormattedQuoteResult?.FormattedQuote || []);
  const bySym = Object.fromEntries(list.map((q) => [q.symbol, q]));
  const now = {},
    prev = {};
  let time = null;
  for (const t of cfg.tenors) {
    const q = bySym[cfg.sym(t)];
    if (!q || String(q.code) !== "0") continue;
    const v = toNum(q.last),
      p = toNum(q.previous_day_closing);
    if (v == null) continue;
    now[t] = v;
    if (p != null) prev[t] = p;
    const at = cnbcTime(q.last_time);
    if (at && (!time || at > time)) time = at;
  }
  return {
    tenors: cfg.tenors.filter((t) => now[t] != null),
    curves: [
      { key: "now", label: "Now", date: time, values: now },
      { key: "prev", label: "Previous close", values: prev },
    ],
  };
}

async function liveCurve(code) {
  const cfg = COUNTRIES[code];
  const syms = cfg.tenors.map(cfg.sym);
  const url = `${CNBC}?symbols=${encodeURIComponent(syms.join("|"))}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1`;
  const json = await cached(`cnbc:${code}`, 60e3, () =>
    getJson(url, YAHOO_UA),
  ).catch(() => {
    throw fail(
      `CNBC didn't send ${cfg.name} yields. Try again in a minute, or pick another country.`,
    );
  });
  const c = cnbcCurve(json, cfg);
  if (c.tenors.length < 3)
    throw fail(
      `CNBC sent too few ${cfg.name} yields to draw a curve. Try again in a minute, or pick another country.`,
    );
  return c;
}

const countryList = () =>
  Object.entries(COUNTRIES).map(([code, c]) => ({ code, label: c.label }));

export default async function (q) {
  const code = countryCode(q.country);
  if (!code)
    throw fail(
      `No yield curve for "${q.country}". Try ${Object.keys(COUNTRIES).join(", ")}.`,
      400,
    );
  const base = {
    country: code,
    name: COUNTRIES[code].name,
    countries: countryList(),
  };
  if (code !== "US") {
    const c = await liveCurve(code);
    return {
      ...base,
      kind: "live",
      ...c,
      spread: spread2s10s(c.curves[0].values),
      source:
        "CNBC bond quotes (real time, unofficial feed), change against the previous close",
    };
  }
  try {
    const c = usCurves(await treasuryRows("daily_treasury_yield_curve"));
    if (!c) throw fail("The US Treasury sent no yield curve rows.");
    return {
      ...base,
      kind: "history",
      ...c,
      spread: spread2s10s(c.curves[0].values),
      source:
        "US Treasury daily par yield curve (official, published each evening for that day's close)",
    };
  } catch (e) {
    // Treasury down: show live market yields instead, and say so.
    const c = await liveCurve("USLIVE").catch(() => Promise.reject(e));
    return {
      ...base,
      kind: "live",
      ...c,
      spread: spread2s10s(c.curves[0].values),
      note: `The Treasury website didn't answer, so this shows live market yields from CNBC instead. (${e.message})`,
      source:
        "CNBC bond quotes (real time, unofficial feed): the US Treasury website didn't answer",
    };
  }
}
