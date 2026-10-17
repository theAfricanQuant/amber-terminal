// /api/fn/insd?symbol=AAPL : recent insider transactions.
// Primary: the company's latest SEC Form 4 filings, read straight from their XML. Fallback: Nasdaq's insider-trades list.
import { getJson, cached, NQ, resolve } from "../providers.js";
import {
  SEC_HEADERS,
  loadTickers,
  lookupCik,
  secSubmissions,
  filingRows,
} from "./cf.js";

const FILINGS = 30; // Form 4s read per lookup
const PARALLEL = 5; // SEC asks for no more than 10 requests a second

// Transaction codes on Form 4, in plain words. side: "buy" and "sell" are open-market trades only.
const TYPES = {
  P: ["Buy", "buy"],
  S: ["Sell", "sell"],
  A: ["Award", null],
  F: ["Tax withheld", null],
  M: ["Option exercise", null],
  X: ["Option exercise", null],
  O: ["Option exercise", null],
  C: ["Conversion", null],
  G: ["Gift", null],
  D: ["Sold to company", null],
  J: ["Other", null],
  I: ["Fund-managed buy or sell", null],
  W: ["Inheritance", null],
  L: ["Small purchase", null],
  V: ["Reported early", null],
  U: ["Tender offer", null],
};
export const typeOf = (code) =>
  TYPES[String(code || "").toUpperCase()] || [`Code ${code || "?"}`, null];

// ---------- Form 4 XML ----------
const unxml = (s) =>
  String(s ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
const block = (xml, tag) => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1] : "";
};
const blocks = (xml, tag) =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (m) => m[1],
  );
// <tag><value>x</value></tag> (the value may sit beside a footnote marker)
const valueOf = (xml, tag) => {
  const m = /<value>\s*([^<]*?)\s*<\/value>/.exec(block(xml, tag));
  return m ? unxml(m[1]) : "";
};
const flag = (xml, tag) => /^(1|true)$/i.test(unxml(block(xml, tag)));
const numOrNull = (s) => {
  const v = parseFloat(String(s ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(v) ? v : null;
};

// SEC writes names as "COXE TENCH" or "Newstead Jennifer": show all-caps ones in normal case.
export const niceName = (s) => {
  const t = String(s || "").trim();
  return t && t === t.toUpperCase()
    ? t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
    : t;
};

export function parseForm4(xml) {
  const text = String(xml || "");
  const owner = block(text, "reportingOwner");
  const rel = block(owner, "reportingOwnerRelationship");
  const roles = [
    unxml(block(rel, "officerTitle")) ||
      (flag(rel, "isOfficer") ? "Officer" : ""),
    flag(rel, "isDirector") ? "Director" : "",
    flag(rel, "isTenPercentOwner") ? "10% owner" : "",
    flag(rel, "isOther") ? unxml(block(rel, "otherText")) || "Other" : "",
  ].filter(Boolean);
  const notes = {};
  for (const m of text.matchAll(
    /<footnote id="([^"]+)">([\s\S]*?)<\/footnote>/g,
  ))
    notes[m[1]] = unxml(m[2]);
  const planBox = flag(text, "aff10b5One");
  const trades = blocks(text, "nonDerivativeTransaction").map((b) => {
    const code = unxml(block(block(b, "transactionCoding"), "transactionCode"));
    const planNote = [...b.matchAll(/<footnoteId id="([^"]+)"/g)].some((m) =>
      /10b5-1/i.test(notes[m[1]] || ""),
    );
    return {
      date: valueOf(b, "transactionDate"),
      code,
      shares: numOrNull(valueOf(b, "transactionShares")),
      price: numOrNull(valueOf(b, "transactionPricePerShare")),
      acquired: valueOf(b, "transactionAcquiredDisposedCode"),
      held: numOrNull(valueOf(b, "sharesOwnedFollowingTransaction")),
      owned:
        valueOf(b, "directOrIndirectOwnership") === "I" ? "Indirect" : "Direct",
      plan: planNote || (planBox && (code === "S" || code === "P")),
    };
  });
  return {
    issuerCik: Number(unxml(block(block(text, "issuer"), "issuerCik"))) || null,
    name: niceName(unxml(block(owner, "rptOwnerName"))),
    role: roles.join(", "),
    trades,
  };
}

// Several lots sold the same day at different prices become one row, at their average price.
export function mergeTrades(trades) {
  const groups = new Map();
  for (const t of trades) {
    const k = [t.accession, t.date, t.code, t.acquired, t.owned].join("|");
    const g = groups.get(k);
    if (!g) {
      groups.set(k, {
        ...t,
        value: t.price > 0 ? (t.shares || 0) * t.price : 0,
        priced: t.price > 0 ? t.shares || 0 : 0,
      });
      continue;
    }
    g.shares = (g.shares || 0) + (t.shares || 0);
    if (t.price > 0) {
      g.value += (t.shares || 0) * t.price;
      g.priced += t.shares || 0;
    }
    g.held = t.held ?? g.held;
    g.plan = g.plan || t.plan;
  }
  return [...groups.values()].map(({ value, priced, ...g }) => ({
    ...g,
    price: priced ? value / priced : null,
    value: priced ? value : null,
  }));
}

