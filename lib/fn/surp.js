// /api/fn/surp : the main US data releases of the last 60 days, actual against consensus, and how the
// S&P 500, the 10-year yield and EURUSD moved that day. Past days come from the Nasdaq economic calendar,
// one request per day, and every day's released figures are kept in data/eco-log.json, so the history
// grows on your machine (point in time: the figures as they were first released).
import { getJson, cached, NQ, getCandles } from "../providers.js";
import { parseNasdaqDay, nasdaqDateFor, addDays } from "./eco.js";
import * as store from "../store.js";

export const WINDOW_DAYS = 60;
const LOG = "eco-log";
const US = "United States";

// The releases, matched on Nasdaq's event names. "dual" ones come twice a day: one month on the last (m/m)
// and one year on the last (y/y), under the same name.
export const RELEASES = [
  { id: "CPI", name: "CPI", match: /^cpi$/i, dual: true },
  { id: "CORE-CPI", name: "Core CPI", match: /^core cpi$/i, dual: true },
  { id: "PPI", name: "PPI", match: /^ppi$/i, dual: true },
  { id: "CORE-PPI", name: "Core PPI", match: /^core ppi$/i, dual: true },
  { id: "NFP", name: "Nonfarm payrolls", match: /^nonfarm payrolls$/i },
  { id: "UNEMP", name: "Unemployment rate", match: /^unemployment rate$/i },
  { id: "RETAIL", name: "Retail sales", match: /^retail sales$/i, dual: true },
  { id: "GDP", name: "GDP (annual rate)", match: /^gdp$/i },
  { id: "PCE", name: "PCE prices", match: /^pce price index$/i, dual: true },
  {
    id: "CORE-PCE",
    name: "Core PCE prices",
    match: /^core pce price index$/i,
    dual: true,
  },
  {
    id: "ISM-MFG",
    name: "ISM manufacturing",
    match: /^ism manufacturing pmi$/i,
  },
  {
    id: "ISM-SVC",
    name: "ISM services",
    match: /^ism (non-manufacturing|services) pmi$/i,
  },
  { id: "CLAIMS", name: "Jobless claims", match: /^initial jobless claims$/i },
  {
    id: "SENT",
    name: "Consumer sentiment",
    match: /^michigan consumer sentiment$/i,
  },
];

const nyToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

const weekday = (day) => {
  const w = new Date(`${day}T12:00:00Z`).getUTCDay();
  return w > 0 && w < 6;
};

// The weekdays from WINDOW_DAYS ago up to today, oldest first.
export function windowDays(today, days = WINDOW_DAYS) {
  const out = [];
  for (let i = days; i >= 0; i--) {
    const d = addDays(today, -i);
    if (weekday(d)) out.push(d);
  }
  return out;
}

// "1,710K" -> 1710 K, "3.7%" -> 3.7 %, "-11.120M" -> -11.12 M, "54.6" -> 54.6.
const SCALE = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
export function parseValue(s) {
  const m = /^([+-]?)\s*([\d,]*\.?\d+)\s*([KMBT%]?)$/i.exec(
    String(s ?? "").trim(),
  );
  if (!m) return null;
  const digits = m[2].replace(/,/g, "");
  return {
    v: Number(m[1] + digits),
    unit: m[3].toUpperCase(),
    dp: digits.includes(".") ? digits.split(".")[1].length : 0,
  };
}

// actual minus consensus, in the actual's units (a consensus of 1.71M against an actual of 1,710K still works).
export function surpriseOf(actual, consensus) {
  const a = parseValue(actual);
  const c = parseValue(consensus);
  if (!a || !c) return null;
  let cv = c.v;
  if (a.unit !== c.unit) {
    if (!SCALE[a.unit] || !SCALE[c.unit]) return null;
    cv = (c.v * SCALE[c.unit]) / SCALE[a.unit];
  }
  const dp = Math.max(a.dp, c.unit === a.unit ? c.dp : a.dp);
  return { value: Number((a.v - cv).toFixed(dp)), unit: a.unit, dp };
}

const size = (r) =>
  Math.max(
    ...[r.actual, r.consensus, r.previous].map((x) =>
      Math.abs(parseValue(x)?.v ?? 0),
    ),
  );

// One day's Nasdaq rows -> the tracked US releases, each named and with its surprise.
// A dual release's two rows are told apart by size: the one-year change is the bigger number.
export function classifyDay(rows, day) {
  const out = [];
  for (const rel of RELEASES) {
    const hits = rows.filter(
      (r) =>
        r.country === US &&
        rel.match.test(String(r.event || "").trim()) &&
        r.actual,
    );
    if (!hits.length) continue;
    let tagged;
    if (!rel.dual) tagged = hits.map((r) => [r, ""]);
    else if (hits.length === 2) {
      const [a, b] = hits;
      const yy = size(a) >= size(b) ? a : b;
      tagged = hits.map((r) => [r, r === yy ? "Y/Y" : "M/M"]);
    } else
      tagged = hits.map((r) => [
        r,
        rel.id === "RETAIL" || size(r) < 1.5 ? "M/M" : "Y/Y",
      ]);
    for (const [r, period] of tagged) {
      const s = surpriseOf(r.actual, r.consensus);
      if (!s) continue; // no consensus, no surprise
      out.push({
        id: period ? `${rel.id}-${period.replace("/", "")}` : rel.id,
        name: period ? `${rel.name} ${period.toLowerCase()}` : rel.name,
        day,
        time: r.time || null,
        actual: r.actual,
        consensus: r.consensus,
        previous: r.previous || null,
        surprise: s.value,
        unit: s.unit,
        dp: s.dp,
      });
    }
  }
  return out;
}

