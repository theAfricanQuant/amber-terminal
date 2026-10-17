// Equity tools: compare returns (COMP), the equity screener (EQS), your portfolio (PORT), dividends (DVD),
// earnings estimates (EE) and analyst ratings (ANR). The maths runs on the server (lib/fn/eq-*.js, eqs.js,
// dvd.js, ee.js, anr.js), so the numbers the tests check are the numbers on screen.
import { api, esc, px, pct, cls, big, num, date } from "../api.js";
import { table, kv, sect, tabs, html, lineChart } from "../ui.js";
import { toSecurity, YELLOW } from "../securities.js";

// Six line colours that read on black and don't look like the green and red of up and down.
export const PALETTE = [
  "#ffa028",
  "#5aaeff",
  "#e9e9e9",
  "#ff5ec8",
  "#3ee0c5",
  "#b48cff",
];
const COMP_RANGES = ["1M", "6M", "1Y", "5Y"];

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const usd = (v, d = 2) =>
  finite(v) ? `${v < 0 ? "-" : ""}$${num(Math.abs(v), d)}` : "—";
const usdChg = (v) =>
  finite(v) ? `${v > 0 ? "+" : v < 0 ? "-" : ""}$${num(Math.abs(v), 2)}` : "—";
const perc1 = (v) => (finite(v) ? `${v.toFixed(1)}%` : "—");
const setCmd = (ctx, c) => ctx.setCmd?.(c);
// Dividend amounts: cents unless the payment has fractions of a cent.
const divAmt = (v) => usd(v, finite(v) && Math.abs(v * 100 - Math.round(v * 100)) > 1e-9 ? 4 : 2);
const hint = (text) =>
  html(`<div class="hint" style="margin-top:6px">${text}</div>`);

// Split words into securities: each starts with a ticker and can take an exchange code and a yellow key,
// so "AAPL MSFT NVDA", "SPX INDEX NDX INDEX" and "VOD LN AAPL US EQUITY" all read the way you'd expect.
export function secGroups(words) {
  const groups = [];
  for (const w of words) {
    const g = groups.at(-1);
    if (g && !g.some((x) => YELLOW[x])) {
      if (YELLOW[w]) {
        g.push(w);
        continue;
      }
      if (g.length === 1 && toSecurity([g[0], w])?.exch === w) {
        g.push(w);
        continue;
      }
    }
    if (!YELLOW[w]) groups.push([w]);
  }
  return groups;
}

// ---------- COMP ----------
async function renderComp(ctx) {
  let range = ctx.args.find((a) => COMP_RANGES.includes(a)) || "1Y";
  const words = ctx.args.filter((a) => !COMP_RANGES.includes(a));
  const list = [];
  if (ctx.panel?.sec) list.push(ctx.panel.sec);
  for (const g of secGroups(words)) {
    const s = toSecurity(g);
    if (s) list.push(s);
  }
  const secs = list
    .filter((s, i) => list.findIndex((x) => x.id === s.id) === i)
    .slice(0, 6);
  ctx.el.innerHTML = "";
  if (!secs.length) {
    ctx.el.append(
      html(
        `<p class="para">Compare up to six securities, each rebased to 100 at the start of the range. Type <b class="amber">COMP AAPL MSFT NVDA</b>, or load a security first: <b class="amber">SPX INDEX COMP NDX INDEX</b>. Each security is a ticker, plus an exchange code or yellow key if it needs one (<b class="amber">VOD LN</b>, <b class="amber">GC1 COMDTY</b>, <b class="amber">BTC</b>). Add 1M, 6M, 1Y or 5Y for the range.</p>`,
      ),
    );
    ctx.setSource("Daily closes from the same sources as GP");
    return;
  }
  ctx.setTitle(secs.map((s) => s.ticker).join(" vs "));
  const bar = html(
    `<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"></div>`,
  );
  const box = html(
    `<div style="position:relative;height:58%;min-height:170px"></div>`,
  );
  const out = document.createElement("div");
  ctx.el.append(bar, box, out);
  let chart;
  ctx.onCleanup(() => chart?.remove());
  const draw = async () => {
    bar.innerHTML = "";
    bar.append(
      tabs(COMP_RANGES, range, (r) => {
        range = r;
        draw();
      }),
    );
    setCmd(ctx, `COMP ${secs.map((s) => s.raw).join(" ")} ${range}`);
    out.innerHTML = `<div class="loading">Loading ${secs.length} price histories</div>`;
    const d = await api.fn("eq-comp", {
      symbols: secs.map((s) => s.id).join(","),
      range,
    });
    if (!ctx.live()) return;
    const rows = d.series.map((s, i) => ({
      ...s,
      sec: secs[i],
      color: PALETTE[i],
    }));
    chart?.remove();
    box.innerHTML = "";
    chart = lineChart(
      box,
      rows
        .filter((r) => r.points)
        .map((r) => ({ color: r.color, title: r.sec.ticker, data: r.points })),
    );
    chart.chart.applyOptions({ timeScale: { lockVisibleTimeRangeOnResize: true } });
    out.innerHTML = "";
    out.append(
      table(
        rows,
        [
          {
            key: "color",
            label: "",
            html: true,
            fmt: (c) => `<span style="color:${c}">■</span>`,
          },
          { key: (r) => r.sec.raw, label: "Security", left: true, lbl: true },
          { key: (r) => r.sec.name || "", label: "Name", left: true },
          { key: "from", label: "From", fmt: (v) => (v ? date(v) : "—") },
          { key: "first", label: "Start", fmt: px },
          { key: "last", label: "Last", fmt: px },
          { key: "ret", label: "Price return", fmt: (v) => pct(v), cls },
          { key: "vol", label: "Volatility (yr)", fmt: perc1 },
          { key: "mdd", label: "Max drawdown", fmt: (v) => pct(v), cls },
          { key: "error", label: "", left: true, wrap: true, fmt: (v) => v || "", cls: () => "err" },
        ],
        { onRow: (r) => ctx.go(`${r.sec.raw} GP`) },
      ),
      hint(
        `Rebased to 100 on the first close on or after ${esc(date(d.start))}. Price return leaves out dividends. Volatility is the standard deviation of daily returns times √252 (√365 for crypto). Max drawdown is the worst fall from a high within the range. Click a row for its chart.`,
      ),
    );
    ctx.setSource(d.source);
  };
  await draw();
}

