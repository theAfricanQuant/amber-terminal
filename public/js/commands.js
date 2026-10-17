// The command line: "<ticker> [exchange] [yellow key] [function]", then GO.
//   AAPL US EQUITY DES   VOD LN DES   SPX INDEX GP   CL1 COMDTY   EURUSD CURNCY   BTC   WEI   TOP
// A security sets the panel's subject; a function runs on it (or on its own, for market-wide screens).
import { isPublicDemo } from "./api.js";
import { FUNCS } from "./fn/index.js";

import { YELLOW, INDICES, GENERICS, toSecurity } from "./securities.js";
export { YELLOW, INDICES, GENERICS, toSecurity };

// Split input into a security part and a function, the way the terminal reads it.
// Words that are options to a function, not a security: FA Q, HP W, CF 10-K, GP 1Y, MOST GAINERS, OMON 2.
const OPTS = new Set(["Q", "A", "D", "W", "M", "H", "ALL", "HIGH", "MEDIUM", "VOLUME", "GAINERS", "LOSERS", "1D", "5D", "1M", "6M", "1Y", "5Y", "MAX", "10-K", "10-Q", "8-K", "S-1", "13F", "TECH", "COINS", "ECON", "CANDLES", "LINE"]);
export const isOpt = (fn, w) => OPTS.has(w) || /^\d{1,2}$/.test(w) || (FUNCS[fn]?.opts || []).includes(w);

export function parse(input) {
  const words = String(input || "")
    .toUpperCase()
    .replace(/<?GO>?$/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  // A function first ("TOP CRYPTO", "FA Q", "OMON AAPL", "GP BTC 1Y"): what follows is options, or a subject
  // and then options.
  // ...unless a yellow key and then a function follow, which makes the first word a ticker ("W US EQUITY DES").
  const yk = words.findIndex((w, i) => i > 0 && YELLOW[w]);
  const tickerFirst = yk > 0 && words.slice(yk + 1).some((w) => FUNCS[w] && !YELLOW[w]);
  if (FUNCS[words[0]] && !tickerFirst) {
    const fn = words[0];
    const rest = words.slice(1);
    if (!FUNCS[fn].needs || rest.every((w) => isOpt(fn, w))) return { fn, sec: null, args: rest };
    let cut = rest.findIndex((w, i) => i > 0 && isOpt(fn, w));
    if (cut < 0) cut = rest.length;
    return { fn, sec: toSecurity(rest.slice(0, cut)), args: rest.slice(cut) };
  }
  // A security first ("AAPL US EQUITY DES", "BTC CRYPTO GP"): the function is the last word that names one.
  // CRYPTO after a ticker is the yellow key, not the crypto monitor.
  let fi = -1;
  for (let i = words.length - 1; i > 0; i--)
    // An option word after an earlier function ("AAPL HP W") stays an option, even if it also names a function.
    if (FUNCS[words[i]] && !YELLOW[words[i]] && !(OPTS.has(words[i]) && words.slice(0, i).some((w) => FUNCS[w]))) {
      fi = i;
      break;
    }
  const fn = fi >= 0 ? words[fi] : null;
  return { fn, sec: toSecurity(fi >= 0 ? words.slice(0, fi) : words), args: fi >= 0 ? words.slice(fi + 1) : [] };
}

export function defaultFn(sec) {
  return sec?.sector === "EQUITY" ? "DES" : "GP";
}

// Security lookup (SECF): the words being typed that name a security, or null when what's being typed is a
// function, a yellow key, an option or a finished word. "apple" -> "APPLE", "OMON app" -> "APP" after the function,
// "bank of am" -> the whole phrase. start is the index of the first word the lookup will replace.
export function securityQuery(input) {
  const s = String(input || "");
  if (!s.trim() || /\s$/.test(s)) return null;
  const words = s.toUpperCase().trim().split(/\s+/);
  const start = FUNCS[words[0]] && words.length > 1 ? 1 : 0;
  const tail = words.slice(start);
  const last = tail.at(-1);
  if (tail.length > 4 || !/^[A-Z&]/.test(last) || last.replace(/[^A-Z0-9]/g, "").length < 2) return null;
  if (tail.some((w) => FUNCS[w] || YELLOW[w] || OPTS.has(w))) return null;
  if (tail.length === 2 && /^[A-Z0-9.]{1,6}$/.test(tail[0]) && EXCH_CODES.has(tail[1])) return null;
  return { query: tail.join(" "), start };
}
const EXCH_CODES = new Set(["US", "UN", "UW", "UQ", "LN", "GR", "GY", "FP", "NA", "SM", "IM", "SW", "SE", "JP", "JT", "HK", "CN", "CT", "AU", "AT", "IN", "IS", "IB", "KS", "TT", "SP", "BZ", "MM", "SS", "NO", "DC", "FH", "BB", "ID", "PL", "AV"]);

// Autocomplete: functions whose code or name starts with what's typed.
const PUBLIC_DISABLED_FUNCS = new Set(["ALRT", "PORT", "API", "ASK", "DS", "SURP"]);

export function suggestions(input) {
  const w = String(input || "")
    .toUpperCase()
    .trim()
    .split(/\s+/)
    .pop();
  if (!w) return [];
  return Object.values(FUNCS)
    .filter((f) => !(isPublicDemo() && PUBLIC_DISABLED_FUNCS.has(f.id)))
    .filter((f) => f.id.startsWith(w) || f.name.toUpperCase().includes(w))
    .sort(
      (a, b) =>
        (b.id.startsWith(w) ? 1 : 0) - (a.id.startsWith(w) ? 1 : 0) ||
        a.id.localeCompare(b.id),
    )
    .slice(0, 12);
}
