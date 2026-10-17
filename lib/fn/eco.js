// /api/fn/eco : economic releases for today and the next four days, with the actual figure as it lands.
// Nasdaq's economic calendar first (worldwide, has actuals); Forex Factory's weekly calendar when Nasdaq fails.
import {
  getJson,
  cached,
  NQ,
  economicCalendar,
  nyWallToUtc,
} from "../providers.js";

const DAYS = 5;

// Nasdaq files each day's events one date late: asking for date=2026-10-16 returns Thursday 15 October
// (checked against Forex Factory's dated calendar and weekday-only releases like US jobless claims).
// Its CDN also serves stale days, so the request carries a cache-buster that changes every five minutes.
export const nasdaqDateFor = (day) => addDays(day, 1);

export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const nyToday = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);

const ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
// Empty cells come back as "&nbsp;" or a single space.
export function cell(v) {
  const s = String(v ?? "")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) => ENTITIES[m])
    .trim();
  return s || null;
}

// One Nasdaq day ("gmt" is New York wall-clock time despite its name) -> rows with a UTC time.
// "All Day" (holidays) and "24H" (some time that day) have no clock time.
export function parseNasdaqDay(j, day) {
  const rows = j?.data?.rows;
  if (!Array.isArray(rows)) return [];
  const [y, m, d] = day.split("-").map(Number);
  return rows.map((r) => {
    const hm = /^(\d{1,2}):(\d{2})$/.exec(String(r.gmt || "").trim());
    return {
      day,
      time: hm
        ? new Date(
            nyWallToUtc(Date.UTC(y, m - 1, d, +hm[1], +hm[2])),
          ).toISOString()
        : null,
      when: hm ? null : "All day",
      country: cell(r.country),
      event: cell(r.eventName),
      actual: cell(r.actual),
      consensus: cell(r.consensus),
      previous: cell(r.previous),
      impact: null,
    };
  });
}

// Forex Factory rows (dated in New York time, no actual figures) in the same shape.
export function fromForexFactory(rows) {
  return (rows || []).map((r) => {
    const t = Date.parse(r.date);
    return {
      day: String(r.date || "").slice(0, 10),
      time: Number.isFinite(t) ? new Date(t).toISOString() : null,
      when: Number.isFinite(t) ? null : "All day",
      country: r.country || null,
      event: r.title || null,
      actual: null,
      consensus: cell(r.forecast),
      previous: cell(r.previous),
      impact: r.impact || null,
    };
  });
}

const byTime = (a, b) =>
  a.day.localeCompare(b.day) ||
  (a.time ? 1 : 0) - (b.time ? 1 : 0) ||
  String(a.time).localeCompare(String(b.time));

async function nasdaq(today) {
  const bust = Math.floor(Date.now() / 300e3);
  const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i));
  const got = await Promise.allSettled(
    days.map((day) =>
      getJson(
        `https://api.nasdaq.com/api/calendar/economicevents?date=${nasdaqDateFor(day)}&_=${bust}`,
        NQ,
      ).then((j) => {
        if (!Array.isArray(j?.data?.rows)) throw new Error("no rows");
        return parseNasdaqDay(j, day);
      }),
    ),
  );
  const ok = got.filter((g) => g.status === "fulfilled");
  if (!ok.length) throw got[0].reason;
  const missed = days.filter((_, i) => got[i].status !== "fulfilled");
  return { rows: ok.flatMap((g) => g.value).sort(byTime), missed };
}

// Nasdaq first, Forex Factory when every Nasdaq day fails. Not cached; the default export caches it.
export async function loadEco(today) {
  try {
    const { rows, missed } = await nasdaq(today);
    return {
      rows,
      impact: false,
      source: `Nasdaq economic calendar, actual figures as they're released${missed.length ? ` (Nasdaq didn't answer for ${missed.join(", ")})` : ""}`,
    };
  } catch (e) {
    const ff = await economicCalendar().catch(() => []);
    const rows = fromForexFactory(ff).filter((r) => r.day >= today).sort(byTime);
    if (!rows.length)
      throw Object.assign(
        new Error(`The economic calendar couldn't be loaded (Nasdaq: ${e.message}). Try again in a few minutes.`),
        { status: 502 },
      );
    return {
      rows,
      impact: true,
      source: "Forex Factory weekly calendar (Nasdaq didn't answer, so no actual figures)",
    };
  }
}

export default async function () {
  return cached("eco", 5 * 60e3, () => loadEco(nyToday()));
}
