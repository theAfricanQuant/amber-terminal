// Options: OMON, the option monitor. One expiry's chain from CBOE's free delayed quotes: calls on the left,
// the strike in the middle, puts on the right, with the totals and the move the market prices in underneath.
import { api, esc, px, pct, chg, cls, num } from "../api.js";
import { tabs, kv, sect, html } from "../ui.js";

const MON = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
const TAB_EXPIRIES = 8;

const dateOf = (iso) => new Date(`${iso}T12:00:00Z`);
function expLabel(e) {
  const d = dateOf(e.date);
  const yr =
    d.getUTCFullYear() !== new Date().getFullYear()
      ? ` ${String(d.getUTCFullYear()).slice(2)}`
      : "";
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}${yr}${e.root ? ` ${e.root}` : ""}`;
}
const longDate = (iso) =>
  dateOf(iso).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const daysText = (n) =>
  n <= 0 ? "expires today" : n === 1 ? "1 day" : `${n} days`;

const COLS = [
  ["bid", "Bid", (v) => num(v, 2)],
  ["ask", "Ask", (v) => num(v, 2)],
  ["last", "Last", (v) => num(v, 2)],
  ["iv", "IV %", (v) => (v == null ? "—" : num(v * 100, 1))],
  ["delta", "Delta", (v) => num(v, 2)],
  ["volume", "Volume", (v) => num(v, 0)],
  ["oi", "Open int", (v) => num(v, 0)],
];
const SHADE = "background:var(--bar)";
const EDGE =
  "border-left:1px solid var(--line);border-right:1px solid var(--line);text-align:center";

function chainTable(d) {
  const dec = d.rows.some((r) => !Number.isInteger(r.strike)) ? 2 : 0;
  const head = COLS.map(([, l]) => `<th>${l}</th>`).join("");
  const cells = (q, itm) =>
    COLS.map(
      ([k, , f]) =>
        `<td${itm ? ` style="${SHADE}"` : ""}>${esc(q ? f(q[k]) : "—")}</td>`,
    ).join("");
  const body = d.rows
    .map((r) => {
      const atm = r.strike === d.atm;
      const strike = atm
        ? `<td style="${EDGE};background:var(--amber);color:var(--bg);font-weight:700">${num(r.strike, dec)}</td>`
        : `<td class="amber" style="${EDGE}">${num(r.strike, dec)}</td>`;
      return `<tr${atm ? ' data-atm="1"' : ""}>${cells(r.call, r.strike < d.price)}${strike}${cells(r.put, r.strike > d.price)}</tr>`;
    })
    .join("");
  return html(
    `<div><div style="display:flex;justify-content:space-between;color:var(--amber-2);font-weight:700;padding:0 6px"><span>Calls</span><span>Puts</span></div>` +
      `<table class="t"><thead><tr>${head}<th style="${EDGE}">Strike</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
  );
}

function summary(d) {
  const t = d.totals;
  const box = html(`<div class="cols"><div></div><div></div></div>`);
  const [l, r] = box.children;
  l.append(
    sect("Volume and open interest, whole expiry"),
    html(
      `<table class="t"><thead><tr><th class="l"></th><th>Calls</th><th>Puts</th><th>Put/call</th></tr></thead><tbody>` +
        `<tr><td class="l lbl">Volume</td><td>${num(t.callVolume, 0)}</td><td>${num(t.putVolume, 0)}</td><td class="amber">${num(t.pcVolume, 2)}</td></tr>` +
        `<tr><td class="l lbl">Open interest</td><td>${num(t.callOi, 0)}</td><td>${num(t.putOi, 0)}</td><td class="amber">${num(t.pcOi, 2)}</td></tr>` +
        `</tbody></table>`,
    ),
  );
  const m = d.move;
  r.append(sect(`Implied move by ${longDate(d.expiry.date)}`));
  if (m)
    r.append(
      kv([
        [
          "Move priced in",
          d.index
            ? `±${num(m.dollars, 2)} points  (±${num(m.pct, 2)}%)`
            : `±$${num(m.dollars, 2)}  (±${num(m.pct, 2)}%)`,
        ],
        ["Range", `${px(d.price - m.dollars)} to ${px(d.price + m.dollars)}`],
        [
          "From",
          `${num(m.strike, Number.isInteger(m.strike) ? 0 : 2)} call ${num(m.call, 2)} + put ${num(m.put, 2)} (mid prices)`,
        ],
      ]),
    );
  else
    r.append(
      html(
        `<div class="hint">No two-sided quote at the money yet, so no implied move.</div>`,
      ),
    );
  return box;
}

