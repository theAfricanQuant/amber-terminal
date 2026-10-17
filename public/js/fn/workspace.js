// Workspace: W, your own watchlist monitor (a Launchpad monitor), and ALRT, price alerts that fire from the server.
// The list lives in the server state (GET/PUT /api/state, key amberWatch); alerts use the engine in lib/alerts.js.
import { api, esc, px, pct, chg, cls } from "../api.js";
import { table, sect, html } from "../ui.js";
import { toSecurity, bbgCode, yahooSymbol, lookupList } from "../securities.js";

export const DEFAULT_WATCH = [
  "SPX INDEX",
  "NDX INDEX",
  "AAPL US EQUITY",
  "NVDA US EQUITY",
  "MSFT US EQUITY",
  "BTC CRYPTO",
  "GC1 COMDTY",
  "EURUSD CURNCY",
];
const DEFAULT_NAMES = {
  "AAPL US EQUITY": "Apple Inc.",
  "NVDA US EQUITY": "NVIDIA Corporation",
  "MSFT US EQUITY": "Microsoft Corporation",
  "BTC CRYPTO": "Bitcoin",
  "EURUSD CURNCY": "Euro in US dollars",
};
const MAX = 60;
const words = (s) =>
  String(s || "")
    .toUpperCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
const secOf = (code) => toSecurity(words(code));

// W ADD NVDA, W ADD VOD LN, W DEL NVDA. Returns { list, code, msg } or { list (unchanged), error }.
export function editWatch(list, op, ws) {
  const verb = {
    ADD: "ADD",
    "+": "ADD",
    DEL: "DEL",
    DELETE: "DEL",
    REMOVE: "DEL",
    RM: "DEL",
    "-": "DEL",
  }[String(op || "").toUpperCase()];
  if (!verb)
    return {
      list,
      error: "Use W ADD or W DEL with a security, for example W ADD NVDA.",
    };
  const sec = ws?.length
    ? toSecurity(ws.map((w) => String(w).toUpperCase()))
    : null;
  if (!sec)
    return {
      list,
      error: `Type a security after ${verb}, for example W ${verb} NVDA or W ${verb} VOD LN.`,
    };
  let code = bbgCode(sec);
  if (verb === "ADD") {
    if (list.includes(code))
      return { list, code, msg: `${code} is already on the list` };
    if (list.length >= MAX)
      return {
        list,
        error: `The list holds ${MAX} securities. Take one off first.`,
      };
    return { list: [...list, code], code, msg: `Added ${code}` };
  }
  if (!list.includes(code)) {
    // "W DEL VOD" when only VOD LN EQUITY is on the list.
    const same = list.filter((c) => c.split(" ")[0] === code.split(" ")[0]);
    if (same.length !== 1)
      return { list, code, error: `${code} isn't on the list` };
    code = same[0];
  }
  return { list: list.filter((c) => c !== code), code, msg: `Removed ${code}` };
}

// One monitor row per security: Yahoo's board (last, change, YTD, 52 weeks, 30 days), with crypto's last
// price and 24-hour change from the live exchange quote.
export function watchRows(list, board = {}, quotes = {}, names = {}) {
  return list.map((code) => {
    const sec = secOf(code);
    const y = (sec && board[yahooSymbol(sec)]) || {};
    const row = {
      code,
      sector: sec?.sector,
      name: names[code] || sec?.name || "",
      price: y.price,
      change: y.change,
      changePct: y.changePct,
      ytdPct: y.ytdPct,
      low52: y.low52,
      high52: y.high52,
      spark: y.spark,
    };
    const q = sec?.sector === "CRYPTO" ? quotes[`BINANCE:${sec.id}`] : null;
    if (Number.isFinite(q?.price) && q.price > 0) {
      row.price = q.price;
      if (Number.isFinite(q.changePct)) {
        row.changePct = q.changePct;
        row.change = q.price - q.price / (1 + q.changePct / 100);
      }
      if (Number.isFinite(row.low52)) row.low52 = Math.min(row.low52, q.price);
      if (Number.isFinite(row.high52))
        row.high52 = Math.max(row.high52, q.price);
    }
    return row;
  });
}

