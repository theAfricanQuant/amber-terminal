// Bloomberg-style securities, mapped to the free sources' symbols. No imports, so the server, the MCP server and
// the browser all parse tickers the same way.
//   AAPL US EQUITY · VOD LN · SPX INDEX · CL1 COMDTY · EURUSD CURNCY · BTC · USGG10YR INDEX
export const YELLOW = {
  EQUITY: "EQUITY",
  EQ: "EQUITY",
  INDEX: "INDEX",
  CMDTY: "CMDTY",
  COMDTY: "CMDTY",
  CRNCY: "CRNCY",
  CURNCY: "CRNCY",
  CRYPTO: "CRYPTO",
  GOVT: "GOVT",
};

// Index tickers as the terminal names them, mapped to Yahoo's symbols.
export const INDICES = {
  SPX: ["^GSPC", "S&P 500"],
  INDU: ["^DJI", "Dow Jones Industrial Average"],
  CCMP: ["^IXIC", "Nasdaq Composite"],
  NDX: ["^NDX", "Nasdaq 100"],
  RTY: ["^RUT", "Russell 2000"],
  VIX: ["^VIX", "CBOE Volatility Index"],
  SPTSX: ["^GSPTSE", "S&P/TSX Composite"],
  MEXBOL: ["^MXX", "Mexico IPC"],
  IBOV: ["^BVSP", "Brazil Ibovespa"],
  UKX: ["^FTSE", "FTSE 100"],
  DAX: ["^GDAXI", "DAX"],
  CAC: ["^FCHI", "CAC 40"],
  SX5E: ["^STOXX50E", "Euro Stoxx 50"],
  IBEX: ["^IBEX", "IBEX 35"],
  FTSEMIB: ["FTSEMIB.MI", "FTSE MIB"],
  AEX: ["^AEX", "AEX"],
  SMI: ["^SSMI", "Swiss Market Index"],
  NKY: ["^N225", "Nikkei 225"],
  HSI: ["^HSI", "Hang Seng"],
  SHCOMP: ["000001.SS", "Shanghai Composite"],
  KOSPI: ["^KS11", "KOSPI"],
  AS51: ["^AXJO", "S&P/ASX 200"],
  SENSEX: ["^BSESN", "BSE Sensex"],
  NIFTY: ["^NSEI", "Nifty 50"],
  TWSE: ["^TWII", "Taiwan Weighted"],
  STI: ["^STI", "Straits Times"],
};

// US Treasury yields as the terminal names them (USGG10YR INDEX), mapped to Yahoo's CBOE yield indices, in percent.
export const YIELDS = {
  USGG3M: ["^IRX", "US 3-month Treasury bill yield"],
  USGG5YR: ["^FVX", "US 5-year Treasury yield"],
  USGG10YR: ["^TNX", "US 10-year Treasury yield"],
  USGG30YR: ["^TYX", "US 30-year Treasury yield"],
};
// On-the-run Treasuries (CT10 GOVT) chart as their yield.
const GOVTS = { CT5: "USGG5YR", CT10: "USGG10YR", CT30: "USGG30YR" };

// Front-month futures ("generic 1st") as the terminal names them, mapped to Yahoo's continuous contracts.
export const GENERICS = {
  CL1: ["CL=F", "WTI crude oil"],
  CO1: ["BZ=F", "Brent crude oil"],
  NG1: ["NG=F", "Natural gas"],
  HO1: ["HO=F", "Heating oil"],
  XB1: ["RB=F", "Gasoline"],
  GC1: ["GC=F", "Gold"],
  SI1: ["SI=F", "Silver"],
  HG1: ["HG=F", "Copper"],
  PL1: ["PL=F", "Platinum"],
  PA1: ["PA=F", "Palladium"],
  C1: ["ZC=F", "Corn"],
  W1: ["ZW=F", "Wheat"],
  S1: ["ZS=F", "Soybeans"],
  KC1: ["KC=F", "Coffee"],
  SB1: ["SB=F", "Sugar"],
  CC1: ["CC=F", "Cocoa"],
  CT1: ["CT=F", "Cotton"],
  LC1: ["LE=F", "Live cattle"],
  LH1: ["HE=F", "Lean hogs"],
  ES1: ["ES=F", "E-mini S&P 500"],
  NQ1: ["NQ=F", "E-mini Nasdaq 100"],
  YM1: ["YM=F", "E-mini Dow"],
  RTY1: ["RTY=F", "E-mini Russell 2000"],
  TY1: ["ZN=F", "10-year T-note"],
  US1: ["ZB=F", "30-year T-bond"],
  FV1: ["ZF=F", "5-year T-note"],
  TU1: ["ZT=F", "2-year T-note"],
};

