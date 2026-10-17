// /api/fn/ee?symbol=AAPL : earnings estimates for US stocks. Consensus EPS forecasts by quarter and year
// (high, low, number of analysts, revisions in the last four weeks), the last four reported quarters
// against the forecast, and the next report date. Nasdaq publishes Zacks' consensus for free.
import { getJson, cached, NQ, resolve } from "../providers.js";

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export function parseForecast(j) {
  const rows = (t) =>
    (t?.rows || []).map((r) => ({
      period: r.fiscalEnd,
      consensus: num(r.consensusEPSForecast),
      high: num(r.highEPSForecast),
      low: num(r.lowEPSForecast),
      estimates: num(r.noOfEstimates),
      up: num(r.up),
      down: num(r.down),
    }));
  return {
    quarterly: rows(j?.data?.quarterlyForecast),
    yearly: rows(j?.data?.yearlyForecast),
  };
}

export function parseSurprise(j) {
  return (j?.data?.earningsSurpriseTable?.rows || []).map((r) => {
    const eps = num(r.eps),
      est = num(r.consensusForecast);
    return {
      period: r.fiscalQtrEnd,
      reported: r.dateReported,
      eps,
      consensus: est,
      surprisePct: num(r.percentageSurprise),
      beat:
        eps != null && est != null
          ? eps > est
            ? "Beat"
            : eps < est
              ? "Missed"
              : "Met"
          : null,
    };
  });
}

export default async function (q) {
  const sym = await resolve(q.symbol);
  if (sym.exchange !== "US")
    throw Object.assign(
      new Error("EE covers US-listed stocks (Nasdaq's free consensus data)."),
      { status: 400 },
    );
  const t = encodeURIComponent(sym.ticker);
  return cached(`ee:${t}`, 3 * 3600e3, async () => {
    const [fc, su, dt] = await Promise.all([
      getJson(
        `https://api.nasdaq.com/api/analyst/${t}/earnings-forecast`,
        NQ,
      ).catch(() => null),
      getJson(
        `https://api.nasdaq.com/api/company/${t}/earnings-surprise`,
        NQ,
      ).catch(() => null),
      getJson(
        `https://api.nasdaq.com/api/analyst/${t}/earnings-date`,
        NQ,
      ).catch(() => null),
    ]);
    const forecast = parseForecast(fc);
    const surprises = parseSurprise(su);
    if (
      !forecast.quarterly.length &&
      !forecast.yearly.length &&
      !surprises.length
    )
      throw Object.assign(
        new Error(`Nasdaq has no earnings estimates for ${sym.ticker}.`),
        { status: 404 },
      );
    return {
      symbol: sym.ticker,
      ...forecast,
      surprises,
      nextReport: dt?.data?.announcement || null,
      note: dt?.data?.reportText || null,
      source:
        "Zacks consensus via Nasdaq, updated daily. EPS as Zacks adjusts it, so it can differ from reported GAAP EPS",
    };
  });
}
