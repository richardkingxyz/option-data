// Audit of the PnL figures against what actually moved on chain, per option. Pure functions;
// the stats job feeds them and ships the summary in stats.enc for the workstation's
// methodology tooltip. Every check is one of: match, mismatch, pending (not happened yet),
// unverified (the data did not let us decide). Nothing here changes a PnL number.
//
//   withdrawal   the OptionSellerWithdrawn event's mint + amount vs what the PnL model assumes
//                the seller gets back (collateral if not exercised; strike x size USDC for an
//                exercised call; the coin for an exercised put)
//   flow pnl     premium net + what was withdrawn (valued at the settlement price) - what was
//                locked (valued at the price at sale): must equal total pnl to the cent
//   premium      the seller's USDC balance change in the create transaction vs premium net
//                (puts also lock USDC in the same transaction, so that is netted off)
//   collateral   the seller's coin balance change in the create transaction vs size (calls)
//   settlement   the program's settlement price vs Deribit's minute close at that moment
//   fees         premium fee as % of gross, settlement fee as % of the in-the-money amount

const near = (a, b, tol) => Math.abs(a - b) <= tol;

export function expectedWithdrawal(o) {
  if (!o.outcome) return null;
  const coinTol = 2 / 10 ** o.asset_decimals, usdcTol = 0.00002;
  if (o.outcome === 'ItmExercised') {
    return o.otype === 'Call' ? { asset: 'USDC', amount: o.strike * o.size, tol: usdcTol } : { asset: o.asset, amount: o.size, tol: coinTol };
  }
  // Otm, ItmForfeit, ForcedToSeller: the collateral comes back
  return o.otype === 'Call' ? { asset: o.asset, amount: o.collateral_units, tol: coinTol } : { asset: 'USDC', amount: o.collateral_units, tol: usdcTol };
}

// o: an option record with pnl fields. create/withdraw: { sellerUsdc, sellerCoin, sellerLamports, fee, feePayer } or null.
export function auditOption(o, create, withdraw, settleMarket) {
  const a = {};
  // 1. withdrawal vs model
  const exp = expectedWithdrawal(o);
  if (!exp) a.withdraw = null;
  else if (o.withdrawn_amount == null) a.withdraw = 'pending';
  else a.withdraw = o.withdrawn_asset === exp.asset && near(o.withdrawn_amount, exp.amount, exp.tol) ? 'match' : 'mismatch';
  a.withdraw_expected = exp;
  // 2. flow pnl from the actual withdrawal
  if (a.withdraw === 'match' || a.withdraw === 'mismatch') {
    const back = o.withdrawn_asset === 'USDC' ? o.withdrawn_amount : o.withdrawn_amount * o.mark;
    a.pnl_flow = o.premium_net + back - o.collateral_usd;
    a.flow_diff = a.pnl_flow - o.pnl_total;
  }
  // 3. premium receipt at creation (and USDC collateral for puts, locked in the same transaction)
  if (create && create.sellerUsdc != null) {
    const expected = o.premium_net - (o.otype === 'Put' ? o.collateral_units : 0);
    a.premium = near(create.sellerUsdc, expected, 0.00002) ? 'match' : 'mismatch';
    a.premium_delta = create.sellerUsdc; a.premium_expected = expected;
  } else a.premium = 'unverified';
  // 4. collateral lock for calls: the coin left the seller (token account), or for SOL, native lamports did
  if (o.otype === 'Call' && create) {
    if (create.sellerCoin != null && near(create.sellerCoin, -o.collateral_units, 2 / 10 ** o.asset_decimals)) a.collateral = 'match';
    else if (o.asset === 'SOL' && create.sellerLamports != null && near(create.sellerLamports / 1e9 + (create.feePayer === o.seller ? create.fee / 1e9 : 0), -o.collateral_units, 0.01)) a.collateral = 'match_native';
    else if (create.sellerCoin != null || create.sellerLamports != null) a.collateral = 'mismatch';
    else a.collateral = 'unverified';
  } else a.collateral = o.otype === 'Call' ? 'unverified' : null;
  // 5. settlement price vs market
  a.settle_vs_market_pct = o.outcome && o.settlement_price > 0 && settleMarket ? (o.settlement_price / settleMarket - 1) * 100 : null;
  // 6. fees
  a.premium_fee_pct = o.premium_gross > 0 ? o.fee / o.premium_gross * 100 : null;
  a.settle_fee_pct = o.outcome === 'ItmExercised' && o.given_up_usd > 0 ? o.settle_fee_usd / o.given_up_usd * 100 : null;
  // 7. gas the seller paid (create + withdraw transactions they signed)
  a.gas_sol = (create && create.feePayer === o.seller ? create.fee : 0) / 1e9 + (withdraw && withdraw.feePayer === o.seller ? withdraw.fee : 0) / 1e9;
  return a;
}

