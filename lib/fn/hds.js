// /api/fn/hds?symbol=AAPL : the biggest institutional holders (funds, banks, insurers), from their 13F filings.
// Primary: Nasdaq institutional holdings. Fallback: Yahoo's top-10 institutional owners.
import { getJson, cached, NQ, YAHOO_UA, resolve } from "../providers.js";

const num = (s) => {
  const v = parseFloat(String(s ?? "").replace(/[$,%\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};
const mdy = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || "").trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};
const pick = (rows, label) =>
  (rows || []).find((r) => r.positions === label) || {};

// ---------- Nasdaq ----------
export function parseNasdaqHolders(json) {
  const d = json?.data;
  if (!d?.holdingsTransactions?.table?.rows) return null;
  const out = num(d.ownershipSummary?.ShareoutstandingTotal?.value); // millions of shares
  const sharesOut = out ? out * 1e6 : null;
  const act = d.activePositions?.rows;
  const gone = d.newSoldOutPositions?.rows;
  const rows = d.holdingsTransactions.table.rows.map((r) => {
    const shares = num(r.sharesHeld);
    return {
      name: r.ownerName,
      shares,
      pctOfCompany:
        sharesOut && shares != null ? (shares / sharesOut) * 100 : null,
      change: num(r.sharesChange),
      changePct: num(r.sharesChangePCT),
      value: num(r.marketValue) != null ? num(r.marketValue) * 1000 : null, // Nasdaq quotes thousands
      date: mdy(r.date),
    };
  });
  return {
    summary: {
      ownedPct: num(d.ownershipSummary?.SharesOutstandingPCT?.value),
      holders: num(d.holdingsTransactions.institutionalHolders),
      shares: num(d.holdingsTransactions.sharesHeld),
      increased: num(pick(act, "Increased Positions").holders),
      decreased: num(pick(act, "Decreased Positions").holders),
      newPositions: num(pick(gone, "New Positions").holders),
      soldOut: num(pick(gone, "Sold Out Positions").holders),
    },
    rows,
  };
}

// ---------- Yahoo fallback (needs a session cookie and crumb) ----------
let session = null;
export function cookieHeader(setCookies) {
  return []
    .concat(setCookies || [])
    .map((c) => String(c).split(";")[0])
    .filter(Boolean)
    .join("; ");
}

async function yahooSession() {
  if (session && Date.now() - session.at < 3600e3) return session;
  const first = await fetch("https://fc.yahoo.com/", {
    headers: YAHOO_UA,
    signal: AbortSignal.timeout(8000),
  });
  const cookie = cookieHeader(
    first.headers.getSetCookie?.() ?? first.headers.get("set-cookie"),
  );
  const res = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { ...YAHOO_UA, Cookie: cookie },
    signal: AbortSignal.timeout(8000),
  });
  const crumb = (await res.text()).trim();
  if (!res.ok || !crumb || crumb.length > 40 || /[<{\s]/.test(crumb))
    throw new Error("Yahoo would not give a session");
  session = { cookie, crumb, at: Date.now() };
  return session;
}

export function parseYahooHolders(json) {
  const r = json?.quoteSummary?.result?.[0];
  const list = r?.institutionOwnership?.ownershipList;
  if (!list?.length) return null;
  const top = r.majorHoldersBreakdown || {};
  return {
    summary: {
      ownedPct:
        top.institutionsPercentHeld?.raw != null
          ? top.institutionsPercentHeld.raw * 100
          : null,
      holders: top.institutionsCount?.raw ?? null,
      shares: null,
      increased: null,
      decreased: null,
      newPositions: null,
      soldOut: null,
    },
    rows: list.map((h) => {
      const shares = h.position?.raw ?? null;
      const pc = h.pctChange?.raw; // a fraction: 0.016 is +1.6%
      return {
        name: h.organization,
        shares,
        pctOfCompany: h.pctHeld?.raw != null ? h.pctHeld.raw * 100 : null,
        change:
          shares != null && pc != null
            ? Math.round(shares - shares / (1 + pc))
            : null,
        changePct: pc != null ? pc * 100 : null,
        value: h.value?.raw ?? null,
        date: h.reportDate?.fmt || null,
      };
    }),
  };
}

async function fromYahoo(ticker) {
  const s = await yahooSession();
  const j = await getJson(
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=institutionOwnership,majorHoldersBreakdown&crumb=${encodeURIComponent(s.crumb)}`,
    { ...YAHOO_UA, Cookie: s.cookie },
  );
  return parseYahooHolders(j);
}

export default async function (q) {
  const sym = await resolve(q.symbol);
  if (sym.exchange !== "US")
    throw Object.assign(new Error("Holders are for US-listed stocks."), {
      status: 422,
    });
  return cached(`hds:${sym.ticker}`, 6 * 3600e3, async () => {
    let nasdaqError;
    try {
      const j = await getJson(
        `https://api.nasdaq.com/api/company/${encodeURIComponent(sym.ticker)}/institutional-holdings?limit=50&type=TOTAL&sortColumn=marketValue&sortOrder=DESC`,
        NQ,
      );
      const d = parseNasdaqHolders(j);
      if (d?.rows.length)
        return {
          symbol: sym.id,
          ...d,
          source:
            "Nasdaq institutional holdings, built from 13F filings. Funds file every quarter, so figures can be up to 4 months old",
        };
    } catch (e) {
      nasdaqError = e;
    }
    const y = await fromYahoo(sym.ticker).catch(() => null);
    if (y?.rows.length)
      return {
        symbol: sym.id,
        ...y,
        source:
          "Yahoo Finance top 10 institutional owners, built from 13F filings (Nasdaq did not answer). Figures can be up to 4 months old",
      };
    if (nasdaqError)
      throw Object.assign(
        new Error(
          "Holder data couldn't be loaded from Nasdaq or Yahoo. Try again in a minute.",
        ),
        { status: 502 },
      );
    throw Object.assign(
      new Error(
        `No institutional holders found for ${sym.ticker}. Try a company ticker such as AAPL.`,
      ),
      { status: 404 },
    );
  });
}
