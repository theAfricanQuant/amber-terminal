// Screens for headlines and company paperwork: top news, SEC filings, insider transactions, institutional holders.
import { api, esc, px, pct, num, big, ago, cls } from "../api.js";
import { table, kv, sect, tabs, html } from "../ui.js";

// TOP CRYPTO and TOP COINS both open the crypto feeds.
const NEWS_GROUPS = { ALL: "ALL", TECH: "TECH", CRYPTO: "CRYPTO", ECON: "ECON" };
const ALIAS = { COINS: "CRYPTO" };
const FILING_TABS = ["ALL", "10-K", "10-Q", "8-K", "4"];
const INSIDER_TABS = ["ALL", "BUYS", "SELLS"];

const link = (url, text) =>
  `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const usd = (v) => (v == null ? "—" : `$${big(v)}`);
const clip = (n) => (v) => {
  const t = String(v || "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// Commands from a tab keep the security in front, so "10-K" isn't read as a security.
const run = (ctx, fn, arg, all = "ALL") =>
  ctx.go(`${ctx.sec.raw} ${fn}${arg === all ? "" : ` ${arg}`}`);
const withName = (ctx, d) => {
  if (d.name) ctx.setTitle(`${d.name}  ·  ${ctx.sec.raw}`);
};

export default [
  {
    id: "TOP",
    name: "Top news",
    group: "News",
    source:
      "CNBC, WSJ, MarketWatch, FT, Bloomberg and Nasdaq public headline feeds",
    async render(ctx) {
      const want = ALIAS[ctx.args[0]] || ctx.args[0] || "ALL";
      if (!NEWS_GROUPS[want])
        throw new Error(
          `There is no ${want} news group. Try TOP, TOP TECH, TOP CRYPTO or TOP ECON.`,
        );
      ctx.el.innerHTML = "";
      ctx.el.append(
        tabs(Object.keys(NEWS_GROUPS), want, (g) =>
          ctx.go(g === "ALL" ? "TOP" : `TOP ${g}`),
        ),
      );
      const box = html(`<div class="news"></div>`);
      ctx.el.append(box);
      const load = async () => {
        const d = await api.fn("top", { group: NEWS_GROUPS[want] });
        if (!ctx.live()) return;
        box.innerHTML = `<ul>${
          d.items
            .map(
              (n) =>
                `<li><span class="when">${esc(n.time ? ago(n.time) : "")}</span><span><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a> <span class="srcn">${esc(n.source || "")}</span></span></li>`,
            )
            .join("") || `<li class="hint">No headlines right now.</li>`
        }</ul>`;
        ctx.setSource(d.source);
      };
      await load();
      ctx.every(120e3, () =>
        load().catch(() => {
          if (ctx.live())
            ctx.setSource(
              "Couldn't refresh just now, showing the last headlines",
            );
        }),
      );
    },
  },
  {
    id: "CF",
    name: "Company filings",
    group: "Equities",
    needs: true,
    source: "SEC EDGAR, the official US filing system",
    async render(ctx) {
      const want = ctx.args.join(" ") || "ALL";
      const d = await api.fn("cf", { symbol: ctx.sec.id, form: want });
      if (!ctx.live()) return;
      withName(ctx, d);
      ctx.el.innerHTML = "";
      ctx.el.append(
        tabs(FILING_TABS, d.form, (t) => run(ctx, "CF", t)),
      );
      if (!d.filings.length) {
        ctx.el.append(
          html(
            `<div class="hint">No ${esc(d.form === "ALL" ? "" : `${d.form} `)}filings found in the latest SEC records for this company.</div>`,
          ),
        );
      } else {
        ctx.el.append(
          table(d.filings, [
            { key: "filed", label: "Filed", left: true, lbl: true },
            { key: "form", label: "Form", left: true },
            { key: "description", label: "What it is", left: true, wrap: true },
            {
              key: "period",
              label: "For period",
              left: true,
              cls: () => "dim",
            },
            {
              key: "url",
              label: "",
              left: true,
              html: true,
              fmt: (u) => link(u, "Open"),
            },
          ]),
        );
        ctx.el.append(
          html(
            `<div class="hint">Showing ${d.filings.length} of ${d.total}. Open goes to the document on sec.gov.</div>`,
          ),
        );
      }
      ctx.setSource(d.source);
    },
  },
  {
    id: "INSD",
    name: "Insider transactions",
    group: "Equities",
    needs: true,
    source: "SEC Form 4 filings, the reports company insiders must file",
    async render(ctx) {
      const want = INSIDER_TABS.includes(ctx.args[0]) ? ctx.args[0] : "ALL";
      const d = await api.fn("insd", { symbol: ctx.sec.id });
      if (!ctx.live()) return;
      withName(ctx, d);
      const rows = d.rows.filter(
        (r) => want === "ALL" || r.side === (want === "BUYS" ? "buy" : "sell"),
      );
      ctx.el.innerHTML = "";
      ctx.el.append(
        tabs(INSIDER_TABS, want, (t) => run(ctx, "INSD", t)),
      );
      if (!rows.length) {
        ctx.el.append(
          html(
            `<div class="hint">${
              want === "ALL"
                ? "No insider transactions found."
                : `No open-market ${want === "BUYS" ? "buys" : "sells"} in the latest filings.`
            }</div>`,
          ),
        );
      } else {
        const side = (v, r) =>
          r.side === "buy" ? "up" : r.side === "sell" ? "down" : "dim";
        ctx.el.append(
          table(rows, [
            { key: "date", label: "Date", left: true, lbl: true },
            { key: "name", label: "Insider", left: true, fmt: clip(20) },
            {
              key: "role",
              label: "Role",
              left: true,
              fmt: clip(22),
              cls: () => "dim",
            },
            { key: "type", label: "Type", left: true, cls: side },
            {
              key: "shares",
              label: "Shares",
              fmt: (v) => num(v, 0),
              cls: side,
            },
            { key: "price", label: "Price", fmt: px },
            { key: "value", label: "Value", fmt: usd },
            { key: "held", label: "After", fmt: (v) => num(v, 0) },
            {
              key: "plan",
              label: "Plan",
              left: true,
              fmt: (v) => (v ? "yes" : ""),
              cls: () => "dim",
            },
            {
              key: "url",
              label: "",
              left: true,
              html: true,
              fmt: (u) => (u ? link(u, "Form") : ""),
            },
          ]),
        );
      }
      ctx.el.append(
        html(
          `<div class="hint">Buy and Sell are trades on the open market. Awards, tax withholding, option exercises and gifts are not trades on the market. After is the shares the insider owns after the trade. Plan means the insider set the sale up in advance.</div>`,
        ),
      );
      ctx.setSource(d.source);
    },
  },
  {
    id: "HDS",
    name: "Holders",
    group: "Equities",
    needs: true,
    source: "Nasdaq institutional holdings (from 13F filings, quarterly)",
    async render(ctx) {
      const d = await api.fn("hds", { symbol: ctx.sec.id });
      if (!ctx.live()) return;
      ctx.el.innerHTML = "";
      const s = d.summary || {};
      const cols = html(`<div class="cols"><div></div><div></div></div>`);
      const [l, r] = cols.children;
      l.append(
        sect("Institutions together"),
        kv([
          [
            "Own",
            s.ownedPct == null ? null : `${num(s.ownedPct)}% of the shares`,
          ],
          ["Holders", s.holders == null ? null : num(s.holders, 0)],
          ["Shares held", s.shares == null ? null : big(s.shares)],
        ]),
      );
      if (s.increased != null)
        r.append(
        sect("Last quarter's moves"),
        kv([
          [
            "Bought more",
            s.increased == null ? null : `${num(s.increased, 0)} holders`,
          ],
          [
            "Sold some",
            s.decreased == null ? null : `${num(s.decreased, 0)} holders`,
          ],
          [
            "New holders",
            s.newPositions == null ? null : num(s.newPositions, 0),
          ],
          ["Sold out", s.soldOut == null ? null : num(s.soldOut, 0)],
        ]),
      );
      ctx.el.append(cols, sect("Biggest holders"));
      ctx.el.append(
        table(d.rows, [
          {
            key: "name",
            label: "Holder",
            left: true,
            lbl: true,
            fmt: clip(34),
          },
          { key: "shares", label: "Shares", fmt: (v) => num(v, 0) },
          {
            key: "pctOfCompany",
            label: "% of company",
            fmt: (v) => (v == null ? "—" : `${num(v)}%`),
          },
          {
            key: "change",
            label: "Change",
            fmt: (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${num(v, 0)}`),
            cls,
          },
          { key: "changePct", label: "Change %", fmt: (v) => pct(v), cls },
          { key: "value", label: "Value", fmt: usd },
          { key: "date", label: "As of", left: true, cls: () => "dim" },
        ]),
      );
      ctx.el.append(
        html(
          `<div class="hint">Holders report to the SEC once a quarter (form 13F), so each row is a snapshot from its As of date.</div>`,
        ),
      );
      ctx.setSource(d.source);
    },
  },
];
