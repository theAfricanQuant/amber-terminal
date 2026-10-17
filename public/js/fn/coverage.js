// Coverage screens that close gaps with the real terminal: CRED credit spreads, AUCT Treasury auctions,
// CT futures curves and OVDV the implied volatility surface.
import { api, esc, num, px, chg, pct, cls, big } from "../api.js";
import { table, sect, tabs, html, lineChart } from "../ui.js";

const fin = Number.isFinite;
const css = (n) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const utc = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
const day = (iso) =>
  iso
    ? utc(iso).toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      })
    : "—";
const dayYear = (iso) =>
  iso
    ? utc(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";
const shortMonth = (label) => label.replace(/ (\d{2})(\d{2})$/, " $2");
const signed = (v, d = 0) => {
  if (!fin(v)) return "—";
  const r = +v.toFixed(d);
  return r === 0 ? (0).toFixed(d) : `${r > 0 ? "+" : ""}${num(r, d)}`;
};
const roundCls =
  (d = 0) =>
  (v) =>
    cls(fin(v) ? +v.toFixed(d) : v);

function links(el, ctx) {
  el.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-c]");
    if (!a) return;
    e.preventDefault();
    ctx.go(a.dataset.c);
  });
  return el;
}

// A small SVG line chart with a numeric x axis (contract number, strike as % of spot, days to expiry).
// series: [{ pts: [[x, y]], color, width, dash, dots, opacity }]; xTicks: [[x, label]].
function plot(series, { xTicks = [], unit = "", height = 220 } = {}) {
  const W = 640,
    H = height,
    L = 52,
    R = 26,
    T = 10,
    B = 22;
  const all = series.flatMap((s) => s.pts).filter(([x, y]) => fin(x) && fin(y));
  if (all.length < 2) return "";
  const xs = [...all.map((p) => p[0]), ...xTicks.map((t) => t[0])];
  let x0 = Math.min(...xs),
    x1 = Math.max(...xs);
  let lo = Math.min(...all.map((p) => p[1])),
    hi = Math.max(...all.map((p) => p[1]));
  if (x1 === x0) x1 = x0 + 1;
  const span = hi - lo || Math.abs(hi) * 0.02 || 1;
  lo -= span * 0.1;
  hi += span * 0.1;
  const mag = 10 ** (Math.floor(Math.log10(hi - lo)) - 1);
  const step = [1, 2, 2.5, 5, 10, 20, 25, 50, 100]
    .map((m) => m * mag)
    .find((s) => (hi - lo) / s <= 6);
  const dp =
    step >= 1 ? 0 : (String(+step.toFixed(8)).split(".")[1] || "").length;
  const x = (v) => L + ((v - x0) / (x1 - x0)) * (W - L - R);
  const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  let g = "";
  for (let k = Math.ceil(lo / step); k * step <= hi; k++) {
    const yy = y(k * step).toFixed(1);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" style="stroke:var(--muted);stroke-opacity:.22"/><text x="${L - 6}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${num(k * step, dp)}${unit}</text>`;
  }
  const every = Math.ceil(xTicks.length / 12);
  xTicks.forEach(([v, l], i) => {
    if (i % every === 0 || i === xTicks.length - 1)
      g += `<text x="${x(v).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(l)}</text>`;
  });
  const lines = series
    .map((s) => {
      const pts = s.pts.filter(([a, b]) => fin(a) && fin(b));
      const d = pts
        .map(
          ([a, b], i) =>
            `${i ? "L" : "M"}${x(a).toFixed(1)},${y(b).toFixed(1)}`,
        )
        .join("");
      const dots = s.dots
        ? pts
            .map(
              ([a, b]) =>
                `<circle cx="${x(a).toFixed(1)}" cy="${y(b).toFixed(1)}" r="2.6" style="fill:${s.color}"/>`,
            )
            .join("")
        : "";
      return `<path d="${d}" style="fill:none;stroke:${s.color};stroke-width:${s.width || 1.6};stroke-opacity:${s.opacity ?? 1};${s.dash ? `stroke-dasharray:${s.dash}` : ""}"/>${dots}`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:${H + 40}px;display:block;font:10px var(--mono);fill:var(--muted)">${g}${lines}</svg>`;
}

// ---------- CRED ----------
const pctileText = (p) =>
  !fin(p)
    ? ""
    : p >= 50
      ? `wider than on ${Math.round(p)}% of days in the past year`
      : `tighter than on ${Math.round(100 - p)}% of days in the past year`;

function credView(ctx, d, state) {
  ctx.el.innerHTML = "";
  state.chart?.remove();
  state.chart = null;
  const ok = d.rows.filter((r) => !r.error);
  const row =
    ok.find((r) => r.key === state.pick) ||
    ok.find((r) => r.key === "HY") ||
    ok[0];
  const latest = ok.reduce((a, r) => (r.date > a ? r.date : a), "");
  const behind = ok.find((r) => r.date === latest)?.behind;
  ctx.el.append(
    html(
      `<div style="font-size:14px;margin-bottom:4px">${esc(row.name)} spread <b class="amber">${num(row.bp, 0)} bp</b> <span class="dim">(${dayYear(row.date)})</span>  <span class="${cls(row.chg1w)}">${signed(row.chg1w)} bp</span> <span class="dim">in a week, ${esc(pctileText(row.pctile))}.</span></div>`,
    ),
    html(
      `<div class="amber" style="margin-bottom:6px">Index spreads: the average extra yield over Treasuries across thousands of company bonds (ICE BofA indices). Not single bonds and not credit default swaps. Latest value is for ${day(latest)}${fin(behind) ? `, ${behind} business day${behind === 1 ? "" : "s"} ago` : ""}: FRED posts each day the next business day, around 11:30am New York time.</div>`,
    ),
  );
  ctx.el.append(
    table(
      d.rows,
      [
        {
          key: "name",
          label: "Index",
          left: true,
          lbl: true,
          fmt: (v, r) => (r.key === row.key ? `▸ ${v}` : v),
        },
        {
          key: "bp",
          label: "Spread bp",
          fmt: (v) => num(v, 0),
          cls: () => "amber",
        },
        {
          key: "chg1w",
          label: "1W chg",
          fmt: (v) => signed(v),
          cls: roundCls(),
        },
        {
          key: "chg1m",
          label: "1M chg",
          fmt: (v) => signed(v),
          cls: roundCls(),
        },
        {
          key: "chg1y",
          label: "1Y chg",
          fmt: (v) => signed(v),
          cls: roundCls(),
        },
        { key: "low1y", label: "1Y low", fmt: (v) => num(v, 0) },
        { key: "high1y", label: "1Y high", fmt: (v) => num(v, 0) },
        {
          key: "pctile",
          label: "1Y percentile",
          fmt: (v) => (fin(v) ? `${num(v, 0)}%` : "—"),
        },
        {
          key: "date",
          label: "Date",
          left: true,
          fmt: (v, r) => (r.error ? "Not available now" : dayYear(v)),
        },
      ],
      {
        onRow: (r) => {
          if (r.error) return;
          state.pick = r.key;
          credView(ctx, d, state);
        },
      },
    ),
  );
  ctx.el.append(sect(`${row.name}: ${row.what}, in basis points`));
  const host = html(`<div style="height:220px;margin:4px 0"></div>`);
  ctx.el.append(host);
  state.chart = lineChart(host, [
    {
      title: "bp",
      color: css("--amber"),
      data: row.history.map((p) => ({ time: p.date, value: p.bp })),
    },
  ]);
  ctx.el.append(
    links(
      html(
        `<div class="hint" style="margin-top:6px">Click a row for its history. Option-adjusted: the value of any call the issuer holds is taken out. bp = basis points: 100bp is 1 percentage point. Percentile: where today sits against every day of the past year (100% = the widest). Wider spreads mean investors want more to lend to companies. Next: <a href="#" data-c="GC">GC yield curve</a> · <a href="#" data-c="AUCT">AUCT Treasury auctions</a></div>`,
      ),
      ctx,
    ),
  );
  ctx.setSource(d.source);
}

// ---------- AUCT ----------
const money = (v) => (fin(v) ? `$${big(v)}` : "Not announced yet");
const security = (v, r) =>
  `${r.name}${r.left ? ` (reopening, ${r.left} left)` : ""}`;
const result = (v, r) =>
  fin(r.rate) ? `${num(r.rate, 3)}% ${r.rateKind}` : "—";

function auctView(ctx, d) {
  ctx.el.innerHTML = "";
  ctx.el.append(sect("Coming up"));
  if (d.upcoming.length)
    ctx.el.append(
      table(d.upcoming, [
        { key: "auction", label: "Auction", left: true, lbl: true, fmt: day },
        { key: "name", label: "Security", left: true, fmt: security },
        { key: "cusip", label: "CUSIP", left: true, cls: () => "dim" },
        { key: "offering", label: "Size", fmt: money },
        { key: "issue", label: "Issue date", left: true, fmt: day },
        { key: "maturity", label: "Matures", left: true, fmt: dayYear },
      ]),
    );
  else
    ctx.el.append(
      html(
        `<div class="hint">${d.partial === "upcoming" ? "TreasuryDirect's upcoming list didn't answer." : "No auctions announced yet."}</div>`,
      ),
    );
  ctx.el.append(sect(`Results, last ${d.recentDays} days`));
  ctx.el.append(
    table(d.recent, [
      { key: "auction", label: "Auction", left: true, lbl: true, fmt: day },
      { key: "name", label: "Security", left: true, fmt: security },
      { key: "cusip", label: "CUSIP", left: true, cls: () => "dim" },
      { key: "offering", label: "Size", fmt: money },
      { key: "rate", label: "High rate", fmt: result, cls: () => "amber" },
      {
        key: "coupon",
        label: "Coupon",
        fmt: (v) => (fin(v) ? `${num(v, 3)}%` : ""),
      },
      {
        key: "bidToCover",
        label: "Bid to cover",
        fmt: (v) => (fin(v) ? `${num(v, 2)}x` : "—"),
      },
      { key: "issue", label: "Issue date", left: true, fmt: day },
    ]),
  );
  ctx.el.append(
    links(
      html(
        `<div class="hint" style="margin-top:6px">High rate: the highest rate the Treasury accepted, which every winning bidder gets. Bills are sold at a discount, notes and bonds on a yield, TIPS on a yield before inflation, floating rate notes (FRN) on a margin over the 13-week bill rate. Bid to cover: dollars bid for every dollar sold, so higher means more demand. Reopening: more of a security already sold. Next: <a href="#" data-c="GC">GC yield curve</a> · <a href="#" data-c="BTMM">BTMM money markets</a> · <a href="#" data-c="CRED">CRED credit spreads</a></div>`,
      ),
      ctx,
    ),
  );
  ctx.setSource(d.source);
}

// ---------- CT ----------
function ctSentence(d) {
  const c = d.curve;
  if (!c)
    return `<div class="err">Too few months traded today to draw the curve.</div>`;
  const pctTxt = `${num(Math.abs(c.spreadPct), 1)}%`;
  const what =
    c.shape === "contango"
      ? `<b class="amber">Contango</b>: ${esc(c.last.label)} costs ${pctTxt} more than ${esc(c.first.label)}. Later months cost more than the front, ${d.financial ? "which for a financial future mostly reflects interest rates against the dividends or coupons the holder gives up" : "which usually reflects the cost of storing and financing the thing until then"}.`
      : c.shape === "backwardation"
        ? `<b class="amber">Backwardation</b>: ${esc(c.last.label)} costs ${pctTxt} less than ${esc(c.first.label)}. Later months cost less than the front, ${d.financial ? "which for a financial future mostly means the dividends or coupons earned are worth more than the interest cost" : "which usually means supply is tight right now"}.`
        : `<b class="amber">Flat</b>: ${esc(c.last.label)} and ${esc(c.first.label)} cost about the same.`;
  const hump = [
    c.peak ? `highest in ${esc(c.peak.label)} (${px(c.peak.price)})` : "",
    c.trough ? `lowest in ${esc(c.trough.label)} (${px(c.trough.price)})` : "",
  ].filter(Boolean);
  // Ends within 2% with a hump in between: the slope from first to last says little, so lead with the shape.
  if (hump.length && Math.abs(c.spreadPct) < 2)
    return `<div style="font-size:14px;margin-bottom:4px"><b class="amber">Mixed</b>: ${esc(c.last.label)} and ${esc(c.first.label)} are within ${pctTxt} of each other (${c.spreadPct < 0 ? "a slight backwardation" : "a slight contango"}), but the months in between are not: ${hump.join(", ")}. Seasonal demand often shapes a curve like this.</div>`;
  return `<div style="font-size:14px;margin-bottom:4px">${what}${hump.length ? ` The curve isn't one straight slope: ${hump.join(", ")}.` : ""}</div>`;
}

function ctView(ctx, d) {
  ctx.setTitle(`${d.name}  ·  ${d.generic || d.root} futures curve`);
  ctx.el.innerHTML = "";
  ctx.el.append(html(ctSentence(d)));
  const cur = d.contracts.filter((c) => c.current);
  const idx = new Map(d.contracts.map((c, i) => [c.symbol, i]));
  ctx.el.append(
    html(
      `<div>${plot(
        [
          {
            color: "var(--amber)",
            width: 2.4,
            dots: true,
            pts: cur.map((c) => [idx.get(c.symbol), c.price]),
          },
        ],
        { xTicks: d.contracts.map((c, i) => [i, shortMonth(c.label)]) },
      )}</div>`,
    ),
  );
  const front = cur[0]?.price;
  ctx.el.append(
    table(d.contracts, [
      { key: "code", label: "Contract", left: true, lbl: true },
      { key: "label", label: "Month", left: true },
      {
        key: "price",
        label: "Last",
        fmt: (v) => px(v),
        cls: (v, r) => (r.current ? "amber" : "dim"),
      },
      {
        key: "change",
        label: "Change",
        fmt: (v, r) => chg(v, r.price >= 10 ? 2 : 3),
        cls: (v) => cls(v),
      },
      {
        key: "changePct",
        label: "Change %",
        fmt: (v) => pct(v),
        cls: (v) => cls(v),
      },
      {
        key: "price",
        label: "Vs front",
        fmt: (v, r) =>
          r.current && fin(front) ? pct((v / front - 1) * 100) : "—",
      },
      {
        key: "date",
        label: "Priced",
        left: true,
        fmt: (v, r) =>
          r.current ? "Today's session" : `Last traded ${day(v)}`,
        cls: (v, r) => (r.current ? "" : "dim"),
      },
    ]),
  );
  const notes = [];
  if (d.contracts.some((c) => !c.current))
    notes.push(
      "Months marked “last traded” haven't traded yet this session, so they keep their last price and are left off the chart.",
    );
  if (d.missing.length)
    notes.push(`Yahoo sent nothing for ${d.missing.join(", ")}.`);
  if (d.contracts.length < 8)
    notes.push(
      `Yahoo lists only ${d.contracts.length} contract months for this market.`,
    );
  notes.push(
    `Prices in ${esc(d.unit)}, about 10 minutes delayed. Months shown are the ones the exchange trades most.`,
  );
  ctx.el.append(
    links(
      html(
        `<div class="hint" style="margin-top:6px">${notes.join(" ")} Next: <a href="#" data-c="GP">GP chart</a> · <a href="#" data-c="COT">COT positioning</a></div>`,
      ),
      ctx,
    ),
  );
  ctx.setSource(d.source);
}

// ---------- OVDV ----------
const iv = (v) => (fin(v) ? num(v, 1) : "—");
const expShort = (e) =>
  `${utc(e.date).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })} · ${e.days}d`;

function vixBlock(v) {
  const box = html(`<div></div>`);
  if (!v?.rows?.some((r) => fin(r.value))) return box;
  const word =
    v.shape === "contango"
      ? `<b class="amber">Contango</b>: 30-day VIX ${num(v.rows[1].value, 2)} is below 3-month VIX ${num(v.rows[2].value, 2)} (ratio ${num(v.ratio, 2)}). The normal, calm-market shape: protection further out costs more.`
      : v.shape === "inverted"
        ? `<b class="down">Inverted</b>: 30-day VIX ${num(v.rows[1].value, 2)} is above 3-month VIX ${num(v.rows[2].value, 2)} (ratio ${num(v.ratio, 2)}). Near-term fear is higher than longer-term, which usually happens in a sell-off.`
        : `<b class="amber">Flat</b>: 30-day and 3-month VIX are about equal.`;
  box.append(
    sect("VIX term structure (S&P 500 implied volatility at fixed horizons)"),
    html(
      `<div style="margin-bottom:4px">${word}${v.steady ? " Every step up the curve is higher." : ""}</div>`,
    ),
    html(
      `<div>${plot(
        [
          {
            color: "var(--amber)",
            width: 2.4,
            dots: true,
            pts: v.rows.map((r) => [Math.log(r.days), r.value]),
          },
        ],
        { xTicks: v.rows.map((r) => [Math.log(r.days), r.label]), height: 150 },
      )}</div>`,
    ),
    table(v.rows, [
      { key: "label", label: "Index", left: true, lbl: true },
      { key: "name", label: "Horizon", left: true },
      {
        key: "value",
        label: "Level",
        fmt: (x) => num(x, 2),
        cls: () => "amber",
      },
      {
        key: "change",
        label: "Change",
        fmt: (x) => chg(x),
        cls: (x) => cls(x),
      },
      { key: "date", label: "As of", left: true, fmt: day },
    ]),
  );
  return box;
}

function ovdvView(ctx, d, state) {
  ctx.el.innerHTML = "";
  const asOf = d.asOf
    ? new Date(d.asOf).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const chosen = d.expiries[d.pick - 1];
  ctx.el.append(
    html(
      `<div style="display:flex;gap:14px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px"><span><span class="amber">${esc(d.symbol)}</span>  <b style="font-size:15px;color:var(--white)">${px(d.price)}</b></span>${fin(d.iv30) ? `<span><span class="dim">IV30</span> ${num(d.iv30, 2)}%</span>` : ""}<span><span class="dim">At the money, ${chosen.days} days</span> <b class="amber">${iv(chosen.atm)}%</b></span><span class="dim">${asOf ? `CBOE file ${asOf}, ` : ""}about 15 minutes delayed</span></div>`,
    ),
  );
  const labels = d.expiries.map(expShort);
  ctx.el.append(
    tabs(labels, labels[d.pick - 1], (l) =>
      ctx.go(`OVDV ${labels.indexOf(l) + 1}`),
    ),
  );
  const box = html(`<div class="cols"><div></div><div></div></div>`);
  const [l, r] = box.children;
  const smile = d.smile.points;
  l.append(
    sect(`Smile, ${dayYear(d.smile.date)}: IV % by strike as % of spot`),
    html(
      `<div>${plot(
        [
          {
            color: "var(--amber)",
            width: 2,
            pts: smile.map((p) => [p.m, p.iv]),
          },
          {
            color: "var(--muted)",
            dash: "3 3",
            width: 1,
            pts: [
              [100, Math.min(...smile.map((p) => p.iv))],
              [100, Math.max(...smile.map((p) => p.iv))],
            ],
          },
        ],
        {
          unit: "%",
          xTicks: [70, 80, 85, 90, 95, 100, 105, 110, 115, 120, 130]
            .filter(
              (m) => smile.length && m >= smile[0].m && m <= smile.at(-1).m,
            )
            .map((m) => [m, `${m}%`]),
        },
      )}</div>`,
    ),
  );
  const term = d.expiries.filter((e) => fin(e.atm));
  r.append(
    sect("Term structure: at-the-money IV % by days to expiry"),
    html(
      `<div>${plot(
        [
          {
            color: "var(--amber)",
            width: 2.4,
            dots: true,
            pts: term.map((e) => [Math.log(e.days), e.atm]),
          },
        ],
        {
          unit: "%",
          xTicks: term.map((e) => [Math.log(e.days), `${e.days}d`]),
        },
      )}</div>`,
    ),
  );
  ctx.el.append(box);
  ctx.el.append(
    tabs(
      ["BY DELTA", "BY % OF SPOT"],
      state.view,
      (t) => ((state.view = t), ovdvView(ctx, d, state)),
    ),
  );
  const exp = {
    key: "date",
    label: "Expiry",
    left: true,
    lbl: true,
    fmt: (v, e) => `${dayYear(v)}${e.root && d.index ? ` ${e.root}` : ""}`,
  };
  const days = { key: "days", label: "Days", fmt: (v) => num(v, 0) };
  const pickRow = { onRow: (e) => ctx.go(`OVDV ${d.expiries.indexOf(e) + 1}`) };
  ctx.el.append(
    state.view === "BY DELTA"
      ? table(
          d.expiries,
          [
            exp,
            days,
            { key: "put10", label: "10Δ put", fmt: iv },
            { key: "put25", label: "25Δ put", fmt: iv },
            { key: "atm", label: "At the money", fmt: iv, cls: () => "amber" },
            { key: "call25", label: "25Δ call", fmt: iv },
            { key: "call10", label: "10Δ call", fmt: iv },
            {
              key: "skew",
              label: "Skew (25Δ put − call)",
              fmt: (v) => (fin(v) ? signed(v, 1) : "—"),
            },
          ],
          pickRow,
        )
      : table(
          d.expiries,
          [
            exp,
            days,
            ...Object.keys(d.expiries[0].byMoneyness).map((m) => ({
              key: (e) => e.byMoneyness[m],
              label: `${m}%`,
              fmt: iv,
              cls: () => (m === "100" ? "amber" : ""),
            })),
          ],
          pickRow,
        ),
  );
  ctx.el.append(vixBlock(d.vix));
  ctx.el.append(
    links(
      html(
        `<div class="hint" style="margin-top:6px">Implied volatility (IV): the yearly move the option prices imply, in %. The surface uses out-of-the-money options with a live bid: puts below the spot price, calls above. 25Δ put = the put with a delta of −0.25, about a 1-in-4 chance of finishing in the money. Skew above zero means downside protection costs more than upside. One expiry near each of 1 week, 2 weeks, 1, 2, 3, 6 and 9 months and 1 year. Click a row or tab for its smile. Next: <a href="#" data-c="OMON">OMON option chain</a></div>`,
      ),
      ctx,
    ),
  );
  ctx.setSource(d.source);
}

export default [
  {
    id: "CRED",
    name: "Credit spreads",
    group: "Rates",
    needs: undefined,
    source:
      "ICE BofA option-adjusted spreads via FRED, daily, one business day behind",
    async render(ctx) {
      const state = { pick: null, chart: null };
      ctx.onCleanup(() => state.chart?.remove());
      const load = async () => {
        const d = await api.fn("cred");
        if (ctx.live()) credView(ctx, d, state);
      };
      await load();
      ctx.every(60 * 60e3, () => load().catch(() => {}));
    },
  },
  {
    id: "AUCT",
    name: "Treasury auctions",
    group: "Rates",
    needs: undefined,
    source: "TreasuryDirect auction announcements and results",
    async render(ctx) {
      const load = async () => {
        const d = await api.fn("auct");
        if (ctx.live()) auctView(ctx, d);
      };
      await load();
      ctx.every(30 * 60e3, () => load().catch(() => {}));
    },
  },
  {
    id: "CT",
    name: "Futures curve",
    group: "Markets",
    needs: true,
    source:
      "One Yahoo Finance symbol per contract month (about 10 minutes delayed)",
    async render(ctx) {
      const load = async () => {
        const d = await api.fn("ct", { symbol: ctx.sec.id });
        if (ctx.live()) ctView(ctx, d);
      };
      await load();
      ctx.every(2 * 60e3, () => load().catch(() => {}));
    },
  },
  {
    id: "OVDV",
    name: "Volatility surface",
    group: "Equities",
    needs: true,
    source:
      "CBOE delayed option quotes (about 15 minutes behind); VIX indices via Yahoo Finance",
    async render(ctx) {
      const n = ctx.args.find((a) => /^\d{1,2}$/.test(a));
      const state = { view: "BY DELTA" };
      const load = async () => {
        const d = await api.fn("ovdv", { symbol: ctx.sec.id, expiry: n });
        if (ctx.live()) ovdvView(ctx, d, state);
      };
      await load();
      ctx.every(2 * 60e3, () => load().catch(() => {}));
    },
  },
];
