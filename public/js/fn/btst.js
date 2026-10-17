// BTST: backtest a strategy on the panel's security, then run the checks quant desks use to tell an edge from luck.
import { api, esc, pct, num, cls } from "../api.js";
import { table, sect, tabs, html, lineChart } from "../ui.js";
import { backtest, EXAMPLE_STRATEGIES } from "../../lib/backtest.js";
import { quantChecks } from "../../lib/quant.js";

const NAMES = Object.keys(EXAMPLE_STRATEGIES);
const SHORT = Object.fromEntries(NAMES.map((n, i) => [String(i + 1), n]));
const TFS = { D: ["1D", 2000], H: ["1h", 3000], W: ["1W", 600] };

export default [
  {
    id: "BTST",
    name: "Backtest with quant checks",
    group: "Strategy",
    needs: true,
    source:
      "Daily bars from the same sources as GP; the test runs on your computer",
    async render(ctx) {
      const pick = SHORT[ctx.args.find((a) => SHORT[a])] || NAMES[0];
      const tfKey = ctx.args.find((a) => TFS[a]) || "D";
      const [tf, n] = TFS[tfKey];
      const res = await api.candles(ctx.sec.id, tf, n);
      if (!ctx.live()) return;
      const bars = res.candles;
      if (bars.length < 300)
        throw new Error(
          `Only ${bars.length} bars of history here. The checks need at least 300, so try the daily chart (BTST D) or a symbol with a longer history.`,
        );
      const strat = {
        ...EXAMPLE_STRATEGIES[pick],
        feePct: 0.1,
        slippagePct: 0.05,
      };
      const r = backtest(bars, strat);
      const s = r.stats;
      ctx.el.innerHTML = "";
      const nav = html(
        `<div style="display:flex;gap:10px;flex-wrap:wrap"></div>`,
      );
      nav.append(
        tabs(
          NAMES.map((x, i) => `${i + 1} ${x}`),
          `${NAMES.indexOf(pick) + 1} ${pick}`,
          (x) => ctx.go(`BTST ${x.split(" ")[0]} ${tfKey}`),
        ),
        tabs(["D", "H", "W"], tfKey, (t) =>
          ctx.go(`BTST ${NAMES.indexOf(pick) + 1} ${t}`),
        ),
      );
      ctx.el.append(nav);
      const cols = html(`<div class="cols"><div></div><div></div></div>`);
      const [left, right] = cols.children;
      left.append(
        sect(`${pick} on ${bars.length.toLocaleString()} ${tf} bars`),
        table(
          [
            ["Net result", pct(s.netProfitPct), s.netProfitPct],
            ["Buy and hold", pct(s.buyHoldPct), s.buyHoldPct],
            [
              "Worst drop (max drawdown)",
              s.maxDrawdownPct == null ? "—" : `-${num(s.maxDrawdownPct)}%`,
              -1,
            ],
            ["Trades", String(s.totalTrades), 0],
            [
              "Share of trades that made money",
              s.winRatePct == null ? "—" : `${num(s.winRatePct)}%`,
              0,
            ],
            [
              "Profit factor",
              s.profitFactor == null ? "—" : num(s.profitFactor),
              0,
            ],
            ["Sharpe", s.sharpe == null ? "—" : num(s.sharpe), 0],
            [
              "Time in the market",
              s.exposurePct == null ? "—" : `${num(s.exposurePct)}%`,
              0,
            ],
          ].map(([k, v, x]) => ({ k, v, x })),
          [
            { key: "k", label: "", left: true, lbl: true },
            { key: "v", label: "", cls: (v, row) => (row.x ? cls(row.x) : "") },
          ],
        ),
        html(
          `<div class="hint">${esc(s.feesAndSlippage)}. Signals on the close, fills at the next open.</div>`,
        ),
      );
      const box = html(
        `<div style="position:relative;height:220px;margin-top:8px"></div>`,
      );
      left.append(box);
      const base = bars[0].close;
      const chart = lineChart(box, [
        {
          title: "Strategy",
          color: getComputedStyle(document.documentElement)
            .getPropertyValue("--amber")
            .trim(),
          data: r.equity.map((e) => ({
            time: e.time,
            value: (e.value / r.equity[0].value) * 100,
          })),
        },
        {
          title: "Buy and hold",
          color: "#777",
          data: bars.map((b) => ({
            time: b.time,
            value: (b.close / base) * 100,
          })),
        },
      ]);
      ctx.onCleanup(() => chart.remove());
      right.append(
        sect("Quant checks"),
        html(
          `<div class="loading">Running the checks (about 25 versions with nearby settings)</div>`,
        ),
      );
      ctx.el.append(cols);
      ctx.setSource(`${res.provider} bars; tested on this computer`);
      // The checks re-run the strategy many times, so give the screen a frame to paint first.
      await new Promise((ok) => setTimeout(ok, 30));
      if (!ctx.live()) return;
      const q = quantChecks(bars, strat, { mcRuns: 1000 });
      right.innerHTML = "";
      right.append(
        sect(`Quant checks: passed ${q.passed} of ${q.gates.length}`),
        table(q.gates, [
          { key: "label", label: "Check", left: true, lbl: true },
          {
            key: "pass",
            label: "",
            left: true,
            fmt: (v) => (v ? "PASS" : "FAIL"),
            cls: (v) => (v ? "up" : "down"),
          },
          { key: "value", label: "What it found", left: true, wrap: true },
        ]),
        html(
          `<p class="para dim" style="margin-top:8px">A backtest shows what rules did on past prices. These checks ask whether that result would survive new data, nearby settings, double costs and a reshuffle of the same trades. Passing them doesn't make a strategy profitable; failing them is a reason not to trust it.</p>`,
        ),
      );
    },
  },
];
