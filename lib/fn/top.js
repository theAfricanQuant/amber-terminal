// /api/fn/top?group=ALL|TECH|CRYPTO|ECON : market headlines from several public RSS feeds, merged,
// de-duplicated by title and sorted newest first. If the main feeds all fail, Google News business is the fallback.
import { cached } from "../providers.js";
import { parseRss } from "../market-info.js";

const OFFLINE = process.env.QT_OFFLINE === "1";
const UA = { "User-Agent": "Mozilla/5.0" };
const FEED_TIMEOUT_MS = Number(process.env.QT_TIMEOUT_MS) || 6000;
const cnbc = (id) =>
  `https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=${id}`;

export const FEEDS = {
  ALL: [
    ["CNBC", cnbc(100003114)],
    ["WSJ", "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain"],
    [
      "MarketWatch",
      "https://feeds.content.dowjones.io/public/rss/mw_topstories",
    ],
    ["FT", "https://www.ft.com/markets?format=rss"],
    ["Bloomberg", "https://feeds.bloomberg.com/markets/news.rss"],
    ["Nasdaq", "https://www.nasdaq.com/feed/rssoutbound?category=Markets"],
  ],
  TECH: [
    ["CNBC", cnbc(19854910)],
    ["WSJ", "https://feeds.content.dowjones.io/public/rss/RSSWSJD"],
    ["Bloomberg", "https://feeds.bloomberg.com/technology/news.rss"],
    ["FT", "https://www.ft.com/technology?format=rss"],
  ],
  CRYPTO: [
    ["Cointelegraph", "https://cointelegraph.com/rss"],
    ["Decrypt", "https://decrypt.co/feed"],
    ["CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss"],
    ["Bloomberg", "https://feeds.bloomberg.com/crypto/news.rss"],
  ],
  ECON: [
    ["CNBC", cnbc(20910258)],
    ["Bloomberg", "https://feeds.bloomberg.com/economics/news.rss"],
    ["FT", "https://www.ft.com/global-economy?format=rss"],
    ["Federal Reserve", "https://www.federalreserve.gov/feeds/press_all.xml"],
  ],
};
const FALLBACK = [
  "Google News",
  "https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en",
];

const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  ndash: "–",
  mdash: "—",
  hellip: "…",
};
// parseRss leaves numeric entities like &#x2019; alone, which MarketWatch and WSJ use in titles.
export function unescapeEntities(s) {
  return String(s ?? "").replace(
    /&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi,
    (m, hex, dec, name) => {
      if (name) return NAMED[name.toLowerCase()] ?? m;
      const code = hex ? parseInt(hex, 16) : Number(dec);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    },
  );
}

const httpUrl = (u) => (/^https?:\/\//i.test(u) ? u : "");

// One feed's XML to { title, url, source, time }. Items without a title or a web link are dropped.
export function parseFeed(xml, source) {
  return parseRss(String(xml || ""), source)
    .map((i) => ({
      title: unescapeEntities(i.title).replace(/\s+/g, " ").trim(),
      url: httpUrl(unescapeEntities(i.url).trim()),
      source,
      time: i.time,
    }))
    .filter((i) => i.title && i.url);
}

// Google News titles end in " - Publisher": move the publisher into the source field.
export function parseGoogleNews(xml) {
  return parseFeed(xml, "Google News").map((i) => {
    const m = /^(.*\S)\s+-\s+([^-]{2,40})$/.exec(i.title);
    return m ? { ...i, title: m[1], source: m[2].trim() } : i;
  });
}

const titleKey = (t) =>
  t
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Newest first; when two feeds carry the same headline, the newest copy stays.
export function mergeNews(lists, limit = 80) {
  const seen = new Set();
  const out = [];
  const all = lists.flat().sort((a, b) => (b.time || 0) - (a.time || 0));
  for (const item of all) {
    const k = titleKey(item.title);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out.slice(0, limit);
}

async function getText(url) {
  const res = await fetch(url, {
    headers: UA,
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

export async function loadNews(group) {
  const feeds = FEEDS[group];
  const results = await Promise.all(
    feeds.map(async ([name, url]) => {
      try {
        return { name, items: parseFeed(await getText(url), name) };
      } catch {
        return { name, items: null };
      }
    }),
  );
  const ok = results.filter((r) => r.items?.length);
  let items = mergeNews(ok.map((r) => r.items));
  let used = ok.map((r) => r.name);
  if (items.length < 5 && group === "ALL") {
    try {
      items = mergeNews([items, parseGoogleNews(await getText(FALLBACK[1]))]);
      used = [...used, FALLBACK[0]];
    } catch {
      /* the main feeds' result stands */
    }
  }
  if (!items.length)
    throw Object.assign(
      new Error(
        "None of the news feeds answered. Check your internet connection and try again in a minute.",
      ),
      { status: 502 },
    );
  const missed = results.filter((r) => !r.items?.length).map((r) => r.name);
  return {
    group,
    items,
    feeds: used,
    source: `${used.join(", ")} public headline feeds, a few minutes behind${missed.length ? ` (no answer from ${missed.join(", ")})` : ""}`,
  };
}

export default async function (q) {
  const group = String(q.group || "ALL").toUpperCase();
  if (!FEEDS[group])
    throw Object.assign(
      new Error(
        `There is no ${group} news group. Try ${Object.keys(FEEDS).join(", ")}.`,
      ),
      { status: 400 },
    );
  if (OFFLINE)
    return {
      group,
      items: [],
      feeds: [],
      source: "Offline mode: no news is fetched",
    };
  return cached(`top:${group}`, 120e3, () => loadNews(group));
}
