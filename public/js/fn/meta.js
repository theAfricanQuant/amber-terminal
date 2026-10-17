// HELP lists every function; DATA says where each one's numbers come from and how fresh they are.
import { esc } from "../api.js";
import { table, sect, html } from "../ui.js";
import { FUNCS } from "./index.js";

const groups = () => {
  const g = {};
  for (const f of Object.values(FUNCS)) (g[f.group || "Other"] ||= []).push(f);
  return g;
};

export default [
  {
    id: "HELP",
    name: "Functions",
    group: "Help",
    source: "This app",
    render(ctx) {
      ctx.el.innerHTML = "";
      ctx.el.append(
        html(
          `<p class="para">Type a security, then a function, then press Enter (that's GO). <b class="amber">AAPL US EQUITY DES</b>, <b class="amber">VOD LN DES</b>, <b class="amber">SPX INDEX GP</b>, <b class="amber">CL1 COMDTY GP</b>, <b class="amber">EURUSD CURNCY GP</b>, <b class="amber">BTC GP</b>. A function on its own runs on the panel's last security, or market-wide (WEI, TOP, ECO). Esc goes back. Ctrl or Cmd plus 1 to 4 picks a panel. Type LAYOUT 1, 2 or 4 in the top bar to change the grid. <b class="amber">Keyboard:</b> F8 adds EQUITY, F9 CMDTY, F10 INDEX, F11 CRNCY and F2 GOVT, F1 opens this page, and typing a name like apple lists matching securities (AAPL US EQUITY) to pick with the arrow keys and Tab.</p>`,
        ),
      );
      for (const [g, list] of Object.entries(groups())) {
        ctx.el.append(sect(g));
        ctx.el.append(
          table(
            list,
            [
              { key: "id", label: "Code", left: true, lbl: true },
              { key: "name", label: "What it shows", left: true },
              {
                key: (f) => (f.needs ? "needs a security" : "market-wide"),
                label: "",
                left: true,
                cls: () => "dim",
              },
            ],
            { onRow: (f) => ctx.go(f.id) },
          ),
        );
      }
      ctx.setSource("Click a row to open it");
    },
  },
  {
    id: "DATA",
    name: "Where the data comes from",
    group: "Help",
    source: "This app",
    render(ctx) {
      ctx.el.innerHTML = "";
      ctx.el.append(
        html(
          `<p class="para">Every number here comes from a public source that needs no account and no API key. Crypto prices stream live from the exchanges. Stock, index and futures prices are public quotes that can run up to 15 minutes behind on some exchanges. It is not a paid exchange feed, so use your broker's prices to place orders.</p><p class="para dim">Charts are drawn with <a href="https://www.tradingview.com/" target="_blank" rel="noopener">TradingView Lightweight Charts™</a>, Copyright TradingView, Inc., used under the Apache License 2.0.</p>`,
        ),
      );
      ctx.el.append(
        table(
          Object.values(FUNCS).filter((f) => f.group !== "Help"),
          [
            { key: "id", label: "Code", left: true, lbl: true },
            { key: "name", label: "Function", left: true },
            {
              key: "source",
              label: "Source and freshness",
              left: true,
              wrap: true,
            },
          ],
          { onRow: (f) => ctx.go(f.id) },
        ),
      );
      ctx.setSource("No keys, no accounts, no paid feeds");
    },
  },
];
