// Rates and economics screens: yield curves, money markets, the Fed rate path priced by futures, US economic
// statistics, central bank policy rates and futures positioning (Commitments of Traders).
import { api, esc, num, cls } from "../api.js";
import { table, kv, sect, tabs, html, lineChart } from "../ui.js";

const css = (n) =>
  getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const fin = Number.isFinite;
const pctv = (v, d = 2) => (fin(v) ? `${num(v, d)}%` : "—");
// Signed change, with -0 shown as 0.
const bp = (v, d = 0) => {
  if (!fin(v)) return "—";
  const r = +v.toFixed(d);
  return r === 0 ? (0).toFixed(d) : `${r > 0 ? "+" : ""}${num(r, d)}`;
};
const bpCls =
  (d = 0) =>
  (v) =>
    cls(fin(v) ? +v.toFixed(d) : v);
const signed = (v) => (fin(v) ? `${v > 0 ? "+" : ""}${num(v, 0)}` : "—");
const utcDate = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`);
const day = (iso) =>
  iso
    ? utcDate(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";
const shortDay = (iso) =>
  utcDate(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const period = (iso, freq) =>
  !iso
    ? "—"
    : freq === "D"
      ? day(iso)
      : freq === "Q"
        ? `Q${Math.floor((+iso.slice(5, 7) - 1) / 3) + 1} ${iso.slice(0, 4)}`
        : utcDate(iso).toLocaleDateString("en-GB", {
            month: "short",
            year: "numeric",
            timeZone: "UTC",
          });
const clock = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function links(el, ctx) {
  el.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-c]");
    if (!a) return;
    e.preventDefault();
    ctx.go(a.dataset.c);
  });
  return el;
}

// A small line chart drawn as SVG, for x values that are labels (tenors, meeting dates) rather than time.
// series: [{ values: [number|null], color, width, opacity, dash, dots }]
function lineSvg(labels, series, { unit = "%" } = {}) {
  const W = 640,
    H = 220,
    L = 50,
    R = 12,
    T = 10,
    B = 22;
  const vals = series.flatMap((s) => s.values).filter(fin);
  if (!vals.length) return "";
  let lo = Math.min(...vals),
    hi = Math.max(...vals);
  const span = hi - lo || 0.5;
  ((lo -= span * 0.08), (hi += span * 0.08));
  // The finest round step that gives at most 7 gridlines.
  const mag = 10 ** (Math.floor(Math.log10(hi - lo)) - 1);
  const step = [1, 2, 2.5, 5, 10, 20, 25, 50, 100]
    .map((m) => m * mag)
    .find((s) => (hi - lo) / s <= 7);
  const dp =
    step >= 1 ? 0 : (String(+step.toFixed(6)).split(".")[1] || "").length;
  const x = (i) =>
    L +
    (labels.length < 2
      ? (W - L - R) / 2
      : (i * (W - L - R)) / (labels.length - 1));
  const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  let g = "";
  for (let k = Math.ceil(lo / step); k * step <= hi; k++) {
    const v = k * step,
      yy = y(v).toFixed(1);
    g += `<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" style="stroke:var(--muted);stroke-opacity:.22"/><text x="${L - 6}" y="${(+yy + 3).toFixed(1)}" text-anchor="end">${v.toFixed(dp)}${unit}</text>`;
  }
  const every = Math.ceil(labels.length / 14);
  labels.forEach((l, i) => {
    if (i % every === 0 || i === labels.length - 1)
      g += `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(l)}</text>`;
  });
  const lines = series
    .map((s) => {
      let d = "",
        pen = false;
      s.values.forEach((v, i) => {
        if (!fin(v)) return (pen = false);
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      const dots = s.dots
        ? s.values
            .map((v, i) =>
              fin(v)
                ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" style="fill:${s.color}"/>`
                : "",
            )
            .join("")
        : "";
      return `<path d="${d}" style="fill:none;stroke:${s.color};stroke-width:${s.width || 1.4};stroke-opacity:${s.opacity ?? 1};${s.dash ? `stroke-dasharray:${s.dash}` : ""}"/>${dots}`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;max-height:280px;display:block;font:10px var(--mono);fill:var(--muted)">${g}${lines}</svg>`;
}

const legend = (items) =>
  `<div class="hint" style="display:flex;gap:16px;flex-wrap:wrap;margin:2px 0 6px">${items
    .map(
      (i) =>
        `<span style="color:${i.color};opacity:${i.opacity ?? 1}">${i.dash ? "╍╍" : "━━"} ${esc(i.label)}</span>`,
    )
    .join("")}</div>`;

// ---------- GC ----------
const CURVE_STYLE = {
  now: { color: "var(--amber)", width: 2.4, dots: true },
  "1W": { color: "var(--amber)", opacity: 0.5, dash: "5 3" },
  "1M": { color: "var(--white)", opacity: 0.55 },
  "1Y": { color: "var(--muted)", dash: "2 3" },
  prev: { color: "var(--muted)", dash: "4 3" },
};
const SHORT = {
  "1 week ago": "1W ago",
  "1 month ago": "1M ago",
  "1 year ago": "1Y ago",
  "Previous close": "Prev close",
};

function gcView(ctx, d) {
  const live = d.kind === "live";
  const dp = live ? 3 : 2,
    bdp = live ? 1 : 0;
  const [now, ...past] = d.curves;
  ctx.setTitle(d.name);
  ctx.el.innerHTML = "";
  const cur = d.countries.find((c) => c.code === d.country)?.label;
  ctx.el.append(
    tabs(
      d.countries.map((c) => c.label),
      cur,
      (lab) => ctx.go(`GC ${d.countries.find((c) => c.label === lab).code}`),
    ),
  );
  const s = d.spread;
  if (s)
    ctx.el.append(
      html(
        `<div style="margin-bottom:4px">2s10s spread <b class="${s.inverted ? "down" : "amber"}">${bp(s.bp, bdp)} bp</b> <span class="dim">(10-year ${pctv(s.tenYear, dp)} minus 2-year ${pctv(s.twoYear, dp)})</span>. ${
          s.inverted
            ? `<b class="down">Inverted:</b> the 2-year yields more than the 10-year.`
            : "Not inverted: the 10-year yields more than the 2-year."
        }</div>`,
      ),
    );
  if (d.note) ctx.el.append(html(`<div class="err">${esc(d.note)}</div>`));
  const series = [...past].reverse().map((c) => ({
    ...CURVE_STYLE[c.key],
    values: d.tenors.map((t) => c.values[t]),
  }));
  series.push({
    ...CURVE_STYLE.now,
    values: d.tenors.map((t) => now.values[t]),
  });
  ctx.el.append(html(`<div>${lineSvg(d.tenors, series)}</div>`));
  ctx.el.append(
    html(
      legend(
        d.curves.map((c) => ({
          ...CURVE_STYLE[c.key],
          label:
            c.key === "now"
              ? live
                ? `Now (${clock(c.date)} your time)`
                : `Latest close ${day(c.date)}`
              : c.date
                ? `${c.label} ${day(c.date)}`
                : c.label,
        })),
      ),
    ),
  );
  const rows = d.tenors.map((t) => {
    const r = { t, now: now.values[t] };
    for (const c of past) {
      r[c.key] = c.values[t];
      r[`${c.key}chg`] =
        fin(now.values[t]) && fin(c.values[t])
          ? (now.values[t] - c.values[t]) * 100
          : null;
    }
    return r;
  });
  ctx.el.append(
    table(rows, [
      { key: "t", label: "Tenor", left: true, lbl: true },
      { key: "now", label: live ? "Now" : "Latest", fmt: (v) => pctv(v, dp) },
      ...past.flatMap((c) => [
        {
          key: c.key,
          label: SHORT[c.label] || c.label,
          fmt: (v) => pctv(v, dp),
        },
        {
          key: `${c.key}chg`,
          label: "Chg bp",
          fmt: (v) => bp(v, bdp),
          cls: bpCls(bdp),
        },
      ]),
    ]),
  );
  ctx.el.append(
    links(
      html(
        `<div class="hint" style="margin-top:6px">${
          live
            ? "Live market yields from CNBC, an unofficial feed. Change is against the previous close."
            : `Par yields: the Treasury's official curve, published each evening for that day's close. For yields moving now, see <a href="#" data-c="GC USLIVE">US LIVE</a>.`
        } bp = basis points: 100bp is 1 percentage point. Next: <a href="#" data-c="BTMM">BTMM money markets</a> · <a href="#" data-c="WIRP">WIRP rate path</a></div>`,
      ),
      ctx,
    ),
  );
  ctx.setSource(d.source);
}

// ---------- WIRP ----------
// A meeting's step in 25bp moves, read the way FedWatch reads it: 0.3 = a 30% chance of a 25bp move.
export const describeStep = (m) => {
  if (!fin(m)) return "—";
  const a = Math.abs(m),
    kind = m > 0 ? "hike" : "cut";
  if (Math.round(a * 100) === 0) return "No change priced";
  if (a <= 1) return `${Math.round(a * 100)}% chance of a 25bp ${kind}`;
  const whole = Math.floor(a),
    rest = Math.round((a - whole) * 100);
  return `${whole * 25}bp ${kind} priced${rest ? `, ${rest}% chance of ${(whole + 1) * 25}bp` : ""}`;
};
const movesText = (m) => {
  if (!fin(m)) return "—";
  const a = Math.abs(m).toFixed(2);
  return a === "0.00"
    ? "none"
    : `${a} ${m > 0 ? "hike" : "cut"}${a === "1.00" ? "" : "s"}`;
};
// Futures prices move in 0.005 or 0.0025 steps: show the fourth decimal only when it's there.
const tick = (v) =>
  fin(v) ? v.toFixed(Math.round(v * 1e4) % 10 ? 4 : 3) : "—";

function wirpView(ctx, d) {
  const e = d.effr;
  ctx.el.innerHTML = "";
  ctx.el.append(
    html(
      `<div style="font-size:14px;margin-bottom:4px">Effective fed funds rate <b class="amber">${pctv(e.rate)}</b> <span class="dim">(${day(e.date)})</span>${
        fin(e.from) && fin(e.to)
          ? `  ·  Fed target range <b class="amber">${pctv(e.from)} to ${pctv(e.to)}</b>`
          : ""
      }</div>`,
    ),
    html(
      `<div class="amber" style="margin-bottom:4px">Worked out from fed funds futures prices, delayed about 10 minutes. It shows what the market is pricing, not an official forecast.</div>`,
    ),
  );
  const m = d.meetings;
  if (!m.length) {
    ctx.el.append(
      html(
        `<div class="err">No futures prices were found for the coming meetings. Try again in a few minutes.</div>`,
      ),
    );
    return;
  }
  ctx.el.append(
    html(
      `<div style="margin-bottom:4px">Next meeting <b class="amber">${day(m[0].date)}</b>: ${esc(describeStep(m[0].stepMoves))} <span class="dim">(${bp(m[0].stepBp, 1)} bp).</span> By ${day(m.at(-1).date)}: <b class="${cls(m.at(-1).cumBp)}">${bp(m.at(-1).cumBp, 1)} bp</b> from today, ${movesText(m.at(-1).moves)} of 25bp.</div>`,
    ),
  );
  ctx.el.append(
    html(
      `<div>${lineSvg(
        m.map((x) => shortDay(x.date)),
        [
          { color: "var(--muted)", dash: "4 3", values: m.map(() => e.rate) },
          {
            color: "var(--amber)",
            width: 2.4,
            dots: true,
            values: m.map((x) => x.after),
          },
        ],
      )}</div>`,
    ),
    html(
      legend([
        { color: "var(--amber)", label: "Rate priced after each meeting" },
        {
          color: "var(--muted)",
          dash: true,
          label: `Today's effective rate ${pctv(e.rate)}`,
        },
      ]),
    ),
  );
  const monthName = Object.fromEntries(
    d.contracts.map((c) => [c.month, c.label]),
  );
  ctx.el.append(sect("FOMC meetings"));
  ctx.el.append(
    table(m, [
      { key: "date", label: "Meeting", left: true, lbl: true, fmt: day },
      { key: "after", label: "Rate priced", fmt: (v) => pctv(v, 3) },
      { key: "stepBp", label: "Move bp", fmt: (v) => bp(v, 1), cls: bpCls(1) },
      { key: "stepMoves", label: "Read as", left: true, fmt: describeStep },
      {
        key: "cumBp",
        label: "Vs today bp",
        fmt: (v) => bp(v, 1),
        cls: bpCls(1),
      },
      { key: "moves", label: "25bp moves priced", fmt: movesText },
      {
        key: "contract",
        label: "From contract",
        left: true,
        fmt: (v) => monthName[v] || v,
        cls: () => "dim",
      },
    ]),
  );
  ctx.el.append(sect("Fed funds futures (30-day, CME)"));
  ctx.el.append(
    table(d.contracts, [
      {
        key: (r) => r.symbol.replace(/\.CBT$/, ""),
        label: "Contract",
        left: true,
        lbl: true,
      },
      { key: "label", label: "Month", left: true },
      { key: "price", label: "Price", fmt: tick },
      {
        key: "rate",
        label: "Average rate priced",
        fmt: (v) => (fin(v) ? `${tick(v)}%` : "—"),
      },
      {
        key: "changeBp",
        label: "Day chg bp",
        fmt: (v) => bp(v, 1),
        cls: bpCls(1),
      },
    ]),
  );
  ctx.el.append(
    html(
      `<div class="hint" style="margin-top:6px">How it works: each contract pays out on the average fed funds rate over its month, so 100 minus its price is the average rate the market expects. For a meeting on day d of an N-day month, the rate after it = (month average − rate before × d/N) ÷ (1 − d/N), starting from today's effective rate and chaining meeting to meeting. A meeting in the last week of its month uses the next month's contract. Meeting dates from federalreserve.gov.</div>`,
    ),
  );
  ctx.setSource(d.source);
}

// ---------- ECST ----------
const ecstVal = (v, r) => {
  if (!fin(v)) return "—";
  if (r.unit === "k") return `${v > 0 ? "+" : ""}${num(v, 0)}k`;
  return r.unit === "%" ? `${num(v, r.dp)}%` : num(v, r.dp);
};
const ecstChg = (v, r) => {
  if (!fin(v)) return "—";
  if (r.changeIn === "bp") return `${bp(v)} bp`;
  if (r.changeIn === "k") return `${bp(v)}k`;
  return r.unit === "%" ? `${bp(v, r.dp)} pts` : bp(v, r.dp);
};

// ---------- COT ----------
const COT_COLORS = ["--amber", "--white", "--muted"];
const GROUP_WHAT = {
  tff: "Leveraged funds are hedge funds and trading firms. Asset managers are pension, insurance and mutual funds. Dealers are banks, usually on the other side of their clients' trades.",
  dis: "Managed money is hedge funds and trading advisers. Producers and merchants are miners, drillers, refiners and other businesses hedging the real thing. Swap dealers are banks hedging swaps they've sold.",
};

export default [
  {
    id: "GC",
    name: "Yield curves",
    group: "Rates",
    needs: undefined,
    source:
      "US Treasury daily par yield curve; CNBC live bond yields for other countries",
    async render(ctx) {
      const country = ctx.args.join(" ") || "US";
      const load = async () => {
        const d = await api.fn("gc", { country });
        if (ctx.live()) gcView(ctx, d);
      };
      await load();
      ctx.every(country === "US" ? 15 * 60e3 : 60e3, () =>
        load().catch(() => {}),
      );
    },
  },
  {
    id: "BTMM",
    name: "US money markets",
    group: "Rates",
    needs: undefined,
    source: "New York Fed reference rates; US Treasury bill and note yields",
    async render(ctx) {
      const load = async () => {
        const d = await api.fn("btmm");
        if (!ctx.live()) return;
        ctx.el.innerHTML = "";
        const effr = d.funding.find((r) => r.key === "EFFR");
        if (d.target)
          ctx.el.append(
            html(
              `<div style="font-size:14px;margin-bottom:6px">Fed target range <b class="amber">${pctv(d.target.from)} to ${pctv(d.target.to)}</b>${
                fin(effr?.rate)
                  ? `  ·  effective fed funds <b class="amber">${pctv(effr.rate)}</b> <span class="dim">(${day(effr.date)})</span>`
                  : ""
              }</div>`,
            ),
          );
        const cols = (first, prevLabel) => [
          { key: "name", label: first, left: true, lbl: true },
          { key: "rate", label: "Latest", fmt: (v) => pctv(v) },
          { key: "prev", label: prevLabel, fmt: (v) => pctv(v) },
          { key: "changeBp", label: "Chg bp", fmt: (v) => bp(v), cls },
          {
            key: "date",
            label: "For",
            left: true,
            fmt: (v, r) => (r.error ? "Not available now" : day(v)),
          },
        ];
        ctx.el.append(
          sect(
            "Overnight rates (New York Fed, each morning for the business day before)",
          ),
        );
        ctx.el.append(
          table(d.funding, [
            ...cols("Rate", "Day before"),
            { key: "note", label: "", left: true, cls: () => "dim" },
          ]),
        );
        ctx.el.append(kv(d.funding.map((r) => [r.key, r.what])));
        ctx.el.append(sect("Treasury bills (yield, coupon equivalent)"));
        ctx.el.append(table(d.bills, cols("Bill", "Day before")));
        ctx.el.append(sect("Treasury notes (par yield)"));
        ctx.el.append(table(d.notes, cols("Note", "Day before")));
        ctx.el.append(
          links(
            html(
              `<div class="hint" style="margin-top:6px">SOFR and EFFR are published around 8 to 9am New York time for the day before. Treasury yields are published each evening for that day's close. bp = basis points: 100bp is 1 percentage point. Next: <a href="#" data-c="WIRP">WIRP rate path</a> · <a href="#" data-c="GC">GC yield curve</a></div>`,
            ),
            ctx,
          ),
        );
        ctx.setSource(d.source);
      };
      await load();
      ctx.every(15 * 60e3, () => load().catch(() => {}));
    },
  },
  {
    id: "WIRP",
    name: "Fed rate path priced by futures",
    group: "Rates",
    needs: undefined,
    source:
      "CME 30-day fed funds futures via Yahoo Finance (about 10 minutes delayed)",
    async render(ctx) {
      const load = async () => {
        const d = await api.fn("wirp");
        if (ctx.live()) wirpView(ctx, d);
      };
      await load();
      ctx.every(2 * 60e3, () => load().catch(() => {}));
    },
  },
  {
    id: "ECST",
    name: "US economic statistics",
    group: "Economics",
    needs: undefined,
    source: "FRED, St. Louis Fed",
    async render(ctx) {
      let data,
        pick = null,
        chart = null;
      ctx.onCleanup(() => chart?.remove());
      const draw = () => {
        chart?.remove();
        chart = null;
        ctx.el.innerHTML = "";
        const row = pick && data.rows.find((r) => r.key === pick);
        if (!row) {
          ctx.el.append(
            table(
              data.rows,
              [
                { key: "name", label: "Statistic", left: true, lbl: true },
                { key: "value", label: "Latest", fmt: ecstVal },
                { key: "prev", label: "Previous", fmt: ecstVal },
                { key: "change", label: "Change", fmt: ecstChg, cls },
                {
                  key: "date",
                  label: "Period",
                  left: true,
                  fmt: (v, r) =>
                    r.error ? "Not available now" : period(v, r.freq),
                },
              ],
              {
                onRow: (r) => {
                  if (!r.history?.length) return;
                  pick = r.key;
                  draw();
                },
              },
            ),
          );
          ctx.el.append(
            html(
              `<div class="hint" style="margin-top:6px">Click a row to see its history. Inflation is the change against the same month a year before, worked out here from the price index. pts = percentage points, bp = basis points (100bp is 1 point). ${esc(data.notFree)}</div>`,
            ),
          );
          ctx.setSource(data.source);
          return;
        }
        const head = html(
          `<div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><a href="#">← All statistics</a>  <b class="amber">${esc(row.name)}</b>  <span class="dim">${esc(ecstVal(row.value, row))} (${esc(period(row.date, row.freq))})</span></div>`,
        );
        head.querySelector("a").onclick = (e) => {
          e.preventDefault();
          pick = null;
          draw();
        };
        const box = html(`<div class="chartbox"></div>`);
        ctx.el.append(head, box);
        chart = lineChart(box, [
          {
            title:
              row.unit === "k"
                ? "jobs added, thousands"
                : row.unit === "%"
                  ? "%"
                  : "",
            color: css("--amber"),
            data: row.history.map((p) => ({ time: p.date, value: p.value })),
          },
        ]);
        ctx.setSource(`FRED ${row.id}. ${row.note}`);
      };
      const load = async () => {
        const d = await api.fn("ecst");
        if (!ctx.live()) return;
        data = d;
        draw();
      };
      await load();
      ctx.every(30 * 60e3, () => load().catch(() => {}));
    },
  },
  {
    id: "CBRT",
    name: "Central bank rates",
    group: "Rates",
    needs: undefined,
    source:
      "BIS central bank policy rates; New York Fed for the Fed's target range",
    async render(ctx) {
      const d = await api.fn("cbrt");
      if (!ctx.live()) return;
      ctx.el.innerHTML = "";
      // The Fed sets a 25bp range; BIS records its middle, so show the range itself.
      const range = (mid) =>
        `${num(mid - 0.125, 2)} to ${num(mid + 0.125, 2)}%`;
      ctx.el.append(
        table(d.rows, [
          { key: "bank", label: "Central bank", left: true, lbl: true },
          { key: "country", label: "Country", left: true },
          {
            key: "rate",
            label: "Policy rate",
            fmt: (v, r) =>
              r.error
                ? "—"
                : r.target
                  ? `${num(r.target.from, 2)} to ${num(r.target.to, 2)}%`
                  : pctv(v),
            cls: () => "amber",
          },
          {
            key: "changed",
            label: "Last change",
            left: true,
            fmt: (v, r) =>
              v ? day(v) : r.since ? `None since ${day(r.since)}` : "—",
          },
          { key: "changeBp", label: "Size bp", fmt: (v) => bp(v), cls },
          {
            key: "prev",
            label: "Before",
            fmt: (v, r) =>
              fin(v) && r.area === "US" && r.target ? range(v) : pctv(v),
          },
          {
            key: "asOf",
            label: "Data to",
            left: true,
            fmt: (v, r) => (r.error ? "Not available now" : day(v)),
          },
          { key: "note", label: "Which rate", left: true, cls: () => "dim" },
        ]),
      );
      ctx.el.append(
        html(
          `<div class="hint" style="margin-top:6px">Last change is the day the new rate took effect. The BIS collects these from each central bank and runs a few days behind, so a move this week may not show yet. The Fed's row shows today's target range from the New York Fed.${d.partial ? " The BIS didn't answer, so only the banks with their own free feed are shown." : ""}</div>`,
        ),
      );
      ctx.setSource(d.source);
    },
  },
  {
    id: "COT",
    name: "Commitments of traders",
    group: "Economics",
    needs: undefined,
    source: "CFTC Commitments of Traders, futures only, weekly",
    async render(ctx) {
      if (ctx.args[0]) {
        const d = await api.fn("cot", { market: ctx.args.join(" ") });
        if (!ctx.live()) return;
        ctx.setTitle(`${d.name}  ·  ${d.reportName} report`);
        ctx.el.innerHTML = "";
        ctx.el.append(
          links(
            html(
              `<div><a href="#" data-c="COT">← All markets</a>  <b class="amber">${esc(d.name)}</b>  <span class="dim">net contracts by trader group, last ${d.rows.length} weeks</span></div>`,
            ),
            ctx,
          ),
        );
        const host = html(`<div style="height:220px;margin:6px 0"></div>`);
        ctx.el.append(host);
        const asc = d.rows.slice().reverse();
        const chart = lineChart(
          host,
          d.groupNames.map((name, i) => ({
            title: `${name}, thousands`,
            color: css(COT_COLORS[i]),
            data: asc
              .filter((r) => fin(r.groups[i].net))
              .map((r) => ({ time: r.date, value: r.groups[i].net / 1000 })),
          })),
        );
        ctx.onCleanup(() => chart.remove());
        ctx.el.append(
          table(d.rows, [
            { key: "date", label: "Week to", left: true, lbl: true, fmt: day },
            ...d.groupNames.flatMap((name, i) => [
              {
                key: (r) => r.groups[i].net,
                label: `${name} net`,
                fmt: signed,
                cls,
              },
              {
                key: (r) => r.groups[i].chg,
                label: "Wk chg",
                fmt: signed,
                cls,
              },
            ]),
            { key: "oi", label: "Open interest", fmt: (v) => num(v, 0) },
          ]),
        );
        ctx.el.append(
          html(
            `<div class="hint" style="margin-top:6px">${esc(GROUP_WHAT[d.report])}</div>`,
          ),
        );
        ctx.setSource(d.source);
        return;
      }
      const d = await api.fn("cot");
      if (!ctx.live()) return;
      ctx.el.innerHTML = "";
      ctx.el.append(
        html(
          `<div style="margin-bottom:4px">Net = contracts held long minus short. Above zero, the group is positioned for prices to rise. Positions are as of Tuesday, published the following Friday. Click a market for its last year, or type <b class="amber">COT GOLD</b>.</div>`,
        ),
      );
      for (const s of d.sections) {
        ctx.el.append(sect(`${s.reportName} report`));
        ctx.el.append(
          table(
            s.rows,
            [
              { key: "name", label: "Market", left: true, lbl: true },
              ...s.groupNames.flatMap((name, i) => [
                {
                  key: (r) => r.groups?.[i]?.net,
                  label: `${name} net`,
                  fmt: signed,
                  cls,
                },
                {
                  key: (r) => r.groups?.[i]?.chg,
                  label: "Wk chg",
                  fmt: signed,
                  cls,
                },
              ]),
              { key: "oi", label: "Open interest", fmt: (v) => num(v, 0) },
              {
                key: "date",
                label: "Week to",
                left: true,
                fmt: (v, r) => (r.error ? r.error : day(v)),
              },
            ],
            { onRow: (r) => ctx.go(`COT ${r.key}`) },
          ),
        );
        ctx.el.append(
          html(`<div class="hint">${esc(GROUP_WHAT[s.report])}</div>`),
        );
      }
      ctx.setSource(d.source);
    },
  },
];
