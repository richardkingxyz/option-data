// Order flow collector: every 15 minutes (GitHub Actions), pull the option trades since the last
// run from Deribit (BTC, ETH, SOL_USDC) and Derive (BTC, ETH, SOL), keep the large ones as
// defined in data/orderflow/config.json, and append them to data/orderflow/<ISO week>.json.
// data/orderflow/latest.json holds the newest 300 for the page; state.json the per-source cursor.
//
// Public endpoints, no keys. Any source that fails is logged and left at its old cursor, so the
// next run re-reads it; the process always exits 0 so the commit step runs for the sources that
// worked. Run by hand: node scripts/collect-orderflow.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromDeribit, fromDerive, takerOnly, keepLarge, isoWeek, DEFAULT_CONFIG } from './orderflow-lib.mjs';

const DIR = fileURLToPath(new URL('../data/orderflow/', import.meta.url));
const BACKFILL_MS = 7 * 864e5;        // first run reads the last 7 days
const OVERLAP_MS = 15 * 60e3;         // re-read this much before the cursor; ids dedupe the repeats
const PAGE_DELAY_MS = 250;
const MAX_PAGES = 80;                 // 80 x 1000 trades per source per run is far above any real window
const LATEST_N = 300;
const STALE_CURSOR_MS = 2 * 36e5;    // rewrite the cursor file at least this often even with nothing new
const DERIBIT = 'https://www.deribit.com/api/v2/public/';
const DERIVE = 'https://api.derive.xyz/v3/public/';

const SOURCES = [
  { key: 'deribit:BTC', venue: 'deribit', currency: 'BTC' },
  { key: 'deribit:ETH', venue: 'deribit', currency: 'ETH' },
  { key: 'deribit:USDC', venue: 'deribit', currency: 'USDC', only: n => n.startsWith('SOL_') },   // linear SOL options live under USDC
  { key: 'derive:BTC', venue: 'derive', currency: 'BTC' },
  { key: 'derive:ETH', venue: 'derive', currency: 'ETH' },
  { key: 'derive:SOL', venue: 'derive', currency: 'SOL' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJson = (name, fallback) => existsSync(DIR + name) ? JSON.parse(readFileSync(DIR + name, 'utf8')) : fallback;
const writeJson = (name, v) => writeFileSync(DIR + name, JSON.stringify(v, null, 0) + '\n');

async function getJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url.split('?')[0]}`);
  const j = await r.json();
  if (j.error) throw new Error(`${j.error.message || JSON.stringify(j.error)} for ${url.split('?')[0]}`);
  return j.result;
}

// Deribit: pages forward by timestamp while has_more.
async function fetchDeribit(currency, from, to) {
  const out = [];
  let start = from;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ currency, kind: 'option', start_timestamp: String(start), end_timestamp: String(to), count: '1000', sorting: 'asc' });
    const res = await getJson(`${DERIBIT}get_last_trades_by_currency_and_time?${q}`);
    const trades = res.trades || [];
    out.push(...trades);
    if (!res.has_more || !trades.length) break;
    start = trades[trades.length - 1].timestamp + 1;
    await sleep(PAGE_DELAY_MS);
  }
  return out;
}

// Derive: numbered pages; both sides of each match come back, takerOnly keeps the aggressor.
async function fetchDerive(currency, from, to) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await getJson(`${DERIVE}get_trade_history`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instrument_type: 'option', currency, from_timestamp: from, to_timestamp: to, page, page_size: 1000 }),
    });
    out.push(...(res.trades || []));
    if (page >= (res.pagination?.num_pages || 1) || !(res.trades || []).length) break;
    await sleep(PAGE_DELAY_MS);
  }
  return takerOnly(out);
}

const cfg = { ...DEFAULT_CONFIG, ...readJson('config.json', {}) };
const state = readJson('state.json', { cursors: {} });
const prevCursors = { ...state.cursors };
const now = Date.now();
const kept = [];            // this run's kept records
const seenRaw = [];         // per-source counts for the log
let anyOk = false;

for (const s of SOURCES) {
  const cursor = state.cursors[s.key];
  const from = cursor ? cursor - OVERLAP_MS : now - BACKFILL_MS;
  try {
    const raw = s.venue === 'deribit' ? await fetchDeribit(s.currency, from, now) : await fetchDerive(s.currency, from, now);
    const mine = s.only ? raw.filter(t => s.only(t.instrument_name)) : raw;
    const records = mine.map(s.venue === 'deribit' ? fromDeribit : fromDerive).filter(Boolean);
    const large = keepLarge(records, cfg);
    kept.push(...large);
    state.cursors[s.key] = now;
    anyOk = true;
    seenRaw.push(`${s.key} ${mine.length} seen ${large.length} kept`);
  } catch (e) {
    console.error(`[${s.key}] failed, cursor kept: ${e.message || e}`);
    seenRaw.push(`${s.key} FAILED`);
  }
  await sleep(PAGE_DELAY_MS);
}

// Append to the week files, never touching records already stored.
let added = 0;
const touched = new Set();
const byWeek = new Map();
for (const r of kept) { const w = isoWeek(r.ts); if (!byWeek.has(w)) byWeek.set(w, []); byWeek.get(w).push(r); }
for (const [week, recs] of byWeek) {
  const file = `${week}.json`;
  const have = readJson(file, []);
  const ids = new Set(have.map(r => r.id));
  const fresh = recs.filter(r => !ids.has(r.id) && ids.add(r.id));
  if (!fresh.length) continue;
  have.push(...fresh);
  have.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
  writeJson(file, have);
  added += fresh.length;
  touched.add(week);
}

// latest.json: the newest LATEST_N across this week and the one before, newest first.
if (added || !existsSync(DIR + 'latest.json')) {
  const thisWeek = isoWeek(now);
  const weeks = [thisWeek, isoWeek(now - 7 * 864e5), isoWeek(now - 14 * 864e5)];
  const pool = weeks.flatMap(w => readJson(`${w}.json`, []));
  pool.sort((a, b) => b.ts - a.ts || a.id.localeCompare(b.id));
  writeJson('latest.json', { updated: now, config: cfg, trades: pool.slice(0, LATEST_N) });
}
// The cursor file is only rewritten when something was added or it is getting stale, so a
// quiet quarter-hour makes no commit; the overlap re-read covers the gap either way.
const oldest = Math.min(...SOURCES.map(s => prevCursors[s.key] || 0));
if (anyOk && (added || now - oldest > STALE_CURSOR_MS)) { state.updated = new Date(now).toISOString(); writeJson('state.json', state); }

console.log(`orderflow ${new Date(now).toISOString()}: +${added} trades (${seenRaw.join('; ')})${touched.size ? ' -> ' + [...touched].join(', ') : ''}`);
console.log(`ADDED=${added}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `added=${added}\n`);