// ---------- reading Form 4s ----------
const form4Cache = new Map(); // a filed Form 4 never changes, so it is kept for the session
async function readForm4(row) {
  if (form4Cache.has(row.accession)) return form4Cache.get(row.accession);
  const res = await fetch(
    `https://www.sec.gov/Archives/edgar/data/${row.cik}/${row.accession.replace(/-/g, "")}/${row.rawDoc}`,
    { headers: SEC_HEADERS, signal: AbortSignal.timeout(10000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const parsed = parseForm4(await res.text());
  if (form4Cache.size >= 600) form4Cache.delete(form4Cache.keys().next().value);
  form4Cache.set(row.accession, parsed);
  return parsed;
}

async function inPool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]).catch(() => null);
      }
    }),
  );
  return out;
}

export function toRow(t, who, filing) {
  const [type, side] = typeOf(t.code);
  return {
    name: who.name,
    role: who.role,
    date: t.date,
    code: t.code,
    type,
    side,
    shares: t.shares,
    price: t.price,
    value: t.value,
    held: t.held,
    owned: t.owned,
    plan: !!t.plan,
    filed: filing.filed,
    url: filing.url,
  };
}

const byNewest = (a, b) =>
  String(b.date).localeCompare(String(a.date)) ||
  String(b.filed).localeCompare(String(a.filed));

async function fromSec(ticker) {
  const entry = lookupCik(await loadTickers(), ticker);
  if (!entry) return null;
  const sub = await secSubmissions(entry.cik);
  // Amendments (4/A) restate trades already listed, so only the originals are read.
  const all = filingRows(sub).filter((r) => r.form === "4");
  // A company that is also a big shareholder (Berkshire) has Form 4s about other companies in its list:
  // keep only filings where it is the issuer, reading further back if the first batch has few.
  const mine = [];
  let read = 0;
  for (let from = 0; from < all.length && mine.length < FILINGS && from < FILINGS * 3; from += FILINGS) {
    const batch = all.slice(from, from + FILINGS);
    const parsed = await inPool(batch, PARALLEL, readForm4);
    parsed.forEach((p, i) => {
      if (!p) return;
      read++;
      if (!p.issuerCik || p.issuerCik === entry.cik) mine.push([batch[i], p]);
    });
  }
  if (all.length && !read) throw new Error("None of the Form 4 files could be read");
  const rows = [];
  for (const [filing, p] of mine) {
    const trades = mergeTrades(p.trades.map((t) => ({ ...t, accession: filing.accession })));
    for (const t of trades) rows.push(toRow(t, p, filing));
  }
  return {
    name: sub.name || entry.name,
    rows: rows.sort(byNewest),
    source: mine.length
      ? `SEC Form 4 filings (sec.gov), the latest ${mine.length}. Insiders must file within 2 business days`
      : "SEC Form 4 filings (sec.gov): none filed recently",
  };
}

// ---------- Nasdaq fallback ----------
const mdy = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || "").trim());
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
};

export function parseNasdaqInsiders(json) {
  const rows = json?.data?.transactionTable?.table?.rows || [];
  return rows.map((r) => {
    const raw = String(r.transactionType || "");
    const side = /\bbuy$/i.test(raw)
      ? "buy"
      : /\bsell$/i.test(raw)
        ? "sell"
        : null;
    const shares = numOrNull(r.sharesTraded);
    const price = numOrNull(r.lastPrice);
    return {
      name: niceName(r.insider),
      role: r.relation || "",
      date: mdy(r.lastDate),
      code: "",
      type: side
        ? side === "buy"
          ? "Buy"
          : "Sell"
        : raw
            .replace(/Execute/i, "exercise")
            .replace(/\s*\(Non Open Market\)/i, " (not a market trade)"),
      side,
      shares,
      price: price > 0 ? price : null,
      value: shares && price > 0 ? shares * price : null,
      held: numOrNull(r.sharesHeld),
      owned: r.ownType || "",
      plan: /automatic/i.test(raw),
      filed: "",
      url: r.url ? `https://www.nasdaq.com${r.url}` : "",
    };
  });
}

async function fromNasdaq(ticker) {
  const j = await getJson(
    `https://api.nasdaq.com/api/company/${encodeURIComponent(ticker)}/insider-trades?limit=50&type=ALL&sortColumn=lastDate&sortOrder=DESC`,
    NQ,
  );
  return {
    name: null,
    rows: parseNasdaqInsiders(j),
    source:
      "Nasdaq's insider trades list, which copies SEC Form 4 filings (the SEC itself did not answer)",
  };
}

export default async function (q) {
  const sym = await resolve(q.symbol);
  if (sym.exchange !== "US")
    throw Object.assign(
      new Error("Insider transactions are for US-listed companies."),
      { status: 422 },
    );
  return cached(`insd:${sym.ticker}`, 10 * 60e3, async () => {
    let secError;
    try {
      const d = await fromSec(sym.ticker);
      if (d) return { symbol: sym.id, ...d };
    } catch (e) {
      secError = e;
    }
    const nq = await fromNasdaq(sym.ticker).catch(() => null);
    if (nq?.rows.length) return { symbol: sym.id, ...nq };
    if (secError)
      throw Object.assign(
        new Error(
          "The SEC filing system couldn't be reached. Try again in a minute.",
        ),
        { status: 502 },
      );
    throw Object.assign(
      new Error(
        `No insider filings found for ${sym.ticker}. Funds and ETFs have none, so try a company ticker such as AAPL.`,
      ),
      { status: 404 },
    );
  });
}