// ---------- EQS ----------
const fmtAmt = (v) => {
  if (!finite(v)) return "";
  const a = Math.abs(v);
  for (const [n, s] of [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ])
    if (a >= n) return `${+(v / n).toFixed(2)}${s}`;
  return String(v);
};
const EQS_FIELDS = [
  ["capMin", "Market cap from", "10B"],
  ["capMax", "to", "200B"],
  ["priceMin", "Price from", "5"],
  ["priceMax", "to", "500"],
  ["chgMin", "Day % from", "-5"],
  ["chgMax", "to", "5"],
  ["volMin", "Volume at least", "1M"],
];
const TEXT_SORTS = ["ticker", "name", "sector", "country"];
const EQS_COLS = [
  { key: "ticker", label: "Ticker", left: true, lbl: true },
  { key: "name", label: "Name", left: true, fmt: (v) => (v.length > 30 ? `${v.slice(0, 29)}…` : v) },
  { key: "price", label: "Price", fmt: px },
  { key: "changePct", label: "Day %", fmt: (v) => pct(v), cls },
  { key: "volume", label: "Volume", fmt: big },
  { key: "marketCap", label: "Mkt cap", fmt: big },
  { key: "sector", label: "Sector", left: true },
  { key: "country", label: "Country", left: true },
];

