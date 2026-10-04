// el casino del piso de trading: la casa donde el cash sobrante se quema con
// estilo. blackjack, tragamonedas y ruleta, con la misma regla de oro que el
// resto del servicio: el servidor es la única verdad del dinero. el cliente
// manda "quiero apostar X" y aquí se decide todo — baraja, rodillos, número —
// para que ni un solo peso se mueva por confianza en el navegador.
//
// los bordes de la casa son reales pero amables: ~1% en slots, ~2.7% en ruleta
// (europea, un solo cero) y blackjack paga 3:2. es dinero en llamas con
// dignidad, no una trampa.

export const CASINO_MIN_BET = 10;
export const CASINO_MAX_BET = 1e7;

// --------------------------------------------------------------- utilidades

// una baraja infinita: cada carta sale del sombrero. para un casino de juego
// no hace falta contar cartas ni barajar zapatos de 6 mazos.
export function drawCard() {
  return { r: 1 + Math.floor(Math.random() * 13), s: Math.floor(Math.random() * 4) };
}

export function cardValue(card) {
  return card.r === 1 ? 11 : Math.min(card.r, 10);
}

export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardValue(c);
    if (c.r === 1) aces += 1;
  }
  // los ases bajan de 11 a 1 mientras la mano se pase
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

export function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards) === 21;
}

const SUITS = ['♠', '♥', '♦', '♣'];
export function cardLabel(card) {
  const face = card.r === 1 ? 'A' : card.r === 11 ? 'J' : card.r === 12 ? 'Q' : card.r === 13 ? 'K' : String(card.r);
  return face + SUITS[card.s] || face;
}

// ------------------------------------------------------------ tragamonedas

// pesos por símbolo: los bars y cerezas dominan, los 7s son el unicornio
const REELS = [
  { sym: '🍒', w: 32 },
  { sym: '🔔', w: 26 },
  { sym: '⭐', w: 18 },
  { sym: '💎', w: 10 },
  { sym: '7', w: 4 },
];
const REEL_TOTAL = REELS.reduce((s, r) => s + r.w, 0);

// pagos (multiplicador sobre la apuesta): línea + pares que devuelven la apuesta
const SLOT_PAYS = { '🍒': 4, '🔔': 6, '⭐': 10, '💎': 20, '7': 60 };

function spinReel() {
  let r = Math.random() * REEL_TOTAL;
  for (const reel of REELS) {
    r -= reel.w;
    if (r <= 0) return reel.sym;
  }
  return REELS[REELS.length - 1].sym;
}

function spinSlots() {
  const reels = [spinReel(), spinReel(), spinReel()];
  let mult = 0;
  if (reels[0] === reels[1] && reels[1] === reels[2]) {
    mult = SLOT_PAYS[reels[0]];
  } else if (reels[0] === reels[1] || reels[1] === reels[2] || reels[0] === reels[2]) {
    mult = 1; // un par devuelve la apuesta: pierdes el impulso, no el dinero
  }
  return { reels, mult };
}

// ----------------------------------------------------------------- ruleta

const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

// apuestas aceptadas y su pago (total devuelto, stake incluido)
const ROULETTE_PAYS = {
  number: 36,
  red: 2, black: 2, even: 2, odd: 2,
  low: 2, high: 2, // 1-18 / 19-36
  dozen: 3,
};

function parseRoulettePick(raw) {
  const pick = String(raw || '').trim().toLowerCase();
  if (pick === '') return null;
  if (ROULETTE_PAYS[pick]) return { kind: pick, pays: ROULETTE_PAYS[pick] };
  if (/^(1-12|13-24|25-36)$/.test(pick)) return { kind: 'dozen', pays: ROULETTE_PAYS.dozen, dozen: pick };
  const n = Number(pick);
  if (Number.isInteger(n) && n >= 0 && n <= 36) return { kind: 'number', pays: ROULETTE_PAYS.number, n };
  return null;
}

function rouletteWins(pick, n) {
  switch (pick.kind) {
    case 'number': return n === pick.n;
    case 'red': return n !== 0 && RED_NUMBERS.has(n);
    case 'black': return n !== 0 && !RED_NUMBERS.has(n);
    case 'even': return n !== 0 && n % 2 === 0;
    case 'odd': return n % 2 === 1;
    case 'low': return n >= 1 && n <= 18;
    case 'high': return n >= 19 && n <= 36;
    case 'dozen': {
      if (n === 0) return false;
      const d = n <= 12 ? '1-12' : n <= 24 ? '13-24' : '25-36';
      return d === pick.dozen;
    }
    default: return false;
  }
}

