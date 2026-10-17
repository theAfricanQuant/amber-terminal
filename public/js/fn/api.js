// API: BDP and BDH as local URLs for Excel and Python, with live examples for the panel's security.
// ASK: Bloomberg's AI is ASKB; here your own Claude is the assistant, connected with one line (scripts/mcp.js).
import { api, esc, px, pct } from "../api.js";
import { table, sect, html } from "../ui.js";

const STYLE = `
.apiscr .cmd{display:flex;gap:6px;align-items:flex-start;margin:3px 0 8px}
.apiscr .cmd code{flex:1;min-width:0;background:#0d0d0d;border:1px solid var(--line);color:var(--white);padding:4px 6px;white-space:pre-wrap;word-break:break-all;font:inherit}
.apiscr .cmd button{background:#151515;color:var(--amber);border:1px solid #2c2c2c;padding:3px 8px;flex:none}
.apiscr .cmd button:hover{background:var(--amber);color:#000}
.apiscr ol{margin:2px 0 8px;padding-left:20px;color:var(--white)}
.apiscr .para{white-space:normal}
`;

function setup(ctx) {
  if (!document.getElementById("apiscr-style")) {
    const s = document.createElement("style");
    s.id = "apiscr-style";
    s.textContent = STYLE;
    document.head.append(s);
  }
  ctx.el.innerHTML = "";
  const root = document.createElement("div");
  root.className = "apiscr";
  ctx.el.append(root);
  return root;
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
}

// A command or URL with a Copy button.
function cmd(ctx, text, { link = false } = {}) {
  const el = html(
    `<div class="cmd"><code>${link ? `<a href="${esc(text)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text)}</code><button type="button">Copy</button></div>`,
  );
  el.querySelector("button").onclick = async () => {
    await copy(text);
    ctx.toast("Copied");
  };
  return el;
}

// The panel's security in the terminal's full form, for the examples.
function labelOf(sec) {
  if (!sec) return "AAPL US EQUITY";
  if (/\b(EQUITY|INDEX|COMDTY|CMDTY|CURNCY|CRNCY)\b/.test(sec.raw))
    return sec.raw;
  if (sec.sector === "EQUITY")
    return /[:=^]/.test(sec.ticker)
      ? sec.raw
      : `${sec.ticker} ${sec.exch || "US"} EQUITY`;
  if (sec.sector === "INDEX") return `${sec.ticker} INDEX`;
  if (sec.sector === "CMDTY") return `${sec.ticker} COMDTY`;
  if (sec.sector === "CRNCY") return `${sec.ticker} CURNCY`;
  return sec.raw;
}

// A path inside this install, with the separator its own OS uses.
const inDir = (dir, ...parts) => [dir, ...parts].join(dir.includes("\\") ? "\\" : "/");
const about = () => api.get("/api/about").catch(() => null);
const enc = (s) => encodeURIComponent(s).replace(/%2C/gi, ",");

