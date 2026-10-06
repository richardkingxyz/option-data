// Platform statistics for an options program on Solana, decoded from the program's
// own event logs, written encrypted to data/stats.enc for the workstation page.
// Run by the snapshot workflow. Needs env: RPC_URL (an RPC endpoint with history,
// e.g. a Helius URL with the key in it), PROGRAM_ID, WORKSTATION_PASSWORD.
//
// Why logs and not accounts: option accounts are closed when the seller withdraws,
// so the chain's current state forgets settled options. Every instruction emits an
// Anchor event, and those stay in the transaction logs forever.
//
// Definitions (keep in step with the workstation's stats view):
//   premium_gross   what the buyer paid (the OptionCreated.premium field)
//   premium_net     what reached the seller: gross minus the protocol's premium fee
//   notional        size x the asset's price at the moment of sale (Deribit hourly candle)
//   collateral_usd  what the seller locked: the asset at the price at sale for calls,
//                   the USDC itself for puts
//   apr             the seller's return: premium_net / collateral_usd x 365 / days to expiry
//   payouts / fees  are denominated in the COLLATERAL token (asset for calls, USDC for
//                   puts) and are converted to USD at the price on the day

import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { encrypt } from '../pro/crypto.mjs';

const RPC = process.env.RPC_URL;
const PROGRAM = process.env.PROGRAM_ID;
const PASSWORD = process.env.WORKSTATION_PASSWORD;
if (!RPC || !PROGRAM || !PASSWORD) throw new Error('RPC_URL, PROGRAM_ID and WORKSTATION_PASSWORD are required');

const MINTS = {
  So11111111111111111111111111111111111111112: { asset: 'SOL', decimals: 9 },
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: { asset: 'BTC', decimals: 8 },
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { asset: 'USDC', decimals: 6 },
};
const DECIMALS = { SOL: 9, BTC: 8 };
const QUOTE = 1e6;   // USDC
const CANDLES = { SOL: 'SOL_USDC-PERPETUAL', BTC: 'BTC-PERPETUAL' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rpc(method, params) {
  for (let a = 0; ; a++) {
    const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429 && a < 8) { await sleep(400 * 2 ** a); continue; }
    const j = await r.json();
    if (j.error) { if (a < 5) { await sleep(600); continue; } throw new Error(JSON.stringify(j.error)); }
    return j.result;
  }
}

// --- base58 for 32-byte keys ---
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58(bytes) {
  let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
  let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  let z = 0; for (const b of bytes) { if (b !== 0) break; z++; }
  return '1'.repeat(z) + s;
}
class Reader {
  constructor(buf) { this.b = buf; this.i = 8; }
  u8() { return this.b[this.i++]; }
  u64() { const v = this.b.readBigUInt64LE(this.i); this.i += 8; return Number(v); }
  i64() { const v = this.b.readBigInt64LE(this.i); this.i += 8; return Number(v); }
  pk() { const v = b58(this.b.subarray(this.i, this.i + 32)); this.i += 32; return v; }
}
const EVENTS = ['OptionCreated', 'OptionSettled', 'OptionAdminSettled', 'OptionForceSettled', 'OptionSellerWithdrawn', 'ProtocolFeeCollected'];
const DISC = new Map(EVENTS.map(n => [createHash('sha256').update(`event:${n}`).digest().subarray(0, 8).toString('hex'), n]));
const OTYPE = ['Call', 'Put'], OUTCOME = ['Otm', 'ItmExercised', 'ItmForfeit', 'ForcedToSeller'], FEE = ['Premium', 'Settlement'];

// --- 1. every transaction the program was part of ---
let before, sigs = [];
for (;;) {
  const page = await rpc('getSignaturesForAddress', [PROGRAM, { limit: 1000, ...(before ? { before } : {}) }]);
  sigs.push(...page);
  if (page.length < 1000) break;
  before = page[page.length - 1].signature;
}
const good = sigs.filter(s => !s.err);
console.log(`signatures: ${sigs.length} (${sigs.length - good.length} failed)`);

// --- 2. logs + accounts of each successful one ---
const txs = [];
for (const s of good) {
  const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
  if (tx) txs.push({ sig: s.signature, blockTime: tx.blockTime, logs: tx.meta.logMessages ?? [], instructions: tx.transaction.message.instructions });
  await sleep(110);
}