export function rouletteColor(n) {
  if (n === 0) return 'green';
  return RED_NUMBERS.has(n) ? 'red' : 'black';
}

// ---------------------------------------------------------- la mesa central

function casinoBook(portfolio) {
  if (!portfolio.casino || typeof portfolio.casino !== 'object') {
    portfolio.casino = { bj: null, stats: { rounds: 0, wagered: 0, won: 0 } };
  }
  if (!portfolio.casino.stats || typeof portfolio.casino.stats !== 'object') {
    portfolio.casino.stats = { rounds: 0, wagered: 0, won: 0 };
  }
  return portfolio.casino;
}

function clampBet(raw, cash) {
  const bet = Math.floor(Number(raw));
  if (!Number.isFinite(bet) || bet < CASINO_MIN_BET) return { error: `apuesta mínima ${CASINO_MIN_BET}` };
  if (bet > CASINO_MAX_BET) return { error: 'la casa no cubre apuestas tan grandes' };
  if (bet > cash + 0.001) return { error: 'no tienes ese efectivo' };
  return { bet };
}

function grantXp(portfolio, bet) {
  // XP simbólico por jugada: el casino no es la ruta de leveling, es el fogón
  portfolio.xp = Math.min(1e9, (Number(portfolio.xp) || 0) + Math.max(1, Math.round(bet / 60)));
}

function recordRound(book, bet, returned) {
  book.stats.rounds += 1;
  book.stats.wagered += bet;
  book.stats.won += returned;
}

// la puerta única: recibe la cartera (la que el server conserva), la acción y
// el cuerpo del pedido. muta portfolio.cash/xp/casino y devuelve una respuesta
// lista para el cliente. el caller persiste.
export function casinoAction(portfolio, action, body = {}) {
  if (portfolio.bankrupt === true) {
    return { ok: false, error: 'estás en bancarrota: el casino no da crédito' };
  }
  const book = casinoBook(portfolio);
  const cash = Number(portfolio.cash) || 0;
  const bet0 = body?.amount;

  // ---------------------------------------------------------- blackjack
  if (action === 'bj_deal') {
    if (book.bj) return { ok: false, error: 'termina la mano en curso' };
    const clamp = clampBet(bet0, cash);
    if (clamp.error) return { ok: false, error: clamp.error };
    const bet = clamp.bet;
    const player = [drawCard(), drawCard()];
    const dealer = [drawCard(), drawCard()];
    portfolio.cash = cash - bet;
    book.bj = { bet, player, dealer, done: false };
    grantXp(portfolio, bet);

    // blackjack natural se resuelve al momento (el dealer no juega)
    if (isBlackjack(player)) {
      const dealerBJ = isBlackjack(dealer);
      const returned = dealerBJ ? bet : Math.round(bet * 2.5);
      portfolio.cash += returned;
      recordRound(book, bet, returned);
      book.bj.done = true;
      const result = dealerBJ ? 'push' : 'blackjack';
      return finishHand(book, portfolio, result, { player, dealer, returned, bet, result });
    }
    return { ok: true, action, hand: publicHand(book.bj), cash: portfolio.cash };
  }

  if (action === 'bj_hit' || action === 'bj_stand') {
    const hand = book.bj;
    if (!hand || hand.done) return { ok: false, error: 'no hay mano activa: reparte primero' };
    if (action === 'bj_hit') {
      hand.player.push(drawCard());
      const total = handValue(hand.player);
      if (total > 21) {
        // bust: la casa cobra
        recordRound(book, hand.bet, 0);
        hand.done = true;
        return finishHand(book, portfolio, 'bust', { player: hand.player, dealer: hand.dealer, returned: 0, bet: hand.bet, result: 'bust' });
      }
      if (total === 21) return { ok: true, action, hand: publicHand(hand), cash: portfolio.cash };
      return { ok: true, action, hand: publicHand(hand), cash: portfolio.cash };
    }
    // stand: el dealer roba hasta 17 (se planta en todos los 17)
    while (handValue(hand.dealer) < 17) hand.dealer.push(drawCard());
    const p = handValue(hand.player);
    const d = handValue(hand.dealer);
    let returned = 0;
    let result;
    if (d > 21 || p > d) {
      returned = hand.bet * 2;
      result = 'win';
    } else if (p === d) {
      returned = hand.bet;
      result = 'push';
    } else {
      result = 'lose';
    }
    portfolio.cash += returned;
    recordRound(book, hand.bet, returned);
    hand.done = true;
    return finishHand(book, portfolio, result, { player: hand.player, dealer: hand.dealer, returned, bet: hand.bet, result });
  }

  // ------------------------------------------------------- tragamonedas
  if (action === 'slots') {
    if (book.bj && !book.bj.done) return { ok: false, error: 'termina la mano de blackjack primero' };
    const clamp = clampBet(bet0, cash);
    if (clamp.error) return { ok: false, error: clamp.error };
    const bet = clamp.bet;
    const { reels, mult } = spinSlots();
    const returned = bet * mult;
    portfolio.cash = cash - bet + returned;
    grantXp(portfolio, bet);
    recordRound(book, bet, returned);
    return {
      ok: true,
      action,
      reels,
      mult,
      returned,
      net: returned - bet,
      cash: portfolio.cash,
      result: mult >= 10 ? 'jackpot' : mult > 1 ? 'win' : mult === 1 ? 'push' : 'lose',
    };
  }

  // -------------------------------------------------------------- ruleta
  if (action === 'roulette') {
    if (book.bj && !book.bj.done) return { ok: false, error: 'termina la mano de blackjack primero' };
    const pick = parseRoulettePick(body?.pick);
    if (!pick) return { ok: false, error: 'apuesta inválida: número 0-36, red, black, even, odd, low, high o decena' };
    const clamp = clampBet(bet0, cash);
    if (clamp.error) return { ok: false, error: clamp.error };
    const bet = clamp.bet;
    const n = Math.floor(Math.random() * 37); // 0-36, europea
    const won = rouletteWins(pick, n);
    const returned = won ? bet * pick.pays : 0;
    portfolio.cash = cash - bet + returned;
    grantXp(portfolio, bet);
    recordRound(book, bet, returned);
    return {
      ok: true,
      action,
      number: n,
      color: rouletteColor(n),
      won,
      returned,
      net: returned - bet,
      cash: portfolio.cash,
      result: won ? (pick.pays >= 36 ? 'jackpot' : 'win') : 'lose',
    };
  }

  return { ok: false, error: 'acción desconocida' };
}

