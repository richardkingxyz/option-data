// Records Deribit's live figures for SOL and BTC into data/history.json.
// Run by .github/workflows/snapshot.yml every six hours. Nothing is calculated here:
// each entry is what Deribit reported at that moment, so the page can later show
// today's reading against a genuine history (Deribit itself keeps no IV history).
//
// Entry shape: { t, asset, spot, rv, dvol, atm: [{ e, k, iv }] }
//   t    snapshot time (ms)        rv    Deribit's realized volatility, latest reading (%)
//   spot index price               dvol  Deribit's DVOL index (BTC only; null for SOL)
//   atm  per expiration date e (ms): the strike k nearest spot and Deribit's mark IV there (%)

import { readFileSync, writeFileSync } from 'node:fs';

const FILE = new URL('../data/history.json', import.meta.url);
const API = 'https://www.deribit.com/api/v2/public/';
const ASSETS = {
  SOL: { currency: 'USDC', prefix: 'SOL_USDC-', index: 'sol_usdc', vol: 'SOL', dvol: null },
  BTC: { currency: 'BTC', prefix: 'BTC-', index: 'btc_usd', vol: 'BTC', dvol: 'btcdvol_usdc' },
};
const MIN_DAYS = 1, MAX_DAYS = 120;   // same expiry window as the page

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(method, params) {
  const url = API + method + '?' + new URLSearchParams(params);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    const body = await res.json().catch(() => null);
    const limited = res.status === 429 || body?.error?.code === 10028;
    if (limited && attempt < 6) { await sleep(500 * 2 ** attempt); continue; }
    if (!res.ok || !body || body.error) throw new Error(`${method}: HTTP ${res.status} ${JSON.stringify(body?.error ?? '')}`);
    return body.result;
  }
}
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

const now = Date.now();
const entries = [];
for (const [asset, cfg] of Object.entries(ASSETS)) {
  const spot = (await api('get_index_price', { index_name: cfg.index })).index_price;
  const rvSeries = await api('get_historical_volatility', { currency: cfg.vol });
  const rv = rvSeries.length ? rvSeries[rvSeries.length - 1][1] : null;
  const dvol = cfg.dvol ? (await api('get_index_price', { index_name: cfg.dvol })).index_price : null;
  const inst = (await api('get_instruments', { currency: cfg.currency, kind: 'option', expired: 'false' }))
    .filter(i => i.instrument_name.startsWith(cfg.prefix));
  const expiries = [...new Set(inst.map(i => i.expiration_timestamp))]
    .filter(e => (e - now) / 864e5 >= MIN_DAYS && (e - now) / 864e5 <= MAX_DAYS)
    .sort((a, b) => a - b);
  const atm = [];
  for (const e of expiries) {
    const rows = inst.filter(i => i.expiration_timestamp === e);
    const k = rows.reduce((best, i) => Math.abs(i.strike - spot) < Math.abs(best - spot) ? i.strike : best, rows[0].strike);
    // call and put at one strike share the same mark IV on Deribit, so one ticker is enough
    const name = rows.find(i => i.strike === k).instrument_name;
    const t = await api('ticker', { instrument_name: name });
    atm.push({ e, k, iv: r1(t.mark_iv) });
  }
  entries.push({ t: now, asset, spot: Math.round(spot * 100) / 100, rv: r1(rv), dvol: r1(dvol), atm });
  console.log(`${asset}: spot ${spot} rv ${r1(rv)} dvol ${r1(dvol)} atm ${atm.map(a => a.iv).join('/')}`);
}

let history = [];
try { history = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* first run */ }
history.push(...entries);
writeFileSync(FILE, '[\n' + history.map(e => JSON.stringify(e)).join(',\n') + '\n]\n');
console.log(`history now has ${history.length} entries`);