const count = (L, f) => L.filter(f).length;
const minmax = v => v.length ? { min: Math.min(...v), max: Math.max(...v), mean: v.reduce((s, x) => s + x, 0) / v.length } : null;

export function auditSummary(L) {
  const A = L.map(o => o.audit).filter(Boolean);
  const w = A.filter(a => a.withdraw);
  const mism = (key, f) => L.filter(o => o.audit && o.audit[key] === 'mismatch').slice(0, 10).map(f);
  const svm = A.map(a => a.settle_vs_market_pct).filter(x => x != null);
  const worst = L.filter(o => o.audit && o.audit.settle_vs_market_pct != null).sort((x, y) => Math.abs(y.audit.settle_vs_market_pct) - Math.abs(x.audit.settle_vs_market_pct))[0];
  const flows = A.map(a => a.flow_diff).filter(x => x != null);
  return {
    withdrawals: { checked: count(w, a => a.withdraw !== 'pending'), matched: count(w, a => a.withdraw === 'match'), mismatched: count(w, a => a.withdraw === 'mismatch'), pending: count(w, a => a.withdraw === 'pending'),
      mismatches: mism('withdraw', o => ({ wallet: o.seller, option_id: o.option_id, outcome: o.outcome, expected: o.audit.withdraw_expected, got: { asset: o.withdrawn_asset, amount: o.withdrawn_amount } })) },
    flow_pnl: { checked: flows.length, max_abs_diff_usd: flows.length ? Math.max(...flows.map(Math.abs)) : null },
    premium: { checked: count(A, a => a.premium === 'match' || a.premium === 'mismatch'), matched: count(A, a => a.premium === 'match'), mismatched: count(A, a => a.premium === 'mismatch'), unverified: count(A, a => a.premium === 'unverified'),
      mismatches: mism('premium', o => ({ wallet: o.seller, option_id: o.option_id, otype: o.otype, expected: o.audit.premium_expected, got: o.audit.premium_delta })) },
    collateral: { calls: count(L, o => o.otype === 'Call'), matched: count(A, a => a.collateral === 'match'), matched_native: count(A, a => a.collateral === 'match_native'), mismatched: count(A, a => a.collateral === 'mismatch'), unverified: count(A, a => a.collateral === 'unverified') },
    settlement_vs_market: { checked: svm.length, mean_abs_pct: svm.length ? svm.reduce((s, x) => s + Math.abs(x), 0) / svm.length : null, max_abs_pct: svm.length ? Math.max(...svm.map(Math.abs)) : null,
      worst: worst ? { asset: worst.asset, settled_at: worst.settled_at, program: worst.settlement_price, market: worst.settle_market, pct: worst.audit.settle_vs_market_pct } : null },
    fees: { premium_fee_pct: minmax(A.map(a => a.premium_fee_pct).filter(x => x != null)), settlement_fee_pct_of_given_up: minmax(A.map(a => a.settle_fee_pct).filter(x => x != null)) },
    spot_precision: (() => { const v = L.filter(o => o.spot_hourly != null && o.spot_source === 'minute').map(o => (o.spot_hourly / o.spot - 1) * 100);
      return { minute: count(L, o => o.spot_source === 'minute'), hourly_fallback: count(L, o => o.spot_source === 'hourly'), hourly_vs_minute_abs_pct: v.length ? { mean: v.reduce((s, x) => s + Math.abs(x), 0) / v.length, max: Math.max(...v.map(Math.abs)) } : null,
        coin_move_if_hourly_usd: L.filter(o => o.otype === 'Call' && o.spot_hourly != null).reduce((s, o) => s + (o.mark - o.spot_hourly) * o.size, 0), coin_move_usd: L.filter(o => o.otype === 'Call').reduce((s, o) => s + o.coin_move_usd, 0) }; })(),
    gas: { seller_sol_total: A.reduce((s, a) => s + a.gas_sol, 0), options_with_gas: count(A, a => a.gas_sol > 0) },
  };
}
