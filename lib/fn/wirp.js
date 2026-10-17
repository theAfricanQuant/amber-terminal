// /api/fn/wirp : the fed funds rate the market is pricing for each coming FOMC meeting, worked out from the
// 30-day fed funds futures (CME "ZQ") strip on Yahoo's public spark endpoint (about 10 minutes delayed).
// Each contract settles on the average effective fed funds rate over its month, so 100 minus its price is
// the rate the market expects on average that month. Chained meeting by meeting from today's EFFR.
import { getJson, cached } from "../providers.js";
import { board } from "./board.js";
import { nyToday, round } from "./gc.js";
import { fredSeries } from "./ecst.js";

// FOMC decision days: the second day of each two-day meeting. Source: Federal Reserve, "Meeting calendars
// and information", https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm (read 15 Oct 2026).
// 2026: Jan 27-28, Mar 17-18, Apr 28-29, Jun 16-17, Jul 28-29, Sep 15-16, Oct 27-28, Dec 8-9.
// 2027: Jan 26-27, Mar 16-17, Apr 27-28, Jun 8-9, Jul 27-28, Sep 14-15, Oct 26-27, Dec 7-8.
// Add the next year's dates here when the Fed publishes them (usually each August).
export const FOMC = [
  "2026-01-28",
  "2026-03-18",
  "2026-04-29",
  "2026-06-17",
  "2026-07-29",
  "2026-09-16",
  "2026-10-28",
  "2026-12-09",
  "2027-01-27",
  "2027-03-17",
  "2027-04-28",
  "2027-06-09",
  "2027-07-28",
  "2027-09-15",
  "2027-10-27",
  "2027-12-08",
];

const CODES = "FGHJKMNQUVXZ";
const MONTHS = [
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
export const ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
const nextYm = (y, m) => (m === 12 ? ym(y + 1, 1) : ym(y, m + 1));
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const zqSymbol = (y, m) => `ZQ${CODES[m - 1]}${String(y).slice(-2)}.CBT`;

// Contract months from this month to the month after the last listed meeting (Yahoo allows 20 per call).
export function contractMonths(today, meetings = FOMC) {
  let [y, m] = today.split("-").map(Number);
  const last = meetings.at(-1).slice(0, 7);
  const out = [];
  while (out.length < 20) {
    out.push({
      y,
      m,
      key: ym(y, m),
      symbol: zqSymbol(y, m),
      label: `${MONTHS[m - 1]} ${y}`,
    });
    if (ym(y, m) > last) break;
    [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  }
  return out;
}

// The standard meeting-month method (as CME FedWatch does it).
// avg: { "YYYY-MM": implied average rate for that month, in % }. Rates change the day after a decision,
// so a decision on day d of an N-day month leaves d days at the old rate:
//   avg = before * d/N + after * (1 - d/N)  =>  after = (avg - before * d/N) / (1 - d/N)
// When the decision is in the last week of its month (fewer than 7 days left at the new rate), that month
// says little about the new rate, so the next month's contract is used: after = avg(next month), as long as
// the next month has no meeting of its own.
export function impliedPath({ effr, avg, meetings = FOMC, today }) {
  const out = [];
  let before = effr;
  for (const d of meetings.filter((x) => x >= today)) {
    const [y, m, day] = d.split("-").map(Number);
    const N = daysIn(y, m);
    const here = ym(y, m),
      next = nextYm(y, m);
    const nextHasMeeting = meetings.some((x) => x.slice(0, 7) === next);
    let after, contract, method;
    if (N - day < 7 && avg[next] != null && !nextHasMeeting) {
      after = avg[next];
      contract = next;
      method = "next month";
    } else if (avg[here] != null) {
      const f = day / N;
      after = (avg[here] - before * f) / (1 - f);
      contract = here;
      method = "meeting month";
    } else break; // no price for the month needed: stop the chain rather than guess
    out.push({
      date: d,
      contract,
      method,
      before,
      after,
      stepBp: (after - before) * 100,
      cumBp: (after - effr) * 100,
      stepMoves: (after - before) / 0.25,
      moves: (after - effr) / 0.25,
    });
    before = after;
  }
  return out;
}

async function currentEffr() {
  try {
    const j = await cached("nyfed:effr1", 15 * 60e3, () =>
      getJson(
        "https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json",
      ),
    );
    const r = j.refRates[0];
    return {
      rate: +r.percentRate,
      date: r.effectiveDate,
      from: +r.targetRateFrom,
      to: +r.targetRateTo,
      source: "New York Fed",
    };
  } catch {
    const rows = await fredSeries(
      "EFFR",
      `${new Date().getUTCFullYear() - 1}-01-01`,
    );
    const r = rows.at(-1);
    return {
      rate: r.value,
      date: r.date,
      from: null,
      to: null,
      source: "FRED",
    };
  }
}

export default async function () {
  const today = nyToday();
  if (!FOMC.some((d) => d >= today))
    throw Object.assign(
      new Error(
        "No FOMC meeting dates are listed after today. The meeting list in lib/fn/wirp.js needs next year's dates.",
      ),
      { status: 500 },
    );
  const months = contractMonths(today);
  const [effr, rows] = await Promise.all([
    currentEffr(),
    cached("wirp:zq", 2 * 60e3, () => board(months.map((c) => c.symbol))).catch(
      () => {
        throw Object.assign(
          new Error(
            "Yahoo Finance didn't send fed funds futures prices. Try again in a minute.",
          ),
          { status: 502, upstream: true },
        );
      },
    ),
  ]);
  const contracts = months
    .map((c) => {
      const r = rows[c.symbol];
      if (!r || !Number.isFinite(r.price)) return null;
      return {
        symbol: c.symbol,
        month: c.key,
        label: c.label,
        price: r.price,
        rate: round(100 - r.price, 4),
        // Price up means a lower expected rate.
        changeBp: Number.isFinite(r.change) ? round(-r.change * 100, 1) : null,
      };
    })
    .filter(Boolean);
  if (!contracts.length)
    throw Object.assign(
      new Error(
        "Yahoo Finance sent no fed funds futures prices. Try again in a minute.",
      ),
      { status: 502, upstream: true },
    );
  const avg = Object.fromEntries(contracts.map((c) => [c.month, c.rate]));
  const meetings = impliedPath({ effr: effr.rate, avg, today });
  return {
    today,
    effr,
    contracts,
    meetings,
    source: `CME 30-day fed funds futures via Yahoo Finance (about 10 minutes delayed); current rate from the ${effr.source}`,
  };
}