async function renderEqs(ctx) {
  let query = { preset: ctx.args.join(" ") };
  let filters = {};
  const form = html(`<form class="wform" autocomplete="off"></form>`);
  const info = html(`<div class="hint" style="margin:2px 0 4px"></div>`);
  const body = document.createElement("div");
  ctx.el.innerHTML = "";
  ctx.el.append(form, info, body);
  const opt = (list, cur, all) =>
    `<option value="">${all}</option>` +
    list
      .map(
        (x) =>
          `<option value="${esc(x.name)}"${x.name === cur ? " selected" : ""}>${esc(x.name)} (${x.n})</option>`,
      )
      .join("");
  // The form's fields as a query (no preset words: the form now holds what they set).
  const current = () => {
    const q = { sort: filters.sort, dir: filters.dir };
    for (const el of form.elements)
      if (el.name && el.value.trim()) q[el.name] = el.value.trim();
    return q;
  };
  const load = async () => {
    body.innerHTML = `<div class="loading">Screening</div>`;
    const d = await api.fn("eqs", query);
    if (!ctx.live()) return;
    filters = d.filters;
    form.innerHTML =
      `<select name="sector">${opt(d.sectors, filters.sector, "Any sector")}</select>` +
      `<select name="country">${opt(d.countries, filters.country, "Any country")}</select>` +
      EQS_FIELDS.map(
        ([k, label, ph]) =>
          `<span class="dim">${label}</span><input name="${k}" style="width:70px" placeholder="${ph}" value="${esc(fmtAmt(filters[k]))}">`,
      ).join("") +
      `<button type="submit">Screen</button><button type="button" data-reset>Clear</button>`;
    const sortName =
      EQS_COLS.find((c) => c.key === filters.sort)?.label || filters.sort;
    info.textContent = `${d.total.toLocaleString("en-US")} of ${d.universe.toLocaleString("en-US")} US stocks match.${d.total > d.rows.length ? ` Showing the first ${d.rows.length}.` : ""} Sorted by ${sortName}, ${filters.dir === "asc" ? "lowest" : "highest"} first. Click a heading to sort, a row to open DES.`;
    body.innerHTML = "";
    const t = table(d.rows, EQS_COLS, {
      onRow: (r) => ctx.go(`${r.ticker} US EQUITY DES`),
    });
    t.querySelectorAll("th").forEach((th, i) => {
      const k = EQS_COLS[i].key;
      th.style.cursor = "pointer";
      if (k === filters.sort)
        th.textContent += filters.dir === "asc" ? " ▲" : " ▼";
      th.onclick = () => {
        const dir =
          k === filters.sort
            ? filters.dir === "asc"
              ? "desc"
              : "asc"
            : TEXT_SORTS.includes(k)
              ? "asc"
              : "desc";
        query = { ...current(), sort: k, dir };
        load();
      };
    });
    body.append(t);
    ctx.setSource(d.source);
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    query = current();
    load();
  };
  form.onclick = (e) => {
    if (!e.target.matches("[data-reset]")) return;
    query = {};
    load();
  };
  await load();
}

// ---------- PORT ----------
const isNum = (w) => /^-?\d*\.?\d+$/.test(w);
const sameSec = (a, b) => {
  const x = toSecurity(a.split(" ")),
    y = toSecurity(b.split(" "));
  return x && y ? x.id === y.id : a === b;
};

// "ADD NVDA 10 120" or "DEL NVDA" -> { list, msg } or { error }. ADD replaces a holding already there.
export function editPort(list, op, words) {
  words = words.slice();
  if (op === "ADD") {
    const nums = [];
    while (words.length && isNum(words.at(-1)) && nums.length < 2)
      nums.unshift(Number(words.pop()));
    const sec = words.join(" ");
    if (!sec || !toSecurity(words))
      return {
        error:
          "Type PORT ADD, a security, the shares and the average cost: PORT ADD NVDA 10 120",
      };
    if (!nums.length || !nums[0])
      return {
        error: `How many? PORT ADD ${sec} 10 120 means 10 at an average cost of 120.`,
      };
    const [shares, cost = null] = nums;
    const next = list.filter((h) => !sameSec(h.sec, sec));
    next.push({ sec, shares, cost });
    return {
      list: next,
      msg: `${sec}: ${shares} at ${cost ?? "no cost given"}`,
    };
  }
  if (op === "DEL" || op === "REMOVE") {
    const sec = words.join(" ");
    const next = list.filter((h) => !sameSec(h.sec, sec));
    if (next.length === list.length)
      return { error: `${sec} isn't in the portfolio` };
    return { list: next, msg: `Removed ${sec}` };
  }
  return {
    error:
      "PORT ADD NVDA 10 120 adds or updates a holding, PORT DEL NVDA removes it, PORT IMPORT reads a CSV",
  };
}

// Imported holdings into the list: a security already there takes the imported numbers.
export const mergePort = (list, add) => [
  ...list.filter((h) => !add.some((a) => sameSec(a.sec, h.sec))),
  ...add,
];

// ---------- broker CSV import ----------
// Rows of cells from CSV text: quoted fields, commas inside quotes, CRLF, and tab or semicolon files.
export function csvRows(text) {
  const s = String(text ?? "");
  const head = s.split(/\r?\n/).slice(0, 12).join("\n");
  const count = (c) => head.split(c).length;
  const sep =
    count("\t") > count(",") ? "\t" : count(";") > count(",") ? ";" : ",";
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.map((r) => r.map((x) => x.trim()));
}

