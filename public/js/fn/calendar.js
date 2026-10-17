// Calendars: economic releases and company earnings.
import { api, esc, big } from "../api.js";
import { table, sect, tabs } from "../ui.js";

const fmtWhen = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d)
    ? iso
    : d.toLocaleString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
};

export default [
  {
    id: "ECO",
    name: "Economic calendar",
    group: "Economics",
    source: "Nasdaq economic calendar with actual figures (Forex Factory when Nasdaq is down)",
    async render(ctx) {
      let first = true;
      const load = async () => {
        const d = await api.fn("eco");
        if (!ctx.live()) return;
        // Importance filter only when the source rates importance (Forex Factory does, Nasdaq doesn't).
        const want = d.impact ? ctx.args[0] || "HIGH" : "ALL";
        const keep = (r) =>
          want === "ALL" ||
          (want === "HIGH"
            ? r.impact === "High"
            : r.impact === "High" || r.impact === "Medium");
        const list = d.rows.filter(keep);
        const top = ctx.el.scrollTop;
        ctx.el.innerHTML = "";
        if (d.impact)
          ctx.el.append(
            tabs(["HIGH", "MEDIUM", "ALL"], want, (t) => ctx.go(`ECO ${t}`)),
          );
        const now = Date.now();
        const state = (r) =>
          r.actual ? "released" : r.time && new Date(r.time) < now ? "done" : "upcoming";
        ctx.el.append(
          table(
            list,
            [
              {
                key: "time",
                label: "Time (your clock)",
                left: true,
                lbl: true,
                fmt: (v, r) =>
                  v
                    ? fmtWhen(v)
                    : `${new Date(`${r.day}T12:00:00`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, all day`,
              },
              { key: "country", label: "Country", left: true },
              { key: "event", label: "Event", left: true },
              d.impact && {
                key: "impact",
                label: "Impact",
                left: true,
                cls: (v) =>
                  v === "High" ? "down" : v === "Medium" ? "amber" : "dim",
              },
              { key: "actual", label: "Actual", cls: (v) => (v ? "amber" : "") },
              { key: "consensus", label: "Survey" },
              { key: "previous", label: "Prior" },
              {
                key: state,
                label: "",
                left: true,
                cls: (v) => (v === "upcoming" ? "up" : "dim"),
              },
            ].filter(Boolean),
          ),
        );
        if (!list.length)
          ctx.el.insertAdjacentHTML("beforeend", `<div class="hint">No releases in the next five days.</div>`);
        const next = [...ctx.el.querySelectorAll("td")].find((td) => td.textContent === "upcoming");
        if (first && next)
          ctx.el.scrollTop +=
            next.getBoundingClientRect().top - ctx.el.getBoundingClientRect().top - 80;
        else ctx.el.scrollTop = top;
        first = false;
        ctx.setSource(d.source);
      };
      await load();
      ctx.every(5 * 60e3, () => load().catch(() => {}));
    },
  },
  {
    id: "ERN",
    name: "Earnings calendar",
    group: "Equities",
    source: "Nasdaq earnings calendar",
    async render(ctx) {
      const rows = await api.get("/api/earnings?days=7");
      if (!ctx.live()) return;
      ctx.el.innerHTML = "";
      const byDay = {};
      for (const r of rows) (byDay[r.date] ||= []).push(r);
      for (const [d, list] of Object.entries(byDay)) {
        ctx.el.append(
          sect(
            new Date(`${d}T12:00:00Z`).toLocaleDateString("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "long",
            }),
          ),
        );
        ctx.el.append(
          table(
            list
              .sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))
              .slice(0, 25),
            [
              { key: "ticker", label: "Ticker", left: true, lbl: true },
              {
                key: "name",
                label: "Company",
                left: true,
                fmt: (v) => String(v || "").slice(0, 34),
              },
              { key: "when", label: "When", left: true },
              { key: "marketCap", label: "Mkt cap", fmt: big },
              { key: "epsForecast", label: "EPS est" },
              { key: "lastYearEps", label: "Year ago" },
            ],
            { onRow: (r) => ctx.go(`${r.ticker} US EQUITY DES`) },
          ),
        );
      }
      if (!rows.length)
        ctx.el.innerHTML = `<div class="hint">No earnings in the next week.</div>`;
      ctx.setSource("Nasdaq earnings calendar");
    },
  },
];