function draw(ctx, d, all) {
  const el = ctx.el;
  el.innerHTML = "";
  const asOf = d.asOf
    ? new Date(d.asOf).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  el.append(
    html(
      `<div style="display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px">` +
        `<span><span class="amber">${esc(d.symbol)}</span>  <b style="font-size:15px;color:var(--white)">${px(d.price)}</b>  <span class="${cls(d.change)}">${chg(d.change)}  ${pct(d.changePct)}</span></span>` +
        (d.iv30 != null
          ? `<span><span class="dim">IV30</span> ${num(d.iv30, 1)}%</span>`
          : "") +
        `<span><span class="dim">Expiry</span> ${esc(longDate(d.expiry.date))}${d.expiry.root && d.expiries.some((e) => e.root) ? ` ${esc(d.expiry.root)}` : ""}, ${daysText(d.expiry.days)}</span>` +
        `<span class="dim">${asOf ? `CBOE file ${asOf}, ` : ""}quotes about 15 minutes delayed</span></div>`,
    ),
  );
  const pick = (n) => ctx.go(`OMON ${n}${all ? " ALL" : ""}`);
  const bar = html(
    `<div style="display:flex;gap:10px;align-items:flex-start;flex-wrap:wrap"></div>`,
  );
  const shown = d.expiries.slice(0, TAB_EXPIRIES);
  const labels = shown.map(expLabel);
  bar.append(
    tabs(labels, labels[d.expiry.n - 1] ?? null, (l) =>
      pick(labels.indexOf(l) + 1),
    ),
  );
  if (d.expiries.length > TAB_EXPIRIES) {
    const sel = html(
      `<select style="background:var(--bar);color:var(--amber);border:1px solid var(--line);font:inherit;padding:1px 4px">` +
        d.expiries
          .map(
            (e) =>
              `<option value="${e.n}"${e.n === d.expiry.n ? " selected" : ""}>${e.n}. ${esc(expLabel(e))} (${e.days}d)</option>`,
          )
          .join("") +
        `</select>`,
    );
    sel.onchange = () => pick(sel.value);
    bar.append(sel);
  }
  bar.append(
    tabs(
      ["NEAR THE MONEY", "ALL STRIKES"],
      all ? "ALL STRIKES" : "NEAR THE MONEY",
      (t) => ctx.go(`OMON ${d.expiry.n}${t === "ALL STRIKES" ? " ALL" : ""}`),
    ),
  );
  el.append(bar);
  if (!d.rows.length) {
    el.append(
      html(`<div class="hint">No strikes quoted for this expiry.</div>`),
    );
    return;
  }
  el.append(chainTable(d));
  el.append(
    html(
      `<div class="hint">${d.rows.length} of ${d.strikes.total} strikes${all ? "" : `, ${d.strikes.shown} either side of the money. OMON ALL shows every strike`}. Shaded cells are in the money.</div>`,
    ),
  );
  el.append(summary(d));
}

export default [
  {
    id: "OMON",
    name: "Option monitor",
    group: "Equities",
    needs: true,
    source:
      "CBOE delayed option quotes (about 15 minutes behind), Nasdaq option chain as the fallback",
    async render(ctx) {
      const n = ctx.args.find((a) => /^\d{1,2}$/.test(a));
      const all = ctx.args.includes("ALL");
      let first = true;
      const load = async () => {
        const d = await api.fn("omon", {
          symbol: ctx.sec.id,
          expiry: n,
          strikes: all ? "all" : null,
        });
        if (!ctx.live()) return;
        const top = ctx.el.scrollTop;
        draw(ctx, d, all);
        const atm = ctx.el.querySelector('tr[data-atm="1"]');
        if (first && atm)
          ctx.el.scrollTop +=
            atm.getBoundingClientRect().top -
            ctx.el.getBoundingClientRect().top -
            ctx.el.clientHeight / 2;
        else ctx.el.scrollTop = top;
        first = false;
        ctx.setSource(d.source);
      };
      await load();
      ctx.every(60e3, () => load().catch(() => {}));
    },
  },
];
