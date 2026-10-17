// Every terminal function, by its code. Each file exports a list of { id, name, group, source, needs, render(ctx) }.
// To add a screen: write public/js/fn/<area>.js (and lib/fn/<name>.js if it needs server data), then import it here.
import market from "./market.js";
import security from "./security.js";
import calendar from "./calendar.js";
import meta from "./meta.js";
import apiHelp from "./api.js";
import newsfilings from "./newsfilings.js";
import docsearch from "./docsearch.js";
import rates from "./rates.js";
import options from "./options.js";
import btst from "./btst.js";
import coverage from "./coverage.js";
import workspace from "./workspace.js";
import equity from "./equity.js";
import playbooks from "./playbooks.js";

export const FUNCS = {};
for (const f of [...market, ...security, ...calendar, ...newsfilings, ...docsearch, ...rates, ...options, ...btst, ...coverage, ...workspace, ...equity, ...playbooks, ...apiHelp, ...meta]) FUNCS[f.id] = f;
