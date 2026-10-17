// DS: full-text search of SEC filings. SURP: US economic surprises and how the market took them.
import { api, esc, num, pct, cls } from "../api.js";
import { table, kv, sect, tabs, html } from "../ui.js";

const FORM_TABS = ["ALL", "10-K", "10-Q", "8-K"];
const RANGE_TABS = { "30 days": "30D", "1 year": "1Y", "5 years": "5Y" };
const EVERY = "Every company";

const link = (url, text) =>
  `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const clip = (n) => (v) => {
  const t = String(v || "");
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const day = (d) =>
  d
    ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";

// The command line hands a market-wide function no security, so DS reads the panel's: it searches within a
// US company only when this command named one ("AAPL US EQUITY DS tariff"). A plain "DS tariff" searches
// every company, whatever the panel showed before.
export function companyFor(panel, named) {
  const sec = named ? panel?.sec || null : null;
  return sec && sec.sector === "EQUITY" && (!sec.exch || sec.exch === "US")
    ? sec
    : null;
}

// The matched words, lit up in a passage.
function mark(text, query) {
  const terms = [...String(query).matchAll(/"([^"]+)"|(\S+)/g)]
    .map((m) => m[1] || m[2])
    .filter((t) => t && !/^(OR|AND|NOT)$/.test(t) && !t.startsWith("-"))
    .map((t) =>
      t
        .split(" ")
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+"),
    );
  const safe = esc(text);
  if (!terms.length) return safe;
  return safe.replace(
    new RegExp(`\\b(${terms.join("|")})`, "gi"),
    '<span class="amber">$1</span>',
  );
}

const signed = (v, dp, unit = "") =>
  typeof v === "number" && Number.isFinite(v)
    ? `${v > 0 ? "+" : ""}${v.toFixed(dp)}${unit}`
    : "—";
const surpriseText = (v, r) => signed(v, r.dp, r.unit);
const sdText = (v) => (v == null ? "—" : `${signed(v, 1)} sd`);
const bp = (v) => (v == null ? "—" : `${signed(v, 1)} bp`);
const moved = (fmt) => (v, r) =>
  r.partial && v != null ? `${fmt(v)} so far` : fmt(v);

const marketCols = [
  {
    key: "spx",
    label: "S&P 500",
    fmt: moved((v) => pct(v)),
    cls: (v, r) => (r.partial ? "dim" : cls(v)),
  },
  {
    key: "us10y",
    label: "10-year",
    fmt: moved(bp),
    cls: (v, r) => (r.partial ? "dim" : cls(v)),
  },
  {
    key: "eurusd",
    label: "EURUSD",
    fmt: moved((v) => pct(v)),
    cls: (v, r) => (r.partial ? "dim" : cls(v)),
  },
];

export default [
  {
    id: "DS",
    name: "Document search",
    group: "Equities",
    source: "SEC EDGAR full-text search, every filing since 2001",
    async render(ctx) {
      const sec = companyFor(ctx.panel, ctx.named);
      const d = await api.fn("ds", { q: ctx.args.join(" "), symbol: sec?.id });
      if (!ctx.live()) return;
      const prefix = sec ? `${sec.raw} ` : "";
      const words = d.query.toUpperCase();
      const cmd = (form, range, scoped = !!sec) =>
        `${scoped ? prefix : ""}DS ${words}${form === "ALL" ? "" : ` ${form}`}${range === "1Y" ? "" : ` ${range}`}`;
      // So a reload or Back runs the same search, company included.
      if (sec) ctx.setCmd(cmd(d.form, d.range));
      ctx.setTitle(
        sec
          ? `${d.company.name}  ·  ${sec.raw}`
          : `Every company  ·  ${d.query}`,
      );
      ctx.el.innerHTML = "";
      ctx.el.append(tabs(FORM_TABS, d.form, (f) => ctx.go(cmd(f, d.range))));
      const rangeName = Object.keys(RANGE_TABS).find(
        (k) => RANGE_TABS[k] === d.range,
      );
      ctx.el.append(
        tabs(Object.keys(RANGE_TABS), rangeName, (k) =>
          ctx.go(cmd(d.form, RANGE_TABS[k])),
        ),
      );
      if (sec)
        ctx.el.append(
          tabs(
            [`Only ${sec.ticker}`, EVERY],
            `Only ${sec.ticker}`,
            (t) => t === EVERY && ctx.go(cmd(d.form, d.range, false)),
          ),
        );

      const where = `${d.form === "ALL" ? "filings" : `${d.form} filings`}${d.company ? ` by ${d.company.name}` : ""}, ${day(d.from)} to ${day(d.to)}`;
      if (!d.rows.length) {
        ctx.el.append(
          html(
            `<div class="hint">Nothing in ${esc(where)} mentions ${esc(d.query)}. Try a longer date range or every form.</div>`,
          ),
        );
        ctx.setSource(d.source);
        return;
      }
      const total = `${num(d.total, 0)}${d.totalIsFloor ? "+" : ""}`;
      ctx.el.append(
        html(
          `<div class="hint">${total} documents mention ${esc(d.query)} in ${esc(where)}. The ${d.rows.length} best-matching filings are below, newest first. Click one to see the sentences that match. ${link(d.searchUrl, "Same search on sec.gov")}</div>`,
        ),
      );
      const cols = [
        { key: "filed", label: "Filed", left: true, lbl: true },
        { key: "company", label: "Company", left: true, fmt: clip(34) },
        { key: "ticker", label: "Ticker", left: true, fmt: (v) => v || "" },
        { key: "form", label: "Form", left: true },
        {
          key: "document",
          label: "Document",
          left: true,
          fmt: (v, r) => (r.title ? `${v}: ${clip(30)(r.title)}` : v),
          cls: () => "dim",
        },
        {
          key: "url",
          label: "",
          left: true,
          html: true,
          fmt: (u) => link(u, "Open"),
        },
      ];
      const t = table(d.rows, cols, { onRow: (r) => show(r) });
      ctx.el.append(t);
      ctx.setSource(d.source);

      // The matching sentences, read from the document itself, in a row under the filing.
      async function show(r) {
        const tr = t.querySelector(`tr[data-i="${d.rows.indexOf(r)}"]`);
        const open = tr?.nextElementSibling?.dataset.sub === "1";
        if (open) return tr.nextElementSibling.remove();
        const sub = html(
          `<table><tr data-sub="1"><td colspan="${cols.length}" class="l wrap dim">Reading the document…</td></tr></table>`,
        ).querySelector("tr");
        tr.after(sub);
        const cell = sub.firstElementChild;
        try {
          const p = await api.fn("ds", { q: d.query, doc: r.url });
          if (!ctx.live()) return;
          cell.className = "l wrap";
          cell.innerHTML = p.passages.length
            ? `${p.passages.map((s) => `<p class="para">${mark(s, d.query)}</p>`).join("")}<div class="hint">${num(p.matches, 0)} match${p.matches === 1 ? "" : "es"} in this document.</div>`
            : `<div class="hint">${esc(p.note || "The words are in this filing, but not in its main text (often a table or an attachment). Open it to read.")}</div>`;
        } catch (e) {
          if (ctx.live()) cell.textContent = e.message;
        }
      }
    },
  },
  {
    id: "SURP",
    name: "Economic surprises",
    group: "Economics",
    source:
      "Nasdaq economic calendar for the releases, Yahoo Finance daily closes for the market moves",
    async render(ctx) {
      const d = await api.fn("surp");
      if (!ctx.live()) return;
      const want = ctx.args[0];
      ctx.el.innerHTML = "";
      const valueCols = [
        { key: "actual", label: "Actual", cls: () => "amber" },
        { key: "consensus", label: "Survey" },
        { key: "previous", label: "Prior", cls: () => "dim" },
        { key: "surprise", label: "Surprise", fmt: surpriseText, cls },
        { key: "z", label: "In sd", fmt: sdText, cls },
      ];

      if (!want) {
        const rows = d.rows.filter((r) => r.day >= d.from);
        ctx.el.append(
          html(
            `<div class="hint">US releases since ${esc(day(d.from))}. Surprise is actual minus survey. The market columns are close to close on the release day. Click a release for its history.</div>`,
          ),
          table(
            rows,
            [
              { key: "day", label: "Date", left: true, lbl: true, fmt: day },
              { key: "name", label: "Release", left: true },
              ...valueCols,
              ...marketCols,
            ],
            { onRow: (r) => ctx.go(`SURP ${r.id}`) },
          ),
          html(
            `<div class="hint">In sd is the surprise in standard deviations of that release's past surprises. It shows once four or more are logged. Your log holds ${num(d.loggedDays, 0)} days since ${esc(day(d.firstLogged))}, saved in the data folder as eco-log.json, and grows each day you open SURP.</div>`,
          ),
        );
        if (!rows.length)
          ctx.el.prepend(
            html(
              `<div class="hint">No main US releases in the last 60 days.</div>`,
            ),
          );
        ctx.setSource(d.source);
        return;
      }

      const rows = d.rows.filter((r) => r.id === want);
      if (!rows.length)
        throw new Error(
          `No release called ${want} in the log. Type SURP and click a row.`,
        );
      const name = rows[0].name;
      ctx.setTitle(name);
      ctx.el.append(
        tabs(["All releases", name], name, (t) => t !== name && ctx.go("SURP")),
      );
      // How the S&P took it, split by which way the number surprised.
      const done = rows.filter((r) => !r.partial && r.spx != null);
      const avg = (xs) =>
        xs.length ? xs.reduce((a, r) => a + r.spx, 0) / xs.length : null;
      const above = done.filter((r) => r.surprise > 0);
      const below = done.filter((r) => r.surprise < 0);
      const inline = done.filter((r) => r.surprise === 0);
      const line = (xs) =>
        xs.length
          ? `${pct(avg(xs))} on average (${xs.length} release${xs.length > 1 ? "s" : ""})`
          : "none logged yet";
      ctx.el.append(
        sect(`S&P 500 on the day`),
        kv([
          ["Above survey", line(above)],
          ["In line", line(inline)],
          ["Below survey", line(below)],
        ]),
        sect("Every release in your log"),
        table(rows, [
          { key: "day", label: "Date", left: true, lbl: true, fmt: day },
          ...valueCols,
          ...marketCols,
        ]),
        html(
          `<div class="hint">The log starts ${esc(day(d.firstLogged))} and adds every release from then on, so these averages firm up over the months.</div>`,
        ),
      );
      ctx.setSource(d.source);
    },
  },
];
