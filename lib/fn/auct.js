// /api/fn/auct : US Treasury auctions, coming up and just held, from TreasuryDirect's free JSON service
// (www.treasurydirect.gov/TA_WS/securities, no key). Results are posted minutes after each auction closes
// (bills about 11:30am, notes and bonds about 1pm New York time).
import { getJson, cached } from "../providers.js";
import { nyToday, toNum } from "./gc.js";

const TD = "https://www.treasurydirect.gov/TA_WS/securities";
const UA = { "User-Agent": "Mozilla/5.0" };
const RECENT_DAYS = 30;

const day = (v) => (/^\d{4}-\d{2}-\d{2}/.test(v || "") ? v.slice(0, 10) : null);
const KIND = {
  Bill: "bill",
  Note: "note",
  Bond: "bond",
  TIPS: "TIPS",
  FRN: "FRN",
  CMB: "cash management bill",
};

// One TreasuryDirect security -> one row. Rates in percent, amounts in dollars.
// Bills are sold on a discount rate (the investment rate is the bond-equivalent yield); notes, bonds and TIPS on
// a yield (TIPS: the real yield, before inflation); floating rate notes on a margin over the 13-week bill rate.
export function auctionRow(r) {
  const type =
    r.cashManagementBillCMB === "Yes"
      ? "CMB"
      : r.floatingRate === "Yes"
        ? "FRN"
        : r.type || r.securityType;
  const term = String(
    r.term || r.originalSecurityTerm || r.securityTerm || "",
  ).trim();
  const reopening = r.reopening === "Yes";
  let rate = null,
    rateKind = null;
  if (type === "Bill" || type === "CMB") {
    rate = toNum(r.highDiscountRate);
    rateKind = "discount rate";
  } else if (type === "FRN") {
    rate = toNum(r.highDiscountMargin);
    rateKind = "margin";
  } else {
    rate = toNum(r.highYield);
    rateKind = type === "TIPS" ? "real yield" : "yield";
  }
  return {
    cusip: r.cusip,
    type,
    name: `${term.toLowerCase()} ${KIND[type] || String(type).toLowerCase()}`,
    term,
    // Bills reopen every week with the same term, so "time left" only says something for notes and bonds.
    left:
      reopening && !["Bill", "CMB"].includes(type) && r.securityTerm !== term
        ? String(r.securityTerm || "").toLowerCase()
        : null,
    reopening,
    announced: day(r.announcementDate),
    auction: day(r.auctionDate),
    issue: day(r.issueDate),
    maturity: day(r.maturityDate),
    offering: toNum(r.offeringAmount),
    coupon:
      type === "Bill" || type === "CMB" || type === "FRN"
        ? null
        : toNum(r.interestRate),
    rate,
    rateKind,
    investRate: toNum(r.highInvestmentRate),
    bidToCover: toNum(r.bidToCoverRatio),
    accepted: toNum(r.totalAccepted),
  };
}

const byDateThenTerm = (a, b) =>
  a.auction.localeCompare(b.auction) ||
  (a.issue || "").localeCompare(b.issue || "");

// upcoming: auctions not yet held (today's count until results are in); recent: newest first, results only.
export function splitAuctions(upcomingJson, auctionedJson, today = nyToday()) {
  const recent = (Array.isArray(auctionedJson) ? auctionedJson : [])
    .map(auctionRow)
    .filter(
      (r) =>
        r.auction &&
        r.auction <= today &&
        (r.rate != null || r.bidToCover != null),
    )
    .sort((a, b) => -byDateThenTerm(a, b));
  const done = new Set(recent.map((r) => `${r.cusip} ${r.auction}`));
  const upcoming = (Array.isArray(upcomingJson) ? upcomingJson : [])
    .map(auctionRow)
    .filter(
      (r) =>
        r.auction && r.auction >= today && !done.has(`${r.cusip} ${r.auction}`),
    )
    .sort(byDateThenTerm);
  return { upcoming, recent };
}

const fetchTd = (path) =>
  cached(`td:${path}`, 3600e3, () => getJson(`${TD}/${path}`, UA));

export default async function () {
  const today = nyToday();
  const [up, done] = await Promise.all([
    fetchTd("upcoming?format=json").catch((e) => e),
    fetchTd(`auctioned?format=json&days=${RECENT_DAYS}`).catch((e) => e),
  ]);
  if (up instanceof Error && done instanceof Error)
    throw Object.assign(
      new Error(
        `TreasuryDirect didn't send auction data (${done.message}). Try again in a minute.`,
      ),
      { status: 502, upstream: true },
    );
  const { upcoming, recent } = splitAuctions(
    up instanceof Error ? [] : up,
    done instanceof Error ? [] : done,
    today,
  );
  return {
    today,
    recentDays: RECENT_DAYS,
    upcoming,
    recent,
    partial:
      up instanceof Error
        ? "upcoming"
        : done instanceof Error
          ? "recent"
          : null,
    source:
      "US Treasury auction announcements and results from TreasuryDirect, refreshed hourly here (results post minutes after each auction)",
  };
}