// "$1,234.50" -> 1234.5, "(12.00)" -> -12, "--" -> null.
export function csvNumber(v) {
  let t = String(v ?? "").trim();
  const neg = /^\(.*\)$/.test(t);
  t = t.replace(/^\(|\)$/g, "").replace(/[$£€,%\s+]|USD/gi, "");
  if (!/^-?\d*\.?\d+$/.test(t)) return null;
  return neg ? -Number(t) : Number(t);
}

const norm = (h) => String(h).toLowerCase().replace(/\s+/g, " ").trim();
const COLUMN = {
  symbol: (h) =>
    /^(symbol|ticker|ticker symbol|stock symbol|security symbol|instrument symbol|code)\b/.test(
      h,
    ),
  shares: (h) => /\b(qty|quantity|shares|units)\b/.test(h) || h === "position",
  unitCost: (h) =>
    /(avg|average)\.? (cost|price|cost basis|purchase price)|cost (basis )?per (share|unit)|cost\/share|price paid|cost price|unit cost|purchase price/.test(
      h,
    ),
  totalCost: (h) =>
    /^(cost basis|cost basis total|total cost|total cost basis|book cost|cost)$/.test(
      h.replace(/ \(.*\)$/, ""),
    ),
  currency: (h) => h === "currency",
};

// A broker's positions export -> holdings, plus what was skipped and why, for the preview.
export function parseHoldingsCsv(text) {
  const rows = csvRows(text);
  const find = (cells, test) => cells.findIndex((c) => test(norm(c)));
  const hi = rows.findIndex(
    (r) => find(r, COLUMN.symbol) >= 0 && find(r, COLUMN.shares) >= 0,
  );
  if (hi < 0)
    return {
      error:
        "Couldn't find a header row with a symbol column and a quantity column (like Symbol and Quantity).",
      holdings: [],
      skipped: [],
    };
  const h = rows[hi];
  const col = {
    symbol: find(h, COLUMN.symbol),
    shares: find(h, COLUMN.shares),
    unitCost: find(h, COLUMN.unitCost),
    totalCost: find(h, (x) => COLUMN.totalCost(x) && !COLUMN.unitCost(x)),
    currency: find(h, COLUMN.currency),
  };
  const lots = new Map();
  const skipped = [];
  rows.slice(hi + 1).forEach((r, i) => {
    const line = hi + i + 2;
    const raw = (r[col.symbol] || "").trim();
    // Blank lines, totals and the notes brokers add at the end have no symbol: not holdings.
    if (!raw) return;
    const why = (w) =>
      skipped.push({
        line,
        text: raw || r.filter(Boolean).slice(0, 3).join(" "),
        why: w,
      });
    // "SPAXX**" -> SPAXX; class shares "BRK B", "BRK.B", "BRK/B" -> BRK-B, the form the price feeds know.
    const sym = raw
      .toUpperCase()
      .replace(/\*+$/, "")
      .replace(/^([A-Z]{1,5})[ ./]([A-Z])$/, "$1-$2");
    if (!/^[A-Z0-9][A-Z0-9.\-/]{0,11}$/.test(sym))
      return why("Not a stock, fund or crypto ticker");
    const shares = csvNumber(r[col.shares]);
    if (!shares) return why("No quantity");
    const ccy = col.currency >= 0 ? (r[col.currency] || "").toUpperCase() : "";
    if (ccy && ccy !== "USD")
      return why(
        `Priced in ${ccy}: add it by hand with its exchange code, like PORT ADD VOD LN 1000 70`,
      );
    const unit = col.unitCost >= 0 ? csvNumber(r[col.unitCost]) : null;
    const total = col.totalCost >= 0 ? csvNumber(r[col.totalCost]) : null;
    const costTotal = unit != null ? unit * shares : total;
    // Several lots of one security become one holding at their average cost.
    const lot = lots.get(sym) || {
      sec: sym,
      shares: 0,
      costTotal: 0,
      costKnown: true,
    };
    lot.shares += shares;
    if (costTotal == null) lot.costKnown = false;
    else lot.costTotal += costTotal;
    lots.set(sym, lot);
  });
  const holdings = [...lots.values()].map((l) => ({
    sec: l.sec,
    shares: +l.shares.toFixed(8),
    cost: l.costKnown && l.shares ? +(l.costTotal / l.shares).toFixed(6) : null,
  }));
  return {
    holdings,
    skipped,
    columns: {
      symbol: h[col.symbol],
      shares: h[col.shares],
      cost:
        col.unitCost >= 0
          ? h[col.unitCost]
          : col.totalCost >= 0
            ? `${h[col.totalCost]} (a total, divided by the quantity)`
            : null,
    },
  };
}

