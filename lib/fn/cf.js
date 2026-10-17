// /api/fn/cf?symbol=AAPL&form=ALL|10-K|10-Q|8-K|4 : a company's latest SEC filings.
// Primary: SEC's submissions API (ticker to CIK from company_tickers.json). Fallback: Nasdaq's filings list.
// The SEC helpers at the top are shared with insd.js.
import { getJson, cached, NQ, resolve } from "../providers.js";

// SEC asks every script to say who it is.
export const SEC_HEADERS = {
  "User-Agent": "AmberTerminal/1.0 (+https://github.com/theAfricanQuant/amber-terminal)",
};
const ARCHIVE = "https://www.sec.gov/Archives/edgar/data";

// ---------- ticker to CIK ----------
export function tickerIndex(json) {
  const map = new Map();
  for (const r of Object.values(json || {}))
    if (r?.ticker && r.cik_str != null)
      map.set(String(r.ticker).toUpperCase(), {
        cik: Number(r.cik_str),
        name: r.title || "",
      });
  return map;
}

// Share classes are BRK-B at the SEC and BRK.B or BRK-B elsewhere.
export function lookupCik(index, ticker) {
  const t = String(ticker || "").toUpperCase();
  return (
    index.get(t) ||
    index.get(t.replace(/\./g, "-")) ||
    index.get(t.replace(/-/g, ".")) ||
    null
  );
}

export const loadTickers = () =>
  cached("sec:tickers", 24 * 3600e3, async () =>
    tickerIndex(
      await getJson(
        "https://www.sec.gov/files/company_tickers.json",
        SEC_HEADERS,
      ),
    ),
  );

export const secSubmissions = (cik) =>
  cached(`sec:sub:${cik}`, 10 * 60e3, () =>
    getJson(
      `https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`,
      SEC_HEADERS,
    ),
  );

// ---------- plain-words descriptions ----------
const FORM_WORDS = {
  "10-K": "Annual report",
  "10-Q": "Quarterly report",
  "8-K": "Event report",
  4: "Insider trade report",
  3: "First insider holdings report",
  5: "Insider year-end report",
  144: "Notice of a planned insider sale",
  "DEF 14A": "Proxy statement for the shareholder vote",
  DEFA14A: "Extra proxy material",
  PX14A6G: "Shareholder letter to other investors",
  PX14A6N: "Shareholder letter to other investors",
  "S-8": "Employee stock plan registration",
  "S-8 POS": "Employee stock plan registration update",
  "S-3": "Share sale registration",
  "S-3ASR": "Share sale registration",
  "S-1": "Share sale registration",
  424: "Prospectus for a share or bond sale",
  FWP: "Marketing material for a sale",
  "SC 13G": "Report of a stake over 5%",
  "SC 13D": "Report of an activist stake over 5%",
  "SCHEDULE 13G": "Report of a stake over 5%",
  "SCHEDULE 13D": "Report of an activist stake over 5%",
  "13F-HR": "Fund holdings report",
  "6-K": "Foreign company news report",
  "20-F": "Annual report (foreign company)",
  "40-F": "Annual report (foreign company)",
  "11-K": "Employee plan annual report",
  "25-NSE": "Stock exchange delisting notice",
  SD: "Conflict minerals report",
  UPLOAD: "Letter from the SEC",
  CORRESP: "Reply to the SEC",
  "NO ACT": "SEC no-action letter",
  "NT 10-K": "Late filing notice",
  "NT 10-Q": "Late filing notice",
  "8-A12B": "Stock listing registration",
  ARS: "Annual report to shareholders",
  CERT: "Exchange listing certification",
  CERTNYS: "Exchange listing certification",
  EFFECT: "Registration went live",
  IRANNOTICE: "Iran activity notice",
};

const EIGHT_K_ITEMS = {
  1.01: "signed a major agreement",
  1.02: "ended a major agreement",
  1.03: "bankruptcy",
  1.05: "cyber security incident",
  2.01: "completed a purchase or sale of assets",
  2.02: "results (earnings)",
  2.03: "took on new debt",
  2.04: "debt payment came due early",
  2.05: "restructuring costs",
  2.06: "asset write-down",
  3.01: "stock exchange listing notice",
  3.02: "sold unregistered shares",
  3.03: "changed shareholder rights",
  4.01: "changed auditor",
  4.02: "past financials should not be relied on",
  5.01: "change of control",
  5.02: "executive or director change",
  5.03: "changed company rules (bylaws)",
  5.05: "code of ethics change",
  5.07: "shareholder vote results",
  5.08: "shareholder meeting date",
  7.01: "investor update",
  8.01: "other event",
  9.01: "documents attached",
};

const lookupWords = (form) => {
  const f = String(form || "").toUpperCase();
  return FORM_WORDS[f] || (f.startsWith("424B") ? FORM_WORDS[424] : null);
};