// Exchange codes to Yahoo suffixes, so "VOD LN" is Vodafone in London.
const EXCH = {
  US: "",
  UN: "",
  UW: "",
  UQ: "",
  LN: ".L",
  GR: ".DE",
  GY: ".DE",
  FP: ".PA",
  NA: ".AS",
  SM: ".MC",
  IM: ".MI",
  SW: ".SW",
  SE: ".SW",
  JP: ".T",
  JT: ".T",
  HK: ".HK",
  CN: ".TO",
  CT: ".TO",
  AU: ".AX",
  AT: ".AX",
  IN: ".NS",
  IS: ".NS",
  IB: ".BO",
  KS: ".KS",
  TT: ".TW",
  SP: ".SI",
  BZ: ".SA",
  MM: ".MX",
  SS: ".ST",
  NO: ".OL",
  DC: ".CO",
  FH: ".HE",
  BB: ".BR",
  ID: ".IR",
  PL: ".LS",
  AV: ".VI",
};
const CRYPTO = new Set([
  "BTC",
  "XBT",
  "ETH",
  "SOL",
  "XRP",
  "BNB",
  "DOGE",
  "ADA",
  "AVAX",
  "LINK",
  "DOT",
  "LTC",
  "BCH",
  "TRX",
  "XLM",
  "ATOM",
  "UNI",
  "NEAR",
  "SUI",
  "PEPE",
  "SHIB",
  "AAVE",
  "TON",
  "XMR",
  "HYPE",
]);
const FIAT = [
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "CHF",
  "AUD",
  "CAD",
  "NZD",
  "CNY",
  "HKD",
  "SEK",
  "NOK",
  "DKK",
  "SGD",
  "MXN",
  "ZAR",
  "INR",
  "BRL",
  "KRW",
  "TRY",
  "PLN",
];

// Turn the words of a command into a security the server can chart, or null.
export function toSecurity(words) {
  if (!words.length) return null;
  const yk = words.map((w) => YELLOW[w]).find(Boolean);
  const rest = words.filter((w) => !YELLOW[w]);
  const t = rest[0];
  if (!t) return null;
  const raw = words.join(" ");
  if (yk === "GOVT" && GOVTS[t]) {
    const [id, name] = YIELDS[GOVTS[t]];
    return { raw, ticker: t, sector: "GOVT", id, name: name.replace(" yield", ", on the run (yield)") };
  }
  if (yk === "INDEX" || (!yk && (INDICES[t] || YIELDS[t]))) {
    const ix = INDICES[t] || YIELDS[t];
    if (ix)
      return {
        raw,
        ticker: t,
        sector: "INDEX",
        id: ix[0],
        name: ix[1],
      };
    return {
      raw,
      ticker: t,
      sector: "INDEX",
      id: t.startsWith("^") ? t : `^${t}`,
    };
  }
  if (yk === "CMDTY" || (!yk && GENERICS[t])) {
    const g = GENERICS[t] || GENERICS[`${t}1`];
    if (g)
      return {
        raw,
        ticker: t,
        sector: "CMDTY",
        id: g[0],
        name: g[1],
      };
    return {
      raw,
      ticker: t,
      sector: "CMDTY",
      id: `${t.replace(/1$/, "")}=F`,
    };
  }
  if (
    yk === "CRNCY" ||
    (!yk &&
      /^[A-Z]{6}$/.test(t) &&
      FIAT.includes(t.slice(0, 3)) &&
      FIAT.includes(t.slice(3)))
  ) {
    const c = t.replace("/", "");
    const base = c.slice(0, 3) === "XBT" ? "BTC" : c.slice(0, 3);
    if (CRYPTO.has(base)) return { raw, ticker: base, sector: "CRYPTO", id: `${base}USDT` };
    const pair = c.length === 3 ? (c === "USD" ? "EURUSD" : `USD${c}`) : c;
    return { raw, ticker: pair, sector: "CRNCY", id: `FX:${pair}` };
  }
  if (yk === "CRYPTO" || (!yk && CRYPTO.has(t))) {
    const base = t === "XBT" ? "BTC" : t;
    return { raw, ticker: base, sector: "CRYPTO", id: `${base}USDT` };
  }
  // Equity: "AAPL", "AAPL US", "VOD LN".
  const ex = rest[1] && EXCH[rest[1]] !== undefined ? rest[1] : null;
  if (ex && EXCH[ex])
    return {
      raw,
      ticker: t,
      sector: "EQUITY",
      exch: ex,
      id: `${t}${EXCH[ex]}`,
    };
  if (t.includes(":") || t.includes("=") || t.includes("^"))
    return { raw, ticker: t, sector: yk || "EQUITY", id: t };
  return { raw, ticker: t, sector: "EQUITY", exch: ex || "US", id: t };
}

