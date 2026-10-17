// Market-wide monitors: world indices, commodities, currencies, crypto and the day's most active stocks.
import { api, esc, px, pct, chg, cls, big, num } from "../api.js";
import { table, sect } from "../ui.js";
import { INDICES, GENERICS } from "../commands.js";

const REGIONS = {
  Americas: [
    "INDU",
    "SPX",
    "CCMP",
    "NDX",
    "RTY",
    "VIX",
    "SPTSX",
    "MEXBOL",
    "IBOV",
  ],
  "Europe, Middle East and Africa": [
    "SX5E",
    "UKX",
    "DAX",
    "CAC",
    "IBEX",
    "FTSEMIB",
    "AEX",
    "SMI",
  ],
  "Asia Pacific": [
    "NKY",
    "HSI",
    "SHCOMP",
    "KOSPI",
    "AS51",
    "SENSEX",
    "NIFTY",
    "TWSE",
    "STI",
  ],
};

const spark = (vals) => {
  if (!vals?.length) return "";
  const lo = Math.min(...vals),
    hi = Math.max(...vals),
    w = 70,
    h = 14;
  const pts = vals
    .map(
      (v, i) =>
        `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - ((v - lo) / (hi - lo || 1)) * h).toFixed(1)}`,
    )
    .join(" ");
  const up = vals.at(-1) >= vals[0];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${up ? "#2fd36b" : "#ff4a4a"}" stroke-width="1.2" points="${pts}"/></svg>`;
};

const boardCols = (nameCol) => [
  { key: "code", label: "Ticker", left: true, lbl: true },
  { key: nameCol, label: "Name", left: true },
  { key: "price", label: "Value", fmt: px },
  { key: "change", label: "Net chg", fmt: (v) => chg(v), cls },
  { key: "changePct", label: "% chg", fmt: (v) => pct(v), cls },
  { key: "ytdPct", label: "YTD %", fmt: (v) => pct(v), cls },
  { key: "low52", label: "52w low", fmt: px },
  { key: "high52", label: "52w high", fmt: px },
  { key: "spark", label: "30 days", html: true, fmt: spark },
];

async function renderBoard(ctx, groups, { yellow, nameFrom, every = 60e3 }) {
  const all = Object.values(groups).flat();
  const load = async () => {
    const { rows, source } = await api.fn("board", {
      symbols: all.map((c) => nameFrom(c)[0]).join(","),
    });
    if (!ctx.live()) return;
    ctx.el.innerHTML = "";
    for (const [g, codes] of Object.entries(groups)) {
      ctx.el.append(sect(g));
      const list = codes.map((c) => ({
        code: c,
        name: nameFrom(c)[1],
        ...(rows[nameFrom(c)[0]] || {}),
      }));
      ctx.el.append(
        table(list, boardCols("name"), {
          onRow: (r) => ctx.go(`${r.code} ${yellow} GP`),
        }),
      );
    }
    ctx.setSource(source);
  };
  await load();
  ctx.every(every, load);
}