const spark = (vals) => {
  if (!vals?.length || vals.length < 2) return "";
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
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" style="stroke:var(${vals.at(-1) >= vals[0] ? "--up" : "--down"})" stroke-width="1.2" points="${pts}"/></svg>`;
};

async function loadWatch() {
  const st = await api.get("/api/state").catch(() => null);
  const w = st?.amberWatch || {};
  return {
    lists: w.lists || {},
    list: Array.isArray(w.lists?.MAIN) ? w.lists.MAIN : DEFAULT_WATCH.slice(),
    names: { ...DEFAULT_NAMES, ...(w.names || {}) },
  };
}
const saveWatch = (s) =>
  api.put("/api/state", {
    amberWatch: { lists: { ...s.lists, MAIN: s.list }, names: s.names },
  });

// A company's name for a new row, from the same search the command line's lookup uses.
async function nameFor(code) {
  const sec = secOf(code);
  if (!sec || sec.name) return sec?.name || "";
  try {
    const res = await api.get(
      `/api/search?q=${encodeURIComponent(sec.ticker)}`,
    );
    return (
      lookupList(res, sec.ticker, 30).find((r) => r.code === code)?.name || ""
    );
  } catch {
    return "";
  }
}

// ---------- alerts ----------
// "ALRT BTC ABOVE 70000" -> { words: ["BTC"], dir: "above", level: "70000" }
export function alertArgs(args) {
  const i = args.findIndex((a) => /^(ABOVE|BELOW|>|<|>=|<=)$/i.test(a));
  if (i < 1) return null;
  return {
    words: args.slice(0, i),
    dir: /^(ABOVE|>|>=)$/i.test(args[i]) ? "above" : "below",
    level: args[i + 1],
  };
}

// A price alert in the engine's rule format (Quant Terminal's): it fires once, the first time the last
// 1-minute close is at or beyond the level.
export function alertRule(ws, dir, level) {
  const sec = ws?.length
    ? toSecurity(ws.map((w) => String(w).toUpperCase()))
    : null;
  if (!sec)
    return { error: "Type a security, for example BTC or AAPL US EQUITY." };
  const d = String(dir || "").toLowerCase();
  if (d !== "above" && d !== "below") return { error: "Pick above or below." };
  const n = Number(
    String(level ?? "")
      .replace(/,/g, "")
      .trim(),
  );
  if (!String(level ?? "").trim() || !Number.isFinite(n))
    return { error: "Type a price level, for example 70000." };
  const code = bbgCode(sec);
  return {
    code,
    rule: {
      symbol: sec.id,
      tf: "1m",
      left: "close",
      op: d === "above" ? ">=" : "<=",
      right: n,
      trigger: "once",
      message: `${code} ${d} ${n}`,
    },
  };
}

const OP_WORDS = {
  ">": "above",
  ">=": "above",
  "<": "below",
  "<=": "below",
  crossesAbove: "crosses above",
  crossesBelow: "crosses below",
  crosses: "crosses",
};
export const alertText = (a) =>
  a.message || `${a.symbol} ${OP_WORDS[a.op] || a.op} ${a.right}`;
const when = (t) =>
  t
    ? new Date(t).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
export function alertStatus(a) {
  if (a.active && a.error) return `Error: ${a.error}`;
  if (a.active) return "Watching";
  if (a.fired) return `Fired ${when(a.lastFiredAt)}`;
  return "Off";
}

async function askNotify() {
  try {
    if (window.Notification?.permission === "default")
      await Notification.requestPermission();
  } catch {}
}

async function createAlert(ctx, ws, dir, level) {
  const r = alertRule(ws, dir, level);
  if (r.error) return (ctx.toast(r.error, true), false);
  askNotify();
  try {
    await api.post("/api/alerts", r.rule);
  } catch (e) {
    return (ctx.toast(`Couldn't create the alert: ${e.message}`, true), false);
  }
  ctx.toast(`Alert set: ${r.rule.message}`);
  // Check straight away, so a level that's already passed fires now rather than in 15 seconds.
  api.post("/api/alerts/check").catch(() => {});
  return true;
}