// ---------- Bloomberg-style labels ----------
// The canonical way the terminal writes a security: AAPL US EQUITY, VOD LN EQUITY, SPX INDEX, GC1 COMDTY.
export function bbgCode(sec) {
  if (!sec) return "";
  if (sec.sector === "EQUITY") return /[.:=^]/.test(sec.ticker) ? `${sec.ticker} EQUITY` : `${sec.ticker} ${sec.exch || "US"} EQUITY`;
  const word = { INDEX: "INDEX", CMDTY: "COMDTY", CRNCY: "CURNCY", CRYPTO: "CRYPTO", GOVT: "GOVT" }[sec.sector];
  return word ? `${sec.ticker} ${word}` : sec.raw;
}

// The Yahoo symbol for a security, for the board endpoint (prices, YTD, 52-week range, sparkline).
export function yahooSymbol(sec) {
  if (!sec) return null;
  if (sec.sector === "CRYPTO") return `${sec.ticker}-USD`;
  if (sec.sector === "CRNCY") return `${sec.id.replace(/^FX:/, "")}=X`;
  return sec.id;
}

export const CRYPTO_NAMES = {
  BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", XRP: "XRP", BNB: "BNB", DOGE: "Dogecoin", ADA: "Cardano",
  AVAX: "Avalanche", LINK: "Chainlink", DOT: "Polkadot", LTC: "Litecoin", BCH: "Bitcoin Cash", TRX: "Tron",
  XLM: "Stellar", ATOM: "Cosmos", UNI: "Uniswap", NEAR: "Near", SUI: "Sui", PEPE: "Pepe", SHIB: "Shiba Inu",
  AAVE: "Aave", TON: "Toncoin", XMR: "Monero", HYPE: "Hyperliquid",
};

// Yahoo suffix back to the exchange code: ".L" is LN. The first code listed for a suffix wins (.DE is GR).
const SUFFIX = {};
for (const [code, sfx] of Object.entries(EXCH)) if (sfx && !SUFFIX[sfx]) SUFFIX[sfx] = code;
const byYahoo = (map) => Object.fromEntries(Object.entries(map).map(([k, [y, n]]) => [y, [k, n]]));
const INDEX_BY_YAHOO = { ...byYahoo(INDICES), ...byYahoo(YIELDS) };
const GENERIC_BY_YAHOO = byYahoo(GENERICS);

