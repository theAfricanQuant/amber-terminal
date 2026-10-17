// Talking to the local server, and the number and date formats every screen shares.

async function req(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body
      ? { "Content-Type": "application/json", "x-qt": "1" }
      : { "x-qt": "1" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!r.ok)
    throw new Error(
      (data && data.error) ||
        (typeof data === "string" && data) ||
        `HTTP ${r.status}`,
    );
  return data;
}

export const api = {
  get: (u) => req("GET", u),
  put: (u, b) => req("PUT", u, b ?? {}),
  post: (u, b) => req("POST", u, b ?? {}),
  del: (u) => req("DELETE", u),
  candles: (symbol, tf, limit = 1500) =>
    req(
      "GET",
      `/api/candles?symbol=${encodeURIComponent(symbol)}&tf=${encodeURIComponent(tf)}&limit=${limit}`,
    ),
  quotes: (symbols) =>
    req("GET", `/api/quotes?symbols=${encodeURIComponent(symbols.join(","))}`),
  fn: (name, params = {}) =>
    req(
      "GET",
      `/api/fn/${name}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== ""))}`,
    ),
};

export const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const finite = (v) => typeof v === "number" && Number.isFinite(v);

// Prices: enough decimals to see a move, whatever the size of the number.
export function px(v) {
  if (!finite(v)) return "—";
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 10 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return v.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(d, 2),
    maximumFractionDigits: d,
  });
}
export const num = (v, d = 2) =>
  finite(v)
    ? v.toLocaleString("en-US", {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
      })
    : "—";
export const pct = (v, d = 2) =>
  finite(v) ? `${v > 0 ? "+" : ""}${v.toFixed(d)}%` : "—";
export const chg = (v, d = 2) =>
  finite(v) ? `${v > 0 ? "+" : ""}${num(v, d)}` : "—";
export const cls = (v) =>
  finite(v) ? (v > 0 ? "up" : v < 0 ? "down" : "") : "";
export function big(v) {
  if (!finite(v)) return "—";
  const a = Math.abs(v);
  for (const [n, s] of [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ])
    if (a >= n)
      return `${(v / n).toFixed(a / n >= 100 ? 0 : a / n >= 10 ? 1 : 2)}${s}`;
  return num(v, 0);
}
export const date = (t) => {
  const d =
    t instanceof Date
      ? t
      : new Date(typeof t === "number" && t < 1e12 ? t * 1000 : t);
  return Number.isNaN(+d) ? "—" : d.toISOString().slice(0, 10);
};
export function ago(t) {
  const d = new Date(typeof t === "number" && t < 1e12 ? t * 1000 : t);
  const s = (Date.now() - d) / 1000;
  if (!Number.isFinite(s)) return "";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
