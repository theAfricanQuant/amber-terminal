#!/usr/bin/env node
// Starts the real server, checks the page and live data endpoints, then stops it.
// Used by CI on Windows, macOS and Linux, and by the install prompt as its final check.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = String(3700 + Math.floor(Math.random() * 90));
const child = spawn(process.execPath, [path.join(root, 'server.js')], { env: { ...process.env, PORT: port, QT_DATA_DIR: path.join(root, 'data', 'smoke') }, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

const base = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`Server did not start within 20s:\n${out}`)), 20000);
  const iv = setInterval(() => {
    const m = /http:\/\/localhost:(\d+)/.exec(out);
    if (m) { clearInterval(iv); clearTimeout(t); resolve(`http://127.0.0.1:${m[1]}`); }
  }, 100);
});

const results = [];
async function check(name, url, test) {
  const t = Date.now();
  try {
    const r = await fetch(base + url, { signal: AbortSignal.timeout(30000) });
    const body = r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text();
    const ok = r.ok && test(body);
    results.push({ name, ok, ms: Date.now() - t, info: ok ? '' : JSON.stringify(body).slice(0, 200) });
  } catch (e) { results.push({ name, ok: false, ms: Date.now() - t, info: e.message }); }
}

await check('app page', '/', (b) => b.includes('Amber Terminal'));
await check('chart engine', '/vendor/lightweight-charts.standalone.production.js', (b) => b.length > 100000);
await check('health', '/api/health', (b) => b.ok === true);
await check('crypto candles (BTCUSDT 1h)', '/api/candles?symbol=BTCUSDT&tf=1h&limit=200', (b) => b.candles?.length >= 100 && (results.cryptoVia = b.provider));
await check('stock candles (AAPL 1D)', '/api/candles?symbol=AAPL&tf=1D&limit=200', (b) => b.candles?.length >= 100 && (results.stockVia = b.provider));
await check('watchlist quotes', '/api/quotes?symbols=BTCUSDT,ETHUSDT', (b) => Object.values(b).every((q) => q.price > 0));

// Each screen's public source, checked from this connection. These don't fail the install: if one is blocked or
// busy, only its screens are affected, and the summary says which.
const SOURCES = [
  ['world prices (WEI, GLCO, FXC)', '/api/fn/board?symbols=%5EGSPC,GC%3DF', (b) => b.rows?.['^GSPC']?.price > 0],
  ['news (TOP)', '/api/fn/top', (b) => b.items?.length > 0],
  ['company profile (DES)', '/api/fn/des?symbol=AAPL', (b) => !!b.name],
  ['SEC filings (CF, INSD)', '/api/fn/cf?symbol=AAPL', (b) => b.filings?.length > 0],
  ['holders (HDS)', '/api/fn/hds?symbol=AAPL', (b) => b.rows?.length > 0],
  ['options (OMON)', '/api/fn/omon?symbol=AAPL', (b) => b.expiries?.length > 0],
  ['economic calendar (ECO)', '/api/fn/eco', (b) => b.rows?.length > 0],
  ['Treasury yields (GC)', '/api/fn/gc', (b) => b.tenors?.length > 0],
  ['money markets (BTMM)', '/api/fn/btmm', (b) => b.funding?.length > 0],
  ['Fed rate path (WIRP)', '/api/fn/wirp', (b) => b.meetings?.length > 0],
  ['macro series (ECST)', '/api/fn/ecst', (b) => b.rows?.length > 0],
  ['central banks (CBRT)', '/api/fn/cbrt', (b) => b.rows?.length > 0],
  ['positioning (COT)', '/api/fn/cot', (b) => b.sections?.length > 0],
];
for (const [name, url, test] of SOURCES) await check(`source: ${name}`, url, test);

await fetch(`${base}/api/shutdown`, { method: 'POST', headers: { 'x-qt': '1' } }).catch(() => {});
setTimeout(() => child.kill(), 1000).unref();

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.ms} ms)${r.info ? `  ${r.info}` : ''}`);
console.log(`crypto via ${results.cryptoVia || '-'}, stocks via ${results.stockVia || '-'}`);
const required = results.filter((r) => !r.name.startsWith('stock') && !r.name.startsWith('source:'));
const down = results.filter((r) => r.name.startsWith('source:') && !r.ok).map((r) => r.name.slice(8));
console.log(down.length ? `Sources not reachable right now: ${down.join(', ')}. Everything else works.` : 'Every screen\'s source is reachable.');
const pass = required.every((r) => r.ok);
console.log(pass ? '\nSMOKE TEST PASSED' : '\nSMOKE TEST FAILED');
process.exit(pass ? 0 : 1);