export default [
  {
    id: "WEI",
    name: "World equity indices",
    group: "Markets",
    source: "Yahoo Finance, public prices (some exchanges delayed 15 minutes)",
    render: (ctx) =>
      renderBoard(ctx, REGIONS, {
        yellow: "INDEX",
        nameFrom: (c) => INDICES[c],
      }),
  },
  {
    id: "GLCO",
    name: "Commodities",
    group: "Markets",
    source: "Yahoo Finance front-month futures (delayed)",
    render: (ctx) =>
      renderBoard(
        ctx,
        {
          Energy: ["CL1", "CO1", "NG1", "HO1", "XB1"],
          Metals: ["GC1", "SI1", "HG1", "PL1", "PA1"],
          Agriculture: [
            "C1",
            "W1",
            "S1",
            "KC1",
            "SB1",
            "CC1",
            "CT1",
            "LC1",
            "LH1",
          ],
        },
        { yellow: "CMDTY", nameFrom: (c) => GENERICS[c] },
      ),
  },
  {
    id: "FXC",
    name: "Currency cross rates",
    group: "Markets",
    source: "Yahoo Finance FX (indicative mid rates)",
    async render(ctx) {
      const ccy = ["USD", "EUR", "JPY", "GBP", "CHF", "CAD", "AUD", "CNY"];
      const vsUsd = ccy.filter((c) => c !== "USD").map((c) => `${c}USD=X`);
      const load = async () => {
        const { rows, source } = await api.fn("board", {
          symbols: vsUsd.join(","),
        });
        if (!ctx.live()) return;
        const usd = { USD: 1 };
        for (const c of ccy) if (c !== "USD") usd[c] = rows[`${c}USD=X`]?.price;
        const pctMove = Object.fromEntries(
          ccy.map((c) => [c, c === "USD" ? 0 : rows[`${c}USD=X`]?.changePct]),
        );
        const grid = ccy.map((r) => ({
          r,
          ...Object.fromEntries(
            ccy.map((c) => [c, r === c ? null : usd[r] / usd[c]]),
          ),
        }));
        ctx.el.innerHTML = "";
        ctx.el.append(
          sect("1 unit of the row currency in the column currency"),
        );
        ctx.el.append(
          table(
            grid,
            [
              { key: "r", label: "", left: true, lbl: true },
              ...ccy.map((c) => ({
                key: c,
                label: c,
                fmt: (v) => (v == null ? "—" : num(v, v >= 100 ? 2 : 4)),
              })),
            ],
            {
              onRow: (row) =>
                row.r !== "USD" && ctx.go(`${row.r}USD CURNCY GP`),
            },
          ),
        );
        ctx.el.append(sect("Move against the dollar today"));
        ctx.el.append(
          table(
            ccy
              .filter((c) => c !== "USD")
              .map((c) => ({ c, v: usd[c], p: pctMove[c] })),
            [
              { key: "c", label: "Currency", left: true, lbl: true },
              { key: "v", label: "In USD", fmt: (v) => num(v, 4) },
              { key: "p", label: "% chg", fmt: (v) => pct(v), cls },
            ],
          ),
        );
        ctx.setSource(source);
      };
      await load();
      ctx.every(60e3, load);
    },
  },
  {
    id: "CRYPTO",
    name: "Crypto monitor",
    group: "Markets",
    source: "Binance 24-hour tickers, live",
    async render(ctx) {
      const load = async () => {
        const rows = await api.get("/api/screener?universe=crypto");
        if (!ctx.live()) return;
        const list = rows
          // Dollar stablecoins trade the most but barely move, so they'd fill the top of the list.
          .filter((r) => /USDT$/.test(r.symbol || r.id || "") && !/^(BINANCE:)?(USDC|FDUSD|TUSD|USDP|DAI|USD1|EUR|BUSD|USDE|RLUSD|PYUSD)USDT$/.test(r.symbol || r.id || ""))
          .sort((a, b) => (b.volume || 0) - (a.volume || 0))
          .slice(0, 40);
        ctx.el.innerHTML = "";
        ctx.el.append(
          table(
            list,
            [
              {
                key: (r) =>
                  (r.symbol || r.id || "")
                    .replace(/^BINANCE:/, "")
                    .replace(/USDT$/, ""),
                label: "Coin",
                left: true,
                lbl: true,
              },
              { key: "price", label: "Price", fmt: px },
              { key: "changePct", label: "24h %", fmt: (v) => pct(v), cls },
              { key: "volume", label: "24h volume $", fmt: big },
              { key: "high", label: "24h high", fmt: px },
              { key: "low", label: "24h low", fmt: px },
            ],
            {
              onRow: (r) =>
                ctx.go(
                  `${(r.symbol || r.id).replace(/^BINANCE:/, "").replace(/USDT$/, "")} CRYPTO GP`,
                ),
            },
          ),
        );
        ctx.setSource("Binance 24-hour tickers (live)");
      };
      await load();
      ctx.every(20e3, load);
    },
  },
  {
    id: "MOST",
    name: "Most active US stocks",
    group: "Equities",
    source: "Nasdaq market movers (real time in the session), Nasdaq screener as the fallback",
    async render(ctx) {
      const by = ["VOLUME", "GAINERS", "LOSERS"].includes(ctx.args[0]) ? ctx.args[0] : "VOLUME";
      const load = async () => {
        const d = await api.fn("most");
        if (!ctx.live()) return;
        const top = ctx.el.scrollTop;
        ctx.el.innerHTML = `<div class="tabs">${["VOLUME", "GAINERS", "LOSERS"].map((t) => `<button class="tab${t === by ? " on" : ""}" data-t="${t}">${t}</button>`).join("")}</div>`;
        ctx.el.querySelector(".tabs").onclick = (e) =>
          e.target.dataset.t && ctx.go(`MOST ${e.target.dataset.t}`);
        for (const s of d.tabs?.[by] || []) {
          if (!s.rows.length) continue;
          const has = (k) => s.rows.some((r) => r[k] != null);
          ctx.el.append(sect(s.title));
          ctx.el.append(
            table(
              s.rows,
              [
                { key: "ticker", label: "Ticker", left: true, lbl: true },
                { key: "name", label: "Name", left: true, fmt: (v) => String(v || "").slice(0, 28) },
                { key: "price", label: "Last", fmt: px },
                has("change") && { key: "change", label: "Net chg", fmt: (v) => chg(v), cls },
                { key: "changePct", label: "% chg", fmt: (v) => pct(v), cls },
                has("volume") && { key: "volume", label: "Volume", fmt: big },
                has("marketCap") && { key: "marketCap", label: "Mkt cap", fmt: big },
                has("sector") && { key: "sector", label: "Sector", left: true, fmt: (v) => String(v || "").slice(0, 18) },
              ].filter(Boolean),
              { onRow: (r) => ctx.go(`${r.ticker} US EQUITY DES`) },
            ),
          );
        }
        ctx.el.scrollTop = top;
        ctx.setSource(d.source);
      };
      await load();
      ctx.every(60e3, () => load().catch(() => {}));
    },
  },
];
