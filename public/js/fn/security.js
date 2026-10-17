// Screens about one security: description, financials, news, price chart (with studies), intraday chart,
// price history.
import { api, esc, px, pct, chg, cls, big, num, date, ago } from "../api.js";
import { table, kv, sect, tabs, priceChart, html } from "../ui.js";
import { compute } from "../../lib/indicators.js";

const RANGES = {
  "1D": ["5m", 120],
  "5D": ["15m", 160],
  "1M": ["1h", 200],
  "6M": ["1D", 130],
  "1Y": ["1D", 260],
  "5Y": ["1W", 270],
  MAX: ["1M", 600],
};

// GP studies, drawn with the reference-tested formulas in public/lib/indicators.js. Overlays and volume sit
// on the price pane; RSI and MACD get panes of their own underneath. Your choice is saved as amberStudies.
const STUDIES = [
  { id: "SMA50", label: "SMA 50", color: "#5aaeff" },
  { id: "SMA200", label: "SMA 200", color: "#ff5ec8" },
  { id: "EMA20", label: "EMA 20", color: "#f2d21b" },
  { id: "BB", label: "Bollinger 20,2", color: "#b48cff" },
  { id: "VOL", label: "Volume", color: "#8c8c8c" },
  { id: "RSI", label: "RSI 14", color: "#ffbf66" },
  { id: "MACD", label: "MACD 12,26,9", color: "#3ee0c5" },
];
const DEFAULT_STUDIES = ["SMA50", "SMA200", "VOL"];
// Extra bars loaded before the visible range, so a 200-bar average is already running at the left edge.
const WARMUP = 250;
let studiesSaved;
const loadStudies = () =>
  (studiesSaved ||= api
    .get("/api/state")
    .then((s) =>
      Array.isArray(s?.amberStudies)
        ? s.amberStudies.filter((id) => STUDIES.some((x) => x.id === id))
        : DEFAULT_STUDIES.slice(),
    )
    .catch(() => DEFAULT_STUDIES.slice()));
const saveStudies = (on) => {
  studiesSaved = Promise.resolve(on.slice());
  api.put("/api/state", { amberStudies: on }).catch(() => {});
};

