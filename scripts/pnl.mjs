// Seller profit and loss per option, two ways, from fields the stats job already has.
//
// Settlement on this program is physical. An exercised put hands the buyer the USDC
// collateral and leaves the seller holding the coin; an exercised call hands the buyer the
// coin and leaves the seller with strike x size in USDC. The settlement fee (5% of the
// in-the-money amount) comes out of the buyer's side. So an exercise costs the seller only
// the in-the-money amount at the settlement price, never the collateral that changed hands.
//
//   option PnL  = premium kept (after the premium fee) - in-the-money amount given up
//                 the options strategy on its own, as most platforms report it
//   total PnL   = option PnL + the coin's move on the locked collateral while it was locked
//                 calls lock the coin, so its rise or fall counts (capped at the strike when
//                 exercised); puts lock USDC, which does not move, so total = option PnL
//
// Settled options use the settlement price the program recorded. Open ones are marked at the
// latest price as if they expired now, and are always reported apart from realized figures.

export function pnlFields(o, latestPrice) {
  const settled = !!o.outcome;
  // a forced settlement records no price: value it at the market on that day instead
  const mark = settled && o.settlement_price > 0 ? o.settlement_price : latestPrice;
  const itm = o.otype === 'Call' ? Math.max(mark - o.strike, 0) * o.size : Math.max(o.strike - mark, 0) * o.size;
  // settled: the seller only gives something up when the buyer actually exercised
  // open: assume an in-the-money option would be exercised
  const given_up_usd = settled ? (o.outcome === 'ItmExercised' ? itm : 0) : itm;
  const coin_move_usd = o.otype === 'Call' ? (mark - o.spot) * o.size : 0;
  const pnl_option = o.premium_net - given_up_usd;
  return { mark, given_up_usd, coin_move_usd, pnl_option, pnl_total: pnl_option + coin_move_usd };
}

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const block = opts => ({
  options: opts.length,
  exercised: opts.filter(o => o.outcome ? o.outcome === 'ItmExercised' : o.given_up_usd > 0).length,
  premium_net: sum(opts, o => o.premium_net),
  given_up: sum(opts, o => o.given_up_usd),
  coin_move: sum(opts, o => o.coin_move_usd),
  option: sum(opts, o => o.pnl_option),
  total: sum(opts, o => o.pnl_total),
  collateral: sum(opts, o => o.collateral_usd),
});

// L: the option list with pnlFields merged in. latest: { SOL: price, BTC: price } used for open options.
export function pnlSummary(L, latest) {
  const settled = L.filter(o => o.outcome), open = L.filter(o => !o.outcome);
  const bySeller = new Map();
  for (const o of L) (bySeller.get(o.seller) ?? bySeller.set(o.seller, []).get(o.seller)).push(o);
  const by_wallet = [...bySeller.entries()].map(([wallet, opts]) => {
    const r = block(opts.filter(o => o.outcome)), u = block(opts.filter(o => !o.outcome));
    return { wallet, realized: r, open: u, return_pct: r.collateral > 0 ? r.option / r.collateral * 100 : null };
  }).sort((a, b) => b.realized.option - a.realized.option);
  const realized = block(settled);
  // the buyer side: paid the gross premium, received the in-the-money amount less the settlement fee
  const buyer = { premium_paid: sum(settled, o => o.premium_gross), received: sum(settled, o => o.given_up_usd - o.settle_fee_usd) };
  buyer.pnl = buyer.received - buyer.premium_paid;
  return {
    marked_at: latest,
    realized,
    open: block(open),
    wallets: { up: by_wallet.filter(w => w.realized.options && w.realized.option > 0).length, down: by_wallet.filter(w => w.realized.option < 0).length, flat: by_wallet.filter(w => w.realized.options && w.realized.option === 0).length },
    buyer,
    by_wallet,
  };
}