export default [
  {
    id: "API",
    name: "Excel, Python and Claude: the local API",
    group: "Help",
    source: "This app's own API (BDP and BDH), on this computer",
    async render(ctx) {
      const sec = ctx.panel?.sec || null;
      const label = labelOf(sec);
      const [a] = await Promise.all([about()]);
      if (!ctx.live()) return;
      const base = location.origin;
      const isEquity = !sec || sec.sector === "EQUITY";
      const others = isEquity
        ? `${label},SPX INDEX`
        : `${label},AAPL US EQUITY`;
      const bdpFields =
        "NAME,PX_LAST,CHG_PCT_1D,CHG_PCT_YTD,CUR_MKT_CAP,PE_RATIO,EQY_DVD_YLD_IND";
      const bdp = `${base}/api/bdp?securities=${enc(others)}&fields=${bdpFields}&format=csv`;
      const bdh = `${base}/api/bdh?security=${enc(label)}&fields=PX_OPEN,PX_HIGH,PX_LOW,PX_LAST,PX_VOLUME&start=-1Y&per=W&format=csv`;
      const el = setup(ctx);
      el.append(
        html(
          `<p class="para">Bloomberg sells its data to Excel as <b class="amber">BDP</b> (a snapshot: one value per security and field) and <b class="amber">BDH</b> (history: one row per day, week or month). Amber has both as plain web addresses on this computer, so Excel, Python and your own scripts can pull the same numbers the screens show. No key, no login. They answer to this computer only.</p>`,
        ),
      );

      el.append(
        sect(
          `BDP: a snapshot of ${label}${isEquity ? " and the S&P 500" : " and Apple"}`,
        ),
      );
      el.append(cmd(ctx, bdp, { link: true }));
      const live = document.createElement("div");
      live.innerHTML = `<div class="loading">Loading the live result</div>`;
      el.append(live);

      el.append(sect(`BDH: a year of weekly prices for ${label}`));
      el.append(cmd(ctx, bdh, { link: true }));
      const hist = document.createElement("div");
      hist.innerHTML = `<div class="loading">Loading the last five weeks</div>`;
      el.append(hist);
      el.append(
        html(
          `<p class="para dim">Change <b>per</b> to D, W, M, Q or Y. <b>start</b> and <b>end</b> take 2025-01-31, 20250131, or -1Y, -6M, -30D. Leave out <b>format=csv</b> for JSON. A field it can't fill from the free sources comes back empty, with a note in the JSON.</p>`,
        ),
      );

      el.append(sect("Excel (Power Query)"));
      el.append(
        html(
          `<ol><li>Copy the BDH address above.</li><li>In Excel: <b>Data</b> &gt; <b>From Web</b> (Windows), or <b>Data</b> &gt; <b>Get Data</b> &gt; <b>From Web</b> (Mac).</li><li>Paste the address and press OK, then <b>Load</b>. The table lands in a new sheet.</li><li><b>Data</b> &gt; <b>Refresh All</b> pulls fresh prices while Amber is running.</li></ol>`,
        ),
      );

      el.append(sect("Python (pandas)"));
      el.append(
        cmd(
          ctx,
          `import pandas as pd\ndf = pd.read_csv("${bdh}", parse_dates=["date"], index_col="date")\nprint(df.tail())`,
        ),
      );
      if (a?.dir)
        el.append(
          html(
            `<p class="para">A ready-made notebook (Bloomberg's version is BQuant): history for a few securities, a snapshot, a chart, and the Fed path and yield curve. Open it in Jupyter or VS Code:</p>`,
          ),
          cmd(
            ctx,
            inDir(a.dir, "examples", "quickstart.ipynb"),
          ),
        );

      el.append(sect("Every screen's data, as JSON"));
      el.append(
        html(
          `<p class="para">Each function's raw data is at <b>/api/fn/&lt;code&gt;</b>, for example the Fed path and the Treasury curve:</p>`,
        ),
        cmd(ctx, `${base}/api/fn/wirp`, { link: true }),
        cmd(ctx, `${base}/api/fn/gc`, { link: true }),
      );

      el.append(sect("Ask Claude instead"));
      el.append(
        html(
          `<p class="para">Connect your own Claude with this line (type ASK for more):</p>`,
        ),
      );
      el.append(cmd(ctx, a?.mcp || "node scripts/mcp.js --help"));

      if (a?.fields) {
        el.append(sect("Fields"));
        el.append(
          html(
            `<p class="para"><b class="amber">BDP</b> ${esc(a.fields.bdp.join(", "))}</p><p class="para"><b class="amber">BDH</b> ${esc(a.fields.bdh.join(", "))}</p>`,
          ),
        );
      }
      ctx.setSource(`Live from ${base}`);

      const [snap, h] = await Promise.all([
        api
          .get(bdp.replace("&format=csv", ""))
          .catch((e) => ({ error: e.message })),
        api
          .get(bdh.replace("&format=csv", ""))
          .catch((e) => ({ error: e.message })),
      ]);
      if (!ctx.live()) return;
      live.innerHTML = "";
      if (snap.error)
        live.append(html(`<div class="err">${esc(snap.error)}</div>`));
      else
        live.append(
          table(snap.rows, [
            { key: "security", label: "Security", left: true, lbl: true },
            { key: "NAME", label: "NAME", left: true },
            { key: "PX_LAST", label: "PX_LAST", fmt: px },
            { key: "CHG_PCT_1D", label: "CHG_PCT_1D", fmt: (v) => pct(v) },
            { key: "CHG_PCT_YTD", label: "CHG_PCT_YTD", fmt: (v) => pct(v) },
            {
              key: "CUR_MKT_CAP",
              label: "CUR_MKT_CAP",
              fmt: (v) => (v == null ? "—" : `${(v / 1e9).toFixed(1)}B`),
            },
            {
              key: "PE_RATIO",
              label: "PE_RATIO",
              fmt: (v) => (v == null ? "—" : v.toFixed(1)),
            },
          ]),
        );
      hist.innerHTML = "";
      if (h.error) hist.append(html(`<div class="err">${esc(h.error)}</div>`));
      else
        hist.append(
          table(h.rows.slice(-5), [
            { key: "date", label: "date", left: true, lbl: true },
            ...["PX_OPEN", "PX_HIGH", "PX_LOW", "PX_LAST"].map((k) => ({
              key: k,
              label: k,
              fmt: px,
            })),
            {
              key: "PX_VOLUME",
              label: "PX_VOLUME",
              fmt: (v) => (v == null ? "—" : Math.round(v).toLocaleString()),
            },
          ]),
        );
    },
  },
  {
    id: "ASK",
    name: "Ask Claude about the markets",
    group: "Help",
    source: "Your own Claude, through scripts/mcp.js on this computer",
    async render(ctx) {
      const a = await about();
      if (!ctx.live()) return;
      const el = setup(ctx);
      el.append(
        html(
          `<p class="para">Bloomberg's AI assistant is called <b class="amber">ASKB</b>. It answers questions from Terminal data. Here, your own Claude is the assistant: connect it to Amber once, then ask in plain English. Claude runs the same functions as these screens (WIRP, GC, OMON, DES, FA, INSD and the rest), reads the numbers and tells you where each one came from.</p>`,
        ),
      );
      el.append(sect("1. Connect it (once)"));
      el.append(
        html(
          `<p class="para">Paste this into a terminal on this computer. It needs Claude Code installed.</p>`,
        ),
      );
      el.append(cmd(ctx, a?.mcp || "node scripts/mcp.js --help"));
      el.append(
        html(
          `<p class="para dim">Amber doesn't need to be open for this: Claude starts its own copy of the functions. Other apps that speak MCP (Claude Desktop, Cursor) run: node ${esc(a?.dir ? inDir(a.dir, "scripts", "mcp.js") : "scripts/mcp.js")}</p>`,
        ),
      );
      el.append(sect("2. Ask"));
      el.append(
        html(`<p class="para">Open Claude Code and try one of these:</p>`),
      );
      for (const q of [
        "What does the futures market price for the next Fed meeting, and what is the 2s10s spread?",
        "Compare the 10-year and 2-year yields over the last month.",
        "Which S&P stocks have insiders buying this week?",
        "What's the implied move for NVDA's next earnings, from the options?",
        "Backtest a 50/200-day moving average cross on SPY and tell me if it passes the quant checks.",
        "How is my watchlist doing today?",
      ])
        el.append(cmd(ctx, q));
      el.append(sect("What Claude can use"));
      el.append(
        table(
          [
            [
              "terminal_function",
              "Any function code, with its data and source",
            ],
            ["quote", "Prices and the day's change for any securities"],
            ["history", "Price bars for any security and timeframe"],
            ["search_security", "Find a ticker from a company name"],
            ["backtest", "Test a rule you describe, then run the quant checks"],
            ["workspace", "Your watchlist and portfolio, valued live"],
            ["alerts", "List your alerts, or set one while Amber is open"],
          ].map(([tool, what]) => ({ tool, what })),
          [
            { key: "tool", label: "Tool", left: true, lbl: true },
            { key: "what", label: "What it does", left: true },
          ],
        ),
      );
      el.append(
        html(
          `<p class="para dim">The data comes from the same public sources as the screens, and goes only to your own Claude. Prices can be up to 15 minutes behind on some exchanges.</p>`,
        ),
      );
      ctx.setSource("Your Claude, through scripts/mcp.js");
    },
  },
];
