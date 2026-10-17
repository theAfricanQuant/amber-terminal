// Building blocks for function screens: tables, key-value grids, tabs and charts, all in the terminal's look.
import { esc } from "./api.js";

// cols: [{ key, label, left, fmt(v,row) -> text, cls(v,row) -> class, html: true }]
export function table(rows, cols, { onRow, max = 500 } = {}) {
  const head = cols
    .map((c) => `<th class="${c.left ? "l" : ""}">${esc(c.label)}</th>`)
    .join("");
  const body = rows
    .slice(0, max)
    .map((r, i) => {
      const tds = cols
        .map((c) => {
          const v = typeof c.key === "function" ? c.key(r) : r[c.key];
          const txt = c.fmt ? c.fmt(v, r) : v;
          const k = [
            c.left ? "l" : "",
            c.cls ? c.cls(v, r) : "",
            c.lbl ? "lbl" : "",
            c.wrap ? "wrap" : "",
          ].join(" ");
          return `<td class="${k}">${c.html ? (txt ?? "") : esc(txt ?? "—")}</td>`;
        })
        .join("");
      return `<tr data-i="${i}" class="${onRow ? "click" : ""}">${tds}</tr>`;
    })
    .join("");
  const el = document.createElement("table");
  el.className = "t";
  el.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  if (onRow)
    el.addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-i]");
      if (tr) onRow(rows[+tr.dataset.i]);
    });
  return el;
}

export function kv(pairs) {
  const el = document.createElement("div");
  el.className = "kv";
  el.innerHTML = pairs
    .filter(([, v]) => v != null && v !== "")
    .map(
      ([k, v]) =>
        `<div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>`,
    )
    .join("");
  return el;
}

export function sect(title) {
  const h = document.createElement("h3");
  h.className = "sect";
  h.textContent = title;
  return h;
}

export function html(s) {
  const d = document.createElement("div");
  d.innerHTML = s;
  return d.childElementCount === 1 ? d.firstElementChild : d;
}

export function tabs(names, current, onPick) {
  const el = document.createElement("div");
  el.className = "tabs";
  for (const n of names) {
    const b = document.createElement("button");
    b.className = `tab${n === current ? " on" : ""}`;
    b.textContent = n;
    b.onclick = () => onPick(n);
    el.append(b);
  }
  return el;
}

const css = (n) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// A price chart in the terminal's colours. Returns { chart, series, remove }.
export function priceChart(host, { type = "line", height } = {}) {
  const LW = window.LightweightCharts;
  const chart = LW.createChart(host, {
    autoSize: true,
    height,
    layout: {
      background: { type: "solid", color: "#050505" },
      textColor: css("--amber"),
      fontFamily: css("--mono"),
      fontSize: 11,
      attributionLogo: true, // TradingView's required attribution remains visible
    },
    grid: { vertLines: { color: "#161616" }, horzLines: { color: "#161616" } },
    rightPriceScale: { borderColor: "#262626" },
    timeScale: { borderColor: "#262626", timeVisible: true },
    crosshair: { mode: 0 },
  });
  const series =
    type === "candles"
      ? chart.addSeries(LW.CandlestickSeries, {
          upColor: css("--up"),
          downColor: css("--down"),
          wickUpColor: css("--up"),
          wickDownColor: css("--down"),
          borderVisible: false,
        })
      : chart.addSeries(LW.AreaSeries, {
          lineColor: css("--amber"),
          topColor: "rgba(255,160,40,0.28)",
          bottomColor: "rgba(255,160,40,0.02)",
          lineWidth: 2,
        });
  return { chart, series, remove: () => chart.remove() };
}

export function lineChart(host, seriesList, { percent = false } = {}) {
  const LW = window.LightweightCharts;
  const chart = LW.createChart(host, {
    autoSize: true,
    layout: {
      background: { type: "solid", color: "#050505" },
      textColor: css("--amber"),
      fontFamily: css("--mono"),
      fontSize: 11,
      attributionLogo: true, // TradingView's required attribution remains visible
    },
    grid: { vertLines: { color: "#161616" }, horzLines: { color: "#161616" } },
    rightPriceScale: { borderColor: "#262626", mode: percent ? 2 : 0 },
    timeScale: { borderColor: "#262626" },
  });
  for (const s of seriesList) {
    const ser = chart.addSeries(LW.LineSeries, {
      color: s.color,
      lineWidth: 2,
      title: s.title,
    });
    ser.setData(s.data);
  }
  chart.timeScale().fitContent();
  return { chart, remove: () => chart.remove() };
}