const loadPort = async () => {
  const s = await api.get("/api/state");
  return Array.isArray(s?.amberPort) ? s.amberPort : [];
};
const savePort = (list) => api.put("/api/state", { amberPort: list });

async function renderPort(ctx) {
  let list = await loadPort().catch(() => []);
  if (!ctx.live()) return;
  const save = async (next, msg) => {
    try {
      await savePort(next);
    } catch (e) {
      ctx.toast(`Couldn't save the portfolio: ${e.message}`, true);
      return false;
    }
    list = next;
    ctx.toast(msg);
    return true;
  };
  const change = async (op, words) => {
    const r = editPort(list, op, words);
    if (r.error) {
      ctx.toast(r.error, true);
      return false;
    }
    return save(r.list, r.msg);
  };
  const op = ctx.args[0];
  if (op && op !== "IMPORT") {
    await change(op, ctx.args.slice(1));
    if (!ctx.live()) return;
  }
  // The edit is done: keep it out of the saved layout and Back, so it can't run twice.
  if (op) setCmd(ctx, "PORT");
  ctx.el.innerHTML = "";
  const form = html(
    `<form class="wform" autocomplete="off"><input class="sec" spellcheck="false" placeholder="Security: NVDA, VOD LN, BTC"><input style="width:80px" inputmode="decimal" placeholder="Shares"><input style="width:100px" inputmode="decimal" placeholder="Average cost"><button type="submit">Add or update</button><button type="button" data-import>Import CSV</button><span class="hint">PORT ADD NVDA 10 120, PORT DEL NVDA and PORT IMPORT work on the command line too.</span></form>`,
  );
  const box = document.createElement("div");
  const body = document.createElement("div");
  ctx.el.append(form, box, body);

  const load = async () => {
    if (!list.length) {
      body.innerHTML = "";
      body.append(
        html(
          `<p class="para">Type in what you hold: a security, the number of shares and your average cost, or import your broker's positions file. Stocks, ETFs, crypto, indices and non-US stocks all work. PORT values them at live prices, works out your profit and loss, and measures risk against the S&amp;P 500. These are your own numbers; nothing here is advice.</p>`,
        ),
      );
      ctx.setSource(
        "Your holdings are saved on this computer (data/state.json)",
      );
      return;
    }
    const d = await api.fn("eq-port");
    if (!ctx.live()) return;
    const t = d.totals;
    body.innerHTML = "";
    const holdings = table(
      d.holdings,
      [
        { key: "sec", label: "Security", left: true, lbl: true },
        { key: "shares", label: "Shares", fmt: (v) => num(v, v % 1 ? 4 : 0) },
        { key: "cost", label: "Avg cost", fmt: px },
        {
          key: "price",
          label: "Price",
          fmt: (v, r) =>
            `${px(v)}${r.currency && r.currency !== "USD" ? ` ${r.currency}` : ""}`,
        },
        { key: "changePct", label: "Day %", fmt: (v) => pct(v), cls },
        { key: "value", label: "Value $", fmt: (v) => usd(v) },
        { key: "pnl", label: "P&L $", fmt: usdChg, cls },
        { key: "pnlPct", label: "P&L %", fmt: (v) => pct(v), cls },
        { key: "dayChg", label: "Today $", fmt: usdChg, cls },
        { key: "weight", label: "Weight", fmt: perc1 },
        { key: "beta", label: "Beta", fmt: (v) => num(v, 2) },
        { key: "vol", label: "Vol (yr)", fmt: perc1 },
        { key: "sector", label: "Sector", left: true },
        {
          key: () => `<button class="xbtn" title="Remove">×</button>`,
          label: "",
          html: true,
        },
      ],
      { onRow: (r) => ctx.go(r.sec) },
    );
    // The remove button, caught before the row's click opens the security.
    holdings.addEventListener(
      "click",
      async (e) => {
        if (!e.target.closest(".xbtn")) return;
        e.stopPropagation();
        const r = d.holdings[+e.target.closest("tr").dataset.i];
        if (await change("DEL", r.sec.split(" "))) load();
      },
      true,
    );
    body.append(
      html(
        `<div style="font-size:14px;margin-bottom:6px">Value <b class="amber">${usd(t.value)}</b>  <span class="dim">cost</span> ${usd(t.cost)}  <span class="dim">P&amp;L</span> <span class="${cls(t.pnl)}">${usdChg(t.pnl)} ${pct(t.pnlPct)}</span>  <span class="dim">today</span> <span class="${cls(t.dayChg)}">${usdChg(t.dayChg)} ${pct(t.dayChgPct)}</span></div>`,
      ),
      holdings,
    );
    const cols = html(
      `<div class="cols" style="margin-top:8px"><div></div><div></div></div>`,
    );
    const [l, rt] = cols.children;
    l.append(
      sect("Risk, last year of daily returns"),
      kv([
        [
          `Beta vs ${d.market || "S&P 500"}`,
          finite(t.beta) ? num(t.beta, 2) : "—",
        ],
        ["Volatility (yr)", perc1(t.vol)],
        ["Holdings", String(d.holdings.length)],
      ]),
    );
    rt.append(
      sect("Sector mix"),
      table(d.sectors, [
        { key: "sector", label: "Sector", left: true, lbl: true },
        { key: "value", label: "Value $", fmt: (v) => usd(v, 0) },
        { key: "weight", label: "Weight", fmt: perc1 },
      ]),
    );
    body.append(
      cols,
      hint(
        `Beta is the covariance of a holding's daily returns with the S&amp;P 500's, over the variance of the S&amp;P's, on the days both traded; the portfolio's is the value-weighted average. Volatility is the standard deviation of daily returns times √252 (√365 for crypto). ${d.notes.map(esc).join(" ")}`,
      ),
    );
    ctx.setSource(d.source);
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const [s, n, c] = form.querySelectorAll("input");
    const words = [
      ...s.value.toUpperCase().trim().split(/\s+/),
      n.value.trim(),
      c.value.trim(),
    ].filter(Boolean);
    if (await change("ADD", words)) {
      form.reset();
      load();
    }
  };

  // Paste a broker export, see what was understood, then save it.
  const openImport = () => {
    box.innerHTML = "";
    const f = html(
      `<div style="border:1px solid var(--line);padding:6px;margin-bottom:8px"><div class="hint">Paste the positions export from your broker (Schwab, Fidelity, Interactive Brokers, Vanguard and most others), or choose the file. It needs a symbol column and a quantity column; an average cost or cost basis column gives you P&amp;L.</div><textarea spellcheck="false" style="width:100%;height:120px;margin:6px 0;background:#0d0d0d;color:var(--white);border:1px solid #333;font:12px var(--mono)"></textarea><div class="wform"><input type="file" accept=".csv,.txt,text/csv"><button type="button" data-read>Read it</button><button type="button" data-close>Cancel</button></div><div data-preview></div></div>`,
    );
    box.append(f);
    const ta = f.querySelector("textarea");
    const preview = f.querySelector("[data-preview]");
    f.querySelector("input[type=file]").onchange = async (e) => {
      const file = e.target.files?.[0];
      if (file) ta.value = await file.text();
    };
    f.onclick = async (e) => {
      if (e.target.matches("[data-close]")) box.innerHTML = "";
      if (e.target.matches("[data-read]")) {
        const r = parseHoldingsCsv(ta.value);
        preview.innerHTML = "";
        if (r.error)
          return preview.append(html(`<div class="err">${esc(r.error)}</div>`));
        preview.append(
          html(
            `<div class="hint">Read ${r.holdings.length} holding${r.holdings.length === 1 ? "" : "s"}. Symbol from "${esc(r.columns.symbol)}", shares from "${esc(r.columns.shares)}", cost ${r.columns.cost ? `from "${esc(r.columns.cost)}"` : "not found, so P&amp;L will be blank"}.</div>`,
          ),
          table(r.holdings, [
            { key: "sec", label: "Security", left: true, lbl: true },
            {
              key: "shares",
              label: "Shares",
              fmt: (v) => num(v, v % 1 ? 4 : 0),
            },
            { key: "cost", label: "Avg cost", fmt: px },
          ]),
        );
        if (r.skipped.length)
          preview.append(
            sect("Skipped"),
            table(r.skipped, [
              { key: "line", label: "Line", lbl: true },
              { key: "text", label: "Row", left: true },
              { key: "why", label: "Why", left: true, wrap: true },
            ]),
          );
        if (!r.holdings.length) return;
        const acts = html(
          `<div class="wform" style="margin-top:6px"><button type="button" data-replace>Save: replace my holdings</button><button type="button" data-merge>Save: add to my holdings</button></div>`,
        );
        preview.append(acts);
        acts.onclick = async (ev) => {
          const replace = ev.target.matches("[data-replace]");
          if (!replace && !ev.target.matches("[data-merge]")) return;
          const next = replace ? r.holdings : mergePort(list, r.holdings);
          if (await save(next, `Imported ${r.holdings.length} holdings`)) {
            box.innerHTML = "";
            load();
          }
        };
      }
    };
    ta.focus();
  };
  form.querySelector("[data-import]").onclick = openImport;
  if (op === "IMPORT") openImport();
  await load();
  ctx.every(60e3, load);
}

