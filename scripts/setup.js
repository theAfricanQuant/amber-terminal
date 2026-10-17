#!/usr/bin/env node
// Set the four panels for what you follow, before the first launch.
//   node scripts/setup.js --profile stocks|crypto|fx|macro|mix [--ticker NVDA]
// Run it while the app is stopped (or refresh the browser tab afterwards).
import * as store from "../lib/store.js";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--"))
      acc.push([
        a.slice(2),
        all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "true",
      ]);
    return acc;
  }, []),
);

export const PROFILES = {
  stocks: (t = "SPY") => ["WEI", "TOP", `${t} US EQUITY GP`, "MOST"],
  crypto: (t = "BTC") => ["CRYPTO", "TOP CRYPTO", `${t} GP`, "WIRP"],
  fx: (t = "EURUSD") => ["FXC", "ECO", `${t} CURNCY GP`, "CBRT"],
  macro: () => ["WIRP", "GC", "ECO", "GLCO"],
  mix: () => ["WEI", "TOP", "WIRP", "ECO"],
};

const profile = String(args.profile || "mix").toLowerCase();
if (!PROFILES[profile]) {
  console.error(
    `Unknown profile "${profile}". Use one of: ${Object.keys(PROFILES).join(", ")}.`,
  );
  process.exit(1);
}
const ticker =
  args.ticker && /^[A-Za-z0-9.^=-]{1,15}$/.test(args.ticker)
    ? args.ticker.toUpperCase()
    : undefined;
const panels = PROFILES[profile](ticker);
const state = store.read("state", {});
store.write("state", { ...state, amber: { layout: 4, panels, active: 0 } });
console.log(`Set up for ${profile}. Panels: ${panels.join("  |  ")}`);