// ---------- market reaction ----------
// Daily bars -> day -> { close, prev } (the bar before it), keyed by YYYY-MM-DD.
export function closesByDay(candles) {
  const out = new Map();
  let prev = null;
  for (const c of candles || []) {
    if (!Number.isFinite(c?.close)) continue;
    const day = new Date(c.time * 1000).toISOString().slice(0, 10);
    if (prev != null) out.set(day, { close: c.close, prev });
    prev = c.close;
  }
  return out;
}

const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);

// The S&P 500 and EURUSD as % changes on the day, the 10-year yield as a change in basis points.
export function reactionOn(day, { spx, tnx, eur }) {
  const s = spx?.get(day);
  const t = tnx?.get(day);
  const e = eur?.get(day);
  return {
    spx: s ? round((s.close / s.prev - 1) * 100, 2) : null,
    us10y: t ? round((t.close - t.prev) * 100, 1) : null,
    eurusd: e ? round((e.close / e.prev - 1) * 100, 2) : null,
  };
}

// Surprise in standard deviations of that release's surprises, once there are four or more of them.
export function addZ(rows, min = 4) {
  const by = new Map();
  for (const r of rows)
    (by.get(r.id) || by.set(r.id, []).get(r.id)).push(r.surprise);
  const sd = new Map();
  for (const [id, xs] of by) {
    if (xs.length < min) continue;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
    if (v > 0) sd.set(id, Math.sqrt(v));
  }
  return rows.map((r) => ({
    ...r,
    z: sd.has(r.id) ? round(r.surprise / sd.get(r.id), 1) : null,
    n: by.get(r.id).length,
  }));
}

// ---------- the log of released figures ----------
const slim = ({ time, country, event, actual, consensus, previous }) => ({
  time,
  country,
  event,
  actual,
  consensus,
  previous,
});

// Past days are written once and kept as they were; today is rewritten until it's over.
export function mergeDay(log, day, rows, today) {
  const old = log.days[day];
  if (old?.final) return false;
  log.days[day] = {
    final: day < today,
    at: new Date().toISOString(),
    rows: rows.filter((r) => r.actual).map(slim),
  };
  return true;
}

async function fetchDay(day, today, attempt = 0) {
  const bust = `${Math.floor(Date.now() / 300e3)}${attempt ? `-${attempt}` : ""}`;
  const j = await getJson(
    `https://api.nasdaq.com/api/calendar/economicevents?date=${nasdaqDateFor(day)}&_=${bust}`,
    NQ,
  );
  if (!Array.isArray(j?.data?.rows)) throw new Error("no rows");
  const rows = parseNasdaqDay(j, day);
  // Every weekday has some release somewhere, so an empty past day is a bad answer: retry it next time
  // rather than log it as final.
  if (day < today && !rows.some((r) => r.actual)) throw new Error("no released figures");
  return rows;
}

// At most n requests in flight; results in the order of items.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]).then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason }),
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function market() {
  return cached("surp:market", 15 * 60e3, async () => {
    const get = (s) => getCandles(s, "1D", 400).then((r) => r.candles);
    const notes = [];
    const [spx, tnx, eur] = await Promise.all(
      [
        get("^GSPC").catch(() =>
          get("SPY").then(
            (c) => (
              notes.push(
                "S&P 500 moves use SPY, the S&P 500 fund, because Yahoo didn't answer",
              ),
              c
            ),
          ),
        ),
        get("^TNX"),
        get("EURUSD"),
      ].map((p) => p.catch(() => null)),
    );
    return {
      spx: closesByDay(spx),
      tnx: closesByDay(tnx),
      eur: closesByDay(eur),
      notes,
    };
  });
}

export async function buildSurp(today = nyToday()) {
  const log = store.read(LOG, null) || { days: {} };
  log.days ||= {};
  const days = windowDays(today);
  const todo = days.filter((d) => !log.days[d]?.final);
  // Under load Nasdaq now and then answers a past day with nothing, so a failed day gets one more try.
  const got = await pool(todo, 6, (d) =>
    fetchDay(d, today)
      .catch(() => fetchDay(d, today, 1))
      .then((rows) => [d, rows]),
  );
  let changed = false;
  const missed = [];
  got.forEach((g, i) => {
    if (g.status === "fulfilled")
      changed = mergeDay(log, g.value[0], g.value[1], today) || changed;
    else missed.push(todo[i]);
  });
  if (changed) store.write(LOG, log);
  const logged = Object.keys(log.days).sort();
  if (!logged.some((d) => d >= days[0]))
    throw Object.assign(
      new Error(
        "The Nasdaq economic calendar didn't answer. Try again in a few minutes.",
      ),
      { status: 502 },
    );

  const mkt = await market();
  const rows = addZ(logged.flatMap((d) => classifyDay(log.days[d].rows, d)))
    .map((r) => ({ ...r, ...reactionOn(r.day, mkt), partial: r.day === today }))
    .sort(
      (a, b) =>
        b.day.localeCompare(a.day) ||
        String(b.time).localeCompare(String(a.time)) ||
        a.name.localeCompare(b.name),
    );
  return {
    today,
    from: days[0],
    rows,
    loggedDays: logged.length,
    firstLogged: logged[0] || null,
    missed,
    source: [
      "Nasdaq economic calendar (actual, consensus, prior) and Yahoo Finance daily closes (S&P 500, 10-year yield, EURUSD)",
      ...mkt.notes,
      missed.length
        ? `Nasdaq didn't answer for ${missed.length} day${missed.length > 1 ? "s" : ""}; they fill in next time`
        : "",
    ]
      .filter(Boolean)
      .join(". "),
  };
}

export default async function () {
  return cached("surp", 10 * 60e3, () => buildSurp());
}
