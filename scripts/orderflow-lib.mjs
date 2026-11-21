// Order flow: one module shared by the collector (Node), the weekly digest (Node) and the
// flow page (browser, <script type="module">). No dependencies, no Node-only APIs.
//
// A "trade record" is one shape for both venues:
//   id            "deribit:463787832" | "derive:<uuid>"
//   venue         "deribit" | "derive"
//   ts            trade time, ms since epoch
//   underlying    "BTC" | "ETH" | "SOL"
//   instrument    venue's instrument name as given
//   type          "call" | "put"
//   strike        number
//   expiry        "YYYY-MM-DD" (both venues expire 08:00 UTC)
//   dte           days to expiry at trade time, one decimal
//   side          taker side: "buy" | "sell"
//   size          contracts in base coin (BTC, ETH or SOL)
//   index         index price at the trade, USD
//   notionalUsd   size * index
//   premiumUsd    what the taker paid or received
//                   Deribit BTC/ETH: price is in coin -> price * size * index
//                   Deribit SOL_USDC: price is USDC per SOL -> price * size
//                   Derive: trade_price is USDC per contract -> price * size
//   iv            Deribit trade IV in %; null on Derive (not published with trades)
//   moneynessPct  (strike / index - 1) * 100
//   block         Deribit block trade (block_trade_id or block_rfq_id present)
//   rfq           Derive RFQ trade
//   group         id shared by the legs of one block / combo / RFQ, else null
//   liq           Deribit liquidation trade
//   wallet        Derive wallet address (full); show it with shortWallet()

export const UNDERLYINGS = ['BTC', 'ETH', 'SOL'];
export const VENUES = ['deribit', 'derive'];
export const EXPIRY_HOUR_UTC = 8;

const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
const pad = n => String(n).padStart(2, '0');
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const r2 = x => Math.round(x * 100) / 100;

// "BTC-26DEC26-95000-C" (Deribit), "SOL_USDC-26DEC26-200-C" (Deribit linear, decimals written
// with a "d": "82d5"), "BTC-20261226-95000-C" (Derive). Null for anything else.
export function parseInstrument(name) {
  const parts = String(name || '').split('-');
  if (parts.length !== 4) return null;
  const [base, d, strikeStr, cp] = parts;
  const type = cp === 'C' ? 'call' : cp === 'P' ? 'put' : null;
  const strike = Number(strikeStr.replace('d', '.'));
  let y, m, day;
  if (/^\d{8}$/.test(d)) { y = +d.slice(0, 4); m = +d.slice(4, 6) - 1; day = +d.slice(6, 8); }
  else {
    const mm = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(d);
    if (!mm || !(mm[2] in MONTHS)) return null;
    y = 2000 + +mm[3]; m = MONTHS[mm[2]]; day = +mm[1];
  }
  if (!type || !isNum(strike) || strike <= 0) return null;
  const expiryTs = Date.UTC(y, m, day, EXPIRY_HOUR_UTC);
  return { underlying: base.split('_')[0], type, strike, expiry: `${y}-${pad(m + 1)}-${pad(day)}`, expiryTs };
}

function build(x) {
  const p = x.p;
  if (!p || !isNum(x.size) || !isNum(x.index) || x.size <= 0 || x.index <= 0 || !isNum(x.ts)) return null;
  return {
    id: x.id, venue: x.venue, ts: x.ts,
    underlying: p.underlying, instrument: x.instrument, type: p.type, strike: p.strike, expiry: p.expiry,
    dte: Math.round((p.expiryTs - x.ts) / 864e5 * 10) / 10,
    side: x.side === 'buy' ? 'buy' : 'sell',
    size: x.size, index: r2(x.index),
    notionalUsd: r2(x.size * x.index),
    premiumUsd: r2(x.premiumUsd),
    iv: isNum(x.iv) ? x.iv : null,
    moneynessPct: r2((p.strike / x.index - 1) * 100),
    block: !!x.block, rfq: !!x.rfq, group: x.group || null, liq: !!x.liq,
    wallet: x.wallet || null,
  };
}

// Deribit trade as returned by public/get_last_trades_by_currency_and_time and by the
// trades.option.<CUR>.100ms subscription (same fields).
export function fromDeribit(t) {
  if (!t || !t.instrument_name) return null;
  const linear = t.instrument_name.includes('_');   // SOL_USDC etc: price quoted in USDC per coin
  const size = Number(t.amount), index = Number(t.index_price), price = Number(t.price);
  return build({
    id: 'deribit:' + t.trade_id, venue: 'deribit', ts: Number(t.timestamp), instrument: t.instrument_name,
    p: parseInstrument(t.instrument_name), side: t.direction, size, index,
    premiumUsd: linear ? price * size : price * size * index,
    iv: Number(t.iv), block: !!(t.block_trade_id || t.block_rfq_id), rfq: false,
    group: t.block_trade_id || t.combo_id || null, liq: !!t.liquidation, wallet: null,
  });
}