export default [
  {
    id: "W",
    name: "Watchlist monitor",
    group: "Workspace",
    source:
      "Yahoo Finance prices (some exchanges delayed 15 minutes), crypto live from Binance. Your list is saved on this computer",
    async render(ctx) {
      const st = await loadWatch();
      if (ctx.args.length) {
        const r = editWatch(st.list, ctx.args[0], ctx.args.slice(1));
        if (r.error) ctx.toast(r.error, true);
        else if (r.list !== st.list) {
          st.list = r.list;
          if (r.msg.startsWith("Added") && !st.names[r.code])
            st.names[r.code] = await nameFor(r.code);
          await saveWatch(st).catch((e) =>
            ctx.toast(`Couldn't save the list: ${e.message}`, true),
          );
          ctx.toast(r.msg);
        } else ctx.toast(r.msg);
        ctx.setCmd("W");
      }
      if (!ctx.live()) return;
      ctx.setTitle("Main list");
      ctx.el.innerHTML = "";
      const form = html(
        `<form class="wform" autocomplete="off"><input class="sec" spellcheck="false" placeholder="Add: NVDA, VOD LN, BTC, GC1 COMDTY"><button type="submit">Add</button><span class="hint">Click a row to open it.</span></form>`,
      );
      const body = document.createElement("div");
      ctx.el.append(form, body);

      const edit = async (op, ws) => {
        const r = editWatch(st.list, op, ws);
        if (r.error) return ctx.toast(r.error, true);
        if (r.list === st.list) return ctx.toast(r.msg);
        st.list = r.list;
        if (op === "ADD" && !st.names[r.code])
          st.names[r.code] = await nameFor(r.code);
        try {
          await saveWatch(st);
        } catch (e) {
          return ctx.toast(`Couldn't save the list: ${e.message}`, true);
        }
        ctx.toast(r.msg);
        load();
      };
      form.onsubmit = (e) => {
        e.preventDefault();
        const input = form.querySelector("input");
        const ws = words(input.value);
        input.value = "";
        if (ws.length) edit("ADD", ws);
      };
      body.addEventListener(
        "click",
        (e) => {
          const b = e.target.closest("[data-del]");
          if (!b) return;
          e.stopPropagation();
          edit("DEL", words(b.dataset.del));
        },
        true,
      );

      const cols = [
        { key: "code", label: "Security", left: true, lbl: true },
        {
          key: "name",
          label: "Name",
          left: true,
          fmt: (v) => String(v || "").slice(0, 24),
        },
        { key: "price", label: "Last", fmt: px },
        { key: "change", label: "Net chg", fmt: (v) => chg(v), cls },
        { key: "changePct", label: "% chg", fmt: (v) => pct(v), cls },
        { key: "ytdPct", label: "YTD %", fmt: (v) => pct(v), cls },
        { key: "low52", label: "52w low", fmt: px },
        { key: "high52", label: "52w high", fmt: px },
        { key: "spark", label: "30 days", html: true, fmt: spark },
        {
          key: "code",
          label: "",
          html: true,
          fmt: (v) =>
            `<button class="xbtn" data-del="${esc(v)}" title="Take ${esc(v)} off the list">×</button>`,
        },
      ];
      const load = async () => {
        const secs = st.list.map(secOf).filter(Boolean);
        const ys = [...new Set(secs.map(yahooSymbol).filter(Boolean))];
        const crypto = secs
          .filter((s) => s.sector === "CRYPTO")
          .map((s) => s.id);
        const [b, q] = await Promise.all([
          ys.length
            ? api
                .fn("board", { symbols: ys.join(",") })
                .catch(() => ({ rows: {} }))
            : { rows: {} },
          crypto.length ? api.quotes(crypto).catch(() => ({})) : {},
        ]);
        if (!ctx.live()) return;
        const top = ctx.el.scrollTop;
        body.innerHTML = "";
        body.append(sect(`Main list, ${st.list.length} securities`));
        if (!st.list.length)
          body.append(
            html(
              `<div class="hint">The list is empty. Add a security above, or type W ADD NVDA.</div>`,
            ),
          );
        else
          body.append(
            table(watchRows(st.list, b.rows, q, st.names), cols, {
              onRow: (r) =>
                ctx.go(`${r.code} ${r.sector === "EQUITY" ? "DES" : "GP"}`),
            }),
          );
        ctx.el.scrollTop = top;
        ctx.setSource(
          `Yahoo Finance prices (some exchanges delayed 15 minutes)${crypto.length ? ", crypto live from Binance" : ""}`,
        );
      };
      await load();
      ctx.every(30e3, () => load().catch(() => {}));
    },
  },
  {
    id: "ALRT",
    name: "Alerts",
    group: "Workspace",
    source:
      "The alert engine on this computer: 1-minute closes every 15 seconds, from Binance for crypto and Yahoo Finance for the rest",
    async render(ctx) {
      const a = alertArgs(ctx.args);
      if (a) await createAlert(ctx, a.words, a.dir, a.level);
      else if (ctx.args.length)
        ctx.toast("Try ALRT BTC ABOVE 70000, or use the form.", true);
      if (ctx.args.length) ctx.setCmd("ALRT");
      if (!ctx.live()) return;
      ctx.el.innerHTML = "";
      const form = html(
        `<form class="wform" autocomplete="off"><input class="sec" spellcheck="false" placeholder="Security: BTC, AAPL, SPX INDEX" value="${esc(a ? a.words.join(" ") : "")}"><select><option value="above">above</option><option value="below">below</option></select><input class="lvl" inputmode="decimal" placeholder="Level"><button type="submit">Create alert</button></form>`,
      );
      const body = document.createElement("div");
      ctx.el.append(
        form,
        html(
          `<p class="hint">An alert fires once, the first time the price is at or past your level. You'll get a pop-up here and a desktop notification, as long as the app is running.</p>`,
        ),
        body,
      );
      form.onsubmit = async (e) => {
        e.preventDefault();
        const [sec, lvl] = form.querySelectorAll("input");
        if (
          await createAlert(
            ctx,
            words(sec.value),
            form.querySelector("select").value,
            lvl.value,
          )
        ) {
          lvl.value = "";
          load();
        }
      };
      body.addEventListener(
        "click",
        async (e) => {
          const b = e.target.closest("[data-del]");
          if (!b) return;
          e.stopPropagation();
          try {
            await api.del(`/api/alerts/${encodeURIComponent(b.dataset.del)}`);
          } catch (err) {
            ctx.toast(`Couldn't delete the alert: ${err.message}`, true);
          }
          load();
        },
        true,
      );
      const load = async () => {
        const [list, log] = await Promise.all([
          api.get("/api/alerts"),
          api.get("/api/alerts/log").catch(() => []),
        ]);
        if (!ctx.live()) return;
        body.innerHTML = "";
        body.append(
          sect(`Your alerts, ${list.filter((x) => x.active).length} watching`),
        );
        if (!list.length)
          body.append(
            html(
              `<div class="hint">No alerts yet. Pick a security and a level above, or type ALRT BTC ABOVE 70000.</div>`,
            ),
          );
        else
          body.append(
            table(list.slice().reverse(), [
              { key: alertText, label: "Alert", left: true, lbl: true },
              {
                key: alertStatus,
                label: "Status",
                left: true,
                cls: (v) =>
                  v === "Watching"
                    ? "amber"
                    : /^Fired/.test(v)
                      ? "up"
                      : /^Error/.test(v)
                        ? "down"
                        : "dim",
              },
              { key: (x) => when(x.createdAt), label: "Created", left: true },
              { key: "fired", label: "Times fired" },
              {
                key: "id",
                label: "",
                html: true,
                fmt: (v) =>
                  `<button class="xbtn" data-del="${esc(v)}" title="Delete this alert">×</button>`,
              },
            ]),
          );
        if (log.length) {
          body.append(sect("Fired recently"));
          body.append(
            table(log.slice(0, 15), [
              { key: (x) => when(x.at), label: "When", left: true },
              { key: "text", label: "Alert", left: true, wrap: true },
              { key: "price", label: "Price", fmt: px },
            ]),
          );
        }
        ctx.setSource(
          "Alert engine on this computer, checking 1-minute closes every 15 seconds (Binance for crypto, Yahoo Finance for the rest)",
        );
      };
      const onFire = () => ctx.live() && load().catch(() => {});
      window.addEventListener("amber:alert", onFire);
      ctx.onCleanup(() => window.removeEventListener("amber:alert", onFire));
      await load();
      ctx.every(15e3, () => load().catch(() => {}));
    },
  },
];
