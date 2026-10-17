// /api/fn/des?symbol=AAPL : company description. US stocks: Nasdaq's company profile and quote summary.
// Everything else (VOD.L, SAP.DE, RELIANCE.NS, 7203.T): Yahoo's quoteSummary profile, which needs an anonymous
// session (a cookie from fc.yahoo.com, then a "crumb" token from getcrumb). Prices for both from Yahoo's spark.
import { getJson, cached, NQ, resolve, YAHOO_UA } from "../providers.js";
import { board } from "./board.js";

// ---------- Yahoo session: cookie + crumb, kept for 12 hours, renewed once if Yahoo says 401 ----------
let session = null;
const TIMEOUT = 10000;
export const resetYahooSession = () => {
  session = null;
};

const cookieOf = (res) =>
  []
    .concat(res.headers.getSetCookie?.() ?? res.headers.get("set-cookie") ?? [])
    .map((c) => String(c).split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

export async function yahooSession() {
  if (session && Date.now() - session.at < 12 * 3600e3) return session;
  let cookie = "";
  // fc.yahoo.com answers 404 but sets the A3 cookie; finance.yahoo.com is the fallback.
  for (const url of ["https://fc.yahoo.com/", "https://finance.yahoo.com/"]) {
    try {
      const r = await fetch(url, {
        headers: YAHOO_UA,
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT),
      });
      cookie = cookieOf(r);
    } catch {}
    if (cookie) break;
  }
  if (!cookie) throw new Error("Yahoo Finance didn't start a session");
  const res = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { ...YAHOO_UA, Cookie: cookie },
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const crumb = (await res.text()).trim();
  if (!res.ok || !crumb || crumb.length > 40 || /[<{\s]/.test(crumb))
    throw new Error(`Yahoo Finance wouldn't give a session token (HTTP ${res.status})`);
  session = { cookie, crumb, at: Date.now() };
  return session;
}

// quoteSummary with the crumb. A 401 means the crumb went stale: get a fresh session and try once more.
export async function quoteSummary(symbol, modules) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await yahooSession();
    const res = await fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules.join(",")}&crumb=${encodeURIComponent(s.crumb)}`,
      {
        headers: { ...YAHOO_UA, Cookie: s.cookie },
        signal: AbortSignal.timeout(TIMEOUT),
      },
    );
    if (res.status === 401 && attempt === 0) {
      session = null;
      continue;
    }
    if (!res.ok)
      throw Object.assign(
        new Error(
          res.status === 404
            ? `Yahoo Finance has no profile for ${symbol}`
            : `Yahoo Finance returned HTTP ${res.status}`,
        ),
        { status: res.status === 404 ? 404 : 502 },
      );
    const j = await res.json();
    return j?.quoteSummary?.result?.[0] || null;
  }
}

// Prices in pence, cents or agorot: the market value is in the main unit (pounds, rand, shekels).
const MINOR = {
  GBp: ["GBP", "pence"],
  GBX: ["GBP", "pence"],
  ZAc: ["ZAR", "cents"],
  ILA: ["ILS", "agorot"],
};

// quoteSummary (assetProfile + summaryDetail + price) -> the shape the DES screen shows.
export function parseProfile(r) {
  if (!r) return null;
  const a = r.assetProfile || {},
    d = r.summaryDetail || {},
    p = r.price || {};
  const cur = d.currency || p.currency || null;
  const minor = MINOR[cur];
  const fmt = (x) => (x && x.fmt ? x.fmt : null);
  const stats = [
    ["Exchange", p.exchangeName || null],
    ["Currency", cur ? (minor ? `${cur} (${minor[1]})` : cur) : null],
    [
      "Market value",
      fmt(d.marketCap || p.marketCap)
        ? `${fmt(d.marketCap || p.marketCap)} ${minor ? minor[0] : cur || ""}`.trim()
        : null,
    ],
    ["P/E (last 12 months)", fmt(d.trailingPE)],
    ["P/E (next 12 months)", fmt(d.forwardPE)],
    ["Dividend yield", fmt(d.dividendYield)],
    [
      "52-week range",
      fmt(d.fiftyTwoWeekLow) && fmt(d.fiftyTwoWeekHigh)
        ? `${fmt(d.fiftyTwoWeekLow)} to ${fmt(d.fiftyTwoWeekHigh)}`
        : null,
    ],
    ["Beta", fmt(d.beta)],
    ["Average volume (3 months)", fmt(d.averageVolume)],
    [
      "Employees",
      Number.isFinite(a.fullTimeEmployees)
        ? a.fullTimeEmployees.toLocaleString("en-US")
        : null,
    ],
  ]
    .filter(([, v]) => v)
    .map(([label, value]) => ({ label, value }));
  return {
    name: p.longName || p.shortName?.trim() || null,
    sector: a.sector || null,
    industry: a.industry || null,
    region: a.country || null,
    website: a.website || null,
    description: a.longBusinessSummary || null,
    stats,
    // Yahoo's 52-week high and low (intraday), so the price line above matches the key data.
    low52: d.fiftyTwoWeekLow?.raw ?? null,
    high52: d.fiftyTwoWeekHigh?.raw ?? null,
  };
}

const yahooSymbol = (id) =>
  id.startsWith("YAHOO:")
    ? id.slice(6)
    : id.startsWith("FX:")
      ? `${id.slice(3)}=X`
      : /[=^.]/.test(id)
        ? id
        : null;

export default async function (q) {
  const sym = await resolve(q.symbol);
  if (sym.exchange === "US") {
    return cached(`des:${sym.ticker}`, 6 * 3600e3, async () => {
      const [prof, sum, b] = await Promise.all([
        getJson(
          `https://api.nasdaq.com/api/company/${sym.ticker}/company-profile`,
          NQ,
        ).catch(() => null),
        getJson(
          `https://api.nasdaq.com/api/quote/${sym.ticker}/summary?assetclass=stocks`,
          NQ,
        ).catch(() => null),
        board([sym.ticker]).catch(() => ({})),
      ]);
      const p = prof?.data || {};
      const val = (k) => p[k]?.value || null;
      const stats = Object.values(sum?.data?.summaryData || {})
        .map((x) => ({ label: x.label, value: x.value }))
        .filter((x) => x.value && x.value !== "N/A");
      if (!val("CompanyName") && !stats.length)
        throw Object.assign(
          new Error(`Nasdaq has no profile for ${sym.ticker}.`),
          { status: 404 },
        );
      return {
        symbol: sym.id,
        name: val("CompanyName"),
        sector: val("Sector"),
        industry: val("Industry"),
        region: val("Region"),
        website: val("CompanyUrl"),
        description: val("CompanyDescription"),
        stats,
        price: b[sym.ticker] || null,
        source:
          "Nasdaq company profile and quote summary, Yahoo Finance prices",
      };
    });
  }
  const y = yahooSymbol(sym.id);
  const [b, prof] = await Promise.all([
    y ? board([y]).catch(() => ({})) : {},
    y
      ? cached(`des:yahoo:${y}`, 24 * 3600e3, async () =>
          parseProfile(
            await quoteSummary(y, ["assetProfile", "summaryDetail", "price"]),
          ),
        ).catch(() => null)
      : null,
  ]);
  if (prof?.name) {
    const { low52, high52, ...rest } = prof;
    const price = b[y]
      ? { ...b[y], ...(low52 && high52 ? { low52, high52 } : {}) }
      : null;
    return {
      symbol: sym.id,
      ...rest,
      price,
      source:
        "Yahoo Finance company profile (refreshed daily here) and prices (delayed up to 15 minutes, depending on the exchange)",
    };
  }
  return {
    symbol: sym.id,
    name: null,
    description: null,
    stats: [],
    price: b[y] || null,
    source: "Yahoo Finance prices (Yahoo's company profile didn't answer)",
  };
}