// ---------- export to CSV (every table on a screen, for Excel) ----------
// A cell as Excel reads it: numbers lose their thousands commas, a dash for "no value" becomes empty.
export function csvCell(v) {
  let s = String(v ?? "").replace(/\s+/g, " ").trim();
  if (s === "—" || s === "-") s = "";
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?%?$/.test(s)) s = s.replace(/,/g, "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// blocks: [{ title, rows: [[cell, ...], ...] }] -> one CSV text, tables separated by a blank line and their titles.
export function buildCsv(blocks, { heading, footer } = {}) {
  const parts = [];
  if (heading) parts.push(csvCell(heading));
  for (const b of blocks) {
    if (!b.rows?.length) continue;
    const lines = b.rows.map((r) => r.map(csvCell).join(","));
    parts.push([b.title ? csvCell(b.title) : null, ...lines].filter((x) => x != null).join("\r\n"));
  }
  if (footer) parts.push(csvCell(footer));
  return `${parts.join("\r\n\r\n")}\r\n`;
}

// DES-AAPL_US_EQUITY-2026-10-15.csv, or WEI-2026-10-15.csv for a market-wide screen.
export function csvName(fn, security, d = new Date()) {
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const sec = String(security || "").trim().replace(/[^A-Za-z0-9.]+/g, "_").replace(/^_|_$/g, "");
  return `${[fn, sec, day].filter(Boolean).join("-")}.csv`;
}

// The tables (and key-value grids) inside a screen, in reading order, with the section title above each.
// Buttons and other controls marked data-noexp are left out, and so is a column with nothing in it (sparklines).
export function tableBlocks(root) {
  const text = (el) => {
    const c = el.cloneNode(true);
    c.querySelectorAll("[data-noexp], button").forEach((x) => x.remove());
    return c.textContent.replace(/\s+/g, " ").trim();
  };
  const blocks = [];
  let title = null;
  for (const el of root.querySelectorAll("h3.sect, table, .kv")) {
    if (el.matches("h3.sect")) {
      title = text(el);
      continue;
    }
    if (el.parentElement?.closest("table")) continue;
    let rows;
    if (el.matches(".kv")) {
      const cells = [...el.children].map(text);
      rows = [];
      for (let i = 0; i + 1 < cells.length; i += 2) rows.push([cells[i], cells[i + 1]]);
    } else {
      const head = el.tHead ? [[...el.tHead.rows].at(-1)] : [];
      const body = [...el.rows].filter((r) => !el.tHead || r.parentElement !== el.tHead);
      const hrow = head.length ? [...head[0].cells].map(text) : null;
      const brows = body.map((r) => [...r.cells].map(text));
      const width = Math.max(hrow?.length || 0, ...brows.map((r) => r.length));
      const keep = Array.from({ length: width }, (_, j) => brows.some((r) => r[j]) || (!brows.length && hrow?.[j]));
      rows = [...(hrow ? [hrow] : []), ...brows].map((r) => r.filter((_, j) => keep[j]));
    }
    if (rows.length) blocks.push({ title, rows });
    title = null;
  }
  return blocks;
}

export function downloadText(name, text, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob(["﻿", text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- source links ----------
// Footers name their sources in words; these turn into links to the public page the numbers came from.
export const SOURCE_LINKS = {
  "US Treasury": "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
  Treasury: "https://home.treasury.gov/resource-center/data-chart-center/interest-rates",
  TreasuryDirect: "https://www.treasurydirect.gov/auctions/upcoming/",
  "New York Fed": "https://www.newyorkfed.org/markets/reference-rates",
  "NY Fed": "https://www.newyorkfed.org/markets/reference-rates",
  "SEC EDGAR": "https://www.sec.gov/edgar/search/",
  EDGAR: "https://www.sec.gov/edgar/search/",
  SEC: "https://www.sec.gov/edgar/search/",
  CBOE: "https://www.cboe.com/delayed_quotes/",
  Cboe: "https://www.cboe.com/delayed_quotes/",
  FRED: "https://fred.stlouisfed.org/",
  "St. Louis Fed": "https://fred.stlouisfed.org/",
  BIS: "https://data.bis.org/",
  CFTC: "https://publicreporting.cftc.gov/",
  "Yahoo Finance": "https://finance.yahoo.com/",
  Yahoo: "https://finance.yahoo.com/",
  Nasdaq: "https://www.nasdaq.com/",
  Binance: "https://www.binance.com/",
  Coinbase: "https://www.coinbase.com/",
  Kraken: "https://www.kraken.com/",
  "Forex Factory": "https://www.forexfactory.com/calendar",
  CNBC: "https://www.cnbc.com/",
  MarketWatch: "https://www.marketwatch.com/",
  "Google News": "https://news.google.com/",
  CME: "https://www.cmegroup.com/",
  "Federal Reserve": "https://www.federalreserve.gov/",
  ECB: "https://data.ecb.europa.eu/",
  "Bank of England": "https://www.bankofengland.co.uk/boeapps/database/",
  BLS: "https://www.bls.gov/",
  BEA: "https://www.bea.gov/",
};
const SOURCE_RE = new RegExp(
  `(?<![A-Za-z])(${Object.keys(SOURCE_LINKS)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![A-Za-z])`,
  "g",
);
export function linkSources(text) {
  return String(text ?? "")
    .split(SOURCE_RE)
    .map((part, i) =>
      i % 2 ? `<a href="${SOURCE_LINKS[part]}" target="_blank" rel="noopener noreferrer">${esc(part)}</a>` : esc(part),
    )
    .join("");
}