// ---------- DVD, EE, ANR ----------
async function renderDvd(ctx) {
  const d = await api.fn("dvd", { symbol: ctx.sec.id });
  if (!ctx.live()) return;
  ctx.el.innerHTML = "";
  const each =
    d.perYear && d.lastAmount != null ? `, ${divAmt(d.lastAmount)} a time` : "";
  ctx.el.append(
    html(
      `<div style="font-size:15px;margin-bottom:6px">Yield <b class="amber">${finite(d.yieldPct) ? `${d.yieldPct.toFixed(2)}%` : "—"}</b>  <span class="dim">${esc(d.frequency)}${each} · price</span> ${usd(d.price)}</div>`,
    ),
  );
  const cols = html(`<div class="cols"><div></div><div></div></div>`);
  const [l, r] = cols.children;
  l.append(
    sect("Next"),
    kv([
      ["Next ex-date", d.nextExDate || "Not announced yet"],
      ["Amount", d.nextAmount != null ? divAmt(d.nextAmount) : null],
      ["Payment date", d.nextPayDate],
      ["Last ex-date", d.lastExDate || "—"],
    ]),
  );
  r.append(
    sect("Yield"),
    kv([
      [
        "Indicated annual dividend",
        d.indicatedAnnual != null ? divAmt(d.indicatedAnnual) : "—",
      ],
      [
        "Indicated yield",
        finite(d.yieldPct) ? `${d.yieldPct.toFixed(2)}%` : "—",
      ],
      [
        "Paid in the last 12 months",
        d.trailing12m != null ? divAmt(d.trailing12m) : "—",
      ],
      [
        "Trailing yield",
        finite(d.trailingYieldPct) ? `${d.trailingYieldPct.toFixed(2)}%` : "—",
      ],
      ["Payments a year", d.perYear ? String(d.perYear) : "—"],
    ]),
  );
  ctx.el.append(
    cols,
    sect("History"),
    d.history.length
      ? table(d.history, [
          { key: "exDate", label: "Ex-date", left: true, lbl: true },
          { key: "amount", label: "Amount", fmt: divAmt },
          { key: "type", label: "Type", left: true },
          { key: "declared", label: "Declared", left: true },
          { key: "record", label: "Record", left: true },
          { key: "paid", label: "Paid", left: true },
        ])
      : html(`<p class="hint">No dividends on record.</p>`),
    hint(
      "Indicated annual dividend is the latest regular dividend times the payments a year; indicated yield is that over the live price.",
    ),
  );
  ctx.setSource(d.source);
}