// Studies are worked out on every bar loaded (warm-up included) and drawn from bar `from` on, the visible range.
function drawStudies(chart, bars, on, from = 0) {
  const LW = window.LightweightCharts;
  const color = (id) => STUDIES.find((s) => s.id === id).color;
  const pts = (arr) =>
    bars
      .map((b, i) => ({ time: b.time, value: arr[i] }))
      .filter((p, i) => i >= from && Number.isFinite(p.value));
  const quiet = { lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
  const line = (values, c, pane = 0, extra = {}) =>
    chart.addSeries(LW.LineSeries, { ...quiet, color: c, ...extra }, pane).setData(pts(values));
  if (on.includes("SMA50")) line(compute("sma", bars, { length: 50 }).value, color("SMA50"));
  if (on.includes("SMA200")) line(compute("sma", bars, { length: 200 }).value, color("SMA200"));
  if (on.includes("EMA20")) line(compute("ema", bars, { length: 20 }).value, color("EMA20"));
  if (on.includes("BB")) {
    const bb = compute("bb", bars, { length: 20, mult: 2 });
    line(bb.upper, color("BB"));
    line(bb.basis, color("BB"), 0, { lineStyle: 2 });
    line(bb.lower, color("BB"));
  }
  const shown = bars.slice(from);
  if (on.includes("VOL") && shown.some((b) => b.volume > 0)) {
    const v = chart.addSeries(
      LW.HistogramSeries,
      { priceScaleId: "vol", priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false },
      0,
    );
    v.setData(
      shown.map((b) => ({
        time: b.time,
        value: b.volume || 0,
        color: b.close >= b.open ? "rgba(47,211,107,0.35)" : "rgba(255,74,74,0.35)",
      })),
    );
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } });
  }
  let pane = 0;
  if (on.includes("RSI")) {
    pane += 1;
    const s = chart.addSeries(
      LW.LineSeries,
      { color: color("RSI"), lineWidth: 1, priceLineVisible: false, title: "RSI 14" },
      pane,
    );
    s.setData(pts(compute("rsi", bars, { length: 14, maLength: 0 }).value));
    for (const level of [70, 30])
      s.createPriceLine({ price: level, color: "#555", lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
  }
  if (on.includes("MACD")) {
    pane += 1;
    const m = compute("macd", bars, { fast: 12, slow: 26, signal: 9 });
    const h = chart.addSeries(LW.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, pane);
    h.setData(
      bars
        .map((b, i) => ({
          time: b.time,
          value: m.hist[i],
          color: m.hist[i] >= 0 ? "rgba(47,211,107,0.55)" : "rgba(255,74,74,0.55)",
        }))
        .filter((p, i) => i >= from && Number.isFinite(p.value)),
    );
    line(m.macd, color("MACD"), pane, { lastValueVisible: true, title: "MACD" });
    line(m.signal, "#ffa028", pane, { lastValueVisible: true, title: "Signal" });
  }
  if (pane) chart.panes().forEach((p, i) => p.setStretchFactor(i === 0 ? 3 : 1));
}

async function chartScreen(ctx, range, type = "candles") {
  const sec = ctx.sec;
  ctx.el.innerHTML = "";
  const top = html(`<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"></div>`);
  const rangeTabs = tabs(Object.keys(RANGES), range, (r) => draw(r));
  const kind = tabs(["CANDLES", "LINE"], type === "candles" ? "CANDLES" : "LINE", (k) => {
    type = k === "LINE" ? "line" : "candles";
    [...kind.children].forEach((b) => b.classList.toggle("on", b.textContent === k));
    paint();
  });
  const on = (await loadStudies()).slice();
  if (!ctx.live()) return;
  const studyTabs = document.createElement("div");
  studyTabs.className = "tabs";
  for (const s of STUDIES) {
    const b = document.createElement("button");
    b.className = `tab${on.includes(s.id) ? " on" : ""}`;
    b.title = `Show or hide ${s.label}`;
    b.innerHTML = `<span style="color:${s.color}">■</span> ${esc(s.label)}`;
    b.onclick = () => {
      const i = on.indexOf(s.id);
      if (i >= 0) on.splice(i, 1);
      else on.push(s.id);
      b.classList.toggle("on", on.includes(s.id));
      saveStudies(on);
      paint();
    };
    studyTabs.append(b);
  }
  const quote = html(`<span class="dim"></span>`);
  top.append(rangeTabs, kind, studyTabs, quote);
  const box = html(`<div class="chartbox"></div>`);
  ctx.el.append(top, box);
  // The tabs can wrap onto more lines in a narrow panel, so the chart starts below them.
  const fit = () => (box.style.top = `${top.offsetTop + top.offsetHeight + 4}px`);
  const ro = new ResizeObserver(fit);
  ro.observe(top);
  let current, res, shown;
  ctx.onCleanup(() => {
    ro.disconnect();
    current?.remove();
  });
  function paint() {
    if (!res) return;
    current?.remove();
    box.innerHTML = "";
    current = priceChart(box, { type });
    const bars = res.candles;
    const from = Math.max(0, bars.length - shown);
    const vis = bars.slice(from);
    current.series.setData(type === "candles" ? vis : vis.map((b) => ({ time: b.time, value: b.close })));
    drawStudies(current.chart, bars, on, from);
    // Maximising the panel keeps the same dates in view instead of opening empty space on the left.
    current.chart.applyOptions({ timeScale: { lockVisibleTimeRangeOnResize: true } });
    current.chart.timeScale().fitContent();
    fit();
  }
  async function draw(r) {
    range = r;
    [...rangeTabs.children].forEach((b) => b.classList.toggle("on", b.textContent === r));
    const [tf, n] = RANGES[r];
    const got = await api.candles(sec.id, tf, n + WARMUP);
    if (!ctx.live()) return;
    res = got;
    shown = n;
    paint();
    const bars = res.candles;
    const last = bars.at(-1),
      first = bars[Math.max(0, bars.length - n)];
    const move = last && first ? ((last.close - first.open) / first.open) * 100 : null;
    quote.innerHTML = `${esc(res.symbol)}  last <b class="amber">${px(last?.close)}</b>  <span class="${cls(move)}">${pct(move)}</span> over ${r}`;
    ctx.setSource(`${res.provider}${res.notes?.length ? `. ${res.notes.join(" ")}` : ""}`);
  }
  await draw(range);
}

export default [
  {
    id: "DES",
    name: "Description",
    group: "Equities",
    needs: true,
    source: "Nasdaq company profile (US stocks), Yahoo Finance prices",
    async render(ctx) {
      const d = await api.fn("des", { symbol: ctx.sec.id });
      if (!ctx.live()) return;
      if (d.name) ctx.setTitle(`${d.name}  ·  ${ctx.sec.raw}`);
      ctx.el.innerHTML = "";
      const p = d.price;
      if (p)
        ctx.el.append(
          html(
            `<div style="font-size:15px;margin-bottom:6px"><b class="amber">${px(p.price)}</b>  <span class="${cls(p.change)}">${chg(p.change)}  ${pct(p.changePct)}</span>  <span class="dim">52w ${px(p.low52)} to ${px(p.high52)} · YTD</span> <span class="${cls(p.ytdPct)}">${pct(p.ytdPct)}</span></div>`,
          ),
        );
      const cols = html(`<div class="cols"><div></div><div></div></div>`);
      const [l, r] = cols.children;
      l.append(
        sect("Company"),
        kv([
          ["Name", d.name],
          ["Sector", d.sector],
          ["Industry", d.industry],
          ["Region", d.region],
          ["Website", d.website],
        ]),
      );
      if (d.stats?.length)
        r.append(sect("Key data"), kv(d.stats.map((s) => [s.label, s.value])));
      ctx.el.append(cols);
      if (d.description)
        ctx.el.append(
          sect("Business"),
          html(`<p class="para">${esc(d.description)}</p>`),
        );
      ctx.el.append(
        html(
          `<div class="hint">Next: <a href="#" data-c="FA">FA financials</a> · <a href="#" data-c="CN">CN news</a> · <a href="#" data-c="GP">GP chart</a> · <a href="#" data-c="OMON">OMON options</a> · <a href="#" data-c="CF">CF filings</a> · <a href="#" data-c="DVD">DVD dividends</a> · <a href="#" data-c="EE">EE estimates</a> · <a href="#" data-c="ANR">ANR analysts</a></div>`,
        ),
      );
      ctx.el.querySelector(".hint:last-child").onclick = (e) => {
        e.preventDefault();
        if (e.target.dataset.c) ctx.go(e.target.dataset.c);
      };
      ctx.setSource(d.source);
    },
  },
  {
    id: "FA",
    name: "Financial analysis",
    group: "Equities",
    needs: true,
    source:
      "Nasdaq financial statements (from company filings, in thousands of US dollars)",
    async render(ctx) {
      const freq = ctx.args[0] === "Q" ? "quarterly" : "annual";
      const d = await api.get(
        `/api/financials?symbol=${encodeURIComponent(ctx.sec.id)}&frequency=${freq}`,
      );
      if (!ctx.live()) return;
      const sheets = [
        ["Income statement", d.income],
        ["Balance sheet", d.balance],
        ["Cash flow", d.cashflow],
        ["Ratios", d.ratios],
      ].filter(([, t]) => t);
      let pick = sheets[0]?.[0];
      const draw = () => {
        ctx.el.innerHTML = "";
        const bar = html(
          `<div style="display:flex;gap:10px;flex-wrap:wrap"></div>`,
        );
        bar.append(
          tabs(
            sheets.map(([n]) => n),
            pick,
            (n) => {
              pick = n;
              draw();
            },
          ),
          tabs(
            ["ANNUAL", "QUARTERLY"],
            freq === "annual" ? "ANNUAL" : "QUARTERLY",
            (f) => ctx.go(`FA${f === "QUARTERLY" ? " Q" : ""}`),
          ),
        );
        ctx.el.append(bar);
        const t = sheets.find(([n]) => n === pick)?.[1];
        if (t)
          ctx.el.append(
            table(t.rows, [
              { key: "label", label: "", left: true, lbl: true },
              ...t.periods.map((p, i) => ({
                key: (r) => r.values[i],
                label: p,
              })),
            ]),
          );
        ctx.el.append(
          html(
            `<div class="hint">${esc(d.note || "")} ${d.nextEarnings ? `· ${esc(d.nextEarnings)}` : ""}</div>`,
          ),
        );
      };
      draw();
      ctx.setSource("Nasdaq financial statements");
    },
  },
  {
    id: "CN",
    name: "Company news",
    group: "News",
    needs: true,
    source: "Nasdaq news by symbol, plus public RSS",
    async render(ctx) {
      const load = async () => {
        const d = await api.get(
          `/api/news?symbol=${encodeURIComponent(ctx.sec.id)}`,
        );
        if (!ctx.live()) return;
        const items = d.items || d || [];
        ctx.el.innerHTML = `<div class="news"><ul>${
          items
            .slice(0, 60)
            .map(
              (n) =>
                `<li><span class="when">${esc(ago(n.time))}</span><span><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a> <span class="srcn">${esc(n.source || "")}</span></span></li>`,
            )
            .join("") || `<li class="hint">No recent headlines.</li>`
        }</ul></div>`;
        ctx.setSource(d.note || "Nasdaq and public news feeds");
      };
      await load();
      ctx.every(120e3, load);
    },
  },
  {
    id: "GP",
    name: "Price graph",
    group: "Charts",
    needs: true,
    source:
      "Exchange and Yahoo price history (crypto live, stocks may be delayed)",
    render: (ctx) =>
      chartScreen(
        ctx,
        ["1D", "5D", "1M", "6M", "1Y", "5Y", "MAX"].includes(ctx.args[0])
          ? ctx.args[0]
          : "1Y",
      ),
  },
  {
    id: "GIP",
    name: "Intraday price graph",
    group: "Charts",
    needs: true,
    source: "Exchange and Yahoo intraday bars",
    render: (ctx) => chartScreen(ctx, "1D", "line"),
  },
  {
    id: "HP",
    name: "Historical prices",
    group: "Charts",
    needs: true,
    source: "Daily bars from the same sources as GP",
    async render(ctx) {
      const tf = ctx.args[0] === "W" ? "1W" : ctx.args[0] === "M" ? "1M" : "1D";
      const res = await api.candles(ctx.sec.id, tf, 260);
      if (!ctx.live()) return;
      const rows = res.candles
        .slice()
        .reverse()
        .map((b, i, a) => ({
          ...b,
          chgPct: a[i + 1]
            ? ((b.close - a[i + 1].close) / a[i + 1].close) * 100
            : null,
        }));
      ctx.el.innerHTML = "";
      ctx.el.append(
        tabs(["D", "W", "M"], ctx.args[0] || "D", (t) => ctx.go(`HP ${t}`)),
      );
      ctx.el.append(
        table(rows, [
          { key: "time", label: "Date", left: true, lbl: true, fmt: date },
          { key: "open", label: "Open", fmt: px },
          { key: "high", label: "High", fmt: px },
          { key: "low", label: "Low", fmt: px },
          { key: "close", label: "Close", fmt: px },
          { key: "chgPct", label: "% chg", fmt: (v) => pct(v), cls },
          { key: "volume", label: "Volume", fmt: big },
        ]),
      );
      ctx.setSource(res.provider);
    },
  },
];