export function describe(form, items, docDescription) {
  const amended = /\/A$/i.test(form || "");
  const base = String(form || "").replace(/\/A$/i, "");
  let text = lookupWords(base) || docDescription || base || "Filing";
  if (base === "8-K" && items) {
    const labels = String(items)
      .split(",")
      .map((i) => EIGHT_K_ITEMS[i.trim()])
      .filter(Boolean);
    const main = labels.filter((l) => l !== EIGHT_K_ITEMS["9.01"]);
    const shown = main.length ? main : labels;
    if (shown.length) text += `: ${shown.slice(0, 3).join(", ")}`;
  }
  return amended ? `${text} (amended)` : text;
}

// ---------- filings from the submissions API ----------
// The raw XML of a Form 4 sits next to its styled HTML page: drop the xslF345X0N/ folder.
export const rawDoc = (primaryDocument) =>
  String(primaryDocument || "").replace(/^xsl[^/]*\//, "");

export function filingRows(sub) {
  const r = sub?.filings?.recent;
  if (!r?.form) return [];
  const cik = String(Number(sub.cik));
  return r.form.map((form, i) => {
    const acc = r.accessionNumber[i];
    const folder = `${ARCHIVE}/${cik}/${acc.replace(/-/g, "")}`;
    const doc = r.primaryDocument[i];
    return {
      form,
      filed: r.filingDate[i],
      period: r.reportDate[i] || null,
      accession: acc,
      items: r.items[i] || "",
      description: describe(form, r.items[i], r.primaryDocDescription[i]),
      url: doc ? `${folder}/${doc}` : `${folder}/${acc}-index.htm`,
      rawDoc: rawDoc(doc),
      cik,
    };
  });
}

// "10-K" also takes 10-K405 and 10-KT; "4" takes only Form 4 (and its amendments).
export function filterForm(rows, want) {
  const w = String(want || "ALL").toUpperCase();
  if (w === "ALL") return rows;
  return rows.filter((r) => {
    const base = String(r.form).toUpperCase().split("/")[0];
    return base === w || (w.length > 1 && base.startsWith(w));
  });
}

const FORM_ALIASES = { "10K": "10-K", "10Q": "10-Q", "8K": "8-K", FORM4: "4" };
export function normForm(raw) {
  const w = String(raw || "ALL")
    .toUpperCase()
    .trim()
    .replace(/\s+/g, " ");
  return FORM_ALIASES[w.replace(/ /g, "")] || (w.length <= 14 ? w : "ALL");
}

// ---------- Nasdaq fallback ----------
const mdy = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || "").trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
};

export function parseNasdaqFilings(json) {
  return (json?.data?.rows || [])
    .map((r) => ({
      form: r.formType || "",
      filed: mdy(r.filed),
      period: mdy(r.period),
      description: describe(r.formType, "", ""),
      url: r.view?.htmlLink || r.view?.pdfLink || "",
      owner: r.reportingOwner || "",
    }))
    .filter((r) => r.form && /^https?:\/\//.test(r.url));
}

const LIMIT = 100;

async function fromSec(ticker, want) {
  const entry = lookupCik(await loadTickers(), ticker);
  if (!entry) return null;
  const sub = await secSubmissions(entry.cik);
  const rows = filterForm(filingRows(sub), want);
  return {
    name: sub.name || entry.name,
    cik: String(entry.cik).padStart(10, "0"),
    total: rows.length,
    filings: rows.slice(0, LIMIT).map(({ rawDoc: _r, cik: _c, ...f }) => f),
    source:
      "SEC EDGAR (sec.gov), the official filing system. New filings show up within minutes",
  };
}

async function fromNasdaq(ticker, want) {
  const j = await getJson(
    `https://api.nasdaq.com/api/company/${encodeURIComponent(ticker)}/sec-filings?limit=${LIMIT}&sortColumn=filed&sortOrder=desc`,
    NQ,
  );
  const rows = filterForm(parseNasdaqFilings(j), want);
  return {
    name: null,
    cik: null,
    total: rows.length,
    filings: rows,
    source:
      "Nasdaq's filings list, which copies SEC EDGAR (the SEC itself did not answer)",
  };
}

export default async function (q) {
  const sym = await resolve(q.symbol);
  if (sym.exchange !== "US")
    throw Object.assign(new Error("Filings are for US-listed companies."), {
      status: 422,
    });
  const want = normForm(q.form);
  return cached(`cf:${sym.ticker}:${want}`, 10 * 60e3, async () => {
    let secError;
    try {
      const d = await fromSec(sym.ticker, want);
      if (d) return { symbol: sym.id, form: want, ...d };
    } catch (e) {
      secError = e;
    }
    const nq = await fromNasdaq(sym.ticker, want).catch(() => null);
    if (nq?.filings.length) return { symbol: sym.id, form: want, ...nq };
    if (secError)
      throw Object.assign(
        new Error(
          "The SEC filing system couldn't be reached. Try again in a minute.",
        ),
        { status: 502 },
      );
    throw Object.assign(
      new Error(
        `The SEC has no company filings under ${sym.ticker}. Funds and ETFs often file under a different name, so try a company ticker such as AAPL.`,
      ),
      { status: 404 },
    );
  });
}
