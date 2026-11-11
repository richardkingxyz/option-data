// Weekly order-flow digest: reads data/orderflow/<ISO week>.json (default: the week that just
// ended) and writes data/orderflow/digest/<week>.json for the page, <week>.md for Telegram
// (plain text, under 4,096 characters) and digest/index.json (the list of weeks for the picker).
//
// Telegram posting is OFF unless all three are set: env TG_BOT_TOKEN, TG_CHAT_ID (GitHub secrets)
// and ORDERFLOW_TG_ENABLED=true (GitHub repository variable). Nothing in here needs a key otherwise.
// Run by hand: node scripts/weekly-digest.mjs [2026-W45]
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { previousWeek, weekRange, shortWallet, fmtUsd, fmtSize, DISCLAIMER, UNDERLYINGS, VENUES } from './orderflow-lib.mjs';

const DIR = fileURLToPath(new URL('../data/orderflow/', import.meta.url));
const OUT = DIR + 'digest/';
const TG_LIMIT = 4096;
const week = process.argv[2] || previousWeek();
const range = weekRange(week);
if (!range) { console.error(`bad week key: ${week}`); process.exit(1); }
if (!existsSync(DIR + `${week}.json`)) { console.log(`no trades recorded for ${week}, nothing to digest`); process.exit(0); }
const trades = JSON.parse(readFileSync(DIR + `${week}.json`, 'utf8')).filter(t => t.ts >= range.start && t.ts < range.end);
mkdirSync(OUT, { recursive: true });

