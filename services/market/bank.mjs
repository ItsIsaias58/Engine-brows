// the player bank, in the spirit of BNT's IGB (igb.php): a savings account that
// pays interest once per game day and a loan desk that charges more than it
// pays. the server runs both, so the money exists even if the player never
// opens the panel again — the pass below is called from the tick loop with the
// account's own portfolio, exactly like BNT's scheduler touched every ship.
//
// why a bank at all: idle cash earns nothing on the trading floor, which makes
// "hold cash" strictly worse than "hold stock". a savings rate gives cash a
// yield, and a loan gives a player who just went broke (or who spotted a
// once-in-a-season dip) a way to get leverage without selling.

import { portfolioNetWorth } from './valuation.mjs';

export const BANK_RATE_DAILY = 0.003; // 0.3% per game day on savings
export const LOAN_RATE_DAILY = 0.012; // 1.2% per game day on what you owe
export const LOAN_PENALTY = 0.10; // seizure surcharge when the term runs out
export const LOAN_TERM_DAYS = 5; // game days before the bank collects
export const BANK_MAX_BALANCE = 1e9;
export const LOAN_MAX = 250_000; // hard ceiling, level independent
export const TRANSFER_MIN = 1; // nothing smaller than a dollar moves
export const TRANSFER_MAX = 1e8; // sanity cap per transfer
export const TRANSFER_HISTORY_LIMIT = 50; // kept per book (in and out)
// the wire fee: big wires pay 5%, small ones ride free. banks love a threshold.
export const TRANSFER_FEE_RATE = 0.05; // 5% above the threshold
export const TRANSFER_FEE_THRESHOLD = 10_000; // only the big wires pay

// fee for a wire of `amount`: 0 below the threshold, 5% of everything above it
// (not 5% of the whole wire) — moving 12k costs 5% of 2k, same as real
// progressive brackets
export function transferFee(amount) {
  const value = Math.max(0, Number(amount) || 0);
  if (value <= TRANSFER_FEE_THRESHOLD) return 0;
  return (value - TRANSFER_FEE_THRESHOLD) * TRANSFER_FEE_RATE;
}

export function defaultBank() {
  return { balance: 0, loan: 0, loanDaysLeft: 0, loanAtDay: null };
}

