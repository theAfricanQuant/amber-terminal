// /api/fn/ds?q="going concern" 10-K&range=1y&symbol=AAPL : full-text search of SEC filings.
// EDGAR's own full-text search (efts.sec.gov, the search behind sec.gov/edgar/search), no key.
// /api/fn/ds?doc=<sec.gov Archives url>&q=... : the passages in one document that match the search.
import { getJson, cached, resolve } from "../providers.js";
import { SEC_HEADERS, loadTickers, lookupCik } from "./cf.js";

const EFTS = "https://efts.sec.gov/LATEST/search-index";
const ARCHIVE = "https://www.sec.gov/Archives/edgar/data";
const TTL = 10 * 60e3;

export const FORMS = ["ALL", "10-K", "10-Q", "8-K"];
export const RANGES = { "30D": 30, "1Y": 365, "5Y": 1826 };
const FORM_WORDS = {
  ALL: "ALL",
  "10-K": "10-K",
  "10K": "10-K",
  "10-Q": "10-Q",
  "10Q": "10-Q",
  "8-K": "8-K",
  "8K": "8-K",
};
const RANGE_WORDS = {
  "30D": "30D",
  "1M": "30D",
  "1Y": "1Y",
  "12M": "1Y",
  "5Y": "5Y",
};
const OPS = new Set(["OR", "AND", "NOT"]);

// The command line arrives uppercased and split on spaces: ['"GOING', 'CONCERN"', '10-K'].
// Quoted phrases are joined back together, form and date words come out, everything else is lowercased
// (EDGAR's search ignores case). OR, AND and NOT between two terms stay as search operators.
export function parseSearch(text) {
  const s = String(text ?? "").replace(/[“”„‟″]/g, '"');
  const tokens = [];
  let form = null;
  let range = null;
  for (let i = 0; i < s.length;) {
    if (/\s/.test(s[i])) {
      i++;
      continue;
    }
    if (s[i] === '"') {
      const end = s.indexOf('"', i + 1);
      const phrase = s
        .slice(i + 1, end < 0 ? s.length : end)
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (phrase) tokens.push({ phrase });
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    let j = i;
    while (j < s.length && !/\s/.test(s[j]) && s[j] !== '"') j++;
    const w = s.slice(i, j);
    const up = w.toUpperCase();
    i = j;
    if (FORM_WORDS[up]) form = FORM_WORDS[up];
    else if (RANGE_WORDS[up]) range = RANGE_WORDS[up];
    else tokens.push({ word: w });
  }
  // An operator only means something between two terms.
  const parts = tokens.map((t, k) => {
    if (t.phrase) return `"${t.phrase}"`;
    const up = t.word.toUpperCase();
    const between = k > 0 && k < tokens.length - 1;
    return OPS.has(up) && between ? up : t.word.toLowerCase();
  });
  return { query: parts.join(" "), form, range };
}

const nyToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

export function rangeDates(range, today = nyToday()) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (RANGES[range] || RANGES["1Y"]));
  return { start: d.toISOString().slice(0, 10), end: today };
}

// EDGAR only filters by date with dateRange=custom plus both dates (dateRange=1y on its own is ignored).
export function buildUrl({
  query,
  form = "ALL",
  range = "1Y",
  cik = null,
  today,
}) {
  const { start, end } = rangeDates(range, today);
  const p = new URLSearchParams({
    q: query,
    dateRange: "custom",
    startdt: start,
    enddt: end,
  });
  if (form && form !== "ALL") p.set("forms", form);
  if (cik) p.set("ciks", String(cik).padStart(10, "0"));
  return `${EFTS}?${p.toString().replace(/\+/g, "%20")}`;
}

// "Apple Inc.  (AAPL)  (CIK 0000320193)" -> name, tickers, cik. Tickers are missing for companies without one.
export function parseDisplayName(s) {
  const text = String(s || "");
  const cik = /\(CIK (\d+)\)/.exec(text)?.[1] || null;
  const tick = /\(([A-Z0-9.\-, ]+)\)\s*\(CIK \d+\)/.exec(text)?.[1];
  const name = text
    .replace(/\s*\(CIK \d+\)\s*$/, "")
    .replace(/\s*\([^()]*\)\s*$/, (m) => (tick ? "" : m))
    .trim();
  return {
    name,
    tickers: tick
      ? tick
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    cik: cik ? String(Number(cik)) : null,
  };
}