const KEEP_UPPER = new Set(["PLC", "AG", "SA", "SE", "NV", "ASA", "AB", "SPA", "ETF", "CDR", "ADR", "REIT", "USA", "UK", "US"]);
// "Apple Inc. Common Stock" is "Apple Inc.", "VODAFONE GROUP PLC ORD USD0.20" is "Vodafone Group PLC".
export function cleanName(n) {
  let s = String(n || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s+(Common Stock|Common Shares|Ordinary Shares?|American Depositary Shares?|American Depository Shares?|Depositary Shares?|ORD\b.*)$/i, "")
    .trim();
  if (s && !/[a-z]/.test(s))
    s = s.replace(/[A-Z][A-Z'&]*/g, (w) => (KEEP_UPPER.has(w) ? w : w === "OF" || w === "AND" || w === "THE" ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase()));
  return s;
}

// One /api/search result as the terminal labels it, { code, name }, or null when it isn't something the
// command line can open (structured notes, other exchanges' copies of the same coin, unmapped exchanges).
export function searchLabel(r) {
  const m = /^([A-Z]+):(.+)$/.exec(String(r?.symbol || ""));
  if (!m) return null;
  const [, src, sym] = m;
  const type = String(r.type || "").toLowerCase();
  if (src === "US") {
    if (type === "crypto") return { code: `${sym} CRYPTO`, name: r.name || CRYPTO_NAMES[sym] || sym };
    if (/stock|etf|equity|adr/.test(type)) return { code: `${sym} US EQUITY`, name: cleanName(r.name) };
    return null;
  }
  if (src === "BINANCE") {
    const c = /^([A-Z0-9]{2,12})USDT$/.exec(sym);
    if (!c || FIAT.includes(c[1])) return null;
    return { code: `${c[1]} CRYPTO`, name: CRYPTO_NAMES[c[1]] || c[1] };
  }
  if (src === "FX") return { code: `${sym} CURNCY`, name: r.name };
  if (src === "YAHOO") {
    if (sym.startsWith("^")) {
      const k = INDEX_BY_YAHOO[sym];
      return { code: `${k ? k[0] : sym.slice(1)} INDEX`, name: k ? k[1] : cleanName(r.name) };
    }
    const fx = /^([A-Z]{3})([A-Z]{3})?=X$/.exec(sym);
    if (fx) return { code: `${fx[2] ? fx[1] + fx[2] : `USD${fx[1]}`} CURNCY`, name: r.name };
    if (/=F$/.test(sym)) {
      const g = GENERIC_BY_YAHOO[sym];
      return g ? { code: `${g[0]} COMDTY`, name: g[1] } : null;
    }
    const eq = /^([A-Z0-9-]+)(\.[A-Z]+)$/.exec(sym);
    if (eq && SUFFIX[eq[2]]) return { code: `${eq[1]} ${SUFFIX[eq[2]]} EQUITY`, name: cleanName(r.name) };
  }
  return null;
}

// The terminal's own names first (SPX, GC1, USGG10YR, BTC), so "gold", "nikkei" or "10-year" find them.
function localMatches(q) {
  const out = [];
  const add = (code, name) => out.push({ code, name });
  const w = q.toLowerCase();
  const hit = (k, n) => k === q || String(n).toLowerCase().split(/[^a-z0-9&-]+/).some((p) => p.startsWith(w)) || String(n).toLowerCase().startsWith(w);
  for (const [k, [, n]] of Object.entries(INDICES)) if (hit(k, n)) add(`${k} INDEX`, n);
  for (const [k, [, n]] of Object.entries(YIELDS)) if (hit(k, n)) add(`${k} INDEX`, n);
  for (const [k, [, n]] of Object.entries(GENERICS)) if (hit(k, n)) add(`${k} COMDTY`, n);
  for (const [k, n] of Object.entries(CRYPTO_NAMES)) if (hit(k, n)) add(`${k} CRYPTO`, n);
  return out;
}

// Search results as the security lookup lists them: exact ticker first, the terminal's own names, then the
// rest in the order the sources ranked them, without duplicates.
export function lookupList(results, query, max = 8) {
  const q = String(query || "").trim().toUpperCase();
  const all = [...localMatches(q), ...(results || []).map(searchLabel).filter(Boolean)];
  const seen = new Set();
  const uniq = all.filter((r) => !seen.has(r.code) && seen.add(r.code));
  const exact = uniq.filter((r) => r.code.split(" ")[0] === q.replace(/\s+/g, ""));
  return [...exact, ...uniq.filter((r) => !exact.includes(r))].slice(0, max);
}