// --- 3. decode events ---
const events = [];
for (const t of txs) {
  for (const l of t.logs) {
    if (!l.startsWith('Program data: ')) continue;
    const raw = Buffer.from(l.slice(14), 'base64');
    const name = DISC.get(raw.subarray(0, 8).toString('hex'));
    if (!name) continue;
    const r = new Reader(raw);
    let e;
    if (name === 'OptionCreated') e = { option_id: r.u64(), seller: r.pk(), buyer: r.pk(), otype: OTYPE[r.u8()], strike: r.u64(), size: r.u64(), premium: r.u64(), collateral: r.u64(), expiry: r.i64() };
    else if (name === 'OptionSettled') e = { option_id: r.u64(), seller: r.pk(), buyer: r.pk(), outcome: OUTCOME[r.u8()], settlement_price: r.u64(), buyer_payout: r.u64(), settled_at: r.i64() };
    else if (name === 'OptionAdminSettled') e = { option_id: r.u64(), seller: r.pk(), buyer: r.pk(), settlement_price: r.u64(), outcome: OUTCOME[r.u8()], buyer_payout: r.u64(), settled_at: r.i64() };
    else if (name === 'OptionForceSettled') e = { option_id: r.u64(), seller: r.pk(), buyer: r.pk(), settler: r.pk(), settled_at: r.i64(), outcome: 'ForcedToSeller', settlement_price: 0, buyer_payout: 0 };
    else if (name === 'OptionSellerWithdrawn') e = { option_id: r.u64(), seller: r.pk(), outcome: OUTCOME[r.u8()], mint: r.pk(), amount: r.u64(), withdrawn_at: r.i64() };
    else if (name === 'ProtocolFeeCollected') e = { option_id: r.u64(), fee_type: FEE[r.u8()], amount: r.u64(), mint: r.pk(), treasury: r.pk() };
    events.push({ ...e, event: name, sig: t.sig, t: t.blockTime });
  }
}

// --- 4. which asset each option is on: the create instruction's token_pair (acct 3) and collateral_mint (acct 9) ---
const pairAsset = new Map(), createPair = new Map();
for (const t of txs) {
  if (!t.logs.some(l => l.includes('Instruction: CreateOption'))) continue;
  for (const ins of t.instructions) {
    if (ins.programId !== PROGRAM || !ins.accounts || ins.accounts.length < 10) continue;
    const pair = ins.accounts[3], mint = MINTS[ins.accounts[9]];
    if (mint && mint.asset !== 'USDC') pairAsset.set(pair, mint.asset);
    createPair.set(t.sig, pair);
  }
}

// --- 5. prices at the time of each event, from Deribit hourly candles ---
const firstT = Math.min(...txs.map(t => t.blockTime)) * 1000 - 3600e3;
const candles = {};
for (const [asset, inst] of Object.entries(CANDLES)) {
  const r = await fetch(`https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=${inst}&start_timestamp=${firstT}&end_timestamp=${Date.now()}&resolution=60`).then(r => r.json());
  candles[asset] = { ticks: r.result.ticks, close: r.result.close };
}
function priceAt(asset, ms) {
  const { ticks, close } = candles[asset];
  let lo = 0, hi = ticks.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ticks[mid] <= ms) lo = mid; else hi = mid - 1; }
  return close[lo];
}

// --- 6. assemble options ---
const opts = new Map();
const key = e => `${e.seller}:${e.option_id}`;
for (const e of events) {
  if (e.event !== 'OptionCreated') continue;
  const asset = pairAsset.get(createPair.get(e.sig)) ?? (e.strike > 1e9 ? 'BTC' : 'SOL');
  const size = e.size / 10 ** DECIMALS[asset], strike = e.strike / QUOTE, premium = e.premium / QUOTE;
  const spot = priceAt(asset, e.t * 1000), days = (e.expiry - e.t) / 86400, notional = size * spot;
  const collateral_usd = e.otype === 'Call' ? e.collateral / 10 ** DECIMALS[asset] * spot : e.collateral / QUOTE;
  opts.set(key(e), { seller: e.seller, buyer: e.buyer, option_id: e.option_id, asset, otype: e.otype, size, strike, spot, premium_gross: premium, fee: 0, settle_fee_usd: 0,
    created: e.t, expiry: e.expiry, days, notional, collateral_usd,
    outcome: null, settlement_price: null, buyer_payout_usd: 0, settled_at: null, withdrawn_at: null });
}
const bySig = new Map();
for (const e of events) if (e.event === 'OptionCreated' || e.event.startsWith('OptionSettled') || e.event === 'OptionAdminSettled') (bySig.get(e.sig) ?? bySig.set(e.sig, []).get(e.sig)).push(e);
for (const e of events) {
  if (e.event === 'ProtocolFeeCollected') {
    // fee events carry the option id but not the seller: pair them with the option event in the same transaction
    const sib = (bySig.get(e.sig) ?? []).find(x => x.option_id === e.option_id);
    const o = sib && opts.get(key(sib));
    if (!o) continue;
    const m = MINTS[e.mint];
    const usd = !m || m.asset === 'USDC' ? e.amount / QUOTE : e.amount / 10 ** m.decimals * priceAt(m.asset, e.t * 1000);
    if (e.fee_type === 'Premium') o.fee += usd; else o.settle_fee_usd += usd;
  } else if (e.event === 'OptionSettled' || e.event === 'OptionAdminSettled' || e.event === 'OptionForceSettled') {
    const o = opts.get(key(e));
    if (!o) continue;
    o.outcome = e.outcome; o.settlement_price = e.settlement_price / QUOTE; o.settled_at = e.settled_at;
    // payout is in the collateral token: the asset for calls, USDC for puts
    o.buyer_payout_usd = o.otype === 'Call' ? e.buyer_payout / 10 ** DECIMALS[o.asset] * priceAt(o.asset, e.settled_at * 1000) : e.buyer_payout / QUOTE;
  } else if (e.event === 'OptionSellerWithdrawn') {
    const o = opts.get(key(e));
    if (o) o.withdrawn_at = e.withdrawn_at;
  }
}
// apr waits until here because it is on the net premium, and the fee arrives in its own event
const L = [...opts.values()].map(o => { const premium_net = o.premium_gross - o.fee; return { ...o, premium_net, apr: o.collateral_usd > 0 && o.days > 0 ? premium_net / o.collateral_usd * 365 / o.days * 100 : null }; });

