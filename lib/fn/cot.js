// /api/fn/cot[?market=GOLD] : CFTC Commitments of Traders, futures only, from the CFTC's public Socrata API.
// Financial futures use the Traders in Financial Futures report (leveraged funds, asset managers, dealers);
// gold and crude use the Disaggregated report (managed money, producers and merchants, swap dealers).
// Positions are as of Tuesday and published the following Friday at 3:30pm New York time.
import { getJson, cached } from "../providers.js";

export const REPORTS = {
  tff: {
    id: "gpe5-46if",
    name: "Traders in Financial Futures",
    groups: [
      {
        key: "lev",
        name: "Leveraged funds",
        long: "lev_money_positions_long",
        short: "lev_money_positions_short",
        dl: "change_in_lev_money_long",
        ds: "change_in_lev_money_short",
      },
      {
        key: "am",
        name: "Asset managers",
        long: "asset_mgr_positions_long",
        short: "asset_mgr_positions_short",
        dl: "change_in_asset_mgr_long",
        ds: "change_in_asset_mgr_short",
      },
      {
        key: "dealer",
        name: "Dealers",
        long: "dealer_positions_long_all",
        short: "dealer_positions_short_all",
        dl: "change_in_dealer_long_all",
        ds: "change_in_dealer_short_all",
      },
    ],
  },
  dis: {
    id: "72hh-3qpy",
    name: "Disaggregated",
    groups: [
      {
        key: "mm",
        name: "Managed money",
        long: "m_money_positions_long_all",
        short: "m_money_positions_short_all",
        dl: "change_in_m_money_long_all",
        ds: "change_in_m_money_short_all",
      },
      {
        key: "pm",
        name: "Producers and merchants",
        long: "prod_merc_positions_long",
        short: "prod_merc_positions_short",
        dl: "change_in_prod_merc_long",
        ds: "change_in_prod_merc_short",
      },
      // The CFTC's own field name has the double underscore.
      {
        key: "swap",
        name: "Swap dealers",
        long: "swap_positions_long_all",
        short: "swap__positions_short_all",
        dl: "change_in_swap_long_all",
        ds: "change_in_swap_short_all",
      },
    ],
  },
};

export const MARKETS = {
  ES: {
    code: "13874A",
    name: "S&P 500 E-mini",
    report: "tff",
    words: ["SPX", "SP500", "S&P", "SPY", "EMINI"],
  },
  NQ: {
    code: "209742",
    name: "Nasdaq 100 E-mini",
    report: "tff",
    words: ["NDX", "NASDAQ", "QQQ"],
  },
  TY: {
    code: "043602",
    name: "10-year Treasury note",
    report: "tff",
    words: ["10Y", "TNOTE", "NOTE", "NOTES", "TREASURY", "UST"],
  },
  EUR: {
    code: "099741",
    name: "Euro",
    report: "tff",
    words: ["EURO", "EURUSD", "6E"],
  },
  JPY: {
    code: "097741",
    name: "Japanese yen",
    report: "tff",
    words: ["YEN", "USDJPY", "6J"],
  },
  BTC: {
    code: "133741",
    name: "Bitcoin (CME)",
    report: "tff",
    words: ["BITCOIN", "XBT"],
  },
  GOLD: {
    code: "088691",
    name: "Gold (COMEX)",
    report: "dis",
    words: ["XAU", "XAUUSD"],
  },
  OIL: {
    code: "067651",
    name: "WTI crude oil (NYMEX)",
    report: "dis",
    words: ["CRUDE", "WTI", "CL", "USOIL"],
  },
};

export function marketKey(word) {
  const w = String(word || "")
    .toUpperCase()
    .trim();
  if (MARKETS[w]) return w;
  return Object.keys(MARKETS).find((k) => MARKETS[k].words.includes(w)) || null;
}

const n = (v) => (v == null || v === "" ? null : Number(v));

// One Socrata row -> net position and week-on-week change for each trader group.
export function cotRow(r, report) {
  return {
    date: String(r.report_date_as_yyyy_mm_dd || "").slice(0, 10),
    code: r.cftc_contract_market_code,
    oi: n(r.open_interest_all),
    groups: REPORTS[report].groups.map((g) => {
      const long = n(r[g.long]),
        short = n(r[g.short]),
        dl = n(r[g.dl]),
        ds = n(r[g.ds]);
      return {
        key: g.key,
        long,
        short,
        net: long != null && short != null ? long - short : null,
        // The CFTC's own week-on-week change fields, so one report is enough.
        chg: dl != null && ds != null ? dl - ds : null,
      };
    }),
  };
}

function socrata(report, where, limit) {
  const p = new URLSearchParams({
    $where: where,
    $order: "report_date_as_yyyy_mm_dd DESC",
    $limit: String(limit),
  });
  const url = `https://publicreporting.cftc.gov/resource/${REPORTS[report].id}.json?${p}`;
  return cached(`cot:${report}:${where}:${limit}`, 12 * 3600e3, () =>
    getJson(url),
  ).catch(() => {
    throw Object.assign(
      new Error(
        "The CFTC's data service didn't answer. Try again in a few minutes.",
      ),
      { status: 502, upstream: true },
    );
  });
}

const groupNames = (report) => REPORTS[report].groups.map((g) => g.name);
const SOURCE =
  "CFTC Commitments of Traders, futures only (positions as of Tuesday, published Friday)";

export default async function (q) {
  if (q.market) {
    const key = marketKey(q.market);
    if (!key)
      throw Object.assign(
        new Error(
          `COT doesn't cover "${q.market}". Try ${Object.keys(MARKETS).join(", ")}.`,
        ),
        { status: 400 },
      );
    const m = MARKETS[key];
    const rows = (
      await socrata(m.report, `cftc_contract_market_code='${m.code}'`, 52)
    ).map((r) => cotRow(r, m.report));
    if (!rows.length)
      throw Object.assign(
        new Error(`The CFTC sent no reports for ${m.name}.`),
        { status: 502, upstream: true },
      );
    return {
      key,
      name: m.name,
      report: m.report,
      reportName: REPORTS[m.report].name,
      groupNames: groupNames(m.report),
      rows,
      source: SOURCE,
    };
  }
  // Four months back, so the latest report shows even after a holiday or a pause in publishing.
  const since = new Date(Date.now() - 120 * 86400e3).toISOString().slice(0, 10);
  const sections = await Promise.all(
    ["tff", "dis"].map(async (report) => {
      const list = Object.entries(MARKETS).filter(
        ([, m]) => m.report === report,
      );
      const codes = list.map(([, m]) => `'${m.code}'`).join(",");
      const raw = await socrata(
        report,
        `cftc_contract_market_code in(${codes}) AND report_date_as_yyyy_mm_dd >= '${since}T00:00:00'`,
        400,
      );
      const latest = {};
      for (const r of raw) latest[r.cftc_contract_market_code] ||= r; // newest first
      return {
        report,
        reportName: REPORTS[report].name,
        groupNames: groupNames(report),
        rows: list.map(([key, m]) => ({
          key,
          name: m.name,
          ...(latest[m.code]
            ? cotRow(latest[m.code], report)
            : { error: "No recent report" }),
        })),
      };
    }),
  );
  return { sections, source: SOURCE };
}