// One row per filing (the best-matching document in it), newest first.
export function parseHits(json, { cik = null } = {}) {
  const seen = new Set();
  const rows = [];
  for (const h of json?.hits?.hits || []) {
    const s = h._source || {};
    const [adsh, file] = String(h._id || "").split(":");
    if (!adsh || !file || seen.has(adsh)) continue;
    seen.add(adsh);
    const names = (s.display_names || []).map(parseDisplayName);
    const who = (cik && names.find((n) => n.cik === String(Number(cik)))) ||
      names[0] || { name: "", tickers: [] };
    const folderCik = String(Number(s.ciks?.[0] || who.cik || 0));
    const folder = `${ARCHIVE}/${folderCik}/${adsh.replace(/-/g, "")}`;
    const type = s.file_type || s.form || "";
    const desc = String(s.file_description || "").trim();
    rows.push({
      company: who.name,
      ticker: who.tickers[0] || null,
      others: Math.max(0, names.length - 1),
      form: s.form || s.root_forms?.[0] || "",
      document:
        type === s.form ? "Main document" : type.replace(/^EX-/, "Exhibit "),
      title: desc && !/^((form|exhibit|ex)[\s-]*)?[\w.-]+$/i.test(desc) ? desc : null,
      filed: s.file_date || null,
      period: s.period_ending || null,
      accession: adsh,
      url: `${folder}/${file}`,
      filingUrl: `${folder}/${adsh}-index.htm`,
      snippet: null, // EDGAR's search doesn't return the matching text; ?doc= fetches it for one document.
    });
  }
  return rows.sort((a, b) => String(b.filed).localeCompare(String(a.filed)));
}

// SEC allows 10 requests a second from one machine; this keeps every DS call under that.
let nextSlot = 0;
async function secSlot() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 110;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

// ---------- matching passages in one document ----------
const ENT = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  mdash: "—",
  ndash: "–",
  sect: "§",
};
export function htmlToText(html) {
  return String(html || "")
    .replace(/<ix:header[\s\S]*?<\/ix:header>/gi, " ")
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, " ")
    .replace(/ ([.,;:)])/g, "$1")
    .trim();
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// What to look for in the text: the phrases first, then the words, never the excluded ones.
export function searchTerms(query) {
  const out = [];
  const s = String(query || "");
  for (const m of s.matchAll(/"([^"]+)"/g)) out.push(m[1]);
  const rest = s.replace(/"[^"]*"/g, " ").split(/\s+/);
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k];
    if (!w || OPS.has(w) || w.startsWith("-") || rest[k - 1] === "NOT")
      continue;
    out.push(w);
  }
  return out;
}

// A full stop that ends a sentence, not one in "No.", "Inc.", "U.S." or an initial.
const SENTENCE_END = /(?<!\b(?:No|Nos|Inc|Corp|Co|Ltd|Mr|Ms|Dr|vs|[A-Za-z]))[.;?!](?=\s|$)/g;

export function passages(text, query, { max = 3, span = 260 } = {}) {
  const terms = searchTerms(query);
  const found = [];
  let count = 0;
  for (const t of terms) {
    const re = new RegExp(`\\b${t.split(" ").map(reEsc).join("\\s+")}`, "gi");
    for (const m of text.matchAll(re)) {
      count++;
      if (
        found.length >= max ||
        found.some((f) => Math.abs(f.at - m.index) < span * 2)
      )
        continue;
      // Back to the start of the sentence, forward to its end, within a few hundred characters.
      const before = text.slice(Math.max(0, m.index - span), m.index);
      const ends = [...before.matchAll(SENTENCE_END)];
      const stop = ends.length ? ends.at(-1).index + 1 : -1;
      const from =
        stop >= 0
          ? m.index - before.length + stop
          : Math.max(0, m.index - span);
      const after = text.slice(m.index, m.index + span + t.length);
      const end = new RegExp(SENTENCE_END.source).exec(after.slice(t.length));
      const to = end
        ? m.index + t.length + end.index + 1
        : Math.min(text.length, m.index + span + t.length);
      const body = text.slice(from, to).trim();
      found.push({
        at: m.index,
        text: `${stop < 0 && from > 0 ? "…" : ""}${body}${end || to >= text.length ? "" : "…"}`,
      });
    }
    if (found.length) break;
  }
  return {
    matches: count,
    passages: found.sort((a, b) => a.at - b.at).map((f) => f.text),
  };
}