// a money movement between players, as it lands in each book. `dir` is from
// the perspective of the book it is stored in.
export function transferEntry(dir, counterparty, amount, at, note) {
  return {
    id: `t${at.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    dir, // 'in' | 'out'
    with: counterparty, // the other side's display name
    amount,
    at,
    note: typeof note === 'string' ? note.slice(0, 120) : '',
  };
}

export function recordTransfer(list, entry) {
  const book = Array.isArray(list) ? list : [];
  book.unshift(entry);
  if (book.length > TRANSFER_HISTORY_LIMIT) book.length = TRANSFER_HISTORY_LIMIT;
  return book;
}

// the atomic money movement: validated against the live account store, not the
// client's copy, so a stale screen cannot send money twice. both books are
// written here, in one call, or nothing moves.
export function transferCash({ from, to, toName, amount, now = Date.now(), note }) {
  const value = Math.floor(Number(amount));
  if (!Number.isFinite(value) || value < TRANSFER_MIN) {
    return { ok: false, error: `el mínimo es ${TRANSFER_MIN}` };
  }
  if (value > TRANSFER_MAX) return { ok: false, error: 'monto demasiado grande' };
  if (!to || !to.portfolio) return { ok: false, error: 'el destinatario no existe' };
  if (to === from) return { ok: false, error: 'no puedes transferirte a ti mismo' };

  const fromPortfolio = from.portfolio;
  const cash = Number(fromPortfolio.cash) || 0;
  if (value > cash + 0.001) {
    return { ok: false, error: `solo tienes ${cash.toFixed(2)} de efectivo` };
  }

  const toPortfolio = to.portfolio;
  const fee = transferFee(value);
  const received = value - fee;
  if (received < TRANSFER_MIN) {
    return { ok: false, error: 'después del impuesto el envío queda por debajo del mínimo' };
  }
  // the sender pays amount + fee from cash; the receiver gets the full net
  const totalDebit = value + fee;
  if (totalDebit > cash + 0.001) {
    return { ok: false, error: `con el impuesto del ${TRANSFER_FEE_RATE * 100}% necesitas ${totalDebit.toFixed(2)} de efectivo (tienes ${cash.toFixed(2)})` };
  }
  // the receiving side lands in cash (not the savings account): the bank does
  // not silently lock somebody else's money into a term they did not choose
  toPortfolio.cash = (Number(toPortfolio.cash) || 0) + received;
  fromPortfolio.cash = cash - totalDebit;
  toPortfolio.updatedAt = now;
  fromPortfolio.updatedAt = now;

  const at = now;
  const outEntry = transferEntry('out', toName, value, at, note);
  if (fee > 0) outEntry.fee = Math.round(fee * 100) / 100;
  const inEntry = transferEntry('in', from.name, received, at, note);
  fromPortfolio.transfers = recordTransfer(fromPortfolio.transfers, outEntry);
  toPortfolio.transfers = recordTransfer(toPortfolio.transfers, inEntry);

  return { ok: true, amount: value, fee, received, outEntry, inEntry, toName };
}

// arrives straight from the client's save, so every field is clamped
export function sanitizeBank(input) {
  const base = defaultBank();
  if (!input || typeof input !== 'object') return base;
  const num = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  return {
    balance: num(input.balance, 0, 0, BANK_MAX_BALANCE),
    loan: num(input.loan, 0, 0, LOAN_MAX * 4),
    loanDaysLeft: Math.round(num(input.loanDaysLeft, 0, 0, 365)),
    loanAtDay: Number.isFinite(input.loanAtDay) ? input.loanAtDay : null,
  };
}

// the transfer history travels inside the portfolio save; clamped, never
// trusted: names capped, amounts finite, ids short
export function sanitizeTransfers(input) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((t) => t && typeof t === 'object' && (t.dir === 'in' || t.dir === 'out'))
    .slice(0, TRANSFER_HISTORY_LIMIT)
    .map((t) => ({
      id: typeof t.id === 'string' ? t.id.slice(0, 24) : 't',
      dir: t.dir,
      with: typeof t.with === 'string' ? t.with.slice(0, 24) : '?',
      amount: Math.min(TRANSFER_MAX, Math.max(0, Number(t.amount) || 0)),
      at: Number.isFinite(t.at) ? t.at : 0,
      note: typeof t.note === 'string' ? t.note.slice(0, 120) : '',
      // the wire fee travels with the out entry (a number, or nothing)
      ...(Number.isFinite(t.fee) && t.fee > 0 ? { fee: Math.min(TRANSFER_MAX, t.fee) } : {}),
    }));
}

// deposit/withdraw/borrow/repay, validated against the portfolio the server
// keeps. returns { ok, error?, portfolio?, bank? } — the caller persists.
export function bankAction(portfolio, action, rawAmount, priceOf = () => undefined) {
  const bank = portfolio.bank || defaultBank();
  portfolio.bank = bank; // the default case must land back on the portfolio too
  const amount = Math.floor(Number(rawAmount));
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: 'monto inválido' };
  }

  const cash = Number(portfolio.cash) || 0;

  if (action === 'deposit') {
    if (amount > cash + 0.001) return { ok: false, error: 'no tienes ese efectivo' };
    // el 5% siempre queda en efectivo: sin queda-forzado (la vieja espera de
    // 10 minutos para recuperar el último peso era el guardado debounced de
    // la bolsa, no el banco; esto además evita depositar el 100% y quedarte a 0)
    const maxDeposit = Math.floor(cash * 0.95);
    if (amount > maxDeposit) {
      return { ok: false, error: `sólo puedes depositar hasta el 95% de tu efectivo (${maxDeposit} ahora) — deja al menos 5% en mano` };
    }
    if (bank.balance + amount > BANK_MAX_BALANCE) return { ok: false, error: 'la cuenta no acepta tanto' };
    portfolio.cash = cash - amount;
    bank.balance += amount;
    return { ok: true, bank, note: `depositaste ${amount.toFixed(2)} · quedan ${Math.round(cash - amount)} en efectivo` };
  }

  if (action === 'withdraw') {
    if (amount > bank.balance + 0.001) return { ok: false, error: 'saldo insuficiente en el banco' };
    bank.balance -= amount;
    portfolio.cash = cash + amount;
    return { ok: true, bank, note: `retiraste ${amount.toFixed(2)}` };
  }

  if (action === 'borrow') {
    if (bank.loan > 0) return { ok: false, error: 'ya tienes un préstamo activo' };
    const net = netWorthOf(portfolio, priceOf);
    // the desk lends at most what the player is worth, capped: a broke player
    // with $200 cannot take a $250k loan and instantly go negative forever
    const cap = Math.min(LOAN_MAX, Math.max(2_000, net * 1.5));
    const granted = Math.min(amount, cap);
    if (granted <= 0) return { ok: false, error: 'el banco no te presta nada hoy' };
    bank.loan = granted;
    bank.loanDaysLeft = LOAN_TERM_DAYS;
    portfolio.cash = cash + granted;
    return { ok: true, bank, note: `préstamo de ${granted.toFixed(2)} a ${LOAN_TERM_DAYS} días` };
  }

  if (action === 'repay') {
    if (bank.loan <= 0) return { ok: false, error: 'no debes nada' };
    const owed = bank.loan;
    const pay = Math.min(amount, owed, cash);
    if (pay <= 0) return { ok: false, error: 'no tienes efectivo para pagar' };
    bank.loan = owed - pay;
    portfolio.cash = cash - pay;
    if (bank.loan <= 0.001) {
      bank.loan = 0;
      bank.loanDaysLeft = 0;
      bank.loanAtDay = null;
    }
    return { ok: true, bank, note: `pagaste ${pay.toFixed(2)} de la deuda` };
  }

  return { ok: false, error: 'acción desconocida' };
}

// once per game day (the tick loop calls this when the day rolls): savings
// compound, the loan grows, and an expired loan is collected — from cash first,
// then by liquidating positions at the current prices, exactly like BNT's
// governor took what a debt-ridden captain owed.
export function accrueBankDay(portfolio, prices, day) {
  const bank = portfolio.bank || defaultBank();
  const log = [];

  if (bank.balance > 0) {
    const interest = bank.balance * BANK_RATE_DAILY;
    bank.balance = Math.min(BANK_MAX_BALANCE, bank.balance + interest);
    log.push({ kind: 'bank-interest', amount: interest });
  }

  if (bank.loan > 0) {
    bank.loan *= 1 + LOAN_RATE_DAILY;
    bank.loanDaysLeft -= 1;
    if (bank.loanDaysLeft <= 0) {
      const collected = collectLoan(portfolio, bank, prices);
      log.push({ kind: 'loan-collected', amount: collected, owed: bank.loan });
      bank.loan = 0;
      bank.loanDaysLeft = 0;
    } else {
      log.push({ kind: 'loan-interest', owed: bank.loan, daysLeft: bank.loanDaysLeft });
    }
  }

  bank.loanAtDay = bank.loan > 0 ? day : null;
  portfolio.bank = bank;
  return log;
}

function collectLoan(portfolio, bank, prices) {
  const original = bank.loan * (1 + LOAN_PENALTY);
  let owed = original;
  const cash = Number(portfolio.cash) || 0;
  const fromCash = Math.min(cash, owed);
  portfolio.cash = cash - fromCash;
  owed -= fromCash;

  // liquidate positions best-effort: selling a fraction of the shares releases
  // that fraction of the position's liquidation value (margin + open P/L); what
  // the bank takes goes to the debt, the rest stays in the player's cash
  for (const [sym, position] of Object.entries(portfolio.positions || {})) {
    if (owed <= 0) break;
    const price = prices.get(sym);
    const shares = Number(position.shares) || 0;
    if (!Number.isFinite(price) || price <= 0 || shares <= 0) continue;
    const value = shares * price;
    const liquidation = Math.max(
      0,
      (Number(position.margin) || 0) + shares * (price - (Number(position.avgPrice) || 0)),
    );
    if (liquidation <= 0 || value <= 0) continue;
    const take = Math.min(liquidation, owed);
    const frac = Math.min(1, take / value);
    const sold = shares * frac;
    portfolio.cash += liquidation * frac - take;
    if (sold >= shares - 0.0001) delete portfolio.positions[sym];
    else {
      position.shares = shares - sold;
      position.margin = Math.max(0, (Number(position.margin) || 0) * (1 - frac));
    }
    owed -= take;
  }
  // whatever could not be covered is forgiven: the player lost what was seized
  return original - owed;
}

export function netWorthOf(portfolio, priceOf = () => undefined) {
  return portfolioNetWorth(portfolio, priceOf);
}