// --- 7. statistics ---
const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const mean = a => a.length ? sum(a, x => x) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sellers = new Map();
for (const o of L) (sellers.get(o.seller) ?? sellers.set(o.seller, []).get(o.seller)).push(o);
const withApr = L.filter(o => o.apr != null);
const settled = L.filter(o => o.outcome);
const isoWeek = ts => { const d = new Date(ts * 1000); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); const y = d.getUTCFullYear(); const jan4 = new Date(Date.UTC(y, 0, 4)); const w = 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7); return `${y}-W${String(w).padStart(2, '0')}`; };
const weekly = {};
for (const o of L) { const w = weekly[isoWeek(o.created)] ??= { options: 0, premium_gross: 0, premium_net: 0, notional: 0, sellers: new Set() }; w.options++; w.premium_gross += o.premium_gross; w.premium_net += o.premium_net; w.notional += o.notional; w.sellers.add(o.seller); }
const group = (f) => { const g = {}; for (const o of L) { const k = f(o); const x = g[k] ??= { options: 0, premium_gross: 0, premium_net: 0, notional: 0, aprs: [] }; x.options++; x.premium_gross += o.premium_gross; x.premium_net += o.premium_net; x.notional += o.notional; if (o.apr != null) x.aprs.push(o.apr); } for (const x of Object.values(g)) { x.apr_mean = mean(x.aprs); delete x.aprs; } return g; };

const stats = {
  asOf: new Date().toISOString(),
  program: PROGRAM,
  since: Math.min(...L.map(o => o.created)),
  counts: { options: L.length, sellers: sellers.size, buyers: new Set(L.map(o => o.buyer)).size, repeat_sellers: [...sellers.values()].filter(v => v.length > 1).length, open: L.filter(o => !o.outcome).length, settled: settled.length, transactions: sigs.length, failed_transactions: sigs.length - good.length },
  premium: { gross: sum(L, o => o.premium_gross), net_to_sellers: sum(L, o => o.premium_net), protocol_fee_premium: sum(L, o => o.fee), protocol_fee_settlement: sum(L, o => o.settle_fee_usd) },
  notional: { total: sum(L, o => o.notional), open: sum(L.filter(o => !o.outcome), o => o.notional) },
  apr: { per_option_mean: mean(withApr.map(o => o.apr)), per_option_median: median(withApr.map(o => o.apr)), notional_weighted: sum(withApr, o => o.apr * o.notional) / sum(withApr, o => o.notional),
    per_wallet_mean: mean([...sellers.values()].map(v => mean(v.filter(o => o.apr != null).map(o => o.apr))).filter(x => x != null)),
    per_wallet_median: median([...sellers.values()].map(v => mean(v.filter(o => o.apr != null).map(o => o.apr))).filter(x => x != null)) },
  outcomes: Object.fromEntries(['Otm', 'ItmExercised', 'ItmForfeit', 'ForcedToSeller'].map(k => [k, settled.filter(o => o.outcome === k).length])),
  itm_payout_usd: sum(settled, o => o.buyer_payout_usd),
  durations: { mean_days: mean(L.map(o => o.days)), median_days: median(L.map(o => o.days)), min_days: Math.min(...L.map(o => o.days)), max_days: Math.max(...L.map(o => o.days)) },
  size: { mean_notional: mean(L.map(o => o.notional)), median_notional: median(L.map(o => o.notional)), max_notional: Math.max(...L.map(o => o.notional)) },
  strike_distance_median_pct: median(L.map(o => Math.abs(o.strike / o.spot - 1) * 100)),
  by_asset: group(o => o.asset),
  by_type: group(o => o.otype),
  weekly: Object.fromEntries(Object.entries(weekly).sort().map(([k, v]) => [k, { ...v, sellers: v.sellers.size }])),
  top_sellers: [...sellers.entries()].map(([w, v]) => ({ wallet: w, options: v.length, premium_gross: sum(v, o => o.premium_gross), premium_net: sum(v, o => o.premium_net), notional: sum(v, o => o.notional), apr_mean: mean(v.filter(o => o.apr != null).map(o => o.apr)), first: Math.min(...v.map(o => o.created)), last: Math.max(...v.map(o => o.created)) })).sort((a, b) => b.premium_gross - a.premium_gross),
  options: L.sort((a, b) => b.created - a.created),
};

writeFileSync(new URL('../data/stats.enc', import.meta.url), await encrypt(JSON.stringify(stats), PASSWORD));
console.log(`stats.enc: ${L.length} options, ${sellers.size} sellers, gross premium $${stats.premium.gross.toFixed(2)}, net $${stats.premium.net_to_sellers.toFixed(2)}`);