async function docPassages(url, query) {
  if (
    !/^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/\d+\/\d+\/[\w.-]+$/.test(
      url,
    )
  )
    throw Object.assign(
      new Error("Only documents on sec.gov can be opened here."),
      { status: 400 },
    );
  if (/\.pdf$/i.test(url))
    return {
      url,
      matches: null,
      passages: [],
      note: "This document is a PDF. Open it to read the match.",
    };
  return cached(`ds:doc:${url}:${query}`, 60 * 60e3, async () => {
    await secSlot();
    const res = await fetch(url, {
      headers: SEC_HEADERS,
      signal: AbortSignal.timeout(20000),
    }).catch((e) => {
      throw Object.assign(
        new Error(
          `sec.gov couldn't be reached (${e.cause?.code || e.message})`,
        ),
        { status: 502 },
      );
    });
    if (!res.ok)
      throw Object.assign(new Error(`sec.gov returned HTTP ${res.status}`), {
        status: 502,
      });
    return { url, ...passages(htmlToText(await res.text()), query) };
  });
}

// ---------- the function ----------
export default async function (q) {
  const parsed = parseSearch(q.q);
  if (q.doc) return docPassages(String(q.doc), parsed.query);
  const form = FORMS.includes(String(q.form || "").toUpperCase())
    ? String(q.form).toUpperCase()
    : parsed.form || "ALL";
  const range =
    RANGE_WORDS[String(q.range || "").toUpperCase()] || parsed.range || "1Y";
  if (!parsed.query)
    throw Object.assign(
      new Error(
        'Type what to search for, for example DS "going concern" or DS buyback 8-K.',
      ),
      { status: 400 },
    );

  let company = null;
  if (q.symbol) {
    const sym = await resolve(q.symbol);
    if (sym.exchange !== "US")
      throw Object.assign(
        new Error(
          "Document search covers US filers. Leave the security off to search every company.",
        ),
        { status: 422 },
      );
    const hit = lookupCik(await loadTickers(), sym.ticker);
    if (!hit)
      throw Object.assign(
        new Error(
          `The SEC has no filer under ${sym.ticker}. Leave the security off to search every company.`,
        ),
        { status: 404 },
      );
    company = { ticker: sym.ticker, cik: hit.cik, name: hit.name };
  }

  const url = buildUrl({ query: parsed.query, form, range, cik: company?.cik });
  return cached(`ds:${url}`, TTL, async () => {
    await secSlot();
    let j;
    try {
      j = await getJson(url, SEC_HEADERS);
    } catch (e) {
      throw Object.assign(
        new Error(
          `EDGAR's full-text search didn't answer (${e.message}). Try again in a minute.`,
        ),
        { status: 502 },
      );
    }
    const rows = parseHits(j, { cik: company?.cik });
    const total = j?.hits?.total || {};
    const { start, end } = rangeDates(range);
    return {
      query: parsed.query,
      form,
      range,
      from: start,
      to: end,
      company,
      total: Number(total.value) || 0,
      totalIsFloor: total.relation === "gte",
      rows,
      searchUrl: `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(parsed.query)}&dateRange=custom&startdt=${start}&enddt=${end}${form !== "ALL" ? `&forms=${form}` : ""}${company ? `&ciks=${String(company.cik).padStart(10, "0")}` : ""}`,
      source:
        "SEC EDGAR full-text search, the same search as sec.gov/edgar/search. It covers filings since 2001",
    };
  });
}