const epsCols = [
  { key: "period", label: "Period", left: true, lbl: true },
  { key: "consensus", label: "Consensus EPS", fmt: (v) => num(v, 2) },
  { key: "low", label: "Low", fmt: (v) => num(v, 2) },
  { key: "high", label: "High", fmt: (v) => num(v, 2) },
  { key: "estimates", label: "Analysts", fmt: (v) => num(v, 0) },
  { key: "up", label: "Revised up (4 wk)", fmt: (v) => num(v, 0) },
  { key: "down", label: "Revised down (4 wk)", fmt: (v) => num(v, 0) },
];

async function renderEe(ctx) {
  const d = await api.fn("ee", { symbol: ctx.sec.id });
  if (!ctx.live()) return;
  ctx.el.innerHTML = "";
  if (d.nextReport)
    ctx.el.append(
      html(
        `<div style="font-size:14px;margin-bottom:4px" class="amber">${esc(d.nextReport.replace(/\*/g, ""))}</div>`,
      ),
    );
  if (d.note)
    ctx.el.append(
      html(
        `<p class="para dim">${esc(d.note.replace(/\s+/g, " ").replace(/\*/g, ""))}</p>`,
      ),
    );
  if (d.quarterly.length)
    ctx.el.append(sect("Quarterly consensus"), table(d.quarterly, epsCols));
  if (d.yearly.length)
    ctx.el.append(sect("Fiscal year consensus"), table(d.yearly, epsCols));
  if (d.surprises.length)
    ctx.el.append(
      sect("Last reports against the forecast"),
      table(d.surprises, [
        { key: "period", label: "Quarter", left: true, lbl: true },
        { key: "reported", label: "Reported", left: true },
        { key: "eps", label: "EPS", fmt: (v) => num(v, 2) },
        { key: "consensus", label: "Forecast", fmt: (v) => num(v, 2) },
        { key: "surprisePct", label: "Surprise", fmt: (v) => pct(v), cls },
        {
          key: "beat",
          label: "",
          left: true,
          cls: (v) => (v === "Beat" ? "up" : v === "Missed" ? "down" : ""),
        },
      ]),
    );
  ctx.setSource(d.source);
}

