// what a portfolio is worth right now, in one place.
//
// three consumers used to answer this question separately and disagree:
// the client (cash + bank balance - debt + positions at the live quote), the
// ranking (cash + positions at the live quote, no bank) and the bank desk
// (cash + bank balance - debt + positions at the price they were BOUGHT at).
// the player therefore saw a "patrimonio" that the leaderboard scored
// differently, and a loan ceiling that changed depending on whether they were
// signed in. this module is the single answer they all use now.
//
// pure and dependency-free on purpose: it is the contract, so it can be tested
// without a market, an account store or a bank.

/**
 * @param portfolio the stored portfolio
 * @param priceOf   (sym) => number | undefined, the live quote for that symbol
 * @returns cash + bank balance - debt + every position at its live quote
 */
export function portfolioNetWorth(portfolio, priceOf) {
  const bank = portfolio.bank || {};
  let total = (Number(portfolio.cash) || 0)
    + (Number(bank.balance) || 0)
    - (Number(bank.loan) || 0);

  for (const [sym, position] of Object.entries(portfolio.positions || {})) {
    const shares = Number(position.shares) || 0;
    if (shares <= 0) continue;
    // no live quote (the symbol left the catalogue): what the player paid is
    // the last honest number we have for it
    const price = priceOf(sym);
    const value = Number.isFinite(price) ? price : (Number(position.avgPrice) || 0);
    total += shares * value;
  }
  return total;
}

/**
 * the same sum without the bank, for the ranking: the leaderboard has always
 * scored only the trading book, and changing that would move every stored rank.
 *
 * @param portfolio the stored portfolio
 * @param priceOf   (sym) => number | undefined, the live quote for that symbol
 */
export function portfolioTradingValue(portfolio, priceOf) {
  let total = Number(portfolio.cash) || 0;
  for (const [sym, position] of Object.entries(portfolio.positions || {})) {
    const shares = Number(position.shares) || 0;
    if (shares <= 0) continue;
    const price = priceOf(sym);
    if (!Number.isFinite(price)) continue;
    total += shares * price;
  }
  return Math.max(0, total);
}