// Derive trade as returned by public/get_trade_history and by trades.option.<CUR>.
// Every match is listed once per side; callers keep the taker row (see takerOnly) so that
// `side` is the aggressor, as on Deribit.
export function fromDerive(t) {
  if (!t || !t.instrument_name) return null;
  const size = Number(t.trade_amount), price = Number(t.trade_price), index = Number(t.index_price);
  return build({
    id: 'derive:' + t.trade_id, venue: 'derive', ts: Number(t.timestamp), instrument: t.instrument_name,
    p: parseInstrument(t.instrument_name), side: t.direction, size, index,
    premiumUsd: price * size, iv: null, block: false, rfq: !!t.rfq_id, group: t.rfq_id || null, liq: false,
    wallet: t.wallet || null,
  });
}

// Derive rows -> one per trade_id, preferring the taker row.
export function takerOnly(rows) {
  const by = new Map();
  for (const t of rows) {
    const prev = by.get(t.trade_id);
    if (!prev || (prev.liquidity_role !== 'taker' && t.liquidity_role === 'taker')) by.set(t.trade_id, t);
  }
  return [...by.values()];
}

export const DEFAULT_CONFIG = {
  alwaysInclude: { block: true, rfq: false },
  minNotionalUsd: { BTC: 2500000, ETH: 1000000, SOL: 50000 },
  minPremiumUsd: { BTC: 50000, ETH: 25000, SOL: 2500 },
  derive: { minNotionalUsd: 250000 },
  excludeLiquidations: true,
};

const pick = (x, u) => x == null ? null : typeof x === 'number' ? x : (isNum(x[u]) ? x[u] : null);

// The one rule for "large", used by the collector and the live page alike. A venue block
// (cfg.derive / cfg.deribit) can override the thresholds for that venue; otherwise the
// per-underlying numbers apply. An underlying with no threshold at all is never kept.
export function isLarge(r, cfg = DEFAULT_CONFIG) {
  if (!r) return false;
  if (cfg.excludeLiquidations !== false && r.liq) return false;
  const ai = cfg.alwaysInclude || {};
  if (ai.block && r.block) return true;
  if (ai.rfq && r.rfq) return true;
  const v = cfg[r.venue] || {};
  const minN = pick(v.minNotionalUsd, r.underlying) ?? pick(cfg.minNotionalUsd, r.underlying);
  const minP = pick(v.minPremiumUsd, r.underlying) ?? pick(cfg.minPremiumUsd, r.underlying);
  return (minN != null && r.notionalUsd >= minN) || (minP != null && r.premiumUsd >= minP);
}

// Apply isLarge to a batch, then pull in every other leg of a block / combo / RFQ that had
// at least one large leg, so multi-leg trades stay whole.
export function keepLarge(records, cfg = DEFAULT_CONFIG) {
  const kept = records.filter(r => isLarge(r, cfg));
  const groups = new Set(kept.filter(r => r.group).map(r => r.venue + ':' + r.group));
  if (!groups.size) return kept;
  const ids = new Set(kept.map(r => r.id));
  for (const r of records) {
    if (r.group && groups.has(r.venue + ':' + r.group) && !ids.has(r.id) && !(cfg.excludeLiquidations !== false && r.liq)) { kept.push(r); ids.add(r.id); }
  }
  return kept;
}

// ISO week key "2026-W46" for a timestamp, and the [start, end) of a key, UTC.
export function isoWeek(ts) {
  const d = new Date(ts);
  const day = (d.getUTCDay() + 6) % 7;                       // Monday = 0
  const thu = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3);
  const y = new Date(thu).getUTCFullYear();
  const jan4 = Date.UTC(y, 0, 4);
  const week = 1 + Math.round(((thu - jan4) / 864e5 - 3 + (new Date(jan4).getUTCDay() + 6) % 7) / 7);
  return `${y}-W${pad(week)}`;
}
export function weekRange(key) {
  const m = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!m) return null;
  const jan4 = Date.UTC(+m[1], 0, 4);
  const monday1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 864e5;
  const start = monday1 + (+m[2] - 1) * 7 * 864e5;
  return { start, end: start + 7 * 864e5 };
}
export function previousWeek(ts = Date.now()) { return isoWeek(weekRange(isoWeek(ts)).start - 864e5); }

// Display helpers, shared so the page and the digest print the same numbers.
export function shortWallet(w) { return w ? `${w.slice(0, 4)}…${w.slice(-4)}` : ''; }
export function fmtUsd(n) {
  if (!isNum(n)) return '--';
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${s}$${Math.round(a / 1e3)}k`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}k`;
  return `${s}$${Math.round(a)}`;
}
export function fmtSize(n) { return isNum(n) ? (Math.abs(n) >= 100 ? Math.round(n).toLocaleString('en-US') : String(Math.round(n * 100) / 100)) : '--'; }
export const DISCLAIMER = 'Market data and education only, not financial advice.';