async function renderAnr(ctx) {
  const d = await api.fn("anr", { symbol: ctx.sec.id });
  if (!ctx.live()) return;
  ctx.el.innerHTML = "";
  const share = (n) => (d.analysts ? (n / d.analysts) * 100 : 0);
  ctx.el.append(
    html(
      `<div style="font-size:15px;margin-bottom:6px">Consensus <b class="amber">${esc(d.consensus || "—")}</b>  <span class="dim">from ${d.analysts ?? "—"} analysts ·</span> <span class="up">${d.buy ?? "—"} buy</span> · ${d.hold ?? "—"} hold · <span class="down">${d.sell ?? "—"} sell</span></div>`,
    ),
    html(
      `<div style="display:flex;height:8px;margin-bottom:8px"><div style="width:${share(d.buy)}%;background:var(--up)"></div><div style="width:${share(d.hold)}%;background:var(--amber-dim)"></div><div style="width:${share(d.sell)}%;background:var(--down)"></div></div>`,
    ),
  );
  const cols = html(`<div class="cols"><div></div><div></div></div>`);
  const [l, r] = cols.children;
  l.append(
    sect("12-month price target"),
    kv([
      ["Mean", usd(d.mean)],
      ["Low", usd(d.low)],
      ["High", usd(d.high)],
      ["Live price", usd(d.price)],
      ["Mean target vs price", pct(d.upsidePct)],
    ]),
  );
  r.append(
    sect("Firms covering it"),
    html(`<p class="para">${esc(d.firms.join(", ") || "—")}</p>`),
  );
  ctx.el.append(
    cols,
    sect("Month by month, as of the 1st"),
    table(d.history.slice().reverse(), [
      { key: "date", label: "Month", left: true, lbl: true },
      { key: "buy", label: "Buy", fmt: (v) => num(v, 0) },
      { key: "hold", label: "Hold", fmt: (v) => num(v, 0) },
      { key: "sell", label: "Sell", fmt: (v) => num(v, 0) },
      { key: "consensus", label: "Consensus", left: true },
      { key: "meanTarget", label: "Mean target", fmt: (v) => usd(v) },
    ]),
    hint(
      "Counts and targets are the consensus Nasdaq publishes. Each analyst's own rating and target is paid data.",
    ),
  );
  ctx.setSource(d.source);
}

export default [
  {
    id: "COMP",
    name: "Compare returns",
    group: "Charts",
    source:
      "Daily closes from the same sources as GP; price return, volatility and drawdown worked out here",
    render: renderComp,
  },
  {
    id: "EQS",
    name: "Equity screener",
    group: "Equities",
    source:
      "Nasdaq stock screener (every US-listed stock; the 200 largest live, the rest last close)",
    render: renderEqs,
  },
  {
    id: "PORT",
    name: "Portfolio",
    group: "Workspace",
    source:
      "Your holdings, valued at live prices (Nasdaq, crypto exchanges, Yahoo); beta against the S&P 500",
    render: renderPort,
  },
  {
    id: "DVD",
    name: "Dividends",
    group: "Equities",
    needs: true,
    source:
      "Nasdaq dividend history (Nasdaq-listed), Yahoo dividend events (NYSE and others), live price from Nasdaq",
    render: renderDvd,
  },
  {
    id: "EE",
    name: "Earnings estimates",
    group: "Equities",
    needs: true,
    source:
      "Zacks consensus EPS estimates and surprises, published free by Nasdaq, updated daily",
    render: renderEe,
  },
  {
    id: "ANR",
    name: "Analyst ratings",
    group: "Equities",
    needs: true,
    source:
      "Analyst buy, hold and sell counts and price targets (Zacks consensus via Nasdaq), updated daily",
    render: renderAnr,
  },
];