const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);
const r0 = x => Math.round(x);
const bucket = (xs, key) => { const m = new Map(); for (const x of xs) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
const top = (m, n) => [...m].map(([k, xs]) => ({ key: k, trades: xs.length, premiumUsd: r0(sum(xs, t => t.premiumUsd)) })).sort((a, b) => b.premiumUsd - a.premiumUsd).slice(0, n);
const day = ts => new Date(ts).toISOString().slice(0, 10);

// 1. totals by underlying and venue
const totals = { trades: trades.length, premiumUsd: r0(sum(trades, t => t.premiumUsd)), byUnderlying: {}, byVenue: {} };
for (const u of UNDERLYINGS) { const xs = trades.filter(t => t.underlying === u); totals.byUnderlying[u] = { trades: xs.length, premiumUsd: r0(sum(xs, t => t.premiumUsd)) }; }
for (const v of VENUES) { const xs = trades.filter(t => t.venue === v); totals.byVenue[v] = { trades: xs.length, premiumUsd: r0(sum(xs, t => t.premiumUsd)) }; }
// 2. top 10 by premium
const top10 = [...trades].sort((a, b) => b.premiumUsd - a.premiumUsd).slice(0, 10).map(t => ({
  date: day(t.ts), venue: t.venue, instrument: t.instrument, side: t.side === 'buy' ? 'bought' : 'sold', size: t.size,
  premiumUsd: r0(t.premiumUsd), notionalUsd: r0(t.notionalUsd), iv: t.iv, moneynessPct: t.moneynessPct, block: t.block, rfq: t.rfq,
}));
// 3. calls vs puts, bought vs sold (taker side), premium per underlying
const buckets = {};
for (const u of UNDERLYINGS) {
  buckets[u] = {};
  for (const type of ['call', 'put']) for (const side of ['buy', 'sell']) {
    const xs = trades.filter(t => t.underlying === u && t.type === type && t.side === side);
    buckets[u][`${type}_${side === 'buy' ? 'bought' : 'sold'}`] = { trades: xs.length, premiumUsd: r0(sum(xs, t => t.premiumUsd)) };
  }
}
// 4. most active strikes and expiries by premium, per underlying
const active = {};
for (const u of UNDERLYINGS) {
  const xs = trades.filter(t => t.underlying === u);
  active[u] = { strikes: top(bucket(xs, t => `${t.strike}${t.type === 'call' ? 'C' : 'P'}`), 5), expiries: top(bucket(xs, t => t.expiry), 5) };
}
// 5. block trades
const blocks = trades.filter(t => t.block);
const blockStats = { trades: blocks.length, premiumUsd: r0(sum(blocks, t => t.premiumUsd)), premiumSharePct: totals.premiumUsd ? Math.round(1000 * sum(blocks, t => t.premiumUsd) / totals.premiumUsd) / 10 : 0 };
// 6. Derive wallets seen 3+ times
const wallets = [...bucket(trades.filter(t => t.venue === 'derive' && t.wallet), t => t.wallet)]
  .filter(([, xs]) => xs.length >= 3)
  .map(([w, xs]) => ({ wallet: shortWallet(w), trades: xs.length, premiumUsd: r0(sum(xs, t => t.premiumUsd)) }))
  .sort((a, b) => b.premiumUsd - a.premiumUsd);

const digest = { week, start: day(range.start), end: day(range.end - 1), totals, top10, buckets, active, blocks: blockStats, repeatWallets: wallets, disclaimer: DISCLAIMER };
// Rewritten only when the numbers changed, so a re-run on the same data makes no commit.
const prev = existsSync(OUT + `${week}.json`) ? JSON.parse(readFileSync(OUT + `${week}.json`, 'utf8')) : null;
const same = prev && JSON.stringify({ ...prev, generated: undefined }) === JSON.stringify({ ...digest, generated: undefined });
if (!same) writeFileSync(OUT + `${week}.json`, JSON.stringify({ ...digest, generated: new Date().toISOString() }, null, 1) + '\n');

// Plain text for Telegram (no parse_mode, so underscores and dashes in instrument names are safe).
function render(limits) {
  const L = [];
  L.push(`CRYPTO OPTION ORDER FLOW, week ${week} (${digest.start} to ${digest.end}, UTC)`);
  L.push(`Large trades on Deribit and Derive. Side = the taker.`);
  L.push('');
  L.push(`TOTALS: ${totals.trades} trades, ${fmtUsd(totals.premiumUsd)} premium`);
  for (const u of UNDERLYINGS) L.push(`  ${u}: ${totals.byUnderlying[u].trades} trades, ${fmtUsd(totals.byUnderlying[u].premiumUsd)}`);
  for (const v of VENUES) L.push(`  ${v}: ${totals.byVenue[v].trades} trades, ${fmtUsd(totals.byVenue[v].premiumUsd)}`);
  L.push('');
  L.push(`TOP ${Math.min(limits.top, top10.length)} BY PREMIUM`);
  for (const t of top10.slice(0, limits.top)) L.push(`  ${t.date.slice(5)} ${t.venue} ${t.instrument} ${t.side} ${fmtSize(t.size)} for ${fmtUsd(t.premiumUsd)}${t.iv != null ? `, IV ${t.iv}%` : ''}, ${t.moneynessPct > 0 ? '+' : ''}${t.moneynessPct}% from spot${t.block ? ', block' : ''}${t.rfq ? ', rfq' : ''}`);
  L.push('');
  L.push('CALLS VS PUTS, BOUGHT VS SOLD (premium)');
  for (const u of UNDERLYINGS) { const b = buckets[u]; L.push(`  ${u}: calls bought ${fmtUsd(b.call_bought.premiumUsd)}, calls sold ${fmtUsd(b.call_sold.premiumUsd)}, puts bought ${fmtUsd(b.put_bought.premiumUsd)}, puts sold ${fmtUsd(b.put_sold.premiumUsd)}`); }
  L.push('');
  L.push('MOST ACTIVE (premium)');
  for (const u of UNDERLYINGS) {
    const a = active[u]; if (!a.strikes.length) continue;
    L.push(`  ${u} strikes: ${a.strikes.slice(0, limits.active).map(s => `${s.key} ${fmtUsd(s.premiumUsd)}`).join(', ')}`);
    L.push(`  ${u} expiries: ${a.expiries.slice(0, limits.active).map(s => `${s.key} ${fmtUsd(s.premiumUsd)}`).join(', ')}`);
  }
  L.push('');
  L.push(`BLOCK TRADES: ${blockStats.trades} trades, ${fmtUsd(blockStats.premiumUsd)} premium, ${blockStats.premiumSharePct}% of the week's premium`);
  L.push('');
  L.push(`DERIVE WALLETS SEEN 3+ TIMES: ${wallets.length}`);
  for (const w of wallets.slice(0, limits.wallets)) L.push(`  ${w.wallet}: ${w.trades} trades, ${fmtUsd(w.premiumUsd)}`);
  if (wallets.length > limits.wallets) L.push(`  and ${wallets.length - limits.wallets} more`);
  L.push('');
  L.push(DISCLAIMER);
  return L.join('\n');
}
let limits = { top: 10, active: 5, wallets: 10 }, text = render(limits);
while (text.length > TG_LIMIT && (limits.top > 3 || limits.active > 2 || limits.wallets > 3)) {
  limits = { top: Math.max(3, limits.top - 1), active: Math.max(2, limits.active - 1), wallets: Math.max(3, limits.wallets - 1) };
  text = render(limits);
}
if (text.length > TG_LIMIT) text = text.slice(0, TG_LIMIT - DISCLAIMER.length - 2).replace(/\n[^\n]*$/, '') + '\n\n' + DISCLAIMER;
if (!existsSync(OUT + `${week}.md`) || readFileSync(OUT + `${week}.md`, 'utf8') !== text + '\n') writeFileSync(OUT + `${week}.md`, text + '\n');

const weeks = readdirSync(OUT).filter(f => /^\d{4}-W\d{2}\.json$/.test(f)).map(f => f.slice(0, -5)).sort().reverse();
const index = JSON.stringify({ weeks, latest: weeks[0] || null }) + '\n';
if (!existsSync(OUT + 'index.json') || readFileSync(OUT + 'index.json', 'utf8') !== index) writeFileSync(OUT + 'index.json', index);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `week=${week}\n`);
console.log(`digest ${week}: ${totals.trades} trades, ${fmtUsd(totals.premiumUsd)} premium, text ${text.length} chars -> digest/${week}.json + .md`);

// Telegram, off unless explicitly enabled.
const { TG_BOT_TOKEN, TG_CHAT_ID, ORDERFLOW_TG_ENABLED } = process.env;
if (TG_BOT_TOKEN && TG_CHAT_ID && ORDERFLOW_TG_ENABLED === 'true') {
  const r = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT_ID, text, disable_web_page_preview: true }),
  });
  const j = await r.json().catch(() => ({}));
  console.log(j.ok ? 'telegram: posted' : `telegram: failed (${r.status} ${j.description || ''})`);
} else {
  console.log('telegram: off' + (TG_BOT_TOKEN && TG_CHAT_ID ? ' (set repository variable ORDERFLOW_TG_ENABLED=true to post)' : ''));
}