// cierra una mano: limpia el estado si terminó y adjunta el resumen
function finishHand(book, portfolio, result, extra) {
  const summary = { ok: true, action: 'bj_resolve', ...extra, cash: portfolio.cash };
  if (extra.returned > 0 && extra.returned > extra.bet) grantXp(portfolio, extra.bet);
  // la mano se conserva un instante para que el cliente la muestre; el
  // siguiente bj_deal la borra
  book.bj = { ...book.bj, done: true, result };
  summary.hand = { bet: extra.bet, player: extra.player, dealer: extra.dealer, done: true, result };
  return summary;
}

// lo que ve el cliente mientras la mano vive: la segunda carta del dealer
// tapada. cuando la mano terminó, todo se muestra.
export function publicHand(hand) {
  const hide = !hand.done && hand.dealer.length >= 2;
  return {
    bet: hand.bet,
    player: hand.player,
    playerTotal: handValue(hand.player),
    dealer: hide ? [hand.dealer[0], { hidden: true }] : hand.dealer,
    dealerTotal: hide ? cardValue(hand.dealer[0]) : handValue(hand.dealer),
    done: !!hand.done,
    result: hand.result || null,
  };
}

// lo que viaja dentro del portfolio guardado: la mano viva y las stats,
// recortadas a formas sanas (el cliente nunca dicta saldos, sólo la mano)
export function sanitizeCasino(input) {
  const base = { bj: null, stats: { rounds: 0, wagered: 0, won: 0 } };
  if (!input || typeof input !== 'object') return base;
  const stats = input.stats && typeof input.stats === 'object' ? input.stats : {};
  const casino = {
    stats: {
      rounds: Math.max(0, Math.round(Number(stats.rounds) || 0)),
      wagered: Math.min(1e15, Math.max(0, Number(stats.wagered) || 0)),
      won: Math.min(1e15, Math.max(0, Number(stats.won) || 0)),
    },
    bj: null,
  };
  const bj = input.bj;
  if (bj && typeof bj === 'object') {
    const clean = (cards) => Array.isArray(cards)
      ? cards.slice(0, 12).map((c) => ({ r: Math.min(13, Math.max(1, Math.round(Number(c?.r) || 1))), s: Math.min(3, Math.max(0, Math.round(Number(c?.s) || 0))) }))
      : [];
    casino.bj = {
      bet: Math.min(CASINO_MAX_BET, Math.max(0, Number(bj.bet) || 0)),
      player: clean(bj.player),
      dealer: clean(bj.dealer),
      done: bj.done === true,
      ...(typeof bj.result === 'string' ? { result: bj.result.slice(0, 12) } : {}),
    };
    if (!casino.bj.player.length || casino.bj.bet <= 0) casino.bj = null;
  }
  return casino;
}
